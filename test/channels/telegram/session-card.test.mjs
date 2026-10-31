import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { ActionCardRegistry } from '../../../src/channels/shared/action-card.mjs';
import { createAccessPolicy, createAccessPolicyScope } from '../../../src/channels/shared/access-policy.mjs';
import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import { COMMAND_PERMISSION_DENIED_MESSAGE } from '../../../src/channels/shared/inbound-access.mjs';
import { TextHarnessBridge } from '../../../src/channels/shared/text-harness-bridge.mjs';
import { TelegramHarnessBridge } from '../../../src/channels/telegram/telegram-bridge.mjs';
import { runWorkspaceCommand } from '../../../src/channels/shared/workspace-command.mjs';
import {
  TELEGRAM_SESSION_CARD_MAX_SESSIONS,
  TELEGRAM_SESSION_CARD_PAGE_SIZE,
  TelegramSessionCard,
  parseTelegramSessionCallback,
  telegramSessionCardRender,
} from '../../../src/channels/telegram/session-card.mjs';

let WORKSPACE = '';
const EMPTY_KEYBOARD = { inline_keyboard: [] };

before(async () => {
  // /sessionlist validates the effective workspace on disk, so the fixture must
  // be a real directory (the card path shares that validation with the text one).
  WORKSPACE = await mkdtemp(join(tmpdir(), 'session-card-'));
});

after(async () => {
  if (WORKSPACE) await rm(WORKSPACE, { recursive: true, force: true });
});

function sessionIdFor(index) {
  return `${String(index + 1).padStart(8, '0')}-1111-2222-3333-444455556666`;
}

function sessionsFixture(count, { archivedIndexes = [], summaryUnavailableIndexes = [] } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    sessionId: sessionIdFor(index),
    title: `会话 ${index + 1}`,
    archived: archivedIndexes.includes(index),
    summaryAvailable: !summaryUnavailableIndexes.includes(index),
  }));
}

function bridgeFixture({
  sessions = sessionsFixture(3),
  currentSessionId = null,
  cardResult = 'ok',
  bindError = null,
  bindTitle = null,
  accessPolicy,
  registry,
  sessionCard = true,
  parkBind = false,
  failClear = false,
} = {}) {
  const sent = [];
  const cards = [];
  const notices = [];
  const edits = [];
  const binds = [];
  const clears = [];
  let bound = currentSessionId;
  let releaseBind = null;
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'telegram', label: 'Telegram', reactions: {} },
    state: {
      seen: new Set(),
      hasSeen(messageId) { return this.seen.has(messageId); },
      async markSeen(messageId) { this.seen.add(messageId); },
      sessionFor() { return bound; },
      async setSession(_key, sessionId) { bound = sessionId; },
      async clearSession() {
        clears.push(1);
        if (failClear) throw new Error('clearSession failed');
        bound = null;
      },
    },
    ...(sessionCard
      ? {
        sessionCard: sessionCard === true
          ? new TelegramSessionCard({ registry: registry ?? new ActionCardRegistry() })
          : sessionCard,
      }
      : {}),
    accessPolicy,
    bot: {
      async sendText(_target, text) { sent.push(text); },
      async sendInteractionCard(_target, { text, markup }) {
        if (cardResult === 'fail') throw new Error('telegram refused the keyboard');
        cards.push({ text, markup });
        return { providerMessageIds: [String(700 + cards.length)] };
      },
      async updateInteractionCard(_target, messageId, { markup }) {
        edits.push({ messageId, markup });
      },
      async editInteractionCard(_target, messageId, { text, markup }) {
        edits.push({ messageId, text, markup });
      },
      async answerInteractionCallback(queryId, text) {
        notices.push({ queryId, text });
      },
    },
    harness: {
      currentWorkspace: () => WORKSPACE,
      async listWorkspaceSessions(workspace) {
        return { workspace, sessions: sessions.map((session) => ({ ...session })) };
      },
      async bindWorkspaceSession(key, sessionId) {
        binds.push({ key, sessionId });
        if (parkBind) await new Promise((resolve) => { releaseBind = resolve; });
        if (bindError) throw bindError;
        bound = sessionId;
        return {
          sessionId,
          workspace: WORKSPACE,
          title: bindTitle ?? `标题 ${sessionId.slice(0, 8)}`,
          archived: false,
        };
      },
      assertWorkspaceScope() {},
    },
    logger: { warn() {}, error() {} },
  });
  return {
    bridge,
    sent,
    cards,
    notices,
    edits,
    binds,
    clears,
    releaseBind: () => releaseBind?.(),
  };
}

let messageSeq = 0;
function message(content, overrides = {}) {
  messageSeq += 1;
  return {
    messageId: `msg-${messageSeq}`,
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
  messageSeq += 1;
  return {
    messageId: `update-${messageSeq}`,
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

function buttons(card) {
  return (card?.markup?.inline_keyboard ?? []).flat();
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function press(bridge, data, overrides = {}) {
  await bridge.acceptCallback(callback(data, overrides));
  await tick();
}

test('/sessionlist sends one session card with title, short ID and current ✓', async () => {
  const sessions = sessionsFixture(3, { archivedIndexes: [2] });
  const { bridge, cards, sent } = bridgeFixture({
    sessions,
    currentSessionId: sessions[0].sessionId,
  });
  await bridge.accept(message('/sessionlist'));

  assert.equal(cards.length, 1, 'exactly one card');
  assert.equal(sent.length, 0, 'no duplicate text list');
  assert.match(cards[0].text, new RegExp(`工作区：${WORKSPACE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(cards[0].text, /会话（2）/);
  assert.match(cards[0].text, /点击按钮把会话绑定到当前聊天/);
  const rows = cards[0].markup.inline_keyboard;
  // Two visible session rows plus the action strip; archived sessions never
  // become buttons.
  assert.equal(rows.length, 3);
  assert.ok(rows.flat().every((button) => !/archived|归档/u.test(button.text)));
  assert.equal(rows[0][0].text, '✓ 会话 1 · 00000001');
  assert.equal(rows[1][0].text, '会话 2 · 00000002');
  assert.doesNotMatch(JSON.stringify(cards[0]), /已归档/);
});

test('a workspace whose sessions are all archived hides them and says why', async () => {
  const sessions = sessionsFixture(2, { archivedIndexes: [0, 1] });
  const { bridge, cards, sent } = bridgeFixture({ sessions });
  await bridge.accept(message('/sessionlist'));

  assert.equal(cards.length, 0, 'no keyboard that could bind an archived Session');
  assert.match(sent.join(''), /当前工作区没有可绑定的会话（已归档的会话不显示）/);
  assert.doesNotMatch(sent.join(''), /（已归档）|ID: /, 'the archived rows are not leaked in the notice');
});

test('long lists paginate ten per page and page presses edit the same card in place', async () => {
  const sessions = sessionsFixture(TELEGRAM_SESSION_CARD_PAGE_SIZE + 2);
  const { bridge, cards, edits, binds } = bridgeFixture({ sessions });
  await bridge.accept(message('/sessionlist'));

  const firstKeyboard = cards[0].markup.inline_keyboard;
  // ten session rows + pager + the action strip
  assert.equal(firstKeyboard.length, TELEGRAM_SESSION_CARD_PAGE_SIZE + 2);
  const firstPager = firstKeyboard.at(-2);
  assert.deepEqual(firstPager.map((button) => button.text), ['第 1/2 页', '下一页 ▶']);
  await press(bridge, firstPager[1].callback_data);

  assert.equal(binds.length, 0, 'paging never binds');
  assert.equal(edits.length, 1, 'the same message is edited');
  assert.equal(edits[0].messageId, '701');
  assert.match(edits[0].text, /会话（12）.*第 2\/2 页/);
  const secondKeyboard = edits[0].markup.inline_keyboard;
  assert.equal(secondKeyboard.length, 4, 'two session rows, the pager and the actions');
  assert.equal(secondKeyboard[0][0].text, '会话 11 · 00000011');
  assert.deepEqual(secondKeyboard.at(-2).map((button) => button.text), ['◀ 上一页', '第 2/2 页']);
});

test('the page indicator is a disabled label, not a pressable no-op', async () => {
  const { bridge, cards, edits, binds } = bridgeFixture({
    sessions: sessionsFixture(TELEGRAM_SESSION_CARD_PAGE_SIZE + 1),
  });
  await bridge.accept(message('/sessionlist'));
  const indicator = cards[0].markup.inline_keyboard.at(-2)[0];
  assert.equal(indicator.text, '第 1/2 页');
  // Bot API 10.3: no callback_data means the client sends nothing at all.
  assert.equal(indicator.callback_data, undefined);
  assert.deepEqual(indicator.disabled, {});
  assert.equal(edits.length, 0);
  assert.equal(binds.length, 0);
});

test('pressing a session binds it, moves ✓ in place and returns a receipt', async () => {
  const sessions = sessionsFixture(3);
  const { bridge, cards, edits, notices, binds } = bridgeFixture({ sessions });
  await bridge.accept(message('/sessionlist'));
  const rows = cards[0].markup.inline_keyboard;

  await press(bridge, rows[1][0].callback_data);
  assert.deepEqual(binds, [{ key: 'direct:chat-a', sessionId: sessions[1].sessionId }]);
  const boundEdit = edits.at(-1);
  assert.equal(boundEdit.messageId, '701');
  assert.match(boundEdit.markup.inline_keyboard[1][0].text, /^✓ 会话 2/);
  assert.doesNotMatch(boundEdit.markup.inline_keyboard[0][0].text, /✓/);
  assert.match(notices.at(-1).text, /^已绑定会话：标题 00000002/);

  // The refreshed card is a new presentation: a second, different binding works
  // without re-sending /sessionlist.
  await press(bridge, boundEdit.markup.inline_keyboard[0][0].callback_data);
  assert.deepEqual(binds.map((call) => call.sessionId), [
    sessions[1].sessionId,
    sessions[0].sessionId,
  ]);
  assert.match(edits.at(-1).markup.inline_keyboard[0][0].text, /^✓ 会话 1/);
  assert.doesNotMatch(edits.at(-1).markup.inline_keyboard[1][0].text, /✓/);
});

test('pressing the session that is already bound is an idempotent receipt', async () => {
  const sessions = sessionsFixture(2);
  const { bridge, cards, binds, notices } = bridgeFixture({
    sessions,
    currentSessionId: sessions[0].sessionId,
  });
  await bridge.accept(message('/sessionlist'));
  await press(bridge, cards[0].markup.inline_keyboard[0][0].callback_data);
  assert.equal(binds.length, 0, 'binding is not repeated');
  assert.match(notices.at(-1).text, /当前聊天已经绑定该会话/);
});

test('a binding failure reuses the typed /session text and clears the keyboard', async () => {
  const error = new Error('the session is gone');
  error.code = 'session-not-registered';
  const sessions = sessionsFixture(2);
  const { bridge, cards, sent, edits, notices, binds } = bridgeFixture({
    sessions,
    bindError: error,
  });
  await bridge.accept(message('/sessionlist'));
  await press(bridge, cards[0].markup.inline_keyboard[1][0].callback_data);

  assert.equal(binds.length, 1);
  // One failure mapping for both entry points: the same error object produced by
  // the typed command yields byte-identical words on the card path.
  const typed = await runWorkspaceCommand('/session an-unrelated-id', {
    async bindWorkspaceSession() { throw error; },
  }, 'direct:chat-a');
  assert.equal(sent.join('\n'), typed.message);
  assert.equal(notices.at(-1).text, typed.message);
  assert.deepEqual(edits.at(-1), { messageId: '701', markup: EMPTY_KEYBOARD });
});

test('a second press while binding does not bind twice', async () => {
  const sessions = sessionsFixture(2);
  const { bridge, cards, binds, notices, releaseBind } = bridgeFixture({
    sessions,
    parkBind: true,
  });
  await bridge.accept(message('/sessionlist'));
  const data = cards[0].markup.inline_keyboard[0][0].callback_data;
  const first = bridge.acceptCallback(callback(data));
  await tick();
  const second = bridge.acceptCallback(callback(data));
  await tick();
  assert.equal(binds.length, 1, 'only the first press binds');
  assert.match(notices.at(-1).text, /正在绑定会话/);
  releaseBind();
  await Promise.all([first, second]);
  await tick();
});

test('an expired card clears its keyboard and never binds', async () => {
  let now = 1_000_000;
  const registry = new ActionCardRegistry({ ttlMs: 60_000, now: () => now });
  const sessions = sessionsFixture(2);
  const { bridge, cards, edits, notices, binds } = bridgeFixture({ sessions, registry });
  await bridge.accept(message('/sessionlist'));
  const data = cards[0].markup.inline_keyboard[0][0].callback_data;

  now += 60_001;
  await press(bridge, data);
  assert.equal(binds.length, 0);
  assert.deepEqual(edits.at(-1), { messageId: '701', markup: EMPTY_KEYBOARD });
  assert.match(notices.at(-1).text, /这个会话列表已过期/);
  assert.match(notices.at(-1).text, /\/sessionlist/);
});

test('callback payloads stay within 64 bytes and carry no session ID or workspace path', async () => {
  const sessions = sessionsFixture(12);
  const { bridge, cards } = bridgeFixture({ sessions });
  await bridge.accept(message('/sessionlist'));

  const parsedKinds = new Set();
  // Labels (`disabled`) carry no callback at all, so they are not part of this.
  for (const button of buttons(cards[0]).filter((entry) => typeof entry.callback_data === 'string')) {
    const bytes = Buffer.byteLength(button.callback_data, 'utf8');
    assert.ok(bytes <= 64, `callback_data is ${bytes} bytes: ${button.callback_data}`);
    assert.ok(!button.callback_data.includes(WORKSPACE), 'workspace path stays out of callbacks');
    assert.ok(!button.callback_data.includes(sessions[0].sessionId), 'session ID stays out of callbacks');
    const parsed = parseTelegramSessionCallback(button.callback_data);
    assert.ok(parsed, `callback parses: ${button.callback_data}`);
    assert.match(parsed.nonce, /^[A-Za-z0-9_-]{1,32}$/);
    parsedKinds.add(parsed.kind);
  }
  // `new` rides the same namespace: the strip acts on this conversation, so like
  // bind/page it carries no id. Nothing is bound here, so there is no 解绑 row.
  assert.deepEqual([...parsedKinds].sort(), ['bind', 'new', 'page']);
});

test('a newer session list retires the previous card keyboard', async () => {
  const { bridge, cards, edits } = bridgeFixture({ sessions: sessionsFixture(2) });
  await bridge.accept(message('/sessionlist'));
  await bridge.accept(message('/sessionlist'));
  assert.equal(cards.length, 2);
  assert.equal(edits[0].messageId, '701');
  assert.deepEqual(edits[0].markup, EMPTY_KEYBOARD);
});

test('card delivery failure falls back to the byte-identical /sessionlist text', async () => {
  const sessions = sessionsFixture(3, { archivedIndexes: [1] });
  const { bridge, cards, sent } = bridgeFixture({ sessions, cardResult: 'fail' });
  await bridge.accept(message('/sessionlist'));

  assert.equal(cards.length, 0);
  const expected = await runWorkspaceCommand('/sessionlist', {
    currentWorkspace: () => WORKSPACE,
    async listWorkspaceSessions(workspace) {
      return { workspace, sessions };
    },
  }, 'direct:chat-a');
  assert.equal(sent.join(''), expected.message);
});

test('too many sessions fall back to the text list', async () => {
  const sessions = sessionsFixture(TELEGRAM_SESSION_CARD_MAX_SESSIONS + 1);
  const { bridge, cards, sent } = bridgeFixture({ sessions });
  await bridge.accept(message('/sessionlist'));
  assert.equal(cards.length, 0);
  assert.match(sent.join(''), new RegExp(`会话（${sessions.length}）`));
  assert.match(sent.join(''), /绑定用法：\/session/);
});

test('an empty workspace keeps the explicit empty prompt', async () => {
  const { bridge, cards, sent } = bridgeFixture({ sessions: [] });
  await bridge.accept(message('/sessionlist'));
  assert.equal(cards.length, 0);
  assert.match(sent.join(''), /该工作区暂无会话/);
});

test('bare /session opens the same card while an argument keeps the text binding', async () => {
  const sessions = sessionsFixture(2);
  const { bridge, cards, sent } = bridgeFixture({ sessions });
  await bridge.accept(message('/session'));
  assert.equal(cards.length, 1, '/session without an argument opens the picker');
  assert.equal(sent.length, 0);

  await bridge.accept(message(`/SESSION ${sessions[0].sessionId}`));
  assert.equal(cards.length, 1, 'an argument does not open a card');
  assert.match(sent.at(-1), /当前聊天已绑定会话：/);
});

test('without a session card the bare /session keeps its legacy usage text', async () => {
  const { bridge, cards, sent } = bridgeFixture({ sessionCard: false });
  await bridge.accept(message('/session'));
  assert.equal(cards.length, 0);
  assert.match(sent.join(''), /用法：\/session Session ID/);
});

test('the renderer declines empty and oversized listings and truncates long labels', () => {
  const nonce = 'AbCdEfGhIjKl';
  assert.equal(telegramSessionCardRender({ workspace: WORKSPACE, sessions: [] }, { nonce }), null);
  assert.equal(telegramSessionCardRender({
    workspace: WORKSPACE,
    sessions: sessionsFixture(TELEGRAM_SESSION_CARD_MAX_SESSIONS + 1),
  }, { nonce }), null);

  const longTitle = '这是一个特别长的会话标题'.repeat(8);
  const card = telegramSessionCardRender({
    workspace: WORKSPACE,
    sessions: [{ sessionId: sessionIdFor(0), title: longTitle, archived: false, summaryAvailable: true }],
  }, { nonce });
  const label = card.markup.inline_keyboard[0][0].text;
  assert.ok([...label].length <= 64, `button label is ${[...label].length} code points`);
  assert.match(label, /…/);
  assert.match(label, /00000001/);
});

test('a press without command permission binds nothing', async () => {
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
  const sessions = sessionsFixture(2);
  const { bridge, cards, binds, notices } = bridgeFixture({
    sessions,
    accessPolicy: { getSettings: () => policy },
  });
  await bridge.accept(message('/sessionlist'));
  await press(bridge, cards[0].markup.inline_keyboard[0][0].callback_data, {
    senderId: 'actor-b',
  });
  assert.equal(binds.length, 0);
  assert.equal(notices.at(-1).text, COMMAND_PERMISSION_DENIED_MESSAGE);
});

test('a card from another conversation cannot bind', async () => {
  const sessions = sessionsFixture(2);
  const { bridge, cards, binds, notices } = bridgeFixture({ sessions });
  await bridge.accept(message('/sessionlist'));
  await press(bridge, cards[0].markup.inline_keyboard[0][0].callback_data, {
    conversationId: 'chat-b',
  });
  assert.equal(binds.length, 0);
  assert.match(notices.at(-1).text, /这个会话列表已过期/);
});

test('English UI translates the card body, the pager, the hint and the receipt', async (t) => {
  t.after(() => setImHostLanguage('zh'));
  setImHostLanguage('en');
  const sessions = sessionsFixture(TELEGRAM_SESSION_CARD_PAGE_SIZE + 2);
  const { bridge, cards, notices } = bridgeFixture({ sessions });
  await bridge.accept(message('/sessionlist'));

  assert.match(cards[0].text, new RegExp(`^Workspace: ${WORKSPACE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u'));
  assert.match(cards[0].text, /Sessions \(12\): Page 1\/2/u);
  assert.match(cards[0].text, /Tap a session button to bind it to this chat\./u);
  // The pager is second-to-last now; the action strip closes the card.
  assert.deepEqual(
    cards[0].markup.inline_keyboard.at(-2).map((button) => button.text),
    ['Page 1/2', 'Next ▶'],
  );
  assert.deepEqual(
    cards[0].markup.inline_keyboard.at(-1).map((button) => button.text),
    ['🆕 New session'],
  );

  await press(bridge, cards[0].markup.inline_keyboard[1][0].callback_data);
  assert.match(notices.at(-1).text, /^Bound to Session: /u);
});

test('the Telegram bridge wires the session picker by default', async () => {
  const cards = [];
  const sessions = sessionsFixture(2);
  const bridge = new TelegramHarnessBridge({
    bot: {
      async sendText() {},
      async sendInteractionCard(_target, card) {
        cards.push(card);
        return { providerMessageIds: ['900'] };
      },
      async updateInteractionCard() {},
      async editInteractionCard() {},
      async answerInteractionCallback() {},
    },
    harness: {
      currentWorkspace: () => WORKSPACE,
      async listWorkspaceSessions(workspace) { return { workspace, sessions }; },
      assertWorkspaceScope() {},
    },
    state: {
      hasSeen: () => false,
      async markSeen() {},
      sessionFor: () => null,
    },
  });
  await bridge.accept(message('/sessionlist'));
  assert.equal(cards.length, 1, 'the default bridge carries the picker');
  assert.match(cards[0].text, /会话（2）/);
  // two session rows + the action strip
  assert.equal(cards[0].markup.inline_keyboard.length, 3);
});

// ── action strip: 解绑 / 新会话 ───────────────────────────────────────────────

function actionsOf(card) {
  return card.markup.inline_keyboard.at(-1);
}

test('a bound chat gets both 解绑 and 新会话; an unbound one only 新会话', async () => {
  const sessions = sessionsFixture(2);
  const bound = bridgeFixture({ sessions, currentSessionId: sessions[0].sessionId });
  await bound.bridge.accept(message('/sessionlist'));
  const actions = actionsOf(bound.cards[0]);
  assert.deepEqual(actions.map((button) => button.text), ['🔓 解绑当前会话', '🆕 新会话']);

  const unbound = bridgeFixture({ sessions });
  await unbound.bridge.accept(message('/sessionlist'));
  assert.deepEqual(actionsOf(unbound.cards[0]).map((button) => button.text), ['🆕 新会话']);
});

test('the 解绑 row drops the binding and turns the card into a receipt', async () => {
  const sessions = sessionsFixture(2);
  const { bridge, cards, edits, clears, notices } = bridgeFixture({
    sessions,
    currentSessionId: sessions[0].sessionId,
  });
  await bridge.accept(message('/sessionlist'));
  const unbind = actionsOf(cards[0])[0];
  await bridge.acceptCallback({
    callbackQueryId: 'cb-unbind',
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    messageId: 'update-unbind',
    providerMessageId: '701',
    data: unbind.callback_data,
    replyTarget: { chatId: 42 },
  });
  assert.equal(clears.length, 1, 'the binding is released once');
  // The receipt replaces the list, and the keyboard is gone.
  const receipt = edits.find((edit) => edit.text);
  assert.ok(receipt, 'the card body is rewritten');
  assert.match(receipt.text, /已解绑会话/u);
  assert.deepEqual(receipt.markup, { inline_keyboard: [] });
  assert.ok(notices.some(({ text }) => /已解绑/u.test(text ?? '')));
});

test('the 新会话 row starts a fresh session through the /new path', async () => {
  const sessions = sessionsFixture(2);
  const { bridge, cards, edits, clears } = bridgeFixture({
    sessions,
    currentSessionId: sessions[0].sessionId,
  });
  await bridge.accept(message('/sessionlist'));
  const startNew = actionsOf(cards[0]).at(-1);
  assert.equal(startNew.text, '🆕 新会话');
  await bridge.acceptCallback({
    callbackQueryId: 'cb-new',
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    messageId: 'update-new',
    providerMessageId: '701',
    data: startNew.callback_data,
    replyTarget: { chatId: 42 },
  });
  assert.equal(clears.length, 1);
  const receipt = edits.find((edit) => edit.text);
  assert.match(receipt.text, /已开启新会话/u);
  assert.deepEqual(receipt.markup, { inline_keyboard: [] });
});

test('a double press on an action row releases only once', async () => {
  const sessions = sessionsFixture(2);
  const { bridge, cards, clears } = bridgeFixture({
    sessions,
    currentSessionId: sessions[0].sessionId,
  });
  await bridge.accept(message('/sessionlist'));
  const unbind = actionsOf(cards[0])[0];
  const callback = (queryId, messageId) => ({
    callbackQueryId: queryId,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    messageId,
    providerMessageId: '701',
    data: unbind.callback_data,
    replyTarget: { chatId: 42 },
  });
  await Promise.all([
    bridge.acceptCallback(callback('cb-1', 'update-1')),
    bridge.acceptCallback(callback('cb-2', 'update-2')),
  ]);
  assert.equal(clears.length, 1, 'the binding is released exactly once');
});

test('an action row from another chat cannot touch this conversation', async () => {
  const sessions = sessionsFixture(2);
  const { bridge, cards, clears } = bridgeFixture({
    sessions,
    currentSessionId: sessions[0].sessionId,
  });
  await bridge.accept(message('/sessionlist'));
  const unbind = actionsOf(cards[0])[0];
  await bridge.acceptCallback({
    callbackQueryId: 'cb-other',
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-b',
    messageId: 'update-other',
    providerMessageId: '701',
    data: unbind.callback_data,
    replyTarget: { chatId: 43 },
  });
  assert.equal(clears.length, 0);
});

test('a failed release leaves the card usable instead of claiming success', async () => {
  const sessions = sessionsFixture(2);
  const { bridge, cards, edits, notices } = bridgeFixture({
    sessions,
    currentSessionId: sessions[0].sessionId,
    failClear: true,
  });
  await bridge.accept(message('/sessionlist'));
  const unbind = actionsOf(cards[0])[0];
  await bridge.acceptCallback({
    callbackQueryId: 'cb-fail',
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    messageId: 'update-fail',
    providerMessageId: '701',
    data: unbind.callback_data,
    replyTarget: { chatId: 42 },
  });
  assert.equal(edits.filter((edit) => edit.text).length, 0, 'no success receipt is painted');
  assert.ok(notices.some(({ text }) => /没有完成/u.test(text ?? '')));
});
