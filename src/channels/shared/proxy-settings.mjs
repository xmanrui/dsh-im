// The IM proxy, as the operator configures it in the dashboard: one document for
// the whole plugin, applied to every channel that has not opted out.
//
// A proxy is a per-channel transport property (see proxy.mjs), but asking an
// operator to repeat host/port/login for every channel would be cruel and
// error-prone, so the shared value lives here and a channel's own `proxy: false`
// in the plugin config is the exception.

export const PROXY_SETTINGS_VERSION = 1;

/** The schemes the dashboard offers, in the order it offers them. */
export const PROXY_TYPES = Object.freeze(['socks5h', 'socks5', 'http', 'https']);

/**
 * The port each type falls back to when the operator leaves the field empty.
 *
 * It lives here, next to the form, because the settings path builds a spec
 * itself — `parseProxySpec` is not used there (it lives in a module the client
 * cannot bundle), so without this table an empty field produced
 * `port: undefined`, an invalid ProxyAgent URI and a SOCKS handshake that never
 * starts. The page promises the default port; this is what keeps the promise.
 */
export const PROXY_TYPE_PORTS = Object.freeze({
  http: 8080,
  https: 443,
  socks5: 1080,
  socks5h: 1080,
});

export const DEFAULT_PROXY_SETTINGS = Object.freeze({
  // Off until the operator asks: a stray proxy in a working setup is a mystery
  // outage, and the page must never take a channel down by itself.
  enabled: false,
  type: 'socks5h',
  host: '',
  port: '',
  // "No password" in the form: a SOCKS or HTTP proxy that accepts anyone.
  anonymous: true,
  username: '',
  password: '',
  // Channels that keep their own `proxy: false` in the plugin config are not
  // repeated here; this list is the operator's per-channel opt-out from the
  // dashboard, and it wins over the proxy above for the channels it names.
  bypass: Object.freeze([]),
});

/** Longest accepted channel id, so a pasted sentence cannot become one. */
const CHANNEL_ID_MAX_LENGTH = 64;

/** The channel ids that opted out of the shared proxy. */
function cleanChannelIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const id = entry.trim();
    if (!id || id.length > CHANNEL_ID_MAX_LENGTH || CONTROL_CHARACTER.test(id)) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Longest accepted host, so a pasted URL does not become the host. */
const HOST_MAX_LENGTH = 255;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

/** The fields a client may patch, in the order the form shows them. */
export const PROXY_SETTINGS_KEYS = Object.freeze(Object.keys(DEFAULT_PROXY_SETTINGS));

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, { max = HOST_MAX_LENGTH } = {}) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || CONTROL_CHARACTER.test(trimmed)) return '';
  return trimmed;
}

/** Port stays a string in the document: an empty field means "the scheme's default". */
function cleanPort(value) {
  if (typeof value === 'number') value = String(value);
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return '';
  return String(port);
}

export function normalizeProxySettings(value) {
  if (!isRecord(value)) return null;
  const type = PROXY_TYPES.includes(value.type) ? value.type : DEFAULT_PROXY_SETTINGS.type;
  const anonymous = typeof value.anonymous === 'boolean'
    ? value.anonymous
    : DEFAULT_PROXY_SETTINGS.anonymous;
  return Object.freeze({
    enabled: typeof value.enabled === 'boolean' ? value.enabled : false,
    type,
    host: cleanText(value.host),
    port: cleanPort(value.port),
    anonymous,
    // Credentials are kept even while the box says "no password": unticking it
    // again should not make the operator retype the login.
    username: cleanText(value.username),
    password: typeof value.password === 'string' && !CONTROL_CHARACTER.test(value.password)
      ? value.password.slice(0, 512)
      : '',
    bypass: cleanChannelIds(value.bypass),
  });
}

/** The keys of a patch, or null when it carries a field this document does not have. */
export function proxySettingsPatchKeys(payload) {
  if (!isRecord(payload)) return null;
  const keys = Object.keys(payload);
  return keys.every((key) => PROXY_SETTINGS_KEYS.includes(key)) ? keys : null;
}

export function applyProxySettingsPatch(current, patch) {
  const merged = { ...DEFAULT_PROXY_SETTINGS, ...(current ?? {}), ...patch };
  return normalizeProxySettings(merged) ?? DEFAULT_PROXY_SETTINGS;
}

/**
 * The proxy spec these settings describe, or null when they describe none.
 *
 * `enabled` without a host is not a proxy but half-typed form; the transport
 * then runs direct and the page says why, instead of failing every connection.
 */
export function proxySettingsToSpec(settings) {
  if (!settings?.enabled) return null;
  const host = cleanText(settings.host);
  if (!host) return null;
  const port = settings.port ? Number(settings.port) : PROXY_TYPE_PORTS[settings.type];
  return Object.freeze({
    protocol: settings.type,
    host,
    port,
    username: settings.anonymous ? null : cleanText(settings.username) || null,
    password: settings.anonymous ? null : (settings.password || null),
  });
}

/** Why the settings describe no proxy, in the words the page uses. */
export function proxySettingsProblem(settings) {
  if (!settings?.enabled) return null;
  if (!cleanText(settings.host)) return 'host-required';
  if (!settings.anonymous && !cleanText(settings.username)) return 'username-required';
  return null;
}
