import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  OUTBOUND_ARTIFACT_TOOL,
  OutboundArtifactRegistry,
  createOutboundArtifactTool,
  releaseOutboundArtifact,
} from '../../../src/channels/shared/semantic/artifact.mjs';
import { TelegramApi } from '../../../src/channels/telegram/telegram-api.mjs';
import { TelegramHarnessBridge } from '../../../src/channels/telegram/telegram-bridge.mjs';
import {
  splitTelegramRegularText,
  splitTelegramRichMarkdown,
  toTelegramRichMarkdown,
} from '../../../src/channels/telegram/telegram-rich-message.mjs';
import { TelegramBotClient } from '../../../src/channels/telegram/telegram-runtime.mjs';

const TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function rejected(code = 400) {
  const error = new Error(`Telegram ${code}`);
  error.code = `telegram-${code}`;
  error.status = code;
  error.providerCode = code;
  return error;
}

function uncertain(code = 'telegram-timeout') {
  const error = new Error('Telegram delivery is uncertain');
  error.code = code;
  error.deliveryOutcome = 'unknown';
  return error;
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

async function committedArtifact(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-im-telegram-rich-artifact-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const registry = new OutboundArtifactRegistry({ uuid: () => 'telegram-rich-artifact' });
  t.after(() => registry.clear());
  await writeFile(join(workspace, 'result.txt'), 'rich result');
  const agent = {
    session: {
      header: { id: 'session-rich-artifact', cwd: workspace },
      events: [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { turn: 1, source: { rpcId: 'rpc-rich-artifact' } } },
      ],
    },
  };
  const tool = createOutboundArtifactTool({ registry });
  const exec = {
    name: OUTBOUND_ARTIFACT_TOOL,
    callId: 'call-rich-artifact',
    rootCallId: 'call-rich-artifact',
    token: Symbol('call-rich-artifact'),
    agent,
  };
  await tool.definition.execute({ path: 'result.txt' }, exec);
  tool.onResult(exec, { isError: false });
  const artifact = registry.take('session-rich-artifact', 1)[0];
  t.after(() => releaseOutboundArtifact(artifact));
  return artifact;
}

test('Telegram Rich Markdown keeps structure while escaping raw and encoded HTML', () => {
  const source = [
    '# 标题 😀',
    '',
    '- 第一项',
    '  - 嵌套项',
    '',
    '```js',
    'const tag = "<script>";',
    '```',
    '',
    '| 名称 | 值 |',
    '| --- | --- |',
    '| 公式 | $E = mc^2$ |',
    '',
    '[链接](https://example.com/?a=1&b=2)',
    '<tg-thinking>hidden</tg-thinking>',
    '&lt;tg-thinking&gt;encoded&lt;/tg-thinking&gt;',
  ].join('\n');

  const rich = toTelegramRichMarkdown(source);
  assert.match(rich, /^# 标题 😀/);
  assert.match(rich, /```js/);
  assert.match(rich, /\| 公式 \| \$E = mc\^2\$ \|/);
  assert.match(rich, /\[链接\]\(https:\/\/example\.com\/\?a=1&amp;b=2\)/);
  assert.doesNotMatch(rich, /<tg-thinking>/);
  assert.match(rich, /&lt;tg-thinking&gt;hidden&lt;\/tg-thinking&gt;/);
  assert.match(rich, /&amp;lt;tg-thinking&amp;gt;/);
});

test('Telegram splitters preserve every space, newline, Emoji, and long fenced-code character', () => {
  const body = `  const emoji = '😀';\n\n${'中'.repeat(33_000)}  \n`;
  const source = `  ## 代码 😀\n\n\`\`\`js\n${body}\`\`\`\n\n  尾部  \n`;
  const chunks = splitTelegramRichMarkdown(source);

  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => Array.from(chunk.markdown).length <= 30_000));
  assert.equal(chunks.map((chunk) => chunk.source).join(''), source);
  assert.ok(chunks.filter((chunk) => chunk.markdown.includes('```js\n')).length >= 2);
  assert.equal(chunks.some((chunk) => chunk.source.includes('😀')), true);
  assert.throws(
    () => splitTelegramRichMarkdown('```js\nunfinished'),
    /unfinished code fence/,
  );
  const plain = `  开头 😀\n\n${'中'.repeat(4_001)} \n尾部  `;
  const plainChunks = splitTelegramRegularText(plain);
  assert.equal(plainChunks.map((chunk) => chunk).join(''), plain);
  assert.ok(plainChunks.every((chunk) => Array.from(chunk).length <= 4_000));
});

test('Telegram API uses the documented Rich Message, Draft, and rich edit fields', async () => {
  const calls = [];
  const api = new TelegramApi({
    token: TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ method: url.pathname.split('/').at(-1), body: JSON.parse(options.body) });
      return jsonResponse({ ok: true, result: { message_id: 701 } });
    },
  });

  await api.sendRichMessage({
    chatId: -100123,
    richMessage: { markdown: '# final' },
    replyToMessageId: 44,
    messageThreadId: 55,
  });
  await api.sendRichMessageDraft({
    chatId: 42,
    draftId: 9,
    richMessage: { markdown: 'partial' },
    messageThreadId: 66,
  });
  await api.editMessageText({
    chatId: -100123,
    messageId: 701,
    richMessage: { markdown: '# edited' },
  });

  assert.deepEqual(calls, [{
    method: 'sendRichMessage',
    body: {
      chat_id: -100123,
      rich_message: { markdown: '# final' },
      reply_parameters: { message_id: 44, allow_sending_without_reply: true },
      message_thread_id: 55,
    },
  }, {
    method: 'sendRichMessageDraft',
    body: {
      chat_id: 42,
      draft_id: 9,
      rich_message: { markdown: 'partial' },
      message_thread_id: 66,
    },
  }, {
    method: 'editMessageText',
    body: {
      chat_id: -100123,
      message_id: 701,
      rich_message: { markdown: '# edited' },
    },
  }]);
  await assert.rejects(() => api.sendRichMessage({
    chatId: 42,
    richMessage: { markdown: 'one', html: 'two' },
  }), /exactly one format/);
  await assert.rejects(() => api.sendRichMessageDraft({
    chatId: 42,
    draftId: 0,
    richMessage: { markdown: 'draft' },
  }), /non-zero integer/);
});

test('Telegram private stream reuses one non-zero Draft id and persists one Rich final', async () => {
  const drafts = [];
  const finals = [];
  const plain = [];
  const client = new TelegramBotClient({
    api: {
      sendRichMessageDraft: async (payload) => { drafts.push(payload); return true; },
      sendRichMessage: async (payload) => {
        finals.push(payload);
        return { message_id: 801 };
      },
      sendMessage: async (payload) => { plain.push(payload); return { message_id: 802 }; },
    },
    logger: { warn() {} },
  });
  const target = {
    chatId: 42,
    chatType: 'private',
    replyToMessageId: 44,
    messageThreadId: 66,
  };

  const stream = await client.openDeliveryStream(target);
  const draftResult = await stream.update({
    kind: 'text', text: '## partial', format: 'markdown',
  });
  const result = await stream.finish({ kind: 'text', text: '## final', format: 'markdown' });

  assert.equal(drafts.length, 2);
  assert.ok(Number.isSafeInteger(drafts[0].draftId) && drafts[0].draftId !== 0);
  assert.equal(drafts[1].draftId, drafts[0].draftId);
  assert.deepEqual(drafts.map((draft) => draft.messageThreadId), [66, 66]);
  assert.equal(finals.length, 1);
  assert.equal(finals[0].replyToMessageId, 44);
  assert.equal(finals[0].messageThreadId, 66);
  assert.deepEqual(finals[0].richMessage, { markdown: '## final' });
  assert.equal(plain.length, 0);
  assert.deepEqual(draftResult, {
    presentation: 'telegram-rich-draft',
    providerMessageIds: [],
    deliveryOutcome: 'sent',
  });
  assert.deepEqual(result, {
    presentation: 'telegram-rich-final',
    providerMessageIds: ['801'],
    deliveryOutcome: 'sent',
  });
});

test('Telegram group and Topic stream keeps one placeholder and finalizes it in place', async () => {
  const created = [];
  const edited = [];
  const drafts = [];
  const richSends = [];
  const client = new TelegramBotClient({
    api: {
      sendMessage: async (payload) => { created.push(payload); return { message_id: 901 }; },
      editMessageText: async (payload) => { edited.push(payload); return { message_id: 901 }; },
      sendRichMessageDraft: async (payload) => { drafts.push(payload); return true; },
      sendRichMessage: async (payload) => { richSends.push(payload); return { message_id: 902 }; },
    },
  });
  const target = {
    chatId: -100123,
    chatType: 'supergroup',
    replyToMessageId: 44,
    messageThreadId: 55,
  };

  const stream = await client.openDeliveryStream(target);
  await stream.update({ kind: 'text', text: '正在使用工具…', format: 'plain' });
  await stream.update({ kind: 'text', text: '## partial', format: 'markdown' });
  const result = await stream.finish({ kind: 'text', text: '## final', format: 'markdown' });

  assert.equal(created.length, 1);
  assert.equal(created[0].replyToMessageId, 44);
  assert.equal(created[0].messageThreadId, 55);
  assert.equal(drafts.length, 0);
  assert.equal(richSends.length, 0);
  assert.equal(edited.length, 3);
  assert.equal(edited[0].text, '正在使用工具…');
  assert.deepEqual(edited[1].richMessage, { markdown: '## partial' });
  assert.deepEqual(edited[2].richMessage, { markdown: '## final' });
  assert.ok(edited.every((call) => call.messageId === 901));
  assert.deepEqual(result, {
    presentation: 'telegram-rich-final',
    providerMessageIds: ['901'],
    deliveryOutcome: 'sent',
  });
});

test('Telegram long Rich final records the placeholder and every remainder message id', async () => {
  const edits = [];
  const remainders = [];
  const client = new TelegramBotClient({
    api: {
      sendMessage: async () => ({ message_id: 951 }),
      editMessageText: async (payload) => {
        edits.push(payload);
        return { message_id: 951 };
      },
      sendRichMessage: async (payload) => {
        remainders.push(payload);
        return { message_id: 952 + remainders.length };
      },
    },
  });
  const stream = await client.openDeliveryStream({
    chatId: -100123,
    chatType: 'supergroup',
    replyToMessageId: 44,
    messageThreadId: 55,
  });
  const answer = `## long\n\n${'中'.repeat(31_000)} 😀`;
  const result = await stream.finish({ kind: 'text', text: answer, format: 'markdown' });

  assert.equal(edits.length, 1);
  assert.ok(remainders.length >= 1);
  assert.ok(remainders.every((call) => call.messageThreadId === 55));
  assert.deepEqual(result.providerMessageIds, [
    '951',
    ...remainders.map((_, index) => String(953 + index)),
  ]);
  assert.equal(result.deliveryOutcome, 'sent');
});

test('Telegram final delivery degrades a definite Rich rejection directly to plain text', async () => {
  const calls = [];
  const client = new TelegramBotClient({
    api: {
      sendRichMessage: async (payload) => {
        calls.push({ method: 'rich', payload });
        throw rejected(400);
      },
      sendMessage: async (payload) => {
        calls.push({ method: 'plain', payload });
        return { message_id: 1001 };
      },
    },
  });
  const result = await client.sendDelivery({
    chatId: 42,
    chatType: 'private',
    replyToMessageId: 44,
  }, { kind: 'text', text: '<b>**answer**</b>', format: 'markdown' });

  assert.deepEqual(calls.map((call) => call.method), ['rich', 'plain']);
  assert.equal(calls[0].payload.richMessage.markdown, '&lt;b&gt;**answer**&lt;/b&gt;');
  assert.equal(calls[1].payload.text, '<b>**answer**</b>');
  assert.ok(calls.every((call) => call.payload.replyToMessageId === 44));
  assert.deepEqual(result, {
    presentation: 'text-fallback',
    providerMessageIds: ['1001'],
    deliveryOutcome: 'sent',
  });
});

test('Telegram conversion failure skips Rich and keeps the exact source in plain fallback', async () => {
  let richCalls = 0;
  const regular = [];
  const client = new TelegramBotClient({
    api: {
      sendRichMessage: async () => { richCalls += 1; return { message_id: 1050 }; },
      sendMessage: async (payload) => { regular.push(payload); return { message_id: 1051 }; },
    },
  });
  const result = await client.sendDelivery({ chatId: 42, replyToMessageId: 44 }, {
    kind: 'text', text: '```js\nunfinished <tag>', format: 'markdown',
  });

  assert.equal(richCalls, 0);
  assert.equal(regular.length, 1);
  assert.equal(regular[0].text, '```js\nunfinished <tag>');
  assert.equal(Object.hasOwn(regular[0], 'parseMode'), false);
  assert.equal(result.presentation, 'text-fallback');
});

test('Telegram group fallback edits the same placeholder and never sends a second final', async () => {
  const edits = [];
  let sends = 0;
  const client = new TelegramBotClient({
    api: {
      sendMessage: async () => { sends += 1; return { message_id: 1101 }; },
      editMessageText: async (payload) => {
        edits.push(payload);
        if (payload.richMessage) throw rejected(400);
        return { message_id: 1101 };
      },
      sendRichMessage: async () => assert.fail('short final must stay on the placeholder'),
    },
  });
  const stream = await client.openDeliveryStream({
    chatId: -100123,
    chatType: 'supergroup',
    replyToMessageId: 44,
    messageThreadId: 55,
  });
  const result = await stream.finish({ kind: 'text', text: '# final', format: 'markdown' });

  assert.equal(sends, 1);
  assert.equal(edits.length, 2);
  assert.ok(edits.every((edit) => edit.messageId === 1101));
  assert.deepEqual(edits.map((edit) => (edit.richMessage ? 'rich' : 'plain')), ['rich', 'plain']);
  assert.equal(result.presentation, 'text-fallback');
  assert.equal(result.deliveryOutcome, 'sent');
  assert.deepEqual(result.providerMessageIds, ['1101']);
});

test('Telegram replaces a rejected placeholder or records every failed terminalization attempt', async () => {
  const sends = [];
  const edits = [];
  const client = new TelegramBotClient({
    api: {
      sendMessage: async (payload) => {
        sends.push(payload);
        return { message_id: sends.length === 1 ? 1111 : 1112 };
      },
      editMessageText: async (payload) => {
        edits.push(payload);
        if (payload.richMessage || payload.text === '# final') throw rejected(400);
        return { message_id: 1111 };
      },
    },
    logger: { warn() {} },
  });
  const stream = await client.openDeliveryStream({
    chatId: -100123,
    chatType: 'supergroup',
    replyToMessageId: 44,
    messageThreadId: 55,
  });
  const result = await stream.finish({ kind: 'text', text: '# final', format: 'markdown' });

  assert.deepEqual(sends.map((call) => call.text), ['正在处理…', '# final']);
  assert.deepEqual(edits.map((call) => (
    call.richMessage ? 'rich' : call.text
  )), ['rich', '# final', '回复已发送。']);
  assert.deepEqual(result.providerMessageIds, ['1111', '1112']);
  assert.equal(result.deliveryOutcome, 'sent');

  const failedEdits = [];
  let failedSends = 0;
  const failedClient = new TelegramBotClient({
    api: {
      sendMessage: async (payload) => {
        failedSends += 1;
        if (failedSends === 1) return { message_id: 1121 };
        throw rejected(403);
      },
      editMessageText: async (payload) => {
        failedEdits.push(payload);
        throw rejected(403);
      },
    },
    logger: { warn() {} },
  });
  const failedStream = await failedClient.openDeliveryStream({
    chatId: -100123,
    chatType: 'supergroup',
    messageThreadId: 55,
  });
  const failedResult = await failedStream.finish({
    kind: 'text', text: '# final', format: 'markdown',
  });

  assert.equal(failedSends, 2);
  assert.deepEqual(failedEdits.map((call) => (
    call.richMessage ? 'rich' : call.text
  )), ['rich', '# final', '消息发送失败，请稍后重试。']);
  assert.equal(failedResult.deliveryOutcome, 'failed');
  assert.deepEqual(failedResult.providerMessageIds, ['1121']);
});

test('Telegram uncertain final delivery records unknown and never sends a fallback copy', async () => {
  let fallbacks = 0;
  const direct = new TelegramBotClient({
    api: {
      sendRichMessage: async () => { throw uncertain(); },
      sendMessage: async () => { fallbacks += 1; return { message_id: 1201 }; },
    },
  });
  const directResult = await direct.sendDelivery({
    chatId: 42,
    chatType: 'private',
    replyToMessageId: 44,
  }, { kind: 'text', text: '# final', format: 'markdown' });
  assert.equal(fallbacks, 0);
  assert.equal(directResult.deliveryOutcome, 'unknown');
  assert.equal(directResult.reason, 'telegram-timeout');

  const edits = [];
  const group = new TelegramBotClient({
    api: {
      sendMessage: async () => ({ message_id: 1202 }),
      editMessageText: async (payload) => {
        edits.push(payload);
        throw uncertain('telegram-500');
      },
      sendRichMessage: async () => assert.fail('must not send a fallback final'),
    },
  });
  const stream = await group.openDeliveryStream({
    chatId: -100123,
    chatType: 'supergroup',
    messageThreadId: 55,
  });
  const groupResult = await stream.finish({ kind: 'text', text: '# final', format: 'markdown' });
  assert.equal(edits.length, 1);
  assert.equal(groupResult.deliveryOutcome, 'unknown');
  assert.deepEqual(groupResult.providerMessageIds, ['1202']);
});

test('shared bridge surfaces a definite final delivery failure without rerunning Prompt or artifacts', async (t) => {
  for (const safeReplyFails of [false, true]) {
    await t.test(safeReplyFails ? 'safe reply also fails' : 'safe reply succeeds', async () => {
      const safeReplies = [];
      let prompts = 0;
      const stream = {
        providerMessageIds: ['failed-placeholder'],
        presentation: 'telegram-regular',
        async update() {},
        async finish() {
          return {
            presentation: 'telegram-rich-final',
            providerMessageIds: ['failed-placeholder'],
            deliveryOutcome: 'failed',
            reason: 'telegram-403',
          };
        },
        async fail() {
          return undefined;
        },
        cancel() {},
      };
      const bridge = new TelegramHarnessBridge({
        bot: {
          sendTyping: async () => {},
          openDeliveryStream: async () => stream,
          sendText: async (_target, text) => {
            safeReplies.push(text);
            if (safeReplyFails) throw rejected(403);
            return { message_id: 1261 };
          },
        },
        state: memoryState(),
        logger: { warn() {}, error() {} },
        harness: {
          createSession: async () => 'session-rich-artifact',
          ask: async () => {
            prompts += 1;
            return '## final';
          },
        },
      });

      const receipt = await bridge.accept({
        messageId: `definite-failure-${safeReplyFails}`,
        senderId: 'rich-user',
        kind: 'direct',
        conversationId: `definite-failure-${safeReplyFails}`,
        content: 'return a file',
        addressed: true,
        replyTarget: { chatId: 42, chatType: 'private', replyToMessageId: 44 },
      });

      assert.equal(prompts, 1);
      assert.equal(safeReplies.length, 1);
      assert.match(safeReplies[0], /回复已经生成，但当前渠道暂时无法发送/);
      assert.match(safeReplies[0], /错误码：CHANNEL_DELIVERY；参考号：MF-[A-F0-9]{8}/);
      assert.equal(receipt.deliveryOutcome, 'failed');
      assert.equal(receipt.reason, 'telegram-403');
      assert.deepEqual(receipt.artifacts, []);
      assert.equal(bridge.status.lastError, 'Channel message delivery failed');
    });
  }
});

test('shared bridge settles each artifact once before containing a definite text failure', async (t) => {
  const artifact = await committedArtifact(t);
  const sentFiles = [];
  let prompts = 0;
  let safeReplies = 0;
  const bridge = new TelegramHarnessBridge({
    bot: {
      sendTyping: async () => {},
      openDeliveryStream: async () => ({
        providerMessageIds: ['failed-placeholder'],
        presentation: 'telegram-regular',
        async update() {},
        async finish() {
          return {
            presentation: 'telegram-rich-final',
            providerMessageIds: ['failed-placeholder'],
            deliveryOutcome: 'failed',
            reason: 'telegram-403',
          };
        },
        cancel() {},
      }),
      sendText: async () => {
        safeReplies += 1;
        return { message_id: 1261 };
      },
      sendFile: async (_target, file) => {
        sentFiles.push(file.fileName);
        return { message_id: 1262 };
      },
    },
    state: memoryState(),
    logger: { warn() {}, error() {} },
    harness: {
      createSession: async () => 'session-rich-artifact',
      ask: async (_sessionId, _text, options) => {
        prompts += 1;
        await options.onArtifact(artifact);
        return '## final with file';
      },
    },
  });

  const receipt = await bridge.accept({
    messageId: 'definite-failure-with-file',
    senderId: 'rich-user',
    kind: 'direct',
    conversationId: 'definite-failure-with-file',
    content: 'return a file',
    addressed: true,
    replyTarget: { chatId: 42, chatType: 'private', replyToMessageId: 44 },
  });

  assert.equal(prompts, 1);
  assert.equal(safeReplies, 0);
  assert.deepEqual(sentFiles, ['result.txt']);
  assert.equal(receipt.deliveryOutcome, 'failed');
  assert.deepEqual(receipt.artifacts, [{
    artifactId: 'telegram-rich-artifact', outcome: 'sent',
  }]);
});

test('Telegram distinguishes pre-dispatch abort from an uncertain in-flight abort', async () => {
  const before = new AbortController();
  const beforeReason = new DOMException('stopped before dispatch', 'AbortError');
  before.abort(beforeReason);
  let beforeCalls = 0;
  const beforeClient = new TelegramBotClient({
    api: new TelegramApi({
      token: TOKEN,
      fetchImpl: async () => {
        beforeCalls += 1;
        return jsonResponse({ ok: true, result: { message_id: 1251 } });
      },
    }),
    signal: before.signal,
  });
  const beforeResult = await beforeClient.sendDelivery({ chatId: 42 }, {
    kind: 'text', text: '# final', format: 'markdown',
  });
  assert.equal(beforeCalls, 0);
  assert.equal(beforeResult.deliveryOutcome, 'failed');

  const after = new AbortController();
  let afterCalls = 0;
  let dispatchStarted;
  const started = new Promise((resolve) => { dispatchStarted = resolve; });
  const afterClient = new TelegramBotClient({
    api: new TelegramApi({
      token: TOKEN,
      fetchImpl: async (_url, { signal }) => {
        afterCalls += 1;
        dispatchStarted();
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    }),
    signal: after.signal,
  });
  const inFlight = afterClient.sendDelivery({ chatId: 42 }, {
    kind: 'text', text: '# final', format: 'markdown',
  });
  await started;
  after.abort(new DOMException('stopped after dispatch', 'AbortError'));
  const afterResult = await inFlight;
  assert.equal(afterCalls, 1);
  assert.equal(afterResult.deliveryOutcome, 'unknown');
  assert.equal(afterResult.reason, 'telegram-aborted-after-dispatch');
});

test('Telegram keeps an uncertain Rich receipt and still delivers the registered result file', async (t) => {
  const artifact = await committedArtifact(t);
  const sentFiles = [];
  const stream = {
    providerMessageIds: [],
    async update() {},
    async finish() {
      return {
        presentation: 'telegram-rich-final',
        providerMessageIds: [],
        deliveryOutcome: 'unknown',
        reason: 'telegram-timeout',
      };
    },
    cancel() {},
  };
  const bridge = new TelegramHarnessBridge({
    bot: {
      sendText: async () => assert.fail('must not replace an uncertain Rich final'),
      sendTyping: async () => {},
      openDeliveryStream: async () => stream,
      sendFile: async (_target, file) => {
        sentFiles.push(file.fileName);
        return { message_id: 1302 };
      },
    },
    state: memoryState(),
    harness: {
      createSession: async () => 'session-rich-artifact',
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '## final with file';
      },
    },
  });

  const receipt = await bridge.accept({
    messageId: 'rich-artifact-inbound',
    senderId: 'rich-user',
    kind: 'direct',
    conversationId: 'rich-user-artifact',
    content: 'return a file',
    addressed: true,
    replyTarget: { chatId: 42, chatType: 'private', replyToMessageId: 44 },
  });

  assert.deepEqual(sentFiles, ['result.txt']);
  assert.equal(receipt.presentation, 'telegram-text-and-files');
  assert.equal(receipt.deliveryOutcome, 'unknown');
  assert.equal(receipt.reason, 'telegram-timeout');
  assert.deepEqual(receipt.providerMessageIds, ['1302']);
  assert.deepEqual(receipt.artifacts, [{ artifactId: 'telegram-rich-artifact', outcome: 'sent' }]);
});

test('Telegram Rich text and a result file keep the placeholder and file message ids', async (t) => {
  const artifact = await committedArtifact(t);
  const sent = [];
  const edited = [];
  const files = [];
  let prompts = 0;
  const client = new TelegramBotClient({
    api: {
      sendChatAction: async () => true,
      sendMessage: async (payload) => {
        sent.push(payload);
        return { message_id: 1351 };
      },
      editMessageText: async (payload) => {
        edited.push(payload);
        return { message_id: 1351 };
      },
      sendDocument: async (payload) => {
        files.push(payload);
        return { message_id: 1352 };
      },
    },
  });
  const bridge = new TelegramHarnessBridge({
    bot: client,
    state: memoryState(),
    harness: {
      createSession: async () => 'session-rich-mixed',
      ask: async (_sessionId, _text, options) => {
        prompts += 1;
        await options.onArtifact(artifact);
        return '## final with file';
      },
    },
  });

  const receipt = await bridge.accept({
    messageId: 'rich-mixed-inbound',
    senderId: 'rich-user',
    kind: 'group',
    conversationId: '-100123:55',
    content: 'return text and a file',
    addressed: true,
    replyTarget: {
      chatId: -100123,
      chatType: 'supergroup',
      replyToMessageId: 44,
      messageThreadId: 55,
    },
  });

  assert.equal(prompts, 1);
  assert.deepEqual(sent.map((call) => call.text), ['正在处理…']);
  assert.deepEqual(edited.map((call) => call.richMessage), [{ markdown: '## final with file' }]);
  assert.equal(files.length, 1);
  assert.equal(files[0].replyToMessageId, 44);
  assert.equal(files[0].messageThreadId, 55);
  assert.equal(receipt.presentation, 'telegram-text-and-files');
  assert.equal(receipt.deliveryOutcome, 'sent');
  assert.deepEqual(receipt.providerMessageIds, ['1351', '1352']);
  assert.deepEqual(receipt.artifacts, [{ artifactId: 'telegram-rich-artifact', outcome: 'sent' }]);
});

test('shared bridge streams linear text with a refreshing status line', async () => {
  const blocks = [];
  const stream = {
    providerMessageIds: ['1301'],
    async update(block) { blocks.push(block); },
    async finish(block) {
      blocks.push(block);
      return {
        presentation: 'telegram-rich-final',
        providerMessageIds: ['1301'],
        deliveryOutcome: 'sent',
      };
    },
    cancel() {},
  };
  const bridge = new TelegramHarnessBridge({
    bot: {
      sendText: async () => assert.fail('semantic final must not use the legacy path'),
      sendTyping: async () => {},
      openDeliveryStream: async () => stream,
    },
    state: memoryState(),
    harness: {
      createSession: async () => 'session-rich',
      ask: async (_sessionId, _text, options) => {
        await options.onUpdate({ type: 'tool', name: '搜索' });
        await options.onUpdate({ type: 'text', text: '## partial' });
        return '## final';
      },
    },
  });

  const receipt = await bridge.accept({
    messageId: 'rich-inbound',
    senderId: 'rich-user',
    kind: 'direct',
    conversationId: 'rich-user',
    content: 'answer richly',
    addressed: true,
    replyTarget: { chatId: 42, chatType: 'private', replyToMessageId: 44 },
  });

  assert.deepEqual(blocks, [{
    kind: 'text', text: '🔧 正在使用搜索…', format: 'plain',
  }, {
    kind: 'text', text: '## partial\n\n🔧 正在使用搜索…', format: 'markdown',
  }, {
    kind: 'text', text: '## final', format: 'markdown',
  }]);
  assert.equal(receipt.presentation, 'telegram-rich-final');
  assert.equal(receipt.deliveryOutcome, 'sent');
});

test('Telegram stop runs one Prompt and replaces the group placeholder with one terminal message', async () => {
  const sent = [];
  const edits = [];
  let prompts = 0;
  const client = new TelegramBotClient({
    api: {
      sendChatAction: async () => true,
      sendMessage: async (payload) => { sent.push(payload); return { message_id: 1391 }; },
      editMessageText: async (payload) => { edits.push(payload); return { message_id: 1391 }; },
    },
  });
  const bridge = new TelegramHarnessBridge({
    bot: client,
    state: memoryState(),
    harness: {
      createSession: async () => 'session-rich-stop',
      ask: async () => {
        prompts += 1;
        const error = new Error('stopped');
        error.code = 'turn-stopped';
        throw error;
      },
    },
  });

  await bridge.accept({
    messageId: 'rich-stop-inbound',
    senderId: 'rich-user',
    kind: 'group',
    conversationId: '-100123:55',
    content: 'stop safely',
    addressed: true,
    replyTarget: {
      chatId: -100123,
      chatType: 'supergroup',
      replyToMessageId: 44,
      messageThreadId: 55,
    },
  });

  assert.equal(prompts, 1);
  assert.deepEqual(sent.map((call) => call.text), ['正在处理…']);
  assert.deepEqual(edits.map((call) => call.text), ['已停止。']);
  assert.ok(edits.every((call) => !call.richMessage));
});

test('Telegram group processing failure replaces its placeholder instead of leaving it stuck', async () => {
  const sent = [];
  const edits = [];
  let prompts = 0;
  const client = new TelegramBotClient({
    api: {
      sendChatAction: async () => true,
      sendMessage: async (payload) => { sent.push(payload); return { message_id: 1401 }; },
      editMessageText: async (payload) => { edits.push(payload); return { message_id: 1401 }; },
    },
  });
  const bridge = new TelegramHarnessBridge({
    bot: client,
    state: memoryState(),
    logger: { warn() {}, error() {} },
    harness: {
      createSession: async () => 'session-rich-error',
      ask: async () => {
        prompts += 1;
        throw new Error('private Harness diagnostic');
      },
    },
  });

  await bridge.accept({
    messageId: 'rich-error-inbound',
    senderId: 'rich-user',
    kind: 'group',
    conversationId: '-100123:55',
    content: 'fail safely',
    addressed: true,
    replyTarget: {
      chatId: -100123,
      chatType: 'supergroup',
      replyToMessageId: 44,
      messageThreadId: 55,
    },
  });

  assert.equal(prompts, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, '正在处理…');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].messageId, 1401);
  assert.match(edits[0].text, /任务未完成，暂时无法确定原因/);
  assert.match(edits[0].text, /错误码：INTERNAL_UNKNOWN；参考号：MF-[A-F0-9]{8}/);
  assert.equal(Object.hasOwn(edits[0], 'richMessage'), false);
});
