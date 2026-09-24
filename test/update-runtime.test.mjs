import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { createUpdateRuntime, NPM_REGISTRY, PACKAGE_NAME } from '../plugin-src/host/update-runtime.mjs';

async function json(filename, value) {
  await mkdir(join(filename, '..'), { recursive: true });
  await writeFile(filename, JSON.stringify(value));
}

async function plugin(directory, version = '3.0.8') {
  await mkdir(join(directory, 'lib'), { recursive: true });
  await json(join(directory, 'package.json'), {
    name: PACKAGE_NAME,
    version,
    main: './lib/index.js',
    exports: { '.': './lib/index.js', './client': './lib/client.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  });
  await Promise.all(['lib/index.js', 'lib/client.js', 'cordis.patch.yml']
    .map((entry) => writeFile(join(directory, entry), '')));
}

function isLinkPrivilegeError(error) {
  return ['EACCES', 'EPERM', 'ENOSYS', 'UNKNOWN'].includes(error?.code);
}

async function linkDirectory(target, link) {
  try {
    await symlink(target, link, 'dir');
    return 'symlink';
  } catch (error) {
    if (!isLinkPrivilegeError(error)) throw error;
  }
  try {
    await symlink(target, link, 'junction');
    return 'junction';
  } catch (error) {
    if (!isLinkPrivilegeError(error)) throw error;
  }
  await cp(target, link, { recursive: true });
  return 'copy';
}

function operation({ output = '', errors = '', exitCode = 0, signal, pending = false, onCancel } = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let finish;
  let closed = false;
  const done = new Promise((resolve) => { finish = resolve; });
  const settle = (code, terminationSignal = null) => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', cancel);
    stdout.end(output);
    stderr.end(errors);
    finish({ exitCode: code, signal: terminationSignal });
  };
  const cancel = () => {
    onCancel?.();
    settle(null, 'SIGTERM');
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (!pending) setImmediate(() => settle(exitCode));
  return { stdout, stderr, done, cancel, terminate: cancel, waitForExit: () => done };
}

async function fixture(t, { desktop = false, name = 'update-test', hoisted = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-update-runtime-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeDir = join(root, 'dsh-home');
  const profileDir = join(homeDir, 'profiles', name);
  const installedLink = join(profileDir, 'node_modules', PACKAGE_NAME);
  const installedDir = hoisted ? installedLink
    : join(profileDir, 'node_modules/.pnpm/@xmanrui+dsh-im@3.0.8/node_modules', PACKAGE_NAME);
  await plugin(installedDir);
  if (!hoisted) {
    await mkdir(join(installedLink, '..'), { recursive: true });
    await linkDirectory(installedDir, installedLink);
  }
  const manifest = { name: `dsh-profile-${name}`, private: true, dependencies: { [PACKAGE_NAME]: '3.0.8' } };
  await json(join(profileDir, 'package.json'), manifest);
  await writeFile(join(profileDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  const cliRoot = join(root, 'harness');
  const cliEntry = join(cliRoot, 'lib/bin.js');
  await json(join(cliRoot, 'package.json'), { name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.js' } });
  await mkdir(join(cliEntry, '..'), { recursive: true });
  await writeFile(cliEntry, '');
  const calls = [];
  let registry = '';
  let installResult = {};
  const ctx = {
    subprocess: {
      spawn(spec) {
        calls.push(spec);
        return operation({
          ...spec.argv.includes('config') ? { output: registry } : installResult,
          signal: spec.signal,
        });
      },
    },
  };
  const options = {
    ctx,
    env: { DSH_HOME: homeDir },
    argv: [process.execPath, cliEntry, '--profile', name],
    execArgv: [],
    execPath: process.execPath,
    cwd: root,
    moduleUrl: pathToFileURL(join(installedDir, 'lib/index.js')).href,
    platform: 'darwin',
    electron: false,
  };
  if (desktop) {
    const desktopRoot = join(root, 'desktop-app');
    const bootstrapPath = join(desktopRoot, 'lib/desktop-cli.js');
    await json(join(desktopRoot, 'package.json'), { name: 'dsh-plugin-desktop', version: '2.0.3' });
    await mkdir(join(bootstrapPath, '..'), { recursive: true });
    await writeFile(bootstrapPath, '');
    ctx.desktopProfiles = { current: { name, dir: profileDir } };
    ctx.desktopPnpmBootstrap = {
      activeProfileName: name,
      activeProfileDir: profileDir,
      homeDir,
      appExecutable: process.execPath,
      dshBootstrapPath: bootstrapPath,
    };
    ctx.desktopPnpm = {
      run(args, signal) {
        calls.push({ method: 'run', args, signal });
        return operation({ output: registry, signal });
      },
      runPlugin(args, cwd, signal) {
        calls.push({ method: 'runPlugin', args, cwd, signal });
        return operation({ ...installResult, signal });
      },
    };
    options.electron = '43.4.0';
  }
  return {
    root, homeDir, profileDir, installedDir, installedLink, manifest, cliEntry, ctx, options, calls,
    runtime: () => createUpdateRuntime(options),
    registry: (value) => { registry = value; },
    installResult: (value) => { installResult = value; },
  };
}

test('read-only inspection accepts normal pnpm symlinks and never starts a process', async (t) => {
  const f = await fixture(t);
  const info = await f.runtime().inspect();
  assert.equal(info.profileName, 'update-test');
  assert.equal(info.environmentKind, 'cli');
  assert.equal(info.installedVersion, '3.0.8');
  assert.equal(info.packageValid, true);
  assert.equal(info.eligible, true);
  assert.match(info.installationKey, /^[a-f0-9]{64}$/u);
  assert.deepEqual(f.calls, []);
});

test('Desktop uses optional services and accepts the hoisted installation layout', async (t) => {
  const f = await fixture(t, { desktop: true, hoisted: true });
  const values = { ...f.ctx };
  f.options.ctx = { get: (name) => values[name] };
  const info = await f.runtime().inspect();
  assert.equal(info.environmentKind, 'desktop');
  assert.equal(info.profileName, 'update-test');
  assert.equal(info.eligible, true);
  assert.deepEqual(f.calls, []);
});

test('profile detection follows only launcher arguments and never guesses from cwd', async (t) => {
  const f = await fixture(t, { name: 'web' });
  for (const args of [['web', '--profile', 'wrong'], ['--profile=web', '--prompt', '--profile', 'wrong']]) {
    f.options.argv = [process.execPath, f.cliEntry, ...args];
    assert.equal((await f.runtime().inspect()).profileName, 'web');
  }
  f.options.argv = [process.execPath, f.cliEntry, '--prompt', '--profile', 'web'];
  assert.equal((await f.runtime().inspect()).blockedReason, 'unknown-profile');
  f.options.argv = [process.execPath, f.cliEntry, '--profile', '../web'];
  assert.equal((await f.runtime().inspect()).blockedReason, 'unknown-profile');
});

test('local, Git, alias and external-directory installations cannot be replaced', async (t) => {
  const f = await fixture(t);
  for (const spec of ['link:/work/dsh-im', 'file:../dsh-im', 'github:xmanrui/dsh-im', 'git+ssh://git@example.com/repo.git', 'npm:another-plugin@1.0.0']) {
    await json(join(f.profileDir, 'package.json'), { ...f.manifest, dependencies: { [PACKAGE_NAME]: spec } });
    const inspected = await f.runtime().inspect();
    assert.equal(inspected.blockedReason, 'source-install', spec);
    assert.equal(inspected.sourceInstall, true, spec);
  }
  const sourceDir = join(f.root, 'source-checkout');
  await plugin(sourceDir);
  await rm(f.installedLink, { recursive: true, force: true });
  await linkDirectory(sourceDir, f.installedLink);
  await json(join(f.profileDir, 'package.json'), f.manifest);
  f.options.moduleUrl = pathToFileURL(join(sourceDir, 'lib/index.js')).href;
  const inspected = await f.runtime().inspect();
  assert.equal(inspected.blockedReason, 'source-install');
  assert.equal(inspected.sourceInstall, true);
  assert.deepEqual(f.calls, []);
});

test('a loaded plugin from another profile cannot authorize an installation', async (t) => {
  const f = await fixture(t);
  const otherPackage = join(f.root, 'other-profile-package');
  await plugin(otherPackage);
  f.options.moduleUrl = pathToFileURL(join(otherPackage, 'lib/index.js')).href;
  assert.equal((await f.runtime().inspect()).blockedReason, 'installation-changed');
});

test('disk verification checks package identity and required entry files', async (t) => {
  const f = await fixture(t);
  const runtime = f.runtime();
  assert.equal((await runtime.inspect()).packageValid, true);
  await unlink(join(f.installedDir, 'lib/client.js'));
  const missingClient = await runtime.inspect();
  assert.equal(missingClient.packageValid, false);
  assert.equal(missingClient.blockedReason, 'invalid-installation');
  assert.equal(missingClient.installedVersion, '3.0.8');
});

test('inspection reads new disk versions and snapshots without require cache', async (t) => {
  const f = await fixture(t);
  const runtime = f.runtime();
  const before = await runtime.inspect();
  const newDir = join(f.profileDir, 'node_modules/.pnpm/@xmanrui+dsh-im@3.0.9/node_modules', PACKAGE_NAME);
  await plugin(newDir, '3.0.9');
  await rm(f.installedLink, { recursive: true, force: true });
  await linkDirectory(newDir, f.installedLink);
  const after = await runtime.inspect();
  assert.equal(after.installedVersion, '3.0.9');
  assert.equal(after.packageValid, true);
  assert.equal(after.blockedReason, 'pending-restart');
  assert.notEqual(after.installationKey, before.installationKey);
});

test('in-place Desktop replacement also requires restart until a new Host loads', async (t) => {
  const f = await fixture(t, { desktop: true, hoisted: true });
  const runtime = f.runtime();
  await runtime.inspect();
  await plugin(f.installedDir, '3.0.9');
  assert.equal((await runtime.inspect()).blockedReason, 'pending-restart');
  assert.equal((await f.runtime().inspect()).eligible, true);
});

test('manifest and lockfile changes invalidate an installation snapshot', async (t) => {
  const f = await fixture(t);
  const runtime = f.runtime();
  const first = await runtime.inspect();
  await writeFile(join(f.profileDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n# changed\n");
  const second = await runtime.inspect();
  assert.notEqual(first.installationKey, second.installationKey);
  await json(join(f.profileDir, 'package.json'), { ...f.manifest, dependencies: { ...f.manifest.dependencies, another: '1.0.0' } });
  assert.notEqual(second.installationKey, (await runtime.inspect()).installationKey);
});

test('installation rejects changes after service confirmation before starting any process', async (t) => {
  for (const desktop of [false, true]) {
    const f = await fixture(t, { desktop });
    const runtime = f.runtime();
    const confirmed = await runtime.inspect();
    await writeFile(join(f.profileDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n# external change after confirmation\n");
    await assert.rejects(runtime.install('3.0.9', { expectedInstallationKey: confirmed.installationKey }), {
      code: 'installation-changed',
    });
    assert.deepEqual(f.calls, []);
  }
});

test('Desktop refuses a mismatched bootstrap or a changed active profile', async (t) => {
  const f = await fixture(t, { desktop: true });
  const runtime = f.runtime();
  assert.equal((await runtime.inspect()).eligible, true);
  f.ctx.desktopPnpmBootstrap.activeProfileName = 'wrong';
  assert.equal((await runtime.inspect()).blockedReason, 'executor-unavailable');
  delete f.ctx.desktopPnpm;
  assert.equal((await runtime.inspect()).eligible, false);
});

test('preflight validates the effective scoped registry without exposing credentials', async (t) => {
  const f = await fixture(t, { desktop: true });
  const runtime = f.runtime();
  for (const output of ['', 'undefined\n', 'null\n', JSON.stringify(NPM_REGISTRY)]) {
    f.registry(output);
    assert.equal((await runtime.inspect({ preflight: true })).eligible, true);
  }
  for (const value of ['https://mirror.example/', 'https://user:password@registry.npmjs.org/', 'http://registry.npmjs.org/']) {
    f.registry(JSON.stringify(value));
    const result = await runtime.inspect({ preflight: true });
    assert.equal(result.blockedReason, 'registry-conflict');
    assert.doesNotMatch(JSON.stringify(result), /password|mirror\.example/u);
  }
  f.registry('not valid json');
  assert.equal((await runtime.inspect({ preflight: true })).blockedReason, 'registry-check-failed');
  assert.ok(f.calls.every((call) => call.method === 'run'));
});

test('Desktop installation reuses runPlugin with one pinned npm target and no restart', async (t) => {
  const f = await fixture(t, { desktop: true });
  let restartCalls = 0;
  f.ctx.desktopProfiles.select = () => { restartCalls += 1; };
  f.ctx.desktopActions = { restart: () => { restartCalls += 1; } };
  const runtime = f.runtime();
  const confirmed = await runtime.inspect();
  assert.deepEqual(await runtime.install('3.0.9', { expectedInstallationKey: confirmed.installationKey }), { exitCode: 0, signal: null });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].args, ['config', 'get', '@xmanrui:registry', '--json']);
  assert.deepEqual(f.calls[1].args, ['add', '-w', '--save-exact', `${PACKAGE_NAME}@3.0.9`, `--registry=${NPM_REGISTRY}`]);
  assert.equal(f.calls[1].cwd, f.profileDir);
  assert.equal(restartCalls, 0);
});

test('CLI installation uses the running Node and verified dsh entry, without shell interpolation', async (t) => {
  const f = await fixture(t);
  f.options.execArgv = ['--expose-internals'];
  await f.runtime().install('3.0.9');
  const [preflight, install] = f.calls;
  assert.deepEqual(preflight.argv, ['pnpm', 'config', 'get', '@xmanrui:registry', '--json']);
  assert.equal(preflight.cwd, f.profileDir);
  assert.deepEqual(install.argv, [process.execPath, '--expose-internals', f.cliEntry, 'plugin', '--profile', 'update-test',
    'add', '-w', '--save-exact', `${PACKAGE_NAME}@3.0.9`, `--registry=${NPM_REGISTRY}`]);
  assert.equal(install.env.DSH_HOME, f.homeDir);
  assert.equal(install.stdio.stdin, 'ignore');
  assert.equal(install.env.CI, 'true');
  assert.equal('shell' in install, false);
});

test('installation rejects ranges, prereleases and argument injection before starting any command', async (t) => {
  const f = await fixture(t);
  const runtime = f.runtime();
  for (const version of ['latest', '^3.0.9', '3.0.9-beta.1', 'v3.0.9', '3.0.9; echo secret', undefined]) {
    await assert.rejects(runtime.install(version), { code: 'invalid-version' });
  }
  assert.deepEqual(f.calls, []);
});

test('a registry conflict prevents the install command', async (t) => {
  const f = await fixture(t, { desktop: true });
  f.registry(JSON.stringify('https://mirror.example/'));
  await assert.rejects(f.runtime().install('3.0.9'), { code: 'registry-conflict' });
  assert.ok(f.calls.every((call) => call.method === 'run'));
});

test('nonzero installation exits return only safe diagnostics', async (t) => {
  const f = await fixture(t, { desktop: true });
  f.installResult({ exitCode: 1, errors: 'secret=abcd /Users/private ERR_PNPM_EACCES https://user:password@example.com/' });
  await assert.rejects(f.runtime().install('3.0.9'), (error) => {
    assert.equal(error.code, 'install-failed');
    assert.equal(error.exitCode, 1);
    assert.equal(error.diagnosticCode, 'ERR_PNPM_EACCES');
    assert.doesNotMatch(JSON.stringify(error) + error.message, /abcd|private|password/u);
    return true;
  });
});

test('timeout and abort use the Host-owned cancellation and await exit', async (t) => {
  for (const mode of ['timeout', 'abort']) {
    const f = await fixture(t, { desktop: true });
    let cancellations = 0;
    f.installResult({ pending: true, onCancel: () => { cancellations += 1; } });
    f.options.installTimeoutMs = mode === 'timeout' ? 20 : 10_000;
    const controller = new AbortController();
    const promise = f.runtime().install('3.0.9', { signal: controller.signal });
    if (mode === 'abort') {
      while (f.calls.length < 2) await new Promise((resolve) => setImmediate(resolve));
      controller.abort();
    }
    await assert.rejects(promise, { code: mode === 'timeout' ? 'install-timeout' : 'install-interrupted' });
    assert.ok(cancellations >= 1);
  }
});

test('Windows CLI without a verified pnpm adapter fails closed', async (t) => {
  const f = await fixture(t);
  f.options.platform = 'win32';
  assert.equal((await f.runtime().inspect()).blockedReason, 'executor-unavailable');
  assert.deepEqual(f.calls, []);
});

test('package validation rejects entry files escaping the installed package', async (t) => {
  const f = await fixture(t);
  const metadata = JSON.parse(await readFile(join(f.installedDir, 'package.json'), 'utf8'));
  metadata.exports['./client'] = '../../../../../outside.js';
  await json(join(f.installedDir, 'package.json'), metadata);
  assert.equal((await f.runtime().inspect()).packageValid, false);
});
