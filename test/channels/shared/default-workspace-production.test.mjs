import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const channels = ['weixin', 'wecom', 'wecom-app', 'feishu', 'dingtalk', 'qq', 'slack', 'telegram', 'discord', 'whatsapp', 'imessage'];

for (const channel of channels) {
  test(channel + ' initializes new bots in the shared IM directory and honors a custom workspace', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-default-' + channel + '-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { createProductionController } = await import('../../../plugin-src/host/channels/' + channel + '/production.mjs');
    for (const custom of [false, true]) {
      const dshHome = join(root, custom ? 'custom-home' : 'default-home');
      const workspace = custom ? join(root, 'project') : join(dshHome, 'im');
      if (custom) await mkdir(workspace);
      let controllerOptions;
      let harnessOptions;
      let runtimeOptions;
      class ConfigStore {
        async load() { return this; }
        list() { return []; }
      }
      class StateStore { async load() { return this; } }
      class Harness {
        constructor(options) { harnessOptions = options; }
        stopManagedProcess() {}
      }
      class Runtime { constructor(options) { runtimeOptions = options; } }
      class Controller {
        constructor(options) { controllerOptions = options; }
        async close() {}
      }
      class CallbackServer {
        registerRoute() {}
        unregisterRoute() {}
        async stop() {}
      }
      const production = await createProductionController({
        credentials: {}, apiProxy: {},
        logger: () => ({ error() {}, warn() {}, info() {}, debug() {} }),
      }, { dshHome, ...(custom ? { workspace } : {}) }, {
        ConfigStore, StateStore, HarnessClient: Harness, Controller, Runtime, FeishuRuntime: Runtime,
        CallbackServer, api: {}, qrAuth: {}, deviceAuth: {}, lark: {}, proxyEnv: {},
        createConnectionSupervisor: () => ({
          ready: Promise.resolve(), start() { return this; }, async close() {},
        }),
      });
      try {
        const bot = { botId: 'new_bot', id: 'new_bot', appId: 'fixture', secretRef: 'fixture' };
        await controllerOptions.createRuntime({ botId: bot.botId, config: bot });
        assert.equal(harnessOptions.workspace, workspace);
        assert.equal(harnessOptions.ungroupedWorkspace, join(dshHome, 'im'));
        assert.equal(runtimeOptions.harness.currentWorkspace(), workspace);
        assert.equal((await stat(workspace)).isDirectory(), true);
      } finally {
        await production.close();
      }
    }
  });
}
