import { callManagementRpc } from '../management-rpc.mjs';
import * as React from 'react';
import manifest from '../../package.json' with { type: 'json' };

import {
  DingtalkLogoGlyph,
  DiscordLogoGlyph,
  FeishuLogoGlyph,
  OfficeLogoGlyph,
  QqLogoGlyph,
  SlackLogoGlyph,
  TelegramLogoGlyph,
  WecomLogoGlyph,
  WeixinLogoGlyph,
  WhatsappLogoGlyph,
  IMessageLogoGlyph,
  EmailLogoGlyph,
  MatrixLogoGlyph,
} from './channel-logos.js';
import { ChannelLogo, CHANNELS } from './channel-catalog.js';
import { ProviderGrid, useProviderStatus } from './provider-grid.js';
import { Button, IconButton, installUiStyles, Tooltip } from './ui/index.js';
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
import { EMAIL_RPC_CHANNEL } from './channels/email/api.js';
import { IMessageSettingsTab } from './channels/imessage/index.js';
import { EmailSettingsTab, useEmailChannelEnabled } from './channels/email/index.js';
import { installIMessageStyles } from './channels/imessage/styles.js';
import { installEmailStyles } from './channels/email/styles.js';
import { MATRIX_RPC_CHANNEL } from './channels/matrix/api.js';
import { MatrixSettingsTab } from './channels/matrix/index.js';
import { installMatrixStyles } from './channels/matrix/styles.js';
import { en, h, IM_LOCALE_NAMESPACE, localizeText, setImTranslator, zh } from './i18n.js';
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
import { IMPanelErrorBoundary } from './panel-error-boundary.js';

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

/**
 * Drill-down heading for a channel's configuration page: a back control plus
 * the channel's brand mark and name, so the page still says where it is now
 * that the always-visible rail is gone (issue #247 (h)).
 */
function ChannelPageHeader({ channel, onBack }) {
  return h('div', { className: 'dim-channelHeader' },
    h(Button, {
      variant: 'ghost',
      size: 'sm',
      className: 'dim-channelBack',
      onClick: onBack,
    }, '返回服务商列表'),
    h(ChannelLogo, { channel: channel.id }),
    h('span', { className: 'dim-channelHeaderCopy' },
      h('strong', { id: `dim-channel-heading-${channel.id}`, className: 'dim-channelHeaderName' },
        channel.label),
      channel.note ? h('small', { className: 'dim-channelHeaderNote' }, channel.note) : null));
}

export function IMSettingsTab({
  dingtalkRpcCall,
  discordRpcCall,
  feishuRpcCall,
  imessageRpcCall,
  emailRpcCall,
  matrixRpcCall,
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
  preferredSectionId,
  browserLocation = globalThis.location,
  navigateToRecoveryUrl = replacePageLocation,
}) {
  const [selected, setSelected] = React.useState(() => (
    preferredSectionId === GLOBAL_SETTINGS_TAB_ID
      || CHANNELS.some((channel) => channel.id === preferredSectionId)
      ? preferredSectionId : 'weixin'
  ));
  // The Lobe layout is list-then-detail: the entry page is the provider grid,
  // and a channel's own configuration page only mounts after a card is picked.
  // A caller that names a section explicitly (deep link / host restore) goes
  // straight to that page instead of the grid.
  const [browsing, setBrowsing] = React.useState(() => !(
    preferredSectionId === GLOBAL_SETTINGS_TAB_ID
    || CHANNELS.some((channel) => channel.id === preferredSectionId)
  ));
  const [loopbackRecovery, setLoopbackRecovery] = React.useState(null);
  const [runningVersion, setRunningVersion] = React.useState(IM_PLUGIN_VERSION);
  const [deliverySettings, setDeliverySettings] = React.useState(null);
  // The Host owns email availability and reports it over RPC. The
  // mailbox entry point is omitted entirely while it is closed, and the visible
  // channel list is what every later lookup reads from.
  const emailEnabled = useEmailChannelEnabled(emailRpcCall);
  const visibleChannels = React.useMemo(
    () => CHANNELS.filter((channel) => channel.id !== 'email' || emailEnabled),
    [emailEnabled],
  );
  const globalSettingsSelected = selected === GLOBAL_SETTINGS_TAB_ID;
  const active = visibleChannels.find((channel) => channel.id === selected) ?? visibleChannels[0];
  const showProviderGrid = browsing && !globalSettingsSelected;
  const activePanelId = showProviderGrid
    ? 'dim-panel-providers'
    : globalSettingsSelected
      ? `dim-panel-${GLOBAL_SETTINGS_TAB_ID}`
      : `dim-panel-${active.id}`;
  // The provider grid is not a tab panel: it owns the page, so it is labelled
  // directly. A channel page is labelled by its own drill-down heading.
  const panelLabelledBy = showProviderGrid
    ? undefined
    : globalSettingsSelected
      ? 'dim-general-settings-trigger'
      : `dim-channel-heading-${active.id}`;
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
    emailRpcCall,
    matrixRpcCall,
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
    emailRpcCall,
    matrixRpcCall,
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
  // One status probe per visible channel, loaded for the whole panel so the
  // grid can group cards into enabled / not-yet-enabled and the drill-down can
  // reuse the same facts.
  const providerStatus = useProviderStatus(visibleChannels, rpcCalls);
  const openChannel = React.useCallback((channelId) => {
    setSelected(channelId);
    setDeliverySettings(null);
    setBrowsing(false);
  }, []);
  const goBackToProviders = React.useCallback(() => {
    setBrowsing(true);
    setDeliverySettings(null);
  }, []);
  const openGlobalSettings = React.useCallback(() => {
    setSelected(GLOBAL_SETTINGS_TAB_ID);
    setDeliverySettings(null);
    setBrowsing(false);
  }, []);
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
      h(Tooltip, { label: localizeText('帮助与反馈 · 前往 GitHub'), side: 'bottom' },
        h('a', {
          className: 'dim-githubLink',
          href: 'https://github.com/xmanrui/dsh-im',
          target: '_blank',
          rel: 'noopener noreferrer',
          'aria-label': 'dsh-im GitHub',
        },
        h('svg', {
          width: 18,
          height: 18,
          viewBox: '0 0 16 16',
          fill: 'currentColor',
          focusable: 'false',
          'aria-hidden': 'true',
        }, h('path', {
          d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z',
        })))),
      h(Tooltip, { label: localizeText('通用设置'), side: 'bottom' },
        h(IconButton, {
          id: 'dim-general-settings-trigger',
          className: 'dim-generalSettingsButton',
          label: '通用设置',
          'aria-controls': `dim-panel-${GLOBAL_SETTINGS_TAB_ID}`,
          'aria-current': globalSettingsSelected ? 'page' : undefined,
          onClick: openGlobalSettings,
        }, h(GlobalSettingsLogoGlyph, { size: 17 }))),
      ),
    ),
    h('div', { className: 'dim-layout' },
      h('main', {
        className: 'dim-panel',
        id: activePanelId,
        'aria-labelledby': panelLabelledBy,
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
          : browsing
          // Lobe layout: the entry page is a grouped card grid; configuration
          // opens only after picking a channel (issue #247 (h)).
          ? h(ProviderGrid, {
              visibleChannels,
              statusById: providerStatus.statusById,
              onOpen: openChannel,
            })
          : h(React.Fragment, null,
            h(ChannelPageHeader, { channel: active, onBack: goBackToProviders }),
            deliverySettings?.channel === active.id
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
                            : active.id === 'email'
                              ? h(EmailSettingsTab, { rpcCall: rpcCalls.emailRpcCall })
                            : active.id === 'matrix'
                              ? h(MatrixSettingsTab, { rpcCall: rpcCalls.matrixRpcCall })
                            : h(OfficeSettingsTab, { rpcCall: rpcCalls.officeRpcCall }))))),
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
      installEmailStyles(),
      installMatrixStyles(),
      installOfficeStyles(),
      installImStyles(),
      installUiStyles(),
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
  const emailRpcCall = (endpoint, payload, signal) =>
    callManagementRpc(ctx.connection, EMAIL_RPC_CHANNEL, endpoint, payload, signal);
  const matrixRpcCall = (endpoint, payload, signal) =>
    callManagementRpc(ctx.connection, MATRIX_RPC_CHANNEL, endpoint, payload, signal);
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

  const panelDependencies = {
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
    emailRpcCall,
    matrixRpcCall,
    updateRpcCall,
    deliveryRpcCall,
    globalSettingsRpcCall,
    workspaceDirectoryPicker,
  };
  const subscribeLocale = (listener) => typeof ctx.on === 'function'
    ? ctx.on('locale/change', listener) : () => {};
  const localeSnapshot = () => ctx.locale.getLocale?.()?.active ?? '';

  // Stable for this plugin lifetime: creating an element must not create a
  // new component type and reset the reader's selected tab or unsaved input.
  function IMPanel({ preferredSectionId }) {
    React.useSyncExternalStore(subscribeLocale, localeSnapshot, localeSnapshot);
    return h(IMPanelErrorBoundary, null,
      h(IMSettingsTab, { ...panelDependencies, preferredSectionId }));
  }
  const buildPanelElement = (props = {}) => h(IMPanel, {
    preferredSectionId: props.preferredSectionId,
  });

  ctx.effect(() => {
    let disposed = false;
    let stopSettings = null;
    let registered = false;
    const setSettingsVisible = (visible) => {
      if (disposed) return;
      if (typeof visible !== 'boolean') throw new TypeError('visible must be a boolean');
      if (visible === (stopSettings !== null)) return;
      if (!visible) {
        const stop = stopSettings;
        stopSettings = null;
        stop();
        return;
      }
      // The existing slot controller owns late declarations, withdrawal and
      // re-declaration. Cancelling it also cancels a pending registration.
      stopSettings = ctx.slots.inject('settings.section', () => {
        const unregister = ctx.slots.register({
          name: 'settings.section',
          id: 'xmanrui-dsh-im',
          order: 21,
          label: () => t('IM机器人'),
          locale: IM_LOCALE_NAMESPACE,
          inject: () => panelDependencies,
        }, buildPanelElement);
        registered = true;
        return () => {
          registered = false;
          unregister();
        };
      });
    };

    // Publish only after the default registration is established, so a
    // consumer hiding it during service discovery cannot be overridden.
    setSettingsVisible(true);
    if (typeof ctx.provide === 'function') {
      ctx.provide('dshImClient', Object.freeze({
        version: 1,
        render: (props) => disposed ? null : buildPanelElement(props),
        setSettingsVisible,
        settingsVisible: () => !disposed && registered,
      }));
    }
    return () => {
      disposed = true;
      const stop = stopSettings;
      stopSettings = null;
      registered = false;
      stop?.();
    };
  }, 'im-settings: client panel service');
}
