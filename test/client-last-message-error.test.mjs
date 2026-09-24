import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { normalizeLastMessageError } from '../plugin-src/client/last-message-error.js';
import { normalizeBotsSnapshot as normalizeFeishu } from '../plugin-src/client/channels/feishu/api.js';
import { normalizeSnapshot as normalizeDingtalk } from '../plugin-src/client/channels/dingtalk/api.js';
import { normalizeSnapshot as normalizeWeixin } from '../plugin-src/client/channels/weixin/api.js';
import { normalizeSnapshot as normalizeWecom } from '../plugin-src/client/channels/wecom/api.js';
import { normalizeSnapshot as normalizeQq } from '../plugin-src/client/channels/qq/api.js';
import { normalizeSnapshot as normalizeSlack } from '../plugin-src/client/channels/slack/api.js';
import { normalizeSnapshot as normalizeTelegram } from '../plugin-src/client/channels/telegram/api.js';
import { normalizeSnapshot as normalizeDiscord } from '../plugin-src/client/channels/discord/api.js';
import { normalizeSnapshot as normalizeWhatsapp } from '../plugin-src/client/channels/whatsapp/api.js';
import { BotCard as FeishuBotCard } from '../plugin-src/client/channels/feishu/index.js';
import { AccountCard as DingtalkAccountCard } from '../plugin-src/client/channels/dingtalk/index.js';
import { AccountCard as WeixinAccountCard } from '../plugin-src/client/channels/weixin/index.js';
import { AccountCard as WecomAccountCard } from '../plugin-src/client/channels/wecom/index.js';
import { AccountCard as QqAccountCard } from '../plugin-src/client/channels/qq/index.js';
import { SlackAccountCard } from '../plugin-src/client/channels/slack/index.js';
import { TelegramAccountCard } from '../plugin-src/client/channels/telegram/index.js';
import { DiscordAccountCard } from '../plugin-src/client/channels/discord/index.js';
import { WhatsappAccountCard } from '../plugin-src/client/channels/whatsapp/index.js';

const publicFailure = Object.freeze({
  code: 'MODEL_RATE_LIMIT',
  reason: 'MODEL_RATE_LIMIT',
  message: '模型服务正在限流，本次任务未完成。请稍后重试。',
  referenceId: 'MF-12AB34CD',
  at: Date.UTC(2026, 7, 25, 7, 30),
});

const publicAccessPolicy = Object.freeze({
  direct: Object.freeze({
    mode: 'allowlist',
    open: Object.freeze({
      defaultCanExecuteCommands: false,
      commandPermissionOverrides: Object.freeze([]),
    }),
    allowlist: Object.freeze({
      users: Object.freeze([{ id: 'user_safe', canExecuteCommands: true }]),
    }),
  }),
  group: Object.freeze({
    mode: 'open',
    open: Object.freeze({
      defaultCanExecuteCommands: false,
      commandPermissionOverrides: Object.freeze([]),
    }),
    allowlist: Object.freeze({ users: Object.freeze([]) }),
  }),
});

function rawBot() {
  return {
    botId: 'bot_safe',
    connected: true,
    configured: true,
    state: 'connected',
    workspace: '/workspace/current',
    groupResponseMode: 'mention',
    accessPolicy: publicAccessPolicy,
    bot: {
      name: 'Harness Bot',
      username: 'harness_bot',
      appIdMasked: 'app••••01',
      clientIdMasked: 'client••••01',
      accountIdMasked: 'account••••01',
      idMasked: 'bot••••01',
    },
    health: {
      status: 'healthy',
      summary: '连接运行正常',
      lastCheckedAt: publicFailure.at,
    },
    lastMessageError: {
      ...publicFailure,
      providerDetail: 'must-not-cross-client-normalization',
      stack: '/private/path/that/must/not/render',
    },
  };
}

test('last-message error normalizer keeps only the bounded public contract', () => {
  assert.deepEqual(normalizeLastMessageError({
    ...publicFailure,
    providerDetail: 'secret provider response',
    token: 'secret token',
  }), publicFailure);

  const bounded = normalizeLastMessageError({
    code: 'C'.repeat(80),
    reason: 'R'.repeat(80),
    message: 'M'.repeat(600),
    referenceId: 'F'.repeat(60),
    at: 1,
  });
  assert.deepEqual({
    code: bounded.code.length,
    reason: bounded.reason.length,
    message: bounded.message.length,
    referenceId: bounded.referenceId.length,
  }, { code: 64, reason: 64, message: 500, referenceId: 40 });

  for (const invalid of [
    null,
    [],
    { ...publicFailure, referenceId: '' },
    { ...publicFailure, at: '2026-08-25T07:30:00Z' },
    { ...publicFailure, at: Number.POSITIVE_INFINITY },
  ]) assert.equal(normalizeLastMessageError(invalid), null);
});

test('all channel snapshot normalizers retain the same safe message failure', () => {
  const normalizers = [
    ['Feishu', normalizeFeishu],
    ['DingTalk', normalizeDingtalk],
    ['WeChat', normalizeWeixin],
    ['WeCom', normalizeWecom],
    ['QQ', normalizeQq],
    ['Slack', normalizeSlack],
    ['Telegram', normalizeTelegram],
    ['Discord', normalizeDiscord],
    ['WhatsApp', normalizeWhatsapp],
  ];

  for (const [channel, normalize] of normalizers) {
    const snapshot = normalize({ bots: [rawBot()] });
    assert.deepEqual(snapshot.bots[0].lastMessageError, publicFailure, channel);
    assert.deepEqual(snapshot.bots[0].accessPolicy, publicAccessPolicy, channel);
    assert.doesNotMatch(
      JSON.stringify(snapshot.bots[0].lastMessageError),
      /providerDetail|private|token/i,
      channel,
    );
  }
});

test('all channel cards show message failures independently from healthy connections', () => {
  const account = rawBot();
  const callbacks = {
    onReconnect() {},
    onRequestRemove() {},
    onConfirmRemove() {},
    onCancelRemove() {},
  };
  const cards = [
    ['Feishu', FeishuBotCard, { connection: account }],
    ['DingTalk', DingtalkAccountCard, { account }],
    ['WeChat', WeixinAccountCard, { account }],
    ['WeCom', WecomAccountCard, { account }],
    ['QQ', QqAccountCard, { account }],
    ['Slack', SlackAccountCard, { account }],
    ['Telegram', TelegramAccountCard, { account }],
    ['Discord', DiscordAccountCard, { account }],
    ['WhatsApp', WhatsappAccountCard, { account }],
  ];

  for (const [channel, Card, props] of cards) {
    const markup = renderToStaticMarkup(React.createElement(Card, { ...callbacks, ...props }));
    assert.match(markup, /运行正常/, channel);
    assert.match(markup, /最近一条消息处理失败/, channel);
    assert.match(markup, /模型服务正在限流/, channel);
    assert.match(markup, /MODEL_RATE_LIMIT/, channel);
    assert.match(markup, /MF-12AB34CD/, channel);
    assert.match(markup, /role="status"/, channel);
    assert.match(markup, /<time dateTime="2026-08-25T07:30:00.000Z">/, channel);
    assert.doesNotMatch(markup, /providerDetail|must-not-cross|private\/path/, channel);
  }
});
