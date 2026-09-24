import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_IMAGE_PROMPT,
  ImagePromptError,
  fetchImageBuffer,
  hasInboundPrompt,
  imagePromptDiagnostic,
  imagePromptUserMessage,
  promptContentForMessage,
} from '../src/channels/shared/image-prompt.mjs';
import { HarnessClient } from '../src/channels/shared/harness-client.mjs';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

test('text-only messages retain the existing Harness content shape', async () => {
  assert.equal(hasInboundPrompt({ content: ' hello ' }), true);
  assert.deepEqual(await promptContentForMessage({ content: ' hello ' }), [
    { type: 'text', text: 'hello' },
  ]);
});

test('image-only messages lazily load bytes and receive a useful default instruction', async () => {
  let loadOptions;
  const content = await promptContentForMessage({
    content: '',
    images: [{
      name: '../photo.png',
      async load(options) {
        loadOptions = options;
        return PNG_1X1;
      },
    }],
  });

  assert.equal(loadOptions.maxBytes, 5 * 1024 * 1024);
  assert.deepEqual(content, [
    { type: 'text', text: DEFAULT_IMAGE_PROMPT },
    {
      type: 'image',
      mediaType: 'image/png',
      data: PNG_1X1.toString('base64'),
      name: 'photo.png',
    },
  ]);
});

test('captions and multiple image parts preserve their input order', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const gif = Buffer.from('GIF89a payload');
  assert.deepEqual(await promptContentForMessage({
    content: 'compare these',
    images: [{ data: jpeg }, { data: gif }],
  }), [
    { type: 'text', text: 'compare these' },
    { type: 'image', mediaType: 'image/jpeg', data: jpeg.toString('base64') },
    { type: 'image', mediaType: 'image/gif', data: gif.toString('base64') },
  ]);
});

test('declared oversized images are rejected without downloading them', async () => {
  let loaded = false;
  await assert.rejects(
    promptContentForMessage({
      images: [{
        size: 5 * 1024 * 1024 + 1,
        async load() { loaded = true; return PNG_1X1; },
      }],
    }),
    (error) => error instanceof ImagePromptError && error.code === 'image-too-large',
  );
  assert.equal(loaded, false);
});

test('multiple images share an aggregate byte limit', async () => {
  let secondLoaded = false;
  await assert.rejects(
    promptContentForMessage({
      images: [
        { size: PNG_1X1.length, async load() { return PNG_1X1; } },
        {
          size: PNG_1X1.length,
          async load() { secondLoaded = true; return PNG_1X1; },
        },
      ],
    }, { maxTotalImageBytes: PNG_1X1.length + 1 }),
    (error) => error instanceof ImagePromptError && error.code === 'images-too-large',
  );
  assert.equal(secondLoaded, false);
});

test('unsupported image bytes receive a channel-safe error', async () => {
  await assert.rejects(
    promptContentForMessage({ images: [{ data: Buffer.from('not an image') }] }),
    (error) => error instanceof ImagePromptError
      && error.code === 'unsupported-image-type'
      && /JPEG/.test(error.userMessage),
  );
});

test('Harness attachment failures map only allowlisted reasons to safe channel messages', () => {
  const modelError = Object.assign(new Error('private provider detail'), {
    code: 'attachment-error',
    details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES', privatePath: '/secret/model' },
  });
  assert.deepEqual(imagePromptDiagnostic(modelError), {
    code: 'attachment-error',
    reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES',
    userMessage: '当前模型不支持图片，请用 /models 查看可用模型，再用 /model <序号> 切换后重发。',
  });
  assert.doesNotMatch(imagePromptUserMessage(modelError), /private|secret/);

  for (const reason of [
    'IMAGE_TOO_LARGE',
    'IMAGE_TOO_MANY_PIXELS',
    'INVALID_IMAGE',
    'INVALID_IMAGE_BASE64',
    'IMAGE_TYPE_MISMATCH',
    'TOO_MANY_IMAGES',
    'IMAGES_TOO_LARGE',
  ]) {
    assert.equal(typeof imagePromptUserMessage({
      code: 'attachment-error', details: { reason },
    }), 'string', reason);
  }
});

test('unknown Harness failures remain generic and cannot access inherited map properties', () => {
  for (const reason of ['FUTURE_PRIVATE_REASON', 'toString']) {
    const error = {
      code: 'attachment-error',
      details: { reason },
      message: 'provider token and /private/path',
    };
    assert.equal(imagePromptDiagnostic(error), null);
    assert.equal(imagePromptUserMessage(error), null);
  }
  assert.equal(imagePromptUserMessage({
    code: 'agent-busy',
    details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
  }), null);
});

test('bounded HTTPS downloads enforce response size before buffering', async () => {
  let cancelled = false;
  const fetchImpl = async (url, options) => {
    assert.equal(url.href, 'https://files.example/image.png');
    assert.equal(options.redirect, 'manual');
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name === 'content-length' ? '9' : null) },
      body: { async cancel() { cancelled = true; } },
      async arrayBuffer() { throw new Error('must not buffer'); },
    };
  };
  await assert.rejects(
    fetchImageBuffer('https://files.example/image.png', { fetchImpl, maxBytes: 8 }),
    (error) => error instanceof ImagePromptError && error.code === 'image-too-large',
  );
  assert.equal(cancelled, true);
});

test('image downloads reject insecure platform URLs', async () => {
  await assert.rejects(
    fetchImageBuffer('http://files.example/image.png'),
    /must use HTTPS/,
  );
});

test('image downloads enforce messaging-platform host allowlists', async () => {
  await assert.rejects(
    fetchImageBuffer('https://cdn.attacker.example/image.png', {
      allowedHosts: ['cdn.discordapp.com', '.slack.com'],
    }),
    /not hosted by the messaging platform/,
  );
  const data = await fetchImageBuffer('https://files.slack.com/image.png', {
    allowedHosts: ['.slack.com'],
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => null },
      async arrayBuffer() { return PNG_1X1; },
    }),
  });
  assert.deepEqual(data, PNG_1X1);
});

test('image downloads report redirects without following or exposing the target', async () => {
  let options;
  let cancelled = false;
  await assert.rejects(
    fetchImageBuffer('https://files.example.test/image', {
      fetchImpl: async (_url, requestOptions) => {
        options = requestOptions;
        return {
          ok: false,
          status: 302,
          headers: { get: () => null },
          body: { async cancel() { cancelled = true; } },
        };
      },
    }),
    (error) => {
      assert.equal(error.code, 'image-redirect-blocked');
      assert.doesNotMatch(error.message, /private|token|hidden/);
      return true;
    },
  );
  assert.equal(options.redirect, 'manual');
  assert.equal(cancelled, true);
});

test('image downloads report the safe HTTP status for non-success responses', async () => {
  let cancelled = false;
  await assert.rejects(
    fetchImageBuffer('https://files.example.test/image', {
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        headers: { get: () => null },
        body: { async cancel() { cancelled = true; } },
      }),
    }),
    (error) => error.code === 'image-http-error'
      && error.userMessage === '图片下载失败（HTTP 403），请重新发送后再试。',
  );
  assert.equal(cancelled, true);
});

test('HarnessClient sends structured image content without rewriting it', async () => {
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/image-prompt-test',
  });
  client.ensureRunning = async () => true;
  let promptPayload;
  let promptRpcId;
  let historyCalls = 0;
  client.rpc = async (method, payload, _timeoutMs, options) => {
    if (method === 'session.prompt') {
      promptPayload = payload;
      promptRpcId = options.rpcId;
      return {};
    }
    assert.equal(method, 'session.history');
    historyCalls += 1;
    if (historyCalls === 1) return { events: [] };
    return {
      events: [
        { event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
        { event: {
          seq: 2,
          type: 'user/message',
          data: { turn: 1, source: { rpcId: promptRpcId } },
        } },
        { event: {
          seq: 3,
          type: 'assistant/message',
          data: { turn: 1, message: { content: [{ type: 'text', text: 'a cat' }] } },
        } },
        { event: { seq: 4, type: 'turn/end', data: { turn: 1, reason: 'completed' } } },
      ],
    };
  };
  const content = [
    { type: 'text', text: 'what is this?' },
    { type: 'image', mediaType: 'image/png', data: PNG_1X1.toString('base64') },
  ];

  assert.equal(await client.ask('session-image', content, { timeoutMs: 2_000 }), 'a cat');
  assert.deepEqual(promptPayload.content, content);
  assert.equal(promptPayload.sessionId, 'session-image');
});
