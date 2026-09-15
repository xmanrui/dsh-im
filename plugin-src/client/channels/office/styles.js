export const OFFICE_STYLE_ID = 'xmanrui-dsh-im-office-settings';

const CSS = `
.dof-page { --dof-accent: var(--dsw-alias-brand-primary, #3964fe); }
.dof-hero { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: center; margin-bottom: 12px; padding: 16px; border: 0.5px solid var(--dsw-alias-border-l4, rgb(0 0 0 / 16%)); border-radius: 16px; background: none; }
.dof-hero::after { display: none; }
.dof-heroCopy { min-width: 0; }
.dof-heroCopy h3 { margin: 0; color: var(--dsw-alias-label-primary, #0f1115); font-size: 15px; line-height: 22px; font-weight: 600; }
.dof-heroCopy p { margin: 4px 0 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; line-height: 18px; }
.dof-status { position: relative; z-index: 1; display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border: none; border-radius: 12px; background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-secondary, #61666b); font-size: 12px; line-height: 18px; white-space: nowrap; }
.dof-dot { width: 8px; height: 8px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-state-warn-primary, #f59e0b); }
.dof-status[data-connected="true"] .dof-dot { background: var(--dsw-alias-state-success-primary, #22c55e); }
.dof-card { margin-top: 12px; padding: 16px; border: 0.5px solid var(--dsw-alias-border-l4, rgb(0 0 0 / 16%)); border-radius: 16px; background: none; }
.dof-cardTitle { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; margin-bottom: 4px; }
.dof-cardTitle h4 { margin: 0; color: var(--dsw-alias-label-primary, #0f1115); font-size: 14px; line-height: 22px; font-weight: 400; }
.dof-cardTitle span { color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; line-height: 18px; }
.dof-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 24px; }
.dof-field { min-width: 0; display: flex; flex-direction: column; gap: 6px; padding: 12px 0; border-top: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); color: var(--dsw-alias-label-primary, #0f1115); font-size: 13px; font-weight: 500; line-height: 1.5; }
.dof-grid > .dof-field:nth-child(-n+2) { border-top: 0; padding-top: 0; }
.dof-field[data-wide="true"] { grid-column: 1 / -1; }
.dof-field input, .dof-field textarea { box-sizing: border-box; width: 100%; border: 0.5px solid var(--dsw-alias-border-l4, rgb(0 0 0 / 16%)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #0f1115); font: inherit; font-size: 14px; font-weight: 400; line-height: 1.5; outline: none; }
.dof-field input { height: 32px; padding: 0 10px; }
.dof-field textarea { min-height: 86px; resize: vertical; padding: 8px 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.dof-field input:focus, .dof-field textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #0f1115); box-shadow: none; }
.dof-field small { color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; font-weight: 400; line-height: 1.5; }
.dof-hooks { display: grid; gap: 7px; }
.dof-hook { min-width: 0; display: grid; grid-template-columns: 82px minmax(0, 1fr); gap: 10px; align-items: center; padding: 8px 10px; border-radius: 12px; background: var(--dsw-alias-bg-module-platform, #f5f6f7); }
.dof-hook strong { color: var(--dsw-alias-label-secondary, #61666b); font-size: 12px; font-weight: 500; }
.dof-hook code { overflow: hidden; color: var(--dsw-alias-label-primary, #1f2329); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
/* The hook preview's empty state had no rule at all - the class was mounted and
   never styled, so the paragraph fell back to the browser default. Native gives a
   field its hint paragraph this exact shape (ui-settings-plugins .hint). */
.dof-hooksEmpty { margin: 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; line-height: 1.5; }
.dof-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.dof-actions .ddt-button[data-kind="primary"] { border: var(--dim-control-border); color: var(--dsw-alias-label-primary, #0f1115); background: transparent; }
.dof-error, .dof-notice { margin: 10px 0 0; padding: 9px 11px; border-radius: 8px; font-size: 12px; line-height: 1.5; }
.dof-error { color: var(--dsw-alias-state-error-primary, #d54941); background: var(--dsw-alias-state-error-secondary, #fff0ef); }
.dof-notice { color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-interactive-bg-hover, #f7f8fa); }
.dof-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
.dof-metric { min-width: 0; padding: 9px 10px; border-radius: 12px; background: var(--dsw-alias-bg-module-platform, #f5f6f7); }
.dof-metric span { display: block; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; }
.dof-metric strong { display: block; overflow: hidden; margin-top: 4px; color: var(--dsw-alias-label-primary, #1f2329); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
@container (max-width: 680px) { .dof-grid { grid-template-columns: minmax(0, 1fr); } .dof-field[data-wide="true"] { grid-column: auto; } .dof-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (prefers-reduced-motion: reduce) { .dof-page * { transition: none !important; } }
`;

export function installOfficeStyles() {
  if (typeof document === 'undefined') return () => {};
  if (document.querySelector(`style[data-plugin-css="${OFFICE_STYLE_ID}"]`)) return () => {};
  const style = document.createElement('style');
  style.dataset.pluginCss = OFFICE_STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
  return () => style.remove();
}
