import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractMemoryCandidates, renderCandidate } from '../src/channels/shared/memory-extract.mjs';
import { MemoryStore } from '../src/channels/shared/memory-store.mjs';
import { memoryScope, recallMemoryBlock, recordInboundMemory } from '../src/channels/shared/memory-turn.mjs';

test('抽取规则认得自称、喜好、厌恶与显式记住', () => {
  assert.deepEqual(extractMemoryCandidates('我叫小李').map((c) => c.kind), ['identity']);
  assert.deepEqual(extractMemoryCandidates('我喜欢喝手冲咖啡').map((c) => c.kind), ['preference']);
  assert.deepEqual(extractMemoryCandidates('我讨厌开长会').map((c) => c.kind), ['dislike']);
  assert.deepEqual(extractMemoryCandidates('记住 周三下午我有例会').map((c) => c.kind), ['note']);
});

test('没关系的话一条都不抽：不猜就没记错', () => {
  assert.deepEqual(extractMemoryCandidates('今天天气不错'), []);
  assert.deepEqual(extractMemoryCandidates('/dsh 在吗'), []);
  assert.deepEqual(extractMemoryCandidates(''), []);
  assert.deepEqual(extractMemoryCandidates(undefined), []);
});

test('同一句话里同一类只留一条，且不把命令当陈述', () => {
  const candidates = extractMemoryCandidates('/remember 我喜欢喝猫屎咖啡');
  // The command prefix is stripped, so the statement behind it is still read.
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, 'preference');
});

test('renderCandidate 带上说话人，群里不说清是谁等于没记', () => {
  assert.equal(renderCandidate({ object: '喝手冲咖啡', speaker: '小李' }), '小李：喝手冲咖啡');
  assert.equal(renderCandidate({ object: '喝手冲咖啡', speaker: '' }), '喝手冲咖啡');
  assert.equal(renderCandidate({ object: '' }), '');
});

test('scope 由渠道+bot+会话拼成，非白名单字符被替换', () => {
  assert.equal(memoryScope({ channel: 'weixin', botId: 'wx_ab', conversationKey: 'g1' }), 'weixin:wx_ab:g1');
  assert.equal(memoryScope({ channel: 'weixin', botId: 'wx_ab', conversationKey: 'a b/c' }), 'weixin:wx_ab:a_b_c');
  assert.equal(memoryScope({ channel: 'weixin', botId: '', conversationKey: 'g1' }), null);
  assert.equal(memoryScope({}), null);
});

test('端到端：写进去的喜好能在下一条消息里被召回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-turn-'));
  const store = new MemoryStore(dir);
  try {
    const scope = memoryScope({ channel: 'weixin', botId: 'wx_ab', conversationKey: 'g1' });
    const written = await recordInboundMemory(store, {
      scope, text: '我喜欢喝手冲咖啡', speaker: '小李', messageId: 'm1',
    });
    assert.equal(written, 1);
    const block = await recallMemoryBlock(store, { scope, query: '咖啡' });
    assert.match(block, /小李/u);
    assert.match(block, /手冲咖啡/u);
    // A different conversation must not see it.
    const otherScope = memoryScope({ channel: 'weixin', botId: 'wx_ab', conversationKey: 'g2' });
    assert.equal(await recallMemoryBlock(store, { scope: otherScope, query: '咖啡' }), '');
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('记忆关闭时读写都是空操作，不抛错', async () => {
  assert.equal(await recordInboundMemory(null, { scope: 's:1:a', text: '我喜欢猫' }), 0);
  assert.equal(await recallMemoryBlock(null, { scope: 's:1:a', query: '猫' }), '');
  assert.equal(await recordInboundMemory({ remember: async () => { throw new Error('boom'); } }, {
    scope: 's:1:a', text: '我喜欢猫', logger: { warn: () => {} },
  }), 0);
});

test('记忆读失败不冒泡，回复照常发', async () => {
  const block = await recallMemoryBlock({
    recall: async () => { throw new Error('disk'); },
    slots: async () => ({}),
  }, { scope: 's:1:a', query: '猫', logger: { warn: () => {} } });
  assert.equal(block, '');
});
