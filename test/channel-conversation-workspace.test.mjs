import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BotWorkspaceStore, createBotWorkspaceScope } from '../src/channels/shared/bot-workspace-store.mjs';
import { runWorkspaceCommand } from '../src/channels/shared/workspace-command.mjs';
import { FeishuHarnessBridge } from '../src/channels/feishu/bridge.mjs';
import { StateStore } from '../src/channels/feishu/state-store.mjs';
import { dingtalkMenuSnapshot } from '../src/channels/dingtalk/dingtalk-menu.mjs';
import { DingtalkHarnessBridge } from '../src/channels/dingtalk/dingtalk-bridge.mjs';
import { qqMenuView } from '../src/channels/qq/qq-menu.mjs';
import { QqHarnessBridge } from '../src/channels/qq/qq-bridge.mjs';
import { directAccessPolicy } from './channels/access-policy-fixture.mjs';

async function fixture(t, { sessionCount = 1, beforeList } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-channel-workspace-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceA = join(root, 'a');
  const workspaceB = join(root, 'b');
  await Promise.all([mkdir(workspaceA), mkdir(workspaceB)]);
  const workspaces = await new BotWorkspaceStore(join(root, 'workspaces.json'), {
    defaultWorkspace: workspaceA,
  }).load();
  const botId = 'bot_channel_workspace';
  await workspaces.ensure(botId);
  const state = await new StateStore(join(root, 'state.json')).load();
  const listedWorkspaces = [];
  const adoptedSessions = [];
  const archivedSessionCalls = [];
  const target = {
    async ensureRunning() {},
    async listWorkspaces() { return [workspaceA, workspaceB]; },
    async listWorkspaceSessions(workspace) {
      listedWorkspaces.push(workspace);
      await beforeList?.(workspace);
      const name = workspace === workspaceB ? 'B' : 'A';
      return {
        workspace,
        sessions: Array.from({ length: sessionCount }, (_, index) => ({
          sessionId: `session-${name}${index ? `-${index + 1}` : ''}`,
          title: `Session ${name}${index ? ` ${index + 1}` : ''}`,
        })),
      };
    },
    async listModels() { return { groups: [], failures: [] }; },
    async adoptWorkspaceSession(sessionId) {
      adoptedSessions.push(sessionId);
      return { sessionId, workspace: sessionId === 'session-B' ? workspaceB : workspaceA };
    },
    async archiveWorkspaceSession(sessionId, options = {}) {
      archivedSessionCalls.push({ sessionId, stopActivity: options.stopActivity === true });
      return { archivedSessionIds: [sessionId] };
    },
  };
  const scope = createBotWorkspaceScope(target, { botId, workspaces, state });
  return {
    ...scope,
    workspaces,
    botId,
    workspaceA,
    workspaceB,
    listedWorkspaces,
    adoptedSessions,
    archivedSessionCalls,
  };
}

function feishuMessage(messageId, text) {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
    message: {
      message_id: messageId, message_type: 'text', chat_type: 'p2p',
      chat_id: 'oc_chat', content: JSON.stringify({ text }),
    },
  };
}

function feishuBridge(f) {
  const sent = [];
  const sendMessage = async (request) => {
    sent.push({ type: request.data.msg_type, content: JSON.parse(request.data.content) });
    return { code: 0, data: { message_id: `card-${sent.length}` } };
  };
  const bridge = new FeishuHarnessBridge({
    client: { im: { v1: { message: { create: sendMessage, reply: sendMessage } } } },
    channel: {}, harness: f.harness, state: f.state,
    status: { messagesReceived: 0, messagesReplied: 0, messagesRejected: 0 },
    allowedSenderOpenIds: new Set(['ou_owner']),
  });
  return {
    sent,
    async send(id, text) {
      await bridge.accept(feishuMessage(id, text));
      await bridge.waitForIdle();
    },
  };
}

test('the production scope exposes sessionFor so /sessionlist marks the bound Session', async (t) => {
  const f = await fixture(t);
  const key = 'p2p:ou_owner';
  assert.equal(typeof f.harness.sessionFor, 'function');
  await f.state.setSession(key, 'session-A');

  const listed = await runWorkspaceCommand('/sessionlist', f.harness, key);
  assert.match(listed.message, /1\. Session A（当前绑定）\n   ID: session-A/);
});

test('title binding in a pinned workspace preserves the bot default and other chats', async (t) => {
  const f = await fixture(t);
  const key = 'p2p:ou_owner';
  const otherKey = 'p2p:ou_other';
  await f.harness.switchConversationWorkspace(key, f.workspaceB);
  await f.state.setSession(otherKey, 'session-A');

  const bound = await runWorkspaceCommand('/session B', f.harness, key);

  assert.match(bound.message, /ID：session-B/);
  assert.equal(f.state.sessionFor(key), 'session-B');
  assert.equal(f.state.sessionFor(otherKey), 'session-A');
  assert.equal(f.harness.currentWorkspace(), f.workspaceA);
  assert.equal(f.harness.currentConversationWorkspace(key), f.workspaceB);
  assert.equal(f.workspaces.hasConversationWorkspaceOverride(f.botId, key), true);

  // Explicit IDs retain the documented bot-wide switching behavior.
  await runWorkspaceCommand('/session session-B', f.harness, key);
  assert.equal(f.harness.currentWorkspace(), f.workspaceB);
  assert.equal(f.state.sessionFor(otherKey), null);
});

test('a workspace change during title search rejects the stale selection', async (t) => {
  let release;
  let ready;
  const paused = new Promise((resolve) => { ready = resolve; });
  const resume = new Promise((resolve) => { release = resolve; });
  let block = true;
  const f = await fixture(t, {
    async beforeList() {
      if (!block) return;
      block = false;
      ready();
      await resume;
    },
  });
  const key = 'p2p:ou_owner';
  const otherKey = 'p2p:ou_other';
  await f.harness.switchConversationWorkspace(key, f.workspaceB);
  await f.state.setSession(otherKey, 'session-A');
  const selecting = runWorkspaceCommand('/session B', f.harness, key);
  await paused;
  try {
    await f.harness.switchConversationWorkspace(key, f.workspaceA);
  } finally {
    release();
  }

  const result = await selecting;
  assert.match(result.message, /工作区或会话状态已发生变化/);
  assert.equal(f.harness.currentWorkspace(), f.workspaceA);
  assert.equal(f.harness.currentConversationWorkspace(key), f.workspaceA);
  assert.equal(f.state.sessionFor(key), null);
  assert.equal(f.state.sessionFor(otherKey), 'session-A');
});

test('Feishu accept sends cross-workspace summaries with limits and binding markers', async (t) => {
  const f = await fixture(t, { sessionCount: 12 });
  const key = 'p2p:ou_owner';
  await f.harness.switchConversationWorkspace(key, f.workspaceB);
  await f.state.setSession(key, 'session-B');
  const channel = feishuBridge(f);

  await channel.send('sessions-all', '/sessionlist --all');
  const all = JSON.stringify(channel.sent);
  assert.deepEqual(f.listedWorkspaces, [f.workspaceB, f.workspaceA]);
  assert.match(all, /跨工作区会话（2 个工作区，共 24 个会话）/);
  assert.match(all, /Session B（当前绑定）/);
  assert.match(all, /ID: session-A-10/);
  assert.match(all, /ID: session-B-10/);
  assert.doesNotMatch(all, /ID: session-[AB]-11/);

  f.listedWorkspaces.length = 0;
  channel.sent.length = 0;
  await channel.send('sessions-all-limited', '/SESSIONS --LIMIT 2 --ALL');
  const limited = JSON.stringify(channel.sent);
  assert.deepEqual(f.listedWorkspaces, [f.workspaceB, f.workspaceA]);
  assert.match(limited, /ID: session-A-2/);
  assert.match(limited, /ID: session-B-2/);
  assert.doesNotMatch(limited, /ID: session-[AB]-3/);
});

test('Feishu session cards mark the bound Session while retaining watch and use actions', async (t) => {
  const f = await fixture(t);
  const key = 'p2p:ou_owner';
  await f.state.setSession(key, 'session-A');
  const channel = feishuBridge(f);

  await channel.send('sessions-bound', '/sessionlist');

  assert.equal(channel.sent.at(-1).type, 'interactive');
  const card = JSON.stringify(channel.sent.at(-1).content);
  assert.match(card, /1\. Session A（当前绑定）/);
  assert.match(card, /use:session-A/);
  assert.match(card, /watch:session-A/);
});

test('Feishu accept uses /conv for /sessionlist while explicit selectors still win', async (t) => {
  const f = await fixture(t);
  const channel = feishuBridge(f);
  await channel.send('conv-set', `/conv ${f.workspaceB}`);
  assert.equal(f.workspaces.conversationWorkspaceFor(f.botId, 'p2p:ou_owner'), f.workspaceB);

  await channel.send('sessions-default', '/sessionlist');
  assert.equal(f.listedWorkspaces.at(-1), f.workspaceB);
  assert.match(JSON.stringify(channel.sent.at(-1)), /session-B/u);
  assert.doesNotMatch(JSON.stringify(channel.sent.at(-1)), /session-A/u);

  await channel.send('sessions-explicit', `/sessionlist ${f.workspaceA}`);
  assert.equal(f.listedWorkspaces.at(-1), f.workspaceA);
  await channel.send('conv-clear', '/conv clear');
  await channel.send('sessions-follow-default', '/sessionlist');
  assert.equal(f.listedWorkspaces.at(-1), f.workspaceA);
});

test('Feishu main menu lists conversation sessions but keeps workspace settings bot-scoped', async (t) => {
  const f = await fixture(t);
  const channel = feishuBridge(f);
  await channel.send('conv-set', `/conv ${f.workspaceB}`);
  await channel.send('menu-open', '/m');
  assert.deepEqual(f.listedWorkspaces, [f.workspaceB]);
  assert.match(JSON.stringify(channel.sent.at(-1)), /session-B/u);
  assert.doesNotMatch(JSON.stringify(channel.sent.at(-1)), /session-A/u);
  assert.equal(f.harness.currentWorkspace(), f.workspaceA);
});

test('Dingtalk menu selects conversation sessions without changing its workspace setting', async (t) => {
  const f = await fixture(t);
  const key = 'direct:owner';
  await runWorkspaceCommand(`/conv ${f.workspaceB}`, f.harness, key);
  const menu = await dingtalkMenuSnapshot(f.harness, f.state, key);

  assert.deepEqual(f.listedWorkspaces, [f.workspaceB]);
  assert.ok(menu.selections.session.some(([, command]) => command === '/session session-B'));
  assert.ok(!menu.selections.session.some(([, command]) => command === '/session session-A'));
  assert.equal(menu.selections.workspace[menu.data.workspace_index][1], `/workspace ${f.workspaceA}`);
  assert.equal(f.harness.currentWorkspace(), f.workspaceA);
});

test('QQ menus list conversation sessions while workspace choices retain the bot default', async (t) => {
  const f = await fixture(t);
  const key = 'c2c:owner';
  await runWorkspaceCommand(`/conv ${f.workspaceB}`, f.harness, key);
  const sessions = await qqMenuView('sessions', f.harness, f.state, key);
  assert.deepEqual(f.listedWorkspaces, [f.workspaceB]);
  assert.ok(sessions.entries.some((entry) => entry.action.text === '/session session-B'));
  assert.ok(!sessions.entries.some((entry) => entry.action.text === '/session session-A'));

  await qqMenuView('main', f.harness, f.state, key);
  assert.equal(f.listedWorkspaces.at(-1), f.workspaceB);
  const choices = await qqMenuView('workspaces', f.harness, f.state, key);
  const current = choices.entries.find((entry) => entry.label.startsWith('✓ '));
  assert.equal(current.action.text, `/workspace ${f.workspaceA}`);
  assert.equal(f.harness.currentWorkspace(), f.workspaceA);
});

test('Dingtalk rejects a previously displayed session choice after only /conv changes', async (t) => {
  const f = await fixture(t);
  const key = 'p2p:staff-owner';
  const cards = [];
  const updates = [];
  const bridge = new DingtalkHarnessBridge({
    api: {
      async sendText() {},
      async createMenuCard(card) { cards.push(card); return { cardInstanceId: 'menu-one' }; },
      async updateMenuCard(card) { updates.push(card); },
    },
    clientId: 'test-client', clientSecret: 'test-secret',
    harness: f.harness, state: f.state,
    accessPolicy: directAccessPolicy({ users: [{ id: 'staff-owner', canExecuteCommands: true }] }),
    logger: { warn() {}, info() {} },
  });
  const message = (msgId, content) => ({
    msgId, msgtype: 'text', text: { content }, conversationType: '1',
    conversationId: 'direct-conversation', senderStaffId: 'staff-owner',
    sessionWebhook: 'https://oapi.dingtalk.com/robot/reply?ticket=test-fixture',
  });
  await bridge.accept(message('conv-before-menu', `/conv ${f.workspaceB}`));
  await bridge.waitForIdle();
  await bridge.accept(message('open-menu', '/m'));
  await bridge.waitForIdle();
  assert.equal(cards.length, 1);
  assert.equal(f.state.sessionFor(key), null);
  await bridge.accept(message('conv-after-menu', `/conv ${f.workspaceA}`));
  await bridge.waitForIdle();
  assert.equal(f.state.sessionFor(key), null);
  await bridge.acceptCard({
    outTrackId: 'menu-one', userId: 'staff-owner',
    content: JSON.stringify({ cardPrivateData: { actionIds: ['session'], params: {
      revision: cards[0].data.revision, session: { index: 1 },
    } } }),
  }, 'old-menu-selection');

  assert.deepEqual(f.adoptedSessions, []);
  assert.equal(f.harness.currentConversationWorkspace(key), f.workspaceA);
  assert.equal(f.state.sessionFor(key), null);
  assert.match(updates.at(-1).data.notice, /会话或工作区已变化/u);
});

test('QQ rejects an actor\'s old session menu after another group actor changes /conv', async (t) => {
  const f = await fixture(t);
  const key = 'group:group-one';
  const sent = [];
  const policy = directAccessPolicy({ users: [
    { id: 'owner', canExecuteCommands: true }, { id: 'other', canExecuteCommands: true },
  ] });
  policy.getSettings().group = structuredClone(policy.getSettings().direct);
  const bridge = new QqHarnessBridge({
    bot: {
      async send(message) { sent.push(message); return { id: `reply-${sent.length}` }; },
      async sendText(_target, text) { sent.push({ content: text }); return { id: `reply-${sent.length}` }; },
    },
    ownerUserOpenid: '*', harness: f.harness, state: f.state, accessPolicy: policy,
    logger: { warn() {}, error() {} },
  });
  let sequence = 0;
  const send = async (content, senderId = 'owner') => {
    const messageId = `message-${++sequence}`;
    await bridge.accept({
      kind: 'group', groupOpenid: 'group-one', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
      senderId, messageId, content,
      replyTarget: { scope: 'group', targetId: 'group-one', msgId: messageId },
    });
  };
  await send(`/conv ${f.workspaceB}`);
  await send('/m sessions');
  const menu = sent.findLast((message) => message.keyboard);
  assert.ok(menu);
  const choice = menu.keyboard.content.rows[0].buttons[0].action.data;
  await send(`/conv ${f.workspaceA}`, 'other');
  assert.equal(f.state.sessionFor(key), null);
  await send(choice);

  assert.deepEqual(f.adoptedSessions, []);
  assert.equal(f.harness.currentConversationWorkspace(key), f.workspaceA);
  assert.equal(f.state.sessionFor(key), null);
  assert.match(JSON.stringify(sent.at(-1)), /会话或工作区已变化/u);
});

test('the production scope exposes archiveWorkspaceSession for /sessionarchive', async (t) => {
  const f = await fixture(t, { sessionCount: 2 });
  assert.equal(typeof f.harness.archiveWorkspaceSession, 'function');

  const result = await runWorkspaceCommand('/sessionarchive session-A-2', f.harness, 'p2p:ou_owner');
  assert.deepEqual(f.archivedSessionCalls, [{ sessionId: 'session-A-2', stopActivity: false }]);
  assert.match(result.message, /^已归档会话：/);
  assert.match(result.message, /ID：session-A-2/);

  // An index only previews; the destructive call needs the explicit id.
  const preview = await runWorkspaceCommand('/sessionarchive 1', f.harness, 'p2p:ou_owner');
  assert.match(preview.message, /按序号归档只做预览/);
  assert.equal(f.archivedSessionCalls.length, 1);

  const withStop = await runWorkspaceCommand('/sessionarchive session-A --stop', f.harness, 'p2p:ou_owner');
  assert.deepEqual(f.archivedSessionCalls.at(-1), { sessionId: 'session-A', stopActivity: true });
  assert.match(withStop.message, /ID：session-A/);
});
