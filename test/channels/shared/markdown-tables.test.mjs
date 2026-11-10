import assert from 'node:assert/strict';
import test from 'node:test';

import {
  markdownTableDisplayWidth,
  renderPipeTablesAsCode,
  splitMarkdownTableRow,
} from '../../../src/channels/shared/markdown-tables.mjs';

function fenced(...lines) {
  return ['```', ...lines, '```'].join('\n');
}

test('renders a pipe table as an aligned monospace block', () => {
  const input = [
    'Here is the summary:',
    '',
    '| Name | Age |',
    '| --- | --- |',
    '| Ann | 4 |',
    '| Bob | 12 |',
    '',
    'Done.',
  ].join('\n');
  assert.equal(renderPipeTablesAsCode(input), [
    'Here is the summary:',
    '',
    fenced(
      '| Name | Age |',
      '| ---- | --- |',
      '| Ann  | 4   |',
      '| Bob  | 12  |',
    ),
    '',
    'Done.',
  ].join('\n'));
});

test('aligns CJK and emoji cells by display width instead of code unit count', () => {
  const rendered = renderPipeTablesAsCode([
    '| 指标 | value |',
    '| --- | --- |',
    '| 内存 | 3 |',
    '| 磁盘 | 🚀 |',
  ].join('\n'));
  const lines = rendered.split('\n').slice(1, -1);
  const widths = lines.map((line) => markdownTableDisplayWidth(line));
  assert.equal(new Set(widths).size, 1, `columns must line up: ${lines.join(' / ')}`);
  assert.match(rendered, /^\| 指标 \| value \|$/mu);
  assert.match(rendered, /^\| 内存 \| 3     \|$/mu);
});

test('keeps an existing code block and stays idempotent', () => {
  const input = [
    'Before',
    '```markdown',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '```',
    'After',
  ].join('\n');
  assert.equal(renderPipeTablesAsCode(input), input);
  const once = renderPipeTablesAsCode('| a | b |\n| --- | --- |\n| 1 | 2 |');
  assert.equal(renderPipeTablesAsCode(once), once);
});

test('ignores block quotes, list items and indented tables', () => {
  const quoted = '> | a | b |\n> | --- | --- |\n> | 1 | 2 |';
  assert.equal(renderPipeTablesAsCode(quoted), quoted);
  const listed = '- | a | b |\n  | --- | --- |';
  assert.equal(renderPipeTablesAsCode(listed), listed);
  const indented = '    | a | b |\n    | --- | --- |\n    | 1 | 2 |';
  assert.equal(renderPipeTablesAsCode(indented), indented);
});

test('treats escaped pipes and pipes inside inline code as cell content', () => {
  assert.deepEqual(splitMarkdownTableRow('| a \\| b | c |'), ['a | b', 'c']);
  assert.deepEqual(splitMarkdownTableRow('| `a|b` | c |'), ['`a|b`', 'c']);
  const rendered = renderPipeTablesAsCode('| cmd | note |\n| --- | --- |\n| `a|b` | x |');
  assert.match(rendered, /^\| a\|b \| x +\|$/mu);
});

test('strips emphasis and code markers that a fence cannot render', () => {
  const rendered = renderPipeTablesAsCode([
    '| key | value |',
    '| --- | --- |',
    '| **CPU** | `12%` |',
    '| foo__bar__baz | ~~old~~ |',
  ].join('\n'));
  assert.match(rendered, /^\| CPU +\| 12% +\|$/mu);
  assert.match(rendered, /^\| foo__bar__baz \| old +\|$/mu);
});

test('pads short rows and truncates extra cells to the header column count', () => {
  const rendered = renderPipeTablesAsCode([
    '| a | b |',
    '| --- | --- |',
    '| 1 |',
    '| 2 | 3 | ignored |',
  ].join('\n'));
  const lines = rendered.split('\n');
  assert.equal(lines.at(-2), '| 2 | 3 |');
  assert.equal(lines.at(-3), '| 1 |   |');
});

test('leaves text without tables byte-for-byte unchanged', () => {
  const input = 'plain | text without a delimiter row\nand a list:\n- a | b';
  assert.equal(renderPipeTablesAsCode(input), input);
  assert.equal(renderPipeTablesAsCode(''), '');
  assert.equal(renderPipeTablesAsCode(undefined), undefined);
});
