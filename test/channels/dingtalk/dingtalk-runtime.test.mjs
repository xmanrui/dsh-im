import assert from 'node:assert/strict';
import test from 'node:test';

import { DingtalkRuntime } from '../../../src/channels/dingtalk/dingtalk-runtime.mjs';
import { rememberConnectionTestTarget } from '../../../src/channels/shared/connection-test.mjs';

async function eventually(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition did not become true');
}

function stateFixture() {
  const sessions = new Map();
  const seen = new Set();
  const pending = new Map();
  return {
    hasSeen: (id) => seen.has(id),
    markSeen: async (id) => seen.add(id),
    sessionFor: (key) => sessions.get(key) ?? null,
    setSession: async (key, value) => sessions.set(key, value),
    clearSession: async (key) => sessions.delete(key),
    pendingSenders: () => [...pending.values()],
    pendingSender: (requestId) => pending.get(requestId) ?? null,
    recordPendingSender: async ({ staffId, displayName, lastSeenAt }) => {
      const entry = {
        requestId: `request-${staffId}`,
        staffId,
        displayName,
        requestedAt: lastSeenAt,
        lastSeenAt,
      };
      pending.set(entry.requestId, entry);
      return entry;
    },
    removePendingSenderByStaffId: async (staffId) => {
      const entry = [...pending.values()].find((value) => value.staffId === staffId);
      if (!entry) return false;
      pending.delete(entry.requestId);
      return true;
    },
  };
}

test('runtime sends a DingTalk connection test only through the remembered private webhook', async () => {
  const state = stateFixture();
  const sends = [];
  const proactiveSends = [];
  let proactiveFailure = null;
  const client = {
    connected: true,
    socket: { readyState: 1 },
    registerCallbackListener() {},
    async connect() {},
    socketCallBackResponse() {},
    disconnect() {},
  };
  const runtime = new DingtalkRuntime({
    config: { clientId: 'ding-client', approvedSenders: [] },
    clientSecret: 'host-secret',
    harness: { ensureRunning: async () => true },
    state,
    api: {
      sendText: async (request) => sends.push(request),
      sendRobotText: async (request) => {
        proactiveSends.push(request);
        if (proactiveFailure) throw proactiveFailure;
      },
    },
    streamFactory: async () => ({ client, topic: 'robot-topic' }),
  });

  await runtime.start();
  await assert.rejects(() => runtime.sendConnectionTest('连接测试'), {
    code: 'test-target-unavailable',
  });
  rememberConnectionTestTarget(state, {
    sessionWebhook: 'https://oapi.dingtalk.com/robot/reply?ticket=inbound-private',
  });
  assert.deepEqual(await runtime.sendConnectionTest('连接测试'), { sent: true });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].clientId, 'ding-client');
  assert.equal(sends[0].clientSecret, 'host-secret');
  assert.equal(sends[0].sessionWebhook, 'https://oapi.dingtalk.com/robot/reply?ticket=inbound-private');
  assert.equal(sends[0].text, '连接测试');
  assert.deepEqual(await runtime.sendProactiveText({
    kind: 'group',
    route: { openConversationId: 'cid-proactive' },
  }, '主动投递'), { sent: true });
  assert.equal(proactiveSends.length, 1);
  assert.deepEqual(proactiveSends[0].target, {
    type: 'group',
    robotCode: 'ding-client',
    openConversationId: 'cid-proactive',
  });
  assert.equal(proactiveSends[0].text, '主动投递');
  assert.equal('sessionWebhook' in proactiveSends[0], false);
  proactiveFailure = Object.assign(new Error('provider detail'), { code: 'send-rejected' });
  await assert.rejects(() => runtime.sendProactiveText({
    kind: 'user',
    route: { userId: 'staff-one' },
  }, '失败投递'), { code: 'target-rejected' });
  await runtime.stop();
});

test('runtime owns one DWClient, waits for socket OPEN, acknowledges first, and disconnects on stop', async () => {
  const order = [];
  const state = stateFixture();
  await state.recordPendingSender({
    staffId: 'staff-approved',
    displayName: '已批准用户',
    lastSeenAt: '2026-08-15T01:00:00.000Z',
  });
  let callback;
  const client = {
    connected: false,
    socket: { readyState: 0 },
    registerCallbackListener(topic, listener) {
      order.push(['register', topic]);
      callback = listener;
    },
    async connect() {
      order.push(['connect']);
      setTimeout(() => {
        this.connected = true;
        this.socket.readyState = 1;
      }, 10);
    },
    socketCallBackResponse(messageId, body) {
      order.push(['ack', messageId, body]);
    },
    disconnect() {
      order.push(['disconnect']);
      this.connected = false;
      this.socket.readyState = 3;
    },
  };
  const runtime = new DingtalkRuntime({
    config: {
      clientId: 'ding-client',
      approvedSenders: [{ staffId: 'staff-approved' }],
    },
    clientSecret: 'host-secret',
    harness: {
      ensureRunning: async () => order.push(['harness-ready']),
      sessionExists: async () => true,
      createSession: async () => 'session-one',
      ask: async () => {
        order.push(['ask']);
        return 'Harness 回答';
      },
    },
    state,
    api: {
      sendText: async ({ text }) => order.push(['send', text]),
    },
    streamFactory: async ({ clientId, clientSecret }) => {
      assert.equal(clientId, 'ding-client');
      assert.equal(clientSecret, 'host-secret');
      return { client, topic: 'robot-topic' };
    },
    connectPollIntervalMs: 2,
  });

  const started = await runtime.start();
  assert.equal(started.ready, true);
  assert.equal(started.dingtalkStreamState, 'connected');
  assert.deepEqual(started.pendingSenders, []);
  assert.deepEqual(order.slice(0, 4), [
    ['harness-ready'],
    ['register', '/v1.0/card/instances/callback'],
    ['register', 'robot-topic'],
    ['connect'],
  ]);

  callback({
    headers: { messageId: 'callback-one' },
    data: JSON.stringify({
      msgId: 'business-one',
      msgtype: 'text',
      text: { content: '问题' },
      conversationType: '1',
      senderStaffId: 'staff-approved',
      senderNick: '用户',
      sessionWebhook: 'https://oapi.dingtalk.com/robot/reply?ticket=one',
    }),
  });
  assert.deepEqual(order.at(-1), ['ack', 'callback-one', { success: true }]);
  await eventually(() => runtime.status.messagesReplied === 1);
  assert.ok(order.findIndex(([action]) => action === 'ack') < order.findIndex(([action]) => action === 'ask'));
  assert.ok(order.findIndex(([action]) => action === 'ack') < order.findIndex(([action]) => action === 'send'));

  await runtime.stop();
  assert.deepEqual(order.at(-1), ['disconnect']);
  assert.equal(runtime.status.ready, false);
  assert.equal(runtime.status.dingtalkStreamState, 'idle');
});

test('runtime acknowledges a card callback before applying it and ignores callbacks after stop', async () => {
  const state = stateFixture();
  await state.setSession('p2p:staff-approved', 'session-before');
  const listeners = new Map();
  const acknowledgements = [];
  const cards = [];
  const updates = [];
  const client = {
    connected: true, socket: { readyState: 1 },
    registerCallbackListener: (topic, listener) => listeners.set(topic, listener),
    async connect() {}, disconnect() {},
    socketCallBackResponse: (id) => acknowledgements.push(id),
  };
  const runtime = new DingtalkRuntime({
    config: { clientId: 'ding-client', approvedSenders: [{ staffId: 'staff-approved' }] },
    clientSecret: 'secret', state,
    harness: { ensureRunning: async () => true, currentWorkspace: () => process.cwd() },
    api: {
      sendText: async () => assert.fail('card actions should update the same card'),
      createMenuCard: async (request) => { cards.push(request); return { cardInstanceId: 'menu-card' }; },
      updateMenuCard: async (request) => updates.push(request),
    },
    streamFactory: async () => ({ client, topic: 'robot-topic' }),
  });
  await runtime.start();
  listeners.get('robot-topic')({ headers: { messageId: 'open-envelope' }, data: JSON.stringify({
    msgId: 'open-menu', msgtype: 'text', text: { content: '/m' },
    conversationType: '1', senderStaffId: 'staff-approved',
    sessionWebhook: 'https://oapi.dingtalk.com/robot/reply?ticket=menu',
  }) });
  await eventually(() => cards.length === 1);
  const callback = { headers: { messageId: 'card-envelope' }, data: JSON.stringify({
    outTrackId: 'menu-card', userId: 'staff-approved',
    content: JSON.stringify({ cardPrivateData: { actionIds: ['new'], params: {
      revision: cards[0].data.revision,
    } } }),
  }) };
  const onCard = listeners.get('/v1.0/card/instances/callback');
  onCard(callback);
  assert.equal(acknowledgements.at(-1), 'card-envelope');
  assert.equal(state.sessionFor('p2p:staff-approved'), 'session-before');
  await eventually(() => updates.length === 1);
  assert.equal(state.sessionFor('p2p:staff-approved'), null);
  assert.equal(updates[0].cardInstanceId, 'menu-card');
  await runtime.stop();
  onCard({ ...callback, headers: { messageId: 'after-stop' } });
  assert.equal(acknowledgements.includes('after-stop'), false);
  assert.equal(updates.length, 1);
});

test('runtime sends visible-scope messages to Harness without local sender approval', async () => {
  const state = stateFixture();
  const asked = [];
  const sent = [];
  let callback;
  const client = {
    connected: true,
    socket: { readyState: 1 },
    registerCallbackListener(_topic, listener) { callback = listener; },
    async connect() {},
    socketCallBackResponse() {},
    disconnect() {},
  };
  const runtime = new DingtalkRuntime({
    config: { clientId: 'ding-client', approvedSenders: [] },
    clientSecret: 'host-secret',
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => false,
      createSession: async () => 'session-visible-sender',
      ask: async (sessionId, text) => {
        asked.push({ sessionId, text });
        return '直接回答';
      },
    },
    state,
    api: { sendText: async ({ text }) => sent.push(text) },
    streamFactory: async () => ({ client, topic: 'robot-topic' }),
  });
  await runtime.start();
  callback({
    headers: { messageId: 'callback-pending' },
    data: JSON.stringify({
      msgId: 'business-pending',
      msgtype: 'text',
      text: { content: '请求使用' },
      conversationType: '1',
      senderStaffId: 'raw-staff-id',
      senderNick: '可见范围用户',
      sessionWebhook: 'https://oapi.dingtalk.com/robot/reply?ticket=pending',
    }),
  });

  await eventually(() => runtime.status.messagesReplied === 1);
  assert.deepEqual(asked, [{
    sessionId: 'session-visible-sender',
    text: '请求使用',
  }]);
  assert.deepEqual(sent, ['直接回答']);
  assert.deepEqual(runtime.pendingSenders(), []);
  await runtime.stop();
});

for (const scenario of [
  { name: 'private enabled to disabled', conversationType: '1', before: [true, false], after: [false, true] },
  { name: 'group enabled to disabled', conversationType: '2', before: [false, true], after: [true, false] },
  { name: 'private disabled to enabled', conversationType: '1', before: [false, true], after: [true, false] },
]) {
  test(`DingTalk received callback retains settings before its parse microtask: ${scenario.name}`, async () => {
    const order = [];
    const asked = [];
    const configFor = ([directEnabled, groupEnabled], guidance) => ({
      group: { enabled: groupEnabled, fields: ['channel', 'botId'], guidance },
      direct: { enabled: directEnabled, fields: ['channel', 'botId'], guidance },
    });
    let config = configFor(scenario.before, 'before callback returned');
    let callback;
    const client = {
      connected: true,
      socket: { readyState: 1 },
      registerCallbackListener(_topic, listener) { callback = listener; },
      async connect() {},
      socketCallBackResponse(messageId) { order.push(['ack', messageId]); },
      disconnect() {},
    };
    const runtime = new DingtalkRuntime({
      config: { clientId: 'ding-client', approvedSenders: [] },
      clientSecret: 'host-secret',
      contextEnhancement: {
        botId: 'dingtalk_internal',
        getSettings: () => { order.push(['settings']); return config; },
      },
      harness: {
        ensureRunning: async () => true,
        createSession: async () => 'session-existing',
        sessionExists: async () => true,
        ask: async (_sessionId, text) => { asked.push(text); order.push(['ask']); return 'done'; },
      },
      state: stateFixture(),
      api: { sendText: async () => {} },
      streamFactory: async () => ({ client, topic: 'robot-topic' }),
      logger: { warn() {}, error() {} },
    });
    const response = (id) => ({
      headers: { messageId: `callback-${id}` },
      get data() {
        order.push(['read-data', id]);
        return JSON.stringify({
          msgId: `message-${id}`, msgtype: 'text', text: { content: `message ${id}` },
          conversationType: scenario.conversationType, conversationId: 'group-chat',
          isInAtList: true, senderStaffId: 'staff-id', senderNick: 'Ada',
          sessionWebhook: 'https://oapi.dingtalk.com/robot/reply?ticket=test',
        });
      },
    });
    try {
      await runtime.start();
      callback(response(1));
      assert.deepEqual(order, [['ack', 'callback-1'], ['settings']], 'ACK stays first and JSON remains unparsed until the original microtask');
      config = configFor(scenario.after, 'after callback returned');
      await eventually(() => runtime.status.messagesReplied === 1, 5_000);
      callback(response(2));
      await eventually(() => runtime.status.messagesReplied === 2, 5_000);
      for (const [index, switches] of [scenario.before, scenario.after].entries()) {
        const enabled = switches[scenario.conversationType === '1' ? 0 : 1];
        if (enabled) {
          assert.match(asked[index], index === 0 ? /before callback returned/ : /after callback returned/);
          assert.deepEqual(JSON.parse(/^<dsh_im_source>(.*?)<\/dsh_im_source>/su.exec(asked[index])[1]), {
            channel: 'dingtalk', botId: 'dingtalk_internal',
          });
        } else {
          assert.equal(asked[index], `message ${index + 1}`);
        }
      }
      assert.equal(order.filter(([action]) => action === 'settings').length, 2, 'one source configuration read per callback');
      assert.equal(order.filter(([action]) => action === 'read-data').length, 4, 'preserves the original data parsing path');
    } finally {
      await runtime.stop();
    }
  });
}

test('runtime accepts an OPEN DingTalk socket when the SDK registered flag remains false', async () => {
  const client = {
    connected: true,
    registered: false,
    socket: { readyState: 1 },
    registerCallbackListener() {},
    async connect() {},
    socketCallBackResponse() {},
    disconnect() {},
  };
  const runtime = new DingtalkRuntime({
    config: { clientId: 'ding-client', approvedSenders: [] },
    clientSecret: 'host-secret',
    harness: { ensureRunning: async () => true },
    state: stateFixture(),
    api: { sendText: async () => true },
    streamFactory: async () => ({ client, topic: 'robot-topic' }),
  });

  assert.equal((await runtime.start()).ready, true);
  assert.equal(client.registered, false);
  await runtime.stop();
});

test('runtime never reports ready when connect resolves before the socket opens permanently', async () => {
  let disconnects = 0;
  const client = {
    connected: false,
    socket: { readyState: 0 },
    registerCallbackListener() {},
    async connect() {},
    socketCallBackResponse() {},
    disconnect() { disconnects += 1; },
  };
  const runtime = new DingtalkRuntime({
    config: { clientId: 'ding-client', approvedSenders: [] },
    clientSecret: 'host-secret',
    harness: { ensureRunning: async () => true },
    state: stateFixture(),
    api: { sendText: async () => true },
    streamFactory: async () => ({ client, topic: 'robot-topic' }),
    connectTimeoutMs: 15,
    connectPollIntervalMs: 2,
    logger: { warn() {}, error() {} },
  });

  await assert.rejects(
    runtime.start(),
    (error) => error.code === 'dingtalk-stream-connect-failed'
      && /handshake timed out/.test(error.message)
      && error.cause?.message === error.message,
  );
  assert.equal(disconnects, 1);
  assert.equal(runtime.status.ready, false);
  assert.equal(runtime.status.dingtalkStreamState, 'failed');
  assert.match(runtime.status.lastError, /handshake timed out/);
});

test('runtime bounds a stalled SDK gateway lookup and disconnects a late connection', async () => {
  let finishConnect;
  let disconnects = 0;
  const client = {
    connected: false,
    socket: { readyState: 0 },
    registerCallbackListener() {},
    connect: async () => new Promise((resolve) => { finishConnect = resolve; }),
    socketCallBackResponse() {},
    disconnect() { disconnects += 1; },
  };
  const runtime = new DingtalkRuntime({
    config: { clientId: 'ding-client', approvedSenders: [] },
    clientSecret: 'host-secret',
    harness: { ensureRunning: async () => true },
    state: stateFixture(),
    api: { sendText: async () => true },
    streamFactory: async () => ({ client, topic: 'robot-topic' }),
    connectTimeoutMs: 10,
    connectPollIntervalMs: 2,
    logger: { warn() {}, error() {} },
  });

  await assert.rejects(runtime.start(), /handshake timed out after 10ms/);
  assert.equal(disconnects, 1);
  finishConnect();
  await eventually(() => disconnects === 2);
  assert.equal(runtime.status.ready, false);
  assert.equal(runtime.status.dingtalkStreamState, 'failed');
});

test('a callback from a stopped stream is not acknowledged or processed', async () => {
  const events = [];
  let callback;
  const client = {
    connected: true,
    socket: { readyState: 1 },
    registerCallbackListener(_topic, listener) { callback = listener; },
    async connect() {},
    socketCallBackResponse() { events.push('ack'); },
    disconnect() { this.connected = false; this.socket.readyState = 3; },
  };
  const runtime = new DingtalkRuntime({
    config: { clientId: 'ding-client', approvedSenders: [{ staffId: 'approved' }] },
    clientSecret: 'host-secret',
    harness: { ensureRunning: async () => true, ask: async () => events.push('ask') },
    state: stateFixture(),
    api: { sendText: async () => events.push('send') },
    streamFactory: async () => ({ client, topic: 'robot-topic' }),
  });
  await runtime.start();
  await runtime.stop();

  callback({
    headers: { messageId: 'late-callback' },
    data: JSON.stringify({
      msgId: 'late-message',
      msgtype: 'text',
      text: { content: '不应处理' },
      conversationType: '1',
      senderStaffId: 'approved',
      sessionWebhook: 'https://oapi.dingtalk.com/robot/reply?ticket=late',
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, []);
});

test('stop aborts in-flight Harness work without waiting for the reply timeout', async () => {
  let callback;
  let askStarted;
  const askStartedPromise = new Promise((resolve) => { askStarted = resolve; });
  const client = {
    connected: true,
    socket: { readyState: 1 },
    registerCallbackListener(_topic, listener) { callback = listener; },
    async connect() {},
    socketCallBackResponse() {},
    disconnect() { this.connected = false; this.socket.readyState = 3; },
  };
  const runtime = new DingtalkRuntime({
    config: { clientId: 'ding-client', approvedSenders: [{ staffId: 'approved' }] },
    clientSecret: 'host-secret',
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      createSession: async () => 'session-one',
      ask: async (_sessionId, _text, { signal }) => {
        askStarted();
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    },
    state: stateFixture(),
    api: { sendText: async () => true },
    streamFactory: async () => ({ client, topic: 'robot-topic' }),
    logger: { warn() {}, error() {} },
  });
  await runtime.start();
  callback({
    headers: { messageId: 'callback-hanging' },
    data: JSON.stringify({
      msgId: 'business-hanging',
      msgtype: 'text',
      text: { content: '长时间问题' },
      conversationType: '1',
      senderStaffId: 'approved',
      sessionWebhook: 'https://oapi.dingtalk.com/robot/reply?ticket=hanging',
    }),
  });
  await askStartedPromise;

  await Promise.race([
    runtime.stop(),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('runtime stop did not abort Harness work')),
      100,
    )),
  ]);

  assert.equal(runtime.status.ready, false);
  assert.equal(runtime.status.dingtalkStreamState, 'idle');
});
