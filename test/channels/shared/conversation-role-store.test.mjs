import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ConversationRoleStore } from '../../../src/channels/shared/conversation-role-store.mjs';

async function freshStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-role-'));
  const path = join(dir, 'roles.json');
  const store = await new ConversationRoleStore(path).load();
  t.after(async () => {
    await store.remove().catch(() => {});
  });
  return { store, path };
}

test('ConversationRoleStore persists and reloads conversation overrides', async (t) => {
  const { store, path } = await freshStore(t);
  await store.setOverride('bot-a', 'group:123', 'project-developer');
  await store.setOverride('bot-a', 'group:999', 'code-reviewer');

  const reloaded = await new ConversationRoleStore(path).load();
  assert.equal(reloaded.overrideFor('bot-a', 'group:123'), 'project-developer');
  assert.equal(reloaded.overrideFor('bot-a', 'group:999'), 'code-reviewer');
  assert.equal(reloaded.overrideFor('bot-a', 'group:missing'), null);
});

test('ConversationRoleStore override is scoped per bot and per conversation', async (t) => {
  const { store } = await freshStore(t);
  await store.setOverride('bot-a', 'group:1', 'developer');
  await store.setOverride('bot-b', 'group:1', 'reviewer');
  assert.equal(store.overrideFor('bot-a', 'group:1'), 'developer');
  assert.equal(store.overrideFor('bot-b', 'group:1'), 'reviewer');
  assert.equal(store.overrideFor('bot-a', 'group:2'), null);
});

test('ConversationRoleStore clearOverride removes only that conversation', async (t) => {
  const { store } = await freshStore(t);
  await store.setOverride('bot-a', 'group:1', 'developer');
  await store.setOverride('bot-a', 'group:2', 'reviewer');
  await store.clearOverride('bot-a', 'group:1');
  assert.equal(store.overrideFor('bot-a', 'group:1'), null);
  assert.equal(store.overrideFor('bot-a', 'group:2'), 'reviewer');
});

test('ConversationRoleStore tracks role-scoped sessions separately', async (t) => {
  const { store } = await freshStore(t);
  await store.setRoleSession('bot-a', 'group:1', 'developer', 'session-dev');
  await store.setRoleSession('bot-a', 'group:1', 'reviewer', 'session-review');
  assert.equal(store.roleSessionFor('bot-a', 'group:1', 'developer'), 'session-dev');
  assert.equal(store.roleSessionFor('bot-a', 'group:1', 'reviewer'), 'session-review');
  assert.equal(store.roleSessionFor('bot-a', 'group:2', 'developer'), null);
  await store.clearRoleSession('bot-a', 'group:1', 'developer');
  assert.equal(store.roleSessionFor('bot-a', 'group:1', 'developer'), null);
});

test('ConversationRoleStore clearBot drops all role state for that bot only', async (t) => {
  const { store } = await freshStore(t);
  await store.setOverride('bot-a', 'group:1', 'developer');
  await store.setRoleSession('bot-a', 'group:1', 'developer', 's1');
  await store.setOverride('bot-b', 'group:1', 'reviewer');
  await store.clearBot('bot-a');
  assert.equal(store.overrideFor('bot-a', 'group:1'), null);
  assert.equal(store.roleSessionFor('bot-a', 'group:1', 'developer'), null);
  assert.equal(store.overrideFor('bot-b', 'group:1'), 'reviewer');
});

test('ConversationRoleStore survives a missing or empty file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-role-'));
  const path = join(dir, 'roles.json');
  const store = await new ConversationRoleStore(path).load();
  assert.equal(store.overrideFor('bot-a', 'group:1'), null);
  assert.equal(store.roleSessionFor('bot-a', 'group:1', 'developer'), null);
});

test('ConversationRoleStore rejects invalid preset ids and missing bots/conversations', async (t) => {
  const { store } = await freshStore(t);
  await assert.rejects(() => store.setOverride('bot-a', 'group:1', 'BAD PRESET'));
  assert.throws(() => store.overrideFor('bad bot!', 'group:1'));
  assert.throws(() => store.overrideFor('bot-a', ''));
});
