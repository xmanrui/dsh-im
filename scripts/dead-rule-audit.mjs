#!/usr/bin/env node
/**
 * Dead-rule audit: which rule in a channel stylesheet can never win the cascade?
 *
 * Mechanism this encodes (already measured upstream, not re-derived here):
 *   - plugin-src/client/styles.js (the shared sheet) is installed LAST for every
 *     channel except dingtalk - plugin-src/client/index.js:445-463 lists the
 *     channel installers and calls installImStyles() after all of them.
 *     => at EQUAL specificity the shared sheet wins for those channels.
 *   - dingtalk is not in that list; channels/dingtalk/styles.js is installed from
 *     the mount effect at channels/dingtalk/index.js:403, i.e. after apply() ran.
 *     => at EQUAL specificity dingtalk wins; only a STRICTLY more specific shared
 *     rule beats it.
 *
 * A channel rule is reported as DEAD when, for every declaration in it, some
 * shared rule provably (a) matches every element the channel selector can match
 * and (b) wins the cascade against it. Both halves are deliberately conservative:
 * anything not provable goes to the "uncertain" bucket instead of being reported.
 *
 * How (a) is proved:
 *   - structural containment: does the shared selector match a superset of the
 *     elements the channel selector matches, plus
 *   - class co-occurrence harvested from the plugin's own render code. Every
 *     string / template literal inside a className value is one observation; a
 *     class X is "always accompanied by" Y only when Y lies in the intersection of
 *     all observations containing X. A class with no observation yields no
 *     co-occurrence at all, so nothing is claimed about it.
 *   - one ambient ancestor class set, because every channel page is mounted inside
 *     <main class="dim-panel"> (index.js:374-375). The premise is re-verified at
 *     run time and the audit aborts if it stopped holding.
 *
 * Usage: node scripts/dead-rule-audit.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLIENT = path.join(ROOT, 'plugin-src', 'client');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const ARGS = new Set(process.argv.slice(2));
const AS_JSON = ARGS.has('--json');
const BT = String.fromCharCode(96);

function fail(msg) { console.error('dead-rule-audit: ' + msg); process.exit(1); }
function readFile(p) { return fs.readFileSync(p, 'utf8'); }
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
function skipString(s, i) {
  const q = s[i];
  i++;
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === q) return i + 1;
    i++;
  }
  return i;
}
function matchPair(s, i) {
  const open = s[i], close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") { i = skipString(s, i) - 1; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (!depth) return i + 1; }
  }
  return s.length;
}

/* ---- 0. premise checks: abort when the mechanism described above changed ---- */

const indexSrc = readFile(path.join(CLIENT, 'index.js'));
const lineOfIndex = (idx) => indexSrc.slice(0, idx).split('\n').length;
const markIdx = indexSrc.indexOf('install combined channel styles');
if (markIdx < 0) fail('index.js: cannot find the "install combined channel styles" effect');
const effectRegion = indexSrc.slice(indexSrc.lastIndexOf('ctx.effect(', markIdx), markIdx);
const sharedInstallIdx = effectRegion.indexOf('installImStyles()');
if (sharedInstallIdx < 0) fail('index.js: installImStyles() is not in the combined-styles effect');
for (const m of effectRegion.matchAll(/install(\w+)Styles\(\)/g)) {
  if (m[1] === 'Im') continue;
  if (m.index > sharedInstallIdx) fail('index.js: install' + m[1] + 'Styles() runs after the shared sheet - mechanism changed');
}
if (effectRegion.includes('installDingtalkStyles')) fail('index.js: dingtalk is inside the shared-last list - mechanism changed');
if (!/React\.useEffect\(\(\) => installDingtalkStyles\(\), \[\]\)/.test(readFile(path.join(CLIENT, 'channels', 'dingtalk', 'index.js')))) {
  fail('channels/dingtalk/index.js: mount-time installDingtalkStyles() not found - mechanism changed');
}
function balancedRegion(src, from) {
  let i = from; const stack = []; const close = { '(': ')', '{': '}', '[': ']' };
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === BT) { i = skipString(src, i) - 1; continue; }
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); if (e < 0) break; i = e; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (close[c]) { stack.push(close[c]); continue; }
    if (stack.length && c === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return src.slice(from, i + 1); }
  }
  return null;
}
const mainCallIdx = indexSrc.indexOf("h('main'");
if (mainCallIdx < 0) fail("index.js: h('main' ...) panel not found");
const panelRegion = balancedRegion(indexSrc, mainCallIdx);
if (!panelRegion || !panelRegion.includes("className: 'dim-panel'")) fail('index.js: the tabpanel is not .dim-panel');
const tabNames = new Set([...panelRegion.matchAll(/\b(\w+SettingsTab)\b/g)].map((m) => m[1]));
if (tabNames.size < 11) fail('index.js: only ' + tabNames.size + ' channel tabs render inside .dim-panel - ambient-ancestor premise changed');
const AMBIENT = new Set(['dim-panel']);
const AMBIENT_CITE = 'plugin-src/client/index.js:' + lineOfIndex(mainCallIdx) + '-' + lineOfIndex(mainCallIdx + panelRegion.length);

/* ---- 1. stylesheet discovery ---- */

const styleFiles = walk(CLIENT).filter((f) => /styles\.js$/.test(f));
const sharedFile = styleFiles.find((f) => path.dirname(f) === CLIENT);
if (!sharedFile) fail('plugin-src/client/styles.js not found');
const channelFiles = styleFiles.filter((f) => f !== sharedFile)
  .map((f) => ({ file: f, channel: path.basename(path.dirname(f)) }))
  .sort((a, b) => a.channel.localeCompare(b.channel));

/* ---- 2. tiny CSS reader ---- */

const CONDITIONAL_AT = new Set(['media', 'container', 'supports']);

function extractCssLiteral(src, file) {
  const m = /const\s+CSS\s*=\s*(String\.raw)?/.exec(src);
  const bt = src.indexOf(BT, m ? m.index : 0);
  if (!m || bt < 0) fail(rel(file) + ': no const CSS = template-literal sheet');
  const bodyStart = bt + 1;
  let i = bodyStart;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === BT) break;
    i++;
  }
  return { text: src.slice(bodyStart, i), startLine: src.slice(0, bodyStart).split('\n').length };
}

function parseStylesheet(text, startLine, file) {
  const rules = [];
  let i = 0; const n = text.length;
  let pending = '', pendingStart = 0;
  const atStack = [];
  const lineAt = (idx) => startLine + (text.slice(0, idx).match(/\n/g) || []).length;
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'") { const j = skipString(text, i); if (pending.trim() === '') pendingStart = i; pending += text.slice(i, j); i = j; continue; }
    if (c === '{') {
      const prelude = pending.trim();
      const isAt = prelude.startsWith('@');
      const name = isAt ? prelude.slice(1).split(/[\s({]/)[0].toLowerCase() : '';
      if (isAt && CONDITIONAL_AT.has(name)) { atStack.push({ name }); i++; pending = ''; continue; }
      if (isAt) { i = matchPair(text, i); pending = ''; continue; }
      const end = matchPair(text, i);
      rules.push({ file: rel(file), line: lineAt(pendingStart), selector: prelude,
        decls: parseDecls(text.slice(i + 1, end - 1)), at: atStack.map((a) => a.name), conditional: atStack.length > 0 });
      i = end; pending = ''; continue;
    }
    if (c === '}') { atStack.pop(); i++; pending = ''; continue; }
    if (c === ';') { i++; pending = ''; continue; }
    if (pending.trim() === '') pendingStart = i;
    pending += c; i++;
  }
  return rules;
}

function splitTopLevel(s, sep) {
  const out = []; let cur = '', depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") { const j = skipString(s, i); cur += s.slice(i, j); i = j - 1; continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function parseDecls(body) {
  const out = [];
  for (const chunk of splitTopLevel(body, ';')) {
    const idx = chunk.indexOf(':');
    if (idx < 0) continue;
    const prop = chunk.slice(0, idx).trim().toLowerCase();
    if (!prop || !/^(--)?[-a-z]/.test(prop)) continue;
    let value = chunk.slice(idx + 1).trim();
    const important = /!\s*important\s*$/i.test(value);
    if (important) value = value.replace(/!\s*important\s*$/i, '').trim();
    out.push({ prop, value: value || '(empty)', important });
  }
  return out;
}

/* ---- 3. selectors: compounds, combinators, specificity ---- */

function parseComplex(sel) {
  const compounds = [], combinators = [];
  let cur = '', i = 0; const n = sel.length;
  const flush = () => { if (cur.trim()) { compounds.push(cur.trim()); cur = ''; } };
  while (i < n) {
    const c = sel[i];
    if (c === '\\') { cur += sel.slice(i, i + 2); i += 2; continue; }
    if (c === '"' || c === "'") { const j = skipString(sel, i); cur += sel.slice(i, j); i = j; continue; }
    if (c === '(' || c === '[') { const j = matchPair(sel, i); cur += sel.slice(i, j); i = j; continue; }
    if (/\s/.test(c)) {
      let j = i; while (j < n && /\s/.test(sel[j])) j++;
      if (sel[j] === '>' || sel[j] === '+' || sel[j] === '~') { i = j; continue; }
      if (cur.trim()) { flush(); combinators.push(' '); }
      i = j; continue;
    }
    if (c === '>' || c === '+' || c === '~') {
      flush(); combinators.push(c); i++;
      while (i < n && /\s/.test(sel[i])) i++;
      continue;
    }
    cur += c; i++;
  }
  flush();
  while (combinators.length > compounds.length - 1) combinators.pop();
  return { text: sel.trim().replace(/\s+/g, ' '), compounds, combinators };
}

function simpleSelectors(compound) {
  const parts = []; let i = 0; const n = compound.length;
  while (i < n) {
    const c = compound[i];
    if (c === '\\') { parts.push(compound.slice(i, i + 2)); i += 2; continue; }
    if (c === '*') { i++; continue; }
    if (c === '.' || c === '#') {
      let j = i + 1;
      while (j < n && /[\w-]/.test(compound[j])) j++;
      parts.push(compound.slice(i, j)); i = j; continue;
    }
    if (c === '[') { const j = matchPair(compound, i); parts.push(compound.slice(i, j)); i = j; continue; }
    if (c === ':') {
      let j = i + 1;
      if (compound[j] === ':') j++;
      while (j < n && /[\w-]/.test(compound[j])) j++;
      if (compound[j] === '(') { const k = matchPair(compound, j); parts.push(compound.slice(i, k).replace(/\s+/g, ' ')); i = k; }
      else { parts.push(compound.slice(i, j).toLowerCase()); i = j; }
      continue;
    }
    let j = i;
    while (j < n && /[\w-]/.test(compound[j])) j++;
    if (j === i) { i++; continue; }
    parts.push(compound.slice(i, j).toLowerCase());
    i = j;
  }
  return parts;
}

function pseudoName(part) {
  let j = 1;
  if (part[j] === ':') j++;
  let k = j;
  while (k < part.length && /[\w-]/.test(part[k])) k++;
  return part.slice(j, k).toLowerCase();
}
const MAX_ARG_PSEUDOS = new Set(['not', 'is', 'has', 'matches', 'any']);

function specificityOfComplex(complex) {
  let a = 0, b = 0, c = 0;
  const add = (s) => { a += s[0]; b += s[1]; c += s[2]; };
  for (const compound of complex.compounds) {
    for (const part of simpleSelectors(compound)) {
      if (part.startsWith('#')) { a++; continue; }
      if (part.startsWith('.')) { b++; continue; }
      if (part.startsWith('[')) { b++; continue; }
      if (part.startsWith('::')) { c++; continue; }
      if (part.startsWith(':')) {
        const name = pseudoName(part);
        if (name === 'where') continue;
        const p = part.indexOf('(');
        const arg = p >= 0 ? part.slice(p + 1, -1) : '';
        if (MAX_ARG_PSEUDOS.has(name)) {
          if (arg) add(splitTopLevel(arg, ',').map(specificityOfSelector).reduce(maxSpec, [0, 0, 0]));
          continue;
        }
        if (name === 'nth-child' || name === 'nth-last-child' || name === 'nth-of-type' || name === 'nth-last-of-type') {
          b++;
          const of = /(?:^|\s)of\s/i.exec(arg);
          if (of) add(splitTopLevel(arg.slice(of.index + of[0].length), ',').map(specificityOfSelector).reduce(maxSpec, [0, 0, 0]));
          continue;
        }
        b++; continue;
      }
      c++;
    }
  }
  return [a, b, c];
}
function specificityOfSelector(sel) {
  return splitTopLevel(sel, ',').map((s) => specificityOfComplex(parseComplex(s))).reduce(maxSpec, [0, 0, 0]);
}
function maxSpec(x, y) {
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? x : y;
  return x;
}
const specStr = (s) => '(' + s.join(',') + ')';
const specCmp = (x, y) => (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]);

/* ---- 4. className observations from the plugin's render code ---- */

const codeFiles = walk(CLIENT).filter((f) => /\.(js|jsx|mjs)$/.test(f) && !/styles\.js$/.test(f));
const classObs = new Map();

function bucket(cls) {
  let e = classObs.get(cls);
  if (!e) { e = { occurrences: [], sawDynamicTemplate: false, dirty: false }; classObs.set(cls, e); }
  return e;
}
function tokensOf(text) {
  return text.split(/\s+/).map((t) => t.trim()).filter((t) => /^-?[_a-zA-Z][\w-]*$/.test(t));
}
function record(text, file, line, dynamic) {
  const toks = tokensOf(text);
  if (!toks.length) return;
  const rec = { file: rel(file), line, classes: toks.slice().sort(), dynamic };
  for (const t of toks) bucket(t).occurrences.push(rec);
}
function noteDynamic(text) {
  for (const t of tokensOf(text)) bucket(t).sawDynamicTemplate = true;
}
const INTERP = /\$\{[^}]*\}/g;

function expressionEnd(src, i) {
  if (src[i] === '{') return matchPair(src, i);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '"' || c === "'" || c === BT) { j = skipString(src, j) - 1; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (!depth) return j; depth--; }
    else if ((c === ',' || c === '\n') && !depth) return j;
  }
  return src.length;
}

function literalSpans(src) {
  const spans = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === BT) { const j = skipString(src, i); spans.push([i, j]); i = j; continue; }
    i++;
  }
  return spans;
}

/**
 * Two passes per file.
 *   pass 1  every className value: each string / template literal inside it is one
 *           observation of "these classes are on this element, together".
 *   pass 2  every OTHER string literal in the file. A class token that also shows up
 *           outside a className value - handed to a component as a prop, concatenated
 *           in a helper, named in a message - has render points this script cannot
 *           see, so no co-occurrence is claimed for it at all ("dirty").
 */
function scanFile(src, file) {
  const ranges = [];
  for (const m of src.matchAll(/\bclassName\b/g)) {
    let i = m.index + m[0].length;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== ':' && src[i] !== '=') continue;
    i++;
    while (i < src.length && /\s/.test(src[i])) i++;
    const line = src.slice(0, m.index).split('\n').length;
    const c = src[i];
    if (c === '"' || c === "'") { const j = skipString(src, i); ranges.push([i, j]); record(src.slice(i + 1, j - 1), file, line, false); continue; }
    if (c === BT) {
      const j = skipString(src, i);
      ranges.push([i, j]);
      const inner = src.slice(i + 1, j - 1);
      const dynamic = inner.includes('${');
      if (dynamic) noteDynamic(inner.replace(INTERP, ' '));
      record(inner.replace(INTERP, ' '), file, line, dynamic);
      continue;
    }
    const end = expressionEnd(src, i);
    ranges.push([i, end]);
    const region = src.slice(i, end);
    for (let k = 0; k < region.length; k++) {
      const d = region[k];
      if (d === '"' || d === "'") { record(region.slice(k + 1, skipString(region, k) - 1), file, line, false); k = skipString(region, k) - 1; continue; }
      if (d === BT) {
        const inner = region.slice(k + 1, skipString(region, k) - 1);
        const dynamic = inner.includes('${');
        if (dynamic) noteDynamic(inner.replace(INTERP, ' '));
        record(inner.replace(INTERP, ' '), file, line, dynamic);
        k = skipString(region, k) - 1; continue;
      }
    }
  }
  for (const [s, e] of literalSpans(src)) {
    if (ranges.some(([a, b]) => s >= a && e <= b)) continue;
    for (const t of tokensOf(src.slice(s + 1, e - 1).replace(INTERP, ' '))) bucket(t).dirty = true;
  }
}
for (const f of codeFiles) scanFile(readFile(f), f);

const closureCache = new Map();
function coPresent(cls, relaxed = false, seen = new Set()) {
  const key = (relaxed ? '1' : '0') + cls;
  if (closureCache.has(key)) return closureCache.get(key);
  if (seen.has(cls)) return new Set([cls]);
  seen.add(cls);
  const e = classObs.get(cls);
  if (!e || !e.occurrences.length) return new Set([cls]);
  if (e.dirty && !relaxed) return new Set([cls]);   // render points exist that this scan cannot see
  let acc = null;
  for (const o of e.occurrences) {
    const s = new Set(o.classes);
    acc = acc === null ? s : new Set([...acc].filter((x) => s.has(x)));
  }
  acc.add(cls);
  const out = new Set(acc);
  for (const x of acc) { if (x === cls) continue; for (const y of coPresent(x, relaxed, seen)) out.add(y); }
  closureCache.set(key, out);
  return out;
}

/* ---- 5. cascade comparison ---- */

const SHORTHANDS = {
  background: ['background-color', 'background-image', 'background-position', 'background-size', 'background-repeat', 'background-origin', 'background-clip', 'background-attachment'],
  font: ['font-style', 'font-variant', 'font-weight', 'font-stretch', 'font-size', 'line-height', 'font-family'],
  border: ['border-width', 'border-style', 'border-color', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-top-width', 'border-top-style', 'border-top-color', 'border-right-width', 'border-right-style', 'border-right-color', 'border-bottom-width', 'border-bottom-style', 'border-bottom-color', 'border-left-width', 'border-left-style', 'border-left-color'],
  'border-top': ['border-top-width', 'border-top-style', 'border-top-color'],
  'border-right': ['border-right-width', 'border-right-style', 'border-right-color'],
  'border-bottom': ['border-bottom-width', 'border-bottom-style', 'border-bottom-color'],
  'border-left': ['border-left-width', 'border-left-style', 'border-left-color'],
  'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'border-style': ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'],
  'border-radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  inset: ['top', 'right', 'bottom', 'left'],
  gap: ['row-gap', 'column-gap'],
  overflow: ['overflow-x', 'overflow-y'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  'flex-flow': ['flex-direction', 'flex-wrap'],
  transition: ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay'],
  animation: ['animation-name', 'animation-duration', 'animation-timing-function', 'animation-delay', 'animation-iteration-count', 'animation-direction', 'animation-fill-mode', 'animation-play-state'],
  outline: ['outline-width', 'outline-style', 'outline-color'],
  'text-decoration': ['text-decoration-line', 'text-decoration-style', 'text-decoration-color', 'text-decoration-thickness'],
  'place-items': ['align-items', 'justify-items'],
  'place-content': ['align-content', 'justify-content'],
  'place-self': ['align-self', 'justify-self'],
  'grid-template': ['grid-template-rows', 'grid-template-columns'],
};
function propCovers(sp, rp) {
  if (sp === rp) return true;
  const l = SHORTHANDS[sp];
  return Array.isArray(l) && l.includes(rp);
}
function declBeaten(sDecl, rDecl, specS, specR, channel) {
  if (rDecl.important && !sDecl.important) return false;
  if (!rDecl.important && !sDecl.important) {
    const cmp = specCmp(specS, specR);
    if (cmp < 0) return false;
    if (cmp === 0 && channel === 'dingtalk') return false;
  }
  return propCovers(sDecl.prop, rDecl.prop);
}

/* ---- 6. selector containment ---- */

function relationOk(want, got) {
  if (want === ' ') return got === ' ' || got === '>';
  if (want === '>') return got === '>';
  if (want === '+') return got === '+';
  if (want === '~') return got === '~' || got === '+';
  return false;
}
function compoundSatisfied(sCompound, cCompound, relaxed) {
  const cSimple = new Set(simpleSelectors(cCompound));
  const guaranteed = new Set();
  for (const p of cSimple) {
    if (!p.startsWith('.')) continue;
    for (const x of coPresent(p.slice(1), relaxed)) guaranteed.add(x);
  }
  for (const part of simpleSelectors(sCompound)) {
    if (part.startsWith('.')) { if (!guaranteed.has(part.slice(1))) return false; }
    else if (!cSimple.has(part)) return false;
  }
  return true;
}
function contains(sharedComplex, channelComplex, relaxed = false) {
  const S = sharedComplex.compounds;
  if (!S.length) return false;
  const C = ['.dim-panel', ...channelComplex.compounds];
  const Cc = [' ', ...channelComplex.combinators];
  const n = S.length, m = C.length;
  if (n > m) return false;
  const effRelation = (from, to) => {
    if (to === from + 1) return Cc[from];
    for (let k = from; k < to; k++) if (Cc[k] === '+' || Cc[k] === '~') return 'sibling';
    return ' ';
  };
  const rec = (si, ci) => {
    if (si === n) return true;
    // the subject of a complex selector is its last compound: it must be the
    // channel selector's own subject, never one of its ancestors.
    const last = si === n - 1;
    for (let j = last ? m - 1 : ci; j < m; j++) {
      if (j === 0) {
        const parts = simpleSelectors(S[si]);
        if (!parts.length || !parts.every((p) => p.startsWith('.') && AMBIENT.has(p.slice(1)))) continue;
      } else if (!compoundSatisfied(S[si], C[j], relaxed)) continue;
      if (si > 0 && !relationOk(sharedComplex.combinators[si - 1], effRelation(ci, j))) continue;
      if (rec(si + 1, j + 1)) return true;
      if (last) break;
    }
    return false;
  };
  return rec(0, 0);
}

/* ---- 7. run the audit ---- */

const sharedLit = extractCssLiteral(readFile(sharedFile), sharedFile);
const sharedRules = parseStylesheet(sharedLit.text, sharedLit.startLine, sharedFile);
for (const r of sharedRules) r.complexes = splitTopLevel(r.selector, ',').map(parseComplex).map((cx) => ({ ...cx, spec: specificityOfComplex(cx) }));

/* family = the shared role the rule is trying to write to. First match wins. */
const FAMILIES = [
  { match: /qrExpired/, label: '二维码过期遮罩' },
  { match: /dim-qrFrame|dim-qrLayout|dim-qrColumn|dim-qrCopy|dim-qrFallback/, label: '二维码框与布局' },
  { match: /dim-countdown|dim-progress/, label: '倒计时与进度条' },
  { match: /dim-emptyBrand|emptyBrand|brandMark|dxw-logo|markStage/i, label: '空态品牌图标（110×110）' },
  { match: /dim-emptyView|dim-emptyCopy|dim-specialView/, label: '空态视图网格' },
  { match: /dim-botAvatar|botAvatar/, label: '机器人头像容器' },
  { match: /dim-stateDot|dim-healthDot|stateDot/, label: '状态点' },
  { match: /dim-stateLabel/, label: '状态标签' },
  { match: /dim-inlineError|dim-statusNotice|error|danger/i, label: '错误块' },
  { match: /dim-surfaceCard|dim-surfaceBody|dim-botCard|dim-cardActions|dim-cardAction\b/, label: '卡片表面与卡片操作' },
  { match: /dim-botCardTop|dim-cardFooter|dim-botIdentity|dim-botName|dim-botList/, label: '机器人卡片内容' },
  { match: /dim-confirm/, label: '二次确认块' },
  { match: /dim-loadingView|dim-spinner/, label: '加载态' },
  { match: /dim-listSection|dim-listHeading/, label: '列表分节' },
  { match: /dim-steps/, label: '步骤列表' },
  { match: /dim-viewActions/, label: '页脚操作区' },
  { match: /dim-credentialPanel|dim-credential/, label: '凭据面板' },
  { match: /dim-channelPage/, label: '渠道页外壳' },
  { match: /button/i, label: '按钮胶囊' },
  { match: /dim-field|input|select/, label: '表单字段' },
  { match: /visuallyHidden|srOnly/, label: '无障碍隐藏' },
];

const report = { dead: [], partial: [], uncertain: [], unreachable: [] };

/** best shared suppressor of one declaration for one complex selector, or null */
function findSuppressor(decl, cCx, channel, relaxed) {
  const cSpec = specificityOfComplex(cCx);
  let best = null;
  for (const sRule of sharedRules) {
    for (const sCx of sRule.complexes) {
      if (!contains(sCx, cCx, relaxed)) continue;
      for (const sDecl of sRule.decls) {
        if (!declBeaten(sDecl, decl, sCx.spec, cSpec, channel)) continue;
        const cand = { file: sRule.file, line: sRule.line, selector: sCx.text, spec: sCx.spec, prop: sDecl.prop, value: sDecl.value, conditional: sRule.conditional, at: sRule.at };
        if (!best) best = cand;
        else if (best.conditional && !cand.conditional) best = cand;
        else if (best.conditional === cand.conditional && specCmp(cand.spec, best.spec) > 0) best = cand;
      }
    }
  }
  return best;
}

/** per-declaration pass; returns the buckets for one rule */
function pass(rule, complexes, channel, relaxed) {
  const covered = [], partial = [], condOnly = [];
  let nCovered = 0, nPartial = 0;
  for (const decl of rule.decls) {
    const entries = [];
    let everyUncond = complexes.length > 0, anyUncond = false, anyCond = false;
    for (const cCx of complexes) {
      const cSpec = specificityOfComplex(cCx);
      const best = findSuppressor(decl, cCx, channel, relaxed);
      if (best && !best.conditional) { anyUncond = true; entries.push({ cx: cCx.text, spec: cSpec, decl, by: best }); }
      else {
        everyUncond = false;
        if (best) { anyCond = true; entries.push({ cx: cCx.text, spec: cSpec, decl, by: best, conditionalOnly: true }); }
        else entries.push({ cx: cCx.text, spec: cSpec, decl, by: null });
      }
    }
    if (everyUncond) { nCovered++; covered.push(...entries); }
    else if (anyUncond) { nPartial++; partial.push(...entries.filter((e) => e.by && !e.conditionalOnly)); }
    else if (anyCond) condOnly.push(...entries.filter((e) => e.by));
  }
  return { covered, partial, condOnly, nCovered, nPartial };
}

for (const { file, channel } of channelFiles) {
  const lit = extractCssLiteral(readFile(file), file);
  for (const rule of parseStylesheet(lit.text, lit.startLine, file)) {
    const complexes = splitTopLevel(rule.selector, ',').map(parseComplex);
    const strict = pass(rule, complexes, channel, false);
    const classes = [...new Set(complexes.flatMap((cx) => cx.compounds.flatMap((cp) => simpleSelectors(cp).filter((p) => p.startsWith('.')).map((p) => p.slice(1)))))];
    const blind = classes.filter((c) => { const e = classObs.get(c); return e && e.occurrences.length && (e.dirty || e.sawDynamicTemplate); });
    const rec = {
      channel, file: rule.file, line: rule.line, selector: rule.selector.trim().replace(/\s+/g, ' '),
      spec: specificityOfSelector(rule.selector), decls: rule.decls, classes,
      occurrences: classes.map((c) => ({ cls: c, known: !!(classObs.get(c)?.occurrences.length), dynamic: !!classObs.get(c)?.sawDynamicTemplate, dirty: !!classObs.get(c)?.dirty, occ: classObs.get(c)?.occurrences || [] })),
      suppressed: [...strict.covered, ...strict.partial], conditionalOnly: strict.condOnly,
      coveredDecls: strict.nCovered, partialDecls: strict.nPartial, totalDecls: rule.decls.length,
    };
    if (rule.decls.length && strict.nCovered === rule.decls.length) { report.dead.push(rec); continue; }
    if (strict.nCovered || strict.nPartial) { report.partial.push(rec); continue; }
    if (strict.condOnly.length) {
      report.uncertain.push({ ...rec, why: 'only a conditional shared rule (@media/@container/@supports) outranks it - not provable in every condition' });
      continue;
    }
    // near miss: would be dead if the render points this scan cannot see behaved
    if (blind.length) {
      const relaxed = pass(rule, complexes, channel, true);
      if (relaxed.nCovered === rule.decls.length && rule.decls.length) {
        report.uncertain.push({
          ...rec,
          why: 'near miss - a shared rule outranks it on every render point this scan can see, but .' + blind.join(' / .') + ' is also used outside a className value (prop or helper), so further render points exist that this scan cannot see',
          wouldBe: relaxed.covered,
        });
        continue;
      }
      if (relaxed.nCovered || relaxed.nPartial) {
        report.uncertain.push({ ...rec, why: 'partial near miss - some declarations would be dead if .' + blind.join(' / .') + ' were proven to co-occur', wouldBe: relaxed.covered });
        continue;
      }
    }
    if (classes.length && classes.every((c) => !classObs.get(c)?.occurrences.length)) report.unreachable.push(rec);
  }
}

/* ---- 8. output ---- */

function familyOf(rec) {
  const pool = rec.suppressed.filter((s) => s.by).map((s) => s.by.selector).join(' ') + ' ' + rec.selector;
  for (const f of FAMILIES) if (f.match.test(pool)) return f.label;
  return '其他';
}
function groupBy(list) {
  const map = new Map();
  for (const rec of list) {
    const key = familyOf(rec);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(rec);
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
}
function printRec(rec, out) {
  const scope = rec.coveredDecls === rec.totalDecls ? '' : ' [dead decls ' + rec.coveredDecls + '/' + rec.totalDecls + ']';
  out.push('  [' + rec.channel + '] ' + rec.file + ':' + rec.line + '  spec ' + specStr(rec.spec) + scope + '  ' + rec.selector);
  out.push('    decls     : ' + rec.decls.map((d) => d.prop + ': ' + d.value + (d.important ? ' !important' : '')).join('; '));
  const bys = new Map();
  for (const s of rec.suppressed) {
    const key = s.cx + '   <-   ' + s.by.file + ':' + s.by.line + '  spec ' + specStr(s.by.spec) + '  ' + s.by.selector;
    if (!bys.has(key)) bys.set(key, []);
    bys.get(key).push(s.decl.prop);
  }
  for (const [k, props] of bys) out.push('    beaten by : ' + k + '   [' + props.join(', ') + ']');
  for (const o of rec.occurrences) {
    if (!o.known) { out.push('    jsx       : .' + o.cls + ' - no render point found'); continue; }
    const tag = (o.dirty ? ' [also used outside className]' : '') + (o.dynamic ? ' [interpolated template]' : '');
    out.push('    jsx       : .' + o.cls + ' - ' + o.occ.length + ' render point(s)' + tag);
    for (const occ of o.occ) out.push('                ' + occ.file + ':' + occ.line + "  className='" + occ.classes.join(' ') + "'" + (occ.dynamic ? ' + interpolation' : ''));
  }
}

if (AS_JSON) {
  console.log(JSON.stringify({ premise: { ambient: [...AMBIENT], ambientCite: AMBIENT_CITE }, dead: report.dead, partial: report.partial, uncertain: report.uncertain, unreachable: report.unreachable }, null, 2));
} else {
  const out = [];
  out.push('dead-rule audit  -  plugin-src/client/**/styles.js');
  out.push('premise: shared sheet installed last for 11 channels (index.js:445-463); dingtalk installs at mount (channels/dingtalk/index.js:403), so it wins ties');
  out.push('ambient ancestor: .' + [...AMBIENT].join(' .') + '   (' + AMBIENT_CITE + ')');
  const observed = [...classObs.values()].filter((e) => e.occurrences.length).length;
  out.push('className observations: ' + observed + ' classes with a render point, ' + classObs.size + ' class tokens seen, from ' + codeFiles.length + ' render files');
  out.push('shared sheet rules: ' + sharedRules.length + ' | channel sheets: ' + channelFiles.length);
  out.push('');
  out.push('== DEAD - every declaration always outranked (' + report.dead.length + ') ==');
  for (const [family, recs] of groupBy(report.dead)) {
    out.push('');
    out.push('-- family: ' + family + ' (' + recs.length + ') --');
    for (const rec of recs) printRec(rec, out);
  }
  out.push('');
  out.push('== PARTIAL - some declarations always outranked (' + report.partial.length + ') ==');
  for (const [family, recs] of groupBy(report.partial)) {
    out.push('');
    out.push('-- family: ' + family + ' (' + recs.length + ') --');
    for (const rec of recs) printRec(rec, out);
  }
  out.push('');
  out.push('== uncertain - NOT reported as dead (' + report.uncertain.length + ') ==');
  for (const rec of report.uncertain) {
    out.push('  [' + rec.channel + '] ' + rec.file + ':' + rec.line + '  spec ' + specStr(rec.spec) + '  ' + rec.selector);
    out.push('    decls     : ' + rec.decls.map((d) => d.prop + ': ' + d.value).join('; '));
    out.push('    why       : ' + rec.why);
    if (rec.conditionalOnly.length) {
      const b = rec.conditionalOnly[0].by;
      out.push('    would be  : ' + b.file + ':' + b.line + '  spec ' + specStr(b.spec) + '  @' + b.at.join('/') + '  ' + b.selector);
    }
    for (const s of (rec.wouldBe || []).slice(0, 3)) {
      out.push('    would be  : ' + s.by.file + ':' + s.by.line + '  spec ' + specStr(s.by.spec) + '  ' + s.by.selector + '   [' + s.decl.prop + ' on ' + s.cx + ']');
    }
  }
  out.push('');
  out.push('== channel rules whose classes have no render point at all (' + report.unreachable.length + ', informational) ==');
  for (const rec of report.unreachable) out.push('  [' + rec.channel + '] ' + rec.file + ':' + rec.line + '  ' + rec.selector + '   (.' + rec.classes.join(' .') + ')');
  console.log(out.join('\n'));
}
