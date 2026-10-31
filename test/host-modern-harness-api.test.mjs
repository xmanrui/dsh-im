import assert from 'node:assert/strict';
import test from 'node:test';

import { harnessConnection } from '../plugin-src/host/harness-connection.mjs';
import { modernHarnessApi } from '../plugin-src/host/modern-harness-api.mjs';
import { HarnessApprovalQueue } from '../src/channels/shared/harness-approval.mjs';
import { HarnessClient, HarnessRpcError } from '../src/channels/shared/harness-client.mjs';
import { classifyMessageFailure } from '../src/channels/shared/message-failure.mjs';

function asyncValues(...values) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* values;
    },
  };
}

test('modern permission adapter reads structured live values without activating an agent', async () => {
  const calls = [];
  let currentValue = 'workspace-write';
  const { ctx } = fakeContext({
    stream() { throw new Error('Permission reads do not need a stream'); },
    async invoke(request) {
      calls.push(request);
      if (request.namespace === 'permissionPresets' && request.method === 'catalog') {
        assert.deepEqual(request.args, {});
        return { options: [{ value: 'workspace-write' }, { value: 'auto' }] };
      }
      if (request.namespace === 'session' && request.method === 'projections') {
        assert.deepEqual(request.args, { request: { sessionId: 'session' } });
        return currentValue === null ? null : { values: { permissions: { currentValue } } };
      }
      throw new Error('Unexpected invocation');
    },
  });
  const harness = new HarnessClient({ ...harnessConnection(ctx), workspace: '/workspace', autostart: false });
  assert.equal((await harness.getSessionPermissions('session')).currentValue, 'workspace-write');
  currentValue = 'auto';
  assert.equal((await harness.getSessionPermissions('session')).currentValue, 'auto');
  currentValue = null;
  await assert.rejects(harness.getSessionPermissions('session'), (error) => error.code === 'session-not-found');
  assert.equal(calls.length, 6);
  assert.ok(calls.every((call) => call.signal instanceof AbortSignal));
});

function fakeContext(gateway) {
  const listeners = new Map();
  const root = {};
  const ctx = {
    root,
    typertGateway: gateway,
    on(event, listener) {
      const entries = listeners.get(event) ?? [];
      entries.push(listener);
      listeners.set(event, entries);
      return () => {
        const index = entries.indexOf(listener);
        if (index >= 0) entries.splice(index, 1);
      };
    },
  };
  return {
    ctx,
    emit(event, ...args) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    },
    waterfall(event, request, next = () => Promise.resolve('delegated')) {
      const [listener] = listeners.get(event) ?? [];
      return listener ? listener(request, next) : next();
    },
  };
}

function catalogFixture() {
  const reads = [];
  let catalog = {
    groups: [{ id: 'provider', name: 'Provider', models: [{ id: 'model', name: 'Model' }] }],
    failures: [],
  };
  let read = () => structuredClone(catalog);
  const { ctx } = fakeContext({
    stream() { assert.fail('model lists do not need streams'); },
    invoke(request) {
      assert.equal(`${request.namespace}/${request.method}`, 'session/modelCatalog');
      assert.deepEqual(request.args, {});
      reads.push(request);
      return read();
    },
  });
  const disposers = [];
  ctx.effect = (setup) => { disposers.push(setup()); };
  const client = () => new HarnessClient({ ...harnessConnection(ctx), workspace: '/workspace' });
  return {
    ctx, reads, client, api: modernHarnessApi(ctx),
    dispose() { for (const dispose of disposers.splice(0).reverse()) dispose(); },
    get catalog() { return catalog; },
    set catalog(value) { catalog = value; },
    set read(value) { read = value; },
  };
}

test('model catalogs share one successful read per Host and expire lazily after 30 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const f = catalogFixture();
  const one = f.client();
  const two = f.client();
  for (let second = 0; second < 60; second += 1) {
    const values = await Promise.all([one.listModels(), two.listModels()]);
    assert.deepEqual(values[0], f.catalog);
    assert.notEqual(values[0], values[1]);
    values[0].groups[0].models[0].name = 'caller mutation';
    t.mock.timers.tick(1_000);
  }
  assert.equal(f.reads.length, 2);
  t.mock.timers.tick(90_000);
  assert.equal(f.reads.length, 2, 'expiry does not start a background refresh');
  assert.deepEqual(await one.listModels(), f.catalog);
  assert.equal(f.reads.length, 3);
  const other = catalogFixture();
  await other.client().listModels();
  assert.equal(other.reads.length, 1, 'different Hosts have independent catalogs');
});

test('concurrent catalog callers share a pending read and TTL starts on success', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const f = catalogFixture();
  const gate = Promise.withResolvers();
  f.read = () => gate.promise;
  const pending = Array.from({ length: 8 }, () => f.client().listModels());
  await new Promise(setImmediate);
  assert.equal(f.reads.length, 1);
  t.mock.timers.tick(20_000);
  gate.resolve(f.catalog);
  await Promise.all(pending);
  t.mock.timers.tick(29_999);
  await f.client().listModels();
  assert.equal(f.reads.length, 1);
  t.mock.timers.tick(1);
  await Promise.all([f.client().listModels(), f.client().listModels()]);
  assert.equal(f.reads.length, 2);
});

test('fresh model reads bypass pending work and prevent late cache repopulation', async () => {
  const f = catalogFixture();
  const client = f.client();
  const old = Promise.withResolvers();
  f.read = () => old.promise;
  const pending = client.listModels();
  await new Promise(setImmediate);
  const latest = { groups: [], failures: [{ id: 'provider', name: 'Unavailable' }] };
  f.read = () => latest;
  assert.deepEqual(await client.listModels({ fresh: true }), latest);
  assert.equal(f.reads.length, 2);
  assert.deepEqual(await client.listModels(), latest);
  old.resolve(f.catalog);
  assert.deepEqual(await pending, f.catalog);
  assert.deepEqual(await client.listModels(), latest);
  assert.equal(f.reads.length, 3, 'late old read must not replace the current cache');
  f.read = () => { throw new Error('fresh failed'); };
  await assert.rejects(client.listModels({ fresh: true }), /fresh failed/);
  f.read = () => f.catalog;
  assert.deepEqual(await client.listModels(), f.catalog);
  assert.equal(f.reads.length, 5, 'failed fresh reads also invalidate cached data');
});

test('failed and malformed catalog reads are retried; valid empty catalogs are cached', async () => {
  const f = catalogFixture();
  const client = f.client();
  f.read = () => { throw new Error('offline'); };
  await assert.rejects(client.listModels(), /offline/);
  f.read = () => ({ groups: null, failures: [] });
  await assert.rejects(client.listModels(), /invalid response/);
  f.read = () => ({ groups: [], failures: [] });
  assert.deepEqual(await client.listModels(), { groups: [], failures: [] });
  await client.listModels();
  assert.equal(f.reads.length, 3);
});

test('catalog cancellation affects only the caller; disposal aborts shared reads', async () => {
  const f = catalogFixture();
  const client = f.client();
  const cancelled = new AbortController();
  cancelled.abort(new Error('already cancelled'));
  await assert.rejects(client.listModels({ signal: cancelled.signal }), /already cancelled/);
  assert.equal(f.reads.length, 0);
  const gate = Promise.withResolvers();
  f.read = () => gate.promise;
  const caller = new AbortController();
  const first = client.listModels({ signal: caller.signal });
  const stopped = assert.rejects(first, /caller stopped/);
  const second = f.client().listModels();
  await new Promise(setImmediate);
  caller.abort(new Error('caller stopped'));
  await stopped;
  assert.equal(f.reads.length, 1);
  assert.equal(f.reads[0].signal.aborted, false);
  gate.resolve(f.catalog);
  assert.deepEqual(await second, f.catalog);

  await client.listModels({ fresh: true });
  const late = Promise.withResolvers();
  f.read = () => late.promise;
  const read = client.listModels();
  const disposed = assert.rejects(read);
  await new Promise(setImmediate);
  f.dispose();
  await disposed;
  assert.equal(f.reads.at(-1).signal.aborted, true);
  late.resolve(f.catalog);
  f.read = () => f.catalog;
  const before = f.reads.length;
  assert.notEqual(modernHarnessApi(f.ctx), f.api);
  await f.client().listModels();
  assert.equal(f.reads.length, before + 1, 'recreated adapter does not retain the old catalog');
});

test('a shared catalog read may complete after its only caller cancels', async () => {
  const f = catalogFixture();
  const gate = Promise.withResolvers();
  f.read = () => gate.promise;
  const caller = new AbortController();
  const pending = f.client().listModels({ signal: caller.signal });
  const stopped = assert.rejects(pending, { name: 'AbortError' });
  await new Promise(setImmediate);
  caller.abort();
  await stopped;
  gate.resolve(f.catalog);
  await new Promise(setImmediate);
  assert.deepEqual(await f.client().listModels(), f.catalog);
  assert.equal(f.reads.length, 1);
});

test('catalog RPC timeout releases the pending slot even when the gateway ignores cancellation', async (t) => {
  const timeouts = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    assert.ok([5_000, 30_000].includes(milliseconds));
    const controller = new AbortController();
    timeouts.push(controller);
    return controller.signal;
  });
  const f = catalogFixture();
  f.read = () => new Promise(() => {});
  const pending = f.client().listModels();
  const timedOut = assert.rejects(pending, { code: 'harness-timeout' });
  await new Promise(setImmediate);
  timeouts.at(-1).abort(new DOMException('Timed out', 'TimeoutError'));
  await timedOut;
  f.read = () => f.catalog;
  assert.deepEqual(await f.client().listModels(), f.catalog);
  assert.equal(f.reads.length, 2);
});

test('modern workspace baseline detects an archived binding without loading its Session', async () => {
  const calls = [];
  const { ctx } = fakeContext({
    invoke() { assert.fail('an archived Session must not be loaded or prompted'); },
    stream(request) {
      calls.push(`${request.namespace}/${request.method}`);
      assert.equal(calls.at(-1), 'workspace/follow');
      return asyncValues({ type: 'baseline', value: { items: [], archivedSessionIds: ['archived-session'] } });
    },
  });
  const client = new HarnessClient({ ...harnessConnection(ctx), workspace: '/workspace', autostart: false });
  assert.equal(await client.sessionExists('archived-session'), true);
  await assert.rejects(client.ask('archived-session', 'hello'), { code: 'session-archived' });
  assert.deepEqual(calls, ['workspace/follow', 'workspace/follow']);
});

function sessionFixture(api, id = 'session') {
  const events = [];
  if (api === 'snapshotEvents') {
    return {
      events,
      session: {
        id,
        snapshotEvents: () => Object.freeze([...events]),
      },
    };
  }
  if (api === 'events') return { events, session: { id, events } };
  if (api === 'both') {
    return {
      events,
      session: {
        id,
        events: [],
        snapshotEvents: () => Object.freeze([...events]),
      },
    };
  }
  throw new TypeError(`unsupported Session API fixture: ${api}`);
}

function forEachSessionApi(interaction, run) {
  for (const sessionApi of ['snapshotEvents', 'events', 'both']) {
    test(
      `modern adapter routes ${interaction} through ${sessionApi} only to the active dsh-im turn`,
      () => run(sessionApi),
    );
  }
}

test('modern adapter maps the narrow legacy API without changing HarnessClient', async () => {
  const calls = [];
  let pageCalls = 0;
  const catalog = {
    default: { provider: 'deepseek', model: 'chat' },
    routableProviders: ['deepseek'],
    groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat' }] }],
    failures: [],
  };
  const gateway = {
    async invoke(request) {
      calls.push(request);
      const endpoint = `${request.namespace}/${request.method}`;
      if (endpoint === 'workspace/create') {
        return { workspace: { workspaceId: 'workspace', path: request.args.request.path }, created: true };
      }
      if (endpoint === 'session/list') {
        return {
          items: [{
            sessionId: 'session', running: false, blank: false,
            projections: {
              asOfSeq: 8,
              values: {
                modelSelection: {
                  lastUsed: { provider: 'deepseek', model: 'chat' },
                  next: null,
                },
              },
            },
          }],
        };
      }
      if (endpoint === 'session/modelCatalog') return catalog;
      if (endpoint === 'session/page') {
        pageCalls += 1;
        return {
          records: [{
            type: 'event',
            event: { type: 'turn/end', seq: 8, time: 8, data: { turn: 1, reason: { kind: 'completed' } } },
          }],
          hasMore: false,
        };
      }
      if (endpoint === 'session/prompt') return { accepted: true };
      if (endpoint === 'session/rename') {
        return { title: request.args.request.title, seq: 9 };
      }
      if (endpoint === 'session/cancel') return { accepted: true };
      if (endpoint === 'session/selectModel') return { selected: request.args.request };
      throw new Error(`unexpected invoke ${endpoint}`);
    },
    async stream(request) {
      calls.push(request);
      const endpoint = `${request.namespace}/${request.method}`;
      if (endpoint === 'workspace/follow') {
        return asyncValues({
          type: 'baseline',
          value: {
            items: [{ workspaceId: 'workspace', path: '/workspace', sessionIds: ['session'] }],
            archivedSessionIds: [],
          },
        });
      }
      if (endpoint === 'session/follow') {
        return asyncValues({
          type: 'snapshot',
          cursor: 7,
          records: [{
            type: 'chunks',
            event: {
              type: 'chunkrow/text-chunks',
              seq: 5,
              time: 100,
              data: { turn: 1, step: 0, index: 0, texts: ['a', 'b', 'c'], dt: [1, 2] },
            },
          }],
          hasMore: true,
          projections: { asOfSeq: 7, values: {} },
        });
      }
      throw new Error(`unexpected stream ${endpoint}`);
    },
  };
  const { ctx } = fakeContext(gateway);
  const first = harnessConnection(ctx);
  const second = harnessConnection(ctx);
  assert.equal(first.apiProxy, second.apiProxy);
  assert.equal(first.interactionScope, ctx.root);

  const workspace = await first.apiProxy.workspace.list({ rpcId: 'workspace-list', payload: {} });
  assert.equal(workspace.result.value.items[0].path, '/workspace');

  const history = await first.apiProxy.sessions.history({
    rpcId: 'history-one', payload: { sessionId: 'session', maxMessages: 50 },
  });
  assert.deepEqual(history.result.value.events.map(({ event }) => [
    event.seq, event.time, event.data.chunk.text,
  ]), [[5, 100, 'a'], [6, 101, 'b'], [7, 103, 'c']]);
  assert.equal(history.result.value.projections.asOfSeq, 7);

  const nextHistory = await first.apiProxy.sessions.history({
    rpcId: 'history-two', payload: { sessionId: 'session', maxMessages: 50 },
  });
  assert.equal(nextHistory.result.value.events[0].event.seq, 8);
  assert.equal(pageCalls, 1);

  const models = await first.apiProxy.sessions.models({
    rpcId: 'models', payload: { sessionId: 'session' },
  });
  assert.deepEqual(models.result.value.current, { provider: 'deepseek', model: 'chat' });
  assert.equal(models.result.value.routable, true);

  await first.apiProxy.sessions.prompt({
    rpcId: 'prompt-correlation',
    payload: { sessionId: 'session', mode: 'queue', content: [{ type: 'text', text: 'hi' }] },
  });
  const promptCall = calls.find((call) => call.namespace === 'session' && call.method === 'prompt');
  assert.equal(promptCall.args.request.requestId, 'prompt-correlation');
  assert.equal(Object.hasOwn(promptCall.args.request, 'rpcId'), false);

  const renamed = await first.apiProxy.sessions.rename({
    rpcId: 'rename-correlation',
    payload: { sessionId: 'session', title: '订单查询' },
  });
  assert.deepEqual(renamed.result.value, { title: '订单查询', seq: 9 });
  const renameCall = calls.find((call) => call.namespace === 'session' && call.method === 'rename');
  assert.deepEqual(renameCall.args, {
    request: { sessionId: 'session', title: '订单查询' },
  });
});

test('sessions.fork forwards session.fork and passes atSeq through only when given', async () => {
  const calls = [];
  const { ctx } = fakeContext({
    async invoke({ namespace, method, args }) {
      calls.push({ namespace, method, args });
      assert.equal(namespace, 'session');
      assert.equal(method, 'fork');
      return { sessionId: 'child', seq: 5 };
    },
    async stream() { throw new Error('unused'); },
  });
  const { apiProxy } = harnessConnection(ctx);

  await apiProxy.sessions.fork({ rpcId: 'fork-with-seq', payload: { sessionId: 'parent', atSeq: 9 } });
  await apiProxy.sessions.fork({ rpcId: 'fork-latest', payload: { sessionId: 'parent' } });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, { request: { sessionId: 'parent', atSeq: 9 } });
  assert.deepEqual(calls[1].args, { request: { sessionId: 'parent' } });
  assert.equal(Object.hasOwn(calls[1].args.request, 'atSeq'), false, 'atSeq is omitted when absent');
});

test('queue and steer omit an unresolved time zone at the in-process gateway boundary', async (t) => {
  t.mock.method(Intl, 'DateTimeFormat', () => ({ resolvedOptions: () => ({ timeZone: undefined }) }));
  const events = [];
  const requests = [];
  const admitted = Promise.withResolvers();
  const { ctx } = fakeContext({
    async invoke({ namespace, method, args }) {
      assert.equal(namespace, 'session');
      if (method === 'page') {
        return { records: events.map(event => ({ type: 'event', event })), hasMore: false };
      }
      assert.equal(method, 'prompt');
      const request = args.request;
      requests.push(request);
      assert.equal(Object.hasOwn(request, 'clientTimeZone'), false);
      if (request.mode === 'queue') {
        events.push(
          { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
          { type: 'user/message', seq: 1, time: 1,
            data: { turn: 1, source: { kind: 'user', rpcId: request.requestId } } },
        );
        admitted.resolve();
      }
      return { accepted: true };
    },
    stream({ namespace, method }) {
      if (namespace === 'workspace' && method === 'follow') {
        return asyncValues({ type: 'baseline', value: { items: [], archivedSessionIds: [] } });
      }
      assert.equal(`${namespace}/${method}`, 'session/follow');
      return asyncValues({ type: 'snapshot', cursor: -1, records: [], hasMore: false });
    },
  });
  const client = new HarnessClient({ ...harnessConnection(ctx), workspace: '/workspace' });
  const control = { owner: {}, key: 'time-zone' };
  const asking = client.ask('session', 'hello', { control, timeoutMs: 2_000 });
  try {
    await Promise.race([admitted.promise, asking]);
    assert.equal(await client.steerActiveTurn('session', 'continue', control), true);
    assert.deepEqual(requests.map(request => request.mode), ['queue', 'steer']);
    assert.ok(requests.every(request => typeof request.requestId === 'string'));
  } finally {
    events.push(
      { type: 'assistant/message', seq: 2, time: 2,
        data: { turn: 1, message: { content: [{ type: 'text', text: 'done' }] } } },
      { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    );
    assert.equal(await asking, 'done');
  }
});

test('modern adapter preserves gateway validation failures through message classification', async () => {
  const { ctx } = fakeContext({
    async invoke() {
      throw Object.assign(new Error('boundary validation failed'), {
        failure: { code: 'gateway/input-invalid', message: 'boundary validation failed', details: { field: 'request' } },
      });
    },
    stream() { throw new Error('unused'); },
  });
  const client = new HarnessClient({ ...harnessConnection(ctx), workspace: '/workspace' });
  await assert.rejects(client.rpc('session.prompt', { sessionId: 'session' }), error => {
    assert.ok(error instanceof HarnessRpcError);
    assert.equal(error.code, 'gateway/input-invalid');
    assert.equal(error.details.field, 'request');
    const failure = classifyMessageFailure(error);
    assert.equal(failure.code, 'HARNESS_PROTOCOL');
    assert.equal(failure.reason, 'GATEWAY_INPUT_INVALID');
    return true;
  });
});

test('modern adapter preserves Typert business failures as Harness RPC errors', async () => {
  const gateway = {
    async invoke() {
      const error = new Error('missing');
      error.failure = {
        code: 'session-not-found',
        message: 'missing',
        details: { sessionId: 'missing' },
      };
      throw error;
    },
    async stream() { throw new Error('unused'); },
  };
  const { ctx } = fakeContext(gateway);
  const client = new HarnessClient({
    apiProxy: modernHarnessApi(ctx),
    interactionScope: ctx.root,
    workspace: '/workspace',
  });
  await assert.rejects(
    () => client.rpc('session.list'),
    (error) => error instanceof HarnessRpcError
      && error.code === 'session-not-found'
      && error.details.sessionId === 'missing',
  );
});

test('modern adapter preserves direct DSH RemoteErrors through message classification', async () => {
  const sourceError = Object.assign(new Error('preset "removed" not found'), {
    name: 'RemoteError',
    isDSHRemoteError: true,
    code: 'agent-preset/not-found',
    details: { agentPreset: 'removed', available: ['standard'] },
  });
  const { ctx } = fakeContext({
    async invoke() { throw sourceError; },
    async stream() { throw new Error('unused'); },
  });
  const client = new HarnessClient({ apiProxy: modernHarnessApi(ctx), workspace: '/workspace' });
  await assert.rejects(() => client.rpc('session.prompt', { sessionId: 'session', text: 'test' }), (error) => {
    assert.ok(error instanceof HarnessRpcError);
    assert.equal(error.code, sourceError.code);
    assert.deepEqual(error.details, sourceError.details);
    const failure = classifyMessageFailure(error);
    assert.equal(failure.code, 'PRESET_UNAVAILABLE');
    assert.equal(failure.reason, 'AGENT_PRESET_NOT_FOUND');
    return true;
  });
});

test('modern adapter keeps unmarked internal errors internal', async () => {
  const { ctx } = fakeContext({
    async invoke() { throw Object.assign(new Error('local error'), { code: 'agent-preset/not-found' }); },
    async stream() { throw new Error('unused'); },
  });
  const client = new HarnessClient({ apiProxy: modernHarnessApi(ctx), workspace: '/workspace' });
  await assert.rejects(() => client.rpc('session.prompt', { sessionId: 'session', text: 'test' }), {
    code: 'internal',
  });
});

test('modern adapter retains safe transport evidence through Harness RPC and message classification', async () => {
  for (const [sourceError, expected] of [
    [new DOMException('private timeout detail', 'TimeoutError'), 'REQUEST_TIMEOUT'],
    [new TypeError('private URL and token', { cause: new AggregateError([
      Object.assign(new Error('private DNS detail'), { code: 'ENOTFOUND' }),
      Object.assign(new Error('private socket detail'), { code: 'ECONNREFUSED' }),
    ]) }), 'NETWORK_ERROR'],
  ]) {
    sourceError.durationMs = 123;
    sourceError.timeoutMs = 100;
    const { ctx } = fakeContext({
      async invoke() { throw sourceError; },
      async stream() { throw new Error('unused'); },
    });
    const client = new HarnessClient({ apiProxy: modernHarnessApi(ctx), workspace: '/workspace' });
    await assert.rejects(() => client.rpc('session.prompt', { sessionId: 'session', text: 'test' }), error => {
      assert.equal(error.code, 'internal');
      assert.equal(error.details.durationMs, 123);
      assert.equal(error.details.timeoutMs, 100);
      const failure = classifyMessageFailure(error);
      assert.equal(failure.code, expected);
      assert.match(failure.message, /不要立即重复提交/u);
      if (expected === 'NETWORK_ERROR') assert.deepEqual(failure.details.reasons, ['ENOTFOUND', 'ECONNREFUSED']);
      assert.doesNotMatch(JSON.stringify(failure), /private|token/u);
      return true;
    });
  }
});

test('modern adapter exposes DSH v2 live assistant chunks through legacy history', async () => {
  const records = [
    {
      type: 'event',
      event: { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    },
    {
      type: 'event',
      event: {
        type: 'user/message', seq: 1, time: 1,
        data: { turn: 1, source: { kind: 'user', rpcId: 'prompt' }, message: { content: [] } },
      },
    },
  ];
  const gateway = {
    async invoke(request) {
      if (`${request.namespace}/${request.method}` !== 'session/page') {
        throw new Error('unexpected invoke');
      }
      return { records, hasMore: false };
    },
    async stream(request) {
      if (`${request.namespace}/${request.method}` === 'workspace/follow') {
        return asyncValues({ type: 'baseline', value: { items: [], archivedSessionIds: [] } });
      }
      if (`${request.namespace}/${request.method}` !== 'session/follow') {
        throw new Error('unexpected stream');
      }
      return asyncValues({
        type: 'snapshot', cursor: 1, records, hasMore: false,
        projections: { asOfSeq: 1, values: {} },
      });
    },
  };
  const fixture = fakeContext(gateway);
  const api = modernHarnessApi(fixture.ctx);
  const muxController = new AbortController();
  const mux = api.events.mux(
    { rpcId: 'live-events', payload: {} },
    muxController.signal,
  )[Symbol.asyncIterator]();

  await api.sessions.history({ rpcId: 'baseline', payload: { sessionId: 'session' } });
  const agent = { session: { id: 'session', seq: 2 } };
  fixture.emit('agent/assistant-stream', {
    agent,
    frame: {
      type: 'start', attemptId: 'session:1', revision: 1, turn: 1, step: 1,
    },
  });
  const firstLiveFrame = mux.next();
  fixture.emit('agent/assistant-stream', {
    agent,
    frame: {
      type: 'chunk', attemptId: 'session:1', revision: 2, index: 0, time: 2,
      chunk: { type: 'text-delta', index: 0, text: '你好' },
    },
  });
  const secondLiveFrame = mux.next();
  fixture.emit('agent/assistant-stream', {
    agent,
    frame: {
      type: 'chunk', attemptId: 'session:1', revision: 3, index: 1, time: 3,
      chunk: { type: 'text-delta', index: 0, text: '，世界' },
    },
  });

  const live = await api.sessions.history({
    rpcId: 'live', payload: { sessionId: 'session' },
  });
  const chunks = live.result.value.events.filter(
    ({ event }) => event.type === 'assistant/chunk',
  );
  assert.deepEqual(chunks.map(({ event }) => event.data.chunk.text), ['你好', '，世界']);
  assert.ok(chunks.every(({ event }) => event.seq > 1 && event.seq < 2));
  assert.ok(chunks[0].event.seq < chunks[1].event.seq);
  assert.deepEqual(
    (await Promise.all([firstLiveFrame, secondLiveFrame]))
      .map(({ value }) => value.payload.event),
    chunks.map(({ event }) => event),
    'transient chunks must also reach mux consumers before history drops them',
  );

  fixture.emit('agent/assistant-stream', {
    agent,
    frame: {
      type: 'end', attemptId: 'session:1', revision: 4, index: 2,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: 2 },
    },
  });
  const settled = await api.sessions.history({
    rpcId: 'settled', payload: { sessionId: 'session' },
  });
  assert.equal(settled.result.value.events.some(
    ({ event }) => event.type === 'assistant/chunk',
  ), false);
  muxController.abort();
  await mux.return();
});

forEachSessionApi('an approval', async (sessionApi) => {
  const { events, session } = sessionFixture(sessionApi);
  const eventRecord = (event) => ({ type: 'event', event });
  let fixture;
  let turnTask;
  const append = (event) => {
    events.push(event);
    fixture.emit('session/event', session, event);
  };
  const gateway = {
    async invoke(request) {
      const endpoint = `${request.namespace}/${request.method}`;
      if (endpoint === 'session/page') {
        return { records: events.map(eventRecord), hasMore: false };
      }
      if (endpoint === 'session/prompt') {
        const rpcId = request.args.request.requestId;
        turnTask = (async () => {
          append({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } });
          append({
            type: 'user/message', seq: 1, time: 1,
            data: { turn: 1, source: { kind: 'user', rpcId }, message: { content: [] } },
          });
          append({
            type: 'approval/asked', seq: 2, time: 2,
            data: { id: 'approval-one', toolName: 'bash', callId: 'call-one' },
          });
          const outcome = await fixture.waterfall('approval/request', {
            agent: { id: 'session', session },
            toolName: 'bash',
            callId: 'call-one',
          }, () => Promise.resolve('unavailable'));
          append({
            type: 'approval/decided', seq: 3, time: 3,
            data: { id: 'approval-one', outcome },
          });
          append({
            type: 'assistant/message', seq: 4, time: 4,
            data: { turn: 1, message: { content: [{ type: 'text', text: 'approved' }] } },
          });
          append({
            type: 'turn/end', seq: 5, time: 5,
            data: { turn: 1, reason: { kind: 'completed' } },
          });
        })();
        return { accepted: true };
      }
      throw new Error(`unexpected invoke ${endpoint}`);
    },
    async stream(request) {
      if (`${request.namespace}/${request.method}` === 'workspace/follow') {
        return asyncValues({ type: 'baseline', value: { items: [], archivedSessionIds: [] } });
      }
      if (`${request.namespace}/${request.method}` !== 'session/follow') {
        throw new Error('unexpected stream');
      }
      return asyncValues({
        type: 'snapshot', cursor: -1, records: [], hasMore: false,
        projections: { asOfSeq: -1, values: {} },
      });
    },
  };
  fixture = fakeContext(gateway);
  const connection = harnessConnection(fixture.ctx);
  const client = new HarnessClient({
    ...connection,
    workspace: '/workspace',
    rpcIdPrefix: 'modern-test',
    logPrefix: 'modern-test',
  });
  const interactions = [];
  const resolutions = [];
  const answer = await client.ask('session', 'approve it', {
    timeoutMs: 5_000,
    onInteraction: async (interaction) => {
      interactions.push(interaction);
      await interaction.respond({
        ok: true,
        value: {
          sessionId: interaction.sessionId,
          approvalId: interaction.payload.approvalId,
          outcome: 'allowed-once',
        },
      });
    },
    onInteractionResolved: (resolution) => resolutions.push(resolution),
  });
  await turnTask;
  assert.equal(answer, 'approved');
  assert.equal(interactions.length, 1);
  assert.equal(interactions[0].kind, 'approval');
  assert.equal(events[3].data.outcome, 'allowed-once');
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].kind, 'approval');
  assert.equal(resolutions[0].outcome, 'allowed-once');

  const other = sessionFixture(sessionApi, 'other').session;
  const delegated = await fixture.waterfall('approval/request', {
    agent: { id: 'other', session: other },
    toolName: 'bash',
  }, () => Promise.resolve('browser-owned'));
  assert.equal(delegated, 'browser-owned');
});

forEachSessionApi('structured questions', async (sessionApi) => {
  const { events, session } = sessionFixture(sessionApi);
  const eventRecord = (event) => ({ type: 'event', event });
  let fixture;
  let turnTask;
  let structuredAnswer;
  const append = (event) => {
    events.push(event);
    fixture.emit('session/event', session, event);
  };
  const gateway = {
    async invoke(request) {
      const endpoint = `${request.namespace}/${request.method}`;
      if (endpoint === 'session/page') {
        return { records: events.map(eventRecord), hasMore: false };
      }
      if (endpoint === 'session/prompt') {
        const rpcId = request.args.request.requestId;
        turnTask = (async () => {
          append({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } });
          append({
            type: 'user/message', seq: 1, time: 1,
            data: { turn: 1, source: { kind: 'user', rpcId }, message: { content: [] } },
          });
          structuredAnswer = await fixture.waterfall('user-questions/request', {
            agent: { id: 'session', session },
            questions: [{
              id: 'environment',
              question: 'Choose an environment',
              options: [{ label: 'Test' }, { label: 'Production' }],
            }],
          }, () => Promise.reject(new Error('unavailable')));
          append({
            type: 'assistant/message', seq: 2, time: 2,
            data: { turn: 1, message: { content: [{ type: 'text', text: 'question answered' }] } },
          });
          append({
            type: 'turn/end', seq: 3, time: 3,
            data: { turn: 1, reason: { kind: 'completed' } },
          });
        })();
        return { accepted: true };
      }
      throw new Error(`unexpected invoke ${endpoint}`);
    },
    async stream(request) {
      if (`${request.namespace}/${request.method}` === 'workspace/follow') {
        return asyncValues({ type: 'baseline', value: { items: [], archivedSessionIds: [] } });
      }
      if (`${request.namespace}/${request.method}` !== 'session/follow') {
        throw new Error('unexpected stream');
      }
      return asyncValues({
        type: 'snapshot', cursor: -1, records: [], hasMore: false,
        projections: { asOfSeq: -1, values: {} },
      });
    },
  };
  fixture = fakeContext(gateway);
  const client = new HarnessClient({
    ...harnessConnection(fixture.ctx),
    workspace: '/workspace',
    rpcIdPrefix: 'modern-question-test',
    logPrefix: 'modern-question-test',
  });
  const interactions = [];
  const resolutions = [];
  const answer = await client.ask('session', 'ask a question', {
    timeoutMs: 5_000,
    onInteraction: async (interaction) => {
      interactions.push(interaction);
      await interaction.respond({
        ok: true,
        value: {
          sessionId: interaction.sessionId,
          answer: { answers: [{ id: 'environment', selected: ['Test'] }] },
        },
      });
    },
    onInteractionResolved: (resolution) => resolutions.push(resolution),
  });
  await turnTask;
  assert.equal(answer, 'question answered');
  assert.equal(interactions.length, 1);
  assert.equal(interactions[0].kind, 'question');
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].kind, 'question');
  assert.equal(resolutions[0].outcome, 'answered');
  assert.deepEqual(structuredAnswer, {
    answers: [{ id: 'environment', selected: ['Test'] }],
  });

  const other = sessionFixture(sessionApi, 'other').session;
  const delegated = await fixture.waterfall('user-questions/request', {
    agent: { id: 'other', session: other },
    questions: [{ id: 'other', question: 'Browser-owned?' }],
  }, () => Promise.resolve({ answers: [{ id: 'other', selected: [], custom: 'yes' }] }));
  assert.deepEqual(delegated, {
    answers: [{ id: 'other', selected: [], custom: 'yes' }],
  });
});

test('modern adapter delegates interactions when a Session exposes no readable events', async () => {
  const gateway = {
    async invoke() { throw new Error('unused'); },
    async stream() { throw new Error('unused'); },
  };
  const fixture = fakeContext(gateway);
  modernHarnessApi(fixture.ctx);
  const session = { id: 'unsupported' };

  const approval = await fixture.waterfall('approval/request', {
    agent: { id: session.id, session },
    toolName: 'bash',
  }, () => Promise.resolve('browser-owned'));
  assert.equal(approval, 'browser-owned');

  const questionAnswer = { answers: [{ id: 'other', selected: [], custom: 'yes' }] };
  const question = await fixture.waterfall('user-questions/request', {
    agent: { id: session.id, session },
    questions: [{ id: 'other', question: 'Browser-owned?' }],
  }, () => Promise.resolve(questionAnswer));
  assert.deepEqual(question, questionAnswer);
});

forEachSessionApi('concurrent questions', async (sessionApi) => {
  const { events, session } = sessionFixture(sessionApi);
  const eventRecord = (event) => ({ type: 'event', event });
  let fixture;
  let turnTask;
  const append = (event) => {
    events.push(event);
    fixture.emit('session/event', session, event);
  };
  const browserAnswer = { answers: [{ id: 'environment', selected: ['Production'] }] };
  const gateway = {
    async invoke(request) {
      const endpoint = `${request.namespace}/${request.method}`;
      if (endpoint === 'session/page') {
        return { records: events.map(eventRecord), hasMore: false };
      }
      if (endpoint === 'session/prompt') {
        const rpcId = request.args.request.requestId;
        turnTask = (async () => {
          append({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } });
          append({
            type: 'user/message', seq: 1, time: 1,
            data: { turn: 1, source: { kind: 'user', rpcId }, message: { content: [] } },
          });
          // The host answers; the IM side is offered the question but stays silent.
          const raced = await fixture.waterfall('user-questions/request', {
            agent: { id: 'session', session },
            questions: [{
              id: 'environment',
              question: 'Choose an environment',
              options: [{ label: 'Test' }, { label: 'Production' }],
            }],
          }, () => Promise.resolve(browserAnswer));
          assert.deepEqual(raced, browserAnswer);
          append({
            type: 'assistant/message', seq: 2, time: 2,
            data: { turn: 1, message: { content: [{ type: 'text', text: 'answered by the host' }] } },
          });
          append({
            type: 'turn/end', seq: 3, time: 3,
            data: { turn: 1, reason: { kind: 'completed' } },
          });
        })();
        return { accepted: true };
      }
      throw new Error(`unexpected invoke ${endpoint}`);
    },
    async stream(request) {
      if (`${request.namespace}/${request.method}` === 'workspace/follow') {
        return asyncValues({ type: 'baseline', value: { items: [], archivedSessionIds: [] } });
      }
      if (`${request.namespace}/${request.method}` !== 'session/follow') {
        throw new Error('unexpected stream');
      }
      return asyncValues({
        type: 'snapshot', cursor: -1, records: [], hasMore: false,
        projections: { asOfSeq: -1, values: {} },
      });
    },
  };
  fixture = fakeContext(gateway);
  const client = new HarnessClient({
    ...harnessConnection(fixture.ctx),
    workspace: '/workspace',
    rpcIdPrefix: 'modern-race-test',
    logPrefix: 'modern-race-test',
  });
  const interactions = [];
  const resolutions = [];
  const answer = await client.ask('session', 'ask a question', {
    timeoutMs: 5_000,
    onInteraction: async (interaction) => { interactions.push(interaction); },
    onInteractionResolved: (resolution) => resolutions.push(resolution),
  });
  await turnTask;

  assert.equal(answer, 'answered by the host');
  assert.equal(interactions.length, 1, 'IM is still offered an active-turn question');
  assert.equal(resolutions.length, 1, 'the IM pending is retired once the host answers');
  assert.equal(resolutions[0].outcome, 'cancelled');
});

forEachSessionApi('questions answered on IM', async (sessionApi) => {
  const { events, session } = sessionFixture(sessionApi);
  const eventRecord = (event) => ({ type: 'event', event });
  let fixture;
  let turnTask;
  let turnRetiredByAbort = 0;
  let questionSignal;
  let questionRetiredByAbort = 0;
  let programController;
  let turnSignal;
  const append = (event) => {
    events.push(event);
    fixture.emit('session/event', session, event);
  };
  const gateway = {
    async invoke(request) {
      const endpoint = `${request.namespace}/${request.method}`;
      if (endpoint === 'session/page') {
        return { records: events.map(eventRecord), hasMore: false };
      }
      if (endpoint === 'session/prompt') {
        const rpcId = request.args.request.requestId;
        turnTask = (async () => {
          append({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } });
          append({
            type: 'user/message', seq: 1, time: 1,
            data: { turn: 1, source: { kind: 'user', rpcId }, message: { content: [] } },
          });
          const controller = new AbortController();
          turnSignal = controller.signal;
          controller.signal.addEventListener('abort', () => { turnRetiredByAbort += 1; });
          // Every tool call in one turn receives the same turn-level signal, and a
          // PTC program waiting on this answer subscribes to it by EVENT rather than
          // by polling `signal.aborted`: `run_code` flips its own program controller
          // from an abort listener (dsh-tools `onOuterAbort`), and the worker code
          // runtime retires the worker the same way
          // (dsh-code-runtime-worker-thread `onAbort`). This controller stands in for
          // the program that is merely waiting for the answer.
          programController = new AbortController();
          controller.signal.addEventListener('abort', () => {
            programController.abort('run_code run is over');
          });
          const request = {
            agent: { id: 'session', session },
            signal: controller.signal,
            questions: [{
              id: 'environment',
              question: 'Choose an environment',
              options: [{ label: 'Test' }, { label: 'Production' }],
            }],
          };
          const answer = await fixture.waterfall('user-questions/request', request, () => {
            // What a host-side Remote/Web forwarder holds: it projects
            // `request.signal` and drops its card when that lifetime ends.
            questionSignal = request.signal;
            questionSignal.addEventListener('abort', () => { questionRetiredByAbort += 1; }, { once: true });
            if (questionSignal.aborted) questionRetiredByAbort += 1;
            return new Promise(() => {});
          });
          assert.deepEqual(answer, {
            answers: [{ id: 'environment', selected: ['Test'] }],
          });
          append({
            type: 'assistant/message', seq: 2, time: 2,
            data: { turn: 1, message: { content: [{ type: 'text', text: 'answered on IM' }] } },
          });
          append({
            type: 'turn/end', seq: 3, time: 3,
            data: { turn: 1, reason: { kind: 'completed' } },
          });
        })();
        return { accepted: true };
      }
      throw new Error(`unexpected invoke ${endpoint}`);
    },
    async stream(request) {
      if (`${request.namespace}/${request.method}` === 'workspace/follow') {
        return asyncValues({ type: 'baseline', value: { items: [], archivedSessionIds: [] } });
      }
      if (`${request.namespace}/${request.method}` !== 'session/follow') {
        throw new Error('unexpected stream');
      }
      return asyncValues({
        type: 'snapshot', cursor: -1, records: [], hasMore: false,
        projections: { asOfSeq: -1, values: {} },
      });
    },
  };
  fixture = fakeContext(gateway);
  const client = new HarnessClient({
    ...harnessConnection(fixture.ctx),
    workspace: '/workspace',
    rpcIdPrefix: 'modern-im-answer-test',
    logPrefix: 'modern-im-answer-test',
  });
  const answer = await client.ask('session', 'ask a question', {
    timeoutMs: 5_000,
    onInteraction: async (interaction) => {
      await interaction.respond({
        ok: true,
        value: {
          sessionId: interaction.sessionId,
          answer: { answers: [{ id: 'environment', selected: ['Test'] }] },
        },
      });
    },
  });
  await turnTask;

  assert.equal(answer, 'answered on IM');
  // Retirement is local to this question: the turn signal is shared with every other
  // tool execution in the turn, so broadcasting on it would also stop a `run_code`
  // program that is merely waiting for this answer.
  assert.equal(programController.signal.aborted, false, 'a program waiting on the answer must survive an IM answer');
  assert.equal(turnRetiredByAbort, 0, 'an IM answer must not broadcast an abort on the shared turn signal');
  assert.notEqual(questionSignal, turnSignal, 'the question must own its lifetime, not borrow the turn signal');
  // The host answerer is still holding the question open here (its own pending
  // never settles), and a host-side adapter has no other handle on it. Without a
  // retirement a Web client watching the same Session keeps a card offering choices
  // for a question already answered on IM, so the question's own lifetime must end.
  assert.equal(questionRetiredByAbort, 1, 'an IM answer must retire the question lifetime a Web card holds');
});

forEachSessionApi('questions answered by the host', async (sessionApi) => {
  const { events, session } = sessionFixture(sessionApi);
  const eventRecord = (event) => ({ type: 'event', event });
  let fixture;
  let turnTask;
  let retiredByAbort = 0;
  let questionRetiredByAbort = 0;
  const append = (event) => {
    events.push(event);
    fixture.emit('session/event', session, event);
  };
  const hostAnswer = { answers: [{ id: 'environment', selected: ['Test'] }] };
  const gateway = {
    async invoke(request) {
      const endpoint = `${request.namespace}/${request.method}`;
      if (endpoint === 'session/page') {
        return { records: events.map(eventRecord), hasMore: false };
      }
      if (endpoint === 'session/prompt') {
        const rpcId = request.args.request.requestId;
        turnTask = (async () => {
          append({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } });
          append({
            type: 'user/message', seq: 1, time: 1,
            data: { turn: 1, source: { kind: 'user', rpcId }, message: { content: [] } },
          });
          const controller = new AbortController();
          controller.signal.addEventListener('abort', () => { retiredByAbort += 1; });
          // The host answers first, exactly as the Web client does when the person
          // looking at the Session presses an option before touching Telegram.
          const request = {
            agent: { id: 'session', session },
            signal: controller.signal,
            questions: [{
              id: 'environment',
              question: 'Choose an environment',
              options: [{ label: 'Test' }, { label: 'Production' }],
            }],
          };
          const answer = await fixture.waterfall('user-questions/request', request, () => {
            request.signal.addEventListener('abort', () => { questionRetiredByAbort += 1; }, { once: true });
            if (request.signal.aborted) questionRetiredByAbort += 1;
            return Promise.resolve(hostAnswer);
          });
          assert.deepEqual(answer, hostAnswer);
          append({
            type: 'assistant/message', seq: 2, time: 2,
            data: { turn: 1, message: { content: [{ type: 'text', text: 'answered by the host' }] } },
          });
          append({
            type: 'turn/end', seq: 3, time: 3,
            data: { turn: 1, reason: { kind: 'completed' } },
          });
        })();
        return { accepted: true };
      }
      throw new Error(`unexpected invoke ${endpoint}`);
    },
    async stream(request) {
      if (`${request.namespace}/${request.method}` === 'workspace/follow') {
        return asyncValues({ type: 'baseline', value: { items: [], archivedSessionIds: [] } });
      }
      if (`${request.namespace}/${request.method}` !== 'session/follow') {
        throw new Error('unexpected stream');
      }
      return asyncValues({
        type: 'snapshot', cursor: -1, records: [], hasMore: false,
        projections: { asOfSeq: -1, values: {} },
      });
    },
  };
  fixture = fakeContext(gateway);
  const client = new HarnessClient({
    ...harnessConnection(fixture.ctx),
    workspace: '/workspace',
    rpcIdPrefix: 'modern-host-answer-test',
    logPrefix: 'modern-host-answer-test',
  });
  const interactions = [];
  const resolutions = [];
  const answer = await client.ask('session', 'ask a question', {
    timeoutMs: 5_000,
    onInteraction: async (interaction) => { interactions.push(interaction); },
    onInteractionResolved: (resolution) => resolutions.push(resolution),
  });
  await turnTask;

  assert.equal(answer, 'answered by the host');
  assert.equal(interactions.length, 1, 'IM is still offered an active-turn question');
  assert.equal(resolutions.length, 1, 'the IM pending is retired once the host answers');
  assert.equal(resolutions[0].outcome, 'cancelled');
  // Retirement is one-directional: only an IM answer ends the question's lifetime.
  // The host settling the request itself must not retire pendings the host never
  // touched, and nothing here may reach the turn signal every tool call shares.
  assert.equal(questionRetiredByAbort, 0, 'the question lifetime must outlive a host answer untouched');
  assert.equal(retiredByAbort, 0, 'a host answer must not broadcast an abort on the turn signal');
});

forEachSessionApi('a question cancelled with its turn', async (sessionApi) => {
  const { events, session } = sessionFixture(sessionApi);
  const eventRecord = (event) => ({ type: 'event', event });
  let fixture;
  let turnTask;
  const append = (event) => {
    events.push(event);
    fixture.emit('session/event', session, event);
  };
  const gateway = {
    async invoke(request) {
      const endpoint = `${request.namespace}/${request.method}`;
      if (endpoint === 'session/page') {
        return { records: events.map(eventRecord), hasMore: false };
      }
      if (endpoint === 'session/prompt') {
        const rpcId = request.args.request.requestId;
        turnTask = (async () => {
          append({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } });
          append({
            type: 'user/message', seq: 1, time: 1,
            data: { turn: 1, source: { kind: 'user', rpcId }, message: { content: [] } },
          });
          const controller = new AbortController();
          let questionRetiredByAbort = 0;
          const request = {
            agent: { id: 'session', session },
            signal: controller.signal,
            questions: [{
              id: 'environment',
              question: 'Choose an environment',
              options: [{ label: 'Test' }, { label: 'Production' }],
            }],
          };
          const pending = fixture.waterfall('user-questions/request', request, () => {
            request.signal.addEventListener('abort', () => { questionRetiredByAbort += 1; }, { once: true });
            if (request.signal.aborted) questionRetiredByAbort += 1;
            return new Promise(() => {});
          });
          // A real cancellation of the enclosing turn must still reach the question
          // lifetime a Web card holds: giving the question its own controller is a
          // narrowing of the cancellation scope, not a severing of it.
          controller.abort(new Error('the turn was cancelled'));
          await assert.rejects(pending, (error) => error?.code === 'ASK_ABORTED');
          assert.equal(questionRetiredByAbort, 1, 'a cancelled turn must retire the question lifetime');
          append({
            type: 'assistant/message', seq: 2, time: 2,
            data: { turn: 1, message: { content: [{ type: 'text', text: 'turn unwound' }] } },
          });
          append({
            type: 'turn/end', seq: 3, time: 3,
            data: { turn: 1, reason: { kind: 'completed' } },
          });
        })();
        return { accepted: true };
      }
      throw new Error(`unexpected invoke ${endpoint}`);
    },
    async stream(request) {
      if (`${request.namespace}/${request.method}` === 'workspace/follow') {
        return asyncValues({ type: 'baseline', value: { items: [], archivedSessionIds: [] } });
      }
      if (`${request.namespace}/${request.method}` !== 'session/follow') {
        throw new Error('unexpected stream');
      }
      return asyncValues({
        type: 'snapshot', cursor: -1, records: [], hasMore: false,
        projections: { asOfSeq: -1, values: {} },
      });
    },
  };
  fixture = fakeContext(gateway);
  const client = new HarnessClient({
    ...harnessConnection(fixture.ctx),
    workspace: '/workspace',
    rpcIdPrefix: 'modern-turn-cancel-test',
    logPrefix: 'modern-turn-cancel-test',
  });
  const answer = await client.ask('session', 'ask a question', {
    timeoutMs: 5_000,
    onInteraction: async () => {},
  });
  await turnTask;

  assert.equal(answer, 'turn unwound');
});

function competitiveApprovalFixture({ native = new Promise(() => {}), deliver } = {}) {
  const fixture = fakeContext({ invoke() {}, stream() {} });
  let offered;
  let nativeSignal;
  const turn = new AbortController();
  const completion = new Promise((resolve) => {
    modernHarnessApi(fixture.ctx, { deliveryService: {
      async presentSessionSyncApproval(sessionId, interaction, options) {
        offered = { sessionId, interaction, options };
        resolve(offered);
        return deliver ? deliver(offered) : true;
      },
    } });
  });
  const { events, session } = sessionFixture('snapshotEvents');
  events.push(
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/code-dispatch-start', data: { subCallId: 'call', name: 'bash', arguments: { command: 'printf safe' } } },
    { type: 'approval/asked', data: { id: 'approval', callId: 'call', toolName: 'bash' } },
  );
  const request = { agent: { session }, toolName: 'bash', callId: 'call', signal: turn.signal };
  const result = fixture.waterfall('approval/request', request, () => {
    nativeSignal = request.signal;
    return native;
  });
  return { fixture, completion, request, result, turn, nativeSignal: () => nativeSignal };
}

for (const winner of ['web', 'im']) {
  for (const decision of ['allowed-once', 'rejected']) {
    test(`competitive Web-origin approval: ${winner} ${decision} wins once without aborting the turn`, async () => {
      let answerWeb;
      const native = new Promise((resolve) => { answerWeb = resolve; });
      const f = competitiveApprovalFixture({ native });
      const { interaction, options } = await f.completion;
      assert.deepEqual(JSON.parse(interaction.toolCall.arguments), { command: 'printf safe' });
      const response = { ok: true, value: { sessionId: 'session', approvalId: 'approval', outcome: decision } };
      if (winner === 'web') answerWeb(decision);
      else await interaction.respond(response);
      assert.equal(await f.result, decision);
      assert.equal(await options.completion, decision);
      assert.equal(f.turn.signal.aborted, false);
      assert.equal(f.nativeSignal().aborted, true);
      assert.equal(f.request.signal, f.turn.signal);
      await assert.rejects(interaction.respond(response), { code: 'interaction-not-pending' });
      answerWeb(decision === 'rejected' ? 'allowed-once' : 'rejected');
      assert.equal(await f.result, decision);
    });
  }
}

test('native unavailable keeps a live IM approval pending', async () => {
  const f = competitiveApprovalFixture({ native: Promise.resolve('unavailable') });
  const { interaction } = await f.completion;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.nativeSignal().aborted, false);
  await interaction.respond({ ok: true, value: { sessionId: 'session', approvalId: 'approval', outcome: 'rejected' } });
  assert.equal(await f.result, 'rejected');
});

test('IM withdrawal leaves Web usable, and both unavailable finishes without approval', async () => {
  let answerWeb;
  const f = competitiveApprovalFixture({ native: new Promise((resolve) => { answerWeb = resolve; }) });
  const { interaction } = await f.completion;
  await interaction.withdraw();
  assert.equal(f.nativeSignal().aborted, false);
  await assert.rejects(interaction.respond({ ok: true, value: { sessionId: 'session', approvalId: 'approval', outcome: 'allowed-once' } }), { code: 'interaction-not-pending' });
  answerWeb('allowed-once');
  assert.equal(await f.result, 'allowed-once');
  const unavailable = competitiveApprovalFixture({ native: Promise.resolve('unavailable'), deliver: () => false });
  assert.equal(await unavailable.result, 'unavailable');
});

test('an expired IM approval settles the shared Web approval instead of leaving Web waiting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const settle = async () => {
    for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const sent = [];
  const queue = new HarnessApprovalQueue({ logger: { warn() {}, error() {} } });
  let answerWeb;
  const f = competitiveApprovalFixture({
    native: new Promise((resolve) => { answerWeb = resolve; }),
    deliver: ({ interaction }) => queue.handleRequested(interaction, {
      key: 'direct:actor', actor: 'actor', send: async (text) => { sent.push(text); },
    }),
  });
  await f.completion;
  await settle();
  assert.equal(queue.hasPending('direct:actor'), true);

  t.mock.timers.tick(60 * 60_000);
  await settle();
  assert.equal(queue.hasPending('direct:actor'), false);
  assert.equal(f.nativeSignal().aborted, true, 'the Web presentation must be retired too');
  answerWeb('allowed-once');
  assert.equal(await f.result, 'rejected');
  assert.equal(sent.at(-1), '审批已超时，已自动拒绝此次操作。');
});

test('turn cancellation retires both presentations and refuses a late decision', async () => {
  const f = competitiveApprovalFixture();
  const { interaction, options } = await f.completion;
  f.turn.abort();
  assert.equal(await f.result, 'cancelled');
  assert.equal(options.signal.aborted, true);
  assert.equal(f.nativeSignal().aborted, true);
  await assert.rejects(interaction.respond({ ok: true, value: { sessionId: 'session', approvalId: 'approval', outcome: 'allowed-once' } }), { code: 'interaction-not-pending' });
});

forEachSessionApi('a competitive approval', async (sessionApi) => {
  const { events, session } = sessionFixture(sessionApi);
  const eventRecord = (event) => ({ type: 'event', event });
  let fixture;
  let turnTask;
  const append = (event) => {
    events.push(event);
    fixture.emit('session/event', session, event);
  };
  const gateway = {
    async invoke(request) {
      const endpoint = `${request.namespace}/${request.method}`;
      if (endpoint === 'session/page') {
        return { records: events.map(eventRecord), hasMore: false };
      }
      if (endpoint === 'session/prompt') {
        const rpcId = request.args.request.requestId;
        turnTask = (async () => {
          append({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } });
          append({
            type: 'user/message', seq: 1, time: 1,
            data: { turn: 1, source: { kind: 'user', rpcId }, message: { content: [] } },
          });
          append({
            type: 'approval/asked', seq: 2, time: 2,
            data: { id: 'approval-one', toolName: 'bash', callId: 'call-one' },
          });
          const outcome = await fixture.waterfall('approval/request', {
            agent: { id: 'session', session },
            toolName: 'bash',
            callId: 'call-one',
          }, () => Promise.resolve('unavailable'));
          append({
            type: 'approval/decided', seq: 3, time: 3,
            data: { id: 'approval-one', outcome },
          });
          append({
            type: 'assistant/message', seq: 4, time: 4,
            data: { turn: 1, message: { content: [{ type: 'text', text: 'approved' }] } },
          });
          append({
            type: 'turn/end', seq: 5, time: 5,
            data: { turn: 1, reason: { kind: 'completed' } },
          });
        })();
        return { accepted: true };
      }
      throw new Error(`unexpected invoke ${endpoint}`);
    },
    async stream(request) {
      if (`${request.namespace}/${request.method}` === 'workspace/follow') {
        return asyncValues({ type: 'baseline', value: { items: [], archivedSessionIds: [] } });
      }
      if (`${request.namespace}/${request.method}` !== 'session/follow') {
        throw new Error('unexpected stream');
      }
      return asyncValues({
        type: 'snapshot', cursor: -1, records: [], hasMore: false,
        projections: { asOfSeq: -1, values: {} },
      });
    },
  };
  fixture = fakeContext(gateway);
  const connection = harnessConnection(fixture.ctx, {}, { competitiveApprovals: true });
  const client = new HarnessClient({
    ...connection,
    workspace: '/workspace',
    rpcIdPrefix: 'modern-test',
    logPrefix: 'modern-test',
  });
  const interactions = [];
  const resolutions = [];
  const answer = await client.ask('session', 'approve it', {
    timeoutMs: 5_000,
    onInteraction: async (interaction) => {
      interactions.push(interaction);
      await interaction.respond({
        ok: true,
        value: {
          sessionId: interaction.sessionId,
          approvalId: interaction.payload.approvalId,
          outcome: 'allowed-once',
        },
      });
    },
    onInteractionResolved: (resolution) => resolutions.push(resolution),
  });
  await turnTask;
  assert.equal(answer, 'approved');
  assert.equal(interactions.length, 1);
  assert.equal(interactions[0].kind, 'approval');
  assert.equal(events[3].data.outcome, 'allowed-once');
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].kind, 'approval');
  assert.equal(resolutions[0].outcome, 'allowed-once');

  const other = sessionFixture(sessionApi, 'other').session;
  const delegated = await fixture.waterfall('approval/request', {
    agent: { id: 'other', session: other },
    toolName: 'bash',
  }, () => Promise.resolve('browser-owned'));
  assert.equal(delegated, 'browser-owned');
});

test('modern workspace adapter forwards rename without activating a session', async () => {
  const calls = [];
  const { ctx } = fakeContext({
    stream() { throw new Error('rename does not need a stream'); },
    async invoke(request) {
      calls.push(request);
      assert.equal(request.namespace, 'workspace');
      assert.equal(request.method, 'rename');
      assert.deepEqual(request.args, { request: { workspaceId: 'preset-group', title: 'Research' } });
      return { workspace: { workspaceId: 'preset-group', title: 'Research' } };
    },
  });
  const harness = new HarnessClient({ ...harnessConnection(ctx), workspace: '/workspace', autostart: false });
  const result = await harness.rpc('workspace.rename', { workspaceId: 'preset-group', title: 'Research' });
  assert.equal(result.workspace.title, 'Research');
  assert.equal(calls.length, 1);
});
