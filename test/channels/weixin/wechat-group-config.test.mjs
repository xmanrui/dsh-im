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
    autoMinimize: false,
    groups: [{
      id: 'uia_group_one',
      title: '精确群名',
      commandPrefix: '/dsh',
      mentionMode: 'command',
      allowSelf: false,
      // Absent in the file, normalized to false so the runtime consults one shape.
      allowUnverifiedTrigger: false,
      // Same for triggerNames: an absent list normalizes to empty so the mention
      // matcher has one shape to read instead of distinguishing two cases.
      triggerNames: [],
      // Observation grants memory and no reply; absent means off, so a fresh file
      // never starts listening to the group's ambient chatter.
      observeAmbient: false,
    }],
  });
});


test('autoMinimize is accepted as a boolean and preserved', async (t) => {
  // The opt-in that lets the bridge stow WeChat itself. Without a config key
  // the only way to enable it is an environment variable, which needs a Host
  // restart; the whole point of the root switches is to avoid that.
  const { path } = await fixture(t);
  await writeJson(path, validConfig({ autoMinimize: true }));
  const loaded = await loadWechatGroupConfig(path);
  assert.equal(loaded.autoMinimize, true);
});

test('autoMinimize must be a boolean', async (t) => {
  for (const value of ['1', 1, null, {}]) {
    const { path } = await fixture(t);
    await writeJson(path, validConfig({ autoMinimize: value === null ? undefined : value }));
    if (value === null) {
      const loaded = await loadWechatGroupConfig(path);
      assert.equal(loaded.autoMinimize, false);
      continue;
    }
    await assert.rejects(() => loadWechatGroupConfig(path), (error) => error.code === 'invalid-group-config');
  }
});

test('mention modes are accepted and normalized', async (t) => {
  // The adapter honours a leading @[...] token when the operator asks for it,
  // so the config layer has to accept the mode rather than reject the file.
  for (const mode of ['mention', 'mention-or-command']) {
    const { path } = await fixture(t);
    await writeJson(path, validConfig({
      groups: [{
        id: 'uia_group_one', title: '精确群名', commandPrefix: '/dsh',
        mentionMode: mode, allowUnverifiedTrigger: true,
      }],
    }));
    const loaded = await loadWechatGroupConfig(path);
    assert.equal(loaded.groups[0].mentionMode, mode);
  }
});

test('a mode that can never fire is refused', async (t) => {
  // Measured: every group row is uia-unverified:row, so a mention mode with
  // neither the masked-token opt-in nor any trigger name is a config the
  // operator believes is live but that stays mute forever.
  for (const mode of ['mention', 'mention-or-command']) {
    const { path } = await fixture(t);
    await writeJson(path, validConfig({
      groups: [{
        id: 'uia_group_one', title: '精确群名', commandPrefix: '/dsh',
        mentionMode: mode, allowUnverifiedTrigger: false,
      }],
    }));
    await assert.rejects(() => loadWechatGroupConfig(path),
      (error) => error.code === 'invalid-group-config');
  }
});

test('triggerNames is accepted as a string array', async (t) => {
  // A readable mention name is a name match, not an identity claim, so it can
  // authorise a mention without the unverified opt-in. The Python side already
  // reads this key; rejecting it here would make the two validators disagree.
  const { path } = await fixture(t);
  await writeJson(path, validConfig({
    groups: [{
      id: 'uia_group_one', title: '精确群名', commandPrefix: '/dsh',
      mentionMode: 'mention', triggerNames: ['大肥鱼'],
    }],
  }));
  const loaded = await loadWechatGroupConfig(path);
  assert.deepEqual(loaded.groups[0].triggerNames, ['大肥鱼']);
});

test('unknown mention modes and malformed triggerNames still fail closed', async (t) => {
  const cases = [
    { mentionMode: 'mentions', allowUnverifiedTrigger: true },
    { mentionMode: 'COMMAND', allowUnverifiedTrigger: true },
    { mentionMode: 1, allowUnverifiedTrigger: true },
    { mentionMode: 'mention', allowUnverifiedTrigger: true, triggerNames: '大肥鱼' },
    { mentionMode: 'mention', allowUnverifiedTrigger: true, triggerNames: [7] },
  ];
  for (const patch of cases) {
    const { path } = await fixture(t);
    await writeJson(path, validConfig({
      groups: [{
        id: 'uia_group_one', title: '精确群名', commandPrefix: '/dsh', ...patch,
      }],
    }));
    await assert.rejects(() => loadWechatGroupConfig(path),
      (error) => error.code === 'invalid-group-config', JSON.stringify(patch));
  }
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

test('observeAmbient is an explicit, typed, per-group opt-in', async (t) => {
  // Observation is the one switch that makes the bot remember chatter it was
  // not addressed in. It must be as hard to turn on by accident as every other
  // permission: an explicit boolean, defaulting off.
  const { path } = await fixture(t);
  const value = validConfig();
  value.groups[0].observeAmbient = true;
  await writeJson(path, value);
  const loaded = await loadWechatGroupConfig(path);
  assert.equal(loaded.groups[0].observeAmbient, true);

  // A truthy string is not consent.
  const bogus = validConfig();
  bogus.groups[0].observeAmbient = 'false';
  await writeJson(path, bogus);
  await assert.rejects(() => loadWechatGroupConfig(path), /observeAmbient must be boolean/u);
});
