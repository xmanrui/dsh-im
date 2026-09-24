import assert from 'node:assert/strict';
import test from 'node:test';

import { createDingTalkCardStream } from '../../../src/channels/dingtalk/dingtalk-card-stream.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function scheduler() {
  let now = 0;
  const tasks = [];
  return {
    clock: () => now,
    timer: {
      setTimeout(callback, delay) {
        const task = { callback, at: now + delay };
        tasks.push(task);
        return task;
      },
      clearTimeout(task) {
        const index = tasks.indexOf(task);
        if (index >= 0) tasks.splice(index, 1);
      },
    },
    tasks,
    async advance(milliseconds) {
      now += milliseconds;
      while (true) {
        tasks.sort((left, right) => left.at - right.at);
        const task = tasks[0];
        if (!task || task.at > now) break;
        tasks.shift();
        task.callback();
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

function fixture(overrides = {}) {
  const calls = { create: [], update: [], finish: [], fail: [] };
  return {
    calls,
    api: {
      async createAiCard(request) {
        calls.create.push(request);
        return { cardInstanceId: 'card-one' };
      },
      async updateAiCard(request) {
        calls.update.push(request);
      },
      async finishAiCard(request) {
        calls.finish.push(request);
      },
      async failAiCard(request) {
        calls.fail.push(request);
      },
      ...overrides,
    },
  };
}

function createStream(api, options = {}) {
  return createDingTalkCardStream({
    api,
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    target: { openConversationId: 'conversation-one' },
    updateIntervalMs: 0,
    ...options,
  });
}

test('finish waits for an in-flight update and discards stale pending progress', async () => {
  const activeUpdate = deferred();
  const fixtureValue = fixture({
    async updateAiCard(request) {
      fixtureValue.calls.update.push(request);
      await activeUpdate.promise;
    },
  });
  const stream = createStream(fixtureValue.api, { logger: { error() {} } });

  assert.deepEqual(stream.providerMessageIds, []);
  assert.equal(await stream.start('正在处理'), true);
  assert.deepEqual(stream.providerMessageIds, ['card-one']);
  stream.push('第一段');
  stream.push('应丢弃的旧进度');
  const finishing = stream.finish('最终答案');

  assert.equal(fixtureValue.calls.finish.length, 0);
  activeUpdate.resolve();
  assert.equal(await finishing, true);
  assert.deepEqual(fixtureValue.calls.create, [{
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    target: { openConversationId: 'conversation-one' },
    initialText: '正在处理',
    signal: undefined,
  }]);
  assert.deepEqual(fixtureValue.calls.update.map(({ text, finished }) => ({ text, finished })), [
    { text: '第一段', finished: false },
  ]);
  assert.deepEqual(fixtureValue.calls.finish.map(({ text }) => text), ['最终答案']);
});

test('progress buffering sends only the latest text after the throttle delay', async () => {
  const timers = scheduler();
  const fixtureValue = fixture();
  const stream = createStream(fixtureValue.api, {
    updateIntervalMs: 800,
    clock: timers.clock,
    timer: timers.timer,
  });

  await stream.start('开始');
  stream.push('草稿一');
  stream.push('草稿二');
  stream.push('草稿三');

  assert.equal(timers.tasks.length, 1);
  await timers.advance(799);
  assert.equal(fixtureValue.calls.update.length, 0);
  await timers.advance(1);
  assert.deepEqual(fixtureValue.calls.update.map(({ text }) => text), ['草稿三']);
  assert.equal(await stream.finish('完成'), true);
});

test('an API failure permanently closes the stream without exposing request data', async () => {
  const logged = [];
  const fixtureValue = fixture({
    async updateAiCard(request) {
      fixtureValue.calls.update.push(request);
      throw new Error(`remote rejected ${request.clientSecret}`);
    },
  });
  const stream = createStream(fixtureValue.api, {
    logger: { error: (...args) => logged.push(args) },
  });

  await stream.start('开始');
  stream.push('失败的更新');
  assert.equal(await stream.finish('不会发送'), false);
  stream.push('失败后忽略');
  assert.equal(await stream.finish('仍然不会发送'), false);

  assert.equal(fixtureValue.calls.update.length, 1);
  assert.equal(fixtureValue.calls.finish.length, 0);
  assert.equal(fixtureValue.calls.fail.length, 1);
  assert.deepEqual(logged, [['[dsh-dingtalk] AI Card update failed']]);
  assert.doesNotMatch(JSON.stringify(logged), /host-secret|conversation-one/);
});

test('abort cancels a scheduled update and prevents finalization', async () => {
  const timers = scheduler();
  const controller = new AbortController();
  const fixtureValue = fixture();
  const stream = createStream(fixtureValue.api, {
    signal: controller.signal,
    updateIntervalMs: 800,
    clock: timers.clock,
    timer: timers.timer,
  });

  assert.equal(await stream.start('开始'), true);
  stream.push('等待发送');
  assert.equal(timers.tasks.length, 1);
  controller.abort();

  assert.equal(timers.tasks.length, 0);
  await timers.advance(800);
  assert.equal(fixtureValue.calls.update.length, 0);
  assert.equal(await stream.finish('不会完成'), false);
  assert.equal(fixtureValue.calls.finish.length, 0);
  assert.equal(fixtureValue.calls.fail.length, 1);
});

test('a failed final frame closes the delivered card once and requests text fallback', async () => {
  const fixtureValue = fixture({
    async finishAiCard(request) {
      fixtureValue.calls.finish.push(request);
      throw new Error('final frame rejected');
    },
  });
  const stream = createStream(fixtureValue.api, { logger: { error() {} } });

  assert.equal(await stream.start('开始'), true);
  assert.equal(await stream.finish('最终答案'), false);

  assert.equal(fixtureValue.calls.finish.length, 1);
  assert.equal(fixtureValue.calls.fail.length, 1);
  assert.equal(fixtureValue.calls.fail[0].text, '卡片已结束，请查看后续消息。');
  assert.notEqual(fixtureValue.calls.fail[0].signal, fixtureValue.calls.finish[0].signal);
});
