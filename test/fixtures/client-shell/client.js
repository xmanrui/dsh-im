// Manual smoke consumer, installed only in a local test profile. This file is
// deliberately outside the package's published files; the IM plugin itself
// must never depend on the Tauri shell or register its private sidebar slots.
window.__ModuleLoader__.load({
  id: 'dsh-im-client-smoke',
  factory: (require) => {
    const React = require('react');
    const { definePanel } = require('dsh-tauri');
    const h = React.createElement;
    return {
      name: 'dsh-im-client-smoke',
      inject: ['slots', 'layout', 'dshImClient'],
      apply(ctx) {
        const im = ctx.dshImClient;
        if (im.version !== 1) throw new Error('Unsupported IM client service');
        let stopIntegration = null;
        let panel = null;
        let revision = 0;
        const listeners = new Set();
        const notify = () => { revision += 1; for (const fn of listeners) fn(); };
        const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
        const toggle = (visible) => { im.setSettingsVisible(visible); notify(); };
        const disable = () => {
          const stop = stopIntegration;
          stopIntegration = null;
          stop?.();
          notify();
        };
        const enable = () => {
          if (stopIntegration) return;
          stopIntegration = ctx.slots.inject('main', () =>
            ctx.slots.inject('sidebar.panellist', () => {
              panel = definePanel(ctx, {
                id: 'dsh-im-smoke', label: 'IM 接入测试', order: 90,
                icon: () => h('span', { 'aria-label': 'IM 接入测试' }, 'IM'),
                render: Panel,
              });
              im.setSettingsVisible(false);
              notify();
              return () => {
                im.setSettingsVisible(true);
                panel.dispose();
                panel = null;
                notify();
              };
            }));
          notify();
        };
        function Controls() {
          React.useSyncExternalStore(subscribe, () => revision, () => revision);
          return h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 } },
            h('strong', null, `IM API v${im.version} · settings=${im.settingsVisible()} · ${window.parent === window ? 'browser' : 'desktop'}`),
            h('button', { onClick: () => toggle(true) }, '恢复设置入口'),
            h('button', { onClick: () => toggle(false) }, '隐藏设置入口'),
            h('button', { onClick: enable }, '启用侧栏接入'),
            h('button', { onClick: () => panel?.select() }, '打开 IM 面板'),
            h('button', { onClick: disable }, '停用侧栏接入'));
        }
        function Panel() {
          const [generation, remount] = React.useReducer((n) => n + 1, 0);
          return h('div', { style: { height: '100%', overflow: 'auto', padding: 24, boxSizing: 'border-box' } },
            h(Controls),
            h('button', { onClick: remount, style: { marginBottom: 16 } }, '重新挂载面板'),
            h(React.Fragment, { key: generation }, im.render()));
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'im-client-smoke', order: 22, label: 'IM 接入验证',
        }, Controls));
        // Only the desktop opts in. Another browser on the same Host keeps its
        // default IM settings entry until its own user explicitly changes it.
        if (window.parent !== window) enable();
        return disable;
      },
    };
  },
});
