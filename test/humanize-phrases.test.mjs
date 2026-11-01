import assert from 'node:assert/strict';
import test from 'node:test';

import { stripMachinePhrases } from '../src/channels/shared/humanize-outbound.mjs';

//
// The stripping rule has one failure mode that matters more than all others: it
// can leave a dangling fragment behind. Removing 「其次」 but not the 「是」 that
// follows it turns a finished sentence into 「是水温，别超过九十三度」, which reads
// worse than the opener it was trying to remove. These cases are the enumeration
// form a model actually produces.
//
test('枚举词连同其后的系词一起移除，不留断句碎片', () => {
  assert.equal(stripMachinePhrases('其次是水温，别超过九十三度。'), '水温，别超过九十三度。');
  assert.equal(stripMachinePhrases('最后是粉水比。'), '粉水比。');
  assert.equal(stripMachinePhrases('首先是好事，其次是坏事。'), '好事，其次是坏事。');
});

test('没有系词的枚举词同样移除，带不带标点都行', () => {
  assert.equal(stripMachinePhrases('首先我要说明一下。'), '我要说明一下。');
  assert.equal(stripMachinePhrases('首先，我要说明一下。'), '我要说明一下。');
});

test('连接词有更轻的说法时只替换不删除', () => {
  assert.equal(stripMachinePhrases('总之这事得等等。'), '总之这事得等等。');
  assert.equal(stripMachinePhrases('总而言之，这事得等等。'), '总之，这事得等等。');
});
