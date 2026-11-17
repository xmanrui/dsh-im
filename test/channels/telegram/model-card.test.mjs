import assert from 'node:assert/strict';
import test from 'node:test';

import { ActionCardRegistry } from '../../../src/channels/shared/action-card.mjs';
import {
  createAccessPolicy,
  createAccessPolicyScope,
} from '../../../src/channels/shared/access-policy.mjs';
import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import { TelegramHarnessBridge } from '../../../src/channels/telegram/telegram-bridge.mjs';
import {
  TELEGRAM_MODEL_CARD_MAX_ITEMS,
  TELEGRAM_MODEL_CARD_PAGE_SIZE,
  TelegramModelCard,
  parseTelegramModelCardCallback,
} from '../../../src/channels/telegram/model-card.mjs';

/* ---------------------------------------------------------------------------
 * Fixtures
 *
 * The catalog mirrors what the Harness returns from `listModels` / `models`:
 * provider groups, models, optional reasoning metadata and a current selection
 * on the session read.
 * ------------------------------------------------------------------------- */

function effort(id, name) {
  return { id, name };
}

function model(id, name, reasoning) {
  return { id, name, ...(reasoning ? { reasoning } : {}) };
}

const CATALOG = Object.freeze({
  groups: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        model('flash', 'Flash', {
          efforts: [effort('off', 'Off'), effort('high', 'High')],
          defaultEffort: 'high',
        }),
        model('pro', 'Pro', {
          efforts: [effort('medium', 'Medium'), effort('xhigh', 'XHigh')],
          defaultEffort: 'medium',
        }),
      ],
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      models: [model('anthropic/claude', 'Claude')],
    },
  ],
  failures: [],
});

const DEFAULT_CURRENT = Object.freeze({
  provider: 'deepseek',
  model: 'flash',
  reasoningEffort: 'high',
});

/** One provider with `count` plain (reasoning-less) models: `m1`..`mN`. */
function flatCatalog(count) {
  return {
    groups: [{
      id: 'deepseek',
      name: 'DeepSeek',
      models: Array.from({ length: count }, (_, index) => model(
        `m${index + 1}`,
        `Model ${index + 1}`,
      )),
    }],
    failures: [],
  };
}

function bridgeFixture({
  catalog = CATALOG,
  sessionId = 'session-one',
  current = DEFAULT_CURRENT,
  cardResult = 'ok',
  editResult = 'ok',
  accessPolicy,
  modelCard,
  selectModelHook,
} = {}) {
  const seen = new Set();
  const sessions = new Map();
  if (sessionId !== null) sessions.set('direct:chat-a', sessionId);
  const sent = [];
  const cards = [];
  const notices = [];
  const updates = [];
  const edits = [];
  const selectModelCalls = [];
  const calls = { listModels: 0, createSession: 0 };
  let selected = { ...current };

  const defaultEffortFor = (selection) => catalog.groups
    .find(({ id }) => id === selection.provider)
    ?.models.find(({ id }) => id === selection.model)
    ?.reasoning?.defaultEffort;

  const session = {
    async sessionExists() { return true; },
    async models() { return { ...catalog, current: selected, routable: true }; },
    async isRunning() { return false; },
    async hasActiveTurn() { return false; },
    async selectModel(selection) {
      selectModelCalls.push(selection);
      if (selectModelHook) await selectModelHook(selection);
      const reasoningEffort = selection.reasoningEffort ?? defaultEffortFor(selection);
      selected = {
        provider: selection.provider,
        model: selection.model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      };
      return { selected };
    },
  };

  const harness = {
    async listModels() { calls.listModels += 1; return catalog; },
    workspaceSession() { return session; },
    async createSession() { calls.createSession += 1; return 'session-created'; },
  };

  const bot = {
    async sendText(_target, text) { sent.push(text); },
    async sendInteractionCard(_target, { text, markup }) {
      if (cardResult === 'fail') throw new Error('telegram refused the keyboard');
      const messageId = String(700 + cards.length + 1);
      cards.push({ text, markup, messageId });
      return { providerMessageIds: [messageId] };
    },
    async updateInteractionCard(_target, messageId, { markup }) {
      updates.push({ messageId: String(messageId), markup });
    },
    async editInteractionCard(_target, messageId, { text, markup }) {
      if (editResult === 'fail') throw new Error('telegram refused the edit');
      edits.push({ messageId: String(messageId), text, markup });
      return {};
    },
    async answerInteractionCallback(_queryId, text) { notices.push({ text }); },
  };

  const state = {
    sessionFor: (key) => sessions.get(key) ?? null,
    async setSession(key, value) { sessions.set(key, value); return true; },
    async clearSession(key) { sessions.delete(key); },
    hasSeen: (id) => seen.has(id),
    async markSeen(id) { seen.add(id); },
    async unmarkSeen(id) { seen.delete(id); },
  };

  const bridge = new TelegramHarnessBridge({
    bot,
    harness,
    state,
    logger: { warn() {}, error() {} },
    ...(accessPolicy === undefined ? {} : { accessPolicy }),
    ...(modelCard === undefined ? {} : { modelCard }),
  });

  return {
    bridge,
    sent,
    cards,
    notices,
    updates,
    edits,
    selectModelCalls,
    calls,
    sessions,
    setSelected: (value) => { selected = { ...value }; },
    current: () => selected,
  };
}

let sequence = 0;
function message(content, overrides = {}) {
  sequence += 1;
  return {
    messageId: `msg-${sequence}`,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    content,
    addressed: true,
    replyTarget: { chatId: 42 },
    ...overrides,
  };
}

function callback(data, overrides = {}) {
  sequence += 1;
  return {
    messageId: `update-${sequence}`,
    callbackQueryId: 'cb-1',
    providerMessageId: 701,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    addressed: true,
    replyTarget: { chatId: 42 },
    data,
    ...overrides,
  };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function press(bridge, data, overrides = {}) {
  await bridge.acceptCallback(callback(data, overrides));
  await tick();
}

function rows(card) {
  return card?.markup?.inline_keyboard ?? [];
}

function buttons(card) {
  return rows(card).flat();
}

/** A pressed-able button: disabled labels have no callback_data by design. */
function button(card, pattern) {
  const found = buttons(card).find((entry) => pattern.test(entry.text)
    && typeof entry.callback_data === 'string');
  assert.ok(found, `no delivered button matching ${pattern}: ${buttons(card).map((b) => b.text).join(' | ')}`);
  return found;
}

/** The label row whose text matches (group headers, page numbers, current row). */
function label(card, pattern) {
  return buttons(card).find((entry) => pattern.test(entry.text));
}

function labels(card) {
  return rows(card).map((row) => row.map((entry) => entry.text));
}

/** Only pressable buttons carry a callback; labels are `disabled` by design. */
function pressable(card) {
  return buttons(card).filter((entry) => typeof entry.callback_data === 'string');
}

function parseActions(card) {
  return pressable(card).map((entry) => parseTelegramModelCardCallback(entry.callback_data));
}

/* ---------------------------------------------------------------------------
 * Model picker
 * ------------------------------------------------------------------------- */

test('/models sends a provider-grouped picker with the current model checked', async () => {
  const { bridge, sent, cards, calls } = bridgeFixture();
  await bridge.accept(message('/models'));

  assert.equal(cards.length, 1, 'the listing becomes one picker card');
  assert.deepEqual(sent, [], 'the text list is replaced by the card, not duplicated');
  const card = cards[0];
  assert.match(card.text, /选择要使用的模型（共 3 个，第 1\/1 页）/);
  assert.match(card.text, /当前模型：deepseek\/flash/);
  assert.match(card.text, /当前推理等级：High \(high\)/);
  assert.deepEqual(labels(card), [
    ['DeepSeek'],
    ['✓ 1. Flash'],
    ['2. Pro'],
    ['OpenRouter'],
    ['3. Claude'],
    ['⚙️ 推理等级：High (high)'],
  ]);
  assert.equal(calls.listModels, 0, 'a bound conversation reads the Session catalog');
});

test('/model without arguments opens the same picker; without a Session the text stays', async () => {
  const bound = bridgeFixture();
  await bound.bridge.accept(message('/MODEL'));
  assert.equal(bound.cards.length, 1);
  assert.match(bound.cards[0].text, /当前模型：deepseek\/flash/);

  const unbound = bridgeFixture({ sessionId: null });
  await unbound.bridge.accept(message('/model'));
  assert.equal(unbound.cards.length, 0);
  assert.match(unbound.sent.join('\n'), /还没有会话/);
});

test('a list longer than one page paginates; a page press repaints the same message', async () => {
  assert.equal(TELEGRAM_MODEL_CARD_PAGE_SIZE, 8);
  const catalog = flatCatalog(10);
  const fixture = bridgeFixture({
    catalog,
    current: { provider: 'deepseek', model: 'm1' },
  });
  await fixture.bridge.accept(message('/models'));
  const first = fixture.cards[0];
  assert.match(first.text, /第 1\/2 页/);
  const modelRows = rows(first).filter((row) => /Model \d/.test(row[0].text));
  assert.equal(modelRows.length, 8, 'eight models per page');
  const firstNav = rows(first).at(-1);
  assert.deepEqual(firstNav.map((entry) => entry.text), ['上一页', '第 1/2 页', '下一页']);

  const stalePageOne = button(first, /^2\. Model 2$/).callback_data;
  const nextPage = button(first, /^下一页$/).callback_data;
  await press(fixture.bridge, nextPage);

  assert.equal(fixture.edits.length, 1, 'the same card message is edited');
  assert.equal(fixture.edits[0].messageId, '701');
  assert.match(fixture.edits[0].text, /第 2\/2 页/);
  const second = { text: fixture.edits[0].text, markup: fixture.edits[0].markup };
  const secondLabels = labels(second).flat();
  assert.ok(secondLabels.includes('9. Model 9'));
  assert.ok(secondLabels.includes('10. Model 10'));
  assert.ok(!secondLabels.includes('2. Model 2'), 'page one models are gone');
  const secondNav = rows(second).at(-1);
  assert.deepEqual(secondNav.map((entry) => entry.text), ['上一页', '第 2/2 页', '下一页']);
  // The last page has nowhere to go, so 下一页 is a real disabled label rather
  // than a button that answers a pointless "h".
  assert.deepEqual(secondNav.at(-1), { text: '下一页', disabled: {} });

  // The page flip re-presents the card with a fresh nonce, so a stale page-one
  // button is dead and must not switch anything.
  await press(fixture.bridge, stalePageOne, { providerMessageId: 701 });
  assert.deepEqual(fixture.selectModelCalls, []);
  assert.match(fixture.notices.at(-1).text, /取代|已处理/);
  assert.equal(fixture.updates.length, 0, 'the refreshed keyboard is not cleared by a stale press');
});

test('a press switches the model, re-marks the card in place and follows the new model effort', async () => {
  const fixture = bridgeFixture();
  await fixture.bridge.accept(message('/models'));

  const pro = button(fixture.cards[0], /^2\. Pro$/);
  await press(fixture.bridge, pro.callback_data);

  assert.deepEqual(fixture.selectModelCalls, [{ provider: 'deepseek', model: 'pro' }]);
  assert.equal(fixture.edits.length, 1);
  assert.equal(fixture.edits[0].messageId, '701');
  assert.match(fixture.edits[0].text, /当前模型：deepseek\/pro/);
  // The reasoning row must follow the new model's catalog metadata, not the old
  // model's snapshot (Pro defaults to Medium, Flash defaulted to High).
  assert.match(fixture.edits[0].text, /当前推理等级：Medium \(medium\)/);
  const refreshed = { text: fixture.edits[0].text, markup: fixture.edits[0].markup };
  assert.ok(labels(refreshed).flat().includes('✓ 2. Pro'));
  assert.ok(!labels(refreshed).flat().includes('✓ 1. Flash'));
  assert.ok(labels(refreshed).flat().includes('⚙️ 推理等级：Medium (medium)'));
  assert.ok(parseActions(refreshed).every(Boolean), 'every refreshed button is attributable');
  assert.match(fixture.notices.at(-1).text, /模型已切换为：deepseek\/pro/);
});

test('a double press while the switch is in flight performs exactly one switch', async () => {
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const fixture = bridgeFixture({
    selectModelHook: () => gate,
  });
  await fixture.bridge.accept(message('/models'));
  const data = button(fixture.cards[0], /^2\. Pro$/).callback_data;

  const first = fixture.bridge.acceptCallback(callback(data));
  await tick();
  const second = fixture.bridge.acceptCallback(callback(data));
  await tick();

  assert.equal(fixture.selectModelCalls.length, 1, 'the second press does not switch again');
  assert.match(fixture.notices.at(-1).text, /正在切换/);
  release();
  await Promise.all([first, second]);
  assert.equal(fixture.edits.length, 1);
});

test('the current model is a disabled button, not a pressable no-op', async () => {
  const fixture = bridgeFixture();
  await fixture.bridge.accept(message('/models'));
  const current = label(fixture.cards[0], /^✓ 1\. Flash$/);
  // Bot API 10.3: labels carry `disabled` and no callback_data, so the client
  // never sends a callback — there is nothing to answer or switch.
  assert.equal(current.callback_data, undefined);
  assert.deepEqual(current.disabled, {});
  assert.deepEqual(fixture.selectModelCalls, []);
  assert.equal(fixture.edits.length, 0);
});

test('a newer picker retires the previous keyboard; the old press cannot switch', async () => {
  const fixture = bridgeFixture();
  await fixture.bridge.accept(message('/models'));
  const stale = button(fixture.cards[0], /^2\. Pro$/).callback_data;
  await fixture.bridge.accept(message('/models'));

  assert.equal(fixture.cards.length, 2);
  assert.deepEqual(fixture.updates, [{
    messageId: '701',
    markup: { inline_keyboard: [] },
  }]);
  await press(fixture.bridge, stale);
  assert.deepEqual(fixture.selectModelCalls, []);
  assert.match(fixture.notices.at(-1).text, /已被新操作取代|已处理/);
  assert.equal(fixture.updates.length, 1, 'the live keyboard is not cleared by the dead press');
});

test('an expired picker clears its keyboard and cannot switch', async () => {
  let now = 1_000;
  const registry = new ActionCardRegistry({ ttlMs: 5_000, now: () => now });
  const fixture = bridgeFixture({
    modelCard: new TelegramModelCard({ registry, logger: { warn() {} } }),
  });
  await fixture.bridge.accept(message('/models'));
  const data = button(fixture.cards[0], /^2\. Pro$/).callback_data;

  now += 6_000;
  await press(fixture.bridge, data);

  assert.deepEqual(fixture.selectModelCalls, []);
  assert.match(fixture.notices.at(-1).text, /过期/);
  assert.deepEqual(fixture.updates, [{
    messageId: '701',
    markup: { inline_keyboard: [] },
  }]);
});

test('every callback payload fits the 64-byte budget and carries no path or id', async () => {
  const fixture = bridgeFixture();
  await fixture.bridge.accept(message('/models'));
  await fixture.bridge.accept(message('/reasoninglist'));
  assert.equal(fixture.cards.length, 2);
  for (const card of fixture.cards) {
    // Labels are `disabled` (Bot API 10.3) and carry no callback at all.
    for (const entry of pressable(card)) {
      assert.ok(Buffer.byteLength(entry.callback_data, 'utf8') <= 64, entry.callback_data);
      assert.doesNotMatch(entry.callback_data, /\/|session-|chat-a/u,
        'paths, session ids and chat ids never ride in a callback');
      assert.ok(parseTelegramModelCardCallback(entry.callback_data),
        `unattributable callback: ${entry.callback_data}`);
    }
  }
});

test('a refused card send falls back to the exact text listing', async () => {
  const fixture = bridgeFixture({ cardResult: 'fail' });
  await fixture.bridge.accept(message('/models'));
  assert.equal(fixture.cards.length, 0);
  const text = fixture.sent.join('\n');
  assert.match(text, /可用模型：/);
  assert.match(text, /1\. deepseek\/flash/);
  assert.match(text, /切换模型：\/model <序号>/);
});

test('a list above the card cap falls back to the text listing', async () => {
  const catalog = flatCatalog(TELEGRAM_MODEL_CARD_MAX_ITEMS + 1);
  const fixture = bridgeFixture({
    catalog,
    current: { provider: 'deepseek', model: 'm1' },
  });
  await fixture.bridge.accept(message('/models'));
  assert.equal(fixture.cards.length, 0);
  const text = fixture.sent.join('\n');
  assert.match(text, /可用模型：/);
  assert.match(text, new RegExp(`${TELEGRAM_MODEL_CARD_MAX_ITEMS + 1}\\. deepseek/m${TELEGRAM_MODEL_CARD_MAX_ITEMS + 1}`));
});

test('a channel without card capability keeps the byte-identical text output', async () => {
  const fixture = bridgeFixture({ modelCard: null });
  await fixture.bridge.accept(message('/models'));
  assert.equal(fixture.cards.length, 0);
  assert.deepEqual(fixture.sent, [
    [
      '可用模型：',
      '',
      'DeepSeek',
      '1. deepseek/flash（当前）',
      '2. deepseek/pro',
      '',
      'OpenRouter',
      '3. openrouter/anthropic/claude',
      '',
      '切换模型：/model <序号> [推理等级ID]',
    ].join('\n'),
  ]);
});

test('a failed in-place refresh delivers the text receipt instead of going silent', async () => {
  const fixture = bridgeFixture({ editResult: 'fail' });
  await fixture.bridge.accept(message('/models'));
  const pro = button(fixture.cards[0], /^2\. Pro$/).callback_data;
  await press(fixture.bridge, pro);

  assert.equal(fixture.selectModelCalls.length, 1);
  assert.match(fixture.sent.join('\n'), /模型已切换为：/);
  assert.match(fixture.notices.at(-1).text, /无法更新选择卡片/);
  assert.deepEqual(fixture.updates, [{
    messageId: '701',
    markup: { inline_keyboard: [] },
  }]);
});

/* ---------------------------------------------------------------------------
 * Reasoning picker
 * ------------------------------------------------------------------------- */

test('/reasoninglist sends a reasoning picker with current effort and a follow-default row', async () => {
  const fixture = bridgeFixture();
  await fixture.bridge.accept(message('/reasoninglist'));
  assert.equal(fixture.cards.length, 1);
  assert.deepEqual(fixture.sent, []);
  const card = fixture.cards[0];
  assert.match(card.text, /选择推理等级（共 2 个）/);
  assert.match(card.text, /当前模型：deepseek\/flash/);
  assert.match(card.text, /当前推理等级：High \(high\)/);
  assert.deepEqual(labels(card), [
    ['1. Off (off)'],
    ['✓ 2. High (high)'],
    ['跟随默认（由模型决定）'],
  ]);
});

test('every reasoning alias sends the picker; /reasoning without arguments too', async () => {
  for (const command of ['/reasoninglist', '/reasonings', '/reasoning']) {
    const fixture = bridgeFixture();
    await fixture.bridge.accept(message(command));
    assert.equal(fixture.cards.length, 1, command);
    assert.match(fixture.cards[0].text, /选择推理等级/, command);
  }
});

test('a reasoning press switches the effort and repaints the picker', async () => {
  const fixture = bridgeFixture();
  await fixture.bridge.accept(message('/reasoninglist'));
  const off = button(fixture.cards[0], /^1\. Off \(off\)$/).callback_data;
  await press(fixture.bridge, off);

  assert.deepEqual(fixture.selectModelCalls, [{
    provider: 'deepseek',
    model: 'flash',
    reasoningEffort: 'off',
  }]);
  assert.equal(fixture.edits.length, 1);
  assert.match(fixture.edits[0].text, /当前推理等级：Off \(off\)/);
  const refreshed = { text: fixture.edits[0].text, markup: fixture.edits[0].markup };
  assert.ok(labels(refreshed).flat().includes('✓ 1. Off (off)'));
  assert.ok(!labels(refreshed).flat().includes('✓ 2. High (high)'));
  assert.match(fixture.notices.at(-1).text, /推理等级已切换为：Off \(off\)/);
});

test('the follow-default row restores the model default', async () => {
  const fixture = bridgeFixture();
  await fixture.bridge.accept(message('/reasoninglist'));
  const followDefault = button(fixture.cards[0], /^跟随默认/).callback_data;
  await press(fixture.bridge, followDefault);
  assert.deepEqual(fixture.selectModelCalls, [{ provider: 'deepseek', model: 'flash' }]);
  assert.equal(fixture.edits.length, 1);
  assert.match(fixture.notices.at(-1).text, /已恢复默认推理等级/);
  assert.match(fixture.edits[0].text, /当前推理等级：High \(high\)/);
});

test('a model without reasoning metadata keeps the explicit text hint', async () => {
  const fixture = bridgeFixture({
    current: { provider: 'openrouter', model: 'anthropic/claude' },
  });
  await fixture.bridge.accept(message('/reasoninglist'));
  assert.equal(fixture.cards.length, 0);
  assert.match(fixture.sent.join('\n'), /该模型不提供可切换的推理等级/);
  assert.match(fixture.sent.join('\n'), /恢复默认等级：\/reasoning --default/);
});

test('a reasoning press after the model changed explains the incompatible effort', async () => {
  const fixture = bridgeFixture();
  await fixture.bridge.accept(message('/reasoninglist'));
  const off = button(fixture.cards[0], /^1\. Off \(off\)$/).callback_data;
  // The model changed behind the card's back (typed /model, another client, ...).
  fixture.setSelected({ provider: 'deepseek', model: 'pro', reasoningEffort: 'medium' });
  await press(fixture.bridge, off);

  assert.deepEqual(fixture.selectModelCalls, [], 'no silent fallback to another effort');
  assert.match(fixture.sent.join('\n'), /模型不支持推理等级：off/);
  assert.match(fixture.sent.join('\n'), /可用推理等级：medium, xhigh/);
  assert.match(fixture.notices.at(-1).text, /无法切换推理等级/);
  assert.deepEqual(fixture.updates, [{
    messageId: '701',
    markup: { inline_keyboard: [] },
  }]);
});

test('pressing the current reasoning effort is a no-op receipt', async () => {
  const fixture = bridgeFixture();
  await fixture.bridge.accept(message('/reasoninglist'));
  const current = button(fixture.cards[0], /^✓ 2\. High \(high\)$/).callback_data;
  await press(fixture.bridge, current);
  assert.deepEqual(fixture.selectModelCalls, []);
  assert.equal(fixture.edits.length, 0);
  assert.match(fixture.notices.at(-1).text, /已经是当前推理等级/);
});

test('a press without command permission switches nothing', async () => {
  const policy = createAccessPolicy({
    direct: createAccessPolicyScope({
      mode: 'open',
      open: {
        defaultCanExecuteCommands: true,
        commandPermissionOverrides: [{ id: 'actor-b', canExecuteCommands: false }],
      },
      allowlist: { users: [] },
    }),
    group: createAccessPolicyScope({
      mode: 'open',
      open: { defaultCanExecuteCommands: true, commandPermissionOverrides: [] },
      allowlist: { users: [] },
    }),
  });
  const fixture = bridgeFixture({ accessPolicy: { getSettings: () => policy } });
  await fixture.bridge.accept(message('/models'));
  const pro = button(fixture.cards[0], /^2\. Pro$/).callback_data;
  await press(fixture.bridge, pro, { senderId: 'actor-b' });

  assert.deepEqual(fixture.selectModelCalls, []);
  assert.match(fixture.notices.at(-1).text, /权限|不能执行|没有/);
});

/* ---------------------------------------------------------------------------
 * Parser + i18n
 * ------------------------------------------------------------------------- */

test('the callback parser accepts only its own namespaces', () => {
  assert.equal(parseTelegramModelCardCallback(undefined), null);
  assert.equal(parseTelegramModelCardCallback(''), null);
  assert.equal(parseTelegramModelCardCallback('w1|abc|0'), null, 'workspace cards keep their namespace');
  assert.equal(parseTelegramModelCardCallback('q|abc|0|0'), null, 'question cards keep their namespace');
  assert.deepEqual(parseTelegramModelCardCallback('m2|abc|waytoolongaction'), {
    kind: 'models',
    nonce: 'abc',
    action: 'waytoolongaction',
  });
  assert.equal(parseTelegramModelCardCallback('m2|abc|waytoolongactionx'), null);
  assert.deepEqual(parseTelegramModelCardCallback('m2|abc|3'), {
    kind: 'models',
    nonce: 'abc',
    action: '3',
  });
  assert.deepEqual(parseTelegramModelCardCallback('r2|abc|d'), {
    kind: 'reasoning',
    nonce: 'abc',
    action: 'd',
  });
});

test('the selection cards are translated when the host language is English', async () => {
  setImHostLanguage('en');
  try {
    const fixture = bridgeFixture();
    await fixture.bridge.accept(message('/models'));
    assert.match(fixture.cards[0].text, /Choose a model \(3 total, page 1\/1\)/);
    assert.match(fixture.cards[0].text, /Current model: deepseek\/flash/);
    assert.match(fixture.cards[0].text, /Current reasoning effort: High \(high\)/);
    assert.ok(labels(fixture.cards[0]).flat().includes('✓ 1. Flash'));

    await fixture.bridge.accept(message('/reasoninglist'));
    const reasoning = fixture.cards.at(-1);
    assert.match(reasoning.text, /Choose a reasoning effort \(2 total\)/);
    assert.match(reasoning.text, /Current model: deepseek\/flash/);
    assert.ok(labels(reasoning).flat().includes('Follow the default (decided by the model)'));
    assert.ok(labels(reasoning).flat().includes('✓ 2. High (high)'));

    // The in-place receipt is translated too.
    const off = button(reasoning, /^1\. Off \(off\)$/).callback_data;
    await press(fixture.bridge, off);
    assert.match(fixture.notices.at(-1).text, /Reasoning effort switched to: Off \(off\)/);
  } finally {
    setImHostLanguage('zh');
  }
});
