import { deferredStateAccess, normalizeDeferredState } from '../shared/deferred-state.mjs';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { qqStateError } from './state-error.mjs';

const EMPTY_STATE = Object.freeze({ version: 1, sessions: {}, seenMessageIds: [] });

function normalizeState(value) {
  if (!value || typeof value !== 'object') return structuredClone(EMPTY_STATE);
  const sessions = {};
  if (value.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions)) {
    for (const [key, sessionId] of Object.entries(value.sessions)) {
      if (typeof key === 'string' && typeof sessionId === 'string' && sessionId) {
        sessions[key] = sessionId;
      }
    }
  }
  return {
    version: 1,
    sessions,
    includeArchivedSessions: value.includeArchivedSessions === true,
    ...(value.deferred ? { deferred: normalizeDeferredState(value.deferred) } : {}),
    seenMessageIds: Array.isArray(value.seenMessageIds)
      ? value.seenMessageIds.filter((id) => typeof id === 'string').slice(-1_000)
      : [],
  };
}

export class QqStateStore {
  #path;
  #logger;
  #state = structuredClone(EMPTY_STATE);
  #writeQueue = Promise.resolve();
  #deferred = deferredStateAccess(() => this.#state, () => this.#persist());

  constructor(path, { logger = console } = {}) {
    this.#path = path;
    this.#logger = logger;
  }

  async load() {
    let bytes;
    try {
      bytes = await fs.readFile(this.#path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw qqStateError('state-read-failed', error);
      this.#state = structuredClone(EMPTY_STATE);
      await this.#persist();
      return this;
    }

    let parsed;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const backup = `${this.#path}.corrupt-${Date.now()}-${randomUUID()}`;
      try {
        // Copy the exact bytes before replacing anything. A failed rebuild
        // leaves both the original and this exclusive backup available.
        await fs.writeFile(backup, bytes, { flag: 'wx', mode: 0o600 });
      } catch (cause) {
        throw qqStateError('state-backup-failed', cause);
      }
      this.#state = structuredClone(EMPTY_STATE);
      await this.#persist();
      this.#logger.warn?.(`[dsh-im:qq] state-recovered: ${this.#path}; backup: ${backup}; conversation mappings, message deduplication and deferred deliveries have been reset.`);
      return this;
    }
    this.#state = normalizeState(parsed);
    return this;
  }

  deferredEntries() { return this.#deferred.entries(); }
  putDeferred(entry) { return this.#deferred.put(entry); }
  patchDeferred(id, patch) { return this.#deferred.patch(id, patch); }
  removeDeferred(id) { return this.#deferred.remove(id); }

  includesArchivedSessions() { return this.#state.includeArchivedSessions === true; }

  async setIncludeArchivedSessions(include) {
    this.#state.includeArchivedSessions = include === true;
    await this.#persist();
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
      await fs.unlink(this.#path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    this.#state = structuredClone(EMPTY_STATE);
  }

  async #persist() {
    const snapshot = `${JSON.stringify(this.#state, null, 2)}\n`;
    const operation = this.#writeQueue.then(async () => {
      await fs.mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temporary = `${this.#path}.tmp`;
      await fs.writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, this.#path);
    });
    this.#writeQueue = operation.then(() => undefined, () => undefined);
    await operation.catch(error => { throw qqStateError('state-write-failed', error); });
  }
}
