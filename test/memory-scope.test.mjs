import assert from 'node:assert/strict';
import test from 'node:test';

import { memoryScope } from '../src/channels/shared/memory-turn.mjs';

//
// scope 是记忆的隔离边界：两个会话编码成同一个字符串，就等于互相读对方的记忆。
// 实测过的碰撞：`group:x:y` 与 `group:x_y` 都变成 `group_x_y`。
//
test('曾经碰撞的两个会话键现在编码不同', () => {
  const a = memoryScope({ channel: 'weixin', botId: 'wx', conversationKey: 'group:x:y' });
  const b = memoryScope({ channel: 'weixin', botId: 'wx', conversationKey: 'group:x_y' });
  assert.notEqual(a, b);
});

test('编码是单射：任意两个不同的键都不会落到同一个 scope', () => {
  const keys = [
    'group:a', 'group:a_', 'group:_a', 'group:a:b', 'group:a_b', 'p2p:a', 'p2p:a_',
    'group:uia_group_room', 'p2p:uia-name:x', 'p2p:uia_name:x', 'group:中文群', 'group:a b',
  ];
  const seen = new Map();
  for (const key of keys) {
    const scope = memoryScope({ channel: 'weixin', botId: 'wx', conversationKey: key });
    assert.equal(seen.has(scope), false, `${key} 与 ${seen.get(scope)} 撞成 ${scope}`);
    seen.set(scope, key);
  }
});

test('输出只用 store 允许的字符集，且长度受限', () => {
  const scope = memoryScope({ channel: 'weixin', botId: 'wx', conversationKey: '群:A B/中' });
  assert.match(scope, /^[A-Za-z0-9_.:-]+$/u);
  const long = memoryScope({ channel: 'weixin', botId: 'wx', conversationKey: 'x'.repeat(400) });
  assert.equal(long, null, '超长直接拒绝而不是截断（截断会再制造碰撞）');
});

test('空段仍然被拒绝', () => {
  assert.equal(memoryScope({ channel: 'weixin', botId: '', conversationKey: 'g' }), null);
  assert.equal(memoryScope({}), null);
});
