export const IM_STYLE_ID = 'xmanrui-dsh-im-settings';

const CSS = String.raw`
.dim-page {
  --dim-blue: var(--dsw-alias-state-business-primary, #3370ff);
  --dim-blue-soft: color-mix(in srgb, var(--dim-blue) 9%, transparent);
  width: 100%;
  max-width: 1080px;
  padding: 2px 0 30px;
  color: var(--dsw-alias-label-primary, #1f2329);
  box-sizing: border-box;
}
.dim-page *, .dim-page *::before, .dim-page *::after { box-sizing: border-box; }
.dim-title { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 0 0 18px; }
.dim-brand { min-width: 0; width: max-content; max-width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; margin: -2px -6px; padding: 2px 6px; border-radius: 8px; }
.dim-brandHeading { display: flex; align-items: baseline; gap: 8px; white-space: nowrap; }
.dim-brandName { color: var(--dsw-alias-label-primary, #1f2329); font-size: 20px; line-height: 24px; font-weight: 800; letter-spacing: .04em; }
.dim-brandVersion { color: var(--dsw-alias-label-tertiary, #8f959e); font: 500 10px/16px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0; }
.dim-title p { margin: 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: 18px; font-weight: 500; white-space: nowrap; }
.dim-titleActions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.dim-updateButton { min-height: 30px; display: inline-flex; align-items: center; justify-content: center; gap: 3px; padding: 5px 10px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; font-size: 12px; line-height: 18px; font-weight: 560; cursor: pointer; }
.dim-updateButton:hover:not(:disabled) { border-color: #aeb3bb; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-interactive-bg-hover, #f7f8fa); }
.dim-updateButton:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3370ff); outline-offset: 2px; }
.dim-updateButton:disabled { opacity: .55; cursor: default; }
.dim-updateTrigger { white-space: nowrap; }
.dim-updateBackdrop { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 24px; background: rgb(15 17 21 / 42%); }
.dim-updateBackdrop, .dim-updateBackdrop * { box-sizing: border-box; }
.dim-updateDialog { width: min(480px, 100%); max-height: calc(100vh - 48px); overflow-y: auto; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 16px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-3, #fff); box-shadow: 0 20px 70px rgb(0 0 0 / 20%); text-align: left; }
.dim-updateDialog:focus { outline: none; }
.dim-updateDialog h3 { margin: 22px 24px 8px; font-size: 18px; line-height: 25px; font-weight: 680; }
.dim-updateDescription { margin: 0 24px; color: var(--dsw-alias-label-secondary, #646a73); font-size: 13px; line-height: 20px; }
.dim-updateBody { padding: 18px 24px 20px; }
.dim-updateVersions { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 18px; margin: 0 0 18px; font-size: 12px; line-height: 18px; }
.dim-updateVersions dt { color: var(--dsw-alias-label-secondary, #646a73); }
.dim-updateVersions dd { min-width: 0; margin: 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.dim-updateStatus { padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #f7f8fa); font-size: 13px; line-height: 20px; }
.dim-updateStatus strong { font-weight: 600; }
.dim-updateStatus p { margin: 6px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: 19px; overflow-wrap: anywhere; }
.dim-updateStatusError { border-color: color-mix(in srgb, var(--dsw-alias-state-danger-primary, #d92d20) 25%, var(--dsw-alias-border-l2, #dfe1e5)); }
.dim-updateHint, .dim-updateError { margin: 12px 0 0; font-size: 12px; line-height: 19px; overflow-wrap: anywhere; }
.dim-updateHint { color: var(--dsw-alias-label-secondary, #646a73); }
.dim-updateError { color: var(--dsw-alias-state-danger-primary, #d92d20); }
.dim-updateManual { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.dim-updateManualHeading { margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; }
.dim-updateManualHint { margin: 8px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: 19px; }
.dim-updateCommandRow { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #f7f8fa); }
.dim-updateCommand { display: block; flex: 1; width: 100%; min-width: 0; padding: 0; resize: none; border: 0; color: var(--dsw-alias-label-primary, #1f2329); background: transparent; font: 12px/19px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
.dim-updateCommand:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3370ff); outline-offset: 2px; }
.dim-updateCopy { display: inline-flex; flex: 0 0 28px; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; color: var(--dsw-alias-label-secondary, #646a73); background: transparent; cursor: pointer; }
.dim-updateCopy:hover:not(:disabled) { color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-interactive-bg-hover, #eef0f3); }
.dim-updateCopy:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3370ff); outline-offset: 2px; }
.dim-updateCopy:disabled { opacity: .55; cursor: default; }
.dim-updateCopyCopied { color: var(--dsw-alias-state-success-primary, #20a162); }
.dim-updateFooter { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; padding: 14px 24px; border-top: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.dim-updateFooter .dim-updateButton:first-child { margin-right: auto; }
.dim-updatePrimary, .dim-updatePrimary:hover:not(:disabled) { border-color: var(--dsw-alias-state-business-primary, #3370ff); color: #fff; background: var(--dsw-alias-state-business-primary, #3370ff); }
.dim-githubAction { position: relative; display: inline-flex; flex: none; }
.dim-githubLink { min-height: 30px; display: inline-flex; align-items: center; gap: 5px; flex: none; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-bg-layer-1, #fff); font-size: 12px; line-height: normal; font-weight: 560; text-decoration: none; transition: border-color .15s ease, color .15s ease, background .15s ease; }
.dim-githubLink:hover { border-color: #aeb3bb; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-interactive-bg-hover, #f7f8fa); }
.dim-githubLink:focus-visible { outline: 2px solid color-mix(in srgb, var(--dim-blue) 70%, white); outline-offset: 2px; }
.dim-githubArrow { font-size: 13px; line-height: 1; }
.dim-githubTooltip { position: absolute; top: calc(100% + 8px); right: 0; z-index: 20; width: max-content; max-width: min(220px, 80vw); padding: 6px 9px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 7px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-3, #fff); box-shadow: 0 8px 24px rgb(31 35 41 / 14%); font-size: 11px; line-height: 16px; font-weight: 500; white-space: nowrap; opacity: 0; visibility: hidden; transform: translateY(-3px); pointer-events: none; transition: opacity .15s ease, transform .15s ease, visibility .15s ease; }
.dim-githubAction:hover .dim-githubTooltip, .dim-githubAction:focus-within .dim-githubTooltip { opacity: 1; visibility: visible; transform: translateY(0); }
.dim-layout { display: grid; grid-template-columns: 174px 1px minmax(0, 1fr); gap: 24px; align-items: start; }
.dim-rail { max-height: 520px; display: grid; align-content: start; gap: 8px; overflow-y: auto; padding: 0 4px 1px 1px; scrollbar-width: thin; scrollbar-color: var(--dsw-alias-border-l2, #dfe1e5) transparent; }
.dim-rail::-webkit-scrollbar { width: 4px; }
.dim-rail::-webkit-scrollbar-thumb { border-radius: 99px; background: var(--dsw-alias-border-l2, #dfe1e5); }
.dim-channel { width: 100%; min-height: 48px; display: grid; grid-template-columns: 30px minmax(0, 1fr); align-items: center; gap: 10px; padding: 8px 12px; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 14px; color: inherit; background: var(--dsw-alias-bg-layer-3, #fff); box-shadow: 0 2px 8px rgb(31 35 41 / 3%); font: inherit; text-align: left; cursor: pointer; transition: border-color .16s ease, background .16s ease, box-shadow .16s ease; }
.dim-channel:hover { border-color: color-mix(in srgb, var(--dim-blue) 25%, var(--dsw-alias-border-l2, #eef0f3)); background: color-mix(in srgb, var(--dim-blue) 2%, var(--dsw-alias-bg-layer-3, #fff)); box-shadow: 0 5px 16px rgb(31 35 41 / 5%); }
.dim-channel[aria-selected="true"] { border-color: color-mix(in srgb, var(--dim-blue) 43%, var(--dsw-alias-border-l2, #dfe1e5)); color: var(--dim-blue); background: color-mix(in srgb, var(--dim-blue) 12%, var(--dsw-alias-bg-layer-3, #fff)); box-shadow: 0 3px 12px rgb(51 112 255 / 7%); }
.dim-channel:focus-visible { outline: none; border-color: color-mix(in srgb, var(--dim-blue) 72%, var(--dsw-alias-border-l2, #dfe1e5)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--dim-blue) 24%, transparent) inset, 0 3px 12px rgb(51 112 255 / 7%); }
.dim-logo { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 9px; box-shadow: 0 1px 3px rgb(31 35 41 / 7%); }
.dim-logo svg { display: block; width: 20px; height: 20px; }
.dim-logoWeixin { color: white; background: #07c160; }
.dim-logoWeixin svg { width: 19px; height: 19px; }
.dim-logoFeishu { background: white; border: 1px solid var(--dsw-alias-border-l2, #e5e6eb); }
.dim-logoFeishu svg { width: 28px; height: 28px; }
.dim-logoDingtalk { color: white; background: #1677ff; }
.dim-logoDingtalk svg { width: 24px; height: 24px; }
.dim-logoQq { color: white; background: #1677ff; }
.dim-logoQq svg { width: 21px; height: 21px; }
.dim-logoWecom { background: white; border: 1px solid var(--dsw-alias-border-l2, #e5e6eb); }
.dim-logoWecom svg { width: 22px; height: 22px; }
.dim-logoTelegram { color: white; background: #229ed9; }
.dim-logoTelegram svg { width: 21px; height: 21px; }
.dim-logoOffice { color: white; background: linear-gradient(145deg, #12213f, #3964fe); }
.dim-logoOffice svg { width: 23px; height: 23px; }
.dim-logoDiscord { color: white; background: #5865f2; }
.dim-logoDiscord svg { width: 21px; height: 21px; }
.dim-logoSlack { color: white; background: #4a154b; }
.dim-logoSlack svg { width: 21px; height: 21px; }
.dim-logoWhatsapp { color: white; background: #25d366; }
.dim-logoWhatsapp svg { width: 21px; height: 21px; }
.dim-channelCopy { min-width: 0; display: grid; }
.dim-channelCopy strong { overflow: hidden; color: inherit; font-size: 14px; line-height: 20px; font-weight: 680; text-overflow: ellipsis; white-space: nowrap; }
.dim-channelNote { overflow: hidden; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 10px; line-height: 13px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.dim-divider { width: 1px; min-height: 520px; background: var(--dsw-alias-border-l1, #eef0f3); }
.dim-panel { min-width: 0; container-type: inline-size; }
.dim-loopbackRecovery { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 0 0 14px; padding: 14px 16px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 30%, var(--dsw-alias-border-l2, #dfe1e5)); border-radius: 12px; color: var(--dsw-alias-label-primary, #1f2329); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 8%, var(--dsw-alias-bg-layer-1, #fff)); }
.dim-loopbackRecoveryCopy { min-width: 0; }
.dim-loopbackRecoveryCopy strong { display: block; font-size: 14px; line-height: 20px; font-weight: 650; }
.dim-loopbackRecoveryCopy p { margin: 3px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: 18px; }
.dim-loopbackRecoveryCopy code { display: block; overflow: hidden; margin-top: 5px; color: var(--dsw-alias-label-secondary, #646a73); font: 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
.dim-loopbackRecoveryAction { flex: none; min-height: 34px; display: inline-flex; align-items: center; justify-content: center; padding: 0 12px; border: 1px solid #1677ff; border-radius: 8px; color: #fff; background: #1677ff; font: inherit; font-size: 13px; font-weight: 560; white-space: nowrap; cursor: pointer; }
.dim-loopbackRecoveryAction:hover { border-color: #0958d9; background: #0958d9; }
.dim-loopbackRecoveryAction:focus-visible { outline: 2px solid color-mix(in srgb, #1677ff 62%, white); outline-offset: 2px; }
.dim-panel .bxf-page, .dim-panel .dxw-page, .dim-panel .ddt-page, .dim-panel .dqq-page, .dim-panel .dwecom-page, .dim-panel .dsl-page, .dim-panel .dwa-page { width: 100%; max-width: none; padding: 0 0 24px; }
.dim-panel .bxf-heading, .dim-panel .dxw-heading, .dim-panel .ddt-heading { justify-content: flex-end; }
.dim-panel .bxf-headingTools, .dim-panel .dxw-tools, .dim-panel .ddt-tools { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) max-content; align-items: center; justify-content: stretch; gap: 8px; }
.dim-panel .dim-bindActions { min-width: 0; display: flex; align-items: center; flex-wrap: nowrap; gap: 8px; }
.dim-panel .dim-bindActions > button { min-width: 0; }
.dim-panel .bxf-headingTools .dim-scanButton, .dim-panel .dxw-tools .dim-scanButton, .dim-panel .ddt-tools .dim-scanButton { flex: none; min-height: 34px; display: inline-flex; align-items: center; justify-content: center; justify-self: start; gap: 6px; padding: 0 10px; border: 1px solid #1677ff; border-radius: 8px; color: #fff; background: #1677ff; box-shadow: none; font: inherit; font-size: 13px; font-weight: 560; white-space: nowrap; }
.dim-panel .bxf-headingTools .dim-scanButton:hover:not(:disabled), .dim-panel .dxw-tools .dim-scanButton:hover:not(:disabled), .dim-panel .ddt-tools .dim-scanButton:hover:not(:disabled) { border-color: #0958d9; background: #0958d9; }
.dim-panel .dim-credentialButton { flex: none; min-height: 34px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 10px; border: 1px solid #86909c; border-radius: 8px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 1px 2px rgb(31 35 41 / 5%); font: inherit; font-size: 13px; font-weight: 560; line-height: normal; white-space: nowrap; }
.dim-panel .dim-actionIcon { width: 15px; height: 15px; flex: 0 0 15px; }
.dim-panel .dim-credentialButton:hover:not(:disabled) { border-color: #4e5969; background: var(--dsw-alias-interactive-bg-hover, #f7f8fa); }
.dim-panel .dim-credentialButton[aria-pressed="true"] { border-color: #4e5969; background: var(--dsw-alias-bg-module-platform, #f2f3f5); box-shadow: inset 0 0 0 1px rgb(78 89 105 / 8%); }
.dim-panel .bxf-headingTools .dim-onlineBadge, .dim-panel .dxw-tools .dim-onlineBadge, .dim-panel .ddt-tools .dim-onlineBadge { min-height: 30px; display: inline-flex; align-items: center; justify-self: end; gap: 0; padding: 0 11px; border: 0; border-radius: 999px; color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-bg-module-platform, #f2f3f5); font: inherit; font-size: 12px; font-weight: 400; line-height: normal; white-space: nowrap; }
.dim-panel .dim-channelPage { min-width: 0; width: 100%; max-width: none; display: flex; flex-direction: column; gap: 12px; padding: 0 0 24px; color: var(--dsw-alias-label-primary, #1f2329); box-sizing: border-box; }
.dim-panel .dim-surfaceCard { position: relative; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2, #e5e6eb); border-radius: 14px; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 1px 2px rgb(31 35 41 / 3%); }
.dim-panel .dim-surfaceCard::before { display: none; }
.dim-panel .dim-surfaceBody { padding: 24px; }
.dim-panel .dim-credentialPanel { display: grid; gap: 18px; padding: 20px; }
.dim-panel .dim-credentialTitle { margin: 0; color: var(--dsw-alias-label-primary, #1f2329); font-size: 17px; line-height: 1.35; font-weight: 650; }
.dim-panel .dim-credentialForm { min-width: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 12px; }
.dim-panel .dim-credentialFormSingle { grid-template-columns: minmax(0, 1fr); }
.dim-panel .dim-credentialField { min-width: 0; display: grid; gap: 7px; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: normal; font-weight: 560; }
.dim-panel .dim-credentialField input { width: 100%; min-width: 0; height: 38px; padding: 0 11px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; outline: none; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-1, #fff); font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; transition: border-color .16s ease, box-shadow .16s ease; }
.dim-panel .dim-credentialField input:focus { border-color: #4e5969; box-shadow: 0 0 0 3px rgb(78 89 105 / 10%); }
.dim-panel .dim-credentialField input::placeholder { color: var(--dsw-alias-label-tertiary, #8f959e); font-family: inherit; }
.dim-panel .dim-credentialError, .dim-panel .dim-credentialActions { grid-column: 1 / -1; }
.dim-panel .dim-credentialError { margin: 0; color: var(--dsw-alias-state-error-primary, #d54941); font-size: 12px; line-height: 1.5; }
.dim-panel .dim-credentialActions { margin-top: 0; }
.dim-panel .dim-listSection { min-width: 0; width: 100%; max-width: 100%; display: flex; flex-direction: column; gap: 0; }
.dim-panel .dim-listHeading { min-height: 0; display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 0 0 6px; padding: 0; }
.dim-panel .dim-listHeading h3 { margin: 0; color: var(--dsw-alias-label-primary, #1f2329); font-size: 14px; line-height: normal; font-weight: 650; }
.dim-panel .dim-listTitle { min-width: 0; display: inline-flex; align-items: center; gap: 6px; }
.dim-panel .dim-channelHelp { position: relative; display: inline-flex; flex: none; }
.dim-panel .dim-channelHelpButton { width: 17px; height: 17px; display: grid; place-items: center; padding: 0; border: 1px solid color-mix(in srgb, #1677ff 28%, var(--dsw-alias-border-l2, #dfe1e5)); border-radius: 50%; color: #1677ff; background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; font-size: 11px; line-height: 1; font-weight: 700; cursor: help; transition: border-color .15s ease, color .15s ease, background .15s ease, box-shadow .15s ease; }
.dim-panel .dim-channelHelpButton:hover { border-color: #1677ff; color: #0f5fce; background: color-mix(in srgb, #1677ff 8%, var(--dsw-alias-bg-layer-1, #fff)); }
.dim-panel .dim-channelHelpButton:focus-visible { outline: none; border-color: #1677ff; box-shadow: 0 0 0 3px color-mix(in srgb, #1677ff 16%, transparent); }
.dim-panel .dim-channelTooltip { position: absolute; top: calc(100% + 7px); left: 0; z-index: 30; width: max-content; max-width: min(280px, calc(100vw - 48px)); display: flex; align-items: baseline; gap: 5px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-bg-layer-3, #fff); box-shadow: 0 10px 28px rgb(31 35 41 / 16%); font-size: 11px; line-height: 16px; font-weight: 400; white-space: normal; opacity: 0; visibility: hidden; transform: translateY(-3px); pointer-events: none; transition: opacity .15s ease, transform .15s ease, visibility .15s ease; }
.dim-panel .dim-channelTooltip strong { color: var(--dsw-alias-label-primary, #1f2329); font-weight: 600; white-space: nowrap; }
.dim-panel .dim-channelHelp:hover .dim-channelTooltip, .dim-panel .dim-channelHelp:focus-within .dim-channelTooltip { opacity: 1; visibility: visible; transform: translateY(0); }
.dim-panel .dim-botList { min-width: 0; width: 100%; max-width: 100%; display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; margin: 0; padding: 0; list-style: none; }
.dim-panel .dim-botList > li { min-width: 0; max-width: 100%; }
.dim-panel .dim-loadingView { padding: 38px; color: var(--dsw-alias-label-secondary, #646a73); text-align: center; }
.dim-panel .dim-loadingView h3 { margin: 0 0 7px; color: var(--dsw-alias-label-primary, #1f2329); font-size: 17px; line-height: normal; font-weight: 650; }
.dim-panel .dim-loadingView p { margin: 0; line-height: 1.6; }
.dim-panel .dim-spinner { width: 24px; height: 24px; margin: 0 auto 13px; border: 3px solid var(--dsw-alias-border-l2, #e6e8eb); border-top-color: #1677ff; border-radius: 50%; animation: dim-spin .8s linear infinite; }
@keyframes dim-spin { to { transform: rotate(360deg); } }
.dim-panel .dim-emptyView { min-height: 230px; display: grid; grid-template-columns: minmax(0, 1fr) 180px; align-items: center; gap: 30px; }
.dim-panel .dim-emptyCopy { min-width: 0; }
.dim-panel .dim-emptyCopy h3 { margin: 8px 0; color: var(--dsw-alias-label-primary, #1f2329); font-size: 18px; line-height: 1.35; font-weight: 650; }
.dim-panel .dim-emptyCopy > p { max-width: 560px; margin: 0; color: var(--dsw-alias-label-secondary, #646a73); line-height: 1.65; }
.dim-panel .dim-emptyBrand { width: 110px; height: 110px; display: grid; place-items: center; justify-self: center; border-radius: 28px; box-shadow: 0 18px 45px rgb(22 119 255 / 18%); }
.dim-panel .dim-stateLabel { display: inline-flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: normal; font-weight: 600; }
.dim-panel .dim-stateDot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #8f959e); box-shadow: none; }
.dim-panel .dim-stateDot[data-tone="success"] { background: var(--dsw-alias-state-success-primary, #20a162); }
.dim-panel .dim-stateDot[data-tone="warning"] { background: var(--dsw-alias-state-warn-primary, #d97706); }
.dim-panel .dim-stateDot[data-tone="error"] { background: var(--dsw-alias-state-error-primary, #d54941); }
.dim-panel .dim-viewActions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 20px; }
.dim-panel .dim-viewActions .bxf-button, .dim-panel .dim-viewActions .dxw-button, .dim-panel .dim-viewActions .ddt-button { min-height: 34px; padding: 0 13px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: none; font: inherit; font-size: 13px; font-weight: 560; line-height: normal; white-space: nowrap; }
.dim-panel .dim-viewActions .bxf-button[data-kind="primary"], .dim-panel .dim-viewActions .dxw-button[data-kind="primary"], .dim-panel .dim-viewActions .ddt-button[data-kind="primary"] { border-color: #1677ff; color: #fff; background: #1677ff; box-shadow: none; }
.dim-panel .dim-viewActions .bxf-button[data-kind="danger"], .dim-panel .dim-viewActions .dxw-button[data-kind="danger"], .dim-panel .dim-viewActions .ddt-button[data-kind="danger"] { color: var(--dsw-alias-state-error-primary, #d54941); }
.dim-panel .dim-qrLayout { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 34px; align-items: start; }
.dim-panel .dim-qrColumn { width: 100%; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 12px; }
.dim-panel .dim-qrFrame { position: relative; width: min(270px, 100%); height: auto; aspect-ratio: 1; display: grid; place-items: center; overflow: hidden; padding: 10px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 16px; background: #fff; }
.dim-panel .dim-qrFrame::before { content: ""; position: absolute; inset: 7px; z-index: 0; border: 1px solid color-mix(in srgb, #1677ff 16%, var(--dsw-alias-border-l2, #dfe1e5)); border-radius: 12px; pointer-events: none; }
.dim-panel .dim-qrFrame::after { display: none; }
.dim-panel .dim-qrFrame img { position: relative; z-index: 1; width: 100%; height: 100%; display: block; object-fit: contain; }
.dim-panel .dim-qrFallback { position: relative; z-index: 1; display: grid; place-items: center; gap: 8px; color: var(--dsw-alias-label-secondary, #646a73); font-size: 13px; line-height: 1.5; text-align: center; }
.dim-panel .dim-qrExpired { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; padding: 20px; color: var(--dsw-static-neutral-bluish-1000, #0f1115); background: rgb(255 255 255 / 92%); font-size: 15px; line-height: 1.6; font-weight: 650; text-align: center; white-space: pre-line; backdrop-filter: blur(3px); }
.dim-panel .dim-countdown { width: min(270px, 100%); margin: 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: normal; }
.dim-panel .dim-countdownTop { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 6px; }
.dim-panel .dim-countdownTop strong { color: var(--dsw-alias-label-primary, #1f2329); font-weight: 650; }
.dim-panel .dim-progress { height: 4px; overflow: hidden; margin: 0; border-radius: 99px; background: var(--dsw-alias-bg-module-platform, #eef0f3); }
.dim-panel .dim-progress span { display: block; width: var(--bxf-progress, var(--dxw-progress, var(--ddt-progress, 0%))); height: 100%; border-radius: inherit; background: #1677ff; transition: width .25s linear; }
.dim-panel .dim-qrCopy { min-width: 0; overflow-wrap: anywhere; }
.dim-panel .dim-qrCopy h3 { margin: 9px 0 8px; color: var(--dsw-alias-label-primary, #1f2329); font-size: 18px; line-height: 1.35; font-weight: 650; }
.dim-panel .dim-qrCopy > p { margin: 0; color: var(--dsw-alias-label-secondary, #646a73); line-height: 1.65; }
.dim-panel .dim-steps { margin: 18px 0 16px; padding: 0; list-style: none; counter-reset: dim-step; }
.dim-panel .dim-steps li { position: relative; min-height: 28px; display: flex; align-items: center; padding: 5px 0 5px 36px; color: var(--dsw-alias-label-secondary, #646a73); line-height: 1.5; counter-increment: dim-step; }
.dim-panel .dim-steps li::before { content: counter(dim-step); position: absolute; left: 0; top: 4px; width: 25px; height: 25px; display: grid; place-items: center; border-radius: 8px; color: #4d93f8; background: color-mix(in srgb, #1677ff 16%, var(--dsw-alias-bg-layer-1, #fff)); font-size: 12px; font-weight: 650; }
.dim-panel .dim-specialView { padding: 32px; text-align: center; }
.dim-panel .dim-statusNotice { display: flex; align-items: flex-start; gap: 10px; padding: 13px 15px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 22%, var(--dsw-alias-border-l2, #dfe1e5)); border-radius: 10px; color: var(--dsw-alias-state-error-primary, #d54941); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 8%, var(--dsw-alias-bg-layer-1, #fff)); font-size: 13px; line-height: 1.5; }
.dim-panel .dim-inlineError { display: flex; align-items: flex-start; flex-direction: column; gap: 10px; padding: 22px; color: var(--dsw-alias-state-error-primary, #d54941); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 8%, var(--dsw-alias-bg-layer-1, #fff)); }
.dim-panel .dim-inlineError > div { min-width: 0; }
.dim-panel .dim-inlineError h3 { margin: 0; color: inherit; font-size: 17px; line-height: 1.35; font-weight: 650; }
.dim-panel .dim-inlineError p { margin: 7px 0 0; color: inherit; line-height: 1.6; }
.dim-panel .dim-confirm { padding: 18px 24px; border-top: 1px solid var(--dsw-alias-border-l1, #eef0f3); background: var(--dsw-alias-interactive-bg-hover, #f7f8fa); }
.dim-panel .dim-confirm strong, .dim-panel .dim-confirm h4 { margin: 0; color: var(--dsw-alias-label-primary, #1f2329); font-size: 14px; line-height: 1.4; font-weight: 650; }
.dim-panel .dim-confirm p { margin: 7px 0 0; color: var(--dsw-alias-label-secondary, #646a73); line-height: 1.6; }
.dim-panel .dim-cardFooter { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 6px; border-top: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.dim-panel .dim-workspace { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) max-content; align-items: center; column-gap: 10px; row-gap: 4px; margin-top: 6px; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 9px; background: var(--dsw-alias-bg-module-platform, #f7f8fa); }
.dim-panel .dim-workspaceHeader { display: contents; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: normal; }
.dim-panel .dim-workspaceHeader > span { grid-column: 1; grid-row: 1; white-space: nowrap; }
.dim-panel .dim-workspaceEdit { grid-column: 2; grid-row: 1; padding: 0; border: 0; color: #1677ff; background: transparent; font: inherit; font-weight: 560; white-space: nowrap; cursor: pointer; }
.dim-panel .dim-workspaceEdit:disabled { cursor: not-allowed; opacity: .55; }
.dim-panel .dim-workspacePath { min-width: 0; max-width: 100%; grid-column: 1 / -1; grid-row: 2; display: block; overflow: hidden; color: var(--dsw-alias-label-primary, #1f2329); font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; white-space: normal; }
.dim-panel .dim-preset { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) max-content; align-items: center; column-gap: 10px; row-gap: 4px; margin-top: 6px; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 9px; background: var(--dsw-alias-bg-module-platform, #f7f8fa); }
.dim-panel .dim-presetHeader { position: relative; min-width: 0; grid-column: 1 / -1; grid-row: 1; display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: normal; }
.dim-panel .dim-presetTitle { min-width: 0; display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.dim-panel .dim-presetHelp { display: inline-flex; align-items: center; flex: none; }
.dim-panel .dim-presetHelpButton { width: 17px; height: 17px; display: grid; place-items: center; padding: 0; border: 1px solid color-mix(in srgb, #1677ff 28%, var(--dsw-alias-border-l2, #dfe1e5)); border-radius: 50%; color: #1677ff; background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; font-size: 11px; line-height: 1; font-weight: 700; cursor: help; transition: border-color .15s ease, color .15s ease, background .15s ease, box-shadow .15s ease; }
.dim-panel .dim-presetHelpButton:hover { border-color: #1677ff; color: #0f5fce; background: color-mix(in srgb, #1677ff 8%, var(--dsw-alias-bg-layer-1, #fff)); }
.dim-panel .dim-presetHelpButton:focus-visible { outline: none; border-color: #1677ff; box-shadow: 0 0 0 3px color-mix(in srgb, #1677ff 16%, transparent); }
.dim-panel .dim-presetTooltip { position: absolute; top: calc(100% + 7px); left: 0; z-index: 30; width: min(320px, 100%); padding: 9px 10px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-3, #fff); box-shadow: 0 10px 28px rgb(31 35 41 / 16%); font-size: 11px; line-height: 16px; font-weight: 400; overflow-wrap: anywhere; white-space: normal; opacity: 0; visibility: hidden; transform: translateY(-3px); pointer-events: none; transition: opacity .15s ease, transform .15s ease, visibility .15s ease; }
.dim-panel .dim-presetHelp:hover .dim-presetTooltip, .dim-panel .dim-presetHelp:focus-within .dim-presetTooltip { opacity: 1; visibility: visible; transform: translateY(0); }
.dim-panel .dim-presetStatus { grid-column: 2; grid-row: 1; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 12px; white-space: nowrap; }
.dim-panel .dim-presetSelect { min-width: 0; max-width: 100%; grid-column: 1 / -1; grid-row: 2; height: 30px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 7px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; font-size: 12px; }
.dim-panel .dim-presetSelect:disabled { cursor: not-allowed; opacity: .55; }
.dim-panel .dim-presetError { grid-column: 1 / -1; grid-row: 3; margin: 0; color: var(--dsw-alias-state-error-primary, #d54941); font-size: 12px; line-height: 1.4; }
.dim-contextEntry { width: 100%; min-height: 40px; display: grid; grid-template-columns: 16px minmax(0, 1fr) max-content 16px; align-items: center; gap: 9px; margin: 10px 0; padding: 8px 11px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-module-platform, #f7f8fa); font: inherit; font-size: 13px; line-height: 20px; text-align: left; cursor: pointer; }
.dim-contextEntry:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #eef0f3); }
.dim-contextEntry > svg { color: var(--dsw-alias-label-secondary, #646a73); }
.dim-contextLabel { min-width: 0; font-weight: 500; overflow-wrap: anywhere; }
.dim-contextStatus { padding: 2px 7px; border-radius: 5px; color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-bg-layer-1, #fff); font-size: 11px; line-height: 16px; font-weight: 400; white-space: nowrap; }
.dim-contextStatus[data-active="true"] { color: var(--dsw-alias-state-business-primary, #3370ff); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3370ff) 10%, var(--dsw-alias-bg-layer-1, #fff)); }
.dim-contextBackdrop { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 12px; background: rgb(15 17 21 / 42%); }
.dim-contextBackdrop, .dim-contextBackdrop *, .dim-contextBackdrop *::before, .dim-contextBackdrop *::after { box-sizing: border-box; }
.dim-contextDialog { width: min(450px, 100%); min-width: 0; max-height: calc(100vh - 24px); max-height: calc(100dvh - 24px); overflow-y: auto; padding: 16px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 12px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-3, #fff); box-shadow: 0 20px 70px rgb(0 0 0 / 20%); font-size: 13px; line-height: 1.5; text-align: left; }
.dim-contextDialog:focus { outline: none; }
.dim-contextHeader, .dim-contextEditorHeader { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dim-contextHeader { position: relative; }
.dim-contextHeaderTitle { min-width: 0; display: inline-flex; align-items: center; gap: 6px; }
.dim-contextHeader h3 { margin: 0; font-size: 15px; line-height: 22px; font-weight: 500; }
.dim-contextHeaderTooltip { width: min(340px, calc(100vw - 72px)); }
.dim-contextClose { width: 30px; height: 30px; flex: none; display: grid; place-items: center; padding: 0; border: 0; border-radius: 6px; color: var(--dsw-alias-label-secondary, #646a73); background: transparent; cursor: pointer; }
.dim-contextClose:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #eef0f3); }
.dim-contextTabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3px; margin-top: 14px; padding: 3px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 8px; background: var(--dsw-alias-bg-module-platform, #f7f8fa); }
.dim-contextTab { min-width: 0; min-height: 34px; padding: 5px 12px; border: 0; border-radius: 6px; color: var(--dsw-alias-label-secondary, #646a73); background: transparent; font: inherit; font-weight: 500; cursor: pointer; transition: color .15s ease, background .15s ease, box-shadow .15s ease; }
.dim-contextTab:hover:not(:disabled):not([aria-selected="true"]) { color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-interactive-bg-hover, #eef0f3); }
.dim-contextTab[aria-selected="true"] { color: var(--dsw-alias-state-business-primary, #3370ff); background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 1px 3px rgb(31 35 41 / 12%); }
.dim-contextTabPanel[hidden] { display: none; }
.dim-contextSection { min-width: 0; margin: 0; padding: 0; border: 0; }
.dim-contextScope { margin-top: 10px; padding: 12px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 9px; background: var(--dsw-alias-bg-layer-1, #fff); }
.dim-contextScopeBlock { margin-top: 12px; }
.dim-contextLegend { position: relative; display: inline-flex; align-items: center; gap: 6px; }
.dim-contextSwitchRow { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 34px; cursor: pointer; }
.dim-contextSwitchLabel { min-width: 0; display: inline-flex; align-items: baseline; gap: 5px; flex-wrap: wrap; }
.dim-contextUnavailable { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; line-height: 16px; font-weight: 400; }
.dim-contextSwitch { appearance: none; flex: none; width: 32px; height: 19px; margin: 0; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 12px; background: var(--dsw-alias-interactive-bg-hover, #eef0f3); cursor: pointer; }
.dim-contextSwitch::before { content: ""; display: block; width: 13px; height: 13px; margin: 2px; border-radius: 50%; background: var(--dsw-alias-label-secondary, #646a73); }
.dim-contextSwitch:checked { border-color: var(--dsw-alias-state-business-primary, #3370ff); background: var(--dsw-alias-state-business-primary, #3370ff); }
.dim-contextSwitch:checked::before { transform: translateX(13px); background: #fff; }
.dim-contextFields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3px 12px; }
.dim-contextField { min-width: 0; min-height: 30px; display: flex; align-items: center; gap: 6px; }
.dim-contextField input { flex: none; width: 14px; height: 14px; margin: 0; accent-color: var(--dsw-alias-state-business-primary, #3370ff); }
.dim-contextFieldText { min-width: 0; display: grid; grid-template-columns: max-content max-content; align-items: center; column-gap: 5px; overflow-wrap: anywhere; }
.dim-contextFieldName { min-width: 0; line-height: 17px; cursor: pointer; }
.dim-contextFieldKey { min-width: 0; grid-column: 1 / -1; color: var(--dsw-alias-label-tertiary, #8f959e); font: 10px/14px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; cursor: pointer; }
.dim-contextFieldHelp { position: relative; }
.dim-contextFieldHelpButton { width: 16px; height: 16px; font-size: 10px; }
.dim-contextTooltip.dim-contextFieldTooltip { top: calc(100% + 6px); right: 0; left: auto; width: min(280px, calc(100vw - 72px)); }
.dim-contextEditorHeader { position: relative; flex-wrap: wrap; }
.dim-contextEditorTitle { min-width: 0; display: inline-flex; align-items: center; gap: 6px; }
.dim-contextEditorTitle > label { font-weight: 500; }
.dim-contextHelp { display: inline-flex; align-items: center; flex: none; }
.dim-contextHelpButton { width: 18px; height: 18px; display: grid; place-items: center; padding: 0; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #3370ff) 30%, var(--dsw-alias-border-l2, #dfe1e5)); border-radius: 50%; color: var(--dsw-alias-state-business-primary, #3370ff); background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; font-size: 11px; line-height: 1; font-weight: 700; cursor: help; transition: border-color .15s ease, color .15s ease, background .15s ease, box-shadow .15s ease; }
.dim-contextHelpButton:hover:not(:disabled) { border-color: var(--dsw-alias-state-business-primary, #3370ff); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3370ff) 8%, var(--dsw-alias-bg-layer-1, #fff)); }
.dim-contextTooltip { position: absolute; top: calc(100% + 7px); left: 0; z-index: 30; width: min(330px, calc(100vw - 72px)); display: grid; gap: 5px; padding: 10px 11px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-3, #fff); box-shadow: 0 10px 28px rgb(31 35 41 / 16%); font-size: 11px; line-height: 16px; font-weight: 400; overflow-wrap: anywhere; white-space: normal; opacity: 0; visibility: hidden; transform: translateY(-3px); pointer-events: none; transition: opacity .15s ease, transform .15s ease, visibility .15s ease; }
.dim-contextTooltip strong { font-weight: 600; }
.dim-contextTooltipExample { padding: 7px 8px; border-radius: 6px; background: var(--dsw-alias-bg-module-platform, #f7f8fa); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }
.dim-contextTooltip.dim-contextLegendTooltip { width: min(350px, calc(100vw - 72px)); }
.dim-contextTooltip.dim-contextGuidanceTooltip { top: auto; bottom: calc(100% + 7px); width: min(380px, calc(100vw - 72px)); max-height: calc(100dvh - 48px); overflow-y: auto; }
.dim-contextHelp:hover .dim-contextTooltip, .dim-contextHelp:focus-within .dim-contextTooltip { opacity: 1; visibility: visible; transform: translateY(0); pointer-events: auto; }
.dim-contextTextActions { display: flex; gap: 10px; margin-left: auto; }
.dim-contextTextActions button { min-height: 30px; padding: 4px 0; border: 0; border-radius: 4px; color: var(--dsw-alias-state-business-primary, #3370ff); background: transparent; font: inherit; font-size: 12px; cursor: pointer; }
.dim-contextTextActions button:hover:not(:disabled) { text-decoration: underline; }
.dim-contextGuidance textarea { display: block; width: 100%; min-height: 88px; margin-top: 7px; padding: 9px 10px; resize: vertical; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 7px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-module-platform, #f7f8fa); font: inherit; font-size: 12px; line-height: 1.6; }
.dim-contextGuidance textarea::placeholder { color: var(--dsw-alias-label-tertiary, #8f959e); opacity: 1; }
.dim-contextHint { margin: 5px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.dim-contextError { margin: 12px 0 0; color: var(--dsw-alias-state-error-primary, #d54941); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.dim-contextFooter { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.dim-contextFooter button { min-height: 34px; padding: 6px 15px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 7px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; cursor: pointer; }
.dim-contextFooter button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #eef0f3); }
.dim-contextFooter .dim-contextSave, .dim-contextFooter .dim-contextSave:hover:not(:disabled) { border-color: var(--dsw-alias-state-business-primary, #3370ff); color: #fff; background: var(--dsw-alias-state-business-primary, #3370ff); }
.dim-contextEntry:focus-visible, .dim-contextDialog button:focus-visible, .dim-contextDialog input:focus-visible, .dim-contextDialog textarea:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3370ff); outline-offset: 2px; }
.dim-contextEntry:disabled, .dim-contextDialog button:disabled, .dim-contextDialog input:disabled, .dim-contextDialog textarea:disabled { opacity: .55; cursor: not-allowed; }
@media (pointer: coarse) {
  .dim-contextEntry, .dim-contextTab, .dim-contextClose, .dim-contextFooter button, .dim-contextTextActions button, .dim-contextField, .dim-contextSwitchRow { min-height: 44px; }
  .dim-contextClose, .dim-contextTextActions button { min-width: 44px; }
  .dim-contextGuidance textarea { font-size: 16px; }
}
.dim-directoryPickerBackdrop { --dim-blue: var(--dsw-alias-state-business-primary, #3370ff); --dim-blue-soft: color-mix(in srgb, var(--dim-blue) 9%, transparent); position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 24px; background: rgb(15 17 21 / 42%); backdrop-filter: blur(3px); }
.dim-directoryPickerBackdrop, .dim-directoryPickerBackdrop *, .dim-directoryPickerBackdrop *::before, .dim-directoryPickerBackdrop *::after { box-sizing: border-box; }
.dim-directoryPicker { width: min(720px, 100%); height: min(620px, calc(100vh - 48px)); min-height: 420px; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 18px; outline: none; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 24px 72px rgb(15 17 21 / 24%); }
.dim-directoryPickerHeader { min-width: 0; padding: 22px 24px 17px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.dim-directoryPickerHeader h3 { margin: 0 0 14px; color: var(--dsw-alias-label-primary, #1f2329); font-size: 20px; line-height: 1.35; font-weight: 680; }
.dim-directoryPickerHeader > p { margin: 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: 13px; }
.dim-directoryCrumbs { min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 4px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dim-directoryCrumbs button { max-width: 210px; overflow: hidden; padding: 3px 5px; border: 0; border-radius: 6px; color: var(--dsw-alias-label-secondary, #646a73); background: transparent; font: inherit; font-size: 12px; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.dim-directoryCrumbs button:hover:not(:disabled) { color: var(--dim-blue); background: var(--dim-blue-soft); }
.dim-directoryCrumbs button[aria-current="page"] { color: var(--dsw-alias-label-primary, #1f2329); font-weight: 650; }
.dim-directoryCrumbs button:focus-visible, .dim-directoryPathInput:focus-visible, .dim-directoryPathControl button:focus-visible, .dim-directoryList button:focus-visible, .dim-directoryPickerActions button:focus-visible { outline: 2px solid color-mix(in srgb, var(--dim-blue) 65%, white); outline-offset: 1px; }
.dim-directoryCrumbSeparator { flex: none; font-size: 12px; }
.dim-directoryPathForm { display: grid; gap: 7px; margin-top: 14px; }
.dim-directoryPathMeta { min-width: 0; display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.dim-directoryPathMeta label { flex: none; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; font-weight: 650; }
.dim-directoryPathMeta span { min-width: 0; overflow: hidden; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.dim-directoryPathControl { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) max-content; gap: 8px; }
.dim-directoryPathInput { min-width: 0; height: 38px; padding: 0 11px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-1, #fff); font: 12px ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; line-height: 38px; }
.dim-directoryPathInput::placeholder { color: var(--dsw-alias-label-tertiary, #8f959e); }
.dim-directoryPathInput:hover:not(:disabled) { border-color: var(--dsw-alias-border-l3, #bbbfc4); }
.dim-directoryPathInput:focus { border-color: var(--dim-blue); }
.dim-directoryPathInput[aria-invalid="true"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 62%, var(--dsw-alias-border-l2, #dfe1e5)); }
.dim-directoryPathControl button { min-height: 38px; padding: 0 14px; border: 1px solid color-mix(in srgb, var(--dim-blue) 30%, var(--dsw-alias-border-l2, #dfe1e5)); border-radius: 8px; color: var(--dim-blue); background: var(--dim-blue-soft); font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; }
.dim-directoryPathControl button:hover:not(:disabled) { border-color: color-mix(in srgb, var(--dim-blue) 48%, var(--dsw-alias-border-l2, #dfe1e5)); background: color-mix(in srgb, var(--dim-blue) 13%, transparent); }
.dim-directoryPathInput:disabled, .dim-directoryPathControl button:disabled { cursor: not-allowed; opacity: .55; }
.dim-directoryPickerBody { min-height: 0; overflow-y: auto; padding: 14px 16px; scrollbar-width: thin; scrollbar-color: var(--dsw-alias-border-l2, #dfe1e5) transparent; }
.dim-directoryList { display: grid; gap: 3px; margin: 0; padding: 0; list-style: none; }
.dim-directoryList button { width: 100%; min-height: 46px; display: grid; grid-template-columns: 24px minmax(0, 1fr) 18px; align-items: center; gap: 10px; padding: 7px 11px; border: 0; border-radius: 9px; color: var(--dsw-alias-label-primary, #1f2329); background: transparent; font: inherit; text-align: left; cursor: pointer; }
.dim-directoryList button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #f7f8fa); }
.dim-directoryList button:disabled, .dim-directoryCrumbs button:disabled { cursor: wait; opacity: .55; }
.dim-directoryFolder { width: 24px; height: 24px; display: grid; place-items: center; color: var(--dsw-alias-label-secondary, #646a73); }
.dim-directoryFolder svg { width: 22px; height: 22px; }
.dim-directoryName { min-width: 0; overflow: hidden; font-size: 14px; line-height: 20px; text-overflow: ellipsis; white-space: nowrap; }
.dim-directoryChevron { width: 18px; height: 18px; display: grid; place-items: center; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dim-directoryChevron svg { width: 17px; height: 17px; }
.dim-directoryPickerState { min-height: 210px; display: grid; place-content: center; justify-items: center; gap: 10px; color: var(--dsw-alias-label-secondary, #646a73); text-align: center; }
.dim-directoryPickerState p { margin: 0; font-size: 13px; line-height: 1.6; }
.dim-directoryPickerSpinner { width: 24px; height: 24px; border: 3px solid var(--dsw-alias-border-l2, #e6e8eb); border-top-color: var(--dim-blue); border-radius: 50%; animation: dim-spin .8s linear infinite; }
.dim-directoryPickerError { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 8px 0 0; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 22%, var(--dsw-alias-border-l2, #dfe1e5)); border-radius: 8px; color: var(--dsw-alias-state-error-primary, #d54941); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 7%, var(--dsw-alias-bg-layer-1, #fff)); font-size: 12px; line-height: 1.5; }
.dim-directoryPickerError button { flex: none; padding: 4px 8px; border: 0; border-radius: 6px; color: inherit; background: transparent; font: inherit; font-weight: 650; cursor: pointer; }
.dim-directoryPickerTruncated { margin: 10px 4px 0; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 12px; line-height: 1.5; }
.dim-directoryPickerFooter { display: grid; grid-template-columns: max-content minmax(0, 1fr) max-content; align-items: center; gap: 14px; padding: 16px 20px; border-top: 1px solid var(--dsw-alias-border-l1, #eef0f3); background: var(--dsw-alias-bg-layer-1, #fff); }
.dim-directoryHidden { display: inline-flex; align-items: center; gap: 7px; padding: 2px 0; border: 0; color: var(--dsw-alias-label-secondary, #646a73); background: transparent; font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer; }
.dim-directoryHidden:focus-visible { outline: 2px solid color-mix(in srgb, var(--dim-blue) 65%, white); outline-offset: 2px; }
.dim-directoryHidden:disabled { cursor: not-allowed; opacity: .52; }
.dim-directoryHiddenBox { position: relative; width: 15px; height: 15px; flex: 0 0 15px; border: 1px solid var(--dsw-alias-border-l2, #c9cdd4); border-radius: 4px; background: var(--dsw-alias-bg-layer-1, #fff); }
.dim-directoryHidden[aria-pressed="true"] .dim-directoryHiddenBox { border-color: var(--dim-blue); background: var(--dim-blue); }
.dim-directoryHidden[aria-pressed="true"] .dim-directoryHiddenBox::after { content: ""; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px; border: solid white; border-width: 0 2px 2px 0; transform: rotate(45deg); }
.dim-directoryPickerNotice { min-width: 0; margin: 0; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; line-height: 1.45; text-align: right; }
.dim-directoryPickerActions { display: flex; gap: 8px; }
.dim-directoryPickerActions button { min-height: 36px; padding: 0 14px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; font-size: 13px; font-weight: 560; white-space: nowrap; cursor: pointer; }
.dim-directoryPickerActions .dim-directoryPickerPrimary { border-color: var(--dim-blue); color: #fff; background: var(--dim-blue); }
.dim-directoryPickerActions button:hover:not(:disabled) { filter: brightness(.97); }
.dim-directoryPickerActions button:disabled { cursor: not-allowed; opacity: .52; }
.dim-panel .dim-cardSummary { min-width: 0; color: var(--dsw-alias-label-secondary, #646a73); font: inherit; font-size: 12px; font-weight: 400; line-height: normal; overflow-wrap: anywhere; white-space: normal; }
.dim-panel .dim-cardFooterLayout { min-width: 0; width: 100%; display: flex; flex-direction: column; align-items: stretch; gap: 9px; }
.dim-panel .dim-inboundRetention { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 10px; }
.dim-panel .dim-inboundRetentionTitle { display: flex; flex-direction: column; gap: 6px; }
.dim-panel .dim-inboundRetentionOption { display: flex; align-items: center; gap: 7px; font: inherit; font-size: 12px; line-height: 18px; color: var(--dsw-alias-text-primary, #1f2329); cursor: pointer; }
.dim-panel .dim-inboundRetentionOption input { margin: 0; }
.dim-panel .dim-inboundRetentionActions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.dim-panel .dim-inboundRetentionSave, .dim-panel .dim-inboundRetentionClear { min-height: 30px; padding: 0 11px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); background: transparent; color: var(--dsw-alias-text-primary, #1f2329); font: inherit; font-size: 12px; cursor: pointer; }
.dim-panel .dim-inboundRetentionSave:disabled, .dim-panel .dim-inboundRetentionClear:disabled { opacity: 0.5; cursor: default; }
.dim-panel .dim-inboundRetentionClear { color: var(--dsw-alias-text-critical, #d83931); border-color: var(--dsw-alias-text-critical, #d83931); }
.dim-panel .dim-inboundRetentionClear:not(:disabled):hover { background: rgba(216, 57, 49, 0.06); }
.dim-panel .dim-cardFooterLayout > .dim-cardActions { align-self: stretch; }
.dim-panel .dim-cardFeedback { width: 100%; padding: 8px 10px; border-radius: 8px; color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-bg-module-platform, #f7f8fa); font: inherit; font-size: 12px; font-weight: 400; line-height: 18px; overflow-wrap: anywhere; white-space: normal; }
.dim-panel .dim-cardActions { flex: none; width: 100%; display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin: 0; }
.dim-panel .dim-cardActions .dim-cardAction { flex: none; min-height: 32px; padding: 0 11px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; font-size: 13px; font-weight: 560; line-height: normal; white-space: nowrap; }
.dim-panel .dim-cardActions .dim-cardAction:hover:not(:disabled) { border-color: #aeb3bb; background: var(--dsw-alias-interactive-bg-hover, #f7f8fa); }
.dim-panel .dim-cardActions .dim-cardAction[data-kind="danger"] { color: var(--dsw-alias-state-error-primary, #d54941); }
.dim-panel .dim-botCard { position: relative; min-width: 0; width: 100%; max-width: 100%; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2, #e5e6eb); border-radius: 14px; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 1px 2px rgb(31 35 41 / 3%); }
.dim-panel .dim-botCard::before { display: none; }
.dim-panel .dim-botCardBody { position: relative; min-width: 0; width: 100%; max-width: 100%; padding: 12px; }
.dim-panel .dim-botCardTop { min-width: 0; max-width: 100%; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.dim-panel .dim-botIdentity { min-width: 0; flex: 1 1 0; display: flex; align-items: center; gap: 10px; }
.dim-panel .dim-botAvatar { flex: none; width: 38px; height: 38px; display: grid; place-items: center; overflow: hidden; border-radius: 11px; box-shadow: none; }
.dim-panel .dim-botAvatar svg { width: 27px; height: 27px; }
.dim-panel .dim-botName { min-width: 0; }
.dim-panel .dim-botName h3 { overflow: hidden; margin: 0; color: var(--dsw-alias-label-primary, #1f2329); font-size: 15px; font-weight: 650; line-height: normal; text-overflow: ellipsis; white-space: nowrap; }
.dim-panel .dim-botName p { overflow: hidden; margin: 4px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font: 12px ui-monospace, SFMono-Regular, monospace; line-height: normal; text-overflow: ellipsis; white-space: nowrap; }
.dim-panel .dim-botCardTools { flex: none; display: flex; align-items: flex-start; gap: 8px; }
.dim-panel .dim-botHealthGroup { min-width: 0; max-width: 100%; flex: none; display: grid; justify-items: end; gap: 5px; }
.dim-panel .dim-botCard .dim-botHealth { flex: none; min-height: 0; display: inline-flex; align-items: center; gap: 7px; padding: 0; border: 0; border-radius: 0; color: var(--dsw-alias-label-secondary, #646a73); background: transparent; font: inherit; font-size: 12px; font-weight: 400; line-height: normal; white-space: nowrap; }
.dim-panel .dim-lastChecked { display: inline-flex; align-items: baseline; gap: 4px; color: var(--dsw-alias-label-tertiary, #8f959e); font: inherit; font-size: 11px; font-weight: 400; line-height: normal; white-space: nowrap; }
.dim-panel .dim-botCard .dim-healthDot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #aeb3bb; box-shadow: none; }
.dim-panel .dim-botCard .dim-healthDot[data-tone="success"] { background: var(--dsw-alias-state-success-primary, #20a162); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary, #20a162) 14%, transparent); }
.dim-panel .dim-botCard .dim-healthDot[data-tone="warning"] { background: var(--dsw-alias-state-warn-primary, #d97706); }
.dim-panel .dim-botCard .dim-healthDot[data-tone="error"] { background: var(--dsw-alias-state-error-primary, #d54941); }
.dim-botSettingsAction { position: relative; flex: none; display: inline-flex; }
.dim-botSettingsButton { width: 32px; height: 32px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 8px; color: var(--dsw-alias-label-secondary, #646a73); background: transparent; cursor: pointer; transition: color .15s ease, background .15s ease; }
.dim-botSettingsButton:hover { color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-interactive-bg-hover, #eef0f3); }
.dim-botSettingsButton:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3370ff); outline-offset: 2px; }
.dim-botSettingsTooltip { position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; width: max-content; padding: 6px 9px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 7px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-3, #fff); box-shadow: 0 8px 24px rgb(31 35 41 / 14%); font-size: 11px; line-height: 16px; opacity: 0; visibility: hidden; transform: translateY(-3px); pointer-events: none; transition: opacity .15s ease, transform .15s ease, visibility .15s ease; }
.dim-botSettingsAction:hover .dim-botSettingsTooltip, .dim-botSettingsAction:focus-within .dim-botSettingsTooltip { opacity: 1; visibility: visible; transform: translateY(0); }
.dim-deliveryPage { min-width: 0; display: grid; }
.dim-deliveryHeader { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.dim-botSettingsTabsBar { min-width: 0; margin-top: 10px; border-bottom: 1px solid var(--dsw-alias-border-l2, #dfe1e5); }
.dim-botSettingsTabs { min-width: 0; display: flex; align-items: flex-end; gap: 24px; overflow-x: auto; scrollbar-width: none; }
.dim-botSettingsTabs::-webkit-scrollbar { display: none; }
.dim-botSettingsTab { position: relative; min-height: 38px; flex: none; display: inline-flex; align-items: center; justify-content: center; padding: 6px 2px 9px; border: 0; color: var(--dsw-alias-label-secondary, #646a73); background: transparent; font: inherit; font-size: 13px; line-height: 20px; font-weight: 560; white-space: nowrap; cursor: pointer; transition: color .15s ease; }
.dim-botSettingsTab::after { content: ''; position: absolute; right: 0; bottom: -1px; left: 0; height: 2px; border-radius: 2px 2px 0 0; background: transparent; transform: scaleX(.45); transition: background .15s ease, transform .15s ease; }
.dim-botSettingsTab:hover:not([aria-selected="true"]) { color: var(--dsw-alias-label-primary, #1f2329); }
.dim-botSettingsTab[aria-selected="true"] { color: var(--dsw-alias-state-business-primary, #3370ff); font-weight: 650; }
.dim-botSettingsTab[aria-selected="true"]::after { background: var(--dsw-alias-state-business-primary, #3370ff); transform: scaleX(1); }
.dim-botSettingsTab:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3370ff); outline-offset: -2px; border-radius: 5px; }
.dim-botSettingsTabPanel { min-width: 0; display: grid; gap: 14px; padding-top: 14px; }
.dim-deliveryDocsLink { min-height: 30px; flex: none; display: inline-flex; align-items: center; gap: 4px; padding: 5px 8px; border-radius: 7px; color: var(--dsw-alias-state-business-primary, #3370ff); font-size: 12px; line-height: 18px; text-decoration: none; white-space: nowrap; }
.dim-deliveryDocsLink:hover { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3370ff) 8%, transparent); }
.dim-deliveryDocsLink:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3370ff); outline-offset: 2px; }
.dim-deliveryButton { min-height: 30px; display: inline-flex; align-items: center; justify-content: center; padding: 5px 10px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; }
.dim-deliveryButton:hover:not(:disabled) { border-color: #aeb3bb; background: var(--dsw-alias-interactive-bg-hover, #eef0f3); }
.dim-deliveryButton:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3370ff); outline-offset: 2px; }
.dim-deliveryButton:disabled { opacity: .5; cursor: not-allowed; }
.dim-deliveryButton[data-kind="primary"] { border-color: var(--dsw-alias-state-business-primary, #3370ff); color: #fff; background: var(--dsw-alias-state-business-primary, #3370ff); }
.dim-deliveryButton[data-kind="danger"] { color: var(--dsw-alias-state-error-primary, #d54941); }
.dim-deliveryBack { flex: none; border-color: transparent; background: transparent; }
.dim-deliveryIdentity, .dim-deliveryTargets { min-width: 0; padding: 16px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 12px; background: var(--dsw-alias-bg-layer-3, #fff); }
.dim-deliveryIdentityHeading { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dim-deliveryBotName, .dim-deliverySectionHeading h3 { min-width: 0; overflow: hidden; margin: 0; font-size: 15px; line-height: 22px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.dim-deliveryIdentity > div:first-child p, .dim-deliverySectionHeading p { margin: 2px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: 18px; }
.dim-deliveryBotId { min-width: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr) max-content; align-items: center; gap: 10px; margin-top: 12px; padding: 10px 12px; border-radius: 9px; background: var(--dsw-alias-bg-module-platform, #f7f8fa); }
.dim-deliveryBotId > span { color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; }
.dim-deliveryBotId code { min-width: 0; overflow: hidden; font: 12px/18px ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
.dim-deliverySectionHeading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.dim-deliveryState { margin-top: 14px; padding: 24px 16px; border: 1px dashed var(--dsw-alias-border-l2, #dfe1e5); border-radius: 10px; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: 19px; text-align: center; }
.dim-deliveryState p { margin: 5px 0; }
.dim-deliveryEmpty strong { color: var(--dsw-alias-label-primary, #1f2329); font-size: 13px; }
.dim-targetList { display: grid; gap: 10px; margin: 14px 0 0; padding: 0; list-style: none; }
.dim-targetRow { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) max-content; gap: 8px 14px; padding: 13px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #fff); }
.dim-targetSummary { min-width: 0; }
.dim-targetTitle { min-width: 0; display: flex; align-items: center; gap: 7px; }
.dim-targetTitle strong { overflow: hidden; font-size: 13px; line-height: 20px; font-weight: 620; text-overflow: ellipsis; white-space: nowrap; }
.dim-targetTitle span { flex: none; padding: 1px 6px; border-radius: 5px; color: var(--dsw-alias-state-business-primary, #3370ff); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3370ff) 9%, transparent); font-size: 10px; line-height: 16px; }
.dim-targetSummary code { display: block; overflow: hidden; margin-top: 3px; color: var(--dsw-alias-label-secondary, #646a73); font: 11px/17px ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
.dim-targetActions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
.dim-targetFeedback { grid-column: 1 / -1; margin: 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: 11px; line-height: 17px; }
.dim-targetFeedback[data-tone="success"] { color: var(--dsw-alias-state-success-primary, #20a162); }
.dim-targetFeedback[data-tone="error"], .dim-targetFormError { color: var(--dsw-alias-state-error-primary, #d54941); }
.dim-targetDeleteConfirm { grid-column: 1 / -1; padding: 10px 12px; border-radius: 8px; background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d54941) 7%, var(--dsw-alias-bg-layer-1, #fff)); }
.dim-targetDeleteConfirm p { margin: 0 0 8px; font-size: 12px; line-height: 18px; }
.dim-targetSuggestions { margin-top: 14px; padding: 14px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 10px; background: var(--dsw-alias-bg-module-platform, #f7f8fa); }
.dim-targetSuggestionHeading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.dim-targetSuggestionHeading h3 { margin: 0; font-size: 14px; line-height: 21px; }
.dim-targetSuggestionHeading p { margin: 2px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: 11px; line-height: 17px; }
.dim-targetSuggestionState { margin-top: 12px; padding: 18px 12px; border: 1px dashed var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: 18px; text-align: center; }
.dim-targetSuggestionState p { margin: 4px 0; }
.dim-targetSuggestionState strong { color: var(--dsw-alias-label-primary, #1f2329); }
.dim-targetSuggestionField { min-width: 0; display: grid; gap: 5px; margin-top: 12px; color: var(--dsw-alias-label-secondary, #646a73); font-size: 11px; line-height: 16px; }
.dim-targetSuggestionField select { width: 100%; min-width: 0; height: 38px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; font-size: 12px; cursor: pointer; }
.dim-targetSuggestionField select:focus { outline: 2px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #3370ff) 28%, transparent); border-color: var(--dsw-alias-state-business-primary, #3370ff); }
.dim-targetForm { margin-top: 14px; padding: 14px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 10px; background: var(--dsw-alias-bg-module-platform, #f7f8fa); }
.dim-targetFormHeading h3 { margin: 0; font-size: 14px; line-height: 21px; }
.dim-targetFormHeading p { margin: 2px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: 11px; line-height: 17px; }
.dim-targetFormGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 11px 12px; margin-top: 12px; }
.dim-targetField { min-width: 0; display: grid; align-content: start; gap: 5px; color: var(--dsw-alias-label-secondary, #646a73); font-size: 11px; line-height: 16px; }
.dim-targetField input, .dim-targetField select { width: 100%; min-width: 0; height: 34px; padding: 0 9px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 7px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; font-size: 12px; }
.dim-targetField input:focus, .dim-targetField select:focus { outline: 2px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #3370ff) 28%, transparent); border-color: var(--dsw-alias-state-business-primary, #3370ff); }
.dim-targetField input[readonly] { color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-bg-module-platform, #f7f8fa); }
.dim-targetFormError { margin: 10px 0 0; font-size: 12px; line-height: 18px; }
.dim-targetFormActions { display: flex; justify-content: flex-end; gap: 7px; margin-top: 12px; }
.dim-accessPage { min-width: 0; display: grid; gap: 14px; }
.dim-accessScene { position: relative; min-width: 0; margin: 0; padding: 16px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 12px; background: var(--dsw-alias-bg-layer-3, #fff); }
.dim-accessScene > legend { padding: 0 6px; color: var(--dsw-alias-label-primary, #1f2329); font-size: 15px; line-height: 22px; font-weight: 650; }
.dim-accessLegendContent { display: inline-flex; align-items: center; gap: 6px; }
.dim-panel .dim-accessLegendHelp { position: static; }
.dim-accessLegendHelp .dim-channelTooltip { top: 20px; right: auto; left: 16px; width: min(320px, calc(100% - 32px)); max-width: none; }
.dim-accessControls { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.dim-accessControls[data-mode="allowlist"] { grid-template-columns: minmax(0, 1fr); }
.dim-accessField { min-width: 0; display: grid; align-content: start; gap: 5px; color: var(--dsw-alias-label-secondary, #646a73); font-size: 11px; line-height: 16px; }
.dim-accessField input, .dim-accessField select { width: 100%; min-width: 0; height: 36px; padding: 0 9px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 7px; color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; font-size: 12px; }
.dim-accessField input:focus, .dim-accessField select:focus { outline: 2px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #3370ff) 28%, transparent); border-color: var(--dsw-alias-state-business-primary, #3370ff); }
.dim-accessUsers { min-width: 0; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.dim-accessUsersHeading { position: relative; min-width: 0; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.dim-accessUsersHeading > div { min-width: 0; }
.dim-accessUsersTitle { display: inline-flex; align-items: center; gap: 6px; }
.dim-accessUsersHeading strong { color: var(--dsw-alias-label-primary, #1f2329); font-size: 13px; line-height: 20px; font-weight: 620; }
.dim-accessUsersHeading p { margin: 2px 0 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: 11px; line-height: 17px; }
.dim-panel .dim-accessUsersHelp { position: static; }
.dim-accessUsersHelp .dim-channelTooltip { top: calc(100% + 7px); right: auto; left: 0; width: min(320px, 100%); max-width: none; }
.dim-accessAddUser { width: 32px; height: 32px; min-height: 32px; flex: 0 0 32px; padding: 0; font-size: 20px; line-height: 1; }
.dim-accessUsersEmpty { margin-top: 10px; padding: 15px 12px; border: 1px dashed var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 12px; line-height: 18px; text-align: center; }
.dim-accessUserList { display: grid; gap: 9px; margin: 10px 0 0; padding: 0; list-style: none; }
.dim-accessUserRow { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(145px, 180px) max-content; align-items: end; gap: 10px; padding: 11px; border: 1px solid var(--dsw-alias-border-l1, #eef0f3); border-radius: 9px; background: var(--dsw-alias-bg-module-platform, #f7f8fa); }
.dim-accessDeleteUser { margin-bottom: 1px; }
.dim-accessUnsupported { padding: 18px 14px; border: 1px dashed var(--dsw-alias-border-l2, #dfe1e5); border-radius: 9px; color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-bg-module-platform, #f7f8fa); text-align: center; }
.dim-accessUnsupported strong { color: var(--dsw-alias-label-primary, #1f2329); font-size: 13px; line-height: 20px; }
.dim-accessUnsupported p { margin: 4px 0 0; font-size: 12px; line-height: 18px; }
.dim-accessState { padding: 11px 13px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 24%, var(--dsw-alias-border-l2, #dfe1e5)); border-radius: 9px; color: var(--dsw-alias-state-warn-primary, #d97706); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 7%, var(--dsw-alias-bg-layer-1, #fff)); font-size: 12px; line-height: 18px; }
.dim-accessFeedback { margin: 0; padding: 10px 12px; border-radius: 8px; color: var(--dsw-alias-label-secondary, #646a73); background: var(--dsw-alias-bg-module-platform, #f7f8fa); font-size: 12px; line-height: 18px; }
.dim-accessFeedback[data-tone="success"] { color: var(--dsw-alias-state-success-primary, #20a162); }
.dim-accessFeedback[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #d54941); }
.dim-accessActions { display: flex; justify-content: flex-end; }
.dim-panel .dim-botCard .dim-cardFooter { margin-top: 0; }
.dim-panel .ddt-headingCopy { display: none; }
.dim-panel .ddt-qrFrame, .dim-panel .ddt-countdown { width: min(270px, 100%); }
@container (max-width: 680px) {
  .dim-panel .bxf-headingTools, .dim-panel .dxw-tools, .dim-panel .ddt-tools { gap: 6px; }
  .dim-panel .dim-bindActions { gap: 6px; }
  .dim-panel .bxf-headingTools .dim-scanButton, .dim-panel .dxw-tools .dim-scanButton, .dim-panel .ddt-tools .dim-scanButton, .dim-panel .dim-credentialButton { gap: 5px; padding-inline: 8px; font-size: 12px; }
  .dim-panel .dim-actionIcon { width: 13px; height: 13px; flex-basis: 13px; }
  .dim-panel .bxf-headingTools .dim-onlineBadge, .dim-panel .dxw-tools .dim-onlineBadge, .dim-panel .ddt-tools .dim-onlineBadge { padding-inline: 8px; font-size: 11px; }
  .dim-panel .dim-credentialForm { grid-template-columns: minmax(0, 1fr); }
  .dim-panel .dim-credentialError, .dim-panel .dim-credentialActions { grid-column: auto; }
  .dim-panel .dim-emptyView { min-height: 0; grid-template-columns: minmax(0, 1fr); }
  .dim-panel .dim-emptyBrand { display: none; }
  .dim-panel .dim-qrLayout { grid-template-columns: minmax(0, 1fr); justify-items: center; gap: 24px; }
  .dim-panel .dim-qrColumn { width: 100%; min-width: 0; }
  .dim-panel .dim-qrCopy { width: 100%; min-width: 0; overflow-wrap: anywhere; }
  .dim-panel .ddt-qrLayout { grid-template-columns: minmax(0, 1fr); justify-items: center; gap: 24px; }
  .dim-panel .ddt-qrColumn { width: 100%; min-width: 0; }
  .dim-panel .ddt-qrCopy { width: 100%; min-width: 0; overflow-wrap: anywhere; }
  .dim-targetRow { grid-template-columns: minmax(0, 1fr); }
  .dim-targetActions { justify-content: flex-start; }
  .dim-targetFormGrid { grid-template-columns: minmax(0, 1fr); }
  .dim-targetSuggestionHeading { align-items: stretch; flex-direction: column; }
  .dim-accessControls { grid-template-columns: minmax(0, 1fr); }
  .dim-accessUserRow { grid-template-columns: minmax(0, 1fr); }
  .dim-accessDeleteUser { justify-self: start; }
}
@media (max-width: 840px) {
  .dim-title { align-items: flex-start; }
  .dim-layout { grid-template-columns: minmax(0, 1fr); gap: 18px; }
  .dim-rail { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dim-divider { display: none; }
  .dim-rail { max-height: none; overflow: visible; padding-right: 1px; }
  .dim-channel { min-height: 48px; }
}
@media (max-width: 560px) {
  .dim-title { flex-direction: column; gap: 10px; }
  .dim-title p { white-space: normal; }
  .dim-titleActions { justify-content: flex-start; }
  .dim-updateBackdrop { padding: 12px; }
  .dim-updateDialog { max-height: calc(100vh - 24px); }
  .dim-updateDialog h3 { margin: 18px 18px 8px; }
  .dim-updateDescription { margin: 0 18px; }
  .dim-updateBody { padding: 16px 18px; }
  .dim-updateFooter { padding: 12px 18px; }
  .dim-githubTooltip { right: auto; left: 0; }
  .dim-rail { grid-template-columns: minmax(0, 1fr); }
  .dim-loopbackRecovery { align-items: stretch; flex-direction: column; gap: 12px; }
  .dim-loopbackRecoveryAction { width: 100%; }
  .dim-deliverySectionHeading { align-items: stretch; flex-direction: column; }
  .dim-botSettingsTabs { gap: 18px; }
  .dim-deliveryBotId { grid-template-columns: minmax(0, 1fr) max-content; }
  .dim-deliveryBotId > span { grid-column: 1 / -1; }
  .dim-targetActions .dim-deliveryButton { flex: 1 1 auto; }
  .dim-accessActions .dim-deliveryButton { width: 100%; }
  .dim-directoryPickerBackdrop { padding: 10px; }
  .dim-directoryPicker { height: calc(100vh - 20px); min-height: 0; border-radius: 14px; }
  .dim-directoryPickerHeader { padding: 18px 17px 14px; }
  .dim-directoryPickerHeader h3 { font-size: 18px; }
  .dim-directoryPathMeta span { display: none; }
  .dim-directoryPickerBody { padding: 10px; }
  .dim-directoryPickerFooter { grid-template-columns: minmax(0, 1fr) max-content; gap: 10px; padding: 13px 14px; }
  .dim-directoryPickerNotice { grid-column: 1 / -1; grid-row: 1; text-align: left; }
}
@media (prefers-reduced-motion: reduce) {
  .dim-page * { transition-duration: .01ms !important; }
  .dim-directoryPickerSpinner { animation-duration: 1.8s; }
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
