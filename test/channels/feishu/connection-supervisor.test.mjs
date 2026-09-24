import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectionSupervisor } from '../../../plugin-src/host/channels/feishu/connection-supervisor.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function scheduler() {
  const pending = [];
  return {
    pending,
    setTimeoutImpl(callback, delay) {
      const handle = { callback, delay, cancelled: false, unref() {} };
      pending.push(handle);
      return handle;
    },
    clearTimeoutImpl(handle) {
      handle.cancelled = true;
    },
    async runNext() {
      const handle = pending.shift();
      assert.ok(handle, 'expected a scheduled supervisor pass');
      assert.equal(handle.cancelled, false);
      handle.callback();
      await flush();
      await flush();
      return handle.delay;
    },
  };
}

test('supervisor waits for the in-process Harness Host before initializing bots', async () => {
  const timers = scheduler();
  const warnings = [];
  let healthChecks = 0;
  let initializations = 0;
  const controller = {
    async initialize() { initializations += 1; },
    status() { return { totals: { configured: 1, connected: 1 } }; },
  };
  const supervisor = new ConnectionSupervisor({
    controller,
    harness: {
      async ensureRunning() {
        healthChecks += 1;
        if (healthChecks < 3) throw new Error('Host is still starting');
      },
    },
    logger: { warn: (...args) => warnings.push(args) },
    retryDelaysMs: [5, 10],
    healthyIntervalMs: 100,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  }).start();

  assert.equal(await timers.runNext(), 0);
  assert.equal(initializations, 0);
  assert.equal(timers.pending[0].delay, 5);
  await timers.runNext();
  assert.equal(initializations, 0);
  assert.equal(timers.pending[0].delay, 10);
  await timers.runNext();
  assert.equal(await supervisor.ready.then((status) => status.totals.connected), 1);
  assert.equal(initializations, 1);
  assert.equal(timers.pending[0].delay, 100);
  assert.equal(warnings.length, 2);

  await supervisor.close();
  assert.equal(timers.pending[0].cancelled, true);
});

test('supervisor retries an offline bot and leaves the recovered connection on the health interval', async () => {
  const timers = scheduler();
  let initializations = 0;
  const controller = {
    async initialize() { initializations += 1; },
    status() {
      return { totals: { configured: 1, connected: initializations >= 2 ? 1 : 0 } };
    },
  };
  const supervisor = new ConnectionSupervisor({
    controller,
    harness: { async ensureRunning() {} },
    logger: { warn() {} },
    retryDelaysMs: [7],
    healthyIntervalMs: 101,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  }).start();

  await timers.runNext();
  assert.equal(initializations, 1);
  assert.equal(timers.pending[0].delay, 7);
  await timers.runNext();
  assert.equal(initializations, 2);
  assert.equal(timers.pending[0].delay, 101);

  await supervisor.close();
});

test('supervisor awaits an asynchronous controller status before resolving readiness', async () => {
  const timers = scheduler();
  let resolveStatus;
  let readyResolved = false;
  const pendingStatus = new Promise((resolve) => { resolveStatus = resolve; });
  const supervisor = new ConnectionSupervisor({
    controller: {
      async initialize() {},
      status() { return pendingStatus; },
    },
    harness: { async ensureRunning() {} },
    logger: { warn() {} },
    healthyIntervalMs: 103,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  }).start();
  void supervisor.ready.then(() => { readyResolved = true; });

  await timers.runNext();
  assert.equal(readyResolved, false);
  assert.equal(timers.pending.length, 0);

  resolveStatus({ totals: { configured: 1, connected: 1 } });
  assert.equal((await supervisor.ready).totals.connected, 1);
  await flush();
  assert.equal(timers.pending[0].delay, 103);

  await supervisor.close();
});
