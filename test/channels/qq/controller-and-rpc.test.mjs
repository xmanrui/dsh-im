import { assertTestMessageFailure } from '../../fixtures/connection-diagnostics.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { maskQqAppId } from '../../../src/channels/qq/config-store.mjs';
import { QqController } from '../../../src/channels/qq/qq-controller.mjs';
import { connectionTestMessage } from '../../../src/channels/shared/connection-test.mjs';
import { QQ_ENDPOINTS, createQqRpcHandler } from '../../../plugin-src/host/channels/qq/rpc.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('QQ QR success stores the secret off-config and starts a scanner-owned runtime', async () => {
  const qr = deferred();
  let callbacks;
  const values = new Map();
  const configs = [];
  let runtimeArgs;
  const controller = new QqController({
    qrAuth: {
      start(next) {
        callbacks = next;
        queueMicrotask(() => next.onQrDisplayed('https://q.qq.com/connect?task=opaque'));
        return () => {};
      },
    },
    credentials: {
      resolve: async (ref) => values.has(ref) ? { value: values.get(ref) } : undefined,
      set: async (ref, value) => values.set(ref, value),
      unset: async (ref) => values.delete(ref),
    },
    configStore: {
      list: () => [...configs],
      get: (id) => configs.find((value) => value.botId === id) ?? null,
      getByAppId: (id) => configs.find((value) => value.appId === id) ?? null,
      save: async (value) => { configs.splice(0, configs.length, value); },
      remove: async () => null,
    },
    createRuntime: async (args) => {
      runtimeArgs = args;
      return { status: { ready: true, qqConnectionState: 'connected', harnessReachable: true }, start: async () => {}, stop: async () => {} };
    },
  });
  const started = await controller.startProvisioning();
  assert.equal(started.status, 'pending');
  callbacks.onSuccess([{ appId: 'app-id', appSecret: 'private-secret', userOpenid: 'scanner-openid' }]);
  while (controller.registrationStatus(started.attemptId).status !== 'connected') await new Promise((resolve) => setImmediate(resolve));
  const status = controller.status();
  assert.equal(status.bots[0].connected, true);
  assert.equal(configs[0].ownerUserOpenid, 'scanner-openid');
  assert.equal(values.get(configs[0].secretRef), 'private-secret');
  assert.equal(runtimeArgs.appSecret, 'private-secret');
  assert.doesNotMatch(JSON.stringify(status), /private-secret|scanner-openid|secretRef/);
  qr.resolve();
});

test('QQ AppID and AppSecret binding stores the secret and accepts the platform visibility scope', async () => {
  const values = new Map();
  const configs = [];
  let runtimeArgs;
  const controller = new QqController({
    qrAuth: { start() { return () => {}; } },
    credentials: {
      resolve: async (ref) => values.has(ref) ? { value: values.get(ref) } : undefined,
      set: async (ref, value) => values.set(ref, value),
      unset: async (ref) => values.delete(ref),
    },
    configStore: {
      list: () => [...configs],
      get: (id) => configs.find((value) => value.botId === id) ?? null,
      getByAppId: (id) => configs.find((value) => value.appId === id) ?? null,
      save: async (value) => { configs.splice(0, configs.length, value); },
      remove: async () => null,
    },
    createRuntime: async (args) => {
      runtimeArgs = args;
      return {
        status: { ready: true, qqConnectionState: 'connected', harnessReachable: true },
        start: async () => {}, stop: async () => {},
      };
    },
  });

  const status = await controller.bindCredentials({ appId: 'manual-app', appSecret: 'manual-secret' });
  assert.equal(status.totals.connected, 1);
  assert.equal(configs[0].ownerUserOpenid, '*');
  assert.equal(values.get(configs[0].secretRef), 'manual-secret');
  assert.equal(runtimeArgs.appSecret, 'manual-secret');
  assert.doesNotMatch(JSON.stringify(status), /manual-secret|ownerUserOpenid|secretRef/);
  await controller.close();
});

test('QQ controller delegates the shared connection-test message to the selected runtime', async () => {
  const config = {
    botId: 'qq_bot', appId: 'app-id', secretRef: 'qq.secret', ownerUserOpenid: 'owner-openid',
  };
  const sent = [];
  const proactiveSends = [];
  const controller = new QqController({
    qrAuth: { start() { return () => {}; } },
    credentials: {
      resolve: async () => ({ value: 'secret' }),
      set: async () => {},
      unset: async () => {},
    },
    configStore: {
      list: () => [config],
      get: (botId) => botId === config.botId ? config : null,
      getByAppId: () => config,
      save: async () => {},
      remove: async () => null,
    },
    createRuntime: async () => ({
      status: { ready: true, qqConnectionState: 'connected', harnessReachable: true },
      start: async () => {},
      stop: async () => {},
      sendConnectionTest: async (text) => sent.push(text),
      sendProactiveText: async (...args) => {
        proactiveSends.push(args);
        return { sent: true };
      },
    }),
  });

  await controller.initialize();
  assert.deepEqual(await controller.sendConnectionTest(config.botId), { sent: true });
  assert.deepEqual(sent, [
    connectionTestMessage(`QQ 机器人（${maskQqAppId(config.appId)}）`),
  ]);
  const target = { kind: 'user', route: { userOpenId: 'user-openid' } };
  assert.deepEqual(await controller.sendProactiveText(config.botId, target, '主动投递'), {
    sent: true,
  });
  assert.deepEqual(proactiveSends, [[target, '主动投递', {}]]);
  await controller.close();
});

test('QQ RPC exposes the pending scan target with its image and strips credential fields', async () => {
  const handler = createQqRpcHandler({
    status: () => ({ bots: [], totals: { configured: 0, connected: 0 } }),
    startProvisioning: async () => ({
      attemptId: 'attempt_1', status: 'pending', verificationUrl: 'https://q.qq.com/opaque',
      appSecret: 'never-public', ownerUserOpenid: 'never-public', expiresAt: Date.now() + 1_000,
    }),
    registrationStatus: () => null,
    cancelProvisioning: async () => ({}),
    bindCredentials: async () => ({ bots: [], totals: { configured: 0, connected: 0 } }),
    reconnectBot: async (botId) => ({
      bots: [{ botId, connected: true }], totals: { configured: 1, connected: 1 },
    }),
    deleteBot: async () => ({}),
  }, { encodeQr: async () => 'data:image/png;base64,YWJjZA==' });
  const result = await handler(QQ_ENDPOINTS.beginProvisioning, { locale: 'zh-CN' });
  assert.equal(result.ok, true);
  assert.equal(result.value.qrCodeDataUrl, 'data:image/png;base64,YWJjZA==');
  assert.equal(result.value.verificationUrl, 'https://q.qq.com/opaque');
  assert.doesNotMatch(JSON.stringify(result), /never-public|ownerUserOpenid|appSecret/);
  const legacyReconnect = await handler(QQ_ENDPOINTS.reconnectBot, {
    botId: 'qq_bot', sendTest: true,
  });
  assert.equal(legacyReconnect.ok, true);
  assert.deepEqual(legacyReconnect.value.testMessage, {
    sent: false, code: 'test-target-unavailable',
  });
});

test('QQ public scan target survives real controller begin, poll and status without credential fields', async t => {
  const target = 'https://q.qq.com/connect?task=original-scan';
  const controller = new QqController({
    qrAuth: { start(callbacks) { queueMicrotask(() => callbacks.onQrDisplayed(target)); return () => {}; } },
    credentials: { resolve: async () => undefined, set: async () => {}, unset: async () => {} },
    configStore: { list: () => [], get: () => null, getByAppId: () => null, save: async () => {}, remove: async () => null },
    createRuntime: async () => { throw new Error('No account is activated by this test'); },
  });
  t.after(() => controller.close());
  const handler = createQqRpcHandler(controller);
  const begun = await handler(QQ_ENDPOINTS.beginProvisioning, {});
  const polled = await handler(QQ_ENDPOINTS.pollProvisioning, { attemptId: begun.value.attemptId });
  const status = await handler(QQ_ENDPOINTS.status, {});
  for (const value of [begun.value, polled.value, status.value.provisioning]) {
    assert.equal(value.verificationUrl, target);
    assert.match(value.qrCodeDataUrl, /^data:image\/png;base64,/);
    assert.doesNotMatch(JSON.stringify(value), /appSecret|ownerUserOpenid|secretRef|device_code|scode/);
  }
  const cancelled = await handler(QQ_ENDPOINTS.cancelProvisioning, { attemptId: begun.value.attemptId });
  assert.equal(cancelled.value.verificationUrl, undefined);
});

test('QQ exposes no terminal, nested or invalid verification target', async () => {
  let attempt = { attemptId: 'attempt_1', status: 'pending', verificationUrl: 'https://q.qq.com/original',
    nested: { verificationUrl: 'https://q.qq.com/another', appSecret: 'private-value' } };
  const handler = createQqRpcHandler({
    status: () => ({ provisioning: attempt, bots: [{ verificationUrl: 'https://q.qq.com/another' }] }),
    startProvisioning: async () => attempt, registrationStatus: () => attempt,
    cancelProvisioning: async () => attempt, bindCredentials: async () => ({}),
    reconnectBot: async () => ({}), deleteBot: async () => ({}),
  }, { encodeQr: async () => 'data:image/png;base64,YWJjZA==' });
  for (const status of ['connected', 'cancelled', 'failed', 'expired']) {
    attempt = { ...attempt, status };
    assert.equal((await handler(QQ_ENDPOINTS.pollProvisioning, { attemptId: 'attempt_1' })).value.verificationUrl, undefined);
  }
  for (const verificationUrl of ['http://q.qq.com/scan', 'https://user:pass@q.qq.com/scan',
    'https://q.qq.com/white space', 'https://q.qq.com/' + 'a'.repeat(4096), 'not-a-url']) {
    attempt = { ...attempt, status: 'pending', verificationUrl };
    assert.equal((await handler(QQ_ENDPOINTS.beginProvisioning, {})).value.verificationUrl, undefined);
  }
  attempt = { ...attempt, status: 'refreshing', verificationUrl: 'https://q.qq.com/refreshed' };
  const snapshot = (await handler(QQ_ENDPOINTS.status, {})).value;
  assert.equal(snapshot.provisioning.verificationUrl, attempt.verificationUrl);
  assert.deepEqual(snapshot.provisioning.nested, {});
  assert.deepEqual(snapshot.bots, [{}]);
});

test('QQ credential RPC validates the pair and never returns AppSecret', async () => {
  let received;
  const handler = createQqRpcHandler({
    status: () => ({ bots: [], totals: { configured: 0, connected: 0 } }),
    startProvisioning: async () => ({}), registrationStatus: () => null,
    cancelProvisioning: async () => ({}), reconnectBot: async () => ({}), deleteBot: async () => ({}),
    bindCredentials: async (payload) => {
      received = payload;
      return { bots: [], totals: { configured: 0, connected: 0 }, appSecret: payload.appSecret };
    },
  });
  const result = await handler(QQ_ENDPOINTS.bindCredentials, {
    appId: 'manual-app', appSecret: 'manual-secret',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(received, { appId: 'manual-app', appSecret: 'manual-secret' });
  assert.doesNotMatch(JSON.stringify(result), /manual-secret|appSecret/);
  assert.equal((await handler(QQ_ENDPOINTS.bindCredentials, { appId: 'manual-app' })).ok, false);
});

test('QQ reconnect RPC reports test-message outcomes without discarding the snapshot', async () => {
  const calls = [];
  let sendError = null;
  let connected = true;
  const handler = createQqRpcHandler({
    status: () => ({ bots: [], totals: { configured: 0, connected: 0 } }),
    startProvisioning: async () => ({}),
    registrationStatus: () => null,
    cancelProvisioning: async () => ({}),
    bindCredentials: async () => ({}),
    reconnectBot: async (botId) => {
      calls.push(['reconnect', botId]);
      return {
        revision: 7,
        bots: [{ botId, connected, bot: { name: 'QQ机器人' } }],
        totals: { configured: 1, connected: connected ? 1 : 0 },
      };
    },
    sendConnectionTest: async (botId) => {
      calls.push(['test', botId]);
      if (sendError) throw sendError;
      return { sent: true };
    },
    deleteBot: async () => ({}),
  });

  const success = await handler(QQ_ENDPOINTS.reconnectBot, { botId: 'qq_bot', sendTest: true });
  assert.equal(success.ok, true);
  assert.equal(success.value.revision, 7);
  assert.deepEqual(success.value.testMessage, { sent: true });
  assert.deepEqual(calls, [['reconnect', 'qq_bot'], ['test', 'qq_bot']]);

  sendError = Object.assign(new Error('no recent target'), { code: 'test-target-unavailable' });
  const unavailable = await handler(QQ_ENDPOINTS.reconnectBot, {
    botId: 'qq_bot', sendTest: true,
  });
  assert.equal(unavailable.ok, true);
  assert.equal(unavailable.value.bots[0].connected, true);
  assert.deepEqual(unavailable.value.testMessage, {
    sent: false, code: 'test-target-unavailable',
  });

  sendError = new Error('QQ API rejected the message');
  const failed = await handler(QQ_ENDPOINTS.reconnectBot, { botId: 'qq_bot', sendTest: true });
  assert.equal(failed.ok, true);
  assertTestMessageFailure(failed.value.testMessage);

  calls.length = 0;
  connected = false;
  sendError = null;
  const offline = await handler(QQ_ENDPOINTS.reconnectBot, { botId: 'qq_bot', sendTest: true });
  assert.equal(offline.ok, true);
  assert.deepEqual(offline.value.testMessage, {
    sent: false, code: 'test-target-unavailable',
  });
  assert.deepEqual(calls, [['reconnect', 'qq_bot']]);

  calls.length = 0;
  connected = true;
  const reconnectOnly = await handler(QQ_ENDPOINTS.reconnectBot, { botId: 'qq_bot' });
  assert.equal(reconnectOnly.ok, true);
  assert.equal(reconnectOnly.value.testMessage, undefined);
  assert.deepEqual(calls, [['reconnect', 'qq_bot']]);
  assert.equal((await handler(QQ_ENDPOINTS.reconnectBot, {
    botId: 'qq_bot', sendTest: false,
  })).ok, false);
});
