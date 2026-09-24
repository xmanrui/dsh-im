import { managementFetch } from '../../fixtures/management-rpc.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Context, Service } from '@deepseek-ai/cordis';

import { createWecomHostPlugin } from '../../../plugin-src/host/channels/wecom/index.mjs';
import { WecomConfigStore } from '../../../src/channels/wecom/config-store.mjs';
import { WecomController } from '../../../src/channels/wecom/wecom-controller.mjs';
import { publicChannelStartupError } from '../../../plugin-src/host/channels/shared/startup-error.mjs';
import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import { presentError, unwrapRpcResult } from '../../../plugin-src/client/channels/wecom/api.js';

async function fixture(t, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-wecom-startup-'));
  const ctx = new Context();
  const routes = new Map();
  class Connection extends Service {
    constructor(context) { super(context, 'connection'); }
    get fetch() {
      const owner = this.ctx;
      return managementFetch((channel, handler, options) => {
        return owner.effect(() => {
          assert.equal(routes.has(channel), false, 'one route remains installed across startup');
          routes.set(channel, { handler, options });
          return () => routes.delete(channel);
        }, 'test: channel route');
      });
    }
  }
  new Connection(ctx);
  ctx.provide('credentials', { resolve: async () => undefined, set: async () => {}, unset: async () => {} });
  ctx.provide('typertGateway', { invoke: async () => ({}), stream: async function* () {} });
  const configPath = join(directory, 'config.json');
  const start = (overrides = {}) => ctx.plugin(createWecomHostPlugin({
    dshHome: directory,
    workspace: directory,
    configPath,
    workspacesPath: join(directory, 'workspaces.json'),
    ...config,
    ...overrides,
    internals: {
      createConnectionSupervisor: () => ({ start() { return this; }, async close() {} }),
      ...overrides.internals,
    },
  }));
  const call = (endpoint = 'connection.status', payload = {}, signal) => routes.get('/wecom').handler(endpoint, payload, signal);
  const fibers = [];
  t.after(async () => {
    for (const fiber of fibers) await fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return { ctx, routes, configPath, call, start(overrides) { const fiber = start(overrides); fibers.push(fiber); return fiber; } };
}

test('WeCom exposes startup status before loading configuration, then serves the controller on the same route', async (t) => {
  const f = await fixture(t, { rpcAuthority: 'trusted-host' });
  const gate = Promise.withResolvers();
  class ConfigStore extends WecomConfigStore {
    async load() { await gate.promise; return super.load(); }
  }
  const fiber = f.start({ internals: { ConfigStore } });
  t.after(() => gate.resolve());
  await new Promise(setImmediate);
  const route = f.routes.get('/wecom');
  assert.deepEqual(route.options.methods, ['POST']);
  assert.equal((await route.handler('connection.status', {}, undefined, { host: 'trusted.example' })).error.code, `wecom-initializing`);
  assert.equal((await f.call()).error.code, 'wecom-initializing');
  assert.equal((await f.call('bot.delete', { botId: 'test', confirm: true })).error.code, 'wecom-initializing');
  gate.resolve();
  await fiber.await();
  const status = await f.call();
  assert.equal(status.ok, true);
  assert.deepEqual(status.value.bots, []);
  assert.equal(f.routes.get('/wecom'), route);
  await fiber.dispose();
  assert.equal(f.routes.size, 0);
});

test('WeCom preserves malformed configuration and exposes safe failure guidance to the settings client', async (t) => {
  const f = await fixture(t);
  const contents = 'private-secret-value is not JSON';
  await writeFile(f.configPath, contents);
  const fiber = f.start();
  await fiber.await();
  const result = await f.call();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'wecom-startup-config-invalid');
  { assert.equal(result.error.details.stage, 'startup.load'); assert.match(result.error.details.referenceId, /^IM-CONN-[A-F0-9]{8}$/); assert.equal(result.error.details.operation, 'startup'); }
  assert.doesNotMatch(JSON.stringify(result), /private-secret-value/);
  assert.equal(await readFile(f.configPath, 'utf8'), contents);
  assert.throws(() => unwrapRpcResult(result), error => {
    assert.match(presentError(error).message, /config\.json.*workspaces\.json/);
    assert.match(presentError(error).message, /重启 DSH/);
    return error.code === 'wecom-startup-config-invalid';
  });
  assert.ok(f.ctx.logger.buffer.some(message => message.args[0]?.includes(result.error.details.referenceId)));
  assert.equal((await f.call('provision.begin')).error.code, 'wecom-startup-config-invalid');
  const aborted = new AbortController();
  aborted.abort();
  assert.equal((await f.call('connection.status', {}, aborted.signal)).error.code, 'cancelled');
  await fiber.dispose();
  assert.equal(f.routes.size, 0);
});

test('WeCom closes a prepared controller when delivery registration fails and keeps the error route', async (t) => {
  const f = await fixture(t);
  let closed = 0;
  class Controller extends WecomController {
    async close() { closed += 1; await super.close(); }
  }
  const fiber = f.start({
    internals: { Controller },
    deliveryService: { registerAdapter() { throw new Error('private-token should only appear in the startup log'); } },
  });
  await fiber.await();
  assert.equal(closed, 1);
  const result = await f.call();
  assert.equal(result.error.code, 'wecom-startup-failed');
  assert.doesNotMatch(JSON.stringify(result), /private-token/);
  await fiber.dispose();
  assert.equal(closed, 1);
  assert.equal(f.routes.size, 0);
});

test('WeCom startup guidance distinguishes invalid data and permissions without returning private paths', () => {
  for (const code of ['EACCES', 'EPERM']) {
    const error = Object.assign(new Error('private/path/private-secret'), { code });
    const failure = publicChannelStartupError('wecom', error);
    assert.equal(failure.code, 'wecom-startup-permission-denied');
    assert.match(failure.message, /权限/);
    assert.doesNotMatch(JSON.stringify(failure), /private/);
  }
  for (const message of ['dsh-im Enterprise WeChat config contains invalid bot data', 'dsh-im workspace config is invalid']) {
    assert.equal(publicChannelStartupError('wecom', new Error(message)).code, 'wecom-startup-config-invalid');
  }
  setImHostLanguage('en');
  try {
    assert.match(publicChannelStartupError('wecom', new SyntaxError('private-secret')).message, /configuration is invalid/);
  } finally {
    setImHostLanguage('zh');
  }
});
