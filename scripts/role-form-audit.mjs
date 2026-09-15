#!/usr/bin/env node
/**
 * Role-versus-form audit.
 *
 * The plugin renders the same user-facing roles in every channel, and each
 * channel sheet writes them out independently. A per-value audit (is this
 * font-size on the ladder? is this radius a rung?) cannot see the failure that
 * matters here: one role wearing several different forms, every one of them
 * individually legal.
 *
 * This groups rules by role across the channel sheets and reports the groups
 * whose FORM disagrees. The role key is the selector with the channel's own
 * class prefix normalised away, so '.ddt-button' and '.dxw-button' collapse to
 * the same key and their declarations become directly comparable.
 *
 * Structural properties must agree. Colour properties are reported separately:
 * a channel's accent colour is legitimately its own.
 *
 *   node scripts/role-form-audit.mjs           # only divergent groups
 *   node scripts/role-form-audit.mjs --all     # every group
 *   node scripts/role-form-audit.mjs --soft    # include colour divergence
 *
 * KNOWN FALSE POSITIVE - resolve before acting on a hit.
 *
 * This compares DECLARATIONS, not resolved values, so a channel rule that loses
 * the cascade is reported even though nothing on screen differs. The shared sheet
 * routinely outranks the channel sheets: it prefixes its selectors with the panel
 * (.dim-panel .dim-stateDot is 0,2,0) while a channel rule is a bare class
 * (.bxf-dot is 0,1,0).
 *
 * The first run reported the status dot as 8px against 7px, the avatar as 42px
 * against 48px and the card radius as r14 against r16. Measured in the browser on
 * the two largest independently-written sheets, all three render identically:
 * .bxf-dot is 8x8, .bxf-avatar is 38x38 r12 (the shared .dim-botAvatar wins), and
 * .bxf-card is r16 (the shared .dim-surfaceCard wins). The channel declarations
 * were dead code, not divergence.
 *
 * The remaining class of false positive is a DECLARED VARIANT, which is not drift:
 * .bxf-button reads 32px against 28px until you notice the taller ones carry
 * [data-size="small"], and the base rule is byte-identical to the shared geometry.
 *
 * So: before treating a hit as visual, (a) check whether a shared rule with higher
 * specificity targets a class that co-occurs on the same element, and (b) check
 * whether the differing rules are gated by different attributes. Anything still
 * standing after both is worth a browser measurement - and only then a fix.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BACKTICK = String.fromCharCode(96);
const CHANNELS = 'plugin-src/client/channels';
const SHARED = 'plugin-src/client/styles.js';

/** Properties that define a control's form. These must match within a role. */
const HARD = new Set([
  'display', 'align-items', 'justify-content', 'flex-direction', 'flex-wrap',
  'height', 'min-height', 'max-height', 'width', 'min-width',
  'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
  'padding-inline', 'padding-block',
  'border-width', 'border-style', 'border-radius', 'gap', 'row-gap', 'column-gap',
  'font-size', 'font-weight', 'line-height', 'white-space', 'text-align',
  'text-transform', 'letter-spacing', 'text-decoration',
]);

/** Properties that may legitimately differ per channel. */
const SOFT = new Set([
  'color', 'background', 'background-color', 'border-color', 'border-top-color',
  'border-bottom-color', 'box-shadow',
]);

/** The CSS a sheet contributes: every template literal body it carries. */
function cssOf(source) {
  const out = [];
  const re = new RegExp('([A-Za-z_$][\\w$.]*)?' + BACKTICK + '([\\s\\S]*?)' + BACKTICK, 'g');
  let m;
  while ((m = re.exec(source))) {
    const body = m[2];
    // A stylesheet body always carries at least one rule; prose does not.
    if (body.includes('{') && body.includes(':')) out.push(body);
  }
  return out.join('\n');
}

/** The class prefixes a sheet actually uses, longest first. */
function prefixesOf(css) {
  const counts = new Map();
  for (const m of css.matchAll(/\.([a-z][a-z0-9]{1,11})-/g)) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([p, n]) => n >= 2 && p !== 'dim' && p !== 'dsw' && p !== 'ds')
    .map(([p]) => p)
    .sort((a, b) => b.length - a.length);
}

/** Declarations of one rule body, as [property, value] pairs. */
function declarationsOf(body) {
  const out = [];
  for (const raw of body.split(';')) {
    const i = raw.indexOf(':');
    if (i < 0) continue;
    const property = raw.slice(0, i).trim();
    const value = raw.slice(i + 1).trim();
    if (property && value && !property.startsWith('/*')) out.push([property, value]);
  }
  return out;
}

/** A border shorthand reduced to the part that describes form, not colour. */
function borderForm(value) {
  const width = (value.match(/[\d.]+px/) ?? [''])[0];
  const style = (value.match(/\b(solid|dashed|dotted|none)\b/) ?? [''])[0];
  return [width, style].filter(Boolean).join(' ') || 'none';
}

/** Normalise a value so a channel's own names do not read as a difference. */
function normaliseValue(value, prefixes) {
  let out = value;
  for (const p of prefixes) {
    out = out.split('--' + p + '-').join('--CH-');
    out = out.split('.' + p + '-').join('.CH-');
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** The role key: selector minus state, minus the channel's own prefix. */
function roleKey(selector, prefixes) {
  let out = selector;
  for (const p of prefixes) out = out.split('.' + p + '-').join('.CH-');
  out = out.replace(/::?[a-z-]+(\([^)]*\))?/g, '');
  return out.replace(/\s+/g, ' ').trim();
}

function signature(declarations, prefixes, wanted) {
  const out = {};
  for (const [property, value] of declarations) {
    if (!wanted.has(property)) continue;
    const v = property.startsWith('border') && !property.endsWith('radius') && !property.endsWith('color')
      ? borderForm(value)
      : normaliseValue(value, prefixes);
    out[property] = v;
  }
  return out;
}

function sheets() {
  const out = [];
  out.push({ name: 'shared', file: SHARED });
  for (const entry of readdirSync(CHANNELS)) {
    const file = join(CHANNELS, entry, 'styles.js');
    try { if (statSync(file).isFile()) out.push({ name: entry, file }); } catch { /* no sheet */ }
  }
  return out;
}

const groups = new Map();
const skipped = [];
for (const sheet of sheets()) {
  const css = cssOf(readFileSync(sheet.file, 'utf8'));
  if (!css) { skipped.push(sheet.name); continue; }
  const prefixes = prefixesOf(css);
  if (sheet.name !== 'shared' && prefixes.length === 0) { skipped.push(sheet.name); continue; }
  for (const m of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    for (const selector of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
      const key = roleKey(selector, prefixes);
      if (!key || key.startsWith('@') || !key.includes('CH-')) continue;
      const declarations = declarationsOf(m[2]);
      const entry = {
        sheet: sheet.name,
        selector,
        hard: signature(declarations, prefixes, HARD),
        soft: signature(declarations, prefixes, SOFT),
      };
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
  }
}

const showAll = process.argv.includes('--all');
const showSoft = process.argv.includes('--soft');
const flat = s => JSON.stringify(Object.entries(s).sort());

let divergent = 0, comparable = 0;
const lines = [];
for (const [key, entries] of [...groups.entries()].sort()) {
  // Compare per sheet: a sheet that states one role twice is its own problem and
  // belongs to the intra-sheet pass, not here.
  const bySheet = new Map();
  for (const e of entries) if (!bySheet.has(e.sheet)) bySheet.set(e.sheet, e);
  if (bySheet.size < 2) continue;
  comparable++;
  const shapes = new Map();
  for (const [sheet, e] of bySheet) {
    const k = flat(e.hard);
    if (!shapes.has(k)) shapes.set(k, []);
    shapes.get(k).push(sheet);
  }
  // Separate a genuine conflict (two sheets state the property and disagree)
  // from one sheet stating what the others leave to inheritance. The second is
  // often equivalent on screen and needs a render check before it is touched.
  const props = new Set();
  for (const e of bySheet.values()) for (const p of Object.keys(e.hard)) props.add(p);
  const conflicts = [], partials = [];
  for (const p of [...props].sort()) {
    const stated = new Map();
    for (const [sheet, e] of bySheet) if (p in e.hard) stated.set(sheet, e.hard[p]);
    if (stated.size < 2) { partials.push(p + ' only in ' + [...stated.keys()].join(',')); continue; }
    if (new Set(stated.values()).size > 1) {
      conflicts.push(p + '  ->  ' + [...stated.entries()].map(([s, v]) => s + ':' + v).join('   '));
    }
  }
  if (shapes.size === 1) { if (showAll) lines.push('  ok    ' + key + '  (' + bySheet.size + ' channels)'); continue; }
  if (conflicts.length) divergent++;
  else if (!showAll) continue;
  lines.push((conflicts.length ? '  CONFLICT  ' : '  partial   ') + key + '   [' + bySheet.size + ' channels]');
  for (const c of conflicts) lines.push('          ! ' + c);
  for (const p of partials) lines.push('          ~ ' + p);
  if (showSoft) {
    for (const [sheet, e] of bySheet) lines.push('            ~ ' + sheet + ' ' + flat(e.soft));
  }
}

console.log('role groups with >= 2 channels: ' + comparable);
console.log('groups whose FORM diverges:    ' + divergent);
console.log('  ^ declarations only. Resolve specificity and declared variants before');
console.log('    treating a hit as visual - see KNOWN FALSE POSITIVE in this file.');
if (skipped.length) console.log('sheets skipped (no parseable CSS): ' + skipped.join(', '));
console.log('');
console.log(lines.join('\n') || '  (none)');
