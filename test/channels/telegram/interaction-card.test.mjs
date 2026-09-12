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
    addressed: true,
    replyTarget: { chatId: 42 },
    ...overrides,
  };
}

/** The payload a real Telegram client would send back for one delivered button. */
function pressData(cards, optionIndex = 0) {
  const rows = cards.at(-1)?.markup?.inline_keyboard ?? [];
  const data = rows[optionIndex]?.[0]?.callback_data;
  assert.ok(data, `no delivered button at index ${optionIndex}`);
  return data;
}

async function eventually(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition was not met before timeout');
}

function bridgeFixture({ questions, respond, cardResult, ackDelayMs = 0 } = {}) {
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
        // A real round-trip: a second press can land while this is still in flight.
        if (ackDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, ackDelayMs));
      },
    },
    harness: {
      sessionExists: async () => false,
      createSession: async () => 'session-one',
      ask: async (sessionId, _text, options) => {
        const base = questionInteraction({
          sessionId,
          ...(questions ? { questions } : {}),
          ...(respond ? { respond } : {}),
        });
        let markAnswered;
        const answered = new Promise((resolve) => { markAnswered = resolve; });
        await options.onInteraction({
          ...base,
          respond: async (result) => {
            const value = await base.respond(result);
            markAnswered();
            return value;
          },
        });
        // Settle when the interaction is answered, so a later message in the same
        // conversation is not stuck behind this turn.
        await Promise.race([
          answered,
          new Promise((_, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), {
              once: true,
            });
          }),
        ]);
        return '已完成';
      },
    },
    logger: { warn() {}, error() {} },
  });
  return { bridge, controller, sent, cards, notices, edits };
}

test('Telegram card callback payload round-trips and rejects foreign data', () => {
  assert.deepEqual(parseTelegramCardCallback('q|abcd1234|0|2'), {
    nonce: 'abcd1234',
    questionIndex: 0,
    optionIndex: 2,
  });
  assert.deepEqual(parseTelegramCardCallback('q|A-1_b|12|7'), {
    nonce: 'A-1_b',
    questionIndex: 12,
    optionIndex: 7,
  });
  for (const invalid of [
    '', 'q', 'q|n', 'q|n|0', 'q|n||0', 'x|n|0|0', 'q|n|a|b',
    'q|n|0|0|0', 'q||0|0', null, undefined, 7,
  ]) {
    assert.equal(parseTelegramCardCallback(invalid), null, `rejected ${String(invalid)}`);
  }
  // The two-field shape predating the presentation nonce must not parse: without an
  // identity, a press cannot be attributed to the card currently on screen.
  assert.equal(parseTelegramCardCallback('q|0|1'), null);
});

test('Telegram card renderer encodes one button per option within the byte budget', () => {
  const question = {
    id: 'pick',
    question: '选一个颜色',
    options: [{ label: '红色', description: '像蝴蝶结' }, { label: '绿色' }],
  };
  const card = TELEGRAM_INTERACTION_CARD.render(question, {
    questionIndex: 1,
    total: 2,
    nonce: 'abcd1234',
  });
  assert.ok(card, 'expected a card for a single-choice question with options');
  assert.equal(card.markup.inline_keyboard.length, 2);
  assert.deepEqual(card.markup.inline_keyboard[0], [
    { text: '红色', callback_data: 'q|abcd1234|1|0' },
  ]);
  assert.deepEqual(card.markup.inline_keyboard[1], [
    { text: '绿色', callback_data: 'q|abcd1234|1|1' },
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
  const nonce = 'abcd1234';
  assert.equal(TELEGRAM_INTERACTION_CARD.render({ ...base }, { nonce }), null, 'no options');
  assert.equal(
    TELEGRAM_INTERACTION_CARD.render({ ...base, options: [] }, { nonce }),
    null,
    'empty options',
  );
  assert.equal(
    TELEGRAM_INTERACTION_CARD.render({
      ...base,
      multiSelect: true,
      options: [{ label: '红色' }, { label: '绿色' }],
    }, { nonce }),
    null,
    'multi-select keeps the text flow',
  );
  assert.equal(
    TELEGRAM_INTERACTION_CARD.render({
      ...base,
      options: Array.from({ length: 9 }, (_, index) => ({ label: `选项${index}` })),
    }, { nonce }),
    null,
    'too many options',
  );
  assert.equal(
    TELEGRAM_INTERACTION_CARD.render({ ...base, options: [{ label: '   ' }] }, { nonce }),
    null,
    'unusable label',
  );
  assert.equal(
    TELEGRAM_INTERACTION_CARD.render(
      { ...base, options: [{ description: 'no label' }] },
      { nonce },
    ),
    null,
    'missing label',
  );
  assert.equal(
    TELEGRAM_INTERACTION_CARD.render({ ...base, options: [{ label: '红色' }] }, {}),
    null,
    'a press needs a presentation identity to be attributed to',
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
      data: 'q|abcd1234|0|1',
    },
  }, { botId: 123456789 });
  assert.ok(normalized);
  assert.equal(normalized.callbackQueryId, 'cb-1');
  assert.equal(normalized.providerMessageId, 700);
  assert.equal(normalized.senderId, '7');
  assert.equal(normalized.conversationId, '42');
  assert.equal(normalized.kind, 'direct');
  assert.equal(normalized.data, 'q|abcd1234|0|1');
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
      data: 'q|abcd1234|0|0',
    },
  }, {});
  assert.equal(normalized.conversationId, '42:55');
  assert.equal(normalized.kind, 'group');
});

test('Telegram long polling subscribes to button presses', async () => {
  const { api, calls } = apiRecorder({ responses: { getUpdates: { ok: true, result: [] } } });
  await api.getUpdates({ offset: 3, timeout: 0 });
  assert.deepEqual(
    calls[0].payload.allowed_updates,
    ['message', 'callback_query'],
    'a keyboard that never delivers presses would fail silently on a real bot',
  );
});

test('Telegram API accepts an inline keyboard and an empty one that removes it', async () => {
  const { api, calls } = apiRecorder();
  await api.sendMessage({
    chatId: 42,
    text: '选一个',
    replyMarkup: { inline_keyboard: [[{ text: '红色', callback_data: 'q|abcd1234|0|0' }]] },
  });
  assert.deepEqual(calls[0].payload.reply_markup, {
    inline_keyboard: [[{ text: '红色', callback_data: 'q|abcd1234|0|0' }]],
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

  await bridge.acceptCallback(callback({ data: pressData(cards, 1) }));
  await eventually(() => answered.length === 1);

  assert.equal(answered[0].ok, true);
  assert.deepEqual(answered[0].value.answer.answers, [{ id: 'pick', selected: ['绿色'] }]);
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

  await bridge.acceptCallback(callback({ data: pressData(cards, 0), senderId: 'actor-b' }));
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
  const nonce = parseTelegramCardCallback(pressData(cards, 0)).nonce;

  // The card on screen carries question index 0; replay an index-3 payload.
  await bridge.acceptCallback(callback({ data: `q|${nonce}|3|0` }));
  assert.equal(answered.length, 0);
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /失效/);

  // A payload from a different presentation is refused even at identical indexes.
  await bridge.acceptCallback(callback({ data: 'q|deadbeef|0|0' }));
  assert.equal(answered.length, 0, 'another presentation must not answer this one');
  assert.equal(notices.length, 2);

  await bridge.acceptCallback(callback({ data: 'not-ours' }));
  assert.equal(answered.length, 0, 'foreign payloads never answer');
  assert.equal(notices.length, 3);

  controller.abort(new DOMException('test finished', 'AbortError'));
  await processing.catch(() => {});
});

test('two presses of one card answer only the question it belongs to', async () => {
  const answered = [];
  const { bridge, controller, cards, notices } = bridgeFixture({
    ackDelayMs: 40,
    questions: [
      { id: 'q-a', question: '第一题', options: [{ label: 'A1' }, { label: 'A2' }] },
      { id: 'q-b', question: '第二题', options: [{ label: 'B1' }, { label: 'B2' }] },
    ],
    respond: async (result) => { answered.push(result); return { accepted: true }; },
  });
  const processing = bridge.accept(message('m-1', '开始提问'));
  await eventually(() => cards.length === 1);
  const first = pressData(cards, 1);

  // A user who sees no feedback presses again while the acknowledgement is still in
  // flight: the second press must not advance the second question by itself.
  await Promise.all([
    bridge.acceptCallback(callback({ data: first, messageId: 'update-20' })),
    bridge.acceptCallback(callback({ data: first, messageId: 'update-21' })),
  ]);
  assert.equal(answered.length, 0, 'the batch is not submitted before every question is answered');
  assert.ok(
    notices.some((entry) => /正在提交/.test(entry.text)),
    'the duplicate press is told to wait rather than answering again',
  );

  await eventually(() => cards.length === 2);
  await bridge.acceptCallback(callback({ data: pressData(cards, 0), messageId: 'update-22' }));
  await eventually(() => answered.length === 1);
  assert.deepEqual(answered[0].value.answer.answers, [
    { id: 'q-a', selected: ['A2'] },
    { id: 'q-b', selected: ['B1'] },
  ]);

  controller.abort(new DOMException('test finished', 'AbortError'));
  await processing.catch(() => {});
});

test('answering by text retires the card keyboard', async () => {
  const answered = [];
  const { bridge, controller, cards, edits } = bridgeFixture({
    respond: async (result) => { answered.push(result); return { accepted: true }; },
  });
  const processing = bridge.accept(message('m-1', '开始提问'));
  await eventually(() => cards.length === 1);
  const delivered = pressData(cards, 0);

  await bridge.accept(message('m-2', '1'));
  await eventually(() => answered.length === 1);
  assert.deepEqual(answered[0].value.answer.answers, [{ id: 'pick', selected: ['红色'] }]);

  // A card left behind in the chat would stay pressable after the batch moved on,
  // so the text answer path retires its keyboard too.
  await eventually(() => edits.length === 1);
  assert.deepEqual(edits[0], { messageId: '700', markup: { inline_keyboard: [] } });

  // And the payload itself is refused once the interaction is gone.
  await bridge.acceptCallback(callback({ data: delivered, messageId: 'update-30' }));
  assert.equal(answered.length, 1, 'a retired card must not submit again');

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

  await bridge.acceptCallback(callback({ data: 'q|deadbeef|0|0' }));
  assert.equal(answered.length, 0);
  assert.match(notices[0].text, /失效|多选/);

  controller.abort(new DOMException('test finished', 'AbortError'));
  await processing.catch(() => {});
});

test('a press with no pending question is acknowledged without a submission', async () => {
  const { bridge, notices } = bridgeFixture({});
  await bridge.acceptCallback(callback({ data: 'q|deadbeef|0|0' }));
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
  assert.deepEqual(answered[0].value.answer.answers, [{ id: 'pick', selected: ['绿色'] }]);

  controller.abort(new DOMException('test finished', 'AbortError'));
  await processing.catch(() => {});
});

test('a press answers with its own option when labels are numbers', async () => {
  const answered = [];
  const { bridge, controller, cards } = bridgeFixture({
    questions: [{
      id: 'concurrency',
      question: '并发数选多少？',
      options: [{ label: '2' }, { label: '4' }, { label: '8' }],
    }],
    respond: async (result) => { answered.push(result); return { accepted: true }; },
  });
  const processing = bridge.accept(message('m-1', '开始提问'));
  await eventually(() => cards.length === 1);

  // Pressing the first button ("2") must submit "2". Replaying the label as reply
  // text would re-read it as option 2 and submit "4" — a different option entirely.
  await bridge.acceptCallback(callback({ data: pressData(cards, 0) }));
  await eventually(() => answered.length === 1);
  assert.deepEqual(answered[0].value.answer.answers, [
    { id: 'concurrency', selected: ['2'] },
  ]);

  controller.abort(new DOMException('test finished', 'AbortError'));
  await processing.catch(() => {});
});

test('a pressed numeric label never shifts to a neighbouring option', async () => {
  for (const [index, label] of [['0', '2'], ['1', '4'], ['2', '8']]) {
    const answered = [];
    const { bridge, controller, cards } = bridgeFixture({
      questions: [{
        id: 'concurrency',
        question: '并发数选多少？',
        options: [{ label: '2' }, { label: '4' }, { label: '8' }],
      }],
      respond: async (result) => { answered.push(result); return { accepted: true }; },
    });
    const processing = bridge.accept(message('m-1', '开始提问'));
    await eventually(() => cards.length === 1);

    await bridge.acceptCallback(callback({ data: pressData(cards, Number(index)) }));
    await eventually(() => answered.length === 1);
    assert.deepEqual(
      answered[0].value.answer.answers,
      [{ id: 'concurrency', selected: [label] }],
      `button ${index} must answer ${label}`,
    );

    controller.abort(new DOMException('test finished', 'AbortError'));
    await processing.catch(() => {});
  }
});

test('typing a number still selects the option at that position', async () => {
  const answered = [];
  const { bridge, controller, cards } = bridgeFixture({
    questions: [{
      id: 'concurrency',
      question: '并发数选多少？',
      options: [{ label: '2' }, { label: '4' }, { label: '8' }],
    }],
    respond: async (result) => { answered.push(result); return { accepted: true }; },
  });
  const processing = bridge.accept(message('m-1', '开始提问'));
  await eventually(() => cards.length === 1);

  // The text path keeps its existing meaning: "2" is the position, not the label.
  await bridge.accept(message('m-2', '2'));
  await eventually(() => answered.length === 1);
  assert.deepEqual(answered[0].value.answer.answers, [
    { id: 'concurrency', selected: ['4'] },
  ]);

  controller.abort(new DOMException('test finished', 'AbortError'));
  await processing.catch(() => {});
});
