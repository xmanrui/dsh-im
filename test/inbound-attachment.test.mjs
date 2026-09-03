import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mock, test } from 'node:test';

import {
  deleteInboundAttachments,
  listInboundAttachments,
  normalizeInboundRetention,
  stageInboundFiles,
} from '../src/channels/shared/inbound-file.mjs';
import {
  isAttachmentCommand,
  runAttachmentCommand,
} from '../src/channels/shared/attachment-command.mjs';
import { runWorkspaceCommand } from '../src/channels/shared/workspace-command.mjs';
import {
  BotWorkspaceStore,
  createWorkspaceAwareController,
} from '../src/channels/shared/bot-workspace-store.mjs';
import { createDingtalkRpcHandler, DINGTALK_ENDPOINTS } from '../plugin-src/host/channels/dingtalk/rpc.mjs';
import { normalizeSnapshot } from '../plugin-src/client/channels/dingtalk/api.js';
import {
  validClearInboundAttachmentsPayload,
  validInboundRetentionPayload,
} from '../plugin-src/host/channels/shared/inbound-retention-rpc.mjs';

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-inbound-retention-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('normalizeInboundRetention accepts only known values', () => {
  assert.equal(normalizeInboundRetention(undefined), 'turn');
  assert.equal(normalizeInboundRetention('turn'), 'turn');
  assert.equal(normalizeInboundRetention('forever'), 'forever');
  assert.equal(normalizeInboundRetention('keep'), null);
});

test('forever retention keeps staged files and names batches by arrival time', async (t) => {
  const root = await workspace(t);
  const staged = await stageInboundFiles({
    files: [{ name: 'data.csv', data: Buffer.from('a,b\n1,2'), mediaType: 'text/csv' }],
  }, { workspace: root, retention: 'forever' });
  assert.equal(staged.retention, 'forever');
  const batch = staged.files[0].path.split(/[\\/]/)[2];
  assert.match(batch, /^\d{8}-\d{6}-[0-9a-f]{8}/);
  await staged.cleanup();
  await stat(resolve(root, staged.files[0].path));
  const attachments = await listInboundAttachments(root);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].temporary, false);
  assert.match(attachments[0].name, /data\.csv$/);
});

test('turn retention still auto-deletes and lists as leftover', async (t) => {
  const root = await workspace(t);
  const staged = await stageInboundFiles({
    files: [{ name: 'note.txt', data: Buffer.from('hi'), mediaType: 'text/plain' }],
  }, { workspace: root, retention: 'turn' });
  const batch = staged.files[0].path.split(/[\\/]/)[2];
  assert.ok(batch.startsWith('turn-'));
  const attachments = await listInboundAttachments(root);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].temporary, true);
  await staged.cleanup();
  await assert.rejects(stat(resolve(root, staged.files[0].path)), { code: 'ENOENT' });
});

test('deleteInboundAttachments removes targets inside the attachment root only', async (t) => {
  const root = await workspace(t);
  const staged = await stageInboundFiles({
    files: [{ name: 'a.txt', data: Buffer.from('a'), mediaType: 'text/plain' }],
  }, { workspace: root, retention: 'forever' });
  const outside = resolve(root, 'outside.txt');
  await writeFile(outside, 'keep me');
  await deleteInboundAttachments(root, [staged.files[0].path, 'outside.txt']);
  await assert.rejects(stat(resolve(root, staged.files[0].path)), { code: 'ENOENT' });
  await stat(outside);
});

test('deleteInboundAttachments all removes the attachment directory', async (t) => {
  const root = await workspace(t);
  await stageInboundFiles({
    files: [{ name: 'a.txt', data: Buffer.from('a'), mediaType: 'text/plain' }],
  }, { workspace: root, retention: 'forever' });
  await deleteInboundAttachments(root, 'all');
  assert.deepEqual(await listInboundAttachments(root), []);
});

function fakeHarness(workspace) {
  return { currentWorkspace: () => workspace };
}

test('attachment commands list, delete one, and clear-all with confirmation', async (t) => {
  const root = await workspace(t);
  const harness = fakeHarness(root);
  await stageInboundFiles({
    files: [{ name: '数据.csv', data: Buffer.from('1'), mediaType: 'text/csv' }],
  }, { workspace: root, retention: 'forever' });

  assert.equal(isAttachmentCommand('/attachmentlist'), true);
  assert.equal(isAttachmentCommand('/attachmentdelete 1'), true);
  assert.equal(isAttachmentCommand('/hello'), false);

  const listed = await runAttachmentCommand('/attachmentlist', harness);
  assert.match(listed.message, /数据\.csv/);
  assert.match(listed.message, /attachmentdelete/);

  const deleted = await runAttachmentCommand('/attachmentdelete 1', harness);
  assert.match(deleted.message, /数据\.csv/);
  assert.deepEqual(await listInboundAttachments(root), []);

  await stageInboundFiles({
    files: [{ name: 'b.txt', data: Buffer.from('b'), mediaType: 'text/plain' }],
  }, { workspace: root, retention: 'forever' });
  const guard = await runAttachmentCommand('/attachmentdelete all', harness);
  assert.match(guard.message, /confirm/);
  assert.equal((await listInboundAttachments(root)).length, 1);
  const cleared = await runAttachmentCommand('/attachmentdelete all confirm', harness);
  assert.ok(cleared.handled);
  assert.deepEqual(await listInboundAttachments(root), []);

  const missing = await runAttachmentCommand('/attachmentdelete 9', harness);
  assert.match(missing.message, /attachmentlist/);
});

test('attachment commands are reachable through runWorkspaceCommand', async (t) => {
  const root = await workspace(t);
  const result = await runWorkspaceCommand('/attachmentlist', fakeHarness(root), 'k');
  assert.ok(result?.handled);
});

test('rpc payload validators accept only well-formed payloads', () => {
  assert.equal(validInboundRetentionPayload({ botId: 'bot_1', retention: 'forever' }), true);
  assert.equal(validInboundRetentionPayload({ botId: 'bot_1', retention: 'turn' }), true);
  assert.equal(validInboundRetentionPayload({ botId: 'bot_1', retention: 'nope' }), false);
  assert.equal(validInboundRetentionPayload({ botId: 'bot 1', retention: 'turn' }), false);
  assert.equal(validClearInboundAttachmentsPayload({ botId: 'bot_1' }), true);
  assert.equal(validClearInboundAttachmentsPayload({ botId: 'bot_1', extra: 1 }), false);
});

test('direct /attachmentdelete all confirm without a pending clear is rejected', async (t) => {
  const root = await workspace(t);
  const harness = fakeHarness(root);
  await stageInboundFiles({
    files: [{ name: 'first.txt', data: Buffer.from('x'), mediaType: 'text/plain' }],
  }, { workspace: root, retention: 'forever' });

  const rejected = await runAttachmentCommand('/attachmentdelete all confirm', harness);
  assert.equal(rejected.handled, true);
  assert.match(rejected.message, /\/attachmentdelete all/);
  assert.equal((await listInboundAttachments(root)).length, 1);

  // The proper arm-then-confirm flow still clears after a stale confirm.
  await runAttachmentCommand('/attachmentdelete all', harness);
  const cleared = await runAttachmentCommand('/attachmentdelete all confirm', harness);
  assert.ok(cleared.handled);
  assert.deepEqual(await listInboundAttachments(root), []);
});

test('pending clear confirmation expires after the TTL', async (t) => {
  const root = await workspace(t);
  const harness = fakeHarness(root);
  await stageInboundFiles({
    files: [{ name: 'ttl.txt', data: Buffer.from('x'), mediaType: 'text/plain' }],
  }, { workspace: root, retention: 'forever' });

  mock.timers.enable({ now: Date.now() });
  t.after(() => mock.timers.reset());
  const guard = await runAttachmentCommand('/attachmentdelete all', harness);
  assert.match(guard.message, /confirm/);
  mock.timers.tick(61_000);
  const expired = await runAttachmentCommand('/attachmentdelete all confirm', harness);
  assert.equal(expired.handled, true);
  assert.match(expired.message, /\/attachmentdelete all/);
  assert.equal((await listInboundAttachments(root)).length, 1);
});

test('deleteInboundAttachments fails closed when the attachment root is a symlink outside the workspace', async (t) => {
  const root = await workspace(t);
  const external = await workspace(t);
  await writeFile(join(external, 'sentinel.txt'), 'keep me');
  await symlink(external, join(root, '.dsh-im'));
  const staged = await stageInboundFiles({
    files: [{ name: 'linked.txt', data: Buffer.from('x'), mediaType: 'text/plain' }],
  }, { workspace: root, retention: 'forever' });
  assert.equal((await listInboundAttachments(root)).length, 1);

  await assert.rejects(
    deleteInboundAttachments(root, 'all'),
    { code: 'inbound-file-root-outside-workspace' },
  );
  // The external directory and its sentinel must survive the blocked clear.
  await stat(join(external, 'sentinel.txt'));
  assert.equal((await listInboundAttachments(root)).length, 1);

  await assert.rejects(
    deleteInboundAttachments(root, [staged.files[0].path]),
    { code: 'inbound-file-root-outside-workspace' },
  );
  await stat(join(external, 'sentinel.txt'));
  assert.equal((await listInboundAttachments(root)).length, 1);
});

test('deleteInboundAttachments is idempotent when the attachment root is missing', async (t) => {
  const root = await workspace(t);
  assert.deepEqual(await deleteInboundAttachments(root, 'all'), { deleted: 'all' });
  assert.deepEqual(
    await deleteInboundAttachments(root, ['.dsh-im/inbound/none.txt']),
    { deleted: 0 },
  );
});

function fakeController(botIds) {
  const unavailable = () => { throw new Error('unrelated lifecycle action must not run'); };
  return {
    status: () => ({ bots: botIds.map((botId) => ({ botId, configured: true, connected: false })) }),
    startProvisioning: unavailable,
    registrationStatus: unavailable,
    submitVerification: unavailable,
    cancelProvisioning: unavailable,
    bindCredentials: unavailable,
    reconnectBot: unavailable,
    deleteBot: unavailable,
    startRegistration: unavailable,
    cancelRegistration: unavailable,
    disconnect: unavailable,
    setAccessPolicy: unavailable,
    approveSender: unavailable,
    revokeSender: unavailable,
  };
}

test('clearInboundAttachments RPC returns a snapshot the settings page can parse', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-clear-rpc-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new BotWorkspaceStore(join(directory, 'workspaces.json'), {
    defaultWorkspace: directory,
  }).load();
  const aware = createWorkspaceAwareController(fakeController(['bot_one']), {
    workspaces: store,
    stateFor: () => { throw new Error('must not load session state'); },
  });
  await stageInboundFiles({
    files: [{ name: 'rpc.txt', data: Buffer.from('x'), mediaType: 'text/plain' }],
  }, { workspace: directory, retention: 'forever' });
  assert.equal((await listInboundAttachments(directory)).length, 1);

  const handler = createDingtalkRpcHandler(aware);
  const result = await handler(DINGTALK_ENDPOINTS.clearInboundAttachments, { botId: 'bot_one' });
  assert.equal(result.ok, true);
  // Previously the RPC returned { cleared: true } and this parse threw.
  const snapshot = normalizeSnapshot(result.value);
  assert.equal(snapshot.bots[0].botId, 'bot_one');
  assert.deepEqual(await listInboundAttachments(directory), []);
});
