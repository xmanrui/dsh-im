import assert from 'node:assert/strict';
import test from 'node:test';
import { FeishuRuntime } from '../src/channels/feishu/feishu-runtime.mjs';
import { MultiBotDshFeishuController } from '../src/channels/feishu/multi-bot-controller.mjs';
import { createDeliveryService } from '../plugin-src/host/delivery-service.mjs';

for (const action of ['close-controller', 'stop-runtime']) {
  test(`public Lark posting refuses native effects when the final consumer fence calls ${action}`, async () => {
    const bot = { id: 'bot_one', appId: 'cli_test', secretRef: 'testref', ownerOpenIds: ['ou_owner'],
      botOpenId: 'ou_verified_bot', consumerMode: 'external-consumer', domain: 'feishu', activated: 1 };
    let effects = 0;
    let stopped;
    let runtime;
    const client = { im: { v1: {
      chatModeration: { get: async () => ({ code: 0, data: { moderation_setting: 'all_members' } }) },
      message: { create: async payload => { effects++; return { code: 0,
        data: { message_id: 'om_test', chat_id: payload.data.receive_id } }; } },
    } } };
    const lark = {
      Domain: { Feishu: 'feishu-domain' }, LoggerLevel: { info: 'info' },
      Client: class { constructor() { return client; } },
      EventDispatcher: class { register() { return this; } },
      WSClient: class {
        constructor(options) { this.options = options; }
        async start() { this.options.onReady(); }
        getConnectionStatus() { return { state: 'connected' }; }
        close() {}
      },
    };
    const controller = new MultiBotDshFeishuController({
      registerApp: async () => {}, verifyApp: async () => ({ openId: 'ou_verified_bot' }),
      logger: { info() {}, warn() {}, error() {} },
      credentials: { resolve: async () => ({ value: 'test-only' }) },
      configStore: { list: () => [bot], getBot: () => bot },
      createRuntime: () => runtime = new FeishuRuntime({ ...bot, appSecret: 'test-only',
        state: { hasSeen: () => false }, harness: { ensureRunning: async () => {} }, lark }),
    });
    await controller.initialize();
    const identity = await controller.describeDeliveryAccount('bot_one');
    const service = createDeliveryService();
    service.registerAdapter({
      channel: 'feishu', ownsBot: id => id === 'bot_one', listBots: () => ['bot_one'],
      listTargets: () => [], listSuggestions: () => [], createTarget() {}, updateTarget() {},
      deleteTarget() {}, sendText() {}, describeAccount: id => controller.describeDeliveryAccount(id),
      listReachableConversations: (id, options) => controller.listReachableConversations(id, options),
      postConversationChecked: (id, conversation, text, options) => controller.postConversationChecked(id, conversation, text, options),
    });
    let fences = 0;
    let error;
    try {
      await service.postConversationChecked('bot_one', 'oc_test', 'test-only', {
        expectedFingerprint: identity.account.fingerprint,
        beforeSend: () => {
          if (++fences === 2) stopped = action === 'close-controller' ? controller.close() : runtime.stop();
          return true;
        },
      });
    } catch (caught) { error = caught; }
    await stopped;
    await controller.close();
    assert.equal(fences, 2, 'Revoke only at the final native effect boundary');
    assert.equal(effects, 0, 'A closed or stopped Provider must not create a native message');
    assert.ok(error, 'The public post must reject instead of returning acceptance');
  });
}
