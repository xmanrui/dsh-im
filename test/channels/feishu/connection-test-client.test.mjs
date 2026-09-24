import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';

import { FEISHU_ENDPOINTS } from '../../../plugin-src/client/channels/feishu/api.js';
import {
  BotCard,
  FeishuSettingsTab,
} from '../../../plugin-src/client/channels/feishu/index.js';
import {
  FeishuGroupSettingsPage,
  GroupResponseModeEditor,
} from '../../../plugin-src/client/channels/feishu/group-settings.js';
import {
  en,
  setImTranslator,
} from '../../../plugin-src/client/i18n.js';

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node) return '';
  const children = node.children ?? node.props?.children ?? [];
  return (Array.isArray(children) ? children : [children]).map(textOf).join('');
}

test('Feishu connection check requests and displays test-message feedback', async () => {
  const source = await readFile(new URL(
    '../../../plugin-src/client/channels/feishu/index.js',
    import.meta.url,
  ), 'utf8');
  assert.match(source, /FEISHU_ENDPOINTS\.reconnectBot, \{ botId, sendTest: true \}/);
  assert.match(source, /机器人尚未收到可用于测试的私聊消息/);
  assert.doesNotMatch(source, /请先私聊机器人发送 \/status/);

  const cardProps = {
    connection: {
      botId: 'bot-feishu-test',
      state: 'connected',
      connected: true,
      bot: { name: '飞书测试机器人', appIdMasked: 'cli_test••••1234' },
      health: { summary: '长连接运行正常', lastCheckedAt: Date.now() },
    },
    testNotice: '测试消息已发送，请到飞书会话中确认。',
    onReconnect() {},
    onRequestRemove() {},
    onConfirmRemove() {},
    onCancelRemove() {},
  };
  const markup = renderToStaticMarkup(React.createElement(BotCard, cardProps));
  assert.match(markup, /role="status"[^>]*>测试消息已发送/);
  assert.match(markup, /class="dim-cardFooterLayout"[^]*class="bxf-actions bxf-botActions dim-cardActions"[^]*class="bxf-healthSummary dim-cardFeedback"/);

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(BotCard, cardProps));
  });
  const footerChildren = renderer.root.findByProps({ className: 'dim-cardFooterLayout' }).children;
  assert.match(footerChildren[0].props.className, /\bbxf-botActions\b/);
  assert.equal(footerChildren[1].props.role, 'status');
  assert.match(footerChildren[1].props.className, /\bdim-cardFeedback\b/);
  const repairButton = renderer.root.findByProps({
    'aria-label': '为飞书测试机器人补全权限与回调',
  });
  const repairTooltip = renderer.root.findByProps({ className: 'bxf-repairTooltip' });
  assert.equal(repairTooltip.props.role, 'tooltip');
  assert.equal(repairButton.props['aria-describedby'], repairTooltip.props.id);
  assert.match(textOf(repairTooltip), /card\.action\.trigger/);
  assert.match(textOf(repairTooltip), /im:message:readonly/);
  assert.match(textOf(repairTooltip), /im:resource/);
  await act(async () => renderer.unmount());

  assert.match(markup, /补全权限/);
  assert.match(markup, /aria-label="为飞书测试机器人补全权限与回调"/);
  assert.doesNotMatch(markup, /aria-label="群聊响应方式"/);
  assert.doesNotMatch(markup, /aria-label="群聊以话题方式回复"/);
});

test('Feishu group settings page saves both migrated group controls', async () => {
  let groupResponseMode = 'mention';
  let groupTopicReply = false;
  const calls = [];
  const snapshot = () => ({
    schemaVersion: 2,
    revision: calls.length + 1,
    state: 'connected',
    bots: [{
      botId: 'bot-mode-test',
      state: 'connected',
      connected: true,
      groupResponseMode,
      groupTopicReply,
      groupMessagePermissionGranted: true,
      bot: { name: '响应模式机器人' },
      health: { status: 'healthy', summary: '长连接运行正常' },
    }],
  });
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === FEISHU_ENDPOINTS.status) return { ok: true, value: snapshot() };
    if (endpoint === FEISHU_ENDPOINTS.setGroupResponseMode) {
      groupResponseMode = payload.groupResponseMode;
      return { ok: true, value: snapshot() };
    }
    if (endpoint === FEISHU_ENDPOINTS.setGroupTopicReply) {
      groupTopicReply = payload.groupTopicReply;
      return { ok: true, value: snapshot() };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(FeishuGroupSettingsPage, {
      account: {
        botId: 'bot-mode-test',
        botName: '响应模式机器人',
        groupResponseMode: 'mention',
        groupMessagePermissionGranted: true,
      },
      rpcCall,
    }));
    await flushMicrotasks();
  });
  const select = renderer.root.findByProps({ 'aria-label': '群聊响应方式' });
  assert.equal(select.type, 'select');
  assert.equal(select.props.value, 'mention');
  assert.deepEqual(select.findAllByType('option').map((option) => option.props.value), [
    'mention', 'all',
  ]);

  await act(async () => {
    select.props.onChange({ target: { value: 'all' } });
    await flushMicrotasks();
  });
  assert.ok(calls.some(({ endpoint, payload }) => (
    endpoint === FEISHU_ENDPOINTS.setGroupResponseMode
      && payload.botId === 'bot-mode-test'
      && payload.groupResponseMode === 'all'
  )));
  assert.equal(renderer.root.findByProps({ 'aria-label': '群聊响应方式' }).props.value, 'all');

  const topicSelect = renderer.root.findByProps({ 'aria-label': '群聊以话题方式回复' });
  assert.equal(topicSelect.props.value, 'off');
  await act(async () => {
    topicSelect.props.onChange({ target: { value: 'on' } });
    await flushMicrotasks();
  });
  assert.ok(calls.some(({ endpoint, payload }) => (
    endpoint === FEISHU_ENDPOINTS.setGroupTopicReply
      && payload.botId === 'bot-mode-test'
      && payload.groupTopicReply === true
  )));
  assert.equal(
    renderer.root.findByProps({ 'aria-label': '群聊以话题方式回复' }).props.value,
    'on',
  );
  await act(async () => renderer.unmount());
});

test('Feishu group response setting offers authorization recovery for all-message mode', () => {
  const reauthorizeMarkup = renderToStaticMarkup(React.createElement(GroupResponseModeEditor, {
    value: 'all',
    permissionGranted: true,
  }));
  assert.match(reauthorizeMarkup, /aria-label="重新授权群消息权限"/);
  assert.match(reauthorizeMarkup, />重新授权</);

  const legacyMarkup = renderToStaticMarkup(React.createElement(GroupResponseModeEditor, {
    value: 'all',
    permissionGranted: false,
  }));
  assert.match(legacyMarkup, /尚未确认“获取群组中所有消息”权限/);
  assert.match(legacyMarkup, />去授权</);
});

test('selecting all group messages opens the official permission flow before saving mode', async (t) => {
  const previousWindow = globalThis.window;
  let nextTimer = 0;
  const frames = new Map();
  globalThis.window = {
    setInterval() { return ++nextTimer; },
    clearInterval() {},
    setTimeout() { return ++nextTimer; },
    clearTimeout() {},
    requestAnimationFrame(callback) {
      const id = ++nextTimer;
      frames.set(id, callback);
      queueMicrotask(() => {
        const pending = frames.get(id);
        if (!pending) return;
        frames.delete(id);
        pending();
      });
      return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });

  const snapshot = {
    schemaVersion: 2,
    revision: 1,
    state: 'connected',
    bots: [{
      botId: 'bot_before_permission',
      state: 'connected',
      connected: true,
      configured: true,
      groupResponseMode: 'mention',
      groupMessagePermissionGranted: false,
      bot: { name: '前一个机器人', appIdMasked: 'cli_bef••••ore' },
      health: { status: 'healthy', summary: '长连接运行正常' },
    }, {
      botId: 'bot_group_permission',
      state: 'connected',
      connected: true,
      configured: true,
      groupResponseMode: 'mention',
      groupMessagePermissionGranted: false,
      bot: { name: '权限机器人', appIdMasked: 'cli_per••••sion' },
      health: { status: 'healthy', summary: '长连接运行正常' },
    }],
  };
  const calls = [];
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === FEISHU_ENDPOINTS.status) return { ok: true, value: snapshot };
    if (endpoint === FEISHU_ENDPOINTS.beginGroupMessagePermission) {
      return {
        ok: true,
        value: {
          attemptId: 'reg_group_permission',
          operation: 'group_message_permission',
          botId: 'bot_group_permission',
          verificationUrl: 'https://open.feishu.cn/page/launcher?tp=sdk&clientID=cli_permission&addons=encoded',
          qrCodeDataUrl: 'data:image/png;base64,AAAA',
          expiresAt: Date.now() + 60_000,
          pollIntervalMs: 800,
        },
      };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(FeishuGroupSettingsPage, {
      account: {
        botId: 'bot_group_permission',
        botName: '权限机器人',
        groupResponseMode: 'mention',
        groupMessagePermissionGranted: false,
      },
      rpcCall,
    }));
    await flushMicrotasks();
  });
  const select = renderer.root.findByProps({ 'aria-label': '群聊响应方式' });
  await act(async () => {
    select.props.onChange({ target: { value: 'all' } });
    await flushMicrotasks();
  });

  assert.ok(calls.some(({ endpoint, payload }) => (
    endpoint === FEISHU_ENDPOINTS.beginGroupMessagePermission
      && payload.botId === 'bot_group_permission'
  )));
  assert.equal(calls.some(({ endpoint }) => endpoint === FEISHU_ENDPOINTS.setGroupResponseMode), false);
  const permissionPanel = renderer.root.findByProps({
    'aria-label': '权限机器人的飞书授权流程',
  });
  assert.equal(permissionPanel.findByType('a').props.href,
    'https://open.feishu.cn/page/launcher?tp=sdk&clientID=cli_permission&addons=encoded');
  assert.match(textOf(permissionPanel), /只增量开通“获取群组中所有消息”权限/);
  assert.equal(renderer.root.findByProps({ 'aria-label': '群聊响应方式' }).props.value, 'mention');
  await act(async () => renderer.unmount());
});

test('reauthorizing all-message mode starts the same bot-scoped permission flow', async (t) => {
  const previousWindow = globalThis.window;
  let nextTimer = 0;
  const frames = new Map();
  globalThis.window = {
    setInterval() { return ++nextTimer; },
    clearInterval() {},
    setTimeout() { return ++nextTimer; },
    clearTimeout() {},
    requestAnimationFrame(callback) {
      const id = ++nextTimer;
      frames.set(id, callback);
      queueMicrotask(() => {
        const pending = frames.get(id);
        if (!pending) return;
        frames.delete(id);
        pending();
      });
      return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });

  const snapshot = {
    schemaVersion: 2,
    revision: 1,
    state: 'connected',
    bots: [{
      botId: 'bot_reauthorize',
      state: 'connected',
      connected: true,
      configured: true,
      groupResponseMode: 'all',
      groupMessagePermissionGranted: true,
      bot: { name: '重新授权机器人', appIdMasked: 'cli_reau••••thorize' },
      health: { status: 'healthy', summary: '长连接运行正常' },
    }],
  };
  const calls = [];
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === FEISHU_ENDPOINTS.status) return { ok: true, value: snapshot };
    if (endpoint === FEISHU_ENDPOINTS.beginGroupMessagePermission) {
      return {
        ok: true,
        value: {
          attemptId: 'reg_reauthorize',
          operation: 'group_message_permission',
          botId: 'bot_reauthorize',
          verificationUrl: 'https://open.feishu.cn/page/launcher?tp=sdk&clientID=cli_reauthorize&addons=encoded',
          qrCodeDataUrl: 'data:image/png;base64,AAAA',
          expiresAt: Date.now() + 60_000,
          pollIntervalMs: 800,
        },
      };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(FeishuGroupSettingsPage, {
      account: {
        botId: 'bot_reauthorize',
        botName: '重新授权机器人',
        groupResponseMode: 'all',
        groupMessagePermissionGranted: true,
      },
      rpcCall,
    }));
    await flushMicrotasks();
  });
  await act(async () => {
    renderer.root.findByProps({ 'aria-label': '重新授权群消息权限' }).props.onClick();
    await flushMicrotasks();
  });

  assert.ok(calls.some(({ endpoint, payload }) => (
    endpoint === FEISHU_ENDPOINTS.beginGroupMessagePermission
      && payload.botId === 'bot_reauthorize'
  )));
  assert.equal(calls.some(({ endpoint }) => endpoint === FEISHU_ENDPOINTS.setGroupResponseMode), false);
  assert.match(textOf(renderer.root.findByProps({
    'aria-label': '重新授权机器人的飞书授权流程',
  })),
    /正在为「重新授权机器人」开通群消息权限/);
  await act(async () => renderer.unmount());
});

test('Feishu callback repair keeps a Host-submitted attempt when a stale QR cancel races saving', async (t) => {
  const previousWindow = globalThis.window;
  let nextTimer = 0;
  const timeouts = new Map();
  const frames = new Map();
  globalThis.window = {
    setInterval() { return ++nextTimer; },
    clearInterval() {},
    setTimeout(callback) {
      const id = ++nextTimer;
      timeouts.set(id, callback);
      return id;
    },
    clearTimeout(id) { timeouts.delete(id); },
    requestAnimationFrame(callback) {
      const id = ++nextTimer;
      frames.set(id, callback);
      queueMicrotask(() => {
        const pending = frames.get(id);
        if (!pending) return;
        frames.delete(id);
        pending();
      });
      return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });

  const snapshot = {
    schemaVersion: 2,
    revision: 1,
    state: 'connected',
    bots: [{
      botId: 'bot_target',
      state: 'connected',
      connected: true,
      configured: true,
      workspace: '/workspace/current',
      bot: { name: '目标机器人', appIdMasked: 'cli_tar••••rget' },
      health: { status: 'healthy', summary: '长连接运行正常' },
    }],
  };
  const calls = [];
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === FEISHU_ENDPOINTS.status) return { ok: true, value: snapshot };
    if (endpoint === FEISHU_ENDPOINTS.beginCallbackRepair) {
      return {
        ok: true,
        value: {
          attemptId: 'reg_repair',
          operation: 'callback_repair',
          botId: 'bot_target',
          verificationUrl: 'https://open.feishu.cn/page/launcher?tp=sdk&clientID=cli_target',
          qrCodeDataUrl: 'data:image/png;base64,AAAA',
          expiresAt: Date.now() + 60_000,
          pollIntervalMs: 800,
        },
      };
    }
    if (endpoint === FEISHU_ENDPOINTS.pollProvisioning) {
      return {
        ok: true,
        value: {
          status: 'connecting',
          operation: 'callback_repair',
          botId: 'bot_target',
        },
      };
    }
    if (endpoint === FEISHU_ENDPOINTS.cancelProvisioning) {
      return {
        ok: true,
        value: {
          status: 'connecting',
          operation: 'callback_repair',
          botId: 'bot_target',
          message: 'Callback repair was already submitted and is still being verified.',
        },
      };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(FeishuSettingsTab, { rpcCall }));
    await flushMicrotasks();
  });
  const card = renderer.root.findByProps({ 'data-bot-id': 'bot_target' });
  await act(async () => {
    card.findAllByType('button')
      .find((button) => textOf(button) === '补全权限').props.onClick();
    await flushMicrotasks();
  });

  assert.ok(calls.some(({ endpoint, payload }) => endpoint === FEISHU_ENDPOINTS.beginCallbackRepair
    && payload.botId === 'bot_target'));
  const officialLink = renderer.root.findByType('a');
  assert.equal(
    officialLink.props.href,
    'https://open.feishu.cn/page/launcher?tp=sdk&clientID=cli_target',
  );
  assert.match(textOf(renderer.toJSON()), /不会创建新应用/);
  assert.match(textOf(renderer.toJSON()), /im:message:readonly/);
  assert.match(textOf(renderer.toJSON()), /im:resource/);
  assert.match(textOf(renderer.toJSON()), /获取单聊、群组消息/);
  assert.match(textOf(renderer.toJSON()), /当前缺少/);

  const staleCancel = renderer.root.findAllByType('button')
    .find((button) => textOf(button) === '取消补全');
  assert.ok(staleCancel);
  await act(async () => {
    staleCancel.props.onClick();
    await flushMicrotasks();
  });
  assert.ok(calls.some(({ endpoint, payload }) => endpoint === FEISHU_ENDPOINTS.cancelProvisioning
    && payload.attemptId === 'reg_repair'));
  assert.match(textOf(renderer.toJSON()), /此阶段无法取消/);
  assert.equal(renderer.root.findAllByType('button').some(
    (button) => textOf(button) === '取消补全',
  ), false);
  assert.ok(timeouts.size > 0, 'submitted repair keeps polling after the refused cancel');
  await act(async () => { renderer.unmount(); });
});

test('Feishu callback repair recovers when a Host restart forgets the browser attempt', async (t) => {
  const previousWindow = globalThis.window;
  let nextTimer = 0;
  const frames = new Map();
  globalThis.window = {
    setInterval() { return ++nextTimer; },
    clearInterval() {},
    setTimeout() { return ++nextTimer; },
    clearTimeout() {},
    requestAnimationFrame(callback) {
      const id = ++nextTimer;
      frames.set(id, callback);
      queueMicrotask(() => {
        const pending = frames.get(id);
        if (!pending) return;
        frames.delete(id);
        pending();
      });
      return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });

  const snapshot = {
    schemaVersion: 2,
    revision: 1,
    state: 'connected',
    bots: [{
      botId: 'bot_target',
      state: 'connected',
      connected: true,
      configured: true,
      workspace: '/workspace/current',
      bot: { name: '目标机器人', appIdMasked: 'cli_tar••••rget' },
      health: { status: 'healthy', summary: '长连接运行正常' },
    }],
  };
  let beginCount = 0;
  const calls = [];
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === FEISHU_ENDPOINTS.status) return { ok: true, value: snapshot };
    if (endpoint === FEISHU_ENDPOINTS.beginCallbackRepair) {
      beginCount += 1;
      return {
        ok: true,
        value: {
          attemptId: `reg_repair_${beginCount}`,
          operation: 'callback_repair',
          botId: 'bot_target',
          verificationUrl: `https://open.feishu.cn/page/launcher?tp=sdk&clientID=cli_target&attempt=${beginCount}`,
          qrCodeDataUrl: 'data:image/png;base64,AAAA',
          expiresAt: Date.now() + 60_000,
          pollIntervalMs: 800,
        },
      };
    }
    if (endpoint === FEISHU_ENDPOINTS.cancelProvisioning) {
      return {
        ok: false,
        error: {
          code: 'bad-request',
          message: 'The provisioning attempt is no longer active.',
        },
      };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(FeishuSettingsTab, { rpcCall }));
    await flushMicrotasks();
  });
  const repairButton = () => renderer.root.findByProps({ 'data-bot-id': 'bot_target' })
    .findAllByType('button')
    .find((button) => textOf(button) === '补全权限');

  await act(async () => {
    repairButton().props.onClick();
    await flushMicrotasks();
  });
  await act(async () => {
    renderer.root.findAllByType('button')
      .find((button) => textOf(button) === '换一个二维码').props.onClick();
    await flushMicrotasks();
  });
  assert.equal(beginCount, 2, 'a stale cancel cannot block the replacement begin');
  assert.match(renderer.root.findByType('a').props.href, /attempt=2$/);

  await act(async () => {
    renderer.root.findAllByType('button')
      .find((button) => textOf(button) === '取消补全').props.onClick();
    await flushMicrotasks();
  });
  assert.match(textOf(renderer.toJSON()), /The provisioning attempt is no longer active/);
  await act(async () => {
    renderer.root.find((node) => node.props.role === 'alert')
      .findAllByType('button')
      .find((button) => textOf(button) === '关闭').props.onClick();
    await flushMicrotasks();
  });
  assert.equal(renderer.root.findAll((node) => node.props.role === 'alert').length, 0);
  assert.equal(repairButton().props.disabled, false);
  assert.ok(calls.some(({ endpoint }) => endpoint === FEISHU_ENDPOINTS.cancelProvisioning));
  await act(async () => { renderer.unmount(); });
});

test('Feishu reconnect failures render fixed English-safe feedback', async (t) => {
  const previousWindow = globalThis.window;
  let nextFrame = 0;
  const frames = new Map();
  globalThis.window = {
    setInterval() { return 1; },
    clearInterval() {},
    requestAnimationFrame(callback) {
      const id = ++nextFrame;
      frames.set(id, callback);
      queueMicrotask(() => {
        const pending = frames.get(id);
        if (!pending) return;
        frames.delete(id);
        pending();
      });
      return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  setImTranslator((key) => en[key] ?? key);
  t.after(() => {
    setImTranslator(null);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });

  const snapshot = {
    schemaVersion: 2,
    revision: 1,
    state: 'connected',
    bots: [{
      botId: 'bot_feishu_test',
      state: 'connected',
      connected: true,
      configured: true,
      workspace: '/workspace/current',
      bot: { name: '今天是牢梁', appIdMasked: 'cli_test••••1234' },
      health: { status: 'healthy', summary: 'Long connection is healthy' },
    }],
  };
  const rpcCall = async (endpoint) => {
    if (endpoint === FEISHU_ENDPOINTS.status) return { ok: true, value: snapshot };
    if (endpoint === FEISHU_ENDPOINTS.reconnectBot) {
      return {
        ok: false,
        error: { code: 'FEISHU_UPSTREAM_FAILED', message: '飞书上游操作失败' },
      };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(FeishuSettingsTab, { rpcCall }));
    await flushMicrotasks();
  });
  const card = renderer.root.findByProps({ 'data-bot-id': 'bot_feishu_test' });
  await act(async () => {
    card.findAllByType('button')
      .find((button) => textOf(button) === 'Check connection').props.onClick();
    await flushMicrotasks();
  });

  const announcement = renderer.root.find(
    (node) => node.props.role === 'status' && node.props['aria-live'] === 'polite',
  );
  assert.equal(textOf(announcement), 'Connection check failed. Try again later.');
  assert.doesNotMatch(textOf(announcement), /[\p{Script=Han}]/u);
  assert.match(textOf(card), /Connection check failed\. Try again later\./);
  assert.doesNotMatch(textOf(card), /飞书上游操作失败/);
  await act(async () => { renderer.unmount(); });
});
