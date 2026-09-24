import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { QqStateStore } from '../../../src/channels/qq/state-store.mjs';

const EMPTY = { version: 1, sessions: {}, seenMessageIds: [] };

async function fixture(t, bytes) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'dsh-qq-state-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  if (bytes !== undefined) await fs.writeFile(path, bytes);
  const warnings = [];
  const store = new QqStateStore(path, { logger: { warn: (...args) => warnings.push(args) } });
  return { path, directory, store, warnings };
}

test('QQ loads normal conversation and deferred state without rewriting it', async (t) => {
  const state = {
    ...EMPTY, sessions: { user: 'session-1' }, seenMessageIds: ['message-1'],
    includeArchivedSessions: true,
    deferred: { user: [{ id: 'delivery-1', key: 'user', sessionId: 'session-1', status: 'pending', text: 'pending reply' }] },
  };
  const bytes = JSON.stringify(state);
  const f = await fixture(t, bytes);
  assert.equal(await f.store.load(), f.store);
  assert.deepEqual(f.store.snapshot(), state);
  assert.equal(await fs.readFile(f.path, 'utf8'), bytes);
  assert.deepEqual(await fs.readdir(f.directory), ['state.json']);
  assert.equal(f.warnings.length, 0);
});

test('QQ creates a missing state file', async (t) => {
  const f = await fixture(t);
  await f.store.load();
  assert.deepEqual(JSON.parse(await fs.readFile(f.path, 'utf8')), EMPTY);
  assert.equal(f.warnings.length, 0);
});

for (const [name, bytes] of [
  ['449 zero bytes', Buffer.alloc(449)],
  ['empty file', Buffer.alloc(0)],
  ['truncated JSON', Buffer.from('{"sessions":{"private-user":')],
  ['invalid UTF-8', Buffer.from([0xff, 0xfe, 0x00])],
]) {
  test(`QQ backs up and rebuilds ${name}, then loads normally`, async (t) => {
    const f = await fixture(t, bytes);
    await f.store.load();
    const backups = (await fs.readdir(f.directory)).filter(name => name.startsWith('state.json.corrupt-'));
    assert.equal(backups.length, 1);
    assert.deepEqual(await fs.readFile(join(f.directory, backups[0])), bytes);
    if (process.platform !== 'win32') assert.equal((await fs.stat(join(f.directory, backups[0]))).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await fs.readFile(f.path, 'utf8')), EMPTY);
    assert.equal(f.warnings.length, 1);
    assert.match(JSON.stringify(f.warnings), /state-recovered/);
    assert.doesNotMatch(JSON.stringify(f.warnings), /private-user/);
    await f.store.setSession('user', 'new-session');
    const reloaded = await new QqStateStore(f.path).load();
    assert.equal(reloaded.sessionFor('user'), 'new-session');
    assert.equal((await fs.readdir(f.directory)).filter(name => name.startsWith('state.json.corrupt-')).length, 1);
  });
}

test('QQ leaves the file untouched on a read failure', async (t) => {
  const bytes = Buffer.alloc(449);
  const f = await fixture(t, bytes);
  const cause = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const read = t.mock.method(fs, 'readFile', async () => { throw cause; });
  await assert.rejects(f.store.load(), error => error.code === 'state-read-failed' && error.cause === cause);
  read.mock.restore();
  assert.deepEqual(await fs.readFile(f.path), bytes);
  assert.deepEqual(await fs.readdir(f.directory), ['state.json']);
  await f.store.load();
  assert.deepEqual(JSON.parse(await fs.readFile(f.path, 'utf8')), EMPTY);
});

test('QQ stops recovery when backup fails and uses exclusive private backup writes', async (t) => {
  const bytes = Buffer.alloc(449);
  const f = await fixture(t, bytes);
  const cause = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  const writes = [];
  const write = t.mock.method(fs, 'writeFile', async (path, data, options) => {
    writes.push({ path, data, options });
    throw cause;
  });
  await assert.rejects(f.store.load(), error => error.code === 'state-backup-failed' && error.cause === cause);
  write.mock.restore();
  assert.equal(writes.length, 1);
  assert.match(writes[0].path, /state\.json\.corrupt-/);
  assert.equal(writes[0].options.flag, 'wx');
  assert.equal(writes[0].options.mode, 0o600);
  assert.deepEqual(writes[0].data, bytes);
  assert.deepEqual(await fs.readFile(f.path), bytes);
  assert.equal(f.warnings.length, 0);
});

for (const stage of ['writeFile', 'rename']) {
  test(`QQ retains original and backup when recovery ${stage} fails, then retries`, async (t) => {
    const bytes = Buffer.alloc(449);
    const f = await fixture(t, bytes);
    const cause = Object.assign(new Error('cannot persist'), { code: 'EACCES' });
    const original = fs[stage];
    const failure = t.mock.method(fs, stage, async (...args) => {
      if (args[0] === `${f.path}.tmp`) throw cause;
      return original(...args);
    });
    await assert.rejects(f.store.load(), error => error.code === 'state-write-failed' && error.cause === cause);
    failure.mock.restore();
    assert.deepEqual(await fs.readFile(f.path), bytes);
    const backups = (await fs.readdir(f.directory)).filter(name => name.startsWith('state.json.corrupt-'));
    assert.equal(backups.length, 1);
    assert.deepEqual(await fs.readFile(join(f.directory, backups[0])), bytes);
    assert.equal(f.warnings.length, 0);
    await f.store.load();
    assert.deepEqual(JSON.parse(await fs.readFile(f.path, 'utf8')), EMPTY);
    assert.deepEqual(await fs.readFile(join(f.directory, backups[0])), bytes);
  });
}

test('QQ classifies failure to create missing state as a write failure', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(`${f.path}.tmp`);
  await assert.rejects(f.store.load(), { code: 'state-write-failed' });
  await assert.rejects(fs.readFile(f.path), { code: 'ENOENT' });
});
