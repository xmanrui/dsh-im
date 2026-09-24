/**
 * Button：官方 `Button` 的直通 + 官方没有的变体的 refork。
 *
 * 单一组件内分发：官方变体（primary / ghost / outline / toolbar）原样交给官方实现，
 * 因此拿到的是完全一致的官方样式与无障碍语义；本插件独有的变体（elevated / add /
 * addGhost / danger）走 `ui/styles.js` 里按官方几何复刻的样式。
 */

import { h } from '../i18n.js';
import { Button as PrimitiveButton } from '@deepseek-ai/dsh-client-ui-primitives';
import { cx } from './cx.js';

/** 官方变体。 */
export const OFFICIAL_BUTTON_VARIANTS = Object.freeze(['primary', 'ghost', 'outline', 'toolbar']);
/** 本插件复刻的变体。 */
export const REFORK_BUTTON_VARIANTS = Object.freeze(['elevated', 'add', 'addGhost', 'danger']);

const REFORK = new Set(REFORK_BUTTON_VARIANTS);

/**
 * 渲染按钮。
 * @param props.variant 视觉族；官方与 refork 变体共用同一个属性。
 * @param props.size `md`（36px 胶囊）或 `sm`（28px 紧凑）。
 * @param props.icon 可选的前置 16px 图标节点。
 * @param props.block 是否占满一行（refork 变体用 elevanted 时本就占满）。
 */
export function Button({
  variant = 'ghost',
  size = 'md',
  icon,
  block = false,
  className,
  children,
  ...rest
}) {
  if (!REFORK.has(variant)) {
    return h(PrimitiveButton, { variant, size, icon, className, ...rest }, children);
  }
  return h('button', {
    type: 'button',
    className: cx('dim-ui-button', `dim-ui-button--${variant}`, `dim-ui-button--${size}`, block && 'dim-ui-button--block', className),
    ...rest,
  }, icon, children);
}
