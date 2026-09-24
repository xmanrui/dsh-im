import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FeishuHarnessBridge } from '../src/channels/feishu/bridge.mjs';
import { StateStore } from '../src/channels/feishu/state-store.mjs';
import { BotWorkspaceStore, createBotWorkspaceScope } from '../src/channels/shared/bot-workspace-store.mjs';

const KEY = 'p2p:ou_owner';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-feishu-stale-menu-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceA = join(root, 'a');
  const workspaceB = join(root, 'b');
  await Promise.all([mkdir(workspaceA), mkdir(workspaceB)]);
  const workspaces = await new BotWorkspaceStore(join(root, 'workspaces.json'), {
    defaultWorkspace: workspaceA,
  }).load();
  await workspaces.ensure('bot_feishu_menu');
  const state = await new StateStore(join(root, 'state.json')).load();
  const adopted = [];
  const scope = createBotWorkspaceScope({
    async listWorkspaces() { return [workspaceA, workspaceB]; },
    async listWorkspaceSessions(workspace) {
      return { workspace, sessions: [{ sessionId: workspace === workspaceA ? 'session-A' : 'session-B' }] };
    },
    async listModels() { return { groups: [], failures: [] }; },
    async adoptWorkspaceSession(sessionId) {
      adopted.push(sessionId);
      return { sessionId, workspace: sessionId === 'session-A' ? workspaceA : workspaceB };
    },
  }, { botId: 'bot_feishu_menu', workspaces, state });
  const sent = [];
  const deliver = async (request) => {
    const id = request.path?.message_id ?? `out-${sent.length + 1}`;
    sent.push({ id, type: request.data.msg_type ?? 'interactive', content: JSON.parse(request.data.content) });
    return { code: 0, data: { message_id: id } };
  };
  const bridge = new FeishuHarnessBridge({
    client: { im: { v1: { message: { create: deliver, reply: deliver, patch: deliver } } } },
    channel: {}, harness: scope.harness, state: scope.state,
    status: { messagesReceived: 0, messagesReplied: 0, messagesRejected: 0 },
    allowedSenderOpenIds: new Set(['ou_owner']),
  });
  let incoming = 0;
  return {
    workspaceA, workspaceB, state, scope, adopted, sent,
    async send(text) {
      incoming += 1;
      await bridge.accept({
        sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
        message: {
          message_id: `in-${incoming}`, message_type: 'text', chat_type: 'p2p',
          chat_id: 'oc_chat', content: JSON.stringify({ text }),
        },
      });
      await bridge.waitForIdle();
    },
    cardId() { return sent.findLast((entry) => entry.type === 'interactive').id; },
    async click(id, action, option) {
      await bridge.onCardAction({
        operator: { open_id: 'ou_owner' },
        action: { value: { action }, ...(option ? { option } : {}) },
        context: { open_message_id: id },
      });
      await bridge.waitForIdle();
    },
  };
}

for (const entryPoint of ['main-dropdown', 'session-card', 'session-number']) {
  test(`Feishu ${entryPoint} rejects a Session choice after /conv changes its effective workspace`, async (t) => {
    const f = await fixture(t);
    await f.send(`/conv ${f.workspaceB}`);
    await f.send(entryPoint === 'main-dropdown' ? '/m' : '/sessionlist');
    const cardId = f.cardId();
    await f.send(`/conv ${f.workspaceA}`);

    if (entryPoint === 'main-dropdown') await f.click(cardId, 'session_pick', 'session-B');
    else if (entryPoint === 'session-card') await f.click(cardId, 'use:session-B');
    else await f.send('1');

    assert.deepEqual(f.adopted, []);
    assert.equal(f.state.sessionFor(KEY), null);
    assert.equal(f.scope.harness.currentConversationWorkspace(KEY), f.workspaceA);
    assert.match(JSON.stringify(f.sent.at(-1).content), /会话或工作区已变化|菜单已过期/u);
  });
}

test('Feishu still allows an explicit /sessionlist A choice while the conversation remains pinned to B', async (t) => {
  const f = await fixture(t);
  await f.send(`/conv ${f.workspaceB}`);
  await f.send(`/sessionlist ${f.workspaceA}`);

  await f.click(f.cardId(), 'use:session-A');

  assert.deepEqual(f.adopted, ['session-A']);
  assert.equal(f.state.sessionFor(KEY), 'session-A');
  assert.equal(f.scope.harness.currentConversationWorkspace(KEY), f.workspaceA);
});
