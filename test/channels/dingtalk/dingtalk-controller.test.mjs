import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveDingtalkBotIdentity,
} from '../../../src/channels/dingtalk/config-store.mjs';
import { DingtalkController } from '../../../src/channels/dingtalk/dingtalk-controller.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function credentialsFixture(events = []) {
  const values = new Map();
  return {
    values,
    provider: {
      resolve: async (ref) => values.has(ref)
        ? { configured: true, source: 'settings', value: values.get(ref) }
        : { configured: false },
      set: async (ref, value) => {
        events.push(['set', ref]);
        values.set(ref, value);
      },
      unset: async (ref) => {
        events.push(['unset', ref]);
        values.delete(ref);
      },
    },
  };
}

function configFixture(initial = [], events = []) {
  const bots = new Map(initial.map((bot) => [bot.botId, structuredClone(bot)]));
  return {
    bots,
    store: {
      list: () => [...bots.values()].map((bot) => structuredClone(bot)),
      get: (botId) => bots.has(botId) ? structuredClone(bots.get(botId)) : null,
      getByClientId: (clientId) => {
        const found = [...bots.values()].find((bot) => bot.clientId === clientId);
        return found ? structuredClone(found) : null;
      },
      save: async (bot) => {
        events.push(['save', bot.botId]);
        bots.set(bot.botId, structuredClone(bot));
        return structuredClone(bot);
      },
      remove: async (botId) => {
        events.push(['remove', botId]);
        const value = bots.get(botId) ?? null;
        bots.delete(botId);
        return value;
      },
    },
  };
}

function runtimeFactory({ events = [], pendingByClient = new Map(), failStart = false } = {}) {
  const runtimes = [];
  const connectionTests = [];
  const proactiveSends = [];
  return {
    runtimes,
    connectionTests,
    proactiveSends,
    createRuntime: async ({ botId, config, clientSecret }) => {
      events.push(['create', botId]);
      let ready = false;
      const approvedIds = new Set(config.approvedSenders.map((sender) => sender.staffId));
      const pending = (pendingByClient.get(config.clientId) ?? [])
        .filter((sender) => !approvedIds.has(sender.staffId));
      const runtime = {
        botId,
        config,
        clientSecret,
        get status() {
          return {
            ready,
            state: ready ? 'connected' : 'offline',
            pendingSenders: pending,
            messagesReceived: 2,
            messagesReplied: 1,
          };
        },
        pendingSender(requestId) {
          return pending.find((sender) => sender.requestId === requestId) ?? null;
        },
        async start() {
          events.push(['start', botId]);
          if (typeof failStart === 'function' ? failStart() : failStart) {
            throw new Error('runtime failure containing private-secret');
          }
          ready = true;
        },
        async stop() {
          events.push(['stop', botId]);
          ready = false;
        },
        async sendConnectionTest(text) {
          connectionTests.push({ botId, text });
        },
        async sendProactiveText(...args) {
          proactiveSends.push({ botId, args });
          return { sent: true };
        },
      };
      runtimes.push(runtime);
      return runtime;
    },
  };
}

function successfulDeviceAuth(clientId = 'ding-client-private', clientSecret = 'client-secret-private') {
  return {
    start: async () => ({
      deviceCode: 'device-code-private',
      verificationUrl: 'https://oapi.dingtalk.com/verify?code=public-qr-code',
      expiresAt: 100_000,
      pollIntervalMs: 1_000,
    }),
    poll: async ({ deviceCode }) => {
      assert.equal(deviceCode, 'device-code-private');
      return { status: 'SUCCESS', clientId, clientSecret };
    },
  };
}

test('successful QR poll stores secret then config then starts runtime without public leakage', async () => {
  const events = [];
  const credentials = credentialsFixture(events);
  const configs = configFixture([], events);
  const runtimes = runtimeFactory({ events });
  const controller = new DingtalkController({
    deviceAuth: successfulDeviceAuth(),
    credentials: credentials.provider,
    configStore: configs.store,
    createRuntime: runtimes.createRuntime,
    clock: () => 1_000,
  });

  const begun = await controller.startProvisioning();
  assert.equal(begun.status, 'pending');
  assert.doesNotMatch(JSON.stringify(begun), /device-code-private|client-secret-private|secretRef/);
  const completed = await controller.registrationStatus(begun.attemptId);

  assert.equal(completed.status, 'connected');
  assert.match(completed.botId, /^dt_[a-f0-9]{24}$/);
  assert.deepEqual(events.slice(0, 4).map(([event]) => event), ['set', 'save', 'create', 'start']);
  assert.equal(credentials.values.size, 1);
  assert.equal([...credentials.values.values()][0], 'client-secret-private');
  assert.equal(configs.bots.size, 1);
  assert.equal(runtimes.runtimes[0].clientSecret, 'client-secret-private');

  const publicJson = JSON.stringify(controller.status());
  assert.doesNotMatch(
    publicJson,
    /device-code-private|client-secret-private|secretRef|ding-client-private/,
  );
  assert.equal(controller.status().totals.connected, 1);
  await controller.sendConnectionTest(completed.botId);
  assert.equal(runtimes.connectionTests[0].botId, completed.botId);
  assert.match(runtimes.connectionTests[0].text, /DeepSeek Harness 连接测试成功/);
  assert.match(runtimes.connectionTests[0].text, /钉钉机器人（ding••••vate）/);
  const target = { kind: 'user', route: { userId: 'staff-one' } };
  assert.deepEqual(await controller.sendProactiveText(completed.botId, target, '主动投递'), {
    sent: true,
  });
  assert.deepEqual(runtimes.proactiveSends, [{
    botId: completed.botId,
    args: [target, '主动投递', {}],
  }]);
  await controller.close();
});

test('manual DingTalk Client ID and Client Secret binding stores credentials off the public plane', async () => {
  const events = [];
  const credentials = credentialsFixture(events);
  const configs = configFixture([], events);
  const runtimes = runtimeFactory({ events });
  const controller = new DingtalkController({
    deviceAuth: successfulDeviceAuth(),
    credentials: credentials.provider,
    configStore: configs.store,
    createRuntime: runtimes.createRuntime,
    clock: () => 1_000,
  });

  const status = await controller.bindCredentials({
    clientId: 'manual-ding-client',
    clientSecret: 'manual-ding-secret',
  });
  assert.equal(status.totals.connected, 1);
  assert.equal([...credentials.values.values()][0], 'manual-ding-secret');
  assert.equal(runtimes.runtimes[0].clientSecret, 'manual-ding-secret');
  assert.doesNotMatch(JSON.stringify(status), /manual-ding-client|manual-ding-secret|secretRef/);
  await controller.close();
});

test('scanning the same client ID is idempotent and replaces its one runtime', async () => {
  const events = [];
  const credentials = credentialsFixture(events);
  const configs = configFixture([], events);
  const runtimes = runtimeFactory({ events });
  const controller = new DingtalkController({
    deviceAuth: successfulDeviceAuth(),
    credentials: credentials.provider,
    configStore: configs.store,
    createRuntime: runtimes.createRuntime,
    clock: () => 1_000,
  });

  const first = await controller.startProvisioning();
  await controller.registrationStatus(first.attemptId);
  const second = await controller.startProvisioning();
  const completed = await controller.registrationStatus(second.attemptId);

  assert.equal(completed.alreadyConnected, true);
  assert.equal(configs.bots.size, 1);
  assert.equal(credentials.values.size, 1);
  assert.equal(controller.status().bots.length, 1);
  assert.equal(runtimes.runtimes.length, 2);
  assert.equal(runtimes.runtimes[0].status.ready, false);
  assert.equal(runtimes.runtimes[1].status.ready, true);
  await controller.close();
});

test('sender approval uses opaque request and sender keys while raw staff IDs stay host-only', async () => {
  const events = [];
  const identity = deriveDingtalkBotIdentity('ding-client-one');
  const config = {
    ...identity,
    clientId: 'ding-client-one',
    approvedSenders: [],
  };
  const credentials = credentialsFixture(events);
  credentials.values.set(identity.secretRef, 'client-secret-private');
  const configs = configFixture([config], events);
  const pendingByClient = new Map([[
    'ding-client-one',
    [{
      staffId: 'staff-private-one',
      senderNick: '待审批用户',
      requestedAt: '2026-08-15T00:00:00.000Z',
      requestId: 'ding_sender_abc123',
    }],
  ]]);
  const runtimes = runtimeFactory({ events, pendingByClient });
  const controller = new DingtalkController({
    deviceAuth: successfulDeviceAuth(),
    credentials: credentials.provider,
    configStore: configs.store,
    createRuntime: runtimes.createRuntime,
    clock: () => Date.parse('2026-08-15T01:00:00.000Z'),
  });
  await controller.initialize();

  const pending = controller.status().bots[0].senders.pending[0];
  assert.equal(pending.requestId, 'ding_sender_abc123');
  assert.equal(pending.displayName, '待审批用户');
  assert.doesNotMatch(JSON.stringify(controller.status()), /staff-private-one|secretRef/);

  await controller.approveSender(identity.botId, pending.requestId);
  const approvedStatus = controller.status().bots[0].senders;
  assert.equal(approvedStatus.pending.length, 0);
  assert.equal(approvedStatus.approved.length, 1);
  assert.match(approvedStatus.approved[0].senderKey, /^dt_sender_[a-f0-9]{32}$/);
  assert.equal(approvedStatus.approved[0].approvedAt, '2026-08-15T01:00:00.000Z');
  assert.equal(configs.bots.get(identity.botId).approvedSenders[0].staffId, 'staff-private-one');
  assert.doesNotMatch(JSON.stringify(controller.status()), /staff-private-one|client-secret-private/);

  await controller.revokeSender(identity.botId, approvedStatus.approved[0].senderKey);
  assert.equal(configs.bots.get(identity.botId).approvedSenders.length, 0);
  assert.equal(controller.status().bots[0].senders.approved.length, 0);
  await controller.close();
});

test('runtime activation failure retains the authorized bot for reconnect without exposing detail', async () => {
  let startCount = 0;
  const events = [];
  const logs = [];
  const credentials = credentialsFixture(events);
  const configs = configFixture([], events);
  const runtimes = runtimeFactory({ events, failStart: () => startCount++ === 0 });
  const controller = new DingtalkController({
    deviceAuth: successfulDeviceAuth(),
    credentials: credentials.provider,
    configStore: configs.store,
    createRuntime: runtimes.createRuntime,
    logger: { error: (...args) => logs.push(args), warn() {} },
    clock: () => 1_000,
  });
  const begun = await controller.startProvisioning();
  const completed = await controller.registrationStatus(begun.attemptId);

  assert.equal(completed.status, 'connected');
  assert.equal(credentials.values.size, 1);
  assert.equal(configs.bots.size, 1);
  const status = controller.status();
  assert.deepEqual(status.totals, { configured: 1, connected: 0 });
  assert.equal(status.bots[0].state, 'error');
  assert.equal(status.bots[0].error.code, 'stream-connect-failed');
  assert.match(status.bots[0].error.referenceId, /^DT-CONN-[A-F0-9]{8}$/);
  assert.match(status.bots[0].error.hint, /dsh web 日志/);
  assert.equal(logs.length, 1);
  assert.match(logs[0][0], new RegExp(status.bots[0].error.referenceId));
  assert.equal(JSON.parse(logs[0][0].slice(logs[0][0].indexOf('{'))).code, 'stream-connect-failed');
  assert.equal(events.some(([event]) => event === 'unset' || event === 'remove'), false);
  assert.doesNotMatch(
    JSON.stringify({ completed, status, logs }),
    /private-secret|client-secret-private|device-code-private|secretRef/,
  );

  const reconnected = await controller.reconnectBot(completed.botId);
  assert.deepEqual(reconnected.totals, { configured: 1, connected: 1 });
  assert.equal(reconnected.bots[0].state, 'connected');
  assert.equal(reconnected.bots[0].error, null);
  assert.equal(credentials.values.size, 1);
  assert.equal(configs.bots.size, 1);
  await controller.close();
});

test('config persistence failure rolls back the newly stored credential', async () => {
  const credentials = credentialsFixture();
  const configs = configFixture();
  const controller = new DingtalkController({
    deviceAuth: successfulDeviceAuth(),
    credentials: credentials.provider,
    configStore: {
      ...configs.store,
      save: async () => {
        throw new Error('config failure containing private-secret');
      },
    },
    createRuntime: runtimeFactory().createRuntime,
    logger: { error() {}, warn() {} },
    clock: () => 1_000,
  });
  const begun = await controller.startProvisioning();
  const failed = await controller.registrationStatus(begun.attemptId);

  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'activation-failed');
  assert.equal(credentials.values.size, 0);
  assert.equal(configs.bots.size, 0);
  assert.doesNotMatch(JSON.stringify(failed), /private-secret|client-secret-private|device-code-private/);
  await controller.close();
});

test('cancelling while the persisted bot is starting rolls its binding back', async () => {
  const credentials = credentialsFixture();
  const configs = configFixture();
  let enteredStart;
  let releaseStart;
  const startEntered = new Promise((resolve) => { enteredStart = resolve; });
  const controller = new DingtalkController({
    deviceAuth: successfulDeviceAuth(),
    credentials: credentials.provider,
    configStore: configs.store,
    createRuntime: async () => ({
      status: { ready: false },
      start: async () => new Promise((resolve) => {
        releaseStart = resolve;
        enteredStart();
      }),
      stop: async () => {},
    }),
    logger: { error() {}, warn() {} },
    clock: () => 1_000,
  });
  const begun = await controller.startProvisioning();
  const polling = controller.registrationStatus(begun.attemptId);
  await startEntered;
  assert.equal(credentials.values.size, 1);
  assert.equal(configs.bots.size, 1);

  const cancelling = controller.cancelProvisioning(begun.attemptId);
  releaseStart();
  const [cancelled, polled] = await Promise.all([cancelling, polling]);

  assert.equal(cancelled.status, 'cancelled');
  assert.equal(polled.status, 'cancelled');
  assert.equal(credentials.values.size, 0);
  assert.equal(configs.bots.size, 0);
  await controller.close();
});

test('cancelling an in-flight poll aborts it and writes no credential', async () => {
  const credentials = credentialsFixture();
  const configs = configFixture();
  const controller = new DingtalkController({
    deviceAuth: {
      start: successfulDeviceAuth().start,
      poll: async ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
    },
    credentials: credentials.provider,
    configStore: configs.store,
    createRuntime: runtimeFactory().createRuntime,
    clock: () => 1_000,
  });
  const begun = await controller.startProvisioning();
  const polling = controller.registrationStatus(begun.attemptId);
  await flush();
  const cancelled = await controller.cancelProvisioning(begun.attemptId);

  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await polling).status, 'cancelled');
  assert.equal(credentials.values.size, 0);
  assert.equal(configs.bots.size, 0);
  await controller.close();
});

test('initialize manages multiple configured bot runtimes independently', async () => {
  const firstIdentity = deriveDingtalkBotIdentity('ding-client-one');
  const secondIdentity = deriveDingtalkBotIdentity('ding-client-two');
  const configs = configFixture([
    { ...firstIdentity, clientId: 'ding-client-one', approvedSenders: [] },
    { ...secondIdentity, clientId: 'ding-client-two', approvedSenders: [] },
  ]);
  const credentials = credentialsFixture();
  credentials.values.set(firstIdentity.secretRef, 'secret-one');
  credentials.values.set(secondIdentity.secretRef, 'secret-two');
  const runtimes = runtimeFactory();
  const controller = new DingtalkController({
    deviceAuth: successfulDeviceAuth(),
    credentials: credentials.provider,
    configStore: configs.store,
    createRuntime: runtimes.createRuntime,
  });

  const status = await controller.initialize();
  assert.deepEqual(status.totals, { configured: 2, connected: 2 });
  assert.equal(runtimes.runtimes.length, 2);
  await controller.close();
});

test('close waits for an in-flight transition and leaves no connected runtime behind', async () => {
  const identity = deriveDingtalkBotIdentity('ding-client-close');
  const configs = configFixture([{
    ...identity,
    clientId: 'ding-client-close',
    approvedSenders: [],
  }]);
  const credentials = credentialsFixture();
  credentials.values.set(identity.secretRef, 'secret-close');
  let rejectStart;
  let stops = 0;
  const controller = new DingtalkController({
    deviceAuth: successfulDeviceAuth(),
    credentials: credentials.provider,
    configStore: configs.store,
    createRuntime: async () => ({
      status: { ready: false },
      start: async () => new Promise((_, reject) => { rejectStart = reject; }),
      stop: async () => {
        stops += 1;
        rejectStart?.(new DOMException('Runtime stopped', 'AbortError'));
      },
    }),
    logger: { warn() {}, error() {} },
  });

  const initializing = controller.initialize();
  await flush();
  const closing = controller.close();
  await Promise.race([
    closing,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('controller close did not stop the provisional runtime')),
      100,
    )),
  ]);
  await Promise.allSettled([initializing, closing]);

  assert.ok(stops >= 1);
  assert.equal(controller.status().totals.connected, 0);
  await assert.rejects(
    controller.reconnectBot(identity.botId),
    /controller is closed/,
  );
});
