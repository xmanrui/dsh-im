import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createTokenProductionController } from '../../../plugin-src/host/channels/shared/production.mjs';

test('token-channel production has no per-bot result-file Gate', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-token-production-artifacts-'));
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
  const supervisor = {
    ready: Promise.resolve(),
    start() { return this; },
    async close() {},
  };

  const production = await createTokenProductionController({
    credentials: {},
    apiProxy: {},
    logger: () => ({ error() {}, warn() {}, info() {}, debug() {} }),
  }, { dataDir }, {
    ConfigStore,
    StateStore,
    HarnessClient: Harness,
    Controller,
    Runtime,
    createConnectionSupervisor: () => supervisor,
  }, {
    channel: 'test-token',
    ConfigStore,
    StateStore,
    HarnessClient: Harness,
    Controller,
    Runtime,
  });

  await controllerOptions.createRuntime({
    botId: 'bot_enabled',
    config: { botId: 'bot_enabled' },
    token: 'host-only',
  });
  await controllerOptions.createRuntime({
    botId: 'bot_disabled',
    config: { botId: 'bot_disabled' },
    token: 'host-only',
  });

  assert.equal(Object.hasOwn(runtimes[0], 'outboundArtifactsEnabled'), false);
  assert.equal(Object.hasOwn(runtimes[1], 'outboundArtifactsEnabled'), false);
  await production.close();
});
