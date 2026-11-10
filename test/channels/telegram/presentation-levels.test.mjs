import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import { TelegramConfigStore } from '../../../src/channels/telegram/config-store.mjs';
import { TelegramController } from '../../../src/channels/telegram/telegram-controller.mjs';
import { TelegramDisplayCard } from '../../../src/channels/telegram/display-card.mjs';
import { TelegramHarnessBridge } from '../../../src/channels/telegram/telegram-bridge.mjs';
import { TelegramBotClient, TelegramRuntime } from '../../../src/channels/telegram/telegram-runtime.mjs';
import { TelegramStateStore } from '../../../src/channels/telegram/state-store.mjs';

const quietLogger = { warn: () => {}, error: () => {}, debug: () => {} };

function memoryState() {
  const sessions = new Map();
  const seen = new Set();
  return {
    sessionFor: (key) => sessions.get(key) ?? null,
    setSession: async (key, value) => sessions.set(key, value),
    clearSession: async (key) => sessions.delete(key),
    hasSeen: (id) => seen.has(id),
    markSeen: async (id) => seen.add(id),
  };
}

function message(overrides = {}) {
  return {
    messageId: 'm1',
    senderId: 'u1',
    kind: 'direct',
    conversationId: 'u1',
    content: 'hello',
    addressed: true,
    replyTarget: { chatId: 42, replyToMessageId: 7 },
    ...overrides,
  };
}

/** A semantic stream that records what the bridge asked it to show. */
function streamFixture({ failMode = false } = {}) {
  const calls = { updates: [], finish: [], fail: [], cancel: 0, deletes: 0 };
  const stream = {
    presentation: 'telegram-regular',
    previewAnswer: false,
    supportsProgressSummary: true,
    async update(block) { calls.updates.push(block.text); },
    async finish(block) {
      calls.finish.push(block);
      return { presentation: 'telegram-rich-final', providerMessageIds: ['9'], deliveryOutcome: 'sent' };
    },
    async fail(block) {
      if (!failMode) {
        calls.fail.push(block);
        return { presentation: 'telegram-regular', providerMessageIds: ['9'], deliveryOutcome: 'sent' };
      }
      calls.fail.push(block);
      return null;
    },
    cancel() { calls.cancel += 1; },
  };
  return { stream, calls };
}

function botFixture({ stream, onOpen } = {}) {
  const texts = [];
  const bot = {
    async sendText(_target, text) { texts.push(text); },
    async sendTyping() {},
    async openDeliveryStream() {
      onOpen?.('delivery');
      return stream;
    },
    async openThinkingStream() {
      onOpen?.('thinking');
      const lines = [];
      return {
        presentation: 'telegram-thinking',
        keepalive: true,
        async update() {},
        async refresh() {},
        async sendThinking(text) { lines.push(['thinking', text]); },
        async sendToolTrace(name, args) { lines.push(['tool', name, args]); },
        async finish(block) { lines.push(['finish', block.text]); },
        sendLines: () => lines,
      };
    },
    streamLines: null,
  };
  return { bot, texts };
}

function harnessFixture({ onAsk, workspaceSession } = {}) {
  return {
    async ensureRunning() { return true; },
    async sessionExists() { return true; },
    async createSession() { return 'session-x'; },
    ...(typeof workspaceSession === 'function' ? { workspaceSession } : {}),
    async ask(_sessionId, _text, options) {
      if (onAsk) await onAsk(options);
      return '**final**';
    },
  };
}

test('L1: minimal opens the placeholder stream and shows no progress at all', async () => {
  const { stream, calls } = streamFixture();
  const { bot } = botFixture({ stream });
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: harnessFixture({
      onAsk: async (options) => {
        await options.onUpdate({ type: 'tool', name: 'bash', arguments: '{"command":"ls"}' });
        await options.onUpdate({ type: 'reasoning', text: 'thinking out loud' });
        await options.onUpdate({ type: 'status', text: '正在整理结果…' });
        await options.onUpdate({ type: 'text', text: 'partial answer' });
      },
    }),
    state: memoryState(),
    presentationLevel: 'minimal',
    logger: quietLogger,
  });
  await bridge.accept(message());
  assert.deepEqual(calls.updates, [], 'minimal must not rewrite the placeholder');
  assert.equal(calls.finish.length, 1);
  assert.equal(
    calls.finish[0].progressSummary ?? null,
    null,
    'minimal leaves no receipt: the answer is the only message',
  );
});

test('L2: standard paints one compact line and leaves a one-line receipt', async () => {
  const { stream, calls } = streamFixture();
  const { bot } = botFixture({ stream });
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: harnessFixture({
      onAsk: async (options) => {
        await options.onUpdate({ type: 'tool', name: 'bash', arguments: '{"command":"ls"}' });
        await options.onUpdate({ type: 'tool-result', callId: 'c1', toolName: 'bash', text: 'output' });
        await options.onUpdate({ type: 'reasoning', text: 'must stay hidden' });
        // The answer text is not previewed, but it marks the turn as "writing";
        // wait past the edit window so the second frame is actually sent.
        await new Promise((resolve) => setTimeout(resolve, 1_300));
        await options.onUpdate({ type: 'text', text: 'answer draft' });
      },
    }),
    state: memoryState(),
    presentationLevel: 'standard',
    logger: quietLogger,
  });
  await bridge.accept(message());
  assert.equal(calls.updates.length, 2, 'one update per window, not one per event');
  assert.match(calls.updates[0], /^⏳ 处理中 · \d+ 秒 · 1 步\n🔧 bash → ls$/);
  assert.match(calls.updates[1], /\n✍️ 正在整理回复$/u, 'the arrival of answer text switches the line');
  assert.match(calls.finish[0].progressSummary, /^✅ 完成 · \d+ 秒 · 1 步$/);
  assert.equal(calls.finish[0].format, 'markdown', 'the answer format is unchanged');
});

test('L3: a failed standard turn deletes the placeholder and sends the error', async () => {
  const { stream, calls } = streamFixture({ failMode: true });
  const { bot } = botFixture({ stream });
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: harnessFixture({
      onAsk: async (options) => {
        await options.onUpdate({ type: 'tool', name: 'bash' });
        throw new Error('the turn died');
      },
    }),
    state: memoryState(),
    logger: quietLogger,
  });
  await bridge.accept(message());
  assert.equal(calls.fail.length, 1);
  assert.equal(
    typeof calls.fail[0].progressSummary,
    'undefined',
    'a failure leaves no receipt; the error message is the terminal state',
  );
});

test('L4: full still opens the thinking stream and never adds a receipt', async () => {
  const seen = [];
  const { bot } = botFixture({ onOpen: (kind) => seen.push(kind) });
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: harnessFixture({
      onAsk: async (options) => {
        await options.onUpdate({ type: 'reasoning', text: 'Let me look first.' });
        await options.onUpdate({ type: 'tool', name: 'bash', arguments: 'ls' });
      },
    }),
    state: memoryState(),
    presentationLevel: 'full',
    logger: quietLogger,
  });
  await bridge.accept(message());
  assert.deepEqual(seen, ['thinking']);
});

test('L5: a legacy thinkingTraces=true still means the full rung', async () => {
  const seen = [];
  const { bot } = botFixture({ onOpen: (kind) => seen.push(kind) });
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: harnessFixture(),
    state: memoryState(),
    thinkingTraces: true,
    logger: quietLogger,
  });
  assert.equal(bridge.presentationLevel, 'full');
  await bridge.accept(message());
  assert.deepEqual(seen, ['thinking']);
});

test('L6: /display without a card answers with the three rungs', async () => {
  const { stream } = streamFixture();
  const { bot, texts } = botFixture({ stream });
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: harnessFixture(),
    state: memoryState(),
    logger: quietLogger,
    displayCard: null,
  });
  await bridge.accept(message({ content: '/display' }));
  assert.equal(texts.length, 1);
  assert.match(texts[0], /显示挡位：标准/u);
  assert.match(texts[0], /极简/u);
  assert.match(texts[0], /全面/u);
});

test('L7: /display <level> persists the new level and confirms it', async () => {
  const { stream } = streamFixture();
  const { bot, texts } = botFixture({ stream });
  const saved = [];
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: harnessFixture(),
    state: memoryState(),
    logger: quietLogger,
    onPresentationLevelChange: async (level) => { saved.push(level); },
  });
  await bridge.accept(message({ content: '/display 极简' }));
  assert.deepEqual(saved, ['minimal']);
  assert.equal(bridge.presentationLevel, 'minimal');
  assert.match(texts.at(-1), /显示挡位已设为「极简」/u);
});

test('L8: a failed save keeps the previous level and says so', async () => {
  const { stream } = streamFixture();
  const { bot, texts } = botFixture({ stream });
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: harnessFixture(),
    state: memoryState(),
    logger: quietLogger,
    presentationLevel: 'standard',
    onPresentationLevelChange: async () => { throw new Error('config write failed'); },
  });
  await bridge.accept(message({ content: '/display 全面' }));
  assert.equal(bridge.presentationLevel, 'standard', 'a failed write must not claim a new rung');
  assert.match(texts.at(-1), /显示挡位保存失败/u);
});

test('L9: an unknown word is a usage error, not a silent no-op', async () => {
  const { stream } = streamFixture();
  const { bot, texts } = botFixture({ stream });
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: harnessFixture(),
    state: memoryState(),
    logger: quietLogger,
  });
  await bridge.accept(message({ content: '/display loud' }));
  assert.match(texts.at(-1), /用法：\/display/u);
});

test('L10: the picker card switches in place and reports the stored level', async () => {
  const cards = [];
  const edits = [];
  const notices = [];
  const bot = {
    async sendText() { assert.fail('the card path must not send a text menu'); },
    async answerInteractionCallback(queryId, text) { notices.push(text); },
    async sendInteractionCard(_target, { text, markup }) {
      cards.push({ text, markup });
      return { providerMessageIds: ['701'] };
    },
    async editInteractionCard(_target, messageId, { text, markup }) {
      edits.push({ messageId, text, markup });
      return {};
    },
  };
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: harnessFixture(),
    state: memoryState(),
    logger: quietLogger,
    displayCard: new TelegramDisplayCard({ logger: quietLogger }),
    onPresentationLevelChange: async () => {},
  });
  await bridge.accept(message({ content: '/display' }));
  assert.equal(cards.length, 1);
  assert.match(cards[0].text, /当前：标准/u);
  const buttons = cards[0].markup.inline_keyboard.flat();
  assert.equal(buttons.length, 3);
  assert.match(buttons[1].text, /✓.*标准/u);

  const minimalPress = buttons[0].callback_data;
  await bridge.acceptCallback({
    conversationId: 'u1', senderId: 'u1', messageId: '701', kind: 'direct',
    data: minimalPress, replyTarget: { chatId: 42 },
  });
  assert.equal(bridge.presentationLevel, 'minimal');
  assert.equal(edits.length, 1, 'the picker repaints itself');
  assert.match(edits[0].text, /当前：极简/u);
  assert.match(edits[0].markup.inline_keyboard.flat()[0].text, /✓/u);
  assert.match(notices.at(-1), /极简/u);
});

// --- config store + controller -------------------------------------------

test('L11: the level is stored, reported and cleared back to the legacy field', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-display-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'config.json');
  const configStore = await new TelegramConfigStore(configPath).load();
  const runtimeRecords = [];
  const liveLevels = [];
  const controller = new TelegramController({
    credentials: {
      async resolve() { return { value: '123456789:token' }; },
      async set() {},
      async unset() {},
    },
    configStore,
    inspectToken: async () => ({ platformId: '123456789', name: 'Display Bot', username: 'display_bot' }),
    createRuntime: async ({ botId, config }) => {
      runtimeRecords.push({ botId, config: structuredClone(config) });
      return {
        status: { ready: true, connectionState: 'connected', harnessReachable: true, lastCheckedAt: 10 },
        async start() {},
        async stop() {},
        setPresentationLevel(level) { liveLevels.push(level); },
      };
    },
  });
  const bound = await controller.bindCredentials({ token: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456' });
  const botId = bound.bots[0].botId;
  assert.equal(bound.bots[0].presentationLevel, 'standard', 'a fresh bot starts compact');

  const restartsBefore = runtimeRecords.length;
  const full = await controller.setPresentationLevel(botId, 'full');
  assert.equal(full.bots[0].presentationLevel, 'full');
  assert.equal(configStore.get(botId).presentationLevel, 'full');
  // A display change never reconnects: a reconnect would abort every in-flight
  // turn in every chat, including the one that asked for the change.
  assert.equal(runtimeRecords.length, restartsBefore, 'the bot must not reconnect for a display change');
  assert.deepEqual(liveLevels, ['full'], 'the live runtime is switched in place');

  // An unknown value clamps to the default instead of poisoning the bot.
  const clamped = await controller.setPresentationLevel(botId, 'shout');
  assert.equal(clamped.bots[0].presentationLevel, 'standard');

  // A legacy explicit `thinkingTraces: true` still renders at the full rung.
  await controller.setThinkingTraces(botId, true);
  assert.equal(controller.status().bots.find((item) => item.botId === botId).presentationLevel, 'full');
  // Choosing a level clears the legacy field so the two cannot disagree.
  await controller.setPresentationLevel(botId, 'minimal');
  assert.equal(configStore.get(botId).thinkingTraces, undefined);
  assert.equal(configStore.get(botId).presentationLevel, 'minimal');
});

// --- runtime: the placeholder becomes the receipt -------------------------

test('L12: a finished standard turn edits the placeholder into its receipt', async () => {
  const calls = { sent: [], edited: [], deleted: [] };
  const client = new TelegramBotClient({
    api: {
      async sendMessage(payload) { calls.sent.push(payload); return { message_id: 501 }; },
      async editMessageText(payload) { calls.edited.push(payload); return true; },
      async deleteMessage(payload) { calls.deleted.push(payload); return true; },
      async sendChatAction() { return true; },
    },
    logger: quietLogger,
  });
  const stream = await client.openDeliveryStream({ chatId: 42 });
  assert.equal(stream.supportsProgressSummary, true);
  await stream.finish({ kind: 'text', text: 'answer', format: 'plain', progressSummary: '✅ 完成 · 9 秒 · 2 步' });
  assert.equal(calls.deleted.length, 0, 'the receipt replaces the placeholder');
  assert.equal(calls.edited.at(-1).text, '✅ 完成 · 9 秒 · 2 步');
  assert.equal(calls.sent.at(-1).text, 'answer');
});

test('L13: without a receipt the placeholder is deleted, exactly as before', async () => {
  const calls = { sent: [], edited: [], deleted: [] };
  const client = new TelegramBotClient({
    api: {
      async sendMessage(payload) { calls.sent.push(payload); return { message_id: 502 }; },
      async editMessageText(payload) { calls.edited.push(payload); return true; },
      async deleteMessage(payload) { calls.deleted.push(payload); return true; },
      async sendChatAction() { return true; },
    },
    logger: quietLogger,
  });
  const stream = await client.openDeliveryStream({ chatId: 42 });
  await stream.finish({ kind: 'text', text: 'answer', format: 'plain' });
  assert.equal(calls.deleted.length, 1);
  assert.equal(calls.edited.length, 0);
});

test('L14: a rejected receipt edit falls back to deleting the placeholder', async () => {
  const calls = { sent: [], edited: [], deleted: [] };
  const client = new TelegramBotClient({
    api: {
      async sendMessage(payload) { calls.sent.push(payload); return { message_id: 503 }; },
      async editMessageText(payload) {
        calls.edited.push(payload);
        throw new Error('message is not modified');
      },
      async deleteMessage(payload) { calls.deleted.push(payload); return true; },
      async sendChatAction() { return true; },
    },
    logger: quietLogger,
  });
  const stream = await client.openDeliveryStream({ chatId: 42 });
  await stream.finish({ kind: 'text', text: 'answer', format: 'plain', progressSummary: '✅ 完成 · 1 秒' });
  assert.equal(calls.deleted.length, 1, 'a stale placeholder must not outlive the turn');
  assert.equal(calls.sent.at(-1).text, 'answer');
});

// --- the picker as the runtime actually ships it ---------------------------

test('L15: a real runtime answers /display with the picker card, not just text', async (t) => {
  // Regression for the card being constructed in tests but never wired into the
  // production bridge: `/display` used to fall through to the plain text menu.
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-display-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = await new TelegramStateStore(join(directory, 'state.json')).load();
  const sent = [];
  const cards = [];
  const fakeApi = {
    getMe: async () => ({ id: 123456789, is_bot: true, username: 'HarnessBot' }),
    getWebhookInfo: async () => ({ url: '' }),
    deleteMyCommands: async () => true,
    setMyCommands: async () => true,
    setChatMenuButton: async () => true,
    setMessageReaction: async () => true,
    getUpdates: async ({ offset, timeout, signal } = {}) => {
      if (timeout === 0) return [];
      if (offset <= 200) {
        return [{
          update_id: 200,
          message: {
            message_id: 200,
            date: 1_700_000_000,
            chat: { id: 42, type: 'private' },
            from: { id: 42, is_bot: false, first_name: 'Wings' },
            text: '/display',
          },
        }];
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    },
    sendMessage: async (request) => {
      sent.push(request.text);
      if (request.replyMarkup) {
        cards.push({ text: request.text, markup: request.replyMarkup });
        return { message_id: 777 };
      }
      return { message_id: 700 + sent.length };
    },
    editMessageText: async () => true,
  };
  const runtime = new TelegramRuntime({
    config: { botId: 'telegram_display', platformId: '123456789', username: 'HarnessBot' },
    token: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456',
    state,
    createApi: () => fakeApi,
    logger: { error() {}, warn() {}, info() {}, debug() {} },
    harness: { ensureRunning: async () => true },
  });
  await runtime.start();
  try {
    const deadline = Date.now() + 3_000;
    while (cards.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(cards.length, 1, 'the runtime must send the picker card');
    const buttons = cards[0].markup.inline_keyboard.flat();
    assert.equal(buttons.length, 3);
    assert.ok(buttons.every((button) => /^d1\|/u.test(button.callback_data)));
    assert.ok(sent.every((text) => !/发送 \/display 极简/u.test(text)), 'the text fallback must not also fire');
  } finally {
    await runtime.stop();
  }
});

test('L16: every press keeps the picker alive (current rung, then another rung)', async () => {
  const bot = {
    async sendText() { assert.fail('card path only'); },
    async answerInteractionCallback() {},
    async sendInteractionCard() { return { providerMessageIds: ['801'] }; },
    async editInteractionCard() { return {}; },
  };
  const card = new TelegramDisplayCard({ logger: quietLogger });
  const presses = [];
  const handle = (callback, current) => card.handlePress(callback, {
    bot,
    answer: (text) => presses.push(text),
    conversationKey: 'direct:u1',
    current,
    apply: async (level) => level,
  });
  assert.equal(await card.present({
    bot, target: { chatId: 42 }, conversationKey: 'direct:u1', current: 'standard',
  }), true);
  const nonce = card.registry.activeFor('direct:u1')?.nonce;
  assert.ok(nonce, 'the card issued a nonce');

  // A tap on the rung already in use must not kill the card.
  await handle({ data: `d1|${nonce}|standard` }, 'standard');
  const live = card.registry.activeFor('direct:u1');
  assert.ok(live, 'the picker stayed live after tapping the current rung');

  // A real switch also hands the picker a new identity, so a second tap works.
  await handle({ data: `d1|${live.nonce}|full` }, 'standard');
  const afterSwitch = card.registry.activeFor('direct:u1');
  assert.ok(afterSwitch, 'the picker stayed live after a successful switch');
  assert.notEqual(afterSwitch.nonce, live.nonce, 'the used nonce is retired');
  assert.match(presses.at(-1), /显示挡位已设为「全面」/u);
});

test('L17: a real runtime press saves the level, repaints the picker and confirms', async (t) => {
  // End-to-end over the two updates a reader actually produces: the command, then
  // the button press. This is the regression for "save reconnects and the
  // confirmation is lost" and for "the picker dies after one press".
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-display-press-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = await new TelegramStateStore(join(directory, 'state.json')).load();
  const queue = [{
    update_id: 300,
    message: {
      message_id: 300,
      date: 1_700_000_000,
      chat: { id: 42, type: 'private' },
      from: { id: 42, is_bot: false, first_name: 'Wings' },
      text: '/display',
    },
  }];
  const cards = [];
  const edits = [];
  const acks = [];
  const sent = [];
  const saved = [];
  let nextUpdate = 300;
  const fakeApi = {
    getMe: async () => ({ id: 123456789, is_bot: true, username: 'HarnessBot' }),
    getWebhookInfo: async () => ({ url: '' }),
    deleteMyCommands: async () => true,
    setMyCommands: async () => true,
    setChatMenuButton: async () => true,
    setMessageReaction: async () => true,
    answerCallbackQuery: async (payload) => { acks.push(payload); return true; },
    getUpdates: async ({ offset, timeout, signal } = {}) => {
      if (timeout === 0) return [];
      if (queue.length > 0) return [queue.shift()];
      // The poll loop runs ahead of the turn, so wait for the card instead of
      // racing it: the press is only meaningful once the picker is on screen.
      while (cards.length === 0 && !signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (nextUpdate === 300) {
        nextUpdate = 301;
        const button = cards[0].markup.inline_keyboard[0][0];
        return [{
          update_id: 301,
          callback_query: {
            id: 'cb-display',
            from: { id: 42, is_bot: false, first_name: 'Wings' },
            message: {
              message_id: 777,
              date: 1_700_000_001,
              chat: { id: 42, type: 'private' },
            },
            chat_instance: 'ci',
            data: button.callback_data,
          },
        }];
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    },
    sendMessage: async (request) => {
      sent.push(request.text);
      if (request.replyMarkup) {
        cards.push({ text: request.text, markup: request.replyMarkup });
        return { message_id: 777 };
      }
      return { message_id: 800 + sent.length };
    },
    editMessageText: async (request) => {
      edits.push(request);
      return true;
    },
  };
  const runtime = new TelegramRuntime({
    config: { botId: 'telegram_display_press', platformId: '123456789', username: 'HarnessBot' },
    token: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456',
    state,
    createApi: () => fakeApi,
    logger: { error() {}, warn() {}, info() {}, debug() {} },
    harness: { ensureRunning: async () => true },
    onPresentationLevelChange: async (level) => { saved.push(level); },
  });
  await runtime.start();
  try {
    const deadline = Date.now() + 4_000;
    while (edits.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(saved, ['minimal'], 'the press persisted the chosen rung through the channel hook');
    assert.equal(edits.length, 1, 'the picker repainted in place');
    assert.match(edits[0].text, /当前：极简/u);
    const repainted = edits[0].replyMarkup.inline_keyboard.flat();
    assert.equal(repainted.length, 3);
    assert.ok(repainted.every((button) => /^d1\|/u.test(button.callback_data)));
    assert.ok(repainted.some((button) => /✓/u.test(button.text)), 'the new rung is marked');
    assert.ok(acks.some((ack) => /极简/u.test(ack.text ?? '')), 'the press is acknowledged with the new rung');
    assert.equal(runtime.status.ready, true, 'the bot stayed connected: no reconnect for a display change');
  } finally {
    await runtime.stop();
  }
});

test('L18: the /status card carries the current rung and a picker entry', async (t) => {
  const previous = setImHostLanguage('zh');
  t.after(() => setImHostLanguage(previous));
  const cards = [];
  const bot = {
    async sendText() {},
    async sendTyping() {},
    async sendInteractionCard(_target, card) {
      cards.push(card);
      return { providerMessageIds: ['321'] };
    },
  };
  const bridge = new TelegramHarnessBridge({
    bot,
    state: { hasSeen: () => false, markSeen: async () => {}, sessionFor: () => null },
    harness: {
      ensureRunning: async () => true,
      currentWorkspace: () => '/home/wings/e2e',
      currentConversationWorkspace: () => '/home/wings/e2e',
      status: async () => ({ connected: true }),
      hostDescribe: async () => ({ version: '0.2.2' }),
    },
    presentationLevel: 'full',
    logger: { warn() {}, error() {} },
  });
  await bridge.accept({
    messageId: '1', senderId: '42', kind: 'direct', conversationId: '42',
    content: '/status', addressed: true, replyTarget: { chatId: 42 },
  });
  assert.equal(cards.length, 1, 'the status card was sent');
  assert.match(cards[0].text, /显示挡位：全面/u);
  const displayButton = cards[0].markup.inline_keyboard.flat()
    .find((button) => /显示挡位/u.test(button.text));
  assert.ok(displayButton, 'the picker entry must be on the card');

  // Pressing it must open the picker, not answer "could not open".
  const notices = [];
  bot.answerInteractionCallback = async (_id, text) => { notices.push(text); };
  bot.editInteractionCard = async () => ({});
  await bridge.acceptCallback({
    conversationId: '42', senderId: '42', messageId: '321', kind: 'direct',
    data: displayButton.callback_data, replyTarget: { chatId: 42 },
  });
  assert.equal(cards.length, 2, 'the display picker was sent');
  assert.match(cards[1].text, /🎛 显示挡位/u);
  assert.ok(!notices.some((text) => /无法打开/u.test(text ?? '')), notices.join('|'));
});

test('L19: a failed step turns the closing receipt into a warning', async () => {
  const { stream, calls } = streamFixture();
  const { bot } = botFixture({ stream });
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: harnessFixture({
      onAsk: async (options) => {
        await options.onUpdate({ type: 'tool', name: 'bash', arguments: '{"command":"false"}', callId: 'c1' });
        // The shape production sends for a failed tool.
        await options.onUpdate({ type: 'status', toolName: 'bash', callId: 'c1', error: 'exit code 1', text: '正在整理结果…' });
        await options.onUpdate({ type: 'text', text: 'the answer' });
      },
    }),
    state: memoryState(),
    presentationLevel: 'standard',
    logger: quietLogger,
  });
  await bridge.accept(message());
  assert.match(calls.updates[0], /^⏳ 处理中 · \d+ 秒 · 1 步\n🔧 bash → false$/u);
  assert.match(calls.finish[0].progressSummary, /^⚠️ 完成 · \d+ 秒 · 1 步 · 1 步失败$/u);
});

test('L20: /display in a group answers into the same group chat', async (t) => {
  const previous = setImHostLanguage('zh');
  t.after(() => setImHostLanguage(previous));
  const cards = [];
  const bot = {
    async sendText() {},
    async sendTyping() {},
    async sendInteractionCard(target, card) {
      cards.push({ target, card });
      return { providerMessageIds: ['901'] };
    },
  };
  const bridge = new TelegramHarnessBridge({
    bot,
    state: { hasSeen: () => false, markSeen: async () => {}, sessionFor: () => null },
    harness: { ensureRunning: async () => true },
    presentationLevel: 'standard',
    logger: { warn() {}, error() {} },
  });
  await bridge.accept({
    messageId: 'g1', senderId: '77', kind: 'group', conversationId: '-1001',
    content: '/display', addressed: true,
    replyTarget: { chatId: -1001, chatType: 'supergroup', messageThreadId: 5 },
  });
  assert.equal(cards.length, 1, 'the picker goes to the group, not a private chat');
  assert.equal(cards[0].target.chatId, -1001);
  assert.equal(cards[0].target.messageThreadId, 5);
  assert.match(cards[0].card.text, /🎛 显示挡位/u);
});

test('L21: refreshing the /status card keeps the display line', async (t) => {
  const previous = setImHostLanguage('zh');
  t.after(() => setImHostLanguage(previous));
  const cards = [];
  const edits = [];
  const bot = {
    async sendText() {},
    async sendTyping() {},
    async sendInteractionCard(_target, card) { cards.push(card); return { providerMessageIds: ['411'] }; },
    async editInteractionCard(_target, messageId, card) { edits.push(card); return {}; },
    async answerInteractionCallback() {},
  };
  const bridge = new TelegramHarnessBridge({
    bot,
    state: { hasSeen: () => false, markSeen: async () => {}, sessionFor: () => null },
    harness: {
      ensureRunning: async () => true,
      currentWorkspace: () => '/home/wings/e2e',
      currentConversationWorkspace: () => '/home/wings/e2e',
      status: async () => ({ connected: true }),
      hostDescribe: async () => ({ version: '0.2.2' }),
    },
    presentationLevel: 'minimal',
    logger: { warn() {}, error() {} },
  });
  await bridge.accept({
    messageId: '1', senderId: '42', kind: 'direct', conversationId: '42',
    content: '/status', addressed: true, replyTarget: { chatId: 42 },
  });
  const refresh = cards[0].markup.inline_keyboard.flat()
    .find((button) => /刷新|Refresh/u.test(button.text));
  assert.ok(refresh, 'the card has a refresh button');
  await bridge.acceptCallback({
    conversationId: '42', senderId: '42', messageId: '411', kind: 'direct',
    data: refresh.callback_data, replyTarget: { chatId: 42 },
  });
  assert.equal(edits.length, 1, 'the card repainted in place');
  assert.match(edits[0].text, /显示挡位：极简/u, 'the refreshed card still shows the level');
});

test('L22: /start greets with the launcher card instead of prompting the model', async (t) => {
  const previous = setImHostLanguage('zh');
  t.after(() => setImHostLanguage(previous));
  const cards = [];
  let prompted = 0;
  const bot = {
    async sendText() {},
    async sendTyping() {},
    async sendInteractionCard(_target, card) { cards.push(card); return { providerMessageIds: ['611'] }; },
  };
  const bridge = new TelegramHarnessBridge({
    bot,
    state: { hasSeen: () => false, markSeen: async () => {}, sessionFor: () => null },
    harness: {
      ensureRunning: async () => true,
      createSession: async () => 's',
      ask: async () => { prompted += 1; return 'should not happen'; },
    },
    presentationLevel: 'standard',
    logger: { warn() {}, error() {} },
  });
  await bridge.accept({
    messageId: 's1', senderId: '42', kind: 'direct', conversationId: '42',
    content: '/start', addressed: true, replyTarget: { chatId: 42 },
  });
  assert.equal(prompted, 0, '/start must never reach the model');
  assert.equal(cards.length, 1, 'the greeting card was sent');
  assert.match(cards[0].text, /已连接 DeepSeek Harness/u);
  assert.match(cards[0].text, /当前过程显示：标准/u);
});

test('L23: a running turn carries a ⏹ button, and only its sender can press it', async (t) => {
  const previous = setImHostLanguage('zh');
  t.after(() => setImHostLanguage(previous));
  const sent = [];
  const acks = [];
  const { stream } = streamFixture();
  const bot = {
    async sendText(_target, text) { sent.push(text); },
    async sendTyping() {},
    async sendInteractionCard() { return { providerMessageIds: ['1'] }; },
    async answerInteractionCallback(_id, text) { acks.push(text); },
    async openDeliveryStream(target) {
      stopToken = target.stopToken ?? null;
      sent.push(`placeholder:${stopToken ? 'stop' : 'plain'}`);
      return stream;
    },
  };
  let release = () => {};
  let stopToken = null;
  const stopCalls = [];
  // The turn must be bound to a Session, otherwise `/stop` answers "nothing is
  // running" and never reaches the harness.
  const state = memoryState();
  await state.setSession('direct:u1', 'session-stop');
  const harness = harnessFixture({
    onAsk: async (options) => {
      await options.onUpdate({ type: 'tool', name: 'bash', arguments: '{"command":"sleep 60"}' });
      await new Promise((resolve) => { release = resolve; });
    },
  });
  // The ⏹ path reaches `session.stopActiveTurn(control, …)`: without a bound
  // session this fixture would fall out at `boundSession` and the "missing
  // control" regression would stay invisible. The stub session delegates `ask`
  // so the turn itself still runs through the fixture above.
  harness.workspaceSession = () => ({
    async sessionExists() { return true; },
    async stopActiveTurn(control) {
      stopCalls.push(control);
      release();
      return true;
    },
    // The harness-level fixture is `ask(sessionId, prompt, options)`; the session
    // one is `ask(prompt, options)`.
    ask: (prompt, options) => harness.ask('session-stop', prompt, options),
  });
  const bridge = new TelegramHarnessBridge({
    bot,
    state,
    presentationLevel: 'standard',
    logger: quietLogger,
    harness,
  });
  const turn = bridge.accept(message({ messageId: 'm-stop', content: 'run a long task' }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(sent.some((line) => line === 'placeholder:stop'), 'the placeholder asks for the button');

  assert.ok(stopToken, 'a stop token was issued for the turn');

  // A stranger tapping it changes nothing.
  await bridge.acceptCallback({
    conversationId: 'u1', senderId: 'other', messageId: '1', kind: 'direct',
    data: `st|${stopToken}`, replyTarget: { chatId: 42 },
  });
  assert.match(acks.at(-1) ?? '', /只有发起/u);

  // The sender's press stops the turn.
  await bridge.acceptCallback({
    conversationId: 'u1', senderId: 'u1', messageId: '1', kind: 'direct',
    data: `st|${stopToken}`, replyTarget: { chatId: 42 },
  });
  assert.match(acks.at(-1) ?? '', /已请求停止/u);
  assert.equal(stopCalls.length, 1, 'the harness was actually asked to stop the turn');
  assert.deepEqual(stopCalls[0], { owner: bridge, key: 'direct:u1' }, 'with the control handle the typed /stop passes');
  release();
  await turn.catch(() => {});
});

test('L24: a ⏹ press with nothing to stop says so in the chat', async (t) => {
  const previous = setImHostLanguage('zh');
  t.after(() => setImHostLanguage(previous));
  const sent = [];
  const acks = [];
  const { stream } = streamFixture();
  let stopToken = null;
  let release = () => {};
  const state = memoryState();
  await state.setSession('direct:u1', 'session-stop');
  const harness = harnessFixture({
    onAsk: async (options) => {
      await options.onUpdate({ type: 'tool', name: 'bash', arguments: '{"command":"sleep 60"}' });
      await new Promise((resolve) => { release = resolve; });
    },
  });
  // The harness reports "nothing was running" — the reader must see that, because
  // the toast already claimed a stop was requested.
  harness.workspaceSession = () => ({
    async sessionExists() { return true; },
    async stopActiveTurn() { return false; },
    ask: (prompt, options) => harness.ask('session-stop', prompt, options),
  });
  const bridge = new TelegramHarnessBridge({
    bot: {
      async sendText(_target, text) { sent.push(text); },
      async sendTyping() {},
      async answerInteractionCallback(_id, text) { acks.push(text); },
      async openDeliveryStream(target) { stopToken = target.stopToken ?? null; return stream; },
    },
    state,
    presentationLevel: 'standard',
    logger: quietLogger,
    harness,
  });
  const turn = bridge.accept(message({ messageId: 'm-nostop', content: 'long task' }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(stopToken, 'a stop token was issued');
  await bridge.acceptCallback({
    conversationId: 'u1', senderId: 'u1', messageId: '1', kind: 'direct',
    data: `st|${stopToken}`, replyTarget: { chatId: 42 },
  });
  assert.match(acks.at(-1) ?? '', /已请求停止/u);
  assert.ok(sent.some((text) => /没有正在运行的任务/u.test(text)),
    `the chat must correct the toast, saw ${JSON.stringify(sent)}`);
  release();
  await turn.catch(() => {});
});

test('L25: the greeting\'s 菜单 entry opens the hub instead of failing', async (t) => {
  const previous = setImHostLanguage('zh');
  t.after(() => setImHostLanguage(previous));
  const cards = [];
  const acks = [];
  const bot = {
    async sendText() {},
    async sendTyping() {},
    async answerInteractionCallback(_id, text) { acks.push(text); },
    async sendInteractionCard(_target, card) { cards.push(card); return { providerMessageIds: [String(600 + cards.length)] }; },
  };
  const bridge = new TelegramHarnessBridge({
    bot,
    state: { hasSeen: () => false, markSeen: async () => {}, sessionFor: () => null },
    harness: {
      ensureRunning: async () => true,
      currentWorkspace: () => '/home/wings/e2e',
      currentConversationWorkspace: () => '/home/wings/e2e',
      status: async () => ({ connected: true }),
      hostDescribe: async () => ({ version: '0.2.2' }),
    },
    presentationLevel: 'standard',
    logger: { warn() {}, error() {} },
  });
  await bridge.accept({
    messageId: 'g1', senderId: '42', kind: 'direct', conversationId: '42',
    content: '/start', addressed: true, replyTarget: { chatId: 42 },
  });
  assert.equal(cards.length, 1, 'greeting first');
  const menuButton = cards[0].markup.inline_keyboard.flat().find((button) => /菜单/u.test(button.text));
  assert.ok(menuButton, 'the greeting offers the menu');
  await bridge.acceptCallback({
    conversationId: '42', senderId: '42', messageId: '600', kind: 'direct',
    data: menuButton.callback_data, replyTarget: { chatId: 42 },
  });
  assert.equal(cards.length, 2, 'the hub card was sent');
  assert.ok(!acks.some((text) => /无法打开/u.test(text ?? '')), acks.join('|'));
});
