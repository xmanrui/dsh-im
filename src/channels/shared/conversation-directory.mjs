// Shared by the Host and settings UI; keep this module browser-compatible.
//
// A conversation directory isolates one IM conversation (or one Session) in its
// own directory below the conversation's base workspace. The name is derived
// from the conversation key alone, so every participant can recompute it
// without a round trip and a restart cannot rename an existing directory.

/** Directory prefix. Also the marker the workspace list filters on. */
export const CONVERSATION_DIRECTORY_PREFIX = 'conv-';

/**
 * How many directories one conversation may own.
 * `per-conversation` keeps a single stable directory for the conversation;
 * `per-session` mints one for each new Session.
 */
export const CONVERSATION_DIRECTORY_STRATEGIES = Object.freeze([
  'per-conversation',
  'per-session',
]);

/**
 * Isolation is off by default: existing deployments keep writing into their
 * configured workspace until an operator opts in per bot.
 */
export const DEFAULT_CONVERSATION_DIRECTORY_SETTINGS = Object.freeze({
  enabled: false,
  strategy: 'per-conversation',
  prefix: CONVERSATION_DIRECTORY_PREFIX,
});

const SETTINGS_KEYS = ['enabled', 'strategy', 'prefix'];

/**
 * Longest directory segment this module emits. Well below the 255-byte limit
 * every mainstream filesystem imposes, and short enough that a deep base
 * workspace still leaves room inside the Windows 260-character path budget.
 */
const MAX_DIRECTORY_NAME_LENGTH = 100;

/** Characters Windows rejects in a path segment, plus every C0/C1 control. */
const ILLEGAL_SEGMENT_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/gu;

/** Trailing dots and spaces are unstorable on Windows and ambiguous elsewhere. */
const TRAILING_DOT_OR_SPACE = /[. ]+$/u;

const PREFIX_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

function invalidSettings(message) {
  const error = new TypeError(message);
  error.code = 'conversation-directory-invalid';
  return error;
}

function hasExactKeys(input, keys, { allowMissing = [] } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) return false;
  const allowed = new Set(keys);
  const present = Reflect.ownKeys(input);
  if (present.some((key) => typeof key !== 'string' || !allowed.has(key))) return false;
  return keys.every((key) => Object.hasOwn(input, key) || allowMissing.includes(key));
}

/**
 * Validate one complete atomic settings save. Rejects unknown keys instead of
 * dropping them so a client that sends a newer field is told, not silently
 * downgraded.
 *
 * @param {unknown} value Candidate settings.
 * @returns {{ enabled: boolean, strategy: string, prefix: string }} Frozen settings.
 */
export function validateConversationDirectorySettings(value) {
  if (!hasExactKeys(value, SETTINGS_KEYS, { allowMissing: ['strategy', 'prefix'] })) {
    throw invalidSettings('请提交完整的会话目录设置。');
  }
  const { enabled } = value;
  if (typeof enabled !== 'boolean') {
    throw invalidSettings('会话目录开关必须是布尔值。');
  }
  const strategy = Object.hasOwn(value, 'strategy')
    ? value.strategy
    : DEFAULT_CONVERSATION_DIRECTORY_SETTINGS.strategy;
  if (!CONVERSATION_DIRECTORY_STRATEGIES.includes(strategy)) {
    throw invalidSettings('会话目录策略只能是 per-conversation 或 per-session。');
  }
  const prefix = Object.hasOwn(value, 'prefix')
    ? value.prefix
    : CONVERSATION_DIRECTORY_PREFIX;
  if (typeof prefix !== 'string' || !PREFIX_PATTERN.test(prefix)) {
    throw invalidSettings('会话目录前缀只能是 1-32 位字母、数字、下划线或连字符。');
  }
  return Object.freeze({ enabled, strategy, prefix });
}

/**
 * Read a persisted settings value, substituting the defaults for anything
 * damaged. Unlike validation, normalization never throws: one damaged bot must
 * not disable the whole document.
 *
 * @param {unknown} value Persisted settings.
 * @returns {{ enabled: boolean, strategy: string, prefix: string }} Frozen settings.
 */
export function normalizeConversationDirectorySettings(value) {
  try {
    return validateConversationDirectorySettings(value);
  } catch {
    return DEFAULT_CONVERSATION_DIRECTORY_SETTINGS;
  }
}

/**
 * FNV-1a over the UTF-16 code units of `value`, rendered as 8 lowercase hex
 * characters. Deliberately not a cryptographic digest: the host and the browser
 * bundle must compute the same name without a platform crypto dependency, and
 * the value only has to separate keys that sanitize to the same stem.
 *
 * @param {string} value Source text.
 * @returns {string} Eight hex characters.
 */
function shortDigest(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    // 32-bit FNV prime multiply without overflowing the Number mantissa.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Compact UTC stamp: one sortable token, no separator, no locale dependence. */
function timestampToken(value) {
  const date = new Date(value);
  const pad = (number, width = 2) => String(number).padStart(width, '0');
  return [
    pad(date.getUTCFullYear(), 4), pad(date.getUTCMonth() + 1), pad(date.getUTCDate()),
    '-',
    pad(date.getUTCHours()), pad(date.getUTCMinutes()), pad(date.getUTCSeconds()),
    pad(date.getUTCMilliseconds(), 3),
  ].join('');
}

/**
 * Turn a conversation key into one filesystem-safe directory segment.
 *
 * The key is lossy when sanitized (`p2p:a-b` and `p2p:a:b` share a stem), so a
 * digest of the *original* key always terminates the name; the stem is kept
 * only for readability. The result is deterministic for a given key, strategy
 * and instant, which is what lets a restart recompute the same directory.
 *
 * @param {string} conversationKey Conversation key, e.g. `p2p:ou_abc`.
 * @param {{ prefix?: string, strategy?: string, now?: number }} [options]
 *   `now` participates only in the `per-session` strategy.
 * @returns {string} A single path segment.
 * @throws {TypeError} When the key is missing or the prefix leaves no room.
 */
export function conversationDirectoryName(conversationKey, options = {}) {
  if (typeof conversationKey !== 'string' || !conversationKey) {
    throw new TypeError('conversationKey is required');
  }
  const prefix = options.prefix ?? CONVERSATION_DIRECTORY_PREFIX;
  if (typeof prefix !== 'string' || !PREFIX_PATTERN.test(prefix)) {
    throw new TypeError('conversation directory prefix is invalid');
  }
  const strategy = options.strategy ?? DEFAULT_CONVERSATION_DIRECTORY_SETTINGS.strategy;
  const suffix = strategy === 'per-session'
    ? `-${timestampToken(options.now ?? Date.now())}`
    : '';
  const digest = shortDigest(conversationKey);
  const budget = MAX_DIRECTORY_NAME_LENGTH - prefix.length - 1 - digest.length - suffix.length;
  if (budget < 1) throw new TypeError('conversation directory prefix is too long');
  let stem = conversationKey
    .replace(ILLEGAL_SEGMENT_CHARACTERS, '-')
    .replace(TRAILING_DOT_OR_SPACE, '')
    .trim();
  if (!stem) stem = 'conversation';
  if (stem.length > budget) stem = stem.slice(0, budget).replace(TRAILING_DOT_OR_SPACE, '');
  // The prefix is mandatory and non-empty, so the segment can never be one of
  // the device names Windows resolves before the filesystem.
  return `${prefix}${stem}-${digest}${suffix}`;
}

/**
 * Whether a path names a directory this module minted. Used to keep the
 * workspace list readable; it decides nothing about ownership or access.
 *
 * @param {unknown} value Candidate path.
 * @param {{ prefix?: string }} [options] Prefix to match.
 * @returns {boolean} True when the last path segment carries the prefix.
 */
export function isConversationDirectoryPath(value, options = {}) {
  if (typeof value !== 'string' || !value) return false;
  const prefix = options.prefix ?? CONVERSATION_DIRECTORY_PREFIX;
  if (typeof prefix !== 'string' || !prefix) return false;
  // Split on both separators so a Windows path stays readable on POSIX and the
  // predicate holds whichever platform produced the stored value.
  const segments = value.split(/[\\/]+/u).filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  return last.startsWith(prefix);
}

/**
 * User-facing reason for a degraded directory preparation. Callers wrap the
 * result in `t()`; the literals double as translation keys.
 *
 * @param {string | null | undefined} reason Code reported by the preparation.
 * @returns {string} A Chinese literal.
 */
export function conversationDirectoryFailureReason(reason) {
  switch (reason) {
    case 'base-unavailable':
      return '找不到可用的基工作区。';
    case 'create-failed':
      return '无法创建目录（权限或磁盘空间不足）。';
    case 'switch-failed':
      return '无法把本对话切换到新目录。';
    case 'unsupported-harness':
      return '当前 Harness 版本不支持会话目录隔离。';
    case 'invalid-key':
      return '当前消息缺少可用的会话标识。';
    default:
      return '未知原因。';
  }
}
