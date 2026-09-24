// Conversation session-timeout service. Owns the periodic sweeper that
// unbinds conversationKey→sessionId after an idle window, plus the activity
// tracker per user message and turn-end. Mirrors the lifecycle shape of
// ./inbound-ttl-service.mjs: start/reset/stop + unref'd interval timer +
// ctx.effect disposal.

import { realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { isAbsolute as pathIsAbsolute, relative, resolve } from 'node:path';

import {
  CONVERSATION_DIRECTORY_PREFIX,
  isConversationDirectoryPath,
} from '../../src/channels/shared/conversation-directory.mjs';
import { sweepInboundAttachments } from '../../src/channels/shared/inbound-file.mjs';

const DEFAULT_SCAN_INTERVAL_MS = 5 * 60_000;
// A tracked conversation is shielded while a turn may still be running so a
// long reply never gets its binding expired mid-turn. The buffer mirrors
// inbound-ttl-service's TRACKED_PROTECTION_MS philosophy: far above the
// default reply timeout, after which protection expires on its own.
const DEFAULT_REPLY_TIMEOUT_BUFFER_MS = 600_000 * 1.5;
// Activity is memory-only, so a restart starts every conversation untracked
// and this grace window rarely applies anymore. It still covers the residual
// case where an entry ages past the threshold between two scans and happens
// to be caught by the very first scan after (re)scheduling: give it one more
// cycle instead of unbinding on the opening sweep.
const COLD_START_GRACE_MS_MULTIPLIER = 1;

function settingsEnabled(settings) {
  return settings?.enabled === true;
}

function shortDiagnosticId(value) {
  if (typeof value !== 'string' || !value) return null;
  return value.length <= 12 ? value : `...${value.slice(-12)}`;
}

/**
 * Build a session-timeout service. The `stateStore` is the channel's
 * `ConversationStateStore`; `clearSession` is the unbinding action. The
 * optional `notify` and `cleanup` callbacks let the host plug in delivery
 * and file cleanup without coupling this module to them.
 *
 * @param {object} options Service dependencies.
 * @param {object} options.store `SessionTimeoutStore`.
 * @param {object} options.stateStore `ConversationStateStore`.
 * @param {object} [options.deliveryService] Optional delivery service for
 *   session-sync notifications when `settings.notify` is on.
 * @param {object} [options.logger] Logger; defaults to console.
 * @param {number} [options.intervalMs] Scan interval override.
 * @param {number} [options.replyTimeoutBufferMs] Running-turn protection
 *   window override.
 * @param {function():number} [options.now] Clock override for tests.
 */
export function createSessionTimeoutService({
  store,
  stateStore,
  deliveryService = null,
  logger = console,
  intervalMs = DEFAULT_SCAN_INTERVAL_MS,
  replyTimeoutBufferMs = DEFAULT_REPLY_TIMEOUT_BUFFER_MS,
  now = () => Date.now(),
} = {}) {
  if (!store || typeof store.getSettings !== 'function'
    || typeof store.track !== 'function' || typeof store.clearTracked !== 'function'
    || typeof store.listTracked !== 'function'
    || typeof store.setSettings !== 'function') {
    throw new TypeError(
      'createSessionTimeoutService requires a store exposing getSettings/track/clearTracked/listTracked/setSettings',
    );
  }
  if (!stateStore || typeof stateStore.sessionFor !== 'function'
    || typeof stateStore.clearSession !== 'function') {
    // The default state store is optional when channels register their own
    // state sources via registerStateSource(). With no store and no source
    // registered, expire() stays a no-op until a channel mounts.
    if (stateStore !== null && stateStore !== undefined) {
      throw new TypeError(
        'createSessionTimeoutService requires a stateStore exposing sessionFor/clearSession, or null',
      );
    }
  }
  let timer = null;
  let scannedOnce = false;
  let delivery = deliveryService;

  /**
   * Conversation-state sources. Each channel that wants session timeout
   * registers its per-bot state getter; the service consults every one of
   * them by botId when it needs to resolve/unbind a conversation binding.
   * This exists because every channel owns an independent ConversationStateStore.
   */
  const stateSources = new Map();
  let defaultStateStore = stateStore;

  function effectiveScanIntervalMs() {
    const settings = store.getSettings();
    const configured = Number(settings.scanIntervalMs);
    return Number.isFinite(configured) && configured > 0 ? configured : intervalMs;
  }

  function registerStateSource(name, { stateFor } = {}) {
    if (typeof name !== 'string' || !name) {
      throw new TypeError('state source name is required');
    }
    if (typeof stateFor !== 'function' && stateFor !== defaultStateStore) {
      throw new TypeError('state source stateFor must be a function');
    }
    stateSources.set(name, stateFor ?? defaultStateStore);
    return () => stateSources.delete(name);
  }

  /**
   * Workspace sources. Each channel registers its bot workspace store plus
   * the channel default workspace so the cleanup path can resolve a
   * conversation's recorded directory and the per-bot fallback workspace.
   * Indexed by channel name exactly like stateSources, and resolved by
   * the botId → channel lookup that resolveWorkspaceContextForBot performs.
   */
  const workspaceProviders = new Map();

  function registerWorkspaceProvider(name, {
    workspaces,
    defaultWorkspace,
    stateFor,
  } = {}) {
    if (typeof name !== 'string' || !name) {
      throw new TypeError('workspace provider name is required');
    }
    if (!workspaces || typeof workspaces.workspaceFor !== 'function'
      || typeof workspaces.sessionDirectoryFor !== 'function'
      || typeof workspaces.clearSessionDirectory !== 'function') {
      throw new TypeError(
        'workspace provider must expose workspaceFor/sessionDirectoryFor/clearSessionDirectory',
      );
    }
    if (typeof defaultWorkspace !== 'string' || !defaultWorkspace) {
      throw new TypeError('workspace provider defaultWorkspace is required');
    }
    workspaceProviders.set(name, { workspaces, defaultWorkspace, stateFor });
    return () => workspaceProviders.delete(name);
  }

  /**
   * Find the workspace context that owns a botId. Iterates registered
   * providers in registration order; the first whose `workspaces.has(botId)`
   * returns true wins. Falls back to the first provider (so a provider that
   * registered before bots loaded can still be used) and finally to null.
   */
  function resolveWorkspaceContextForBot(botId) {
    if (typeof botId !== 'string' || !botId) return null;
    if (workspaceProviders.size === 0) return null;
    for (const [name, { workspaces, defaultWorkspace }] of workspaceProviders.entries()) {
      try {
        if (typeof workspaces.has === 'function' ? workspaces.has(botId) : true) {
          return { name, workspaces, defaultWorkspace };
        }
      } catch {
        // continue with the next provider
      }
    }
    // No provider claimed the bot; use the first registered one so a
    // provider that mounted before its bots loaded still offers a default.
    const first = workspaceProviders.values().next().value;
    return first ?? null;
  }

  async function resolveStateStore(conversationKey, record) {
    if (stateSources.size === 0) return defaultStateStore;
    const botId = record?.botId;
    if (!botId) {
      // Unknown botId — fall back to the default store so the unbind at least
      // attempts the path the channel that mounted first established.
      return defaultStateStore;
    }
    // State sources are registered once per channel. Route through the
    // workspace provider that owns this bot before considering any fallback;
    // several channel stateFor(botId) functions can otherwise accept an
    // unknown bot and clear the wrong channel's state file.
    const workspaceContext = resolveWorkspaceContextForBot(botId);
    const ownedStateFor = workspaceContext?.name
      ? stateSources.get(workspaceContext.name)
      : null;
    if (ownedStateFor) {
      try {
        const storeInstance = await ownedStateFor(botId);
        if (storeInstance && typeof storeInstance.sessionFor === 'function'
          && typeof storeInstance.clearSession === 'function') {
          return storeInstance;
        }
      } catch (error) {
        logger.warn?.('[dsh-im] session timeout owned state source lookup failed', error);
      }
      return defaultStateStore;
    }
    // Iterate over registered sources; the first that owns the bot wins.
    for (const stateFor of stateSources.values()) {
      if (stateFor === defaultStateStore) continue;
      try {
        const storeInstance = await stateFor(botId);
        if (storeInstance && typeof storeInstance.sessionFor === 'function'
          && typeof storeInstance.clearSession === 'function') {
          return storeInstance;
        }
        if (storeInstance) {
          // stateFor may answer null when the bot has no file-backed state yet;
          // try the next source.
          continue;
        }
      } catch (error) {
        logger.warn?.('[dsh-im] session timeout state source lookup failed', error);
      }
    }
    return defaultStateStore;
  }

  async function resolveSessionId(conversationKey, record) {
    // Cheap path first: if the persistent record captured a sessionId, use it.
    if (record?.sessionId) return record.sessionId;
    const storeInstance = await resolveStateStore(conversationKey, record);
    if (!storeInstance) return null;
    try {
      const live = storeInstance.sessionFor(conversationKey);
      if (typeof live === 'string' && live) return live;
    } catch (error) {
      logger.warn?.('[dsh-im] session timeout sessionFor failed', error);
    }
    return null;
  }

  /**
   * Record activity on a conversation. Fire-and-forget: any failure stays
   * in the log so messaging is unaffected. `runningSince` is only written
   * when supplied by the caller; callers just observed a turn start.
   */
  function touch(conversationKey, { botId, sessionId, runningSince, at = now() } = {}) {
    if (typeof conversationKey !== 'string' || !conversationKey) return;
    if (typeof botId !== 'string' || !botId) return;
    const settings = store.getSettings();
    if (!settingsEnabled(settings)) {
      logger.debug?.('[dsh-im] session timeout touch skipped: disabled', {
        botId: shortDiagnosticId(botId),
        sessionId: shortDiagnosticId(sessionId),
      });
      return;
    }
    logger.debug?.('[dsh-im] session timeout touch', {
      botId: shortDiagnosticId(botId),
      sessionId: shortDiagnosticId(sessionId),
      at,
      runningSince: Number.isFinite(runningSince) ? runningSince : undefined,
    });
    void store.track(conversationKey, { botId, sessionId, at, runningSince }).catch((error) => {
      logger.warn?.('[dsh-im] session timeout touch failed', error);
    });
  }

  /**
   * Resolve the conversationKey for a session across all bot state stores.
   * The host wires this in when the service is created so this module does
   * not need to enumerate conversation-state snapshots itself.
   *
   * @param {function(string): (Promise<string|null>|string|null)} resolver
   */
  let reverse = null;
  function setConversationKeyResolver(resolver) {
    if (typeof resolver !== 'function') {
      throw new TypeError('conversation-key resolver must be a function');
    }
    reverse = resolver;
  }

  /**
   * Default reverse: scan registered state sources by iterating the
   * delivery service's bot list and matching sessionId in any snapshot.
   * The host may override this with a cheaper resolver, but a built-in
   * default keeps touch wiring tractable across every channel.
   */
  async function defaultReverse(sessionId) {
    if (!sessionId) return null;
    if (!delivery || typeof delivery.listBots !== 'function') return null;
    let bots;
    try {
      bots = await delivery.listBots();
    } catch (error) {
      logger.warn?.('[dsh-im] session timeout listBots failed', error);
      return null;
    }
    for (const botId of Array.isArray(bots) ? bots : []) {
      const stateFor = dispatchForBot(botId);
      if (!stateFor) continue;
      try {
        const state = await stateFor(botId);
        const snapshot = state?.snapshot?.();
        const sessions = snapshot?.sessions;
        if (!sessions || typeof sessions !== 'object') continue;
        for (const [conversationKey, bound] of Object.entries(sessions)) {
          if (bound === sessionId) return conversationKey;
        }
      } catch {
        // continue with the next source
      }
    }
    return null;
  }

  function dispatchForBot(botId) {
    const workspaceContext = resolveWorkspaceContextForBot(botId);
    const ownedStateFor = workspaceContext?.name
      ? stateSources.get(workspaceContext.name)
      : null;
    if (ownedStateFor) return ownedStateFor;
    for (const stateFor of stateSources.values()) {
      if (stateFor === defaultStateStore) continue;
      return stateFor;
    }
    return defaultStateStore;
  }

  async function resolveConversationKeyForSession(sessionId) {
    if (!sessionId) return null;
    if (typeof reverse === 'function') {
      try {
        const resolved = await reverse(sessionId);
        if (typeof resolved === 'string' && resolved) return resolved;
      } catch (error) {
        logger.warn?.('[dsh-im] conversation-key resolver failed', error);
      }
    }
    return defaultReverse(sessionId);
  }

  /**
   * Touch a conversation by session id. Used by the file-ingress executor
   * (where only sessionId is known). The session is resolved to a
   * conversationKey via the reverse lookup, then the per-key activity
   * record is updated. Returns silently when no binding exists yet — the
   * next message that creates a real binding will start tracking from then.
   */
  async function touchBySessionId(sessionId, options = {}) {
    if (typeof sessionId !== 'string' || !sessionId) return;
    const settings = store.getSettings();
    if (!settingsEnabled(settings)) return;
    const conversationKey = await resolveConversationKeyForSession(sessionId);
    if (!conversationKey) return;
    // botId is already in the tracked record if we have one; otherwise infer
    // it from the delivery service's listTargets chain (the bind path
    // re-touch will fill it in). For now use whatever the existing record
    // has, and if we know the botId from options use it.
    const record = store.getTracked(conversationKey);
    const botId = options.botId ?? record?.botId;
    if (!botId) return;
    touch(conversationKey, {
      botId,
      sessionId,
      ...options,
    });
  }

  async function notify(conversationKey, sessionId, botId, settings) {
    if (!settingsEnabled(settings) || settings.notify !== true) return;
    if (!delivery || typeof delivery.listSessionSyncTargets !== 'function'
      || typeof delivery.sendSessionSyncText !== 'function') {
      return;
    }
    const text = settings.notifyText;
    if (typeof text !== 'string' || !text.trim()) return;
    let targets = [];
    try {
      targets = await delivery.listSessionSyncTargets(sessionId);
    } catch (error) {
      logger.warn?.('[dsh-im] session timeout target lookup failed', error);
      return;
    }
    if (!Array.isArray(targets) || targets.length === 0) {
      if (typeof delivery.sendToConversation === 'function') {
        try {
          await delivery.sendToConversation(botId, conversationKey, text);
          logger.info?.('[dsh-im] session timeout notification sent by conversation fallback', {
            botId,
            conversationKey,
            sessionId,
          });
        } catch (error) {
          logger.warn?.('[dsh-im] session timeout conversation notification failed', {
            botId,
            conversationKey,
            sessionId,
            code: error?.code ?? error?.name ?? 'unknown-error',
            message: error?.message,
          });
        }
      } else {
        logger.warn?.('[dsh-im] session timeout notification skipped: no targets or conversation fallback', {
          botId,
          conversationKey,
          sessionId,
        });
      }
      return;
    }
    await Promise.allSettled(targets.map((target) => {
      if (!target || typeof target.botId !== 'string' || !target.botId
        || typeof target.targetId !== 'string' || !target.targetId) {
        return Promise.resolve();
      }
      return delivery.sendSessionSyncText(
        target.botId,
        target.targetId,
        sessionId,
        text,
      ).catch((error) => {
        logger.warn?.(
          `[dsh-im] session timeout notification failed (${target.channel ?? 'unknown'})`,
          error,
        );
      });
    }));
  }

  /**
   * File cleanup for the optional `cleanupScope` tiers. The service only
   * reaches here when the settings document set the scope to something other
   * than `'none'`; the directory tier carries four safety checks so a
   * malformed or hostile path never widens into deleting the base workspace.
   *
   * The on-disk removal runs before `clearConversationSessionDirectory` so
   * a write failure leaves the documented "directory gone, record still
   * present" state, which the next sweeper catches and retries.
   *
   * Returns a short summary; never throws — a cleanup failure must not
   * block the unbinding.
   */
  async function cleanupFiles(conversationKey, record, settings) {
    const scope = settings?.cleanupScope;
    if (scope !== 'inbound' && scope !== 'directory') {
      return { scope, deleted: false, reason: 'skipped' };
    }
    const botId = record?.botId;
    const ctx = resolveWorkspaceContextForBot(botId);
    if (!ctx) {
      return { scope, deleted: false, reason: 'no-workspace-provider' };
    }
    const { workspaces, defaultWorkspace } = ctx;
    const directoryRecord = workspaces.sessionDirectoryFor(botId, conversationKey);
    const directory = directoryRecord?.directory ?? null;
    const base = directoryRecord?.base ?? defaultWorkspace;
    if (scope === 'inbound') {
      return cleanupInboundScope({ directory, base, defaultWorkspace });
    }
    return cleanupDirectoryScope({
      workspaces, botId, conversationKey, directory, base, defaultWorkspace,
    });
  }

  async function cleanupInboundScope({ directory, base, defaultWorkspace }) {
    let deleted = 0;
    // Sweep the base workspace's inbound subtree first; this covers the
    // common case where conversation directory isolation is off.
    try {
      const result = await sweepInboundAttachments(base, 0, {
        isTracked: () => false,
      });
      deleted += result.deleted;
    } catch (error) {
      logger.warn?.(
        `[dsh-im] session timeout inbound sweep failed under ${base}`,
        error,
      );
    }
    // If a conversation directory was recorded and differs from the base,
    // sweep its inbound subtree too — it holds the conversation's own staged
    // files under `.dsh-im/inbound/`.
    if (directory && directory !== base && directory !== defaultWorkspace) {
      try {
        const result = await sweepInboundAttachments(directory, 0, {
          isTracked: () => false,
        });
        deleted += result.deleted;
      } catch (error) {
        logger.warn?.(
          `[dsh-im] session timeout inbound sweep failed under ${directory}`,
          error,
        );
      }
    }
    return { scope: 'inbound', deleted, reason: deleted > 0 ? 'swept' : 'no-op' };
  }

  async function cleanupDirectoryScope({
    workspaces, botId, conversationKey, directory, base, defaultWorkspace,
  }) {
    if (!directory) {
      // No directory was ever recorded for this conversation; degrade to
      // the inbound tier silently so the caller still gets file cleanup.
      const fallback = await cleanupInboundScope({
        directory: null, base, defaultWorkspace,
      });
      return { ...fallback, scope: 'directory', reason: `${fallback.reason};no-directory` };
    }
    // Four safety checks. Any failure degrades to the inbound tier instead of
    // deleting — the base workspace root is never removed.
    let canonicalDirectory = null;
    let canonicalBase = null;
    try {
      canonicalDirectory = realpathSync(directory);
    } catch (error) {
      logger.warn?.(
        `[dsh-im] session timeout directory realpath failed: ${directory}`,
        error,
      );
      const fallback = await cleanupInboundScope({
        directory, base, defaultWorkspace,
      });
      return { ...fallback, scope: 'directory', reason: 'degraded:realpath-failed' };
    }
    try {
      canonicalBase = realpathSync(base);
    } catch {
      // Fall back to the unresolved base; we still have the path-shape check.
      canonicalBase = base;
    }
    // The is-base check runs before the path-shape check so a recorded
    // directory that happens to equal the base root fails for the safer
    // reason, without being skewed by the prefix test.
    if (directory === defaultWorkspace || canonicalDirectory === canonicalBase) {
      logger.warn?.(
        `[dsh-im] session timeout directory equals the base workspace; refusing to delete: ${directory}`,
      );
      const fallback = await cleanupInboundScope({
        directory, base, defaultWorkspace,
      });
      return { ...fallback, scope: 'directory', reason: 'degraded:is-base' };
    }
    if (!isConversationDirectoryPath(directory, { prefix: CONVERSATION_DIRECTORY_PREFIX })) {
      logger.warn?.(
        `[dsh-im] session timeout directory path-shape mismatch: ${directory}`,
      );
      const fallback = await cleanupInboundScope({
        directory, base, defaultWorkspace,
      });
      return { ...fallback, scope: 'directory', reason: 'degraded:path-shape' };
    }
    // Last segment must lie under the canonical base: compute relative path.
    const relativeUnder = relativePathUnder(canonicalBase, canonicalDirectory);
    if (relativeUnder === null || relativeUnder.startsWith('..') || pathIsAbsolute(relativeUnder)) {
      logger.warn?.(
        `[dsh-im] session timeout directory outside base; refusing to delete: ${directory}`,
      );
      const fallback = await cleanupInboundScope({
        directory, base, defaultWorkspace,
      });
      return { ...fallback, scope: 'directory', reason: 'degraded:outside-base' };
    }
    try {
      await rm(canonicalDirectory, { recursive: true, force: true });
    } catch (error) {
      logger.warn?.(
        `[dsh-im] session timeout directory removal failed: ${directory}`,
        error,
      );
      const fallback = await cleanupInboundScope({
        directory, base, defaultWorkspace,
      });
      return { ...fallback, scope: 'directory', reason: 'degraded:rm-failed' };
    }
    // Disk deleted successfully; now remove the recorded directory entry and,
    // if asked, the conversation-workspace override. A write failure here
    // leaves the documented "directory gone, record still present" state.
    let recordCleared = false;
    try {
      await workspaces.clearSessionDirectory(botId, conversationKey, {
        alsoClearWorkspaceOverride: false,
      });
      recordCleared = true;
    } catch (error) {
      logger.warn?.(
        `[dsh-im] session timeout clearSessionDirectory failed for ${conversationKey}`,
        error,
      );
    }
    return {
      scope: 'directory',
      deleted: true,
      reason: recordCleared ? 'removed' : 'removed-record-stale',
    };
  }

  /**
   * Compute the relative path of `target` under `base`, returning null when
   * `target` is not under `base`. Uses platform-relative path semantics via
   * node:path so Windows backslash separators do not falsely reject.
   */
  function relativePathUnder(base, target) {
    if (typeof base !== 'string' || typeof target !== 'string') return null;
    if (base === target) return '';
    const rel = relative(base, target);
    if (!rel || rel === '..') return null;
    if (pathIsAbsolute(rel) || rel.startsWith('..')) return null;
    return rel;
  }

  function isAbsolute(p) {
    return typeof p === 'string' && p.length > 0
      && (p.startsWith('/') || p.startsWith('\\')
        || (p.length >= 2 && p[1] === ':'));
  }

  /**
   * Expire one conversation. Order: resolve session → notify (optional) →
   * cleanup files (optional) → unbind (core) → clear activity. Notifications
   * and file cleanup never block the unbinding; if they fail only the core
   * unbind runs, which is the minimal safe behavior.
   */
  async function expire(conversationKey, { force = false } = {}) {
    if (typeof conversationKey !== 'string' || !conversationKey) return null;
    const settings = store.getSettings();
    if (!force && !settingsEnabled(settings)) return null;
    const record = store.getTracked(conversationKey);
    const sessionId = await resolveSessionId(conversationKey, record);
    if (sessionId && settings.notify === true && record?.botId) {
      await notify(conversationKey, sessionId, record.botId, settings).catch((error) => {
        logger.warn?.('[dsh-im] session timeout notification error', error);
      });
    }
    if (settings.cleanupScope && settings.cleanupScope !== 'none') {
      const cleanupSummary = await cleanupFiles(conversationKey, record, settings)
        .catch((error) => {
          logger.warn?.('[dsh-im] session timeout cleanup error', error);
          return { scope: settings.cleanupScope, deleted: false, reason: 'error' };
        });
      if (cleanupSummary?.deleted) {
        logger.info?.(
          `[dsh-im] session timeout cleanup removed files for ${conversationKey}`
          + ` (scope=${cleanupSummary.scope}, reason=${cleanupSummary.reason})`,
        );
      }
    }
    const storeInstance = await resolveStateStore(conversationKey, record);
    if (storeInstance && typeof storeInstance.clearSession === 'function') {
      await storeInstance.clearSession(conversationKey).catch((error) => {
        logger.warn?.('[dsh-im] session timeout clearSession failed', error);
      });
    }
    await store.clearTracked(conversationKey).catch((error) => {
      logger.warn?.('[dsh-im] session timeout clearTracked failed', error);
    });
    return { conversationKey, sessionId };
  }

  async function scanAndExpire() {
    const settings = store.getSettings();
    if (!settingsEnabled(settings)) {
      logger.debug?.('[dsh-im] session timeout scan skipped: disabled');
      return { expired: [], scanned: 0 };
    }
    const thresholdMs = settings.timeoutMinutes * 60_000;
    const nowMs = now();
    const tracked = store.listTracked();
    logger.debug?.('[dsh-im] session timeout scan started', {
      tracked: tracked.length,
      now: nowMs,
      thresholdMs,
      scanIntervalMs: effectiveScanIntervalMs(),
      scannedOnce,
    });
    let scanned = 0;
    const expired = [];
    for (const entry of tracked) {
      scanned += 1;
      const age = nowMs - entry.lastActivityAt;
      if (age < thresholdMs) continue;
      // Running-turn protection: if a turn started within the buffer, leave
      // the binding in place so the in-flight reply is never stranded.
      if (Number.isFinite(entry.runningSince)
        && nowMs - entry.runningSince < replyTimeoutBufferMs) {
        logger.debug?.('[dsh-im] session timeout scan skipped: running turn', {
          botId: shortDiagnosticId(entry.botId),
          sessionId: shortDiagnosticId(entry.sessionId),
          age,
          runningSince: entry.runningSince,
          protectionMs: replyTimeoutBufferMs,
        });
        continue;
      }
      // First-scan grace: the first scan after start() gives an entry that
      // aged past the threshold between two scans one more cycle instead of
      // being unbound by the very first sweep after (re)scheduling.
      if (!scannedOnce
        && age < thresholdMs + effectiveScanIntervalMs() * COLD_START_GRACE_MS_MULTIPLIER) {
        logger.debug?.('[dsh-im] session timeout scan skipped: cold-start grace', {
          botId: shortDiagnosticId(entry.botId),
          sessionId: shortDiagnosticId(entry.sessionId),
          age,
          graceMs: effectiveScanIntervalMs() * COLD_START_GRACE_MS_MULTIPLIER,
        });
        continue;
      }
      try {
        const result = await expire(entry.key, { force: false });
        if (result) {
          expired.push(result.conversationKey);
          logger.info?.(
            `[dsh-im] session ${result.sessionId ?? '(unknown)'} timed out for ${entry.key}; unbound`,
          );
        }
      } catch (error) {
        logger.warn?.(`[dsh-im] session timeout expire failed for ${entry.key}`, error);
      }
    }
    scannedOnce = true;
    logger.debug?.('[dsh-im] session timeout scan finished', {
      scanned,
      expired: expired.length,
    });
    return { expired, scanned };
  }

  function runScan() {
    scanAndExpire().catch((error) => {
      logger.error?.('[dsh-im] session timeout scan failed', error);
    });
  }

  function start() {
    if (timer) return;
    logger.info?.('[dsh-im] session timeout sweeper started', {
      intervalMs: effectiveScanIntervalMs(),
      timeoutMinutes: store.getSettings().timeoutMinutes,
    });
    runScan();
    timer = setInterval(runScan, effectiveScanIntervalMs());
    timer.unref?.();
  }

  function resetSchedule() {
    if (!timer) return;
    clearInterval(timer);
    timer = setInterval(runScan, effectiveScanIntervalMs());
    timer.unref?.();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    scannedOnce = false;
    logger.info?.('[dsh-im] session timeout sweeper stopped');
  }

  function attachDeliveryService(next) {
    delivery = next;
  }

  return Object.freeze({
    touch,
    touchBySessionId,
    expire,
    expireNow: (target) => (Array.isArray(target)
      ? Promise.all(target.map((k) => expire(k, { force: true })))
      : expire(target, { force: true })),
    scanAndExpire,
    start,
    resetSchedule,
    stop,
    get running() { return timer !== null; },
    attachDeliveryService,
    setConversationKeyResolver,
    resolveConversationKeyForSession,
    registerStateSource,
    registerWorkspaceProvider,
    cleanupFiles,
  });
}

/** Localizable default notify text, exposed for the store fallback. */
export const SESSION_TIMEOUT_NOTIFY_TEXT = '会话超时，已开启新会话；如需继续上一段，请使用 /history';

/** English rendering of the default notify text. */
export const SESSION_TIMEOUT_NOTIFY_TEXT_EN =
  'Session timed out; a new conversation has started. Use /history to continue the previous one.';
