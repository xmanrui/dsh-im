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

test('update RPC keeps local authority even when other management uses trusted-host', async () => {
  const calls = [];
  const service = { close: async () => {} };
  const ctx = {
    connection: { fetch: managementFetch((...args) => calls.push(args)) },
    effect: () => {},
  };
  installUpdateRpc(ctx, { service, runtime: {} });
  assert.equal(calls[0][0], '/dsh-im');
  await assert.rejects(calls[0][1]('update.status', {}, undefined, { host: 'trusted.example' }), /HTTP 403/);
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
