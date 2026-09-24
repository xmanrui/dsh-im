import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  SlackAccountCard,
  SlackCredentialPanel,
  SlackSettingsTab,
} from '../../../plugin-src/client/channels/slack/index.js';
import { SLACK_APP_MANIFEST_YAML } from '../../../src/channels/slack/manifest.mjs';

test('Slack settings exposes Manifest-assisted dual-token access without QR', () => {
  const markup = renderToStaticMarkup(React.createElement(SlackSettingsTab, {
    rpcCall: async () => ({ ok: true, value: { bots: [] } }),
  }));
  assert.match(markup, /aria-label="使用 Manifest 和双 Token 接入 Slack 机器人"/);
  assert.match(markup, />接入机器人</);
  assert.doesNotMatch(markup, /扫码接入机器人|dim-scanButton/);

  const panel = renderToStaticMarkup(React.createElement(SlackCredentialPanel, {
    onSubmit() {},
    onCancel() {},
  }));
  assert.match(panel, />复制 Manifest</);
  assert.match(panel, />打开 Slack 创建页</);
  assert.match(panel, />Bot Token</);
  assert.match(panel, />App Token</);
  assert.match(panel, /placeholder="xoxb-…"/);
  assert.match(panel, /placeholder="xapp-…"/);
  assert.equal((panel.match(/type="password"/g) ?? []).length, 2);
  assert.match(SLACK_APP_MANIFEST_YAML, /socket_mode_enabled: true/);
  assert.match(SLACK_APP_MANIFEST_YAML, /- app_mention/);
  assert.match(SLACK_APP_MANIFEST_YAML, /- message\.im/);
});

test('Slack account card matches the unified compact layout', () => {
  const markup = renderToStaticMarkup(React.createElement(SlackAccountCard, {
    account: {
      botId: 'slack_test',
      connected: true,
      state: 'connected',
      bot: { name: 'DeepSeek Harness', username: 'deepseek-harness', idMasked: 'T123•••' },
      health: { summary: 'Slack Socket Mode 长连接运行正常', lastCheckedAt: Date.now() },
      error: null,
    },
    onReconnect() {},
    onRequestRemove() {},
    onConfirmRemove() {},
    onCancelRemove() {},
  }));
  assert.match(markup, /data-im-channel-logo="slack"/);
  assert.match(markup, /@deepseek-harness/);
  assert.match(markup, /class="dim-botHealthGroup"[^]*class="dim-lastChecked"><span>最近检查<\/span>/);
  assert.doesNotMatch(markup, /Socket Mode 长连接|消息通道|dim-botMetric/);
  assert.match(markup, />检查连接</);
  assert.match(markup, />移除接入</);
});
