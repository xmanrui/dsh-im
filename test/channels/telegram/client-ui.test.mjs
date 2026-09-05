import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  TelegramAccountCard,
  TelegramSettingsTab,
} from '../../../plugin-src/client/channels/telegram/index.js';

test('Telegram settings exposes a Bot Token action without a fake QR action', () => {
  const markup = renderToStaticMarkup(React.createElement(TelegramSettingsTab, {
    rpcCall: async () => ({ ok: true, value: { bots: [] } }),
  }));
  assert.match(markup, /aria-label="使用 Bot Token 接入 Telegram 机器人"/);
  assert.match(markup, />手动接入</);
  assert.doesNotMatch(markup, /扫码接入机器人|dim-scanButton/);
});

test('Telegram account card matches the unified compact card layout', () => {
  const markup = renderToStaticMarkup(React.createElement(TelegramAccountCard, {
    account: {
      botId: 'telegram_test',
      connected: true,
      state: 'connected',
      bot: { name: 'Harness Bot', username: 'harness_bot', idMasked: '123•••' },
      health: { summary: 'Telegram Bot API 长轮询运行正常', lastCheckedAt: Date.now() },
      error: null,
    },
    onReconnect() {},
    onRequestRemove() {},
    onConfirmRemove() {},
    onCancelRemove() {},
  }));
  assert.match(markup, /data-im-channel-logo="telegram"/);
  assert.match(markup, /@harness_bot/);
  assert.match(markup, /class="dim-botHealthGroup"[^]*class="dim-lastChecked"><span>最近检查<\/span>/);
  assert.doesNotMatch(markup, /Bot API 长轮询|消息通道|dim-botMetric/);
  assert.match(markup, />检查连接</);
  assert.match(markup, />移除接入</);
  assert.match(markup, /aria-label="更多机器人设置"/);
  assert.doesNotMatch(markup, /Telegram 访问模式|兼容模式（默认）|安全模式（私聊白名单）/);
  assert.doesNotMatch(markup, /dim-cardSummary/);
});

test('Telegram cards shrink to a narrow English panel without horizontal scrolling', async () => {
  const sharedStyles = await readFile(
    new URL('../../../plugin-src/client/styles.js', import.meta.url),
    'utf8',
  );

  assert.match(sharedStyles, /\.dim-panel \.dim-botList \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(sharedStyles, /\.dim-panel \.dim-botCard \{[^}]*min-width: 0;[^}]*width: 100%;[^}]*max-width: 100%;[^}]*overflow: visible;/);
  assert.match(sharedStyles, /\.dim-panel \.dim-botIdentity \{[^}]*min-width: 0;[^}]*flex: 1 1 0;/);
  assert.doesNotMatch(sharedStyles, /\.dim-panel \.dim-botCardTop \{ flex-direction: column;/);
  assert.match(sharedStyles, /\.dim-panel \.dim-workspacePath \{[^}]*overflow: hidden;[^}]*overflow-wrap: anywhere;[^}]*white-space: normal;/);
  assert.doesNotMatch(sharedStyles, /\.dim-panel \.dim-workspacePath \{[^}]*overflow-x: auto;/);
});
