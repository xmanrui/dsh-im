/**
 * A proxy for the IM channels, and only for them.
 *
 * The host reaches some networks and not others: Telegram is blocked in some
 * regions, Discord in others. The fix must not become "route the whole process
 * through a proxy" — the models, the nodes and the web GUI have nothing to do
 * with the IM traffic, and pulling them along would add latency and a failure
 * mode to everything. So a proxy is a property of a channel: it is chosen here,
 * handed to that channel's HTTP client as an undici dispatcher, and stops there.
 *
 * Both families are supported through the same value:
 *
 *     http://user:pass@proxy.example:3128
 *     https://proxy.example:8443
 *     socks5h://user:pass@proxy.example:1080
 *     socks5://proxy.example:1080
 *     { protocol: 'socks5h', host: 'proxy.example', port: 1080, username, password }
 *
 * `socks5h` resolves the destination name on the proxy side; `socks5` resolves
 * it here. The first is what a blocked or poisoned resolver needs, so it is the
 * safer default when a name is given without a scheme.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { connect as tlsConnect } from 'node:tls';
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from 'undici';
import { SocksClient } from 'socks';

/** Ports a scheme falls back to when the value leaves it out. */
const DEFAULT_PORTS = Object.freeze({
  http: 8080,
  https: 443,
  socks4: 1080,
  socks4a: 1080,
  socks5: 1080,
  socks5h: 1080,
});

/** How long a SOCKS handshake may take before the connector gives up. */
const SOCKS_HANDSHAKE_TIMEOUT_MS = 10_000;

const SCHEME_ALIASES = Object.freeze({
  http: 'http',
  https: 'https',
  socks: 'socks5h',
  socks5: 'socks5',
  socks5h: 'socks5h',
  socks4: 'socks4',
  socks4a: 'socks4a',
});

export const SUPPORTED_PROXY_SCHEMES = Object.freeze(Object.keys(SCHEME_ALIASES));

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parsePort(value, scheme) {
  if (value === undefined || value === null || value === '') return DEFAULT_PORTS[scheme];
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError(`proxy port must be an integer between 1 and 65535, got ${String(value)}`);
  }
  return port;
}

function pickScheme(raw) {
  const scheme = cleanString(raw)?.toLowerCase().replace(/:$/, '');
  if (!scheme) return null;
  const normalized = SCHEME_ALIASES[scheme];
  if (!normalized) {
    throw new TypeError(
      `unsupported proxy scheme "${scheme}" (supported: ${SUPPORTED_PROXY_SCHEMES.join(', ')})`,
    );
  }
  return normalized;
}

function decode(value) {
  if (value === null || value === undefined) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Turn whatever the config holds into one normalised spec, or null for "no proxy".
 *
 * Accepts a URL string, an object with the same fields, `false`/`null` (no proxy)
 * and throws a TypeError with a human message for anything unusable — the message
 * is shown in the channel status, so it says what to fix rather than "invalid".
 */
export function parseProxySpec(value) {
  if (value === null || value === undefined || value === false || value === '') return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    let url;
    try {
      url = new URL(text.includes('://') ? text : `socks5h://${text}`);
    } catch {
      throw new TypeError(`proxy address is not a URL: "${text}"`);
    }
    const scheme = pickScheme(url.protocol);
    return Object.freeze({
      protocol: scheme,
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: parsePort(url.port, scheme),
      username: decode(url.username) || null,
      password: decode(url.password) || null,
    });
  }
  if (typeof value !== 'object') {
    throw new TypeError('proxy must be a URL string, an object, or false');
  }
  if (value.disabled === true) return null;
  const host = cleanString(value.host ?? value.address);
  if (!host) throw new TypeError('proxy.host is required');
  const scheme = pickScheme(value.protocol ?? value.type ?? value.scheme) ?? 'socks5h';
  return Object.freeze({
    protocol: scheme,
    host: host.replace(/^\[|\]$/g, ''),
    port: parsePort(value.port, scheme),
    username: cleanString(value.username ?? value.user),
    password: typeof value.password === 'string' ? value.password : null,
  });
}

/** How a spec is named in diagnostics: no password, no login. */
export function describeProxy(spec) {
  return spec ? `${spec.protocol}://${spec.host}:${spec.port}` : 'none';
}

function proxyUri(spec) {
  const auth = spec.username
    ? `${encodeURIComponent(spec.username)}:${encodeURIComponent(spec.password ?? '')}@`
    : '';
  return `${spec.protocol === 'https' ? 'https' : 'http'}://${auth}${spec.host}:${spec.port}`;
}

function socksType(spec) {
  return spec.protocol.startsWith('socks4') ? 4 : 5;
}

/**
 * The undici connector that opens the destination TCP through a SOCKS proxy.
 *
 * undici hands us a plain TCP job (`protocol: 'http:'`) or a TLS one
 * (`protocol: 'https:'`). For the latter the socket must come back already
 * wrapped in TLS, otherwise the handshake happens in the wrong order.
 */
function createSocksConnector(spec) {
  return function socksConnect(options, callback) {
    const remoteDns = spec.protocol === 'socks5h' || spec.protocol === 'socks4a';
    const port = Number(options.port) || (options.protocol === 'https:' ? 443 : 80);
    const hostname = options.hostname ?? options.host;
    const servername = options.servername || hostname;

    (async () => {
      let destinationHost = hostname;
      if (!remoteDns && !isIpAddress(hostname)) {
        const resolved = await dnsLookup(hostname, { family: 0 });
        destinationHost = resolved.address;
      }
      const { socket } = await SocksClient.createConnection({
        proxy: {
          host: spec.host,
          port: spec.port,
          type: socksType(spec),
          userId: spec.username ?? undefined,
          password: spec.password ?? undefined,
        },
        destination: { host: destinationHost, port },
        command: 'connect',
        // undici's connector options carry no connectTimeout (it sets its own on
        // the Agent), so this is a fixed bound rather than a configurable one.
        timeout: SOCKS_HANDSHAKE_TIMEOUT_MS,
      });
      if (options.protocol !== 'https:') return socket;
      return tlsConnect({ socket, servername, rejectUnauthorized: options.rejectUnauthorized !== false });
    })().then(
      (socket) => callback(null, socket),
      (error) => callback(error, null),
    );
  };
}

function isIpAddress(value) {
  if (typeof value !== 'string' || !value) return false;
  if (value.includes(':')) return true; // IPv6 literal
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part));
}

/**
 * The dispatcher for one spec. http(s) proxies are undici's own business;
 * SOCKS needs the connector above.
 */
export function createProxyDispatcher(spec, { connections = 4 } = {}) {
  if (!spec) throw new TypeError('createProxyDispatcher needs a proxy spec');
  if (spec.protocol === 'http' || spec.protocol === 'https') {
    return new ProxyAgent({ uri: proxyUri(spec), connections });
  }
  return new Agent({ connections, connect: createSocksConnector(spec) });
}

/**
 * A fetch bound to the proxy, shaped like the one channels already accept.
 *
 * `baseFetch` exists for the tests: they inject a fake transport and check that
 * the dispatcher reaches it, without opening a socket.
 */
export function createProxyFetch(spec, { connections = 4, baseFetch = undiciFetch } = {}) {
  const dispatcher = createProxyDispatcher(spec, { connections });
  return {
    dispatcher,
    label: describeProxy(spec),
    fetchImpl: (url, options = {}) => baseFetch(url, { ...options, dispatcher }),
    destroy: () => dispatcher.destroy(),
  };
}

/** Proxy settings from the environment, the way undici already reads them. */
export function hasEnvProxy(env = process.env) {
  return Boolean(
    cleanString(env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy),
  );
}

/**
 * The final choice for one channel, from every source that can speak.
 *
 * Precedence: the channel's own switch (false = off, a value = its own proxy),
 * then the dashboard settings, then the plugin config file, then the
 * environment. A bad value in the config file must not stop the plugin, so it
 * is reported as `invalid` and the channel runs direct instead of failing.
 */
export function resolveProxyForChannel({
  settingsSpec = null, configProxy = null, override, env = process.env,
} = {}) {
  if (override === false) return { spec: null, source: 'channel-off' };
  if (override !== null && override !== undefined) {
    try {
      return { spec: parseProxySpec(override), source: 'channel' };
    } catch (error) {
      return { spec: null, source: 'channel-invalid', error: error.message };
    }
  }
  if (settingsSpec) return { spec: settingsSpec, source: 'settings' };
  let fromConfig = null;
  try {
    fromConfig = parseProxySpec(configProxy);
  } catch (error) {
    return { spec: null, source: 'config-invalid', error: error.message };
  }
  if (fromConfig) return { spec: fromConfig, source: 'plugin' };
  if (hasEnvProxy(env)) return { spec: null, source: 'env' };
  return { spec: null, source: 'none' };
}

/**
 * The HTTP transport one channel uses: a proxy when it has one, undici's
 * environment-aware agent when the environment asks for it, plain fetch otherwise.
 *
 * Returns the same shape as the telegram transport, so a channel does not care
 * which of the three it got.
 */
export function createChannelHttp({ spec = null, useEnv = true, connections = 4, FormDataImpl = null } = {}) {
  if (spec) {
    const proxy = createProxyFetch(spec, { connections });
    return {
      fetchImpl: proxy.fetchImpl,
      FormDataImpl,
      proxy: proxy.label,
      destroy: proxy.destroy,
    };
  }
  // Even without a proxy the channel keeps its own pool: a shared global
  // dispatcher is process-wide state, and a saturated one would stall a channel
  // that never asked for it. EnvHttpProxyAgent honours HTTP(S)_PROXY when set
  // and behaves like a plain pool when it is not.
  const dispatcher = useEnv
    ? new EnvHttpProxyAgent({ connections })
    : new Agent({ connections });
  return {
    fetchImpl: (url, options = {}) => undiciFetch(url, { ...options, dispatcher }),
    FormDataImpl,
    proxy: useEnv && hasEnvProxy() ? 'env' : 'none',
    destroy: () => dispatcher.destroy(),
  };
}
