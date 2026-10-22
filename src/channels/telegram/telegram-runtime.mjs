import { captureGroupHistory, groupHistoryEntry } from '../shared/group-history.mjs';
import { extractConnectionEvidence, createConnectionDiagnostics, atConnectionStage } from '../shared/connection-error.mjs';

import { createEditableMessageStream } from '../shared/editable-message-stream.mjs';
import { createTextDeliveryBlock } from '../shared/semantic/delivery.mjs';
import { t } from '../shared/i18n.mjs';
import { groupTriggerAddressed, normalizeGroupTriggers } from './group-triggers.mjs';
import { captureContextEnhancement } from '../shared/context-enhancement.mjs';
import { recoverAssistantTextByTimestamp } from '../shared/session-reply-recovery.mjs';
import { SHARED_COMMAND_CATALOG, commandsForChannel } from '../shared/command-catalog.mjs';
import { COMMANDS_MENU_BUTTON, TelegramApi, validateTelegramCommands } from './telegram-api.mjs';
import { createTelegramHttpTransport } from './telegram-http.mjs';
import { createTelegramBridgeStatus, TelegramHarnessBridge } from './telegram-bridge.mjs';
import { VOICE_MAX_BYTES, telegramVoiceSource, voiceFailureReason, voiceNote } from './voice.mjs';
import { evaluateInboundAccess } from '../shared/inbound-access.mjs';
import { createConversationQueue } from '../shared/conversation-queue.mjs';
import {
  splitTelegramRegularText,
  splitTelegramRichMarkdown,
  toTelegramRichMarkdown,
} from './telegram-rich-message.mjs';
import {
  TELEGRAM_ACCESS_MODES,
} from './config-store.mjs';

function commandMenuEntries(catalog, translate) {
  return commandsForChannel('telegram', catalog)
    .filter((item) => item.menuVisible !== false)
    .flatMap((item) => [item, ...(item.aliases ?? [])]
      .filter((entry) => entry.menuVisible !== false && entry.enabled !== false
        && (!entry.channels || entry.channels.includes('telegram')))
      .map((entry) => ({
        command: entry.name,
        description: translate(entry.description ?? item.description),
      })));
}

export function telegramCommandMenu(catalog = SHARED_COMMAND_CATALOG) {
  const commands = commandMenuEntries(catalog, t);
  validateTelegramCommands(commands, { allowEmpty: true });
  return commands;
}

// Retain the source-language export for existing consumers, derived from the
// catalog. Runtime synchronization always generates a fresh, localized list.
export const TELEGRAM_COMMAND_MENU = Object.freeze(
  commandMenuEntries(SHARED_COMMAND_CATALOG, (text) => text).map((item) => Object.freeze(item)),
);

function mentionedUsername(message, username) {
  if (!username) return false;
  return [
    [message?.text, message?.entities],
    [message?.caption, message?.caption_entities],
  ].some(([text, entities]) => typeof text === 'string' && Array.isArray(entities)
    && entities.some((entity) => {
      if (entity?.type !== 'mention' || !Number.isInteger(entity.offset)
        || !Number.isInteger(entity.length)) return false;
      return text.slice(entity.offset, entity.offset + entity.length).toLowerCase()
        === `@${username.toLowerCase()}`;
    }));
}

function isUsernameBoundary(character) {
  return character === undefined || !(/[a-z0-9_]/i).test(character);
}

function withoutBotMention(text, username) {
  if (!username || typeof text !== 'string') return text;
  const target = `@${username}`.toLowerCase();
  let result = '';
  let offset = 0;
  while (offset < text.length) {
    // Case-fold only the candidate: Unicode casing can change the full text's length.
    if (text[offset] === '@'
      && text.slice(offset, offset + target.length).toLowerCase() === target
      && isUsernameBoundary(text[offset + target.length])) {
      offset += target.length;
    } else {
      result += text[offset];
      offset += 1;
    }
  }
  return result.trim();
}

const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const IMAGE_FILE_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);

function imageTypeForDocument(document) {
  const declaredType = document?.mime_type ?? document?.mimetype;
  const type = typeof declaredType === 'string' ? declaredType.toLowerCase() : '';
  if (IMAGE_MEDIA_TYPES.has(type)) return type;
  const filename = typeof document?.file_name === 'string' ? document.file_name.toLowerCase() : '';
  for (const [extension, mediaType] of IMAGE_FILE_TYPES) {
    if (filename.endsWith(extension)) return mediaType;
  }
  return null;
}

function fileSize(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function photoScore(photo) {
  return fileSize(photo?.file_size) ?? ((Number(photo?.width) || 0) * (Number(photo?.height) || 0));
}

function telegramImageSource(message, loadFile) {
  let file;
  let mediaType;
  let name;
  if (Array.isArray(message?.photo) && message.photo.length > 0) {
    file = message.photo.reduce((largest, candidate) => (
      photoScore(candidate) > photoScore(largest) ? candidate : largest
    ));
    mediaType = 'image/jpeg';
    name = `${file.file_unique_id ?? file.file_id ?? 'telegram-photo'}.jpg`;
  } else if (message?.document) {
    const type = imageTypeForDocument(message.document);
    if (!type) return null;
    file = message.document;
    mediaType = type;
    name = typeof file.file_name === 'string' ? file.file_name : undefined;
  }
  if (!file || typeof file.file_id !== 'string') return null;
  return {
    name,
    mediaType,
    size: fileSize(file.file_size),
    load: (options) => loadFile(file.file_id, options),
  };
}

function telegramFileSource(message, loadFile) {
  const file = message?.document;
  if (!file || imageTypeForDocument(file)
    || typeof file.file_id !== 'string' || !file.file_id) return null;
  const mediaType = typeof file.mime_type === 'string' && file.mime_type
    ? file.mime_type.toLowerCase() : undefined;
  return {
    name: typeof file.file_name === 'string' && file.file_name
      ? file.file_name : String(file.file_unique_id ?? file.file_id),
    ...(mediaType ? { mediaType } : {}),
    size: fileSize(file.file_size),
    load: ({ signal } = {}) => loadFile(file.file_id, { signal }),
  };
}

function telegramReplyAttachment(kind, file) {
  if (!file || typeof file !== 'object') return null;
  const name = typeof file.file_name === 'string' && file.file_name
    ? file.file_name : undefined;
  return { kind, ...(name ? { name } : {}) };
}

function telegramReplyAttachments(message) {
  const attachments = [];
  if (Array.isArray(message?.photo) && message.photo.length > 0) {
    const largest = message.photo.reduce((best, candidate) => (
      photoScore(candidate) > photoScore(best) ? candidate : best
    ));
    attachments.push(telegramReplyAttachment('image', largest));
  } else if (message?.document) {
    attachments.push(telegramReplyAttachment(
      imageTypeForDocument(message.document) ? 'image' : 'file',
      message.document,
    ));
  }
  for (const [field, kind] of [
    ['audio', 'audio'],
    ['voice', 'audio'],
    ['video', 'video'],
    ['video_note', 'video'],
    ['animation', 'video'],
  ]) {
    if (message?.[field]) attachments.push(telegramReplyAttachment(kind, message[field]));
  }
  if (message?.sticker) {
    attachments.push(telegramReplyAttachment(
      message.sticker.is_video === true ? 'video' : 'image',
      message.sticker,
    ));
  }
  return attachments.filter(Boolean);
}

function telegramReplyReference(message, { quote, loadReplyContent } = {}) {
  if ((!message || typeof message !== 'object')
    && (!quote || typeof quote !== 'object')) return undefined;
  const authorId = message?.from?.id === undefined ? undefined : String(message.from.id);
  const authorName = [message?.from?.first_name, message?.from?.last_name]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim()).join(' ') || (
      typeof message?.from?.username === 'string' && message.from.username
        ? message.from.username : undefined
    );
  const content = typeof message?.text === 'string'
    ? message.text : typeof message?.caption === 'string'
      ? message.caption : typeof quote?.text === 'string' ? quote.text : '';
  const attachments = telegramReplyAttachments(message);
  const messageId = Number.isSafeInteger(message?.message_id)
    ? String(message.message_id) : undefined;
  const createdAt = Number.isSafeInteger(message?.date) && message.date >= 0
    ? message.date * 1_000 : undefined;
  const load = !content.trim() && attachments.length === 0
    && typeof loadReplyContent === 'function'
    ? ({ signal } = {}) => loadReplyContent({
        ...(messageId ? { messageId } : {}),
        ...(createdAt === undefined ? {} : { createdAt }),
      }, { signal })
    : null;
  return {
    ...(messageId ? { messageId } : {}),
    ...(authorId ? { authorId } : {}),
    ...(authorName ? { authorName } : {}),
    ...(content.trim() ? { content } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(load ? { load } : {}),
    ...(!content.trim() && attachments.length === 0 && !load
      ? { unavailableReason: 'not-delivered' }
      : {}),
  };
}

/**
 * Normalize an inline-keyboard press into the same shape the bridge already
 * consumes for messages, so a button reuses the existing conversation key,
 * access policy, and pending-interaction routing instead of a parallel path.
 * A press always counts as addressed: the user acted on a message the bot sent.
 */
export function normalizeTelegramCallback(update, { botId } = {}) {
  const callback = update?.callback_query;
  const message = callback?.message;
  const chatId = message?.chat?.id;
  const senderId = callback?.from?.id;
  const providerMessageId = message?.message_id;
  if (!Number.isSafeInteger(update?.update_id)
    || typeof callback?.id !== 'string' || !callback.id
    || chatId === undefined || senderId === undefined
    || !Number.isSafeInteger(providerMessageId)) return null;
  if (!['private', 'group', 'supergroup'].includes(message.chat?.type)) return null;
  const direct = message.chat.type === 'private';
  const messageThreadId = Number.isSafeInteger(message.message_thread_id)
    ? message.message_thread_id : undefined;
  const conversationId = messageThreadId === undefined
    ? String(chatId) : `${chatId}:${messageThreadId}`;
  return {
    messageId: String(update.update_id),
    callbackQueryId: callback.id,
    providerMessageId,
    senderId: String(senderId),
    senderIsBot: callback.from?.is_bot === true,
    kind: direct ? 'direct' : 'group',
    conversationId,
    data: typeof callback.data === 'string' ? callback.data : '',
    addressed: true,
    replyTarget: {
      chatId,
      chatType: message.chat.type,
      messageThreadId,
    },
    reactionTarget: { chatId, messageId: providerMessageId },
    contextSource: () => ({
      senderName: [callback.from?.first_name, callback.from?.last_name]
        .filter((value) => typeof value === 'string' && value.trim())
        .map((value) => value.trim()).join(' ') || callback.from?.username,
      conversationTitle: direct ? undefined : message.chat?.title,
      chatId: String(chatId),
      threadId: messageThreadId === undefined ? undefined : String(messageThreadId),
    }),
    ...(botId === undefined ? {} : { botId }),
  };
}

/**
 * Access is decided before any download happens: a sender the allowlist refuses
 * must not spend local CPU or a provider quota on a message that will be dropped.
 */
export function voiceMessageAllowed(accessPolicy, message) {
  const decision = evaluateInboundAccess(accessPolicy, {
    conversationType: message?.kind === 'direct' ? 'direct' : 'group',
    senderIds: [message?.senderId],
    text: '',
  });
  return decision.allowed === true;
}

function formatDurationMs(value) {
  const ms = Math.max(1, Math.round(Number(value) || 0));
  return ms < 1_000 ? `${ms}ms` : `${Math.round(ms / 1_000)}s`;
}

/**
 * Fill `message.content` with a transcript or with an explicit note.
 *
 * `timeoutMs` bounds conversion plus provider time on its own controller, so a
 * slow recognizer cannot hold the chat open for the runtime's lifetime.
 */
export async function fillVoiceContent({
  message,
  voice = message?.voice,
  api,
  transcriber,
  timeoutMs = 60_000,
  signal,
  logFailure = null,
} = {}) {
  if (!transcriber) {
    message.content = voiceNote({ voice, reason: 'speech recognition is not enabled in this Host' });
    return;
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    const audio = await api.downloadFile({
      fileId: voice.fileId,
      signal: controller.signal,
      maxBytes: VOICE_MAX_BYTES,
    });
    const transcript = await transcriber.transcribe({ audio, voice, signal: controller.signal });
    // Providers may return raw text; an empty result is not a transcript.
    const text = typeof transcript === 'string' ? transcript.trim() : '';
    message.content = text || voiceNote({ voice, reason: 'no speech recognized' });
  } catch (error) {
    if (signal?.aborted) return;
    const reason = controller.signal.aborted
      ? `transcription timed out after ${formatDurationMs(timeoutMs)}`
      : voiceFailureReason(error);
    message.content = voiceNote({ voice, reason });
    logFailure?.(reason, error);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

export function normalizeTelegramUpdate(update, {
  botId,
  username,
  groupTriggers,
  loadFile = async () => { throw new Error('Telegram file downloader is unavailable'); },
  loadFileStream = loadFile,
  loadReplyContent,
}) {
  const message = update?.message;
  const chatId = message?.chat?.id;
  const senderId = message?.from?.id;
  const messageId = message?.message_id;
  if (!Number.isSafeInteger(update?.update_id) || chatId === undefined || senderId === undefined
    || !Number.isSafeInteger(messageId)) return null;
  if (!['private', 'group', 'supergroup'].includes(message.chat?.type)) return null;
  const direct = message.chat.type === 'private';
  // A reply to the bot or an @username mention is the legacy "tagged" signal;
  // the per-group rule decides whether it is enough (or unnecessary).
  const tagged = String(message.reply_to_message?.from?.id ?? '') === String(botId)
    || mentionedUsername(message, username);
  const addressed = direct || groupTriggerAddressed(groupTriggers, {
    chatId: String(chatId),
    senderId: String(senderId),
    tagged,
  });
  const messageThreadId = Number.isSafeInteger(message.message_thread_id)
    ? message.message_thread_id : undefined;
  const image = telegramImageSource(message, loadFile);
  const file = telegramFileSource(message, loadFileStream);
  // Voice notes carry no text; a speech service later fills `content` in.
  const voice = telegramVoiceSource(message);
  const conversationId = messageThreadId === undefined
    ? String(chatId) : `${chatId}:${messageThreadId}`;
  const key = `${direct ? 'direct' : 'group'}:${conversationId}`;
  const replyTo = telegramReplyReference(
    message.reply_to_message ?? message.external_reply,
    {
      quote: message.quote,
      ...(typeof loadReplyContent === 'function' ? {
        loadReplyContent: (reference, options) => loadReplyContent({
          conversationKey: key,
          ...reference,
        }, options),
      } : {}),
    },
  );
  return {
    messageId: String(update.update_id),
    senderId: String(senderId),
    contextSource: () => ({
      senderName: [message.from?.first_name, message.from?.last_name]
        .filter((value) => typeof value === 'string' && value.trim())
        .map((value) => value.trim()).join(' ') || message.from?.username,
      conversationTitle: direct ? undefined : message.chat?.title,
      chatId: String(chatId),
      threadId: messageThreadId === undefined ? undefined : String(messageThreadId),
    }),
    senderIsBot: message.from?.is_bot === true,
    kind: direct ? 'direct' : 'group',
    conversationId,
    content: withoutBotMention(message.text ?? message.caption ?? '', username),
    plainText: typeof message.text === 'string',
    images: image ? [image] : [],
    files: file ? [file] : [],
    ...(voice ? { voice } : {}),
    ...(replyTo ? { replyTo } : {}),
    addressed,
    reactionTarget: { chatId, messageId },
    replyTarget: {
      chatId,
      chatType: message.chat.type,
      replyToMessageId: messageId,
      messageThreadId,
    },
    connectionTestTarget: { chatId, messageThreadId },
  };
}

export function telegramInboundAllowed(message, {
  accessMode = TELEGRAM_ACCESS_MODES.compatible,
  allowedPrivateUserIds = new Set(),
} = {}) {
  if (accessMode !== TELEGRAM_ACCESS_MODES.privateAllowlist) return true;
  return message?.kind === 'direct'
    && allowedPrivateUserIds instanceof Set
    && allowedPrivateUserIds.has(String(message.senderId));
}

function telegramMessageId(value) {
  return Number.isSafeInteger(value?.message_id) ? String(value.message_id) : null;
}

function telegramFailure(error) {
  const providerCode = Number(error?.providerCode);
  const status = Number(error?.status);
  const unknown = error?.deliveryOutcome === 'unknown'
    || providerCode >= 500
    || status >= 500
    || ['telegram-timeout', 'telegram-aborted-after-dispatch', 'telegram-transport-error',
      'telegram-response-invalid'].includes(error?.code);
  return {
    outcome: unknown ? 'unknown' : 'failed',
    reason: typeof error?.code === 'string' && error.code
      ? error.code
      : unknown ? 'telegram-delivery-uncertain' : 'telegram-provider-rejected',
  };
}

function deliveryResult(presentation, providerMessageIds, deliveryOutcome = 'sent', reason) {
  return {
    presentation,
    providerMessageIds: [...new Set(providerMessageIds)],
    deliveryOutcome,
    ...(reason ? { reason } : {}),
  };
}

class TelegramDeliveryStream {
  #update;
  #finish;
  #fail;
  #logger;
  #providerMessageIds;
  #closed = false;
  #lastUpdate = null;
  #lastBlock = null;
  #keepalive = false;
  #previewAnswer = true;
  #previewStopped = false;
  #chain = Promise.resolve();

  constructor({
    update,
    finish,
    fail,
    providerMessageIds = [],
    presentation,
    logger,
    keepalive = false,
    previewAnswer = true,
  }) {
    this.#update = update;
    this.#finish = finish;
    this.#fail = fail;
    this.#providerMessageIds = providerMessageIds;
    this.presentation = presentation;
    this.#logger = logger;
    // Only short-lived carriers (e.g. the private-chat Rich Draft) need a
    // keepalive refresh; editing a real placeholder message with identical
    // content would be rejected by the platform.
    this.#keepalive = keepalive === true;
    // The placeholder is deleted before the answer is sent, so mirroring the
    // answer text into it would show the same reply twice: first as a run of
    // edits, then again as the delivered message.
    this.#previewAnswer = previewAnswer !== false;
  }

  /** Whether answer text may be shown in the carrier before it is delivered. */
  get previewAnswer() {
    return this.#previewAnswer;
  }

  get providerMessageIds() {
    return [...this.#providerMessageIds];
  }

  /** Whether this carrier is short-lived and wants a keepalive heartbeat. */
  get keepalive() {
    return this.#keepalive;
  }

  /** Serialize every write so an in-flight keepalive refresh can never land
   *  after the final frame: finish()/fail() queue behind refresh()/update(). */
  #enqueue(task) {
    const run = this.#chain.then(task);
    this.#chain = run.catch(() => undefined);
    return run;
  }

  // Live drafts can block the user's composer. Drain any pending draft before
  // the regular question/approval message clears it, and keep this turn's
  // preview stopped so late progress cannot block the answer again.
  stopPreview() {
    this.#previewStopped = true;
    return this.#enqueue(() => undefined);
  }

  update(value) {
    return this.#enqueue(async () => {
      if (this.#closed || this.#previewStopped) return undefined;
      const block = createTextDeliveryBlock(value);
      this.#lastBlock = block;
      const key = `${block.format}:${block.text}`;
      if (key === this.#lastUpdate) return undefined;
      this.#lastUpdate = key;
      try {
        return await this.#update(block);
      } catch (error) {
        this.#logger.warn?.('[dsh-im:telegram] rich stream update failed:', extractConnectionEvidence(error).details);
        return undefined;
      }
    });
  }

  /** Re-send the most recent frame even when unchanged, to keep a short-lived
   *  carrier (the private-chat Rich Draft) visible during long silent
   *  stretches such as a running tool call. Serialized like update() so it
   *  never overtakes a later finish(). No-op for carriers without keepalive. */
  refresh() {
    return this.#enqueue(async () => {
      if (this.#closed || this.#previewStopped || !this.#keepalive || !this.#lastBlock) return undefined;
      try {
        return await this.#update(this.#lastBlock);
      } catch (error) {
        this.#logger.warn?.('[dsh-im:telegram] rich stream refresh failed:', extractConnectionEvidence(error).details);
        return undefined;
      }
    });
  }

  finish(value) {
    return this.#enqueue(async () => {
      if (this.#closed) throw new Error('Message stream is already closed');
      this.#closed = true;
      const result = await this.#finish(createTextDeliveryBlock(value));
      this.#providerMessageIds.push(...(result?.providerMessageIds ?? []));
      return result;
    });
  }

  fail(text) {
    return this.#enqueue(async () => {
      if (this.#closed) return undefined;
      this.#closed = true;
      const result = await this.#fail(createTextDeliveryBlock(text, 'plain'));
      this.#providerMessageIds.push(...(result?.providerMessageIds ?? []));
      return result;
    });
  }

  cancel() {
    this.#closed = true;
  }
}

// Thinking-trace display rules. Truncation fallback (spoiler / inline-button
// expansion are follow-ups gated on three-platform client verification):
// tool traces cap the argument summary, reasoning caps the first paragraph.
const TOOL_TRACE_ARG_KEYS = Object.freeze([
  'command', 'pattern', 'query', 'url', 'file_path', 'path', 'text', 'prompt', 'message', 'description',
]);
const TOOL_TRACE_SUMMARY_LIMIT = 120;
const THINKING_LINE_LIMIT = 200;

function truncateCapped(value, limit) {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** Extract a one-line argument summary from a tool call's `arguments`. */
export function toolTraceSummary(argumentsValue) {
  let record = null;
  if (argumentsValue && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)) {
    record = argumentsValue;
  } else if (typeof argumentsValue === 'string') {
    const trimmed = argumentsValue.trim();
    if (!trimmed) return null;
    let parsed = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return truncateCapped(trimmed.replace(/\s+/g, ' ').trim(), TOOL_TRACE_SUMMARY_LIMIT);
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      record = parsed;
    } else {
      return truncateCapped(trimmed.replace(/\s+/g, ' ').trim(), TOOL_TRACE_SUMMARY_LIMIT);
    }
  }
  if (!record) return null;
  for (const key of TOOL_TRACE_ARG_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return truncateCapped(value.replace(/\s+/g, ' ').trim(), TOOL_TRACE_SUMMARY_LIMIT);
    }
  }
  return null;
}

/** Format one tool-trace line: `🔧 <name> → <summary>` (summary optional). */
export function formatToolTrace(name, argumentsValue) {
  const toolName = typeof name === 'string' && name.trim() ? name.trim() : t('工具');
  const summary = toolTraceSummary(argumentsValue);
  return summary ? `🔧 ${toolName} → ${summary}` : `🔧 ${toolName}`;
}

/** Format one reasoning line: `💭 <first paragraph>` (200-char cap). */
export function formatThinkingLine(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return null;
  const firstParagraph = trimmed.split(/\n{2,}/)[0].trim();
  if (!firstParagraph) return null;
  return `💭 ${truncateCapped(firstParagraph, THINKING_LINE_LIMIT)}`;
}

/** Telegram reports an idempotent edit with HTTP 400; treat it as success. */
function isMessageNotModified(error) {
  return /message is not modified/iu.test(error?.message ?? '');
}

export class TelegramBotClient {
  #api;
  #signal;
  #logger;

  constructor({ api, signal, logger = console }) {
    this.#api = api;
    this.#signal = signal;
    this.#logger = logger;
  }

  async sendText(target, text) {
    const chunks = splitTelegramRegularText(text);
    const providerMessageIds = [];
    for (const [index, chunk] of chunks.entries()) {
      const result = await this.#api.sendMessage({
        chatId: target.chatId,
        text: chunk,
        replyToMessageId: index === 0 ? target.replyToMessageId : undefined,
        messageThreadId: target.messageThreadId,
        signal: this.#signal,
      });
      if (Number.isSafeInteger(result?.message_id)) {
        providerMessageIds.push(String(result.message_id));
      }
    }
    return { providerMessageIds };
  }

  /**
   * Deliver a card whose inline keyboard carries the interaction payloads.
   * Kept separate from sendText so a markup failure can be caught and degraded
   * to the plain-text flow by the caller without losing the text itself.
   */
  async sendInteractionCard(target, { text, markup, replyToMessageId } = {}) {
    const result = await this.#api.sendMessage({
      chatId: target.chatId,
      text,
      replyToMessageId: replyToMessageId ?? target.replyToMessageId,
      messageThreadId: target.messageThreadId,
      replyMarkup: markup,
      signal: this.#signal,
    });
    const providerMessageIds = [];
    if (Number.isSafeInteger(result?.message_id)) {
      providerMessageIds.push(String(result.message_id));
    }
    return { providerMessageIds };
  }

  /** Replace a delivered card's keyboard in place; an empty keyboard removes it. */
  async updateInteractionCard(target, providerMessageId, { markup } = {}) {
    try {
      await this.#api.editMessageReplyMarkup({
        chatId: target.chatId,
        messageId: Number(providerMessageId),
        replyMarkup: markup,
        signal: this.#signal,
      });
    } catch (error) {
      // Clearing a keyboard that is already gone is the desired end state.
      if (!isMessageNotModified(error)) throw error;
    }
  }

  /**
   * Rewrite a delivered card's text and keyboard in one `editMessageText` call.
   *
   * Telegram answers "message is not modified" when the client already holds the
   * exact payload (a duplicate resolution); that is success, not failure. If a
   * Bot API deployment refuses the combined text+keyboard edit, degrade to the
   * two calls this client already supports — the interface stays the same.
   */
  async editInteractionCard(target, providerMessageId, { text, markup } = {}) {
    const messageId = Number(providerMessageId);
    if (!Number.isSafeInteger(messageId)) {
      throw new TypeError('Telegram card message id must be a safe integer');
    }
    try {
      return await this.#api.editMessageText({
        chatId: target.chatId,
        messageId,
        text,
        replyMarkup: markup,
        signal: this.#signal,
      });
    } catch (error) {
      if (isMessageNotModified(error)) return { unchanged: true };
      if (error?.code !== 'telegram-400' || markup === undefined) throw error;
      // Clear the dead keyboard first so a stale card cannot keep submitting.
      try {
        await this.#api.editMessageReplyMarkup({
          chatId: target.chatId,
          messageId,
          replyMarkup: markup,
          signal: this.#signal,
        });
      } catch (markupError) {
        if (!isMessageNotModified(markupError)) throw markupError;
      }
      await this.#api.editMessageText({
        chatId: target.chatId,
        messageId,
        text,
        signal: this.#signal,
      });
      return { fallback: true };
    }
  }

  /** Stop the client-side spinner on a pressed button. */
  async answerInteractionCallback(callbackQueryId, notice) {
    await this.#api.answerCallbackQuery({
      callbackQueryId,
      text: notice,
      signal: this.#signal,
    });
  }

  async addReaction(target, emoji, { signal } = {}) {
    const reactionKey = String(emoji ?? '').trim();
    await this.#api.setMessageReaction({
      chatId: target.chatId,
      messageId: target.messageId,
      emoji: reactionKey,
      signal: signal ?? this.#signal,
    });
    return reactionKey;
  }

  removeReaction(target, _reactionKey, { signal } = {}) {
    return this.#api.setMessageReaction({
      chatId: target.chatId,
      messageId: target.messageId,
      signal: signal ?? this.#signal,
    });
  }

  sendTyping(target) {
    return this.#api.sendChatAction({
      chatId: target.chatId,
      messageThreadId: target.messageThreadId,
      signal: this.#signal,
    });
  }

  sendFile(target, file) {
    return this.#api.sendDocument({
      chatId: target.chatId,
      file,
      replyToMessageId: target.replyToMessageId,
      messageThreadId: target.messageThreadId,
      signal: this.#signal,
    });
  }

  sendImage(target, file) {
    return this.#api.sendPhoto({
      chatId: target.chatId,
      file,
      replyToMessageId: target.replyToMessageId,
      messageThreadId: target.messageThreadId,
      signal: this.#signal,
    });
  }

  async #sendPlain(target, text) {
    const chunks = splitTelegramRegularText(text);
    const providerMessageIds = [];
    for (const [index, chunk] of chunks.entries()) {
      try {
        const result = await this.#api.sendMessage({
          chatId: target.chatId,
          text: chunk,
          replyToMessageId: index === 0 ? target.replyToMessageId : undefined,
          messageThreadId: target.messageThreadId,
          signal: this.#signal,
        });
        const id = telegramMessageId(result);
        if (id) providerMessageIds.push(id);
      } catch (error) {
        const failure = telegramFailure(error);
        return deliveryResult(
          'text-fallback',
          providerMessageIds,
          failure.outcome,
          failure.reason,
        );
      }
    }
    return deliveryResult('text-fallback', providerMessageIds);
  }

  /** Drop the progress placeholder before the answer is sent so the turn ends
   *  with a notification instead of a silent edit. Best-effort: Telegram only
   *  lets a bot delete its own messages for 48 hours, and a stale placeholder
   *  must never cost the reader the answer that was already produced. */
  async #deletePlaceholder(target, messageId) {
    try {
      await this.#api.deleteMessage({
        chatId: target.chatId,
        messageId,
        signal: this.#signal,
      });
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-im:telegram] unable to delete the processing placeholder:',
        error,
      );
    }
  }

  async #sendRich(target, block) {
    if (block.format === 'plain') return this.#sendPlain(target, block.text);

    let chunks;
    try {
      chunks = splitTelegramRichMarkdown(block.text);
    } catch {
      this.#logger.warn?.('[dsh-im:telegram] Rich Markdown could not be prepared; sending plain text');
      return this.#sendPlain(target, block.text);
    }
    const providerMessageIds = [];
    for (const [index, chunk] of chunks.entries()) {
      try {
        const result = await this.#api.sendRichMessage({
          chatId: target.chatId,
          richMessage: { markdown: chunk.markdown },
          replyToMessageId: index === 0 ? target.replyToMessageId : undefined,
          messageThreadId: target.messageThreadId,
          signal: this.#signal,
        });
        const id = telegramMessageId(result);
        if (id) providerMessageIds.push(id);
      } catch (error) {
        const failure = telegramFailure(error);
        if (failure.outcome === 'unknown') {
          return deliveryResult(
            'telegram-rich-final',
            providerMessageIds,
            'unknown',
            failure.reason,
          );
        }
        const remaining = chunks.slice(index).map((part) => part.source).join('');
        const fallback = await this.#sendPlain({
          ...target,
          replyToMessageId: index === 0 ? target.replyToMessageId : undefined,
        }, remaining);
        return deliveryResult(
          fallback.presentation,
          [...providerMessageIds, ...fallback.providerMessageIds],
          fallback.deliveryOutcome,
          fallback.reason,
        );
      }
    }
    return deliveryResult('telegram-rich-final', providerMessageIds);
  }

  sendDelivery(target, value) {
    return this.#sendRich(target, createTextDeliveryBlock(value));
  }

  async openDeliveryStream(target) {
    // Real messages keep the Android composer available for /stop and /steer;
    // private-chat Rich Drafts can block sending for the whole turn (#276).
    const placeholder = await this.#api.sendMessage({
      chatId: target.chatId,
      text: t('正在处理…'),
      replyToMessageId: target.replyToMessageId,
      messageThreadId: target.messageThreadId,
      signal: this.#signal,
    });
    const messageId = placeholder?.message_id;
    if (!Number.isSafeInteger(messageId)) {
      throw new Error('Telegram did not return a placeholder message id');
    }
    return new TelegramDeliveryStream({
      update: async (block) => {
        if (block.format === 'plain') {
          await this.#api.editMessageText({
            chatId: target.chatId,
            messageId,
            text: block.text,
            signal: this.#signal,
          });
          return deliveryResult('text-fallback', [String(messageId)]);
        }
        await this.#api.editMessageText({
          chatId: target.chatId,
          messageId,
          richMessage: { markdown: toTelegramRichMarkdown(block.text) },
          signal: this.#signal,
        });
        return deliveryResult('telegram-rich-draft', [String(messageId)]);
      },
      // The placeholder carries progress only: its last frame would be a silent
      // edit, so the answer goes out as its own message and Telegram notifies
      // the reader that the turn is over.
      finish: async (block) => {
        await this.#deletePlaceholder(target, messageId);
        return this.#sendRich(target, block);
      },
      fail: async (block) => {
        await this.#deletePlaceholder(target, messageId);
        return this.#sendPlain(target, block.text);
      },
      presentation: 'telegram-regular',
      // Answer text is not mirrored into the placeholder: it is deleted before
      // the real message goes out, so a preview would duplicate the reply.
      previewAnswer: false,
      logger: this.#logger,
    });
  }

  async openStream(target) {
    const stream = createEditableMessageStream({
      limit: 4_000,
      create: async (text) => {
        const message = await this.#api.sendMessage({
          chatId: target.chatId,
          text,
          replyToMessageId: target.replyToMessageId,
          messageThreadId: target.messageThreadId,
          signal: this.#signal,
        });
        return message.message_id;
      },
      edit: (messageId, text) => this.#api.editMessageText({
        chatId: target.chatId,
        messageId,
        text,
        signal: this.#signal,
      }),
      sendRemainder: (text) => this.#api.sendMessage({
        chatId: target.chatId,
        text,
        messageThreadId: target.messageThreadId,
        signal: this.#signal,
      }),
      messageIdForResult: (message) => message?.message_id,
    });
    return stream.start();
  }

  /**
   * Thinking-trace stream: every intermediate line is a permanent, separate
   * Telegram message (no placeholder editing), so the user watches the
   * "think → act" chain build up. Trace lines are best-effort; the final
   * answer must still land, falling back to plain sendText delivery.
   */
  openThinkingStream(target) {
    const client = this;
    const providerMessageIds = [];
    let firstMessageId = null;
    let closed = false;
    const logger = this.#logger;
    const warnFailure = (label, error) => {
      logger?.warn?.(`[dsh-im:telegram] thinking stream ${label} failed:`, error);
    };
    const sendLine = async (text) => {
      const message = await this.#api.sendMessage({
        chatId: target.chatId,
        text,
        replyToMessageId: firstMessageId === null ? target.replyToMessageId : undefined,
        messageThreadId: target.messageThreadId,
        signal: this.#signal,
      });
      const id = message?.message_id;
      if (Number.isSafeInteger(id)) {
        if (firstMessageId === null) firstMessageId = id;
        providerMessageIds.push(String(id));
      }
    };
    return {
      get messageId() {
        return firstMessageId;
      },
      get providerMessageIds() {
        return [...providerMessageIds];
      },
      presentation: 'telegram-thinking',
      // The chain is made of permanent messages, but long tool runs still
      // want the typing indicator; the bridge re-sends it every 4 seconds.
      keepalive: true,
      update: async () => {},
      refresh: async () => {},
      sendLine,
      sendToolTrace: (name, argumentsValue) => (async () => {
        if (closed) return;
        try {
          await sendLine(formatToolTrace(name, argumentsValue));
        } catch (error) {
          warnFailure('tool trace', error);
        }
      })(),
      sendThinking: (text) => (async () => {
        if (closed) return;
        const line = formatThinkingLine(text);
        if (!line) return;
        try {
          await sendLine(line);
        } catch (error) {
          warnFailure('thinking line', error);
        }
      })(),
      async finish(answer) {
        if (closed) throw new Error('Message stream is already closed');
        closed = true;
        const format = answer && typeof answer === 'object' && answer.format === 'markdown'
          ? 'markdown'
          : 'plain';
        const text = answer && typeof answer === 'object' && typeof answer.text === 'string'
          ? answer.text
          : typeof answer === 'string' ? answer : '';
        const trimmed = text.trim();
        const answerText = trimmed || t('处理完成。');
        // The final answer keeps the channel's normal delivery path, so a
        // markdown answer renders rich (bold, code fences) exactly like
        // non-trace mode; trace lines above stay plain permanent messages.
        // Markdown goes to #sendRich in one shot: splitTelegramRichMarkdown
        // is fence-aware, so code blocks with inner blank lines stay intact
        // and no blank line is rewritten. A blank-line pre-split would break
        // both: unfinished fences fall back to plain, and rejoining with a
        // fixed separator collapses \n{3,} inside multi-line strings. Plain
        // answers use the whitespace-preserving regular-text splitter.
        const chunks = format === 'markdown'
          ? [answerText]
          : splitTelegramRegularText(answerText);
        const remember = (ids) => {
          for (const id of ids ?? []) {
            if (!providerMessageIds.includes(id)) providerMessageIds.push(id);
          }
        };
        for (let index = 0; index < chunks.length; index += 1) {
          let result;
          try {
            result = await client.#sendRich(target, createTextDeliveryBlock(chunks[index], format));
          } catch (error) {
            const failure = telegramFailure(error);
            warnFailure('final answer', error);
            if (failure.outcome === 'unknown') {
              return deliveryResult('telegram-thinking', providerMessageIds, 'unknown', failure.reason);
            }
          }
          if (result?.deliveryOutcome === 'sent') {
            remember(result.providerMessageIds);
            continue;
          }
          if (result?.deliveryOutcome === 'unknown') {
            // 结果未知（超时等）：可能已送达，重发会造成重复，保留 unknown 状态。
            remember(result.providerMessageIds);
            return deliveryResult('telegram-thinking', providerMessageIds, 'unknown', result.reason);
          }
          // 明确失败：该分片确认未送达。纯文本分片再走一次 plain 重发
          // （markdown 分片的 plain 回退已在 #sendRich 内尝试过），只重发
          // 尚未发送的尾部内容，已成功的分片不重复。
          remember(result?.providerMessageIds);
          if (format === 'markdown') {
            return deliveryResult('telegram-thinking', providerMessageIds, 'failed', result.reason);
          }
          warnFailure('final answer chunk', new Error('chunk definitively rejected'));
          try {
            // Regular-text chunks already retain the original whitespace.
            const fallback = await client.sendText(target, chunks.slice(index).join(''));
            remember(fallback.providerMessageIds);
            return deliveryResult('telegram-thinking', providerMessageIds);
          } catch (error) {
            const failure = telegramFailure(error);
            warnFailure('final answer fallback', error);
            return deliveryResult('telegram-thinking', providerMessageIds, failure.outcome, failure.reason);
          }
        }
        return deliveryResult('telegram-thinking', providerMessageIds);
      },
      cancel() {
        closed = true;
      },
    };
  }
}

export function createTelegramRuntimeStatus() {
  return {
    startedAt: null,
    ready: false,
    connectionState: 'idle',
    harnessReachable: false,
    lastCheckedAt: null,
    lastConnectedAt: null,
    lastError: null,
    ...createTelegramBridgeStatus(),
  };
}

export class TelegramRuntime {
  #config;
  #token;
  #harness;
  #state;
  #contextEnhancement;
  #groupHistory;
  #groupTriggers;
  #accessPolicy;
  #voice;
  #voiceTimeoutMs;
  #conversationQueue;
  /** Reasons already reported, so a broken recognizer logs once. */
  #voiceFailures = new Set();
  #logger;
  #diagnostics;
  #replyTimeoutMs;
  #createApi;
  #createHttpTransport;
  #commandCatalog;
  #status = createTelegramRuntimeStatus();
  #httpTransport = null;
  #api = null;
  #bridge = null;
  #abortController = null;
  #pollTask = null;
  #starting = null;
  // True only while #start() is between "started connecting" and "ready",
  // which is the one window a skipped refresh must be reconciled. A refresh on
  // a never-started or already-stopped runtime stays a no-op.
  #connecting = false;
  // True when a language switch arrived while the runtime was connecting, so a
  // refreshCommandMenu() had nothing to push. Reconciled once startup
  // completes, so the platform always ends up with the latest language.
  #menuDirty = false;

  constructor({
    config,
    token,
    harness,
    state,
    contextEnhancement,
    groupHistory,
    accessPolicy,
    voice = null,
    voiceTimeoutMs = 60_000,
    logger = console,
    replyTimeoutMs = 600_000,
    createApi = (options) => new TelegramApi(options),
    createHttpTransport = createTelegramHttpTransport,
    commandCatalog = SHARED_COMMAND_CATALOG,
  }) {
    if (!config || !token || !harness || !state) {
      throw new TypeError('TelegramRuntime requires config, token, Harness, and state');
    }
    this.#config = config;
    this.#token = token;
    this.#harness = harness;
    this.#state = state;
    this.#contextEnhancement = contextEnhancement;
    this.#groupHistory = groupHistory;
    // Rules change through the controller, which restarts the runtime, so the
    // normalized snapshot is read once per start.
    this.#groupTriggers = normalizeGroupTriggers(config.groupTriggers);
    this.#accessPolicy = accessPolicy;
    // null when the Host mounts no speech service; voice messages then stay textless.
    this.#voice = voice;
    this.#voiceTimeoutMs = voiceTimeoutMs;
    // Voice prep and delivery are serialised per conversation, never per poll.
    this.#conversationQueue = createConversationQueue({
      onError: (error, key) => this.#logger.error?.(
        `[dsh-im:telegram] bot ${this.#config.botId} queued work failed for ${key}:`,
        error?.message ?? error,
      ),
    });
    this.#logger = logger; this.#diagnostics = createConnectionDiagnostics({ channel: 'telegram', logger });
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#createApi = createApi;
    this.#createHttpTransport = createHttpTransport;
    this.#commandCatalog = commandCatalog;
  }

  get status() {
    return structuredClone(this.#status);
  }

  async sendConnectionTest(text) {
    if (!this.#status.ready || !this.#bridge) {
      const error = new Error('Telegram bot is not connected');
      error.code = 'test-target-unavailable';
      throw error;
    }
    return this.#bridge.sendConnectionTest(text);
  }

  async presentSessionSyncApproval(target, interaction, options = {}) {
    if (!this.#status.ready || !this.#bridge) return false;
    const actor = typeof target?.route?.chatId === 'string' ? target.route.chatId.trim() : '';
    if (!actor) return false;
    return this.#bridge.presentSessionSyncApproval(interaction, {
      key: options.key, actor, validate: options.validate,
      send: (text) => this.sendProactiveText(target, text),
    }, options);
  }

  async sendProactiveText(target, text, options = {}) {
    if (!this.#status.ready || !this.#bridge) {
      const error = new Error('Telegram bot is not connected');
      error.code = 'bot-not-connected';
      throw error;
    }
    const chatIdText = typeof target?.route?.chatId === 'string'
      ? target.route.chatId.trim() : '';
    const chatId = Number(chatIdText);
    const messageThreadId = target?.route?.messageThreadId;
    if (!/^-?\d+$/.test(chatIdText) || !Number.isSafeInteger(chatId)
      || (target?.kind !== 'chat' && target?.kind !== 'topic')
      || (target.kind === 'topic' && (!Number.isSafeInteger(messageThreadId) || messageThreadId <= 0))
      || (target.kind === 'chat' && messageThreadId !== undefined)) {
      const error = new TypeError('Invalid Telegram proactive delivery target');
      error.code = 'invalid-target';
      throw error;
    }
    return this.#bridge.sendProactiveText({
      chatId,
      ...(target.kind === 'topic' ? { messageThreadId } : {}),
    }, text, options);
  }

  async start() {
    if (this.#status.ready && this.#pollTask) return this.status;
    if (this.#starting) return this.#starting;
    this.#starting = this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #start() {
    await this.stop();
    this.#connecting = true;
    this.#status.startedAt = new Date().toISOString();
    this.#status.connectionState = 'connecting';
    this.#status.lastError = null; this.#status.error = null; this.#diagnostics.clear();
    await atConnectionStage('harness.check', () => this.#harness.ensureRunning());
    this.#status.harnessReachable = true;

    const controller = new AbortController();
    this.#abortController = controller;
    try {
      const transport = this.#createHttpTransport();
      this.#httpTransport = transport;
      const api = this.#createApi({
        token: this.#token,
        fetchImpl: transport.fetchImpl,
        FormDataImpl: transport.FormDataImpl,
      });
      this.#api = api;
      const bot = await api.getMe({ signal: controller.signal });
      if (String(bot?.id ?? '') !== this.#config.platformId || bot?.is_bot !== true) {
        throw new Error('Telegram token identity does not match the saved bot');
      }
      const webhook = await api.getWebhookInfo({ signal: controller.signal });
      if (typeof webhook?.url === 'string' && webhook.url) {
        const error = new Error(t('该 Telegram 机器人已配置 Webhook，请先在原服务中移除 Webhook 后重试。'));
        error.code = 'webhook-configured';
        throw error;
      }
      try {
        await this.#sendCommandMenu(api, controller.signal);
        await api.setChatMenuButton({ menuButton: COMMANDS_MENU_BUTTON, signal: controller.signal });
      } catch (error) {
        this.#logger.warn?.(
          `[dsh-im:telegram] bot ${this.#config.botId} command menu setup failed:`,
          extractConnectionEvidence(error).details,
        );
      }
      const client = new TelegramBotClient({
        api,
        signal: controller.signal,
        logger: this.#logger,
      });
      this.#bridge = new TelegramHarnessBridge({
        bot: client,
        harness: this.#harness,
        state: this.#state,
        contextEnhancement: this.#contextEnhancement,
        accessPolicy: this.#accessPolicy,
        // Default ON; an explicit false in the bot config opts out.
        thinkingTraces: this.#config?.thinkingTraces !== false,
        status: this.#status,
        logger: this.#logger,
        replyTimeoutMs: this.#replyTimeoutMs,
        signal: controller.signal,
      });

      let cursor = this.#state.cursor();
      if (cursor === null) {
        const latest = await api.getUpdates({ offset: -1, timeout: 0, signal: controller.signal });
        cursor = latest.length > 0 ? latest.at(-1).update_id + 1 : 0;
        await this.#state.setCursor(cursor);
      }
      const now = Date.now();
      this.#status.ready = true;
      this.#status.connectionState = 'connected';
      this.#status.lastCheckedAt = now;
      this.#status.lastConnectedAt = now;
      // A language switch that landed while we were connecting was skipped by
      // refreshCommandMenu(); re-send the menu now that the API is usable, so
      // the platform ends with the latest language instead of the one that was
      // current when #sendCommandMenu first ran.
      if (this.#menuDirty) {
        this.#menuDirty = false;
        try {
          await this.#sendCommandMenu(api, controller.signal);
        } catch (error) {
          this.#logger.warn?.(
            `[dsh-im:telegram] bot ${this.#config.botId} command menu catch-up failed:`,
            extractConnectionEvidence(error).details,
          );
        }
      }
      await this.#replayPendingVoice(controller.signal);
      this.#pollTask = this.#poll(cursor, controller.signal);
      this.#pollTask.catch((error) => {
        if (controller.signal.aborted) return;
        this.#status.ready = false;
        this.#status.connectionState = 'failed';
        this.#status.error = this.#diagnostics.report(error, { operation: 'connection.monitor', botId: this.#config?.botId, automatic: true }).publicError;
        this.#status.lastError = this.#status.error.message;

      });
      return this.status;
    } catch (error) {
      this.#status.ready = false;
      this.#status.connectionState = 'failed';
      this.#status.error = this.#diagnostics.report(error, { operation: 'connection.restore', reuse: true, botId: this.#config?.botId, automatic: true }).publicError;
      this.#status.lastError = this.#status.error.message;
      await this.stop();
      throw error;
    } finally {
      // Whether the bot is now ready or the attempt failed, the connecting
      // window is over. A failed attempt also drops any unreconciled dirty
      // flag: a later retry re-sends the menu from scratch in the current
      // language anyway.
      this.#connecting = false;
      this.#menuDirty = false;
    }
  }

  // Both operations use the existing default scope and language. Sending the
  // full list replaces old entries; an empty catalog clears that list.
  async #sendCommandMenu(api, signal) {
    const commands = telegramCommandMenu(this.#commandCatalog);
    if (commands.length > 0) await api.setMyCommands({ commands, signal });
    else await api.deleteMyCommands({ signal });
  }

  /**
   * Re-send the command menu in the current host message language.
   *
   * The menu Telegram shows is registered once per connection, so a language
   * change would otherwise stay invisible until the bot reconnected. This
   * replaces the text only: the chat menu button is owned by connect.
   * @returns whether a connected bot accepted the refreshed menu.
   */
  async refreshCommandMenu() {
    const api = this.#api;
    const signal = this.#abortController?.signal;
    if (!this.#status.ready || !api || !signal || signal.aborted) {
      // A refresh during an in-progress connection must not be lost: mark the
      // menu dirty so #start() reconciles it the moment the bot is ready. A
      // never-started or stopped runtime stays a no-op, as before.
      if (this.#connecting) this.#menuDirty = true;
      return false;
    }
    try {
      await this.#sendCommandMenu(api, signal);
      return true;
    } catch (error) {
      this.#logger.warn?.(
        `[dsh-im:telegram] bot ${this.#config.botId} command menu refresh failed:`,
        extractConnectionEvidence(error).details,
      );
      return false;
    }
  }

  /**
   * Queue one update: durable pending record first, then per-conversation work.
   *
   * Ordering inside a chat is kept, while other chats, callbacks and the cursor
   * keep moving. The pending entry is removed only once the bridge owns the
   * message, so a restart before that point can replay it.
   */
  async #dispatchUpdate(update, message, contextSnapshot, signal) {
    const needsPreparation = Boolean(message.voice) && message.addressed === true
      && !message.content.trim();
    const pendingId = `telegram-voice:${update.update_id}`;
    if (needsPreparation) {
      try {
        await this.#state.putPendingMessage({
          id: pendingId,
          key: message.conversationId,
          messageId: String(message.messageId),
          kind: message.kind,
          text: voiceNote({ voice: message.voice, reason: 'transcription pending' }),
          senderId: String(message.senderId),
          target: { voiceReplay: { update, contextSnapshot } },
        });
      } catch (error) {
        this.#logger.warn?.(
          `[dsh-im:telegram] bot ${this.#config.botId} could not persist a queued voice message:`,
          error?.message ?? error,
        );
      }
    }
    let accepted = false;
    void this.#conversationQueue.run(message.conversationId, async () => {
      try {
        if (signal.aborted) return;
        if (needsPreparation) await this.#transcribeVoice(message, signal);
        if (signal.aborted) return;
        await captureGroupHistory(this.#groupHistory, message, groupHistoryEntry('telegram', update, message), {
          logger: this.#logger,
        });
        accepted = true;
        // The bridge owns turn ordering; awaiting it here would park the
        // conversation behind a turn that waits for the user.
        void this.#bridge.accept(message, { contextSnapshot }).catch((error) => {
          if (signal.aborted) return;
          this.#logger.error?.(
            `[dsh-im:telegram] bot ${this.#config.botId} message handling failed:`,
            extractConnectionEvidence(error).details,
          );
        });
      } finally {
        // A cancelled prepare keeps the record: the next start replays it.
        if (needsPreparation && accepted) {
          await this.#state.removePendingMessage(pendingId).catch(() => {});
        }
      }
    });
  }

  /**
   * Replay voice messages whose preparation was interrupted by a restart.
   *
   * The raw update travels with the pending record, so the message is rebuilt
   * exactly as the poller first saw it.
   */
  async #replayPendingVoice(signal) {
    let entries = [];
    try {
      entries = typeof this.#state.pendingMessages === 'function' ? this.#state.pendingMessages() : [];
    } catch {
      return;
    }
    for (const entry of entries) {
      const replayed = entry?.target?.voiceReplay;
      if (!replayed || !replayed.update) continue;
      if (signal.aborted) return;
      const message = normalizeTelegramUpdate(replayed.update, {
        botId: this.#config.platformId,
        username: this.#config.username,
        // Same rules the poller applied: a replayed group update must keep the
        // addressing decision that queued it.
        groupTriggers: this.#groupTriggers,
        loadFile: (fileId, options) => this.#api.downloadFile({ fileId, ...options }),
        loadFileStream: (fileId, options) => this.#api.downloadFileStream({ fileId, ...options }),
        loadReplyContent: (reference, options) => this.#loadReplyContent(reference, options),
      });
      if (!message) {
        await this.#state.removePendingMessage(entry.id).catch(() => {});
        continue;
      }
      this.#logger.warn?.(
        `[dsh-im:telegram] bot ${this.#config.botId} replaying an interrupted voice message`,
      );
      await this.#dispatchUpdate(replayed.update, message, replayed.contextSnapshot, signal);
    }
  }

  /**
   * Substitute a transcript — or an explicit "not transcribed" note — for an
   * empty voice message.
   *
   * The note is the model's input, not the user's answer: the channel never
   * phrases a reply on its own, and the note says plainly that no transcript
   * exists so nothing is invented from the audio.
   */
  async #transcribeVoice(message, signal) {
    if (!voiceMessageAllowed(this.#accessPolicy, message)) return;
    await fillVoiceContent({
      message,
      voice: message.voice,
      api: this.#api,
      transcriber: this.#voice,
      timeoutMs: this.#voiceTimeoutMs,
      signal,
      logFailure: (reason, error) => this.#logVoiceFailure(reason, error),
    });
  }

  /** Report one reason per runtime start; the model still gets a note every time. */
  #logVoiceFailure(reason, error) {
    if (this.#voiceFailures.has(reason)) return;
    this.#voiceFailures.add(reason);
    this.#logger.warn?.(
      `[dsh-im:telegram] bot ${this.#config.botId} voice transcription unavailable: ${reason}`,
      error?.message ?? '',
    );
  }

  async #loadReplyContent(reference, { signal } = {}) {
    const key = typeof reference?.conversationKey === 'string'
      ? reference.conversationKey.trim() : '';
    const quotedAt = Number(reference?.createdAt);
    if (!key || !Number.isFinite(quotedAt)) {
      return { unavailableReason: 'not-delivered' };
    }
    const sessionId = this.#state.sessionFor(key);
    const session = typeof sessionId === 'string' && sessionId
      ? this.#harness.workspaceSession?.(sessionId, key)
      : null;
    const text = await recoverAssistantTextByTimestamp({ session, quotedAt, signal });
    return text ? { content: text } : { unavailableReason: 'not-delivered' };
  }

  async #poll(initialCursor, signal) {
    let cursor = initialCursor;
    while (!signal.aborted) {
      const updates = await this.#api.getUpdates({ offset: cursor, timeout: 25, signal });
      this.#status.lastCheckedAt = Date.now();
      if (signal.aborted) return;
      // All updates have arrived together; cursor persistence must not move the
      // settings boundary for the later messages in this received batch.
      const received = updates.map((update) => {
        const chatType = update?.message?.chat?.type
          ?? update?.callback_query?.message?.chat?.type;
        return {
          update,
          contextSnapshot: captureContextEnhancement(this.#contextEnhancement,
            chatType === 'private' ? 'direct'
              : chatType === 'group' || chatType === 'supergroup' ? 'group' : null),
        };
      });
      for (const { update, contextSnapshot } of received) {
        if (signal.aborted) return;
        const callback = normalizeTelegramCallback(update, {
          botId: this.#config.platformId,
        });
        if (callback) {
          if (typeof this.#bridge.acceptCallback === 'function') {
            void this.#bridge.acceptCallback(callback, { contextSnapshot }).catch((error) => {
              if (signal.aborted) return;
              this.#logger.error?.(
                `[dsh-im:telegram] bot ${this.#config.botId} callback handling failed:`,
                extractConnectionEvidence(error).details,
              );
            });
          }
          cursor = update.update_id + 1;
          await this.#state.setCursor(cursor);
          continue;
        }
        const message = normalizeTelegramUpdate(update, {
          botId: this.#config.platformId,
          username: this.#config.username,
          groupTriggers: this.#groupTriggers,
          loadFile: (fileId, options) => this.#api.downloadFile({ fileId, ...options }),
          loadFileStream: (fileId, options) => this.#api.downloadFileStream({ fileId, ...options }),
          loadReplyContent: (reference, options) => this.#loadReplyContent(reference, options),
        });
        if (message) {
          // The queued record is written before the caller persists the cursor,
          // so a restart replays preparation instead of losing the update.
          await this.#dispatchUpdate(update, message, contextSnapshot, signal);
        }
        cursor = update.update_id + 1;
        await this.#state.setCursor(cursor);
      }
    }
  }

  async stop() {
    const pollTask = this.#pollTask;
    const queued = this.#conversationQueue.idle();
    const bridge = this.#bridge;
    const httpTransport = this.#httpTransport;
    this.#abortController?.abort();
    this.#abortController = null;
    this.#pollTask = null;
    this.#httpTransport = null;
    this.#api = null;
    this.#bridge = null;
    await Promise.race([
      pollTask?.catch(() => undefined) ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    // Queued per-conversation work settles on its own deadline, never shutdown.
    await Promise.race([
      queued,
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await Promise.race([
      bridge?.waitForIdle() ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    try {
      await httpTransport?.destroy();
    } catch {
      this.#logger.warn?.('[dsh-im:telegram] Telegram HTTP transport cleanup failed');
    }
    this.#status.ready = false;
    this.#status.connectionState = 'idle';
    return this.status;
  }
}
