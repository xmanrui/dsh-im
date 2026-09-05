import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../../../src/channels/feishu/state-store.mjs';

test('StateStore persists sessions and dedupe ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-state-'));
  const path = join(dir, 'state.json');
  const first = await new StateStore(path).load();
  await first.setSession('group:one', 'session-one');
  await first.markSeen('message-one');

  const second = await new StateStore(path).load();
  assert.equal(second.sessionFor('group:one'), 'session-one');
  assert.equal(second.hasSeen('message-one'), true);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 1);
});

test('StateStore persists managed-topic roots (thread_id → root message)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-state-topics-'));
  const path = join(dir, 'state.json');
  const first = await new StateStore(path).load();
  assert.equal(first.topicRootFor('omt_missing'), null);
  await first.setTopic('omt_created', { rootMessageId: 'om_root', chatId: 'oc_group' });
  assert.deepEqual(first.topicRootFor('omt_created'), { rootMessageId: 'om_root', chatId: 'oc_group' });
  await first.setTopic('omt_second', { rootMessageId: 'om_root2', chatId: 'oc_group' });

  const second = await new StateStore(path).load();
  assert.deepEqual(second.topicRootFor('omt_created'), { rootMessageId: 'om_root', chatId: 'oc_group' });
  assert.deepEqual(second.topicRootFor('omt_second'), { rootMessageId: 'om_root2', chatId: 'oc_group' });
  assert.equal(second.topicRootFor('omt_missing'), null);
});

test('StateStore loads legacy documents without a topics field', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-state-legacy-'));
  const path = join(dir, 'state.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, JSON.stringify({ version: 1, sessions: {}, seenMessageIds: [], watches: {} }), 'utf8');
  const store = await new StateStore(path).load();
  assert.equal(store.topicRootFor('omt_anything'), null);
  await store.setTopic('omt_created', { rootMessageId: 'om_root', chatId: 'oc_group' });
  assert.deepEqual(store.topicRootFor('omt_created'), { rootMessageId: 'om_root', chatId: 'oc_group' });
});

test('separate bot StateStores isolate identical conversations and message ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-state-bots-'));
  const alpha = await new StateStore(join(dir, 'bot-alpha', 'state.json')).load();
  const beta = await new StateStore(join(dir, 'bot-beta', 'state.json')).load();

  await alpha.setSession('p2p:ou_same', 'session-alpha');
  await beta.setSession('p2p:ou_same', 'session-beta');
  await alpha.markSeen('om_same');

  assert.equal(alpha.sessionFor('p2p:ou_same'), 'session-alpha');
  assert.equal(beta.sessionFor('p2p:ou_same'), 'session-beta');
  assert.equal(alpha.hasSeen('om_same'), true);
  assert.equal(beta.hasSeen('om_same'), false);
});

test('StateStore persists deferred delivery entries (round-trip and filters)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-state-deferred-'));
  const path = join(dir, 'state.json');
  const store = await new StateStore(path).load();

  await store.putDeferred({
    id: 'k s1 3', key: 'k', chatId: 'oc', replyToMessageId: null, sessionId: 's1',
    turn: 3, afterSeq: 5, lastSeenEndSeq: -1, attempts: 0, status: 'pending', createdAt: 1,
  });
  await store.putDeferred({
    id: 'k s2 any', key: 'k', chatId: 'oc', replyToMessageId: null, sessionId: 's2',
    turn: null, afterSeq: -1, lastSeenEndSeq: -1, attempts: 0, status: 'pending', createdAt: 2,
  });

  assert.equal(store.deferredEntries().length, 2);

  const patched = await store.patchDeferred('k s1 3', { lastSeenEndSeq: 9 });
  assert.equal(patched.lastSeenEndSeq, 9);
  assert.equal(store.deferredEntries()[0].lastSeenEndSeq, 9);

  await store.removeDeferred('k s1 3');
  assert.deepEqual(store.deferredEntries().map((entry) => entry.sessionId), ['s2']);

  const reopened = await new StateStore(path).load();
  assert.deepEqual(reopened.deferredEntries().map((entry) => entry.id), ['k s2 any']);
});

test('StateStore rejects malformed deferred entries and unknown patches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-state-deferred-bad-'));
  const store = await new StateStore(join(dir, 'state.json')).load();
  await assert.rejects(() => store.putDeferred({ id: 'x', key: 'k' }), TypeError);
  assert.equal(await store.patchDeferred('missing id', { attempts: 1 }), null);
});

test('StateStore loads legacy documents without a deferred field', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-state-deferred-legacy-'));
  const path = join(dir, 'state.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, JSON.stringify({ version: 1, sessions: {}, seenMessageIds: [], watches: {} }), 'utf8');
  const store = await new StateStore(path).load();
  assert.deepEqual(store.deferredEntries(), []);
});
