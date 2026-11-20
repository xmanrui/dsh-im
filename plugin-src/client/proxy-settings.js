import * as React from 'react';

import {
  DEFAULT_PROXY_SETTINGS,
  PROXY_TYPES,
  normalizeProxySettings,
  proxySettingsProblem,
} from '../../src/channels/shared/proxy-settings.mjs';
import { h } from './i18n.js';

/**
 * The IM proxy page: one place for the proxy that every channel uses unless it
 * opts out in its own config.
 *
 * The page has to be honest about two things. First, that the setting exists
 * because IM networks are blocked unevenly across regions. Second, that it does
 * not cover every transport in the plugin — email speaks IMAP/SMTP on its own
 * sockets, and the Feishu/WeCom long connections are opened inside their SDKs,
 * so a proxy cannot be pushed through them from here.
 */
export const PROXY_RPC_CHANNEL = '/dsh-im-proxy';

export const PROXY_SETTINGS_ENDPOINTS = Object.freeze({
  get: 'settings.proxy.get',
  set: 'settings.proxy.set',
  check: 'settings.proxy.check',
});

const TYPE_LABELS = Object.freeze({
  'socks5h': 'SOCKS5H（域名由代理解析，推荐）',
  'socks5': 'SOCKS5（域名在本地解析）',
  http: 'HTTP',
  https: 'HTTPS',
});

function unwrap(result) {
  if (result?.ok === true) return result.value;
  if (result?.ok === false) {
    const error = new Error(result.error?.message || '无法读取或保存代理设置，请稍后重试。');
    error.code = result.error?.code;
    throw error;
  }
  return result;
}

export function ProxySettings({ rpcCall }) {
  const [values, setValues] = React.useState(DEFAULT_PROXY_SETTINGS);
  const [phase, setPhase] = React.useState('loading');
  const [error, setError] = React.useState(null);
  const [saved, setSaved] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [checkResult, setCheckResult] = React.useState(null);
  const id = React.useId();
  const disabled = phase === 'loading' || phase === 'saving';

  const load = React.useCallback(async (signal) => {
    setPhase('loading');
    setError(null);
    setSaved(false);
    try {
      if (typeof rpcCall !== 'function') throw new Error('代理设置通道不可用。');
      const settings = normalizeProxySettings(unwrap(await rpcCall(PROXY_SETTINGS_ENDPOINTS.get, {}, signal)))
        ?? DEFAULT_PROXY_SETTINGS;
      setValues(settings);
      setPhase('ready');
    } catch (cause) {
      if (cause?.name === 'AbortError') return;
      setPhase('error');
      setError(cause?.message ?? '无法读取代理设置。');
    }
  }, [rpcCall]);

  React.useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const edit = (patch) => {
    setSaved(false);
    setError(null);
    setValues((current) => ({ ...current, ...patch }));
  };

  const check = async () => {
    if (checking) return;
    setChecking(true);
    setCheckResult(null);
    try {
      const result = unwrap(await rpcCall(PROXY_SETTINGS_ENDPOINTS.check, {}));
      setCheckResult({ ok: true, result });
    } catch (cause) {
      setCheckResult({ ok: false, error: cause?.message ?? '无法检查代理。' });
    } finally {
      setChecking(false);
    }
  };

  const problem = proxySettingsProblem(values);

  const save = async (event) => {
    event?.preventDefault?.();
    if (disabled) return;
    setPhase('saving');
    setError(null);
    setSaved(false);
    try {
      const settings = normalizeProxySettings(
        unwrap(await rpcCall(PROXY_SETTINGS_ENDPOINTS.set, { ...values })),
      ) ?? DEFAULT_PROXY_SETTINGS;
      setValues(settings);
      setPhase('ready');
      setSaved(true);
    } catch (cause) {
      setPhase('error');
      setError(cause?.message ?? '无法保存代理设置。');
    }
  };

  const help = h('div', { className: 'dim-deliverySyncField' },
    h('p', { className: 'dim-deliverySyncHelp' },
      '在某些地区，部分 IM 服务不可达：Telegram 在一个国家打不开，Discord 在另一个国家打不开，而通道本身必须连上才收得到消息。这里配置的代理会用于所有仍在使用它的通道。'),
    h('p', { className: 'dim-deliverySyncHelp' },
      '代理不覆盖以下传输：邮件（IMAP/SMTP 走自己的套接字）、飞书和企业微信的长连接（套接字在各自的 SDK 内部建立），以及节点的 WebSocket。'),
    h('p', { className: 'dim-deliverySyncHelp' },
      '某个通道可以在它自己的设置里写 proxy: false，那样它会忽略这里的代理。'));

  const typeField = h('div', { className: 'dim-deliverySyncField' },
    h('div', { className: 'dim-deliverySyncLabel' },
      h('label', { htmlFor: `${id}-type` }, '代理类型')),
    h('select', {
      id: `${id}-type`,
      className: 'dim-globalTtlInput dim-deliverySyncSelect',
      value: values.type,
      disabled,
      onChange: (event) => edit({ type: event.target.value }),
    }, ...PROXY_TYPES.map((type) => h('option', { key: type, value: type }, TYPE_LABELS[type] ?? type))));

  const hostField = h('div', { className: 'dim-deliverySyncField' },
    h('div', { className: 'dim-deliverySyncLabel' },
      h('label', { htmlFor: `${id}-host` }, '主机'),
      h('p', { className: 'dim-deliverySyncHelp' }, 'IP 或域名，不带协议前缀。')),
    h('input', {
      id: `${id}-host`,
      className: 'dim-globalTtlInput',
      type: 'text',
      value: values.host,
      placeholder: 'proxy.example',
      autoComplete: 'off',
      spellCheck: false,
      disabled,
      onChange: (event) => edit({ host: event.target.value }),
    }));

  const portField = h('div', { className: 'dim-deliverySyncField' },
    h('div', { className: 'dim-deliverySyncLabel' },
      h('label', { htmlFor: `${id}-port` }, '端口'),
      h('p', { className: 'dim-deliverySyncHelp' }, '留空则使用该类型的默认端口。')),
    h('input', {
      id: `${id}-port`,
      className: 'dim-globalTtlInput',
      type: 'text',
      inputMode: 'numeric',
      value: values.port,
      placeholder: values.type.startsWith('socks5') ? '1080' : '3128',
      autoComplete: 'off',
      disabled,
      onChange: (event) => edit({ port: event.target.value.replace(/[^\d]/g, '') }),
    }));

  const anonymousField = h('div', { className: 'dim-deliverySyncField' },
    h('div', { className: 'dim-deliverySyncLabel' },
      h('label', { className: 'dim-deliverySyncCheckLabel', htmlFor: `${id}-anonymous` },
        h('input', {
          id: `${id}-anonymous`,
          type: 'checkbox',
          checked: values.anonymous,
          disabled,
          onChange: (event) => edit({ anonymous: event.target.checked }),
        }),
        h('span', null, '免密码访问')),
      h('p', { className: 'dim-deliverySyncHelp' }, '代理接受不带用户名和密码的连接。')));

  const credentials = values.anonymous ? null : h('div', { className: 'dim-deliverySyncField' },
    h('div', { className: 'dim-deliverySyncLabel' },
      h('label', { htmlFor: `${id}-username` }, '用户名')),
    h('input', {
      id: `${id}-username`,
      className: 'dim-globalTtlInput',
      type: 'text',
      value: values.username,
      autoComplete: 'off',
      spellCheck: false,
      disabled,
      onChange: (event) => edit({ username: event.target.value }),
    }),
    h('div', { className: 'dim-deliverySyncLabel' },
      h('label', { htmlFor: `${id}-password` }, '密码')),
    h('input', {
      id: `${id}-password`,
      className: 'dim-globalTtlInput',
      type: 'password',
      value: values.password,
      autoComplete: 'new-password',
      disabled,
      onChange: (event) => edit({ password: event.target.value }),
    }));

  const enabledField = h('div', { className: 'dim-deliverySyncField' },
    h('div', { className: 'dim-deliverySyncLabel' },
      h('label', { className: 'dim-deliverySyncCheckLabel', htmlFor: `${id}-enabled` },
        h('input', {
          id: `${id}-enabled`,
          type: 'checkbox',
          checked: values.enabled,
          disabled,
          onChange: (event) => edit({ enabled: event.target.checked }),
        }),
        h('span', null, '使用代理')),
      h('p', { className: 'dim-deliverySyncHelp' },
        '关闭时代理不生效，通道像以前一样直连。')));

  // Everything below the switch only means something while the proxy is on:
  // a disabled proxy with a half-filled host is noise, not a setting.
  const details = values.enabled
    ? h(React.Fragment, null, typeField, hostField, portField, anonymousField, credentials)
    : null;

  const actions = h('div', { className: 'dim-imageSettingsActions' },
    h('button', {
      type: 'submit',
      className: 'dim-deliveryButton dim-globalSaveButton',
      'data-kind': 'primary',
      disabled,
    }, phase === 'saving' ? '正在保存…' : '保存代理设置'),
    h('button', {
      type: 'button',
      className: 'dim-deliveryButton dim-globalSaveButton',
      disabled: checking,
      onClick: () => void check(),
    }, checking ? '正在检查代理…' : '检查代理'),
    phase === 'error'
      ? h('button', {
        type: 'button',
        className: 'dim-deliveryButton dim-globalSaveButton',
        onClick: () => void load(),
      }, '重试')
      : null);

  return h('section', {
    className: 'dim-globalSection dim-proxySettings',
    'aria-label': '网络',
    'aria-busy': phase === 'loading' || phase === 'saving',
  },
  help,
  h('form', { onSubmit: save },
    h('div', { className: 'dim-deliverySyncFields' },
      enabledField, details),
    problem === 'host-required'
      ? h('p', { className: 'dim-globalInline', 'data-tone': 'error', role: 'alert' },
        '请填写代理主机，否则设置不会生效。')
      : problem === 'username-required'
        ? h('p', { className: 'dim-globalInline', 'data-tone': 'error', role: 'alert' },
          '请填写用户名，或勾选「免密码访问」。')
        : null,
    actions),
  error
    ? h('p', {
      className: 'dim-globalInline dim-deliverySyncFeedback',
      'data-tone': 'error',
      role: 'alert',
    }, error)
    : null,
  checkResult
    ? h('div', { className: 'dim-globalInline dim-deliverySyncFeedback', role: 'status' },
      checkResult.ok
        ? [
          h('p', { key: 'head' }, `${checkResult.result.proxy} · ${checkResult.result.ms} ms`),
          ...checkResult.result.results.map((row) => h('p', { key: row.id },
            row.ok
              ? `${row.id} · HTTP ${row.status} · ${row.ms} ms`
              : `${row.id} · ${row.ms} ms · ${row.error}`)),
        ]
        : h('p', null, checkResult.error))
    : null,
  saved ? h('p', { className: 'dim-globalInline dim-deliverySyncFeedback', role: 'status' }, '已保存') : null,
  saved
    ? h('p', { className: 'dim-globalInline dim-deliverySyncFeedback', role: 'status' },
      '保存后按机器人卡片上的「检查连接」（未连接时是「重试连接」）即可让新设置生效。')
    : null,
  phase === 'loading'
    ? h('p', { className: 'dim-globalInline dim-deliverySyncFeedback', role: 'status' }, '正在读取代理设置…')
    : null);
}
