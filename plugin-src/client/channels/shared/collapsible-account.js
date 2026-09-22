/**
 * Collapsible per-account card, shared by every IM channel.
 *
 * When several accounts are connected, each account's workspace / preset /
 * context-enhancement editors make the list extremely long. This component
 * keeps one settings toggle in the existing header tools slot. Clicking the
 * header also expands the settings details; more settings live in the body.
 *
 * Design notes:
 * - The native toggle owns keyboard interaction. Header controls stop click
 *   propagation so editing a name cannot accidentally toggle the card.
 * - Height animation uses grid-template-rows: 0fr -> 1fr (pure CSS).
 * - The toggle exposes aria-expanded / aria-controls; the body keeps native
 *   semantics and hides collapsed controls from focus and accessibility.
 * - Honors prefers-reduced-motion.
 * - Styles are managed by the IM settings plugin, not individual accounts.
 */
import * as React from 'react';
import { h } from '../../i18n.js';
import { ChevronRightGlyph } from '../../ui-glyphs.js';

const AccountSectionContext = React.createContext(null);

/**
 * Does the caller's header already render the settings toggle?
 *
 * That toggle carries its own chevron, so the section must not add a second one
 * beside it: two affordances for one job is what the account card looked like
 * when the toggle arrived from upstream and this branch still rendered the bare
 * disclosure chevron. Read off the element tree the caller passed, because a
 * React element is lazy - the section cannot observe a mount from up here.
 */
function headerCarriesToggle(node) {
  if (!React.isValidElement(node)) return false;
  if (node.type === AccountSettingsToggle) return true;
  return React.Children.toArray(node.props?.children).some(headerCarriesToggle);
}

/**
 * The header's disclosure affordance, in the slot the settings button used to
 * take. It is ONLY the arrow: the whole header already toggles the section, so a
 * gear here was a second icon for a job the card does anyway, and the filled pill
 * behind it read as a primary action rather than as "this row expands".
 */
export function AccountSettingsToggle() {
  const { open, toggle, contentId } = React.useContext(AccountSectionContext);
  return h('button', {
    type: 'button',
    className: 'dim-accountSettingsToggle',
    'aria-label': open ? '收起该账号的设置' : '展开该账号的设置',
    'aria-expanded': open ? 'true' : 'false',
    'aria-controls': contentId,
    onClick: (event) => {
      event.stopPropagation();
      toggle();
    },
  },
  h('svg', {
    className: 'dim-collapsibleChevron',
    viewBox: '0 0 12 16',
    width: 12,
    height: 16,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  }, h('path', { d: 'M2 6 6 10 10 6' })));
}

/**
 * Collapsible account card.
 *
 * `header` renders the always-visible header line; clicking it toggles.
 * Any interactive control inside the header should stop the click event so it
 * does not toggle the section (e.g. the bot settings button).
 * `settings` is the original more-settings action, shown above the editors.
 * `children` is the collapsed details region.
 */
/**
 * The expand affordance, shared by every disclosure in the plugin.
 *
 * Rendered inside the toggle so the rotation stays a pure CSS reaction to the
 * root's `is-open` class; a second copy of this markup would be a second place
 * to change the glyph size.
 */
export function DisclosureChevron() {
  return h('span', { className: 'dim-collapsibleChevron', 'aria-hidden': 'true' },
    h(ChevronRightGlyph, { size: 14 }));
}

export function CollapsibleAccountSection({
  header,
  settings,
  defaultOpen = false,
  open: controlledOpen,
  onToggle,
  id,
  className = '',
  toggleLabel,
  children,
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const open = controlledOpen ?? uncontrolledOpen;
  // Undefined without an explicit id: the head then points at nothing while the
  // section is closed, which is what the disclosure contract asserts.
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

  return h(AccountSectionContext.Provider, { value: { open, toggle, contentId } },
  h('div', {
    className: `dim-collapsible ${open ? 'is-open' : ''} ${className}`.trim(),
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
      // Callers pass null when the header already carries visible text, so the
      // accessible name stays the text the user can see.
      'aria-label': toggleLabel === undefined
        ? (open ? '收起该账号的设置' : '展开该账号的设置')
        : (toggleLabel || undefined),
    },
      h('div', { className: 'dim-collapsibleHeaderContent' }, header),
      headerCarriesToggle(header) ? null : h(DisclosureChevron),
    ),
    h('div', {
      id: contentId,
      className: 'dim-collapsibleBody',
      role: 'region',
    },
      h('div', { className: 'dim-collapsibleBodyInner' },
        settings ? h('div', { className: 'dim-accountSettingsHeader' },
          h('span', null, '常用配置'), settings) : null,
        children),
    ),
  ));
}
