import assert from 'node:assert/strict';
import test from 'node:test';
import { FeishuRuntime } from '../src/channels/feishu/feishu-runtime.mjs';
import { createDeliveryService } from '../plugin-src/host/delivery-service.mjs';

test('public Lark posting checks the verified Bot in paginated native moderator lists and rejects revoked membership', async t => {
  let permitted = true;
  const sends = [];
  const fingerprint = 'a'.repeat(64);
  const client = { im: { v1: {
    chat: { list: async () => ({ code: 0, data: { items: [{ chat_id: 'oc_restricted', name: 'Restricted group' }], has_more: false } }) },
    chatModeration: { get: async ({ params }) => ({ code: 0, data: { moderation_setting: 'moderator_list',
      items: params.page_token ? [{ user_id_type: 'open_id', user_id: permitted ? 'ou_verified_bot' : 'ou_other' }]
        : [{ user_id_type: 'open_id', user_id: 'ou_first' }],
      has_more: !params.page_token, ...(!params.page_token ? { page_token: 'next' } : {}),
    } }) },
    message: { create: async payload => { sends.push(payload); return { code: 0,
      data: { message_id: 'om_restricted', chat_id: payload.data.receive_id } }; } },
  } } };
  const runtime = new FeishuRuntime({ appId: 'cli_test', appSecret: 'test-only', botOpenId: 'ou_verified_bot',
    ownerOpenIds: ['ou_owner'], consumerMode: 'external-consumer', state: { hasSeen: () => false },
    harness: { ensureRunning: async () => {} }, lark: {
      Domain: { Feishu: 'feishu-domain' }, LoggerLevel: { info: 'info' },
      Client: class { constructor() { return client; } }, EventDispatcher: class { register() { return this; } },
      WSClient: class { constructor(options) { this.options = options; } async start() { this.options.onReady(); }
        getConnectionStatus() { return { state: 'connected' }; } close() {} },
    },
  });
  t.after(() => runtime.stop());
  await runtime.start();
  const service = createDeliveryService();
  service.registerAdapter({ channel: 'feishu', ownsBot: id => id === 'bot_one', listBots: () => ['bot_one'],
    listTargets: () => [], listSuggestions: () => [], createTarget: () => assert.fail('No saved target'),
    updateTarget: () => assert.fail('No saved target'), deleteTarget: () => assert.fail('No saved target'),
    sendText: () => assert.fail('No saved target'),
    describeAccount: async () => ({ version: 1, connected: true, account: { fingerprint }, capabilities: ['reachable-conversations-checked'] }),
    listReachableConversations: (_id, options) => runtime.listReachableConversations(options),
    postConversationChecked: (_id, id, text, options) => runtime.postConversationChecked(id, text, options),
  });
  const options = { expectedFingerprint: fingerprint, beforeSend: () => true };
  assert.deepEqual((await service.listReachableConversations('bot_one', options)).conversations,
    [{ id: 'oc_restricted', kind: 'group', name: 'Restricted group' }]);
  permitted = false;
  await assert.rejects(service.postConversationChecked('bot_one', 'oc_restricted', 'Revoked', options), { code: 'send-permission-denied' });
  assert.equal(sends.length, 0);
  permitted = true;
  assert.deepEqual(await service.postConversationChecked('bot_one', 'oc_restricted', 'Allowed', options), {
    sent: true, receipt: { version: 1, messageId: 'om_restricted', conversationId: 'oc_restricted' },
  });
  assert.equal(sends.length, 1);
});
