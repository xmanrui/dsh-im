import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { TelegramRuntime } from '../../../src/channels/telegram/telegram-runtime.mjs';
import { TelegramStateStore } from '../../../src/channels/telegram/state-store.mjs';

const TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456';
const CHAT_ID = 42;

/**
 * One full turn through the real runtime (config → bridge → bot client → Bot API
 * calls), with the API replaced by a recorder. This is the closest a unit test
 * gets to "what the reader's chat receives", and it is what pins the three
 * display rungs to an actual call sequence.
 */
async function runTurn(t, {
  presentationLevel, legacyThinkingTraces, numbering = false, intervalSeconds = 0,
  dropCallId = false, batchedResult = false, toolFailed = false,
  twoTools = false, unknownCallFirst = false,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), `dsh-im-level-${presentationLevel ?? 'legacy'}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = await new TelegramStateStore(join(directory, 'state.json')).load();
  const calls = [];
  let placeholderId = 900;
  let delivered = false;

  const fakeApi = {
    getMe: async () => ({ id: 123456789, is_bot: true, username: 'HarnessBot' }),
    getWebhookInfo: async () => ({ url: '' }),
    deleteMyCommands: async () => true,
    setMyCommands: async () => true,
    setChatMenuButton: async () => true,
    setMessageReaction: async () => true,
    getUpdates: async ({ offset, timeout, signal } = {}) => {
      if (timeout === 0) return [];
      // The runtime expects raw Bot API updates and normalizes them itself.
      if (offset <= 100) {
        return [{
          update_id: 100,
          message: {
            message_id: 100,
            date: 1_700_000_000,
            chat: { id: CHAT_ID, type: 'private' },
            from: { id: CHAT_ID, is_bot: false, first_name: 'Wings' },
            text: 'hello there',
          },
        }];
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    },
    sendMessage: async (request) => {
      calls.push({ method: 'send', text: request.text });
      placeholderId += 1;
      return { message_id: placeholderId };
    },
    editMessageText: async (request) => {
      calls.push({ method: 'edit', text: request.text });
      return true;
    },
    deleteMessage: async () => { calls.push({ method: 'delete' }); return true; },
    sendRichMessage: async (request) => {
      calls.push({ method: 'rich', text: request.richMessage?.markdown });
      delivered = true;
      return { message_id: 999 };
    },
    sendChatAction: async () => true,
  };

  const config = { botId: 'telegram_levels', platformId: '123456789', username: 'HarnessBot' };
  if (presentationLevel !== undefined) config.presentationLevel = presentationLevel;
  if (legacyThinkingTraces !== undefined) config.thinkingTraces = legacyThinkingTraces;
  if (numbering) config.thinkingNumbering = true;
  config.thinkingIntervalSeconds = intervalSeconds;

  const runtime = new TelegramRuntime({
    config,
    token: TOKEN,
    state,
    createApi: () => fakeApi,
    logger: { error() {}, warn() {}, info() {}, debug() {} },
    allowedPrivateUserIds: [String(CHAT_ID)],
    harness: {
      ensureRunning: async () => true,
      createSession: async () => 'session-levels',
      ask: async (_sessionId, _text, options) => {
        await options.onUpdate({ type: 'reasoning', step: 0, text: 'Let me check the directory.' });
        await options.onUpdate({ type: 'tool', name: 'bash', arguments: '{"command":"ls"}', ...(dropCallId ? {} : { callId: 'c1' }) });
        if (twoTools) {
          await options.onUpdate({ type: 'tool', name: 'grep', arguments: '{"pattern":"x"}', callId: 'c2' });
        }
        if (unknownCallFirst) {
          // A result naming a call we never recorded must not close anyone else's
          // line: the frame may have been merged away, and that tool still runs.
          await options.onUpdate({ type: 'status', toolName: 'bash', callId: 'zzz', text: '正在整理结果…' });
        }
        if (batchedResult) {
          // The shape Telegram actually receives: `progressMode: 'all'` means the
          // tracker is never "live", so results arrive as a status frame carrying
          // the tool name, its call id and (on failure) the error text.
          await options.onUpdate({
            type: 'status',
            toolName: 'bash',
            ...(dropCallId ? {} : { callId: 'c1' }),
            ...(toolFailed ? { error: 'exit code 1' } : {}),
            text: '正在整理结果…',
          });
        } else {
          await options.onUpdate({ type: 'tool-result', ...(dropCallId ? {} : { callId: 'c1' }), toolName: 'bash', text: 'a b c' });
        }
        await options.onUpdate({ type: 'text', text: 'Writing the answer…' });
        return '**final answer**';
      },
    },
  });

  await runtime.start();
  try {
    const deadline = Date.now() + 5_000;
    while (!delivered && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(delivered, 'the turn never delivered an answer');
    // Let the poll loop notice the abort before asserting on the recorder.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    await runtime.stop();
  }
  return calls;
}

test('runtime/minimal: one placeholder, deleted, then the answer', async (t) => {
  const calls = await runTurn(t, { presentationLevel: 'minimal' });
  assert.deepEqual(calls.map((call) => call.method), ['send', 'delete', 'rich']);
  assert.equal(calls[0].text, '正在处理…');
  assert.match(calls[2].text, /final answer/u);
});

test('runtime/standard: one message rewritten, then collapsed into a receipt', async (t) => {
  const calls = await runTurn(t, { presentationLevel: 'standard' });
  assert.deepEqual(calls.map((call) => call.method), ['send', 'edit', 'edit', 'rich']);
  assert.equal(calls[0].text, '正在处理…');
  assert.match(calls[1].text, /^⏳ 处理中 · \d+ 秒 · 1 步\n🔧 bash → ls$/);
  assert.match(calls[2].text, /^✅ 完成 · \d+ 秒 · 1 步$/);
  assert.match(calls[3].text, /final answer/u);
});

test('runtime/full: every thought and tool call is its own message, and a result edits its own line', async (t) => {
  const calls = await runTurn(t, { presentationLevel: 'full' });
  assert.deepEqual(calls.map((call) => call.method), ['send', 'send', 'edit', 'rich']);
  assert.match(calls[0].text, /^💭 Let me check the directory\.$/u);
  assert.match(calls[1].text, /^🔧 bash → ls$/u);
  // One call = one message: the outcome is appended to that line, not sent anew.
  assert.match(calls[2].text, /^🔧 bash → ls · ✓ \d+\.\ds$/u);
});

test('runtime: the legacy toggle still elects the every-line rung', async (t) => {
  const calls = await runTurn(t, { legacyThinkingTraces: true });
  assert.deepEqual(calls.map((call) => call.method), ['send', 'send', 'edit', 'rich']);
  assert.match(calls[2].text, /· ✓ \d+\.\ds$/u);
});

test('runtime: a bot with no stored level renders the new standard default', async (t) => {
  // Telegram always resolves a level (`presentationLevelFromConfig`): an absent
  // config is the compact default, not the old per-line flood.
  const calls = await runTurn(t, {});
  assert.deepEqual(calls.map((call) => call.method), ['send', 'edit', 'edit', 'rich']);
  assert.match(calls[1].text, /^⏳ 处理中 · \d+ 秒 · 1 步\n🔧 bash → /u);
  assert.match(calls[2].text, /^✅ 完成 · \d+ 秒 · 1 步$/u);
});

test('runtime/full with numbering: the outcome keeps the frame number', async (t) => {
  // A numbered trace line is rewritten when its result lands; dropping the number
  // there would break the sequence the reader is following.
  const calls = await runTurn(t, { presentationLevel: 'full', numbering: true, intervalSeconds: 0 });
  assert.deepEqual(calls.map((call) => call.method), ['send', 'send', 'edit', 'rich']);
  const sent = /^(\d+) 🔧 bash → ls$/u.exec(calls[1].text);
  assert.ok(sent, `the tool line carries its frame number, got ${calls[1].text}`);
  const edited = /^(\d+) 🔧 bash → ls · ✓ \d+\.\ds$/u.exec(calls[2].text);
  assert.ok(edited, `the settled line keeps a frame number, got ${calls[2].text}`);
  assert.equal(edited[1], sent[1], 'the number is the same before and after the edit');
});

test('runtime/full: a result without a call id still settles the waiting line', async (t) => {
  // The host does not always echo the call id on the result event; the oldest
  // unsettled line is then the one it belongs to (FIFO).
  const calls = await runTurn(t, { presentationLevel: 'full', dropCallId: true });
  assert.deepEqual(calls.map((call) => call.method), ['send', 'send', 'edit', 'rich']);
  assert.match(calls[2].text, /· ✓ \d+\.\ds$/u);
});

test('runtime/full: a batched turn settles the line from the status frame', async (t) => {
  // Telegram never gets a live `tool-result`; the result is a status frame.
  const calls = await runTurn(t, { presentationLevel: 'full', batchedResult: true });
  assert.deepEqual(calls.map((call) => call.method), ['send', 'send', 'edit', 'rich']);
  assert.match(calls[2].text, /· ✓ \d+\.\ds$/u);
});

test('runtime/full: a FAILED batched tool settles as a failure, not a tick', async (t) => {
  const calls = await runTurn(t, { presentationLevel: 'full', batchedResult: true, toolFailed: true });
  assert.deepEqual(calls.map((call) => call.method), ['send', 'send', 'edit', 'rich']);
  assert.match(calls[2].text, /· ⚠️ 失败 \d+\.\ds$/u);
  assert.doesNotMatch(calls[2].text, /✓/u);
});

test('runtime/full: an unknown call id settles nothing', async (t) => {
  const calls = await runTurn(t, {
    presentationLevel: 'full', twoTools: true, unknownCallFirst: true, batchedResult: true,
  });
  const edits = calls.filter((call) => call.method === 'edit');
  assert.equal(edits.length, 1, 'only the tool whose id matched was settled');
  assert.match(edits[0].text, /bash → ls · ✓/u);
  assert.ok(!edits.some((edit) => /grep/u.test(edit.text)), 'the other line must stay untouched');
});
