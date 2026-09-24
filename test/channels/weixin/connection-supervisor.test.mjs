import assert from 'node:assert/strict';
import test from 'node:test';

import { ConnectionSupervisor } from '../../../plugin-src/host/channels/weixin/connection-supervisor.mjs';

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
    clearTimeoutImpl(handle) { handle.cancelled = true; },
    async runNext() {
      const handle = pending.shift();
      assert.ok(handle);
      assert.equal(handle.cancelled, false);
      handle.callback();
      await flush();
      await flush();
      return handle.delay;
    },
  };
}

test('supervisor waits for the in-process Harness API and retries offline Weixin accounts', async () => {
  const timers = scheduler();
  let healthChecks = 0;
  let initializations = 0;
  const supervisor = new ConnectionSupervisor({
    harness: {
      async ensureRunning() {
        healthChecks += 1;
        if (healthChecks === 1) throw new Error('Host is still starting');
      },
    },
    controller: {
      async initialize() {
        initializations += 1;
        return {
          totals: { configured: 1, connected: initializations > 1 ? 1 : 0 },
        };
      },
      status() {},
    },
    logger: { warn() {} },
    retryDelaysMs: [5, 10],
    healthyIntervalMs: 100,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  }).start();

  assert.equal(await timers.runNext(), 0);
  assert.equal(timers.pending[0].delay, 5);
  await timers.runNext();
  assert.equal(initializations, 1);
  assert.equal(timers.pending[0].delay, 10);
  await timers.runNext();
  assert.equal(initializations, 2);
  assert.equal((await supervisor.ready).totals.connected, 0);
  assert.equal(timers.pending[0].delay, 100);
  await supervisor.close();
  assert.equal(timers.pending[0].cancelled, true);
});
