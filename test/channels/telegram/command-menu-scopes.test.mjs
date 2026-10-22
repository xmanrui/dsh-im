import assert from 'node:assert/strict';
import test from 'node:test';

import { SHARED_COMMAND_CATALOG } from '../../../src/channels/shared/command-catalog.mjs';
import { getImHostLanguage, setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import {
  TELEGRAM_COMMAND_MENU_SCOPES,
  telegramCommandMenu,
  telegramCommandMenuScopes,
} from '../../../src/channels/telegram/telegram-runtime.mjs';

const MAIN_MENU_NAMES = [
  'new', 'compact', 'clear', 'history', 'workspace', 'conv', 'workspacelist',
  'sessionlist', 'session', 'models', 'reasoninglist', 'reasoning', 'model',
  'presetlist', 'preset', 'stop', 'steer', 'batch', 'send', 'cancel',
  'status', 'version', 'help',
];
const PRIVATE_ONLY = ['history', 'batch', 'send', 'cancel'];

function entry(name, options = {}) {
  return {
    name, description: '显示帮助', channels: ['telegram'], menuVisible: true,
    help: [`/${name}  Fixture usage`], ...options,
  };
}

test('private and group scopes publish different command lists', () => {
  const plan = telegramCommandMenuScopes();
  assert.deepEqual(plan.map(({ scope }) => scope), [
    { type: 'all_private_chats' },
    { type: 'all_group_chats' },
  ]);
  assert.deepEqual(TELEGRAM_COMMAND_MENU_SCOPES, {
    private: { type: 'all_private_chats' },
    group: { type: 'all_group_chats' },
  });
  assert.ok(Object.isFrozen(TELEGRAM_COMMAND_MENU_SCOPES));
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan[0].commands));
  const [privateMenu, groupMenu] = plan;
  assert.deepEqual(privateMenu.commands.map((item) => item.command), MAIN_MENU_NAMES);
  assert.deepEqual(groupMenu.commands.map((item) => item.command),
    MAIN_MENU_NAMES.filter((name) => !PRIVATE_ONLY.includes(name)));
  // The scope-agnostic export keeps meaning "everything a direct chat can use".
  assert.deepEqual(telegramCommandMenu(), privateMenu.commands);
  for (const name of PRIVATE_ONLY) {
    assert.ok(privateMenu.commands.some((item) => item.command === name), name);
    assert.ok(!groupMenu.commands.some((item) => item.command === name), name);
  }
});

test('scope lists filter hidden entries, private-only aliases and other channels', () => {
  const catalog = [
    entry('visible', { aliases: [
      { name: 'visible_alias' },
      { name: 'hidden_alias', menuVisible: false },
    ] }),
    entry('private_base', { privateOnly: true, aliases: [{ name: 'private_alias' }] }),
    entry('hidden', { menuVisible: false }),
    entry('feishu_only', { channels: ['feishu'] }),
  ];
  const [privateMenu, groupMenu] = telegramCommandMenuScopes(catalog);
  assert.deepEqual(privateMenu.commands.map((item) => item.command),
    ['visible', 'visible_alias', 'private_base', 'private_alias']);
  assert.deepEqual(groupMenu.commands.map((item) => item.command),
    ['visible', 'visible_alias']);
  assert.deepEqual(telegramCommandMenuScopes([]).map(({ scope, commands }) => ({ scope, commands })),
    [
      { scope: { type: 'all_private_chats' }, commands: [] },
      { scope: { type: 'all_group_chats' }, commands: [] },
    ]);
  const overLimit = Array.from({ length: 101 }, (_, index) => entry(`command_${index}`));
  assert.throws(() => telegramCommandMenuScopes(overLimit), /commands are invalid/);
});

test('scoped menus localize with the host language', (t) => {
  const previous = getImHostLanguage();
  t.after(() => setImHostLanguage(previous));
  setImHostLanguage('en');
  const [privateMenu, groupMenu] = telegramCommandMenuScopes();
  for (const menu of [privateMenu, groupMenu]) {
    for (const item of menu.commands) {
      assert.doesNotMatch(item.description, /\p{Script=Han}/u, item.command);
    }
  }
  assert.equal(privateMenu.commands.find((item) => item.command === 'history').description,
    'Show recent history (private chats only)');
  setImHostLanguage('zh');
  assert.deepEqual(
    telegramCommandMenuScopes()[0].commands,
    telegramCommandMenu(),
  );
});

test('real catalog keeps its primary-name order inside both scopes', () => {
  const [privateMenu, groupMenu] = telegramCommandMenuScopes(SHARED_COMMAND_CATALOG);
  assert.deepEqual(privateMenu.commands.map((item) => item.command), MAIN_MENU_NAMES);
  assert.deepEqual(groupMenu.commands.map((item) => item.command),
    MAIN_MENU_NAMES.filter((name) => !PRIVATE_ONLY.includes(name)));
});
