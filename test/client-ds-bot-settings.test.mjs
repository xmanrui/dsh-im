import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { DsBotSettingsPage, DsBotPicker } from '../plugin-src/client/ds-bot-settings.js';
import { DsBotAvatar } from '../plugin-src/client/ds-bot-avatar.js';

const { act, create } = TestRenderer;
const bots = [
  { id: 'ds-one', name: 'stepBot', color: 'red', avatar: { shape: 'whale' } },
  { id: 'ds-two', name: 'ImBot', color: 'violet', avatar: { shape: 'whale' } },
];
const key = 'c2c:private-one';
function text(node) {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(text).join('');
  return text(node?.props?.children ?? '');
}

test('binding page works without any delivery RPC and renders avatars in the picker and bound row', async (t) => {
  let binding;
  const calls = [];
  let renderer;
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === 'ds-bot.bind') binding = payload.dsBotId;
    else if (endpoint === 'ds-bot.unbind') binding = undefined;
    else assert.equal(endpoint, 'ds-bot.status');
    return { state: 'ready', bots, conversations: [{ conversationKey: key, address: 'private-one', dsBotId: binding }] };
  };
  await act(async () => { renderer = create(React.createElement(DsBotSettingsPage, { botId: 'im-one', rpcCall })); });
  t.after(async () => act(async () => renderer.unmount()));
  assert.equal(renderer.root.findAllByType('select').length, 1);
  assert.equal(renderer.root.findAllByProps({ role: 'combobox' }).length, 1);
  await act(async () => renderer.root.findByProps({ role: 'combobox' }).props.onClick());
  const options = renderer.root.findAllByProps({ role: 'option' });
  assert.equal(options.length, 2);
  assert.equal(options[0].findAllByType(DsBotAvatar).length, 1);
  await act(async () => options[0].props.onClick());
  await act(async () => renderer.root.findByType('select').props.onChange({ target: { value: key } }));
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.deepEqual(calls.find((call) => call.endpoint === 'ds-bot.bind').payload, {
    botId: 'im-one', dsBotId: 'ds-one', conversationKey: key,
  });
  const row = renderer.root.findByType('li');
  assert.equal(row.findByType(DsBotAvatar).props.bot.name, 'stepBot');
  assert.match(text(row), /stepBot.*已绑定.*private-one/);
  assert.equal(renderer.root.findByType(DsBotPicker).props.value, '');
  assert.deepEqual(renderer.root.findByType(DsBotPicker).props.bots.map((bot) => bot.id), ['ds-two']);
  assert.equal(renderer.root.findByType('select').props.value, '');
  assert.equal(renderer.root.findByType('select').props.disabled, true);
  assert.deepEqual(renderer.root.findByType('select').findAllByType('option').map((option) => option.props.value), ['']);
  assert.equal(renderer.root.findByProps({ type: 'submit' }).props.disabled, true);
  await act(async () => row.findByType('button').props.onClick());
  assert.equal(renderer.root.findAllByType('li').length, 0);
  assert.equal(renderer.root.findByType('select').props.disabled, false);
  assert.equal(renderer.root.findByType(DsBotPicker).props.bots.length, 2);
  assert.equal(renderer.root.findByType('select').findAllByType('option')[1].props.value, key);
  assert.equal(calls.every((call) => call.endpoint.startsWith('ds-bot.')), true);
});

test('refresh excludes bindings made elsewhere and clears stale selections', async (t) => {
  const otherKey = 'c2c:private-two';
  let bound = false;
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(DsBotSettingsPage, {
      botId: 'im-one', rpcCall: async () => ({
        state: 'ready', bots,
        conversations: [
          { conversationKey: key, address: 'private-one', ...(bound ? { dsBotId: 'ds-one' } : {}) },
          { conversationKey: otherKey, address: 'private-two' },
        ],
      }),
    }));
  });
  t.after(async () => act(async () => renderer.unmount()));
  await act(async () => renderer.root.findByType(DsBotPicker).props.onChange('ds-one'));
  await act(async () => renderer.root.findByType('select').props.onChange({ target: { value: key } }));
  assert.equal(renderer.root.findByProps({ type: 'submit' }).props.disabled, false);
  bound = true;
  await act(async () => renderer.root.findAllByType('button').find((button) => text(button) === '刷新').props.onClick());
  assert.equal(renderer.root.findByType(DsBotPicker).props.value, '');
  assert.equal(renderer.root.findByType('select').props.value, '');
  assert.equal(renderer.root.findByProps({ type: 'submit' }).props.disabled, true);
  assert.deepEqual(renderer.root.findByType('select').findAllByType('option').map((option) => option.props.value), ['', otherKey]);
  await act(async () => renderer.root.findByType(DsBotPicker).props.onChange('ds-two'));
  await act(async () => renderer.root.findByType('select').props.onChange({ target: { value: otherKey } }));
  assert.equal(renderer.root.findByProps({ type: 'submit' }).props.disabled, false);
});

test('binding page reads on open or manual refresh, not on a timer or window focus', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = new EventTarget();
  globalThis.document = Object.assign(new EventTarget(), { hidden: false });
  t.after(() => { globalThis.window = previousWindow; globalThis.document = previousDocument; });
  let calls = 0;
  let currentBots = bots;
  const rpcCall = async (endpoint) => {
    assert.equal(endpoint, 'ds-bot.status');
    calls++;
    return { state: 'ready', bots: currentBots, conversations: [
      { conversationKey: key, address: 'private-one', dsBotId: 'ds-one' },
    ] };
  };
  const page = () => React.createElement(DsBotSettingsPage, { botId: 'im-one', rpcCall });
  let renderer;
  await act(async () => { renderer = create(page()); });
  t.after(() => act(() => renderer.unmount()));
  assert.equal(calls, 1);
  currentBots = bots.map((bot) => ({ ...bot, name: bot.name + ' renamed', color: 'green', avatar: { shape: 'kitty' } }));
  await act(async () => {
    t.mock.timers.tick(60_000);
    globalThis.window.dispatchEvent(new Event('focus'));
    globalThis.document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(calls, 1, 'keeping the page open does not read again');
  assert.equal(renderer.root.findByType('li').findByType(DsBotAvatar).props.bot.name, 'stepBot');
  await act(async () => renderer.root.findAllByType('button').find((button) => text(button) === '刷新').props.onClick());
  assert.equal(calls, 2);
  assert.deepEqual(renderer.root.findByType('li').findByType(DsBotAvatar).props.bot, currentBots[0]);
  act(() => renderer.unmount());
  currentBots = bots.map((bot) => ({ ...bot, name: bot.name + ' reopened', color: 'blue' }));
  await act(async () => { renderer = create(page()); });
  assert.equal(calls, 3, 'reopening reads the latest Bot identity');
  assert.match(text(renderer.root.findByType('li')), /stepBot reopened/);
  assert.deepEqual(renderer.root.findByType('li').findByType(DsBotAvatar).props.bot, currentBots[0]);
  assert.deepEqual(renderer.root.findByType(DsBotPicker).props.bots, [currentBots[1]]);
});

test('no remaining bots disables the picker without creating an empty listbox', async () => {
  let renderer;
  await act(async () => { renderer = create(React.createElement(DsBotPicker, {
    bots: [], value: '', onChange() { assert.fail('No selection should be possible'); },
  })); });
  const picker = renderer.root.findByProps({ role: 'combobox' });
  assert.equal(picker.props.disabled, true);
  await act(async () => picker.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} }));
  assert.equal(renderer.root.findAllByProps({ role: 'listbox' }).length, 0);
  await act(async () => renderer.unmount());
});

test('empty private chats show one instruction, with no dependency on delivery settings', async () => {
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(DsBotSettingsPage, {
      botId: 'im-one', rpcCall: async () => ({ state: 'ready', bots, conversations: [] }),
    }));
  });
  assert.match(text(renderer.root.findByType('section')), /先给这个机器人发一条私聊消息/);
  assert.doesNotMatch(text(renderer.root.findByType('section')), /投递设置/);
  await act(async () => renderer.unmount());
});

test('the avatar picker supports keyboard selection and escape', async () => {
  let renderer;
  let selected;
  await act(async () => { renderer = create(React.createElement(DsBotPicker, {
    bots, value: '', onChange: (id) => { selected = id; },
  })); });
  const keyDown = async (key) => act(async () => renderer.root.findByProps({ role: 'combobox' })
    .props.onKeyDown({ key, preventDefault() {} }));
  await keyDown('ArrowDown');
  await keyDown('ArrowDown');
  await keyDown('Enter');
  assert.equal(selected, 'ds-two');
  assert.equal(renderer.root.findAllByProps({ role: 'listbox' }).length, 0);
  await keyDown('ArrowDown');
  await keyDown('Escape');
  assert.equal(renderer.root.findAllByProps({ role: 'listbox' }).length, 0);
  await act(async () => renderer.unmount());
});

test('avatar uses DS Bot colors and shapes or its safe uploaded raster image', () => {
  const whale = renderToStaticMarkup(React.createElement(DsBotAvatar, { bot: bots[0] }));
  assert.match(whale, /#FF3E51/);
  assert.match(whale, /<mask/);
  const photo = renderToStaticMarkup(React.createElement(DsBotAvatar, {
    bot: { avatar: { image: 'data:image/png;base64,AAAA' } },
  }));
  assert.match(photo, /<img/);
  const unsafe = renderToStaticMarkup(React.createElement(DsBotAvatar, {
    bot: { avatar: { image: 'https://untrusted.example/track' } },
  }));
  assert.doesNotMatch(unsafe, /untrusted/);
  assert.match(renderToStaticMarkup(React.createElement(DsBotAvatar, {
    bot: { id: 'unknown-shape', color: 'constructor', avatar: { shape: 'constructor' } },
  })), /<svg/);
});
