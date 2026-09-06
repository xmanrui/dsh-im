import assert from 'node:assert/strict';
import test from 'node:test';
import { MultiBotDshFeishuController } from '../../../src/channels/feishu/multi-bot-controller.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await flush();
  }
}

class MemoryConfigStore {
  constructor(bots = []) {
    this.bots = structuredClone(bots);
  }
  list() { return structuredClone(this.bots); }
  getBot(id) {
    const bot = this.bots.find((candidate) => candidate.id === id);
    return bot ? structuredClone(bot) : null;
  }
  async saveBot(bot) {
    const index = this.bots.findIndex((candidate) => candidate.id === bot.id);
    if (index === -1) this.bots.push(structuredClone(bot));
    else this.bots[index] = structuredClone(bot);
    return structuredClone(bot);
  }
  async removeBot(id) {
    const index = this.bots.findIndex((candidate) => candidate.id === id);
    return index === -1 ? null : this.bots.splice(index, 1)[0];
  }
}

function bot(id, suffix = id) {
  return {
    id,
    appId: `cli_${suffix}`,
    secretRef: `DSH_FEISHU_APP_SECRET_${suffix.toUpperCase()}`,
    ownerOpenIds: [`ou_${suffix}`],
    domain: 'feishu',
    botName: `机器人 ${suffix}`,
    botOpenId: `ou_bot_${suffix}`,
    activated: 1,
  };
}

function fixture({
  bots = [],
  secrets = {},
  createBotIds = [],
  failResolveRefs = new Set(),
  failUnsetRefs = new Set(),
  runtimeStart,
  callbackProbe,
  verifyApp,
  credentialSet,
  deleteState,
} = {}) {
  const configStore = new MemoryConfigStore(bots);
  const values = new Map(Object.entries(secrets));
  const unsetCalls = [];
  const registrationRuns = [];
  const runtimes = new Map();
  let registrationSequence = 0;
  let botSequence = 0;
  const controller = new MultiBotDshFeishuController({
    registerApp(options) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      registrationRuns.push({ options, resolve, reject });
      return promise;
    },
    verifyApp: verifyApp ?? (async ({ appId }) => ({
      name: `已验证 ${appId}`,
      openId: `ou_bot_${appId}`,
      activated: 1,
    })),
    credentials: {
      async resolve(ref) {
        if (failResolveRefs.has(ref)) throw new Error('credential provider unavailable');
        return values.has(ref) ? { value: values.get(ref), source: 'file' } : undefined;
      },
      async set(ref, value) {
        if (credentialSet) await credentialSet({ ref, value, values });
        else values.set(ref, value);
      },
      async unset(ref) {
        unsetCalls.push(ref);
        if (failUnsetRefs.has(ref)) throw new Error('credential provider is read-only');
        values.delete(ref);
      },
    },
    configStore,
    createRuntime: async ({ botId, config, appSecret, repair }) => {
      const status = {
        ready: false,
        feishuLongConnectionState: 'idle',
        harnessReachable: false,
      };
      const runtime = {
        botId,
        config: structuredClone(config),
        appSecret,
        starts: 0,
        stops: 0,
        sentTests: [],
        proactiveSends: [],
        probes: [],
        responseModes: [],
        repair,
        get status() { return structuredClone(status); },
        async start() {
          runtime.starts += 1;
          if (runtimeStart) await runtimeStart({ botId, runtime });
          status.ready = true;
          status.feishuLongConnectionState = 'connected';
          status.harnessReachable = true;
        },
        async stop() {
          runtime.stops += 1;
          status.ready = false;
          status.feishuLongConnectionState = 'idle';
        },
        async sendConnectionTest(text) {
          runtime.sentTests.push(text);
          return { sent: true };
        },
        async sendProactiveText(...args) {
          runtime.proactiveSends.push(args);
          return { sent: true };
        },
        setGroupResponseMode(mode) {
          runtime.responseModes.push(mode);
          runtime.config.groupResponseMode = mode;
        },
        async beginCardActionProbe(options) {
          runtime.probes.push(structuredClone(options));
          if (callbackProbe) return callbackProbe({ botId, runtime, options });
          return { verified: true };
        },
      };
      const history = runtimes.get(botId) ?? [];
      history.push(runtime);
      runtimes.set(botId, history);
      return runtime;
    },
    deleteState: deleteState ?? (async () => {}),
    createBotId() {
      const id = createBotIds[botSequence] ?? `bot_generated_${++botSequence}`;
      botSequence += createBotIds.length > 0 ? 1 : 0;
      return id;
    },
    createRegistrationId: () => `reg_${++registrationSequence}`,
    callbackProbeTimeoutMs: 50,
  });
  return { controller, configStore, values, unsetCalls, registrationRuns, runtimes };
}

async function completeScan(fx, result) {
  const started = fx.controller.startRegistration();
  const attemptId = started.registration.attempt;
  await waitFor(() => fx.registrationRuns.length > 0);
  const run = fx.registrationRuns.shift();
  run.options.onQRCodeReady({ url: `https://accounts.feishu.cn/${attemptId}`, expireIn: 60 });
  run.resolve(result);
  await waitFor(() => ['succeeded', 'error'].includes(
    fx.controller.registrationStatus(attemptId).registration.state,
  ));
  return fx.controller.registrationStatus(attemptId);
}

function callbackRepairQrUrl(appId, domain = 'feishu') {
  const host = domain === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn';
  return `https://${host}/page/launcher?tp=sdk&clientID=${encodeURIComponent(appId)}&addons=encoded`;
}

test('QR registration separates events from card callbacks', async () => {
  const fx = fixture({ createBotIds: ['bot_callbacks'] });
  const started = fx.controller.startRegistration();
  const attemptId = started.registration.attempt;
  await waitFor(() => fx.registrationRuns.length === 1);
  const run = fx.registrationRuns.shift();
  assert.deepEqual(run.options.addons.events.items.tenant, ['im.message.receive_v1']);
  assert.deepEqual(run.options.addons.callbacks.items, ['card.action.trigger']);
  assert.ok(run.options.addons.scopes.tenant.includes('im:resource'));
  assert.equal(run.options.addons.scopes.tenant.includes('im:resource:upload'), false);
  assert.ok(run.options.addons.scopes.tenant.includes('application:app_slash_command:read'));
  assert.ok(run.options.addons.scopes.tenant.includes('application:app_slash_command:write'));
  run.options.onQRCodeReady({ url: 'https://accounts.feishu.cn/callbacks', expireIn: 60 });
  run.resolve({
    client_id: 'cli_callbacks', client_secret: 'callbacks-secret',
    user_info: { open_id: 'ou_callbacks', tenant_brand: 'feishu' },
  });
  await waitFor(() => fx.controller.registrationStatus(attemptId).registration.state === 'succeeded');
  await fx.controller.close();
});

test('group response mode defaults to mention and updates the live runtime without reconnecting', async () => {
  const existing = bot('bot_response_mode', 'response_mode');
  existing.groupMessagePermissionGranted = true;
  const fx = fixture({
    bots: [existing],
    secrets: { [existing.secretRef]: 'stable-secret' },
  });
  await fx.controller.initialize();

  assert.equal(fx.controller.status().bots[0].groupResponseMode, 'mention');
  assert.equal(fx.controller.status().bots[0].groupMessagePermissionGranted, true);
  const runtime = fx.runtimes.get(existing.id)[0];
  const updated = await fx.controller.updateGroupResponseMode(existing.id, 'all');

  assert.equal(updated.bots[0].groupResponseMode, 'all');
  assert.equal(fx.configStore.getBot(existing.id).groupResponseMode, 'all');
  assert.deepEqual(runtime.responseModes, ['all']);
  assert.equal(fx.runtimes.get(existing.id).length, 1);
  await assert.rejects(
    fx.controller.updateGroupResponseMode(existing.id, 'sometimes'),
    /Invalid Feishu group response mode/,
  );
  await fx.controller.close();
});

test('groupTopicReply persists and reaches the live runtime without reconnecting', async () => {
  const existing = bot('bot_topic_reply', 'topic_reply');
  const fx = fixture({
    bots: [existing],
    secrets: { [existing.secretRef]: 'stable-secret' },
  });
  await fx.controller.initialize();

  assert.equal(fx.controller.status().bots[0].groupTopicReply, false);
  const runtime = fx.runtimes.get(existing.id)[0];
  const topicReplies = [];
  runtime.setGroupTopicReply = (value) => topicReplies.push(value);
  const updated = await fx.controller.updateGroupTopicReply(existing.id, true);

  assert.equal(updated.bots[0].groupTopicReply, true);
  assert.equal(fx.configStore.getBot(existing.id).groupTopicReply, true);
  assert.deepEqual(topicReplies, [true]);
  assert.equal(fx.runtimes.get(existing.id).length, 1);
  await assert.rejects(
    fx.controller.updateGroupTopicReply(existing.id, 'yes'),
    /Invalid Feishu group topic reply flag/,
  );
  await fx.controller.close();
});

test('stepPush persists and reaches the live runtime without reconnecting', async () => {
  const existing = bot('bot_step_push', 'step_push');
  const fx = fixture({
    bots: [existing],
    secrets: { [existing.secretRef]: 'stable-secret' },
  });
  await fx.controller.initialize();

  assert.equal(fx.controller.status().bots[0].stepPush, false);
  const runtime = fx.runtimes.get(existing.id)[0];
  const stepPushes = [];
  runtime.setStepPush = (value) => stepPushes.push(value);
  const updated = await fx.controller.updateStepPush(existing.id, true);

  assert.equal(updated.bots[0].stepPush, true);
  assert.equal(fx.configStore.getBot(existing.id).stepPush, true);
  assert.deepEqual(stepPushes, [true]);
  assert.equal(fx.runtimes.get(existing.id).length, 1);
  await assert.rejects(
    fx.controller.updateStepPush(existing.id, 'yes'),
    /Invalid Feishu step push/,
  );
  await fx.controller.close();
});

test('all-message mode requires authorization before direct updates', async () => {
  const existing = bot('bot_response_permission_required', 'response_permission_required');
  const fx = fixture({
    bots: [existing],
    secrets: { [existing.secretRef]: 'stable-secret' },
  });
  await fx.controller.initialize();

  await assert.rejects(
    fx.controller.updateGroupResponseMode(existing.id, 'all'),
    (error) => error?.code === 'group_message_permission_required',
  );
  assert.equal(fx.configStore.getBot(existing.id).groupResponseMode, undefined);
  assert.equal(fx.controller.status().bots[0].groupResponseMode, 'mention');
  assert.equal(fx.controller.status().bots[0].groupMessagePermissionGranted, false);
  await fx.controller.close();
});

test('group-message authorization grants only its scope, enables all mode, and restarts one bot', async () => {
  const existing = bot('bot_group_permission', 'group_permission');
  const fx = fixture({
    bots: [existing],
    secrets: { [existing.secretRef]: 'stable-secret' },
    verifyApp: async () => ({
      name: existing.botName,
      openId: existing.botOpenId,
      activated: existing.activated,
    }),
  });
  await fx.controller.initialize();
  const oldRuntime = fx.runtimes.get(existing.id)[0];

  const started = fx.controller.startGroupMessagePermission(existing.id);
  const duplicate = fx.controller.startGroupMessagePermission(existing.id);
  const attemptId = started.registration.attempt;
  assert.equal(duplicate.registration.attempt, attemptId);
  assert.equal(started.registration.operation, 'group_message_permission');
  assert.equal(started.registration.botId, existing.id);

  await waitFor(() => fx.registrationRuns.length === 1);
  const run = fx.registrationRuns.shift();
  assert.equal(run.options.appId, existing.appId);
  assert.equal(Object.hasOwn(run.options, 'createOnly'), false);
  assert.deepEqual(run.options.addons, {
    preset: false,
    scopes: { tenant: ['im:message.group_msg'] },
  });
  run.options.onQRCodeReady({
    url: callbackRepairQrUrl(existing.appId),
    expireIn: 60,
  });
  run.resolve({
    client_id: existing.appId,
    client_secret: 'stable-secret',
    user_info: { open_id: existing.ownerOpenIds[0], tenant_brand: existing.domain },
  });

  await waitFor(() => fx.controller.registrationStatus(attemptId).registration.state === 'succeeded');
  const saved = fx.configStore.getBot(existing.id);
  assert.equal(saved.groupMessagePermissionGranted, true);
  assert.equal(saved.groupResponseMode, 'all');
  assert.equal(oldRuntime.stops, 1);
  assert.equal(fx.runtimes.get(existing.id).length, 2);
  assert.equal(fx.runtimes.get(existing.id)[1].config.groupResponseMode, 'all');
  const status = fx.controller.registrationStatus(attemptId);
  assert.equal(status.bots[0].groupMessagePermissionGranted, true);
  assert.equal(status.bots[0].groupResponseMode, 'all');
  await fx.controller.close();
});

test('cancelling group-message authorization before confirmation preserves mention mode', async () => {
  const existing = bot('bot_group_permission_cancel', 'group_permission_cancel');
  const fx = fixture({
    bots: [existing],
    secrets: { [existing.secretRef]: 'stable-secret' },
  });
  await fx.controller.initialize();

  const started = fx.controller.startGroupMessagePermission(existing.id);
  const attemptId = started.registration.attempt;
  await waitFor(() => fx.registrationRuns.length === 1);
  const cancelled = await fx.controller.cancelRegistration(attemptId);
  assert.equal(cancelled.registration.state, 'cancelled');
  const saved = fx.configStore.getBot(existing.id);
  assert.equal(saved.groupMessagePermissionGranted, undefined);
  assert.equal(saved.groupResponseMode, undefined);
  assert.equal(fx.runtimes.get(existing.id).length, 1);
  await fx.controller.close();
});

test('callback repair is deduplicated per bot, updates only its secret, and proves the callback', async () => {
  const existing = bot('bot_existing', 'existing');
  const fx = fixture({
    bots: [existing],
    secrets: { [existing.secretRef]: 'stable-secret' },
    verifyApp: async () => ({
      name: existing.botName,
      openId: existing.botOpenId,
      activated: existing.activated,
    }),
  });
  await fx.controller.initialize();
  const oldRuntime = fx.runtimes.get(existing.id)[0];

  const started = fx.controller.startCallbackRepair(existing.id, {
    actorOpenId: existing.ownerOpenIds[0],
    chatId: 'oc_repair_chat',
  });
  const duplicate = fx.controller.startCallbackRepair(existing.id, {
    actorOpenId: existing.ownerOpenIds[0],
    chatId: 'oc_repair_chat',
  });
  const attemptId = started.registration.attempt;
  assert.equal(duplicate.registration.attempt, attemptId);
  assert.equal(started.registration.operation, 'callback_repair');
  assert.equal(started.registration.botId, existing.id);

  await waitFor(() => fx.registrationRuns.length === 1);
  const run = fx.registrationRuns.shift();
  assert.equal(run.options.appId, existing.appId);
  assert.equal(run.options.domain, 'accounts.feishu.cn');
  assert.equal(Object.hasOwn(run.options, 'createOnly'), false);
  assert.equal(Object.hasOwn(run.options, 'appPreset'), false);
  assert.deepEqual(run.options.addons, {
    preset: false,
    scopes: {
      tenant: [
        'im:message:readonly',
        'im:resource',
        'application:app_slash_command:read',
        'application:app_slash_command:write',
      ],
    },
    callbacks: { items: ['card.action.trigger'] },
  });
  run.options.onQRCodeReady({
    url: callbackRepairQrUrl(existing.appId),
    expireIn: 60,
  });
  run.resolve({
    client_id: existing.appId,
    client_secret: 'rotated-secret',
    user_info: { open_id: existing.ownerOpenIds[0], tenant_brand: 'feishu' },
  });

  await waitFor(() => fx.controller.registrationStatus(attemptId).registration.state === 'succeeded');
  const result = fx.controller.registrationStatus(attemptId);
  const history = fx.runtimes.get(existing.id);
  assert.equal(result.registration.operation, 'callback_repair');
  assert.equal(result.registration.botId, existing.id);
  assert.equal(result.registration.stage, 'verified');
  assert.deepEqual(fx.configStore.list(), [existing]);
  assert.equal(fx.values.get(existing.secretRef), 'rotated-secret');
  assert.equal(history.length, 2);
  assert.equal(oldRuntime.stops, 1);
  assert.equal(history[1].appSecret, 'rotated-secret');
  assert.deepEqual(history[1].probes, [{
    expectedOperatorOpenId: existing.ownerOpenIds[0],
    timeoutMs: 50,
    chatId: 'oc_repair_chat',
  }]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /rotated-secret|stable-secret|ownerOpenIds|secretRef/,
  );
  await fx.controller.close();
});

test('callback repair with an unchanged secret still refreshes the target runtime before probing', async () => {
  const existing = bot('bot_existing', 'existing');
  const fx = fixture({
    bots: [existing],
    secrets: { [existing.secretRef]: 'stable-secret' },
    verifyApp: async () => ({ openId: existing.botOpenId }),
  });
  await fx.controller.initialize();
  const oldRuntime = fx.runtimes.get(existing.id)[0];
  const started = fx.controller.startCallbackRepair(existing.id);
  const attemptId = started.registration.attempt;
  await waitFor(() => fx.registrationRuns.length === 1);
  const run = fx.registrationRuns.shift();
  run.options.onQRCodeReady({ url: callbackRepairQrUrl(existing.appId), expireIn: 60 });
  run.resolve({
    client_id: existing.appId,
    client_secret: 'stable-secret',
    user_info: { open_id: existing.ownerOpenIds[0], tenant_brand: 'feishu' },
  });

  await waitFor(() => fx.controller.registrationStatus(attemptId).registration.state === 'succeeded');
  const history = fx.runtimes.get(existing.id);
  assert.equal(history.length, 2);
  assert.equal(oldRuntime.stops, 1);
  assert.deepEqual(oldRuntime.probes, []);
  assert.deepEqual(history[1].probes, [{
    expectedOperatorOpenId: existing.ownerOpenIds[0],
    timeoutMs: 50,
  }]);
  await fx.controller.close();
});

test('close drains a repair runtime created after delayed credential verification', async () => {
  const existing = bot('bot_existing', 'existing');
  let releaseVerify;
  const verifyGate = new Promise((resolve) => { releaseVerify = resolve; });
  const fx = fixture({
    bots: [existing],
    secrets: { [existing.secretRef]: 'stable-secret' },
    verifyApp: async () => {
      await verifyGate;
      return { openId: existing.botOpenId };
    },
  });
  await fx.controller.initialize();
  const oldRuntime = fx.runtimes.get(existing.id)[0];
  const started = fx.controller.startCallbackRepair(existing.id);
  const attemptId = started.registration.attempt;
  await waitFor(() => fx.registrationRuns.length === 1);
  const run = fx.registrationRuns.shift();
  run.options.onQRCodeReady({ url: callbackRepairQrUrl(existing.appId), expireIn: 60 });
  run.resolve({
    client_id: existing.appId,
    client_secret: 'rotated-secret',
    user_info: { open_id: existing.ownerOpenIds[0], tenant_brand: 'feishu' },
  });
  await waitFor(() => fx.controller.registrationStatus(attemptId).registration.state === 'saving');

  const closing = fx.controller.close();
  await waitFor(() => oldRuntime.stops === 1);
  releaseVerify();
  await closing;

  const history = fx.runtimes.get(existing.id);
  assert.equal(history.length, 2);
  assert.equal(history[1].starts, 1);
  assert.equal(history[1].stops, 1);
  assert.equal(fx.values.get(existing.secretRef), 'rotated-secret');
  assert.equal(fx.controller.status().totals.connected, 0);
});

test('close waits for a delayed callback probe before its final runtime drain', async () => {
  const existing = bot('bot_existing', 'existing');
  let releaseProbe;
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  const fx = fixture({
    bots: [existing],
    secrets: { [existing.secretRef]: 'stable-secret' },
    verifyApp: async () => ({ openId: existing.botOpenId }),
    callbackProbe: async () => probeGate,
  });
  await fx.controller.initialize();
  const started = fx.controller.startCallbackRepair(existing.id);
  const attemptId = started.registration.attempt;
  await waitFor(() => fx.registrationRuns.length === 1);
  const run = fx.registrationRuns.shift();
  run.options.onQRCodeReady({ url: callbackRepairQrUrl(existing.appId), expireIn: 60 });
  run.resolve({
    client_id: existing.appId,
    client_secret: 'rotated-secret',
    user_info: { open_id: existing.ownerOpenIds[0], tenant_brand: 'feishu' },
  });
  await waitFor(() => fx.runtimes.get(existing.id)?.at(-1).probes.length === 1);

  let closeFinished = false;
  const closing = fx.controller.close().then(() => { closeFinished = true; });
  await flush();
  assert.equal(closeFinished, false);
  releaseProbe({ verified: true });
  await closing;

  const history = fx.runtimes.get(existing.id);
  assert.equal(history.length, 2);
  assert.equal(history[1].stops, 1);
  assert.equal(closeFinished, true);
  assert.equal(fx.controller.status().totals.connected, 0);
});

test('web callback repair accepts wildcard visibility but probes the precise SDK operator', async () => {
  const existing = bot('bot_existing', 'existing');
  existing.ownerOpenIds = ['*'];
  const fx = fixture({
    bots: [existing],
    secrets: { [existing.secretRef]: 'stable-secret' },
    verifyApp: async () => ({ openId: existing.botOpenId }),
  });
  await fx.controller.initialize();
  const oldRuntime = fx.runtimes.get(existing.id)[0];
  const started = fx.controller.startCallbackRepair(existing.id);
  const attemptId = started.registration.attempt;
  await waitFor(() => fx.registrationRuns.length === 1);
  const run = fx.registrationRuns.shift();
  run.options.onQRCodeReady({ url: callbackRepairQrUrl(existing.appId), expireIn: 60 });
  run.resolve({
    client_id: existing.appId,
    client_secret: 'stable-secret',
    user_info: { open_id: 'ou_sdk_operator', tenant_brand: 'feishu' },
  });

  await waitFor(() => fx.controller.registrationStatus(attemptId).registration.state === 'succeeded');
  assert.deepEqual(fx.configStore.list(), [existing]);
  const history = fx.runtimes.get(existing.id);
  assert.equal(history.length, 2);
  assert.equal(oldRuntime.stops, 1);
  assert.deepEqual(history[1].probes, [{
    expectedOperatorOpenId: 'ou_sdk_operator',
    timeoutMs: 50,
  }]);
  await fx.controller.close();
});

test('chat callback repair has no separate administrator role', async () => {
  const existing = bot('bot_existing', 'existing');
  const fx = fixture({
    bots: [existing],
    secrets: { [existing.secretRef]: 'stable-secret' },
    verifyApp: async () => ({ openId: existing.botOpenId }),
  });
  await fx.controller.initialize();
  const runtime = fx.runtimes.get(existing.id)[0];
  const started = fx.controller.startCallbackRepair(existing.id, {
    actorOpenId: existing.ownerOpenIds[0],
    chatId: 'oc_owner_chat',
  });
  const attemptId = started.registration.attempt;
  await waitFor(() => fx.registrationRuns.length === 1);
  const run = fx.registrationRuns.shift();
  run.options.onQRCodeReady({ url: callbackRepairQrUrl(existing.appId), expireIn: 60 });
  run.resolve({
    client_id: existing.appId,
    client_secret: 'rotated-secret',
    user_info: { open_id: 'ou_different_operator', tenant_brand: 'feishu' },
  });

  await waitFor(() => fx.controller.registrationStatus(attemptId).registration.state === 'succeeded');
  const result = fx.controller.registrationStatus(attemptId);
  assert.equal(result.registration.stage, 'verified');
  assert.equal(fx.values.get(existing.secretRef), 'rotated-secret');
  const history = fx.runtimes.get(existing.id);
  assert.equal(history.length, 2);
  assert.equal(runtime.stops, 1);
  assert.deepEqual(history[1].probes, [{
    expectedOperatorOpenId: existing.ownerOpenIds[0],
    timeoutMs: 50,
    chatId: 'oc_owner_chat',
  }]);
  await fx.controller.close();
});

test('callback repair rejects an app mismatch without changing local bot state', async () => {
  const existing = bot('bot_existing', 'existing');
  let verifyCalls = 0;
  const fx = fixture({
    bots: [existing],
    secrets: { [existing.secretRef]: 'stable-secret' },
    verifyApp: async () => {
      verifyCalls += 1;
      return { openId: existing.botOpenId };
    },
  });
  await fx.controller.initialize();
  const runtime = fx.runtimes.get(existing.id)[0];
  const started = fx.controller.startCallbackRepair(existing.id);
  const attemptId = started.registration.attempt;
  await waitFor(() => fx.registrationRuns.length === 1);
  const run = fx.registrationRuns.shift();
  run.options.onQRCodeReady({ url: callbackRepairQrUrl(existing.appId), expireIn: 60 });
  run.resolve({
    client_id: 'cli_wrong_app',
    client_secret: 'wrong-secret',
    user_info: { open_id: existing.ownerOpenIds[0], tenant_brand: 'feishu' },
  });

  await waitFor(() => fx.controller.registrationStatus(attemptId).registration.state === 'error');
  const result = fx.controller.registrationStatus(attemptId);
  assert.equal(result.registration.error.code, 'repair_app_mismatch');
  assert.equal(verifyCalls, 0);
  assert.deepEqual(fx.configStore.list(), [existing]);
  assert.equal(fx.values.get(existing.secretRef), 'stable-secret');
  assert.equal(fx.runtimes.get(existing.id).length, 1);
  assert.equal(runtime.stops, 0);
  assert.deepEqual(runtime.probes, []);
  assert.doesNotMatch(JSON.stringify(result), /wrong-secret/);
  await fx.controller.close();
});

test('callback probe timeout keeps the verified rotated secret and ready runtime', async () => {
  const existing = bot('bot_existing', 'existing');
  const fx = fixture({
    bots: [existing],
    secrets: { [existing.secretRef]: 'stable-secret' },
    verifyApp: async () => ({ openId: existing.botOpenId }),
    callbackProbe: async () => {
      const error = new Error('probe timed out with sensitive diagnostics');
      error.code = 'card_action_probe_timeout';
      throw error;
    },
  });
  await fx.controller.initialize();
  const started = fx.controller.startCallbackRepair(existing.id);
  const attemptId = started.registration.attempt;
  await waitFor(() => fx.registrationRuns.length === 1);
  const run = fx.registrationRuns.shift();
  run.options.onQRCodeReady({ url: callbackRepairQrUrl(existing.appId), expireIn: 60 });
  run.resolve({
    client_id: existing.appId,
    client_secret: 'rotated-secret',
    user_info: { open_id: existing.ownerOpenIds[0], tenant_brand: 'feishu' },
  });

  await waitFor(() => fx.controller.registrationStatus(attemptId).registration.state === 'error');
  const result = fx.controller.registrationStatus(attemptId);
  const history = fx.runtimes.get(existing.id);
  assert.equal(result.registration.error.code, 'card_action_probe_timeout');
  assert.equal(result.registration.stage, 'awaiting_callback');
  assert.equal(fx.values.get(existing.secretRef), 'rotated-secret');
  assert.equal(history.length, 2);
  assert.equal(history.at(-1).appSecret, 'rotated-secret');
  assert.equal(result.bots[0].connected, true);
  assert.doesNotMatch(JSON.stringify(result), /sensitive diagnostics|rotated-secret/);
  await fx.controller.close();
});

test('callback repair restart failure keeps the remotely committed secret for reconnect', async () => {
  const existing = bot('bot_existing', 'existing');
  const fx = fixture({
    bots: [existing],
    secrets: { [existing.secretRef]: 'stable-secret' },
    verifyApp: async () => ({ openId: existing.botOpenId }),
    runtimeStart: async ({ runtime }) => {
      if (runtime.appSecret === 'rotated-secret') throw new Error('new secret handshake failed');
    },
  });
  await fx.controller.initialize();
  const started = fx.controller.startCallbackRepair(existing.id);
  const attemptId = started.registration.attempt;
  await waitFor(() => fx.registrationRuns.length === 1);
  const run = fx.registrationRuns.shift();
  run.options.onQRCodeReady({ url: callbackRepairQrUrl(existing.appId), expireIn: 60 });
  run.resolve({
    client_id: existing.appId,
    client_secret: 'rotated-secret',
    user_info: { open_id: existing.ownerOpenIds[0], tenant_brand: 'feishu' },
  });

  await waitFor(() => fx.controller.registrationStatus(attemptId).registration.state === 'error');
  const result = fx.controller.registrationStatus(attemptId);
  assert.equal(result.registration.error.code, 'repair_connection_failed');
  assert.deepEqual(fx.configStore.list(), [existing]);
  assert.equal(fx.values.get(existing.secretRef), 'rotated-secret');
  assert.equal(fx.runtimes.get(existing.id).length, 2);
  assert.equal(fx.runtimes.get(existing.id).at(-1).appSecret, 'rotated-secret');
  assert.equal(result.bots[0].connected, false);
  assert.equal(result.bots[0].error.code, 'connection_failed');
  assert.doesNotMatch(JSON.stringify(result), /new secret handshake failed|rotated-secret/);
  await fx.controller.close();
});

test('callback repair leaves the existing runtime intact when the new secret cannot be stored', async () => {
  const existing = bot('bot_existing', 'existing');
  const fx = fixture({
    bots: [existing],
    secrets: { [existing.secretRef]: 'stable-secret' },
    verifyApp: async () => ({ openId: existing.botOpenId }),
    credentialSet: async () => { throw new Error('credential provider is read-only'); },
  });
  await fx.controller.initialize();
  const runtime = fx.runtimes.get(existing.id)[0];
  const started = fx.controller.startCallbackRepair(existing.id);
  const attemptId = started.registration.attempt;
  await waitFor(() => fx.registrationRuns.length === 1);
  const run = fx.registrationRuns.shift();
  run.options.onQRCodeReady({ url: callbackRepairQrUrl(existing.appId), expireIn: 60 });
  run.resolve({
    client_id: existing.appId,
    client_secret: 'rotated-secret',
    user_info: { open_id: existing.ownerOpenIds[0], tenant_brand: 'feishu' },
  });

  await waitFor(() => fx.controller.registrationStatus(attemptId).registration.state === 'error');
  const result = fx.controller.registrationStatus(attemptId);
  assert.equal(result.registration.error.code, 'credential_update_failed');
  assert.equal(fx.values.get(existing.secretRef), 'stable-secret');
  assert.equal(fx.runtimes.get(existing.id).length, 1);
  assert.equal(runtime.stops, 0);
  assert.equal(result.bots[0].connected, true);
  assert.doesNotMatch(JSON.stringify(result), /credential provider is read-only|rotated-secret/);
  await fx.controller.close();
});

test('runtime repair capability is bot-bound and can cancel a pre-commit attempt', async () => {
  const alpha = bot('bot_alpha', 'alpha');
  const beta = bot('bot_beta', 'beta');
  const fx = fixture({
    bots: [alpha, beta],
    secrets: { [alpha.secretRef]: 'secret-a', [beta.secretRef]: 'secret-b' },
  });
  await fx.controller.initialize();
  const alphaRepair = fx.runtimes.get(alpha.id)[0].repair;
  const betaRepair = fx.runtimes.get(beta.id)[0].repair;

  const started = alphaRepair.start({
    actorOpenId: alpha.ownerOpenIds[0],
    chatId: 'oc_alpha',
  });
  const attemptId = started.registration.attempt;
  assert.equal(started.registration.botId, alpha.id);
  assert.equal(alphaRepair.status({ attemptId }).registration.attempt, attemptId);
  assert.equal(betaRepair.status({ attemptId }), null);
  const cancelled = await alphaRepair.cancel({ attemptId });
  assert.equal(cancelled.registration.state, 'cancelled');
  assert.deepEqual(fx.configStore.list(), [alpha, beta]);
  assert.equal(fx.values.get(alpha.secretRef), 'secret-a');
  assert.equal(fx.values.get(beta.secretRef), 'secret-b');
  assert.equal(fx.runtimes.get(alpha.id).length, 1);
  assert.equal(fx.runtimes.get(beta.id).length, 1);
  await fx.controller.close();
});

test('manual Feishu credentials are verified, stored host-side, and use app visibility for access', async () => {
  const fx = fixture({ createBotIds: ['bot_manual'] });

  const status = await fx.controller.bindCredentials({
    appId: 'cli_manual',
    appSecret: 'manual-private-secret',
  });

  assert.equal(status.totals.connected, 1);
  assert.equal(fx.configStore.bots.length, 1);
  assert.deepEqual(fx.configStore.bots[0].ownerOpenIds, ['*']);
  assert.equal(fx.values.get(fx.configStore.bots[0].secretRef), 'manual-private-secret');
  assert.equal(fx.runtimes.get('bot_manual')[0].appSecret, 'manual-private-secret');
  assert.doesNotMatch(JSON.stringify(status), /manual-private-secret|ownerOpenIds|secretRef/);
  await fx.controller.close();
});

test('initialization isolates failures and starts every bot with available credentials', async () => {
  const missing = bot('bot_missing', 'missing');
  const healthy = bot('bot_healthy', 'healthy');
  const fx = fixture({
    bots: [missing, healthy],
    secrets: { [healthy.secretRef]: 'healthy-secret' },
    failResolveRefs: new Set([missing.secretRef]),
  });

  await fx.controller.initialize();
  const status = fx.controller.status();

  assert.equal(status.totals.configured, 2);
  assert.equal(status.totals.connected, 1);
  assert.equal(status.bots.find((entry) => entry.botId === missing.id).phase, 'error');
  assert.equal(status.bots.find((entry) => entry.botId === healthy.id).connected, true);
  assert.equal(fx.runtimes.has(missing.id), false);
  assert.equal(fx.runtimes.get(healthy.id).length, 1);
  assert.doesNotMatch(JSON.stringify(status), /healthy-secret|DSH_FEISHU_APP_SECRET|ou_healthy/);
});

test('repeated initialization never restarts an already healthy bot', async () => {
  const healthy = bot('bot_healthy', 'healthy');
  const fx = fixture({
    bots: [healthy],
    secrets: { [healthy.secretRef]: 'healthy-secret' },
  });

  await fx.controller.initialize();
  await fx.controller.initialize();

  assert.equal(fx.controller.status().totals.connected, 1);
  assert.equal(fx.runtimes.get(healthy.id).length, 1);
  assert.equal(fx.runtimes.get(healthy.id)[0].starts, 1);
  assert.equal(fx.runtimes.get(healthy.id)[0].stops, 0);
});

test('connection test uses the selected bot runtime and shared message copy', async () => {
  const healthy = bot('bot_healthy', 'healthy');
  healthy.appId = 'cli_healthy_1234567890';
  const fx = fixture({
    bots: [healthy],
    secrets: { [healthy.secretRef]: 'healthy-secret' },
  });

  await fx.controller.initialize();
  assert.deepEqual(await fx.controller.sendConnectionTest(healthy.id), { sent: true });
  assert.deepEqual(fx.runtimes.get(healthy.id)[0].sentTests, [
    '✅ DeepSeek Harness 连接测试成功\n这条消息由「IM机器人」设置页中的“机器人 healthy（cli_heal••••7890）”机器人卡片发出。',
  ]);
  const target = { kind: 'group', route: { chatId: 'oc_target' } };
  assert.deepEqual(await fx.controller.sendProactiveText(healthy.id, target, '主动投递'), {
    sent: true,
  });
  assert.deepEqual(fx.runtimes.get(healthy.id)[0].proactiveSends, [[target, '主动投递', {}]]);
  await fx.controller.close();
});

test('multiple scans create independent bots, credential refs and runtimes', async () => {
  const fx = fixture({ createBotIds: ['bot_alpha', 'bot_beta'] });
  const alpha = completeScan(fx, {
    client_id: 'cli_alpha', client_secret: 'secret-alpha',
    user_info: { open_id: 'ou_alpha', tenant_brand: 'feishu' },
  });
  const beta = completeScan(fx, {
    client_id: 'cli_beta', client_secret: 'secret-beta',
    user_info: { open_id: 'ou_beta', tenant_brand: 'feishu' },
  });
  const [alphaStatus, betaStatus] = await Promise.all([alpha, beta]);

  assert.equal(alphaStatus.registration.state, 'succeeded');
  assert.equal(betaStatus.registration.state, 'succeeded');
  assert.equal(fx.configStore.list().length, 2);
  const [first, second] = fx.configStore.list();
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.secretRef, second.secretRef);
  assert.match(first.secretRef, /^[A-Za-z_][A-Za-z0-9_]*$/);
  assert.equal(fx.runtimes.get(first.id).length, 1);
  assert.equal(fx.runtimes.get(second.id).length, 1);
  assert.equal(fx.controller.status().totals.connected, 2);
});

test('scanning an existing app is idempotent and reuses its bot and secret ref', async () => {
  const existing = bot('bot_existing', 'existing');
  const fx = fixture({
    bots: [existing],
    secrets: { [existing.secretRef]: 'old-secret' },
  });
  await fx.controller.initialize();
  const completed = await completeScan(fx, {
    client_id: existing.appId,
    client_secret: 'rotated-secret',
    user_info: { open_id: 'ou_second_owner', tenant_brand: 'feishu' },
  });

  assert.equal(completed.registration.state, 'succeeded');
  assert.equal(completed.registration.botId, existing.id);
  assert.equal(fx.configStore.list().length, 1);
  assert.equal(fx.configStore.list()[0].secretRef, existing.secretRef);
  assert.deepEqual(fx.configStore.list()[0].ownerOpenIds.sort(), ['ou_existing', 'ou_second_owner']);
  assert.equal(fx.values.get(existing.secretRef), 'rotated-secret');
  assert.equal(fx.runtimes.get(existing.id).length, 2);
  assert.equal(fx.runtimes.get(existing.id)[0].stops, 1);
});

test('deleting one bot clears only its secret and leaves the other runtime online', async () => {
  const alpha = bot('bot_alpha', 'alpha');
  const beta = bot('bot_beta', 'beta');
  const fx = fixture({
    bots: [alpha, beta],
    secrets: { [alpha.secretRef]: 'secret-a', [beta.secretRef]: 'secret-b' },
  });
  await fx.controller.initialize();
  const alphaRuntime = fx.runtimes.get(alpha.id)[0];
  const betaRuntime = fx.runtimes.get(beta.id)[0];

  const status = await fx.controller.deleteBot(alpha.id);

  assert.deepEqual(fx.unsetCalls, [alpha.secretRef]);
  assert.equal(fx.values.has(alpha.secretRef), false);
  assert.equal(fx.values.get(beta.secretRef), 'secret-b');
  assert.equal(alphaRuntime.stops, 1);
  assert.equal(betaRuntime.stops, 0);
  assert.equal(status.totals.configured, 1);
  assert.equal(status.totals.connected, 1);
  assert.equal(status.bots[0].botId, beta.id);
});

test('cancelling a terminal attempt is a no-op and cannot roll back a newer same-app scan', async () => {
  const existing = bot('bot_existing', 'existing');
  const fx = fixture({
    bots: [existing],
    secrets: { [existing.secretRef]: 'original-secret' },
  });
  await fx.controller.initialize();
  const first = await completeScan(fx, {
    client_id: existing.appId, client_secret: 'first-secret',
    user_info: { open_id: 'ou_first', tenant_brand: 'feishu' },
  });
  const oldAttemptId = first.registration.attempt;
  const second = await completeScan(fx, {
    client_id: existing.appId, client_secret: 'newest-secret',
    user_info: { open_id: 'ou_second', tenant_brand: 'feishu' },
  });

  const cancelled = await fx.controller.cancelRegistration(oldAttemptId);

  assert.equal(cancelled.registration.state, 'succeeded');
  assert.equal(second.registration.botId, existing.id);
  assert.equal(fx.configStore.list().length, 1);
  assert.equal(fx.values.get(existing.secretRef), 'newest-secret');
  assert.equal(fx.controller.status().bots[0].connected, true);
});

test('credential removal failure is retriable and cannot affect another bot', async () => {
  const alpha = bot('bot_alpha', 'alpha');
  const beta = bot('bot_beta', 'beta');
  const fx = fixture({
    bots: [alpha, beta],
    secrets: { [alpha.secretRef]: 'secret-a', [beta.secretRef]: 'secret-b' },
    failUnsetRefs: new Set([alpha.secretRef]),
  });
  await fx.controller.initialize();
  const betaRuntime = fx.runtimes.get(beta.id)[0];

  await assert.rejects(fx.controller.deleteBot(alpha.id), /remove the Feishu credential/);

  assert.equal(fx.configStore.list().length, 2);
  assert.equal(fx.values.get(alpha.secretRef), 'secret-a');
  assert.equal(fx.values.get(beta.secretRef), 'secret-b');
  assert.equal(betaRuntime.stops, 0);
  assert.equal(fx.controller.status().bots.find((entry) => entry.botId === alpha.id).error.code,
    'credential_removal_failed');

  // Deletion intent is durable. Even though the immutable secret still
  // exists, a fresh controller must not resurrect this bot on restart.
  const restarted = fixture({
    bots: fx.configStore.list(),
    secrets: Object.fromEntries(fx.values),
  });
  await restarted.controller.initialize();
  assert.equal(restarted.runtimes.has(alpha.id), false);
  assert.equal(restarted.controller.status().bots.find((entry) => entry.botId === alpha.id).error.code,
    'deletion_pending');
  assert.equal(restarted.controller.status().bots.find((entry) => entry.botId === beta.id).connected, true);
});

test('one bot activation failure does not stop a healthy existing bot', async () => {
  const healthy = bot('bot_healthy', 'healthy');
  const fx = fixture({
    bots: [healthy],
    secrets: { [healthy.secretRef]: 'healthy-secret' },
    createBotIds: ['bot_failure'],
    runtimeStart: async ({ botId }) => {
      if (botId === 'bot_failure') throw new Error('new bot handshake failed');
    },
  });
  await fx.controller.initialize();
  const healthyRuntime = fx.runtimes.get(healthy.id)[0];
  const result = await completeScan(fx, {
    client_id: 'cli_failure', client_secret: 'failure-secret',
    user_info: { open_id: 'ou_failure', tenant_brand: 'feishu' },
  });

  assert.equal(result.registration.state, 'error');
  assert.equal(healthyRuntime.stops, 0);
  assert.equal(fx.controller.status().bots.find((entry) => entry.botId === healthy.id).connected, true);
  assert.equal(fx.controller.status().bots.find((entry) => entry.botId === 'bot_failure').phase, 'error');
});

test('close during credential activation cannot leave a late runtime or bot behind', async () => {
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const fx = fixture({
    createBotIds: ['bot_closing'],
    runtimeStart: async ({ botId }) => {
      if (botId === 'bot_closing') await startGate;
    },
  });
  const started = fx.controller.startRegistration();
  const attemptId = started.registration.attempt;
  await waitFor(() => fx.registrationRuns.length === 1);
  const run = fx.registrationRuns.shift();
  run.options.onQRCodeReady({ url: 'https://accounts.feishu.cn/closing', expireIn: 60 });
  run.resolve({
    client_id: 'cli_closing', client_secret: 'closing-secret',
    user_info: { open_id: 'ou_closing', tenant_brand: 'feishu' },
  });
  await waitFor(() => fx.controller.registrationStatus(attemptId).registration.state === 'saving');

  const closing = fx.controller.close();
  releaseStart();
  await closing;

  assert.equal(fx.configStore.list().length, 0);
  assert.equal(fx.values.size, 0);
  assert.equal(fx.controller.status().totals.connected, 0);
  assert.equal(fx.runtimes.get('bot_closing').at(-1).stops > 0, true);
  assert.throws(() => fx.controller.startRegistration(), /closed/);
});

test('a failed repeat-scan restores the previously healthy config, secret and runtime', async () => {
  const existing = bot('bot_existing', 'existing');
  const fx = fixture({
    bots: [existing],
    secrets: { [existing.secretRef]: 'stable-secret' },
    runtimeStart: async ({ runtime }) => {
      if (runtime.appSecret === 'bad-rotated-secret') throw new Error('new handshake failed');
    },
  });
  await fx.controller.initialize();
  const result = await completeScan(fx, {
    client_id: existing.appId,
    client_secret: 'bad-rotated-secret',
    user_info: { open_id: 'ou_new_owner', tenant_brand: 'feishu' },
  });

  assert.equal(result.registration.state, 'error');
  assert.deepEqual(fx.configStore.list()[0], existing);
  assert.equal(fx.values.get(existing.secretRef), 'stable-secret');
  assert.equal(fx.controller.status().bots[0].connected, true);
  assert.equal(fx.runtimes.get(existing.id).length, 3);
  assert.equal(fx.runtimes.get(existing.id).at(-1).appSecret, 'stable-secret');
});

test('state cleanup failure keeps the bot visible and retryable with no live credential', async () => {
  const existing = bot('bot_existing', 'existing');
  const fx = fixture({
    bots: [existing],
    secrets: { [existing.secretRef]: 'stable-secret' },
    deleteState: async () => { throw new Error('state file is busy'); },
  });
  await fx.controller.initialize();

  await assert.rejects(fx.controller.deleteBot(existing.id), /session state/);

  assert.equal(fx.configStore.list().length, 1);
  assert.equal(fx.values.has(existing.secretRef), false);
  const visible = fx.controller.status().bots[0];
  assert.equal(visible.botId, existing.id);
  assert.equal(visible.error.code, 'state_cleanup_failed');
  assert.equal(visible.connected, false);
});

test('cancelling after a successful replacement start restores the old runtime exactly once', async () => {
  const existing = bot('bot_existing', 'existing');
  let releaseReplacement;
  const replacementGate = new Promise((resolve) => { releaseReplacement = resolve; });
  const fx = fixture({
    bots: [existing],
    secrets: { [existing.secretRef]: 'stable-secret' },
    runtimeStart: async ({ runtime }) => {
      if (runtime.appSecret === 'replacement-secret') await replacementGate;
    },
  });
  await fx.controller.initialize();
  const started = fx.controller.startRegistration();
  const attemptId = started.registration.attempt;
  await waitFor(() => fx.registrationRuns.length === 1);
  const run = fx.registrationRuns.shift();
  run.options.onQRCodeReady({ url: 'https://accounts.feishu.cn/replacement', expireIn: 60 });
  run.resolve({
    client_id: existing.appId,
    client_secret: 'replacement-secret',
    user_info: { open_id: 'ou_replacement', tenant_brand: 'feishu' },
  });
  await waitFor(() => fx.runtimes.get(existing.id)?.length === 2);

  const cancelling = fx.controller.cancelRegistration(attemptId);
  releaseReplacement();
  await cancelling;

  const history = fx.runtimes.get(existing.id);
  assert.equal(history.length, 3);
  assert.equal(history[1].appSecret, 'replacement-secret');
  assert.equal(history[1].stops, 1);
  assert.equal(history[2].appSecret, 'stable-secret');
  assert.equal(history[2].starts, 1);
  assert.deepEqual(fx.configStore.list()[0], existing);
  assert.equal(fx.values.get(existing.secretRef), 'stable-secret');
});

test('a cancelled replacement whose start rejects still restores the old runtime', async () => {
  const existing = bot('bot_existing', 'existing');
  let releaseReplacement;
  const replacementGate = new Promise((resolve) => { releaseReplacement = resolve; });
  const fx = fixture({
    bots: [existing],
    secrets: { [existing.secretRef]: 'stable-secret' },
    runtimeStart: async ({ runtime }) => {
      if (runtime.appSecret === 'replacement-secret') {
        await replacementGate;
        throw new Error('replacement handshake rejected');
      }
    },
  });
  await fx.controller.initialize();
  const started = fx.controller.startRegistration();
  const attemptId = started.registration.attempt;
  await waitFor(() => fx.registrationRuns.length === 1);
  const run = fx.registrationRuns.shift();
  run.options.onQRCodeReady({ url: 'https://accounts.feishu.cn/replacement-reject', expireIn: 60 });
  run.resolve({
    client_id: existing.appId,
    client_secret: 'replacement-secret',
    user_info: { open_id: 'ou_replacement', tenant_brand: 'feishu' },
  });
  await waitFor(() => fx.runtimes.get(existing.id)?.length === 2);

  const cancelling = fx.controller.cancelRegistration(attemptId);
  releaseReplacement();
  await cancelling;

  const history = fx.runtimes.get(existing.id);
  assert.equal(history.length, 3);
  assert.equal(history.at(-1).appSecret, 'stable-secret');
  assert.equal(history.at(-1).starts, 1);
  assert.deepEqual(fx.configStore.list()[0], existing);
  assert.equal(fx.values.get(existing.secretRef), 'stable-secret');
  assert.equal(fx.controller.status().bots[0].connected, true);
});
