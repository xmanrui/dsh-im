import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { askInWorkspaceSession } from '../../../src/channels/shared/workspace-session.mjs';
import { ConversationRoleStore } from '../../../src/channels/shared/conversation-role-store.mjs';

function makeState() {
  const sessions = new Map();
  return {
    sessionFor: (key) => sessions.get(key) ?? null,
    async setSession(key, sessionId) {
      sessions.set(key, sessionId);
      return true;
    },
    async clearSession(key) {
      sessions.delete(key);
    },
    snapshot: () => Object.fromEntries(sessions),
  };
}

function makeHarness() {
  const created = [];
  return {
    created,
    async createSession(options = {}) {
      created.push({ options });
      return `session-${created.length}`;
    },
    workspaceSession(sessionId) {
      return {
        sessionId,
        async sessionExists() { return true; },
        async ask() { return 'ok'; },
      };
    },
  };
}

async function freshRoleStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wssession-'));
  const path = join(dir, 'roles.json');
  const store = await new ConversationRoleStore(path).load();
  t.after(() => store.remove().catch(() => {}));
  return store;
}

test('askInWorkspaceSession uses a role-scoped key and injects the role preset when overridden', async (t) => {
  const store = await freshRoleStore(t);
  await store.setOverride('bot-a', 'group:1', 'coding');
  const harness = makeHarness();
  const state = makeState();

  await askInWorkspaceSession({
    harness, state, key: 'group:1',
    text: 'do it', content: 'do it',
    createOptions: { signal: undefined },
    existsOptions: {},
    askOptions: {},
    roleStore: store, botId: 'bot-a',
  });

  assert.equal(harness.created.length, 1);
  assert.equal(harness.created[0].options.agentPreset, 'coding');
  // Session bound under the role-scoped key.
  assert.ok(state.snapshot()['group:1:coding']);
  // Role session persisted back into the store.
  assert.ok(store.roleSessionFor('bot-a', 'group:1', 'coding'));
});

test('askInWorkspaceSession keeps the plain key and bot default preset without an override', async (t) => {
  const store = await freshRoleStore(t);
  const harness = makeHarness();
  const state = makeState();

  await askInWorkspaceSession({
    harness, state, key: 'group:2',
    text: 'hi', content: 'hi',
    createOptions: {},
    existsOptions: {},
    askOptions: {},
    roleStore: store, botId: 'bot-a',
  });

  assert.equal(harness.created.length, 1);
  assert.equal(harness.created[0].options.agentPreset, undefined);
  assert.ok(state.snapshot()['group:2']);
  assert.equal(state.snapshot()['group:2:coding'], undefined);
});

test('askInWorkspaceSession reuses an existing role-scoped session instead of creating a new one', async (t) => {
  const store = await freshRoleStore(t);
  await store.setOverride('bot-a', 'group:1', 'coding');
  await store.setRoleSession('bot-a', 'group:1', 'coding', 'existing-role-session');
  const harness = makeHarness();
  const state = makeState();
  state.setSession('group:1:coding', 'existing-role-session');

  await askInWorkspaceSession({
    harness, state, key: 'group:1',
    text: 'again', content: 'again',
    createOptions: {},
    existsOptions: {},
    askOptions: {},
    roleStore: store, botId: 'bot-a',
  });

  assert.equal(harness.created.length, 0, 'should reuse the existing role session');
});

test('askInWorkspaceSession ignores roles when the store is absent', async (t) => {
  const harness = makeHarness();
  const state = makeState();
  await askInWorkspaceSession({
    harness, state, key: 'group:3',
    text: 'x', content: 'x',
    createOptions: {}, existsOptions: {}, askOptions: {},
  });
  assert.equal(harness.created.length, 1);
  assert.equal(harness.created[0].options.agentPreset, undefined);
});
