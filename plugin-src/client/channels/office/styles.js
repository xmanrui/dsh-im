export const OFFICE_STYLE_ID = 'xmanrui-dsh-im-office-settings';

const CSS = `
.dof-page { --dof-accent: var(--dsw-alias-brand-primary, #3964fe); }
.dof-hero { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--dim-gap-16); align-items: center; margin-bottom: 12px; padding: 16px; border: 0.5px solid var(--dsw-alias-border-l4, rgb(0 0 0 / 16%)); border-radius: var(--dim-radius-16); background: none; }
.dof-hero::after { display: none; }
.dof-heroCopy { min-width: 0; }
.dof-heroCopy h3 { margin: 0; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-15); line-height: var(--dim-line-15); font-weight: var(--dim-weight-600); }
.dof-heroCopy p { margin: 4px 0 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dof-status { position: relative; z-index: 1; display: inline-flex; align-items: center; gap: var(--dim-gap-4); height: 24px; padding: 0 8px; border: none; border-radius: var(--dim-radius-12); background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); white-space: nowrap; }
/* The office dot is the same role as .dim-stateDot and now carries that class, so the
   shared rule owns its geometry and its not-configured colour. It used to declare the
   shared 8px / 50% / superellipse as a second author AND paint itself amber for a state
   that the other eleven channels render neutral grey - an unconfigured integration is not
   a warning. Only the connected colour stays channel-owned, and it is raised to (0,3,0)
   so it still outranks the shared rule. */
.dof-status[data-connected="true"] .dof-dot.dim-stateDot { background: var(--dsw-alias-state-success-primary, #22c55e); }
.dof-card { margin-top: 12px; padding: 16px; border: 0.5px solid var(--dsw-alias-border-l4, rgb(0 0 0 / 16%)); border-radius: var(--dim-radius-16); background: none; }
.dof-cardTitle { display: flex; justify-content: space-between; gap: var(--dim-gap-12); align-items: baseline; margin-bottom: 4px; }
.dof-cardTitle h4 { margin: 0; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-14); line-height: var(--dim-line-14); font-weight: var(--dim-weight-400); }
.dof-cardTitle span { color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dof-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: var(--dim-gap-24); }
.dof-field { min-width: 0; display: flex; flex-direction: column; gap: var(--dim-gap-6); padding: 12px 0; border-top: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-13); font-weight: var(--dim-weight-500); line-height: var(--dim-line-13); }
.dof-grid > .dof-field:nth-child(-n+2) { border-top: 0; padding-top: 0; }
.dof-field[data-wide="true"] { grid-column: 1 / -1; }
.dof-field input, .dof-field textarea { box-sizing: border-box; width: 100%; border: 0.5px solid var(--dsw-alias-border-l4, rgb(0 0 0 / 16%)); border-radius: var(--dim-radius-8); background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #0f1115); font: inherit; font-size: var(--dim-font-14); font-weight: var(--dim-weight-400); line-height: var(--dim-line-14); outline: none; }
.dof-field input { height: 32px; padding: 0 10px; }
.dof-field textarea { min-height: 86px; resize: vertical; padding: 8px 12px; font-family: var(--dim-font-mono, monospace); }
.dof-field input:focus, .dof-field textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #0f1115); box-shadow: none; }
.dof-field small { color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); font-weight: var(--dim-weight-400); line-height: var(--dim-line-12); }
.dof-hooks { display: grid; gap: var(--dim-gap-7); }
.dof-hook { min-width: 0; display: grid; grid-template-columns: 82px minmax(0, 1fr); gap: var(--dim-gap-10); align-items: center; padding: 8px 10px; border-radius: var(--dim-radius-12); background: var(--dsw-alias-bg-module-platform, #f5f6f7); }
.dof-hook strong { color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); font-weight: var(--dim-weight-500); }
.dof-hook code { overflow: hidden; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-11); text-overflow: ellipsis; white-space: nowrap; }
/* The hook preview's empty state had no rule at all - the class was mounted and
   never styled, so the paragraph fell back to the browser default. Native gives a
   field its hint paragraph this exact shape (ui-settings-plugins .hint). */
.dof-hooksEmpty { margin: 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dof-actions { display: flex; flex-wrap: wrap; gap: var(--dim-gap-8); margin-top: 14px; }
.dof-actions .ddt-button[data-kind="primary"] { border: var(--dim-control-border); color: var(--dsw-alias-label-primary, #0f1115); background: transparent; }
.dof-error, .dof-notice { margin: 10px 0 0; padding: 9px 11px; border-radius: var(--dim-radius-8); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
/* error-secondary is red-400 in both themes while error-primary is red-400 in dark,
   so this text and its own background resolved to one colour: 1.00:1, invisible.
   It is the tinted-notice pattern the rest of the sheet already uses. */
.dof-error { color: var(--dim-danger); background: color-mix(in srgb, var(--dim-danger) 8%, var(--dsw-alias-bg-layer-1, #fff)); }
.dof-notice { color: var(--dsw-alias-label-secondary, #646a73); background: var(--dim-hover); }
.dof-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--dim-gap-8); margin-top: 12px; }
.dof-metric { min-width: 0; padding: 9px 10px; border-radius: var(--dim-radius-12); background: var(--dsw-alias-bg-module-platform, #f5f6f7); }
.dof-metric span { display: block; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-11); }
.dof-metric strong { display: block; overflow: hidden; margin-top: 4px; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-12); text-overflow: ellipsis; white-space: nowrap; }
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
