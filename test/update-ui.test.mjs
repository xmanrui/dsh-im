import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import TestRenderer from 'react-test-renderer';

import { en, setImTranslator } from '../plugin-src/client/i18n.js';
import { UpdatePanel } from '../plugin-src/client/update-panel.js';

const { act, create } = TestRenderer;

function snapshot(overrides = {}) {
  return {
    runningVersion: '3.0.8',
    installedVersion: '3.0.8',
    latestVersion: null,
    profileName: 'desktop-test',
    environmentKind: 'desktop',
    canInstall: false,
    blockedReason: null,
    checkedAt: null,
    checkId: null,
    job: null,
    ...overrides,
  };
}

function available(overrides = {}) {
  return snapshot({
    latestVersion: '3.0.9', canInstall: true,
    checkedAt: 1_000, checkId: 'check_one', ...overrides,
  });
}

function installing(state = 'installing') {
  return available({
    canInstall: false,
    job: { id: 'job_one', state, targetVersion: '3.0.9', message: '' },
  });
}

function ok(value) { return { ok: true, value }; }

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return node?.children?.map(textOf).join('') ?? '';
}

function buttonNamed(renderer, label) {
  return renderer.root.findAllByType('button').find((node) => (node.props['aria-label'] ?? textOf(node)) === label);
}

async function flushMicrotasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function mount(t, rpcCall, props = {}, options) {
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(UpdatePanel, {
      rpcCall, clientVersion: '3.0.8', ...props,
    }), options);
    await flushMicrotasks();
  });
  t.after(async () => { await act(async () => { renderer.unmount(); }); });
  return renderer;
}

async function click(renderer, label) {
  const button = buttonNamed(renderer, label);
  assert.ok(button, `Missing button: ${label}`);
  assert.equal(button.props.disabled === true, false, `Disabled button: ${label}`);
  await act(async () => {
    button.props.onClick();
    await flushMicrotasks();
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function stubClipboard(t, clipboard) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  });
}

function manualCommandOf(renderer) {
  return renderer.root.findAllByType('textarea')[0]?.props.value;
}

async function tick(t, milliseconds = 1_000) {
  await act(async () => {
    t.mock.timers.tick(milliseconds);
    await flushMicrotasks();
  });
}

test('update panel reads local status first and requires an explicit npm check and confirmation', async (t) => {
  const calls = [];
  const reported = [];
  const renderer = await mount(t, async (endpoint, payload, signal) => {
    calls.push({ endpoint, payload, signal });
    if (endpoint === 'update.status') return ok(snapshot());
    if (endpoint === 'update.check') return ok(available());
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  }, { onStatus: (value) => reported.push(value.runningVersion) });

  assert.deepEqual(calls.map((call) => call.endpoint), ['update.status']);
  assert.deepEqual(calls[0].payload, {});
  assert.deepEqual(reported, ['3.0.8']);
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);

  await click(renderer, '检查更新');
  assert.deepEqual(calls.map((call) => call.endpoint), ['update.status', 'update.check']);
  assert.deepEqual(calls[1].payload, {});
  assert.equal(renderer.root.findByProps({ role: 'dialog' }).props['aria-modal'], 'true');
  assert.match(textOf(renderer.toJSON()), /发现新版本/);
  assert.match(textOf(renderer.toJSON()), /desktop-test/);
  assert.match(textOf(renderer.toJSON()), /需手动重启后台.*本功能不会自动重启或主动刷新页面/);
  assert.ok(buttonNamed(renderer, '安装更新'));
  assert.ok(buttonNamed(renderer, '更新至 v3.0.9'));
  assert.equal(calls.some((call) => call.endpoint === 'update.install'), false);
  await click(renderer, '关闭');
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);
});

test('version details hide npm, registry and client metadata while preserving running and installed versions', async (t) => {
  for (const latestVersion of [null, '3.1.2']) {
    const renderer = await mount(t, async () => ok(snapshot({
      runningVersion: '3.1.0', installedVersion: '3.1.1', latestVersion,
      profileName: 'web', blockedReason: 'pending-restart',
    })), { clientVersion: '3.1.1' });
    await click(renderer, '待手动重启');
    const details = renderer.root.findByProps({ className: 'dim-updateVersions' });
    assert.deepEqual(details.findAllByType('dt').map(textOf), ['运行版本', '已安装版本', '目标 profile']);
    assert.deepEqual(details.findAllByType('dd').map(textOf), ['v3.1.0', 'v3.1.1', 'web']);
  }
});

test('historical jobs do not suppress a new check or its available version', async (t) => {
  for (const state of ['completed', 'failed', 'interrupted']) {
    const job = {
      id: 'old-job', state, targetVersion: '4.21.1',
      message: state === 'completed' ? null : 'installation-changed',
      recoverable: state !== 'completed',
    };
    const base = snapshot({ runningVersion: '4.23.0', installedVersion: '4.23.0', profileName: 'web', job });
    const calls = [];
    const renderer = await mount(t, async (endpoint, payload) => {
      calls.push({ endpoint, payload });
      if (endpoint === 'update.status') return ok(base);
      if (endpoint === 'update.check') return ok({ ...base, latestVersion: '4.24.0', canInstall: true,
        checkedAt: 1_000, checkId: 'new-check' });
      return ok({ ...base, job: { id: 'new-job', state: 'restart-required', targetVersion: '4.24.0' },
        installedVersion: '4.24.0', blockedReason: 'pending-restart' });
    }, { clientVersion: '4.23.0' });

    await click(renderer, '检查更新');
    assert.deepEqual(calls.map(call => call.endpoint), ['update.status', 'update.check']);
    assert.equal(textOf(renderer.root.findByProps({ role: 'status' })), '发现新版本');
    assert.doesNotMatch(renderer.root.findByProps({ role: 'status' }).props.className, /dim-updateStatusError/);
    const details = renderer.root.findByProps({ className: 'dim-updateVersions' });
    assert.match(textOf(details), /最新版本v4\.24\.0/);
    assert.match(textOf(details), /上次更新目标v4\.21\.1/);
    assert.equal(details.findAllByType('dt').some(node => textOf(node) === '目标版本'), false);
    assert.equal(manualCommandOf(renderer), 'dsh plugin --profile web add -w @xmanrui/dsh-im@4.24.0');
    await click(renderer, '安装更新');
    assert.equal(calls.at(-1).payload.checkId, 'new-check');
    assert.match(textOf(renderer.toJSON()), /目标版本v4\.24\.0/);
    assert.match(textOf(renderer.toJSON()), /已安装，待手动重启/);
  }
});

test('fresh check results and errors take priority over recovered or completed history', async (t) => {
  for (const state of ['completed', 'interrupted']) {
    const job = { id: 'history', state, targetVersion: '3.0.7', recoverable: state !== 'completed' };
    let fail = false;
    let blockedReason = null;
    const renderer = await mount(t, async (endpoint) => {
      if (endpoint === 'update.status') return ok(snapshot({ job }));
      if (fail) throw Object.assign(new Error('check-failed'), { code: 'check-failed' });
      return ok(snapshot({ job, latestVersion: '3.0.8', checkedAt: 1_000, blockedReason }));
    });
    await click(renderer, '检查更新');
    assert.equal(textOf(renderer.root.findByProps({ role: 'status' })), '已是最新版本');
    blockedReason = 'registry-conflict';
    await click(renderer, '重新检查');
    assert.doesNotMatch(textOf(renderer.root.findByProps({ role: 'status' })), /已是最新版本|更新已生效/);
    assert.match(textOf(renderer.toJSON()), /当前 npm 源配置与官方源不一致/);
    fail = true;
    await click(renderer, '重新检查');
    assert.equal(textOf(renderer.root.findByProps({ role: 'status' })), '更新请求失败');
    assert.equal(buttonNamed(renderer, '安装更新'), undefined);
    assert.doesNotMatch(textOf(renderer.toJSON()), /最新版本v3\.0\.8/);
  }
});

test('an active or unconfirmed historical job keeps its failure and installation target visible', async (t) => {
  for (const state of ['installing', 'verifying', 'restart-required', 'interrupted']) {
    const calls = [];
    const current = available({ canInstall: false, checkId: null, latestVersion: '3.0.10',
      blockedReason: state === 'interrupted' ? 'recovery-required' : null,
      job: { id: 'job', state, targetVersion: '3.0.9', message: 'recovery-required', recoverable: false } });
    const renderer = await mount(t, async (endpoint) => { calls.push(endpoint); return ok(current); });
    await click(renderer, state === 'restart-required' ? '待手动重启'
      : state === 'interrupted' ? '检查更新' : '正在更新…');
    assert.equal(buttonNamed(renderer, '安装更新'), undefined);
    if (state === 'interrupted') assert.match(textOf(renderer.toJSON()), /上次更新已中断/);
    else {
      assert.match(textOf(renderer.toJSON()), /目标版本v3\.0\.9/);
      assert.doesNotMatch(textOf(renderer.toJSON()), /最新版本v3\.0\.10/);
      assert.equal(calls.includes('update.check'), false);
    }
  }
});

test('recovered historical version labels and fresh results have English copy', async (t) => {
  setImTranslator((key) => en[key] ?? key);
  t.after(() => setImTranslator(null));
  const current = available({ job: { id: 'history', state: 'interrupted', targetVersion: '3.0.7',
    message: 'installation-changed', recoverable: true } });
  const renderer = await mount(t, async () => ok(current));
  await click(renderer, 'Update to v3.0.9');
  assert.match(textOf(renderer.toJSON()), /Latest versionv3\.0\.9/);
  assert.match(textOf(renderer.toJSON()), /Previous update targetv3\.0\.7/);
  assert.match(textOf(renderer.toJSON()), /Update available/);
  assert.doesNotMatch(textOf(renderer.toJSON()), /[\p{Script=Han}]/u);
});

test('confirmed installation ignores double clicks, polls the Host and stops at manual restart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pendingInstall = deferred();
  const calls = [];
  let current = snapshot();
  const renderer = await mount(t, async (endpoint, payload, signal) => {
    calls.push({ endpoint, payload, signal });
    if (endpoint === 'update.status') return ok(current);
    if (endpoint === 'update.check') return ok(current = available());
    if (endpoint === 'update.install') return pendingInstall.promise;
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  });

  await click(renderer, '检查更新');
  const confirm = buttonNamed(renderer, '安装更新');
  await act(async () => {
    confirm.props.onClick();
    confirm.props.onClick();
    await flushMicrotasks();
  });
  const installs = calls.filter((call) => call.endpoint === 'update.install');
  assert.equal(installs.length, 1);
  assert.deepEqual(Object.keys(installs[0].payload).sort(), ['checkId', 'requestId']);
  assert.equal(installs[0].payload.checkId, 'check_one');
  assert.equal(typeof installs[0].payload.requestId, 'string');
  assert.equal(installs[0].signal, undefined);

  current = installing();
  await act(async () => {
    pendingInstall.resolve(ok(current));
    await flushMicrotasks();
  });
  assert.match(textOf(renderer.toJSON()), /正在安装/);
  await click(renderer, '关闭');
  current = installing('verifying');
  await tick(t);
  await click(renderer, '正在更新…');
  assert.match(textOf(renderer.toJSON()), /正在校验安装结果/);

  current = installing('restart-required');
  current.installedVersion = '3.0.9';
  await tick(t);
  assert.match(textOf(renderer.toJSON()), /已安装，待手动重启/);
  assert.match(textOf(renderer.toJSON()), /已安装版本v3.0.9/);
  assert.equal(buttonNamed(renderer, '安装更新'), undefined);
  assert.equal(buttonNamed(renderer, '重新检查'), undefined);
  const callsAtCompletion = calls.length;
  await tick(t, 10_000);
  assert.equal(calls.length, callsAtCompletion);
  assert.equal(calls.some((call) => /restart|reload/.test(call.endpoint)), false);
  assert.ok(buttonNamed(renderer, '待手动重启'));
});

test('a retry after a lost installation response reuses the same request id', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests = [];
  const renderer = await mount(t, async (endpoint, payload) => {
    if (endpoint === 'update.status') return ok(available());
    if (endpoint === 'update.install') {
      requests.push(payload);
      if (requests.length === 1) throw new Error('Connection closed');
      return ok(installing());
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  });
  await click(renderer, '更新至 v3.0.9');
  await click(renderer, '安装更新');
  assert.match(textOf(renderer.toJSON()), /Connection closed/);
  await click(renderer, '安装更新');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
});

test('a failed npm check cannot reuse an earlier up-to-date result', async (t) => {
  const renderer = await mount(t, async (endpoint) => {
    if (endpoint === 'update.status') {
      return ok(snapshot({ latestVersion: '3.0.8', checkedAt: 1_000, blockedReason: 'no-update' }));
    }
    return { ok: false, error: { code: 'check-failed', message: 'npm timed out' } };
  });
  await click(renderer, '检查更新');
  assert.match(textOf(renderer.toJSON()), /无法访问 npm 或请求超时/);
  assert.match(manualCommandOf(renderer), /@latest$/);
  assert.doesNotMatch(textOf(renderer.toJSON()), /已是最新版本|当前版本无需更新/);
  assert.equal(buttonNamed(renderer, '安装更新'), undefined);
});

test('source installations can check npm but never offer automatic replacement', async (t) => {
  const calls = [];
  const reported = [];
  const renderer = await mount(t, async (endpoint) => {
    calls.push(endpoint);
    return ok(endpoint === 'update.status'
      ? snapshot({ blockedReason: 'source-install' })
      : available({ blockedReason: 'source-install', canInstall: false, checkId: null }));
  }, { onStatus: (value) => reported.push(value) });
  await click(renderer, '检查更新');
  assert.deepEqual(calls, ['update.status', 'update.check']);
  assert.match(textOf(renderer.toJSON()), /当前是源码或链接安装/);
  assert.equal(reported.at(-1).latestVersion, '3.0.9');
  assert.equal(buttonNamed(renderer, '安装更新'), undefined);
});

test('an older Host gives manual update guidance instead of breaking settings', async (t) => {
  const renderer = await mount(t, async () => {
    const error = new Error('Unknown endpoint update.status');
    error.rpcError = { code: 'endpoint-not-found', message: error.message };
    throw error;
  });
  await click(renderer, '检查更新');
  assert.match(textOf(renderer.toJSON()), /当前 Host 不支持更新接口/);
  assert.equal(buttonNamed(renderer, '安装更新'), undefined);
  assert.ok(buttonNamed(renderer, '重新检查'));
});

test('unmount aborts an in-flight status poll and cannot create a zombie timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pendingPoll = deferred();
  const signals = [];
  let reads = 0;
  const reported = [];
  const renderer = await mount(t, async (endpoint, payload, signal) => {
    assert.equal(endpoint, 'update.status');
    signals.push(signal);
    reads += 1;
    return reads === 1 ? ok(installing()) : pendingPoll.promise;
  }, { onStatus: (value) => reported.push(value) });
  await tick(t);
  assert.equal(reads, 2);
  await act(async () => { renderer.unmount(); });
  assert.equal(signals[1].aborted, true);
  await act(async () => {
    pendingPoll.resolve(ok(installing()));
    await flushMicrotasks();
  });
  await tick(t, 10_000);
  assert.equal(reads, 2);
  assert.equal(reported.length, 1);
});

test('unmount aborts a pending version check but does not cancel an installation request', async (t) => {
  const pending = deferred();
  let checkSignal;
  const checking = await mount(t, async (endpoint, payload, signal) => {
    if (endpoint === 'update.status') return ok(snapshot());
    checkSignal = signal;
    return pending.promise;
  });
  await click(checking, '检查更新');
  await act(async () => { checking.unmount(); });
  assert.equal(checkSignal.aborted, true);
  await act(async () => { pending.resolve(ok(available())); });

  const pendingInstall = deferred();
  let installSignal = 'not called';
  const reports = [];
  const installingRenderer = await mount(t, async (endpoint, payload, signal) => {
    if (endpoint === 'update.status') return ok(available());
    assert.equal(endpoint, 'update.install');
    installSignal = signal;
    return pendingInstall.promise;
  }, { onStatus: (value) => reports.push(value) });
  await click(installingRenderer, '更新至 v3.0.9');
  await click(installingRenderer, '安装更新');
  await act(async () => { installingRenderer.unmount(); });
  assert.equal(installSignal, undefined);
  await act(async () => { pendingInstall.resolve(ok(installing())); });
  assert.equal(reports.length, 1);
});

test('pending restart shows manual restart guidance instead of a redundant page refresh suggestion', async (t) => {
  const calls = [];
  const current = installing('restart-required');
  current.installedVersion = '3.0.9';
  const renderer = await mount(t, async (endpoint) => {
    calls.push(endpoint);
    return ok(current);
  }, { clientVersion: '3.0.7' });
  await click(renderer, '待手动重启');
  assert.deepEqual(calls, ['update.status', 'update.status']);
  assert.match(textOf(renderer.toJSON()), /运行版本v3.0.8/);
  assert.match(textOf(renderer.toJSON()), /手动重启当前 Harness 或 Desktop/);
  assert.doesNotMatch(textOf(renderer.toJSON()), /页面版本与运行版本不同|手动刷新页面/);
  assert.equal(buttonNamed(renderer, '安装更新'), undefined);
  assert.equal(buttonNamed(renderer, '重新检查'), undefined);

  const stalePage = await mount(t, async () => ok(available()), { clientVersion: '3.0.7' });
  await click(stalePage, '更新至 v3.0.9');
  assert.match(textOf(stalePage.toJSON()), /页面版本与运行版本不同/);
  assert.match(textOf(stalePage.toJSON()), /手动刷新页面.*手动重启 Harness 或 Desktop/);
});

test('remounting the new client retains the old Host version and restores the restart requirement', async (t) => {
  const calls = [];
  let current = snapshot();
  let headerVersion = '3.0.8';
  const rpcCall = async (endpoint) => {
    calls.push(endpoint);
    return ok(current);
  };
  const onStatus = (value) => { headerVersion = value.runningVersion; };
  const initial = await mount(t, rpcCall, { onStatus });
  await act(async () => { initial.unmount(); });

  current = snapshot({ installedVersion: '3.0.9', blockedReason: 'pending-restart' });
  headerVersion = '3.0.9';
  const remounted = await mount(t, rpcCall, { clientVersion: '3.0.9', onStatus });
  assert.equal(headerVersion, '3.0.8');
  await click(remounted, '待手动重启');
  assert.match(textOf(remounted.toJSON()), /运行版本v3.0.8/);
  assert.match(textOf(remounted.toJSON()), /已安装版本v3.0.9/);
  assert.match(textOf(remounted.toJSON()), /已安装，待手动重启/);
  assert.doesNotMatch(textOf(remounted.toJSON()), /手动刷新页面/);
  assert.equal(buttonNamed(remounted, '安装更新'), undefined);
  assert.equal(buttonNamed(remounted, '重新检查'), undefined);
  assert.deepEqual(calls, ['update.status', 'update.status', 'update.status']);
});

test('manual status refresh observes a restarted Host without remounting or checking npm', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const headerVersions = [];
  let current = snapshot({
    runningVersion: '3.0.7', installedVersion: '3.0.8', blockedReason: 'pending-restart',
    job: { id: 'restart_job', state: 'restart-required', targetVersion: '3.0.8', message: null },
  });
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    return ok(current);
  };
  const renderer = await mount(t, rpcCall, {
    clientVersion: '3.0.7', onStatus: (value) => headerVersions.push(value.runningVersion),
  });
  const originalPanel = renderer.root.findByType(UpdatePanel);
  await click(renderer, '待手动重启');
  const refreshButton = buttonNamed(renderer, '刷新状态');
  assert.ok(refreshButton);
  await tick(t, 10_000);
  assert.equal(calls.length, 2);

  current = { ...current, runningVersion: '3.0.8', blockedReason: null,
    job: { ...current.job, state: 'completed' } };
  await click(renderer, '刷新状态');
  assert.equal(renderer.root.findByType(UpdatePanel), originalPanel);
  assert.equal(originalPanel.props.rpcCall, rpcCall);
  assert.deepEqual(headerVersions, ['3.0.7', '3.0.7', '3.0.8']);
  assert.match(textOf(renderer.toJSON()), /运行版本v3.0.8/);
  assert.match(textOf(renderer.toJSON()), /更新已生效/);
  assert.doesNotMatch(textOf(renderer.toJSON()), /待手动重启/);
  assert.equal(buttonNamed(renderer, '刷新状态'), undefined);
  assert.ok(buttonNamed(renderer, '重新检查') === refreshButton, 'The focused footer button must keep its node identity');
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ({ endpoint: 'update.status', payload: {} })));
  await tick(t, 10_000);
  assert.equal(calls.length, 3);
});

test('a late uncertainty poll cannot restore an old Host after an install retry and manual refresh', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const oldPoll = deferred();
  const headers = [];
  const pending = snapshot({
    runningVersion: '3.0.7', installedVersion: '3.0.8', blockedReason: 'pending-restart',
    job: { id: 'retry_job', state: 'restart-required', targetVersion: '3.0.8', message: null },
  });
  const completed = { ...pending, runningVersion: '3.0.8', blockedReason: null,
    job: { ...pending.job, state: 'completed' } };
  let reads = 0;
  let installs = 0;
  let oldSignal;
  const renderer = await mount(t, async (endpoint, payload, signal) => {
    if (endpoint === 'update.install') {
      installs += 1;
      if (installs === 1) throw new Error('Lost install response');
      return ok(pending);
    }
    assert.equal(endpoint, 'update.status');
    reads += 1;
    if (reads === 1) return ok(available({
      runningVersion: '3.0.7', installedVersion: '3.0.7', latestVersion: '3.0.8',
    }));
    if (reads === 2) {
      oldSignal = signal;
      return oldPoll.promise;
    }
    return ok(completed);
  }, { clientVersion: '3.0.7', onStatus: (value) => headers.push(value.runningVersion) });
  await click(renderer, '更新至 v3.0.8');
  await click(renderer, '安装更新');
  await tick(t);
  await click(renderer, '安装更新');
  assert.equal(oldSignal.aborted, true);
  await click(renderer, '刷新状态');
  await act(async () => {
    oldPoll.resolve(ok(pending));
    await flushMicrotasks();
  });
  assert.deepEqual(headers, ['3.0.7', '3.0.7', '3.0.8']);
  assert.equal(oldSignal.aborted, true);
  assert.match(textOf(renderer.toJSON()), /更新已生效/);
  assert.doesNotMatch(textOf(renderer.toJSON()), /待手动重启/);
  await tick(t, 10_000);
  assert.equal(reads, 3);
});

test('cancelling an uncertainty poll still resumes polling an accepted active installation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const oldPoll = deferred();
  const states = [];
  let reads = 0;
  let installs = 0;
  let oldSignal;
  const renderer = await mount(t, async (endpoint, payload, signal) => {
    if (endpoint === 'update.install') {
      installs += 1;
      if (installs === 1) throw new Error('Lost install response');
      return ok(installing());
    }
    assert.equal(endpoint, 'update.status');
    reads += 1;
    if (reads === 1) return ok(available());
    if (reads === 2) {
      oldSignal = signal;
      return oldPoll.promise;
    }
    return ok(installing('restart-required'));
  }, { onStatus: (value) => states.push(value.job?.state ?? null) });
  await click(renderer, '更新至 v3.0.9');
  await click(renderer, '安装更新');
  await tick(t);
  await click(renderer, '安装更新');
  assert.equal(oldSignal.aborted, true);
  await act(async () => {
    oldPoll.resolve(ok(available()));
    await flushMicrotasks();
  });
  assert.equal(oldSignal.aborted, true);
  assert.match(textOf(renderer.toJSON()), /正在安装/);
  await tick(t);
  assert.deepEqual(states, [null, 'installing', 'restart-required']);
  assert.equal(reads, 3);
});

test('a failed local status refresh releases the button and can be retried', async (t) => {
  const calls = [];
  const pending = snapshot({
    runningVersion: '3.0.7', installedVersion: '3.0.8', blockedReason: 'pending-restart',
  });
  const renderer = await mount(t, async (endpoint) => {
    calls.push(endpoint);
    if (calls.length === 1) return ok(pending);
    if (calls.length === 2) throw new Error('Host is restarting');
    return ok(snapshot({
      job: { id: 'restart_job', state: 'completed', targetVersion: '3.0.8', message: null },
    }));
  }, { clientVersion: '3.0.7' });
  await click(renderer, '待手动重启');
  assert.match(textOf(renderer.toJSON()), /Host is restarting/);
  assert.match(textOf(renderer.toJSON()), /待手动重启/);
  assert.equal(buttonNamed(renderer, '刷新状态').props.disabled, false);
  await click(renderer, '刷新状态');
  assert.match(textOf(renderer.toJSON()), /更新已生效/);
  assert.doesNotMatch(textOf(renderer.toJSON()), /Host is restarting|待手动重启/);
  assert.deepEqual(calls, ['update.status', 'update.status', 'update.status']);
});

test('opening a stale restart notice reads the new Host status once', async (t) => {
  const calls = [];
  const headerVersions = [];
  let current = snapshot({
    runningVersion: '3.0.7', installedVersion: '3.0.8', blockedReason: 'pending-restart',
  });
  const rpcCall = async (endpoint) => {
    calls.push(endpoint);
    return ok(current);
  };
  const renderer = await mount(t, rpcCall, {
    clientVersion: '3.0.7', onStatus: (value) => headerVersions.push(value.runningVersion),
  });
  current = snapshot({
    job: { id: 'restart_job', state: 'completed', targetVersion: '3.0.8', message: null },
  });
  await click(renderer, '待手动重启');
  assert.deepEqual(headerVersions, ['3.0.7', '3.0.8']);
  assert.match(textOf(renderer.toJSON()), /更新已生效/);
  assert.doesNotMatch(textOf(renderer.toJSON()), /待手动重启/);
  assert.deepEqual(calls, ['update.status', 'update.status']);
});

test('unmount aborts a manual status refresh and ignores its late response', async (t) => {
  const pending = deferred();
  const headers = [];
  const signals = [];
  const current = snapshot({
    runningVersion: '3.0.7', installedVersion: '3.0.8', blockedReason: 'pending-restart',
  });
  const renderer = await mount(t, async (endpoint, payload, signal) => {
    assert.equal(endpoint, 'update.status');
    signals.push(signal);
    return signals.length < 3 ? ok(current) : pending.promise;
  }, { onStatus: (value) => headers.push(value.runningVersion) });
  await click(renderer, '待手动重启');
  const refresh = buttonNamed(renderer, '刷新状态');
  await act(async () => {
    refresh.props.onClick();
    refresh.props.onClick();
    await flushMicrotasks();
  });
  assert.equal(signals.length, 3);
  assert.equal(buttonNamed(renderer, '刷新状态').props.disabled, true);
  await act(async () => { renderer.unmount(); });
  assert.equal(signals[2].aborted, true);
  await act(async () => { pending.resolve(ok(snapshot())); });
  assert.deepEqual(headers, ['3.0.7', '3.0.7']);
});

test('disk changes and a persisted failure render actionable localized status', async (t) => {
  const pendingRestart = await mount(t, async () => ok(snapshot({
    installedVersion: '3.0.9', blockedReason: 'pending-restart',
  })));
  await click(pendingRestart, '待手动重启');
  assert.match(textOf(pendingRestart.toJSON()), /已安装，待手动重启/);
  assert.equal(buttonNamed(pendingRestart, '重新检查'), undefined);

  const failed = await mount(t, async () => ok(snapshot({
    job: { id: 'failed_job', state: 'failed', targetVersion: '3.0.9', message: 'install-failed' },
  })));
  await click(failed, '检查更新');
  assert.match(textOf(failed.toJSON()), /上次更新目标v3.0.9/);
  assert.match(textOf(failed.toJSON()), /安装失败，请检查当前安装状态后重试/);
  assert.doesNotMatch(textOf(failed.toJSON()), /install-failed/);

  const uncertain = await mount(t, async () => ok(snapshot({
    job: { id: 'uncertain_job', state: 'interrupted', targetVersion: '3.0.9', message: 'state-unavailable' },
  })));
  await click(uncertain, '检查更新');
  assert.match(textOf(uncertain.toJSON()), /无法安全保存更新状态，请先检查当前安装结果/);
  assert.doesNotMatch(textOf(uncertain.toJSON()), /未开始安装/);
});

test('update confirmation, source protection and failures have English copy', async (t) => {
  setImTranslator((key) => en[key] ?? key);
  t.after(() => setImTranslator(null));
  let current = available();
  const renderer = await mount(t, async (endpoint) => {
    if (endpoint === 'update.install') {
      return { ok: false, error: { code: 'check-expired', message: 'expired' } };
    }
    return ok(current);
  });
  await click(renderer, 'Update to v3.0.9');
  assert.match(textOf(renderer.toJSON()), /Install update/);
  assert.doesNotMatch(textOf(renderer.toJSON()), /[\p{Script=Han}]/u);
  await click(renderer, 'Install update');
  assert.match(textOf(renderer.toJSON()), /version confirmation expired/);
  assert.doesNotMatch(textOf(renderer.toJSON()), /[\p{Script=Han}]/u);
  current = available({ canInstall: false, checkId: null, blockedReason: 'source-install' });
  await click(renderer, 'Check again');
  assert.match(textOf(renderer.toJSON()), /source or linked installation/);
  assert.doesNotMatch(textOf(renderer.toJSON()), /[\p{Script=Han}]/u);
  current = installing('completed');
  current.runningVersion = '3.0.9';
  current.installedVersion = '3.0.9';
  await click(renderer, 'Check again');
  assert.match(textOf(renderer.toJSON()), /Up to date/);
  assert.doesNotMatch(textOf(renderer.toJSON()), /Update is running|[\p{Script=Han}]/u);
});

test('dialog actions retain focus before disabling the initiating button', async (t) => {
  const scenarios = [
    {
      initial: snapshot({ installedVersion: '3.0.9', blockedReason: 'pending-restart' }),
      open: '待手动重启', action: '刷新状态', endpoint: 'update.status',
    },
    { initial: available(), open: '更新至 v3.0.9', action: '重新检查', endpoint: 'update.check' },
    { initial: available(), open: '更新至 v3.0.9', action: '安装更新', endpoint: 'update.install' },
  ];
  for (const scenario of scenarios) {
    const response = deferred();
    const trace = [];
    let submitting = false;
    const renderer = await mount(t, async (endpoint) => {
      if (submitting) {
        trace.push(endpoint);
        return response.promise;
      }
      return ok(scenario.initial);
    });
    await click(renderer, scenario.open);
    const button = buttonNamed(renderer, scenario.action);
    submitting = true;
    await act(async () => {
      button.props.onClick({
        currentTarget: {
          closest(selector) {
            assert.equal(selector, '.dim-updateDialog');
            return { focus() { trace.push('focus'); } };
          },
        },
      });
      await flushMicrotasks();
    });
    assert.deepEqual(trace, ['focus', scenario.endpoint], scenario.action);
    assert.equal(button.props.disabled, true);
    await act(async () => { response.resolve(ok(scenario.initial)); });
  }
});

test('the confirmation supports keyboard focus, tab wrapping, Escape and focus restoration', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previous = { isConnected: true, focus() { document.activeElement = previous; } };
  const first = { focus() { document.activeElement = first; } };
  const last = { focus() { document.activeElement = last; } };
  const dialogNode = {
    focus() { document.activeElement = dialogNode; },
    querySelectorAll(selector) {
      assert.match(selector, /textarea:not\(:disabled\)/);
      return [first, last];
    },
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true, value: { activeElement: previous },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else delete globalThis.document;
  });
  const renderer = await mount(t, async () => ok(available()), {}, {
    createNodeMock(element) {
      return element.props?.className === 'dim-updateDialog' ? dialogNode : null;
    },
  });
  await click(renderer, '更新至 v3.0.9');
  assert.equal(document.activeElement, dialogNode);
  const dialog = renderer.root.findByProps({ role: 'dialog' });
  let prevented = 0;
  await act(async () => {
    dialog.props.onKeyDown({ key: 'Tab', shiftKey: false, preventDefault() { prevented += 1; } });
  });
  assert.equal(document.activeElement, first);
  await act(async () => {
    dialog.props.onKeyDown({ key: 'Tab', shiftKey: true, preventDefault() { prevented += 1; } });
  });
  assert.equal(document.activeElement, last);
  await act(async () => {
    dialog.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  });
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);
  assert.equal(document.activeElement, previous);
  assert.equal(prevented, 2);
});

test('manual commands use the current profile and a known target without downgrading', async (t) => {
  const cases = [
    { profileName: 'web', runningVersion: '3.1.0', installedVersion: '3.1.1',
      blockedReason: 'pending-restart', expected: 'web', version: '3.1.1' },
    { profileName: 'desktop-test', job: { state: 'failed', targetVersion: '3.1.2', message: 'install-failed' },
      expected: 'desktop-test', version: '3.1.2' },
    { profileName: 'web', latestVersion: '3.1.3', job: { state: 'failed', targetVersion: '3.1.2' },
      expected: 'web', version: '3.1.3' },
    { profileName: 'web', runningVersion: '3.1.10', installedVersion: '3.1.10', latestVersion: '3.1.9',
      expected: 'web', version: '3.1.10' },
    { profileName: 'Team One', expected: '"Team One"', version: 'latest' },
    { profileName: '测试环境', expected: '"测试环境"', version: 'latest' },
    { profileName: 'web', latestVersion: '3.1.1; echo unsafe', expected: 'web', version: 'latest' },
    { profileName: 'web', job: { state: 'completed', targetVersion: '3.0.8' }, expected: 'web', version: 'latest' },
    { profileName: 'web', job: { state: 'interrupted', targetVersion: '3.1.5', recoverable: true },
      expected: 'web', version: 'latest' },
    { profileName: 'web', latestVersion: '3.1.3',
      job: { state: 'interrupted', targetVersion: '3.1.5', recoverable: true },
      expected: 'web', version: '3.1.3' },
  ];
  for (const { expected, version, ...fields } of cases) {
    const renderer = await mount(t, async () => ok(snapshot(fields)));
    await click(renderer, fields.blockedReason === 'pending-restart' ? '待手动重启' : '检查更新');
    assert.equal(manualCommandOf(renderer),
      `dsh plugin --profile ${expected} add -w @xmanrui/dsh-im@${version}`);
    assert.equal(renderer.root.findByType('textarea').props.readOnly, true);
    assert.match(textOf(renderer.toJSON()), /自动更新失败可以使用命令更新：/);
    assert.doesNotMatch(textOf(renderer.toJSON()), /通常只需手动重启/);
  }
});

test('manual copying uses an accessible icon at the right of the command row', async (t) => {
  stubClipboard(t, { async writeText() {} });
  const renderer = await mount(t, async () => ok(available()));
  await click(renderer, '更新至 v3.0.9');
  const row = renderer.root.findByProps({ className: 'dim-updateCommandRow' });
  const copy = buttonNamed(renderer, '复制命令');
  assert.equal(row.children[0].type, 'textarea');
  assert.equal(row.children.at(-1), copy);
  assert.equal(copy.props.className, 'dim-updateCopy');
  assert.equal(copy.props.title, '复制命令');
  assert.equal(textOf(copy), '');
  assert.equal(copy.findByType('svg').props['aria-hidden'], 'true');
  assert.equal(copy.findByType('svg').props.focusable, 'false');
  await click(renderer, '复制命令');
  const copied = buttonNamed(renderer, '已复制');
  assert.match(copied.props.className, /dim-updateCopyCopied/);
  assert.equal(copied.props.title, '已复制');
  assert.equal(textOf(copied), '');
  assert.equal(copied.findAllByType('rect').length, 0);
});

test('manual commands remain available after a failed npm check and explain the latest fallback', async (t) => {
  const renderer = await mount(t, async (endpoint) => {
    if (endpoint === 'update.status') return ok(snapshot({ profileName: 'web', environmentKind: 'cli' }));
    throw new Error('npm unavailable');
  });
  await click(renderer, '检查更新');
  assert.match(manualCommandOf(renderer), /@xmanrui\/dsh-im@latest$/);
  assert.match(textOf(renderer.toJSON()), /尚未确认目标版本.*执行时 npm 的 latest/);
  assert.match(textOf(renderer.toJSON()), /DSH_HOME 一致/);
  assert.equal(buttonNamed(renderer, '复制命令').props.disabled, false);
  assert.equal(buttonNamed(renderer, '安装更新'), undefined);
});

test('manual commands cannot overwrite source installs or interpolate unsafe profiles', async (t) => {
  for (const profileName of [null, '', '..', 'node_modules', '-other', '../other', 'work; echo x',
    'work$(echo x)', 'work`echo x`', 'work%PATH%', 'work"name', 'work\nname']) {
    const renderer = await mount(t, async () => ok(snapshot({ profileName })));
    await click(renderer, '检查更新');
    assert.equal(manualCommandOf(renderer), undefined, String(profileName));
    assert.equal(buttonNamed(renderer, '复制命令'), undefined);
  }
  for (const blockedReason of ['source-install', 'pending-restart', 'recovery-required']) {
    const renderer = await mount(t, async () => ok(snapshot({
      blockedReason, ...(blockedReason === 'source-install' ? {} : { sourceInstall: true }),
    })));
    await click(renderer, blockedReason === 'pending-restart' ? '待手动重启' : '检查更新');
    assert.equal(manualCommandOf(renderer), undefined);
    assert.equal(buttonNamed(renderer, '复制命令'), undefined);
    assert.match(textOf(renderer.toJSON()), /不提供覆盖源码的 npm 命令/);
  }
});

test('copying writes exactly the displayed command and never submits an installation', async (t) => {
  const writes = [];
  const calls = [];
  const clipboard = { async writeText(value) { assert.equal(this, clipboard); writes.push(value); } };
  stubClipboard(t, clipboard);
  const renderer = await mount(t, async (endpoint) => {
    calls.push(endpoint);
    return ok(available());
  });
  await click(renderer, '更新至 v3.0.9');
  assert.match(textOf(renderer.toJSON()), /Desktop 的内置终端/);
  const before = [...calls];
  await click(renderer, '复制命令');
  assert.deepEqual(writes, [manualCommandOf(renderer)]);
  assert.deepEqual(calls, before);
  assert.ok(buttonNamed(renderer, '已复制'));
  assert.match(textOf(renderer.toJSON()), /命令已复制/);
});

test('copy failure selects the command for keyboard copying and allows a retry', async (t) => {
  const selection = [];
  let denied = true;
  stubClipboard(t, { async writeText() { if (denied) throw new Error('NotAllowedError'); } });
  const renderer = await mount(t, async () => ok(available()), {}, {
    createNodeMock(element) {
      return element.type === 'textarea' ? {
        focus() { selection.push('focus'); }, select() { selection.push('select'); },
      } : null;
    },
  });
  await click(renderer, '更新至 v3.0.9');
  await click(renderer, '复制命令');
  assert.deepEqual(selection, ['focus', 'select']);
  assert.match(textOf(renderer.root.findByProps({ role: 'alert' })), /Ctrl\+C 或 ⌘C/);
  assert.equal(buttonNamed(renderer, '复制命令').props.disabled, false);
  denied = false;
  await click(renderer, '复制命令');
  assert.ok(buttonNamed(renderer, '已复制'));
  assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 0);
});

test('missing clipboard support exposes a selectable command without claiming success', async (t) => {
  stubClipboard(t, undefined);
  const renderer = await mount(t, async () => ok(available()));
  await click(renderer, '更新至 v3.0.9');
  await click(renderer, '复制命令');
  assert.match(textOf(renderer.toJSON()), /复制失败/);
  assert.ok(manualCommandOf(renderer));
  assert.equal(buttonNamed(renderer, '已复制'), undefined);
});

test('an old clipboard result cannot mark a changed command or reopened dialog as copied', async (t) => {
  const pending = deferred();
  let writes = 0;
  stubClipboard(t, { writeText() { writes += 1; return pending.promise; } });
  const renderer = await mount(t, async (endpoint) => ok(endpoint === 'update.check'
    ? available({ latestVersion: '3.0.10' }) : available()));
  await click(renderer, '更新至 v3.0.9');
  const copy = buttonNamed(renderer, '复制命令');
  await act(async () => { copy.props.onClick(); copy.props.onClick(); await flushMicrotasks(); });
  assert.equal(writes, 1);
  assert.equal(buttonNamed(renderer, '复制中…').props.disabled, true);
  await click(renderer, '重新检查');
  assert.match(manualCommandOf(renderer), /@3\.0\.10$/);
  await act(async () => { pending.resolve(); await flushMicrotasks(); });
  assert.equal(buttonNamed(renderer, '已复制'), undefined);
  await click(renderer, '复制命令');
  assert.ok(buttonNamed(renderer, '已复制'));
  await click(renderer, '关闭');
  await click(renderer, '更新至 v3.0.10');
  assert.ok(buttonNamed(renderer, '复制命令'));
});

test('manual copying is disabled while the Host may still be installing', async (t) => {
  const renderer = await mount(t, async () => ok(installing()));
  await click(renderer, '正在更新…');
  assert.equal(buttonNamed(renderer, '复制命令').props.disabled, true);
  assert.match(textOf(renderer.toJSON()), /确认没有安装进程运行/);
});

test('manual update instructions and copy feedback render in English', async (t) => {
  setImTranslator((key) => en[key] ?? key);
  t.after(() => setImTranslator(null));
  stubClipboard(t, { async writeText() {} });
  const renderer = await mount(t, async () => ok(available()));
  await click(renderer, 'Update to v3.0.9');
  assert.match(textOf(renderer.toJSON()), /Manual update/);
  assert.match(textOf(renderer.toJSON()), /If the automatic update fails, update with this command:/);
  assert.equal(renderer.root.findByType('textarea').props['aria-label'], 'Manual update command');
  assert.equal(buttonNamed(renderer, 'Copy command').props.title, 'Copy command');
  await click(renderer, 'Copy command');
  assert.match(textOf(renderer.toJSON()), /Command copied/);
  assert.doesNotMatch(textOf(renderer.toJSON()), /[\p{Script=Han}]/u);
});
