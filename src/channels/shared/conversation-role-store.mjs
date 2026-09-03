import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { normalizeAgentPresetId } from './agent-preset.mjs';

const EMPTY_DOCUMENT = Object.freeze({ version: 1, overrides: {}, roleSessions: {} });

const BOT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function botIdOf(value) {
  if (typeof value !== 'string' || !BOT_ID_RE.test(value)) {
    throw new TypeError('Invalid bot id');
  }
  return value;
}

/** A conversation key is an opaque non-empty string; we never parse it here. */
function conversationKeyOf(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('conversation key is required');
  }
  return value;
}

function safePresetId(value) {
  if (value === null) return null;
  const normalized = normalizeAgentPresetId(value);
  if (normalized === null) {
    const error = new Error('Agent Preset 无效。');
    error.code = 'agent-preset-invalid';
    throw error;
  }
  return normalized;
}

function roleSessionKey(conversationKey, presetId) {
  return `${conversationKey}:${presetId}`;
}

function normalizeDocument(value) {
  if (!value || value.version !== 1) return null;
  const overrides = {};
  if (value.overrides && typeof value.overrides === 'object' && !Array.isArray(value.overrides)) {
    for (const [botId, byConversation] of Object.entries(value.overrides)) {
      if (!BOT_ID_RE.test(botId)) return null;
      if (!byConversation || typeof byConversation !== 'object' || Array.isArray(byConversation)) {
        return null;
      }
      const cleaned = {};
      for (const [conversationKey, presetId] of Object.entries(byConversation)) {
        if (!conversationKey) return null;
        const id = safePresetId(presetId);
        if (id !== null) cleaned[conversationKey] = id;
      }
      overrides[botId] = cleaned;
    }
  }
  const roleSessions = {};
  if (value.roleSessions && typeof value.roleSessions === 'object' && !Array.isArray(value.roleSessions)) {
    for (const [botId, byRoleKey] of Object.entries(value.roleSessions)) {
      if (!BOT_ID_RE.test(botId)) return null;
      if (!byRoleKey || typeof byRoleKey !== 'object' || Array.isArray(byRoleKey)) return null;
      const cleaned = {};
      for (const [roleKey, sessionId] of Object.entries(byRoleKey)) {
        if (!roleKey || typeof sessionId !== 'string' || !sessionId) return null;
        cleaned[roleKey] = sessionId;
      }
      roleSessions[botId] = cleaned;
    }
  }
  return { version: 1, overrides, roleSessions };
}

/**
 * Persists conversation-scoped Agent Preset overrides and role-scoped session
 * bindings. A bot still owns exactly one workspace; this store only adds a
 * per-conversation Preset override plus the resulting role-specific session.
 */
export class ConversationRoleStore {
  #path;
  #overrides = {};
  #roleSessions = {};
  #writeQueue = Promise.resolve();

  constructor(path) {
    if (typeof path !== 'string' || !path) throw new TypeError('role store path is required');
    this.#path = path;
  }

  async load() {
    try {
      const normalized = normalizeDocument(JSON.parse(await readFile(this.#path, 'utf8')));
      if (!normalized) throw new Error('dsh-im conversation role config is invalid');
      this.#overrides = normalized.overrides;
      this.#roleSessions = normalized.roleSessions;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.#overrides = {};
      this.#roleSessions = {};
    }
    return this;
  }

  overrideFor(botId, conversationKey) {
    const id = botIdOf(botId);
    const key = conversationKeyOf(conversationKey);
    return this.#overrides[id]?.[key] ?? null;
  }

  async setOverride(botId, conversationKey, presetId) {
    const id = botIdOf(botId);
    const key = conversationKeyOf(conversationKey);
    const normalized = safePresetId(presetId);
    const bucket = (this.#overrides[id] ??= {});
    if (normalized === null) delete bucket[key];
    else bucket[key] = normalized;
    await this.#persist();
    return this.overrideFor(id, key);
  }

  async clearOverride(botId, conversationKey) {
    return this.setOverride(botId, conversationKey, null);
  }

  roleSessionFor(botId, conversationKey, presetId) {
    const id = botIdOf(botId);
    const key = conversationKeyOf(conversationKey);
    const normalized = safePresetId(presetId);
    if (!normalized) return null;
    return this.#roleSessions[id]?.[roleSessionKey(key, normalized)] ?? null;
  }

  async setRoleSession(botId, conversationKey, presetId, sessionId) {
    const id = botIdOf(botId);
    const key = conversationKeyOf(conversationKey);
    const normalized = safePresetId(presetId);
    if (!normalized) throw new TypeError('invalid preset id for role session');
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('session id is required');
    const bucket = (this.#roleSessions[id] ??= {});
    bucket[roleSessionKey(key, normalized)] = sessionId;
    await this.#persist();
  }

  async clearRoleSession(botId, conversationKey, presetId) {
    const id = botIdOf(botId);
    const key = conversationKeyOf(conversationKey);
    const normalized = safePresetId(presetId);
    if (!normalized) return;
    const bucket = this.#roleSessions[id];
    if (!bucket) return;
    delete bucket[roleSessionKey(key, normalized)];
    await this.#persist();
  }

  /** Drop every override and role session owned by a bot (workspace switch / removal). */
  async clearBot(botId) {
    const id = botIdOf(botId);
    const hadOverride = Object.hasOwn(this.#overrides, id);
    const hadRoleSessions = Object.hasOwn(this.#roleSessions, id);
    delete this.#overrides[id];
    delete this.#roleSessions[id];
    if (hadOverride || hadRoleSessions) await this.#persist();
  }

  async remove() {
    try {
      await unlink(this.#path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    this.#overrides = {};
    this.#roleSessions = {};
  }

  async #persist() {
    const document = { version: 1 };
    if (Object.keys(this.#overrides).length > 0) document.overrides = this.#overrides;
    if (Object.keys(this.#roleSessions).length > 0) document.roleSessions = this.#roleSessions;
    const snapshot = `${JSON.stringify(document, null, 2)}\n`;
    const operation = this.#writeQueue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temporary = `${this.#path}.tmp`;
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.#path);
    });
    this.#writeQueue = operation.then(() => undefined, () => undefined);
    await operation;
  }
}
