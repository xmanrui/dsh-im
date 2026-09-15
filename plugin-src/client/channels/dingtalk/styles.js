export const DINGTALK_STYLE_ID = 'xmanrui-dsh-im-dingtalk-settings';

const CSS = String.raw`
.ddt-page {
  --ddt-accent: #1677ff;
  --ddt-accent-deep: #0958d9;
  --ddt-accent-wash: #eaf3ff;
  --ddt-success: var(--dsw-alias-state-success-primary, #20a162);
  --ddt-warning: var(--dsw-alias-state-warn-primary, #d97706);
  --ddt-error: var(--dsw-alias-state-error-primary, #d54941);
  width: 100%;
  max-width: 880px;
  display: flex;
  flex-direction: column;
  gap: var(--dim-gap-18);
  padding: 2px 0 28px;
  container-type: inline-size;
  color: var(--dsw-alias-label-primary, #0f1115);
  box-sizing: border-box;
}
.ddt-page *, .ddt-page *::before, .ddt-page *::after { box-sizing: border-box; }
.ddt-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--dim-gap-20); }
.ddt-headingCopy { min-width: 0; }
.ddt-heading h2, .ddt-heading p, .ddt-card h3, .ddt-card h4, .ddt-card p { margin: 0; }
.ddt-eyebrow { margin-bottom: 3px; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
.ddt-heading h2 { font-size: var(--dim-font-20); line-height: 28px; font-weight: 600; }
.ddt-heading p { margin-top: 5px; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-13); line-height: 20px; white-space: nowrap; }
.ddt-tools, .ddt-actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--dim-gap-10); }
.ddt-tools { width: 100%; justify-content: space-between; flex-wrap: nowrap; }
.ddt-badge { min-height: 30px; display: inline-flex; align-items: center; gap: var(--dim-gap-7); padding: 0 11px; border-radius: var(--dim-radius-full); color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-bg-module-platform, #f5f6f7); font-size: var(--dim-font-12); white-space: nowrap; }
.ddt-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: #aeb3bb; }
.ddt-dot[data-tone="success"] { background: var(--ddt-success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ddt-success) 14%, transparent); }
.ddt-dot[data-tone="warning"] { background: var(--ddt-warning); }
.ddt-dot[data-tone="error"] { background: var(--ddt-error); }
.ddt-button { height: 28px; display: inline-flex; align-items: center; justify-content: center; gap: var(--dim-gap-4); padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l3, #dfe1e5); border-radius: var(--dim-radius-14); color: var(--dsw-alias-label-primary, #0f1115); background: transparent; font: inherit; font-size: var(--dim-font-12); font-weight: 400; text-decoration: none; cursor: pointer; transition: border-color .15s ease, background .15s ease, transform .15s ease; }
.ddt-button:hover:not(:disabled) { border-color: #aeb3bb; background: var(--dim-hover); }
.ddt-button:active:not(:disabled) { transform: translateY(1px); }
.ddt-button:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); outline-offset: 2px; }
.ddt-button:disabled { cursor: not-allowed; opacity: 0.4; }
.ddt-button[data-kind="primary"] { color: #fff; border-color: var(--ddt-accent); background: var(--ddt-accent); }
.ddt-button[data-kind="primary"]:hover:not(:disabled) { border-color: var(--ddt-accent-deep); background: var(--ddt-accent-deep); }
.ddt-button[data-kind="danger"] { color: var(--ddt-error); }
.ddt-button[data-kind="quiet"] { min-height: 30px; padding: 0 10px; border-color: transparent; background: transparent; }
.ddt-card { overflow: hidden; border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); border-radius: var(--dim-radius-14); background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 1px 2px rgb(31 35 41 / 3%); }
.ddt-cardBody { padding: 24px; }
.ddt-empty { min-height: 230px; display: grid; grid-template-columns: minmax(0, 1fr) 180px; align-items: center; gap: var(--dim-gap-30); }
.ddt-empty h3 { margin: 8px 0; font-size: var(--dim-font-18); }
.ddt-empty p { max-width: 560px; color: var(--dsw-alias-label-secondary, #646a73); line-height: 1.65; }
.ddt-empty .ddt-actions { margin-top: 20px; }
.ddt-brandMark { width: 110px; height: 110px; display: grid; place-items: center; justify-self: center; border-radius: var(--dim-radius-24); color: #fff; background: linear-gradient(145deg, #2997ff, var(--ddt-accent)); box-shadow: 0 18px 45px rgb(22 119 255 / 23%); }
.ddt-brandMark svg { filter: drop-shadow(0 3px 8px rgb(0 35 96 / 16%)); }
.ddt-qrLayout { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: var(--dim-gap-34); align-items: start; }
.ddt-qrColumn { display: flex; flex-direction: column; align-items: center; gap: var(--dim-gap-12); }
.ddt-qrFrame { position: relative; width: min(270px, 100%); aspect-ratio: 1; display: grid; place-items: center; overflow: hidden; padding: 10px; border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); border-radius: var(--dim-radius-16); background: #fff; }
.ddt-qrFrame::before { content: ''; position: absolute; inset: 6px; border: 1px solid rgb(22 119 255 / 10%); border-radius: var(--dim-radius-12); pointer-events: none; }
.ddt-qrFrame img { display: block; width: 100%; height: 100%; object-fit: contain; }
.ddt-qrFallback { padding: 24px; color: #646a73; text-align: center; }
.ddt-expired { position: absolute; inset: 0; display: grid; place-items: center; padding: 30px; color: #fff; text-align: center; font-weight: 600; white-space: pre-line; background: rgb(31 35 41 / 76%); backdrop-filter: blur(3px); }
.ddt-countdown { width: min(270px, 100%); color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); }
.ddt-countdownTop { display: flex; justify-content: space-between; margin-bottom: 6px; }
.ddt-countdown strong { color: var(--dsw-alias-label-primary, #0f1115); font-variant-numeric: tabular-nums; }
.ddt-progress { height: 4px; overflow: hidden; border-radius: var(--dim-radius-full); background: #eef0f3; }
.ddt-progress span { display: block; width: var(--ddt-progress); height: 100%; background: var(--ddt-accent); transition: width .2s linear; }
.ddt-stateLabel { display: inline-flex; align-items: center; gap: var(--dim-gap-8); color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); font-weight: 600; }
.ddt-qrCopy { min-width: 0; overflow-wrap: anywhere; }
.ddt-qrCopy h3 { margin: 9px 0 8px; font-size: var(--dim-font-18); }
.ddt-qrCopy > p { color: var(--dsw-alias-label-secondary, #646a73); line-height: 1.65; }
.ddt-steps { margin: 18px 0 16px; padding: 0; list-style: none; counter-reset: ddt-step; }
.ddt-steps li { position: relative; min-height: 28px; padding: 3px 0 3px 36px; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-13); line-height: 22px; counter-increment: ddt-step; }
.ddt-steps li::before { content: counter(ddt-step); position: absolute; left: 0; top: 1px; width: 26px; height: 26px; display: grid; place-items: center; border-radius: var(--dim-radius-8); color: var(--ddt-accent-deep); background: var(--ddt-accent-wash); font-size: var(--dim-font-12); font-weight: 600; }
.ddt-loading { padding: 38px; color: var(--dsw-alias-label-secondary, #646a73); text-align: center; }
.ddt-loading h3 { margin: 0 0 7px; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-16); }
.ddt-loading p { line-height: 1.6; }
.ddt-spinner { width: 24px; height: 24px; margin: 0 auto 13px; border: 3px solid #e6e8eb; border-top-color: var(--ddt-accent); border-radius: 50%; animation: ddt-spin .8s linear infinite; }
.ddt-statusNotice, .ddt-inlineError { display: flex; align-items: flex-start; gap: var(--dim-gap-10); padding: 13px 15px; border: 1px solid color-mix(in srgb, var(--ddt-error) 28%, transparent); border-radius: var(--dim-radius-10); color: var(--ddt-error); background: color-mix(in srgb, var(--ddt-error) 7%, transparent); font-size: var(--dim-font-13); }
.ddt-inlineError { flex-direction: column; padding: 22px; }
.ddt-inlineError h3 { font-size: var(--dim-font-16); overflow-wrap: anywhere; }
.ddt-inlineError p { line-height: 1.55; overflow-wrap: anywhere; }
.ddt-errorCode { font: 11px ui-monospace, SFMono-Regular, monospace; opacity: .8; overflow-wrap: anywhere; }
.ddt-errorDiagnostic { display: grid; gap: var(--dim-gap-5); color: var(--ddt-error); overflow-wrap: anywhere; }
.ddt-errorHint { margin: 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: 1.55; overflow-wrap: anywhere; }
.ddt-listHeading { display: flex; align-items: center; justify-content: space-between; margin: 2px 0 9px; }
.ddt-listHeading h3 { margin: 0; font-size: var(--dim-font-14); }
.ddt-list { display: grid; gap: var(--dim-gap-12); margin: 0; padding: 0; list-style: none; }
.ddt-accountTop { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--dim-gap-16); }
.ddt-accountIdentity { min-width: 0; display: flex; align-items: center; gap: var(--dim-gap-12); }
.ddt-avatar { width: 42px; height: 42px; display: grid; place-items: center; flex: none; border-radius: var(--dim-radius-12); color: #fff; background: linear-gradient(145deg, #2997ff, var(--ddt-accent)); }
.ddt-accountIdentity h3 { overflow: hidden; font-size: var(--dim-font-15); text-overflow: ellipsis; white-space: nowrap; }
.ddt-accountIdentity p { margin-top: 4px; color: var(--dsw-alias-label-secondary, #646a73); font: 12px ui-monospace, SFMono-Regular, monospace; }
.ddt-health { display: inline-flex; align-items: center; gap: var(--dim-gap-7); color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); white-space: nowrap; }
.ddt-accountFooter { display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-15); padding-top: 16px; border-top: 0.5px solid var(--dsw-alias-border-l1, #eef0f3); }
.ddt-accountFooter .ddt-actions { flex: none; flex-wrap: nowrap; gap: var(--dim-gap-8); margin-top: 0; }
.ddt-accountFooter .ddt-button { flex: none; white-space: nowrap; }
.ddt-summary { color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); }
.ddt-confirm { padding: 18px 24px; border-top: 1px solid color-mix(in srgb, var(--ddt-error) 25%, transparent); background: color-mix(in srgb, var(--ddt-error) 5%, transparent); }
.ddt-confirm strong { display: block; margin-bottom: 6px; font-size: var(--dim-font-14); }
.ddt-confirm p { color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: 1.55; }
.ddt-confirm .ddt-actions { margin-top: 13px; }
.ddt-visuallyHidden { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@keyframes ddt-spin { to { transform: rotate(360deg); } }
@container (max-width: 680px) {
  .ddt-heading { flex-direction: column; align-items: stretch; }
  .ddt-tools { width: 100%; flex-wrap: nowrap; gap: var(--dim-gap-6); }
  .ddt-tools .ddt-badge { min-height: 34px; padding-inline: 8px; }
  .ddt-tools .ddt-button { flex: none; padding-inline: 10px; white-space: nowrap; }
  .ddt-empty { grid-template-columns: minmax(0, 1fr); }
  .ddt-brandMark { display: none; }
  .ddt-qrLayout { grid-template-columns: minmax(0, 1fr); justify-items: center; gap: var(--dim-gap-24); }
  .ddt-qrColumn { width: 100%; min-width: 0; }
  .ddt-qrCopy { width: 100%; }
}
@media (max-width: 720px) {
  .ddt-heading, .ddt-accountTop { flex-direction: column; align-items: stretch; }
  .ddt-heading p { white-space: normal; }
  .ddt-empty { grid-template-columns: minmax(0, 1fr); }
  .ddt-brandMark { display: none; }
  .ddt-qrLayout { grid-template-columns: minmax(0, 1fr); justify-items: center; }
  .ddt-qrCopy { width: 100%; }
  .ddt-cardBody { padding: 20px; }
}
@media (prefers-reduced-motion: reduce) {
  .ddt-page *, .ddt-page *::before, .ddt-page *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
`;

export function installDingtalkStyles() {
  if (typeof document === 'undefined') return () => {};
  const existing = document.querySelector(`style[data-plugin-css="${DINGTALK_STYLE_ID}"]`);
  if (existing) return () => {};
  const style = document.createElement('style');
  style.dataset.plugin = '@xmanrui/dsh-im';
  style.dataset.pluginCss = DINGTALK_STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => style.remove();
}
