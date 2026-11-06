import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runSessionNavCommand } from '../../../src/channels/shared/session-nav-command.mjs';

/**
 * The six channels that assemble their own state store used to have no session
 * ring at all: `/ls` answered "no sessions in this chat yet" while the binding
 * itself was written, because `workspace-session.mjs` calls
 * `state.ensureSessionRing?.()` optionally. The ring now comes from
 * `shared/session-ring-support.mjs`; this table is what proves each store really
 * got it, including that the ring survives a reload.
 */
const STORES = [
  { channel: 'weixin', module: '../../../src/channels/weixin/state-store.mjs', export: 'WeixinStateStore', key: 'p2p:o9cq@im.wechat' },
  { channel: 'wecom', module: '../../../src/channels/wecom/state-store.mjs', export: 'WecomStateStore', key: 'p2p:zhangsan' },
  { channel: 'wecom-app', module: '../../../src/channels/wecom-app/state-store.mjs', export: 'WecomAppStateStore', key: 'p2p:zhangsan' },
  { channel: 'feishu', module: '../../../src/channels/feishu/state-store.mjs', export: 'StateStore', key: 'p2p:ou_1' },
  { channel: 'qq', module: '../../../src/channels/qq/state-store.mjs', export: 'QqStateStore', key: 'c2c:openid-1' },
  { channel: 'dingtalk', module: '../../../src/channels/dingtalk/state-store.mjs', export: 'DingtalkStateStore', key: 'p2p:staff-1' },
];

const RING_METHODS = [
  'ringFor',
  'ensureSessionRing',
  'dropSessionRing',
  'dropSessionRingAllExcept',
  'renameSessionRing',
  'navigateRing',
  'stepRingTo',
  'appendRing',
  'markSessionRingUserTitled',
  'replaceSessionRing',
  'setPendingTitle',
  'takePendingTitle',
];

async function openStore(entry) {
  const directory = await mkdtemp(join(tmpdir(), `dsh-${entry.channel}-ring-`));
  const path = join(directory, 'state.json');
  const Store = (await import(entry.module))[entry.export];
  const store = await new Store(path).load();
  return { directory, path, Store, store };
}

for (const entry of STORES) {
  test(`${entry.channel} state store owns a session ring`, async (t) => {
    const { directory, path, Store, store } = await openStore(entry);
    t.after(() => rm(directory, { recursive: true, force: true }));

    for (const method of RING_METHODS) {
      assert.equal(typeof store[method], 'function', `${entry.channel} must expose ${method}`);
    }

    assert.equal(store.ringFor(entry.key), null, 'an untouched chat has no ring');

    // The symptom a person sees: /ls answered "no sessions in this chat yet"
    // while the binding was already written.
    const harness = {
      workspaceSession: () => ({
        async sessionExists() { return true; },
        readHistory: async () => ({ events: [], hasMore: false }),
      }),
      async isSessionArchived() { return false; },
    };
    const beforeBind = await runSessionNavCommand('/ls', harness, store, entry.key);


    const created = await store.ensureSessionRing(entry.key, 'session-1');
    assert.equal(created.created, true);
    assert.equal(created.entry.n, 1, 'the first session gets number 1');

    // This is the whole bug: the ring the navigation commands read was empty.
    const ring = store.ringFor(entry.key);
    assert.deepEqual(ring.entries.map((item) => [item.n, item.sessionId]), [[1, 'session-1']]);

    // /ls now shows that session instead of the empty answer it gave above.
    const listed = await runSessionNavCommand('/ls', harness, store, entry.key);
    assert.notEqual(listed.message, beforeBind.message, '/ls stops answering "no sessions"');
    assert.match(listed.message, /1\./, '/ls lists the bound session by number');

    // A second binding continues the numbering instead of starting over.
    const second = await store.ensureSessionRing(entry.key, 'session-2');
    assert.equal(second.entry.n, 2);

    // The ring is persisted in the channel's own file, so a restart keeps it.
    const reloaded = await new Store(path).load();
    assert.deepEqual(
      reloaded.ringFor(entry.key).entries.map((item) => [item.n, item.sessionId]),
      [[1, 'session-1'], [2, 'session-2']],
      'the ring survives a reload',
    );

    // Reads are clones: a caller cannot change the store by mutating the answer.
    const clone = reloaded.ringFor(entry.key);
    clone.entries.push({ n: 99, sessionId: 'session-99' });
    assert.equal(reloaded.ringFor(entry.key).entries.length, 2, 'ringFor hands out a clone');

    // Drops and renames are committed, not just applied in memory.
    assert.equal(await reloaded.dropSessionRing(entry.key, 1), true);
    const renamed = await reloaded.renameSessionRing(entry.key, 2, 'поговорим о физике');
    assert.equal(renamed.title, 'поговорим о физике');
    const afterEdits = await new Store(path).load();
    assert.deepEqual(
      afterEdits.ringFor(entry.key).entries.map((item) => [item.n, item.sessionId, item.title]),
      [[2, 'session-2', 'поговорим о физике']],
      'a drop and a rename reach the file',
    );

    // A title set before anything is bound has to outlive the restart too.
    await afterEdits.setPendingTitle(entry.key, 'черновик');
    const beforeTake = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(beforeTake.pendingTitles?.[entry.key], 'черновик', 'the pending title is written');
    const withPending = await new Store(path).load();
    assert.equal(await withPending.takePendingTitle(entry.key), 'черновик');
    assert.equal(await withPending.takePendingTitle(entry.key), null, 'taking it clears it');
  });

  test(`${entry.channel} keeps a state file written before the ring existed`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), `dsh-${entry.channel}-legacy-`));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.json');
    // The shape earlier versions wrote: no rings, no pendingTitles.
    await writeFile(path, JSON.stringify({ version: 1, sessions: { [entry.key]: 'session-old' }, seenMessageIds: [] }), 'utf8');

    const Store = (await import(entry.module))[entry.export];
    const store = await new Store(path).load();

    assert.equal(store.sessionFor(entry.key), 'session-old', 'the existing binding is untouched');
    assert.equal(store.ringFor(entry.key), null, 'no ring is invented out of nowhere');

    // The first binding after the upgrade starts the ring at 1 and writes both keys.
    await store.ensureSessionRing(entry.key, 'session-old');
    const file = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(file.rings?.[entry.key]?.entries?.map((item) => item.n), [1]);
    assert.equal(file.sessions[entry.key], 'session-old');
  });
}
