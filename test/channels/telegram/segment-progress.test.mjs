import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  DEFAULT_SEGMENT_PREFIX,
  normalizeSegmentPrefix,
  normalizeSegmentProgress,
} from '../../../src/channels/shared/progress-segment.mjs';
import { TelegramConfigStore } from '../../../src/channels/telegram/config-store.mjs';
import { TelegramController } from '../../../src/channels/telegram/telegram-controller.mjs';
import { TelegramBotClient } from '../../../src/channels/telegram/telegram-runtime.mjs';
import { TelegramHarnessBridge } from '../../../src/channels/telegram/telegram-bridge.mjs';
import { ThinkingTracesSettings } from '../../../plugin-src/client/channels/telegram/thinking-traces.js';
import {
  validSegmentPrefixPayload,
  validSegmentProgressPayload,
} from '../../../plugin-src/host/channels/shared/segment-progress-rpc.mjs';

const TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456';

const quietLogger = { warn: () => {}, error: () => {}, debug: () => {} };

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

function stubHarness({ onAsk, answer = 'Final answer' }) {
  return {
    ensureRunning: async () => true,
    sessionExists: async () => true,
    createSession: async () => 'session-segments',
    ask: async (_session, _text, options) => {
      if (onAsk) await onAsk(options);
      return answer;
    },
  };
}

async function controllerFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-segments-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'config.json');
  const configStore = await new TelegramConfigStore(configPath).load();
  const controller = new TelegramController({
    credentials: credentials(),
    configStore,
    inspectToken: async () => ({
      platformId: '123456789', name: 'Harness Telegram', username: 'harness_bot',
    }),
    createRuntime: async () => ({
      status: { ready: true, connectionState: 'connected', harnessReachable: true, lastCheckedAt: 10 },
      async start() {},
      async stop() {},
    }),
  });
  const bound = await controller.bindCredentials({ token: TOKEN });
  return { controller, botId: bound.bots[0].botId };
}

// --- A: normalization and RPC payloads ------------------------------------

test('A1: only an explicit true enables segments', () => {
  assert.equal(normalizeSegmentProgress(true), true);
  assert.equal(normalizeSegmentProgress(false), false);
  assert.equal(normalizeSegmentProgress('true'), false);
  assert.equal(normalizeSegmentProgress(undefined), false);
});

test('A2: the prefix keeps text, spaces and emoji, and counts code points', () => {
  assert.equal(DEFAULT_SEGMENT_PREFIX, '🤤 ');
  assert.equal(normalizeSegmentPrefix('🤤 '), '🤤 ');
  assert.equal(normalizeSegmentPrefix('[过程] '), '[过程] ');
  assert.equal(normalizeSegmentPrefix(''), '', 'an empty prefix means no marker');
  assert.equal(normalizeSegmentPrefix(null), DEFAULT_SEGMENT_PREFIX);
  assert.equal(normalizeSegmentPrefix('a\nb'), 'a b', 'newlines never leak into a message');
  const longEmoji = '🤤'.repeat(40);
  assert.equal([...normalizeSegmentPrefix(longEmoji)].length, 32);
});

test('A3: RPC payloads are validated strictly', () => {
  assert.equal(validSegmentProgressPayload({
    botId: 'telegram_1', segmentProgress: true,
  }), true);
  assert.equal(validSegmentProgressPayload({
    botId: 'telegram_1', segmentProgress: true, extra: 1,
  }), false);
  assert.equal(validSegmentProgressPayload({ botId: 'telegram_1' }), false);
  assert.equal(validSegmentProgressPayload({
    botId: 'telegram_1', segmentProgress: 'yes',
  }), false);

  assert.equal(validSegmentPrefixPayload({
    botId: 'telegram_1', segmentPrefix: '🤤 ',
  }), true);
  assert.equal(validSegmentPrefixPayload({
    botId: 'telegram_1', segmentPrefix: '🤤'.repeat(33),
  }), false);
  assert.equal(validSegmentPrefixPayload({
    botId: 'telegram_1', segmentPrefix: 3,
  }), false);
  assert.equal(validSegmentPrefixPayload({
    botId: 'telegram_1', segmentPrefix: 'x', segmentProgress: true,
  }), false);
});

// --- B: controller status and setters --------------------------------------

test('B1: controller exposes and persists the segment settings', async (t) => {
  const { controller, botId } = await controllerFixture(t);
  let status = controller.status();
  assert.equal(status.bots[0].segmentProgress, false, 'off by default');
  assert.equal(status.bots[0].segmentPrefix, DEFAULT_SEGMENT_PREFIX);

  status = await controller.setSegmentProgress(botId, true);
  assert.equal(status.bots[0].segmentProgress, true);

  status = await controller.setSegmentPrefix(botId, '[过程] ');
  assert.equal(status.bots[0].segmentPrefix, '[过程] ');

  status = await controller.setSegmentProgress(botId, false);
  assert.equal(status.bots[0].segmentProgress, false);
});

// --- C: bridge routing -----------------------------------------------------

function deliveryBot({ segments, updates, finished }) {
  return {
    sendText: async () => {},
    sendTyping: async () => {},
    openDeliveryStream: async () => ({
      sendSegment: async (text) => { segments.push(text); return true; },
      update: async (block) => { updates.push(block.text ?? block); },
      finish: async (block) => { finished.push(block.text); },
      cancel: () => {},
      presentation: 'telegram-regular',
      previewAnswer: false,
    }),
  };
}

test('C1: assistant notes become segments; tool calls flush the previous note', async () => {
  const segments = [];
  const updates = [];
  const finished = [];
  const bridge = new TelegramHarnessBridge({
    bot: deliveryBot({ segments, updates, finished }),
    harness: stubHarness({
      answer: '我先看目录\n验证通过。',
      onAsk: async (options) => {
        await options.onUpdate({ type: 'assistant-message', step: 0, text: '我先看目录' });
        await options.onUpdate({ type: 'tool', name: 'bash', arguments: '{"command":"ls"}' });
        await options.onUpdate({ type: 'text', text: '我先看目录' });
        await options.onUpdate({ type: 'assistant-message', step: 1, text: '验证通过。' });
      },
    }),
    state: memoryState(),
    segmentProgress: true,
    logger: quietLogger,
  });
  await bridge.accept({
    messageId: '1', senderId: 'u1', kind: 'direct', conversationId: 'u1',
    content: 'check the directory', addressed: true,
    replyTarget: { chatId: 42, replyToMessageId: 7 },
  });
  assert.deepEqual(segments, ['我先看目录'], 'only the earlier note goes out as a segment');
  assert.ok(updates.some((text) => text.includes('bash')), 'the tool keeps the placeholder line');
  assert.deepEqual(finished, ['验证通过。'], 'the last note is the answer, never duplicated');
});

test('C2: with segments off the bridge behaves exactly as before', async () => {
  const segments = [];
  const updates = [];
  const finished = [];
  const bridge = new TelegramHarnessBridge({
    bot: deliveryBot({ segments, updates, finished }),
    harness: stubHarness({
      answer: 'I will check the files.',
      onAsk: async (options) => {
        await options.onUpdate({ type: 'assistant-message', step: 0, text: 'I will check the files.' });
        await options.onUpdate({ type: 'text', text: 'I will check the files.' });
      },
    }),
    state: memoryState(),
    logger: quietLogger,
  });
  await bridge.accept({
    messageId: '2', senderId: 'u1', kind: 'direct', conversationId: 'u1',
    content: 'check the files', addressed: true,
    replyTarget: { chatId: 42, replyToMessageId: 7 },
  });
  assert.deepEqual(segments, [], 'a closed setting never sends segments');
  assert.deepEqual(finished, ['I will check the files.']);
});

test('C3: thinking traces win over segments', async () => {
  const segments = [];
  const lines = [];
  const bot = {
    sendText: async () => {},
    sendTyping: async () => {},
    openThinkingStream: async () => ({
      sendThinking: async (text) => { lines.push(text); },
      sendToolTrace: async (name) => { lines.push(name); },
      update: async () => {},
      refresh: async () => {},
      finish: async (block) => { lines.push(block.text); },
      cancel: () => {},
      keepalive: true,
      presentation: 'telegram-thinking',
    }),
    openDeliveryStream: async () => ({
      sendSegment: async (text) => { segments.push(text); return true; },
      update: async () => {},
      finish: async () => {},
      cancel: () => {},
      presentation: 'telegram-regular',
      previewAnswer: false,
    }),
  };
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: stubHarness({
      answer: 'done',
      onAsk: async (options) => {
        await options.onUpdate({ type: 'reasoning', text: 'thinking' });
        await options.onUpdate({ type: 'assistant-message', step: 0, text: 'note' });
      },
    }),
    state: memoryState(),
    thinkingTraces: true,
    segmentProgress: true,
    logger: quietLogger,
  });
  await bridge.accept({
    messageId: '3', senderId: 'u1', kind: 'direct', conversationId: 'u1',
    content: 'go', addressed: true,
    replyTarget: { chatId: 42, replyToMessageId: 7 },
  });
  assert.deepEqual(segments, [], 'segments stay off while traces drive the stream');
  assert.deepEqual(lines, ['thinking', 'done'], 'assistant notes stay out of the trace stream');
});

// --- D: Telegram sendSegment ----------------------------------------------

test('D1: segments carry the configured prefix and only the first one replies', async () => {
  const requests = [];
  const api = {
    sendMessage: async (params) => {
      requests.push(params);
      return { message_id: 5001 };
    },
    sendRichMessage: async (params) => {
      requests.push(params);
      return { message_id: 6000 + requests.length };
    },
  };
  const client = new TelegramBotClient({
    api, signal: undefined, logger: quietLogger, segmentPrefix: '[过程] ',
  });
  const stream = await client.openDeliveryStream({ chatId: 42, replyToMessageId: 7 });
  await stream.sendSegment('我先看目录');
  await stream.sendSegment('验证通过');
  const segments = requests.filter((request) => request.richMessage);
  assert.equal(segments.length, 2);
  assert.ok(segments[0].richMessage.markdown.includes('[过程] 我先看目录'));
  assert.equal(segments[0].replyToMessageId, 7);
  assert.equal(segments[1].replyToMessageId, undefined, 'no reply chain for later segments');
});

test('D2: a rejected rich segment falls back to plain and still succeeds', async () => {
  const plain = [];
  const api = {
    sendMessage: async (params) => {
      plain.push(params);
      return { message_id: 5000 + plain.length };
    },
    sendRichMessage: async () => {
      const error = new Error('rich rejected');
      throw error;
    },
  };
  const client = new TelegramBotClient({ api, signal: undefined, logger: quietLogger });
  const stream = await client.openDeliveryStream({ chatId: 42 });
  assert.equal(await stream.sendSegment('note'), true);
  assert.ok(plain.some((params) => String(params.text).includes('note')), 'the note still reaches the chat');
});

// --- E: settings UI -------------------------------------------------------

test('E1: the behavior panel renders the segment switch and prefix field', () => {
  const markup = renderToStaticMarkup(React.createElement(ThinkingTracesSettings, {
    account: {
      botId: 'telegram_1',
      thinkingTraces: true,
      thinkingNumbering: false,
      thinkingIntervalSeconds: 0,
      sendLimitPerMinute: 30,
      segmentProgress: true,
      segmentPrefix: '[过程] ',
    },
    busy: false,
    onSave() {},
    rpcCall: async () => ({ ok: true, value: {} }),
    endpoints: {
      setSegmentProgress: 'bot.segment-progress.set',
      setSegmentPrefix: 'bot.segment-prefix.set',
    },
    onChanged() {},
  }));
  assert.match(markup, /过程说明分段/);
  assert.match(markup, /分段消息前缀/);
  assert.match(markup, /value="\[过程\] "/);
});
