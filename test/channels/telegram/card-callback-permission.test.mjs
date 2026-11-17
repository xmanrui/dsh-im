import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAccessPolicy,
  createAccessPolicyScope,
} from '../../../src/channels/shared/access-policy.mjs';
import { COMMAND_PERMISSION_DENIED_MESSAGE } from '../../../src/channels/shared/inbound-access.mjs';
import { TextHarnessBridge } from '../../../src/channels/shared/text-harness-bridge.mjs';
import { TELEGRAM_INTERACTION_CARD } from '../../../src/channels/telegram/telegram-bridge.mjs';
import { TelegramClearCard } from '../../../src/channels/telegram/clear-card.mjs';
import {
  TelegramDisplayCard,
  parseTelegramDisplayCardCallback,
} from '../../../src/channels/telegram/display-card.mjs';

const QUIET_LOGGER = { warn() {}, error() {} };
const GROUP_KEY = 'group:g1';
const SESSION_ID = 'session-abcdef1234567890';
const WORKSPACE = '/home/wings/project';

/**
 * A group policy that denies commands by default and grants them only to the
 * members this test authorizes. This is the exact shape the review describes:
 * `defaultCanExecuteCommands: false` plus a per-member allow.
 */
function groupPolicy({ allowedUsers = ['actor-a'] } = {}) {
  return createAccessPolicy({
    direct: createAccessPolicyScope({
      mode: 'open',
      open: { defaultCanExecuteCommands: true, commandPermissionOverrides: [] },
      allowlist: { users: [] },
    }),
    group: createAccessPolicyScope({
      mode: 'open',
      open: {
        defaultCanExecuteCommands: false,
        commandPermissionOverrides: allowedUsers.map((id) => ({
          id,
          canExecuteCommands: true,
        })),
      },
      allowlist: { users: [] },
    }),
  });
}

function stateFixture() {
  const sessions = new Map([[GROUP_KEY, SESSION_ID]]);
  const seen = new Set();
  return {
    sessionFor: (key) => sessions.get(key) ?? null,
    async setSession(key, value) { sessions.set(key, value); },
    async clearSession(key) { sessions.delete(key); },
    hasSeen: (id) => seen.has(id),
    async markSeen(id) { seen.add(id); },
    async unmarkSeen(id) { return seen.delete(id); },
  };
}

/** A bot that records cards, in-place edits, toasts and plain texts. */
function botFixture() {
  const cards = [];
  const edits = [];
  const notices = [];
  const texts = [];
  const bot = {
    async sendText(_target, text) { texts.push(text); },
    async answerInteractionCallback(queryId, text) { notices.push({ queryId, text }); },
    async sendInteractionCard(_target, { text, markup } = {}) {
      cards.push({ text, markup });
      return { providerMessageIds: [String(900 + cards.length)] };
    },
    async editInteractionCard(_target, messageId, { text, markup } = {}) {
      edits.push({ messageId, text, markup });
      return { messageId, text, markup };
    },
  };
  return { bot, cards, edits, notices, texts };
}

/** A harness whose /clear either runs or is never reached. */
function harnessFixture() {
  const clears = [];
  return {
    clears,
    async ensureRunning() {},
    currentWorkspace: () => WORKSPACE,
    currentConversationWorkspace: () => WORKSPACE,
    workspaceSession: (sessionId, key) => ({
      async executeCommand(text) {
        clears.push({ sessionId, key, text });
        return { result: { kind: 'success' } };
      },
    }),
  };
}

function bridgeFor({
  bot,
  harness,
  state = stateFixture(),
  policy = groupPolicy(),
  display = null,
  applied = [],
} = {}) {
  return new TextHarnessBridge({
    descriptor: { key: 'telegram', label: 'Telegram' },
    bot,
    harness,
    state,
    accessPolicy: { getSettings: () => policy },
    interactionCard: TELEGRAM_INTERACTION_CARD,
    clearCard: new TelegramClearCard({ logger: QUIET_LOGGER }),
    // Card-less channels keep the old behaviour; every test here injects what it needs.
    ...(display
      ? {
        displayCard: new TelegramDisplayCard({ logger: QUIET_LOGGER }),
        presentationLevel: 'standard',
        onPresentationLevelChange: async (level) => { applied.push(level); },
      }
      : {}),
    logger: QUIET_LOGGER,
  });
}

function groupMessage(content, messageId = `m-${content}`) {
  return {
    messageId,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'group',
    conversationId: 'g1',
    content,
    addressed: true,
    replyTarget: { chatId: -100, replyToMessageId: 7 },
  };
}

function callbackFor(data, overrides = {}) {
  return {
    callbackQueryId: 'cb-1',
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'group',
    conversationId: 'g1',
    messageId: 'update-1',
    data,
    replyTarget: { chatId: -100 },
    ...overrides,
  };
}

test('an unauthorized member cannot run an authorized member\'s /clear card', async () => {
  const harness = harnessFixture();
  const { bot, cards, notices } = botFixture();
  const bridge = bridgeFor({ bot, harness });
  await bridge.accept(groupMessage('/clear'));
  assert.equal(cards.length, 1, 'the authorized member gets the confirmation card');
  const confirm = cards[0].markup.inline_keyboard[0][0].callback_data;

  await bridge.acceptCallback(callbackFor(confirm, { senderId: 'actor-b' }));

  assert.deepEqual(harness.clears, [], 'a denied press must never clear the session');
  assert.equal(notices.length, 1, 'the press is answered exactly once');
  assert.equal(notices[0].text, COMMAND_PERMISSION_DENIED_MESSAGE);
});

test('the authorized member\'s /clear card press still runs the command', async () => {
  const harness = harnessFixture();
  const { bot, cards, notices } = botFixture();
  const bridge = bridgeFor({ bot, harness });
  await bridge.accept(groupMessage('/clear'));
  const confirm = cards[0].markup.inline_keyboard[0][0].callback_data;

  await bridge.acceptCallback(callbackFor(confirm));

  assert.equal(harness.clears.length, 1, 'the allowed press runs /clear once');
  assert.equal(harness.clears[0].text, '/clear');
  assert.equal(harness.clears[0].sessionId, SESSION_ID);
  assert.match(notices.at(-1)?.text ?? '', /已清空/u);
});

test('an unauthorized member cannot change the bot-wide display level from a card', async () => {
  const applied = [];
  const harness = harnessFixture();
  const { bot, cards, notices } = botFixture();
  const bridge = bridgeFor({ bot, harness, display: true, applied });
  await bridge.accept(groupMessage('/display'));
  assert.equal(cards.length, 1, 'the authorized member gets the picker');
  const full = cards[0].markup.inline_keyboard.flat()
    .find((button) => parseTelegramDisplayCardCallback(button.callback_data)?.level === 'full')
    .callback_data;

  await bridge.acceptCallback(callbackFor(full, { senderId: 'actor-b' }));

  assert.deepEqual(applied, [], 'a denied press must not persist any level');
  assert.equal(bridge.presentationLevel, 'standard', 'the live level is unchanged');
  assert.equal(notices.length, 1, 'the press is answered exactly once');
  assert.equal(notices[0].text, COMMAND_PERMISSION_DENIED_MESSAGE);
});

test('the authorized member\'s /display card press still changes the level', async () => {
  const applied = [];
  const harness = harnessFixture();
  const { bot, cards } = botFixture();
  const bridge = bridgeFor({ bot, harness, display: true, applied });
  await bridge.accept(groupMessage('/display'));
  const full = cards[0].markup.inline_keyboard.flat()
    .find((button) => parseTelegramDisplayCardCallback(button.callback_data)?.level === 'full')
    .callback_data;

  await bridge.acceptCallback(callbackFor(full));

  assert.deepEqual(applied, ['full']);
  assert.equal(bridge.presentationLevel, 'full');
});

test('a question-card press is not judged by the command-permission policy', async () => {
  const harness = harnessFixture();
  const { bot, notices } = botFixture();
  const bridge = bridgeFor({ bot, harness });
  // `q|` is the question card's namespace: the same denied sender above must
  // reach the actor/pending check instead of a command-permission refusal.
  await bridge.acceptCallback(callbackFor('q|abcd1234EFGH|0|0', { senderId: 'actor-b' }));
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /该问题已处理，无需再次选择/u);
});
