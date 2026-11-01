import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_SEGMENTS,
  PLAN_TOTAL_MAX_MS,
  SEGMENT_GAP_MAX_MS,
  SEGMENT_GAP_MIN_MS,
  TYPING_MAX_MS,
  describeOutboundPlan,
  planOutbound,
  segmentGapMs,
  splitReply,
  stripMachinePhrases,
  typingDelayMs,
} from '../src/channels/shared/humanize-outbound.mjs';

test('stripMachinePhrases 删掉 AI 腔开头与客套收尾', () => {
  const text = stripMachinePhrases('作为一个AI，首先我要说明一下。希望对您有所帮助。');
  assert.equal(text, '我要说明一下。');
});

test('stripMachinePhrases 替换报告腔连接词', () => {
  assert.equal(stripMachinePhrases('总而言之，这事得等等。'), '总之，这事得等等。');
  assert.equal(stripMachinePhrases('值得注意的是，他迟到了。'), '另外，他迟到了。');
});

test('stripMachinePhrases 不动角色自己的口癖与结巴', () => {
  const text = '哈哈哈哈哈，这个真的绝了……';
  assert.equal(stripMachinePhrases(text), text);
});

test('stripMachinePhrases 对非字符串输入答空串', () => {
  assert.equal(stripMachinePhrases(undefined), '');
  assert.equal(stripMachinePhrases(''), '');
  assert.equal(stripMachinePhrases(42), '');
});

test('splitReply 短回复保持一条：反应不值得拆', () => {
  assert.deepEqual(splitReply('好'), ['好']);
  assert.deepEqual(splitReply('今天好热。\n\n不想出门。'), ['今天好热。\n\n不想出门。']);
});

test('splitReply 按段落拆分，超出上限时合并最短的相邻两条', () => {
  const text = '第一段说得长一点啊。\n\n第二段也说长一点吧。\n\n第三段继续。\n\n第四段还要。';
  const segments = splitReply(text);
  assert.equal(segments.length, MAX_SEGMENTS);
  // Nothing the model wrote is dropped by the merge.
  assert.equal(segments.join('').replace(/\s+/gu, ''), text.replace(/\s+/gu, ''));
});

test('splitReply 绝不拆结构化内容', () => {
  const code = '```\nconst a = 1;\nconst b = 2;\n```';
  assert.deepEqual(splitReply(code), [code]);
  const list = '- 一\n- 二\n- 三\n- 四\n- 五\n- 六';
  assert.deepEqual(splitReply(list), [list]);
});

test('splitReply 空文本答空数组，拆不开时一字不丢', () => {
  assert.deepEqual(splitReply('   '), []);
  const long = '这是一句话中间没有句号的超长段落我们要看它怎么被处理掉很多很多字'.repeat(4);
  assert.equal(splitReply(long).join(''), long);
});

test('typingDelayMs 按 3 字每秒给延迟', () => {
  const delay = typingDelayMs('今天好热啊我不想出门了', { jitter: 1 });
  assert.ok(delay > 3000 && delay < 4000, String(delay));
});

test('typingDelayMs 太短的回复不装打字', () => {
  assert.equal(typingDelayMs('好', { jitter: 1 }), 0);
  assert.equal(typingDelayMs('', { jitter: 1 }), 0);
});

test('typingDelayMs 扣掉模型已花的生成时间，扣完立刻发', () => {
  const full = typingDelayMs('今天好热啊我不想出门了', { jitter: 1 });
  const remainder = typingDelayMs('今天好热啊我不想出门了', { jitter: 1, elapsedMs: 3000 });
  assert.ok(remainder < full);
  assert.equal(typingDelayMs('今天好热啊我不想出门了', { jitter: 1, elapsedMs: 60000 }), 0);
});

test('typingDelayMs 永不超过上限', () => {
  const delay = typingDelayMs('字'.repeat(400), { jitter: 1 });
  assert.equal(delay, TYPING_MAX_MS);
});

test('segmentGapMs 是同一条回复内部的短停顿', () => {
  const gap = segmentGapMs({ jitter: 1 });
  assert.ok(gap >= SEGMENT_GAP_MIN_MS && gap <= SEGMENT_GAP_MAX_MS);
});

test('planOutbound 第一段走打字延迟，后续只走短停顿', () => {
  const plan = planOutbound('我先说结论：热。\n\n其次是别的细节内容都在这里。\n\n第三段也来一段吧。', { jitter: 1 });
  assert.equal(plan.segments.length, 3);
  assert.equal(plan.delaysMs.length, 3);
  assert.ok(plan.delaysMs[0] > plan.delaysMs[1]);
  assert.equal(plan.delaysMs[1], plan.delaysMs[2]);
});

test('planOutbound 总等待有硬上限', () => {
  const plan = planOutbound('字'.repeat(200));
  const total = plan.delaysMs.reduce((sum, value) => sum + value, 0);
  assert.ok(total <= PLAN_TOTAL_MAX_MS, String(total));
});

test('planOutbound 走 stripMachinePhrases，机器腔不出现在任何一段', () => {
  const plan = planOutbound('作为一个AI，我先说结论：热。\n\n其次是别的细节内容都在这里。', { jitter: 1 });
  assert.ok(!plan.segments.join('').includes('作为一个AI'));
});

test('describeOutboundPlan 给出段数与秒数，坏输入答空串', () => {
  const text = describeOutboundPlan({ segments: ['a', 'b'], delaysMs: [1000, 500] });
  assert.match(text, /2 段/u);
  assert.equal(describeOutboundPlan(null), '');
});
