// Settings RPC surface for session timeout. Mirrors ./inbound-ttl-rpc.mjs:
// three endpoints (get / set / expire-now) inside /dsh-im-settings, with
// loopback authority. The setter only accepts the documented fields and
// re-arms the sweeper interval after a successful save.

import { registerManagementRpc } from '../management-rpc.mjs';
import {
  DEFAULT_SESSION_TIMEOUT_SETTINGS,
  validateSessionTimeoutField,
} from '../../src/channels/shared/session-timeout.mjs';
import { getSessionTimeoutRuntime } from './session-timeout-runtime.mjs';

export const SESSION_TIMEOUT_RPC_CHANNEL = '/dsh-im-settings';
export const SESSION_TIMEOUT_ENDPOINTS = Object.freeze({
  get: 'settings.session-timeout.get',
  set: 'settings.session-timeout.set',
  expireNow: 'settings.session-timeout.expire-now',
});

const ENDPOINTS = new Set(Object.values(SESSION_TIMEOUT_ENDPOINTS));
const SETTABLE_FIELDS = new Set(Object.keys(DEFAULT_SESSION_TIMEOUT_SETTINGS));

export function validSessionTimeoutPayload(endpoint, payload) {
  if (!ENDPOINTS.has(endpoint)) return false;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const keys = Object.keys(payload);
  if (endpoint === SESSION_TIMEOUT_ENDPOINTS.get) {
    return keys.length === 0;
  }
  if (endpoint === SESSION_TIMEOUT_ENDPOINTS.set) {
    if (keys.length === 0) return false;
    return keys.every((key) => SETTABLE_FIELDS.has(key)
      && validateSessionTimeoutField(key, payload[key]) !== null);
  }
  // expire-now: optional conversationKey (single) or conversationKeys (list)
  if (keys.length === 0) return true;
  if (keys.length === 1 && keys[0] === 'conversationKey'
    && typeof payload.conversationKey === 'string' && payload.conversationKey) {
    return true;
  }
  if (keys.length === 1 && keys[0] === 'conversationKeys'
    && Array.isArray(payload.conversationKeys)
    && payload.conversationKeys.every((key) => typeof key === 'string' && key)) {
    return true;
  }
  return false;
}

export function createSessionTimeoutRpcHandler({ store, service, logger = null } = {}) {
  if (!store || typeof store.getSettings !== 'function'
    || typeof store.setSettings !== 'function'
    || !service || typeof service.expireNow !== 'function'
    || typeof service.scanAndExpire !== 'function') {
    throw new TypeError(
      'createSessionTimeoutRpcHandler requires a session timeout store and service',
    );
  }
  return async (endpoint, payload, signal) => {
    if (!validSessionTimeoutPayload(endpoint, payload)) {
      return { ok: false, error: { code: 'bad-request', message: 'Invalid session timeout request.' } };
    }
    if (signal?.aborted) {
      return { ok: false, error: { code: 'cancelled', message: 'Request cancelled.' } };
    }
    try {
      if (endpoint === SESSION_TIMEOUT_ENDPOINTS.get) {
        return { ok: true, value: store.getSettings() };
      }
      if (endpoint === SESSION_TIMEOUT_ENDPOINTS.set) {
        const next = await store.setSettings(payload);
        // Re-arm the sweeper so a new scan interval or a freshly enabled
        // setting takes effect immediately rather than on the next tick.
        service.resetSchedule?.();
        const settings = store.getSettings();
        if (settings.enabled && !service.running) {
          service.start?.();
        } else if (!settings.enabled) {
          // Stopping the timer is safe; restart happens on the next enable.
          service.stop?.();
        }
        return { ok: true, value: next };
      }
      const keys = payload.conversationKeys
        ?? (payload.conversationKey ? [payload.conversationKey] : null);
      if (!keys) {
        const summary = await service.scanAndExpire();
        logger?.info?.(
          `[dsh-im] manual session timeout scan: ${summary.expired.length} expired`,
        );
        return { ok: true, value: summary };
      }
      const results = await service.expireNow(keys);
      return {
        ok: true,
        value: {
          expired: results
            .filter((result) => result !== null)
            .map((result) => ({
              conversationKey: result.conversationKey,
              sessionId: result.sessionId ?? null,
            })),
        },
      };
    } catch (error) {
      if (error?.code === 'session-timeout-invalid') {
        return {
          ok: false,
          error: {
            code: 'session-timeout-invalid',
            message: '会话超时设置无效：请检查 enabled、阈值、扫描间隔与清理范围。',
          },
        };
      }
      return {
        ok: false,
        error: { code: 'session-timeout-unavailable', message: 'session-timeout-unavailable' },
      };
    }
  };
}

export function installSessionTimeoutRpc(ctx, options = {}) {
  const runtime = options.runtime ?? getSessionTimeoutRuntime(ctx, options.config);
  const logger = typeof ctx?.logger === 'function'
    ? ctx.logger('dsh-im:session-timeout') : (ctx?.logger ?? null);
  return registerManagementRpc(ctx,
    SESSION_TIMEOUT_RPC_CHANNEL,
    createSessionTimeoutRpcHandler({ ...runtime, logger }),
    { authority: 'loopback', methodPrefix: 'settings.session-timeout.' },
  );
}
