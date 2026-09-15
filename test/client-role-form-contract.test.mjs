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
        assert.equal(weight, 'var(--dim-weight-400)', selector + ' keeps the native row-title weight');
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
  assert.equal(declared(caption[0], 'font-weight'), 'var(--dim-weight-500)');
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
  // The disabled state lives on the control now, not the row: the row is a plain
  // container and the pill is the button, so this looks at the pill.
  const disabled = rules.filter(rule =>
    rule.selectors.some(s => s.startsWith('.dim-modelSelector') && s.includes(':disabled')));
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

test('every placeholder uses the token native gives placeholders', () => {
  // The host does not use one placeholder token. A census of all 12 placeholder
  // declarations in packages/client found three tiers, and label-dimmed is the
  // MINORITY (3 of 12, two of them dead code):
  //   label-caption  #ADB2B8 / #81858C - 7 of 12, the dominant tier, and the one the
  //                  session composer uses (ui-conversation InputBar.module.css:210)
  //   label-tertiary #81858C / #ADB2B8 - 2 of 12, the search boxes
  //   label-dimmed   #E1E5EE / #43454A - 3 of 12; measured on the live UI it is
  //                  1.26:1 on white and 1.64:1 on bg-layer-1 dark, i.e. a
  //                  disabled-text grey. Chasing it made the credential fields
  //                  unreadable, which is the opposite of the reported bug.
  // caption also restores the host's own relationship: placeholder one step lighter
  // than the label-tertiary helper text that sits under the same field.
  const placeholders = rules.filter(rule =>
    rule.selectors.some(s => s.includes(String.fromCharCode(58,58) + "placeholder")));
  assert.ok(placeholders.length >= 3, 'the placeholders keep their rules');
  for (const rule of placeholders) {
    const colour = declared(rule, String.fromCharCode(99,111,108,111,114)) ?? "";
    assert.match(colour, /--dsw-alias-label-caption/,
      'placeholder colour follows the native placeholder tier: ' + rule.selectors.join(', '));
  }
});

/**
 * Specificity as [ids, classes-and-attributes, elements], the way the cascade counts
 * it. `:not()` contributes its argument - the detail that made the capsule defect
 * invisible to a naive reading of the two rules, which look like rest versus hover
 * and are in fact a tie.
 */
function specificity(selector) {
  const withoutNot = selector.replace(/:not\(([^)]*)\)/g, ' $1 ');
  let a = 0; let b = 0; let c = 0;
  const stripped = withoutNot.replace(/::?[a-z-]+(\([^)]*\))?/gi, (hit) => {
    if (hit.startsWith('::')) { c += 1; return ' '; }
    b += 1;
    return ' ';
  });
  for (const _ of stripped.matchAll(/#[\w-]+/g)) a += 1;
  for (const _ of stripped.matchAll(/\.[\w-]+/g)) b += 1;
  for (const _ of stripped.matchAll(/\[[^\]]+\]/g)) b += 1;
  for (const _ of stripped.matchAll(/(^|[\s>+~,(])([a-zA-Z][\w-]*)/g)) c += 1;
  return [a, b, c];
}

function outranks(left, right) {
  const [la, lb, lc] = specificity(left);
  const [ra, rb, rc] = specificity(right);
  if (la !== ra) return la > ra;
  if (lb !== rb) return lb > rb;
  return lc > rc;
}

test('the capsule hover has one deciding author, and it is the shared rule', () => {
  // Measured on 3081: the channel rule and this shared rule were BOTH (0,4,0), so the
  // winner was decided by <style> injection order - weixin sheet 110, shared 120,
  // dingtalk 121. WeChat lost the tie, so its Generate button had no hover feedback at
  // all, while DingTalk won it and turned rgb(67,69,74). Same rule, two appearances.
  // The shared rule now sits one step higher, so the tie cannot happen again.
  const anchors = [
    '.dim-panel .dim-viewActions .bxf-button:hover:not(:disabled)',
    '.dim-panel .dim-viewActions .dxw-button:hover:not(:disabled)',
    '.dim-panel .dim-viewActions .ddt-button:hover:not(:disabled)',
  ];
  const owner = rules.filter(rule => anchors.every(a => rule.selectors.includes(a)));
  assert.equal(owner.length, 1, 'exactly one shared rule declares the capsule hover');
  assert.equal(declared(owner[0], 'background'), 'var(--dim-hover-solid)');
  assert.match(declared(owner[0], 'border-color'), /^var\(--dsw-alias-border-l3/);

  // The channel sheets keep their own hover rules on purpose: those also style filled
  // buttons that are NOT capsules, so banning them outright would break those. What is
  // forbidden is a channel declaration that can tie or win. Every one of them must lose.
  const channelHover = [
    '.bxf-button[data-kind="primary"]:hover:not(:disabled)',
    '.dxw-button[data-kind="primary"]:hover:not(:disabled)',
    '.ddt-button[data-kind="primary"]:hover:not(:disabled)',
  ];
  for (const selector of channelHover) {
    for (const anchorSelector of anchors) {
      assert.ok(
        outranks(anchorSelector, selector),
        anchorSelector + ' must strictly outrank ' + selector + ' so the tie cannot return',
      );
    }
  }
});

const CHANNEL_STYLES = new URL('../plugin-src/client/channels/feishu/styles.js', import.meta.url);
const channelRules = parseRules(await readFile(CHANNEL_STYLES, 'utf8'));
const allRules = rules.concat(channelRules);

test('a tooltip foreground and background are decided as a pair', () => {
  // The pairing rule, and the reason it is not simply 'never flip'. The tooltip base is
  // DARK IN BOTH THEMES: design-platform.css:235 gives --dsw-alias-tooltip-bg =
  // neutral-bluish-850 (44,44,46) in light, and :328 gives neutral-bluish-750
  // (67,69,74) in dark. So a foreground that flips with the theme lands near-black on a
  // dark base in the light theme. Measured on 3080 before the fix:
  //   .dim-panel .dim-channelTooltip strong  1.36:1
  //   .bxf-repairTooltip > span              2.40:1   <- black text and white text in
  //                                                      one tooltip: the plain text
  //                                                      inherited the skin, the span
  //                                                      did not. Both read fine in
  //                                                      dark, which is why it survived.
  // But a block that repaints its own surface with a THEME token must flip - its
  // background flips, so its foreground has to flip with it. Flipping is therefore legal
  // exactly when the same rule also repaints the base.
  const tooltipRules = allRules.filter(r => r.selectors.some(s => /tooltip/i.test(s)));
  assert.ok(tooltipRules.length >= 10, 'the tooltip rules are found');
  for (const rule of tooltipRules) {
    const colour = declared(rule, 'color');
    if (!colour) continue;
    if (!/var\(--dsw-alias-/.test(colour)) continue; // static: safe on the dark base
    const background = declared(rule, 'background') ?? declared(rule, 'background-color');
    assert.ok(
      background && !/--dsw-alias-tooltip-bg/.test(background),
      rule.selectors[0] + ' paints tooltip text with a theme-flipping alias (' + colour
        + ') without pairing a themed surface of its own',
    );
  }
  // The converse: repainting the base obliges the rule to state its own foreground,
  // otherwise the text inherits the tooltip's constant white onto a light surface.
  // Measured on 3080 in light before the fix: white on rgb(245,246,247).
  for (const rule of tooltipRules) {
    const background = declared(rule, 'background') ?? declared(rule, 'background-color');
    if (!background) continue;
    if (/--dsw-alias-tooltip-bg/.test(background)) continue;
    assert.ok(
      declared(rule, 'color'),
      rule.selectors[0] + ' repaints the tooltip background (' + background + ') so it must pair a foreground',
    );
  }
});


test('the settings row has one anatomy, declared once and never per channel', () => {
  // Native builds every settings row the same way: a left text slot (title over
  // description, 4px apart), a right control that sizes to its own content, and a
  // 0.5px border-l2 hairline between rows. Measured on 3080 at the host's own rows.
  // Two plugin families now go through it - model-setting and agent-preset - and the
  // point of pinning it here is that the third one cannot invent its own.
  const slot = rules.filter(r => r.selectors.includes('.dim-rowText') && r.selectors.includes('.dim-rowText'));
  assert.equal(slot.length, 1, 'the text slot is declared once, for the whole family');
  assert.equal(declared(slot[0], 'display'), 'grid');
  assert.equal(declared(slot[0], 'gap'), 'var(--dim-gap-4)', 'title and description sit 4px apart, as native does');

  const desc = rulesFor('.dim-rowDesc')[0];
  assert.ok(desc, '.dim-rowDesc exists');
  assert.equal(declared(desc, 'font-size'), 'var(--dim-font-12)');
  assert.equal(declared(desc, 'line-height'), 'var(--dim-line-12)');
  assert.match(declared(desc, 'color'), /--dsw-alias-label-tertiary/);

  // Scoped to .dim-panel on purpose: at (0,1,0) it loses to
  // .dim-panel .dim-presetSelect { width: 100% } and a control stays full-width
  // with no visible error. That bug was real once already.
  const control = rulesFor('.dim-panel .dim-rowControl');
  assert.equal(control.length, 1, 'the right slot is declared once, and scoped so it can win');
  assert.equal(declared(control[0], 'flex'), 'none');
  assert.equal(declared(control[0], 'width'), 'auto');
  assert.equal(declared(control[0], 'max-width'), '60%');

  const divider = rulesFor('.dim-rowDivider')[0];
  assert.ok(divider, '.dim-rowDivider exists');
  assert.match(declared(divider, 'border-top'), /^0\.5px solid var\(--dsw-alias-border-l2/);

  // Channels must not declare any of it: one anatomy means one author.
  const anatomy = /dim-rowText|dim-rowDesc|dim-rowControl|dim-rowDivider|dim-rowText/;
  for (const rule of channelRules) {
    const wrong = rule.declarations.filter(([property]) => ['display', 'gap', 'flex', 'max-width', 'border-top'].includes(property));
    for (const selector of rule.selectors) {
      assert.ok(
        !anatomy.test(selector),
        'a channel sheet must not declare the row anatomy: ' + selector,
      );
    }
    void wrong;
  }
});
test('the settings-row family keeps one form: title over description, 4px apart', () => {
  // Native's row text slot is a 4px-gap column, the title at 14/22 over a 12/18
  // tertiary description - measured on 3080 at the host's oY77xG_rowText. The plugin
  // used to put the description in a separate paragraph below the whole block, which
  // is what made .dim-modelSetting 184px tall. Every row in the family shares this one
  // slot, so the values live here once instead of per row.
  const slot = rulesFor('.dim-rowText')[0];
  assert.ok(slot, '.dim-rowText exists');
  assert.equal(declared(slot, 'display'), 'grid');
  assert.equal(declared(slot, 'gap'), 'var(--dim-gap-4)', 'title and description sit 4px apart, as native does');
  assert.equal(declared(slot, 'text-align'), 'left');

  const desc = rulesFor('.dim-rowDesc')[0];
  assert.ok(desc, '.dim-rowDesc exists');
  assert.equal(declared(desc, 'font-size'), 'var(--dim-font-12)');
  assert.equal(declared(desc, 'line-height'), 'var(--dim-line-12)');
  assert.match(declared(desc, 'color'), /--dsw-alias-label-tertiary/);

  // The old form: the label itself stretched and the description was a sibling
  // paragraph. Guard against either coming back.
  const label = rulesFor('.dim-modelRowLabel')[0];
  assert.ok(label, '.dim-modelRowLabel exists');
  assert.notEqual(declared(label, 'flex'), '1', 'the label no longer stretches on its own; the text slot does');
  assert.equal(rulesFor('.dim-modelHint').length, 0, 'the standalone hint rule is gone with its last use');
});
