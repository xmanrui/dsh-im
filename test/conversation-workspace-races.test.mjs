import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { dingtalkMenuSnapshot } from '../src/channels/dingtalk/dingtalk-menu.mjs';
import { qqMenuView } from '../src/channels/qq/qq-menu.mjs';
import {
  BotWorkspaceStore,
  createBotWorkspaceScope,
} from '../src/channels/shared/bot-workspace-store.mjs';
import { ConversationStateStore } from '../src/channels/shared/conversation-state-store.mjs';
import { runCompactCommand } from '../src/channels/shared/compact-command.mjs';
import { runControlCommand } from '../src/channels/shared/control-command.mjs';
import { runModelCommand } from '../src/channels/shared/model-command.mjs';
import {
  askInWorkspaceSession,
  WORKSPACE_SESSION_STALE,
} from '../src/channels/shared/workspace-session.mjs';

const BOT = 'bot_conversation_race';
const KEY = 'direct:one';
const SELECTION = Object.freeze({ provider: 'provider', model: 'model' });
const CATALOG = Object.freeze({
  groups: [{ id: 'provider', name: 'Provider', models: [{ id: 'model', name: 'Model' }] }],
  failures: [],
});

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function fixture(t, overrides = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-conversation-races-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceA = join(root, 'a');
  const workspaceB = join(root, 'b');
  await Promise.all([mkdir(workspaceA), mkdir(workspaceB)]);
  const workspaces = await new BotWorkspaceStore(join(root, 'workspaces.json'), {
    defaultWorkspace: workspaceA,
  }).load();
  await workspaces.ensure(BOT);
  const state = await new ConversationStateStore(join(root, 'state.json')).load();
  const created = [];
  const asked = [];
  const selected = [];
  const sessions = new Map([['session-existing', workspaceA]]);
  const target = {
    async adoptWorkspaceSession(sessionId) {
      return { sessionId, workspace: sessions.get(sessionId) };
    },
    async createSession({ workspace }) {
      const sessionId = `session-created-${created.length + 1}`;
      created.push({ sessionId, workspace });
      sessions.set(sessionId, workspace);
      return sessionId;
    },
    async sessionExists(sessionId) { return sessions.has(sessionId); },
    async listModels() { return CATALOG; },
    async getSessionModels() { return { ...CATALOG, current: SELECTION, routable: true }; },
    async selectSessionModel(sessionId, selection) {
      selected.push({ sessionId, selection });
      return { selected: selection };
    },
    async isSessionRunning() { return false; },
    async hasActiveTurn() { return false; },
    async ask(sessionId) {
      asked.push({ sessionId, workspace: sessions.get(sessionId) });
      return 'answer';
    },
    ...overrides,
  };
  const scope = createBotWorkspaceScope(target, { botId: BOT, workspaces, state });
  return { workspaceA, workspaceB, workspaces, state, scope, created, asked, selected, sessions };
}

test('an explicitly adopted session cannot be written back after a bot workspace switch', async (t) => {
  const { scope, state, workspaceB } = await fixture(t);
  await scope.harness.bindWorkspaceSession(KEY, 'session-existing');
  const oldId = scope.state.sessionFor(KEY);

  await scope.harness.switchWorkspace(workspaceB);

  assert.equal(await scope.state.setSession(KEY, oldId), false);
  assert.equal(state.sessionFor(KEY), null);
});

test('a new /model session cannot bind or receive a prompt after a concurrent /conv', { timeout: 5_000 }, async (t) => {
  const selecting = deferred();
  const finishSelection = deferred();
  const { scope, state, workspaceA, workspaceB, created, asked } = await fixture(t, {
    async selectSessionModel(_sessionId, selection) {
      selecting.resolve();
      await finishSelection.promise;
      return { selected: selection };
    },
  });

  const command = runModelCommand('/model provider/model', scope.harness, scope.state, KEY);
  await selecting.promise;
  await scope.harness.switchConversationWorkspace(KEY, workspaceB);
  finishSelection.resolve();
  await command;

  assert.equal(state.sessionFor(KEY), null, 'the old /model must not restore its session binding');
  await askInWorkspaceSession({ harness: scope.harness, state: scope.state, key: KEY, text: 'hello' });
  assert.deepEqual(created.map(({ workspace }) => workspace), [workspaceA, workspaceB]);
  assert.deepEqual(asked.map(({ workspace }) => workspace), [workspaceB]);
});

test('an existing-session /model cannot select the old model after /conv during a run-state check', { timeout: 5_000 }, async (t) => {
  const checking = deferred();
  const finishCheck = deferred();
  const { scope, state, workspaceB, selected } = await fixture(t, {
    async isSessionRunning() {
      checking.resolve();
      await finishCheck.promise;
      return false;
    },
  });
  await state.setSession(KEY, 'session-existing');

  const command = runModelCommand('/model provider/model', scope.harness, scope.state, KEY);
  await checking.promise;
  await scope.harness.switchConversationWorkspace(KEY, workspaceB);
  finishCheck.resolve();
  await command;

  assert.deepEqual(selected, [], 'a workspace switch must fence mutations not yet started');
  assert.equal(state.sessionFor(KEY), null);
});

test('an adoption begun before /conv cannot restore the old session after adoption finishes', { timeout: 5_000 }, async (t) => {
  const adopting = deferred();
  const finishAdoption = deferred();
  let adoptedWorkspace;
  const { scope, state, workspaceA, workspaceB } = await fixture(t, {
    async adoptWorkspaceSession(sessionId) {
      adopting.resolve();
      await finishAdoption.promise;
      return { sessionId, workspace: adoptedWorkspace };
    },
  });
  adoptedWorkspace = workspaceA;

  const binding = scope.harness.bindWorkspaceSession(KEY, 'session-existing');
  const rejected = assert.rejects(binding, (error) => error?.code === WORKSPACE_SESSION_STALE);
  await adopting.promise;
  await scope.harness.switchConversationWorkspace(KEY, workspaceB);
  finishAdoption.resolve();
  await rejected;

  assert.equal(state.sessionFor(KEY), null);
  assert.equal(scope.harness.currentConversationWorkspace(KEY), workspaceB);
});

test('creating a workspace session handle preserves provenance for a later binding fence', async (t) => {
  const { scope, state, workspaceB } = await fixture(t);
  const oldId = await scope.harness.createSession({ conversationKey: KEY });
  const handle = scope.harness.workspaceSession(oldId, KEY);
  assert.equal(await handle.sessionExists(), true);

  await scope.harness.switchConversationWorkspace(KEY, workspaceB);

  assert.equal(await scope.state.setSession(KEY, oldId), false);
  assert.equal(state.sessionFor(KEY), null);
});

test('a workspace session handle without an explicit key inherits its creation provenance', async (t) => {
  const { scope, workspaceB } = await fixture(t);
  const oldId = await scope.harness.createSession({ conversationKey: KEY });
  const handle = scope.harness.workspaceSession(oldId);

  await scope.harness.switchConversationWorkspace(KEY, workspaceB);

  assert.equal(await handle.sessionExists(), false);
});

test('switching one conversation preserves another conversation bound to the same Session', async (t) => {
  const otherKey = 'direct:two';
  const { scope, state, workspaceA, workspaceB, asked, created } = await fixture(t);
  await scope.harness.bindWorkspaceSession(KEY, 'session-existing');
  await scope.harness.bindWorkspaceSession(otherKey, 'session-existing');
  const firstHandle = scope.harness.workspaceSession(scope.state.sessionFor(KEY), KEY);
  const otherHandle = scope.harness.workspaceSession(scope.state.sessionFor(otherKey), otherKey);

  await scope.harness.switchConversationWorkspace(KEY, workspaceB);

  assert.equal(state.sessionFor(KEY), null);
  assert.equal(scope.state.sessionFor(otherKey), 'session-existing');
  assert.equal(await firstHandle.sessionExists(), false);
  assert.equal(await otherHandle.sessionExists(), true);
  await askInWorkspaceSession({
    harness: scope.harness, state: scope.state, key: otherKey, text: 'keep this conversation',
  });
  assert.deepEqual(created, []);
  assert.deepEqual(asked, [{ sessionId: 'session-existing', workspace: workspaceA }]);
});

test('shared Session controls stay usable when the most recently bound conversation switches away', async (t) => {
  const otherKey = 'direct:two';
  const calls = [];
  const { scope, state, workspaceB } = await fixture(t, {
    async executeCommand(sessionId, command, options) {
      calls.push(['compact', sessionId, command, options]);
      return { result: { kind: 'success', text: 'No compactable history yet.' } };
    },
    async stopActiveTurn(sessionId, control) {
      calls.push(['stop', sessionId, control]);
      return true;
    },
    async steerActiveTurn(sessionId, text, control) {
      calls.push(['steer', sessionId, text, control]);
      return true;
    },
  });
  // The switched conversation owns the most recent per-Session provenance.
  await scope.harness.bindWorkspaceSession(otherKey, 'session-existing');
  await scope.harness.bindWorkspaceSession(KEY, 'session-existing');
  await scope.harness.switchConversationWorkspace(KEY, workspaceB);

  const control = { owner: {}, key: otherKey };
  const options = { signal: new AbortController().signal };
  const compact = await runCompactCommand('/compact', scope.harness, scope.state, otherKey, options);
  const stopped = await runControlCommand('/stop', scope.harness, scope.state, otherKey, { control });
  const steered = await runControlCommand('/steer continue', scope.harness, scope.state, otherKey, { control });

  assert.match(compact.message, /暂无可压缩/);
  assert.equal(stopped.stopped, true);
  assert.match(steered.message, /已提交补充指令/);
  assert.deepEqual(calls, [
    ['compact', 'session-existing', '/compact', options],
    ['stop', 'session-existing', control],
    ['steer', 'session-existing', 'continue', control],
  ]);
  assert.equal(state.sessionFor(KEY), null);
  assert.equal(scope.state.sessionFor(otherKey), 'session-existing');
});

test('Dingtalk and QQ menus preserve shared Session models for the conversation left behind', async (t) => {
  const otherKey = 'direct:two';
  const { scope, workspaceB } = await fixture(t, {
    async listWorkspaces() { return []; },
    async listWorkspaceSessions() { return { sessions: [] }; },
  });
  await scope.harness.bindWorkspaceSession(otherKey, 'session-existing');
  await scope.harness.bindWorkspaceSession(KEY, 'session-existing');
  await scope.harness.switchConversationWorkspace(KEY, workspaceB);

  const dingtalk = await dingtalkMenuSnapshot(scope.harness, scope.state, otherKey);
  assert.deepEqual(dingtalk.selections.model, [['Model (provider)', '/model provider/model']]);
  const qqMain = await qqMenuView('main', scope.harness, scope.state, otherKey);
  assert.match(qqMain.detail, /当前模型：Model/);
  const qqModels = await qqMenuView('models', scope.harness, scope.state, otherKey);
  assert.ok(qqModels.entries.some(({ label }) => label.startsWith('✓ ')));
});

test('repeating an explicit /conv workspace preserves its binding for the next prompt', async (t) => {
  const { scope, workspaceB, created, asked } = await fixture(t);
  await scope.harness.switchConversationWorkspace(KEY, workspaceB);
  const sessionId = await scope.harness.createSession({ conversationKey: KEY });
  await scope.state.setSession(KEY, sessionId);
  scope.harness.workspaceSession(scope.state.sessionFor(KEY), KEY);

  await scope.harness.switchConversationWorkspace(KEY, workspaceB);

  assert.equal(scope.state.sessionFor(KEY), sessionId);
  await askInWorkspaceSession({ harness: scope.harness, state: scope.state, key: KEY, text: 'continue' });
  assert.equal(created.length, 1);
  assert.deepEqual(asked, [{ sessionId, workspace: workspaceB }]);
});

test('/conv clear without an override preserves its binding for the next prompt', async (t) => {
  const { scope, workspaceA, asked, created } = await fixture(t);
  await scope.harness.bindWorkspaceSession(KEY, 'session-existing');
  scope.harness.workspaceSession(scope.state.sessionFor(KEY), KEY);

  await scope.harness.clearConversationWorkspace(KEY);

  assert.equal(scope.state.sessionFor(KEY), 'session-existing');
  await askInWorkspaceSession({ harness: scope.harness, state: scope.state, key: KEY, text: 'continue' });
  assert.deepEqual(created, []);
  assert.deepEqual(asked, [{ sessionId: 'session-existing', workspace: workspaceA }]);
});
