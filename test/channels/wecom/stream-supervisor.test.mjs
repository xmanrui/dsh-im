import test from 'node:test';
import assert from 'node:assert/strict';

import { createWecomStreamSupervisor } from '../../../src/channels/wecom/stream-supervisor.mjs';

function createMockClient() {
  const calls = [];
  const behaviors = [];
  const client = {
    calls,
    replyStream: async (frame, streamId, text, finish) => {
      for (const behave of [...behaviors].reverse()) {
        const outcome = behave({ op: 'replyStream', frame, streamId, text, finish });
        if (outcome !== undefined) {
          if (outcome instanceof Error || (outcome && outcome.errcode !== undefined)) throw outcome;
          return outcome;
        }
      }
      calls.push({ op: 'replyStream', streamId, text, finish });
      return { body: { errcode: 0, msgid: `id-${calls.length}` } };
    },
    replyStreamNonBlocking: async (frame, streamId, text, finish) => {
      for (const behave of [...behaviors].reverse()) {
        const outcome = behave({ op: 'replyStreamNonBlocking', frame, streamId, text, finish });
        if (outcome !== undefined) {
          if (outcome instanceof Error || (outcome && outcome.errcode !== undefined)) throw outcome;
          return outcome;
        }
      }
      calls.push({ op: 'replyStreamNonBlocking', streamId, text, finish });
      return { body: { errcode: 0 } };
    },
    onBehavior(fn) { behaviors.push(fn); },
  };
  return client;
}

const baseOptions = (client, overrides = {}) => ({
  client,
  frame: { body: { chattype: 'single' } },
  chatId: 'chat-1',
  generateStreamId: (() => { let n = 1; return () => `stream-${++n}`; })(),
  logger: { warn() {}, error() {} },
  rotateAfterMs: 100,
  silentProbeMs: 2_000,
  tickMs: 20,
  ...overrides,
});

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('supervisor rotates the card at the deadline during silence', async () => {
  const client = createMockClient();
  const supervisor = createWecomStreamSupervisor(baseOptions(client, { previewText: () => '' }));
  supervisor.start('stream-1');
  await sleep(160);
  try {
    const finishes = client.calls.filter((call) => call.op === 'replyStream' && call.finish);
    const opens = client.calls.filter((call) => call.op === 'replyStream' && !call.finish);
    assert.equal(finishes.length, 1, 'expired card is finished exactly once');
    assert.match(finishes[0].text, /第 1 段/);
    assert.ok(opens.length >= 1, 'a fresh card is opened');
    assert.notEqual(supervisor.currentId(), 'stream-1');
    assert.equal(supervisor.isAlive(), true);
  } finally {
    supervisor.stop();
  }
});

test('supervisor rotates at the next progress frame past the deadline', async () => {
  const client = createMockClient();
  const supervisor = createWecomStreamSupervisor(baseOptions(client, { tickMs: 10_000 }));
  supervisor.start('stream-1');
  await sleep(140);
  await supervisor.progress('step 3 of 9');
  try {
    const open = client.calls.find((call) => call.op === 'replyStream' && !call.finish);
    assert.ok(open, 'rotation opened a new card');
    assert.equal(open.text, 'step 3 of 9', 'the pending preview seeds the new card');
    assert.equal(supervisor.currentId(), open.streamId);
  } finally {
    supervisor.stop();
  }
});

test('supervisor passes early progress frames to the same stream', async () => {
  const client = createMockClient();
  const supervisor = createWecomStreamSupervisor(baseOptions(client));
  supervisor.start('stream-1');
  await supervisor.progress('early preview');
  try {
    const updates = client.calls.filter((call) => call.op === 'replyStreamNonBlocking');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].streamId, 'stream-1');
    assert.equal(updates[0].text, 'early preview');
    assert.equal(supervisor.currentId(), 'stream-1');
  } finally {
    supervisor.stop();
  }
});

test('supervisor rebuilds after two consecutive rejected updates', async () => {
  const client = createMockClient();
  let rejectUpdates = false;
  client.onBehavior(({ op }) => {
    if (rejectUpdates && op === 'replyStreamNonBlocking') {
      return { errcode: 846608, errmsg: 'stream message update expired (>10 minutes), cannot update' };
    }
    return undefined;
  });
  const supervisor = createWecomStreamSupervisor(baseOptions(client));
  supervisor.start('stream-1');
  rejectUpdates = true;
  await supervisor.progress('update 1');
  assert.equal(supervisor.currentId(), 'stream-1', 'a single rejection is treated as transient');
  await supervisor.progress('update 2');
  try {
    assert.notEqual(supervisor.currentId(), 'stream-1', 'dead card is replaced after two rejections');
    assert.equal(supervisor.isAlive(), true);
    const finish = client.calls.find((call) => call.op === 'replyStream' && call.finish);
    assert.ok(finish, 'the dead card is still closed politely');
  } finally {
    rejectUpdates = false;
    supervisor.stop();
  }
});

test('finishStream rejects when no live card remains, so callers fall back', async () => {
  const client = createMockClient();
  let failEverything = false;
  client.onBehavior(() => (failEverything
    ? { errcode: 846608, errmsg: 'stream message update expired' }
    : undefined));
  const supervisor = createWecomStreamSupervisor(baseOptions(client));
  supervisor.start('stream-1');
  failEverything = true;
  await supervisor.progress('update 1');
  await supervisor.progress('update 2');
  try {
    assert.equal(supervisor.isAlive(), false, 'rotation failure marks the stream unavailable');
    await assert.rejects(() => supervisor.finishStream('final answer'), /wecom stream unavailable/);
  } finally {
    supervisor.stop();
  }
});

test('supervisor probes silent stretches with a light refresh', async () => {
  const client = createMockClient();
  const supervisor = createWecomStreamSupervisor(
    baseOptions(client, { rotateAfterMs: 10_000, silentProbeMs: 60 }),
  );
  supervisor.start('stream-1');
  await sleep(200);
  try {
    const probes = client.calls.filter((call) => call.op === 'replyStreamNonBlocking');
    assert.ok(probes.length >= 1, 'silent probe frames are sent');
    for (const probe of probes) assert.equal(probe.streamId, 'stream-1');
    assert.equal(supervisor.currentId(), 'stream-1', 'probing does not rotate the card');
  } finally {
    supervisor.stop();
  }
});

test('final delivery waits for an in-flight rotation and lands on the new card', async () => {
  const client = createMockClient();
  let releaseClosing;
  const closingHeld = new Promise((resolve) => { releaseClosing = resolve; });
  client.onBehavior(({ op, streamId, finish }) => {
    // Hold the rotation's closing reply of the first card.
    if (op === 'replyStream' && finish && streamId === 'stream-1') return closingHeld.then(() => undefined);
    return undefined;
  });
  const supervisor = createWecomStreamSupervisor(
    baseOptions(client, { rotateAfterMs: 0, tickMs: 10_000 }),
  );
  supervisor.start('stream-1');
  const rotating = supervisor.progress('step 5 of 9');
  await sleep(20);
  const finishing = supervisor.finishStream('FINAL ANSWER');
  await sleep(20);
  releaseClosing();
  await Promise.all([rotating, finishing]);
  try {
    const opens = client.calls.filter((call) => call.op === 'replyStream' && !call.finish);
    const final = client.calls.filter((call) => call.op === 'replyStream' && call.finish && call.text === 'FINAL ANSWER');
    assert.equal(opens.length, 1, 'exactly one new card opened');
    assert.equal(final.length, 1, 'final answer delivered exactly once');
    assert.equal(final[0].streamId, opens[0].streamId, 'final answer went to the rotated card, not the closed one');
    assert.notEqual(final[0].streamId, 'stream-1');
  } finally {
    supervisor.stop();
  }
});

test('stop during an in-flight rotation leaves no unfinished continuation card', async () => {
  const client = createMockClient();
  let releaseClosing;
  const closingHeld = new Promise((resolve) => { releaseClosing = resolve; });
  client.onBehavior(({ op, streamId, finish }) => {
    if (op === 'replyStream' && finish && streamId === 'stream-1') {
      return closingHeld.then(() => undefined);
    }
    return undefined;
  });
  const supervisor = createWecomStreamSupervisor(
    baseOptions(client, { rotateAfterMs: 0, tickMs: 10_000 }),
  );
  supervisor.start('stream-1');
  const rotating = supervisor.progress('step 2 of 4');
  await sleep(20);
  supervisor.stop();
  releaseClosing();
  await rotating;
  const opens = client.calls.filter((call) => call.op === 'replyStream' && !call.finish);
  assert.equal(opens.length, 0, 'no continuation card is opened after shutdown');
  assert.equal(supervisor.isAlive(), false);
});

test('finalization is terminal: background supervision stops once the final finish is sent', async () => {
  const client = createMockClient();
  const supervisor = createWecomStreamSupervisor(
    baseOptions(client, { rotateAfterMs: 40, silentProbeMs: 20, tickMs: 10 }),
  );
  supervisor.start('stream-1');
  await sleep(30); // probes may already fire before finalization
  await supervisor.finishStream('done');
  assert.equal(supervisor.isDelivering(), true);
  const callsAtFinal = client.calls.length;
  await sleep(200); // many ticks would fire here without the terminal state
  try {
    assert.equal(client.calls.length, callsAtFinal, 'no probe or rotation after finalization');
    const final = client.calls.filter((call) => call.op === 'replyStream' && call.finish);
    assert.equal(final.length, 1, 'the card carries exactly one finish');
  } finally {
    supervisor.stop();
  }
});

test('a failed final finish still stops supervision and rejects for the caller', async () => {
  const client = createMockClient();
  client.onBehavior(({ op, finish }) => {
    if (op === 'replyStream' && finish) {
      return { errcode: 846608, errmsg: 'stream message update expired (>10 minutes), cannot update' };
    }
    return undefined;
  });
  const supervisor = createWecomStreamSupervisor(
    baseOptions(client, { rotateAfterMs: 10_000, silentProbeMs: 10_000, tickMs: 10 }),
  );
  supervisor.start('stream-1');
  await sleep(20);
  await assert.rejects(() => supervisor.finishStream('final answer'));
  const callsAtFailure = client.calls.length;
  await sleep(120);
  try {
    assert.equal(client.calls.length, callsAtFailure, 'supervision stops after a failed finalization');
    assert.equal(supervisor.isDelivering(), true);
  } finally {
    supervisor.stop();
  }
});
