// Shared by the Host and the settings UI; keep this module browser-compatible.
//
// Per-bot overrides for the DingTalk status texts. Every field is optional: an
// absent (or blank) field falls back to the i18n default, so a deployment only
// stores what it actually changed and keeps translations for the rest.

export const TEXT_OVERRIDE_FIELDS = Object.freeze([
  'cardInitial',
  'working',
  'toolUsing',
  'webSearching',
  'accessDenied',
]);

export const TEXT_OVERRIDE_MAX_LENGTH = 500;

export const EMPTY_TEXT_OVERRIDES = Object.freeze({});

function overrideText(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new TypeError('text override must be a string');
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > TEXT_OVERRIDE_MAX_LENGTH) {
    throw new TypeError(`text override is longer than ${TEXT_OVERRIDE_MAX_LENGTH} characters`);
  }
  return text;
}

/** Validate and normalize one bot's overrides. Throws on an unknown field. */
export function validateTextOverrides(value) {
  if (value === undefined || value === null) return EMPTY_TEXT_OVERRIDES;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('text overrides must be an object');
  }
  const normalized = {};
  for (const [field, raw] of Object.entries(value)) {
    if (!TEXT_OVERRIDE_FIELDS.includes(field)) {
      throw new TypeError(`unknown text override field: ${field}`);
    }
    const text = overrideText(raw);
    if (text !== undefined) normalized[field] = text;
  }
  return Object.freeze(normalized);
}

/** Read-side normalizer: damaged overrides never break the workspace document. */
export function normalizeTextOverrides(value) {
  try {
    return validateTextOverrides(value);
  } catch {
    return EMPTY_TEXT_OVERRIDES;
  }
}

/** Default tool progress text keeps the `{name}` placeholder contract. */
export function toolProgressWithName(template, name) {
  const text = typeof template === 'string' ? template : '';
  return text.includes('{name}') ? text.replaceAll('{name}', name) : text;
}
