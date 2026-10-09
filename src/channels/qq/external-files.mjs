import { QQ_EXTERNAL_IMAGE_LIMIT } from './external-images.mjs';
import { qqNativeIdentifier } from './native-reply-observations.mjs';

const refusal = (code, reason) => Object.assign(new Error(code), { code, ...(reason ? { reason } : {}) });

export function checkedQqGenericFile(file) {
  if (typeof file?.id !== 'string' || !file.id || file.id.length > 512
    || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 512
    || /[\x00-\x1f\x7f/\\]/.test(file.name) || !(file.bytes instanceof Uint8Array)
    || !file.bytes.byteLength || typeof file.mediaType !== 'string'
    || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(file.mediaType)
    || /^(image|audio|video)\//i.test(file.mediaType)) throw refusal('bad-request');
  if (file.bytes.byteLength > QQ_EXTERNAL_IMAGE_LIMIT) throw refusal('artifact-too-large');
  return Buffer.from(file.bytes);
}
export function qqQuotedFileMessage(message) {
  return qqQuotedMediaMessage(message, { accepts: files => files.every(file => file?.content_type === 'file'), label: 'file' });
}

/** Shared native quote authority; each media owner supplies its own category policy. */
export function qqQuotedMediaMessage(message, { accepts, label, requireCaption = true }) {
  if (message?.msgType !== 103) return undefined;
  const raw = message.raw;
  const elements = raw?.msg_elements;
  const element = Array.isArray(elements) && elements.length === 1 ? elements[0] : undefined;
  const key = element?.msg_idx;
  const refs = Array.isArray(raw?.message_scene?.ext)
    ? raw.message_scene.ext.filter(value => typeof value === 'string' && value.split('=', 1)[0].trim() === 'ref_msg_idx')
      .map(value => value.slice(value.indexOf('=') + 1).trim()) : [];
  if (message.kind !== 'group' || message.rawEventType !== 'GROUP_AT_MESSAGE_CREATE'
    || raw?.message_type !== 103 || raw.id !== message.messageId || raw.group_openid !== message.groupOpenid
    || raw.author?.member_openid !== message.senderId || raw.author?.bot === true)
    throw refusal('invalid-inbound', 'quote-envelope-invalid');
  if (!qqNativeIdentifier(key) || message.refMsgIdx !== key || refs.some(value => value !== key))
    throw refusal('invalid-inbound', 'quote-reference-invalid');
  if ((message.attachments !== undefined && (!Array.isArray(message.attachments) || message.attachments.length))
    || (raw.attachments !== undefined && (!Array.isArray(raw.attachments) || raw.attachments.length))
    || !Array.isArray(message.msgElements) || message.msgElements.length !== 1
    || message.msgElements[0]?.msg_idx !== key
    || Object.keys(element).some(field => !['msg_idx', 'content', 'message_type', 'attachments'].includes(field))
    || (element.message_type !== undefined && (!Number.isSafeInteger(element.message_type)
      || element.message_type < 0))
    || !Array.isArray(element.attachments) || !element.attachments.length
    || !accepts(element.attachments)
    || typeof message.content !== 'string' || (requireCaption && !message.content.trim()))
    throw refusal('invalid-inbound', 'quote-elements-invalid');
  return { referenceKey: key, message: { ...message, msgType: 0, msgElements: undefined,
    content: `${message.content}\n[Quoted ${label}]`, attachments: element.attachments } };
}
