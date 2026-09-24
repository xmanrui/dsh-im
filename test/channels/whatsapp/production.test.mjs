import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createProductionController } from '../../../plugin-src/host/channels/whatsapp/production.mjs';

test('WhatsApp production has no per-bot result-file Gate', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-whatsapp-production-artifacts-'));
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
    createSession: async () => ({}),
    createConnectionSupervisor,
  };
  const ctx = {
    apiProxy: {},
    logger: () => ({ error() {}, warn() {}, info() {}, debug() {} }),
  };

  const production = await createProductionController(ctx, { dataDir }, internals);
  await controllerOptions.createRuntime({
    botId: 'whatsapp_enabled',
    config: {
      botId: 'whatsapp_enabled',
      accountJid: '16505550123@s.whatsapp.net',
    },
    authDir: '00000000-0000-4000-8000-000000000001',
  });
  await controllerOptions.createRuntime({
    botId: 'whatsapp_disabled',
    config: { botId: 'whatsapp_disabled' },
    authDir: '00000000-0000-4000-8000-000000000002',
  });

  assert.equal(Object.hasOwn(runtimes[0], 'outboundArtifactsEnabled'), false);
  assert.equal(Object.hasOwn(runtimes[1], 'outboundArtifactsEnabled'), false);
  assert.equal(runtimes[0].accessPolicy.isPrivileged(['+16505550123'], 'direct'), true,
    'production privileged matching uses the same bare-number normalization');
  assert.equal(runtimes[0].accessPolicy.isPrivileged(['not-a-jid'], 'direct'), false);
  await production.close();

  const productionWithDefault = await createProductionController(ctx, { dataDir }, internals);
  await controllerOptions.createRuntime({
    botId: 'whatsapp_default',
    config: { botId: 'whatsapp_default' },
    authDir: '00000000-0000-4000-8000-000000000003',
  });
  assert.equal(Object.hasOwn(runtimes[2], 'outboundArtifactsEnabled'), false);
  await productionWithDefault.close();
});
