export const WECOM_APP_STYLE_ID = 'xmanrui-dsh-im-wecom-app-settings';

const CSS = String.raw`
.dwecomapp-page.dim-channelPage { --ddt-accent: #07c160; --ddt-accent-deep: #059a4c; --ddt-accent-wash: #eefaf3; }
.dwecomapp-avatar.dim-botAvatar, .dwecomapp-brand.dim-emptyBrand { color: #07c160; background: #fff; border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); }
.dwecomapp-avatar svg, .dwecomapp-brand svg { display: block; }
.dim-appFieldGrid { display: grid; gap: var(--dim-gap-10); grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.dim-callbackBox { display: flex; flex-direction: column; gap: var(--dim-gap-6); padding: 10px 12px; border: 1px dashed var(--dsw-alias-border-l3, #e5e6eb); border-radius: var(--dim-radius-8); }
.dim-callbackBox strong { font-size: var(--dim-font-12); color: var(--dsw-alias-label-secondary, #646a73); }
.dim-callbackRow { display: flex; gap: var(--dim-gap-8); align-items: center; }
/* Every other input in the plugin carries the field language; this one declared
   none of it, so it fell back to the UA default beside a 28px capsule button. */
.dim-callbackRow input { flex: 1 1 auto; min-width: 0; height: 32px; padding: 0 10px; border: var(--dim-field-border); border-radius: var(--dim-field-radius); color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-alias-bg-layer-1, #fff); font-family: var(--dim-font-mono); font-size: var(--dim-font-12); }
.dim-appSwitchRow { display: flex; align-items: center; flex-wrap: wrap; gap: var(--dim-gap-8); font-size: var(--dim-font-13); }
/* The streaming toggle is a labelled boolean, so it takes the native outline
   capsule every other action in the panel uses, plus the native pressed
   surface - the same pair .dim-credentialButton already uses. */
.dim-streamToggle { height: 28px; display: inline-flex; align-items: center; justify-content: center; padding: 0 10px; border: var(--dim-control-border); border-radius: var(--dim-radius-14); color: var(--dsw-alias-label-primary, #0f1115); background: transparent; font-size: var(--dim-font-12); line-height: var(--dim-line-12); cursor: pointer; }
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
