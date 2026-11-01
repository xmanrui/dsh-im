// Humanize: turn one finished answer into the way a person would actually send
// it -- typed at human speed, split into message-sized pieces, with the most
// obvious machine phrasing removed.
//
// Everything here is deterministic and local: no model call, no randomness that
// cannot be replayed from an injected source. The numbers come from open-source
// projects that solved this before us (human_reply_speed: 3 Chinese characters
// per second, +-20%, clamped 0.3s..12s; WAHA presence: typing jitter 0.7..1.3,
// a 30% chance of an extra pause). They are defaults, not laws: a channel may
// override any of them.
//
// The splitter is deliberately conservative. A group chat punishes a bot that
// fires five messages at once far harder than it punishes one long message, so
// segments are capped, and text that is clearly structured (code, lists,
// headings, quotes) is never split -- those are read as documents, not as
// chatter, and chopping them destroys meaning.

import { t } from './i18n.mjs';

/** Chinese typing speed used for the delay, characters per second. */
export const TYPING_CHARS_PER_SECOND = 3;
/** Fractional jitter applied to the delay, so identical replies never pace identically. */
export const TYPING_JITTER = 0.2;
/** Never type for less than this: an instant reply reads as a machine. */
export const TYPING_MIN_MS = 300;
/** ...nor longer than this: past twelve seconds the wait is a bug, not a tell. */
export const TYPING_MAX_MS = 12_000;
/** A reaction this short is sent at once; nobody watches a three-word typing bubble. */
export const TYPING_SKIP_UNDER_CHARS = 4;
/** Extra pause charged per sentence-ending mark. */
export const TYPING_PUNCTUATION_MS = 50;

/** Most segments one answer may become. Beyond three the bot is a spammer. */
export const MAX_SEGMENTS = 3;
/** A segment shorter than this is glued to its neighbour rather than sent alone. */
export const MIN_SEGMENT_CHARS = 6;
/** A paragraph longer than this is broken on sentence ends. */
export const MAX_SEGMENT_CHARS = 120;
/** Below this many characters the whole answer is one bubble: it is a reaction. */
export const SPLIT_SKIP_UNDER_CHARS = 24;

/**
 * Machine phrasings that survive into chat text and give the bot away.
 *
 * Each entry is [pattern, replacement]. The replacements are Chinese, matching
 * the primary deployment. Order matters: the report-style openers run first so a
 * sentence cannot be rewritten twice.
 */
const MACHINE_PHRASES = Object.freeze([
  [/^作为(?:一个)?(?:AI|人工智能|语言模型|智能助手)[，,]?\s*/u, ''],
  [/(?:希望|以上)(?:这些)?(?:内容|信息|回答)?(?:能|对您|对你)(?:有所帮助|有帮助)[。.!！]?/gu, ''],
  // An enumeration opener is narration, not content: a person does not say
  // "firstly" before a single sentence. Connective words with a lighter form
  // (总而言之/综上) are handled by the replacement rules below instead, so they
  // survive as 总之 rather than disappearing.
  // The separator after the opener is optional: "作为一个AI，首先我要说" has no
  // comma once the AI disclaimer in front of it is gone. `是` belongs to the
  // opener too -- stripping only "其次" leaves "是水温…", which is worse than
  // leaving the opener in place.
  [/^\s*(?:首先|其次|再次|最后|另外一点)(?:[，,：:]|是)?\s*/gmu, ''],
  [/总而言之/g, '总之'],
  [/值(?:得|得)注意的是/g, '另外'],
  [/需要注意的是/g, '另外'],
  [/非常(?:重要|关键)的是/g, '关键是'],
  [/(?:请问)?(?:还|另外)?有(?:什么|其它|其他)(?:可以|需要)(?:帮|为)(?:您|你)(?:的)?吗[？?]?/gu, ''],
  [/如果(?:您|你)还有(?:任何)?(?:其他|其它)?(?:问题|疑问)[，,]?(?:随时|欢迎)[^。！？!?]*[。！？!?]?/gu, ''],
  [/我(?:很|非常)?(?:乐意|高兴)(?:为您|为你)(?:提供)?(?:帮助|解答)[。！!]?/gu, ''],
  [/以下是(?:关于)?[^：:。\n]*[：:]\s*/gu, ''],
]);

/**
 * Things that look like machine phrasing but are the character speaking.
 *
 * Kept as an explicit exemption list because the failure mode of style cleanup
 * is symmetric: over-cleaning turns a written character into a bland assistant,
 * which is the exact outcome this module exists to prevent. A line matching any
 * of these is left alone, including any surrounding ellipsis or stutter.
 */
const KEEP_PATTERNS = Object.freeze([
  /\.{3,}|。{3,}|…/u,
  /(.)\1{2,}/u,
  /^(?:哈|呵|嘿|哎|唉|哦|噢|呃|嗯)/u,
]);

/**
 * A short random token for this call's placeholders.
 *
 * The placeholders must be unguessable by the text being flattened, otherwise a
 * message that happens to contain the placeholder text collides with a real one
 * and restores to the wrong value (measured: a literal NUL CODE 5 NUL restored as
 * `undefined`). Falls back to a counter when no crypto is available.
 */
let placeholderCounter = 0;
function randomToken() {
  const uuid = globalThis.crypto?.randomUUID;
  if (typeof uuid === 'function') return uuid.call(globalThis.crypto).replaceAll('-', '').slice(0, 12);
  placeholderCounter += 1;
  return `p${placeholderCounter.toString(36)}`;
}

/**
 * The largest index <= `limit` that does not split a surrogate pair.
 *
 * `String.prototype.slice` counts UTF-16 units, so a limit that lands on the
 * high half of an emoji tears it in two. Backing off by one keeps every code
 * point whole, which is what the receiving chat client actually renders.
 *
 * @param text - the string being cut.
 * @param limit - the desired maximum length in UTF-16 units.
 * @returns an index safe to slice at, never below 1 for non-empty text.
 */
function codePointSafeCut(text, limit) {
  if (limit >= text.length) return text.length;
  if (limit <= 0) return 0;
  // A high surrogate as the LAST kept unit means the pair would be broken.
  const last = text.charCodeAt(limit - 1);
  const next = text.charCodeAt(limit);
  const lastIsHigh = last >= 0xd800 && last <= 0xdbff;
  const nextIsLow = next >= 0xdc00 && next <= 0xdfff;
  return lastIsHigh && nextIsLow ? limit - 1 : limit;
}

/** Structures that must never be chopped into chat-sized pieces. */
function looksStructured(text) {
  return /```/u.test(text)
    || /^\s{0,3}(?:[-*+]|\d+[.)])\s+/mu.test(text)
    || /^\s{0,3}#{1,6}\s+/mu.test(text)
    || /^\s*>/mu.test(text)
    || /\|.*\|/u.test(text)
    || /^\s{2,}\S/mu.test(text);
}

/**
 * Rewrite the machine-sounding parts of one finished answer.
 *
 * @param text - the answer exactly as the model produced it.
 * @returns the text with machine phrasing removed and whitespace tidied.
 */
export function stripMachinePhrases(text) {
  if (typeof text !== 'string' || !text) return '';
  let out = text;
  for (const [pattern, replacement] of MACHINE_PHRASES) {
    // A line the character obviously wrote itself is not rewritten.
    out = out.split('\n').map((line) => (
      KEEP_PATTERNS.some((keep) => keep.test(line))
        ? line
        : line.replace(pattern, replacement)
    )).join('\n');
  }
  // Rewriting leaves doubled blank lines and trailing spaces behind.
  return out
    .replace(/[ \t]+$/gmu, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Split one answer into the messages a person would send instead of one wall.
 *
 * Paragraphs are packed in order until they reach the target size, so a reply
 * written as three short paragraphs becomes at most `MAX_SEGMENTS` bubbles, and a
 * single long paragraph is broken on sentence boundaries. Structured text is
 * returned as one segment: see `looksStructured`.
 *
 * @param text - the answer to split.
 * @param options.maxSegments - cap, defaulting to `MAX_SEGMENTS`.
 * @returns an array of segments; always at least one entry for non-empty input.
 */
export function splitReply(text, { maxSegments = MAX_SEGMENTS, splitBelowChars = SPLIT_SKIP_UNDER_CHARS } = {}) {
  if (typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (!trimmed) return [];
  // One bubble is right for a short reaction and for anything structured.
  if (maxSegments <= 1 || trimmed.length < splitBelowChars || looksStructured(trimmed)) return [trimmed];

  // A paragraph is the unit the model itself used to separate ideas, so it is
  // the unit to send. Only a paragraph too long for one bubble is broken: on a
  // sentence end first (where a person pauses anyway), then on a hard cut.
  const units = [];
  for (const paragraph of trimmed.split(/\n{2,}/u)) {
    const block = paragraph.trim();
    if (!block) continue;
    if (block.length <= MAX_SEGMENT_CHARS) {
      units.push(block);
      continue;
    }
    const sentences = block.match(/[^。！？!?\n]+[。！？!?]?/gu) ?? [block];
    let chunk = '';
    for (const sentence of sentences) {
      // A single sentence longer than the ceiling still becomes its own unit;
      // the ceiling governs grouping, not correctness.
      if (chunk && (chunk + sentence).length > MAX_SEGMENT_CHARS) {
        units.push(chunk.trim());
        chunk = sentence;
      } else {
        chunk += sentence;
      }
      // A single sentence can itself exceed the ceiling -- a pasted log line, or
      // text with no sentence-ending punctuation at all. Cutting it here is the
      // only way the ceiling means anything; the alternative is one bubble far
      // past what the platform will accept, which fails at send time instead.
      //
      // The cut is taken on a code-point boundary: a naive slice at a raw index
      // can land between the two halves of a surrogate pair, and the resulting
      // lone surrogates render as replacement characters on the other side.
      while (chunk.length > MAX_SEGMENT_CHARS) {
        const cut = codePointSafeCut(chunk, MAX_SEGMENT_CHARS);
        units.push(chunk.slice(0, cut));
        chunk = chunk.slice(cut);
      }
    }
    if (chunk.trim()) units.push(chunk.trim());
  }
  if (units.length === 0) return [trimmed];

  // Over the cap: fold the shortest adjacent pair, repeatedly. Merging the
  // shortest first keeps the longest ideas intact and never drops text.
  let segments = units;
  while (segments.length > maxSegments) {
    let bestIndex = 0;
    let bestSize = Infinity;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const size = segments[index].length + segments[index + 1].length;
      if (size < bestSize) {
        bestSize = size;
        bestIndex = index;
      }
    }
    segments = [...segments.slice(0, bestIndex), `${segments[bestIndex]}\n${segments[bestIndex + 1]}`, ...segments.slice(bestIndex + 2)];
  }

  // A scrap below the floor is not worth its own bubble; glue it backwards.
  const merged = [];
  for (const segment of segments) {
    if (merged.length > 0 && segment.length < MIN_SEGMENT_CHARS) {
      merged[merged.length - 1] = `${merged.at(-1)}\n${segment}`;
    } else {
      merged.push(segment);
    }
  }
  return merged;
}

/**
 * How long a person would take to type this, in milliseconds.
 *
 * The count is of code points, not UTF-16 length, so an emoji or a CJK character
 * both cost one keystroke. `jitter` and `random` let a caller (a test, a replay)
 * pass deterministic values instead of rolling a die.
 *
 * Generation time already spent is subtracted: a model that took eight seconds
 * to produce the text has already "typed" most of it, and stacking a full
 * simulated delay on top would make the bot the slowest member of the group. An
 * answer that took longer than the estimate is sent as soon as it is ready.
 *
 * @param text - the text about to be sent.
 * @param options.charsPerSecond - typing speed.
 * @param options.jitter - 0.8..1.2 style multiplier; random when omitted.
 * @param options.random - [0,1) source, injectable for tests.
 * @param options.elapsedMs - wall time already spent producing this text.
 * @returns the delay in milliseconds, within 0..`TYPING_MAX_MS`.
 */
export function typingDelayMs(text, {
  charsPerSecond = TYPING_CHARS_PER_SECOND,
  jitter,
  random = Math.random,
  elapsedMs = 0,
} = {}) {
  if (typeof text !== 'string' || !text) return 0;
  // Whitespace is free: nobody "types" a newline at the cost of a character.
  const visible = [...text.replace(/\s+/gu, '')].length;
  if (visible < TYPING_SKIP_UNDER_CHARS) return 0;
  const punctuation = (text.match(/[，,。.！!？?；;：:、]/gu) ?? []).length;
  const multiplier = typeof jitter === 'number' && Number.isFinite(jitter)
    ? jitter
    : 1 - TYPING_JITTER + random() * TYPING_JITTER * 2;
  const base = (visible / Math.max(0.1, charsPerSecond)) * 1_000;
  const estimate = Math.min(TYPING_MAX_MS, base * multiplier + punctuation * TYPING_PUNCTUATION_MS);
  // The model already spent time; only the remainder is worth simulating.
  const already = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const remaining = estimate - already;
  // A remainder under the floor is dropped entirely rather than floored up:
  // once generation has eaten the delay, adding 300ms is pure latency.
  if (remaining < TYPING_MIN_MS) return 0;
  return Math.round(Math.min(TYPING_MAX_MS, remaining));
}

/** Base pause between two bubbles of the same answer, milliseconds. */
export const SEGMENT_GAP_MS = 700;
/** A same-answer gap is jittered this much around the base. */
export const SEGMENT_GAP_JITTER = 0.4;
/** A same-answer gap never falls below this or exceeds `SEGMENT_GAP_MAX_MS`. */
export const SEGMENT_GAP_MIN_MS = 350;
/** ...nor exceeds this. */
export const SEGMENT_GAP_MAX_MS = 2_000;
/** Total simulated waiting one answer may cost, across every bubble. */
export const PLAN_TOTAL_MAX_MS = 18_000;

/**
 * Pause before the next bubble of an answer already under way.
 *
 * Only the first bubble is worth a full typing estimate: after that the person
 * is demonstrably present, and re-typing every bubble at three characters per
 * second would turn a three-part answer into half a minute of dead air. A short
 * jittered gap is what actually happens in a chat.
 *
 * @param options.jitter - fixed multiplier, for tests.
 * @param options.random - [0,1) source, injectable for tests.
 * @returns the gap in milliseconds.
 */
export function segmentGapMs({ jitter, random = Math.random } = {}) {
  const multiplier = typeof jitter === 'number' && Number.isFinite(jitter)
    ? jitter
    : 1 - SEGMENT_GAP_JITTER + random() * SEGMENT_GAP_JITTER * 2;
  return Math.round(Math.min(SEGMENT_GAP_MAX_MS, Math.max(SEGMENT_GAP_MIN_MS, SEGMENT_GAP_MS * multiplier)));
}

/**
 * Plan one outbound answer: the segments to send and the pause before each.
 *
 * Pure: it reads nothing and sends nothing, so a bridge can compute the plan and
 * a test can assert it without a clock or a socket. The caller owns the waiting
 * and the abort handling.
 *
 * The whole plan is bounded by `PLAN_TOTAL_MAX_MS`. Waiting is the one place a
 * bot can be worse than instant: past roughly eighteen seconds the group has
 * moved on, so the leftover budget is redistributed rather than exceeded.
 *
 * @param text - the finished answer.
 * @param options - forwarded to `splitReply`, `typingDelayMs`, `segmentGapMs`.
 * @param options.elapsedMs - wall time already spent producing this answer.
 * @returns `{ segments: string[], delaysMs: number[] }`, index-aligned.
 */
/**
 * Plan one outbound answer: the segments to send and the pause before each.
 *
 * Pure: it reads nothing and sends nothing, so a bridge can compute the plan and
 * a test can assert it without a clock or a socket. The caller owns the waiting
 * and the abort handling.
 *
 * `options.structured` lets the caller say "the ORIGINAL was a list or a code
 * block" when it already had to flatten the text first: the flattened form no
 * longer looks structured, and splitting it would undo the very protection that
 * stopped it being split in the first place.
 *
 * @param text - the finished answer.
 * @param options - forwarded to `splitReply`, `typingDelayMs`, `segmentGapMs`.
 * @param options.elapsedMs - wall time already spent producing this answer.
 * @returns `{ segments: string[], delaysMs: number[] }`, index-aligned.
 */
export function planOutbound(text, options = {}) {
  const cleaned = stripMachinePhrases(text);
  const segments = options.structured === true
    ? (cleaned.trim() ? [cleaned.trim()] : [])
    : splitReply(cleaned, options);
  const delaysMs = segments.map((segment, index) => (index === 0
    ? typingDelayMs(segment, options)
    : segmentGapMs(options)));
  // Clamp the total, taking the excess off the longest wait first so pacing
  // stays proportional instead of being flattened to a single constant.
  let total = delaysMs.reduce((sum, value) => sum + value, 0);
  while (total > PLAN_TOTAL_MAX_MS) {
    let longest = 0;
    for (let index = 1; index < delaysMs.length; index += 1) {
      if (delaysMs[index] > delaysMs[longest]) longest = index;
    }
    const excess = total - PLAN_TOTAL_MAX_MS;
    const cut = Math.min(delaysMs[longest], excess);
    if (cut <= 0) break;
    delaysMs[longest] -= cut;
    total -= cut;
  }
  return { segments, delaysMs };
}

/** Localized one-line explanation of a plan, for diagnostics and logs. */
export function describeOutboundPlan(plan) {
  if (!plan || !Array.isArray(plan.segments)) return '';
  const segments = plan.segments.length;
  const total = plan.delaysMs.reduce((sum, value) => sum + value, 0);
  return t('{segments} 段，预计 {seconds} 秒发完', {
    segments,
    seconds: Math.round(total / 100) / 10,
  });
}


/**
 * Whether a target renders Markdown at all.
 *
 * WeChat does not: a `**bold**` arrives as literal asterisks, and a `- item`
 * arrives as a dash. Sending Markdown to a client that cannot render it is one of
 * the loudest machine tells -- it reads as a log dump pasted into a chat. Channels
 * that do render it keep their Markdown; this flag is the difference.
 */
export const PLAIN_TEXT_TARGETS_FALLBACK = true;

/**
 * Flatten the Markdown a chat client will not render into what a person would type.
 *
 * Deliberately conservative, like the splitter. Emphasis markers are dropped
 * because the words are the message; bullets become a middle dot because a real
 * person does enumerate things; headings become the bare line; links become
 * "text (url)" because a bare URL with brackets is unreadable. Code fences and
 * inline code are preserved verbatim -- someone pasted a command expects it to stay
 * copyable, and stripping backticks would make it wrong.
 *
 * @param text - the finished answer.
 * @returns the text a plain-text client should receive.
 */
/**
 * Flatten the Markdown a chat client will not render into what a person would type.
 *
 * Returns the flattened text plus whether the ORIGINAL was structured. The
 * caller needs that second half: flattening a bulleted list turns it into plain
 * lines, which then look like ordinary prose to `splitReply` and get chopped --
 * so the "never split a list" guarantee has to be decided on the input, not on
 * what is left after flattening.
 *
 * @param text - the finished answer.
 * @returns `{ text, structured }`.
 */
export function flattenMarkdownDetailed(text) {
  if (typeof text !== 'string' || !text) return { text: '', structured: false };
  // Decided on the INPUT: see the doc comment above.
  const structured = looksStructured(text);
  let out = text;
  // Fences first, so nothing inside them is rewritten by the rules below.
  //
  // The placeholder carries a NUL and a per-call random token: a plain
  // `\u0000CODE5\u0000` inside the message itself would collide with a real
  // placeholder index and then restore as `undefined`, corrupting the text.
  const token = randomToken();
  const fences = [];
  out = out.replace(/```[\s\S]*?```/gu, (block) => {
    fences.push(block);
    return `\u0000${token}F${fences.length - 1}\u0000`;
  });
  // Inline code is protected the same way: a command must stay copyable.
  const codes = [];
  out = out.replace(/`([^`\n]+)`/gu, (_match, code) => {
    codes.push(code);
    return `\u0000${token}C${codes.length - 1}\u0000`;
  });
  out = out
    // Images are DROPPED, not flattened.
    //
    // Measured in the live group: the bot sent `![第40帧](D:/dsh-im-robot/_v3_1.png)`
    // as text, and a reader saw a local Windows path. That is worse than sending
    // nothing -- it leaks the operator's filesystem into a group chat and tells
    // the reader to open a file they cannot reach. The image itself is delivered
    // by the artifact path, so the tag is pure noise.
    .replace(/!\[([^\]\n]*)\]\(([^)\s]*)\)/gu, '')
    // [text](url) -> text（url）: the address survives, the syntax does not.
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/gu, '$1（$2）')
    // Headings lose their hashes but keep the line.
    .replace(/^\s{0,3}#{1,6}\s+/gmu, '')
    // Bullets become a middle dot, the way people actually enumerate in chat.
    .replace(/^\s{0,3}[-*+]\s+/gmu, '· ')
    .replace(/^\s{0,3}(\d+)[.)]\s+/gmu, '$1. ')
    // Blockquote markers carry nothing once the line stands alone.
    .replace(/^\s{0,3}>\s?/gmu, '')
    // Horizontal rules are not something a person types.
    .replace(/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/gmu, '')
    // A star that stands alone between spaces is arithmetic or a glob, never
    // emphasis: `2 * 3 * 4` and `*.log` are the two shapes that showed up. They
    // are swapped for a sentinel before the emphasis rules and restored after,
    // because deleting them silently changes what the message says.
    .replace(/\s\*\s/gu, (match) => match.replace('*', '\u0000STAR\u0000'))
    .replace(/(^|[\s（(])\*(?=[.\w])/gu, (match, lead) => lead + '\u0000STAR\u0000')
    // Emphasis: strip the markers, keep the words. Bold before italic, so `***x***`
    // resolves to x rather than leaving a stray asterisk behind.
    .replace(/\*\*\*([^*\n]+)\*\*\*/gu, '$1')
    .replace(/\*\*([^*\n]+)\*\*/gu, '$1')
    .replace(/__([^_\n]+)__/gu, '$1')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/gu, '$1$2')
    .replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/gu, '$1$2')
    .replace(/~~([^~\n]+)~~/gu, '$1')
    .replace(/\u0000STAR\u0000/gu, '*');
  // Restore the protected spans. A placeholder whose index is somehow out of
  // range leaves the raw text alone rather than printing `undefined` into the
  // group -- silence is recoverable, a literal `undefined` is not.
  const restore = (text, marker, values) => text.replace(
    new RegExp(`\\u0000${token}${marker}(\\d+)\\u0000`, 'gu'),
    (match, index) => values[Number(index)] ?? match,
  );
  out = restore(out, 'C', codes);
  out = restore(out, 'F', fences);
  // Flattening leaves doubled blank lines and trailing spaces behind.
  const flattened = out.replace(/[ \t]+$/gmu, '').replace(/\n{3,}/gu, '\n\n').trim();
  return { text: flattened, structured };
}

/**
 * Flatten Markdown and return only the text.
 *
 * Kept as the plain-answer API; `flattenMarkdownDetailed` is for callers that
 * also need the structure decision (the pacing path does).
 *
 * @param text - the finished answer.
 * @returns the text a plain-text client should receive.
 */
export function flattenMarkdown(text) {
  return flattenMarkdownDetailed(text).text;
}
