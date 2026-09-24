// Persistent local desktop integration; standalone Web keeps its settings entry.
window.__ModuleLoader__.load({
  id: 'dsh-im-desktop-panel',
  factory: (require) => {
    const React = require('react');
    const { definePanel } = require('dsh-tauri');
    const h = React.createElement;
    function Icon(props) {
      return h('svg', { ...props, width: 18, height: 18, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5 9.2 9.2 0 0 1-4-.9L3 21l1.9-5.5a9.2 9.2 0 0 1-.9-4A8.5 8.5 0 0 1 12.5 3H13a8.5 8.5 0 0 1 8 8v.5Z' }),
        h('path', { d: 'M8 11.5h.01M12 11.5h.01M16 11.5h.01' }));
    }
    return {
      name: 'dsh-im-desktop-panel',
      inject: ['slots', 'layout', 'locale', 'dshImClient'],
      apply(ctx) {
        // This profile also serves ordinary browser tabs. Only its desktop
        // iframe opts in; no host configuration or shared visibility is written.
        if (window.parent === window || ctx.dshImClient.version !== 1) return;
        const im = ctx.dshImClient;
        const t = ctx.locale.bind('dsh-im');
        function Panel() {
          return h('div', { style: { height: '100%', overflow: 'auto',
            padding: 24, boxSizing: 'border-box' } }, im.render());
        }
        return ctx.slots.inject('main', () =>
          ctx.slots.inject('sidebar.panellist', () => {
            const panel = definePanel(ctx, {
              id: 'dsh-im', label: () => t('IM机器人'), order: 30, icon: Icon, render: Panel,
            });
            im.setSettingsVisible(false);
            return () => {
              im.setSettingsVisible(true);
              panel.dispose();
            };
          }));
      },
    };
  },
});
