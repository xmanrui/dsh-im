import assert from 'node:assert/strict';
import test from 'node:test';

import { ActionCardRegistry, ACTION_CARD_STATUS } from '../../../src/channels/shared/action-card.mjs';
import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import { TextHarnessBridge } from '../../../src/channels/shared/text-harness-bridge.mjs';
import {
  CLEAR_CARD_CANCEL,
  CLEAR_CARD_CONFIRM,
  TELEGRAM_CLEAR_CARD_CALLBACK,
  TelegramClearCard,
  clearCardText,
  parseTelegramClearCardCallback,
  renderClearCard,
} from '../../../src/channels/telegram/clear-card.mjs';

const EMPTY_KEYBOARD = { inline_keyboard: [] };
const SESSION_ID = 'session-abcdef1234567890';
const WORKSPACE = '/home/wings/project';

function stateFixture({ sessionId = SESSION_ID } = {}) {
  const sessions = new Map();
  const seen = new Set();
  if (sessionId) sessions.set('direct:chat-a', sessionId);
  return {
    sessionFor: (key) => sessions.get(key) ?? null,
    async setSession(key, value) { sessions.set(key, value); },
    async clearSession(key) { sessions.delete(key); },
    hasSeen: (id) => seen.has(id),
    async markSeen(id) { seen.add(id); },
    async unmarkSeen(id) { return seen.delete(id); },
  };
}

/** A bot that records cards, edits, ack notices and plain texts. */
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
      return { providerMessageIds: [String(700 + cards.length)] };
    };
    bot.editInteractionCard = async (_target, messageId, { text, markup } = {}) => {
      if (editResult === 'fail') throw new Error('telegram refused the edit');
      edits.push({ messageId, text, markup });
      return { messageId, text, markup };
    };
  }
  return { bot, sent, cards, edits, notices };
}

/** A harness whose /clear either succeeds or returns one scripted failure. */
function harnessFixture({ result = { kind: 'success' }, clearError = null } = {}) {
  const calls = [];
  return {
    calls,
    async ensureRunning() {},
    currentWorkspace: () => WORKSPACE,
    currentConversationWorkspace: () => WORKSPACE,
    workspaceSession: (sessionId, key) => {
      assert.equal(sessionId, SESSION_ID);
      assert.equal(key, 'direct:chat-a');
      return {
        async executeCommand(text, options) {
          calls.push(['executeCommand', text, options]);
          if (clearError) throw clearError;
          return { result };
        },
      };
    },
  };
}

function bridgeFor({ bot, harness = harnessFixture(), state = stateFixture(), clearCard } = {}) {
  return new TextHarnessBridge({
    descriptor: { key: 'telegram', label: 'Telegram' },
    bot,
    harness,
    state,
    // Default: a real confirmation (same as the Telegram bridge). `null` keeps
    // the immediate behaviour for the no-keyboard regression case.
    clearCard: clearCard === undefined ? new TelegramClearCard({ logger: { warn() {} } }) : clearCard,
    logger: { warn() {}, error() {} },
  });
}

function clearMessage(messageId = 'm-clear') {
  return {
    messageId,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    content: '/clear',
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
    providerMessageId: '701',
    data,
    replyTarget: { chatId: 42 },
    ...overrides,
  };
}

test('the body says what survives the clear, because the wording is ambiguous', () => {
  const text = clearCardText({ workspace: WORKSPACE, sessionId: SESSION_ID });
  assert.match(text, /确定要清空当前会话的上下文吗？/u);
  assert.match(text, /Session 绑定和历史记录仍会保留/u);
  assert.match(text, /这个操作不能撤销/u);
  assert.match(text, new RegExp(SESSION_ID, 'u'));
  assert.match(text, new RegExp(WORKSPACE.replaceAll('/', '\\/'), 'u'));
  // Without a known session/workspace the body still explains the consequence.
  const minimal = clearCardText();
  assert.match(minimal, /确定要清空/u);
  assert.doesNotMatch(minimal, /会话：/u);
});

test('the confirmation carries exactly two attributable buttons', () => {
  const card = renderClearCard('abcd1234EFGH', 'body');
  const rows = card.markup.inline_keyboard;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].length, 2);
  const [confirm, cancel] = rows[0];
  assert.match(confirm.text, /清空上下文/u);
  assert.match(cancel.text, /取消/u);
  for (const button of rows[0]) {
    assert.ok(Buffer.byteLength(button.callback_data, 'utf8') <= 64);
    assert.match(button.callback_data, /^c2\|abcd1234EFGH\|/u);
  }
  assert.deepEqual(parseTelegramClearCardCallback(confirm.callback_data), {
    kind: 'clear', nonce: 'abcd1234EFGH', action: CLEAR_CARD_CONFIRM,
  });
  assert.deepEqual(parseTelegramClearCardCallback(cancel.callback_data), {
    kind: 'clear', nonce: 'abcd1234EFGH', action: CLEAR_CARD_CANCEL,
  });
  // Foreign namespaces and unknown actions are not ours.
  assert.equal(parseTelegramClearCardCallback('p1|abcd1234EFGH|i1'), null);
  assert.equal(parseTelegramClearCardCallback(TELEGRAM_CLEAR_CARD_CALLBACK.encode({
    nonce: 'abcd1234EFGH', action: 'z',
  })), null);
  assert.equal(parseTelegramClearCardCallback('garbage'), null);
});

test('/clear asks first instead of executing immediately', async () => {
  const harness = harnessFixture();
  const { bot, cards, sent } = botFixture();
  const bridge = bridgeFor({ bot, harness });
  await bridge.accept(clearMessage());
  assert.equal(cards.length, 1, 'one confirmation card');
  assert.equal(cards[0].markup.inline_keyboard.length, 1);
  assert.equal(
    harness.calls.filter((call) => call[0] === 'executeCommand').length,
    0,
    'nothing is cleared before the user confirms',
  );
  assert.deepEqual(sent, [], 'no text output for the prompt');
});

test('confirming runs the real /clear and reports the result in place', async () => {
  const harness = harnessFixture();
  const { bot, cards, edits } = botFixture();
  const bridge = bridgeFor({ bot, harness });
  await bridge.accept(clearMessage());
  const confirm = cards[0].markup.inline_keyboard[0][0];
  await bridge.acceptCallback(callbackFor(confirm.callback_data));

  assert.equal(
    harness.calls.filter((call) => call[0] === 'executeCommand').length,
    1,
    'the command runs exactly once',
  );
  assert.equal(harness.calls.find((call) => call[0] === 'executeCommand')[1], '/clear');
  assert.equal(edits.length, 1, 'the prompt turns into the result');
  assert.match(edits[0].text, /上下文已清空/u);
  assert.deepEqual(edits[0].markup, EMPTY_KEYBOARD, 'the keyboard is gone');
});

test('cancelling changes nothing', async () => {
  const harness = harnessFixture();
  const { bot, cards, edits } = botFixture();
  const bridge = bridgeFor({ bot, harness });
  await bridge.accept(clearMessage());
  const cancel = cards[0].markup.inline_keyboard[0][1];
  await bridge.acceptCallback(callbackFor(cancel.callback_data));
  assert.equal(
    harness.calls.filter((call) => call[0] === 'executeCommand').length,
    0,
    'a cancel must never clear the context',
  );
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /已取消/u);
});

test('a double press clears once', async () => {
  const harness = harnessFixture();
  const { bot, cards } = botFixture();
  const bridge = bridgeFor({ bot, harness });
  await bridge.accept(clearMessage());
  const confirm = cards[0].markup.inline_keyboard[0][0];
  await Promise.all([
    bridge.acceptCallback(callbackFor(confirm.callback_data, { callbackQueryId: 'cb-1' })),
    bridge.acceptCallback(callbackFor(confirm.callback_data, {
      callbackQueryId: 'cb-2', messageId: 'update-2',
    })),
  ]);
  assert.equal(
    harness.calls.filter((call) => call[0] === 'executeCommand').length,
    1,
    'the shared clear is only run once',
  );
});

test('a failed clear shows the failure text instead of a success receipt', async () => {
  const harness = harnessFixture({
    result: { kind: 'error', failure: { code: 'agent-busy' } },
  });
  const { bot, cards, edits } = botFixture();
  const bridge = bridgeFor({ bot, harness });
  await bridge.accept(clearMessage());
  await bridge.acceptCallback(callbackFor(cards[0].markup.inline_keyboard[0][0].callback_data));
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /正在生成回复或等待交互/u);
  assert.doesNotMatch(edits[0].text, /上下文已清空/u);
});

test('a channel without keyboard support runs /clear immediately', async () => {
  const harness = harnessFixture();
  const { bot, cards, sent } = botFixture({ supportsCards: false });
  const bridge = bridgeFor({ bot, harness });
  await bridge.accept(clearMessage());
  assert.equal(cards.length, 0);
  assert.equal(
    harness.calls.filter((call) => call[0] === 'executeCommand').length,
    1,
    'no keyboard means no new confirmation step',
  );
  assert.match(sent.join('\n'), /上下文已清空/u);
});

test('clearCard: null keeps the pre-card behaviour', async () => {
  const harness = harnessFixture();
  const { bot, sent } = botFixture();
  const bridge = bridgeFor({ bot, harness, clearCard: null });
  await bridge.accept(clearMessage());
  assert.equal(harness.calls.filter((call) => call[0] === 'executeCommand').length, 1);
  assert.match(sent.join('\n'), /上下文已清空/u);
});

test('a refused card send falls back to clearing immediately', async () => {
  const harness = harnessFixture();
  const { bot, cards, sent } = botFixture({ cardResult: 'fail' });
  const bridge = bridgeFor({ bot, harness });
  await bridge.accept(clearMessage());
  assert.equal(cards.length, 0);
  assert.equal(
    harness.calls.filter((call) => call[0] === 'executeCommand').length,
    1,
    'a failed prompt must not block the command the user typed',
  );
  assert.match(sent.join('\n'), /上下文已清空/u);
});

test('with no session bound the command answers instead of a pointless card', async () => {
  const { bot, cards, sent } = botFixture();
  const bridge = bridgeFor({
    bot,
    harness: harnessFixture(),
    state: stateFixture({ sessionId: null }),
  });
  await bridge.accept(clearMessage());
  assert.equal(cards.length, 0, 'nothing to clear means nothing to confirm');
  assert.match(sent.join('\n'), /还没有可清空的会话/u);
});

test('an expired confirmation cannot clear a session later', async () => {
  let now = 1_000_000;
  const card = new TelegramClearCard({
    logger: { warn() {} },
    registry: new ActionCardRegistry({
      now: () => now, ttlMs: 50, createNonce: () => 'abcd1234EFGH',
    }),
  });
  const { bot, cards, edits } = botFixture();
  await card.present({
    bot, target: { chatId: 42 }, conversationKey: 'direct:chat-a', sessionId: SESSION_ID,
  });
  now += 100;
  let ran = 0;
  await card.handlePress(callbackFor(cards[0].markup.inline_keyboard[0][0].callback_data), {
    bot, answer: () => {}, conversationKey: 'direct:chat-a', run: async () => { ran += 1; return null; },
  });
  assert.equal(ran, 0, 'an expired prompt must never run /clear');
  assert.ok(edits.length >= 1, 'its dead keyboard is retired');
});

test('a confirmation from another chat cannot clear this one', async () => {
  const card = new TelegramClearCard({ logger: { warn() {} } });
  const { bot, cards } = botFixture();
  await card.present({
    bot, target: { chatId: 42 }, conversationKey: 'direct:chat-a', sessionId: SESSION_ID,
  });
  let ran = 0;
  await card.handlePress(
    callbackFor(cards[0].markup.inline_keyboard[0][0].callback_data, { conversationId: 'chat-b' }),
    {
      bot, answer: () => {}, conversationKey: 'direct:chat-b',
      run: async () => { ran += 1; return null; },
    },
  );
  assert.equal(ran, 0);
});

test('a newer prompt supersedes the previous keyboard', async () => {
  let counter = 0;
  const card = new TelegramClearCard({
    logger: { warn() {} },
    registry: new ActionCardRegistry({ createNonce: () => `nonce-${++counter}` }),
  });
  const { bot, cards, edits } = botFixture();
  const present = () => card.present({
    bot, target: { chatId: 42 }, conversationKey: 'direct:chat-a', sessionId: SESSION_ID,
  });
  await present();
  const staleData = cards[0].markup.inline_keyboard[0][0].callback_data;
  await present();
  // The first prompt's keyboard must already be gone.
  assert.ok(edits.some((edit) => edit.markup === EMPTY_KEYBOARD || edit.markup?.inline_keyboard?.length === 0));
  let ran = 0;
  await card.handlePress(callbackFor(staleData), {
    bot, answer: () => {}, conversationKey: 'direct:chat-a', run: async () => { ran += 1; return null; },
  });
  assert.equal(ran, 0, 'a superseded prompt must not clear anything');
});

test('clear card labels follow the host language', (t) => {
  const previous = setImHostLanguage('en');
  t.after(() => setImHostLanguage(previous));
  const text = clearCardText({ sessionId: SESSION_ID });
  assert.match(text, /Clear the context of this conversation/u);
  assert.match(text, /This cannot be undone/u);
  const card = renderClearCard('abcd1234EFGH', text);
  assert.equal(card.markup.inline_keyboard[0][0].text, '🗑 Clear context');
  assert.equal(card.markup.inline_keyboard[0][1].text, '✖️ Cancel');
});

test('a stale claim never runs the command twice', async () => {
  const card = new TelegramClearCard({ logger: { warn() {} } });
  const { bot, cards } = botFixture();
  await card.present({
    bot, target: { chatId: 42 }, conversationKey: 'direct:chat-a', sessionId: SESSION_ID,
  });
  const data = cards[0].markup.inline_keyboard[0][0].callback_data;
  // Claim it out of band, as a press that is still in flight would.
  card.registry.claim(parseTelegramClearCardCallback(data).nonce);
  let ran = 0;
  await card.handlePress(callbackFor(data), {
    bot, answer: () => {}, conversationKey: 'direct:chat-a', run: async () => { ran += 1; return null; },
  });
  assert.equal(ran, 0);
  assert.equal(card.registry.get(parseTelegramClearCardCallback(data).nonce).status,
    ACTION_CARD_STATUS.CLAIMED);
});
