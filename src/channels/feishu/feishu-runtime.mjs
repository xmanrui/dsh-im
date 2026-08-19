import { FeishuHarnessBridge } from './bridge.mjs';
import { VerifiedFeishuChannel } from './feishu-channel.mjs';
import {
  connectionTestTargetUnavailable,
  sendRememberedConnectionTest,
} from '../shared/connection-test.mjs';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

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
    lastMessageAt: null,
    lastReplyAt: null,
    lastRejectedAt: null,
    lastError: null,
    agentPreset: 'standard',
    authorizationMode: 'sender-open-id-allowlist',
    allowedSenderCount,
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
  #appId;
  #appSecret;
  #domain;
  #ownerOpenIds;
  #harness;
  #state;
  #replyTimeoutMs;
  #connectTimeoutMs;
  #requestTimeoutMs;
  #logger;
  #client = null;
  #bridge = null;
  #wsClient = null;
  #starting = null;
  #abortController = null;
  #status;

  constructor({
    lark,
    appId,
    appSecret,
    domain = 'feishu',
    ownerOpenId,
    ownerOpenIds,
    harness,
    state,
    replyTimeoutMs = 600000,
    connectTimeoutMs = 15000,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    logger = console,
  }) {
    if (!lark) throw new Error('FeishuRuntime requires the Feishu SDK');
    if (!appId || !appSecret) throw new Error('FeishuRuntime requires app credentials');
    const allowedOwners = Array.isArray(ownerOpenIds) ? ownerOpenIds : [ownerOpenId];
    const normalizedOwners = [...new Set(allowedOwners.filter((value) => typeof value === 'string' && value))];
    if (normalizedOwners.length === 0) throw new Error('FeishuRuntime requires at least one owner open_id');
    if (!harness) throw new Error('FeishuRuntime requires a Harness client');
    if (!state) throw new Error('FeishuRuntime requires a state store');
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new TypeError('FeishuRuntime requestTimeoutMs must be a positive number');
    }

    this.#lark = lark;
    this.#appId = appId;
    this.#appSecret = appSecret;
    this.#domain = domain;
    this.#ownerOpenIds = normalizedOwners;
    this.#harness = harness;
    this.#state = state;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#logger = logger;
    this.#status = createBridgeStatus({ allowedSenderCount: normalizedOwners.length });
  }

  get status() {
    return structuredClone(this.#status);
  }

  async start() {
    if (this.#wsClient && this.#status.ready) return this.status;
    if (this.#starting) return this.#starting;

    this.#starting = this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #start() {
    const abortController = new AbortController();
    this.#abortController = abortController;
    const { signal } = abortController;
    this.#status.startedAt = new Date().toISOString();
    this.#status.feishuLongConnectionState = 'connecting';
    this.#status.lastError = null;

    try {
      await this.#harness.ensureRunning({ signal });
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
      this.#client = new this.#lark.Client(larkConfig);
      const channel = new VerifiedFeishuChannel({
        client: this.#client,
        initialText: '已连接 DeepSeek Harness，正在思考…',
      });
      this.#bridge = new FeishuHarnessBridge({
        client: this.#client,
        channel,
        harness: this.#harness,
        state: this.#state,
        status: this.#status,
        allowedSenderOpenIds: new Set(this.#ownerOpenIds),
        replyTimeoutMs: this.#replyTimeoutMs,
        signal,
        logger: this.#logger,
      });

      const dispatcher = new this.#lark.EventDispatcher({}).register({
        'im.message.receive_v1': (event) => {
          this.#bridge.accept(event);
          return {};
        },
        'im.message.reaction.created_v1': () => ({}),
        'im.message.reaction.deleted_v1': () => ({}),
        // Interactive-card button callbacks (only delivered when the app
        // subscribes card.action.trigger; the number-reply fallback covers
        // apps that do not).
        'card.action.trigger': (event) => {
          this.#bridge.onCardAction(event);
          return {};
        },
      });

      let settleReady;
      let settleError;
      const ready = new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(`Feishu WebSocket handshake timed out after ${this.#connectTimeoutMs}ms`));
        }, this.#connectTimeoutMs);
        settleReady = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        settleError = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        };
      });

      this.#wsClient = new this.#lark.WSClient({
        ...larkConfig,
        loggerLevel: this.#lark.LoggerLevel.info,
        handshakeTimeoutMs: 15000,
        onReady: () => {
          this.#status.feishuLongConnectionState = 'connected';
          this.#status.ready = true;
          this.#status.lastError = null;
          settleReady();
        },
        onError: (error) => {
          this.#status.feishuLongConnectionState = 'failed';
          this.#status.ready = false;
          this.#status.lastError = error?.message ?? String(error);
          this.#logger.error('[dsh-feishu] Feishu long connection failed:', this.#status.lastError);
          settleError(error);
        },
        onReconnecting: () => {
          this.#status.feishuLongConnectionState = 'reconnecting';
          this.#status.ready = false;
        },
        onReconnected: () => {
          this.#status.feishuLongConnectionState = 'connected';
          this.#status.ready = true;
          this.#status.lastError = null;
        },
      });
      await this.#wsClient.start({ eventDispatcher: dispatcher }).catch((error) => {
        settleError(error);
      });
      await ready;
      return this.status;
    } catch (error) {
      this.#status.ready = false;
      this.#status.feishuLongConnectionState = 'failed';
      this.#status.lastError = error?.message ?? String(error);
      await this.stop({ preserveError: true });
      throw error;
    }
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
      channelLabel: '飞书机器人',
      send: async (target, content) => {
        const chatId = typeof target?.chatId === 'string' ? target.chatId.trim() : '';
        if (!chatId) throw connectionTestTargetUnavailable('飞书机器人');
        await send('chat_id', chatId, content);
      },
    });
  }

  async stop({ preserveError = false } = {}) {
    const error = preserveError ? this.#status.lastError : null;
    const abortController = this.#abortController;
    this.#abortController = null;
    abortController?.abort(new DOMException('Feishu runtime stopped', 'AbortError'));
    this.#status.ready = false;
    if (this.#wsClient) {
      this.#wsClient.close({ force: true });
      this.#wsClient = null;
    }
    if (this.#bridge) {
      await this.#bridge.waitForIdle();
      this.#bridge = null;
    }
    this.#client = null;
    this.#status.feishuLongConnectionState = preserveError ? 'failed' : 'idle';
    this.#status.lastError = error;
    return this.status;
  }
}
