import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BotWorkspaceStore,
  createBotWorkspaceScope,
} from '../src/channels/shared/bot-workspace-store.mjs';
import { ConversationStateStore } from '../src/channels/shared/conversation-state-store.mjs';
import { HarnessRpcError } from '../src/channels/shared/harness-client.mjs';
import { TextHarnessBridge } from '../src/channels/shared/text-harness-bridge.mjs';

function message(messageId, content) {
  return {
    messageId,
    senderId: 'actor-one',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-one',
    content,
    addressed: true,
    replyTarget: { id: 'chat-one' },
  };
}

test('/preset changes only the sessions created after /new and --default follows Host', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-preset-lifecycle-')));
  t.after(() => rm(root, { recursive: true, force: true }));

  const botId = 'bot-one';
  const conversationKey = 'direct:chat-one';
  const workspaces = await new BotWorkspaceStore(join(root, 'workspaces.json'), {
    defaultWorkspace: root,
  }).load();
  await workspaces.ensure(botId, { defaultAgentPreset: 'preset-old' });
  const state = await new ConversationStateStore(join(root, 'state.json')).load();

  const creations = [];
  const asks = [];
  const sessions = new Set();
  const harness = {
    async createSession(options) {
      const sessionId = `session-${String.fromCharCode(97 + creations.length)}`;
      creations.push({ sessionId, options });
      sessions.add(sessionId);
      return sessionId;
    },
    async sessionExists(sessionId) {
      return sessions.has(sessionId);
    },
    async ask(sessionId, text) {
      asks.push({ sessionId, text });
      return `answer-from-${sessionId}`;
    },
  };
  const agentPresetCatalog = {
    defaultId: 'preset-old',
    items: [
      { id: 'preset-old', label: 'Old preset' },
      { id: 'preset-new', label: 'New preset' },
    ],
  };
  const scope = createBotWorkspaceScope(harness, {
    botId,
    workspaces,
    state,
    agentPresetCatalog,
  });
  const sent = [];
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'test', label: 'Test' },
    bot: { async sendText(_target, text) { sent.push(text); } },
    harness: scope.harness,
    state: scope.state,
    logger: { warn() {}, error() {} },
  });

  await bridge.accept(message('message-one', 'first prompt'));
  assert.equal(state.sessionFor(conversationKey), 'session-a');
  assert.deepEqual(creations, [{
    sessionId: 'session-a',
    options: { workspace: root, agentPreset: 'preset-old' },
  }]);

  await bridge.accept(message('message-list', '/presetlist'));
  assert.match(sent.at(-1), /2\. New preset（preset-new）/u);

  await bridge.accept(message('message-preset', '/preset 2'));
  assert.equal(workspaces.agentPresetFor(botId), 'preset-new');
  assert.match(sent.at(-1), /已有会话不变/u);
  assert.equal(state.sessionFor(conversationKey), 'session-a');
  assert.equal(creations.length, 1, '/preset itself must not create a session');

  await bridge.accept(message('message-two', 'still in the current chat'));
  assert.equal(creations.length, 1, 'the current chat must reuse session A');
  assert.equal(state.sessionFor(conversationKey), 'session-a');

  await bridge.accept(message('message-new', '/new'));
  assert.equal(state.sessionFor(conversationKey), null);
  assert.equal(creations.length, 1, '/new itself must not create a session');

  await bridge.accept(message('message-three', 'first prompt after /new'));
  assert.equal(state.sessionFor(conversationKey), 'session-b');
  assert.deepEqual(creations, [
    {
      sessionId: 'session-a',
      options: { workspace: root, agentPreset: 'preset-old' },
    },
    {
      sessionId: 'session-b',
      options: { workspace: root, agentPreset: 'preset-new' },
    },
  ]);

  await bridge.accept(message('message-default', '/preset --default'));
  assert.equal(workspaces.agentPresetFor(botId), null);
  assert.equal(state.sessionFor(conversationKey), 'session-b');
  assert.equal(creations.length, 2, '--default itself must not create a session');

  await bridge.accept(message('message-new-default', '/new'));
  await bridge.accept(message('message-four', 'first prompt using Host default'));
  assert.equal(state.sessionFor(conversationKey), 'session-c');
  assert.deepEqual(creations.at(-1), {
    sessionId: 'session-c',
    options: { workspace: root },
  });
  assert.deepEqual(asks, [
    { sessionId: 'session-a', text: 'first prompt' },
    { sessionId: 'session-a', text: 'still in the current chat' },
    { sessionId: 'session-b', text: 'first prompt after /new' },
    { sessionId: 'session-c', text: 'first prompt using Host default' },
  ]);
  assert.equal(sent.at(-1), 'answer-from-session-c');
});

test('a missing preset is recoverable by selecting an available preset and starting a new Session', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-preset-recovery-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const botId = 'bot-one';
  const key = 'direct:chat-one';
  const workspaces = await new BotWorkspaceStore(join(root, 'workspaces.json'), {
    defaultWorkspace: root,
  }).load();
  await workspaces.ensure(botId, { defaultAgentPreset: 'preset-old' });
  const state = await new ConversationStateStore(join(root, 'state.json')).load();
  const sessions = new Map();
  const availablePresets = new Set(['preset-old', 'preset-new']);
  const harness = {
    async createSession({ agentPreset }) {
      const id = `session-${sessions.size + 1}`;
      sessions.set(id, agentPreset);
      return id;
    },
    async sessionExists(id) { return sessions.has(id); },
    async ask(id) {
      if (!availablePresets.has(sessions.get(id))) {
        throw new HarnessRpcError('session.prompt', {
          code: 'agent-preset/not-found', message: 'The Session preset was removed',
        });
      }
      return `answer-from-${id}`;
    },
  };
  const scope = createBotWorkspaceScope(harness, {
    botId,
    workspaces,
    state,
    agentPresetCatalog: () => ({
      defaultId: 'preset-new',
      items: [...availablePresets].map((id) => ({ id, label: id })),
    }),
  });
  const sent = [];
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'test', label: 'Test' },
    bot: { async sendText(_target, text) { sent.push(text); } },
    harness: scope.harness,
    state: scope.state,
    logger: { warn() {}, error() {} },
  });

  await bridge.accept(message('initial', 'first prompt'));
  assert.equal(sent.at(-1), 'answer-from-session-1');
  availablePresets.delete('preset-old');
  await bridge.accept(message('missing', 'continue the original Session'));
  assert.equal(bridge.status.lastMessageError.code, 'PRESET_UNAVAILABLE');
  assert.equal(bridge.status.lastMessageError.reason, 'AGENT_PRESET_NOT_FOUND');
  assert.equal(state.sessionFor(key), 'session-1');

  await bridge.accept(message('list', '/presetlist'));
  assert.match(sent.at(-1), /1\. preset-new/u);
  await bridge.accept(message('select', '/preset 1'));
  assert.equal(workspaces.agentPresetFor(botId), 'preset-new');
  await bridge.accept(message('before-new', 'retry without a new Session'));
  assert.equal(bridge.status.lastMessageError.code, 'PRESET_UNAVAILABLE');
  assert.equal(state.sessionFor(key), 'session-1');
  assert.equal(sessions.size, 1);

  await bridge.accept(message('new', '/new'));
  assert.equal(state.sessionFor(key), null);
  await bridge.accept(message('recovered', 'retry in the new Session'));
  assert.equal(state.sessionFor(key), 'session-2');
  assert.equal(sessions.get('session-2'), 'preset-new');
  assert.equal(sent.at(-1), 'answer-from-session-2');
  assert.equal(bridge.status.lastMessageError, null);
  assert.equal(sessions.get('session-1'), 'preset-old');
});
