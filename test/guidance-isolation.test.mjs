import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BotWorkspaceStore,
  createBotWorkspaceScope,
  createContextEnhancementProvider,
  createWorkspaceAwareController,
} from '../src/channels/shared/bot-workspace-store.mjs';
import {
  captureContextEnhancement,
  enhanceContextContent,
  overlayConversationGuidance,
} from '../src/channels/shared/context-enhancement.mjs';
import { runGuidanceCommand } from '../src/channels/shared/guidance-command.mjs';
import {
  TOKEN_BOT_ENDPOINTS,
  createTokenBotRpcHandler,
} from '../plugin-src/host/channels/shared/rpc.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-guidance-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const defaultWorkspace = join(root, 'default');
  await mkdir(defaultWorkspace);
  const path = join(root, 'workspaces.json');
  return { path, defaultWorkspace };
}

function enabledGroupConfig(guidance = '默认群提示') {
  return {
    group: { enabled: true, fields: ['senderId'], guidance },
    direct: { enabled: false, fields: ['senderId'], guidance: '' },
  };
}

test('conversation guidance isolation is off by default and overlays per chat when enabled', async (t) => {
  const { path, defaultWorkspace } = await fixture(t);
  const store = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await store.ensure('bot_guide');
  await store.setContextEnhancement('bot_guide', enabledGroupConfig());
  const scope = createBotWorkspaceScope({}, {
    botId: 'bot_guide',
    workspaces: store,
    state: { async clearSessions() {} },
  });
  const provider = createContextEnhancementProvider(store, 'bot_guide');

  assert.equal(store.isolateConversationGuidanceFor('bot_guide'), false);
  assert.equal(scope.harness.isolateConversationGuidance(), false);
  assert.equal(store.decorateStatus({
    bots: [{ botId: 'bot_guide' }],
  }).bots[0].isolateConversationGuidance, false);

  const shared = await runGuidanceCommand('/guidance 全机器人提示', scope.harness, 'group:a');
  assert.match(shared.message, /已更新整台机器人的群聊增强提示词/);
  assert.equal(store.contextEnhancementFor('bot_guide').group.guidance, '全机器人提示');
  assert.equal('conversationGuidances' in JSON.parse(await readFile(path, 'utf8')), false);

  const capturedShared = captureContextEnhancement(provider, 'group', 'group:a');
  assert.equal(capturedShared.config.guidance, '全机器人提示');
  const capturedB = captureContextEnhancement(provider, 'group', 'group:b');
  assert.equal(capturedB.config.guidance, '全机器人提示');

  await store.setIsolateConversationGuidance('bot_guide', true);
  assert.equal(store.isolateConversationGuidanceFor('bot_guide'), true);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).isolateConversationGuidances.bot_guide, true);

  const isolated = await runGuidanceCommand('/guidance 只给A群', scope.harness, 'group:a');
  assert.match(isolated.message, /当前聊天的增强提示词已更新/);
  assert.equal(store.contextEnhancementFor('bot_guide').group.guidance, '全机器人提示');
  assert.equal(store.conversationGuidanceFor('bot_guide', 'group:a'), '只给A群');
  assert.equal(store.conversationGuidanceFor('bot_guide', 'group:b'), undefined);

  const aSnap = captureContextEnhancement(provider, 'group', 'group:a');
  const bSnap = captureContextEnhancement(provider, 'group', 'group:b');
  assert.equal(aSnap.config.guidance, '只给A群');
  assert.equal(bSnap.config.guidance, '全机器人提示');
  assert.match(enhanceContextContent('你好', aSnap, () => ({ senderId: 'u1' })), /只给A群/);
  assert.match(enhanceContextContent('你好', bSnap, () => ({ senderId: 'u1' })), /全机器人提示/);
  assert.doesNotMatch(enhanceContextContent('你好', bSnap, () => ({ senderId: 'u1' })), /只给A群/);

  const frozen = captureContextEnhancement({
    botId: 'bot_guide',
    getSettings: () => store.contextEnhancementFor('bot_guide'),
  }, 'group');
  assert.equal(frozen.config.guidance, '全机器人提示');
  assert.equal(
    overlayConversationGuidance(frozen, provider, 'group:a').config.guidance,
    '只给A群',
  );

  const none = await runGuidanceCommand('/guidance --none', scope.harness, 'group:a');
  assert.match(none.message, /当前聊天已改为不附加增强提示词/);
  assert.equal(store.conversationGuidanceFor('bot_guide', 'group:a'), '');
  const emptySnap = captureContextEnhancement(provider, 'group', 'group:a');
  assert.equal(emptySnap.config.guidance, '');
  assert.doesNotMatch(
    enhanceContextContent('你好', emptySnap, () => ({ senderId: 'u1' })),
    /dsh_im_source_guidance/,
  );

  const cleared = await runGuidanceCommand('/guidance --clear', scope.harness, 'group:a');
  assert.match(cleared.message, /当前聊天已改回跟随默认增强提示词/);
  assert.equal(store.conversationGuidanceFor('bot_guide', 'group:a'), undefined);

  await store.setIsolateConversationGuidance('bot_guide', false);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(store.isolateConversationGuidanceFor('bot_guide'), false);
  assert.equal('isolateConversationGuidances' in saved, false);
  assert.equal('conversationGuidances' in saved, false);
  assert.equal(captureContextEnhancement(provider, 'group', 'group:a').config.guidance, '全机器人提示');
});

test('guidance isolation RPC toggles the public bot flag without clearing sessions', async (t) => {
  const { path, defaultWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_one');
  let cleared = 0;
  const controller = createWorkspaceAwareController({
    status() { return { bots: [{ botId: 'bot_one', connected: true }] }; },
    bindCredentials() { return this.status(); },
    reconnectBot() { return this.status(); },
    deleteBot() { return { bots: [] }; },
  }, {
    workspaces,
    stateFor: async () => ({
      async clearSessions() { cleared += 1; },
    }),
  });
  const handler = createTokenBotRpcHandler(controller, { channel: 'Telegram' });

  const enabled = await handler(TOKEN_BOT_ENDPOINTS.setIsolateConversationGuidance, {
    botId: 'bot_one', isolateConversationGuidance: true,
  });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.value.bots[0].isolateConversationGuidance, true);
  assert.equal(cleared, 0);

  const invalid = await handler(TOKEN_BOT_ENDPOINTS.setIsolateConversationGuidance, {
    botId: 'bot_one', isolateConversationGuidance: 'yes',
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'bad-request');

  const disabled = await handler(TOKEN_BOT_ENDPOINTS.setIsolateConversationGuidance, {
    botId: 'bot_one', isolateConversationGuidance: false,
  });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.value.bots[0].isolateConversationGuidance, false);
  assert.equal(cleared, 0);
});

test('capture still returns null when the bot-level group switch is off', async (t) => {
  const { path, defaultWorkspace } = await fixture(t);
  const store = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await store.ensure('bot_off');
  await store.setIsolateConversationGuidance('bot_off', true);
  await store.setConversationGuidance('bot_off', 'group:a', '不该注入');
  const provider = createContextEnhancementProvider(store, 'bot_off');
  assert.equal(captureContextEnhancement(provider, 'group', 'group:a'), null);
});
