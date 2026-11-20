import * as React from 'react';

import { h } from './i18n.js';
import { PROXY_SETTINGS_ENDPOINTS } from './proxy-settings.js';

/**
 * The per-channel opt-out from the proxy configured on the proxy page.
 *
 * The proxy exists so a blocked network still reaches its messenger. A channel
 * running somewhere the route is already short — a self-hosted bot next to the
 * host, a network the operator reaches directly — should be able to say so
 * without editing the plugin config, so the switch lives on the channel's own
 * form and writes `bypass` into the same document as the proxy itself.
 *
 * Only channels whose HTTP client accepts the dispatcher can honour it. The
 * rest open their own sockets inside their SDKs (email speaks IMAP/SMTP, the
 * Feishu and WeCom long connections live in their libraries), so the switch is
 * not offered there rather than shown and ignored.
 */
export const PROXY_CAPABLE_CHANNELS = Object.freeze(['telegram']);

function unwrap(result) {
  if (result?.ok === true) return result.value;
  if (result?.ok === false) {
    const error = new Error(result.error?.message || '无法读取或保存代理设置，请稍后重试。');
    error.code = result.error?.code;
    throw error;
  }
  return result;
}

function bypassList(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

export function ChannelProxyToggle({ channel, proxyRpcCall }) {
  const capable = PROXY_CAPABLE_CHANNELS.includes(channel);
  const [bypassed, setBypassed] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const id = React.useId();

  React.useEffect(() => {
    if (!capable || typeof proxyRpcCall !== 'function') return undefined;
    const controller = new AbortController();
    let live = true;
    void (async () => {
      try {
        const settings = unwrap(
          await proxyRpcCall(PROXY_SETTINGS_ENDPOINTS.get, {}, controller.signal),
        );
        if (live) setBypassed(bypassList(settings?.bypass).includes(channel));
      } catch {
        // A switch that cannot read its own state would lie about it: stay hidden.
        if (live) setBypassed(null);
      }
    })();
    return () => {
      live = false;
      controller.abort();
    };
  }, [capable, channel, proxyRpcCall]);

  if (!capable || bypassed === null) return null;

  const onChange = async (event) => {
    const next = event.target.checked;
    setBypassed(next);
    setSaving(true);
    try {
      const current = unwrap(
        await proxyRpcCall(PROXY_SETTINGS_ENDPOINTS.get, {}),
      );
      const rest = bypassList(current?.bypass).filter((entry) => entry !== channel);
      const bypass = next ? [...rest, channel] : rest;
      unwrap(await proxyRpcCall(PROXY_SETTINGS_ENDPOINTS.set, { bypass }));
    } catch {
      setBypassed(!next);
    } finally {
      setSaving(false);
    }
  };

  return h('section', {
    className: 'dim-globalSection dim-channelProxyToggle',
    'aria-label': '代理',
  },
  h('div', { className: 'dim-deliverySyncField' },
    h('div', { className: 'dim-deliverySyncLabel' },
      h('label', { className: 'dim-deliverySyncCheckLabel', htmlFor: `${id}-bypass` },
        h('input', {
          id: `${id}-bypass`,
          type: 'checkbox',
          checked: bypassed,
          disabled: saving,
          onChange,
        }),
        h('span', null, '不使用已配置的代理')),
      h('p', { className: 'dim-deliverySyncHelp' },
        '勾选后对该机器人的请求将直连，绕过代理页面里配置的代理。')),
  ));
}
