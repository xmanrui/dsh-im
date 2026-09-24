import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeFeishuSnapshotState } from '../plugin-src/client/channels/feishu/index.js';
import { mergeWeixinProvisioningSnapshot } from '../plugin-src/client/channels/weixin/index.js';
import {
  createAnimationFrameScheduler,
  createPollScheduler,
} from '../plugin-src/client/lifecycle.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(callback) {
      const id = nextId;
      nextId += 1;
      pending.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    runNext() {
      const entry = pending.entries().next().value;
      if (!entry) return false;
      const [id, callback] = entry;
      pending.delete(id);
      callback();
      return true;
    },
    get size() {
      return pending.size;
    },
  };
}

test('disposed Weixin polling cannot schedule a zombie timer after a late RPC', async () => {
  const timers = fakeTimers();
  const response = deferred();
  const scheduler = createPollScheduler({
    setTimeoutFn: (callback) => timers.setTimeout(callback),
    clearTimeoutFn: (id) => timers.clearTimeout(id),
  });
  let polls = 0;
  const poll = async () => {
    polls += 1;
    await response.promise;
    scheduler.schedule(poll, 1_000);
  };

  scheduler.schedule(poll, 0);
  assert.equal(timers.runNext(), true);
  assert.equal(polls, 1);
  assert.equal(timers.size, 0);

  scheduler.dispose();
  response.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(timers.size, 0);
  assert.equal(scheduler.schedule(poll, 1_000), false);
});

test('disposing an animation-frame scheduler cancels callbacks queued by a removed tab', () => {
  let nextId = 1;
  const pending = new Map();
  const cancelled = [];
  const scheduler = createAnimationFrameScheduler({
    requestFrame(callback) {
      const id = nextId;
      nextId += 1;
      pending.set(id, callback);
      return id;
    },
    cancelFrame(id) {
      cancelled.push(id);
      pending.delete(id);
    },
  });
  let ran = false;

  scheduler.schedule(() => {
    ran = true;
  });
  scheduler.dispose();

  assert.deepEqual(cancelled, [1]);
  assert.equal(pending.size, 0);
  assert.equal(ran, false);
  assert.equal(scheduler.schedule(() => {}), false);
});

test('keyed animation frames keep only the latest announcement', () => {
  let nextId = 1;
  const pending = new Map();
  const cancelled = [];
  const scheduler = createAnimationFrameScheduler({
    requestFrame(callback) {
      const id = nextId;
      nextId += 1;
      pending.set(id, callback);
      return id;
    },
    cancelFrame(id) {
      cancelled.push(id);
      pending.delete(id);
    },
  });
  const announcements = [];

  scheduler.schedule(() => announcements.push('old'), 'announcement');
  scheduler.schedule(() => announcements.push('new'), 'announcement');

  assert.deepEqual(cancelled, [1]);
  assert.deepEqual([...pending.keys()], [2]);
  const latest = pending.get(2);
  pending.delete(2);
  latest();
  assert.deepEqual(announcements, ['new']);
  scheduler.dispose();
});

test('periodic snapshots cannot restore locally cancelled Weixin or Feishu provisioning', () => {
  const weixinProvisioning = {
    attemptId: 'wx_attempt_stale',
    status: 'pending',
    expiresAt: 2_000,
  };
  assert.equal(mergeWeixinProvisioningSnapshot(
    null,
    weixinProvisioning,
    { restoreProvisioning: false },
  ), null);
  assert.equal(
    mergeWeixinProvisioningSnapshot(
      null,
      weixinProvisioning,
      { restoreProvisioning: true },
    )?.attemptId,
    'wx_attempt_stale',
  );

  const current = {
    phase: 'ready',
    revision: 3,
    bots: [],
    totals: { configured: 0, connected: 0 },
    provisioning: null,
    pageError: null,
    statusError: null,
  };
  const snapshot = {
    revision: 4,
    state: 'provisioning',
    bots: [],
    totals: { configured: 0, connected: 0 },
    provisioning: {
      attemptId: 'fs_attempt_stale',
      expiresAt: 2_000,
    },
  };
  assert.equal(mergeFeishuSnapshotState(
    current,
    snapshot,
    { restoreProvisioning: false, now: 1_000 },
  ).provisioning, null);
  assert.equal(
    mergeFeishuSnapshotState(
      current,
      snapshot,
      { restoreProvisioning: true, now: 1_000 },
    ).provisioning.attemptId,
    'fs_attempt_stale',
  );
});

test('Feishu restores a submitted callback repair as non-cancellable connecting state', () => {
  const current = {
    phase: 'ready',
    revision: 3,
    bots: [],
    totals: { configured: 1, connected: 1 },
    provisioning: null,
    pageError: null,
    statusError: null,
  };
  const restored = mergeFeishuSnapshotState(current, {
    revision: 4,
    // The target runtime can remain connected while the callback proof is
    // pending, so Host aggregate state alone cannot identify this phase.
    state: 'connected',
    bots: [],
    totals: { configured: 1, connected: 1 },
    provisioning: {
      attemptId: 'reg_committed',
      operation: 'callback_repair',
      botId: 'bot_target',
      submitted: true,
      expiresAt: 1,
      pollIntervalMs: 800,
    },
  }, { restoreProvisioning: true, now: 2_000 });

  assert.equal(restored.provisioning.phase, 'connecting');
  assert.equal(restored.provisioning.expired, false);
});
