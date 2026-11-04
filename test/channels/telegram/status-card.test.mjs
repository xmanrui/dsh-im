import assert from 'node:assert/strict';
import test from 'node:test';

import { ActionCardRegistry, ACTION_CARD_STATUS } from '../../../src/channels/shared/action-card.mjs';
import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import { TextHarnessBridge } from '../../../src/channels/shared/text-harness-bridge.mjs';
import {
  TELEGRAM_STATUS_ACTIONS,
  TELEGRAM_STATUS_CARD_CALLBACK,
  TelegramStatusCard,
  parseTelegramStatusCardCallback,
  renderStatusCard,
  statusActionCommand,
  statusCardText,
} from '../../../src/channels/telegram/status-card.mjs';

const EMPTY_KEYBOARD = { inline_keyboard: [] };
const SESSION_ID = 'session-0ba8335d-787f-4c73-80af-a2e033ce0ccb';
const WORKSPACE = '/home/wings/dsh-lab/im';

const SNAPSHOT = Object.freeze({
  label: 'Telegram',
  workspace: WORKSPACE,
  sessionId: SESSION_ID,
  model: 'bifrost-chat/commandcode-chat/glim-5.3',
  preset: '跟随 Host 默认',
  running: false,
});

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
      return { providerMessageIds: [String(600 + cards.length)] };
    };
    bot.editInteractionCard = async (_target, messageId, { text, markup } = {}) => {
      if (editResult === 'fail') throw new Error('telegram refused the edit');
      edits.push({ messageId, text, markup });
      return { messageId, text, markup };
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
    async listWorkspaceSessions(workspace) {
      return { workspace, sessions: [] };
    },
    async agentPresetSettings() {
      return {
        agentPreset: null,
        agentPresetCatalog: { defaultId: '', items: [] },
      };
    },
    workspaceSession: () => ({
      async sessionExists() { return true; },
      async models() {
        return {
          groups: [], failures: [],
          current: { provider: 'bifrost-chat', model: 'commandcode-chat/glim-5.3' },
        };
      },
      async isRunning() { return false; },
    }),
  };
}

function bridgeFor({ bot, harness = harnessFixture(), state, statusCard } = {}) {
  return new TextHarnessBridge({
    descriptor: { key: 'telegram', label: 'Telegram' },
    bot,
    harness,
    state: state ?? {
      hasSeen: () => false,
      async markSeen() {},
      sessionFor: () => SESSION_ID,
    },
    statusCard: statusCard === undefined
      ? new TelegramStatusCard({ logger: { warn() {} } })
      : statusCard,
    logger: { warn() {}, error() {} },
  });
}

function statusMessage() {
  return {
    messageId: 'm-status',
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    content: '/status',
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

test('the card body keeps every line the text status prints', () => {
  const text = statusCardText(SNAPSHOT);
  assert.match(text, /Telegram机器人与 DeepSeek Harness 连接正常/u);
  // The workspace is shortened to its last segment so a long path cannot blow
  // the card layout apart.
  assert.match(text, /工作区：im/u);
  assert.doesNotMatch(text, new RegExp(WORKSPACE.replaceAll('/', '\\/'), 'u'));
  assert.match(text, new RegExp(SESSION_ID, 'u'));
  assert.match(text, /bifrost-chat\/commandcode-chat\/glim-5\.3/u);
  assert.match(text, /Agent Preset（预设）：跟随 Host 默认/u);
  assert.doesNotMatch(text, /运行中任务/u);
});

test('an unbound chat still gets an explanatory body', () => {
  const text = statusCardText({ label: 'Telegram', workspace: null, sessionId: null, model: null });
  assert.match(text, /会话：未绑定/u);
  assert.match(text, /当前模型：暂无/u);
});

test('a running task is called out with how to stop it', () => {
  const text = statusCardText({ ...SNAPSHOT, running: true });
  assert.match(text, /运行中任务：有（发送\/stop 可停止）|运行中任务：有（发送 \/stop 可停止）/u);
});

test('every button is attributable and fits the callback budget', () => {
  const card = renderStatusCard(SNAPSHOT, 'abcd1234EFGH');
  const buttons = card.markup.inline_keyboard.flat();
  assert.equal(card.markup.inline_keyboard[0][0].text, '🔄 刷新');
  for (const button of buttons) {
    assert.ok(Buffer.byteLength(button.callback_data, 'utf8') <= 64, button.callback_data);
    assert.match(button.callback_data, /^t1\|abcd1234EFGH\|/u);
    assert.ok(parseTelegramStatusCardCallback(button.callback_data), button.callback_data);
    assert.doesNotMatch(button.callback_data, /\/|session-|chat-a/u,
      'paths, session ids and chat ids never ride in a callback');
  }
  assert.equal(parseTelegramStatusCardCallback('m3|abcd1234EFGH|s'), null);
  assert.equal(parseTelegramStatusCardCallback('garbage'), null);
});

test('the preset entry only appears when the Host reports a preset', () => {
  const withPreset = renderStatusCard(SNAPSHOT, 'abcd');
  const labels = withPreset.markup.inline_keyboard.flat().map((button) => button.text);
  assert.ok(labels.includes('🧩 预设'));
  const withoutPreset = renderStatusCard({ ...SNAPSHOT, preset: null }, 'abcd');
  const labels2 = withoutPreset.markup.inline_keyboard.flat().map((button) => button.text);
  assert.ok(!labels2.includes('🧩 预设'), 'no preset means no preset button');
});

test('every entry maps to a command that already exists', () => {
  assert.equal(statusActionCommand(TELEGRAM_STATUS_ACTIONS.sessions), '/sessionlist');
  assert.equal(statusActionCommand(TELEGRAM_STATUS_ACTIONS.workspace), '/ws');
  assert.equal(statusActionCommand(TELEGRAM_STATUS_ACTIONS.models), '/models');
  assert.equal(statusActionCommand(TELEGRAM_STATUS_ACTIONS.presets), '/presetlist');
  assert.equal(statusActionCommand(TELEGRAM_STATUS_ACTIONS.menu), '/menu');
  assert.equal(statusActionCommand(TELEGRAM_STATUS_ACTIONS.help), '/help');
  // refresh is handled by the card itself, not by replaying a command.
  assert.equal(statusActionCommand(TELEGRAM_STATUS_ACTIONS.refresh), null);
});

test('/status sends the actionable card instead of plain text', async () => {
  const { bot, cards, sent } = botFixture();
  const bridge = bridgeFor({ bot });
  await bridge.accept(statusMessage());
  assert.equal(cards.length, 1);
  assert.match(cards[0].text, /连接正常/u);
  assert.deepEqual(sent, [], 'the text status is replaced by the card');
});

test('refresh re-reads the snapshot and repaints the same message', async () => {
  const harness = harnessFixture();
  const { bot, cards, edits } = botFixture();
  const bridge = bridgeFor({ bot, harness });
  await bridge.accept(statusMessage());
  const refresh = cards[0].markup.inline_keyboard[0][0];
  assert.equal(refresh.text, '🔄 刷新');
  await bridge.acceptCallback(callbackFor(refresh.callback_data));
  assert.equal(edits.length, 1, 'the same message is repainted');
  assert.equal(String(edits[0].messageId), '601');
  assert.match(edits[0].text, /连接正常/u);
});

test('a failed refresh leaves the refresh button usable', async () => {
  // The card is sent from a healthy read, then the Host goes away: the refresh
  // must report the failure and keep the button pressable, not leave a card that
  // silently stopped working.
  let hostDown = false;
  const harness = {
    async ensureRunning() {
      if (hostDown) throw new Error('host down');
    },
    currentWorkspace: () => WORKSPACE,
    currentConversationWorkspace: () => WORKSPACE,
    async agentPresetSettings() {
      return { agentPreset: null, agentPresetCatalog: { defaultId: '', items: [] } };
    },
    workspaceSession: () => ({
      async sessionExists() { return true; },
      async models() { return { groups: [], failures: [], current: null }; },
      async isRunning() { return false; },
    }),
  };
  const { bot, cards, edits, notices } = botFixture();
  const bridge = bridgeFor({ bot, harness });
  await bridge.accept(statusMessage());
  assert.equal(cards.length, 1, 'the card was delivered from a healthy read');
  hostDown = true;
  const refresh = cards[0].markup.inline_keyboard[0][0];
  await bridge.acceptCallback(callbackFor(refresh.callback_data));
  assert.equal(edits.length, 0, 'nothing is repainted on a failed read');
  assert.ok(notices.some(({ text }) => /刷新失败/u.test(text ?? '')));
});

test('a picker entry replays its command and leaves the status card alone', async () => {
  const { bot, cards, edits, sent } = botFixture();
  const bridge = bridgeFor({ bot });
  await bridge.accept(statusMessage());
  const labels = cards[0].markup.inline_keyboard.flat();
  const help = labels.find((button) => button.text === '❓ 帮助');
  await bridge.acceptCallback(callbackFor(help.callback_data));
  assert.equal(edits.length, 0, 'the status card is not repainted by a picker');
  assert.ok(sent.length >= 1, 'the picker output is delivered');
});

test('a channel without keyboards gets the exact text status', async () => {
  const { bot, cards, sent } = botFixture({ supportsCards: false });
  const bridge = bridgeFor({ bot });
  await bridge.accept(statusMessage());
  assert.equal(cards.length, 0);
  assert.match(sent.join('\n'), /连接正常/u);
});

test('statusCard: null keeps the pre-card text status', async () => {
  const { bot, cards, sent } = botFixture();
  const bridge = bridgeFor({ bot, statusCard: null });
  await bridge.accept(statusMessage());
  assert.equal(cards.length, 0);
  assert.match(sent.join('\n'), /连接正常/u);
});

test('a refused card send falls back to the text status', async () => {
  const { bot, cards, sent } = botFixture({ cardResult: 'fail' });
  const bridge = bridgeFor({ bot });
  await bridge.accept(statusMessage());
  assert.equal(cards.length, 0);
  assert.match(sent.join('\n'), /连接正常/u);
});

test('an expired status card is refused', async () => {
  let now = 1_000_000;
  const card = new TelegramStatusCard({
    logger: { warn() {} },
    registry: new ActionCardRegistry({ now: () => now, ttlMs: 50, createNonce: () => 'abcd1234EFGH' }),
  });
  const { bot, cards, edits } = botFixture();
  await card.present({
    bot, target: { chatId: 42 }, conversationKey: 'direct:chat-a', snapshot: SNAPSHOT,
  });
  now += 100;
  await card.handlePress(callbackFor(cards[0].markup.inline_keyboard[0][0].callback_data), {
    bot, answer: () => {}, conversationKey: 'direct:chat-a',
    refresh: async () => SNAPSHOT, run: async () => null,
  });
  // The only allowed edit is the keyboard removal that retires the dead card.
  assert.ok(edits.every((edit) => edit.text === undefined), 'an expired card is not repainted');
});

test('a press from another chat cannot drive this card', async () => {
  const card = new TelegramStatusCard({ logger: { warn() {} } });
  const { bot, cards, edits } = botFixture();
  await card.present({
    bot, target: { chatId: 42 }, conversationKey: 'direct:chat-a', snapshot: SNAPSHOT,
  });
  let refreshed = 0;
  await card.handlePress(
    callbackFor(cards[0].markup.inline_keyboard[0][0].callback_data, { conversationId: 'chat-b' }),
    {
      bot, answer: () => {}, conversationKey: 'direct:chat-b',
      refresh: async () => { refreshed += 1; return SNAPSHOT; },
      run: async () => null,
    },
  );
  assert.equal(refreshed, 0);
  assert.equal(edits.length, 0);
});

test('a newer status card supersedes the previous keyboard', async () => {
  let counter = 0;
  const card = new TelegramStatusCard({
    logger: { warn() {} },
    registry: new ActionCardRegistry({ createNonce: () => `nonce-${++counter}` }),
  });
  const { bot, cards, edits } = botFixture();
  const present = () => card.present({
    bot, target: { chatId: 42 }, conversationKey: 'direct:chat-a', snapshot: SNAPSHOT,
  });
  await present();
  const staleData = cards[0].markup.inline_keyboard[0][0].callback_data;
  await present();
  assert.ok(edits.length >= 1, 'the old keyboard is retired');
  let refreshed = 0;
  await card.handlePress(callbackFor(staleData), {
    bot, answer: () => {}, conversationKey: 'direct:chat-a',
    refresh: async () => { refreshed += 1; return SNAPSHOT; },
    run: async () => null,
  });
  assert.equal(refreshed, 0);
});

test('status card labels follow the host language', (t) => {
  const previous = setImHostLanguage('en');
  t.after(() => setImHostLanguage(previous));
  const card = renderStatusCard(SNAPSHOT, 'abcd1234EFGH');
  assert.equal(card.markup.inline_keyboard[0][0].text, '🔄 Refresh');
  assert.match(card.text, /connected to DeepSeek Harness and working normally/u);
});

test('a double refresh reads the snapshot once per claimed press', async () => {
  const card = new TelegramStatusCard({ logger: { warn() {} } });
  const { bot, cards, edits } = botFixture();
  await card.present({
    bot, target: { chatId: 42 }, conversationKey: 'direct:chat-a', snapshot: SNAPSHOT,
  });
  const data = cards[0].markup.inline_keyboard[0][0].callback_data;
  let reads = 0;
  await Promise.all([
    card.handlePress(callbackFor(data, { callbackQueryId: 'cb-1' }), {
      bot, answer: () => {}, conversationKey: 'direct:chat-a',
      refresh: async () => { reads += 1; return SNAPSHOT; }, run: async () => null,
    }),
    card.handlePress(callbackFor(data, { callbackQueryId: 'cb-2' }), {
      bot, answer: () => {}, conversationKey: 'direct:chat-a',
      refresh: async () => { reads += 1; return SNAPSHOT; }, run: async () => null,
    }),
  ]);
  assert.equal(reads, 1, 'a concurrent second press does not refresh again');
});
