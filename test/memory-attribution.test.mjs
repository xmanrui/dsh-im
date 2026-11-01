import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isNamedSpeaker, renderCandidate } from '../src/channels/shared/memory-extract.mjs';
import { MemoryStore } from '../src/channels/shared/memory-store.mjs';
import { memoryKeyFor, memoryScope, recallMemoryBlock, recordInboundMemory } from '../src/channels/shared/memory-turn.mjs';

/**
 * The live WeChat group path hands every row the same placeholder identity, so
 * these cases are the difference between a memory the model can use and one that
 * says 「uia-unverified:row：喜欢咖啡」.
 */
const PLACEHOLDER = 'uia-unverified:row';

test('placeholder 身份不算人名，真实昵称算', () => {
  assert.equal(isNamedSpeaker(PLACEHOLDER), false);
  assert.equal(isNamedSpeaker('uia-name:小李'), true);
  assert.equal(isNamedSpeaker('小李'), true);
  assert.equal(isNamedSpeaker(''), false);
  assert.equal(isNamedSpeaker(undefined), false);
});

test('无署名的事实用群口吻复述，不出现占位符', () => {
  const like = renderCandidate({ kind: 'preference', label: 'like', object: '喝手冲咖啡', speaker: PLACEHOLDER });
  assert.equal(like, '群里有人喜欢喝手冲咖啡');
  assert.equal(like.includes('uia-unverified'), false);
  assert.equal(renderCandidate({ kind: 'identity', label: 'name', object: '小李', speaker: PLACEHOLDER }), '有人自称小李');
  assert.equal(renderCandidate({ kind: 'plan', label: 'plan', object: '去上海出差', speaker: PLACEHOLDER }), '有人说要去上海出差');
  assert.equal(renderCandidate({ kind: 'note', label: 'explicit', object: '周三有例会', speaker: PLACEHOLDER }), '有人让你记住：周三有例会');
});

test('有名有姓的事实仍然用「名字：内容」，与旧行为一致', () => {
  assert.equal(renderCandidate({ kind: 'preference', label: 'like', object: '喝手冲咖啡', speaker: '小李' }), '小李：喝手冲咖啡');
});

test('无署名的两条不同喜好共存，不会互相顶掉', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-attrib-'));
  const store = new MemoryStore(dir);
  try {
    const scope = memoryScope({ channel: 'weixin', botId: 'wx_a', conversationKey: 'g1' });
    await recordInboundMemory(store, { scope, text: '我喜欢喝手冲咖啡', speaker: PLACEHOLDER, messageId: 'm1' });
    await recordInboundMemory(store, { scope, text: '我喜欢游泳', speaker: PLACEHOLDER, messageId: 'm2' });
    const stats = await store.stats(scope);
    assert.equal(stats.activeFacts, 2, '两条不同的事实都必须在');
    const block = await recallMemoryBlock(store, { scope, query: '喜欢' });
    assert.match(block, /咖啡/u);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('同一个人改口时旧事实失效：这是有署名才有的语义', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-attrib-'));
  const store = new MemoryStore(dir);
  try {
    const scope = memoryScope({ channel: 'weixin', botId: 'wx_a', conversationKey: 'g1' });
    await recordInboundMemory(store, { scope, text: '我喜欢喝手冲咖啡', speaker: '小李', messageId: 'm1' });
    await recordInboundMemory(store, { scope, text: '我喜欢喝茶', speaker: '小李', messageId: 'm2' });
    const stats = await store.stats(scope);
    assert.equal(stats.facts, 2, '旧事实不删');
    assert.equal(stats.activeFacts, 1, '只有新的还在生效');
    // Recall is keyword-based over what was stored, so the query names the drink:
    // the superseded coffee row must be gone, the tea row must be there.
    const block = await recallMemoryBlock(store, { scope, query: '茶' });
    assert.match(block, /茶/u);
    assert.equal(block.includes('咖啡'), false);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('重复的同一句话只是刷新时间，不会堆出重复行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-attrib-'));
  const store = new MemoryStore(dir);
  try {
    const scope = memoryScope({ channel: 'weixin', botId: 'wx_a', conversationKey: 'g1' });
    await recordInboundMemory(store, { scope, text: '我喜欢喝手冲咖啡', speaker: PLACEHOLDER, messageId: 'm1' });
    await recordInboundMemory(store, { scope, text: '我喜欢喝手冲咖啡', speaker: PLACEHOLDER, messageId: 'm2' });
    const stats = await store.stats(scope);
    assert.equal(stats.activeFacts, 1, '同一句重复说不该变成两条记忆');
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('memoryKeyFor 对两种身份给出不同形状的键', () => {
  const named = memoryKeyFor({ label: 'like', object: '咖啡', speaker: '小李' });
  assert.deepEqual(named, { subject: '小李', predicate: 'statement:like' });
  const lore = memoryKeyFor({ label: 'like', object: '咖啡', speaker: PLACEHOLDER });
  assert.equal(lore.subject, 'conversation');
  assert.equal(lore.predicate, 'statement:like:咖啡');
});
