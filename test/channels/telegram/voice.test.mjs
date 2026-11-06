import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  VOICE_SAMPLE_RATE,
  createTelegramVoiceTranscriber,
  formatVoiceDuration,
  isCanonicalWav,
  telegramVoiceSource,
  voiceFailureReason,
  voiceNote,
  wrapCanonicalWav,
} from '../../../src/channels/telegram/voice.mjs';
import { normalizeTelegramUpdate } from '../../../src/channels/telegram/telegram-runtime.mjs';

const BOT = 999;

/** A real temp directory, so the transcriber can write into it. */
function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), 'dsh-voice-test-'));
}

function update(message) {
  return {
    update_id: 1,
    message: {
      message_id: 7,
      date: 1_700_000_000,
      chat: { id: -1001234567890, type: 'supergroup', title: 'Team' },
      from: { id: 111, first_name: 'Ann' },
      ...message,
    },
  };
}

/** Records the transcription request and answers with fixed text. */
function speechService({ text = 'привет', fail = null } = {}) {
  const calls = { resolve: [], transcribe: 0 };
  return {
    calls,
    resolve(request) {
      calls.resolve.push(request);
      return { ...request, provider: { info: { id: 'stub' } } };
    },
    async transcribe(spec, signal) {
      calls.transcribe += 1;
      assert.ok(spec && typeof spec === 'object');
      assert.ok(signal === undefined || signal === null || typeof signal.aborted === 'boolean' || signal instanceof AbortSignal);
      if (fail) throw fail;
      return { text, audioSeconds: 1, inferenceSeconds: 0.1 };
    },
  };
}

test('voice and audio attachments are recognized, everything else is not', () => {
  const voice = telegramVoiceSource({ voice: { file_id: 'v1', duration: 3, mime_type: 'audio/ogg' } });
  assert.deepEqual({ ...voice }, {
    kind: 'voice', fileId: 'v1', fileName: 'voice.ogg', mimeType: 'audio/ogg', seconds: 3,
  });

  const audio = telegramVoiceSource({ audio: { file_id: 'a1', file_name: 'song.mp3', mime_type: 'audio/mpeg', duration: 30 } });
  assert.equal(audio.kind, 'audio');
  assert.equal(audio.fileName, 'song.mp3');
  assert.equal(audio.seconds, 30);

  assert.equal(telegramVoiceSource({}), null);
  assert.equal(telegramVoiceSource({ voice: {} }), null);
  assert.equal(telegramVoiceSource(undefined), null);
});

test('a voice update exposes its attachment and keeps the text empty', () => {
  const message = normalizeTelegramUpdate(update({
    voice: { file_id: 'v1', duration: 2, mime_type: 'audio/ogg' },
  }), { botId: BOT, username: 'harness_bot' });
  assert.equal(message.content, '');
  assert.equal(message.voice.fileId, 'v1');
});

test('messages without audio carry no voice field', () => {
  const message = normalizeTelegramUpdate(update({ text: 'hello' }), { botId: BOT, username: 'harness_bot' });
  assert.equal(Object.hasOwn(message, 'voice'), false);
});

test('without a speech service the transcriber is absent', () => {
  assert.equal(createTelegramVoiceTranscriber({}), null);
  assert.equal(createTelegramVoiceTranscriber({ speechToText: { resolve() {} } }), null);
});

test('transcribe converts to canonical WAV, forwards the transcript and cleans up', async () => {
  const service = speechService({ text: '  привет мир  ' });
  let removed = null;
  let directory = null;
  const ffmpegArgs = [];
  const transcriber = createTelegramVoiceTranscriber({
    speechToText: service,
    language: 'ru',
    workspace: () => { directory = tempWorkspace(); return directory; },
    removeDir: (path) => { removed = path; rmSync(path, { recursive: true, force: true }); },
    runFfmpeg: async (bin, args) => {
      assert.equal(bin, 'ffmpeg');
      ffmpegArgs.push(...args);
      // Stand in for ffmpeg writing raw PCM samples.
      const { writeFileSync } = await import('node:fs');
      writeFileSync(args.at(-1), Buffer.from('raw-pcm-data'));
    },
  });

  const text = await transcriber.transcribe({
    audio: Buffer.from('opus-bytes'),
    voice: { mimeType: 'audio/ogg' },
  });

  assert.equal(text, 'привет мир');
  assert.equal(removed, directory);
  assert.deepEqual(
    ffmpegArgs.slice(0, 6),
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(directory, 'in.ogg')],
  );
  assert.ok(ffmpegArgs.includes(String(VOICE_SAMPLE_RATE)));
  // Raw PCM is requested, so the container is built by us and carries no
  // LIST/INFO chunk that the Host validator would reject.
  assert.ok(ffmpegArgs.join(' ').includes('-f s16le'));
  assert.ok(!ffmpegArgs.join(' ').includes('.wav'));
  assert.equal(service.calls.transcribe, 1);
  const request = service.calls.resolve[0];
  assert.equal(request.language, 'ru');
  assert.ok(request.audio instanceof Uint8Array);
  assert.equal(isCanonicalWav(request.audio), true, 'the provider receives a canonical container');
  assert.equal(
    Buffer.from(request.audio.slice(44)).toString(),
    'raw-pcm-data',
    'sample bytes sit directly in the data chunk',
  );
});

test('an omitted language is left to the Host selection', async () => {
  const service = speechService();
  const transcriber = createTelegramVoiceTranscriber({
    speechToText: service,
    workspace: tempWorkspace,
    removeDir: (path) => rmSync(path, { recursive: true, force: true }),
    runFfmpeg: async (bin, args) => {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(args.at(-1), Buffer.from('wav'));
    },
  });
  await transcriber.transcribe({ audio: Buffer.from('x'), voice: { mimeType: 'audio/mpeg' } });
  assert.equal(Object.hasOwn(service.calls.resolve[0], 'language'), false);
});

test('ffmpeg failures reject and still clean up', async () => {
  const service = speechService();
  let removed = null;
  const transcriber = createTelegramVoiceTranscriber({
    speechToText: service,
    workspace: tempWorkspace,
    removeDir: (path) => { removed = path; rmSync(path, { recursive: true, force: true }); },
    runFfmpeg: async () => { throw new Error('ffmpeg exited with code 1'); },
  });
  await assert.rejects(
    () => transcriber.transcribe({ audio: Buffer.from('x'), voice: { mimeType: 'audio/ogg' } }),
    /ffmpeg exited/,
  );
  assert.ok(removed && removed.startsWith(tmpdir()));
  assert.equal(service.calls.transcribe, 0);
});

test('provider failures propagate to the caller', async () => {
  const service = speechService({ fail: new Error('provider withdrawn') });
  const transcriber = createTelegramVoiceTranscriber({
    speechToText: service,
    workspace: tempWorkspace,
    removeDir: (path) => rmSync(path, { recursive: true, force: true }),
    runFfmpeg: async (bin, args) => {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(args.at(-1), Buffer.from('wav'));
    },
  });
  await assert.rejects(
    () => transcriber.transcribe({ audio: Buffer.from('x'), voice: { mimeType: 'audio/ogg' } }),
    /provider withdrawn/,
  );
});

test('oversized recordings are refused before conversion', async () => {
  const service = speechService();
  let ran = false;
  const transcriber = createTelegramVoiceTranscriber({
    speechToText: service,
    maxBytes: 8,
    workspace: tempWorkspace,
    removeDir: (path) => rmSync(path, { recursive: true, force: true }),
    runFfmpeg: async () => { ran = true; },
  });
  await assert.rejects(
    () => transcriber.transcribe({ audio: Buffer.alloc(9), voice: { mimeType: 'audio/ogg' } }),
    /larger than 8 bytes/,
  );
  assert.equal(ran, false);
});

test('empty audio is refused', async () => {
  const service = speechService();
  const transcriber = createTelegramVoiceTranscriber({ speechToText: service, removeDir: () => {} });
  await assert.rejects(
    () => transcriber.transcribe({ audio: Buffer.alloc(0), voice: { mimeType: 'audio/ogg' } }),
    /needs audio bytes/,
  );
});

test('durations are rendered for the transcript note', () => {
  assert.equal(formatVoiceDuration(7), '0:07');
  assert.equal(formatVoiceDuration(75), '1:15');
  assert.equal(formatVoiceDuration(0), 'unknown duration');
  assert.equal(formatVoiceDuration(null), 'unknown duration');
});

test('a textless recording becomes a note for the model, never an answer', () => {
  assert.equal(
    voiceNote({ voice: { seconds: 7 }, reason: 'ffmpeg is not installed' }),
    '[voice message, 0:07; ffmpeg is not installed]',
  );
  assert.equal(
    voiceNote({ voice: { seconds: null }, reason: 'no speech recognized' }),
    '[voice message, unknown duration; no speech recognized]',
  );
});

test('failures map to short, path-free reasons', () => {
  const enoent = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
  assert.equal(voiceFailureReason(enoent), 'ffmpeg is not installed');
  assert.equal(
    voiceFailureReason(new Error('spawn /usr/local/bin/ffmpeg ENOENT')),
    'ffmpeg is not installed',
  );
  assert.equal(
    voiceFailureReason(new Error('ffmpeg exited with code 1: Invalid data found')),
    'ffmpeg failed with code 1',
  );
  assert.equal(
    voiceFailureReason(new Error('Voice recording is larger than 20 bytes')),
    'recording is too large',
  );
  const provider = Object.assign(new Error('Speech provider "whisper" is not registered'), { code: 'speech-provider' });
  assert.equal(
    voiceFailureReason(provider),
    'speech provider failed: Speech provider "whisper" is not registered',
  );
  assert.match(voiceFailureReason(new Error('boom')), /^transcription failed: boom$/);
});

test('provider failures are tagged so the reason names the provider', async () => {
  const speechToText = {
    resolve() { throw new Error('no provider selected'); },
    async transcribe() { throw new Error('unreachable'); },
  };
  const transcriber = createTelegramVoiceTranscriber({
    speechToText,
    workspace: tempWorkspace,
    removeDir: (path) => rmSync(path, { recursive: true, force: true }),
    runFfmpeg: async (bin, args) => {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(args.at(-1), Buffer.from('wav'));
    },
  });
  await assert.rejects(
    () => transcriber.transcribe({ audio: Buffer.from('x'), voice: { mimeType: 'audio/ogg' } }),
    (error) => {
      assert.equal(voiceFailureReason(error), 'speech provider failed: no provider selected');
      return true;
    },
  );
});

test('canonical WAV input skips the converter', async () => {
  const service = speechService({ text: 'ok' });
  let ran = false;
  const transcriber = createTelegramVoiceTranscriber({
    speechToText: service,
    removeDir: () => {},
    runFfmpeg: async () => { ran = true; },
  });
  const canonical = wrapCanonicalWav(Buffer.alloc(8, 7)); // even PCM16 payload
  const text = await transcriber.transcribe({
    audio: Buffer.from(canonical),
    voice: { mimeType: 'audio/wav' },
  });
  assert.equal(text, 'ok');
  assert.equal(ran, false, 'a canonical container needs no conversion');
  assert.equal(Buffer.from(service.calls.resolve[0].audio).toString(), Buffer.from(canonical).toString());
});

test('the canonical check inspects the actual layout, not the MIME type', () => {
  const canonical = wrapCanonicalWav(Buffer.alloc(4, 1));
  assert.equal(isCanonicalWav(canonical), true);

  // ffmpeg-style output carries an extra chunk before `data`.
  const withList = Buffer.from(canonical);
  withList.write('LIST', 36, 'ascii');
  assert.equal(isCanonicalWav(withList), false);

  // 44.1 kHz stereo PCM16 with a canonical container is still not acceptable.
  const stereo = Buffer.from(canonical);
  stereo.writeUInt16LE(2, 22);
  stereo.writeUInt32LE(44_100, 24);
  assert.equal(isCanonicalWav(stereo), false);

  assert.equal(isCanonicalWav(Buffer.alloc(10)), false);
  assert.equal(isCanonicalWav(null), false);
});

test('a WAV that is not 16 kHz mono PCM16 is converted instead of trusted', async () => {
  const service = speechService({ text: 'resampled' });
  let converted = false;
  const transcriber = createTelegramVoiceTranscriber({
    speechToText: service,
    workspace: tempWorkspace,
    removeDir: (path) => rmSync(path, { recursive: true, force: true }),
    runFfmpeg: async (bin, args) => {
      converted = true;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(args.at(-1), Buffer.alloc(4, 3));
    },
  });
  const stereo = Buffer.from(wrapCanonicalWav(Buffer.alloc(8, 1)));
  stereo.writeUInt16LE(2, 22); // stereo
  const text = await transcriber.transcribe({ audio: stereo, voice: { mimeType: 'audio/wav' } });
  assert.equal(text, 'resampled');
  assert.equal(converted, true, 'a non-canonical WAV goes through ffmpeg');
  assert.equal(isCanonicalWav(service.calls.resolve[0].audio), true);
});

test('real ffmpeg output passes the canonical container check', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (probe.error) {
    t.skip('ffmpeg is not installed');
    return;
  }
  const directory = tempWorkspace();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = join(directory, 'in.ogg');
  const encoded = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3',
    '-c:a', 'libopus', input,
  ]);
  assert.equal(encoded.status, 0, encoded.stderr?.toString() ?? 'ffmpeg could not create a sample');

  const service = speechService({ text: 'ok' });
  const transcriber = createTelegramVoiceTranscriber({
    speechToText: service,
    workspace: tempWorkspace,
    removeDir: (path) => rmSync(path, { recursive: true, force: true }),
  });
  const { readFileSync } = await import('node:fs');
  await transcriber.transcribe({ audio: readFileSync(input), voice: { mimeType: 'audio/ogg' } });
  const audio = service.calls.resolve[0].audio;
  assert.equal(isCanonicalWav(audio), true, 'the Host validator must accept real ffmpeg output');
  assert.equal(audio.length > 44, true, 'the recording still carries audio');
});
