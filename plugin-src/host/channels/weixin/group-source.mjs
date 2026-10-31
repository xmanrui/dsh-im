import { join } from 'node:path';
import { findAdapterScript } from '../../../../src/channels/weixin/adapter-script.mjs';
import { WechatGroupRuntime } from '../../../../src/channels/weixin/wechat-group-runtime.mjs';
import { WechatGroupProcess } from '../../../../src/channels/weixin/wechat-group-process.mjs';
import { loadWechatGroupConfig } from '../../../../src/channels/weixin/wechat-group-config.mjs';

/**
 * Create the optional local-UIA group source for one account.
 *
 * Every failure here is confined to the group transport: a missing or damaged
 * config, a missing Python interpreter or an unavailable WeChat window must not
 * stop iLink direct messages. Returning null means "no group source configured".
 */
export function createWechatGroupRuntimeFactory({
  pluginRoot = undefined, spawnImpl = undefined, logger = console,
} = {}) {
  return async function createGroupRuntime({
    config, configPath, harness, state, contextEnhancement, accessPolicy, logger: providedLogger,
  }) {
    const activeLogger = providedLogger ?? logger;
    let groupConfig;
    try {
      groupConfig = await loadWechatGroupConfig(configPath);
    } catch (error) {
      // A damaged config is an explicit offline state, never a reason to
      // tear down the account's direct-message connection.
      activeLogger.warn?.('[dsh-weixin] group config rejected:', error?.code ?? error?.message);
      return unhealthyGroupRuntime(error?.code ?? 'group-config-invalid', error?.message);
    }
    if (!groupConfig) return null;

    // Resolve the adapter by finding the real file instead of trusting a guessed
    // package root. The same module is consumed both as a bundled lib/index.js
    // entry and as an unbundled plugin-src module, and a link: install resolves
    // the entry through a symlink, so a fixed ../../../.. ascent pointed outside
    // the package and the child interpreter died with "can't open file" before
    // executing a single Python statement.
    const scriptPath = findAdapterScript(pluginRoot ?? import.meta.dirname)
      ?? join(pluginRoot ?? import.meta.dirname, 'scripts', 'wechat_group_uia.py');
    const process = new WechatGroupProcess({
      config: groupConfig,
      scriptPath,
      configPath,
      ...(spawnImpl ? { spawnImpl } : {}),
      logger: activeLogger,
    });
    return new WechatGroupRuntime({
      config: groupConfig,
      process,
      harness,
      logger: activeLogger,
    });
  };
}

/** A stable offline runtime so Host status keeps reporting the real cause. */
export function unhealthyGroupRuntime(code, message) {
  return {
    status: { ready: false, configuredGroups: 0, lastError: String(code) },
    handles: () => false,
    async start() {
      const error = new Error(message ?? code);
      error.code = code;
      throw error;
    },
    async stop() {},
    async waitForIdle() {},
    async sendText() {
      const error = new Error(message ?? code);
      error.code = code;
      throw error;
    },
  };
}
