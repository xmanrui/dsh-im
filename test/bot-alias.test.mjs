import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotWorkspaceStore, createWorkspaceAwareController } from '../src/channels/shared/bot-workspace-store.mjs';
import { validateBotAlias, withBotAlias } from '../src/channels/shared/bot-alias.mjs';
import { validAliasPayload } from '../plugin-src/host/channels/shared/bot-alias-rpc.mjs';

const channels = [
  ['wecom', 'createWecomRpcHandler'], ['wecom-app', 'createWecomAppRpcHandler'],
  ['weixin', 'createWeixinRpcHandler'], ['feishu', 'createFeishuRpcHandler'],
  ['dingtalk', 'createDingtalkRpcHandler'], ['qq', 'createQqRpcHandler'],
  ['slack', 'createSlackRpcHandler'], ['telegram', 'createTelegramRpcHandler'],
  ['discord', 'createDiscordRpcHandler'], ['whatsapp', 'createWhatsappRpcHandler'],
  ['imessage', 'createIMessageRpcHandler'],
];
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-alias-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspaces.json');
  const store = await new BotWorkspaceStore(path, { defaultWorkspace: dir }).load();
  await store.ensure('bot_one', { defaultAgentPreset: 'standard' });
  await store.ensure('bot_two');
  return { dir, path, store };
}
function coreController() {
  const unavailable = () => { throw new Error('Alias changes must not touch bot lifecycle or sessions'); };
  return {
    status: () => ({ schemaVersion: 2, revision: 1, bots: ['bot_one', 'bot_two'].map(botId => ({
      botId, configured: true, connected: true, state: 'connected',
      bot: { name: '企业微信机器人', appIdMasked: 'demo••••001' },
      health: { status: 'healthy', summary: '正常', lastConnectedAt: 1234 },
      stats: { messagesReceived: 1, messagesReplied: 1 },
    })) }),
    startProvisioning: unavailable, registrationStatus: unavailable, submitVerification: unavailable,
    cancelProvisioning: unavailable, bindCredentials: unavailable, reconnectBot: unavailable,
    deleteBot: unavailable, startRegistration: unavailable, cancelRegistration: unavailable,
    disconnect: unavailable, setAccessPolicy: unavailable, approveSender: unavailable,
    revokeSender: unavailable, bindApp: unavailable, updateAppSettings: unavailable, resetCallbackSecret: unavailable, permissions: () => ({}), bindNative: unavailable,
  };
}
function aware(store) {
  return createWorkspaceAwareController(coreController(), {
    workspaces: store, stateFor() { throw new Error('Session state must not be accessed'); },
  });
}

test('alias validation accepts clearing and rejects malformed payloads', () => {
  assert.equal(validateBotAlias('  客服助手  '), '客服助手');
  assert.equal(validateBotAlias('  '), '');
  for (const alias of [null, undefined, {}, 1, 'x'.repeat(81), 'foo\nbar', 'a\u0000']) {
    assert.throws(() => validateBotAlias(alias));
    assert.equal(validAliasPayload({ botId: 'bot_one', alias }), false);
  }
  assert.equal(validAliasPayload({ botId: 'bot_one', alias: '' }), true);
  assert.equal(validAliasPayload({ botId: '../bot', alias: 'x' }), false);
  assert.equal(validAliasPayload({ botId: 'bot_one', alias: 'x', secret: 'extra' }), false);
});

test('aliases persist independently, restore the original name, and leave all other settings unchanged', async (t) => {
  const { path, store } = await fixture(t);
  const before = JSON.parse(await readFile(path, 'utf8'));
  const controller = aware(store);
  const status = await controller.status();
  const generation = store.generationFor('bot_one');
  const incarnation = store.incarnationFor('bot_one');
  const renamed = await controller.updateAlias('bot_one', ' 客服助手 ');
  assert.deepEqual(renamed.bots[0].bot, { ...status.bots[0].bot, name: '客服助手', originalName: '企业微信机器人', alias: '客服助手' });
  assert.deepEqual(renamed.bots[1], status.bots[1]);
  assert.deepEqual({ ...renamed.bots[0], bot: status.bots[0].bot }, status.bots[0]);
  const { aliases, ...stored } = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(stored, before);
  assert.deepEqual(aliases, { bot_one: '客服助手' });
  assert.equal(store.generationFor('bot_one'), generation);
  assert.equal(store.incarnationFor('bot_one'), incarnation);
  const reloaded = await new BotWorkspaceStore(path).load();
  assert.equal(reloaded.aliasFor('bot_one'), '客服助手');
  // Platform metadata stays authoritative when the alias is cleared.
  assert.deepEqual(withBotAlias({ name: '客服助手', alias: '客服助手', originalName: '平台新名称' }, ''), { name: '平台新名称' });
  await store.setAgentPreset('bot_two', 'minimal');
  assert.equal((await new BotWorkspaceStore(path).load()).aliasFor('bot_one'), '客服助手');
  const restored = await controller.updateAlias('bot_one', '');
  assert.deepEqual(restored.bots[0].bot, status.bots[0].bot);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(path, 'utf8')), 'aliases'), false);
});

test('failed writes and failed public projection do not change the live alias', async (t) => {
  const { path, store } = await fixture(t);
  const controller = aware(store);
  await store.setAlias('bot_one', '原别名');
  const before = await readFile(path, 'utf8');
  await assert.rejects(controller.updateAlias('bot_one', '失败', () => { throw new Error('projection failed'); }), /projection failed/);
  assert.equal(await readFile(path, 'utf8'), before);
  await rm(path);
  await mkdir(path);
  await assert.rejects(store.setAlias('bot_one', '不应保存'));
  assert.equal(store.aliasFor('bot_one'), '原别名');
  await rm(path, { recursive: true });
  await writeFile(path, before);
  await store.setAlias('bot_one', '重试成功');
  assert.equal((await new BotWorkspaceStore(path).load()).aliasFor('bot_one'), '重试成功');
});

test('old or damaged alias data does not affect bot settings; removed bot aliases are cleaned up', async (t) => {
  const { path, store } = await fixture(t);
  const old = await readFile(path, 'utf8');
  await new BotWorkspaceStore(path).load();
  assert.equal(await readFile(path, 'utf8'), old);
  await writeFile(path, JSON.stringify({ ...JSON.parse(old), aliases: { bot_one: {}, bot_two: '测试', '../bad': 'bad' } }));
  const reloaded = await new BotWorkspaceStore(path).load();
  assert.equal(reloaded.aliasFor('bot_one'), '');
  assert.equal(reloaded.aliasFor('bot_two'), '测试');
  const incarnation = reloaded.incarnationFor('bot_two');
  await reloaded.remove('bot_two');
  await reloaded.ensure('bot_two');
  await assert.rejects(reloaded.setAlias('bot_two', '过期写入', { incarnation }), { code: 'workspace-bot-not-found' });
  assert.equal(reloaded.aliasFor('bot_two'), '');
  await assert.rejects(store.setAlias('missing', 'x'), { code: 'workspace-bot-not-found' });
});

for (const [channel, factory] of channels) {
  test(`${channel}: alias RPC preserves connection status and original name through client normalization`, async (t) => {
    const { store } = await fixture(t);
    const { [factory]: makeHandler } = await import(`../plugin-src/host/channels/${channel}/rpc.mjs`);
    const api = await import(`../plugin-src/client/channels/${channel}/api.js`);
    const handler = makeHandler(aware(store));
    const result = await handler('bot.alias.set', { botId: 'bot_one', alias: '客服助手' });
    assert.equal(result.ok, true, JSON.stringify(result));
    const normalize = api.normalizeBotsSnapshot ?? api.normalizeSnapshot;
    const normalized = normalize(result.value);
    assert.equal(normalized.bots[0].bot.name, '客服助手');
    assert.equal(normalized.bots[0].bot.originalName, '企业微信机器人');
    assert.equal(normalized.bots[0].bot.alias, '客服助手');
    assert.equal(normalized.bots[0].connected, true);
    assert.equal(normalized.bots[1].bot.name, '企业微信机器人');
    const restored = await handler('bot.alias.set', { botId: 'bot_one', alias: '' });
    assert.equal(restored.ok, true);
    assert.equal(normalize(restored.value).bots[0].bot.name, '企业微信机器人');
    assert.equal((await handler('bot.alias.set', { botId: 'bot_one', alias: null })).ok, false);
  });
}
