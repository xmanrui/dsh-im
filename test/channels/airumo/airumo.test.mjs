import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AirumoApi, validateUpdate } from '../../../src/channels/airumo/api.mjs';
import { AirumoStateStore } from '../../../src/channels/airumo/state-store.mjs';
import { AirumoRuntime } from '../../../src/channels/airumo/runtime.mjs';
import { cancelAirumoPrompt } from '../../../plugin-src/host/channels/airumo/index.mjs';
import { deriveAirumoBotIdentity } from '../../../src/channels/airumo/config-store.mjs';
import { AirumoController } from '../../../src/channels/airumo/controller.mjs';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const me = {
  user_agent_id: 'bot-1',
  name: 'Fixture Bot',
  protocol: 'airumo.bot.v1',
  api_base_url: 'https://api.airumo.cn/_airumo/bot/v1',
};
const input = (id, session = 'chat:one') => ({
  request_id: id,
  session_id: session,
  room_id: '!room:airumo',
  deadline_ts: Date.now() + 120000,
  state: 'pending',
  attachments: [],
  message: { sender: '@user:airumo', content: { body: 'Hello from AIRumo' } },
});
const groupInput = (id, { room = '!room:airumo', rule = 'rule-one', sender = '@user:airumo' } = {}) => ({
  ...input(id, `rule:${rule}:request:${id}`),
  room_id: room,
  source_kind: 'message',
  rule_context: { rule_kind: 'group', rule_id: rule, action_type: 'agent_reply', turn: 0 },
  message: { sender, content: { body: id } },
});
async function wait(predicate) {
  for (let n = 0; n < 200; n++) {
    if (await predicate()) return;
    await sleep(10);
  }
  assert.fail('timed out');
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'airumo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await new AirumoStateStore(join(root, 'state.json')).load();
  return { root, state };
}

test('API uses bearer only on trusted origin; signed media never receives it; multipart output', async () => {
  const calls = [];
  const api = new AirumoApi('secret-not-for-logs', {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), ...options });
      if (String(url).endsWith('/me')) return json(me);
      if (String(url).includes('/media/'))
        return json({
          url: 'https://files.airumo.cn/signed',
          size_bytes: 3,
          original_filename: '../a.txt',
          mime_type: 'text/plain',
        });
      if (String(url).includes('/signed')) return new Response('abc');
      if (String(url).endsWith('/uploads'))
        return json({ upload_id: 'upload', part_size: 2, part_count: 2 });
      if (String(url).endsWith('/complete')) return json({ media_id: 'out' });
      return json({});
    },
  });
  await api.me();
  assert.equal(
    (await api.download('request', 'file', new AbortController().signal)).data.toString(),
    'abc',
  );
  assert.equal(calls.find((c) => c.url.endsWith('/signed')).headers, undefined);
  assert.deepEqual(
    await api.upload('request', {
      fileName: 'a.txt',
      mediaType: 'text/plain',
      bytes: Buffer.from('abc'),
    }),
    { media_id: 'out' },
  );
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 2);
  assert.ok(calls.every((c) => c.redirect === 'error'));
  assert.ok(
    calls
      .filter((c) => c.url.startsWith(me.api_base_url))
      .every((c) => c.headers.Authorization === 'Bearer secret-not-for-logs'),
  );
});

test('API failure redaction, fatal pause, rate limit, JSON envelope and identity validation', async () => {
  const api = new AirumoApi('secret', {
    fetchImpl: async () =>
      json({ errcode: 'BOT_INVALID_TOKEN', error: 'secret-private-body' }, 401),
  });
  await assert.rejects(api.me(), (e) => e.halt && !e.message.includes('secret'));
  const limited = new AirumoApi('secret', {
    fetchImpl: async () => json({ errcode: 'BOT_RATE_LIMITED', retry_after_ms: 1234 }, 429),
  });
  await assert.rejects(limited.me(), (e) => e.retryable && e.retryAfterMs === 1234);
  await assert.rejects(
    api.result('id', { text: 'x'.repeat(20000) }),
    (e) => e.code === 'LOCAL_JSON_TOO_LARGE',
  );
  assert.throws(() => validateUpdate({ ...input('id'), deadline_ts: 'tomorrow' }));
});

test('private state retains session mappings, task handles, immutable consumer across reload', async (t) => {
  const { state, root } = await fixture(t);
  await state.setSession('["bot-1","chat:one"]', 'native-one');
  await state.putRequest({
    input: input('id'),
    phase: 'executing',
    handle: { promptRpcId: 'owned' },
  });
  const restored = await new AirumoStateStore(join(root, 'state.json')).load();
  assert.equal(restored.consumerId(), state.consumerId());
  assert.equal(restored.sessionFor('["bot-1","chat:one"]'), 'native-one');
  assert.equal(restored.request('id').handle.promptRpcId, 'owned');
  assert.equal((await stat(join(root, 'state.json'))).mode & 0o777, 0o600);
});

function mockApi(updates) {
  const results = [];
  let first = true;
  return {
    results,
    me: async () => me,
    status: async () => ({}),
    updates: async (_consumer, signal) => {
      if (first) {
        first = false;
        return updates;
      }
      await sleep(50, undefined, { signal });
      return [];
    },
    request: async () => ({ state: 'pending' }),
    accept: async () => ({ execution_id: '550e8400-e29b-41d4-a716-446655440000' }),
    progress: async () => ({}),
    result: async (id, body) => {
      results.push({ id, body: structuredClone(body) });
      return { state: 'completed' };
    },
  };
}
function mockHarness() {
  let n = 0;
  const calls = [];
  return {
    calls,
    ensureRunning: async () => {},
    listModels: async () => ({ groups: [{ models: [{}] }] }),
    createSession: async () => `native-${++n}`,
    sessionExists: async () => true,
    ask: async (sessionId, prompt, options) => {
      calls.push({ sessionId, prompt });
      await options.onPrompt({ sessionId, promptRpcId: `rpc-${calls.length}`, baselineSeq: -1 });
      await sleep(20, undefined, { signal: options.signal });
      return 'Hello from Harness';
    },
  };
}
test('runtime deduplicates, serializes shared context, separates rooms and returns canonical answers', async (t) => {
  const { state } = await fixture(t);
  const api = mockApi([input('1'), input('1'), input('2'), input('3', 'chat:two')]);
  const harness = mockHarness();
  const runtime = new AirumoRuntime({
    config: { platformId: 'bot-1' },
    api,
    harness,
    state,
    logger: {},
  });
  t.after(() => runtime.stop());
  await runtime.start();
  await wait(() => api.results.length === 3);
  assert.equal(harness.calls.length, 3);
  const same = harness.calls.filter((c) => c.prompt.includes('chat:one'));
  assert.equal(same[0].sessionId, same[1].sessionId);
  assert.notEqual(
    same[0].sessionId,
    harness.calls.find((c) => c.prompt.includes('chat:two')).sessionId,
  );
  assert.ok(api.results.every((r) => r.body.content.text === 'Hello from Harness'));
});

test('group-rule requests from different members reuse one session and execute serially', async (t) => {
  const { state } = await fixture(t);
  const api = mockApi([groupInput('hello'), groupInput('holdings', { sender: '@other:airumo' })]);
  const harness = mockHarness();
  const ask = harness.ask;
  let active = 0, maximum = 0;
  harness.ask = async (...args) => {
    maximum = Math.max(maximum, ++active);
    try { return await ask(...args); } finally { active--; }
  };
  const runtime = new AirumoRuntime({ config: { platformId: 'bot-1' }, api, harness, state, logger: {} });
  t.after(() => runtime.stop());
  await runtime.start();
  await wait(() => api.results.length === 2);
  assert.ok(api.results.every((r) => r.body.status === 'succeeded'));
  assert.equal(harness.calls[0].sessionId, harness.calls[1].sessionId);
  assert.equal(maximum, 1, 'shared group context must not receive overlapping turns');
  assert.match(harness.calls[0].prompt, /rule:rule-one:request:hello/,
    'the original platform identity remains available as source context');
  assert.match(harness.calls[1].prompt, /rule:rule-one:request:holdings/);
});

test('group bindings survive runtime restart and only archived sessions are replaced', async (t) => {
  const { state, root } = await fixture(t);
  const harness = mockHarness();
  let api = mockApi([groupInput('first')]);
  let runtime = new AirumoRuntime({ config: { platformId: 'bot-1' }, api, harness, state, logger: {} });
  t.after(() => runtime.stop());
  await runtime.start();
  await wait(() => api.results.length === 1);
  await runtime.stop();
  const original = harness.calls[0].sessionId;
  const restored = await new AirumoStateStore(join(root, 'state.json')).load();
  api = mockApi([groupInput('after-restart')]);
  runtime = new AirumoRuntime({ config: { platformId: 'bot-1' }, api, harness, state: restored, logger: {} });
  await runtime.start();
  await wait(() => api.results.length === 1);
  assert.equal(harness.calls[1].sessionId, original);
  await runtime.stop();
  harness.sessionExists = async (id) => id !== original;
  api = mockApi([groupInput('after-archive'), groupInput('follow-up')]);
  runtime = new AirumoRuntime({ config: { platformId: 'bot-1' }, api, harness, state: restored, logger: {} });
  await runtime.start();
  await wait(() => api.results.length === 2);
  assert.notEqual(harness.calls[2].sessionId, original);
  assert.equal(harness.calls[3].sessionId, harness.calls[2].sessionId);
});

test('group context keeps room, rule and topic boundaries while legacy bindings remain available', async (t) => {
  const { state } = await fixture(t);
  const oldKey = JSON.stringify(['bot-1', 'rule:rule-one:request:legacy']);
  await state.setSession(oldKey, 'legacy-session');
  const updates = [
    groupInput('first'),
    groupInput('same-room-rule'),
    groupInput('other-room', { room: '!other:airumo' }),
    groupInput('other-rule', { rule: 'rule-two' }),
    { ...groupInput('topic-one'), session_id: 'topic:topic-one:1' },
    { ...groupInput('topic-two'), session_id: 'topic:topic-two:1' },
    { ...groupInput('topic-reset'), session_id: 'topic:topic-one:2' },
  ];
  const api = mockApi(updates), harness = mockHarness();
  const runtime = new AirumoRuntime({ config: { platformId: 'bot-1' }, api, harness, state, logger: {} });
  t.after(() => runtime.stop());
  await runtime.start();
  await wait(() => api.results.length === updates.length);
  const sessions = Object.fromEntries(harness.calls.map((c) => [c.prompt.split('\n')[0], c.sessionId]));
  assert.equal(sessions.first, sessions['same-room-rule']);
  assert.equal(new Set(Object.values(sessions)).size, updates.length - 1);
  assert.equal(state.sessionFor(oldKey), 'legacy-session', 'upgrade preserves earlier split conversations');
});

test('only matching group reply requests share a key; bots and other request types stay separate', () => {
  const runtime = new AirumoRuntime({ config: {}, state: {}, harness: {} });
  runtime.me = me;
  const a = groupInput('a'), b = groupInput('b');
  assert.equal(runtime.key(a), runtime.key(b));
  for (const change of [
    { source_kind: 'scheduled' },
    { rule_context: undefined },
    { rule_context: { ...a.rule_context, rule_kind: 'topic' } },
    { rule_context: { ...a.rule_context, action_type: 'other' } },
    { rule_context: { ...a.rule_context, rule_id: 'another-rule' } },
    { session_id: 'chat:one' },
  ]) {
    const first = { ...a, ...change }, second = { ...b, ...change };
    assert.equal(runtime.key(first), JSON.stringify(['bot-1', first.session_id]));
    assert.equal(runtime.key(second), JSON.stringify(['bot-1', second.session_id]));
  }
  const firstBotKey = runtime.key(a);
  runtime.me = { ...me, user_agent_id: 'bot-2' };
  assert.notEqual(runtime.key(a), firstBotKey);
});

test('cached final result is retried with identical key and content, never calls model twice', async (t) => {
  const { state } = await fixture(t);
  const entry = {
    input: input('retry'),
    phase: 'result',
    executionId: 'exec',
    attachments: [],
    result: { status: 'succeeded', content: { text: '已完成', attachments: [] } },
  };
  await state.putRequest(entry);
  const api = mockApi([]),
    harness = mockHarness();
  const runtime = new AirumoRuntime({
    config: { platformId: 'bot-1' },
    api,
    harness,
    state,
    logger: {},
  });
  t.after(() => runtime.stop());
  await runtime.start();
  await wait(() => api.results.length === 1);
  assert.equal(harness.calls.length, 0);
  assert.equal(api.results[0].body.execution_id, 'exec');
  assert.equal(api.results[0].body.content.text, '已完成');
});

test('unknown dispatch is reported, never replays an accepted prompt', async (t) => {
  const { state } = await fixture(t);
  await state.putRequest({
    input: input('unknown'),
    phase: 'dispatching',
    executionId: 'exec',
    attachments: [],
  });
  const api = mockApi([]),
    harness = mockHarness();
  const runtime = new AirumoRuntime({
    config: { platformId: 'bot-1' },
    api,
    harness,
    state,
    logger: {},
  });
  t.after(() => runtime.stop());
  await runtime.start();
  await wait(() => api.results.length === 1);
  assert.equal(harness.calls.length, 0);
  assert.equal(api.results[0].body.error_code, 'EXECUTION_OUTCOME_UNKNOWN');
});

test('recovery observes the original completed turn and excludes another prompt', async (t) => {
  const { state } = await fixture(t);
  await state.putRequest({
    input: input('recover'),
    phase: 'executing',
    executionId: 'exec',
    attachments: [],
    handle: { sessionId: 'original', promptRpcId: 'owned', baselineSeq: -1 },
  });
  const api = mockApi([]),
    harness = mockHarness();
  harness.rpc = async () => ({
    events: [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, data: { turn: 1, source: { rpcId: 'other' } } },
      {
        type: 'assistant/message',
        seq: 2,
        data: { turn: 1, message: { content: [{ type: 'text', text: 'other result' }] } },
      },
      { type: 'turn/end', seq: 3, data: { turn: 1, reason: 'completed' } },
      { type: 'turn/start', seq: 4, data: { turn: 2 } },
      { type: 'user/message', seq: 5, data: { turn: 2, source: { rpcId: 'owned' } } },
      {
        type: 'assistant/message',
        seq: 6,
        data: { turn: 2, message: { content: [{ type: 'text', text: 'original result' }] } },
      },
      { type: 'turn/end', seq: 7, data: { turn: 2, reason: { kind: 'completed' } } },
    ],
  });
  const runtime = new AirumoRuntime({
    config: { platformId: 'bot-1' },
    api,
    harness,
    state,
    logger: {},
  });
  t.after(() => runtime.stop());
  await runtime.start();
  await wait(() => api.results.length === 1);
  assert.equal(api.results[0].body.content.text, 'original result');
  assert.equal(harness.calls.length, 0);
});

test('heartbeat reports unavailable while models are missing and keeps polling without executing', async (t) => {
  const { state } = await fixture(t);
  const api = mockApi([input('no-model')]),
    harness = mockHarness();
  harness.listModels = async () => ({ groups: [] });
  let status;
  api.status = async (s) => {
    status = s;
  };
  const runtime = new AirumoRuntime({
    config: { platformId: 'bot-1' },
    api,
    harness,
    state,
    logger: {},
  });
  t.after(() => runtime.stop());
  await runtime.start();
  await wait(() => state.request('no-model'));
  assert.equal(status, 'unavailable');
  assert.equal(harness.calls.length, 0);
  assert.equal(runtime.status.harnessReachable, false);
});

test('platform cancellation stops owned execution and never publishes a late answer', async (t) => {
  const { state } = await fixture(t);
  const api = mockApi([input('cancel')]);
  let reads = 0,
    cancelled = 0;
  api.request = async () => ({ state: ++reads > 1 ? 'cancelled' : 'pending' });
  const harness = mockHarness();
  harness.ask = async (sessionId, _prompt, options) => {
    await options.onPrompt({ sessionId, promptRpcId: 'owned', baselineSeq: -1 });
    await sleep(10000, undefined, { signal: options.signal });
    return 'late';
  };
  const runtime = new AirumoRuntime({
    config: { platformId: 'bot-1' },
    api,
    harness,
    state,
    logger: {},
    cancelCheckMs: 10,
    cancelExecution: async (handle) => {
      assert.equal(handle.promptRpcId, 'owned');
      cancelled++;
    },
  });
  t.after(() => runtime.stop());
  await runtime.start();
  await wait(() => state.request('cancel')?.phase === 'done');
  assert.ok(cancelled > 0);
  assert.equal(api.results.length, 0);
});

test('exact cancellation removes own queued input and preserves unrelated active turn', () => {
  const removed = [];
  let cancelled = 0;
  const agent = {
    status: 'running',
    inbox: {
      nextTurn: [
        { id: 'own', source: { rpcId: 'own' } },
        { id: 'other', source: { rpcId: 'other' } },
      ],
      nextStep: [],
      remove: (id) => removed.push(id),
    },
    session: {
      snapshotEvents: () => [
        { type: 'turn/start', data: { turn: 2 } },
        { type: 'user/message', data: { source: { rpcId: 'other' } } },
      ],
    },
    cancel: () => cancelled++,
  };
  cancelAirumoPrompt(
    { get: () => ({ get: () => agent }) },
    { sessionId: 'session', promptRpcId: 'own' },
  );
  assert.deepEqual(removed, ['own']);
  assert.equal(cancelled, 0);
  agent.session.snapshotEvents = () => [
    { type: 'turn/start', data: { turn: 3 } },
    { type: 'user/message', data: { source: { rpcId: 'own' } } },
  ];
  cancelAirumoPrompt(
    { get: () => ({ get: () => agent }) },
    { sessionId: 'session', promptRpcId: 'own' },
  );
  assert.equal(cancelled, 1);
});

test('long answers become attachments instead of truncation', async (t) => {
  const { state } = await fixture(t);
  const api = mockApi([input('long')]);
  let uploaded;
  api.upload = async (_id, file) => {
    uploaded = file.bytes.toString();
    return { media_id: 'long-answer' };
  };
  const harness = mockHarness();
  harness.ask = async () => '长答案'.repeat(10000);
  const runtime = new AirumoRuntime({
    config: { platformId: 'bot-1' },
    api,
    harness,
    state,
    logger: {},
  });
  t.after(() => runtime.stop());
  await runtime.start();
  await wait(() => api.results.length === 1);
  assert.equal(uploaded, '长答案'.repeat(10000));
  assert.deepEqual(api.results[0].body.content.attachments, [{ media_id: 'long-answer' }]);
});

test('controller exposes no Token and invalid identities cannot bind', async () => {
  const id = deriveAirumoBotIdentity('bot-1');
  const saved = new Map(),
    secrets = new Map();
  const controller = new AirumoController({
    credentials: {
      resolve: async (k) => ({ value: secrets.get(k) }),
      set: async (k, v) => secrets.set(k, v),
      unset: async (k) => secrets.delete(k),
    },
    configStore: {
      list: () => [...saved.values()],
      get: (k) => saved.get(k),
      getByPlatformId: () => null,
      save: async (v) => saved.set(v.botId, v),
      remove: async (k) => saved.delete(k),
    },
    inspectToken: async () => ({ platformId: 'bot-1', name: 'Fixture Bot' }),
    createRuntime: async () => ({
      status: { ready: true, connectionState: 'connected', harnessReachable: true },
      start: async () => {},
      stop: async () => {},
    }),
  });
  const snapshot = await controller.bindCredentials({ token: 'private-airumo-token' });
  assert.equal(snapshot.bots[0].botId, id.botId);
  assert.ok(!JSON.stringify(snapshot).includes('private-airumo-token'));
  await controller.close();
});

test('interrupted artifact upload never recovers as a successful incomplete answer', async (t) => {
  const { state } = await fixture(t);
  await state.putRequest({
    input: input('artifact-interrupted'), phase: 'executing', executionId: 'exec',
    attachments: [], artifactPending: true,
    handle: { sessionId: 'original', promptRpcId: 'owned', baselineSeq: -1 },
  });
  const api = mockApi([]), harness = mockHarness();
  harness.rpc = async () => assert.fail('must not recover a potentially incomplete artifact result');
  const runtime = new AirumoRuntime({ config: { platformId: 'bot-1' }, api, harness, state, logger: {} });
  t.after(() => runtime.stop());
  await runtime.start();
  await wait(() => api.results.length === 1);
  assert.equal(api.results[0].body.status, 'failed');
  assert.equal(api.results[0].body.error_code, 'EXECUTION_OUTCOME_UNKNOWN');
  assert.equal(harness.calls.length, 0);
});

test('recovery refuses a completed file-return turn whose attachment was never persisted', async (t) => {
  const { state } = await fixture(t);
  await state.putRequest({
    input: input('missing-file'), phase: 'executing', executionId: 'exec', attachments: [],
    handle: { sessionId: 'original', promptRpcId: 'owned', baselineSeq: -1 },
  });
  const api = mockApi([]), harness = mockHarness();
  harness.rpc = async () => ({ events: [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { turn: 1, source: { rpcId: 'owned' } } },
    { type: 'tool/call', seq: 2, data: { turn: 1, name: 'dsh_im_return_file', callId: 'file' } },
    { type: 'assistant/message', seq: 3, data: { turn: 1, message: { content: [{ type: 'text', text: 'See attachment' }] } } },
    { type: 'turn/end', seq: 4, data: { turn: 1, reason: 'completed' } },
  ] });
  const runtime = new AirumoRuntime({ config: { platformId: 'bot-1' }, api, harness, state, logger: {} });
  t.after(() => runtime.stop());
  await runtime.start();
  await wait(() => api.results.length === 1);
  assert.equal(api.results[0].body.status, 'failed');
  assert.equal(harness.calls.length, 0);
});
