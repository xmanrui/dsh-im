/**
 * A setting row's selector, in the form the host itself uses.
 *
 * The host splits this by role, and the split is measurable:
 * - A selector that owns a whole row (General -> Language, theme, layout, queue) is a
 *   button[aria-haspopup=menu] with a portaled list, right-aligned to the trigger and
 *   4px under it. Measured live: trigger right 1096, list right 1096, list top =
 *   trigger bottom + 4, position fixed, z-index 1100, radius 20, white, padding 4.
 * - An enum inside a .field (label above, control below) is a real select, skinned by
 *   .input + .selectInput (settings-models bundle:1300-1305, :1680-1685, :2093-2098).
 *
 * This component is the first of those two. It exists because a select cannot follow
 * the row form: its option list is drawn by the operating system, so it ignores every
 * token, every theme and the container query the rest of the page obeys.
 *
 * The caller keeps its own class name, so the sheet still owns the skin through the
 * element-agnostic .dim-rowControl.
 */
import * as React from 'react';
import { createPortal } from 'react-dom';
import { h } from './i18n.js';
import { CheckGlyph } from './ui-glyphs.js';

function chevron(open = false) {
  return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true,
    className: 'dim-modelChevron', style: open ? { transform: 'rotate(90deg)' } : undefined },
  h('path', { d: 'm6 4 4 4-4 4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }));
}

export function RowSelect({ value, options, disabled = false, label, onChange, className = 'dim-rowControl' }) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState(null);
  const id = React.useId();
  const triggerRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const selected = options.find((option) => option.value === value);

  React.useEffect(() => {
    if (!open) { setPos(null); return undefined; }
    const place = () => {
      const trigger = triggerRef.current?.getBoundingClientRect?.();
      if (!trigger) return;
      setPos({ top: trigger.bottom + 4, right: Math.max(8, globalThis.innerWidth - trigger.right) });
    };
    place();
    const checked = menuRef.current?.querySelector('[aria-checked="true"]')
      ?? menuRef.current?.querySelector('[role="menuitemradio"]');
    checked?.focus();
    // The list is portaled out of this component, so it needs its own containment test
    // or pressing an item would read as an outside click and close the list.
    const outside = (event) => {
      if (triggerRef.current?.contains(event.target)) return;
      if (menuRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    globalThis.document?.addEventListener('mousedown', outside);
    const view = globalThis.window;
    view?.addEventListener?.('resize', place);
    view?.addEventListener?.('scroll', place, true);
    return () => {
      globalThis.document?.removeEventListener('mousedown', outside);
      view?.removeEventListener?.('resize', place);
      view?.removeEventListener?.('scroll', place, true);
    };
  }, [open]);

  // Focus lives in the list, so its keys never bubble back through the row.
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); setOpen(false); triggerRef.current?.focus(); return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...(menuRef.current?.querySelectorAll('[role="menuitemradio"]:not(:disabled)') ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(globalThis.document?.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  const trigger = h('button', {
    type: 'button', ref: triggerRef, className, disabled,
    'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': open,
    'aria-controls': open ? `${id}-menu` : undefined,
    onClick: () => setOpen((current) => !current),
  },
  h('span', { className: 'dim-modelValue', title: selected?.label ?? '' }, selected?.label ?? ''),
  chevron(open));

  const menu = open ? h('div', {
    ref: menuRef, id: `${id}-menu`, role: 'menu', 'aria-label': label, onKeyDown,
    className: 'dim-modelMenu',
    style: pos ? { top: pos.top, right: pos.right } : undefined,
  }, options.map((option) => h('button', {
    key: option.value, type: 'button', role: 'menuitemradio',
    'aria-checked': option.value === value, className: 'dim-modelOption', disabled: option.disabled,
    onClick: () => {
      setOpen(false);
      triggerRef.current?.focus();
      if (option.value !== value) onChange(option.value);
    },
  },
  h('span', { className: 'dim-modelOptionCopy' },
    h('span', { className: 'dim-modelOptionName' }, option.label),
    option.description ? h('span', { className: 'dim-modelDescription' }, option.description) : null),
  h('span', { className: 'dim-modelCheck', 'aria-hidden': true },
    option.value === value ? h(CheckGlyph, { size: 16 }) : null)))) : null;

  const portalTarget = globalThis.document?.body ?? null;
  return h(React.Fragment, null, trigger,
    menu && portalTarget ? createPortal(menu, portalTarget) : menu);
}
