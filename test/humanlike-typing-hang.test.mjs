import assert from 'node:assert/strict';
import test from 'node:test';

import { WeixinHarnessBridge } from '../src/channels/weixin/weixin-bridge.mjs';

//
// 「正在输入」是装饰，不能变成回复的代价。线上实测：`sendtyping` 出现过
// durationMs 10056 / timeoutMs 10000，而它当时被 await 在生成之前 ——
// 一次卡顿等于群友空等 10 秒，且输入气泡根本没出现。
// 这条用例把 sendTyping 做成永不返回：回答仍必须在秒级内发出去。
//
const LOGGER = { info() {}, warn() {}, error() {} };

function bridgeWithHungTyping() {
  const sent = [];
  let askedAt = 0;
  const bridge = new WeixinHarnessBridge({
    api: {
      sendText: async ({ text }) => { sent.push(text); return {}; },
      getConfig: async () => ({ typingTicket: 'tk' }),
      // Ignores its abort signal entirely: the worst case a provider can produce.
      sendTyping: async () => new Promise(() => {}),
    },
    baseUrl: 'https://x', token: 't', ownerUserId: 'actor',
    harness: {
      currentBusyMessageMode: () => 'queue', ensureRunning: async () => {}, createSession: async () => 's',
      renameSession: async (i, title) => ({ title, seq: 0 }), sessionExists: async () => true,
      hasActiveTurn: async () => false, isSessionRunning: async () => false, currentWorkspace: () => null,
      ask: async () => { askedAt = Date.now(); return '在'; },
    },
    state: {
      hasSeen: () => false, markSeen: async () => {}, sessionFor: () => null,
      setSession: async () => true, clearSession: async () => true, pendingSenders: () => [],
      rememberContextToken: async () => {}, rememberOutboundMessage: async () => {},
    },
    logger: LOGGER, botId: 'wx_demo',
  });
  return { bridge, sent, getAskedAt: () => askedAt };
}

test('输入状态卡死时，回答仍然在秒级内发出', async () => {
  const { bridge, sent, getAskedAt } = bridgeWithHungTyping();
  const event = { message_id: 'q1', message_type: 1, from_user_id: 'actor', sender_name: 'actor',
    text: '在吗', context_token: 'c', item_list: [{ type: 1, text_item: { text: '在吗' } }] };
  const startedAt = Date.now();
  await bridge.accept(event);
  const latency = Date.now() - startedAt;
  // 旧实现：await 在生成之前 + 队列无界 ⇒ 这条 accept 永不返回。
  assert.ok(getAskedAt() - startedAt < 1_000, '模型必须几乎立刻开始生成');
  assert.ok(latency < 3_000, `回答必须在秒级发出，实际 ${latency}ms`);
  assert.deepEqual(sent, ['在']);
});
