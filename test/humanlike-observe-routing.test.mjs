import assert from 'node:assert/strict';
import test from 'node:test';

import { decideObserved } from '../src/channels/weixin/wechat-group-runtime.mjs';

//
// 观察模式的边界：一条没 @ 的消息可以进记忆，但**不能变成一轮对话**。
// 这里钉的是那条路由规则本身（纯函数），桥那一侧的「不回答」在
// humanlike-observe.test.mjs 里另有用例。
//
function group(overrides = {}) {
  return {
    id: 'uia_group_room',
    commandPrefix: '/dsh',
    observeAmbient: false,
    ...overrides,
  };
}

function event(text, { isSelf = false } = {}) {
  return { text, raw_text: text, is_self: isSelf };
}

test('没开观察：未 @ 的行一律拒掉，理由仍是 not-addressed', () => {
  const verdict = decideObserved(event('我喜欢喝手冲咖啡'), group());
  assert.equal(verdict.group, null);
  assert.equal(verdict.reason, 'not-addressed');
});

test('开了观察：放行，且带 observed 标记', () => {
  const verdict = decideObserved(event('我喜欢喝手冲咖啡'), group({ observeAmbient: true }));
  assert.notEqual(verdict.group, null);
  assert.equal(verdict.group.observed, true, '只有带这个标记，桥才走观察路径');
});

test('观察不放行命令：命令是给机器人的指令，没 @ 就不算数', () => {
  const verdict = decideObserved(event('/dsh 在吗'), group({ observeAmbient: true }));
  assert.equal(verdict.group, null);
  assert.equal(verdict.reason, 'observed-command');
});

test('观察不放行自己的行：那会把它自己说的话当成群友说的', () => {
  const verdict = decideObserved(event('好的', { isSelf: true }), group({ observeAmbient: true }));
  assert.equal(verdict.group, null);
  assert.equal(verdict.reason, 'observed-self');
});

test('观察不放行空正文', () => {
  const verdict = decideObserved(event('   '), group({ observeAmbient: true }));
  assert.equal(verdict.group, null);
  assert.equal(verdict.reason, 'observed-empty');
});
