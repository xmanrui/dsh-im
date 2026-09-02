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
  cards = null,
  boundSession = 'session-defer',     // 默认与 deferredFixture().sessionId 一致
  sessionForCapability = true,        // false 则 state 不提供 sessionFor（能力缺失场景）
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
    ...(cards ? {
      createAiCard: async ({ initialText, target }) => {
        cards.created.push({ initialText, target });
        if (cards.createError) throw new Error('card create rejected');
        return { cardInstanceId: cards.cardInstanceId ?? 'card-defer-1' };
      },
      finishAiCard: async ({ cardInstanceId, text }) => {
        cards.finished.push({ cardInstanceId, text });
        if (cards.finishError) throw new Error('card finish rejected');
        return { delivered: true, completed: true };
      },
      failAiCard: async (request) => {
        if (typeof request?.text !== 'string' || !request.text.trim()) {
          throw new TypeError('text is required');
        }
        cards.failed.push(request);
        return true;
      },
    } : {}),
  };
  const binding = { session: boundSession };
  const state = {
    ...(sessionForCapability ? {
      sessionFor: (key) => binding.session,
    } : {}),
    rememberOutboundMessage: async (entry) => remembered.push(entry),
  };
  const deliverer = createDeferredDeliverer({
    api,
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness,
    state,
    logger: { warn: () => {} },
    sendText: sendText ?? (async (_webhook, text, _at) => {
      sent.push(text);
      return ['webhook-msg-1'];
    }),
  });
  return {
    deliverer, listeners, sent, proactive, remembered, cards: cards ?? null,
    setHistory: (next) => { history = next; },
    setBinding: (next) => { binding.session = next; },
  };
}

const P2P_ROUTE = {
  sessionWebhook: 'https://oapi.dingtalk.com/robot/reply?ticket=defer-1',
  sessionWebhookExpiredTime: 0,
  fallbackTarget: { type: 'user', userId: 'staff-approved', robotCode: 'ding-client' },
  at: undefined,
};

const CARD_ROUTE = {
  ...P2P_ROUTE,
  cardTarget: { type: 'user', userId: 'staff-approved' },
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

test('a card-capable route delivers the deferred result as a finalized AI card', async () => {
  const cards = { created: [], finished: [], failed: [] };
  const fx = delivererFixture({ cards });
  const deferred = deferredFixture();
  await fx.deliverer.register({ key: 'p2p:staff-approved', deferred, route: CARD_ROUTE });
  assert.equal(cards.created.length, 1);
  assert.equal(cards.created[0].initialText, '后台完成的结果');
  assert.deepEqual(cards.created[0].target, { type: 'user', userId: 'staff-approved' });
  assert.deepEqual(cards.finished, [{
    cardInstanceId: 'card-defer-1',
    text: '后台完成的结果',
  }]);
  assert.equal(fx.sent.length, 0, 'card delivery must not also send webhook text');
  assert.equal(fx.proactive.length, 0);
  assert.equal(deferred.released, 1);
  assert.deepEqual(fx.remembered[0].providerMessageIds, ['card-defer-1']);
});

test('a failed card creation falls back to the webhook text path', async () => {
  const cards = { created: [], finished: [], failed: [], createError: true };
  const fx = delivererFixture({ cards });
  const deferred = deferredFixture();
  await fx.deliverer.register({ key: 'p2p:staff-approved', deferred, route: CARD_ROUTE });
  assert.equal(fx.sent.length, 1);
  assert.equal(fx.sent[0], '后台完成的结果');
  assert.equal(deferred.released, 1);
});

test('a failed card finalize marks the card failed and falls back to text', async () => {
  const cards = { created: [], finished: [], failed: [], finishError: true };
  const fx = delivererFixture({ cards });
  const deferred = deferredFixture();
  await fx.deliverer.register({ key: 'p2p:staff-approved', deferred, route: CARD_ROUTE });
  assert.equal(cards.failed.length, 1);
  assert.equal(cards.failed[0].cardInstanceId, 'card-defer-1');
  assert.equal(cards.failed[0].text, '卡片已结束，请查看后续消息。');
  assert.equal(fx.sent.length, 1, 'text fallback after finalize failure');
});

test('a card-capable api without a cardTarget in the route keeps the text path', async () => {
  const cards = { created: [], finished: [], failed: [] };
  const fx = delivererFixture({ cards });
  const deferred = deferredFixture();
  await fx.deliverer.register({ key: 'p2p:staff-approved', deferred, route: P2P_ROUTE });
  assert.equal(cards.created.length, 0);
  assert.equal(fx.sent.length, 1);
});

test('a deferred result is dropped when the conversation moved to another session', async () => {
  const fx = delivererFixture({ boundSession: 'session-other' });
  const deferred = deferredFixture();
  await fx.deliverer.register({ key: 'p2p:staff-approved', deferred, route: P2P_ROUTE });
  assert.equal(fx.sent.length, 0);
  assert.equal(fx.proactive.length, 0);
  assert.equal(deferred.released, 1, 'dropped entry must release ownership');
  assert.equal(fx.remembered.length, 0);
  // 条目已删：重复事件不补投。
  fx.listeners[0].onSessionEvent({
    sessionId: 'session-defer',
    event: { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fx.sent.length, 0);
});

test('switching back while the turn runs delivers at completion', async () => {
  const fx = delivererFixture({ history: historyFixture({ ended: false }), boundSession: 'session-other' });
  const deferred = deferredFixture();
  await fx.deliverer.register({ key: 'p2p:staff-approved', deferred, route: P2P_ROUTE });
  assert.equal(fx.sent.length, 0);
  fx.setBinding('session-defer');
  fx.setHistory(historyFixture());
  fx.listeners[0].onSessionEvent({
    sessionId: 'session-defer',
    event: { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  });
  await eventually(() => fx.sent.length === 1);
  assert.equal(deferred.released, 1);
});

test('switching back after completion does not retroactively deliver', async () => {
  const fx = delivererFixture({ boundSession: 'session-other' });
  const deferred = deferredFixture();
  await fx.deliverer.register({ key: 'p2p:staff-approved', deferred, route: P2P_ROUTE });
  assert.equal(fx.sent.length, 0, 'dropped at completion while unbound');
  fx.setBinding('session-defer');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fx.sent.length, 0, 'no retroactive delivery after rebind');
});

test('a state without sessionFor keeps delivering (capability-graceful)', async () => {
  const fx = delivererFixture({ sessionForCapability: false });
  const deferred = deferredFixture();
  await fx.deliverer.register({ key: 'p2p:staff-approved', deferred, route: P2P_ROUTE });
  assert.deepEqual(fx.sent, ['后台完成的结果']);
});

test('pendingFor reports in-flight entries for the conversation binding', async () => {
  const fx = delivererFixture({ history: historyFixture({ ended: false }) });
  await fx.deliverer.register({ key: 'p2p:staff-approved', deferred: deferredFixture(), route: P2P_ROUTE });
  assert.equal(fx.deliverer.pendingFor('p2p:staff-approved', 'session-defer'), true);
  assert.equal(fx.deliverer.pendingFor('p2p:staff-approved', 'session-other'), false);
  assert.equal(fx.deliverer.pendingFor('group:conversation-1', 'session-defer'), false);
});
