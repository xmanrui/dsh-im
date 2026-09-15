import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const sheet = await readFile(new URL('../plugin-src/client/styles.js', import.meta.url), 'utf8');
const CLIENT = new URL('../plugin-src/client/', import.meta.url);
const source = (relative) => readFile(new URL(relative, import.meta.url), 'utf8');

async function clientSources(dir = CLIENT) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) found.push(...await clientSources(child));
    else if (entry.name.endsWith('.js')) found.push({ name: entry.name, text: await readFile(child, 'utf8') });
  }
  return found;
}
const client = await clientSources();

/** A class that only ever named stacked copy. Nothing may render or declare it again. */
const RETIRED = [
  'dim-contextLegendHint', 'dim-contextFieldHint', 'dim-contextIntro', 'dim-helpHint',
  'dim-aliasHelp', 'dim-globalTtlHints', 'dim-updateDescription', 'dim-switchHint', 'dim-callbackHint',
];

test('help is one role with one author, and no fourth variant exists', async () => {
  assert.match(sheet, /\.dim-helpButton \{/, 'the one button skin');
  assert.match(sheet, /\.dim-helpPanel \{/, 'the one panel skin');
  assert.match(sheet, /\.dim-help \{/, 'the one wrapper');
  // This role is used inside the settings panel AND inside dialogs that portal to
  // document.body. A panel-scoped rule would not match in the dialogs at all, so the
  // skin must stay unscoped - the opposite of what the other shared roles need.
  assert.ok(!/\.dim-panel \.dim-help/.test(sheet), 'the help skin is not scoped to the panel');
  // The two class-name sets this role used to have are gone as declarations, not merely
  // unused: the sheet's comments name them, so this reads selectors, not prose.
  assert.ok(!/\.dim-context(Help|Tooltip)|(^|[^\w-])\.dim-preset(Help|Tooltip)/m.test(sheet),
    'the retired help class names declare nothing');
  assert.equal((sheet.match(/\.dim-[A-Za-z]*[Hh]elp[A-Za-z]*Button/g) || [])
    .filter((name, index, all) => all.indexOf(name) === index).length, 1,
  'exactly one help button skin is declared');
});

test('the panel keeps the pairing invariant: dark base, static light foreground', () => {
  const at = sheet.indexOf('.dim-helpPanel,');
  assert.notEqual(at, -1, 'the panel takes the shared native tooltip skin');
  const skin = sheet.slice(at, sheet.indexOf('}', at));
  assert.ok(skin.includes('background: var(--dsw-alias-tooltip-bg'), 'the base is the tooltip base, not a surface');
  assert.ok(skin.includes('color: var(--dsw-static-neutral-bluish-00'),
    'the foreground is a STATIC light value - an alias would flip with the theme and land back on the 1.x:1 defect');
  assert.ok(skin.includes('font-size: var(--dim-font-13)') && skin.includes('font-weight: var(--dim-weight-400)'),
    '13/400');
});

test('the panel is hidden until its own button is hovered or focused', async () => {
  const panel = sheet.slice(sheet.indexOf('.dim-helpPanel {'));
  const rule = panel.slice(0, panel.indexOf('}'));
  assert.ok(rule.includes('opacity: 0') && rule.includes('visibility: hidden'), 'hidden by default');
  const show = sheet.match(/\.dim-helpPanel\[data-open="true"\][^{]*\{[^}]*\}/);
  assert.ok(show, 'the open state is declared');
  assert.ok(show[0].includes('opacity: 1') && show[0].includes('visibility: visible'), 'shown while open');

  // The panel is portaled to document.body: inside the card it was clipped by the card
  // and painted under the block next to it, which is the defect this shape fixes. The
  // component therefore owns the open state - a CSS hover rule cannot reach a node that
  // is no longer its descendant.
  assert.match(sheet, /\.dim-helpPanel \{[^}]*position: fixed;/, 'fixed, not absolute in the card');
  assert.match(sheet, /\.dim-helpPanel \{[^}]*z-index: var\(--dim-z-menu\)/, 'on the top layer the menus use');
  const tip = await source('../plugin-src/client/help-tip.js');
  assert.match(tip, /createPortal\(panel, target\)/, 'the panel is portaled out of the card');
  assert.match(tip, /globalThis\.document\?(\.|\?\.)body/, 'and it targets document.body');
  assert.match(tip, /onMouseEnter: show/, 'the component owns hover');
  assert.match(tip, /onFocus: show/, 'and keyboard focus');
});

test('nothing renders a stacked description any more, in source or in the sheet', async () => {
  for (const name of RETIRED) {
    for (const file of client) {
      // Read the class names a file actually RENDERS, not every occurrence of the token:
      // the sheet and these files both name the classes they retired, and a prose mention
      // must not read as a live render point.
      const rendered = [...file.text.matchAll(/className:\s*['"`]([^'"`]+)['"`]/g)]
        .flatMap((match) => match[1].split(/\s+/));
      assert.ok(!rendered.includes(name), `${name} is still rendered in ${file.name}`);
    }
    // Same on the other side: a declaration starts a selector, a comment does not.
    assert.ok(!new RegExp('\\.' + name + '\\s*[,{:]').test(sheet), `${name} is still declared in the sheet`);
  }
});

test('each converted site renders it through the shared component', async () => {
  const sites = [
    ['../plugin-src/client/context-enhancement.js', 'the source-fields block and the guidance editor'],
    ['../plugin-src/client/access-policy-settings.js', 'the access legend'],
    ['../plugin-src/client/bot-alias.js', 'the alias field'],
    ['../plugin-src/client/global-settings.js', 'the attachment TTL value legend'],
    ['../plugin-src/client/update-panel.js', 'the update panel description'],
    ['../plugin-src/client/channels/wecom-app/index.js', 'the stream switch and the callback box'],
    ['../plugin-src/client/channels/feishu/index.js', 'the preset header'],
  ];
  for (const [relative, what] of sites) {
    const text = await source(relative);
    assert.match(text, /from '[^']*help-tip\.js'/, `${what} imports the shared tip`);
    assert.match(text, /h\(HelpTip,/, `${what} renders it`);
  }
  // The component itself has to wire the panel to the button, or the text is unreachable
  // for anyone not using a pointer.
  const tip = await source('../plugin-src/client/help-tip.js');
  assert.match(tip, /'aria-describedby': id/, 'the button points at the panel');
  assert.match(tip, /role: 'tooltip'/, 'the panel announces itself as a tooltip');
});
