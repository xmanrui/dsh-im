import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  IMAGE_FILE_FALLBACK_PROMPT,
  contentWithoutImages,
  imageFileSourcesFromContent,
  isModelImageRejection,
} from '../src/channels/shared/image-prompt.mjs';
import { stageInboundFiles } from '../src/channels/shared/inbound-file.mjs';
import {
  HarnessClient,
  HarnessRpcError,
} from '../src/channels/shared/harness-client.mjs';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function imageContent() {
  return [
    { type: 'text', text: 'what is in this picture?' },
    { type: 'image', mediaType: 'image/png', data: PNG_BYTES.toString('base64'), name: 'photo.png' },
  ];
}

function modelImageRejection() {
  return new HarnessRpcError('session.prompt', {
    code: 'attachment-error',
    message: 'Model "text-only" does not support image input.',
    details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
  });
}

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-image-fallback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A client whose RPC layer is scripted per test; staging uses the real pipeline. */
function scriptedClient({ workspaceRoot, fileIngressExecutor, onPrompt }) {
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: workspaceRoot,
    ...(fileIngressExecutor !== undefined ? { fileIngressExecutor } : {}),
  });
  client.ensureRunning = async () => true;
  const promptCalls = [];
  let historyCalls = 0;
  client.rpc = async (method, payload, _timeoutMs, options) => {
    if (method === 'session.prompt') {
      promptCalls.push({ payload, rpcId: options.rpcId });
      return onPrompt(promptCalls.length, options.rpcId);
    }
    if (method === 'session.list') {
      return { items: [{ sessionId: payload.sessionId ?? 'session-fallback', cwd: workspaceRoot }] };
    }
    assert.equal(method, 'session.history', `unexpected RPC: ${method}`);
    historyCalls += 1;
    if (historyCalls === 1) return { events: [] };
    return {
      events: [
        { event: { seq: 1, type: 'turn/start', data: { turn: 7 } } },
        { event: {
          seq: 2,
          type: 'user/message',
          data: { turn: 7, source: { rpcId: promptCalls[0]?.rpcId ?? options.rpcId } },
        } },
        { event: {
          seq: 3,
          type: 'assistant/message',
          data: { turn: 7, message: { content: [{ type: 'text', text: 'answer from tools' }] } },
        } },
        { event: { seq: 4, type: 'turn/end', data: { turn: 7, reason: 'completed' } } },
      ],
    };
  };
  return { client, promptCalls };
}

function manifestFiles(content) {
  const parts = content
    .filter((part) => part?.type === 'text' && part.text.includes('<dsh_im_files>'));
  assert.equal(parts.length, 1, 'exactly one <dsh_im_files> manifest block');
  return JSON.parse(parts[0].text.split('\n').find((line) => line.startsWith('{'))).files;
}

test('imageFileSourcesFromContent maps image blocks to safe file sources', () => {
  assert.deepEqual(imageFileSourcesFromContent([
    { type: 'text', text: 'caption' },
    { type: 'image', mediaType: 'image/png', data: PNG_BYTES.toString('base64'), name: '../photo.png' },
    { type: 'image', mediaType: 'image/jpeg', data: '' },
    { type: 'image', mediaType: 'image/webp', data: '', name: 'shot' },
    { type: 'image', mediaType: 'image/gif', data: '', name: 'anim.gif' },
    null,
  ]), [
    { name: 'photo.png', mediaType: 'image/png', data: PNG_BYTES },
    { name: 'image-2.jpg', mediaType: 'image/jpeg', data: Buffer.alloc(0) },
    { name: 'shot.webp', mediaType: 'image/webp', data: Buffer.alloc(0) },
    { name: 'anim.gif', mediaType: 'image/gif', data: Buffer.alloc(0) },
  ]);

  assert.deepEqual(contentWithoutImages(imageContent()), [
    { type: 'text', text: 'what is in this picture?' },
  ]);
  assert.deepEqual(imageFileSourcesFromContent('plain text'), []);
  assert.equal(contentWithoutImages('plain text'), 'plain text');
});

test('isModelImageRejection matches only the non-vision admission reason', () => {
  assert.equal(isModelImageRejection(modelImageRejection()), true);
  assert.equal(isModelImageRejection({
    code: 'attachment-error',
    details: { reason: 'IMAGE_TOO_LARGE' },
  }), false);
  assert.equal(isModelImageRejection({
    code: 'agent-busy',
    details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
  }), false);
  assert.equal(isModelImageRejection(new Error('unrelated')), false);
});

test('HarnessClient restages rejected images as workspace files and retries text-only', async (t) => {
  const root = await workspace(t);
  const ingressCalls = [];
  const { client, promptCalls } = scriptedClient({
    workspaceRoot: root,
    fileIngressExecutor: ({ files, workspace, signal }) => {
      ingressCalls.push({ files, workspace });
      return stageInboundFiles({ files }, { workspace, signal });
    },
    onPrompt: (attempt) => (attempt === 1 ? Promise.reject(modelImageRejection()) : Promise.resolve({})),
  });

  assert.equal(
    await client.ask('session-fallback', imageContent(), { timeoutMs: 3_000 }),
    'answer from tools',
  );

  // Exactly one retry, reusing the same rpcId so reply tracking stays bound.
  assert.equal(promptCalls.length, 2);
  assert.equal(promptCalls[1].rpcId, promptCalls[0].rpcId);
  assert.deepEqual(promptCalls[0].payload.content, imageContent());

  const retryContent = promptCalls[1].payload.content;
  assert.equal(retryContent.some((part) => part?.type === 'image'), false);
  assert.deepEqual(retryContent[0], { type: 'text', text: 'what is in this picture?' });
  assert.deepEqual(retryContent[1], { type: 'text', text: IMAGE_FILE_FALLBACK_PROMPT });

  const files = manifestFiles(retryContent);
  assert.deepEqual(files.map(({ name }) => name), ['photo.png']);
  assert.match(files[0].path, /^\.dsh-im[\\/]inbound[\\/]\d{8}-\d{6}-[^\\/]+[\\/]01-photo\.png$/);

  // The exact image bytes were staged into the Session workspace via ingress.
  assert.equal(ingressCalls.length, 1);
  assert.equal(ingressCalls[0].workspace, root);
  assert.equal(ingressCalls[0].files[0].data.equals(PNG_BYTES), true);

  // The turn finishing cleans the staged image like any inbound file.
  await assert.rejects(readFile(resolve(root, files[0].path)), /ENOENT/);
});

test('mixed upload and image messages merge into one manifest after fallback', async (t) => {
  const root = await workspace(t);
  const { client, promptCalls } = scriptedClient({
    workspaceRoot: root,
    fileIngressExecutor: ({ files, workspace, signal }) => (
      stageInboundFiles({ files }, { workspace, signal })
    ),
    onPrompt: (attempt) => (attempt === 1 ? Promise.reject(modelImageRejection()) : Promise.resolve({})),
  });

  assert.equal(await client.ask('session-fallback', imageContent(), {
    timeoutMs: 3_000,
    files: [{ name: 'archive.zip', data: Buffer.from('PK\u0003\u0004'), mediaType: 'application/zip' }],
  }), 'answer from tools');

  assert.equal(promptCalls.length, 2);
  const retryContent = promptCalls[1].payload.content;
  assert.equal(retryContent.some((part) => part?.type === 'image'), false);
  assert.deepEqual(manifestFiles(retryContent).map(({ name }) => name), [
    'archive.zip',
    'photo.png',
  ]);
});

test('other image admission failures never trigger the fallback', async (t) => {
  const root = await workspace(t);
  let ingressUsed = false;
  const { client, promptCalls } = scriptedClient({
    workspaceRoot: root,
    fileIngressExecutor: async () => {
      ingressUsed = true;
      throw new Error('must not stage');
    },
    onPrompt: () => Promise.reject(new HarnessRpcError('session.prompt', {
      code: 'attachment-error',
      message: 'too large',
      details: { reason: 'IMAGE_TOO_LARGE' },
    })),
  });

  await assert.rejects(
    client.ask('session-fallback', imageContent(), { timeoutMs: 3_000 }),
    (error) => error.code === 'attachment-error' && error.details?.reason === 'IMAGE_TOO_LARGE',
  );
  assert.equal(promptCalls.length, 1);
  assert.equal(ingressUsed, false);
});

test('a failed restage keeps the original model-rejection error for the user', async (t) => {
  const root = await workspace(t);
  const { client, promptCalls } = scriptedClient({
    workspaceRoot: root,
    fileIngressExecutor: async () => {
      throw new Error('ingress exploded');
    },
    onPrompt: (attempt) => (attempt === 1 ? Promise.reject(modelImageRejection()) : Promise.resolve({})),
  });

  await assert.rejects(
    client.ask('session-fallback', imageContent(), { timeoutMs: 3_000 }),
    (error) => error.code === 'attachment-error'
      && error.details?.reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES',
  );
  assert.equal(promptCalls.length, 1);
});

test('caller cancellation wins while rejected images are being restaged', async (t) => {
  const root = await workspace(t);
  const controller = new AbortController();
  const cancellation = new Error('caller cancelled image fallback');
  const { client, promptCalls } = scriptedClient({
    workspaceRoot: root,
    fileIngressExecutor: async () => {
      controller.abort(cancellation);
      throw cancellation;
    },
    onPrompt: (attempt) => (attempt === 1 ? Promise.reject(modelImageRejection()) : Promise.resolve({})),
  });

  await assert.rejects(
    client.ask('session-fallback', imageContent(), {
      timeoutMs: 3_000,
      signal: controller.signal,
    }),
    (error) => error === cancellation,
  );
  assert.equal(promptCalls.length, 1);
});

test('the fallback retry itself is never retried again', async (t) => {
  const root = await workspace(t);
  const { client, promptCalls } = scriptedClient({
    workspaceRoot: root,
    fileIngressExecutor: ({ files, workspace, signal }) => (
      stageInboundFiles({ files }, { workspace, signal })
    ),
    onPrompt: () => Promise.reject(modelImageRejection()),
  });

  await assert.rejects(
    client.ask('session-fallback', imageContent(), { timeoutMs: 3_000 }),
    (error) => error.code === 'attachment-error',
  );
  assert.equal(promptCalls.length, 2);
});

test('text-only prompts keep the single-call behavior', async (t) => {
  const root = await workspace(t);
  const { client, promptCalls } = scriptedClient({
    workspaceRoot: root,
    onPrompt: () => Promise.resolve({}),
  });

  assert.equal(
    await client.ask('session-fallback', 'plain question', { timeoutMs: 3_000 }),
    'answer from tools',
  );
  assert.equal(promptCalls.length, 1);
  assert.deepEqual(promptCalls[0].payload.content, [{ type: 'text', text: 'plain question' }]);
});
