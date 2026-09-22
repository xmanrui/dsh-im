import { assertTestMessageFailure } from '../../fixtures/connection-diagnostics.mjs';
import { managementFetch } from '../../fixtures/management-rpc.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DINGTALK_ENDPOINTS,
  createDingtalkRpcHandler,
  installDingtalkRpc,
} from '../../../plugin-src/host/channels/dingtalk/rpc.mjs';
import { dingtalkPublicConnectionError } from '../../../src/channels/dingtalk/connection-error.mjs';

function controller(overrides = {}) {
  return {
    status: async () => ({ bots: [] }),
    startProvisioning: async () => ({
      attemptId: 'attempt_1',
      status: 'pending',
      verificationUrl: 'https://open-dev.dingtalk.com/registration',
      deviceCode: 'must-not-leak',
      secretRef: 'must-not-leak',
    }),
    registrationStatus: async () => ({ attemptId: 'attempt_1', status: 'pending' }),
    cancelProvisioning: async () => ({ attemptId: 'attempt_1', status: 'cancelled' }),
    bindCredentials: async () => ({ bots: [] }),
    reconnectBot: async () => ({ bots: [] }),
    sendConnectionTest: async () => ({ sent: true }),
    deleteBot: async () => ({ bots: [] }),
    approveSender: async () => ({ bots: [] }),
    revokeSender: async () => ({ bots: [] }),
    ...overrides,
  };
}

test('RPC encodes QR on the Host and strips all credential material', async () => {
  const handler = createDingtalkRpcHandler(controller(), {
    encodeQr: async (url) => `data:image/png;base64,${Buffer.from(url).toString('base64')}`,
  });

  const result = await handler(DINGTALK_ENDPOINTS.beginProvisioning, { locale: 'zh-CN' });

  assert.equal(result.ok, true);
  assert.match(result.value.qrCodeDataUrl, /^data:image\/png;base64,/);
  assert.equal('verificationUrl' in result.value, false);
  assert.equal('deviceCode' in result.value, false);
  assert.equal('secretRef' in result.value, false);
});

test('status re-encodes an active QR without exposing its authorization URL', async () => {
  const handler = createDingtalkRpcHandler(controller({
    status: async () => ({
      bots: [],
      provisioning: {
        attemptId: 'attempt_1',
        status: 'pending',
        verificationUrl: 'https://open-dev.dingtalk.com/registration',
      },
    }),
  }), {
    encodeQr: async () => 'data:image/png;base64,AAAA',
  });

  const result = await handler(DINGTALK_ENDPOINTS.status, {});

  assert.equal(result.ok, true);
  assert.equal(result.value.provisioning.qrCodeDataUrl, 'data:image/png;base64,AAAA');
  assert.equal('verificationUrl' in result.value.provisioning, false);
});

test('RPC validates mutating requests before invoking the controller', async () => {
  let calls = 0;
  const handler = createDingtalkRpcHandler(controller({
    approveSender: async () => { calls += 1; },
  }));

  const rejected = await handler(DINGTALK_ENDPOINTS.approveSender, {
    botId: 'dt_abc', requestId: 'request_1', confirm: false,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'bad-request');
  assert.equal(calls, 0);
});

test('credential RPC accepts Client ID fields while keeping Client Secret host-only', async () => {
  let received;
  const handler = createDingtalkRpcHandler(controller({
    bindCredentials: async (payload) => {
      received = payload;
      return { bots: [], clientSecret: payload.clientSecret };
    },
  }));

  const result = await handler(DINGTALK_ENDPOINTS.bindCredentials, {
    clientId: 'manual-client', clientSecret: 'manual-secret',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(received, { clientId: 'manual-client', clientSecret: 'manual-secret' });
  assert.doesNotMatch(JSON.stringify(result), /manual-secret|clientSecret/);
  assert.equal((await handler(DINGTALK_ENDPOINTS.bindCredentials, { clientId: 'manual-client' })).ok, false);
});

test('RPC returns only the safe connection diagnostic projection', async () => {
  const cause = new Error('request body contains clientSecret=must-not-leak');
  const publicError = {
    code: 'stream-proxy-dependency-incompatible',
    message: '钉钉 Stream 连接失败。',
    hint: '请修复代理依赖后重试。',
    referenceId: 'DT-CONN-DEADBEEF',
  };
  const handler = createDingtalkRpcHandler(controller({
    reconnectBot: async () => {
      throw dingtalkPublicConnectionError(publicError, cause);
    },
  }));

  const result = await handler(DINGTALK_ENDPOINTS.reconnectBot, {
    botId: 'dt_abc', sendTest: true,
  });

  assert.equal(result.error.details.stage, 'connection.start');
  assert.equal(result.error.details.referenceId, publicError.referenceId);
  const { details, ...legacyError } = result.error;
  assert.deepEqual({ ...result, error: legacyError }, { ok: false, error: publicError });
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak|clientSecret|cause/);
});

test('RPC honors an explicit loopback-only restriction', async () => {
  const registrations = [];
  const dispose = () => {};
  const ctx = {
    connection: {
      fetch: managementFetch((...args) => {
        registrations.push(args);
        return dispose;
      }),
    },
  };

  assert.equal(installDingtalkRpc(ctx, controller(), undefined, 'loopback'), dispose);
  assert.equal(registrations[0][0], '/dingtalk');
  assert.equal(registrations[0][2].path, '/api/dsh-im/dingtalk');
  await assert.rejects(registrations[0][1]('connection.status', {}, undefined, { host: 'remote.example' }), /HTTP 403/);
});

test('reconnect sends a DingTalk test message only for a connected bot and isolates send failures', async () => {
  const sent = [];
  const connectedSnapshot = {
    bots: [{ botId: 'dt_abc', connected: true }],
    totals: { configured: 1, connected: 1 },
  };
  const success = await createDingtalkRpcHandler(controller({
    reconnectBot: async () => connectedSnapshot,
    sendConnectionTest: async (botId) => { sent.push(botId); },
  }))(DINGTALK_ENDPOINTS.reconnectBot, { botId: 'dt_abc', sendTest: true });
  assert.equal(success.ok, true);
  assert.deepEqual(success.value.testMessage, { sent: true });
  assert.deepEqual(sent, ['dt_abc']);

  const failedSend = await createDingtalkRpcHandler(controller({
    reconnectBot: async () => connectedSnapshot,
    sendConnectionTest: async () => { throw new Error('expired webhook'); },
  }))(DINGTALK_ENDPOINTS.reconnectBot, { botId: 'dt_abc', sendTest: true });
  assert.equal(failedSend.ok, true);
  assertTestMessageFailure(failedSend.value.testMessage);

  let offlineSendCalled = false;
  const offline = await createDingtalkRpcHandler(controller({
    reconnectBot: async () => ({
      bots: [{ botId: 'dt_abc', connected: false }],
      totals: { configured: 1, connected: 0 },
    }),
    sendConnectionTest: async () => { offlineSendCalled = true; },
  }))(DINGTALK_ENDPOINTS.reconnectBot, { botId: 'dt_abc', sendTest: true });
  assert.equal(offline.ok, true);
  assert.deepEqual(offline.value.testMessage, {
    sent: false, code: 'test-target-unavailable',
  });
  assert.equal(offlineSendCalled, false);
  const withoutMethod = controller({ reconnectBot: async () => connectedSnapshot });
  delete withoutMethod.sendConnectionTest;
  const unavailableWithoutMethod = await createDingtalkRpcHandler(withoutMethod)(
    DINGTALK_ENDPOINTS.reconnectBot,
    { botId: 'dt_abc', sendTest: true },
  );
  assert.equal(unavailableWithoutMethod.ok, true);
  assert.deepEqual(unavailableWithoutMethod.value.testMessage, {
    sent: false, code: 'test-target-unavailable',
  });
  assert.equal((await createDingtalkRpcHandler(controller())(
    DINGTALK_ENDPOINTS.reconnectBot,
    { botId: 'dt_abc', sendTest: false },
  )).ok, false);
});
