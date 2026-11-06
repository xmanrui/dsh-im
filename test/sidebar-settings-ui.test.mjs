import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { SidebarSettings, installSidebarVisibilitySync } from '../plugin-src/client/sidebar-settings.js';
import { createSidebarSettingsRpcHandler } from '../plugin-src/host/sidebar-settings.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const result = (mode, visible) => ({ ok: true, value: { mode, visible } });

test('sidebar settings save on selection and roll back failed changes with a retry', async (t) => {
  let fail = true;
  const calls = [];
  let renderer;
  const rpcCall = async (endpoint, payload) => {
    calls.push([endpoint, payload]);
    if (fail) return { ok: false, error: { message: '无法保存' } };
    return result(payload.mode ?? 'auto', payload.mode === 'show');
  };
  t.after(() => act(() => renderer.unmount()));
  await act(async () => { renderer = create(React.createElement(SidebarSettings, { rpcCall })); });
  assert.equal(renderer.root.findByType('select').props.disabled, false);
  fail = false;
  await act(async () => renderer.root.findAllByType('button').find((button) => button.props.type === 'button').props.onClick());
  const select = () => renderer.root.findByType('select');
  assert.equal(select().props.value, 'auto');
  assert.equal(renderer.root.findAllByType('form').length, 0);
  assert.equal(renderer.root.findAllByType('button').length, 0);
  assert.deepEqual(select().findAllByType('option').map((option) => option.props.value), ['auto', 'show', 'hide']);
  for (const mode of ['show', 'hide', 'auto']) {
    await act(async () => select().props.onChange({ target: { value: mode } }));
    assert.deepEqual(calls.at(-1), ['settings.sidebar-entry.set', { mode }]);
    assert.equal(renderer.root.findByProps({ role: 'status' }).children.join(''), '已保存');
  }
  fail = true;
  await act(async () => select().props.onChange({ target: { value: 'hide' } }));
  assert.equal(select().props.value, 'auto', 'a failed change must not appear saved');
  assert.equal(select().props.disabled, false);
  assert.equal(renderer.root.findByProps({ role: 'alert' }).children.join(''), '无法保存');
  fail = false;
  await act(async () => renderer.root.findByType('button').props.onClick());
  assert.deepEqual(calls.at(-1), ['settings.sidebar-entry.set', { mode: 'hide' }]);
  assert.equal(select().props.value, 'hide', 'retry saves the failed selection, not the rolled-back value');
  assert.equal(renderer.root.findAllByType('button').length, 0);
});

test('saving a selection disables changes and prevents concurrent requests', async (t) => {
  const pending = Promise.withResolvers();
  const calls = [];
  let renderer;
  const rpcCall = (endpoint, payload) => {
    if (endpoint.endsWith('.get')) return Promise.resolve(result('auto', true));
    calls.push(payload.mode);
    return pending.promise;
  };
  await act(async () => { renderer = create(React.createElement(SidebarSettings, { rpcCall })); });
  t.after(() => act(() => renderer.unmount()));
  const select = () => renderer.root.findByType('select');
  const change = select().props.onChange;
  await act(async () => {
    void change({ target: { value: 'show' } });
    void change({ target: { value: 'hide' } });
  });
  assert.deepEqual(calls, ['show']);
  assert.equal(select().props.disabled, true);
  assert.equal(select().props.value, 'show');
  assert.equal(renderer.root.findByProps({ role: 'status' }).children.join(''), '保存中…');
  await act(async () => { pending.resolve(result('show', true)); });
  assert.equal(select().props.disabled, false);
  assert.equal(select().props.value, 'show');
});

test('failed configuration reads still allow forced modes and retain retry after a failed save', async (t) => {
  for (const mode of ['show', 'hide']) await t.test(mode, async (t) => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-sidebar-ui-'));
    t.after(() => rm(dshHome, { recursive: true, force: true }));
    await mkdir(join(dshHome, 'integrations/dsh-qq'), { recursive: true });
    await writeFile(join(dshHome, 'integrations/dsh-qq/config.json'), '{broken');
    const handler = createSidebarSettingsRpcHandler({ config: { dshHome } });
    let pending;
    const rpcCall = (...args) => (pending = handler(...args));
    let renderer;
    await act(async () => { renderer = create(React.createElement(SidebarSettings, { rpcCall })); });
    t.after(() => act(() => renderer.unmount()));
    await act(async () => { await pending; });
    const select = () => renderer.root.findByType('select');
    assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 1);
    assert.equal(select().props.disabled, false);
    await act(async () => select().props.onChange({ target: { value: 'auto' } }));
    assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 1, 'auto cannot bypass the broken config');
    assert.equal(renderer.root.findAllByType('button').some((button) => button.props.type === 'button'), true,
      'retry remains available after a failed recovery save');
    await act(async () => select().props.onChange({ target: { value: mode } }));
    assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 0);
    assert.equal(renderer.root.findByProps({ role: 'status' }).children.join(''), '已保存');
    assert.deepEqual((await handler('settings.sidebar-entry.get', {})).value, { mode, visible: mode === 'show' });
  });
});

function syncHarness(t) {
  const calls = [];
  const visible = [];
  const timers = new Map();
  let id = 0;
  const sync = installSidebarVisibilitySync({
    rpcCall: (_endpoint, _payload, signal) => new Promise((resolve, reject) => calls.push({ resolve, reject, signal })),
    setVisible: (value) => visible.push(value),
    setTimeoutFn(callback, delay) { timers.set(++id, { callback, delay }); return id; },
    clearTimeoutFn(timer) { timers.delete(timer); },
  });
  t.after(() => sync.dispose());
  return { sync, calls, visible, timers, tick() {
    const [key, timer] = timers.entries().next().value;
    timers.delete(key); timer.callback();
  } };
}

test('visibility sync applies startup and cross-client changes and retains visibility on failure', async (t) => {
  const host = syncHarness(t);
  host.calls[0].resolve(result('auto', false));
  await flush();
  assert.deepEqual(host.visible, [false]);
  assert.equal([...host.timers.values()][0].delay, 30_000);
  host.tick(); host.calls[1].resolve(result('auto', true)); await flush();
  assert.deepEqual(host.visible, [false, true]);
  host.sync.refresh(); host.tick(); host.calls[2].reject(Error('offline')); await flush();
  assert.deepEqual(host.visible, [false, true]);
  host.tick(); host.calls[3].resolve({ ok: false }); await flush();
  assert.deepEqual(host.visible, [false, true]);
});

test('in-flight reads cannot undo a saved preference or resurrect an unmounted entry', async (t) => {
  const host = syncHarness(t);
  host.sync.apply(result('hide', false));
  host.calls[0].resolve(result('auto', true)); await flush();
  assert.deepEqual(host.visible, [false]);
  host.tick();
  host.sync.refresh(); host.sync.refresh();
  host.calls[1].resolve(result('auto', true)); await flush();
  assert.deepEqual(host.visible, [false], 'read predating channel mutation is stale');
  host.tick(); host.calls[2].resolve(result('auto', false)); await flush();
  assert.deepEqual(host.visible, [false, false]);
  host.tick(); host.sync.dispose();
  assert.equal(host.calls[3].signal.aborted, true);
  host.calls[3].resolve(result('show', true)); await flush();
  assert.deepEqual(host.visible, [false, false]);
  assert.equal(host.timers.size, 0);
});
