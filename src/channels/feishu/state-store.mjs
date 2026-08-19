import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const EMPTY_STATE = Object.freeze({ version: 1, sessions: {}, seenMessageIds: [], watches: {} });

/** One watch entry: the watched session plus its chat delivery target. */
export const MAX_WATCHES_PER_KEY = 20;

function validWatchEntry(value) {
  return value
    && typeof value === 'object'
    && typeof value.sessionId === 'string' && value.sessionId.length > 0
    && typeof value.title === 'string';
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

  // ── Completion watches ──────────────────────────────────────────────────

  /** The watch entries of one conversation key. */
  watchesFor(key) {
    const items = this.#state.watches[key]?.items;
    return Array.isArray(items) ? items.filter(validWatchEntry) : [];
  }

  /** All (key, chatId, entry) triples watching a given session. */
  watchKeysFor(sessionId) {
    const found = [];
    for (const [key, record] of Object.entries(this.#state.watches)) {
      if (!record || typeof record !== 'object' || !Array.isArray(record.items)) continue;
      for (const entry of record.items) {
        if (validWatchEntry(entry) && entry.sessionId === sessionId) {
          found.push({ key, chatId: typeof record.chatId === 'string' ? record.chatId : null, entry });
        }
      }
    }
    return found;
  }

  /** All conversation keys whose bound session is `sessionId`. */
  sessionKeysFor(sessionId) {
    return Object.entries(this.#state.sessions)
      .filter(([, bound]) => bound === sessionId)
      .map(([key]) => key);
  }

  /** Add (or refresh) one watch under a conversation key. */
  async setWatch(key, chatId, entry) {
    if (!validWatchEntry(entry)) throw new TypeError('invalid watch entry');
    const record = this.#state.watches[key] ?? { chatId, items: [] };
    record.chatId = chatId;
    const items = record.items.filter((item) => validWatchEntry(item) && item.sessionId !== entry.sessionId);
    items.push({ sessionId: entry.sessionId, title: entry.title, workspace: entry.workspace });
    record.items = items.slice(-MAX_WATCHES_PER_KEY);
    this.#state.watches[key] = record;
    await this.#persist();
  }

  /** Remove one watched session under a conversation key. */
  async clearWatch(key, sessionId) {
    const record = this.#state.watches[key];
    if (!record || !Array.isArray(record.items)) return;
    record.items = record.items.filter((item) => item?.sessionId !== sessionId);
    if (record.items.length === 0) delete this.#state.watches[key];
    await this.#persist();
  }

  async clearWatches(key) {
    delete this.#state.watches[key];
    await this.#persist();
  }

  snapshot() {
    return structuredClone(this.#state);
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
