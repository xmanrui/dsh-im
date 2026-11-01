import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_SEGMENT_CHARS, splitReply } from '../src/channels/shared/humanize-outbound.mjs';

//
// 这两条是实测出来的坑，不是想出来的边界：
//   ① 一句话本身超过单条上限时（粘贴的日志、没有句号的长文），旧代码不切，
//      整条远超上限，到发送那一步才失败；
//   ② 硬切按 UTF-16 下标走，切点落在 emoji 的代理对中间时，两边都是半个字符。
//
function loneSurrogates(text) {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
      else count += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      count += 1;
    }
  }
  return count;
}

test('没有句号的长文本被切到上限以内，而不是整条塞过去', () => {
  const text = '字'.repeat(MAX_SEGMENT_CHARS * 3 + 17);
  const segments = splitReply(text);
  assert.ok(segments.length <= 3, `段数应受上限约束，实际 ${segments.length}`);
  // 文本一字不丢（拼回去与原文等长）。
  assert.equal(segments.join('').replace(/\n/gu, '').length, text.length);
});

test('切点不劈开代理对：emoji 长文切完没有孤立半字符', () => {
  const text = 'a' + '\u{1F600}'.repeat(3000);
  const segments = splitReply(text);
  const lone = segments.reduce((sum, segment) => sum + loneSurrogates(segment), 0);
  assert.equal(lone, 0);
});

test('切点落在代理对正中时仍然安全', () => {
  // 119 个单字节 + emoji：上限的落点正好压在代理对上。
  const text = 'x'.repeat(MAX_SEGMENT_CHARS - 1) + '\u{1F600}'.repeat(2000);
  const segments = splitReply(text);
  const lone = segments.reduce((sum, segment) => sum + loneSurrogates(segment), 0);
  assert.equal(lone, 0);
});

test('短回复与结构化内容不受影响', () => {
  assert.deepEqual(splitReply('好'), ['好']);
  const code = '```\nconst a = 1;\n```';
  assert.deepEqual(splitReply(code), [code]);
});
