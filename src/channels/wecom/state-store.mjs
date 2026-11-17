import { deferredStateAccess, normalizeDeferredState } from '../shared/deferred-state.mjs';
import { createSessionRingSupport, normalizePendingTitles, normalizeSessionRings } from '../shared/session-ring-support.mjs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const EMPTY_STATE = Object.freeze({ version: 1, sessions: {}, seenMessageIds: [] });

/**
 * How many conversations remember their last author. One entry per
 * conversation, overwritten on every inbound message, so this is a bounded
 * map of "who spoke here last" -- never a transcript.
 */
const AUTHOR_LIMIT = 500;

/**
 * Keep only what identifies the speaker: no message text, no display extras.
 * A missing or malformed id drops the entry instead of storing a half record.
 */
function normalizeAuthor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const senderId = typeof value.senderId === 'string' ? value.senderId : '';
  if (!senderId) return null;
  const author = { senderId, isBot: value.isBot === true };
  if (typeof value.senderName === 'string' && value.senderName) author.senderName = value.senderName;
  if (typeof value.at === 'string' && value.at) author.at = value.at;
  return author;
}

function normalizeAuthors(value) {
  const authors = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return authors;
  const keys = Object.keys(value);
  for (const key of keys.slice(Math.max(0, keys.length - AUTHOR_LIMIT))) {
    if (typeof key !== 'string' || !key) continue;
    const author = normalizeAuthor(value[key]);
    if (author) authors[key] = author;
  }
  return authors;
}

function normalizeState(value) {
  if (!value || typeof value !== 'object') return structuredClone(EMPTY_STATE);
  const sessions = {};
  if (value.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions)) {
    for (const [key, sessionId] of Object.entries(value.sessions)) {
      if (typeof key === 'string' && typeof sessionId === 'string' && sessionId) sessions[key] = sessionId;
    }
  }
  // A file written before the navigation ring existed loads unchanged: the keys
  // are only added when they hold something.
  const rings = normalizeSessionRings(value.rings);
  const pendingTitles = normalizePendingTitles(value.pendingTitles);
  // Authors are optional for the same reason: a state file written before this
  // field existed loads unchanged and simply reports no author.
  const authors = normalizeAuthors(value.authors);
  return {
    version: 1,
    sessions,
    ...(value.deferred ? { deferred: normalizeDeferredState(value.deferred) } : {}),
    seenMessageIds: Array.isArray(value.seenMessageIds)
      ? value.seenMessageIds.filter((id) => typeof id === 'string').slice(-1_000)
      : [],
    ...(Object.keys(rings).length ? { rings } : {}),
    ...(Object.keys(pendingTitles).length ? { pendingTitles } : {}),
    ...(Object.keys(authors).length ? { authors } : {}),
  };
}

export class WecomStateStore {
  #path;
  #state = structuredClone(EMPTY_STATE);
  #writeQueue = Promise.resolve();
  #deferred = deferredStateAccess(() => this.#state, () => this.#persist());

  constructor(path) {
    this.#path = path;
    // The navigation ring is a view over this store's state, shared with the
    // channels that inherit `ConversationStateStore`.
    Object.assign(this, createSessionRingSupport({
      state: () => this.#state,
      persist: () => this.#persist(),
    }));
  }
  async load() {
    try {
      this.#state = normalizeState(JSON.parse(await readFile(this.#path, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.#state = structuredClone(EMPTY_STATE);
      await this.#persist();
    }
    return this;
  }

  deferredEntries() { return this.#deferred.entries(); }
  putDeferred(entry) { return this.#deferred.put(entry); }
  patchDeferred(id, patch) { return this.#deferred.patch(id, patch); }
  removeDeferred(id) { return this.#deferred.remove(id); }

  sessionFor(key) {
    return this.#state.sessions[key] ?? null;
  }

  /** The last speaker of a conversation, or null when none was recorded. */
  authorFor(key) {
    const author = this.#state.authors?.[key];
    return author ? structuredClone(author) : null;
  }

  /**
   * Remember who last spoke in a conversation. Persisted so the answer survives
   * a restart; overwritten on every inbound message and bounded by AUTHOR_LIMIT.
   */
  async rememberAuthor(key, value) {
    const author = normalizeAuthor({ at: new Date().toISOString(), ...value });
    if (typeof key !== 'string' || !key || !author) return null;
    const authors = this.#state.authors ??= {};
    delete authors[key];
    authors[key] = author;
    const keys = Object.keys(authors);
    if (keys.length > AUTHOR_LIMIT) {
      for (const stale of keys.slice(0, keys.length - AUTHOR_LIMIT)) delete authors[stale];
    }
    await this.#persist();
    return structuredClone(author);
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
    if (this.#state.seenMessageIds.length > 1_000) {
      this.#state.seenMessageIds.splice(0, this.#state.seenMessageIds.length - 1_000);
    }
    await this.#persist();
  }

  snapshot() {
    return structuredClone(this.#state);
  }

  async remove() {
    try {
      await unlink(this.#path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    this.#state = structuredClone(EMPTY_STATE);
  }

  async #persist() {
    const snapshot = `${JSON.stringify(this.#state, null, 2)}\n`;
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
