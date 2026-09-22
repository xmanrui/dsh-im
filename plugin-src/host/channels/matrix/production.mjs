import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

import { MatrixConfigStore, MatrixSidecarStore } from '../../../../src/channels/matrix/matrix-config-store.mjs';
import { MatrixController } from '../../../../src/channels/matrix/matrix-controller.mjs';
import { MatrixCryptoStore, matrixCryptoPathFor } from '../../../../src/channels/matrix/matrix-crypto-store.mjs';
import { MatrixHarnessClient } from '../../../../src/channels/matrix/matrix-harness-client.mjs';
import { MatrixRuntime } from '../../../../src/channels/matrix/matrix-runtime.mjs';
import { ConversationStateStore } from '../../../../src/channels/shared/conversation-state-store.mjs';
import {
  BotWorkspaceStore,
  createBotWorkspaceScope,
  createWorkspaceAwareController,
  observeBotWorkspaceRemovals,
} from '../../../../src/channels/shared/bot-workspace-store.mjs';
import { listAgentPresetCatalog } from '../../../../src/channels/shared/agent-preset.mjs';
import { listModelCatalog } from '../../../../src/channels/shared/model-setting.mjs';
import { commandsForChannel } from '../../../../src/channels/shared/command-catalog.mjs';
import { createDeliveryAdapter } from '../../delivery-adapter.mjs';
import { createTokenConnectionSupervisor } from '../shared/connection-supervisor.mjs';
import { pluginPaths } from '../shared/production.mjs';
import { createHarnessCommandExecutor } from '../../harness-command-executor.mjs';
import { harnessConnection } from '../../harness-connection.mjs';
import { createHarnessSessionExecutors } from '../../harness-session-coordinator.mjs';
import {
  getInboundTtlRuntime,
  registerInboundTtlWorkspaces,
} from '../../inbound-ttl-runtime.mjs';
import {
  accessPolicyProvider,
  initialAccessPolicyFor,
} from '../shared/access-policy-production.mjs';

export async function createProductionController(ctx, config = {}, internals = {}) {
  if (!ctx?.credentials) throw new TypeError('dsh-im matrix requires ctx.credentials');
  const connection = harnessConnection(ctx, config);

  const ResolvedConfigStore = internals.ConfigStore ?? MatrixConfigStore;
  const ResolvedStateStore = internals.StateStore ?? ConversationStateStore;
  const ResolvedSidecarStore = internals.SidecarStore ?? MatrixSidecarStore;
  const ResolvedHarness = internals.HarnessClient ?? MatrixHarnessClient;
  const ResolvedController = internals.Controller ?? MatrixController;
  const ResolvedRuntime = internals.Runtime ?? MatrixRuntime;
  const createSupervisor = internals.createConnectionSupervisor ?? createTokenConnectionSupervisor;
  const logger = typeof ctx.logger === 'function'
    ? ctx.logger('dsh-im:matrix') : (ctx.logger ?? console);
  const agentPresetCatalog = () => listAgentPresetCatalog(ctx);
  const paths = pluginPaths(config, 'matrix');
  const configStore = await new ResolvedConfigStore(paths.config).load();
  const defaultWorkspace = resolve(config.workspace ?? process.cwd());
  const WorkspaceStore = internals.WorkspaceStore ?? BotWorkspaceStore;
  const workspaces = internals.workspaces
    ?? await new WorkspaceStore(paths.workspaces, { defaultWorkspace }).load();
  const configuredBots = configStore.list();
  await workspaces.reconcile(configuredBots.map((bot) => bot.botId));
  await Promise.all(configuredBots.map((bot) => workspaces.ensure(bot.botId, {
    defaultAgentPreset: config.agentPreset,
    initialAccessPolicy: initialAccessPolicyFor('matrix', bot),
  })));
  const observedConfigStore = typeof configStore.remove === 'function'
    ? observeBotWorkspaceRemovals(configStore, { workspaces })
    : configStore;
  const stateStores = new Map();
  const sidecarStores = new Map();
  const cryptoStores = new Map();
  const ResolvedCryptoStore = internals.CryptoStore ?? MatrixCryptoStore;
  const statePath = (botId) => resolve(paths.bots, botId, 'state.json');
  const sidecarPath = (botId) => resolve(paths.bots, botId, 'matrix.json');
  const cryptoPath = (botId) => matrixCryptoPathFor(resolve(paths.bots, botId));
  const stateFor = async (botId) => {
    let state = stateStores.get(botId);
    if (!state) {
      state = await new ResolvedStateStore(statePath(botId)).load();
      stateStores.set(botId, state);
    }
    return state;
  };
  const sidecarFor = async (botId) => {
    let sidecar = sidecarStores.get(botId);
    if (!sidecar) {
      sidecar = await new ResolvedSidecarStore(sidecarPath(botId)).load();
      sidecarStores.set(botId, sidecar);
    }
    return sidecar;
  };
  const cryptoFor = async (botId) => {
    let crypto = cryptoStores.get(botId);
    if (!crypto) {
      crypto = await new ResolvedCryptoStore(cryptoPath(botId)).load();
      cryptoStores.set(botId, crypto);
    }
    return crypto;
  };
  const commandExecutor = createHarnessCommandExecutor(ctx, internals.commandExecutor);
  const inboundTtl = internals.inboundTtl ?? getInboundTtlRuntime(ctx, config);
  const inboundTtlService = inboundTtl?.service ?? inboundTtl;
  registerInboundTtlWorkspaces(ctx, inboundTtlService, {
    workspaces,
    configStore: observedConfigStore,
    defaultWorkspace,
  });
  const { controlExecutor, sessionMaintenanceExecutor, fileIngressExecutor } = createHarnessSessionExecutors(ctx, {
    controlExecutor: internals.controlExecutor,
    sessionMaintenanceExecutor: internals.sessionMaintenanceExecutor,
    fileIngressExecutor: internals.fileIngressExecutor,
    inboundTtlService,
  });
  const harness = new ResolvedHarness({
    ...connection,
    workspace: defaultWorkspace,
    autostart: false,
    dshBin: config.dshBin ?? 'dsh',
    ...(commandExecutor ? { commandExecutor } : {}),
    ...(controlExecutor ? { controlExecutor } : {}),
    ...(sessionMaintenanceExecutor ? { sessionMaintenanceExecutor } : {}),
    ...(fileIngressExecutor ? { fileIngressExecutor } : {}),
  });
  const modelCatalog = () => listModelCatalog(harness);
  const knownCommandNames = new Set(
    commandsForChannel('matrix').flatMap((entry) => [entry.name, ...entry.aliases.map((alias) => alias.name)]),
  );
  const isKnownCommand = (name) => typeof name === 'string' && knownCommandNames.has(name.replace(/^\/+/, ''));
  const coreController = new ResolvedController({
    credentials: ctx.credentials,
    configStore: observedConfigStore,
    logger,
    ...(internals.inspectCredentials ? { inspectCredentials: internals.inspectCredentials } : {}),
    createRuntime: async ({ botId, config: botConfig, accessToken, password, userId }) => {
      const state = await stateFor(botId);
      const sidecar = await sidecarFor(botId);
      await workspaces.ensure(botId, {
        defaultAgentPreset: config.agentPreset,
        initialAccessPolicy: initialAccessPolicyFor('matrix', botConfig),
      });
      const workspaceScope = createBotWorkspaceScope(harness, {
        botId, workspaces, state, agentPresetCatalog,
      });
      const e2eeMode = String(botConfig?.e2eeMode ?? 'optional').trim().toLowerCase();
      const cryptoStore = e2eeMode === 'off' ? null : await cryptoFor(botId);
      return new ResolvedRuntime({
        config: botConfig,
        ...(accessToken ? { accessToken } : {}),
        ...(password ? { password } : {}),
        ...(userId ? { userId } : {}),
        harness: workspaceScope.harness,
        state: workspaceScope.state,
        sidecar,
        ...(cryptoStore ? { cryptoStore } : {}),
        contextEnhancement: { botId, getSettings: () => workspaces.contextEnhancementFor(botId) },
        accessPolicy: accessPolicyProvider(workspaces, botId, {
          channel: 'matrix', config: botConfig,
        }),
        ...(typeof internals.isKnownCommand === 'function'
          ? { isKnownCommand: internals.isKnownCommand }
          : { isKnownCommand }),
        replyTimeoutMs: config.replyTimeoutMs ?? 600_000,
        logger: {
          error: (...args) => logger.error?.(`[${botId}]`, ...args),
          warn: (...args) => logger.warn?.(`[${botId}]`, ...args),
          info: (...args) => logger.info?.(`[${botId}]`, ...args),
          debug: (...args) => logger.debug?.(`[${botId}]`, ...args),
        },
      });
    },
    deleteState: async ({ botId }) => {
      const state = stateStores.get(botId);
      stateStores.delete(botId);
      const sidecar = sidecarStores.get(botId);
      sidecarStores.delete(botId);
      const crypto = cryptoStores.get(botId);
      cryptoStores.delete(botId);
      if (crypto && typeof crypto.remove === 'function') {
        await crypto.remove();
      } else {
        try {
          await unlink(cryptoPath(botId));
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      if (state && typeof state.remove === 'function') {
        await state.remove();
      } else {
        try {
          await unlink(statePath(botId));
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      if (sidecar && typeof sidecar.remove === 'function') {
        await sidecar.remove();
      } else {
        try {
          await unlink(sidecarPath(botId));
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
    channel: 'matrix',
    controller,
    harness,
    logger,
    retryDelaysMs: config.retryDelaysMs,
    healthyIntervalMs: config.healthyIntervalMs,
  }).start();
  return {
    controller,
    deliveryAdapter: createDeliveryAdapter({
      channel: 'matrix', workspaces, coreController, stateFor,
    }),
    ready: supervisor.ready,
    async close() {
      await supervisor.close();
      await controller.close();
      harness.stopManagedProcess();
    },
  };
}
