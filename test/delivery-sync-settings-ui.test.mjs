import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';

import {
  DeliverySyncSettings,
  messageLanguageFromSnapshot,
} from '../plugin-src/client/delivery-sync-settings.js';
import { GlobalSettingsPanel } from '../plugin-src/client/global-settings.js';
import { setImTranslator, en, ru } from '../plugin-src/client/i18n.js';
import { DEFAULT_DELIVERY_SYNC_SETTINGS } from '../src/channels/shared/delivery-sync-settings.mjs';

const LANGUAGE_SNAPSHOT = { language: 'en', tag: 'en', source: 'settings', pinned: false };

function fixture({ stored = {}, snapshot = LANGUAGE_SNAPSHOT, failSet = false } = {}) {
  const calls = [];
  const values = { ...DEFAULT_DELIVERY_SYNC_SETTINGS, ...stored };
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === 'settings.delivery-sync.get') return { ok: true, value: { ...values } };
    if (endpoint === 'settings.delivery-sync.set') {
      if (failSet) return { ok: false, error: { message: '写入失败' } };
      Object.assign(values, payload);
      return { ok: true, value: { ...values } };
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
  const languageRpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === 'settings.language.get') return { ok: true, value: snapshot };
    if (endpoint === 'settings.language.set') {
      if (failSet) return { ok: false, error: { message: '写入失败' } };
      return {
        ok: true,
        value: payload.language === 'auto'
          ? LANGUAGE_SNAPSHOT
          : { language: payload.language, tag: payload.language, source: 'explicit', pinned: false },
      };
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
  return { calls, rpcCall, languageRpcCall };
}

test('the Delivery tab loads, edits, and saves both switches, icons, and the language', async (t) => {
  t.after(() => setImTranslator((key) => key));
  const { calls, rpcCall, languageRpcCall } = fixture({
    stored: { deliverModelAnswers: true, inputIcon: '👤' },
  });
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(GlobalSettingsPanel, {
      rpcCall, deliverySyncRpcCall: rpcCall, languageRpcCall,
    }));
  });
  const tabButton = renderer.root.findAllByType('button')
    .find((button) => button.props.id === 'dim-general-settings-tab-delivery');
  assert.equal(tabButton.props['aria-selected'], false);
  await act(async () => tabButton.props.onClick());
  assert.equal(
    renderer.root.findAllByType('button')
      .find((button) => button.props.id === 'dim-general-settings-tab-delivery')
      .props['aria-selected'],
    true,
  );

  const checkboxes = () => renderer.root.findAllByType('input').filter((input) => input.props.type === 'checkbox');
  const iconFields = () => renderer.root.findAllByType('input').filter((input) => input.props.type === 'text');
  const select = () => renderer.root.findByType('select');
  assert.deepEqual(checkboxes().map((input) => input.props.checked), [false, true]);
  assert.deepEqual(iconFields().map((input) => input.props.value), ['👤', '']);
  assert.equal(select().props.value, 'auto');
  assert.deepEqual(
    select().findAllByType('option').map((option) => option.props.value),
    ['auto', 'zh', 'en', 'ru'],
  );

  await act(async () => checkboxes()[0].props.onChange({ target: { checked: true } }));
  await act(async () => iconFields()[0].props.onChange({ target: { value: ' 🔔 ' } }));
  await act(async () => iconFields()[1].props.onChange({ target: { value: '🤖' } }));
  await act(async () => select().props.onChange({ target: { value: 'ru' } }));
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));

  assert.deepEqual(calls.at(-2), { endpoint: 'settings.language.set', payload: { language: 'ru' } });
  assert.deepEqual(calls.at(-1), {
    endpoint: 'settings.delivery-sync.set',
    payload: {
      mirrorUserInput: true,
      deliverModelAnswers: true,
      inputIcon: '🔔',
      modelIcon: '🤖',
    },
  });
  assert.equal(renderer.root.findByProps({ role: 'status' }).children.join(''), '已保存');
  act(() => renderer.unmount());
});

test('a failed save keeps the typed values, reports the RPC message, and unlocks the form', async (t) => {
  t.after(() => setImTranslator((key) => key));
  const { rpcCall, languageRpcCall } = fixture({ failSet: true });
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(DeliverySyncSettings, { rpcCall, languageRpcCall }));
  });
  const iconFields = () => renderer.root.findAllByType('input').filter((input) => input.props.type === 'text');
  await act(async () => iconFields()[1].props.onChange({ target: { value: '🤖' } }));
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.equal(iconFields()[1].props.value, '🤖');
  assert.equal(renderer.root.findByProps({ role: 'alert' }).children.join(''), '写入失败');
  const submit = renderer.root.findAllByType('button').find((button) => button.props.type === 'submit');
  assert.equal(submit.props.disabled, false);
  act(() => renderer.unmount());
});

test('the language select shows the pinned language only while it is in force', () => {
  assert.equal(messageLanguageFromSnapshot(LANGUAGE_SNAPSHOT), 'auto');
  assert.equal(messageLanguageFromSnapshot({ language: 'ru', tag: 'ru', source: 'explicit' }), 'ru');
  assert.equal(messageLanguageFromSnapshot({ language: 'zh', tag: 'zh', source: 'config' }), 'auto');
  assert.equal(messageLanguageFromSnapshot(null), 'auto');
});

test('the Delivery tab renders its Russian and English labels from the dictionaries', async (t) => {
  t.after(() => setImTranslator((key) => key));
  for (const [label, dictionary, expected] of [
    ['ru', ru, 'Доставка'],
    ['en', en, 'Delivery'],
  ]) {
    setImTranslator((key) => dictionary[key] ?? key);
    const { rpcCall, languageRpcCall } = fixture();
    let renderer;
    await act(async () => {
      renderer = create(React.createElement(GlobalSettingsPanel, {
        rpcCall, deliverySyncRpcCall: rpcCall, languageRpcCall,
      }));
    });
    const deliveryTab = renderer.root.findAllByType('button')
      .find((button) => button.props.id === 'dim-general-settings-tab-delivery');
    assert.equal(deliveryTab.children.join(''), expected, label);
    act(() => renderer.unmount());
  }
});

test('the Delivery tab never falls back to the loopback settings channel', async (t) => {
  t.after(() => setImTranslator((key) => key));
  const { calls, rpcCall, languageRpcCall } = fixture();
  let renderer;
  await act(async () => {
    // No delivery-sync channel was provided: the panel must say so instead of
    // reading another document through the loopback settings call.
    renderer = create(React.createElement(GlobalSettingsPanel, { rpcCall, languageRpcCall }));
  });
  const deliveryTab = renderer.root.findAllByType('button')
    .find((button) => button.props.id === 'dim-general-settings-tab-delivery');
  await act(async () => deliveryTab.props.onClick());

  const alerts = renderer.root.findAllByType('p').filter((node) => node.props.role === 'alert');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].children.join(''), /投递同步设置通道不可用/);
  // The unrelated general-settings reads still happen; no delivery-sync or
  // language request is made on the wrong channel.
  assert.deepEqual(
    calls.filter(({ endpoint }) => /^settings\.(delivery-sync|language)\./.test(endpoint)),
    [],
  );
});
