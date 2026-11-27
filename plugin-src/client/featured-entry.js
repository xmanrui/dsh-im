// Featured plugins inline entry — integration with the community "精选插件"
// (dsh-featured) ecosystem. See https://github.com/skillpie/dsh-plugins
// (dsh-featured/AI-INTEGRATION.md) for the integration contract.
//
// What this does:
//   - Registers a lightweight 「精选插件」 tab on the official Plugins page so
//     users who install only dsh-im still get the entry; opening it offers a
//     one-click install of the full `dsh-featured` plugin, which then takes
//     over (search, filtering, README details, apply-for-listing).
//   - Yields when the full plugin is present (`window.__DSH_FEATURED_FULL__`),
//     so exactly one tab exists regardless of plugin activation order.
//
// Being listed in the featured catalog is decided solely by the skillpie.cn
// review flow — integration only provides the entry and makes no promise
// about listing. Copy lives in the IM dictionary (i18n.js), like the rest of
// this plugin's UI strings.
import * as React from 'react';
import { IM_LOCALE_NAMESPACE, localizeText } from './i18n.js';

const h = React.createElement;
const FULL_PKG = 'dsh-featured';

const S = {
  wrap: { padding: '24px 16px', maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 12 },
  desc: { fontSize: 13, lineHeight: 1.7, margin: 0, color: 'var(--dsw-alias-label-secondary)' },
  note: { fontSize: 13, lineHeight: 1.7, margin: 0, color: 'var(--dsw-alias-label-primary)' },
  btn: {
    alignSelf: 'flex-start', cursor: 'pointer', font: 'inherit', fontSize: 13, fontWeight: 500,
    padding: '7px 16px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-brand-primary)', color: '#fff',
  },
  btnOff: { opacity: 0.6, cursor: 'default' },
};

function FeaturedSection(props) {
  const install = props.install;
  const [st, setSt] = React.useState('idle'); // idle | running | installed

  const openInstall = () => {
    if (st !== 'idle' || typeof install !== 'function') return;
    setSt('running');
    try {
      install({ spec: FULL_PKG, title: localizeText('精选插件'), version: '' });
      setSt('installed');
    } catch {
      setSt('installed');
    }
  };

  React.useEffect(() => {
    if (st !== 'idle') return;
    if (typeof install !== 'function') { setSt('installed'); return; }
    setSt('running');
    try {
      install({ spec: FULL_PKG, title: localizeText('精选插件'), version: '' });
      setSt('installed');
    } catch {
      setSt('installed');
    }
  }, [st, install]);

  const label = st === 'running' ? localizeText('正在安装完整版…')
    : (st === 'installed' ? localizeText('已安装') : localizeText('安装完整版'));

  return h('div', { style: S.wrap },
    h('p', { style: S.desc }, localizeText('一个入口逛完社区精选的好插件:搜索、标签筛选、一键安装、README 详情。')),
    st === 'idle' ? h('p', { style: S.note }, localizeText('精选插件完整版(dsh-featured)未安装。')) : null,
    h('button', {
      type: 'button',
      style: Object.assign({}, S.btn, st === 'installed' ? S.btnOff : {}),
      disabled: st === 'installed',
      onClick: openInstall,
    }, label));
}

// Registers the inline entry on the plugin client context. Returns a disposer.
export function installFeaturedEntry(ctx) {
  if (typeof window === 'undefined') return () => {};
  if (window.__DSH_FEATURED_APPLIED__) return () => {};
  window.__DSH_FEATURED_APPLIED__ = true;
  if (window.__DSH_FEATURED_FULL__) {
    // Full dsh-featured plugin is loaded: yield so there is never a double tab.
    return () => { window.__DSH_FEATURED_APPLIED__ = false; };
  }
  let tabDisposable = null;
  try {
    ctx.slots.inject('plugins.tab', () => {
      tabDisposable = ctx.slots.register({
        name: 'plugins.tab',
        id: 'dsh-plugins-plugin',
        label: () => ctx.locale.bind(IM_LOCALE_NAMESPACE)('精选插件'),
        locale: IM_LOCALE_NAMESPACE,
        priority: 100,
      }, FeaturedSection);
      return tabDisposable;
    }, 'dsh-plugins-plugin: featured tab');
    window.__DSH_FEATURED_ENTRY__ = {
      kind: 'inline',
      dispose() {
        try { if (typeof tabDisposable === 'function') tabDisposable(); } catch { /* already gone */ }
        window.__DSH_FEATURED_APPLIED__ = false;
        window.__DSH_FEATURED_ENTRY__ = null;
      },
    };
  } catch (error) {
    console.error('[featured] inline entry failed to register', error);
    window.__DSH_FEATURED_APPLIED__ = false;
  }
  return () => {
    try { window.__DSH_FEATURED_ENTRY__?.dispose?.(); } catch { /* already gone */ }
  };
}
