import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadWechatGroupConfig } from '../../../src/channels/weixin/wechat-group-config.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wechat-group-config-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const path = join(root, 'group-chats.json');
  return { root, path };
}

function validConfig(overrides = {}) {
  return {
    version: 1,
    pollIntervalMs: 750,
    groups: [{
      id: 'uia_group_one',
      title: '精确群名',
      commandPrefix: '/dsh',
      mentionMode: 'command',
      allowSelf: false,
    }],
    ...overrides,
  };
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value), 'utf8');
}

test('missing account config returns null without creating a file', async (t) => {
  const { path } = await fixture(t);
  assert.equal(await loadWechatGroupConfig(path), null);
});

test('valid config preserves IDs and defaults allowSelf to false', async (t) => {
  const { path } = await fixture(t);
  const value = validConfig();
  delete value.groups[0].allowSelf;
  await writeJson(path, value);
  const loaded = await loadWechatGroupConfig(path);
  assert.deepEqual(loaded, {
    pollIntervalMs: 750,
    // Root switches default to disabled so a fresh file never reads, sends,
    // or takes the screen away.
    allowUnverifiedRead: false,
    allowSend: false,
    allowWindowRestore: false,
    groups: [{
      id: 'uia_group_one',
      title: '精确群名',
      commandPrefix: '/dsh',
      mentionMode: 'command',
      allowSelf: false,
      // Absent in the file, normalized to false so the runtime consults one shape.
      allowUnverifiedTrigger: false,
    }],
  });
});

test('malformed JSON fails closed', async (t) => {
  const { path } = await fixture(t);
  await writeFile(path, '{"version":1,"groups":[', 'utf8');
  await assert.rejects(() => loadWechatGroupConfig(path));
});

test('wrong root, version, polling interval, and empty groups fail closed', async (t) => {
  const cases = [
    null,
    [],
    validConfig({ version: 2 }),
    validConfig({ pollIntervalMs: 0 }),
    validConfig({ pollIntervalMs: 1.5 }),
    validConfig({ pollIntervalMs: '750' }),
    validConfig({ groups: [] }),
    validConfig({ groups: {} }),
  ];
  for (const [index, value] of cases.entries()) {
    const { path } = await fixture(t);
    await writeJson(path, value);
    await assert.rejects(() => loadWechatGroupConfig(path), undefined, 'case ' + index);
  }
});

test('duplicate group id is rejected even when titles differ', async (t) => {
  const { path } = await fixture(t);
  const value = validConfig();
  value.groups.push({ ...value.groups[0], title: '另一个群' });
  await writeJson(path, value);
  await assert.rejects(() => loadWechatGroupConfig(path), /duplicate.*id/i);
});

test('duplicate exact UIA title is rejected even when IDs differ', async (t) => {
  const { path } = await fixture(t);
  const value = validConfig();
  value.groups.push({ ...value.groups[0], id: 'uia_group_two' });
  await writeJson(path, value);
  await assert.rejects(() => loadWechatGroupConfig(path), /duplicate.*title/i);
});

test('invalid IDs, titles, triggers, mention modes, and allowSelf fail closed', async (t) => {
  const groups = [
    { id: '' },
    { id: 'group-one' },
    { id: 'uia_bad id' },
    { title: '' },
    { title: ' 首尾空格 ' },
    { title: '换行\n群名' },
    { commandPrefix: '' },
    { commandPrefix: 'dsh' },
    { commandPrefix: '/dsh now' },
    { mentionMode: 'mention' },
    { mentionMode: '' },
    { allowSelf: 'false' },
    { allowUnverifiedTrigger: 'false' },
    { allowUnverifiedTrigger: 1 },
  ];
  for (const [index, patch] of groups.entries()) {
    const { path } = await fixture(t);
    const value = validConfig();
    Object.assign(value.groups[0], patch);
    await writeJson(path, value);
    await assert.rejects(() => loadWechatGroupConfig(path), undefined, 'case ' + index);
  }
});

test('allowUnverifiedTrigger is an explicit, typed, per-group opt-in', async (t) => {
  const { path } = await fixture(t);
  const value = validConfig();
  value.groups[0].allowUnverifiedTrigger = true;
  await writeJson(path, value);
  const loaded = await loadWechatGroupConfig(path);
  assert.equal(loaded.groups[0].allowUnverifiedTrigger, true);
  assert.equal(loaded.groups[0].id, 'uia_group_one');
});

test('unknown top-level and group keys fail closed instead of hiding typos', async (t) => {
  for (const [index, mutate] of [
    (value) => { value.pollInterval = 750; },
    (value) => { value.groups[0].prefix = '/dsh'; },
  ].entries()) {
    const { path } = await fixture(t);
    const value = validConfig();
    mutate(value);
    await writeJson(path, value);
    await assert.rejects(() => loadWechatGroupConfig(path), undefined, 'case ' + index);
  }
});
