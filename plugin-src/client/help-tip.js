/**
 * The one help "?" and the panel it opens.
 *
 * This idiom already existed twice under two class-name sets - the context
 * enhancement editor's own (dim-contextHelp/Button/Tooltip) and the Feishu preset
 * editor's (dim-presetHelp/Button/Tooltip). They were the same thing: a 16px box
 * holding an 11/500 glyph, cursor: help, and a panel shown while the trigger is
 * hovered or focused. Two names for one role is how the two drifted apart in the
 * first place (320px vs 330px panel, one had a grid gap and the other did not), so
 * this component carries ONE name and the sheet declares it once.
 *
 * The panel is PORTALED TO document.body AND position: fixed. It used to be an
 * absolutely positioned child, which put it inside whatever card it was rendered in:
 * the Context enhancement card scrolls and clips, the card is painted above the tip's
 * own z-index, and the panel that explains a field ended up cut off or hidden behind
 * the block next to it. Nothing inside a card can promise to be on top - only a layer
 * outside it can. Portaling also means no CSS hover rule can reach the panel any more
 * (it is no longer a descendant), so the open state is React state here, with the
 * small close delay a hover tip needs to survive the 7px gap between button and panel.
 *
 * Every visible description that explains a labelled control or a block title goes in
 * here instead of being stacked under it as its own grey paragraph. What does NOT
 * belong here: the row-description slot (.dim-rowDesc and friends), and any text that
 * appears or disappears with data - an error, a warning, a progress line, a command to
 * copy. Those are states, not help.
 */
import * as React from 'react';
import { createPortal } from 'react-dom';
import { h } from './i18n.js';
import { QuestionGlyph } from './ui-glyphs.js';

/** Long enough to cross the gap between the button and the panel, short enough to feel
    like it closed because you left. */
const HIDE_DELAY = 140;
const MARGIN = 12;
const GAP = 7;

/**
 * @param id        id of the panel, so the button can point at it with aria-describedby
 * @param label     the button's accessible name; it must say WHAT is explained
 * @param place     'below' (default) or 'above' when the control sits at the bottom
 * @param disabled  mirrors the control the help belongs to
 */
export function HelpTip({ id, label, place = 'below', disabled = false, className = '', children }) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState(null);
  const triggerRef = React.useRef(null);
  const panelRef = React.useRef(null);
  const timerRef = React.useRef(null);

  const clear = () => {
    if (timerRef.current) { globalThis.clearTimeout(timerRef.current); timerRef.current = null; }
  };
  const show = () => { clear(); setOpen(true); };
  const hide = () => { clear(); timerRef.current = globalThis.setTimeout(() => setOpen(false), HIDE_DELAY); };
  React.useEffect(() => clear, []);

  // Measured against the trigger, in viewport coordinates, because the panel is fixed.
  // Clamped to the viewport on both axes: a tip for a control near an edge is still a
  // tip, and one that hangs off the screen is the same defect as one that is clipped.
  React.useEffect(() => {
    if (!open) { setPos(null); return undefined; }
    const reposition = () => {
      const trigger = triggerRef.current?.getBoundingClientRect?.();
      if (!trigger) return;
      const box = panelRef.current?.getBoundingClientRect?.();
      const width = box?.width || 330;
      const height = box?.height || 0;
      const viewportW = globalThis.innerWidth ?? 0;
      const viewportH = globalThis.innerHeight ?? 0;
      const left = Math.max(MARGIN, Math.min(trigger.left, viewportW - width - MARGIN));
      if (place === 'above') {
        setPos({ left, bottom: Math.max(MARGIN, viewportH - trigger.top + GAP) });
        return;
      }
      const top = Math.min(trigger.bottom + GAP, Math.max(MARGIN, viewportH - height - MARGIN));
      setPos({ left, top });
    };
    reposition();
    const view = globalThis.window;
    view?.addEventListener?.('resize', reposition);
    view?.addEventListener?.('scroll', reposition, true);
    return () => {
      view?.removeEventListener?.('resize', reposition);
      view?.removeEventListener?.('scroll', reposition, true);
    };
  }, [open, place]);

  const wrapper = h('span', {
    className: className ? `dim-help ${className}` : 'dim-help',
    onMouseEnter: show,
    onMouseLeave: hide,
  },
  h('button', {
    type: 'button', ref: triggerRef, className: 'dim-helpButton', disabled,
    'aria-label': label, 'aria-describedby': id,
    onFocus: show, onBlur: hide,
  }, h(QuestionGlyph, { size: 14 })));

  // Always rendered, hidden by [data-open] - the same shape the CSS-only version had, so
  // the panel is in the markup (and in a test tree) whether or not it is showing. It is
  // visible only once the first measurement has landed, so it can never paint at 0,0.
  const panel = h('span', {
    ref: panelRef, id, role: 'tooltip',
    className: place === 'above' ? 'dim-helpPanel dim-helpPanelTop' : 'dim-helpPanel',
    'data-open': open && pos ? 'true' : 'false',
    style: pos ?? { left: -9999, top: -9999 },
    onMouseEnter: show,
    onMouseLeave: hide,
  }, children);

  // Test renderers have no document; there the panel stays in the tree, which is what
  // the contract tests read. Everywhere else it goes to the top layer.
  const target = globalThis.document?.body ?? null;
  return h(React.Fragment, null, wrapper, target ? createPortal(panel, target) : panel);
}
