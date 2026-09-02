import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

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
