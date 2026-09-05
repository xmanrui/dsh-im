import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const EMPTY_STATE = Object.freeze({
  version: 1,
  sessions: {},
  seenMessageIds: [],
  watches: {},
  deferred: {},
  includeArchivedSessions: false,
  topics: {},
});

/** One conversation key may watch at most this many sessions. */
export const MAX_WATCHES_PER_KEY = 20;

/** A persisted watch entry: the watched session plus its delivery target. */
function validWatchEntry(value) {
  return value
    && typeof value === 'object'
    && typeof value.sessionId === 'string' && value.sessionId.length > 0
    && typeof value.chatId === 'string' && value.chatId.length > 0;
}

/** A persisted deferred-delivery entry (spec: feishu-timeout-deferred-delivery). */
function validDeferredEntry(value) {
  return value
    && typeof value === 'object'
    && typeof value.id === 'string' && value.id.length > 0
    && typeof value.key === 'string' && value.key.length > 0
    && typeof value.chatId === 'string' && value.chatId.length > 0
    && typeof value.sessionId === 'string' && value.sessionId.length > 0
    && (value.status === 'pending' || value.status === 'failed');
}

export class StateStore {
  #path;
  #state = structuredClone(EMPTY_STATE);
  #writeQueue = Promise.resolve();

  constructor(path) {
    this.#path = path;
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8'));
      this.#state = {
        version: 1,
        sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
        seenMessageIds: Array.isArray(parsed.seenMessageIds) ? parsed.seenMessageIds.slice(-1000) : [],
        watches: parsed.watches && typeof parsed.watches === 'object' ? parsed.watches : {},
        deferred: parsed.deferred && typeof parsed.deferred === 'object' ? parsed.deferred : {},
        includeArchivedSessions: typeof parsed.includeArchivedSessions === 'boolean'
          ? parsed.includeArchivedSessions
          : false,
        topics: parsed.topics && typeof parsed.topics === 'object' ? parsed.topics : {},
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await this.#persist();
    }
    return this;
  }

  sessionFor(key) {
    return this.#state.sessions[key] ?? null;
  }

  async setSession(key, sessionId) {
    this.#state.sessions[key] = sessionId;
    await this.#persist();
  }

  async clearSession(key) {
    delete this.#state.sessions[key];
    await this.#persist();
  }

  async clearSessions() {
    this.#state.sessions = {};
    await this.#persist();
  }

  hasSeen(messageId) {
    return this.#state.seenMessageIds.includes(messageId);
  }

  async markSeen(messageId) {
    if (this.hasSeen(messageId)) return;
    this.#state.seenMessageIds.push(messageId);
    if (this.#state.seenMessageIds.length > 1000) {
      this.#state.seenMessageIds.splice(0, this.#state.seenMessageIds.length - 1000);
    }
    await this.#persist();
  }

  snapshot() {
    return structuredClone(this.#state);
  }

  // ── Watches (persisted: surviving restarts) ─────────────────────────────

  watchEntries(key) {
    const list = this.#state.watches[key];
    return Array.isArray(list) ? list.filter(validWatchEntry) : [];
  }

  watchEntry(key, sessionId) {
    return this.watchEntries(key).find((entry) => entry.sessionId === sessionId) ?? null;
  }

  async setWatch(key, entry) {
    const list = this.#state.watches[key] ?? [];
    const index = list.findIndex((existing) => existing.sessionId === entry.sessionId);
    if (index === -1) {
      if (list.length >= MAX_WATCHES_PER_KEY) list.shift();
      list.push(entry);
    } else {
      list[index] = entry;
    }
    this.#state.watches[key] = list;
    await this.#persist();
  }

  async removeWatch(key, sessionId) {
    const list = this.#state.watches[key] ?? [];
    this.#state.watches[key] = list.filter((entry) => entry.sessionId !== sessionId);
    await this.#persist();
  }

  async clearWatches(key) {
    delete this.#state.watches[key];
    await this.#persist();
  }

  /** Every conversation key currently watching the given session. */
  keysWatching(sessionId) {
    return Object.entries(this.#state.watches)
      .filter(([, list]) => Array.isArray(list) && list.some((entry) => validWatchEntry(entry) && entry.sessionId === sessionId))
      .map(([key]) => key);
  }

  /** Unique watched session ids across all keys (restart compensation). */
  watchedSessionIds() {
    const ids = new Set();
    for (const list of Object.values(this.#state.watches)) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) if (validWatchEntry(entry)) ids.add(entry.sessionId);
    }
    return [...ids];
  }

  // ── Deferred delivery (persisted: surviving restarts) ───────────────────

  deferredEntries() {
    const rows = [];
    for (const list of Object.values(this.#state.deferred)) {
      if (Array.isArray(list)) rows.push(...list.filter(validDeferredEntry));
    }
    return rows;
  }

  async putDeferred(entry) {
    if (!validDeferredEntry(entry)) throw new TypeError('Invalid deferred delivery entry');
    const list = this.#state.deferred[entry.key] ?? [];
    const index = list.findIndex((existing) => existing.id === entry.id);
    if (index === -1) list.push(entry);
    else list[index] = entry;
    this.#state.deferred[entry.key] = list;
    await this.#persist();
  }

  async patchDeferred(id, patch) {
    for (const [key, list] of Object.entries(this.#state.deferred)) {
      if (!Array.isArray(list)) continue;
      const index = list.findIndex((entry) => entry?.id === id);
      if (index === -1) continue;
      const next = { ...list[index], ...patch };
      if (!validDeferredEntry(next)) throw new TypeError('Invalid deferred delivery patch');
      list[index] = next;
      this.#state.deferred[key] = list;
      await this.#persist();
      return { ...next };
    }
    return null;
  }

  async removeDeferred(id) {
    for (const [key, list] of Object.entries(this.#state.deferred)) {
      if (!Array.isArray(list)) continue;
      const next = list.filter((entry) => entry?.id !== id);
      if (next.length === list.length) continue;
      if (next.length === 0) delete this.#state.deferred[key];
      else this.#state.deferred[key] = next;
      await this.#persist();
      return;
    }
  }

  // ── Managed Feishu topics (thread_id → root message, persisted) ────────

  topicRootFor(threadId) {
    const entry = this.#state.topics[threadId];
    return entry && typeof entry === 'object'
      && typeof entry.rootMessageId === 'string' && entry.rootMessageId.length > 0
      && typeof entry.chatId === 'string' && entry.chatId.length > 0
      ? { rootMessageId: entry.rootMessageId, chatId: entry.chatId }
      : null;
  }

  async setTopic(threadId, root) {
    const validRoot = root && typeof root === 'object'
      && typeof root.rootMessageId === 'string' && root.rootMessageId.length > 0
      && typeof root.chatId === 'string' && root.chatId.length > 0;
    if (!validRoot) throw new TypeError('Invalid Feishu topic root');
    this.#state.topics[threadId] = {
      rootMessageId: root.rootMessageId,
      chatId: root.chatId,
    };
    await this.#persist();
  }

  // ── Session-list archived policy (per bot) ───────────────────

  includesArchivedSessions() {
    return this.#state.includeArchivedSessions === true;
  }

  async setIncludeArchivedSessions(include) {
    this.#state.includeArchivedSessions = include === true;
    await this.#persist();
  }

  async #persist() {
    const snapshot = JSON.stringify(this.#state, null, 2) + '\n';
    this.#writeQueue = this.#writeQueue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temporary = `${this.#path}.tmp`;
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.#path);
    });
    await this.#writeQueue;
  }
}
