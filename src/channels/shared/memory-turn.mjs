// Inbound memory: record what a message stated, and recall what is worth saying.
//
// The two halves run at different moments and must never block each other.
// `recordInboundMemory` runs after a message is accepted (fire and forget; a
// failed write costs one memory, never the reply). `recallMemoryBlock` runs
// before the prompt is assembled, where it must answer quickly or not at all --
// a group message is answered in seconds, so a slow disk read is worse than a
// smaller memory.
//
// Scope is the conversation, not the process: two groups on the same account
// share a bot but must never share facts. The scope string is therefore built
// from the channel, the bot and the conversation key, in the same shape the
// memory store validates.

import { extractMemoryCandidates, renderCandidate } from './memory-extract.mjs';
import { renderMemoryBlock } from './memory-store.mjs';

/** Fact predicate used for every extracted statement. */
const FACT_PREDICATE = 'statement';

/** How many recalled facts one prompt may carry. */
const RECALL_LIMIT = 8;

/** Bounded wait for a recall; past this the answer goes out without memory. */
const RECALL_TIMEOUT_MS = 400;

/**
 * Build the memory scope for one conversation.
 *
 * @param channel - channel key, e.g. `weixin`.
 * @param botId - the bot account.
 * @param conversationKey - the channel's own conversation identity.
 * @returns a scope string the store accepts, or null when any part is unusable.
 */
export function memoryScope({ channel, botId, conversationKey } = {}) {
  const parts = [channel, botId, conversationKey];
  if (parts.some((part) => typeof part !== 'string' || !part.trim())) return null;
  // The store allows [A-Za-z0-9_:.-]{1,256}; a channel key can carry characters
  // outside that set, so anything else is replaced rather than rejected.
  const scope = parts.map((part) => part.trim().replace(/[^A-Za-z0-9_.-]/g, '_')).join(':');
  return scope.length <= 256 ? scope : null;
}

/**
 * Record every durable statement one inbound message made.
 *
 * Never throws: the caller is a message handler, and losing a memory is
 * acceptable where losing the message is not.
 *
 * @param store - a `MemoryStore`, or null when memory is off.
 * @param options.scope - the conversation scope.
 * @param options.text - the inbound text with the trigger mention removed.
 * @param options.speaker - display name of the sender, when known.
 * @param options.messageId - source message id, kept for audit and revocation.
 * @param options.logger - where a failed write is reported.
 * @returns how many facts were stored.
 */
export async function recordInboundMemory(store, {
  scope, text, speaker = '', messageId = null, logger = console,
} = {}) {
  if (!store || !scope) return 0;
  let written = 0;
  try {
    const candidates = extractMemoryCandidates(text, { speaker });
    for (const candidate of candidates) {
      const object = renderCandidate(candidate);
      if (!object) continue;
      // The subject is the speaker, so "小李喜欢咖啡" and "老王喜欢咖啡" are two
      // rows that supersede independently; the predicate names the fact shape.
      await store.remember({
        scope,
        subject: candidate.speaker || 'conversation',
        predicate: `${FACT_PREDICATE}:${candidate.label}`,
        object,
        sourceMessageId: messageId,
      });
      written += 1;
    }
  } catch (error) {
    logger.warn?.('[dsh-im] memory write failed:', error?.message ?? error);
  }
  return written;
}

/**
 * Recall and render the memory block for one prompt.
 *
 * Answers '' rather than throwing or waiting: memory is an enhancement, and an
 * enhancement that can stall a reply is a regression. The timeout is enforced
 * here rather than inside the store so a slow disk (or a locked database) is
 * contained at the caller, where its cost is already bounded by the reply path.
 *
 * @param store - a `MemoryStore`, or null when memory is off.
 * @param options.scope - the conversation scope.
 * @param options.query - the current message, used as the keyword source.
 * @param options.logger - where a failed read is reported.
 * @returns the rendered block, or an empty string.
 */
export async function recallMemoryBlock(store, { scope, query = '', logger = console } = {}) {
  if (!store || !scope) return '';
  let timer;
  try {
    const work = (async () => {
      const [facts, slots] = await Promise.all([
        store.recall({ scope, query, limit: RECALL_LIMIT }),
        store.slots(scope),
      ]);
      return renderMemoryBlock(facts, slots);
    })();
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(''), RECALL_TIMEOUT_MS);
    });
    const block = await Promise.race([work, timeout]);
    return typeof block === 'string' ? block : '';
  } catch (error) {
    logger.warn?.('[dsh-im] memory recall failed:', error?.message ?? error);
    return '';
  } finally {
    // Always cleared, so a fast recall does not leave a timer holding the
    // process open (node --test would otherwise hang for the full timeout).
    if (timer) clearTimeout(timer);
  }
}
