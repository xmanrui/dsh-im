import assert from 'node:assert/strict';
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  InboundFileError,
  stageInboundFiles,
} from '../src/channels/shared/inbound-file.mjs';
import { assertPathInside, assertPathMatches } from './support/filesystem.mjs';

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-inbound-file-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function absoluteStagedPath(root, file) {
  assert.equal(isAbsolute(file.path), false, 'Harness receives a workspace-relative path');
  const path = resolve(root, file.path);
  assertPathInside(root, path);
  return path;
}

test('stageInboundFiles preserves exact bytes, including a zero-byte file', async (t) => {
  const root = await workspace(t);
  const binary = Buffer.from([0x00, 0xff, 0x01, 0x80, 0x0a, 0x0d]);
  const staged = await stageInboundFiles({
    files: [
      { name: 'binary.dat', data: binary, mediaType: 'application/octet-stream' },
      { name: 'empty.txt', data: Buffer.alloc(0), mediaType: 'text/plain' },
    ],
  }, { workspace: root });

  assert.deepEqual(staged.files.map(({ name, mediaType }) => ({ name, mediaType })), [
    { name: 'binary.dat', mediaType: 'application/octet-stream' },
    { name: 'empty.txt', mediaType: 'text/plain' },
  ]);
  assert.deepEqual(
    await readFile(absoluteStagedPath(root, staged.files[0])),
    binary,
  );
  assert.deepEqual(
    await readFile(absoluteStagedPath(root, staged.files[1])),
    Buffer.alloc(0),
  );

  const turnDirectory = resolve(root, staged.files[0].path, '..');
  await staged.cleanup();
  await assert.rejects(readFile(resolve(turnDirectory, '01-binary.dat')), /ENOENT/);
});

test('stageInboundFiles writes async streams without changing their bytes', async (t) => {
  const root = await workspace(t);
  const chunks = [
    Buffer.from([0xde, 0xad]),
    new Uint8Array([0xbe, 0xef]),
    Buffer.from('stream tail'),
  ];
  const expected = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  const staged = await stageInboundFiles({
    files: [{
      name: 'stream.bin',
      load: async () => ({
        stream: Readable.from(chunks),
        name: 'provider-stream.bin',
        mimetype: 'application/x-provider-stream',
      }),
    }],
  }, { workspace: root });

  assert.deepEqual(staged.files, [{
    name: 'provider-stream.bin',
    path: staged.files[0].path,
    mediaType: 'application/x-provider-stream',
  }]);
  assert.deepEqual(await readFile(absoluteStagedPath(root, staged.files[0])), expected);
  await staged.cleanup();
});

test('stageInboundFiles reports failures raised while streaming provider bytes as file downloads', async (t) => {
  const root = await workspace(t);
  await assert.rejects(stageInboundFiles({
    files: [{
      name: 'broken.bin',
      load: async () => ({
        stream: Readable.from((async function* brokenStream() {
          yield Buffer.from('partial');
          throw new Error('provider stream disconnected');
        }())),
      }),
    }],
  }, { workspace: root }), (error) => (
    error instanceof InboundFileError
    && error.code === 'inbound-file-download-failed'
    && error.userMessage === '文件下载失败，请重新发送后再试。'
    && error.cause?.message === 'provider stream disconnected'
  ));
  assert.deepEqual(await readdir(join(root, '.dsh-im', 'inbound')), []);
});

test('stageInboundFiles removes the whole partial batch when any file download fails', async (t) => {
  const root = await workspace(t);
  let secondAttempted = false;

  await assert.rejects(
    stageInboundFiles({
      files: [
        { name: 'first.txt', data: Buffer.from('must be removed') },
        {
          name: 'second.txt',
          async load() {
            secondAttempted = true;
            throw new Error('private signed URL expired');
          },
        },
        {
          name: 'third.txt',
          async load() {
            assert.fail('files after a failed member must not be downloaded');
          },
        },
      ],
    }, { workspace: root }),
    (error) => error instanceof InboundFileError
      && error.code === 'inbound-file-download-failed'
      && error.userMessage === '文件下载失败，请重新发送后再试。',
  );
  assert.equal(secondAttempted, true);
  assert.deepEqual(await readdir(join(root, '.dsh-im', 'inbound')), []);
});

test('stageInboundFiles keeps display names but makes traversal-like storage names path-safe', async (t) => {
  const root = await workspace(t);
  const staged = await stageInboundFiles({
    files: [{
      name: '../../private\\folder/..\\report:?*.txt\u0000\n',
      data: Buffer.from('safe'),
    }],
  }, { workspace: root });

  assert.equal(staged.files[0].name, 'report:?*.txt');
  assertPathMatches(staged.files[0].path, /^\.dsh-im\/inbound\/\d{8}-\d{6}-[^/]+\/01-report___\.txt$/);
  assert.equal(await readFile(absoluteStagedPath(root, staged.files[0]), 'utf8'), 'safe');
  await staged.cleanup();
});

test('stageInboundFiles adds no count, extension, MIME, or declared-size acceptance limits', async (t) => {
  const root = await workspace(t);
  const sources = Array.from({ length: 33 }, (_, index) => ({
    name: index === 0 ? 'no-extension' : `unknown-${index}.unsupported-${index}`,
    mediaType: `application/x-unknown-${index}`,
    size: Number.MAX_SAFE_INTEGER,
    data: Buffer.from(`file-${index}`),
  }));

  const staged = await stageInboundFiles({ files: sources }, { workspace: root });
  assert.equal(staged.files.length, 33);
  assert.deepEqual(
    await Promise.all(staged.files.map((file) => readFile(absoluteStagedPath(root, file), 'utf8'))),
    sources.map((_source, index) => `file-${index}`),
  );
  assert.equal(staged.files[0].name, 'no-extension');
  assert.equal(staged.files.at(-1).mediaType, 'application/x-unknown-32');
  await staged.cleanup();
});
