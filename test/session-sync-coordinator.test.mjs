import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSessionSyncCoordinator,
  installSessionSyncCoordinator,
} from '../plugin-src/host/session-sync-coordinator.mjs';

const TARGET_A = Object.freeze({ channel: 'feishu', botId: 'bot-a', targetId: 'alice' });
const TARGET_B = Object.freeze({ channel: 'telegram', botId: 'bot-b', targetId: 'bob' });
const TARGET_C = Object.freeze({ channel: 'slack', botId: 'bot-c', targetId: 'carol' });
const TARGET_WEIXIN = Object.freeze({ channel: 'weixin', botId: 'bot-weixin', targetId: 'owner' });

function turnStart(turn = 1) {
  return { type: 'turn/start', data: { turn } };
}

function userMessage(text, rpcId = 'dsh-user') {
  return {
    type: 'user/message',
    surfaceOp: 'append',
    data: { source: { kind: 'user', rpcId }, content: [{ type: 'text', text }] },
  };
}

function assistantMessage(step, text, turn = 1) {
  return {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      turn,
      step,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
  };
}

function turnEnd(reason = { kind: 'completed' }, turn = 1) {
  return { type: 'turn/end', data: { turn, reason } };
}

test('Session sync mirrors direct DSH text and one ordered multi-step assistant result', async () => {
  const sends = [];
  let lookup = 0;
  const deliveryService = {
    async listSessionSyncTargets() {
      lookup += 1;
      return lookup === 1 ? [TARGET_A, TARGET_B] : [TARGET_A, TARGET_C];
    },
    async sendSessionSyncText(botId, targetId, sessionId, text) {
      sends.push({ botId, targetId, sessionId, text });
    },
  };
  const coordinator = createSessionSyncCoordinator({ deliveryService });

  void coordinator.enqueue('session-one', turnStart());
  void coordinator.enqueue('session-one', userMessage('先检查构建'), 'dsh');
  void coordinator.enqueue('session-one', userMessage('再检查测试', 'dsh-steer'), 'dsh');
  void coordinator.enqueue('session-one', assistantMessage(1, '第二步结果'));
  void coordinator.enqueue('session-one', {
    type: 'assistant/attempt',
    surfaceOp: 'append',
    data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '不得出现' }] } },
  });
  void coordinator.enqueue('session-one', assistantMessage(0, '第一步结果'));
  void coordinator.enqueue('session-one', turnEnd());
  await coordinator.whenIdle();

  assert.deepEqual(sends, [
    { botId: 'bot-a', targetId: 'alice', sessionId: 'session-one', text: '[来自 DSH]\n先检查构建' },
    { botId: 'bot-b', targetId: 'bob', sessionId: 'session-one', text: '[来自 DSH]\n先检查构建' },
    { botId: 'bot-a', targetId: 'alice', sessionId: 'session-one', text: '[来自 DSH]\n再检查测试' },
    { botId: 'bot-c', targetId: 'carol', sessionId: 'session-one', text: '[来自 DSH]\n再检查测试' },
    {
      botId: 'bot-a',
      targetId: 'alice',
      sessionId: 'session-one',
      text: '[DSH 助手]\n\n第一步结果\n\n第二步结果',
    },
  ]);
});

test('Session sync suppresses IM, unknown, non-append, and unsuccessful Turn output', async () => {
  const sends = [];
  const deliveryService = {
    async listSessionSyncTargets() { return [TARGET_A]; },
    async sendSessionSyncText(...args) { sends.push(args); },
  };
  const coordinator = createSessionSyncCoordinator({ deliveryService });

  for (const [sessionId, origin, reason] of [
    ['session-im', 'im', { kind: 'completed' }],
    ['session-unknown', 'other', { kind: 'completed' }],
    ['session-failed', 'dsh', { kind: 'error' }],
  ]) {
    void coordinator.enqueue(sessionId, turnStart());
    void coordinator.enqueue(sessionId, userMessage('输入'), origin);
    void coordinator.enqueue(sessionId, assistantMessage(0, '回答'));
    void coordinator.enqueue(sessionId, turnEnd(reason));
  }
  void coordinator.enqueue('session-replace', turnStart());
  void coordinator.enqueue('session-replace', {
    ...userMessage('替换输入'),
    surfaceOp: 'replace',
  }, 'dsh');
  void coordinator.enqueue('session-replace', assistantMessage(0, '不得发送'));
  void coordinator.enqueue('session-replace', turnEnd());
  await coordinator.whenIdle();

  assert.deepEqual(sends, [[
    'bot-a', 'alice', 'session-failed', '[来自 DSH]\n输入', { format: 'plain' },
  ]]);
});

test('Session sync isolates target failures and only returns the assistant to successful recipients', async () => {
  const sends = [];
  const warnings = [];
  const deliveryService = {
    async listSessionSyncTargets() { return [TARGET_A, TARGET_B]; },
    async sendSessionSyncText(botId, targetId, sessionId, text) {
      sends.push({ botId, targetId, sessionId, text });
      if (targetId === 'bob') throw new Error('provider secret detail');
    },
  };
  const coordinator = createSessionSyncCoordinator({
    deliveryService,
    logger: { warn: (...args) => warnings.push(args) },
  });

  void coordinator.enqueue('session-one', turnStart());
  void coordinator.enqueue('session-one', userMessage('开始'), 'dsh');
  void coordinator.enqueue('session-one', assistantMessage(0, '完成'));
  void coordinator.enqueue('session-one', turnEnd('completed'));
  await coordinator.whenIdle();

  assert.equal(sends.filter((entry) => entry.targetId === 'alice').length, 2);
  assert.equal(sends.filter((entry) => entry.targetId === 'bob').length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /telegram\/bot-b\/bob/);
});

test('installed Session sync classifies an unregistered Host user rpcId as direct DSH input', async () => {
  let listener;
  let disposed = 0;
  const effects = [];
  const sends = [];
  const ctx = {
    root: {},
    on(name, callback, options) {
      assert.equal(name, 'session/event');
      assert.deepEqual(options, { global: true });
      listener = callback;
      return () => { disposed += 1; };
    },
    effect(effect) { effects.push(effect()); },
  };
  const installed = installSessionSyncCoordinator(ctx, {
    async listSessionSyncTargets() { return [TARGET_A]; },
    async sendSessionSyncText(...args) { sends.push(args); },
  });

  listener({ id: 'session-one' }, turnStart());
  listener({ id: 'session-one' }, userMessage('Desktop 输入', 'desktop-rpc'));
  listener({ id: 'session-one' }, assistantMessage(0, 'Desktop 回答'));
  listener({ id: 'session-one' }, turnEnd());
  await installed.whenIdle();

  assert.deepEqual(sends.map((entry) => entry[3]), [
    '[来自 DSH]\nDesktop 输入',
    '[DSH 助手]\n\nDesktop 回答',
  ]);
  effects[0]();
  installed.close();
  assert.equal(disposed, 1);
});

test('installed Session sync sends one scheduled answer without echoing its internal input', async () => {
  let listener;
  const sends = [];
  const installed = installSessionSyncCoordinator({
    root: {},
    on(_name, callback) { listener = callback; return () => {}; },
  }, {
    async listSessionSyncTargets() { return [TARGET_WEIXIN, TARGET_WEIXIN, {}]; },
    async sendSessionSyncText(...args) { sends.push(args); },
  });
  const session = { id: 'scheduled-session' };
  listener(session, turnStart());
  listener(session, {
    ...userMessage('internal reminder framing'),
    data: { source: { kind: 'schedule' }, content: [{ type: 'text', text: 'internal reminder framing' }] },
  });
  listener(session, assistantMessage(1, 'second step'));
  listener(session, assistantMessage(0, 'first step'));
  await installed.whenIdle();
  assert.deepEqual(sends, [], 'wait for successful completion; never echo the reminder');
  listener(session, turnEnd());
  listener(session, turnEnd());
  await installed.whenIdle();
  assert.deepEqual(sends, [[
    'bot-weixin', 'owner', 'scheduled-session', '[DSH 助手]\n\nfirst step\n\nsecond step', { format: 'markdown' },
  ]]);
  installed.close();
});

test('all eleven sync channels request Markdown for answers while Feishu retains its plain mirror fallback', async () => {
  const channels = ['feishu', 'telegram', 'qq', 'dingtalk', 'slack', 'wecom',
    'matrix', 'discord', 'whatsapp', 'wecom-app', 'weixin'];
  const sends = [];
  const coordinator = createSessionSyncCoordinator({ deliveryService: {
    listSessionSyncTargets: async () => channels.map(channel => ({ channel, botId: channel, targetId: 'owner' })),
    sendSessionSyncText: async (...args) => sends.push(args),
  } });
  await coordinator.enqueue('session', turnStart());
  await coordinator.enqueue('session', userMessage('**literal question**'), 'dsh');
  await coordinator.enqueue('session', assistantMessage(0, '# Heading\n\n**answer**'));
  await coordinator.enqueue('session', turnEnd());
  for (const channel of channels) {
    const [question, answer] = sends.filter(args => args[0] === channel);
    assert.deepEqual(question.slice(3), ['[来自 DSH]\n**literal question**', { format: 'plain' }]);
    assert.deepEqual(answer.slice(3), ['[DSH 助手]\n\n# Heading\n\n**answer**', {
      format: channel === 'feishu' ? 'plain' : 'markdown',
    }]);
  }
  assert.equal(sends.length, channels.length * 2);
  coordinator.close();
});

test('scheduled sync keeps target selection, completion, and IM ownership checks', async () => {
  const sends = [];
  const warnings = [];
  const coordinator = createSessionSyncCoordinator({
    deliveryService: {
      async listSessionSyncTargets(sessionId) {
        return sessionId === 'unbound' ? [] : [TARGET_WEIXIN];
      },
      async sendSessionSyncText(...args) { sends.push(args); },
    },
    logger: { warn: (...args) => warnings.push(args) },
  });
  const reminder = {
    ...userMessage('internal reminder'),
    data: { source: { kind: 'schedule' }, content: [{ type: 'text', text: 'internal reminder' }] },
  };
  for (const sessionId of ['unbound', 'aborted', 'im-owned']) {
    void coordinator.enqueue(sessionId, turnStart());
    if (sessionId === 'im-owned') {
      void coordinator.enqueue(sessionId, userMessage('IM question'), 'im');
    }
    void coordinator.enqueue(sessionId, reminder, 'dsh');
    void coordinator.enqueue(sessionId, assistantMessage(0, 'answer'));
    void coordinator.enqueue(sessionId, turnEnd(sessionId === 'aborted' ? 'aborted' : 'completed'));
  }
  await coordinator.whenIdle();
  assert.deepEqual(sends, []);
  assert.deepEqual(warnings, []);
  coordinator.close();
});
