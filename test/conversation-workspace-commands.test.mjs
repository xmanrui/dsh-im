import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BotWorkspaceStore,
  createBotWorkspaceScope,
} from '../src/channels/shared/bot-workspace-store.mjs';
import { ConversationStateStore } from '../src/channels/shared/conversation-state-store.mjs';
import { runWorkspaceCommand } from '../src/channels/shared/workspace-command.mjs';
import { askInWorkspaceSession } from '../src/channels/shared/workspace-session.mjs';
import { symlinkOrSkip } from './support/filesystem.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-conversation-commands-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const defaultWorkspace = join(root, 'default');
  const alternateWorkspace = join(root, 'alternate');
  await Promise.all([mkdir(defaultWorkspace), mkdir(alternateWorkspace)]);
  const workspaces = await new BotWorkspaceStore(join(root, 'workspaces.json'), {
    defaultWorkspace,
  }).load();
  const botId = 'bot_conversation_commands';
  await workspaces.ensure(botId);
  const state = await new ConversationStateStore(join(root, 'state.json')).load();
  const knownSessions = [
    { sessionId: 'session-A', workspace: defaultWorkspace, title: 'Default workspace session' },
    { sessionId: 'session-B', workspace: alternateWorkspace, title: 'Conversation workspace session' },
  ];
  const listedWorkspaces = [];
  const adoptedSessions = [];
  const asked = [];
  const harness = {
    async listWorkspaces() { return [defaultWorkspace, alternateWorkspace]; },
    async listWorkspaceSessions(workspace) {
      listedWorkspaces.push(workspace);
      return { workspace, sessions: knownSessions.filter((session) => session.workspace === workspace) };
    },
    async adoptWorkspaceSession(sessionId) {
      adoptedSessions.push(sessionId);
      return knownSessions.find((session) => session.sessionId === sessionId);
    },
    async createSession({ workspace }) {
      const sessionId = `session-created-${knownSessions.length}`;
      knownSessions.push({ sessionId, workspace });
      return sessionId;
    },
    async sessionExists(sessionId) {
      return knownSessions.some((session) => session.sessionId === sessionId);
    },
    async ask(sessionId) {
      asked.push(knownSessions.find((session) => session.sessionId === sessionId));
      return 'answer';
    },
  };
  const scope = createBotWorkspaceScope(harness, { botId, workspaces, state });
  const key = 'group:conversation';
  return {
    command: (text) => runWorkspaceCommand(text, scope.harness, key),
    ask: () => askInWorkspaceSession({ harness: scope.harness, state: scope.state, key, text: 'run task' }),
    scope,
    harness,
    root,
    asked,
    path: join(root, 'workspaces.json'),
    workspaces,
    state,
    key,
    botId,
    defaultWorkspace,
    alternateWorkspace,
    listedWorkspaces,
    adoptedSessions,
  };
}

test('/session N selects from the same effective workspace as /sessionlist', async (t) => {
  const f = await fixture(t);
  await f.command(`/conv ${f.alternateWorkspace}`);

  const listing = await f.command('/sessionlist');
  assert.match(listing.message, /session-B/u);
  assert.doesNotMatch(listing.message, /session-A/u);
  const binding = await f.command('/session 1');

  assert.match(binding.message, /session-B/u);
  assert.equal(f.state.sessionFor(f.key), 'session-B');
  assert.deepEqual(f.adoptedSessions, ['session-B']);
  assert.deepEqual(f.listedWorkspaces, [f.alternateWorkspace, f.alternateWorkspace]);
  assert.equal(f.workspaces.conversationWorkspaceFor(f.botId, f.key), f.alternateWorkspace);
});

test('/session N still follows the bot default without an override', async (t) => {
  const f = await fixture(t);
  const listing = await f.command('/sessionlist');
  const binding = await f.command('/session 1');

  assert.match(listing.message, /session-A/u);
  assert.match(binding.message, /session-A/u);
  assert.equal(f.state.sessionFor(f.key), 'session-A');
  assert.deepEqual(f.listedWorkspaces, [f.defaultWorkspace, f.defaultWorkspace]);
});

test('/conv reports persisted explicit bindings and following the bot default', async (t) => {
  const f = await fixture(t);
  assert.match((await f.command('/conv')).message, /状态：未显式绑定，当前跟随 bot 默认工作区/u);

  await f.command(`/conv ${f.defaultWorkspace}`);
  assert.equal(f.workspaces.hasConversationWorkspaceOverride(f.botId, f.key), true);
  assert.match((await f.command('/conv')).message, /状态：已为该对话显式绑定/u);

  await f.command(`/conv ${f.alternateWorkspace}`);
  assert.match((await f.command('/conv')).message, /状态：已为该对话显式绑定/u);

  await f.command('/conv clear');
  assert.equal(f.workspaces.hasConversationWorkspaceOverride(f.botId, f.key), false);
  assert.match((await f.command('/conv')).message, /状态：未显式绑定，当前跟随 bot 默认工作区/u);
});

test('/session ID retains existing cross-workspace bot-default behavior', async (t) => {
  const f = await fixture(t);
  await f.state.setSession('group:other', 'session-A');
  const binding = await f.command('/session session-B');

  assert.match(binding.message, /session-B/u);
  assert.equal(f.state.sessionFor(f.key), 'session-B');
  assert.equal(f.workspaces.workspaceFor(f.botId), f.alternateWorkspace);
  assert.equal(f.state.sessionFor('group:other'), null);
  assert.deepEqual(f.listedWorkspaces, []);
});

test('/conv B after /session A must execute the next task in B, not the bound A Session', async (t) => {
  const f = await fixture(t);
  await f.command(`/conv ${f.alternateWorkspace}`);
  await f.command('/session session-A');
  const result = await f.command(`/conv ${f.alternateWorkspace}`);
  assert.ok(result.message.includes(f.alternateWorkspace));
  assert.equal(f.scope.harness.currentConversationWorkspace(f.key), f.alternateWorkspace);

  await f.ask();

  assert.equal(f.asked.length, 1);
  assert.equal(f.asked[0].workspace, f.alternateWorkspace);
  assert.notEqual(f.asked[0].sessionId, 'session-A');
});

for (const target of ['defaultWorkspace', 'alternateWorkspace']) {
  test(`/session reconciles a conflicting override when binding to ${target}`, async (t) => {
    const f = await fixture(t);
    const previous = target === 'defaultWorkspace' ? f.alternateWorkspace : f.defaultWorkspace;
    const sessionId = target === 'defaultWorkspace' ? 'session-A' : 'session-B';
    await f.command(`/conv ${previous}`);
    await f.ask();
    const oldHandle = f.scope.harness.workspaceSession(f.state.sessionFor(f.key), f.key);

    await f.command(`/session ${sessionId}`);

    assert.equal(f.scope.harness.currentConversationWorkspace(f.key), f[target]);
    assert.equal(f.workspaces.hasConversationWorkspaceOverride(f.botId, f.key), false);
    const reloaded = await new BotWorkspaceStore(f.path, { defaultWorkspace: f.defaultWorkspace }).load();
    assert.equal(reloaded.conversationWorkspaceFor(f.botId, f.key), f[target]);
    assert.equal(reloaded.hasConversationWorkspaceOverride(f.botId, f.key), false);
    assert.equal(await oldHandle.sessionExists(), false, 'a handle from the old effective workspace is fenced');
    assert.equal(f.scope.state.sessionFor(f.key), sessionId);
    await f.ask();
    assert.equal(f.asked.at(-1).sessionId, sessionId);
    assert.equal(f.asked.at(-1).workspace, f[target]);
  });
}

test('/session preserves a matching explicit override and repeated /conv keeps its Session', async (t) => {
  const f = await fixture(t);
  await f.command(`/conv ${f.alternateWorkspace}`);
  await f.command('/session session-B');
  assert.equal(f.workspaces.hasConversationWorkspaceOverride(f.botId, f.key), true);
  await f.command(`/conv ${f.alternateWorkspace}`);
  assert.equal(f.scope.state.sessionFor(f.key), 'session-B');
  await f.ask();
  assert.equal(f.asked[0].sessionId, 'session-B');
});

for (const sessionId of ['session-A', 'session-B']) {
  test(`/conv validates a legacy ${sessionId} binding even when the override is unchanged`, async (t) => {
    const f = await fixture(t);
    await f.command(`/conv ${f.alternateWorkspace}`);
    // Simulate a persisted binding from the old implementation, without fresh
    // create/adopt provenance in this scope.
    await f.state.setSession(f.key, sessionId);
    const reads = [];
    f.harness.rpc = async (method) => {
      reads.push(method);
      return { items: [
        { path: f.defaultWorkspace, sessionIds: ['session-A'] },
        { path: f.alternateWorkspace, sessionIds: ['session-B'] },
      ] };
    };

    await f.command(`/conv ${f.alternateWorkspace}`);

    assert.equal(f.state.sessionFor(f.key), sessionId === 'session-B' ? sessionId : null);
    assert.deepEqual(reads, ['workspace.list']);
    assert.deepEqual(f.adoptedSessions, [], 'workspace verification must not adopt a Session');
    await f.ask();
    assert.equal(f.asked.at(-1).workspace, f.alternateWorkspace);
  });
}

test('/conv preserves a legacy Session registered at the real path of a symlink override', async (t) => {
  const f = await fixture(t);
  const linked = join(f.root, 'alternate-link');
  if (!await symlinkOrSkip(t, f.alternateWorkspace, linked)) return;
  await f.command(`/conv ${linked}`);
  await f.state.setSession(f.key, 'session-B');
  f.harness.rpc = async () => ({ items: [{ path: f.alternateWorkspace, sessionIds: ['session-B'] }] });

  await f.command(`/conv ${linked}`);

  assert.equal(f.state.sessionFor(f.key), 'session-B');
  await f.ask();
  assert.equal(f.asked.at(-1).sessionId, 'session-B');
});

test('/conv cannot report success if a legacy Session workspace cannot be verified', async (t) => {
  const f = await fixture(t);
  await f.command(`/conv ${f.alternateWorkspace}`);
  await f.state.setSession(f.key, 'session-A');
  f.harness.rpc = async () => { throw new Error('workspace lookup failed'); };

  await assert.rejects(
    f.scope.harness.switchConversationWorkspace(f.key, f.alternateWorkspace),
    /workspace lookup failed/,
  );
  assert.deepEqual(f.adoptedSessions, []);
});
