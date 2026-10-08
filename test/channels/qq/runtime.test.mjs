import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { QqRuntime } from '../../../src/channels/qq/qq-runtime.mjs';
import { rememberConnectionTestTarget } from '../../../src/channels/shared/connection-test.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

class FakeBot extends EventEmitter {
  middlewares = [];
  sent = [];
  stopped = false;
  use(value) { this.middlewares.push(value); }
  async start(signal) {
    queueMicrotask(() => this.emit('ready', {}));
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  }
  stop() { this.stopped = true; }
  async sendText(target, text) { this.sent.push({ target, text }); }
}

test('QQ runtime preserves mention decisions through sanitization, typing and commands', async (t) => {
  const bot = new FakeBot();
  bot.appId = '123';
  const typing = [];
  const seen = new Set();
  const runtime = new QqRuntime({
    config: { botId: 'qq_bot', appId: '123', ownerUserOpenid: '*' }, appSecret: 'secret',
    harness: { ensureRunning: async () => true },
    state: { hasSeen: (id) => seen.has(id), markSeen: async (id) => seen.add(id) },
    createBot: () => bot,
    typingMiddleware: ({ predicate }) => async (ctx, next) => {
      typing.push(predicate(ctx));
      await next();
    },
  });
  t.after(() => runtime.stop());
  await runtime.start();
  bot.emit('ready', { user: { id: 'ready-self' } });
  bot.emit('resumed'); // A resume without user data must retain the verified identity.
  let sequence = 0;
  async function dispatch(content, fields = {}) {
    const ctx = { bot, message: {
      kind: 'group', rawEventType: 'GROUP_MESSAGE_CREATE', senderId: 'owner', groupOpenid: 'g',
      messageId: `runtime-mention-${++sequence}`, content, raw: { content },
      replyTarget: { scope: 'group', targetId: 'g', msgId: `runtime-mention-${sequence}` }, ...fields,
    } };
    let index = 0;
    const next = async () => {
      if (index < bot.middlewares.length) return bot.middlewares[index++](ctx, next);
      bot.emit('message', ctx, ctx.message);
    };
    await next();
    // Bridge scheduling is asynchronous; local status commands need no network.
    await new Promise((resolve) => setImmediate(resolve));
    return ctx.message;
  }
  for (const [content, fields] of [
    ['<@123> /status', {}],
    ['<@!ready-self> /status', {}],
    ['<@ABCDEF0123456789ABCDEF0123456789> /status', {
      mentions: [{ is_you: true, member_openid: 'ABCDEF0123456789ABCDEF0123456789' }],
    }],
    ['<@!ABCDEF0123456789ABCDEF0123456789> /status', {}],
  ]) {
    const count = bot.sent.length;
    const normalized = await dispatch(content, fields);
    assert.equal(normalized.content, '/status');
    assert.equal(typing.at(-1), true);
    assert.equal(bot.sent.length, count + 1);
    assert.match(bot.sent.at(-1).text, /连接正常/);
  }
  const count = bot.sent.length;
  for (const content of ['/status', '<@other> /status', '<@1234> /status']) {
    await dispatch(content);
    assert.equal(typing.at(-1), false);
    assert.equal(bot.sent.length, count);
  }
  // Recreating a runtime must not inherit IDs learned from a previous connection.
  await runtime.stop();
  bot.middlewares = [];
  await runtime.start();
  await dispatch('<@ABCDEF0123456789ABCDEF0123456789> /status');
  assert.equal(typing.at(-1), false);
  assert.equal(bot.sent.length, count);
});

test('QQ runtime waits for gateway ready, installs typing, and stops its client', async () => {
  const bot = new FakeBot();
  let botOptions;
  const sdkLogs = [];
  const runtime = new QqRuntime({
    config: { botId: 'qq_bot', appId: 'app', ownerUserOpenid: 'owner' },
    appSecret: 'secret',
    harness: { ensureRunning: async () => true },
    state: {},
    createBot: (options) => {
      botOptions = options;
      return bot;
    },
    logger: {
      debug: (...args) => sdkLogs.push(['debug', ...args]),
      info: (...args) => sdkLogs.push(['info', ...args]),
    },
    typingMiddleware: (options) => ({ name: 'typing-middleware', options }),
    connectTimeoutMs: 100,
  });
  const status = await runtime.start();
  assert.equal(status.ready, true);
  assert.equal(status.qqConnectionState, 'connected');
  assert.equal(typeof bot.middlewares[0], 'function'); // mention normalization
  assert.equal(typeof bot.middlewares[1], 'function'); // contentSanitizer (face-tag parsing)
  assert.equal(bot.middlewares[2].name, 'typing-middleware');
  assert.equal(bot.middlewares[2].options.keepAlive, true);
  assert.equal(bot.middlewares[2].options.predicate({ message: { senderId: 'owner' } }), true);
  assert.equal(bot.middlewares[2].options.predicate({ message: { senderId: 'other' } }), false);
  assert.equal(botOptions.markdownSupport, false);
  botOptions.logger.debug('raw gateway payload');
  botOptions.logger.info('gateway ready');
  assert.deepEqual(sdkLogs, [['info', 'gateway ready']]);
  bot.emit('error', new Error('temporary disconnect'));
  assert.equal(runtime.status.ready, false);
  bot.emit('resumed');
  assert.equal(runtime.status.ready, true);
  assert.equal(runtime.status.lastError, null);
  await runtime.stop();
  assert.equal(bot.stopped, true);
  assert.equal(runtime.status.ready, false);
  bot.emit('ready', {});
  bot.emit('resumed', {});
  assert.equal(runtime.status.ready, false);
});

test('QQ runtime never reports ready when the gateway does not emit ready', async () => {
  const bot = new FakeBot();
  bot.start = async (signal) => new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  const runtime = new QqRuntime({
    config: { botId: 'qq_bot', appId: 'app', ownerUserOpenid: 'owner' },
    appSecret: 'secret',
    harness: { ensureRunning: async () => true },
    state: {},
    createBot: () => bot,
    typingMiddleware: () => 'typing',
    connectTimeoutMs: 5,
  });
  await assert.rejects(() => runtime.start(), /did not become ready/);
  assert.equal(runtime.status.ready, false);
});

test('QQ runtime sends a proactive connection test to the explicit owner fallback', async () => {
  const bot = new FakeBot();
  const runtime = new QqRuntime({
    config: { botId: 'qq_bot', appId: 'app', ownerUserOpenid: 'owner-openid' },
    appSecret: 'secret',
    harness: { ensureRunning: async () => true },
    state: {},
    createBot: () => bot,
    typingMiddleware: () => 'typing',
    connectTimeoutMs: 100,
  });

  await runtime.start();
  assert.deepEqual(await runtime.sendConnectionTest('connection-test'), { sent: true });
  assert.deepEqual(bot.sent, [{
    target: { scope: 'c2c', targetId: 'owner-openid' },
    text: 'connection-test',
  }]);
  await runtime.sendProactiveText({
    kind: 'group',
    route: { groupOpenId: 'group-openid' },
  }, 'proactive-test');
  assert.deepEqual(bot.sent[1], {
    target: { scope: 'group', targetId: 'group-openid' },
    text: 'proactive-test',
  });
  await runtime.stop();
});

test('QQ runtime requires a remembered private target for wildcard owners and strips the reply id', async () => {
  const bot = new FakeBot();
  const state = {};
  const runtime = new QqRuntime({
    config: { botId: 'qq_bot', appId: 'app', ownerUserOpenid: '*' },
    appSecret: 'secret',
    harness: { ensureRunning: async () => true },
    state,
    createBot: () => bot,
    typingMiddleware: () => 'typing',
    connectTimeoutMs: 100,
  });

  await runtime.start();
  await assert.rejects(
    () => runtime.sendConnectionTest('unavailable'),
    (error) => error?.code === 'test-target-unavailable',
  );
  rememberConnectionTestTarget(state, {
    scope: 'c2c', targetId: 'recent-user', msgId: 'old-inbound-message',
  });
  await runtime.sendConnectionTest('remembered-target');
  assert.deepEqual(bot.sent, [{
    target: { scope: 'c2c', targetId: 'recent-user' },
    text: 'remembered-target',
  }]);
  await runtime.stop();
});

test('QQ runtime aborts an in-flight Harness interaction when stopped', async () => {
  const bot = new FakeBot();
  const askStarted = deferred();
  let askSignal;
  const runtime = new QqRuntime({
    config: { botId: 'qq_bot', appId: 'app', ownerUserOpenid: 'owner' },
    appSecret: 'secret',
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        askSignal = options.signal;
        askStarted.resolve();
        await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
          reject(options.signal.reason);
        }, { once: true }));
      },
    },
    state: {
      hasSeen: () => false,
      markSeen: async () => {},
      sessionFor: () => 'session-existing',
      setSession: async () => {},
      clearSession: async () => {},
    },
    createBot: () => bot,
    typingMiddleware: () => 'typing',
    connectTimeoutMs: 100,
    logger: { error() {}, warn() {}, info() {} },
  });

  await runtime.start();
  bot.emit('message', {}, {
    kind: 'c2c',
    rawEventType: 'C2C_MESSAGE_CREATE',
    senderId: 'owner',
    senderIsBot: false,
    content: '需要交互',
    messageId: 'interaction-message',
    replyTarget: { scope: 'c2c', targetId: 'owner', msgId: 'interaction-message' },
  });
  await askStarted.promise;
  assert.equal(askSignal.aborted, false);
  bot.emit('message', {}, {
    kind: 'c2c',
    rawEventType: 'C2C_MESSAGE_CREATE',
    senderId: 'owner',
    senderIsBot: false,
    content: '排队中的下一条消息',
    messageId: 'queued-message',
    replyTarget: { scope: 'c2c', targetId: 'owner', msgId: 'queued-message' },
  });
  await runtime.stop();
  assert.equal(askSignal.aborted, true);
});

test('QQ runtime enables result-file delivery without per-bot configuration', async () => {
  const bot = new FakeBot();
  const askObserved = deferred();
  let onArtifact;
  const runtime = new QqRuntime({
    config: { botId: 'qq_bot', appId: 'app', ownerUserOpenid: 'owner' },
    appSecret: 'secret',
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        onArtifact = options.onArtifact;
        askObserved.resolve();
        return '完成';
      },
    },
    state: {
      hasSeen: () => false,
      markSeen: async () => {},
      sessionFor: () => 'session-existing',
      setSession: async () => {},
      clearSession: async () => {},
    },
    createBot: () => bot,
    typingMiddleware: () => 'typing',
    connectTimeoutMs: 100,
  });

  await runtime.start();
  bot.emit('message', {}, {
    kind: 'c2c',
    rawEventType: 'C2C_MESSAGE_CREATE',
    senderId: 'owner',
    senderIsBot: false,
    content: '生成文件',
    messageId: 'qq-artifact-gate',
    replyTarget: { scope: 'c2c', targetId: 'owner', msgId: 'qq-artifact-gate' },
  });
  await askObserved.promise;
  assert.equal(typeof onArtifact, 'function');
  await runtime.stop();
});
