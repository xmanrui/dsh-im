import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DshFeishuController,
  FEISHU_SECRET_REF,
} from '../../../src/channels/feishu/plugin-controller.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture({ initialConfig = null, failConfigSave = false } = {}) {
  let sdkOptions;
  let config = initialConfig;
  let storedSecret = null;
  const runtimes = [];
  const controller = new DshFeishuController({
    registerApp: (options) => {
      sdkOptions = options;
      return new Promise((resolve) => { fixture.resolveRegistration = resolve; });
    },
    verifyApp: async () => ({ name: '北汇星河助手', openId: 'ou_bot', activated: 1 }),
    credentials: {
      async resolve(ref) {
        assert.equal(ref, FEISHU_SECRET_REF);
        return storedSecret ? { value: storedSecret, source: 'file' } : undefined;
      },
      async set(ref, value) {
        assert.equal(ref, FEISHU_SECRET_REF);
        storedSecret = value;
      },
      async unset(ref) {
        assert.equal(ref, FEISHU_SECRET_REF);
        storedSecret = null;
      },
    },
    configStore: {
      get: () => config ? structuredClone(config) : null,
      async save(next) {
        if (failConfigSave) throw new Error('config write failed');
        config = structuredClone(next);
        return structuredClone(config);
      },
      async clear() { config = null; },
    },
    createRuntime: async () => {
      const status = {
        ready: false,
        feishuLongConnectionState: 'idle',
        harnessReachable: false,
      };
      const runtime = {
        get status() { return structuredClone(status); },
        async start() {
          status.ready = true;
          status.feishuLongConnectionState = 'connected';
          status.harnessReachable = true;
        },
        async stop() {
          status.ready = false;
          status.feishuLongConnectionState = 'idle';
        },
      };
      runtimes.push(runtime);
      return runtime;
    },
  });
  return {
    controller,
    getSdkOptions: () => sdkOptions,
    getConfig: () => config,
    getSecret: () => storedSecret,
    runtimes,
  };
}

test('QR success stores the secret off-config and becomes immediately chat-ready', async () => {
  const fx = fixture();
  const start = fx.controller.startRegistration();
  assert.equal(start.phase, 'registering');
  await flush();
  assert.equal(fx.getSdkOptions().createOnly, true);
  assert.equal(fx.getSdkOptions().addons.preset, false);
  assert.deepEqual(fx.getSdkOptions().addons.events.items.tenant, ['im.message.receive_v1', 'card.action.trigger']);
  assert.ok(fx.getSdkOptions().addons.scopes.tenant.includes('im:message.p2p_msg:readonly'));
  assert.ok(fx.getSdkOptions().addons.scopes.tenant.includes('im:message:readonly'));
  assert.ok(fx.getSdkOptions().addons.scopes.tenant.includes('im:message:send_as_bot'));
  assert.ok(fx.getSdkOptions().addons.scopes.tenant.includes('cardkit:card:write'));
  fx.getSdkOptions().onQRCodeReady({ url: 'https://accounts.feishu.cn/qr', expireIn: 600 });
  fixture.resolveRegistration({
    client_id: 'cli_created',
    client_secret: 'new-secret',
    user_info: { open_id: 'ou_owner', tenant_brand: 'feishu' },
  });
  await flush();
  await flush();
  await flush();

  const status = fx.controller.status();
  assert.equal(status.phase, 'connected');
  assert.equal(status.connected, true);
  assert.equal(status.bot.name, '北汇星河助手');
  assert.equal(fx.getSecret(), 'new-secret');
  assert.equal(fx.getConfig().appSecret, undefined);
  assert.doesNotMatch(JSON.stringify(status), /new-secret|client_secret/);
});

test('disconnect removes configuration and stops automatic reuse', async () => {
  const fx = fixture();
  fx.controller.startRegistration();
  await flush();
  fixture.resolveRegistration({
    client_id: 'cli_created',
    client_secret: 'new-secret',
    user_info: { open_id: 'ou_owner', tenant_brand: 'feishu' },
  });
  await flush();
  await flush();
  await flush();
  await fx.controller.disconnect();

  assert.equal(fx.controller.status().phase, 'unconfigured');
  assert.equal(fx.getConfig(), null);
  assert.equal(fx.getSecret(), null);
});

test('credential is removed when non-secret configuration cannot be persisted', async () => {
  const fx = fixture({ failConfigSave: true });
  fx.controller.startRegistration();
  await flush();
  fixture.resolveRegistration({
    client_id: 'cli_created',
    client_secret: 'new-secret',
    user_info: { open_id: 'ou_owner', tenant_brand: 'feishu' },
  });
  await flush();
  await flush();

  assert.equal(fx.getSecret(), null);
  assert.equal(fx.getConfig(), null);
  assert.equal(fx.controller.status().phase, 'error');
});
