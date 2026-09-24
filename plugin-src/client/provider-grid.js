/**
 * The Lobe-style provider list that replaces the always-open channel rail
 * (issue #247 (h): 选项与配置同页导致信息嘈杂).
 *
 * Entry page: channels grouped into 已启用 / 未启用 cards (logo + name +
 * description + a real status badge on the right). Picking a card drills into
 * that channel's existing configuration page, which keeps its own component
 * untouched.
 *
 * The badge is derived from real Host state through `provider-catalog.js`; this
 * plugin has no channel enable/disable RPC, so the grid reports status instead
 * of pretending to toggle it.
 */

import * as React from 'react';

import { h } from './i18n.js';
import { ChannelLogo, CHANNELS } from './channel-catalog.js';
import { probeProviderStatus } from './provider-catalog.js';
import { Tag } from './ui/index.js';

/** One line under the channel name in each card. Keys are `CHANNELS` ids. */
const PROVIDER_DESCRIPTIONS = Object.freeze({
  weixin: '个人微信扫码接入，长轮询收发消息',
  feishu: '飞书扫码或手动接入，支持多机器人与群聊',
  dingtalk: '钉钉 Stream 长连接，扫码授权接入',
  wecom: '企业微信智能机器人，WebSocket 长连接',
  qq: 'QQ 官方机器人，扫码创建并绑定',
  slack: 'Socket Mode 长连接，Manifest 快速配置',
  telegram: 'Bot Token 接入，支持命令菜单',
  discord: 'Developer Portal 创建 Bot 后邀请接入',
  whatsapp: '扫码关联设备，个人号收发消息',
  wecomApp: '企业微信应用回调通道，需配置回调 URL',
  imessage: 'macOS 原生 Messages，需本机权限',
  email: 'IMAP/SMTP 邮箱或腾讯 Agent 邮箱',
  matrix: 'homeserver 与凭据接入',
  office: 'AI Office Connector 工作台接入',
});

/**
 * Derive a card badge from real Host state.
 *
 * `label` is always a dictionary key that already has an English projection,
 * and `count` is a locale-independent `connected/configured` figure, so the
 * badge never needs a per-channel translated sentence.
 */
function statusBadge(totals, enabled) {
  if (totals === null) {
    return enabled ? { tone: 'neutral', label: '未接入', count: '' } : null;
  }
  if (totals.connected > 0) {
    return {
      tone: 'success',
      label: '在线',
      count: totals.configured > 1 ? `${totals.connected}/${totals.configured}` : '',
    };
  }
  if (totals.configured > 0) return { tone: 'warning', label: '离线', count: '' };
  return { tone: 'neutral', label: '未配置', count: '' };
}

/**
 * Render one provider card. The whole card is the drill-down control; the badge
 * is decorative so the accessible name stays the channel name.
 */
function ProviderCard({ channel, label, note, totals, available, onOpen }) {
  const badge = statusBadge(totals, available);
  return h('button', {
    key: channel,
    type: 'button',
    className: 'dim-providerCard',
    'data-im-provider': channel,
    onClick: () => onOpen(channel),
  },
  h(ChannelLogo, { channel }),
  h('span', { className: 'dim-providerCardCopy' },
    h('span', { className: 'dim-providerCardName' },
      h('strong', null, label),
      note ? h('small', { className: 'dim-providerCardNote' }, note) : null),
    h('span', { className: 'dim-providerCardDesc' }, PROVIDER_DESCRIPTIONS[channel] ?? '')),
  badge
    ? h(Tag, { tone: badge.tone, className: 'dim-providerCardBadge' },
        badge.count ? h('span', { className: 'dim-providerCardCount' }, badge.count) : null,
        badge.label)
    : null);
}

/**
 * The entry page: every visible channel in one grouped card grid.
 * @param props.visibleChannels channels to show (email is omitted while closed).
 * @param props.statusById `channel id -> totals | null` from the Host probes.
 * @param props.onOpen enters a channel's configuration page.
 */
export function ProviderGrid({ visibleChannels, statusById, onOpen }) {
  const enabled = [];
  const disabled = [];
  for (const channel of visibleChannels) {
    const totals = statusById[channel.id] ?? null;
    // "Enabled" means the Host actually reports this channel as configured.
    if (totals !== null && totals.configured > 0) enabled.push(channel);
    else disabled.push(channel);
  }

  const renderGroup = (title, channels, count) => channels.length === 0 ? null : h('section', {
    className: 'dim-providerGroup',
    'aria-label': title,
  },
  h('h3', { className: 'dim-providerGroupTitle' },
    h('span', null, title),
    h('span', { className: 'dim-providerGroupCount' }, count)),
  h('div', { className: 'dim-providerGrid' },
    channels.map((channel) => h(ProviderCard, {
      key: channel.id,
      channel: channel.id,
      label: channel.label,
      note: channel.note,
      totals: statusById[channel.id] ?? null,
      available: true,
      onOpen,
    }))));

  return h('div', { className: 'dim-providers' },
    renderGroup('已启用服务商', enabled, String(enabled.length)),
    renderGroup('未启用服务商', disabled, String(disabled.length)));
}

/**
 * Load every provider's status once per mount (and on demand).
 * @returns `{ statusById, loading, reload }`.
 */
export function useProviderStatus(visibleChannels, rpcCalls) {
  const [statusById, setStatusById] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [revision, setRevision] = React.useState(0);

  const ids = visibleChannels.map((channel) => channel.id).join(',');
  React.useEffect(() => {
    let cancelled = false;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    setLoading(true);
    void Promise.all(visibleChannels.map(async (channel) => [
      channel.id,
      await probeProviderStatus(channel.id, rpcCalls[`${channel.id}RpcCall`], controller?.signal),
    ])).then((entries) => {
      if (cancelled) return;
      setStatusById(Object.fromEntries(entries));
      setLoading(false);
    });
    return () => {
      cancelled = true;
      controller?.abort();
    };
    // `ids` captures exactly which channels are visible; `rpcCalls` is stable
    // for the plugin lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, revision]);

  return {
    statusById,
    loading,
    reload: React.useCallback(() => setRevision((value) => value + 1), []),
  };
}

export { CHANNELS };
