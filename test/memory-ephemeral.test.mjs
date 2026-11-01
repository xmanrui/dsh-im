import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEphemeralMemoryStore } from '../src/channels/shared/memory-store.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ephemeral-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('每次操作自己开库关库，写进去的读得回来', async () => {
  await withTempDir(async (dir) => {
    const store = createEphemeralMemoryStore(join(dir, 'memory'));
    await store.remember({
      scope: 'weixin:wx_a:g1', subject: '小李', predicate: 'statement:like', object: '小李：喝手冲咖啡',
    });
    const facts = await store.recall({ scope: 'weixin:wx_a:g1', query: '咖啡' });
    assert.equal(facts.length, 1);
    assert.match(facts[0].object, /手冲咖啡/u);
  });
});

test('close 只排空队列：关掉之后目录立刻可删（Windows 的 EBUSY 回归）', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'memory');
    const store = createEphemeralMemoryStore(root);
    await store.remember({ scope: 'weixin:wx_a:g1', subject: '小李', predicate: 'p', object: 'x' });
    await store.close();
    // The whole point: no handle survives the call, so removal must succeed.
    await rm(root, { recursive: true, force: true });
  });
});

test('并发调用被串行化，不会两个事务交错', async () => {
  await withTempDir(async (dir) => {
    const store = createEphemeralMemoryStore(join(dir, 'memory'));
    await Promise.all(Array.from({ length: 8 }, (_, index) => store.remember({
      scope: 'weixin:wx_a:g1', subject: `s${index}`, predicate: 'p', object: `o${index}`,
    })));
    const stats = await store.stats('weixin:wx_a:g1');
    assert.equal(stats.activeFacts, 8);
  });
});
