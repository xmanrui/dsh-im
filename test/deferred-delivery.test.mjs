import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_DEFERRED_PER_KEY,
  createDeferredDeliveryRegistry,
  extractCompletedTurnAnswer,
  terminalOutcomeOf,
} from '../src/channels/shared/deferred-delivery.mjs';

const ev = (seq, type, data = {}, extra = {}) => ({ seq, type, data, ...extra });

function historyEvents() {
  return [
    ev(1, 'turn/start', { turn: 3 }),
    ev(2, 'user/message', { turn: 3 }),
    ev(3, 'assistant/chunk', { turn: 3, step: 0, chunk: { type: 'text-delta', index: 0, text: '计算' } }),
    ev(4, 'tool/call', { turn: 3, callId: 'c1', name: 'bash' }),
    ev(5, 'assistant/message', { turn: 3, message: { content: [{ type: 'text', text: '计算结果：42' }] } }),
    ev(6, 'turn/end', { turn: 3, reason: { kind: 'completed' } }),
  ];
}

describe('extractCompletedTurnAnswer', () => {
  test('提取 completed 回合的最终回答', () => {
    const r = extractCompletedTurnAnswer(historyEvents(), { turn: 3 });
    assert.deepEqual(r, { found: true, turn: 3, text: '计算结果：42', reason: 'completed', endSeq: 6 });
  });

  test('多步骤回合按 step 累积、canonical 替换对应 step（对齐 HarnessReplyTracker）', () => {
    const events = [
      ev(1, 'assistant/chunk', { turn: 3, step: 0, chunk: { type: 'text-delta', index: 0, text: '计算' } }),
      ev(2, 'assistant/message', { turn: 3, step: 0, message: { content: [{ type: 'text', text: '计算结果：42' }] } }),
      ev(3, 'assistant/chunk', { turn: 3, step: 1, chunk: { type: 'text-delta', index: 0, text: '验证' } }),
      ev(4, 'assistant/message', { turn: 3, step: 1, message: { content: [{ type: 'text', text: '验证通过。' }] } }),
      ev(5, 'turn/end', { turn: 3, reason: 'completed' }),
    ];
    const r = extractCompletedTurnAnswer(events, { turn: 3 });
    assert.equal(r.found, true);
    assert.equal(r.text, '计算结果：42\n\n验证通过。');
  });

  test('多步骤同 step 内多个 chunk 按 index 拼接', () => {
    const events = [
      ev(1, 'assistant/chunk', { turn: 3, step: 0, chunk: { type: 'text-delta', index: 0, text: '计算' } }),
      ev(2, 'assistant/chunk', { turn: 3, step: 0, chunk: { type: 'text-delta', index: 1, text: '结果' } }),
      ev(3, 'turn/end', { turn: 3, reason: 'completed' }),
    ];
    const r = extractCompletedTurnAnswer(events, { turn: 3 });
    assert.equal(r.text, '计算\n结果');
  });

  test('acceptAnyTerminal：历史缺 turn/end 时保持等待语义（endSeq=-1）', () => {
    // mux 已报 completed，但历史投影还没有 turn/end：不能当作已终态处理。
    const events = [
      ev(1, 'assistant/message', { turn: 3, message: { content: [{ type: 'text', text: '半截' }] } }),
    ];
    const r = extractCompletedTurnAnswer(events, { turn: 3, acceptAnyTerminal: true });
    assert.equal(r.found, false);
    assert.equal(r.endSeq, -1);
  });

  test('acceptAnyTerminal 返回已确认的非 completed 终态（stopped）', () => {
    const events = [
      ev(1, 'assistant/message', { turn: 3, message: { content: [{ type: 'text', text: '半截' }] } }),
      ev(2, 'turn/end', { turn: 3, reason: { kind: 'stopped' } }),
    ];
    const r = extractCompletedTurnAnswer(events, { turn: 3, acceptAnyTerminal: true });
    assert.equal(r.found, false);
    assert.equal(r.reason, 'stopped');
    assert.equal(r.endSeq, 2);
  });

  test('turn 缺省时取最新 completed 回合', () => {
    const events = [
      ...historyEvents(),
      ev(7, 'assistant/message', { turn: 4, message: { content: [{ type: 'text', text: '第二轮' }] } }),
      ev(8, 'turn/end', { turn: 4, reason: 'completed' }),
    ];
    const r = extractCompletedTurnAnswer(events);
    assert.equal(r.turn, 4);
    assert.equal(r.text, '第二轮');
    assert.equal(r.endSeq, 8);
  });

  test('非 completed 终态 found=false 且带 reason', () => {
    const events = [
      ev(1, 'assistant/message', { turn: 5, message: { content: [{ type: 'text', text: '半截' }] } }),
      ev(2, 'turn/end', { turn: 5, reason: { kind: 'stopped' } }),
    ];
    const r = extractCompletedTurnAnswer(events, { turn: 5 });
    assert.equal(r.found, false);
    assert.equal(r.reason, 'stopped');
    assert.equal(r.endSeq, 2);
  });

  test('interrupted 的 assistant/message 不作为最终回答', () => {
    const events = [
      ev(1, 'assistant/message', { turn: 6, interrupted: true, message: { content: [{ type: 'text', text: '被打断' }] } }),
      ev(2, 'turn/end', { turn: 6, reason: 'completed' }),
    ];
    assert.equal(extractCompletedTurnAnswer(events, { turn: 6 }).found, false);
  });

  test('接受 {event} 包装条目且乱序输入按 seq 排序', () => {
    const entries = historyEvents().reverse().map((event) => ({ event }));
    assert.equal(extractCompletedTurnAnswer(entries, { turn: 3 }).found, true);
  });

  test('空输入返回 not found', () => {
    assert.deepEqual(extractCompletedTurnAnswer([]), {
      found: false, turn: null, text: null, reason: null, endSeq: -1,
    });
  });
});

describe('terminalOutcomeOf', () => {
  test('分类 completed 与 stopped', () => {
    assert.deepEqual(terminalOutcomeOf(ev(1, 'turn/end', { reason: { kind: 'completed' } })),
      { kind: 'completed' });
    assert.deepEqual(terminalOutcomeOf(ev(2, 'turn/end', { reason: 'stopped' })),
      { kind: 'stopped' });
  });

  test('缺失 reason 归为 other', () => {
    assert.deepEqual(terminalOutcomeOf(ev(3, 'turn/end', {})),
      { kind: 'other' });
  });
});

describe('createDeferredDeliveryRegistry', () => {
  function memoryStore() {
    const rows = new Map();
    return {
      rows,
      async listDeferred() { return [...rows.values()]; },
      async putDeferred(entry) { rows.set(entry.id, { ...entry }); },
      async patchDeferred(id, patch) { rows.set(id, { ...rows.get(id), ...patch }); },
      async removeDeferred(id) { rows.delete(id); },
    };
  }

  test('register 生成 id 并可按 session/key 查询 pending', async () => {
    const store = memoryStore();
    const registry = createDeferredDeliveryRegistry(store);
    const entry = await registry.register({
      key: 'p2p:ou_1', chatId: 'oc_1', replyToMessageId: 'om_1',
      sessionId: 's1', turn: 3, afterSeq: 10,
    });
    assert.equal(entry.id, 'p2p:ou_1 s1 3');
    assert.equal(entry.status, 'pending');
    assert.deepEqual((await registry.pendingForSession('s1')).map((e) => e.id), [entry.id]);
    assert.equal((await registry.pendingForKey('p2p:ou_1')).length, 1);
  });

  test('turn 为 null 时 id 用 any 占位', async () => {
    const registry = createDeferredDeliveryRegistry(memoryStore());
    const entry = await registry.register({ key: 'k', chatId: 'c', sessionId: 's' });
    assert.equal(entry.id, 'k s any');
    assert.equal(entry.turn, null);
  });

  test('register 缺少必填字段抛 TypeError', async () => {
    const registry = createDeferredDeliveryRegistry(memoryStore());
    await assert.rejects(() => registry.register({ chatId: 'c', sessionId: 's' }), TypeError);
    await assert.rejects(() => registry.register({ key: 'k', sessionId: 's' }), TypeError);
    await assert.rejects(() => registry.register({ key: 'k', chatId: 'c' }), TypeError);
  });

  test('单 key pending 数量超限丢弃最旧', async () => {
    const store = memoryStore();
    const registry = createDeferredDeliveryRegistry(store);
    for (let i = 0; i < MAX_DEFERRED_PER_KEY + 1; i += 1) {
      await registry.register({ key: 'k', chatId: 'c', sessionId: `s${i}`, turn: i });
    }
    const pending = await registry.pendingForKey('k');
    assert.equal(pending.length, MAX_DEFERRED_PER_KEY);
    assert.equal(pending.some((e) => e.sessionId === 's0'), false);
  });

  test('markFailedAttempt 三次后置 failed 且不再出现在 pending', async () => {
    const store = memoryStore();
    const registry = createDeferredDeliveryRegistry(store);
    const entry = await registry.register({ key: 'k', chatId: 'c', sessionId: 's' });
    await registry.markFailedAttempt(entry);
    await registry.markFailedAttempt(entry);
    const third = await registry.markFailedAttempt(entry);
    assert.equal(third, 3);
    assert.equal((await registry.pendingForSession('s')).length, 0);
    assert.equal(store.rows.get(entry.id).status, 'failed');
  });

  test('allPending 跨 key 汇总', async () => {
    const registry = createDeferredDeliveryRegistry(memoryStore());
    await registry.register({ key: 'k1', chatId: 'c', sessionId: 's1' });
    await registry.register({ key: 'k2', chatId: 'c', sessionId: 's2' });
    assert.equal((await registry.allPending()).length, 2);
  });

  test('remove 删除条目', async () => {
    const store = memoryStore();
    const registry = createDeferredDeliveryRegistry(store);
    const entry = await registry.register({ key: 'k', chatId: 'c', sessionId: 's' });
    await registry.remove(entry);
    assert.equal(store.rows.size, 0);
  });
});
