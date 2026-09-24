import assert from 'node:assert/strict';
import test from 'node:test';

import { ConnectionSupervisor } from '../../../plugin-src/host/channels/dingtalk/connection-supervisor.mjs';

function scheduler() {
  const tasks = [];
  return {
    tasks,
    setTimeout(callback, delay) {
      const task = { callback, delay, unref() {} };
      tasks.push(task);
      return task;
    },
    clearTimeout(task) {
      const index = tasks.indexOf(task);
      if (index >= 0) tasks.splice(index, 1);
    },
    async runNext() {
      const task = tasks.shift();
      assert.ok(task);
      task.callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test('supervisor starts configured DingTalk runtimes after Harness is healthy', async () => {
  const timers = scheduler();
  let healthChecks = 0;
  let initializes = 0;
  const supervisor = new ConnectionSupervisor({
    harness: { async ensureRunning() { healthChecks += 1; } },
    controller: {
      async initialize() {
        initializes += 1;
        return { totals: { configured: 1, connected: 1 } };
      },
      status() {},
    },
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    healthyIntervalMs: 9_000,
  }).start();

  await timers.runNext();
  assert.equal(healthChecks, 1);
  assert.equal(initializes, 1);
  assert.equal((await supervisor.ready).totals.connected, 1);
  assert.equal(timers.tasks[0].delay, 9_000);
  await supervisor.close();
});

test('supervisor retries an offline DingTalk runtime without blocking startup', async () => {
  const timers = scheduler();
  const warnings = [];
  const supervisor = new ConnectionSupervisor({
    harness: { async ensureRunning() {} },
    controller: {
      async initialize() { return { totals: { configured: 2, connected: 1 } }; },
      status() {},
    },
    logger: { warn: (...args) => warnings.push(args) },
    retryDelaysMs: [7, 11],
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  }).start();

  await timers.runNext();
  assert.equal(timers.tasks[0].delay, 7);
  assert.match(warnings[0][0], /1\/2 bots connected/);
  await supervisor.close();
});
