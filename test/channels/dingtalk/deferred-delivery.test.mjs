import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDeferredDeliverer,
  deferredTerminalText,
} from '../../../src/channels/dingtalk/deferred-delivery.mjs';

async function eventually(predicate, message = 'condition was not met') {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function historyFixture({
  turn = 1,
  promptRpcId = 'dingtalk-defer-1',
  answer = '后台完成的结果',
  reason = { kind: 'completed' },
  ended = true,
} = {}) {
  const events = [
    { seq: 1, type: 'turn/start', data: { turn } },
    { seq: 2, type: 'user/message', data: { turn, source: { rpcId: promptRpcId } } },
    {
      seq: 3,
      type: 'assistant/chunk',
      data: { turn, step: 0, chunk: { type: 'text-delta', index: 0, text: answer } },
    },
  ];
  if (ended) events.push({ seq: 4, type: 'turn/end', data: { turn, reason } });
  return { events };
}

function deferredFixture(overrides = {}) {
  return {
    deferred: true,
    sessionId: 'session-defer',
    turn: 1,
    promptRpcId: 'dingtalk-defer-1',
    afterSeq: -1,
    released: 0,
    releaseOwnership() { this.released += 1; },
    ...overrides,
  };
}

function delivererFixture({
  history = historyFixture(),
  sendText,
} = {}) {
  const listeners = [];
  const sent = [];
  const proactive = [];
  const remembered = [];
  const harness = {
    rpc: async (method) => (method === 'session.history' ? history : null),
    watchHarnessEvents: ({ signal, onSessionEvent, onReconnect }) => {
      listeners.push({ signal, onSessionEvent, onReconnect });
      return new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', resolve, { once: true });
      });
    },
  };
  const api = {
    sendRobotText: async ({ target, text }) => {
      proactive.push({ target, text });
      return {};
    },
  };
  const deliverer = createDeferredDeliverer({
    api,
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness,
    state: { rememberOutboundMessage: async (entry) => remembered.push(entry) },
    logger: { warn: () => {} },
    sendText: sendText ?? (async (_webhook, text, _at) => {
      sent.push(text);
      return ['webhook-msg-1'];
    }),
  });
  return {
    deliverer, listeners, sent, proactive, remembered,
    setHistory: (next) => { history = next; },
  };
}

const P2P_ROUTE = {
  sessionWebhook: 'https://oapi.dingtalk.com/robot/reply?ticket=defer-1',
  sessionWebhookExpiredTime: 0,
  fallbackTarget: { type: 'user', userId: 'staff-approved', robotCode: 'ding-client' },
  at: undefined,
};

test('deferredTerminalText keeps error semantics for every terminal reason', () => {
  assert.equal(deferredTerminalText({ kind: 'completed' }, '答案'), '答案');
  assert.equal(deferredTerminalText(null, '答案'), '答案');
  assert.match(deferredTerminalText({ kind: 'completed' }, '   '), /没有可发送的文本结果/);
  assert.match(
    deferredTerminalText({ kind: 'error', error: { message: 'RATE_LIMIT' } }, ''),
    /任务失败：RATE_LIMIT/,
  );
  assert.match(deferredTerminalText('max-tokens', ''), /长度上限/);
  assert.match(deferredTerminalText('blocked', ''), /安全策略/);
  assert.equal(deferredTerminalText('stopped', ''), '任务已停止。');
  assert.equal(deferredTerminalText('cancelled', ''), '任务已停止。');
  assert.equal(deferredTerminalText('aborted', ''), '任务已中止。');
  assert.equal(deferredTerminalText('something-else', ''), '任务已结束。');
});

test('a deferred turn already finished at registration delivers immediately', async () => {
  const fx = delivererFixture();
  const deferred = deferredFixture();
  await fx.deliverer.register({ key: 'p2p:staff-approved', deferred, route: P2P_ROUTE });
  assert.deepEqual(fx.sent, ['后台完成的结果']);
  assert.equal(deferred.released, 1);
  assert.equal(fx.remembered.length, 1);
  assert.equal(fx.remembered[0].conversationKey, 'p2p:staff-approved');
  // 已交付条目不重复投递。
  fx.listeners[0].onSessionEvent({
    sessionId: 'session-defer',
    event: { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fx.sent.length, 1);
});

test('a deferred turn delivers through the watcher when it ends later', async () => {
  const fx = delivererFixture({ history: historyFixture({ ended: false }) });
  const deferred = deferredFixture();
  await fx.deliverer.register({ key: 'p2p:staff-approved', deferred, route: P2P_ROUTE });
  assert.equal(fx.sent.length, 0);
  fx.setHistory(historyFixture({ reason: 'stopped' }));
  fx.listeners[0].onSessionEvent({
    sessionId: 'session-defer',
    event: { type: 'turn/end', seq: 4, data: { turn: 1, reason: 'stopped' } },
  });
  await eventually(() => fx.sent.length === 1);
  assert.equal(fx.sent[0], '任务已停止。');
  assert.equal(deferred.released, 1);
});

test('an expired webhook window routes the result through the proactive API', async () => {
  const fx = delivererFixture();
  await fx.deliverer.register({
    key: 'group:conversation-1',
    deferred: deferredFixture(),
    route: {
      ...P2P_ROUTE,
      sessionWebhookExpiredTime: Date.now() - 1_000,
      fallbackTarget: {
        type: 'group',
        openConversationId: 'conversation-1',
        robotCode: 'ding-client',
      },
    },
  });
  assert.equal(fx.sent.length, 0);
  assert.equal(fx.proactive.length, 1);
  assert.deepEqual(fx.proactive[0].target, {
    type: 'group',
    openConversationId: 'conversation-1',
    robotCode: 'ding-client',
  });
});

test('a failed webhook send falls back to the proactive API', async () => {
  const fx = delivererFixture({
    sendText: async () => { throw new Error('webhook rejected'); },
  });
  const deferred = deferredFixture();
  await fx.deliverer.register({ key: 'p2p:staff-approved', deferred, route: P2P_ROUTE });
  assert.equal(fx.proactive.length, 1);
  assert.match(fx.proactive[0].text, /后台完成的结果/);
  assert.equal(deferred.released, 1);
});

test('reconnect compensation rescans turns that ended while offline', async () => {
  const fx = delivererFixture({ history: historyFixture({ ended: false }) });
  await fx.deliverer.register({ key: 'p2p:staff-approved', deferred: deferredFixture(), route: P2P_ROUTE });
  fx.setHistory(historyFixture());
  fx.listeners[0].onReconnect?.();
  await eventually(() => fx.sent.length === 1);
});
