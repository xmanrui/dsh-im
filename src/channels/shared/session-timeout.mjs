// Pure validation and defaults for conversation session-timeout settings.
// Mirrors the shape of ./inbound-ttl.mjs so the two features stay
// structurally aligned: a single normalize/validate surface plus the
// constants the store and RPC both reach for.

/** Inbound attachment TTL keeps the wider surface; session timeout stays in minutes. */
export const MIN_TIMEOUT_MINUTES = 1;
/** 7 days — IM conversations can legitimately go quiet for a day or more. */
export const MAX_TIMEOUT_MINUTES = 10_080;

export const MIN_SCAN_INTERVAL_MS = 60_000;
export const MAX_SCAN_INTERVAL_MS = 3_600_000;

/**
 * Cleanup scope values, in narrow-to-wide order. `'none'` clears only the
 * conversationKey→sessionId binding; `'inbound'` additionally sweeps the
 * inbound attachment subtree; `'directory'` removes the whole conversation
 * directory after safety checks.
 */
export const CLEANUP_SCOPES = Object.freeze(['none', 'inbound', 'directory']);

const INTEGER_STRING = /^\d+$/;

/**
 * Default session-timeout settings. `enabled: false` preserves the existing
 * deployment behavior; nothing expires until a tenant explicitly opts in.
 */
export const DEFAULT_SESSION_TIMEOUT_SETTINGS = Object.freeze({
  enabled: false,
  timeoutMinutes: 30,
  scanIntervalMs: 300_000,
  cleanupScope: 'none',
  notify: true,
  notifyText: '会话超时，已开启新会话；如需继续上一段，请使用 /history',
});

/** Default timeout-notification text shown to users when `notify` is on. */
export const DEFAULT_NOTIFY_TEXT = DEFAULT_SESSION_TIMEOUT_SETTINGS.notifyText;

function normalizeTimeoutMinutes(value) {
  let candidate = value;
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (!INTEGER_STRING.test(trimmed)) return null;
    candidate = Number(trimmed);
  }
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) return null;
  if (!Number.isInteger(candidate)) return null;
  if (candidate < MIN_TIMEOUT_MINUTES || candidate > MAX_TIMEOUT_MINUTES) return null;
  return candidate;
}

function normalizeScanIntervalMs(value) {
  let candidate = value;
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (!INTEGER_STRING.test(trimmed)) return null;
    candidate = Number(trimmed);
  }
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) return null;
  if (!Number.isInteger(candidate)) return null;
  if (candidate < MIN_SCAN_INTERVAL_MS || candidate > MAX_SCAN_INTERVAL_MS) return null;
  return candidate;
}

function normalizeCleanupScope(value) {
  return typeof value === 'string' && CLEANUP_SCOPES.includes(value) ? value : null;
}

function normalizeNotifyText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

/**
 * Validate and normalize a full session-timeout settings patch. Unknown
 * fields are ignored; known-but-invalid fields fall back to the matching
 * default. `null` is never returned: this surface always yields a usable
 * settings object.
 *
 * @param {object} [patch] Candidate settings patch.
 * @returns {object} A normalized, frozen settings object.
 */
export function normalizeSessionTimeoutSettings(patch) {
  const base = DEFAULT_SESSION_TIMEOUT_SETTINGS;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return structuredClone(base);
  }
  const enabled = typeof patch.enabled === 'boolean' ? patch.enabled : base.enabled;
  const timeoutMinutes = normalizeTimeoutMinutes(patch.timeoutMinutes) ?? base.timeoutMinutes;
  const scanIntervalMs = normalizeScanIntervalMs(patch.scanIntervalMs) ?? base.scanIntervalMs;
  const cleanupScope = normalizeCleanupScope(patch.cleanupScope) ?? base.cleanupScope;
  const notify = typeof patch.notify === 'boolean' ? patch.notify : base.notify;
  const notifyText = normalizeNotifyText(patch.notifyText) ?? base.notifyText;
  return Object.freeze({
    enabled,
    timeoutMinutes,
    scanIntervalMs,
    cleanupScope,
    notify,
    notifyText,
  });
}

/**
 * Report whether a single settings value is individually valid. Used by the
 * RPC payload validator: it accepts a candidate for a named field and
 * returns `null` when invalid, so the handler can reject bad payloads before
 * touching the store.
 *
 * @param {string} field One of the settings field names.
 * @param {unknown} value Candidate value.
 * @returns {unknown} The normalized value, or `null` if invalid.
 */
export function validateSessionTimeoutField(field, value) {
  switch (field) {
    case 'enabled':
      return typeof value === 'boolean' ? value : null;
    case 'timeoutMinutes':
      return normalizeTimeoutMinutes(value);
    case 'scanIntervalMs':
      return normalizeScanIntervalMs(value);
    case 'cleanupScope':
      return normalizeCleanupScope(value);
    case 'notify':
      return typeof value === 'boolean' ? value : null;
    case 'notifyText':
      return normalizeNotifyText(value);
    default:
      return null;
  }
}
