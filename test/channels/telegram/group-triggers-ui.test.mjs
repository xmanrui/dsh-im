import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import TestRenderer from 'react-test-renderer';

import {
  GROUP_TRIGGER_MODE_OPTIONS,
  GROUP_TRIGGERS_ENDPOINTS,
  TelegramGroupTriggersSettings,
  splitMemberIds,
  stateFromSnapshot,
} from '../../../plugin-src/client/channels/telegram/group-triggers-settings.js';
import { en, setImTranslator } from '../../../plugin-src/client/i18n.js';

const { act, create } = TestRenderer;

async function flush() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node?.children?.map(textOf).join('') ?? '';
}

const SNAPSHOT = Object.freeze({
  defaults: { mode: 'off', senders: [] },
  groups: {
    '-1001111111111': { mode: 'all', senders: [] },
    '-1002222222222': { mode: 'all-list', senders: ['111', '222'] },
  },
  seen: [
    {
      chatId: '-1001111111111',
      title: 'One',
      type: 'supergroup',
      lastSeenAt: '2026-02-03T04:05:06.000Z',
      lastSenderName: 'Ann',
    },
    { chatId: '-1003333333333', title: 'Three', type: null, lastSeenAt: null, lastSenderName: null },
  ],
});

function rpcStub(t, { resolve = null } = {}) {
  const calls = [];
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === GROUP_TRIGGERS_ENDPOINTS.get) return { ok: true, value: SNAPSHOT };
    if (endpoint === GROUP_TRIGGERS_ENDPOINTS.set) {
      return {
        ok: true,
        value: {
          defaults: payload.config.defaults,
          groups: payload.config.groups,
          seen: SNAPSHOT.seen.filter((entry) => !payload.removed.includes(entry.chatId)),
        },
      };
    }
    if (endpoint === GROUP_TRIGGERS_ENDPOINTS.resolve) {
      if (typeof resolve === 'function') return resolve(payload.input);
      if (payload.input === '-1001111111111') {
        return { ok: true, value: { chatId: '-1001111111111', title: 'One', type: 'supergroup', verified: true } };
      }
      return { ok: true, value: { chatId: '-1009999999999', title: 'Nine', type: 'supergroup', verified: true } };
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  return { calls, rpcCall };
}

async function mount(t, props) {
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(TelegramGroupTriggersSettings, props));
    await flush();
  });
  t.after(async () => { await act(async () => { renderer.unmount(); await flush(); }); });
  return renderer;
}

function fieldsetOf(root, legend) {
  return root.findAllByType('fieldset').find((node) => textOf(node).startsWith(legend));
}

function selectOf(node) {
  return node.findByType('select');
}

test('English UI: state mapping keeps modes and member lists', (t) => {
  setImTranslator((key) => en[key] ?? key);
  t.after(() => setImTranslator(null));
  const state = stateFromSnapshot(SNAPSHOT);
  assert.deepEqual(state.defaults, { mode: 'off', sendersText: '' });
  assert.deepEqual(state.groups['-1002222222222'], { mode: 'all-list', sendersText: '111\n222' });
  assert.deepEqual(state.removed, []);
  assert.deepEqual(splitMemberIds(' 111, 222\n333 '), ['111', '222', '333']);
  assert.equal(GROUP_TRIGGER_MODE_OPTIONS.length, 5);
});

test('the panel renders the defaults, one card per group and a blank add form', async (t) => {
  setImTranslator((key) => en[key] ?? key);
  t.after(() => setImTranslator(null));
  const { rpcCall, calls } = rpcStub(t);
  const renderer = await mount(t, { account: { botId: 'telegram_abc' }, rpcCall });
  const root = renderer.root;
  assert.deepEqual(calls[0], { endpoint: GROUP_TRIGGERS_ENDPOINTS.get, payload: { botId: 'telegram_abc' } });

  const text = textOf(root);
  assert.match(text, /Default for new groups/u);
  assert.match(text, /Bot in groups|One/u);
  assert.match(text, /-1001111111111/u);
  assert.match(text, /Last activity/u);
  assert.match(text, /Do not react/u);

  const one = fieldsetOf(root, 'One');
  assert.ok(one, 'configured group card is rendered');
  assert.equal(selectOf(one).props.value, 'all');

  // A group only seen in the history shows the inherited default instead.
  const three = fieldsetOf(root, 'Three');
  assert.ok(three);
  assert.equal(three.findAllByType('select').length, 0);
  assert.match(textOf(three), /All messages, anyone|Do not react/u);
  assert.match(textOf(three), /default/u);

  // The add form starts blank: new rules never copy the defaults.
  const add = fieldsetOf(root, 'Add group');
  assert.ok(add);
  assert.equal(add.findAllByType('textarea')[0].props.value, '');
  assert.equal(selectOf(add).props.value, 'off');
});

test('changing a mode and saving sends the normalized config', async (t) => {
  setImTranslator((key) => en[key] ?? key);
  t.after(() => setImTranslator(null));
  const { rpcCall, calls } = rpcStub(t);
  const renderer = await mount(t, { account: { botId: 'telegram_abc' }, rpcCall });
  const root = renderer.root;

  const add = fieldsetOf(root, 'Add group');
  await act(async () => {
    selectOf(add).props.onChange({ target: { value: 'mention-list' } });
    await flush();
  });
  const members = add.findAllByType('textarea')[1];
  await act(async () => {
    members.props.onChange({ target: { value: '111\n222' } });
    await flush();
  });

  const form = root.findByType('form');
  await act(async () => {
    form.props.onSubmit({ preventDefault() {} });
    await flush();
  });

  const saved = calls.find((call) => call.endpoint === GROUP_TRIGGERS_ENDPOINTS.set);
  assert.deepEqual(saved.payload.config.defaults, { mode: 'off', senders: [] });
  assert.deepEqual(saved.payload.config.groups['-1002222222222'], {
    mode: 'all-list',
    senders: ['111', '222'],
  });
  assert.deepEqual(saved.payload.removed, []);
});

test('adding a group resolves the reference and refuses duplicates', async (t) => {
  setImTranslator((key) => en[key] ?? key);
  t.after(() => setImTranslator(null));
  const { rpcCall, calls } = rpcStub(t);
  const renderer = await mount(t, { account: { botId: 'telegram_abc' }, rpcCall });
  let add = fieldsetOf(renderer.root, 'Add group');

  const link = add.findAllByType('textarea')[0];
  await act(async () => {
    link.props.onChange({ target: { value: 'https://t.me/c/9999999999/1' } });
    await flush();
  });
  assert.equal(link.props.value, 'https://t.me/c/9999999999/1');
  await act(async () => {
    link.props.onKeyDown({ key: 'Enter', preventDefault() {} });
    await flush();
  });
  const resolved = calls.find((call) => call.endpoint === GROUP_TRIGGERS_ENDPOINTS.resolve);
  assert.equal(resolved.payload.input, 'https://t.me/c/9999999999/1');
  assert.match(textOf(renderer.root), /Nine/u);

  // Whitelisting the same chat again must not overwrite the existing card.
  await act(async () => {
    selectOf(add).props.onChange({ target: { value: 'all' } });
    await flush();
  });
  add = fieldsetOf(renderer.root, 'Add group');
  const again = add.findAllByType('textarea')[0];
  await act(async () => {
    again.props.onChange({ target: { value: '-1001111111111' } });
    await flush();
  });
  await act(async () => {
    again.props.onKeyDown({ key: 'Enter', preventDefault() {} });
    await flush();
  });
  assert.match(textOf(renderer.root), /already in the list/u);
  const one = fieldsetOf(renderer.root, 'One');
  assert.equal(selectOf(one).props.value, 'all', 'existing rule is untouched');
});

test('remove hides the card immediately and the next save reports it as removed', async (t) => {
  setImTranslator((key) => en[key] ?? key);
  t.after(() => setImTranslator(null));
  const { rpcCall, calls } = rpcStub(t);
  const renderer = await mount(t, { account: { botId: 'telegram_abc' }, rpcCall });
  const root = renderer.root;

  const one = fieldsetOf(root, 'One');
  const remove = one.findAllByType('button').find((node) => textOf(node).includes('Remove'));
  assert.ok(remove);
  await act(async () => { remove.props.onClick(); await flush(); });
  assert.equal(fieldsetOf(root, 'One'), undefined, 'card disappears right away');

  await act(async () => {
    root.findByType('form').props.onSubmit({ preventDefault() {} });
    await flush();
  });
  const saved = calls.find((call) => call.endpoint === GROUP_TRIGGERS_ENDPOINTS.set);
  assert.deepEqual(saved.payload.removed, ['-1001111111111']);
  assert.ok(!Object.hasOwn(saved.payload.config.groups, '-1001111111111'));
});

test('a failing lookup keeps the add form usable and shows the reason', async (t) => {
  setImTranslator((key) => en[key] ?? key);
  t.after(() => setImTranslator(null));
  const { rpcCall } = rpcStub(t, {
    resolve: async () => ({
      ok: false,
      error: {
        code: 'group-triggers-invalid',
        message: 'Could not resolve this reference through Telegram (chat not found). Retry later or enter the numeric group ID.',
      },
    }),
  });
  const renderer = await mount(t, { account: { botId: 'telegram_abc' }, rpcCall });
  const add = fieldsetOf(renderer.root, 'Add group');
  const input = add.findAllByType('textarea')[0];
  await act(async () => {
    input.props.onChange({ target: { value: '@missing' } });
    await flush();
  });
  await act(async () => {
    input.props.onKeyDown({ key: 'Enter', preventDefault() {} });
    await flush();
  });
  assert.match(textOf(renderer.root), /Retry later or enter the numeric group ID/u);
  assert.ok(fieldsetOf(renderer.root, 'Add group'), 'the form is still there');
});

test('a chat known only from the archive is configurable in place', async (t) => {
  setImTranslator((key) => en[key] ?? key);
  t.after(() => setImTranslator(null));
  const { calls, rpcCall } = rpcStub(t);
  const renderer = await mount(t, { account: { botId: 'telegram_abc' }, rpcCall });

  const historyOnly = fieldsetOf(renderer.root, 'Three');
  assert.ok(historyOnly, 'the archived chat has a card');
  assert.equal(historyOnly.findAllByType('select').length, 0, 'no editor while it only inherits defaults');

  const customize = historyOnly.findAllByType('button').find((node) => textOf(node).includes('Customize'));
  assert.ok(customize, 'the card offers an explicit action');
  await act(async () => { customize.props.onClick(); await flush(); });

  const edited = fieldsetOf(renderer.root, 'Three');
  assert.equal(edited.findAllByType('select').length, 1, 'the card now carries its own rule');

  await act(async () => {
    edited.findByType('select').props.onChange({ target: { value: 'all' } });
    await flush();
  });
  await act(async () => {
    renderer.root.findByType('form').props.onSubmit({ preventDefault() {} });
    await flush();
  });
  const saved = calls.find((call) => call.endpoint === GROUP_TRIGGERS_ENDPOINTS.set);
  assert.deepEqual(saved.payload.config.groups['-1003333333333'], { mode: 'all', senders: [] });
});

test('an archived chat that already has a rule is still a duplicate', async (t) => {
  setImTranslator((key) => en[key] ?? key);
  t.after(() => setImTranslator(null));
  const { rpcCall } = rpcStub(t, {
    resolve: async () => ({
      ok: true,
      value: { chatId: '-1001111111111', title: 'One', type: 'supergroup', verified: true },
    }),
  });
  const renderer = await mount(t, { account: { botId: 'telegram_abc' }, rpcCall });
  const add = fieldsetOf(renderer.root, 'Add group');
  const input = add.findAllByType('textarea')[0];
  await act(async () => {
    input.props.onChange({ target: { value: '-1001111111111' } });
    await flush();
  });
  await act(async () => {
    input.props.onKeyDown({ key: 'Enter', preventDefault() {} });
    await flush();
  });
  assert.match(textOf(renderer.root), /already in the list/u);
});
