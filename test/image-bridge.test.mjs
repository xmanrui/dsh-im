import { loadDeferredImages } from './helpers/deferred-images.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { TextHarnessBridge } from '../src/channels/shared/text-harness-bridge.mjs';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

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

function bridgeFixture() {
  const sent = [];
  const prompts = [];
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'test', label: 'Test' },
    bot: { sendText: async (_target, text) => sent.push(text) },
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      createSession: async () => 'session-image',
      ask: async (_sessionId, prompt, options) => {
        prompt = await loadDeferredImages(prompt, options);
        prompts.push(prompt);
        return '识别成功';
      },
    },
    state: memoryState(),
  });
  return { bridge, sent, prompts };
}

test('the shared bridge sends image and caption content to Harness', async () => {
  const { bridge, sent, prompts } = bridgeFixture();
  let loads = 0;
  await bridge.accept({
    messageId: 'image-1',
    senderId: 'user-1',
    kind: 'direct',
    conversationId: 'user-1',
    content: '图中是什么？',
    images: [{ async load() { loads += 1; return PNG_1X1; } }],
    replyTarget: {},
  });

  assert.equal(loads, 1);
  assert.deepEqual(prompts, [[
    { type: 'text', text: '图中是什么？' },
    { type: 'image', mediaType: 'image/png', data: PNG_1X1.toString('base64') },
  ]]);
  assert.deepEqual(sent, ['识别成功']);
});

test('unaddressed group images are rejected before their bytes are downloaded', async () => {
  const { bridge, sent, prompts } = bridgeFixture();
  let loads = 0;
  await bridge.accept({
    messageId: 'image-2',
    senderId: 'user-1',
    kind: 'group',
    conversationId: 'group-1',
    content: '',
    addressed: false,
    images: [{ async load() { loads += 1; return PNG_1X1; } }],
    replyTarget: {},
  });

  assert.equal(loads, 0);
  assert.deepEqual(prompts, []);
  assert.deepEqual(sent, []);
});

test('image validation failures receive a specific safe reply', async () => {
  const { bridge, sent, prompts } = bridgeFixture();
  await bridge.accept({
    messageId: 'image-3',
    senderId: 'user-1',
    kind: 'direct',
    conversationId: 'user-1',
    content: '',
    images: [{ data: Buffer.from('not an image') }],
    replyTarget: {},
  });

  assert.deepEqual(prompts, []);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^暂不支持该图片格式，请发送 JPEG、PNG、WebP 或 GIF 图片。/);
  assert.match(sent[0], /错误码：INPUT_INVALID；参考号：MF-[A-F0-9]{8}$/);
});

test('an image caption cannot answer a pending Harness question', async () => {
  const sent = [];
  const questionSent = Promise.withResolvers();
  const answered = Promise.withResolvers();
  let interactionResult;
  let imageLoads = 0;
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'test', label: 'Test' },
    bot: {
      async sendText(_target, text) {
        sent.push(text);
        if (text.includes('请选择环境')) questionSent.resolve();
      },
    },
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      createSession: async () => 'session-question',
      async ask(_sessionId, prompt, options) {
        assert.equal(prompt, '开始测试');
        await options.onInteraction({
          kind: 'question',
          interactionId: 'question-1',
          rpcId: 'question-1',
          sessionId: 'session-question',
          payload: {
            questions: [{
              id: 'environment',
              question: '请选择环境',
              options: [{ label: '生产环境' }],
            }],
          },
          async respond(result) {
            interactionResult = result;
            answered.resolve();
            return { accepted: true };
          },
        });
        await answered.promise;
        return '已完成';
      },
    },
    state: memoryState(),
  });

  const original = bridge.accept({
    messageId: 'question-start',
    senderId: 'user-1',
    kind: 'direct',
    conversationId: 'user-1',
    content: '开始测试',
    replyTarget: {},
  });
  await questionSent.promise;

  await bridge.accept({
    messageId: 'question-image',
    senderId: 'user-1',
    kind: 'direct',
    conversationId: 'user-1',
    content: '生产环境',
    images: [{ async load() { imageLoads += 1; return PNG_1X1; } }],
    replyTarget: {},
  });
  assert.equal(imageLoads, 0);
  assert.equal(interactionResult, undefined);
  assert.equal(sent.at(-1), '请用文字回答当前问题。');

  await bridge.accept({
    messageId: 'question-answer',
    senderId: 'user-1',
    kind: 'direct',
    conversationId: 'user-1',
    content: '生产环境',
    replyTarget: {},
  });
  await original;
  assert.deepEqual(interactionResult, {
    ok: true,
    value: {
      sessionId: 'session-question',
      answer: { answers: [{ id: 'environment', selected: ['生产环境'] }] },
    },
  });
});
