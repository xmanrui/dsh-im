import { createEditableMessageStream, splitMessageText } from '../shared/editable-message-stream.mjs';
import { t } from '../shared/i18n.mjs';
import {
  isMatrixEventId,
  isMatrixRoomId,
  MatrixApi,
  MatrixApiError,
  performMatrixPasswordLogin,
  validateMatrixHomeserver,
} from './matrix-api.mjs';
import {
  createMatrixBridgeStatus,
  MATRIX_DESCRIPTOR,
  MatrixHarnessBridge,
} from './matrix-bridge.mjs';
import { MatrixCryptoEngine } from './matrix-crypto.mjs';
import {
  ClockSkewGuard,
  compileIgnorePatterns,
  EventDedupeRing,
  normalizeMatrixDeliveryTarget,
  normalizeMatrixTimelineEvent,
  resolveBangMatrixCommand,
} from './matrix-normalize.mjs';
import {
  applyMatrixRelations,
  buildMatrixEditContent,
  buildMatrixReactionContent,
  buildMatrixTextContent,
  extractOutboundMentions,
  hasRoomMention,
} from './matrix-rich-text.mjs';

const RECONNECT_DELAYS_MS = Object.freeze([1_000, 3_000, 5_000, 10_000, 30_000]);
const SYNC_LONG_POLL_MS = 30_000;
const SYNC_RETRY_DELAY_MS = 5_000;
const INVITE_JOIN_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_MESSAGE_LENGTH = 16_000;
const DEFAULT_MAX_MEDIA_BYTES = 104_857_600;
const EDIT_STREAM_INTERVAL_MS = 350;
const DEAD_ROOM_MARKERS = Object.freeze(['no servers', 'room not found']);
const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toRoomSet(values) {
  const list = Array.isArray(values) ? values : (values instanceof Set ? [...values] : []);
  return new Set(list.filter((value) => isMatrixRoomId(value)));
}

function toTextSet(values) {
  const list = Array.isArray(values) ? values : (values instanceof Set ? [...values] : []);
  return new Set(list.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()));
}

function safeErrorInfo(error) {
  if (!error) return null;
  return Object.freeze({
    at: new Date().toISOString(),
    code: error instanceof MatrixApiError ? error.code : (error?.code ?? 'error'),
    message: String(error?.message ?? error).slice(0, 400).replaceAll(/mxc:\/\/[^\s]+/g, 'mxc://…'),
  });
}

function summarizeCryptoStats(stats) {
  if (!stats || typeof stats !== 'object') return null;
  return Object.freeze({
    inboundSessions: Number(stats.inboundSessions) || 0,
    outboundRooms: Number(stats.outboundRooms) || 0,
    pendingEvents: Number(stats.pendingEvents) || 0,
    undecryptable: Number(stats.undecryptable) || 0,
    keyUploads: Number(stats.keyUploads) || 0,
    roomKeySends: Number(stats.roomKeySends) || 0,
    shareFailures: Number(stats.shareFailures) || 0,
  });
}

function resolveE2eeMode(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'false' || raw === 'no') return 'off';
  if (raw === 'required' || raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return 'required';
  return 'optional';
}

function inviterAllowed(accessPolicy, inviter) {
  if (!inviter) return false;
  const settings = typeof accessPolicy?.getSettings === 'function' ? accessPolicy.getSettings() : null;
  const candidate = inviter.trim().toLowerCase();
  for (const scope of [settings?.direct, settings?.group]) {
    if (!scope) continue;
    if (scope.mode === 'open') return true;
    const users = Array.isArray(scope.allowlist?.users) ? scope.allowlist.users : [];
    if (users.some((entry) => String(entry?.id ?? '').trim().toLowerCase() === candidate)) return true;
  }
  return false;
}

function inviteSenderOf(inviteRoom) {
  const events = Array.isArray(inviteRoom?.invite_state?.events) ? inviteRoom.invite_state.events : [];
  for (const event of events) {
    if (event?.type === 'm.room.member' && event?.content?.membership === 'invite'
      && typeof event.sender === 'string') return event.sender;
  }
  return null;
}

function timelineEventsOf(joinRoom) {
  const events = Array.isArray(joinRoom?.timeline?.events) ? joinRoom.timeline.events : [];
  return events.filter((event) => event && typeof event === 'object' && event.state_key === undefined);
}

function initialStateEventsOf(joinRoom) {
  const events = Array.isArray(joinRoom?.state?.events) ? joinRoom.state.events : [];
  return events.filter((event) => event && typeof event === 'object');
}

export function createMatrixRuntimeStatus() {
  return Object.assign(createMatrixBridgeStatus(), {
    startedAt: null,
    ready: false,
    connectionState: 'idle',
    harnessReachable: false,
    lastCheckedAt: null,
    lastConnectedAt: null,
    lastError: null,
    joinedRooms: 0,
    e2eeMode: 'optional',
    e2eeActive: false,
    lastCryptoError: null,
    cryptoStats: null,
    encryptedRoomsSeen: 0,
    lastClockSkewAt: null,
  });
}

export class MatrixRuntime {
  #config;
  #auth;
  #harness;
  #state;
  #sidecar;
  #contextEnhancement;
  #accessPolicy;
  #status;
  #logger;
  #createApi;
  #isKnownCommand;
  #replyTimeoutMs;
  #api = null;
  #bridge = null;
  #botUserId = null;
  #deviceId = null;
  #crypto = null;
  #cryptoStore;
  #createCrypto;
  #generation = 0;
  #started = false;
  #stopped = true;
  #syncTask = null;
  #reconnectTimer = null;
  #reconnectIndex = 0;
  #inviteTasks = new Map();
  #clock = new ClockSkewGuard({});
  #ring = new EventDedupeRing(1_000);
  #patterns = [];
  #dmRooms = new Set();
  #joinedRooms = new Set();
  #encryptedRooms = new Set();
  #notifiedEncryptedRooms = new Set();
  #e2eeActive = false;

  constructor({
    config = {},
    accessToken,
    password,
    harness,
    state,
    sidecar,
    contextEnhancement,
    accessPolicy,
    status = createMatrixRuntimeStatus(),
    logger = console,
    replyTimeoutMs = 600_000,
    createApi = (options) => new MatrixApi(options),
    cryptoStore = null,
    createCrypto = null,
    isKnownCommand,
  } = {}) {
    const homeserver = validateMatrixHomeserver(config.homeserver);
    if (!homeserver) throw new TypeError('Matrix runtime requires a valid homeserver');
    const token = cleanString(accessToken);
    const secret = cleanString(password);
    const userId = cleanString(config.userId);
    if (!token && !(secret && userId)) {
      throw new TypeError('Matrix runtime requires an access token or a user id with password');
    }
    this.#config = Object.freeze({
      ...config,
      homeserver,
      maxMessageLength: Number.isSafeInteger(config.maxMessageLength)
        ? Math.min(Math.max(config.maxMessageLength, 500), 65_535)
        : DEFAULT_MAX_MESSAGE_LENGTH,
      maxMediaBytes: Number.isSafeInteger(config.maxMediaBytes) && config.maxMediaBytes > 0
        ? Math.min(config.maxMediaBytes, 104_857_600)
        : DEFAULT_MAX_MEDIA_BYTES,
      requireMention: config.requireMention !== false,
      processNotices: config.processNotices === true,
      allowRoomMentions: config.allowRoomMentions === true,
      reactions: config.reactions !== false,
      autoJoinInvites: config.autoJoinInvites === 'all' ? 'all' : 'authorized',
      e2eeMode: resolveE2eeMode(config.e2eeMode),
    });
    this.#auth = Object.freeze(token ? { accessToken: token } : { password: secret, userId });
    this.#harness = harness;
    this.#state = state;
    this.#sidecar = sidecar;
    this.#contextEnhancement = contextEnhancement;
    this.#accessPolicy = accessPolicy;
    this.#status = status;
    this.#status.e2eeMode = this.#config.e2eeMode;
    this.#logger = logger;
    this.#createApi = createApi;
    if (cryptoStore != null
      && (typeof cryptoStore.load !== 'function'
        || typeof cryptoStore.bootstrap !== 'function'
        || typeof cryptoStore.apply !== 'function')) {
      throw new TypeError('Matrix crypto store is missing the load/bootstrap/apply contract');
    }
    this.#cryptoStore = cryptoStore ?? null;
    this.#createCrypto = typeof createCrypto === 'function'
      ? createCrypto
      : (options) => new MatrixCryptoEngine(options);
    this.#isKnownCommand = typeof isKnownCommand === 'function' ? isKnownCommand : () => false;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#patterns = compileIgnorePatterns(config.ignoreUserPatterns);
    for (const roomId of toRoomSet(config.freeResponseRooms)) this.#freeRooms.add(roomId);
    this.#allowedRooms = toRoomSet(config.allowedRooms);
  }

  #freeRooms = new Set();
  #allowedRooms = new Set();

  get status() {
    return this.#status;
  }

  async start() {
    if (this.#started && this.#status.ready) return;
    this.#stopped = false;
    this.#started = true;
    const generation = ++this.#generation;
    const homeserver = this.#config.homeserver;
    let accessToken = this.#auth.accessToken ?? null;
    let resolvedUserId = 'userId' in this.#auth ? this.#auth.userId : cleanString(this.#config.userId);
    let resolvedDeviceId = cleanString(this.#config.deviceId);
    if (!accessToken) {
      const session = await performMatrixPasswordLogin({
        homeserver,
        userId: resolvedUserId,
        password: this.#auth.password,
        ...(resolvedDeviceId ? { deviceId: resolvedDeviceId } : {}),
      });
      accessToken = session.accessToken;
      resolvedUserId = session.userId;
      if (session.deviceId && resolvedDeviceId && session.deviceId !== resolvedDeviceId) {
        this.#logger.warn?.(t('Matrix 配置的 device_id 与服务端实际设备不一致，以服务端设备为准。'));
      }
      resolvedDeviceId = session.deviceId ?? resolvedDeviceId;
    }
    const api = this.#createApi({ homeserver, accessToken, userId: resolvedUserId });
    const identity = await api.whoami();
    const verifiedUserId = cleanString(identity?.user_id) ?? resolvedUserId;
    const verifiedDeviceId = cleanString(identity?.device_id);
    if (!verifiedUserId) throw new Error('Matrix whoami returned no user id');
    if (resolvedUserId && verifiedUserId.toLowerCase() !== resolvedUserId.toLowerCase()) {
      this.#logger.warn?.(
        t('Matrix whoami 返回的用户 {verified} 与配置的用户 {configured} 不一致，以 whoami 结果为准。'),
        { verified: verifiedUserId, configured: resolvedUserId },
      );
    }
    if (verifiedDeviceId && resolvedDeviceId && verifiedDeviceId !== resolvedDeviceId) {
      this.#logger.warn?.(
        t('Matrix 配置的 device_id {configured} 与令牌绑定设备 {verified} 不一致，令牌仅能为其设备共享密钥，以令牌设备为准。'),
        { configured: resolvedDeviceId, verified: verifiedDeviceId },
      );
    }
    this.#api = api;
    this.#botUserId = verifiedUserId;
    this.#deviceId = verifiedDeviceId ?? resolvedDeviceId;
    await this.#startCrypto(api, verifiedUserId, this.#deviceId);
    if (generation !== this.#generation) return;
    this.#clock = new ClockSkewGuard({});
    this.#ring.seed(this.#state.snapshot?.()?.seenMessageIds ?? []);
    this.#bridge = new MatrixHarnessBridge({
      descriptor: { ...MATRIX_DESCRIPTOR, reactions: this.#config.reactions ? MATRIX_DESCRIPTOR.reactions : {} },
      bot: this.#createBotClient(),
      harness: this.#harness,
      state: this.#state,
      contextEnhancement: this.#contextEnhancement,
      accessPolicy: this.#accessPolicy,
      status: this.#status,
      logger: this.#logger,
      replyTimeoutMs: this.#replyTimeoutMs,
    });
    await this.#initialSync();
    if (generation !== this.#generation) return;
    this.#status.ready = true;
    this.#status.connectionState = 'connected';
    this.#status.harnessReachable = true;
    this.#status.lastConnectedAt = new Date().toISOString();
    this.#status.lastCheckedAt = this.#status.lastConnectedAt;
    this.#status.lastError = null;
    this.#status.startedAt ??= this.#status.lastConnectedAt;
    this.#status.e2eeActive = this.#e2eeActive;
    this.#reconnectIndex = 0;
    this.#syncTask = Promise.resolve().then(() => this.#syncLoop(generation));
  }

  async stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#started = false;
    this.#generation += 1;
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    for (const task of this.#inviteTasks.values()) task.abort?.();
    this.#inviteTasks.clear();
    const bridge = this.#bridge;
    this.#bridge = null;
    const crypto = this.#crypto;
    this.#crypto = null;
    this.#e2eeActive = false;
    this.#status.e2eeActive = false;
    this.#api = null;
    await Promise.race([
      bridge?.waitForIdle() ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 2_000).unref?.()),
    ]);
    await crypto?.stop?.().catch(() => undefined);
    this.#status.ready = false;
    this.#status.connectionState = 'idle';
  }

  async sendConnectionTest(text) {
    const bridge = this.#bridge;
    if (!bridge) throw new Error('Matrix bot is not connected');
    return await bridge.sendConnectionTest(text);
  }

  async sendProactiveText(target, text, options = {}) {
    const api = this.#api;
    if (!api) throw new Error('Matrix bot is not connected');
    const normalized = normalizeMatrixDeliveryTarget(target ?? {});
    if (normalized.error) {
      const error = new Error(`Matrix delivery target is invalid: ${normalized.error}`);
      error.code = 'invalid-target';
      throw error;
    }
    const route = normalized.value;
    if (route.kind === 'dm') {
      const roomId = await this.#resolveDmRoom(route.userId, options);
      await this.#sendRoomText({ roomId, threadId: null }, text, options);
      return { sent: true };
    }
    await this.#sendRoomText({ roomId: route.roomId, threadId: route.threadId ?? null }, text, options);
    return { sent: true };
  }

  // ---- 端到端加密 ----

  async #startCrypto(api, userId, deviceId) {
    this.#crypto = null;
    this.#e2eeActive = false;
    this.#status.cryptoStats = null;
    this.#status.lastCryptoError = null;
    if (this.#config.e2eeMode === 'off') return;
    if (!this.#cryptoStore) {
      this.#status.lastCryptoError = safeErrorInfo(new Error('matrix crypto store is not configured'));
      if (this.#config.e2eeMode === 'required') {
        throw new Error(t('端到端加密模式为 required，但未配置加密状态存储，已拒绝建立加密连接。'));
      }
      this.#logger.warn?.(t('Matrix 端到端加密未配置状态存储，加密房间消息将明确降级跳过。'));
      return;
    }
    let engine = null;
    try {
      await this.#cryptoStore.load();
      engine = this.#createCrypto({
        api,
        store: this.#cryptoStore,
        userId,
        deviceId,
        logger: this.#logger,
      });
      engine.setPendingMessageHandler((roomId, event) => this.#handleTimelineEvent(roomId, event));
      await engine.start();
      this.#crypto = engine;
      this.#e2eeActive = true;
      this.#status.cryptoStats = summarizeCryptoStats(engine.getStats());
      this.#logger.info?.(t('Matrix 端到端加密引擎已就绪，设备密钥与一次性密钥已注册。'));
    } catch (error) {
      this.#e2eeActive = false;
      this.#crypto = null;
      this.#status.cryptoStats = null;
      this.#status.lastCryptoError = safeErrorInfo(error);
      await engine?.stop?.().catch(() => undefined);
      if (this.#config.e2eeMode === 'required') {
        const reason = String(error?.message ?? error).replaceAll(/mxc:\/\/[^\s]+/g, 'mxc://…').slice(0, 300);
        throw new Error(t('端到端加密模式为 required，但加密引擎启动失败，已拒绝建立加密连接：{reason}', { reason }));
      }
      this.#logger.warn?.(t('Matrix 端到端加密引擎启动失败，加密房间消息将明确降级跳过。'), error?.message ?? error);
    }
  }

  async #dispatchToDeviceEvents(events) {
    if (!this.#crypto || !Array.isArray(events)) return;
    await this.#crypto.handleToDeviceEvents(events).catch(() => undefined);
  }

  // ---- 连接与 sync 循环 ----

  async #initialSync() {
    const api = this.#api;
    const initial = await api.sync({ timeout: 0 });
    const rooms = initial?.rooms ?? {};
    for (const roomId of Object.keys(rooms.join ?? {})) {
      if (!isMatrixRoomId(roomId)) continue;
      this.#joinedRooms.add(roomId);
      for (const event of initialStateEventsOf(rooms.join?.[roomId])) {
        if (event?.type === 'm.room.encryption') this.#encryptedRooms.add(roomId);
      }
    }
    const direct = await api.getAccountData('m.direct').catch(() => null);
    for (const list of Object.values(direct ?? {})) {
      if (!Array.isArray(list)) continue;
      for (const roomId of list) if (isMatrixRoomId(roomId)) this.#dmRooms.add(roomId);
    }
    for (const roomId of this.#sidecar.dmRooms()) this.#dmRooms.add(roomId);
    for (const roomId of this.#sidecar.joinedRooms()) this.#joinedRooms.add(roomId);
    await this.#classifyUnknownRooms();
    for (const roomId of Object.keys(rooms.invite ?? {})) {
      const inviter = inviteSenderOf(rooms.invite?.[roomId]);
      this.#scheduleInviteJoin(roomId, inviter);
    }
    // Queued to-device room keys land before the offline timeline replay so queued ciphertext can decrypt on first sight.
    await this.#dispatchToDeviceEvents(initial?.to_device?.events);
    for (const [roomId, room] of Object.entries(rooms.join ?? {})) {
      for (const event of timelineEventsOf(room)) await this.#handleTimelineEvent(roomId, event);
    }
    if (typeof initial?.next_batch === 'string' && initial.next_batch) {
      this.#lastBatch = initial.next_batch;
      await this.#sidecar.apply({
        nextBatch: initial.next_batch,
        joinedRooms: [...this.#joinedRooms],
        dmRooms: [...this.#dmRooms],
      });
    }
    this.#status.joinedRooms = this.#joinedRooms.size;
    this.#status.encryptedRoomsSeen = this.#encryptedRooms.size;
  }

  async #classifyUnknownRooms() {
    for (const roomId of this.#joinedRooms) {
      if (this.#dmRooms.has(roomId)) continue;
      const count = await this.#api.getJoinedMemberCount(roomId).catch(() => null);
      if (count !== null && count <= 2) this.#dmRooms.add(roomId);
    }
  }

  async #syncLoop(generation) {
    while (!this.#stopped && generation === this.#generation && this.#api) {
      try {
        const data = await this.#api.sync({
          since: this.#lastBatch ?? undefined,
          timeout: SYNC_LONG_POLL_MS,
        });
        if (generation !== this.#generation || this.#stopped) return;
        await this.#handleSyncData(data);
        if (this.#crypto) {
          await this.#crypto.maintain?.().catch(() => undefined);
          this.#status.cryptoStats = summarizeCryptoStats(this.#crypto.getStats());
        }
        this.#status.lastCheckedAt = new Date().toISOString();
        this.#reconnectIndex = 0;
      } catch (error) {
        if (generation !== this.#generation || this.#stopped) return;
        const permanent = error instanceof MatrixApiError
          ? error.permanent
          : /m_unknown_token|unauthorized|forbidden/i.test(String(error?.message ?? ''));
        if (permanent) {
          this.#status.connectionState = 'failed';
          this.#status.harnessReachable = false;
          this.#status.lastError = safeErrorInfo(error);
          this.#logger.warn?.('[dsh-im:matrix] sync loop stopped on a permanent auth error; reconnecting', error);
          this.#scheduleReconnect(generation);
          return;
        }
        this.#logger.warn?.('[dsh-im:matrix] sync loop error; retrying', error);
        await new Promise((resolve) => setTimeout(resolve, SYNC_RETRY_DELAY_MS).unref?.());
      }
    }
  }

  #scheduleReconnect(generation) {
    if (this.#stopped || generation !== this.#generation || this.#reconnectTimer !== null) return;
    const delayMs = RECONNECT_DELAYS_MS[Math.min(this.#reconnectIndex, RECONNECT_DELAYS_MS.length - 1)];
    this.#reconnectIndex += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#stopped || generation !== this.#generation) return;
      this.#status.connectionState = 'connecting';
      void this.start().catch((error) => {
        this.#logger.warn?.('[dsh-im:matrix] reconnect attempt failed; the supervisor will retry', error);
      });
    }, delayMs);
    this.#reconnectTimer.unref?.();
  }

  async #handleSyncData(data) {
    const rooms = data?.rooms ?? {};
    await this.#dispatchToDeviceEvents(data?.to_device?.events);
    let joinedChanged = false;
    for (const [roomId, room] of Object.entries(rooms.join ?? {})) {
      if (!isMatrixRoomId(roomId)) continue;
      if (!this.#joinedRooms.has(roomId)) {
        this.#joinedRooms.add(roomId);
        joinedChanged = true;
      }
      for (const event of initialStateEventsOf(room)) {
        if (event?.type === 'm.room.encryption') this.#encryptedRooms.add(roomId);
        // A membership change invalidates the shared-device set so the next send re-shares the room key.
        else if (event?.type === 'm.room.member' && event?.state_key && this.#crypto) this.#crypto.invalidateRoomSharing(roomId);
      }
      for (const event of timelineEventsOf(room)) await this.#handleTimelineEvent(roomId, event);
    }
    for (const [roomId, room] of Object.entries(rooms.invite ?? {})) {
      if (!isMatrixRoomId(roomId)) continue;
      this.#scheduleInviteJoin(roomId, inviteSenderOf(room));
    }
    if (typeof data?.next_batch === 'string' && data.next_batch) {
      this.#lastBatch = data.next_batch;
      await this.#sidecar.apply({
        nextBatch: data.next_batch,
        ...(joinedChanged ? { joinedRooms: [...this.#joinedRooms] } : {}),
      });
      this.#status.joinedRooms = this.#joinedRooms.size;
      this.#status.encryptedRoomsSeen = this.#encryptedRooms.size;
    }
  }

  async #handleTimelineEvent(roomId, event) {
    if (event?.type === 'm.room.encrypted') {
      this.#noteEncryptedRoom(roomId);
      if (!this.#crypto) return;
      if (typeof event?.event_id !== 'string' || !event.event_id) return;
      const decrypted = await this.#crypto.decryptRoomEvent(roomId, event).catch(() => null);
      if (!decrypted || typeof decrypted.content !== 'object' || decrypted.content === null) return;
      event = { ...event, type: 'm.room.message', content: decrypted.content };
    }
    if (event?.type !== 'm.room.message' && event?.type !== 'm.room.encryption') return;
    if (event?.type === 'm.room.encryption') {
      this.#encryptedRooms.add(roomId);
      return;
    }
    const content = event?.content;
    if (content?.['m.relates_to']?.rel_type === 'm.replace') return;
    const isDirect = this.#dmRooms.has(roomId);
    const outcome = normalizeMatrixTimelineEvent({
      event,
      roomId,
      botUserId: this.#botUserId,
      isDirect,
      config: {
        requireMention: this.#config.requireMention,
        processNotices: this.#config.processNotices,
        freeResponseRooms: this.#freeRooms,
        allowedRooms: this.#allowedRooms.size > 0 ? this.#allowedRooms : null,
      },
      patterns: this.#patterns,
      ring: this.#ring,
      clock: this.#clock,
      deps: { createMediaSource: (mediaContent, msgtype) => this.#createMediaSource(mediaContent, msgtype) },
    });
    if (outcome.drop) {
      if (outcome.warnSkew && !this.#status.lastClockSkewAt) {
        this.#status.lastClockSkewAt = new Date().toISOString();
        this.#logger.warn?.(t('Matrix 收到的时间戳持续远落后于本机时间，检测到本机时钟超前，请校准系统时间后重启机器人。'));
      }
      return;
    }
    const message = { ...outcome.message };
    if (message.addressed && typeof message.content === 'string' && message.content.startsWith('!')) {
      const resolved = resolveBangMatrixCommand(message.content, (name) => this.#isKnownCommand(name));
      if (resolved !== message.content) {
        message.content = resolved;
        message.addressed = true;
      }
    }
    void Promise.resolve(this.#bridge?.accept(message)).catch((error) => {
      this.#logger.warn?.('[dsh-im:matrix] inbound message handling failed:', error?.message ?? error);
    });
    if (message.addressed) {
      void this.#api?.setTyping(message.roomId, { typing: true, timeoutMs: 20_000 }).catch(() => undefined);
    }
  }

  #noteEncryptedRoom(roomId) {
    this.#encryptedRooms.add(roomId);
    this.#status.encryptedRoomsSeen = this.#encryptedRooms.size;
    if (this.#e2eeActive || this.#config.e2eeMode === 'off') return;
    if (this.#notifiedEncryptedRooms.has(roomId)) return;
    this.#notifiedEncryptedRooms.add(roomId);
    this.#logger.warn?.(
      `[dsh-im:matrix] ${roomId} ${t('端到端加密未启用或不可用，加密房间 {room} 的密文会被明确降级跳过。', { room: roomId })}`,
    );
  }

  // ---- 邀请 join ----

  #scheduleInviteJoin(roomId, inviter) {
    if (this.#stopped || !isMatrixRoomId(roomId) || this.#joinedRooms.has(roomId)) return;
    if (this.#sidecar.isDeclined(roomId)) return;
    const allowed = this.#config.autoJoinInvites === 'all' || inviterAllowed(this.#accessPolicy, inviter);
    if (!allowed) {
      this.#logger.warn?.(
        t('Matrix 拒绝了来自未授权用户 {inviter} 的入房邀请 {room}。'),
        { inviter: inviter ?? '?', room: roomId },
      );
      return;
    }
    if (this.#inviteTasks.has(roomId)) return;
    const controller = new AbortController();
    this.#inviteTasks.set(roomId, controller);
    void this.#joinInvitedRoom(roomId, inviter, controller).finally(() => {
      this.#inviteTasks.delete(roomId);
    });
  }

  async #joinInvitedRoom(roomId, inviter, controller) {
    const timeout = AbortSignal.timeout(INVITE_JOIN_TIMEOUT_MS);
    const signal = AbortSignal.any([controller.signal, timeout]);
    try {
      await this.#api.joinRoom(roomId, { signal });
      this.#joinedRooms.add(roomId);
      this.#status.joinedRooms = this.#joinedRooms.size;
      await this.#sidecar.apply({ joinedRooms: [...this.#joinedRooms] });
      if (inviter) await this.#recordDmRoom(roomId, inviter);
      this.#logger.info?.(t('Matrix 已按授权邀请加入房间 {room}。'), { room: roomId });
    } catch (error) {
      const text = String(error?.message ?? '').toLowerCase();
      if (DEAD_ROOM_MARKERS.some((marker) => text.includes(marker))) {
        try {
          await this.#api.leaveRoom(roomId, { signal: AbortSignal.timeout(10_000) });
          await this.#sidecar.apply({ declinedRooms: [...this.#sidecar.declinedRooms(), roomId] });
          this.#logger.info?.(t('Matrix 已婉拒失效房间的遗留邀请 {room}。'), { room: roomId });
        } catch {
          // A dead-room decline is best effort; a later sync reconciles again.
        }
        return;
      }
      this.#logger.warn?.('[dsh-im:matrix] invite join failed; sync will reconcile again:', error?.message ?? error);
    }
  }

  async #recordDmRoom(roomId, inviter) {
    const direct = await this.#api.getAccountData('m.direct').catch(() => null);
    const map = { ...(direct && typeof direct === 'object' && !Array.isArray(direct) ? direct : {}) };
    const list = Array.isArray(map[inviter]) ? [...map[inviter]] : [];
    if (!list.includes(roomId)) list.push(roomId);
    map[inviter] = list;
    await this.#api.setAccountData('m.direct', map).catch(() => undefined);
    this.#dmRooms.add(roomId);
    const dmRoomByUser = { ...this.#sidecar.dmRoomByUser(), [inviter.trim().toLowerCase()]: roomId };
    await this.#sidecar.apply({ dmRooms: [...this.#dmRooms], dmRoomByUser });
  }

  async #resolveDmRoom(userId, options = {}) {
    const key = userId.trim().toLowerCase();
    const known = this.#sidecar.dmRoomByUser()[key];
    if (known && isMatrixRoomId(known)) return known;
    const created = await this.#api.createRoom({
      preset: 'private_chat',
      is_direct: true,
      invite: [userId],
    }, options).catch(() => null);
    const roomId = cleanString(created?.room_id ?? created?.room_Id);
    if (!roomId || !isMatrixRoomId(roomId)) {
      const error = new Error(t('Matrix 无法为该用户创建私聊房间。'));
      error.code = 'dm-room-unavailable';
      throw error;
    }
    this.#dmRooms.add(roomId);
    this.#joinedRooms.add(roomId);
    await this.#sidecar.apply({
      dmRooms: [...this.#dmRooms],
      joinedRooms: [...this.#joinedRooms],
      dmRoomByUser: { ...this.#sidecar.dmRoomByUser(), [key]: roomId },
    });
    return roomId;
  }

  // ---- 出站 ----

  async #sendRoomEvent(roomId, eventType, content, options = {}) {
    const api = this.#api;
    if (!api) throw new Error('Matrix bot is not connected');
    if (this.#crypto && this.#encryptedRooms.has(roomId)) {
      const encrypted = await this.#crypto.encryptForRoom(roomId, content);
      return await api.sendEvent(roomId, 'm.room.encrypted', encrypted, options);
    }
    return await api.sendEvent(roomId, eventType, content, options);
  }

  #createMediaSource(content, msgtype) {
    const encrypted = content?.file && typeof content.file === 'object' ? content.file : null;
    const contentUri = cleanString(content?.url ?? encrypted?.url);
    if (!contentUri || !contentUri.startsWith('mxc://')) return null;
    const declaredSize = Number(content?.info?.size ?? encrypted?.size);
    if (Number.isFinite(declaredSize) && declaredSize > this.#config.maxMediaBytes) return null;
    const name = cleanString(content?.body) ?? cleanString(content?.filename) ?? undefined;
    const api = this.#api;
    const mediaType = cleanString(content?.info?.mimetype ?? content?.mimetype);
    const load = async (options = {}) => {
      try {
        return await api.downloadContent(contentUri, {
          ...options,
          maxBytes: this.#config.maxMediaBytes,
        });
      } catch {
        return null;
      }
    };
    const source = { name, ...(mediaType ? { mediaType } : {}), load };
    if (msgtype === 'm.image' && mediaType && !IMAGE_MEDIA_TYPES.has(mediaType.toLowerCase())) return null;
    if (msgtype === 'm.image') return { images: [source], files: [] };
    if (msgtype === 'm.audio' || msgtype === 'm.video' || msgtype === 'm.file' || msgtype === 'm.sticker') {
      return { images: [], files: [source] };
    }
    return null;
  }

  #createBotClient() {
    return {
      sendText: async (target, text) => await this.#sendRoomText(target, text),
      sendTyping: async (target) => {
        await this.#api?.setTyping(target?.roomId ?? '', { typing: true, timeoutMs: 20_000 }).catch(() => undefined);
      },
      addReaction: async (target, key) => {
        if (!isMatrixRoomId(target?.roomId) || !isMatrixEventId(target?.eventId)) return undefined;
        await this.#sendRoomEvent(target.roomId, 'm.reaction', buildMatrixReactionContent(target.eventId, key));
        return key;
      },
      removeReaction: async (target, key) => {
        if (!isMatrixRoomId(target?.roomId) || !isMatrixEventId(target?.eventId) || !this.#botUserId) return;
        const listing = await this.#api.listRelations(target.roomId, target.eventId, 'm.annotation');
        let events = Array.isArray(listing?.events) ? listing.events : [];
        if (this.#crypto) {
          const opened = [];
          for (const event of events) {
            if (event?.type !== 'm.room.encrypted') { opened.push(event); continue; }
            const decrypted = await this.#crypto.decryptRoomEvent(target.roomId, event).catch(() => null);
            if (decrypted?.content && typeof decrypted.content === 'object') opened.push({ ...event, content: decrypted.content });
          }
          events = opened;
        }
        const own = events.filter((event) => (
          typeof event?.sender === 'string'
          && event.sender.toLowerCase() === this.#botUserId.toLowerCase()
          && event?.content?.['m.reaction'] === key
        ));
        for (const event of own.slice(0, 5)) {
          await this.#api.redactEvent(target.roomId, event.event_id).catch(() => undefined);
        }
      },
      sendImage: async (target, file) => await this.#sendArtifact(target, file, true),
      sendFile: async (target, file) => await this.#sendArtifact(target, file, false),
      openStream: (target) => this.#openStream(target),
    };
  }

  async #sendRoomText(target, text, options = {}) {
    const api = this.#api;
    if (!api) throw new Error('Matrix bot is not connected');
    const roomId = typeof target?.roomId === 'string' ? target.roomId : '';
    if (!isMatrixRoomId(roomId)) throw new TypeError('Matrix reply target requires a valid room id');
    const threadId = typeof target?.threadId === 'string' && isMatrixEventId(target.threadId)
      ? target.threadId : null;
    const replyToEventId = typeof target?.replyToEventId === 'string' && isMatrixEventId(target.replyToEventId)
      ? target.replyToEventId : null;
    const chunks = splitMessageText(text, this.#config.maxMessageLength);
    const providerMessageIds = [];
    for (const chunk of chunks) {
      const content = buildMatrixTextContent({
        text: chunk,
        mentionUserIds: extractOutboundMentions(chunk),
        roomMention: this.#config.allowRoomMentions && hasRoomMention(chunk),
      });
      applyMatrixRelations(content, { threadId, replyToEventId });
      const result = await this.#sendRoomEvent(roomId, 'm.room.message', content, {
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (typeof result?.event_id === 'string') providerMessageIds.push(result.event_id);
    }
    return { providerMessageIds };
  }

  async #openStream(target) {
    const roomId = typeof target?.roomId === 'string' ? target.roomId : '';
    if (!isMatrixRoomId(roomId)) throw new TypeError('Matrix stream target requires a valid room id');
    if (!this.#api) throw new Error('Matrix bot is not connected');
    const initialText = t('正在处理…');
    const opened = await this.#sendRoomText(target, initialText);
    const messageId = opened.providerMessageIds[0] ?? null;
    const threadId = typeof target?.threadId === 'string' && isMatrixEventId(target.threadId)
      ? target.threadId : null;
    const stream = createEditableMessageStream({
      initialText,
      limit: this.#config.maxMessageLength,
      updateIntervalMs: EDIT_STREAM_INTERVAL_MS,
      create: async () => messageId,
      edit: async (streamMessageId, text) => {
        if (!isMatrixEventId(streamMessageId)) return;
        const content = buildMatrixEditContent({
          originalContent: { msgtype: 'm.text', body: initialText },
          newText: text,
          eventId: streamMessageId,
        });
        if (threadId) {
          content['m.relates_to'] = {
            ...content['m.relates_to'],
            chain: [{ event_id: threadId, origin_server: null, origin_sender: null, rel_type: 'm.thread' }],
          };
        }
        await this.#sendRoomEvent(roomId, 'm.room.message', content);
      },
      sendRemainder: async (chunk) => await this.#sendRoomText(target, chunk),
      messageIdForResult: (result) => result?.providerMessageIds?.at(-1) ?? null,
      logger: this.#logger,
    });
    await stream.start();
    return stream;
  }

  async #sendArtifact(target, file, preferImage) {
    const api = this.#api;
    if (!api) throw new Error('Matrix bot is not connected');
    const roomId = typeof target?.roomId === 'string' ? target.roomId : '';
    if (!isMatrixRoomId(roomId)) throw new TypeError('Matrix artifact target requires a valid room id');
    const bytes = await file?.load?.({}).catch(() => null);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      const error = new Error(t('结果文件内容为空或下载失败。'));
      error.code = 'artifact-provider-failed';
      throw error;
    }
    if (bytes.byteLength > this.#config.maxMediaBytes) {
      const error = new Error(t('结果文件超过 Matrix 媒体大小上限。'));
      error.code = 'artifact-too-large';
      throw error;
    }
    const mediaType = cleanString(file?.mediaType) ?? 'application/octet-stream';
    const fileName = cleanString(file?.name) ?? (preferImage ? 'image.jpg' : 'file.bin');
    const contentUri = await api.uploadMedia(bytes, { filename: fileName, mediaType }).catch((cause) => {
      const error = new Error(t('Matrix 媒体上传失败。'));
      error.code = 'artifact-provider-failed';
      error.cause = cause;
      throw error;
    });
    const threadId = typeof target?.threadId === 'string' && isMatrixEventId(target.threadId)
      ? target.threadId : null;
    const imageLike = preferImage && mediaType.toLowerCase().startsWith('image/');
    const baseContent = {
      body: fileName,
      filename: fileName,
      url: contentUri,
    };
    const info = { mimetype: mediaType, size: bytes.byteLength };
    const attempts = imageLike
      ? [{ msgtype: 'm.image', extra: { info } }, { msgtype: 'm.file', extra: { 'm.file': info } }]
      : [{ msgtype: 'm.file', extra: { 'm.file': info } }];
    let lastError = null;
    for (const attempt of attempts) {
      const content = { ...baseContent, msgtype: attempt.msgtype, ...attempt.extra };
      applyMatrixRelations(content, { threadId });
      try {
        await this.#sendRoomEvent(roomId, 'm.room.message', content);
        return { sent: true, msgtype: attempt.msgtype };
      } catch (error) {
        lastError = error;
        if (!(error instanceof MatrixApiError) || (error.code !== 'matrix-rejected' && error.code !== 'matrix-forbidden')) {
          throw error;
        }
      }
    }
    throw lastError ?? new Error(t('Matrix 文件消息发送失败。'));
  }

  #lastBatch = null;
}
