import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BotWorkspaceStore,
  createBotWorkspaceScope,
  createWorkspaceAwareController,
} from '../src/channels/shared/bot-workspace-store.mjs';
import {
  cachedModelCatalog,
  defaultModelSelectionText,
  normalizeDefaultModelSelection,
  validateDefaultModelSelection,
} from '../src/channels/shared/default-model.mjs';
import {
  MODEL_CATALOG_ENDPOINT,
  SET_DEFAULT_MODEL_ENDPOINT,
  validDefaultModelPayload,
} from '../plugin-src/host/channels/shared/default-model-rpc.mjs';
import {
  TOKEN_BOT_ENDPOINTS,
  createTokenBotRpcHandler,
} from '../plugin-src/host/channels/shared/rpc.mjs';

const CATALOG = Object.freeze({
  groups: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ],
    },
  ],
  failures: [],
  current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
});

async function storeFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-default-model-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const defaultWorkspace = join(root, 'default');
  await mkdir(defaultWorkspace);
  return {
    root,
    defaultWorkspace,
    path: join(root, 'workspaces.json'),
    async store() {
      return new BotWorkspaceStore(join(root, 'workspaces.json'), { defaultWorkspace });
    },
  };
}

test('selection helpers normalize, validate, and render default models', () => {
  assert.deepEqual(normalizeDefaultModelSelection(null), null);
  assert.deepEqual(normalizeDefaultModelSelection('x'), null);
  assert.deepEqual(normalizeDefaultModelSelection({ provider: 'p', model: '' }), null);
  assert.deepEqual(normalizeDefaultModelSelection({
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  }), { provider: 'deepseek-official', model: 'deepseek-v4-pro' });
  assert.deepEqual(normalizeDefaultModelSelection({
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'high',
  }), {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'high',
  });

  assert.equal(validateDefaultModelSelection(null), null);
  let thrown;
  try {
    validateDefaultModelSelection({ provider: 'p/', model: 'm' });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown?.code, 'default-model-invalid');

  assert.equal(
    defaultModelSelectionText({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    }),
    'deepseek-official/deepseek-v4-pro · reasoningEffort=high',
  );
});

test('the store persists, reloads, and clears per-bot default models', async (t) => {
  const fixture = await storeFixture(t);
  const workspaces = await (await fixture.store()).load();
  await workspaces.ensure('bot_one');
  await workspaces.ensure('bot_two');

  assert.equal(workspaces.defaultModelFor('bot_one'), null);
  await workspaces.setDefaultModel('bot_one', {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'high',
  });
  assert.deepEqual(workspaces.defaultModelFor('bot_one'), {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'high',
  });
  assert.equal(workspaces.defaultModelFor('bot_two'), null);
  assert.equal(workspaces.defaultModelFor('unknown'), null);

  const document = JSON.parse(await readFile(fixture.path, 'utf8'));
  assert.deepEqual(document.defaultModels, {
    bot_one: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    },
  });

  const reloaded = await (await fixture.store()).load();
  assert.deepEqual(reloaded.defaultModelFor('bot_one'), {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'high',
  });

  await reloaded.setDefaultModel('bot_one', null);
  assert.equal(reloaded.defaultModelFor('bot_one'), null);
  assert.equal(
    Object.hasOwn(JSON.parse(await readFile(fixture.path, 'utf8')), 'defaultModels'),
    false,
  );
});

test('default-model document damage is isolated per bot and invalid shapes are rejected', async (t) => {
  const fixture = await storeFixture(t);
  await mkdir(join(fixture.root, 'ws'), { recursive: false });
  await writeFile(fixture.path, `${JSON.stringify({
    version: 1,
    workspaces: { bot_one: join(fixture.root, 'ws'), bot_two: join(fixture.root, 'ws') },
    defaultModels: {
      bot_one: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      bot_two: { provider: 'not a provider', model: 'x' },
      bot_three: null,
    },
  })}\n`);

  const workspaces = await (await fixture.store()).load();
  assert.deepEqual(workspaces.defaultModelFor('bot_one'), {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  });
  assert.equal(workspaces.defaultModelFor('bot_two'), null);

  await assert.rejects(
    () => workspaces.setDefaultModel('bot_one', { provider: 'p', model: 'm', extra: 1 }),
    (error) => error?.code === 'default-model-invalid',
  );
});

test('removing a bot drops its default model and reconcile cleans orphans', async (t) => {
  const fixture = await storeFixture(t);
  const workspaces = await (await fixture.store()).load();
  await workspaces.ensure('bot_keep');
  await workspaces.ensure('bot_gone');
  await workspaces.setDefaultModel('bot_keep', {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  });
  await workspaces.setDefaultModel('bot_gone', {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  });

  await workspaces.remove('bot_gone');
  assert.equal(workspaces.defaultModelFor('bot_gone'), null);
  assert.deepEqual(workspaces.defaultModelFor('bot_keep'), {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  });

  await workspaces.ensure('bot_orphan');
  await workspaces.setDefaultModel('bot_orphan', {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  });
  await workspaces.reconcile(['bot_keep']);
  assert.equal(workspaces.defaultModelFor('bot_orphan'), null);

  const document = JSON.parse(await readFile(fixture.path, 'utf8'));
  assert.deepEqual(Object.keys(document.defaultModels), ['bot_keep']);
});

test('decorateStatus exposes each bot default model', async (t) => {
  const fixture = await storeFixture(t);
  const workspaces = await (await fixture.store()).load();
  await workspaces.ensure('bot_status');
  await workspaces.setDefaultModel('bot_status', {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  });
  const decorated = workspaces.decorateStatus({ bots: [{ botId: 'bot_status' }, {}] });
  assert.deepEqual(decorated.bots[0].defaultModel, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  });
  assert.equal(decorated.bots[1].defaultModel, undefined);
});

async function scopeFixture(t, { defaultModel } = {}) {
  const fixture = await storeFixture(t);
  const workspaces = await (await fixture.store()).load();
  await workspaces.ensure('bot_scope');
  if (defaultModel) await workspaces.setDefaultModel('bot_scope', defaultModel);
  const calls = [];
  const harness = {
    async listModels(options) {
      calls.push(['listModels', options]);
      return CATALOG;
    },
    async createSession(options) {
      calls.push(['createSession', options]);
      return 'session-new';
    },
    async selectSessionModel(sessionId, selection, options) {
      calls.push(['selectSessionModel', sessionId, selection, options]);
      return { selected: selection };
    },
  };
  const state = { async clearSessions() {} };
  const scope = createBotWorkspaceScope(harness, { botId: 'bot_scope', workspaces, state });
  return { calls, scope, workspaces, state };
}

test('scoped createSession applies the bot default model to new sessions', async (t) => {
  const { calls, scope } = await scopeFixture(t, {
    defaultModel: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    },
  });
  const signal = new AbortController().signal;
  const sessionId = await scope.harness.createSession({ signal });
  assert.equal(sessionId, 'session-new');
  assert.deepEqual(calls.map(([name]) => name), ['createSession', 'selectSessionModel']);
  assert.equal(calls[0][1].signal, signal);
  assert.equal(typeof calls[0][1].workspace, 'string');
  assert.deepEqual(calls[1], [
    'selectSessionModel',
    'session-new',
    {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    },
    { signal },
  ]);
});

test('scoped createSession skips model selection when no default is configured', async (t) => {
  const { calls, scope } = await scopeFixture(t);
  await scope.harness.createSession();
  assert.deepEqual(calls.map(([name]) => name), ['createSession']);
});

test('scoped createSession surfaces an unavailable default model instead of falling back', async (t) => {
  const fixture = await storeFixture(t);
  const workspaces = await (await fixture.store()).load();
  await workspaces.ensure('bot_broken');
  await workspaces.setDefaultModel('bot_broken', {
    provider: 'gone',
    model: 'model',
  });
  const cause = Object.assign(new Error('provider unavailable'), { code: 'model-unavailable' });
  const harness = {
    async createSession() { return 'session-new'; },
    async selectSessionModel() { throw cause; },
  };
  const state = { async clearSessions() {} };
  const scope = createBotWorkspaceScope(harness, {
    botId: 'bot_broken', workspaces, state,
  });
  await assert.rejects(
    () => scope.harness.createSession(),
    (error) => error?.code === 'default-model-unavailable'
      && error?.cause === cause
      && /gone\/model/.test(error.message)
      && /\/model default clear/.test(error.message),
  );
});

test('scoped updateDefaultModel validates against the live catalog and stores the selection', async (t) => {
  const { calls, scope, workspaces } = await scopeFixture(t);
  assert.deepEqual(
    await scope.harness.defaultModelSettings(),
    { defaultModel: null },
  );

  await scope.harness.updateDefaultModel({
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  });
  assert.deepEqual(workspaces.defaultModelFor('bot_scope'), {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  });

  await assert.rejects(
    () => scope.harness.updateDefaultModel({ provider: 'deepseek-official', model: 'missing' }),
    (error) => error?.code === 'default-model-unavailable',
  );
  await scope.harness.updateDefaultModel(null);
  assert.equal(workspaces.defaultModelFor('bot_scope'), null);
  assert.equal(calls.filter(([name]) => name === 'listModels').length, 2);
});

test('scoped updateDefaultModel maps catalog failures to a typed error', async (t) => {
  const fixture = await storeFixture(t);
  const workspaces = await (await fixture.store()).load();
  await workspaces.ensure('bot_catalog_down');
  const harness = {
    async listModels() { throw new Error('rpc down'); },
  };
  const state = { async clearSessions() {} };
  const scope = createBotWorkspaceScope(harness, {
    botId: 'bot_catalog_down', workspaces, state,
  });
  await assert.rejects(
    () => scope.harness.updateDefaultModel({ provider: 'p', model: 'm' }),
    (error) => error?.code === 'model-catalog-unavailable' && error?.cause?.message === 'rpc down',
  );
});

test('the controller updates default models through the model catalog source', async (t) => {
  const fixture = await storeFixture(t);
  const workspaces = await (await fixture.store()).load();
  await workspaces.ensure('bot_ctrl');
  const state = { async clearSessions() {} };
  const status = { bots: [{ botId: 'bot_ctrl', connected: true }] };
  const catalogCalls = [];
  const modelCatalog = async () => {
    catalogCalls.push('fetch');
    return CATALOG;
  };
  const controller = createWorkspaceAwareController({
    status() { return status; },
  }, { workspaces, stateFor: async () => state, modelCatalog });

  assert.deepEqual(await controller.listModelCatalog(), CATALOG);
  assert.deepEqual(catalogCalls, ['fetch']);

  const updated = await controller.updateDefaultModel('bot_ctrl', {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  });
  assert.deepEqual(updated.bots[0].defaultModel, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  });

  await assert.rejects(
    () => controller.updateDefaultModel('bot_ctrl', { provider: 'x', model: 'y' }),
    (error) => error?.code === 'default-model-unavailable',
  );
  await assert.rejects(
    () => controller.updateDefaultModel('bot_missing', { provider: 'x', model: 'y' }),
    (error) => error?.code === 'workspace-bot-not-found',
  );

  await controller.updateDefaultModel('bot_ctrl', null);
  assert.equal(workspaces.defaultModelFor('bot_ctrl'), null);
});

test('cachedModelCatalog caches successes per ttl and never caches failures', async () => {
  let fetches = 0;
  let failNext = false;
  const loader = async () => {
    fetches += 1;
    if (failNext) throw new Error('boom');
    return { fetched: fetches };
  };
  const cached = cachedModelCatalog(loader, { ttlMs: 60_000 });

  assert.deepEqual(await cached(), { fetched: 1 });
  assert.deepEqual(await cached(), { fetched: 1 });

  const uncached = cachedModelCatalog(loader, { ttlMs: 0 });
  failNext = true;
  await assert.rejects(() => uncached(), /boom/);
  failNext = false;
  assert.deepEqual(await uncached(), { fetched: 3 });
});

function rpcController() {
  return {
    status() { return { bots: [{ botId: 'bot_rpc' }] }; },
    async bindCredentials() {},
    async reconnectBot() { return { bots: [] }; },
    async deleteBot() { return { bots: [] }; },
    async updateDefaultModel(botId, model) {
      if (model && model.provider === 'gone') {
        const error = new Error('默认模型不存在或当前不可用：gone/model');
        error.code = 'default-model-unavailable';
        throw error;
      }
      return { bots: [{ botId, defaultModel: model }] };
    },
    async listModelCatalog() { return CATALOG; },
  };
}

test('validDefaultModelPayload accepts botId plus a selection or null', () => {
  assert.equal(validDefaultModelPayload({ botId: 'b', model: null }), true);
  assert.equal(validDefaultModelPayload({
    botId: 'b',
    model: { provider: 'p', model: 'm' },
  }), true);
  assert.equal(validDefaultModelPayload({
    botId: 'b',
    model: { provider: 'p', model: 'm', reasoningEffort: 'high' },
  }), true);
  for (const payload of [
    null,
    {},
    { botId: 'b' },
    { botId: 'b!', model: null },
    { botId: 'b', model: { provider: 'p' } },
    { botId: 'b', model: { provider: 'p', model: 'm', extra: 1 } },
    { botId: 'b', model: 'p/m' },
    { botId: 'b', model: null, extra: true },
  ]) {
    assert.equal(validDefaultModelPayload(payload), false, JSON.stringify(payload));
  }
});

test('the token bot RPC sets default models and serves the model catalog', async () => {
  const handler = createTokenBotRpcHandler(rpcController(), { channel: 'Telegram' });

  const set = await handler(TOKEN_BOT_ENDPOINTS.setDefaultModel, {
    botId: 'bot_rpc',
    model: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  });
  assert.equal(set.ok, true);
  assert.deepEqual(set.value.bots[0].defaultModel, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  });

  const cleared = await handler(TOKEN_BOT_ENDPOINTS.setDefaultModel, {
    botId: 'bot_rpc',
    model: null,
  });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.value.bots[0].defaultModel, null);

  const invalid = await handler(TOKEN_BOT_ENDPOINTS.setDefaultModel, {
    botId: 'bot_rpc',
    model: { provider: 'p' },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'bad-request');

  const unavailable = await handler(TOKEN_BOT_ENDPOINTS.setDefaultModel, {
    botId: 'bot_rpc',
    model: { provider: 'gone', model: 'model' },
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error.code, 'default-model-unavailable');

  const catalog = await handler(TOKEN_BOT_ENDPOINTS.modelCatalog, {});
  assert.equal(catalog.ok, true);
  assert.deepEqual(catalog.value.groups, CATALOG.groups);

  const rejectedCatalog = await handler(TOKEN_BOT_ENDPOINTS.modelCatalog, { x: 1 });
  assert.equal(rejectedCatalog.ok, false);

  assert.equal(SET_DEFAULT_MODEL_ENDPOINT, 'bot.model.set');
  assert.equal(MODEL_CATALOG_ENDPOINT, 'bot.model.catalog');
});
