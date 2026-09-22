import assert from 'node:assert/strict';
import test from 'node:test';
import { callManagementRpc, registerManagementRpc } from '../plugin-src/management-rpc.mjs';
import { installInboundTtlRpc } from '../plugin-src/host/inbound-ttl-rpc.mjs';

function fixture(handler, options) {
  let route;
  const dispose = async () => {};
  const ctx = { connection: { fetch: { register(value) { route = value; return dispose; } } } };
  assert.equal(registerManagementRpc(ctx, '/feishu', handler, options), dispose);
  return route;
}

function request({ envelope, body, method = 'POST', headers, signal } = {}) {
  return new Request('http://dsh.internal/api/dsh-im/feishu', {
    method,
    headers: { host: 'localhost:3080', 'content-type': 'application/json', ...headers },
    ...(method === 'POST' ? { body: body ?? JSON.stringify(envelope ?? {
      type: 'client-request', rpcId: 'correlation-1', method: 'dsh-im/feishu',
      payload: { method: 'connection.status', payload: {} },
    }) } : {}),
    signal,
  });
}

test('management RPC carries business methods and null payloads without changing their meaning', async () => {
  const calls = [];
  const abort = new AbortController();
  const route = fixture(async (method, payload, signal) => {
    calls.push({ method, payload, aborted: signal.aborted });
    return { ok: true, value: { received: payload } };
  });
  assert.equal(route.path, '/api/dsh-im/feishu');
  assert.deepEqual(route.methods, ['POST']);
  assert.equal(route.requestBody, 'buffered');
  const connection = { rpc: { async call(channel, endpoint, payload, signal) {
    assert.equal(channel, '/api');
    assert.equal(endpoint, 'dsh-im/feishu');
    assert.equal(signal, abort.signal);
    const response = await route.fetch(request({ envelope: {
      type: 'client-request', rpcId: 'correlation-1', method: endpoint, payload,
    }, signal }));
    const full = await response.json();
    assert.equal(full.type, 'server-response');
    assert.equal(full.rpcId, 'correlation-1');
    return full.result;
  } } };
  const result = await callManagementRpc(connection, '/feishu', 'connection.status', null, abort.signal);
  assert.deepEqual(result, { ok: true, value: { received: null } });
  assert.deepEqual(calls, [{ method: 'connection.status', payload: null, aborted: false }]);
});

test('business failures retain their code and gain the details required by Connection clients', async () => {
  const error = { code: 'bad-request', message: 'Invalid bot.' };
  const route = fixture(async () => ({ ok: false, error }));
  const full = await (await route.fetch(request())).json();
  assert.deepEqual(full.result, { ok: false, error: { ...error, details: {} } });
  assert.equal(Object.hasOwn(error, 'details'), false);
});

test('invalid envelopes never reach a business handler', async () => {
  let calls = 0;
  const route = fixture(async () => { calls += 1; return { ok: true, value: {} }; });
  const valid = { type: 'client-request', rpcId: 'one', method: 'dsh-im/feishu', payload: { method: 'bot.delete', payload: {} } };
  for (const envelope of [
    [], 'invalid', {},
    { ...valid, type: 'server-response' }, { ...valid, rpcId: 1 },
    { ...valid, method: 'dsh-im/telegram' }, { ...valid, payload: null },
    { ...valid, payload: { method: 1, payload: {} } },
    { ...valid, payload: { method: 'bot.delete' } },
  ]) {
    const response = await route.fetch(request({ envelope }));
    assert.equal((await response.json()).result.error.code, 'gateway/bad-request');
  }
  assert.equal((await route.fetch(request({ body: '{' }))).status, 400);
  assert.equal((await route.fetch(request({ headers: { 'content-type': 'text/plain' } }))).status, 415);
  assert.equal((await route.fetch(request({ method: 'GET' }))).status, 405);
  assert.equal(calls, 0);
});

test('explicit loopback policy uses original Host headers instead of the internal carrier URL', async () => {
  let calls = 0;
  const route = fixture(async () => { calls += 1; return { ok: true, value: {} }; }, { authority: 'loopback' });
  for (const host of ['localhost', 'localhost:3080', '127.0.0.1:3080', '127.0.0.2', '[::1]:3080']) {
    assert.equal((await route.fetch(request({ headers: { host, origin: `http://${host}` } }))).status, 200);
  }
  for (const headers of [
    { host: '192.168.1.100:3080' }, { host: 'trusted.example' }, { host: 'localhost.evil.test' }, { host: '' },
    { host: 'user@localhost' }, { host: 'localhost/path' },
    { origin: 'http://192.168.1.100:3080' }, { origin: 'https://remote.example' }, { origin: 'null' }, { origin: 'invalid' },
  ]) assert.equal((await route.fetch(request({ headers }))).status, 403);
  assert.equal(calls, 5);
});

test('default and explicit trusted-host policies accept LAN requests already admitted by Harness', async () => {
  for (const authority of [undefined, 'trusted-host']) {
    let calls = 0;
    const route = fixture(async () => { calls += 1; return { ok: true, value: {} }; }, { authority });
    // This fixture starts after Harness browser authentication and Host/Origin checks.
    for (const host of ['localhost:3080', '192.168.1.100:3080', '10.0.0.10:3080', '[fd00::1]:3080', 'trusted.example']) {
      const response = await route.fetch(request({ headers: { host, origin: `http://${host}` } }));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).result.ok, true);
    }
    assert.equal(calls, 5);
  }
  assert.throws(() => fixture(async () => {}, { authority: 'anyone' }), /rpcAuthority/);
});

test('cancellation reaches a running handler and failed calls are never retried', async () => {
  const entered = Promise.withResolvers();
  const abort = new AbortController();
  let calls = 0;
  const route = fixture(async (_method, _payload, signal) => {
    calls += 1;
    entered.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { ok: false, error: { code: 'cancelled', message: 'cancelled' } };
  });
  const pending = route.fetch(request({ signal: abort.signal }));
  await entered.promise;
  abort.abort();
  assert.equal((await (await pending).json()).result.error.code, 'cancelled');
  assert.equal(calls, 1);
  let attempts = 0;
  await assert.rejects(callManagementRpc({ rpc: { async call() { attempts += 1; throw new Error('HTTP 500'); } } }, '/feishu', 'bot.delete', {}), error => error.code === 'management-unreachable' && error.details.stage === 'management.request');
  assert.equal(attempts, 1);
});

test('unexpected handler exceptions do not expose secrets', async () => {
  const route = fixture(async () => { throw new Error('token=private-secret'); });
  const response = await route.fetch(request());
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /private-secret/);
});

test('inbound TTL remains loopback-only with default and explicit trusted-host policies', async () => {
  for (const config of [{}, { rpcAuthority: 'trusted-host' }]) {
    let route;
    installInboundTtlRpc({ connection: { fetch: { register(value) { route = value; return () => {}; } } } }, {
      config,
      runtime: {
        store: { getTtlHours() { return 24; }, async setTtlHours() {} },
        service: { async sweepNow() {} },
      },
    });
    assert.equal((await route.fetch(request({ headers: {
      host: '192.168.1.100:3080', origin: 'http://192.168.1.100:3080',
    } }))).status, 403);
  }
});
