import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import { HarnessClient } from '../../../../src/channels/shared/harness-client.mjs';
import { XiaoAIConfigStore } from '../../../../src/channels/xiaoai/config-store.mjs';
import { XiaoAIController } from '../../../../src/channels/xiaoai/controller.mjs';
import { XiaoAIRuntime } from '../../../../src/channels/xiaoai/runtime.mjs';
import { XiaoAIStateStore } from '../../../../src/channels/xiaoai/state-store.mjs';
import { AccountTransportPool } from '../../../../src/channels/xiaoai/account-transport.mjs';
import { createTokenProductionController, pluginPaths } from '../shared/production.mjs';

export async function createProductionController(ctx, config = {}, internals = {}) {
  const stateRoot = pluginPaths(config, 'xiaoai').bots;
  // A login worker cannot survive a Host restart. Remove its abandoned private tokens.
  await rm(resolve(stateRoot, 'auth'), { recursive: true, force: true });
  // In production esbuild places this module in lib/index.js, so one level up
  // is the package root. When the source module is loaded directly it lives at
  // plugin-src/host/channels/xiaoai, four levels below the package root. Pick
  // the candidate that actually contains the sidecar component.
  const moduleDir = fileURLToPath(new URL('.', import.meta.url));
  const packageRoot = [resolve(moduleDir, '..'), resolve(moduleDir, '../../../..')]
    .find((root) => existsSync(join(root, 'sidecar/xiaoai_sidecar.py')))
    ?? resolve(moduleDir, '..');
  const sidecar = { python: config.python ?? (process.platform === 'win32' ? 'python.exe' : '/usr/bin/python3'),
    script: config.sidecarScript ?? resolve(packageRoot, 'sidecar/xiaoai_sidecar.py'),
    dependencyDir: config.dependencyDir ?? resolve(packageRoot, 'sidecar/vendor') };
  const accountTransport = new AccountTransportPool({ stateRoot, sidecar, connectTimeoutMs: config.connectTimeoutMs ?? 25_000 });
  class Controller extends XiaoAIController {
    constructor(options) { super({ ...options, stateRoot, sidecar, accountTransport }); }
  }
  class XiaoAIHarnessClient extends HarnessClient {
    constructor(options) { super({ ...options, rpcIdPrefix: 'xiaoai', logPrefix: 'dsh-xiaoai' }); }
  }
  return createTokenProductionController(ctx, config, internals, {
    channel: 'xiaoai', ConfigStore: XiaoAIConfigStore, StateStore: XiaoAIStateStore,
    HarnessClient: XiaoAIHarnessClient, Controller, Runtime: XiaoAIRuntime,
    supportsSessionBinding: true, runtimeOptions: () => ({ stateRoot, sidecar,
      createSidecar: ({ credential }) => accountTransport.endpoint(credential) }),
  });
}
