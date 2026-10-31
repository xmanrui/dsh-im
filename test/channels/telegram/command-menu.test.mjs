import assert from 'node:assert/strict';
import test from 'node:test';

import { SHARED_COMMAND_CATALOG, availableCommandCatalog, commandHelpLines } from '../../../src/channels/shared/command-catalog.mjs';
import { isHistoryCommand } from '../../../src/channels/shared/history-command.mjs';
import { getImHostLanguage, setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import { isModelCommand } from '../../../src/channels/shared/model-command.mjs';
import { isPresetCommand } from '../../../src/channels/shared/preset-command.mjs';
import { isWorkspaceCommand } from '../../../src/channels/shared/workspace-command.mjs';
import { TelegramApi } from '../../../src/channels/telegram/telegram-api.mjs';
import { telegramCommandMenu } from '../../../src/channels/telegram/telegram-runtime.mjs';

// The native Telegram menu only carries primary command names. Aliases stay
// typeable (and stay in /help), so they are asserted as accepted input below.
// /workspacelist stays typeable and stays in /help, but main already keeps it
// out of the native menu: /workspace (alias /ws) covers listing and switching.
const MAIN_MENU_NAMES = [
  'new', 'fork', 'compact', 'clear', 'history', 'workspace', 'conv',
  'sessionlist', 'session', 'ls', 'go', 'prev', 'next', 'drop', 'title', 'tail',
  'models', 'reasoninglist', 'reasoning', 'model',
  'presetlist', 'preset', 'stop', 'steer', 'batch', 'send', 'cancel',
  'status', 'version', 'help',
];
const HIDDEN_ALIASES = [
  'ws', 'conversation', 'thread', 'workspaces', 'wsl', 'sessions',
  'reasonings', 'presets',
];

for (const command of ['history', 'reasoninglist', 'reasoning']) {
  test(`Telegram command menu includes the supported /${command} command`, () => {
    assert.equal(isHistoryCommand(`/${command}`) || isModelCommand(`/${command}`), true);
    assert.ok(telegramCommandMenu().some((item) => item.command === command),
      `Supported /${command} is missing from the production menu`);
  });
}

for (const alias of HIDDEN_ALIASES) {
  test(`hidden alias /${alias} still parses but is absent from the native menu`, () => {
    assert.equal(
      isWorkspaceCommand(`/${alias}`) || isModelCommand(`/${alias}`) || isPresetCommand(`/${alias}`),
      true,
      `/${alias} must stay accepted as typed input`,
    );
    assert.ok(!telegramCommandMenu().some((item) => item.command === alias),
      `/${alias} must not be registered in the native menu`);
  });
}

// /help text is pinned byte-for-byte by test/channels/shared/command-help.test.mjs
// against fixtures/command-help.json; this only checks the documented aliases
// still appear there after leaving the native menu.
const DOCUMENTED_ALIASES = [
  'ws', 'conversation', 'workspaces', 'wsl', 'sessions', 'reasonings', 'presets',
  'list', 'peek',
];
test('hiding aliases from the native menu leaves the documented /help lines intact', () => {
  const help = commandHelpLines('telegram');
  assert.equal(help.length, 41);
  for (const alias of DOCUMENTED_ALIASES) {
    assert.ok(help.some((line) => line.includes(`/${alias}`)), alias);
  }
});

test('/fork leaves the menu and /help when the facade has no fork primitive', () => {
  const catalog = availableCommandCatalog(SHARED_COMMAND_CATALOG, { supportsFork: false });
  const commands = telegramCommandMenu(catalog).map((item) => item.command);
  assert.ok(commands.includes('new'), '/new stays available');
  assert.ok(!commands.includes('fork'), '/fork must not be advertised');

  const help = commandHelpLines('telegram', catalog);
  assert.ok(help.every((line) => !line.includes('/fork')), 'the /fork help line is dropped');
  assert.equal(commandHelpLines('telegram').some((line) => line.includes('/fork')), true,
    'the default catalog still documents /fork');
});

function entry(name, options = {}) {
  return {
    name, description: '显示帮助', channels: ['telegram'], menuVisible: true,
    help: [`/${name}  Fixture usage`], ...options,
  };
}

test('one new declaration drives both production menu and help consumers', () => {
  const catalog = [...SHARED_COMMAND_CATALOG, entry('fixture', {
    aliases: [{ name: 'fixture_alias', menuVisible: true }],
    help: ['/fixture or /fixture_alias [value]  Fixture usage'],
  })];
  const before = structuredClone(catalog);
  assert.deepEqual(telegramCommandMenu(catalog).slice(-2).map((item) => item.command),
    ['fixture', 'fixture_alias']);
  assert.equal(commandHelpLines('telegram', catalog).at(-1),
    '/fixture or /fixture_alias [value]  Fixture usage');
  assert.deepEqual(catalog, before);
  const result = telegramCommandMenu(catalog);
  result[0].description = 'modified result';
  assert.notEqual(telegramCommandMenu(catalog)[0].description, 'modified result');
});

test('menu filters unsupported, disabled and hidden commands and aliases in stable order', () => {
  const catalog = [
    entry('visible', { aliases: [
      { name: 'alias' },
      { name: 'hidden_alias', menuVisible: false },
      { name: 'disabled_alias', enabled: false },
      { name: 'feishu_alias', channels: ['feishu'] },
    ] }),
    entry('repair', { channels: ['feishu'] }),
    entry('hidden', { menuVisible: false, aliases: [{ name: 'hidden_child' }] }),
    entry('disabled', { enabled: false }),
    entry('private', { privateOnly: true }),
  ];
  assert.deepEqual(telegramCommandMenu(catalog).map((item) => item.command),
    ['visible', 'alias', 'private']);
  assert.deepEqual(commandHelpLines('telegram', catalog),
    ['/visible  Fixture usage', '/hidden  Fixture usage', '/private  Fixture usage']);
  assert.deepEqual(commandHelpLines('feishu', catalog), ['/repair  Fixture usage']);
});

test('real catalog presents only primary names and keeps every alias in help', () => {
  const names = telegramCommandMenu().map((item) => item.command);
  assert.deepEqual(names, MAIN_MENU_NAMES);
  for (const name of ['repair', 'role', 'roles', 'menu', 'm']) assert.ok(!names.includes(name));
  for (const alias of HIDDEN_ALIASES) assert.ok(!names.includes(alias), alias);
  const help = commandHelpLines('telegram').join('\n');
  for (const alias of DOCUMENTED_ALIASES) assert.match(help, new RegExp(`/${alias}\\b`), alias);
  assert.ok(Object.isFrozen(SHARED_COMMAND_CATALOG));
  for (const item of SHARED_COMMAND_CATALOG) {
    assert.ok(Object.isFrozen(item));
    assert.ok(Object.isFrozen(item.help));
    assert.ok(Object.isFrozen(item.aliases));
    assert.ok(Object.isFrozen(item.channels));
    for (const alias of item.aliases) assert.ok(Object.isFrozen(alias));
  }
});

test('all real menu descriptions localize on repeated host language changes', (t) => {
  const previous = getImHostLanguage();
  t.after(() => setImHostLanguage(previous));
  const translated = {
    clear: 'Clear the current session context and keep the Session binding',
    history: 'Show recent history (private chats only)',
    reasoninglist: 'List reasoning efforts for the current model by index',
    reasoning: 'Show or switch the current reasoning effort',
  };
  setImHostLanguage('zh');
  const chinese = telegramCommandMenu();
  for (const language of ['en', 'zh', 'en', 'zh']) {
    setImHostLanguage(language);
    const menu = telegramCommandMenu();
    if (language === 'zh') {
      assert.deepEqual(menu, chinese);
    } else {
      for (const item of menu) {
        assert.doesNotMatch(item.description, /\p{Script=Han}/u, item.command);
        if (translated[item.command]) assert.equal(item.description, translated[item.command]);
      }
    }
  }
});

test('production menu rejects invalid data instead of silently omitting or truncating it', () => {
  for (const name of ['', '/help', 'Bad', 'bad-name', 'a'.repeat(33)]) {
    assert.throws(() => telegramCommandMenu([entry(name)]), /commands are invalid/);
  }
  for (const description of ['', ' ', undefined, 1, 'a'.repeat(257), '😀'.repeat(257)]) {
    assert.throws(() => telegramCommandMenu([entry('valid', { description })]), /commands are invalid/);
  }
  for (const catalog of [
    [entry('duplicate'), entry('duplicate')],
    [entry('duplicate', { aliases: [{ name: 'duplicate' }] })],
    [entry('first', { aliases: [{ name: 'duplicate' }] }), entry('duplicate')],
  ]) assert.throws(() => telegramCommandMenu(catalog), /commands are invalid/);
  assert.equal(telegramCommandMenu([entry('a'.repeat(32), { description: '😀'.repeat(256) })]).length, 1);
  const hundred = Array.from({ length: 100 }, (_, i) => entry(`command_${i}`));
  assert.equal(telegramCommandMenu(hundred).length, 100);
  assert.throws(() => telegramCommandMenu([...hundred, entry('overflow')]), /commands are invalid/);
  assert.throws(() => telegramCommandMenu([
    ...hundred.slice(1), entry('last', { aliases: [{ name: 'overflow' }] }),
  ]), /commands are invalid/);
  assert.deepEqual(telegramCommandMenu([]), []);
  assert.deepEqual(telegramCommandMenu([entry('hidden', { menuVisible: false })]), []);
});

test('Telegram API validates menu boundaries and sends scoped payloads', async () => {
  const calls = [];
  const api = new TelegramApi({
    token: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456',
    fetchImpl: async (url, options) => {
      calls.push({ method: url.pathname.split('/').at(-1), body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ ok: true, result: true }));
    },
  });
  const hundred = Array.from({ length: 100 }, (_, i) => ({ command: `c_${i}`, description: 'Valid' }));
  const first = { command: 'help', description: '显示帮助' };
  await api.setMyCommands({ commands: hundred });
  await api.setMyCommands({
    commands: [first],
    scope: { type: 'all_private_chats' },
    languageCode: ' en ',
  });
  for (const commands of [[], [...hundred, hundred[0]], [hundred[0], hundred[0]],
    [{ command: 'empty', description: ' ' }], [{ command: 'long', description: 'a'.repeat(257) }]]) {
    await assert.rejects(() => api.setMyCommands({ commands }), /commands are invalid/);
  }
  await api.deleteMyCommands();
  await api.deleteMyCommands({ scope: { type: 'chat', chat_id: 88 }, languageCode: ' en ' });
  assert.deepEqual(calls, [
    { method: 'setMyCommands', body: { commands: hundred } },
    {
      method: 'setMyCommands',
      body: {
        commands: [first],
        scope: { type: 'all_private_chats' },
        language_code: 'en',
      },
    },
    { method: 'deleteMyCommands', body: {} },
    { method: 'deleteMyCommands', body: { scope: { type: 'chat', chat_id: 88 }, language_code: 'en' } },
  ]);
});
