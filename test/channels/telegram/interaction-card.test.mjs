import assert from 'node:assert/strict';
import test from 'node:test';

import { TextHarnessBridge } from '../../../src/channels/shared/text-harness-bridge.mjs';
import { TelegramApi } from '../../../src/channels/telegram/telegram-api.mjs';
import {
  TELEGRAM_INTERACTION_CARD,
  parseTelegramCardCallback,
} from '../../../src/channels/telegram/telegram-bridge.mjs';
import { normalizeTelegramCallback } from '../../../src/channels/telegram/telegram-runtime.mjs';

const TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Capture every Bot API call so payload shapes can be asserted directly. */
function apiRecorder({ responses = {} } = {}) {
  const calls = [];
  const api = new TelegramApi({
    token: TOKEN,
    fetchImpl: async (url, init) => {
      const method = url.pathname.split('/').at(-1);
      calls.push({ method, payload: JSON.parse(init.body) });
      const body = responses[method] ?? { ok: true, result: { message_id: 700 } };
      return jsonResponse(body);
    },
  });
  return { api, calls };
}

function stateFixture() {
  const sessions = new Map();
  const seen = new Set();
  return {
    state: {
      sessionFor: (key) => sessions.get(key) ?? null,
      async setSession(key, value) { sessions.set(key, value); return true; },
      async clearSession(key) { sessions.delete(key); },
      hasSeen: (id) => seen.has(id),
      async markSeen(id) { seen.add(id); },
    },
  };
}

function message(messageId, content, overrides = {}) {
  return {
    messageId,
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

function questionInteraction({
  id = 'question-one',
  sessionId = 'session-one',
  questions = [{
    id: 'pick',
    question: '选一个颜色',
    options: [{ label: '红色' }, { label: '绿色' }],
  }],
  respond = async () => ({ accepted: true }),
} = {}) {
  return {
    kind: 'question',
    interactionId: id,
    rpcId: id,
    sessionId,
    payload: { type: 'question/requested', sessionId, questions },
    respond,
  };
}

function callback(overrides = {}) {
  return {
    messageId: 'update-20',
    callbackQueryId: 'cb-1',
    providerMessageId: 700,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    data: 'q|0|1',
    addressed: true,
    replyTarget: { chatId: 42 },
    ...overrides,
  };
}

async function eventually(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition was not met before timeout');
}

/** Build a bridge whose harness answers one question through the given callback. */
function bridgeFixture({ questions, respond, cardResult } = {}) {
  const { state } = stateFixture();
  // The bridge forwards its own signal into ask(); the harness needs one to park on.
  const controller = new AbortController();
  const sent = [];
  const cards = [];
  const notices = [];
  const edits = [];
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'telegram', label: 'Telegram', reactions: {} },
    state,
    signal: controller.signal,
    interactionCard: TELEGRAM_INTERACTION_CARD,
    bot: {
      sendText: async (_target, text) => { sent.push(text); },
      sendInteractionCard: async (_target, { text, markup }) => {
        if (cardResult === 'fail') throw new Error('telegram refused the keyboard');
        cards.push({ text, markup });
        return { providerMessageIds: ['700'] };
      },
      updateInteractionCard: async (_target, messageId, { markup }) => {
        edits.push({ messageId, markup });
      },
      answerInteractionCallback: async (queryId, text) => {
        notices.push({ queryId, text });
      },
    },
    harness: {
      sessionExists: async () => false,
      createSession: async () => 'session-one',
      ask: async (sessionId, _text, options) => {
        await options.onInteraction(questionInteraction({
          sessionId,
          ...(questions ? { questions } : {}),
          ...(respond ? { respond } : {}),
        }));
        await new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
        });
      },
    },
    logger: { warn() {}, error() {} },
  });
  return { bridge, controller, sent, cards, notices, edits };
}

test('Telegram card callback payload round-trips and rejects foreign data', () => {
  assert.deepEqual(parseTelegramCardCallback('q|0|2'), { questionIndex: 0, optionIndex: 2 });
  assert.deepEqual(parseTelegramCardCallback('q|12|7'), { questionIndex: 12, optionIndex: 7 });
  for (const invalid of ['', 'q', 'q|0', 'q|0|', 'x|0|0', 'q|a|b', 'q|0|2|3', null, undefined, 7]) {
    assert.equal(parseTelegramCardCallback(invalid), null, `rejected ${String(invalid)}`);
  }
});

test('Telegram card renderer encodes one button per option within the byte budget', () => {
  const question = {
    id: 'pick',
    question: '选一个颜色',
    options: [{ label: '红色', description: '像蝴蝶结' }, { label: '绿色' }],
  };
  const card = TELEGRAM_INTERACTION_CARD.render(question, { questionIndex: 1, total: 2 });
  assert.ok(card, 'expected a card for a single-choice question with options');
  assert.equal(card.markup.inline_keyboard.length, 2);
  assert.deepEqual(card.markup.inline_keyboard[0], [
    { text: '红色', callback_data: 'q|1|0' },
  ]);
  assert.deepEqual(card.markup.inline_keyboard[1], [
    { text: '绿色', callback_data: 'q|1|1' },
  ]);
  // The numbered list survives so a refused keyboard can still be answered by text.
  assert.match(card.text, /1\. 红色/);
  assert.match(card.text, /选一个颜色/);
  for (const row of card.markup.inline_keyboard) {
    for (const button of row) {
      assert.ok(Buffer.byteLength(button.callback_data, 'utf8') <= 64);
    }
  }
});

test('Telegram card renderer declines shapes a keyboard cannot express', () => {
  const base = { id: 'pick', question: '问题' };
  assert.equal(TELEGRAM_INTERACTION_CARD.render({ ...base }, {}), null, 'no options');
  assert.equal(
    TELEGRAM_INTERACTION_CARD.render({ ...base, options: [] }, {}),
    null,
    'empty options',
  );
  assert.equal(
    TELEGRAM_INTERACTION_CARD.render({
      ...base,
      multiSelect: true,
      options: [{ label: '红色' }, { label: '绿色' }],
    }, {}),
    null,
    'multi-select keeps the text flow',
  );
  assert.equal(
    TELEGRAM_INTERACTION_CARD.render({
      ...base,
      options: Array.from({ length: 9 }, (_, index) => ({ label: `选项${index}` })),
    }, {}),
    null,
    'too many options',
  );
  assert.equal(
    TELEGRAM_INTERACTION_CARD.render({ ...base, options: [{ label: '   ' }] }, {}),
    null,
    'unusable label',
  );
  assert.equal(
    TELEGRAM_INTERACTION_CARD.render({ ...base, options: [{ description: 'no label' }] }, {}),
    null,
    'missing label',
  );
});

test('Telegram callback normalization reuses the message conversation key', () => {
  const normalized = normalizeTelegramCallback({
    update_id: 20,
    callback_query: {
      id: 'cb-1',
      from: { id: 7, is_bot: false, first_name: 'Wings' },
      message: {
        message_id: 700,
        chat: { id: 42, type: 'private' },
      },
      data: 'q|0|1',
    },
  }, { botId: 123456789 });
  assert.ok(normalized);
  assert.equal(normalized.callbackQueryId, 'cb-1');
  assert.equal(normalized.providerMessageId, 700);
  assert.equal(normalized.senderId, '7');
  assert.equal(normalized.conversationId, '42');
  assert.equal(normalized.kind, 'direct');
  assert.equal(normalized.data, 'q|0|1');
  assert.equal(normalized.messageId, '20');
  assert.equal(normalized.addressed, true);

  assert.equal(normalizeTelegramCallback({ update_id: 20 }, {}), null);
  assert.equal(normalizeTelegramCallback({
    update_id: 20,
    callback_query: { from: { id: 7 }, message: { message_id: 700 } },
  }, {}), null, 'missing callback id and chat');
});

test('Telegram callback normalization keeps topic threads apart', () => {
  const normalized = normalizeTelegramCallback({
    update_id: 21,
    callback_query: {
      id: 'cb-2',
      from: { id: 7, is_bot: false },
      message: {
        message_id: 701,
        message_thread_id: 55,
        chat: { id: 42, type: 'supergroup' },
      },
      data: 'q|0|0',
    },
  }, {});
  assert.equal(normalized.conversationId, '42:55');
  assert.equal(normalized.kind, 'group');
});

test('Telegram API accepts an inline keyboard and an empty one that removes it', async () => {
  const { api, calls } = apiRecorder();
  await api.sendMessage({
    chatId: 42,
    text: '选一个',
    replyMarkup: { inline_keyboard: [[{ text: '红色', callback_data: 'q|0|0' }]] },
  });
  assert.deepEqual(calls[0].payload.reply_markup, {
    inline_keyboard: [[{ text: '红色', callback_data: 'q|0|0' }]],
  });

  await api.editMessageReplyMarkup({ chatId: 42, messageId: 700, replyMarkup: { inline_keyboard: [] } });
  assert.equal(calls[1].method, 'editMessageReplyMarkup');
  assert.deepEqual(calls[1].payload.reply_markup, { inline_keyboard: [] });

  // Omitting the markup must not silently clear an existing keyboard.
  await api.sendMessage({ chatId: 42, text: '普通消息' });
  assert.equal('reply_markup' in calls[2].payload, false);
});

test('Telegram API refuses an oversized or malformed keyboard before dispatch', async () => {
  const { api, calls } = apiRecorder();
  await assert.rejects(
    () => api.sendMessage({
      chatId: 42,
      text: 'x',
      replyMarkup: { inline_keyboard: [[{ text: 'a', callback_data: 'x'.repeat(65) }]] },
    }),
    /at most 64 bytes/u,
  );
  await assert.rejects(
    () => api.sendMessage({ chatId: 42, text: 'x', replyMarkup: { inline_keyboard: [[]] } }),
    /non-empty arrays/u,
  );
  await assert.rejects(
    () => api.sendMessage({ chatId: 42, text: 'x', replyMarkup: { inline_keyboard: [[{ text: 'a' }]] } }),
    /require text and callback_data/u,
  );
  await assert.rejects(
    () => api.sendMessage({ chatId: 42, text: 'x', replyMarkup: {} }),
    /requires inline_keyboard/u,
  );
  assert.equal(calls.length, 0, 'no rejected keyboard may reach the network');
});

test('Telegram API acknowledges a press and reports a missing query id', async () => {
  const { api, calls } = apiRecorder();
  await api.answerCallbackQuery({ callbackQueryId: 'cb-1', text: '已选择' });
  assert.equal(calls[0].method, 'answerCallbackQuery');
  assert.deepEqual(calls[0].payload, { callback_query_id: 'cb-1', text: '已选择' });
  await assert.rejects(() => api.answerCallbackQuery({}), /callback query id is required/u);
});

test('a card press submits the pressed label through the shared answer path', async () => {
  const answered = [];
  const { bridge, controller, cards, notices, edits } = bridgeFixture({
    respond: async (result) => { answered.push(result); return { accepted: true }; },
  });
  const processing = bridge.accept(message('m-1', '开始提问'));
  await eventually(() => cards.length === 1);

  await bridge.acceptCallback(callback());
  await eventually(() => answered.length === 1);

  assert.equal(answered[0].ok, true);
  assert.deepEqual(answered[0].value.answer.answers, [
    { id: 'pick', selected: ['绿色'] },
  ]);
  assert.equal(answered[0].value.sessionId, 'session-one');
  // The press is acknowledged and its keyboard retired so it cannot replay.
  assert.equal(notices.length, 1);
  assert.equal(notices[0].queryId, 'cb-1');
  assert.match(notices[0].text, /绿色/);
  assert.deepEqual(edits, [{ messageId: '700', markup: { inline_keyboard: [] } }]);

  controller.abort(new DOMException('test finished', 'AbortError'));
  await processing.catch(() => {});
});

test('a card press from another user is refused without answering', async () => {
  const answered = [];
  const { bridge, controller, cards, notices, edits } = bridgeFixture({
    respond: async (result) => { answered.push(result); return { accepted: true }; },
  });
  const processing = bridge.accept(message('m-1', '开始提问'));
  await eventually(() => cards.length === 1);

  await bridge.acceptCallback(callback({ senderId: 'actor-b' }));
  assert.equal(answered.length, 0, 'a stranger must not answer');
  assert.equal(notices.length, 1);
  assert.equal(edits.length, 0, 'the keyboard stays for the original actor');

  controller.abort(new DOMException('test finished', 'AbortError'));
  await processing.catch(() => {});
});

test('a stale keyboard cannot answer the question now on screen', async () => {
  const answered = [];
  const { bridge, controller, cards, notices } = bridgeFixture({
    respond: async (result) => { answered.push(result); return { accepted: true }; },
  });
  const processing = bridge.accept(message('m-1', '开始提问'));
  await eventually(() => cards.length === 1);

  // The card on screen carries question index 0; replay an index-3 payload.
  await bridge.acceptCallback(callback({ data: 'q|3|0' }));
  assert.equal(answered.length, 0);
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /失效/);

  await bridge.acceptCallback(callback({ data: 'not-ours' }));
  assert.equal(answered.length, 0, 'foreign payloads never answer');
  assert.equal(notices.length, 2);

  controller.abort(new DOMException('test finished', 'AbortError'));
  await processing.catch(() => {});
});

test('a multi-select question keeps the text flow instead of a keyboard', async () => {
  const answered = [];
  const { bridge, controller, cards, sent, notices } = bridgeFixture({
    questions: [{
      id: 'pick',
      question: '选几个颜色',
      multiSelect: true,
      options: [{ label: '红色' }, { label: '绿色' }],
    }],
    respond: async (result) => { answered.push(result); return { accepted: true }; },
  });
  const processing = bridge.accept(message('m-1', '开始提问'));
  await eventually(() => sent.length === 1 || cards.length === 1);

  assert.equal(cards.length, 0, 'no keyboard for multi-select');
  assert.equal(sent.length, 1, 'the text flow still asks the question');
  assert.match(sent[0], /多选用逗号分隔/);

  await bridge.acceptCallback(callback());
  assert.equal(answered.length, 0);
  assert.match(notices[0].text, /多选/);

  controller.abort(new DOMException('test finished', 'AbortError'));
  await processing.catch(() => {});
});

test('a press with no pending question is acknowledged without a submission', async () => {
  const { bridge, controller, notices } = bridgeFixture({});
  await bridge.acceptCallback(callback());
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /已处理/);
});

test('a refused keyboard degrades to the plain-text question', async () => {
  const answered = [];
  const { bridge, controller, cards, sent } = bridgeFixture({
    cardResult: 'fail',
    respond: async (result) => { answered.push(result); return { accepted: true }; },
  });
  const processing = bridge.accept(message('m-1', '开始提问'));
  await eventually(() => sent.length === 1);

  assert.equal(cards.length, 0);
  assert.match(sent[0], /选一个颜色/);
  assert.match(sent[0], /1\. 红色/, 'the numbered list is the fallback answer path');

  // The text reply still completes the interaction.
  await bridge.accept(message('m-2', '2'));
  await eventually(() => answered.length === 1);
  assert.deepEqual(answered[0].value.answer.answers, [
    { id: 'pick', selected: ['绿色'] },
  ]);

  controller.abort(new DOMException('test finished', 'AbortError'));
  await processing.catch(() => {});
});
