import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sheet = await readFile(new URL('../plugin-src/client/styles.js', import.meta.url), 'utf8');
const source = (relative) => readFile(new URL(relative, import.meta.url), 'utf8');

/** The declarations a rule makes, so a second author is visible as a second rule. */
function ruleFor(css, selector) {
  const start = css.indexOf(selector + ' {');
  assert.notEqual(start, -1, `${selector} is declared`);
  return css.slice(start, css.indexOf('}', start));
}

test('the task progress control is a left-text/right-control row, not a stack', async () => {
  const feishu = await source('../plugin-src/client/channels/feishu/index.js');
  assert.match(feishu, /className: "dim-feishuGroupControl dim-modelRow"/);
  assert.match(feishu, /className: "dim-rowText"/);
  assert.match(feishu, /className: "dim-feishuGroupSelect dim-rowControl"/);

  // The text block owns the title, the live status, the hint and the error; the
  // select is the only thing outside it.
  const rowText = feishu.slice(feishu.indexOf('"dim-rowText"'));
  const select = rowText.indexOf('"dim-feishuGroupSelect dim-rowControl"');
  for (const inside of ['任务过程展示', 'dim-feishuGroupControlStatus', 'dim-feishuGroupHelp', 'dim-feishuGroupError']) {
    const at = rowText.indexOf(inside);
    assert.ok(at !== -1 && at < select, `${inside} sits in the text block`);
  }

  // One author for the geometry: the block must not re-declare the layout the
  // shared row already supplies.
  const block = ruleFor(sheet, '.dim-feishuGroupControl');
  for (const banned of ['display:', 'grid-template-columns', 'gap:', 'padding:']) {
    assert.ok(!block.includes(banned), `.dim-feishuGroupControl must not declare ${banned}`);
  }
});

test('the row label and hint take the shared row roles', () => {
  const label = ruleFor(sheet, '.dim-feishuGroupControlHeader h3');
  assert.ok(label.includes('font-size: var(--dim-font-14)'), '14px');
  assert.ok(label.includes('line-height: var(--dim-line-14)'), '22px');
  assert.ok(label.includes('font-weight: var(--dim-weight-400)'), 'regular, not a heading weight');

  // A field-skin select inside a row was the drift: the control now takes its
  // shape from the one row-control declaration.
  // The row trigger owns no rule at all now: it is a .dim-rowControl button, so its
  // whole shape comes from the one declaration above. The field selects that used to
  // share this class name have their own.
  assert.ok(!sheet.includes('.dim-feishuGroupSelect'), 'the row trigger declares nothing of its own');
  assert.ok(sheet.includes('.dim-panel .dim-fieldSelect {'), 'the field selects have one shared skin');
  const control = sheet.match(/\.dim-panel \.dim-rowControl \{[^}]*\}/);
  assert.ok(control, 'the shared row control is declared');
  for (const required of ['height: 36px', 'border-radius: var(--dim-radius-18)', 'background-color: var(--dim-module-fill)']) {
    assert.ok(control[0].includes(required), `the shared control carries ${required}`);
  }
});

test('an inline editor repeats neither the title nor a close button', async () => {
  const panel = await source('../plugin-src/client/context-enhancement.js');
  assert.ok(!/dim-contextClose/.test(panel), 'the trigger is the only way out');
  assert.ok(!/className: 'dim-contextHeader'/.test(panel), 'no second heading for the same section');
  // The copy the dialog carried is not deleted, only demoted to the hint role.
  assert.match(panel, /dim-helpHint dim-contextIntro/);
  assert.ok(panel.includes('选择在哪些会话中启用、提供哪些来源字段'),
    'the description survives the header removal');
  // Collapsing must discard the draft exactly as the close button did, so the
  // trigger is a toggle rather than an open-only button.
  assert.match(panel, /onClick: \(\) => setOpen\(\(value\) => !value\)/);
  assert.doesNotMatch(sheet, /dim-contextHeader|dim-contextClose/);
});

test('the source-field grid uses the official advanced-grid values', () => {
  const fields = ruleFor(sheet, '.dim-contextFields');
  assert.ok(fields.includes('grid-template-columns: repeat(auto-fit, minmax(160px, 1fr))'));
  assert.ok(fields.includes('gap: var(--dim-gap-8)'));
  assert.ok(fields.includes('padding: 8px 4px 2px'));
});

test('no tooltip skin survives for a tooltip nothing renders', () => {
  for (const ghost of ['dim-channelTooltip', 'dim-globalTtlTooltip', 'dim-globalTtlHelp',
    'dim-contextHeaderTooltip', 'dim-contextFieldTooltip', 'dim-contextLegendTooltip',
    'dim-accessLegendHelp', 'dim-accessUsersHelp', 'dim-contextFieldHelp']) {
    assert.ok(!sheet.includes(ghost), `${ghost} has no render point and no skin`);
  }
});

test('no channel sheet keeps a rule for a class nothing renders', async () => {
  // 36 rules across the Feishu and WeChat sheets described states no render point
  // ever reached: the connecting orbit, the skeleton, the unmounted response-mode
  // block. Every class prefix was re-checked to have zero non-stylesheet references.
  const dead = ['bxf-responseMode', 'bxf-connecting', 'bxf-orbit', 'bxf-orbitCore', 'bxf-skeleton',
    'bxf-note', 'bxf-headingCopy', 'bxf-eyebrow', 'bxf-errorIcon', 'dxw-eyebrow', 'dxw-errorCode'];
  for (const channel of ['feishu', 'weixin']) {
    const css = await source(`../plugin-src/client/channels/${channel}/styles.js`);
    for (const name of dead) {
      assert.ok(!css.includes(name), `${channel} styles must not declare .${name}`);
    }
  }
  const feishu = await source('../plugin-src/client/channels/feishu/styles.js');
  // The orphan animations went with their only users; the two that still have one stay.
  assert.doesNotMatch(feishu, /@keyframes bxf-(pulse|shimmer)/);
  assert.ok(feishu.includes('@keyframes bxf-rotate'), 'bxf-rotate is still used at :276');
  assert.ok(feishu.includes('@keyframes bxf-revealProvision'), 'bxf-revealProvision is still used at :438');
});

test('the text side of a row reads as text, and only the control takes the hand', () => {
  // Measured on the live page before this: the left slot declared no cursor at all, so
  // it showed the default arrow, nothing set user-select, and the row itself had claimed
  // cursor: pointer. The host's rows are plain text, so the slot is declared once.
  assert.ok(ruleFor(sheet, '.dim-rowText > *').includes('cursor: text'), 'the text runs show the I-beam');
  assert.ok(!ruleFor(sheet, '.dim-rowText').includes('cursor: text'),
    'the empty part of the slot keeps the plain arrow');
  assert.ok(ruleFor(sheet, '.dim-rowText').includes('user-select: text'), 'and the run can be selected');
  assert.ok(ruleFor(sheet, '.dim-panel .dim-rowControl').includes('cursor: pointer'),
    'the control is the only thing with the hand');
  assert.ok(!sheet.includes('user-select: none'), 'no row text is locked out of selection');
});

test('a portaled menu carries its own type, because it inherits nothing', () => {
  // Measured live in both themes: .dim-modelMenu computed font-size 16px / line-height
  // normal, the UA default, because it is portaled to BODY and no longer sits inside
  // .dim-panel. Every child happens to declare its own size today, so the cost is only
  // visible to the next thing added; the host's own portaled list carries its own type.
  const menu = ruleFor(sheet, '.dim-modelMenu');
  assert.ok(menu.includes('font-size: var(--dim-font-14)'), 'the menu states its size');
  assert.ok(menu.includes('line-height: var(--dim-line-14)'), 'and its line height');
});

test('the 11px tier is two host roles, not one', () => {
  // The host has 11/16 (.rowTag, .cardIdentity) and 11/17 (.details dt) - label and
  // metadata roles - and its hint role is 12/18 (.advancedHint, .hint). Treating the
  // tier as one thing is why it had been kept whole; ADR-0002's note was right in
  // direction and too broad in scope.
  for (const hint of ['.dim-contextFieldHint', '.dim-contextUnavailable', '.dim-globalInline',
    '.dim-directoryPickerNotice', '.dim-targetFeedback', '.dim-globalTtlHints span']) {
    const rule = ruleFor(sheet, hint);
    assert.ok(rule.includes('font-size: var(--dim-font-12)'), hint + ' takes the hint role');
    assert.ok(!rule.includes('var(--dim-font-11)'), hint + ' left the 11px tier');
  }
  for (const label of ['.dim-channelNote', '.dim-contextSwitchScope', '.dim-targetTitle span',
    '.dim-feishuGroupCountdown', '.dim-targetSessionSyncCopy small', '.dim-contextSwitchScope']) {
    assert.ok(ruleFor(sheet, label).includes('font-size: var(--dim-font-11)'),
      label + ' keeps the label tier the host also has');
  }
});

