import { t } from '../shared/i18n.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { TextHarnessBridge, createTextBridgeStatus } from '../shared/text-harness-bridge.mjs';
import { harnessApprovalDecision } from '../shared/harness-approval.mjs';
import { parseCredential, XIAOAI_DESCRIPTOR } from './config-store.mjs';
import { SidecarClient, waitReady } from './sidecar-client.mjs';
import { ReceiptStore } from './state-store.mjs';

export function voiceText(text, keyword) {
  let value = text.trim();
  const commands = new Map([['停止回答', '/stop'], ['取消回答', '/stop'], ['停止播报', '/speech-stop'], ['新建会话', '/new'], ['查看状态', '/status']]);
  if (typeof keyword !== 'string' || !keyword.trim()) return null;
  if (!value.toLowerCase().startsWith(keyword.toLowerCase())) return null;
  value = value.slice(keyword.length).replace(/^[\s，,。:：！？!?、;；]+/u, '');
  return commands.get(value) ?? value;
}

export class XiaoAIRuntime {
  #options; #credential; #status = { ...createTextBridgeStatus(), ready: false, connectionState: 'idle', harnessReachable: false };
  #client; #bridge; #receipts; #abort; #ingress = Promise.resolve(); #turns = new Set(); #heartbeat;
  #lastHeartbeat = 0; #stopped = true; #permanentFailure = false;
  #cancelled = new Set(); #nativeTurns = new Set(); #outputs = new Map(); #speechEpoch = 0;
  constructor(options) { this.#options = options; this.#credential = parseCredential(options.token); delete this.#credential.password; }
  get status() { return structuredClone({ ...this.#status, ...this.#receipts?.summary(),
    taskActive: this.active,
    permanentFailure: this.#permanentFailure,
    routingMode: 'required-prefix',
    nativeSuppression: this.#credential.muteNative === false ? 'disabled' : 'best-effort',
    device: { deviceId: this.#credential.deviceId, hardware: this.#credential.hardware, keyword: this.#credential.keyword ?? '让大肥鱼回答' },
    sidecarPid: this.#client?.pid, sessionId: this.#options.state.sessionFor(`direct:${this.#credential.deviceId}`) }); }
  get active() { return this.#turns.size > 0 || this.#outputs.size > 0; }
  #bridgeHarness() {
    const decorate = (options = {}) => ({ ...options,
      onInteraction: async (interaction) => {
        this.#status.waitingInteraction = interaction?.kind ?? 'question';
        return options.onInteraction?.(interaction);
      },
      onInteractionResolved: async (resolution) => {
        this.#status.waitingInteraction = null;
        return options.onInteractionResolved?.(resolution);
      },
    });
    const source = this.#options.harness;
    return new Proxy(source, { get: (target, key) => {
      if (key === 'ask') return (sid, prompt, options) => target.ask(sid, prompt, decorate(options));
      if (key === 'workspaceSession' && typeof target.workspaceSession === 'function') return (...args) => {
        const session = target.workspaceSession(...args);
        return { ...session, ask: (prompt, options) => session.ask(prompt, decorate(options)) };
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
  async start() {
    await this.stop(); this.#stopped = false; this.#permanentFailure = false;
    this.#abort = new AbortController();
    this.#status.connectionState = 'connecting'; this.#status.startedAt = Date.now();
    this.#status.auth = null; this.#status.lastError = null;
    await this.#options.harness.ensureRunning(); this.#status.harnessReachable = true;
    const root = join(this.#options.stateRoot, this.#options.config.botId);
    this.#receipts = await new ReceiptStore(join(root, 'receipts.json')).load();
    this.#cancelled = new Set(this.#receipts.cancelledTurns());
    // Retire continuation state written by earlier releases. Every utterance
    // must now include the prefix, including answers to pending questions.
    for (const entry of Object.values(this.#receipts.inbound)) {
      if (entry.state === 'armed') await this.#receipts.patchInbound(entry.event.eventId, 'trigger-cancelled');
    }
    // Recovered receipts are older than anything that can arrive while the
    // bridge is being created; enqueue them first so a restart cannot answer
    // an old question after a newer live one.
    const backlog = Object.values(this.#receipts.inbound)
      .filter(entry => entry.state === 'received').map(entry => entry.event);
    const client = this.#client = this.#options.createSidecar?.({ stateDir: root, credential: this.#credential }) ?? new SidecarClient({ ...this.#options.sidecar, stateDir: root });
    client.on('message', (message) => {
      if (message.type === 'utterance') {
        if (!this.#bridge) backlog.push(message);
        else this.#accept(message);
      } else if (message.type === 'health') {
        this.#lastHeartbeat = Date.now();
        this.#status.lastCheckedAt = message.lastSuccessAt;
        this.#status.cloudConnected = message.connected;
        this.#status.lastError = message.connected ? null : t('小米云读取失败，正在重试');
        if (message.consecutiveFailures >= 5) { this.#status.ready = false; this.#status.connectionState = 'failed'; }
      } else if (message.type === 'auth_required') {
        // A Xiaomi credential/verification problem is permanent until the user
        // logs in again. Stop this child immediately so neither the poll loop
        // nor a retry can keep submitting the account password to Xiaomi.
        this.#permanentFailure = true;
        this.#status.auth = message.reason;
        this.#status.lastError = t('小米授权已失效，请在 XiaoAI 频道重新登录');
        this.#status.ready = false;
        this.#status.connectionState = 'failed';
        void client.close().catch(() => {});
      } else if (message.type === 'native_suppression') {
        this.#status.lastNativeSuppression = { status: message.status, at: Date.now() };
      }
    });
    client.on('fault', () => { this.#status.ready = false; this.#status.connectionState = 'failed'; });
    client.on('exit', () => { this.#status.ready = false; this.#status.connectionState = 'failed'; });
    await client.start(this.#credential);
    const ready = await waitReady(client, this.#options.connectTimeoutMs ?? 25_000);
    // `ready` and `auth_required` can arrive in the same stdout chunk. The auth
    // handler closes the child and marks the failure; do not let this
    // continuation overwrite that state and publish a connected runtime.
    if (this.#permanentFailure) {
      throw Object.assign(new Error('XiaoAI authorization is not ready'), { code: 'xiaoai-auth-required' });
    }
    this.#status.capabilities = ready.capabilities;
    const bot = { sendText: (target, text) => this.#speak(target, text), sendTyping: async () => {} };
    this.#bridge = new TextHarnessBridge({ descriptor: XIAOAI_DESCRIPTOR, bot,
      harness: this.#bridgeHarness(), state: this.#options.state,
      contextEnhancement: this.#options.contextEnhancement, accessPolicy: this.#options.accessPolicy,
      status: this.#status, logger: this.#options.logger, replyTimeoutMs: this.#options.replyTimeoutMs,
      signal: this.#abort.signal });
    this.#status.ready = true; this.#status.connectionState = 'connected'; this.#status.lastConnectedAt = Date.now();
    this.#lastHeartbeat = Date.now();
    for (const message of backlog) this.#accept(message);
    this.#heartbeat = setInterval(() => {
      if (Date.now() - this.#lastHeartbeat > 120_000) {
        this.#status.ready = false; this.#status.connectionState = 'failed';
        void client.close();
      }
    }, 15_000);
    this.#heartbeat.unref?.();
    return this.status;
  }
  #accept(event) {
    // Persist and acknowledge independently of the long-running model turn.
    this.#ingress = this.#ingress.then(async () => {
      if (this.#stopped || event.deviceId !== this.#credential.deviceId || !/^[a-f0-9]{64}$/.test(event.eventId)
        || typeof event.text !== 'string' || !Number.isSafeInteger(event.timestamp)) return;
      await this.#receipts.receive(event);
      await this.#client.send({ type: 'accepted', eventId: event.eventId });
      const prior = this.#receipts.getInbound(event.eventId);
      if (prior?.state !== 'received') return;
      const keyword = this.#credential.keyword ?? '让大肥鱼回答';
      const text = voiceText(event.text, keyword);
      const target = { deviceId: event.deviceId, eventId: event.eventId, turnId: event.eventId };
      if (this.#nativeTurns.size || this.#outputs.size) {
        // New speech can interrupt the old audio without entering a DSH chat.
        // Pending question answers must still be able to resume their original turn.
        await this.#interrupt({ permanent: !this.#status.waitingInteraction,
          stopDevice: Boolean(text), reason: text ? 'new-prefixed-utterance' : 'new-native-utterance' });
      }
      if (!text) { await this.#receipts.patchInbound(event.eventId, 'filtered'); return; }
      if (text === '/speech-stop') {
        await this.#interrupt({ permanent: true, stopDevice: true, reason: 'voice-stop-speech' });
        await this.#receipts.patchInbound(event.eventId, 'finished'); return;
      }
      await this.#receipts.patchInbound(event.eventId, 'dispatching');
      if (text === '/stop') {
        await this.#interrupt({ permanent: true, stopDevice: true, reason: 'voice-stop-task' });
        this.#cancelled.add(event.eventId); // the stop acknowledgement must stay quiet
        await this.#receipts.patchInbound(event.eventId, 'cancelled');
      } else if (this.#credential.muteNative !== false) {
        this.#status.lastNativeSuppression = { status: 'requested', at: Date.now() };
        void this.#client.request('mute_native', { deviceId: event.deviceId, turnId: event.eventId },
          { requestId: `${event.eventId}:mute`, timeoutMs: 4_000 }).catch(() => {});
      }
      let work;
      // Only intercept an approval token while an approval is actually waiting.
      // Otherwise "yes"/"同意" is an ordinary answer to a pending question (or a
      // normal request) and must reach the model unchanged. The guard matters
      // even when the Host approval policy is "never": no approval exists then.
      const approvalPending = this.#status.waitingInteraction === 'approval';
      if (approvalPending && harnessApprovalDecision(text)) work = this.#speak(target, t('请在 DSH Web 会话中查看并处理审批；补充信息可用选项序号或其他文字回答。'));
      else work = this.#bridge.accept({ messageId: event.eventId, senderId: event.deviceId,
        conversationId: event.deviceId, kind: 'direct', addressed: true, plainText: true,
        content: text, controlText: text, replyTarget: target }, { busyMessageMode: 'queue' });
      this.#nativeTurns.add(event.eventId);
      this.#turns.add(work);
      work.then(() => !this.#stopped && !this.#cancelled.has(event.eventId) && this.#receipts.patchInbound(event.eventId, 'finished'),
        () => !this.#stopped && !this.#cancelled.has(event.eventId) && this.#receipts.patchInbound(event.eventId, 'uncertain'))
        .catch(() => {}).finally(() => { this.#turns.delete(work); this.#nativeTurns.delete(event.eventId); });
    }).catch(() => {
      this.#status.lastError = t('入站消息持久化或接入失败，未确认的消息将重试');
    });
  }
  async #speak(target, text) {
    if (target?.deviceId !== this.#credential.deviceId || this.#stopped) throw new Error('XiaoAI device is not connected');
    const turnId = target.turnId ?? target.eventId ?? `output:${randomUUID()}`;
    if (this.#cancelled.has(turnId)) return { sent: false, cancelled: true };
    const epoch = this.#speechEpoch;
    this.#outputs.set(turnId, (this.#outputs.get(turnId) ?? 0) + 1);
    try {
    if (/需要你的审批|请精准回复「批准」|approval required/i.test(text)) text = t('当前任务需要审批，请在 DSH Web 会话中查看操作详情并处理。');
    const hash = createHash('sha256').update(text).digest('hex');
    const requestId = `${turnId}:${hash.slice(0, 24)}`;
    const previous = await this.#receipts.outboundIntent(requestId, hash, turnId);
    if (previous) {
      if (previous.state === 'cancelled') return { sent: false, cancelled: true };
      if (previous.state !== 'accepted') throw Object.assign(new Error('Previous speech delivery is uncertain'), { code: 'delivery-uncertain' });
      return { sent: true, completionConfirmed: previous.result.completionConfirmed };
    }
    if (epoch !== this.#speechEpoch || this.#cancelled.has(turnId)) {
      await this.#receipts.outboundResult(requestId, { status: 'cancelled', completionConfirmed: false });
      return { sent: false, cancelled: true };
    }
    const result = await this.#client.request('speak', { deviceId: target.deviceId, text, turnId }, { requestId });
    if (result.status === 'cancelled' || epoch !== this.#speechEpoch || this.#cancelled.has(turnId)) {
      await this.#receipts.outboundResult(requestId, { status: 'cancelled', completionConfirmed: false });
      return { sent: false, cancelled: true };
    }
    await this.#receipts.outboundResult(requestId, result);
    this.#status.lastDelivery = { status: result.status, completionConfirmed: result.completionConfirmed,
      transport: result.transport, modelProfile: result.modelProfile, code: result.code,
      providerCode: result.providerCode, innerCode: result.innerCode, httpStatus: result.httpStatus,
      errorType: result.errorType, at: Date.now() };
    if (result.status !== 'accepted') {
      const message = result.code === 'tts-authorization-required'
        ? t('播报所需的小米授权不可用，请在小米账号接入中重新登录。')
        : result.code === 'tts-rate-limited' ? t('小米接口暂时限制播报请求，请稍后再试；未自动重播。')
        : result.status === 'failed' ? t('小米接口拒绝了播报，请查看设备卡片的播报诊断。')
        : t('播报结果不确定，未自动重播；请查看设备卡片的播报诊断。');
      throw Object.assign(new Error(message), { code: 'delivery-' + result.status, expose: true });
    }
    return { sent: true, completionConfirmed: result.completionConfirmed };
    } finally {
      const count = (this.#outputs.get(turnId) ?? 1) - 1;
      if (count) this.#outputs.set(turnId, count); else this.#outputs.delete(turnId);
    }
  }
  async reviewReceipts() { await this.#receipts.reviewUncertain(); return this.status; }
  async sendConnectionTest(text) { return this.#speak({ deviceId: this.#credential.deviceId }, text); }
  async sendProactiveText(target, text, options = {}) {
    const logicalId = options.deliveryId ?? options.idempotencyKey;
    if (logicalId !== undefined && (typeof logicalId !== 'string' || !logicalId || logicalId.length > 128)) throw new TypeError('Invalid XiaoAI delivery identity');
    const identity = logicalId ? createHash('sha256').update(logicalId).digest('hex') : randomUUID();
    return this.#speak({ deviceId: target?.route?.deviceId, turnId: `delivery:${identity}` }, text);
  }
  async #interrupt({ permanent = true, stopDevice = true, reason = 'stop-speech' } = {}) {
    this.#speechEpoch += 1;
    const turnIds = permanent ? [...new Set([...this.#nativeTurns, ...this.#outputs.keys()])] : [];
    for (const id of turnIds) this.#cancelled.add(id);
    await this.#receipts.cancelTurns(turnIds);
    this.#status.lastCancellation = { reason, at: Date.now(), turns: turnIds.length };
    const completion = this.#client.request('cancel_speech', {
      deviceId: this.#credential.deviceId, turnIds, stopDevice,
    }, { timeoutMs: 5_000 }).catch(() => ({ status: 'unknown', playbackStopped: false }));
    return { completion };
  }
  async cancelSpeech() {
    const admission = this.#ingress.then(() => this.#interrupt());
    this.#ingress = admission.then(() => {}, () => {});
    const { completion } = await admission;
    const result = await completion;
    return { cancelled: true, playbackStopped: result.playbackStopped ?? null };
  }
  async stopPlayback() { return this.#client.request('stop_playback', { deviceId: this.#credential.deviceId }, { timeoutMs: 15_000 }); }
  async setKeyword(keyword, persist) {
    // Serialize against ingress while saved and live routing are changing.
    const update = this.#ingress.then(async () => {
      if (this.active || this.#status.waitingInteraction) throw Object.assign(new Error(t('请等待当前任务结束再修改触发前缀')), { expose: true });
      await persist();
      this.#credential.keyword = keyword;
    });
    this.#ingress = update.catch(() => {});
    await update;
    return this.status;
  }
  async stopConversation() {
    const stopped = this.cancelSpeech();
    const quietTurn = `quiet:${randomUUID()}`;
    this.#cancelled.add(quietTurn);
    await this.#bridge.accept({ messageId: randomUUID(), senderId: this.#credential.deviceId,
      conversationId: this.#credential.deviceId, kind: 'direct', addressed: true,
      content: '/stop', controlText: '/stop', replyTarget: { deviceId: this.#credential.deviceId, turnId: quietTurn } });
    return stopped;
  }
  async stop() {
    this.#stopped = true; clearInterval(this.#heartbeat); this.#abort?.abort();
    await this.#client?.close(); await this.#ingress.catch(() => {});
    let timer;
    await Promise.race([Promise.allSettled([...this.#turns]), new Promise(resolve => { timer = setTimeout(resolve, 3000); })]);
    clearTimeout(timer);
    await this.#receipts?.persist();
    this.#bridge = null; this.#client = null; this.#status.ready = false; this.#status.waitingInteraction = null;
  }
}
