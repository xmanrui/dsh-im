import { randomUUID } from 'node:crypto';
import { ConversationStateStore } from '../shared/conversation-state-store.mjs';

export class AirumoStateStore extends ConversationStateStore {
  async load() {
    await super.load();
    const state = this.extensionState();
    if (
      state.airumoRequests &&
      (typeof state.airumoRequests !== 'object' || Array.isArray(state.airumoRequests))
    )
      throw new Error('AIRumo task state is invalid');
    state.airumoRequests ??= {};
    const phases = new Set([
      'queued',
      'accepting',
      'accepted',
      'dispatching',
      'executing',
      'result',
      'done',
    ]);
    for (const [id, e] of Object.entries(state.airumoRequests)) {
      if (
        e?.input?.request_id !== id ||
        !phases.has(e.phase) ||
        (e.phase !== 'done' &&
          (typeof e.input.session_id !== 'string' || !Number.isSafeInteger(e.input.deadline_ts)))
      )
        throw new Error('AIRumo task state is invalid');
    }
    state.airumoConsumerId ??= `dsh-${randomUUID()}`;
    await this.persist();
    return this;
  }
  consumerId() {
    return this.extensionState().airumoConsumerId;
  }
  requests() {
    return structuredClone(Object.values(this.extensionState().airumoRequests));
  }
  request(id) {
    return structuredClone(this.extensionState().airumoRequests[id] ?? null);
  }
  async putRequest(entry) {
    const entries = this.extensionState().airumoRequests;
    entries[entry.input.request_id] = structuredClone(entry);
    // Preserve every unsettled task. Keep recent receipts bounded; published work is never replayed.
    const settled = Object.values(entries)
      .filter((e) => e.phase === 'done')
      .sort((a, b) => a.at - b.at);
    for (const e of settled.slice(0, Math.max(0, settled.length - 1000)))
      delete entries[e.input.request_id];
    await this.persist();
  }
}
