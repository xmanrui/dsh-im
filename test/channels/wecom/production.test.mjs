import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createProductionController } from '../../../plugin-src/host/channels/wecom/production.mjs';

test('Enterprise WeChat production has no per-bot result-file Gate', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-wecom-production-artifacts-'));
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
    constructor(options) {
      this.options = options;
      runtimes.push(options);
    }
  }
  class Controller {
    constructor(options) {
      controllerOptions = options;
    }
    async close() {}
  }
  class QrAuth {}
  const supervisor = {
    ready: Promise.resolve(),
    start() { return this; },
    async close() {},
  };

  const production = await createProductionController({
    credentials: {},
    apiProxy: {},
    logger: () => ({ error() {}, warn() {}, info() {}, debug() {} }),
  }, { dataDir }, {
    ConfigStore,
    StateStore,
    HarnessClient: Harness,
    Controller,
    Runtime,
    QrAuth,
    createConnectionSupervisor: () => supervisor,
  });

  await controllerOptions.createRuntime({
    botId: 'wecom_enabled',
    config: { botId: 'wecom_enabled', remoteBotId: 'remote-enabled' },
    secret: 'host-only',
  });
  await controllerOptions.createRuntime({
    botId: 'wecom_disabled',
    config: { botId: 'wecom_disabled', remoteBotId: 'remote-disabled' },
    secret: 'host-only',
  });

  assert.equal(Object.hasOwn(runtimes[0], 'outboundArtifactsEnabled'), false);
  assert.equal(Object.hasOwn(runtimes[1], 'outboundArtifactsEnabled'), false);
  await production.close();
});
