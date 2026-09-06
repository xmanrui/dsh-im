import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  FEISHU_APP_ID_REF,
  FEISHU_APP_SECRET_REF,
  FEISHU_ENDPOINTS,
  FEISHU_MULTI_ENDPOINTS,
  apply,
  createDshCredentialStore,
  createProductionController,
  createProvisioningBackedController,
} from '../../../plugin-src/host/channels/feishu/index.mjs';

const signal = () => new AbortController().signal;

function status(overrides = {}) {
  return {
    phase: 'unconfigured',
    connected: false,
    configured: false,
    bot: null,
    registration: { state: 'idle', attempt: 0, updatedAt: 100 },
    connection: {
      ready: false,
      feishuLongConnectionState: 'idle',
      harnessReachable: false,
    },
    error: null,
    ...overrides,
  };
}

async function rpcFixture(controller) {
  let registration;
  let disposed = false;
  const ctx = {
    connection: {
      rpc: {
        handle(channel, handler, options) {
          registration = { channel, handler, options };
          return async () => { disposed = true; };
        },
      },
    },
  };
  const dispose = await apply(ctx, { controller });
  return {
    dispose,
    get registration() { return registration; },
    get disposed() { return disposed; },
  };
}

test('Host plugin registers the real rc.6 Connection RPC shape as loopback-only', async () => {
  const controller = {
    status: async () => status(),
    startRegistration: async () => status(),
    cancelRegistration: async () => status(),
    disconnect: async () => status(),
  };
  const fx = await rpcFixture(controller);

  assert.equal(fx.registration.channel, '/feishu');
  assert.deepEqual(fx.registration.options, { authority: 'loopback' });
  const result = await fx.registration.handler(FEISHU_ENDPOINTS.status, {}, signal());
  assert.equal(result.ok, true);
  assert.equal(result.value.state, 'disconnected');
  assert.equal(result.value.connected, false);
  assert.equal(result.value.configured, false);
  assert.equal(result.value.bot.name, '飞书机器人');
  assert.equal(result.value.health.status, 'offline');
  assert.equal('registration' in result.value, false);

  await fx.dispose();
  assert.equal(fx.disposed, true);
});

test('Host exposes configured offline as a redacted capability fact', async () => {
  const secret = 'offline-secret-must-stay-host-only';
  const controller = {
    status: async () => status({
      phase: 'disconnected',
      configured: true,
      bot: { name: '北汇星河助手', appSecret: secret },
      credentials: { client_secret: secret },
      connection: {
        ready: false,
        feishuLongConnectionState: 'failed',
        harnessReachable: true,
        token: secret,
      },
    }),
    startRegistration: async () => status(),
    cancelRegistration: async () => status(),
    reconnect: async () => status({ configured: true }),
    disconnect: async () => status(),
  };
  const fx = await rpcFixture(controller);
  const result = await fx.registration.handler(FEISHU_ENDPOINTS.status, {}, signal());

  assert.equal(result.ok, true);
  assert.equal(result.value.state, 'disconnected');
  assert.equal(result.value.connected, false);
  assert.equal(result.value.configured, true);
  assert.equal(result.value.health.status, 'offline');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  assert.equal('credentials' in result.value, false);
});

test('Host exposes only browser-safe Agent Preset fields in status and update responses', async () => {
  let selectedPreset = 'marketing-jeep';
  const calls = [];
  const current = () => status({
    schemaVersion: 2,
    revision: 3,
    configured: true,
    agentPresetCatalog: {
      defaultId: 'standard',
      root: 'private-preset-root',
      failures: [{ message: 'private-catalog-failure' }],
      items: [
        {
          id: 'standard',
          name: 'Standard',
          path: 'private-standard-path',
          trust: 'private-trust-level',
        },
        {
          id: 'marketing-jeep',
          label: '营销吉普',
          error: { message: 'private-preset-error' },
        },
        {
          id: 'broken-preset',
          label: 'Broken',
          broken: { message: 'private-broken-reason' },
        },
        { id: 'INVALID', label: 'invalid-item-must-be-filtered' },
        { id: 'standard', label: 'duplicate-item-must-be-filtered' },
      ],
    },
    bots: [{
      botId: 'bot_safe',
      phase: 'connected',
      connected: true,
      configured: true,
      agentPreset: selectedPreset,
      bot: { name: '安全机器人', domain: 'feishu' },
      connection: {
        ready: true,
        feishuLongConnectionState: 'connected',
        harnessReachable: true,
      },
    }],
  });
  const controller = {
    status: async () => current(),
    startRegistration: async () => current(),
    cancelRegistration: async () => current(),
    disconnect: async () => status(),
    updateAgentPreset: async (botId, agentPreset) => {
      calls.push({ botId, agentPreset });
      selectedPreset = agentPreset;
      return current();
    },
  };
  const fx = await rpcFixture(controller);

  const listed = await fx.registration.handler(FEISHU_ENDPOINTS.status, {}, signal());
  assert.equal(listed.ok, true);
  assert.equal(listed.value.bots[0].agentPreset, 'marketing-jeep');
  assert.deepEqual(listed.value.agentPresetCatalog, {
    defaultId: 'standard',
    items: [
      { id: 'standard', label: 'Standard' },
      { id: 'marketing-jeep', label: '营销吉普' },
    ],
  });
  assert.doesNotMatch(
    JSON.stringify(listed),
    /private-preset-root|private-catalog-failure|private-standard-path|private-trust-level|private-preset-error|private-broken-reason|invalid-item|duplicate-item/,
  );

  const cleared = await fx.registration.handler(
    FEISHU_ENDPOINTS.setAgentPreset,
    { botId: 'bot_safe', agentPreset: null },
    signal(),
  );
  assert.equal(cleared.ok, true);
  assert.deepEqual(calls, [{ botId: 'bot_safe', agentPreset: null }]);
  assert.equal(cleared.value.bots[0].agentPreset, null);
  assert.deepEqual(cleared.value.agentPresetCatalog, listed.value.agentPresetCatalog);
  assert.doesNotMatch(JSON.stringify(cleared), /private-|invalid-item|duplicate-item/);

  await fx.dispose();
});

test('Host validates and updates the Feishu group response mode', async () => {
  let mode = 'mention';
  const current = () => status({
    schemaVersion: 2,
    revision: 4,
    configured: true,
    bots: [{
      botId: 'bot_mode',
      phase: 'connected',
      connected: true,
      configured: true,
      groupResponseMode: mode,
      bot: { name: '模式机器人', domain: 'feishu' },
      connection: {
        ready: true,
        feishuLongConnectionState: 'connected',
        harnessReachable: true,
      },
    }],
  });
  const controller = {
    status: async () => current(),
    startRegistration: async () => current(),
    cancelRegistration: async () => current(),
    disconnect: async () => status(),
    updateGroupResponseMode: async (botId, value) => {
      assert.equal(botId, 'bot_mode');
      mode = value;
      return current();
    },
  };
  const fx = await rpcFixture(controller);

  const updated = await fx.registration.handler(
    FEISHU_ENDPOINTS.setGroupResponseMode,
    { botId: 'bot_mode', groupResponseMode: 'all' },
    signal(),
  );
  assert.equal(updated.ok, true);
  assert.equal(updated.value.bots[0].groupResponseMode, 'all');

  const invalid = await fx.registration.handler(
    FEISHU_ENDPOINTS.setGroupResponseMode,
    { botId: 'bot_mode', groupResponseMode: 'sometimes' },
    signal(),
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'bad-request');
  await fx.dispose();
});

test('Host validates and updates the Feishu group topic reply flag', async () => {
  let topicReply = false;
  const current = () => status({
    schemaVersion: 2,
    revision: 4,
    configured: true,
    bots: [{
      botId: 'bot_topic',
      phase: 'connected',
      connected: true,
      configured: true,
      groupResponseMode: 'mention',
      groupTopicReply: topicReply,
      bot: { name: '话题机器人', domain: 'feishu' },
      connection: {
        ready: true,
        feishuLongConnectionState: 'connected',
        harnessReachable: true,
      },
    }],
  });
  const controller = {
    status: async () => current(),
    startRegistration: async () => current(),
    cancelRegistration: async () => current(),
    disconnect: async () => status(),
    updateGroupTopicReply: async (botId, value) => {
      assert.equal(botId, 'bot_topic');
      topicReply = value;
      return current();
    },
  };
  const fx = await rpcFixture(controller);

  const updated = await fx.registration.handler(
    FEISHU_ENDPOINTS.setGroupTopicReply,
    { botId: 'bot_topic', groupTopicReply: true },
    signal(),
  );
  assert.equal(updated.ok, true);
  assert.equal(updated.value.bots[0].groupTopicReply, true);

  const invalid = await fx.registration.handler(
    FEISHU_ENDPOINTS.setGroupTopicReply,
    { botId: 'bot_topic', groupTopicReply: 'sometimes' },
    signal(),
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'bad-request');
  await fx.dispose();
});

test('Host validates and updates the Feishu step push flag', async () => {
  let stepPush = false;
  const current = () => status({
    schemaVersion: 2,
    revision: 5,
    configured: true,
    bots: [{
      botId: 'bot_step',
      phase: 'connected',
      connected: true,
      configured: true,
      groupResponseMode: 'mention',
      groupTopicReply: false,
      stepPush,
      bot: { name: '分步直推机器人', domain: 'feishu' },
      connection: {
        ready: true,
        feishuLongConnectionState: 'connected',
        harnessReachable: true,
      },
    }],
  });
  const controller = {
    status: async () => current(),
    startRegistration: async () => current(),
    cancelRegistration: async () => current(),
    disconnect: async () => status(),
    updateStepPush: async (botId, value) => {
      assert.equal(botId, 'bot_step');
      stepPush = value;
      return current();
    },
  };
  const fx = await rpcFixture(controller);

  const updated = await fx.registration.handler(
    FEISHU_ENDPOINTS.setStepPush,
    { botId: 'bot_step', stepPush: true },
    signal(),
  );
  assert.equal(updated.ok, true);
  assert.equal(updated.value.bots[0].stepPush, true);

  const invalid = await fx.registration.handler(
    FEISHU_ENDPOINTS.setStepPush,
    { botId: 'bot_step', stepPush: 'sometimes' },
    signal(),
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'bad-request');
  await fx.dispose();
});

test('RPC dispatch matches every endpoint in client/api.js', async () => {
  const calls = [];
  let current = status({
    phase: 'registering',
    registration: {
      state: 'qr_ready',
      attempt: 7,
      updatedAt: 100,
      qrCodeUrl: 'https://accounts.feishu.cn/device',
      expiresAt: Date.now() + 60_000,
    },
  });
  const controller = {
    status: async () => current,
    startRegistration: async () => { calls.push('begin'); return current; },
    cancelRegistration: async () => {
      calls.push('cancel');
      current = status({ registration: { state: 'cancelled', attempt: 7, updatedAt: 200 } });
      return current;
    },
    reconnect: async () => { calls.push('test'); return current; },
    bindCredentials: async ({ appId, appSecret }) => {
      calls.push(`bind:${appId}:${appSecret}`);
      return current;
    },
    disconnect: async () => { calls.push('disconnect'); return status(); },
  };
  const fx = await rpcFixture(controller);

  const begun = await fx.registration.handler(
    FEISHU_ENDPOINTS.beginProvisioning,
    { locale: 'zh-CN' },
    signal(),
  );
  assert.equal(begun.ok, true);
  assert.equal(begun.value.attemptId, '7');
  assert.match(begun.value.qrCodeDataUrl, /^data:image\/png;base64,/);

  const polled = await fx.registration.handler(
    FEISHU_ENDPOINTS.pollProvisioning,
    { attemptId: '7' },
    signal(),
  );
  assert.equal(polled.ok, true);
  assert.equal(polled.value.status, 'pending');

  const tested = await fx.registration.handler(FEISHU_ENDPOINTS.testConnection, {}, signal());
  assert.equal(tested.ok, true);

  const bound = await fx.registration.handler(
    FEISHU_ENDPOINTS.bindCredentials,
    { appId: 'cli_manual', appSecret: 'manual-private-secret' },
    signal(),
  );
  assert.equal(bound.ok, true);
  assert.doesNotMatch(JSON.stringify(bound), /manual-private-secret|appSecret/);

  const cancelled = await fx.registration.handler(
    FEISHU_ENDPOINTS.cancelProvisioning,
    { attemptId: '7' },
    signal(),
  );
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.value.status, 'failed');

  const disconnected = await fx.registration.handler(
    FEISHU_ENDPOINTS.disconnect,
    { removeCredentials: true },
    signal(),
  );
  assert.equal(disconnected.ok, true);
  assert.deepEqual(calls, [
    'begin', 'test', 'bind:cli_manual:manual-private-secret', 'cancel', 'disconnect',
  ]);

  const attemptedSecret = await fx.registration.handler(
    FEISHU_ENDPOINTS.beginProvisioning,
    { appSecret: 'must-not-cross-browser-boundary' },
    signal(),
  );
  assert.equal(attemptedSecret.ok, false);
  assert.equal(attemptedSecret.error.code, 'bad-request');
  assert.doesNotMatch(JSON.stringify(attemptedSecret), /must-not-cross-browser-boundary/);
});

test('callback repair begins for exactly one bot and returns only a safe official QR projection', async () => {
  const calls = [];
  const repair = status({
    schemaVersion: 2,
    phase: 'registering',
    configured: true,
    registration: {
      state: 'qr_ready',
      attempt: 'reg_repair',
      operation: 'callback_repair',
      botId: 'bot_target',
      qrCodeUrl: 'https://open.feishu.cn/page/launcher?tp=sdk&clientID=cli_target&addons=encoded&user_code=opaque',
      expiresAt: Date.now() + 60_000,
    },
    bots: [{
      botId: 'bot_target',
      connected: true,
      configured: true,
      bot: { name: '目标机器人', appIdMasked: 'cli_tar••••rget' },
      connection: { ready: true, feishuLongConnectionState: 'connected', harnessReachable: true },
    }],
  });
  const controller = {
    status: async () => repair,
    registrationStatus: async () => repair,
    startRegistration: async () => status(),
    startCallbackRepair: async (botId) => { calls.push(botId); return repair; },
    cancelRegistration: async () => repair,
    disconnect: async () => status(),
  };
  const fx = await rpcFixture(controller);
  const result = await fx.registration.handler(
    FEISHU_ENDPOINTS.beginCallbackRepair,
    { botId: 'bot_target' },
    signal(),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['bot_target']);
  assert.equal(result.value.operation, 'callback_repair');
  assert.equal(result.value.botId, 'bot_target');
  assert.equal(
    result.value.verificationUrl,
    'https://open.feishu.cn/page/launcher?tp=sdk&clientID=cli_target&addons=encoded&user_code=opaque',
  );
  assert.match(result.value.qrCodeDataUrl, /^data:image\/png;base64,/);
  assert.doesNotMatch(JSON.stringify(result), /client_secret|appSecret/);

  const restored = await fx.registration.handler(FEISHU_ENDPOINTS.status, {}, signal());
  assert.equal(restored.value.provisioning.operation, 'callback_repair');
  assert.equal(restored.value.provisioning.botId, 'bot_target');

  for (const payload of [
    {},
    { botId: '../target' },
    { botId: 'bot_target', appSecret: 'must-not-leak' },
  ]) {
    const invalid = await fx.registration.handler(
      FEISHU_ENDPOINTS.beginCallbackRepair,
      payload,
      signal(),
    );
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, 'bad-request');
    assert.doesNotMatch(JSON.stringify(invalid), /must-not-leak|\.\.\/target/);
  }
  await fx.dispose();
});

test('group-message permission begins for one existing bot and returns a safe official QR projection', async () => {
  const calls = [];
  const permission = status({
    schemaVersion: 2,
    phase: 'registering',
    configured: true,
    registration: {
      state: 'qr_ready',
      attempt: 'reg_group_permission',
      operation: 'group_message_permission',
      botId: 'bot_target',
      qrCodeUrl: 'https://open.feishu.cn/page/launcher?tp=sdk&clientID=cli_target&addons=encoded&user_code=opaque',
      expiresAt: Date.now() + 60_000,
    },
    bots: [{
      botId: 'bot_target',
      connected: true,
      configured: true,
      groupResponseMode: 'mention',
      groupMessagePermissionGranted: false,
      bot: { name: '目标机器人', appIdMasked: 'cli_tar••••rget', domain: 'feishu' },
      connection: { ready: true, feishuLongConnectionState: 'connected', harnessReachable: true },
    }],
  });
  const controller = {
    status: async () => permission,
    registrationStatus: async () => permission,
    startRegistration: async () => status(),
    startGroupMessagePermission: async (botId) => { calls.push(botId); return permission; },
    cancelRegistration: async () => permission,
    disconnect: async () => status(),
  };
  const fx = await rpcFixture(controller);
  const result = await fx.registration.handler(
    FEISHU_ENDPOINTS.beginGroupMessagePermission,
    { botId: 'bot_target' },
    signal(),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['bot_target']);
  assert.equal(result.value.operation, 'group_message_permission');
  assert.equal(result.value.botId, 'bot_target');
  assert.equal(
    result.value.verificationUrl,
    'https://open.feishu.cn/page/launcher?tp=sdk&clientID=cli_target&addons=encoded&user_code=opaque',
  );
  assert.match(result.value.qrCodeDataUrl, /^data:image\/png;base64,/);
  assert.doesNotMatch(JSON.stringify(result), /client_secret|appSecret/);

  const restored = await fx.registration.handler(FEISHU_ENDPOINTS.status, {}, signal());
  assert.equal(restored.value.provisioning.operation, 'group_message_permission');
  assert.equal(restored.value.provisioning.botId, 'bot_target');
  assert.equal(restored.value.bots[0].groupMessagePermissionGranted, false);

  for (const payload of [
    {},
    { botId: '../target' },
    { botId: 'bot_target', appSecret: 'must-not-leak' },
  ]) {
    const invalid = await fx.registration.handler(
      FEISHU_ENDPOINTS.beginGroupMessagePermission,
      payload,
      signal(),
    );
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, 'bad-request');
    assert.doesNotMatch(JSON.stringify(invalid), /must-not-leak|\.\.\/target/);
  }
  await fx.dispose();
});

test('status preserves a submitted callback repair attempt after its QR URL is discarded', async () => {
  const secret = 'must-never-cross-the-rpc-boundary';
  const saving = status({
    schemaVersion: 2,
    phase: 'connecting',
    configured: true,
    registration: {
      state: 'saving',
      attempt: 'reg_committed',
      operation: 'callback_repair',
      botId: 'bot_target',
    },
    bots: [{
      botId: 'bot_target',
      configured: true,
      bot: { name: '目标机器人', domain: 'feishu', appSecret: secret },
    }],
  });
  const controller = {
    status: async () => saving,
    startRegistration: async () => status(),
    cancelRegistration: async () => saving,
    disconnect: async () => status(),
  };
  const fx = await rpcFixture(controller);
  const restored = await fx.registration.handler(FEISHU_ENDPOINTS.status, {}, signal());

  assert.equal(restored.ok, true);
  assert.equal(restored.value.state, 'connecting');
  assert.deepEqual(
    {
      attemptId: restored.value.provisioning.attemptId,
      operation: restored.value.provisioning.operation,
      botId: restored.value.provisioning.botId,
      submitted: restored.value.provisioning.submitted,
    },
    {
      attemptId: 'reg_committed',
      operation: 'callback_repair',
      botId: 'bot_target',
      submitted: true,
    },
  );
  assert.equal(restored.value.provisioning.verificationUrl, undefined);
  assert.equal(restored.value.provisioning.qrCodeDataUrl, undefined);
  assert.doesNotMatch(JSON.stringify(restored), new RegExp(secret));
  await fx.dispose();
});

test('callback repair failures cross RPC only as fixed safe public errors', async () => {
  const expected = new Map([
    ['repair_app_mismatch', 'The authorized Feishu app does not match the selected bot.'],
    ['repair_domain_mismatch', 'The authorized Feishu tenant does not match the selected bot.'],
    ['repair_owner_mismatch', 'The authorizing Feishu account is not an owner of the selected bot.'],
    ['repair_target_changed', 'The selected bot changed while repair was in progress. Start the repair again.'],
    ['credential_update_failed', 'Unable to store the repaired Feishu credentials.'],
    ['repair_connection_failed', 'The callback update was accepted, but the selected bot could not reconnect.'],
    ['card_action_probe_send_failed', 'The callback update was accepted, but the verification card could not be sent.'],
    ['card_action_probe_unavailable', 'The selected bot is not connected, so its card button cannot be verified.'],
    ['card_action_probe_timeout', 'Feishu accepted the update, but the card button was not verified in time. Start the repair again and click the test button within two minutes.'],
  ]);
  for (const [code, message] of expected) {
    const failed = status({
      phase: 'error',
      registration: {
        state: 'error',
        attempt: 'reg_failed',
        operation: 'callback_repair',
        botId: 'bot_target',
        error: { code, message: 'secret=must-not-cross' },
      },
    });
    const controller = {
      status: async () => failed,
      startRegistration: async () => status(),
      cancelRegistration: async () => failed,
      disconnect: async () => status(),
    };
    const fx = await rpcFixture(controller);
    const result = await fx.registration.handler(FEISHU_ENDPOINTS.status, {}, signal());
    assert.deepEqual(result.value.error, { code, message });
    assert.doesNotMatch(JSON.stringify(result), /must-not-cross/);
    await fx.dispose();
  }
});

test('callback repair refuses placeholder, non-SDK, and non-official verification links', async () => {
  for (const qrCodeUrl of [
    'https://open.feishu.cn/page/launcher?tp=sdk&clientID=%7B%7Bclient_id%7D%7D',
    'https://open.feishu.cn/page/launcher?tp=card&clientID=cli_target',
    'https://evil.example/device?tp=sdk&clientID=cli_target',
    'http://open.feishu.cn/page/launcher?tp=sdk&clientID=cli_target',
    'https://accounts.feishu.cn/device?tp=sdk&clientID=cli_target',
    'https://open.feishu.cn/page/launcher?tp=sdk&clientID=cli_target&addons=x&createOnly=true',
  ]) {
    const repair = status({
      phase: 'registering',
      configured: true,
      registration: {
        state: 'qr_ready',
        attempt: 'reg_unsafe',
        operation: 'callback_repair',
        botId: 'bot_target',
        qrCodeUrl,
        expiresAt: Date.now() + 60_000,
      },
    });
    const controller = {
      status: async () => repair,
      registrationStatus: async () => repair,
      startRegistration: async () => status(),
      startCallbackRepair: async () => repair,
      cancelRegistration: async () => repair,
      disconnect: async () => status(),
    };
    const fx = await rpcFixture(controller);
    const result = await fx.registration.handler(
      FEISHU_ENDPOINTS.beginCallbackRepair,
      { botId: 'bot_target' },
      signal(),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'internal');
    assert.equal(JSON.stringify(result).includes(qrCodeUrl), false);
    await fx.dispose();
  }
});

test('callback repair cannot be cancelled after configuration enters saving', async () => {
  let cancels = 0;
  const saving = status({
    phase: 'connecting',
    configured: true,
    registration: {
      state: 'saving',
      attempt: 'reg_committed',
      operation: 'callback_repair',
      botId: 'bot_target',
    },
  });
  const controller = {
    status: async () => saving,
    registrationStatus: async () => saving,
    startRegistration: async () => status(),
    cancelRegistration: async () => { cancels += 1; return saving; },
    disconnect: async () => status(),
  };
  const fx = await rpcFixture(controller);
  const result = await fx.registration.handler(
    FEISHU_ENDPOINTS.cancelProvisioning,
    { attemptId: 'reg_committed' },
    signal(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'connecting');
  assert.equal(result.value.operation, 'callback_repair');
  assert.equal(result.value.botId, 'bot_target');
  assert.equal(cancels, 1);

  const polled = await fx.registration.handler(
    FEISHU_ENDPOINTS.pollProvisioning,
    { attemptId: 'reg_committed' },
    signal(),
  );
  assert.equal(polled.ok, true);
  assert.equal(polled.value.status, 'connecting');
  await fx.dispose();
});

test('connection.test does not restart an already healthy long connection', async () => {
  let reconnects = 0;
  const healthy = status({
    phase: 'connected',
    connected: true,
    configured: true,
    connection: {
      ready: true,
      feishuLongConnectionState: 'connected',
      harnessReachable: true,
    },
  });
  const controller = {
    status: async () => healthy,
    startRegistration: async () => healthy,
    cancelRegistration: async () => healthy,
    reconnect: async () => { reconnects += 1; return healthy; },
    disconnect: async () => status(),
  };
  const fx = await rpcFixture(controller);

  const result = await fx.registration.handler(FEISHU_ENDPOINTS.testConnection, {}, signal());

  assert.equal(result.ok, true);
  assert.equal(result.value.connected, true);
  assert.equal(reconnects, 0);
});

test('provision.begin waits through starting until onQRCodeReady is observable', async () => {
  let current = status({
    phase: 'registering',
    registration: { state: 'starting', attempt: 3, updatedAt: 100 },
  });
  const controller = {
    status: async () => current,
    startRegistration: async () => {
      setTimeout(() => {
        current = status({
          phase: 'registering',
          registration: {
            state: 'qr_ready',
            attempt: 3,
            updatedAt: 110,
            qrCodeUrl: 'https://accounts.feishu.cn/async-qr',
            expiresAt: Date.now() + 60_000,
          },
        });
      }, 5);
      return current;
    },
    cancelRegistration: async () => status(),
    disconnect: async () => status(),
  };
  const fx = await rpcFixture(controller);
  const begun = await fx.registration.handler(
    FEISHU_ENDPOINTS.beginProvisioning,
    { locale: 'zh-CN' },
    signal(),
  );

  assert.equal(begun.ok, true);
  assert.equal(begun.value.attemptId, '3');
  assert.equal(begun.value.verificationUrl, 'https://accounts.feishu.cn/async-qr');
  assert.match(begun.value.qrCodeDataUrl, /^data:image\/png;base64,/);
});

test('cancelling during credential activation tears down the eventual runtime', async () => {
  const calls = [];
  const current = status({
    phase: 'connecting',
    configured: true,
    registration: { state: 'saving', attempt: 11, updatedAt: 100 },
  });
  const controller = {
    status: async () => current,
    startRegistration: async () => current,
    cancelRegistration: async () => { calls.push('cancel-only'); return current; },
    disconnect: async () => { calls.push('disconnect'); return status(); },
  };
  const fx = await rpcFixture(controller);
  const result = await fx.registration.handler(
    FEISHU_ENDPOINTS.cancelProvisioning,
    { attemptId: '11' },
    signal(),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['disconnect']);
});

test('status returns qrCodeDataUrl while dropping all credential-shaped fields', async () => {
  const secret = 'sdk-super-secret-value';
  const controller = {
    status: async () => status({
      phase: 'registering',
      appSecret: secret,
      credentials: { client_secret: secret },
      registration: {
        state: 'qr_ready',
        attempt: 1,
        qrCodeUrl: 'https://accounts.feishu.cn/device',
        expiresAt: Date.now() + 60_000,
        client_secret: secret,
      },
      connection: {
        ready: true,
        connected: false,
        state: 'connecting',
        token: secret,
      },
    }),
    startRegistration: async () => status(),
    cancelRegistration: async () => status(),
    disconnect: async () => status(),
  };
  const fx = await rpcFixture(controller);
  const result = await fx.registration.handler(FEISHU_ENDPOINTS.status, {}, signal());

  assert.equal(result.ok, true);
  assert.equal(result.value.state, 'provisioning');
  assert.equal(result.value.provisioning.verificationUrl, 'https://accounts.feishu.cn/device');
  assert.match(result.value.provisioning.qrCodeDataUrl, /^data:image\/png;base64,/);
  assert.doesNotMatch(JSON.stringify(result), /sdk-super-secret-value|client_secret|credentials|token/);
});

test('polling a new QR stays pending when another bot is already connected', async () => {
  const current = status({
    schemaVersion: 2,
    phase: 'registering',
    connected: false,
    configured: true,
    registration: {
      state: 'qr_ready',
      attempt: 'reg_new_bot',
      qrCodeUrl: 'https://accounts.feishu.cn/new-bot',
      expiresAt: Date.now() + 60_000,
    },
    bots: [{
      botId: 'bot_existing',
      phase: 'connected',
      connected: true,
      configured: true,
      bot: { name: '现有机器人', appIdMasked: 'cli_old••••1234' },
      connection: {
        ready: true,
        feishuLongConnectionState: 'connected',
        harnessReachable: true,
      },
    }],
  });
  const controller = {
    status: async () => current,
    registrationStatus: async () => current,
    startRegistration: async () => current,
    cancelRegistration: async () => current,
    disconnect: async () => status(),
  };
  const fx = await rpcFixture(controller);
  const result = await fx.registration.handler(
    FEISHU_ENDPOINTS.pollProvisioning,
    { attemptId: 'reg_new_bot' },
    signal(),
  );

  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'pending');
  assert.equal('botId' in result.value, false);
  assert.equal('connection' in result.value, false);
});

test('multi-bot RPC operations require a botId and never expose host-only fields', async () => {
  const calls = [];
  const multi = status({
    schemaVersion: 2,
    revision: 9,
    configured: true,
    bots: [{
      botId: 'bot_safe',
      phase: 'connected',
      connected: true,
      configured: true,
      secretRef: 'DSH_FEISHU_APP_SECRET_PRIVATE',
      ownerOpenIds: ['ou_private'],
      bot: {
        name: '安全机器人',
        appId: 'cli_raw_private',
        appIdMasked: 'cli_safe••••1234',
        domain: 'feishu',
      },
      connection: {
        ready: true,
        feishuLongConnectionState: 'connected',
        harnessReachable: true,
        token: 'private-token',
      },
    }],
  });
  const controller = {
    status: async () => multi,
    startRegistration: async () => multi,
    cancelRegistration: async () => multi,
    disconnect: async () => status(),
    reconnectBot: async (botId) => { calls.push(['reconnect', botId]); return multi; },
    sendConnectionTest: async (botId) => { calls.push(['test-message', botId]); },
    disconnectBot: async (botId) => { calls.push(['disconnect', botId]); return multi; },
    deleteBot: async (botId) => { calls.push(['delete', botId]); return status({ schemaVersion: 2, bots: [] }); },
  };
  const fx = await rpcFixture(controller);

  for (const [endpoint, payload] of [
    [FEISHU_MULTI_ENDPOINTS.reconnectBot, { botId: 'bot_safe', sendTest: true }],
    [FEISHU_MULTI_ENDPOINTS.disconnectBot, { botId: 'bot_safe' }],
    [FEISHU_MULTI_ENDPOINTS.deleteBot, { botId: 'bot_safe', confirm: true }],
  ]) {
    const result = await fx.registration.handler(endpoint, payload, signal());
    assert.equal(result.ok, true);
    assert.doesNotMatch(JSON.stringify(result), /DSH_FEISHU_APP_SECRET|ou_private|cli_raw_private|private-token/);
    if (endpoint === FEISHU_MULTI_ENDPOINTS.reconnectBot) {
      assert.deepEqual(result.value.testMessage, { sent: true });
    }
  }
  assert.deepEqual(calls, [
    ['reconnect', 'bot_safe'],
    ['test-message', 'bot_safe'],
    ['disconnect', 'bot_safe'],
    ['delete', 'bot_safe'],
  ]);

  const invalid = await fx.registration.handler(
    FEISHU_MULTI_ENDPOINTS.deleteBot,
    { botId: '../private', confirm: true },
    signal(),
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'bad-request');
  assert.doesNotMatch(JSON.stringify(invalid), /\.\.\/private/);
});

test('Feishu reconnect test delivery is best-effort and requires the target bot to be connected', async () => {
  let connected = true;
  let sendCalls = 0;
  const snapshot = () => status({
    schemaVersion: 2,
    revision: 1,
    configured: true,
    bots: [{
      botId: 'bot_safe',
      phase: connected ? 'connected' : 'disconnected',
      connected,
      configured: true,
      bot: { name: '安全机器人', appIdMasked: 'cli_safe••••1234', domain: 'feishu' },
      connection: {
        ready: connected,
        feishuLongConnectionState: connected ? 'connected' : 'idle',
        harnessReachable: connected,
      },
    }],
  });
  const controller = {
    status: async () => snapshot(),
    startRegistration: async () => snapshot(),
    cancelRegistration: async () => snapshot(),
    disconnect: async () => status(),
    reconnectBot: async () => snapshot(),
    sendConnectionTest: async () => {
      sendCalls += 1;
      throw new Error('private Feishu provider failure');
    },
  };
  const fx = await rpcFixture(controller);

  const failedSend = await fx.registration.handler(
    FEISHU_MULTI_ENDPOINTS.reconnectBot,
    { botId: 'bot_safe', sendTest: true },
    signal(),
  );
  assert.equal(failedSend.ok, true);
  assert.deepEqual(failedSend.value.testMessage, {
    sent: false,
    code: 'test-message-failed',
  });
  assert.doesNotMatch(JSON.stringify(failedSend), /private Feishu provider failure/);
  assert.equal(sendCalls, 1);

  connected = false;
  const unavailable = await fx.registration.handler(
    FEISHU_MULTI_ENDPOINTS.reconnectBot,
    { botId: 'bot_safe', sendTest: true },
    signal(),
  );
  assert.equal(unavailable.ok, true);
  assert.deepEqual(unavailable.value.testMessage, {
    sent: false,
    code: 'test-target-unavailable',
  });
  assert.equal(sendCalls, 1);

  const invalid = await fx.registration.handler(
    FEISHU_MULTI_ENDPOINTS.reconnectBot,
    { botId: 'bot_safe', sendTest: 'yes' },
    signal(),
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'bad-request');
  await fx.dispose();
});

test('Feishu RPC never sends a connection test after reconnect is cancelled', async () => {
  let resolveReconnect;
  let sendCalls = 0;
  const reconnect = new Promise((resolve) => { resolveReconnect = resolve; });
  const controller = {
    status: async () => status(),
    startRegistration: async () => status(),
    cancelRegistration: async () => status(),
    disconnect: async () => status(),
    reconnectBot: async () => reconnect,
    sendConnectionTest: async () => { sendCalls += 1; },
  };
  const fx = await rpcFixture(controller);
  const abort = new AbortController();
  const result = fx.registration.handler(FEISHU_MULTI_ENDPOINTS.reconnectBot, {
    botId: 'bot_safe',
    sendTest: true,
  }, abort.signal);

  abort.abort();
  resolveReconnect(status({
    schemaVersion: 2,
    bots: [{ botId: 'bot_safe', connected: true }],
  }));

  assert.equal((await result).error.code, 'cancelled');
  assert.equal(sendCalls, 0);
  await fx.dispose();
});

test('dependency failures and AbortSignal use valid RpcResult error branches', async () => {
  const secret = 'should-never-be-reflected';
  const controller = {
    status: async () => { throw new Error(`SDK failed with ${secret}`); },
    startRegistration: async () => status(),
    cancelRegistration: async () => status(),
    disconnect: async () => status(),
  };
  const fx = await rpcFixture(controller);
  const failure = await fx.registration.handler(FEISHU_ENDPOINTS.status, {}, signal());
  assert.deepEqual(failure, {
    ok: false,
    error: {
      code: 'internal',
      message: 'The Feishu integration operation failed.',
      details: {},
    },
  });
  assert.doesNotMatch(JSON.stringify(failure), new RegExp(secret));

  const abort = new AbortController();
  abort.abort();
  const cancelled = await fx.registration.handler(FEISHU_ENDPOINTS.status, {}, abort.signal);
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.code, 'cancelled');

  const unknown = await fx.registration.handler('credentials.read', {}, signal());
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'bad-request');
});

test('provisioning callback stores credentials and connects before connected is visible', async () => {
  const secret = 'host-only-app-secret';
  let onCredentials;
  let registrationState = 'idle';
  let configured = false;
  let connectionStatus = {
    ready: false,
    feishuLongConnectionState: 'idle',
    harnessReachable: false,
  };
  const saved = [];
  const connectedWith = [];
  const controller = createProvisioningBackedController({
    createProvisioningManager(callbacks) {
      onCredentials = callbacks.onCredentials;
      return {
        start() { registrationState = 'qr_ready'; return this.status(); },
        status() {
          return {
            state: registrationState,
            attempt: 1,
            updatedAt: 100,
            ...(registrationState === 'qr_ready'
              ? { qrCodeUrl: 'https://accounts.feishu.cn/qr', expiresAt: Date.now() + 60_000 }
              : {}),
          };
        },
        cancel() { registrationState = 'cancelled'; return this.status(); },
      };
    },
    credentialStore: {
      async save(credentials) { saved.push(credentials); configured = true; },
      async clear() { configured = false; },
      async configured() { return configured; },
    },
    connectionManager: {
      async connect(credentials) {
        connectedWith.push(credentials);
        connectionStatus = {
          ready: true,
          feishuLongConnectionState: 'connected',
          harnessReachable: true,
        };
      },
      async disconnect() {
        connectionStatus = {
          ready: false,
          feishuLongConnectionState: 'idle',
          harnessReachable: false,
        };
      },
      status: () => connectionStatus,
    },
  });
  const fx = await rpcFixture(controller);

  const begun = await fx.registration.handler(
    FEISHU_ENDPOINTS.beginProvisioning,
    { locale: 'zh-CN' },
    signal(),
  );
  assert.equal(begun.ok, true);

  await onCredentials({
    client_id: 'cli_created',
    client_secret: secret,
    user_info: { open_id: 'ou_owner' },
  });
  registrationState = 'succeeded';
  const ready = await fx.registration.handler(FEISHU_ENDPOINTS.status, {}, signal());

  assert.equal(ready.ok, true);
  assert.equal(ready.value.state, 'connected');
  assert.equal(ready.value.connected, true);
  assert.equal(saved[0].appSecret, secret);
  assert.equal(connectedWith[0].appSecret, secret);
  assert.doesNotMatch(JSON.stringify(ready), new RegExp(secret));

  const disconnected = await fx.registration.handler(
    FEISHU_ENDPOINTS.disconnect,
    { removeCredentials: true },
    signal(),
  );
  assert.equal(disconnected.ok, true);
  assert.equal(disconnected.value.state, 'disconnected');
  assert.equal(configured, false);
});

test('DSH credential adapter stores refs off the browser plane and clears them', async () => {
  const values = new Map();
  const provider = {
    async resolve(ref) {
      return values.has(ref) ? { value: values.get(ref), source: 'file' } : undefined;
    },
    async describe(ref) {
      return { configured: values.has(ref), source: values.has(ref) ? 'file' : undefined, writable: true };
    },
    async set(ref, value) { values.set(ref, value); },
    async unset(ref) { values.delete(ref); },
  };
  const store = createDshCredentialStore(provider);

  await store.save({ appId: 'cli_created', appSecret: 'stored-secret' });
  assert.equal(values.get(FEISHU_APP_ID_REF), 'cli_created');
  assert.equal(values.get(FEISHU_APP_SECRET_REF), 'stored-secret');
  assert.equal(await store.configured(), true);

  await store.clear();
  assert.equal(values.size, 0);
  assert.equal(await store.configured(), false);
});

test('production assembly uses ctx credentials and the active Host apiProxy without a webServer', async () => {
  const constructed = {};
  const httpInstance = { request: async () => ({}) };
  const wsAgent = {
    addRequest() {},
    destroy() { constructed.wsAgentDestroyed = true; },
  };
  class FakeConfigStore {
    constructor(path) { constructed.configPath = path; }
    async load() { return this; }
  }
  class FakeStateStore {
    constructor(path) {
      constructed.statePath = path;
      (constructed.statePaths ??= []).push(path);
    }
    async load() { return this; }
  }
  class FakeHarness {
    constructor(options) { constructed.harness = options; }
    async ensureRunning() { constructed.harnessReadyChecks = (constructed.harnessReadyChecks ?? 0) + 1; }
    stopManagedProcess() { constructed.harnessStopped = true; }
  }
  class FakeRuntime {
    constructor(options) { constructed.runtime = options; }
  }
  class FakeController {
    constructor(options) { constructed.controller = options; }
    async initialize() { constructed.initialized = true; }
    status() { return { totals: { configured: 0, connected: 0 } }; }
    async close() { constructed.closed = true; }
  }
  const credentials = {};
  const apiProxy = {};
  const production = await createProductionController({
    credentials,
    apiProxy,
    logger: console,
  }, {
    dshHome: '/tmp/dsh-feishu-host-test',
    workspace: '/tmp/dsh-feishu-workspace',
    slashCommands: false,
  }, {
    lark: { registerApp: async () => ({}), defaultHttpInstance: httpInstance },
    Controller: FakeController,
    ConfigStore: FakeConfigStore,
    StateStore: FakeStateStore,
    HarnessClient: FakeHarness,
    FeishuRuntime: FakeRuntime,
    verifyFeishuApp: async (options) => {
      constructed.verifyOptions = options;
      return {};
    },
    proxyEnv: { HTTPS_PROXY: 'http://proxy.test:8080' },
    createProxyAgent: (proxyUrl) => {
      constructed.wsAgentCreated = (constructed.wsAgentCreated ?? 0) + 1;
      constructed.wsProxyUrl = proxyUrl;
      return wsAgent;
    },
  });

  assert.equal(constructed.initialized, undefined);
  await production.ready;
  assert.equal(constructed.initialized, true);
  assert.equal(constructed.harnessReadyChecks, 1);
  assert.equal(constructed.controller.credentials, credentials);
  await constructed.controller.verifyApp({ appId: 'cli_verify', appSecret: 'verify-secret' });
  assert.equal(constructed.verifyOptions.httpInstance, httpInstance);
  assert.equal(constructed.wsAgentCreated, 1);
  assert.equal(constructed.wsProxyUrl, 'http://proxy.test:8080');
  assert.equal(constructed.harness.apiProxy, apiProxy);
  assert.equal(Object.hasOwn(constructed.harness, 'baseUrl'), false);
  assert.equal(constructed.harness.autostart, false);
  assert.match(constructed.configPath, /integrations\/dsh-feishu\/config\.json$/);

  await constructed.controller.createRuntime({
    config: {
      appId: 'cli_created',
      domain: 'feishu',
      ownerOpenId: 'ou_owner',
    },
    appSecret: 'host-only',
  });
  assert.match(constructed.statePath, /integrations\/dsh-feishu\/state\.json$/);
  assert.equal(constructed.runtime.appSecret, 'host-only');
  assert.equal(constructed.runtime.wsAgent, wsAgent);
  assert.equal(constructed.runtime.slashCommands, false);
  const repair = { start() {}, status() {}, cancel() {} };
  await constructed.controller.createRuntime({
    botId: 'bot_alpha',
    config: {
      id: 'bot_alpha',
      appId: 'cli_alpha',
      secretRef: 'DSH_FEISHU_APP_SECRET_ALPHA',
      domain: 'feishu',
      ownerOpenIds: ['ou_alpha'],
    },
    appSecret: 'alpha-secret',
    repair,
  });
  const alphaState = constructed.runtime.state;
  assert.equal(constructed.runtime.botId, 'bot_alpha');
  assert.equal(constructed.runtime.repair, repair);
  assert.equal(Object.hasOwn(constructed.runtime, 'outboundArtifactsEnabled'), false);
  await constructed.controller.createRuntime({
    botId: 'bot_beta',
    config: {
      id: 'bot_beta',
      appId: 'cli_beta',
      secretRef: 'DSH_FEISHU_APP_SECRET_BETA',
      domain: 'feishu',
      ownerOpenIds: ['ou_beta'],
    },
    appSecret: 'beta-secret',
  });
  const betaState = constructed.runtime.state;
  assert.equal(Object.hasOwn(constructed.runtime, 'outboundArtifactsEnabled'), false);
  assert.notEqual(alphaState, betaState);
  assert.ok(constructed.statePaths.some((path) => /bots\/bot_alpha\/state\.json$/.test(path)));
  assert.ok(constructed.statePaths.some((path) => /bots\/bot_beta\/state\.json$/.test(path)));
  await production.close();
  assert.equal(constructed.closed, true);
  assert.equal(constructed.harnessStopped, true);
  assert.equal(constructed.wsAgentDestroyed, true);
});

test('a corrupt legacy state file cannot prevent a healthy v2 bot from starting', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-feishu-production-state-isolation-'));
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'state.json'), '{corrupt legacy state');
  const legacy = {
    id: 'bot_legacy',
    appId: 'cli_legacy',
    secretRef: 'DSH_FEISHU_APP_SECRET',
    ownerOpenIds: ['ou_legacy'],
    domain: 'feishu',
    botName: '旧机器人',
  };
  const healthy = {
    id: 'bot_healthy',
    appId: 'cli_healthy',
    secretRef: 'DSH_FEISHU_APP_SECRET_HEALTHY',
    ownerOpenIds: ['ou_healthy'],
    domain: 'feishu',
    botName: '健康机器人',
  };
  await writeFile(join(dataDir, 'config.json'), JSON.stringify({ version: 2, bots: [legacy, healthy] }));
  const secrets = new Map([
    [legacy.secretRef, 'legacy-secret'],
    [healthy.secretRef, 'healthy-secret'],
  ]);
  class FakeRuntime {
    #status = { ready: false, feishuLongConnectionState: 'idle', harnessReachable: false };
    get status() { return structuredClone(this.#status); }
    async start() {
      this.#status = { ready: true, feishuLongConnectionState: 'connected', harnessReachable: true };
    }
    async stop() {
      this.#status = { ready: false, feishuLongConnectionState: 'idle', harnessReachable: false };
    }
  }
  class FakeHarness {
    async ensureRunning() {}
    stopManagedProcess() {}
  }
  const production = await createProductionController({
    credentials: {
      async resolve(ref) { return secrets.has(ref) ? { value: secrets.get(ref) } : undefined; },
      async set(ref, value) { secrets.set(ref, value); },
      async unset(ref) { secrets.delete(ref); },
    },
    apiProxy: {},
    logger: console,
  }, { dataDir, workspace: dataDir }, {
    lark: { registerApp: async () => ({}) },
    HarnessClient: FakeHarness,
    FeishuRuntime: FakeRuntime,
    verifyFeishuApp: async () => ({}),
    proxyEnv: {},
  });

  await production.ready;
  const statusValue = await production.controller.status();
  assert.equal(statusValue.bots.find((entry) => entry.botId === 'bot_legacy').phase, 'error');
  assert.equal(statusValue.bots.find((entry) => entry.botId === 'bot_healthy').connected, true);
  assert.equal(statusValue.totals.connected, 1);
  await production.close();
});
