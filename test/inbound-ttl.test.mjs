import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_INBOUND_TTL_HOURS,
  INBOUND_TTL_MAX_HOURS,
  normalizeInboundTtlHours,
} from '../src/channels/shared/inbound-ttl.mjs';
import { InboundTtlStore } from '../src/channels/shared/inbound-ttl-store.mjs';
import {
  InboundFileError,
  parseInboundDirectoryName,
  stageInboundFiles,
  sweepInboundAttachments,
} from '../src/channels/shared/inbound-file.mjs';
import { createInboundTtlService } from '../plugin-src/host/inbound-ttl-service.mjs';
import {
  INBOUND_TTL_ENDPOINTS,
  createInboundTtlRpcHandler,
  validInboundTtlPayload,
} from '../plugin-src/host/inbound-ttl-rpc.mjs';
import { createHarnessSessionExecutors } from '../plugin-src/host/harness-session-coordinator.mjs';

async function directory(t, prefix = 'dsh-im-inbound-ttl-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function memoryStore(ttlHours) {
  let value = ttlHours;
  return {
    getTtlHours: () => value,
    async setTtlHours(next) {
      const normalized = normalizeInboundTtlHours(next);
      if (normalized === null) {
        const error = new Error('Invalid inbound attachment TTL hours.');
        error.code = 'inbound-ttl-invalid';
        throw error;
      }
      value = normalized;
      return normalized;
    },
  };
}

function inboundRoot(workspace) {
  return join(workspace, '.dsh-im', 'inbound');
}

async function stageDirectory(workspace, name, content = 'x') {
  const path = join(inboundRoot(workspace), name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'payload.txt'), content);
  return path;
}

test('normalizeInboundTtlHours accepts -1, 0, and 1..8760 whole hours only', () => {
  assert.equal(DEFAULT_INBOUND_TTL_HOURS, 168);
  assert.equal(INBOUND_TTL_MAX_HOURS, 8760);
  assert.deepEqual([
    normalizeInboundTtlHours(-1),
    normalizeInboundTtlHours(0),
    normalizeInboundTtlHours(1),
    normalizeInboundTtlHours(24),
    normalizeInboundTtlHours(8760),
  ], [-1, 0, 1, 24, 8760]);
  assert.deepEqual([
    normalizeInboundTtlHours(8761),
    normalizeInboundTtlHours(-2),
    normalizeInboundTtlHours(1.5),
    normalizeInboundTtlHours('abc'),
    normalizeInboundTtlHours(null),
    normalizeInboundTtlHours(undefined),
    normalizeInboundTtlHours(true),
    normalizeInboundTtlHours('1.5'),
    normalizeInboundTtlHours(''),
  ], [null, null, null, null, null, null, null, null, null]);
  assert.equal(normalizeInboundTtlHours('24'), 24);
  assert.equal(normalizeInboundTtlHours('-1'), -1);
});

test('parseInboundDirectoryName parses timestamp names and rejects everything else', () => {
  const parsed = parseInboundDirectoryName('20260904-051030-aB9xY1');
  assert.equal(parsed?.getFullYear(), 2026);
  assert.equal(parsed?.getMonth(), 8);
  assert.equal(parsed?.getDate(), 4);
  assert.equal(parsed?.getHours(), 5);
  assert.equal(parsed?.getMinutes(), 10);
  assert.equal(parsed?.getSeconds(), 30);
  assert.deepEqual([
    parseInboundDirectoryName('turn-abc123'),
    parseInboundDirectoryName('20261304-000000-x'),
    parseInboundDirectoryName('20260231-000000-x'),
    parseInboundDirectoryName('20260904-250000-x'),
    parseInboundDirectoryName('not-a-timestamp'),
    parseInboundDirectoryName(''),
    parseInboundDirectoryName(undefined),
  ], [null, null, null, null, null, null, null]);
});

test('InboundTtlStore starts at the default TTL, round-trips values, and survives damage', async (t) => {
  const root = await directory(t, 'dsh-im-ttl-store-');
  const settingsPath = join(root, 'integrations', 'dsh-im', 'settings.json');

  const fresh = await new InboundTtlStore(settingsPath).load();
  assert.equal(fresh.getTtlHours(), DEFAULT_INBOUND_TTL_HOURS);
  assert.deepEqual(await readdir(root, { recursive: true }), []);

  assert.equal(await fresh.setTtlHours(24), 24);
  assert.equal(fresh.getTtlHours(), 24);
  const persisted = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.deepEqual(persisted, { version: 1, inboundAttachmentTtlHours: 24 });
  // Atomic writes leave no temporary files behind.
  assert.deepEqual((await readdir(dirname(settingsPath))).filter((name) => name.includes('.tmp')), []);

  const reloaded = await new InboundTtlStore(settingsPath).load();
  assert.equal(reloaded.getTtlHours(), 24);
  assert.equal(await reloaded.setTtlHours('-1'), -1);
  assert.equal((await new InboundTtlStore(settingsPath).load()).getTtlHours(), -1);

  await writeFile(settingsPath, 'definitely not json{{{', 'utf8');
  const corrupted = await new InboundTtlStore(settingsPath).load();
  assert.equal(corrupted.getTtlHours(), -1, 'damaged documents fall back to keep-forever');
  await writeFile(settingsPath, JSON.stringify({ version: 2, inboundAttachmentTtlHours: 99 }), 'utf8');
  assert.equal((await new InboundTtlStore(settingsPath).load()).getTtlHours(), -1, 'unknown versions fall back to keep-forever');
  // Crash leftovers from an interrupted atomic write are cleaned on load.
  await writeFile(`${settingsPath}.orphan.tmp`, 'garbage', 'utf8');
  await new InboundTtlStore(settingsPath).load();
  assert.deepEqual(
    (await readdir(dirname(settingsPath))).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('InboundTtlStore rejects invalid TTL values with a stable error code', async (t) => {
  const root = await directory(t, 'dsh-im-ttl-store-invalid-');
  const store = await new InboundTtlStore(join(root, 'settings.json')).load();
  for (const invalid of [8761, -2, 1.5, 'abc', null, undefined]) {
    await assert.rejects(store.setTtlHours(invalid), (error) => (
      error instanceof Error && error.code === 'inbound-ttl-invalid'
    ));
  }
  assert.equal(store.getTtlHours(), DEFAULT_INBOUND_TTL_HOURS);
  await assert.rejects(async () => new InboundTtlStore(''), TypeError);
});

test('stageInboundFiles uses timestamp directories and honors retention', async (t) => {
  const workspace = await directory(t, 'dsh-im-ttl-stage-');

  const transient = await stageInboundFiles({
    files: [{ name: 'turn.txt', data: Buffer.from('turn') }],
  }, { workspace });
  assert.equal(transient.retention, 'turn');
  assert.match(basename(transient.directory), /^\d{8}-\d{6}-/);
  assert.equal(
    transient.directory,
    resolve(workspace, dirname(transient.files[0].path)),
    'staged.directory is the absolute path holding the files',
  );
  await transient.cleanup();
  await assert.rejects(stat(transient.directory), /ENOENT/);

  const persistent = await stageInboundFiles({
    files: [{ name: 'kept.txt', data: Buffer.from('kept') }],
  }, { workspace, retention: 'persistent' });
  assert.equal(persistent.retention, 'persistent');
  await persistent.cleanup();
  assert.equal((await stat(persistent.directory)).isDirectory(), true);
  await persistent.cleanup();
  assert.equal((await stat(persistent.directory)).isDirectory(), true);
  await rm(persistent.directory, { recursive: true, force: true });

  await assert.rejects(stageInboundFiles({
    files: [{ name: 'bad.txt', data: Buffer.from('bad') }],
  }, { workspace, retention: 'forever' }), (error) => (
    error instanceof InboundFileError && error.code === 'inbound-file-retention-invalid'
  ));
  assert.deepEqual(await readdir(inboundRoot(workspace)), []);
});

test('sweepInboundAttachments applies -1, 0, and hour-based TTLs to timestamp directories only', async (t) => {
  const workspace = await directory(t, 'dsh-im-ttl-sweep-');
  const ancient = await stageDirectory(workspace, '20200101-000001-ancient');
  const expired = await stageDirectory(workspace, '20200101-000002-gone');
  const fresh = await stageDirectory(workspace, '20260102-230000-fresh');
  const legacyTurn = await stageDirectory(workspace, 'turn-legacy');
  const junk = await stageDirectory(workspace, 'misc');
  const now = () => new Date('2026-01-03T00:00:00');

  // Two-hour TTL: the ancient and expired names are far past, fresh is one hour old.
  assert.deepEqual(await sweepInboundAttachments(workspace, 2, { now }), { deleted: 2 });
  await assert.rejects(stat(ancient), /ENOENT/);
  await assert.rejects(stat(expired), /ENOENT/);
  for (const kept of [fresh, legacyTurn, junk]) {
    assert.equal((await stat(kept)).isDirectory(), true);
  }

  assert.deepEqual(await sweepInboundAttachments(workspace, -1, { now }), { deleted: 0 });
  assert.equal((await stat(fresh)).isDirectory(), true, 'keep-forever never deletes');

  // TTL 0 would delete the fresh directory, but it is owned by a live turn.
  assert.deepEqual(
    await sweepInboundAttachments(workspace, 0, { now, isTracked: (path) => path === fresh }),
    { deleted: 0 },
  );
  assert.equal((await stat(fresh)).isDirectory(), true, 'tracked directories survive a sweep');

  assert.deepEqual(await sweepInboundAttachments(workspace, 0, { now }), { deleted: 1 });
  await assert.rejects(stat(fresh), /ENOENT/);
  for (const untouched of [legacyTurn, junk]) {
    assert.equal((await stat(untouched)).isDirectory(), true, 'unparseable directories are never managed');
  }
});

test('sweepInboundAttachments tolerates a missing inbound root and unparseable TTLs', async (t) => {
  const emptyWorkspace = await directory(t, 'dsh-im-ttl-empty-');
  assert.deepEqual(await sweepInboundAttachments(emptyWorkspace, 0), { deleted: 0 });
  const workspace = await directory(t, 'dsh-im-ttl-badttl-');
  const staged = await stageDirectory(workspace, '20200101-000000-old');
  assert.deepEqual(await sweepInboundAttachments(workspace, -5), { deleted: 0 });
  assert.deepEqual(await sweepInboundAttachments(workspace, 'soon'), { deleted: 0 });
  assert.equal((await stat(staged)).isDirectory(), true);
  await assert.rejects(sweepInboundAttachments('', 0), TypeError);
});

test('sweepInboundAttachments refuses an attachment root outside the workspace', async (t) => {
  const root = await directory(t, 'dsh-im-ttl-outside-root-');
  const workspace = join(root, 'workspace');
  const external = join(root, 'external');
  const sentinel = join(external, 'inbound', '20200101-000000-external', 'sentinel.txt');
  await mkdir(workspace, { recursive: true });
  await mkdir(dirname(sentinel), { recursive: true });
  await writeFile(sentinel, 'must survive');
  try {
    await symlink(external, join(workspace, '.dsh-im'));
  } catch (error) {
    t.skip(`symlinks are unavailable on this filesystem: ${error?.message}`);
    return;
  }

  await assert.rejects(
    sweepInboundAttachments(workspace, 0),
    (error) => error instanceof InboundFileError
      && error.code === 'inbound-file-root-outside-workspace',
  );
  assert.equal(await readFile(sentinel, 'utf8'), 'must survive');
});

test('stageInboundFiles reports the batch directory before any file is written', async (t) => {
  const workspace = await directory(t, 'dsh-im-ttl-register-');
  const seen = [];
  const staged = await stageInboundFiles({
    files: [{ name: 'note.txt', data: Buffer.from('note') }],
  }, {
    workspace,
    retention: 'persistent',
    onStagedDirectory: (directory) => seen.push(directory),
  });
  assert.deepEqual(seen, [staged.directory]);
  await assert.rejects(stageInboundFiles({
    files: [{ name: 'bad.txt', data: Buffer.from('bad') }],
  }, { workspace, onStagedDirectory: 'nope' }), TypeError);
});

test('trackDirectory shields a mid-staging directory from a TTL=0 sweep', async (t) => {
  const workspace = await directory(t, 'dsh-im-ttl-midstaging-');
  const midStaging = await stageDirectory(workspace, '20200101-000000-mid');
  const service = createInboundTtlService({
    store: memoryStore(0),
    logger: { error: () => undefined },
  });
  service.registerWorkspaceProvider(() => [workspace]);
  service.trackDirectory(midStaging);
  assert.deepEqual(await service.sweepNow(), { deletedDirectories: 0, sweptWorkspaces: 1 });
  assert.equal((await stat(midStaging)).isDirectory(), true, 'mid-staging batches are never swept');
});

test('tracked protection expires so leaked directories return to TTL control', async (t) => {
  const workspace = await directory(t, 'dsh-im-ttl-expiry-');
  const stale = await stageDirectory(workspace, '20200101-000000-stale');
  const service = createInboundTtlService({
    store: memoryStore(0),
    logger: { error: () => undefined },
  });
  service.registerWorkspaceProvider(() => [workspace]);
  // A stalled or aborted turn never calls cleanup; after the protection
  // window the directory must fall back under TTL control.
  service.trackDirectory(stale, { now: () => Date.now() - 25 * 60 * 60_000 });
  assert.deepEqual(await service.sweepNow(), { deletedDirectories: 1, sweptWorkspaces: 1 });
  await assert.rejects(stat(stale), /ENOENT/);
});

test('the first workspace provider registration triggers an immediate sweep', async (t) => {
  const workspace = await directory(t, 'dsh-im-ttl-first-provider-');
  const orphan = await stageDirectory(workspace, '20200101-000000-orphan');
  const service = createInboundTtlService({
    store: memoryStore(0),
    logger: { error: () => undefined },
  });
  service.start();
  t.after(() => service.stop());
  service.registerWorkspaceProvider(() => [workspace]);
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await stat(orphan);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (Date.now() > deadline) {
      assert.fail('orphan directory was not swept after the first provider registered');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
});

test('tracked directories survive symlink spelling differences between staging and sweeping', async (t) => {
  const workspace = await directory(t, 'dsh-im-ttl-symlink-');
  const alias = join(tmpdir(), `dsh-im-ttl-alias-${process.pid}-${Date.now()}`);
  try {
    await symlink(workspace, alias);
  } catch (error) {
    t.skip(`symlinks are unavailable on this filesystem: ${error?.message}`);
    return;
  }
  t.after(() => rm(alias, { force: true }));
  const staged = await stageInboundFiles({
    files: [{ name: 'live.txt', data: Buffer.from('live') }],
  }, { workspace: alias, retention: 'persistent' });
  const service = createInboundTtlService({
    store: memoryStore(0),
    logger: { error: () => undefined },
  });
  // The harness reports the alias spelling; workspaceFor() reports the real one.
  service.trackDirectory(staged.directory);
  service.registerWorkspaceProvider(() => [workspace]);
  assert.deepEqual(await service.sweepNow(), { deletedDirectories: 0, sweptWorkspaces: 1 });
  assert.equal((await stat(staged.directory)).isDirectory(), true);
});

test('the inbound TTL service maps retention, tracks staged directories, and dedupes sweeps', async (t) => {
  const workspaceA = await directory(t, 'dsh-im-ttl-svc-a-');
  const workspaceB = await directory(t, 'dsh-im-ttl-svc-b-');
  const workspaceC = await directory(t, 'dsh-im-ttl-svc-c-');
  await stageDirectory(workspaceA, '20200101-000001-a');
  await stageDirectory(workspaceA, '20200101-000002-a');
  await stageDirectory(workspaceB, '20200101-000001-b');
  const live = await stageDirectory(workspaceA, '20200101-000003-live');

  const store = memoryStore(0);
  const service = createInboundTtlService({ store, logger: { error: () => undefined } });
  assert.equal(service.stagingRetention(), 'turn');
  store.setTtlHours(24);
  assert.equal(service.stagingRetention(), 'persistent');

  const staged = await stageInboundFiles({
    files: [{ name: 'live.txt', data: Buffer.from('live') }],
  }, { workspace: workspaceA, retention: 'persistent' });
  assert.notEqual(staged.directory, live);
  const tracked = service.trackStaged(staged);
  assert.equal(tracked.files, staged.files);
  assert.equal(tracked.directory, staged.directory);
  assert.equal(tracked.retention, 'persistent');
  assert.equal(service.trackStaged(null), null);

  // Duplicate workspace entries collapse, and a crashing provider is isolated.
  service.registerWorkspaceProvider(() => [workspaceA, workspaceA, workspaceB]);
  const unregisterC = service.registerWorkspaceProvider(() => [workspaceC]);
  service.registerWorkspaceProvider(() => {
    throw new Error('provider crashed');
  });

  assert.deepEqual(await service.sweepNow(), { deletedDirectories: 4, sweptWorkspaces: 3 });
  await assert.rejects(stat(join(inboundRoot(workspaceA), '20200101-000001-a')), /ENOENT/);
  await assert.rejects(stat(join(inboundRoot(workspaceA), '20200101-000002-a')), /ENOENT/);
  await assert.rejects(stat(join(inboundRoot(workspaceA), '20200101-000003-live')), /ENOENT/);
  await assert.rejects(stat(join(inboundRoot(workspaceB), '20200101-000001-b')), /ENOENT/);
  assert.equal((await stat(tracked.directory)).isDirectory(), true);

  await tracked.cleanup();
  // Persistent cleanup is a no-op on disk; it only releases the registry entry.
  assert.equal((await stat(tracked.directory)).isDirectory(), true);
  store.setTtlHours(0);
  assert.deepEqual(await service.sweepNow(), { deletedDirectories: 1, sweptWorkspaces: 3 });
  await assert.rejects(stat(tracked.directory), /ENOENT/);

  unregisterC();
  const onlyInC = await stageDirectory(workspaceC, '20200101-000001-c');
  await stageDirectory(workspaceB, '20200101-000002-b');
  assert.deepEqual(await service.sweepNow(), { deletedDirectories: 1, sweptWorkspaces: 2 });
  assert.equal((await stat(onlyInC)).isDirectory(), true, 'unregistered workspaces are no longer swept');
  await assert.rejects(stat(join(inboundRoot(workspaceB), '20200101-000002-b')), /ENOENT/);

  store.setTtlHours(-1);
  await stageDirectory(workspaceB, '20200101-000003-b');
  assert.deepEqual(await service.sweepNow(), { deletedDirectories: 0, sweptWorkspaces: 0 });

  await assert.rejects(async () => createInboundTtlService({}), TypeError);
  await assert.rejects(async () => service.registerWorkspaceProvider('nope'), TypeError);
});

test('the service sweeps on a schedule and survives provider crashes between sweeps', async () => {
  let sweeps = 0;
  const store = memoryStore(0);
  const errors = [];
  const service = createInboundTtlService({
    store,
    logger: { error: (message) => errors.push(message) },
    intervalMs: 5,
  });
  service.registerWorkspaceProvider(() => {
    sweeps += 1;
    return [];
  });
  service.start();
  service.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  service.stop();
  service.stop();
  assert.equal(sweeps >= 2, true, 'startup sweep plus at least one interval sweep ran');
  assert.deepEqual(errors, []);
});

test('the coordinator applies the service retention and returns tracked staged batches', async (t) => {
  const workspace = await directory(t, 'dsh-im-ttl-coordinator-');
  const service = createInboundTtlService({ store: memoryStore(24) });
  const { fileIngressExecutor } = createHarnessSessionExecutors({}, { inboundTtlService: service });

  const staged = await fileIngressExecutor({
    sessionId: 'session-cold',
    workspace,
    files: [{ name: 'report.txt', data: Buffer.from('tracked') }],
  });
  assert.equal(staged.retention, 'persistent');
  await staged.cleanup();
  assert.equal((await stat(staged.directory)).isDirectory(), true, 'persistent cleanup is a no-op');
  await rm(staged.directory, { recursive: true, force: true });

  await assert.rejects(
    async () => createHarnessSessionExecutors({}, { inboundTtlService: { stagingRetention: () => 'turn' } }),
    TypeError,
  );
});

test('inbound TTL RPC payloads validate exactly the documented contract', () => {
  const { get, set, sweep } = INBOUND_TTL_ENDPOINTS;
  assert.deepEqual([
    validInboundTtlPayload(get, {}),
    validInboundTtlPayload(sweep, {}),
    validInboundTtlPayload(set, { ttlHours: 24 }),
    validInboundTtlPayload(set, { ttlHours: 0 }),
    validInboundTtlPayload(set, { ttlHours: -1 }),
    validInboundTtlPayload(set, { ttlHours: '24' }),
  ], [true, true, true, true, true, true]);
  assert.deepEqual([
    validInboundTtlPayload(get, { ttlHours: 1 }),
    validInboundTtlPayload(sweep, null),
    validInboundTtlPayload(sweep, []),
    validInboundTtlPayload(set, {}),
    validInboundTtlPayload(set, { ttlHours: 8761 }),
    validInboundTtlPayload(set, { ttlHours: 24, extra: true }),
    validInboundTtlPayload(set, { hours: 24 }),
    validInboundTtlPayload('settings.inbound-ttl.reset', {}),
  ], [false, false, false, false, false, false, false, false]);
});

test('the inbound TTL RPC handler answers get, set, and sweep with the fixed value shapes', async () => {
  const store = memoryStore(7);
  const results = [{ deletedDirectories: 2, sweptWorkspaces: 1 }];
  const service = {
    sweepNow: async () => results[0],
  };
  const handler = createInboundTtlRpcHandler({ store, service });

  assert.deepEqual(
    await handler(INBOUND_TTL_ENDPOINTS.get, {}),
    { ok: true, value: { ttlHours: 7 } },
  );
  assert.deepEqual(
    await handler(INBOUND_TTL_ENDPOINTS.set, { ttlHours: -1 }),
    { ok: true, value: { ttlHours: -1 } },
  );
  assert.equal(store.getTtlHours(), -1);
  assert.deepEqual(
    await handler(INBOUND_TTL_ENDPOINTS.sweep, {}),
    { ok: true, value: { deletedDirectories: 2, sweptWorkspaces: 1 } },
  );
  assert.deepEqual(
    await handler(INBOUND_TTL_ENDPOINTS.set, { ttlHours: 9999 }),
    { ok: false, error: { code: 'bad-request', message: 'Invalid inbound TTL request.' } },
  );
  assert.deepEqual(
    await handler(INBOUND_TTL_ENDPOINTS.sweep, {}, AbortSignal.abort()),
    { ok: false, error: { code: 'cancelled', message: 'Request cancelled.' } },
  );
  await assert.rejects(async () => createInboundTtlRpcHandler({}), TypeError);
});

test('resetSweepSchedule postpones the next scheduled sweep by a full interval', async (t) => {
  const workspace = await directory(t, 'dsh-im-ttl-reset-');
  await stageDirectory(workspace, '20200101-000001-a');
  let sweeps = 0;
  const service = createInboundTtlService({
    store: memoryStore(0),
    logger: { error: () => undefined, warn: () => undefined },
    intervalMs: 200,
  });
  service.registerWorkspaceProvider(() => {
    sweeps += 1;
    return [workspace];
  });
  service.start();
  t.after(() => service.stop());
  // Let the startup sweep finish, then re-arm well before the first tick.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const sweepsAtReset = sweeps;
  service.resetSweepSchedule();
  // The original 200ms tick is cancelled; nothing may fire in this window.
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(sweeps, sweepsAtReset, 'the cancelled tick must not fire');
  // The re-armed interval fires a full window after the reset.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(sweeps > sweepsAtReset, 'the re-armed interval fires after a full window');
});

test('saving a TTL through the RPC re-arms the sweep schedule', async () => {
  const store = memoryStore(0);
  const resets = [];
  const service = {
    sweepNow: async () => ({ deletedDirectories: 0, sweptWorkspaces: 0 }),
    resetSweepSchedule: () => resets.push(Date.now()),
  };
  const handler = createInboundTtlRpcHandler({ store, service });
  assert.deepEqual(
    await handler(INBOUND_TTL_ENDPOINTS.get, {}),
    { ok: true, value: { ttlHours: 0 } },
  );
  assert.equal(resets.length, 0, 'reading does not touch the schedule');
  assert.deepEqual(
    await handler(INBOUND_TTL_ENDPOINTS.set, { ttlHours: 24 }),
    { ok: true, value: { ttlHours: 24 } },
  );
  assert.equal(resets.length, 1);
  assert.deepEqual(
    await handler(INBOUND_TTL_ENDPOINTS.sweep, {}),
    { ok: true, value: { deletedDirectories: 0, sweptWorkspaces: 0 } },
  );
  assert.equal(resets.length, 1, 'only set re-arms the schedule');
  assert.deepEqual(
    await handler(INBOUND_TTL_ENDPOINTS.set, { ttlHours: 8761 }),
    { ok: false, error: { code: 'bad-request', message: 'Invalid inbound TTL request.' } },
  );
  assert.equal(resets.length, 1, 'a rejected set leaves the schedule untouched');
});
