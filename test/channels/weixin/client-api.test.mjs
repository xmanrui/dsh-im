import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer from 'react-test-renderer';

import { en, setImTranslator } from '../../../plugin-src/client/i18n.js';
import { normalizeSnapshot } from '../../../plugin-src/client/channels/weixin/api.js';
import { WeixinConnectionError, formatWeixinDiagnostic } from '../../../plugin-src/client/channels/weixin/connection-error.js';
import { createWeixinDiagnostics } from '../../../src/channels/weixin/connection-error.mjs';
import { configValidationError, withConfigResource } from '../../../src/channels/shared/config-read-error.mjs';
import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import {
  AccountCard,
  WeixinSettingsTab,
} from '../../../plugin-src/client/channels/weixin/index.js';

const { act, create } = TestRenderer;

test('startup configuration fields and guidance survive rendering, copying and an English UI', async t => {
  setImHostLanguage('zh');
  t.after(() => { setImTranslator(); setImHostLanguage('zh'); });
  const cause = withConfigResource(configValidationError('private-parser-message', 'workspaces[0].value', 'invalid-workspace-path'), 'workspace-config');
  const error = createWeixinDiagnostics({ logger: {} }).report(cause, {
    code: 'weixin-startup-config-invalid', operation: 'startup', stage: 'startup.load',
  }).publicError;
  error.details.secret = 'private-config-value';
  const beforeNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let copied;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async text => { copied = text; } } } });
  t.after(() => {
    if (beforeNavigator) Object.defineProperty(globalThis, 'navigator', beforeNavigator);
    else delete globalThis.navigator;
  });
  for (const english of [false, true]) {
    setImTranslator(english ? key => en[key] ?? key : undefined);
    let renderer;
    await act(async () => { renderer = create(React.createElement(WeixinConnectionError, { error })); });
    try {
      const rendered = textOf(renderer.root);
      for (const expected of ['workspaces.json', 'workspaces[0].value', 'invalid-config']) assert.ok(rendered.includes(expected));
      assert.ok(rendered.includes(english ? 'absolute on the current operating system' : '当前操作系统的绝对路径'));
      await act(async () => {
        buttonNamed(renderer.root, english ? en['复制诊断信息'] : '复制诊断信息').props.onClick();
        await flushMicrotasks();
      });
      assert.equal(copied, formatWeixinDiagnostic(error));
      for (const expected of ['file: workspaces.json', 'field: workspaces[0].value', 'issue: invalid-workspace-path', error.details.referenceId]) {
        assert.ok(copied.includes(expected));
      }
      assert.doesNotMatch(copied + rendered, /private-parser-message|private-config-value/);
      if (english) assert.doesNotMatch(copied + rendered, /[\p{Script=Han}]/u);
    } finally {
      await act(async () => renderer.unmount());
    }
  }
});

async function flushMicrotasks() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node?.children?.map(textOf).join('') ?? '';
}

function buttonNamed(root, name) {
  return root.findAllByType('button').find((button) => textOf(button) === name);
}

function account(botId, name) {
  return {
    botId,
    connected: true,
    state: 'connected',
    configured: true,
    workspace: '/workspace/current',
    bot: { name, accountIdMasked: `${botId}•••` },
    health: { summary: '微信消息长轮询运行正常', lastCheckedAt: Date.now() },
    error: null,
  };
}

test('Weixin client keeps only the public connection-test result', () => {
  const snapshot = normalizeSnapshot({
    schemaVersion: 1,
    revision: 1,
    state: 'connected',
    testMessage: {
      sent: false,
      code: 'test-target-unavailable',
      providerDetail: 'must-not-cross-client-normalization',
    },
    bots: [{
      botId: 'wx_0123456789abcdef01234567',
      connected: true,
      state: 'connected',
      configured: true,
      bot: { name: '微信机器人', accountIdMasked: 'account••••1234' },
      lastMessageError: {
        code: 'attachment-error',
        reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES',
        message: '当前模型不支持图片。',
        referenceId: 'MF-1A2B3C4D',
        at: 123,
        providerDetail: 'must-not-cross-client-normalization',
      },
    }],
  });

  assert.deepEqual(snapshot.testMessage, {
    sent: false,
    code: 'test-target-unavailable',
  });
  assert.deepEqual(snapshot.bots[0].lastMessageError, {
    code: 'attachment-error',
    reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES',
    message: '当前模型不支持图片。',
    referenceId: 'MF-1A2B3C4D',
    at: 123,
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /must-not-cross-client-normalization/);
});

test('Weixin account card shows the latest safe message-processing error', () => {
  const props = {
    account: {
      ...account('wx_image', '微信机器人'),
      lastMessageError: {
        code: 'attachment-error',
        reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES',
        message: '当前模型不支持图片，请用 /models 查看可用模型，再用 /model <序号> 切换后重发。',
        referenceId: 'MF-1A2B3C4D',
        at: Date.now(),
      },
    },
    onReconnect() {}, onRequestRemove() {}, onConfirmRemove() {}, onCancelRemove() {},
  };
  const markup = renderToStaticMarkup(React.createElement(AccountCard, props));

  assert.match(markup, /最近一条消息处理失败/);
  assert.match(markup, /当前模型不支持图片/);

  setImTranslator((key) => en[key] ?? key);
  try {
    const english = renderToStaticMarkup(React.createElement(AccountCard, props));
    assert.match(english, /Latest message failed/);
    assert.match(english, /current model does not support images/i);
    assert.doesNotMatch(english, /[\p{Script=Han}]/u);
  } finally {
    setImTranslator(null);
  }
});

test('Weixin card feedback stays visible without hiding connection errors', () => {
  const markup = renderToStaticMarkup(React.createElement(AccountCard, {
    account: {
      ...account('wx_first', '微信机器人'),
      connected: false,
      state: 'error',
      error: { code: 'offline', message: '连接凭据已失效' },
    },
    feedback: '微信连接检查完成，测试消息已发送。',
    onReconnect() {}, onRequestRemove() {}, onConfirmRemove() {}, onCancelRemove() {},
  }));

  assert.match(markup, />连接凭据已失效</);
  assert.match(markup, /role="status"[^>]*>微信连接检查完成，测试消息已发送。</);
});

test('Weixin connection feedback is scoped to the checked bot', async (t) => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    setInterval() { return 1; }, clearInterval() {},
    setTimeout() { return 1; }, clearTimeout() {},
    requestAnimationFrame(callback) { callback(); return 1; }, cancelAnimationFrame() {},
  };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });

  const bots = [account('wx_first', 'First Bot'), account('wx_second', 'Second Bot')];
  const calls = [];
  const rpcCall = async (endpoint, payload) => {
    if (endpoint === 'connection.status') return { ok: true, value: { revision: 1, bots } };
    if (endpoint === 'bot.reconnect') {
      calls.push(payload);
      return { ok: true, value: { revision: 2, bots, testMessage: { sent: true } } };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(WeixinSettingsTab, { rpcCall }));
    await flushMicrotasks();
  });
  const first = renderer.root.findByProps({ 'data-bot-id': 'wx_first' });
  await act(async () => {
    buttonNamed(first, '检查连接').props.onClick();
    await flushMicrotasks();
  });

  const firstAfter = renderer.root.findByProps({ 'data-bot-id': 'wx_first' });
  const secondAfter = renderer.root.findByProps({ 'data-bot-id': 'wx_second' });
  assert.match(textOf(firstAfter), /测试消息已发送/);
  assert.doesNotMatch(textOf(secondAfter), /测试消息已发送/);
  assert.deepEqual(calls, [{ botId: 'wx_first', sendTest: true }]);
  await act(async () => { renderer.unmount(); });
});

test('Weixin management failures stay visible with a copyable diagnostic', async t => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    setInterval() { return 1; }, clearInterval() {}, setTimeout() { return 1; }, clearTimeout() {},
    requestAnimationFrame(callback) { callback(); return 1; }, cancelAnimationFrame() {},
  };
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  const error = { code: 'credential-read-failed', message: '无法读取登录凭据', details: {
    stage: 'credential.read', reason: 'EACCES', referenceId: 'WX-CONN-ABCDEF12', hint: '请检查数据目录权限',
    bot_token: 'must-not-cross-client-normalization', providerCode: 'must-not-cross-client-normalization',
  } };
  for (const operation of ['bot.reconnect', 'bot.delete', 'provision.begin']) {
    let renderer;
    const bots = operation === 'provision.begin' ? [] : [account('wx_first', 'First Bot')];
    await act(async () => {
      renderer = create(React.createElement(WeixinSettingsTab, { rpcCall: async endpoint => {
        if (endpoint === 'connection.status') return { ok: true, value: { revision: 1, bots } };
        if (endpoint === operation) return { ok: false, error };
        throw new Error('Unexpected endpoint');
      } }));
      await flushMicrotasks();
    });
    if (operation === 'bot.delete') await act(async () => { buttonNamed(renderer.root, '移除接入').props.onClick(); });
    await act(async () => {
      buttonNamed(renderer.root, operation === 'bot.delete' ? '确认移除' : operation === 'provision.begin' ? '生成微信二维码' : '检查连接').props.onClick();
      await flushMicrotasks();
    });
    const diagnostics = renderer.root.findAllByProps({ 'data-weixin-diagnostic': true });
    assert.equal(diagnostics.length, 1, operation);
    assert.match(textOf(diagnostics[0]), /WX-CONN-ABCDEF12/);
    assert.match(textOf(diagnostics[0]), /EACCES/);
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /must-not-cross-client-normalization/);
    await act(async () => { buttonNamed(diagnostics[0], '复制诊断信息').props.onClick(); await flushMicrotasks(); });
    assert.match(renderer.root.findByType('textarea').props.value, /WX-CONN-ABCDEF12/);
    if (operation === 'bot.delete') assert.ok(buttonNamed(renderer.root, '确认移除'));
    await act(async () => { renderer.unmount(); });
  }
});
