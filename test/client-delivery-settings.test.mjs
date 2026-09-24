import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer from 'react-test-renderer';

import {
  ACCESS_CHANNEL_DEFINITIONS,
  ACCESS_POLICY_ENDPOINT,
} from '../plugin-src/client/access-policy-settings.js';
import {
  BOT_SETTINGS_TABS,
  DELIVERY_CHANNEL_DEFINITIONS,
  DELIVERY_ENDPOINTS,
  DELIVERY_RPC_CHANNEL,
  DeliveryTargetSettingsPage,
  FEISHU_BOT_SETTINGS_TABS,
  botSettingsTabsForChannel,
} from '../plugin-src/client/delivery-settings.js';
import { en, setImTranslator } from '../plugin-src/client/i18n.js';
import { FEISHU_ENDPOINTS } from '../plugin-src/client/channels/feishu/api.js';
import { BotCard as FeishuBotCard } from '../plugin-src/client/channels/feishu/index.js';
import { AccountCard as WeixinAccountCard } from '../plugin-src/client/channels/weixin/index.js';
import { AccountCard as DingtalkAccountCard } from '../plugin-src/client/channels/dingtalk/index.js';
import { AccountCard as WecomAccountCard } from '../plugin-src/client/channels/wecom/index.js';
import { AccountCard as QqAccountCard } from '../plugin-src/client/channels/qq/index.js';
import { SlackAccountCard } from '../plugin-src/client/channels/slack/index.js';
import { TelegramAccountCard } from '../plugin-src/client/channels/telegram/index.js';
import { DiscordAccountCard } from '../plugin-src/client/channels/discord/index.js';
import { WhatsappAccountCard } from '../plugin-src/client/channels/whatsapp/index.js';
import { IMessageAccountCard } from '../plugin-src/client/channels/imessage/index.js';
import { IMSettingsTab } from '../plugin-src/client/index.js';
import { BotSettingsContext } from '../plugin-src/client/channel-card-meta.js';
import { AccountCard as WecomAppAccountCard } from '../plugin-src/client/channels/wecom-app/index.js';

const { act, create } = TestRenderer;

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node?.props?.children ?? '');
}

function button(root, label) {
  return root.findAllByType('button').find((entry) => textOf(entry) === label);
}

function accessHelpButtons(root) {
  return root.findAll((entry) => entry.type === 'button'
    && String(entry.props['aria-label'] ?? '').endsWith('查看访问权限说明'));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function mount(t, props) {
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(DeliveryTargetSettingsPage, props));
    await flush();
  });
  t.after(async () => {
    await act(async () => {
      renderer.unmount();
      await flush();
    });
  });
  return renderer;
}

const connectedAccount = Object.freeze({
  botId: 'bot_feishu_01',
  botName: '通知机器人',
  connected: true,
  accessPolicy: Object.freeze({
    direct: Object.freeze({
      mode: 'open',
      open: Object.freeze({
        defaultCanExecuteCommands: true,
        commandPermissionOverrides: Object.freeze([]),
      }),
      allowlist: Object.freeze({ users: Object.freeze([]) }),
    }),
    group: Object.freeze({
      mode: 'open',
      open: Object.freeze({
        defaultCanExecuteCommands: false,
        commandPermissionOverrides: Object.freeze([]),
      }),
      allowlist: Object.freeze({ users: Object.freeze([]) }),
    }),
  }),
});

test('delivery settings define only the ten supported IM channel routes', () => {
  assert.deepEqual(BOT_SETTINGS_TABS, [
    { id: 'delivery', label: '投递设置' },
    { id: 'access', label: '访问设置' },
  ]);
  assert.deepEqual(FEISHU_BOT_SETTINGS_TABS, [
    { id: 'delivery', label: '投递设置' },
    { id: 'access', label: '访问设置' },
    { id: 'group', label: '群聊' },
  ]);
  assert.equal(botSettingsTabsForChannel('weixin'), BOT_SETTINGS_TABS);
  assert.equal(botSettingsTabsForChannel('dingtalk'), BOT_SETTINGS_TABS);
  assert.equal(botSettingsTabsForChannel('feishu'), FEISHU_BOT_SETTINGS_TABS);
  assert.equal(DELIVERY_RPC_CHANNEL, '/dsh-im-delivery');
  assert.deepEqual(Object.keys(DELIVERY_CHANNEL_DEFINITIONS), [
    'weixin', 'feishu', 'dingtalk', 'wecom', 'wecomApp', 'qq',
    'slack', 'telegram', 'discord', 'whatsapp', 'imessage',
  ]);
  assert.deepEqual(
    DELIVERY_CHANNEL_DEFINITIONS.feishu.fields.user.map((field) => field.key),
    ['openId'],
  );
  assert.deepEqual(
    DELIVERY_CHANNEL_DEFINITIONS.dingtalk.fields.group.map((field) => field.key),
    ['openConversationId'],
  );
  assert.deepEqual(
    DELIVERY_CHANNEL_DEFINITIONS.telegram.fields.topic.map((field) => field.key),
    ['chatId', 'messageThreadId'],
  );
  assert.equal('office' in DELIVERY_CHANNEL_DEFINITIONS, false);
  assert.deepEqual(Object.keys(ACCESS_CHANNEL_DEFINITIONS), Object.keys(DELIVERY_CHANNEL_DEFINITIONS));
  assert.equal(ACCESS_CHANNEL_DEFINITIONS.weixin.groupSupported, false);
});

test('robot card settings toggle expands in place and more settings preserves the bot scope', () => {
  const account = {
    botId: 'bot_card_01',
    connected: true,
    state: 'connected',
    bot: {
      name: '机器人',
      idMasked: 'id••01',
      username: 'robot',
      appIdMasked: 'app••01',
      accountIdMasked: 'account••01',
      clientIdMasked: 'client••01',
    },
    health: { lastCheckedAt: null, summary: '运行正常' },
    workspace: null,
  };
  const cards = [
    ['feishu', FeishuBotCard, { connection: account }],
    ['weixin', WeixinAccountCard, { account }],
    ['dingtalk', DingtalkAccountCard, { account }],
    ['wecom', WecomAccountCard, { account }],
    ['wecomApp', WecomAppAccountCard, { account }],
    ['qq', QqAccountCard, { account }],
    ['slack', SlackAccountCard, { account }],
    ['telegram', TelegramAccountCard, { account }],
    ['discord', DiscordAccountCard, { account }],
    ['whatsapp', WhatsappAccountCard, { account }],
    ['imessage', IMessageAccountCard, { account }],
  ];

  for (const [channel, Card, props] of cards) {
    const markup = renderToStaticMarkup(React.createElement(Card, props));
    assert.equal((markup.match(/aria-label="更多机器人设置"/g) ?? []).length, 1);
    assert.match(markup, /class="dim-botCardTools"/);
    assert.match(markup, new RegExp(`data-delivery-channel="${channel}"`));
    assert.match(markup, /aria-label="展开该账号的设置" aria-expanded="false"/);
    let renderer;
    const opened = [];
    act(() => { renderer = create(React.createElement(BotSettingsContext.Provider, {
      value: { openBotSettings: (value) => opened.push(value) },
    }, React.createElement(Card, props))); });
    try {
      const header = renderer.root.findByProps({ className: 'dim-collapsibleHead' });
      const tools = header.findByProps({ className: 'dim-botCardTools' });
      const toggle = tools.findByType('button');
      const healthBefore = textOf(tools.findByProps({ className: 'dim-botHealthGroup' }));
      assert.equal(textOf(toggle), '', `${channel}: the entry has no visible settings label`);
      assert.equal(header.findAllByProps({ 'aria-label': '更多机器人设置' }).length, 0);
      assert.equal(toggle.props['aria-controls'], renderer.root.findByProps({ className: 'dim-collapsibleBody' }).props.id);
      let stopped = false;
      act(() => toggle.props.onClick({ stopPropagation() { stopped = true; } }));
      assert.ok(stopped, `${channel}: the button must not also toggle the header`);
      assert.equal(toggle.props['aria-expanded'], 'true');
      assert.equal(opened.length, 0, `${channel}: expanding must not navigate away`);
      assert.equal(textOf(tools.findByProps({ className: 'dim-botHealthGroup' })), healthBefore);
      const toolbar = renderer.root.findByProps({ className: 'dim-accountSettingsHeader' });
      const more = toolbar.findByProps({ 'aria-label': '更多机器人设置' });
      assert.equal(textOf(more), '更多设置');
      act(() => more.props.onClick());
      assert.equal(opened.length, 1);
      assert.equal(opened[0].channel, channel);
      assert.equal(opened[0].botId, account.botId);
      act(() => toggle.props.onClick({ stopPropagation() {} }));
      assert.equal(toggle.props['aria-expanded'], 'false');
    } finally {
      act(() => renderer.unmount());
    }
  }
});

test('expanded card more settings opens a bot-scoped page and returns in place', async (t) => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    requestAnimationFrame(callback) { callback(); return 1; },
    cancelAnimationFrame() {},
  };
  const bot = {
    botId: 'wx_stable_bot',
    connected: true,
    configured: true,
    state: 'connected',
    bot: { name: '微信通知助手', accountIdMasked: 'wx••01' },
    health: { status: 'healthy', summary: '微信连接正常', lastCheckedAt: Date.now() },
    accessPolicy: connectedAccount.accessPolicy,
  };
  const deliveryCalls = [];
  const renderer = await (async () => {
    let mounted;
    await act(async () => {
      mounted = create(React.createElement(IMSettingsTab, {
        browserLocation: { href: 'http://localhost:9527/settings' },
        weixinRpcCall: async (endpoint) => {
          assert.equal(endpoint, 'connection.status');
          return { ok: true, value: { revision: 1, bots: [bot] } };
        },
        deliveryRpcCall: async (endpoint, payload) => {
          deliveryCalls.push({ endpoint, payload });
          return { ok: true, value: { targets: [] } };
        },
        updateRpcCall: async () => ({
          ok: true,
          value: { runningVersion: '4.0.1', canInstall: false },
        }),
      }));
      await flush();
    });
    return mounted;
  })();
  t.after(async () => {
    await act(async () => { renderer.unmount(); await flush(); });
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });

  const card = renderer.root.findByProps({ 'data-bot-id': 'wx_stable_bot' });
  act(() => card.findByProps({ 'aria-label': '展开该账号的设置' }).props.onClick({ stopPropagation() {} }));
  await act(async () => {
    card.findByProps({ 'aria-label': '更多机器人设置' }).props.onClick();
    await flush();
  });
  const page = renderer.root.findByProps({ className: 'dim-deliveryPage' });
  assert.match(textOf(page), /微信通知助手/);
  assert.doesNotMatch(textOf(page), /调用标识/);
  assert.equal(
    page.findByProps({ className: 'dim-deliveryHeader' }).findAllByType('h2').length,
    0,
  );
  const settingsTabs = page.findAllByProps({ role: 'tab' });
  assert.deepEqual(settingsTabs.map(textOf), ['投递设置', '访问设置']);
  const settingsTab = settingsTabs[0];
  const settingsPanel = page.findByProps({ role: 'tabpanel' });
  assert.equal(textOf(settingsTab), '投递设置');
  assert.equal(settingsTab.props['aria-selected'], true);
  assert.equal(settingsTab.props.tabIndex, 0);
  assert.equal(settingsTab.props['aria-controls'], settingsPanel.props.id);
  assert.equal(settingsPanel.props['aria-labelledby'], settingsTab.props.id);
  const identity = settingsPanel.findByProps({ className: 'dim-deliveryIdentity' });
  assert.ok(identity);
  assert.ok(settingsPanel.findByProps({ className: 'dim-deliveryTargets' }));
  assert.equal(page.findByProps({ className: 'dim-botSettingsTabsBar' }).findAllByType('a').length, 0);
  assert.equal(
    textOf(identity.findByType('h2')),
    '微信通知助手',
  );
  const docsLink = identity.findByProps({ className: 'dim-deliveryDocsLink' });
  assert.equal(textOf(docsLink), '使用文档↗');
  assert.equal(
    docsLink.props.href,
    'https://github.com/xmanrui/dsh-im/blob/main/PROACTIVE_DELIVERY.md',
  );
  assert.equal(docsLink.props.target, '_blank');
  assert.equal(docsLink.props.rel, 'noopener noreferrer');
  assert.equal(page.findByType('code').props.children, 'wx_stable_bot');
  assert.deepEqual(deliveryCalls, [{
    endpoint: DELIVERY_ENDPOINTS.list,
    payload: { botId: 'wx_stable_bot' },
  }]);

  await act(async () => {
    button(page, '← 返回机器人列表').props.onClick();
    await flush();
  });
  assert.ok(renderer.root.findByProps({ 'data-bot-id': 'wx_stable_bot' }));
  assert.equal(renderer.root.findByProps({ id: 'dim-tab-weixin' }).props['aria-selected'], true);
});

test('only Feishu adds a group tab and it contains only the two migrated controls', async (t) => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    requestAnimationFrame(callback) { callback(); return 1; },
    cancelAnimationFrame() {},
  };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });

  const bot = {
    botId: 'feishu_group_settings',
    connected: true,
    configured: true,
    state: 'connected',
    groupResponseMode: 'all',
    groupTopicReply: true,
    groupMessagePermissionGranted: true,
    bot: { name: '群聊设置机器人', appIdMasked: 'cli_group••••test' },
    health: { status: 'healthy', summary: '长连接运行正常', lastCheckedAt: Date.now() },
  };
  const status = { schemaVersion: 2, revision: 1, state: 'connected', bots: [bot] };
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(IMSettingsTab, {
      browserLocation: { href: 'http://localhost:9527/settings' },
      weixinRpcCall: async () => ({ ok: true, value: { revision: 1, bots: [] } }),
      feishuRpcCall: async (endpoint) => {
        assert.equal(endpoint, FEISHU_ENDPOINTS.status);
        return { ok: true, value: status };
      },
      deliveryRpcCall: async () => ({ ok: true, value: { targets: [] } }),
      updateRpcCall: async () => ({
        ok: true,
        value: { runningVersion: '4.0.1', canInstall: false },
      }),
    }));
    await flush();
  });
  t.after(async () => {
    await act(async () => { renderer.unmount(); await flush(); });
  });

  await act(async () => {
    renderer.root.findByProps({ id: 'dim-tab-feishu' }).props.onClick();
    await flush();
    await flush();
  });
  await act(async () => {
    renderer.root.findByProps({ 'aria-label': '展开该账号的设置' }).props.onClick({ stopPropagation() {} });
  });
  await act(async () => {
    renderer.root.findByProps({ 'aria-label': '更多机器人设置' }).props.onClick();
    await flush();
  });

  const page = renderer.root.findByProps({ className: 'dim-deliveryPage' });
  assert.deepEqual(page.findAllByProps({ role: 'tab' }).map(textOf), [
    '投递设置', '访问设置', '群聊',
  ]);
  await act(async () => {
    button(page, '群聊').props.onClick();
    await flush();
  });

  const groupSettings = renderer.root.findByProps({ className: 'dim-feishuGroupSettings' });
  assert.equal(groupSettings.findAllByProps({ className: 'dim-feishuGroupControl' }).length, 2);
  assert.equal(groupSettings.findAllByType('h2').length, 0);
  assert.doesNotMatch(textOf(groupSettings), /这些设置只影响|刷新群聊设置/);
  assert.equal(groupSettings.findByProps({ 'aria-label': '群聊响应方式' }).props.value, 'all');
  assert.equal(groupSettings.findByProps({ 'aria-label': '群聊以话题方式回复' }).props.value, 'on');
});

test('access settings preserve independent mode drafts and save direct and group atomically', async (t) => {
  const calls = [];
  const renderer = await mount(t, {
    channel: 'feishu',
    account: connectedAccount,
    rpcCall: async (endpoint) => {
      assert.equal(endpoint, DELIVERY_ENDPOINTS.list);
      return { ok: true, value: { targets: [] } };
    },
    accessRpcCall: async (endpoint, payload) => {
      calls.push({ endpoint, payload });
      return {
        ok: true,
        value: { bots: [{ botId: connectedAccount.botId, accessPolicy: payload.policy }] },
      };
    },
    onBack() {},
  });

  assert.equal(accessHelpButtons(renderer.root).length, 0);
  await act(async () => {
    button(renderer.root, '访问设置').props.onClick();
    await flush();
  });

  assert.equal(renderer.root.findAllByProps({ role: 'tab' }).length, 3);
  assert.equal(renderer.root.findAllByProps({ className: 'dim-accessScene' }).length, 2);
  assert.equal(renderer.root.findAllByProps({ className: 'dim-accessOwnerNotice' }).length, 0);
  assert.equal(accessHelpButtons(renderer.root).length, 2);
  for (const [scene, title] of [['direct', '私聊'], ['group', '群聊']]) {
    const sceneEditor = renderer.root.findByProps({ 'data-scene': scene });
    assert.equal(sceneEditor.props['aria-label'], title);
    const accessHelpButton = sceneEditor.findByProps({
      'aria-label': `${title} 查看访问权限说明`,
    });
    const accessHelpTooltip = sceneEditor.findByProps({
      className: 'dim-channelTooltip dim-accessHelpTooltip',
    });
    assert.equal(accessHelpTooltip.props.role, 'tooltip');
    assert.equal(accessHelpButton.props['aria-describedby'], accessHelpTooltip.props.id);
    assert.match(textOf(accessHelpTooltip), /原所有者或扫码接入者始终可以访问并执行命令/);
  }
  assert.equal(accessHelpButtons(renderer.root.findByProps({ className: 'dim-accessActions' })).length, 0);
  assert.equal(accessHelpButtons(renderer.root.findByProps({ role: 'tablist' })).length, 0);
  assert.match(
    textOf(renderer.root.findByProps({ 'data-scene': 'direct' })),
    /命令权限例外/,
  );
  await act(async () => {
    const direct = renderer.root.findByProps({ 'data-scene': 'direct' });
    const addUser = direct.findByProps({ 'aria-label': '私聊 新增用户' });
    assert.equal(addUser.props.title, '新增用户');
    assert.match(addUser.props.className, /dim-accessAddUser/);
    assert.equal(textOf(addUser), '+');
    addUser.props.onClick();
    await flush();
  });
  await act(async () => {
    renderer.root.findByProps({ 'aria-label': '私聊 飞书 Open ID 1' }).props.onChange({
      target: { value: '  ou_override  ' },
    });
    renderer.root.findByProps({ 'aria-label': '群聊 默认命令权限' }).props.onChange({
      target: { value: 'allow' },
    });
    await flush();
  });

  await act(async () => {
    renderer.root.findByProps({ 'aria-label': '私聊 访问模式' }).props.onChange({
      target: { value: 'allowlist' },
    });
    await flush();
  });
  const directAllowlistHelp = renderer.root.findByProps({
    'aria-label': '私聊 查看白名单说明',
  });
  const directAllowlistTooltip = renderer.root.findByProps({
    className: 'dim-channelTooltip dim-accessEmptyAllowlistTooltip',
  });
  assert.equal(directAllowlistTooltip.props.role, 'tooltip');
  assert.equal(directAllowlistHelp.props['aria-describedby'], directAllowlistTooltip.props.id);
  assert.equal(
    textOf(directAllowlistTooltip),
    '当前没有白名单用户，保存后普通用户将无法使用机器人。',
  );
  assert.equal(renderer.root.findAllByProps({ className: 'dim-accessWarning' }).length, 0);
  assert.match(
    textOf(renderer.root.findByProps({ 'data-scene': 'direct' })),
    /白名单用户/,
  );
  assert.equal(
    renderer.root.findAllByProps({ 'aria-label': '私聊 默认命令权限' }).length,
    0,
  );

  await act(async () => {
    const direct = renderer.root.findByProps({ 'data-scene': 'direct' });
    direct.findByProps({ 'aria-label': '私聊 新增用户' }).props.onClick();
    await flush();
  });
  assert.equal(
    renderer.root.findAllByProps({ 'aria-label': '私聊 查看白名单说明' }).length,
    0,
  );
  await act(async () => {
    renderer.root.findByProps({ 'aria-label': '群聊 访问模式' }).props.onChange({
      target: { value: 'allowlist' },
    });
    await flush();
  });
  assert.ok(renderer.root.findByProps({ 'aria-label': '群聊 查看白名单说明' }));
  await act(async () => {
    renderer.root.findByProps({ 'aria-label': '群聊 访问模式' }).props.onChange({
      target: { value: 'open' },
    });
    await flush();
  });
  await act(async () => {
    renderer.root.findByProps({ 'aria-label': '私聊 飞书 Open ID 1' }).props.onChange({
      target: { value: '  ou_allowed  ' },
    });
    await flush();
  });
  await act(async () => {
    renderer.root.findByProps({ 'aria-label': '私聊 用户 1 命令权限' }).props.onChange({
      target: { value: 'allow' },
    });
    await flush();
  });

  await act(async () => {
    renderer.root.findByProps({ 'aria-label': '私聊 访问模式' }).props.onChange({
      target: { value: 'open' },
    });
    await flush();
  });
  assert.equal(
    renderer.root.findByProps({ 'aria-label': '私聊 飞书 Open ID 1' }).props.value,
    '  ou_override  ',
  );
  assert.equal(
    renderer.root.findByProps({ 'aria-label': '私聊 用户 1 命令权限' }).props.value,
    'deny',
  );
  assert.equal(
    renderer.root.findByProps({ 'aria-label': '私聊 默认命令权限' }).props.value,
    'allow',
  );

  await act(async () => {
    renderer.root.findByProps({ 'aria-label': '私聊 访问模式' }).props.onChange({
      target: { value: 'allowlist' },
    });
    await flush();
  });
  assert.equal(
    renderer.root.findByProps({ 'aria-label': '私聊 飞书 Open ID 1' }).props.value,
    '  ou_allowed  ',
  );
  assert.equal(
    renderer.root.findByProps({ 'aria-label': '私聊 用户 1 命令权限' }).props.value,
    'allow',
  );

  await act(async () => {
    renderer.root.findByProps({ className: 'dim-accessPage' }).props.onSubmit({
      preventDefault() {},
    });
    await flush();
  });

  assert.deepEqual(calls, [{
    endpoint: ACCESS_POLICY_ENDPOINT,
    payload: {
      botId: connectedAccount.botId,
      policy: {
        direct: {
          mode: 'allowlist',
          open: {
            defaultCanExecuteCommands: true,
            commandPermissionOverrides: [{ id: 'ou_override', canExecuteCommands: false }],
          },
          allowlist: {
            users: [{ id: 'ou_allowed', canExecuteCommands: true }],
          },
        },
        group: {
          mode: 'open',
          open: {
            defaultCanExecuteCommands: true,
            commandPermissionOverrides: [],
          },
          allowlist: { users: [] },
        },
      },
    },
  }]);
  const feedback = renderer.root.findByProps({ className: 'dim-accessFeedback' });
  assert.match(textOf(feedback), /访问设置已保存/);
  assert.equal(feedback.props['data-tone'], 'success');
  assert.equal(feedback.props.role, 'status');

  await act(async () => {
    button(renderer.root, '投递设置').props.onClick();
    await flush();
  });
  assert.equal(accessHelpButtons(renderer.root).length, 0);
});

test('access settings keep a failed atomic save visible as an error', async (t) => {
  const renderer = await mount(t, {
    channel: 'feishu',
    account: connectedAccount,
    rpcCall: async () => ({ ok: true, value: { targets: [] } }),
    accessRpcCall: async () => ({
      ok: false,
      error: { code: 'access-policy-invalid', message: '访问策略未保存。' },
    }),
    onBack() {},
  });

  await act(async () => {
    button(renderer.root, '访问设置').props.onClick();
    await flush();
  });
  await act(async () => {
    renderer.root.findByProps({ className: 'dim-accessPage' }).props.onSubmit({
      preventDefault() {},
    });
    await flush();
  });

  const feedback = renderer.root.findByProps({ className: 'dim-accessFeedback' });
  assert.equal(textOf(feedback), '访问策略未保存。');
  assert.equal(feedback.props['data-tone'], 'error');
  assert.equal(feedback.props.role, 'alert');
});

test('WeChat keeps the shared access page but disables its unsupported group section', async (t) => {
  const renderer = await mount(t, {
    channel: 'weixin',
    account: { ...connectedAccount, botId: 'wx_access_01' },
    rpcCall: async () => ({ ok: true, value: { targets: [] } }),
    accessRpcCall: async () => {
      throw new Error('save should not run in this rendering test');
    },
    onBack() {},
  });
  await act(async () => {
    button(renderer.root, '访问设置').props.onClick();
    await flush();
  });

  const group = renderer.root.findByProps({ 'data-scene': 'group' });
  assert.equal(group.props.disabled, true);
  assert.match(textOf(group), /当前渠道不支持群聊/);
  assert.equal(group.findAllByType('select').length, 0);
  assert.ok(renderer.root.findByProps({ 'data-scene': 'direct' }));
});

test('new target waits for saved targets before generating aliases or checking duplicates', async (t) => {
  const pending = deferred();
  const renderer = await mount(t, {
    channel: 'feishu',
    account: connectedAccount,
    rpcCall: async (endpoint) => {
      assert.equal(endpoint, DELIVERY_ENDPOINTS.list);
      return pending.promise;
    },
    onBack() {},
  });

  assert.equal(button(renderer.root, '新建目标').props.disabled, true);

  await act(async () => {
    pending.resolve({ ok: true, value: { targets: [] } });
    await flush();
  });

  assert.equal(button(renderer.root, '新建目标').props.disabled, false);
});

test('each saved target tests only its own botId and targetId and keeps row-local feedback', async (t) => {
  const pending = deferred();
  const calls = [];
  const targets = [
    { targetId: 'daily-report', name: '日报群', kind: 'group', route: { chatId: 'oc_daily' } },
    { targetId: 'oncall', name: '值班同学', kind: 'user', route: { openId: 'ou_oncall' } },
  ];
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === DELIVERY_ENDPOINTS.list) return { ok: true, value: { targets } };
    if (endpoint === DELIVERY_ENDPOINTS.test) return pending.promise;
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  const renderer = await mount(t, {
    channel: 'feishu', account: connectedAccount, rpcCall, onBack() {},
  });
  const first = renderer.root.findByProps({ 'data-target-id': 'daily-report' });
  const second = renderer.root.findByProps({ 'data-target-id': 'oncall' });

  await act(async () => {
    first.findByProps({ 'aria-label': '测试投递目标' }).props.onClick();
    await flush();
  });
  assert.ok(first.findAllByType('button').some((entry) => textOf(entry) === '测试中…'));
  assert.ok(second.findAllByType('button').some((entry) => textOf(entry) === '测试'));
  assert.deepEqual(calls.at(-1), {
    endpoint: DELIVERY_ENDPOINTS.test,
    payload: { botId: 'bot_feishu_01', targetId: 'daily-report' },
  });

  pending.resolve({ ok: true, value: { sent: true } });
  await act(async () => { await flush(); });
  assert.match(textOf(first), /测试消息已发送，请到目标会话确认。/);
  assert.doesNotMatch(textOf(second), /测试消息已发送/);

  await act(async () => {
    renderer.update(React.createElement(DeliveryTargetSettingsPage, {
      channel: 'feishu',
      account: { ...connectedAccount, connected: false },
      rpcCall,
      onBack() {},
    }));
    await flush();
  });
  for (const row of renderer.root.findAllByProps({ className: 'dim-targetRow' })) {
    assert.equal(row.findByProps({ 'aria-label': '测试投递目标' }).props.disabled, true);
  }
});

test('saved private targets toggle Session sync while unavailable targets stay disabled', async (t) => {
  const calls = [];
  let targets = [{
    targetId: 'alice',
    name: 'Alice',
    kind: 'user',
    route: { openId: 'ou_alice' },
    sessionSync: { enabled: false, state: 'off' },
  }, {
    targetId: 'group',
    name: '项目群',
    kind: 'group',
    route: { chatId: 'oc_group' },
    sessionSync: { enabled: false, state: 'unavailable' },
  }];
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === DELIVERY_ENDPOINTS.list) {
      return { ok: true, value: { targets: structuredClone(targets) } };
    }
    if (endpoint === DELIVERY_ENDPOINTS.sessionSync) {
      targets = targets.map((target) => target.targetId === payload.targetId
        ? { ...target, sessionSync: { enabled: payload.enabled, state: payload.enabled ? 'active' : 'off' } }
        : target);
      return { ok: true, value: targets[0].sessionSync };
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  const renderer = await mount(t, {
    channel: 'feishu', account: connectedAccount, rpcCall, onBack() {},
  });
  let privateRow = renderer.root.findByProps({ 'data-target-id': 'alice' });
  const groupRow = renderer.root.findByProps({ 'data-target-id': 'group' });
  const privateToggle = privateRow.findByProps({ 'aria-label': '会话双向同步' });
  assert.equal(privateToggle.props.checked, false);
  assert.equal(privateToggle.props.disabled, false);
  assert.match(textOf(privateRow), /关闭时不发送 DSH 会话消息/);
  assert.equal(groupRow.findByProps({ 'aria-label': '会话双向同步' }).props.disabled, true);

  await act(async () => {
    privateToggle.props.onChange({ target: { checked: true } });
    await flush();
    await flush();
  });
  assert.deepEqual(calls.find((call) => call.endpoint === DELIVERY_ENDPOINTS.sessionSync), {
    endpoint: DELIVERY_ENDPOINTS.sessionSync,
    payload: { botId: 'bot_feishu_01', targetId: 'alice', enabled: true },
  });
  privateRow = renderer.root.findByProps({ 'data-target-id': 'alice' });
  assert.equal(privateRow.findByProps({ 'aria-label': '会话双向同步' }).props.checked, true);
  assert.match(textOf(privateRow), /自动跟随该私聊的当前会话/);

  await act(async () => { button(privateRow, '编辑').props.onClick(); });
  assert.match(textOf(renderer.root.findByType('form')), /修改接收位置会关闭会话双向同步/);
});

test('new target defaults to recent conversations and selection creates an editable unsaved draft', async (t) => {
  const calls = [];
  let targets = [
    { targetId: 'user-1', name: '值班同学', kind: 'user', route: { openId: 'ou_existing_secret_123456' } },
  ];
  const suggestions = [
    { kind: 'user', route: { openId: 'ou_existing_secret_123456' } },
    { kind: 'user', route: { openId: 'ou_new_secret_123456' } },
    { kind: 'group', route: { chatId: 'oc_group_secret_123456' } },
  ];
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === DELIVERY_ENDPOINTS.list) {
      return { ok: true, value: { targets: structuredClone(targets) } };
    }
    if (endpoint === DELIVERY_ENDPOINTS.listSuggestions) {
      return { ok: true, value: { suggestions: structuredClone(suggestions) } };
    }
    if (endpoint === DELIVERY_ENDPOINTS.test) {
      return { ok: true, value: { sent: true } };
    }
    if (endpoint === DELIVERY_ENDPOINTS.create) {
      targets = [...targets, structuredClone(payload.target)];
      return { ok: true, value: structuredClone(payload.target) };
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  const renderer = await mount(t, {
    channel: 'feishu', account: connectedAccount, rpcCall, onBack() {},
  });

  await act(async () => {
    button(renderer.root, '新建目标').props.onClick();
    await flush();
  });
  assert.deepEqual(calls.at(-1), {
    endpoint: DELIVERY_ENDPOINTS.listSuggestions,
    payload: { botId: 'bot_feishu_01' },
  });
  const picker = renderer.root.findByProps({ 'aria-label': '从已聊过的会话选择' });
  const suggestionSelect = picker.findByProps({ name: 'suggestion' });
  const options = suggestionSelect.findAllByType('option');
  assert.equal(options.length, 4);
  const existing = options.find((option) => textOf(option).includes('ou_ex'));
  assert.equal(existing.props.disabled, true);
  assert.match(textOf(existing), /已添加/);
  assert.doesNotMatch(textOf(picker), /ou_existing_secret_123456|ou_new_secret_123456|oc_group_secret_123456/);

  const groupIndex = options.find((option) => textOf(option).includes('oc_gr')).props.value;
  await act(async () => { suggestionSelect.props.onChange({ target: { value: groupIndex } }); });
  let form = renderer.root.findByType('form');
  const groupTargetId = form.findByProps({ name: 'targetId' }).props.value;
  assert.match(groupTargetId, /^tgt_[0-9a-f]{16}$/);
  assert.equal(form.findByProps({ name: 'targetId' }).props.readOnly, false);
  assert.equal(form.findByProps({ name: 'kind' }).props.value, 'group');
  assert.equal(form.findByProps({ name: 'chatId' }).props.value, 'oc_group_secret_123456');
  assert.match(form.findByProps({ name: 'name' }).props.value, /^群聊 · oc_gr/);
  assert.equal(calls.some((call) => call.endpoint === DELIVERY_ENDPOINTS.create), false);

  await act(async () => {
    form.findByProps({ name: 'chatId' }).props.onChange({ target: { value: 'oc_unsaved_current' } });
  });
  form = renderer.root.findByType('form');
  assert.ok(button(form, '测试'));
  await act(async () => {
    button(form, '测试').props.onClick();
    await flush();
  });
  assert.deepEqual(calls.at(-1), {
    endpoint: DELIVERY_ENDPOINTS.test,
    payload: {
      botId: 'bot_feishu_01',
      target: { kind: 'group', route: { chatId: 'oc_unsaved_current' } },
    },
  });
  assert.equal(calls.some((call) => (
    call.endpoint === DELIVERY_ENDPOINTS.create || call.endpoint === DELIVERY_ENDPOINTS.update
  )), false);
  assert.match(textOf(renderer.root.findByType('form')), /测试消息已发送，请到目标会话确认。/);

  await act(async () => { button(renderer.root, '取消').props.onClick(); });
  const nextSelect = renderer.root.findByProps({ name: 'suggestion' });
  const userIndex = nextSelect.findAllByType('option')
    .find((option) => textOf(option).includes('ou_ne')).props.value;
  await act(async () => { nextSelect.props.onChange({ target: { value: userIndex } }); });
  form = renderer.root.findByType('form');
  const userTargetId = form.findByProps({ name: 'targetId' }).props.value;
  assert.match(userTargetId, /^tgt_[0-9a-f]{16}$/);
  assert.notEqual(userTargetId, groupTargetId);
  assert.match(form.findByProps({ name: 'name' }).props.value, /^私聊 · ou_ne/);
  assert.equal(form.findByProps({ name: 'kind' }).props.value, 'user');
  assert.equal(form.findByProps({ name: 'openId' }).props.value, 'ou_new_secret_123456');
  const fallbackName = form.findByProps({ name: 'name' }).props.value;

  await act(async () => {
    form.findByProps({ name: 'targetId' }).props.onChange({ target: { value: 'project-chat' } });
  });
  await act(async () => {
    await form.props.onSubmit({ preventDefault() {} });
    await flush();
  });
  assert.deepEqual(calls.find((call) => call.endpoint === DELIVERY_ENDPOINTS.create), {
    endpoint: DELIVERY_ENDPOINTS.create,
    payload: {
      botId: 'bot_feishu_01',
      target: {
        targetId: 'project-chat',
        name: fallbackName,
        kind: 'user',
        route: { openId: 'ou_new_secret_123456' },
      },
    },
  });
});

test('recent conversation picker explains the empty state and refreshes on demand', async (t) => {
  const calls = [];
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === DELIVERY_ENDPOINTS.list) return { ok: true, value: { targets: [] } };
    if (endpoint === DELIVERY_ENDPOINTS.listSuggestions) {
      return { ok: true, value: { suggestions: [] } };
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  const renderer = await mount(t, {
    channel: 'telegram', account: connectedAccount, rpcCall, onBack() {},
  });

  await act(async () => {
    button(renderer.root, '新建目标').props.onClick();
    await flush();
  });
  assert.match(
    textOf(renderer.root.findByProps({ className: 'dim-targetSuggestions' })),
    /先在对应平台与机器人聊一条消息，再刷新。/,
  );
  assert.ok(button(renderer.root, '手动填写（高级）'));
  await act(async () => {
    button(renderer.root, '刷新').props.onClick();
    await flush();
  });
  assert.equal(calls.filter((call) => call.endpoint === DELIVERY_ENDPOINTS.listSuggestions).length, 2);
});

test('recent conversation names remain platform data in the English UI', async (t) => {
  setImTranslator((key) => en[key] ?? key);
  t.after(() => setImTranslator(null));
  const rpcCall = async (endpoint) => {
    if (endpoint === DELIVERY_ENDPOINTS.list) return { ok: true, value: { targets: [] } };
    if (endpoint === DELIVERY_ENDPOINTS.listSuggestions) {
      return {
        ok: true,
        value: {
          suggestions: [{
            id: 'group', name: '飞书项目群', kind: 'group', route: { chatId: 'oc_secret_123456' },
          }],
        },
      };
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  const renderer = await mount(t, {
    channel: 'feishu', account: connectedAccount, rpcCall, onBack() {},
  });

  await act(async () => {
    button(renderer.root, 'New target').props.onClick();
    await flush();
  });
  const select = renderer.root.findByProps({ name: 'suggestion' });
  assert.match(textOf(select), /飞书项目群/);
  assert.doesNotMatch(textOf(select), /Feishu项目群/);
  assert.match(
    textOf(renderer.root.findByProps({ className: 'dim-targetSuggestions' })),
    /Choose from conversations/,
  );
  const docsLink = renderer.root.findByProps({ className: 'dim-deliveryDocsLink' });
  assert.equal(textOf(docsLink), 'User guide↗');
  assert.equal(
    docsLink.props.href,
    'https://github.com/xmanrui/dsh-im/blob/main/PROACTIVE_DELIVERY.en.md',
  );
  assert.deepEqual(
    renderer.root.findAllByProps({ role: 'tab' }).map(textOf),
    ['Delivery settings', 'Access settings', 'Group'],
  );
});

test('target create, edit, copy, and delete use the minimal RPC payloads', async (t) => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const copied = [];
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { async writeText(value) { copied.push(value); } } },
  });
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
  });

  const calls = [];
  let targets = [];
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === DELIVERY_ENDPOINTS.list) {
      return { ok: true, value: { targets: structuredClone(targets) } };
    }
    if (endpoint === DELIVERY_ENDPOINTS.listSuggestions) {
      return { ok: true, value: { suggestions: [] } };
    }
    if (endpoint === DELIVERY_ENDPOINTS.test) {
      return { ok: true, value: { sent: true } };
    }
    if (endpoint === DELIVERY_ENDPOINTS.create) {
      targets = [...targets, structuredClone(payload.target)];
      return { ok: true, value: structuredClone(payload.target) };
    }
    if (endpoint === DELIVERY_ENDPOINTS.update) {
      targets = targets.map((target) => target.targetId === payload.targetId
        ? { targetId: payload.targetId, ...structuredClone(payload.target) }
        : target);
      return { ok: true, value: targets[0] };
    }
    if (endpoint === DELIVERY_ENDPOINTS.delete) {
      targets = targets.filter((target) => target.targetId !== payload.targetId);
      return { ok: true, value: { deleted: true } };
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  const renderer = await mount(t, {
    channel: 'telegram', account: connectedAccount, rpcCall, onBack() {},
  });

  await act(async () => {
    button(renderer.root, '复制').props.onClick();
    await flush();
  });
  assert.equal(copied.at(-1), 'bot_feishu_01');

  await act(async () => {
    button(renderer.root, '新建目标').props.onClick();
    await flush();
  });
  assert.ok(renderer.root.findByProps({ 'aria-label': '从已聊过的会话选择' }));
  await act(async () => { button(renderer.root, '手动填写（高级）').props.onClick(); });
  let createForm = renderer.root.findByType('form');
  assert.ok(button(createForm, '测试'));
  assert.equal(button(createForm, '测试').props.disabled, true);
  assert.match(
    renderer.root.findByProps({ name: 'targetId' }).props.value,
    /^tgt_[0-9a-f]{16}$/,
  );
  await act(async () => {
    renderer.root.findByProps({ name: 'targetId' }).props.onChange({ target: { value: 'Ops:Topic@A' } });
    renderer.root.findByProps({ name: 'name' }).props.onChange({ target: { value: '告警话题' } });
    renderer.root.findByProps({ name: 'kind' }).props.onChange({ target: { value: 'topic' } });
  });
  await act(async () => {
    renderer.root.findByProps({ name: 'chatId' }).props.onChange({ target: { value: '-100123' } });
    renderer.root.findByProps({ name: 'messageThreadId' }).props.onChange({ target: { value: '42' } });
  });
  createForm = renderer.root.findByType('form');
  assert.equal(createForm.findByProps({ name: 'targetId' }).props.pattern, '[A-Za-z0-9._:@-]{1,128}');
  assert.equal(createForm.findByProps({ name: 'targetId' }).props.maxLength, 128);
  assert.equal(button(createForm, '测试').props.disabled, false);
  await act(async () => {
    button(createForm, '测试').props.onClick();
    await flush();
  });
  assert.deepEqual(calls.at(-1), {
    endpoint: DELIVERY_ENDPOINTS.test,
    payload: {
      botId: 'bot_feishu_01',
      target: {
        kind: 'topic',
        route: { chatId: '-100123', messageThreadId: 42 },
      },
    },
  });
  assert.equal(calls.some((call) => (
    call.endpoint === DELIVERY_ENDPOINTS.create || call.endpoint === DELIVERY_ENDPOINTS.update
  )), false);
  assert.match(textOf(renderer.root.findByType('form')), /测试消息已发送，请到目标会话确认。/);
  await act(async () => {
    await createForm.props.onSubmit({ preventDefault() {} });
    await flush();
  });
  assert.deepEqual(calls.find((call) => call.endpoint === DELIVERY_ENDPOINTS.create), {
    endpoint: DELIVERY_ENDPOINTS.create,
    payload: {
      botId: 'bot_feishu_01',
      target: {
        targetId: 'Ops:Topic@A',
        name: '告警话题',
        kind: 'topic',
        route: { chatId: '-100123', messageThreadId: 42 },
      },
    },
  });

  const row = () => renderer.root.findByProps({ 'data-target-id': 'Ops:Topic@A' });
  assert.match(textOf(row()), /告警话题/);
  assert.match(textOf(row()), /targetId: Ops:Topic@A/);
  assert.doesNotMatch(textOf(row()), /-100123/);
  const typeBadges = row().findByProps({ className: 'dim-targetTitle' }).findAllByType('span');
  assert.equal(typeBadges.length, 1);
  assert.equal(textOf(typeBadges[0]), '话题');
  await act(async () => {
    button(row(), '复制调用参数').props.onClick();
    await flush();
  });
  assert.equal(copied.at(-1), '{"botId":"bot_feishu_01","targetId":"Ops:Topic@A"}');

  await act(async () => { button(row(), '编辑').props.onClick(); });
  let editForm = renderer.root.findByType('form');
  assert.equal(editForm.findByProps({ name: 'targetId' }).props.readOnly, true);
  assert.ok(button(editForm, '测试'));
  await act(async () => {
    editForm.findByProps({ name: 'chatId' }).props.onChange({ target: { value: '-100999' } });
    editForm.findByProps({ name: 'messageThreadId' }).props.onChange({ target: { value: '77' } });
  });
  editForm = renderer.root.findByType('form');
  await act(async () => {
    button(editForm, '测试').props.onClick();
    await flush();
  });
  assert.deepEqual(calls.at(-1), {
    endpoint: DELIVERY_ENDPOINTS.test,
    payload: {
      botId: 'bot_feishu_01',
      target: {
        kind: 'topic',
        route: { chatId: '-100999', messageThreadId: 77 },
      },
    },
  });
  assert.equal(calls.filter((call) => call.endpoint === DELIVERY_ENDPOINTS.update).length, 0);
  assert.match(textOf(renderer.root.findByType('form')), /测试消息已发送，请到目标会话确认。/);
  await act(async () => {
    editForm.findByProps({ name: 'chatId' }).props.onChange({ target: { value: '-100123' } });
    editForm.findByProps({ name: 'messageThreadId' }).props.onChange({ target: { value: '42' } });
    editForm.findByProps({ name: 'name' }).props.onChange({ target: { value: '夜间告警' } });
  });
  editForm = renderer.root.findByType('form');
  await act(async () => {
    await editForm.props.onSubmit({ preventDefault() {} });
    await flush();
  });
  const updateCall = calls.find((call) => call.endpoint === DELIVERY_ENDPOINTS.update);
  assert.deepEqual(updateCall.payload, {
    botId: 'bot_feishu_01',
    targetId: 'Ops:Topic@A',
    target: {
      name: '夜间告警',
      kind: 'topic',
      route: { chatId: '-100123', messageThreadId: 42 },
    },
  });
  assert.equal('targetId' in updateCall.payload.target, false);

  await act(async () => { button(row(), '删除').props.onClick(); });
  assert.match(textOf(row().findByProps({ role: 'alertdialog' })), /unknown-target/);
  await act(async () => {
    button(row(), '确认删除').props.onClick();
    await flush();
  });
  assert.deepEqual(calls.find((call) => call.endpoint === DELIVERY_ENDPOINTS.delete), {
    endpoint: DELIVERY_ENDPOINTS.delete,
    payload: { botId: 'bot_feishu_01', targetId: 'Ops:Topic@A' },
  });
  assert.match(
    textOf(renderer.root.findByProps({ className: 'dim-deliveryState dim-deliveryEmpty' })),
    /尚未配置投递目标/,
  );
});
