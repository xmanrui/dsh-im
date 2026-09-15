import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const BT = String.fromCharCode(96);
const CHANNELS = 'plugin-src/client/channels';
const SHARED = 'plugin-src/client/styles.js';

function jsFiles(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) jsFiles(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

// className co-occurrence: which classes share an element in the JSX
const co = new Map();
for (const f of jsFiles('plugin-src/client')) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/className:\s*'([^']+)'/g)) {
    const classes = m[1].split(/\s+/).filter(Boolean);
    for (const c of classes) {
      if (!co.has(c)) co.set(c, new Set());
      for (const o of classes) co.get(c).add(o);
    }
  }
  for (const m of src.matchAll(/className:\s*["]([^"]+)["]/g)) {
    const classes = m[1].split(/\s+/).filter(Boolean);
    for (const c of classes) {
      if (!co.has(c)) co.set(c, new Set());
      for (const o of classes) co.get(c).add(o);
    }
  }
}

function cssOf(source) {
  const out = [];
  const re = new RegExp(BT + '([\\s\\S]*?)' + BT, 'g');
  let m;
  while ((m = re.exec(source))) if (m[1].includes('{') && m[1].includes(':')) out.push(m[1]);
  return out.join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
}

function spec(selector) {
  const ids = (selector.match(/#[\w-]+/g) || []).length;
  const cls = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length;
  const el = (selector.match(/(^|[\s>+~])[a-z][\w-]*/g) || []).length;
  return ids * 10000 + cls * 100 + el;
}

function classesIn(compound) {
  return (compound.match(/\.[\w-]+/g) || []).map(s => s.slice(1));
}

function sheets() {
  const out = [{ name: 'shared', file: SHARED }];
  for (const e of readdirSync(CHANNELS)) {
    const f = join(CHANNELS, e, 'styles.js');
    try { if (statSync(f).isFile()) out.push({ name: e, file: f }); } catch {}
  }
  return out;
}

const all = [];
for (const s of sheets()) {
  const css = cssOf(readFileSync(s.file, 'utf8'));
  if (!css) continue;
  for (const m of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    for (const sel of m[1].split(',').map(x => x.trim()).filter(Boolean)) {
      const decls = {};
      for (const d of m[2].split(';')) {
        const i = d.indexOf(':');
        if (i < 0) continue;
        const p = d.slice(0, i).trim();
        if (p) decls[p] = d.slice(i + 1).trim();
      }
      all.push({ sheet: s.name, sel, base: sel.replace(/::?[\w-]+(\([^)]*\))?/g, '').trim(), spec: spec(sel), decls });
    }
  }
}

// Does this rule co-match an element carrying `channelClass`?
function coMatches(rule, channelClass) {
  const own = co.get(channelClass);
  if (!own) return false;
  const parts = rule.base.split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1] || '';
  const need = classesIn(last);
  if (!need.length) return false;
  return need.every(c => own.has(c));
}

const pairs = [
  ['dot', ['.ddt-dot', '.bxf-dot', '.dxw-dot', '.dof-dot'], ['width', 'height', 'border-radius']],
  ['avatar', ['.ddt-avatar', '.dxw-avatar', '.bxf-avatar'], ['width', 'height', 'border-radius']],
  ['button', ['.ddt-button', '.dxw-button', '.bxf-button'], ['height', 'border-radius', 'font-size', 'padding', 'font-weight', 'line-height']],
  ['card', ['.ddt-card', '.dxw-card', '.bxf-card'], ['border-radius', 'padding']],
  ['actions', ['.ddt-actions', '.dxw-actions', '.bxf-actions'], ['gap']],
];

for (const [role, sels, props] of pairs) {
  console.log('\n== ROLE ' + role);
  for (const sel of sels) {
    const cls = sel.slice(1);
    const own = all.filter(r => r.sel === sel)[0];
    const others = all.filter(r => r.sheet === 'shared' && coMatches(r, cls));
    const line = [];
    for (const p of props) {
      const mine = own && own.decls[p];
      const win = others.filter(r => r.decls[p]).sort((a, b) => b.spec - a.spec)[0];
      if (!mine && !win) continue;
      const mineSpec = own ? own.spec : 0;
      const shadowed = win && win.spec > mineSpec;
      line.push(p + ': ' + (mine || '-') + (win ? '   [shared ' + win.sel + ' spec ' + win.spec + ' = ' + win.decls[p] + ']' + (shadowed ? '  SHADOWED' : '') : ''));
    }
    if (line.length) console.log('  ' + sel + '  (spec ' + (own ? own.spec : 0) + ')');
    for (const l of line) console.log('      ' + l);
  }
}