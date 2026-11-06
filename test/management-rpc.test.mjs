import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callManagementRpc, registerManagementRpc } from '../plugin-src/management-rpc.mjs';
import { installInboundTtlRpc } from '../plugin-src/host/inbound-ttl-rpc.mjs';
import { managementFetch } from './fixtures/management-rpc.mjs';

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

test('general settings honor the configured authority for every read, write and sweep', async (t) => {
  for (const rpcAuthority of [undefined, 'trusted-host', 'loopback']) {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-im-management-'));
    t.after(() => rm(dshHome, { recursive: true, force: true }));
    let call;
    let operations = 0;
    let ttlHours = 24;
    let groupHistoryRetentionDays = 14;
    const image = { maxDownloadMb: 30, maxImageMb: 6, maxTotalMb: 20, maxImages: 20 };
    const sweep = { deletedDirectories: 0, sweptWorkspaces: 0 };
    const ctx = { connection: { fetch: managementFetch((_channel, handler) => { call = handler; }) } };
    installInboundTtlRpc(ctx, {
      config: { dshHome, rpcAuthority },
      runtime: {
        store: {
          getTtlHours() { operations += 1; return ttlHours; },
          async setTtlHours(value) { operations += 1; ttlHours = value; return value; },
        },
        service: { async sweepNow() { operations += 1; return sweep; } },
      },
      groupHistory: {
        async settings() { operations += 1; return { groupHistoryRetentionDays }; },
        async setRetentionDays(value) { operations += 1; groupHistoryRetentionDays = value; return { groupHistoryRetentionDays }; },
      },
    });
    const methods = [
      ['settings.inbound-ttl.set', { ttlHours: 48 }, { ttlHours: 48 }],
      ['settings.inbound-ttl.get', {}, { ttlHours: 48 }],
      ['settings.inbound-ttl.sweep', {}, sweep],
      ['settings.image-input.set', image, image],
      ['settings.image-input.get', {}, image],
      ['settings.group-history.set', { groupHistoryRetentionDays: 21 }, { groupHistoryRetentionDays: 21 }],
      ['settings.group-history.get', {}, { groupHistoryRetentionDays: 21 }],
    ];
    for (const host of ['192.168.1.100:3080', 'trusted.example:3080', 'localhost:3080', '127.0.0.1:3080', '[::1]:3080']) {
      const headers = { host, origin: `http://${host}` };
      const rejected = rpcAuthority === 'loopback' && ['192.168.1.100:3080', 'trusted.example:3080'].includes(host);
      for (const [method, payload, value] of methods) {
        if (rejected) await assert.rejects(call(method, payload, undefined, headers), /HTTP 403/);
        else assert.deepEqual(await call(method, payload, undefined, headers), { ok: true, value });
      }
      if (rejected) {
        assert.equal(operations, 0);
        assert.deepEqual(await readdir(dshHome), [], 'denied image writes must not create files');
      }
    }
    assert.ok(operations > 0);
    assert.deepEqual(await call('settings.inbound-ttl.get', {}), { ok: true, value: { ttlHours: 48 } },
      'local clients without Origin remain supported');
  }
});

test('management failures distinguish HTTP status without exposing the transport error or retrying', async () => {
  for (const status of [401, 403, 404, 500, 503, 429]) {
    for (const structured of [false, true]) {
      let attempts = 0;
      const cause = structured ? Object.assign(new Error('token=private-secret'), { status })
        : new Error(`transport failure for /api/dsh-im/feishu: HTTP ${status}`);
      const connection = { rpc: { async call() { attempts += 1; throw cause; } } };
      await assert.rejects(callManagementRpc(connection, '/feishu', 'bot.delete', {}), error => {
        assert.equal(error.code, 'management-unreachable');
        assert.equal(error.cause, cause);
        assert.equal(error.details.httpStatus, status);
        assert.equal(error.details.operation, 'bot.delete');
        assert.equal(error.details.stage, 'management.request');
        assert.ok(Number.isFinite(Date.parse(error.details.occurredAt)));
        assert.doesNotMatch(error.message, /private-secret|transport failure/);
        if (status === 401) assert.match(error.message, /登录/);
        else assert.doesNotMatch(error.message, /重新登录/);
        if (status === 403) assert.match(error.message, /HTTP 403.*权限/);
        if (status === 404) assert.match(error.message, /HTTP 404/);
        if (status >= 500) assert.match(error.message, /服务暂时异常/);
        return true;
      });
      assert.equal(attempts, 1);
    }
  }
});

test('only the exact current RPC transport message supplies a missing HTTP status', async () => {
  const prefix = 'transport failure for /api/dsh-im/feishu: HTTP ';
  for (const cause of [
    new Error('HTTP 403'), new Error('403'), new Error('fetch failed'),
    new Error('transport failure for /api/dsh-im/qq: HTTP 403'),
    new Error(`${prefix}403 token=private-secret`), new Error(`${prefix}403\n`),
    new Error(`${prefix}099`), new Error(`${prefix}600`), new Error(`${prefix}4030`),
    Object.assign(new Error('unknown'), { status: '403' }),
    Object.assign(new Error('unknown'), { status: 403.5 }),
    Object.assign(new Error('unknown'), { status: 600 }),
  ]) {
    await assert.rejects(callManagementRpc({ rpc: { call: async () => { throw cause; } } }, '/feishu', 'bot.delete', {}), error => {
      assert.equal(error.details.httpStatus, undefined);
      assert.doesNotMatch(error.message, /重新登录|HTTP 403|private-secret/);
      return true;
    });
  }
  for (const [status, expected] of [[401, 401], ['401', 403], [600, 403]]) {
    const cause = Object.assign(new Error(`${prefix}403`), { status });
    await assert.rejects(callManagementRpc({ rpc: { call: async () => { throw cause; } } }, '/feishu', 'bot.delete', {}),
      error => error.details.httpStatus === expected);
  }
});

test('management callers preserve business failures and original cancellation errors', async () => {
  const result = { ok: false, error: { code: 'check-expired', message: 'check-expired', details: {} } };
  assert.equal(await callManagementRpc({ rpc: { call: async () => result } }, '/dsh-im', 'update.install', {}), result);
  for (const [cause, signal] of [[new DOMException('Cancelled', 'AbortError'), undefined], [new Error('cancelled'), AbortSignal.abort()]]) {
    await assert.rejects(callManagementRpc({ rpc: { call: async () => { throw cause; } } }, '/dsh-im', 'update.install', {}, signal),
      error => error === cause);
  }
});
