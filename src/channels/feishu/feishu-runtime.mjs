import { randomUUID } from 'node:crypto';
import { FeishuHarnessBridge } from './bridge.mjs';
import { cardActionProbeCard } from './feishu-cards.mjs';
import { VerifiedFeishuChannel } from './feishu-channel.mjs';
import { normalizeFeishuGroupResponseMode } from './group-response-mode.mjs';
import {
  registerSlashCommands,
  SLASH_COMMAND_MANIFEST,
} from './slash-command-registry.mjs';
import {
  connectionTestTargetUnavailable,
  sendRememberedConnectionTest,
} from '../shared/connection-test.mjs';
import { t } from '../shared/i18n.mjs';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const CALLBACK_PROBE_SUCCESS_NOTICE = '✅ 修复完成：已实测收到 card.action.trigger，菜单按钮现在可用。';
const CALLBACK_PROBE_TIMEOUT_NOTICE = '⚠️ 修复验证超时：未收到测试卡按钮的 card.action.trigger，不能确认按钮已修复。请不要重复授权；先检查飞书开放平台的卡片回调配置，确认后再发送 /repair。';
const CALLBACK_PROBE_SEND_FAILURE_NOTICE = '⚠️ 修复验证失败：无法发送专用测试卡，不能确认 card.action.trigger 已恢复。请不要重复授权；先检查机器人消息权限和连接状态。';
const CALLBACK_PROBE_ABORT_NOTICE = '⚠️ 修复验证中断：Runtime 已停止，未完成 card.action.trigger 实测，不能确认修复成功。请不要重复授权；先等待机器人恢复连接。';
const REUSABLE_WS_STATES = new Set(['connected', 'connecting', 'reconnecting']);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function strictCardOperatorOpenId(event) {
  return nonEmptyString(event?.operator?.open_id)
    ?? nonEmptyString(event?.operator?.operator_id?.open_id);
}

function websocketState(wsClient, fallback) {
  try {
    const state = wsClient?.getConnectionStatus?.()?.state;
    return typeof state === 'string' && state ? state : fallback;
  } catch {
    return fallback;
  }
}

function probeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function httpInstanceWithTimeout(httpInstance, timeoutMs) {
  if (!httpInstance || typeof httpInstance.request !== 'function') return undefined;
  const optionsWithTimeout = (options) => ({
    ...(options ?? {}),
    timeout: options?.timeout ?? timeoutMs,
  });
  return {
    request: (options) => httpInstance.request(optionsWithTimeout(options)),
    get: (url, options) => httpInstance.get(url, optionsWithTimeout(options)),
    delete: (url, options) => httpInstance.delete(url, optionsWithTimeout(options)),
    head: (url, options) => httpInstance.head(url, optionsWithTimeout(options)),
    options: (url, options) => httpInstance.options(url, optionsWithTimeout(options)),
    post: (url, data, options) => httpInstance.post(url, data, optionsWithTimeout(options)),
    put: (url, data, options) => httpInstance.put(url, data, optionsWithTimeout(options)),
    patch: (url, data, options) => httpInstance.patch(url, data, optionsWithTimeout(options)),
  };
}

export function createBridgeStatus({ allowedSenderCount = 1 } = {}) {
  return {
    startedAt: null,
    ready: false,
    feishuLongConnectionState: 'idle',
    harnessReachable: false,
    messagesReceived: 0,
    messagesReplied: 0,
    messagesRejected: 0,
    reactionsAdded: 0,
    reactionsRemoved: 0,
    reactionErrors: 0,
    streamResponses: 0,
    streamUpdates: 0,
    streamFallbacks: 0,
    streamErrors: 0,
    cardActionsReceived: 0,
    cardActionProbesVerified: 0,
    lastMessageAt: null,
    lastReplyAt: null,
    lastRejectedAt: null,
    lastCardActionAt: null,
    lastError: null,
    agentPreset: 'standard',
    authorizationMode: 'sender-open-id-allowlist',
    allowedSenderCount,
    slashCommandRegistration: 'idle',
    slashCommandsRegistered: 0,
    slashCommandsExisting: 0,
    slashCommandsFailed: 0,
    slashCommandsError: null,
  };
}

/**
 * Owns one live Feishu long connection and the already-tested bridge stack.
 * The class intentionally receives the SDK and Harness dependencies so the
 * plugin can run it in-process while tests exercise the lifecycle without a
 * real Feishu tenant.
 */
export class FeishuRuntime {
  #lark;
  #botId;
  #appId;
  #appSecret;
  #domain;
  #botOpenId;
  #groupResponseMode;
  #ownerOpenIds;
  #harness;
  #state;
  #contextEnhancement;
  #accessPolicy;
  #replyTimeoutMs;
  #connectTimeoutMs;
  #requestTimeoutMs;
  #wsAgent;
  #logger;
  #repair;
  #client = null;
  #bridge = null;
  #wsClient = null;
  #starting = null;
  #stopping = null;
  #abortController = null;
  #pendingCardActionProbes = new Map();
  #status;
  #slashCommands = true;

  constructor({
    lark,
    botId,
    appId,
    appSecret,
    domain = 'feishu',
    botOpenId,
    groupResponseMode,
    ownerOpenId,
    ownerOpenIds,
    harness,
    state,
    contextEnhancement,
    accessPolicy,
    repair,
    replyTimeoutMs = 600000,
    connectTimeoutMs = 15000,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    slashCommands = true,
    wsAgent,
    logger = console,
  }) {
    if (!lark) throw new Error('FeishuRuntime requires the Feishu SDK');
    if (!appId || !appSecret) throw new Error('FeishuRuntime requires app credentials');
    const allowedOwners = Array.isArray(ownerOpenIds) ? ownerOpenIds : [ownerOpenId];
    const normalizedOwners = [...new Set(allowedOwners.filter((value) => typeof value === 'string' && value))];
    if (normalizedOwners.length === 0) throw new Error('FeishuRuntime requires at least one owner open_id');
    if (!harness) throw new Error('FeishuRuntime requires a Harness client');
    if (!state) throw new Error('FeishuRuntime requires a state store');
    if (repair !== undefined && repair !== null && !nonEmptyString(botId)) {
      throw new TypeError('FeishuRuntime repair capability requires a botId');
    }
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new TypeError('FeishuRuntime requestTimeoutMs must be a positive number');
    }

    this.#lark = lark;
    this.#botId = nonEmptyString(botId);
    this.#appId = appId;
    this.#appSecret = appSecret;
    this.#domain = domain;
    this.#botOpenId = nonEmptyString(botOpenId);
    this.#groupResponseMode = normalizeFeishuGroupResponseMode(groupResponseMode);
    this.#ownerOpenIds = normalizedOwners;
    this.#harness = harness;
    this.#state = state;
    this.#contextEnhancement = contextEnhancement;
    this.#accessPolicy = accessPolicy;
    this.#repair = repair ?? null;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#slashCommands = Boolean(slashCommands);
    this.#wsAgent = wsAgent;
    this.#logger = logger;
    this.#status = createBridgeStatus({ allowedSenderCount: normalizedOwners.length });
  }

  get status() {
    return structuredClone(this.#status);
  }

  setGroupResponseMode(value) {
    this.#groupResponseMode = normalizeFeishuGroupResponseMode(value);
    this.#bridge?.setGroupResponseMode(this.#groupResponseMode);
  }

  async start() {
    while (true) {
      while (this.#stopping) await this.#stopping;
      if (this.#starting) return this.#starting;

      const wsClient = this.#wsClient;
      if (wsClient) {
        const state = websocketState(wsClient, this.#status.feishuLongConnectionState);
        if (REUSABLE_WS_STATES.has(state)) return this.status;

        await this.stop({ preserveError: state === 'failed' });
        continue;
      }

      // A partial/failed attempt may have created resources before its
      // WSClient became observable. Drain them before assigning a new attempt.
      if (this.#client || this.#bridge || this.#abortController) {
        await this.stop({
          preserveError: this.#status.feishuLongConnectionState === 'failed',
        });
        continue;
      }

      break;
    }

    let starting;
    starting = this.#start().finally(() => {
      if (this.#starting === starting) this.#starting = null;
    });
    this.#starting = starting;
    return starting;
  }

  async #start() {
    const abortController = new AbortController();
    this.#abortController = abortController;
    const { signal } = abortController;
    const abortError = () => (
      signal.reason ?? new DOMException('Feishu runtime stopped', 'AbortError')
    );
    const isCurrentStart = () => (
      !signal.aborted && this.#abortController === abortController
    );
    const assertCurrentStart = () => {
      if (!isCurrentStart()) throw abortError();
    };
    this.#status.startedAt = new Date().toISOString();
    this.#status.feishuLongConnectionState = 'connecting';
    this.#status.lastError = null;

    try {
      await this.#harness.ensureRunning({ signal });
      assertCurrentStart();
      this.#status.harnessReachable = true;

      const sdkDomain = this.#domain === 'lark'
        ? this.#lark.Domain.Lark
        : this.#lark.Domain.Feishu;
      const larkConfig = {
        appId: this.#appId,
        appSecret: this.#appSecret,
        domain: sdkDomain,
      };
      const httpInstance = httpInstanceWithTimeout(
        this.#lark.defaultHttpInstance,
        this.#requestTimeoutMs,
      );
      if (httpInstance) larkConfig.httpInstance = httpInstance;
      const client = new this.#lark.Client(larkConfig);
      this.#client = client;
      const channel = new VerifiedFeishuChannel({
        client,
        initialText: t('已连接 DeepSeek Harness，正在思考…'),
      });
      const bridge = new FeishuHarnessBridge({
        client,
        channel,
        harness: this.#harness,
        state: this.#state,
        contextEnhancement: this.#contextEnhancement,
        accessPolicy: this.#accessPolicy,
        status: this.#status,
        allowedSenderOpenIds: new Set(this.#ownerOpenIds),
        botId: this.#botId,
        appId: this.#appId,
        botOpenId: this.#botOpenId,
        groupResponseMode: this.#groupResponseMode,
        repair: this.#repair,
        replyTimeoutMs: this.#replyTimeoutMs,
        // Interaction cards (approval/question buttons) are on by default.
        // Set DSH_IM_INTERACTION_CARDS=0 to fall back to plain-text replies.
        interactionCards: !['0', 'false', 'no', 'off'].includes(
          String(process.env.DSH_IM_INTERACTION_CARDS ?? '').trim().toLowerCase(),
        ),
        signal,
        logger: this.#logger,
      });
      this.#bridge = bridge;

      const dispatcher = new this.#lark.EventDispatcher({}).register({
        'im.message.receive_v1': (event) => {
          if (isCurrentStart()) void bridge.accept(event);
        },
        'im.message.reaction.created_v1': () => undefined,
        'im.message.reaction.deleted_v1': () => undefined,
        // Interactive-card button callbacks (only delivered when the app
        // subscribes card.action.trigger; the number-reply fallback covers
        // apps that do not).
        'card.action.trigger': (event) => {
          if (!isCurrentStart()) return;
          this.#status.cardActionsReceived += 1;
          this.#status.lastCardActionAt = new Date().toISOString();
          if (!this.#consumeCardActionProbe(event)) void bridge.onCardAction(event);
        },
      });

      let settleReady;
      let settleError;
      const ready = new Promise((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
          settleError(abortError());
        };
        const settle = (callback, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          callback(value);
        };
        const timer = setTimeout(() => {
          settle(
            reject,
            new Error(`Feishu WebSocket handshake timed out after ${this.#connectTimeoutMs}ms`),
          );
        }, this.#connectTimeoutMs);
        settleReady = () => {
          settle(resolve);
        };
        settleError = (error) => {
          settle(reject, error);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      // The SDK constructor can throw before Promise.all attaches below.
      // Keep the abort-driven rejection observed in that path as well.
      void ready.catch(() => undefined);

      const wsClient = new this.#lark.WSClient({
        ...larkConfig,
        ...(this.#wsAgent ? { agent: this.#wsAgent } : {}),
        loggerLevel: this.#lark.LoggerLevel.info,
        handshakeTimeoutMs: this.#connectTimeoutMs,
        onReady: () => {
          if (!isCurrentStart()) return;
          this.#status.feishuLongConnectionState = 'connected';
          this.#status.ready = true;
          this.#status.lastError = null;
          settleReady();
        },
        onError: (error) => {
          if (!isCurrentStart()) return;
          this.#status.feishuLongConnectionState = 'failed';
          this.#status.ready = false;
          this.#status.lastError = error?.message ?? String(error);
          this.#logger.error('[dsh-feishu] Feishu long connection failed:', this.#status.lastError);
          settleError(error);
        },
        onReconnecting: () => {
          if (!isCurrentStart()) return;
          this.#status.feishuLongConnectionState = 'reconnecting';
          this.#status.ready = false;
        },
        onReconnected: () => {
          if (!isCurrentStart()) return;
          this.#status.feishuLongConnectionState = 'connected';
          this.#status.ready = true;
          this.#status.lastError = null;
        },
      });
      this.#wsClient = wsClient;
      const wsStarted = Promise.resolve()
        .then(() => wsClient.start({ eventDispatcher: dispatcher }))
        .catch((error) => {
          settleError(error);
          throw error;
        });
      await Promise.all([wsStarted, ready]);
      assertCurrentStart();
      // Register the native Slash Command panel best-effort and asynchronously
      // so it never blocks the long-connection startup. The panel is only a
      // client-side convenience; failure here must not take the bot down.
      if (this.#slashCommands && httpInstance) {
        void this.#registerSlashCommands(httpInstance, isCurrentStart, signal);
      }
      return this.status;
    } catch (error) {
      // stop() owns the terminal idle state for an explicitly aborted start.
      // In particular, do not let the rejected handshake waiter overwrite it.
      if (signal.aborted) throw error;
      this.#status.ready = false;
      this.#status.feishuLongConnectionState = 'failed';
      this.#status.lastError = error?.message ?? String(error);
      await this.#cleanup({ preserveError: true, abortController });
      throw error;
    }
  }

  /**
   * Send a one-shot callback card and resolve only after Feishu delivers the
   * exact message/nonce/operator tuple over card.action.trigger. The controller
   * uses this as the final proof for both browser- and chat-initiated repairs.
   */
  async beginCardActionProbe({ expectedOperatorOpenId, timeoutMs = 90_000 } = {}) {
    if (!this.#status.ready || !this.#client) {
      throw probeError('card_action_probe_unavailable', '飞书机器人尚未连接');
    }
    const operatorOpenId = nonEmptyString(expectedOperatorOpenId);
    if (!operatorOpenId || operatorOpenId === '*') {
      throw new TypeError('A precise Feishu operator open_id is required');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10 * 60_000) {
      throw new TypeError('Card-action probe timeout must be between 1 and 600000ms');
    }

    const nonce = randomUUID().replaceAll('-', '');
    let response;
    try {
      response = await this.#client.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: operatorOpenId,
          msg_type: 'interactive',
          content: cardActionProbeCard(nonce),
        },
      });
    } catch {
      void this.#sendCardActionProbeNotice(
        operatorOpenId,
        t(CALLBACK_PROBE_SEND_FAILURE_NOTICE),
        'failure',
      );
      throw probeError('card_action_probe_send_failed', '无法发送飞书卡片回调测试');
    }
    if (response?.code && response.code !== 0) {
      void this.#sendCardActionProbeNotice(
        operatorOpenId,
        t(CALLBACK_PROBE_SEND_FAILURE_NOTICE),
        'failure',
      );
      throw probeError('card_action_probe_send_failed', '无法发送飞书卡片回调测试');
    }
    const messageId = nonEmptyString(response?.data?.message_id)
      ?? nonEmptyString(response?.message_id);
    if (!messageId) {
      void this.#sendCardActionProbeNotice(
        operatorOpenId,
        t(CALLBACK_PROBE_SEND_FAILURE_NOTICE),
        'failure',
      );
      throw probeError('card_action_probe_send_failed', '飞书未返回测试卡片的消息 ID');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const current = this.#pendingCardActionProbes.get(messageId);
        if (!current || current.nonce !== nonce) return;
        this.#pendingCardActionProbes.delete(messageId);
        void this.#sendCardActionProbeNotice(
          operatorOpenId,
          t(CALLBACK_PROBE_TIMEOUT_NOTICE),
          'timeout',
        );
        reject(probeError(
          'card_action_probe_timeout',
          '在规定时间内未收到飞书卡片按钮回调',
        ));
      }, timeoutMs);
      timeout.unref?.();
      this.#pendingCardActionProbes.set(messageId, {
        messageId,
        nonce,
        expectedOperatorOpenId: operatorOpenId,
        timeout,
        resolve,
        reject,
      });
    });
  }

  #consumeCardActionProbe(event) {
    const messageId = nonEmptyString(event?.context?.open_message_id);
    if (!messageId) return false;
    const probe = this.#pendingCardActionProbes.get(messageId);
    if (!probe) return false;
    const value = event?.action?.value;
    const operatorOpenId = strictCardOperatorOpenId(event);
    if (value?.action !== 'repair_verify'
      || value?.nonce !== probe.nonce
      || operatorOpenId !== probe.expectedOperatorOpenId) {
      return false;
    }
    clearTimeout(probe.timeout);
    this.#pendingCardActionProbes.delete(messageId);
    this.#status.cardActionProbesVerified += 1;
    // Start the terminal notification before resolving the controller-facing
    // probe. A repair may rotate the App Secret and immediately replace this
    // runtime after resolution; initiating the send here keeps chat and web
    // repair flows equally observable. Notification failure never invalidates
    // the callback proof itself.
    void this.#sendCardActionProbeNotice(
      operatorOpenId,
      t(CALLBACK_PROBE_SUCCESS_NOTICE),
      'success',
    ).finally(() => {
      probe.resolve({
        verified: true,
        messageId,
        operatorOpenId,
      });
    });
    return true;
  }

  #sendCardActionProbeNotice(operatorOpenId, text, outcome) {
    const client = this.#client;
    if (!client) {
      this.#logger.warn?.(`[dsh-feishu] unable to send the callback repair ${outcome} notice`);
      return Promise.resolve(false);
    }
    return Promise.resolve().then(async () => {
      const response = await client.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: operatorOpenId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
      if (response?.code && response.code !== 0) {
        throw new Error('Feishu callback repair notice failed');
      }
      return true;
    }).catch(() => {
      this.#logger.warn?.(`[dsh-feishu] unable to send the callback repair ${outcome} notice`);
      return false;
    });
  }

  async sendConnectionTest(text) {
    if (!this.#status.ready || !this.#client) {
      const error = new Error('飞书机器人尚未连接');
      error.code = 'test-target-unavailable';
      throw error;
    }
    if (typeof text !== 'string' || !text.trim()) {
      throw new TypeError('Feishu connection test text is required');
    }
    const send = async (receiveIdType, receiveId, content) => {
      const response = await this.#client.im.v1.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: 'text',
          content: JSON.stringify({ text: content }),
        },
      });
      if (response?.code && response.code !== 0) {
        throw new Error(`Feishu connection test failed: ${response.msg || response.code}`);
      }
    };

    const ownerOpenId = this.#ownerOpenIds.find((value) => value !== '*');
    if (ownerOpenId) {
      await send('open_id', ownerOpenId, text);
      return { sent: true };
    }

    return sendRememberedConnectionTest({
      state: this.#state,
      text,
      channelLabel: t('飞书机器人'),
      send: async (target, content) => {
        const chatId = typeof target?.chatId === 'string' ? target.chatId.trim() : '';
        if (!chatId) throw connectionTestTargetUnavailable(t('飞书机器人'));
        await send('chat_id', chatId, content);
      },
    });
  }

  async sendProactiveText(target, text, { signal } = {}) {
    if (!this.#status.ready || !this.#client) {
      const error = new Error('飞书机器人尚未连接');
      error.code = 'bot-not-connected';
      throw error;
    }
    const receiveIdType = target?.kind === 'user' ? 'open_id'
      : target?.kind === 'group' ? 'chat_id' : null;
    const receiveId = target?.kind === 'user'
      ? nonEmptyString(target?.route?.openId)
      : target?.kind === 'group'
        ? nonEmptyString(target?.route?.chatId)
        : null;
    if (!receiveIdType || !receiveId) {
      const error = new TypeError('Invalid Feishu proactive delivery target');
      error.code = 'invalid-target';
      throw error;
    }
    signal?.throwIfAborted();
    const response = await this.#client.im.v1.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    if (response?.code && response.code !== 0) {
      const error = new Error(`Feishu proactive delivery failed: ${response.msg || response.code}`);
      error.code = 'target-rejected';
      throw error;
    }
    return { sent: true };
  }

  async #registerSlashCommands(httpInstance, isCurrentStart, signal) {
    this.#status.slashCommandRegistration = 'registering';
    this.#status.slashCommandsError = null;
    try {
      const result = await registerSlashCommands({
        appId: this.#appId,
        appSecret: this.#appSecret,
        domain: this.#domain,
        httpInstance,
        signal,
        manifest: SLASH_COMMAND_MANIFEST,
      });
      if (!isCurrentStart()) return;
      this.#status.slashCommandRegistration = 'done';
      this.#status.slashCommandsRegistered = result.created.length;
      this.#status.slashCommandsExisting = result.existing.length;
      this.#status.slashCommandsFailed = result.failed.length;
      this.#status.slashCommandsError = result.failed.length > 0
        ? result.failed.map((f) => `/${f.command}: ${f.error?.message ?? String(f.error)}`).join('; ')
        : null;
      if (result.created.length > 0) {
        this.#logger.info?.(`[dsh-feishu] registered ${result.created.length} slash command(s)`);
      }
      if (result.failed.length > 0) {
        this.#logger.warn?.(
          `[dsh-feishu] ${result.failed.length} slash command(s) failed to register: ${this.#status.slashCommandsError}`,
        );
      }
    } catch (error) {
      if (!isCurrentStart()) return;
      this.#status.slashCommandRegistration = 'failed';
      this.#status.slashCommandsError = error?.message ?? String(error);
      this.#logger.warn?.(
        `[dsh-feishu] slash command registration skipped: ${this.#status.slashCommandsError}`,
      );
    }
  }

  stop(options = {}) {
    if (this.#stopping) return this.#stopping;

    let stopping;
    stopping = this.#stop(options).finally(() => {
      if (this.#stopping === stopping) this.#stopping = null;
    });
    this.#stopping = stopping;
    return stopping;
  }

  async #stop({ preserveError = false } = {}) {
    const abortController = this.#abortController;
    if (this.#abortController === abortController) this.#abortController = null;
    abortController?.abort(new DOMException('Feishu runtime stopped', 'AbortError'));

    const starting = this.#starting;
    if (starting) await starting.catch(() => undefined);
    return this.#cleanup({ preserveError, abortController });
  }

  async #cleanup({ preserveError = false, abortController } = {}) {
    const error = preserveError ? this.#status.lastError : null;
    if (this.#abortController === abortController) this.#abortController = null;
    abortController?.abort(new DOMException('Feishu runtime stopped', 'AbortError'));
    for (const probe of this.#pendingCardActionProbes.values()) {
      clearTimeout(probe.timeout);
      void this.#sendCardActionProbeNotice(
        probe.expectedOperatorOpenId,
        t(CALLBACK_PROBE_ABORT_NOTICE),
        'abort',
      );
      probe.reject(probeError('abort', '飞书运行时已停止'));
    }
    this.#pendingCardActionProbes.clear();
    this.#status.ready = false;
    const wsClient = this.#wsClient;
    this.#wsClient = null;
    wsClient?.close({ force: true });
    const bridge = this.#bridge;
    this.#bridge = null;
    if (bridge) await bridge.waitForIdle();
    this.#client = null;
    this.#status.feishuLongConnectionState = preserveError ? 'failed' : 'idle';
    this.#status.slashCommandRegistration = 'idle';
    this.#status.lastError = error;
    return this.status;
  }
}
