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

// 判据必须能变红：以下用例分别钉住"渲染稳定"、"替换只动围栏内"、"缺围栏要报错"三件事，
// 并给一条负向对照（围栏外的内容必须原样保留），否则这张表可以静默过期而没人发现。
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
  const first = renderMatrix(channels);
  const second = renderMatrix(channels);
  assert.equal(first, second, 'rendering must be deterministic');
  assert.ok(first.startsWith(BLOCK_START));
  assert.ok(first.endsWith(BLOCK_END));
});

test('each capability column is present in the header', async () => {
  const channels = await collectChannelMatrix();
  const header = renderMatrix(channels).split('\n').find((line) => line.startsWith('| 渠道 |'));
  assert.ok(header, 'header row must exist');
  for (const capability of CAPABILITIES) {
    assert.ok(header.includes(capability.label), 'missing column ' + capability.label);
  }
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
