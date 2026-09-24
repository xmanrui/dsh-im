import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FEISHU_GROUP_MESSAGE_SCOPE,
  GroupMessagePermissionManager,
  assertGroupMessagePermissionUrl,
} from '../../../src/channels/feishu/group-message-permission-manager.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await flush();
  }
}

test('GroupMessagePermissionManager updates one real app with only im:message.group_msg', async () => {
  let observed;
  let resolveRegistration;
  const accepted = [];
  const manager = new GroupMessagePermissionManager({
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
    scopes: { tenant: [FEISHU_GROUP_MESSAGE_SCOPE] },
  });
  assert.equal(Object.hasOwn(observed.addons, 'events'), false);
  assert.equal(Object.hasOwn(observed.addons, 'callbacks'), false);

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
  assert.doesNotMatch(JSON.stringify(manager.status()), /private-secret/);
});

test('group-message permission URLs stay on the exact official SDK launcher', () => {
  assert.equal(
    assertGroupMessagePermissionUrl(
      'https://open.larksuite.com/page/launcher?tp=sdk&clientID=cli_real_app&addons=x',
      'cli_real_app',
      'lark',
    ),
    'https://open.larksuite.com/page/launcher?tp=sdk&clientID=cli_real_app&addons=x',
  );
  for (const unsafe of [
    'http://open.feishu.cn/page/launcher?tp=sdk&clientID=cli_real_app&addons=x',
    'https://open.larksuite.com/page/launcher?tp=sdk&clientID=cli_real_app&addons=x',
    'https://open.feishu.cn/page/launcher?tp=sdk&clientID=other_app&addons=x',
    'https://open.feishu.cn/page/launcher?tp=sdk&clientID=cli_real_app&addons=x&createOnly=true',
    'https://open.feishu.cn/page/launcher?tp=sdk&clientID=cli_real_app',
  ]) {
    assert.throws(
      () => assertGroupMessagePermissionUrl(unsafe, 'cli_real_app'),
      /unsafe verification URL/,
      unsafe,
    );
  }
});
