import assert from 'node:assert/strict';
import test from 'node:test';
import { FeishuRuntime } from '../../../src/channels/feishu/feishu-runtime.mjs';
import { rememberConnectionTestTarget } from '../../../src/channels/shared/connection-test.mjs';

class FakeClient {
  static instances = [];
  static sent = [];

  constructor(options) {
    this.options = options;
    this.im = {
      v1: {
        message: {
          create: async (payload) => {
            FakeClient.sent.push(payload);
            return { code: 0, data: { message_id: `message-${FakeClient.sent.length}` } };
          },
        },
      },
    };
    FakeClient.instances.push(this);
  }
}

class FakeDispatcher {
  register(handlers) {
    this.handlers = handlers;
    return this;
  }
}

class FakeWSClient {
  static instances = [];

  constructor(options) {
    this.options = options;
    this.state = 'idle';
    FakeWSClient.instances.push(this);
  }

  async start({ eventDispatcher } = {}) {
    this.state = 'connecting';
    this.dispatcher = eventDispatcher;
  }

  becomeReady() {
    this.state = 'connected';
    this.options.onReady();
  }

  fail(error = new Error('synthetic WebSocket failure')) {
    this.state = 'failed';
    this.options.onError(error);
  }

  beginReconnecting() {
    this.state = 'reconnecting';
    this.options.onReconnecting();
  }

  becomeReconnected() {
    this.state = 'connected';
    this.options.onReconnected();
  }

  becomeIdle() {
    this.state = 'idle';
  }

  getConnectionStatus() {
    return { state: this.state };
  }

  close() {
    this.state = 'closed';
  }
}

function fakeLark() {
  FakeWSClient.instances.length = 0;
  FakeClient.instances.length = 0;
  FakeClient.sent.length = 0;
  return {
    Domain: { Feishu: 'feishu-domain', Lark: 'lark-domain' },
    LoggerLevel: { info: 'info' },
    Client: FakeClient,
    EventDispatcher: FakeDispatcher,
    WSClient: FakeWSClient,
    defaultHttpInstance: {
      request: async (options) => options,
      get: async (_url, options) => options,
      delete: async (_url, options) => options,
      head: async (_url, options) => options,
      options: async (_url, options) => options,
      post: async (_url, _data, options) => options,
      put: async (_url, _data, options) => options,
      patch: async (_url, _data, options) => options,
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('FeishuRuntime becomes chat-ready only after Harness and Feishu are connected', async () => {
  let harnessChecks = 0;
  let harnessSignal;
  const wsAgent = { addRequest() {} };
  const runtime = new FeishuRuntime({
    lark: fakeLark(),
    appId: 'cli_test',
    appSecret: 'secret',
    wsAgent,
    ownerOpenIds: ['*', 'ou_owner'],
    harness: {
      async ensureRunning(options) {
        harnessChecks += 1;
        harnessSignal = options.signal;
      },
    },
    state: { hasSeen: () => false },
    connectTimeoutMs: 1_234,
  });

  assert.equal(runtime.status.ready, false);
  let settled = false;
  const starting = runtime.start().then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(runtime.status.feishuLongConnectionState, 'connecting');
  assert.equal(FakeWSClient.instances[0].options.agent, wsAgent);
  assert.equal(FakeWSClient.instances[0].options.handshakeTimeoutMs, 1_234);
  assert.equal('agent' in FakeClient.instances[0].options, false);
  FakeWSClient.instances[0].becomeReady();
  const status = await starting;
  assert.equal(harnessChecks, 1);
  assert.equal(status.ready, true);
  assert.equal(status.feishuLongConnectionState, 'connected');
  assert.equal(status.harnessReachable, true);
  assert.equal(harnessSignal.aborted, false);
  assert.equal((await FakeClient.instances[0].options.httpInstance.request({
    url: 'https://open.feishu.cn/test',
  })).timeout, 15_000);

  const firstDispatcher = FakeWSClient.instances[0].dispatcher;
  FakeWSClient.instances[0].beginReconnecting();
  const reconnecting = await runtime.start();
  assert.equal(reconnecting.ready, false);
  assert.equal(reconnecting.feishuLongConnectionState, 'reconnecting');
  assert.equal(harnessChecks, 1);
  assert.equal(FakeWSClient.instances.length, 1);
  assert.equal(FakeClient.instances.length, 1);
  assert.equal(FakeWSClient.instances[0].dispatcher, firstDispatcher);
  FakeWSClient.instances[0].becomeReconnected();
  assert.equal(runtime.status.ready, true);
  assert.equal(runtime.status.feishuLongConnectionState, 'connected');

  assert.deepEqual(await runtime.sendConnectionTest('连接测试'), { sent: true });
  assert.deepEqual(FakeClient.sent, [{
    params: { receive_id_type: 'open_id' },
    data: {
      receive_id: 'ou_owner',
      msg_type: 'text',
      content: JSON.stringify({ text: '连接测试' }),
    },
  }]);

  assert.deepEqual(await runtime.sendProactiveText({
    kind: 'group',
    route: { chatId: 'oc_proactive_group' },
  }, '主动投递'), { sent: true });
  assert.deepEqual(FakeClient.sent[1], {
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: 'oc_proactive_group',
      msg_type: 'text',
      content: JSON.stringify({ text: '主动投递' }),
    },
  });

  const stopped = await runtime.stop();
  assert.equal(stopped.ready, false);
  assert.equal(stopped.feishuLongConnectionState, 'idle');
  assert.equal(FakeWSClient.instances[0].state, 'closed');
  assert.equal(harnessSignal.aborted, true);

  const stoppedStatus = runtime.status;
  FakeWSClient.instances[0].becomeReady();
  assert.deepEqual(runtime.status, stoppedStatus);
  FakeWSClient.instances[0].fail(new Error('late failure after stop'));
  assert.deepEqual(runtime.status, stoppedStatus);
  FakeWSClient.instances[0].beginReconnecting();
  assert.deepEqual(runtime.status, stoppedStatus);
  FakeWSClient.instances[0].becomeReconnected();
  assert.deepEqual(runtime.status, stoppedStatus);
});

test('FeishuRuntime uses the selected domain for both HTTP and WebSocket clients', async () => {
  for (const domain of [undefined, 'feishu', 'lark']) {
    const runtime = new FeishuRuntime({
      lark: fakeLark(),
      appId: 'cli_domain',
      appSecret: 'secret',
      domain,
      ownerOpenIds: ['ou_owner'],
      harness: { async ensureRunning() {} },
      state: { hasSeen: () => false },
    });
    try {
      const starting = runtime.start();
      await waitFor(() => FakeWSClient.instances.length === 1);
      FakeWSClient.instances[0].becomeReady();
      await starting;
      const expected = domain === 'lark' ? 'lark-domain' : 'feishu-domain';
      assert.equal(FakeClient.instances[0].options.domain, expected);
      assert.equal(FakeWSClient.instances[0].options.domain, expected);
    } finally {
      await runtime.stop();
    }
  }
});

test('FeishuRuntime keeps Slash registration non-blocking and aborts it on stop', async () => {
  const lark = fakeLark();
  const requests = [];
  let createSignal;
  lark.defaultHttpInstance.request = async (options) => {
    requests.push(options);
    if (options.url.includes('/tenant_access_token/')) {
      return { code: 0, tenant_access_token: 'tenant-token' };
    }
    if (options.method === 'GET') return { code: 0, data: { items: [] } };
    createSignal = options.signal;
    return new Promise((_resolve, reject) => {
      const abort = () => reject(createSignal.reason);
      createSignal.addEventListener('abort', abort, { once: true });
      if (createSignal.aborted) abort();
    });
  };
  const runtime = new FeishuRuntime({
    lark,
    appId: 'cli_slash',
    appSecret: 'secret',
    ownerOpenIds: ['ou_owner'],
    harness: { async ensureRunning() {} },
    state: { hasSeen: () => false },
    logger: { info() {}, warn() {}, error() {} },
  });

  const starting = runtime.start();
  await new Promise((resolve) => setImmediate(resolve));
  FakeWSClient.instances[0].becomeReady();
  const ready = await starting;
  assert.equal(ready.ready, true);
  await waitFor(() => createSignal !== undefined);
  assert.equal(runtime.status.slashCommandRegistration, 'registering');
  assert.equal(requests.filter((request) => request.url.includes('/tenant_access_token/')).length, 1);

  await runtime.stop();
  assert.equal(createSignal.aborted, true);
  assert.equal(runtime.status.slashCommandRegistration, 'idle');
});

test('FeishuRuntime can disable Slash registration', async () => {
  const lark = fakeLark();
  let requests = 0;
  lark.defaultHttpInstance.request = async () => {
    requests += 1;
    return { code: 0 };
  };
  const runtime = new FeishuRuntime({
    lark,
    appId: 'cli_no_slash',
    appSecret: 'secret',
    ownerOpenIds: ['ou_owner'],
    harness: { async ensureRunning() {} },
    state: { hasSeen: () => false },
    slashCommands: false,
  });

  const starting = runtime.start();
  await new Promise((resolve) => setImmediate(resolve));
  FakeWSClient.instances[0].becomeReady();
  await starting;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 0);
  assert.equal(runtime.status.slashCommandRegistration, 'idle');
  await runtime.stop();
});

test('FeishuRuntime uses a remembered private target for wildcard-only manual bots', async () => {
  const state = { hasSeen: () => false };
  const runtime = new FeishuRuntime({
    lark: fakeLark(),
    appId: 'cli_manual',
    appSecret: 'secret',
    ownerOpenIds: ['*'],
    harness: { async ensureRunning() {} },
    state,
  });

  const starting = runtime.start();
  await new Promise((resolve) => setImmediate(resolve));
  FakeWSClient.instances[0].becomeReady();
  await starting;

  await assert.rejects(
    runtime.sendConnectionTest('连接测试'),
    (error) => error?.code === 'test-target-unavailable',
  );
  rememberConnectionTestTarget(state, { chatId: 'oc_manual_private' });
  assert.deepEqual(await runtime.sendConnectionTest('连接测试'), { sent: true });
  assert.deepEqual(FakeClient.sent, [{
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: 'oc_manual_private',
      msg_type: 'text',
      content: JSON.stringify({ text: '连接测试' }),
    },
  }]);

  await runtime.stop();
});

test('FeishuRuntime stop waits for a pending Harness check and prevents startup resurrection', async () => {
  const harnessReady = deferred();
  let harnessSignal;
  const runtime = new FeishuRuntime({
    lark: fakeLark(),
    appId: 'cli_delayed_harness',
    appSecret: 'secret',
    ownerOpenId: 'ou_owner',
    harness: {
      async ensureRunning({ signal }) {
        harnessSignal = signal;
        await harnessReady.promise;
      },
    },
    state: { hasSeen: () => false },
  });

  const starting = runtime.start();
  const startRejected = assert.rejects(starting, (error) => error?.name === 'AbortError');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harnessSignal.aborted, false);

  let stopSettled = false;
  const stopping = runtime.stop().then((status) => {
    stopSettled = true;
    return status;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harnessSignal.aborted, true);
  assert.equal(stopSettled, false);
  assert.equal(FakeClient.instances.length, 0);
  assert.equal(FakeWSClient.instances.length, 0);

  harnessReady.resolve();
  await startRejected;
  const stopped = await stopping;
  assert.equal(stopped.ready, false);
  assert.equal(stopped.feishuLongConnectionState, 'idle');
  assert.equal(FakeClient.instances.length, 0);
  assert.equal(FakeWSClient.instances.length, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runtime.status, stopped);
});

test('FeishuRuntime fails closed when the initial WebSocket handshake times out', async () => {
  const runtime = new FeishuRuntime({
    lark: fakeLark(),
    appId: 'cli_test',
    appSecret: 'secret',
    ownerOpenId: 'ou_owner',
    harness: { async ensureRunning() {} },
    state: { hasSeen: () => false },
    connectTimeoutMs: 10,
  });

  await assert.rejects(runtime.start(), /handshake timed out/);
  assert.equal(runtime.status.ready, false);
  assert.equal(runtime.status.feishuLongConnectionState, 'failed');
  assert.equal(FakeWSClient.instances[0].state, 'closed');
  assert.equal(FakeWSClient.instances[0].options.handshakeTimeoutMs, 10);

  const failedStatus = runtime.status;
  FakeWSClient.instances[0].becomeReady();
  assert.deepEqual(runtime.status, failedStatus);
  FakeWSClient.instances[0].fail(new Error('late failure after timeout'));
  assert.deepEqual(runtime.status, failedStatus);
  FakeWSClient.instances[0].beginReconnecting();
  assert.deepEqual(runtime.status, failedStatus);
  FakeWSClient.instances[0].becomeReconnected();
  assert.deepEqual(runtime.status, failedStatus);
});

test('FeishuRuntime fails closed when Harness is unavailable', async () => {
  const runtime = new FeishuRuntime({
    lark: fakeLark(),
    appId: 'cli_test',
    appSecret: 'secret',
    ownerOpenId: 'ou_owner',
    harness: {
      async ensureRunning() { throw new Error('Harness unavailable'); },
    },
    state: { hasSeen: () => false },
  });

  await assert.rejects(runtime.start(), /Harness unavailable/);
  assert.equal(runtime.status.ready, false);
  assert.equal(runtime.status.feishuLongConnectionState, 'failed');
  assert.equal(runtime.status.lastError, 'Harness unavailable');
});

async function startRuntimeForProbe(options = {}) {
  const runtime = new FeishuRuntime({
    lark: fakeLark(),
    botId: 'bot_probe',
    appId: 'cli_probe',
    appSecret: 'secret',
    ownerOpenIds: ['ou_owner'],
    harness: { async ensureRunning() {} },
    state: { hasSeen: () => false },
    ...options,
  });
  const starting = runtime.start();
  await new Promise((resolve) => setImmediate(resolve));
  FakeWSClient.instances[0].becomeReady();
  await starting;
  return runtime;
}

test('FeishuRuntime drains failed and idle WS resources before creating a replacement', async () => {
  const runtime = await startRuntimeForProbe({
    logger: { info() {}, warn() {}, error() {} },
  });
  const firstWsClient = FakeWSClient.instances[0];
  firstWsClient.fail(new Error('terminal connection failure'));
  assert.equal(runtime.status.feishuLongConnectionState, 'failed');

  const restartingFromFailure = runtime.start();
  for (let attempt = 0; attempt < 20 && FakeWSClient.instances.length < 2; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(firstWsClient.state, 'closed');
  assert.equal(FakeWSClient.instances.length, 2);
  assert.equal(FakeClient.instances.length, 2);
  const secondWsClient = FakeWSClient.instances[1];
  secondWsClient.becomeReady();
  assert.equal((await restartingFromFailure).ready, true);

  // The SDK snapshot is authoritative even if a transition callback was
  // missed and Runtime status still says connected.
  secondWsClient.becomeIdle();
  assert.equal(runtime.status.ready, true);
  const restartingFromIdle = runtime.start();
  for (let attempt = 0; attempt < 20 && FakeWSClient.instances.length < 3; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(secondWsClient.state, 'closed');
  assert.equal(FakeWSClient.instances.length, 3);
  assert.equal(FakeClient.instances.length, 3);
  FakeWSClient.instances[2].becomeReady();
  assert.equal((await restartingFromIdle).ready, true);
  await runtime.stop();
});

function probeAction({ messageId = 'message-1', nonce, operatorOpenId = 'ou_owner' } = {}) {
  return {
    operator: { open_id: operatorOpenId },
    action: { value: { action: 'repair_verify', nonce } },
    context: { open_message_id: messageId },
  };
}

test('FeishuRuntime dispatcher ACKs immediately while card work is still pending', async () => {
  const seen = new Set();
  const runtime = await startRuntimeForProbe({
    logger: { info() {}, warn() {}, error() {} },
    harness: {
      async ensureRunning() {},
      async listWorkspaces() { return []; },
    },
    state: {
      hasSeen: (messageId) => seen.has(messageId),
      async markSeen(messageId) { seen.add(messageId); },
      sessionFor: () => null,
      includesArchivedSessions: () => false,
    },
  });
  const handlers = FakeWSClient.instances[0].dispatcher.handlers;

  assert.equal(handlers['im.message.reaction.created_v1']({}), undefined);
  assert.equal(handlers['im.message.reaction.deleted_v1']({}), undefined);
  assert.equal(handlers['im.message.receive_v1']({
    sender: {
      sender_type: 'user',
      sender_id: { open_id: 'ou_owner' },
    },
    message: {
      message_id: 'incoming-menu',
      chat_type: 'p2p',
      chat_id: 'oc_chat',
      message_type: 'text',
      content: JSON.stringify({ text: '/m' }),
    },
  }), undefined);

  for (let attempt = 0; attempt < 20 && FakeClient.sent.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(FakeClient.sent[0]?.data?.msg_type, 'interactive');
  await new Promise((resolve) => setImmediate(resolve));

  let patchCalls = 0;
  let resolvePatch;
  const pendingPatch = new Promise((resolve) => { resolvePatch = resolve; });
  FakeClient.instances[0].im.v1.message.patch = async () => {
    patchCalls += 1;
    return pendingPatch;
  };

  const result = handlers['card.action.trigger']({
    operator: { open_id: 'ou_owner' },
    action: { value: { action: 'help' } },
    context: {
      open_message_id: 'message-1',
      open_chat_id: 'oc_chat',
    },
  });

  assert.equal(result, undefined);
  assert.equal(runtime.status.cardActionsReceived, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(patchCalls, 1);

  resolvePatch({ code: 0, data: { message_id: 'message-1' } });
  await pendingPatch;
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.stop();
});

test('FeishuRuntime start waits for an idle-draining stop and preserves the new resources', async () => {
  const seen = new Set();
  const runtime = await startRuntimeForProbe({
    logger: { info() {}, warn() {}, error() {} },
    harness: {
      async ensureRunning() {},
      async listWorkspaces() { return []; },
    },
    state: {
      hasSeen: (messageId) => seen.has(messageId),
      async markSeen(messageId) { seen.add(messageId); },
      sessionFor: () => null,
      includesArchivedSessions: () => false,
    },
  });
  const firstWsClient = FakeWSClient.instances[0];
  const handlers = firstWsClient.dispatcher.handlers;
  handlers['im.message.receive_v1']({
    sender: {
      sender_type: 'user',
      sender_id: { open_id: 'ou_owner' },
    },
    message: {
      message_id: 'restart-menu',
      chat_type: 'p2p',
      chat_id: 'oc_chat',
      message_type: 'text',
      content: JSON.stringify({ text: '/m' }),
    },
  });
  for (let attempt = 0; attempt < 20 && FakeClient.sent.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(FakeClient.sent[0]?.data?.msg_type, 'interactive');
  await new Promise((resolve) => setImmediate(resolve));

  const patchEntered = deferred();
  const patchReleased = deferred();
  FakeClient.instances[0].im.v1.message.patch = async () => {
    patchEntered.resolve();
    return patchReleased.promise;
  };
  handlers['card.action.trigger']({
    operator: { open_id: 'ou_owner' },
    action: { value: { action: 'help' } },
    context: {
      open_message_id: 'message-1',
      open_chat_id: 'oc_chat',
    },
  });
  await patchEntered.promise;

  let stopSettled = false;
  const stopping = runtime.stop().then((status) => {
    stopSettled = true;
    return status;
  });
  let restartSettled = false;
  const restarting = runtime.start().then((status) => {
    restartSettled = true;
    return status;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopSettled, false);
  assert.equal(restartSettled, false);
  assert.equal(FakeWSClient.instances.length, 1);
  assert.equal(FakeClient.instances.length, 1);
  assert.equal(firstWsClient.state, 'closed');

  patchReleased.resolve({ code: 0, data: { message_id: 'message-1' } });
  const stopped = await stopping;
  assert.equal(stopped.ready, false);
  assert.equal(stopped.feishuLongConnectionState, 'idle');
  for (let attempt = 0; attempt < 20 && FakeWSClient.instances.length < 2; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(FakeWSClient.instances.length, 2);
  assert.equal(FakeClient.instances.length, 2);

  const secondWsClient = FakeWSClient.instances[1];
  secondWsClient.becomeReady();
  const restarted = await restarting;
  assert.equal(restarted.ready, true);
  assert.equal(restarted.feishuLongConnectionState, 'connected');
  assert.equal(secondWsClient.state, 'connected');

  const sentBeforeLateDispatch = FakeClient.sent.length;
  const cardActionsBeforeLateDispatch = runtime.status.cardActionsReceived;
  handlers['im.message.receive_v1']({
    sender: {
      sender_type: 'user',
      sender_id: { open_id: 'ou_owner' },
    },
    message: {
      message_id: 'late-old-dispatcher-message',
      chat_type: 'p2p',
      chat_id: 'oc_chat',
      message_type: 'text',
      content: JSON.stringify({ text: '/m' }),
    },
  });
  handlers['card.action.trigger']({
    operator: { open_id: 'ou_owner' },
    action: { value: { action: 'help' } },
    context: {
      open_message_id: 'message-1',
      open_chat_id: 'oc_chat',
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.has('late-old-dispatcher-message'), false);
  assert.equal(runtime.status.cardActionsReceived, cardActionsBeforeLateDispatch);
  assert.equal(FakeClient.sent.length, sentBeforeLateDispatch);

  assert.deepEqual(await runtime.sendConnectionTest('重启后连接测试'), { sent: true });
  await runtime.stop();
});

test('FeishuRuntime resolves a card-action probe only for the exact message, nonce and operator', async () => {
  const runtime = await startRuntimeForProbe();
  let settled = false;
  const probe = runtime.beginCardActionProbe({
    expectedOperatorOpenId: 'ou_owner',
    timeoutMs: 1_000,
  }).then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));

  const request = FakeClient.sent[0];
  assert.deepEqual(request.params, { receive_id_type: 'open_id' });
  assert.equal(request.data.receive_id, 'ou_owner');
  assert.equal(request.data.msg_type, 'interactive');
  const card = JSON.parse(request.data.content);
  const behavior = card.body.elements[1].columns[0].elements[0].behaviors[0];
  assert.equal(behavior.value.action, 'repair_verify');
  const nonce = behavior.value.nonce;
  assert.match(nonce, /^[A-Za-z0-9_-]{16,128}$/);

  const dispatch = FakeWSClient.instances[0].dispatcher.handlers['card.action.trigger'];
  dispatch(probeAction({ messageId: 'message-other', nonce }));
  dispatch(probeAction({ nonce: `${nonce}x` }));
  dispatch(probeAction({ nonce, operatorOpenId: 'ou_other' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  dispatch(probeAction({ nonce }));
  assert.deepEqual(await probe, {
    verified: true,
    messageId: 'message-1',
    operatorOpenId: 'ou_owner',
  });
  assert.equal(runtime.status.cardActionsReceived, 4);
  assert.equal(runtime.status.cardActionProbesVerified, 1);
  assert.equal(FakeClient.sent.length, 2);
  assert.deepEqual(FakeClient.sent[1], {
    params: { receive_id_type: 'open_id' },
    data: {
      receive_id: 'ou_owner',
      msg_type: 'text',
      content: JSON.stringify({
        text: '✅ 修复完成：已实测收到 card.action.trigger，菜单按钮现在可用。',
      }),
    },
  });
  await runtime.stop();
});

test('FeishuRuntime times out and aborts pending card-action probes with stable codes', async () => {
  const runtime = await startRuntimeForProbe();
  await assert.rejects(
    runtime.beginCardActionProbe({ expectedOperatorOpenId: 'ou_owner', timeoutMs: 10 }),
    (error) => error?.code === 'card_action_probe_timeout',
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(
    JSON.parse(FakeClient.sent.at(-1).data.content).text,
    /修复验证超时.*不能确认按钮已修复.*不要重复授权/,
  );

  const pending = runtime.beginCardActionProbe({
    expectedOperatorOpenId: 'ou_owner',
    timeoutMs: 1_000,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.stop();
  await assert.rejects(pending, (error) => error?.code === 'abort');
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(
    JSON.parse(FakeClient.sent.at(-1).data.content).text,
    /修复验证中断.*不能确认修复成功.*不要重复授权/,
  );
});

test('FeishuRuntime reports probe-card send failure without masking its stable error', async () => {
  const runtime = await startRuntimeForProbe();
  const client = FakeClient.instances[0];
  client.im.v1.message.create = async (payload) => {
    FakeClient.sent.push(payload);
    if (payload.data.msg_type === 'interactive') return { code: 230001 };
    return { code: 0, data: { message_id: 'failure-notice' } };
  };

  await assert.rejects(
    runtime.beginCardActionProbe({ expectedOperatorOpenId: 'ou_owner', timeoutMs: 1_000 }),
    (error) => error?.code === 'card_action_probe_send_failed',
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(FakeClient.sent.length, 2);
  assert.match(
    JSON.parse(FakeClient.sent[1].data.content).text,
    /修复验证失败.*不能确认 card\.action\.trigger 已恢复.*不要重复授权/,
  );
  await runtime.stop();
});

test('FeishuRuntime rejects imprecise probe operators and probes before connection', async () => {
  const runtime = new FeishuRuntime({
    lark: fakeLark(),
    botId: 'bot_probe',
    appId: 'cli_probe',
    appSecret: 'secret',
    ownerOpenIds: ['*'],
    harness: { async ensureRunning() {} },
    state: { hasSeen: () => false },
  });
  await assert.rejects(
    runtime.beginCardActionProbe({ expectedOperatorOpenId: 'ou_owner' }),
    (error) => error?.code === 'card_action_probe_unavailable',
  );

  const starting = runtime.start();
  await new Promise((resolve) => setImmediate(resolve));
  FakeWSClient.instances[0].becomeReady();
  await starting;
  await assert.rejects(
    runtime.beginCardActionProbe({ expectedOperatorOpenId: '*' }),
    /precise Feishu operator/,
  );
  await runtime.stop();
});
