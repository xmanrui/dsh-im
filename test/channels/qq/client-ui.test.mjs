import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AccountCard, QqSettingsTab } from '../../../plugin-src/client/channels/qq/index.js';
import { en, setImTranslator } from '../../../plugin-src/client/i18n.js';

const CLIENT_URL = new URL('../../../plugin-src/client/channels/qq/index.js', import.meta.url);

test('QQ settings uses the shared compact channel toolbar', () => {
  const markup = renderToStaticMarkup(React.createElement(QqSettingsTab, {
    rpcCall: async () => ({ ok: true, value: {} }),
  }));
  assert.match(markup, /class="ddt-page dqq-page dim-channelPage"/);
  assert.match(markup, /class="ddt-button dim-scanButton"/);
  assert.match(markup, /aria-label="扫码接入 QQ 机器人"/);
  assert.match(markup, /class="dim-actionIcon"[^]*扫码接入机器人/);
  assert.doesNotMatch(markup, /凭据仅保存在本机|role="switch"|type="checkbox"/);
});

test('QQ bot cards keep check time with status and omit repeated channel details', () => {
  const markup = renderToStaticMarkup(React.createElement(AccountCard, {
    account: {
      botId: 'qq_bot',
      connected: true,
      state: 'connected',
      bot: { name: 'QQ机器人', appIdMasked: '123••••456' },
      health: { summary: 'QQ WebSocket 长连接运行正常', lastCheckedAt: Date.now() },
      error: null,
    },
    onReconnect() {},
    onRequestRemove() {},
    onConfirmRemove() {},
    onCancelRemove() {},
  }));
  assert.match(markup, /class="ddt-card dim-botCard"/);
  assert.match(markup, /data-im-channel-logo="qq"/);
  assert.match(markup, /class="dim-botHealthGroup"[^]*class="dim-lastChecked"><span>最近检查<\/span>/);
  assert.doesNotMatch(markup, /消息通道|dim-botMetric/);
  assert.match(markup, />检查连接<[^]*>移除接入</);
  assert.match(markup, /class="dim-presetSelect"/);
  assert.doesNotMatch(markup, /收到\s*\/\s*回复|dim-cardSummary|QQ WebSocket 长连接运行正常/);

  const offlineMarkup = renderToStaticMarkup(React.createElement(AccountCard, {
    account: {
      botId: 'qq_bot', connected: false, state: 'error',
      bot: { name: 'QQ机器人', appIdMasked: '123••••456' },
      health: { summary: '连接失败，请检查凭据', lastCheckedAt: Date.now() },
      error: null,
    },
    onReconnect() {}, onRequestRemove() {}, onConfirmRemove() {}, onCancelRemove() {},
  }));
  assert.match(offlineMarkup, /class="ddt-summary dim-cardSummary">连接失败，请检查凭据</);
});

test('QQ connection checks request a test message and show concise card feedback', async () => {
  const source = await readFile(CLIENT_URL, 'utf8');
  assert.match(source, /\{ botId: account\.botId, sendTest: true \}/);
  assert.match(source, /'连接检查失败，请稍后重试。'/);
  assert.doesNotMatch(source, /连接检查失败：\$\{presentError\(error\)\.message\}/);

  const markup = renderToStaticMarkup(React.createElement(AccountCard, {
    account: {
      botId: 'qq_bot', connected: true, state: 'connected',
      bot: { name: 'QQ机器人', appIdMasked: '123••••456' },
      health: { summary: 'QQ WebSocket 长连接运行正常', lastCheckedAt: Date.now() },
      error: null,
    },
    feedback: '测试消息已发送，请到对应机器人会话中确认。',
    onReconnect() {}, onRequestRemove() {}, onConfirmRemove() {}, onCancelRemove() {},
  }));
  assert.match(markup, /role="status"/);
  assert.match(markup, /测试消息已发送/);

  const offlineMarkup = renderToStaticMarkup(React.createElement(AccountCard, {
    account: {
      botId: 'qq_bot', connected: false, state: 'error',
      bot: { name: 'QQ机器人', appIdMasked: '123••••456' },
      health: { summary: 'QQ 连接尚未就绪', lastCheckedAt: Date.now() },
      error: { code: 'offline', message: '连接凭据已失效' },
    },
    feedback: '测试消息已发送，请到对应机器人会话中确认。',
    onReconnect() {}, onRequestRemove() {}, onConfirmRemove() {}, onCancelRemove() {},
  }));
  assert.match(offlineMarkup, />连接凭据已失效</);
  assert.match(offlineMarkup, /role="status"[^>]*>测试消息已发送/);
});

test('fixed reconnect failure copy renders fully in English', () => {
  setImTranslator((key) => en[key] ?? key);
  try {
    const markup = renderToStaticMarkup(React.createElement(AccountCard, {
      account: {
        botId: 'qq_bot', connected: true, state: 'connected',
        bot: { name: 'QQ Bot', appIdMasked: '123••••456' },
        health: { summary: 'healthy', lastCheckedAt: Date.now() },
        error: null,
      },
      feedback: '连接检查失败，请稍后重试。',
      onReconnect() {}, onRequestRemove() {}, onConfirmRemove() {}, onCancelRemove() {},
    }));
    assert.match(markup, /Connection check failed\. Try again later\./);
    assert.doesNotMatch(markup, /[\p{Script=Han}]/u);
  } finally {
    setImTranslator(null);
  }
});
