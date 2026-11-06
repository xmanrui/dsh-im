import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { TelegramConfigStore } from '../../../src/channels/telegram/config-store.mjs';
import { TelegramController } from '../../../src/channels/telegram/telegram-controller.mjs';

const TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456';
const quietLogger = { warn: () => {}, error: () => {}, debug: () => {} };

function credentials() {
  const values = new Map();
  return {
    async resolve(ref) { return values.has(ref) ? { value: values.get(ref), source: 'test' } : undefined; },
    async set(ref, value) { values.set(ref, value); },
    async unset(ref) { values.delete(ref); },
  };
}

/** A controller over a throwaway config store with one bound bot. */
async function controllerWithBot(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-group-triggers-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configStore = await new TelegramConfigStore(join(directory, 'config.json')).load();
  const controller = new TelegramController({
    credentials: credentials(),
    configStore,
    inspectToken: async () => ({ platformId: '123456789', name: 'Harness Telegram', username: 'harness_bot' }),
    createRuntime: async () => ({
      status: { ready: true, connectionState: 'connected', harnessReachable: true, lastCheckedAt: 10 },
      async start() {},
      async stop() {},
    }),
    logger: quietLogger,
  });
  const bound = await controller.bindCredentials({ token: TOKEN });
  return { controller, configStore, botId: bound.bots[0].botId };
}

test('a removed group stays hidden across later saves', async (t) => {
  const { controller, configStore, botId } = await controllerWithBot(t);

  const first = await controller.updateGroupTriggers(botId, {
    config: {
      defaults: { mode: 'off', senders: [] },
      groups: { '-1001': { mode: 'all', senders: [] }, '-1002': { mode: 'mention', senders: [] } },
    },
  });
  assert.deepEqual(Object.keys(first.groups).sort(), ['-1001', '-1002']);

  const removed = await controller.updateGroupTriggers(botId, {
    config: {
      defaults: { mode: 'off', senders: [] },
      groups: { '-1001': { mode: 'all', senders: [] } },
    },
    removed: ['-1002'],
  });
  assert.deepEqual(Object.keys(removed.groups), ['-1001']);
  assert.deepEqual(configStore.get(botId).groupTriggers.hiddenGroupIds, ['-1002']);

  // The panel does not echo hiddenGroupIds; a plain second save must not undo it.
  const resaved = await controller.updateGroupTriggers(botId, {
    config: {
      defaults: { mode: 'off', senders: [] },
      groups: { '-1001': { mode: 'all', senders: [] } },
    },
  });
  assert.deepEqual(Object.keys(resaved.groups), ['-1001'], 'the removed group must not come back');
  assert.deepEqual(configStore.get(botId).groupTriggers.hiddenGroupIds, ['-1002']);
});

test('re-adding a hidden group clears its removal', async (t) => {
  const { controller, configStore, botId } = await controllerWithBot(t);
  await controller.updateGroupTriggers(botId, {
    config: { defaults: { mode: 'off', senders: [] }, groups: { '-1002': { mode: 'all', senders: [] } } },
    removed: ['-1002'],
  });
  assert.deepEqual(configStore.get(botId).groupTriggers.hiddenGroupIds, ['-1002']);

  const readded = await controller.updateGroupTriggers(botId, {
    config: { defaults: { mode: 'off', senders: [] }, groups: { '-1002': { mode: 'all-list', senders: ['111'] } } },
  });
  assert.deepEqual(Object.keys(readded.groups), ['-1002']);
  assert.deepEqual(readded.groups['-1002'], { mode: 'all-list', senders: ['111'] });
  assert.deepEqual(configStore.get(botId).groupTriggers.hiddenGroupIds, []);
});

test('an unknown bot is rejected instead of creating a stray record', async (t) => {
  const { controller } = await controllerWithBot(t);
  await assert.rejects(
    () => controller.updateGroupTriggers('telegram_missing', { config: { defaults: { mode: 'off' } } }),
    /Unknown Telegram bot/,
  );
});

test('group lookup borrows the runtime transport and disposes it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-group-lookup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configStore = await new TelegramConfigStore(join(directory, 'config.json')).load();
  const store = credentials();
  const apiOptions = [];
  let created = 0;
  let destroyed = 0;
  const fetchImpl = async () => ({ ok: true });
  const controller = new TelegramController({
    credentials: store,
    configStore,
    inspectToken: async () => ({ platformId: '123456789', name: 'Harness Telegram', username: 'harness_bot' }),
    createRuntime: async () => ({
      status: { ready: true, connectionState: 'connected', harnessReachable: true, lastCheckedAt: 10 },
      async start() {},
      async stop() {},
    }),
    createHttpTransport: () => {
      created += 1;
      return {
        fetchImpl,
        FormDataImpl: class {},
        async destroy() { destroyed += 1; },
      };
    },
    createApi: (options) => {
      apiOptions.push(options);
      return { async getChat({ chatId }) { return { id: '-1001234567890', title: chatId, type: 'supergroup' }; } };
    },
    logger: quietLogger,
  });
  const bound = await controller.bindCredentials({ token: TOKEN });
  await store.set(configStore.get(bound.bots[0].botId).tokenRef, TOKEN);

  const resolved = await controller.resolveGroupTrigger(bound.bots[0].botId, '@harness_chat');
  assert.equal(resolved.chatId, '-1001234567890');
  assert.equal(created, 1, 'the lookup builds the shared transport');
  assert.equal(destroyed, 1, 'and disposes it afterwards');
  assert.equal(apiOptions[0].fetchImpl, fetchImpl, 'the API never falls back to global fetch');
  assert.equal(typeof apiOptions[0].FormDataImpl, 'function');
});

test('a numeric reference resolves without any transport', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-group-lookup-offline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configStore = await new TelegramConfigStore(join(directory, 'config.json')).load();
  let created = 0;
  const controller = new TelegramController({
    credentials: credentials(),
    configStore,
    inspectToken: async () => ({ platformId: '123456789', name: 'Harness Telegram', username: 'harness_bot' }),
    createRuntime: async () => ({
      status: { ready: true, connectionState: 'connected', harnessReachable: true, lastCheckedAt: 10 },
      async start() {},
      async stop() {},
    }),
    createHttpTransport: () => { created += 1; return { fetchImpl: async () => ({ ok: true }), FormDataImpl: class {}, async destroy() {} }; },
    createApi: () => { throw new Error('the API must not be built for a numeric id'); },
    logger: quietLogger,
  });
  const bound = await controller.bindCredentials({ token: TOKEN });
  const resolved = await controller.resolveGroupTrigger(bound.bots[0].botId, '-1001234567890');
  assert.equal(resolved.chatId, '-1001234567890');
  assert.equal(created, 0);
});
