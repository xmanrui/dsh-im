export const MAX_DEFERRED_PER_KEY = 4;

/** Classify one turn/end event into a terminal-reason label. */
export function terminalOutcomeOf(turnEndEvent) {
  const raw = turnEndEvent?.data?.reason;
  const kind = typeof raw === 'string'
    ? raw
    : typeof raw?.kind === 'string' ? raw.kind : null;
  return { kind: kind ?? 'other' };
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

function textFromContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) => (block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
    .join('\n')
    .trim();
}

/**
 * Extract the final answer of one completed turn from durable history events.
 *
 * Mirrors HarnessReplyTracker accumulation: chunk deltas accumulate per
 * (step, part index); a canonical assistant/message replaces its step; steps
 * join with a blank line. `turn` omitted → the latest ended turn wins.
 * Returns `{ found, turn, text, reason, endSeq }`; `found: false` when the
 * turn ended without a completed final answer (stopped/failed/empty/
 * interrupted) — `reason`/`endSeq` still identify the confirmed terminal.
 */
export function extractCompletedTurnAnswer(entries, { turn } = {}) {
  const events = orderedEvents(entries);
  const wantTurn = Number.isSafeInteger(turn) ? turn : null;
  const chunkParts = new Map();   // turn -> step -> partIndex -> text
  const canonical = new Map();    // turn -> step -> { text, interrupted }
  for (const event of events) {
    if (event?.type === 'assistant/chunk' && event.data?.chunk?.type === 'text-delta') {
      const turnId = event.data?.turn;
      if (!Number.isSafeInteger(turnId)) continue;
      const text = event.data.chunk.text;
      if (typeof text !== 'string' || !text) continue;
      const step = Number.isSafeInteger(event.data.step) ? event.data.step : 0;
      const index = Number.isSafeInteger(event.data.chunk.index) ? event.data.chunk.index : 0;
      const steps = chunkParts.get(turnId) ?? new Map();
      const parts = steps.get(step) ?? new Map();
      parts.set(index, (parts.get(index) ?? '') + text);
      steps.set(step, parts);
      chunkParts.set(turnId, steps);
    } else if (event?.type === 'assistant/message') {
      const turnId = event.data?.turn;
      if (!Number.isSafeInteger(turnId)) continue;
      const text = textFromContent(event.data?.message?.content);
      if (!text) continue;
      const step = Number.isSafeInteger(event.data.step) ? event.data.step : 0;
      const steps = canonical.get(turnId) ?? new Map();
      steps.set(step, { text, interrupted: event.data.interrupted === true });
      canonical.set(turnId, steps);
    }
  }

  function turnText(turnId) {
    const steps = canonical.get(turnId);
    const chunks = chunkParts.get(turnId);
    const stepNumbers = new Set([...(steps?.keys() ?? []), ...(chunks?.keys() ?? [])]);
    return [...stepNumbers]
      .sort((left, right) => left - right)
      .map((step) => {
        const message = steps?.get(step);
        if (message) return message.text;
        return [...(chunks?.get(step)?.entries() ?? [])]
          .sort(([left], [right]) => left - right)
          .map(([, part]) => part)
          .join('\n')
          .trim();
      })
      .filter(Boolean)
      .join('\n\n');
  }

  function interruptedFinal(turnId) {
    const steps = canonical.get(turnId);
    if (!steps || steps.size === 0) return false;
    const lastStep = [...steps.keys()].sort((left, right) => left - right).at(-1);
    return steps.get(lastStep).interrupted === true;
  }

  function scan(matchTurn, acceptAnyTerminal = false) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== 'turn/end' || !Number.isSafeInteger(event.data?.turn)) continue;
      if (matchTurn !== null && event.data.turn !== matchTurn) continue;
      const raw = event.data?.reason;
      const reason = typeof raw === 'string' ? raw : typeof raw?.kind === 'string' ? raw.kind : null;
      const hasAnswer = reason === 'completed' && !interruptedFinal(event.data.turn);
      const text = hasAnswer ? turnText(event.data.turn) : null;
      if (hasAnswer && text) {
        return { found: true, turn: event.data.turn, text, reason, endSeq: event.seq ?? -1 };
      }
      if (matchTurn !== null || acceptAnyTerminal) {
        return { found: false, turn: event.data.turn, text: null, reason, endSeq: event.seq ?? -1 };
      }
    }
    return null;
  }

  const completed = scan(wantTurn);
  if (completed) return completed;
  const anyTerminal = scan(wantTurn, true);
  if (anyTerminal) return anyTerminal;
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
      key, chatId, replyToMessageId = null, sessionId, turn = null, afterSeq = -1, promptRpcId = null,
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
        promptRpcId,
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
