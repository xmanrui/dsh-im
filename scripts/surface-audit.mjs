#!/usr/bin/env node
/**
 * Surface audit: enumerate every UI surface the settings page can render, from source.
 *
 * Re-runnable by design. Written because a hand-made inventory of ~118 surfaces was
 * produced in a chat session and never persisted - when it was needed again it did not
 * exist. Anything that only lives in a conversation is not an inventory.
 *
 * Surface kinds:
 *   1. portal       - createPortal(...) to a target outside the panel
 *   2. select       - a native <select>, which the UA styles unless a rule claims it
 *   3. menu         - role="menu" / "listbox" / "dialog" / "tablist" containers
 *   4. conditional  - a surface only rendered behind a boolean (expanded / hidden)
 *   5. data-gated   - a surface that only renders when data exists (a configured bot,
 *                     a non-empty list). Invisible on an instance with no bots.
 *   6. unstyled     - a rendered element that no rule appears to claim
 *
 * STATIC ANALYSIS CANNOT DECIDE THE CASCADE. The unstyled bucket is therefore a
 * CANDIDATE list: it now also checks a descendant selector through the element's
 * enclosing className, but it still cannot evaluate @media/@container or a selector
 * that matches through several ancestors. Stage two is scripts/surface-probe.js, which
 * runs in the page and reports the rules that actually match plus the computed values.
 *
 * Usage: node scripts/surface-audit.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLIENT = path.join(ROOT, 'plugin-src', 'client');

function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

const jsFiles = walk(CLIENT, ['.js']);
const styleFiles = jsFiles.filter((f) => /styles\.js$/.test(f));
const codeFiles = jsFiles.filter((f) => !/styles\.js$/.test(f));
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

// ---- every class name any plugin stylesheet mentions, plus the raw selector text ----
const declaredClasses = new Set();
const selectors = [];
for (const f of styleFiles) {
  const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of src.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const sel of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      selectors.push({ sel, file: rel(f) });
      for (const c of sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) declaredClasses.add(c[1]);
    }
  }
}

const CLASS_ATTR = /className:\s*(['"\x60])([^'"\x60]+)\1/g;

// ---- rendered elements: own className plus the nearest enclosing className ----
const rendered = new Map();
const elements = [];
for (const f of codeFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const lineOf = (i) => src.slice(0, i).split('\n').length;
  for (const m of src.matchAll(/h\(\s*['"](\w+)['"]\s*,\s*\{/g)) {
    const tag = m[1];
    const open = m.index;
    // the element's own className: search forward inside this call
    const fwd = src.slice(open, open + 600);
    const ownRaw = /className:\s*['"\x60]([^'"\x60]+)['"\x60]/.exec(fwd);
    const own = ownRaw ? [null, ownRaw[1].replace(/\$\{.*$/, '')] : null;
    // the nearest enclosing className before this call
    let enclosing = null;
    for (const e of src.slice(0, open).matchAll(CLASS_ATTR)) enclosing = e[2];
    elements.push({ file: rel(f), line: lineOf(open), tag, own: own ? own[1] : null, enclosing });
    for (const c of (own ? own[1] : '').split(/\s+/).filter(Boolean)) {
      if (!rendered.has(c)) rendered.set(c, []);
      rendered.get(c).push({ file: rel(f), line: lineOf(open) });
    }
  }
}

const surfaces = [];
const push = (o) => surfaces.push(o);

for (const f of codeFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const at = (i) => src.slice(0, i).split('\n').length;
  for (const m of src.matchAll(/createPortal\s*\(/g)) {
    push({ kind: 'portal', file: rel(f), line: at(m.index), trigger: 'component mounts (target outside the panel)' });
  }
  for (const m of src.matchAll(/h\(\s*['"]select['"]/g)) {
    push({ kind: 'select', file: rel(f), line: at(m.index), trigger: 'the field renders' });
  }
  for (const m of src.matchAll(/role:\s*['"](menu|listbox|dialog|tooltip|tablist)['"]/g)) {
    push({ kind: 'menu', file: rel(f), line: at(m.index), trigger: 'role=' + m[1] + ' container renders' });
  }
  for (const m of src.matchAll(/['"]aria-expanded['"]\s*:/g)) {
    push({ kind: 'conditional', file: rel(f), line: at(m.index), trigger: 'expanded state toggles' });
  }
  // data-gated: a render guarded by a data check, so it cannot appear on an empty instance
  const GATE = /(?:\.length\s*(?:>|>=|!==|===|\?|&&)|\bhasBots\b|\bconfigured\s*>\s*0|\bif\s*\(\s*!\s*\w*(?:bot|list|items|entries)\w*\s*\))/gi;
  for (const m of src.matchAll(GATE)) {
    const line = at(m.index);
    const near = src.slice(m.index, m.index + 400);
    if (!/\bh\(/.test(near)) continue;
    push({ kind: 'data-gated', file: rel(f), line, trigger: 'only when the data exists: ' + m[0].trim().slice(0, 40) });
  }
}

// ---- unstyled candidates: own class undeclared AND no rule reaching it through its parent ----
const PREFIX = /^(dim|bxf|ddt|dxw|dof|dsl|dqq|dwecom|dimessage|dwa|dtg|dwb)-/;
function reachableByAncestor(tag, enclosing) {
  return selectors.some(({ sel }) => {
    if (!sel.includes(tag)) return false;
    if (!enclosing) return false;
    return enclosing.split(/\s+/).some((c) => c && sel.includes('.' + c));
  });
}
// An element is a candidate only when NONE of its classes is declared. Checking one
// class at a time flagged 'ddt-expired dim-qrExpired', whose second class is declared
// and does the whole job - a false positive that would have sent someone chasing it.
for (const el of elements) {
  if (!el.own) continue;
  const classes = el.own.split(/\s+/).filter(Boolean);
  if (!classes.length) continue;
  if (!classes.some((c) => PREFIX.test(c))) continue;
  if (classes.some((c) => declaredClasses.has(c))) continue;
  push({ kind: 'unstyled', file: el.file, line: el.line, trigger: 'the element renders', cls: el.own, uses: 1 });
}
// Only tags the UA styles visibly by itself. SVG internals (svg/path/circle/...) are
// painted through fill/stroke inheritance and are not surfaces; including them buried
// the real candidates under ~90 false positives.
const UA_STYLED = new Set(['select', 'input', 'textarea', 'button', 'ul', 'ol', 'table', 'dialog', 'details', 'summary']);
for (const el of elements) {
  if (el.own) continue;
  if (!UA_STYLED.has(el.tag)) continue;
  if (reachableByAncestor(el.tag, el.enclosing)) continue;
  push({ kind: 'unstyled', file: el.file, line: el.line, trigger: 'classless <' + el.tag + '> that no rule reaches, not even through a parent', cls: '(no class)', uses: 1 });
}

const byKind = {};
for (const s of surfaces) byKind[s.kind] = (byKind[s.kind] || 0) + 1;

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total: surfaces.length, byKind, surfaces }, null, 2));
} else {
  console.log('total surfaces found: ' + surfaces.length);
  console.log('by kind: ' + JSON.stringify(byKind));
  console.log('');
  console.log('=== unstyled candidates (stage 1 of 2 - confirm with scripts/surface-probe.js) ===');
  for (const s of surfaces.filter((x) => x.kind === 'unstyled')) {
    console.log('  ' + String(s.cls).padEnd(30) + s.file + ':' + s.line + '   ' + s.trigger + '  uses=' + s.uses);
  }
  console.log('');
  for (const kind of ['data-gated', 'portal', 'select', 'menu']) {
    const rows = surfaces.filter((x) => x.kind === kind);
    console.log('=== ' + kind + ' (' + rows.length + ') ===');
    for (const s of rows.slice(0, 30)) console.log('  ' + s.file + ':' + s.line + '   ' + s.trigger);
    console.log('');
  }
}
