export const FEISHU_STYLE_ID = "xmanrui-dsh-im-feishu-settings";

const CSS = String.raw`
.bxf-page {
  --bxf-accent: var(--dim-blue);
  --bxf-success: var(--dsw-alias-state-success-primary, #20a162);
  --bxf-warning: var(--dsw-alias-state-warn-primary, #d97706);
  --bxf-error: var(--dim-danger);
  box-sizing: border-box;
  width: 100%;
  max-width: 860px;
  color: var(--dsw-alias-label-primary, #0f1115);
  display: flex;
  flex-direction: column;
  container-type: inline-size;
  gap: var(--dim-gap-18);
  padding: 2px 0 24px;
}

.bxf-page *, .bxf-page *::before, .bxf-page *::after { box-sizing: border-box; }

.bxf-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--dim-gap-20);
}

.bxf-heading h2, .bxf-heading p, .bxf-card h3, .bxf-card p { margin: 0; }

  color: var(--dsw-alias-label-tertiary, #81858c);
  font-size: var(--dim-font-12);
  font-weight: var(--dim-weight-600);
  line-height: var(--dim-line-12);
  letter-spacing: .08em;
  text-transform: uppercase;
  margin-bottom: 3px;
}

.bxf-heading h2 {
  font-size: var(--dim-font-20);
  line-height: var(--dim-line-20);
  font-weight: var(--dim-weight-600);
  letter-spacing: -.015em;
}

.bxf-heading p {
  max-width: 540px;
  color: var(--dsw-alias-label-secondary, #646a73);
  font-size: var(--dim-font-13);
  line-height: var(--dim-line-13);
  margin-top: 5px;
  white-space: nowrap;
}

.bxf-headingTools {
  width: 100%;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: nowrap;
  gap: var(--dim-gap-8);
}

.bxf-totalBadge {
  display: inline-flex;
  align-items: baseline;
  gap: var(--dim-gap-3);
  border-radius: var(--dim-radius-full);
  padding: 4px 10px;
  color: var(--dsw-alias-label-secondary, #646a73);
  background: var(--dim-module-fill);
  font-size: var(--dim-font-11);
  line-height: 16px;
  white-space: nowrap;
}

.bxf-totalBadge strong { color: var(--bxf-success); font-size: var(--dim-font-13); }

.bxf-card {
  position: relative;
  overflow: hidden;
  border-radius: var(--dim-radius-14);
  background: var(--dsw-alias-bg-layer-3, #fff);
  /* The hairline belongs to the convergence layer, which paints every card in
     this plugin through .dim-panel .dim-surfaceCard / .dim-botCard. Drawing a
     stroke here as well — as a layout border or inside the shadow via
     --dsw-elevation-stroke — gave the card two outlines. Only the soft drop
     shadow is local. */
  box-shadow: var(--dsw-shadow-lv1, 0 3px 12px rgba(31, 35, 41, .05));
}

.bxf-card::before {
  content: "";
  pointer-events: none;
  position: absolute;
  inset: 0 0 auto;
  height: 88px;
  background:
    radial-gradient(circle at 86% -35%, color-mix(in srgb, var(--bxf-accent) 18%, transparent), transparent 68%);
  opacity: .85;
}

.bxf-cardBody { position: relative; padding: 24px; }

.bxf-intro {
  min-height: 250px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 172px;
  gap: var(--dim-gap-32);
  align-items: center;
}

.bxf-introCopy { max-width: 500px; }

.bxf-stateLabel {
  display: inline-flex;
  align-items: center;
  gap: var(--dim-gap-7);
  color: var(--dsw-alias-label-secondary, #646a73);
  font-size: var(--dim-font-12);
  font-weight: var(--dim-weight-600);
  line-height: var(--dim-line-12);
  margin-bottom: 13px;
}

.bxf-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dsw-alias-label-tertiary, #81858c);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--dsw-alias-label-tertiary, #81858c) 12%, transparent);
}

.bxf-dot[data-tone="success"] {
  background: var(--bxf-success);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--bxf-success) 13%, transparent);
}

.bxf-dot[data-tone="warning"] {
  background: var(--bxf-warning);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--bxf-warning) 13%, transparent);
}

.bxf-dot[data-tone="error"] {
  background: var(--bxf-error);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--bxf-error) 13%, transparent);
}

.bxf-intro h3 {
  font-size: var(--dim-font-20);
  line-height: 34px;
  font-weight: var(--dim-weight-600);
  letter-spacing: -.02em;
}

.bxf-introCopy > p {
  max-width: 490px;
  color: var(--dsw-alias-label-secondary, #646a73);
  font-size: var(--dim-font-14);
  line-height: 23px;
  margin-top: 8px;
}

  display: flex;
  gap: var(--dim-gap-8);
  align-items: flex-start;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-size: var(--dim-font-12);
  line-height: var(--dim-line-12);
  margin-top: 16px;
}


.bxf-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--dim-gap-10);
  margin-top: 22px;
}

.bxf-button {
  appearance: none;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--dim-gap-4);
  border: 0.5px solid var(--dsw-alias-border-l3, #dee0e3);
  border-radius: var(--dim-radius-14);
  padding: 0 10px;
  color: var(--dsw-alias-label-primary, #0f1115);
  background: transparent;
  font: inherit;
  font-size: var(--dim-font-12);
  font-weight: var(--dim-weight-400);
  line-height: var(--dim-line-12);
  text-decoration: none;
  cursor: pointer;
  transition: background .15s var(--ds-ease-in-out, ease), border-color .15s var(--ds-ease-in-out, ease), transform .15s var(--ds-ease-in-out, ease);
}

/* One hover treatment for every outline capsule in the plugin, owned by the shared
   sheet: the surface moves to --dim-hover-solid and the resting border is left alone.
   These three channel rules used to disagree - feishu took --dim-hover (a translucent
   blue-tinted rgb(38 49 72 / 6%)) with a #c9cdd4 border, dingtalk and weixin took the
   same translucent fill with a hardcoded #aeb3bb border - so the identical button
   changed hue depending on which channel page it sat on. */
.bxf-button:hover:not(:disabled) {
  background: var(--dim-hover-solid);
}

.bxf-button:active:not(:disabled) { transform: translateY(1px); }

.bxf-button:focus-visible, .bxf-link:focus-visible {
  outline: none; box-shadow: var(--dim-focus-shadow);
  outline-offset: 2px;
}

.bxf-button:disabled { cursor: not-allowed; opacity: 0.4; }

.bxf-button[data-kind="primary"] {
  border-color: var(--bxf-accent);
  color: var(--dim-action-on-fill, #fff);
  background: var(--bxf-accent);
  box-shadow: 0 4px 12px color-mix(in srgb, var(--bxf-accent) 24%, transparent);
}

.bxf-button[data-kind="primary"]:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--bxf-accent) 86%, #000);
  background: color-mix(in srgb, var(--bxf-accent) 90%, #000);
}

.bxf-button[data-kind="danger"] { color: var(--bxf-error); }
/* 'small' was 32px against a 28px base, so it beat the shared .dim-scanButton
   height and made Feishu's Scan QR / Manual setup row 4px taller than every
   other channel's - a visible jitter when switching channels. The shared layer
   puts this whole family at 28px, so the variant stays a size marker only. */
.bxf-button[data-size="small"] { min-height: 28px; padding: 0 10px; font-size: var(--dim-font-12); }
.bxf-bindButton { flex: none; white-space: nowrap; }

.bxf-provisionCard {
  border-color: color-mix(in srgb, var(--bxf-accent) 32%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)));
}

.bxf-markStage {
  position: relative;
  width: 156px;
  height: 156px;
  display: grid;
  place-items: center;
  justify-self: end;
}

.bxf-markStage::before, .bxf-markStage::after {
  content: "";
  position: absolute;
  border-radius: 50%;
}

.bxf-markStage::before {
  inset: 12px;
  border: 0.5px solid color-mix(in srgb, var(--bxf-accent) 18%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)));
  background: color-mix(in srgb, var(--bxf-accent) 4%, var(--dsw-alias-bg-layer-1, #fff));
}

.bxf-markStage::after {
  inset: 0;
  border: 1px dashed color-mix(in srgb, var(--bxf-accent) 16%, transparent);
  animation: bxf-rotate 18s linear infinite;
}

.bxf-brandMark {
  position: relative;
  z-index: 1;
  width: 68px;
  height: 68px;
  display: grid;
  place-items: center;
  border-radius: var(--dim-radius-20);
  color: #fff;
  background: var(--bxf-accent);
  box-shadow: 0 12px 28px color-mix(in srgb, var(--bxf-accent) 28%, transparent);
}

.bxf-qrLayout {
  display: grid;
  grid-template-columns: 236px minmax(0, 1fr);
  align-items: center;
  gap: var(--dim-gap-32);
}

.bxf-qrColumn { min-width: 0; }

.bxf-qrFrame {
  position: relative;
  width: 222px;
  height: 222px;
  display: grid;
  place-items: center;
  border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%));
  border-radius: var(--dim-radius-14);
  padding: 13px;
  background: #fff;
  box-shadow: 0 8px 24px rgba(31, 35, 41, .07);
}

.bxf-qrFrame::before, .bxf-qrFrame::after {
  content: "";
  position: absolute;
  width: 24px;
  height: 24px;
  border-color: var(--bxf-accent);
  border-style: solid;
}

.bxf-qrFrame::before { inset: -3px auto auto -3px; border-width: 2px 0 0 2px; border-radius: var(--dim-radius-8) 0 0; }
.bxf-qrFrame::after { inset: auto -3px -3px auto; border-width: 0 2px 2px 0; border-radius: 0 0 8px; }
.bxf-qrFrame img { width: 100%; height: 100%; display: block; object-fit: contain; }

.bxf-qrFallback {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  border-radius: var(--dim-radius-8);
  color: var(--bxf-accent);
  background: #f7f9ff;
  text-align: center;
  padding: 20px;
}

.bxf-qrFallback span { display: block; color: #646a73; font-size: var(--dim-font-12); line-height: var(--dim-line-12); margin-top: 8px; }

/* Only border-radius survives here. Every other declaration - position, inset, display,
   place-items, colour, background, blur, font-size, weight, text-align - is also declared by the
   shared .dim-panel .dim-qrExpired at (0,2,0), and the element carries both classes
   (feishu/index.js:283), so all of them were dead. The two other channels' expired rules
   (.ddt-expired, .dxw-expired) declared nothing BUT dead properties and are deleted outright. */
.bxf-expiredOverlay {
  border-radius: var(--dim-radius-8);
}

.bxf-countdown {
  width: 222px;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-variant-numeric: tabular-nums;
  font-size: var(--dim-font-11);
  line-height: 17px;
  margin-top: 11px;
}

.bxf-countdownTop { display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-10); }
.bxf-progress { height: 3px; overflow: hidden; border-radius: var(--dim-radius-full); background: var(--dim-module-fill); margin-top: 6px; }
.bxf-progress > span { display: block; width: var(--bxf-progress, 100%); height: 100%; border-radius: inherit; background: var(--bxf-accent); transition: width 1s linear; }

/* The channel's qrCopy h3 used to be declared twice here (20/28/600, and 18/26 under
   .bxf-botProvision). Both were dead: the element carries bxf-qrCopy AND dim-qrCopy
   (feishu/index.js:298), so the shared .dim-panel .dim-qrCopy h3 owns it at (0,2,1) - the first
   rule loses on specificity, the second ties and loses because the shared sheet is injected
   later. Measured on 3080: the h3 renders 18 / 24 / 600, never 20 or 26. */
.bxf-qrCopy > p { color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-13); line-height: var(--dim-line-13); margin-top: 7px; }

.bxf-steps { counter-reset: bxf-step; display: flex; flex-direction: column; gap: var(--dim-gap-11); margin: 20px 0 0; padding: 0; list-style: none; }
.bxf-steps li { counter-increment: bxf-step; display: grid; grid-template-columns: 23px minmax(0, 1fr); align-items: start; gap: var(--dim-gap-9); color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.bxf-steps li::before { content: counter(bxf-step); width: 21px; height: 21px; display: grid; place-items: center; border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); border-radius: 50%; color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-alias-bg-layer-1, #fff); font-size: var(--dim-font-11); font-weight: var(--dim-weight-600); }


.bxf-inlineError {
  min-height: 190px;
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  align-content: center;
  gap: var(--dim-gap-15);
  padding: 28px;
}

.bxf-inlineError h3 { font-size: var(--dim-font-16); line-height: var(--dim-line-16); margin: 0; overflow-wrap: anywhere; }
.bxf-inlineError p { color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-13); line-height: var(--dim-line-13); margin-top: 5px; overflow-wrap: anywhere; }

.bxf-listSection { display: flex; flex-direction: column; gap: var(--dim-gap-10); }
.bxf-listHeading { min-height: 28px; display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-16); padding: 0 2px; }
.bxf-listHeading h3 { font-size: var(--dim-font-14); line-height: var(--dim-line-14); font-weight: var(--dim-weight-600); margin: 0; }
.bxf-botList { display: flex; flex-direction: column; gap: var(--dim-gap-12); margin: 0; padding: 0; list-style: none; }
.bxf-botList > li { min-width: 0; }
.bxf-botCard:focus { outline: none; }
.bxf-botCard:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); outline-offset: 2px; }

.bxf-connectedTop { display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-20); }
.bxf-botIdentity { min-width: 0; display: flex; align-items: center; gap: 13px; }
.bxf-avatar { flex: none; display: grid; place-items: center; overflow: hidden; border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 1px 3px rgb(31 35 41 / 7%); }
.bxf-botName { min-width: 0; }
.bxf-botName h3 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--dim-font-16); line-height: var(--dim-line-16); font-weight: var(--dim-weight-600); }
.bxf-botName p { overflow: hidden; color: var(--dsw-alias-label-tertiary, #81858c); font-family: var(--dim-font-mono); font-size: var(--dim-font-12); line-height: var(--dim-line-12); text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }

/* A coloured status indicator, so the host owner is ConnectionIndicator (12 / 500 / 18, semantic
   colour carried by the indicator) rather than the neutral Pill (12 / 400 / 18). Only the weight
   moves here; the tinted-fill treatment is a separate question already on the open list. */
.bxf-healthPill { flex: none; display: inline-flex; align-items: center; gap: var(--dim-gap-7); min-height: 28px; border-radius: var(--dim-radius-full); padding: 4px 10px; color: var(--bxf-success); background: color-mix(in srgb, var(--bxf-success) 10%, transparent); font-size: var(--dim-font-12); font-weight: var(--dim-weight-500); line-height: var(--dim-line-12); }
.bxf-healthPill[data-health="degraded"], .bxf-healthPill[data-health="checking"], .bxf-healthPill[data-health="connecting"] { color: var(--bxf-warning); background: color-mix(in srgb, var(--bxf-warning) 10%, transparent); }
.bxf-healthPill[data-health="offline"], .bxf-healthPill[data-health="error"] { color: var(--bxf-error); background: color-mix(in srgb, var(--bxf-error) 10%, transparent); }




.bxf-botProvision {
  position: relative;
  margin-top: 14px;
  scroll-margin-block: 20px;
  animation: bxf-revealProvision .2s var(--ds-ease-out, ease-out) both;
}
.bxf-botProvision:focus { outline: none; }
.bxf-botProvision:focus-visible {
  outline: none; box-shadow: var(--dim-focus-shadow);
  outline-offset: 3px;
  border-radius: var(--dim-radius-12);
}
.bxf-botProvision > .bxf-provisionCard {
  border-radius: var(--dim-radius-12);
  box-shadow: none;
  background: color-mix(in srgb, var(--bxf-accent) 2.5%, var(--dsw-alias-bg-layer-3, #fff));
}
.bxf-botProvision .bxf-cardBody { padding: 18px; }
.bxf-botProvision .bxf-qrLayout {
  grid-template-columns: 184px minmax(0, 1fr);
  align-items: start;
  gap: var(--dim-gap-24);
}
.bxf-botProvision .bxf-qrFrame { width: 176px; height: 176px; padding: 10px; border-radius: var(--dim-radius-12); }
.bxf-botProvision .bxf-countdown { width: 176px; }
.bxf-botProvision .bxf-steps { gap: var(--dim-gap-8); margin-top: 14px; }
.bxf-botProvision .bxf-actions { margin-top: 16px; }
.bxf-botProvision .bxf-inlineError { min-height: 160px; padding: 22px; }

.bxf-connectedFooter { display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-15); margin-top: 20px; padding-top: 16px; border-top: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); }
.bxf-healthSummary { min-width: 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.bxf-healthSummary[data-error="true"] { color: var(--bxf-error); }
.bxf-botActions { position: relative; flex: none; width: 100%; flex-wrap: wrap; gap: var(--dim-gap-8); margin-top: 0; justify-content: flex-end; }
.bxf-botActions .bxf-button { flex: none; white-space: nowrap; }
.bxf-botActions .bxf-repairButton { color: var(--bxf-accent); border-color: color-mix(in srgb, var(--bxf-accent) 35%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); }
.bxf-botActions .bxf-repairButton:hover:not(:disabled) { background: color-mix(in srgb, var(--bxf-accent) 7%, transparent); }
.bxf-repairAction { display: inline-flex; }.bxf-repairTooltip { position: absolute; right: 0; bottom: calc(100% + 8px); z-index: 40; width: min(330px, 100%); display: grid; gap: var(--dim-gap-3); opacity: 0; visibility: hidden; transform: translateY(3px); pointer-events: none; transition: opacity .15s ease, transform .15s ease, visibility .15s ease; }
.bxf-repairTooltip strong { font-size: var(--dim-font-12); line-height: var(--dim-line-12); font-weight: var(--dim-weight-600); }
.bxf-repairTooltip > span { color: var(--dsw-static-neutral-bluish-00, #f9fafb); font-size: var(--dim-font-11); line-height: 17px; font-weight: var(--dim-weight-400); overflow-wrap: anywhere; }
.bxf-repairAction:hover .bxf-repairTooltip,
.bxf-repairAction:focus-within .bxf-repairTooltip { opacity: 1; visibility: visible; transform: translateY(0); }

.bxf-confirm {
  border-top: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%));
  background: color-mix(in srgb, var(--bxf-error) 4%, var(--dim-module-fill));
  padding: 17px 24px 20px;
}
.bxf-confirm:focus { outline: none; }
.bxf-confirm h4 { font-size: var(--dim-font-13); line-height: var(--dim-line-13); margin: 0; }
.bxf-confirm p { color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); margin: 4px 0 0; }
.bxf-confirm .bxf-actions { margin-top: 12px; }

.bxf-error { min-height: 252px; display: grid; grid-template-columns: 44px minmax(0, 1fr); align-content: center; gap: var(--dim-gap-15); padding: 30px; }
.bxf-error h3 { font-size: var(--dim-font-16); line-height: var(--dim-line-16); overflow-wrap: anywhere; }
.bxf-error p { color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-13); line-height: var(--dim-line-13); margin-top: 5px; overflow-wrap: anywhere; }
.bxf-errorCode { display: inline-block; color: var(--dsw-alias-label-tertiary, #81858c); font-family: var(--dim-font-mono); font-size: var(--dim-font-11); margin-top: 7px; overflow-wrap: anywhere; }

.bxf-statusNotice {
  display: flex;
  align-items: center;
  gap: var(--dim-gap-9);
  border: 0.5px solid color-mix(in srgb, var(--bxf-warning) 28%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)));
  border-radius: var(--dim-radius-10);
  padding: 9px 11px;
  color: var(--dsw-alias-label-secondary, #646a73);
  background: color-mix(in srgb, var(--bxf-warning) 5%, var(--dsw-alias-bg-layer-1, #fff));
  font-size: var(--dim-font-12);
  line-height: var(--dim-line-12);
}
.bxf-statusNotice > svg { flex: none; color: var(--bxf-warning); }
.bxf-statusNotice > span { min-width: 0; flex: 1; overflow-wrap: anywhere; }


.bxf-visuallyHidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

@keyframes bxf-rotate { to { transform: rotate(360deg); } }
@keyframes bxf-revealProvision { from { opacity: 0; transform: translateY(-5px); } }

@container (max-width: 620px) {
  .bxf-headingTools { gap: var(--dim-gap-6); }
  .bxf-headingTools .bxf-totalBadge { padding-inline: 8px; }
  }

@media (max-width: 680px) {
  .bxf-intro { grid-template-columns: minmax(0, 1fr); }
  .bxf-markStage { display: none; }
  .bxf-qrLayout { grid-template-columns: minmax(0, 1fr); justify-items: center; }
  .bxf-botProvision .bxf-qrLayout { grid-template-columns: minmax(0, 1fr); }
  .bxf-qrCopy { width: 100%; }
  .bxf-connectedTop { align-items: flex-start; flex-direction: column; }
  .bxf-inlineError { grid-template-columns: minmax(0, 1fr); padding: 20px; }
  .bxf-statusNotice { align-items: flex-start; flex-wrap: wrap; }
  .bxf-cardBody { padding: 20px; }
}

@media (prefers-reduced-motion: reduce) {
  .bxf-page *, .bxf-page *::before, .bxf-page *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; transition-duration: .01ms !important; }
}
`;

export function installFeishuStyles() {
  if (typeof document === "undefined") {
    return () => {};
  }

  const existing = document.querySelector(
    `style[data-plugin-css="${FEISHU_STYLE_ID}"]`,
  );
  if (existing) {
    return () => {};
  }

  const style = document.createElement("style");
  style.dataset.plugin = "@xmanrui/dsh-im";
  style.dataset.pluginCss = FEISHU_STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);

  return () => {
    style.remove();
  };
}
