import { managementFetch } from './fixtures/management-rpc.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createUpdateRpcHandler, installUpdateRpc } from '../plugin-src/host/update-rpc.mjs';
import { createImHostPlugin } from '../plugin-src/host/index.mjs';

test('update RPC rejects arbitrary commands, paths, profiles, sources and invalid request identifiers', async () => {
  const calls = [];
  const service = Object.fromEntries(['status', 'check', 'install'].map((key) => [key, async (value) => calls.push([key, value])]));
  const handle = createUpdateRpcHandler(service);
  for (const [endpoint, payload] of [
    ['unknown', {}], ['update.check', { registry: 'https://evil.test/' }],
    ['update.status', { profile: '../other' }], ['update.install', null],
    ['update.install', { checkId: 'id', requestId: 'request', command: 'anything' }],
    ['update.install', { checkId: 'id', requestId: '; rm -rf /' }],
    ['update.install', { checkId: 'id', requestId: 'request', version: '9.0.0' }],
  ]) {
    assert.equal((await handle(endpoint, payload)).error.code, 'bad-request');
  }
  assert.deepEqual(calls, []);
});

test('all update methods honor the configured authority before calling the service', async () => {
  for (const authority of [undefined, 'trusted-host', 'loopback']) {
    const calls = [];
    let call;
    const service = {
      ...Object.fromEntries(['status', 'check', 'install'].map(method => [method, async (payload) => {
        calls.push({ method, payload });
        return { method };
      }])),
      close: async () => {},
    };
    const ctx = {
      connection: { fetch: managementFetch((channel, handler) => { assert.equal(channel, '/dsh-im'); call = handler; }) },
      effect: () => {},
    };
    installUpdateRpc(ctx, { service, runtime: {}, authority });
    for (const host of ['192.168.1.100:3080', 'trusted.example', '127.0.0.1:3080', 'localhost']) {
      const headers = { host, origin: `http://${host}` };
      const rejected = authority === 'loopback' && ['192.168.1.100:3080', 'trusted.example'].includes(host);
      for (const method of ['status', 'check', 'install']) {
        const payload = method === 'install' ? { checkId: 'confirmed', requestId: 'request' } : {};
        const before = calls.length;
        if (rejected) {
          await assert.rejects(call(`update.${method}`, payload, undefined, headers), /HTTP 403/);
          assert.equal(calls.length, before);
        } else {
          assert.deepEqual(await call(`update.${method}`, payload, undefined, headers), { ok: true, value: { method } });
          assert.equal(calls.length, before + 1);
          assert.deepEqual(calls.at(-1), { method, payload: method === 'install' ? payload : undefined });
        }
      }
    }
  }
});

test('update RPC returns only safe codes for unanticipated runtime errors', async () => {
  const handle = createUpdateRpcHandler({ status: async () => {
    throw new Error('token=secret /Users/private/profile');
  } });
  assert.deepEqual(await handle('update.status', {}), {
    ok: false, error: { code: 'update-failed', message: 'update-failed' },
  });
});

test('aborting a submitted browser request does not cancel the Host installation', async () => {
  const abort = new AbortController();
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  const handle = createUpdateRpcHandler({ install: async () => pending });
  const result = handle('update.install', { checkId: 'confirmed', requestId: 'request' }, abort.signal);
  abort.abort();
  complete({ job: { state: 'installing' } });
  assert.deepEqual(await result, { ok: true, value: { job: { state: 'installing' } } });
});

test('Host update initialization failure leaves all channel activations available', async () => {
  const calls = [];
  const channels = ['Feishu', 'Weixin', 'Dingtalk', 'Wecom', 'WecomApp', 'Qq', 'Slack', 'Telegram', 'Discord', 'Whatsapp', 'IMessage', 'Email', 'Matrix', 'Office'];
  const internals = Object.fromEntries(channels.map((channel) => [`apply${channel}`, async () => calls.push(channel)]));
  internals.installUpdateRpc = () => { throw new Error('updater unavailable'); };
  internals.installDeliveryRpc = () => {};
  internals.installInboundTtlRpc = () => {};
  internals.installDeliverySyncRpc = () => {};
  internals.installSidebarSettingsRpc = () => {};
  internals.installHostLanguage = () => undefined;
  internals.installHostLanguageRpc = () => {};
  const errors = [];
  await createImHostPlugin(internals).apply({
    connection: { fetch: {} }, logger: { error: (...args) => errors.push(args) },
  });
  assert.deepEqual(calls, channels);
  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /update management/);
});
