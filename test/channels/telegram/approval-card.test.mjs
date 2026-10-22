import assert from 'node:assert/strict';
import test from 'node:test';

import { harnessApprovalText } from '../../../src/channels/shared/harness-approval.mjs';
import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import { TelegramApi } from '../../../src/channels/telegram/telegram-api.mjs';
import {
  TelegramHarnessBridge,
} from '../../../src/channels/telegram/telegram-bridge.mjs';
import {
  parseTelegramApprovalCallback,
  telegramApprovalCallbackData,
} from '../../../src/channels/telegram/approval-card.mjs';
import { TelegramBotClient } from '../../../src/channels/telegram/telegram-runtime.mjs';

const TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456';

const APPROVAL_ID = 'approval-one';
const CALL_ID = 'call-approval-one';
const TOOL_NAME = 'bash';
const ARGUMENTS_TEXT = JSON.stringify({ command: "printf 'approval-test\\n'" });
const REASON = '测试审批链路';

const APPROVAL_PAYLOAD = {
  type: 'approval/requested',
  sessionId: 'session-one',
  approvalId: APPROVAL_ID,
  toolName: TOOL_NAME,
  callId: CALL_ID,
  reason: REASON,
};
const APPROVAL_TOOL_CALL = {
  callId: CALL_ID,
  name: TOOL_NAME,
  arguments: ARGUMENTS_TEXT,
};
// The exact prompt the plain-text path shows today. The card must never change it.
const PLAIN_APPROVAL_PROMPT = harnessApprovalText(APPROVAL_PAYLOAD, { toolCall: APPROVAL_TOOL_CALL });

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

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function deferredWithReject() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function eventually(predicate, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition was not met before timeout');
}

function stateFixture() {
  const sessions = new Map();
  const seen = new Set();
  return {
    sessions,
    state: {
      sessionFor: (key) => sessions.get(key) ?? null,
      async setSession(key, value) { sessions.set(key, value); return true; },
      async clearSession(key) { sessions.delete(key); },
      hasSeen: (id) => seen.has(id),
      async markSeen(id) { seen.add(id); },
      async unmarkSeen(id) { seen.delete(id); },
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

function approvalInteraction({
  sessionId = 'session-one',
  argumentsText = ARGUMENTS_TEXT,
  respond = async () => ({ accepted: true }),
} = {}) {
  return {
    kind: 'approval',
    interactionId: APPROVAL_ID,
    rpcId: `rpc-${APPROVAL_ID}`,
    sessionId,
    payload: { ...APPROVAL_PAYLOAD, sessionId },
    toolCall: { ...APPROVAL_TOOL_CALL, arguments: argumentsText },
    respond,
  };
}

/** The payload a real Telegram client would send back for one delivered button. */
function pressData(cards, buttonIndex) {
  const buttons = (cards.at(-1)?.markup?.inline_keyboard ?? []).flat();
  const data = buttons[buttonIndex]?.callback_data;
  assert.ok(data, `no delivered button at index ${buttonIndex}`);
  return data;
}

function bridgeFixture({
  cardResult = 'ok',
  cardEditResult = 'ok',
  supportsCards = true,
  ackDelayMs = 0,
  approvalTimeoutMs,
  argumentsText,
  harness,
} = {}) {
  const { state } = stateFixture();
  const controller = new AbortController();
  const env = {
    sent: [],
    cards: [],
    cardAttempts: 0,
    notices: [],
    edits: [],
    events: [],
    submissions: [],
  };
  const bot = {
    async sendText(_target, text) {
      env.sent.push(text);
    },
    async updateInteractionCard(_target, messageId, { markup } = {}) {
      env.edits.push({ messageId, markup });
    },
    async answerInteractionCallback(queryId, text) {
      env.events.push('ack');
      env.notices.push({ queryId, text });
      // A real ack round-trip: a second press can land while it is in flight.
      if (ackDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, ackDelayMs));
    },
  };
  if (supportsCards) {
    bot.sendInteractionCard = async (_target, { text, markup } = {}) => {
      env.events.push('card');
      env.cardAttempts += 1;
      if (cardResult === 'fail') throw new Error('telegram refused the keyboard');
      env.cards.push({ text, markup });
      return { providerMessageIds: [String(699 + env.cards.length)] };
    };
    bot.editInteractionCard = async (_target, messageId, { text, markup } = {}) => {
      env.events.push('edit');
      if (cardEditResult === 'fail') throw new Error('telegram refused the card edit');
      env.edits.push({ messageId, text, markup });
      return { messageId, text, markup };
    };
  }

  const defaultHarness = {
    sessionExists: async () => false,
    createSession: async () => 'session-one',
    ask: async (sessionId, _text, options) => {
      const answered = deferredWithReject();
      await options.onInteraction(approvalInteraction({
        sessionId,
        ...(argumentsText === undefined ? {} : { argumentsText }),
        respond: async (result) => {
          env.events.push('submit');
          env.submissions.push(result);
          answered.resolve();
          return { accepted: true };
        },
      }));
      await Promise.race([
        answered.promise,
        new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
        }),
      ]);
      return '审批完成';
    },
  };

  const bridge = new TelegramHarnessBridge({
    state,
    signal: controller.signal,
    bot,
    harness: harness ?? defaultHarness,
    logger: { warn() {}, error() {} },
    ...(approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs }),
  });
  return { bridge, controller, env };
}

function stopFixture(controller, processing) {
  controller.abort(new DOMException('test finished', 'AbortError'));
  return processing.catch(() => {});
}

test('approval callback data is versioned, bounded and limited to approve/reject', () => {
  const approve = telegramApprovalCallbackData('abcd1234EFGH', 'approve');
  const reject = telegramApprovalCallbackData('abcd1234EFGH', 'reject');
  assert.equal(approve, 'ap1|abcd1234EFGH|a');
  assert.equal(reject, 'ap1|abcd1234EFGH|d');
  assert.deepEqual(parseTelegramApprovalCallback(approve), {
    nonce: 'abcd1234EFGH',
    action: 'approve',
  });
  assert.deepEqual(parseTelegramApprovalCallback(reject), {
    nonce: 'abcd1234EFGH',
    action: 'reject',
  });
  for (const invalid of [
    '',
    'ap1',
    'ap1|n',
    'ap1|n|x',
    'ap1|n|a|extra',
    'q|abcd1234|0|0',
    'ap2|n|a',
    null,
    7,
  ]) {
    assert.equal(parseTelegramApprovalCallback(invalid), null, `foreign payload: ${String(invalid)}`);
  }
  for (const data of [approve, reject]) {
    assert.ok(Buffer.byteLength(data, 'utf8') <= 64);
  }
  assert.throws(
    () => telegramApprovalCallbackData('', 'approve'),
    /nonce is invalid/u,
  );
});

test('an approval is delivered as a two-button card carrying the existing prompt body', async () => {
  const { bridge, controller, env } = bridgeFixture();
  const processing = bridge.accept(message('m-1', '启动审批'));
  await eventually(() => env.cards.length === 1);

  const [card] = env.cards;
  assert.match(card.text, /bash/u);
  assert.match(card.text, /printf/u, 'the tool arguments stay in the card body');
  assert.match(card.text, /测试审批链路/u, 'the reason stays in the card body');
  assert.doesNotMatch(
    card.text,
    /请精准回复/u,
    'a card does not tell the user to type the decision',
  );

  const buttons = card.markup.inline_keyboard.flat();
  assert.deepEqual(buttons.map((button) => button.text), ['✅ 批准一次', '❌ 拒绝']);
  const parsed = buttons.map((button) => parseTelegramApprovalCallback(button.callback_data));
  assert.ok(parsed.every(Boolean), 'every button carries our own callback payload');
  assert.equal(parsed[0].nonce, parsed[1].nonce, 'both buttons belong to one presentation');
  assert.deepEqual(parsed.map(({ action }) => action), ['approve', 'reject']);
  for (const button of buttons) {
    assert.ok(
      Buffer.byteLength(button.callback_data, 'utf8') <= 64,
      'Telegram rejects callback_data over 64 bytes',
    );
  }
  assert.equal(
    env.sent.some((text) => text.includes('请精准回复')),
    false,
    'the plain-text prompt is not sent when the card works',
  );

  await stopFixture(controller, processing);
});

test('approving on the card submits allowed-once and turns the card into a receipt', async () => {
  const { bridge, controller, env } = bridgeFixture();
  const processing = bridge.accept(message('m-1', '启动审批'));
  await eventually(() => env.cards.length === 1);

  await bridge.acceptCallback(callback({ data: pressData(env.cards, 0) }));
  await eventually(() => env.submissions.length === 1);

  assert.deepEqual(env.submissions[0], {
    ok: true,
    value: {
      sessionId: 'session-one',
      approvalId: APPROVAL_ID,
      outcome: 'allowed-once',
    },
  });
  // Telegram must get its acknowledgement before the decision is submitted.
  assert.ok(env.events.includes('ack'));
  assert.ok(
    env.events.indexOf('ack') < env.events.indexOf('submit'),
    'the press must be acknowledged before the decision is submitted',
  );
  assert.equal(env.notices.length, 1);
  assert.equal(env.notices[0].queryId, 'cb-1');

  await eventually(() => env.edits.length === 1);
  const [edit] = env.edits;
  assert.equal(edit.messageId, '700');
  assert.match(edit.text, /✅ 已批准（仅本次）/u);
  assert.match(edit.text, /bash/u, 'the receipt keeps the tool details visible');
  assert.deepEqual(edit.markup, { inline_keyboard: [] }, 'the keyboard is removed');
  assert.equal(
    env.sent.some((text) => text === '已批准，仅对本次操作有效。'),
    false,
    'the card receipt replaces the separate terminal text',
  );

  await stopFixture(controller, processing);
});

test('rejecting on the card submits rejected and shows the rejected receipt', async () => {
  const { bridge, controller, env } = bridgeFixture();
  const processing = bridge.accept(message('m-1', '启动审批'));
  await eventually(() => env.cards.length === 1);

  await bridge.acceptCallback(callback({ data: pressData(env.cards, 1) }));
  await eventually(() => env.submissions.length === 1);
  assert.equal(env.submissions[0].value.outcome, 'rejected');

  await eventually(() => env.edits.length === 1);
  assert.match(env.edits[0].text, /❌ 已拒绝/u);
  assert.deepEqual(env.edits[0].markup, { inline_keyboard: [] });

  await stopFixture(controller, processing);
});

test('a press by someone else only receives a toast and leaves the card for its owner', async () => {
  const { bridge, controller, env } = bridgeFixture();
  const processing = bridge.accept(message('m-1', '启动审批'));
  await eventually(() => env.cards.length === 1);
  const data = pressData(env.cards, 0);

  await bridge.acceptCallback(callback({ data, senderId: 'actor-b', callbackQueryId: 'cb-stranger' }));
  assert.equal(env.submissions.length, 0, 'a stranger must not decide the approval');
  assert.equal(env.edits.length, 0, 'the owner keeps a working keyboard');
  assert.equal(env.notices.length, 1);
  assert.equal(env.notices[0].queryId, 'cb-stranger');
  assert.match(env.notices[0].text, /只有发起/u);

  // The owner can still press the very same button afterwards.
  await bridge.acceptCallback(callback({ data, callbackQueryId: 'cb-owner' }));
  await eventually(() => env.submissions.length === 1);
  assert.equal(env.submissions[0].value.outcome, 'allowed-once');

  await stopFixture(controller, processing);
});

test('two presses of one card submit the decision exactly once', async () => {
  const { bridge, controller, env } = bridgeFixture({ ackDelayMs: 30 });
  const processing = bridge.accept(message('m-1', '启动审批'));
  await eventually(() => env.cards.length === 1);
  const data = pressData(env.cards, 0);

  await Promise.all([
    bridge.acceptCallback(callback({ data, messageId: 'update-20', callbackQueryId: 'cb-1' })),
    bridge.acceptCallback(callback({ data, messageId: 'update-21', callbackQueryId: 'cb-2' })),
  ]);
  await eventually(() => env.submissions.length === 1);
  assert.equal(env.submissions.length, 1, 'the shared approval is only submitted once');
  assert.ok(
    env.notices.some(({ text }) => /正在提交|已处理|已失效/u.test(text ?? '')),
    'the duplicate press gets an explanatory toast',
  );

  await stopFixture(controller, processing);
});

test('a press on a resolved card is refused and its dead keyboard is retired', async () => {
  const { bridge, controller, env } = bridgeFixture();
  const processing = bridge.accept(message('m-1', '启动审批'));
  await eventually(() => env.cards.length === 1);
  const data = pressData(env.cards, 0);

  await bridge.acceptCallback(callback({ data, callbackQueryId: 'cb-1' }));
  await eventually(() => env.submissions.length === 1);
  await eventually(() => env.edits.length === 1);

  await bridge.acceptCallback(callback({ data, callbackQueryId: 'cb-2' }));
  assert.equal(env.submissions.length, 1, 'a resolved card cannot decide twice');
  assert.match(env.notices.at(-1).text, /已处理|已失效/u);
  // The stale keyboard is cleared again (the card edit above cannot be trusted to
  // have reached a client that cached the old keyboard).
  assert.equal(env.edits.at(-1).markup.inline_keyboard.length, 0);

  await stopFixture(controller, processing);
});

test('an approval timeout turns the card into an expired receipt without a keyboard', async () => {
  const { bridge, controller, env } = bridgeFixture({ approvalTimeoutMs: 50 });
  const processing = bridge.accept(message('m-1', '启动审批'));
  await eventually(() => env.cards.length === 1);

  await eventually(() => env.edits.some((edit) => /已过期/u.test(edit.text ?? '')));
  const expired = env.edits.find((edit) => /已过期/u.test(edit.text ?? ''));
  assert.deepEqual(expired.markup, { inline_keyboard: [] });
  assert.equal(env.submissions.length, 1, 'the timeout auto-rejects the approval');
  assert.equal(env.submissions[0].value.outcome, 'rejected');
  assert.equal(
    env.sent.some((text) => text.includes('审批已超时')),
    false,
    'the card receipt replaces the separate timeout text',
  );

  // Pressing the expired keyboard is refused instead of submitting a decision.
  await bridge.acceptCallback(callback({ data: pressData(env.cards, 0), callbackQueryId: 'cb-late' }));
  assert.equal(env.submissions.length, 1);
  assert.match(env.notices.at(-1).text, /已处理|已过期|已失效/u);

  await stopFixture(controller, processing);
});

test('a refused card send falls back to the byte-identical text approval', async () => {
  const { bridge, controller, env } = bridgeFixture({ cardResult: 'fail' });
  const processing = bridge.accept(message('m-1', '启动审批'));
  await eventually(() => env.sent.length === 1);

  assert.equal(env.cards.length, 0);
  assert.equal(env.cardAttempts, 1, 'the channel must try the card before giving up');
  assert.equal(
    env.sent[0],
    PLAIN_APPROVAL_PROMPT,
    'the fallback prompt must stay byte-identical to the pre-card text flow',
  );

  await bridge.accept(message('m-2', '批准'));
  await eventually(() => env.submissions.length === 1);
  assert.equal(env.submissions[0].value.outcome, 'allowed-once');
  assert.equal(
    env.sent.includes('已批准，仅对本次操作有效。'),
    true,
    'the plain-text terminal receipt is unchanged when no card exists',
  );

  await stopFixture(controller, processing);
});

test('a channel without keyboard support keeps the plain-text approval flow', async () => {
  const { bridge, controller, env } = bridgeFixture({ supportsCards: false });
  const processing = bridge.accept(message('m-1', '启动审批'));
  await eventually(() => env.sent.length === 1);

  assert.equal(env.sent[0], PLAIN_APPROVAL_PROMPT);
  assert.equal(env.edits.length, 0);

  await bridge.accept(message('m-2', '拒绝'));
  await eventually(() => env.submissions.length === 1);
  assert.equal(env.submissions[0].value.outcome, 'rejected');

  await stopFixture(controller, processing);
});

test('a failed card edit still delivers the terminal text receipt (never lose a decision)', async () => {
  const { bridge, controller, env } = bridgeFixture({ cardEditResult: 'fail' });
  const processing = bridge.accept(message('m-1', '启动审批'));
  await eventually(() => env.cards.length === 1);

  await bridge.acceptCallback(callback({ data: pressData(env.cards, 0) }));
  await eventually(() => env.submissions.length === 1);
  assert.equal(env.submissions[0].value.outcome, 'allowed-once');
  await eventually(() => env.sent.includes('已批准，仅对本次操作有效。'));

  await stopFixture(controller, processing);
});

test('editMessageText forwards an optional keyboard but never mixes one into a rich message', async () => {
  const { api, calls } = apiRecorder();
  const markup = {
    inline_keyboard: [[
      { text: '✅ 批准一次', callback_data: 'ap1|abcd1234EFGH|a' },
      { text: '❌ 拒绝', callback_data: 'ap1|abcd1234EFGH|d' },
    ]],
  };
  await api.editMessageText({ chatId: 42, messageId: 700, text: '审批', replyMarkup: markup });
  assert.equal(calls[0].method, 'editMessageText');
  assert.deepEqual(calls[0].payload, {
    chat_id: 42,
    message_id: 700,
    text: '审批',
    link_preview_options: { is_disabled: true },
    reply_markup: markup,
  });

  await api.editMessageText({ chatId: 42, messageId: 700, text: '审批（已处理）' });
  assert.equal('reply_markup' in calls[1].payload, false, 'no markup means no reply_markup field');

  await assert.rejects(
    () => api.editMessageText({
      chatId: 42,
      messageId: 700,
      richMessage: { markdown: '**已批准**' },
      replyMarkup: markup,
    }),
    /rich Telegram answer never carries an inline keyboard/u,
  );
  await assert.rejects(
    () => api.editMessageText({
      chatId: 42,
      messageId: 700,
      text: 'x',
      replyMarkup: { inline_keyboard: [[{ text: 'a', callback_data: 'x'.repeat(65) }]] },
    }),
    /at most 64 bytes/u,
  );
  assert.equal(calls.length, 2, 'rejected payloads never reach the network');
});

test('the card edit treats message is not modified as success', async () => {
  const { api } = apiRecorder({
    responses: {
      editMessageText: {
        ok: false,
        error_code: 400,
        description: 'Bad Request: message is not modified: specified new message content '
          + 'and reply markup are exactly the same as a current content and reply markup of the message',
      },
    },
  });
  const client = new TelegramBotClient({ api, logger: { warn() {}, error() {} } });
  assert.deepEqual(
    await client.editInteractionCard({ chatId: 42 }, '700', {
      text: '✅ 已批准（仅本次）',
      markup: { inline_keyboard: [] },
    }),
    { unchanged: true },
  );
});

test('the card edit degrades to editMessageReplyMarkup when text+keyboard is refused', async () => {
  const calls = [];
  let editTextCalls = 0;
  const api = new TelegramApi({
    token: TOKEN,
    fetchImpl: async (url, init) => {
      const method = url.pathname.split('/').at(-1);
      calls.push({ method, payload: JSON.parse(init.body) });
      if (method === 'editMessageText') {
        editTextCalls += 1;
        if (editTextCalls === 1) {
          return jsonResponse({
            ok: false,
            error_code: 400,
            description: "Bad Request: can't parse reply_markup JSON object",
          });
        }
      }
      return jsonResponse({ ok: true, result: true });
    },
  });
  const client = new TelegramBotClient({ api, logger: { warn() {}, error() {} } });
  const result = await client.editInteractionCard({ chatId: 42 }, '700', {
    text: '✅ 已批准（仅本次）',
    markup: { inline_keyboard: [] },
  });
  assert.deepEqual(result, { fallback: true });
  assert.deepEqual(calls.map(({ method }) => method), [
    'editMessageText',
    'editMessageReplyMarkup',
    'editMessageText',
  ]);
  assert.deepEqual(calls[1].payload.reply_markup, { inline_keyboard: [] });
  assert.equal('reply_markup' in calls[2].payload, false);
});

test('a failed terminal card edit still clears the dead keyboard (normalised message id)', async () => {
  const { bridge, controller, env } = bridgeFixture({ cardEditResult: 'fail' });
  const processing = bridge.accept(message('m-1', '启动审批'));
  await eventually(() => env.cards.length === 1);

  await bridge.acceptCallback(callback({ data: pressData(env.cards, 0) }));
  await eventually(() => env.submissions.length === 1);
  // The card text edit failed, but the keyboard must not stay pressable: the
  // stored message id is a string and has to be normalised before the guard.
  await eventually(() => env.edits.length >= 1);
  assert.deepEqual(env.edits.at(-1), {
    messageId: 700,
    markup: { inline_keyboard: [] },
  });

  await stopFixture(controller, processing);
});

test('ordinary text while a card is live neither asks for typing nor duplicates the receipt', async () => {
  const { bridge, controller, env } = bridgeFixture();
  const processing = bridge.accept(message('m-1', '启动审批'));
  await eventually(() => env.cards.length === 1);

  await bridge.accept(message('m-2', '随便说一句'));
  assert.equal(env.submissions.length, 0, 'ordinary text is not an approval decision');
  assert.equal(
    env.sent.some((text) => /请精准回复/u.test(text)),
    false,
    'the button card must not answer ordinary text with the type-the-decision prompt',
  );

  await bridge.acceptCallback(callback({ data: pressData(env.cards, 0) }));
  await eventually(() => env.submissions.length === 1);
  await eventually(() => env.edits.length === 1);
  assert.equal(
    env.sent.filter((text) => text === '已批准，仅对本次操作有效。').length,
    0,
    'a card receipt is the only terminal notice after the owner already replied in text',
  );

  await stopFixture(controller, processing);
});

test('typing 批准 and then pressing the card keeps a single terminal receipt', async () => {
  const { bridge, controller, env } = bridgeFixture();
  const processing = bridge.accept(message('m-1', '启动审批'));
  await eventually(() => env.cards.length === 1);

  await bridge.accept(message('m-2', '批准'));
  await eventually(() => env.submissions.length === 1);
  assert.equal(env.submissions[0].value.outcome, 'allowed-once');
  await eventually(() => env.edits.length === 1);
  assert.match(env.edits[0].text, /已批准（仅本次）/u);
  assert.equal(
    env.sent.includes('已批准，仅对本次操作有效。'),
    false,
    'the card is the terminal receipt; no duplicate chat message',
  );

  // Pressing the now-terminal keyboard must not decide a second time.
  await bridge.acceptCallback(callback({ data: pressData(env.cards, 0), callbackQueryId: 'cb-late' }));
  assert.equal(env.submissions.length, 1);
  assert.match(env.notices.at(-1).text, /已处理|已失效/u);

  await stopFixture(controller, processing);
});

test('an oversized approval body keeps the plain-text flow instead of a doomed card', async () => {
  const bigArguments = JSON.stringify({ command: `echo ${'x'.repeat(4_500)}` });
  const expected = harnessApprovalText(APPROVAL_PAYLOAD, {
    toolCall: { ...APPROVAL_TOOL_CALL, arguments: bigArguments },
  });
  assert.ok(expected.length > 4_096, 'the fixture must exceed Telegram\'s message limit');
  const { bridge, controller, env } = bridgeFixture({ argumentsText: bigArguments });
  const processing = bridge.accept(message('m-1', '启动超长审批'));
  await eventually(() => env.sent.length === 1);

  assert.equal(env.cardAttempts, 0, 'a body Telegram will reject must not be sent as a card');
  assert.equal(env.cards.length, 0);
  assert.equal(env.sent[0], expected, 'the split-capable text path takes over unchanged');

  await bridge.accept(message('m-2', '批准'));
  await eventually(() => env.submissions.length === 1);
  assert.equal(env.submissions[0].value.outcome, 'allowed-once');

  await stopFixture(controller, processing);
});

test('approval card labels follow the host language', async () => {
  setImHostLanguage('en');
  try {
    const { bridge, controller, env } = bridgeFixture();
    const processing = bridge.accept(message('m-1', 'start an approval'));
    await eventually(() => env.cards.length === 1);
    assert.deepEqual(
      env.cards[0].markup.inline_keyboard.flat().map((button) => button.text),
      ['✅ Approve once', '❌ Reject'],
    );

    await bridge.acceptCallback(callback({ data: pressData(env.cards, 0) }));
    await eventually(() => env.edits.length === 1);
    assert.match(env.edits[0].text, /✅ Approved \(this time only\)/u);

    await bridge.acceptCallback(callback({ data: pressData(env.cards, 0), callbackQueryId: 'cb-late' }));
    assert.match(env.notices.at(-1).text, /already (?:handled|processed)/u);

    await stopFixture(controller, processing);
  } finally {
    setImHostLanguage('zh');
  }
});
