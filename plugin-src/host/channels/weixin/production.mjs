import { getImageInputSettingsStore } from '../../../../src/channels/shared/image-input-settings-store.mjs';
import { unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { WeixinConfigStore } from '../../../../src/channels/weixin/config-store.mjs';
import { HarnessClient } from '../../../../src/channels/weixin/harness-client.mjs';
import { WeixinStateStore } from '../../../../src/channels/weixin/state-store.mjs';
import {
  createWeixinApi,
  DEFAULT_WEIXIN_MAX_MESSAGE_CHARS,
} from '../../../../src/channels/weixin/weixin-api.mjs';
import { WeixinController } from '../../../../src/channels/weixin/weixin-controller.mjs';
import { WeixinRuntime } from '../../../../src/channels/weixin/weixin-runtime.mjs';
import { createWeixinDiagnostics, knownWeixinErrorCode, weixinStageError } from '../../../../src/channels/weixin/connection-error.mjs';
import {
  BotWorkspaceStore,
  createBotWorkspaceScope,
  createWorkspaceAwareController,
  observeBotWorkspaceRemovals,
} from '../../../../src/channels/shared/bot-workspace-store.mjs';
import { prepareBotWorkspace } from '../../../../src/channels/shared/default-workspace.mjs';
import { listAgentPresetCatalog } from '../../../../src/channels/shared/agent-preset.mjs';
import { listModelCatalog } from '../../../../src/channels/shared/model-setting.mjs';
import { createDeliveryAdapter } from '../../delivery-adapter.mjs';
import { createConnectionSupervisor } from './connection-supervisor.mjs';
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

function pluginPaths(config) {
  const dshHome = resolve(config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'));
  const root = resolve(config.dataDir ?? join(dshHome, 'integrations', 'dsh-weixin'));
  return {
    root,
    config: resolve(config.configPath ?? join(root, 'config.json')),
    accounts: resolve(config.accountsDir ?? join(root, 'accounts')),
    workspaces: resolve(config.workspacesPath ?? join(root, 'workspaces.json')),
  };
}

// Keep shared workspace lifecycle semantics; expose its fallible persistence only to Weixin.
function diagnosticWorkspaces(store) {
  const writes = new Set(['ensure', 'setWorkspace', 'setModel', 'setAgentPreset', 'setAlias', 'setContextEnhancement', 'setAccessPolicy', 'flushPendingRemoval']);
  const removals = new Set(['retireAfterConfigCommit', 'finishRemoval']);
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (!writes.has(property) && !removals.has(property)) return value.bind(target);
      return (...args) => {
        const failure = error => {
          throw knownWeixinErrorCode(error?.code) ? error
            : weixinStageError(removals.has(property) ? 'workspace-cleanup-failed' : 'workspace-save-failed', error);
        };
        try {
          const result = value.apply(target, args);
          // flushPendingRemoval must remain synchronous when no cleanup is pending.
          return result?.then ? result.then(value => {
            if (removals.has(property) && value?.error) failure(value.error);
            return value;
          }, failure) : result;
        } catch (error) { return failure(error); }
      };
    },
  });
}

export async function createProductionController(ctx, config = {}, internals = {}) {
  if (!ctx?.credentials) throw new TypeError('dsh-weixin requires ctx.credentials');
  const connection = harnessConnection(ctx, config);

  const ConfigStore = internals.ConfigStore ?? WeixinConfigStore;
  const StateStore = internals.StateStore ?? WeixinStateStore;
  const Harness = internals.HarnessClient ?? HarnessClient;
  const Controller = internals.Controller ?? WeixinController;
  const Runtime = internals.Runtime ?? WeixinRuntime;
  const api = internals.api ?? createWeixinApi();
  const createSupervisor = internals.createConnectionSupervisor ?? createConnectionSupervisor;
  const logger = typeof ctx.logger === 'function'
    ? ctx.logger('dsh-weixin')
    : (ctx.logger ?? console);
  const diagnostics = internals.diagnostics ?? createWeixinDiagnostics({ logger });
  const agentPresetCatalog = () => listAgentPresetCatalog(ctx);
  const paths = pluginPaths(config);
  const configStore = await new ConfigStore(paths.config).load();
  const { defaultWorkspace, ungroupedWorkspace } = await prepareBotWorkspace(config);
  const WorkspaceStore = internals.WorkspaceStore ?? BotWorkspaceStore;
  const workspaces = diagnosticWorkspaces(internals.workspaces
    ?? await new WorkspaceStore(paths.workspaces, { defaultWorkspace }).load());
  const configuredBots = configStore.list();
  await workspaces.reconcile(configuredBots.map((bot) => bot.botId));
  await Promise.all(configuredBots.map((bot) => workspaces.ensure(bot.botId, {
    defaultAgentPreset: config.agentPreset,
    initialAccessPolicy: initialAccessPolicyFor('weixin', bot),
  })));
  const observedConfigStore = typeof configStore.remove === 'function'
    ? observeBotWorkspaceRemovals(configStore, { workspaces })
    : configStore;
  const stateStores = new Map();

  const statePath = (botId) => resolve(paths.accounts, botId, 'state.json');
  const stateFor = async (botId) => {
    let state = stateStores.get(botId);
    if (!state) {
      state = await new StateStore(statePath(botId)).load();
      stateStores.set(botId, state);
    }
    return state;
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
  const harness = new Harness({
    ...connection,
    workspace: defaultWorkspace,
    ungroupedWorkspace,
    autostart: false,
    dshBin: config.dshBin ?? 'dsh',
    ...(commandExecutor ? { commandExecutor } : {}),
    ...(controlExecutor ? { controlExecutor } : {}),
    ...(sessionMaintenanceExecutor ? { sessionMaintenanceExecutor } : {}),
    ...(fileIngressExecutor ? { fileIngressExecutor } : {}),
    imageInputPolicy: () => getImageInputSettingsStore(config).get(),
  });
  const modelCatalog = () => listModelCatalog(harness);
  const coreController = new Controller({
    api,
    credentials: ctx.credentials,
    configStore: observedConfigStore,
    logger,
    diagnostics,
    createRuntime: async ({ botId, config: accountConfig, token }) => {
      const state = await stateFor(botId);
      await workspaces.ensure(botId, {
        defaultAgentPreset: config.agentPreset,
        initialAccessPolicy: initialAccessPolicyFor('weixin', accountConfig),
      });
      const workspaceScope = createBotWorkspaceScope(harness, {
        botId, workspaces, state, agentPresetCatalog,
      });
      return new Runtime({
        diagnostics,
        api,
        config: accountConfig,
        token,
        harness: workspaceScope.harness,
        state: workspaceScope.state,
        contextEnhancement: { botId, getSettings: () => workspaces.contextEnhancementFor(botId) },
        accessPolicy: accessPolicyProvider(workspaces, botId, {
          channel: 'weixin', config: accountConfig,
        }),
        replyTimeoutMs: config.replyTimeoutMs ?? 600_000,
        maxMessageChars: config.maxMessageChars ?? DEFAULT_WEIXIN_MAX_MESSAGE_CHARS,
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
  const workspaceController = createWorkspaceAwareController(coreController, {
    workspaces,
    stateFor,
    agentPresetCatalog,
    modelCatalog,
  });
  const controller = new Proxy(workspaceController, {
    get(target, property) {
      if (property === 'deleteBot') return async (...args) => {
        const existed = Boolean(configStore.get(args[0]));
        try { return await target.deleteBot(...args); }
        catch (error) {
          if (!existed || configStore.get(args[0])) throw error;
          // The shared workspace wrapper can fail cleaning up after the account commit.
          const warning = diagnostics.report(weixinStageError('workspace-cleanup-failed', error), {
            operation: 'bot.delete', botId: args[0], warning: true,
          }).publicError;
          try { return { ...await target.status(), warnings: [warning] }; }
          catch (readError) { throw weixinStageError('status-read-failed', readError, 'status.read'); }
        }
      };
      return Reflect.get(target, property);
    },
  });
  const supervisor = createSupervisor({
    controller,
    harness,
    logger,
    diagnostics,
    retryDelaysMs: config.retryDelaysMs,
    healthyIntervalMs: config.healthyIntervalMs,
  }).start();
  return {
    controller,
    deliveryAdapter: createDeliveryAdapter({
      channel: 'weixin', workspaces, coreController, stateFor,
    }),
    ready: supervisor.ready,
    async close() {
      await supervisor.close();
      await controller.close();
      harness.stopManagedProcess();
    },
  };
}
