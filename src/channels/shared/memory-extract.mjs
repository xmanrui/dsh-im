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
export const MEMORY_KINDS = Object.freeze([
  'identity', 'preference', 'dislike', 'plan', 'note', 'possession', 'activity',
]);

/** Longest captured object, so one rambling message cannot become a paragraph. */
const CAPTURE_MAX = 40;

/**
 * One extraction rule: a labelled pattern and the kind of fact it yields.
 *
 * `capture` is the pattern group that becomes the object. Rules are tried in
 * order and the first match per kind wins, so a message cannot produce two
 * identity facts from the same sentence.
 */
// One character IS a complete object in Chinese: 茶, 猫, 冷 are all things a
// person states about themselves ("我喜欢茶"). The capture minimum was two, which
// silently dropped exactly those -- measured: 我喜欢茶, 我养猫 and 我怕冷 all
// produced nothing. The verb is what makes a statement a fact; its object needs
// no minimum length.
const RULES = Object.freeze([
  // "记住 X" is an explicit instruction and outranks every inference below.
  { kind: 'note', label: 'explicit', pattern: /(?:^|[，,。\s])(?:请)?记住[：:，,]?\s*([^。！？!?\n]{1,40})/u },
  // Self-description: name, job, location. Stored as identity.
  { kind: 'identity', label: 'name', pattern: /我(?:叫|是|的名字(?:是|叫))\s*([^，,。！？!?\s]{1,20})/u },
  { kind: 'identity', label: 'work', pattern: /我在\s*([^，,。！？!?\s]{1,20}?)(?:工作|上班|读书|上学)/u },
  { kind: 'identity', label: 'home', pattern: /我(?:住在|家在|来自)\s*([^，,。！？!?\s]{1,20})/u },
  { kind: 'preference', label: 'like', pattern: /我(?:很|超|最|挺)?(?:喜欢|爱|偏好|中意)\s*([^。！？!?\n]{1,40})/u },
  { kind: 'dislike', label: 'dislike', pattern: /我(?:很|超|最|挺)?(?:讨厌|不喜欢|受不了|烦)\s*([^。！？!?\n]{1,40})/u },
  { kind: 'plan', label: 'plan', pattern: /我(?:们)?\s*(?:要|准备|打算|计划|想)\s*([^。！？!?\n]{1,40})/u },
  // What somebody has, and what they are up to lately. These are the things a
  // group actually remembers about each other ("老王养了只猫"), and both stay
  // anchored on 我 so an offhand remark about the weather never becomes a fact
  // about a member. A measure word is optional but a verb is not: bare 我有
  // captures nothing on its own.
  // `养` in every form a person uses it: 养 / 养了 / 养着, with an optional
  // measure word (一只 / 几盆) before the object.
  // An aspect particle must stay with its verb, or "我养了" would capture 了 as the
  // object. The verb therefore requires an object after any 了/着, and a bare 养
  // only counts when something follows it.
  { kind: 'possession', label: 'has', pattern: /我(?:养(?:了|着)?|有)(?:[一几]?[只条个台辆棵盆])?\s*([^。！？!?\n了着]{1,40})/u },
  { kind: 'activity', label: 'doing', pattern: /我(?:最近一直在|最近在|近来在|这阵子在|现在在|最近)\s*([^。！？!?\n]{1,40})/u },
]);

/** Link and path patterns that carry no memory value and would be quoted back. */
const LINK_PATTERN = /(?:https?:\/\/|www\.)\S+|[A-Za-z]:\\\S+|\\\\\S+/gu;

/**
 * Remove links and file paths before looking for facts.
 *
 * A remembered fact gets quoted back into the prompt, so an address inside it
 * becomes noise the bot may repeat: "群里有人喜欢看 https://a.com 的教程" is not a
 * thing anybody wants remembered. The rest of the sentence still reads, because
 * only the address is removed -- "我喜欢看教程" survives.
 *
 * @param text - one inbound message.
 * @returns the message with addresses and paths replaced by a space.
 */
function stripLinks(text) {
  return text.replace(LINK_PATTERN, ' ').replace(/\s{2,}/gu, ' ').trim();
}

/** Trim one captured span and drop the trailing particles chat text leaves. */
function tidy(value) {
  if (typeof value !== 'string') return '';
  return value
    // A removed address leaves a gap; collapse the doubled spaces it creates and
    // drop the dangling particles that end up next to one ("看 的教程" -> "看的教程").
    .replace(/\s{2,}/gu, ' ')
    .replace(/[\s]+(的|了|在|和)/gu, '$1')
    .replace(/[\s，,。.!！?？~～]+$/u, '')
    .trim()
    .slice(0, CAPTURE_MAX);
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
  const raw = text.trim();
  // A command is an instruction to the bot, not a statement about the sender --
  // and its ARGUMENTS are part of the instruction. `/steer 我喜欢咖啡` is the
  // operator telling the bot what to say, so remembering "the group likes coffee"
  // from it is inventing a fact out of somebody's command (measured: it did).
  if (raw.startsWith('/')) return [];
  const body = stripLinks(raw);
  if (!body) return [];
  const candidates = [];
  const usedKinds = new Set();
  for (const rule of RULES) {
    // One fact per kind per message: the first sentence that states it wins.
    if (usedKinds.has(rule.kind) && rule.kind !== 'note') continue;
    const match = rule.pattern.exec(body);
    if (!match) continue;
    const object = tidy(match[1]);
    // No length floor: see the note above RULES.
    if (!object) continue;
    // An explicit "记住 X" captures the whole instruction, so nothing else is
    // inferred from the same message: the note already says what to remember,
    // and re-reading it for a possession ("我有例会") would store half of it as a
    // separate, worse fact. The operator said what to keep; believe them.
    if (rule.kind === 'note') {
      usedKinds.add('note');
      candidates.push({ kind: 'note', label: rule.label, object, speaker: speaker || '' });
      break;
    }
    usedKinds.add(rule.kind);
    candidates.push({ kind: rule.kind, label: rule.label, object, speaker: speaker || '' });
  }
  return candidates;
}

/**
 * The sender id the WeChat adapter uses when a row exposed no identity.
 *
 * Measured on this build: every group row arrives as `uia-unverified:row`,
 * because the author line is a separate UIA control this reading path cannot
 * pair with the text row. It is a platform placeholder, never a person.
 */
export const UNVERIFIED_SPEAKER_PREFIX = 'uia-unverified:';

/**
 * Decide whether a speaker string names somebody worth remembering.
 *
 * The distinction is not cosmetic. A placeholder stored as a subject turns every
 * remembered fact into "uia-unverified:row：喜欢咖啡", which is useless to the
 * model and leaks a machine identity into the prompt. An unattributed statement
 * is still worth keeping as group lore: the bot should know the group likes
 * coffee even when it cannot say who said so.
 *
 * @param speaker - a display name, an id, or nothing.
 * @returns whether the speaker may be used as a subject.
 */
export function isNamedSpeaker(speaker) {
  if (typeof speaker !== 'string') return false;
  const value = speaker.trim();
  if (!value) return false;
  return !value.startsWith(UNVERIFIED_SPEAKER_PREFIX);
}

/**
 * One unattributed statement, phrased the way a person would repeat it.
 *
 * `label` names the sentence shape the rule matched, so the retelling stays
 * grammatical: "有人自称小李" reads, "小李" on its own does not.
 */
const LORE_PHRASES = Object.freeze({
  name: (object) => `有人自称${object}`,
  work: (object) => `有人说自己在${object}`,
  home: (object) => `有人说自己来自${object}`,
  like: (object) => `群里有人喜欢${object}`,
  dislike: (object) => `群里有人不喜欢${object}`,
  plan: (object) => `有人说要${object}`,
  has: (object) => `群里有人有${object}`,
  doing: (object) => `群里有人最近在${object}`,
  explicit: (object) => `有人让你记住：${object}`,
});

/**
 * Render one extracted candidate into the sentence the store keeps.
 *
 * A named speaker prefixes their own name. An unnamed one becomes group lore in
 * the third person -- the fact must be readable on its own, because the memory
 * block renders the stored object and nothing else.
 *
 * @param candidate - one entry from `extractMemoryCandidates`.
 * @returns the stored object text.
 */
export function renderCandidate(candidate) {
  const object = tidy(candidate?.object);
  if (!object) return '';
  const speaker = typeof candidate?.speaker === 'string' ? candidate.speaker.trim() : '';
  if (isNamedSpeaker(speaker)) return `${speaker}：${object}`;
  const phrase = LORE_PHRASES[candidate?.label];
  // An unmatched label still says something true rather than mislabelling it.
  return phrase ? phrase(object) : `群里有人提到${object}`;
}

/**
 * Shapes that mean "forget this", and what they ask to forget.
 *
 * A memory system people cannot correct is a memory system they stop trusting:
 * the moment the bot repeats something wrong, the only repair is to tell it so.
 * The grammar is deliberately narrow -- 忘掉 / 忘记 / 别记 / 不用记 + a target --
 * because the failure mode of guessing here is deleting something the person
 * wanted kept, which is worse than forgetting to forget.
 */
const FORGET_PATTERNS = Object.freeze([
  // 忘掉 X / 忘记 X / 别记着 X / 不用记住 X
  /(?:忘掉|忘记|忘了|别记着|别记|不用记(?:住)?|不要再记(?:住)?)(?:关于)?\s*([^。！？!?\n]{1,40})/u,
]);

/**
 * Read a "forget this" instruction out of one message.
 *
 * @param text - the inbound text with the trigger mention removed.
 * @returns the target phrase to forget, or null when this is not such a message.
 */
export function extractForgetTarget(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const body = text.trim().replace(/^\/\S+\s*/u, '');
  for (const pattern of FORGET_PATTERNS) {
    const match = pattern.exec(body);
    if (!match) continue;
    const target = tidy(match[1]);
    // A single character is a real target in Chinese -- "忘掉茶" names 茶, and the
    // old floor of two silently turned the most natural request into a no-op
    // (measured: the fact stayed in the store). What makes a target dangerous is
    // not its length but its reach, and `forgetMatching` already requires exact
    // containment inside one scope, so a broad target can only remove rows that
    // literally contain it.
    if (target.length < 1) continue;
    return target;
  }
  return null;
}
