import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BLOCK_END,
  BLOCK_START,
  CAPABILITIES,
  collectChannelMatrix,
  renderMatrix,
  replaceBlock,
} from '../scripts/channel-capability-matrix.mjs';

// 判据必须能变红：以下用例分别钉住"渲染稳定"、"两种语言只换标签"、"替换只动围栏内"、
// "缺围栏要报错"四件事，否则这张表可以静默过期而没人发现。
test('every channel directory except shared produces a row', async () => {
  const channels = await collectChannelMatrix();
  const names = channels.map((channel) => channel.channel);
  assert.ok(names.length >= 14, 'expected at least 14 channel directories, got ' + names.length);
  assert.equal(names.includes('shared'), false);
  assert.equal(names.includes('office'), true);
  assert.deepEqual(names.slice().sort(), names, 'rows must be sorted for a stable diff');
});

test('the rendered block is fenced and repeats identically', async () => {
  const channels = await collectChannelMatrix();
  assert.equal(renderMatrix(channels), renderMatrix(channels), 'rendering must be deterministic');
  const block = renderMatrix(channels);
  assert.ok(block.startsWith(BLOCK_START));
  assert.ok(block.endsWith(BLOCK_END));
});

test('each capability column is present in both locales', async () => {
  const channels = await collectChannelMatrix();
  for (const [locale, channelLabel] of [['zh', '渠道'], ['en', 'Channel']]) {
    const header = renderMatrix(channels, locale).split('\n').find((line) => line.startsWith('| ' + channelLabel + ' |'));
    assert.ok(header, 'missing ' + locale + ' header row');
    for (const capability of CAPABILITIES) {
      const expected = locale === 'en' ? (capability.labelEn ?? capability.label) : capability.label;
      assert.ok(header.includes(expected), 'missing ' + locale + ' column ' + expected);
    }
  }
});

// 同一份数据、两种语言：行数必须一致，格内容必须逐行相同（只允许表头/图例不同）。
test('both locales agree cell by cell', async () => {
  const channels = await collectChannelMatrix();
  const dataRows = (locale) => renderMatrix(channels, locale)
    .split('\n')
    .filter((line) => line.startsWith('| \`'));
  const zh = dataRows('zh');
  const en = dataRows('en');
  assert.deepEqual(zh, en, 'the two locales must describe exactly the same channels and cells');
});

// 负向对照：围栏之外的内容（赞助商、安装说明）一个字节都不能被替换掉。
test('replaceBlock only rewrites the fenced region', () => {
  const document = 'HEAD\n' + BLOCK_START + '\nold table\n' + BLOCK_END + '\nTAIL\n';
  const { document: next, replaced } = replaceBlock(document, BLOCK_START + '\nnew\n' + BLOCK_END);
  assert.equal(replaced, true);
  assert.ok(next.startsWith('HEAD\n'));
  assert.ok(next.endsWith('TAIL\n'));
  assert.ok(next.includes('new'));
  assert.equal(next.includes('old table'), false);
});

test('a document without the fence is refused instead of silently rewritten', () => {
  const { replaced } = replaceBlock('no fence here', BLOCK_START + 'x' + BLOCK_END);
  assert.equal(replaced, false);
});
