export const WECOM_APP_STYLE_ID = 'xmanrui-dsh-im-wecom-app-settings';

const CSS = String.raw`
.dwecomapp-page { --ddt-accent: #07c160; --ddt-accent-deep: #059a4c; --ddt-accent-wash: #eefaf3; }
.dwecomapp-avatar, .dwecomapp-brand { color: #07c160; background: #fff; border: 0.5px solid var(--dsw-alias-border-l2, #e5e6eb); }
.dwecomapp-avatar svg, .dwecomapp-brand svg { display: block; }
.dim-appFieldGrid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.dim-callbackBox { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 1px dashed var(--dsw-alias-border-l3, #e5e6eb); border-radius: 8px; }
.dim-callbackBox strong { font-size: 12px; color: var(--dsw-alias-label-secondary, #646a73); }
.dim-callbackRow { display: flex; gap: 8px; align-items: center; }
.dim-callbackRow input { flex: 1 1 auto; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.dim-appSwitchRow { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 13px; }
/* Both were mounted with no rule at all (wecom-app/index.js:161,190), so the
   text fell back to the browser default. Native gives help text under a
   control this shape (ui-settings-plugins .hint). */
.dim-switchHint, .dim-callbackHint { flex: 1 1 100%; margin: 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; line-height: 1.5; }
/* The streaming toggle is a labelled boolean, so it takes the native outline
   capsule every other action in the panel uses, plus the native pressed
   surface - the same pair .dim-credentialButton already uses. */
.dim-streamToggle { height: 28px; display: inline-flex; align-items: center; justify-content: center; padding: 0 10px; border: var(--dim-control-border); border-radius: 14px; color: var(--dsw-alias-label-primary, #0f1115); background: transparent; font-size: 12px; line-height: 18px; cursor: pointer; }
.dim-streamToggle:hover:not(:disabled) { background: var(--dim-hover-solid); }
.dim-streamToggle[aria-pressed="true"] { border-color: transparent; background: var(--dsw-specific-sidebar-nav-item-active, #ebeef2); }
`;

export function installWecomAppStyles() {
  if (typeof document === 'undefined') return () => {};
  const existing = document.querySelector(`style[data-plugin-css="${WECOM_APP_STYLE_ID}"]`);
  if (existing) return () => {};
  const style = document.createElement('style');
  style.dataset.plugin = '@xmanrui/dsh-im';
  style.dataset.pluginCss = WECOM_APP_STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => style.remove();
}
