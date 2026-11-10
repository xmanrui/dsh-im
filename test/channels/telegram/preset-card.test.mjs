import assert from 'node:assert/strict';
import test from 'node:test';

import { ActionCardRegistry, ACTION_CARD_STATUS } from '../../../src/channels/shared/action-card.mjs';
import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import { runPresetCommand } from '../../../src/channels/shared/preset-command.mjs';
import { TextHarnessBridge } from '../../../src/channels/shared/text-harness-bridge.mjs';
import {
  TELEGRAM_PRESET_CARD_CALLBACK,
  TELEGRAM_PRESET_CARD_MAX_ITEMS,
  TelegramPresetCard,
  parseTelegramPresetCardCallback,
  presetCardView,
  renderPresetCard,
} from '../../../src/channels/telegram/preset-card.mjs';

const CATALOG = Object.freeze({
  agentPreset: 'marketing-jeep',
  defaultId: 'default-one',
  items: Object.freeze([
    { id: 'default-one', label: '默认预设' },
    { id: 'marketing-jeep', label: '营销预设' },
    { id: 'ops', label: '运维预设' },
  ]),
});

const EMPTY_KEYBOARD = { inline_keyboard: [] };

function stateFixture() {
  const sessions = new Map();
  const seen = new Set();
  return {
    sessionFor: (key) => sessions.get(key) ?? null,
    async setSession(key, value) { sessions.set(key, value); },
    async clearSession(key) { sessions.delete(key); },
    hasSeen: (id) => seen.has(id),
    async markSeen(id) { seen.add(id); },
    async unmarkSeen(id) { return seen.delete(id); },
    commandListSnapshot: () => null,
    saveCommandListSnapshot: () => {},
  };
}

/** A bot that records cards, edits and texts. */
function botFixture({ cardResult = 'ok', editResult = 'ok' } = {}) {
  const sent = [];
  const cards = [];
  const edits = [];
  const bot = {
    async sendText(_target, text) { sent.push(text); },
    async sendInteractionCard(_target, { text, markup } = {}) {
      if (cardResult === 'fail') throw new Error('telegram refused the keyboard');
      cards.push({ text, markup });
      return { providerMessageIds: [String(500 + cards.length)] };
    },
    async editInteractionCard(_target, messageId, { text, markup } = {}) {
      if (editResult === 'fail') throw new Error('telegram refused the edit');
      edits.push({ messageId, text, markup });
      return { messageId, text, markup };
    },
    async answerInteractionCallback() {},
  };
  return { bot, sent, cards, edits };
}

function harnessFixture({
  catalog = CATALOG,
  updateError = null,
} = {}) {
  const calls = [];
  return {
    calls,
    async agentPresetSettings(options = {}) {
      calls.push(['agentPresetSettings', options]);
      return {
        agentPreset: catalog.agentPreset,
        agentPresetCatalog: { defaultId: catalog.defaultId, items: catalog.items },
      };
    },
    async updateAgentPreset(value, options = {}) {
      calls.push(['updateAgentPreset', value, options]);
      if (updateError) throw updateError;
      return {
        agentPreset: value === '--default' ? null : value,
        agentPresetCatalog: { defaultId: catalog.defaultId, items: catalog.items },
      };
    },
  };
}

function bridgeFor({ bot, harness = harnessFixture(), state = stateFixture(), presetCard }) {
  return new TextHarnessBridge({
    descriptor: { key: 'telegram', label: 'Telegram' },
    bot,
    harness,
    state,
    // Default: a real picker (same as the Telegram bridge). `null` keeps the
    // plain text path for the no-keyboard regression case.
    presetCard: presetCard === undefined
      ? new TelegramPresetCard({ logger: { warn() {} } })
      : presetCard,
    logger: { warn() {}, error() {} },
  });
}

function presetListMessage(messageId = 'm-1') {
  return {
    messageId,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    content: '/presetlist',
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
    providerMessageId: '501',
    data,
    replyTarget: { chatId: 42 },
    ...overrides,
  };
}

test('the preset card view marks the current row and the follow-default choice', () => {
  const view = presetCardView(CATALOG);
  assert.equal(view.kind, 'preset');
  assert.equal(view.items.length, 3);
  assert.deepEqual(view.items.map((item) => item.index), [1, 2, 3]);
  assert.equal(view.currentId, 'marketing-jeep');
  // The ✓ marks the bot's current preset, not the host default.
  assert.deepEqual(view.items.map((item) => item.current), [false, true, false]);
  assert.match(view.text, /共 3 个/u);
  assert.match(view.text, /营销预设（marketing-jeep）/u);

  const following = presetCardView({ ...CATALOG, agentPreset: null });
  assert.equal(following.currentId, null);
  assert.match(following.text, /跟随 Host 默认/u);
  // With no explicit choice the host default is what actually runs.
  assert.equal(following.items.find((item) => item.id === 'default-one').current, true);
});

test('an unrenderable catalog keeps the text path instead of a broken keyboard', () => {
  assert.equal(presetCardView(null), null);
  assert.equal(presetCardView({ items: [] }), null);
  assert.equal(presetCardView({ items: [{ id: '', label: 'x' }] }), null);
  assert.equal(presetCardView({ items: [{ id: 'a\u0000b', label: 'x' }] }), null);
  const tooMany = {
    items: Array.from({ length: TELEGRAM_PRESET_CARD_MAX_ITEMS + 1 }, (_, index) => ({
      id: `id-${index}`,
      label: `预设 ${index}`,
    })),
  };
  assert.equal(presetCardView(tooMany), null);
});

test('every button is attributable to this presentation and fits the callback budget', () => {
  const view = presetCardView(CATALOG);
  const card = renderPresetCard(view, 'abcd1234EFGH');
  const rows = card.markup.inline_keyboard;
  assert.equal(rows.length, 4, 'three presets plus the follow-default row');
  // Labels are `disabled` (Bot API 10.3) and carry no callback at all.
  const pressable = rows.flat().filter((button) => typeof button.callback_data === 'string');
  const payloads = pressable.map((button) => button.callback_data);
  for (const payload of payloads) {
    assert.ok(Buffer.byteLength(payload, 'utf8') <= 64, payload);
    assert.match(payload, /^p1\|abcd1234EFGH\|/u);
  }
  // The current row is a real label: no callback, so a press cannot claim it.
  const currentRow = rows.flat().find((button) => button.text.startsWith('✓ '));
  assert.deepEqual(currentRow, { text: '✓ 2. 营销预设', disabled: {} });
  assert.deepEqual(parseTelegramPresetCardCallback(payloads[0]), {
    kind: 'preset',
    nonce: 'abcd1234EFGH',
    action: 'i1',
  });
  assert.equal(parseTelegramPresetCardCallback('m2|abcd1234EFGH|1'), null);
  assert.equal(parseTelegramPresetCardCallback('nonsense'), null);
});

test('/presetlist sends a picker card instead of the text wall', async () => {
  const { bot, cards, sent } = botFixture();
  const bridge = bridgeFor({ bot });
  await bridge.accept(presetListMessage());
  assert.equal(cards.length, 1, 'one picker card');
  assert.equal(sent.length, 0, 'the text listing is replaced by the card');
  assert.match(cards[0].text, /选择要使用的 Agent Preset/u);
  assert.equal(cards[0].markup.inline_keyboard.length, 4);
});

test('a press applies the preset through the typed command and repaints in place', async () => {
  const harness = harnessFixture();
  const { bot, cards, edits, sent } = botFixture();
  const bridge = bridgeFor({ bot, harness });
  await bridge.accept(presetListMessage());
  const row = cards[0].markup.inline_keyboard[2][0]; // 3. 运维预设
  await bridge.acceptCallback(callbackFor(row.callback_data, { providerMessageId: '501' }));

  const update = harness.calls.find((call) => call[0] === 'updateAgentPreset');
  assert.equal(update[1], 'ops', 'the press runs /preset <id>');
  assert.equal(edits.length, 1, 'the card is repainted in place');
  assert.equal(String(edits[0].messageId), '501');
  assert.match(edits[0].text, /当前选择：运维预设（ops）/u);
  assert.equal(sent.length, 0, 'no extra text when the card repaint lands');
});

test('the follow-default row applies /preset --default', async () => {
  const harness = harnessFixture();
  const { bot, cards, edits } = botFixture();
  const bridge = bridgeFor({ bot, harness });
  await bridge.accept(presetListMessage());
  const followRow = cards[0].markup.inline_keyboard.at(-1)[0];
  await bridge.acceptCallback(callbackFor(followRow.callback_data));
  const update = harness.calls.find((call) => call[0] === 'updateAgentPreset');
  // The command translates the flag: /preset --default means "follow the host".
  assert.equal(update[1], null);
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /跟随 Host 默认/u);
});

test('a numeric preset ID is addressed with id: so it cannot be read as an index', async () => {
  const catalog = {
    agentPreset: null,
    defaultId: '',
    items: [{ id: '12345', label: '数字预设' }],
  };
  const harness = harnessFixture({ catalog });
  const { bot, cards } = botFixture();
  const bridge = bridgeFor({ bot, harness });
  await bridge.accept(presetListMessage());
  await bridge.acceptCallback(callbackFor(cards[0].markup.inline_keyboard[0][0].callback_data));
  const update = harness.calls.find((call) => call[0] === 'updateAgentPreset');
  assert.equal(update[1], '12345', 'the ID reaches the command unchanged');
});

test('a double press applies the preset once', async () => {
  const harness = harnessFixture();
  const { bot, cards } = botFixture();
  const bridge = bridgeFor({ bot, harness });
  await bridge.accept(presetListMessage());
  const data = cards[0].markup.inline_keyboard[2][0].callback_data;
  await Promise.all([
    bridge.acceptCallback(callbackFor(data, { callbackQueryId: 'cb-1' })),
    bridge.acceptCallback(callbackFor(data, { callbackQueryId: 'cb-2', messageId: 'update-2' })),
  ]);
  assert.equal(
    harness.calls.filter((call) => call[0] === 'updateAgentPreset').length,
    1,
    'the shared preset is only switched once',
  );
});

test('a refused card send keeps the exact text listing', async () => {
  const { bot, cards, sent } = botFixture({ cardResult: 'fail' });
  const bridge = bridgeFor({ bot });
  await bridge.accept(presetListMessage());
  assert.equal(cards.length, 0);
  assert.ok(sent.length >= 1, 'the text listing still arrives');
  assert.match(sent.join('\n'), /可用 Agent Preset/u);
});

test('a channel without keyboard support keeps the plain text listing', async () => {
  const { bot, cards, sent } = botFixture();
  const bridge = bridgeFor({ bot, presetCard: null });
  await bridge.accept(presetListMessage());
  assert.equal(cards.length, 0);
  assert.match(sent.join('\n'), /可用 Agent Preset/u);
});

test('a failed repaint still delivers the command text and drops the keyboard', async () => {
  const { bot, cards, edits, sent } = botFixture({ editResult: 'fail' });
  const bridge = bridgeFor({ bot });
  await bridge.accept(presetListMessage());
  await bridge.acceptCallback(callbackFor(cards[0].markup.inline_keyboard[2][0].callback_data));
  // The repaint is refused, so the command's own text carries the outcome.
  assert.ok(sent.some((text) => /已设置为/u.test(text)), 'the outcome text is not lost');
});

test('the typed text path is unchanged when no card can be shown', async () => {
  const harness = harnessFixture();
  const state = stateFixture();
  const result = await runPresetCommand('/presetlist', harness, state, 'direct:chat-a', {});
  assert.equal(result.handled, true);
  assert.match(result.message, /可用 Agent Preset（3）：/u);
  // The card payload rides alongside, it never changes the text.
  assert.equal(result.presetCatalog.items.length, 3);
  assert.equal(result.presetCatalog.agentPreset, 'marketing-jeep');
});

test('an update result reports its selection without a second settings read', async () => {
  const harness = harnessFixture();
  const state = stateFixture();
  const listed = await runPresetCommand('/presetlist', harness, state, 'direct:chat-a', {});
  assert.ok(listed.presetCatalog);
  const updated = await runPresetCommand('/preset 3', harness, state, 'direct:chat-a', {});
  assert.equal(updated.handled, true);
  assert.deepEqual(updated.presetSelection, { agentPreset: 'ops' });
  assert.equal(
    harness.calls.filter((call) => call[0] === 'agentPresetSettings').length,
    1,
    'the update adds no extra settings read',
  );
});

test('an expired card is refused and its keyboard retired', async () => {
  let now = 1_000_000;
  const card = new TelegramPresetCard({
    logger: { warn() {} },
    registry: new ActionCardRegistry({ now: () => now, ttlMs: 50, createNonce: () => 'abcd1234EFGH' }),
  });
  const { bot, cards, edits } = botFixture();
  const presented = await card.present({
    bot,
    target: { chatId: 42 },
    conversationKey: 'direct:chat-a',
    presetCatalog: CATALOG,
  });
  assert.equal(presented, true);
  now += 100;
  await card.handlePress(
    // Row 3 (ops) is not the current preset, so this is a real action row.
    callbackFor(cards[0].markup.inline_keyboard[2][0].callback_data),
    { bot, answer: () => {}, conversationKey: 'direct:chat-a', apply: async () => null },
  );
  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0].markup, EMPTY_KEYBOARD);
});

test('a superseded card cannot switch the preset', async () => {
  let counter = 0;
  const card = new TelegramPresetCard({
    logger: { warn() {} },
    registry: new ActionCardRegistry({ createNonce: () => `nonce-${++counter}` }),
  });
  const { bot, cards } = botFixture();
  const present = () => card.present({
    bot,
    target: { chatId: 42 },
    conversationKey: 'direct:chat-a',
    presetCatalog: CATALOG,
  });
  await present();
  const staleData = cards[0].markup.inline_keyboard[2][0].callback_data;
  await present();
  let applied = 0;
  await card.handlePress(callbackFor(staleData), {
    bot,
    answer: () => {},
    conversationKey: 'direct:chat-a',
    apply: async () => { applied += 1; return null; },
  });
  assert.equal(applied, 0, 'the retired keyboard must not switch anything');
});

test('another chat cannot press this card', async () => {
  const card = new TelegramPresetCard({ logger: { warn() {} } });
  const { bot, cards } = botFixture();
  await card.present({
    bot,
    target: { chatId: 42 },
    conversationKey: 'direct:chat-a',
    presetCatalog: CATALOG,
  });
  let applied = 0;
  await card.handlePress(
    callbackFor(cards[0].markup.inline_keyboard[2][0].callback_data, { conversationId: 'chat-b' }),
    { bot, answer: () => {}, conversationKey: 'direct:chat-b', apply: async () => { applied += 1; return null; } },
  );
  assert.equal(applied, 0);
});

test('preset card labels follow the host language', (t) => {
  const previous = setImHostLanguage('en');
  t.after(() => setImHostLanguage(previous));
  const view = presetCardView(CATALOG);
  assert.match(view.text, /Choose an Agent Preset/u);
  assert.match(view.text, /Current choice: /u);
  const card = renderPresetCard(view, 'abcd1234EFGH');
  assert.equal(card.markup.inline_keyboard.at(-1)[0].text, 'Follow Host default');
  assert.equal(renderPresetCard(view, 'abcdefgh').markup.inline_keyboard.at(-1)[0].callback_data,
    TELEGRAM_PRESET_CARD_CALLBACK.encode({ nonce: 'abcdefgh', action: 'd' }));
});

test('a stale press whose catalog entry vanished is refused, not guessed', async () => {
  const card = new TelegramPresetCard({ logger: { warn() {} } });
  const { bot, cards } = botFixture();
  await card.present({
    bot,
    target: { chatId: 42 },
    conversationKey: 'direct:chat-a',
    presetCatalog: CATALOG,
  });
  // An index no catalog entry carries (forged or from a longer earlier list).
  const forged = TELEGRAM_PRESET_CARD_CALLBACK.encode({ nonce: 'forged', action: 'i9' });
  let applied = 0;
  await card.handlePress(callbackFor(forged), {
    bot,
    answer: () => {},
    conversationKey: 'direct:chat-a',
    apply: async () => { applied += 1; return null; },
  });
  assert.equal(applied, 0);
  assert.equal(cards.length, 1);
});
