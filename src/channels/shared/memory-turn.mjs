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

import {
  extractForgetTarget,
  extractMemoryCandidates,
  isNamedSpeaker,
  renderCandidate,
} from './memory-extract.mjs';
import { renderMemoryBlock } from './memory-store.mjs';

/** Fact predicate used for every extracted statement. */
const FACT_PREDICATE = 'statement';

/** Longest object fragment folded into an unattributed fact's key. */
const LORE_KEY_MAX = 60;

/**
 * The storage key one extracted fact is written under.
 *
 * A named speaker is the subject, so a later statement by the same person of the
 * same kind retires the earlier one: if 小李 says he likes tea after saying he
 * likes coffee, the coffee row is wrong and must stop being recalled.
 *
 * An unnamed speaker gets no such correction, because there is nobody to correct.
 * The object therefore joins the key: two different group members liking two
 * different things are two facts, and folding them onto one key would make each
 * new statement silently delete the last -- the exact opposite of memory.
 *
 * @param candidate - one entry from `extractMemoryCandidates`.
 * @returns `{ subject, predicate }` for `MemoryStore.remember`.
 */
export function memoryKeyFor(candidate) {
  if (isNamedSpeaker(candidate?.speaker)) {
    return {
      subject: candidate.speaker.trim(),
      predicate: FACT_PREDICATE + ':' + candidate.label,
    };
  }
  const object = String(candidate?.object ?? '').trim().replace(/\s+/gu, '').slice(0, LORE_KEY_MAX);
  return {
    subject: 'conversation',
    predicate: FACT_PREDICATE + ':' + candidate.label + ':' + object,
  };
}

/** How many recalled facts one prompt may carry. */
const RECALL_LIMIT = 8;

/** Bounded wait for a recall; past this the answer goes out without memory. */
const RECALL_TIMEOUT_MS = 400;

/**
 * How the recalled facts are meant to be used.
 *
 * A block of remembered facts with no instruction is read as a checklist to be
 * recited: the bot announces "我记得你喜欢手冲咖啡" and sounds like a database.
 * A person simply talks differently because they remember. This one sentence
 * moves the facts from subject matter to context, and it says nothing when there
 * is nothing to remember.
 */
const MEMORY_USAGE_NOTE = '这些是你还记得的事。像群里的人一样自然地用：需要时提一句，别念清单，也别主动说「我记得」或者复述上面的原话。';

/**
 * Build the memory scope for one conversation.
 *
 * @param channel - channel key, e.g. `weixin`.
 * @param botId - the bot account.
 * @param conversationKey - the channel's own conversation identity.
 * @returns a scope string the store accepts, or null when any part is unusable.
 */
/**
 * Encode one scope part so the joined result is injective.
 *
 * The naive version replaced every disallowed character with `_`, which is not
 * injective: `group:x:y` and `group:x_y` both became `group_x_y` and therefore
 * shared ONE memory scope -- two different conversations reading each other's
 * facts. Measured: a group id and a user id that differed only by `:` versus `_`
 * collided.
 *
 * `_` is the escape character, so it must be doubled first; then anything outside
 * the store's allowed set becomes `_` plus its code point in hex. Every output
 * character stays inside `[A-Za-z0-9_.:-]`, and the mapping is reversible.
 *
 * @param part - one already-trimmed scope component.
 * @returns the encoded component.
 */
function encodeScopePart(part) {
  return part.replaceAll('_', '__').replace(/[^A-Za-z0-9_.-]/gu, (character) => (
    '_' + character.codePointAt(0).toString(16).padStart(2, '0')
  ));
}

export function memoryScope({ channel, botId, conversationKey } = {}) {
  const parts = [channel, botId, conversationKey];
  if (parts.some((part) => typeof part !== 'string' || !part.trim())) return null;
  // The store allows [A-Za-z0-9_:.-]{1,256}; the encoder keeps every character
  // inside that set while staying reversible, so two different conversations can
  // never land on one scope.
  const scope = parts.map((part) => encodeScopePart(part.trim())).join(':');
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
    // A "forget this" instruction is handled before anything is written, so the
    // message can never also be read as a new fact about the same subject
    // ("忘掉咖啡" names a subject, not a preference).
    const forget = extractForgetTarget(text);
    if (forget) return -(await forgetMatching(store, { scope, target: forget, logger }));
    const candidates = extractMemoryCandidates(text, { speaker });
    for (const candidate of candidates) {
      const object = renderCandidate(candidate);
      if (!object) continue;
      // Attributed facts supersede per person; unattributed ones are group lore
      // keyed by their own content (see memoryKeyFor).
      const { subject, predicate } = memoryKeyFor(candidate);
      await store.remember({
        scope, subject, predicate, object,
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
 * Delete every fact in one scope that mentions a phrase.
 *
 * Matching is literal and scoped: the person said "忘掉咖啡", so the rows that
 * contain 咖啡 go and everything else stays. Another conversation's memory is
 * unreachable from here because the scope never crosses.
 *
 * Recall proposes the candidates (the same index the answer uses, so "what the
 * bot would have said" and "what gets deleted" cannot drift apart) and an exact
 * containment check decides: recall is fuzzy on purpose, deletion must not be.
 *
 * @param store - the memory store.
 * @param options.scope - the conversation scope.
 * @param options.target - the phrase to erase.
 * @param options.logger - where a failed delete is reported.
 * @returns how many facts were removed.
 */
export async function forgetMatching(store, { scope, target, logger = console } = {}) {
  // No length floor: in Chinese a single character IS a target ("忘掉茶"), and the
  // old two-character floor turned the most natural request into a silent no-op --
  // measured, the fact stayed in the store. Safety comes from the exact-containment
  // check below, not from the length of what the person asked to erase.
  if (!store || !scope || typeof target !== 'string' || target.trim().length < 1) return 0;
  let removed = 0;
  try {
    const facts = await store.recall({ scope, query: target, limit: 50 });
    for (const fact of facts) {
      const haystack = `${fact.object} ${fact.subject} ${fact.predicate}`;
      if (!haystack.includes(target)) continue;
      await store.forget(scope, fact.id);
      removed += 1;
    }
  } catch (error) {
    logger.warn?.('[dsh-im] memory forget failed:', error?.message ?? error);
    return 0;
  }
  return removed;
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
    if (typeof block !== 'string' || !block.trim()) return '';
    // The instruction rides in the same injected block as the facts it governs,
    // so a model that reads the memory also reads what to do with it.
    return block + '\n\n' + MEMORY_USAGE_NOTE;
  } catch (error) {
    logger.warn?.('[dsh-im] memory recall failed:', error?.message ?? error);
    return '';
  } finally {
    // Always cleared, so a fast recall does not leave a timer holding the
    // process open (node --test would otherwise hang for the full timeout).
    if (timer) clearTimeout(timer);
  }
}
