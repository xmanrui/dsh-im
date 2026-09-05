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
 * - Styles are injected once per document (data-plugin-css guard).
 */
import * as React from 'react';
import { h } from '../../i18n.js';

const COLLAPSIBLE_STYLE_ID = 'xmanrui-dsh-im-collapsible-account';

const CSS = String.raw`
.dim-collapsibleAccount { min-width: 0; display: flex; flex-direction: column; }

/* The header row is the toggle: fills the width, cursor hints it. */
.dim-collapsibleHead {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
}
.dim-collapsibleHead:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #3370ff);
  outline-offset: 2px;
  border-radius: 8px;
}

.dim-collapsibleHeaderContent { min-width: 0; flex: 1 1 auto; display: flex; align-items: center; }

/* Chevron affordance at the end of the header line. */
.dim-collapsibleChevron {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 9px;
  height: 9px;
  border-right: 1.6px solid var(--dsw-alias-label-tertiary, #8f959e);
  border-bottom: 1.6px solid var(--dsw-alias-label-tertiary, #8f959e);
  transform: rotate(-45deg);
  transition: transform .22s cubic-bezier(.4, 0, .2, 1);
  transform-origin: 50% 50%;
}
.dim-collapsibleAccount.is-open .dim-collapsibleChevron { transform: rotate(45deg); }

/* Pure CSS height animation: 0fr -> 1fr, no content measurement needed */
.dim-collapsibleBody {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows .22s cubic-bezier(.4, 0, .2, 1);
}
.dim-collapsibleAccount.is-open > .dim-collapsibleBody { grid-template-rows: 1fr; }
.dim-collapsibleBodyInner { min-height: 0; overflow: hidden; }

/* Keep collapsed content out of the a11y tree and tab order. */
.dim-collapsibleAccount:not(.is-open) .dim-collapsibleBodyInner { visibility: hidden; }

@media (prefers-reduced-motion: reduce) {
  .dim-collapsibleBody,
  .dim-collapsibleChevron { transition: none !important; }
}
`;

function injectCollapsibleStyles() {
  if (typeof document === 'undefined') return () => {};
  if (document.querySelector(`style[data-plugin-css="${COLLAPSIBLE_STYLE_ID}"]`)) return () => {};
  const style = document.createElement('style');
  style.dataset.plugin = '@xmanrui/dsh-im';
  style.dataset.pluginCss = COLLAPSIBLE_STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => {
    style.remove();
  };
}

export function useCollapsibleAccountStyles() {
  React.useEffect(() => injectCollapsibleStyles(), []);
}

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
  useCollapsibleAccountStyles();
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
