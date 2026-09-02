import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

import { t } from './i18n.mjs';

const FILES_DIRECTORY = join('.dsh-im', 'inbound');
const TURN_DIRECTORY_PREFIX = 'turn-';

import { INBOUND_FILE_RETENTIONS, normalizeInboundRetention } from './inbound-retention.mjs';
export { INBOUND_FILE_RETENTIONS, normalizeInboundRetention };

/** Permanent attachment batches are named by arrival time so users can locate them. */
function permanentDirectoryName(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = [
    now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate()),
    '-', pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds()),
  ].join('');
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

export class InboundFileError extends Error {
  constructor(code, message, userMessage = t('文件接收失败，请重新发送后再试。'), options = {}) {
    super(message, options);
    this.name = 'InboundFileError';
    this.code = code;
    this.userMessage = userMessage;
  }
}

function fileSources(message) {
  return Array.isArray(message?.files) ? message.files.filter(Boolean) : [];
}

function displayName(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value
    .replaceAll('\\', '/')
    .split('/')
    .at(-1)
    ?.replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return cleaned || fallback;
}

function storageName(value, index) {
  const cleaned = displayName(value, 'file')
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .replace(/^\.+/, '')
    .slice(0, 160) || 'file';
  return `${String(index + 1).padStart(2, '0')}-${cleaned}`;
}

function loadedFile(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { data: Buffer.from(value) };
  }
  const raw = value?.data ?? value?.buffer;
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    return {
      data: Buffer.from(raw),
      name: value?.name ?? value?.filename,
      mediaType: value?.mediaType ?? value?.mimetype,
    };
  }
  const stream = value?.stream ?? value;
  if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
    return {
      stream,
      name: value?.name ?? value?.filename,
      mediaType: value?.mediaType ?? value?.mimetype,
    };
  }
  return null;
}

export function hasInboundFiles(message) {
  return fileSources(message).length > 0;
}

/** Start provider downloads immediately while preserving the lazy file-source contract. */
export function prefetchInboundFiles(message, { signal } = {}) {
  const sources = fileSources(message);
  if (sources.length === 0) return message;
  return {
    ...message,
    files: sources.map((source) => {
      if (source?.data !== undefined || typeof source?.load !== 'function') return source;
      let download;
      try {
        download = Promise.resolve(source.load({ signal }));
      } catch (error) {
        download = Promise.reject(error);
      }
      download.catch(() => undefined);
      return {
        ...source,
        async load({ signal: loadSignal } = {}) {
          loadSignal?.throwIfAborted();
          const result = await download;
          loadSignal?.throwIfAborted();
          return result;
        },
      };
    }),
  };
}

export async function stageInboundFiles(message, {
  workspace,
  signal,
  retention = 'turn',
} = {}) {
  const effectiveRetention = normalizeInboundRetention(retention);
  if (!effectiveRetention) {
    throw new InboundFileError(
      'inbound-file-retention-invalid',
      `Unknown inbound file retention: ${String(retention)}`,
    );
  }
  const sources = fileSources(message);
  if (sources.length === 0) return null;
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) {
    throw new InboundFileError(
      'inbound-file-workspace-unavailable',
      'The Harness Session workspace is unavailable for inbound files.',
    );
  }

  signal?.throwIfAborted();
  const root = resolve(workspace, FILES_DIRECTORY);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, effectiveRetention === 'forever'
    ? permanentDirectoryName()
    : TURN_DIRECTORY_PREFIX));
  // mkdtemp appends six random characters to the prefix; keep the permanent
  // prefix self-describing while temporary batches keep the legacy shape.
  const files = [];

  try {
    for (const [index, source] of sources.entries()) {
      signal?.throwIfAborted();
      let value;
      try {
        value = source?.data === undefined
          ? await source?.load?.({ signal })
          : source.data;
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new InboundFileError(
          'inbound-file-download-failed',
          `Unable to download inbound file ${index + 1}: ${error?.message ?? String(error)}`,
          t('文件下载失败，请重新发送后再试。'),
          { cause: error },
        );
      }

      const loaded = loadedFile(value);
      if (!loaded) {
        throw new InboundFileError(
          'inbound-file-data-invalid',
          `Inbound file ${index + 1} returned no readable data.`,
        );
      }
      const name = displayName(loaded.name ?? source?.name, `file-${index + 1}`);
      const path = join(directory, storageName(name, index));
      if (loaded.data) {
        await writeFile(path, loaded.data, { mode: 0o600, signal });
      } else {
        try {
          await pipeline(
            loaded.stream,
            createWriteStream(path, { flags: 'wx', mode: 0o600 }),
            { signal },
          );
        } catch (error) {
          if (signal?.aborted) throw error;
          throw new InboundFileError(
            'inbound-file-download-failed',
            `Unable to stream inbound file ${index + 1}: ${error?.message ?? String(error)}`,
            t('文件下载失败，请重新发送后再试。'),
            { cause: error },
          );
        }
      }
      const relativePath = relative(resolve(workspace), path);
      if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
        throw new InboundFileError(
          'inbound-file-path-invalid',
          'The staged inbound file escaped the Harness Session workspace.',
        );
      }
      files.push(Object.freeze({
        name,
        path: relativePath,
        ...(typeof (loaded.mediaType ?? source?.mediaType) === 'string'
          && (loaded.mediaType ?? source.mediaType).trim()
          ? { mediaType: (loaded.mediaType ?? source.mediaType).trim() }
          : {}),
      }));
    }
    return Object.freeze({
      files: Object.freeze(files),
      retention: effectiveRetention,
      async cleanup() {
        // Permanent batches are kept until the user deletes them explicitly.
        if (effectiveRetention !== 'turn') return;
        await rm(directory, { recursive: true, force: true });
      },
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export function appendInboundFilesToPrompt(prompt, staged) {
  if (!staged?.files?.length) return prompt;
  const manifest = [
    '<dsh_im_files>',
    JSON.stringify({
      description: 'Files uploaded with this user message. Paths are relative to the current Harness workspace.',
      files: staged.files,
    }),
    '</dsh_im_files>',
  ].join('\n');

  if (Array.isArray(prompt)) return [...prompt, { type: 'text', text: manifest }];
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  return text ? `${text}\n\n${manifest}` : manifest;
}

export function inboundFileUserMessage(error) {
  return error instanceof InboundFileError ? error.userMessage : null;
}

function inboundRoot(workspace) {
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) return null;
  return resolve(workspace, FILES_DIRECTORY);
}

function relativeWorkspacePath(workspace, target) {
  const relativePath = relative(resolve(workspace), target);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) return null;
  return relativePath.split('\\').join('/');
}

/**
 * List inbound attachment batches under `<workspace>/.dsh-im/inbound`.
 * Permanent batches use timestamped directory names; `turn-` batches are
 * leftovers that automatic cleanup failed to remove.
 */
export async function listInboundAttachments(workspace) {
  const root = inboundRoot(workspace);
  if (!root) {
    throw new InboundFileError(
      'inbound-file-workspace-unavailable',
      'The Harness Session workspace is unavailable for inbound files.',
    );
  }
  let batchEntries;
  try {
    batchEntries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const attachments = [];
  for (const batch of batchEntries) {
    if (!batch.isDirectory()) continue;
    const batchDirectory = join(root, batch.name);
    const fileEntries = await readdir(batchDirectory, { withFileTypes: true });
    for (const entry of fileEntries) {
      if (!entry.isFile()) continue;
      const filePath = join(batchDirectory, entry.name);
      const info = await stat(filePath);
      attachments.push(Object.freeze({
        // The stored path is relative to the workspace, matching the
        // `<dsh_im_files>` manifest convention.
        path: relativeWorkspacePath(workspace, filePath),
        batch: batch.name,
        name: entry.name,
        sizeBytes: info.size,
        mtimeMs: info.mtimeMs,
        temporary: batch.name.startsWith(TURN_DIRECTORY_PREFIX),
      }));
    }
  }
  return attachments.sort((left, right) => left.mtimeMs - right.mtimeMs);
}

/**
 * Delete inbound attachments. `paths` must reference files inside
 * `<workspace>/.dsh-im/inbound`; the sentinel `'all'` removes the whole
 * attachment directory.
 */
export async function deleteInboundAttachments(workspace, paths) {
  const root = inboundRoot(workspace);
  if (!root) {
    throw new InboundFileError(
      'inbound-file-workspace-unavailable',
      'The Harness Session workspace is unavailable for inbound files.',
    );
  }
  if (paths === 'all') {
    await rm(root, { recursive: true, force: true });
    return { deleted: 'all' };
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new InboundFileError(
      'inbound-file-delete-target-invalid',
      'No inbound attachment paths were provided.',
    );
  }
  let deleted = 0;
  for (const candidate of paths) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const target = resolve(workspace, candidate);
    const canonicalRoot = await realpath(root).catch(() => null);
    const canonicalTarget = await realpath(target).catch(() => null);
    if (!canonicalRoot || !canonicalTarget) continue;
    // Only paths inside the attachment root are deletable.
    const contained = relative(canonicalRoot, canonicalTarget);
    if (!contained || contained.startsWith('..') || isAbsolute(contained)) continue;
    await rm(canonicalTarget, { recursive: true, force: true });
    deleted += 1;
  }
  return { deleted };
}
