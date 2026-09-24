import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { defaultImWorkspace, prepareBotWorkspace } from '../src/channels/shared/default-workspace.mjs';
import { HarnessClient } from '../src/channels/shared/harness-client.mjs';
import { BotWorkspaceStore, createBotWorkspaceScope, createWorkspaceAwareController } from '../src/channels/shared/bot-workspace-store.mjs';
import { ConversationStateStore } from '../src/channels/shared/conversation-state-store.mjs';
import { runWorkspaceCommand } from '../src/channels/shared/workspace-command.mjs';
import { askInWorkspaceSession } from '../src/channels/shared/workspace-session.mjs';
import { TextHarnessBridge } from '../src/channels/shared/text-harness-bridge.mjs';
import { symlinkOrSkip } from './support/filesystem.mjs';

async function fixture(t, { createDirectory = true } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-default-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { defaultWorkspace: workspace, ungroupedWorkspace } = await prepareBotWorkspace({ dshHome: root });
  if (createDirectory) await mkdir(workspace);
  const client = new HarnessClient({ apiProxy: {}, workspace, ungroupedWorkspace });
  client.ensureRunning = async () => true;
  return { root, workspace, client };
}

test('default directory resolution preserves precedence without creating directories', async (t) => {
  const { root, workspace } = await fixture(t, { createDirectory: false });
  await assert.rejects(stat(workspace), { code: 'ENOENT' });
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
  await assert.rejects(stat(prepared.defaultWorkspace), { code: 'ENOENT' });
  const custom = join(root, 'project');
  const overridden = await prepareBotWorkspace({ dshHome: join(root, 'unused'), workspace: custom });
  assert.equal(overridden.defaultWorkspace, custom);
  await assert.rejects(stat(join(root, 'unused')), { code: 'ENOENT' });
});

test('directory failures propagate without falling back to the Host working directory', async (t) => {
  const { root, workspace, client } = await fixture(t);
  await writeFile(join(root, 'blocked'), 'file');
  const prepared = await prepareBotWorkspace({ dshHome: join(root, 'blocked') });
  const store = await new BotWorkspaceStore(join(root, 'workspaces.json'), prepared).load();
  await assert.rejects(store.ensure('bot'));
  assert.equal(store.has('bot'), false);
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
  await rm(workspace, { recursive: true });
  let summary = { sessionId: 'existing', cwd: workspace, projections: { values: { title: 'Existing' } } };
  let owners = [];
  const creates = [];
  client.rpc = async (method, payload) => {
    if (method === 'workspace.list') return { items: owners, archivedSessionIds: ['existing'] };
    if (method === 'session.list') return { items: summary ? [summary] : [] };
    assert.equal(method, 'session.create');
    assert.equal((await stat(workspace)).isDirectory(), true, 'prepare cwd before restoring the session');
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
  await rm(workspace, { recursive: true });
  for (const [patch, code] of [
    [{ cwd: join(root, 'other') }, 'session-not-registered'],
    [{ cwd: undefined }, 'session-not-registered'],
    [{ cwd: 'relative' }, 'session-not-registered'],
    [{ origin: 'subagent' }, 'session-subagent-unsupported'],
  ]) {
    summary = { ...original, ...patch };
    await assert.rejects(client.adoptWorkspaceSession('existing'), { code });
    await assert.rejects(stat(workspace), { code: 'ENOENT' }, 'invalid sessions must not create a directory');
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
  const workspaceOptions = { defaultWorkspace: workspace, ungroupedWorkspace: workspace };
  let workspaces = await new BotWorkspaceStore(storePath, workspaceOptions).load();
  let state = await new ConversationStateStore(statePath).load();
  await workspaces.ensure('bot');
  let scope = createBotWorkspaceScope(client, { botId: 'bot', workspaces, state });
  assert.ok((await runWorkspaceCommand('/wsl', scope.harness)).message.includes(workspace));
  assert.match((await runWorkspaceCommand('/sessions', scope.harness, 'direct:chat')).message, /existing/);
  await runWorkspaceCommand('/session 1', scope.harness, 'direct:chat');
  assert.equal(state.sessionFor('direct:chat'), 'existing');
  await runWorkspaceCommand('/session existing', scope.harness, 'direct:chat');
  assert.equal(state.sessionFor('direct:chat'), 'existing');
  await rm(workspace, { recursive: true });
  workspaces = await new BotWorkspaceStore(storePath, workspaceOptions).load();
  await workspaces.ensure('bot');
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

test('only selected bot and conversation workspaces prepare the shared directory on reload', async (t) => {
  const { root, workspace } = await fixture(t, { createDirectory: false });
  const project = join(root, 'project');
  await mkdir(project);
  const path = join(root, 'workspaces.json');
  const options = { defaultWorkspace: workspace, ungroupedWorkspace: workspace };
  let store = await new BotWorkspaceStore(path, options).load();
  assert.equal(store.workspaceFor('new_bot'), workspace);
  await assert.rejects(stat(workspace), { code: 'ENOENT' });
  await Promise.all(['one', 'two'].map(bot => store.ensure(bot, { workspace: project })));
  store = await new BotWorkspaceStore(path, options).load();
  await Promise.all(['one', 'two'].map(bot => store.ensure(bot)));
  assert.equal(store.workspaceFor('one'), project);
  await assert.rejects(stat(workspace), { code: 'ENOENT' });
  await store.setConversationWorkspace('one', 'direct:chat', workspace);
  assert.equal((await stat(workspace)).isDirectory(), true);
  await rm(workspace, { recursive: true });
  store = await new BotWorkspaceStore(path, options).load();
  assert.equal(store.conversationWorkspaceFor('one', 'direct:chat'), workspace);
  await assert.rejects(stat(workspace), { code: 'ENOENT' }, 'loading and reading are side-effect free');
  await store.ensure('two');
  await assert.rejects(stat(workspace), { code: 'ENOENT' }, 'only the selected bot prepares its paths');
  await store.ensure('one');
  assert.equal((await stat(workspace)).isDirectory(), true);
  await writeFile(join(workspace, 'keep.txt'), 'user data');
  await Promise.all(['three', 'four'].map(bot => store.ensure(bot)));
  assert.equal(store.workspaceFor('three'), workspace);
  assert.equal(store.workspaceFor('two'), project);
  assert.equal(await readFile(join(workspace, 'keep.txt'), 'utf8'), 'user data');
  assert.equal(Object.hasOwn(JSON.parse(await readFile(path, 'utf8')), 'ungroupedWorkspace'), false);
});

test('custom defaults and stores without an IM directory retain strict path validation', async (t) => {
  const { root, workspace } = await fixture(t, { createDirectory: false });
  const project = join(root, 'missing-project');
  const store = await new BotWorkspaceStore(join(root, 'workspaces.json'), {
    defaultWorkspace: project, ungroupedWorkspace: workspace,
  }).load();
  await store.ensure('bot');
  await assert.rejects(stat(project), { code: 'ENOENT' });
  await assert.rejects(stat(workspace), { code: 'ENOENT' });
  await assert.rejects(store.setWorkspace('bot', project), { code: 'workspace-not-found' });
  const ordinary = await new BotWorkspaceStore(join(root, 'ordinary.json'), { defaultWorkspace: workspace }).load();
  await ordinary.ensure('bot');
  await assert.rejects(ordinary.setWorkspace('bot', workspace), { code: 'workspace-not-found' });
  await assert.rejects(stat(workspace), { code: 'ENOENT' });
});

test('new default bots can list sessions before their first message and recreate cwd for that message', async (t) => {
  const { root, workspace, client } = await fixture(t, { createDirectory: false });
  const workspaces = await new BotWorkspaceStore(join(root, 'workspaces.json'), {
    defaultWorkspace: workspace, ungroupedWorkspace: workspace,
  }).load();
  const state = await new ConversationStateStore(join(root, 'state.json')).load();
  await workspaces.ensure('bot');
  const scope = createBotWorkspaceScope(client, { botId: 'bot', workspaces, state });
  let creates = 0;
  client.rpc = async (method, payload) => {
    if (method === 'workspace.list') return { items: [], archivedSessionIds: [] };
    if (method === 'session.list') return { items: [] };
    assert.equal(method, 'session.create');
    assert.deepEqual(payload, { cwd: workspace });
    assert.equal((await stat(workspace)).isDirectory(), true);
    creates += 1;
    return { sessionId: 'new-session' };
  };
  assert.ok((await runWorkspaceCommand('/workspacelist', scope.harness)).message.includes(workspace));
  assert.match((await runWorkspaceCommand('/sessions', scope.harness, 'direct:chat')).message, /暂无会话/);
  assert.equal(creates, 0);
  await rm(workspace, { recursive: true });
  client.ask = async () => 'answer';
  await askInWorkspaceSession({ harness: scope.harness, state: scope.state, key: 'direct:chat', text: 'hello' });
  assert.equal(state.sessionFor('direct:chat'), 'new-session');
  assert.equal(creates, 1);
});

test('card saves, workspace commands and conversation clear prepare only the selected default directory', async (t) => {
  const { root, workspace, client } = await fixture(t, { createDirectory: false });
  const project = join(root, 'project');
  await mkdir(project);
  const workspaces = await new BotWorkspaceStore(join(root, 'workspaces.json'), {
    defaultWorkspace: project, ungroupedWorkspace: workspace,
  }).load();
  const state = await new ConversationStateStore(join(root, 'state.json')).load();
  await workspaces.ensure('bot');
  const scope = createBotWorkspaceScope(client, { botId: 'bot', workspaces, state });
  const controller = createWorkspaceAwareController({ status: () => ({ bots: [{ botId: 'bot' }] }) }, {
    workspaces, stateFor: async () => state,
  });
  await state.setSession('direct:chat', 'old-session');
  await controller.updateWorkspace('bot', workspace);
  assert.equal(workspaces.workspaceFor('bot'), workspace);
  assert.equal(state.sessionFor('direct:chat'), null);
  assert.equal((await stat(workspace)).isDirectory(), true);
  await controller.updateWorkspace('bot', project);
  await rm(workspace, { recursive: true });
  await runWorkspaceCommand('/workspace ' + workspace, scope.harness);
  assert.equal(workspaces.workspaceFor('bot'), workspace);
  assert.equal((await stat(workspace)).isDirectory(), true);
  await runWorkspaceCommand('/workspace ' + project, scope.harness);
  await rm(workspace, { recursive: true });
  await runWorkspaceCommand('/conv ' + workspace, scope.harness, 'direct:chat');
  assert.equal(workspaces.conversationWorkspaceFor('bot', 'direct:chat'), workspace);
  assert.equal(workspaces.workspaceFor('bot'), project);
  assert.equal((await stat(workspace)).isDirectory(), true);
  await controller.updateWorkspace('bot', workspace);
  await runWorkspaceCommand('/conv ' + project, scope.harness, 'direct:chat');
  await rm(workspace, { recursive: true });
  await runWorkspaceCommand('/conv clear', scope.harness, 'direct:chat');
  assert.equal(workspaces.hasConversationWorkspaceOverride('bot', 'direct:chat'), false);
  assert.equal(workspaces.conversationWorkspaceFor('bot', 'direct:chat'), workspace);
  assert.equal((await stat(workspace)).isDirectory(), true);
});

test('failed directory preparation preserves existing workspace and session bindings', async (t) => {
  const { root, workspace, client } = await fixture(t, { createDirectory: false });
  const project = join(root, 'project');
  await mkdir(project);
  const path = join(root, 'workspaces.json');
  const workspaces = await new BotWorkspaceStore(path, {
    defaultWorkspace: project, ungroupedWorkspace: workspace,
  }).load();
  const state = await new ConversationStateStore(join(root, 'state.json')).load();
  await workspaces.ensure('bot');
  await state.setSession('direct:chat', 'old-session');
  const before = await readFile(path, 'utf8');
  const scope = createBotWorkspaceScope(client, { botId: 'bot', workspaces, state });
  const missing = join(root, 'typo');
  await assert.rejects(scope.harness.switchWorkspace(missing), { code: 'workspace-not-found' });
  await assert.rejects(stat(missing), { code: 'ENOENT' });
  await writeFile(workspace, 'file blocking directory creation');
  await assert.rejects(scope.harness.switchWorkspace(workspace));
  await assert.rejects(scope.harness.switchConversationWorkspace('direct:chat', workspace));
  client.rpc = async (method) => {
    if (method === 'workspace.list') return { items: [], archivedSessionIds: [] };
    if (method === 'session.list') return { items: [{ sessionId: 'default-session', cwd: workspace }] };
    assert.fail('must fail before restoring a session');
  };
  await assert.rejects(scope.harness.bindWorkspaceSession('direct:chat', 'default-session'));
  assert.equal(workspaces.workspaceFor('bot'), project);
  assert.equal(workspaces.conversationWorkspaceFor('bot', 'direct:chat'), project);
  assert.equal(state.sessionFor('direct:chat'), 'old-session');
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal(await readFile(workspace, 'utf8'), 'file blocking directory creation');
});

test('permission failures do not publish a new default bot', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async (t) => {
  const { root, workspace } = await fixture(t, { createDirectory: false });
  const store = await new BotWorkspaceStore(join(root, 'workspaces.json'), {
    defaultWorkspace: workspace, ungroupedWorkspace: workspace,
  }).load();
  await chmod(root, 0o500);
  try {
    await assert.rejects(store.ensure('bot'), { code: 'EACCES' });
    assert.equal(store.has('bot'), false);
  } finally {
    await chmod(root, 0o700);
  }
});

test('binding an old default session from a custom workspace restores cwd before the Host call', async (t) => {
  const { root, workspace, client } = await fixture(t, { createDirectory: false });
  const project = join(root, 'project');
  await mkdir(project);
  const workspaces = await new BotWorkspaceStore(join(root, 'workspaces.json'), {
    defaultWorkspace: project, ungroupedWorkspace: workspace,
  }).load();
  const state = await new ConversationStateStore(join(root, 'state.json')).load();
  await workspaces.ensure('bot');
  await state.setSession('direct:chat', 'previous');
  const scope = createBotWorkspaceScope(client, { botId: 'bot', workspaces, state });
  const restored = [];
  client.rpc = async (method, payload) => {
    if (method === 'workspace.list') return { items: [], archivedSessionIds: [] };
    if (method === 'session.list') return { items: [{ sessionId: 'existing', cwd: workspace }] };
    assert.equal(method, 'session.create');
    assert.deepEqual(payload, { sessionId: 'existing', cwd: workspace });
    assert.equal((await stat(workspace)).isDirectory(), true);
    restored.push(payload.sessionId);
    return { sessionId: 'existing' };
  };
  assert.match((await runWorkspaceCommand('/session existing', scope.harness, 'direct:chat')).message, /已绑定会话/);
  assert.equal(workspaces.workspaceFor('bot'), workspace);
  assert.equal(state.sessionFor('direct:chat'), 'existing');
  assert.deepEqual(restored, ['existing']);
});
