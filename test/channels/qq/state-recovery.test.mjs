import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { QqConfigStore, deriveQqBotIdentity } from '../../../src/channels/qq/config-store.mjs';
import { QqController } from '../../../src/channels/qq/qq-controller.mjs';
import { qqStateError, publicQqStateError } from '../../../src/channels/qq/state-error.mjs';
import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import { createProductionController } from '../../../plugin-src/host/channels/qq/production.mjs';
import { createQqRpcHandler, QQ_ENDPOINTS } from '../../../plugin-src/host/channels/qq/rpc.mjs';
import { AccountCard } from '../../../plugin-src/client/channels/qq/index.js';
import { normalizeSnapshot } from '../../../plugin-src/client/channels/qq/api.js';

const credentials = { resolve: async () => ({ value: 'test-secret' }), set: async () => {}, unset: async () => {} };

async function productionFixture(t, count = 1) {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-qq-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configs = await new QqConfigStore(join(root, 'config.json')).load();
  for (let i = 0; i < count; i++) {
    const appId = `app-${i}`;
    const config = { ...deriveQqBotIdentity(appId), appId, ownerUserOpenid: '*', createdAt: new Date().toISOString() };
    await configs.save(config);
    await fs.mkdir(join(root, 'bots', config.botId), { recursive: true });
  }
  const started = [];
  const warnings = [];
  const production = await createProductionController({
    credentials, apiProxy: {}, logger: () => ({ warn: (...args) => warnings.push(args) }),
  }, { dataDir: root, workspace: root }, {
    HarnessClient: class { stopManagedProcess() {} },
    QrAuth: class { start() {} },
    Runtime: class {
      constructor(options) { this.options = options; }
      status = { ready: true, qqConnectionState: 'connected', harnessReachable: true };
      async start() { started.push(this.options.config.botId); }
      async stop() {}
    },
    createConnectionSupervisor: () => ({ ready: Promise.resolve(), start() { return this; }, async close() {} }),
  });
  t.after(() => production.close());
  const bots = configs.list();
  return { ...production, root, bots, started, warnings, path: id => join(root, 'bots', id, 'state.json') };
}

test('QQ production recovers a corrupt state before starting its runtime and reports through the host logger', async (t) => {
  const f = await productionFixture(t);
  const path = f.path(f.bots[0].botId);
  await fs.writeFile(path, Buffer.alloc(449));
  const status = await f.controller.initialize();
  assert.equal(status.totals.connected, 1);
  assert.deepEqual(f.started, [f.bots[0].botId]);
  assert.equal(f.warnings.length, 1);
  assert.match(JSON.stringify(f.warnings), /state-recovered/);
  const backup = (await fs.readdir(join(f.root, 'bots', f.bots[0].botId))).find(name => name.startsWith('state.json.corrupt-'));
  assert.deepEqual(await fs.readFile(join(f.root, 'bots', f.bots[0].botId, backup)), Buffer.alloc(449));
});

test('QQ production retries a failed state load without blocking other bots or caching the failed store', async (t) => {
  const f = await productionFixture(t, 2);
  const path = f.path(f.bots[0].botId);
  await fs.writeFile(path, Buffer.alloc(449));
  const original = fs.readFile;
  let reads = 0;
  const failure = t.mock.method(fs, 'readFile', async (...args) => {
    if (args[0] === path) {
      reads++;
      throw Object.assign(new Error('private-path'), { code: 'EACCES' });
    }
    return original(...args);
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const status = await f.controller.initialize();
    assert.equal(status.totals.connected, 1);
    assert.equal(status.bots[0].error.code, 'state-read-failed');
    assert.equal(status.bots[0].health.summary, status.bots[0].error.message);
    assert.equal(status.bots[1].connected, true);
  }
  assert.equal(reads, 2);
  failure.mock.restore();
  const restored = await f.controller.initialize();
  assert.equal(restored.totals.connected, 2);
  assert.equal(restored.bots[0].error, null);
  assert.deepEqual(f.started, [f.bots[1].botId, f.bots[0].botId]);
});

function failingController(code) {
  const config = { ...deriveQqBotIdentity('app'), appId: 'app', ownerUserOpenid: '*' };
  let callbacks;
  const cause = Object.assign(new Error('private-state-content'), { code: 'ENOSPC' });
  const error = code === 'network' ? cause : qqStateError(code, cause);
  const controller = new QqController({
    credentials,
    qrAuth: { start(next) { callbacks = next; queueMicrotask(() => next.onQrDisplayed('https://q.qq.com/test')); return () => {}; } },
    configStore: { list: () => [config], get: () => config, getByAppId: () => config, save: async () => {}, remove: async () => {} },
    createRuntime: async () => { throw error; }, logger: { warn() {} },
  });
  return { controller, config, error, callbacks: () => callbacks };
}

for (const code of ['state-read-failed', 'state-backup-failed', 'state-write-failed', 'network']) {
  test(`QQ preserves ${code} through initialization, binding, reconnect RPC, QR activation and settings`, async (t) => {
    const f = failingController(code);
    t.after(() => f.controller.close());
    const expectedCode = code === 'network' ? 'connection-failed' : code;
    const check = status => {
      assert.equal(status.bots[0].error.code, expectedCode);
      assert.equal(status.bots[0].health.summary, status.bots[0].error.message);
      assert.doesNotMatch(JSON.stringify(status), /private-state-content|test-secret/);
    };
    check(await f.controller.initialize());
    check(await f.controller.bindCredentials({ appId: 'app', appSecret: 'test-secret' }));
    const rpc = createQqRpcHandler(f.controller);
    const reconnect = await rpc(QQ_ENDPOINTS.reconnectBot, { botId: f.config.botId });
    assert.equal(reconnect.ok, false);
    assert.equal(reconnect.error.code, code === 'network' ? 'qq-operation-failed' : code);
    assert.doesNotMatch(JSON.stringify(reconnect), /private-state-content|test-secret/);
    check(f.controller.status());
    const attempt = await f.controller.startProvisioning();
    f.callbacks().onSuccess([{ appId: 'app', appSecret: 'test-secret', userOpenid: 'owner' }]);
    for (let i = 0; i < 50 && f.controller.registrationStatus(attempt.attemptId).status !== 'connected'; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(f.controller.registrationStatus(attempt.attemptId).status, 'connected');
    check(f.controller.status());
    const response = await rpc(QQ_ENDPOINTS.status, {});
    assert.equal(response.ok, true);
    const account = normalizeSnapshot(response.value).bots[0];
    assert.equal(account.error.code, expectedCode);
    const html = renderToStaticMarkup(React.createElement(AccountCard, { account }));
    assert.ok(html.includes(account.error.message));
  });
}

test('QQ state errors have English messages and expose only code and message', () => {
  setImHostLanguage('en');
  try {
    for (const code of ['state-read-failed', 'state-backup-failed', 'state-write-failed']) {
      const error = publicQqStateError(qqStateError(code, new Error('private')));
      assert.deepEqual(Object.keys(error), ['code', 'message']);
      assert.match(error.message, /QQ/);
      assert.doesNotMatch(error.message, /[\u4e00-\u9fff]|private/);
    }
    assert.equal(publicQqStateError(new Error('unknown')), null);
  } finally {
    setImHostLanguage('zh');
  }
});
