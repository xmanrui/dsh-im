import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

async function eventually(predicate, message = 'condition was not met', budgetMs = 1_000) {
  const deadline = Date.now() + budgetMs;
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
      const code = this.failCode || 'start-failed';
      const error = new Error(code);
      error.code = code;
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

test('a failed start re-arms a retry instead of leaving the bridge dead', async (t) => {
  // The live failure was: WeChat was minimised/logged out at boot, the first start
  // threw, and nothing ever tried again - so a group message got no answer at all.
  let attempts = 0;
  let ready = false;
  const fakeProcess = new EventEmitter();
  fakeProcess.sendText = async () => ({ ok: true, providerMessageIds: [] });
  fakeProcess.stop = async () => {};
  fakeProcess.start = async () => {
    attempts += 1;
    if (!ready) throw Object.assign(new Error('adapter could not start'), { code: 'window_minimised' });
    fakeProcess.status = { ready: true };
    fakeProcess.emit('ready');
    return { ready: true };
  };
  fakeProcess.status = { ready: false };
  const runtime = new WechatGroupRuntime({
    config: CONFIG,
    process: fakeProcess,
    restartDelaysMs: [20],
    logger: { warn() {}, error() {}, info() {}, debug() {} },
  });
  t.after(() => runtime.stop().catch(() => undefined));
  const bridge = { accept: async () => {} };
  await assert.rejects(() => runtime.start({ bridge }), (error) => error.code === 'window_minimised');
  // The retry ladder must keep running after the throw.
  assert.equal(runtime.status.running, true);
  await eventually(() => attempts >= 2, 'the runtime never retried after a failed start');
  // Once the window comes back the retry must actually connect.
  ready = true;
  await eventually(() => runtime.status.ready === true, 'the retry never produced a ready bridge');
});

test('a restart after a failed start keeps the account bridge so real rows still arrive', async (t) => {
  // Measured live failure: the adapter was alive and emitting addressed rows, yet
  // the group stayed mute because #start() cleared #bridge on failure and
  // #restart() never restored it. The event was dropped with no log line, so the
  // healthiest-looking state was the broken one.
  let attempts = 0;
  let ready = false;
  const accepted = [];
  const fakeProcess = new EventEmitter();
  fakeProcess.sendText = async () => ({ ok: true, providerMessageIds: [] });
  fakeProcess.stop = async () => {};
  fakeProcess.start = async () => {
    attempts += 1;
    if (!ready) throw Object.assign(new Error('adapter could not start'), { code: 'window_minimised' });
    fakeProcess.status = { ready: true };
    fakeProcess.emit('ready');
    return { ready: true };
  };
  fakeProcess.status = { ready: false };
  const runtime = new WechatGroupRuntime({
    config: CONFIG,
    process: fakeProcess,
    restartDelaysMs: [20],
    logger: { warn() {}, error() {}, info() {}, debug() {} },
  });
  t.after(() => runtime.stop().catch(() => undefined));
  const bridge = { accept: async (event) => { accepted.push(event); } };
  await assert.rejects(() => runtime.start({ bridge }), (error) => error.code === 'window_minimised');
  ready = true;
  await eventually(() => runtime.status.ready === true, 'the retry never produced a ready bridge');
  fakeProcess.emit('message', groupEvent({ message_id: 'after-restart' }));
  await runtime.waitForIdle();
  assert.deepEqual(accepted.map((event) => event.message_id), ['after-restart']);
  assert.equal(runtime.status.messagesRejected, 0);
});

test('a dropped event names its reason instead of vanishing', async (t) => {
  const { runtime, groupProcess, logs } = makeRuntime(t);
  // No bridge was ever attached, so intake cannot open; a silent drop must be
  // visible in the log rather than looking like a healthy offline state.
  groupProcess.emit('message', groupEvent());
  assert.equal(
    logs.some((line) => line.includes('dropped group event')),
    true,
  );
  assert.equal(runtime.status.messagesRejected, 1);
});

test('a real unverified UIA row reaches the bridge and keeps its unknown identity', async (t) => {
  const { runtime, groupProcess, accepted, bridge } = makeRuntime(t, {
    config: { ...CONFIG, groups: [{ ...CONFIG.groups[0], allowUnverifiedTrigger: true }] },
  });
  await runtime.start({ bridge });
  // WeChat 4.1 exposes no sender, so the adapter reports this exact shape.
  const unverified = groupEvent({
    message_id: "real-unverified-row",
    from_user_id: "uia-unverified:row",
    sender_name: "uia-unverified:row",
  });
  groupProcess.emit("message", unverified);
  await runtime.waitForIdle();
  assert.deepEqual(accepted.map((event) => event.message_id), ["real-unverified-row"]);
  assert.equal(accepted[0].from_user_id, "uia-unverified:row");
  assert.equal(runtime.status.messagesRejected, 0);
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

const MENTION_CONFIG = {
  pollIntervalMs: 750,
  groups: [{
    id: 'uia_group_one',
    title: '精确群名',
    commandPrefix: '/dsh',
    mentionMode: 'mention',
    allowSelf: false,
    // Measured: rows carry no sender, so a mention group must opt in explicitly.
    allowUnverifiedTrigger: true,
  }],
};

test('a leading mention token is a valid trigger and the body is stripped', async (t) => {
  // The adapter strips @[___] before emitting, so the second proof here has to
  // re-derive the same rule: raw_text must start with a mention token and the
  // remainder must equal text. Without it an adapter bug or a forged event could
  // claim addressed=true on an ordinary message.
  const groupProcess = new FakeGroupProcess();
  const { runtime, accepted, bridge } = makeRuntime(t, {
    groupProcess, config: MENTION_CONFIG,
  });
  await runtime.start({ bridge });
  groupProcess.emit('message', groupEvent({
    message_id: 'mention-1', from_user_id: 'uia-unverified:row',
    sender_name: 'uia-unverified:row', raw_text: '@[___] 正文', text: '正文',
  }));
  await runtime.waitForIdle();
  assert.deepEqual(accepted.map((event) => event.message_id), ['mention-1']);
  // The agent sees the request, never the placeholder.
  assert.equal(accepted[0].text, '正文');
  assert.equal(runtime.status.messagesRejected, 0);
});

test('mention mode rejects a body that does not carry the token', async (t) => {
  const groupProcess = new FakeGroupProcess();
  const { runtime, accepted, bridge } = makeRuntime(t, {
    groupProcess, config: MENTION_CONFIG,
  });
  await runtime.start({ bridge });
  const rejected = [
    // Prefix-shaped raw text is not a mention.
    groupEvent({ message_id: 'prefix-only', from_user_id: 'uia-unverified:row',
      sender_name: 'uia-unverified:row', raw_text: '/dsh 正文', text: '正文' }),
    // Hand-typed @name has no bracket shape and must not pass.
    groupEvent({ message_id: 'typed-at', from_user_id: 'uia-unverified:row',
      sender_name: 'uia-unverified:row', raw_text: '@成员甲 正文', text: '正文' }),
    // Mention present but the body kept the token: strip rule violated.
    groupEvent({ message_id: 'unstripped', from_user_id: 'uia-unverified:row',
      sender_name: 'uia-unverified:row', raw_text: '@[___] 正文', text: '@[___] 正文' }),
    // A mention of somebody else is not an address of the bot.
    groupEvent({ message_id: 'foreign', from_user_id: 'uia-unverified:row',
      sender_name: 'uia-unverified:row', raw_text: '@[小李] 正文', text: '正文' }),
  ];
  for (const event of rejected) groupProcess.emit('message', event);
  await runtime.waitForIdle();
  assert.deepEqual(accepted, []);
  assert.equal(runtime.status.messagesRejected, rejected.length);
});

test('command mode still refuses a mention-shaped event', async (t) => {
  // Backward compatibility gate: today's default config must keep ignoring @.
  const { runtime, groupProcess, accepted, bridge } = makeRuntime(t);
  await runtime.start({ bridge });
  groupProcess.emit('message', groupEvent({
    message_id: 'mention-in-command', raw_text: '@[___] 正文', text: '正文',
  }));
  await runtime.waitForIdle();
  assert.deepEqual(accepted, []);
  assert.equal(runtime.status.messagesRejected, 1);
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
  // The first bounded retry happens immediately; the failure it hits must still
  // schedule the next one, so give the ladder room instead of failing at 1s.
  await eventually(() => groupProcess.starts >= 3, 'bounded retries did not finish', 3_000);
  await eventually(() => runtime.status.restartAttempts === 2, 'retry status was not recorded', 3_000);
  assert.equal(runtime.status.ready, false);
  assert.equal(runtime.status.lastError, 'start-failed');
  groupProcess.emit('message', groupEvent({ message_id: 'offline-history' }));
  await runtime.waitForIdle();
  assert.equal(accepted.length, 0);
});

test('surface-loss exits retry on the slow ladder, other failures on the fast one', async (t) => {
  // A closed panel or a logged-out client is fixed on a human timescale, so
  // probing every 30s only floods the log - the flood this objective called a
  // defect. The fast ladder is for failures a restart could actually clear
  // (interpreter trouble, a transient COM glitch), where picking the window up
  // quickly is worth the noise.
  // Short delays make the walk observable; production defaults are
  // [2500,5000,10000,30000] fast and [30000,120000,600000] slow, and only the
  // shape of the behaviour matters here.
  //
  // The retries fail on purpose. A real bridge that lost its surface keeps
  // losing it: the child writes the same error frame and exits again, so
  // start() rejects rather than resolving. A fake whose start succeeds without
  // ever becoming ready would not model production at all, because the real
  // start() promise only resolves once the ready frame arrives - and ready is
  // what releases the in-progress flag and resets the ladder.
  const surface = new FakeGroupProcess();
  const { runtime, bridge } = makeRuntime(t, {
    groupProcess: surface,
    restartDelaysMs: [5, 5],
    surfaceLossRestartDelaysMs: [7, 20, 40],
  });
  await runtime.start({ bridge });
  await eventually(() => runtime.status.ready, 'initial ready never arrived');
  assert.equal(runtime.status.surfaceLoss, false);
  surface.failStarts = 5;
  surface.status = { running: false, ready: false, pid: null };
  surface.emit('exit', { code: 4, error: 'wechat_panel_closed' });
  // Read the ladder head synchronously: scheduling happens inside the exit
  // handler, whereas by the time the retry has run and failed again the delay
  // has already advanced to the next rung.
  assert.equal(runtime.status.restartDelayMs, 7, 'first surface retry uses ladder head');
  assert.equal(runtime.status.surfaceLoss, true);
  await eventually(() => surface.starts === 2, 'surface loss did not retry');
  // Each further failure walks the slow ladder; the delay held for the next
  // attempt is readable through status without waiting for it to fire. Waiting
  // on the delay itself, not on the start counter, matters: starts is bumped at
  // the top of start(), while the next delay is only recorded once that attempt
  // has failed, so asserting against starts alone races its own value.
  await eventually(
    () => runtime.status.restartDelayMs === 20,
    'second surface retry did not widen',
    3000,
  );
  await eventually(
    () => runtime.status.restartDelayMs === 40,
    'third surface retry did not widen',
    3000,
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  // Past the ladder the slowest delay is kept, never wrapped back to 7ms.
  assert.equal(runtime.status.restartDelayMs, 40, 'ladder wrapped instead of holding');
  assert.equal(runtime.status.surfaceLoss, true);

  // A failure that is not about the surface (an interpreter glitch, a transient
  // COM error) stays on the fast ladder, because retrying quickly can fix it.
  const transient = new FakeGroupProcess();
  const fast = makeRuntime(t, {
    groupProcess: transient,
    restartDelaysMs: [5, 5],
    surfaceLossRestartDelaysMs: [7, 700000],
  });
  await fast.runtime.start({ bridge: fast.bridge });
  await eventually(() => fast.runtime.status.ready, 'transient ready never arrived');
  transient.failStarts = 3;
  transient.status = { running: false, ready: false, pid: null };
  transient.emit('exit', { code: 1, error: 'poll_failed' });
  await eventually(() => transient.starts === 2, 'transient failure did not retry');
  assert.equal(fast.runtime.status.restartDelayMs, 5, 'must stay on the fast ladder');
  assert.equal(fast.runtime.status.surfaceLoss, false);
  await eventually(() => transient.starts === 3, 'second transient retry missing');
  assert.equal(fast.runtime.status.restartDelayMs, 5, 'transient ladder must not widen to slow');
});
test('both sides agree on which failures mean the surface is gone', () => {
  // Two languages hold the same rule: the adapter decides which failures mean the
  // WeChat surface is gone and exits on them, and this runtime picks the retry
  // pace from the same set. They are maintained apart, so a code added on one
  // side silently gets the wrong ladder on the other - fast retries for a
  // condition only a human can fix, which is the log flood this objective set
  // out to end. Parse both shipped lists instead of restating either, so the
  // comparison cannot itself go stale.
  const python = readFileSync(
    new URL('../../../scripts/wechat_group_uia.py', import.meta.url), 'utf8');
  const javascript = readFileSync(
    new URL('../../../src/channels/weixin/wechat-group-runtime.mjs', import.meta.url), 'utf8');
  const pyBlock = /SURFACE_LOST_CODES = frozenset\(\{([\s\S]*?)\}\)/.exec(python);
  const jsBlock = /SURFACE_LOSS_CODES = new Set\(\[([\s\S]*?)\]\)/.exec(javascript);
  assert.ok(pyBlock, 'adapter SURFACE_LOST_CODES not found to compare');
  assert.ok(jsBlock, 'runtime SURFACE_LOSS_CODES not found to compare');
  const pyCodes = new Set([...pyBlock[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
  const jsCodes = new Set([...jsBlock[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  assert.ok(pyCodes.size >= 5, 'suspiciously few adapter codes parsed: ' + pyCodes.size);
  assert.ok(jsCodes.size >= 3, 'suspiciously few runtime codes parsed: ' + jsCodes.size);
  // Codes that end a session or refuse to start, rather than losing a window.
  const notASurface = new Set([
    'backend_closed', 'unsupported_platform', 'dependency_missing', 'control_missing',
  ]);
  for (const code of jsCodes) {
    assert.equal(pyCodes.has(code), true, code + ' is in the runtime list but not the adapter');
  }
  for (const code of pyCodes) {
    if (notASurface.has(code)) continue;
    assert.equal(jsCodes.has(code), true, code + ' is missing from the runtime list');
  }
});
test('the default surface-loss ladder caps its wait at two minutes', async (t) => {
  // The ceiling is what an operator pays after they fix WeChat: the bridge only
  // notices on the next retry, so a ten-minute rung means ten silent minutes
  // where the group looks dead even though the panel is back. Two minutes is
  // still far quieter than the 750ms flood this replaced, and short enough to
  // feel live. Asserted through status rather than by waiting out the ladder,
  // because a test that slept three minutes would not be run.
  const { runtime } = makeRuntime(t);
  assert.ok(Array.isArray(runtime.status.surfaceLossLadderMs), 'ladder not exposed');
  assert.equal(runtime.status.surfaceLossLadderMs[0], 30_000);
  assert.equal(Math.max(...runtime.status.surfaceLossLadderMs), 120_000,
    'surface-loss retries must never wait longer than two minutes');
});
test('a visible panel with no accessibility tree also retries slowly', async (t) => {
  // Same reason as the closed panel: only restarting WeChat fixes it, and that
  // is human-scale work. The code is new, so the JS set must stay in step with
  // SURFACE_LOST_CODES in the adapter or this case silently returns to 2.5s.
  const groupProcess = new FakeGroupProcess();
  groupProcess.failStarts = 4;
  groupProcess.failCode = 'wechat_accessibility_unavailable';
  const { runtime } = makeRuntime(t, {
    groupProcess,
    restartDelaysMs: [5, 5],
    surfaceLossRestartDelaysMs: [7, 20, 40],
  });
  await assert.rejects(() => runtime.start({
    bridge: { accept: async () => {}, waitForIdle: async () => {}, close: async () => {} },
  }));
  assert.equal(runtime.status.surfaceLoss, true);
  assert.equal(runtime.status.restartDelayMs, 7);
});
test('a cold start that loses the surface retries on the slow ladder', async (t) => {
  // The first start is the common path on this machine: the Host boots while
  // WeChat’s panel is closed, start() rejects with the adapter’s code, and
  // there is no exit event for the classification to ride on because the child
  // never reached the poll loop. Keying only on #onExit left that case on the
  // fast ladder, which probes every 30s and is the noise this objective called
  // a defect; the same surface check must therefore run on the start failure.
  const groupProcess = new FakeGroupProcess();
  groupProcess.failStarts = 99;
  groupProcess.failCode = 'wechat_panel_closed';
  const { runtime } = makeRuntime(t, {
    groupProcess,
    restartDelaysMs: [5, 5],
    surfaceLossRestartDelaysMs: [7, 20, 40],
  });
  await assert.rejects(() => runtime.start({ bridge: { accept: async () => {}, waitForIdle: async () => {}, close: async () => {} } }));
  assert.equal(runtime.status.surfaceLoss, true, 'cold surface loss not classified');
  assert.equal(runtime.status.restartDelayMs, 7, 'cold loss must use the slow ladder head');
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
