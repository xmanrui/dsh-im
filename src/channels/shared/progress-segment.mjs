/**
 * Opt-in progress segments: a turn's assistant notes are delivered as separate
 * messages instead of only being folded into the placeholder. The prefix is
 * free-form text plus emoji, so it is never trimmed — a trailing space is often
 * exactly what separates the marker from the sentence.
 */
export const DEFAULT_SEGMENT_PREFIX = '🤤 ';

/** Prefix length is counted in code points so one emoji never costs two. */
export const SEGMENT_PREFIX_MAX_CHARS = 32;

/** Only an explicit true enables segments; an absent field stays off. */
export function normalizeSegmentProgress(value) {
  return value === true;
}

/** Store a usable prefix; unusable input falls back to the default marker. */
export function normalizeSegmentPrefix(value) {
  if (typeof value !== 'string') return DEFAULT_SEGMENT_PREFIX;
  // Newlines would leak into the rendered message as a stray empty line.
  return [...value.replace(/[\r\n]+/gu, ' ')].slice(0, SEGMENT_PREFIX_MAX_CHARS).join('');
}
