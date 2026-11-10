import assert from 'node:assert/strict';
import test from 'node:test';

import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import {
  TELEGRAM_WELCOME_CARD_CALLBACK,
  TelegramWelcomeCard,
} from '../../../src/channels/telegram/welcome-card.mjs';

const quietLogger = { warn: () => {}, error: () => {} };

function botFixture({ cards = true } = {}) {
  const sent = [];
  const cardSends = [];
  const notices = [];
  const bot = {
    async sendText(_target, text) { sent.push(text); },
    async answerInteractionCallback(_id, text) { notices.push(text); },
  };
  if (cards) {
    bot.sendInteractionCard = async (target, card) => {
      cardSends.push({ target, card });
      return { providerMessageIds: ['611'] };
    };
  }
  return { bot, sent, cardSends, notices };
}

test('W1: the greeting explains the bot and offers three entries', async (t) => {
  const previous = setImHostLanguage('zh');
  t.after(() => setImHostLanguage(previous));
  const { bot, cardSends } = botFixture();
  const card = new TelegramWelcomeCard({ logger: quietLogger });
  const presented = await card.present({
    bot,
    target: { chatId: 42 },
    conversationKey: 'direct:42',
    levelLabel: '标准',
  });
  assert.equal(presented, true);
  assert.equal(cardSends.length, 1);
  assert.match(cardSends[0].card.text, /已连接 DeepSeek Harness/u);
  assert.match(cardSends[0].card.text, /当前过程显示：标准/u);
  const buttons = cardSends[0].card.markup.inline_keyboard.flat();
  assert.deepEqual(buttons.map((button) => button.callback_data.split('|')[2]), ['m', 'd', 'h']);
  for (const button of buttons) {
    assert.ok(TELEGRAM_WELCOME_CARD_CALLBACK.parse(button.callback_data), 'every payload is ours');
  }
});

test('W2: a press replays the entry command and keeps the card alive', async (t) => {
  const previous = setImHostLanguage('zh');
  t.after(() => setImHostLanguage(previous));
  const { bot, cardSends, notices } = botFixture();
  const card = new TelegramWelcomeCard({ logger: quietLogger });
  await card.present({ bot, target: { chatId: 42 }, conversationKey: 'direct:42' });
  const entry = card.registry.activeFor('direct:42');
  assert.ok(entry, 'a nonce was issued');
  const ran = [];
  const handled = await card.handlePress(
    { data: TELEGRAM_WELCOME_CARD_CALLBACK.encode({ nonce: entry.nonce, action: 'd' }), replyTarget: { chatId: 42 } },
    {
      bot,
      answer: (text) => notices.push(text),
      conversationKey: 'direct:42',
      run: async (command) => { ran.push(command); return { handled: true }; },
    },
  );
  assert.equal(handled, true);
  assert.deepEqual(ran, ['/display']);
  assert.ok(card.registry.activeFor('direct:42'), 'the launcher stays usable');
  assert.match(notices.at(-1), /已打开/u);
});

test('W3: a foreign or stale press is refused without running anything', async (t) => {
  const previous = setImHostLanguage('zh');
  t.after(() => setImHostLanguage(previous));
  const { bot, notices } = botFixture();
  const card = new TelegramWelcomeCard({ logger: quietLogger });
  await card.present({ bot, target: { chatId: 42 }, conversationKey: 'direct:42' });
  const ran = [];
  await card.handlePress(
    { data: 'w2|AAAAAAAAAAAA|m', replyTarget: { chatId: 42 } },
    { bot, answer: (text) => notices.push(text), conversationKey: 'direct:42', run: async (command) => { ran.push(command); return { handled: true }; } },
  );
  assert.deepEqual(ran, []);
  assert.match(notices.at(-1), /失效|无法/u);
});

test('W4: another chat cannot press this greeting', async (t) => {
  const previous = setImHostLanguage('zh');
  t.after(() => setImHostLanguage(previous));
  const { bot, notices } = botFixture();
  const card = new TelegramWelcomeCard({ logger: quietLogger });
  await card.present({ bot, target: { chatId: 42 }, conversationKey: 'direct:42' });
  const entry = card.registry.activeFor('direct:42');
  const ran = [];
  await card.handlePress(
    { data: TELEGRAM_WELCOME_CARD_CALLBACK.encode({ nonce: entry.nonce, action: 'm' }), replyTarget: { chatId: 99 } },
    { bot, answer: (text) => notices.push(text), conversationKey: 'direct:99', run: async (command) => { ran.push(command); return { handled: true }; } },
  );
  assert.deepEqual(ran, [], 'a press from another conversation does nothing');
});

test('W5: a superseded greeting is refused and its keyboard is cleared', async (t) => {
  const previous = setImHostLanguage('zh');
  t.after(() => setImHostLanguage(previous));
  const cleared = [];
  const bot = {
    async sendText() {},
    async answerInteractionCallback() {},
    async sendInteractionCard(_target, card) { cards.push(card); return { providerMessageIds: [String(700 + cards.length)] }; },
    // Only the keyboard-only edit counts here: `editInteractionCard` would need a
    // text and would throw on a real client.
    async updateInteractionCard(target, messageId, payload) { cleared.push({ target, messageId, payload }); },
  };
  const cards = [];
  const card = new TelegramWelcomeCard({ logger: quietLogger });
  await card.present({ bot, target: { chatId: 42 }, conversationKey: 'direct:42' });
  const first = card.registry.activeFor('direct:42');
  await card.present({ bot, target: { chatId: 42 }, conversationKey: 'direct:42' });
  const ran = [];
  const notices = [];
  await card.handlePress(
    { data: TELEGRAM_WELCOME_CARD_CALLBACK.encode({ nonce: first.nonce, action: 'm' }), replyTarget: { chatId: 42 } },
    { bot, answer: (text) => notices.push(text), conversationKey: 'direct:42', run: async (command) => { ran.push(command); return { handled: true }; } },
  );
  assert.deepEqual(ran, [], 'a superseded greeting must not run anything');
  assert.equal(cleared.length, 1, 'the dead keyboard is removed through the keyboard-only API');
  assert.equal(cleared[0].messageId, 701);
  assert.deepEqual(cleared[0].payload, { markup: { inline_keyboard: [] } });
});
