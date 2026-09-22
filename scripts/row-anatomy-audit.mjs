#!/usr/bin/env node
/**
 * Row-anatomy audit: how each settings-like block is built, from source.
 *
 * The host's settings pages have exactly ONE anatomy: one setting = one row,
 * [ title 14/22/400 primary over description 12/18/400 tertiary, 4px apart ] on
 * the left, a 36px auto-width control on the right, 16px 0 row padding, a 0.5px
 * border-l2 hairline between rows. Anything else in this plugin is drift.
 *
 * Kinds reported:
 *   row          - has a left text slot plus a right control
 *   stacked      - a title row followed by a FULL-WIDTH control underneath
 *   orphanDesc   - a hint paragraph that is not inside any row
 *   groupHeading - a block heading above a group of rows
 *
 * Usage: node scripts/row-anatomy-audit.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLIENT = path.join(ROOT, 'plugin-src', 'client');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js') && !/styles\.js$/.test(e.name)) files.push(p);
  }
})(CLIENT);

const ROW_TEXT = /dim-rowText|dim-rowText|dim-rowLabel/;
const ROW = /dim-(modelRow|targetRow|globalTtlRow|accessUserRow|contextSwitchRow|appSwitchRow|callbackRow|updateCommandRow)\b/;
const STACKED_CTL = /dim-(presetSelect|fieldInput|accessField|targetField|accessField)/;
const HINT = /dim-(helpHint|modelHint|contextHint|channelNote|rowDesc|presetError|presetHint)\b/;
const HEADING = /dim-(presetHeader|listTitle|sectionTitle|groupTitle)\b/;
// The host's other anatomy: a field cell inside a form grid. See fields.module.css.
const GRID_CONTAINERS = /dim-(targetFormGrid|accessUserRow|targetRow|accessControls|contextFields)\b/;

const rows = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const lineOf = (i) => src.slice(0, i).split('\n').length;
  const sites = [...src.matchAll(/className:\s*['"\x60]([^'"\x60]+)['"\x60]/g)].map((x) => ({ cls: x[1], index: x.index, file: f }));
  for (const m of src.matchAll(/className:\s*['"\x60]([^'"\x60]+)['"\x60]/g)) {
    const cls = m[1];
    const line = lineOf(m.index);
    const near = src.slice(Math.max(0, m.index - 700), m.index + 700);
    if (ROW.test(cls)) rows.push({ kind: 'row', file: rel(f), line, cls, hasTextSlot: ROW_TEXT.test(near) });
    // A label-over-control INSIDE a multi-column form grid is not drift: that is the
    // host's other anatomy, `.field` (fields.module.css:3-8 - flex column, gap 6px,
    // padding 12px 0). Only a full-width stacked field is a third form, so the grid
    // containers are excluded here. First run of this script flagged six grid cells
    // as drift; converting them would have broken the grids and moved AWAY from native.
    else if (STACKED_CTL.test(cls)) {
      // Context is resolved by walking back to the nearest enclosing CONTAINER class,
      // not by a fixed character window - a window missed .dim-targetField at 357/374
      // even though they sit in the same grid as 331/347, and reported them as drift.
      // Carrying a row-slot class also means it is already a row.
      const isRow = /dim-rowControl|dim-rowText/.test(cls) || ROW_TEXT.test(near);
      let ctx = null;
      const at = sites.findIndex((x) => x.index === m.index);
      for (let k = at - 1; k >= 0; k -= 1) {
        const prev = sites[k];
        if (prev.file !== f) break;
        if (GRID_CONTAINERS.test(prev.cls) || ROW.test(prev.cls)) { ctx = prev.cls; break; }
      }
      const inGrid = ctx !== null && GRID_CONTAINERS.test(ctx);
      if (isRow) rows.push({ kind: 'row', file: rel(f), line, cls, hasTextSlot: true });
      else rows.push({ kind: inGrid ? 'fieldCell' : 'stacked', file: rel(f), line, cls, ctx });
    }
    // The host has standalone hint and invalid paragraphs of its own - .hint is
    // 12/1.5 tertiary and .invalid is 12/1.5 label-error, both plain <p>
    // (fields.module.css:81-93). So a loose paragraph is only drift when it is a
    // SPECIFIC row's description sitting outside that row; a section note or a status
    // line is native. The first run called all nine of these orphans.
    else if (HINT.test(cls)) {
      const status = /Error|Notice|Feedback|Inline\b/.test(cls);
      const inRow = ROW.test(near) || ROW_TEXT.test(near);
      const kind = status ? 'statusText' : inRow ? 'rowDesc' : 'sectionHint';
      rows.push({ kind, file: rel(f), line, cls, insideRow: inRow });
    }
    else if (HEADING.test(cls)) rows.push({ kind: 'groupHeading', file: rel(f), line, cls });
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const by = {};
  for (const r of rows) by[r.kind] = (by[r.kind] || 0) + 1;
  console.log('row-anatomy audit  -  ' + rows.length + ' settings-like render sites');
  console.log('kinds: ' + JSON.stringify(by));
  console.log('');
  const order = ['stacked', 'fieldCell', 'sectionHint', 'statusText', 'rowDesc', 'groupHeading', 'row'];
  const label = {
    stacked: 'STACKED  title + full-width control underneath  (host has no such anatomy)',
    orphanDesc: 'ORPHAN   hint paragraph; insideRow=false means it has no row to belong to',
    groupHeading: 'HEADING  block heading above rows',
    fieldCell: 'FIELD    label over control inside a form grid - this IS native (fields.module.css .field)',
    rowDesc: 'ROWDESC  a description inside its own row - this IS native (the row text slot)',
    sectionHint: 'HINT     a loose paragraph - native too (fields.module.css:88 .hint), unless it is one row\'s description',
    statusText: 'STATUS   a state message - native too (fields.module.css:81 .invalid)',
    row: 'ROW      left text slot + right control  (host anatomy)',
  };
  for (const kind of order) {
    const list = rows.filter((r) => r.kind === kind);
    console.log('== ' + label[kind] + '  [' + list.length + ']');
    for (const r of list) {
      const extra = kind === 'orphanDesc' ? '  insideRow=' + r.insideRow : kind === 'row' ? '  textSlot=' + r.hasTextSlot : '';
      console.log('   ' + r.file + ':' + r.line + '  .' + r.cls + extra);
    }
    console.log('');
  }
}
