/**
 * refork 组件的样式：官方未导出（或 0.1.5 缺失）的组件，按官方几何与 `--dsw-*`
 * token 复刻，注入为一张 `<style>` 标签。
 *
 * 官方拥有实现的组件（Button 官方变体、Switch、Tag、Input、Tooltip、Modal、Menu …）
 * 的样式**不在这里**：它们由官方包自己的样式表提供，本插件只负责转发。
 *
 * 依据：issue #247 给出的官方规格，以及 dsh-tauri-ui `components/` 下的同源 refork。
 *
 * NOTE: the CSS below is a template literal, so every comment inside it must stay
 * ASCII — the bilingual projection test (`every shipped Chinese client string has
 * an English projection`) harvests Han characters out of string literals.
 */

export const IM_UI_STYLE_ID = 'xmanrui-dsh-im-ui';

const CSS = String.raw`
/* ---------------------------------------------------------------------------
 * Button -- the official Button only ships primary / ghost / outline / toolbar;
 * these variants refork the button spec found in official compound components
 * (see upstreamPath in registry.js).
 * ------------------------------------------------------------------------- */
.dim-ui-button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; margin: 0; font: inherit; cursor: pointer; }
.dim-ui-button:disabled { cursor: not-allowed; }

/* Sidebar "new session" large button. */
.dim-ui-button--elevated {
  flex: none; gap: 6px; width: 100%; height: 38px; padding: 8px 16px;
  font-size: 14px; font-weight: 500; line-height: 22px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-button-elevated-fill);
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 12px; overflow: hidden;
}
.dim-ui-button--elevated:hover:not(:disabled) { background: var(--dsw-alias-button-floating-hover); }
.dim-ui-button--elevated:disabled { opacity: 0.5; }

/* Plugin-page "add" pill: primary solid / transparent. */
.dim-ui-button--add, .dim-ui-button--addGhost {
  height: 32px; padding: 0 12px; font-size: 13px; line-height: 20px;
  border: none; border-radius: 16px;
}
.dim-ui-button--add { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dim-ui-button--add:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dim-ui-button--add:disabled { opacity: 0.4; }
.dim-ui-button--addGhost { background: transparent; color: var(--dsw-alias-label-primary); }
.dim-ui-button--addGhost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dim-ui-button--addGhost:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
.dim-ui-button--addGhost:disabled { opacity: 0.4; }

/* Destructive action: transparent fill + error color. */
.dim-ui-button--danger {
  height: 36px; padding: 0 14px;
  font-size: 14px; line-height: 22px;
  color: var(--dsw-alias-state-error-primary);
  background: transparent;
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent);
  border-radius: 18px;
  --dsw-alias-interactive-bg-hover: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
}
.dim-ui-button--danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dim-ui-button--danger:disabled { opacity: 0.4; }
.dim-ui-button--danger.dim-ui-button--sm { height: 28px; padding: 0 10px; font-size: 12px; line-height: 18px; border-radius: 14px; }

/* ---------------------------------------------------------------------------
 * IconButton -- issue #247 (d): 28px, no border, transparent fill, tertiary label.
 * ------------------------------------------------------------------------- */
.dim-ui-icon-button {
  box-sizing: border-box; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; margin: 0;
  border: none; border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.dim-ui-icon-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dim-ui-icon-button:disabled { cursor: default; opacity: 0.4; }
.dim-ui-icon-button:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }
/* Round: in-message icon actions (reforked from MessageIconActions). */
.dim-ui-icon-button--action { border-radius: 28px; padding: 6px; }
.dim-ui-icon-button--action:hover:not(:disabled) { color: var(--dsw-alias-label-secondary); }

/* ---------------------------------------------------------------------------
 * Checkbox -- absent from 0.1.5 entirely; whole component reforked from the
 * official 0.1.7 spec.
 * ------------------------------------------------------------------------- */
.dim-ui-checkbox { display: inline-flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-primary); cursor: pointer; font-size: 14px; line-height: 22px; }
.dim-ui-checkbox__input { box-sizing: border-box; flex: none; width: 16px; height: 16px; margin: 0; accent-color: var(--dsw-alias-button-primary-fill); cursor: inherit; }
.dim-ui-checkbox__input:focus-visible { outline: 2px solid var(--dsw-alias-border-l3); outline-offset: 1px; }
.dim-ui-checkbox__label { min-width: 0; color: var(--dsw-alias-label-secondary); }
.dim-ui-checkbox:has(> .dim-ui-checkbox__input:disabled) { cursor: not-allowed; opacity: 0.5; }

/* ---------------------------------------------------------------------------
 * SegmentedControl -- missing on 0.1.5; whole component reforked from the
 * official 0.1.7 spec.
 * ------------------------------------------------------------------------- */
.dim-ui-segmented { box-sizing: border-box; display: inline-flex; align-items: center; gap: 2px; padding: 2px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
.dim-ui-segmented__segment { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 24px; padding: 0 10px; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; white-space: nowrap; }
.dim-ui-segmented__segment:hover:not(:disabled):not([aria-selected="true"]) { background: var(--dsw-alias-interactive-bg-hover); }
.dim-ui-segmented__segment[aria-selected="true"] { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); }
.dim-ui-segmented__segment:disabled { cursor: default; opacity: 0.4; }
.dim-ui-segmented__segment:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }

/* ---------------------------------------------------------------------------
 * Channel card grid -- the Lobe-style entry page (issue #247 (h)): a grouped
 * card grid, click a card to enter that channel's config page.
 * ------------------------------------------------------------------------- */
.dim-providers { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
.dim-providerGroup { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.dim-providerGroupTitle { display: flex; align-items: baseline; gap: 8px; margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; line-height: 20px; }
.dim-providerGroupCount { color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.dim-providerGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; min-width: 0; }
.dim-providerCard { box-sizing: border-box; display: grid; grid-template-columns: 28px minmax(0, 1fr) max-content; align-items: center; gap: 10px; width: 100%; padding: 12px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 12px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer; }
.dim-providerCard:hover { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-border-l3); }
.dim-providerCard:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary); }
.dim-providerCardCopy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dim-providerCardName { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 13px; font-weight: 500; line-height: 20px; }
.dim-providerCardNote { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.dim-providerCardDesc { overflow: hidden; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; }
.dim-providerCardBadge { flex: none; }
/* The card is narrow in the desktop side panel; drop the badge rather than
   letting the description collapse to an ellipsis. */
@container (max-width: 420px) { .dim-providerCardBadge { display: none; } }

/* Drill-down header shown above a channel's config page. */
.dim-channelHeader { display: flex; align-items: center; gap: 10px; min-width: 0; }
.dim-channelHeaderCopy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dim-channelHeaderName { font-size: 14px; font-weight: 600; line-height: 22px; }
.dim-channelHeaderNote { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }

/* ---------------------------------------------------------------------------
 * Panel skeleton -- aligned with the official plugin-page geometry; corrects
 * the oversized type and spacing from issue #247 (g).
 * ------------------------------------------------------------------------- */
.dim-page { box-sizing: border-box; display: flex; flex-direction: column; gap: 20px; min-height: 0; height: 100%; container-type: inline-size; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; }
.dim-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.dim-brand { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dim-brandHeading { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.dim-brandName { font-size: 16px; font-weight: 600; line-height: 24px; }
.dim-brandVersion { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 20px; font-variant-numeric: tabular-nums; }
.dim-brand p { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 20px; }
.dim-titleActions { display: flex; align-items: center; gap: 4px; flex: none; }

.dim-layout { display: block; min-width: 0; }
.dim-panel { min-width: 0; display: flex; flex-direction: column; gap: 16px; }
/* Logo geometry and brand colours live in the legacy sheet: the same
   .dim-logo<Name> hooks are used by the provider grid and by the per-bot cards. */
@container (max-width: 420px) { .dim-providerGrid { grid-template-columns: minmax(0, 1fr); } }

.dim-loopbackRecovery { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-state-warn-primary); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
.dim-loopbackRecoveryCopy { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: 13px; }
.dim-loopbackRecoveryCopy p { margin: 0; color: var(--dsw-alias-label-secondary); }
.dim-loopbackRecoveryCopy code { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dim-loopbackRecoveryAction { flex: none; height: 28px; padding: 0 12px; border: none; border-radius: 14px; background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); font: inherit; font-size: 13px; cursor: pointer; }

@media (prefers-reduced-motion: reduce) { .dim-page * { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; } }
`;

/**
 * 注入 refork 样式表。
 * @returns 卸载函数；非浏览器环境为空操作。
 */
export function installUiStyles() {
  if (typeof document === 'undefined') return () => {};
  const existing = document.querySelector(`style[data-plugin-css="${IM_UI_STYLE_ID}"]`);
  if (existing) return () => {};
  const style = document.createElement('style');
  style.dataset.plugin = '@xmanrui/dsh-im';
  style.dataset.pluginCss = IM_UI_STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => style.remove();
}
