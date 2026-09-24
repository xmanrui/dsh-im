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
import { runModelCommand } from '../src/channels/shared/model-command.mjs';
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

for (const [change, newModel] of [
  ['model and effort', { provider: 'provider-two', model: 'model-new', reasoningEffort: 'max' }],
  ['effort only', { provider: 'provider-one', model: 'model-old', reasoningEffort: 'max' }],
]) test(`card ${change} changes apply before the first prompt only to sessions created after /new`, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-model-lifecycle-')));
  t.after(() => rm(root, { recursive: true, force: true }));

  const botId = 'bot-one';
  const conversationKey = 'direct:chat-one';
  const oldModel = { provider: 'provider-one', model: 'model-old', reasoningEffort: 'high' };
  const workspaces = await new BotWorkspaceStore(join(root, 'workspaces.json'), {
    defaultWorkspace: root,
  }).load();
  await workspaces.ensure(botId);
  await workspaces.setModel(botId, oldModel);
  const state = await new ConversationStateStore(join(root, 'state.json')).load();

  const timeline = [];
  const sessions = new Set();
  let nextSession = 0;
  const harness = {
    async createSession(options) {
      const sessionId = `session-${String.fromCharCode(97 + nextSession)}`;
      nextSession += 1;
      sessions.add(sessionId);
      timeline.push(['create', sessionId, options]);
      return sessionId;
    },
    async selectSessionModel(sessionId, selection) {
      timeline.push(['select', sessionId, selection]);
      return { selected: selection };
    },
    async sessionExists(sessionId) {
      return sessions.has(sessionId);
    },
    async ask(sessionId, text) {
      timeline.push(['ask', sessionId, text]);
      return `answer-from-${sessionId}`;
    },
  };
  const scope = createBotWorkspaceScope(harness, { botId, workspaces, state });
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'test', label: 'Test' },
    bot: { async sendText() {} },
    harness: scope.harness,
    state: scope.state,
    logger: { warn() {}, error() {} },
  });

  await bridge.accept(message('message-one', 'first prompt'));
  assert.equal(state.sessionFor(conversationKey), 'session-a');
  assert.deepEqual(timeline, [
    ['create', 'session-a', { workspace: root }],
    ['select', 'session-a', oldModel],
    ['ask', 'session-a', 'first prompt'],
  ]);

  await workspaces.setModel(botId, newModel);
  await bridge.accept(message('message-two', 'keep current session'));
  assert.equal(state.sessionFor(conversationKey), 'session-a');
  assert.deepEqual(timeline.at(-1), ['ask', 'session-a', 'keep current session']);
  assert.equal(timeline.filter(([kind]) => kind === 'create').length, 1);
  assert.equal(timeline.filter(([kind]) => kind === 'select').length, 1);

  await bridge.accept(message('message-new', '/new'));
  assert.equal(state.sessionFor(conversationKey), null);
  await bridge.accept(message('message-three', 'first prompt after new'));
  assert.equal(state.sessionFor(conversationKey), 'session-b');
  assert.deepEqual(timeline.slice(-3), [
    ['create', 'session-b', { workspace: root }],
    ['select', 'session-b', newModel],
    ['ask', 'session-b', 'first prompt after new'],
  ]);

  await workspaces.setModel(botId, null);
  await bridge.accept(message('message-new-default', '/new'));
  await bridge.accept(message('message-four', 'use host default'));
  assert.equal(state.sessionFor(conversationKey), 'session-c');
  assert.deepEqual(timeline.slice(-2), [
    ['create', 'session-c', { workspace: root }],
    ['ask', 'session-c', 'use host default'],
  ]);
  assert.equal(timeline.filter(([kind]) => kind === 'select').length, 2);
});

test('new sessions require confirmation of an explicit effort but accept a resolved default', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-effort-confirmation-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaces = await new BotWorkspaceStore(join(root, 'workspaces.json'), {
    defaultWorkspace: root,
  }).load();
  await workspaces.ensure('bot-one');
  const model = { provider: 'provider', model: 'model' };
  let selected = { ...model, reasoningEffort: 'high' };
  const harness = {
    async createSession() { return 'session-one'; },
    async selectSessionModel() { return { selected }; },
  };
  const scope = createBotWorkspaceScope(harness, { botId: 'bot-one', workspaces, state: {} });
  await workspaces.setModel('bot-one', model);
  assert.equal(await scope.harness.createSession(), 'session-one');
  await workspaces.setModel('bot-one', { ...model, reasoningEffort: 'max' });
  await assert.rejects(scope.harness.createSession(), { code: 'model-selection-mismatch' });
  selected = { ...model };
  await assert.rejects(scope.harness.createSession(), { code: 'model-selection-mismatch' });
  selected = { ...model, reasoningEffort: 'max' };
  assert.equal(await scope.harness.createSession(), 'session-one');
});

async function modelRecoveryFixture(t, savedModel, failure) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-model-recovery-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaces = await new BotWorkspaceStore(join(root, 'workspaces.json'), {
    defaultWorkspace: root,
  }).load();
  await workspaces.ensure('bot-one');
  await workspaces.ensure('bot-two');
  await workspaces.setModel('bot-one', savedModel);
  await workspaces.setAgentPreset('bot-one', 'preset-one');
  const state = await new ConversationStateStore(join(root, 'state.json')).load();
  const selection = { provider: 'provider', model: 'available', reasoningEffort: 'max' };
  const catalog = {
    groups: [{ id: 'provider', name: 'Provider', models: [{
      id: 'available', name: 'Available',
      reasoning: { efforts: [{ id: 'max', name: 'Max' }], defaultEffort: 'max' },
    }] }],
    failures: [],
  };
  const calls = [];
  let selected;
  const harness = {
    async listModels() { return catalog; },
    async createSession(options) {
      calls.push(['create', options]);
      return 'session-one';
    },
    async selectSessionModel(sessionId, model, options) {
      calls.push(['select', sessionId, model, options]);
      if (model.model === 'expired' || model.reasoningEffort === 'retired'
        || failure === 'rejected') {
        throw Object.assign(new Error('unavailable'), { code: 'model-unavailable' });
      }
      selected = model;
      return { selected: failure === 'selection-mismatch' ? { ...model, model: 'other' } : model };
    },
    async getSessionModels() {
      return {
        ...catalog, routable: true,
        current: failure === 'readback-mismatch' ? { ...selected, model: 'other' } : selected,
      };
    },
    async sessionExists() { return true; },
    async ask(sessionId, text) {
      calls.push(['ask', sessionId, text]);
      return 'recovered';
    },
  };
  const scope = createBotWorkspaceScope(harness, { botId: 'bot-one', workspaces, state });
  return { ...scope, workspaces, root, calls, selection };
}

for (const savedModel of [
  { provider: 'provider', model: 'expired' },
  { provider: 'provider', model: 'available', reasoningEffort: 'retired' },
]) test(`/model recovers an unbound bot with unavailable saved ${savedModel.model === 'expired' ? 'model' : 'effort'}`, async (t) => {
  const { harness, state, workspaces, root, calls, selection } = await modelRecoveryFixture(t, savedModel);
  const signal = new AbortController().signal;
  const key = 'direct:chat-one';
  assert.match((await runModelCommand('/models', harness, state, key)).message, /provider\/available/);
  assert.equal(calls.length, 0);

  const result = await runModelCommand('/model 1 max', harness, state, key, { signal });
  assert.match(result.message, /模型已切换为/);
  assert.equal(state.sessionFor(key), 'session-one');
  assert.deepEqual(calls, [
    ['create', { signal, workspace: root, agentPreset: 'preset-one' }],
    ['select', 'session-one', selection, { signal }],
  ]);
  assert.deepEqual(workspaces.modelFor('bot-one'), savedModel);
  assert.equal(workspaces.modelFor('bot-two'), null);

  const replies = [];
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'test', label: 'Test' },
    bot: { async sendText(_target, text) { replies.push(text); } },
    harness, state, logger: { warn() {}, error() {} },
  });
  await bridge.accept(message('recovered-prompt', 'hello'));
  assert.deepEqual(calls.at(-1), ['ask', 'session-one', 'hello']);
  assert.ok(replies.includes('recovered'));
  await bridge.accept(message('new-after-recovery', '/new'));
  assert.equal(state.sessionFor(key), null);
  await assert.rejects(harness.createSession(), { code: 'model-unavailable' });
  assert.deepEqual(calls.at(-1), ['select', 'session-one', savedModel, {}]);
});

for (const failure of ['rejected', 'selection-mismatch', 'readback-mismatch']) {
  test(`/model recovery leaves the bot unbound when the requested selection is ${failure}`, async (t) => {
    const savedModel = { provider: 'provider', model: 'expired' };
    const { harness, state, workspaces, calls, selection } = await modelRecoveryFixture(t, savedModel, failure);
    const result = await runModelCommand('/model 1 max', harness, state, 'direct:chat-one');
    assert.doesNotMatch(result.message, /模型已切换为/);
    assert.equal(state.sessionFor('direct:chat-one'), null);
    assert.deepEqual(calls.filter(([kind]) => kind === 'select'), [
      ['select', 'session-one', selection, {}],
    ]);
    assert.deepEqual(workspaces.modelFor('bot-one'), savedModel);
  });
}
