import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStateStore } from '../src/channels/shared/conversation-state-store.mjs';
import { createDeferredDeliveryCoordinator } from '../src/channels/shared/deferred-delivery-coordinator.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const event = (type, seq, data) => ({ type, seq, data });
const start = event('turn/start', 1, { turn: 3 });
const prompt = event('user/message', 2, { source: { rpcId: 'im-prompt' } });
const answer = event('assistant/message', 3, { turn: 3, step: 0, message: { content: [{ type: 'text', text: 'result' }] } });
const end = event('turn/end', 4, { turn: 3, reason: 'completed' });
const complete = [start, prompt, answer, end];
const timeout = (details = {}) => Object.assign(new Error('timeout'), {
  code: 'harness-reply-timeout', details: { sessionId: 'session', promptRpcId: 'im-prompt', turn: 3, baselineSeq: 0, ...details },
});
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await sleep(5); }
  assert.fail('condition was not met');
}
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-deferred-'));
  const state = await new ConversationStateStore(join(dir, 'state.json')).load();
  await state.setSession('chat', 'session');
  const sent = [];
  const harness = { rpc: async () => ({ events: complete, hasMore: false }), ...options.harness };
  const abort = new AbortController();
  const coordinator = createDeferredDeliveryCoordinator({ harness, state,
    deliver: async (entry, outcome) => { sent.push({ entry, outcome }); return true; },
    retryDelayMs: 5, pollDelayMs: 20, logger: { warn() {} }, ...options,
    signal: abort.signal,
  });
  t.after(async () => { abort.abort(); await coordinator.whenIdle(); await rm(dir, { recursive: true, force: true }); });
  await coordinator.whenIdle();
  const track = (error = timeout()) => coordinator.trackTimeout(error, { key: 'chat', target: { chatId: 'destination' } });
  return { state, sent, harness, abort, coordinator, track };
}

test('only reply timeouts are tracked; duplicate terminal events consume the row once', async (t) => {
  const f = await fixture(t);
  await f.track(Object.assign(new Error('network error'), { code: 'rpc-timeout' }));
  assert.deepEqual(f.state.deferredEntries(), []);
  await f.track();
  await Promise.all([f.coordinator.onEvent({ sessionId: 'session', event: end }), f.coordinator.resume()]);
  await f.coordinator.whenIdle();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].outcome.text, 'result');
  assert.deepEqual(f.state.deferredEntries(), []);
});

test('history lag recovers without another event and does not consume send attempts', async (t) => {
  let reads = 0;
  const f = await fixture(t, { harness: { rpc: async () => {
    reads++;
    if (reads === 1) throw new Error('temporarily disconnected');
    return { events: reads < 3 ? [start, prompt] : complete, hasMore: false };
  } } });
  await f.track();
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0].entry.attempts, 0);
  assert.equal(f.sent[0].outcome.text, 'result');
});

test('definite send failures retry automatically, stop after three attempts, and retain the row for diagnosis', async (t) => {
  let sends = 0;
  const f = await fixture(t, { deliver: async () => { sends++; throw Object.assign(new Error('rate limited'), { status: 429 }); } });
  await f.track();
  await until(() => f.state.deferredEntries()[0]?.status === 'failed');
  await f.coordinator.resume();
  await f.coordinator.onEvent({ sessionId: 'session', event: end });
  assert.equal(sends, 3);
  assert.equal(f.state.deferredEntries()[0].attempts, 3);
  assert.equal(f.state.deferredEntries()[0].target.chatId, 'destination');
});

for (const throws of [false, true]) {
  test(`uncertain delivery is retained without an automatic duplicate (${throws ? 'error' : 'receipt'})`, async (t) => {
    let sends = 0;
    const f = await fixture(t, { deliver: async () => {
      sends++;
      if (throws) throw new Error('connection lost after sending');
      return { deliveryOutcome: 'unknown' };
    } });
    await f.track();
    await f.coordinator.whenIdle();
    await f.coordinator.resume();
    await f.coordinator.onEvent({ sessionId: 'session', event: end });
    assert.equal(sends, 1);
    assert.equal(f.state.deferredEntries()[0].deliveryOutcome, 'unknown');
    assert.equal(f.state.deferredEntries()[0].status, 'failed');
  });
}

test('a send that succeeds on retry is removed', async (t) => {
  let sends = 0;
  const f = await fixture(t, { deliver: async () => ++sends > 1 });
  await f.track();
  await until(() => sends === 2);
  await f.coordinator.whenIdle();
  assert.deepEqual(f.state.deferredEntries(), []);
});

test('prompt identity recovers an unknown turn without delivering a different completed turn', async (t) => {
  let history = [event('turn/start', 5, { turn: 4 }), event('user/message', 6, { source: { rpcId: 'desktop' } }),
    event('assistant/message', 7, { ...answer.data, turn: 4 }), event('turn/end', 8, { turn: 4, reason: 'completed' })];
  const f = await fixture(t, { harness: { rpc: async () => ({ events: history, hasMore: false }) } });
  await f.track(timeout({ turn: null }));
  await f.coordinator.whenIdle();
  assert.equal(f.sent.length, 0);
  assert.equal(f.state.deferredEntries().length, 1);
  history = [...complete, ...history];
  await f.coordinator.resume();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].outcome.turn, 3);
});

for (const legacy of [false, true]) {
  test(`history pagination finds the original result instead of the latest page (${legacy ? 'legacy' : 'owned'} row)`, async (t) => {
    const cursors = [];
    const f = await fixture(t, { harness: { rpc: async (_method, params) => {
      cursors.push(params.beforeSeq);
      return params.beforeSeq === undefined
        ? { events: [event('turn/end', 400, { turn: 99, reason: 'completed' })], hasMore: true }
        : { events: complete, hasMore: false };
    } } });
    await f.track(timeout(legacy ? { promptRpcId: null, turn: null } : {}));
    await f.coordinator.whenIdle();
    assert.deepEqual(cursors, [undefined, 400]);
    assert.equal(f.sent[0].outcome.text, 'result');
    assert.equal(f.sent[0].outcome.turn, 3);
  });
}

test('shutdown during history recovery retains the row for the next process', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reading = false;
  const f = await fixture(t, { harness: { rpc: async () => { reading = true; await gate; return { events: complete }; } } });
  await f.track();
  await until(() => reading);
  f.abort.abort();
  release();
  await f.coordinator.whenIdle();
  assert.equal(f.sent.length, 0);
  assert.equal(f.state.deferredEntries().length, 1);
});

test('rebind during history recovery prevents sending to a conversation that changed session', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reading = false;
  const f = await fixture(t, { harness: { rpc: async () => { reading = true; await gate; return { events: complete }; } } });
  await f.track();
  await until(() => reading);
  await f.state.setSession('chat', 'new-session');
  release();
  await f.coordinator.whenIdle();
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.state.deferredEntries(), []);
});

test('stop forwards the exact turn and prompt identity to the existing scoped control', async (t) => {
  const controls = [];
  const f = await fixture(t, { harness: {
    rpc: async () => ({ events: [start, prompt], hasMore: false }),
    workspaceSession: (sessionId) => ({ stopDeferredTurn: async (identity, options) => {
      controls.push({ sessionId, identity, current: options.isCurrent() });
      return true;
    } }),
  } });
  await f.track();
  await f.coordinator.whenIdle();
  assert.equal(await f.coordinator.stop('chat'), 'stopped');
  assert.deepEqual(controls, [{ sessionId: 'session', identity: { turn: 3, promptRpcId: 'im-prompt' }, current: true }]);
  assert.equal(f.state.deferredEntries().length, 1, 'the terminal event still needs delivery');
});

test('without scoped cancellation, stop does not call session.cancel', async (t) => {
  const f = await fixture(t, { harness: { rpc: async (method) => {
    assert.equal(method, 'session.history');
    return { events: [start, prompt], hasMore: false };
  } } });
  await f.track();
  await f.coordinator.whenIdle();
  assert.equal(await f.coordinator.stop('chat'), 'unavailable');
});
