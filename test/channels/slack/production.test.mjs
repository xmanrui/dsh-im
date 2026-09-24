import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createProductionController } from '../../../plugin-src/host/channels/slack/production.mjs';

test('Slack production has no per-bot result-file Gate', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-slack-production-artifacts-'));
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
    createConnectionSupervisor,
  };
  const ctx = {
    credentials: {},
    apiProxy: {},
    logger: () => ({ error() {}, warn() {}, info() {}, debug() {} }),
  };

  const production = await createProductionController(ctx, { dataDir }, internals);
  await controllerOptions.createRuntime({
    botId: 'slack_enabled',
    config: { botId: 'slack_enabled' },
    botToken: 'host-only-bot-token',
    appToken: 'host-only-app-token',
  });
  await controllerOptions.createRuntime({
    botId: 'slack_disabled',
    config: { botId: 'slack_disabled' },
    botToken: 'host-only-bot-token',
    appToken: 'host-only-app-token',
  });

  assert.equal(Object.hasOwn(runtimes[0], 'outboundArtifactsEnabled'), false);
  assert.equal(Object.hasOwn(runtimes[1], 'outboundArtifactsEnabled'), false);
  await production.close();

  const productionWithDefault = await createProductionController(ctx, { dataDir }, internals);
  await controllerOptions.createRuntime({
    botId: 'slack_default',
    config: { botId: 'slack_default' },
    botToken: 'host-only-bot-token',
    appToken: 'host-only-app-token',
  });
  assert.equal(Object.hasOwn(runtimes[2], 'outboundArtifactsEnabled'), false);
  await productionWithDefault.close();
});
