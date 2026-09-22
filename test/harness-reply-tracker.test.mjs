import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HarnessReplyTracker } from '../src/channels/shared/harness-client.mjs';

const PROMPT_RPC_ID = 'reply-tracker-test';

function turnPrefix(turn = 1) {
  return [
    { type: 'turn/start', seq: 1, data: { turn } },
    {
      type: 'user/message',
      seq: 2,
      data: { turn, source: { rpcId: PROMPT_RPC_ID } },
    },
  ];
}

function textDelta(seq, { turn = 1, step = 0, index = 0, text }) {
  return {
    type: 'assistant/chunk',
    seq,
    data: { turn, step, chunk: { type: 'text-delta', index, text } },
  };
}

function assistantMessage(seq, { turn = 1, step, text }) {
  return {
    type: 'assistant/message',
    seq,
    data: {
      turn,
      ...(step === undefined ? {} : { step }),
      message: { content: [{ type: 'text', text }] },
    },
  };
}

test('HarnessReplyTracker accumulates text deltas across steps', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: PROMPT_RPC_ID });

  const updates = tracker.consumeAll([
    ...turnPrefix(),
    textDelta(3, { step: 0, text: '第一段' }),
    textDelta(4, { step: 1, text: '第二段' }),
    { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } },
  ]);

  assert.deepEqual(updates, [{ type: 'text', text: '第一段\n\n第二段' }]);
  assert.equal(tracker.answer, '第一段\n\n第二段');
  assert.equal(tracker.finished, true);
});

test('HarnessReplyTracker orders content parts within each step', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: PROMPT_RPC_ID });

  tracker.consumeAll([
    ...turnPrefix(),
    textDelta(3, { step: 1, index: 1, text: '乙' }),
    textDelta(4, { step: 0, index: 0, text: '甲' }),
    textDelta(5, { step: 1, index: 0, text: '丙' }),
  ]);

  assert.equal(tracker.answer, '甲\n\n丙\n乙');
});

test('HarnessReplyTracker merges canonical assistant messages across steps', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: PROMPT_RPC_ID });

  tracker.consumeAll([
    ...turnPrefix(),
    assistantMessage(3, { step: 0, text: '第一步定稿' }),
    assistantMessage(4, { step: 1, text: '第二步定稿' }),
  ]);

  assert.equal(tracker.answer, '第一步定稿\n\n第二步定稿');
});

test('HarnessReplyTracker replaces one step deltas with its canonical message', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: PROMPT_RPC_ID });

  tracker.consumeAll([
    ...turnPrefix(),
    textDelta(3, { step: 0, text: '第一步草稿' }),
    assistantMessage(4, { step: 0, text: '第一步定稿' }),
    textDelta(5, { step: 1, text: '第二步草稿' }),
    assistantMessage(6, { step: 1, text: '第二步定稿' }),
  ]);

  assert.equal(tracker.answer, '第一步定稿\n\n第二步定稿');
  assert.equal(tracker.answer.includes('草稿'), false);
});

test('HarnessReplyTracker keeps replace-latest behavior for assistant messages without step metadata', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: PROMPT_RPC_ID });

  tracker.consumeAll([
    ...turnPrefix(),
    assistantMessage(3, { text: '旧定稿' }),
    assistantMessage(4, { text: '新定稿' }),
  ]);

  assert.equal(tracker.answer, '新定稿');
});

test('HarnessReplyTracker excludes reasoning and tool events from the answer', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: PROMPT_RPC_ID });

  tracker.consumeAll([
    ...turnPrefix(),
    {
      type: 'assistant/chunk',
      seq: 3,
      data: {
        turn: 1,
        step: 0,
        chunk: { type: 'reasoning-delta', index: 0, text: '内部推理' },
      },
    },
    { type: 'tool/call', seq: 4, data: { turn: 1, step: 0, name: 'search' } },
    { type: 'tool/result', seq: 5, data: { turn: 1, step: 0, secret: '工具结果' } },
    textDelta(6, { step: 1, text: '用户可见答案' }),
  ]);

  assert.equal(tracker.answer, '用户可见答案');
});

test('HarnessReplyTracker still ignores duplicate sequences and unrelated turns', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: PROMPT_RPC_ID, afterSeq: 10 });

  tracker.consumeAll([
    { type: 'turn/start', seq: 11, data: { turn: 7 } },
    {
      type: 'user/message',
      seq: 12,
      data: { turn: 7, source: { rpcId: PROMPT_RPC_ID } },
    },
    textDelta(14, { turn: 8, step: 0, text: '其他 Turn' }),
    textDelta(13, { turn: 7, step: 0, text: '有效' }),
    textDelta(13, { turn: 7, step: 0, text: '重复' }),
  ]);

  assert.equal(tracker.answer, '有效');
});

test('HarnessReplyTracker does not let pre-turn live frames skip the prompt turn', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: PROMPT_RPC_ID, afterSeq: 0 });

  assert.deepEqual(tracker.consumeAll([
    textDelta(5, { turn: 1, step: 0, text: '过早到达' }),
  ], { live: true }), []);
  assert.equal(tracker.lastSeq, 0);

  const updates = tracker.consumeAll([
    ...turnPrefix(1),
    textDelta(3, { turn: 1, step: 0, text: '有效答案' }),
    { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ], { live: true });

  assert.deepEqual(updates, [
    { type: 'turn-start', turn: 1 },
    { type: 'text', text: '有效答案' },
    { type: 'turn-end', turn: 1, reason: { kind: 'completed' } },
  ]);
  assert.equal(tracker.answer, '有效答案');
  assert.equal(tracker.finished, true);
});

function reasoningDelta(seq, text, turn = 1) {
  return { type: 'assistant/chunk', seq, data: {
    turn, step: 0, chunk: { type: 'reasoning-delta', text },
  } };
}

for (const type of ['step/end', 'tool/call', 'tool/result', 'assistant/message', 'assistant/chunk', 'turn/end']) {
  test(`live mux ${type} cannot skip missing history`, () => {
    const tracker = new HarnessReplyTracker({ promptRpcId: PROMPT_RPC_ID });
    tracker.consumeAll(turnPrefix(), { live: true });
    assert.deepEqual(tracker.consumeAll([
      { type, seq: 8, data: { turn: 1, chunk: { type: 'text-delta', text: '提前草稿' } } },
    ], { live: true, fromMux: true }), []);
    assert.equal(tracker.lastSeq, 2);
    assert.equal(tracker.finished, false);
    tracker.consumeAll([
      assistantMessage(3, { step: 0, text: '完整答案' }),
      { type: 'turn/end', seq: 9, data: { turn: 1 } },
    ], { live: true });
    assert.equal(tracker.answer, '完整答案');
    assert.equal(tracker.finished, true);
  });
}

test('live buffered reasoning keeps tool ordering, deduplicates history and rejects foreign or late frames', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: PROMPT_RPC_ID });
  const early = reasoningDelta(1.5, '早期思考');
  const later = reasoningDelta(4.5, '第二步思考');
  assert.deepEqual(tracker.consumeAll([
    reasoningDelta(0.5, '上一轮', 0), early, later,
  ], { live: true, fromMux: true }), []);
  const updates = tracker.consumeAll([
    ...turnPrefix(), early,
    { type: 'tool/call', seq: 3, data: { turn: 1, callId: 'call', name: 'read' } },
    { type: 'tool/result', seq: 4, data: { turn: 1, callId: 'call', result: 'ok' } },
    later, assistantMessage(5, { step: 1, text: '答案' }),
    { type: 'turn/end', seq: 6, data: { turn: 1 } },
  ], { live: true });
  assert.deepEqual(updates.map(u => u.type), [
    'turn-start', 'reasoning', 'tool', 'tool-result', 'reasoning', 'assistant-message', 'text', 'turn-end',
  ]);
  assert.deepEqual(updates.filter(u => u.type === 'reasoning').map(u => u.text), ['早期思考', '第二步思考']);
  assert.deepEqual(tracker.consumeAll([reasoningDelta(7, '结束后迟到')], { live: true, fromMux: true }), []);
  assert.equal(tracker.lastSeq, 6);
});

for (const seq of [10, 10.5]) {
  test(`live mux reasoning seq ${seq} does not advance history cursor`, () => {
    const tracker = new HarnessReplyTracker({ promptRpcId: PROMPT_RPC_ID });
    tracker.consumeAll(turnPrefix(), { live: true });
    const frame = reasoningDelta(seq, '思考');
    assert.equal(tracker.consumeAll([frame], { live: true, fromMux: true })[0].text, '思考');
    assert.equal(tracker.lastSeq, 2);
    assert.deepEqual(tracker.consumeAll([frame], { live: true }), []);
    assert.deepEqual(tracker.consumeAll([reasoningDelta(11, '其他任务', 2)], { live: true, fromMux: true }), []);
    tracker.consumeAll([assistantMessage(3, { step: 0, text: '补回答案' })], { live: true });
    assert.equal(tracker.answer, '补回答案');
  });
}

for (const [count, textSize, retained] of [[300, 1, 256], [100, 1024, 64]]) {
  test(`unbound reasoning cache bounds ${count} frames of ${textSize} characters`, () => {
    const tracker = new HarnessReplyTracker({ promptRpcId: PROMPT_RPC_ID });
    tracker.consumeAll(Array.from({ length: count }, (_, i) => reasoningDelta(i + 0.5, 'a'.repeat(textSize))),
      { live: true, fromMux: true });
    const updates = tracker.consumeAll([
      { type: 'user/message', seq: 1000, data: { turn: 1, source: { rpcId: PROMPT_RPC_ID } } },
      assistantMessage(1001, { step: 0, text: '答案' }),
      { type: 'turn/end', seq: 1002, data: { turn: 1 } },
    ], { live: true });
    assert.equal(updates.filter(u => u.type === 'reasoning').length, retained);
    assert.equal(updates[0].type, 'turn-start');
    assert.equal(tracker.answer, '答案');
    assert.equal(tracker.finished, true);
  });
}

for (const reason of [{ kind: 'error' }, { kind: 'cancelled' }, { kind: 'completed' }]) {
  test(`history ${reason.kind} finishes without requiring an assistant answer`, () => {
    const tracker = new HarnessReplyTracker({ promptRpcId: PROMPT_RPC_ID });
    tracker.consumeAll([...turnPrefix(), { type: 'turn/end', seq: 3, data: { turn: 1, reason } }], { live: true });
    assert.equal(tracker.finished, true);
    assert.deepEqual(tracker.reason, reason);
    assert.equal(tracker.answer, '');
  });
}
