import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FEISHU_ENDPOINTS,
  normalizeBotsSnapshot,
  normalizeConnectionSnapshot,
  normalizePollResult,
  normalizeProvisioning,
  presentError,
  reconnectBot,
  retryConnection,
  screenFromSnapshot,
  unwrapRpcResult,
} from '../../../plugin-src/client/channels/feishu/api.js';

test('multi-bot endpoints are bot-scoped and keep legacy operations separate', () => {
  assert.equal(FEISHU_ENDPOINTS.beginCallbackRepair, 'bot.callback-repair.begin');
  assert.equal(FEISHU_ENDPOINTS.beginGroupMessagePermission, 'bot.group-message-permission.begin');
  assert.equal(FEISHU_ENDPOINTS.reconnectBot, 'bot.reconnect');
  assert.equal(FEISHU_ENDPOINTS.disconnectBot, 'bot.disconnect');
  assert.equal(FEISHU_ENDPOINTS.deleteBot, 'bot.delete');
  assert.equal(FEISHU_ENDPOINTS.setGroupResponseMode, 'bot.group-response-mode.set');
  assert.equal(FEISHU_ENDPOINTS.setGroupTopicReply, 'bot.group-topic-reply.set');
  assert.equal(FEISHU_ENDPOINTS.setStepPush, 'bot.step-push.set');
  assert.equal(FEISHU_ENDPOINTS.testConnection, 'connection.test');
});

test('client normalizes multiple independent bots and derives authoritative totals', () => {
  const snapshot = normalizeBotsSnapshot({
    schemaVersion: 2,
    revision: 9,
    totals: { configured: 99, connected: 99 },
    bots: [
      {
        botId: 'bot-a',
        state: 'connected',
        connected: true,
        configured: true,
        groupResponseMode: 'all',
        groupTopicReply: true,
        stepPush: true,
        groupMessagePermissionGranted: true,
        bot: {
          name: '销售助手',
          appIdMasked: 'cli_aaaa••••1111',
          domain: 'feishu',
          clientSecret: 'must-not-leak',
        },
        health: { status: 'healthy', summary: '长连接运行正常' },
      },
      {
        botId: 'bot-b',
        // A stale state label must not make an offline bot appear connected.
        state: 'connected',
        connected: false,
        configured: true,
        groupTopicReply: 'stale-truthy', // must normalize to false
        stepPush: 'stale-truthy', // must normalize to false
        bot: { name: '研发助手', domain: 'lark' },
        health: { status: 'offline', summary: '等待重连' },
        error: { code: 'connection_failed', message: '连接失败' },
      },
    ],
  });

  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.revision, 9);
  assert.deepEqual(snapshot.totals, { configured: 2, connected: 1 });
  assert.equal(snapshot.bots[0].state, 'connected');
  assert.equal(snapshot.bots[0].groupResponseMode, 'all');
  assert.equal(snapshot.bots[0].groupTopicReply, true);
  assert.equal(snapshot.bots[0].stepPush, true);
  assert.equal(snapshot.bots[0].groupMessagePermissionGranted, true);
  assert.equal(snapshot.bots[1].groupResponseMode, 'mention');
  assert.equal(snapshot.bots[1].groupTopicReply, false);
  assert.equal(snapshot.bots[1].stepPush, false);
  assert.equal(snapshot.bots[1].groupMessagePermissionGranted, false);
  assert.equal(snapshot.bots[1].state, 'connecting');
  assert.equal(snapshot.bots[1].bot.domain, 'lark');
  assert.equal(snapshot.bots[1].error.message, '连接失败');
  assert.equal('clientSecret' in snapshot.bots[0].bot, false);
});

test('multi-bot snapshot rejects entries without an opaque botId', () => {
  assert.throws(
    () => normalizeBotsSnapshot({ schemaVersion: 2, bots: [{ connected: true }] }),
    /botId/,
  );
});

test('provision polling preserves the newly connected botId', () => {
  assert.deepEqual(normalizePollResult({
    status: 'connected',
    botId: 'bot-new',
  }), {
    status: 'connected',
    operation: 'provision',
    botId: 'bot-new',
    message: undefined,
    connection: undefined,
    provisioning: undefined,
  });
});

test('reconnect helper scopes the mutation to one bot before refreshing the list', async () => {
  const calls = [];
  const status = { schemaVersion: 2, bots: [] };
  const value = await reconnectBot(async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    return endpoint === 'connection.status' ? status : { accepted: true };
  }, 'bot-a');

  assert.deepEqual(calls, [
    { endpoint: 'bot.reconnect', payload: { botId: 'bot-a' } },
    { endpoint: 'connection.status', payload: {} },
  ]);
  assert.equal(value, status);
});

test('client only shows connected when the Host confirms connected=true', () => {
  assert.equal(normalizeConnectionSnapshot({
    state: 'connected',
    connected: false,
  }).state, 'connecting');
  assert.equal(normalizeConnectionSnapshot({
    state: 'connecting',
    connected: true,
  }).state, 'connected');
});

test('client accepts a Host-rendered QR code without exposing credentials', () => {
  const provisioning = normalizeProvisioning({
    attemptId: '7',
    verificationUrl: 'https://accounts.feishu.cn/device',
    qrCodeDataUrl: 'data:image/png;base64,AAAA',
    expiresAt: 100_000,
    pollIntervalMs: 1_800,
  }, 1_000);

  assert.equal(provisioning.attemptId, '7');
  assert.equal(provisioning.qrCodeDataUrl, 'data:image/png;base64,AAAA');
  assert.equal('clientSecret' in provisioning, false);
});

test('client preserves callback repair identity across QR and poll projections', () => {
  const provisioning = normalizeProvisioning({
    attemptId: 'reg_repair',
    operation: 'callback_repair',
    botId: 'bot_target',
    verificationUrl: 'https://accounts.feishu.cn/device?tp=sdk&clientID=cli_target',
    qrCodeDataUrl: 'data:image/png;base64,AAAA',
  });
  assert.equal(provisioning.operation, 'callback_repair');
  assert.equal(provisioning.botId, 'bot_target');

  const poll = normalizePollResult({
    status: 'connecting',
    operation: 'callback_repair',
    botId: 'bot_target',
  });
  assert.equal(poll.operation, 'callback_repair');
  assert.equal(poll.botId, 'bot_target');
  assert.throws(() => normalizeProvisioning({
    attemptId: 'reg_broken',
    operation: 'callback_repair',
    verificationUrl: 'https://accounts.feishu.cn/device',
  }), /botId/);
});

test('client restores a submitted callback repair without requiring an expired QR URL', () => {
  const provisioning = normalizeProvisioning({
    attemptId: 'reg_committed',
    operation: 'callback_repair',
    botId: 'bot_target',
    submitted: true,
    pollIntervalMs: 800,
  });
  assert.equal(provisioning.attemptId, 'reg_committed');
  assert.equal(provisioning.operation, 'callback_repair');
  assert.equal(provisioning.botId, 'bot_target');
  assert.equal(provisioning.submitted, true);
  assert.equal(provisioning.verificationUrl, undefined);
  assert.equal(provisioning.qrCodeDataUrl, undefined);
});

test('client preserves group-message permission identity across QR and poll projections', () => {
  const provisioning = normalizeProvisioning({
    attemptId: 'reg_group_permission',
    operation: 'group_message_permission',
    botId: 'bot_target',
    verificationUrl: 'https://open.feishu.cn/page/launcher?tp=sdk&clientID=cli_target&addons=x',
    qrCodeDataUrl: 'data:image/png;base64,AAAA',
  });
  assert.equal(provisioning.operation, 'group_message_permission');
  assert.equal(provisioning.botId, 'bot_target');

  const poll = normalizePollResult({
    status: 'connecting',
    operation: 'group_message_permission',
    botId: 'bot_target',
  });
  assert.equal(poll.operation, 'group_message_permission');
  assert.equal(poll.botId, 'bot_target');
  assert.throws(() => normalizeProvisioning({
    attemptId: 'reg_broken_permission',
    operation: 'group_message_permission',
    verificationUrl: 'https://open.feishu.cn/page/launcher?tp=sdk&clientID=cli_target&addons=x',
  }), /botId/);
});

test('client unwraps RpcResult and redacts credential-shaped error text', () => {
  assert.deepEqual(unwrapRpcResult({ ok: true, value: { connected: true } }), {
    connected: true,
  });
  assert.throws(
    () => unwrapRpcResult({
      ok: false,
      error: { code: 'internal', message: 'failed' },
    }),
    /failed/,
  );
  assert.doesNotMatch(
    presentError(new Error('app_secret=do-not-show token=also-hidden')).message,
    /do-not-show|also-hidden/,
  );
});

test('configured offline and startup errors never become the create screen', () => {
  const offline = normalizeConnectionSnapshot({
    state: 'disconnected',
    connected: false,
    configured: true,
    bot: { name: '北汇星河助手' },
    health: { status: 'offline', summary: '长连接已断开' },
  });
  assert.equal(offline.configured, true);
  assert.equal(screenFromSnapshot(offline).phase, 'offline');

  const failed = screenFromSnapshot(normalizeConnectionSnapshot({
    state: 'error',
    connected: false,
    configured: true,
    error: { message: '启动失败' },
  }));
  assert.equal(failed.phase, 'error');
  assert.equal(failed.retry, 'test');
  assert.equal(failed.configured, true);

  const failedBeforeConfiguration = screenFromSnapshot(normalizeConnectionSnapshot({
    state: 'error',
    connected: false,
    configured: false,
    error: { message: '二维码已过期' },
  }));
  assert.equal(failedBeforeConfiguration.phase, 'error');
  assert.equal(failedBeforeConfiguration.retry, 'begin');

  const fresh = screenFromSnapshot(normalizeConnectionSnapshot({
    state: 'disconnected',
    connected: false,
    configured: false,
  }));
  assert.deepEqual(fresh, { phase: 'disconnected', configured: false });
});

test('retry connection calls connection.test before authoritative connection.status', async () => {
  const calls = [];
  const status = { state: 'connected', connected: true, configured: true };
  const value = await retryConnection(async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    return endpoint === 'connection.status' ? status : { accepted: true };
  });

  assert.deepEqual(calls, [
    { endpoint: 'connection.test', payload: {} },
    { endpoint: 'connection.status', payload: {} },
  ]);
  assert.equal(value, status);
});
