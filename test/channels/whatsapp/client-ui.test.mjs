import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer from 'react-test-renderer';

import {
  EmptyView,
  ProvisionView,
  QrPanel,
  WhatsappAccountCard,
  WhatsappSettingsTab,
} from '../../../plugin-src/client/channels/whatsapp/index.js';
import { en, setImTranslator } from '../../../plugin-src/client/i18n.js';

const { act, create } = TestRenderer;

async function flushMicrotasks() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node?.children?.map(textOf).join('') ?? '';
}

test('WhatsApp onboarding is QR-only with no Cloud API credential form', () => {
  const empty = renderToStaticMarkup(React.createElement(EmptyView, {}));
  const qr = renderToStaticMarkup(React.createElement(QrPanel, {
    provision: {
      qrCodeDataUrl: 'data:image/png;base64,QUJDRA==',
      expiresAt: Date.now() + 60_000,
      durationMs: 60_000,
    },
    now: Date.now(),
  }));
  assert.match(empty, /扫码绑定 WhatsApp 机器人/);
  assert.match(empty, /生成二维码/);
  assert.match(qr, /已关联设备/);
  assert.match(qr, /关联设备/);
  assert.doesNotMatch(`${empty}${qr}`, /Cloud API|Phone Number ID|Access Token|App Secret|Verify Token|Webhook/);
});

test('WhatsApp QR startup renders a neutral loading state instead of an error card', () => {
  const markup = renderToStaticMarkup(React.createElement(ProvisionView, {
    provision: { status: 'starting' },
    busy: true,
  }));
  assert.match(markup, /正在生成 WhatsApp 二维码/);
  assert.match(markup, /aria-busy="true"/);
  assert.doesNotMatch(markup, /WhatsApp 没有接入完成|WHATSAPP_PROVISION_FAILED|ddt-inlineError/);
});

test('WhatsApp account card uses the unified compact channel layout', () => {
  const markup = renderToStaticMarkup(React.createElement(WhatsappAccountCard, {
    account: {
      botId: 'whatsapp-card',
      state: 'connected',
      connected: true,
      bot: { name: 'Harness WhatsApp', idMasked: '1650••••0123' },
      health: { summary: 'WhatsApp Web 关联设备运行正常', lastCheckedAt: Date.now() },
      error: null,
    },
    testNotice: '测试消息已发送，请到 WhatsApp 自聊会话中确认。',
  }));
  assert.match(markup, /data-im-channel-logo="whatsapp"/);
  assert.match(markup, /class="dim-botHealthGroup"[^]*class="dim-lastChecked"><span>最近检查<\/span>/);
  assert.doesNotMatch(markup, /WhatsApp Web|消息通道|dim-botMetric/);
  assert.match(markup, /检查连接/);
  assert.match(markup, /移除接入/);
  assert.match(markup, /class="dim-presetSelect"/);
  assert.match(markup, /aria-label="更多机器人设置"/);
  assert.doesNotMatch(markup, /仅自己模式（默认）|指定联系人模式|开放响应模式/);
  assert.match(markup, /role="status"[^>]*>测试消息已发送/);
});

test('WhatsApp connection check requests a test message from the existing reconnect endpoint', async () => {
  const source = await readFile(new URL(
    '../../../plugin-src/client/channels/whatsapp/index.js',
    import.meta.url,
  ), 'utf8');
  assert.match(source, /WHATSAPP_ENDPOINTS\.reconnectBot,[\s\S]*\{ botId: account\.botId, sendTest: true \}/);
  assert.doesNotMatch(source, /WHATSAPP_ENDPOINTS\.setAccessPolicy/);
  assert.match(source, /\[account\.botId\]: '连接检查失败，请稍后重试。'/);
  assert.doesNotMatch(source, /连接检查失败：\$\{presentError\(error\)\.message\}/);
});

test('WhatsApp reconnect failures render a fixed English-safe notice', async (t) => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
  };
  setImTranslator((key) => en[key] ?? key);
  t.after(() => {
    setImTranslator(null);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const snapshot = {
    schemaVersion: 1,
    bots: [{
      botId: 'whatsapp_test',
      state: 'connected',
      connected: true,
      workspace: '/workspace/current',
      bot: { name: 'Harness WhatsApp', idMasked: '1650••••0123' },
      health: { summary: 'WhatsApp Web is healthy', lastCheckedAt: Date.now() },
      error: null,
    }],
    totals: { configured: 1, connected: 1 },
  };
  const rpcCall = async (endpoint) => {
    if (endpoint === 'connection.status') return { ok: true, value: snapshot };
    if (endpoint === 'bot.reconnect') {
      return {
        ok: false,
        error: { code: 'whatsapp-operation-failed', message: 'WhatsApp 操作失败，请稍后重试。' },
      };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(WhatsappSettingsTab, { rpcCall }));
    await flushMicrotasks();
  });
  const card = renderer.root.findByProps({ 'data-bot-id': 'whatsapp_test' });
  await act(async () => {
    card.findAllByType('button')
      .find((button) => textOf(button) === 'Check connection').props.onClick();
    await flushMicrotasks();
  });

  const notice = textOf(renderer.root.findByProps({ role: 'status' }));
  assert.equal(notice, 'Connection check failed. Try again later.');
  assert.doesNotMatch(notice, /[\p{Script=Han}]/u);
  await act(async () => { renderer.unmount(); });
});
