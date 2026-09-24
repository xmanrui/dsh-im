import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createUpdateService, fetchNpmRelease } from '../plugin-src/host/update-service.mjs';

function release(version = '3.0.8', fields = {}) {
  return {
    name: '@xmanrui/dsh-im', version, engines: { node: '>=22.19' },
    dist: {
      tarball: `https://registry.npmjs.org/@xmanrui/dsh-im/-/dsh-im-${version}.tgz`,
      integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
    },
    ...fields,
  };
}

async function fixture(t, options = {}) {
  const homeDir = await mkdtemp(join(tmpdir(), 'dsh-im-update-service-'));
  const profileDir = join(homeDir, 'profiles', 'test');
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, 'package.json'), '{"dependencies":{"@xmanrui/dsh-im":"3.0.7"}}\n');
  await writeFile(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await writeFile(join(profileDir, '.npmrc'), '//example.test/:_authToken=do-not-copy\n');
  const environment = {
    homeDir, profileDir, profileName: 'test', environmentKind: 'desktop',
    installedVersion: '3.0.7', eligible: true, packageValid: true,
    blockedReason: null, installationKey: 'old-installation',
    ...options.environment,
  };
  const state = { time: 10_000, release: release(), fetches: 0, installs: [], installKeys: [], failFetch: false };
  const runtime = {
    inspect: async () => ({ ...environment }),
    install: async (version, { signal, expectedInstallationKey }) => {
      state.installs.push(version);
      state.installKeys.push(expectedInstallationKey);
      if (options.install) return options.install({ version, signal, environment, expectedInstallationKey });
      environment.installedVersion = version;
      environment.installationKey = 'new-installation';
    },
  };
  const serviceOptions = {
    runtime, runningVersion: '3.0.7', nodeVersion: '22.20.0', now: () => state.time,
    fetchImpl: async (url, init) => {
      state.fetches++;
      assert.equal(url, 'https://registry.npmjs.org/%40xmanrui%2Fdsh-im/latest');
      assert.equal(init.redirect, 'error');
      if (state.failFetch) throw new Error('private-path-and-token');
      return new Response(JSON.stringify(state.release));
    },
    ...options.service,
  };
  const service = createUpdateService(serviceOptions);
  const services = [service];
  t.after(async () => {
    await Promise.all(services.map((item) => item.close()));
    await rm(homeDir, { recursive: true, force: true });
  });
  return {
    service, environment, state, homeDir,
    restart(version = '3.0.8') {
      const restarted = createUpdateService({ ...serviceOptions, runningVersion: version });
      services.push(restarted);
      return restarted;
    },
    async submit(requestId = 'request-1') {
      const { checkId } = await service.check();
      return service.install({ checkId, requestId });
    },
    async directory() {
      const root = join(homeDir, 'updates', 'dsh-im');
      return join(root, (await readdir(root))[0]);
    },
  };
}

async function waitForJob(service, expected) {
  const deadline = Date.now() + 4_000;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await service.status();
    if (snapshot.job?.state === expected) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Expected ${expected}, received ${JSON.stringify(snapshot)}`);
}

async function historicalUpdate(t, state = 'restart-required') {
  const f = await fixture(t, {
    service: { runningVersion: '4.21.0' },
    environment: { installedVersion: '4.21.0' },
  });
  f.state.release = release('4.21.1');
  await f.submit('historical-request');
  await waitForJob(f.service, 'restart-required');
  await f.service.close();
  const directory = await f.directory();
  const statePath = join(directory, 'state.json');
  const job = JSON.parse(await readFile(statePath, 'utf8'));
  await writeFile(statePath, JSON.stringify({ ...job, state }));
  f.environment.installedVersion = '4.23.0';
  f.environment.installationKey = 'external-installation';
  f.state.release = release('4.24.0');
  return { ...f, directory, statePath };
}

test('historical successful jobs allow subsequent updates after external upgrades or rollbacks', async (t) => {
  for (const state of ['restart-required', 'completed']) {
    for (const version of ['4.23.0', '4.20.0']) {
      await t.test(`${state}, now running ${version}`, async (t) => {
        const f = await historicalUpdate(t, state);
        f.environment.installedVersion = version;
        const original = await readFile(f.statePath, 'utf8');
        const host = f.restart(version);
        for (let attempt = 0; attempt < 3; attempt++) {
          f.state.time += 3_000;
          const result = await host.check();
          assert.equal(result.job.targetVersion, '4.21.1');
          assert.equal(result.job.state, 'interrupted');
          assert.equal(result.job.message, 'installation-changed');
          assert.equal(result.job.recoverable, true);
          assert.equal(result.latestVersion, '4.24.0');
          assert.equal(result.blockedReason, null);
          assert.equal(result.canInstall, true);
        }
        await host.close();
        const restarted = f.restart(version);
        assert.equal((await restarted.status()).job.recoverable, true);
        const checked = await restarted.check();
        assert.equal(await readFile(f.statePath, 'utf8'), original);
        const replay = await restarted.install({ checkId: checked.checkId, requestId: 'historical-request' });
        assert.equal(replay.job.targetVersion, '4.21.1');
        assert.deepEqual(f.state.installs, ['4.21.1']);

        await restarted.install({ checkId: checked.checkId, requestId: 'next-update' });
        const finished = await waitForJob(restarted, 'restart-required');
        assert.equal(finished.job.targetVersion, '4.24.0');
        assert.equal(finished.job.recoverable, false);
        await restarted.close();
        const nextHost = f.restart('4.24.0');
        assert.equal((await nextHost.status()).job.state, 'completed');
        f.state.release = release('4.25.0');
        const next = await nextHost.check();
        await nextHost.install({ checkId: next.checkId, requestId: 'following-update' });
        await waitForJob(nextHost, 'restart-required');
        assert.deepEqual(f.state.installs, ['4.21.1', '4.24.0', '4.25.0']);
      });
    }
  }
});

test('historical recovery preserves locks, installation validation and restart requirements', async (t) => {
  const cases = [
    { name: 'live lock', lock: { id: 'other', pid: process.pid } },
    { name: 'stale lock', lock: { id: 'other', pid: 999_999_999 } },
    { name: 'null lock', lock: null },
    { name: 'invalid package', environment: { packageValid: false } },
    { name: 'ineligible environment', environment: { eligible: false } },
    { name: 'source installation', environment: { sourceInstall: true, blockedReason: 'source-install', eligible: false } },
    { name: 'changed profile', environment: { blockedReason: 'installation-changed', eligible: false } },
    { name: 'unavailable executor', environment: { blockedReason: 'executor-unavailable', eligible: false } },
    { name: 'registry conflict', environment: { blockedReason: 'registry-conflict', eligible: false } },
    { name: 'not restarted', runningVersion: '4.21.1' },
  ];
  for (const state of ['restart-required', 'completed']) {
    for (const scenario of cases) {
      await t.test(`${state}: ${scenario.name}`, async (t) => {
        const f = await historicalUpdate(t, state);
        Object.assign(f.environment, scenario.environment);
        const lockPath = join(f.directory, 'install.lock');
        if ('lock' in scenario) await writeFile(lockPath, JSON.stringify(scenario.lock));
        const original = await readFile(f.statePath, 'utf8');
        const host = f.restart(scenario.runningVersion ?? '4.23.0');
        const result = await host.check();
        assert.equal(result.job.recoverable, false);
        assert.equal(result.canInstall, false);
        assert.equal(result.checkId, null);
        await assert.rejects(host.install({ checkId: 'not-confirmed', requestId: 'blocked' }));
        assert.deepEqual(f.state.installs, ['4.21.1']);
        assert.equal(await readFile(f.statePath, 'utf8'), original);
        if ('lock' in scenario) assert.equal(await readFile(lockPath, 'utf8'), JSON.stringify(scenario.lock));
      });
    }
  }
});

test('recovered history cannot bypass failed checks, expired confirmation or changed installation', async (t) => {
  const f = await historicalUpdate(t);
  const host = f.restart('4.23.0');
  let checked = await host.check();
  assert.equal(checked.canInstall, true);
  f.state.time += 3_000;
  f.state.failFetch = true;
  await assert.rejects(host.check(), { code: 'check-failed' });
  assert.equal((await host.status()).canInstall, false);
  await assert.rejects(host.install({ checkId: checked.checkId, requestId: 'failed-check' }), { code: 'check-expired' });

  f.state.failFetch = false;
  checked = await host.check();
  f.state.time += 10 * 60_000;
  await assert.rejects(host.install({ checkId: checked.checkId, requestId: 'expired' }), { code: 'check-expired' });
  checked = await host.check();
  f.environment.installationKey = 'another-external-change';
  await assert.rejects(host.install({ checkId: checked.checkId, requestId: 'changed' }), { code: 'installation-changed' });
  assert.deepEqual(f.state.installs, ['4.21.1']);
});

test('recovery flags are derived again and do not override the new release Node requirement', async (t) => {
  const f = await historicalUpdate(t);
  const host = f.restart('4.23.0');
  assert.equal((await host.check()).job.recoverable, true);
  f.state.time += 3_000;
  f.state.release = release('4.24.0', { engines: { node: '>=99' } });
  const incompatible = await host.check();
  assert.equal(incompatible.job.recoverable, true);
  assert.equal(incompatible.blockedReason, 'incompatible-node');
  assert.equal(incompatible.canInstall, false);

  const job = JSON.parse(await readFile(f.statePath, 'utf8'));
  await writeFile(f.statePath, JSON.stringify({ ...job, recoverable: true }));
  f.environment.packageValid = false;
  const invalid = await host.status();
  assert.equal(invalid.job.recoverable, false);
  assert.equal(invalid.blockedReason, 'recovery-required');
  assert.equal(invalid.canInstall, false);
});

test('status is local and npm checking only happens on demand', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.service.status()).latestVersion, null);
  assert.equal(f.state.fetches, 0);
  const checked = await f.service.check();
  assert.equal(checked.latestVersion, '3.0.8');
  assert.equal(checked.canInstall, true);
  assert.ok(checked.checkId);
  await f.service.check();
  assert.equal(f.state.fetches, 1);
});

test('SemVer comparison handles two digit patches and refuses downgrades or equal versions', async (t) => {
  for (const [runningVersion, latest, expected] of [
    ['3.0.9', '3.0.10', true], ['3.0.8', '3.0.8', false], ['3.0.10', '3.0.9', false],
  ]) {
    const f = await fixture(t, { service: { runningVersion }, environment: { installedVersion: runningVersion } });
    f.state.release = release(latest);
    assert.equal((await f.service.check()).canInstall, expected);
  }
});

test('npm metadata rejects pre-releases, other sources, wrong package and invalid integrity', async () => {
  for (const metadata of [
    release('3.0.9-beta.1'), release('not-a-version'), release('3.0.8', { name: 'other-package' }),
    release('3.0.8', { dist: { ...release().dist, tarball: 'https://github.com/example/package.tgz' } }),
    release('3.0.8', { dist: { ...release().dist, integrity: 'sha512-fake' } }),
    release('3.0.8', { engines: { node: 'anything' } }),
  ]) {
    await assert.rejects(fetchNpmRelease(async () => new Response(JSON.stringify(metadata))), { code: 'invalid-release' });
  }
  await assert.rejects(fetchNpmRelease(async () => new Response('x'.repeat(256 * 1024 + 1))), { code: 'invalid-release' });
  await assert.rejects(fetchNpmRelease(async () => new Response('{}', { status: 429 })), { code: 'check-failed' });
});

test('source installs and incompatible Host Node can check but cannot install', async (t) => {
  const source = await fixture(t, { environment: { eligible: false, blockedReason: 'source-install' } });
  const checked = await source.service.check();
  assert.equal(checked.latestVersion, '3.0.8');
  assert.equal(checked.blockedReason, 'source-install');
  assert.equal(checked.sourceInstall, true);
  assert.equal(checked.canInstall, false);
  assert.equal(checked.checkId, null);
  const oldNode = await fixture(t, { service: { nodeVersion: '22.18.0' } });
  assert.equal((await oldNode.service.check()).blockedReason, 'incompatible-node');
  assert.deepEqual(source.state.installs, []);
});

test('source-install protection remains independent of the primary status reason', async (t) => {
  const f = await fixture(t, { environment: {
    eligible: false, blockedReason: 'source-install', sourceInstall: true, installedVersion: '3.0.8',
  } });
  const status = await f.service.status();
  assert.equal(status.blockedReason, 'pending-restart');
  assert.equal(status.sourceInstall, true);
  f.environment.blockedReason = 'installation-changed';
  assert.equal((await f.service.status()).sourceInstall, true);
});

test('a failed check invalidates previous install confirmation without claiming latest', async (t) => {
  const f = await fixture(t);
  const checked = await f.service.check();
  f.state.time += 3_000;
  f.state.failFetch = true;
  await assert.rejects(f.service.check(), { code: 'check-failed' });
  assert.equal((await f.service.status()).canInstall, false);
  await assert.rejects(f.service.install({ checkId: checked.checkId, requestId: 'retry' }), { code: 'check-expired' });
});

test('installation pins the confirmed version, verifies disk and waits for a manual restart', async (t) => {
  const f = await fixture(t);
  const submitted = await f.submit();
  assert.equal(submitted.job.state, 'installing');
  const finished = await waitForJob(f.service, 'restart-required');
  assert.deepEqual(f.state.installs, ['3.0.8']);
  assert.deepEqual(f.state.installKeys, ['old-installation']);
  assert.equal(finished.runningVersion, '3.0.7');
  assert.equal(finished.installedVersion, '3.0.8');
  assert.equal(finished.blockedReason, 'pending-restart');
  assert.equal(finished.canInstall, false);
  await f.service.close();
  const restarted = await f.restart().status();
  assert.equal(restarted.job.state, 'completed');
  assert.equal(restarted.runningVersion, '3.0.8');
  const backup = await readFile(join(await f.directory(), 'before.json'), 'utf8');
  assert.match(backup, /package\.json/);
  assert.doesNotMatch(backup, /authToken|do-not-copy|\.npmrc/);
  assert.doesNotMatch(JSON.stringify(finished), new RegExp(f.homeDir));
});

test('idempotent requests and multiple Host instances cannot start a second install', async (t) => {
  let complete;
  const gate = new Promise((resolve) => { complete = resolve; });
  const f = await fixture(t, { install: async ({ version, environment }) => {
    await gate;
    environment.installedVersion = version;
  } });
  const checked = await f.service.check();
  const first = await f.service.install({ checkId: checked.checkId, requestId: 'same-request' });
  const again = await f.service.install({ checkId: checked.checkId, requestId: 'same-request' });
  assert.equal(first.job.id, again.job.id);
  const otherHost = f.restart('3.0.7');
  const otherCheck = await otherHost.check();
  await assert.rejects(otherHost.install({ checkId: otherCheck.checkId ?? 'unknown', requestId: 'another' }), { code: 'update-busy' });
  assert.equal(f.state.installs.length, 1);
  complete();
  await waitForJob(f.service, 'restart-required');
});

test('changed installation, expired confirmation or changed latest require a fresh confirmation', async (t) => {
  const changed = await fixture(t);
  const first = await changed.service.check();
  changed.environment.installationKey = 'external-change';
  await assert.rejects(changed.service.install({ checkId: first.checkId, requestId: 'changed' }), { code: 'installation-changed' });
  const expired = await fixture(t);
  const second = await expired.service.check();
  expired.state.time += 11 * 60_000;
  await assert.rejects(expired.service.install({ checkId: second.checkId, requestId: 'expired' }), { code: 'check-expired' });
  const newer = await fixture(t);
  const third = await newer.service.check();
  newer.state.release = release('3.0.9');
  await assert.rejects(newer.service.install({ checkId: third.checkId, requestId: 'newer' }), { code: 'check-expired' });
  assert.equal(newer.state.installs.length, 0);
  assert.equal((await readdir(await newer.directory())).includes('install.lock'), false);
});

test('successful command without correct installed version or usable entry is a verification failure', async (t) => {
  const unchanged = await fixture(t, { install: async () => {} });
  await unchanged.submit();
  assert.equal((await waitForJob(unchanged.service, 'failed')).job.message, 'verify-failed');
  const invalid = await fixture(t, { install: async ({ environment, version }) => {
    environment.installedVersion = version;
    environment.packageValid = false;
  } });
  await invalid.submit();
  assert.equal((await waitForJob(invalid.service, 'failed')).blockedReason, 'recovery-required');
});

test('failed package mutation reports recovery instead of claiming unchanged or updated', async (t) => {
  const f = await fixture(t, { install: async ({ environment, version }) => {
    environment.installedVersion = version;
    throw new Error('stderr with private-path-and-token');
  } });
  await f.submit();
  const result = await waitForJob(f.service, 'failed');
  assert.equal(result.blockedReason, 'recovery-required');
  assert.equal(result.canInstall, false);
  assert.doesNotMatch(JSON.stringify(result), /private-path-and-token/);
});

test('closing the Host aborts its job and a later healthy Host can retry once the lock is released', async (t) => {
  let signal;
  const f = await fixture(t, { install: async (options) => {
    signal = options.signal;
    await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'interrupted' })), { once: true });
    });
  } });
  await f.submit();
  await f.service.close();
  assert.equal(signal.aborted, true);
  const result = await f.restart('3.0.7').status();
  assert.equal(result.job.state, 'interrupted');
  assert.equal(result.blockedReason, null);
  assert.equal(result.canInstall, false);
  assert.equal((await f.restart('3.0.7').check()).canInstall, true);
});

test('foreign stale lock is reported for manual recovery and is not silently deleted', async (t) => {
  const f = await fixture(t);
  await f.submit();
  await waitForJob(f.service, 'restart-required');
  const directory = await f.directory();
  await rm(join(directory, 'state.json'));
  await writeFile(join(directory, 'install.lock'), JSON.stringify({ id: 'foreign', pid: 999_999_999 }));
  const result = await f.restart().status();
  assert.equal(result.job.state, 'interrupted');
  assert.match(await readFile(join(directory, 'install.lock'), 'utf8'), /foreign/);
});

test('an external version change after installation is not reported as this job completing', async (t) => {
  const f = await fixture(t);
  await f.submit();
  await waitForJob(f.service, 'restart-required');
  await f.service.close();
  f.environment.installedVersion = '3.0.9';
  const result = await f.restart('3.0.9').status();
  assert.equal(result.job.state, 'interrupted');
  assert.equal(result.job.message, 'installation-changed');
});

test('post-install verification stays bound to the original home and profile', async (t) => {
  for (const field of ['homeDir', 'profileDir', 'profileName']) {
    const f = await fixture(t, { install: async ({ environment, version }) => {
      environment.installedVersion = version;
      environment[field] += '-other';
      environment.blockedReason = 'installation-changed';
      environment.eligible = false;
    } });
    await f.submit();
    const statePath = join(await f.directory(), 'state.json');
    const result = await waitForJob({ status: async () => ({ job: JSON.parse(await readFile(statePath, 'utf8')) }) }, 'failed');
    assert.equal(result.job.message, 'installation-changed', field);
  }
});

test('a correct target version from a changed installation source does not pass verification', async (t) => {
  const f = await fixture(t, { install: async ({ environment, version }) => {
    environment.installedVersion = version;
    environment.blockedReason = 'source-install';
    environment.eligible = false;
  } });
  await f.submit();
  assert.equal((await waitForJob(f.service, 'failed')).job.message, 'verify-failed');
});

test('a runtime rejection of the confirmed installation snapshot is persisted as a failure', async (t) => {
  const f = await fixture(t, { install: async ({ expectedInstallationKey }) => {
    assert.equal(expectedInstallationKey, 'old-installation');
    throw Object.assign(new Error('installation-changed'), { code: 'installation-changed' });
  } });
  await f.submit();
  assert.equal((await waitForJob(f.service, 'failed')).job.message, 'installation-changed');
});

test('manual repair followed by a new healthy Host can recover failed and interrupted jobs', async (t) => {
  for (const interrupted of [false, true]) {
    const f = await fixture(t, { install: async ({ signal }) => {
      if (interrupted) await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('interrupted'), { code: 'interrupted' })), { once: true });
      });
      else throw new Error('installation failed');
    } });
    await f.submit();
    if (!interrupted) await waitForJob(f.service, 'failed');
    await f.service.close();
    f.environment.installedVersion = '3.0.8';
    f.environment.installationKey = 'manually-repaired';
    f.state.release = release('3.0.9');
    const result = await f.restart('3.0.8').check();
    assert.equal(result.job.state, 'completed');
    assert.equal(result.job.message, 'recovered');
    assert.equal(result.blockedReason, null);
    assert.equal(result.canInstall, true);
  }
});

test('manual recovery never clears a residual lock, including a malformed lock document', async (t) => {
  for (const contents of [JSON.stringify({ id: 'old-job', pid: process.pid }), JSON.stringify({ id: 'old-job', pid: 999_999_999 }), 'null']) {
    const f = await fixture(t, { install: async () => { throw new Error('failed'); } });
    await f.submit();
    await waitForJob(f.service, 'failed');
    await f.service.close();
    const lockPath = join(await f.directory(), 'install.lock');
    await writeFile(lockPath, contents);
    const result = await f.restart('3.0.7').check();
    assert.equal(result.job.state, 'interrupted');
    assert.equal(result.blockedReason, 'recovery-required');
    assert.equal(result.canInstall, false);
    assert.equal(await readFile(lockPath, 'utf8'), contents);
  }
});

test('an incomplete package cannot be reported as completed after a restart', async (t) => {
  const f = await fixture(t);
  await f.submit();
  await waitForJob(f.service, 'restart-required');
  await f.service.close();
  f.environment.packageValid = false;
  const result = await f.restart('3.0.8').status();
  assert.equal(result.job.state, 'interrupted');
  assert.equal(result.blockedReason, 'recovery-required');
});

test('a final journal write failure is visible in memory and leaves its lock intact', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async (t) => {
  let directory;
  const f = await fixture(t, { install: async ({ environment, version }) => {
    directory = await f.directory();
    environment.installedVersion = version;
    await chmod(directory, 0o500);
  } });
  try {
    await f.submit();
    const result = await waitForJob(f.service, 'interrupted');
    assert.equal(result.job.message, 'state-unavailable');
    assert.equal(result.blockedReason, 'recovery-required');
    assert.equal(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).state, 'installing');
    assert.equal(JSON.parse(await readFile(join(directory, 'install.lock'), 'utf8')).id, result.job.id);
    await chmod(directory, 0o700);
    assert.equal((await f.service.status()).job.state, 'interrupted');
  } finally {
    if (directory) await chmod(directory, 0o700);
  }
});

test('the service watchdog reports timeout and waits for the owned installer to stop', async (t) => {
  let stopped = false;
  const f = await fixture(t, {
    service: { installTimeoutMs: 20 },
    install: async ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        stopped = true;
        reject(Object.assign(new Error('install-interrupted'), { code: 'install-interrupted' }));
      }, { once: true });
    }),
  });
  await f.submit();
  const result = await waitForJob(f.service, 'failed');
  assert.equal(stopped, true);
  assert.equal(result.job.message, 'install-timeout');
  await f.service.close();
  assert.equal((await readdir(await f.directory())).includes('install.lock'), false);
});
