import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { unlink } from 'node:fs/promises';
import * as Lark from '@larksuiteoapi/node-sdk';
import HttpsProxyAgent from 'https-proxy-agent';
import { createConnectionSupervisor } from './connection-supervisor.mjs';
import { createHarnessCommandExecutor } from '../../harness-command-executor.mjs';
import { harnessConnection } from '../../harness-connection.mjs';
import { createHarnessSessionExecutors } from '../../harness-session-coordinator.mjs';
import { verifyFeishuApp } from '../../../../src/channels/feishu/feishu-app.mjs';
import { FeishuRuntime } from '../../../../src/channels/feishu/feishu-runtime.mjs';
import { HarnessClient } from '../../../../src/channels/feishu/harness-client.mjs';
import {
  LEGACY_FEISHU_SECRET_REF,
  PluginConfigStore,
} from '../../../../src/channels/feishu/plugin-config-store.mjs';
import { MultiBotDshFeishuController } from '../../../../src/channels/feishu/multi-bot-controller.mjs';
import { StateStore } from '../../../../src/channels/feishu/state-store.mjs';
import {
  BotWorkspaceStore,
  createBotWorkspaceScope,
  createWorkspaceAwareController,
  observeBotWorkspaceRemovals,
} from '../../../../src/channels/shared/bot-workspace-store.mjs';
import { listAgentPresetCatalog } from '../../../../src/channels/shared/agent-preset.mjs';
import { cachedModelCatalog } from '../../../../src/channels/shared/default-model.mjs';
import { createDeliveryAdapter } from '../../delivery-adapter.mjs';
import {
  accessPolicyProvider,
  initialAccessPolicyFor,
} from '../shared/access-policy-production.mjs';

// The WebSocket agent built here is only used for the Feishu long connection,
// whose endpoint is open.feishu.cn (Feishu) or open.larksuite.com (Lark).
// Honor NO_PROXY/no_proxy for those hosts so users with blanket proxy
// environments exported in their shell (Clash/V2Ray etc.) keep a direct
// connection to Feishu instead of routing the WSS handshake through the proxy.
const LONG_CONNECTION_HOSTS = ['open.feishu.cn', 'open.larksuite.com'];

function hostExcludedByNoProxyEntry(host, entry) {
  if (entry === '*') return true;
  const bare = entry.startsWith('.') ? entry.slice(1) : entry;
  if (!bare) return false;
  return host === bare || host.endsWith(`.${bare}`);
}

function longConnectionExcludedByNoProxy(env) {
  for (const key of ['no_proxy', 'NO_PROXY']) {
    const value = env?.[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    const entries = value.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
    if (LONG_CONNECTION_HOSTS.some((host) => entries.some((entry) => hostExcludedByNoProxyEntry(host, entry)))) {
      return true;
    }
  }
  return false;
}

function webSocketProxyUrl(env) {
  if (longConnectionExcludedByNoProxy(env)) return undefined;
  for (const key of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY']) {
    const value = env?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function createFeishuWebSocketAgent(
  env,
  createAgent = (url) => new HttpsProxyAgent(url),
) {
  const proxyUrl = webSocketProxyUrl(env);
  return proxyUrl ? createAgent(proxyUrl) : undefined;
}

function pluginPaths(config) {
  const dshHome = resolve(config.dshHome
    ?? process.env.DSH_HOME
    ?? join(homedir(), '.dsh'));
  const root = resolve(config.dataDir ?? join(dshHome, 'integrations', 'dsh-feishu'));
  return {
    root,
    config: resolve(config.configPath ?? join(root, 'config.json')),
    legacyState: resolve(config.statePath ?? join(root, 'state.json')),
    bots: resolve(config.botsDir ?? join(root, 'bots')),
    workspaces: resolve(config.workspacesPath ?? join(root, 'workspaces.json')),
  };
}

/**
 * Assemble the production controller from DSH Host services and local plugin
 * classes. No bridge process or environment App credentials are required.
 */
export async function createProductionController(ctx, config = {}, internals = {}) {
  if (!ctx?.credentials) throw new TypeError('dsh-feishu requires ctx.credentials');
  const connection = harnessConnection(ctx, config);

  const lark = internals.lark ?? Lark;
  const Controller = internals.Controller ?? MultiBotDshFeishuController;
  const ConfigStore = internals.ConfigStore ?? PluginConfigStore;
  const SessionStateStore = internals.StateStore ?? StateStore;
  const Harness = internals.HarnessClient ?? HarnessClient;
  const Runtime = internals.FeishuRuntime ?? FeishuRuntime;
  const verify = internals.verifyFeishuApp ?? verifyFeishuApp;
  const verifyApp = (options) => verify({
    ...options,
    httpInstance: lark.defaultHttpInstance,
  });
  const createSupervisor = internals.createConnectionSupervisor ?? createConnectionSupervisor;
  const logger = typeof ctx.logger === 'function'
    ? ctx.logger('dsh-feishu')
    : (ctx.logger ?? console);
  const agentPresetCatalog = () => listAgentPresetCatalog(ctx);
  const modelCatalog = cachedModelCatalog(() => harness.listModels());
  const paths = pluginPaths(config);
  const configStore = await new ConfigStore(paths.config).load();
  const defaultWorkspace = resolve(config.workspace ?? process.cwd());
  const WorkspaceStore = internals.WorkspaceStore ?? BotWorkspaceStore;
  const workspaces = internals.workspaces
    ?? await new WorkspaceStore(paths.workspaces, { defaultWorkspace }).load();
  const canListConfiguredBots = typeof configStore.list === 'function';
  const listConfiguredBots = () => canListConfiguredBots ? configStore.list() : [];
  const configuredBots = listConfiguredBots();
  if (canListConfiguredBots) {
    await workspaces.reconcile(configuredBots.map((bot) => bot.id));
  }
  await Promise.all(configuredBots.map((bot) => workspaces.ensure(bot.id, {
    defaultAgentPreset: config.agentPreset,
    initialAccessPolicy: initialAccessPolicyFor('feishu', bot),
  })));
  const observedConfigStore = typeof configStore.removeBot === 'function'
    ? observeBotWorkspaceRemovals(configStore, {
        workspaces,
        method: 'removeBot',
        botIdFromRemoved: (removed) => removed.id,
        saveMethod: 'saveBot',
        botIdFromSave: (bot) => bot?.id,
      })
    : configStore;
  // State is lazy per bot. A corrupt legacy file can therefore fail only the
  // migrated bot and cannot prevent healthy v2 bots from starting.
  const stateStores = new Map();
  const statePathFor = (botConfig) => !botConfig.id
    || !botConfig.secretRef
    || botConfig.secretRef === LEGACY_FEISHU_SECRET_REF
    ? paths.legacyState
    : resolve(paths.bots, botConfig.id, 'state.json');
  const stateFor = async (botConfig) => {
    const stateKey = botConfig.id ?? '__legacy__';
    let state = stateStores.get(stateKey);
    if (!state) {
      state = await new SessionStateStore(statePathFor(botConfig)).load();
      stateStores.set(stateKey, state);
    }
    return state;
  };
  const stateForBotId = async (botId) => {
    const botConfig = listConfiguredBots().find((bot) => bot.id === botId);
    if (!botConfig) throw new Error('Unknown Feishu bot');
    return stateFor(botConfig);
  };
  const commandExecutor = createHarnessCommandExecutor(ctx, internals.commandExecutor);
  const { controlExecutor, sessionMaintenanceExecutor, fileIngressExecutor } = createHarnessSessionExecutors(ctx, {
    controlExecutor: internals.controlExecutor,
    sessionMaintenanceExecutor: internals.sessionMaintenanceExecutor,
    fileIngressExecutor: internals.fileIngressExecutor,
  });
  const harness = new Harness({
    ...connection,
    workspace: defaultWorkspace,
    // This plugin is already hosted by a running DSH process. Starting a
    // second DSH would create a competing server and lifecycle.
    autostart: false,
    dshBin: config.dshBin ?? 'dsh',
    ...(commandExecutor ? { commandExecutor } : {}),
    ...(controlExecutor ? { controlExecutor } : {}),
    ...(sessionMaintenanceExecutor ? { sessionMaintenanceExecutor } : {}),
    ...(fileIngressExecutor ? { fileIngressExecutor } : {}),
  });
  const proxyEnv = internals.proxyEnv ?? process.env;
  const wsAgent = createFeishuWebSocketAgent(proxyEnv, internals.createProxyAgent);

  const coreController = new Controller({
    registerApp: (options) => lark.registerApp(options),
    verifyApp,
    credentials: ctx.credentials,
    configStore: observedConfigStore,
    createRuntime: async ({ botId, config: botConfig, appSecret, repair }) => {
      const state = await stateFor(botConfig);
      const id = botId ?? botConfig.id ?? botConfig.appId;
      await workspaces.ensure(id, {
        defaultAgentPreset: config.agentPreset,
        initialAccessPolicy: initialAccessPolicyFor('feishu', botConfig),
      });
      const workspaceScope = createBotWorkspaceScope(harness, {
        botId: id, workspaces, state, agentPresetCatalog,
      });
      return new Runtime({
        lark,
        botId: id,
        repair,
        appId: botConfig.appId,
        appSecret,
        domain: botConfig.domain,
        botOpenId: botConfig.botOpenId,
        groupResponseMode: botConfig.groupResponseMode,
        ownerOpenIds: botConfig.ownerOpenIds ?? [botConfig.ownerOpenId],
        harness: workspaceScope.harness,
        state: workspaceScope.state,
        contextEnhancement: { botId: id, getSettings: () => workspaces.contextEnhancementFor(id) },
        accessPolicy: accessPolicyProvider(workspaces, id, {
          channel: 'feishu', config: botConfig,
        }),
        replyTimeoutMs: config.replyTimeoutMs ?? 600_000,
        slashCommands: config.slashCommands !== false,
        ...(wsAgent ? { wsAgent } : {}),
        logger: {
          error: (...args) => logger.error?.(`[${botId ?? botConfig.id}]`, ...args),
          warn: (...args) => logger.warn?.(`[${botId ?? botConfig.id}]`, ...args),
          info: (...args) => logger.info?.(`[${botId ?? botConfig.id}]`, ...args),
          debug: (...args) => logger.debug?.(`[${botId ?? botConfig.id}]`, ...args),
        },
      });
    },
    deleteState: async ({ botId, config: botConfig }) => {
      stateStores.delete(botId);
      try {
        await unlink(statePathFor(botConfig));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },
  });
  const controller = createWorkspaceAwareController(coreController, {
    workspaces,
    stateFor: stateForBotId,
    agentPresetCatalog,
    modelCatalog,
  });

  const supervisor = createSupervisor({
    controller,
    harness,
    logger,
    retryDelaysMs: config.retryDelaysMs,
    healthyIntervalMs: config.healthyIntervalMs,
  }).start();
  return {
    controller,
    deliveryAdapter: createDeliveryAdapter({
      channel: 'feishu', workspaces, coreController, stateFor: stateForBotId,
    }),
    ready: supervisor.ready,
    async close() {
      await supervisor.close();
      await controller.close();
      harness.stopManagedProcess();
      wsAgent?.destroy?.();
    },
  };
}
