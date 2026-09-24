import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BotWorkspaceStore,
  createWorkspaceAwareController,
  observeBotWorkspaceRemovals,
} from '../src/channels/shared/bot-workspace-store.mjs';
import {
  DEFAULT_CONTEXT_ENHANCEMENT_CONFIG,
  captureContextEnhancement,
  enhanceContextContent,
} from '../src/channels/shared/context-enhancement.mjs';
import { TokenBotController } from '../src/channels/shared/token-bot-controller.mjs';
import {
  TokenBotConfigStore,
  deriveTokenBotIdentity,
} from '../src/channels/shared/token-config-store.mjs';
import { createWecomRpcHandler, WECOM_ENDPOINTS } from '../plugin-src/host/channels/wecom/rpc.mjs';
import { createWeixinRpcHandler, WEIXIN_ENDPOINTS } from '../plugin-src/host/channels/weixin/rpc.mjs';
import { createFeishuRpcHandler, FEISHU_ENDPOINTS } from '../plugin-src/host/channels/feishu/rpc.mjs';
import { createDingtalkRpcHandler, DINGTALK_ENDPOINTS } from '../plugin-src/host/channels/dingtalk/rpc.mjs';
import { createQqRpcHandler, QQ_ENDPOINTS } from '../plugin-src/host/channels/qq/rpc.mjs';
import { createSlackRpcHandler, SLACK_ENDPOINTS } from '../plugin-src/host/channels/slack/rpc.mjs';
import { createTelegramRpcHandler, TELEGRAM_ENDPOINTS } from '../plugin-src/host/channels/telegram/rpc.mjs';
import { createDiscordRpcHandler, DISCORD_ENDPOINTS } from '../plugin-src/host/channels/discord/rpc.mjs';
import { createWhatsappRpcHandler, WHATSAPP_ENDPOINTS } from '../plugin-src/host/channels/whatsapp/rpc.mjs';
import {
  SET_CONTEXT_ENHANCEMENT_ENDPOINT,
  validContextEnhancementPayload,
} from '../plugin-src/host/channels/shared/context-enhancement-rpc.mjs';

const CHANNELS = [
  ['wecom', createWecomRpcHandler, WECOM_ENDPOINTS],
  ['weixin', createWeixinRpcHandler, WEIXIN_ENDPOINTS],
  ['feishu', createFeishuRpcHandler, FEISHU_ENDPOINTS],
  ['dingtalk', createDingtalkRpcHandler, DINGTALK_ENDPOINTS],
  ['qq', createQqRpcHandler, QQ_ENDPOINTS],
  ['slack', createSlackRpcHandler, SLACK_ENDPOINTS],
  ['telegram', createTelegramRpcHandler, TELEGRAM_ENDPOINTS],
  ['discord', createDiscordRpcHandler, DISCORD_ENDPOINTS],
  ['whatsapp', createWhatsappRpcHandler, WHATSAPP_ENDPOINTS],
];

const enabled = (overrides = {}) => {
  const {
    groupEnabled = true,
    directEnabled = true,
    fields = ['channel', 'botId'],
    guidance = 'saved guidance',
    group = {},
    direct = {},
    ...extra
  } = overrides;
  return {
    group: { enabled: groupEnabled, fields, guidance, ...group },
    direct: { enabled: directEnabled, fields, guidance, ...direct },
    ...extra,
  };
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-context-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'workspaces.json');
  const store = await new BotWorkspaceStore(path, { defaultWorkspace: directory }).load();
  return { directory, path, store };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeController(botIds) {
  const unavailable = () => { throw new Error('unrelated lifecycle action must not run'); };
  return {
    status: () => ({ bots: botIds.map((botId) => ({ botId, configured: true, connected: false })) }),
    startProvisioning: unavailable,
    registrationStatus: unavailable,
    submitVerification: unavailable,
    cancelProvisioning: unavailable,
    bindCredentials: unavailable,
    reconnectBot: unavailable,
    deleteBot: unavailable,
    startRegistration: unavailable,
    cancelRegistration: unavailable,
    disconnect: unavailable,
    setAccessPolicy: unavailable,
    approveSender: unavailable,
    revokeSender: unavailable,
  };
}

function awareController(store, core, extra = {}) {
  return createWorkspaceAwareController(core, {
    workspaces: store,
    stateFor: () => { throw new Error('saving enhancement must not load or clear session state'); },
    ...extra,
  });
}

test('old workspace files remain untouched and default enhancement off', async (t) => {
  const { directory, path } = await fixture(t);
  const original = JSON.stringify({ version: 1, workspaces: { old_bot: directory }, agentPresets: { old_bot: 'preset-one' } });
  await writeFile(path, original);
  const store = await new BotWorkspaceStore(path).load();
  assert.equal(store.contextEnhancementFor('old_bot'), DEFAULT_CONTEXT_ENHANCEMENT_CONFIG);
  assert.equal(store.contextEnhancementFor('unknown_bot'), DEFAULT_CONTEXT_ENHANCEMENT_CONFIG);
  assert.equal(store.workspaceFor('old_bot'), directory);
  assert.equal(store.agentPresetFor('old_bot'), 'preset-one');
  assert.equal(store.decorateStatus({ bots: [{ botId: 'old_bot' }] }).bots[0].contextEnhancement, DEFAULT_CONTEXT_ENHANCEMENT_CONFIG);
  assert.equal(await readFile(path, 'utf8'), original, 'reading/decorating old config must not migrate/write it');
});

test('legacy enhancement settings migrate in memory and persist lazily on the next successful write', async (t) => {
  const { directory, path } = await fixture(t);
  const legacy = {
    groupEnabled: true,
    directEnabled: false,
    fields: ['botId', 'channel', 'botId'],
    guidance: 'legacy guidance',
  };
  const original = JSON.stringify({
    version: 1,
    workspaces: { legacy_bot: directory },
    contextEnhancement: { legacy_bot: legacy },
  });
  await writeFile(path, original);
  const store = await new BotWorkspaceStore(path).load();
  assert.deepEqual(store.contextEnhancementFor('legacy_bot'), enabled({
    directEnabled: false,
    fields: ['channel', 'botId'],
    guidance: 'legacy guidance',
  }));
  assert.equal(await readFile(path, 'utf8'), original, 'loading legacy settings must not write');
  await store.setAgentPreset('legacy_bot', 'preset-one');
  const migrated = JSON.parse(await readFile(path, 'utf8')).contextEnhancement.legacy_bot;
  assert.deepEqual(migrated, enabled({
    directEnabled: false,
    fields: ['channel', 'botId'],
    guidance: 'legacy guidance',
  }));
  assert.equal(Object.hasOwn(migrated, 'guidance'), false);
});

test('complete per-bot settings persist all switch combinations and explicit empty fields/text', async (t) => {
  const { path, directory, store } = await fixture(t);
  await store.ensure('bot_one', { defaultAgentPreset: 'preset-one' });
  await store.ensure('bot_two');
  const generation = store.generationFor('bot_one');
  const incarnation = store.incarnationFor('bot_one');
  for (const groupEnabled of [false, true]) {
    for (const directEnabled of [false, true]) {
      const selected = enabled({ groupEnabled, directEnabled, fields: [], guidance: '' });
      const saved = await store.setContextEnhancement('bot_one', selected);
      assert.deepEqual(saved, selected);
      assert.equal(store.contextEnhancementFor('bot_one'), saved);
      assert.equal(store.contextEnhancementFor('bot_two'), DEFAULT_CONTEXT_ENHANCEMENT_CONFIG);
      const reloaded = await new BotWorkspaceStore(path).load();
      assert.deepEqual(reloaded.contextEnhancementFor('bot_one'), selected);
    }
  }
  assert.equal(store.workspaceFor('bot_one'), directory);
  assert.equal(store.agentPresetFor('bot_one'), 'preset-one');
  assert.equal(store.generationFor('bot_one'), generation);
  assert.equal(store.incarnationFor('bot_one'), incarnation);
  const document = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(document.contextEnhancement.bot_one, enabled({ fields: [], guidance: '' }));
  assert.equal(Object.hasOwn(document.contextEnhancement, 'bot_two'), false);

  const alternate = join(directory, 'alternate');
  await mkdir(alternate);
  const before = store.contextEnhancementFor('bot_one');
  await store.setWorkspace('bot_one', alternate);
  await store.setAgentPreset('bot_one', 'preset-two');
  assert.equal(store.contextEnhancementFor('bot_one'), before);
});

test('malformed enhancement entries fail off without poisoning valid workspace or preset data', async (t) => {
  const { directory, path } = await fixture(t);
  const malformed = [null, [], true, 'bad', {}, enabled({ fields: ['secret'] }), enabled({ directEnabled: 'yes' })];
  for (const invalid of malformed) {
    const original = {
      version: 1,
      workspaces: { broken_bot: directory, healthy_bot: directory },
      agentPresets: { broken_bot: 'preset-one' },
      contextEnhancement: { broken_bot: invalid, healthy_bot: enabled(), '../bad-id': enabled() },
    };
    await writeFile(path, JSON.stringify(original));
    const store = await new BotWorkspaceStore(path).load();
    assert.equal(store.contextEnhancementFor('broken_bot'), DEFAULT_CONTEXT_ENHANCEMENT_CONFIG);
    assert.deepEqual(store.contextEnhancementFor('healthy_bot'), enabled());
    assert.equal(store.workspaceFor('broken_bot'), directory);
    assert.equal(store.agentPresetFor('broken_bot'), 'preset-one');
  }
  for (const contextEnhancement of [null, [], 'broken', true, 1]) {
    await writeFile(path, JSON.stringify({ version: 1, workspaces: { bot_one: directory }, contextEnhancement }));
    const store = await new BotWorkspaceStore(path).load();
    assert.equal(store.contextEnhancementFor('bot_one'), DEFAULT_CONTEXT_ENHANCEMENT_CONFIG);
  }
  await writeFile(path, JSON.stringify({ version: 1, workspaces: { bot_one: 'relative' }, contextEnhancement: null }));
  await assert.rejects(new BotWorkspaceStore(path).load(), /workspace config is invalid/);
});

test('pending and failed writes never publish an uncommitted context snapshot', async (t) => {
  const { path, store } = await fixture(t);
  await store.ensure('bot_one');
  const first = await store.setContextEnhancement('bot_one', enabled());
  const provider = { botId: 'bot_one', getSettings: () => store.contextEnhancementFor('bot_one') };
  const queuedMessage = captureContextEnhancement(provider, 'group');
  const diskBefore = await readFile(path, 'utf8');
  await mkdir(`${path}.tmp`);
  const save = store.setContextEnhancement('bot_one', enabled({ fields: [], guidance: '' }));
  await Promise.resolve();
  assert.equal(store.contextEnhancementFor('bot_one'), first, 'the persist await must not expose partial settings');
  await assert.rejects(save);
  assert.equal(store.contextEnhancementFor('bot_one'), first);
  assert.equal(await readFile(path, 'utf8'), diskBefore);
  await rm(`${path}.tmp`, { recursive: true });
  await store.setContextEnhancement('bot_one', enabled({ groupEnabled: false, directEnabled: false, fields: [], guidance: '' }));
  assert.equal(captureContextEnhancement(provider, 'group'), null);
  const text = enhanceContextContent('queued text', queuedMessage, () => ({ channel: 'qq' }));
  assert.match(text, /saved guidance/);
  assert.match(text, /"botId":"bot_one"/);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.group.fields), true);
  assert.equal(Object.isFrozen(first.direct.fields), true);
});

test('invalid saves reject atomically and deleted or rebound bot incarnations cannot receive stale updates', async (t) => {
  const { path, store } = await fixture(t);
  await store.ensure('bot_one');
  const initial = await store.setContextEnhancement('bot_one', enabled());
  const diskBefore = await readFile(path, 'utf8');
  await assert.rejects(store.setContextEnhancement('bot_one', enabled({ fields: ['token'] })), { code: 'context-enhancement-invalid' });
  assert.equal(store.contextEnhancementFor('bot_one'), initial);
  assert.equal(await readFile(path, 'utf8'), diskBefore);

  const oldIncarnation = store.incarnationFor('bot_one');
  await store.remove('bot_one');
  await store.ensure('bot_one');
  await assert.rejects(store.setContextEnhancement('bot_one', enabled(), { incarnation: oldIncarnation }), { code: 'workspace-bot-not-found' });
  await assert.rejects(store.setContextEnhancement('bot_one', enabled(), { incarnation: null }), { code: 'workspace-bot-not-found' });
  await assert.rejects(store.setContextEnhancement('missing_bot', enabled()), { code: 'workspace-bot-not-found' });
  assert.equal(store.contextEnhancementFor('bot_one'), DEFAULT_CONTEXT_ENHANCEMENT_CONFIG);
});

test('context update captures incarnation before waiting on controller status', async (t) => {
  const { store } = await fixture(t);
  await store.ensure('bot_one');
  const statusStarted = deferred();
  const statusResult = deferred();
  const controller = awareController(store, {
    async status() { statusStarted.resolve(); return statusResult.promise; },
  });
  const pending = controller.updateContextEnhancement('bot_one', enabled());
  await statusStarted.promise;
  await store.remove('bot_one');
  await store.ensure('bot_one');
  statusResult.resolve({ bots: [{ botId: 'bot_one' }] });
  await assert.rejects(pending, { code: 'workspace-bot-not-found' });
  assert.equal(store.contextEnhancementFor('bot_one'), DEFAULT_CONTEXT_ENHANCEMENT_CONFIG);
});

test('removal abort preserves settings, committed deletion removes them, and reconciliation cleans orphans', async (t) => {
  const { directory, path, store } = await fixture(t);
  await store.ensure('bot_one');
  await store.ensure('bot_two');
  const saved = await store.setContextEnhancement('bot_one', enabled({ fields: [], guidance: '' }));
  const removal = await store.beginRemoval('bot_one');
  await store.abortRemoval(removal);
  assert.equal(store.contextEnhancementFor('bot_one'), saved);
  const observed = observeBotWorkspaceRemovals({ async remove(botId) { return { botId }; } }, { workspaces: store });
  await observed.remove('bot_one');
  assert.equal(store.contextEnhancementFor('bot_one'), DEFAULT_CONTEXT_ENHANCEMENT_CONFIG);
  const remaining = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(remaining.contextEnhancement, undefined);
  assert.deepEqual(remaining.workspaces, { bot_two: directory });

  await writeFile(path, JSON.stringify({
    version: 1, workspaces: { bot_two: directory }, contextEnhancement: { orphan_bot: enabled() },
  }));
  const reloaded = await new BotWorkspaceStore(path).load();
  await reloaded.reconcile(['bot_two']);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).contextEnhancement, undefined);
  await reloaded.remove('bot_two');
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('failed cleanup retires context settings and startup reconciliation heals stale disk state', async (t) => {
  const { path, store } = await fixture(t);
  await store.ensure('bot_one');
  await store.ensure('bot_two');
  await store.setContextEnhancement('bot_one', enabled());
  await mkdir(`${path}.tmp`);
  await assert.rejects(store.remove('bot_one'));
  assert.equal(store.has('bot_one'), false);
  assert.equal(store.contextEnhancementFor('bot_one'), DEFAULT_CONTEXT_ENHANCEMENT_CONFIG);
  await rm(`${path}.tmp`, { recursive: true });
  const reloaded = await new BotWorkspaceStore(path).load();
  assert.equal(reloaded.contextEnhancementFor('bot_one').group.enabled, true);
  await reloaded.reconcile(['bot_two']);
  assert.equal(reloaded.contextEnhancementFor('bot_one'), DEFAULT_CONTEXT_ENHANCEMENT_CONFIG);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).contextEnhancement, undefined);
});

for (const recovery of ['retry', 'restart']) {
  test(`failed same-id rebind rolls back credentials and cannot revive old context after ${recovery}`, async (t) => {
    const { directory, path, store } = await fixture(t);
    const configPath = join(directory, 'bots.json');
    const identityOptions = { channel: 'test', botPrefix: 'bot', tokenRefPrefix: 'BOT_TOKEN' };
    const configStore = await new TokenBotConfigStore(configPath, identityOptions).load();
    const credentials = new Map();
    const runtimeStarts = [];
    const controllers = [];
    const createController = (workspaces, configs) => {
      const core = new TokenBotController({
        descriptor: { key: 'test', label: 'Test', connectionLabel: 'connection' },
        configStore: observeBotWorkspaceRemovals(configs, { workspaces }),
        credentials: {
          async resolve(ref) { return credentials.has(ref) ? { value: credentials.get(ref) } : undefined; },
          async set(ref, value) { credentials.set(ref, value); },
          async unset(ref) { credentials.delete(ref); },
        },
        async inspectToken(token) { return { platformId: token.split(':')[0], name: 'Test bot' }; },
        deriveIdentity: (id) => deriveTokenBotIdentity(id, identityOptions),
        maskPlatformId: (id) => id,
        async createRuntime({ botId }) {
          runtimeStarts.push(botId);
          await workspaces.ensure(botId);
          return {
            status: { ready: true, connectionState: 'connected', harnessReachable: true },
            async start() {},
            async stop() {},
          };
        },
        logger: { warn() {} },
      });
      const controller = createWorkspaceAwareController(core, {
        workspaces,
        stateFor: async () => ({ async clearSessions() {} }),
      });
      controllers.push(controller);
      return controller;
    };
    t.after(async () => { await Promise.all(controllers.map((controller) => controller.close())); });
    let controller = createController(store, configStore);
    await controller.bindCredentials({ token: 'one:original' });
    await controller.bindCredentials({ token: 'two:original' });
    const first = deriveTokenBotIdentity('one', identityOptions);
    const second = deriveTokenBotIdentity('two', identityOptions);
    const oldWorkspace = join(directory, 'old-workspace');
    await mkdir(oldWorkspace);
    await store.setWorkspace(first.botId, oldWorkspace);
    await store.setAgentPreset(first.botId, 'old-preset');
    await store.setContextEnhancement(first.botId, enabled());
    const otherSettings = await store.setContextEnhancement(second.botId, enabled({ guidance: 'other bot' }));
    const originalDocument = await readFile(path, 'utf8');
    const otherGeneration = store.generationFor(second.botId);

    // Only metadata persistence fails; the independent bot config remains writable.
    await mkdir(`${path}.tmp`);
    await controller.deleteBot(first.botId);
    assert.equal(configStore.get(first.botId), null);
    assert.equal(store.contextEnhancementFor(first.botId), DEFAULT_CONTEXT_ENHANCEMENT_CONFIG);
    assert.equal(await readFile(path, 'utf8'), originalDocument);
    const previousStarts = runtimeStarts.length;
    await assert.rejects(controller.bindCredentials({ token: 'one:rebound' }));
    assert.equal(configStore.get(first.botId), null, 'failed cleanup must precede the new config commit');
    assert.equal(credentials.has(first.tokenRef), false, 'the existing config-save catch rolls back the new credential');
    assert.equal(runtimeStarts.length, previousStarts, 'a blocked rebind must not attempt runtime startup');
    assert.equal(await readFile(path, 'utf8'), originalDocument);
    assert.equal(store.contextEnhancementFor(second.botId), otherSettings);
    assert.equal(store.generationFor(second.botId), otherGeneration);
    const reloadedConfigs = await new TokenBotConfigStore(configPath, identityOptions).load();
    assert.equal(reloadedConfigs.get(first.botId), null, 'restart has no active config for the deleted id');

    await rm(`${path}.tmp`, { recursive: true });
    let currentStore = store;
    if (recovery === 'restart') {
      await controller.close();
      currentStore = await new BotWorkspaceStore(path, { defaultWorkspace: directory }).load();
      await currentStore.reconcile(reloadedConfigs.list().map((bot) => bot.botId));
      assert.equal(currentStore.contextEnhancementFor(first.botId), DEFAULT_CONTEXT_ENHANCEMENT_CONFIG);
      controller = createController(currentStore, reloadedConfigs);
    }
    const rebound = await controller.bindCredentials({ token: 'one:rebound' });
    assert.equal(rebound.bots.find((bot) => bot.botId === first.botId).connected, true);
    assert.equal(currentStore.workspaceFor(first.botId), directory);
    assert.equal(currentStore.agentPresetFor(first.botId), null);
    assert.equal(currentStore.contextEnhancementFor(first.botId), DEFAULT_CONTEXT_ENHANCEMENT_CONFIG);
    assert.equal(credentials.get(first.tokenRef), 'one:rebound');
    const reloaded = await new BotWorkspaceStore(path, { defaultWorkspace: directory }).load();
    assert.equal(reloaded.workspaceFor(first.botId), directory);
    assert.equal(reloaded.agentPresetFor(first.botId), null);
    assert.equal(reloaded.contextEnhancementFor(first.botId), DEFAULT_CONTEXT_ENHANCEMENT_CONFIG);
    assert.deepEqual(reloaded.contextEnhancementFor(second.botId), otherSettings);
  });
}

for (const idKey of ['botId', 'id']) {
  test(`${idKey} config-save observation retries only dirty IDs and preserves normal save timing/results`, async (t) => {
    const { path, store } = await fixture(t);
    await store.ensure('bot_one');
    await store.ensure('bot_two');
    await store.setContextEnhancement('bot_one', enabled());
    const saveMethod = idKey === 'id' ? 'saveBot' : 'save';
    const method = idKey === 'id' ? 'removeBot' : 'remove';
    const result = Promise.resolve('saved');
    const calls = [];
    const target = {
      [saveMethod](config) { assert.equal(this, target); calls.push(config); return result; },
      async [method](botId) { return { [idKey]: botId }; },
    };
    const observed = observeBotWorkspaceRemovals(target, {
      workspaces: store,
      method,
      botIdFromRemoved: (removed) => removed[idKey],
      ...(idKey === 'id' ? { saveMethod, botIdFromSave: (config) => config.id } : {}),
    });
    assert.equal(observed[saveMethod]({ [idKey]: 'bot_two' }), result);
    assert.equal(calls.length, 1, 'normal save starts synchronously, without a new queue/await');
    await mkdir(`${path}.tmp`);
    await assert.rejects(observed[method]('bot_one'), { code: 'EISDIR' });
    await assert.rejects(observed[saveMethod]({ [idKey]: 'bot_one' }));
    assert.equal(calls.length, 1, 'failed metadata cleanup prevents config save');
    assert.equal(observed[saveMethod]({ [idKey]: 'bot_two' }), result);
    assert.equal(calls.length, 2, 'another bot is not blocked by this retired id');
    await rm(`${path}.tmp`, { recursive: true });
    assert.equal(await observed[saveMethod]({ [idKey]: 'bot_one' }), 'saved');
    assert.equal(calls.length, 3);
    const document = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(Object.hasOwn(document.workspaces, 'bot_one'), false);
    assert.equal(Object.hasOwn(document.workspaces, 'bot_two'), true);
    assert.equal(document.contextEnhancement, undefined);
  });
}

test('context save performs no session/lifecycle work and no fallible status/catalog I/O after commit', async (t) => {
  const { store } = await fixture(t);
  await store.ensure('bot_one');
  let statusReads = 0;
  let catalogReads = 0;
  const controller = awareController(store, {
    status() {
      statusReads += 1;
      assert.equal(statusReads, 1, 'must not make a second status call after persistence');
      return { bots: [{ botId: 'bot_one' }] };
    },
  }, {
    agentPresetCatalog() {
      catalogReads += 1;
      assert.equal(store.contextEnhancementFor('bot_one'), DEFAULT_CONTEXT_ENHANCEMENT_CONFIG);
      return { items: [{ id: 'preset-one', label: 'One' }] };
    },
  });
  const result = await controller.updateContextEnhancement('bot_one', enabled());
  assert.deepEqual(result.bots[0].contextEnhancement, enabled());
  assert.equal(result.agentPresetCatalog.items[0].id, 'preset-one');
  assert.equal(catalogReads, 1);

  const brokenCatalog = awareController(store, fakeController(['bot_one']), {
    agentPresetCatalog() { throw new Error('catalog unavailable'); },
  });
  await assert.rejects(brokenCatalog.updateContextEnhancement('bot_one', enabled({ fields: [] })), /catalog unavailable/);
  assert.deepEqual(store.contextEnhancementFor('bot_one'), enabled());
});

test('shared context RPC payload validator rejects unknown keys and incomplete settings', () => {
  assert.equal(validContextEnhancementPayload({ botId: 'bot_one', config: enabled() }), true);
  for (const payload of [
    null, [], {}, { botId: 'bot_one' }, { botId: '../bot_one', config: enabled() },
    { botId: 'bot_one', config: enabled(), token: 'no' },
    { botId: 'bot_one', config: { groupEnabled: true } },
    { botId: 'bot_one', config: enabled({ fields: ['password'] }) },
  ]) assert.equal(validContextEnhancementPayload(payload), false);
});

for (const [channel, createHandler, endpoints] of CHANNELS.filter(([name]) => (
  !['slack', 'telegram', 'discord'].includes(name)
))) {
  test(`${channel} QR/status projection failure happens before a context save commits`, async (t) => {
    const { path, store } = await fixture(t);
    const botId = `${channel}_projection`;
    await store.ensure(botId);
    const previous = store.contextEnhancementFor(botId);
    const diskBefore = await readFile(path, 'utf8');
    const core = fakeController([botId]);
    core.status = () => ({
      bots: [{ botId, configured: true }],
      provisioning: {
        verificationUrl: 'https://example.test/qr', qrValue: 'whatsapp-qr',
      },
      registration: {
        state: 'qr_ready', attempt: 1, qrCodeUrl: 'https://accounts.feishu.cn/fixture',
      },
    });
    let projections = 0;
    const handler = createHandler(awareController(store, core), {
      async encodeQr() {
        projections += 1;
        assert.equal(store.contextEnhancementFor(botId), previous);
        throw new Error('QR rendering unavailable');
      },
    });
    const result = await handler(endpoints.setContextEnhancement, { botId, config: enabled() });
    assert.equal(result.ok, false);
    assert.equal(projections, 1);
    assert.equal(store.contextEnhancementFor(botId), previous);
    assert.equal(await readFile(path, 'utf8'), diskBefore);
  });
}

for (const [channel, createHandler, endpoints] of CHANNELS) {
  test(`${channel} context RPC returns its complete status, preserves empty settings and rejects invalid saves`, async (t) => {
    const { path, store } = await fixture(t);
    const botId = `${channel}_one`;
    const otherBotId = `${channel}_two`;
    await store.ensure(botId);
    await store.ensure(otherBotId);
    const controller = awareController(store, fakeController([botId, otherBotId]));
    const handler = createHandler(controller);
    assert.equal(endpoints.setContextEnhancement, SET_CONTEXT_ENHANCEMENT_ENDPOINT);
    const before = await handler(endpoints.status, {});
    assert.equal(before.ok, true);
    assert.deepEqual(before.value.bots[0].contextEnhancement, DEFAULT_CONTEXT_ENHANCEMENT_CONFIG);
    const selected = enabled({ fields: ['botId', 'channel', 'botId'], guidance: ' \n ' });
    const saved = await handler(endpoints.setContextEnhancement, { botId, config: selected });
    assert.equal(saved.ok, true);
    assert.equal(saved.value.bots.length, 2);
    assert.deepEqual(saved.value.bots[0].contextEnhancement, enabled({ fields: ['channel', 'botId'], guidance: '' }));
    assert.deepEqual(saved.value.bots[1].contextEnhancement, DEFAULT_CONTEXT_ENHANCEMENT_CONFIG);
    const original = store.contextEnhancementFor(botId);
    const diskBefore = await readFile(path, 'utf8');
    for (const config of [enabled({ groupEnabled: 'yes' }), enabled({ fields: ['secret'] }), enabled({ guidance: 'x'.repeat(8001) })]) {
      const failed = await handler(endpoints.setContextEnhancement, { botId, config });
      assert.equal(failed.ok, false);
      assert.equal(failed.error.code, 'bad-request');
      assert.equal(store.contextEnhancementFor(botId), original);
    }
    assert.equal(await readFile(path, 'utf8'), diskBefore);
    const missing = await handler(endpoints.setContextEnhancement, { botId: 'missing_bot', config: enabled() });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'workspace-bot-not-found');
    const cancelled = await handler(endpoints.setContextEnhancement, { botId, config: enabled() }, AbortSignal.abort());
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.error.code, 'cancelled');
    assert.equal(store.contextEnhancementFor(botId), original);
    await mkdir(`${path}.tmp`);
    const failedWrite = await handler(endpoints.setContextEnhancement, { botId, config: enabled({ fields: [] }) });
    assert.equal(failedWrite.ok, false);
    assert.equal(store.contextEnhancementFor(botId), original);
    assert.equal(await readFile(path, 'utf8'), diskBefore);
    await rm(`${path}.tmp`, { recursive: true });
    const cleared = await handler(endpoints.setContextEnhancement, { botId, config: enabled({ fields: [], guidance: '' }) });
    assert.equal(cleared.ok, true);
    assert.deepEqual(cleared.value.bots[0].contextEnhancement.group.fields, []);
    assert.deepEqual(cleared.value.bots[0].contextEnhancement.direct.fields, []);
    assert.equal(cleared.value.bots[0].contextEnhancement.group.guidance, '');
    assert.equal(cleared.value.bots[0].contextEnhancement.direct.guidance, '');
  });
}
