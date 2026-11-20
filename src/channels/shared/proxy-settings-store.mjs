import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  applyProxySettingsPatch,
  DEFAULT_PROXY_SETTINGS,
  normalizeProxySettings,
  PROXY_SETTINGS_VERSION,
} from './proxy-settings.mjs';

const stores = new Map();

/**
 * The IM proxy document: one per DSH home, shared by the settings page, the RPC
 * and every channel that starts afterwards. Same shape as the delivery settings
 * store — atomic rename, serialized writes, and a damaged file falls back to
 * the defaults so a broken document never takes the channels down.
 */
export class ProxySettingsStore {
  #path;
  #settings = DEFAULT_PROXY_SETTINGS;
  #ready;
  #writes = Promise.resolve();

  constructor(path) {
    if (typeof path !== 'string' || !path) {
      throw new TypeError('proxy settings store path is required');
    }
    this.#path = path;
  }

  async get() {
    this.#ready ??= this.#load().catch((error) => { this.#ready = null; throw error; });
    await this.#ready;
    return { ...this.#settings };
  }

  /**
   * The settings as they are right now, without touching the disk.
   *
   * A transport is created synchronously, on every reconnect, so it cannot
   * await the store. It reads this instead: after a save the same store object
   * already holds the new document, which is what makes a bot reconnect enough
   * to apply a proxy change.
   */
  spec() {
    return this.#settings;
  }

  async #load() {
    let raw;
    try { raw = await readFile(this.#path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    let document;
    try { document = JSON.parse(raw); } catch { return; }
    if (!document || typeof document !== 'object' || Array.isArray(document)) return;
    if (document.version !== PROXY_SETTINGS_VERSION) return;
    this.#settings = normalizeProxySettings(document.proxy) ?? DEFAULT_PROXY_SETTINGS;
  }

  /** Apply a partial update: only the fields present in `patch` are written. */
  async set(patch) {
    const operation = this.#writes.catch(() => {}).then(async () => {
      const current = await this.get();
      const settings = applyProxySettingsPatch(current, patch);
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temporary = `${this.#path}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporary,
          `${JSON.stringify({ version: PROXY_SETTINGS_VERSION, proxy: settings }, null, 2)}\n`,
          // 0600: the password travels in this file, and it is not a place a
          // backup should be able to read anyway.
          { mode: 0o600, flag: 'wx' },
        );
        await rename(temporary, this.#path);
        this.#settings = settings;
      } finally { await rm(temporary, { force: true }); }
      return { ...settings };
    });
    this.#writes = operation;
    return operation;
  }
}

/** Path of the document, for diagnostics and tests. */
export function proxySettingsPath(config = {}) {
  const root = resolve(config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'));
  return join(root, 'integrations', 'dsh-im', 'proxy-settings.json');
}

/** One settings owner per DSH home, shared by the UI, the RPC and the channels. */
export function getProxySettingsStore(config = {}) {
  const path = proxySettingsPath(config);
  if (!stores.has(path)) stores.set(path, new ProxySettingsStore(path));
  return stores.get(path);
}
