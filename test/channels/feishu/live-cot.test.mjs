import test from 'node:test';
import assert from 'node:assert/strict';

import { FeishuLiveCot } from '../../../src/channels/feishu/live-cot.mjs';

function fixture({ createError, writeError } = {}) {
  const calls = { creates: [], writes: [], failures: [] };
  const channel = {
    async createCot(chatId, options) {
      calls.creates.push({ chatId, options });
      if (createError) throw createError;
      return { cotId: 'cot-1', messageId: 'om-cot-1' };
    },
    async writeCotEvents(handle, events) {
      calls.writes.push({ handle, events });
      if (writeError) throw writeError;
    },
  };
  const cot = new FeishuLiveCot(channel, 'oc-chat', {
    replyTo: 'om-user',
    onFailure: (error) => calls.failures.push(error),
  });
  return { cot, calls };
}

function decoded(calls) {
  return calls.writes.flatMap(({ events }) => events.map((event) => ({
    type: event.event_type,
    content: JSON.parse(event.content),
    timestamp: Number(event.timestamp),
  })));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('FeishuLiveCot maps a complete Harness process to ordered native events', async () => {
  const { cot, calls } = fixture();
  await cot.handle({ type: 'turn-start', turn: 7 });
  await cot.handle({ type: 'reasoning', turn: 7, text: '先检查目录。' });
  await cot.handle({ type: 'assistant-message', turn: 7, step: 0, text: '我先读取配置。' });
  await cot.handle({
    type: 'tool',
    turn: 7,
    callId: 'call-1',
    name: 'read_file',
    arguments: '{"path":"config.json"}',
  });
  await cot.handle({
    type: 'tool-result',
    turn: 7,
    callId: 'call-1',
    text: '配置内容',
  });
  await cot.handle({ type: 'assistant-message', turn: 7, step: 1, text: '最终答案' });
  await cot.handle({ type: 'turn-end', turn: 7, reason: { kind: 'completed' } });

  assert.deepEqual(calls.creates, [{
    chatId: 'oc-chat',
    options: { replyTo: 'om-user', hidden: false },
  }]);
  const events = decoded(calls);
  assert.deepEqual(events.map(({ type }) => type), [
    'RUN_STARTED',
    'REASONING_MESSAGE_START',
    'REASONING_MESSAGE_CONTENT',
    'TEXT_MESSAGE_START',
    'TEXT_MESSAGE_CONTENT',
    'TEXT_MESSAGE_END',
    'REASONING_MESSAGE_END',
    'TOOL_CALL_START',
    'TOOL_CALL_ARGS',
    'TOOL_CALL_END',
    'TOOL_CALL_RESULT',
    'RUN_FINISHED',
  ]);
  assert.equal(events.find(({ type }) => type === 'TOOL_CALL_START').content.icon, 'read');
  assert.equal(events.find(({ type }) => type === 'TOOL_CALL_RESULT').content.content.code, '配置内容');
  assert.ok(events.every((event, index) => (
    index === 0 || event.timestamp > events[index - 1].timestamp
  )));
  assert.ok(!JSON.stringify(events).includes('最终答案'),
    'the final assistant message belongs to the ordinary answer message');
});

test('FeishuLiveCot bounds tool output and closes failed turns', async () => {
  const { cot, calls } = fixture();
  await cot.handle({ type: 'turn-start', turn: 2 });
  await cot.handle({
    type: 'tool-result',
    turn: 2,
    callId: 'call-long',
    text: 'x'.repeat(2_000),
    errorCode: 'TOOL_FAILED',
  });
  await cot.handle({
    type: 'turn-end',
    turn: 2,
    reason: { kind: 'error', error: { code: 'MODEL', message: 'failed' } },
  });

  const events = decoded(calls);
  const result = events.find(({ type }) => type === 'TOOL_CALL_RESULT').content;
  assert.equal(result.content.code.length, 1_500);
  assert.match(result.content.code, /…$/);
  assert.equal(result.error, 'TOOL_FAILED');
  assert.deepEqual(events.at(-1), {
    type: 'RUN_ERROR',
    content: { message: 'MODEL: failed', code: 'TURN_FAILED' },
    timestamp: events.at(-1).timestamp,
  });
});

test('FeishuLiveCot keeps visible text when native event content is truncated', async () => {
  const { cot, calls } = fixture();
  const longText = 'x'.repeat(8_000);

  await cot.handle({ type: 'turn-start', turn: 9 });
  await cot.handle({ type: 'reasoning', turn: 9, text: longText });
  await cot.finish();

  const content = decoded(calls)
    .find(({ type }) => type === 'REASONING_MESSAGE_CONTENT')
    .content;
  assert.equal(content.truncated, true);
  assert.equal(typeof content.delta, 'string');
  assert.ok(content.delta.length > 0);
  assert.ok(content.delta.length < longText.length);
  assert.ok(JSON.stringify(content).length <= 4_096);
});

for (const reason of [
  { kind: 'max-tokens' },
  { kind: 'blocked' },
  { kind: 'interrupted' },
  { kind: 'stopped' },
  { kind: 'cancelled' },
  { kind: 'canceled' },
  { kind: 'aborted' },
  { kind: 'unknown-terminal' },
]) {
  test(`FeishuLiveCot reports ${reason.kind} as a failed run`, async () => {
    const { cot, calls } = fixture();
    await cot.handle({ type: 'turn-start', turn: 2 });
    await cot.handle({ type: 'turn-end', turn: 2, reason });

    const terminal = decoded(calls).at(-1);
    assert.equal(terminal.type, 'RUN_ERROR');
    assert.equal(terminal.content.code, 'TURN_FAILED');
    assert.match(terminal.content.message, new RegExp(reason.kind));
  });
}

test('FeishuLiveCot contains native process failures', async () => {
  const failure = new Error('native CoT unavailable');
  const { cot, calls } = fixture({ createError: failure });
  await cot.handle({ type: 'turn-start', turn: 1 });
  await cot.handle({ type: 'reasoning', turn: 1, text: 'ignored' });
  await cot.finish();

  assert.deepEqual(calls.failures, [failure]);
  assert.equal(calls.writes.length, 0);
});

test('FeishuLiveCot queues reasoning without waiting for each network write', async () => {
  const releaseFirstWrite = deferred();
  const writes = [];
  let calls = 0;
  const channel = {
    async createCot() {
      return { cotId: 'cot-fast', messageId: 'om-cot-fast' };
    },
    async writeCotEvents(_handle, events) {
      calls += 1;
      writes.push(events);
      if (calls === 1) await releaseFirstWrite.promise;
    },
  };
  const cot = new FeishuLiveCot(channel, 'oc-chat');

  await cot.handle({ type: 'turn-start', turn: 1 });
  for (const text of ['思', '考', '过', '程']) {
    await cot.handle({ type: 'reasoning', turn: 1, text });
  }

  assert.equal(calls, 1, 'only the already-running request may be in flight');
  releaseFirstWrite.resolve();
  await cot.finish();

  assert.ok(writes.some((batch) => batch.length > 1),
    'queued deltas should share a later batch instead of one round trip each');
  assert.deepEqual(
    writes.flat().filter(({ event_type }) => event_type === 'REASONING_MESSAGE_CONTENT')
      .map(({ content }) => JSON.parse(content).delta),
    ['思', '考', '过', '程'],
  );
});
