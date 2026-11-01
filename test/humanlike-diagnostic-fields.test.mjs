import assert from 'node:assert/strict';
import test from 'node:test';

import { WeixinHarnessBridge } from '../src/channels/weixin/weixin-bridge.mjs';

//
// 宿主日志层会把 Error 对象脱敏成 {"code":"****"} —— 唯一有用的那个字段被抹掉，
// 线上 6 次「输入状态失败」因此完全无法归因。
// 这条用例钉住：这些日志以字符串形式带出 code，而不是把对象丢给日志层。
//
function bridgeWith(api) {
  const warnings = [];
  const logger = {
    info() {}, error() {},
    warn: (...args) => warnings.push(args.map(String).join(' ')),
  };
  const bridge = new WeixinHarnessBridge({
    api,
    baseUrl: 'https://x', token: 't', ownerUserId: 'actor',
    harness: { ask: async () => 'x' },
    state: {
      hasSeen: () => false, markSeen: async () => {}, sessionFor: () => null,
      setSession: async () => true, clearSession: async () => true, pendingSenders: () => [],
    },
    logger, botId: 'wx_demo',
  });
  return { bridge, warnings };
}

test('输入状态失败时，日志里带的是可归因的 code 文本，而不是被脱敏的对象', async () => {
  const { bridge, warnings } = bridgeWith({
    sendText: async () => ({}),
    getConfig: async () => ({ typingTicket: 'tk' }),
    sendTyping: async () => { throw Object.assign(new Error('nope'), { name: 'WeixinApiError', code: 'typing-rejected' }); },
  });
  // Trigger the typing path; it must swallow the failure and warn.
  await bridge.accept({
    message_id: 'q1', message_type: 1, from_user_id: 'actor', sender_name: 'actor',
    text: '在吗', context_token: 'c', item_list: [{ type: 1, text_item: { text: '在吗' } }],
  });
  const line = warnings.find((w) => w.includes('typing indicator failed'));
  assert.ok(line, '失败必须留下日志');
  assert.match(line, /typing-rejected/u, '必须带出真实 code，而不是 **** 或 [object Object]');
  assert.equal(line.includes('[object Object]'), false);
});
