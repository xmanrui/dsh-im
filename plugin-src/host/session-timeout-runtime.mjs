// Per-process session-timeout runtime. Mirrors ./inbound-ttl-runtime.mjs:
// cached by the shared settings path (so the inbound-ttl store and this
// feature share one settings.json and one DocumentVersion), ctx.effect
// lifecycle, and lazy async load → start. Channels register their state
// sources when they mount, exactly like registerInboundTtlWorkspaces.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  DEFAULT_SESSION_TIMEOUT_SETTINGS,
  normalizeSessionTimeoutSettings,
} from '../../src/channels/shared/session-timeout.mjs';
import { SessionTimeoutStore } from '../../src/channels/shared/session-timeout-store.mjs';
import { createSessionTimeoutService } from './session-timeout-service.mjs';
import { inboundTtlSettingsPath } from './inbound-ttl-runtime.mjs';

const runtimes = new Map();

/**
 * Resolve the host-config defaults. Mirrors inbound ttl's resolution order
 * (config.dshHome → DSH_HOME → ~/.dsh) for the settings path itself.
 */
export function sessionTimeoutSettingsPath(config = {}) {
  return inboundTtlSettingsPath(config);
}

/**
 * Merge a host-side Cordis config with persisted store settings. The host
 * config acts as the startup default; an explicit host `false` on `enabled`
 * is a hard veto (the runtime stays disabled even if the store enabled it).
 * For everything else a stored value wins over an unset host default.
 */
export function mergeSessionTimeoutConfig(hostConfig = {}, storeSettings) {
  const enabled = hostConfig.sessionTimeoutEnabled === false
    ? false
    : storeSettings.enabled;
  const timeoutMinutes = storeSettings.timeoutMinutes
    ?? hostConfig.sessionTimeoutMinutes
    ?? DEFAULT_SESSION_TIMEOUT_SETTINGS.timeoutMinutes;
  const scanIntervalMs = storeSettings.scanIntervalMs
    ?? DEFAULT_SESSION_TIMEOUT_SETTINGS.scanIntervalMs;
  const cleanupScope = storeSettings.cleanupScope
    ?? hostConfig.sessionTimeoutCleanupScope
    ?? DEFAULT_SESSION_TIMEOUT_SETTINGS.cleanupScope;
  const notify = typeof storeSettings.notify === 'boolean'
    ? storeSettings.notify
    : DEFAULT_SESSION_TIMEOUT_SETTINGS.notify;
  const notifyText = storeSettings.notifyText
    ?? DEFAULT_SESSION_TIMEOUT_SETTINGS.notifyText;
  return Object.freeze({ enabled, timeoutMinutes, scanIntervalMs, cleanupScope, notify, notifyText });
}

/**
 * Get the process-wide session-timeout runtime, or build it from disk. The
 * caller's `ctx.effect` registers the sweeper teardown; channels share the
 * cached entry by its settings path exactly as inbound-ttl does.
 */
export function getSessionTimeoutRuntime(ctx, config = {}) {
  const settingsPath = sessionTimeoutSettingsPath(config);
  const existing = runtimes.get(settingsPath);
  if (existing) return existing.runtime;
  const logger = typeof ctx?.logger === 'function'
    ? ctx.logger('dsh-im:session-timeout') : (ctx?.logger ?? console);
  const store = new SessionTimeoutStore(settingsPath);
  const replyTimeoutMs = Number.isFinite(config.replyTimeoutMs)
    ? config.replyTimeoutMs
    : Number.isFinite(config.sessionTimeoutReplyTimeoutMs)
      ? config.sessionTimeoutReplyTimeoutMs
      : 600_000;
  const replyTimeoutBufferMs = (Number.isFinite(replyTimeoutMs) ? replyTimeoutMs : 600_000) * 1.5;
  // The service's default stateStore is null and channels register their
  // own state sources through registerSessionTimeoutStateSource().
  const service = createSessionTimeoutService({
    store,
    stateStore: null,
    deliveryService: null,
    logger,
    replyTimeoutBufferMs,
  });
  const runtime = Object.freeze({ store, service });
  const entry = { runtime };
  runtimes.set(settingsPath, entry);
  void store.load().then(
    () => {
      logger.info?.('[dsh-im] session timeout settings loaded', {
        settingsPath,
        fresh: store.wasFresh(),
        enabled: store.getSettings().enabled,
        timeoutMinutes: store.getSettings().timeoutMinutes,
        scanIntervalMs: store.getSettings().scanIntervalMs,
        cleanupScope: store.getSettings().cleanupScope,
      });
      // First-run seeding: when settings.json has no sessionTimeout sub-object
      // yet (file missing, or only inboundAttachmentTtlHours exists), apply
      // the host-config defaults as the initial persisted values. After this
      // seed, the store owns the running state — runtime RPC toggles persist
      // across restarts and host config only acts as a startup default.
      if (store.wasFresh()) {
        const seeded = mergeSessionTimeoutConfig(config, store.getSettings());
        if (config.sessionTimeoutEnabled === true
          || config.sessionTimeoutMinutes !== undefined
          || config.sessionTimeoutCleanupScope !== undefined) {
          void store.setSettings({
            enabled: config.sessionTimeoutEnabled === true
              || store.getSettings().enabled,
            ...(config.sessionTimeoutMinutes !== undefined
              ? { timeoutMinutes: config.sessionTimeoutMinutes } : {}),
            ...(config.sessionTimeoutCleanupScope !== undefined
              ? { cleanupScope: config.sessionTimeoutCleanupScope } : {}),
          }).catch((error) => {
            logger.error?.(
              '[dsh-im] unable to seed session timeout host-config defaults',
              error,
            );
            return null;
          }).then((seededSettings) => {
            if (!seededSettings) return;
            logger.info?.('[dsh-im] session timeout settings seeded', {
              enabled: seededSettings.enabled,
              timeoutMinutes: seededSettings.timeoutMinutes,
              cleanupScope: seededSettings.cleanupScope,
            });
            if (seededSettings.enabled) service.start();
          });
          return;
        }
        // No host config provided; nothing to seed. Treat the merged defaults
        // as the runtime intent (which is disabled unless set later).
        if (seeded.enabled) service.start();
        return;
      }
      // Subsequent boot: store values are authoritative; host config only
      // vetoes "enabled" with an explicit false.
      const merged = mergeSessionTimeoutConfig(config, store.getSettings());
      logger.info?.('[dsh-im] session timeout settings resolved', {
        enabled: merged.enabled,
        timeoutMinutes: merged.timeoutMinutes,
        scanIntervalMs: merged.scanIntervalMs,
        cleanupScope: merged.cleanupScope,
      });
      if (merged.enabled) service.start();
    },
    (error) => logger.error?.(
      '[dsh-im] unable to load session timeout settings; sweeping stays disabled',
      error,
    ),
  );
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => {
      if (runtimes.get(settingsPath) !== entry) return;
      runtimes.delete(settingsPath);
      service.stop();
    }, 'dsh-im: stop session timeout sweeper');
  }
  return runtime;
}

/**
 * Register one channel's conversation-state getter with the shared service.
 * The provider receives a botId and must return the matching ConversationStateStore
 * (or null for an unknown bot). Idempotent: re-registration replaces the prior
 * entry for the same channel name. Returns an unregister function.
 */
export function registerSessionTimeoutStateSource(ctx, service, {
  channel,
  stateFor,
} = {}) {
  if (!service || typeof service.registerStateSource !== 'function') return undefined;
  if (typeof channel !== 'string' || !channel) return undefined;
  if (typeof stateFor !== 'function') return undefined;
  const unregister = service.registerStateSource(channel, { stateFor });
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => unregister, `dsh-im: unregister session timeout state source for ${channel}`);
  }
  return unregister;
}

/**
 * Register one channel's bot workspace store with the shared service so the
 * optional file-cleanup tier can resolve a conversation's recorded directory
 * and the per-bot default workspace. Mirrors registerSessionTimeoutStateSource
 * exactly — channel name is the provider key so cleanup can route by botId.
 */
export function registerSessionTimeoutWorkspaceProvider(ctx, service, {
  channel,
  workspaces,
  defaultWorkspace,
  stateFor,
} = {}) {
  if (!service || typeof service.registerWorkspaceProvider !== 'function') return undefined;
  if (typeof channel !== 'string' || !channel) return undefined;
  if (!workspaces || typeof defaultWorkspace !== 'string' || !defaultWorkspace) return undefined;
  const unregister = service.registerWorkspaceProvider(channel, {
    workspaces,
    defaultWorkspace,
    ...(typeof stateFor === 'function' ? { stateFor } : {}),
  });
  if (typeof ctx?.effect === 'function') {
    ctx.effect(
      () => unregister,
      `dsh-im: unregister session timeout workspace provider for ${channel}`,
    );
  }
  return unregister;
}
