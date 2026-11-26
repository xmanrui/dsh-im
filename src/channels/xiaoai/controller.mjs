import { t } from '../shared/i18n.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir, copyFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { TokenBotController } from '../shared/token-bot-controller.mjs';
import { withSessionBindingLock } from '../shared/session-binding-lock.mjs';
import { SidecarClient } from './sidecar-client.mjs';
import { parseCredential, deriveXiaoAIIdentity, maskXiaoAIId, XIAOAI_DESCRIPTOR } from './config-store.mjs';

function userError(message, ErrorType = Error) {
  return Object.assign(new ErrorType(message), { expose: true });
}

function deviceIdFromPlatformId(platformId) {
  const separator = typeof platformId === 'string' ? platformId.indexOf(':') : -1;
  return separator >= 0 ? platformId.slice(separator + 1) : platformId;
}

export class XiaoAIController extends TokenBotController {
  #options; #runtimes; #blocked; #auth = new Map(); #configStore; #authentication;
  #migrated = new Set(); #migrationWarnings = new Map(); #binding = Promise.resolve();
  constructor(options) {
    const runtimes = new Map();
    // Authentication and credential failures are permanent until a human logs in
    // again. Keep those bots out of the supervisor's start path so a bad
    // password/passToken cannot turn into a repeated Xiaomi login loop.
    const blocked = new Set();
    super({ ...options, descriptor: XIAOAI_DESCRIPTOR, deriveIdentity: deriveXiaoAIIdentity,
      maskPlatformId: maskXiaoAIId,
      inspectToken: async (token) => {
        const value = parseCredential(token);
        return { platformId: `${value.accountId}:${value.deviceId}`, name: value.name };
      },
      createRuntime: async (args) => {
        if (blocked.has(args.botId)) {
          throw Object.assign(new Error('XiaoAI re-login required'), { code: 'xiaoai-auth-required' });
        }
        let runtime;
        try {
          const credential = parseCredential(args.token);
          delete credential.password; // fail closed even if persistence migration failed
          runtime = await options.createRuntime({ ...args, token: JSON.stringify(credential) });
        } catch (error) {
          if (/credential|device identity|hardware/i.test(error?.message ?? '')) blocked.add(args.botId);
          throw error;
        }
        runtimes.set(args.botId, runtime);
        return runtime;
      },
    });
    this.#options = options; this.#runtimes = runtimes; this.#blocked = blocked;
    this.#configStore = options.configStore;
  }
  status() {
    const value = super.status();
    return { ...value, bots: value.bots.map((bot) => {
      const blocked = this.#blocked.has(bot.botId);
      const xiaoai = this.#runtimes.get(bot.botId)?.status ?? null;
      return {
        ...bot,
        xiaoai: xiaoai ? { ...xiaoai, retryBlocked: blocked } : null,
        ...(this.#migrationWarnings.has(bot.botId) ? { credentialWarning: t('旧密码清理写入失败，正在自动重试；运行时不使用该密码。') } : {}),
        ...(blocked ? {
          state: 'error',
          connected: false,
          health: { ...bot.health, status: 'error', summary: t('需要重新登录小米账号') },
          error: {
            code: 'xiaoai-auth-required',
            message: t('小米授权已失效，请在“小米账号接入”中重新登录并选择设备。'),
          },
        } : {}),
      };
    }) };
  }
  #refreshBlocked() {
    for (const [botId, runtime] of this.#runtimes) {
      let status;
      try { status = runtime?.status; } catch { continue; }
      if (status?.permanentFailure || status?.auth) this.#blocked.add(botId);
      else if (status?.ready) this.#blocked.delete(botId);
    }
  }
  async initialize() {
    await this.#migrateStoredCredentials();
    this.#refreshBlocked();
    try { await super.initialize(); }
    finally { this.#refreshBlocked(); }
    return this.status();
  }
  /**
   * P1-4 migration: older releases stored the Xiaomi account password in every
   * per-device credential. The password is only needed by the short-lived
   * interactive login worker; an established device uses the copied passToken.
   * Remove the password at the first controller initialization. A passToken
   * that has expired then surfaces as a normal re-login request instead of
   * silently keeping the account password on disk forever.
   */
  async #migrateStoredCredentials() {
    for (const config of this.#options.configStore.list()) {
      if (this.#migrated.has(config.tokenRef)) continue;
      let saved;
      try { saved = await this.#options.credentials.resolve(config.tokenRef); } catch { continue; }
      if (!saved?.value) continue;
      let credential;
      try { credential = JSON.parse(saved.value); } catch { continue; }
      if (!credential || typeof credential !== 'object') continue;
      if (!Object.hasOwn(credential, 'password')) { this.#migrated.add(config.tokenRef); this.#migrationWarnings.delete(config.botId); continue; }
      const next = { ...credential };
      delete next.password;
      try {
        await this.#options.credentials.set(config.tokenRef, JSON.stringify(next));
        this.#migrated.add(config.tokenRef); this.#migrationWarnings.delete(config.botId);
      } catch { this.#migrationWarnings.set(config.botId, true); }
    }
  }
  async reconnectBot(botId) {
    this.#blocked.delete(botId);
    try {
      await super.reconnectBot(botId);
      if (this.#runtimes.get(botId)?.status?.ready) {
        this.#unblockAccount(this.#configStore.get(botId)?.platformId.split(':')[0]);
      }
      return this.status();
    }
    finally { this.#refreshBlocked(); }
  }
  #unblockAccount(accountId) {
    for (const config of this.#configStore.list()) if (config.platformId.startsWith(accountId + ':')) {
      this.#blocked.delete(config.botId);
      if (this.#runtimes.get(config.botId)?.status?.permanentFailure) this.#runtimes.delete(config.botId);
    }
  }
  // Auth DTOs do not need workspace/model catalogs. The generic workspace
  // decorator wraps controller methods, so expose this independent service face.
  get authentication() {
    return this.#authentication ??= Object.freeze({
      beginAuth: this.beginAuth.bind(this), authStatus: this.authStatus.bind(this),
      submitAuth: this.submitAuth.bind(this), cancelAuth: this.cancelAuth.bind(this),
      bindDevice: this.bindDevice.bind(this), bindDevices: this.bindDevices.bind(this),
    });
  }
  #getAuth(id) {
    if (typeof id !== 'string' || !this.#auth.has(id)) throw userError(t('小米登录会话已过期，请重新登录。'));
    return this.#auth.get(id);
  }
  async beginAuth({ account, password }) {
    if (typeof account !== 'string' || !account.trim() || account.length > 128
      || typeof password !== 'string' || !password || password.length > 512) throw userError(t('请输入小米账号和密码'), TypeError);
    // Only one active login per management user is needed for this local gateway.
    for (const id of [...this.#auth.keys()]) await this.cancelAuth(id);
    const id = randomUUID();
    const root = join(this.#options.stateRoot, 'auth', id);
    const client = this.#options.createAuthClient?.({ stateDir: root }) ?? new SidecarClient({ ...this.#options.sidecar, stateDir: root });
    const auth = { id, root, client, credential: { account: account.trim(), password }, state: 'connecting', devices: [] };
    auth.timer = setTimeout(() => { void this.cancelAuth(id).catch(() => {}); }, 10 * 60_000); auth.timer.unref?.();
    this.#auth.set(id, auth);
    client.on('message', (message) => {
      if (message.type === 'auth_required') { auth.state = message.reason === 'verification-code' ? 'verification-required' : 'failed'; auth.method = message.method; }
      if (message.type === 'error') auth.state = 'failed';
    });
    client.on('exit', () => { if (auth.state !== 'ready') auth.state = 'failed'; });
    client.ready.then((ready) => {
      auth.state = 'ready'; auth.accountId = ready.accountId; auth.devices = ready.devices;
    }, () => { auth.state = 'failed'; });
    try { await client.start(auth.credential, 'discover'); }
    catch (error) { await this.cancelAuth(id).catch(() => {}); throw error; }
    return this.authStatus(id);
  }
  authStatus(id) {
    if (typeof id !== 'string' || !this.#auth.has(id)) return { authId: id, state: 'expired', devices: [] };
    const auth = this.#auth.get(id);
    return { authId: id, state: auth.state, method: auth.method, devices: auth.devices };
  }
  async submitAuth(id, code) {
    const auth = this.#getAuth(id);
    if (auth.state !== 'verification-required' || typeof code !== 'string' || !/^[A-Za-z0-9]{4,12}$/.test(code)) throw userError(t('请输入有效验证码'), TypeError);
    await auth.client.send({ type: 'auth_submit', code }); auth.state = 'verifying';
    return this.authStatus(id);
  }
  async bindDevice({ deviceId, ...input }) {
    const result = await this.bindDevices({ ...input, deviceIds: [deviceId] });
    return { ...result.status, binding: result.results };
  }
  bindDevices(input) {
    const task = this.#binding.catch(() => {}).then(() => this.#bindDevices(input));
    this.#binding = task.then(() => {}, () => {});
    return task;
  }
  async #bindDevices({ authId, deviceIds, keyword = '让大肥鱼回答' }) {
    const auth = this.#getAuth(authId);
    if (auth.state !== 'ready') throw userError(t('请先完成小米登录'));
    if (!Array.isArray(deviceIds) || !deviceIds.length || deviceIds.length > 32
      || new Set(deviceIds).size !== deviceIds.length
      || deviceIds.some(id => typeof id !== 'string' || !auth.devices.some(d => d.deviceId === id))
      || typeof keyword !== 'string' || !keyword.trim() || keyword.length > 80
      || /[\u0000-\u001f]/u.test(keyword)) throw userError(t('请选择设备并填写有效触发前缀'), TypeError);
    const selected = deviceIds.map(id => auth.devices.find(d => d.deviceId === id));
    const credentials = selected.map(device => parseCredential(JSON.stringify({
      account: auth.credential.account, accountId: auth.accountId,
      deviceId: device.deviceId, name: device.name, hardware: device.hardware || 'UNKNOWN',
      miotDID: device.miotDID ?? '', keyword: keyword.trim(),
    })));
    for (const config of this.#configStore.list()) {
      if (config.platformId.startsWith(auth.accountId + ':') && this.#runtimes.get(config.botId)?.active) {
        throw userError(t('该账号的音箱仍在处理任务，请先停止任务再重新绑定'));
      }
    }
    if (this.#options.accountTransport) await this.#options.accountTransport.adoptAccount(auth.accountId, join(auth.root, 'mi-token.json'));
    this.#unblockAccount(auth.accountId);
    const results = [];
    for (const credential of credentials) {
      const identity = deriveXiaoAIIdentity(`${auth.accountId}:${credential.deviceId}`);
      try {
        if (!this.#options.accountTransport) {
          const root = join(this.#options.stateRoot, identity.botId);
          await mkdir(root, { recursive: true, mode: 0o700 });
          await copyFile(join(auth.root, 'mi-token.json'), join(root, 'mi-token.json'));
          await chmod(join(root, 'mi-token.json'), 0o600);
        }
        await super.bindCredentials({ token: JSON.stringify(credential) });
        const bot = this.status().bots.find(b => b.botId === identity.botId);
        results.push({ deviceId: credential.deviceId, botId: identity.botId, bound: true, connected: bot?.connected === true });
      } catch { results.push({ deviceId: credential.deviceId, bound: false, message: t('设备绑定未完成，请重试。') }); }
    }
    if (results.every(r => r.bound)) await this.cancelAuth(authId).catch(() => {});
    this.#refreshBlocked();
    return { results, status: this.status() };
  }
  async cancelAuth(id) {
    if (typeof id !== 'string' || !this.#auth.has(id)) return { cancelled: true };
    const auth = this.#auth.get(id); this.#auth.delete(id); clearTimeout(auth.timer);
    await auth.client.close();
    await rm(auth.root, { recursive: true, force: true });
    return { cancelled: true };
  }
  async deviceSessions(botId) {
    const config = this.#configStore.get(botId);
    if (!config) throw new TypeError('Unknown XiaoAI device');
    const state = await this.#options.stateFor(botId);
    const catalog = await this.#options.listWorkspaceSessions(this.#options.botWorkspaceFor(botId));
    const sessions = Array.isArray(catalog) ? catalog : catalog.sessions ?? catalog.items ?? [];
    return { currentSessionId: state.sessionFor(`direct:${deviceIdFromPlatformId(config.platformId)}`), sessions };
  }
  async bindSession(botId, sessionId) {
    const config = this.#configStore.get(botId);
    const catalog = await this.deviceSessions(botId);
    if (this.#runtimes.get(botId)?.active) throw userError(t('请先停止设备当前任务再切换会话'));
    const state = await this.#options.stateFor(botId);
    const key = `direct:${deviceIdFromPlatformId(config.platformId)}`;
    await withSessionBindingLock(state, key, async () => {
      if (this.#runtimes.get(botId)?.active) throw userError(t('请先停止设备当前任务再切换会话'));
      if (sessionId === null) await state.clearSession(key);
      else {
        if (!catalog.sessions.some((s) => (s.sessionId ?? s.id) === sessionId)) throw userError(t('请选择当前工作区的会话'));
        await state.setSession(key, sessionId);
      }
    });
    return this.deviceSessions(botId);
  }
  async stopDevice(botId) {
    const runtime = this.#runtimes.get(botId);
    if (!runtime) throw userError(t('设备尚未连接'));
    return runtime.stopConversation();
  }
  async stopSpeech(botId) {
    const runtime = this.#runtimes.get(botId);
    if (!runtime) throw userError(t('设备尚未连接'));
    return runtime.cancelSpeech();
  }
  async reviewReceipts(botId) {
    const runtime = this.#runtimes.get(botId);
    if (!runtime) throw userError(t('设备尚未连接'));
    return runtime.reviewReceipts();
  }
  async setKeyword(botId, keyword) {
    const config = this.#configStore.get(botId);
    if (!config || typeof keyword !== 'string' || !keyword.trim() || keyword.length > 80 || /[\u0000-\u001f]/u.test(keyword)) throw userError(t('请选择设备并填写有效触发前缀'), TypeError);
    const saved = await this.#options.credentials.resolve(config.tokenRef);
    const credential = parseCredential(saved?.value);
    const normalized = keyword.trim();
    const persist = () => this.#options.credentials.set(config.tokenRef, JSON.stringify({ ...credential, keyword: normalized }));
    const runtime = this.#runtimes.get(botId);
    if (runtime) await runtime.setKeyword(normalized, persist);
    else await persist();
    return this.status();
  }
  async deleteBot(botId) {
    const accountId = this.#configStore.get(botId)?.platformId.split(':')[0];
    const value = await super.deleteBot(botId);
    this.#runtimes.delete(botId);
    this.#blocked.delete(botId);
    if (/^xiaoai_[a-f0-9]{24}$/.test(botId)) await rm(join(this.#options.stateRoot, botId), { recursive: true, force: true });
    if (accountId && !this.#configStore.list().some(c => c.platformId.startsWith(accountId + ':'))) {
      await this.#options.accountTransport?.removeAccount(accountId);
    }
    return value;
  }
  async close() {
    await this.#binding;
    for (const id of [...this.#auth.keys()]) await this.cancelAuth(id);
    this.#blocked.clear();
    await super.close();
    await this.#options.accountTransport?.close();
  }
}
