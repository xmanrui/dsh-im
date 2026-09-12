import { fetchFileStream } from '../shared/file-download.mjs';
import { fetchImageBuffer } from '../shared/image-prompt.mjs';
import { t } from '../shared/i18n.mjs';

const DEFAULT_BASE_URL = 'https://api.telegram.org/';
const TELEGRAM_FILE_HOSTS = Object.freeze(['api.telegram.org']);
const DEFAULT_FILE_UPLOAD_TIMEOUT_MS = 120_000;

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function positiveTimeout(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function preserveProviderMetadata(target, source) {
  if (source?.providerCode !== undefined) target.providerCode = source.providerCode;
  if (source?.retry_after !== undefined) {
    target.retry_after = source.retry_after;
    target.retryAfter = source.retry_after;
  }
  if (Number.isInteger(source?.status)) target.status = source.status;
  return target;
}

function inputRichMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('A Telegram rich message is required');
  }
  const formats = ['markdown', 'html', 'blocks'].filter((key) => value[key] !== undefined);
  if (formats.length !== 1) {
    throw new TypeError('A Telegram rich message requires exactly one format');
  }
  const selected = formats[0];
  if ((selected === 'markdown' || selected === 'html')
    && (typeof value[selected] !== 'string' || !value[selected].trim())) {
    throw new TypeError('Telegram rich message text is invalid');
  }
  if (selected === 'blocks' && !Array.isArray(value.blocks)) {
    throw new TypeError('Telegram rich message blocks are invalid');
  }
  return value;
}

/** Telegram rejects callback_data longer than 64 bytes. */
const CALLBACK_DATA_MAX_BYTES = 64;

/** Validate an inline keyboard so no oversized or malformed payload is dispatched.
 * An empty `inline_keyboard` is accepted: that is how Telegram removes a keyboard.
 */
function inputReplyMarkup(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('A Telegram reply markup is required');
  }
  const rows = value.inline_keyboard;
  if (!Array.isArray(rows)) {
    throw new TypeError('Telegram reply markup requires inline_keyboard rows');
  }
  return {
    inline_keyboard: rows.map((row) => {
      if (!Array.isArray(row) || row.length === 0) {
        throw new TypeError('Telegram inline keyboard rows must be non-empty arrays');
      }
      return row.map((button) => {
        const text = cleanString(button?.text);
        const data = cleanString(button?.callback_data);
        if (!text || !data) {
          throw new TypeError('Telegram inline keyboard buttons require text and callback_data');
        }
        if (Buffer.byteLength(data, 'utf8') > CALLBACK_DATA_MAX_BYTES) {
          throw new TypeError(
            `Telegram callback_data must be at most ${CALLBACK_DATA_MAX_BYTES} bytes`,
          );
        }
        return { text, callback_data: data };
      });
    }),
  };
}

function telegramArtifactProviderError(cause, mediaLabel = 'document') {
  const providerCode = Number(cause?.providerCode);
  const status = Number(cause?.status);
  const message = cleanString(cause?.message) ?? '';
  let code = 'artifact-provider-rejected';
  let summary = `Telegram rejected the ${mediaLabel}.`;
  if (providerCode === 401 || providerCode === 403 || status === 401 || status === 403) {
    code = 'artifact-permission-required';
    summary = `Telegram denied permission to send the ${mediaLabel}.`;
  } else if (providerCode === 413 || status === 413
    || /(?:file|request|entity).{0,20}(?:too (?:big|large)|size limit)|too (?:big|large)/i.test(message)) {
    code = 'artifact-too-large';
    summary = `The ${mediaLabel} exceeds Telegram's size limit.`;
  } else if (providerCode === 429 || status === 429) {
    code = 'artifact-rate-limited';
    summary = `Telegram rate-limited ${mediaLabel} delivery.`;
  } else if (providerCode >= 500 || status >= 500) {
    code = 'artifact-delivery-uncertain';
    summary = `Telegram ${mediaLabel} delivery result is uncertain.`;
  }
  const error = new Error(summary, { cause });
  error.code = code;
  return preserveProviderMetadata(error, cause);
}

function uncertainTelegramDelivery(cause, mediaLabel = 'document') {
  const error = new Error(`Telegram ${mediaLabel} delivery result is uncertain`, { cause });
  error.code = 'artifact-delivery-uncertain';
  return preserveProviderMetadata(error, cause);
}

export function validTelegramToken(value) {
  return typeof value === 'string' && /^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(value.trim());
}

const TELEGRAM_COMMAND_NAME = /^[a-z0-9_]{1,32}$/;

function validBotCommand(value) {
  return Boolean(value)
    && typeof value === 'object' && !Array.isArray(value)
    && typeof value.command === 'string' && TELEGRAM_COMMAND_NAME.test(value.command)
    && typeof value.description === 'string' && value.description.trim().length >= 1
    && [...value.description].length <= 256;
}

export function validateTelegramCommands(commands, { allowEmpty = false } = {}) {
  if (!Array.isArray(commands) || (!allowEmpty && commands.length === 0)
    || commands.length > 100 || commands.some((command) => !validBotCommand(command))
    || new Set(commands.map((item) => item.command)).size !== commands.length) {
    throw new TypeError('Telegram bot commands are invalid');
  }
}

export const COMMANDS_MENU_BUTTON = Object.freeze({ type: 'commands' });

export class TelegramApi {
  #token;
  #fetch;
  #FormDataImpl;
  #baseUrl;
  #fileUploadTimeoutMs;

  constructor({
    token,
    fetchImpl = fetch,
    FormDataImpl = globalThis.FormData,
    baseUrl = DEFAULT_BASE_URL,
    fileUploadTimeoutMs = DEFAULT_FILE_UPLOAD_TIMEOUT_MS,
  }) {
    if (!validTelegramToken(token)) throw new TypeError('Telegram Bot Token is invalid');
    if (typeof fetchImpl !== 'function') throw new TypeError('TelegramApi requires fetch');
    if (typeof FormDataImpl !== 'function') throw new TypeError('TelegramApi requires FormData');
    this.#token = token.trim();
    this.#fetch = fetchImpl;
    this.#FormDataImpl = FormDataImpl;
    this.#baseUrl = new URL(baseUrl);
    this.#fileUploadTimeoutMs = positiveTimeout(fileUploadTimeoutMs, 'fileUploadTimeoutMs');
  }

  async getMe(options = {}) {
    return this.#call('getMe', {}, options);
  }

  async getWebhookInfo(options = {}) {
    return this.#call('getWebhookInfo', {}, options);
  }

  async getUpdates({ offset, timeout = 25, signal } = {}) {
    const payload = {
      timeout,
      limit: 100,
      allowed_updates: ['message', 'callback_query'],
      ...(Number.isSafeInteger(offset) ? { offset } : {}),
    };
    return this.#call('getUpdates', payload, {
      signal,
      timeoutMs: Math.max(10_000, (timeout + 10) * 1_000),
    });
  }

  async getFile({ fileId, signal } = {}) {
    const id = cleanString(fileId);
    if (!id || !/^[A-Za-z0-9_-]{1,512}$/.test(id)) {
      throw new TypeError('Telegram file id is invalid');
    }
    return this.#call('getFile', { file_id: id }, { signal });
  }

  async downloadFile({ fileId, signal, maxBytes } = {}) {
    const url = await this.#downloadUrl(fileId, signal);
    return fetchImageBuffer(url, {
      fetchImpl: this.#fetch,
      signal,
      maxBytes,
      allowedHosts: TELEGRAM_FILE_HOSTS,
    });
  }

  async downloadFileStream({ fileId, signal } = {}) {
    const url = await this.#downloadUrl(fileId, signal);
    return fetchFileStream(url, {
      fetchImpl: this.#fetch,
      signal,
      allowedHosts: TELEGRAM_FILE_HOSTS,
    });
  }

  async #downloadUrl(fileId, signal) {
    const file = await this.getFile({ fileId, signal });
    const filePath = cleanString(file?.file_path);
    if (!filePath || filePath.startsWith('/') || filePath.includes('\\')
      || filePath.includes('?') || filePath.includes('#')) {
      throw new Error('Telegram returned an invalid file path');
    }
    let decodedSegments;
    try {
      decodedSegments = filePath.split('/').map((segment) => decodeURIComponent(segment));
    } catch {
      throw new Error('Telegram returned an invalid file path');
    }
    if (decodedSegments.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error('Telegram returned an invalid file path');
    }
    const url = new URL(this.#baseUrl);
    url.pathname = `/file/bot${this.#token}/${filePath}`;
    return url;
  }

  async sendMessage({ chatId, text, replyToMessageId, messageThreadId, replyMarkup, signal }) {
    return this.#call('sendMessage', {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...(replyToMessageId ? {
        reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true },
      } : {}),
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      ...(replyMarkup === undefined ? {} : { reply_markup: inputReplyMarkup(replyMarkup) }),
    }, { signal });
  }

  /** Acknowledge a button press so the client stops showing its progress spinner. */
  async answerCallbackQuery({ callbackQueryId, text, signal }) {
    const queryId = cleanString(callbackQueryId);
    if (!queryId) throw new TypeError('Telegram callback query id is required');
    const notice = cleanString(text);
    return this.#call('answerCallbackQuery', {
      callback_query_id: queryId,
      ...(notice ? { text: notice } : {}),
    }, { signal });
  }

  /** Replace only the keyboard of an existing message, keeping its text intact. */
  async editMessageReplyMarkup({ chatId, messageId, replyMarkup, signal }) {
    if (!Number.isSafeInteger(messageId)) {
      throw new TypeError('Telegram message id must be a safe integer');
    }
    return this.#call('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      ...(replyMarkup === undefined ? {} : { reply_markup: inputReplyMarkup(replyMarkup) }),
    }, { signal });
  }

  async setMessageReaction({ chatId, messageId, emoji, signal, timeoutMs }) {
    const normalizedEmoji = cleanString(emoji);
    return this.#call('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: normalizedEmoji ? [{ type: 'emoji', emoji: normalizedEmoji }] : [],
    }, { signal, timeoutMs });
  }

  async sendRichMessage({
    chatId,
    richMessage,
    replyToMessageId,
    messageThreadId,
    signal,
  }) {
    return this.#call('sendRichMessage', {
      chat_id: chatId,
      rich_message: inputRichMessage(richMessage),
      ...(replyToMessageId ? {
        reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true },
      } : {}),
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    }, { signal });
  }

  async sendRichMessageDraft({ chatId, draftId, richMessage, messageThreadId, signal }) {
    if (!Number.isSafeInteger(draftId) || draftId === 0) {
      throw new TypeError('Telegram rich message draft id must be a non-zero integer');
    }
    return this.#call('sendRichMessageDraft', {
      chat_id: chatId,
      draft_id: draftId,
      rich_message: inputRichMessage(richMessage),
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    }, { signal });
  }

  async sendDocument({ chatId, file, replyToMessageId, messageThreadId, signal }) {
    return this.#sendArtifact('sendDocument', 'document', 'document', {
      chatId,
      file,
      replyToMessageId,
      messageThreadId,
      signal,
    });
  }

  async sendPhoto({ chatId, file, replyToMessageId, messageThreadId, signal }) {
    return this.#sendArtifact('sendPhoto', 'photo', 'photo', {
      chatId,
      file,
      replyToMessageId,
      messageThreadId,
      signal,
    });
  }

  async #sendArtifact(method, fieldName, mediaLabel, {
    chatId,
    file,
    replyToMessageId,
    messageThreadId,
    signal,
  }) {
    if (!file || typeof file !== 'object'
      || typeof file.fileName !== 'string' || !file.fileName
      || !Buffer.isBuffer(file.bytes)) {
      throw new TypeError(`A Telegram ${mediaLabel} is required`);
    }
    const payload = new this.#FormDataImpl();
    payload.append('chat_id', String(chatId));
    payload.append(
      fieldName,
      new Blob([file.bytes], { type: file.mediaType ?? 'application/octet-stream' }),
      file.fileName,
    );
    if (replyToMessageId) {
      payload.append('reply_parameters', JSON.stringify({
        message_id: replyToMessageId,
        allow_sending_without_reply: true,
      }));
    }
    if (messageThreadId) payload.append('message_thread_id', String(messageThreadId));
    if (signal?.aborted) throw abortReason(signal);
    const uploadSignal = requestSignal(signal, this.#fileUploadTimeoutMs);
    try {
      return await this.#call(method, payload, {
        signal: uploadSignal,
        timeoutMs: this.#fileUploadTimeoutMs,
        multipart: true,
      });
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (error?.deliveryOutcome === 'unknown') {
        throw uncertainTelegramDelivery(error?.cause ?? error, mediaLabel);
      }
      if (error?.code?.startsWith?.('telegram-')) {
        throw telegramArtifactProviderError(error, mediaLabel);
      }
      throw uncertainTelegramDelivery(error, mediaLabel);
    }
  }

  async editMessageText({ chatId, messageId, text, richMessage, signal }) {
    if ((text === undefined) === (richMessage === undefined)) {
      throw new TypeError('Telegram message edit requires exactly one of text or richMessage');
    }
    return this.#call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      ...(text === undefined ? { rich_message: inputRichMessage(richMessage) } : {
        text,
        link_preview_options: { is_disabled: true },
      }),
    }, { signal });
  }

  async sendChatAction({ chatId, messageThreadId, signal }) {
    return this.#call('sendChatAction', {
      chat_id: chatId,
      action: 'typing',
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    }, { signal });
  }

  async setMyCommands({ commands, scope, languageCode, signal } = {}) {
    validateTelegramCommands(commands);
    return this.#call('setMyCommands', {
      commands,
      ...(scope ? { scope } : {}),
      ...(cleanString(languageCode) ? { language_code: cleanString(languageCode) } : {}),
    }, { signal });
  }

  async deleteMyCommands({ scope, languageCode, signal } = {}) {
    return this.#call('deleteMyCommands', {
      ...(scope ? { scope } : {}),
      ...(cleanString(languageCode) ? { language_code: cleanString(languageCode) } : {}),
    }, { signal });
  }

  async setChatMenuButton({ menuButton = COMMANDS_MENU_BUTTON, signal } = {}) {
    if (!menuButton || typeof menuButton !== 'object' || Array.isArray(menuButton)) {
      throw new TypeError('Telegram menu button is invalid');
    }
    return this.#call('setChatMenuButton', { menu_button: menuButton }, { signal });
  }

  async #call(method, payload, { signal, timeoutMs = 15_000, multipart = false } = {}) {
    if (signal?.aborted) throw abortReason(signal);
    const url = new URL(this.#baseUrl);
    url.pathname = `${url.pathname.replace(/\/$/, '')}/bot${this.#token}/${method}`;
    let response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        ...(multipart ? {} : { headers: { 'content-type': 'application/json' } }),
        body: multipart ? payload : JSON.stringify(payload),
        signal: requestSignal(signal, timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      const transport = new Error(`Telegram ${method} transport failed`, { cause: error });
      transport.code = error?.name === 'TimeoutError'
        ? 'telegram-timeout'
        : error?.name === 'AbortError'
          ? 'telegram-aborted-after-dispatch'
          : 'telegram-transport-error';
      transport.deliveryOutcome = 'unknown';
      throw transport;
    }
    let body;
    try {
      body = await response.json();
    } catch {
      const error = new Error(`Telegram ${method} returned invalid JSON`);
      error.status = response?.status;
      error.code = 'telegram-response-invalid';
      error.deliveryOutcome = 'unknown';
      throw error;
    }
    if (!response.ok || body?.ok !== true) {
      const description = cleanString(body?.description);
      const error = new Error(description ?? `Telegram ${method} failed`);
      error.code = Number.isInteger(body?.error_code) ? `telegram-${body.error_code}` : 'telegram-api-error';
      error.status = response.status;
      if (Number.isInteger(body?.error_code)) error.providerCode = body.error_code;
      const retryAfter = Number(body?.parameters?.retry_after);
      if (Number.isFinite(retryAfter) && retryAfter >= 0) {
        error.retry_after = retryAfter;
        error.retryAfter = retryAfter;
      }
      throw error;
    }
    return body.result;
  }
}

export async function inspectTelegramToken(token, options = {}) {
  const api = new TelegramApi({ token, ...options });
  const bot = await api.getMe();
  if (!bot?.id || bot?.is_bot !== true) throw new Error('Telegram token does not belong to a bot');
  return {
    platformId: String(bot.id),
    name: cleanString([bot.first_name, bot.last_name].filter(Boolean).join(' ')) ?? t('Telegram机器人'),
    username: cleanString(bot.username),
  };
}
