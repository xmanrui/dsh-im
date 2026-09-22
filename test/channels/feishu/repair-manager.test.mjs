import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CallbackRepairManager,
  FEISHU_MESSAGE_READ_SCOPE,
  FEISHU_RESOURCE_SCOPE,
  assertCallbackRepairUrl,
} from '../../../src/channels/feishu/repair-manager.mjs';
import { SLASH_COMMAND_TENANT_SCOPES } from '../../../src/channels/feishu/slash-command-registry.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await flush();
  }
}

test('CallbackRepairManager targets one real app with only the callback and required scopes', async () => {
  let observed;
  let resolveRegistration;
  const accepted = [];
  const manager = new CallbackRepairManager({
    appId: 'cli_real_app',
    domain: 'feishu',
    registerApp(options) {
      observed = options;
      return new Promise((resolve) => { resolveRegistration = resolve; });
    },
    onCredentials: async (result) => { accepted.push(result); },
  });

  manager.start();
  await waitFor(() => observed !== undefined);
  assert.equal(observed.appId, 'cli_real_app');
  assert.equal(observed.domain, 'accounts.feishu.cn');
  assert.equal(Object.hasOwn(observed, 'createOnly'), false);
  assert.equal(Object.hasOwn(observed, 'appPreset'), false);
  assert.deepEqual(observed.addons, {
    preset: false,
    scopes: {
      tenant: [
        FEISHU_MESSAGE_READ_SCOPE,
        FEISHU_RESOURCE_SCOPE,
        'im:message.group_at_msg.include_bot:readonly',
        ...SLASH_COMMAND_TENANT_SCOPES,
      ],
    },
    callbacks: { items: ['card.action.trigger'] },
  });
  assert.equal(Object.hasOwn(observed.addons, 'events'), false);

  observed.onQRCodeReady({
    url: 'https://open.feishu.cn/page/launcher?tp=sdk&clientID=cli_real_app&addons=encoded',
    expireIn: 60,
  });
  assert.equal(manager.status().state, 'qr_ready');
  resolveRegistration({
    client_id: 'cli_real_app',
    client_secret: 'private-secret',
    user_info: { open_id: 'ou_owner', tenant_brand: 'feishu' },
  });
  await waitFor(() => manager.status().state === 'succeeded');
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].client_id, 'cli_real_app');
  assert.doesNotMatch(JSON.stringify(manager.status()), /private-secret/);
});

test('CallbackRepairManager uses the Lark accounts domain', async () => {
  let observed;
  const manager = new CallbackRepairManager({
    appId: 'cli_lark_app',
    domain: 'lark',
    registerApp(options) {
      observed = options;
      return new Promise(() => {});
    },
    onCredentials: async () => {},
  });
  manager.start();
  await waitFor(() => observed !== undefined);
  assert.equal(observed.domain, 'accounts.larksuite.com');
  manager.cancel();
});

test('callback repair accepts only the exact SDK URL origin and singleton repair params', () => {
  assert.equal(
    assertCallbackRepairUrl(
      'https://open.larksuite.com/page/launcher?tp=sdk&clientID=cli_real_app&addons=x',
      'cli_real_app',
      'lark',
    ),
    'https://open.larksuite.com/page/launcher?tp=sdk&clientID=cli_real_app&addons=x',
  );
  assert.throws(
    () => assertCallbackRepairUrl(
      'https://open.feishu.cn/page/launcher?tp=sdk&clientID=%7B%7Bclient_id%7D%7D&addons=x',
      'cli_real_app',
    ),
    /unsafe verification URL/,
  );
  assert.throws(
    () => assertCallbackRepairUrl(
      'https://open.feishu.cn/page/launcher?tp=sdk&clientID=cli_real_app&addons=x&createOnly=true',
      'cli_real_app',
    ),
    /unsafe verification URL/,
  );
  assert.throws(
    () => assertCallbackRepairUrl(
      'https://open.feishu.cn/page/launcher?tp=sdk&clientID=cli_real_app',
      'cli_real_app',
    ),
    /unsafe verification URL/,
  );
  for (const unsafe of [
    'http://open.feishu.cn/page/launcher?tp=sdk&clientID=cli_real_app&addons=x',
    'https://open.larksuite.com/page/launcher?tp=sdk&clientID=cli_real_app&addons=x',
    'https://open.feishu.cn:4430/page/launcher?tp=sdk&clientID=cli_real_app&addons=x',
    'https://user@open.feishu.cn/page/launcher?tp=sdk&clientID=cli_real_app&addons=x',
    'https://open.feishu.cn/page/launcher?clientID=cli_real_app&addons=x',
    'https://open.feishu.cn/page/launcher?tp=web&clientID=cli_real_app&addons=x',
    'https://open.feishu.cn/page/launcher?tp=sdk&tp=sdk&clientID=cli_real_app&addons=x',
    'https://open.feishu.cn/page/launcher?tp=sdk&clientID=cli_real_app&clientID=cli_real_app&addons=x',
    'https://open.feishu.cn/page/launcher?tp=sdk&clientID=cli_real_app&addons=x&addons=y',
    'https://open.feishu.cn/page/launcher?tp=sdk&clientID=cli_real_app&addons=%7B%7Baddons%7D%7D',
  ]) {
    assert.throws(
      () => assertCallbackRepairUrl(unsafe, 'cli_real_app'),
      /unsafe verification URL/,
      unsafe,
    );
  }
});

test('an unsafe SDK URL becomes a safe terminal registration error', async () => {
  const manager = new CallbackRepairManager({
    appId: 'cli_real_app',
    registerApp(options) {
      options.onQRCodeReady({
        url: 'https://open.feishu.cn/page/launcher?tp=sdk&clientID=%7B%7Bclient_id%7D%7D&addons=x',
        expireIn: 60,
      });
      return new Promise(() => {});
    },
    onCredentials: async () => {},
  });
  manager.start();
  await waitFor(() => manager.status().state === 'error');
  assert.equal(manager.status().error.details.stage, 'qr.begin');
  assert.match(manager.status().error.details.referenceId, /^IM-CONN-[A-F0-9]{8}$/);
  const { details, ...legacyError } = manager.status().error;
  assert.deepEqual(legacyError, {
    code: 'registration_failed',
    message: 'Unable to register the Feishu app.',
  });
});
