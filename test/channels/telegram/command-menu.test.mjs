import assert from 'node:assert/strict';
import test from 'node:test';

import { SHARED_COMMAND_CATALOG, commandHelpLines } from '../../../src/channels/shared/command-catalog.mjs';
import { isHistoryCommand } from '../../../src/channels/shared/history-command.mjs';
import { getImHostLanguage, setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import { isModelCommand } from '../../../src/channels/shared/model-command.mjs';
import { TelegramApi } from '../../../src/channels/telegram/telegram-api.mjs';
import { telegramCommandMenu } from '../../../src/channels/telegram/telegram-runtime.mjs';

for (const command of ['history', 'reasoninglist', 'reasonings', 'reasoning']) {
  test(`Telegram command menu includes the supported /${command} command`, () => {
    assert.equal(isHistoryCommand(`/${command}`) || isModelCommand(`/${command}`), true);
    assert.ok(telegramCommandMenu().some((item) => item.command === command),
      `Supported /${command} is missing from the production menu`);
  });
}

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

test('real catalog preserves existing aliases and excludes channel-specific commands', () => {
  const names = telegramCommandMenu().map((item) => item.command);
  assert.deepEqual(names, [
    'new', 'compact', 'history', 'workspace', 'ws',
    'conv', 'conversation', 'thread', 'workspacelist', 'workspaces', 'wsl',
    'sessionlist', 'sessions', 'session', 'models', 'reasoninglist', 'reasonings',
    'reasoning', 'model', 'presetlist', 'presets', 'preset', 'stop', 'steer',
    'batch', 'send', 'cancel', 'status', 'version', 'help',
  ]);
  for (const name of ['repair', 'role', 'roles', 'menu', 'm']) assert.ok(!names.includes(name));
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
    history: 'Show recent history (private chats only)',
    reasoninglist: 'List reasoning efforts for the current model by index',
    reasonings: 'List reasoning efforts for the current model by index',
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

test('Telegram API validates menu boundaries and deletes commands in the requested scope', async () => {
  const calls = [];
  const api = new TelegramApi({
    token: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456',
    fetchImpl: async (url, options) => {
      calls.push({ method: url.pathname.split('/').at(-1), body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ ok: true, result: true }));
    },
  });
  const hundred = Array.from({ length: 100 }, (_, i) => ({ command: `c_${i}`, description: 'Valid' }));
  await api.setMyCommands({ commands: hundred });
  for (const commands of [[], [...hundred, hundred[0]], [hundred[0], hundred[0]],
    [{ command: 'empty', description: ' ' }], [{ command: 'long', description: 'a'.repeat(257) }]]) {
    await assert.rejects(() => api.setMyCommands({ commands }), /commands are invalid/);
  }
  await api.deleteMyCommands();
  await api.deleteMyCommands({ scope: { type: 'chat', chat_id: 88 }, languageCode: ' en ' });
  assert.deepEqual(calls, [
    { method: 'setMyCommands', body: { commands: hundred } },
    { method: 'deleteMyCommands', body: {} },
    { method: 'deleteMyCommands', body: { scope: { type: 'chat', chat_id: 88 }, language_code: 'en' } },
  ]);
});
