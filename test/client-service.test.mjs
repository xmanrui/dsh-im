import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer from 'react-test-renderer';

import { apply, inject, IMSettingsTab } from '../plugin-src/client/index.js';
import { en, setImTranslator } from '../plugin-src/client/i18n.js';
import { IMPanelErrorBoundary } from '../plugin-src/client/panel-error-boundary.js';

const { act, create } = TestRenderer;
const once = (fn) => {
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    fn();
  };
};

// Model declaration lifetimes, not just callback invocation: an injection
// disposer cancels both a future wait and the current declaration's effect.
function harness({ ready = true, provide = true, onProvide } = {}) {
  let declared = ready;
  let language = 'zh';
  let made = 0;
  const subscriptions = new Set();
  const entries = new Set();
  const effects = [];
  const listeners = new Set();
  const services = new Map();
  const calls = [];
  const ctx = {
    effect(install) {
      const cleanup = install();
      const stop = once(() => cleanup?.());
      effects.push(stop);
      return stop;
    },
    on(event, listener) {
      assert.equal(event, 'locale/change');
      listeners.add(listener);
      return once(() => listeners.delete(listener));
    },
    locale: {
      register: () => () => {},
      bind: () => (text) => language === 'en' ? en[text] ?? text : text,
      getLocale: () => ({ active: language }),
    },
    connection: { rpc: { call: (...args) => {
      calls.push(args);
      // No network or polling completion is needed to test the panel wiring.
      return new Promise(() => {});
    } } },
    workspaces: {
      listDirectory: async (path) => ({ path, entries: [] }),
      pickDirectory: async () => '/chosen',
    },
    slots: {
      inject(name, install) {
        assert.equal(name, 'settings.section');
        const item = { cleanup: null, install };
        subscriptions.add(item);
        if (declared) item.cleanup = install();
        return once(() => {
          subscriptions.delete(item);
          item.cleanup?.();
          item.cleanup = null;
        });
      },
      register(options, component) {
        assert.ok(declared);
        assert.equal(entries.size, 0, 'duplicate IM settings registration');
        const entry = { options, component };
        entries.add(entry);
        made += 1;
        return once(() => entries.delete(entry));
      },
    },
  };
  if (provide) ctx.provide = (name, value) => ctx.effect(() => {
    services.set(name, value);
    onProvide?.(value);
    return () => services.delete(name);
  });
  return {
    ctx, entries, subscriptions, services, calls, listeners,
    get service() { return services.get('dshImClient'); },
    get made() { return made; },
    declare(value) {
      if (declared === value) return;
      declared = value;
      for (const item of subscriptions) {
        item.cleanup?.();
        item.cleanup = value ? item.install() : null;
      }
    },
    locale(value) {
      language = value;
      for (const listener of listeners) listener();
    },
    dispose() {
      for (const stop of effects.reverse()) stop();
      setImTranslator(null);
    },
  };
}

function start(t, options) {
  const host = harness(options);
  apply(host.ctx);
  t.after(() => host.dispose());
  return host;
}

test('web keeps its one bilingual settings entry, including hosts without provide', (t) => {
  for (const provide of [true, false]) {
    const host = start(t, { provide });
    assert.equal(host.entries.size, 1);
    const { options, component } = [...host.entries][0];
    assert.equal(options.id, 'xmanrui-dsh-im');
    assert.equal(options.order, 21);
    assert.equal(options.label(), 'IM机器人');
    assert.equal(options.locale, 'dsh-im');
    const markup = renderToStaticMarkup(React.createElement(component));
    assert.match(markup, /DSH-IM/);
    assert.match(markup, /id="dim-panel-weixin"/);
    assert.equal(Boolean(host.service), provide);
    if (provide) {
      assert.equal(host.service.version, 1);
      assert.equal(Object.isFrozen(host.service), true);
    }
  }
});

test('hide cancels a pending declaration and show restores exactly one waiter', (t) => {
  const host = start(t, { ready: false });
  const im = host.service;
  assert.equal(im.settingsVisible(), false);
  im.setSettingsVisible(false);
  host.declare(true);
  assert.equal(host.entries.size, 0);
  assert.equal(host.subscriptions.size, 0);
  im.setSettingsVisible(true);
  im.setSettingsVisible(true);
  assert.equal(im.settingsVisible(), true);
  assert.equal(host.entries.size, 1);
  assert.equal(host.subscriptions.size, 1);
  assert.equal(host.made, 1);
});

test('hide/show are idempotent and follow slot withdrawal and re-declaration', (t) => {
  const host = start(t);
  const im = host.service;
  im.setSettingsVisible(true);
  assert.equal(host.made, 1);
  im.setSettingsVisible(false);
  im.setSettingsVisible(false);
  assert.equal(im.settingsVisible(), false);
  assert.equal(host.entries.size, 0);
  im.setSettingsVisible(true);
  assert.equal(host.made, 2);
  host.declare(false);
  assert.equal(im.settingsVisible(), false);
  assert.equal(host.entries.size, 0);
  assert.equal(host.subscriptions.size, 1);
  host.declare(true);
  assert.equal(host.entries.size, 1);
  assert.equal(im.settingsVisible(), true);
  im.setSettingsVisible(false);
  host.declare(false);
  host.declare(true);
  assert.equal(host.entries.size, 0);
});

test('a consumer hiding during service discovery is not overridden by initialization', (t) => {
  const host = start(t, { onProvide: (im) => im.setSettingsVisible(false) });
  assert.equal(host.entries.size, 0);
  assert.equal(host.subscriptions.size, 0);
  assert.equal(host.service.settingsVisible(), false);
});

test('invalid visibility values cannot accidentally hide or show the entry', (t) => {
  const host = start(t);
  for (const value of ['false', null, undefined, 0, 1]) {
    assert.throws(() => host.service.setSettingsVisible(value), TypeError);
  }
  assert.equal(host.entries.size, 1);
  assert.equal(host.made, 1);
});

test('disposing a waiting or mounted plugin removes services and rejects stale resurrection', () => {
  for (const ready of [true, false]) {
    const host = harness({ ready });
    apply(host.ctx);
    const im = host.service;
    // Include injections made after the initial effect has finished.
    im.setSettingsVisible(false);
    im.setSettingsVisible(true);
    host.dispose();
    im.setSettingsVisible(true);
    im.setSettingsVisible(false);
    host.declare(true);
    assert.equal(im.settingsVisible(), false);
    assert.equal(im.render(), null);
    assert.equal(host.services.size, 0);
    assert.equal(host.entries.size, 0);
    assert.equal(host.subscriptions.size, 0);
    assert.equal(host.listeners.size, 0);
  }
});

test('visibility belongs to one client instance even when both share a host connection', (t) => {
  const web = start(t);
  const desktop = harness();
  desktop.ctx.connection = web.ctx.connection;
  apply(desktop.ctx);
  t.after(() => desktop.dispose());
  desktop.service.setSettingsVisible(false);
  assert.equal(desktop.entries.size, 0);
  assert.equal(web.entries.size, 1);
  assert.equal(web.service.settingsVisible(), true);
});

test('render returns fresh elements of a stable type without changing settings or making RPCs', (t) => {
  const host = start(t);
  const before = host.calls.length;
  const first = host.service.render();
  const second = host.service.render();
  assert.notEqual(first, second);
  assert.equal(first.type, second.type);
  assert.equal(host.calls.length, before);
  assert.equal(host.entries.size, 1);
  const entry = [...host.entries][0];
  assert.equal(entry.component().type, first.type, 'both entries share the panel builder');
});

test('preferred section is initial-only, invalid sections retain the web default', (t) => {
  const host = start(t);
  for (const id of ['weixin', 'feishu', 'dingtalk', 'wecom', 'wecomApp', 'qq', 'slack',
    'telegram', 'discord', 'whatsapp', 'imessage', 'matrix', 'office', 'global-settings', 'unknown', undefined]) {
    const markup = renderToStaticMarkup(host.service.render({ preferredSectionId: id }));
    const expected = !id || id === 'unknown' ? 'weixin' : id;
    assert.ok(markup.includes(`id="dim-panel-${expected}"`), String(id));
  }
  let renderer;
  act(() => { renderer = create(host.service.render({ preferredSectionId: 'feishu' })); });
  t.after(() => act(() => renderer.unmount()));
  act(() => renderer.root.findByProps({ id: 'dim-tab-qq' }).props.onClick());
  act(() => renderer.update(host.service.render({ preferredSectionId: 'telegram' })));
  assert.equal(renderer.root.findByProps({ role: 'tabpanel' }).props.id, 'dim-panel-qq');
});

test('embedded panel receives the same management calls and picker, ignoring injected overrides', async (t) => {
  const host = start(t);
  const dependencies = [...host.entries][0].options.inject();
  host.service.setSettingsVisible(false);
  let renderer;
  act(() => { renderer = create(host.service.render({ feishuRpcCall: () => { throw Error('override'); } })); });
  t.after(() => act(() => renderer.unmount()));
  const props = renderer.root.findByType(IMSettingsTab).props;
  for (const [name, value] of Object.entries(dependencies)) assert.equal(props[name], value, name);
  const before = host.calls.length;
  const signal = new AbortController().signal;
  for (const name of ['feishuRpcCall', 'emailRpcCall', 'matrixRpcCall', 'updateRpcCall', 'deliveryRpcCall', 'globalSettingsRpcCall']) {
    props[name]('check', { test: true }, signal);
  }
  assert.equal(host.calls.length, before + 6);
  assert.deepEqual(host.calls.slice(before).map((args) => args.slice(1)), [
    ['dsh-im/feishu', { method: 'check', payload: { test: true } }, signal],
    ['dsh-im/email', { method: 'check', payload: { test: true } }, signal],
    ['dsh-im/matrix', { method: 'check', payload: { test: true } }, signal],
    ['dsh-im/dsh-im', { method: 'check', payload: { test: true } }, signal],
    ['dsh-im/dsh-im-delivery', { method: 'check', payload: { test: true } }, signal],
    ['dsh-im/dsh-im-settings', { method: 'check', payload: { test: true } }, signal],
  ]);
  assert.deepEqual(await props.workspaceDirectoryPicker.listDirectory('/tmp'), { path: '/tmp', entries: [] });
  assert.equal(await props.workspaceDirectoryPicker.pickDirectory(), '/chosen');
  assert.equal(host.service.settingsVisible(), false);
  assert.equal(host.listeners.size, 2, 'language mirror stays installed alongside the panel subscription');
});

test('embedded panel changes language without remounting and unsubscribes on unmount', (t) => {
  const host = start(t);
  let renderer;
  act(() => { renderer = create(host.service.render()); });
  act(() => renderer.root.findByProps({ id: 'dim-tab-qq' }).props.onClick());
  assert.equal(host.listeners.size, 2);
  act(() => host.locale('en'));
  assert.match(JSON.stringify(renderer.toJSON()), /General settings/);
  assert.equal(renderer.root.findByProps({ role: 'tabpanel' }).props.id, 'dim-panel-qq');
  act(() => host.locale('zh'));
  assert.match(JSON.stringify(renderer.toJSON()), /通用设置/);
  act(() => renderer.unmount());
  assert.equal(host.listeners.size, 1);
});

test('panel-local render failure is recoverable and never takes down its sibling', (t) => {
  let fail = true;
  const Child = () => {
    if (fail) throw new Error('test render failure');
    return React.createElement('p', null, 'recovered');
  };
  t.mock.method(console, 'error', () => {});
  let renderer;
  act(() => { renderer = create(React.createElement(React.Fragment, null,
    React.createElement('p', null, 'shell stays'),
    React.createElement(IMPanelErrorBoundary, null, React.createElement(Child)))); });
  t.after(() => act(() => renderer.unmount()));
  assert.match(JSON.stringify(renderer.toJSON()), /shell stays/);
  assert.match(JSON.stringify(renderer.toJSON()), /IM 面板加载失败/);
  fail = false;
  act(() => renderer.root.findByType('button').props.onClick());
  assert.match(JSON.stringify(renderer.toJSON()), /recovered/);
  assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 0);
});

test('real Cordis consumer is activated and its UI is cleaned when the provider unloads', async (t) => {
  const root = new Context();
  const host = harness();
  for (const name of inject) root.provide(name, host.ctx[name]);
  let im;
  let renderer;
  let cleanups = 0;
  const consumer = root.plugin({
    name: 'test-im-client-consumer',
    inject: ['dshImClient'],
    apply(ctx) {
      im = ctx.dshImClient;
      im.setSettingsVisible(false);
      act(() => { renderer = create(im.render()); });
      return () => {
        act(() => renderer.unmount());
        im.setSettingsVisible(true);
        cleanups += 1;
      };
    },
  });
  const provider = root.plugin({ name: 'test-im-client', inject, apply });
  t.after(async () => {
    await provider.dispose();
    await consumer.dispose();
    setImTranslator(null);
  });
  await provider.await();
  await consumer.await();
  assert.ok(im, 'the service is discoverable through real Cordis injection');
  assert.ok(renderer.toJSON());
  assert.equal(host.entries.size, 0);
  im.setSettingsVisible(true);
  assert.equal(host.entries.size, 1);
  await provider.dispose();
  assert.equal(cleanups, 1);
  assert.equal(root.get('dshImClient'), undefined);
  assert.equal(renderer.toJSON(), null);
  assert.equal(host.entries.size, 0);
  assert.equal(host.subscriptions.size, 0);
  assert.equal(im.render(), null);
  im.setSettingsVisible(true);
  assert.equal(host.entries.size, 0);
});
