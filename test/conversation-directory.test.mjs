import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { BotWorkspaceStore } from '../src/channels/shared/bot-workspace-store.mjs';
import { conversationDirectoryName } from '../src/channels/shared/conversation-directory-ensure.mjs';
import { validateConversationDirectory } from '../src/channels/shared/conversation-directory.mjs';

test('conversation directory names are stable, bounded, and distinguish sanitized keys', () => {
  const config = { enabled: true };
  const first = conversationDirectoryName('p2p:a:b', config);
  assert.equal(first, conversationDirectoryName('p2p:a:b', config));
  assert.notEqual(first, conversationDirectoryName('p2p:a-b', config));
  assert.notEqual(conversationDirectoryName('p2p:a:b', config, 0, 'channel:bot-one'),
    conversationDirectoryName('p2p:a:b', config, 0, 'channel:bot-two'));
  assert.ok(first.length <= 100);
  assert.ok(conversationDirectoryName('x'.repeat(200), config).length <= 100);
  assert.throws(() => validateConversationDirectory({ enabled: true, prefix: '../' }), {
    code: 'conversation-directory-invalid',
  });
});

test('conversation directory settings persist and new sessions follow the selected strategy', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-conversation-dir-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'workspaces.json');
  const store = await new BotWorkspaceStore(path, { defaultWorkspace: root }).load();
  await store.ensure('bot_one');
  await store.ensure('bot_two');
  await store.setConversationDirectory(null, { enabled: true });

  const first = await store.prepareConversationDirectory('bot_one', 'p2p:alice');
  const otherBot = await store.prepareConversationDirectory('bot_two', 'p2p:alice');
  assert.notEqual(first.workspace, otherBot.workspace);
  const otherChannel = await new BotWorkspaceStore(join(root, 'other-channel.json'), {
    defaultWorkspace: root,
  }).load();
  await otherChannel.ensure('bot_one');
  await otherChannel.setConversationDirectory(null, { enabled: true });
  assert.notEqual((await otherChannel.prepareConversationDirectory('bot_one', 'p2p:alice')).workspace,
    first.workspace);
  assert.equal(dirname(first.workspace), root);
  assert.equal((await stat(first.workspace)).isDirectory(), true);
  const repeated = await store.prepareConversationDirectory('bot_one', 'p2p:alice', { explicitNew: true });
  assert.equal(repeated.workspace, first.workspace);
  assert.equal(store.conversationWorkspaceFor('bot_one', 'p2p:alice'), first.workspace);
  await assert.rejects(store.setWorkspace('bot_one', root), { code: 'workspace-manual-edit-disabled' });

  await store.setConversationDirectory('bot_one', { enabled: true, strategy: 'per-session' });
  const next = await store.prepareConversationDirectory('bot_one', 'p2p:alice', { explicitNew: true });
  const later = await store.prepareConversationDirectory('bot_one', 'p2p:alice', { explicitNew: true });
  assert.notEqual(next.workspace, first.workspace);
  assert.notEqual(later.workspace, next.workspace);
  assert.deepEqual(new Set(store.conversationDirectoryPathsFor('bot_one')),
    new Set([first.workspace, next.workspace, later.workspace]));
  assert.equal(dirname(next.workspace), root);
  assert.equal(dirname(later.workspace), root);

  const reloaded = await new BotWorkspaceStore(path, { defaultWorkspace: root }).load();
  assert.equal(reloaded.conversationDirectoryFor('bot_one').strategy, 'per-session');
  assert.equal(reloaded.conversationWorkspaceFor('bot_one', 'p2p:alice'), later.workspace);
  assert.equal((await reloaded.prepareConversationDirectory('bot_one', 'p2p:alice')).workspace,
    later.workspace);
  assert.deepEqual(new Set(reloaded.conversationDirectoryPathsFor('bot_one')),
    new Set([first.workspace, next.workspace, later.workspace]));
});

test('group directories stay beside a generated private directory and repair nested records', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-group-dir-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'workspaces.json');
  const botId = 'bot_one';
  const privateKey = 'p2p:alice';
  const nestedKey = 'group:chat:managed:member';
  const freshKey = 'group:other:managed:member';
  const config = { enabled: true, strategy: 'per-conversation', prefix: 'feishu-' };
  const store = await new BotWorkspaceStore(path, { defaultWorkspace: root }).load();
  await store.ensure(botId);
  await store.setConversationDirectory(botId, config);
  const privateDirectory = (await store.prepareConversationDirectory(botId, privateKey)).workspace;
  await store.setConversationDirectory(botId, { ...config, prefix: 'new-prefix-' });
  const renamedPrivateDirectory = (await store.prepareConversationDirectory(botId, privateKey, {
    explicitNew: true,
  })).workspace;
  assert.notEqual(renamedPrivateDirectory, privateDirectory);
  await store.setConversationDirectory(botId, { enabled: false });
  await store.setWorkspace(botId, privateDirectory);
  await store.setConversationDirectory(botId, config);

  const nestedDirectory = join(privateDirectory, 'old-group-directory');
  await mkdir(nestedDirectory);
  const document = JSON.parse(await readFile(path, 'utf8'));
  document.sessionDirectories[botId][nestedKey] = {
    base: privateDirectory, workspace: nestedDirectory, ...config,
  };
  document.conversationWorkspaces[botId][nestedKey] = nestedDirectory;
  await writeFile(path, JSON.stringify(document));

  const reloaded = await new BotWorkspaceStore(path, { defaultWorkspace: root }).load();
  const fresh = await reloaded.prepareConversationDirectory(botId, freshKey);
  const repaired = await reloaded.prepareConversationDirectory(botId, nestedKey, { explicitNew: true });
  assert.equal(dirname(fresh.workspace), root);
  assert.equal(dirname(repaired.workspace), root);
  assert.notEqual(repaired.workspace, nestedDirectory);
  assert.equal((await stat(nestedDirectory)).isDirectory(), true);
  assert.ok(reloaded.conversationDirectoryPathsFor(botId).includes(nestedDirectory));
  assert.equal((await reloaded.prepareConversationDirectory(botId, nestedKey)).workspace, repaired.workspace);
});
