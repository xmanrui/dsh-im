import assert from 'node:assert/strict';
import test from 'node:test';

import { TelegramBotClient } from '../../../src/channels/telegram/telegram-runtime.mjs';

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
  const edits = [];
  const api = {
    sendMessage: async (params) => {
      sent.push(params);
      return { message_id: 5000 + sent.length };
    },
    editMessageText: async (params) => {
      edits.push(params);
      return true;
    },
  };
  return { sent, edits, api };
}

test('a tool trace held by the cadence window is settled on its released message', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { sent, edits, api } = recorder();
  const client = new TelegramBotClient({
    api, signal: undefined, logger: quietLogger, thinkingIntervalSeconds: 3,
  });
  const stream = client.openThinkingStream({ chatId: 42 });
  // The first frame opens the window; the tool trace below lands inside it.
  await stream.sendThinking('checking');
  assert.equal(sent.length, 1);

  const delivered = await stream.sendToolTrace('bash', { command: 'ls' }, 'call-1');
  assert.equal(delivered, null, 'inside the window the trace is held, not sent');
  assert.equal(sent.length, 1);

  await advance(t, 3_000);
  assert.equal(sent.length, 2, 'the timer releases the held tool trace');
  assert.equal(sent[1].text, '🔧 bash → ls');
  const messageId = 5000 + 2;

  await stream.settleToolTrace({ callId: 'call-1', ok: true });
  assert.equal(edits.length, 1, 'the result rewrites the released trace line');
  assert.equal(edits[0].messageId, messageId);
  assert.match(edits[0].text, /✓/u, 'the line stops claiming to be running');
});

test('a held tool trace replaced by a newer frame never registers its call id', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { sent, edits, api } = recorder();
  const client = new TelegramBotClient({
    api, signal: undefined, logger: quietLogger, thinkingIntervalSeconds: 5,
  });
  const stream = client.openThinkingStream({ chatId: 42 });
  await stream.sendThinking('checking');
  await advance(t, 1_000);

  assert.equal(await stream.sendToolTrace('bash', { command: 'ls' }, 'call-old'), null);
  // The deadline passes while the held frame's timer is still queued; the newer
  // frame supersedes it and goes out alone.
  t.mock.timers.setTime(Date.now() + 5_000);
  const delivered = await stream.sendToolTrace('grep', { pattern: 'x' }, 'call-new');
  assert.equal(delivered, 5000 + 2, 'the newer frame is sent immediately');
  assert.deepEqual(sent.map((params) => params.text), ['💭 checking', '🔧 grep → x']);

  await advance(t, 10_000);
  assert.equal(sent.length, 2, 'the superseded timer must not deliver the dropped frame');

  await stream.settleToolTrace({ callId: 'call-old', ok: true });
  assert.equal(edits.length, 0, 'an unknown call id must not close another line');

  await stream.settleToolTrace({ callId: 'call-new', ok: true });
  assert.equal(edits.length, 1);
  assert.equal(edits[0].messageId, 5000 + 2);
  assert.match(edits[0].text, /grep/u);
  assert.match(edits[0].text, /✓/u);
});
