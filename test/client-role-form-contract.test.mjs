import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * Role-versus-form contract.
 *
 * A value audit asks whether each number sits on the native ladder. It cannot
 * see the failure this file guards: one role wearing several forms, every one
 * of them individually legal. Each assertion below pins a role to the single
 * native form that role has, with the native citation in the comment, so the
 * reason survives the person who found it.
 *
 * Native sources are cited by module; they live in the DSH client packages.
 */

const STYLES = new URL('../plugin-src/client/styles.js', import.meta.url);

/** Flat rule list with comments stripped. */
function parseRules(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  for (const match of source.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map(s => s.trim()).filter(Boolean);
    const declarations = match[2].split(';')
      .map(d => d.trim())
      .filter(Boolean)
      .map((d) => {
        const colon = d.indexOf(':');
        return [d.slice(0, colon).trim(), d.slice(colon + 1).trim()];
      })
      .filter(([property]) => property);
    rules.push({ selectors, declarations });
  }
  return rules;
}

const rules = parseRules(await readFile(STYLES, 'utf8'));

/** Every rule whose selector list contains this exact selector. */
function rulesFor(selector) {
  return rules.filter(rule => rule.selectors.includes(selector));
}

/** The value a rule declares for a property, or undefined. */
function declared(rule, property) {
  const hit = rule.declarations.find(([p]) => p === property);
  return hit ? hit[1] : undefined;
}

test('a settings-row label uses the native row-title role, not the stacked-field one', () => {
  // Native's row title is 14px / 400 / 22px / --dsw-alias-label-primary, hand-rolled
  // but byte-identical in LanguageRow, EnterBehaviorRow, TranscriptViewRow,
  // FontSizeRow, AppearanceRow, PermissionRow and PluginInventorySettingsTab.
  // 13px/500 also exists natively, but only as a label stacked ABOVE a control in a
  // card body (fields.module.css .label, ModelsSection .fieldLabel). Mixing it into
  // a row is what made one card read as two competing hierarchies.
  const rowLabels = [
    '.dim-panel .dim-workspaceHeader',
    '.dim-contextEntry',
    '.dim-contextLabel',
    '.dim-modelRowLabel',
    '.dim-modelRow',
  ];
  for (const selector of rowLabels) {
    const found = rulesFor(selector);
    assert.ok(found.length, selector + ' keeps its rule');
    for (const rule of found) {
      const size = declared(rule, 'font-size');
      if (size !== undefined) {
        assert.equal(size, 'var(--dim-font-14)', selector + ' keeps the native row-title size');
      }
      const weight = declared(rule, 'font-weight');
      if (weight !== undefined) {
        assert.equal(weight, '400', selector + ' keeps the native row-title weight');
      }
    }
  }
});

test('the group caption keeps the native caption role', () => {
  // The one label that IS 12px/500 natively: a caption heading a sub-block
  // (ModelsSection .modelCatalogTitle, .fieldLabel). It must not be promoted to the
  // row-title spec just because it sits above rows.
  const caption = rulesFor('.dim-modelSetting > .dim-presetHeader');
  assert.equal(caption.length, 1, 'the group caption keeps its rule');
  assert.equal(declared(caption[0], 'font-size'), 'var(--dim-font-12)');
  assert.equal(declared(caption[0], 'font-weight'), '500');
  assert.match(declared(caption[0], 'color') ?? '', /--dsw-alias-label-secondary/);
});

test('a card that ends in a footer closes with a bottom inset', () => {
  // Measured before this was fixed: the last summary line's bottom edge sat exactly
  // on the card's bottom border (both 885). Native never ends a card at 0 - the floor
  // is 12px (fields.module.css .field), 16px when a row terminates the surface
  // (GeneralSection strips the last separator but keeps the row's padding: 16px 0).
  const footer = rulesFor('.dim-panel .dim-cardFooter');
  assert.equal(footer.length, 1, 'the card footer keeps its rule');
  const bottom = declared(footer[0], 'padding-bottom');
  const shorthand = declared(footer[0], 'padding');
  const parts = shorthand ? shorthand.split(/\s+/) : [];
  const resolved = bottom ?? (parts.length >= 3 ? parts[2] : parts[0]);
  assert.ok(resolved, 'the card footer states its bottom padding');
  assert.notEqual(resolved, '0', 'the card footer closes the card with a real inset');
});

test('a disabled selector keeps its surface and dims only what it says', () => {
  // Native keeps the selector capsule's contrast when disabled and changes the text
  // instead (PermissionRow keeps the pill; FontSizeRow dims the glyph). Fading the
  // whole row made the disabled pill read as a different control rather than the same
  // control switched off.
  const disabled = rules.filter(rule =>
    rule.selectors.some(s => s.startsWith('.dim-modelRow') && s.includes(':disabled')));
  assert.ok(disabled.length, 'the disabled selector keeps a rule');
  for (const rule of disabled) {
    assert.equal(
      declared(rule, 'opacity'),
      undefined,
      'the disabled selector row does not fade its own surface: ' + rule.selectors.join(', '),
    );
  }
});

test('a modal scrolls its body, not its own chrome', () => {
  // The card used to be the only scroll region, so in a short viewport the tab
  // strip that names the scope and the primary action both left the screen.
  // Measured after the fix at a 560px viewport: the body scrolls - 659px of content
  // in 374px - while Save stays at y=532, inside the viewport.
  const dialog = rulesFor('.dim-contextDialog');
  assert.equal(dialog.length, 1, 'the dialog keeps its rule');
  assert.equal(declared(dialog[0], 'display'), 'grid');
  assert.match(declared(dialog[0], 'grid-template-rows') ?? '', /minmax\(0, 1fr\)/);
  const body = rulesFor('.dim-contextBody');
  assert.equal(body.length, 1, 'the dialog has exactly one scrolling body');
  assert.equal(declared(body[0], 'overflow-y'), 'auto');
  assert.equal(declared(body[0], 'min-height'), '0', 'the scroll row may shrink below its content');
});
