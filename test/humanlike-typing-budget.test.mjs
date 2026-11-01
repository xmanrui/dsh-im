import assert from 'node:assert/strict';
import test from 'node:test';

import { createWeixinApi } from '../src/channels/weixin/weixin-api.mjs';

//
// 「正在输入」是装饰，不是回复的一部分。它慢不能拖住回答，它失败不能改变群友看到的东西。
// 实测：线上日志里 sendtyping 出现过 durationMs 10056 / timeoutMs 10000 ——
// 一次卡顿让群友在模型开始生成之前就空等了 10 秒，而输入气泡根本没出现。
//
const TYPING_TIMEOUT_CEILING_MS = 3_000;

test('输入状态请求自带超时，卡住时在数秒内放弃', async () => {
  // A fetch that never settles unless its signal aborts.
  const api = createWeixinApi({
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    }),
  });
  const startedAt = Date.now();
  await assert.rejects(() => api.sendTyping({
    baseUrl: 'https://example.test', token: 't', toUserId: 'u', typingTicket: 'tk', status: 1,
  }));
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed <= TYPING_TIMEOUT_CEILING_MS, `必须在 ${TYPING_TIMEOUT_CEILING_MS}ms 内放弃，实际 ${elapsed}ms`);
});

test('输入状态失败只返回/抛出自身错误，不会挂住调用方', async () => {
  const api = createWeixinApi({ fetchImpl: async () => { throw new Error('network down'); } });
  await assert.rejects(() => api.sendTyping({
    baseUrl: 'https://example.test', token: 't', toUserId: 'u', typingTicket: 'tk', status: 1,
  }));
});
