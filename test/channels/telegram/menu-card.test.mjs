import assert from 'node:assert/strict';
import test from 'node:test';

import { ActionCardRegistry, ACTION_CARD_STATUS } from '../../../src/channels/shared/action-card.mjs';
import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import { runMenuCommand } from '../../../src/channels/shared/menu-command.mjs';
import { TextHarnessBridge } from '../../../src/channels/shared/text-harness-bridge.mjs';
import {
  TELEGRAM_MENU_ACTIONS,
  TELEGRAM_MENU_CARD_CALLBACK,
  TelegramMenuCard,
  menuActionCommand,
  menuCardText,
  parseTelegramMenuCardCallback,
  renderMenuCard,
} from '../../../src/channels/telegram/menu-card.mjs';

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

function botFixture({ cardResult = 'ok', supportsCards = true } = {}) {
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
      return { providerMessageIds: [String(800 + cards.length)] };
    };
    bot.editInteractionCard = async (_target, messageId, { markup } = {}) => {
      edits.push({ messageId, markup });
      return { messageId, markup };
    };
  }
  return { bot, sent, cards, edits, notices };
}

function harnessFixture() {
  const calls = [];
  return {
    calls,
    async ensureRunning() {},
    currentWorkspace: () => WORKSPACE,
    currentConversationWorkspace: () => WORKSPACE,
    async listWorkspaces() {
      calls.push(['listWorkspaces']);
      return { current: WORKSPACE, paths: [WORKSPACE], titles: {} };
    },
    workspaceSession: () => ({
      async sessionExists() { return true; },
      async models() {
        return {
          groups: [],
          failures: [],
          current: { provider: 'p', model: 'm' },
        };
      },
      async isRunning() { return false; },
      async executeCommand() { return { result: { kind: 'success' } }; },
    }),
  };
}

function bridgeFor({ bot, harness = harnessFixture(), state = stateFixture(), menuCard } = {}) {
  return new TextHarnessBridge({
    descriptor: { key: 'telegram', label: 'Telegram' },
    bot,
    harness,
    state,
    menuCard: menuCard === undefined ? new TelegramMenuCard({ logger: { warn() {} } }) : menuCard,
    logger: { warn() {}, error() {} },
  });
}

function menuMessage(messageId = 'm-menu') {
  return {
    messageId,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    content: '/menu',
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

test('the hub body summarizes the current state from the data /status already reads', () => {
  const text = menuCardText({
    workspace: WORKSPACE,
    sessionId: SESSION_ID,
    model: 'p/m',
    preset: 'standard',
    running: true,
  });
  assert.match(text, /DeepSeek Harness 控制台/u);
  // A long absolute path is cut to its last segment to keep the card short.
  assert.match(text, /工作区：project/u);
  assert.doesNotMatch(text, /\/home\/wings\/project/u);
  assert.match(text, new RegExp(SESSION_ID, 'u'));
  assert.match(text, /模型：p\/m/u);
  assert.match(text, /预设：standard/u);
  assert.match(text, /正在运行/u);
});

test('every field is optional: a thin Host still gets a usable hub', () => {
  const text = menuCardText({});
  assert.match(text, /DeepSeek Harness 控制台/u);
  assert.match(text, /会话：未绑定/u);
  assert.doesNotMatch(text, /工作区：/u);
  assert.doesNotMatch(text, /模型：/u);
  assert.doesNotMatch(text, /正在运行/u);
});

test('the hub carries six attributable entries in two rows', () => {
  const card = renderMenuCard('abcd1234EFGH');
  const rows = card.markup.inline_keyboard;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].length, 3);
  assert.equal(rows[1].length, 3);
  const payloads = rows.flat().map((button) => button.callback_data);
  for (const payload of payloads) {
    assert.ok(Buffer.byteLength(payload, 'utf8') <= 64, payload);
    assert.match(payload, /^m3\|abcd1234EFGH\|/u);
  }
  assert.deepEqual(
    payloads.map((payload) => parseTelegramMenuCardCallback(payload).action),
    Object.values(TELEGRAM_MENU_ACTIONS),
  );
  // Foreign namespaces and unknown actions are not ours.
  assert.equal(parseTelegramMenuCardCallback('c2|abcd1234EFGH|y'), null);
  assert.equal(parseTelegramMenuCardCallback(TELEGRAM_MENU_CARD_CALLBACK.encode({
    nonce: 'abcd1234EFGH', action: 'z',
  })), null);
  assert.equal(parseTelegramMenuCardCallback('garbage'), null);
});

test('every entry maps to a command that already exists', () => {
  assert.equal(menuActionCommand(TELEGRAM_MENU_ACTIONS.sessions), '/sessionlist');
  assert.equal(menuActionCommand(TELEGRAM_MENU_ACTIONS.workspace), '/ws');
  assert.equal(menuActionCommand(TELEGRAM_MENU_ACTIONS.models), '/models');
  assert.equal(menuActionCommand(TELEGRAM_MENU_ACTIONS.presets), '/presetlist');
  assert.equal(menuActionCommand(TELEGRAM_MENU_ACTIONS.status), '/status');
  assert.equal(menuActionCommand(TELEGRAM_MENU_ACTIONS.help), '/help');
  assert.equal(menuActionCommand('nope'), null);
});

test('/menu sends the hub card instead of plain text', async () => {
  const { bot, cards, sent } = botFixture();
  const bridge = bridgeFor({ bot });
  await bridge.accept(menuMessage());
  assert.equal(cards.length, 1);
  assert.equal(cards[0].markup.inline_keyboard.length, 2);
  assert.match(cards[0].text, /DeepSeek Harness 控制台/u);
  assert.deepEqual(sent, [], 'the text fallback is not sent when the card lands');
});

test('pressing an entry replays its command and keeps the hub usable', async () => {
  const { bot, cards } = botFixture();
  const bridge = bridgeFor({ bot });
  await bridge.accept(menuMessage());
  const statusButton = cards[0].markup.inline_keyboard[1][1]; // 📊 状态
  assert.equal(parseTelegramMenuCardCallback(statusButton.callback_data).action,
    TELEGRAM_MENU_ACTIONS.status);
  await bridge.acceptCallback(callbackFor(statusButton.callback_data));
  // The hub itself is a launcher: it is never settled or repainted.
  assert.equal(cards.length, 1, 'no second card was opened');
});

test('the help entry answers with the command help, not the hub', async () => {
  const { bot, cards, sent } = botFixture();
  const bridge = bridgeFor({ bot });
  await bridge.accept(menuMessage());
  const helpButton = cards[0].markup.inline_keyboard[1][2]; // ❓ 帮助
  await bridge.acceptCallback(callbackFor(helpButton.callback_data));
  assert.ok(sent.length >= 1, 'the help text is delivered');
  assert.match(sent.join('\n'), /DeepSeek Harness/u);
});

test('a refused card send falls back to the text menu', async () => {
  const { bot, cards, sent } = botFixture({ cardResult: 'fail' });
  const bridge = bridgeFor({ bot });
  await bridge.accept(menuMessage());
  assert.equal(cards.length, 0);
  assert.match(sent.join('\n'), /菜单在当前渠道以文字方式提供|目前支持/u);
});

test('menuCard: null keeps the text menu', async () => {
  const { bot, cards, sent } = botFixture();
  const bridge = bridgeFor({ bot, menuCard: null });
  await bridge.accept(menuMessage());
  assert.equal(cards.length, 0);
  assert.ok(sent.length >= 1);
});

test('the shared text menu lists the pickers and refuses images', async () => {
  const listed = await runMenuCommand('/menu', null, null, 'direct:chat-a', {});
  assert.equal(listed.handled, true);
  assert.match(listed.message, /\/sessionlist/u);
  assert.match(listed.message, /\/ws/u);
  assert.match(listed.message, /\/models/u);
  assert.match(listed.message, /\/presetlist/u);
  const withImages = await runMenuCommand('/menu', null, null, 'direct:chat-a', { hasImages: true });
  assert.match(withImages.message, /仅支持纯文字/u);
  assert.equal(await runMenuCommand('/menux', null, null, 'direct:chat-a', {}), null);
});

test('a press from another chat cannot drive this hub', async () => {
  const card = new TelegramMenuCard({ logger: { warn() {} } });
  const { bot, cards, notices } = botFixture();
  await card.present({
    bot, target: { chatId: 42 }, conversationKey: 'direct:chat-a', snapshot: {},
  });
  let ran = 0;
  await card.handlePress(
    callbackFor(cards[0].markup.inline_keyboard[0][0].callback_data, { conversationId: 'chat-b' }),
    { bot, answer: () => {}, conversationKey: 'direct:chat-b', run: async () => { ran += 1; return null; } },
  );
  assert.equal(ran, 0);
  assert.equal(cards.length, 1);
});

test('the hub works repeatedly, unlike a one-shot prompt', async () => {
  const card = new TelegramMenuCard({ logger: { warn() {} } });
  const { bot, cards } = botFixture();
  await card.present({
    bot, target: { chatId: 42 }, conversationKey: 'direct:chat-a', snapshot: {},
  });
  const data = cards[0].markup.inline_keyboard[0][2].callback_data; // 🤖 模型
  let runs = 0;
  for (let index = 0; index < 3; index += 1) {
    await card.handlePress(callbackFor(data), {
      bot,
      answer: () => {},
      conversationKey: 'direct:chat-a',
      run: async () => { runs += 1; return { handled: true, message: 'ok' }; },
    });
  }
  assert.equal(runs, 3, 'a launcher is not consumed by one press');
});

test('an expired hub is refused', async () => {
  let now = 1_000_000;
  const card = new TelegramMenuCard({
    logger: { warn() {} },
    registry: new ActionCardRegistry({ now: () => now, ttlMs: 50, createNonce: () => 'abcd1234EFGH' }),
  });
  const { bot, cards, edits } = botFixture();
  await card.present({
    bot, target: { chatId: 42 }, conversationKey: 'direct:chat-a', snapshot: {},
  });
  now += 100;
  let ran = 0;
  await card.handlePress(callbackFor(cards[0].markup.inline_keyboard[0][0].callback_data), {
    bot,
    answer: () => {},
    conversationKey: 'direct:chat-a',
    run: async () => { ran += 1; return null; },
  });
  assert.equal(ran, 0);
  assert.ok(edits.some((edit) => edit.markup === EMPTY_KEYBOARD
    || edit.markup?.inline_keyboard?.length === 0));
});

test('a newer hub supersedes the previous keyboard', async () => {
  let counter = 0;
  const card = new TelegramMenuCard({
    logger: { warn() {} },
    registry: new ActionCardRegistry({ createNonce: () => `nonce-${++counter}` }),
  });
  const { bot, cards, edits } = botFixture();
  const present = () => card.present({
    bot, target: { chatId: 42 }, conversationKey: 'direct:chat-a', snapshot: {},
  });
  await present();
  const staleData = cards[0].markup.inline_keyboard[0][0].callback_data;
  await present();
  assert.ok(edits.length >= 1, 'the old keyboard is retired');
  let ran = 0;
  await card.handlePress(callbackFor(staleData), {
    bot,
    answer: () => {},
    conversationKey: 'direct:chat-a',
    run: async () => { ran += 1; return null; },
  });
  assert.equal(ran, 0);
});

test('menu labels follow the host language', (t) => {
  const previous = setImHostLanguage('en');
  t.after(() => setImHostLanguage(previous));
  const text = menuCardText({ sessionId: SESSION_ID });
  assert.match(text, /DeepSeek Harness console/u);
  const card = renderMenuCard('abcd1234EFGH');
  assert.equal(card.markup.inline_keyboard[0][0].text, '💬 Sessions');
  assert.equal(card.markup.inline_keyboard[1][2].text, '❓ Help');
});
