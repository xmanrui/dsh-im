import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractForgetTarget } from '../src/channels/shared/memory-extract.mjs';
import { MemoryStore } from '../src/channels/shared/memory-store.mjs';
import { forgetMatching, recordInboundMemory } from '../src/channels/shared/memory-turn.mjs';

//
// 能改的记忆才值得信。机器人说错了话，唯一的补救是让它忘掉。
// 两条纪律：只删这个会话里、字面命中的行；拿不准就不删（删错比忘不掉更糟）。
//
const A = 'weixin:wx_a:group_1';
const B = 'weixin:wx_a:group_2';

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-forget-'));
  const store = new MemoryStore(dir);
  try { return await fn(store); } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('认得几种忘记说法', () => {
  assert.equal(extractForgetTarget('忘掉咖啡'), '咖啡');
  assert.equal(extractForgetTarget('忘记我喜欢喝咖啡'), '我喜欢喝咖啡');
  assert.equal(extractForgetTarget('别记着橘猫'), '橘猫');
  assert.equal(extractForgetTarget('不用记住这事'), '这事');
});

test('不是忘记指令的一律返回 null', () => {
  assert.equal(extractForgetTarget('我喜欢咖啡'), null);
  assert.equal(extractForgetTarget('今天天气不错'), null);
  assert.equal(extractForgetTarget(''), null);
  assert.equal(extractForgetTarget(undefined), null);
  // 单字在中文里就是真实目标（「忘掉茶」），不设长度门槛；
  // 安全性由「字面包含」判定保证，不由目标长度保证。
  assert.equal(extractForgetTarget('忘掉茶'), '茶');
});

test('忘掉命中短语的事实，别的一条不动', async () => {
  await withStore(async (store) => {
    await recordInboundMemory(store, { scope: A, text: '我喜欢喝手冲咖啡', speaker: '小李' });
    await recordInboundMemory(store, { scope: A, text: '我养了只橘猫', speaker: '小李' });
    const removed = await forgetMatching(store, { scope: A, target: '咖啡' });
    assert.equal(removed, 1);
    const left = await store.recall({ scope: A, query: '橘猫' });
    assert.equal(left.length, 1);
    assert.match(left[0].object, /橘猫/u);
    assert.equal((await store.recall({ scope: A, query: '咖啡' })).length, 0);
  });
});

test('只删本会话：另一个群的同样事实不受影响', async () => {
  await withStore(async (store) => {
    await recordInboundMemory(store, { scope: A, text: '我喜欢喝手冲咖啡', speaker: '小李' });
    await recordInboundMemory(store, { scope: B, text: '我喜欢喝手冲咖啡', speaker: '小李' });
    await forgetMatching(store, { scope: A, target: '咖啡' });
    assert.equal((await store.recall({ scope: A, query: '咖啡' })).length, 0);
    assert.equal((await store.recall({ scope: B, query: '咖啡' })).length, 1);
  });
});

test('入站消息里的忘记指令走删除，而不是被记成新事实', async () => {
  await withStore(async (store) => {
    await recordInboundMemory(store, { scope: A, text: '我喜欢喝手冲咖啡', speaker: '小李' });
    const result = await recordInboundMemory(store, { scope: A, text: '忘掉咖啡', speaker: '小李' });
    // 负数表示删掉了几条，与「写入几条」区分开。
    assert.equal(result, -1);
    assert.equal((await store.recall({ scope: A, query: '咖啡' })).length, 0);
  });
});

test('忘掉不存在的东西是安全空操作', async () => {
  await withStore(async (store) => {
    await recordInboundMemory(store, { scope: A, text: '我养了只橘猫', speaker: '小李' });
    assert.equal(await forgetMatching(store, { scope: A, target: '螺蛳粉' }), 0);
    assert.equal((await store.recall({ scope: A, query: '橘猫' })).length, 1);
  });
});
