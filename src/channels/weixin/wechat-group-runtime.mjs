const GROUP_EVENT_SOURCE = 'uia-wechat-group/v1';
const UNVERIFIED_SENDER_ID = 'uia-unverified:row';
// Codes that mean the WeChat surface itself is gone rather than the bridge being
// broken. Mirror of SURFACE_LOST_CODES in scripts/wechat_group_uia.py: the adapter
// exits once on any of them, and that exit is what lets this layer slow down.
// Keep both lists in step when adding a classification there.
const SURFACE_LOSS_CODES = new Set([
  'wechat_panel_closed',
  'wechat_logged_out',
  'main_window_missing',
  // Measured live: a panel can be on screen and still expose no accessibility
  // tree, which only restarting WeChat fixes. Mirror of SURFACE_LOST_CODES in
  // scripts/wechat_group_uia.py; keep the two lists in step.
  'wechat_accessibility_unavailable',
]);

function runtimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function nonEmptyString(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

function errorCode(error, fallback) {
  return nonEmptyString(error?.code) ? error.code : fallback;
}

/**
 * Attach the local UIA event source to the account's existing HarnessBridge.
 * There is deliberately no bridge factory here: one account owns one bridge
 * and one deferred coordinator, while this runtime owns only the Python side.
 */
export class WechatGroupRuntime {
  #groups;
  #process;
  #harness;
  #logger;
  #restartDelaysMs;
  #surfaceLossDelaysMs;
  #surfaceIndex = 0;
  #surfaceLoss = false;
  // The delay actually used for the pending retry, exposed through status so an
  // operator (and the tests) can see which ladder is in effect.
  #pendingDelayMs = null;
  #bridge = null;
  #starting = null;
  #stopping = null;
  #started = false;
  #accepting = false;
  // The account-owned bridge survives start failures; a restart re-attaches it.
  #startBridge = null;
  #pending = new Set();
  #restartTimer = null;
  #restartInProgress = false;
  #nextRestartIndex = 0;
  #restartAttempts = 0;
  #restarts = 0;
  #startRetryLimit = Infinity;
  #startRetryCount = 0;
  #messagesAccepted = 0;
  #messagesRejected = 0;
  #lastError = null;

  constructor({
    config,
    process: groupProcess,
    harness = null,
    logger = console,
    // A failed START used to end the bridge permanently: the account kept an
    // offline runtime and nothing ever retried, so an operator who opened WeChat
    // after boot got silence forever. These delays keep trying instead; the cap
    // is 30s so a recovered window is picked up within half a minute.
    restartDelaysMs = [2_500, 5_000, 10_000, 30_000],
    // Surface loss (panel closed, client logged out, WeChat not running) is
    // repaired on a human timescale, so the fast ladder only floods the log -
    // exactly the behaviour this objective flagged as a defect. Ten minutes
    // between probes still picks a reopened window up promptly while emitting
    // almost nothing.
    // Capped at two minutes: the bridge only notices a fixed WeChat on its next
    // retry, so a longer top rung buys silence with an outage the operator cannot
    // explain. 30s/1m/2m is still ~160x quieter than the 750ms flood it replaced.
    surfaceLossRestartDelaysMs = [30_000, 60_000, 120_000],
    startRetryLimit = Infinity,
  }) {
    if (!config || !Array.isArray(config.groups) || config.groups.length === 0) {
      throw new TypeError('WechatGroupRuntime requires configured groups');
    }
    if (!groupProcess || typeof groupProcess.start !== 'function'
      || typeof groupProcess.stop !== 'function' || typeof groupProcess.sendText !== 'function'
      || typeof groupProcess.on !== 'function') {
      throw new TypeError('A WeChat group process is required');
    }
    if (!Array.isArray(restartDelaysMs)
      || restartDelaysMs.some((delay) => !Number.isFinite(delay) || delay < 0)) {
      throw new TypeError('restartDelaysMs must contain non-negative delays');
    }
    if (!Array.isArray(surfaceLossRestartDelaysMs)
      || surfaceLossRestartDelaysMs.length === 0
      || surfaceLossRestartDelaysMs.some((delay) => !Number.isFinite(delay) || delay < 0)) {
      throw new TypeError('surfaceLossRestartDelaysMs must contain non-negative delays');
    }
    if (!(startRetryLimit === Infinity
      || (Number.isSafeInteger(startRetryLimit) && startRetryLimit >= 0))) {
      throw new TypeError('startRetryLimit must be a non-negative integer or Infinity');
    }
    this.#groups = new Map(config.groups.map((group) => [group.id, group]));
    this.#process = groupProcess;
    this.#harness = harness;
    this.#logger = logger;
    this.#restartDelaysMs = [...restartDelaysMs];
    this.#surfaceLossDelaysMs = [...surfaceLossRestartDelaysMs];
    this.#startRetryLimit = startRetryLimit;

    this.#process.on('message', (event) => this.#onMessage(event));
    this.#process.on('ready', () => this.#onReady());
    this.#process.on('exit', (detail) => this.#onExit(detail));
    this.#process.on('protocolError', (error) => {
      if (this.#started && !this.#stopping) this.#lastError = errorCode(error, 'invalid-protocol');
    });
  }

  get status() {
    return {
      ready: this.#accepting,
      running: this.#started,
      groupCount: this.#groups.size,
      pending: this.#pending.size,
      restarts: this.#restarts,
      restartAttempts: this.#restartAttempts,
      startRetries: this.#startRetryCount,
      messagesAccepted: this.#messagesAccepted,
      messagesRejected: this.#messagesRejected,
      lastError: this.#lastError,
      // Which ladder is driving the pending retry, and how long until it fires.
      surfaceLoss: this.#surfaceLoss,
      restartDelayMs: this.#pendingDelayMs,
      // The configured slow ladder, exposed so its ceiling is checkable without
      // waiting three minutes to observe it.
      surfaceLossLadderMs: [...this.#surfaceLossDelaysMs],
    };
  }

  /** Attach to an already-created account bridge; never construct a second one. */
  start(context = {}) {
    if (this.#starting) return this.#starting;
    if (this.#started && this.#accepting) return Promise.resolve(this.status);
    const starting = this.#start(context);
    this.#starting = starting;
    starting.then(
      () => { if (this.#starting === starting) this.#starting = null; },
      () => { if (this.#starting === starting) this.#starting = null; },
    );
    return starting;
  }

  async #start(context) {
    if (this.#stopping) await this.#stopping;
    this.#started = true;
    this.#accepting = false;
    this.#lastError = null;
    this.#nextRestartIndex = 0;
    this.#restartAttempts = 0;
    try {
      const bridge = context?.bridge;
      if (!bridge || typeof bridge.accept !== 'function') {
        throw runtimeError('shared-bridge-required', 'The existing account WeixinHarnessBridge is required');
      }
      this.#bridge = bridge;
      // Remember the bridge so a later restart can re-attach it. A failed
      // start used to clear #bridge and #restart() never put it back, so every
      // message from the adapter was dropped by #onMessage's null guard with no
      // log line at all: a live adapter looked healthy while the group was mute.
      this.#startBridge = bridge;
      await this.#harness?.ensureRunning?.();
      await this.#process.start();
      // The real process emits ready before resolving start. The fallback also
      // supports process doubles that only expose a ready status property.
      if (this.#process.status?.ready && !this.#accepting) this.#onReady();
      return this.status;
    } catch (error) {
      this.#accepting = false;
      await this.#process.stop().catch(() => undefined);
      this.#bridge = null;
      // Keep the runtime started and re-arm a retry instead of going dark: the
      // usual cause is a transient window state (logged out, minimised, tree
      // not yet built) that the operator fixes a moment later. Without this the
      // bridge stayed offline until the whole Host was restarted, which is
      // exactly why a group message got no answer at all.
      if (!this.#stopping) {
        const code = errorCode(error, 'start-failed');
        this.#lastError = code;
        // Classify here too, not only in #onExit. The usual failure on this
        // machine is a start against a closed panel: the child reports the code
        // and exits, but a start rejection can arrive without any exit event,
        // and keying the slow ladder on the exit alone left that path probing
        // every 30s - the flood this objective exists to kill.
        this.#surfaceLoss = SURFACE_LOSS_CODES.has(code);
        this.#scheduleRestart();
        this.#restartAttempts = this.#startRetryCount;
      } else {
        this.#started = false;
      }
      throw error;
    }
  }

  /** Let the account API route only exact configured IDs to the UIA transport. */
  handles(toUserId) {
    return this.#groups.has(toUserId);
  }

  /** Public UIA transport used by the account API's direct/group send splitter. */
  async sendText({ toUserId, text, requestId, request_id: legacyRequestId } = {}) {
    if (!this.#groups.has(toUserId)) {
      throw runtimeError('unknown-group', 'Refusing to send to an unconfigured WeChat group');
    }
    if (!this.#accepting) throw runtimeError('group-not-ready', 'WeChat group runtime is not ready');
    const result = await this.#process.sendText({
      toUserId,
      text,
      requestId: requestId ?? legacyRequestId,
    });
    // WeixinHarnessBridge treats a resolved API call as sent. Convert an
    // uncertain provider outcome into an error so it enters reconciliation
    // instead of being remembered and reported as a successful delivery.
    if (result?.status === 'unknown' || result?.ok === false) {
      throw runtimeError(
        nonEmptyString(result?.code) ? result.code : 'outcome_unknown',
        'WeChat group send outcome requires reconciliation',
      );
    }
    return result;
  }

  #onReady() {
    if (!this.#started || this.#stopping) return;
    const wasRestart = this.#restartInProgress;
    this.#restartInProgress = false;
    this.#nextRestartIndex = 0;
    this.#restartAttempts = 0;
    this.#startRetryCount = 0;
    // Ready means the surface came back: both ladders restart at their head and
    // the slow mode is dropped, so the next unrelated failure retries fast.
    this.#surfaceIndex = 0;
    this.#surfaceLoss = false;
    this.#pendingDelayMs = null;
    if (wasRestart) this.#restarts += 1;
    this.#lastError = null;
    // Only ready opens intake. Any message emitted before this point has already
    // been dropped, so a fresh Python baseline can never become a replay queue.
    this.#accepting = true;
  }

  #onExit(detail) {
    if (!this.#started || this.#stopping) return;
    this.#accepting = false;
    const code = nonEmptyString(detail?.error) ? detail.error : 'process-exit';
    this.#lastError = code;
    // The adapter exits once on surface loss precisely so this layer can decide
    // the retry pace; its exit code alone is not enough, the stable error code is.
    this.#surfaceLoss = SURFACE_LOSS_CODES.has(code);
    this.#scheduleRestart();
  }

  #scheduleRestart() {
    if (this.#restartTimer || this.#restartInProgress || !this.#started || this.#stopping) return;
    // Retry for as long as the account is configured: the operator fixes the
    // window a moment later, and giving up after three tries is why the bridge
    // used to stay dead until the Host restarted. Past the ladder, keep the
    // slowest delay instead of stopping.
    if (this.#startRetryCount >= this.#startRetryLimit) return;
    // Two ladders, chosen by cause. Surface loss walks the slow one and keeps its
    // own index, so a panel that stays closed for an hour does not add 120 log
    // lines to the Host the way the old flood did.
    const ladder = this.#surfaceLoss ? this.#surfaceLossDelaysMs : this.#restartDelaysMs;
    const index = this.#surfaceLoss
      ? Math.min(this.#surfaceIndex, ladder.length - 1)
      : Math.min(this.#nextRestartIndex, ladder.length - 1);
    const delay = ladder[index];
    if (this.#surfaceLoss) this.#surfaceIndex += 1;
    else this.#nextRestartIndex += 1;
    this.#pendingDelayMs = delay;
    this.#startRetryCount += 1;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.#restart();
    }, delay);
  }

  async #restart() {
    if (!this.#started || this.#stopping) return;
    this.#restartInProgress = true;
    this.#accepting = false;
    // Re-attach the account bridge that #start() cleared when it failed, and take
    // the fresh one when the caller re-starts with a different bridge.
    if (!this.#bridge) this.#bridge = this.#startBridge;
    try {
      await this.#process.start();
      if (this.#process.status?.ready && !this.#accepting) this.#onReady();
    } catch (error) {
      this.#restartInProgress = false;
      this.#restartAttempts += 1;
      this.#lastError = errorCode(error, 'start-failed');
      this.#scheduleRestart();
    }
  }

  #validEvent(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
    if (event.source !== GROUP_EVENT_SOURCE || event.message_type !== 1) return null;
    if (!nonEmptyString(event.message_id) || event.conversation_type !== 'group') return null;
    const group = this.#groups.get(event.conversation_id);
    if (!group || event.conversation_title !== group.title) return null;
    if (!nonEmptyString(event.from_user_id) || !nonEmptyString(event.sender_name)) return null;
    // WeChat 4.1 exposes no sender, so the adapter reports one fixed
    // unverified identity. Accept it only for a group whose owner explicitly
    // opted in, and never let it borrow a real member id.
    if (event.from_user_id === UNVERIFIED_SENDER_ID) {
      if (event.sender_name !== UNVERIFIED_SENDER_ID) return null;
      if (group.allowUnverifiedTrigger !== true) return null;
    } else if (event.from_user_id !== 'uia-name:' + event.sender_name) return null;
    if (event.reply_target !== group.id || event.addressed !== true) return null;
    if (!nonEmptyString(event.text) || !nonEmptyString(event.raw_text)) return null;
    if (!Number.isSafeInteger(event.sent_at) || event.sent_at < 0 || typeof event.is_self !== 'boolean') return null;
    if (event.is_self && !group.allowSelf) return null;
    if (!Array.isArray(event.item_list) || event.item_list.length !== 1) return null;
    const item = event.item_list[0];
    if (item?.type !== 1 || item?.text_item?.text !== event.text) return null;
    // addressed=true is meaningful only when the raw body still proves the
    // configured command trigger. This blocks forged or stale adapter events.
    const candidate = event.raw_text.trimStart();
    if (!candidate.startsWith(group.commandPrefix)) return null;
    const remainder = candidate.slice(group.commandPrefix.length);
    // A prefix must be a complete command token: /dsh正文 is not /dsh 正文.
    if (!remainder || !/^\s/.test(remainder)) return null;
    const triggeredText = remainder.trim();
    if (!triggeredText || triggeredText !== event.text) return null;
    return group;
  }

  #onMessage(event) {
    // Silence here is the worst failure mode: the adapter is demonstrably live,
    // so a dropped event must name its reason instead of vanishing.
    if (!this.#accepting) {
      this.#messagesRejected += 1;
      this.#logger.warn?.('[dsh-weixin] dropped group event while intake was closed');
      return;
    }
    if (!this.#bridge) {
      this.#messagesRejected += 1;
      this.#logger.warn?.('[dsh-weixin] dropped group event: no account bridge attached');
      return;
    }
    if (!this.#validEvent(event)) {
      this.#messagesRejected += 1;
      const messageId = nonEmptyString(event?.message_id) ? event.message_id.slice(0, 16) : 'unknown';
      this.#logger.warn?.('[dsh-weixin] rejected group event ' + messageId);
      return;
    }
    this.#messagesAccepted += 1;
    // Track the exact promise handed to the bridge so stop can finish accepted
    // work before it terminates Python. Errors are sanitized to message IDs.
    const task = Promise.resolve()
      .then(() => this.#bridge.accept(event))
      .catch((error) => {
        this.#lastError = errorCode(error, 'message-failed');
        this.#logger.error?.('[dsh-weixin] group event handling failed ' + String(event.message_id).slice(0, 16));
      })
      .finally(() => this.#pending.delete(task));
    this.#pending.add(task);
  }

  async waitForIdle() {
    await Promise.allSettled([...this.#pending]);
    await this.#bridge?.waitForIdle?.();
  }

  /** Stop intake and Python, but leave the account-owned bridge open. */
  async stop() {
    if (this.#stopping) return this.#stopping;
    if (!this.#started) {
      this.#accepting = false;
      return this.status;
    }
    this.#accepting = false;
    this.#started = false;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    this.#restartInProgress = false;

    const stopping = (async () => {
      let failure = null;
      try {
        await this.waitForIdle();
      } catch (error) {
        failure = error;
      }
      try {
        await this.#process.stop();
      } catch (error) {
        failure ??= error;
      }
      this.#bridge = null;
      if (failure) {
        this.#lastError = errorCode(failure, 'stop-failed');
        throw failure;
      }
      this.#lastError = null;
      return this.status;
    })();
    this.#stopping = stopping;
    try {
      return await stopping;
    } finally {
      if (this.#stopping === stopping) this.#stopping = null;
    }
  }
}
