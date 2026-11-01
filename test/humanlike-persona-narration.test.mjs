import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_PERSONA, normalizePersona, renderPersonaGuidance } from '../src/channels/shared/persona.mjs';

//
// 真实群聊回放（2026-11-02 05:24）里，机器人把自己的重试过程全发进了群：
//   「画面太糊了，没有层次。我重做一版，加域扭曲…」
//   「画面还是太糊了。我换成真正的 fBm…」
// 人不会边做边念。人设卡原本**一条规则都没管这件事**，所以模型照着「助手汇报进度」演。
//
test('人设卡明确禁止汇报中间过程', () => {
  const card = renderPersonaGuidance(DEFAULT_PERSONA);
  for (const phrase of ['过程烂在肚子里', '重做一版', '不描述中间的试错']) {
    assert.ok(card.includes(phrase), `人设卡必须包含「${phrase}」`);
  }
  // 而且要给出正确做法，不只是禁止。
  assert.match(card, /直接给结果/u);
});

test('新规则没有把卡片撑出限额，也没有挤掉别的规则', () => {
  const back = normalizePersona(DEFAULT_PERSONA);
  // 任何字段超限都会被截断或丢弃；默认卡必须原样活下来。
  assert.equal(back.styleRules, DEFAULT_PERSONA.styleRules);
  assert.equal(back.taboos, DEFAULT_PERSONA.taboos);
  assert.equal(back.speakingStyle, DEFAULT_PERSONA.speakingStyle);
  // 原有规则一条不少。
  const card = renderPersonaGuidance(DEFAULT_PERSONA);
  for (const kept of ['不写「作为一个AI」', '不主动总结对方说的话', '不确定的事说不确定']) {
    assert.ok(card.includes(kept), `原有规则「${kept}」不能被挤掉`);
  }
});
