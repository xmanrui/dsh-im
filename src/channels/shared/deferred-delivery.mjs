export const MAX_DEFERRED_PER_KEY = 4;

/** Classify one turn/end event into a delivery outcome. */
export function terminalOutcomeOf(turnEndEvent) {
  const raw = turnEndEvent?.data?.reason;
  const kind = typeof raw === 'string'
    ? raw
    : typeof raw?.kind === 'string' ? raw.kind : null;
  return { kind: kind ?? 'other', pushFullAnswer: kind === 'completed' };
}

function eventOf(entry) {
  return entry?.event ?? (entry?.type ? entry : null);
}

function orderedEvents(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map(eventOf)
    .filter(Boolean)
    .sort((left, right) => (left.seq ?? -1) - (right.seq ?? -1));
}

function assistantAnswer(event) {
  if (event?.type !== 'assistant/message' || !Number.isSafeInteger(event.data?.turn)) return null;
  if (event.data.interrupted === true) return null;
  const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
  const text = content
    .flatMap((block) => (block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
    .join('\n')
    .trim();
  return text ? { turn: event.data.turn, text } : null;
}

/**
 * Extract the final answer of one completed turn from durable history events.
 * `turn` omitted → the latest ended turn wins. Returns
 * `{ found, turn, text, reason, endSeq }`; `found: false` when the turn ended
 * without a completed final answer (stopped/failed/empty/interrupted).
 */
export function extractCompletedTurnAnswer(entries, { turn } = {}) {
  const events = orderedEvents(entries);
  const answers = new Map();
  for (const event of events) {
    const answer = assistantAnswer(event);
    if (answer) answers.set(answer.turn, answer);
  }
  const wantTurn = Number.isSafeInteger(turn) ? turn : null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'turn/end' || !Number.isSafeInteger(event.data?.turn)) continue;
    if (wantTurn !== null && event.data.turn !== wantTurn) continue;
    const raw = event.data?.reason;
    const reason = typeof raw === 'string' ? raw : typeof raw?.kind === 'string' ? raw.kind : null;
    const answer = answers.get(event.data.turn);
    if (reason === 'completed' && answer?.text) {
      return { found: true, turn: event.data.turn, text: answer.text, reason, endSeq: event.seq ?? -1 };
    }
    if (wantTurn !== null) {
      return { found: false, turn: event.data.turn, text: null, reason, endSeq: event.seq ?? -1 };
    }
  }
  return { found: false, turn: wantTurn, text: null, reason: null, endSeq: -1 };
}

/**
 * Registry over a tiny persistence interface:
 * `listDeferred() / putDeferred(entry) / patchDeferred(id, patch) / removeDeferred(id)`.
 * Entries are plain owned objects; `id` is `${key} ${sessionId} ${turn ?? 'any'}`.
 */
export function createDeferredDeliveryRegistry(store, {
  now = () => Date.now(),
  maxPerKey = MAX_DEFERRED_PER_KEY,
  logger = console,
} = {}) {
  function deferredId(key, sessionId, turn) {
    return `${key} ${sessionId} ${Number.isSafeInteger(turn) ? turn : 'any'}`;
  }

  return {
    deferredId,
    async register({
      key, chatId, replyToMessageId = null, sessionId, turn = null, afterSeq = -1,
    }) {
      if (typeof key !== 'string' || !key) throw new TypeError('key is required');
      if (typeof chatId !== 'string' || !chatId) throw new TypeError('chatId is required');
      if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId is required');
      const entry = {
        id: deferredId(key, sessionId, turn),
        key,
        chatId,
        replyToMessageId: typeof replyToMessageId === 'string' ? replyToMessageId : null,
        sessionId,
        turn: Number.isSafeInteger(turn) ? turn : null,
        afterSeq: Number.isSafeInteger(afterSeq) ? afterSeq : -1,
        lastSeenEndSeq: -1,
        attempts: 0,
        status: 'pending',
        createdAt: now(),
      };
      const sameKey = (await store.listDeferred())
        .filter((candidate) => candidate.key === key && candidate.status === 'pending');
      if (sameKey.length >= maxPerKey) {
        logger?.warn?.('[dsh-im] deferred delivery limit reached for key; dropping the oldest entry');
        await store.removeDeferred(sameKey[0].id);
      }
      await store.putDeferred(entry);
      return entry;
    },
    async pendingForSession(sessionId) {
      return (await store.listDeferred())
        .filter((entry) => entry.status === 'pending' && entry.sessionId === sessionId);
    },
    async pendingForKey(key) {
      return (await store.listDeferred())
        .filter((entry) => entry.status === 'pending' && entry.key === key);
    },
    async allPending() {
      return (await store.listDeferred()).filter((entry) => entry.status === 'pending');
    },
    async markSeen(entry, endSeq) {
      await store.patchDeferred(entry.id, { lastSeenEndSeq: endSeq });
    },
    async markFailedAttempt(entry) {
      // Read fresh state: the caller's snapshot goes stale across attempts.
      const current = (await store.listDeferred())
        .find((candidate) => candidate.id === entry.id) ?? entry;
      const attempts = (current.attempts ?? 0) + 1;
      await store.patchDeferred(entry.id, { attempts, status: attempts >= 3 ? 'failed' : 'pending' });
      return attempts;
    },
    async remove(entry) {
      await store.removeDeferred(entry.id);
    },
  };
}
