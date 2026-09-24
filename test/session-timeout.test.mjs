// Unit tests for the conversation session-timeout feature. Mirrors the
// structure of inbound-ttl.test.mjs: pure-function validation, durable
// store round-trips + damage fallback, and the service's expire flow
// (the MVP path: clearSession + clearTracked, plus notification/cleanup
// skipping when disabled).

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  CLEANUP_SCOPES,
  DEFAULT_SESSION_TIMEOUT_SETTINGS,
  MAX_TIMEOUT_MINUTES,
  MAX_SCAN_INTERVAL_MS,
  MIN_SCAN_INTERVAL_MS,
  MIN_TIMEOUT_MINUTES,
  normalizeSessionTimeoutSettings,
  validateSessionTimeoutField,
} from '../src/channels/shared/session-timeout.mjs';
import { SessionTimeoutStore } from '../src/channels/shared/session-timeout-store.mjs';
import { createSessionTimeoutService } from '../plugin-src/host/session-timeout-service.mjs';
import {
  SESSION_TIMEOUT_ENDPOINTS,
  createSessionTimeoutRpcHandler,
  validSessionTimeoutPayload,
} from '../plugin-src/host/session-timeout-rpc.mjs';

async function directory(t, prefix = 'dsh-im-session-timeout-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function memoryStore(overrides = {}) {
  let settings = { ...DEFAULT_SESSION_TIMEOUT_SETTINGS, ...overrides };
  const activity = new Map();
  return {
    getSettings: () => ({ ...settings }),
    async setSettings(patch) {
      const next = normalizeSessionTimeoutSettings({ ...settings, ...patch });
      settings = next;
      return { ...next };
    },
    getTracked: (key) => (activity.has(key) ? { ...activity.get(key) } : null),
    listTracked: () => [...activity.entries()].map(([key, record]) => ({ key, ...record })),
    async track(key, { botId, sessionId, at, runningSince } = {}) {
      const record = {
        botId, lastActivityAt: at, ...(sessionId ? { sessionId } : {}),
        ...(Number.isFinite(runningSince) ? { runningSince } : {}),
      };
      activity.set(key, record);
      return record;
    },
    async clearTracked(key) { activity.delete(key); },
  };
}

function memoryStateStore(sessions = new Map()) {
  return {
    sessionFor: (key) => sessions.get(key) ?? null,
    async setSession(key, id) { sessions.set(key, id); },
    async clearSession(key) { sessions.delete(key); },
    snapshot: () => ({ sessions: Object.fromEntries(sessions) }),
  };
}

test('normalizeSessionTimeoutSettings applies defaults to bad input and merges patches', () => {
  assert.deepEqual(normalizeSessionTimeoutSettings(null), DEFAULT_SESSION_TIMEOUT_SETTINGS);
  assert.deepEqual(normalizeSessionTimeoutSettings('nope'), DEFAULT_SESSION_TIMEOUT_SETTINGS);
  const merged = normalizeSessionTimeoutSettings({
    enabled: true,
    timeoutMinutes: 60,
    scanIntervalMs: 60_000,
    cleanupScope: 'inbound',
    notify: false,
    notifyText: 'bye',
  });
  assert.equal(merged.enabled, true);
  assert.equal(merged.timeoutMinutes, 60);
  assert.equal(merged.scanIntervalMs, 60_000);
  assert.equal(merged.cleanupScope, 'inbound');
  assert.equal(merged.notify, false);
  assert.equal(merged.notifyText, 'bye');
  // Invalid fields fall back to defaults while keeping the rest of the patch.
  const partial = normalizeSessionTimeoutSettings({
    enabled: true, timeoutMinutes: 0, cleanupScope: 'also everything',
  });
  assert.equal(partial.enabled, true);
  assert.equal(partial.timeoutMinutes, DEFAULT_SESSION_TIMEOUT_SETTINGS.timeoutMinutes);
  assert.equal(partial.cleanupScope, DEFAULT_SESSION_TIMEOUT_SETTINGS.cleanupScope);
});

test('validateSessionTimeoutField returns null for invalid payloads', () => {
  assert.equal(validateSessionTimeoutField('enabled', 'true'), null);
  assert.equal(validateSessionTimeoutField('enabled', true), true);
  assert.equal(validateSessionTimeoutField('timeoutMinutes', 0), null);
  assert.equal(validateSessionTimeoutField('timeoutMinutes', MIN_TIMEOUT_MINUTES), MIN_TIMEOUT_MINUTES);
  assert.equal(validateSessionTimeoutField('timeoutMinutes', MAX_TIMEOUT_MINUTES), MAX_TIMEOUT_MINUTES);
  assert.equal(validateSessionTimeoutField('scanIntervalMs', MIN_SCAN_INTERVAL_MS - 1), null);
  assert.equal(validateSessionTimeoutField('scanIntervalMs', MAX_SCAN_INTERVAL_MS + 1), null);
  assert.equal(validateSessionTimeoutField('cleanupScope', 'everywhere'), null);
  assert.deepEqual(CLEANUP_SCOPES, ['none', 'inbound', 'directory']);
  assert.equal(validateSessionTimeoutField('unknown', 'x'), null);
});

test('SessionTimeoutStore loads defaults, round-trips patches, and backs off on damage', async (t) => {
  const root = await directory(t, 'dsh-im-session-timeout-store-');
  const settingsPath = join(root, 'integrations', 'dsh-im', 'settings.json');

  const fresh = await new SessionTimeoutStore(settingsPath).load();
  assert.deepEqual(fresh.getSettings(), DEFAULT_SESSION_TIMEOUT_SETTINGS);
  assert.deepEqual(await readdir(root, { recursive: true }), []);

  await fresh.setSettings({ enabled: true, timeoutMinutes: 60 });
  const persisted = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.sessionTimeout.enabled, true);
  assert.equal(persisted.sessionTimeout.timeoutMinutes, 60);

  const reloaded = await new SessionTimeoutStore(settingsPath).load();
  assert.equal(reloaded.getSettings().enabled, true);
  assert.equal(reloaded.getSettings().timeoutMinutes, 60);

  // Damage fallback: an unreadable document falls back to disabled, never
  // enabled, so a corrupted intent cannot widen into session unbinding.
  await writeFile(settingsPath, 'definitely not json{{{', 'utf8');
  const corrupted = await new SessionTimeoutStore(settingsPath).load();
  assert.equal(corrupted.getSettings().enabled, false, 'damaged documents fall back to disabled');

  // Unknown version keeps the safe default too.
  await writeFile(settingsPath, JSON.stringify({ version: 2, sessionTimeout: { enabled: true } }), 'utf8');
  const future = await new SessionTimeoutStore(settingsPath).load();
  assert.equal(future.getSettings().enabled, false, 'unknown versions fall back to disabled');
});

test('SessionTimeoutStore keeps activity in memory and out of settings.json', async (t) => {
  const root = await directory(t, 'dsh-im-session-timeout-tracked-');
  const settingsPath = join(root, 'settings.json');
  const store = await new SessionTimeoutStore(settingsPath).load();
  await store.track('feishu:bot:openId', { botId: 'bot-1', sessionId: 'sess-1', at: 1_000 });
  assert.equal(store.getTracked('feishu:bot:openId')?.sessionId, 'sess-1');
  assert.equal(store.getTracked('feishu:bot:openId')?.lastActivityAt, 1_000);

  // Activity is runtime state: touching it must never write settings.json.
  await assert.rejects(readFile(settingsPath, 'utf8'), (error) => error.code === 'ENOENT');

  // A restart starts with an empty activity view — idle windows reset.
  const reloaded = await new SessionTimeoutStore(settingsPath).load();
  assert.equal(reloaded.getTracked('feishu:bot:openId'), null);
  await store.clearTracked('feishu:bot:openId');
  assert.equal(store.getTracked('feishu:bot:openId'), null);
});

test('SessionTimeoutStore drops a stale sessionActivity block on the next settings write', async (t) => {
  const root = await directory(t, 'dsh-im-session-timeout-stale-');
  const settingsPath = join(root, 'settings.json');
  // Written by an older version that persisted activity next to settings.
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({
    version: 1,
    sessionTimeout: { enabled: false, timeoutMinutes: 30 },
    sessionActivity: { 'feishu:bot:openId': { botId: 'bot-1', lastActivityAt: 1 } },
  }), 'utf8');

  const store = await new SessionTimeoutStore(settingsPath).load();
  assert.equal(store.getTracked('feishu:bot:openId'), null, 'stale activity is not rehydrated');
  await store.setSettings({ enabled: true });
  const persisted = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(persisted.sessionActivity, undefined, 'stale activity is dropped on rewrite');
});

test('createSessionTimeoutService expires an idle conversation by unbinding the session', async () => {
  const sessions = new Map([['feishu:bot:openId', 'sess-1']]);
  const stateStore = memoryStateStore(sessions);
  const store = memoryStore({ enabled: true, timeoutMinutes: 30 });
  const service = createSessionTimeoutService({
    store,
    stateStore,
    deliveryService: null,
    logger: { error: () => {}, warn: () => {}, info: () => {} },
    now: () => 31 * 60_000,
  });
  // Start the activity from time 0 and jump past the threshold.
  await store.track('feishu:bot:openId', {
    botId: 'bot-1', sessionId: 'sess-1', at: 0,
  });
  const result = await service.expire('feishu:bot:openId');
  assert.equal(result?.sessionId, 'sess-1');
  assert.equal(stateStore.sessionFor('feishu:bot:openId'), null, 'binding unbound');
  assert.equal(store.getTracked('feishu:bot:openId'), null, 'activity cleared');
});

test('createSessionTimeoutService clears the state store owned by the bot channel', async () => {
  const feishuSessions = new Map([['group:chat', 'feishu-session']]);
  const dingtalkSessions = new Map([['group:chat', 'dingtalk-session']]);
  const feishuState = memoryStateStore(feishuSessions);
  const dingtalkState = memoryStateStore(dingtalkSessions);
  const workspaceProvider = (botId) => ({
    has: (candidate) => candidate === botId,
    workspaceFor: () => 'C:/workspace',
    sessionDirectoryFor: () => null,
    clearSessionDirectory: async () => null,
  });
  const store = memoryStore({ enabled: true, timeoutMinutes: 1, notify: false });
  const service = createSessionTimeoutService({
    store,
    stateStore: null,
    deliveryService: null,
    logger: { error: () => {}, warn: () => {}, info: () => {} },
    now: () => 2 * 60_000,
  });
  service.registerStateSource('dingtalk', { stateFor: async () => dingtalkState });
  service.registerStateSource('feishu', { stateFor: async () => feishuState });
  service.registerWorkspaceProvider('dingtalk', {
    workspaces: workspaceProvider('dingtalk-bot'),
    defaultWorkspace: 'C:/workspace',
  });
  service.registerWorkspaceProvider('feishu', {
    workspaces: workspaceProvider('feishu-bot'),
    defaultWorkspace: 'C:/workspace',
  });
  await store.track('group:chat', {
    botId: 'feishu-bot', sessionId: 'feishu-session', at: 0,
  });

  await service.expire('group:chat');
  assert.equal(feishuState.sessionFor('group:chat'), null);
  assert.equal(dingtalkState.sessionFor('group:chat'), 'dingtalk-session');
});

test('createSessionTimeoutService never expires when disabled', async () => {
  const sessions = new Map([['feishu:bot:openId', 'sess-1']]);
  const stateStore = memoryStateStore(sessions);
  const store = memoryStore({ enabled: false });
  const service = createSessionTimeoutService({
    store,
    stateStore,
    deliveryService: null,
    logger: { error: () => {}, warn: () => {}, info: () => {} },
    now: () => 60 * 60_000,
  });
  await store.track('feishu:bot:openId', {
    botId: 'bot-1', sessionId: 'sess-1', at: 0,
  });
  const result = await service.expire('feishu:bot:openId');
  assert.equal(result, null);
  assert.equal(stateStore.sessionFor('feishu:bot:openId'), 'sess-1');
  assert.notEqual(store.getTracked('feishu:bot:openId'), null);
});

test('createSessionTimeoutService protects a running turn past the idle threshold', async () => {
  const sessions = new Map([['feishu:bot:openId', 'sess-1']]);
  const stateStore = memoryStateStore(sessions);
  const store = memoryStore({ enabled: true, timeoutMinutes: 1 });
  const service = createSessionTimeoutService({
    store,
    stateStore,
    deliveryService: null,
    logger: { error: () => {}, warn: () => {}, info: () => {} },
    now: () => 5 * 60_000, // well past the 1-minute threshold
    replyTimeoutBufferMs: 10 * 60_000,
  });
  // The activity timestamp is recent relative to the runningSince turn; the
  // running-turn protection must skip the expiry entirely.
  await store.track('feishu:bot:openId', {
    botId: 'bot-1', sessionId: 'sess-1', at: 4 * 60_000, runningSince: 4 * 60_000,
  });
  const summary = await service.scanAndExpire();
  assert.deepEqual(summary.expired, []);
  assert.equal(stateStore.sessionFor('feishu:bot:openId'), 'sess-1');
});

test('createSessionTimeoutService sends notifications when notify is on', async () => {
  const sent = [];
  const deliveryService = {
    listSessionSyncTargets: async () => [{ channel: 'feishu', botId: 'bot-1', targetId: 'openId' }],
    sendSessionSyncText: async (botId, targetId, sessionId, text) => {
      sent.push({ botId, targetId, sessionId, text });
    },
    listBots: async () => ['bot-1'],
  };
  const sessions = new Map([['feishu:bot:openId', 'sess-1']]);
  const stateStore = memoryStateStore(sessions);
  const store = memoryStore({
    enabled: true, timeoutMinutes: 5, notify: true,
    notifyText: '会话超时，已开启新会话',
  });
  const service = createSessionTimeoutService({
    store,
    stateStore,
    deliveryService,
    logger: { error: () => {}, warn: () => {}, info: () => {} },
    now: () => 10 * 60_000,
  });
  service.attachDeliveryService(deliveryService);
  await store.track('feishu:bot:openId', {
    botId: 'bot-1', sessionId: 'sess-1', at: 0,
  });
  await service.expire('feishu:bot:openId');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, '会话超时，已开启新会话');
});

test('createSessionTimeoutService scanAndExpire unbinds a stale binding', async () => {
  const sessions = new Map([
    ['feishu:bot:a', 'sess-a'],
    ['feishu:bot:b', 'sess-b'],
  ]);
  const stateStore = memoryStateStore(sessions);
  const store = memoryStore({ enabled: true, timeoutMinutes: 10 });
  await store.track('feishu:bot:a', { botId: 'bot-1', sessionId: 'sess-a', at: 0 });
  await store.track('feishu:bot:b', {
    botId: 'bot-1', sessionId: 'sess-b', at: 5 * 60_000,
  });
  const service = createSessionTimeoutService({
    store,
    stateStore,
    deliveryService: null,
    logger: { error: () => {}, warn: () => {}, info: () => {} },
    now: () => 15 * 60_000,
    replyTimeoutBufferMs: 30 * 60_000,
    intervalMs: 5 * 60_000,
  });
  const summary = await service.scanAndExpire();
  assert.deepEqual(summary.expired, ['feishu:bot:a']);
  assert.equal(stateStore.sessionFor('feishu:bot:a'), null);
  assert.equal(stateStore.sessionFor('feishu:bot:b'), 'sess-b');
});

test('validSessionTimeoutPayload validates each endpoint strictly', () => {
  assert.equal(validSessionTimeoutPayload(SESSION_TIMEOUT_ENDPOINTS.get, {}), true);
  assert.equal(validSessionTimeoutPayload(SESSION_TIMEOUT_ENDPOINTS.get, { extra: 1 }), false);
  assert.equal(validSessionTimeoutPayload(
    SESSION_TIMEOUT_ENDPOINTS.set, { enabled: true }), true);
  assert.equal(validSessionTimeoutPayload(
    SESSION_TIMEOUT_ENDPOINTS.set, { enabled: 'true' }), false);
  assert.equal(validSessionTimeoutPayload(
    SESSION_TIMEOUT_ENDPOINTS.set, { timeoutMinutes: 0 }), false);
  assert.equal(validSessionTimeoutPayload(
    SESSION_TIMEOUT_ENDPOINTS.set, { unknownField: 1 }), false);
  assert.equal(validSessionTimeoutPayload(
    SESSION_TIMEOUT_ENDPOINTS.expireNow, {}), true);
  assert.equal(validSessionTimeoutPayload(
    SESSION_TIMEOUT_ENDPOINTS.expireNow, { conversationKey: 'a' }), true);
  assert.equal(validSessionTimeoutPayload(
    SESSION_TIMEOUT_ENDPOINTS.expireNow, { conversationKey: 1 }), false);
  assert.equal(validSessionTimeoutPayload(
    SESSION_TIMEOUT_ENDPOINTS.expireNow, { conversationKeys: ['a', 'b'] }), true);
  assert.equal(validSessionTimeoutPayload(
    SESSION_TIMEOUT_ENDPOINTS.expireNow, { conversationKeys: ['a', ''] }), false);
  assert.equal(validSessionTimeoutPayload('unknown', {}), false);
});

test('createSessionTimeoutRpcHandler round-trips get/set/expire-now', async () => {
  const store = memoryStore({ enabled: false });
  let lastExpiredClearedKey = null;
  const sessions = new Map([['feishu:bot:openId', 'sess-1']]);
  const stateStore = memoryStateStore(sessions);
  const service = createSessionTimeoutService({
    store,
    stateStore,
    deliveryService: null,
    logger: { error: () => {}, warn: () => {}, info: () => {} },
    now: () => 0,
  });
  // Inject a real state source so expireNow resolves the binding.
  service.registerStateSource('test', { stateFor: async () => stateStore });
  await store.track('feishu:bot:openId', {
    botId: 'bot-1', sessionId: 'sess-1', at: 0,
  });
  const handler = createSessionTimeoutRpcHandler({
    store,
    service,
    logger: { info: () => {} },
  });

  const get = await handler(SESSION_TIMEOUT_ENDPOINTS.get, {});
  assert.equal(get.ok, true);
  assert.equal(get.value.enabled, false);

  const set = await handler(SESSION_TIMEOUT_ENDPOINTS.set, { enabled: true, timeoutMinutes: 60 });
  assert.equal(set.ok, true);
  assert.equal(set.value.enabled, true);
  assert.equal(set.value.timeoutMinutes, 60);

  const expire = await handler(SESSION_TIMEOUT_ENDPOINTS.expireNow, {
    conversationKey: 'feishu:bot:openId',
  });
  assert.equal(expire.ok, true);
  assert.equal(expire.value.expired.length, 1);
  lastExpiredClearedKey = expire.value.expired[0].conversationKey;
  assert.equal(lastExpiredClearedKey, 'feishu:bot:openId');
  assert.equal(stateStore.sessionFor('feishu:bot:openId'), null);
});
