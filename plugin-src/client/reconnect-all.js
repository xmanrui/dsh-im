import * as React from 'react';

import { h } from './i18n.js';

/**
 * One operator action for the whole page: re-create every bot's runtime.
 *
 * After a network change (a proxy, a blocked route, a new exit) the bots sit in
 * a failed state until each card is visited and reconnected by hand. This button
 * does exactly what those cards do, for all of them, and reports how many came
 * back — the same `bot.reconnect` path, so nothing here is a shortcut past the
 * channel's own logic.
 */
export const OPS_RPC_CHANNEL = '/dsh-im-ops';

export const OPS_ENDPOINTS = Object.freeze({
  reconnectAll: 'bots.reconnect-all',
});

function unwrap(result) {
  if (result?.ok === true) return result.value;
  if (result?.ok === false) {
    const error = new Error(result.error?.message || '无法重连机器人。');
    error.code = result.error?.code;
    throw error;
  }
  return result;
}

export function ReconnectAllButton({ rpcCall }) {
  const [phase, setPhase] = React.useState('idle');
  const [summary, setSummary] = React.useState(null);
  const disabled = typeof rpcCall !== 'function' || phase === 'running';

  const run = async () => {
    if (disabled) return;
    setPhase('running');
    setSummary(null);
    try {
      const value = unwrap(await rpcCall(OPS_ENDPOINTS.reconnectAll, {}));
      setSummary({ reconnected: value.reconnected ?? 0, failed: value.failed ?? 0 });
      setPhase('idle');
    } catch (error) {
      setSummary({ error: error?.message ?? '无法重连机器人。' });
      setPhase('error');
    }
  };

  return h('div', { className: 'dim-reconnectAll' },
    h('button', {
      type: 'button',
      className: 'dim-deliveryButton',
      disabled,
      onClick: () => void run(),
    }, phase === 'running' ? '重连中…' : '全部重连'),
    summary && summary.error
      ? h('span', { className: 'dim-globalInline', 'data-tone': 'error', role: 'alert' }, summary.error)
      : null,
    summary && !summary.error
      ? h('span', { className: 'dim-globalInline', role: 'status' },
        `✓ ${summary.reconnected} · ✗ ${summary.failed}`)
      : null);
}
