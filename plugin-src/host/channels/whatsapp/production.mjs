import { rm, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { WhatsappConfigStore } from '../../../../src/channels/whatsapp/config-store.mjs';
import { WhatsappHarnessClient } from '../../../../src/channels/whatsapp/harness-client.mjs';
import { WhatsappStateStore } from '../../../../src/channels/whatsapp/state-store.mjs';
import { WhatsappController } from '../../../../src/channels/whatsapp/whatsapp-controller.mjs';
import {
  WhatsappRuntime,
  whatsappAccessPolicyIdsEqual,
} from '../../../../src/channels/whatsapp/whatsapp-runtime.mjs';
import { createWhatsappWebSession } from '../../../../src/channels/whatsapp/whatsapp-web-session.mjs';
import {
  BotWorkspaceStore,
  createBotWorkspaceScope,
  createWorkspaceAwareController,
  observeBotWorkspaceRemovals,
} from '../../../../src/channels/shared/bot-workspace-store.mjs';
import { listAgentPresetCatalog } from '../../../../src/channels/shared/agent-preset.mjs';
import { cachedModelCatalog } from '../../../../src/channels/shared/default-model.mjs';
import { createDeliveryAdapter } from '../../delivery-adapter.mjs';
import { createTokenConnectionSupervisor } from '../shared/connection-supervisor.mjs';
import { createHarnessCommandExecutor } from '../../harness-command-executor.mjs';
import { harnessConnection } from '../../harness-connection.mjs';
import { createHarnessSessionExecutors } from '../../harness-session-coordinator.mjs';
import {
  accessPolicyProvider,
  initialAccessPolicyFor,
} from '../shared/access-policy-production.mjs';

const AUTH_DIRECTORY_PATTERN = /^[a-f0-9-]{36}$/;

function pluginPaths(config) {
  const dshHome = resolve(config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'));
  const root = resolve(config.dataDir ?? join(dshHome, 'integrations', 'dsh-whatsapp'));
  const authRoot = resolve(config.authDir ?? join(root, 'auth'));
  const authPath = (name) => {
    if (!AUTH_DIRECTORY_PATTERN.test(name ?? '')) throw new TypeError('Invalid WhatsApp auth directory');
    return resolve(authRoot, name);
  };
  return {
    config: resolve(config.configPath ?? join(root, 'config.json')),
    bots: resolve(config.botsDir ?? join(root, 'bots')),
    workspaces: resolve(config.workspacesPath ?? join(root, 'workspaces.json')),
    authPath,
  };
}

export async function createProductionController(ctx, config = {}, internals = {}) {
  const connection = harnessConnection(ctx, config);
  const logger = typeof ctx.logger === 'function'
    ? ctx.logger('dsh-im:whatsapp') : (ctx.logger ?? console);
  const agentPresetCatalog = () => listAgentPresetCatalog(ctx);
  const modelCatalog = cachedModelCatalog(() => harness.listModels());
  const ConfigStore = internals.ConfigStore ?? WhatsappConfigStore;
  const StateStore = internals.StateStore ?? WhatsappStateStore;
  const Harness = internals.HarnessClient ?? WhatsappHarnessClient;
  const Controller = internals.Controller ?? WhatsappController;
  const Runtime = internals.Runtime ?? WhatsappRuntime;
  const createSession = internals.createSession ?? createWhatsappWebSession;
  const createSupervisor = internals.createConnectionSupervisor ?? createTokenConnectionSupervisor;
  const paths = pluginPaths(config);
  const configStore = await new ConfigStore(paths.config).load();
  const defaultWorkspace = resolve(config.workspace ?? process.cwd());
  const WorkspaceStore = internals.WorkspaceStore ?? BotWorkspaceStore;
  const workspaces = internals.workspaces
    ?? await new WorkspaceStore(paths.workspaces, { defaultWorkspace }).load();
  const configuredBots = configStore.list();
  await workspaces.reconcile(configuredBots.map((bot) => bot.botId));
  await Promise.all(configuredBots.map((bot) => workspaces.ensure(bot.botId, {
    defaultAgentPreset: config.agentPreset,
    initialAccessPolicy: initialAccessPolicyFor('whatsapp', bot),
  })));
  const observedConfigStore = typeof configStore.remove === 'function'
    ? observeBotWorkspaceRemovals(configStore, { workspaces })
    : configStore;
  const stateStores = new Map();
  const statePath = (botId) => resolve(paths.bots, botId, 'state.json');
  const stateFor = async (botId) => {
    let state = stateStores.get(botId);
    if (!state) {
      state = await new StateStore(statePath(botId)).load();
      stateStores.set(botId, state);
    }
    return state;
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
    autostart: false,
    dshBin: config.dshBin ?? 'dsh',
    ...(commandExecutor ? { commandExecutor } : {}),
    ...(controlExecutor ? { controlExecutor } : {}),
    ...(sessionMaintenanceExecutor ? { sessionMaintenanceExecutor } : {}),
    ...(fileIngressExecutor ? { fileIngressExecutor } : {}),
  });
  const coreController = new Controller({
    configStore: observedConfigStore,
    authPath: paths.authPath,
    createSession,
    logger,
    createRuntime: async ({ botId, config: botConfig, authDir }) => {
      const state = await stateFor(botId);
      await workspaces.ensure(botId, {
        defaultAgentPreset: config.agentPreset,
        initialAccessPolicy: initialAccessPolicyFor('whatsapp', botConfig),
      });
      const workspaceScope = createBotWorkspaceScope(harness, {
        botId, workspaces, state, agentPresetCatalog,
      });
      return new Runtime({
        config: botConfig,
        authDir,
        harness: workspaceScope.harness,
        state: workspaceScope.state,
        contextEnhancement: { botId, getSettings: () => workspaces.contextEnhancementFor(botId) },
        accessPolicy: accessPolicyProvider(workspaces, botId, {
          channel: 'whatsapp', config: botConfig, equals: whatsappAccessPolicyIdsEqual,
        }),
        replyTimeoutMs: config.replyTimeoutMs ?? 600_000,
        connectTimeoutMs: config.connectTimeoutMs ?? 30_000,
        createSession,
        logger: {
          error: (...args) => logger.error?.(`[${botId}]`, ...args),
          warn: (...args) => logger.warn?.(`[${botId}]`, ...args),
          info: (...args) => logger.info?.(`[${botId}]`, ...args),
          debug: (...args) => logger.debug?.(`[${botId}]`, ...args),
        },
      });
    },
    deleteAuth: (authDirectory) => rm(paths.authPath(authDirectory), {
      recursive: true,
      force: true,
    }),
    deleteState: async ({ botId }) => {
      const state = stateStores.get(botId);
      stateStores.delete(botId);
      if (state && typeof state.remove === 'function') {
        await state.remove();
      } else {
        try {
          await unlink(statePath(botId));
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    },
  });
  const controller = createWorkspaceAwareController(coreController, {
    workspaces,
    stateFor,
    agentPresetCatalog,
    modelCatalog,
  });
  const supervisor = createSupervisor({
    channel: 'whatsapp',
    controller,
    harness,
    logger,
    retryDelaysMs: config.retryDelaysMs,
    healthyIntervalMs: config.healthyIntervalMs,
  }).start();
  return {
    controller,
    deliveryAdapter: createDeliveryAdapter({
      channel: 'whatsapp', workspaces, coreController, stateFor,
    }),
    ready: supervisor.ready,
    async close() {
      await supervisor.close();
      await controller.close();
      harness.stopManagedProcess();
    },
  };
}
