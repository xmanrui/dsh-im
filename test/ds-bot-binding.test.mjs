import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDsBotClient } from '../plugin-src/host/ds-bot-client.mjs';
import { createDeliveryAdapter } from '../plugin-src/host/delivery-adapter.mjs';
import { createDeliveryRpcHandler } from '../plugin-src/host/delivery-rpc.mjs';
import { DeliveryService } from '../plugin-src/host/delivery-service.mjs';
import { BotWorkspaceStore, createBotWorkspaceScope, CURRENT_DOCUMENT_VERSION } from '../src/channels/shared/bot-workspace-store.mjs';
import { ConversationStateStore } from '../src/channels/shared/conversation-state-store.mjs';
import { askInWorkspaceSession } from '../src/channels/shared/workspace-session.mjs';
import { runModelCommand } from '../src/channels/shared/model-command.mjs';
import { privateDeliverySuggestionFromConversationKey } from '../plugin-src/host/delivery-suggestions.mjs';

const bot = { id: 'ds-one', name: 'stepBot', sessionId: 'session-one' };

test('DS Bot client updates Bot-wide model and effort through update-bot only', async () => {
  const calls = [];
  const ctx = {
    connection: {
      createPeer: (options) => ({ ...options, dispose() {} }),
      createSharedFetchHandler: () => ({
        async fetch(request, peer) {
          assert.equal(peer.principal.kind, 'owner');
          const body = await request.json();
          calls.push(body);
          return Response.json({ ok: true, value: {
            id: bot.id, model: body.payload.model, appliedModel: body.payload.model,
            ...(body.payload.effort ? { appliedEffort: body.payload.effort } : {}),
          } });
        },
      }),
    },
  };
  const client = createDsBotClient(ctx);
  assert.deepEqual(await client.updateBotModel(bot.id, {
    provider: 'provider', model: 'model', reasoningEffort: 'high',
  }), { selected: { provider: 'provider', model: 'model', reasoningEffort: 'high' } });
  assert.deepEqual(calls[0], {
    endpoint: 'update-bot', payload: { id: bot.id, model: 'provider/model', effort: 'high' },
  });
  assert.deepEqual(await client.updateBotModel(bot.id, {
    provider: 'provider', model: 'model',
  }), { selected: { provider: 'provider', model: 'model' } });
  assert.deepEqual(calls[1].payload, { id: bot.id, model: 'provider/model', effort: null });
  await assert.rejects(client.updateBotModel('bad/id', {
    provider: 'provider', model: 'model',
  }), { code: 'model-unavailable' });
  assert.equal(calls.length, 2);
});

test('DS Bot client rejects an unconfirmed applied model', async () => {
  const client = createDsBotClient({
    connection: {
      createPeer: () => ({ dispose() {} }),
      createSharedFetchHandler: () => ({
        async fetch() {
          return Response.json({ ok: true, value: {
            id: bot.id, model: 'provider/new', appliedModel: 'provider/old',
          } });
        },
      }),
    },
  });
  await assert.rejects(client.updateBotModel(bot.id, {
    provider: 'provider', model: 'new',
  }), { code: 'model-selection-mismatch' });
});

test('DS Bot client never dispatches an already cancelled model update', async () => {
  const controller = new AbortController();
  controller.abort();
  let requests = 0;
  const client = createDsBotClient({
    connection: {
      createSharedFetchHandler: () => ({
        async fetch() {
          requests++;
          return Response.json({ ok: true, value: {
            id: bot.id, model: 'provider/new', appliedModel: 'provider/new',
          } });
        },
      }),
    },
  });
  await assert.rejects(client.updateBotModel(bot.id, {
    provider: 'provider', model: 'new',
  }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(requests, 0);
});

test('DS Bot model update forwards cancellation to its in-flight request', async () => {
  const controller = new AbortController();
  let requestSignal;
  const client = createDsBotClient({
    connection: {
      createSharedFetchHandler: () => ({
        async fetch(request) {
          requestSignal = request.signal;
          assert.equal(requestSignal.aborted, false);
          controller.abort();
          requestSignal.throwIfAborted();
          return Response.json({ ok: true, value: {
            id: bot.id, model: 'provider/new', appliedModel: 'provider/new',
          } });
        },
      }),
    },
  });
  await assert.rejects(client.updateBotModel(bot.id, {
    provider: 'provider', model: 'new',
  }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(requestSignal.aborted, true);
  assert.equal(requestSignal.reason, controller.signal.reason);
});

test('legacy iMessage direct keys cannot disguise native group chats as private', () => {
  assert.equal(privateDeliverySuggestionFromConversationKey('imessage', 'direct:iMessage;+;chat123'), null);
  assert.equal(privateDeliverySuggestionFromConversationKey('imessage', 'direct:unknown'), null);
  assert.deepEqual(privateDeliverySuggestionFromConversationKey('imessage', 'direct:any;-;+123456789'), {
    kind: 'user', route: { chatGuid: 'any;-;+123456789' },
  });
});

test('DS Bot detection distinguishes installation, activation, read-only and unavailable; only exposes bot identity', async () => {
  let bundle = null;
  let value = { bots: [{ ...bot, secrets: 'never expose' }], readOnly: null };
  let requests = 0;
  const ctx = {
    get: () => ({ listBundles: () => bundle ? [bundle] : [] }),
    connection: {
      createPeer: (options) => ({ ...options, dispose() {} }),
      createSharedFetchHandler: () => ({
        async fetch(request, peer) {
          requests++;
          assert.equal(peer.principal.kind, 'owner');
          assert.equal(new URL(request.url).pathname, '/api/bot');
          assert.deepEqual(await request.json(), { endpoint: 'state', payload: {} });
          return Response.json({ ok: true, value });
        },
      }),
    },
  };
  const client = createDsBotClient(ctx);
  assert.equal((await client.status()).state, 'missing');
  bundle = { name: 'ds-bot', installed: true, enabled: false };
  assert.equal((await client.status()).state, 'disabled');
  assert.equal(requests, 0);
  bundle.enabled = true;
  assert.deepEqual(await client.status(), { state: 'ready', bots: [bot] });
  value.readOnly = 'another host';
  assert.equal((await client.status()).state, 'readonly');
  await assert.rejects(client.resolve(bot.id), { code: 'ds-bot-unavailable' });
  value = { bots: [] };
  assert.equal((await client.status()).state, 'ready');
  await assert.rejects(client.resolve(bot.id), { code: 'ds-bot-not-found' });
  ctx.connection.createSharedFetchHandler = () => { throw new Error('route unavailable'); };
  assert.equal((await client.status()).state, 'unavailable');
});

async function fixture(t, { channel = 'qq', key = 'c2c:user-one', target = { kind: 'user', route: { userOpenId: 'user-one' } } } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dsbot-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspaces.json');
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace: dir }).load();
  await workspaces.ensure('im-one');
  await workspaces.createDeliveryTarget('im-one', { targetId: 'private', ...target });
  const state = await new ConversationStateStore(join(dir, 'state.json')).load();
  await state.setSession(key, 'old-session');
  await state.setSession('other-conversation', 'untouched');
  let current = { ...bot };
  let selectedModel = { provider: 'provider-one', model: 'old', reasoningEffort: 'high' };
  const modelCalls = [];
  const modelCatalog = {
    groups: [{ id: 'provider-one', name: 'Provider One', models: [
      { id: 'old', name: 'Old', reasoning: { efforts: [
        { id: 'high', name: 'High' }, { id: 'max', name: 'Max' },
      ], defaultEffort: 'high' } },
      { id: 'new', name: 'New', reasoning: { efforts: [
        { id: 'low', name: 'Low' }, { id: 'max', name: 'Max' },
      ], defaultEffort: 'low' } },
    ] }], failures: [],
  };
  const dsBot = {
    async status() { return { state: 'ready', bots: current ? [current] : [] }; },
    async resolve(id) {
      if (!current || current.id !== id) throw Object.assign(new Error('missing'), { code: 'ds-bot-not-found' });
      return current;
    },
    async updateBotModel(id, selection) {
      modelCalls.push([id, selection]);
      selectedModel = {
        provider: selection.provider, model: selection.model,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      };
      return { selected: selectedModel };
    },
  };
  const sent = [];
  const adapter = createDeliveryAdapter({
    channel, workspaces, dsBot, stateFor: async () => state,
    coreController: { async sendProactiveText(...args) { sent.push(args); } },
  });
  const service = new DeliveryService({ dsBot });
  service.registerAdapter(adapter);
  const asks = [];
  const harness = {
    async sessionExists() { return true; },
    async getSessionModels() { return { ...modelCatalog, current: selectedModel }; },
    async isSessionRunning() { return false; },
    async hasActiveTurn() { return false; },
    async ask(id, text) { asks.push({ id, text }); return 'answer'; },
    async createSession() { return 'ordinary-new-session'; },
  };
  const scope = createBotWorkspaceScope(harness, { botId: 'im-one', workspaces, state, dsBot });
  return {
    path, dir, workspaces, state, dsBot, adapter, service, scope, asks, sent, key, modelCalls,
    setCurrent: (value) => { current = value; },
    ask: (text) => askInWorkspaceSession({ harness: scope.harness, state: scope.state, key, text }),
  };
}

test('bind, persist, rollover, desktop sync and unbind reuse one session without changing defaults or other chats', async (t) => {
  const f = await fixture(t);
  const deliveryBefore = JSON.parse(await readFile(f.path, 'utf8')).deliveryTargets;
  await f.service.bindDsBot('im-one', f.key, bot.id);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).deliveryTargets, deliveryBefore);
  assert.equal(f.workspaces.workspaceFor('im-one'), f.dir);
  assert.equal(f.state.sessionFor('other-conversation'), 'untouched');
  assert.equal((await f.ask('first')).sessionId, 'session-one');
  f.setCurrent({ ...bot, name: 'renamed', sessionId: 'session-two' });
  assert.equal((await f.service.listSessionSyncTargets('session-one')).length, 0);
  assert.equal((await f.service.listSessionSyncTargets('session-two')).length, 1);
  assert.equal((await f.ask('second')).sessionId, 'session-two');
  const mirror = (await f.service.listSessionSyncTargets('session-two'))[0];
  await f.service.sendSessionSyncText('im-one', mirror.targetId, 'session-two', 'desktop reply');
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.asks.map((entry) => entry.id), ['session-one', 'session-two']);
  const loaded = await new BotWorkspaceStore(f.path, { defaultWorkspace: f.dir }).load();
  assert.equal(loaded.dsBotBindingFor('im-one', f.key).dsBotId, bot.id);
  await f.service.setSessionSync('im-one', 'private', false);
  assert.equal((await f.service.listSessionSyncTargets('session-two')).length, 1);
  await assert.rejects(f.scope.harness.createSession({ conversationKey: f.key }), { code: 'ds-bot-bound' });
  await f.service.unbindDsBot('im-one', f.key);
  assert.equal(f.state.sessionFor(f.key), null);
  assert.equal(f.state.sessionFor('other-conversation'), 'untouched');
  assert.equal(f.workspaces.workspaceFor('im-one'), f.dir);
  assert.equal((await f.ask('after unbind')).sessionId, 'ordinary-new-session');
});

test('bound Feishu model picker and reasoning command update DS Bot without creating an IM session', async (t) => {
  const f = await fixture(t, { channel: 'feishu', key: 'p2p:ou_owner' });
  await f.service.bindDsBot('im-one', f.key, bot.id);
  // A saved binding can outlive the IM chat's locally remembered session.
  await f.state.clearSession(f.key);
  assert.equal(f.state.sessionFor(f.key), null);

  const model = await runModelCommand('/model provider-one/new max', f.scope.harness, f.scope.state, f.key);
  assert.match(model.message, /模型已切换为：/);
  assert.deepEqual(f.modelCalls, [[bot.id, {
    provider: 'provider-one', model: 'new', reasoningEffort: 'max',
  }]]);
  assert.equal(f.state.sessionFor(f.key), bot.sessionId);

  const reasoning = await runModelCommand('/reasoning --default', f.scope.harness, f.scope.state, f.key);
  assert.match(reasoning.message, /推理等级已切换为：/);
  assert.deepEqual(f.modelCalls[1], [bot.id, { provider: 'provider-one', model: 'new' }]);
  assert.equal(f.state.sessionFor(f.key), bot.sessionId);

  f.setCurrent({ ...bot, sessionId: 'session-two' });
  const rolled = await runModelCommand('/model 1', f.scope.harness, f.scope.state, f.key);
  assert.match(rolled.message, /模型已切换为：/);
  assert.equal(f.state.sessionFor(f.key), 'session-two');
  assert.deepEqual(f.modelCalls[2], [bot.id, { provider: 'provider-one', model: 'old' }]);
});

test('bound model selection rejects stale and missing DS Bot without mutating another session', async (t) => {
  const f = await fixture(t, { channel: 'feishu', key: 'p2p:ou_owner' });
  await f.service.bindDsBot('im-one', f.key, bot.id);
  await f.scope.harness.resolveDsBotSession(f.key);
  const handle = f.scope.harness.workspaceSession(bot.sessionId, f.key);
  f.setCurrent({ ...bot, sessionId: 'session-two' });
  await assert.rejects(handle.selectModel({ provider: 'provider-one', model: 'new' }), {
    code: 'workspace-session-stale',
  });
  assert.deepEqual(f.modelCalls, []);
  f.setCurrent(null);
  const result = await runModelCommand('/model 2', f.scope.harness, f.scope.state, f.key);
  assert.doesNotMatch(result.message, /模型已切换为：/);
  assert.deepEqual(f.modelCalls, []);
});

for (const command of ['/model provider-one/new max', '/reasoning --default']) {
  test(`bound ${command} cancelled during Bot resolution never updates the model`, async (t) => {
    const f = await fixture(t, { channel: 'feishu', key: 'p2p:ou_owner' });
    await f.service.bindDsBot('im-one', f.key, bot.id);
    const controller = new AbortController();
    const resolve = f.dsBot.resolve;
    let resolutions = 0;
    f.dsBot.resolve = async (id) => {
      const current = await resolve(id);
      // The command first resolves its session, then rechecks the Bot just
      // before selecting. Simulate bridge shutdown during that second read.
      if (++resolutions === 2) controller.abort();
      return current;
    };
    const result = await runModelCommand(command, f.scope.harness, f.scope.state, f.key, {
      signal: controller.signal,
    });
    assert.equal(resolutions, 2);
    assert.match(result.message, /切换已取消/);
    assert.deepEqual(f.modelCalls, []);
    assert.equal(f.state.sessionFor(f.key), bot.sessionId);
  });
}

test('binding needs no delivery target, and ordinary sync settings cannot disable or duplicate its sync', async (t) => {
  const f = await fixture(t);
  await f.service.deleteTarget('im-one', 'private');
  await f.service.bindDsBot('im-one', f.key, bot.id);
  assert.deepEqual(f.workspaces.listDeliveryTargets('im-one'), []);
  assert.equal((await f.service.listSessionSyncTargets(bot.sessionId)).length, 1);
  await f.service.createTarget('im-one', {
    targetId: 'notification', kind: 'user', route: { userOpenId: 'user-one' },
  });
  await f.service.setSessionSync('im-one', 'notification', true);
  assert.equal((await f.service.listSessionSyncTargets(bot.sessionId)).length, 1);
  const before = JSON.parse(await readFile(f.path, 'utf8')).deliveryTargets;
  await f.service.unbindDsBot('im-one', f.key);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).deliveryTargets, before);
  assert.equal(f.workspaces.listSessionSyncTargets().length, 1);
});

test('ordinary delivery sync remains visible and editable throughout binding, and resumes after unbinding', async (t) => {
  const f = await fixture(t);
  await f.service.setSessionSync('im-one', 'private', true);
  const original = await f.service.listTargets('im-one');
  await f.service.bindDsBot('im-one', f.key, bot.id);
  assert.deepEqual(await f.service.listTargets('im-one'), original);
  await f.service.setSessionSync('im-one', 'private', false);
  assert.deepEqual((await f.service.listTargets('im-one')).targets[0].sessionSync, {
    enabled: false, state: 'off',
  });
  assert.equal((await f.service.listSessionSyncTargets(bot.sessionId)).length, 1);
  await f.service.setSessionSync('im-one', 'private', true);
  assert.deepEqual(await f.service.listTargets('im-one'), original);
  assert.equal((await f.service.listSessionSyncTargets(bot.sessionId)).length, 1);
  await f.service.unbindDsBot('im-one', f.key);
  await f.ask('ordinary chat');
  const targets = await f.service.listSessionSyncTargets('ordinary-new-session');
  assert.equal(targets.length, 1);
  assert.equal(targets[0].targetId, 'private');
  assert.deepEqual(await f.service.listTargets('im-one'), original);
});

test('rollover while preparing a prompt resolves again without sending to the old part', async (t) => {
  const f = await fixture(t);
  await f.service.bindDsBot('im-one', f.key, bot.id);
  const prepared = [];
  const result = await askInWorkspaceSession({
    harness: f.scope.harness, state: f.scope.state, key: f.key, text: 'hello',
    prepareContent({ sessionId, text }) {
      prepared.push(sessionId);
      f.setCurrent({ ...bot, sessionId: 'session-two', parts: ['session-one'] });
      return text;
    },
  });
  assert.equal(result.sessionId, 'session-two');
  assert.deepEqual(prepared, ['session-one', 'session-two']);
  assert.deepEqual(f.asks, [{ id: 'session-two', text: 'hello' }]);
  const [target] = await f.service.listSessionSyncTargets('session-two');
  await f.service.sendSessionSyncText('im-one', target.targetId, 'session-one', 'already in flight');
  assert.equal(f.sent.length, 1);
  assert.deepEqual(await f.service.listSessionSyncTargets('session-one'), []);
});

test('rollover mid-turn when ask fails with turn-blocked re-resolves the fresh part', async (t) => {
  const f = await fixture(t);
  await f.service.bindDsBot('im-one', f.key, bot.id);
  let firstAsk = true;
  f.scope.harness.ask = async (id, text) => {
    if (firstAsk) {
      firstAsk = false;
      f.setCurrent({ ...bot, sessionId: 'session-two', parts: ['session-one'] });
      const error = new Error('Turn blocked');
      error.code = 'turn-blocked';
      throw error;
    }
    f.asks.push({ id, text });
    return 'answer-from-part-two';
  };
  const result = await f.ask('hello');
  assert.equal(result.sessionId, 'session-two');
  assert.equal(result.answer, 'answer-from-part-two');
  assert.deepEqual(f.asks, [{ id: 'session-two', text: 'hello' }]);
});

test('rollover when old session is archived re-resolves the fresh part without error', async (t) => {
  const f = await fixture(t);
  await f.service.bindDsBot('im-one', f.key, bot.id);
  f.scope.harness.isSessionArchived = async (id) => id === 'session-one';
  setTimeout(() => {
    f.setCurrent({ ...bot, sessionId: 'session-two', parts: ['session-one'] });
  }, 100);
  f.scope.harness.ask = async (id, text) => {
    f.asks.push({ id, text });
    return 'answer-from-part-two';
  };
  const result = await f.ask('hello');
  assert.equal(result.sessionId, 'session-two');
  assert.equal(result.answer, 'answer-from-part-two');
  assert.deepEqual(f.asks, [{ id: 'session-two', text: 'hello' }]);
});

test('missing DS Bot fails closed, while delivery target CRUD leaves bindings intact', async (t) => {
  const f = await fixture(t);
  await f.service.bindDsBot('im-one', f.key, bot.id);
  await f.workspaces.createDeliveryTarget('im-one', {
    targetId: 'duplicate', kind: 'user', route: { userOpenId: 'user-one' },
  });
  await f.service.deleteTarget('im-one', 'duplicate');
  await f.service.deleteTarget('im-one', 'private');
  assert.equal(f.workspaces.dsBotBindingFor('im-one', f.key).dsBotId, bot.id);
  f.setCurrent(null);
  await assert.rejects(f.ask('must not create another session'), { code: 'ds-bot-not-found' });
  assert.deepEqual(f.asks, []);
  assert.deepEqual(await f.service.listSessionSyncTargets('session-one'), []);
  await f.service.unbindDsBot('im-one', f.key);
  assert.equal(f.workspaces.dsBotBindingFor('im-one', f.key), null);
});

test('bound bot and private chat cannot be selected again or overwritten, and unbinding releases both', async (t) => {
  const f = await fixture(t);
  const secondKey = 'c2c:user-two';
  await f.state.setSession(secondKey, 'ordinary-two');
  await f.service.bindDsBot('im-one', f.key, bot.id);
  for (const [key, id] of [[f.key, bot.id], [f.key, 'ds-two'], [secondKey, bot.id]]) {
    await assert.rejects(f.service.bindDsBot('im-one', key, id), { code: 'ds-bot-binding-conflict' });
  }
  assert.equal(f.state.sessionFor(f.key), bot.sessionId);
  assert.equal(f.state.sessionFor(secondKey), 'ordinary-two');
  await f.service.unbindDsBot('im-one', f.key);
  assert.equal(f.state.sessionFor(f.key), null);
  assert.equal(f.workspaces.listDsBotBindings('im-one').length, 0);
  assert.equal((await f.adapter.listDsBotConversations('im-one')).some((entry) => entry.conversationKey === f.key && !entry.dsBotId), true);
  const loaded = await new BotWorkspaceStore(f.path, { defaultWorkspace: f.dir }).load();
  assert.deepEqual(loaded.dsBotConversationKeys('im-one'), [f.key]);
  assert.equal(loaded.listDsBotBindings('im-one').length, 0);
  await f.service.bindDsBot('im-one', f.key, bot.id);
  assert.equal(f.workspaces.dsBotBindingFor('im-one', f.key).dsBotId, bot.id);
});

test('concurrent selection of the same bot commits once and restores the rejected chat mapping', async (t) => {
  const f = await fixture(t);
  const secondKey = 'c2c:user-two';
  await f.state.setSession(secondKey, 'ordinary-two');
  const results = await Promise.allSettled([
    f.service.bindDsBot('im-one', f.key, bot.id),
    f.service.bindDsBot('im-one', secondKey, bot.id),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'ds-bot-binding-conflict');
  const [saved] = f.workspaces.listDsBotBindings('im-one');
  const rejectedKey = saved.conversationKey === f.key ? secondKey : f.key;
  assert.equal(f.state.sessionFor(rejectedKey), rejectedKey === f.key ? 'old-session' : 'ordinary-two');
});

const privateRoutes = [
  ['weixin', 'p2p:wx', { kind: 'user', route: { toUserId: 'wx' } }],
  ['feishu', 'p2p:ou_user', { kind: 'user', route: { openId: 'ou_user' } }],
  ['dingtalk', 'p2p:ding', { kind: 'user', route: { userId: 'ding' } }],
  ['wecom', 'direct:wecom', { kind: 'user', route: { chatId: 'wecom' } }],
  ['wecom-app', 'p2p:wecom', { kind: 'user', route: { chatId: 'wecom' } }],
  ['qq', 'c2c:qq', { kind: 'user', route: { userOpenId: 'qq' } }],
  ['slack', 'direct:D123', { kind: 'conversation', route: { channelId: 'D123' } }],
  ['telegram', 'direct:123', { kind: 'chat', route: { chatId: '123' } }],
  ['discord', 'direct:123', { kind: 'channel', route: { channelId: '123' } }],
  ['whatsapp', 'direct:123456789@s.whatsapp.net', { kind: 'user', route: { jid: '123456789@s.whatsapp.net' } }],
  ['imessage', 'direct:iMessage;-;user@example.com', { kind: 'user', route: { chatGuid: 'iMessage;-;user@example.com' } }],
];

for (const [channel, key, target] of privateRoutes) {
  test(`${channel}: supports verified private delivery targets; a matching group record does not authorize binding`, async (t) => {
    const f = await fixture(t, { channel, key, target });
    assert.equal((await f.adapter.listDsBotConversations('im-one')).some((entry) => entry.conversationKey === key), true);
    await f.service.bindDsBot('im-one', f.key, bot.id);
    assert.equal((await f.ask('hello')).sessionId, bot.sessionId);
    await f.service.unbindDsBot('im-one', f.key);
    await f.state.setSession(key.replace(/^[^:]+:/, 'group:'), 'group-session');
    await f.workspaces.ensure('im-two');
    assert.deepEqual(await f.adapter.listDsBotConversations('im-two'), []);
    await assert.rejects(f.service.bindDsBot('im-two', f.key, bot.id), { code: 'ds-bot-private-required' });
  });
}

test('version 3 ordinary sync survives the binding migration and restart', async (t) => {
  const f = await fixture(t);
  const saved = JSON.parse(await readFile(f.path, 'utf8'));
  saved.version = 3;
  saved.deliveryTargets['im-one'].private.sessionSync = { conversationKey: f.key };
  await writeFile(f.path, JSON.stringify(saved));
  const loaded = await new BotWorkspaceStore(f.path, { defaultWorkspace: f.dir }).load();
  assert.equal(loaded.listSessionSyncTargets()[0].conversationKey, f.key);
  await loaded.setDsBotBinding('im-one', f.key, bot.id);
  assert.equal(loaded.listSessionSyncTargets()[0].conversationKey, f.key);
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).version, CURRENT_DOCUMENT_VERSION);
});

test('version 4 bindings remain intact when an unbound private chat is retained in version 5', async (t) => {
  const f = await fixture(t);
  const saved = JSON.parse(await readFile(f.path, 'utf8'));
  saved.version = 4;
  saved.dsBotBindings = { 'im-one': { [f.key]: bot.id } };
  await writeFile(f.path, JSON.stringify(saved));
  const loaded = await new BotWorkspaceStore(f.path, { defaultWorkspace: f.dir }).load();
  assert.equal(loaded.dsBotBindingFor('im-one', f.key).dsBotId, bot.id);
  await loaded.setDsBotBinding('im-one', f.key, null);
  const restarted = await new BotWorkspaceStore(f.path, { defaultWorkspace: f.dir }).load();
  assert.equal(restarted.dsBotBindingFor('im-one', f.key), null);
  assert.deepEqual(restarted.dsBotConversationKeys('im-one'), [f.key]);
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).version, CURRENT_DOCUMENT_VERSION);
});
test('RPC validates the binding payload; remote harness cannot bind a local DS Bot', async (t) => {
  const f = await fixture(t);
  const remote = new DeliveryService({ dsBot: f.dsBot, unavailableSessionSyncChannels: ['qq'] });
  remote.registerAdapter(f.adapter);
  assert.equal((await remote.dsBotStatus('im-one')).state, 'remote');
  await assert.rejects(remote.bindDsBot('im-one', f.key, bot.id), { code: 'ds-bot-unavailable' });
  const rpc = createDeliveryRpcHandler(f.service);
  assert.equal((await rpc('ds-bot.bind', { botId: 'im-one', conversationKey: f.key, dsBotId: bot.id, sessionId: 'forged' })).error.code, 'bad-request');
  assert.equal((await rpc('ds-bot.bind', { botId: 'im-one', conversationKey: f.key, dsBotId: bot.id })).ok, true);
  const status = await rpc('ds-bot.status', { botId: 'im-one' });
  assert.deepEqual(status.value.bots, [{ id: bot.id, name: bot.name }]);
});

test('sidebar avatars expose only bound current sessions, follow rollover and disappear on unbind', async (t) => {
  const f = await fixture(t);
  const rpc = createDeliveryRpcHandler(f.service);
  let reads = 0;
  const status = f.dsBot.status;
  f.dsBot.status = () => { reads++; return status(); };
  assert.deepEqual(await f.service.listDsBotSessions(), []);
  assert.equal(reads, 0, 'unbound installations need no DS Bot request');
  await f.service.bindDsBot('im-one', f.key, bot.id);
  const appearance = { id: bot.id, name: bot.name, color: 'red', avatar: { shape: 'whale' } };
  f.setCurrent({ ...appearance, sessionId: 'current', parts: ['history'], secret: 'private' });
  assert.deepEqual(await rpc('ds-bot.sessions.list', {}), {
    ok: true, value: [{ sessionId: 'current', bot: appearance }],
  });
  assert.equal((await rpc('ds-bot.sessions.list', { botId: 'im-one' })).error.code, 'bad-request');
  f.setCurrent({ ...appearance, sessionId: 'next', parts: ['current', 'history'] });
  assert.deepEqual(await f.service.listDsBotSessions(), [{ sessionId: 'next', bot: appearance }]);
  const remote = new DeliveryService({ dsBot: f.dsBot, unavailableSessionSyncChannels: ['qq'] });
  remote.registerAdapter(f.adapter);
  assert.deepEqual(await remote.listDsBotSessions(), []);
  f.dsBot.status = async () => ({ state: 'disabled', bots: [] });
  assert.deepEqual(await f.service.listDsBotSessions(), []);
  f.dsBot.status = status;
  await f.service.unbindDsBot('im-one', f.key);
  assert.deepEqual(await f.service.listDsBotSessions(), []);
});

test('DS Bot async question uses the registered route and rejects a stale answer', async () => {
  let question = { id: 'q1', question: 'Continue?', options: [{ label: 'Yes' }] };
  const calls = [];
  const client = createDsBotClient({ connection: {
    createPeer: (options) => ({ ...options, dispose() {} }),
    createSharedFetchHandler: () => ({ async fetch(request, peer) {
      assert.equal(peer.principal.kind, 'owner');
      const body = await request.json();
      calls.push(body);
      if (body.endpoint === 'state') return Response.json({ ok: true, value: {
        bots: [bot], questions: { [bot.sessionId]: question, unrelated: { id: 'private' } },
      } });
      if (!question) return Response.json({ ok: false, error: { code: 'bot/stale' } });
      question = null;
      return Response.json({ ok: true, value: true });
    } }),
  } });
  assert.deepEqual(await client.question(bot.sessionId), question);
  assert.equal(await client.question('old-session'), null);
  assert.equal(await client.answerQuestion(bot.sessionId, 'q1', { selected: ['Yes'] }), true);
  assert.deepEqual(calls.at(-1), { endpoint: 'answer-question', payload: {
    sessionId: bot.sessionId, questionId: 'q1', answer: { selected: ['Yes'] },
  } });
  await assert.rejects(client.answerQuestion(bot.sessionId, 'q1', { selected: ['Yes'] }), { code: 'interaction-not-pending' });
});
