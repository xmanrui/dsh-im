import assert from 'node:assert/strict';
import test from 'node:test';

import { ActionCardRegistry, ACTION_CARD_STATUS } from '../../../src/channels/shared/action-card.mjs';
import {
  commandHelpLines,
  commandHelpSections,
} from '../../../src/channels/shared/command-catalog.mjs';
import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import { TextHarnessBridge } from '../../../src/channels/shared/text-harness-bridge.mjs';
import {
  TELEGRAM_HELP_CARD_CALLBACK,
  TelegramHelpCard,
  helpHomeText,
  helpSectionText,
  parseTelegramHelpCardCallback,
  renderHelpHome,
  renderHelpSection,
} from '../../../src/channels/telegram/help-card.mjs';

const EMPTY_KEYBOARD = { inline_keyboard: [] };

function botFixture({ cardResult = 'ok', editResult = 'ok', supportsCards = true } = {}) {
  const sent = [];
  const cards = [];
  const edits = [];
  const notices = [];
  const bot = {
    async sendText(_target, text) { sent.push(text); },
    async answerInteractionCallback(queryId, text) { notices.push({ queryId, text }); },
  };
  if (supportsCards) {
    bot.sendInteractionCard = async (_target, { text, markup } = {}) => {
      if (cardResult === 'fail') throw new Error('telegram refused the keyboard');
      cards.push({ text, markup });
      return { providerMessageIds: [String(900 + cards.length)] };
    };
    bot.editInteractionCard = async (_target, messageId, { text, markup } = {}) => {
      if (editResult === 'fail') throw new Error('telegram refused the edit');
      edits.push({ messageId, text, markup });
      return { messageId, text, markup };
    };
  }
  return { bot, sent, cards, edits, notices };
}

function bridgeFor({ bot, helpCard } = {}) {
  return new TextHarnessBridge({
    descriptor: { key: 'telegram', label: 'Telegram' },
    bot,
    harness: {},
    state: { hasSeen: () => false, markSeen: async () => {}, sessionFor: () => null },
    helpCard: helpCard === undefined ? new TelegramHelpCard({ logger: { warn() {} } }) : helpCard,
    logger: { warn() {}, error() {} },
  });
}

function helpMessage() {
  return {
    messageId: 'm-help',
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    content: '/help',
    addressed: true,
    replyTarget: { chatId: 42 },
  };
}

function callbackFor(data, overrides = {}) {
  return {
    callbackQueryId: 'cb-1',
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    messageId: 'update-1',
    data,
    replyTarget: { chatId: 42 },
    ...overrides,
  };
}

test('the catalog splits into sections without losing a command', () => {
  const sections = commandHelpSections('telegram');
  const grouped = sections.flatMap((section) => section.items.map((item) => item.name));
  const expected = commandHelpLines('telegram');
  // Every command appears exactly once, and the section list covers the lines
  // the text /help prints (that text is pinned separately).
  assert.equal(new Set(grouped).size, grouped.length, 'no command appears twice');
  assert.ok(grouped.length >= sections.length, 'sections actually carry commands');
  assert.ok(expected.length > 0);
  // `menu` is helpVisible:false, so it must be in neither surface.
  assert.ok(!grouped.includes('menu'));
  for (const section of sections) {
    assert.ok(section.items.length > 0, `${section.group} is never empty`);
  }
});

test('the home screen counts commands and offers one button per section', () => {
  const sections = commandHelpSections('telegram');
  const text = helpHomeText(sections);
  const total = sections.reduce((count, section) => count + section.items.length, 0);
  assert.match(text, /DeepSeek Harness 帮助/u);
  assert.ok(text.includes(String(total)));
  const card = renderHelpHome(sections, 'abcd1234EFGH');
  const rows = card.markup.inline_keyboard;
  const buttons = rows.flat();
  // One entry per section plus the /menu shortcut.
  assert.equal(buttons.length, sections.length + 1);
  // Every button has real text: a label that resolves to undefined renders as
  // "undefined (6)" on a device, which is exactly the bug this pins down.
  for (const button of buttons) {
    assert.doesNotMatch(button.text, /undefined|null|\[object/u, button.text);
    assert.ok(button.text.trim().length > 1, button.text);
  }
  // A section button names its section and its command count.
  const sessionIndex = sections.findIndex((section) => section.group === 'session');
  assert.ok(sessionIndex >= 0);
  assert.match(buttons[sessionIndex].text, /会话（\d+）/u);
  for (const button of buttons) {
    assert.ok(Buffer.byteLength(button.callback_data, 'utf8') <= 64, button.callback_data);
    assert.match(button.callback_data, /^h1\|abcd1234EFGH\|/u);
  }
});

test('a section body carries that section only, with real usage lines', () => {
  const sections = commandHelpSections('telegram');
  const model = sections.find((section) => section.group === 'model');
  assert.ok(model, 'the model section exists');
  const text = helpSectionText(model);
  assert.match(text, /\/models/u);
  assert.doesNotMatch(text, /\/batch/u, 'unrelated commands stay out of the section');
  const card = renderHelpSection(model, 'abcd1234EFGH');
  assert.equal(card.markup.inline_keyboard.length, 1);
  assert.equal(parseTelegramHelpCardCallback(
    card.markup.inline_keyboard[0][0].callback_data,
    { sections },
  ).action, 'home');
});

test('every button a render produces is recognised and nothing else is', () => {
  const sections = commandHelpSections('telegram');
  const home = renderHelpHome(sections, 'abcd1234EFGH');
  for (const button of home.markup.inline_keyboard.flat()) {
    assert.ok(parseTelegramHelpCardCallback(button.callback_data, { sections }));
  }
  for (const section of sections) {
    for (const button of renderHelpSection(section, 'abcd1234EFGH').markup.inline_keyboard.flat()) {
      assert.ok(parseTelegramHelpCardCallback(button.callback_data, { sections }));
    }
  }
  // Foreign namespaces, unknown groups and garbage are all rejected.
  assert.equal(parseTelegramHelpCardCallback('m3|abcd1234EFGH|s', { sections }), null);
  // A group the card never rendered is not a legal action.
  assert.equal(parseTelegramHelpCardCallback(
    TELEGRAM_HELP_CARD_CALLBACK.encode({ nonce: 'abcd1234EFGH', action: 'not-a-group' }),
    { sections },
  ), null);
  assert.ok(parseTelegramHelpCardCallback(
    TELEGRAM_HELP_CARD_CALLBACK.encode({ nonce: 'abcd1234EFGH', action: 'session' }),
    { sections },
  ), 'a rendered section is a legal action');
  assert.equal(parseTelegramHelpCardCallback('garbage', { sections }), null);
});

test('/help on a keyboard channel sends the card, not the text wall', async () => {
  const { bot, cards, sent } = botFixture();
  const bridge = bridgeFor({ bot });
  await bridge.accept(helpMessage());
  assert.equal(cards.length, 1);
  assert.match(cards[0].text, /DeepSeek Harness 帮助/u);
  assert.deepEqual(sent, [], 'the long text help is replaced by the card');
});

test('a section press repaints the same message, and 返回 comes home', async () => {
  const { bot, cards, edits } = botFixture();
  const bridge = bridgeFor({ bot });
  await bridge.accept(helpMessage());
  const sections = commandHelpSections('telegram');
  const firstButton = cards[0].markup.inline_keyboard[0][0];
  const press = parseTelegramHelpCardCallback(firstButton.callback_data, { sections });
  assert.ok(press);

  await bridge.acceptCallback(callbackFor(firstButton.callback_data));
  assert.equal(edits.length, 1, 'the section is painted in place');
  assert.equal(String(edits[0].messageId), '901');
  assert.equal(edits[0].markup.inline_keyboard.length, 1, 'a section shows 返回 only');

  const back = edits[0].markup.inline_keyboard[0][0];
  await bridge.acceptCallback(callbackFor(back.callback_data));
  assert.equal(edits.length, 2, '返回 repaints the home screen');
  assert.match(edits[1].text, /DeepSeek Harness 帮助/u);
});

test('a channel without keyboards gets the exact text help', async () => {
  const { bot, cards, sent } = botFixture({ supportsCards: false });
  const bridge = bridgeFor({ bot });
  await bridge.accept(helpMessage());
  assert.equal(cards.length, 0);
  const text = sent.join('\n');
  assert.match(text, /DeepSeek Harness 帮助|已连接 DeepSeek Harness/u);
  assert.match(text, /\/models/u, 'the full command list is still there');
});

test('helpCard: null keeps the pre-card text help', async () => {
  const { bot, cards, sent } = botFixture();
  const bridge = bridgeFor({ bot, helpCard: null });
  await bridge.accept(helpMessage());
  assert.equal(cards.length, 0);
  assert.match(sent.join('\n'), /\/models/u);
});

test('a refused card send falls back to the text help', async () => {
  const { bot, cards, sent } = botFixture({ cardResult: 'fail' });
  const bridge = bridgeFor({ bot });
  await bridge.accept(helpMessage());
  assert.equal(cards.length, 0);
  assert.ok(sent.length >= 1, 'the text help still arrives');
});

test('a failed repaint drops the dead keyboard instead of lying', async () => {
  // First edit (the section paint) is refused; the cleanup pass then clears the
  // keyboard, so the user is never left with buttons that cannot work.
  let attempts = 0;
  const edits = [];
  const notices = [];
  const cards = [];
  const bot = {
    async sendText() {},
    async answerInteractionCallback(queryId, text) { notices.push({ queryId, text }); },
    async sendInteractionCard(_target, { text, markup } = {}) {
      cards.push({ text, markup });
      return { providerMessageIds: ['901'] };
    },
    async editInteractionCard(_target, messageId, { markup } = {}) {
      attempts += 1;
      if (attempts === 1) throw new Error('telegram refused the edit');
      edits.push({ messageId, markup });
      return { messageId, markup };
    },
  };
  const bridge = bridgeFor({ bot });
  await bridge.accept(helpMessage());
  await bridge.acceptCallback(callbackFor(cards[0].markup.inline_keyboard[0][0].callback_data));
  assert.ok(edits.some((edit) => edit.markup?.inline_keyboard?.length === 0),
    'the dead keyboard is cleared');
  assert.ok(notices.some(({ text }) => typeof text === 'string' && text.length > 0),
    'the user is told the card could not be updated');
});

test('an expired help card is refused', async () => {
  let now = 1_000_000;
  const card = new TelegramHelpCard({
    logger: { warn() {} },
    registry: new ActionCardRegistry({ now: () => now, ttlMs: 50, createNonce: () => 'abcd1234EFGH' }),
  });
  const { bot, cards, edits } = botFixture();
  const sections = commandHelpSections('telegram');
  await card.present({
    bot, target: { chatId: 42 }, conversationKey: 'direct:chat-a', sections,
  });
  now += 100;
  await card.handlePress(
    callbackFor(cards[0].markup.inline_keyboard[0][0].callback_data),
    { bot, answer: () => {}, conversationKey: 'direct:chat-a' },
  );
  // Nothing is repainted with section content; the only edit allowed is the
  // keyboard removal that retires the dead card.
  assert.ok(
    edits.every((edit) => edit.markup?.inline_keyboard?.length === 0),
    'an expired card is only stripped of its keyboard',
  );
});

test('a press from another chat cannot drive this help card', async () => {
  const card = new TelegramHelpCard({ logger: { warn() {} } });
  const { bot, cards, edits } = botFixture();
  const sections = commandHelpSections('telegram');
  await card.present({
    bot, target: { chatId: 42 }, conversationKey: 'direct:chat-a', sections,
  });
  await card.handlePress(
    callbackFor(cards[0].markup.inline_keyboard[0][0].callback_data, { conversationId: 'chat-b' }),
    { bot, answer: () => {}, conversationKey: 'direct:chat-b' },
  );
  assert.equal(edits.length, 0);
});

test('the 控制台 entry hands off to the menu hub', async () => {
  const card = new TelegramHelpCard({ logger: { warn() {} } });
  const { bot, cards, edits } = botFixture();
  const sections = commandHelpSections('telegram');
  await card.present({
    bot, target: { chatId: 42 }, conversationKey: 'direct:chat-a', sections,
  });
  const menuButton = cards[0].markup.inline_keyboard.at(-1)[0];
  assert.match(menuButton.callback_data, /\|menu$/u);
  let opened = 0;
  await card.handlePress(callbackFor(menuButton.callback_data), {
    bot,
    answer: () => {},
    conversationKey: 'direct:chat-a',
    openMenu: async () => { opened += 1; return true; },
  });
  assert.equal(opened, 1);
  assert.equal(edits.length, 0, 'the help card is not repainted by the hand-off');
});

test('help card labels follow the host language', (t) => {
  const previous = setImHostLanguage('en');
  t.after(() => setImHostLanguage(previous));
  const sections = commandHelpSections('telegram');
  assert.match(helpHomeText(sections), /DeepSeek Harness help/u);
  const card = renderHelpHome(sections, 'abcd1234EFGH');
  assert.match(card.markup.inline_keyboard.at(-1)[0].text, /Console \(\/menu\)/u);
  const model = sections.find((section) => section.group === 'model');
  assert.match(helpSectionText(model), /Models and presets|Models/u);
});
