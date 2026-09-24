import assert from 'node:assert/strict';
import {
  mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BotWorkspaceStore, createBotWorkspaceScope,
} from '../src/channels/shared/bot-workspace-store.mjs';
import { ConversationStateStore } from '../src/channels/shared/conversation-state-store.mjs';
import {
  askInWorkspaceSession, WORKSPACE_SESSION_STALE,
} from '../src/channels/shared/workspace-session.mjs';
import { symlinkOrSkip } from './support/filesystem.mjs';

const BOT = 'bot_bind_recovery';
const KEY = 'direct:one';
const OTHER_KEY = 'direct:two';

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-bind-recovery-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceA = join(root, 'a');
  const workspaceB = join(root, 'b');
  const workspaceC = join(root, 'c');
  const storeDirectory = join(root, 'store');
  await Promise.all([workspaceA, workspaceB, workspaceC, storeDirectory].map((path) => mkdir(path)));
  const storePath = join(storeDirectory, 'workspaces.json');
  const workspaces = await new BotWorkspaceStore(storePath, { defaultWorkspace: workspaceA }).load();
  await workspaces.ensure(BOT);
  const state = await new ConversationStateStore(join(root, 'state.json')).load();
  const sessionWorkspaces = new Map([
    ['session-a', workspaceA], ['session-b', workspaceB], ['session-c', workspaceC],
  ]);
  const created = [];
  const asked = [];
  const scope = createBotWorkspaceScope({
    async adoptWorkspaceSession(sessionId) {
      return { sessionId, workspace: sessionWorkspaces.get(sessionId) };
    },
    async createSession({ workspace }) {
      const sessionId = `session-created-${created.length + 1}`;
      sessionWorkspaces.set(sessionId, workspace);
      created.push({ sessionId, workspace });
      return sessionId;
    },
    async sessionExists(sessionId) { return sessionWorkspaces.has(sessionId); },
    async ask(sessionId) {
      asked.push({ sessionId, workspace: sessionWorkspaces.get(sessionId) });
      return 'answer';
    },
  }, { botId: BOT, workspaces, state });
  return { root, workspaceA, workspaceB, workspaceC, storeDirectory, storePath, workspaces, state, scope, created, asked };
}

for (const changesDefault of [false, true]) {
  test(`failed bind persistence restores the override and default (${changesDefault ? 'changed' : 'unchanged'} default) without reviving old mappings`, async (t) => {
    const { workspaceA, workspaceB, storeDirectory, workspaces, state, scope } = await fixture(t);
    await scope.harness.switchConversationWorkspace(KEY, workspaceB);
    await state.setSession(KEY, 'session-b');
    await state.setSession(OTHER_KEY, 'session-a');
    const oldHandle = scope.harness.workspaceSession(scope.state.sessionFor(KEY), KEY);
    const oldGeneration = workspaces.generationFor(BOT);
    const oldConversationGeneration = workspaces.conversationGenerationFor(BOT, KEY);
    const savedDirectory = `${storeDirectory}-saved`;
    const savedDocument = await readFile(join(storeDirectory, 'workspaces.json'), 'utf8');
    await rename(storeDirectory, savedDirectory);
    await writeFile(storeDirectory, 'blocks workspace persistence');

    await assert.rejects(scope.harness.bindWorkspaceSession(KEY, changesDefault ? 'session-c' : 'session-a'));

    assert.equal(workspaces.workspaceFor(BOT), workspaceA);
    assert.equal(workspaces.hasConversationWorkspaceOverride(BOT, KEY), true);
    assert.equal(workspaces.conversationWorkspaceFor(BOT, KEY), workspaceB);
    assert.notEqual(workspaces.conversationGenerationFor(BOT, KEY), oldConversationGeneration);
    if (changesDefault) assert.notEqual(workspaces.generationFor(BOT), oldGeneration);
    else assert.equal(workspaces.generationFor(BOT), oldGeneration);
    assert.equal(state.sessionFor(KEY), null);
    assert.equal(state.sessionFor(OTHER_KEY), changesDefault ? null : 'session-a');
    assert.equal(await oldHandle.sessionExists(), false);
    assert.equal(await scope.state.setSession(KEY, 'session-b'), false);
    assert.equal(await readFile(join(savedDirectory, 'workspaces.json'), 'utf8'), savedDocument);

    await unlink(storeDirectory);
    await rename(savedDirectory, storeDirectory);
    const freshId = await scope.harness.createSession({ conversationKey: KEY });
    assert.notEqual(await scope.state.setSession(KEY, freshId), false, 'the advanced scope mask remains usable');
    assert.equal(state.sessionFor(KEY), freshId);
  });
}

for (const pauseAt of ['clearSession', 'setSession']) {
  test(`a later /conv wins while override-reconciling /session awaits ${pauseAt}`, { timeout: 5_000 }, async (t) => {
    const { workspaceA, workspaceB, workspaceC, workspaces, state, scope, asked } = await fixture(t);
    await scope.harness.switchConversationWorkspace(KEY, workspaceB);
    await state.setSession(KEY, 'session-b');
    await state.setSession(OTHER_KEY, 'session-a');
    const paused = deferred();
    const resume = deferred();
    const original = state[pauseAt].bind(state);
    let intercepted = false;
    state[pauseAt] = async (...args) => {
      await original(...args);
      if (!intercepted && args[0] === KEY) {
        intercepted = true;
        paused.resolve();
        await resume.promise;
      }
    };

    const binding = scope.harness.bindWorkspaceSession(KEY, 'session-a');
    const rejected = assert.rejects(binding, (error) => error?.code === WORKSPACE_SESSION_STALE);
    await paused.promise;
    const switching = scope.harness.switchConversationWorkspace(KEY, workspaceC);
    resume.resolve();
    await Promise.all([rejected, switching]);

    assert.equal(workspaces.workspaceFor(BOT), workspaceA);
    assert.equal(scope.harness.currentConversationWorkspace(KEY), workspaceC);
    assert.equal(state.sessionFor(KEY), null);
    assert.equal(state.sessionFor(OTHER_KEY), 'session-a');
    await askInWorkspaceSession({ harness: scope.harness, state: scope.state, key: KEY, text: 'after switch' });
    assert.deepEqual(asked.map(({ workspace }) => workspace), [workspaceC]);
  });
}

test('adopting a Session preserves an explicit symlink pin for the same canonical workspace', async (t) => {
  const { root, workspaceB, workspaces, state, scope, asked } = await fixture(t);
  const alias = join(root, 'b-link');
  if (!await symlinkOrSkip(t, workspaceB, alias, 'dir')) return;
  await scope.harness.switchConversationWorkspace(KEY, alias);
  const generation = workspaces.conversationGenerationFor(BOT, KEY);

  await scope.harness.bindWorkspaceSession(KEY, 'session-b');

  assert.equal(workspaces.workspaceFor(BOT), workspaceB, '/session retains its bot-default behavior');
  assert.equal(workspaces.hasConversationWorkspaceOverride(BOT, KEY), true);
  assert.equal(workspaces.conversationWorkspaceFor(BOT, KEY), alias);
  assert.equal(workspaces.conversationGenerationFor(BOT, KEY), generation);
  assert.equal(state.sessionFor(KEY), 'session-b');
  await askInWorkspaceSession({ harness: scope.harness, state: scope.state, key: KEY, text: 'continue pinned session' });
  assert.deepEqual(asked, [{ sessionId: 'session-b', workspace: workspaceB }]);
});
