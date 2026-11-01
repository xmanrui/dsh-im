import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../src/channels/shared/memory-store.mjs';

const SCOPE = 'weixin:wx_demo:group-1';

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-recall-'));
  const store = new MemoryStore(dir);
  try { return await fn(store); } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function seed(store) {
  await store.remember({
    scope: SCOPE, subject: 'conversation', predicate: 'statement:has:橘猫', object: '群里有人有橘猫',
  });
  await store.remember({
    scope: SCOPE, subject: '小李', predicate: 'statement:activity', object: '小李：学吉他',
  });
}

//
// 召回是「关键词命中才注入」的形态，所以「命中几个词」直接决定有没有记忆。
// 这里钉的是那条实测出来的坑：词与词之间若一律按 AND 连接，群里一句
// 「你那只橘猫会弹吉他吗」里只要有一个词没见过，整段记忆就一起返回空。
//
test('一个陌生词不能把整段记忆抹掉：严格无果时退到任一词命中', async () => {
  await withStore(async (store) => {
    await seed(store);
    // 严格路径：两个词都命中才返回。
    assert.equal((await store.recall({ scope: SCOPE, query: '橘猫 吉他' })).length, 2);
    // 只有一个词命中 + 一个陌生词：旧行为是 0 条，现在是命中的那条。
    const wide = await store.recall({ scope: SCOPE, query: '橘猫 螺蛳粉' });
    assert.equal(wide.length, 1);
    assert.match(wide[0].object, /橘猫/u);
  });
});

test('严格命中时宽匹配不介入，排序与条数都不变', async () => {
  await withStore(async (store) => {
    await seed(store);
    const strict = await store.recall({ scope: SCOPE, query: '橘猫' });
    assert.equal(strict.length, 1);
    assert.equal(strict[0].subject, 'conversation');
  });
});

test('完全无关的查询仍然返回空，不靠兜底乱给', async () => {
  await withStore(async (store) => {
    await seed(store);
    assert.deepEqual(await store.recall({ scope: SCOPE, query: '螺蛳粉' }), []);
  });
});

test('LIMIT 仍然生效，宽匹配不会把整库倒出来', async () => {
  await withStore(async (store) => {
    for (let index = 0; index < 30; index += 1) {
      await store.remember({
        scope: SCOPE, subject: `s${index}`, predicate: 'p', object: `咖啡${index}`,
      });
    }
    const facts = await store.recall({ scope: SCOPE, query: '咖啡 螺蛳粉', limit: 5 });
    assert.equal(facts.length, 5);
  });
});
