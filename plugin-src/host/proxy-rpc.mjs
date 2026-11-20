import { registerManagementRpc } from '../management-rpc.mjs';
import {
  PROXY_SETTINGS_KEYS,
  PROXY_TYPES,
  proxySettingsPatchKeys,
  proxySettingsToSpec,
} from '../../src/channels/shared/proxy-settings.mjs';
import { createChannelHttp } from '../../src/channels/shared/proxy.mjs';
import { getProxySettingsStore } from '../../src/channels/shared/proxy-settings-store.mjs';
import { t } from '../../src/channels/shared/i18n.mjs';

/**
 * Management channel for the IM proxy settings. Separate from the
 * loopback-only settings channel for the same reason as the delivery page: it
 * is opened through the Host dashboard's own domain, so it follows the profile's
 * `rpcAuthority`.
 */
export const PROXY_RPC_CHANNEL = '/dsh-im-proxy';

export const PROXY_ENDPOINTS = Object.freeze({
  get: 'settings.proxy.get',
  set: 'settings.proxy.set',
  check: 'settings.proxy.check',
});

/**
 * What the check asks through the proxy. Two destinations on purpose: a proxy
 * that reaches one IM network and not another is a real situation, and the
 * answer should show it instead of a single "works".
 */
export const PROXY_CHECK_TARGETS = Object.freeze([
  { id: 'telegram', url: 'https://api.telegram.org/' },
  { id: 'discord', url: 'https://discord.com/api/v10/gateway' },
]);

const CHECK_TIMEOUT_MS = 8_000;

const ENDPOINTS = new Set(Object.values(PROXY_ENDPOINTS));

const BOOLEAN_FIELDS = new Set(['enabled', 'anonymous']);
const STRING_FIELDS = new Set(['type', 'host', 'port', 'username', 'password']);
/** The per-channel opt-out list: channel ids, nothing else. */
const LIST_FIELDS = new Set(['bypass']);


/** Field names and value types of a refused payload: enough to fix the caller. */
function describePayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return `payload=${Array.isArray(payload) ? 'array' : typeof payload}`;
  }
  return Object.entries(payload)
    .map(([key, value]) => `${key}=${value === null ? 'null' : typeof value}`)
    .join(' ');
}

export function validProxyPayload(endpoint, payload) {
  if (!ENDPOINTS.has(endpoint)) return false;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const keys = proxySettingsPatchKeys(payload);
  if (keys === null) return false;
  if (endpoint === PROXY_ENDPOINTS.get || endpoint === PROXY_ENDPOINTS.check) {
    return keys.length === 0;
  }
  if (keys.length === 0) return false;
  return keys.every((key) => {
    if (BOOLEAN_FIELDS.has(key)) return typeof payload[key] === 'boolean';
    if (LIST_FIELDS.has(key)) {
      return Array.isArray(payload[key])
        && payload[key].every((entry) => typeof entry === 'string');
    }
    if (!STRING_FIELDS.has(key)) return false;
    if (key === 'port') return typeof payload[key] === 'string' || typeof payload[key] === 'number';
    if (key === 'type') return PROXY_TYPES.includes(payload[key]);
    return typeof payload[key] === 'string';
  });
}


/**
 * Reach each IM endpoint through the configured proxy, once.
 *
 * This is the only way an operator can tell "the proxy is wrong" from "the bot
 * is unhappy" without reading the Host log: a plain request, timed, with the
 * error text when it fails.
 */
export async function checkProxy(settings, { fetchImpl = null } = {}) {
  const spec = proxySettingsToSpec(settings);
  const transport = createChannelHttp({ spec, useEnv: false, connections: 1 });
  const started = Date.now();
  try {
    const results = [];
    for (const target of PROXY_CHECK_TARGETS) {
      const at = Date.now();
      try {
        const response = await (fetchImpl ?? transport.fetchImpl)(target.url, {
          method: 'GET',
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        });
        results.push({
          id: target.id, url: target.url, ok: true,
          status: response.status, ms: Date.now() - at,
        });
      } catch (error) {
        results.push({
          id: target.id, url: target.url, ok: false,
          ms: Date.now() - at, error: error?.message ?? String(error),
        });
      }
    }
    return {
      enabled: Boolean(settings?.enabled),
      proxy: spec ? `${spec.protocol}://${spec.host}:${spec.port ?? ''}`.replace(/:$/, '') : 'none',
      ms: Date.now() - started,
      results,
    };
  } finally {
    await transport.destroy();
  }
}

export function createProxyRpcHandler(store, { logger = console } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new TypeError('createProxyRpcHandler requires a proxy settings store');
  }
  return async (endpoint, payload, signal) => {
    if (!validProxyPayload(endpoint, payload)) {
      // The page shows one stable sentence; the shape that was refused is what
      // makes it diagnosable, so it goes to the Host log.
      logger?.warn?.(`[dsh-im] proxy settings ${endpoint} rejected: ${describePayload(payload)}`);
      return {
        ok: false,
        error: {
          code: 'bad-request',
          message: t('无效的代理设置：类型必须是 {types} 之一，端口是数字，其余字段是文本。', {
            types: PROXY_TYPES.join('/'),
          }),
        },
      };
    }
    if (signal?.aborted) {
      return { ok: false, error: { code: 'cancelled', message: t('请求已取消。') } };
    }
    try {
      if (endpoint === PROXY_ENDPOINTS.check) {
        return { ok: true, value: await checkProxy(await store.get()) };
      }
      const value = endpoint === PROXY_ENDPOINTS.get
        ? await store.get()
        : await store.set(payload);
      return { ok: true, value };
    } catch (error) {
      logger?.warn?.(
        `[dsh-im] proxy settings ${endpoint} failed`
          + ` [${error?.code ?? error?.name ?? 'unknown-error'}]: ${error?.message ?? ''}`,
      );
      return {
        ok: false,
        error: {
          code: 'proxy-settings-unavailable',
          message: t('无法读取或保存代理设置，请稍后重试。'),
        },
      };
    }
  };
}

/** Install-time helper: the store the RPC and the channels share. */
export function proxyStore(config) {
  return getProxySettingsStore(config);
}

export function installProxyRpc(ctx, { config = {}, store = null, logger = console } = {}) {
  const handler = createProxyRpcHandler(store ?? proxyStore(config), { logger });
  return registerManagementRpc(ctx, PROXY_RPC_CHANNEL, handler, {
    authority: config.rpcAuthority,
  });
}

export { PROXY_SETTINGS_KEYS };
