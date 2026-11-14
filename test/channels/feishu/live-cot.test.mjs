import test from 'node:test';
import assert from 'node:assert/strict';

import { FeishuLiveCot } from '../../../src/channels/feishu/live-cot.mjs';

function fixture({ createError, writeError, completeError, createResult, ...options } = {}) {
  const calls = { creates: [], writes: [], completes: [], failures: [] };
  const channel = {
    async createCot(chatId, createOptions) {
      calls.creates.push({ chatId, options: createOptions });
      if (createError) throw createError;
      return createResult ?? { cotId: 'cot-1', messageId: 'om-cot-1' };
    },
    async writeCotEvents(handle, events) {
      calls.writes.push({ handle, events });
      if (writeError) throw writeError;
    },
    async completeCot(handle, reason) {
      calls.completes.push({ handle, reason });
      if (completeError) throw completeError;
    },
  };
  const cot = new FeishuLiveCot(channel, 'oc-chat', {
    replyTo: 'om-user',
    onFailure: (error) => calls.failures.push(error),
    requestIntervalMs: 0,
    ...options,
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

test('FeishuLiveCot stays open while subagents are pending and closes once after their summary', async () => {
  const { cot, calls } = fixture();
  await cot.handle({ type: 'turn-start', turn: 1 });
  await cot.handle({ type: 'turn-end', turn: 1, reason: 'completed', pendingSubagents: ['child'] });
  assert.equal(calls.completes.length, 0);
  assert.deepEqual(decoded(calls).map(({ type }) => type), ['RUN_STARTED']);
  await cot.finish({ kind: 'completed' });
  await cot.finish({ kind: 'completed' });
  assert.equal(calls.completes.length, 1);
  assert.equal(decoded(calls).at(-1).type, 'RUN_FINISHED');
});

test('FeishuLiveCot still closes on interruption with unresolved children', async () => {
  const { cot, calls } = fixture();
  await cot.handle({ type: 'turn-end', turn: 1, reason: 'interrupted', pendingSubagents: ['child'] });
  assert.equal(calls.completes.length, 1);
  assert.equal(decoded(calls).at(-1).content.status, 'interrupted');
});

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
  assert.deepEqual(events.at(-1).content, {
    threadId: 'oc-chat',
    runId: 'turn-7',
    status: 'done',
  });
  assert.deepEqual(calls.completes, [{
    handle: { cotId: 'cot-1', messageId: 'om-cot-1' },
    reason: 'done',
  }], 'CompleteCOT closes the native lifecycle after the terminal event');
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
  assert.deepEqual(calls.completes.map(({ reason }) => reason), ['error']);
});

test('FeishuLiveCot preserves text and arguments across bounded native event batches', async (t) => {
  for (const text of ['short', 'x'.repeat(4_096), 'x'.repeat(220_000), '中😀\0\n"\\'.repeat(2_000)]) {
    await t.test(`input length ${text.length}`, async () => {
      const { cot, calls } = fixture();
      await cot.handle({ type: 'reasoning', turn: 9, text });
      await cot.handle({ type: 'assistant-message', turn: 9, step: 0, text });
      await cot.handle({ type: 'tool', turn: 9, callId: 'call', name: 'read', arguments: text });
      await cot.finish();
      const events = decoded(calls);
      for (const type of ['REASONING_MESSAGE_CONTENT', 'TEXT_MESSAGE_CONTENT', 'TOOL_CALL_ARGS']) {
        const chunks = events.filter((event) => event.type === type);
        assert.equal(chunks.map(({ content }) => content.delta).join(''), text);
        assert.ok(chunks.every(({ content }) => content.delta.isWellFormed()));
        assert.ok(chunks.every(({ content }) => !content.truncated));
      }
      assert.ok(calls.writes.every(({ events: batch }) => batch.length <= 50));
      assert.ok(calls.writes.flatMap(({ events: batch }) => batch)
        .every((event) => event.content.length <= 4_096));
      assert.ok(events.every((event, index) => index === 0 || event.timestamp > events[index - 1].timestamp));
      assert.equal(events.at(-1).type, 'RUN_FINISHED');
      assert.deepEqual(calls.failures, []);
    });
  }
});

test('FeishuLiveCot bounds escaped tool results and errors while retaining their schema', async () => {
  const { cot, calls } = fixture();
  const text = '😀\0"\\\n'.repeat(500);
  await cot.handle({ type: 'tool-result', turn: 1, callId: 'result', text, errorCode: 'FAILED' });
  await cot.finish(new Error(text));
  const events = decoded(calls);
  const result = events.find(({ type }) => type === 'TOOL_CALL_RESULT').content;
  assert.ok(calls.writes.flatMap(({ events: batch }) => batch)
    .every((event) => event.content.length <= 4_096));
  assert.equal(result.content.type, 'code');
  assert.equal(result.toolCallId, 'result');
  assert.equal(result.error, 'FAILED');
  for (const value of [result.content.code, events.at(-1).content.message]) {
    assert.ok(value.length > 0);
    assert.ok(value.isWellFormed());
    assert.ok(value.endsWith('…'));
    assert.ok(text.startsWith(value.slice(0, -1)));
  }
  assert.equal(events.at(-1).type, 'RUN_ERROR');
  assert.equal(events.at(-1).content.code, 'TURN_FAILED');
});

test('FeishuLiveCot handles exact JSON boundaries and Unicode summary boundaries', async (t) => {
  const capacity = 4_096 - JSON.stringify({ messageId: 'reasoning-1-0', delta: '' }).length;
  for (const size of [capacity - 1, capacity, capacity + 1]) {
    await t.test(`delta length ${size}`, async () => {
      const { cot, calls } = fixture();
      await cot.handle({ type: 'reasoning', turn: 1, text: 'x'.repeat(size) });
      await cot.finish();
      const chunks = decoded(calls).filter(({ type }) => type === 'REASONING_MESSAGE_CONTENT');
      assert.equal(chunks.length, size > capacity ? 2 : 1);
      assert.equal(chunks.map(({ content }) => content.delta).join(''), 'x'.repeat(size));
      assert.ok(chunks.every(({ content }) => JSON.stringify(content).length <= 4_096));
    });
  }
  const { cot, calls } = fixture();
  await cot.handle({ type: 'tool-result', turn: 1, callId: 'call', text: `${'x'.repeat(1498)}😀tail` });
  await cot.finish();
  const result = decoded(calls).find(({ type }) => type === 'TOOL_CALL_RESULT').content;
  assert.equal(result.content.code, `${'x'.repeat(1498)}…`);
});

test('FeishuLiveCot contains oversized metadata without emitting invalid events', async () => {
  const { cot, calls } = fixture();
  await cot.handle({ type: 'turn-start', turn: 1 });
  await cot.handle({ type: 'tool', turn: 1, name: 'read', callId: 'x'.repeat(5_000) });
  await cot.finish();
  assert.equal(calls.failures.length, 1);
  assert.match(calls.failures[0].message, /metadata exceeds/);
  assert.ok(calls.writes.flatMap(({ events }) => events).every((event) => event.content.length <= 4_096));
  assert.equal(calls.completes.length, 1);
});

test('FeishuLiveCot gives each reasoning segment a unique, consistently closed ID', async () => {
  const { cot, calls } = fixture();
  await cot.handle({ type: 'reasoning', turn: 3, text: 'first' });
  await cot.handle({ type: 'reasoning', turn: 3, text: 'continued' });
  await cot.handle({ type: 'tool', turn: 3, callId: 'call', name: 'read' });
  await cot.handle({ type: 'reasoning', turn: 3, text: 'next' });
  await cot.finish();
  const events = decoded(calls).filter(({ type }) => type.startsWith('REASONING_MESSAGE_'));
  const starts = events.filter(({ type }) => type === 'REASONING_MESSAGE_START');
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].content.messageId, starts[1].content.messageId);
  for (const [index, start] of starts.entries()) {
    const segment = events.filter(({ content }) => content.messageId === start.content.messageId);
    assert.equal(segment[0].type, 'REASONING_MESSAGE_START');
    assert.equal(segment.at(-1).type, 'REASONING_MESSAGE_END');
    assert.equal(segment.filter(({ type }) => type === 'REASONING_MESSAGE_END').length, 1);
    assert.equal(segment.map(({ content }) => content.delta ?? '').join(''), index ? 'next' : 'firstcontinued');
  }
});

for (const reason of [
  { kind: 'max-tokens' },
  { kind: 'blocked' },
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
    assert.deepEqual(calls.completes.map(({ reason: completed }) => completed), ['error']);
  });
}

for (const reason of [
  { kind: 'interrupted' },
  { kind: 'stopped' },
  { kind: 'cancelled' },
  { kind: 'canceled' },
  Object.assign(new Error('stopped'), { code: 'turn-stopped' }),
  Object.assign(new Error('interrupted'), { code: 'turn-interrupted' }),
]) {
  const label = reason instanceof Error ? reason.code : reason.kind;
  test(`FeishuLiveCot closes a ${label} turn as interrupted, not failed`, async () => {
    const { cot, calls } = fixture();
    await cot.handle({ type: 'turn-start', turn: 3 });
    await cot.finish(reason);

    const events = decoded(calls);
    assert.ok(!events.some(({ type }) => type === 'RUN_ERROR'));
    assert.deepEqual(events.at(-1).type, 'RUN_FINISHED');
    assert.deepEqual(events.at(-1).content, {
      threadId: 'oc-chat',
      runId: 'turn-3',
      status: 'interrupted',
    });
    // A stopped run completes with reason=error so it is not shown as completed.
    assert.deepEqual(calls.completes.map(({ reason: completed }) => completed), ['error']);
  });
}

test('FeishuLiveCot closes once when a stop races the turn end', async () => {
  const { cot, calls } = fixture();
  await cot.handle({ type: 'turn-start', turn: 5 });
  await cot.handle({ type: 'reasoning', turn: 5, text: '执行中' });
  const stopping = cot.finish({ kind: 'interrupted' });
  await cot.handle({ type: 'tool', turn: 5, callId: 'late', name: 'bash' });
  await cot.handle({ type: 'turn-end', turn: 5, reason: { kind: 'completed' } });
  await Promise.all([stopping, cot.finish()]);

  const events = decoded(calls);
  assert.deepEqual(events.slice(-2).map(({ type }) => type), [
    'REASONING_MESSAGE_END',
    'RUN_FINISHED',
  ]);
  assert.equal(events.at(-1).content.status, 'interrupted');
  assert.ok(!events.some(({ type }) => type === 'TOOL_CALL_START'),
    'nothing is written after the terminal event');
  assert.equal(calls.completes.length, 1);
});

test('FeishuLiveCot still completes the process after a write failure', async () => {
  const failure = new Error('write rejected');
  const { cot, calls } = fixture({ writeError: failure });
  await cot.handle({ type: 'turn-start', turn: 1 });
  await cot.handle({ type: 'reasoning', turn: 1, text: 'ignored' });
  await cot.finish();

  assert.deepEqual(calls.failures, [failure]);
  assert.deepEqual(calls.completes.map(({ reason }) => reason), ['done'],
    'the IM message must not stay in the running state');
});

test('FeishuLiveCot contains a CompleteCOT failure', async () => {
  const failure = new Error('complete rejected');
  const { cot, calls } = fixture({ completeError: failure });
  await cot.handle({ type: 'turn-start', turn: 1 });
  await cot.finish();

  assert.deepEqual(calls.failures, [failure]);
});

test('FeishuLiveCot opens a topic turn inside the topic', async () => {
  const threadIds = [];
  const { cot, calls } = fixture({
    replyInThread: true,
    onReplyThreadId: async (threadId) => threadIds.push(threadId),
    createResult: { cotId: 'cot-topic', messageId: 'om-cot-topic', threadId: 'omt-topic' },
  });
  await cot.handle({ type: 'turn-start', turn: 1 });
  await cot.finish();

  assert.deepEqual(calls.creates, [{
    chatId: 'oc-chat',
    options: { replyTo: 'om-user', replyInThread: true, hidden: false },
  }]);
  assert.deepEqual(threadIds, ['omt-topic']);
});

test('FeishuLiveCot spaces requests on one process', async () => {
  const startedAt = [];
  const channel = {
    async createCot() {
      startedAt.push(Date.now());
      return { cotId: 'cot-paced', messageId: 'om-cot-paced' };
    },
    async writeCotEvents() {
      startedAt.push(Date.now());
    },
    async completeCot() {
      startedAt.push(Date.now());
    },
  };
  const cot = new FeishuLiveCot(channel, 'oc-chat', { requestIntervalMs: 30 });
  await cot.handle({ type: 'turn-start', turn: 1 });
  await cot.handle({ type: 'reasoning', turn: 1, text: '一' });
  await cot.finish();

  assert.ok(startedAt.length >= 3);
  for (let index = 1; index < startedAt.length; index += 1) {
    assert.ok(startedAt[index] - startedAt[index - 1] >= 25,
      `request ${index} must wait for the per-process interval`);
  }
});

test('FeishuLiveCot contains native process failures', async () => {
  const failure = new Error('native CoT unavailable');
  const { cot, calls } = fixture({ createError: failure });
  await cot.handle({ type: 'turn-start', turn: 1 });
  await cot.handle({ type: 'reasoning', turn: 1, text: 'ignored' });
  await cot.finish();

  assert.deepEqual(calls.failures, [failure]);
  assert.equal(calls.writes.length, 0);
  assert.equal(calls.completes.length, 0, 'no process was opened, so none is completed');
});

test('FeishuLiveCot queues reasoning without waiting for each network write', async () => {
  const releaseFirstWrite = deferred();
  const firstWriteStarted = deferred();
  const writes = [];
  let calls = 0;
  const channel = {
    async createCot() {
      return { cotId: 'cot-fast', messageId: 'om-cot-fast' };
    },
    async writeCotEvents(_handle, events) {
      calls += 1;
      writes.push(events);
      if (calls === 1) {
        firstWriteStarted.resolve();
        await releaseFirstWrite.promise;
      }
    },
  };
  const cot = new FeishuLiveCot(channel, 'oc-chat');

  await cot.handle({ type: 'turn-start', turn: 1 });
  await firstWriteStarted.promise;
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
