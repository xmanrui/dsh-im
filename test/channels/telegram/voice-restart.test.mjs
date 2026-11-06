import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { TelegramRuntime } from '../../../src/channels/telegram/telegram-runtime.mjs';
import { TelegramStateStore } from '../../../src/channels/telegram/state-store.mjs';

const TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456';
// A private chat is always addressed, so preparation is queued for it.
const CHAT = 42;

const voiceUpdate = {
  update_id: 1,
  message: {
    message_id: 11,
    chat: { id: CHAT, type: 'private' },
    from: { id: 111, first_name: 'Ann' },
    date: 1_700_000_000,
    voice: { file_id: 'voice-1', duration: 7, mime_type: 'audio/ogg' },
  },
};

const textUpdate = {
  update_id: 2,
  message: {
    message_id: 12,
    chat: { id: CHAT, type: 'private' },
    from: { id: 111, first_name: 'Ann' },
    date: 1_700_000_001,
    text: 'follow-up',
  },
};

async function waitFor(predicate, timeoutMs = 2_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

/** A fake Bot API whose long poll waits a tick so the loop cannot spin. */
function fakeApi({ updates = [], onDownload = () => {} } = {}) {
  return {
    downloads: [],
    async getMe() { return { id: 123456789, is_bot: true }; },
    async getWebhookInfo() { return { url: '' }; },
    async setMyCommands() { return true; },
    async setChatMenuButton() { return true; },
    async getUpdates({ offset, timeout, signal }) {
      if (timeout === 0) return [];
      if (updates.length > 0 && offset <= 2) {
        return updates.filter((update) => update.update_id >= offset);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve([]), 20);
        timer.unref?.();
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error('aborted'));
        }, { once: true });
      });
    },
    async downloadFile(request) {
      onDownload(request);
      return Buffer.from('opus-bytes');
    },
    async sendMessage() { return { message_id: 900 }; },
    async sendChatAction() { return true; },
  };
}

const silentLogger = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };

function runtimeWith(state, api, { voice } = {}) {
  return new TelegramRuntime({
    config: { botId: 'telegram_test', platformId: '123456789', username: 'harness_bot' },
    token: TOKEN,
    harness: { ensureRunning: async () => true },
    state,
    voice: voice ?? { async transcribe() { return 'transcribed text'; } },
    createApi: () => api,
    logger: silentLogger,
  });
}

test('a queued voice message is persisted before its update is acknowledged', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-voice-durable-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = await new TelegramStateStore(join(directory, 'state.json')).load();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const api = fakeApi({ updates: [voiceUpdate, textUpdate] });
  const runtime = runtimeWith(state, api, {
    voice: { async transcribe() { await gate; return 'transcribed text'; } },
  });
  await runtime.start();
  try {
    assert.equal(
      await waitFor(() => state.pendingMessages().some((entry) => entry.target?.voiceReplay)),
      true,
      'the queued voice message is durable',
    );
    const entry = state.pendingMessages().find((item) => item.target?.voiceReplay);
    assert.equal(entry.target.voiceReplay.update.update_id, 1);
    assert.equal(entry.key, String(CHAT));
    assert.equal(
      await waitFor(() => state.cursor() >= 2),
      true,
      'the following update is processed while preparation is still running',
    );
    assert.equal(
      state.pendingMessages().some((item) => item.target?.voiceReplay),
      true,
      'acknowledging the cursor does not drop the queued work',
    );
  } finally {
    // Let the queued preparation finish, then shut the runtime down.
    release();
    assert.equal(
      await waitFor(() => !state.pendingMessages().some((item) => item.target?.voiceReplay)),
      true,
      'the record is cleared once the bridge owns the message',
    );
    await runtime.stop();
  }
});

test('a persisted pending voice update is replayed on the next start', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-voice-replay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = await new TelegramStateStore(join(directory, 'state.json')).load();
  // Simulate a restart that happened while preparation was still queued.
  await state.putPendingMessage({
    id: `telegram-voice:${voiceUpdate.update_id}`,
    key: String(CHAT),
    messageId: String(voiceUpdate.message.message_id),
    kind: 'direct',
    text: '[voice message, 0:07; transcription pending]',
    senderId: String(voiceUpdate.message.from.id),
    target: { voiceReplay: { update: voiceUpdate } },
  });

  const downloads = [];
  const api = fakeApi({ updates: [], onDownload: (request) => downloads.push(request) });
  const runtime = runtimeWith(state, api);
  await runtime.start();
  try {
    assert.equal(await waitFor(() => downloads.length > 0), true, 'the recording is fetched again');
    assert.equal(downloads[0].fileId, 'voice-1');
    assert.equal(
      await waitFor(() => state.pendingMessages().length === 0),
      true,
      'the record is cleared once the bridge owns the message',
    );
  } finally {
    await runtime.stop();
  }
});
