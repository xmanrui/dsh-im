import { extractConnectionEvidence, createConnectionDiagnostics, atConnectionStage } from '../shared/connection-error.mjs';
import { QQBot, contentSanitizer, typingIndicator } from '@tencent-connect/qqbot-nodejs';

import {
  connectionTestTarget,
  connectionTestTargetUnavailable,
} from '../shared/connection-test.mjs';
import { t } from '../shared/i18n.mjs';
import { evaluateInboundAccess } from '../shared/inbound-access.mjs';
import { createQqBridgeStatus, QqHarnessBridge } from './qq-bridge.mjs';
import { isQqMessageAddressed, normalizeQqMentions } from './qq-mention.mjs';
import { QqExternalConsumer, qqRefusal, verifiedQqAccount } from './external-consumer.mjs';

function timeoutError() {
  const error = new Error('QQ WebSocket did not become ready in time');
  error.code = 'connect-timeout';
  return error;
}

export function createQqRuntimeStatus() {
  return {
    startedAt: null,
    ready: false,
    qqConnectionState: 'idle',
    harnessReachable: false,
    lastCheckedAt: null,
    lastConnectedAt: null,
    lastError: null,
    ...createQqBridgeStatus(),
  };
}

export class QqRuntime {
  #config;
  #appSecret;
  #harness;
  #state;
  #contextEnhancement;
  #accessPolicy;
  #logger;
  #diagnostics;
  #replyTimeoutMs;
  #connectTimeoutMs;
  #createBot;
  #typingMiddleware;
  #status = createQqRuntimeStatus();
  #bot = null;
  #bridge = null;
  #abortController = null;
  #runTask = null;
  #starting = null;
  #externalConsumer;
  #sourceImages;
  #externalBridge = null;

  constructor({
    config,
    appSecret,
    harness,
    state,
    contextEnhancement,
    accessPolicy,
    logger = console,
    replyTimeoutMs = 600_000,
    connectTimeoutMs = 20_000,
    createBot = (options) => new QQBot(options),
    typingMiddleware = typingIndicator,
    externalConsumer,
    sourceImages = () => false,
  }) {
    if (!config || !appSecret || !harness || !state) {
      throw new TypeError('QqRuntime requires config, app secret, Harness, and state');
    }
    this.#config = config;
    this.#appSecret = appSecret;
    this.#harness = harness;
    this.#state = state;
    this.#contextEnhancement = contextEnhancement;
    this.#accessPolicy = accessPolicy;
    this.#logger = logger; this.#diagnostics = createConnectionDiagnostics({ channel: 'qq', logger });
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#createBot = createBot;
    this.#typingMiddleware = typingMiddleware;
    this.#externalConsumer = externalConsumer;
    this.#sourceImages = sourceImages;
  }

  get status() {
    return structuredClone(this.#status);
  }

  async describeDeliveryAccount(signal) {
    signal?.throwIfAborted();
    if (!this.#status.ready || !this.#bot) throw qqRefusal('bot-not-connected');
    const bot = this.#bot;
    try {
      const user = await bot.api.get('/users/@me');
      signal?.throwIfAborted();
      if (this.#bot !== bot || !this.#status.ready) throw qqRefusal('bot-not-connected');
      const account = verifiedQqAccount(this.#config.appId, user);
      if (this.#status.error?.details?.stage === 'credential.verify') {
        this.#status.error = null;
        this.#status.lastError = null;
      }
      return account;
    } catch (error) {
      if (!signal?.aborted && this.#bot === bot) {
        const qualificationHints = {
          'application-id': t('QQ 应用标识无效。'),
          'native-user-id': t('QQ 账号响应未提供有效的原生用户标识。'),
          'native-bot-flag': t('QQ 账号响应返回了无效或矛盾的机器人标志。'),
        };
        this.#status.error = this.#diagnostics.report(error, { operation: 'connection.status',
          stage: 'credential.verify', botId: this.#config.botId,
          httpStatus: error?.httpStatus, providerCode: error?.bizCode,
          ...(error?.code === 'account-unverified' ? { publicError: {
            code: 'account-unverified', message: t('QQ 账号资格验证失败。'),
            details: { reason: 'invalid-response', hint: qualificationHints[error.verificationFailure] },
          } } : {}),
        }).publicError;
        this.#status.lastError = this.#status.error.message;
      }
      throw error;
    }
  }

  qualifyReplyChecked(route, { signal } = {}) {
    if (!this.#externalBridge) throw qqRefusal('consumer-unavailable');
    return this.#externalBridge.qualify(route, signal);
  }

  replyChecked(route, text, options) {
    if (!this.#externalBridge) throw qqRefusal('consumer-unavailable');
    return this.#externalBridge.reply(route, text, options);
  }

  readSourceImage(route, attachment, options) {
    if (!this.#externalBridge) throw qqRefusal('consumer-unavailable');
    return this.#externalBridge.readImage(route, attachment, options);
  }

  replyImageChecked(route, file, options) {
    if (!this.#externalBridge) throw qqRefusal('consumer-unavailable');
    return this.#externalBridge.replyImage(route, file, options);
  }

  async sendConnectionTest(text) {
    if (!this.#status.ready || !this.#bot) {
      throw connectionTestTargetUnavailable(t('QQ机器人'));
    }
    const ownerUserOpenid = typeof this.#config.ownerUserOpenid === 'string'
      ? this.#config.ownerUserOpenid.trim()
      : '';
    const remembered = connectionTestTarget(this.#state);
    const rememberedUserOpenid = remembered?.scope === 'c2c'
      && typeof remembered.targetId === 'string'
      ? remembered.targetId.trim()
      : '';
    const target = rememberedUserOpenid
      ? { scope: 'c2c', targetId: rememberedUserOpenid }
      : (ownerUserOpenid && ownerUserOpenid !== '*'
        ? { scope: 'c2c', targetId: ownerUserOpenid }
        : null);
    if (!target) throw connectionTestTargetUnavailable(t('QQ机器人'));
    await this.#bot.sendText(target, text);
    return { sent: true };
  }

  async presentSessionSyncApproval(target, interaction, options = {}) {
    if (!this.#status.ready || !this.#bridge) return false;
    const actor = typeof target?.route?.userOpenId === 'string' ? target.route.userOpenId.trim() : '';
    if (!actor) return false;
    return this.#bridge.presentSessionSyncApproval(interaction, {
      key: options.key, actor, validate: options.validate,
      send: (text) => this.sendProactiveText(target, text),
    }, options);
  }

  async sendProactiveText(target, text, { signal } = {}) {
    const nativeId = target?.kind === 'user'
      ? (typeof target?.route?.userOpenId === 'string' ? target.route.userOpenId.trim() : '')
      : target?.kind === 'group'
        ? (typeof target?.route?.groupOpenId === 'string' ? target.route.groupOpenId.trim() : '')
        : '';
    if (!nativeId) {
      const error = new TypeError('Invalid QQ proactive delivery target');
      error.code = 'invalid-target';
      throw error;
    }
    if (!this.#status.ready || !this.#bot) {
      const error = new Error('QQ bot is not connected');
      error.code = 'bot-not-connected';
      throw error;
    }
    signal?.throwIfAborted();
    return this.#bot.sendText({
      scope: target.kind === 'user' ? 'c2c' : 'group',
      targetId: nativeId,
    }, text);
  }

  async start() {
    if (this.#status.ready && this.#bot) return this.status;
    if (this.#starting) return this.#starting;
    this.#starting = this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #start() {
    await this.stop();
    this.#status.startedAt = new Date().toISOString();
    this.#status.qqConnectionState = 'connecting';
    this.#status.lastError = null; this.#status.error = null; this.#diagnostics.clear();
    if (this.#config.consumerMode !== 'external-consumer')
      await atConnectionStage('harness.check', () => this.#harness.ensureRunning());
    this.#status.harnessReachable = true;

    const controller = new AbortController();
    this.#abortController = controller;
    const observeTransport = (message) => {
      if (controller.signal.aborted || this.#abortController !== controller || typeof message !== 'string') return;
      // SDK 1.0.4 exposes close through its public Logger, not a disconnect event.
      if (message.startsWith(`[${this.#config.botId}] WebSocket closed:`)
        || message.startsWith(`[${this.#config.botId}] Connection failed:`)
        || message.startsWith(`[${this.#config.botId}] Connecting to `)) {
        this.#status.ready = false;
        this.#status.qqConnectionState = 'connecting';
      } else if (message === `[${this.#config.botId}] Max reconnect attempts reached or aborted`) {
        this.#status.ready = false;
        this.#status.qqConnectionState = 'failed';
      } else return false;
      this.#logger.info?.(`[dsh-im:qq] ${JSON.stringify({ event: 'receiver-state',
        botId: this.#config.botId, phase: this.#status.qqConnectionState })}`);
      return true;
    };
    const sdkLogger = {
      error: (...args) => { if (!observeTransport(args[0])) this.#logger.error?.(...args); },
      warn: (...args) => this.#logger.warn?.(...args),
      info: (...args) => { if (!observeTransport(args[0])) this.#logger.info?.(...args); },
      debug: () => {},
    };
    const bot = this.#createBot({
      appId: this.#config.appId,
      appSecret: this.#appSecret,
      accountId: this.#config.botId,
      logger: sdkLogger,
      transport: 'websocket',
      tokenPrefetch: 'sync',
      // sendText is reserved for literal notices/connection tests. Markdown
      // replies use the explicit msg_type=2 path in sendMarkdownReply().
      markdownSupport: false,
    });
    if (!bot || typeof bot.start !== 'function' || typeof bot.stop !== 'function') {
      throw new TypeError('QQ bot factory returned an invalid client');
    }
    this.#bot = bot;
    if (this.#config.consumerMode === 'external-consumer' && this.#externalConsumer) {
      try {
        const account = verifiedQqAccount(this.#config.appId, await bot.api.get('/users/@me'));
        controller.signal.throwIfAborted();
        this.#externalBridge = new QqExternalConsumer({ bot, account, botId: this.#config.botId,
          accept: this.#externalConsumer,
          sourceImages: this.#sourceImages,
          reportNativeObservation: record => this.#logger.info?.('[dsh-im:qq] native reply observation', record),
        });
      } catch (error) {
        await this.stop();
        throw error;
      }
    }
    this.#bridge = this.#config.consumerMode === 'external-consumer' ? null : new QqHarnessBridge({
      bot,
      ownerUserOpenid: this.#config.ownerUserOpenid,
      harness: this.#harness,
      state: this.#state,
      contextEnhancement: this.#contextEnhancement,
      accessPolicy: this.#accessPolicy,
      status: this.#status,
      logger: this.#logger,
      replyTimeoutMs: this.#replyTimeoutMs,
      signal: controller.signal,
    });
    const botMentionIds = new Set([this.#config.appId]);
    bot.use(async (ctx, next) => {
      ctx.message = normalizeQqMentions(ctx.message, botMentionIds);
      await next();
    });
    // QQ delivers emoji/face messages as opaque `<faceType=..,faceId="..",ext="..">`
    // tags. Parse them into readable text so the Harness sees what the sender
    // actually meant instead of an unusable markup fragment.
    bot.use(contentSanitizer({ parseFaceTags: true }));
    if (this.#config.consumerMode !== 'external-consumer') bot.use?.(this.#typingMiddleware({
      keepAlive: true,
      predicate: (ctx) => {
        const message = ctx?.message;
        if (!isQqMessageAddressed(message)) return false;
        if (!this.#accessPolicy) {
          return message.kind === 'group'
            || this.#config.ownerUserOpenid === '*'
            || message.senderId === this.#config.ownerUserOpenid;
        }
        return evaluateInboundAccess(this.#accessPolicy, {
          conversationType: message.kind === 'c2c' ? 'direct' : 'group',
          senderIds: message.senderId,
          text: typeof message.content === 'string' ? message.content.trim() : '',
        }).allowed;
      },
    }));

    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const onReady = (data) => {
      if (controller.signal.aborted || this.#bot !== bot) return;
      if (typeof data?.user?.id === 'string' && data.user.id.trim()) {
        botMentionIds.add(data.user.id.trim());
      }
      const now = Date.now();
      this.#status.ready = true;
      this.#status.qqConnectionState = 'connected';
      this.#status.lastCheckedAt = now;
      this.#status.lastConnectedAt = now;
      this.#status.lastError = null; this.#status.error = null; this.#diagnostics.clear();
      readyResolve();
    };
    const onError = (error) => {
      if (controller.signal.aborted || this.#bot !== bot) return;
      if (!this.#status.ready) readyReject(error);
      else {
        this.#status.error = this.#diagnostics.report(error, { operation: 'connection.monitor', botId: this.#config?.botId, automatic: true }).publicError;
        this.#status.lastError = this.#status.error.message;
        this.#logger.warn?.(`[dsh-im:qq] bot ${this.#config.botId} connection error:`, extractConnectionEvidence(error).details);
      }
      this.#status.ready = false;
      this.#status.qqConnectionState = 'connecting';
    };
    const onMessage = async (_ctx, message) => {
      if (controller.signal.aborted || this.#bot !== bot) return;
      const task = this.#config.consumerMode === 'external-consumer'
        ? this.#externalBridge?.accept(message, controller.signal)
        : this.#bridge?.accept(message);
      if (!task) return;
      return task.catch((error) => {
        if (controller.signal.aborted) return;
        this.#logger.error?.(
          `[dsh-im:qq] bot ${this.#config.botId} message handling failed:`,
          extractConnectionEvidence(error).details,
        );
      });
    };
    bot.on('ready', onReady);
    bot.on('resumed', onReady);
    bot.on('error', onError);
    bot.on('message', onMessage);

    const runTask = Promise.resolve().then(() => bot.start(controller.signal));
    this.#runTask = runTask;
    runTask.catch((error) => {
      if (controller.signal.aborted) return;
      readyReject(error);
      this.#status.ready = false;
      this.#status.qqConnectionState = 'failed';
      this.#status.error = this.#diagnostics.report(error, { operation: 'connection.monitor', botId: this.#config?.botId, automatic: true }).publicError;
      this.#status.lastError = this.#status.error.message;
      this.#logger.error?.(`[dsh-im:qq] bot ${this.#config.botId} connection stopped:`, extractConnectionEvidence(error).details);
    });

    let timer;
    try {
      await Promise.race([
        ready,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(timeoutError()), this.#connectTimeoutMs);
        }),
      ]);
      this.#status.ready = true;
      this.#status.qqConnectionState = 'connected';
      this.#status.lastCheckedAt = Date.now();
      this.#status.lastConnectedAt = Date.now();
      return this.status;
    } catch (error) {
      this.#status.ready = false;
      this.#status.qqConnectionState = 'failed';
      this.#status.error = this.#diagnostics.report(error, { operation: 'connection.monitor', botId: this.#config?.botId, automatic: true }).publicError;
      this.#status.lastError = this.#status.error.message;
      await this.stop();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async stop() {
    const bot = this.#bot;
    const bridge = this.#bridge;
    const runTask = this.#runTask;
    this.#abortController?.abort();
    this.#abortController = null;
    this.#bot = null;
    this.#bridge = null;
    this.#externalBridge = null;
    this.#runTask = null;
    try {
      bot?.stop();
    } catch (error) {
      this.#logger.warn?.(`[dsh-im:qq] bot ${this.#config.botId} failed to stop cleanly:`, extractConnectionEvidence(error).details);
    }
    await Promise.race([
      runTask?.catch(() => undefined) ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await bridge?.waitForIdle();
    this.#status.ready = false;
    this.#status.qqConnectionState = 'idle';
    return this.status;
  }
}
