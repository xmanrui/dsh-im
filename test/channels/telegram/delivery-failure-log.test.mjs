import assert from 'node:assert/strict';
import test from 'node:test';

import { TelegramApi } from '../../../src/channels/telegram/telegram-api.mjs';
import { TelegramHarnessBridge } from '../../../src/channels/telegram/telegram-bridge.mjs';
import { TelegramBotClient } from '../../../src/channels/telegram/telegram-runtime.mjs';

const TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456';
const INBOUND = {
  messageId: 'delivery-log-inbound',
  senderId: 'delivery-log-user',
  kind: 'direct',
  conversationId: 'delivery-log-user',
  content: 'answer the question',
  addressed: true,
  replyTarget: { chatId: 42, chatType: 'private', messageThreadId: 7 },
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function memoryState() {
  const seen = new Set();
  return {
    sessionFor: () => null,
    setSession: async () => {},
    clearSession: async () => {},
    hasSeen: (id) => seen.has(id),
    markSeen: async (id) => seen.add(id),
  };
}

/** The line the user is shown, and the log lines the channel emitted. */
function harnesses(fetchImpl, answer = '- answer body that Telegram never confirms', thinkingTraces = false) {
  const error = [];
  const sent = [];
  const api = new TelegramApi({ token: TOKEN, fetchImpl: (...args) => fetchImpl(...args) });
  const client = new TelegramBotClient({ api, logger: { warn() {}, error: (...parts) => error.push(parts.join(' ')) } });
  const bridge = new TelegramHarnessBridge({
    thinkingTraces,
    // Exercise the real thinking stream when enabled, otherwise send directly.
    bot: {
      ...(thinkingTraces ? { openThinkingStream: (target) => client.openThinkingStream(target) } : {}),
      sendDelivery: (target, block) => client.sendDelivery(target, block),
      sendText: async (target, text) => {
        const result = await client.sendText(target, text);
        sent.push(text);
        return result;
      },
      sendTyping: async () => {},
    },
    state: memoryState(),
    logger: { warn() {}, error: (...parts) => error.push(parts.join(' ')) },
    harness: {
      createSession: async () => 'delivery-log-session',
      ask: async () => answer,
    },
  });
  return { bridge, error, sent };
}

function loggedRecord(errorLines) {
  const line = errorLines.find((entry) => entry.includes('] delivery failed ['));
  assert.ok(line, `expected one delivery failure line, got ${JSON.stringify(errorLines)}`);
  // Exactly one line per delivery: the record is a single string, not a
  // pretty-printed object spread over many lines.
  assert.equal(line.split('\n').length, 1);
  return { line, record: JSON.parse(line.slice(line.indexOf('{'))) };
}

for (const thinkingTraces of [false, true]) {
  const mode = thinkingTraces ? 'thinking stream' : 'direct delivery';

  test(`${mode}: a failed delivery logs the same reference id the user is shown`, async () => {
    const calls = [];
    const { bridge, error, sent } = harnesses(async (url, options) => {
      const method = url.pathname.split('/').at(-1);
      calls.push({ method, body: options.body ? JSON.parse(options.body) : null });
      if (method === 'sendRichMessage') {
        return calls.filter((call) => call.method === 'sendRichMessage').length === 1
          ? jsonResponse({
            ok: false,
            error_code: 429,
            description: 'Too Many Requests: retry after 0',
            parameters: { retry_after: 0 },
          }, 429)
          : jsonResponse({ ok: false, error_code: 500, description: 'Internal Server Error' }, 500);
      }
      // The notice itself must reach the chat, so plain sends succeed.
      return jsonResponse({ ok: true, result: { message_id: 900 } });
    }, undefined, thinkingTraces);

    await bridge.accept(INBOUND);

    const notice = sent.find((text) => /MF-[A-Z0-9]{8}/u.test(text));
    assert.ok(notice, `the user must be shown a notice with a reference id, got ${JSON.stringify(sent)}`);
    const referenceId = notice.match(/MF-[A-Z0-9]{8}/u)[0];
    assert.equal(bridge.status.lastMessageError.referenceId, referenceId);

    const { line, record } = loggedRecord(error);
    assert.equal(record.referenceId, referenceId, 'the log line must carry the user-facing reference id');
    assert.ok(line.startsWith('[dsh-im:telegram] delivery failed ['), line);
    assert.equal(record.code, 'CHANNEL_DELIVERY_UNCERTAIN');
    assert.equal(record.reason, 'CHANNEL_DELIVERY_UNCERTAIN');
    assert.equal(record.provider_reason, 'telegram-500');
    assert.equal(record.deliveryOutcome, 'unknown');
    assert.equal(record.attempt_count, 2);
    assert.deepEqual(record.attempts, [
      { attempt: 1, method: 'sendRichMessage', status: 429, description: 'Too Many Requests: retry after 0', retry_after: 0 },
      { attempt: 2, method: 'sendRichMessage', status: 500, description: 'Internal Server Error', retry_after: null },
    ]);
    assert.equal(record.chat_id, '42');
    assert.equal(record.message_thread_id, 7);
    assert.equal(record.parse_mode, 'rich_markdown');
    assert.equal(record.parts.length, 1);
    assert.equal(record.parts[0].index, 0);
    assert.equal(record.parts[0].message_id, null, 'no message id came back for the failed part');
    // The whole point of the line: the text nobody can find in the chat.
    assert.equal(record.parts[0].text, '- answer body that Telegram never confirms');
    assert.equal(record.parts[0].length, '- answer body that Telegram never confirms'.length);
    assert.equal(record.failed_part, 0);
    assert.ok(!line.includes(TOKEN), 'the bot token must never reach the log');
    assert.ok(!line.includes(TOKEN.split(':')[1]), 'no part of the token may reach the log');
  });

  test(`${mode}: a part that comes back without a message id is logged with its text`, async () => {
    const { bridge, error } = harnesses(async (url) => {
      const method = url.pathname.split('/').at(-1);
      if (method === 'sendRichMessage') return jsonResponse({ ok: true, result: {} });
      return jsonResponse({ ok: true, result: { message_id: 901 } });
    }, undefined, thinkingTraces);

    await bridge.accept(INBOUND);

    const { record } = loggedRecord(error);
    assert.equal(record.deliveryOutcome, 'unknown');
    assert.equal(record.provider_reason, 'telegram-message-id-missing');
    assert.equal(record.parts[0].message_id, null);
    assert.equal(record.parts[0].text, '- answer body that Telegram never confirms');
    assert.equal(record.parts[0].length, '- answer body that Telegram never confirms'.length);
    assert.equal(record.attempt_count, 0, 'a resolved call is not a failed attempt');
  });

  test(`${mode}: a successful delivery logs nothing`, async () => {
    const { bridge, error } = harnesses(async () => jsonResponse({ ok: true, result: { message_id: 902 } }), undefined, thinkingTraces);

    const receipt = await bridge.accept(INBOUND);

    assert.equal(receipt.deliveryOutcome, 'sent');
    assert.equal(receipt.presentation, thinkingTraces ? 'telegram-thinking' : 'telegram-rich-final');
    assert.deepEqual(error, [], 'a delivered answer must not produce a delivery failure line');
    assert.equal(bridge.status.lastMessageError, null);
  });

  test(`${mode}: every part of an answer reports whether Telegram returned its message id`, async () => {
    const longAnswer = `\`\`\`js\n${'const value = 1;\n'.repeat(400)}`;
    assert.ok(longAnswer.length > 4_000, 'the answer must need more than one plain part');
    let plainSends = 0;
    const { bridge, error } = harnesses(async (url) => {
      const method = url.pathname.split('/').at(-1);
      if (method === 'sendRichMessage') {
        // Rich Markdown cannot be built from an unclosed fence, so the answer is
        // re-sent as plain text -- which is where it splits into parts.
        return jsonResponse({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, 400);
      }
      plainSends += 1;
      // First part delivered, second rejected, third call is the notice itself.
      if (plainSends === 1) return jsonResponse({ ok: true, result: { message_id: 903 } });
      if (plainSends === 2) return jsonResponse({ ok: false, error_code: 400, description: 'Bad Request: message is too long' }, 400);
      return jsonResponse({ ok: true, result: { message_id: 904 } });
    }, longAnswer, thinkingTraces);

    await bridge.accept(INBOUND);

    const { record } = loggedRecord(error);
    assert.equal(record.code, 'CHANNEL_DELIVERY');
    assert.equal(record.deliveryOutcome, 'failed');
    assert.equal(record.parse_mode, 'none');
    assert.equal(record.parts.length, 2, `expected two parts, got ${JSON.stringify(record.parts)}`);
    assert.equal(record.parts[0].message_id, '903', 'the delivered part keeps its message id');
    assert.equal(record.parts[0].text, undefined, 'a delivered part does not repeat its text in the log');
    assert.equal(record.parts[1].message_id, null);
    assert.equal(record.parts[1].index, 1);
    assert.equal(record.failed_part, 1);
    assert.equal(record.parts[1].length, record.parts[1].text.length);
    assert.ok(longAnswer.includes(record.parts[1].text), 'the logged text is the part that failed, in full');
  });
}
