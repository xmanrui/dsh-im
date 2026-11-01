import assert from 'node:assert/strict';
import test from 'node:test';

import { extractMemoryCandidates, renderCandidate } from '../src/channels/shared/memory-extract.mjs';

const ANON = 'uia-unverified:row';
const remembered = (text) => extractMemoryCandidates(text, { speaker: ANON }).map(renderCandidate);

//
// 「有记忆」最该记住的，是群里**要求你怎么做**。实测：这几句原本一条都记不住。
// 它们既不是喜好（没人喜欢什么），也不是「记住 X」，所以每条规则都漏了。
//
test('标准要求被记住，并渲染成「群里的要求」而不是传闻', () => {
  assert.deepEqual(remembered('以后都用简体中文'), ['群里的要求：用简体中文']);
  assert.deepEqual(remembered('下次直接给成品就行'), ['群里的要求：直接给成品就行']);
  assert.deepEqual(remembered('回答短一点'), ['群里的要求：回答短一点']);
  assert.deepEqual(remembered('回复简洁一点'), ['群里的要求：回复简洁一点']);
});

test('否定式要求保住否定：别把「别问」记成「要问」', () => {
  // 实测缺陷：原规则把「别老是问我要不要帮忙」抽成「有人说要不要帮忙」——意思反了。
  const [only] = remembered('别老是问我要不要帮忙');
  assert.equal(only, '群里的要求：别老是问我要不要帮忙');
  assert.match(only, /别/u);
  assert.deepEqual(remembered('别再发进度了'), ['群里的要求：别再发进度了']);
});

test('放松之后仍然一句闲话都不多记', () => {
  for (const chat of ['今天好热啊', '这个功能挺好用的', '我家猫又胖了', '他说明天不来了']) {
    assert.deepEqual(remembered(chat), [], `${chat} 不该被记住`);
  }
});
