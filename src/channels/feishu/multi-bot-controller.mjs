import { randomUUID } from 'node:crypto';
import { connectionTestMessage } from '../shared/connection-test.mjs';
import { RegistrationManager } from './registration-manager.mjs';
import { REQUIRED_TENANT_SCOPES } from './plugin-controller.mjs';

const ACTIVE_REGISTRATION_STATES = new Set([
  'starting', 'qr_ready', 'polling', 'slow_down', 'domain_switched',
]);
const MUTABLE_REGISTRATION_STATES = new Set([...ACTIVE_REGISTRATION_STATES, 'saving']);
const ALL_VISIBLE_SENDERS = '*';

function idleConnection() {
  return {
    ready: false,
    feishuLongConnectionState: 'idle',
    harnessReachable: false,
  };
}

function connectionStatus(runtime) {
  return runtime ? runtime.status : idleConnection();
}

function isConnected(connection) {
  return connection.ready === true
    && connection.feishuLongConnectionState === 'connected'
    && connection.harnessReachable === true;
}

function maskedAppId(appId) {
  return appId.length > 12
    ? `${appId.slice(0, 8)}••••${appId.slice(-4)}`
    : 'cli_••••';
}

function publicBot(config) {
  return {
    name: config.botName,
    appIdMasked: maskedAppId(config.appId),
    activated: config.activated,
    domain: config.domain,
  };
}

function botPhase({ connected, error, connection }) {
  if (connected) return 'connected';
  if (error || connection.feishuLongConnectionState === 'failed') return 'error';
  return 'disconnected';
}

function makeBotId() {
  return `bot_${randomUUID().replaceAll('-', '')}`;
}

function makeRegistrationId() {
  return `reg_${randomUUID().replaceAll('-', '')}`;
}

function secretRefFor(botId) {
  return `DSH_FEISHU_APP_SECRET_${botId.slice(4).toUpperCase()}`;
}

/**
 * Multi-account Feishu orchestration. Each bot owns its credential reference,
 * runtime and session store. Config commits are serialized, while unrelated
 * runtime lifecycles may proceed independently.
 */
export class MultiBotDshFeishuController {
  #registerApp;
  #verifyApp;
  #credentials;
  #configStore;
  #createRuntime;
  #deleteState;
  #createBotId;
  #createRegistrationId;
  #runtimes = new Map();
  #botErrors = new Map();
  #registrations = new Map();
  #botOwnership = new Map();
  #latestRegistrationId = null;
  #configTransition = Promise.resolve();
  #botTransitions = new Map();
  #revision = 1;
  #closed = false;

  constructor({
    registerApp,
    verifyApp,
    credentials,
    configStore,
    createRuntime,
    deleteState = async () => {},
    createBotId = makeBotId,
    createRegistrationId = makeRegistrationId,
  }) {
    if (typeof registerApp !== 'function') throw new Error('registerApp is required');
    if (typeof verifyApp !== 'function') throw new Error('verifyApp is required');
    if (!credentials) throw new Error('credentials service is required');
    if (!configStore || typeof configStore.list !== 'function') {
      throw new Error('multi-bot config store is required');
    }
    if (typeof createRuntime !== 'function') throw new Error('createRuntime is required');
    if (typeof deleteState !== 'function') throw new Error('deleteState must be a function');
    this.#registerApp = registerApp;
    this.#verifyApp = verifyApp;
    this.#credentials = credentials;
    this.#configStore = configStore;
    this.#createRuntime = createRuntime;
    this.#deleteState = deleteState;
    this.#createBotId = createBotId;
    this.#createRegistrationId = createRegistrationId;
  }

  async initialize() {
    if (this.#closed) return this.status();
    const bots = this.#configStore.list();
    let attempted = false;
    await Promise.allSettled(bots.map((config) => this.#withBotTransition(config.id, async () => {
      const current = connectionStatus(this.#runtimes.get(config.id));
      if (isConnected(current)
        || current.feishuLongConnectionState === 'connecting'
        || current.feishuLongConnectionState === 'reconnecting') {
        return;
      }
      attempted = true;
      if (config.deletionPending) {
        this.#botErrors.set(config.id, {
          code: 'deletion_pending',
          message: '机器人正在等待完成本地删除，请重试移除。',
        });
        return;
      }
      let resolved;
      try {
        resolved = await this.#credentials.resolve(config.secretRef);
      } catch {
        this.#botErrors.set(config.id, {
          code: 'missing_credentials',
          message: '无法读取机器人凭据，请检查凭据存储。',
        });
        return;
      }
      if (!resolved?.value) {
        this.#botErrors.set(config.id, {
          code: 'missing_credentials',
          message: '机器人凭据缺失，请删除后重新扫码接入。',
        });
        return;
      }
      try {
        await this.#startRuntime(config, resolved.value);
        this.#botErrors.delete(config.id);
      } catch {
        this.#botErrors.set(config.id, {
          code: 'connection_failed',
          message: '机器人暂时无法连接飞书，请重试。',
        });
      }
    })));
    if (attempted) this.#touch();
    return this.status();
  }

  startRegistration() {
    this.#assertOpen();
    const id = this.#createRegistrationId();
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || this.#registrations.has(id)) {
      throw new Error('Registration id generator returned an invalid or duplicate id');
    }
    const record = { id, manager: null, botId: null, createdNew: false, cancelled: false };
    record.manager = new RegistrationManager({
      registerApp: this.#registerApp,
      onCredentials: (result) => this.#serializeConfig(() => this.#acceptCredentials(record, result)),
    });
    this.#registrations.set(id, record);
    this.#latestRegistrationId = id;
    this.#trimRegistrations();
    record.manager.start({
      source: 'deepseek-harness',
      createOnly: true,
      appPreset: {
        name: '{user} 的北汇星河 AI 助手',
        desc: '连接飞书与 DeepSeek Harness，在聊天中使用企业 AI 助手。',
      },
      addons: {
        preset: false,
        scopes: { tenant: [...REQUIRED_TENANT_SCOPES] },
        events: { items: { tenant: ['im.message.receive_v1', 'card.action.trigger'] } },
      },
    });
    this.#touch();
    return this.registrationStatus(id);
  }

  hasRegistration(attemptId) {
    return this.#registrations.has(attemptId);
  }

  registrationStatus(attemptId) {
    const record = this.#registrations.get(attemptId);
    if (!record) return null;
    return this.#status({ registration: record, selectedBotId: record.botId });
  }

  async cancelRegistration(attemptId = this.#latestRegistrationId) {
    const record = this.#registrations.get(attemptId);
    if (!record) return this.status();
    if (!MUTABLE_REGISTRATION_STATES.has(record.manager.status().state)) {
      return this.registrationStatus(attemptId);
    }
    record.cancelled = true;
    record.manager.cancel();
    await this.#serializeConfig(async () => {
      if (record.createdNew && record.botId
        && this.#botOwnership.get(record.botId) === record.id
        && this.#configStore.getBot(record.botId)) {
        await this.#withBotTransition(record.botId, () => this.#deleteBot(record.botId));
      }
    });
    this.#touch();
    return this.registrationStatus(attemptId) ?? this.status();
  }

  status(botId) {
    return this.#status({
      registration: this.#registrations.get(this.#latestRegistrationId) ?? null,
      selectedBotId: botId,
    });
  }

  async bindCredentials({ appId, appSecret, domain = 'feishu' } = {}) {
    this.#assertOpen();
    const normalizedAppId = typeof appId === 'string' ? appId.trim() : '';
    const normalizedSecret = typeof appSecret === 'string' ? appSecret.trim() : '';
    const normalizedDomain = domain === 'lark' ? 'lark' : 'feishu';
    if (!normalizedAppId || !normalizedSecret) {
      throw new TypeError('Feishu App ID and App Secret are required');
    }

    return this.#serializeConfig(async () => {
      this.#assertOpen();
      const bot = await this.#verifyApp({
        appId: normalizedAppId,
        appSecret: normalizedSecret,
        domain: normalizedDomain,
      });
      this.#assertOpen();
      const existing = this.#configStore.list().find(
        (candidate) => candidate.appId === normalizedAppId,
      );
      const botId = existing?.id ?? this.#createBotId();
      if (typeof botId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(botId)
        || (!existing && this.#configStore.getBot(botId))) {
        throw new Error('Bot id generator returned an invalid or duplicate id');
      }
      const secretRef = existing?.secretRef ?? secretRefFor(botId);
      const previousSecret = await this.#credentials.resolve(secretRef).catch(() => undefined);
      const config = {
        ...existing,
        id: botId,
        appId: normalizedAppId,
        secretRef,
        ownerOpenIds: existing?.ownerOpenIds?.length
          ? existing.ownerOpenIds
          : [ALL_VISIBLE_SENDERS],
        domain: normalizedDomain,
        botName: bot.name,
        botOpenId: bot.openId,
        activated: bot.activated,
        deletionPending: false,
        connectedAt: new Date().toISOString(),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };

      await this.#credentials.set(secretRef, normalizedSecret);
      let saved;
      try {
        saved = await this.#configStore.saveBot(config);
      } catch (error) {
        await this.#restoreCredential(secretRef, previousSecret);
        throw error;
      }

      await this.#withBotTransition(botId, async () => {
        try {
          await this.#startRuntime(saved, normalizedSecret);
          this.#botErrors.delete(botId);
        } catch {
          this.#botErrors.set(botId, {
            code: 'connection_failed',
            message: '机器人已经绑定，但长连接未就绪，请点击重试。',
          });
        }
      });
      this.#touch();
      return this.status(botId);
    });
  }

  async reconnectBot(botId) {
    this.#assertOpen();
    return this.#withBotTransition(botId, async () => {
      const config = this.#requireBot(botId);
      if (config.deletionPending) {
        this.#botErrors.set(botId, {
          code: 'deletion_pending',
          message: '机器人正在等待完成本地删除，请重试移除。',
        });
        return this.status(botId);
      }
      if (isConnected(connectionStatus(this.#runtimes.get(botId)))) {
        return this.status(botId);
      }
      let resolved;
      try {
        resolved = await this.#credentials.resolve(config.secretRef);
      } catch {
        resolved = null;
      }
      if (!resolved?.value) {
        this.#botErrors.set(botId, {
          code: 'missing_credentials',
          message: '机器人凭据缺失，请删除后重新扫码接入。',
        });
        this.#touch();
        return this.status(botId);
      }
      try {
        await this.#startRuntime(config, resolved.value);
        this.#botErrors.delete(botId);
      } catch {
        this.#botErrors.set(botId, {
          code: 'connection_failed',
          message: '机器人暂时无法连接飞书，请重试。',
        });
      }
      this.#touch();
      return this.status(botId);
    });
  }

  async sendConnectionTest(botId) {
    this.#assertOpen();
    return this.#withBotTransition(botId, async () => {
      const config = this.#requireBot(botId);
      const runtime = this.#runtimes.get(botId);
      if (!isConnected(connectionStatus(runtime))
        || typeof runtime.sendConnectionTest !== 'function') {
        const error = new Error('飞书机器人尚未连接');
        error.code = 'test-target-unavailable';
        throw error;
      }
      return runtime.sendConnectionTest(
        connectionTestMessage(
          `${config.botName}（${maskedAppId(config.appId)}）`,
          '飞书机器人',
        ),
      );
    });
  }

  async disconnectBot(botId) {
    this.#assertOpen();
    // An operational pause only: credentials/config remain durable, so the
    // bot reconnects on the next Host start unless it is explicitly deleted.
    return this.#withBotTransition(botId, async () => {
      this.#requireBot(botId);
      await this.#stopRuntime(botId);
      this.#botErrors.delete(botId);
      this.#touch();
      return this.status(botId);
    });
  }

  async deleteBot(botId) {
    this.#assertOpen();
    return this.#serializeConfig(() => this.#withBotTransition(botId, async () => {
        this.#requireBot(botId);
        await this.#deleteBot(botId);
        this.#touch();
        return this.status();
      }));
  }

  // Compatibility methods for the original one-bot browser contract.
  async reconnect() {
    const bot = this.#configStore.list()[0];
    return bot ? this.reconnectBot(bot.id) : this.status();
  }

  async disconnect() {
    const bot = this.#configStore.list()[0];
    return bot ? this.deleteBot(bot.id) : this.status();
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const record of this.#registrations.values()) {
      if (MUTABLE_REGISTRATION_STATES.has(record.manager.status().state)) {
        record.cancelled = true;
        record.manager.cancel();
      }
    }
    await this.#configTransition;
    await Promise.allSettled([...this.#botTransitions.values()]);
    await Promise.allSettled([...this.#runtimes.keys()].map((id) => this.#stopRuntime(id)));
  }

  #status({ registration, selectedBotId } = {}) {
    const bots = this.#configStore.list().map((config) => {
      const connection = connectionStatus(this.#runtimes.get(config.id));
      const connected = isConnected(connection);
      const error = this.#botErrors.get(config.id) ?? null;
      return {
        botId: config.id,
        phase: botPhase({ connected, error, connection }),
        connected,
        configured: true,
        bot: publicBot(config),
        connection,
        error,
      };
    });
    const registrationSnapshot = registration ? this.#registrationSnapshot(registration) : {
      state: 'idle', attempt: 0, updatedAt: Date.now(),
    };
    const registering = ACTIVE_REGISTRATION_STATES.has(registrationSnapshot.state);
    const connecting = registrationSnapshot.state === 'saving';
    const registrationOwnsProjection = Boolean(registration) && (registering || connecting);
    const selected = bots.find((bot) => bot.botId === selectedBotId)
      ?? (registrationOwnsProjection ? null : (bots[0] ?? null));
    const aggregateConnected = bots.some((bot) => bot.connected);
    let phase = selected?.phase ?? 'unconfigured';
    if (registering) phase = 'registering';
    else if (connecting) phase = 'connecting';
    else if (registrationSnapshot.state === 'error' && !selected) phase = 'error';
    return {
      schemaVersion: 2,
      revision: this.#revision,
      phase,
      connected: selected?.connected ?? false,
      configured: bots.length > 0,
      bot: selected?.bot ?? null,
      connection: selected?.connection ?? idleConnection(),
      error: selected?.error ?? registrationSnapshot.error ?? null,
      registration: registrationSnapshot,
      bots,
      totals: {
        configured: bots.length,
        connected: bots.filter((bot) => bot.connected).length,
      },
      anyConnected: aggregateConnected,
    };
  }

  #registrationSnapshot(record) {
    const snapshot = record.manager.status();
    return {
      ...snapshot,
      attempt: record.id,
      ...(record.botId ? { botId: record.botId } : {}),
    };
  }

  async #acceptCredentials(record, result) {
    if (record.cancelled) throw new Error('Registration was cancelled');
    const appId = result.client_id;
    const appSecret = result.client_secret;
    const ownerOpenId = result.user_info?.open_id;
    const domain = result.user_info?.tenant_brand === 'lark' ? 'lark' : 'feishu';
    if (!ownerOpenId) throw new Error('Feishu registration returned no owner open_id');

    const bot = await this.#verifyApp({ appId, appSecret, domain });
    if (record.cancelled) throw new Error('Registration was cancelled');
    const existing = this.#configStore.list().find((candidate) => candidate.appId === appId);
    const botId = existing?.id ?? this.#createBotId();
    if (typeof botId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(botId)
      || (!existing && this.#configStore.getBot(botId))) {
      throw new Error('Bot id generator returned an invalid or duplicate id');
    }
    const secretRef = existing?.secretRef ?? secretRefFor(botId);
    const previousOwnership = this.#botOwnership.get(botId);
    const previousSecret = await this.#credentials.resolve(secretRef).catch(() => undefined);
    await this.#credentials.set(secretRef, appSecret);
    let config;
    try {
      config = await this.#configStore.saveBot({
        ...existing,
        id: botId,
        appId,
        secretRef,
        ownerOpenIds: [...new Set([...(existing?.ownerOpenIds ?? []), ownerOpenId])],
        domain,
        botName: bot.name,
        botOpenId: bot.openId,
        activated: bot.activated,
        deletionPending: false,
        connectedAt: new Date().toISOString(),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      });
      record.botId = botId;
      record.createdNew = !existing;
      this.#botOwnership.set(botId, record.id);
    } catch (error) {
      try {
        await this.#restoreCredential(secretRef, previousSecret);
      } catch (restoreError) {
        throw new Error('Unable to restore the Feishu credential after a config failure.', {
          cause: restoreError,
        });
      }
      throw error;
    }

    if (record.cancelled) {
      if (record.createdNew) {
        await this.#withBotTransition(botId, () => this.#deleteBot(botId));
      } else {
        await this.#configStore.saveBot(existing);
        await this.#restoreCredential(secretRef, previousSecret);
        if (previousOwnership) this.#botOwnership.set(botId, previousOwnership);
        else this.#botOwnership.delete(botId);
      }
      throw new Error('Registration was cancelled');
    }
    let cancellationRolledBack = false;
    try {
      await this.#withBotTransition(botId, () => this.#startRuntime(config, appSecret));
      if (record.cancelled) {
        if (record.createdNew) {
          await this.#withBotTransition(botId, () => this.#deleteBot(botId));
        } else {
          await this.#configStore.saveBot(existing);
          await this.#restoreCredential(secretRef, previousSecret);
          if (previousOwnership) this.#botOwnership.set(botId, previousOwnership);
          else this.#botOwnership.delete(botId);
          if (previousSecret?.value && !existing.deletionPending) {
            await this.#withBotTransition(botId, () => this.#startRuntime(existing, previousSecret.value));
          } else {
            await this.#withBotTransition(botId, () => this.#stopRuntime(botId));
          }
        }
        cancellationRolledBack = true;
        throw new Error('Registration was cancelled');
      }
      this.#botErrors.delete(botId);
      this.#touch();
    } catch (error) {
      if (record.cancelled) {
        if (!cancellationRolledBack && record.createdNew && this.#configStore.getBot(botId)) {
          await this.#withBotTransition(botId, () => this.#deleteBot(botId));
        } else if (!cancellationRolledBack && existing) {
          await this.#configStore.saveBot(existing);
          await this.#restoreCredential(secretRef, previousSecret);
          if (previousOwnership) this.#botOwnership.set(botId, previousOwnership);
          else this.#botOwnership.delete(botId);
          if (!this.#closed && previousSecret?.value && !existing.deletionPending) {
            await this.#withBotTransition(botId, () => this.#startRuntime(existing, previousSecret.value));
          } else {
            await this.#withBotTransition(botId, () => this.#stopRuntime(botId));
          }
        }
        this.#touch();
        throw error;
      }
      if (existing && previousSecret?.value) {
        try {
          await this.#configStore.saveBot(existing);
          await this.#restoreCredential(secretRef, previousSecret);
          if (previousOwnership) this.#botOwnership.set(botId, previousOwnership);
          else this.#botOwnership.delete(botId);
          if (!existing.deletionPending) {
            await this.#withBotTransition(botId, () => this.#startRuntime(existing, previousSecret.value));
            this.#botErrors.delete(botId);
          } else {
            await this.#withBotTransition(botId, () => this.#stopRuntime(botId));
            this.#botErrors.set(botId, {
              code: 'deletion_pending',
              message: '机器人正在等待完成本地删除，请重试移除。',
            });
          }
          this.#touch();
          throw error;
        } catch (restoreError) {
          if (restoreError === error) throw error;
          this.#botErrors.set(botId, {
            code: 'connection_failed',
            message: '机器人连接更新失败，且原连接无法恢复，请重试。',
          });
          this.#touch();
          throw new Error('Unable to restore the previous Feishu bot connection.', {
            cause: restoreError,
          });
        }
      }
      this.#botErrors.set(botId, {
        code: 'connection_failed',
        message: '机器人已经创建，但长连接未就绪，请点击重试。',
      });
      this.#touch();
      throw error;
    }
  }

  async #startRuntime(config, appSecret) {
    await this.#stopRuntime(config.id);
    const runtime = await this.#createRuntime({
      botId: config.id,
      config,
      appSecret,
    });
    this.#runtimes.set(config.id, runtime);
    try {
      await runtime.start();
    } catch (error) {
      if (this.#runtimes.get(config.id) === runtime) this.#runtimes.delete(config.id);
      await runtime.stop({ preserveError: true }).catch(() => undefined);
      throw error;
    }
  }

  async #stopRuntime(botId) {
    const runtime = this.#runtimes.get(botId);
    this.#runtimes.delete(botId);
    if (runtime) await runtime.stop();
  }

  async #deleteBot(botId) {
    let config = this.#configStore.getBot(botId);
    if (!config) return;
    if (!config.deletionPending) {
      config = await this.#configStore.saveBot({ ...config, deletionPending: true });
    }
    await this.#stopRuntime(botId);
    try {
      await this.#credentials.unset(config.secretRef);
    } catch (error) {
      this.#botErrors.set(botId, {
        code: 'credential_removal_failed',
        message: '无法删除机器人凭据，请稍后重试。',
      });
      throw new Error('Unable to remove the Feishu credential.', { cause: error });
    }
    try {
      await this.#deleteState({ botId, config });
    } catch (error) {
      this.#botErrors.set(botId, {
        code: 'state_cleanup_failed',
        message: '无法删除机器人的本地会话数据，请稍后重试。',
      });
      throw new Error('Unable to remove the Feishu bot session state.', { cause: error });
    }
    await this.#configStore.removeBot(botId);
    this.#botErrors.delete(botId);
    this.#botOwnership.delete(botId);
  }

  async #restoreCredential(secretRef, previous) {
    if (previous?.value) await this.#credentials.set(secretRef, previous.value);
    else await this.#credentials.unset(secretRef);
  }

  #requireBot(botId) {
    const config = this.#configStore.getBot(botId);
    if (!config) throw new Error('Unknown Feishu bot');
    return config;
  }

  #assertOpen() {
    if (this.#closed) throw new Error('The Feishu controller is closed');
  }

  #serializeConfig(operation) {
    const result = this.#configTransition.then(operation, operation);
    this.#configTransition = result.then(() => undefined, () => undefined);
    return result;
  }

  #withBotTransition(botId, operation) {
    const previous = this.#botTransitions.get(botId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.#botTransitions.set(botId, tail);
    void tail.finally(() => {
      if (this.#botTransitions.get(botId) === tail) this.#botTransitions.delete(botId);
    });
    return result;
  }

  #trimRegistrations() {
    if (this.#registrations.size <= 32) return;
    for (const [id, record] of this.#registrations) {
      if (id === this.#latestRegistrationId) continue;
      const state = record.manager.status().state;
      if (!ACTIVE_REGISTRATION_STATES.has(state) && state !== 'saving') {
        this.#registrations.delete(id);
      }
      if (this.#registrations.size <= 32) break;
    }
  }

  #touch() {
    this.#revision += 1;
  }
}
