import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  HarnessReplyTracker,
  reasoningFromHarnessContent,
} from '../../../src/channels/shared/harness-client.mjs';
import {
  TelegramConfigStore,
} from '../../../src/channels/telegram/config-store.mjs';
import { TelegramController } from '../../../src/channels/telegram/telegram-controller.mjs';
import { TelegramHarnessBridge } from '../../../src/channels/telegram/telegram-bridge.mjs';
import {
  TelegramBotClient,
  formatToolTrace,
  formatThinkingLine,
  splitAnswerIntoMessages,
} from '../../../src/channels/telegram/telegram-runtime.mjs';

const TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456';

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

const quietLogger = { warn: () => {}, error: () => {}, debug: () => {} };

// --- A: format and split helpers ------------------------------------------

test('A1: formatToolTrace extracts the command summary', () => {
  assert.equal(formatToolTrace('bash', { command: 'ls -la /home/gin' }), '🔧 bash → ls -la /home/gin');
  assert.equal(formatToolTrace('bash', { arguments: null }), '🔧 bash', 'no usable argument must not add a summary');
});

test('A2: formatToolTrace prefers higher-priority fields', () => {
  const args = {
    command: 'make test',
    pattern: 'foo',
    query: 'bar',
    url: 'https://example.com',
    file_path: '/a/b',
    description: 'build the project',
  };
  assert.equal(formatToolTrace('bash', args), '🔧 bash → make test');
  assert.equal(formatToolTrace('bash', { pattern: 'foo', query: 'bar' }), '🔧 bash → foo');
  assert.equal(formatToolTrace('bash', { query: 'bar', file_path: '/a/b' }), '🔧 bash → bar');
  assert.equal(formatToolTrace('bash', { file_path: '/a/b', path: '/c/d' }), '🔧 bash → /a/b');
  assert.equal(formatToolTrace('bash', { message: 'hello', description: 'd' }), '🔧 bash → hello');
  assert.equal(formatToolTrace('bash', { description: 'd' }), '🔧 bash → d');
});

test('A3: formatToolTrace normalizes whitespace and caps long summaries', () => {
  assert.equal(formatToolTrace('bash', 'ls   -la\necho   hi'), '🔧 bash → ls -la echo hi');
  assert.equal(formatToolTrace('bash', { command: '  spaced\t\tcommand  ' }), '🔧 bash → spaced command');
  const long = 'x'.repeat(150);
  const line = formatToolTrace('bash', { command: long });
  assert.equal(line, `🔧 bash → ${'x'.repeat(120)}…`);
});

test('A4: formatThinkingLine truncates long reasoning at 200 chars', () => {
  const text = '推'.repeat(500);
  assert.equal(formatThinkingLine(text), `💭 ${'推'.repeat(200)}…`);
});

test('A5: formatThinkingLine uses only the first paragraph', () => {
  assert.equal(
    formatThinkingLine('第一段思考。\n\n第二段思考，更长的内容。'),
    '💭 第一段思考。',
  );
});

test('A6: formatThinkingLine returns null for empty reasoning', () => {
  assert.equal(formatThinkingLine(''), null);
  assert.equal(formatThinkingLine('   \n\t '), null);
  assert.equal(formatThinkingLine(null), null);
  assert.equal(formatThinkingLine(undefined), null);
});

test('A7: splitAnswerIntoMessages groups paragraphs up to 1600 chars', () => {
  const paragraphs = ['p'.repeat(500), 'q'.repeat(500), 'r'.repeat(500), 's'.repeat(500)];
  const messages = splitAnswerIntoMessages(paragraphs.join('\n\n'));
  assert.equal(messages.length, 2);
  for (const message of messages) assert.ok(message.length <= 4_000);
  assert.ok(messages[0].startsWith('p'.repeat(500)), 'paragraphs stay in order');
  assert.ok(messages[0].includes('q'.repeat(500)));
  assert.equal(messages[1].trim(), 's'.repeat(500));
  assert.equal(messages.join('\n\n'), paragraphs.join('\n\n'), 'no content is lost or reordered');
});

test('A8: splitAnswerIntoMessages hard-splits an oversized single paragraph', () => {
  const messages = splitAnswerIntoMessages('a'.repeat(12_000));
  assert.equal(messages.length, 3);
  for (const message of messages) assert.ok(message.length <= 4_000);
  assert.equal(messages.join(''), 'a'.repeat(12_000));
});

test('A8b: splitAnswerIntoMessages preserves indentation after a blank line', () => {
  // 空行后的代码缩进是内容：旧实现按段 trim 会把 `    return x` 变成 `return x`。
  const answer = 'def f():\n    x = 1\n\n    return x';
  assert.deepEqual(splitAnswerIntoMessages(answer), [answer]);
  // 超硬限段落跨片时，空行后的缩进段仍完整保留。
  const body = ('x'.repeat(50) + '\n').repeat(90); // 4590 字符 > 4000
  const longAnswer = `${body.trimEnd()}\n\n    return x`;
  const messages = splitAnswerIntoMessages(longAnswer);
  assert.ok(messages.every((message) => message.length <= 4_000));
  assert.ok(
    messages.some((message) => message.includes('    return x')),
    'the indented line keeps its four leading spaces',
  );
});

test('A8c: splitAnswerIntoMessages never cuts a surrogate pair at the boundary', () => {
  // 评审复现：3999 个 'a' + '😀'（limit 4000）时旧实现把 Emoji 拆成两个孤立代理项。
  const answer = 'a'.repeat(3999) + '😀' + 'b'.repeat(50);
  const messages = splitAnswerIntoMessages(answer);
  assert.ok(messages.every((message) => message.length <= 4_000));
  assert.equal(messages.join(''), answer);
  // 强断言：切点落在 Emoji 之前，代理项不跨片。
  assert.equal(messages[0], 'a'.repeat(3999));
  assert.ok(messages[1].startsWith('😀'));
});

// --- A9/A10: openThinkingStream over a stub api ---------------------------

test('A9: thinking stream sends each line as a separate plain message', async () => {
  const sent = [];
  const api = {
    sendMessage: async (params) => {
      sent.push(params);
      return { message_id: 1000 + sent.length };
    },
  };
  const client = new TelegramBotClient({ api, signal: undefined, logger: quietLogger });
  const stream = client.openThinkingStream({ chatId: 42, replyToMessageId: 7 });
  assert.equal(stream.keepalive, true);
  await stream.sendThinking('Let me list the directory first.');
  await stream.sendToolTrace('bash', { command: 'ls -la /home/gin' });
  const result = await stream.finish('The directory contains five items.');
  assert.equal(sent.length, 3);
  assert.equal(sent[0].text, '💭 Let me list the directory first.');
  assert.equal(sent[0].replyToMessageId, 7);
  assert.equal(sent[0].replyMarkup, undefined);
  assert.equal(sent[1].text, '🔧 bash → ls -la /home/gin');
  assert.equal(sent[1].replyToMessageId, undefined);
  assert.equal(sent[1].replyMarkup, undefined);
  assert.equal(sent[2].text, 'The directory contains five items.');
  assert.equal(result.presentation, 'telegram-thinking');
  assert.deepEqual(stream.providerMessageIds, ['1001', '1002', '1003']);
  await assert.rejects(stream.finish('again'), /already closed/);
});

test('A10: an empty final answer still sends one completion message', async () => {
  const sent = [];
  const api = {
    sendMessage: async (params) => { sent.push(params); return { message_id: sent.length + 2000 }; },
  };
  const client = new TelegramBotClient({ api, signal: undefined, logger: quietLogger });
  const stream = client.openThinkingStream({ chatId: 42 });
  await stream.sendThinking('thinking…');
  const result = await stream.finish('');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].text, '处理完成。');
  assert.equal(result.presentation, 'telegram-thinking');
});

test('A11: failing trace lines are best-effort; a failing finish falls back to sendText', async () => {
  const api = { sendMessage: async () => { throw new Error('network down'); } };
  const client = new TelegramBotClient({ api, signal: undefined, logger: quietLogger });
  const stream = client.openThinkingStream({ chatId: 42 });
  await stream.sendThinking('first');
  await stream.sendToolTrace('bash', { command: 'ls' });

  const sent = [];
  const apiTwo = {
    sendMessage: async (params) => {
      sent.push(params);
      if (sent.length === 1) throw new Error('network down');
      return { message_id: 4000 + sent.length };
    },
  };
  const clientTwo = new TelegramBotClient({ api: apiTwo, signal: undefined, logger: quietLogger });
  const streamTwo = clientTwo.openThinkingStream({ chatId: 42, replyToMessageId: 9 });
  const result = await streamTwo.finish('final answer');
  assert.equal(sent.length, 2, 'the failed send is followed by one sendText fallback');
  assert.equal(sent[0].text, 'final answer');
  assert.equal(sent[1].text, 'final answer');
  assert.deepEqual(result.providerMessageIds, ['4002']);
  assert.equal(result.deliveryOutcome, 'sent', 'the plain retry confirms delivery');
});

test('A11b: an unknown final-answer failure is not re-sent and keeps the unknown outcome', async () => {
  const sent = [];
  const api = {
    sendMessage: async (params) => {
      sent.push(params);
      const error = new Error('upstream timed out');
      error.code = 'telegram-timeout';
      throw error;
    },
  };
  const client = new TelegramBotClient({ api, signal: undefined, logger: quietLogger });
  const stream = client.openThinkingStream({ chatId: 42, replyToMessageId: 9 });
  const result = await stream.finish('final answer');
  assert.equal(sent.length, 1, 'unknown outcome: the message may have landed, so no re-send');
  assert.equal(result.deliveryOutcome, 'unknown');
  assert.equal(result.reason, 'telegram-timeout');
  assert.equal(result.presentation, 'telegram-thinking');
});

test('A12: a markdown final answer is delivered through the rich path', async () => {
  const plain = [];
  const rich = [];
  const api = {
    sendMessage: async (params) => { plain.push(params); return { message_id: 5000 + plain.length }; },
    sendRichMessage: async (params) => { rich.push(params); return { message_id: 6000 + rich.length }; },
  };
  const client = new TelegramBotClient({ api, signal: undefined, logger: quietLogger });
  const stream = client.openThinkingStream({ chatId: 42, replyToMessageId: 7 });
  await stream.sendThinking('Let me check.');
  const result = await stream.finish({ text: '**bold** answer', format: 'markdown' });
  assert.equal(rich.length, 1, 'markdown goes through sendRichMessage');
  assert.equal(rich[0].richMessage.markdown, '**bold** answer');
  // 过程消息仍是纯文本；最终答案没有走 plain 回退（只有那条 trace 行进了 plain）。
  assert.equal(plain.length, 1);
  assert.equal(plain[0].text, '💭 Let me check.');
  assert.equal(result.deliveryOutcome, 'sent');
  assert.deepEqual(stream.providerMessageIds, ['5001', '6001']);
});

test('A12b: a markdown final answer falls back to plain when the rich send is rejected', async () => {
  const plain = [];
  const rich = [];
  const api = {
    sendMessage: async (params) => { plain.push(params); return { message_id: 7000 + plain.length }; },
    sendRichMessage: async (params) => {
      rich.push(params);
      throw new Error('rich rejected');
    },
  };
  const client = new TelegramBotClient({ api, signal: undefined, logger: quietLogger });
  const stream = client.openThinkingStream({ chatId: 42 });
  const result = await stream.finish({ text: '**bold** answer', format: 'markdown' });
  assert.equal(rich.length, 1);
  assert.equal(plain.length, 1, 'definite rich failure falls back to one plain send');
  assert.equal(plain[0].text, '**bold** answer');
  assert.equal(result.deliveryOutcome, 'sent');
  assert.deepEqual(result.providerMessageIds, ['7001']);
});

// --- harness client: reasoning update emission -----------------------------

test('B0: the reply tracker emits a reasoning update alongside assistant-message', () => {
  const updates = [];
  const tracker = new HarnessReplyTracker({ promptRpcId: 'tt-prompt', afterSeq: 2, reasoning: true });
  for (const entry of [
    { event: { seq: 3, type: 'turn/start', data: { turn: 9 } } },
    { event: { seq: 4, type: 'user/message', data: { turn: 9, source: { rpcId: 'tt-prompt' } } } },
    { event: {
      seq: 5,
      type: 'assistant/message',
      data: {
        turn: 9,
        step: 0,
        message: {
          content: [
            { type: 'reasoning', text: 'Let me check the files first.' },
            { type: 'text', text: 'I will check the files.' },
          ],
        },
      },
    } },
  ]) {
    tracker.consumeAll([entry]).forEach((update) => updates.push(update));
  }
  assert.deepEqual(updates[0], { type: 'assistant-message', step: 0, text: 'I will check the files.' });
  assert.deepEqual(updates[1], { type: 'reasoning', step: 0, text: 'Let me check the files first.' });
  assert.equal(reasoningFromHarnessContent([{ type: 'text', text: 'x' }]), '');
  assert.equal(reasoningFromHarnessContent(null), '');
});

test('B0b: the default tracker does not emit reasoning updates for non-subscribed channels', () => {
  const updates = [];
  const tracker = new HarnessReplyTracker({ promptRpcId: 'tt-default', afterSeq: 2 });
  for (const entry of [
    { event: { seq: 3, type: 'turn/start', data: { turn: 9 } } },
    { event: { seq: 4, type: 'user/message', data: { turn: 9, source: { rpcId: 'tt-default' } } } },
    { event: {
      seq: 5,
      type: 'assistant/message',
      data: {
        turn: 9,
        step: 0,
        message: {
          content: [
            { type: 'reasoning', text: 'Let me check the files first.' },
            { type: 'text', text: 'I will check the files.' },
          ],
        },
      },
    } },
  ]) {
    tracker.consumeAll([entry]).forEach((update) => updates.push(update));
  }
  // 默认（非留痕订阅方）只见 canonical 定稿更新与既有 text 帧，reasoning 不进入
  // 进度流，钉钉/企微等渠道的 update.text 进度处理因此不会展示思考内容
  // （assistant-message 由各渠道现有处理显式忽略）。
  assert.deepEqual(updates, [
    { type: 'assistant-message', step: 0, text: 'I will check the files.' },
    { type: 'text', text: 'I will check the files.' },
  ]);
  assert.ok(!updates.some((update) => update.type === 'reasoning'));
});

// --- B: bridge thinking mode ----------------------------------------------

function thinkingBot({ lines, updates, openThinking, openDelivery }) {
  const bot = {
    sendText: async (target, text) => { lines.push(text); },
    sendTyping: async () => {},
  };
  if (openThinking) bot.openThinkingStream = openThinking;
  if (openDelivery) bot.openDeliveryStream = openDelivery;
  return bot;
}

function stubHarness({ onAsk }) {
  return {
    ensureRunning: async () => true,
    sessionExists: async () => true,
    createSession: async () => 'session-tt',
    ask: async (_session, _text, options) => {
      if (onAsk) await onAsk(options);
      return 'Final answer';
    },
  };
}

test('B1/B2: thinking mode surfaces 💭 and 🔧 lines only', async () => {
  const lines = [];
  const updates = [];
  const bot = thinkingBot({
    lines,
    updates,
    openThinking: async () => ({
      sendThinking: async (text) => { lines.push(text); },
      sendToolTrace: async (name, argumentsValue) => { lines.push(name, argumentsValue); },
      update: async (text) => { updates.push(text); },
      refresh: async () => {},
      finish: async (block) => { lines.push(block.text); },
      cancel: () => {},
      keepalive: true,
      presentation: 'telegram-thinking',
    }),
  });
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: stubHarness({
      onAsk: async (options) => {
        await options.onUpdate({ type: 'reasoning', step: 0, text: 'Let me list the directory first.' });
        await options.onUpdate({ type: 'tool', name: 'bash', arguments: '{"command":"ls -la /home/gin"}' });
        await options.onUpdate({ type: 'status', text: '正在整理结果…' });
        await options.onUpdate({ type: 'text', text: 'Streaming partial…' });
      },
    }),
    state: memoryState(),
    thinkingTraces: true,
    logger: quietLogger,
  });
  await bridge.accept({
    messageId: '1', senderId: 'u1', kind: 'direct', conversationId: 'u1',
    content: 'list the home directory', addressed: true,
    replyTarget: { chatId: 42, replyToMessageId: 7 },
  });
  assert.equal(lines[0], 'Let me list the directory first.');
  assert.equal(lines[1], 'bash');
  assert.equal(lines[2], '{"command":"ls -la /home/gin"}');
  assert.equal(lines[3], 'Final answer');
  assert.equal(updates.length, 0, 'status and text updates must not be sent as placeholder edits');
});

test('B3: keepalive refresh keeps firing during a long thinking turn', async () => {
  let refreshes = 0;
  let typings = 0;
  const lines = [];
  const bot = thinkingBot({
    lines,
    updates: [],
    openThinking: async () => ({
      sendThinking: async () => {},
      sendToolTrace: async () => {},
      update: async () => {},
      refresh: async () => { refreshes += 1; },
      finish: async (block) => { lines.push(block.text); },
      cancel: () => {},
      keepalive: true,
      presentation: 'telegram-thinking',
    }),
  });
  bot.sendTyping = async () => { typings += 1; };
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: stubHarness({
      onAsk: async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
      },
    }),
    state: memoryState(),
    thinkingTraces: true,
    keepaliveIntervalMs: 20,
    logger: quietLogger,
  });
  await bridge.accept({
    messageId: '1', senderId: 'u1', kind: 'direct', conversationId: 'u1',
    content: 'slow question', addressed: true,
    replyTarget: { chatId: 42, replyToMessageId: 7 },
  });
  assert.ok(refreshes >= 1, `expected at least one keepalive refresh, got ${refreshes}`);
  assert.ok(typings >= 1, 'keepalive must re-send the typing indicator');
});

// --- C: thinking stream failure falls back to the delivery stream ----------

test('C: a failing openThinkingStream falls back to the existing delivery stream', async () => {
  const lines = [];
  const updates = [];
  const bot = thinkingBot({
    lines,
    updates,
    openThinking: async () => { throw new Error('thinking stream unavailable'); },
    openDelivery: async () => ({
      update: async (block) => { updates.push(block.text); },
      finish: async (block) => { lines.push(block.text); },
      presentation: 'telegram-rich-draft',
    }),
  });
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: stubHarness({
      onAsk: async (options) => {
        await options.onUpdate({ type: 'reasoning', step: 0, text: 'should not be shown' });
        await options.onUpdate({ type: 'tool', name: 'bash', arguments: '{"command":"ls"}' });
        await options.onUpdate({ type: 'text', text: 'working…' });
      },
    }),
    state: memoryState(),
    thinkingTraces: true,
    logger: quietLogger,
  });
  await bridge.accept({
    messageId: '1', senderId: 'u1', kind: 'direct', conversationId: 'u1',
    content: 'hello', addressed: true,
    replyTarget: { chatId: 42, replyToMessageId: 7 },
  });
  assert.ok(updates.includes('working…'));
  assert.ok(updates.includes('正在使用bash…'));
  assert.ok(!updates.includes('should not be shown'), 'reasoning is not progress in fallback mode');
  assert.equal(lines[lines.length - 1], 'Final answer');
});

// --- D: toggle OFF keeps the legacy single-message behavior -----------------

test('D: thinkingTraces=false keeps placeholder editing and ignores reasoning', async () => {
  let openedThinking = false;
  const lines = [];
  const updates = [];
  const bot = thinkingBot({
    lines,
    updates,
    openThinking: async () => {
      openedThinking = true;
      return {
        sendThinking: async () => {},
        sendToolTrace: async () => {},
        finish: async (text) => { lines.push(text); },
      };
    },
    openDelivery: async () => ({
      update: async (block) => { updates.push(block.text); },
      finish: async (block) => { lines.push(block.text); },
      presentation: 'telegram-rich-draft',
    }),
  });
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: stubHarness({
      onAsk: async (options) => {
        await options.onUpdate({ type: 'reasoning', step: 0, text: 'hidden reasoning' });
        await options.onUpdate({ type: 'tool', name: 'bash', arguments: '{"command":"ls"}' });
        await options.onUpdate({ type: 'text', text: 'working…' });
      },
    }),
    state: memoryState(),
    thinkingTraces: false,
    logger: quietLogger,
  });
  await bridge.accept({
    messageId: '1', senderId: 'u1', kind: 'direct', conversationId: 'u1',
    content: 'hello', addressed: true,
    replyTarget: { chatId: 42, replyToMessageId: 7 },
  });
  assert.equal(openedThinking, false, 'the thinking stream must not be opened when the toggle is off');
  assert.ok(updates.includes('正在使用bash…'));
  assert.ok(updates.includes('working…'));
  assert.ok(!updates.includes('hidden reasoning'));
  assert.equal(lines[lines.length - 1], 'Final answer');
});

// --- config store + controller: persistence and status ---------------------

test('E1: an explicit thinkingTraces=false is persisted and reported, absent means ON', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-thinking-traces-'));
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
  const botId = bound.bots[0].botId;
  assert.equal(bound.bots[0].thinkingTraces, true, 'absent config means ON');

  const off = await controller.setThinkingTraces(botId, false);
  assert.equal(off.bots[0].thinkingTraces, false);
  assert.equal(configStore.get(botId).thinkingTraces, false);
  assert.ok(runtimeRecords.at(-1).config.thinkingTraces === false, 'the runtime restarts with the new config');

  const on = await controller.setThinkingTraces(botId, true);
  assert.equal(on.bots[0].thinkingTraces, true);
  assert.equal(configStore.get(botId).thinkingTraces, true);
});
