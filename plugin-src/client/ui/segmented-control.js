/**
 * SegmentedControl：官方 0.1.7 起才导出，0.1.5-rc.1 基线上缺失，因此按官方规格
 * 整组件 refork（含 roving focus 与方向键/Home/End 走查）。
 *
 * 与官方契约一致：`id` 是调用方的基础 id，每个分段是 `<id>-<value>` 并声明它控制的
 * `<id>-<value>-panel`；`onChange` 永远不会带着「已经选中的值」触发。
 */

import { h } from '../i18n.js';
import { cx } from './cx.js';

/**
 * 渲染分段控件。
 * @param props.id 调用方基础 id。
 * @param props.value 当前选中值（受控）。
 * @param props.options 分段定义，至少两项，顺序即展示顺序。
 * @param props.onChange 收到被请求的值。
 * @param props.label tablist 的无障碍名称。
 * @param props.disabled 锁住全部分段。
 */
export function SegmentedControl({
  id,
  value,
  options,
  onChange,
  label,
  disabled = false,
  className,
}) {
  const move = (from, delta) => {
    const count = options.length;
    for (let step = 1; step <= count; step += 1) {
      const index = (from + delta * step + count * step) % count;
      const option = options[index];
      if (!option?.disabled) return index;
    }
    return from;
  };

  const onKeyDown = (event, index) => {
    let next = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = move(index, 1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = move(index, -1);
    else if (event.key === 'Home') next = move(0, 1);
    else if (event.key === 'End') next = move(options.length - 1, -1);
    if (next === null || next === index) return;
    event.preventDefault();
    const option = options[next];
    if (disabled || option.disabled || option.value === value) return;
    onChange(option.value);
    event.currentTarget.parentElement
      ?.querySelector(`[data-segment-index="${next}"]`)
      ?.focus();
  };

  return h('div', {
    className: cx('dim-ui-segmented', className),
    role: 'tablist',
    'aria-label': label,
  }, options.map((option, index) => h('button', {
    key: option.value,
    type: 'button',
    id: `${id}-${option.value}`,
    role: 'tab',
    'data-segment-index': index,
    className: 'dim-ui-segmented__segment',
    'aria-selected': option.value === value,
    'aria-controls': `${id}-${option.value}-panel`,
    tabIndex: option.value === value ? 0 : -1,
    disabled: disabled || option.disabled === true,
    title: option.title,
    onClick: () => {
      if (option.value !== value) onChange(option.value);
    },
    onKeyDown: (event) => onKeyDown(event, index),
  }, option.label)));
}
