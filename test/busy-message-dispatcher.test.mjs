import assert from 'node:assert/strict';
import test from 'node:test';
import { BusyMessageDispatcher } from '../src/channels/shared/busy-message-dispatcher.mjs';

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise((done) => setImmediate(done));
function fixture() {
  const dispatcher = new BusyMessageDispatcher();
  const submission = deferred();
  const turn = deferred();
  const calls = [];
  const seen = new Set();
  const acceptedMessageIds = new Map();
  let mode = 'steer';
  let pending = false;
  const options = {
    key: 'chat', eligible: true, text: 'message', status: {},
    state: { sessionFor: () => 'session', hasSeen: (id) => seen.has(id), markSeen: async (id) => { seen.add(id); } },
    harness: { currentBusyMessageMode: () => mode, workspaceSession: () => ({
      steerActiveTurn: async (text) => { calls.push(['steer', text]); return submission.promise; },
    }) },
    acceptedMessageIds, pendingInteraction: () => pending, isQueued: () => true,
    enqueue: ({ alreadyRecorded }) => { calls.push(['queue', alreadyRecorded]); return turn.promise; },
    send: async (text) => { calls.push(['reply', text]); }, logger: { error() {}, warn() {} },
  };
  const dispatch = (id, extra = {}) => {
    acceptedMessageIds.set(id, null);
    return dispatcher.dispatch({ ...options, messageId: id, ...extra });
  };
  return { dispatcher, submission, turn, calls, options, acceptedMessageIds, dispatch,
    mode: (value) => { mode = value; }, pending: () => { pending = true; } };
}

test('routing is FIFO across a delayed false submission and a mode change; it never waits for the long task', async () => {
  const f = fixture();
  const first = f.dispatch('one', { text: 'one' });
  await tick();
  f.mode('queue');
  const second = f.dispatch('two', { text: 'two' });
  f.mode('steer');
  const third = f.dispatch('three', { text: 'three' });
  f.submission.resolve(false);
  await tick();
  assert.deepEqual(f.calls.filter(([op]) => op !== 'reply'), [
    ['steer', 'one'], ['queue', true], ['queue', false], ['steer', 'three'], ['queue', true],
  ]);
  assert.equal(f.acceptedMessageIds.size, 3, 'inputs remain reserved until their ordinary task completes');
  f.turn.resolve();
  await Promise.all([first, second, third, f.dispatcher.whenIdle()]);
  assert.equal(f.acceptedMessageIds.size, 0);
});

test('ineligible attachment reserves its place after a pending steering decision', async () => {
  const f = fixture();
  const first = f.dispatch('one');
  const second = f.dispatch('attachment', { eligible: false });
  await tick();
  assert.equal(f.calls.filter(([op]) => op === 'queue').length, 0);
  f.submission.resolve(true);
  await tick();
  assert.deepEqual(f.calls.filter(([op]) => op !== 'reply'), [['steer', 'message'], ['queue', false]]);
  f.turn.resolve();
  await Promise.all([first, second]);
});

test('new pending interaction takes priority over a message awaiting its routing decision', async () => {
  const f = fixture();
  const first = f.dispatch('one');
  await tick();
  const second = f.dispatch('two');
  f.pending();
  f.submission.resolve(true);
  await tick();
  assert.equal(f.calls.filter(([op]) => op === 'steer').length, 1);
  assert.deepEqual(f.calls.find(([op]) => op === 'queue'), ['queue', false]);
  f.turn.resolve();
  await Promise.all([first, second]);
});

test('successful steering receipts remain enabled by default and can be suppressed per channel', async () => {
  const withReceipt = fixture();
  const visible = withReceipt.dispatch('visible');
  await tick();
  withReceipt.submission.resolve(true);
  await visible;
  assert.equal(withReceipt.calls.filter(([op]) => op === 'reply').length, 1);

  const silent = fixture();
  const quiet = silent.dispatch('quiet', { steerReceipt: false });
  await tick();
  silent.submission.resolve(true);
  await quiet;
  assert.equal(silent.calls.filter(([op]) => op === 'reply').length, 0);
  assert.deepEqual(silent.calls.filter(([op]) => op === 'steer'), [['steer', 'message']]);
});

test('suppressing the success receipt keeps the queued fallback receipt', async () => {
  const f = fixture();
  const routed = f.dispatch('fallback', { steerReceipt: false });
  await tick();
  f.submission.resolve(false);
  await tick();
  assert.equal(f.calls.filter(([op]) => op === 'reply').length, 1);
  assert.deepEqual(f.calls.filter(([op]) => op === 'queue'), [['queue', true]]);
  f.turn.resolve();
  await routed;
});

test('shutdown releases accepted messages without submitting or enqueueing pending routing work', async () => {
  const f = fixture();
  const controller = new AbortController();
  const first = f.dispatch('one');
  await tick();
  const second = f.dispatch('two', { signal: controller.signal });
  controller.abort();
  f.submission.resolve(true);
  await Promise.all([first, second]);
  assert.equal(f.calls.filter(([op]) => op === 'steer').length, 1);
  assert.equal(f.calls.filter(([op]) => op === 'queue').length, 0);
  assert.equal(f.acceptedMessageIds.size, 0);
});
