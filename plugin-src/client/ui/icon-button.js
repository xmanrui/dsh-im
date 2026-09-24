/**
 * IconButton：issue #247 (d) 的图标形按钮——28px、无边框、透明底、
 * `var(--dsw-alias-label-tertiary)` 文字色。官方 primitives 不导出图标按钮，
 * 因此按官方面板里的同一批规格 refork。
 */

import { h } from '../i18n.js';
import { cx } from './cx.js';

export const ICON_BUTTON_VARIANTS = Object.freeze(['default', 'action', 'round', 'toolbar']);

/**
 * 渲染图标按钮。
 * @param props.variant 几何/配色变体。
 * @param props.label 无障碍名称；同时作为 `title` 的回退（调用方通常会显式给 title）。
 * @param props.title 可选悬停文案；默认取 `label`。
 */
export function IconButton({
  variant = 'default',
  label,
  title,
  className,
  children,
  ...rest
}) {
  return h('button', {
    type: 'button',
    className: cx('dim-ui-icon-button', variant !== 'default' && `dim-ui-icon-button--${variant}`, className),
    'aria-label': label,
    title: title ?? label,
    ...rest,
  }, children);
}
