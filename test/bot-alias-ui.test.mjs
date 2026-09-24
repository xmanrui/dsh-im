import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import TestRenderer from 'react-test-renderer';
import { BotName } from '../plugin-src/client/bot-alias.js';
import { withBotAlias } from '../src/channels/shared/bot-alias.mjs';

const { act, create } = TestRenderer;
const text = node => typeof node === 'string' ? node : node?.children?.map(text).join('') ?? '';
const button = (root, label) => root.findAllByType('button').find(node => text(node) === label || node.props['aria-label'] === label);
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); }

const channels = [
  ['wecom', 'WecomSettingsTab'], ['wecom-app', 'WecomAppSettingsTab'],
  ['weixin', 'WeixinSettingsTab'], ['feishu', 'FeishuSettingsTab'],
  ['dingtalk', 'DingtalkSettingsTab'], ['qq', 'QqSettingsTab'],
  ['slack', 'SlackSettingsTab'], ['telegram', 'TelegramSettingsTab'],
  ['discord', 'DiscordSettingsTab'], ['whatsapp', 'WhatsappSettingsTab'], ['imessage', 'IMessageSettingsTab'],
];
function mockWindow(t) {
  const previous = globalThis.window;
  globalThis.window = {
    setInterval() { return 1; }, clearInterval() {}, setTimeout() { return 1; }, clearTimeout() {},
    requestAnimationFrame(callback) { callback(); return 1; }, cancelAnimationFrame() {},
  };
  return () => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; };
}
for (const [channel, component] of channels) {
  test(`${channel}: saving and restoring from the card uses only alias RPC and updates names immediately`, async (t) => {
    const restoreWindow = mockWindow(t);
    const { [component]: Settings } = await import(`../plugin-src/client/channels/${channel}/index.js`);
    const bots = [0, 1].map(index => ({
      botId: `bot_${index}`, configured: true, connected: true, state: 'connected', workspace: '/workspace',
      bot: { name: `Original ${index}`, appIdMasked: 'demo•••', accountIdMasked: 'demo•••', idMasked: 'demo•••' },
      health: { status: 'healthy', summary: 'Connected', lastCheckedAt: 1700000000000 },
    }));
    const calls = [];
    const rpcCall = async (endpoint, payload) => {
      if (endpoint !== 'connection.status') {
        calls.push([endpoint, payload]);
        assert.equal(endpoint, 'bot.alias.set');
        const bot = bots.find(bot => bot.botId === payload.botId);
        bot.bot = withBotAlias(bot.bot, payload.alias);
      }
      return { ok: true, value: { schemaVersion: 2, revision: 1, bots: structuredClone(bots) } };
    };
    let renderer;
    await act(async () => { renderer = create(React.createElement(Settings, { rpcCall })); await flush(); });
    t.after(async () => { await act(async () => { renderer.unmount(); await flush(); }); restoreWindow(); });
    const root = renderer.root;
    await act(async () => { button(root, '修改别名').props.onClick(); });
    assert.equal(root.findAllByType('dialog').length, 1);
    assert.match(text(root.findByType('dialog')), /Original 0/);
    await act(async () => { root.findByType('dialog').findByType('input').props.onChange({ target: { value: '客服助手' } }); });
    await act(async () => { button(root, '保存').props.onClick(); await flush(); });
    assert.equal(root.findAllByType('dialog').length, 0);
    assert.equal(root.findAllByType(BotName)[0].props.bot.name, '客服助手');
    assert.equal(root.findAllByType(BotName)[1].props.bot.name, 'Original 1');
    await act(async () => { button(root, '修改别名').props.onClick(); });
    assert.match(text(root.findByType('dialog')), /Original 0/);
    await act(async () => { button(root, '恢复原名称').props.onClick(); await flush(); });
    assert.equal(root.findAllByType(BotName)[0].props.bot.name, 'Original 0');
    assert.deepEqual(calls, [
      ['bot.alias.set', { botId: 'bot_0', alias: '客服助手' }],
      ['bot.alias.set', { botId: 'bot_0', alias: '' }],
    ]);
  });
}

test('alias dialog keeps the draft on failure and cancellation never saves', async () => {
  let calls = 0;
  let renderer;
  await act(async () => { renderer = create(React.createElement(BotName, {
    bot: { name: 'Original' }, onSave: async () => { calls++; throw new Error('磁盘写入失败'); },
  })); });
  const root = renderer.root;
  await act(async () => { button(root, '修改别名').props.onClick(); });
  await act(async () => { root.findByType('input').props.onChange({ target: { value: '新别名' } }); });
  await act(async () => { button(root, '保存').props.onClick(); await flush(); });
  assert.equal(root.findByType('input').props.value, '新别名');
  assert.equal(text(root.findByProps({ role: 'alert' })), '磁盘写入失败');
  assert.equal(text(root.findAllByType('h3')[0]), 'Original');
  await act(async () => { button(root, '取消').props.onClick(); });
  assert.equal(calls, 1);
  assert.equal(root.findAllByType('dialog').length, 0);
  await act(async () => renderer.unmount());
});
