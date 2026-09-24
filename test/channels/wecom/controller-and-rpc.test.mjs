import { assertTestMessageFailure } from '../../fixtures/connection-diagnostics.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { WecomController } from '../../../src/channels/wecom/wecom-controller.mjs';
import {
  createWecomRpcHandler,
  WECOM_ENDPOINTS,
} from '../../../plugin-src/host/channels/wecom/rpc.mjs';

test('Enterprise WeChat QR success stores Secret off-config and starts its runtime', async () => {
  const values = new Map();
  const configs = [];
  let runtimeArgs;
  const controller = new WecomController({
    qrAuth: {
      start: async () => ({
        scode: 'host-only-code',
        verificationUrl: 'https://work.weixin.qq.com/ai/qc/auth?ticket=opaque',
        expiresAt: Date.now() + 10_000,
        pollIntervalMs: 500,
      }),
      poll: async () => ({ status: 'success', remoteBotId: 'remote-bot', secret: 'private-secret' }),
    },
    credentials: {
      resolve: async (ref) => values.has(ref) ? { value: values.get(ref) } : undefined,
      set: async (ref, value) => values.set(ref, value),
      unset: async (ref) => values.delete(ref),
    },
    configStore: {
      list: () => [...configs],
      get: (id) => configs.find((value) => value.botId === id) ?? null,
      getByRemoteBotId: (id) => configs.find((value) => value.remoteBotId === id) ?? null,
      save: async (value) => { configs.splice(0, configs.length, value); },
      remove: async () => null,
    },
    createRuntime: async (args) => {
      runtimeArgs = args;
      return {
        status: { ready: true, wecomConnectionState: 'connected', harnessReachable: true },
        start: async () => {},
        stop: async () => {},
      };
    },
  });
  const started = await controller.startProvisioning();
  const completed = await controller.registrationStatus(started.attemptId);
  assert.equal(completed.status, 'connected');
  const status = controller.status();
  assert.equal(status.bots[0].connected, true);
  assert.equal(values.get(configs[0].secretRef), 'private-secret');
  assert.equal(runtimeArgs.secret, 'private-secret');
  assert.doesNotMatch(JSON.stringify(status), /private-secret|secretRef|remote-bot|host-only-code/);
});

test('Enterprise WeChat Bot ID and Secret binding stores credentials and starts its runtime', async () => {
  const values = new Map();
  const configs = [];
  let runtimeArgs;
  let connectionTestText;
  const proactiveSends = [];
  const controller = new WecomController({
    qrAuth: { start: async () => ({}), poll: async () => ({ status: 'waiting' }) },
    credentials: {
      resolve: async (ref) => values.has(ref) ? { value: values.get(ref) } : undefined,
      set: async (ref, value) => values.set(ref, value),
      unset: async (ref) => values.delete(ref),
    },
    configStore: {
      list: () => [...configs],
      get: (id) => configs.find((value) => value.botId === id) ?? null,
      getByRemoteBotId: (id) => configs.find((value) => value.remoteBotId === id) ?? null,
      save: async (value) => { configs.splice(0, configs.length, value); },
      remove: async () => null,
    },
    createRuntime: async (args) => {
      runtimeArgs = args;
      return {
        status: { ready: true, wecomConnectionState: 'connected', harnessReachable: true },
        start: async () => {}, stop: async () => {},
        sendConnectionTest: async (text) => { connectionTestText = text; },
        sendProactiveText: async (...args) => {
          proactiveSends.push(args);
          return { sent: true };
        },
      };
    },
  });
  const status = await controller.bindCredentials({ botId: 'remote-manual', secret: 'manual-secret' });
  assert.equal(status.totals.connected, 1);
  assert.equal(values.get(configs[0].secretRef), 'manual-secret');
  assert.equal(runtimeArgs.secret, 'manual-secret');
  assert.doesNotMatch(JSON.stringify(status), /manual-secret|remote-manual|secretRef/);
  await controller.sendConnectionTest(status.bots[0].botId);
  assert.match(connectionTestText, /DeepSeek Harness 连接测试成功/);
  assert.match(connectionTestText, /企业微信机器人（remote••••nual）/);
  const target = { kind: 'group', route: { chatId: 'group-target' } };
  assert.deepEqual(await controller.sendProactiveText(status.bots[0].botId, target, '主动投递'), {
    sent: true,
  });
  assert.deepEqual(proactiveSends, [[target, '主动投递', {}]]);
  await controller.close();
});

test('Enterprise WeChat RPC encodes the QR on Host and strips every authorization field', async () => {
  const handler = createWecomRpcHandler({
    status: () => ({ bots: [], totals: { configured: 0, connected: 0 } }),
    startProvisioning: async () => ({
      attemptId: 'attempt_1',
      status: 'pending',
      verificationUrl: 'https://work.weixin.qq.com/ai/qc/auth?ticket=opaque',
      scode: 'never-public',
      secret: 'never-public',
      remoteBotId: 'never-public',
      expiresAt: Date.now() + 1_000,
    }),
    registrationStatus: async () => null,
    cancelProvisioning: async () => ({}),
    bindCredentials: async () => ({ bots: [], totals: { configured: 0, connected: 0 } }),
    reconnectBot: async () => ({}),
    sendConnectionTest: async () => ({ sent: true }),
    deleteBot: async () => ({}),
  }, { encodeQr: async () => 'data:image/png;base64,YWJjZA==' });
  const result = await handler(WECOM_ENDPOINTS.beginProvisioning, { locale: 'zh-CN' });
  assert.equal(result.ok, true);
  assert.equal(result.value.qrCodeDataUrl, 'data:image/png;base64,YWJjZA==');
  assert.doesNotMatch(JSON.stringify(result), /work\.weixin|never-public|remoteBotId|scode|secret/);
});

test('Enterprise WeChat credential RPC accepts official Bot ID fields and redacts Secret', async () => {
  let received;
  const handler = createWecomRpcHandler({
    status: () => ({ bots: [], totals: { configured: 0, connected: 0 } }),
    startProvisioning: async () => ({}), registrationStatus: async () => null,
    cancelProvisioning: async () => ({}), reconnectBot: async () => ({}),
    sendConnectionTest: async () => ({ sent: true }), deleteBot: async () => ({}),
    bindCredentials: async (payload) => {
      received = payload;
      return { bots: [], totals: { configured: 0, connected: 0 }, secret: payload.secret };
    },
  });
  const result = await handler(WECOM_ENDPOINTS.bindCredentials, {
    botId: 'remote-manual', secret: 'manual-secret',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(received, { botId: 'remote-manual', secret: 'manual-secret' });
  assert.doesNotMatch(JSON.stringify(result), /manual-secret|"secret"/);
  assert.equal((await handler(WECOM_ENDPOINTS.bindCredentials, { botId: 'remote-manual' })).ok, false);
});

test('Enterprise WeChat reconnect optionally sends a test message without changing connection success', async () => {
  const sent = [];
  const base = {
    status: () => ({ bots: [] }),
    startProvisioning: async () => ({}), registrationStatus: async () => null,
    cancelProvisioning: async () => ({}), bindCredentials: async () => ({}),
    deleteBot: async () => ({}),
  };
  const connected = {
    bots: [{ botId: 'wecom_bot', connected: true }],
    totals: { configured: 1, connected: 1 },
  };
  const handler = createWecomRpcHandler({
    ...base,
    reconnectBot: async () => connected,
    sendConnectionTest: async (botId) => { sent.push(botId); },
  });

  const success = await handler(WECOM_ENDPOINTS.reconnectBot, {
    botId: 'wecom_bot', sendTest: true,
  });
  assert.equal(success.ok, true);
  assert.deepEqual(success.value.testMessage, { sent: true });
  assert.deepEqual(sent, ['wecom_bot']);

  const failedSend = await createWecomRpcHandler({
    ...base,
    reconnectBot: async () => connected,
    sendConnectionTest: async () => { throw new Error('provider rejected'); },
  })(WECOM_ENDPOINTS.reconnectBot, { botId: 'wecom_bot', sendTest: true });
  assert.equal(failedSend.ok, true);
  assertTestMessageFailure(failedSend.value.testMessage);

  let offlineSendCalled = false;
  const offline = await createWecomRpcHandler({
    ...base,
    reconnectBot: async () => ({
      bots: [{ botId: 'wecom_bot', connected: false }],
      totals: { configured: 1, connected: 0 },
    }),
    sendConnectionTest: async () => { offlineSendCalled = true; },
  })(WECOM_ENDPOINTS.reconnectBot, { botId: 'wecom_bot', sendTest: true });
  assert.equal(offline.ok, true);
  assert.deepEqual(offline.value.testMessage, {
    sent: false, code: 'test-target-unavailable',
  });
  assert.equal(offlineSendCalled, false);
  const missingMethod = await createWecomRpcHandler({
    ...base,
    reconnectBot: async () => connected,
  })(WECOM_ENDPOINTS.reconnectBot, { botId: 'wecom_bot', sendTest: true });
  assert.equal(missingMethod.ok, true);
  assert.deepEqual(missingMethod.value.testMessage, {
    sent: false, code: 'test-target-unavailable',
  });
  assert.equal((await handler(WECOM_ENDPOINTS.reconnectBot, {
    botId: 'wecom_bot', sendTest: false,
  })).ok, false);
});
