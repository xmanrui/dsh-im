const GROUP_EVENT_SOURCE = 'uia-wechat-group/v1';
const UNVERIFIED_SENDER_ID = 'uia-unverified:row';

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
  #bridge = null;
  #starting = null;
  #stopping = null;
  #started = false;
  #accepting = false;
  #pending = new Set();
  #restartTimer = null;
  #restartInProgress = false;
  #nextRestartIndex = 0;
  #restartAttempts = 0;
  #restarts = 0;
  #messagesAccepted = 0;
  #messagesRejected = 0;
  #lastError = null;

  constructor({
    config,
    process: groupProcess,
    harness = null,
    logger = console,
    restartDelaysMs = [250, 1_000, 5_000],
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
    this.#groups = new Map(config.groups.map((group) => [group.id, group]));
    this.#process = groupProcess;
    this.#harness = harness;
    this.#logger = logger;
    this.#restartDelaysMs = [...restartDelaysMs];

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
      messagesAccepted: this.#messagesAccepted,
      messagesRejected: this.#messagesRejected,
      lastError: this.#lastError,
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
      await this.#harness?.ensureRunning?.();
      await this.#process.start();
      // The real process emits ready before resolving start. The fallback also
      // supports process doubles that only expose a ready status property.
      if (this.#process.status?.ready && !this.#accepting) this.#onReady();
      return this.status;
    } catch (error) {
      this.#accepting = false;
      this.#started = false;
      this.#lastError = errorCode(error, 'start-failed');
      await this.#process.stop().catch(() => undefined);
      this.#bridge = null;
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
    if (wasRestart) this.#restarts += 1;
    this.#lastError = null;
    // Only ready opens intake. Any message emitted before this point has already
    // been dropped, so a fresh Python baseline can never become a replay queue.
    this.#accepting = true;
  }

  #onExit(detail) {
    if (!this.#started || this.#stopping) return;
    this.#accepting = false;
    this.#lastError = nonEmptyString(detail?.error) ? detail.error : 'process-exit';
    this.#scheduleRestart();
  }

  #scheduleRestart() {
    if (this.#restartTimer || this.#restartInProgress || !this.#started || this.#stopping) return;
    if (this.#nextRestartIndex >= this.#restartDelaysMs.length) return;
    const delay = this.#restartDelaysMs[this.#nextRestartIndex];
    this.#nextRestartIndex += 1;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.#restart();
    }, delay);
  }

  async #restart() {
    if (!this.#started || this.#stopping) return;
    this.#restartInProgress = true;
    this.#accepting = false;
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
    if (!this.#accepting || !this.#bridge) return;
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
