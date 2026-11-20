import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROXY_ENDPOINTS,
  checkProxy,
  createProxyRpcHandler,
  validProxyPayload,
} from '../../../plugin-src/host/proxy-rpc.mjs';
import {
  createOpsRpcHandler,
  validOpsPayload,
} from '../../../plugin-src/host/ops-rpc.mjs';
import {
  forgetChannelControllers,
  registerChannelController,
  registeredChannels,
} from '../../../plugin-src/host/channel-registry.mjs';

function storeOf(value) {
  let current = { ...value };
  return {
    get: async () => ({ ...current }),
    set: async (patch) => { current = { ...current, ...patch }; return { ...current }; },
  };
}

test('the proxy RPC accepts only the known fields and their types', () => {
  assert.equal(validProxyPayload(PROXY_ENDPOINTS.get, {}), true);
  assert.equal(validProxyPayload(PROXY_ENDPOINTS.get, { host: 'x' }), false);
  assert.equal(validProxyPayload(PROXY_ENDPOINTS.set, { host: 'p.example' }), true);
  assert.equal(validProxyPayload(PROXY_ENDPOINTS.set, { port: 1080 }), true);
  assert.equal(validProxyPayload(PROXY_ENDPOINTS.set, { enabled: 'yes' }), false);
  assert.equal(validProxyPayload(PROXY_ENDPOINTS.set, { type: 'ftp' }), false);
  assert.equal(validProxyPayload(PROXY_ENDPOINTS.set, { password: 42 }), false);
  assert.equal(validProxyPayload(PROXY_ENDPOINTS.set, { nonsense: 'x' }), false);
  assert.equal(validProxyPayload('settings.proxy.forget', {}), false);
  assert.equal(validProxyPayload(PROXY_ENDPOINTS.set, null), false);
});

test('the proxy handler reads, writes and refuses a bad request', async () => {
  const store = storeOf({ enabled: false, host: '' });
  const handle = createProxyRpcHandler(store, { logger: { warn() {} } });

  const got = await handle(PROXY_ENDPOINTS.get, {}, undefined);
  assert.equal(got.ok, true);
  assert.equal(got.value.enabled, false);

  const set = await handle(PROXY_ENDPOINTS.set, { enabled: true, host: 'proxy.example' }, undefined);
  assert.equal(set.ok, true);
  assert.equal((await store.get()).host, 'proxy.example');

  const bad = await handle(PROXY_ENDPOINTS.set, { enabled: 'yes' }, undefined);
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'bad-request');

  const cancelled = await handle(PROXY_ENDPOINTS.get, {}, { aborted: true });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.code, 'cancelled');
});

test('the check refuses a half-filled form instead of testing the direct route', async () => {
  const half = { enabled: true, type: 'socks5h', host: '', port: '', anonymous: true, username: '', password: '' };
  const result = await checkProxy(half);
  assert.equal(result.problem, 'host-required');
  assert.equal(result.proxy, 'none');
  assert.deepEqual(result.results, []);
});

test('the ops RPC validates the endpoint and its empty payload', () => {
  assert.equal(validOpsPayload('bots.reconnect-all', {}), true);
  assert.equal(validOpsPayload('bots.reconnect-all', { botId: 'x' }), false);
  assert.equal(validOpsPayload('bots.restart', {}), false);
});

test('reconnect-all walks the bots, survives one failure and bounds each call', async () => {
  const calls = [];
  const controller = (bots, { failOn = null, hangOn = null } = {}) => ({
    status: async () => ({ bots: bots.map((botId) => ({ botId })) }),
    reconnectBot: async (botId) => {
      calls.push(botId);
      if (botId === failOn) throw new Error('boom');
      if (botId === hangOn) return new Promise(() => {});
      return undefined;
    },
  });
  const channels = [
    ['telegram', controller(['a', 'b', 'c'], { failOn: 'b', hangOn: 'c' })],
    ['discord', controller(['d'])],
  ];
  const handle = createOpsRpcHandler({
    channels: () => channels, logger: { warn() {} }, timeoutMs: 50,
  });
  const started = Date.now();
  const result = await handle('bots.reconnect-all', {}, undefined);
  const elapsed = Date.now() - started;
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['a', 'b', 'c', 'd'], 'a hung bot does not stop the sweep');
  assert.equal(result.value.reconnected, 2, 'a and d came back; b threw, c timed out');
  assert.equal(result.value.failed, 2, 'one threw, one timed out');
  assert.match(
    result.value.results.find((row) => row.botId === 'c').error,
    /timed out after 50 ms/,
  );
  assert.ok(elapsed < 1_000, `the sweep must not wait for the 20s default (took ${elapsed} ms)`);
});

test('the channel registry keeps the last controller per channel and can be cleared', () => {
  forgetChannelControllers();
  registerChannelController('telegram', { status() {} });
  registerChannelController('telegram', { status() {} });
  registerChannelController('discord', { status() {} });
  registerChannelController(null, {});
  registerChannelController('qq', null);
  assert.deepEqual(registeredChannels().map(([channel]) => channel), ['telegram', 'discord']);
  forgetChannelControllers();
  assert.deepEqual(registeredChannels(), []);
});

test('the check stops probing when its caller goes away', async () => {
  const { checkProxy } = await import('../../../plugin-src/host/proxy-rpc.mjs');
  const controller = new AbortController();
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push(url);
    controller.abort();
    // A request that would otherwise hang: only the abort can end it.
    const { signal } = options;
    if (signal?.aborted) throw new Error('aborted');
    return new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  };
  const settings = {
    enabled: true, type: 'socks5h', host: 'proxy.example', port: '1080',
    anonymous: true, username: '', password: '',
  };
  const result = await checkProxy(settings, { fetchImpl, signal: controller.signal });
  assert.equal(result.results.length, 2, 'both targets are reported, none hangs');
  assert.equal(result.results.every((row) => row.ok === false), true);
  assert.equal(seen.length, 2);
});
