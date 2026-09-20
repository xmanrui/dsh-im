import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sanitizeMarkdownTables } from '../../../src/channels/feishu/feishu-channel.mjs';

/**
 * Feishu renders a markdown table inside a card as a `table` element, and one
 * card accepts only a single such element. A reply carrying several tables is
 * therefore rejected outright:
 *
 *   ErrCode 11310  card table number over limit   (ErrorValue: table)
 *
 * The card silently stops updating and the user never sees the answer, so
 * tables are rewritten into plain text before the card write.
 */
describe('sanitizeMarkdownTables', () => {
  it('rewrites a single table into labelled bullets', () => {
    const input = ['| 项 | 状态 |', '|---|---|', '| 服务 | 正常 |', '| 错误 | 0 |'].join('\n');
    const out = sanitizeMarkdownTables(input);
    assert.equal(out.includes('|---|'), false, 'delimiter row must be gone');
    assert.match(out, /- \*\*项\*\*: 服务 · \*\*状态\*\*: 正常/);
    assert.match(out, /- \*\*项\*\*: 错误 · \*\*状态\*\*: 0/);
  });

  it('rewrites every table in a multi-table reply', () => {
    const input = [
      '| A | B |', '|---|---|', '| 1 | 2 |',
      '', '中间文字', '',
      '| C | D |', '|---|---|', '| 3 | 4 |',
    ].join('\n');
    const out = sanitizeMarkdownTables(input);
    assert.equal(out.includes('|---|'), false);
    assert.match(out, /中间文字/);
    assert.match(out, /\*\*A\*\*: 1/);
    assert.match(out, /\*\*C\*\*: 3/);
  });

  it('leaves non-table pipes untouched', () => {
    // Shell pipelines and `a || b` are not GFM tables and must survive.
    const input = '命令：cat a.txt | grep b\n\n逻辑：a || b';
    assert.equal(sanitizeMarkdownTables(input), input);
  });

  it('leaves text without any pipe untouched', () => {
    const input = '普通回复，没有任何表格。';
    assert.equal(sanitizeMarkdownTables(input), input);
  });

  it('does not treat a lone header row as a table', () => {
    // A delimiter row is required; otherwise this is just a pipe-containing line.
    const input = '| 只有一个表头 |';
    assert.equal(sanitizeMarkdownTables(input), input);
  });

  it('renders a header-only table without dropping it', () => {
    const input = ['| A | B |', '|---|---|'].join('\n');
    const out = sanitizeMarkdownTables(input);
    assert.equal(out.includes('|---|'), false);
    assert.match(out, /A/);
    assert.match(out, /B/);
  });

  it('handles a single-column table', () => {
    const input = ['| 项 |', '|---|', '| 一 |', '| 二 |'].join('\n');
    const out = sanitizeMarkdownTables(input);
    assert.equal(out.includes('|---|'), false);
    assert.match(out, /- 一/);
    assert.match(out, /- 二/);
  });

  it('accepts null and undefined', () => {
    assert.equal(sanitizeMarkdownTables(null), '');
    assert.equal(sanitizeMarkdownTables(undefined), '');
  });

  it('produces zero table elements for a realistic status report', () => {
    // The shape that actually triggered ErrCode 11310 in production.
    const input = [
      '状态报告：',
      '',
      '| 项 | 状态 |', '|---|---|', '| 服务 | 正常 |',
      '',
      '| 指标 | 值 |', '|---|---|', '| 错误 | 0 |',
      '',
      '| 模块 | 结果 |', '|---|---|', '| 插件 | 通过 |',
    ].join('\n');
    const out = sanitizeMarkdownTables(input);
    assert.equal(out.includes('|---|'), false);
    assert.equal(/^\s*\|/m.test(out), false, 'no row may still start with a pipe');
  });
});
