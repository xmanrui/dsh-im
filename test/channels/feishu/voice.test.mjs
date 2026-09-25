import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ASR_BASE_URL,
  DEFAULT_ASR_MODEL,
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_VOICE,
  MAX_TTS_CHARS,
  TTS_ENDPOINT,
  normalizeFeishuVoiceConfig,
} from '../../../src/channels/feishu/voice-config.mjs';
import { createVoice } from '../../../src/channels/feishu/voice.mjs';

// 无 ffmpeg 环境:用可执行 sh 替身(见 fixtures/ffmpeg-stub.sh),只把 -i
// 输入复制到输出路径,不真正转码。Windows 无法直接 spawn 批处理/脚本,
// 依赖 spawn 的用例在 win32 跳过(CI 的 Linux 环境全量执行)。
const FFMPEG_STUB = fileURLToPath(new URL('./fixtures/ffmpeg-stub.sh', import.meta.url));
const SPAWN_SKIP = process.platform === 'win32' ? 'requires the POSIX ffmpeg stub fixture' : false;

const OPUS_BYTES = Buffer.from('fake-opus-bytes');
const WAV_BYTES = Buffer.from('fake-wav-bytes');

function fetchStub(responses) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  };
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function voiceResourceClient() {
  return {
    im: { v1: { messageResource: { get: async () => ({
      writeFile: async (path) => writeFileSync(path, OPUS_BYTES),
    }) } } },
  };
}

function audioEvent(messageId, fileKey) {
  return {
    message: { message_id: messageId, message_type: 'audio', content: JSON.stringify({ file_key: fileKey }) },
  };
}

test('normalizeFeishuVoiceConfig rejects disabled or incomplete configurations', () => {
  assert.equal(normalizeFeishuVoiceConfig(undefined), null);
  assert.equal(normalizeFeishuVoiceConfig(null), null);
  assert.equal(normalizeFeishuVoiceConfig({}), null);
  assert.equal(normalizeFeishuVoiceConfig({ enabled: false }), null);
  assert.equal(normalizeFeishuVoiceConfig({ enabled: 'true' }), null);
  assert.equal(normalizeFeishuVoiceConfig({ enabled: true }), null);
  assert.equal(normalizeFeishuVoiceConfig({ enabled: true, secretRef: '' }), null);
  assert.equal(normalizeFeishuVoiceConfig({ enabled: true, secretRef: '   ' }), null);
  assert.equal(normalizeFeishuVoiceConfig({ enabled: true, secretRef: 'BAD-KEY' }), null);
  assert.equal(normalizeFeishuVoiceConfig({ enabled: true, secretRef: '1abc' }), null);
});

test('normalizeFeishuVoiceConfig applies defaults and preserves custom fields', () => {
  const minimal = normalizeFeishuVoiceConfig({ enabled: true, secretRef: '  MY_KEY  ' });
  assert.deepEqual(minimal, {
    enabled: true,
    secretRef: 'MY_KEY',
    asrModel: DEFAULT_ASR_MODEL,
    ttsModel: DEFAULT_TTS_MODEL,
    ttsVoice: DEFAULT_TTS_VOICE,
    asrBaseUrl: DEFAULT_ASR_BASE_URL,
    ffmpeg: null,
  });
  assert.equal(Object.isFrozen(minimal), true);

  const custom = normalizeFeishuVoiceConfig({
    enabled: true,
    secretRef: 'MY_KEY',
    asrModel: 'm1',
    ttsModel: 'm2',
    ttsVoice: 'Cherry',
    asrBaseUrl: 'https://example.test/v1',
    ffmpeg: '/usr/bin/ffmpeg',
  });
  assert.equal(custom.asrModel, 'm1');
  assert.equal(custom.ttsModel, 'm2');
  assert.equal(custom.ttsVoice, 'Cherry');
  assert.equal(custom.asrBaseUrl, 'https://example.test/v1');
  assert.equal(custom.ffmpeg, '/usr/bin/ffmpeg');
});

test('createVoice returns a disabled capability without settings or secret', () => {
  const warnings = [];
  const logger = { warn: (message) => warnings.push(message) };

  assert.deepEqual(createVoice(), { enabled: false });
  assert.deepEqual(createVoice({ settings: { enabled: true, secretRef: 'MY_KEY' }, logger }), { enabled: false });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /语音凭据缺失/);
  assert.deepEqual(createVoice({
    settings: { enabled: true, secretRef: 'MY_KEY' },
    secret: '   ',
    logger,
  }), { enabled: false });
});

test('createVoice builds an enabled capability with transcription and synthesis', () => {
  const voice = createVoice({
    settings: { enabled: true, secretRef: 'MY_KEY', ttsVoice: 'Cherry', ffmpeg: FFMPEG_STUB },
    secret: 'sk-voice-test',
  });
  assert.equal(voice.enabled, true);
  assert.equal(typeof voice.transcribeIncoming, 'function');
  assert.equal(typeof voice.synthesize, 'function');
  assert.equal(Object.isFrozen(voice), true);
});

test('transcribeIncoming downloads the Feishu resource, converts and calls the ASR endpoint', { skip: SPAWN_SKIP }, async () => {
  const voice = createVoice({
    settings: { enabled: true, secretRef: 'MY_KEY', ffmpeg: FFMPEG_STUB },
    secret: 'sk-voice-test',
  });
  const stub = fetchStub([jsonResponse({ choices: [{ message: { content: '  你好,请讲个故事  ' } }] })]);
  try {
    const client = voiceResourceClient();
    const transcript = await voice.transcribeIncoming(audioEvent('om_voice', 'file_key_1'), client);
    assert.equal(transcript, '你好,请讲个故事');
    assert.equal(stub.calls.length, 1);
    const { url, init } = stub.calls[0];
    assert.equal(url, `${DEFAULT_ASR_BASE_URL}/chat/completions`);
    assert.equal(init.headers.Authorization, 'Bearer sk-voice-test');
    const body = JSON.parse(init.body);
    assert.equal(body.model, DEFAULT_ASR_MODEL);
    const data = body.messages[0].content[0].input_audio.data;
    assert.equal(data, `data:audio/wav;base64,${OPUS_BYTES.toString('base64')}`);
  } finally {
    stub.restore();
  }
});

test('transcribeIncoming returns null for an audio event without a file key', async () => {
  const voice = createVoice({
    settings: { enabled: true, secretRef: 'MY_KEY', ffmpeg: FFMPEG_STUB },
    secret: 'sk-voice-test',
  });
  const stub = fetchStub([]);
  try {
    const transcript = await voice.transcribeIncoming(audioEvent('om_voice', ''), voiceResourceClient());
    assert.equal(transcript, null);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('transcribeIncoming surfaces ASR failures instead of inventing text', { skip: SPAWN_SKIP }, async () => {
  const voice = createVoice({
    settings: { enabled: true, secretRef: 'MY_KEY', ffmpeg: FFMPEG_STUB },
    secret: 'sk-voice-test',
  });
  const stub = fetchStub([jsonResponse({ error: 'quota' }, 500)]);
  try {
    await assert.rejects(
      () => voice.transcribeIncoming(audioEvent('om_voice', 'file_key_1'), voiceResourceClient()),
      /dashscope ASR 500/,
    );
  } finally {
    stub.restore();
  }
});

test('synthesize renders speech through the DashScope TTS endpoint and returns opus bytes', { skip: SPAWN_SKIP }, async () => {
  const voice = createVoice({
    settings: { enabled: true, secretRef: 'MY_KEY', ttsVoice: 'Cherry', ffmpeg: FFMPEG_STUB },
    secret: 'sk-voice-test',
  });
  const stub = fetchStub([
    jsonResponse({ output: { audio: { url: 'https://example.test/audio.wav' } } }),
    new Response(WAV_BYTES, { status: 200 }),
  ]);
  try {
    const opus = await voice.synthesize('  你好   世界  ');
    assert.deepEqual(opus, WAV_BYTES);
    assert.equal(stub.calls.length, 2);
    const { url, init } = stub.calls[0];
    assert.equal(url, TTS_ENDPOINT);
    assert.equal(init.headers.Authorization, 'Bearer sk-voice-test');
    const body = JSON.parse(init.body);
    assert.equal(body.model, DEFAULT_TTS_MODEL);
    assert.deepEqual(body.input, { text: '你好 世界', voice: 'Cherry' });
    assert.equal(stub.calls[1].url, 'https://example.test/audio.wav');
  } finally {
    stub.restore();
  }
});

test('synthesize returns null for empty text without calling the TTS endpoint', async () => {
  const voice = createVoice({
    settings: { enabled: true, secretRef: 'MY_KEY', ffmpeg: FFMPEG_STUB },
    secret: 'sk-voice-test',
  });
  const stub = fetchStub([]);
  try {
    assert.equal(await voice.synthesize(''), null);
    assert.equal(await voice.synthesize('   '), null);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('synthesize clamps long text at the TTS character budget', { skip: SPAWN_SKIP }, async () => {
  const voice = createVoice({
    settings: { enabled: true, secretRef: 'MY_KEY', ffmpeg: FFMPEG_STUB },
    secret: 'sk-voice-test',
  });
  const stub = fetchStub([
    jsonResponse({ output: { audio: { url: 'https://example.test/audio.wav' } } }),
    new Response(WAV_BYTES, { status: 200 }),
  ]);
  try {
    await voice.synthesize(`开头${'啊'.repeat(MAX_TTS_CHARS * 2)}`);
    const body = JSON.parse(stub.calls[0].init.body);
    assert.equal(body.input.text.length, MAX_TTS_CHARS);
    assert.ok(body.input.text.startsWith('开头'));
  } finally {
    stub.restore();
  }
});

test('synthesize rejects when the TTS response carries no audio url', { skip: SPAWN_SKIP }, async () => {
  const voice = createVoice({
    settings: { enabled: true, secretRef: 'MY_KEY', ffmpeg: FFMPEG_STUB },
    secret: 'sk-voice-test',
  });
  const stub = fetchStub([jsonResponse({ output: {} })]);
  try {
    await assert.rejects(() => voice.synthesize('你好'), /TTS 无音频/);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});
