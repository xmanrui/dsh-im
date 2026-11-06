import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import React from 'react';

import { normalizeThinkingIntervalSeconds } from '../../../src/channels/shared/thinking-cadence.mjs';
import { TelegramConfigStore } from '../../../src/channels/telegram/config-store.mjs';
import { TelegramController } from '../../../src/channels/telegram/telegram-controller.mjs';
import { TelegramApi } from '../../../src/channels/telegram/telegram-api.mjs';
import { TelegramBotClient } from '../../../src/channels/telegram/telegram-runtime.mjs';
import { ThinkingTracesSettings } from '../../../plugin-src/client/channels/telegram/thinking-traces.js';
import { createTokenBotRpcHandler, TOKEN_BOT_ENDPOINTS } from '../../../plugin-src/host/channels/shared/rpc.mjs';
import { validThinkingCadencePayload } from '../../../plugin-src/host/channels/shared/thinking-cadence-rpc.mjs';

const TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456';

const quietLogger = { warn: () => {}, error: () => {}, debug: () => {} };

const flush = () => new Promise((resolve) => { setImmediate(resolve); });

/** Advance the fake clock and let the promise chain the timer released run. */
async function advance(t, ms) {
  await flush();
  t.mock.timers.tick(ms);
  await flush();
}

function recorder() {
  const sent = [];
  const api = {
    sendMessage: async (params) => {
      sent.push(params.text);
      return { message_id: 5000 + sent.length };
    },
  };
  return { sent, api };
}

/** Stub API whose sends stay pending until the test releases them, so a test can
 *  ask which request is still on the wire at a given moment. */
function delayedRecorder() {
  const requested = [];
  const delivered = [];
  const api = {
    sendMessage: (params) => new Promise((resolve, reject) => {
      const request = {
        text: params.text,
        settled: false,
        deliver: () => {
          if (request.settled) return;
          request.settled = true;
          delivered.push(params.text);
          resolve({ message_id: 5000 + delivered.length });
        },
        fail: (error) => {
          if (request.settled) return;
          request.settled = true;
          reject(error);
        },
      };
      requested.push(request);
    }),
  };
  return { api, requested, delivered };
}

function credentials() {
  const values = new Map();
  return {
    async resolve(ref) {
      return values.has(ref) ? { value: values.get(ref), source: 'test' } : undefined;
    },
    async set(ref, value) { values.set(ref, value); },
    async unset(ref) { values.delete(ref); },
  };
}

async function controllerFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-thinking-cadence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'config.json');
  const configStore = await new TelegramConfigStore(configPath).load();
  const runtimeRecords = [];
  const controller = new TelegramController({
    credentials: credentials(),
    configStore,
    inspectToken: async () => ({
      platformId: '123456789', name: 'Harness Telegram', username: 'harness_bot',
    }),
    createRuntime: async ({ botId, config }) => {
      runtimeRecords.push({ botId, config: structuredClone(config) });
      return {
        status: { ready: true, connectionState: 'connected', harnessReachable: true, lastCheckedAt: 10 },
        async start() {},
        async stop() {},
      };
    },
  });
  const bound = await controller.bindCredentials({ token: TOKEN });
  return {
    configPath, configStore, controller, runtimeRecords, botId: bound.bots[0].botId,
  };
}

// --- frames on the wire ---------------------------------------------------

test('numbering counts paced-away frames, so the sent frames keep a gap in their numbers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { sent, api } = recorder();
  const client = new TelegramBotClient({
    api, signal: undefined, logger: quietLogger, thinkingNumbering: true, thinkingIntervalSeconds: 3,
  });
  const stream = client.openThinkingStream({ chatId: 42 });
  await stream.sendThinking('one');
  await advance(t, 1_000);
  await stream.sendThinking('two');
  await advance(t, 1_000);
  await stream.sendThinking('three');
  await advance(t, 1_000);
  assert.deepEqual(sent, ['1 💭 one', '3 💭 three'], 'frame 2 was paced away and never renumbered');
  await advance(t, 2_000);
  await stream.sendThinking('four');
  assert.deepEqual(sent, ['1 💭 one', '3 💭 three'], 'frame 4 waits for the rest of its window');
  await stream.finish('done');
  assert.deepEqual(sent.slice(0, 3), ['1 💭 one', '3 💭 three', '4 💭 four']);
  assert.equal(sent.at(-1), 'done');
});

test('a burst inside one window collapses to the newest frame only', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { sent, api } = recorder();
  const client = new TelegramBotClient({
    api, signal: undefined, logger: quietLogger, thinkingNumbering: true, thinkingIntervalSeconds: 3,
  });
  const stream = client.openThinkingStream({ chatId: 42 });
  await stream.sendThinking('first');
  await advance(t, 100);
  await stream.sendToolTrace('bash', { command: 'ls' });
  await advance(t, 100);
  await stream.sendThinking('third');
  assert.deepEqual(sent, ['1 💭 first'], 'nothing inside the window goes out immediately');
  await advance(t, 2_800);
  assert.deepEqual(sent, ['1 💭 first', '3 💭 third'], 'only the latest held frame is flushed');
  assert.ok(!sent.some((text) => text.includes('2 🔧')), 'the superseded frame is dropped, not queued');
});

test('finish() flushes the held frame before the final answer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { sent, api } = recorder();
  const client = new TelegramBotClient({
    api, signal: undefined, logger: quietLogger, thinkingNumbering: true, thinkingIntervalSeconds: 10,
  });
  const stream = client.openThinkingStream({ chatId: 42 });
  await stream.sendThinking('one');
  await advance(t, 1_000);
  await stream.sendThinking('two');
  assert.deepEqual(sent, ['1 💭 one']);
  await stream.finish('the answer');
  assert.deepEqual(sent, ['1 💭 one', '2 💭 two', 'the answer']);
});

test('a trace send that is still in flight settles before the final answer goes out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { api, requested, delivered } = delayedRecorder();
  const client = new TelegramBotClient({
    api, signal: undefined, logger: quietLogger, thinkingNumbering: true, thinkingIntervalSeconds: 5,
  });
  const stream = client.openThinkingStream({ chatId: 42 });
  const firstTrace = stream.sendThinking('one');
  await flush();
  await advance(t, 1_000);
  await stream.sendThinking('two');
  await advance(t, 5_000);
  assert.deepEqual(requested.map((request) => request.text), ['1 💭 one', '2 💭 two'],
    'the window timer flushed the held frame and left its send pending');
  const finishing = stream.finish('the answer');
  await flush();
  // The answer may not be requested while any trace request is unanswered, or
  // the trace lands in the chat after the reply that closes the turn.
  assert.deepEqual(requested.map((request) => request.text), ['1 💭 one', '2 💭 two'],
    'finish() waits for the in-flight trace sends instead of overtaking them');
  for (const request of requested) request.deliver();
  await flush();
  assert.deepEqual(requested.map((request) => request.text),
    ['1 💭 one', '2 💭 two', 'the answer'], 'the answer follows the last trace');
  requested.at(-1).deliver();
  const receipt = await finishing;
  await firstTrace;
  assert.deepEqual(delivered, ['1 💭 one', '2 💭 two', 'the answer']);
  assert.deepEqual(receipt.providerMessageIds, ['5001', '5002', '5003'],
    'the receipt knows every trace message the turn sent');
});

test('a trace request that fails does not cost the final answer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { api, requested } = delayedRecorder();
  const client = new TelegramBotClient({
    api, signal: undefined, logger: quietLogger, thinkingIntervalSeconds: 5,
  });
  const stream = client.openThinkingStream({ chatId: 42 });
  const trace = stream.sendThinking('one');
  await flush();
  const finishing = stream.finish('the answer');
  await flush();
  assert.deepEqual(requested.map((request) => request.text), ['💭 one'],
    'the answer still waits for the trace request it cannot know the fate of');
  requested[0].fail(new Error('telegram is down'));
  await flush();
  requested[1].deliver();
  const receipt = await finishing;
  await trace;
  assert.deepEqual(requested.map((request) => request.text), ['💭 one', 'the answer'],
    'a lost trace is best-effort and must not take the answer down with it');
  assert.equal(receipt.deliveryOutcome, 'sent');
  assert.deepEqual(receipt.providerMessageIds, ['5001']);
});

test('an update that lands after the deadline sends only the newest frame', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { sent, api } = recorder();
  const client = new TelegramBotClient({
    api, signal: undefined, logger: quietLogger, thinkingNumbering: true, thinkingIntervalSeconds: 5,
  });
  const stream = client.openThinkingStream({ chatId: 42 });
  await stream.sendThinking('one');
  await advance(t, 1_000);
  await stream.sendThinking('two');
  assert.deepEqual(sent, ['1 💭 one']);
  // The deadline passes while the held frame's timer is still queued, as it can
  // on a throttled or busy event loop, so the newer update sees the window
  // expired first.
  t.mock.timers.setTime(Date.now() + 5_000);
  await stream.sendThinking('three');
  assert.deepEqual(sent, ['1 💭 one', '3 💭 three'],
    'the frame that owns the fresh window goes out alone');
  await advance(t, 10_000);
  assert.deepEqual(sent, ['1 💭 one', '3 💭 three'],
    'the superseded timer must not deliver its stale frame afterwards');
});

test('cancel() drops the held frame and leaves no timer behind', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { sent, api } = recorder();
  const client = new TelegramBotClient({
    api, signal: undefined, logger: quietLogger, thinkingIntervalSeconds: 10,
  });
  const stream = client.openThinkingStream({ chatId: 42 });
  await stream.sendThinking('one');
  await advance(t, 1_000);
  await stream.sendThinking('two');
  stream.cancel();
  await advance(t, 30_000);
  assert.deepEqual(sent, ['💭 one'], 'the cancelled turn must not send the held frame later');
  await assert.rejects(() => stream.finish('answer'), /already closed/u);
});

test('numbering stays off by default, so a frame keeps exactly its formatted text', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { sent, api } = recorder();
  const client = new TelegramBotClient({ api, signal: undefined, logger: quietLogger });
  const stream = client.openThinkingStream({ chatId: 42 });
  await stream.sendThinking('Let me list the directory first.');
  await stream.sendToolTrace('bash', { command: 'ls -la' });
  await stream.finish('done');
  assert.deepEqual(sent, ['💭 Let me list the directory first.', '🔧 bash → ls -la', 'done']);
});

test('numbering works with pacing off and numbers every frame in order', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { sent, api } = recorder();
  const client = new TelegramBotClient({
    api, signal: undefined, logger: quietLogger, thinkingNumbering: true,
  });
  const stream = client.openThinkingStream({ chatId: 42 });
  await stream.sendThinking('one');
  await stream.sendThinking('two');
  await stream.sendToolTrace('bash', { command: 'pwd' });
  assert.deepEqual(sent, ['1 💭 one', '2 💭 two', '3 🔧 bash → pwd']);
});

// --- config: clamping, persistence, RPC -----------------------------------

test('thinkingIntervalSeconds normalizes to a whole 0..60, and garbage means no pacing', () => {
  assert.equal(normalizeThinkingIntervalSeconds(undefined), 0, 'missing means no pacing');
  assert.equal(normalizeThinkingIntervalSeconds(-5), 0);
  assert.equal(normalizeThinkingIntervalSeconds(99), 60);
  assert.equal(normalizeThinkingIntervalSeconds('7'), 7);
  assert.equal(normalizeThinkingIntervalSeconds(' 7 '), 7);
  assert.equal(normalizeThinkingIntervalSeconds('garbage'), 0);
  assert.equal(normalizeThinkingIntervalSeconds(7.5), 0, 'a fractional value must not slow the trace down');
  assert.equal(normalizeThinkingIntervalSeconds(true), 0);
  assert.equal(normalizeThinkingIntervalSeconds(null), 0);
});

test('the clamped cadence survives save and reload and reaches the runtime', async (t) => {
  const fixture = await controllerFixture(t);
  const saved = await fixture.controller.setThinkingCadence(fixture.botId, {
    thinkingNumbering: true,
    thinkingIntervalSeconds: 99,
  });
  assert.equal(saved.bots[0].thinkingNumbering, true);
  assert.equal(saved.bots[0].thinkingIntervalSeconds, 60, 'the status reports the clamped value');
  assert.equal(fixture.configStore.get(fixture.botId).thinkingIntervalSeconds, 60);
  assert.equal(fixture.runtimeRecords.at(-1).config.thinkingIntervalSeconds, 60,
    'the runtime restarts with the stored value');

  const reloaded = await new TelegramConfigStore(fixture.configPath).load();
  assert.equal(reloaded.get(fixture.botId).thinkingNumbering, true);
  assert.equal(reloaded.get(fixture.botId).thinkingIntervalSeconds, 60);

  const cleared = await fixture.controller.setThinkingCadence(fixture.botId, {
    thinkingNumbering: false,
    thinkingIntervalSeconds: 'nonsense',
  });
  assert.equal(cleared.bots[0].thinkingNumbering, false);
  assert.equal(cleared.bots[0].thinkingIntervalSeconds, 0);
});

test('the cadence RPC validates the payload shape and stores what the controller clamped', async (t) => {
  const fixture = await controllerFixture(t);
  const handler = createTokenBotRpcHandler(fixture.controller, { channel: 'Telegram' });
  assert.equal(TOKEN_BOT_ENDPOINTS.setThinkingCadence, 'bot.thinking-cadence.set');
  assert.equal(validThinkingCadencePayload({
    botId: fixture.botId, thinkingNumbering: true, thinkingIntervalSeconds: '99',
  }), true);
  assert.equal(validThinkingCadencePayload({
    botId: fixture.botId, thinkingNumbering: 'yes', thinkingIntervalSeconds: 5,
  }), false);
  assert.equal(validThinkingCadencePayload({ botId: fixture.botId, thinkingNumbering: true }), false);

  const rejected = await handler(TOKEN_BOT_ENDPOINTS.setThinkingCadence, {
    botId: fixture.botId, thinkingNumbering: true,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.message, '请提交有效的思考帧节奏设置。');

  const accepted = await handler(TOKEN_BOT_ENDPOINTS.setThinkingCadence, {
    botId: fixture.botId, thinkingNumbering: true, thinkingIntervalSeconds: '99',
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.value.bots[0].thinkingIntervalSeconds, 60);
  assert.equal(fixture.configStore.get(fixture.botId).thinkingIntervalSeconds, 60);
});

// --- client card ----------------------------------------------------------

test('the settings card renders the numbering switch and the interval select', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const calls = [];
  const markup = renderToStaticMarkup(React.createElement(ThinkingTracesSettings, {
    account: {
      botId: 'telegram_abc',
      thinkingTraces: true,
      thinkingNumbering: true,
      thinkingIntervalSeconds: 5,
    },
    rpcCall: async (endpoint, payload) => { calls.push({ endpoint, payload }); return { ok: true, value: {} }; },
    endpoints: { setThinkingCadence: 'bot.thinking-cadence.set' },
  }));
  assert.match(markup, /编号思考帧/);
  assert.match(markup, /最多每隔多久发送一帧（秒）/);
  assert.match(markup, /<select[^>]*class="dim-accountSettingsSelect"/);
  assert.match(markup, /<option value="0">不限制（0）<\/option>/);
  assert.match(markup, /<option value="5" selected="">5<\/option>/);
  assert.match(markup, /<option value="60">60<\/option>/);
  // Two switches now: thinking traces and frame numbering.
  assert.equal((markup.match(/type="checkbox"/g) ?? []).length, 2);
  assert.equal(calls.length, 0, 'rendering must not save anything');
});

test('cadence and send-limit RPC saves preserve each other across reload and runtime restart', async (t) => {
  const fixture = await controllerFixture(t);
  const handler = createTokenBotRpcHandler(fixture.controller, { channel: 'Telegram' });
  const { normalizeSnapshot } = await import('../../../plugin-src/client/channels/telegram/api.js');
  const save = async (endpoint, fields) => {
    const response = await handler(endpoint, { botId: fixture.botId, ...fields });
    assert.equal(response.ok, true);
    return normalizeSnapshot(response.value).bots[0];
  };
  await save(TOKEN_BOT_ENDPOINTS.setSendLimit, { sendLimitPerMinute: 12 });
  const cadence = await save(TOKEN_BOT_ENDPOINTS.setThinkingCadence, {
    thinkingNumbering: true, thinkingIntervalSeconds: 5,
  });
  assert.equal(cadence.sendLimitPerMinute, 12);
  const limit = await save(TOKEN_BOT_ENDPOINTS.setSendLimit, { sendLimitPerMinute: 8 });
  assert.equal(limit.thinkingNumbering, true);
  assert.equal(limit.thinkingIntervalSeconds, 5);
  assert.equal(limit.sendLimitPerMinute, 8);
  const reloaded = await new TelegramConfigStore(fixture.configPath).load();
  for (const config of [reloaded.get(fixture.botId), fixture.runtimeRecords.at(-1).config]) {
    assert.equal(config.thinkingNumbering, true);
    assert.equal(config.thinkingIntervalSeconds, 5);
    assert.equal(config.sendLimitPerMinute, 8);
  }
});

test('the combined settings card saves cadence and the send limit through their own endpoints', async (t) => {
  const { act, create } = await import('react-test-renderer');
  const { TELEGRAM_ENDPOINTS } = await import('../../../plugin-src/client/channels/telegram/api.js');
  const calls = [];
  const reloads = [];
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(ThinkingTracesSettings, {
      account: {
        botId: 'telegram_test', thinkingTraces: true,
        thinkingNumbering: true, thinkingIntervalSeconds: 5, sendLimitPerMinute: 15,
      },
      endpoints: TELEGRAM_ENDPOINTS,
      rpcCall: async (endpoint, payload) => {
        calls.push({ endpoint, payload });
        return { ok: true, value: {} };
      },
      onChanged: async (options) => { reloads.push(options); },
    }));
  });
  t.after(() => act(() => renderer.unmount()));
  await act(async () => {
    renderer.root.findByType('select').props.onChange({ target: { value: '7' } });
  });
  await act(async () => {
    renderer.root.findAllByProps({ type: 'checkbox' })[1].props.onChange({ target: { checked: false } });
  });
  await act(async () => {
    renderer.root.findByProps({ type: 'number' }).props.onChange({ target: { value: '12' } });
  });
  await act(async () => { renderer.root.findByProps({ type: 'number' }).props.onBlur(); });
  assert.deepEqual(calls, [
    { endpoint: 'bot.thinking-cadence.set', payload: {
      botId: 'telegram_test', thinkingNumbering: true, thinkingIntervalSeconds: 7,
    } },
    { endpoint: 'bot.thinking-cadence.set', payload: {
      botId: 'telegram_test', thinkingNumbering: false, thinkingIntervalSeconds: 7,
    } },
    { endpoint: 'bot.send-limit.set', payload: { botId: 'telegram_test', sendLimitPerMinute: 12 } },
  ]);
  assert.deepEqual(reloads, [{ silent: true }, { silent: true }, { silent: true }]);
});

test('paced traces waiting for the per-chat budget still settle before the final answer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sent = [];
  const api = new TelegramApi({
    token: TOKEN, sendLimitPerMinute: 1, logger: quietLogger,
    fetchImpl: async (_url, options) => {
      sent.push(JSON.parse(options.body).text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const stream = new TelegramBotClient({
    api, logger: quietLogger, thinkingNumbering: true, thinkingIntervalSeconds: 3,
  }).openThinkingStream({ chatId: 42 });
  await stream.sendThinking('first');
  await advance(t, 1_000);
  await stream.sendThinking('superseded');
  await advance(t, 1_000);
  await stream.sendThinking('latest');
  await advance(t, 1_000);
  let finished = false;
  const finishing = stream.finish('answer').then((receipt) => {
    finished = true;
    return receipt;
  });
  await flush();
  assert.deepEqual(sent, ['1 💭 first']);
  assert.equal(finished, false);
  await advance(t, 57_000);
  assert.deepEqual(sent, ['1 💭 first', '3 💭 latest']);
  assert.equal(finished, false, 'the answer also respects the per-chat budget');
  await advance(t, 60_000);
  const receipt = await finishing;
  assert.deepEqual(sent, ['1 💭 first', '3 💭 latest', 'answer']);
  assert.equal(receipt.deliveryOutcome, 'sent');
  assert.deepEqual(receipt.providerMessageIds, ['1', '2', '3']);
});

test('the placeholder progress is numbered, so an unchanging tool name still moves', async () => {
  const calls = [];
  const client = new TelegramBotClient({
    api: {
      sendMessage: (payload) => {
        calls.push({ method: 'sendMessage', payload });
        return { message_id: 4101 };
      },
      editMessageText: (payload) => {
        calls.push({ method: 'editMessageText', payload });
        return { message_id: 4101 };
      },
      deleteMessage: (payload) => {
        calls.push({ method: 'deleteMessage', payload });
        return true;
      },
      sendRichMessage: (payload) => {
        calls.push({ method: 'sendRichMessage', payload });
        return { message_id: 4102 };
      },
    },
    thinkingNumbering: true,
  });
  const stream = await client.openDeliveryStream({ chatId: 42, chatType: 'private', replyToMessageId: 44 });
  await stream.update({ kind: 'text', text: 'Using bash', format: 'plain' });
  await stream.update({ kind: 'text', text: 'Using bash', format: 'plain' });
  await stream.finish({ kind: 'text', text: '## done', format: 'markdown' });

  assert.deepEqual(
    calls.filter(({ method }) => method === 'editMessageText').map(({ payload }) => payload.text),
    ['1. Using bash', '2. Using bash'],
    'identical progress lines differ by their frame number',
  );
  // The placeholder carries progress only: the merged final-answer delivery
  // deletes it and sends the answer as its own message, so the numbering stops
  // with the last frame instead of rewriting the placeholder into the answer.
  assert.deepEqual(calls.map(({ method }) => method), [
    'sendMessage',
    'editMessageText',
    'editMessageText',
    'deleteMessage',
    'sendRichMessage',
  ]);
  assert.deepEqual(calls.at(-1).payload.richMessage, { markdown: '## done' });
});

// --- placeholder pacing vs. finalization ----------------------------------

/** Placeholder API whose progress edits are recorded in the order they land,
 *  each waiting on the gate for its own frame. */
function pacedPlaceholder(gates = []) {
  const events = [];
  let placeholderId = 7100;
  const api = {
    sendMessage: async () => {
      placeholderId += 1;
      return { message_id: placeholderId };
    },
    editMessageText: async (payload) => {
      const gate = gates.shift();
      if (gate) await gate;
      events.push(`edit ${payload.text}`);
      return { message_id: placeholderId };
    },
    deleteMessage: async () => {
      events.push('delete placeholder');
      return true;
    },
    sendRichMessage: async (payload) => {
      events.push(`answer ${payload.richMessage.markdown}`);
      return { message_id: 7200 };
    },
  };
  return { events, api };
}

test('a progress frame released by the window timer never lands after the final answer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  // The frame the timer releases is the slow one: finalization must wait for it
  // rather than deleting the placeholder underneath its in-flight edit.
  let releaseSlowEdit;
  const slowEdit = new Promise((resolve) => { releaseSlowEdit = resolve; });
  const { events, api } = pacedPlaceholder([undefined, slowEdit]);
  const client = new TelegramBotClient({
    api,
    thinkingNumbering: true,
    thinkingIntervalSeconds: 1,
  });
  const stream = await client.openDeliveryStream({ chatId: 42, chatType: 'private' });

  await stream.update({ kind: 'text', text: 'one', format: 'plain' });
  await stream.update({ kind: 'text', text: 'two', format: 'plain' });
  assert.deepEqual(events, ['edit 1. one'], 'the second frame waits for its window');

  await advance(t, 1_000);
  const finished = stream.finish({ kind: 'text', text: '## answer', format: 'markdown' });
  await flush();
  assert.deepEqual(events, ['edit 1. one'], 'finalization waits for the in-flight timer edit');

  releaseSlowEdit();
  await finished;

  assert.deepEqual(events, [
    'edit 1. one',
    'edit 2. two',
    'delete placeholder',
    'answer ## answer',
  ], 'the answer goes out only after the timer edit it was queued behind');
});

test('cancel() drops the pending window timer instead of sending the held frame later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { events, api } = pacedPlaceholder();
  const client = new TelegramBotClient({
    api,
    thinkingNumbering: true,
    thinkingIntervalSeconds: 2,
  });
  const stream = await client.openDeliveryStream({ chatId: 42, chatType: 'private' });

  await stream.update({ kind: 'text', text: 'one', format: 'plain' });
  await stream.update({ kind: 'text', text: 'two', format: 'plain' });
  assert.deepEqual(events, ['edit 1. one']);

  stream.cancel();
  await advance(t, 30_000);
  assert.deepEqual(events, ['edit 1. one'], 'a cancelled turn must not rewrite the placeholder later');
});

test('a window that expired unseen is cleared, so its overdue timer cannot release the next frame', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { events, api } = pacedPlaceholder();
  const client = new TelegramBotClient({
    api,
    thinkingNumbering: true,
    thinkingIntervalSeconds: 5,
  });
  const stream = await client.openDeliveryStream({ chatId: 42, chatType: 'private' });

  await stream.update({ kind: 'text', text: 'one', format: 'plain' });
  await stream.update({ kind: 'text', text: 'two', format: 'plain' });
  assert.deepEqual(events, ['edit 1. one'], 'the second frame is held in the first window');

  // The clock passes the window end without the timer running, the way a busy
  // event loop delays it, and the next frame opens a fresh window.
  t.mock.timers.setTime(6_000);
  await stream.update({ kind: 'text', text: 'three', format: 'plain' });
  await stream.update({ kind: 'text', text: 'four', format: 'plain' });
  assert.deepEqual(events, ['edit 1. one', 'edit 3. three']);

  // The overdue timer from the first window must be gone; the frame held now
  // belongs to the second window and waits for it to close.
  await advance(t, 1_000);
  assert.deepEqual(
    events,
    ['edit 1. one', 'edit 3. three'],
    'an expired window must not release the frame its successor holds',
  );
  await advance(t, 4_000);
  assert.deepEqual(events, ['edit 1. one', 'edit 3. three', 'edit 4. four']);
});
