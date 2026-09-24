import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';

import {
  BotWorkspaceStore,
  createBotWorkspaceScope,
} from '../src/channels/shared/bot-workspace-store.mjs';
import { ConversationStateStore } from '../src/channels/shared/conversation-state-store.mjs';
import { runModelCommand } from '../src/channels/shared/model-command.mjs';
import { askInWorkspaceSession } from '../src/channels/shared/workspace-session.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

test('/model started during a published /conv waits for its effective workspace', { timeout: 5_000 }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-switch-order-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceA = join(root, 'a');
  const workspaceB = join(root, 'b');
  await Promise.all([mkdir(workspaceA), mkdir(workspaceB)]);
  const workspaces = await new BotWorkspaceStore(join(root, 'workspaces.json'), {
    defaultWorkspace: workspaceA,
  }).load();
  const botId = 'bot_switch_order';
  const key = 'direct:one';
  await workspaces.ensure(botId);
  const state = await new ConversationStateStore(join(root, 'state.json')).load();

  // Hold the real store transition before it joins the bot queue, reproducing
  // the asynchronous path-validation window after /conv publishes its fence.
  const allowSwitch = deferred();
  const applySwitch = workspaces.applyConversationWorkspaceSwitch.bind(workspaces);
  workspaces.applyConversationWorkspaceSwitch = async (...args) => {
    await allowSwitch.promise;
    return applySwitch(...args);
  };

  const selecting = deferred();
  const finishSelection = deferred();
  const created = [];
  const asked = [];
  const selection = { provider: 'provider', model: 'model' };
  const catalog = {
    groups: [{ id: 'provider', name: 'Provider', models: [{ id: 'model', name: 'Model' }] }],
    failures: [],
  };
  const sessions = new Map();
  const target = {
    async listModels() { return catalog; },
    async createSession({ workspace }) {
      const sessionId = `session-${created.length + 1}`;
      sessions.set(sessionId, workspace);
      created.push({ sessionId, workspace });
      return sessionId;
    },
    async selectSessionModel(_sessionId, selected) {
      selecting.resolve();
      await finishSelection.promise;
      return { selected };
    },
    async getSessionModels() { return { ...catalog, current: selection, routable: true }; },
    async sessionExists(sessionId) { return sessions.has(sessionId); },
    async ask(sessionId) {
      asked.push({ sessionId, workspace: sessions.get(sessionId) });
      return 'answer';
    },
  };
  const scope = createBotWorkspaceScope(target, { botId, workspaces, state });

  const switching = scope.harness.switchConversationWorkspace(key, workspaceB);
  const model = runModelCommand('/model provider/model', scope.harness, scope.state, key);
  // Let /model advance while the switch remains published but not yet queued.
  await setImmediate();
  allowSwitch.resolve();
  await switching;
  await selecting.promise;
  finishSelection.resolve();
  const result = await model;

  await askInWorkspaceSession({
    harness: scope.harness,
    state: scope.state,
    key,
    text: 'continue after the switch',
  });

  assert.match(result.message, /模型已切换为/u);
  assert.deepEqual(created.map(({ workspace }) => workspace), [workspaceB]);
  assert.equal(state.sessionFor(key), created[0].sessionId);
  assert.deepEqual(asked, [{ sessionId: created[0].sessionId, workspace: workspaceB }]);
});
