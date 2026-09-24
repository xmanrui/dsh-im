import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WecomRuntime } from '../../../src/channels/wecom/wecom-runtime.mjs';
import { rememberConnectionTestTarget } from '../../../src/channels/shared/connection-test.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

class FakeClient extends EventEmitter {
  disconnected = false;
  sent = [];
  connect() { queueMicrotask(() => this.emit('authenticated')); }
  disconnect() { this.disconnected = true; }
  async replyStream() {}
  async replyStreamNonBlocking() {}
  async sendMessage(chatId, body) { this.sent.push({ chatId, body }); }
}

test('Enterprise WeChat runtime sends a connection test only to the remembered private target', async () => {
  const client = new FakeClient();
  const state = {};
  const runtime = new WecomRuntime({
    config: { botId: 'wecom_bot', remoteBotId: 'remote-bot' },
    secret: 'private-secret',
    harness: { ensureRunning: async () => true },
    state,
    createClient: () => client,
    connectTimeoutMs: 100,
  });
  await runtime.start();
  await assert.rejects(() => runtime.sendConnectionTest('测试'), {
    code: 'test-target-unavailable',
  });
  rememberConnectionTestTarget(state, { chatId: 'member-private' });
  assert.deepEqual(await runtime.sendConnectionTest('测试'), { sent: true });
  assert.deepEqual(client.sent, [{
    chatId: 'member-private',
    body: { msgtype: 'markdown', markdown: { content: '测试' } },
  }]);
  assert.deepEqual(await runtime.sendProactiveText({
    kind: 'group',
    route: { chatId: 'group-target' },
  }, '主动投递'), { sent: true });
  assert.deepEqual(client.sent[1], {
    chatId: 'group-target',
    body: { msgtype: 'markdown', markdown: { content: '主动投递' } },
  });
  await runtime.stop();
});

test('Enterprise WeChat runtime waits for authentication, suppresses SDK payload logs, and reconnects', async () => {
  const client = new FakeClient();
  let options;
  const logs = [];
  const runtime = new WecomRuntime({
    config: { botId: 'wecom_bot', remoteBotId: 'remote-bot' },
    secret: 'private-secret',
    harness: { ensureRunning: async () => true },
    state: {},
    createClient: (value) => { options = value; return client; },
    logger: { debug: (...args) => logs.push(args), warn() {} },
    connectTimeoutMs: 100,
  });
  const status = await runtime.start();
  assert.equal(status.ready, true);
  assert.equal(status.wecomConnectionState, 'connected');
  assert.equal(options.botId, 'remote-bot');
  assert.equal(options.secret, 'private-secret');
  options.logger.debug('raw message payload');
  options.logger.warn('raw unknown frame');
  assert.deepEqual(logs, []);
  client.emit('disconnected', 'network');
  assert.equal(runtime.status.ready, false);
  assert.equal(runtime.status.wecomConnectionState, 'connecting');
  client.emit('authenticated');
  assert.equal(runtime.status.ready, true);
  await runtime.stop();
  assert.equal(client.disconnected, true);
  assert.equal(runtime.status.ready, false);
});

test('Enterprise WeChat runtime never reports ready without SDK authentication', async () => {
  const client = new FakeClient();
  client.connect = () => {};
  const runtime = new WecomRuntime({
    config: { botId: 'wecom_bot', remoteBotId: 'remote-bot' },
    secret: 'private-secret',
    harness: { ensureRunning: async () => true },
    state: {},
    createClient: () => client,
    connectTimeoutMs: 5,
  });
  await assert.rejects(() => runtime.start(), /authentication timed out/);
  assert.equal(runtime.status.ready, false);
  assert.equal(client.disconnected, true);
});

test('Enterprise WeChat runtime stop cancels an in-flight authentication wait', async () => {
  const client = new FakeClient();
  client.connect = () => {};
  const runtime = new WecomRuntime({
    config: { botId: 'wecom_bot', remoteBotId: 'remote-bot' },
    secret: 'private-secret',
    harness: { ensureRunning: async () => true },
    state: {},
    createClient: () => client,
    connectTimeoutMs: 60_000,
  });
  const starting = runtime.start();
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.stop();
  await assert.rejects(starting, { name: 'AbortError' });
  assert.equal(client.disconnected, true);
  assert.equal(runtime.status.wecomConnectionState, 'idle');
});

test('Enterprise WeChat runtime aborts an in-flight Harness interaction when stopped', async () => {
  const client = new FakeClient();
  const askStarted = deferred();
  let askSignal;
  const runtime = new WecomRuntime({
    config: { botId: 'wecom_bot', remoteBotId: 'remote-bot' },
    secret: 'private-secret',
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
    createClient: () => client,
    connectTimeoutMs: 100,
    logger: { error() {}, warn() {} },
  });

  await runtime.start();
  client.emit('message', {
    headers: { req_id: 'req-interaction' },
    body: {
      msgid: 'msg-interaction',
      chattype: 'single',
      from: { userid: 'member-1' },
      msgtype: 'text',
      text: { content: '需要交互' },
    },
  });
  await askStarted.promise;
  assert.equal(askSignal.aborted, false);
  await runtime.stop();
  assert.equal(askSignal.aborted, true);
});

test('Enterprise WeChat runtime enables result-file delivery without per-bot configuration', async () => {
  const client = new FakeClient();
  const askObserved = deferred();
  let onArtifact;
  const runtime = new WecomRuntime({
    config: { botId: 'wecom_bot', remoteBotId: 'remote-bot' },
    secret: 'private-secret',
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
    createClient: () => client,
    connectTimeoutMs: 100,
  });

  await runtime.start();
  client.emit('message', {
    headers: { req_id: 'req-artifact-gate' },
    body: {
      msgid: 'msg-artifact-gate',
      chattype: 'single',
      from: { userid: 'member-1' },
      msgtype: 'text',
      text: { content: '生成文件' },
    },
  });
  await askObserved.promise;
  assert.equal(typeof onArtifact, 'function');
  await runtime.stop();
});
