import assert from 'node:assert/strict';
import test from 'node:test';

import { createConversationQueue } from '../../../src/channels/shared/conversation-queue.mjs';
import {
  fillVoiceContent,
  voiceMessageAllowed,
} from '../../../src/channels/telegram/telegram-runtime.mjs';
import { VOICE_MAX_BYTES, VOICE_SAMPLE_RATE } from '../../../src/channels/telegram/voice.mjs';

const VOICE = Object.freeze({ fileId: 'file-1', fileName: 'voice.ogg', mimeType: 'audio/ogg', seconds: 7 });

function policyFor(mode, users = []) {
  const scope = mode === 'open'
    ? { mode: 'open', open: { defaultCanExecuteCommands: true, commandPermissionOverrides: [] }, allowlist: { users: [] } }
    : { mode: 'allowlist', open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] }, allowlist: { users } };
  return {
    getSettings: () => ({ direct: scope, group: scope }),
  };
}

const ALLOWED = Object.freeze({ kind: 'group', senderId: '111' });

test('access is decided before any download happens', () => {
  assert.equal(voiceMessageAllowed(null, ALLOWED), true, 'a missing provider keeps legacy behaviour');
  assert.equal(voiceMessageAllowed(policyFor('open'), ALLOWED), true);
  const allowlist = policyFor('allowlist', [{ id: '111', canExecuteCommands: false }]);
  assert.equal(voiceMessageAllowed(allowlist, ALLOWED), true);
  assert.equal(voiceMessageAllowed(allowlist, { kind: 'group', senderId: '222' }), false);
  // Private chats are addressed by definition, but the allowlist still applies.
  assert.equal(voiceMessageAllowed(allowlist, { kind: 'direct', senderId: '222' }), false);
});

function apiStub({ audio = Buffer.from('opus'), fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async downloadFile(request) {
      calls.push(request);
      if (fail) throw fail;
      return audio;
    },
  };
}

test('a transcript replaces the empty content and the download uses the voice limit', async () => {
  const api = apiStub();
  const message = { voice: VOICE };
  await fillVoiceContent({
    message,
    voice: VOICE,
    api,
    transcriber: { async transcribe() { return '  привет  '; } },
    timeoutMs: 5_000,
  });
  assert.equal(message.content, 'привет');
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].fileId, 'file-1');
  assert.equal(api.calls[0].maxBytes, VOICE_MAX_BYTES, 'the downloader gets the voice limit, not the image default');
  assert.ok(api.calls[0].signal instanceof AbortSignal);
});

test('the voice limit matches the sample rate contract used by the transcriber', () => {
  assert.equal(VOICE_SAMPLE_RATE, 16_000);
  assert.ok(VOICE_MAX_BYTES > 5 * 1024 * 1024, 'a 6 MiB recording must survive the download');
});

test('an empty transcript becomes the no-speech note', async () => {
  const message = { voice: VOICE };
  await fillVoiceContent({
    message, voice: VOICE, api: apiStub(),
    transcriber: { async transcribe() { return '   '; } },
  });
  assert.equal(message.content, '[voice message, 0:07; no speech recognized]');
});

test('a missing speech service becomes an explicit note', async () => {
  const message = { voice: VOICE };
  await fillVoiceContent({ message, voice: VOICE, api: apiStub(), transcriber: null });
  assert.equal(message.content, '[voice message, 0:07; speech recognition is not enabled in this Host]');
});

test('conversion failures become a note and are reported once', async () => {
  const reasons = [];
  const message = { voice: VOICE };
  const failure = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
  await fillVoiceContent({
    message, voice: VOICE, api: apiStub(),
    transcriber: { async transcribe() { throw failure; } },
    logFailure: (reason) => reasons.push(reason),
  });
  assert.equal(message.content, '[voice message, 0:07; ffmpeg is not installed]');
  assert.deepEqual(reasons, ['ffmpeg is not installed']);
});

test('a slow recognizer is cut off by its own deadline', async () => {
  const reasons = [];
  const message = { voice: VOICE };
  let sawAbort = false;
  const started = Date.now();
  await fillVoiceContent({
    message,
    voice: VOICE,
    api: apiStub(),
    timeoutMs: 30,
    transcriber: {
      transcribe({ signal }) {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            sawAbort = true;
            reject(new Error('aborted'));
          }, { once: true });
        });
      },
    },
    logFailure: (reason) => reasons.push(reason),
  });
  assert.ok(Date.now() - started < 1_000, 'the deadline is respected');
  assert.equal(sawAbort, true, 'the provider sees the cancellation');
  assert.equal(message.content, '[voice message, 0:07; transcription timed out after 30ms]');
  assert.deepEqual(reasons, ['transcription timed out after 30ms']);
});

test('runtime shutdown leaves the message untouched instead of writing a note', async () => {
  const controller = new AbortController();
  const message = { voice: VOICE };
  controller.abort();
  await fillVoiceContent({
    message, voice: VOICE, api: apiStub(),
    transcriber: { async transcribe() { throw new Error('aborted'); } },
    signal: controller.signal,
  });
  assert.equal(message.content, undefined);
});

test('per-conversation work is ordered while other conversations proceed', async () => {
  const queue = createConversationQueue();
  const order = [];
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = queue.run('chat-a', async () => {
    order.push('a1-start');
    await gate;
    order.push('a1-end');
  });
  const second = queue.run('chat-a', async () => { order.push('a2'); });
  const other = queue.run('chat-b', async () => { order.push('b1'); });

  await other;
  assert.deepEqual(order, ['a1-start', 'b1'], 'another conversation is not blocked');
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['a1-start', 'b1', 'a1-end', 'a2'], 'one chat keeps its order');
  await queue.idle();
  assert.equal(queue.size(), 0, 'a settled chain holds no state');
});

test('a failing task does not break the chain of its conversation', async () => {
  const errors = [];
  const queue = createConversationQueue({ onError: (error, key) => errors.push([key, error.message]) });
  await queue.run('chat-a', async () => { throw new Error('boom'); });
  const value = await queue.run('chat-a', async () => 'ok');
  assert.equal(value, 'ok');
  assert.deepEqual(errors, [['chat-a', 'boom']]);
});
