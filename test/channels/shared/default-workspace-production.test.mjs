import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BotWorkspaceStore } from '../../../src/channels/shared/bot-workspace-store.mjs';

const channels = ['weixin', 'wecom', 'wecom-app', 'feishu', 'dingtalk', 'qq', 'slack', 'telegram', 'discord', 'whatsapp', 'imessage'];

for (const channel of channels) {
  test(channel + ' creates the IM directory only for bots that select it, including after reload', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-default-' + channel + '-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { createProductionController } = await import('../../../plugin-src/host/channels/' + channel + '/production.mjs');
    for (const mode of ['default', 'channel', 'saved']) {
      const dshHome = join(root, mode);
      const imDirectory = join(dshHome, 'im');
      const workspace = mode === 'default' ? imDirectory : join(root, 'project-' + mode);
      const workspacesPath = join(root, mode + '-workspaces.json');
      if (mode !== 'default') await mkdir(workspace);
      const bot = { botId: 'new_bot', id: 'new_bot', appId: 'fixture', secretRef: 'fixture' };
      const secondBot = { ...bot, botId: 'second_bot', id: 'second_bot', appId: 'second' };
      let configuredBots = mode === 'saved' ? [bot, secondBot] : [];
      if (mode === 'saved') {
        const saved = await new BotWorkspaceStore(workspacesPath).load();
        for (const item of configuredBots) await saved.ensure(item.botId, { workspace });
      }
      let controllerOptions;
      let harnessOptions;
      let runtimeOptions;
      class ConfigStore {
        async load() { return this; }
        list() { return configuredBots; }
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
      const start = () => createProductionController({
        credentials: {}, apiProxy: {},
        logger: () => ({ error() {}, warn() {}, info() {}, debug() {} }),
      }, { dshHome, workspacesPath, ...(mode === 'channel' ? { workspace } : {}) }, {
        ConfigStore, StateStore, HarnessClient: Harness, Controller, Runtime, FeishuRuntime: Runtime,
        CallbackServer, api: {}, qrAuth: {}, deviceAuth: {}, lark: {}, proxyEnv: {},
        createConnectionSupervisor: () => ({
          ready: Promise.resolve(), start() { return this; }, async close() {},
        }),
      });
      let production = await start();
      try {
        await assert.rejects(stat(imDirectory), { code: 'ENOENT' });
      } finally {
        await production.close();
      }
      production = await start();
      try {
        await assert.rejects(stat(imDirectory), { code: 'ENOENT' }, 'reloading an idle channel stays side-effect free');
        await controllerOptions.createRuntime({ botId: bot.botId, config: bot });
        assert.equal(harnessOptions.workspace, mode === 'channel' ? workspace : imDirectory);
        assert.equal(harnessOptions.ungroupedWorkspace, join(dshHome, 'im'));
        assert.equal(runtimeOptions.harness.currentWorkspace(), workspace);
        assert.equal((await stat(workspace)).isDirectory(), true);
        if (mode !== 'default') await assert.rejects(stat(imDirectory), { code: 'ENOENT' });
      } finally {
        await production.close();
      }
      configuredBots = mode === 'saved' ? [bot, secondBot] : [bot];
      // Reproduce deleting the old empty fallback before a restart.
      await mkdir(imDirectory, { recursive: true });
      await rm(imDirectory, { recursive: true });
      production = await start();
      try {
        if (mode === 'default') assert.equal((await stat(imDirectory)).isDirectory(), true);
        else await assert.rejects(stat(imDirectory), { code: 'ENOENT' });
        for (const item of configuredBots) {
          await controllerOptions.createRuntime({ botId: item.botId, config: item });
          assert.equal(runtimeOptions.harness.currentWorkspace(), workspace);
        }
      } finally {
        await production.close();
      }
    }
  });
}
