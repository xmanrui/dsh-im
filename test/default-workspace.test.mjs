import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { defaultImWorkspace, prepareBotWorkspace } from '../src/channels/shared/default-workspace.mjs';
import { HarnessClient } from '../src/channels/shared/harness-client.mjs';
import { BotWorkspaceStore, createBotWorkspaceScope } from '../src/channels/shared/bot-workspace-store.mjs';
import { ConversationStateStore } from '../src/channels/shared/conversation-state-store.mjs';
import { runWorkspaceCommand } from '../src/channels/shared/workspace-command.mjs';
import { askInWorkspaceSession } from '../src/channels/shared/workspace-session.mjs';
import { TextHarnessBridge } from '../src/channels/shared/text-harness-bridge.mjs';
import { symlinkOrSkip } from './support/filesystem.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-default-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { defaultWorkspace: workspace, ungroupedWorkspace } = await prepareBotWorkspace({ dshHome: root });
  const client = new HarnessClient({ apiProxy: {}, workspace, ungroupedWorkspace });
  client.ensureRunning = async () => true;
  return { root, workspace, client };
}

test('default directory follows DSH home precedence and preserves an explicit workspace', async (t) => {
  const { root } = await fixture(t);
  const previous = process.env.DSH_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  });
  delete process.env.DSH_HOME;
  assert.equal(defaultImWorkspace(), join(homedir(), '.dsh', 'im'));
  process.env.DSH_HOME = join(root, 'env');
  assert.equal(defaultImWorkspace(), join(root, 'env', 'im'));
  assert.equal(defaultImWorkspace({ dshHome: join(root, 'config') }), join(root, 'config', 'im'));
  const prepared = await prepareBotWorkspace();
  assert.equal(prepared.defaultWorkspace, join(root, 'env', 'im'));
  assert.equal((await stat(prepared.defaultWorkspace)).isDirectory(), true);
  const custom = join(root, 'project');
  const overridden = await prepareBotWorkspace({ dshHome: join(root, 'unused'), workspace: custom });
  assert.equal(overridden.defaultWorkspace, custom);
  await assert.rejects(stat(join(root, 'unused')), { code: 'ENOENT' });
});

test('directory failures propagate without falling back to the Host working directory', async (t) => {
  const { root, workspace, client } = await fixture(t);
  await writeFile(join(root, 'blocked'), 'file');
  await assert.rejects(prepareBotWorkspace({ dshHome: join(root, 'blocked') }));
  await rm(workspace, { recursive: true });
  await writeFile(workspace, 'file');
  client.rpc = async () => assert.fail('must fail before creating a session or group');
  await assert.rejects(client.createSession());
});

test('default and symlink sessions stay ungrouped; a selected project keeps normal grouping', async (t) => {
  const { root, workspace, client } = await fixture(t);
  const alias = join(root, 'alias');
  if (!await symlinkOrSkip(t, workspace, alias, 'dir')) return;
  const calls = [];
  client.rpc = async (method, payload) => {
    calls.push({ method, payload });
    if (method === 'workspace.list') return { items: [] };
    if (method === 'workspace.create') return { workspace: { workspaceId: 'project' } };
    assert.equal(method, 'session.create');
    return { sessionId: 'session-' + calls.length };
  };
  await client.createSession();
  await client.createSession({ workspace: alias, agentPreset: 'custom' });
  assert.deepEqual(calls, [
    { method: 'session.create', payload: { cwd: workspace } },
    { method: 'session.create', payload: { cwd: alias, agentPreset: 'custom' } },
  ]);
  calls.length = 0;
  const project = join(root, 'project');
  await mkdir(project);
  await client.createSession({ workspace: project });
  assert.deepEqual(calls, [
    { method: 'workspace.list', payload: {} },
    { method: 'workspace.create', payload: { path: project } },
    { method: 'session.create', payload: { workspaceId: 'project' } },
  ]);
  calls.length = 0;
  await rm(workspace, { recursive: true });
  await client.createSession({ workspace });
  assert.equal((await stat(workspace)).isDirectory(), true);
  assert.deepEqual(calls, [{ method: 'session.create', payload: { cwd: workspace } }]);
});

test('default session listing merges explicit membership with ungrouped cwd matches only', async (t) => {
  const { root, workspace, client } = await fixture(t);
  const alias = join(root, 'alias');
  if (!await symlinkOrSkip(t, workspace, alias, 'dir')) return;
  const groups = [
    { workspaceId: 'im', path: alias, sessionIds: ['grouped', 'missing'] },
    { workspaceId: 'other', path: join(root, 'other'), sessionIds: ['elsewhere'] },
  ];
  const sessions = [
    { sessionId: 'grouped', cwd: workspace },
    { sessionId: 'free', cwd: alias, projections: { asOfSeq: 9, values: { title: 'Hello' } } },
    { sessionId: 'elsewhere', cwd: workspace },
    { sessionId: 'outside', cwd: join(root, 'other') },
    { sessionId: 'child', cwd: workspace, origin: 'subagent', blank: true },
  ];
  client.rpc = async (method) => {
    if (method === 'workspace.list') return { items: groups, archivedSessionIds: ['free', 'missing'] };
    assert.equal(method, 'session.list', 'listing must never create or attach sessions');
    return { items: sessions };
  };
  const listed = await client.listWorkspaceSessions(workspace);
  assert.deepEqual(listed.sessions.map(item => item.sessionId), ['grouped', 'missing', 'free', 'child']);
  assert.equal(listed.sessions[1].summaryAvailable, false);
  assert.equal(listed.sessions[2].title, 'Hello');
  assert.equal(listed.sessions[2].archived, true);
  assert.equal(listed.sessions[2].lastSeq, 9);
  assert.equal(listed.sessions[3].origin, 'subagent');
  assert.deepEqual((await client.listWorkspaceSessions(join(root, 'other'))).sessions.map(item => item.sessionId), ['elsewhere']);
  groups.length = 0;
  assert.equal((await client.listWorkspaceSessions(workspace)).sessions.some(item => item.sessionId === 'free'), true);
});

test('only ordinary default-directory sessions can be adopted without a group', async (t) => {
  const { root, workspace, client } = await fixture(t);
  let summary = { sessionId: 'existing', cwd: workspace, projections: { values: { title: 'Existing' } } };
  let owners = [];
  const creates = [];
  client.rpc = async (method, payload) => {
    if (method === 'workspace.list') return { items: owners, archivedSessionIds: ['existing'] };
    if (method === 'session.list') return { items: summary ? [summary] : [] };
    assert.equal(method, 'session.create');
    creates.push(payload);
    return { sessionId: payload.sessionId };
  };
  assert.deepEqual(await client.adoptWorkspaceSession('existing'), {
    sessionId: 'existing', workspace, title: 'Existing', archived: true,
  });
  assert.deepEqual(creates, [{ cwd: workspace, sessionId: 'existing' }]);
  const original = summary;
  const alias = join(root, 'alias');
  if (!await symlinkOrSkip(t, workspace, alias, 'dir')) return;
  summary = { ...original, cwd: alias };
  assert.equal((await client.adoptWorkspaceSession('existing')).workspace, alias);
  assert.deepEqual(creates[1], { cwd: alias, sessionId: 'existing' });
  for (const [patch, code] of [
    [{ cwd: join(root, 'other') }, 'session-not-registered'],
    [{ cwd: undefined }, 'session-not-registered'],
    [{ cwd: 'relative' }, 'session-not-registered'],
    [{ origin: 'subagent' }, 'session-subagent-unsupported'],
  ]) {
    summary = { ...original, ...patch };
    await assert.rejects(client.adoptWorkspaceSession('existing'), { code });
  }
  summary = null;
  await assert.rejects(client.adoptWorkspaceSession('existing'), { code: 'session-summary-unavailable' });
  summary = original;
  owners = ['one', 'two'].map(workspaceId => ({ workspaceId, path: workspace, sessionIds: ['existing'] }));
  await assert.rejects(client.adoptWorkspaceSession('existing'), { code: 'session-workspace-ambiguous' });
  assert.equal(creates.length, 2);
});

test('commands bind default sessions by id or number and retain them after reload and /conv clear', async (t) => {
  const { root, workspace, client } = await fixture(t);
  const sessions = new Map([['existing', { sessionId: 'existing', cwd: workspace }]]);
  const creates = [];
  const asks = [];
  client.rpc = async (method, payload) => {
    if (method === 'workspace.list') return { items: [], archivedSessionIds: [] };
    if (method === 'session.list') return { items: [...sessions.values()] };
    if (method === 'session.history') {
      assert.ok(sessions.has(payload.sessionId));
      return { events: [] };
    }
    assert.equal(method, 'session.create');
    assert.equal(payload.workspaceId, undefined);
    creates.push(payload);
    const sessionId = payload.sessionId ?? 'new-' + creates.length;
    sessions.set(sessionId, { sessionId, cwd: payload.cwd });
    return { sessionId };
  };
  client.ask = async (id) => { asks.push(id); return 'answer'; };
  const storePath = join(root, 'workspaces.json');
  const statePath = join(root, 'state.json');
  let workspaces = await new BotWorkspaceStore(storePath, { defaultWorkspace: workspace }).load();
  let state = await new ConversationStateStore(statePath).load();
  await workspaces.ensure('bot');
  let scope = createBotWorkspaceScope(client, { botId: 'bot', workspaces, state });
  assert.ok((await runWorkspaceCommand('/wsl', scope.harness)).message.includes(workspace));
  assert.match((await runWorkspaceCommand('/sessions', scope.harness, 'direct:chat')).message, /existing/);
  await runWorkspaceCommand('/session 1', scope.harness, 'direct:chat');
  assert.equal(state.sessionFor('direct:chat'), 'existing');
  await runWorkspaceCommand('/session existing', scope.harness, 'direct:chat');
  assert.equal(state.sessionFor('direct:chat'), 'existing');
  workspaces = await new BotWorkspaceStore(storePath, { defaultWorkspace: workspace }).load();
  state = await new ConversationStateStore(statePath).load();
  scope = createBotWorkspaceScope(client, { botId: 'bot', workspaces, state });
  await scope.harness.clearConversationWorkspace('direct:chat');
  assert.equal(state.sessionFor('direct:chat'), 'existing', 'cold ungrouped binding is still in the correct workspace');
  await askInWorkspaceSession({ harness: scope.harness, state: scope.state, key: 'direct:chat', text: 'continue' });
  assert.deepEqual(asks, ['existing']);
  const abort = new AbortController();
  t.after(() => abort.abort());
  client.watchHarnessEvents = undefined;
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'test', label: 'Test' },
    bot: { async sendText() {} },
    harness: scope.harness,
    state: scope.state,
    signal: abort.signal,
  });
  await bridge.accept({ messageId: 'reset', senderId: 'user', conversationId: 'chat', kind: 'direct', content: '/new' });
  assert.equal(state.sessionFor('direct:chat'), null);
  await bridge.accept({ messageId: 'next', senderId: 'user', conversationId: 'chat', kind: 'direct', content: 'new conversation' });
  assert.ok(state.sessionFor('direct:chat')?.startsWith('new-'));
  assert.deepEqual(asks, ['existing', state.sessionFor('direct:chat')]);
  assert.equal(creates.at(-1).cwd, workspace);
});
