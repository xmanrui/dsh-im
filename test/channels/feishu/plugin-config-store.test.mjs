import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PluginConfigStore } from '../../../src/channels/feishu/plugin-config-store.mjs';

test('PluginConfigStore persists non-secret onboarding facts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-config-'));
  const path = join(dir, 'nested', 'config.json');
  const store = await new PluginConfigStore(path).load();
  assert.equal(store.get(), null);

  await store.save({
    appId: 'cli_test',
    ownerOpenId: 'ou_owner',
    domain: 'feishu',
    botName: '北汇星河助手',
    appSecret: 'must-not-be-written',
  });

  const raw = await readFile(path, 'utf8');
  assert.doesNotMatch(raw, /must-not-be-written/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await new PluginConfigStore(path).load()).get().appId, 'cli_test');
  assert.equal(store.get().groupResponseMode, 'mention');
  assert.equal(store.get().groupMessagePermissionGranted, false);

  await store.save({
    ...store.get(),
    groupResponseMode: 'all',
    groupMessagePermissionGranted: true,
    groupTopicReply: true,
  });
  const reloaded = (await new PluginConfigStore(path).load()).get();
  assert.equal(reloaded.groupResponseMode, 'all');
  assert.equal(reloaded.groupMessagePermissionGranted, true);
  assert.equal(reloaded.groupTopicReply, true);

  await store.clear();
  assert.equal(store.get(), null);
});

test('PluginConfigStore defaults groupTopicReply off and only persists a literal true', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-config-topic-'));
  const path = join(dir, 'config.json');
  const store = await new PluginConfigStore(path).load();

  await store.save({
    appId: 'cli_topic',
    ownerOpenId: 'ou_owner',
    domain: 'feishu',
    groupTopicReply: 'yes', // must not be accepted as true
  });
  assert.equal(store.get().groupTopicReply, false);

  await store.save({ ...store.get(), groupTopicReply: true });
  assert.equal((await new PluginConfigStore(path).load()).get().groupTopicReply, true);

  await store.clear();
});

test('PluginConfigStore defaults stepPush off and only persists a literal true', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-config-step-push-'));
  const path = join(dir, 'config.json');
  const store = await new PluginConfigStore(path).load();

  await store.save({
    appId: 'cli_step_push',
    ownerOpenId: 'ou_owner',
    domain: 'feishu',
    stepPush: 'yes', // must not be accepted as true
  });
  assert.equal(store.get().stepPush, false);

  await store.save({ ...store.get(), stepPush: true });
  assert.equal((await new PluginConfigStore(path).load()).get().stepPush, true);

  await store.clear();
});

test('PluginConfigStore stays unconfigured after a failed write and can retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-config-retry-'));
  const blockedParent = join(dir, 'blocked');
  const path = join(blockedParent, 'config.json');
  const store = await new PluginConfigStore(path).load();
  await writeFile(blockedParent, 'not a directory');
  const value = { appId: 'cli_retry', ownerOpenId: 'ou_retry', domain: 'feishu' };

  await assert.rejects(store.save(value));
  assert.equal(store.get(), null);

  await unlink(blockedParent);
  await mkdir(blockedParent);
  await store.save(value);
  assert.equal(store.get().appId, 'cli_retry');
});

test('PluginConfigStore migrates a v1 bot atomically without moving its credential', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-config-migrate-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    version: 1,
    appId: 'cli_legacy',
    ownerOpenId: 'ou_legacy',
    domain: 'feishu',
    botName: '旧机器人',
  }));

  const store = await new PluginConfigStore(path).load();
  const migrated = JSON.parse(await readFile(path, 'utf8'));

  assert.equal(migrated.version, 2);
  assert.equal(migrated.bots.length, 1);
  assert.match(migrated.bots[0].id, /^bot_[a-f0-9]{24}$/);
  assert.equal(migrated.bots[0].secretRef, 'DSH_FEISHU_APP_SECRET');
  assert.deepEqual(migrated.bots[0].ownerOpenIds, ['ou_legacy']);
  assert.equal(store.get().ownerOpenId, 'ou_legacy');
  assert.equal(store.list()[0].appId, 'cli_legacy');
  assert.equal(store.list()[0].groupResponseMode, 'mention');
  assert.equal(store.list()[0].groupMessagePermissionGranted, false);
});

test('PluginConfigStore rejects an invalid or duplicate v2 document without dropping entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-config-invalid-v2-'));
  const invalidPath = join(dir, 'invalid.json');
  await writeFile(invalidPath, JSON.stringify({
    version: 2,
    bots: [
      {
        id: 'bot_good', appId: 'cli_good', secretRef: 'DSH_FEISHU_APP_SECRET_GOOD',
        ownerOpenIds: ['ou_good'], domain: 'feishu',
      },
      { id: '../bad', appId: 'cli_bad', secretRef: 'not-a-credential-ref', ownerOpenIds: ['ou_bad'] },
    ],
  }));
  await assert.rejects(new PluginConfigStore(invalidPath).load(), /invalid bot entry/);

  const duplicatePath = join(dir, 'duplicate.json');
  await writeFile(duplicatePath, JSON.stringify({
    version: 2,
    bots: [
      {
        id: 'bot_one', appId: 'cli_same', secretRef: 'DSH_FEISHU_APP_SECRET_ONE',
        ownerOpenIds: ['ou_one'], domain: 'feishu',
      },
      {
        id: 'bot_two', appId: 'cli_same', secretRef: 'DSH_FEISHU_APP_SECRET_TWO',
        ownerOpenIds: ['ou_two'], domain: 'feishu',
      },
    ],
  }));
  await assert.rejects(new PluginConfigStore(duplicatePath).load(), /duplicate bot identities/);
});
