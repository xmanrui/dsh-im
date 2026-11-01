// Memory extraction: turn one inbound message into the facts worth keeping.
//
// No model call. The read path of a memory system must be cheap and certain, and
// the write path should be too: a group message that says "我昨天买了台咖啡机" is
// a fact whether or not an LLM agrees, and running one per message would make
// the bot answer slower and its memory nondeterministic. The rules below cover
// the shapes that actually carry durable information in Chinese chat:
// self-description, preferences, plans, and explicit "记住" instructions.
//
// Everything unmatched yields nothing. That is the important half of the
// contract: a memory system that guesses teaches the bot things nobody said,
// and a wrong memory is worse than no memory because it is repeated with
// confidence. The patterns are therefore anchored (我/俺 + a verb) rather than
// fuzzy, and each one captures a bounded span.

/** Kinds a fact may have; the memory store groups and renders them by this. */
export const MEMORY_KINDS = Object.freeze(['identity', 'preference', 'dislike', 'plan', 'note']);

/** Longest captured object, so one rambling message cannot become a paragraph. */
const CAPTURE_MAX = 40;

/**
 * One extraction rule: a labelled pattern and the kind of fact it yields.
 *
 * `capture` is the pattern group that becomes the object. Rules are tried in
 * order and the first match per kind wins, so a message cannot produce two
 * identity facts from the same sentence.
 */
const RULES = Object.freeze([
  // "记住 X" is an explicit instruction and outranks every inference below.
  { kind: 'note', label: 'explicit', pattern: /(?:^|[，,。\s])(?:请)?记住[：:，,]?\s*([^。！？!?\n]{2,40})/u },
  // Self-description: name, job, location. Stored as identity.
  { kind: 'identity', label: 'name', pattern: /我(?:叫|是|的名字(?:是|叫))\s*([^，,。！？!?\s]{1,20})/u },
  { kind: 'identity', label: 'work', pattern: /我在\s*([^，,。！？!?\s]{2,20}?)(?:工作|上班|读书|上学)/u },
  { kind: 'identity', label: 'home', pattern: /我(?:住在|家在|来自)\s*([^，,。！？!?\s]{2,20})/u },
  { kind: 'preference', label: 'like', pattern: /我(?:很|超|最|挺)?(?:喜欢|爱|偏好|中意)\s*([^。！？!?\n]{2,40})/u },
  { kind: 'dislike', label: 'dislike', pattern: /我(?:很|超|最|挺)?(?:讨厌|不喜欢|受不了|烦)\s*([^。！？!?\n]{2,40})/u },
  { kind: 'plan', label: 'plan', pattern: /我(?:们)?\s*(?:要|准备|打算|计划|想)\s*([^。！？!?\n]{2,40})/u },
]);

/** Trim one captured span and drop the trailing particles chat text leaves. */
function tidy(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\s，,。.!！?？~～]+$/u, '').trim().slice(0, CAPTURE_MAX);
}

/**
 * Extract the durable facts one message states about its sender.
 *
 * @param text - the raw inbound text, already stripped of the trigger mention.
 * @param options.speaker - display name of whoever sent it, when known.
 * @returns an array of `{ kind, label, object, speaker }`; empty when the
 *   message states nothing durable, which is the common case in a group.
 */
export function extractMemoryCandidates(text, { speaker = '' } = {}) {
  if (typeof text !== 'string' || !text.trim()) return [];
  // Commands are instructions to the bot, not statements about the sender.
  const body = text.trim().replace(/^\/\S+\s*/u, '');
  if (!body) return [];
  const candidates = [];
  const usedKinds = new Set();
  for (const rule of RULES) {
    // One fact per kind per message: the first sentence that states it wins.
    if (usedKinds.has(rule.kind) && rule.kind !== 'note') continue;
    const match = rule.pattern.exec(body);
    if (!match) continue;
    const object = tidy(match[1]);
    if (!object || object.length < 2) continue;
    usedKinds.add(rule.kind);
    candidates.push({ kind: rule.kind, label: rule.label, object, speaker: speaker || '' });
  }
  return candidates;
}

/**
 * Render one extracted candidate into the sentence the store keeps.
 *
 * Speaker-attributed on purpose: in a group, "喜欢咖啡" means nothing without
 * whose preference it is, and the store keeps one row per (scope, subject,
 * predicate) so the attribution is what makes the row unique.
 *
 * @param candidate - one entry from `extractMemoryCandidates`.
 * @returns the stored object text.
 */
export function renderCandidate(candidate) {
  const object = tidy(candidate?.object);
  if (!object) return '';
  const speaker = typeof candidate?.speaker === 'string' ? candidate.speaker.trim() : '';
  return speaker ? `${speaker}：${object}` : object;
}
