export const IM_STYLE_ID = 'xmanrui-dsh-im-settings';

const CSS = String.raw`
.dim-connectionDiagnostic { min-width: 0; width: 100%; color: var(--dsw-alias-label-secondary, #646a73); overflow-wrap: anywhere; font-size: var(--dim-font-13); line-height: var(--dim-line-13); }
.dim-connectionDiagnostic[data-warning="true"] { color: var(--dsw-alias-state-warn-primary, #d97706); }
.dim-connectionDiagnostic p { margin: 4px 0; }
.dim-connectionDiagnostic button { height: 28px; display: inline-flex; align-items: center; justify-content: center; padding: 0 10px; border: var(--dim-control-border); border-radius: var(--dim-radius-14); color: inherit; background: transparent; font: inherit; font-size: var(--dim-font-12); line-height: var(--dim-line-12); cursor: pointer; }
.dim-connectionDiagnostic button:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); }
/* Native Tooltip skin, declared once. The tooltips in this sheet carry
   only their positioning; these nine declarations used to be repeated
   character for character in every one of them. */
.dim-botNameTooltip,
.dim-updateTooltip,
.dim-githubTooltip,
.dim-generalSettingsTooltip,
.dim-generalSettingsButton[aria-current="page"] + .dim-generalSettingsTooltip,
.dim-helpPanel,
.bxf-repairTooltip {
  padding: 3px 7px;
  border: 0;
  border-radius: var(--dim-radius-8);
  color: var(--dsw-static-neutral-bluish-00, #f9fafb);
  background: var(--dsw-alias-tooltip-bg, #2c2c2e);
  box-shadow: none;
  font-size: var(--dim-font-13);
  line-height: var(--dim-line-13);
  font-weight: var(--dim-weight-400);
}
.dim-aliasName { display: flex; align-items: center; gap: var(--dim-gap-4); min-width: 0; }
.dim-aliasName h3 { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dim-aliasName h3:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); outline-offset: 2px; border-radius: var(--dim-radius-3); }
.dim-botNameTooltip { position: fixed; z-index: var(--dim-z-portal); width: max-content; max-width: min(320px, calc(100vw - 16px)); white-space: normal; overflow-wrap: anywhere; pointer-events: none; animation: dim-botNameTooltip-in .15s ease; }
@keyframes dim-botNameTooltip-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .dim-botNameTooltip { animation: none; } }
.dim-aliasEntry { display: inline-flex; flex: none; }
.dim-aliasEdit { display: grid; place-items: center; width: 28px; height: 28px; padding: 4px; border: 0; border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-tertiary, #81858c); background: transparent; cursor: pointer; }
.dim-aliasEdit svg { opacity: .55; transition: opacity .15s ease; }
.dim-aliasName:hover .dim-aliasEdit:not(:disabled) svg, .dim-aliasEdit:focus-visible svg { opacity: 1; }
.dim-aliasEdit:hover:not(:disabled), .dim-aliasEdit:focus-visible { color: var(--dim-blue); background: var(--dim-hover); }
.dim-aliasDialog { box-sizing: border-box; width: min(380px, calc(100% - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto; padding: 22px; border: 0; border-radius: var(--dim-radius-32); background: var(--dsw-alias-bg-layer-2, #fff); box-shadow: var(--dsw-elevation-prominent, 0 0 0 .5px rgb(0 0 0 / 16%), 0 3px 8px rgb(0 0 0 / 4%), 0 0 20px rgb(0 0 0 / 5%)); color: var(--dsw-alias-label-primary, #0f1115); font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.dim-aliasDialog * { box-sizing: border-box; }
.dim-aliasDialog::backdrop { background: var(--dsw-alias-bg-mask-1, rgb(0 0 0 / 24%)); backdrop-filter: var(--dsw-mask-blur, blur(2px)); }
.dim-aliasHeader { display: flex; justify-content: space-between; align-items: center; gap: var(--dim-gap-12); margin-bottom: 18px; }
.dim-aliasHeader h3 { margin: 0; font-size: var(--dim-font-16); line-height: var(--dim-line-16); font-weight: var(--dim-weight-500); }
.dim-aliasDialog button { font: inherit; cursor: pointer; }
.dim-aliasDialog .dim-aliasClose { width: 28px; height: 28px; padding: 0; border: none; border-radius: var(--dim-radius-8); background: transparent; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-18); cursor: pointer; }
.dim-aliasDialog .dim-aliasClose:hover:not(:disabled) { background: var(--dim-hover); }
.dim-aliasOriginal { display: flex; flex-wrap: wrap; gap: var(--dim-gap-6) 14px; padding: 10px 12px; margin-bottom: 18px; border-radius: var(--dim-radius-8); background: var(--dsw-alias-bg-layer-2, #f5f6f7); overflow-wrap: anywhere; }
.dim-aliasOriginal > span:first-child { flex: none; color: var(--dsw-alias-label-secondary, #646a73); }
.dim-aliasDialog .dim-helpRow { margin-bottom: 7px; }
.dim-aliasDialog .dim-helpRow label { margin-bottom: 0; }
.dim-aliasDialog label { display: block; margin-bottom: 7px; }
.dim-aliasDialog input { width: 100%; height: 32px; padding: 0 10px; border: var(--dim-field-border); border-radius: var(--dim-field-radius); color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; font-size: var(--dim-font-14); line-height: var(--dim-line-14); }
.dim-aliasError { color: var(--dim-danger); overflow-wrap: anywhere; }
.dim-aliasFooter { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--dim-gap-14); margin-top: 24px; }
.dim-aliasRestore { padding: 4px 0; border: 0; color: var(--dim-blue); background: transparent; }
.dim-aliasActions { display: flex; gap: var(--dim-gap-8); margin-left: auto; }
.dim-aliasActions button { height: 28px; display: inline-flex; align-items: center; justify-content: center; padding: 0 10px; border: var(--dim-control-border); border-radius: var(--dim-radius-14); color: var(--dsw-alias-label-primary, #0f1115); background: transparent; font: inherit; font-size: var(--dim-font-12); line-height: var(--dim-line-12); white-space: nowrap; cursor: pointer; }
.dim-aliasActions .dim-aliasSave { border-color: var(--dsw-alias-border-l3, rgb(0 0 0 / 12%)); color: var(--dsw-alias-label-primary, #0f1115); background: transparent; }
.dim-aliasEdit:disabled, .dim-aliasDialog button:disabled, .dim-aliasDialog input:disabled { opacity: 0.4; cursor: not-allowed; }
.dim-aliasEdit:focus-visible, .dim-aliasDialog button:focus-visible, .dim-aliasDialog input:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); outline-offset: 2px; }
@media (pointer: coarse) { .dim-aliasEdit, .dim-aliasDialog button { min-width: 44px; min-height: 44px; } .dim-aliasDialog input { font-size: var(--dim-font-16); } }
/* Plugin token layer. Declared on body. Two constraints have to hold at once,
   and only body satisfies both.

   It cannot live on .dim-page. Five surfaces are portalled to <body> - the
   directory picker, the alias dialog, the context dialog, the update dialog
   and the bot-name tooltip - so they sit outside .dim-page. A custom property
   is inherited through the DOM, and at <body> every one of these was
   undefined, so each declaration reading one was invalid and silently
   dropped: measured, a probe element at body with border:
   var(--dim-field-border) computed to 0px none, and border-radius:
   var(--dim-field-radius) to 0px. The portalled surfaces were rendering with
   no border and no radius at all.

   It cannot live on :root either. A custom property is substituted on the
   element that declares it, and the host publishes --dsw-* on <body>, not on
   <html>. Declared on :root, every alias below substituted against a missing
   token and froze to its literal fallback, for every theme: measured,
   redefining --dsw-alias-border-l4 on body left --dim-field-border at
   rgb(0 0 0 / 16%) instead of following it, so the whole layer was pinned to
   light-mode values and a dark theme would have painted light borders, light
   hover fills and light module fills. The same probe with the layer moved to
   body follows the sentinel, and a child appended to body - which is what a
   portal is - inherits it.

   The --dim- prefix leaves the host --dsw-/--dsh- namespaces untouched. */
body {
  --dim-blue: var(--dsw-alias-state-business-primary, #4176e6);
  --dim-blue-soft: color-mix(in srgb, var(--dim-blue) 9%, transparent);
  /* Field and control language, copied from the native settings form
     (ui-settings-plugins fields.module.css) and the native primitives
     (ui-primitives Input/Switch/Menu, ui-settings-models ModelsSection).
     Restating these as local properties keeps nine near-duplicate input
     skins from drifting apart again. */
  --dim-field-border: 0.5px solid var(--dsw-alias-border-l4, rgb(0 0 0 / 16%));
  --dim-control-border: 0.5px solid var(--dsw-alias-border-l3, rgb(0 0 0 / 12%));
  /* The radius ladder, declared once. */
  --dim-radius-3: 3px;
  --dim-radius-8: 8px;
  --dim-radius-10: 10px;
  --dim-radius-12: 12px;
  --dim-radius-14: 14px;
  --dim-radius-16: 16px;
  --dim-radius-18: 18px;
  --dim-radius-20: 20px;
  --dim-radius-24: 24px;
  --dim-radius-32: 32px;
  /* Genuinely round, and the tab indicator shape - neither is a rung. */
  --dim-radius-full: 999px;
  /* The gap scale. */
  --dim-gap-1: 1px;
  --dim-gap-2: 2px;
  --dim-gap-3: 3px;
  --dim-gap-4: 4px;
  --dim-gap-5: 5px;
  --dim-gap-6: 6px;
  --dim-gap-7: 7px;
  --dim-gap-8: 8px;
  --dim-gap-9: 9px;
  --dim-gap-10: 10px;
  --dim-gap-11: 11px;
  --dim-gap-12: 12px;
  --dim-gap-14: 14px;
  --dim-gap-15: 15px;
  --dim-gap-16: 16px;
  --dim-gap-18: 18px;
  --dim-gap-20: 20px;
  /* 22px is not a rung the host's own ladder names, but it is the value its settings
     tab strips use (PluginsSettingsSection .tabs gap: 22px), so the three tab strips
     here read it rather than each writing the literal. */
  --dim-gap-22: 22px;
  --dim-gap-24: 24px;
  --dim-gap-30: 30px;
  --dim-gap-32: 32px;
  --dim-gap-34: 34px;
  /* The channel rail's fixed track. The page is a two-column list now that it lives
     on the Plugins page and the shell hands it a wide column. The rail keeps this
     width whatever its height does, so a long channel list scrolls inside it instead
     of reflowing into ragged rows. Height never feeds back into it. */
  --dim-rail-width: 200px;
  --dim-field-radius: var(--dim-radius-8);
  --dim-module-fill: var(--dsw-alias-bg-module-platform, #f5f6f7);
  --dim-hover: var(--dsw-alias-interactive-bg-hover, rgb(38 49 72 / 6%));
  --dim-hover-solid: var(--dsw-alias-interactive-bg-hover-solid, #f1f3f5);
  --dim-focus: var(--dsw-alias-brand-primary, #0f1115);
  --dim-focus-shadow: 0 0 0 2px var(--dsw-alias-border-l3, rgb(0 0 0 / 12%));
  /* The disclosure motion, read by both halves of the expand gesture. ui-theme
     base.css declares --ds-ease-in-out as exactly cubic-bezier(0.4, 0, 0.2, 1),
     which is the curve the collapsing body and its arrow were each hardcoding. */
  --dim-disclosure-duration: .22s;
  --dim-disclosure-ease: var(--ds-ease-in-out, cubic-bezier(.4, 0, .2, 1));
  --dim-danger: var(--dsw-alias-state-error-primary, #ec1313);
  --dim-danger-hover: var(--dsw-alias-interactive-bg-hover-danger, rgb(236 19 19 / 5%));
  /* The filled-action pair, taken whole from the host so the fill and the text on it can
     never drift apart. --dsw-alias-button-primary-fill is --dsw-alias-brand-primary
     (bluish-1000 #0f1115 light / bluish-50 #f9fafb dark) and
     --dsw-alias-label-primary-foreground is its matched label (#fff light / #0f1115 dark):
     18.90:1 and 18.08:1. Every control that paints a fill reads this pair, so no channel
     brand colour reaches a control - brand survives on identity marks only. */
  --dim-action-fill: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #0f1115));
  --dim-action-fill-hover: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary, #0f1115));
  --dim-action-on-fill: var(--dsw-alias-label-primary-foreground, #fff);
  /* The QR frame is deliberately white in every theme - a code has to be dark on
     white to scan - so anything written on it must be frozen too, or it turns
     near-white in dark and disappears. .dim-qrExpired already did this. */
  --dim-on-qr: var(--dsw-static-neutral-bluish-1000, #0f1115);
  --dim-on-qr-muted: #646a73;
  /* The stacking ladder. Layers that exist as a concept get a name; the local 1s
     and 2s stay literal because they are per-component stacking contexts rather
     than a layer of the app. */
  --dim-z-tooltip-page: 20;
  --dim-z-tooltip: 30;
  --dim-z-popover: 40;
  --dim-z-portal: 1000;
  --dim-z-menu: 1100;
  /* The type scale, declared once. Every size below was already on the native
     ladder; this only gives the ladder one address. */
  --dim-font-11: 11px;
  --dim-font-12: 12px;
  --dim-font-13: 13px;
  --dim-font-14: 14px;
  --dim-font-15: 15px;
  --dim-font-16: 16px;
  --dim-font-18: 18px;
  --dim-font-20: 20px;
  /* The code/mono family, at one address. Three literal stacks used to ship
     (Menlo-tailed, a shorter one, and a Consolas one) and only Feishu read the host.
     The host publishes exactly one code family - ui-theme base.css:9-10
     --ds-font-family-code - so this reads it, and the fallback is the stack the
     plugin used most, kept so a missing host token still lands on a monospace. */
  --dim-font-mono: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  /* Weight ladder. The plugin wrote three literal weights 97 times; this gives the
     axis one address. No host token exists for weight, so the values are the ones
     already in use. */
  --dim-weight-400: 400;
  --dim-weight-500: 500;
  --dim-weight-600: 600;
  /* Leading, PAIRED WITH THE SIZE RUNG rather than keyed by value. The host pairs
     size with line-height (ui-theme gradient-shadow-text.css:179-268), so a leading
     token is only meaningful next to the rung it belongs to. Only the rungs the host
     itself pairs get one - 12/18, 13/20, 14/22, 16/24, 20/28. The 18px rung is added below
     because the host's own component CSS pairs it even though the ladder skips it; 11 and
     15 still have no host answer and keep their literal, which is what the census found
     (11px text runs at 16px and 17px with nothing to copy). */
  /* The label tier's line height. The host's 11px roles are 11/16 (.rowTag,
     .cardIdentity); the 17px some of these carried was the plugin's own. */
  --dim-line-11: 16px;
  --dim-line-12: 18px;
  --dim-line-13: 20px;
  --dim-line-14: 22px;
  --dim-line-16: 24px;
  /* No 18px rung exists in the host ladder (16/24 then 20/28), but the host's component CSS
     pairs it with 24px anyway: ui-sidebar SidebarRoot.module.css:151-153 is 18 / 600 / 24, and
     ui-settings-plugins PluginsSettingsSection.module.css:13-14 and ui-agent-preset
     AgentPresetSection.module.css:11-12 both use 18 / 600. So 18/24 IS the host's answer. */
  --dim-line-18: 24px;
  /* The 15px rung is not in the host ladder either, but the host's component CSS pairs it:
     ui-agent-preset AgentPresetSection.module.css:243-245 is 15 / 600 / 1.4, which is 21px. */
  --dim-line-15: 21px;
  --dim-line-20: 28px;
  /* Native select chrome: the OS arrow is replaced by the 12px chevron
     ui-settings-models draws, because a data-URI SVG cannot read a token. */
  --dim-chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
}
.dim-page {
  width: 100%;
  max-width: 1080px;
  padding: 0 0 24px;
  color: var(--dsw-alias-label-primary, #0f1115);
  box-sizing: border-box;
}
.dim-page *, .dim-page *::before, .dim-page *::after { box-sizing: border-box; }
.dim-title { display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-16); margin: 0 0 12px; }
.dim-brand { min-width: 0; width: max-content; max-width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: var(--dim-gap-1); margin: -2px -6px; padding: 2px 6px; border-radius: var(--dim-radius-8); }
.dim-brandVersion { display: inline-flex; align-items: center; padding: 1px 8px; border: 0.5px solid var(--dsw-alias-border-l4, rgb(0 0 0 / 16%)); border-radius: var(--dim-radius-full); corner-shape: round; color: var(--dsw-alias-label-tertiary, #81858c); font: 500 11px/17px var(--dim-font-mono); }
.dim-titleActions { display: flex; align-items: center; justify-content: flex-end; gap: var(--dim-gap-8); flex-wrap: wrap; }
.dim-updateButton { height: 28px; display: inline-flex; align-items: center; justify-content: center; gap: var(--dim-gap-4); padding: 0 10px; border: var(--dim-control-border); border-radius: var(--dim-radius-14); color: var(--dsw-alias-label-secondary, #646a73); background: transparent; font: inherit; font-size: var(--dim-font-12); line-height: var(--dim-line-12); cursor: pointer; }
.dim-updateButton:hover:not(:disabled) { color: var(--dsw-alias-label-primary, #0f1115); background: var(--dim-hover-solid); }
.dim-updateButton:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); }
.dim-updateButton:disabled { opacity: 0.4; cursor: default; }
.dim-updateAction { position: relative; display: inline-flex; flex: none; }
.dim-updateTrigger { width: 28px; height: 28px; flex: none; padding: 0; }
.dim-updateTrigger svg { display: block; }
.dim-updateBackdrop { position: fixed; inset: 0; z-index: var(--dim-z-portal); display: grid; place-items: center; padding: 24px; background: var(--dsw-alias-bg-mask-1, rgb(0 0 0 / 24%)); backdrop-filter: var(--dsw-mask-blur, blur(2px)); }
.dim-updateBackdrop, .dim-updateBackdrop * { box-sizing: border-box; }
.dim-updateDialog { width: min(480px, 100%); max-height: calc(100vh - 48px); overflow-y: auto; border: 0; border-radius: var(--dim-radius-32); background: var(--dsw-alias-bg-layer-2, #fff); box-shadow: var(--dsw-elevation-prominent, 0 0 0 .5px rgb(0 0 0 / 16%), 0 3px 8px rgb(0 0 0 / 4%), 0 0 20px rgb(0 0 0 / 5%)); color: var(--dsw-alias-label-primary, #0f1115); text-align: left; }
.dim-updateDialog:focus { outline: none; }
.dim-updateDialog h3 { margin: 22px 24px 8px; font-size: var(--dim-font-16); line-height: var(--dim-line-16); font-weight: var(--dim-weight-500); }
/* The title and its help button are one row now, so the row takes the block margin the
   heading used to carry and the heading gives it up - otherwise the button sits 24px
   away from the title it explains and 7px below its centre. */
.dim-updateDialog .dim-helpRow { margin: 22px 24px 8px; }
.dim-updateDialog .dim-helpRow h3 { margin: 0; }
.dim-updateBody { padding: 18px 24px 20px; }
.dim-updateVersions { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--dim-gap-8) 18px; margin: 0 0 18px; font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-updateVersions dt { color: var(--dsw-alias-label-secondary, #646a73); }
.dim-updateVersions dd { min-width: 0; margin: 0; overflow-wrap: anywhere; font-family: var(--dim-font-mono); }
.dim-updateStatus { padding: 12px 14px; border: 0.5px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: var(--dim-radius-10); background: var(--dsw-alias-bg-layer-1, #f7f8fa); font-size: var(--dim-font-13); line-height: var(--dim-line-13); }
.dim-updateStatus strong { font-weight: var(--dim-weight-600); }
.dim-updateStatus p { margin: 6px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); overflow-wrap: anywhere; }
.dim-updateStatusError { border-color: color-mix(in srgb, var(--dim-danger) 25%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); }
.dim-updateHint, .dim-updateError { margin: 12px 0 0; font-size: var(--dim-font-12); line-height: var(--dim-line-12); overflow-wrap: anywhere; }
.dim-updateHint { color: var(--dsw-alias-label-tertiary, #81858c); }
.dim-updateError { color: var(--dim-danger); }
.dim-updateManual { margin-top: 18px; padding-top: 16px; border-top: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); }
.dim-updateManualHeading { margin: 0; font-size: var(--dim-font-13); line-height: var(--dim-line-13); font-weight: var(--dim-weight-500); }
.dim-updateManualHint { margin: 8px 0 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-updateCommandRow { display: flex; align-items: center; gap: var(--dim-gap-8); margin-top: 10px; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); border-radius: var(--dim-radius-8); background: var(--dsw-alias-bg-layer-1, #f7f8fa); }
.dim-updateCommand { display: block; flex: 1; width: 100%; min-width: 0; padding: 0; resize: none; border: 0; color: var(--dsw-alias-label-primary, #0f1115); background: transparent; font: 12px/19px var(--dim-font-mono); overflow-wrap: anywhere; }
.dim-updateCommand:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); outline-offset: 2px; }
.dim-updateCopy { display: inline-flex; flex: 0 0 28px; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-secondary, #646a73); background: transparent; cursor: pointer; }
.dim-updateCopy:hover:not(:disabled) { color: var(--dsw-alias-label-primary, #0f1115); background: var(--dim-hover); }
.dim-updateCopy:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); outline-offset: 2px; }
.dim-updateCopy:disabled { opacity: 0.4; cursor: default; }
.dim-updateCopyCopied { color: var(--dsw-alias-state-success-primary, #20a162); }
.dim-updateFooter { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: var(--dim-gap-8); padding: 14px 24px; border-top: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); }
.dim-updateFooter .dim-updateButton:first-child { margin-right: auto; }
.dim-updatePrimary, .dim-updatePrimary:hover:not(:disabled) { border-color: var(--dim-blue); color: var(--dim-action-on-fill, #fff); background: var(--dim-blue); }
.dim-githubAction { position: relative; display: inline-flex; flex: none; }
.dim-githubLink { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; flex: none; padding: 0; border: none; border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-tertiary, #81858c); background: transparent; font-size: var(--dim-font-12); line-height: var(--dim-line-12); text-decoration: none; transition: color .15s ease, background .15s ease; }
.dim-githubLink:hover { color: var(--dsw-alias-label-primary, #0f1115); background: var(--dim-hover); }
.dim-githubLink:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); }
.dim-githubLink svg { display: block; }
.dim-updateTooltip, .dim-githubTooltip { position: absolute; top: calc(100% + 8px); right: 0; z-index: var(--dim-z-tooltip-page); width: max-content; max-width: min(220px, 80vw); white-space: nowrap; opacity: 0; visibility: hidden; transform: translateY(-3px); pointer-events: none; transition: opacity .15s ease, transform .15s ease, visibility .15s ease; }
.dim-updateAction:hover .dim-updateTooltip, .dim-updateTrigger:focus-visible + .dim-updateTooltip, .dim-githubAction:hover .dim-githubTooltip, .dim-githubAction:focus-within .dim-githubTooltip { opacity: 1; visibility: visible; transform: translateY(0); }
.dim-generalSettingsAction { position: relative; display: inline-flex; flex: none; }
.dim-generalSettingsButton { width: 28px; height: 28px; display: grid; place-items: center; flex: none; padding: 0; border: none; border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-tertiary, #81858c); background: transparent; cursor: pointer; transition: color .15s ease, background .15s ease; }
.dim-generalSettingsButton svg { display: block; }
.dim-generalSettingsButton:hover { color: var(--dsw-alias-label-primary, #0f1115); background: var(--dim-hover); }
.dim-generalSettingsButton[aria-current="page"] { color: var(--dsw-alias-label-primary, #0f1115); background: var(--dim-module-fill); }
.dim-generalSettingsButton:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); }
.dim-generalSettingsTooltip { position: absolute; top: calc(100% + 8px); right: 0; z-index: var(--dim-z-tooltip-page); width: max-content; white-space: nowrap; opacity: 0; visibility: hidden; transform: translateY(-3px); pointer-events: none; transition: opacity .15s ease, transform .15s ease, visibility .15s ease; }
.dim-generalSettingsAction:hover .dim-generalSettingsTooltip, .dim-generalSettingsButton:focus-visible + .dim-generalSettingsTooltip { opacity: 1; visibility: visible; transform: translateY(0); }
.dim-generalSettingsButton[aria-current="page"] + .dim-generalSettingsTooltip { opacity: 0; visibility: hidden; transform: translateY(-3px); }
/* Channel switching is a two-column list: a fixed-width, vertically scrolling column
   of peers beside the panel. This replaced a wrapped tab strip. The strip was the
   right answer while the page lived in a 564px settings column - a second column
   there left the text at 341px and forced every hint to wrap. The host has since
   moved plugin configuration onto the Plugins page, where the same page has room for
   both columns, and wrapping turned the channel list into ragged rows whose current
   entry was hard to pick out. */
.dim-layout { display: grid; grid-template-columns: var(--dim-rail-width) minmax(0, 1fr); gap: var(--dim-gap-16); align-items: start; }
.dim-rail { display: flex; flex-direction: column; flex-wrap: nowrap; align-items: stretch; gap: var(--dim-gap-2); position: sticky; top: 0; align-self: start; width: var(--dim-rail-width); max-height: calc(100vh - 96px); overflow-y: auto; overscroll-behavior: contain; margin: 0; padding: 0; }
.dim-channel { position: relative; width: 100%; min-width: 0; flex: 0 0 auto; height: 44px; display: flex; align-items: center; gap: var(--dim-gap-8); padding: 0 12px; border: 1px solid transparent; border-radius: var(--dim-radius-12); color: var(--dsw-alias-label-secondary, #646a73); background: transparent; font: inherit; text-align: left; cursor: pointer; }
.dim-channel:hover { color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-specific-sidebar-nav-item-hover, var(--dim-hover)); }
.dim-channel[aria-selected="true"] { color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-specific-sidebar-nav-item-active, #ebeef2); }
/* Hover and current share one surface family, so the bar is what carries 'this is the
   one' when a pointer is also on the rail. Same idiom as the tab strips' indicator. */
.dim-channel[aria-selected="true"]::before { content: ''; position: absolute; left: 0; top: 50%; width: 3px; height: 20px; transform: translateY(-50%); border-radius: 0 var(--dim-radius-3) var(--dim-radius-3) 0; background: var(--dsw-alias-brand-primary, #0f1115); }
.dim-channel[aria-selected="true"] .dim-channelCopy strong { font-weight: var(--dim-weight-600); }
.dim-channel:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #0f1115); outline-offset: 2px; }
.dim-logo { width: 24px; height: 24px; flex: none; display: grid; place-items: center; border-radius: var(--dim-radius-10); }
.dim-logo svg { display: block; width: 17px; height: 17px; }
.dim-logoWeixin { color: white; background: #07c160; }
.dim-logoFeishu { background: white; border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); }
.dim-logoFeishu svg { width: 20px; height: 20px; }
.dim-logoDingtalk { color: white; background: #1677ff; }
.dim-logoQq { color: white; background: #1677ff; }
.dim-logoWecom { background: white; border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); }
.dim-logoWecom svg { width: 18px; height: 18px; }
.dim-logoTelegram { color: white; background: #229ed9; }
.dim-logoOffice { color: white; background: linear-gradient(145deg, #12213f, #3964fe); }
.dim-logoDiscord { color: white; background: #5865f2; }
.dim-logoSlack { background: linear-gradient(145deg, #fff, #f8fafb); border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); }
.dim-logoWhatsapp { color: white; background: #25d366; }
.dim-logoIMessage { color: white; background: linear-gradient(180deg, #5bf675 0%, #28d944 50%, #0fbd2c 100%); }
.dim-channelCopy { flex: 1 1 auto; min-width: 0; overflow: hidden; display: inline-flex; align-items: baseline; gap: var(--dim-gap-5); }
.dim-channelCopy strong { overflow: hidden; color: inherit; font-size: var(--dim-font-15); line-height: var(--dim-line-15); font-weight: var(--dim-weight-400); text-overflow: ellipsis; white-space: nowrap; }
/* Sits in the same slot the note text did, one line high. align-self keeps the glyph on
   the label's centre line: the copy row is baseline-aligned for text, and an svg on a
   baseline hangs below it. */
.dim-channelBadge { flex: none; align-self: center; display: inline-flex; align-items: center; color: var(--dsw-alias-label-tertiary, #81858c); white-space: nowrap; }
.dim-panel { min-width: 0; container-type: inline-size; }
.dim-loopbackRecovery { display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-16); margin: 0 0 14px; padding: 14px 16px; border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 30%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); border-radius: var(--dim-radius-12); color: var(--dsw-alias-label-primary, #0f1115); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 8%, var(--dsw-alias-bg-layer-1, #fff)); }
.dim-loopbackRecoveryCopy { min-width: 0; }
.dim-loopbackRecoveryCopy strong { display: block; font-size: var(--dim-font-14); line-height: var(--dim-line-14); font-weight: var(--dim-weight-600); }
.dim-loopbackRecoveryCopy p { margin: 3px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-loopbackRecoveryCopy code { display: block; overflow: hidden; margin-top: 5px; color: var(--dsw-alias-label-secondary, #646a73); font: 11px/16px var(--dim-font-mono); text-overflow: ellipsis; white-space: nowrap; }
.dim-loopbackRecoveryAction { flex: none; height: 28px; display: inline-flex; align-items: center; justify-content: center; padding: 0 10px; border: var(--dim-control-border); border-radius: var(--dim-radius-14); color: var(--dsw-alias-label-primary, #0f1115); background: transparent; font: inherit; font-size: var(--dim-font-12); line-height: var(--dim-line-12); white-space: nowrap; cursor: pointer; }
.dim-loopbackRecoveryAction:hover { background: var(--dim-hover-solid); }
.dim-loopbackRecoveryAction:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); }
.dim-panel .bxf-page, .dim-panel .dxw-page, .dim-panel .ddt-page, .dim-panel .dqq-page, .dim-panel .dwecom-page, .dim-panel .dsl-page, .dim-panel .dwa-page { width: 100%; max-width: none; padding: 0 0 24px; }
.dim-panel .bxf-heading, .dim-panel .dxw-heading, .dim-panel .ddt-heading { justify-content: flex-end; }
.dim-panel .bxf-headingTools, .dim-panel .dxw-tools, .dim-panel .ddt-tools { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) max-content; align-items: center; justify-content: stretch; gap: var(--dim-gap-8); }
.dim-panel .dim-bindActions { min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: var(--dim-gap-8); }
.dim-panel .dim-bindActions > button { min-width: 0; }
/* Theme-following action capsule (native Button .outline): the surface stays on
   the theme's own layer and only the content colour flips, so the QR glyph inside
   rides currentColor and stays legible in both themes. */
.dim-panel .bxf-headingTools .dim-scanButton, .dim-panel .dxw-tools .dim-scanButton, .dim-panel .ddt-tools .dim-scanButton { flex: none; height: 28px; display: inline-flex; align-items: center; justify-content: center; justify-self: start; gap: var(--dim-gap-6); padding: 0 10px; border: var(--dim-control-border); border-radius: var(--dim-radius-14); color: var(--dsw-alias-label-primary, #0f1115); background: transparent; box-shadow: none; font: inherit; font-size: var(--dim-font-12); line-height: var(--dim-line-12); white-space: nowrap; cursor: pointer; }
/* The scan and credential capsules are native's .outline button: the surface moves on
   hover and the border does not. The scan capsule used to declare kind="primary", which
   put the channel sheets' [data-kind="primary"] rules on it at (0,2,0) - rising to
   (0,4,0) on hover - both painting --dim-action-fill, near-white in dark and near-black
   in light, around a surface the rule above had already made neutral. Two owners, one
   capsule. That marker is gone, so those rules can no longer reach the capsule at all.
   The change is provably invisible: the shared (0,3,0) resting rule already declared
   every property the (0,2,0) rule did, with the same value, and the shared (0,5,0) hover
   rule did the same on hover - so the marker was a second owner that never won. Measured
   on 3080 by flipping data-kind in the live DOM: rest and hover are byte-identical.

   The same family's view-action capsules still carried the marker, and there the tie was
   real rather than theoretical. The channel's .dxw-button[data-kind="primary"]:hover:not(:disabled)
   and the shared resting .dim-panel .dim-viewActions .dxw-button[data-kind="primary"] are
   BOTH (0,4,0), so the winner was decided by <style> injection order: weixin is installed
   at sheet 110 and the shared sheet at 120, so the channel's filled hover lost and the
   button had no hover feedback at all; dingtalk is installed at sheet 121, so it won and
   the same button turned rgb(67,69,74) - a filled hover on a capsule the shared rule had
   already made transparent. One rule, two outcomes, decided by who happened to be
   installed last. Declaring the family's hover here at (0,5,0) removes the tie instead of
   leaning on the install order. Measured on 3081 across weixin / dingtalk / qq: the three
   are now byte-identical at rest and on hover. */
.dim-panel .bxf-headingTools .dim-scanButton:hover:not(:disabled), .dim-panel .dxw-tools .dim-scanButton:hover:not(:disabled), .dim-panel .ddt-tools .dim-scanButton:hover:not(:disabled), .dim-panel .dim-viewActions .bxf-button:hover:not(:disabled), .dim-panel .dim-viewActions .dxw-button:hover:not(:disabled), .dim-panel .dim-viewActions .ddt-button:hover:not(:disabled) { background: var(--dim-hover-solid); border-color: var(--dsw-alias-border-l3, rgb(0 0 0 / 12%)); }
.dim-panel .dim-credentialButton { flex: none; height: 28px; display: inline-flex; align-items: center; justify-content: center; gap: var(--dim-gap-6); padding: 0 10px; border: var(--dim-control-border); border-radius: var(--dim-radius-14); color: var(--dsw-alias-label-primary, #0f1115); background: transparent; font: inherit; font-size: var(--dim-font-12); line-height: var(--dim-line-12); white-space: nowrap; cursor: pointer; }

.dim-panel .dim-credentialButton:hover:not(:disabled) { background: var(--dim-hover-solid); border-color: var(--dsw-alias-border-l3, rgb(0 0 0 / 12%)); }
.dim-panel .dim-credentialButton[aria-pressed="true"] { border-color: transparent; background: var(--dsw-specific-sidebar-nav-item-active, #ebeef2); }
.dim-panel .bxf-headingTools .dim-onlineBadge, .dim-panel .dxw-tools .dim-onlineBadge, .dim-panel .ddt-tools .dim-onlineBadge { height: 24px; min-height: 24px; display: inline-flex; align-items: center; justify-self: end; gap: var(--dim-gap-4); padding: 0 8px; border: none; border-radius: var(--dim-radius-12); color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-bg-layer-2, #fff); font: inherit; font-size: var(--dim-font-12); font-weight: var(--dim-weight-400); line-height: var(--dim-line-12); white-space: nowrap; }
.dim-panel .dim-channelPage { min-width: 0; width: 100%; max-width: none; display: flex; flex-direction: column; gap: var(--dim-gap-12); padding: 0 0 24px; color: var(--dsw-alias-label-primary, #0f1115); box-sizing: border-box; }
/* An enum inside a .field is a real select in the host too - settings-models
   bundle:1300-1305, :1680-1685, :2093-2098 render one inside .field with
   className "input selectInput". These take that skin verbatim (.input is
   border-l4 .5px, radius 8, bg-layer-1, 32px, padding 0 10px, 14/22; select.input
   adds cursor:pointer and max-width:240px; .selectInput adds the 12px chevron at
   right 12px). Only the right padding is ours: a background arrow needs the room,
   and the host's own padding-left of 10px would run text under it.
   The standalone .dim-fieldSelect class is gone: its last two users were the Feishu
   Group tab's settings, which are rows (title left, control right), not fields in a
   grid - they now take .dim-rowControl like the Delivery tab's row already did. This
   rule is left for real form fields only. */
.dim-panel .dim-targetField select,
.dim-panel .dim-targetSuggestionField select,
.dim-panel .dim-accessField select {
  box-sizing: border-box; width: 100%; min-width: 0; max-width: 240px; height: 32px;
  padding: 0 28px 0 10px; appearance: none;
  border: var(--dim-field-border); border-radius: var(--dim-field-radius);
  color: var(--dsw-alias-label-primary, #0f1115); background-color: var(--dsw-alias-bg-layer-1, #fff);
  background-image: var(--dim-chevron); background-repeat: no-repeat;
  background-position: right 12px center; background-size: 12px 12px;
  font: inherit; font-size: var(--dim-font-14); line-height: var(--dim-line-14); cursor: pointer;
}
.dim-panel .dim-targetField select:focus,
.dim-panel .dim-targetSuggestionField select:focus,
.dim-panel .dim-accessField select:focus { outline: none; border-color: var(--dim-focus); }
.dim-panel .dim-targetField select:disabled,
.dim-panel .dim-targetSuggestionField select:disabled,
.dim-panel .dim-accessField select:disabled { opacity: 0.6; cursor: default; }
.dim-panel .dim-surfaceCard { position: relative; overflow: hidden; border: 0.5px solid var(--dsw-alias-border-l4, rgb(0 0 0 / 16%)); border-radius: var(--dim-radius-16); background: none; }
.dim-panel .dim-surfaceCard::before { display: none; }
.dim-panel .dim-surfaceBody { padding: 24px; }
.dim-panel .dim-credentialPanel { display: grid; gap: var(--dim-gap-16); padding: 20px; }
.dim-panel .dim-credentialTitle { margin: 0; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-16); line-height: var(--dim-line-16); font-weight: var(--dim-weight-500); }
.dim-panel .dim-credentialForm { min-width: 0; display: grid; gap: var(--dim-gap-16) 12px; }
.dim-panel .dim-credentialFormSingle { grid-template-columns: minmax(0, 1fr); }
.dim-panel .dim-credentialField { min-width: 0; display: grid; gap: var(--dim-gap-6); color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-13); line-height: var(--dim-line-13); font-weight: var(--dim-weight-500); }
.dim-panel .dim-credentialField input { width: 100%; min-width: 0; height: 32px; padding: 0 10px; border: var(--dim-field-border); border-radius: var(--dim-field-radius); outline: none; color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-alias-bg-layer-1, #fff); font: 13px/1.5 var(--dim-font-mono); transition: border-color .16s ease; }
.dim-panel .dim-credentialField input:focus { outline: none; border-color: var(--dim-focus); }
.dim-panel .dim-credentialField input::placeholder { color: var(--dsw-alias-label-caption, #adb2b8); font-family: inherit; }
.dim-panel .dim-credentialError, .dim-panel .dim-credentialActions { grid-column: 1 / -1; }
.dim-panel .dim-credentialError { margin: 0; color: var(--dim-danger); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-panel .dim-credentialActions { margin-top: 0; }
.dim-panel .dim-listSection { min-width: 0; width: 100%; max-width: 100%; display: flex; flex-direction: column; gap: var(--dim-gap-12); }
.dim-panel .dim-listHeading { min-height: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-16); margin: 0; padding: 0; }
.dim-panel .dim-listConnection { color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
/* An earlier pass moved this to label-tertiary, citing the host's .sectionTitle and
   .groupTitle. Measured since: those are the titles INSIDE a menu or popover, and the
   host's content pages carry no intermediate heading above a card list at all - they
   have a page heading (h2.heading, 18/600) and nothing between it and the cards. The
   nearest role that does exist for a heading inside a card is the host's own in-card
   title (.editorTitle, .rowName): 14/22/500 in label-primary. This now matches
   .dim-presetHeader's base rule, which is the same level and was the second value the
   same level carried. */
.dim-panel .dim-listHeading h3 { margin: 0; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-14); line-height: var(--dim-line-14); font-weight: var(--dim-weight-500); }
.dim-panel .dim-listTitle { min-width: 0; display: inline-flex; align-items: center; gap: var(--dim-gap-6); }
.dim-panel .dim-botList { min-width: 0; width: 100%; max-width: 100%; display: flex; flex-direction: column; gap: var(--dim-gap-10); margin: 0; padding: 0; list-style: none; }
.dim-panel .dim-botList > li { min-width: 0; max-width: 100%; }
.dim-panel .dim-loadingView { padding: 38px; color: var(--dsw-alias-label-tertiary, #81858c); text-align: center; }
.dim-panel .dim-loadingView h3 { margin: 0 0 7px; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-16); line-height: var(--dim-line-16); font-weight: var(--dim-weight-500); }
.dim-panel .dim-loadingView p { margin: 0; line-height: 1.6; }
.dim-panel .dim-spinner { width: 24px; height: 24px; margin: 0 auto 12px; border: 3px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); border-top-color: var(--dim-blue); border-radius: 50%; corner-shape: round; animation: dim-spin .8s linear infinite; }
@keyframes dim-spin { to { transform: rotate(360deg); } }
.dim-panel .dim-emptyView { display: grid; align-items: center; gap: var(--dim-gap-30); }
.dim-panel .dim-emptyCopy { min-width: 0; }
.dim-panel .dim-emptyCopy h3 { margin: 8px 0; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-18); line-height: var(--dim-line-18); font-weight: var(--dim-weight-600); }
.dim-panel .dim-emptyCopy > p { max-width: 560px; margin: 0; color: var(--dsw-alias-label-tertiary, #81858c); line-height: 1.65; }
.dim-panel .dim-emptyBrand { width: 110px; height: 110px; display: grid; place-items: center; justify-self: center; border-radius: var(--dim-radius-24); box-shadow: 0 18px 45px rgb(22 119 255 / 18%); }
/* The dot-plus-label connection indicator is a native component: ui-primitives
   ConnectionIndicator.module.css:12-15 is 12px / 500 / 18px and carries its state in the dot, with a
   neutral label. The plugin drew the same thing at weight 600; it now reads the host's 500. */
.dim-panel .dim-stateLabel { display: inline-flex; align-items: center; gap: var(--dim-gap-8); color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); font-weight: var(--dim-weight-500); }
.dim-panel .dim-stateDot { flex: none; width: 8px; height: 8px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-label-tertiary, #81858c); box-shadow: none; }
/* The tone halo belongs to the ROLE, not to whichever channel sheet happened to author it.
   All three channels that draw a halo used the same host tone token at the same 14% alpha;
   they differed only in radius (3px on dingtalk/weixin, 4px on feishu) and in who won the
   cascade. Because the shared sheet is installed after feishu and weixin but BEFORE dingtalk,
   the tie at (0,2,0) resolved differently per channel: measured on 3080, a
   .dim-stateDot[data-tone="success"] renders a 3px halo on the dingtalk/qq family and NO halo
   on weixin. Declaring it here makes it one role property again - dingtalk keeps winning its
   own tie with the identical value, and weixin/feishu now show the same halo as everyone else. */
.dim-panel .dim-stateDot[data-tone="success"] { background: var(--dsw-alias-state-success-primary, #20a162); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary, #20a162) 14%, transparent); }
.dim-panel .dim-stateDot[data-tone="warning"] { background: var(--dsw-alias-state-warn-primary, #d97706); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 14%, transparent); }
.dim-panel .dim-stateDot[data-tone="error"] { background: var(--dim-danger); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dim-danger) 14%, transparent); }
.dim-panel .dim-viewActions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--dim-gap-10); margin-top: 20px; }
.dim-panel .dim-viewActions .bxf-button, .dim-panel .dim-viewActions .dxw-button, .dim-panel .dim-viewActions .ddt-button { height: 28px; display: inline-flex; align-items: center; justify-content: center; padding: 0 10px; border: var(--dim-control-border); border-radius: var(--dim-radius-14); color: var(--dsw-alias-label-primary, #0f1115); background: transparent; box-shadow: none; font: inherit; font-size: var(--dim-font-12); line-height: var(--dim-line-12); white-space: nowrap; cursor: pointer; }
.dim-panel .dim-viewActions .bxf-button[data-kind="primary"], .dim-panel .dim-viewActions .dxw-button[data-kind="primary"], .dim-panel .dim-viewActions .ddt-button[data-kind="primary"] { border: var(--dim-control-border); color: var(--dsw-alias-label-primary, #0f1115); background: transparent; box-shadow: none; }
.dim-panel .dim-viewActions .bxf-button[data-kind="danger"], .dim-panel .dim-viewActions .dxw-button[data-kind="danger"], .dim-panel .dim-viewActions .ddt-button[data-kind="danger"] { color: var(--dim-danger); }
.dim-panel .dim-qrLayout { display: grid; gap: var(--dim-gap-34); align-items: start; }
.dim-panel .dim-qrColumn { width: 100%; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: var(--dim-gap-12); }
.dim-panel .dim-qrFrame { position: relative; width: min(270px, 100%); height: auto; aspect-ratio: 1; display: grid; place-items: center; overflow: hidden; padding: 10px; border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); border-radius: var(--dim-radius-16); background: #fff; }
.dim-panel .dim-qrFrame::before { display: none; }
.dim-panel .dim-qrFrame::after { display: none; }
.dim-panel .dim-qrFrame img { position: relative; z-index: 1; width: 100%; height: 100%; display: block; object-fit: contain; }
.dim-panel .dim-qrFallback { position: relative; z-index: 1; display: grid; place-items: center; gap: var(--dim-gap-8); color: var(--dim-on-qr-muted, #646a73); font-size: var(--dim-font-14); line-height: var(--dim-line-14); text-align: center; }
.dim-panel .dim-qrExpired { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; padding: 20px; color: var(--dsw-static-neutral-bluish-1000, #0f1115); background: rgb(255 255 255 / 92%); font-size: var(--dim-font-15); line-height: var(--dim-line-15); font-weight: var(--dim-weight-600); text-align: center; white-space: pre-line; backdrop-filter: blur(3px); }
.dim-panel .dim-countdown { width: min(270px, 100%); margin: 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-panel .dim-countdownTop { display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-12); margin-bottom: 6px; }
.dim-panel .dim-countdownTop strong { color: var(--dsw-alias-label-primary, #0f1115); font-weight: var(--dim-weight-600); }
.dim-panel .dim-progress { height: 4px; overflow: hidden; margin: 0; border-radius: var(--dim-radius-full); background: var(--dim-module-fill); }
.dim-panel .dim-progress span { display: block; width: var(--bxf-progress, var(--dxw-progress, var(--ddt-progress, 0%))); height: 100%; border-radius: inherit; background: var(--dim-blue); transition: width .25s linear; }
.dim-panel .dim-qrCopy { min-width: 0; overflow-wrap: anywhere; }
.dim-panel .dim-qrCopy h3 { margin: 9px 0 8px; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-18); line-height: var(--dim-line-18); font-weight: var(--dim-weight-600); }
.dim-panel .dim-qrCopy > p { margin: 0; color: var(--dsw-alias-label-tertiary, #81858c); line-height: 1.65; }
.dim-panel .dim-steps { margin: 18px 0 16px; padding: 0; list-style: none; counter-reset: dim-step; }
.dim-panel .dim-steps li { position: relative; min-height: 28px; display: flex; align-items: center; padding: 5px 0 5px 36px; color: var(--dsw-alias-label-tertiary, #81858c); line-height: 1.5; counter-increment: dim-step; }
.dim-panel .dim-steps li::before { content: counter(dim-step); position: absolute; left: 0; top: 4px; width: 24px; height: 24px; display: grid; place-items: center; border-radius: var(--dim-radius-12); color: var(--dim-blue); background: color-mix(in srgb, var(--dim-blue) 10%, transparent); font-size: var(--dim-font-12); font-weight: var(--dim-weight-500); }
.dim-panel .dim-specialView { padding: 32px; text-align: center; }
.dim-panel .dim-statusNotice { display: flex; align-items: flex-start; gap: var(--dim-gap-10); padding: 13px 15px; border: 0.5px solid color-mix(in srgb, var(--dim-danger) 22%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); border-radius: var(--dim-radius-10); color: var(--dim-danger); background: color-mix(in srgb, var(--dim-danger) 8%, var(--dsw-alias-bg-layer-1, #fff)); font-size: var(--dim-font-14); line-height: var(--dim-line-14); }
.dim-panel .dim-inlineError { display: flex; align-items: flex-start; flex-direction: column; gap: var(--dim-gap-10); padding: 22px; color: var(--dim-danger); background: color-mix(in srgb, var(--dim-danger) 8%, var(--dsw-alias-bg-layer-1, #fff)); }
.dim-panel .dim-inlineError > div { min-width: 0; }
/* The host's 16px heading role is 16 / 24 / 500, declared twice and identically:
   ui-primitives Modal.module.css:53-58 (.title, with the comment "figma wt510, rendered 500") and
   the type ladder's --dsw-font-base-strong-16 (gradient-shadow-text.css:207). All three of the
   plugin's 16px headings already had the 24px leading; only the weight was 600. */
.dim-panel .dim-inlineError h3 { margin: 0; color: inherit; font-size: var(--dim-font-16); line-height: var(--dim-line-16); font-weight: var(--dim-weight-500); overflow-wrap: anywhere; }
.dim-panel .dim-inlineError p { margin: 7px 0 0; color: inherit; line-height: 1.6; overflow-wrap: anywhere; }
.dim-panel .dim-confirm { padding: 18px 24px; border-top: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); background: var(--dim-hover); }
.dim-panel .dim-confirm strong, .dim-panel .dim-confirm h4 { margin: 0; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-14); line-height: var(--dim-line-14); font-weight: var(--dim-weight-600); }
.dim-panel .dim-confirm p { margin: 7px 0 0; color: var(--dsw-alias-label-secondary, #646a73); line-height: 1.6; }
/* padding-bottom was 0, so the last summary line sat flush against the card's
   bottom border (measured: hint bottom 885 == card bottom 885). The head uses
   16px, so the foot closes the card with the same inset. */
.dim-panel .dim-cardFooter { display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-12); padding: 12px 0 16px; border-top: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); }
.dim-panel .dim-workspace { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) max-content; align-items: center; column-gap: var(--dim-gap-12); row-gap: var(--dim-gap-4); margin: 0; padding: 16px 0; border: 0; background: none; }
/* The native settings-row title, byte-identical in five native modules
   (LanguageRow, EnterBehaviorRow, FontSizeRow, AppearanceRow, PermissionRow):
   14px / 400 / 22px / label-primary. 13px/500 is native too, but only as a
   STACKED field label or a group caption - never as a row label. */
.dim-panel .dim-workspaceHeader { display: contents; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-14); line-height: var(--dim-line-14); font-weight: var(--dim-weight-400); }
.dim-panel .dim-workspaceHeader > span { grid-column: 1; grid-row: 1; white-space: nowrap; }
.dim-panel .dim-workspaceEdit { grid-column: 2; grid-row: 1; height: auto; padding: 2px 0; border: none; border-radius: var(--dim-radius-8); color: var(--dsw-alias-link, #4176e6); background: transparent; font: inherit; font-size: var(--dim-font-12); line-height: var(--dim-line-12); font-weight: var(--dim-weight-500); white-space: nowrap; cursor: pointer; }
.dim-panel .dim-workspaceEdit:hover:not(:disabled) { background: var(--dim-hover); }
.dim-panel .dim-workspaceEdit:disabled { cursor: not-allowed; opacity: 0.4; }
.dim-panel .dim-workspacePath { min-width: 0; max-width: 100%; grid-column: 1 / -1; grid-row: 2; display: block; overflow: hidden; color: var(--dsw-alias-label-secondary, #646a73); font: 12px/18px var(--dim-font-mono); overflow-wrap: anywhere; white-space: normal; }
/* Agent Preset is a saved value, so it takes the plugin's stacked-field form
   (.dim-credentialField): label above, field below, full width. As a settings ROW the
   select was capped at max-width: 60%, which truncated the longer preset labels - the
   one thing a preset picker has to keep readable. */
.dim-panel .dim-preset { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); align-content: start; gap: var(--dim-gap-6); margin: 0; padding: 16px 0; border: 0; background: none; }
/* The host has two 12/18 caption roles and they are not interchangeable: label-tertiary
   is the hint/route role (.advancedHint, .editorRoute, .modelFieldLabel), while
   label-secondary is the caption that heads a sub-block (.fieldLabel,
   .modelCatalogTitle, .customizedSummary). This header is the second kind, so it stays
   secondary - an attempt to move it to tertiary cited the top-level .sectionTitle, which
   heads a page section rather than a sub-block, and was reverted. */
.dim-panel .dim-presetHeader { position: relative; min-width: 0; display: flex; align-items: center; gap: var(--dim-gap-8); color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-14); line-height: var(--dim-line-14); font-weight: var(--dim-weight-500); }
.dim-panel .dim-presetTitle { min-width: 0; display: inline-flex; align-items: center; gap: var(--dim-gap-8); white-space: nowrap; }
.dim-panel .dim-presetStatus { flex: none; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); white-space: nowrap; }
/* The row owns its vertical padding now (native: padding 16px 0 per row), so the
   block must not add a second copy - otherwise the hairline between two rows gets
   32px of air on one side and 16px on the other. */
.dim-panel .dim-modelSetting { display: block; padding: 0; }
/* A caption that heads a sub-block inside the card. It used to be the same class name as
   the header above, scoped by an ancestor: one name carrying two levels, which is why the
   two kept being compared as though they were one role. */
.dim-panel .dim-blockTitle { padding: 0 0 8px; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); font-weight: var(--dim-weight-500); }
/* Native "Setting-Cell" cell: 14/22 label on the left, control hard right. */
/* A row is a container, so it does not claim to be clickable: the hand belongs to
   the control on the right, which is the only hit target (model-setting.js:108-110).
   The host does the same - .rowCard and .rowName declare no cursor, only buttons do. */
.dim-modelRow { display: flex; align-items: center; gap: var(--dim-gap-8); width: 100%; min-height: 36px; padding: 16px 0; border: 0; background: transparent; color: var(--dsw-alias-label-primary, #0f1115); font: inherit; font-size: var(--dim-font-14); line-height: var(--dim-line-14); text-align: left; }
/* The row's text side is native's .rowText: a column of title + description with a
   4px gap, so a row carrying a description grows instead of pushing a separate
   paragraph below the block. Measured on 3080: the host's oY77xG_rowText is
   gap 4px with a 14/22 title over a 12/18 tertiary description. */
/* ---- The one row anatomy. Everything settings-like in this sheet is this: a left
   text slot (title over description, 4px apart), a right control that sizes to its
   own content, and a 0.5px border-l2 hairline between rows. Measured on 3080 at the
   host's own rows: title 14/22/400 primary, description 12/18/400 tertiary, row
   padding 16px 0, control 36px auto. Nothing else may declare these. ---- */
/* A row's left slot is text, so it reads as text: the I-beam cursor and a selectable
   run. The host's own rows are plain text (.rowName, .fieldLabel declare no cursor and
   nothing sets user-select), and nothing on the left is a hit target - the control on
   the right is - so the hand never belonged there. One declaration covers every row,
   because a control that wants the hand sets its own cursor (see .dim-rowControl). */
.dim-rowText { flex: 1 1 auto; min-width: 0; display: grid; gap: var(--dim-gap-4); justify-items: start; text-align: left; -webkit-user-select: text; user-select: text; }
/* The I-beam belongs to the text runs, not to the slot that holds them: on the block it
   also changed over the gap between the label and the control. The slot is a grid with
   justify-items: start, so its children are exactly as wide as the text they hold. */
.dim-rowText > * { cursor: text; }
.dim-modelRow { -webkit-user-select: text; user-select: text; }
/* The hairline rides on every row but the first, as native does - not on a
   separator element of its own. */
.dim-rowDivider { border-top: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); }
/* A control in the right slot sizes to its content and never goes full width. The
   native select stays a native select; only its slot changes. */
/* Scoped to .dim-panel so a channel sheet cannot outrank it at equal specificity.
   At (0,1,0) it would lose and the select would silently stay full-width; at (0,2,0)
   it ties and wins on sheet order, because this block comes later. */
/* The row's control looks the same whatever element provides it. Model and Reasoning
   effort use a button pill; Agent Preset uses a native select. Same slot, same skin -
   36px, pill radius, module fill, no border - so the three rows read as one control
   rather than two designs. The element is still a native select. */
/* Every control in a row wears this, so a select cannot half-adopt the skin and
   fall back to the UA font (13.33px) and the system dropdown arrow. */
/* The skin is element-agnostic so a button and a select in the same slot cannot
   drift apart; :not() counts its argument, so the states below are (0,3,0). */
/* The host's own selector pill is display:flex, gap 12px, padding 0 14px, height 36px with a
   chevron svg inside (measured on the General page's four selectors). Its inner layout lives
   here so every row control gets it, not only the one whose class happened to carry it. */
.dim-panel .dim-rowControl { display: inline-flex; align-items: center; gap: var(--dim-gap-12); flex: none; width: auto; min-width: 0; max-width: 60%; height: 36px; padding: 0 14px; border: 0; border-radius: var(--dim-radius-18); appearance: none; color: var(--dsw-alias-label-primary, #0f1115); background-color: var(--dim-module-fill); font: inherit; font-size: var(--dim-font-14); line-height: var(--dim-line-14); cursor: pointer; }
.dim-panel .dim-rowControl:hover:not(:disabled) { background-color: var(--dim-hover); }
.dim-panel .dim-rowControl:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); }
/* The host keeps a disabled selector's surface and dims what it says rather than
   fading the whole row. */
.dim-panel .dim-rowControl:disabled { cursor: default; color: var(--dsw-alias-label-tertiary, #81858c); }
/* A select has no chevron element, so it reserves room for the background one. */
.dim-panel select.dim-rowControl { padding-right: 32px; background-image: var(--dim-chevron); background-repeat: no-repeat; background-position: right 12px center; background-size: 12px 12px; }
.dim-modelRowLabel { min-width: 0; }
.dim-rowDesc { color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); font-weight: var(--dim-weight-400); }
/* Native selector pill (LanguageRow .selector): h36 r18, module fill, gap 12. */
.dim-modelValue { min-width: 0; overflow: hidden; color: var(--dsw-alias-label-primary, #0f1115); text-overflow: ellipsis; white-space: nowrap; }
.dim-modelChevron { flex: none; color: var(--dsw-alias-label-tertiary, #81858c); }
/* Hover and focus belong to the control, not the row: the row is not the hit target. */
.dim-modelSelector:hover:not(:disabled), .dim-modelOption:hover:not(:disabled) { background: var(--dim-hover); }
.dim-modelSelector:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-border-l3, rgb(0 0 0 / 12%)); }
.dim-modelOption:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #0f1115); outline-offset: -2px; }
/* Native keeps a disabled selector's surface and dims what it says, rather
   than fading the whole row (PermissionRow.module.css:54-56 keeps the pill's
   contrast; FontSizeRow.module.css:110-113 dims the glyph). */
.dim-modelSelector:disabled { cursor: default; }
.dim-modelSelector:disabled .dim-modelValue { color: var(--dsw-alias-label-tertiary, #81858c); }
.dim-modelOption:disabled { opacity: 0.4; cursor: default; }
/* Native's own list is a portal at fixed position, which is how it escapes the
   collapsed card and the settings scroll container. In flow it dropped below the
   sibling row instead of below its own trigger. */
/* The menu material is a PAIR. --dsw-specific-menu became translucent in DSH
   0.1.7 (rgba(248,249,250,.58) light / rgba(48,49,54,.5) dark) and the blur that
   completes it lives in a second token, so a fill without
   backdrop-filter: var(--dsw-menu-backdrop-filter) is simply see-through. The
   host states the rule in docs/web-styling.md:25 and pairs them in
   ui-primitives/src/Menu.module.css:17-18. The pair can sit on this container
   because nothing inside the list is fixed-positioned: the blur would otherwise
   become their containing block and move them off the viewport. */
.dim-modelMenu { position: fixed; z-index: var(--dim-z-menu); max-height: calc(100vh - 24px); overflow-y: auto; margin: 0; padding: 4px; border: 0; border-radius: var(--dim-radius-20); background: var(--dsw-specific-menu, #fff); backdrop-filter: var(--dsw-menu-backdrop-filter); --dsw-elevation-stroke-color: var(--dsw-alias-border-l1, rgb(0 0 0 / 4%)); box-shadow: var(--dsw-elevation-prominent, 0 0 0 .5px rgb(0 0 0 / 16%), 0 3px 8px rgb(0 0 0 / 4%), 0 0 20px rgb(0 0 0 / 5%)); color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-14); line-height: var(--dim-line-14); scrollbar-width: thin; }
.dim-modelGroupTitle { padding: 8px 10px; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); font-weight: var(--dim-weight-500); }
.dim-modelOption { display: flex; align-items: center; gap: var(--dim-gap-8); width: 100%; min-height: 40px; padding: 8px 10px; border: none; border-radius: var(--dim-radius-10); background: transparent; color: inherit; text-align: left; font: inherit; font-size: var(--dim-font-14); line-height: var(--dim-line-14); cursor: pointer; }
.dim-modelOptionCopy { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: var(--dim-gap-2); }
.dim-modelOptionName { font-size: var(--dim-font-14); line-height: var(--dim-line-14); font-weight: var(--dim-weight-500); overflow-wrap: anywhere; }
.dim-modelDescription { color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); overflow-wrap: anywhere; }
.dim-modelCheck { flex: 0 0 18px; text-align: center; }
/* Not help: this one appears only while the allowlist is empty, and it describes a state
   rather than a label. It was sharing .dim-helpHint with five pieces of real help, which is
   exactly the "one name, two roles" split this round is undoing. */
.dim-accessEmptyWarning { margin: 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-panel .dim-presetError { margin: 6px 0 0; color: var(--dim-danger); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-contextEntry { width: 100%; min-height: 40px; display: grid; grid-template-columns: 16px minmax(0, 1fr) max-content max-content; align-items: center; gap: var(--dim-gap-6); margin: 0; padding: 14px 0; border: 0; border-radius: 0; color: var(--dsw-alias-label-primary, #0f1115); background: none; font: inherit; font-size: var(--dim-font-14); line-height: var(--dim-line-14); text-align: left; cursor: pointer; }
.dim-contextEntry:hover:not(:disabled) { background: none; color: var(--dim-blue); }
.dim-contextEntry > svg { color: var(--dsw-alias-label-secondary, #646a73); }
.dim-contextLabel { min-width: 0; overflow-wrap: anywhere; }
.dim-contextStatus { height: 24px; display: inline-flex; align-items: center; padding: 0 8px; border-radius: var(--dim-radius-12); color: var(--dsw-alias-label-secondary, #646a73); background: var(--dim-module-fill); font-size: var(--dim-font-12); line-height: var(--dim-line-12); font-weight: var(--dim-weight-400); white-space: nowrap; }
.dim-contextStatus[data-active="true"] { color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-alias-button-ghost-active-fill, #ebeeF2); box-shadow: inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border, #979da6); }
.dim-contextPanel, .dim-contextPanel *, .dim-contextPanel *::before, .dim-contextPanel *::after { box-sizing: border-box; }
/* Three rows: a fixed header, a scrolling body, a fixed footer. The card used to be
   the only scroll region, so in a short viewport the tab strip that names the scope
   and the primary action both scrolled off the bottom edge. The plugin's own
   directory picker already uses this shape. */
/* Inline, not a dialog: it expands where the trigger sits and the page keeps
   scrolling behind it. Native does the same in ModelListEditor.tsx:407 - a plain
   sibling region, no portal, no backdrop, no elevation. The hairline above is the
   host separator between a trigger and what it discloses. */
/* The expansion is separated by spacing and by the tab strip's own underline, not by a
   rule of its own: two hairlines 30px apart, one under the entry and one under the tabs,
   read as clutter rather than as structure. */
.dim-contextPanel { display: grid; grid-template-rows: auto auto; width: 100%; min-width: 0; margin-top: 12px; padding: 0; background: transparent; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-14); line-height: var(--dim-line-14); text-align: left; }
.dim-contextPanel:focus { outline: none; }
.dim-contextEditorHeader { position: relative; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--dim-gap-8); }
/* The trigger already names the section, so the opened region carries no second
   title and no close button: it is an inline editor, not a dialog. */
/* Host tablist, adopted verbatim (settings-plugins bundle:377 .tabs/.tab). One strip
   anatomy now serves both of the plugin's tab strips, so a change here moves Context
   enhancement and the General page together. The host's inactive tab is
   label-tertiary at the inherited weight, its bar exists only while active, and it
   declares no min-height. */
/* The strip and the panel's help button share a row (context-enhancement.js). Only the
   strip inside that row flexes; the other two strips keep the shared sizing. The button
   deliberately does NOT go inside the tablist, whose only permitted children are tabs. */
.dim-contextTabsRow { min-width: 0; display: flex; align-items: center; gap: var(--dim-gap-6); }
.dim-contextTabsRow > .dim-contextTabs { flex: 1 1 auto; }
.dim-contextTabs, .dim-generalSettingsTabs, .dim-botSettingsTabs { min-width: 0; display: flex; align-items: flex-end; gap: var(--dim-gap-22); margin-top: 2px; border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); }
.dim-contextTab, .dim-generalSettingsTab, .dim-botSettingsTab { position: relative; min-width: 0; flex: none; display: inline-flex; align-items: center; justify-content: center; padding: 7px 1px 9px; border: 0; border-radius: 0; color: var(--dsw-alias-label-tertiary, #81858c); background: none; font: inherit; font-size: var(--dim-font-13); line-height: var(--dim-line-13); white-space: nowrap; cursor: pointer; }
.dim-contextTab:hover:not(:disabled):not([aria-selected="true"]), .dim-generalSettingsTab:hover:not([aria-selected="true"]), .dim-botSettingsTab:hover:not([aria-selected="true"]) { color: var(--dsw-alias-label-primary, #0f1115); }
.dim-contextTab[aria-selected="true"], .dim-generalSettingsTab[aria-selected="true"], .dim-botSettingsTab[aria-selected="true"] { color: var(--dsw-alias-label-primary, #0f1115); }
/* border-radius 2px 2px 0 0 is the host's own tab bar (settings-plugins bundle:377). */
.dim-contextTab::after, .dim-generalSettingsTab::after, .dim-botSettingsTab::after { content: ''; position: absolute; right: 0; bottom: -1px; left: 0; height: 2px; border-radius: 2px 2px 0 0; background: transparent; }
.dim-contextTab[aria-selected="true"]::after, .dim-generalSettingsTab[aria-selected="true"]::after, .dim-botSettingsTab[aria-selected="true"]::after { background: var(--dsw-alias-label-primary, #0f1115); }
.dim-contextTab:focus-visible, .dim-generalSettingsTab:focus-visible, .dim-botSettingsTab:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, var(--dim-blue)); outline-offset: 2px; border-radius: 2px; color: var(--dsw-alias-label-primary, #0f1115); }
/* Inline now: no height cap and no chrome of its own, so the page is the only scroll
   region. The old negative margin existed to let a scrollbar sit on the dialog's edge;
   a dialog edge no longer exists, so it is gone too. */
.dim-contextBody { min-height: 0; scrollbar-width: thin; }
.dim-contextTabPanel[hidden] { display: none; }
.dim-contextSection { min-width: 0; margin: 0; padding: 0; border: 0; }
/* Flat. It used to be a filled, rounded slab inside the expansion - a card within a
   card, on top of the two rules above it. The tab strip already says which scope is
   open, so the fill was repeating it in a heavier voice. */
.dim-contextScope { margin-top: 12px; padding: 0; border: 0; background: none; }
.dim-contextScopeBlock { margin-top: 12px; }
/* Same section role as the guidance title below it, so the same weight. Two 14px
   titles at 400 and 500 inside one panel is what made it read as two systems. */
.dim-contextLegend { position: relative; display: grid; justify-items: start; gap: var(--dim-gap-3); }
.dim-contextLegend > span:first-child { font-weight: var(--dim-weight-500); }
.dim-contextSwitchRow { display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-8); min-height: 34px; cursor: pointer; }
.dim-contextSwitchLabel { min-width: 0; display: inline-flex; align-items: baseline; gap: var(--dim-gap-5); flex-wrap: wrap; }
.dim-contextUnavailable { color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); font-weight: var(--dim-weight-400); }
/* The scope tag on the enable switch. Same secondary treatment as the unavailable note beside
   it, so the two annotations on that row read as one tier. */
.dim-contextSwitchScope { flex: none; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-11); line-height: var(--dim-line-11); font-weight: var(--dim-weight-400); }
.dim-contextSwitch { appearance: none; flex: none; width: 36px; height: 20px; margin: 0; padding: 0; border: none; border-radius: var(--dim-radius-10); corner-shape: round; background: var(--dsw-alias-border-l3, rgb(0 0 0 / 12%)); cursor: pointer; transition: background .12s ease; }
.dim-contextSwitch::before { content: ""; display: block; width: 16px; height: 16px; margin: 2px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-label-primary-foreground, #fff); transition: transform .12s ease; }
.dim-contextSwitch:checked { background: var(--dsw-alias-brand-primary, #0f1115); }
.dim-contextSwitch:checked::before { transform: translateX(16px); }
/* Official modelAdvanced: auto-fit tracks so the columns stay equal instead of
   being sized by whichever caveat happens to be longest. */
.dim-contextFields { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--dim-gap-8); padding: 8px 4px 2px; }
/* align-items: center centred the checkbox against the whole hint block, so a
   long hint pushed the control 57-81px below the label it belongs to. */
.dim-contextField { position: relative; min-width: 0; min-height: 30px; display: flex; align-items: flex-start; gap: var(--dim-gap-6); }
.dim-contextField input { flex: none; width: 14px; height: 14px; margin: 2px 0 0; accent-color: var(--dim-blue); }
/* One track: the name took the first, and the hint and the key both span 1 / -1, so the
   second track never held anything. */
.dim-contextFieldText { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); align-items: center; overflow-wrap: anywhere; }
.dim-contextFieldName { min-width: 0; line-height: var(--dim-line-14); }
.dim-contextFieldKey { min-width: 0; grid-column: 1 / -1; color: var(--dsw-alias-label-tertiary, #81858c); font: 11px/16px var(--dim-font-mono); overflow-wrap: anywhere; }
.dim-contextEditorTitle { min-width: 0; display: inline-flex; align-items: center; gap: var(--dim-gap-6); }
.dim-contextEditorTitle > label { font-weight: var(--dim-weight-500); }
/* The one help "?" and the panel it opens. This role had two class-name sets
   (dim-contextHelp* and dim-presetHelp*) and they had already drifted: 320px vs 330px
   panel, a grid gap on one and not the other, :hover vs :hover:not(:disabled). One name
   now, declared once, so a fourth variant cannot appear.
   Deliberately NOT scoped to .dim-panel: this role is used both inside the settings
   panel and inside dialogs that portal to document.body (the alias dialog, the update
   dialog), where a panel-scoped rule would not match at all and the button would render
   unstyled. No channel sheet declares these names, so there is no equal-specificity
   author left to lose to - which is the only reason the other shared roles are scoped.
   The panel is portaled to document.body and positioned in viewport coordinates
   against its own button, so it is never clipped by the card it was rendered in and no
   caller has to supply a positioned ancestor. */
.dim-help { display: inline-flex; align-items: center; flex: none; }
.dim-helpButton { width: 16px; height: 16px; display: grid; place-items: center; padding: 0; border: none; border-radius: 50%; corner-shape: round; color: var(--dsw-alias-label-tertiary, #81858c); background: transparent; font: inherit; font-size: var(--dim-font-11); line-height: 1; font-weight: var(--dim-weight-500); cursor: help; transition: color .15s ease, background .15s ease; }
.dim-helpButton:hover:not(:disabled) { color: var(--dsw-alias-label-primary, #0f1115); background: var(--dim-hover); }
.dim-helpButton:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); }
.dim-helpPanel { position: fixed; z-index: var(--dim-z-menu); width: min(330px, calc(100vw - 72px)); display: grid; gap: var(--dim-gap-5); overflow-wrap: anywhere; white-space: normal; opacity: 0; visibility: hidden; transform: translateY(-3px); pointer-events: none; transition: opacity .15s ease, transform .15s ease, visibility .15s ease; }
.dim-helpPanel strong { font-weight: var(--dim-weight-600); }
.dim-helpExample { padding: 7px 8px; border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-primary, #0f1115); background: var(--dim-module-fill); font-family: var(--dim-font-mono); white-space: pre-wrap; }
.dim-helpPanelTop { width: min(380px, calc(100vw - 72px)); max-height: calc(100dvh - 48px); overflow-y: auto; }
/* Portaled out of the card, so no hover rule can reach it any more: the component owns
   the open state and says so here. */
.dim-helpPanel[data-open="true"] { opacity: 1; visibility: visible; transform: translateY(0); pointer-events: auto; }
/* A value legend that moved into a panel. It must obey the pairing invariant the panel
   itself obeys - the base is always the dark tooltip base, so nothing inside may take a
   foreground or a fill that flips with the theme. That is why the code chip lost its
   module-fill background: a light fill on a permanently dark base is the same mistake
   the invariant exists to prevent, one level down. */
/* A row that puts a block title or a field label and its help button on one line. It needs
   no positioning of its own: the panel is fixed and measured against the button. */
.dim-helpRow { min-width: 0; display: inline-flex; align-items: center; gap: var(--dim-gap-6); }
.dim-helpList { display: grid; gap: var(--dim-gap-4); margin: 0; padding: 0; list-style: none; }
.dim-helpList li { min-width: 0; display: flex; align-items: baseline; gap: var(--dim-gap-8); }
.dim-helpList code { flex: none; min-width: 44px; color: var(--dsw-static-neutral-bluish-00, #f9fafb); font: 11px/16px var(--dim-font-mono); text-align: center; }
.dim-helpList span { min-width: 0; }
.dim-contextTextActions { display: flex; gap: var(--dim-gap-10); margin-left: auto; }
.dim-contextTextActions button { min-height: 30px; padding: 4px 0; border: 0; border-radius: var(--dim-radius-8); color: var(--dim-blue); background: transparent; font: inherit; font-size: var(--dim-font-12); cursor: pointer; }
.dim-contextTextActions button:hover:not(:disabled) { text-decoration: underline; }
/* Same chrome as the diagnostic's textarea - the host's .input padding of 10px on the
   horizontal. The font differs on purpose: this one holds prose the user writes, that
   one holds a machine-formatted diagnostic block, so it stays monospaced. */
.dim-contextGuidance textarea { display: block; width: 100%; min-height: 88px; margin-top: 6px; padding: 8px 10px; resize: vertical; border: var(--dim-field-border); border-radius: var(--dim-field-radius); color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; font-size: var(--dim-font-14); line-height: var(--dim-line-14); }
.dim-contextGuidance textarea::placeholder { color: var(--dsw-alias-label-caption, #adb2b8); opacity: 1; }
/* The host's hint/description role is label-tertiary, not secondary: ui-settings-plugins
   fields.module.css:88-92 (.hint) and every settings-row .desc - TranscriptViewRow.module.css:27,
   EnterBehaviorRow.module.css:27, PermissionRow.module.css:27, FontSizeRow.module.css:29,
   AgentPresetSection.module.css:51, ChatView.module.css:139, PluginInventorySettingsTab.module.css:328.
   Fifteen of the host's twenty hint/description rules are tertiary; these four were the plugin's
   only hint-named rules still on secondary, and its own .dim-helpHint/.dim-modelDescription
   were already tertiary. */
.dim-contextError { margin: 12px 0 0; color: var(--dim-danger); font-size: var(--dim-font-12); line-height: var(--dim-line-12); overflow-wrap: anywhere; }
/* No buttons and no rule above them: the region saves itself, so what is left is a
   status line on the left, where a form that has no Save button says that it saved. */
.dim-contextFooter { min-height: 18px; margin-top: 12px; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-contextEntry:focus-visible, .dim-contextPanel button:focus-visible, .dim-contextPanel input:focus-visible, .dim-contextPanel textarea:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); outline-offset: 2px; }
.dim-contextEntry:disabled, .dim-contextPanel button:disabled, .dim-contextPanel input:disabled, .dim-contextPanel textarea:disabled { opacity: 0.4; cursor: not-allowed; }
@media (pointer: coarse) {
  .dim-contextEntry, .dim-contextTab, .dim-contextTextActions button, .dim-contextField, .dim-contextSwitchRow { min-height: 44px; }
  .dim-contextTextActions button { min-width: 44px; }
  .dim-contextGuidance textarea { font-size: var(--dim-font-16); }
}
/* No local token rebinds: the picker is portalled, but the token layer lives on
   :root now, so it inherits them like any other surface. */
.dim-directoryPickerBackdrop { position: fixed; inset: 0; z-index: var(--dim-z-portal); display: grid; place-items: center; padding: 24px; background: var(--dsw-alias-bg-mask-1, rgb(0 0 0 / 24%)); backdrop-filter: var(--dsw-mask-blur, blur(2px)); }
.dim-directoryPickerBackdrop, .dim-directoryPickerBackdrop *, .dim-directoryPickerBackdrop *::before, .dim-directoryPickerBackdrop *::after { box-sizing: border-box; }
.dim-directoryPicker { width: min(720px, 100%); height: min(620px, calc(100vh - 48px)); min-height: 420px; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; overflow: hidden; border: 0; border-radius: var(--dim-radius-24); background: var(--dsw-alias-bg-layer-2, #fff); box-shadow: var(--dsw-elevation-prominent, 0 0 0 .5px rgb(0 0 0 / 16%), 0 3px 8px rgb(0 0 0 / 4%), 0 0 20px rgb(0 0 0 / 5%)); outline: none; color: var(--dsw-alias-label-primary, #0f1115); }
.dim-directoryPickerHeader { min-width: 0; padding: 22px 24px 17px; border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); }
/* One modal-title role. The host's own modal title is ui-primitives Modal.module.css:55-57 at
   16 / 500 / 24, which is exactly the 16px rung's pairing, so all four modal titles read that
   rung and one change to it reaches every dialog. They used to carry four different specs -
   18/25/600 (update), 20/28/600 (directory picker, shrunk to 18 in the narrow container),
   15/22/500 (context) and a bare 16 with no leading or weight (alias). */
.dim-directoryPickerHeader h3 { margin: 0 0 14px; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-16); line-height: var(--dim-line-16); font-weight: var(--dim-weight-500); }
.dim-directoryPickerHeader > p { margin: 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-13); }
.dim-directoryCrumbs { min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: var(--dim-gap-4); color: var(--dsw-alias-label-tertiary, #81858c); }
.dim-directoryCrumbs button { max-width: 210px; overflow: hidden; padding: 3px 5px; border: 0; border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-secondary, #646a73); background: transparent; font: inherit; font-size: var(--dim-font-12); line-height: var(--dim-line-12); text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.dim-directoryCrumbs button:hover:not(:disabled) { color: var(--dim-blue); background: var(--dim-blue-soft); }
/* Two different host answers, so two different values. A Button in the host declares no
   font-weight at all (ui-primitives Button.module.css:12 and :32 set only font-size), so button
   labels inherit 400 - the path "go" button and the picker's retry button were at 600. The current
   breadcrumb is a selected nav item, and the host's active nav is 500
   (ui-sidebar SidebarRoot.module.css:330 .panelRow.panelActive). */
.dim-directoryCrumbs button[aria-current="page"] { color: var(--dsw-alias-label-primary, #0f1115); font-weight: var(--dim-weight-500); }
.dim-directoryCrumbs button:focus-visible, .dim-directoryPathInput:focus-visible, .dim-directoryPathControl button:focus-visible, .dim-directoryList button:focus-visible, .dim-directoryPickerActions button:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); outline-offset: 1px; }
.dim-directoryCrumbSeparator { flex: none; font-size: var(--dim-font-12); }
.dim-directoryPathForm { display: grid; gap: var(--dim-gap-7); margin-top: 14px; }
.dim-directoryPathMeta { min-width: 0; display: flex; align-items: baseline; justify-content: space-between; gap: var(--dim-gap-12); }
.dim-directoryPathMeta label { flex: none; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); font-weight: var(--dim-weight-500); }
.dim-directoryPathMeta span { min-width: 0; overflow: hidden; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); text-overflow: ellipsis; white-space: nowrap; }
.dim-directoryPathControl { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) max-content; gap: var(--dim-gap-8); }
.dim-directoryPathInput { min-width: 0; height: 32px; padding: 0 10px; border: var(--dim-field-border); border-radius: var(--dim-field-radius); color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-alias-bg-layer-1, #fff); font: 12px/1.5 var(--dim-font-mono); }
.dim-directoryPathInput::placeholder { color: var(--dsw-alias-label-caption, #adb2b8); }

.dim-directoryPathInput:focus { outline: none; border-color: var(--dim-focus); }
.dim-directoryPathInput[aria-invalid="true"] { border-color: color-mix(in srgb, var(--dim-danger) 62%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); }
.dim-directoryPathControl button { min-height: 38px; padding: 0 14px; border: 0.5px solid color-mix(in srgb, var(--dim-blue) 30%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); border-radius: var(--dim-radius-8); color: var(--dim-blue); background: var(--dim-blue-soft); font: inherit; font-size: var(--dim-font-13); font-weight: var(--dim-weight-400); cursor: pointer; }
.dim-directoryPathControl button:hover:not(:disabled) { border-color: color-mix(in srgb, var(--dim-blue) 48%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); background: color-mix(in srgb, var(--dim-blue) 13%, transparent); }
.dim-directoryPathInput:disabled, .dim-directoryPathControl button:disabled { cursor: not-allowed; opacity: 0.4; }
.dim-directoryPickerBody { min-height: 0; overflow-y: auto; padding: 14px 16px; scrollbar-width: thin; scrollbar-color: var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)) transparent; }
.dim-directoryList { display: grid; gap: var(--dim-gap-3); margin: 0; padding: 0; list-style: none; }
.dim-directoryList button { width: 100%; min-height: 46px; display: grid; grid-template-columns: 24px minmax(0, 1fr) 18px; align-items: center; gap: var(--dim-gap-10); padding: 7px 11px; border: 0; border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-primary, #0f1115); background: transparent; font: inherit; text-align: left; cursor: pointer; }
.dim-directoryList button:hover:not(:disabled) { background: var(--dim-hover); }
.dim-directoryList button:disabled, .dim-directoryCrumbs button:disabled { cursor: wait; opacity: 0.4; }
.dim-directoryFolder { width: 24px; height: 24px; display: grid; place-items: center; color: var(--dsw-alias-label-secondary, #646a73); }
.dim-directoryFolder svg { width: 22px; height: 22px; }
.dim-directoryName { min-width: 0; overflow: hidden; font-size: var(--dim-font-14); line-height: var(--dim-line-14); text-overflow: ellipsis; white-space: nowrap; }
.dim-directoryChevron { width: 18px; height: 18px; display: grid; place-items: center; color: var(--dsw-alias-label-tertiary, #81858c); }
.dim-directoryChevron svg { width: 17px; height: 17px; }
.dim-directoryPickerState { min-height: 210px; display: grid; place-content: center; justify-items: center; gap: var(--dim-gap-10); color: var(--dsw-alias-label-secondary, #646a73); text-align: center; }
.dim-directoryPickerState p { margin: 0; font-size: var(--dim-font-13); line-height: var(--dim-line-13); }
.dim-directoryPickerSpinner { width: 24px; height: 24px; border: 3px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); border-top-color: var(--dim-blue); border-radius: 50%; animation: dim-spin .8s linear infinite; }
.dim-directoryPickerError { display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-12); margin: 8px 0 0; padding: 10px 12px; border: 0.5px solid color-mix(in srgb, var(--dim-danger) 22%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); border-radius: var(--dim-radius-8); color: var(--dim-danger); background: color-mix(in srgb, var(--dim-danger) 7%, var(--dsw-alias-bg-layer-1, #fff)); font-size: var(--dim-font-12); line-height: var(--dim-line-12); overflow-wrap: anywhere; }
.dim-directoryPickerError button { flex: none; padding: 4px 8px; border: 0; border-radius: var(--dim-radius-8); color: inherit; background: transparent; font: inherit; font-weight: var(--dim-weight-400); cursor: pointer; }
.dim-directoryPickerTruncated { margin: 10px 4px 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-directoryPickerFooter { display: grid; grid-template-columns: max-content minmax(0, 1fr) max-content; align-items: center; gap: var(--dim-gap-14); padding: 16px 20px; border-top: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); background: var(--dsw-alias-bg-layer-1, #fff); }
.dim-directoryHidden { display: inline-flex; align-items: center; gap: var(--dim-gap-7); padding: 2px 0; border: 0; color: var(--dsw-alias-label-secondary, #646a73); background: transparent; font: inherit; font-size: var(--dim-font-12); white-space: nowrap; cursor: pointer; }
.dim-directoryHidden:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); outline-offset: 2px; }
.dim-directoryHidden:disabled { cursor: not-allowed; opacity: 0.4; }
.dim-directoryHiddenBox { position: relative; width: 15px; height: 15px; flex: 0 0 15px; border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); border-radius: var(--dim-radius-3); background: var(--dsw-alias-bg-layer-1, #fff); }
.dim-directoryHidden[aria-pressed="true"] .dim-directoryHiddenBox { border-color: var(--dim-blue); background: var(--dim-blue); }
.dim-directoryHidden[aria-pressed="true"] .dim-directoryHiddenBox::after { content: ""; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px; border: solid white; border-width: 0 2px 2px 0; transform: rotate(45deg); }
.dim-directoryPickerNotice { min-width: 0; margin: 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: 1.45; text-align: right; }
.dim-directoryPickerActions { display: flex; gap: var(--dim-gap-8); }
.dim-directoryPickerActions button { height: 28px; display: inline-flex; align-items: center; justify-content: center; padding: 0 10px; border: var(--dim-control-border); border-radius: var(--dim-radius-14); color: var(--dsw-alias-label-primary, #0f1115); background: transparent; font: inherit; font-size: var(--dim-font-12); line-height: var(--dim-line-12); white-space: nowrap; cursor: pointer; }
.dim-directoryPickerActions .dim-directoryPickerPrimary { border-color: var(--dsw-alias-border-l3, rgb(0 0 0 / 12%)); color: var(--dsw-alias-label-primary, #0f1115); background: transparent; }
.dim-directoryPickerActions button:hover:not(:disabled) { filter: brightness(.97); }
.dim-directoryPickerActions button:disabled { cursor: not-allowed; opacity: 0.4; }
.dim-panel .dim-cardSummary { min-width: 0; color: var(--dsw-alias-label-secondary, #646a73); font: inherit; font-size: var(--dim-font-12); font-weight: var(--dim-weight-400); line-height: var(--dim-line-12); overflow-wrap: anywhere; white-space: normal; }
.dim-panel .dim-cardFooterLayout { min-width: 0; width: 100%; display: flex; flex-direction: column; align-items: stretch; gap: var(--dim-gap-8); }
.dim-panel .dim-cardFooterLayout > .dim-cardActions { align-self: stretch; }
.dim-panel .dim-cardFeedback { width: 100%; padding: 8px 10px; border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-secondary, #646a73); background: var(--dim-module-fill); font: inherit; font-size: var(--dim-font-12); font-weight: var(--dim-weight-400); line-height: var(--dim-line-12); overflow-wrap: anywhere; white-space: normal; }
.dim-panel .dim-cardActions { flex: none; width: 100%; display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: var(--dim-gap-8); margin: 0; }
.dim-panel .dim-cardActions .dim-cardAction { flex: none; height: 28px; display: inline-flex; align-items: center; justify-content: center; padding: 0 10px; border: var(--dim-control-border); border-radius: var(--dim-radius-14); color: var(--dsw-alias-label-primary, #0f1115); background: transparent; font: inherit; font-size: var(--dim-font-12); line-height: var(--dim-line-12); white-space: nowrap; cursor: pointer; }
.dim-panel .dim-cardActions .dim-cardAction:hover:not(:disabled) { background: var(--dim-hover-solid); }
.dim-panel .dim-cardActions .dim-cardAction[data-kind="danger"] { border-color: transparent; color: var(--dim-danger); }
.dim-panel .dim-cardActions .dim-cardAction[data-kind="danger"]:hover:not(:disabled) { background: var(--dim-danger-hover); }
/* Header tooltips may extend beyond the card; the collapsible body clips its own content. */
.dim-panel .dim-botCard { position: relative; min-width: 0; width: 100%; max-width: 100%; overflow: visible; border: 0.5px solid var(--dsw-alias-border-l4, rgb(0 0 0 / 16%)); border-radius: var(--dim-radius-16); background: none; transition: border-color .16s ease; }
.dim-panel .dim-botCard:hover { border-color: var(--dsw-alias-label-dimmed, #e1e5ee); }
.dim-panel .dim-botCard::before { display: none; }
/* 24px, not 16px: SettingsRoot.module.css:224 gives the host's settings content a
   24px side inset, and matching it is the difference between a row that breathes and
   one that reads cramped. (No backticks in here - this sheet is a template literal.) */
.dim-panel .dim-botCardBody { position: relative; min-width: 0; width: 100%; max-width: 100%; padding: 0 24px; }
/* Hierarchy alternates instead of stacking: the card carries the only outline, and
   every group inside it is a bare row separated by a 0.5px hairline. Nesting a
   second border and fill inside the card is what made one expanded account show
   seven competing boxes. */
.dim-collapsibleHead { padding: 16px 0; }
.dim-collapsibleBodyInner > * + * { border-top: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); }
/* The diagnostic's label/value grid has no host counterpart, so it takes the two
   nearest official roles: the key reads as a field label, the value as the text of
   the field it labels. Its chrome used to be three inline styles. */
/* Official .customizedSummary supplies the text role for a plain disclosure
   trigger; the row-card headers keep their own richer typography. */
.dim-diagnosticSummary { font-weight: var(--dim-weight-500); }
.dim-diagnosticFields { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 12px; margin: 0; }
.dim-diagnosticFields dt { color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-diagnosticValue { margin: 0; color: var(--dsw-alias-label-primary, #0f1115); overflow-wrap: anywhere; }
.dim-diagnosticNotice { margin: 0; color: var(--dsw-alias-state-warn-label, #b45309); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-diagnosticHint { margin: 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-diagnosticTextarea { display: block; width: 100%; margin-top: 6px; padding: 8px 10px; border: var(--dim-field-border); border-radius: var(--dim-field-radius); color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-alias-bg-layer-1, #fff); font: var(--dim-font-12)/var(--dim-line-12) var(--dim-font-mono); resize: vertical; }
.dim-collapsibleBodyInner > .dim-cardFooter { border-top: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); }
/* One disclosure mechanism for the whole plugin: a root that carries is-open,
   a head that toggles, a chevron that rotates, and a body clipped while closed.
   The IM channel cards, the context-enhancement editor and the diagnostic
   details disclosure all render through these four classes, so the gesture is
   declared here once. */
.dim-collapsible { min-width: 0; display: flex; flex-direction: column; }
/* The head toggles, but its text stays text: the host's own disclosure summary sets
   no user-select, so a bot name here is selectable and copyable like any other run. */
.dim-collapsibleHead { min-width: 0; display: flex; align-items: center; gap: var(--dim-gap-6); cursor: pointer; -webkit-user-select: text; user-select: text; }
.dim-collapsibleHead:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); outline-offset: 2px; border-radius: var(--dim-radius-8); }
.dim-collapsibleHeaderContent { min-width: 0; flex: 1 1 auto; display: flex; align-items: center; }
.dim-collapsibleChevron { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; color: var(--dsw-alias-label-tertiary, #81858c); transition: transform var(--dim-disclosure-duration) var(--dim-disclosure-ease); transform-origin: 50% 50%; }
.dim-collapsibleChevron svg { display: block; }
.dim-collapsible.is-open .dim-collapsibleChevron { transform: rotate(90deg); }
/* The per-account settings button the host's own account card carries. Its chevron
   shares the section affordance's class name, so the rotation is scoped to the
   button's own state and this block sits after the section rule above. */
.dim-accountSettingsToggle { flex: none; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-tertiary, #81858c); background: transparent; cursor: pointer; transition: color .15s ease, background .15s ease; }
.dim-accountSettingsToggle > svg { flex: none; display: block; }
.dim-accountSettingsToggle:hover { color: var(--dsw-alias-label-primary, #0f1115); background: var(--dim-hover); }
.dim-accountSettingsToggle:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); }
.dim-accountSettingsToggle .dim-collapsibleChevron { width: 12px; height: 16px; }
.dim-accountSettingsToggle[aria-expanded="true"] .dim-collapsibleChevron { transform: rotate(180deg); }
.dim-accountSettingsHeader { display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-12); margin-top: 12px; padding-top: 8px; border-top: 0.5px solid var(--dsw-alias-border-l2, #e5e6eb); color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }/* Animate height without measuring content; hide collapsed controls from focus and accessibility. */
.dim-collapsibleBody { display: grid; grid-template-rows: 0fr; transition: grid-template-rows var(--dim-disclosure-duration) var(--dim-disclosure-ease); }
.dim-collapsible.is-open > .dim-collapsibleBody { grid-template-rows: 1fr; }
/* clip rather than hidden, plus a clip margin: the collapse animation still
   needs the box clipped, but hidden also swallowed the 2px focus ring of every
   control inside, leaving those rows with no visible focus at all. The margin
   lets the ring paint; browsers without overflow-clip-margin fall back to the
   old behaviour rather than to something worse. */
.dim-collapsibleBodyInner { min-height: 0; overflow: clip; overflow-clip-margin: 4px; }
.dim-collapsible:not(.is-open) .dim-collapsibleBodyInner { visibility: hidden; }
/* Reclaim horizontal spacing for names while keeping status on the same row,
   including when a channel's mobile stylesheet requests a column layout. */
.dim-panel .dim-botCardTop { min-width: 0; width: 100%; max-width: 100%; display: flex; flex-direction: row; flex-wrap: nowrap; align-items: center; justify-content: space-between; gap: var(--dim-gap-6); }
.dim-panel .dim-botIdentity { min-width: 0; flex: 1 1 0; display: flex; align-items: center; gap: var(--dim-gap-6); }
.dim-panel .dim-botAvatar { flex: none; width: 38px; height: 38px; display: grid; place-items: center; overflow: hidden; border-radius: var(--dim-radius-12); box-shadow: none; }
.dim-panel .dim-botAvatar svg { width: 27px; height: 27px; }
.dim-panel .dim-botName { min-width: 0; flex: 1; }
.dim-panel .dim-aliasName { gap: var(--dim-gap-2); }
.dim-panel .dim-botName h3 { overflow: hidden; margin: 0; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-15); font-weight: var(--dim-weight-600); line-height: var(--dim-line-15); text-overflow: ellipsis; white-space: nowrap; }
.dim-panel .dim-botName p { overflow: hidden; margin: 4px 0 0; color: var(--dsw-alias-label-tertiary, #81858c); font: 12px/18px var(--dim-font-mono); text-overflow: ellipsis; white-space: nowrap; }
.dim-panel .dim-botCardTools { flex: none; display: flex; align-items: center; gap: var(--dim-gap-4); }
.dim-panel .dim-botHealthGroup { min-width: 0; max-width: min(100%, 260px); flex: none; display: grid; justify-items: end; gap: var(--dim-gap-2); text-align: right; }
.dim-panel .dim-botCard .dim-botHealth { flex: none; min-height: 0; display: inline-flex; align-items: center; gap: var(--dim-gap-7); padding: 0; border: 0; border-radius: 0; color: var(--dsw-alias-label-secondary, #646a73); background: transparent; font: inherit; font-size: var(--dim-font-12); font-weight: var(--dim-weight-400); line-height: var(--dim-line-12); white-space: nowrap; }
.dim-panel .dim-lastChecked { max-width: 100%; overflow: hidden; text-overflow: ellipsis; display: inline-flex; align-items: baseline; gap: var(--dim-gap-4); color: var(--dsw-alias-label-tertiary, #81858c); font: inherit; font-size: var(--dim-font-12); font-weight: var(--dim-weight-400); line-height: var(--dim-line-12); white-space: nowrap; }
.dim-panel .dim-botCard .dim-healthDot { flex: none; width: 8px; height: 8px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-label-tertiary, #81858c); box-shadow: none; }
.dim-panel .dim-botCard .dim-healthDot[data-tone="success"] { background: var(--dsw-alias-state-success-primary, #22c55e); }
.dim-panel .dim-botCard .dim-healthDot[data-tone="warning"] { background: var(--dsw-alias-state-warn-primary, #f59e0b); }
.dim-panel .dim-botCard .dim-healthDot[data-tone="error"] { background: var(--dim-danger); }
.dim-botSettingsAction { position: relative; flex: none; display: inline-flex; }
.dim-botSettingsButton { min-height: 32px; display: inline-flex; align-items: center; gap: var(--dim-gap-6); padding: 0 6px; border: 0; border-radius: var(--dim-radius-8); color: var(--dim-blue); background: transparent; font: inherit; font-size: var(--dim-font-12); line-height: var(--dim-line-12); white-space: nowrap; cursor: pointer; transition: color .15s ease, background .15s ease; }
.dim-botSettingsButton:hover { color: var(--dsw-alias-label-primary, #0f1115); background: var(--dim-hover); }
.dim-botSettingsButton:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); outline-offset: 2px; }
/* Upstream replaced the hover tooltip with a visible label plus this caret, so the
.dim-deliveryPage { min-width: 0; display: grid; }
.dim-deliveryHeader { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-16); }
.dim-botSettingsTabs { overflow-x: auto; scrollbar-width: none; }
.dim-botSettingsTabs::-webkit-scrollbar { display: none; }
.dim-botSettingsTabsBar { min-width: 0; margin-top: 10px; }
.dim-botSettingsTabPanel { min-width: 0; display: grid; gap: var(--dim-gap-12); padding-top: 12px; }
.dim-feishuGroupSettings { min-width: 0; display: grid; gap: var(--dim-gap-12); }
.dim-feishuGroupControls { min-width: 0; display: grid; gap: var(--dim-gap-12); }
/* Row anatomy supplies the geometry; this class only names the block. */
.dim-feishuGroupControl { min-width: 0; }
.dim-feishuGroupControlHeader { position: relative; min-width: 0; display: flex; align-items: center; gap: var(--dim-gap-6); }
.dim-feishuGroupControlHeader h3 { min-width: 0; margin: 0; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-14); line-height: var(--dim-line-14); font-weight: var(--dim-weight-400); }
.dim-feishuGroupControlStatus { color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-feishuGroupHelp { margin: 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-feishuGroupPermissionAction { display: flex; justify-content: flex-start; }
.dim-feishuGroupPermissionAction .dim-deliveryButton { color: var(--dim-blue); border-color: color-mix(in srgb, var(--dim-blue) 30%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); }
.dim-feishuGroupError, .dim-feishuGroupRefreshError { margin: 0; padding: 9px 11px; border-radius: var(--dim-radius-8); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-feishuGroupError, .dim-feishuGroupRefreshError { color: var(--dim-danger); background: color-mix(in srgb, var(--dim-danger) 7%, var(--dsw-alias-bg-layer-1, #fff)); }
.dim-feishuGroupAuthorization { min-width: 0; display: grid; grid-template-columns: 184px minmax(0, 1fr); align-items: start; gap: var(--dim-gap-24); padding: 18px; border: 0.5px solid color-mix(in srgb, var(--dim-blue) 30%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); border-radius: var(--dim-radius-12); background: color-mix(in srgb, var(--dim-blue) 2.5%, var(--dsw-alias-bg-layer-3, #fff)); }
.dim-feishuGroupAuthorizationState { min-height: 126px; grid-template-columns: 32px minmax(0, 1fr); align-items: center; }
.dim-feishuGroupAuthorizationState h3, .dim-feishuGroupAuthorizationError h3, .dim-feishuGroupAuthorizationCopy h3 { margin: 0; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-16); line-height: var(--dim-line-16); font-weight: var(--dim-weight-600); overflow-wrap: anywhere; }
.dim-feishuGroupAuthorizationState p, .dim-feishuGroupAuthorizationError p, .dim-feishuGroupAuthorizationCopy > p { margin: 5px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); overflow-wrap: anywhere; }
.dim-feishuGroupSpinner { width: 24px; height: 24px; border: 3px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); border-top-color: var(--dim-blue); border-radius: 50%; animation: dim-spin .8s linear infinite; }
.dim-feishuGroupAuthorizationError { grid-template-columns: minmax(0, 1fr) max-content; align-items: center; border-color: color-mix(in srgb, var(--dim-danger) 28%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); background: color-mix(in srgb, var(--dim-danger) 4%, var(--dsw-alias-bg-layer-3, #fff)); }
.dim-feishuGroupAuthorizationError code { display: inline-block; margin-top: 6px; color: var(--dsw-alias-label-tertiary, #81858c); font: 11px/17px var(--dim-font-mono); overflow-wrap: anywhere; }
.dim-feishuGroupQrColumn { min-width: 0; }
.dim-feishuGroupQrFrame { position: relative; width: 176px; height: 176px; display: grid; place-items: center; padding: 10px; border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); border-radius: var(--dim-radius-12); background: #fff; box-shadow: 0 6px 18px rgb(31 35 41 / 7%); }
.dim-feishuGroupQrFrame img { width: 100%; height: 100%; display: block; object-fit: contain; }
.dim-feishuGroupQrFallback { width: 100%; height: 100%; display: grid; place-content: center; justify-items: center; gap: var(--dim-gap-7); border-radius: var(--dim-radius-8); color: var(--dim-on-qr-muted, #646a73); background: #f7f9ff; text-align: center; }
.dim-feishuGroupQrFallback span { color: var(--dim-on-qr-muted, #646a73); font-size: var(--dim-font-11); line-height: var(--dim-line-11); }
.dim-feishuGroupQrExpired { position: absolute; inset: 10px; display: grid; place-content: center; gap: var(--dim-gap-2); border-radius: var(--dim-radius-8); color: var(--dim-on-qr, #0f1115); background: rgb(255 255 255 / 94%); backdrop-filter: blur(3px); text-align: center; }
.dim-feishuGroupQrExpired span { font-size: var(--dim-font-13); line-height: var(--dim-line-13); font-weight: var(--dim-weight-500); }
.dim-feishuGroupQrExpired small { color: var(--dim-on-qr-muted, #646a73); font-size: var(--dim-font-11); line-height: var(--dim-line-11); }
.dim-feishuGroupCountdown { width: 176px; display: grid; grid-template-columns: minmax(0, 1fr) max-content; gap: var(--dim-gap-5) 10px; margin-top: 9px; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-11); line-height: var(--dim-line-11); font-variant-numeric: tabular-nums; }
.dim-feishuGroupCountdown strong { color: var(--dsw-alias-label-secondary, #646a73); font-weight: var(--dim-weight-600); }
.dim-feishuGroupProgress { grid-column: 1 / -1; height: 3px; overflow: hidden; border-radius: var(--dim-radius-full); background: var(--dim-module-fill); }
.dim-feishuGroupProgress > span { display: block; height: 100%; border-radius: inherit; background: var(--dim-blue); transition: width 1s linear; }
.dim-feishuGroupAuthorizationCopy { min-width: 0; }
.dim-feishuGroupAuthorizationEyebrow { display: block; margin-bottom: 7px; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-11); line-height: var(--dim-line-11); font-weight: var(--dim-weight-600); }
.dim-feishuGroupAuthorizationCopy ol { display: grid; gap: var(--dim-gap-6); margin: 13px 0 0; padding-left: 18px; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-11); line-height: 18px; }
.dim-feishuGroupAuthorizationActions { display: flex; align-items: center; justify-content: flex-start; flex-wrap: wrap; gap: var(--dim-gap-8); margin-top: 14px; }
.dim-feishuGroupAuthorizationLink { text-decoration: none; }
.dim-deliveryDocsLink { min-height: 30px; flex: none; display: inline-flex; align-items: center; gap: var(--dim-gap-4); padding: 5px 8px; border-radius: var(--dim-radius-8); color: var(--dim-blue); font-size: var(--dim-font-12); line-height: var(--dim-line-12); text-decoration: none; white-space: nowrap; }
.dim-deliveryDocsLink:hover { background: color-mix(in srgb, var(--dim-blue) 8%, transparent); }
.dim-deliveryDocsLink:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); outline-offset: 2px; }
.dim-deliveryButton { height: 28px; display: inline-flex; align-items: center; justify-content: center; padding: 0 10px; border: var(--dim-control-border); border-radius: var(--dim-radius-14); color: var(--dsw-alias-label-primary, #0f1115); background: transparent; font: inherit; font-size: var(--dim-font-12); line-height: var(--dim-line-12); cursor: pointer; }
.dim-deliveryButton:hover:not(:disabled) { background: var(--dim-hover-solid); }
.dim-deliveryButton:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); }
/* Header-row create action. Native expresses emphasis on an outline button through its text colour (dangerButton), never through a fill, so the create action takes the business tone over the shared outline capsule. */
.dim-deliveryButton[data-kind="primary"] { border-color: color-mix(in srgb, var(--dim-blue) 35%, var(--dsw-alias-border-l3, rgb(0 0 0 / 12%))); color: var(--dim-blue); background: transparent; }
.dim-deliveryButton[data-kind="primary"]:hover:not(:disabled) { background: color-mix(in srgb, var(--dim-blue) 8%, transparent); }
.dim-deliveryButton:disabled { opacity: 0.4; cursor: not-allowed; }
.dim-deliveryButton[data-kind="danger"] { border-color: transparent; color: var(--dim-danger); }
.dim-deliveryButton[data-kind="danger"]:hover:not(:disabled) { background: var(--dim-danger-hover); }
.dim-deliveryBack { flex: none; border-color: transparent; background: transparent; }
.dim-deliveryIdentity, .dim-deliveryTargets { min-width: 0; padding: 16px; border: 0.5px solid var(--dsw-alias-border-l4, rgb(0 0 0 / 16%)); border-radius: var(--dim-radius-16); background: none; }
.dim-deliveryIdentityHeading { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-12); }
.dim-deliveryBotName, .dim-deliverySectionHeading h3 { min-width: 0; overflow: hidden; margin: 0; font-size: var(--dim-font-15); line-height: var(--dim-line-15); font-weight: var(--dim-weight-600); text-overflow: ellipsis; white-space: nowrap; }
.dim-deliveryIdentity > div:first-child p, .dim-deliverySectionHeading p { margin: 2px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-deliveryBotId { min-width: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr) max-content; align-items: center; gap: var(--dim-gap-10); margin-top: 12px; padding: 10px 12px; border-radius: var(--dim-radius-8); background: var(--dim-module-fill); }
.dim-deliveryBotId > span { color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); }
.dim-deliveryBotId code { min-width: 0; overflow: hidden; font: 12px/18px var(--dim-font-mono); text-overflow: ellipsis; white-space: nowrap; }
.dim-deliverySectionHeading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--dim-gap-12); }
.dim-deliveryState { margin-top: 14px; padding: 24px 16px; border: 1px dashed var(--dsw-alias-border-l3, #dfe1e5); border-radius: var(--dim-radius-10); color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); text-align: center; }
.dim-deliveryState p { margin: 5px 0; }
.dim-deliveryEmpty strong { color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-13); }
.dim-targetList { display: grid; gap: var(--dim-gap-10); margin: 14px 0 0; padding: 0; list-style: none; }
.dim-targetRow { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) max-content; gap: var(--dim-gap-14); padding: 14px 16px; border: 0; border-radius: var(--dim-radius-12); background: var(--dim-module-fill); }
.dim-targetSummary { min-width: 0; }
.dim-targetTitle { min-width: 0; display: flex; align-items: center; gap: var(--dim-gap-7); }
.dim-targetTitle strong { overflow: hidden; font-size: var(--dim-font-13); line-height: var(--dim-line-13); font-weight: var(--dim-weight-600); text-overflow: ellipsis; white-space: nowrap; }
.dim-targetTitle span { flex: none; padding: 1px 6px; border-radius: var(--dim-radius-8); color: var(--dim-blue); background: color-mix(in srgb, var(--dim-blue) 9%, transparent); font-size: var(--dim-font-11); line-height: var(--dim-line-11); }
.dim-targetSummary code { display: block; overflow: hidden; margin-top: 3px; color: var(--dsw-alias-label-secondary, #646a73); font: 11px/17px var(--dim-font-mono); text-overflow: ellipsis; white-space: nowrap; }
.dim-targetActions { display: flex; align-items: center; justify-content: flex-end; gap: var(--dim-gap-6); flex-wrap: wrap; }
.dim-targetSessionSync { grid-column: 1 / -1; min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-12); padding-top: 9px; border-top: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); cursor: pointer; }
.dim-targetSessionSyncCopy { min-width: 0; display: grid; gap: var(--dim-gap-1); }
.dim-targetSessionSyncCopy strong { color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-12); line-height: var(--dim-line-12); font-weight: var(--dim-weight-600); }
.dim-targetSessionSyncCopy small { color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-11); line-height: var(--dim-line-11); overflow-wrap: anywhere; }
.dim-targetSessionSync input { width: 16px; height: 16px; flex: none; margin: 0; accent-color: var(--dim-blue); }
.dim-targetSessionSync:has(input:disabled) { cursor: default; }
.dim-targetFeedback { grid-column: 1 / -1; margin: 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); overflow-wrap: anywhere; }
.dim-targetFeedback[data-tone="success"] { color: var(--dsw-alias-state-success-primary, #20a162); }
.dim-targetFeedback[data-tone="error"], .dim-targetFormError { color: var(--dim-danger); overflow-wrap: anywhere; }
.dim-targetDeleteConfirm { grid-column: 1 / -1; padding: 10px 12px; border-radius: var(--dim-radius-8); background: color-mix(in srgb, var(--dim-danger) 7%, var(--dsw-alias-bg-layer-1, #fff)); }
.dim-targetDeleteConfirm p { margin: 0 0 8px; font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-targetSuggestions { margin-top: 14px; padding: 14px; border: 0; border-radius: var(--dim-radius-12); background: var(--dim-module-fill); }
.dim-targetSuggestionHeading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--dim-gap-12); }
.dim-targetSuggestionHeading h3 { margin: 0; font-size: var(--dim-font-14); line-height: var(--dim-line-14); }
.dim-targetSuggestionHeading p { margin: 2px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-targetSuggestionState { margin-top: 12px; padding: 18px 12px; border: 1px dashed var(--dsw-alias-border-l3, #dfe1e5); border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); text-align: center; }
.dim-targetSuggestionState p { margin: 4px 0; }
.dim-targetSuggestionState strong { color: var(--dsw-alias-label-primary, #0f1115); }
.dim-targetSuggestionField { min-width: 0; display: grid; gap: var(--dim-gap-6); margin-top: 12px; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); font-weight: var(--dim-weight-500); }
.dim-targetForm { margin-top: 14px; padding: 14px; border: 0; border-radius: var(--dim-radius-12); background: var(--dim-module-fill); }
.dim-targetFormHeading h3 { margin: 0; font-size: var(--dim-font-14); line-height: var(--dim-line-14); }
.dim-targetFormHeading p { margin: 2px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-targetFormGrid { display: grid; gap: var(--dim-gap-11) 12px; margin-top: 12px; }
/* A field wrapper is the host's .field with a .fieldLabel: 12/18/500 in label-secondary,
   which is a different role from a row title - measured on the live General page, a row
   title (.hVGvvW_title, "Language") is 14/22/400 in label-primary, which is what
   .dim-modelRowLabel already is. */
.dim-targetField { min-width: 0; display: grid; align-content: start; gap: var(--dim-gap-6); padding: 12px 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); font-weight: var(--dim-weight-500); }
.dim-targetField input { width: 100%; min-width: 0; height: 32px; padding: 0 10px; border: var(--dim-field-border); border-radius: var(--dim-field-radius); color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; font-size: var(--dim-font-14); line-height: var(--dim-line-14); }
.dim-targetField input:focus { outline: none; border-color: var(--dim-focus); }
.dim-targetField input[readonly] { color: var(--dsw-alias-label-tertiary, #81858c); background: var(--dim-module-fill); }
.dim-targetFormError { margin: 10px 0 0; font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-targetFormActions { display: flex; justify-content: flex-end; gap: var(--dim-gap-7); margin-top: 12px; }
.dim-accessPage { min-width: 0; display: grid; gap: var(--dim-gap-12); }
.dim-accessScene[aria-disabled="true"] { opacity: 0.4; }
.dim-accessScene { position: relative; min-width: 0; margin: 0; padding: 16px; border: 0.5px solid var(--dsw-alias-border-l4, rgb(0 0 0 / 16%)); border-radius: var(--dim-radius-16); background: none; }
/* Ordinary group heading inside the card. A fieldset legend would notch the card border, which no native surface does. */
.dim-accessLegend { margin: 0 0 4px; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-13); line-height: var(--dim-line-13); font-weight: var(--dim-weight-500); }
.dim-accessLegendContent { display: inline-flex; align-items: center; gap: var(--dim-gap-6); }
.dim-accessControls { display: grid; gap: var(--dim-gap-12); }
.dim-accessControls[data-mode="allowlist"] { grid-template-columns: minmax(0, 1fr); }
/* The stacked form survives only inside the multi-column user editor, where a cell is
   a label over its own control. A full-width access field is a shared row instead -
   one anatomy, not two - so the geometry and typography are scoped to that editor. */
.dim-accessUserRow .dim-accessField { display: grid; align-content: start; gap: var(--dim-gap-6); padding: 12px 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); font-weight: var(--dim-weight-500); }
.dim-accessField { min-width: 0; }
.dim-accessField input { width: 100%; min-width: 0; height: 32px; padding: 0 10px; border: var(--dim-field-border); border-radius: var(--dim-field-radius); color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; font-size: var(--dim-font-14); line-height: var(--dim-line-14); }
.dim-accessField input:focus { outline: none; border-color: var(--dim-focus); }
.dim-accessUsers { min-width: 0; margin-top: 14px; padding-top: 14px; border-top: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); }
/* Centred, like every other heading in the sheet: the action on the right belongs to the
   title, not to the top of whatever the text block happens to measure. */
.dim-accessUsersHeading { position: relative; min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-12); }
.dim-accessUsersHeading > div { min-width: 0; }
/* The title and its warning are a stacked text slot, the same shape as .dim-rowText:
   they used to share an inline-flex row, so the warning sat beside the title instead of
   under it and the pair read as one long line. */
.dim-accessUsersTitle { min-width: 0; display: grid; justify-items: start; gap: var(--dim-gap-4); }
.dim-accessUsersHeading strong { color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-13); line-height: var(--dim-line-13); font-weight: var(--dim-weight-600); }
.dim-accessUsersHeading p { margin: 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
/* An icon button, so it centres its glyph instead of typesetting a plus sign: the text
   glyph sat on the baseline of a 20px line box and never looked centred in the square. */
.dim-accessAddUser { width: 32px; height: 32px; min-height: 32px; flex: 0 0 32px; display: grid; place-items: center; padding: 0; }
.dim-accessUsersEmpty { margin-top: 10px; padding: 15px 12px; border: 1px dashed var(--dsw-alias-border-l3, #dfe1e5); border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); text-align: center; }
.dim-accessUserList { display: grid; gap: var(--dim-gap-9); margin: 10px 0 0; padding: 0; list-style: none; }
.dim-accessUserRow { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(145px, 180px) max-content; align-items: end; gap: var(--dim-gap-14); padding: 14px 16px; border: 0; border-radius: var(--dim-radius-12); background: var(--dim-module-fill); }
.dim-accessDeleteUser { margin-bottom: 1px; }
.dim-accessUnsupported { padding: 18px 14px; border: 1px dashed var(--dsw-alias-border-l3, #dfe1e5); border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-secondary, #646a73); background: var(--dim-module-fill); text-align: center; }
.dim-accessUnsupported strong { color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-13); line-height: var(--dim-line-13); }
.dim-accessUnsupported p { margin: 4px 0 0; font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-accessState { padding: 11px 13px; border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 24%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); border-radius: var(--dim-radius-8); color: var(--dsw-alias-state-warn-primary, #d97706); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 7%, var(--dsw-alias-bg-layer-1, #fff)); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-accessFeedback { margin: 0; padding: 10px 12px; border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-secondary, #646a73); background: var(--dim-module-fill); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-accessFeedback[data-tone="success"] { color: var(--dsw-alias-state-success-primary, #20a162); }
.dim-accessFeedback[data-tone="error"] { color: var(--dim-danger); }
.dim-accessActions { display: flex; justify-content: flex-end; }
.dim-generalSettingsPage { min-width: 0; display: grid; }
.dim-generalSettingsHeader { min-width: 0; margin: 0 0 8px; }
.dim-generalSettingsHeader h2 { margin: 0; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-18); line-height: var(--dim-line-18); font-weight: var(--dim-weight-600); }
/* The strip scrolls sideways when the General page has more tabs than fit. */
.dim-generalSettingsTabs { overflow-x: auto; scrollbar-width: none; }
.dim-generalSettingsTabs::-webkit-scrollbar { display: none; }
.dim-generalSettingsTabsBar { min-width: 0; }
.dim-generalSettingsTabPanel { min-width: 0; padding-top: 2px; }
.dim-globalSection { min-width: 0; padding: 14px 16px; border: 0.5px solid var(--dsw-alias-border-l4, rgb(0 0 0 / 16%)); border-radius: var(--dim-radius-16); background: none; }
.dim-globalSection + .dim-globalSection { margin-top: 12px; }
.dim-imageSettings { container-type: inline-size; }
.dim-imageSettingsFields { min-width: 0; display: grid; gap: var(--dim-gap-12); margin-top: 12px; }
.dim-imageSettingsField { min-width: 0; display: grid; grid-template-columns: minmax(0, 220px) minmax(0, 160px); align-items: center; gap: var(--dim-gap-6) var(--dim-gap-16); }
.dim-imageSettingsField label { min-width: 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-13); line-height: var(--dim-line-13); overflow-wrap: anywhere; }
.dim-imageSettingsField .dim-globalTtlInput { width: 100%; min-width: 0; }
.dim-imageSettingsActions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--dim-gap-8); margin-top: 16px; }
.dim-globalInline.dim-imageSettingsFeedback { margin: 10px 0 0; }
@container (max-width: 380px) {
  .dim-imageSettingsField { grid-template-columns: minmax(0, 1fr); }
}
.dim-globalHead { min-width: 0; display: flex; align-items: center; }
.dim-globalHeadTitle { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: var(--dim-gap-6); }
.dim-globalHead h3 { min-width: 0; overflow: hidden; margin: 0; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-15); line-height: var(--dim-line-15); font-weight: var(--dim-weight-600); text-overflow: ellipsis; white-space: nowrap; }
.dim-globalTtlRow { display: flex; align-items: center; flex-wrap: wrap; gap: var(--dim-gap-4) 10px; margin-top: 12px; }
.dim-globalTtlInput { width: min(160px, 100%); min-width: 110px; max-width: 160px; flex: 1 1 130px; height: 32px; padding: 0 10px; border: var(--dim-field-border); border-radius: var(--dim-field-radius); color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-alias-bg-layer-1, #fff); font: 13px/1.5 var(--dim-font-mono); transition: border-color .16s ease; }

.dim-globalTtlInput:focus { outline: none; border-color: var(--dim-focus); }
.dim-globalTtlInput[aria-invalid="true"] { border-color: color-mix(in srgb, var(--dim-danger) 62%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); }
.dim-globalTtlInput:disabled { cursor: not-allowed; opacity: 0.4; }
/* The save capsule is the same role as .dim-globalSweepButton beside it, so it takes the
   same 28px action rung from .dim-deliveryButton. Declaring min-height: 34px here did not
   "raise" that height - height and min-height are different longhands and never compete, so
   the used value was max(28, 34) = 34px, which made the row 34 / 32 / 28 across three
   controls that should be two ladders: 32px fields, 28px capsule actions. */
.dim-globalSaveButton { min-width: 58px; }
.dim-globalSweepAction { position: relative; display: inline-flex; flex: none; margin-left: auto; }
.dim-globalSweepButton { flex: none; }
.dim-globalSweepConfirm { position: absolute; top: calc(100% + 8px); right: 0; z-index: var(--dim-z-popover); width: 218px; padding: 11px 12px; border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); border-radius: var(--dim-radius-8); background: var(--dsw-alias-bg-layer-3, #fff); box-shadow: 0 12px 30px rgb(31 35 41 / 18%); }
.dim-globalSweepConfirm p { margin: 0; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-globalSweepConfirmActions { display: flex; justify-content: flex-end; gap: var(--dim-gap-7); margin-top: 10px; }
.dim-deliveryButton.dim-globalSweepConfirmButton { border-color: transparent; color: var(--dim-danger); }
.dim-deliveryButton.dim-globalSweepConfirmButton:hover:not(:disabled) { background: var(--dim-danger-hover); }
.dim-globalInline { flex: 1 0 100%; min-width: 0; margin: 2px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); overflow-wrap: anywhere; }
.dim-globalInline[data-tone="error"] { color: var(--dim-danger); }
.dim-panel .dim-botCard .dim-cardFooter { margin-top: 0; }
.dim-panel .ddt-headingCopy { display: none; }
.dim-panel .ddt-qrFrame, .dim-panel .ddt-countdown { width: min(270px, 100%); }
.dim-panel .bxf-headingTools, .dim-panel .dxw-tools, .dim-panel .ddt-tools { gap: var(--dim-gap-8); }
.dim-panel .dim-bindActions { gap: var(--dim-gap-6); }
  /* No padding here. The scan button and the credential button are one role - a
   28px capsule action in the heading toolbar - and their inline padding belongs
   to that role's own rules (292 / 294), not to a container query. This line used
   to set 8px on both, which is how the two buttons in the SAME row ended up
   rendering different paddings: a value expressed on a container query competes
   with the role's own rule, so the winner follows sheet order rather than intent.

   Sheet order is not "channel after shared". client/index.js:445-459 installs the
   eleven channel sheets first and the shared sheet LAST, so at equal specificity
   the shared sheet wins against all eleven - which is why this block, injected
   with the shared sheet, beat feishu. DingTalk is the exception: it is not in
   that list and installs later (mount, or via a peer channel), so dingtalk wins
   equal-specificity ties against the shared sheet. Any future tie-break has to
   be reasoned from that order, not from "the channel sheet came second". */
.dim-panel .bxf-headingTools .dim-scanButton, .dim-panel .dxw-tools .dim-scanButton, .dim-panel .ddt-tools .dim-scanButton, .dim-panel .dim-credentialButton { gap: var(--dim-gap-5); font-size: var(--dim-font-12); }
.dim-panel .dim-actionIcon { width: 13px; height: 13px; flex-basis: 13px; }

.dim-panel .dim-credentialForm { grid-template-columns: minmax(0, 1fr); }
.dim-panel .dim-credentialError, .dim-panel .dim-credentialActions { grid-column: auto; }
.dim-panel .dim-emptyView { min-height: 0; grid-template-columns: minmax(0, 1fr); }
.dim-panel .dim-emptyBrand { display: none; }
.dim-panel .dim-qrLayout { grid-template-columns: minmax(0, 1fr); justify-items: center; gap: var(--dim-gap-24); }
.dim-panel .dim-qrColumn { width: 100%; min-width: 0; }
.dim-panel .dim-qrCopy { width: 100%; min-width: 0; overflow-wrap: anywhere; }
.dim-panel .ddt-qrLayout { grid-template-columns: minmax(0, 1fr); justify-items: center; gap: var(--dim-gap-24); }
.dim-panel .ddt-qrColumn { width: 100%; min-width: 0; }
.dim-panel .ddt-qrCopy { width: 100%; min-width: 0; overflow-wrap: anywhere; }
.dim-targetRow { grid-template-columns: minmax(0, 1fr); }
.dim-targetActions { justify-content: flex-start; }
.dim-targetFormGrid { grid-template-columns: minmax(0, 1fr); }
.dim-targetSuggestionHeading { align-items: stretch; flex-direction: column; }
.dim-accessControls { grid-template-columns: minmax(0, 1fr); }
.dim-accessUserRow { grid-template-columns: minmax(0, 1fr); }
.dim-accessDeleteUser { justify-self: start; }
.dim-feishuGroupAuthorization { grid-template-columns: minmax(0, 1fr); justify-items: center; }
.dim-feishuGroupAuthorizationCopy { width: 100%; }
.dim-feishuGroupAuthorizationState { grid-template-columns: 32px minmax(0, 1fr); justify-items: stretch; }
.dim-feishuGroupAuthorizationError { justify-items: stretch; }
/* Below this the two columns stop fitting, so the rail folds back into the wrapped
   strip it used before: a narrow window keeps every channel reachable without
   introducing a second scroll container. */
@media (max-width: 840px) {
  .dim-title { align-items: flex-start; }
  .dim-layout { display: block; }
  .dim-rail { flex-direction: row; flex-wrap: wrap; align-items: center; gap: var(--dim-gap-4); position: static; width: auto; max-height: none; overflow-y: visible; margin: 0 0 12px; }
  .dim-channel { width: auto; max-width: 100%; height: auto; min-height: 34px; padding: 9px 16px 9px 12px; }
  .dim-channel[aria-selected="true"]::before { display: none; }
}
@media (max-width: 560px) {
  .dim-title { flex-direction: column; gap: var(--dim-gap-10); }
  .dim-titleActions { justify-content: flex-start; }
  .dim-updateBackdrop { padding: 12px; }
  .dim-updateDialog { max-height: calc(100vh - 24px); }
  .dim-updateDialog h3 { margin: 18px 18px 8px; }
  .dim-updateDialog .dim-helpRow { margin: 18px 18px 8px; }
  .dim-updateBody { padding: 16px 18px; }
  .dim-updateFooter { padding: 12px 18px; }
/* Anchored to the action's right edge so the tooltip grows leftward. Opened to
   the right it ran 46px past the page at vw 560 and made a native container
   scrollable by 22px - a hidden element still contributes scrollable overflow. */
.dim-githubTooltip { right: 0; left: auto; }
  .dim-loopbackRecovery { align-items: stretch; flex-direction: column; gap: var(--dim-gap-12); }
  .dim-loopbackRecoveryAction { width: 100%; }
  .dim-deliverySectionHeading { align-items: stretch; flex-direction: column; }
  .dim-botSettingsTabs { gap: var(--dim-gap-18); }
  .dim-deliveryBotId { grid-template-columns: minmax(0, 1fr) max-content; }
  .dim-deliveryBotId > span { grid-column: 1 / -1; }
  .dim-targetActions .dim-deliveryButton { flex: 1 1 auto; }
  .dim-accessActions .dim-deliveryButton { width: 100%; }
  .dim-feishuGroupAuthorizationActions .dim-deliveryButton { flex: 1 1 auto; }
  .dim-directoryPickerBackdrop { padding: 10px; }
  .dim-directoryPicker { height: calc(100vh - 20px); min-height: 0; border-radius: var(--dim-radius-14); }
  .dim-directoryPickerHeader { padding: 18px 17px 14px; }
  .dim-directoryPathMeta span { display: none; }
  .dim-directoryPickerBody { padding: 10px; }
  .dim-directoryPickerFooter { grid-template-columns: minmax(0, 1fr) max-content; gap: var(--dim-gap-10); padding: 13px 14px; }
  .dim-directoryPickerNotice { grid-column: 1 / -1; grid-row: 1; text-align: left; }
}
@media (prefers-reduced-motion: reduce) {
  .dim-page * { transition-duration: .01ms !important; }
  .dim-directoryPickerSpinner { animation-duration: 1.8s; }
  .dim-collapsibleBody, .dim-collapsibleChevron { transition: none !important; }
}
`;

export function installImStyles() {
  if (typeof document === 'undefined') return () => {};
  const existing = document.querySelector(`style[data-plugin-css="${IM_STYLE_ID}"]`);
  if (existing) return () => {};
  const style = document.createElement('style');
  style.dataset.plugin = '@xmanrui/dsh-im';
  style.dataset.pluginCss = IM_STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => style.remove();
}
