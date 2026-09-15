#!/usr/bin/env node
/**
 * Help-idiom audit: which visible descriptions are stacked copy, and which are the
 * shared "?" panel - enumerated from source, attributed from git.
 *
 * The rule this enforces: text that EXPLAINS a labelled control or a block title is
 * help, and help lives in the shared panel (see plugin-src/client/help-tip.js). Text
 * that appears or disappears with data - an error, a warning, a progress line, a
 * command to copy - is a state, not help, and stays visible. The host's own
 * row-description slot is a third role and is not help either.
 *
 * Roles reported:
 *   helpPanel   - rendered through the shared HelpTip; the panel carries it
 *   stacked     - a visible description paragraph/span: the anti-pattern
 *   rowSlot     - the host's row description slot (.dim-rowDesc and friends)
 *   status      - state, warning, progress or copy-me text; must stay visible
 *   reference   - operational data the reader needs while acting (value legend,
 *                 command line, per-channel note)
 *
 * Attribution: a class is "branch" when its token does not exist in the base commit
 * at all, "upstream" when it does. Attribution is per class rather than per line on
 * purpose - line numbers move with every edit in between, the token does not.
 *
 * Usage: node scripts/help-idiom-audit.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLIENT = path.join(ROOT, 'plugin-src', 'client');
const BASE = process.env.HELP_AUDIT_BASE || '0d36ae3';
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

/** class -> [role, why]. Kept next to the scan so a new site has to be classified. */
const ROLES = {
  'dim-help': ['helpPanel', 'the shared wrapper'],
  'dim-helpButton': ['helpPanel', 'the shared button'],
  'dim-helpPanel': ['helpPanel', 'the shared panel'],
  'dim-rowDesc': ['rowSlot', 'the host row description slot'],
  'dim-modelDescription': ['rowSlot', 'the host row description slot'],
  'dim-feishuGroupHelp': ['rowSlot', 'the host row description slot'],
  'dim-helpHint': ['stacked', 'a loose grey paragraph'],
  'dim-contextLegendHint': ['stacked', 'block-title intro, stacked'],
  'dim-contextFieldHint': ['stacked', 'per-field description, stacked'],
  'dim-contextIntro': ['stacked', 'panel intro, stacked'],
  'dim-aliasHelp': ['stacked', 'field description, stacked'],
  'dim-globalTtlHints': ['reference', 'value legend for the input'],
  'dim-updateDescription': ['stacked', 'panel description, stacked'],
  'dim-switchHint': ['stacked', 'control description, stacked'],
  'dim-callbackHint': ['stacked', 'box description, stacked'],
  'dim-diagnosticHint': ['status', 'fallback notice'],
  'dim-updateHint': ['status', 'state and progress line'],
  'dim-updateManualHint': ['status', 'copy-me command and fallback state'],
  'dim-channelNote': ['reference', 'per-channel note'],
};

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js') && !/styles\.js$/.test(e.name)) files.push(p);
  }
})(CLIENT);

const baseCache = new Map();
const inBase = (file, token) => {
  if (!baseCache.has(file)) {
    let text = '';
    try { text = execFileSync('git', ['show', `${BASE}:${rel(file)}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { text = ''; }
    baseCache.set(file, text);
  }
  return baseCache.get(file).includes(token);
};

const rows = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const lineOf = (i) => src.slice(0, i).split('\n').length;
  for (const m of src.matchAll(/className:\s*['"`]([^'"`]+)['"`]/g)) {
    for (const token of m[1].split(/\s+/)) {
      const role = ROLES[token];
      if (!role) continue;
      rows.push({ role: role[0], why: role[1], cls: token, file: rel(f), line: lineOf(m.index),
        shape: /<(p|ul)\b|'p'|"p"|'ul'|"ul"/.test(src.slice(Math.max(0, m.index - 120), m.index)) ? 'block' : 'inline',
        origin: inBase(f, token) ? 'upstream' : 'branch' });
    }
  }
}
rows.sort((a, b) => a.role.localeCompare(b.role) || a.file.localeCompare(b.file) || a.line - b.line);

const sheet = fs.readFileSync(path.join(CLIENT, 'styles.js'), 'utf8');
const declared = [...sheet.matchAll(/\.dim-(?:context|preset)?[Hh]elp(?:Button|Panel|Tip)?\b(?=[\s,:{])/g)]
  .map((m) => m[0].replace('.', ''));
const buttons = [...new Set([...sheet.matchAll(/\.dim-[A-Za-z]*[Hh]elp[A-Za-z]*Button/g)].map((m) => m[0].slice(1)))];

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ rows, buttons, declared: [...new Set(declared)] }, null, 2));
} else {
  const pad = (v, n) => String(v).padEnd(n);
  console.log(`base commit: ${BASE}\n`);
  for (const role of ['stacked', 'helpPanel', 'rowSlot', 'status', 'reference']) {
    const list = rows.filter((r) => r.role === role);
    console.log(`== ${role} (${list.length}) ==`);
    for (const r of list) console.log(`  ${pad(r.file + ':' + r.line, 62)} ${pad(r.cls, 24)} ${pad(r.shape, 7)} ${r.origin}`);
    console.log('');
  }
  console.log(`== help buttons declared in styles.js (${buttons.length}) ==`);
  for (const b of buttons) console.log('  ' + b);
}
