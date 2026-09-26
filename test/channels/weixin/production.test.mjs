import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

import { createProductionController } from '../../../plugin-src/host/channels/weixin/production.mjs';
import { createWeixinRpcHandler } from '../../../plugin-src/host/channels/weixin/rpc.mjs';
import { deriveWeixinBotIdentity, WeixinConfigStore } from '../../../src/channels/weixin/config-store.mjs';
import { WeixinStateStore } from '../../../src/channels/weixin/state-store.mjs';

test('production CDN uploads isolate the global dispatcher, honour proxy bypass, and release their pool', async t => {
  for (const scenario of [
    { name: 'proxy', bypass: false },
    { name: 'NO_PROXY', bypass: true },
    { name: 'controller close failure', bypass: true, failure: 'controller' },
    { name: 'supervisor close failure', bypass: true, failure: 'supervisor' },
  ]) await t.test(scenario.name, async st => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dsh-weixin-upload-'));
    st.after(() => rm(dataDir, { recursive: true, force: true }));
    const uploads = [];
    const cdn = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      uploads.push({ headers: request.headers, bytes: Buffer.concat(chunks) });
      response.writeHead(200, { 'x-encrypted-param': 'private-download', 'content-length': '0' });
      response.end();
    });
    let tunnels = 0;
    const sockets = new Set();
    const proxy = createServer();
    proxy.on('connect', (request, socket, head) => {
      tunnels += 1;
      const upstream = connect(cdn.address().port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      for (const connection of [socket, upstream]) {
        sockets.add(connection);
        connection.on('close', () => sockets.delete(connection));
        connection.on('error', () => { socket.destroy(); upstream.destroy(); });
      }
    });
    for (const server of [cdn, proxy]) {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      st.after(() => new Promise(resolve => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(resolve);
      }));
    }
    const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
    const env = { http_proxy: proxyUrl, https_proxy: proxyUrl,
      no_proxy: scenario.bypass ? '127.0.0.1' : '' };
    for (const [name, value] of Object.entries(env)) {
      for (const key of [name, name.toUpperCase()]) {
        const previous = process.env[key];
        process.env[key] = value;
        st.after(() => {
          if (previous === undefined) delete process.env[key];
          else process.env[key] = previous;
        });
      }
    }
    const previousDispatcher = getGlobalDispatcher();
    setGlobalDispatcher({ dispatch() { throw new Error('CDN must not use the global dispatcher'); } });
    st.after(() => setGlobalDispatcher(previousDispatcher));
    const dispatchers = new Set();
    const dispatch = EnvHttpProxyAgent.prototype.dispatch;
    st.mock.method(EnvHttpProxyAgent.prototype, 'dispatch', function (options, handler) {
      dispatchers.add(this);
      // Redirect only the test socket destination, after the production CDN URL validation.
      return dispatch.call(this, { ...options, origin: `http://127.0.0.1:${cdn.address().port}` }, handler);
    });
    const destroy = EnvHttpProxyAgent.prototype.destroy;
    let destroyed = 0;
    st.mock.method(EnvHttpProxyAgent.prototype, 'destroy', function (...args) {
      // Undici's promise overload re-enters destroy with a callback.
      if (args.length === 0) destroyed += 1;
      return destroy.apply(this, args);
    });
    const jsonCalls = [];
    st.mock.method(globalThis, 'fetch', async (url) => {
      assert.equal(url.hostname, 'ilinkai.weixin.qq.com');
      jsonCalls.push(url.pathname);
      return new Response(JSON.stringify(url.pathname.endsWith('/getuploadurl')
        ? { ret: 0, upload_param: 'test-upload' } : { ret: 0 }));
    });
    let api;
    let harnessStopped = 0;
    const closeError = new Error('close failed');
    class ConfigStore { async load() { return this; } list() { return []; } }
    class Harness { stopManagedProcess() { harnessStopped += 1; } }
    class Controller {
      constructor(options) { api = options.api; }
      async close() { if (scenario.failure === 'controller') throw closeError; }
    }
    const production = await createProductionController({ credentials: {}, apiProxy: {} }, { dataDir }, {
      ConfigStore, HarnessClient: Harness, Controller,
      createConnectionSupervisor: () => ({ ready: Promise.resolve(), start() { return this; },
        async close() { if (scenario.failure === 'supervisor') throw closeError; },
      }),
    });
    st.after(() => production.close().catch(() => {}));
    assert.equal(dispatchers.size, 0);
    for (const operation of ['sendImage', 'sendFile']) await api[operation]({
      baseUrl: 'https://ilinkai.weixin.qq.com', token: 'test-token', toUserId: 'test-user',
      file: { fileName: 'test.png', mediaType: 'image/png', bytes: Buffer.alloc(70_000, 1) },
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(uploads.length, 2);
    for (const upload of uploads) {
      assert.equal(Number(upload.headers['content-length']), upload.bytes.length);
      assert.equal(upload.headers.authorization, undefined);
    }
    assert.equal(jsonCalls.length, 4);
    assert.equal(dispatchers.size, 1, 'reuse the pool across image and file uploads');
    assert.equal(tunnels > 0, !scenario.bypass);
    if (scenario.failure) await assert.rejects(production.close(), error => error === closeError);
    else await production.close();
    assert.equal(destroyed, 1);
    assert.equal(harnessStopped, 1);
    await production.close().catch(() => {});
    assert.equal(destroyed, 1, 'closing twice must not destroy the pool again');
  });
});

test('Weixin production has no per-bot result-file Gate', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-weixin-production-artifacts-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const runtimes = [];
  let controllerOptions;

  class ConfigStore {
    async load() { return this; }
    list() { return []; }
  }
  class StateStore {
    async load() { return this; }
  }
  class Harness {
    stopManagedProcess() {}
  }
  class Runtime {
    constructor(options) { runtimes.push(options); }
  }
  class Controller {
    constructor(options) { controllerOptions = options; }
    async close() {}
  }
  const createConnectionSupervisor = () => ({
    ready: Promise.resolve(),
    start() { return this; },
    async close() {},
  });
  const internals = {
    ConfigStore,
    StateStore,
    HarnessClient: Harness,
    Controller,
    Runtime,
    api: {},
    createConnectionSupervisor,
  };
  const ctx = {
    credentials: {},
    apiProxy: {},
    logger: () => ({ error() {}, warn() {}, info() {}, debug() {} }),
  };

  const production = await createProductionController(ctx, { dataDir }, internals);
  await controllerOptions.createRuntime({
    botId: 'wx_enabled',
    config: { botId: 'wx_enabled' },
    token: 'host-only',
  });
  await controllerOptions.createRuntime({
    botId: 'wx_disabled',
    config: { botId: 'wx_disabled' },
    token: 'host-only',
  });

  assert.equal(Object.hasOwn(runtimes[0], 'outboundArtifactsEnabled'), false);
  assert.equal(Object.hasOwn(runtimes[1], 'outboundArtifactsEnabled'), false);
  assert.equal(runtimes[0].maxMessageChars, 1_800);
  assert.equal(runtimes[1].maxMessageChars, 1_800);
  await production.close();

  const productionWithDefault = await createProductionController(ctx, { dataDir }, internals);
  await controllerOptions.createRuntime({
    botId: 'wx_default',
    config: { botId: 'wx_default' },
    token: 'host-only',
  });
  assert.equal(Object.hasOwn(runtimes[2], 'outboundArtifactsEnabled'), false);
  assert.equal(runtimes[2].maxMessageChars, 1_800);
  await productionWithDefault.close();
});

test('production preserves workspace/session isolation and reports a committed cleanup failure', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-weixin-diagnostics-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const configPath = join(dataDir, 'config.json');
  const workspacesPath = join(dataDir, 'workspaces.json');
  const nextWorkspace = join(dataDir, 'next');
  await mkdir(nextWorkspace);
  const configs = await new WeixinConfigStore(configPath).load();
  const bots = ['first', 'second'].map(accountId => ({
    ...deriveWeixinBotIdentity(accountId), accountId, ownerUserId: 'test-owner', baseUrl: 'https://ilinkai.weixin.qq.com/',
  }));
  for (const bot of bots) await configs.save(bot);
  const credentials = new Map(bots.map(bot => [bot.tokenRef, 'test-login']));
  const logs = [];
  class Harness { ensureRunning = async () => {}; stopManagedProcess() {} }
  class Runtime {
    status = { ready: false, weixinConnectionState: 'idle' };
    async start() { this.status = { ready: true, weixinConnectionState: 'connected', harnessReachable: true }; }
    async stop() { this.status = { ready: false, weixinConnectionState: 'idle' }; }
  }
  const ctx = { apiProxy: {}, credentials: {
    resolve: async ref => credentials.has(ref) ? { value: credentials.get(ref) } : undefined,
    set: async (ref, value) => credentials.set(ref, value), unset: async ref => credentials.delete(ref),
  }, logger: { error: text => logs.push(text), warn: text => logs.push(text), info: text => logs.push(text) } };
  const internals = { HarnessClient: Harness, Runtime, api: { beginLogin() {}, pollLogin() {} },
    createConnectionSupervisor: () => ({ ready: Promise.resolve(), start() { return this; }, async close() {} }),
  };
  let production = await createProductionController(ctx, { dataDir }, internals);
  t.after(() => production.close());
  await production.controller.initialize();
  const handler = () => createWeixinRpcHandler(production.controller, { logger: ctx.logger });
  const before = await production.controller.status();
  const switched = await handler()('bot.workspace.set', { botId: bots[0].botId, workspace: nextWorkspace });
  assert.equal(switched.ok, true);
  assert.equal(switched.value.bots[0].workspace, nextWorkspace);
  assert.equal(switched.value.bots[1].workspace, before.bots[1].workspace);
  assert.equal(credentials.size, 2);
  assert.equal(switched.value.totals.connected, 2);
  await production.close();
  production = await createProductionController(ctx, { dataDir }, internals);
  await production.controller.initialize();
  assert.equal((await production.controller.status()).bots[0].workspace, nextWorkspace);
  assert.equal((await production.controller.status()).totals.connected, 2);
  const state = await new WeixinStateStore(join(dataDir, 'accounts', bots[1].botId, 'state.json')).load();
  await state.setSession('test-conversation', 'second-session');
  const secondStateBefore = await readFile(join(dataDir, 'accounts', bots[1].botId, 'state.json'), 'utf8');

  // A directory in place of the workspace document makes rename fail on every OS.
  await rm(workspacesPath);
  await mkdir(workspacesPath);
  const failedSave = await handler()('bot.workspace.set', { botId: bots[0].botId, workspace: dataDir });
  assert.equal(failedSave.error.code, 'workspace-save-failed');
  assert.equal(failedSave.error.details.resource, 'workspace-config');
  assert.equal((await production.controller.status()).bots[0].workspace, nextWorkspace);
  const removed = await handler()('bot.delete', { botId: bots[0].botId, confirm: true });
  assert.equal(removed.ok, true);
  assert.equal(removed.value.warnings[0].code, 'workspace-cleanup-failed');
  assert.equal(removed.value.bots.length, 1);
  assert.equal(removed.value.bots[0].botId, bots[1].botId);
  assert.equal(removed.value.bots[0].connected, true);
  assert.equal(credentials.size, 1);
  assert.equal((await new WeixinConfigStore(configPath).load()).get(bots[0].botId), null);
  assert.equal(await readFile(join(dataDir, 'accounts', bots[1].botId, 'state.json'), 'utf8'), secondStateBefore);
  assert.doesNotMatch(JSON.stringify([removed, failedSave, logs]), /test-login|test-owner|second-session/);
});
