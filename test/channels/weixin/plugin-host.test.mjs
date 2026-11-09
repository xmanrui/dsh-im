import { managementFetch } from '../../fixtures/management-rpc.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WEIXIN_ENDPOINTS,
  apply,
  createWeixinRpcHandler,
} from '../../../plugin-src/host/channels/weixin/index.mjs';

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    revision: 1,
    state: 'disconnected',
    bots: [],
    totals: { configured: 0, connected: 0 },
    ...overrides,
  };
}

function controllerFixture() {
  const attempts = new Map();
  const controller = {
    status: () => snapshot(),
    startProvisioning: async () => {
      const value = {
        attemptId: 'attempt-1',
        status: 'pending',
        verificationUrl: 'https://liteapp.weixin.qq.com/q/test',
        expiresAt: Date.now() + 60_000,
        pollIntervalMs: 1_000,
      };
      attempts.set(value.attemptId, value);
      return value;
    },
    registrationStatus: (id) => attempts.get(id) ?? null,
    submitVerification: async (id) => ({ ...attempts.get(id), status: 'scanned' }),
    cancelProvisioning: async (id) => ({ ...attempts.get(id), status: 'cancelled' }),
    reconnectBot: async () => snapshot(),
    sendConnectionTest: async () => ({ sent: true }),
    deleteBot: async () => snapshot(),
  };
  return controller;
}

test('Host plugin accepts Harness-admitted LAN requests on the Weixin RPC channel by default', async () => {
  let registration;
  const dispose = async () => {};
  const ctx = {
    connection: { fetch: managementFetch((channel, handler, options) => {
      registration = { channel, handler, options };
      return dispose;
    }) },
  };
  const returned = await apply(ctx, { controller: controllerFixture() });
  assert.equal(returned, dispose);
  assert.equal(registration.channel, '/weixin');
  assert.equal(registration.options.path, '/api/dsh-im/weixin');
  assert.equal((await registration.handler('connection.status', {}, undefined, {
    host: '192.168.1.100:3080', origin: 'http://192.168.1.100:3080',
  })).ok, true);
});

test('Host plugin preserves an explicit loopback restriction on the Weixin RPC channel', async () => {
  let registration;
  const ctx = {
    connection: { fetch: managementFetch((channel, handler, options) => {
      registration = { channel, handler, options };
      return async () => {};
    }) },
  };
  await apply(ctx, {
    controller: controllerFixture(),
    rpcAuthority: 'loopback',
  });
  await assert.rejects(registration.handler('connection.status', {}, undefined, {
    host: '192.168.1.100:3080', origin: 'http://192.168.1.100:3080',
  }), /HTTP 403/);
  assert.equal((await registration.handler('connection.status', {})).ok, true);
});

test('RPC returns QR data and verification states without exposing secret-shaped fields', async () => {
  const controller = controllerFixture();
  const handler = createWeixinRpcHandler(controller, {
    encodeQr: async (url) => `data:image/png;base64,${Buffer.from(url).toString('base64')}`,
  });
  const signal = new AbortController().signal;

  const begun = await handler(WEIXIN_ENDPOINTS.beginProvisioning, {}, signal);
  assert.equal(begun.ok, true);
  assert.match(begun.value.qrCodeDataUrl, /^data:image\/png;base64,/);
  const verified = await handler(WEIXIN_ENDPOINTS.submitVerification, {
    attemptId: 'attempt-1', verifyCode: '123456',
  }, signal);
  assert.equal(verified.ok, true);
  assert.equal(verified.value.status, 'scanned');

  const secretAttempt = await handler(WEIXIN_ENDPOINTS.beginProvisioning, {
    bot_token: 'must-never-cross-the-browser-boundary',
  }, signal);
  assert.equal(secretAttempt.ok, false);
  assert.equal(secretAttempt.error.code, 'bad-request');
  assert.doesNotMatch(JSON.stringify(secretAttempt), /must-never-cross/);
});

test('RPC requires explicit confirmation before removing a Weixin account', async () => {
  const handler = createWeixinRpcHandler(controllerFixture());
  const result = await handler(WEIXIN_ENDPOINTS.deleteBot, {
    botId: 'wx_0123456789abcdef01234567',
    confirm: false,
  }, new AbortController().signal);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'bad-request');
});

test('RPC sends a Weixin connection test only after reconnect reports the account connected', async () => {
  const botId = 'wx_0123456789abcdef01234567';
  const sent = [];
  const connected = controllerFixture();
  connected.reconnectBot = async () => snapshot({
    state: 'connected',
    bots: [{ botId, connected: true }],
    totals: { configured: 1, connected: 1 },
  });
  connected.sendConnectionTest = async (id) => { sent.push(id); };
  const success = await createWeixinRpcHandler(connected)(WEIXIN_ENDPOINTS.reconnectBot, {
    botId, sendTest: true,
  });
  assert.equal(success.ok, true);
  assert.deepEqual(success.value.testMessage, { sent: true });
  assert.deepEqual(sent, [botId]);

  connected.sendConnectionTest = async () => { throw new Error('send rejected'); };
  const failedSend = await createWeixinRpcHandler(connected)(WEIXIN_ENDPOINTS.reconnectBot, {
    botId, sendTest: true,
  });
  assert.equal(failedSend.ok, true);
  assert.deepEqual(failedSend.value.testMessage, {
    sent: false, code: 'test-message-failed',
  });

  let offlineSendCalled = false;
  const offline = controllerFixture();
  offline.reconnectBot = async () => snapshot({
    state: 'offline',
    bots: [{ botId, connected: false }],
    totals: { configured: 1, connected: 0 },
  });
  offline.sendConnectionTest = async () => { offlineSendCalled = true; };
  const unavailable = await createWeixinRpcHandler(offline)(WEIXIN_ENDPOINTS.reconnectBot, {
    botId, sendTest: true,
  });
  assert.equal(unavailable.ok, true);
  assert.deepEqual(unavailable.value.testMessage, {
    sent: false, code: 'test-target-unavailable',
  });
  assert.equal(offlineSendCalled, false);
  const missingMethod = controllerFixture();
  missingMethod.reconnectBot = connected.reconnectBot;
  delete missingMethod.sendConnectionTest;
  const missing = await createWeixinRpcHandler(missingMethod)(WEIXIN_ENDPOINTS.reconnectBot, {
    botId, sendTest: true,
  });
  assert.equal(missing.ok, true);
  assert.deepEqual(missing.value.testMessage, {
    sent: false, code: 'test-target-unavailable',
  });
  assert.equal((await createWeixinRpcHandler(connected)(WEIXIN_ENDPOINTS.reconnectBot, {
    botId, sendTest: false,
  })).ok, false);
});

function bindingFixture(initial = {}) {
  const sessions = { ...initial };
  const writes = [];
  const controller = {
    ...controllerFixture(),
    getSessionBinding: async (botId) => ({ botId, sessions: { ...sessions } }),
    setSessionBinding: async (botId, { conversationKey, sessionId }) => {
      writes.push([conversationKey, sessionId]);
      sessions[conversationKey] = sessionId;
      return { botId, conversationKey, sessionId };
    },
  };
  return { controller, sessions, writes };
}

test('RPC reads and writes the conversation Session binding', async () => {
  const botId = 'wx_0123456789abcdef01234567';
  const key = 'p2p:o9cq804hwOnMsSHBxFvne5vh-Hqg@im.wechat';
  const { controller, writes } = bindingFixture();
  const handler = createWeixinRpcHandler(controller);
  const signal = new AbortController().signal;

  const before = await handler(WEIXIN_ENDPOINTS.getSessionBinding, { botId }, signal);
  assert.equal(before.ok, true);
  assert.deepEqual(before.value, { botId, sessions: {} });

  const written = await handler(WEIXIN_ENDPOINTS.setSessionBinding, {
    botId, conversationKey: key, sessionId: 'session-abc123',
  }, signal);
  assert.equal(written.ok, true);
  assert.deepEqual(writes, [[key, 'session-abc123']]);

  const single = await handler(WEIXIN_ENDPOINTS.getSessionBinding, {
    botId, conversationKey: key,
  }, signal);
  assert.deepEqual(single.value, { botId, conversationKey: key, sessionId: 'session-abc123' });

  const absent = await handler(WEIXIN_ENDPOINTS.getSessionBinding, {
    botId, conversationKey: 'p2p:someone-else@im.wechat',
  }, signal);
  assert.equal(absent.value.sessionId, null);
});

test('RPC rejects malformed Session binding payloads', async () => {
  const botId = 'wx_0123456789abcdef01234567';
  const handler = createWeixinRpcHandler(bindingFixture().controller);
  const signal = new AbortController().signal;
  const rejects = [
    [{}, WEIXIN_ENDPOINTS.setSessionBinding],
    [{ botId, sessionId: 'session-abc123' }, WEIXIN_ENDPOINTS.setSessionBinding],
    [{ botId, conversationKey: '' , sessionId: 'session-abc123' }, WEIXIN_ENDPOINTS.setSessionBinding],
    [{ botId, conversationKey: 'p2p:x', sessionId: 'has space' }, WEIXIN_ENDPOINTS.setSessionBinding],
    [{ botId, conversationKey: 'p2p:x', sessionId: 'session-abc123', extra: 1 }, WEIXIN_ENDPOINTS.setSessionBinding],
    [{ botId: 'not a valid id!', conversationKey: 'p2p:x' }, WEIXIN_ENDPOINTS.getSessionBinding],
  ];
  for (const [payload, endpoint] of rejects) {
    const result = await handler(endpoint, payload, signal);
    assert.equal(result.ok, false, `${endpoint} accepted ${JSON.stringify(payload)}`);
    assert.equal(result.error.code, 'bad-request');
  }
  assert.deepEqual(bindingFixture().writes, []);
});

test('RPC refuses Session binding endpoints the controller does not provide', async () => {
  const handler = createWeixinRpcHandler(controllerFixture());
  const botId = 'wx_0123456789abcdef01234567';
  const signal = new AbortController().signal;
  const read = await handler(WEIXIN_ENDPOINTS.getSessionBinding, { botId }, signal);
  assert.equal(read.ok, false);
  const write = await handler(WEIXIN_ENDPOINTS.setSessionBinding, {
    botId, conversationKey: 'p2p:x', sessionId: 'session-abc123',
  }, signal);
  assert.equal(write.ok, false);
});
