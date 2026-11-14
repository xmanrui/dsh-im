import test from 'node:test';
import assert from 'node:assert/strict';
import { SubagentDispatchTracker, SubagentTaskTracker, waitForSubagentTask } from '../src/channels/shared/subagent-task.mjs';

const task = { sessionId: 'parent', turn: 1, afterSeq: 10, childIds: ['a', 'b'] };
const start = (seq, turn) => ({ seq, type: 'turn/start', data: { turn } });
const end = (seq, turn, reason = 'completed') => ({ seq, type: 'turn/end', data: { turn, reason } });
const notice = (seq, senderSessionId, kind = 'subagent-settled') => ({
  seq, type: 'user/message', surfaceOp: 'append', data: { source: { kind, senderSessionId } },
});

test('agent dispatch is established only by a successful correlated send', async (t) => {
  const cases = [
    { name: 'object arguments', args: { agent_id: 'old-child', message: 'continue' }, expected: 'old-child' },
    { name: 'serialized arguments', args: '{"agent_id":"old-child","message":"continue"}', expected: 'old-child' },
    { name: 'failed send', args: { agent_id: 'old-child' }, error: true, expected: null },
    { name: 'uncorrelated result', args: { agent_id: 'old-child' }, resultId: 'other', expected: null },
    { name: 'malformed arguments', args: '{', expected: null },
    { name: 'missing target', args: {}, expected: null },
    { name: 'another tool', nameOverride: 'read', args: { agent_id: 'old-child' }, expected: null },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const dispatch = new SubagentDispatchTracker();
      assert.equal(dispatch.consume({ type: 'tool/call', data: {
        name: scenario.nameOverride ?? 'send_message', callId: 'call', arguments: scenario.args,
      } }), null, 'a call alone is not successful dispatch');
      const result = { type: 'tool/result', data: {
        message: { toolCallId: scenario.resultId ?? 'call', isError: scenario.error ?? false },
      } };
      assert.equal(dispatch.consume(result), scenario.expected);
      assert.equal(dispatch.consume(result), null, 'duplicate results must not reopen settled agents');
    });
  }
});

test('subagent task status follows settlement and the related parent completion', async (t) => {
  await t.test('multiple children, relay before settlement, unrelated turn, and replay', () => {
    const tracker = new SubagentTaskTracker(task);
    tracker.consume([start(11, 2), notice(12, 'other'), end(13, 2)]);
    assert.equal(tracker.finished, false);
    tracker.consume([start(14, 3), notice(15, 'a', 'agent-message'), end(16, 3)]);
    assert.equal(tracker.finished, false, 'relay is not settlement');
    tracker.consume([start(17, 4), notice(18, 'a'), end(19, 4)]);
    assert.equal(tracker.finished, false, 'the second child is still running');
    tracker.consume([start(20, 5), notice(21, 'b')]);
    assert.equal(tracker.finished, false, 'parent is still processing the result');
    tracker.consume([end(22, 5)]);
    assert.equal(tracker.finished, true);
    assert.equal(tracker.reason, 'completed');
    tracker.consume([notice(18, 'a'), end(19, 4, 'error')]);
    assert.equal(tracker.reason, 'completed');
  });
  await t.test('a continuation can spawn another child', () => {
    const tracker = new SubagentTaskTracker({ ...task, childIds: ['a'] });
    tracker.consume([start(11, 2), notice(12, 'a'),
      { seq: 13, type: 'subagent/catalog', data: { childId: 'c' } }, end(14, 2)]);
    assert.equal(tracker.finished, false);
    tracker.consume([start(15, 3), notice(16, 'c'), end(17, 3)]);
    assert.equal(tracker.reason, 'completed');
  });
  for (const reason of ['interrupted', 'error', 'blocked']) {
    await t.test(`related parent ${reason} is terminal without a false success`, () => {
      const tracker = new SubagentTaskTracker(task);
      tracker.consume([start(11, 2), notice(12, 'a', 'agent-message'), end(13, 2, { kind: reason })]);
      assert.equal(tracker.finished, true);
      assert.equal(tracker.reason, reason);
    });
  }
  await t.test('history pagination recovers notices missed by the live stream', async () => {
    const calls = [];
    const harness = { rpc: async (method, params) => {
      calls.push({ method, params });
      return params.beforeSeq === undefined
        ? { events: [end(15, 2)], hasMore: true }
        : { events: [start(11, 2), notice(12, 'a'), notice(13, 'b')], hasMore: false };
    } };
    assert.equal(await waitForSubagentTask(harness, task), 'completed');
    assert.deepEqual(calls.map(({ params }) => params.beforeSeq), [undefined, 15]);
    assert.ok(calls.every(({ method, params }) => method === 'session.history' && params.sessionId === 'parent'));
  });
  await t.test('cancellation and history failure cannot become success', async () => {
    const signal = AbortSignal.abort(new Error('cancelled'));
    await assert.rejects(waitForSubagentTask({}, task, { signal }), /cancelled/);
    await assert.rejects(waitForSubagentTask({ rpc: async () => { throw new Error('offline'); } }, task), /offline/);
  });
});
