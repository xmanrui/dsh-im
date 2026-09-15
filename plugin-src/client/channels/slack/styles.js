export const SLACK_STYLE_ID = 'xmanrui-dsh-im-slack-settings';

const CSS = String.raw`
.dsl-page.dim-channelPage { --ddt-accent: #4a154b; --ddt-accent-deep: #321033; --ddt-accent-wash: #f7eef7; }
.dsl-avatar.dim-botAvatar { background: linear-gradient(145deg, #fff, #f8fafb); border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); }
.dsl-avatar svg { display: block; }
.dsl-setup { display: grid; gap: var(--dim-gap-18); }
.dsl-guide { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: var(--dim-gap-18); padding: 16px; border: 0.5px solid color-mix(in srgb, #4a154b 18%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); border-radius: var(--dim-radius-12); background: color-mix(in srgb, #4a154b 4%, var(--dsw-alias-bg-layer-1, #fff)); }
.dsl-guideCopy { min-width: 0; }
.dsl-guideCopy strong { display: block; margin-bottom: 5px; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-13); }
.dsl-guideCopy p { margin: 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: 1.6; }
.dsl-guideActions { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: var(--dim-gap-8); }
.dsl-guideActions .ddt-button { white-space: nowrap; }
.dsl-copyState { color: var(--dsw-alias-state-success-primary, #20a162); }
.dsl-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--dim-gap-12); }
.dsl-tokenHint { grid-column: 1 / -1; margin: -4px 0 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-11); line-height: 1.55; overflow-wrap: anywhere; }
@container (max-width: 680px) {
  .dsl-guide { grid-template-columns: minmax(0, 1fr); }
  .dsl-guideActions { justify-content: flex-start; }
  .dsl-fields { grid-template-columns: minmax(0, 1fr); }
}
`;

export function installSlackStyles() {
  if (typeof document === 'undefined') return () => {};
  const existing = document.querySelector(`style[data-plugin-css="${SLACK_STYLE_ID}"]`);
  if (existing) return () => {};
  const style = document.createElement('style');
  style.dataset.plugin = '@xmanrui/dsh-im';
  style.dataset.pluginCss = SLACK_STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => style.remove();
}
