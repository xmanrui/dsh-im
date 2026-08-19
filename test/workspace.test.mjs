import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BotWorkspaceStore,
  createBotScopedHarness,
  createBotWorkspaceScope,
  createWorkspaceAwareController,
  observeBotWorkspaceRemovals,
  validateWorkspacePath,
} from '../src/channels/shared/bot-workspace-store.mjs';
import {
  connectionTestTarget,
  rememberConnectionTestTarget,
} from '../src/channels/shared/connection-test.mjs';
import {
  runWorkspaceCommand,
  splitWorkspaceCommandMessage,
} from '../src/channels/shared/workspace-command.mjs';
import { TextHarnessBridge } from '../src/channels/shared/text-harness-bridge.mjs';
import { askInWorkspaceSession } from '../src/channels/shared/workspace-session.mjs';
import { HarnessClient as WeixinHarnessClient } from '../src/channels/weixin/harness-client.mjs';
import { HarnessClient as FeishuHarnessClient } from '../src/channels/feishu/harness-client.mjs';
import { HarnessClient as DingtalkHarnessClient } from '../src/channels/dingtalk/harness-client.mjs';
import { ConversationStateStore } from '../src/channels/shared/conversation-state-store.mjs';
import { WeixinStateStore } from '../src/channels/weixin/state-store.mjs';
import { StateStore as FeishuStateStore } from '../src/channels/feishu/state-store.mjs';
import { DingtalkStateStore } from '../src/channels/dingtalk/state-store.mjs';
import { WecomStateStore } from '../src/channels/wecom/state-store.mjs';
import { QqStateStore } from '../src/channels/qq/state-store.mjs';
import {
  TOKEN_BOT_ENDPOINTS,
  createTokenBotRpcHandler,
} from '../plugin-src/host/channels/shared/rpc.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-workspace-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const defaultWorkspace = join(root, 'default');
  const alternateWorkspace = join(root, 'alternate workspace');
  await Promise.all([
    mkdir(defaultWorkspace),
    mkdir(alternateWorkspace),
  ]);
  return { root, defaultWorkspace, alternateWorkspace, path: join(root, 'workspaces.json') };
}

test('BotWorkspaceStore persists the creation default and keeps bots isolated', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const store = await new BotWorkspaceStore(path, { defaultWorkspace }).load();

  assert.equal(await store.ensure('bot_one'), defaultWorkspace);
  assert.equal(await store.ensure('bot_two'), defaultWorkspace);
  await store.setWorkspace('bot_one', alternateWorkspace);

  assert.equal(store.workspaceFor('bot_one'), alternateWorkspace);
  assert.equal(store.workspaceFor('bot_two'), defaultWorkspace);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    version: 1,
    workspaces: { bot_one: alternateWorkspace, bot_two: defaultWorkspace },
  });

  const reloaded = await new BotWorkspaceStore(path, { defaultWorkspace: tmpdir() }).load();
  assert.equal(reloaded.workspaceFor('bot_one'), alternateWorkspace);
  assert.equal(reloaded.workspaceFor('bot_two'), defaultWorkspace);
});

test('BotWorkspaceStore uses process.cwd() when a bot has no configured workspace', async (t) => {
  const { root } = await fixture(t);
  const store = await new BotWorkspaceStore(join(root, 'cwd-workspaces.json')).load();
  assert.equal(await store.ensure('bot_cwd'), process.cwd());
});

test('connection test targets survive a new workspace scope for the same bot', async (t) => {
  const { path, defaultWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_reconnect');
  const state = {};
  const harness = {};
  const beforeReconnect = createBotWorkspaceScope(harness, {
    botId: 'bot_reconnect', workspaces, state,
  });
  const afterReconnect = createBotWorkspaceScope(harness, {
    botId: 'bot_reconnect', workspaces, state,
  });

  assert.equal(rememberConnectionTestTarget(beforeReconnect.state, { channelId: 'D123' }), true);
  assert.deepEqual(connectionTestTarget(afterReconnect.state), { channelId: 'D123' });
});

test('workspace writes roll back updates while committed removals stay retired in memory', async (t) => {
  const { root, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const storeDirectory = join(root, 'workspace-store');
  const storePath = join(storeDirectory, 'workspaces.json');
  await mkdir(storeDirectory);
  const store = await new BotWorkspaceStore(storePath, { defaultWorkspace }).load();
  await store.ensure('bot_io');
  await store.setWorkspace('bot_io', alternateWorkspace);

  await rename(storeDirectory, `${storeDirectory}-saved`);
  await writeFile(storeDirectory, 'blocks workspace persistence');
  let clears = 0;
  await assert.rejects(store.setWorkspace('bot_io', defaultWorkspace, {
    clearSessions: async () => { clears += 1; },
  }));
  assert.equal(clears, 1);
  assert.equal(store.workspaceFor('bot_io'), alternateWorkspace);
  await assert.rejects(store.remove('bot_io'));
  assert.equal(store.has('bot_io'), false);
  assert.equal(store.workspaceFor('bot_io'), defaultWorkspace);

  await rm(storeDirectory, { force: true });
  await rename(`${storeDirectory}-saved`, storeDirectory);
  const staleDisk = await new BotWorkspaceStore(storePath, { defaultWorkspace }).load();
  assert.equal(staleDisk.workspaceFor('bot_io'), alternateWorkspace);
  await staleDisk.reconcile([]);
  assert.equal(staleDisk.has('bot_io'), false);

  const blockedParent = join(root, 'blocked-parent');
  await writeFile(blockedParent, 'not a directory');
  const broken = new BotWorkspaceStore(join(blockedParent, 'workspaces.json'), { defaultWorkspace });
  await assert.rejects(broken.ensure('bot_new'));
  assert.equal(broken.workspaceFor('bot_new'), defaultWorkspace);
});

test('workspace validation rejects relative, missing, and file paths', async (t) => {
  const { root } = await fixture(t);
  const file = join(root, 'file.txt');
  await writeFile(file, 'not a directory');

  await assert.rejects(validateWorkspacePath('relative/path'), { code: 'workspace-not-absolute' });
  await assert.rejects(validateWorkspacePath(join(root, 'missing')), { code: 'workspace-not-found' });
  await assert.rejects(validateWorkspacePath(file), { code: 'workspace-not-directory' });
});

test('bot-scoped Harness creates sessions in each bot workspace and switching clears sessions', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await Promise.all([workspaces.ensure('bot_one'), workspaces.ensure('bot_two')]);
  const calls = [];
  const harness = {
    async createSession(options) { calls.push(options); return `session-${calls.length}`; },
    async ensureRunning() { return true; },
  };
  let cleared = 0;
  const state = { async clearSessions() { cleared += 1; } };
  const one = createBotScopedHarness(harness, { botId: 'bot_one', workspaces, state });
  const two = createBotScopedHarness(harness, { botId: 'bot_two', workspaces, state });

  await one.createSession();
  await one.switchWorkspace(alternateWorkspace);
  await Promise.all([one.createSession(), two.createSession()]);

  assert.equal(cleared, 1);
  assert.deepEqual(calls.map((call) => call.workspace), [
    defaultWorkspace,
    alternateWorkspace,
    defaultWorkspace,
  ]);
});

test('an old session cannot be written back while RPC switches the bot workspace', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_race');
  let finishCreation;
  let existenceChecks = 0;
  const harness = {
    createSession() {
      return new Promise((resolveCreation) => { finishCreation = resolveCreation; });
    },
    async sessionExists() {
      existenceChecks += 1;
      return true;
    },
  };
  let persistedSession = null;
  const state = {
    async clearSessions() { persistedSession = null; },
    async setSession(_key, sessionId) { persistedSession = sessionId; },
  };
  const scope = createBotWorkspaceScope(harness, { botId: 'bot_race', workspaces, state });
  const controller = createWorkspaceAwareController({
    status() { return { bots: [{ botId: 'bot_race' }] }; },
  }, {
    workspaces,
    stateFor: async () => state,
  });

  const oldSession = scope.harness.createSession();
  await controller.updateWorkspace('bot_race', alternateWorkspace);
  finishCreation('session-from-old-workspace');
  const sessionId = await oldSession;

  assert.equal(await scope.state.setSession('conversation', sessionId), false);
  assert.equal(persistedSession, null);

  const oldSessionForLookup = scope.harness.createSession();
  await controller.updateWorkspace('bot_race', defaultWorkspace);
  finishCreation('second-session-from-old-workspace');
  assert.equal(await scope.harness.sessionExists(await oldSessionForLookup), false);
  assert.equal(existenceChecks, 0, 'stale sessions are rejected before asking Harness');
});

test('a prompt retries in the new workspace when switching after session creation', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_prompt');
  const createdIn = [];
  const asks = [];
  let sessionNumber = 0;
  let markFirstSet;
  let releaseFirstSet;
  const firstSet = new Promise((resolveSet) => { markFirstSet = resolveSet; });
  const firstSetGate = new Promise((resolveSet) => { releaseFirstSet = resolveSet; });
  const harness = {
    async createSession({ workspace }) {
      createdIn.push(workspace);
      sessionNumber += 1;
      return `session-${sessionNumber}`;
    },
    async sessionExists() { return true; },
    async ask(sessionId) { asks.push(sessionId); return `answer-${sessionId}`; },
  };
  let persistedSession = null;
  const state = {
    sessionFor() { return persistedSession; },
    async setSession(_key, sessionId) {
      persistedSession = sessionId;
      if (sessionId === 'session-1') {
        markFirstSet();
        await firstSetGate;
      }
    },
    async clearSessions() { persistedSession = null; },
  };
  const scope = createBotWorkspaceScope(harness, { botId: 'bot_prompt', workspaces, state });
  const controller = createWorkspaceAwareController({
    status() { return { bots: [{ botId: 'bot_prompt' }] }; },
  }, { workspaces, stateFor: async () => state });

  const prompting = askInWorkspaceSession({
    harness: scope.harness,
    state: scope.state,
    key: 'conversation',
    text: 'hello',
  });
  await firstSet;
  await controller.updateWorkspace('bot_prompt', alternateWorkspace);
  releaseFirstSet();

  const result = await prompting;
  assert.equal(result.answer, 'answer-session-2');
  assert.deepEqual(createdIn, [defaultWorkspace, alternateWorkspace]);
  assert.deepEqual(asks, ['session-2']);
  assert.equal(persistedSession, 'session-2');
});

test('a workspace switch lets an already-started reply finish and moves the next message', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_started_prompt');
  const createdIn = [];
  const asks = [];
  let sessionNumber = 0;
  let markFirstAskStarted;
  let releaseFirstAsk;
  const firstAskStarted = new Promise((resolveStarted) => { markFirstAskStarted = resolveStarted; });
  const firstAskGate = new Promise((resolveAsk) => { releaseFirstAsk = resolveAsk; });
  const harness = {
    async createSession({ workspace }) {
      createdIn.push(workspace);
      sessionNumber += 1;
      return `session-${sessionNumber}`;
    },
    async sessionExists() { return true; },
    async ask(sessionId, text) {
      asks.push({ sessionId, text });
      if (asks.length === 1) {
        markFirstAskStarted();
        await firstAskGate;
      }
      return `answer-${sessionId}`;
    },
  };
  let persistedSession = null;
  const state = {
    sessionFor() { return persistedSession; },
    async setSession(_key, sessionId) { persistedSession = sessionId; },
    async clearSessions() { persistedSession = null; },
  };
  const scope = createBotWorkspaceScope(harness, {
    botId: 'bot_started_prompt', workspaces, state,
  });
  const controller = createWorkspaceAwareController({
    status() { return { bots: [{ botId: 'bot_started_prompt' }] }; },
  }, { workspaces, stateFor: async () => state });

  const first = askInWorkspaceSession({
    harness: scope.harness,
    state: scope.state,
    key: 'conversation',
    text: 'first',
  });
  await firstAskStarted;
  await controller.updateWorkspace('bot_started_prompt', alternateWorkspace);
  assert.equal(workspaces.workspaceFor('bot_started_prompt'), alternateWorkspace);
  releaseFirstAsk();

  assert.deepEqual(await first, {
    sessionId: 'session-1',
    answer: 'answer-session-1',
  });
  assert.deepEqual(await askInWorkspaceSession({
    harness: scope.harness,
    state: scope.state,
    key: 'conversation',
    text: 'second',
  }), {
    sessionId: 'session-2',
    answer: 'answer-session-2',
  });
  assert.deepEqual(createdIn, [defaultWorkspace, alternateWorkspace]);
  assert.deepEqual(asks, [
    { sessionId: 'session-1', text: 'first' },
    { sessionId: 'session-2', text: 'second' },
  ]);
});

test('deleting and rebinding a bot cannot accept an old in-flight session', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_rebind');
  let finishCreation;
  const harness = {
    createSession() {
      return new Promise((resolveCreation) => { finishCreation = resolveCreation; });
    },
  };
  let persistedSession = null;
  const state = {
    async clearSessions() { persistedSession = null; },
    async setSession(_key, sessionId) { persistedSession = sessionId; },
  };
  const oldScope = createBotWorkspaceScope(harness, { botId: 'bot_rebind', workspaces, state });
  let bots = [{ botId: 'bot_rebind' }];
  const controller = createWorkspaceAwareController({
    status() { return { bots }; },
    async deleteBot() { bots = []; return { bots }; },
  }, { workspaces, stateFor: async () => state });

  const oldSession = oldScope.harness.createSession();
  await controller.deleteBot('bot_rebind');
  await workspaces.ensure('bot_rebind');
  finishCreation('session-before-delete');

  assert.equal(await oldScope.state.setSession('conversation', await oldSession), false);
  assert.equal(persistedSession, null);
  await assert.rejects(oldScope.harness.switchWorkspace(alternateWorkspace), {
    code: 'workspace-bot-not-found',
  });
  const reboundScope = createBotWorkspaceScope(harness, {
    botId: 'bot_rebind', workspaces, state,
  });
  assert.equal(await reboundScope.harness.switchWorkspace(alternateWorkspace), alternateWorkspace);
});

test('a successful public delete clears sessions before a same-id rebind', async (t) => {
  const { path, defaultWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_reused_id');
  let persistedSession = 'old-session';
  const state = {
    sessionFor() { return persistedSession; },
    async setSession(_key, sessionId) { persistedSession = sessionId; },
    async clearSessions() { persistedSession = null; },
  };
  let bots = [{ botId: 'bot_reused_id' }];
  const controller = createWorkspaceAwareController({
    status() { return { bots }; },
    async deleteBot() {
      assert.equal(persistedSession, null, 'session cleanup precedes the config deletion');
      bots = [];
      return { bots };
    },
  }, { workspaces, stateFor: async () => state });

  await controller.deleteBot('bot_reused_id');
  await workspaces.ensure('bot_reused_id');
  const asks = [];
  const scope = createBotWorkspaceScope({
    async createSession() { return 'new-session'; },
    async sessionExists() { return true; },
    async ask(sessionId) { asks.push(sessionId); return 'new-answer'; },
  }, { botId: 'bot_reused_id', workspaces, state });

  assert.deepEqual(await askInWorkspaceSession({
    harness: scope.harness,
    state: scope.state,
    key: 'conversation',
    text: 'after rebind',
  }), { sessionId: 'new-session', answer: 'new-answer' });
  assert.deepEqual(asks, ['new-session']);
  assert.equal(persistedSession, 'new-session');
});

test('session cleanup load or clear failures do not block public deletion', async (t) => {
  const { path, defaultWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => { warnings.push(args); });

  for (const failure of ['load', 'clear']) {
    const botId = `bot_cleanup_${failure}`;
    await workspaces.ensure(botId);
    let bots = [{ botId }];
    let deletions = 0;
    const controller = createWorkspaceAwareController({
      status() { return { bots }; },
      async deleteBot() {
        deletions += 1;
        bots = [];
        return { bots };
      },
    }, {
      workspaces,
      stateFor: async () => {
        if (failure === 'load') throw new Error('state load failed');
        return { async clearSessions() { throw new Error('session clear failed'); } };
      },
    });

    await controller.deleteBot(botId);
    assert.equal(deletions, 1);
    assert.equal(workspaces.has(botId), false);
  }
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every(([message]) => message.includes('ignored session cleanup failure')));
});

test('an old deletion transaction cannot retire a same-id rebound bot', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_lifecycle');
  await workspaces.setWorkspace('bot_lifecycle', alternateWorkspace);
  const firstIncarnation = workspaces.incarnationFor('bot_lifecycle');
  let bots = [{ botId: 'bot_lifecycle', lifecycle: 'old' }];
  const observedStore = observeBotWorkspaceRemovals({
    async remove(botId) { return { botId }; },
  }, { workspaces });
  const controller = createWorkspaceAwareController({
    status() { return { bots }; },
    async deleteBot(botId) {
      // The config commit retires the old lifecycle before the outer adapter
      // resumes. Simulate a queued same-account provisioning completing in
      // that gap and creating a new incarnation with the deterministic id.
      await observedStore.remove(botId);
      await workspaces.ensure(botId, { workspace: defaultWorkspace });
      bots = [{ botId, lifecycle: 'rebound' }];
      return { bots };
    },
  }, { workspaces, stateFor: async () => ({ async clearSessions() {} }) });

  const result = await controller.deleteBot('bot_lifecycle');
  assert.equal(workspaces.has('bot_lifecycle'), true);
  assert.equal(workspaces.workspaceFor('bot_lifecycle'), defaultWorkspace);
  assert.notEqual(workspaces.incarnationFor('bot_lifecycle'), firstIncarnation);
  assert.equal(result.bots[0].workspace, defaultWorkspace);

  const staleRemoval = await workspaces.beginRemoval('bot_lifecycle');
  await workspaces.retireAfterConfigCommit('bot_lifecycle');
  await workspaces.ensure('bot_lifecycle', { workspace: alternateWorkspace });
  const latestIncarnation = workspaces.incarnationFor('bot_lifecycle');
  assert.equal(await workspaces.abortRemoval(staleRemoval), false);
  assert.equal((await workspaces.finishRemoval(staleRemoval)).stale, true);
  assert.equal(workspaces.has('bot_lifecycle'), true);
  assert.equal(workspaces.workspaceFor('bot_lifecycle'), alternateWorkspace);
  assert.equal(workspaces.incarnationFor('bot_lifecycle'), latestIncarnation);
});

test('a workspace update for an old incarnation cannot mutate a same-id rebound bot', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_update_aba');
  let markStateRequested;
  let releaseState;
  const stateRequested = new Promise((resolveRequested) => { markStateRequested = resolveRequested; });
  const stateGate = new Promise((resolveState) => { releaseState = resolveState; });
  let clears = 0;
  const controller = createWorkspaceAwareController({
    status() { return { bots: [{ botId: 'bot_update_aba' }] }; },
  }, {
    workspaces,
    stateFor: async () => {
      markStateRequested();
      await stateGate;
      return { async clearSessions() { clears += 1; } };
    },
  });

  const updating = controller.updateWorkspace('bot_update_aba', alternateWorkspace);
  await stateRequested;
  await workspaces.retireAfterConfigCommit('bot_update_aba');
  await workspaces.ensure('bot_update_aba', { workspace: defaultWorkspace });
  releaseState();

  await assert.rejects(updating, { code: 'workspace-bot-not-found' });
  assert.equal(clears, 0);
  assert.equal(workspaces.has('bot_update_aba'), true);
  assert.equal(workspaces.workspaceFor('bot_update_aba'), defaultWorkspace);
});

test('a blocked workspace switch for one bot does not block another bot session', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await Promise.all([workspaces.ensure('bot_slow'), workspaces.ensure('bot_ready')]);
  let markClearStarted;
  let releaseClear;
  const clearStarted = new Promise((resolveClear) => { markClearStarted = resolveClear; });
  const clearGate = new Promise((resolveClear) => { releaseClear = resolveClear; });
  const stateSlow = {
    async clearSessions() { markClearStarted(); await clearGate; },
  };
  const stateReady = { async clearSessions() {} };
  const created = [];
  const harness = {
    async createSession({ workspace }) { created.push(workspace); return 'ready-session'; },
  };
  const slow = createBotScopedHarness(harness, {
    botId: 'bot_slow', workspaces, state: stateSlow,
  });
  const ready = createBotScopedHarness(harness, {
    botId: 'bot_ready', workspaces, state: stateReady,
  });

  const switching = slow.switchWorkspace(alternateWorkspace);
  await clearStarted;
  assert.equal(await ready.createSession(), 'ready-session');
  assert.deepEqual(created, [defaultWorkspace]);
  releaseClear();
  await switching;
});

test('clearing workspace sessions preserves message deduplication and channel cursors', async (t) => {
  const { root } = await fixture(t);
  const stores = [
    ['shared', await new ConversationStateStore(join(root, 'shared-state.json')).load()],
    ['weixin', await new WeixinStateStore(join(root, 'weixin-state.json')).load()],
    ['feishu', await new FeishuStateStore(join(root, 'feishu-state.json')).load()],
    ['dingtalk', await new DingtalkStateStore(join(root, 'dingtalk-state.json'), {
      idFactory: () => 'request',
      now: () => '2026-08-17T00:00:00.000Z',
    }).load()],
    ['wecom', await new WecomStateStore(join(root, 'wecom-state.json')).load()],
    ['qq', await new QqStateStore(join(root, 'qq-state.json')).load()],
  ];

  for (const [name, store] of stores) {
    await store.setSession('conversation', `session-${name}`);
    await store.markSeen(`message-${name}`);
  }
  await stores[0][1].setCursor(42);
  await stores[1][1].setGetUpdatesBuf('next-weixin-cursor');
  await stores[3][1].recordPendingSender('staff-one', 'User One');

  for (const [name, store] of stores) {
    await store.clearSessions();
    assert.equal(store.sessionFor('conversation'), null, `${name} clears its Harness session`);
    assert.equal(store.hasSeen(`message-${name}`), true, `${name} keeps message deduplication`);
  }
  assert.equal(stores[0][1].cursor(), 42);
  assert.equal(stores[1][1].getUpdatesBuf(), 'next-weixin-cursor');
  assert.equal(stores[3][1].pendingSenders().length, 1);
});

test('workspace-aware controller decorates status and updates one bot', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await Promise.all([workspaces.ensure('bot_one'), workspaces.ensure('bot_two')]);
  const cleared = [];
  const controller = createWorkspaceAwareController({
    status() { return { bots: [{ botId: 'bot_one' }, { botId: 'bot_two' }] }; },
    async deleteBot(botId) { return { bots: [{ botId: botId === 'bot_one' ? 'bot_two' : 'bot_one' }] }; },
  }, {
    workspaces,
    stateFor: async (botId) => ({ async clearSessions() { cleared.push(botId); } }),
  });

  const updated = await controller.updateWorkspace('bot_one', alternateWorkspace);
  assert.equal(updated.bots[0].workspace, alternateWorkspace);
  assert.equal(updated.bots[1].workspace, defaultWorkspace);
  assert.deepEqual(cleared, ['bot_one']);

  await assert.rejects(controller.updateWorkspace('missing_bot', alternateWorkspace), {
    code: 'workspace-bot-not-found',
  });
});

test('workspace updates serialize with deletion and cannot recreate a removed bot mapping', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_delete');
  await workspaces.setWorkspace('bot_delete', alternateWorkspace);
  let bots = [{ botId: 'bot_delete' }];
  let releaseDelete;
  let markDeleteStarted;
  const deleteStarted = new Promise((resolveStarted) => { markDeleteStarted = resolveStarted; });
  const deleteGate = new Promise((resolveDelete) => { releaseDelete = resolveDelete; });
  let clears = 0;
  const controller = createWorkspaceAwareController({
    status() { return { bots }; },
    async deleteBot() {
      markDeleteStarted();
      await deleteGate;
      bots = [];
      return { bots };
    },
  }, {
    workspaces,
    stateFor: async () => ({ async clearSessions() { clears += 1; } }),
  });

  const deleting = controller.deleteBot('bot_delete');
  await deleteStarted;
  const lateUpdate = controller.updateWorkspace('bot_delete', defaultWorkspace);
  releaseDelete();
  await deleting;
  await assert.rejects(lateUpdate, { code: 'workspace-bot-not-found' });
  assert.equal(workspaces.workspaceFor('bot_delete'), defaultWorkspace);
  assert.equal(clears, 1);
});

test('workspace deletion keeps the durable path until the bot config commits', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_durable');
  await workspaces.setWorkspace('bot_durable', alternateWorkspace);
  let bots = [{ botId: 'bot_durable' }];
  let markDeleteStarted;
  let releaseDelete;
  const deleteStarted = new Promise((resolveDelete) => { markDeleteStarted = resolveDelete; });
  const deleteGate = new Promise((resolveDelete) => { releaseDelete = resolveDelete; });
  const controller = createWorkspaceAwareController({
    status() { return { bots }; },
    async deleteBot() {
      markDeleteStarted();
      await deleteGate;
      bots = [];
      return { bots };
    },
  }, { workspaces, stateFor: async () => ({ async clearSessions() {} }) });

  const deleting = controller.deleteBot('bot_durable');
  await deleteStarted;
  assert.equal(JSON.parse(await readFile(path, 'utf8')).workspaces.bot_durable, alternateWorkspace);
  releaseDelete();
  await deleting;
  assert.equal(workspaces.has('bot_durable'), false);
});

test('a failed bot deletion aborts the fence without rewriting its workspace', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_abort');
  await workspaces.setWorkspace('bot_abort', alternateWorkspace);
  const state = { async clearSessions() {} };
  const scope = createBotWorkspaceScope({ async createSession() {} }, {
    botId: 'bot_abort', workspaces, state,
  });
  const controller = createWorkspaceAwareController({
    status() { return { bots: [{ botId: 'bot_abort' }] }; },
    async deleteBot() { throw new Error('config removal failed'); },
  }, { workspaces, stateFor: async () => state });

  await assert.rejects(controller.deleteBot('bot_abort'), /config removal failed/);
  assert.equal(workspaces.has('bot_abort'), true);
  assert.equal(workspaces.workspaceFor('bot_abort'), alternateWorkspace);
  assert.equal(await scope.harness.switchWorkspace(defaultWorkspace), defaultWorkspace);
});

test('a committed bot deletion stays retired when workspace cleanup persistence fails', async (t) => {
  const { root, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const storeDirectory = join(root, 'delete-store');
  const storePath = join(storeDirectory, 'workspaces.json');
  await mkdir(storeDirectory);
  const workspaces = await new BotWorkspaceStore(storePath, { defaultWorkspace }).load();
  await workspaces.ensure('bot_commit');
  await workspaces.setWorkspace('bot_commit', alternateWorkspace);
  let bots = [{ botId: 'bot_commit' }];
  let markDeleteStarted;
  let releaseDelete;
  const deleteStarted = new Promise((resolveDelete) => { markDeleteStarted = resolveDelete; });
  const deleteGate = new Promise((resolveDelete) => { releaseDelete = resolveDelete; });
  const controller = createWorkspaceAwareController({
    status() { return { bots }; },
    async deleteBot() {
      markDeleteStarted();
      await deleteGate;
      bots = [];
      return { bots };
    },
  }, { workspaces, stateFor: async () => ({ async clearSessions() {} }) });

  const deleting = controller.deleteBot('bot_commit');
  await deleteStarted;
  await rename(storeDirectory, `${storeDirectory}-saved`);
  await writeFile(storeDirectory, 'block cleanup persistence');
  releaseDelete();
  await deleting;
  assert.equal(workspaces.has('bot_commit'), false);
  await assert.rejects(workspaces.setWorkspace('bot_commit', defaultWorkspace), {
    code: 'workspace-bot-not-found',
  });

  await rm(storeDirectory, { force: true });
  await rename(`${storeDirectory}-saved`, storeDirectory);
  assert.equal(JSON.parse(await readFile(storePath, 'utf8')).workspaces.bot_commit, alternateWorkspace);
  await workspaces.reconcile([]);
  await assert.rejects(readFile(storePath, 'utf8'), { code: 'ENOENT' });
});

test('config-store removal observation retires workspaces after the config commit', async (t) => {
  const { path, defaultWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await Promise.all([workspaces.ensure('bot_remove'), workspaces.ensure('bot_feishu')]);
  const tokenStore = observeBotWorkspaceRemovals({
    async remove(botId) { return { botId }; },
  }, { workspaces });
  const feishuStore = observeBotWorkspaceRemovals({
    async removeBot(id) { return { id }; },
  }, {
    workspaces,
    method: 'removeBot',
    botIdFromRemoved: (removed) => removed.id,
  });

  await tokenStore.remove('bot_remove');
  await feishuStore.removeBot('bot_feishu');
  assert.equal(workspaces.has('bot_remove'), false);
  assert.equal(workspaces.has('bot_feishu'), false);
});

test('/workspace command preserves spaces and returns actionable validation messages', async (t) => {
  const { alternateWorkspace } = await fixture(t);
  const switched = [];
  const harness = { async switchWorkspace(path) { switched.push(path); return path; } };

  assert.equal(await runWorkspaceCommand('hello', harness), null);
  assert.match((await runWorkspaceCommand('/workspace', harness)).message, /用法/);
  assert.match(
    (await runWorkspaceCommand(`/workspace ${alternateWorkspace}`, harness)).message,
    new RegExp(alternateWorkspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.deepEqual(switched, [alternateWorkspace]);

  const invalidHarness = {
    async switchWorkspace() {
      const error = new Error('工作区路径不存在。');
      error.code = 'workspace-not-found';
      throw error;
    },
  };
  const invalid = await runWorkspaceCommand('/workspace /missing/workspace', invalidHarness);
  assert.match(invalid.message, /路径不存在/);
  assert.match(invalid.message, /用法：\/workspace 工作区绝对路径/);

  const removedHarness = {
    async switchWorkspace() {
      const error = new Error('bot removed');
      error.code = 'workspace-bot-not-found';
      throw error;
    },
  };
  assert.match(
    (await runWorkspaceCommand(`/workspace ${alternateWorkspace}`, removedHarness)).message,
    /正在移除或已重新接入/,
  );
});

test('/workspacelist returns existing absolute paths with the current workspace first', async (t) => {
  const { root, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const thirdWorkspace = join(root, 'third');
  await mkdir(thirdWorkspace);
  let listCalls = 0;
  const harness = {
    currentWorkspace() { return defaultWorkspace; },
    async listWorkspaces() {
      listCalls += 1;
      return [
        alternateWorkspace,
        defaultWorkspace,
        alternateWorkspace,
        thirdWorkspace,
        join(root, 'missing'),
        'relative/path',
      ];
    },
  };

  const result = await runWorkspaceCommand('/WORKSPACELIST', harness);
  assert.equal(result.handled, true);
  assert.match(result.message, /工作区（3）/);
  assert.match(result.message, new RegExp(`1\\. ${defaultWorkspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}（当前）`));
  assert.ok(result.message.indexOf(defaultWorkspace) < result.message.indexOf(alternateWorkspace));
  assert.ok(result.message.indexOf(alternateWorkspace) < result.message.indexOf(thirdWorkspace));
  assert.doesNotMatch(result.message, /missing|relative\/path/);
  assert.match(result.message, /切换用法：\/workspace 工作区绝对路径/);
  assert.match(result.message, /查看会话：\/sessionlist 工作区序号或绝对路径/);
  assert.equal(result.messages.join(''), result.message);
  assert.equal(listCalls, 1);

  assert.match((await runWorkspaceCommand('/workspacelist extra', harness)).message, /用法/);
  assert.equal(listCalls, 1);
  assert.match((await runWorkspaceCommand('/workspacelist', {})).message, /暂不支持/);
  assert.match((await runWorkspaceCommand('/workspacelist', {
    async listWorkspaces() { throw new Error('private host detail'); },
  })).message, /暂时无法获取/);
  assert.match((await runWorkspaceCommand('/workspacelist', {
    async listWorkspaces() { return []; },
  })).message, /没有仍然存在/);
});

test('/workspacelist splits a long registry without dropping paths', async (t) => {
  const { root, defaultWorkspace } = await fixture(t);
  const paths = Array.from({ length: 48 }, (_, index) => (
    join(root, `workspace-${String(index).padStart(2, '0')}`)
  ));
  await Promise.all(paths.map((workspace) => mkdir(workspace)));
  const result = await runWorkspaceCommand('/workspacelist', {
    currentWorkspace() { return defaultWorkspace; },
    async listWorkspaces() { return paths; },
  });

  assert.ok(result.messages.length > 1);
  assert.equal(result.messages.join(''), result.message);
  assert.ok(result.messages.every((message) => message.length <= 1_800));
  for (const workspace of paths) assert.ok(result.message.includes(workspace));
});

test('/workspacelist hides unsafe Unicode paths and rechecks the bot scope', async (t) => {
  const { root, defaultWorkspace } = await fixture(t);
  const unsafePaths = [
    join(root, 'line\u2028separator'),
    join(root, 'bidi\u202ereversal'),
    join(root, 'control\u0085next-line'),
  ];
  await Promise.all(unsafePaths.map((workspace) => mkdir(workspace)));

  const filtered = await runWorkspaceCommand('/workspacelist', {
    currentWorkspace() { return defaultWorkspace; },
    async listWorkspaces() { return unsafePaths; },
  });
  assert.match(filtered.message, /工作区（1）/);
  for (const workspace of unsafePaths) assert.ok(!filtered.message.includes(workspace));

  const stale = await runWorkspaceCommand('/workspacelist', {
    currentWorkspace() { return defaultWorkspace; },
    async listWorkspaces() { return [defaultWorkspace]; },
    assertWorkspaceScope() {
      const error = new Error('old bot lifecycle');
      error.code = 'workspace-bot-not-found';
      throw error;
    },
  });
  assert.match(stale.message, /正在移除或已重新接入/);
});

test('/sessionlist supports the current workspace, list numbers, and absolute paths', async (t) => {
  const { root, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const thirdWorkspace = join(root, 'third workspace');
  await mkdir(thirdWorkspace);
  const listedWorkspaces = [];
  let workspaceListCalls = 0;
  const sessionsByWorkspace = new Map([
    [defaultWorkspace, [
      {
        sessionId: 'session-current',
        title: '安全标题\u202e伪造\n4. injected',
        archived: false,
        blank: true,
        origin: 'subagent',
        summaryAvailable: true,
      },
      {
        sessionId: 'session-archived',
        title: null,
        archived: true,
        blank: false,
        origin: null,
        summaryAvailable: true,
      },
      {
        sessionId: 'session-missing-summary',
        title: null,
        archived: false,
        blank: false,
        origin: null,
        summaryAvailable: false,
      },
    ]],
    [alternateWorkspace, [{
      sessionId: 'session-alternate',
      title: 'Alternate session',
      archived: false,
      summaryAvailable: true,
    }]],
    [thirdWorkspace, []],
  ]);
  const harness = {
    currentWorkspace() { return defaultWorkspace; },
    async listWorkspaces() {
      workspaceListCalls += 1;
      return [alternateWorkspace, defaultWorkspace, thirdWorkspace];
    },
    async listWorkspaceSessions(workspace) {
      listedWorkspaces.push(workspace);
      return { workspace, sessions: sessionsByWorkspace.get(workspace) ?? [] };
    },
  };

  const current = await runWorkspaceCommand('/SESSIONLIST', harness);
  assert.match(current.message, new RegExp(`工作区：${defaultWorkspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(current.message, /会话（3）/);
  assert.match(current.message, /1\. 安全标题 伪造 4\. injected\n   ID: session-current/);
  assert.doesNotMatch(current.message, /\u202e|\n4\. injected/);
  assert.match(current.message, /2\. 暂无标题（已归档）\n   ID: session-archived/);
  assert.match(current.message, /3\. 标题暂不可用\n   ID: session-missing-summary/);
  assert.match(current.message, /绑定用法：\/session Session ID 或当前工作区序号（\/session N）/);
  assert.equal(current.messages.join(''), current.message);

  const numbered = await runWorkspaceCommand('/sessionlist 2', harness);
  assert.match(numbered.message, new RegExp(`工作区：${alternateWorkspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(numbered.message, /Alternate session/);
  assert.match(numbered.message, /绑定用法：\/session Session ID\n提示：\/session N 只按机器人当前工作区的序号绑定/);
  assert.doesNotMatch(numbered.message, /Session ID 或当前工作区序号/);

  const absolute = await runWorkspaceCommand(`/sessionlist ${thirdWorkspace}`, harness);
  assert.match(absolute.message, /该工作区暂无会话/);
  assert.deepEqual(listedWorkspaces, [defaultWorkspace, alternateWorkspace, thirdWorkspace]);
  assert.equal(workspaceListCalls, 1, 'only numeric selection needs the workspace registry order');
});

test('/sessionlist returns actionable and safe errors', async (t) => {
  const { root, defaultWorkspace } = await fixture(t);
  const file = join(root, 'not-a-workspace.txt');
  await writeFile(file, 'not a directory');
  const supported = {
    currentWorkspace() { return defaultWorkspace; },
    async listWorkspaces() { return [defaultWorkspace]; },
    async listWorkspaceSessions(workspace) { return { workspace, sessions: [] }; },
  };

  const invalidUsage = (await runWorkspaceCommand('/sessionlist relative/path', supported)).message;
  assert.match(invalidUsage, /工作区必须是绝对路径/);
  assert.match(invalidUsage, /\/sessionlist  列出当前工作区会话/);
  assert.match(invalidUsage, /\/sessionlist 工作区序号/);
  assert.match(invalidUsage, /\/sessionlist 工作区绝对路径/);
  assert.match((await runWorkspaceCommand('/sessionlist 0', supported)).message, /序号不存在/);
  assert.match((await runWorkspaceCommand('/sessionlist 99', supported)).message, /\/workspacelist/);
  assert.match(
    (await runWorkspaceCommand(`/sessionlist ${join(root, 'missing')}`, supported)).message,
    /工作区路径不存在/,
  );
  assert.match(
    (await runWorkspaceCommand(`/sessionlist ${file}`, supported)).message,
    /工作区路径必须指向一个目录/,
  );
  assert.match((await runWorkspaceCommand('/sessionlist', {})).message, /暂不支持/);
  assert.match((await runWorkspaceCommand('/sessionlist', {
    currentWorkspace() { return defaultWorkspace; },
    async listWorkspaceSessions() { throw new Error('private Harness detail'); },
  })).message, /暂时无法获取/);

  const stale = new Error('old bot lifecycle');
  stale.code = 'workspace-bot-not-found';
  const staleResult = await runWorkspaceCommand('/sessionlist', {
    currentWorkspace() { return defaultWorkspace; },
    async listWorkspaceSessions() { throw stale; },
  });
  assert.match(staleResult.message, /正在移除或已重新接入/);
  assert.doesNotMatch(staleResult.message, /old bot lifecycle|private Harness detail/);
});

test('/workspacelist and /sessionlist canonicalize a symbolic-link workspace', async (t) => {
  const { root } = await fixture(t);
  const canonicalWorkspace = join(root, 'canonical-workspace');
  const linkedWorkspace = join(root, 'linked-workspace');
  await mkdir(canonicalWorkspace);
  await symlink(canonicalWorkspace, linkedWorkspace, 'dir');
  const requested = [];
  const harness = {
    currentWorkspace() { return linkedWorkspace; },
    async listWorkspaces() { return [canonicalWorkspace, linkedWorkspace]; },
    async listWorkspaceSessions(workspace) {
      requested.push(workspace);
      return {
        workspace,
        sessions: [{
          sessionId: 'session-through-link',
          title: 'Canonical workspace session',
          archived: false,
          summaryAvailable: true,
        }],
      };
    },
  };

  const workspaces = await runWorkspaceCommand('/workspacelist', harness);
  assert.match(workspaces.message, /工作区（1）/);
  assert.match(workspaces.message, new RegExp(`1\\. ${canonicalWorkspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}（当前）`));

  const current = await runWorkspaceCommand('/sessionlist', harness);
  const absolute = await runWorkspaceCommand(`/sessionlist ${linkedWorkspace}`, harness);
  assert.match(current.message, new RegExp(`工作区：${canonicalWorkspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(current.message, /session-through-link/);
  assert.match(absolute.message, /session-through-link/);
  assert.deepEqual(requested, [canonicalWorkspace, canonicalWorkspace]);
});

test('/sessionlist splits a long complete session list without losing IDs', async (t) => {
  const { defaultWorkspace } = await fixture(t);
  const sessions = Array.from({ length: 120 }, (_, index) => ({
    sessionId: `session-${String(index).padStart(3, '0')}`,
    title: `会话 ${index} ${'标题'.repeat(12)}`,
    archived: index % 9 === 0,
    summaryAvailable: true,
  }));
  const result = await runWorkspaceCommand('/sessionlist', {
    currentWorkspace() { return defaultWorkspace; },
    async listWorkspaceSessions(workspace) { return { workspace, sessions }; },
  });

  assert.ok(result.messages.length > 1);
  assert.ok(result.messages.every((message) => message.length <= 1_800));
  assert.equal(result.messages.join(''), result.message);
  for (const session of sessions) assert.ok(result.message.includes(session.sessionId));
});

test('the shared bridge sends every /sessionlist chunk without creating or prompting a session', async (t) => {
  const { defaultWorkspace } = await fixture(t);
  const sent = [];
  const seen = new Set();
  let sessionCalls = 0;
  const sessions = Array.from({ length: 120 }, (_, index) => ({
    sessionId: `bridge-session-${String(index).padStart(3, '0')}`,
    title: `Bridge title ${index} ${'detail '.repeat(8)}`,
    archived: false,
    summaryAvailable: true,
  }));
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'test', label: 'Test' },
    bot: { async sendText(_target, text) { sent.push(text); } },
    harness: {
      currentWorkspace() { return defaultWorkspace; },
      async listWorkspaceSessions(workspace) { return { workspace, sessions }; },
      async createSession() { sessionCalls += 1; },
      async ask() { sessionCalls += 1; },
    },
    state: {
      hasSeen(messageId) { return seen.has(messageId); },
      async markSeen(messageId) { seen.add(messageId); },
    },
  });

  await bridge.accept({
    messageId: 'message-sessionlist',
    senderId: 'sender',
    conversationId: 'conversation',
    kind: 'direct',
    content: '/sessionlist',
    replyTarget: 'target',
  });

  assert.ok(sent.length > 1);
  assert.ok(sent.every((message) => message.length <= 1_800));
  for (const session of sessions) assert.ok(sent.join('').includes(session.sessionId));
  assert.equal(sessionCalls, 0);
  assert.equal(seen.has('message-sessionlist'), true);
});

test('workspace command message splitting bounds a single very long path', () => {
  const message = `/workspace/${'nested/'.repeat(600)}project-😀`;
  const messages = splitWorkspaceCommandMessage(message);
  assert.ok(messages.length > 1);
  assert.ok(messages.every((part) => part.length <= 1_800));
  assert.equal(messages.join(''), message);
});

test('all nine channel bridge families advertise and fan out workspace command replies', async () => {
  const bridgeFiles = [
    '../src/channels/shared/text-harness-bridge.mjs',
    '../src/channels/weixin/weixin-bridge.mjs',
    '../src/channels/dingtalk/dingtalk-bridge.mjs',
    '../src/channels/wecom/wecom-bridge.mjs',
    '../src/channels/qq/qq-bridge.mjs',
  ];
  for (const file of bridgeFiles) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /\/workspacelist  列出工作区绝对路径/);
    assert.match(source, /\/sessionlist \[工作区序号或绝对路径\]  列出会话 ID 和标题/);
    assert.match(source, /workspaceCommand\.messages \?\? \[workspaceCommand\.message\]/);
  }

  // The Feishu bridge advertises its workspace commands through the
  // interactive-card help module and still fans out shared replies.
  const feishuSource = await readFile(new URL('../src/channels/feishu/bridge.mjs', import.meta.url), 'utf8');
  assert.match(feishuSource, /workspaceCommand\.messages \?\? \[workspaceCommand\.message\]/);
  assert.match(feishuSource, /menuHelpText/);
  const feishuCards = await readFile(new URL('../src/channels/feishu/feishu-cards.mjs', import.meta.url), 'utf8');
  assert.match(feishuCards, /\/workspace 绝对路径  切换工作区/);
});

test('a stale bot scope cannot finish listing workspaces after same-id rebinding', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_list');
  let finishList;
  const harness = {
    listWorkspaces() {
      return new Promise((resolve) => { finishList = resolve; });
    },
  };
  const oldScope = createBotScopedHarness(harness, {
    botId: 'bot_list',
    workspaces,
    state: { async clearSessions() {} },
  });
  const pending = oldScope.listWorkspaces();
  await workspaces.retireAfterConfigCommit('bot_list');
  await workspaces.ensure('bot_list', { workspace: alternateWorkspace });
  finishList([defaultWorkspace]);

  await assert.rejects(pending, { code: 'workspace-bot-not-found' });
});

test('a stale bot scope cannot finish listing workspace sessions after same-id rebinding', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_session_list');
  let finishList;
  const oldScope = createBotScopedHarness({
    listWorkspaceSessions() {
      return new Promise((resolveList) => { finishList = resolveList; });
    },
  }, {
    botId: 'bot_session_list',
    workspaces,
    state: { async clearSessions() {} },
  });
  const pending = oldScope.listWorkspaceSessions(defaultWorkspace);
  await workspaces.retireAfterConfigCommit('bot_session_list');
  await workspaces.ensure('bot_session_list', { workspace: alternateWorkspace });
  finishList({ workspace: defaultWorkspace, sessions: [] });

  await assert.rejects(pending, { code: 'workspace-bot-not-found' });
});

for (const [name, Client] of [
  ['Weixin', WeixinHarnessClient],
  ['Feishu', FeishuHarnessClient],
  ['DingTalk', DingtalkHarnessClient],
]) {
  test(`${name} Harness creates a session with an explicit workspace override`, async () => {
    const client = new Client({
      baseUrl: 'http://127.0.0.1:3080',
      workspace: '/default-workspace',
      agentPreset: 'standard',
      autostart: false,
      dshBin: 'dsh',
    });
    const calls = [];
    client.ensureRunning = async () => true;
    client.rpc = async (method, payload, _timeout, options) => {
      calls.push({ method, payload, options });
      if (method === 'workspace.list') return { items: [] };
      if (method === 'workspace.create') return { workspace: { workspaceId: 'workspace-new' } };
      if (method === 'session.create') return { sessionId: 'session-new' };
      throw new Error(`Unexpected RPC: ${method}`);
    };

    const signal = new AbortController().signal;
    const options = name === 'DingTalk'
      ? { workspace: '/explicit-workspace', signal }
      : { workspace: '/explicit-workspace' };
    assert.equal(await client.createSession(options), 'session-new');
    assert.deepEqual(calls.map(({ method }) => method), [
      'workspace.list', 'workspace.create', 'session.create',
    ]);
    assert.equal(calls[1].payload.path, '/explicit-workspace');
    if (name === 'DingTalk') assert.equal(calls[0].options.signal, signal);
  });
}

test('workspace RPC validates payloads and returns the updated public status', async (t) => {
  const { root, path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_one');
  const base = {
    status() { return { bots: [{ botId: 'bot_one', connected: true }] }; },
    bindCredentials() { return this.status(); },
    reconnectBot() { return this.status(); },
    deleteBot() { return { bots: [] }; },
  };
  const controller = createWorkspaceAwareController(base, {
    workspaces,
    stateFor: async () => ({ async clearSessions() {} }),
  });
  const handler = createTokenBotRpcHandler(controller, { channel: 'Telegram' });

  const success = await handler(TOKEN_BOT_ENDPOINTS.setWorkspace, {
    botId: 'bot_one', workspace: alternateWorkspace,
  });
  assert.equal(success.ok, true);
  assert.equal(success.value.bots[0].workspace, alternateWorkspace);

  const relative = await handler(TOKEN_BOT_ENDPOINTS.setWorkspace, {
    botId: 'bot_one', workspace: 'relative/path',
  });
  assert.equal(relative.error.code, 'bad-request');

  const missing = await handler(TOKEN_BOT_ENDPOINTS.setWorkspace, {
    botId: 'bot_one', workspace: join(root, 'missing'),
  });
  assert.equal(missing.error.code, 'workspace-not-found');
  assert.match(missing.error.message, /不存在/);
});
