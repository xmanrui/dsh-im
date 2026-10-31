import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WechatGroupRuntime } from '../../../src/channels/weixin/wechat-group-runtime.mjs';

const CONFIG = {
  pollIntervalMs: 750,
  groups: [{
    id: 'uia_group_one',
    title: '精确群名',
    commandPrefix: '/dsh',
    mentionMode: 'command',
    allowSelf: false,
  }],
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function eventually(predicate, message = 'condition was not met') {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function groupEvent(overrides = {}) {
  return {
    source: 'uia-wechat-group/v1',
    message_id: 'message-1',
    message_type: 1,
    conversation_type: 'group',
    conversation_id: 'uia_group_one',
    conversation_title: '精确群名',
    from_user_id: 'uia-name:成员甲',
    sender_name: '成员甲',
    reply_target: 'uia_group_one',
    addressed: true,
    text: '正文',
    raw_text: '/dsh 正文',
    sent_at: 1,
    is_self: false,
    item_list: [{ type: 1, text_item: { text: '正文' } }],
    ...overrides,
  };
}

class FakeGroupProcess extends EventEmitter {
  constructor(order = []) {
    super();
    this.order = order;
    this.starts = 0;
    this.stops = 0;
    this.sends = [];
    this.manualReady = false;
    this.failStarts = 0;
    this.status = { running: false, ready: false, pid: 5100 };
  }

  async start() {
    this.starts += 1;
    if (this.failStarts > 0) {
      this.failStarts -= 1;
      this.status = { running: false, ready: false, pid: null };
      const error = new Error('start-failed');
      error.code = 'start-failed';
      throw error;
    }
    this.status = { running: true, ready: false, pid: 5100 + this.starts };
    if (!this.manualReady) {
      queueMicrotask(() => {
        this.status.ready = true;
        this.emit('ready');
      });
    }
    return this.status;
  }

  async stop() {
    this.stops += 1;
    this.order.push('processStop');
    this.status = { running: false, ready: false, pid: null };
    return this.status;
  }

  async sendText(request) {
    this.sends.push(request);
    return { ok: true, providerMessageIds: ['provider-runtime'] };
  }

  emitReady() {
    this.status.ready = true;
    this.emit('ready');
  }
}

function makeRuntime(t, options = {}) {
  const order = [];
  const groupProcess = options.groupProcess ?? new FakeGroupProcess(order);
  const accepted = [];
  const bridgeCalls = [];
  const logs = [];
  let acceptImpl = async (event) => { accepted.push(event); };
  const bridge = {
    accept: (event) => acceptImpl(event),
    waitForIdle: async () => { order.push('bridgeIdle'); },
    close: async () => { order.push('bridgeClose'); },
  };
  const runtime = new WechatGroupRuntime({
    config: CONFIG,
    process: groupProcess,
    baseUrl: 'uia-wechat-group://local',
    token: 'local-token',
    ownerUserId: 'local-owner',
    harness: { ensureRunning: async () => true },
    state: {},
    contextEnhancement: { enabled: true },
    accessPolicy: { group: { mode: 'allowlist' } },
    bridgeFactory: (bridgeOptions) => {
      bridgeCalls.push(bridgeOptions);
      return bridge;
    },
    restartDelaysMs: [],
    logger: {
      warn: (...args) => logs.push(args.join(' ')),
      error: (...args) => logs.push(args.join(' ')),
    },
    ...options,
  });
  t.after(async () => { await runtime.stop(); });
  return {
    runtime,
    groupProcess,
    accepted,
    bridgeCalls,
    logs,
    order,
    bridge,
    setAcceptImpl: (fn) => { acceptImpl = fn; },
  };
}

test('start without the shared account bridge fails before starting Python', async (t) => {
  const { runtime, groupProcess, order } = makeRuntime(t);
  await assert.rejects(runtime.start(), (error) => error.code === 'shared-bridge-required');
  assert.equal(groupProcess.starts, 0);
  assert.equal(order.includes('bridgeClose'), false);
});

test('start reuses the account bridge and routes UIA sends only to configured groups', async (t) => {
  const { runtime, groupProcess, bridgeCalls, bridge } = makeRuntime(t);
  await runtime.start({ bridge });
  assert.equal(bridgeCalls.length, 0);
  assert.equal(runtime.handles('uia_group_one'), true);
  assert.equal(runtime.handles('p2p-owner'), false);

  const result = await runtime.sendText({
    toUserId: 'uia_group_one', text: '群回复', requestId: 'out-runtime',
  });
  assert.deepEqual(result.providerMessageIds, ['provider-runtime']);
  assert.equal(groupProcess.sends[0].requestId, 'out-runtime');
  await assert.rejects(
    () => runtime.sendText({ toUserId: 'uia_unknown', text: '不得发送' }),
    (error) => error.code === 'unknown-group',
  );
  assert.equal(groupProcess.sends.length, 1);
});

test('unknown provider outcome surfaces as an uncertain send error instead of false success', async (t) => {
  const { runtime, groupProcess, bridge } = makeRuntime(t);
  await runtime.start({ bridge });
  groupProcess.sendText = async (request) => {
    groupProcess.sends.push(request);
    return {
      ok: false,
      status: 'unknown',
      code: 'outcome_unknown',
      providerMessageIds: [],
    };
  };
  await assert.rejects(
    () => runtime.sendText({
      toUserId: 'uia_group_one', text: '必须对账', requestId: 'out-uncertain',
    }),
    (error) => error.code === 'outcome_unknown',
  );
  assert.equal(groupProcess.sends.length, 1);
});

test('only complete addressed v1 events for the exact configured group reach the bridge', async (t) => {
  const { runtime, groupProcess, accepted, logs, bridge } = makeRuntime(t);
  await runtime.start({ bridge });
  groupProcess.emit('message', groupEvent());
  groupProcess.emit('message', groupEvent({ message_id: 'leading-space', raw_text: '  /dsh 正文' }));
  const rejected = [
    groupEvent({ message_id: 'bad-source', source: 'uia-wechat-group/v2' }),
    groupEvent({ message_id: 'bad-group', conversation_id: 'uia_unknown', reply_target: 'uia_unknown' }),
    groupEvent({ message_id: 'bad-title', conversation_title: '另一个群' }),
    groupEvent({ message_id: 'bad-target', reply_target: 'uia-name:成员甲' }),
    groupEvent({ message_id: 'not-addressed', addressed: false }),
    groupEvent({ message_id: 'no-member', from_user_id: '' }),
    groupEvent({ message_id: 'member-mismatch', from_user_id: 'uia-name:另一个人' }),
    groupEvent({ message_id: 'bad-trigger', raw_text: '/dsh正文' }),
    groupEvent({ message_id: 'bad-text', item_list: [{ type: 1, text_item: { text: '不一致' } }] }),
    groupEvent({ message_id: 'bad-time', sent_at: '1' }),
    groupEvent({ message_id: 'self-secret', is_self: true, raw_text: 'complete-secret-body' }),
  ];
  for (const event of rejected) groupProcess.emit('message', event);
  await runtime.waitForIdle();
  assert.deepEqual(accepted.map((event) => event.message_id), ['message-1', 'leading-space']);
  assert.equal(runtime.status.messagesRejected, rejected.length);
  assert.equal(logs.join('\n').includes('complete-secret-body'), false);
});

test('stop drains accepted work and stops the child without closing the shared bridge', async (t) => {
  const fixture = makeRuntime(t);
  const { runtime, groupProcess, order, setAcceptImpl, bridge } = fixture;
  const gate = deferred();
  setAcceptImpl(async () => {
    order.push('accept');
    await gate.promise;
  });
  await runtime.start({ bridge });
  groupProcess.emit('message', groupEvent());
  const stopping = runtime.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(order.includes('processStop'), false);
  groupProcess.emit('message', groupEvent({ message_id: 'after-stop-intake' }));
  gate.resolve();
  await stopping;
  assert.ok(order.indexOf('accept') < order.indexOf('processStop'));
  assert.equal(order.includes('bridgeClose'), false);
  assert.equal(runtime.status.ready, false);
  assert.equal(runtime.status.pending, 0);
});

test('crash restart drops pre-ready history and accepts only post-baseline events', async (t) => {
  const { runtime, groupProcess, accepted, bridge } = makeRuntime(t, { restartDelaysMs: [0] });
  await runtime.start({ bridge });
  groupProcess.manualReady = true;
  groupProcess.status = { running: false, ready: false, pid: null };
  groupProcess.emit('exit', { code: 1 });
  await eventually(() => groupProcess.starts === 2, 'restart was not attempted');
  assert.equal(runtime.status.ready, false);
  groupProcess.emit('message', groupEvent({ message_id: 'historical-replay' }));
  groupProcess.emitReady();
  groupProcess.emit('message', groupEvent({ message_id: 'new-after-baseline' }));
  await runtime.waitForIdle();
  assert.deepEqual(accepted.map((event) => event.message_id), ['new-after-baseline']);
  assert.equal(runtime.status.restarts, 1);
});

test('repeated restart failure leaves the group runtime offline without replay', async (t) => {
  const groupProcess = new FakeGroupProcess();
  const { runtime, accepted, bridge } = makeRuntime(t, {
    groupProcess,
    restartDelaysMs: [0, 0],
  });
  await runtime.start({ bridge });
  groupProcess.manualReady = true;
  groupProcess.failStarts = 2;
  groupProcess.emit('exit', { code: 1 });
  await eventually(() => groupProcess.starts === 3, 'bounded retries did not finish');
  await eventually(() => runtime.status.restartAttempts === 2, 'retry status was not recorded');
  assert.equal(runtime.status.ready, false);
  assert.equal(runtime.status.lastError, 'start-failed');
  groupProcess.emit('message', groupEvent({ message_id: 'offline-history' }));
  await runtime.waitForIdle();
  assert.equal(accepted.length, 0);
});

test('events emitted before the first ready baseline are rejected', async (t) => {
  const groupProcess = new FakeGroupProcess();
  groupProcess.manualReady = true;
  const { runtime, accepted, bridge } = makeRuntime(t, { groupProcess });
  await runtime.start({ bridge });
  assert.equal(runtime.status.ready, false);
  groupProcess.emit('message', groupEvent({ message_id: 'initial-history' }));
  groupProcess.emitReady();
  groupProcess.emit('message', groupEvent({ message_id: 'initial-new' }));
  await runtime.waitForIdle();
  assert.deepEqual(accepted.map((event) => event.message_id), ['initial-new']);
});
