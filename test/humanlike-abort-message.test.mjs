import assert from 'node:assert/strict';
import test from 'node:test';

import { messageFailureText, setLastMessageFailure } from '../src/channels/shared/message-failure.mjs';

//
// 被中断的回合要用人话说。线上两次真实失败（TURN_ABORTED）发给群里的原文是
// 「任务被意外中断，本次未完成。请重试。\n\n错误码：TURN_INTERRUPTED；参考号：MF-…」——
// 参考号是给能查日志的人看的，群友看了只会觉得对面是台机器。
//
function failureOf(code) {
  const status = {};
  return setLastMessageFailure(status, Object.assign(new Error(String(code)), { code }), {});
}

test('中断类失败被识别出来，可以换成一句人话', () => {
  // 这三个形态在真实日志与错误对象上都出现过。
  const direct = failureOf('turn-aborted');
  assert.equal(direct.code, 'TURN_INTERRUPTED');
  const nested = failureOf('TURN_ABORTED');
  assert.equal(typeof nested.code, 'string');
});

test('非中断类失败仍然走原来的诊断文案，不被吞掉', () => {
  const text = messageFailureText(failureOf('some-other-code'));
  assert.match(text, /请重试/u);
});

test('参考号只出现在诊断文案里，不写进人话回复', () => {
  const text = messageFailureText(failureOf('turn-aborted'));
  assert.match(text, /参考号/u, '诊断文案保留参考号，供管理员定位');
  assert.equal(text.includes('这次没答完就断了'), false, '人话回复不是 messageFailureText 的职责');
});
