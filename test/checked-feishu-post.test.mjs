import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { MultiBotDshFeishuController } from '../src/channels/feishu/multi-bot-controller.mjs';
import { FeishuRuntime } from '../src/channels/feishu/feishu-runtime.mjs';
import { createDeliveryService } from '../plugin-src/host/delivery-service.mjs';
import { createDeliveryAdapter } from '../plugin-src/host/delivery-adapter.mjs';

for (const mode of ['queued revocation', 'synchronous cancellation']) {
  test(`checked Lark post refuses ${mode} before the native SDK effect`, async () => {
    const cancellation = new AbortController();
    let nativeCalls = 0;
    let allowed = true;
    let fenceCalls = 0;
    class Client {
      constructor() {
        this.im = { v1: { message: { create: async () => {
          nativeCalls++;
          return { code: 0, data: { message_id: 'native', chat_id: 'oc_group' } };
        } } } };
      }
    }
    class Dispatcher { register() { return this; } }
    class WSClient {
      constructor(options) { this.options = options; this.state = 'idle'; }
      async start() { this.state = 'connected'; this.options.onReady(); }
      getConnectionStatus() { return { state: this.state }; }
      close() { this.state = 'closed'; }
    }
    const config = {
      id: 'bot_test', appId: 'cli_test', botOpenId: 'ou_bot', secretRef: 'test',
      domain: 'feishu', ownerOpenIds: ['*'], consumerMode: 'external-consumer',
    };
    const logger = { info() {}, warn() {}, error() {} };
    const controller = new MultiBotDshFeishuController({
      registerApp: async () => {}, verifyApp: async () => ({ openId: 'ou_bot' }),
      credentials: { resolve: async () => ({ value: 'synthetic' }) },
      configStore: { list: () => [config], getBot: () => config }, logger,
      createRuntime: async () => new FeishuRuntime({
        lark: { Domain: { Feishu: 'feishu', Lark: 'lark' }, LoggerLevel: { info: 'info' },
          Client, EventDispatcher: Dispatcher, WSClient },
        appId: config.appId, appSecret: 'synthetic', ownerOpenIds: ['*'],
        consumerMode: 'external-consumer', harness: { ensureRunning: async () => {} },
        state: {}, slashCommands: false, logger,
      }),
    });
    try {
      await controller.initialize();
      const service = createDeliveryService();
      const target = { targetId: 'group', kind: 'group', route: { chatId: 'oc_group' } };
      service.registerAdapter(createDeliveryAdapter({
        channel: 'feishu', coreController: controller,
        workspaces: { has: () => true, listDeliveryTargets: () => [target] },
        stateFor: async () => ({}),
      }));
      const fingerprint = (await service.describeBot(config.id)).account.fingerprint;
      const digest = createHash('sha256')
        .update(JSON.stringify({ kind: target.kind, route: target.route })).digest('hex');
      await assert.rejects(() => service.sendChecked(config.id, target.targetId, 'retained result', {
        expectedFingerprint: fingerprint, expectedTargetDigest: digest, receipt: true,
        signal: cancellation.signal,
        beforeSend: () => {
          fenceCalls++;
          // Revoke after Controller preflight, before the SDK's queued operation.
          if (mode === 'queued revocation' && fenceCalls === 2)
            queueMicrotask(() => { allowed = false; });
          if (mode === 'synchronous cancellation' && fenceCalls === 3)
            cancellation.abort();
          return allowed;
        },
      }), { code: mode === 'queued revocation' ? 'send-permission-denied' : 'cancelled' });
      if (mode === 'queued revocation') assert.equal(allowed, false);
      else assert.equal(cancellation.signal.aborted, true);
      assert.equal(nativeCalls, 0);
    } finally {
      await controller.close();
    }
  });
}
