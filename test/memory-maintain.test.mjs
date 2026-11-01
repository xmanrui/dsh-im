import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore, createEphemeralMemoryStore } from '../src/channels/shared/memory-store.mjs';

//
// 记忆是会长出来的：每次改口都会多一条失效事实，槽位到期也不会自己消失。
// 没有维护，库文件无上界增长，备份与迁移一起变慢。
// 这条维护只删已经失效的行，所以它永远不可能让人忘记正在生效的事。
//
const DAY = 86_400_000;
const A = 'weixin:wx_a:group_1';
const B = 'weixin:wx_a:group_2';

function storeAt(dir, now) {
  return new MemoryStore(dir, { now: () => now() });
}

test('改口后失效的旧事实被清掉，当前事实一条不动', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-maintain-'));
  let clock = 1_700_000_000_000;
  const store = storeAt(dir, () => clock);
  try {
    await store.remember({ scope: A, subject: '小李', predicate: 'statement:like', object: '小李：咖啡' });
    clock += 1000;
    await store.remember({ scope: A, subject: '小李', predicate: 'statement:like', object: '小李：茶' });
    assert.equal((await store.stats(A)).activeFacts, 1);
    assert.equal((await store.stats(A)).facts, 2, '改口后库里应有两行');
    clock += 120 * DAY;
    const removed = await store.maintain();
    assert.equal(removed.facts, 1, '只删掉那条失效的');
    assert.equal((await store.stats(A)).facts, 1);
    assert.equal((await store.stats(A)).activeFacts, 1, '当前事实必须在');
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('维护是全库的：不知道有哪些会话也能清干净', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-maintain-'));
  let clock = 1_700_000_000_000;
  const store = storeAt(dir, () => clock);
  try {
    for (const scope of [A, B]) {
      await store.remember({ scope, subject: 's', predicate: 'p', object: '旧' });
      clock += 1000;
      await store.remember({ scope, subject: 's', predicate: 'p', object: '新' });
    }
    clock += 120 * DAY;
    const removed = await store.maintain();
    assert.equal(removed.facts, 2, '两个会话各清一条');
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('还没到期的失效事实不清：给改口留一段可追溯的时间', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-maintain-'));
  let clock = 1_700_000_000_000;
  const store = storeAt(dir, () => clock);
  try {
    await store.remember({ scope: A, subject: 's', predicate: 'p', object: '旧' });
    clock += 1000;
    await store.remember({ scope: A, subject: 's', predicate: 'p', object: '新' });
    clock += DAY;
    assert.equal((await store.maintain()).facts, 0);
    assert.equal((await store.stats(A)).facts, 2);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('过期槽位被清掉，未过期的不动', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-maintain-'));
  let clock = 1_700_000_000_000;
  const store = storeAt(dir, () => clock);
  try {
    await store.setSlot(A, 'short', 'v1', { ttlMs: 1000 });
    await store.setSlot(A, 'long', 'v2');
    clock += 5000;
    const removed = await store.maintain();
    assert.equal(removed.slots, 1);
    const slots = await store.slots(A);
    assert.equal(Object.hasOwn(slots, 'short'), false);
    assert.equal(Object.hasOwn(slots, 'long'), true);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('空库维护是安全的，返回 0/0', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-maintain-'));
  const store = new MemoryStore(dir);
  try {
    assert.deepEqual(await store.maintain(), { facts: 0, slots: 0 });
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('临时库包装也暴露 maintain，仓库关掉后目录仍可删', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-maintain-'));
  const root = join(dir, 'memory');
  const store = createEphemeralMemoryStore(root);
  await store.remember({ scope: A, subject: 's', predicate: 'p', object: 'x' });
  assert.deepEqual(await store.maintain(), { facts: 0, slots: 0 });
  await store.close();
  await rm(root, { recursive: true, force: true });
});
