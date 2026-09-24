import { deferredStateAccess, normalizeDeferredState } from './deferred-state.mjs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Additional persisted keys a subclass may own. Kept intentionally small and
 * explicit: a subclass reads and writes them through extensionState().
 */
const EXTENSION_KEYS = Object.freeze([
  'emailBindings', 'mailCursor', 'pendingAuth', 'threadIds',
]);

const EMPTY_STATE = Object.freeze({ version: 1, sessions: {}, seenMessageIds: [], cursor: null });

function normalizeState(value) {
  if (!value || typeof value !== 'object') return structuredClone(EMPTY_STATE);
  const sessions = {};
  if (value.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions)) {
    for (const [key, sessionId] of Object.entries(value.sessions)) {
      if (typeof key === 'string' && key && typeof sessionId === 'string' && sessionId) {
        sessions[key] = sessionId;
      }
    }
  }
  const normalized = {
    version: 1,
    sessions,
    ...(value.deferred ? { deferred: normalizeDeferredState(value.deferred) } : {}),
    seenMessageIds: Array.isArray(value.seenMessageIds)
      ? value.seenMessageIds.filter((id) => typeof id === 'string' && id).slice(-1_000)
      : [],
    cursor: Number.isSafeInteger(value.cursor) && value.cursor >= 0 ? value.cursor : null,
  };
  // Channel-specific extensions survive a reload; each is normalized by the
  // subclass that owns it (see extensionKeys()).
  for (const key of EXTENSION_KEYS) {
    if (Object.hasOwn(value, key)) normalized[key] = value[key];
  }
  return normalized;
}

export class ConversationStateStore {
  #path;
  #state = structuredClone(EMPTY_STATE);
  #writeQueue = Promise.resolve();
  #deferred = deferredStateAccess(() => this.#state, () => this.#persist());

  constructor(path) {
    this.#path = path;
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

  /**
   * Take back a `markSeen` whose delivery never happened.
   *
   * `markSeen` means "this message was handled". A turn that failed before
   * producing anything is not handled, so keeping the mark makes the id a
   * permanent tombstone: every later poll short-circuits on `hasSeen` and the
   * mail is never retried. The bridge calls this to separate "attempted" from
   * "done". A message that already succeeded is never unmarked.
   */
  async unmarkSeen(messageId) {
    const index = this.#state.seenMessageIds.indexOf(messageId);
    if (index === -1) return false;
    this.#state.seenMessageIds.splice(index, 1);
    await this.#persist();
    return true;
  }

  cursor() {
    return this.#state.cursor;
  }

  async setCursor(cursor) {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError('Invalid update cursor');
    this.#state.cursor = cursor;
    await this.#persist();
  }

  snapshot() {
    return structuredClone(this.#state);
  }

  /**
   * Live view of the private state for subclasses that persist their own keys.
   * Returns the real object (not a clone) so an extension can be written in
   * place; call persist() afterwards.
   */
  extensionState() {
    return this.#state;
  }

  /** Flush the current state to disk after an extension write. */
  persist() {
    return this.#persist();
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
