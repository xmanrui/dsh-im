import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HarnessReplyTracker,
  toolCallDescription,
  latestTextAndStatus,
} from '../src/channels/shared/harness-client.mjs';

const PROMPT_RPC_ID = 'rpc-test-1';

function chunk(seq, turn, step, index, text) {
  return { type: 'assistant/chunk', seq, data: { turn, step, chunk: { type: 'text-delta', index, text } } };
}

test('accumulates assistant text across steps of one turn instead of keeping only the last step', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: PROMPT_RPC_ID, afterSeq: -1 });
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 7 } },
    { type: 'user/message', seq: 2, data: { turn: 7, source: { rpcId: PROMPT_RPC_ID } } },
    chunk(3, 7, 0, 0, '第一步正文 '),
    chunk(4, 7, 0, 0, 'A'),
    chunk(8, 7, 1, 0, '第二步正文 B'),
    { type: 'turn/end', seq: 9, data: { turn: 7, reason: 'stop' } },
  ];

  const updates = tracker.consumeAll(events);
  const textUpdates = updates.filter((update) => update.type === 'text');

  assert.equal(tracker.finished, true);
  assert.equal(tracker.answer, '第一步正文 A\n\n第二步正文 B');
  assert.equal(textUpdates.length, 1, 'text frames collapse to the newest cumulative text');
  assert.equal(textUpdates[0].text, '第一步正文 A\n\n第二步正文 B');
});

test('separates different steps with a blank line but keeps one line within a step', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: PROMPT_RPC_ID, afterSeq: -1 });
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 8 } },
    { type: 'user/message', seq: 2, data: { turn: 8, source: { rpcId: PROMPT_RPC_ID } } },
    { type: 'assistant/chunk', seq: 3, data: { turn: 8, step: 0, chunk: { type: 'text-delta', index: 0, text: '甲' } } },
    { type: 'assistant/chunk', seq: 4, data: { turn: 8, step: 0, chunk: { type: 'text-delta', index: 1, text: '乙' } } },
    { type: 'assistant/chunk', seq: 5, data: { turn: 8, step: 1, chunk: { type: 'text-delta', index: 0, text: '丙' } } },
    { type: 'turn/end', seq: 6, data: { turn: 8, reason: 'stop' } },
  ];

  tracker.consumeAll(events);
  assert.equal(tracker.answer, '甲\n乙\n\n丙');
});

test('merges assistant/message events by step instead of overwriting earlier text', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: PROMPT_RPC_ID, afterSeq: -1 });
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { turn: 1, source: { rpcId: PROMPT_RPC_ID } } },
    { type: 'assistant/message', seq: 3, data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '第一段' }] } } },
    { type: 'assistant/message', seq: 4, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '第二段' }] } } },
    { type: 'turn/end', seq: 5, data: { turn: 1, reason: 'stop' } },
  ];

  tracker.consumeAll(events);
  assert.equal(tracker.answer, '第一段\n\n第二段');
});

test('canonical assistant/message replaces its step deltas instead of duplicating them', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: PROMPT_RPC_ID, afterSeq: -1 });
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { turn: 1, source: { rpcId: PROMPT_RPC_ID } } },
    { type: 'assistant/chunk', seq: 3, data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: '流式片段' } } },
    { type: 'assistant/message', seq: 4, data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '权威全文' }] } } },
    { type: 'turn/end', seq: 5, data: { turn: 1, reason: 'stop' } },
  ];

  tracker.consumeAll(events);
  assert.equal(tracker.answer, '权威全文');
});

test('assistant/message without step metadata replaces the latest text', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: PROMPT_RPC_ID, afterSeq: -1 });
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { turn: 1, source: { rpcId: PROMPT_RPC_ID } } },
    { type: 'assistant/message', seq: 3, data: { turn: 1, message: { content: [{ type: 'text', text: '第一段' }] } } },
    { type: 'assistant/message', seq: 4, data: { turn: 1, message: { content: [{ type: 'text', text: '第二段' }] } } },
    { type: 'turn/end', seq: 5, data: { turn: 1, reason: 'stop' } },
  ];

  tracker.consumeAll(events);
  assert.equal(tracker.answer, '第二段');
});

test('emits a thinking status on reasoning deltas', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: PROMPT_RPC_ID, afterSeq: -1 });
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 2 } },
    { type: 'user/message', seq: 2, data: { turn: 2, source: { rpcId: PROMPT_RPC_ID } } },
    { type: 'assistant/chunk', seq: 3, data: { turn: 2, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: '...' } } },
    { type: 'turn/end', seq: 4, data: { turn: 2, reason: 'stop' } },
  ];

  const updates = tracker.consumeAll(events);
  assert.ok(updates.some((update) => update.type === 'status' && update.text === '🧠 正在思考…'));
});

test('surfaces the tool description (title) on tool/call updates', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: PROMPT_RPC_ID, afterSeq: -1 });
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 3 } },
    { type: 'user/message', seq: 2, data: { turn: 3, source: { rpcId: PROMPT_RPC_ID } } },
    { type: 'tool/call', seq: 3, data: { turn: 3, callId: 'c1', name: 'bash', arguments: { command: 'ls', description: '列出文件' } } },
    { type: 'turn/end', seq: 4, data: { turn: 3, reason: 'stop' } },
  ];

  const updates = tracker.consumeAll(events);
  const tool = updates.find((update) => update.type === 'tool');
  assert.equal(tool.name, 'bash');
  assert.equal(tool.description, '列出文件');
});

test('toolCallDescription reads description from object or JSON string arguments', () => {
  assert.equal(toolCallDescription({ arguments: { description: '读文件' } }), '读文件');
  assert.equal(toolCallDescription({ arguments: JSON.stringify({ description: '读文件' }) }), '读文件');
  assert.equal(toolCallDescription({ arguments: { command: 'ls' } }), null);
  assert.equal(toolCallDescription({ arguments: 'not-json' }), null);
  assert.equal(toolCallDescription({}), null);
  assert.equal(toolCallDescription(null), null);
});

test('latestTextAndStatus keeps the newest text frame plus the newest status frame', () => {
  const mixed = [
    { type: 'text', text: '全文' },
    { type: 'tool', name: 'bash' },
    { type: 'status', text: '⌛ 正在整理结果…' },
  ];
  const out = latestTextAndStatus(mixed);
  assert.deepEqual(out.map((update) => update.type), ['text', 'status']);
  assert.equal(out[0].text, '全文');
  assert.equal(out[1].text, '⌛ 正在整理结果…');

  assert.deepEqual(latestTextAndStatus([{ type: 'tool', name: 'bash' }]).map((u) => u.type), ['tool']);
  assert.deepEqual(latestTextAndStatus([{ type: 'text', text: '只有正文' }]).map((u) => u.type), ['text']);
  assert.deepEqual(latestTextAndStatus([]), []);
});
