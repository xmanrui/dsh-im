import { managementFetch } from '../../fixtures/management-rpc.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Context, Service } from '@deepseek-ai/cordis';

import { createImHostPlugin } from '../../../plugin-src/host/index.mjs';
import { installProductionChannel } from '../../../plugin-src/host/channels/shared/startup.mjs';
import { publicChannelInitializing, publicChannelStartupError } from '../../../plugin-src/host/channels/shared/startup-error.mjs';
import { getImHostLanguage, setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';

const channels = await Promise.all([
  ['feishu', 'PluginConfigStore', 'plugin-config-store'],
  ['weixin', 'WeixinConfigStore'], ['dingtalk', 'DingtalkConfigStore'],
  ['wecom', 'WecomConfigStore'], ['wecom-app', 'WecomAppConfigStore'],
  ['qq', 'QqConfigStore'], ['slack', 'SlackConfigStore'],
  ['telegram', 'TelegramConfigStore'], ['discord', 'DiscordConfigStore'],
  ['whatsapp', 'WhatsappConfigStore'],
  ['matrix', 'MatrixConfigStore', 'matrix-config-store'],
  ['email', 'EmailConfigStore'], ['office', 'OfficeConfigStore'],
].map(async ([id, storeName, storeFile = 'config-store']) => ({
  id,
  key: id === 'wecom-app' ? 'wecomApp' : id,
  apply: (await import(`../../../plugin-src/host/channels/${id}/index.mjs`)).apply,
  Store: (await import(`../../../src/channels/${id}/${storeFile}.mjs`))[storeName],
  api: await import(`../../../plugin-src/client/channels/${id}/api.js`),
})));

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-channel-startup-'));
  const ctx = new Context();
  const routes = new Map();
  const fibers = [];
  class Connection extends Service {
    constructor(context) { super(context, 'connection'); }
    get fetch() {
      const owner = this.ctx;
      return managementFetch((channel, handler, options) => {
        return owner.effect(() => {
          assert.equal(routes.has(channel), false, 'startup must not remount a route');
          routes.set(channel, { handler, options });
          return () => routes.delete(channel);
        }, 'test: management route');
      });
    }
  }
  new Connection(ctx);
  ctx.provide('credentials', { resolve: async () => undefined, set: async () => {}, unset: async () => {} });
  ctx.provide('typertGateway', { invoke: async () => ({}), stream: async function* () {} });
  ctx.provide('sessionController', {});
  ctx.provide('workspaceController', {});
  t.after(async () => {
    for (const fiber of fibers) await fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    ctx, routes, directory,
    config(id, overrides = {}) {
      return {
        dshHome: directory, workspace: directory,
        configPath: join(directory, `${id}-config.json`),
        workspacesPath: join(directory, `${id}-workspaces.json`),
        ...overrides,
        internals: {
          createConnectionSupervisor: () => ({ start() { return this; }, async close() {} }),
          ...overrides.internals,
        },
      };
    },
    start(apply, config) {
      const fiber = ctx.plugin({ inject: ['connection', 'credentials', 'typertGateway'], apply: c => apply(c, config) });
      fibers.push(fiber);
      return fiber;
    },
    call(id, endpoint = 'connection.status', payload = {}, signal) {
      return routes.get(`/${id}`).handler(endpoint, payload, signal);
    },
  };
}

for (const { id, apply, Store, api } of channels) {
  test(`${id} mounts RPC while loading and switches to its real controller without remounting`, async t => {
    const f = await fixture(t);
    const gate = Promise.withResolvers();
    const loading = Promise.withResolvers();
    class ConfigStore extends Store {
      async load() { loading.resolve(); await gate.promise; return super.load(); }
    }
    const fiber = f.start(apply, f.config(id, { internals: { ConfigStore } }));
    try {
      await loading.promise;
      const route = f.routes.get(`/${id}`);
      assert.deepEqual(route.options.methods, ['POST']);
      const lanHeaders = { host: '192.168.1.100:3080', origin: 'http://192.168.1.100:3080' };
      assert.equal((await route.handler('connection.status', {}, undefined, lanHeaders)).error.code, `${id}-initializing`);
      assert.equal((await f.call(id)).error.code, `${id}-initializing`);
      assert.equal((await f.call(id, 'bot.delete', { confirm: true })).error.code, `${id}-initializing`);
      gate.resolve();
      await fiber.await();
      assert.equal((await f.call(id)).ok, true);
      assert.equal((await route.handler('connection.status', {}, undefined, lanHeaders)).ok, true);
      assert.equal(f.routes.get(`/${id}`), route);
      // The original handler still validates payloads; do not coerce null to {}.
      assert.equal((await f.call(id, 'connection.status', null)).error.code, 'bad-request');
      await fiber.dispose();
      assert.equal(f.routes.size, 0);
      const reloaded = f.start(apply, f.config(id));
      await reloaded.await();
      assert.equal((await f.call(id)).ok, true);
      await reloaded.dispose();
      assert.equal(f.routes.size, 0);
    } finally {
      gate.resolve();
    }
  });

  for (const [label, filename, contents] of [
    ['malformed JSON', 'configPath', '{private-secret-value'],
    ['invalid configuration data', 'configPath', '{"invalid":"private-secret-value"}'],
    ...(id === 'office' ? [] : [['invalid workspace data', 'workspacesPath', '{"version":999,"private":"private-secret-value"}']]),
  ]) {
    test(`${id} preserves ${label} and exposes safe guidance in its settings client`, async t => {
      const f = await fixture(t);
      const config = f.config(id);
      await writeFile(config[filename], contents);
      const fiber = f.start(apply, config);
      await fiber.await();
      const result = await f.call(id);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, `${id}-startup-config-invalid`);
      if (id === 'weixin') {
        assert.equal(result.error.details.stage, 'startup.load');
        assert.match(result.error.details.referenceId, /^WX-CONN-[A-F0-9]{8}$/);
        assert.equal(result.error.details.file, filename === 'configPath' ? 'config.json' : 'workspaces.json');
        assert.equal(result.error.details.resource, filename === 'configPath' ? 'account-config' : 'workspace-config');
        assert.equal(result.error.details.reason, label === 'malformed JSON' ? 'invalid-json' : 'invalid-config');
        if (label !== 'malformed JSON') {
          assert.equal(result.error.details.field, 'version');
          assert.equal(result.error.details.issue, 'unsupported-version');
        }
      } else { assert.equal(result.error.details.stage, 'startup.load'); assert.match(result.error.details.referenceId, /^IM-CONN-[A-F0-9]{8}$/); assert.equal(result.error.details.operation, 'startup'); }
      assert.doesNotMatch(JSON.stringify(result), /private-secret-value/);
      assert.equal(await readFile(config[filename], 'utf8'), contents);
      assert.throws(() => (api.unwrapRpcResult ?? api.unwrapOfficeRpc)(result), error => {
        assert.equal(error.code, result.error.code);
        const message = api.presentError ? api.presentError(error).message : error.message;
        assert.match(message, id === 'weixin' && filename === 'workspacesPath' ? /workspaces\.json/ : /config\.json/);
        assert.match(message, /重启 DSH/);
        if (id === 'weixin') assert.ok(message.includes(result.error.details.file));
        else if (id === 'office') assert.doesNotMatch(message, /workspaces\.json/);
        else assert.match(message, /workspaces\.json/);
        return true;
      });
      assert.deepEqual(await f.routes.get(`/${id}`).handler('connection.status', {}, undefined, {
        host: '192.168.1.100:3080', origin: 'http://192.168.1.100:3080',
      }), result);
      assert.equal((await f.call(id, 'bot.bind-credentials', { token: 'must-not-be-saved' })).error.code, result.error.code);
      assert.equal((await f.call(id, 'connection.status', {}, AbortSignal.abort())).error.code, 'cancelled');
      await fiber.dispose();
      assert.equal(f.routes.size, 0);
    });
  }

  test(`${id} reports configuration permission errors and translates startup guidance`, async t => {
    const f = await fixture(t);
    class ConfigStore extends Store {
      async load() { throw Object.assign(new Error('/private/path/private-token'), { code: 'EACCES' }); }
    }
    const fiber = f.start(apply, f.config(id, { internals: { ConfigStore } }));
    await fiber.await();
    const result = await f.call(id);
    assert.equal(result.error.code, `${id}-startup-permission-denied`);
    assert.match(result.error.message, /权限/);
    assert.doesNotMatch(JSON.stringify(result), /private/);
    setImHostLanguage('en');
    try {
      for (const error of [new SyntaxError('private'), { code: 'EPERM' }, new Error('private')]) {
        const failure = publicChannelStartupError(id, error);
        assert.doesNotMatch(failure.message, /[一-鿿]|private|\{\w+\}/);
        assert.match(failure.message, /restart DSH/);
      }
      assert.match(publicChannelInitializing(id).message, /is initializing/);
    } finally {
      setImHostLanguage('zh');
    }
  });
}

test('the composed host serves other real channels while Feishu is loading and after it fails', async t => {
  const f = await fixture(t);
  const gate = Promise.withResolvers();
  const loaded = new Set();
  const allLoaded = Promise.withResolvers();
  const config = Object.fromEntries(channels.map(({ id, key, Store }) => {
    class ConfigStore extends Store {
      async load() {
        if (id === 'feishu') {
          await gate.promise;
          throw new SyntaxError('private-secret');
        }
        await super.load();
        loaded.add(id);
        if (loaded.size === channels.length - 1) allLoaded.resolve();
        return this;
      }
    }
    return [key, f.config(id, { internals: { ConfigStore } })];
  }));
  const internals = Object.fromEntries([
    'installUpdateRpc', 'installInboundTtlRpc', 'installDeliveryRpc', 'installDeliveryHttp',
    'installSessionSyncCoordinator', 'installHostLanguage', 'installHostLanguageRpc',
  ].map(name => [name, () => {}]));
  const fiber = f.start(createImHostPlugin(internals).apply, config);
  try {
    // Allow Cordis to enter its activation callback; Feishu stays gated.
    await new Promise(setImmediate);
    assert.equal(f.routes.size, channels.length);
    await allLoaded.promise;
    assert.equal((await f.call('feishu')).error.code, 'feishu-initializing');
    // Let the other channels finish their local workspace reconciliation.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await f.call('telegram')).ok) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal((await f.call('telegram')).ok, true);
    gate.resolve();
    await fiber.await();
    assert.equal((await f.call('feishu')).error.code, 'feishu-startup-config-invalid');
    for (const { id } of channels.filter(c => c.id !== 'feishu')) assert.equal((await f.call(id)).ok, true, id);
    await fiber.dispose();
    assert.equal(f.routes.size, 0);
  } finally {
    gate.resolve();
  }
});

test('startup rolls back prepared resources even when delivery cleanup fails', async t => {
  const f = await fixture(t);
  let closed = 0;
  let unregistered = 0;
  const fiber = f.start((ctx, config) => installProductionChannel(ctx, config, {
    channel: 'telegram', rpcChannel: '/telegram',
    createProduction: async () => ({ controller: {}, deliveryAdapter: {}, async close() { closed += 1; } }),
    createHandler() { throw new Error('private-handler-error'); },
  }), {
    deliveryService: { registerAdapter() { return () => { unregistered += 1; throw new Error('private-cleanup-error'); }; } },
  });
  await fiber.await();
  const result = await f.call('telegram');
  assert.equal(result.error.code, 'telegram-startup-failed');
  assert.doesNotMatch(JSON.stringify(result), /private/);
  assert.equal(closed, 1);
  assert.equal(unregistered, 1);
  await fiber.dispose();
  assert.equal(closed, 1);
  assert.equal(unregistered, 1);
  assert.equal(f.routes.size, 0);
});

test('an uncaught endpoint failure keeps a final Host diagnostic instead of becoming a management transport failure', async t => {
  const f = await fixture(t);
  const fiber = f.start((ctx, config) => installProductionChannel(ctx, config, {
    channel: 'telegram', rpcChannel: '/telegram',
    createProduction: async () => ({ controller: {}, async close() {} }),
    createHandler: () => async () => { throw new Error('private-endpoint-error', { cause: Object.assign(new Error('private-host'), { code: 'ENOTFOUND' }) }); },
  }), {});
  await fiber.await();
  const result = await f.call('telegram', 'bot.reconnect');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'telegram-operation-failed');
  assert.equal(result.error.details.reason, 'ENOTFOUND');
  assert.equal(result.error.details.stage, 'connection.start');
  assert.match(result.error.details.referenceId, /^IM-CONN-[A-F0-9]{8}$/);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('a host language change refreshes every started channel menu and releases on unload', async t => {
  const previousLanguage = getImHostLanguage();
  t.after(() => setImHostLanguage(previousLanguage));
  setImHostLanguage('zh');
  const f = await fixture(t);
  const refreshes = [];
  let failNext = false;
  const fiber = f.start((ctx, config) => installProductionChannel(ctx, config, {
    channel: 'telegram', rpcChannel: '/telegram',
    createProduction: async () => ({
      controller: {
        async refreshCommandMenus() {
          refreshes.push(getImHostLanguage());
          if (failNext) {
            failNext = false;
            throw new Error('private-refresh-failure');
          }
          return refreshes.length;
        },
      },
      async close() {},
    }),
    createHandler: () => async () => ({ ok: true, value: {} }),
  }), {});
  await fiber.await();
  assert.deepEqual(refreshes, [], 'connecting a channel is not itself a language change');

  setImHostLanguage('en');
  await new Promise(setImmediate);
  assert.deepEqual(refreshes, ['en']);

  // A rejected refresh is contained: the next language change still refreshes.
  failNext = true;
  setImHostLanguage('zh');
  await new Promise(setImmediate);
  setImHostLanguage('en');
  await new Promise(setImmediate);
  assert.deepEqual(refreshes, ['en', 'zh', 'en']);

  await fiber.dispose();
  setImHostLanguage('zh');
  await new Promise(setImmediate);
  assert.equal(refreshes.length, 3, 'an unloaded channel no longer observes the language');
});

test('a channel without a platform-side command menu ignores language changes', async t => {
  const previousLanguage = getImHostLanguage();
  t.after(() => setImHostLanguage(previousLanguage));
  setImHostLanguage('zh');
  const f = await fixture(t);
  const fiber = f.start((ctx, config) => installProductionChannel(ctx, config, {
    channel: 'office', rpcChannel: '/office',
    createProduction: async () => ({ controller: {}, async close() {} }),
    createHandler: () => async () => ({ ok: true, value: {} }),
  }), {});
  await fiber.await();
  setImHostLanguage('en');
  await new Promise(setImmediate);
  assert.equal((await f.call('office')).ok, true);
  await fiber.dispose();
});

test('disposing a channel during initialization closes the late controller and removes its route', async t => {
  const f = await fixture(t);
  const gate = Promise.withResolvers();
  let closed = 0;
  const fiber = f.start((ctx, config) => installProductionChannel(ctx, config, {
    channel: 'telegram', rpcChannel: '/telegram',
    createProduction: () => gate.promise,
    createHandler: () => async () => ({ ok: true, value: {} }),
  }), {});
  try {
    await new Promise(setImmediate);
    assert.equal((await f.call('telegram')).error.code, 'telegram-initializing');
    const disposing = fiber.dispose();
    gate.resolve({ controller: {}, async close() { closed += 1; } });
    await disposing;
    assert.equal(closed, 1);
    assert.equal(f.routes.size, 0);
  } finally {
    gate.resolve({ controller: {}, async close() { closed += 1; } });
  }
});
