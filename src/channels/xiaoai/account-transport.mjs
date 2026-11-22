import { EventEmitter } from 'node:events';
import { mkdir, copyFile, chmod, access, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SidecarClient, waitReady } from './sidecar-client.mjs';
import { deriveXiaoAIIdentity } from './config-store.mjs';

/** One private token and Python process per Xiaomi account; endpoints remain devices. */
export class AccountTransportPool {
  #options; #entries = new Map(); #tails = new Map(); #closed = false;
  constructor(options) { this.#options = options; }
  accountRoot(accountId) {
    if (!/^[a-f0-9]{24}$/.test(accountId)) throw new TypeError('Invalid Xiaomi account identity');
    return join(this.#options.stateRoot, 'accounts', accountId);
  }
  endpoint(credential) { return new DeviceEndpoint(this, credential); }
  #serial(accountId, operation) {
    const next = (this.#tails.get(accountId) ?? Promise.resolve()).catch(() => {}).then(operation);
    const settled = next.then(() => {}, () => {});
    this.#tails.set(accountId, settled);
    void settled.then(() => { if (this.#tails.get(accountId) === settled) this.#tails.delete(accountId); });
    return next;
  }
  async #ensureToken(credential) {
    const root = this.accountRoot(credential.accountId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const token = join(root, 'mi-token.json');
    try { await access(token); }
    catch {
      const identity = deriveXiaoAIIdentity(`${credential.accountId}:${credential.deviceId}`);
      // Reuse the current device login. Do not read or log its contents.
      await this.#copyToken(join(this.#options.stateRoot, identity.botId, 'mi-token.json'), root);
    }
    return root;
  }
  async #copyToken(source, root) {
    const temporary = join(root, `.token-${randomUUID()}.tmp`);
    try {
      await copyFile(source, temporary); await chmod(temporary, 0o600);
      const handle = await open(temporary, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, join(root, 'mi-token.json'));
      try {
        const directory = await open(root, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } catch { /* directory fsync is not supported on Windows */ }
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  async adoptAccount(accountId, sourceToken) {
    return this.#serial(accountId, async () => {
      const root = this.accountRoot(accountId);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const existing = this.#entries.get(accountId);
      if (existing) { this.#entries.delete(accountId); await existing.client.close(); }
      // Auth worker and destination are private on the same local filesystem.
      await this.#copyToken(sourceToken, root);
    });
  }
  async connect(endpoint, credential) {
    return this.#serial(credential.accountId, async () => {
      if (this.#closed || endpoint.closed) throw new Error('XiaoAI transport is closed');
      let entry = this.#entries.get(credential.accountId);
      if (entry?.failed) { this.#entries.delete(credential.accountId); await entry.client.close(); entry = null; }
      if (!entry) {
        const stateDir = await this.#ensureToken(credential);
        const client = this.#options.createClient?.({ stateDir })
          ?? new SidecarClient({ ...this.#options.sidecar, stateDir });
        entry = { client, endpoints: new Set(), failed: false, ready: null };
        this.#entries.set(credential.accountId, entry);
        const emitAll = (event, value) => {
          for (const destination of entry.endpoints) destination.deliver(event, value);
        };
        client.on('message', message => {
          for (const destination of entry.endpoints) {
            if (!message.deviceId || message.deviceId === destination.deviceId) destination.deliver('message', message);
          }
        });
        client.on('fault', fault => { entry.failed = true; emitAll('fault', fault); });
        client.on('exit', exit => { entry.failed = true; emitAll('exit', exit); });
        entry.endpoints.add(endpoint); endpoint.attach(entry);
        try {
          await client.start({ account: credential.account, accountId: credential.accountId }, 'account');
          entry.ready = await waitReady(client, this.#options.connectTimeoutMs ?? 25_000);
        } catch (error) {
          entry.failed = true; entry.endpoints.delete(endpoint);
          this.#entries.delete(credential.accountId); await client.close(); throw error;
        }
      } else { entry.endpoints.add(endpoint); endpoint.attach(entry); }
      try {
        if (endpoint.closed) throw new Error('XiaoAI device connection cancelled');
        const result = await entry.client.request('device_add', {
          deviceId: credential.deviceId, hardware: credential.hardware,
        }, { timeoutMs: 15_000 });
        if (result.status !== 'accepted') throw new Error('XiaoAI device unavailable');
        endpoint.resolveReady({ ...entry.ready, capabilities: result.capabilities ?? entry.ready.capabilities });
      } catch (error) {
        entry.endpoints.delete(endpoint);
        if (!entry.endpoints.size) {
          this.#entries.delete(credential.accountId); await entry.client.close();
        }
        throw error;
      }
    });
  }
  async release(endpoint, credential) {
    return this.#serial(credential.accountId, async () => {
      const entry = endpoint.entry;
      if (!entry || entry !== this.#entries.get(credential.accountId)) return;
      entry.endpoints.delete(endpoint);
      if (!entry.endpoints.size) {
        this.#entries.delete(credential.accountId); await entry.client.close();
      } else if (!entry.failed && ![...entry.endpoints].some(e => e.deviceId === credential.deviceId)) {
        await entry.client.request('device_remove', { deviceId: credential.deviceId }, { timeoutMs: 4_000 });
      }
    });
  }
  async close() {
    this.#closed = true;
    await Promise.allSettled([...this.#tails.values()]);
    await Promise.allSettled([...this.#entries.values()].map(e => e.client.close()));
    this.#entries.clear();
  }
  async removeAccount(accountId) {
    return this.#serial(accountId, async () => {
      const entry = this.#entries.get(accountId);
      if (entry) { this.#entries.delete(accountId); await entry.client.close(); }
      await rm(this.accountRoot(accountId), { recursive: true, force: true });
    });
  }
}

class DeviceEndpoint extends EventEmitter {
  #pool; #credential; #entry; #closed = false; #ready; #resolve; #reject; #start;
  constructor(pool, credential) {
    super(); this.#pool = pool; this.#credential = credential;
    this.#ready = new Promise((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
    this.#ready.catch(() => {});
  }
  get ready() { return this.#ready; }
  get pid() { return this.#entry?.client.pid; }
  get closed() { return this.#closed; }
  get entry() { return this.#entry; }
  get deviceId() { return this.#credential.deviceId; }
  attach(entry) { this.#entry = entry; }
  resolveReady(value) { this.#resolve(value); }
  deliver(event, value) {
    if (this.#closed) return;
    if (event === 'exit' || event === 'fault') this.#reject(new Error('Xiaomi account transport unavailable'));
    this.emit(event, value);
  }
  start() {
    return this.#start ??= this.#pool.connect(this, this.#credential).catch(error => { this.#reject(error); throw error; });
  }
  send(message) {
    if (this.#closed || !this.#entry) return Promise.reject(new Error('XiaoAI device offline'));
    // An endpoint cannot issue account configuration or another device's commands.
    if (message.type !== 'accepted' || message.deviceId && message.deviceId !== this.deviceId) return Promise.reject(new Error('Invalid XiaoAI endpoint message'));
    return this.#entry.client.send({ ...message, deviceId: this.deviceId });
  }
  request(type, fields = {}, options) {
    if (this.#closed || !this.#entry) return Promise.resolve({ status: 'unknown', code: 'device-offline' });
    if (!['speak', 'stop_playback', 'cancel_speech', 'mute_native'].includes(type)
      || fields.deviceId !== this.deviceId) return Promise.reject(new Error('Invalid XiaoAI device command'));
    return this.#entry.client.request(type, fields, options);
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#start?.catch(() => {});
    await this.#pool.release(this, this.#credential);
  }
}
