import { registerManagementRpc } from '../management-rpc.mjs';
import { registeredChannels } from './channel-registry.mjs';
import { t } from '../../src/channels/shared/i18n.mjs';

/**
 * Operator actions that span channels. Today that is one: reconnect every bot.
 *
 * A bot left in a failed state after a network change is fixed by re-creating
 * its runtime, and doing that from the settings page one card at a time is
 * exactly the kind of chore this endpoint removes. It is not a restart of the
 * Host: each channel's own reconnect is called, the same one its card calls.
 */
export const OPS_RPC_CHANNEL = '/dsh-im-ops';

export const OPS_ENDPOINTS = Object.freeze({
  reconnectAll: 'bots.reconnect-all',
});

const ENDPOINTS = new Set(Object.values(OPS_ENDPOINTS));

/** One bot may not hold the whole sweep hostage. */
export const RECONNECT_TIMEOUT_MS = 20_000;

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function validOpsPayload(endpoint, payload) {
  if (!ENDPOINTS.has(endpoint)) return false;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  return Object.keys(payload).length === 0;
}

/** The bots one controller currently knows about, defensively read. */
function botsOf(snapshot) {
  const bots = Array.isArray(snapshot?.bots) ? snapshot.bots : [];
  return bots
    .map((bot) => (typeof bot?.botId === 'string' ? bot.botId : null))
    .filter(Boolean);
}

export function createOpsRpcHandler({
  channels = registeredChannels, logger = console, timeoutMs = RECONNECT_TIMEOUT_MS,
} = {}) {
  return async (endpoint, payload, signal) => {
    if (!validOpsPayload(endpoint, payload)) {
      return {
        ok: false,
        error: { code: 'bad-request', message: t('无效的操作请求。') },
      };
    }
    if (signal?.aborted) {
      return { ok: false, error: { code: 'cancelled', message: t('请求已取消。') } };
    }
    const results = [];
    for (const [channel, controller] of channels()) {
      if (signal?.aborted) break;
      if (typeof controller?.status !== 'function' || typeof controller?.reconnectBot !== 'function') {
        continue;
      }
      let botIds = [];
      try {
        botIds = botsOf(await controller.status());
      } catch (error) {
        results.push({ channel, botId: null, ok: false, error: error?.message ?? 'status failed' });
        continue;
      }
      for (const botId of botIds) {
        if (signal?.aborted) break;
        try {
          await withTimeout(controller.reconnectBot(botId), timeoutMs, `${channel}/${botId}`);
          results.push({ channel, botId, ok: true });
        } catch (error) {
          // One unhappy bot must not stop the others.
          logger?.warn?.(`[dsh-im] reconnect-all: ${channel}/${botId} failed: ${error?.message ?? error}`);
          results.push({ channel, botId, ok: false, error: error?.message ?? String(error) });
        }
      }
    }
    return {
      ok: true,
      value: {
        results,
        reconnected: results.filter((row) => row.ok).length,
        failed: results.filter((row) => !row.ok).length,
      },
    };
  };
}

export function installOpsRpc(ctx, { config = {}, logger = console } = {}) {
  const handler = createOpsRpcHandler({ logger });
  return registerManagementRpc(ctx, OPS_RPC_CHANNEL, handler, {
    authority: config.rpcAuthority,
  });
}
