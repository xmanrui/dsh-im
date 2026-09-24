// Unit tests for the optional file-cleanup tiers of session timeout.
// Covers `inbound` scope sweeping the inbound subtree, `directory` scope
// removing a recorded conversation directory plus the workspaces.json record,
// and the four safety checks that degrade to `inbound` instead of deleting
// the base workspace. The session-timeout core path (unbind the binding) is
// exercised alongside, invariants on session-timeout.test.mjs.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_SESSION_TIMEOUT_SETTINGS,
  normalizeSessionTimeoutSettings,
} from '../src/channels/shared/session-timeout.mjs';
import { SessionTimeoutStore } from '../src/channels/shared/session-timeout-store.mjs';
import { createSessionTimeoutService } from '../plugin-src/host/session-timeout-service.mjs';
import { BotWorkspaceStore } from '../src/channels/shared/bot-workspace-store.mjs';

async function directory(t, prefix = 'dsh-im-session-timeout-cleanup-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function inboundRoot(workspace) {
  return join(workspace, '.dsh-im', 'inbound');
}

async function stageInbound(workspace, name) {
  const path = join(inboundRoot(workspace), name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'payload.txt'), 'x');
  return path;
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
        botId,
        lastActivityAt: at,
        ...(sessionId ? { sessionId } : {}),
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

async function seedBotWorkspace(root, botId = 'bot-1') {
  const workspacesPath = resolve(root, 'workspaces.json');
  const store = await new BotWorkspaceStore(workspacesPath, {
    defaultWorkspace: root,
  }).load();
  await store.ensure(botId, {});
  return store;
}

/**
 * Apply a session directory using the same fence protocol as the proxy: a
 * fresh conversation-switch token before applyConversationSessionDirectory.
 */
async function recordConversationDirectory(workspaces, botId, conversationKey, {
  strategy, base, directory,
}) {
  const token = workspaces.publishConversationWorkspaceSwitch(botId, conversationKey);
  return workspaces.applyConversationSessionDirectory(botId, conversationKey, {
    strategy, base, directory,
  }, { token, clearSession: async () => {} });
}

test('cleanupFiles with scope=none is a no-op and never touches the filesystem', async () => {
  const store = memoryStore({ enabled: true, cleanupScope: 'none' });
  const service = createSessionTimeoutService({
    store,
    stateStore: null,
    deliveryService: null,
    logger: { error: () => {}, warn: () => {}, info: () => {} },
    now: () => 0,
  });
  const summary = await service.cleanupFiles('feishu:bot:openId', { botId: 'bot-1' }, store.getSettings());
  assert.equal(summary.deleted, false);
  assert.equal(summary.reason, 'skipped');
});

test('cleanupFiles with scope=inbound sweeps the base inbound subtree', async (t) => {
  const root = await directory(t);
  await stageInbound(root, '20260901-000000-aaaaaa');
  const workspaces = await seedBotWorkspace(root);
  const store = memoryStore({ enabled: true, cleanupScope: 'inbound' });
  const service = createSessionTimeoutService({
    store,
    stateStore: null,
    deliveryService: null,
    logger: { error: () => {}, warn: () => {}, info: () => {} },
    now: () => 0,
  });
  service.registerWorkspaceProvider('test', { workspaces, defaultWorkspace: root });
  const summary = await service.cleanupFiles(
    'feishu:bot:openId',
    { botId: 'bot-1' },
    store.getSettings(),
  );
  assert.equal(summary.scope, 'inbound');
  assert.equal(summary.deleted, 1);
  await assert.rejects(stat(join(inboundRoot(root), '20260901-000000-aaaaaa')), /ENOENT/);
});

test('cleanupFiles with scope=directory removes a recorded conversation directory and clears the workspaces.json record', async (t) => {
  const root = await directory(t);
  const workspaces = await seedBotWorkspace(root);
  // Mint a conversation directory under the base, then record it.
  const convDir = join(root, 'conv-feishu-bot-1-abc123');
  await mkdir(convDir, { recursive: true });
  await recordConversationDirectory(workspaces, 'bot-1', 'feishu:bot:openId', {
    strategy: 'per-conversation',
    base: root,
    directory: convDir,
  });
  assert.equal(workspaces.sessionDirectoryFor('bot-1', 'feishu:bot:openId')?.directory, convDir);

  const store = memoryStore({ enabled: true, cleanupScope: 'directory' });
  const service = createSessionTimeoutService({
    store,
    stateStore: null,
    deliveryService: null,
    logger: { error: () => {}, warn: () => {}, info: () => {} },
    now: () => 0,
  });
  service.registerWorkspaceProvider('test', { workspaces, defaultWorkspace: root });
  const summary = await service.cleanupFiles(
    'feishu:bot:openId',
    { botId: 'bot-1' },
    store.getSettings(),
  );
  assert.equal(summary.scope, 'directory');
  assert.equal(summary.deleted, true);
  assert.equal(summary.reason, 'removed');
  await assert.rejects(stat(convDir), /ENOENT/);
  assert.equal(workspaces.sessionDirectoryFor('bot-1', 'feishu:bot:openId'), null,
    'workspaces.json record cleared');
});

test('cleanupFiles with scope=directory degrades to inbound when the path-shape check fails', async (t) => {
  const root = await directory(t);
  const workspaces = await seedBotWorkspace(root);
  // Record a directory whose last segment does NOT carry the conv- prefix.
  const convDir = join(root, 'user-thing-not-minted');
  await mkdir(convDir, { recursive: true });
  await stageInbound(convDir, '20260901-000000-aaaaaa');
  await recordConversationDirectory(workspaces, 'bot-1', 'feishu:bot:openId', {
    strategy: 'per-conversation',
    base: root,
    directory: convDir,
  });

  const store = memoryStore({ enabled: true, cleanupScope: 'directory' });
  const service = createSessionTimeoutService({
    store,
    stateStore: null,
    deliveryService: null,
    logger: { error: () => {}, warn: () => {}, info: () => {} },
    now: () => 0,
  });
  service.registerWorkspaceProvider('test', { workspaces, defaultWorkspace: root });
  const summary = await service.cleanupFiles(
    'feishu:bot:openId',
    { botId: 'bot-1' },
    store.getSettings(),
  );
  // Path-shape check failed -> degrade to inbound: directory itself survives,
  // only its `.dsh-im/inbound/` subtree is gone.
  assert.equal(summary.scope, 'directory');
  assert.match(summary.reason, /degraded:path-shape/);
  assert.equal((await stat(convDir)).isDirectory(), true,
    'the malformed directory is NOT deleted');
  await assert.rejects(stat(join(inboundRoot(convDir), '20260901-000000-aaaaaa')), /ENOENT/);
  assert.notEqual(workspaces.sessionDirectoryFor('bot-1', 'feishu:bot:openId'), null,
    'workspaces.json record still present because removal was skipped');
});

test('cleanupFiles with scope=directory refuses to delete the base workspace root', async (t) => {
  const root = await directory(t);
  const workspaces = await seedBotWorkspace(root);
  // Pretend the conversation directory was somehow recorded as the base root.
  await recordConversationDirectory(workspaces, 'bot-1', 'feishu:bot:openId', {
    strategy: 'per-conversation',
    base: root,
    directory: root,
  });

  const store = memoryStore({ enabled: true, cleanupScope: 'directory' });
  const service = createSessionTimeoutService({
    store,
    stateStore: null,
    deliveryService: null,
    logger: { error: () => {}, warn: () => {}, info: () => {} },
    now: () => 0,
  });
  service.registerWorkspaceProvider('test', { workspaces, defaultWorkspace: root });
  const summary = await service.cleanupFiles(
    'feishu:bot:openId',
    { botId: 'bot-1' },
    store.getSettings(),
  );
  assert.match(summary.reason, /degraded:is-base/);
  // The root MUST survive this attempt.
  assert.equal((await stat(root)).isDirectory(), true);
});

test('BotWorkspaceStore.clearSessionDirectory removes both directory record and optional workspace override', async (t) => {
  const root = await directory(t);
  const workspaces = await seedBotWorkspace(root);
  const convDir = join(root, 'conv-feishu-bot-1-abc456');
  await mkdir(convDir, { recursive: true });
  await recordConversationDirectory(workspaces, 'bot-1', 'feishu:bot:openId', {
    strategy: 'per-conversation',
    base: root,
    directory: convDir,
  });
  assert.notEqual(workspaces.sessionDirectoryFor('bot-1', 'feishu:bot:openId'), null);
  const removed = await workspaces.clearSessionDirectory('bot-1', 'feishu:bot:openId', {
    alsoClearWorkspaceOverride: true,
  });
  assert.equal(removed.directory, convDir);
  assert.equal(workspaces.sessionDirectoryFor('bot-1', 'feishu:bot:openId'), null);
  // After clearing, the persisted file should no longer reference the directory.
  const document = JSON.parse(await readFile(resolve(root, 'workspaces.json'), 'utf8'));
  const remaining = document.sessionDirectories?.['bot-1']?.['feishu:bot:openId'];
  assert.equal(remaining, undefined);
});

test('BotWorkspaceStore.clearSessionDirectory is a no-op when nothing is recorded', async (t) => {
  const root = await directory(t);
  const workspaces = await seedBotWorkspace(root);
  const removed = await workspaces.clearSessionDirectory('bot-1', 'untracked:key', {
    alsoClearWorkspaceOverride: true,
  });
  assert.equal(removed, null);
});

test('expire runs cleanupFiles for cleanupScope=inbound before unbinding', async (t) => {
  const root = await directory(t);
  await stageInbound(root, '20260901-000000-bbbbbb');
  const workspaces = await seedBotWorkspace(root);
  const sessions = new Map([['feishu:bot:openId', 'sess-1']]);
  const stateStore = memoryStateStore(sessions);
  const store = memoryStore({
    enabled: true, timeoutMinutes: 30, cleanupScope: 'inbound', notify: false,
  });
  const service = createSessionTimeoutService({
    store,
    stateStore,
    deliveryService: null,
    logger: { error: () => {}, warn: () => {}, info: () => {} },
    now: () => 31 * 60_000,
  });
  service.registerStateSource('test', { stateFor: async () => stateStore });
  service.registerWorkspaceProvider('test', { workspaces, defaultWorkspace: root });
  await store.track('feishu:bot:openId', {
    botId: 'bot-1', sessionId: 'sess-1', at: 0,
  });
  const result = await service.expire('feishu:bot:openId');
  assert.equal(result?.sessionId, 'sess-1');
  assert.equal(stateStore.sessionFor('feishu:bot:openId'), null, 'binding unbound');
  await assert.rejects(stat(join(inboundRoot(root), '20260901-000000-bbbbbb')), /ENOENT/);
});
