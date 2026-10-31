import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { ActionCardRegistry, ACTION_CARD_STATUS } from '../../../src/channels/shared/action-card.mjs';
import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import { TextHarnessBridge } from '../../../src/channels/shared/text-harness-bridge.mjs';
import {
  TELEGRAM_CONV_CARD_CALLBACK,
  TELEGRAM_CONV_CARD_MAX_ITEMS,
  TELEGRAM_CONV_CLEAR_ACTION,
  TelegramConvCard,
  convCardText,
  parseTelegramConvCardCallback,
  renderConvCard,
} from '../../../src/channels/telegram/conv-card.mjs';

const EMPTY_KEYBOARD = { inline_keyboard: [] };

let A = '';
let B = '';

before(async () => {
  // `/conv` validates the target against the Host's registered workspaces, so the
  // fixture paths must be real directories.
  A = await mkdtemp(join(tmpdir(), 'conv-card-a-'));
  B = await mkdtemp(join(tmpdir(), 'conv-card-b-'));
});

after(async () => {
  for (const path of [A, B]) {
    if (path) await rm(path, { recursive: true, force: true });
  }
});

function listing({ current = A, bound = false, paths = [A, B] } = {}) {
  return { current, bound, paths };
}

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
      return { providerMessageIds: [String(400 + cards.length)] };
    };
    bot.editInteractionCard = async (_target, messageId, { text, markup } = {}) => {
      if (editResult === 'fail') throw new Error('telegram refused the edit');
      edits.push({ messageId, text, markup });
      return { messageId, text, markup };
    };
  }
  return { bot, sent, cards, edits, notices };
}

/**
 * A Host whose conversation pin is real state, so the card can be exercised
 * against the same `/conv` command the text path uses.
 */
function harnessFixture() {
  const pinned = new Map();
  const calls = [];
  return {
    calls,
    pinned,
    currentWorkspace: () => A,
    currentConversationWorkspace: (key) => pinned.get(key) ?? A,
    hasConversationWorkspaceOverride: (key) => pinned.has(key),
    async switchConversationWorkspace(key, path) {
      calls.push(['switch', key, path]);
      pinned.set(key, path);
      return path;
    },
    async clearConversationWorkspace(key) {
      calls.push(['clear', key]);
      pinned.delete(key);
      return A;
    },
    // workspacePathSnapshot reads a plain path array, not a listing object.
    async listWorkspaces() {
      return [A, B];
    },
    assertWorkspaceScope() {},
  };
}

function bridgeFor({ bot, harness = harnessFixture(), convCard } = {}) {
  return new TextHarnessBridge({
    descriptor: { key: 'telegram', label: 'Telegram' },
    bot,
    harness,
    state: { hasSeen: () => false, async markSeen() {}, sessionFor: () => null },
    convCard: convCard === undefined ? new TelegramConvCard({ logger: { warn() {} } }) : convCard,
    logger: { warn() {}, error() {} },
  });
}

function convMessage() {
  return {
    messageId: 'm-conv',
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    content: '/conv',
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

test('the body states this is conversation-scoped and points /ws at the default', () => {
  const text = convCardText(listing());
  assert.match(text, /本对话专属工作区/u);
  assert.match(text, new RegExp(A.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
  assert.match(text, /未显式绑定/u);
  // The one thing users confuse: /conv is not /ws.
  assert.match(text, /这里只影响本对话；改所有对话请用 \/ws/u);
});

test('a pinned conversation says so, and an unset one explains the fallback', () => {
  assert.match(convCardText(listing({ bound: true })), /已为本对话显式绑定/u);
  assert.match(convCardText(listing({ current: null, paths: [] })), /当前：未设置/u);
});

test('the card marks the current workspace and numbers the rest', () => {
  const card = renderConvCard(listing({ current: A }), 'abcd1234EFGH');
  const rows = card.markup.inline_keyboard;
  const labels = rows.flat().map((button) => button.text);
  assert.ok(labels[0].startsWith('✓ 1. '), labels[0]);
  assert.ok(labels[1].startsWith('2. '), labels[1]);
  for (const button of rows.flat()) {
    assert.ok(Buffer.byteLength(button.callback_data, 'utf8') <= 64);
    assert.match(button.callback_data, /^v1\|abcd1234EFGH\|/u);
  }
});

test('清理 only appears when this conversation is actually pinned', () => {
  const unbound = renderConvCard(listing({ bound: false }), 'abcd');
  assert.ok(!unbound.markup.inline_keyboard.flat()
    .some((button) => button.callback_data.endsWith(`|${TELEGRAM_CONV_CLEAR_ACTION}`)));
  const bound = renderConvCard(listing({ bound: true }), 'abcd');
  assert.ok(bound.markup.inline_keyboard.flat()
    .some((button) => button.callback_data.endsWith(`|${TELEGRAM_CONV_CLEAR_ACTION}`)));
});

test('an unrenderable listing keeps the text path', () => {
  assert.equal(renderConvCard(null, 'abcd'), null);
  assert.equal(renderConvCard({ paths: [] }, 'abcd'), null);
  assert.equal(renderConvCard({ paths: ['a\u0000b'] }, 'abcd'), null);
  const tooMany = { paths: Array.from({ length: TELEGRAM_CONV_CARD_MAX_ITEMS + 1 }, (_v, i) => `/p${i}`) };
  assert.equal(renderConvCard(tooMany, 'abcd'), null);
});

test('a press parses only from this namespace', () => {
  const pick = TELEGRAM_CONV_CARD_CALLBACK.encode({ nonce: 'abcd1234EFGH', action: 'i2' });
  assert.deepEqual(parseTelegramConvCardCallback(pick), {
    nonce: 'abcd1234EFGH', action: 'i2', kind: 'conv-pick', index: 2,
  });
  const clear = TELEGRAM_CONV_CARD_CALLBACK.encode({
    nonce: 'abcd1234EFGH', action: TELEGRAM_CONV_CLEAR_ACTION,
  });
  assert.equal(parseTelegramConvCardCallback(clear).kind, 'conv-clear');
  assert.equal(parseTelegramConvCardCallback('s2|abcd1234EFGH|i1'), null);
  assert.equal(parseTelegramConvCardCallback(TELEGRAM_CONV_CARD_CALLBACK.encode({
    nonce: 'abcd1234EFGH', action: 'zz',
  })), null);
  assert.equal(parseTelegramConvCardCallback('garbage'), null);
});

test('/conv sends a picker card instead of the text listing', async () => {
  const { bot, cards, sent } = botFixture();
  const bridge = bridgeFor({ bot });
  await bridge.accept(convMessage());
  assert.equal(cards.length, 1);
  assert.match(cards[0].text, /本对话专属工作区/u);
  assert.deepEqual(sent, [], 'the text listing is replaced by the card');
});

test('picking a workspace pins this conversation only', async () => {
  const harness = harnessFixture();
  const { bot, cards, sent, edits } = botFixture();
  const bridge = bridgeFor({ bot, harness });
  await bridge.accept(convMessage());
  assert.ok(A && B, `fixtures must be set: A=${A} B=${B}`);
  assert.equal(cards.length, 1);
  const second = cards[0].markup.inline_keyboard[1][0];
  await bridge.acceptCallback(callbackFor(second.callback_data));

  const switched = harness.calls.find((call) => call[0] === 'switch');
  assert.equal(switched[1], 'direct:chat-a');
  assert.equal(switched[2], B);
  // The command's own wording is delivered, and the keyboard is retired.
  assert.ok(sent.some((text) => /当前对话工作区已切换为/u.test(text)), JSON.stringify(sent));
  assert.ok(edits.length >= 1, 'the keyboard is retired after the switch');
});

test('清理 unpins the conversation', async () => {
  const harness = harnessFixture();
  harness.pinned.set('direct:chat-a', B);
  const { bot, cards } = botFixture();
  const bridge = bridgeFor({ bot, harness });
  await bridge.accept(convMessage());
  const clear = cards[0].markup.inline_keyboard.at(-1)[0];
  assert.match(clear.text, /清除专属/u);
  await bridge.acceptCallback(callbackFor(clear.callback_data));
  assert.ok(harness.calls.some((call) => call[0] === 'clear'));
  assert.equal(harness.pinned.has('direct:chat-a'), false);
});

test('the card never touches the bot-wide default', async () => {
  const harness = harnessFixture();
  const { bot, cards } = botFixture();
  const bridge = bridgeFor({ bot, harness });
  await bridge.accept(convMessage());
  await bridge.acceptCallback(callbackFor(cards[0].markup.inline_keyboard[1][0].callback_data));
  assert.equal(harness.calls.filter((call) => call[0] === 'switch').length, 1);
  assert.equal(harness.calls.some((call) => call[0] === 'clear'), false,
    'only the conversation pin changes');
});

test('a channel without keyboards gets the text listing', async () => {
  const { bot, cards, sent } = botFixture({ supportsCards: false });
  const bridge = bridgeFor({ bot });
  await bridge.accept(convMessage());
  assert.equal(cards.length, 0);
  assert.match(sent.join('\n'), /当前对话工作区/u);
});

test('convCard: null keeps the text listing', async () => {
  const { bot, cards, sent } = botFixture();
  const bridge = bridgeFor({ bot, convCard: null });
  await bridge.accept(convMessage());
  assert.equal(cards.length, 0);
  assert.match(sent.join('\n'), /当前对话工作区/u);
});

test('a refused card send falls back to the text listing', async () => {
  const { bot, cards, sent } = botFixture({ cardResult: 'fail' });
  const bridge = bridgeFor({ bot });
  await bridge.accept(convMessage());
  assert.equal(cards.length, 0);
  assert.match(sent.join('\n'), /当前对话工作区/u);
});

test('a stale press whose path vanished is refused, not guessed', async () => {
  const card = new TelegramConvCard({ logger: { warn() {} } });
  const { bot, cards, notices } = botFixture();
  await card.present({
    bot, target: { chatId: 42 }, conversationKey: 'direct:chat-a', listing: listing(),
  });
  const forged = TELEGRAM_CONV_CARD_CALLBACK.encode({ nonce: 'forged', action: 'i9' });
  let switches = 0;
  await card.handlePress(callbackFor(forged), {
    bot, answer: () => {}, conversationKey: 'direct:chat-a',
    switchTo: async () => { switches += 1; return null; },
  });
  assert.equal(switches, 0);
  assert.equal(cards.length, 1);
});

test('an expired card is refused', async () => {
  let now = 1_000_000;
  const card = new TelegramConvCard({
    logger: { warn() {} },
    registry: new ActionCardRegistry({ now: () => now, ttlMs: 50, createNonce: () => 'abcd1234EFGH' }),
  });
  const { bot, cards, edits } = botFixture();
  await card.present({
    bot, target: { chatId: 42 }, conversationKey: 'direct:chat-a', listing: listing({ bound: true }),
  });
  now += 100;
  let switches = 0;
  await card.handlePress(callbackFor(cards[0].markup.inline_keyboard[0][0].callback_data), {
    bot, answer: () => {}, conversationKey: 'direct:chat-a',
    switchTo: async () => { switches += 1; return null; },
  });
  assert.equal(switches, 0);
  assert.ok(edits.every((edit) => edit.text === undefined));
});

test('a press from another chat cannot pin this one', async () => {
  const card = new TelegramConvCard({ logger: { warn() {} } });
  const { bot, cards } = botFixture();
  await card.present({
    bot, target: { chatId: 42 }, conversationKey: 'direct:chat-a', listing: listing(),
  });
  let switches = 0;
  await card.handlePress(
    callbackFor(cards[0].markup.inline_keyboard[0][0].callback_data, { conversationId: 'chat-b' }),
    {
      bot, answer: () => {}, conversationKey: 'direct:chat-b',
      switchTo: async () => { switches += 1; return null; },
    },
  );
  assert.equal(switches, 0);
});

test('a failed switch keeps the picker usable', async () => {
  const card = new TelegramConvCard({ logger: { warn() {} } });
  const { bot, cards } = botFixture();
  await card.present({
    bot, target: { chatId: 42 }, conversationKey: 'direct:chat-a', listing: listing(),
  });
  const data = cards[0].markup.inline_keyboard[1][0].callback_data;
  let attempts = 0;
  const answers = [];
  await card.handlePress(callbackFor(data), {
    bot, answer: (text) => answers.push(text), conversationKey: 'direct:chat-a',
    switchTo: async () => { attempts += 1; throw new Error('host down'); },
  });
  assert.equal(attempts, 1);
  // The picker reports the failure rather than pretending it worked.
  assert.ok(answers.some((text) => /没有完成/u.test(text ?? '')), JSON.stringify(answers));
  // The claim was released, so the button still works.
  assert.equal(card.registry.get(parseTelegramConvCardCallback(data).nonce).status,
    ACTION_CARD_STATUS.ACTIVE);
});

test('conv card labels follow the host language', (t) => {
  const previous = setImHostLanguage('en');
  t.after(() => setImHostLanguage(previous));
  const text = convCardText(listing({ bound: true }));
  assert.match(text, /Workspace for this conversation/u);
  assert.match(text, /use \/ws/u);
  const card = renderConvCard(listing({ bound: true }), 'abcd1234EFGH');
  assert.match(card.markup.inline_keyboard.at(-1)[0].text, /Clear pin/u);
});

