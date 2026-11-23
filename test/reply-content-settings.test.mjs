import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BotWorkspaceStore,
  createBotWorkspaceScope,
  createWorkspaceAwareController,
} from '../src/channels/shared/bot-workspace-store.mjs';
import { validReplyContentPayload } from '../plugin-src/host/channels/shared/reply-content-rpc.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-reply-content-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'default');
  await mkdir(workspace);
  return { root, workspace, path: join(root, 'workspaces.json') };
}

const fullTurn = { narration: true, tools: true, thinking: true };

test('reply content persists per bot, defaults to the full turn, and forgets the default', async (t) => {
  const { workspace, path } = await fixture(t);
  const store = new BotWorkspaceStore(path, { defaultWorkspace: workspace });
  await store.load();
  await store.ensure('bot_one');
  await store.ensure('bot_two');
  assert.deepEqual({ ...store.replyContentFor('bot_one') }, fullTurn);

  await store.setReplyContent('bot_one', { narration: false, tools: true, thinking: false });
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(saved.replyContents, {
    bot_one: { narration: false, tools: true, thinking: false },
  });

  const reloaded = new BotWorkspaceStore(path, { defaultWorkspace: workspace });
  await reloaded.load();
  assert.deepEqual({ ...reloaded.replyContentFor('bot_one') }, { narration: false, tools: true, thinking: false });
  assert.deepEqual({ ...reloaded.replyContentFor('bot_two') }, fullTurn, 'one bot never changes another');

  await reloaded.setReplyContent('bot_one', fullTurn);
  const cleaned = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(cleaned.replyContents, undefined, 'the all-on default leaves no record behind');
});

test('a damaged record falls back to the full turn and unknown bots are not stored', async (t) => {
  const { workspace, path } = await fixture(t);
  const store = new BotWorkspaceStore(path, { defaultWorkspace: workspace });
  await store.load();
  await store.ensure('bot_one');
  await writeFile(path, JSON.stringify({
    version: 5,
    workspaces: { bot_one: workspace },
    replyContents: { bot_one: { narration: 'no', thinking: false }, bot_gone: { tools: false } },
  }));
  const reloaded = new BotWorkspaceStore(path, { defaultWorkspace: workspace });
  await reloaded.load();
  assert.deepEqual({ ...reloaded.replyContentFor('bot_one') }, { narration: true, tools: true, thinking: false });
  assert.deepEqual({ ...reloaded.replyContentFor('bot_gone') }, fullTurn);
});

test('the scoped harness reports the bot switches and defaults outside its scope', async (t) => {
  const { workspace, path } = await fixture(t);
  const store = new BotWorkspaceStore(path, { defaultWorkspace: workspace });
  await store.load();
  await store.ensure('bot_one');
  await store.setReplyContent('bot_one', { narration: false, tools: true, thinking: true });
  const scope = createBotWorkspaceScope({}, { botId: 'bot_one', workspaces: store, state: {} });
  assert.deepEqual({ ...scope.harness.currentReplyContent() }, { narration: false, tools: true, thinking: true });
  const other = createBotWorkspaceScope({}, { botId: 'bot_one', workspaces: store, state: {} });
  await store.remove('bot_one');
  assert.deepEqual({ ...other.harness.currentReplyContent() }, fullTurn, 'a retired bot answers with the safe default');
});

test('the controller write path answers with the saved switches and rejects a partial set', async (t) => {
  const { workspace, path } = await fixture(t);
  const store = new BotWorkspaceStore(path, { defaultWorkspace: workspace });
  await store.load();
  await store.ensure('bot_one');
  const controller = createWorkspaceAwareController({
    status: async () => ({ bots: [{ botId: 'bot_one', connected: true }] }),
  }, { workspaces: store, stateFor: async () => ({}) });
  const status = await controller.updateReplyContent('bot_one', { narration: false, tools: false, thinking: true });
  assert.deepEqual(status.bots[0].replyContent, { narration: false, tools: false, thinking: true });
  assert.deepEqual({ ...store.replyContentFor('bot_one') }, { narration: false, tools: false, thinking: true });
  // The setter validates synchronously, like the other per-bot setters.
  assert.throws(
    () => controller.updateReplyContent('bot_one', { narration: false }),
    (error) => error.code === 'reply-content-invalid',
  );
});

test('the settings endpoint only accepts {botId, replyContent} with boolean switches', () => {
  assert.equal(validReplyContentPayload({ botId: 'bot_one', replyContent: { narration: true, tools: false, thinking: true } }), true);
  assert.equal(validReplyContentPayload({ botId: 'bot_one', replyContent: fullTurn, extra: 1 }), false);
  assert.equal(validReplyContentPayload({ botId: 'bot one', replyContent: fullTurn }), false);
  assert.equal(validReplyContentPayload({ botId: 'bot_one', replyContent: { narration: true } }), false);
  assert.equal(validReplyContentPayload({ botId: 'bot_one' }), false);
});
