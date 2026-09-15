export const IM_STYLE_ID = 'xmanrui-dsh-im-settings';

const CSS = String.raw`
/* Native Tooltip skin, declared once. The tooltips in this sheet carry
   only their positioning; these nine declarations used to be repeated
   character for character in every one of them. */
.dim-botNameTooltip,
.dim-githubTooltip,
.dim-generalSettingsTooltip,
.dim-generalSettingsButton[aria-current="page"] + .dim-generalSettingsTooltip,
.dim-panel .dim-channelTooltip,
.dim-panel .dim-presetTooltip,
.dim-contextHeaderTooltip,
.dim-contextTooltip.dim-contextFieldTooltip,
.dim-contextField:nth-child(odd) .dim-contextFieldTooltip,
.dim-contextTooltip,
.dim-contextTooltip.dim-contextLegendTooltip,
.dim-contextTooltip.dim-contextGuidanceTooltip,
.dim-botSettingsTooltip,
.dim-accessLegendHelp .dim-channelTooltip,
.dim-accessUsersHelp .dim-channelTooltip,
.dim-globalTtlTooltip,
.dim-githubTooltip {
  padding: 3px 7px;
  border: 0;
  border-radius: var(--dim-radius-8);
  color: var(--dsw-static-neutral-bluish-00, #f9fafb);
  background: var(--dsw-alias-tooltip-bg, #2c2c2e);
  box-shadow: none;
  font-size: var(--dim-font-13);
  line-height: 20px;
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
.dim-aliasEdit:hover:not(:disabled), .dim-aliasEdit:focus-visible { color: var(--dsw-alias-state-business-primary, #4176e6); background: var(--dim-hover); }
.dim-aliasDialog { box-sizing: border-box; width: min(380px, calc(100% - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto; padding: 22px; border: 0; border-radius: var(--dim-radius-24); background: var(--dsw-alias-bg-layer-2, #fff); box-shadow: var(--dsw-elevation-prominent, 0 0 0 .5px rgb(0 0 0 / 16%), 0 3px 8px rgb(0 0 0 / 4%), 0 0 20px rgb(0 0 0 / 5%)); color: var(--dsw-alias-label-primary, #0f1115); font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.dim-aliasDialog * { box-sizing: border-box; }
.dim-aliasDialog::backdrop { background: var(--dsw-alias-bg-mask-1, rgb(0 0 0 / 24%)); backdrop-filter: var(--dsw-mask-blur, blur(2px)); }
.dim-aliasHeader { display: flex; justify-content: space-between; align-items: center; gap: var(--dim-gap-12); margin-bottom: 18px; }
.dim-aliasHeader h3 { margin: 0; font-size: var(--dim-font-16); }
.dim-aliasDialog button { font: inherit; cursor: pointer; }
.dim-aliasDialog .dim-aliasClose { width: 28px; height: 28px; padding: 0; border: none; border-radius: var(--dim-radius-8); background: transparent; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-18); cursor: pointer; }
.dim-aliasDialog .dim-aliasClose:hover:not(:disabled) { background: var(--dim-hover); }
.dim-aliasOriginal { display: flex; flex-wrap: wrap; gap: var(--dim-gap-6) 14px; padding: 10px 12px; margin-bottom: 18px; border-radius: var(--dim-radius-8); background: var(--dsw-alias-bg-layer-2, #f5f6f7); overflow-wrap: anywhere; }
.dim-aliasOriginal > span:first-child { flex: none; color: var(--dsw-alias-label-secondary, #646a73); }
.dim-aliasDialog label { display: block; margin-bottom: 7px; }
.dim-aliasDialog input { width: 100%; height: 32px; padding: 0 10px; border: var(--dim-field-border); border-radius: var(--dim-field-radius); color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; font-size: var(--dim-font-14); line-height: var(--dim-line-14); }
.dim-aliasHelp { margin: 8px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); }
.dim-aliasError { color: var(--dim-danger); overflow-wrap: anywhere; }
.dim-aliasFooter { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--dim-gap-14); margin-top: 24px; }
.dim-aliasRestore { padding: 4px 0; border: 0; color: var(--dsw-alias-state-business-primary, #4176e6); background: transparent; }
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
  --dim-radius-indicator: 2px 2px 0 0;
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
  --dim-gap-24: 24px;
  --dim-gap-30: 30px;
  --dim-gap-32: 32px;
  --dim-gap-34: 34px;
  --dim-field-radius: var(--dim-radius-8);
  --dim-module-fill: var(--dsw-alias-bg-module-platform, #f5f6f7);
  --dim-hover: var(--dsw-alias-interactive-bg-hover, rgb(38 49 72 / 6%));
  --dim-hover-solid: var(--dsw-alias-interactive-bg-hover-solid, #f1f3f5);
  --dim-focus: var(--dsw-alias-brand-primary, #0f1115);
  --dim-focus-ring: 2px solid var(--dsw-alias-brand-primary, #0f1115);
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
  --dim-z-popover: 35;
  --dim-z-portal: 1000;
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
     itself pairs get one - 12/18, 13/20, 14/22, 16/24, 20/28. The plugin's 11, 15 and
     18px rungs have no host pair, so no leading token exists for them and those rules
     keep their literal, which is what the census found (11px text runs at 16px and
     17px with no host answer to copy). */
  --dim-line-12: 18px;
  --dim-line-13: 20px;
  --dim-line-14: 22px;
  --dim-line-16: 24px;
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
.dim-brandHeading { display: flex; align-items: center; gap: var(--dim-gap-8); white-space: nowrap; }
.dim-brandName { color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-18); line-height: 25px; font-weight: var(--dim-weight-600); letter-spacing: 0; }
.dim-brandVersion { display: inline-flex; align-items: center; padding: 1px 8px; border: 0.5px solid var(--dsw-alias-border-l4, rgb(0 0 0 / 16%)); border-radius: var(--dim-radius-full); corner-shape: round; color: var(--dsw-alias-label-tertiary, #81858c); font: 500 11px/17px var(--dim-font-mono, monospace); }
.dim-title p { margin: 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-13); line-height: var(--dim-line-13); font-weight: var(--dim-weight-400); white-space: nowrap; }
.dim-titleActions { display: flex; align-items: center; justify-content: flex-end; gap: var(--dim-gap-8); flex-wrap: wrap; }
.dim-updateButton { height: 28px; display: inline-flex; align-items: center; justify-content: center; gap: var(--dim-gap-4); padding: 0 10px; border: var(--dim-control-border); border-radius: var(--dim-radius-14); color: var(--dsw-alias-label-secondary, #646a73); background: transparent; font: inherit; font-size: var(--dim-font-12); line-height: var(--dim-line-12); cursor: pointer; }
.dim-updateButton:hover:not(:disabled) { color: var(--dsw-alias-label-primary, #0f1115); background: var(--dim-hover-solid); }
.dim-updateButton:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); }
.dim-updateButton:disabled { opacity: 0.4; cursor: default; }
.dim-updateTrigger { white-space: nowrap; }
.dim-updateBackdrop { position: fixed; inset: 0; z-index: var(--dim-z-portal); display: grid; place-items: center; padding: 24px; background: var(--dsw-alias-bg-mask-1, rgb(0 0 0 / 24%)); backdrop-filter: var(--dsw-mask-blur, blur(2px)); }
.dim-updateBackdrop, .dim-updateBackdrop * { box-sizing: border-box; }
.dim-updateDialog { width: min(480px, 100%); max-height: calc(100vh - 48px); overflow-y: auto; border: 0; border-radius: var(--dim-radius-24); background: var(--dsw-alias-bg-layer-2, #fff); box-shadow: var(--dsw-elevation-prominent, 0 0 0 .5px rgb(0 0 0 / 16%), 0 3px 8px rgb(0 0 0 / 4%), 0 0 20px rgb(0 0 0 / 5%)); color: var(--dsw-alias-label-primary, #0f1115); text-align: left; }
.dim-updateDialog:focus { outline: none; }
.dim-updateDialog h3 { margin: 22px 24px 8px; font-size: var(--dim-font-18); line-height: 25px; font-weight: var(--dim-weight-600); }
.dim-updateDescription { margin: 0 24px; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-13); line-height: var(--dim-line-13); }
.dim-updateBody { padding: 18px 24px 20px; }
.dim-updateVersions { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--dim-gap-8) 18px; margin: 0 0 18px; font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-updateVersions dt { color: var(--dsw-alias-label-secondary, #646a73); }
.dim-updateVersions dd { min-width: 0; margin: 0; overflow-wrap: anywhere; font-family: var(--dim-font-mono, monospace); }
.dim-updateStatus { padding: 12px 14px; border: 0.5px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: var(--dim-radius-10); background: var(--dsw-alias-bg-layer-1, #f7f8fa); font-size: var(--dim-font-13); line-height: var(--dim-line-13); }
.dim-updateStatus strong { font-weight: var(--dim-weight-600); }
.dim-updateStatus p { margin: 6px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); overflow-wrap: anywhere; }
.dim-updateStatusError { border-color: color-mix(in srgb, var(--dim-danger) 25%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); }
.dim-updateHint, .dim-updateError { margin: 12px 0 0; font-size: var(--dim-font-12); line-height: var(--dim-line-12); overflow-wrap: anywhere; }
.dim-updateHint { color: var(--dsw-alias-label-secondary, #646a73); }
.dim-updateError { color: var(--dim-danger); }
.dim-updateManual { margin-top: 18px; padding-top: 16px; border-top: 0.5px solid var(--dsw-alias-border-l1, #eef0f3); }
.dim-updateManualHeading { margin: 0; font-size: var(--dim-font-13); line-height: var(--dim-line-13); font-weight: var(--dim-weight-600); }
.dim-updateManualHint { margin: 8px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-updateCommandRow { display: flex; align-items: center; gap: var(--dim-gap-8); margin-top: 10px; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); border-radius: var(--dim-radius-8); background: var(--dsw-alias-bg-layer-1, #f7f8fa); }
.dim-updateCommand { display: block; flex: 1; width: 100%; min-width: 0; padding: 0; resize: none; border: 0; color: var(--dsw-alias-label-primary, #0f1115); background: transparent; font: 12px/19px var(--dim-font-mono, monospace); overflow-wrap: anywhere; }
.dim-updateCommand:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); outline-offset: 2px; }
.dim-updateCopy { display: inline-flex; flex: 0 0 28px; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-secondary, #646a73); background: transparent; cursor: pointer; }
.dim-updateCopy:hover:not(:disabled) { color: var(--dsw-alias-label-primary, #0f1115); background: var(--dim-hover); }
.dim-updateCopy:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); outline-offset: 2px; }
.dim-updateCopy:disabled { opacity: 0.4; cursor: default; }
.dim-updateCopyCopied { color: var(--dsw-alias-state-success-primary, #20a162); }
.dim-updateFooter { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: var(--dim-gap-8); padding: 14px 24px; border-top: 0.5px solid var(--dsw-alias-border-l1, #eef0f3); }
.dim-updateFooter .dim-updateButton:first-child { margin-right: auto; }
.dim-updatePrimary, .dim-updatePrimary:hover:not(:disabled) { border-color: var(--dsw-alias-state-business-primary, #4176e6); color: var(--dim-action-on-fill, #fff); background: var(--dsw-alias-state-business-primary, #4176e6); }
.dim-githubAction { position: relative; display: inline-flex; flex: none; }
.dim-githubLink { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; flex: none; padding: 0; border: none; border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-tertiary, #81858c); background: transparent; font-size: var(--dim-font-12); line-height: var(--dim-line-12); text-decoration: none; transition: color .15s ease, background .15s ease; }
.dim-githubLink:hover { color: var(--dsw-alias-label-primary, #0f1115); background: var(--dim-hover); }
.dim-githubLink:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); }
.dim-githubTooltip { position: absolute; top: calc(100% + 8px); right: 0; z-index: var(--dim-z-tooltip-page); width: max-content; max-width: min(220px, 80vw); white-space: nowrap; opacity: 0; visibility: hidden; transform: translateY(-3px); pointer-events: none; transition: opacity .15s ease, transform .15s ease, visibility .15s ease; }
.dim-githubAction:hover .dim-githubTooltip, .dim-githubAction:focus-within .dim-githubTooltip { opacity: 1; visibility: visible; transform: translateY(0); }
.dim-generalSettingsAction { position: relative; display: inline-flex; flex: none; }
.dim-generalSettingsButton { width: 28px; height: 28px; display: grid; place-items: center; flex: none; padding: 0; border: none; border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-tertiary, #81858c); background: transparent; cursor: pointer; transition: color .15s ease, background .15s ease; }
.dim-generalSettingsButton svg { display: block; }
.dim-generalSettingsButton:hover { color: var(--dsw-alias-label-primary, #0f1115); background: var(--dim-hover); }
.dim-generalSettingsButton[aria-current="page"] { color: var(--dsw-alias-label-primary, #0f1115); background: var(--dim-module-fill); }
.dim-generalSettingsButton:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); }
.dim-generalSettingsTooltip { position: absolute; top: calc(100% + 8px); right: 0; z-index: var(--dim-z-tooltip-page); width: max-content; white-space: nowrap; opacity: 0; visibility: hidden; transform: translateY(-3px); pointer-events: none; transition: opacity .15s ease, transform .15s ease, visibility .15s ease; }
.dim-generalSettingsAction:hover .dim-generalSettingsTooltip, .dim-generalSettingsButton:focus-visible + .dim-generalSettingsTooltip { opacity: 1; visibility: visible; transform: translateY(0); }
.dim-generalSettingsButton[aria-current="page"] + .dim-generalSettingsTooltip { opacity: 0; visibility: hidden; transform: translateY(-3px); }
/* Channel switching is a wrapped tab strip, the way native settings pages switch
   between peers. A second vertical rail inside the settings column would take
   223px out of the 564px the shell hands to a page. */
.dim-layout { display: block; }
.dim-rail { display: flex; flex-wrap: wrap; align-items: center; gap: var(--dim-gap-4); margin: 0 0 12px; padding: 0; }
.dim-channel { max-width: 100%; min-height: 28px; display: inline-flex; align-items: center; gap: var(--dim-gap-6); padding: 0 10px 0 4px; border: 0; border-radius: var(--dim-radius-14); color: var(--dsw-alias-label-secondary, #646a73); background: transparent; font: inherit; text-align: left; cursor: pointer; transition: background .16s ease, color .16s ease; }
.dim-channel:hover { color: var(--dsw-alias-label-primary, #0f1115); background: var(--dim-hover); }
.dim-channel[aria-selected="true"] { color: var(--dsw-alias-label-primary, #0f1115); font-weight: var(--dim-weight-500); background: var(--dsw-specific-sidebar-nav-item-active, #ebeef2); }
.dim-channel:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #0f1115); outline-offset: 2px; }
.dim-logo { width: 20px; height: 20px; flex: none; display: grid; place-items: center; border-radius: var(--dim-radius-8); }
.dim-logo svg { display: block; width: 14px; height: 14px; }
.dim-logoWeixin { color: white; background: #07c160; }
.dim-logoFeishu { background: white; border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); }
.dim-logoFeishu svg { width: 17px; height: 17px; }
.dim-logoDingtalk { color: white; background: #1677ff; }
.dim-logoQq { color: white; background: #1677ff; }
.dim-logoWecom { background: white; border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); }
.dim-logoWecom svg { width: 15px; height: 15px; }
.dim-logoTelegram { color: white; background: #229ed9; }
.dim-logoOffice { color: white; background: linear-gradient(145deg, #12213f, #3964fe); }
.dim-logoDiscord { color: white; background: #5865f2; }
.dim-logoSlack { background: linear-gradient(145deg, #fff, #f8fafb); border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); }
.dim-logoWhatsapp { color: white; background: #25d366; }
.dim-logoIMessage { color: white; background: linear-gradient(180deg, #5bf675 0%, #28d944 50%, #0fbd2c 100%); }
.dim-channelCopy { min-width: 0; display: inline-flex; align-items: baseline; gap: var(--dim-gap-4); }
.dim-channelCopy strong { overflow: hidden; color: inherit; font-size: var(--dim-font-13); line-height: var(--dim-line-13); font-weight: var(--dim-weight-500); text-overflow: ellipsis; white-space: nowrap; }
.dim-channelNote { flex: none; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-11); line-height: 16px; font-weight: var(--dim-weight-400); white-space: nowrap; }
.dim-panel { min-width: 0; container-type: inline-size; }
.dim-loopbackRecovery { display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-16); margin: 0 0 14px; padding: 14px 16px; border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 30%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); border-radius: var(--dim-radius-12); color: var(--dsw-alias-label-primary, #0f1115); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 8%, var(--dsw-alias-bg-layer-1, #fff)); }
.dim-loopbackRecoveryCopy { min-width: 0; }
.dim-loopbackRecoveryCopy strong { display: block; font-size: var(--dim-font-14); line-height: var(--dim-line-14); font-weight: var(--dim-weight-600); }
.dim-loopbackRecoveryCopy p { margin: 3px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-loopbackRecoveryCopy code { display: block; overflow: hidden; margin-top: 5px; color: var(--dsw-alias-label-secondary, #646a73); font: 11px/16px var(--dim-font-mono, monospace); text-overflow: ellipsis; white-space: nowrap; }
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
   hover and the border does not. They carry data-kind="primary" in the markup, so the
   channel sheets' [data-kind="primary"] rules reach them at (0,2,0)/(0,4,0) and paint the
   BORDER with --dim-action-fill - near-white in dark, near-black in light - around a
   surface this rule had already made neutral. Two owners, one capsule. Declaring the
   resting border colour here at (0,5,0) closes it: the fill rules can no longer reach
   the capsule, and the border keeps the value --dim-control-border already gave it. */
.dim-panel .bxf-headingTools .dim-scanButton:hover:not(:disabled), .dim-panel .dxw-tools .dim-scanButton:hover:not(:disabled), .dim-panel .ddt-tools .dim-scanButton:hover:not(:disabled) { background: var(--dim-hover-solid); border-color: var(--dsw-alias-border-l3, rgb(0 0 0 / 12%)); }
.dim-panel .dim-credentialButton { flex: none; height: 28px; display: inline-flex; align-items: center; justify-content: center; gap: var(--dim-gap-6); padding: 0 10px; border: var(--dim-control-border); border-radius: var(--dim-radius-14); color: var(--dsw-alias-label-primary, #0f1115); background: transparent; font: inherit; font-size: var(--dim-font-12); line-height: var(--dim-line-12); white-space: nowrap; cursor: pointer; }
.dim-panel .dim-actionIcon { width: 15px; height: 15px; flex: 0 0 15px; }
.dim-panel .dim-credentialButton:hover:not(:disabled) { background: var(--dim-hover-solid); border-color: var(--dsw-alias-border-l3, rgb(0 0 0 / 12%)); }
.dim-panel .dim-credentialButton[aria-pressed="true"] { border-color: transparent; background: var(--dsw-specific-sidebar-nav-item-active, #ebeef2); }
.dim-panel .bxf-headingTools .dim-onlineBadge, .dim-panel .dxw-tools .dim-onlineBadge, .dim-panel .ddt-tools .dim-onlineBadge { height: 24px; min-height: 24px; display: inline-flex; align-items: center; justify-self: end; gap: var(--dim-gap-4); padding: 0 8px; border: none; border-radius: var(--dim-radius-12); color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-bg-layer-2, #fff); font: inherit; font-size: var(--dim-font-12); font-weight: var(--dim-weight-400); line-height: var(--dim-line-12); white-space: nowrap; }
.dim-panel .dim-channelPage { min-width: 0; width: 100%; max-width: none; display: flex; flex-direction: column; gap: var(--dim-gap-12); padding: 0 0 24px; color: var(--dsw-alias-label-primary, #0f1115); box-sizing: border-box; }
.dim-panel select.dim-presetSelect, .dim-panel .dim-targetField select, .dim-panel .dim-accessField select,
.dim-panel .dim-targetSuggestionField select, .dim-panel .dim-feishuGroupSelect, .dim-panel .bxf-responseModeSelect {
  appearance: none;
  padding-right: 32px;
  background-image: var(--dim-chevron);
  background-repeat: no-repeat;
  background-position: right 12px center;
  background-size: 12px 12px;
}
.dim-panel .dim-surfaceCard { position: relative; overflow: hidden; border: 0.5px solid var(--dsw-alias-border-l4, rgb(0 0 0 / 16%)); border-radius: var(--dim-radius-16); background: none; }
.dim-panel .dim-surfaceCard::before { display: none; }
.dim-panel .dim-surfaceBody { padding: 24px; }
.dim-panel .dim-credentialPanel { display: grid; gap: var(--dim-gap-16); padding: 20px; }
.dim-panel .dim-credentialTitle { margin: 0; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-16); line-height: var(--dim-line-16); font-weight: var(--dim-weight-600); }
.dim-panel .dim-credentialForm { min-width: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--dim-gap-16) 12px; }
.dim-panel .dim-credentialFormSingle { grid-template-columns: minmax(0, 1fr); }
.dim-panel .dim-credentialField { min-width: 0; display: grid; gap: var(--dim-gap-6); color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-13); line-height: var(--dim-line-13); font-weight: var(--dim-weight-500); }
.dim-panel .dim-credentialField input { width: 100%; min-width: 0; height: 32px; padding: 0 10px; border: var(--dim-field-border); border-radius: var(--dim-field-radius); outline: none; color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-alias-bg-layer-1, #fff); font: 13px/1.5 var(--dim-font-mono, monospace); transition: border-color .16s ease; }
.dim-panel .dim-credentialField input:focus { outline: none; border-color: var(--dim-focus); }
.dim-panel .dim-credentialField input::placeholder { color: var(--dsw-alias-label-caption, #adb2b8); font-family: inherit; }
.dim-panel .dim-credentialError, .dim-panel .dim-credentialActions { grid-column: 1 / -1; }
.dim-panel .dim-credentialError { margin: 0; color: var(--dsw-alias-state-error-primary, #d54941); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-panel .dim-credentialActions { margin-top: 0; }
.dim-panel .dim-listSection { min-width: 0; width: 100%; max-width: 100%; display: flex; flex-direction: column; gap: 0; }
.dim-panel .dim-listHeading { min-height: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-16); margin: 0 0 8px; padding: 0; }
.dim-panel .dim-listConnection { color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-panel .dim-listHeading h3 { margin: 0; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-14); line-height: var(--dim-line-14); font-weight: var(--dim-weight-400); }
.dim-panel .dim-listTitle { min-width: 0; display: inline-flex; align-items: center; gap: var(--dim-gap-6); }
.dim-panel .dim-channelHelp { position: relative; display: inline-flex; flex: none; }
.dim-panel .dim-channelHelpButton { width: 16px; height: 16px; display: grid; place-items: center; padding: 0; border: none; border-radius: 50%; corner-shape: round; color: var(--dsw-alias-label-tertiary, #81858c); background: transparent; font: inherit; font-size: var(--dim-font-11); line-height: 1; font-weight: var(--dim-weight-500); cursor: help; transition: color .15s ease, background .15s ease; }
.dim-panel .dim-channelHelpButton:hover { color: var(--dsw-alias-label-primary, #0f1115); background: var(--dim-hover); }
.dim-panel .dim-channelHelpButton:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); }
.dim-panel .dim-channelTooltip { position: absolute; top: calc(100% + 7px); left: 0; z-index: var(--dim-z-tooltip); width: max-content; max-width: min(280px, calc(100vw - 48px)); display: flex; align-items: baseline; gap: var(--dim-gap-5); white-space: normal; opacity: 0; visibility: hidden; transform: translateY(-3px); pointer-events: none; transition: opacity .15s ease, transform .15s ease, visibility .15s ease; }
.dim-panel .dim-channelTooltip strong { color: var(--dsw-alias-label-primary, #0f1115); font-weight: var(--dim-weight-600); white-space: nowrap; }
.dim-panel .dim-channelHelp:hover .dim-channelTooltip, .dim-panel .dim-channelHelp:focus-within .dim-channelTooltip { opacity: 1; visibility: visible; transform: translateY(0); }
.dim-panel .dim-botList { min-width: 0; width: 100%; max-width: 100%; display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--dim-gap-12); margin: 0; padding: 0; list-style: none; }
.dim-panel .dim-botList > li { min-width: 0; max-width: 100%; }
.dim-panel .dim-loadingView { padding: 38px; color: var(--dsw-alias-label-secondary, #646a73); text-align: center; }
.dim-panel .dim-loadingView h3 { margin: 0 0 7px; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-16); line-height: var(--dim-line-16); font-weight: var(--dim-weight-600); }
.dim-panel .dim-loadingView p { margin: 0; line-height: 1.6; }
.dim-panel .dim-spinner { width: 24px; height: 24px; margin: 0 auto 12px; border: 3px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); border-top-color: var(--dsw-alias-state-business-primary, #4176e6); border-radius: 50%; corner-shape: round; animation: dim-spin .8s linear infinite; }
@keyframes dim-spin { to { transform: rotate(360deg); } }
.dim-panel .dim-emptyView { min-height: 230px; display: grid; grid-template-columns: minmax(0, 1fr) 180px; align-items: center; gap: var(--dim-gap-30); }
.dim-panel .dim-emptyCopy { min-width: 0; }
.dim-panel .dim-emptyCopy h3 { margin: 8px 0; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-18); line-height: 1.35; font-weight: var(--dim-weight-600); }
.dim-panel .dim-emptyCopy > p { max-width: 560px; margin: 0; color: var(--dsw-alias-label-secondary, #646a73); line-height: 1.65; }
.dim-panel .dim-emptyBrand { width: 110px; height: 110px; display: grid; place-items: center; justify-self: center; border-radius: var(--dim-radius-24); box-shadow: 0 18px 45px rgb(22 119 255 / 18%); }
.dim-panel .dim-stateLabel { display: inline-flex; align-items: center; gap: var(--dim-gap-8); color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); font-weight: var(--dim-weight-600); }
.dim-panel .dim-stateDot { flex: none; width: 8px; height: 8px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-label-tertiary, #81858c); box-shadow: none; }
.dim-panel .dim-stateDot[data-tone="success"] { background: var(--dsw-alias-state-success-primary, #20a162); }
.dim-panel .dim-stateDot[data-tone="warning"] { background: var(--dsw-alias-state-warn-primary, #d97706); }
.dim-panel .dim-stateDot[data-tone="error"] { background: var(--dsw-alias-state-error-primary, #d54941); }
.dim-panel .dim-viewActions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--dim-gap-10); margin-top: 20px; }
.dim-panel .dim-viewActions .bxf-button, .dim-panel .dim-viewActions .dxw-button, .dim-panel .dim-viewActions .ddt-button { height: 28px; display: inline-flex; align-items: center; justify-content: center; padding: 0 10px; border: var(--dim-control-border); border-radius: var(--dim-radius-14); color: var(--dsw-alias-label-primary, #0f1115); background: transparent; box-shadow: none; font: inherit; font-size: var(--dim-font-12); line-height: var(--dim-line-12); white-space: nowrap; cursor: pointer; }
.dim-panel .dim-viewActions .bxf-button[data-kind="primary"], .dim-panel .dim-viewActions .dxw-button[data-kind="primary"], .dim-panel .dim-viewActions .ddt-button[data-kind="primary"] { border: var(--dim-control-border); color: var(--dsw-alias-label-primary, #0f1115); background: transparent; box-shadow: none; }
.dim-panel .dim-viewActions .bxf-button[data-kind="danger"], .dim-panel .dim-viewActions .dxw-button[data-kind="danger"], .dim-panel .dim-viewActions .ddt-button[data-kind="danger"] { color: var(--dsw-alias-state-error-primary, #d54941); }
.dim-panel .dim-qrLayout { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: var(--dim-gap-34); align-items: start; }
.dim-panel .dim-qrColumn { width: 100%; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: var(--dim-gap-12); }
.dim-panel .dim-qrFrame { position: relative; width: min(270px, 100%); height: auto; aspect-ratio: 1; display: grid; place-items: center; overflow: hidden; padding: 10px; border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); border-radius: var(--dim-radius-16); background: #fff; }
.dim-panel .dim-qrFrame::before { display: none; }
.dim-panel .dim-qrFrame::after { display: none; }
.dim-panel .dim-qrFrame img { position: relative; z-index: 1; width: 100%; height: 100%; display: block; object-fit: contain; }
.dim-panel .dim-qrFallback { position: relative; z-index: 1; display: grid; place-items: center; gap: var(--dim-gap-8); color: var(--dim-on-qr-muted, #646a73); font-size: var(--dim-font-14); line-height: var(--dim-line-14); text-align: center; }
.dim-panel .dim-qrExpired { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; padding: 20px; color: var(--dsw-static-neutral-bluish-1000, #0f1115); background: rgb(255 255 255 / 92%); font-size: var(--dim-font-15); line-height: 1.6; font-weight: var(--dim-weight-600); text-align: center; white-space: pre-line; backdrop-filter: blur(3px); }
.dim-panel .dim-countdown { width: min(270px, 100%); margin: 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-panel .dim-countdownTop { display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-12); margin-bottom: 6px; }
.dim-panel .dim-countdownTop strong { color: var(--dsw-alias-label-primary, #0f1115); font-weight: var(--dim-weight-600); }
.dim-panel .dim-progress { height: 4px; overflow: hidden; margin: 0; border-radius: var(--dim-radius-full); background: var(--dsw-alias-bg-module-platform, #f5f6f7); }
.dim-panel .dim-progress span { display: block; width: var(--bxf-progress, var(--dxw-progress, var(--ddt-progress, 0%))); height: 100%; border-radius: inherit; background: var(--dsw-alias-state-business-primary, #4176e6); transition: width .25s linear; }
.dim-panel .dim-qrCopy { min-width: 0; overflow-wrap: anywhere; }
.dim-panel .dim-qrCopy h3 { margin: 9px 0 8px; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-18); line-height: 1.35; font-weight: var(--dim-weight-600); }
.dim-panel .dim-qrCopy > p { margin: 0; color: var(--dsw-alias-label-secondary, #646a73); line-height: 1.65; }
.dim-panel .dim-steps { margin: 18px 0 16px; padding: 0; list-style: none; counter-reset: dim-step; }
.dim-panel .dim-steps li { position: relative; min-height: 28px; display: flex; align-items: center; padding: 5px 0 5px 36px; color: var(--dsw-alias-label-secondary, #646a73); line-height: 1.5; counter-increment: dim-step; }
.dim-panel .dim-steps li::before { content: counter(dim-step); position: absolute; left: 0; top: 4px; width: 24px; height: 24px; display: grid; place-items: center; border-radius: var(--dim-radius-12); color: var(--dsw-alias-state-business-primary, #4176e6); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 10%, transparent); font-size: var(--dim-font-12); font-weight: var(--dim-weight-500); }
.dim-panel .dim-specialView { padding: 32px; text-align: center; }
.dim-panel .dim-statusNotice { display: flex; align-items: flex-start; gap: var(--dim-gap-10); padding: 13px 15px; border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 22%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); border-radius: var(--dim-radius-10); color: var(--dsw-alias-state-error-primary, #d54941); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 8%, var(--dsw-alias-bg-layer-1, #fff)); font-size: var(--dim-font-14); line-height: var(--dim-line-14); }
.dim-panel .dim-inlineError { display: flex; align-items: flex-start; flex-direction: column; gap: var(--dim-gap-10); padding: 22px; color: var(--dsw-alias-state-error-primary, #d54941); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 8%, var(--dsw-alias-bg-layer-1, #fff)); }
.dim-panel .dim-inlineError > div { min-width: 0; }
.dim-panel .dim-inlineError h3 { margin: 0; color: inherit; font-size: var(--dim-font-16); line-height: var(--dim-line-16); font-weight: var(--dim-weight-600); overflow-wrap: anywhere; }
.dim-panel .dim-inlineError p { margin: 7px 0 0; color: inherit; line-height: 1.6; overflow-wrap: anywhere; }
.dim-panel .dim-confirm { padding: 18px 24px; border-top: 0.5px solid var(--dsw-alias-border-l1, #eef0f3); background: var(--dim-hover); }
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
.dim-panel .dim-workspacePath { min-width: 0; max-width: 100%; grid-column: 1 / -1; grid-row: 2; display: block; overflow: hidden; color: var(--dsw-alias-label-secondary, #646a73); font: 12px/18px var(--dim-font-mono, monospace); overflow-wrap: anywhere; white-space: normal; }
/* Agent Preset is a saved value, so it takes the plugin's stacked-field form
   (.dim-credentialField): label above, field below, full width. As a settings ROW the
   select was capped at max-width: 60%, which truncated the longer preset labels - the
   one thing a preset picker has to keep readable. */
.dim-panel .dim-preset { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); align-content: start; gap: var(--dim-gap-6); margin: 0; padding: 16px 0; border: 0; background: none; }
.dim-panel .dim-preset > .dim-helpHint { flex: 1 1 100%; }
.dim-panel .dim-presetHeader { position: relative; min-width: 0; display: flex; align-items: center; gap: var(--dim-gap-8); color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-14); line-height: var(--dim-line-14); font-weight: var(--dim-weight-500); }
.dim-panel .dim-presetTitle { min-width: 0; display: inline-flex; align-items: center; gap: var(--dim-gap-8); white-space: nowrap; }
.dim-panel .dim-presetHelp { display: inline-flex; align-items: center; flex: none; }
.dim-panel .dim-presetHelpButton { width: 16px; height: 16px; display: grid; place-items: center; padding: 0; border: none; border-radius: 50%; corner-shape: round; color: var(--dsw-alias-label-tertiary, #81858c); background: transparent; font: inherit; font-size: var(--dim-font-11); line-height: 1; font-weight: var(--dim-weight-500); cursor: help; transition: color .15s ease, background .15s ease; }
.dim-panel .dim-presetHelpButton:hover { color: var(--dsw-alias-label-primary, #0f1115); background: var(--dim-hover); }
.dim-panel .dim-presetHelpButton:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); }
.dim-panel .dim-presetTooltip { position: absolute; top: calc(100% + 7px); left: 0; z-index: var(--dim-z-tooltip); width: min(320px, 100%); overflow-wrap: anywhere; white-space: normal; opacity: 0; visibility: hidden; transform: translateY(-3px); pointer-events: none; transition: opacity .15s ease, transform .15s ease, visibility .15s ease; }
.dim-panel .dim-presetHelp:hover .dim-presetTooltip, .dim-panel .dim-presetHelp:focus-within .dim-presetTooltip { opacity: 1; visibility: visible; transform: translateY(0); }
.dim-panel .dim-presetStatus { flex: none; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); white-space: nowrap; }
.dim-panel .dim-presetSelect { width: 100%; min-width: 0; height: 32px; padding: 0 10px; border: var(--dim-field-border); border-radius: var(--dim-field-radius); color: var(--dsw-alias-label-primary, #0f1115); background-color: var(--dsw-alias-bg-layer-1, #fff); appearance: none; font: inherit; font-size: var(--dim-font-14); line-height: var(--dim-line-14); cursor: pointer; transition: border-color .16s ease; }
.dim-panel .dim-presetSelect:focus { outline: none; border-color: var(--dim-focus); }
.dim-panel .dim-presetSelect:disabled { cursor: not-allowed; opacity: 0.4; }
.dim-panel .dim-modelSetting { display: block; padding: 16px 0; }
.dim-modelSetting > .dim-presetHeader { padding: 0 0 8px; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); font-weight: var(--dim-weight-500); }
/* Native "Setting-Cell" cell: 14/22 label on the left, control hard right. */
.dim-modelRow { display: flex; align-items: center; gap: var(--dim-gap-8); width: 100%; min-height: 36px; padding: 0; border: 0; background: transparent; color: var(--dsw-alias-label-primary, #0f1115); font: inherit; font-size: var(--dim-font-14); line-height: var(--dim-line-14); text-align: left; cursor: pointer; }
.dim-modelRowLabel { flex: 1; min-width: 0; }
/* Native selector pill (LanguageRow .selector): h36 r18, module fill, gap 12. */
.dim-modelSelector { flex: none; max-width: 60%; display: inline-flex; align-items: center; gap: var(--dim-gap-12); height: 36px; padding: 0 14px; border-radius: var(--dim-radius-18); background: var(--dim-module-fill); }
.dim-modelValue { min-width: 0; overflow: hidden; color: var(--dsw-alias-label-primary, #0f1115); text-overflow: ellipsis; white-space: nowrap; }
.dim-modelChevron { flex: none; color: var(--dsw-alias-label-tertiary, #81858c); }
.dim-modelRow:hover:not(:disabled) .dim-modelSelector, .dim-modelOption:hover:not(:disabled) { background: var(--dim-hover); }
.dim-modelRow:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-border-l3, rgb(0 0 0 / 12%)); }
.dim-modelOption:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #0f1115); outline-offset: -2px; }
/* Native keeps a disabled selector's surface and dims what it says, rather
   than fading the whole row (PermissionRow.module.css:54-56 keeps the pill's
   contrast; FontSizeRow.module.css:110-113 dims the glyph). */
.dim-modelRow:disabled { cursor: default; }
.dim-modelRow:disabled .dim-modelValue { color: var(--dsw-alias-label-tertiary, #81858c); }
.dim-modelOption:disabled { opacity: 0.4; cursor: default; }
/* In-flow lists avoid clipping by collapsed-card and settings scroll containers. */
.dim-modelMenu { max-height: 280px; overflow-y: auto; margin: 4px; padding: 4px; border: 0; border-radius: var(--dim-radius-20); background: var(--dsw-specific-menu, #fff); --dsw-elevation-stroke-color: var(--dsw-alias-border-l1, rgb(0 0 0 / 4%)); box-shadow: var(--dsw-elevation-prominent, 0 0 0 .5px rgb(0 0 0 / 16%), 0 3px 8px rgb(0 0 0 / 4%), 0 0 20px rgb(0 0 0 / 5%)); color: var(--dsw-alias-label-primary, #0f1115); scrollbar-width: thin; }
.dim-modelGroupTitle { padding: 7px 8px 3px; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); font-weight: var(--dim-weight-500); }
.dim-modelOption { display: flex; align-items: center; gap: var(--dim-gap-8); width: 100%; min-height: 40px; padding: 8px 10px; border: none; border-radius: var(--dim-radius-10); background: transparent; color: inherit; text-align: left; font: inherit; font-size: var(--dim-font-14); line-height: var(--dim-line-14); cursor: pointer; }
.dim-modelOptionCopy { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: var(--dim-gap-2); }
.dim-modelOptionName { font-size: var(--dim-font-14); line-height: var(--dim-line-14); font-weight: var(--dim-weight-500); overflow-wrap: anywhere; }
.dim-modelDescription { color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); overflow-wrap: anywhere; }
.dim-modelCheck { flex: 0 0 18px; text-align: center; }
.dim-modelHint, .dim-helpHint { margin: 6px 0 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-panel .dim-presetError { margin: 6px 0 0; color: var(--dim-danger); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-contextEntry { width: 100%; min-height: 40px; display: grid; grid-template-columns: 16px minmax(0, 1fr) max-content; align-items: center; gap: var(--dim-gap-9); margin: 0; padding: 14px 0; border: 0; border-radius: 0; color: var(--dsw-alias-label-primary, #0f1115); background: none; font: inherit; font-size: var(--dim-font-14); line-height: var(--dim-line-14); text-align: left; cursor: pointer; }
.dim-contextEntry:hover:not(:disabled) { background: none; color: var(--dsw-alias-state-business-primary, #4176e6); }
.dim-contextEntry > svg { color: var(--dsw-alias-label-secondary, #646a73); }
.dim-contextLabel { min-width: 0; overflow-wrap: anywhere; }
.dim-contextStatus { height: 24px; display: inline-flex; align-items: center; padding: 0 8px; border-radius: var(--dim-radius-12); color: var(--dsw-alias-label-secondary, #646a73); background: var(--dim-module-fill); font-size: var(--dim-font-12); line-height: var(--dim-line-12); font-weight: var(--dim-weight-400); white-space: nowrap; }
.dim-contextStatus[data-active="true"] { color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-alias-button-ghost-active-fill, #ebeeF2); box-shadow: inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border, #979da6); }
.dim-contextBackdrop { position: fixed; inset: 0; z-index: var(--dim-z-portal); display: grid; place-items: center; padding: 12px; background: var(--dsw-alias-bg-mask-1, rgb(0 0 0 / 24%)); backdrop-filter: var(--dsw-mask-blur, blur(2px)); }
.dim-contextBackdrop, .dim-contextBackdrop *, .dim-contextBackdrop *::before, .dim-contextBackdrop *::after { box-sizing: border-box; }
/* Three rows: a fixed header, a scrolling body, a fixed footer. The card used to be
   the only scroll region, so in a short viewport the tab strip that names the scope
   and the primary action both scrolled off the bottom edge. The plugin's own
   directory picker already uses this shape. */
.dim-contextDialog { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; width: min(450px, 100%); min-width: 0; max-height: calc(100vh - 24px); max-height: calc(100dvh - 24px); overflow-y: auto; padding: 16px; border: 0; border-radius: var(--dim-radius-24); background: var(--dsw-alias-bg-layer-2, #fff); box-shadow: var(--dsw-elevation-prominent, 0 0 0 .5px rgb(0 0 0 / 16%), 0 3px 8px rgb(0 0 0 / 4%), 0 0 20px rgb(0 0 0 / 5%)); color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-14); line-height: var(--dim-line-14); text-align: left; }
.dim-contextDialog:focus { outline: none; }
.dim-contextHeader, .dim-contextEditorHeader { display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-8); }
.dim-contextHeader { position: relative; align-items: flex-start; }
/* The description is a paragraph, not a peer of the title: side by side the
   inline-flex squeezed the h3 into a 92px column and wrapped it. */
.dim-contextHeaderTitle { min-width: 0; display: grid; justify-items: start; gap: 3px; }
.dim-contextHeader h3 { margin: 0; font-size: var(--dim-font-15); line-height: 22px; font-weight: var(--dim-weight-500); }
.dim-contextHeaderTooltip { width: min(340px, calc(100vw - 72px)); }
.dim-contextClose { width: 28px; height: 28px; flex: none; display: grid; place-items: center; padding: 0; border: none; border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-secondary, #646a73); background: transparent; cursor: pointer; }
.dim-contextClose:hover:not(:disabled) { background: var(--dim-hover); }
.dim-contextTabs { display: flex; gap: var(--dim-gap-20); margin-top: 12px; border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); }
/* The negative margin lets the scrollbar sit on the card edge while the content keeps
   the card's 16px inset. */
.dim-contextBody { min-height: 0; overflow-y: auto; margin: 0 -16px; padding: 0 16px; scrollbar-width: thin; }
.dim-contextTab { position: relative; min-width: 0; min-height: 32px; display: inline-flex; align-items: center; justify-content: center; padding: 6px 2px; border: none; border-radius: 0; color: var(--dsw-alias-label-secondary, #646a73); background: transparent; font: inherit; font-size: var(--dim-font-13); line-height: var(--dim-line-13); font-weight: var(--dim-weight-500); cursor: pointer; transition: color .15s ease; }
.dim-contextTab:hover:not(:disabled):not([aria-selected="true"]) { color: var(--dsw-alias-label-primary, #0f1115); }
.dim-contextTab[aria-selected="true"] { color: var(--dsw-alias-label-primary, #0f1115); }
.dim-contextTab::after { content: ''; position: absolute; right: 0; bottom: -1px; left: 0; height: 2px; border-radius: var(--dim-radius-indicator); background: transparent; transition: background .15s ease; }
.dim-contextTab[aria-selected="true"]::after { background: var(--dsw-alias-label-primary, #0f1115); }
.dim-contextTabPanel[hidden] { display: none; }
.dim-contextSection { min-width: 0; margin: 0; padding: 0; border: 0; }
.dim-contextScope { margin-top: 12px; padding: 12px 14px; border: 0; border-radius: var(--dim-radius-12); background: var(--dim-module-fill); }
.dim-contextScopeBlock { margin-top: 12px; }
.dim-contextLegend { position: relative; display: grid; justify-items: start; gap: 3px; }
.dim-contextSwitchRow { display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-8); min-height: 34px; cursor: pointer; }
.dim-contextSwitchLabel { min-width: 0; display: inline-flex; align-items: baseline; gap: var(--dim-gap-5); flex-wrap: wrap; }
.dim-contextUnavailable { color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-11); line-height: 16px; font-weight: var(--dim-weight-400); }
.dim-contextSwitch { appearance: none; flex: none; width: 36px; height: 20px; margin: 0; padding: 0; border: none; border-radius: var(--dim-radius-10); corner-shape: round; background: var(--dsw-alias-border-l3, rgb(0 0 0 / 12%)); cursor: pointer; transition: background .12s ease; }
.dim-contextSwitch::before { content: ""; display: block; width: 16px; height: 16px; margin: 2px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-label-primary-foreground, #fff); transition: transform .12s ease; }
.dim-contextSwitch:checked { background: var(--dsw-alias-brand-primary, #0f1115); }
.dim-contextSwitch:checked::before { transform: translateX(16px); }
.dim-contextFields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--dim-gap-3) 12px; }
/* align-items: center centred the checkbox against the whole hint block, so a
   long hint pushed the control 57-81px below the label it belongs to. */
.dim-contextField { position: relative; min-width: 0; min-height: 30px; display: flex; align-items: flex-start; gap: var(--dim-gap-6); }
.dim-contextField input { flex: none; width: 14px; height: 14px; margin: 2px 0 0; accent-color: var(--dsw-alias-state-business-primary, #4176e6); }
.dim-contextFieldText { min-width: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: center; column-gap: var(--dim-gap-5); overflow-wrap: anywhere; }
.dim-contextFieldName { min-width: 0; line-height: 17px; cursor: pointer; }
.dim-contextFieldHint { grid-column: 1 / -1; margin: 2px 0 0; font-size: var(--dim-font-11); line-height: 16px; }
.dim-contextFieldKey { min-width: 0; grid-column: 1 / -1; color: var(--dsw-alias-label-tertiary, #81858c); font: 11px/16px var(--dim-font-mono, monospace); overflow-wrap: anywhere; cursor: pointer; }
.dim-contextFieldHelp { position: static; }
.dim-contextTooltip.dim-contextFieldTooltip { top: calc(100% + 6px); right: 0; left: auto; width: min(280px, calc(100vw - 72px)); }
.dim-contextField:nth-child(odd) .dim-contextFieldTooltip { right: auto; left: 0; }
.dim-contextEditorHeader { position: relative; flex-wrap: wrap; }
.dim-contextEditorTitle { min-width: 0; display: inline-flex; align-items: center; gap: var(--dim-gap-6); }
.dim-contextEditorTitle > label { font-weight: var(--dim-weight-500); }
.dim-contextHelp { display: inline-flex; align-items: center; flex: none; }
.dim-contextHelpButton { width: 16px; height: 16px; display: grid; place-items: center; padding: 0; border: none; border-radius: 50%; corner-shape: round; color: var(--dsw-alias-label-tertiary, #81858c); background: transparent; font: inherit; font-size: var(--dim-font-11); line-height: 1; font-weight: var(--dim-weight-500); cursor: help; transition: color .15s ease, background .15s ease; }
.dim-contextHelpButton:hover:not(:disabled) { color: var(--dsw-alias-label-primary, #0f1115); background: var(--dim-hover); }
.dim-contextTooltip { position: absolute; top: calc(100% + 7px); left: 0; z-index: var(--dim-z-tooltip); width: min(330px, calc(100vw - 72px)); display: grid; gap: var(--dim-gap-5); overflow-wrap: anywhere; white-space: normal; opacity: 0; visibility: hidden; transform: translateY(-3px); pointer-events: none; transition: opacity .15s ease, transform .15s ease, visibility .15s ease; }
.dim-contextTooltip strong { font-weight: var(--dim-weight-600); }
.dim-contextTooltipExample { padding: 7px 8px; border-radius: var(--dim-radius-8); background: var(--dsw-alias-bg-module-platform, #f5f6f7); font-family: var(--dim-font-mono, monospace); white-space: pre-wrap; }
.dim-contextTooltip.dim-contextLegendTooltip { width: min(350px, calc(100vw - 72px)); }
.dim-contextTooltip.dim-contextGuidanceTooltip { top: auto; bottom: calc(100% + 7px); width: min(380px, calc(100vw - 72px)); max-height: calc(100dvh - 48px); overflow-y: auto; }
.dim-contextHelp:hover .dim-contextTooltip, .dim-contextHelp:focus-within .dim-contextTooltip { opacity: 1; visibility: visible; transform: translateY(0); pointer-events: auto; }
.dim-contextTextActions { display: flex; gap: var(--dim-gap-10); margin-left: auto; }
.dim-contextTextActions button { min-height: 30px; padding: 4px 0; border: 0; border-radius: var(--dim-radius-8); color: var(--dsw-alias-state-business-primary, #4176e6); background: transparent; font: inherit; font-size: var(--dim-font-12); cursor: pointer; }
.dim-contextTextActions button:hover:not(:disabled) { text-decoration: underline; }
.dim-contextGuidance textarea { display: block; width: 100%; min-height: 88px; margin-top: 6px; padding: 8px 12px; resize: vertical; border: var(--dim-field-border); border-radius: var(--dim-field-radius); color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; font-size: var(--dim-font-14); line-height: var(--dim-line-14); }
.dim-contextGuidance textarea::placeholder { color: var(--dsw-alias-label-caption, #adb2b8); opacity: 1; }
.dim-contextHint { margin: 5px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-11); line-height: 1.5; overflow-wrap: anywhere; }
.dim-contextError { margin: 12px 0 0; color: var(--dsw-alias-state-error-primary, #d54941); font-size: var(--dim-font-12); line-height: var(--dim-line-12); overflow-wrap: anywhere; }
.dim-contextFooter { display: flex; justify-content: flex-end; gap: var(--dim-gap-8); margin-top: 0; padding-top: 16px; border-top: 0.5px solid var(--dsw-alias-border-l1, #eef0f3); }
.dim-contextFooter button { height: 28px; display: inline-flex; align-items: center; justify-content: center; padding: 0 10px; border: var(--dim-control-border); border-radius: var(--dim-radius-14); color: var(--dsw-alias-label-primary, #0f1115); background: transparent; font: inherit; font-size: var(--dim-font-12); line-height: var(--dim-line-12); white-space: nowrap; cursor: pointer; }
.dim-contextFooter button:hover:not(:disabled) { background: var(--dim-hover); }
.dim-contextFooter .dim-contextSave, .dim-contextFooter .dim-contextSave:hover:not(:disabled) { border-color: var(--dsw-alias-state-business-primary, #4176e6); color: var(--dim-action-on-fill, #fff); background: var(--dsw-alias-state-business-primary, #4176e6); }
.dim-contextEntry:focus-visible, .dim-contextDialog button:focus-visible, .dim-contextDialog input:focus-visible, .dim-contextDialog textarea:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); outline-offset: 2px; }
.dim-contextEntry:disabled, .dim-contextDialog button:disabled, .dim-contextDialog input:disabled, .dim-contextDialog textarea:disabled { opacity: 0.4; cursor: not-allowed; }
@media (pointer: coarse) {
  .dim-contextEntry, .dim-contextTab, .dim-contextClose, .dim-contextFooter button, .dim-contextTextActions button, .dim-contextField, .dim-contextSwitchRow { min-height: 44px; }
  .dim-contextClose, .dim-contextTextActions button { min-width: 44px; }
  .dim-contextGuidance textarea { font-size: var(--dim-font-16); }
}
/* No local token rebinds: the picker is portalled, but the token layer lives on
   :root now, so it inherits them like any other surface. */
.dim-directoryPickerBackdrop { position: fixed; inset: 0; z-index: var(--dim-z-portal); display: grid; place-items: center; padding: 24px; background: var(--dsw-alias-bg-mask-1, rgb(0 0 0 / 24%)); backdrop-filter: var(--dsw-mask-blur, blur(2px)); }
.dim-directoryPickerBackdrop, .dim-directoryPickerBackdrop *, .dim-directoryPickerBackdrop *::before, .dim-directoryPickerBackdrop *::after { box-sizing: border-box; }
.dim-directoryPicker { width: min(720px, 100%); height: min(620px, calc(100vh - 48px)); min-height: 420px; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; overflow: hidden; border: 0; border-radius: var(--dim-radius-24); background: var(--dsw-alias-bg-layer-2, #fff); box-shadow: var(--dsw-elevation-prominent, 0 0 0 .5px rgb(0 0 0 / 16%), 0 3px 8px rgb(0 0 0 / 4%), 0 0 20px rgb(0 0 0 / 5%)); outline: none; color: var(--dsw-alias-label-primary, #0f1115); }
.dim-directoryPickerHeader { min-width: 0; padding: 22px 24px 17px; border-bottom: 0.5px solid var(--dsw-alias-border-l1, #eef0f3); }
.dim-directoryPickerHeader h3 { margin: 0 0 14px; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-20); line-height: var(--dim-line-20); font-weight: var(--dim-weight-600); }
.dim-directoryPickerHeader > p { margin: 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-13); }
.dim-directoryCrumbs { min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: var(--dim-gap-4); color: var(--dsw-alias-label-tertiary, #81858c); }
.dim-directoryCrumbs button { max-width: 210px; overflow: hidden; padding: 3px 5px; border: 0; border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-secondary, #646a73); background: transparent; font: inherit; font-size: var(--dim-font-12); line-height: var(--dim-line-12); text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.dim-directoryCrumbs button:hover:not(:disabled) { color: var(--dim-blue); background: var(--dim-blue-soft); }
.dim-directoryCrumbs button[aria-current="page"] { color: var(--dsw-alias-label-primary, #0f1115); font-weight: var(--dim-weight-600); }
.dim-directoryCrumbs button:focus-visible, .dim-directoryPathInput:focus-visible, .dim-directoryPathControl button:focus-visible, .dim-directoryList button:focus-visible, .dim-directoryPickerActions button:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); outline-offset: 1px; }
.dim-directoryCrumbSeparator { flex: none; font-size: var(--dim-font-12); }
.dim-directoryPathForm { display: grid; gap: var(--dim-gap-7); margin-top: 14px; }
.dim-directoryPathMeta { min-width: 0; display: flex; align-items: baseline; justify-content: space-between; gap: var(--dim-gap-12); }
.dim-directoryPathMeta label { flex: none; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); font-weight: var(--dim-weight-600); }
.dim-directoryPathMeta span { min-width: 0; overflow: hidden; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-11); text-overflow: ellipsis; white-space: nowrap; }
.dim-directoryPathControl { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) max-content; gap: var(--dim-gap-8); }
.dim-directoryPathInput { min-width: 0; height: 32px; padding: 0 10px; border: var(--dim-field-border); border-radius: var(--dim-field-radius); color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-alias-bg-layer-1, #fff); font: 12px/1.5 var(--dim-font-mono, monospace); }
.dim-directoryPathInput::placeholder { color: var(--dsw-alias-label-caption, #adb2b8); }

.dim-directoryPathInput:focus { outline: none; border-color: var(--dim-focus); }
.dim-directoryPathInput[aria-invalid="true"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 62%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); }
.dim-directoryPathControl button { min-height: 38px; padding: 0 14px; border: 0.5px solid color-mix(in srgb, var(--dim-blue) 30%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); border-radius: var(--dim-radius-8); color: var(--dim-blue); background: var(--dim-blue-soft); font: inherit; font-size: var(--dim-font-13); font-weight: var(--dim-weight-600); cursor: pointer; }
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
.dim-directoryPickerError { display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-12); margin: 8px 0 0; padding: 10px 12px; border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 22%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); border-radius: var(--dim-radius-8); color: var(--dsw-alias-state-error-primary, #d54941); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 7%, var(--dsw-alias-bg-layer-1, #fff)); font-size: var(--dim-font-12); line-height: var(--dim-line-12); overflow-wrap: anywhere; }
.dim-directoryPickerError button { flex: none; padding: 4px 8px; border: 0; border-radius: var(--dim-radius-8); color: inherit; background: transparent; font: inherit; font-weight: var(--dim-weight-600); cursor: pointer; }
.dim-directoryPickerTruncated { margin: 10px 4px 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-directoryPickerFooter { display: grid; grid-template-columns: max-content minmax(0, 1fr) max-content; align-items: center; gap: var(--dim-gap-14); padding: 16px 20px; border-top: 0.5px solid var(--dsw-alias-border-l1, #eef0f3); background: var(--dsw-alias-bg-layer-1, #fff); }
.dim-directoryHidden { display: inline-flex; align-items: center; gap: var(--dim-gap-7); padding: 2px 0; border: 0; color: var(--dsw-alias-label-secondary, #646a73); background: transparent; font: inherit; font-size: var(--dim-font-12); white-space: nowrap; cursor: pointer; }
.dim-directoryHidden:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); outline-offset: 2px; }
.dim-directoryHidden:disabled { cursor: not-allowed; opacity: 0.4; }
.dim-directoryHiddenBox { position: relative; width: 15px; height: 15px; flex: 0 0 15px; border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); border-radius: var(--dim-radius-3); background: var(--dsw-alias-bg-layer-1, #fff); }
.dim-directoryHidden[aria-pressed="true"] .dim-directoryHiddenBox { border-color: var(--dim-blue); background: var(--dim-blue); }
.dim-directoryHidden[aria-pressed="true"] .dim-directoryHiddenBox::after { content: ""; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px; border: solid white; border-width: 0 2px 2px 0; transform: rotate(45deg); }
.dim-directoryPickerNotice { min-width: 0; margin: 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-11); line-height: 1.45; text-align: right; }
.dim-directoryPickerActions { display: flex; gap: var(--dim-gap-8); }
.dim-directoryPickerActions button { height: 28px; display: inline-flex; align-items: center; justify-content: center; padding: 0 10px; border: var(--dim-control-border); border-radius: var(--dim-radius-14); color: var(--dsw-alias-label-primary, #0f1115); background: transparent; font: inherit; font-size: var(--dim-font-12); line-height: var(--dim-line-12); white-space: nowrap; cursor: pointer; }
.dim-directoryPickerActions .dim-directoryPickerPrimary { border-color: var(--dsw-alias-border-l3, rgb(0 0 0 / 12%)); color: var(--dsw-alias-label-primary, #0f1115); background: transparent; }
.dim-directoryPickerActions button:hover:not(:disabled) { filter: brightness(.97); }
.dim-directoryPickerActions button:disabled { cursor: not-allowed; opacity: 0.4; }
.dim-panel .dim-cardSummary { min-width: 0; color: var(--dsw-alias-label-secondary, #646a73); font: inherit; font-size: var(--dim-font-12); font-weight: var(--dim-weight-400); line-height: var(--dim-line-12); overflow-wrap: anywhere; white-space: normal; }
.dim-panel .dim-cardFooterLayout { min-width: 0; width: 100%; display: flex; flex-direction: column; align-items: stretch; gap: var(--dim-gap-8); }
.dim-panel .dim-cardFooterLayout > .dim-cardActions { align-self: stretch; }
.dim-panel .dim-cardFeedback { width: 100%; padding: 8px 10px; border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-bg-module-platform, #f5f6f7); font: inherit; font-size: var(--dim-font-12); font-weight: var(--dim-weight-400); line-height: var(--dim-line-12); overflow-wrap: anywhere; white-space: normal; }
.dim-panel .dim-cardActions { flex: none; width: 100%; display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: var(--dim-gap-8); margin: 0; }
.dim-panel .dim-cardActions .dim-cardAction { flex: none; height: 28px; display: inline-flex; align-items: center; justify-content: center; padding: 0 10px; border: var(--dim-control-border); border-radius: var(--dim-radius-14); color: var(--dsw-alias-label-primary, #0f1115); background: transparent; font: inherit; font-size: var(--dim-font-12); line-height: var(--dim-line-12); white-space: nowrap; cursor: pointer; }
.dim-panel .dim-cardActions .dim-cardAction:hover:not(:disabled) { background: var(--dim-hover-solid); }
.dim-panel .dim-cardActions .dim-cardAction[data-kind="danger"] { border-color: transparent; color: var(--dim-danger); }
.dim-panel .dim-cardActions .dim-cardAction[data-kind="danger"]:hover:not(:disabled) { background: var(--dim-danger-hover); }
/* Header tooltips may extend beyond the card; the collapsible body clips its own content. */
.dim-panel .dim-botCard { position: relative; min-width: 0; width: 100%; max-width: 100%; overflow: visible; border: 0.5px solid var(--dsw-alias-border-l4, rgb(0 0 0 / 16%)); border-radius: var(--dim-radius-16); background: none; transition: border-color .16s ease; }
.dim-panel .dim-botCard:hover { border-color: var(--dsw-alias-label-dimmed, #e1e5ee); }
.dim-panel .dim-botCard::before { display: none; }
.dim-panel .dim-botCardBody { position: relative; min-width: 0; width: 100%; max-width: 100%; padding: 0 16px; }
/* Hierarchy alternates instead of stacking: the card carries the only outline, and
   every group inside it is a bare row separated by a 0.5px hairline. Nesting a
   second border and fill inside the card is what made one expanded account show
   seven competing boxes. */
.dim-collapsibleHead { padding: 16px 0; }
.dim-collapsibleBodyInner > * + * { border-top: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); }
.dim-collapsibleBodyInner > .dim-cardFooter { border-top: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); }
.dim-collapsibleAccount { min-width: 0; display: flex; flex-direction: column; }
.dim-collapsibleHead { min-width: 0; display: flex; align-items: center; gap: var(--dim-gap-4); cursor: pointer; user-select: none; -webkit-user-select: none; }
.dim-collapsibleHead:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); outline-offset: 2px; border-radius: var(--dim-radius-8); }
.dim-collapsibleHeaderContent { min-width: 0; flex: 1 1 auto; display: flex; align-items: center; }
.dim-collapsibleChevron { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; color: var(--dsw-alias-label-tertiary, #81858c); transition: transform var(--dim-disclosure-duration) var(--dim-disclosure-ease); transform-origin: 50% 50%; }
.dim-collapsibleChevron svg { display: block; }
.dim-collapsibleAccount.is-open .dim-collapsibleChevron { transform: rotate(90deg); }
/* Animate height without measuring content; hide collapsed controls from focus and accessibility. */
.dim-collapsibleBody { display: grid; grid-template-rows: 0fr; transition: grid-template-rows var(--dim-disclosure-duration) var(--dim-disclosure-ease); }
.dim-collapsibleAccount.is-open > .dim-collapsibleBody { grid-template-rows: 1fr; }
/* clip rather than hidden, plus a clip margin: the collapse animation still
   needs the box clipped, but hidden also swallowed the 2px focus ring of every
   control inside, leaving those rows with no visible focus at all. The margin
   lets the ring paint; browsers without overflow-clip-margin fall back to the
   old behaviour rather than to something worse. */
.dim-collapsibleBodyInner { min-height: 0; overflow: clip; overflow-clip-margin: 4px; }
.dim-collapsibleAccount:not(.is-open) .dim-collapsibleBodyInner { visibility: hidden; }
/* Reclaim horizontal spacing for names while keeping status on the same row,
   including when a channel's mobile stylesheet requests a column layout. */
.dim-panel .dim-botCardTop { min-width: 0; width: 100%; max-width: 100%; display: flex; flex-direction: row; flex-wrap: nowrap; align-items: flex-start; justify-content: space-between; gap: var(--dim-gap-6); }
.dim-panel .dim-botIdentity { min-width: 0; flex: 1 1 0; display: flex; align-items: center; gap: var(--dim-gap-6); }
.dim-panel .dim-botAvatar { flex: none; width: 38px; height: 38px; display: grid; place-items: center; overflow: hidden; border-radius: var(--dim-radius-12); box-shadow: none; }
.dim-panel .dim-botAvatar svg { width: 27px; height: 27px; }
.dim-panel .dim-botName { min-width: 0; flex: 1; }
.dim-panel .dim-aliasName { gap: var(--dim-gap-2); }
.dim-panel .dim-botName h3 { overflow: hidden; margin: 0; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-15); font-weight: var(--dim-weight-600); line-height: normal; text-overflow: ellipsis; white-space: nowrap; }
.dim-panel .dim-botName p { overflow: hidden; margin: 4px 0 0; color: var(--dsw-alias-label-tertiary, #81858c); font: 12px/18px var(--dim-font-mono, monospace); text-overflow: ellipsis; white-space: nowrap; }
.dim-panel .dim-botCardTools { flex: none; display: flex; align-items: center; gap: var(--dim-gap-4); }
.dim-panel .dim-botHealthGroup { min-width: 0; max-width: min(100%, 260px); flex: none; display: grid; justify-items: end; gap: var(--dim-gap-2); text-align: right; }
.dim-panel .dim-botCard .dim-botHealth { flex: none; min-height: 0; display: inline-flex; align-items: center; gap: var(--dim-gap-7); padding: 0; border: 0; border-radius: 0; color: var(--dsw-alias-label-secondary, #646a73); background: transparent; font: inherit; font-size: var(--dim-font-12); font-weight: var(--dim-weight-400); line-height: var(--dim-line-12); white-space: nowrap; }
.dim-panel .dim-lastChecked { max-width: 100%; overflow: hidden; text-overflow: ellipsis; display: inline-flex; align-items: baseline; gap: var(--dim-gap-4); color: var(--dsw-alias-label-tertiary, #81858c); font: inherit; font-size: var(--dim-font-12); font-weight: var(--dim-weight-400); line-height: var(--dim-line-12); white-space: nowrap; }
.dim-panel .dim-botCard .dim-healthDot { flex: none; width: 8px; height: 8px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-label-tertiary, #81858c); box-shadow: none; }
.dim-panel .dim-botCard .dim-healthDot[data-tone="success"] { background: var(--dsw-alias-state-success-primary, #22c55e); }
.dim-panel .dim-botCard .dim-healthDot[data-tone="warning"] { background: var(--dsw-alias-state-warn-primary, #f59e0b); }
.dim-panel .dim-botCard .dim-healthDot[data-tone="error"] { background: var(--dim-danger); }
.dim-botSettingsAction { position: relative; flex: none; display: inline-flex; }
.dim-botSettingsButton { width: 32px; height: 32px; display: grid; place-items: center; padding: 0; border: 0; border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-secondary, #646a73); background: transparent; cursor: pointer; transition: color .15s ease, background .15s ease; }
.dim-botSettingsButton:hover { color: var(--dsw-alias-label-primary, #0f1115); background: var(--dim-hover); }
.dim-botSettingsButton:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); outline-offset: 2px; }
.dim-botSettingsTooltip { position: absolute; top: calc(100% + 6px); right: 0; z-index: var(--dim-z-tooltip); width: max-content; opacity: 0; visibility: hidden; transform: translateY(-3px); pointer-events: none; transition: opacity .15s ease, transform .15s ease, visibility .15s ease; }
.dim-botSettingsAction:hover .dim-botSettingsTooltip, .dim-botSettingsAction:focus-within .dim-botSettingsTooltip { opacity: 1; visibility: visible; transform: translateY(0); }
.dim-deliveryPage { min-width: 0; display: grid; }
.dim-deliveryHeader { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-16); }
.dim-botSettingsTabsBar { min-width: 0; margin-top: 10px; border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); }
.dim-botSettingsTabs { min-width: 0; display: flex; align-items: flex-end; gap: var(--dim-gap-24); overflow-x: auto; scrollbar-width: none; }
.dim-botSettingsTabs::-webkit-scrollbar { display: none; }
.dim-botSettingsTab { position: relative; min-height: 34px; flex: none; display: inline-flex; align-items: center; justify-content: center; padding: 6px 2px 8px; border: none; color: var(--dsw-alias-label-secondary, #646a73); background: transparent; font: inherit; font-size: var(--dim-font-13); line-height: var(--dim-line-13); font-weight: var(--dim-weight-500); white-space: nowrap; cursor: pointer; transition: color .15s ease; }
.dim-botSettingsTab::after { content: ''; position: absolute; right: 0; bottom: -1px; left: 0; height: 2px; border-radius: var(--dim-radius-indicator); background: transparent; transform: scaleX(.45); transition: background .15s ease, transform .15s ease; }
.dim-botSettingsTab:hover:not([aria-selected="true"]) { color: var(--dsw-alias-label-primary, #0f1115); }
.dim-botSettingsTab[aria-selected="true"] { color: var(--dsw-alias-label-primary, #0f1115); }
.dim-botSettingsTab[aria-selected="true"]::after { background: var(--dsw-alias-label-primary, #0f1115); transform: scaleX(1); }
.dim-botSettingsTab:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); outline-offset: -2px; border-radius: var(--dim-radius-8); }
.dim-botSettingsTabPanel { min-width: 0; display: grid; gap: var(--dim-gap-12); padding-top: 12px; }
.dim-feishuGroupSettings { min-width: 0; display: grid; gap: var(--dim-gap-12); }
.dim-feishuGroupControls { min-width: 0; display: grid; gap: var(--dim-gap-12); }
.dim-feishuGroupControl { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--dim-gap-8); padding: 16px 0; border: 0; border-radius: 0; background: none; }
.dim-feishuGroupControlHeader { position: relative; min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-12); }
.dim-feishuGroupControlHeader h3 { min-width: 0; margin: 0; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-13); line-height: var(--dim-line-13); font-weight: var(--dim-weight-500); }
.dim-feishuGroupControlStatus { flex: none; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-11); line-height: 17px; }
.dim-feishuGroupSelect { min-width: 0; width: 100%; height: 32px; padding: 0 10px; border: var(--dim-field-border); border-radius: var(--dim-field-radius); color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; font-size: var(--dim-font-14); line-height: var(--dim-line-14); cursor: pointer; transition: border-color .15s ease; }

.dim-feishuGroupSelect:focus-visible { outline: none; border-color: var(--dim-focus); }
.dim-feishuGroupSelect:disabled { cursor: not-allowed; opacity: 0.4; }
.dim-feishuGroupHelp { margin: -2px 0 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-feishuGroupPermissionAction { display: flex; justify-content: flex-start; }
.dim-feishuGroupPermissionAction .dim-deliveryButton { color: var(--dsw-alias-state-business-primary, #4176e6); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 30%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); }
.dim-feishuGroupError, .dim-feishuGroupRefreshError { margin: 0; padding: 9px 11px; border-radius: var(--dim-radius-8); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-feishuGroupError, .dim-feishuGroupRefreshError { color: var(--dsw-alias-state-error-primary, #d54941); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 7%, var(--dsw-alias-bg-layer-1, #fff)); }
.dim-feishuGroupAuthorization { min-width: 0; display: grid; grid-template-columns: 184px minmax(0, 1fr); align-items: start; gap: var(--dim-gap-24); padding: 18px; border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 30%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); border-radius: var(--dim-radius-12); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 2.5%, var(--dsw-alias-bg-layer-3, #fff)); }
.dim-feishuGroupAuthorizationState { min-height: 126px; grid-template-columns: 32px minmax(0, 1fr); align-items: center; }
.dim-feishuGroupAuthorizationState h3, .dim-feishuGroupAuthorizationError h3, .dim-feishuGroupAuthorizationCopy h3 { margin: 0; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-16); line-height: var(--dim-line-16); font-weight: var(--dim-weight-600); overflow-wrap: anywhere; }
.dim-feishuGroupAuthorizationState p, .dim-feishuGroupAuthorizationError p, .dim-feishuGroupAuthorizationCopy > p { margin: 5px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); overflow-wrap: anywhere; }
.dim-feishuGroupSpinner { width: 24px; height: 24px; border: 3px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); border-top-color: var(--dsw-alias-state-business-primary, #4176e6); border-radius: 50%; animation: dim-spin .8s linear infinite; }
.dim-feishuGroupAuthorizationError { grid-template-columns: minmax(0, 1fr) max-content; align-items: center; border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 28%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 4%, var(--dsw-alias-bg-layer-3, #fff)); }
.dim-feishuGroupAuthorizationError code { display: inline-block; margin-top: 6px; color: var(--dsw-alias-label-tertiary, #81858c); font: 11px/17px var(--dim-font-mono, monospace); overflow-wrap: anywhere; }
.dim-feishuGroupQrColumn { min-width: 0; }
.dim-feishuGroupQrFrame { position: relative; width: 176px; height: 176px; display: grid; place-items: center; padding: 10px; border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); border-radius: var(--dim-radius-12); background: #fff; box-shadow: 0 6px 18px rgb(31 35 41 / 7%); }
.dim-feishuGroupQrFrame img { width: 100%; height: 100%; display: block; object-fit: contain; }
.dim-feishuGroupQrFallback { width: 100%; height: 100%; display: grid; place-content: center; justify-items: center; gap: var(--dim-gap-7); border-radius: var(--dim-radius-8); color: var(--dim-on-qr-muted, #646a73); background: #f7f9ff; text-align: center; }
.dim-feishuGroupQrFallback span { color: var(--dim-on-qr-muted, #646a73); font-size: var(--dim-font-11); line-height: 17px; }
.dim-feishuGroupQrExpired { position: absolute; inset: 10px; display: grid; place-content: center; gap: var(--dim-gap-2); border-radius: var(--dim-radius-8); color: var(--dim-on-qr, #0f1115); background: rgb(255 255 255 / 94%); backdrop-filter: blur(3px); text-align: center; }
.dim-feishuGroupQrExpired span { font-size: var(--dim-font-13); line-height: var(--dim-line-13); font-weight: var(--dim-weight-600); }
.dim-feishuGroupQrExpired small { color: var(--dim-on-qr-muted, #646a73); font-size: var(--dim-font-11); line-height: 17px; }
.dim-feishuGroupCountdown { width: 176px; display: grid; grid-template-columns: minmax(0, 1fr) max-content; gap: var(--dim-gap-5) 10px; margin-top: 9px; color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-11); line-height: 17px; font-variant-numeric: tabular-nums; }
.dim-feishuGroupCountdown strong { color: var(--dsw-alias-label-secondary, #646a73); font-weight: var(--dim-weight-600); }
.dim-feishuGroupProgress { grid-column: 1 / -1; height: 3px; overflow: hidden; border-radius: var(--dim-radius-full); background: var(--dsw-alias-bg-module-platform, #f5f6f7); }
.dim-feishuGroupProgress > span { display: block; height: 100%; border-radius: inherit; background: var(--dsw-alias-state-business-primary, #4176e6); transition: width 1s linear; }
.dim-feishuGroupAuthorizationCopy { min-width: 0; }
.dim-feishuGroupAuthorizationEyebrow { display: block; margin-bottom: 7px; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-11); line-height: 17px; font-weight: var(--dim-weight-600); }
.dim-feishuGroupAuthorizationCopy ol { display: grid; gap: var(--dim-gap-6); margin: 13px 0 0; padding-left: 18px; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-11); line-height: 18px; }
.dim-feishuGroupAuthorizationActions { display: flex; align-items: center; justify-content: flex-start; flex-wrap: wrap; gap: var(--dim-gap-8); margin-top: 14px; }
.dim-feishuGroupAuthorizationLink { text-decoration: none; }
.dim-deliveryDocsLink { min-height: 30px; flex: none; display: inline-flex; align-items: center; gap: var(--dim-gap-4); padding: 5px 8px; border-radius: var(--dim-radius-8); color: var(--dsw-alias-state-business-primary, #4176e6); font-size: var(--dim-font-12); line-height: var(--dim-line-12); text-decoration: none; white-space: nowrap; }
.dim-deliveryDocsLink:hover { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 8%, transparent); }
.dim-deliveryDocsLink:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); outline-offset: 2px; }
.dim-deliveryButton { height: 28px; display: inline-flex; align-items: center; justify-content: center; padding: 0 10px; border: var(--dim-control-border); border-radius: var(--dim-radius-14); color: var(--dsw-alias-label-primary, #0f1115); background: transparent; font: inherit; font-size: var(--dim-font-12); line-height: var(--dim-line-12); cursor: pointer; }
.dim-deliveryButton:hover:not(:disabled) { background: var(--dim-hover-solid); }
.dim-deliveryButton:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); }
/* Header-row create action. Native expresses emphasis on an outline button through its text colour (dangerButton), never through a fill, so the create action takes the business tone over the shared outline capsule. */
.dim-deliveryButton[data-kind="primary"] { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 35%, var(--dsw-alias-border-l3, rgb(0 0 0 / 12%))); color: var(--dsw-alias-state-business-primary, #4176e6); background: transparent; }
.dim-deliveryButton[data-kind="primary"]:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 8%, transparent); }
.dim-deliveryButton:disabled { opacity: 0.4; cursor: not-allowed; }
.dim-deliveryButton[data-kind="danger"] { border-color: transparent; color: var(--dim-danger); }
.dim-deliveryButton[data-kind="danger"]:hover:not(:disabled) { background: var(--dim-danger-hover); }
.dim-deliveryBack { flex: none; border-color: transparent; background: transparent; }
.dim-deliveryIdentity, .dim-deliveryTargets { min-width: 0; padding: 16px; border: 0.5px solid var(--dsw-alias-border-l4, rgb(0 0 0 / 16%)); border-radius: var(--dim-radius-16); background: none; }
.dim-deliveryIdentityHeading { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-12); }
.dim-deliveryBotName, .dim-deliverySectionHeading h3 { min-width: 0; overflow: hidden; margin: 0; font-size: var(--dim-font-15); line-height: 22px; font-weight: var(--dim-weight-600); text-overflow: ellipsis; white-space: nowrap; }
.dim-deliveryIdentity > div:first-child p, .dim-deliverySectionHeading p { margin: 2px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-deliveryBotId { min-width: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr) max-content; align-items: center; gap: var(--dim-gap-10); margin-top: 12px; padding: 10px 12px; border-radius: var(--dim-radius-8); background: var(--dsw-alias-bg-module-platform, #f5f6f7); }
.dim-deliveryBotId > span { color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); }
.dim-deliveryBotId code { min-width: 0; overflow: hidden; font: 12px/18px var(--dim-font-mono, monospace); text-overflow: ellipsis; white-space: nowrap; }
.dim-deliverySectionHeading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--dim-gap-12); }
.dim-deliveryState { margin-top: 14px; padding: 24px 16px; border: 1px dashed var(--dsw-alias-border-l3, #dfe1e5); border-radius: var(--dim-radius-10); color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); text-align: center; }
.dim-deliveryState p { margin: 5px 0; }
.dim-deliveryEmpty strong { color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-13); }
.dim-targetList { display: grid; gap: var(--dim-gap-10); margin: 14px 0 0; padding: 0; list-style: none; }
.dim-targetRow { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) max-content; gap: var(--dim-gap-8) 14px; padding: 13px; border: 0; border-radius: var(--dim-radius-12); background: var(--dsw-alias-bg-module-platform, #f5f6f7); }
.dim-targetSummary { min-width: 0; }
.dim-targetTitle { min-width: 0; display: flex; align-items: center; gap: var(--dim-gap-7); }
.dim-targetTitle strong { overflow: hidden; font-size: var(--dim-font-13); line-height: var(--dim-line-13); font-weight: var(--dim-weight-600); text-overflow: ellipsis; white-space: nowrap; }
.dim-targetTitle span { flex: none; padding: 1px 6px; border-radius: var(--dim-radius-8); color: var(--dsw-alias-state-business-primary, #4176e6); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 9%, transparent); font-size: var(--dim-font-11); line-height: 16px; }
.dim-targetSummary code { display: block; overflow: hidden; margin-top: 3px; color: var(--dsw-alias-label-secondary, #646a73); font: 11px/17px var(--dim-font-mono, monospace); text-overflow: ellipsis; white-space: nowrap; }
.dim-targetActions { display: flex; align-items: center; justify-content: flex-end; gap: var(--dim-gap-6); flex-wrap: wrap; }
.dim-targetSessionSync { grid-column: 1 / -1; min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--dim-gap-12); padding-top: 9px; border-top: 0.5px solid var(--dsw-alias-border-l1, #eef0f3); cursor: pointer; }
.dim-targetSessionSyncCopy { min-width: 0; display: grid; gap: var(--dim-gap-1); }
.dim-targetSessionSyncCopy strong { color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-12); line-height: var(--dim-line-12); font-weight: var(--dim-weight-600); }
.dim-targetSessionSyncCopy small { color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-11); line-height: 17px; overflow-wrap: anywhere; }
.dim-targetSessionSync input { width: 16px; height: 16px; flex: none; margin: 0; accent-color: var(--dsw-alias-state-business-primary, #4176e6); }
.dim-targetSessionSync:has(input:disabled) { cursor: default; }
.dim-targetFeedback { grid-column: 1 / -1; margin: 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-11); line-height: 17px; overflow-wrap: anywhere; }
.dim-targetFeedback[data-tone="success"] { color: var(--dsw-alias-state-success-primary, #20a162); }
.dim-targetFeedback[data-tone="error"], .dim-targetFormError { color: var(--dsw-alias-state-error-primary, #d54941); overflow-wrap: anywhere; }
.dim-targetDeleteConfirm { grid-column: 1 / -1; padding: 10px 12px; border-radius: var(--dim-radius-8); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 7%, var(--dsw-alias-bg-layer-1, #fff)); }
.dim-targetDeleteConfirm p { margin: 0 0 8px; font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-targetSuggestions { margin-top: 14px; padding: 14px; border: 0; border-radius: var(--dim-radius-12); background: var(--dsw-alias-bg-module-platform, #f5f6f7); }
.dim-targetSuggestionHeading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--dim-gap-12); }
.dim-targetSuggestionHeading h3 { margin: 0; font-size: var(--dim-font-14); line-height: var(--dim-line-14); }
.dim-targetSuggestionHeading p { margin: 2px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-11); line-height: 17px; }
.dim-targetSuggestionState { margin-top: 12px; padding: 18px 12px; border: 1px dashed var(--dsw-alias-border-l3, #dfe1e5); border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-12); line-height: var(--dim-line-12); text-align: center; }
.dim-targetSuggestionState p { margin: 4px 0; }
.dim-targetSuggestionState strong { color: var(--dsw-alias-label-primary, #0f1115); }
.dim-targetSuggestionField { min-width: 0; display: grid; gap: var(--dim-gap-6); margin-top: 12px; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-13); line-height: var(--dim-line-13); font-weight: var(--dim-weight-500); }
.dim-targetSuggestionField select { width: 100%; min-width: 0; height: 32px; padding: 0 10px; border: var(--dim-field-border); border-radius: var(--dim-field-radius); color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; font-size: var(--dim-font-14); line-height: var(--dim-line-14); cursor: pointer; }
.dim-targetSuggestionField select:focus { outline: none; border-color: var(--dim-focus); }
.dim-targetForm { margin-top: 14px; padding: 14px; border: 0; border-radius: var(--dim-radius-12); background: var(--dsw-alias-bg-module-platform, #f5f6f7); }
.dim-targetFormHeading h3 { margin: 0; font-size: var(--dim-font-14); line-height: var(--dim-line-14); }
.dim-targetFormHeading p { margin: 2px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-11); line-height: 17px; }
.dim-targetFormGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--dim-gap-11) 12px; margin-top: 12px; }
.dim-targetField { min-width: 0; display: grid; align-content: start; gap: var(--dim-gap-6); color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-13); line-height: var(--dim-line-13); font-weight: var(--dim-weight-500); }
.dim-targetField input, .dim-targetField select { width: 100%; min-width: 0; height: 32px; padding: 0 10px; border: var(--dim-field-border); border-radius: var(--dim-field-radius); color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; font-size: var(--dim-font-14); line-height: var(--dim-line-14); }
.dim-targetField input:focus, .dim-targetField select:focus { outline: none; border-color: var(--dim-focus); }
.dim-targetField input[readonly] { color: var(--dsw-alias-label-tertiary, #81858c); background: var(--dim-module-fill); }
.dim-targetFormError { margin: 10px 0 0; font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-targetFormActions { display: flex; justify-content: flex-end; gap: var(--dim-gap-7); margin-top: 12px; }
.dim-accessPage { min-width: 0; display: grid; gap: var(--dim-gap-12); }
.dim-accessScene[aria-disabled="true"] { opacity: 0.4; }
.dim-accessScene { position: relative; min-width: 0; margin: 0; padding: 16px; border: 0.5px solid var(--dsw-alias-border-l4, rgb(0 0 0 / 16%)); border-radius: var(--dim-radius-16); background: none; }
/* Ordinary group heading inside the card. A fieldset legend would notch the card border, which no native surface does. */
.dim-accessLegend { margin: 0 0 4px; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-13); line-height: var(--dim-line-13); font-weight: var(--dim-weight-500); }
.dim-accessLegendContent { display: inline-flex; align-items: center; gap: var(--dim-gap-6); }
.dim-panel .dim-accessLegendHelp { position: static; }
.dim-accessLegendHelp .dim-channelTooltip { top: 20px; right: auto; left: 16px; width: min(320px, calc(100% - 32px)); max-width: none; }
.dim-accessControls { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--dim-gap-12); }
.dim-accessControls[data-mode="allowlist"] { grid-template-columns: minmax(0, 1fr); }
.dim-accessField { min-width: 0; display: grid; align-content: start; gap: var(--dim-gap-6); color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-13); line-height: var(--dim-line-13); font-weight: var(--dim-weight-500); }
.dim-accessField input, .dim-accessField select { width: 100%; min-width: 0; height: 32px; padding: 0 10px; border: var(--dim-field-border); border-radius: var(--dim-field-radius); color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; font-size: var(--dim-font-14); line-height: var(--dim-line-14); }
.dim-accessField input:focus, .dim-accessField select:focus { outline: none; border-color: var(--dim-focus); }
.dim-accessUsers { min-width: 0; margin-top: 14px; padding-top: 14px; border-top: 0.5px solid var(--dsw-alias-border-l1, #eef0f3); }
.dim-accessUsersHeading { position: relative; min-width: 0; display: flex; align-items: flex-start; justify-content: space-between; gap: var(--dim-gap-12); }
.dim-accessUsersHeading > div { min-width: 0; }
.dim-accessUsersTitle { display: inline-flex; align-items: center; gap: var(--dim-gap-6); }
.dim-accessUsersHeading strong { color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-13); line-height: var(--dim-line-13); font-weight: var(--dim-weight-600); }
.dim-accessUsersHeading p { margin: 2px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-11); line-height: 17px; }
.dim-panel .dim-accessUsersHelp { position: static; }
.dim-accessUsersHelp .dim-channelTooltip { top: calc(100% + 7px); right: auto; left: 0; width: min(320px, 100%); max-width: none; }
.dim-accessAddUser { width: 32px; height: 32px; min-height: 32px; flex: 0 0 32px; padding: 0; font-size: var(--dim-font-20); line-height: var(--dim-line-20); }
.dim-accessUsersEmpty { margin-top: 10px; padding: 15px 12px; border: 1px dashed var(--dsw-alias-border-l3, #dfe1e5); border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-tertiary, #81858c); font-size: var(--dim-font-12); line-height: var(--dim-line-12); text-align: center; }
.dim-accessUserList { display: grid; gap: var(--dim-gap-9); margin: 10px 0 0; padding: 0; list-style: none; }
.dim-accessUserRow { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(145px, 180px) max-content; align-items: end; gap: var(--dim-gap-10); padding: 11px; border: 0; border-radius: var(--dim-radius-12); background: var(--dsw-alias-bg-module-platform, #f5f6f7); }
.dim-accessDeleteUser { margin-bottom: 1px; }
.dim-accessUnsupported { padding: 18px 14px; border: 1px dashed var(--dsw-alias-border-l3, #dfe1e5); border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-bg-module-platform, #f5f6f7); text-align: center; }
.dim-accessUnsupported strong { color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-13); line-height: var(--dim-line-13); }
.dim-accessUnsupported p { margin: 4px 0 0; font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-accessState { padding: 11px 13px; border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 24%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); border-radius: var(--dim-radius-8); color: var(--dsw-alias-state-warn-primary, #d97706); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 7%, var(--dsw-alias-bg-layer-1, #fff)); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-accessFeedback { margin: 0; padding: 10px 12px; border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-bg-module-platform, #f5f6f7); font-size: var(--dim-font-12); line-height: var(--dim-line-12); }
.dim-accessFeedback[data-tone="success"] { color: var(--dsw-alias-state-success-primary, #20a162); }
.dim-accessFeedback[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #d54941); }
.dim-accessActions { display: flex; justify-content: flex-end; }
.dim-generalSettingsPage { min-width: 0; display: grid; }
.dim-generalSettingsHeader { min-width: 0; margin: 0 0 8px; }
.dim-generalSettingsHeader h2 { margin: 0; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-18); line-height: 25px; font-weight: var(--dim-weight-600); }
.dim-generalSettingsTabsBar { min-width: 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%)); }
.dim-generalSettingsTabs { min-width: 0; display: flex; align-items: flex-end; gap: var(--dim-gap-24); overflow-x: auto; scrollbar-width: none; }
.dim-generalSettingsTabs::-webkit-scrollbar { display: none; }
.dim-generalSettingsTab { position: relative; min-height: 34px; flex: none; display: inline-flex; align-items: center; justify-content: center; padding: 6px 2px 8px; border: none; color: var(--dsw-alias-label-secondary, #646a73); background: transparent; font: inherit; font-size: var(--dim-font-13); line-height: var(--dim-line-13); font-weight: var(--dim-weight-500); white-space: nowrap; cursor: pointer; transition: color .15s ease; }
.dim-generalSettingsTab::after { content: ''; position: absolute; right: 0; bottom: -1px; left: 0; height: 2px; border-radius: var(--dim-radius-indicator); background: transparent; transform: scaleX(.45); transition: background .15s ease, transform .15s ease; }
.dim-generalSettingsTab:hover:not([aria-selected="true"]) { color: var(--dsw-alias-label-primary, #0f1115); }
.dim-generalSettingsTab[aria-selected="true"] { color: var(--dsw-alias-label-primary, #0f1115); }
.dim-generalSettingsTab[aria-selected="true"]::after { background: var(--dsw-alias-label-primary, #0f1115); transform: scaleX(1); }
.dim-generalSettingsTab:focus-visible { outline: none; box-shadow: var(--dim-focus-shadow); outline-offset: -2px; border-radius: var(--dim-radius-8); }
.dim-generalSettingsTabPanel { min-width: 0; padding-top: 14px; }
.dim-globalSection { min-width: 0; padding: 14px 16px; border: 0.5px solid var(--dsw-alias-border-l4, rgb(0 0 0 / 16%)); border-radius: var(--dim-radius-16); background: none; }
.dim-globalHead { min-width: 0; display: flex; align-items: center; }
.dim-globalHeadTitle { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: var(--dim-gap-6); }
.dim-globalHead h3 { min-width: 0; overflow: hidden; margin: 0; color: var(--dsw-alias-label-primary, #0f1115); font-size: var(--dim-font-15); line-height: 22px; font-weight: var(--dim-weight-600); text-overflow: ellipsis; white-space: nowrap; }
.dim-globalTtlHelp { position: relative; display: inline-flex; flex: none; }
.dim-globalTtlTooltip { position: absolute; top: calc(100% + 7px); left: 0; z-index: var(--dim-z-tooltip); width: max-content; max-width: min(280px, calc(100vw - 48px)); opacity: 0; visibility: hidden; transform: translateY(-3px); pointer-events: none; transition: opacity .15s ease, transform .15s ease, visibility .15s ease; }
.dim-globalTtlHelp:hover .dim-globalTtlTooltip, .dim-globalTtlHelpButton:focus-visible + .dim-globalTtlTooltip { opacity: 1; visibility: visible; transform: translateY(0); }
.dim-globalTtlHints { display: grid; gap: var(--dim-gap-4); margin: 0; padding: 0; list-style: none; }
.dim-globalTtlHints li { min-width: 0; display: flex; align-items: baseline; gap: var(--dim-gap-8); }
.dim-globalTtlHints code { flex: none; min-width: 44px; padding: 0 6px; border-radius: var(--dim-radius-8); color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-alias-bg-module-platform, #f5f6f7); font: 11px/16px var(--dim-font-mono, monospace); text-align: center; }
.dim-globalTtlHints span { min-width: 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-11); line-height: 16px; }
.dim-globalTtlRow { display: flex; align-items: center; flex-wrap: wrap; gap: var(--dim-gap-4) 10px; margin-top: 12px; }
.dim-globalTtlInput { width: min(160px, 100%); min-width: 110px; max-width: 160px; flex: 1 1 130px; height: 32px; padding: 0 10px; border: var(--dim-field-border); border-radius: var(--dim-field-radius); color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-alias-bg-layer-1, #fff); font: 13px/1.5 var(--dim-font-mono, monospace); transition: border-color .16s ease; }

.dim-globalTtlInput:focus { outline: none; border-color: var(--dim-focus); }
.dim-globalTtlInput[aria-invalid="true"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 62%, var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))); }
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
.dim-globalInline { flex: 1 0 100%; min-width: 0; margin: 2px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: var(--dim-font-11); line-height: 16px; overflow-wrap: anywhere; }
.dim-globalInline[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #d54941); }
.dim-panel .dim-botCard .dim-cardFooter { margin-top: 0; }
.dim-panel .ddt-headingCopy { display: none; }
.dim-panel .ddt-qrFrame, .dim-panel .ddt-countdown { width: min(270px, 100%); }
@container (max-width: 680px) {
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
}
@media (max-width: 840px) {
  .dim-title { align-items: flex-start; }
  .dim-channel { min-height: 34px; }
}
@media (max-width: 560px) {
  .dim-title { flex-direction: column; gap: var(--dim-gap-10); }
  .dim-title p { white-space: normal; }
  .dim-titleActions { justify-content: flex-start; }
  .dim-updateBackdrop { padding: 12px; }
  .dim-updateDialog { max-height: calc(100vh - 24px); }
  .dim-updateDialog h3 { margin: 18px 18px 8px; }
  .dim-updateDescription { margin: 0 18px; }
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
  .dim-directoryPickerHeader h3 { font-size: var(--dim-font-18); }
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
