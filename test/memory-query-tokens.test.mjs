import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../src/channels/shared/memory-store.mjs';

const SCOPE = 'weixin:wx_demo:group_room';

//
// 中文不按空格分词，而群里说话又总带着 @。这两条合起来会造成最气人的症状：
// 「明明记过，怎么又问一遍」。实测：记下「喜欢喝手冲咖啡」后，
// 问「咖啡豆哪种好」曾一条都召不回，因为整句被当成一个词元。
//
async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-token-'));
  const store = new MemoryStore(dir);
  try { return await fn(store); } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function seed(store) {
  await store.remember({
    scope: SCOPE, subject: 'conversation', predicate: 'statement:like:咖啡', object: '群里有人喜欢喝手冲咖啡',
  });
}

test('长中文句按二元切片，能命中记忆里的短词', async () => {
  await withStore(async (store) => {
    await seed(store);
    assert.equal((await store.recall({ scope: SCOPE, query: '咖啡豆哪种好' })).length, 1);
  });
});

test('群消息开头的 @ 不算检索词，也不拉低命中率', async () => {
  await withStore(async (store) => {
    await seed(store);
    const facts = await store.recall({ scope: SCOPE, query: '@大肥鱼 咖啡豆哪种好' });
    assert.equal(facts.length, 1);
  });
});

test('短词保持原样，不被拆成单字去匹配一切', async () => {
  await withStore(async (store) => {
    await seed(store);
    // 两个字本身就是词；若拆成单字，任何含「咖」或「啡」的句子都会命中。
    assert.equal((await store.recall({ scope: SCOPE, query: '咖啡' })).length, 1);
    assert.equal((await store.recall({ scope: SCOPE, query: '螺蛳粉' })).length, 0);
  });
});

test('英文与数字不被二元切分误伤', async () => {
  await withStore(async (store) => {
    await store.remember({ scope: SCOPE, subject: 's', predicate: 'p', object: 'deploy 在 v2.1 上' });
    assert.equal((await store.recall({ scope: SCOPE, query: 'deploy' })).length, 1);
    assert.equal((await store.recall({ scope: SCOPE, query: 'v2.1' })).length, 1);
  });
});

test('纯 @ 令牌不产生任何检索词，空查询仍是空结果', async () => {
  await withStore(async (store) => {
    await seed(store);
    assert.deepEqual(await store.recall({ scope: SCOPE, query: '@大肥鱼' }), []);
    assert.deepEqual(await store.recall({ scope: SCOPE, query: '   ' }), []);
  });
});
