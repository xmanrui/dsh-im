import { callManagementRpc } from '../management-rpc.mjs';
import * as React from 'react';
import manifest from '../../package.json' with { type: 'json' };

import {
  DingtalkLogoGlyph,
  DiscordLogoGlyph,
  FeishuLogoGlyph,
  GithubMarkGlyph,
  OfficeLogoGlyph,
  QqLogoGlyph,
  SlackLogoGlyph,
  TelegramLogoGlyph,
  WecomLogoGlyph,
  WeixinLogoGlyph,
  WhatsappLogoGlyph,
  IMessageLogoGlyph,
} from './channel-logos.js';
import { DINGTALK_RPC_CHANNEL } from './channels/dingtalk/api.js';
import { DingtalkSettingsTab } from './channels/dingtalk/index.js';
import { DISCORD_RPC_CHANNEL } from './channels/discord/api.js';
import { DiscordSettingsTab } from './channels/discord/index.js';
import { installDiscordStyles } from './channels/discord/styles.js';
import { FeishuSettingsTab } from './channels/feishu/index.js';
import { FEISHU_RPC_CHANNEL } from './channels/feishu/api.js';
import { installFeishuStyles } from './channels/feishu/styles.js';
import { QQ_RPC_CHANNEL } from './channels/qq/api.js';
import { QqSettingsTab } from './channels/qq/index.js';
import { installQqStyles } from './channels/qq/styles.js';
import { OFFICE_RPC_CHANNEL } from './channels/office/api.js';
import { OfficeSettingsTab } from './channels/office/index.js';
import { installOfficeStyles } from './channels/office/styles.js';
import { SLACK_RPC_CHANNEL } from './channels/slack/api.js';
import { SlackSettingsTab } from './channels/slack/index.js';
import { installSlackStyles } from './channels/slack/styles.js';
import { TELEGRAM_RPC_CHANNEL } from './channels/telegram/api.js';
import { TelegramSettingsTab } from './channels/telegram/index.js';
import { installTelegramStyles } from './channels/telegram/styles.js';
import { WECOM_RPC_CHANNEL } from './channels/wecom/api.js';
import { WecomSettingsTab } from './channels/wecom/index.js';
import { installWecomStyles } from './channels/wecom/styles.js';
import { WECOM_APP_RPC_CHANNEL } from './channels/wecom-app/api.js';
import { WecomAppSettingsTab } from './channels/wecom-app/index.js';
import { installWecomAppStyles } from './channels/wecom-app/styles.js';
import { WeixinSettingsTab } from './channels/weixin/index.js';
import { WEIXIN_RPC_CHANNEL } from './channels/weixin/api.js';
import { installWeixinStyles } from './channels/weixin/styles.js';
import { WHATSAPP_RPC_CHANNEL } from './channels/whatsapp/api.js';
import { WhatsappSettingsTab } from './channels/whatsapp/index.js';
import { installWhatsappStyles } from './channels/whatsapp/styles.js';
import { IMESSAGE_RPC_CHANNEL } from './channels/imessage/api.js';
import { IMessageSettingsTab } from './channels/imessage/index.js';
import { installIMessageStyles } from './channels/imessage/styles.js';
import { en, h, IM_LOCALE_NAMESPACE, setImTranslator, zh } from './i18n.js';
import {
  HOST_LANGUAGE_RPC_CHANNEL,
  installInterfaceLanguageMirror,
} from './interface-language.js';
import { BotSettingsContext } from './channel-card-meta.js';
import {
  DELIVERY_RPC_CHANNEL,
  DeliveryTargetSettingsPage,
} from './delivery-settings.js';
import {
  GLOBAL_SETTINGS_RPC_CHANNEL,
  GLOBAL_SETTINGS_TAB_ID,
  GlobalSettingsLogoGlyph,
  GlobalSettingsPanel,
} from './global-settings.js';
import {
  createLoopbackAwareRpcCalls,
  replacePageLocation,
} from './loopback-recovery.js';
import { installImStyles } from './styles.js';
import { installSessionChannelLogos } from './session-channel-logos.js';
import { UpdatePanel, UPDATE_RPC_CHANNEL } from './update-panel.js';
import { WorkspaceDirectoryPickerContext } from './workspace-editor.js';

export const name = 'im-settings';
export const inject = ['slots', 'connection', 'locale', 'workspaces'];
export const IM_PLUGIN_VERSION = manifest.version;

function callWorkspaceDirectoryApi(ctx, method, ...args) {
  // Current DSH owns directory operations on uiWorkspace; legacy Hosts keep them on workspaces.
  const uiWorkspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined;
  const service = typeof uiWorkspace?.[method] === 'function' ? uiWorkspace : ctx.workspaces;
  if (typeof service?.[method] !== 'function') {
    throw new Error('无法读取目录，请重试。');
  }
  return service[method](...args);
}

const CHANNELS = Object.freeze([
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
  { id: 'office', label: 'AI Office', note: '（实验功能）' },
]);

function WeixinLogo() {
  return h('span', { className: 'dim-logo dim-logoWeixin', 'aria-hidden': 'true' },
    h(WeixinLogoGlyph));
}

function FeishuLogo() {
  return h('span', { className: 'dim-logo dim-logoFeishu', 'aria-hidden': 'true' },
    h(FeishuLogoGlyph));
}

function DingtalkLogo() {
  return h('span', { className: 'dim-logo dim-logoDingtalk', 'aria-hidden': 'true' },
    h(DingtalkLogoGlyph));
}

function QqLogo() {
  return h('span', { className: 'dim-logo dim-logoQq', 'aria-hidden': 'true' }, h(QqLogoGlyph));
}

function WecomLogo() {
  return h('span', { className: 'dim-logo dim-logoWecom', 'aria-hidden': 'true' }, h(WecomLogoGlyph));
}

function WecomAppLogo() {
  return h('span', { className: 'dim-logo dim-logoWecomApp', 'aria-hidden': 'true' }, h(WecomLogoGlyph));
}

function TelegramLogo() {
  return h('span', { className: 'dim-logo dim-logoTelegram', 'aria-hidden': 'true' },
    h(TelegramLogoGlyph));
}

function SlackLogo() {
  return h('span', { className: 'dim-logo dim-logoSlack', 'aria-hidden': 'true' },
    h(SlackLogoGlyph));
}

function DiscordLogo() {
  return h('span', { className: 'dim-logo dim-logoDiscord', 'aria-hidden': 'true' },
    h(DiscordLogoGlyph));
}

function WhatsappLogo() {
  return h('span', { className: 'dim-logo dim-logoWhatsapp', 'aria-hidden': 'true' },
    h(WhatsappLogoGlyph));
}

function IMessageLogo() {
  return h('span', { className: 'dim-logo dim-logoIMessage', 'aria-hidden': 'true' },
    h(IMessageLogoGlyph));
}

function OfficeLogo() {
  return h('span', { className: 'dim-logo dim-logoOffice', 'aria-hidden': 'true' },
    h(OfficeLogoGlyph));
}

function ChannelLogo({ channel }) {
  if (channel === 'weixin') return h(WeixinLogo);
  if (channel === 'feishu') return h(FeishuLogo);
  if (channel === 'dingtalk') return h(DingtalkLogo);
  if (channel === 'wecom') return h(WecomLogo);
  if (channel === 'wecomApp') return h(WecomAppLogo);
  if (channel === 'qq') return h(QqLogo);
  if (channel === 'slack') return h(SlackLogo);
  if (channel === 'telegram') return h(TelegramLogo);
  if (channel === 'discord') return h(DiscordLogo);
  if (channel === 'whatsapp') return h(WhatsappLogo);
  if (channel === 'imessage') return h(IMessageLogo);
  return h(OfficeLogo);
}

export function LoopbackRecoveryNotice({ recovery, onNavigate = replacePageLocation }) {
  return h('div', {
    className: 'dim-loopbackRecovery',
    role: 'alert',
  },
  h('div', { className: 'dim-loopbackRecoveryCopy' },
    h('strong', null, '请改用 localhost 重新打开'),
    h('p', null, '页面会在当前端口重新打开，机器人配置不会改变。'),
    h('code', null, recovery.origin)),
  h('button', {
    type: 'button',
    className: 'dim-loopbackRecoveryAction',
    onClick: () => onNavigate(recovery.url),
  }, '使用 localhost 重新打开'));
}

export function IMSettingsTab({
  dingtalkRpcCall,
  discordRpcCall,
  feishuRpcCall,
  imessageRpcCall,
  qqRpcCall,
  slackRpcCall,
  telegramRpcCall,
  wecomRpcCall,
  wecomAppRpcCall,
  weixinRpcCall,
  whatsappRpcCall,
  officeRpcCall,
  updateRpcCall,
  deliveryRpcCall,
  globalSettingsRpcCall,
  workspaceDirectoryPicker,
  browserLocation = globalThis.location,
  navigateToRecoveryUrl = replacePageLocation,
}) {
  const [selected, setSelected] = React.useState('weixin');
  const [loopbackRecovery, setLoopbackRecovery] = React.useState(null);
  const [runningVersion, setRunningVersion] = React.useState(IM_PLUGIN_VERSION);
  const [deliverySettings, setDeliverySettings] = React.useState(null);
  const railTabRefs = React.useRef([]);
  const githubTooltipId = React.useId();
  const generalSettingsTooltipId = React.useId();
  const globalSettingsSelected = selected === GLOBAL_SETTINGS_TAB_ID;
  const active = CHANNELS.find((channel) => channel.id === selected) ?? CHANNELS[0];
  const activeTabId = globalSettingsSelected
    ? 'dim-general-settings-trigger'
    : `dim-tab-${active.id}`;
  const activePanelId = globalSettingsSelected
    ? `dim-panel-${GLOBAL_SETTINGS_TAB_ID}`
    : `dim-panel-${active.id}`;
  // WAI-ARIA tabs pattern: one Tab stop for the strip, the arrow keys move
  // within it, Home/End jump to the ends. Selection follows focus, which is the
  // behaviour the pattern prescribes for a strip whose panels are cheap to show.
  const onRailKeyDown = (event) => {
    const { key } = event;
    if (key !== 'ArrowRight' && key !== 'ArrowLeft' && key !== 'Home' && key !== 'End') return;
    const count = CHANNELS.length;
    const from = Math.max(0, CHANNELS.findIndex((channel) => channel.id === selected));
    const next = key === 'Home' ? 0
      : key === 'End' ? count - 1
        : (from + (key === 'ArrowRight' ? 1 : -1) + count) % count;
    event.preventDefault();
    setSelected(CHANNELS[next].id);
    setDeliverySettings(null);
    railTabRefs.current[next]?.focus?.();
  };
  const reportLoopbackRecovery = React.useCallback((recovery) => {
    setLoopbackRecovery((current) => current?.url === recovery.url ? current : recovery);
  }, []);
  const reportUpdateStatus = React.useCallback((snapshot) => {
    setRunningVersion(snapshot.runningVersion);
  }, []);
  const rpcCalls = React.useMemo(() => createLoopbackAwareRpcCalls({
    dingtalkRpcCall,
    discordRpcCall,
    feishuRpcCall,
    qqRpcCall,
    slackRpcCall,
    telegramRpcCall,
    wecomRpcCall,
    wecomAppRpcCall,
    weixinRpcCall,
    whatsappRpcCall,
    officeRpcCall,
    updateRpcCall,
    deliveryRpcCall,
    globalSettingsRpcCall,
    imessageRpcCall,
  }, {
    location: browserLocation,
    onRecovery: reportLoopbackRecovery,
  }), [
    browserLocation,
    dingtalkRpcCall,
    discordRpcCall,
    deliveryRpcCall,
    feishuRpcCall,
    globalSettingsRpcCall,
    imessageRpcCall,
    officeRpcCall,
    qqRpcCall,
    reportLoopbackRecovery,
    slackRpcCall,
    telegramRpcCall,
    updateRpcCall,
    wecomRpcCall,
    wecomAppRpcCall,
    weixinRpcCall,
    whatsappRpcCall,
  ]);
  const botSettingsContext = React.useMemo(() => Object.freeze({
    openBotSettings: setDeliverySettings,
  }), []);
  return h(WorkspaceDirectoryPickerContext.Provider, { value: workspaceDirectoryPicker },
    h('section', { className: 'dim-page', 'aria-label': 'IM机器人设置' },
    h('header', { className: 'dim-title' },
      h('div', { className: 'dim-brand' },
        h('div', { className: 'dim-brandHeading' },
          h('strong', { className: 'dim-brandName' }, 'DSH-IM'),
          h('span', { className: 'dim-brandVersion' }, `v${runningVersion}`)),
        h('p', null, '让 DeepSeek Harness 触手可及')),
      h('div', { className: 'dim-titleActions' },
        h(UpdatePanel, {
          rpcCall: rpcCalls.updateRpcCall,
          clientVersion: IM_PLUGIN_VERSION,
          onStatus: reportUpdateStatus,
        }),
      h('span', { className: 'dim-githubAction' },
        h('a', {
          className: 'dim-githubLink',
          href: 'https://github.com/xmanrui/dsh-im',
          target: '_blank',
          rel: 'noopener noreferrer',
          'aria-label': 'dsh-im GitHub',
          'aria-describedby': githubTooltipId,
        },
        h(GithubMarkGlyph, { size: 16 })),
        h('span', {
          id: githubTooltipId,
          className: 'dim-githubTooltip',
          role: 'tooltip',
        }, '帮助与反馈 · 前往 GitHub')),
      h('span', { className: 'dim-generalSettingsAction' },
        h('button', {
          type: 'button',
          id: 'dim-general-settings-trigger',
          className: 'dim-generalSettingsButton',
          'aria-label': '通用设置',
          'aria-describedby': generalSettingsTooltipId,
          'aria-controls': `dim-panel-${GLOBAL_SETTINGS_TAB_ID}`,
          'aria-current': globalSettingsSelected ? 'page' : undefined,
          onClick: () => {
            setSelected(GLOBAL_SETTINGS_TAB_ID);
            setDeliverySettings(null);
          },
        }, h(GlobalSettingsLogoGlyph, { size: 17 })),
        h('span', {
          id: generalSettingsTooltipId,
          className: 'dim-generalSettingsTooltip',
          role: 'tooltip',
        }, '通用设置'))),
    ),
    h('div', { className: 'dim-layout' },
      h('nav', {
        className: 'dim-rail',
        role: 'tablist',
        'aria-label': 'IM 设置导航',
        onKeyDown: onRailKeyDown,
      },
        CHANNELS.map((channel, index) => h('button', {
          ref: (node) => { railTabRefs.current[index] = node; },
          key: channel.id,
          type: 'button',
          role: 'tab',
          id: `dim-tab-${channel.id}`,
          className: 'dim-channel',
          'aria-selected': !globalSettingsSelected && channel.id === active.id,
          // Roving tabindex: one Tab stop for the whole strip; the arrow keys
          // move within it. With nothing selected (the general settings page is
          // showing) the first tab holds the stop so the strip stays reachable.
          tabIndex: (!globalSettingsSelected && channel.id === active.id)
            || (globalSettingsSelected && channel.id === CHANNELS[0].id) ? 0 : -1,
          'aria-controls': `dim-panel-${channel.id}`,
          onClick: () => {
            setSelected(channel.id);
            setDeliverySettings(null);
          },
        },
        h(ChannelLogo, { channel: channel.id }),
        h('span', { className: 'dim-channelCopy' },
          h('strong', null, channel.label),
          channel.note ? h('small', { className: 'dim-channelNote' }, channel.note) : null,
        )))),
      h('main', {
        className: 'dim-panel',
        role: 'tabpanel',
        id: activePanelId,
        'aria-labelledby': activeTabId,
      },
      loopbackRecovery
        ? h(LoopbackRecoveryNotice, {
            recovery: loopbackRecovery,
            onNavigate: navigateToRecoveryUrl,
          })
        : null,
      h(BotSettingsContext.Provider, { value: botSettingsContext },
        globalSettingsSelected
          ? h(GlobalSettingsPanel, { rpcCall: rpcCalls.globalSettingsRpcCall })
          : deliverySettings?.channel === active.id
          ? h(DeliveryTargetSettingsPage, {
              channel: active.id,
              account: deliverySettings,
              rpcCall: rpcCalls.deliveryRpcCall,
              accessRpcCall: rpcCalls[`${active.id}RpcCall`],
              onBack: () => setDeliverySettings(null),
            })
          : active.id === 'weixin'
            ? h(WeixinSettingsTab, { rpcCall: rpcCalls.weixinRpcCall })
            : active.id === 'feishu'
              ? h(FeishuSettingsTab, { rpcCall: rpcCalls.feishuRpcCall })
              : active.id === 'dingtalk'
                ? h(DingtalkSettingsTab, { rpcCall: rpcCalls.dingtalkRpcCall })
                : active.id === 'wecom'
                  ? h(WecomSettingsTab, { rpcCall: rpcCalls.wecomRpcCall })
                : active.id === 'wecomApp'
                  ? h(WecomAppSettingsTab, { rpcCall: rpcCalls.wecomAppRpcCall })
                  : active.id === 'qq'
                    ? h(QqSettingsTab, { rpcCall: rpcCalls.qqRpcCall })
                    : active.id === 'slack'
                      ? h(SlackSettingsTab, { rpcCall: rpcCalls.slackRpcCall })
                    : active.id === 'telegram'
                      ? h(TelegramSettingsTab, { rpcCall: rpcCalls.telegramRpcCall })
                      : active.id === 'discord'
                        ? h(DiscordSettingsTab, { rpcCall: rpcCalls.discordRpcCall })
                        : active.id === 'whatsapp'
                          ? h(WhatsappSettingsTab, { rpcCall: rpcCalls.whatsappRpcCall })
                          : active.id === 'imessage'
                            ? h(IMessageSettingsTab, { rpcCall: rpcCalls.imessageRpcCall })
                          : h(OfficeSettingsTab, { rpcCall: rpcCalls.officeRpcCall }))),
    ),
  ));
}

export function apply(ctx) {
  ctx.effect(
    () => ctx.locale.register(IM_LOCALE_NAMESPACE, { zh, en }),
    'im-settings: bilingual dictionaries',
  );
  const t = ctx.locale.bind(IM_LOCALE_NAMESPACE);
  setImTranslator(t);

  // The settings page is the only place that knows the locale the interface is
  // actually rendered in: DSH stores nothing when it came from the browser's
  // language list. Report it so bot messages follow the same language.
  ctx.effect(
    () => installInterfaceLanguageMirror(ctx, {
      rpcCall: (endpoint, payload, signal) =>
        callManagementRpc(ctx.connection, HOST_LANGUAGE_RPC_CHANNEL, endpoint, payload, signal),
    }),
    'im-settings: mirror the DSH interface language',
  );

  ctx.effect(() => installSessionChannelLogos(), 'im-settings: Session channel logos');

  ctx.effect(() => {
    const disposers = [
      installFeishuStyles(),
      installWeixinStyles(),
      installWecomStyles(),
      installWecomAppStyles(),
      installQqStyles(),
      installSlackStyles(),
      installTelegramStyles(),
      installDiscordStyles(),
      installWhatsappStyles(),
      installIMessageStyles(),
      installOfficeStyles(),
      installImStyles(),
    ];
    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  }, 'im-settings: install combined channel styles');

  const feishuRpcCall = (endpoint, payload, signal) =>
    callManagementRpc(ctx.connection, FEISHU_RPC_CHANNEL, endpoint, payload, signal);
  const weixinRpcCall = (endpoint, payload, signal) =>
    callManagementRpc(ctx.connection, WEIXIN_RPC_CHANNEL, endpoint, payload, signal);
  const dingtalkRpcCall = (endpoint, payload, signal) =>
    callManagementRpc(ctx.connection, DINGTALK_RPC_CHANNEL, endpoint, payload, signal);
  const qqRpcCall = (endpoint, payload, signal) =>
    callManagementRpc(ctx.connection, QQ_RPC_CHANNEL, endpoint, payload, signal);
  const wecomRpcCall = (endpoint, payload, signal) =>
    callManagementRpc(ctx.connection, WECOM_RPC_CHANNEL, endpoint, payload, signal);
  const wecomAppRpcCall = (endpoint, payload, signal) =>
    callManagementRpc(ctx.connection, WECOM_APP_RPC_CHANNEL, endpoint, payload, signal);
  const telegramRpcCall = (endpoint, payload, signal) =>
    callManagementRpc(ctx.connection, TELEGRAM_RPC_CHANNEL, endpoint, payload, signal);
  const discordRpcCall = (endpoint, payload, signal) =>
    callManagementRpc(ctx.connection, DISCORD_RPC_CHANNEL, endpoint, payload, signal);
  const whatsappRpcCall = (endpoint, payload, signal) =>
    callManagementRpc(ctx.connection, WHATSAPP_RPC_CHANNEL, endpoint, payload, signal);
  const imessageRpcCall = (endpoint, payload, signal) =>
    callManagementRpc(ctx.connection, IMESSAGE_RPC_CHANNEL, endpoint, payload, signal);
  const slackRpcCall = (endpoint, payload, signal) =>
    callManagementRpc(ctx.connection, SLACK_RPC_CHANNEL, endpoint, payload, signal);
  const officeRpcCall = (endpoint, payload, signal) =>
    callManagementRpc(ctx.connection, OFFICE_RPC_CHANNEL, endpoint, payload, signal);
  const updateRpcCall = (endpoint, payload, signal) =>
    callManagementRpc(ctx.connection, UPDATE_RPC_CHANNEL, endpoint, payload, signal);
  const deliveryRpcCall = (endpoint, payload, signal) =>
    callManagementRpc(ctx.connection, DELIVERY_RPC_CHANNEL, endpoint, payload, signal);
  const globalSettingsRpcCall = (endpoint, payload, signal) =>
    callManagementRpc(ctx.connection, GLOBAL_SETTINGS_RPC_CHANNEL, endpoint, payload, signal);
  const workspaceDirectoryPicker = Object.freeze({
    listDirectory: (path, signal) =>
      callWorkspaceDirectoryApi(ctx, 'listDirectory', path, signal),
    pickDirectory: () => callWorkspaceDirectoryApi(ctx, 'pickDirectory'),
  });

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'xmanrui-dsh-im',
    order: 21,
    label: () => t('IM机器人'),
    locale: IM_LOCALE_NAMESPACE,
    inject: () => ({
      dingtalkRpcCall,
      discordRpcCall,
      feishuRpcCall,
      qqRpcCall,
      slackRpcCall,
      telegramRpcCall,
      wecomRpcCall,
      wecomAppRpcCall,
      weixinRpcCall,
      whatsappRpcCall,
      imessageRpcCall,
      officeRpcCall,
      updateRpcCall,
      deliveryRpcCall,
      globalSettingsRpcCall,
      workspaceDirectoryPicker,
    }),
  }, IMSettingsTab));
}
