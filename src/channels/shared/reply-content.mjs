/**
 * Per-bot reply content filters.
 *
 * A Harness turn produces more than its final answer: the assistant narrates
 * between tool calls ("let me check that first"), tools run, and the model may
 * reason. Some conversations only want the answer. Each bot therefore keeps
 * three independent switches for the parts of a turn it is willing to receive:
 *
 *   narration -- the assistant's own prose between tool calls
 *   tools     -- tool calls, their results and tool failures
 *   thinking  -- the model's reasoning trace, where the channel shows one
 *
 * The final answer is never switchable: it is the reason the bot replies at
 * all. When narration is hidden the delivered answer is also extracted after
 * the last tool call, because the prose around it belongs to the process the
 * user asked not to see.
 *
 * Kept free of Node imports so the Web client can share the same rules.
 */

export const SET_REPLY_CONTENT_ENDPOINT = 'bot.reply-content.set';

/** Every key a bot may switch off; the final answer is deliberately absent. */
export const REPLY_CONTENT_KEYS = Object.freeze(['narration', 'tools', 'thinking']);

/** Defaults keep the pre-existing behaviour: a turn is delivered in full. */
export const DEFAULT_REPLY_CONTENT = Object.freeze({
  narration: true,
  tools: true,
  thinking: true,
});

function booleanOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * A complete, frozen switch set. A missing or damaged key falls back to its
 * default, so one bad field can never silence a bot.
 */
export function normalizeReplyContent(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.freeze({
    narration: booleanOr(source.narration, DEFAULT_REPLY_CONTENT.narration),
    tools: booleanOr(source.tools, DEFAULT_REPLY_CONTENT.tools),
    thinking: booleanOr(source.thinking, DEFAULT_REPLY_CONTENT.thinking),
  });
}

/** Whether this switch set is the all-on default (and so need not be stored). */
export function isDefaultReplyContent(value) {
  const content = normalizeReplyContent(value);
  return REPLY_CONTENT_KEYS.every((key) => content[key] === DEFAULT_REPLY_CONTENT[key]);
}

/** True when at least one part of the turn is filtered out. */
export function filtersProcessContent(value) {
  const content = normalizeReplyContent(value);
  return REPLY_CONTENT_KEYS.some((key) => content[key] === false);
}

/**
 * The answer a bot should deliver for this switch set.
 *
 * narration=false asks for the answer alone, so the text of every completed
 * step before the last tool call is process prose rather than the answer.
 */
export function replyContentFinalAnswerOnly(value) {
  return normalizeReplyContent(value).narration === false;
}

/** Whether a progress update of this kind may be delivered. */
export function allowsReplyContent(value, kind) {
  const content = normalizeReplyContent(value);
  if (kind === 'narration' || kind === 'tools' || kind === 'thinking') return content[kind];
  return true;
}

/**
 * Strict shape for the settings endpoint: every switch must be present and
 * boolean. Validation is separate from normalization so a malformed request is
 * rejected instead of silently rewritten.
 */
export function isReplyContent(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === REPLY_CONTENT_KEYS.length
    && REPLY_CONTENT_KEYS.every((key) => typeof value[key] === 'boolean');
}

/** A strict set, or a thrown error naming the field that is wrong. */
export function validateReplyContent(value) {
  if (!isReplyContent(value)) {
    const error = new Error('replyContent must carry boolean narration, tools and thinking switches.');
    error.code = 'reply-content-invalid';
    throw error;
  }
  return Object.freeze({
    narration: value.narration,
    tools: value.tools,
    thinking: value.thinking,
  });
}
