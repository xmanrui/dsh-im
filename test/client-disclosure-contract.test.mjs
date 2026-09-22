import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as React from 'react';
import TestRenderer from 'react-test-renderer';

import { ContextEnhancementEditor } from '../plugin-src/client/context-enhancement.js';
import { CollapsibleAccountSection } from '../plugin-src/client/channels/shared/collapsible-account.js';
import { WeixinConnectionError } from '../plugin-src/client/channels/weixin/connection-error.js';
import { DEFAULT_CONTEXT_ENHANCEMENT_CONFIG } from '../src/channels/shared/context-enhancement.mjs';
import { h } from '../plugin-src/client/i18n.js';

const { act, create } = TestRenderer;
const sheet = await readFile(new URL('../plugin-src/client/styles.js', import.meta.url), 'utf8');
const source = (relative) => readFile(new URL(relative, import.meta.url), 'utf8');

const DIAGNOSTIC = {
  code: 'weixin-startup-config-invalid',
  message: '微信配置格式错误',
  details: { stage: 'startup.load', file: 'workspaces.json', referenceId: 'ref-1', occurredAt: '2026-01-01T00:00:00.000Z' },
};

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return (node?.children ?? []).map(textOf).join('');
}

async function mount(node) {
  let renderer;
  await act(async () => { renderer = create(node); });
  return renderer;
}

/** Every disclosure is a root carrying `dim-collapsible` plus a chevron inside it. */
function disclosure(renderer) {
  const roots = renderer.root.findAll((node) =>
    typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes('dim-collapsible'));
  assert.equal(roots.length, 1, 'a single disclosure root');
  const [root] = roots;
  const chevron = root.findByProps({ className: 'dim-collapsibleChevron' });
  return { root, chevron };
}

test('the three disclosures render one shared anatomy instead of three implementations', async () => {
  const account = await mount(h(CollapsibleAccountSection, { header: h('span', null, '账号') }));
  const context = await mount(h(ContextEnhancementEditor, { config: DEFAULT_CONTEXT_ENHANCEMENT_CONFIG }));
  const diagnostic = await mount(h(WeixinConnectionError, { error: DIAGNOSTIC }));

  for (const [name, renderer] of [['account', account], ['context', context], ['diagnostic', diagnostic]]) {
    const { root, chevron } = disclosure(renderer);
    assert.equal(chevron.props['aria-hidden'], 'true', `${name}: the chevron is decoration`);
    assert.equal(chevron.props.style, undefined, `${name}: the glyph must not carry a per-site override`);
    const toggles = root.findAll((node) => node.props['aria-expanded'] !== undefined);
    assert.equal(toggles.length, 1, `${name}: exactly one toggle announces its state`);
  }
});

test('the diagnostic disclosure keeps every field, the fallback and the copy action', async () => {
  const renderer = await mount(h(WeixinConnectionError, { error: DIAGNOSTIC }));
  const { root } = disclosure(renderer);
  const head = root.findByProps({ className: 'dim-collapsibleHead' });
  assert.equal(head.props['aria-expanded'], 'false');
  assert.equal(head.props['aria-controls'], undefined, 'closed, so nothing is pointed at yet');

  const body = root.findByProps({ className: 'dim-collapsibleBody' });
  const inner = body.findByProps({ className: 'dim-collapsibleBodyInner' });
  const text = textOf(inner);
  for (const field of ['错误码', '失败阶段', '配置文件', '参考号', '发生时间', 'weixin-startup-config-invalid']) {
    assert.ok(text.includes(field), `diagnostic field ${field} survives`);
  }
  const copy = inner.findAll((node) => node.type === 'button' && textOf(node).includes('复制诊断信息'));
  assert.equal(copy.length, 1, 'the clipboard action survives');

  await act(async () => { head.props.onClick(); });
  assert.equal(disclosure(renderer).root.findByProps({ className: 'dim-collapsibleHead' }).props['aria-expanded'], 'true');
});

test('the context editor expands into the shared body rather than a second container', async () => {
  const renderer = await mount(h(ContextEnhancementEditor, { config: DEFAULT_CONTEXT_ENHANCEMENT_CONFIG }));
  const { root } = disclosure(renderer);
  assert.equal(root.props['data-open'], 'false');
  const entry = root.findByProps({ className: 'dim-contextEntry' });
  assert.equal(entry.type, 'button', 'the entry keeps native button semantics');
  assert.equal(root.findAllByProps({ className: 'dim-collapsibleBody' }).length, 0, 'closed means no body is mounted');

  await act(async () => { entry.props.onClick(); });
  const opened = disclosure(renderer);
  assert.equal(opened.root.props['data-open'], 'true');
  const inner = opened.root.findByProps({ className: 'dim-collapsibleBodyInner' });
  assert.equal(inner.findAllByProps({ className: 'dim-contextPanel' }).length, 1);
});

test('the gesture is declared once, so one edit moves every disclosure', async () => {
  const rotation = sheet.split('rotate(90deg)').length - 1;
  assert.equal(rotation, 1, 'exactly one chevron rotation declaration');
  const rule = sheet.slice(sheet.indexOf('.dim-collapsible.is-open .dim-collapsibleChevron'));
  assert.ok(rule.slice(0, rule.indexOf('}')).includes('transform: rotate(90deg)'));

  const duration = (sheet.match(/--dim-disclosure-duration:/g) ?? []).length;
  assert.equal(duration, 1, 'one disclosure duration token');

  assert.ok(sheet.includes('.dim-collapsible.is-open > .dim-collapsibleBody { grid-template-rows: 1fr; }'));
  assert.ok(sheet.includes('.dim-collapsible:not(.is-open) .dim-collapsibleBodyInner { visibility: hidden; }'));

  // No surface may keep a private copy of the mechanism.
  for (const file of ['connection-error.js', 'context-enhancement.js', 'channels/shared/collapsible-account.js']) {
    const text = await source(`../plugin-src/client/${file}`);
    // The host's own block-level disclosure IS a native details/summary; what is
    // forbidden is carrying its chrome as inline styles, which is how the WeChat
    // diagnostic shipped for months.
    assert.ok(!/h\('details',\s*\{\s*style:/.test(text), `${file} must not skin a native disclosure inline`);
  }
});

test('no disclosure renderer outside the shared primitive survives in the client', async () => {
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`.replaceAll('\\', '/');
      if (entry.isDirectory()) files.push(...await walk(path));
      else if (entry.name.endsWith('.js')) files.push(path);
    }
    return files;
  }
  const root = fileURLToPath(new URL('../plugin-src/client/', import.meta.url));
  const offenders = [];
  for (const file of await walk(root)) {
    const text = await readFile(file, 'utf8');
    if (/h\(\s*'details'\s*,\s*\{\s*style:/.test(text) || /h\(\s*'summary'\s*,\s*\{\s*style:/.test(text)) offenders.push(file.pathname);
  }
  assert.deepEqual(offenders, [], 'no disclosure carries its chrome as inline styles');
});

test('the diagnostic expands into named roles, not inline chrome', async () => {
  // The WeChat diagnostic's chrome lives in the shared connection diagnostic now:
  // upstream generalized the component and weixin re-exports it, so the roles this
  // test guards moved with it.
  const diagnostic = await source('../plugin-src/client/connection-error.js');
  // Its chrome was three inline styles; every one of them is now a class, so the
  // sheet is the only place the surface can be restyled from.
  assert.ok(!/style: \{/.test(diagnostic), 'no inline style survives in the diagnostic');
  for (const role of ['dim-diagnosticFields', 'dim-diagnosticValue', 'dim-diagnosticNotice',
    'dim-diagnosticHint', 'dim-diagnosticTextarea']) {
    assert.ok(diagnostic.includes(role), role + ' is used');
    assert.ok(sheet.includes('.' + role), role + ' is declared in the shared sheet');
  }
  // The roles it borrowed, and the ones that must not move.
  assert.match(sheet, /\.dim-diagnosticFields dt \{[^}]*--dsw-alias-label-tertiary/);
  assert.match(sheet, /\.dim-diagnosticValue \{[^}]*--dsw-alias-label-primary/);
  assert.match(sheet, /\.dim-diagnosticTextarea \{[^}]*var\(--dim-field-border\)/);
  for (const keep of ['readOnly: true', "aria-label': localizeText('诊断信息')", 'rows: 7']) {
    assert.ok(diagnostic.includes(keep), keep + ' survives: it is function, not chrome');
  }
});

