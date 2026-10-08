import { createHash } from 'node:crypto';
import { detectedImageMediaType, fetchImageBuffer } from '../shared/image-prompt.mjs';
import { QQ_IMAGE_HOSTS } from './qq-bridge.mjs';

export const QQ_EXTERNAL_IMAGE_LIMIT = 25 * 1024 * 1024;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const refusal = (code, reason) => Object.assign(new Error(code), { code, ...(reason ? { reason } : {}) });

/** Native caption and attachment order are separate; no native interleaving is inferred. */
export function qqSourceAttachments(message, event, { sourceImages = true, sourceFiles = false, referenceKey } = {}) {
  if (!Array.isArray(message.attachments) || !message.attachments.length || message.attachments.length > 32)
    throw refusal('invalid-inbound');
  const files = message.attachments.map((native, index) => {
    // Tencent's native `file` label is a category, not a MIME declaration.
    const mediaType = native?.content_type === 'file' && sourceFiles
      ? 'application/octet-stream' : sourceImages && imageTypes.has(native?.content_type) ? native.content_type : null;
    if (!mediaType) throw refusal('invalid-inbound', 'file-category-invalid');
    if (typeof native.url !== 'string' || native.url.length > 16384)
      throw refusal('invalid-inbound', 'file-url-invalid');
    let url;
    try { url = new URL(native.url); } catch { throw refusal('invalid-inbound', 'file-url-invalid'); }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || !QQ_IMAGE_HOSTS.some(host => url.hostname === host.slice(1) || url.hostname.endsWith(host)))
      throw refusal('resource-unavailable');
    if (native.size !== undefined && (!Number.isSafeInteger(native.size) || native.size <= 0))
      throw refusal('invalid-inbound', 'file-size-invalid');
    if (native.size > QQ_EXTERNAL_IMAGE_LIMIT) throw refusal('artifact-too-large');
    const id = createHash('sha256').update(JSON.stringify([
      event.fingerprint, event.conversation.id, event.messageId, index,
      ...(referenceKey === undefined ? [] : ['quote', referenceKey]),
    ])).digest('hex');
    const name = typeof native.filename === 'string' && native.filename.trim() && native.filename.length <= 512
      && !/[\x00-\x1f\x7f/\\]/.test(native.filename) ? native.filename : native.content_type === 'file' ? 'file' : 'image';
    const attachment = { id, messageId: event.messageId, resourceKey: id, name,
      mediaType, ...(native.size === undefined ? {} : { sizeBytes: native.size }) };
    return { attachment, url: native.url };
  });
  return { files, event: { ...event, attachments: files.map(file => file.attachment),
    contentParts: [
      ...(message.content.trim() ? [{ kind: 'text', text: message.content }] : []),
      ...files.map(({ attachment }) => ({ kind: 'attachment', id: attachment.id })),
    ] } };
}

export async function readQqSourceAttachment(source, attachment, { signal, assertCurrent, verifyAccount }) {
  assertCurrent();
  const file = source.files?.find(file => file.attachment.id === attachment?.id);
  if (!file || Object.keys(attachment).some(key => !Object.hasOwn(file.attachment, key))
    || Object.keys(file.attachment).some(key => file.attachment[key] !== attachment[key]))
    throw refusal('stale-route');
  let bytes;
  try {
    bytes = await fetchImageBuffer(file.url, { signal, allowedHosts: QQ_IMAGE_HOSTS,
      maxBytes: QQ_EXTERNAL_IMAGE_LIMIT, timeoutMs: 15000 });
  } catch (error) {
    assertCurrent();
    throw refusal(error?.code === 'image-too-large' ? 'artifact-too-large' : 'resource-unavailable');
  }
  assertCurrent();
  await verifyAccount();
  assertCurrent();
  if ((attachment.mediaType.startsWith('image/') && detectedImageMediaType(bytes) !== attachment.mediaType)
    || (attachment.sizeBytes !== undefined && bytes.byteLength !== attachment.sizeBytes))
    throw refusal('resource-unavailable');
  return (async function* () {
    await verifyAccount();
    assertCurrent();
    yield new Uint8Array(bytes);
    assertCurrent();
  })();
}

export function checkedQqImageFile(file) {
  if (typeof file?.id !== 'string' || !file.id || file.id.length > 512
    || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 512
    || /[\x00-\x1f\x7f/\\]/.test(file.name) || !(file.bytes instanceof Uint8Array)
    || !file.bytes.byteLength || !imageTypes.has(file.mediaType)) throw refusal('bad-request');
  if (file.bytes.byteLength > QQ_EXTERNAL_IMAGE_LIMIT) throw refusal('artifact-too-large');
  const bytes = Buffer.from(file.bytes);
  if (detectedImageMediaType(bytes) !== file.mediaType) throw refusal('bad-request');
  return bytes;
}

/** Upload cancellation prevents the later send; the SDK upload itself has no AbortSignal. */
export async function uploadQqCheckedMedia(bot, target, file, bytes, signal, fileType = 1) {
  let timer;
  let aborted;
  const interrupted = new Promise((_, reject) => {
    aborted = () => reject(refusal('cancelled'));
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    timer = setTimeout(() => reject(refusal('file-upload-failed')), 120000);
  });
  try {
    const uploaded = await Promise.race([interrupted,
      bot.uploadMedia({ target, fileType, buffer: bytes, fileName: file.name, srvSendMsg: false })]);
    if (typeof uploaded?.file_info !== 'string' || !uploaded.file_info || uploaded.file_info.length > 16384)
      throw refusal('file-upload-failed');
    return uploaded.file_info;
  } catch (error) {
    throw refusal(signal?.aborted || error?.code === 'cancelled' ? 'cancelled' : 'file-upload-failed');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', aborted);
  }
}
