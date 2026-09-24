/**
 * The channel catalog: which channels this plugin ships, and how to render each
 * one's brand mark.
 *
 * Both the settings page (`index.js`) and the Lobe-style provider grid
 * (`provider-grid.js`) read this list, so it lives in its own module to keep the
 * dependency direction one-way (catalog <- views).
 */

import * as React from 'react';

import {
  DingtalkLogoGlyph,
  DiscordLogoGlyph,
  EmailLogoGlyph,
  FeishuLogoGlyph,
  IMessageLogoGlyph,
  MatrixLogoGlyph,
  OfficeLogoGlyph,
  QqLogoGlyph,
  SlackLogoGlyph,
  TelegramLogoGlyph,
  WecomLogoGlyph,
  WeixinLogoGlyph,
  WhatsappLogoGlyph,
} from './channel-logos.js';

const h = React.createElement;

/**
 * Every channel the settings page can show, in rail/grid order.
 * `note` marks a channel as experimental.
 */
export const CHANNELS = Object.freeze([
  { id: 'weixin', label: '微信' },
  { id: 'feishu', label: '飞书' },
  { id: 'dingtalk', label: '钉钉' },
  { id: 'wecom', label: '企业微信' },
  { id: 'qq', label: 'QQ' },
  { id: 'slack', label: 'Slack' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'discord', label: 'Discord' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'wecomApp', label: '企业微信应用', note: '（实验功能）' },
  { id: 'imessage', label: 'iMessage', note: '（实验功能）' },
  { id: 'email', label: '邮箱', note: '（实验功能）' },
  { id: 'matrix', label: 'Matrix', note: '（实验功能）' },
  { id: 'office', label: 'AI Office', note: '（实验功能）' },
]);

function logoWrapper(className, glyph) {
  return function ChannelLogoWrapper() {
    return h('span', { className: `dim-logo ${className}`, 'aria-hidden': 'true' }, h(glyph));
  };
}

const LOGOS = Object.freeze({
  weixin: logoWrapper('dim-logoWeixin', WeixinLogoGlyph),
  feishu: logoWrapper('dim-logoFeishu', FeishuLogoGlyph),
  dingtalk: logoWrapper('dim-logoDingtalk', DingtalkLogoGlyph),
  wecom: logoWrapper('dim-logoWecom', WecomLogoGlyph),
  wecomApp: logoWrapper('dim-logoWecomApp', WecomLogoGlyph),
  qq: logoWrapper('dim-logoQq', QqLogoGlyph),
  slack: logoWrapper('dim-logoSlack', SlackLogoGlyph),
  telegram: logoWrapper('dim-logoTelegram', TelegramLogoGlyph),
  discord: logoWrapper('dim-logoDiscord', DiscordLogoGlyph),
  whatsapp: logoWrapper('dim-logoWhatsapp', WhatsappLogoGlyph),
  imessage: logoWrapper('dim-logoIMessage', IMessageLogoGlyph),
  email: logoWrapper('dim-logoEmail', EmailLogoGlyph),
  matrix: logoWrapper('dim-logoMatrix', MatrixLogoGlyph),
  office: logoWrapper('dim-logoOffice', OfficeLogoGlyph),
});

/** Render one channel's brand mark; anything unknown falls back to AI Office. */
export function ChannelLogo({ channel }) {
  return h(LOGOS[channel] ?? LOGOS.office);
}
