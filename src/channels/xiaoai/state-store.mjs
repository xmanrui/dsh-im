import { ConversationStateStore } from '../shared/conversation-state-store.mjs';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_RECORDS = 2_000;
const PROTECTED_STATES = new Set(['uncertain', 'unknown', 'received', 'dispatching', 'sending']);

export class XiaoAIStateStore extends ConversationStateStore {}

export class ReceiptStore {
  #path; #data = { inbound: {}, outbound: {} }; #queue = Promise.resolve();
  constructor(path) { this.#path = path; }
  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8'));
      if (!parsed || typeof parsed !== 'object'
        || !parsed.inbound || !parsed.outbound || Array.isArray(parsed.inbound) || Array.isArray(parsed.outbound)
        || typeof parsed.inbound !== 'object' || typeof parsed.outbound !== 'object'
        || [...Object.values(parsed.inbound), ...Object.values(parsed.outbound)]
          .some(entry => !entry || typeof entry !== 'object' || typeof entry.state !== 'string')) {
        throw new TypeError('Invalid receipt document');
      }
      this.#data = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // A truncated/corrupt journal must not put the bot into a permanent
        // restart loop. Keep the damaged file for manual inspection, start empty.
        await rename(this.#path, `${this.#path}.corrupt-${Date.now()}`).catch(() => {});
        this.#data = { inbound: {}, outbound: {} };
      }
    }
    // An interrupted dispatch is uncertain; never automatically submit it twice.
    for (const entry of Object.values(this.#data.inbound)) if (entry.state === 'dispatching') entry.state = 'uncertain';
    for (const entry of Object.values(this.#data.outbound)) if (entry.state === 'sending') entry.state = 'unknown';
    await this.persist(); return this;
  }
  get inbound() { return structuredClone(this.#data.inbound); }
  get outbound() { return structuredClone(this.#data.outbound); }
  getInbound(id) { const entry = this.#data.inbound[id]; return entry ? structuredClone(entry) : null; }
  async receive(event) {
    if (this.#data.inbound[event.eventId]) return false;
    this.#data.inbound[event.eventId] = { state: 'received', event, at: Date.now() };
    await this.persist(); return true;
  }
  async patchInbound(id, state) { this.#data.inbound[id].state = state; await this.persist(); }
  async outboundIntent(id, textHash, turnId) {
    const prior = this.#data.outbound[id];
    if (prior) return structuredClone(prior);
    this.#data.outbound[id] = { state: 'sending', textHash, ...(turnId ? { turnId } : {}), at: Date.now() };
    await this.persist(); return null;
  }
  async outboundResult(id, result) {
    this.#data.outbound[id] = { ...this.#data.outbound[id], state: result.status, result };
    await this.persist();
  }
  async cancelTurns(turnIds) {
    const ids = new Set(turnIds);
    for (const [id, entry] of Object.entries(this.#data.inbound)) {
      if (ids.has(id) && entry.state === 'dispatching') entry.state = 'cancelled';
    }
    for (const entry of Object.values(this.#data.outbound)) {
      if (ids.has(entry.turnId) && entry.state === 'sending') entry.state = 'cancelled';
    }
    await this.persist();
  }
  cancelledTurns() {
    return [...new Set([
      ...Object.entries(this.#data.inbound).filter(([,e]) => e.state === 'cancelled').map(([id]) => id),
      ...Object.values(this.#data.outbound).filter(e => e.state === 'cancelled' && e.turnId).map(e => e.turnId),
    ])];
  }
  async reviewUncertain() {
    for (const entry of Object.values(this.#data.inbound)) if (entry.state === 'uncertain') entry.state = 'reviewed';
    for (const entry of Object.values(this.#data.outbound)) if (entry.state === 'unknown') entry.state = 'reviewed';
    await this.persist();
  }
  summary() {
    return { uncertainInbound: Object.values(this.#data.inbound).filter(e => e.state === 'uncertain').length,
      uncertainOutbound: Object.values(this.#data.outbound).filter(e => e.state === 'unknown').length };
  }
  #prune() {
    const cutoff = Date.now() - RETENTION_MS;
    const stale = (entry) => !PROTECTED_STATES.has(entry.state) && (entry.at ?? 0) < cutoff;
    for (const [id, entry] of Object.entries(this.#data.inbound)) if (stale(entry)) delete this.#data.inbound[id];
    for (const [id, entry] of Object.entries(this.#data.outbound)) if (stale(entry)) delete this.#data.outbound[id];
    const trim = (map) => {
      let count = Object.keys(map).length;
      if (count <= MAX_RECORDS) return;
      const removable = Object.entries(map).filter(([, entry]) => !PROTECTED_STATES.has(entry.state))
        .sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0));
      for (const [id] of removable) {
        if (count <= MAX_RECORDS) break;
        delete map[id]; count -= 1;
      }
    };
    trim(this.#data.inbound); trim(this.#data.outbound);
  }
  persist() {
    this.#prune();
    const data = JSON.stringify(this.#data, null, 2);
    const work = this.#queue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temporary = this.#path + '.tmp';
      const handle = await open(temporary, 'w', 0o600);
      try { await handle.chmod(0o600); await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, this.#path);
      // Persist the rename itself where the platform allows directory fsync.
      try {
        const directory = await open(dirname(this.#path), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } catch { /* not supported on every platform/filesystem */ }
    });
    this.#queue = work.catch(() => {}); return work;
  }
}
