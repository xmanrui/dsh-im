import { randomInt } from 'node:crypto';

import { createEditableMessageStream, splitMessageText } from '../shared/editable-message-stream.mjs';
import { createTextDeliveryBlock } from '../shared/semantic/delivery.mjs';
import { t } from '../shared/i18n.mjs';
import { captureContextEnhancement } from '../shared/context-enhancement.mjs';
import { recoverAssistantTextByTimestamp } from '../shared/session-reply-recovery.mjs';
import { COMMANDS_MENU_BUTTON, TelegramApi } from './telegram-api.mjs';
import { createTelegramHttpTransport } from './telegram-http.mjs';
import { createTelegramBridgeStatus, TelegramHarnessBridge } from './telegram-bridge.mjs';
import {
  splitTelegramRegularText,
  splitTelegramRichMarkdown,
  toTelegramRichMarkdown,
} from './telegram-rich-message.mjs';
import {
  TELEGRAM_ACCESS_MODES,
} from './config-store.mjs';

export const TELEGRAM_COMMAND_MENU = Object.freeze([
  { command: 'new', description: '开启一个全新会话' },
  { command: 'compact', description: '压缩当前会话的较早上下文' },
  { command: 'workspace', description: '切换工作区' },
  { command: 'workspacelist', description: '列出工作区绝对路径' },
  { command: 'sessionlist', description: '列出会话 ID 和标题' },
  { command: 'sessions', description: '列出会话 ID 和标题' },
  { command: 'session', description: '将当前聊天绑定到指定会话' },
  { command: 'models', description: '按序号列出所有可用模型' },
  { command: 'model', description: '查看或切换当前会话模型' },
  { command: 'presetlist', description: '列出可用 Agent Preset' },
  { command: 'presets', description: '列出可用 Agent Preset' },
  { command: 'preset', description: '查看或设置新会话 Agent Preset' },
  { command: 'stop', description: '停止当前任务' },
  { command: 'steer', description: '纠偏当前任务' },
  { command: 'batch', description: '开始批量输入（仅私聊）' },
  { command: 'send', description: '提交当前批次' },
  { command: 'cancel', description: '取消当前批次' },
  { command: 'status', description: '检查连接状态' },
  { command: 'version', description: '查看插件版本' },
  { command: 'help', description: '显示帮助' },
]);

export function telegramCommandMenu() {
  return TELEGRAM_COMMAND_MENU.map((item) => ({
    ...item,
    description: t(item.description),
  }));
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

function withoutBotMention(text, username) {
  if (!username || typeof text !== 'string') return text;
  return text.replace(new RegExp(`@${escaped(username)}\\b`, 'ig'), '').trim();
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

function telegramReplyAttachment(kind, file, fallbackName) {
  if (!file || typeof file !== 'object') return null;
  const name = typeof file.file_name === 'string' && file.file_name
    ? file.file_name : typeof fallbackName === 'string' && fallbackName
      ? fallbackName : undefined;
  return { kind, ...(name ? { name } : {}) };
}

function telegramReplyAttachments(message) {
  const attachments = [];
  if (Array.isArray(message?.photo) && message.photo.length > 0) {
    const largest = message.photo.reduce((best, candidate) => (
      photoScore(candidate) > photoScore(best) ? candidate : best
    ));
    attachments.push(telegramReplyAttachment(
      'image',
      largest,
      `${largest.file_unique_id ?? largest.file_id ?? 'telegram-photo'}.jpg`,
    ));
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
      message.sticker.file_unique_id ?? message.sticker.file_id,
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

export function normalizeTelegramUpdate(update, {
  botId,
  username,
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
  const addressed = direct
    || String(message.reply_to_message?.from?.id ?? '') === String(botId)
    || mentionedUsername(message, username);
  const messageThreadId = Number.isSafeInteger(message.message_thread_id)
    ? message.message_thread_id : undefined;
  const image = telegramImageSource(message, loadFile);
  const file = telegramFileSource(message, loadFileStream);
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

  constructor({ update, finish, fail, providerMessageIds = [], presentation, logger }) {
    this.#update = update;
    this.#finish = finish;
    this.#fail = fail;
    this.#providerMessageIds = providerMessageIds;
    this.presentation = presentation;
    this.#logger = logger;
  }

  get providerMessageIds() {
    return [...this.#providerMessageIds];
  }

  async update(value) {
    if (this.#closed) return undefined;
    const block = createTextDeliveryBlock(value);
    const key = `${block.format}:${block.text}`;
    if (key === this.#lastUpdate) return undefined;
    this.#lastUpdate = key;
    try {
      return await this.#update(block);
    } catch (error) {
      this.#logger.warn?.('[dsh-im:telegram] rich stream update failed:', error);
      return undefined;
    }
  }

  async finish(value) {
    if (this.#closed) throw new Error('Message stream is already closed');
    this.#closed = true;
    const result = await this.#finish(createTextDeliveryBlock(value));
    this.#providerMessageIds.push(...(result?.providerMessageIds ?? []));
    return result;
  }

  async fail(text) {
    if (this.#closed) return undefined;
    this.#closed = true;
    const result = await this.#fail(createTextDeliveryBlock(text, 'plain'));
    this.#providerMessageIds.push(...(result?.providerMessageIds ?? []));
    return result;
  }

  cancel() {
    this.#closed = true;
  }
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

  async #sendPlain(target, text, { placeholderMessageId } = {}) {
    const chunks = splitTelegramRegularText(text);
    const providerMessageIds = placeholderMessageId === undefined
      ? []
      : [String(placeholderMessageId)];
    let firstUnsent = 0;
    if (placeholderMessageId !== undefined) {
      try {
        await this.#api.editMessageText({
          chatId: target.chatId,
          messageId: placeholderMessageId,
          text: chunks[0],
          signal: this.#signal,
        });
        firstUnsent = 1;
      } catch (error) {
        const failure = telegramFailure(error);
        if (failure.outcome === 'unknown') {
          return deliveryResult('text-fallback', providerMessageIds, 'unknown', failure.reason);
        }

        const fallback = await this.#sendPlain(target, text);
        const terminalText = fallback.deliveryOutcome === 'sent'
          ? '回复已发送。'
          : fallback.deliveryOutcome === 'unknown'
            ? '回复发送结果未能确认。'
            : '消息发送失败，请稍后重试。';
        try {
          await this.#api.editMessageText({
            chatId: target.chatId,
            messageId: placeholderMessageId,
            text: terminalText,
            signal: this.#signal,
          });
        } catch (terminalError) {
          this.#logger.warn?.(
            '[dsh-im:telegram] unable to replace the processing placeholder:',
            terminalError,
          );
        }
        return deliveryResult(
          'text-fallback',
          [...providerMessageIds, ...fallback.providerMessageIds],
          fallback.deliveryOutcome,
          fallback.reason,
        );
      }
    }

    for (let index = firstUnsent; index < chunks.length; index += 1) {
      try {
        const result = await this.#api.sendMessage({
          chatId: target.chatId,
          text: chunks[index],
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

  async #sendRich(target, block) {
    if (block.format === 'plain') return this.#sendPlain(target, block.text);

    let chunks;
    try {
      chunks = splitTelegramRichMarkdown(block.text);
    } catch {
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

  async #editRich(target, messageId, block) {
    if (block.format === 'plain') {
      return this.#sendPlain(target, block.text, {
        placeholderMessageId: messageId,
      });
    }

    let chunks;
    try {
      chunks = splitTelegramRichMarkdown(block.text);
    } catch {
      return this.#sendPlain(target, block.text, { placeholderMessageId: messageId });
    }
    const providerMessageIds = [String(messageId)];
    try {
      await this.#api.editMessageText({
        chatId: target.chatId,
        messageId,
        richMessage: { markdown: chunks[0].markdown },
        signal: this.#signal,
      });
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
      return this.#sendPlain(target, block.text, { placeholderMessageId: messageId });
    }

    for (const [offset, chunk] of chunks.slice(1).entries()) {
      try {
        const result = await this.#api.sendRichMessage({
          chatId: target.chatId,
          richMessage: { markdown: chunk.markdown },
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
        const remaining = chunks.slice(offset + 1).map((part) => part.source).join('');
        const fallback = await this.#sendPlain({
          ...target,
          replyToMessageId: undefined,
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
    if (target.chatType === 'private') {
      const draftId = randomInt(1, 2_147_483_647);
      const updateDraft = async (block) => {
        const richMessage = { markdown: toTelegramRichMarkdown(block.text) };
        await this.#api.sendRichMessageDraft({
          chatId: target.chatId,
          draftId,
          richMessage,
          messageThreadId: target.messageThreadId,
          signal: this.#signal,
        });
        return deliveryResult('telegram-rich-draft', []);
      };
      const stream = new TelegramDeliveryStream({
        update: updateDraft,
        finish: (block) => this.#sendRich(target, block),
        fail: (block) => this.#sendPlain(target, block.text),
        presentation: 'telegram-rich-draft',
        logger: this.#logger,
      });
      await stream.update(createTextDeliveryBlock('正在处理…', 'plain'));
      return stream;
    }

    const placeholder = await this.#api.sendMessage({
      chatId: target.chatId,
      text: '正在处理…',
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
      finish: (block) => this.#editRich(target, messageId, block),
      fail: (block) => this.#sendPlain(target, block.text, {
        placeholderMessageId: messageId,
      }),
      providerMessageIds: [String(messageId)],
      presentation: 'telegram-regular',
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
  #accessPolicy;
  #logger;
  #replyTimeoutMs;
  #createApi;
  #createHttpTransport;
  #status = createTelegramRuntimeStatus();
  #httpTransport = null;
  #api = null;
  #bridge = null;
  #abortController = null;
  #pollTask = null;
  #starting = null;

  constructor({
    config,
    token,
    harness,
    state,
    contextEnhancement,
    accessPolicy,
    logger = console,
    replyTimeoutMs = 600_000,
    createApi = (options) => new TelegramApi(options),
    createHttpTransport = createTelegramHttpTransport,
  }) {
    if (!config || !token || !harness || !state) {
      throw new TypeError('TelegramRuntime requires config, token, Harness, and state');
    }
    this.#config = config;
    this.#token = token;
    this.#harness = harness;
    this.#state = state;
    this.#contextEnhancement = contextEnhancement;
    this.#accessPolicy = accessPolicy;
    this.#logger = logger;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#createApi = createApi;
    this.#createHttpTransport = createHttpTransport;
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
    this.#status.startedAt = new Date().toISOString();
    this.#status.connectionState = 'connecting';
    this.#status.lastError = null;
    await this.#harness.ensureRunning();
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
        await api.setMyCommands({ commands: telegramCommandMenu(), signal: controller.signal });
        await api.setChatMenuButton({ menuButton: COMMANDS_MENU_BUTTON, signal: controller.signal });
      } catch (error) {
        this.#logger.warn?.(
          `[dsh-im:telegram] bot ${this.#config.botId} command menu setup failed:`,
          error,
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
      this.#pollTask = this.#poll(cursor, controller.signal);
      this.#pollTask.catch((error) => {
        if (controller.signal.aborted) return;
        this.#status.ready = false;
        this.#status.connectionState = 'failed';
        this.#status.lastError = error?.message ?? String(error);
        this.#logger.error?.(`[dsh-im:telegram] bot ${this.#config.botId} polling stopped:`, error);
      });
      return this.status;
    } catch (error) {
      this.#status.ready = false;
      this.#status.connectionState = 'failed';
      this.#status.lastError = error?.message ?? String(error);
      await this.stop();
      throw error;
    }
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
      ? this.#harness.workspaceSession?.(sessionId)
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
        const chatType = update?.message?.chat?.type;
        return {
          update,
          contextSnapshot: captureContextEnhancement(this.#contextEnhancement,
            chatType === 'private' ? 'direct'
              : chatType === 'group' || chatType === 'supergroup' ? 'group' : null),
        };
      });
      for (const { update, contextSnapshot } of received) {
        if (signal.aborted) return;
        const message = normalizeTelegramUpdate(update, {
          botId: this.#config.platformId,
          username: this.#config.username,
          loadFile: (fileId, options) => this.#api.downloadFile({ fileId, ...options }),
          loadFileStream: (fileId, options) => this.#api.downloadFileStream({ fileId, ...options }),
          loadReplyContent: (reference, options) => this.#loadReplyContent(reference, options),
        });
        if (message) {
          void this.#bridge.accept(message, { contextSnapshot }).catch((error) => {
            if (signal.aborted) return;
            this.#logger.error?.(
              `[dsh-im:telegram] bot ${this.#config.botId} message handling failed:`,
              error,
            );
          });
        }
        cursor = update.update_id + 1;
        await this.#state.setCursor(cursor);
      }
    }
  }

  async stop() {
    const pollTask = this.#pollTask;
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
