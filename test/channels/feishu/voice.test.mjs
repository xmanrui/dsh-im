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

// 无 ffmpeg 环境:用 fixtures/ffmpeg-stub.mjs 这个**跨平台**替身(只把 -i 输入
// 复制到输出路径,不真正转码)。此前替身是 .sh,Windows 不能直接 spawn 脚本,
// 依赖它的 5 条用例只能整批 skip,于是语音链路在本机/Windows CI 永不执行 ——
// 那是测试夹具的平台依赖,不是被测代码的平台依赖。
//
// 现在改法:通过 createVoice 的 runFfmpeg 注入位换成"用 node 真起子进程跑替身"。
// 注入的 runner 保持与生产 defaultRunFfmpeg 相同的参数形状(bin 在前、ffmpeg
// 公共参数居中、真实参数在后),所以断言强度不打折:仍然真 spawn、仍然看退出码、
// 仍然校验字节真的落到了输出路径。生产代码一行没为测试让路。
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const FFMPEG_STUB = fileURLToPath(new URL('./fixtures/ffmpeg-stub.mjs', import.meta.url));
// 参数留痕写到 gitignored 的 test/.tmp（.gitignore 已收 test/.tmp/），用来自证"真 spawn 过"。
const STUB_LOG = fileURLToPath(new URL('../../.tmp/ffmpeg-stub-argv.log', import.meta.url));

/**
 * 跨平台替身 runner:签名与 src/channels/feishu/voice.mjs 的 defaultRunFfmpeg 一致。
 *
 * @param {string} bin 配置里的 ffmpeg 路径(替身只透传,不解释)
 * @param {string[]} args 真实参数(-i 输入 ... 输出)
 * @returns {Promise<void>} 退出码非 0 时 reject,与生产同一契约
 */
function runFfmpegStub(bin, args) {
  mkdirSync(dirname(STUB_LOG), { recursive: true });
  return new Promise((resolve, reject) => {
    // node 在所有平台都可执行,因此这条路径 win32/linux/darwin 同形。
    // env 单独构造(不写全局 process.env),避免用例之间互相污染留痕路径。
    const env = { ...process.env, DSH_FFMPEG_STUB_LOG: STUB_LOG };
    const p = spawn(process.execPath, [FFMPEG_STUB, bin, '-hide_banner', '-loglevel', 'error', '-y', ...args], { env });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg stub exit ${code}: ${err.slice(-300)}`))));
  });
}

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
    runFfmpeg: runFfmpegStub,
  });
  assert.equal(voice.enabled, true);
  assert.equal(typeof voice.transcribeIncoming, 'function');
  assert.equal(typeof voice.synthesize, 'function');
  assert.equal(Object.isFrozen(voice), true);
});

test('transcribeIncoming downloads the Feishu resource, converts and calls the ASR endpoint', async () => {
  const voice = createVoice({
    settings: { enabled: true, secretRef: 'MY_KEY', ffmpeg: FFMPEG_STUB },
    secret: 'sk-voice-test',
    runFfmpeg: runFfmpegStub,
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
    runFfmpeg: runFfmpegStub,
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

test('transcribeIncoming surfaces ASR failures instead of inventing text', async () => {
  const voice = createVoice({
    settings: { enabled: true, secretRef: 'MY_KEY', ffmpeg: FFMPEG_STUB },
    secret: 'sk-voice-test',
    runFfmpeg: runFfmpegStub,
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

test('synthesize renders speech through the DashScope TTS endpoint and returns opus bytes', async () => {
  const voice = createVoice({
    settings: { enabled: true, secretRef: 'MY_KEY', ttsVoice: 'Cherry', ffmpeg: FFMPEG_STUB },
    secret: 'sk-voice-test',
    runFfmpeg: runFfmpegStub,
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
    runFfmpeg: runFfmpegStub,
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

test('synthesize clamps long text at the TTS character budget', async () => {
  const voice = createVoice({
    settings: { enabled: true, secretRef: 'MY_KEY', ffmpeg: FFMPEG_STUB },
    secret: 'sk-voice-test',
    runFfmpeg: runFfmpegStub,
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

test('synthesize rejects when the TTS response carries no audio url', async () => {
  const voice = createVoice({
    settings: { enabled: true, secretRef: 'MY_KEY', ffmpeg: FFMPEG_STUB },
    secret: 'sk-voice-test',
    runFfmpeg: runFfmpegStub,
  });
  const stub = fetchStub([jsonResponse({ output: {} })]);
  try {
    await assert.rejects(() => voice.synthesize('你好'), /TTS 无音频/);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

// 回归:ffmpeg 未安装或路径不存在时 spawn 触发 'error'(ENOENT)而非 'close'。
// 未监听 'error' 会让异常击穿 Node 进程;修复后应正常 reject,由外层降级兜底。
// 本用例不依赖 POSIX 替身,全平台执行。
const MISSING_FFMPEG = '/nonexistent/ffmpeg-missing-binary';
const isSpawnError = (error) => error?.code === 'ENOENT' || /ENOENT/i.test(error?.message ?? '');

test('missing ffmpeg rejects transcription instead of crashing the host', async () => {
  const voice = createVoice({
    settings: { enabled: true, secretRef: 'MY_KEY', ffmpeg: MISSING_FFMPEG },
    secret: 'sk-voice-test',
  });
  await assert.rejects(
    () => voice.transcribeIncoming(audioEvent('om_voice', 'file_key_1'), voiceResourceClient()),
    isSpawnError,
  );
});

test('missing ffmpeg rejects synthesis instead of crashing the host', async () => {
  const voice = createVoice({
    settings: { enabled: true, secretRef: 'MY_KEY', ffmpeg: MISSING_FFMPEG },
    secret: 'sk-voice-test',
  });
  const stub = fetchStub([
    jsonResponse({ output: { audio: { url: 'https://example.test/audio.wav' } } }),
    new Response(WAV_BYTES, { status: 200 }),
  ]);
  try {
    await assert.rejects(() => voice.synthesize('你好'), isSpawnError);
  } finally {
    stub.restore();
  }
});