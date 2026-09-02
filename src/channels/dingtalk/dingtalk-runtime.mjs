import { createDingtalkApi } from './dingtalk-api.mjs';
import {
  createDingtalkBridgeStatus,
  DingtalkHarnessBridge,
  DINGTALK_DEFAULT_REPLY_TIMEOUT_MS,
} from './dingtalk-bridge.mjs';
import { sendRememberedConnectionTest } from '../shared/connection-test.mjs';
import { t } from '../shared/i18n.mjs';
import { captureContextEnhancement } from '../shared/context-enhancement.mjs';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function approvedSenderIds(config) {
  const entries = Array.isArray(config?.approvedSenders)
    ? config.approvedSenders
    : config?.approvedSenders instanceof Set
      ? [...config.approvedSenders]
      : [];
  return new Set(entries.map((entry) => nonEmptyString(
    typeof entry === 'string' ? entry : entry?.staffId,
  )).filter(Boolean));
}

function approvedSenderCount(config) {
  return approvedSenderIds(config).size;
}

function streamIsOpen(client) {
  return client?.connected === true || client?.socket?.readyState === 1;
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function waitForStreamOpen(client, pollIntervalMs, signal) {
  while (true) {
    signal?.throwIfAborted();
    if (streamIsOpen(client)) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, pollIntervalMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

async function connectStream(client, timeoutMs, pollIntervalMs, signal) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const connectSignal = AbortSignal.any([signal, timeoutSignal]);
  let connectSettled = false;
  const connectTask = Promise.resolve()
    .then(() => client.connect())
    .finally(() => { connectSettled = true; });
  try {
    await abortable(connectTask, connectSignal);
    await waitForStreamOpen(client, pollIntervalMs, connectSignal);
  } catch (error) {
    if (connectSignal.aborted) {
      if (!connectSettled) {
        void connectTask.then(() => client.disconnect()).catch(() => undefined);
      }
      if (signal.aborted) throw signal.reason;
      throw new Error(`DingTalk Stream handshake timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

async function defaultStreamFactory({ clientId, clientSecret }) {
  const { DWClient, TOPIC_ROBOT } = await import('dingtalk-stream');
  return {
    client: new DWClient({
      clientId,
      clientSecret,
      endpoint: 'https://api.dingtalk.com',
      autoReconnect: false,
      keepAlive: true,
      debug: false,
    }),
    topic: TOPIC_ROBOT,
  };
}

export function createDingtalkRuntimeStatus({
  pendingSenders = [],
  approvedSenders = 0,
} = {}) {
  return {
    startedAt: null,
    ready: false,
    dingtalkStreamState: 'idle',
    harnessReachable: false,
    lastConnectedAt: null,
    lastCheckedAt: null,
    lastCallbackAt: null,
    authorizationMode: 'sender-staff-id-approval',
    approvedSenderCount: approvedSenders,
    ...createDingtalkBridgeStatus({ pendingSenders }),
  };
}

export class DingtalkRuntime {
  #config;
  #clientSecret;
  #harness;
  #state;
  #contextEnhancement;
  #accessPolicy;
  #logger;
  #replyTimeoutMs;
  #maxMessageChars;
  #connectTimeoutMs;
  #connectPollIntervalMs;
  #api;
  #streamFactory;
  #status;
  #client = null;
  #bridge = null;
  #topic = null;
  #starting = null;
  #connectionMonitor = null;
  #abortController = null;
  #callbackTasks = new Set();

  constructor({
    config,
    clientSecret,
    harness,
    state,
    contextEnhancement,
    accessPolicy,
    logger = console,
    replyTimeoutMs = DINGTALK_DEFAULT_REPLY_TIMEOUT_MS,
    maxMessageChars = 4_000,
    connectTimeoutMs = 15_000,
    connectPollIntervalMs = 25,
    api = createDingtalkApi(),
    streamFactory = defaultStreamFactory,
  }) {
    if (!config || !nonEmptyString(config.clientId) || !nonEmptyString(clientSecret)) {
      throw new TypeError('DingtalkRuntime requires app credentials');
    }
    if (!harness || !state) throw new TypeError('DingtalkRuntime requires Harness and state');
    if (typeof streamFactory !== 'function') throw new TypeError('streamFactory must be a function');
    this.#config = config;
    this.#clientSecret = clientSecret.trim();
    this.#harness = harness;
    this.#state = state;
    this.#contextEnhancement = contextEnhancement;
    this.#accessPolicy = accessPolicy;
    this.#logger = logger;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#maxMessageChars = maxMessageChars;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#connectPollIntervalMs = connectPollIntervalMs;
    this.#api = api;
    this.#streamFactory = streamFactory;
    this.#status = createDingtalkRuntimeStatus({
      pendingSenders: this.#pendingSenders(),
      approvedSenders: approvedSenderCount(config),
    });
  }

  get status() {
    if (this.#bridge) {
      const bridgeStatus = this.#bridge.status;
      Object.assign(this.#status, bridgeStatus);
    } else {
      this.#status.pendingSenders = this.#pendingSenders();
    }
    return structuredClone(this.#status);
  }

  pendingSender(requestId) {
    return typeof this.#state.pendingSender === 'function'
      ? this.#state.pendingSender(requestId)
      : null;
  }

  pendingSenders() {
    return this.#pendingSenders();
  }

  async start() {
    if (this.#client && this.#status.ready) return this.status;
    if (this.#starting) return this.#starting;
    this.#starting = this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #start() {
    await this.stop();
    const abortController = new AbortController();
    this.#abortController = abortController;
    const { signal } = abortController;
    this.#status.startedAt = new Date().toISOString();
    this.#status.dingtalkStreamState = 'connecting';
    this.#status.lastError = null;

    try {
      await this.#harness.ensureRunning({ signal });
      this.#status.harnessReachable = true;
      if (typeof this.#state.removePendingSenderByStaffId === 'function') {
        for (const staffId of approvedSenderIds(this.#config)) {
          await this.#state.removePendingSenderByStaffId(staffId);
        }
        this.#status.pendingSenders = this.#pendingSenders();
      }
      this.#bridge = new DingtalkHarnessBridge({
        api: this.#api,
        clientId: this.#config.clientId,
        clientSecret: this.#clientSecret,
        approvedSenders: this.#config.approvedSenders,
        harness: this.#harness,
        state: this.#state,
        contextEnhancement: this.#contextEnhancement,
        accessPolicy: this.#accessPolicy,
        status: this.#status,
        logger: this.#logger,
        replyTimeoutMs: this.#replyTimeoutMs,
        maxMessageChars: this.#maxMessageChars,
        signal,
      });

      const created = await this.#streamFactory({
        clientId: this.#config.clientId,
        clientSecret: this.#clientSecret,
      });
      signal.throwIfAborted();
      this.#client = created?.client ?? created;
      this.#topic = created?.topic ?? created?.TOPIC_ROBOT ?? '/v1.0/im/bot/messages/get';
      if (!this.#client
        || typeof this.#client.registerCallbackListener !== 'function'
        || typeof this.#client.connect !== 'function'
        || typeof this.#client.disconnect !== 'function'
        || typeof this.#client.socketCallBackResponse !== 'function') {
        throw new TypeError('streamFactory returned an invalid DingTalk Stream client');
      }

      const client = this.#client;
      const bridge = this.#bridge;
      client.registerCallbackListener(this.#topic, (response) => {
        if (this.#client !== client || this.#bridge !== bridge) return;
        const callbackMessageId = nonEmptyString(response?.headers?.messageId);
        if (callbackMessageId) {
          try {
            client.socketCallBackResponse(callbackMessageId, { success: true });
          } catch {
            this.#logger.warn?.('[dsh-dingtalk] unable to acknowledge an inbound callback');
          }
        }

        // Retain the committed, read-only settings at receipt without moving
        // JSON parsing out of the existing asynchronous callback path.
        const contextEnhancement = this.#contextEnhancement;
        let receivedSettings;
        try {
          receivedSettings = contextEnhancement?.getSettings?.();
        } catch {
          // Optional settings failures leave the original message path active.
        }
        const task = Promise.resolve().then(async () => {
          if (this.#bridge !== bridge) return;
          let message;
          try {
            message = typeof response?.data === 'string'
              ? JSON.parse(response.data)
              : response?.data;
          } catch {
            this.#status.lastError = t('钉钉消息格式无效。');
            this.#logger.warn?.('[dsh-dingtalk] ignored an invalid callback payload');
            return;
          }
          if (!message || typeof message !== 'object') return;
          this.#status.lastCallbackAt = Date.now();
          const contextSnapshot = captureContextEnhancement({
            getSettings: () => receivedSettings,
            get botId() { return contextEnhancement?.botId; },
          }, message.conversationType === '1' || message.conversationType === 1 ? 'direct'
            : message.conversationType === '2' || message.conversationType === 2 ? 'group' : null);
          await bridge.accept(message, { contextSnapshot });
        }).catch(() => {
          if (signal.aborted || this.#bridge !== bridge) return;
          this.#status.lastError = t('钉钉消息处理失败。');
          this.#logger.error?.('[dsh-dingtalk] callback processing failed');
        }).finally(() => this.#callbackTasks.delete(task));
        this.#callbackTasks.add(task);
      });

      await connectStream(
        client,
        this.#connectTimeoutMs,
        this.#connectPollIntervalMs,
        signal,
      );
      this.#status.ready = true;
      this.#status.dingtalkStreamState = 'connected';
      this.#status.lastConnectedAt = Date.now();
      this.#status.lastCheckedAt = Date.now();
      this.#status.lastError = null;
      this.#connectionMonitor = setInterval(() => {
        const connected = streamIsOpen(client);
        this.#status.ready = connected;
        this.#status.dingtalkStreamState = connected ? 'connected' : 'reconnecting';
        this.#status.lastCheckedAt = Date.now();
        if (connected) this.#status.lastError = null;
      }, 1_000);
      this.#connectionMonitor.unref?.();
      return this.status;
    } catch (error) {
      const aborted = signal.aborted;
      this.#status.ready = false;
      this.#status.dingtalkStreamState = aborted ? 'idle' : 'failed';
      this.#status.lastError = aborted ? null : (error?.message ?? String(error));
      await this.stop({ preserveError: !aborted });
      throw error;
    }
  }

  async stop({ preserveError = false } = {}) {
    const lastError = preserveError ? this.#status.lastError : null;
    const abortController = this.#abortController;
    this.#abortController = null;
    abortController?.abort(new DOMException('DingTalk runtime stopped', 'AbortError'));
    if (this.#connectionMonitor) clearInterval(this.#connectionMonitor);
    this.#connectionMonitor = null;
    this.#status.ready = false;

    const client = this.#client;
    this.#client = null;
    this.#topic = null;
    if (client) {
      try {
        await client.disconnect();
      } catch {
        this.#logger.warn?.('[dsh-dingtalk] DingTalk Stream disconnect failed');
      }
    }
    await Promise.allSettled([...this.#callbackTasks]);
    this.#callbackTasks.clear();
    if (this.#bridge) await this.#bridge.waitForIdle();
    this.#bridge = null;
    this.#status.dingtalkStreamState = preserveError ? 'failed' : 'idle';
    this.#status.lastError = lastError;
    return this.status;
  }

  async sendConnectionTest(text) {
    return sendRememberedConnectionTest({
      state: this.#state,
      text,
      channelLabel: t('钉钉机器人'),
      send: async ({ sessionWebhook }, content) => {
        if (!this.#status.ready || !this.#abortController) {
          throw new Error('DingTalk runtime is not connected');
        }
        await this.#api.sendText({
          clientId: this.#config.clientId,
          clientSecret: this.#clientSecret,
          sessionWebhook,
          text: content,
          signal: this.#abortController.signal,
        });
      },
    });
  }

  async sendProactiveText(target, text, { signal } = {}) {
    const userId = typeof target?.route?.userId === 'string'
      ? target.route.userId.trim() : '';
    const openConversationId = typeof target?.route?.openConversationId === 'string'
      ? target.route.openConversationId.trim() : '';
    if ((target?.kind === 'user' && (!userId || openConversationId))
      || (target?.kind === 'group' && (!openConversationId || userId))
      || (target?.kind !== 'user' && target?.kind !== 'group')) {
      const error = new TypeError('Invalid DingTalk proactive delivery target');
      error.code = 'invalid-target';
      throw error;
    }
    if (!this.#status.ready || !this.#abortController) {
      const error = new Error('DingTalk runtime is not connected');
      error.code = 'bot-not-connected';
      throw error;
    }
    signal?.throwIfAborted();
    try {
      await this.#api.sendRobotText({
        clientId: this.#config.clientId,
        clientSecret: this.#clientSecret,
        target: {
          type: target.kind,
          robotCode: this.#config.clientId,
          ...(target.kind === 'user' ? { userId } : { openConversationId }),
        },
        text,
        signal: signal ?? this.#abortController.signal,
      });
    } catch (cause) {
      if (cause?.code !== 'send-rejected') throw cause;
      const error = new Error('DingTalk rejected the proactive delivery target', { cause });
      error.code = 'target-rejected';
      throw error;
    }
    return { sent: true };
  }

  #pendingSenders() {
    return typeof this.#state.pendingSenders === 'function'
      ? this.#state.pendingSenders()
      : [];
  }
}

export const DingTalkRuntime = DingtalkRuntime;
export const createDingTalkRuntimeStatus = createDingtalkRuntimeStatus;
