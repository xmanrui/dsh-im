/**
 * Test-only double for `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * Why this file exists
 * --------------------
 * The real package is a **browser platform seed module**: at runtime the DSH
 * web shell materializes it into `window.__ModuleLoader__`, so the client bundle
 * only ever holds `require('@deepseek-ai/dsh-client-ui-primitives')` and never a
 * physical copy. That is also why `scripts/verify-package.mjs` forbids any
 * `@deepseek-ai/dsh-*` entry in `dependencies`/`devDependencies`.
 *
 * Node cannot load the real file: its `lib/index.js` starts with
 * `import css from "./StateDot.module.css"` and also imports `clsx`, `shiki`,
 * `katex`, `anser` and the mdast/micromark stack — none of which Node can
 * resolve, and `.css` is not an importable extension at all.
 *
 * The client sources are imported **directly as ESM** by the UI tests
 * (`test/client-ui.test.mjs` imports `plugin-src/client/index.js`), so this
 * double — wired in through `test/support/ui-primitives-loader.mjs` — supplies
 * the same public surface. Tests therefore keep verifying this plugin's wiring,
 * markup and accessibility contract; the *visual* official implementation is
 * verified in a real browser against the dev environment.
 *
 * The double deliberately keeps the official prop contracts (see the
 * `lib/types/*.d.ts` of the real package) and marks its own output with
 * `data-ui-primitive="<name>"` so tests can assert that a call site actually
 * routed through the official layer instead of a local refork.
 */

import * as React from 'react';

function primitive(name, render) {
  const Component = (props) => render(props);
  Component.displayName = `Primitive(${name})`;
  return Component;
}

/** `Button` — official variants are `primary | ghost | outline | toolbar`. */
export const Button = primitive('Button', ({ variant = 'ghost', size = 'md', icon, className, children, ...rest }) =>
  React.createElement('button', {
    type: 'button',
    'data-ui-primitive': 'Button',
    'data-variant': variant,
    'data-size': size,
    className,
    ...rest,
  }, icon, children));

/** `Tag` — read-only pill; `tone` selects the palette. */
export const Tag = primitive('Tag', ({ tone = 'outline', className, children }) =>
  React.createElement('span', {
    'data-ui-primitive': 'Tag',
    'data-tone': tone,
    className,
  }, children));

/** `Tooltip` — clones its single anchor child and adds a bubble while shown. */
export const Tooltip = primitive('Tooltip', ({ label, side = 'right', children }) => {
  if (!React.isValidElement(children)) return children ?? null;
  const text = typeof label === 'function' ? label() : label;
  return React.createElement(
    React.Fragment,
    null,
    React.cloneElement(children, { 'data-tooltip-side': side }),
    React.createElement('span', {
      'data-ui-primitive': 'Tooltip',
      role: 'tooltip',
      'data-side': side,
    }, text),
  );
});

/** `Switch` — fully controlled toggle. */
export const Switch = primitive('Switch', ({ checked, onChange, label, disabled, title, className }) =>
  React.createElement('button', {
    type: 'button',
    role: 'switch',
    'data-ui-primitive': 'Switch',
    'aria-checked': checked === true,
    'aria-label': label,
    title,
    disabled,
    className,
    onClick: () => onChange?.(!(checked === true)),
  }));

/** `Input` — native input inside a wrapper span. */
export const Input = primitive('Input', ({ icon, className, ...rest }) =>
  React.createElement('span', { 'data-ui-primitive': 'Input', className },
    icon, React.createElement('input', rest)));

/**
 * `Modal` — null while closed, otherwise a body-portaled overlay: a presentation
 * wrapper holding an `aria-hidden` mask and a `role="dialog"` `aria-modal` card
 * with an `h2` title, an `aria-label`ed close button, the body and the footer.
 * Mirrors the real implementation (which renders `div[role=dialog]`, never a
 * native `<dialog>` element) so tests assert the shipped DOM contract.
 */
export const Modal = primitive('Modal', ({ open, onClose, title, closeLabel, description, children, footer, className, contentClassName, headless }) => {
  if (!open) return null;
  return React.createElement('div', {
    'data-ui-primitive': 'Modal',
    role: 'presentation',
  },
  React.createElement('div', { className: 'dshp-modal-mask', 'aria-hidden': 'true', onClick: onClose }),
  React.createElement('div', {
    'data-ui-primitive': 'Modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title,
    className,
  },
  headless
    ? children
    : React.createElement(React.Fragment, null,
      React.createElement('div', { className: contentClassName },
        React.createElement('div', null,
          React.createElement('h2', null, title),
          React.createElement('button', { type: 'button', 'aria-label': closeLabel, onClick: onClose }, '\u00d7')),
        description ? React.createElement('p', null, description) : null,
        children !== undefined ? React.createElement('div', null, children) : null),
      footer !== undefined ? React.createElement('div', null, footer) : null)));
});

/** `Menu` — the double only needs to be constructible for composition. */
export const Menu = primitive('Menu', ({ children, className }) =>
  React.createElement('div', { 'data-ui-primitive': 'Menu', role: 'menu', className }, children));

/** `StateDot` — small status dot; `state` selects the tone. */
export const StateDot = primitive('StateDot', ({ state = 'neutral', className }) =>
  React.createElement('span', { 'data-ui-primitive': 'StateDot', 'data-state': state, className }));

export const HoverCard = primitive('HoverCard', ({ children }) => children ?? null);
export const Pill = primitive('Pill', ({ children, className }) =>
  React.createElement('span', { 'data-ui-primitive': 'Pill', className }, children));
export const Toast = primitive('Toast', ({ children }) => children ?? null);
export const ConnectionIndicator = primitive('ConnectionIndicator', ({ state, className }) =>
  React.createElement('span', { 'data-ui-primitive': 'ConnectionIndicator', 'data-state': state, className }));
export const DisclosureRow = primitive('DisclosureRow', ({ children }) => children ?? null);
export const FileTypeIcon = primitive('FileTypeIcon', () => null);
export const BrandWordmark = primitive('BrandWordmark', ({ className }) =>
  React.createElement('span', { 'data-ui-primitive': 'BrandWordmark', className }));
export const FishLogo = primitive('FishLogo', () => null);

/* Non-component members: the client layer only reads these as values. */
export const FISH_LOGO_PATH = '';
export const FISH_LOGO_VIEWBOX = '0 0 1 1';
export const DEFAULT_DIFF_MAX_LINES = 0;
export const DEFAULT_READ_MAX_LINES = 0;
export const DEFAULT_SEARCH_MAX_LINES = 0;
export const DEFAULT_TERMINAL_MAX_LINES = 0;

export const classifyFileType = () => 'text';
export const classifyLinkPath = () => 'text';
export const extractMarkdownPlainText = (value) => String(value ?? '');
export const fileExtension = () => '';
export const fileSizeText = () => '';
export const projectUserText = (value) => value;
export const rankByName = (items) => items;
export const relativeTime = () => '';
export const writeClipboard = async () => true;

export const useAnchoredMaxHeight = () => 0;
export const useAnchoredPosition = () => ({});
export const useDismissOnOutsidePointer = () => {};
