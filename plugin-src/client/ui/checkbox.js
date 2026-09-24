/**
 * Checkbox：官方 0.1.7 起才导出，0.1.5-rc.1 基线上取到 `undefined` 会触发
 * React #130（`Element type is invalid …`），因此整组件按官方规格 refork，
 * 两代内核渲染同一份 DOM 与样式。
 *
 * 官方签名是 `{ checked, onChange, label, disabled, title, className }`（label 是
 * 字符串）。这里放宽为 `children`，让调用点可以传任意可见标签节点；
 * 无障碍名称仍通过 `aria-label` 显式给出。
 */

import { h } from '../i18n.js';
import { cx } from './cx.js';

/**
 * 渲染带标签的原生复选框。
 * @param props.checked 当前选中态（受控）。
 * @param props.onChange 收到请求的选中态。
 * @param props.label 无障碍名称。
 * @param props.title 可选悬停文案。
 */
export function Checkbox({
  checked,
  onChange,
  label,
  title,
  disabled = false,
  className,
  children,
  ...rest
}) {
  return h('label', {
    className: cx('dim-ui-checkbox', className),
    title,
    ...rest,
  },
  h('input', {
    type: 'checkbox',
    className: 'dim-ui-checkbox__input',
    checked,
    disabled,
    'aria-label': label,
    onChange: (event) => onChange(event.target.checked),
  }),
  children === undefined || children === null
    ? null
    : h('span', { className: 'dim-ui-checkbox__label' }, children));
}
