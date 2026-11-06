import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { createTextDeliveryBlock } from '../../../src/channels/shared/semantic/delivery.mjs';
import {
  deriveTelegramBotIdentity,
  normalizeSendLimitPerMinute,
  TelegramConfigStore,
} from '../../../src/channels/telegram/config-store.mjs';
import { TelegramController } from '../../../src/channels/telegram/telegram-controller.mjs';
import { TelegramApi } from '../../../src/channels/telegram/telegram-api.mjs';
import { TelegramBotClient } from '../../../src/channels/telegram/telegram-runtime.mjs';

const TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const flush = () => new Promise((resolve) => { setImmediate(resolve); });

/** Advance the fake clock and let the promise chain that the timer released run. */
async function advance(t, ms) {
  await flush();
  t.mock.timers.tick(ms);
  await flush();
}

function rateLimited(retryAfter) {
  return jsonResponse({
    ok: false,
    error_code: 429,
    description: `Too Many Requests: retry after ${retryAfter}`,
    parameters: { retry_after: retryAfter },
  }, 429);
}

function recorder() {
  const calls = [];
  return {
    calls,
    logger: {
      entries: [],
      warn(...parts) { this.entries.push(parts.join(' ')); },
    },
    fetchImpl: async (url, options) => {
      calls.push({
        method: url.pathname.split('/').pop(),
        body: options.body instanceof String || typeof options.body === 'string'
          ? JSON.parse(options.body)
          : null,
      });
      return jsonResponse({ ok: true, result: { message_id: calls.length } });
    },
  };
}

function credentials() {
  const values = new Map();
  return {
    async resolve(ref) {
      return { value: values.get(ref) ?? TOKEN, source: 'test' };
    },
    async set(ref, value) { values.set(ref, value); },
    async unset(ref) { values.delete(ref); },
  };
}

// --- per-chat send budget ------------------------------------------------

test('a third message to the same chat waits for a free slot while another chat is sent at once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { calls, fetchImpl } = recorder();
  const api = new TelegramApi({ token: TOKEN, fetchImpl, sendLimitPerMinute: 2 });

  await api.sendMessage({ chatId: '-1001234567890', text: 'first' });
  await api.sendMessage({ chatId: '-1001234567890', text: 'second' });

  let thirdDelivered = false;
  const third = api.sendMessage({ chatId: '-1001234567890', text: 'third' })
    .then(() => { thirdDelivered = true; });
  // A different chat has its own budget, so it must not queue behind the busy one.
  await api.sendMessage({ chatId: '42', text: 'elsewhere' });
  await flush();
  assert.equal(calls.length, 3, 'the other chat is sent without waiting');
  assert.equal(thirdDelivered, false, 'the third message waits for the next free slot');

  await advance(t, 60_000);
  await third;
  assert.equal(thirdDelivered, true);
  assert.equal(calls.length, 4);
});

test('edits, drafts, typing actions and reactions never wait for the send budget', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { calls, fetchImpl } = recorder();
  const api = new TelegramApi({ token: TOKEN, fetchImpl, sendLimitPerMinute: 1 });
  const chatId = '-1001234567890';
  await api.sendMessage({ chatId, text: 'budget spent' });

  // Each of these would block forever under the fake clock if it were budgeted.
  await api.editMessageText({ chatId, messageId: 5, text: 'progress' });
  await api.editMessageReplyMarkup({ chatId, messageId: 5, markup: { inline_keyboard: [] } });
  await api.sendRichMessageDraft({ chatId, draftId: 7, richMessage: { markdown: 'draft' } });
  await api.sendChatAction({ chatId });
  await api.setMessageReaction({ chatId, messageId: 5, emoji: '👀' });
  await api.answerCallbackQuery({ callbackQueryId: 'cb-1', text: 'ok' });
  assert.equal(calls.length, 7);
});

// --- 429 handling ---------------------------------------------------------

test('a rate-limited message send is retried after retry_after and then succeeds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let attempts = 0;
  const { logger } = recorder();
  const api = new TelegramApi({
    token: TOKEN,
    logger,
    sendLimitPerMinute: 15,
    fetchImpl: async () => {
      attempts += 1;
      return attempts === 1 ? rateLimited(2) : jsonResponse({ ok: true, result: { message_id: 11 } });
    },
  });

  const send = api.sendMessage({ chatId: '-1001234567890', text: 'hello' });
  await flush();
  assert.equal(attempts, 1, 'the first attempt was rejected by Telegram');
  await advance(t, 2_000);
  const message = await send;

  assert.equal(attempts, 2);
  assert.equal(message.message_id, 11);
  assert.equal(logger.entries.length, 1);
  assert.match(logger.entries[0], /-1001234567890 sendMessage/);
  assert.match(logger.entries[0], /2000 ms/);
});

test('a send that keeps getting 429 gives up after four attempts with channel-rate-limit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let attempts = 0;
  const api = new TelegramApi({
    token: TOKEN,
    sendLimitPerMinute: 15,
    fetchImpl: async () => {
      attempts += 1;
      return rateLimited(attempts === 4 ? 3 : 1);
    },
  });

  const failure = api.sendMessage({ chatId: '-1001234567890', text: 'hello' })
    .then(() => null, (error) => error);
  for (let waited = 0; waited < 3; waited += 1) await advance(t, 1_000);
  const error = await failure;

  assert.equal(attempts, 4, 'one original call and three retries');
  assert.equal(error.code, 'channel-rate-limit');
  assert.equal(error.retry_after, 3, 'the last retry_after travels with the error');
});

test('a wait longer than a minute is reported instead of waited out', async () => {
  let attempts = 0;
  const api = new TelegramApi({
    token: TOKEN,
    sendLimitPerMinute: 15,
    fetchImpl: async () => {
      attempts += 1;
      return rateLimited(120);
    },
  });
  await assert.rejects(
    () => api.sendMessage({ chatId: '-1001234567890', text: 'hello' }),
    (error) => {
      assert.equal(error.code, 'channel-rate-limit');
      assert.equal(error.retry_after, 120);
      return true;
    },
  );
  assert.equal(attempts, 1);
});

test('an edit that gets 429 is not retried and does not throw to the caller', async () => {
  let attempts = 0;
  const { logger } = recorder();
  const api = new TelegramApi({
    token: TOKEN,
    logger,
    sendLimitPerMinute: 15,
    fetchImpl: async () => {
      attempts += 1;
      return rateLimited(30);
    },
  });
  const result = await api.editMessageText({ chatId: '-1001234567890', messageId: 5, text: 'progress' });
  assert.equal(result, undefined);
  assert.equal(attempts, 1, 'the stream moves on instead of retrying');
  assert.match(logger.entries.at(-1), /editMessageText rate limited; skipping this update/u);

  const draft = await api.sendRichMessageDraft({
    chatId: '-1001234567890', draftId: 9, richMessage: { markdown: 'draft' },
  });
  assert.equal(draft, undefined);
  assert.equal(attempts, 2);
});

// --- the final answer ----------------------------------------------------

/** A turn's own bot client, wired to a real TelegramApi so the budget and the
 *  429 retries are the ones under test rather than a stub's impression of them. */
async function finalAnswer(fetchImpl, { sendLimitPerMinute = 15 } = {}) {
  const api = new TelegramApi({
    token: TOKEN,
    fetchImpl,
    sendLimitPerMinute,
    logger: { warn() {} },
  });
  const client = new TelegramBotClient({
    api,
    signal: new AbortController().signal,
    logger: { warn() {} },
  });
  const stream = await client.openDeliveryStream({ chatId: '-1001234567890' });
  return stream;
}

test('a final answer whose send is rejected by 429 is retried and reported as sent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const requests = [];
  let answerAttempts = 0;
  const stream = await finalAnswer(async (url) => {
    const method = url.pathname.split('/').pop();
    requests.push(method);
    if (method === 'deleteMessage') return jsonResponse({ ok: true, result: true });
    if (method === 'sendRichMessage') {
      answerAttempts += 1;
      return answerAttempts === 1
        ? rateLimited(1)
        : jsonResponse({ ok: true, result: { message_id: 777 } });
    }
    return jsonResponse({ ok: true, result: { message_id: 501 } });
  });

  const delivery = stream.finish(createTextDeliveryBlock('**answer**', 'markdown'));
  await flush();
  assert.equal(answerAttempts, 1, 'the answer send was rejected by Telegram once');
  await advance(t, 1_000);
  const result = await delivery;

  assert.equal(answerAttempts, 2, 'the rejected send is retried instead of dropped');
  assert.equal(result.deliveryOutcome, 'sent');
  assert.deepEqual(result.providerMessageIds, ['777']);
  assert.deepEqual(
    requests,
    ['sendMessage', 'deleteMessage', 'sendRichMessage', 'sendRichMessage'],
    'the placeholder goes away before the answer, and the answer itself carries the receipt',
  );
});

test('a final answer that never gets past 429 is reported as undelivered, not sent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const requests = [];
  let placeholderSent = false;
  const stream = await finalAnswer(async (url) => {
    const method = url.pathname.split('/').pop();
    requests.push(method);
    if (method === 'deleteMessage') return jsonResponse({ ok: true, result: true });
    if (method === 'sendRichMessage') return rateLimited(1);
    // Only the progress placeholder gets through; every real answer is refused.
    if (!placeholderSent) {
      placeholderSent = true;
      return jsonResponse({ ok: true, result: { message_id: 501 } });
    }
    return rateLimited(1);
  });

  let settled = false;
  const delivery = stream
    .finish(createTextDeliveryBlock('**answer**', 'markdown'))
    .finally(() => { settled = true; });
  // Two budgeted sends (rich, then the plain fallback), four attempts each.
  for (let waited = 0; waited < 10 && !settled; waited += 1) await advance(t, 1_000);
  const result = await delivery;

  assert.equal(result.deliveryOutcome, 'failed', 'a swallowed answer is never called sent');
  assert.equal(result.reason, 'channel-rate-limit');
  assert.deepEqual(result.providerMessageIds, [], 'nothing was confirmed delivered');
  assert.equal(requests.filter((method) => method === 'deleteMessage').length, 1);
});

test('a final answer that Telegram accepts without a message id is not reported as sent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let placeholderSent = false;
  const stream = await finalAnswer(async (url) => {
    const method = url.pathname.split('/').pop();
    if (method === 'deleteMessage') return jsonResponse({ ok: true, result: true });
    if (!placeholderSent) {
      placeholderSent = true;
      return jsonResponse({ ok: true, result: { message_id: 501 } });
    }
    // Telegram accepted the answer but named no message: delivery is unproven.
    return jsonResponse({ ok: true, result: {} });
  });

  const result = await stream.finish(createTextDeliveryBlock('**answer**', 'markdown'));

  assert.equal(result.deliveryOutcome, 'unknown', 'an unnamed message is not evidence of delivery');
  assert.equal(result.reason, 'telegram-message-id-missing');
  assert.deepEqual(result.providerMessageIds, []);
});

// --- file uploads --------------------------------------------------------

test('a file upload that waits for a free send slot still uploads once it is dispatched', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const requests = [];
  const api = new TelegramApi({
    token: TOKEN,
    sendLimitPerMinute: 1,
    // Shorter than the wait for a slot on purpose: the upload timeout must
    // cover the upload, not the queueing that happens before it starts.
    fileUploadTimeoutMs: 20,
    fetchImpl: async (url) => {
      requests.push(url.pathname.split('/').pop());
      return jsonResponse({ ok: true, result: { message_id: requests.length } });
    },
  });
  const chatId = '-1001234567890';
  await api.sendMessage({ chatId, text: 'budget spent' });

  const upload = api.sendDocument({
    chatId,
    file: { fileName: 'result.bin', bytes: Buffer.from('result') },
  });
  // Real time, deliberately longer than the upload timeout: only the queue runs.
  await delay(40);
  assert.equal(requests.includes('sendDocument'), false, 'the file is still queued');

  await advance(t, 60_000);
  const message = await upload;
  assert.equal(message.message_id, 2, 'the upload went out once a slot was free');
  assert.equal(requests.at(-1), 'sendDocument');
});

test('a file upload cancelled while it waits for a slot fails plainly, not uncertainly', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const requests = [];
  const api = new TelegramApi({
    token: TOKEN,
    sendLimitPerMinute: 1,
    fetchImpl: async (url) => {
      requests.push(url.pathname.split('/').pop());
      return jsonResponse({ ok: true, result: { message_id: 1 } });
    },
  });
  const chatId = '-1001234567890';
  await api.sendMessage({ chatId, text: 'budget spent' });

  const controller = new AbortController();
  const reason = new DOMException('turn stopped', 'AbortError');
  const upload = api.sendDocument({
    chatId,
    file: { fileName: 'result.bin', bytes: Buffer.from('result') },
    signal: controller.signal,
  }).then(() => null, (error) => error);
  await flush();
  controller.abort(reason);
  const error = await upload;

  // Nothing reached Telegram, so there is nothing uncertain to warn about.
  assert.equal(error, reason);
  assert.notEqual(error.code, 'artifact-delivery-uncertain');
  assert.deepEqual(requests, ['sendMessage'], 'the upload never opened a request');
});

// --- configuration -------------------------------------------------------

test('sendLimitPerMinute normalizes to an integer inside the supported range', () => {
  assert.equal(normalizeSendLimitPerMinute(undefined), 15, 'missing falls back to the default');
  assert.equal(normalizeSendLimitPerMinute(0), 1);
  assert.equal(normalizeSendLimitPerMinute(-4), 1);
  assert.equal(normalizeSendLimitPerMinute(99), 30);
  assert.equal(normalizeSendLimitPerMinute('7'), 7);
  assert.equal(normalizeSendLimitPerMinute(7.6), 8);
  assert.equal(normalizeSendLimitPerMinute(Number.NaN), 15);
  assert.equal(normalizeSendLimitPerMinute('garbage'), 15);
  assert.equal(normalizeSendLimitPerMinute(''), 15);
  assert.equal(normalizeSendLimitPerMinute(null), 15);
  assert.equal(normalizeSendLimitPerMinute(true), 15);
});

test('sendLimitPerMinute survives a save and reload round trip', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-send-limit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'config.json');
  const identity = deriveTelegramBotIdentity('123456789');
  const configStore = await new TelegramConfigStore(configPath).load();
  await configStore.save({
    platformId: '123456789',
    ...identity,
    name: 'Harness Telegram',
    sendLimitPerMinute: 99,
  });

  const reloaded = await new TelegramConfigStore(configPath).load();
  assert.equal(reloaded.get(identity.botId).sendLimitPerMinute, 30);
});

test('the controller clamps the limit, reports it and restarts the runtime with it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-send-limit-controller-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configStore = await new TelegramConfigStore(join(directory, 'config.json')).load();
  const runtimeRecords = [];
  const controller = new TelegramController({
    credentials: credentials(),
    configStore,
    inspectToken: async () => ({ platformId: '123456789', name: 'Harness Telegram', username: 'harness_bot' }),
    createRuntime: async ({ botId, config }) => {
      runtimeRecords.push({ botId, config: structuredClone(config) });
      return {
        status: { ready: true, connectionState: 'connected' },
        async start() {},
        async stop() {},
      };
    },
  });
  const bound = await controller.bindCredentials({ token: TOKEN });
  const botId = bound.bots[0].botId;
  assert.equal(bound.bots[0].sendLimitPerMinute, 15, 'a bot without the field reports the default');

  const updated = await controller.setSendLimitPerMinute(botId, '91');
  assert.equal(updated.bots[0].sendLimitPerMinute, 30);
  assert.equal(configStore.get(botId).sendLimitPerMinute, 30);
  assert.equal(runtimeRecords.at(-1).config.sendLimitPerMinute, 30);

  const garbage = await controller.setSendLimitPerMinute(botId, 'not a number');
  assert.equal(garbage.bots[0].sendLimitPerMinute, 15);
  assert.equal(configStore.get(botId).sendLimitPerMinute, 15);
});

// --- settings wiring ------------------------------------------------------

test('the bot card shows the message limit next to the thinking-traces switch', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ThinkingTracesSettings } = await import('../../../plugin-src/client/channels/telegram/thinking-traces.js');
  const markup = renderToStaticMarkup(React.createElement(ThinkingTracesSettings, {
    account: { botId: 'telegram_test', thinkingTraces: true, sendLimitPerMinute: 20 },
    busy: false,
    onSave() {},
    rpcCall: async () => ({ ok: true, value: {} }),
    endpoints: { setSendLimit: 'bot.send-limit.set' },
    onChanged() {},
  }));
  assert.match(markup, /消息发送上限/);
  assert.match(markup, /每个聊天每分钟的消息数；机器人会等待而不是丢弃/);
  assert.match(markup, /<input[^>]*type="number"[^>]*value="20"/);
  assert.match(markup, /dim-accountSettingsSwitch/);
});

test('the settings endpoint stores the limit the controller clamped', async () => {
  const { createTelegramRpcHandler } = await import('../../../plugin-src/host/channels/telegram/rpc.mjs');
  const seen = [];
  const handler = createTelegramRpcHandler({
    async status() { return { schemaVersion: 1, revision: 1, bots: [] }; },
    async bindCredentials() { throw new Error('not used'); },
    async reconnectBot() { throw new Error('not used'); },
    async deleteBot() { throw new Error('not used'); },
    async setSendLimitPerMinute(botId, value) {
      seen.push({ botId, value: normalizeSendLimitPerMinute(value) });
      return { schemaVersion: 1, revision: 2, bots: [] };
    },
  });
  const result = await handler('bot.send-limit.set', { botId: 'telegram_abc', sendLimitPerMinute: '99' });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, [{ botId: 'telegram_abc', value: 30 }]);

  const rejected = await handler('bot.send-limit.set', { botId: 'telegram_abc' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'bad-request');
});
