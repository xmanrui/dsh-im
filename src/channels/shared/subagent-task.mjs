import { setTimeout as delay } from 'node:timers/promises';

/** A successful send_message starts another run without emitting a new catalog entry. */
export class SubagentDispatchTracker {
  #calls = new Map();

  consume(event) {
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return null;
    if (event.type === 'subagent/catalog') {
      return typeof event.data?.childId === 'string' && event.data.childId || null;
    }
    const data = event.data;
    if (event.type === 'tool/call' && data?.name === 'send_message') {
      let args = data.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { return null; }
      }
      if (typeof data.callId === 'string' && typeof args?.agent_id === 'string' && args.agent_id) {
        this.#calls.set(data.callId, args.agent_id);
      }
    }
    if (event.type !== 'tool/result') return null;
    const message = data?.message;
    const callId = message?.toolCallId ?? message?.source?.callId ?? data?.callId;
    const childId = this.#calls.get(callId);
    this.#calls.delete(callId);
    return childId && message?.isError === false && !data?.error ? childId : null;
  }
}

/** Follow only children proved to belong to this reply, across parent turns. */
export class SubagentTaskTracker {
  #dispatch = new SubagentDispatchTracker();
  constructor({ turn, afterSeq, childIds }) {
    this.turn = turn;
    this.lastSeq = afterSeq;
    this.pending = new Set(childIds);
    this.openTurn = null;
    this.finished = false;
    this.reason = null;
  }

  consume(entries) {
    const events = entries.map((entry) => entry?.event ?? entry)
      .filter(Boolean).sort((a, b) => a.seq - b.seq);
    for (const event of events) {
      if (this.finished || !Number.isSafeInteger(event.seq) || event.seq <= this.lastSeq) continue;
      this.lastSeq = event.seq;
      if (event.type === 'turn/start') this.openTurn = event.data?.turn ?? null;
      const source = event.data?.source;
      if (event.type === 'user/message'
        && (event.surfaceOp === undefined || event.surfaceOp === 'append')
        && ['agent-message', 'subagent-settled'].includes(source?.kind)
        && this.pending.has(source.senderSessionId)) {
        this.turn = event.data?.turn ?? this.openTurn;
        if (source.kind === 'subagent-settled') this.pending.delete(source.senderSessionId);
      }
      if (this.openTurn === this.turn) {
        const childId = this.#dispatch.consume(event);
        if (childId) this.pending.add(childId);
      }
      if (event.type !== 'turn/end' || event.data?.turn !== this.turn) continue;
      const reason = event.data?.reason?.kind ?? event.data?.reason;
      if (this.pending.size > 0 && reason === 'completed') continue;
      this.finished = true;
      this.reason = reason ?? 'unknown';
    }
  }
}

/** Status observation is independent of message delivery and never submits a prompt. */
export async function waitForSubagentTask(harness, task, { signal } = {}) {
  const tracker = new SubagentTaskTracker(task);
  while (!tracker.finished) {
    signal?.throwIfAborted();
    const entries = [];
    let beforeSeq;
    for (let page = 0; ; page += 1) {
      const history = await harness.rpc('session.history', {
        sessionId: task.sessionId, maxMessages: 50,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      }, 30_000, { signal });
      const events = history.events ?? [];
      entries.push(...events);
      const oldest = Math.min(...events.map((entry) => (entry.event ?? entry).seq));
      if (!history.hasMore || oldest <= tracker.lastSeq + 1) break;
      // An incomplete history is not proof of completion.
      if (page >= 19 || !Number.isSafeInteger(oldest) || oldest === beforeSeq) {
        throw new Error('Incomplete subagent task history');
      }
      beforeSeq = oldest;
    }
    tracker.consume(entries);
    if (!tracker.finished) await delay(1_000, undefined, { signal, ref: false });
  }
  return tracker.reason;
}
