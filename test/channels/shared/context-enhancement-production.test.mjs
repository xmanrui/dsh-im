import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BotWorkspaceStore } from '../../../src/channels/shared/bot-workspace-store.mjs';
import {
  DEFAULT_CONTEXT_ENHANCEMENT_CONFIG,
  captureContextEnhancement,
} from '../../../src/channels/shared/context-enhancement.mjs';

for (const channel of ['wecom', 'weixin', 'feishu', 'dingtalk', 'qq', 'slack', 'telegram', 'discord', 'whatsapp']) {
  test(`${channel} production passes live, isolated context settings without reconnecting or changing Harness options`, async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), `dsh-context-${channel}-`));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const { createProductionController } = await import(`../../../plugin-src/host/channels/${channel}/production.mjs`);
    const workspaces = await new BotWorkspaceStore(join(dataDir, 'workspaces.json'), { defaultWorkspace: dataDir }).load();
    const botIds = [`${channel}_one`, `${channel}_two`];
    const bots = botIds.map((botId) => ({ botId, id: botId, appId: 'cli_fixture', secretRef: 'fixture-only' }));
    const runtimes = [];
    let controllerOptions;
    let harnessOptions;
    let stateLoads = 0;
    class ConfigStore {
      async load() { return this; }
      list() { return bots; }
    }
    class StateStore {
      async load() { stateLoads += 1; return this; }
      clearSessions() { throw new Error('enhancement must not reset sessions'); }
    }
    class Harness {
      constructor(options) { harnessOptions = options; }
      stopManagedProcess() {}
    }
    class Runtime {
      constructor(options) { runtimes.push(options); }
    }
    class Controller {
      constructor(options) { controllerOptions = options; }
      status() { return { bots: botIds.map((botId) => ({ botId, connected: true })) }; }
      reconnectBot() { throw new Error('enhancement must not reconnect'); }
      async close() {}
    }
    const production = await createProductionController({
      credentials: {},
      apiProxy: {},
      logger: () => ({ error() {}, warn() {}, info() {}, debug() {} }),
    }, { dataDir, workspace: dataDir }, {
      ConfigStore,
      StateStore,
      HarnessClient: Harness,
      Controller,
      Runtime,
      FeishuRuntime: Runtime,
      workspaces,
      api: {},
      qrAuth: {},
      deviceAuth: {},
      lark: {},
      proxyEnv: {},
      createConnectionSupervisor: () => ({
        ready: Promise.resolve(), start() { return this; }, async close() {},
      }),
    });
    t.after(() => production.close());
    for (const bot of bots) {
      await controllerOptions.createRuntime({ botId: bot.botId, config: bot });
    }
    assert.equal(runtimes.length, 2);
    assert.equal(stateLoads, 2);
    assert.equal(Object.hasOwn(harnessOptions, 'contextEnhancement'), false);
    assert.equal(Object.hasOwn(harnessOptions, 'source'), false);
    const provider = runtimes[0].contextEnhancement;
    assert.equal(provider.botId, botIds[0]);
    assert.equal(provider.getSettings(), DEFAULT_CONTEXT_ENHANCEMENT_CONFIG);
    assert.equal(captureContextEnhancement(provider, 'direct'), null);
    const generation = workspaces.generationFor(botIds[0]);
    const selected = {
      group: { enabled: false, fields: ['botId'], guidance: 'stored group guidance' },
      direct: { enabled: true, fields: [], guidance: 'runtime update' },
    };
    const saved = await production.controller.updateContextEnhancement(botIds[0], selected);
    assert.deepEqual(saved.bots[0].contextEnhancement, selected);
    assert.deepEqual(provider.getSettings(), selected);
    const beforeDisable = captureContextEnhancement(provider, 'direct');
    assert.deepEqual(beforeDisable.config, selected.direct);
    assert.equal(runtimes[0].contextEnhancement, provider, 'runtime does not need reconstruction');
    assert.equal(runtimes[1].contextEnhancement.getSettings(), DEFAULT_CONTEXT_ENHANCEMENT_CONFIG);
    assert.equal(runtimes[1].contextEnhancement.botId, botIds[1]);
    await production.controller.updateContextEnhancement(botIds[0], {
      ...selected,
      direct: { ...selected.direct, enabled: false },
    });
    assert.equal(captureContextEnhancement(provider, 'direct'), null);
    assert.equal(beforeDisable.config.enabled, true, 'an already received message keeps its snapshot');
    assert.equal(workspaces.generationFor(botIds[0]), generation);
    assert.equal(runtimes.length, 2);
    assert.equal(stateLoads, 2);
  });
}
