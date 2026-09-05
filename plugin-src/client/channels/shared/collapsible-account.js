/**
 * Collapsible per-account card, shared by every IM channel.
 *
 * When several accounts are connected, each account's workspace / preset /
 * context-enhancement editors make the list extremely long. This component
 * renders the account header as the toggle itself: collapsed, the card shows
 * only the header line; clicking the header expands the settings details.
 *
 * Design notes:
 * - The whole header is the toggle (click + keyboard). Buttons rendered inside
 *   the header must call stopPropagation so they keep their own behaviour.
 * - A chevron sits at the end of the header line as the affordance.
 * - Height animation uses grid-template-rows: 0fr -> 1fr (pure CSS).
 * - Full a11y: the header is a button-like region with aria-expanded /
 *   aria-controls; the details region keeps native semantics.
 * - Honors prefers-reduced-motion.
 * - Styles are managed by the IM settings plugin, not individual accounts.
 */
import * as React from 'react';
import { h } from '../../i18n.js';

/**
 * Collapsible account card.
 *
 * `header` renders the always-visible header line; clicking it toggles.
 * Any interactive control inside the header should stop the click event so it
 * does not toggle the section (e.g. the bot settings button).
 * `children` is the collapsed details region.
 */
export function CollapsibleAccountSection({
  header,
  defaultOpen = false,
  open: controlledOpen,
  onToggle,
  id,
  className = '',
  children,
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const open = controlledOpen ?? uncontrolledOpen;
  const contentId = id ? `${id}-content` : undefined;

  const toggle = () => {
    if (controlledOpen === undefined) setUncontrolledOpen((value) => !value);
    onToggle?.(!open);
  };

  const onKeyDown = (event) => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      toggle();
    }
  };

  return h('div', {
    className: `dim-collapsibleAccount ${open ? 'is-open' : ''} ${className}`.trim(),
    'data-open': open ? 'true' : 'false',
  },
    h('div', {
      className: 'dim-collapsibleHead',
      role: 'button',
      tabIndex: 0,
      onClick: toggle,
      onKeyDown,
      'aria-expanded': open ? 'true' : 'false',
      'aria-controls': contentId,
      'aria-label': open ? '收起该账号的设置' : '展开该账号的设置',
    },
      h('div', { className: 'dim-collapsibleHeaderContent' }, header),
      h('span', { className: 'dim-collapsibleChevron', 'aria-hidden': 'true' }),
    ),
    h('div', {
      id: contentId,
      className: 'dim-collapsibleBody',
      role: 'region',
    },
      h('div', { className: 'dim-collapsibleBodyInner' }, children),
    ),
  );
}
