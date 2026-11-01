import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../src/channels/shared/memory-store.mjs';
import { memoryScope, recallMemoryBlock, recordInboundMemory } from '../src/channels/shared/memory-turn.mjs';
import { renderPersonaGuidance, DEFAULT_PERSONA } from '../src/channels/shared/persona.mjs';
import { planOutbound } from '../src/channels/shared/humanize-outbound.mjs';

/**
 * 一条群消息的完整回路：进站写记忆 → 拼提示 → 出站分条。
 * 这条用例钉住的是三个模块的接缝，而不是各自内部（各自有单独用例）。
 */
test('一条群消息走完三条缝：人设有字、记忆有关、回复像人', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-seam-'));
  const store = new MemoryStore(dir);
  try {
    const scope = memoryScope({ channel: 'weixin', botId: 'wx_demo', conversationKey: 'group-1' });
    // 第一天：小李说自己喜欢手冲咖啡。
    await recordInboundMemory(store, { scope, text: '我喜欢喝手冲咖啡', speaker: '小李', messageId: 'm1' });
    // 第二天：群里又聊到咖啡，机器人在回答前把这条记忆捡回来。
    const memory = await recallMemoryBlock(store, { scope, query: '咖啡' });
    assert.match(memory, /小李/u);
    // 人设是另一条独立的提示上下文，和记忆互不覆盖。
    const persona = renderPersonaGuidance(DEFAULT_PERSONA);
    assert.match(persona, /大肥鱼/u);
    assert.notEqual(persona, memory);
    // 出站：一条有机器腔的长回复被拆成口语短句，且没有任何一段带「作为一个AI」。
    const answer = '作为一个AI，我先说结论：手冲豆子新鲜最重要。\n\n其次是水温，别超过九十三度。';
    const plan = planOutbound(answer);
    assert.ok(plan.segments.length >= 1);
    assert.ok(!plan.segments.join('').includes('作为一个AI'));
    assert.equal(plan.delaysMs.length, plan.segments.length);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
