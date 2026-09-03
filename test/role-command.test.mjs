import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  isRoleCommand,
  runRoleCommand,
} from '../src/channels/shared/role-command.mjs';
import { ConversationRoleStore } from '../src/channels/shared/conversation-role-store.mjs';

const CATALOG = Object.freeze({
  defaultId: 'standard',
  items: Object.freeze([
    Object.freeze({ id: 'standard', label: 'Standard' }),
    Object.freeze({ id: 'coding', label: 'Coding' }),
    Object.freeze({ id: 'reviewer', label: 'Reviewer' }),
  ]),
});

function fixture({ catalog = CATALOG, botId = 'bot-a' } = {}) {
  const calls = [];
  const harness = {
    async agentPresetSettings(options) {
      calls.push(['agentPresetSettings', options]);
      const currentCatalog = typeof catalog === 'function' ? catalog() : catalog;
      return { agentPreset: null, agentPresetCatalog: currentCatalog };
    },
  };
  return { calls, harness, botId };
}

async function freshStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rolecmd-'));
  const path = join(dir, 'roles.json');
  const store = await new ConversationRoleStore(path).load();
  t.after(() => store.remove().catch(() => {}));
  return store;
}

test('isRoleCommand recognizes /roles and /role prefixes', () => {
  for (const command of ['/roles', ' /ROLES ', '/role', '/role coding', ' /Role reviewer']) {
    assert.equal(isRoleCommand(command), true, command);
  }
  for (const value of [null, '', 'role', '/rolesx', '/roleing', '/roleup', 'hello /role']) {
    assert.equal(isRoleCommand(value), false, String(value));
  }
});

test('/roles lists catalog with current overrides and bot default', async (t) => {
  const store = await freshStore(t);
  const { harness, botId } = fixture();
  await store.setOverride(botId, 'group:1', 'coding');
  const out = await runRoleCommand('/roles', harness, {}, 'group:1', {
    roleStore: store, botId,
  });
  assert.match(out.message, /当前聊天角色：/);
  assert.match(out.message, /Coding（coding）/);
  assert.match(out.message, /可用角色/);
});

test('/role without args shows the current conversation role', async (t) => {
  const store = await freshStore(t);
  const { harness, botId } = fixture();
  await store.setOverride(botId, 'group:9', 'reviewer');
  const out = await runRoleCommand('/role', harness, {}, 'group:9', {
    roleStore: store, botId,
  });
  assert.match(out.message, /Reviewer（reviewer）/);
});

test('/role <id> selects a conversation-scoped role without changing bot default', async (t) => {
  const store = await freshStore(t);
  const { harness, botId } = fixture();
  const out = await runRoleCommand('/role coding', harness, {}, 'group:1', {
    roleStore: store, botId,
  });
  assert.match(out.message, /当前聊天角色已设置为/);
  assert.equal(store.overrideFor(botId, 'group:1'), 'coding');
  // Other conversation remains untouched.
  assert.equal(store.overrideFor(botId, 'group:2'), null);
});

test('/role scopes an override to the current conversation only', async (t) => {
  const store = await freshStore(t);
  const { harness, botId } = fixture();
  await runRoleCommand('/role reviewer', harness, {}, 'group:1', { roleStore: store, botId });
  await runRoleCommand('/role coding', harness, {}, 'group:2', { roleStore: store, botId });
  assert.equal(store.overrideFor(botId, 'group:1'), 'reviewer');
  assert.equal(store.overrideFor(botId, 'group:2'), 'coding');
});

test('/role --default clears the override and falls back to bot default', async (t) => {
  const store = await freshStore(t);
  const { harness, botId } = fixture();
  await store.setOverride(botId, 'group:1', 'coding');
  const out = await runRoleCommand('/role --default', harness, {}, 'group:1', {
    roleStore: store, botId,
  });
  assert.match(out.message, /已清除当前聊天角色/);
  assert.equal(store.overrideFor(botId, 'group:1'), null);
});

test('/role rejects an unavailable preset against the current catalog', async (t) => {
  const store = await freshStore(t);
  const { harness, botId } = fixture();
  const out = await runRoleCommand('/role does-not-exist', harness, {}, 'group:1', {
    roleStore: store, botId,
  });
  assert.match(out.message, /不存在或当前不可用/);
  assert.equal(store.overrideFor(botId, 'group:1'), null);
});

test('/role rejects images and missing role store gracefully', async (t) => {
  const store = await freshStore(t);
  const { harness, botId } = fixture();
  const img = await runRoleCommand('/role coding', harness, {}, 'group:1', {
    roleStore: store, botId, hasImages: true,
  });
  assert.match(img.message, /仅支持纯文字/);
  const noStore = await runRoleCommand('/role coding', harness, {}, 'group:1', { botId });
  assert.match(noStore.message, /未启用角色功能/);
});
