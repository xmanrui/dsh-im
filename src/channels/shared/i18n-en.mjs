// English translations for host-side user-facing text.
// Keys are the exact Chinese literals passed to t() in src/channels/**.
// Chinese output is the identity default and needs no entries here.
// Entries are maintained per area in ./i18n-en/*.mjs and merged here.

import sharedA from './i18n-en/shared-a.mjs';
import sharedB from './i18n-en/shared-b.mjs';
import sharedC from './i18n-en/shared-c.mjs';
import conversationDirectory from './i18n-en/conversation-directory.mjs';
import feishu from './i18n-en/feishu.mjs';
import dingtalk from './i18n-en/dingtalk.mjs';
import wecom from './i18n-en/wecom.mjs';
import wecomApp from './i18n-en/wecom-app.mjs';
import qq from './i18n-en/qq.mjs';
import weixin from './i18n-en/weixin.mjs';
import slack from './i18n-en/slack.mjs';
import telegram from './i18n-en/telegram.mjs';
import discord from './i18n-en/discord.mjs';
import whatsapp from './i18n-en/whatsapp.mjs';
import office from './i18n-en/office.mjs';

export const EN = Object.freeze(Object.assign(
  {},
  sharedA,
  sharedB,
  sharedC,
  conversationDirectory,
  feishu,
  dingtalk,
  wecom,
  wecomApp,
  qq,
  weixin,
  slack,
  telegram,
  discord,
  whatsapp,
  office,
));
