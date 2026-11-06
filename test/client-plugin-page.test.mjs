import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { en } from '../plugin-src/client/i18n.js';
import { IM_MAIN_PANEL_ID, installImPluginPage } from '../plugin-src/client/plugin-page.js';
import { apply as applyClient } from '../plugin-src/client/index.js';
import { CHANNEL_SESSIONS_PANEL_ID } from '../plugin-src/client/im-channels.js';

const { act, create } = TestRenderer;
const packageName = '@xmanrui/dsh-im';
const bundle = { kind: 'bundle', pkg: { name: packageName } };
const flush = () => new Promise((resolve) => setImmediate(resolve));

function slotLedger(ready) {
  const declarations = new Set(ready ? ['main', 'plugins.detail.actions', 'sidebar.panellist', 'settings.section'] : []);
  const entries = new Map();
  const waiting = new Set();
  return {
    entries,
    waiting,
    inject(name, install) {
      const item = { name, install, cleanup: undefined };
      waiting.add(item);
      if (declarations.has(name)) item.cleanup = install();
      return () => { waiting.delete(item); item.cleanup?.(); };
    },
    register(options, component) {
      assert.ok(declarations.has(options.name));
      const key = entries.has(options.name)
        ? `${options.name}:${options.key ?? options.id}` : options.name;
      assert.ok(!entries.has(key), 'no duplicate registrations');
      entries.set(key, { options, component });
      const owner = [...waiting].reverse().find(item =>
        item.name === options.name && item.registration === undefined);
      if (owner) owner.registration = options;
      return () => entries.delete(key);
    },
    declare(name, available) {
      if (available === declarations.has(name)) return;
      if (available) declarations.add(name);
      else declarations.delete(name);
      for (const item of [...waiting]) {
        if (item.name !== name) continue;
        item.cleanup?.();
        item.registration = undefined;
        item.cleanup = available ? item.install() : undefined;
      }
    },
  };
}

async function start(t, { ready = true, sidebarVisible = true } = {}) {
  const root = new Context();
  const slots = slotLedger(ready);
  const selected = [];
  let renders = 0;
  let visibility;
  root.provide('slots', slots);
  root.provide('locale', { bind: () => (key) => key });
  const plugin = root.plugin({
    name: 'test-plugin-page',
    apply(ctx) {
      visibility = installImPluginPage(ctx, {
        packageName,
        sidebarVisible,
        renderPanel: () => { renders++; return React.createElement('p', null, 'Shared IM panel'); },
      });
    },
  });
  const providers = [];
  t.after(async () => {
    await plugin.dispose();
    for (const provider of providers) await provider.dispose();
  });
  await plugin.await();
  return {
    slots, selected, plugin,
    setSidebarVisible: (value) => visibility.setSidebarVisible(value),
    get renders() { return renders; },
    async provideNavigation() {
      const provider = root.plugin({
        name: 'test-navigation',
        apply(ctx) {
          ctx.provide('layout', { selectPanel: (id) => selected.push(id) });
        },
      });
      providers.push(provider);
      await provider.await();
      await flush();
      return provider;
    },
    element(name, props = {}, language = 'zh') {
      const { options, component } = slots.entries.get(name);
      assert.equal(options.locale, 'dsh-im');
      return React.createElement(component, {
        ...options.inject?.(), ...props,
        t: (key) => language === 'en' ? en[key] : key,
      });
    },
  };
}

test('localized detail action opens the shared IM panel without a back button', async (t) => {
  const host = await start(t);
  await host.provideNavigation();
  assert.equal(host.renders, 0, 'registration must not mount the management panel');
  assert.equal(host.slots.entries.get('main').options.key, IM_MAIN_PANEL_ID);
  let renderer;
  t.after(() => act(() => renderer?.unmount()));
  act(() => { renderer = create(host.element('plugins.detail.actions', { subject: bundle })); });
  assert.deepEqual(renderer.root.findByType('button').children, ['打开 IM机器人']);
  act(() => renderer.update(host.element('plugins.detail.actions', { subject: bundle }, 'en')));
  const open = renderer.root.findByType('button');
  assert.equal(open.props.type, 'button');
  assert.deepEqual(open.children, ['Open IM bots']);
  act(() => open.props.onClick());
  assert.deepEqual(host.selected, [IM_MAIN_PANEL_ID]);
  act(() => renderer.update(host.element('main', {}, 'en')));
  assert.equal(host.renders, 1);
  assert.deepEqual(renderer.root.findByType('p').children, ['Shared IM panel']);
  assert.equal(renderer.root.findAllByType('button').length, 0);
});

test('sidebar toggling preserves other entries and cancels pending registrations', async (t) => {
  const host = await start(t, { sidebarVisible: false });
  host.setSidebarVisible(false);
  const navigation = await host.provideNavigation();
  assert.equal(host.slots.entries.size, 2);
  for (let i = 0; i < 3; i++) {
    host.setSidebarVisible(true);
    host.setSidebarVisible(true);
    assert.equal(host.slots.entries.size, 3);
    host.setSidebarVisible(false);
    host.setSidebarVisible(false);
    assert.equal(host.slots.entries.size, 2);
  }
  host.slots.declare('sidebar.panellist', false);
  host.setSidebarVisible(true);
  host.setSidebarVisible(false);
  host.slots.declare('sidebar.panellist', true);
  assert.equal(host.slots.entries.size, 2);
  host.slots.declare('main', false);
  host.slots.declare('main', true);
  assert.equal(host.slots.entries.size, 2);
  await navigation.dispose();
  host.setSidebarVisible(true);
  await host.provideNavigation();
  assert.equal(host.slots.entries.size, 3);
  host.setSidebarVisible(false);
  await host.plugin.dispose();
  host.setSidebarVisible(true);
  assert.equal(host.slots.entries.size, 0);
  assert.equal(host.slots.waiting.size, 0);
});

test('the action is limited to dsh-im bundle and component details', async (t) => {
  const host = await start(t);
  await host.provideNavigation();
  let renderer;
  t.after(() => act(() => renderer?.unmount()));
  for (const subject of [undefined, { kind: 'item', id: packageName },
    { kind: 'bundle', pkg: { name: '@other/plugin' } },
    { kind: 'row', pkg: bundle.pkg, row: { moduleName: '@other/plugin' } }]) {
    act(() => { renderer = create(host.element('plugins.detail.actions', { subject })); });
    assert.equal(renderer.toJSON(), null);
    act(() => renderer.unmount());
  }
  const subject = { kind: 'row', pkg: bundle.pkg, row: { moduleName: packageName } };
  act(() => { renderer = create(host.element('plugins.detail.actions', { subject })); });
  assert.equal(renderer.root.findAllByType('button').length, 1);
});

test('sidebar opens the existing main panel with a regular-weight linked-bubble icon at the requested size', async (t) => {
  const host = await start(t);
  await host.provideNavigation();
  const { options } = host.slots.entries.get('sidebar.panellist');
  assert.equal(options.id, host.slots.entries.get('main').options.key);
  assert.equal(options.label(), 'IM机器人');
  assert.ok(host.slots.entries.has('plugins.detail.actions'));
  let renderer;
  t.after(() => act(() => renderer?.unmount()));
  for (const size of [16, 18]) {
    act(() => { renderer = create(host.element('sidebar.panellist', { size })); });
    const icon = renderer.root.findByType('svg');
    assert.equal(icon.props['aria-hidden'], true);
    assert.equal(icon.props.width, size);
    assert.equal(icon.props.height, size);
    assert.equal(icon.props.stroke, 'currentColor');
    assert.equal(icon.props.strokeWidth, 1);
    act(() => renderer.unmount());
  }
  assert.equal(host.renders, 0, 'the sidebar must not mount a second management panel');
  host.slots.declare('sidebar.panellist', false);
  assert.equal(host.slots.entries.size, 2, 'original main panel and details action remain available');
  host.slots.declare('sidebar.panellist', true);
  assert.equal(host.slots.entries.size, 3);
});

test('optional services can arrive late and withdrawing navigation removes all entries', async (t) => {
  const host = await start(t);
  assert.equal(host.slots.entries.size, 0);
  const navigation = await host.provideNavigation();
  assert.equal(host.slots.entries.size, 3);
  await navigation.dispose();
  await flush();
  assert.equal(host.slots.entries.size, 0);
  assert.equal(host.slots.waiting.size, 0);
});

test('slot withdrawal and plugin disposal cancel active registrations and pending waits', async (t) => {
  const host = await start(t, { ready: false });
  await host.provideNavigation();
  assert.equal(host.slots.entries.size, 0);
  host.slots.declare('main', true);
  assert.equal(host.slots.entries.size, 1);
  host.slots.declare('plugins.detail.actions', true);
  assert.equal(host.slots.entries.size, 2);
  host.slots.declare('sidebar.panellist', true);
  assert.equal(host.slots.entries.size, 3);
  host.slots.declare('main', false);
  assert.equal(host.slots.entries.size, 0);
  host.slots.declare('main', true);
  assert.equal(host.slots.entries.size, 3);
  host.slots.declare('plugins.detail.actions', false);
  await host.plugin.dispose();
  host.slots.declare('plugins.detail.actions', true);
  assert.equal(host.slots.entries.size, 0);
  assert.equal(host.slots.waiting.size, 0);
});

test('client startup waits for configuration before showing the sidebar', async (t) => {
  for (const [scenario, initial, visible] of [
    ['configured auto', { ok: true, value: { mode: 'auto', visible: false } }, false],
    ['zero channels', { ok: true, value: { mode: 'auto', visible: true } }, true],
    ['always show', { ok: true, value: { mode: 'show', visible: true } }, true],
    ['always hide', { ok: true, value: { mode: 'hide', visible: false } }, false],
    ['unavailable Host', { ok: false, error: { message: 'unavailable' } }, false],
  ]) await t.test(scenario, async (t) => {
    const root = new Context();
    const slots = slotLedger(true);
    const hasImSidebar = () => [...slots.entries.values()].some(({ options }) =>
      options.name === 'sidebar.panellist' && options.id === IM_MAIN_PANEL_ID);
    let finishInitial;
    const calls = [];
    const selected = [];
    root.provide('slots', slots);
    root.provide('locale', { register: () => () => {}, bind: () => (key) => key });
    root.provide('workspaces', {});
    root.provide('layout', { selectPanel: (id) => selected.push(id) });
    root.provide('connection', { rpc: { call: async (_path, _channel, { method, payload }) => {
      calls.push({ channel: _channel, method });
      if (method === 'settings.sidebar-entry.get') return new Promise((resolve) => { finishInitial = resolve; });
      if (method === 'settings.sidebar-entry.set') return { ok: true, value: { mode: payload.mode, visible: payload.mode === 'show' } };
      return { ok: true, value: {} };
    } } });
    const plugin = root.plugin({ name: 'test-client-sidebar', apply: applyClient });
    t.after(() => plugin.dispose());
    await plugin.await();
    await flush();
    assert.equal(slots.entries.size, 4,
      'both main panels, plugin details and settings are registered without a history sidebar');
    assert.equal([...slots.entries.values()].some(({ options }) =>
      options.name === 'sidebar.panellist' && options.id === CHANNEL_SESSIONS_PANEL_ID), false);
    assert.equal(hasImSidebar(), false);
    assert.equal([...slots.waiting].some(item => item.name === 'sidebar.panellist'
      && item.registration?.id === IM_MAIN_PANEL_ID), false,
    'loading must not enqueue the IM sidebar registration that could flash when the slot arrives');
    finishInitial(initial);
    await flush();
    assert.equal(hasImSidebar(), visible);
    assert.equal(slots.entries.size, visible ? 5 : 4);
    if (scenario === 'always hide') {
      const page = [...slots.entries.values()].find(({ options }) => options.key === IM_MAIN_PANEL_ID);
      let renderer;
      await act(async () => {
        renderer = create(React.createElement(page.component, page.options.inject()));
        await flush();
      });
      const entry = renderer.root.findByProps({ className: 'dim-sessionHistoryButton' });
      assert.equal(entry.props['aria-label'], '会话记录');
      act(() => entry.props.onClick());
      assert.deepEqual(selected, [CHANNEL_SESSIONS_PANEL_ID]);
      act(() => renderer.unmount());
    }
    const { globalSettingsRpcCall } = slots.entries.get('settings.section').options.inject();
    await globalSettingsRpcCall('settings.sidebar-entry.set', { mode: 'show' });
    assert.equal(slots.entries.size, 5);
    await globalSettingsRpcCall('settings.sidebar-entry.set', { mode: 'hide' });
    assert.equal(slots.entries.size, 4);
    assert.ok(calls.filter(({ method }) => method.startsWith('settings.sidebar-entry.'))
      .every(({ channel }) => channel === 'dsh-im/dsh-im-sidebar'));
    await globalSettingsRpcCall('settings.group-history.get', {});
    assert.deepEqual(calls.at(-1), { channel: 'dsh-im/dsh-im-settings', method: 'settings.group-history.get' });
    await plugin.dispose();
    assert.equal(slots.entries.size, 0);
    assert.equal(slots.waiting.size, 0);
  });
});
