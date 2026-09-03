import { generateReqId } from '@wecom/aibot-node-sdk';
import {
  harnessAnswerForQuestion,
  harnessQuestionText,
  validHarnessQuestion,
} from '../shared/harness-question.mjs';
import { HarnessApprovalQueue } from '../shared/harness-approval.mjs';
import {
  BatchInputManager,
  batchInputBusyMessage,
  batchInputGroupUnsupportedMessage,
  isBatchInputCommand,
} from '../shared/batch-input.mjs';
import { runCompactCommand } from '../shared/compact-command.mjs';
import { isHistoryCommand, runHistoryCommand } from '../shared/history-command.mjs';
import {
  isControlCommand,
  runControlCommand,
} from '../shared/control-command.mjs';
import {
  isModelCommand,
  runModelCommand,
} from '../shared/model-command.mjs';
import {
  isPresetCommand,
  runPresetCommand,
} from '../shared/preset-command.mjs';
import { runWorkspaceCommand } from '../shared/workspace-command.mjs';
import { askInWorkspaceSession } from '../shared/workspace-session.mjs';
import { captureContextEnhancement, enhanceContextContent } from '../shared/context-enhancement.mjs';
import {
  hasInboundImages,
  ImagePromptError,
  imagePromptDiagnostic,
  imagePromptUserMessage,
} from '../shared/image-prompt.mjs';
import {
  hasInboundFiles,
  inboundFileUserMessage,
} from '../shared/inbound-file.mjs';
import { rememberConnectionTestTarget } from '../shared/connection-test.mjs';
import { trackOutboundArtifactProviderPromise } from '../shared/semantic/artifact.mjs';
import { deliverOutboundArtifacts } from '../shared/semantic/artifact-delivery.mjs';
import {
  hasReplyReference,
  promptContentForInboundMessage,
} from '../shared/semantic/reply-reference.mjs';
import {
  createDeliveryReceipt,
} from '../shared/semantic/delivery.mjs';
import {
  channelDeliveryFailure,
  clearLastMessageFailure,
  messageFailureText,
  setLastMessageFailure,
} from '../shared/message-failure.mjs';
import {
  COMMAND_PERMISSION_DENIED_MESSAGE,
  evaluateInboundAccess,
} from '../shared/inbound-access.mjs';
import { t } from '../shared/i18n.mjs';

const DEFAULT_FILE_UPLOAD_TIMEOUT_MS = 120_000;

// Built lazily: t() must run after setImHostLanguage, not at import time.
function helpText() {
  return [
    t('企业微信机器人已连接 DeepSeek Harness。'),
    '',
    t('直接发送文字、图片或文件即可继续当前会话。'),
    t('/new  开启一个全新会话'),
    t('/compact  压缩当前会话的较早上下文'),
    t('/history [数量]  查看最近历史消息（默认 3 条，最多 5 条）'),
    t('/workspace 工作区序号或绝对路径  切换工作区'),
    t('/workspacelist  列出工作区绝对路径'),
    t('/ws、/wsl、/workspaces  工作区命令别名'),
    t('/sessionlist 或 /sessions [工作区序号或绝对路径]  列出会话 ID 和标题'),
    t('/sessionlist --limit N  仅列出当前工作区前 N 个会话'),
    t('/session Session ID 或当前工作区序号  将当前聊天绑定到指定会话'),
    t('/models  按序号列出所有可用模型'),
    t('/reasoninglist 或 /reasonings  按序号列出当前模型可用推理等级'),
    t('/reasoning [序号、等级ID或 --default]  查看或切换当前推理等级'),
    t('/model [序号或完整模型ID] [推理等级ID]  查看或切换当前会话模型'),
    t('示例：先发 /models，再发 /model 2 [推理等级ID]'),
    t('/presetlist 或 /presets  按序号列出可用 Agent Preset'),
    t('/preset [序号或完整ID]  查看或设置当前机器人 Agent Preset'),
    t('纯数字 ID：/preset id:<ID>'),
    t('/preset --default  跟随 Host 默认'),
    t('/stop  停止当前任务'),
    t('/steer 补充指令  纠偏当前任务'),
    t('/batch  开始批量输入（仅私聊，最多 10 条文字）'),
    t('/send  提交当前批次'),
    t('/cancel  取消当前批次'),
    t('/status  检查连接状态'),
    t('/version  查看插件版本'),
    t('/help  显示本帮助'),
  ].join('\n');
}
const MAX_REPLY_BYTES = 18_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PREFETCHED_IMAGES = 4;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function bodyOf(frame) {
  return frame?.body && typeof frame.body === 'object' ? frame.body : {};
}

function conversationKey(frame) {
  const body = bodyOf(frame);
  return body.chattype === 'group' ? `group:${body.chatid}` : `direct:${body.from?.userid}`;
}

function messageContentText(body) {
  let text = '';
  if (body.msgtype === 'text') {
    text = typeof body.text?.content === 'string' ? body.text.content.trim() : '';
  } else if (body.msgtype === 'voice') {
    text = typeof body.voice?.content === 'string' ? body.voice.content.trim() : '';
  } else if (body.msgtype === 'mixed' && Array.isArray(body.mixed?.msg_item)) {
    text = body.mixed.msg_item
      .filter((item) => item?.msgtype === 'text' && typeof item.text?.content === 'string')
      .map((item) => item.text.content)
      .join('\n')
      .trim();
  }
  return text;
}

function messageText(frame) {
  const body = bodyOf(frame);
  const text = messageContentText(body);
  // Group callbacks retain the leading @bot mention that caused delivery.
  // It is routing metadata rather than part of the user's prompt or answer.
  return body.chattype === 'group'
    ? text.replace(/^\s*@\S+(?:\s+|$)/u, '').trim()
    : text;
}

function imageContents(frame) {
  const body = bodyOf(frame);
  if (body.msgtype === 'image') return [body.image];
  if (body.msgtype !== 'mixed' || !Array.isArray(body.mixed?.msg_item)) return [];
  return body.mixed.msg_item
    .filter((item) => item?.msgtype === 'image')
    .map((item) => item.image);
}

function fileContents(frame) {
  const body = bodyOf(frame);
  return body.msgtype === 'file' && body.file && typeof body.file === 'object'
    ? [body.file]
    : [];
}

function quoteAttachments(quote) {
  if (quote?.msgtype === 'image') return [{ kind: 'image' }];
  if (quote?.msgtype === 'voice') return [{ kind: 'audio' }];
  if (quote?.msgtype === 'file') {
    const name = nonEmptyString(
      quote.file?.filename ?? quote.file?.file_name ?? quote.file?.name,
    );
    return [{ kind: 'file', ...(name ? { name } : {}) }];
  }
  if (quote?.msgtype !== 'mixed' || !Array.isArray(quote.mixed?.msg_item)) return [];
  return quote.mixed.msg_item
    .filter((item) => item?.msgtype === 'image')
    .map(() => ({ kind: 'image' }));
}

function replyReferenceForBody(body) {
  const quote = body?.quote;
  if (!quote || typeof quote !== 'object') return null;
  const content = messageContentText(quote);
  const attachments = quoteAttachments(quote);
  const supported = ['text', 'image', 'mixed', 'voice', 'file'].includes(quote.msgtype);
  return {
    ...(content ? { content } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(!content && attachments.length === 0
      ? { unavailableReason: supported ? 'not-delivered' : 'unsupported' }
      : {}),
  };
}

function imageSource(client, image) {
  const url = nonEmptyString(image?.url);
  if (!url) return null;
  const aeskey = nonEmptyString(image?.aeskey) ?? undefined;
  return {
    async load({ signal, maxBytes }) {
      signal?.throwIfAborted();
      if (typeof client?.downloadFile !== 'function') {
        throw new Error('Enterprise WeChat image download is unavailable');
      }
      const result = await client.downloadFile(url, aeskey);
      signal?.throwIfAborted();
      const raw = result?.buffer;
      if (!Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) {
        throw new Error('Enterprise WeChat image download returned no data');
      }
      const data = Buffer.from(raw);
      if (Number.isFinite(maxBytes) && data.length > maxBytes) {
        throw new ImagePromptError(
          'image-too-large',
          `Enterprise WeChat image exceeds ${maxBytes} bytes`,
          t('图片超过 5 MB，请压缩后重试。'),
        );
      }
      return { data, name: result?.filename };
    },
  };
}

function fileSource(client, file) {
  const url = nonEmptyString(file?.url);
  if (!url) return null;
  const aeskey = nonEmptyString(file?.aeskey) ?? undefined;
  return {
    name: nonEmptyString(file?.filename ?? file?.file_name ?? file?.name) ?? 'file',
    async load({ signal } = {}) {
      signal?.throwIfAborted();
      if (typeof client?.downloadFile !== 'function') {
        throw new Error('Enterprise WeChat file download is unavailable');
      }
      const result = await client.downloadFile(url, aeskey);
      signal?.throwIfAborted();
      const raw = result?.buffer ?? result?.data;
      if (!Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) {
        throw new Error('Enterprise WeChat file download returned no data');
      }
      return {
        data: Buffer.from(raw),
        ...(nonEmptyString(result?.filename) ? { name: result.filename.trim() } : {}),
      };
    },
  };
}

export function wecomInboundMessage(frame, client) {
  const body = bodyOf(frame);
  const replyTo = replyReferenceForBody(body);
  return {
    content: messageText(frame),
    images: imageContents(frame).map((image) => imageSource(client, image)).filter(Boolean),
    files: fileContents(frame).map((file) => fileSource(client, file)).filter(Boolean),
    ...(replyTo ? { replyTo } : {}),
  };
}

function prefetchInboundFiles(message, signal) {
  if (!Array.isArray(message?.files) || message.files.length === 0) return message;
  return {
    ...message,
    files: message.files.map((source) => {
      const download = source.load({ signal });
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

function prefetchInboundImages(message, signal) {
  if (!hasInboundImages(message)) return message;
  return {
    ...message,
    images: message.images.map((source) => {
      const download = source.load({ signal, maxBytes: MAX_IMAGE_BYTES });
      // The conversation queue may not consume this promise immediately. Keep
      // an attached rejection handler while preserving the original outcome.
      download.catch(() => undefined);
      return {
        ...source,
        async load({ signal: loadSignal, maxBytes = MAX_IMAGE_BYTES } = {}) {
          loadSignal?.throwIfAborted();
          const result = await download;
          loadSignal?.throwIfAborted();
          const raw = result?.data ?? result?.buffer ?? result;
          const size = Buffer.isBuffer(raw) || raw instanceof Uint8Array ? raw.length : 0;
          if (size > maxBytes) {
            throw new ImagePromptError(
              'image-too-large',
              `Enterprise WeChat image exceeds ${maxBytes} bytes`,
              t('图片超过 5 MB，请压缩后重试。'),
            );
          }
          return result;
        },
      };
    }),
  };
}

function imageQueueFullMessage(message) {
  return {
    ...message,
    images: message.images.map((source) => ({
      ...source,
      async load() {
        throw new ImagePromptError(
          'image-queue-full',
          `Enterprise WeChat already has ${MAX_PREFETCHED_IMAGES} prefetched images`,
          t('当前待处理图片较多，请稍后重新发送。'),
        );
      },
    })),
  };
}

function interactionReplyText(frame) {
  return bodyOf(frame).msgtype === 'text' ? messageText(frame) : '';
}

function isNativeWecomText(frame) {
  return bodyOf(frame).msgtype === 'text' && Boolean(nonEmptyString(messageText(frame)));
}

function splitUtf8(text, maxBytes = MAX_REPLY_BYTES) {
  const source = String(text ?? '').trim();
  if (!source) return [];
  const chunks = [];
  let current = '';
  let bytes = 0;
  for (const character of source) {
    const size = Buffer.byteLength(character);
    if (current && bytes + size > maxBytes) {
      chunks.push(current);
      current = character;
      bytes = size;
    } else {
      current += character;
      bytes += size;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function thinkingProgressText(update) {
  if (update?.type === 'tool') return t('正在使用{name}…', { name: update.name });
  return update?.text;
}

function streamContent(thinkingText, answerText = '', { finish = false } = {}) {
  const thinking = String(thinkingText ?? '')
    .replace(/<\/?think>/gi, '')
    .trim();
  const answer = String(answerText ?? '').trim();
  if (!thinking) return answer;
  const thinkBlock = finish || answer
    ? `<think>${thinking}</think>`
    : `<think>${thinking}`;
  return answer ? `${thinkBlock}\n${answer}` : thinkBlock;
}

function artifactFailureText(fileName, error) {
  const name = String(fileName ?? t('结果文件')).replace(/[\r\n]+/g, ' ').trim()
    || t('结果文件');
  switch (error?.code) {
    case 'artifact-delivery-uncertain':
      return t('结果文件「{name}」的发送结果未能确认，请先检查聊天内是否已收到，不要立即重试。', { name });
    case 'artifact-permission-required':
      return t('结果文件「{name}」已生成，但企业微信智能机器人缺少素材上传或文件消息能力，请检查机器人权限。', { name });
    case 'artifact-too-large':
      return t('结果文件「{name}」超过当前企业微信机器人可发送的文件大小，未发送。', { name });
    case 'artifact-empty':
      return t('结果文件「{name}」为空，企业微信不允许发送空文件。', { name });
    case 'artifact-changed':
    case 'artifact-invalid':
    case 'artifact-unavailable':
      return t('结果文件「{name}」暂时无法读取或准备发送，请确认文件仍可访问后重试。', { name });
    case 'artifact-rate-limited':
      return t('结果文件「{name}」暂时被企业微信限流，未能发送，请稍后重试。', { name });
    case 'artifact-provider-rejected':
      return t('结果文件「{name}」已生成，但企业微信拒绝了该文件或文件消息。', { name });
    default:
      return t('结果文件「{name}」已生成，但暂时未能通过企业微信发送，请稍后重试。', { name });
  }
}

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
    if (signal.aborted) onAbort();
  });
}

function wecomArtifactError(error, { dispatched = false } = {}) {
  if (error?.code?.startsWith?.('artifact-')) return error;
  const status = Number(error?.httpStatus ?? error?.status ?? error?.response?.status);
  const providerCode = Number(error?.providerCode ?? error?.errcode ?? error?.body?.errcode);
  const wrapped = new Error('Enterprise WeChat file delivery failed', { cause: error });
  if (status === 401 || status === 403 || providerCode === 48002) {
    wrapped.code = 'artifact-permission-required';
  } else if (status === 413) {
    wrapped.code = 'artifact-too-large';
  } else if (status === 429 || providerCode === 45009) {
    wrapped.code = 'artifact-rate-limited';
  } else if (Number.isFinite(providerCode) && providerCode !== 0) {
    wrapped.code = 'artifact-provider-rejected';
  } else {
    wrapped.code = dispatched ? 'artifact-delivery-uncertain' : 'artifact-provider-failed';
  }
  if (Number.isFinite(status)) wrapped.status = status;
  if (Number.isFinite(providerCode)) wrapped.providerCode = providerCode;
  return wrapped;
}

async function sendWecomMedia(
  client,
  chatId,
  file,
  mediaType,
  { signal, timeoutMs = DEFAULT_FILE_UPLOAD_TIMEOUT_MS } = {},
) {
  signal?.throwIfAborted();
  if (typeof client?.uploadMedia !== 'function'
    || typeof client?.sendMediaMessage !== 'function') {
    const unavailable = new Error(`Enterprise WeChat ${mediaType} delivery is unavailable`);
    unavailable.code = 'artifact-provider-unavailable';
    throw unavailable;
  }

  const timeout = AbortSignal.timeout(timeoutMs);
  const waitSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let uploaded;
  try {
    const pending = client.uploadMedia(file.bytes, {
      type: mediaType,
      filename: file.fileName,
    });
    trackOutboundArtifactProviderPromise(file, pending);
    uploaded = await waitWithSignal(pending, waitSignal);
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    throw wecomArtifactError(error);
  }

  signal?.throwIfAborted();
  const mediaId = nonEmptyString(uploaded?.media_id);
  if (!mediaId) {
    const rejected = new Error(`Enterprise WeChat ${mediaType} upload returned no media id`);
    rejected.code = 'artifact-provider-rejected';
    throw rejected;
  }

  let sent;
  try {
    const pending = client.sendMediaMessage(chatId, mediaType, mediaId);
    trackOutboundArtifactProviderPromise(file, pending);
    sent = await waitWithSignal(pending, waitSignal);
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    throw wecomArtifactError(error, { dispatched: true });
  }

  signal?.throwIfAborted();
  const providerCode = Number(sent?.body?.errcode ?? sent?.errcode);
  if (Number.isFinite(providerCode) && providerCode !== 0) {
    throw wecomArtifactError({ providerCode });
  }
  return sent;
}

/** Send one materialized artifact through Enterprise WeChat's native image message. */
export function sendWecomImage(client, chatId, file, options) {
  return sendWecomMedia(client, chatId, file, 'image', options);
}

function sendWecomFile(client, chatId, file, options) {
  return sendWecomMedia(client, chatId, file, 'file', options);
}

function answerTextForDelivery(answer, artifacts) {
  if (typeof answer === 'string' && answer.trim()) return answer;
  return artifacts.length > 0 ? t('结果文件已生成。') : t('任务已完成，但没有生成可显示的文本。');
}

function providerMessageId(result) {
  return nonEmptyString(result?.body?.msgid)
    ?? nonEmptyString(result?.body?.message_id);
}

function canClaimInteractionReply(frame, pending) {
  return pending.questions[pending.index]
    && nonEmptyString(bodyOf(frame).from?.userid) === pending.actor
    && nonEmptyString(interactionReplyText(frame));
}

export function createWecomBridgeStatus() {
  return {
    messagesReceived: 0,
    messagesReplied: 0,
    messagesRejected: 0,
    artifactsSent: 0,
    artifactSendErrors: 0,
    lastMessageAt: null,
    lastReplyAt: null,
    lastRejectedAt: null,
    lastError: null,
    lastMessageError: null,
  };
}

export class WecomHarnessBridge {
  #client;
  #harness;
  #state;
  #contextEnhancement;
  #accessPolicy;
  #status;
  #logger;
  #replyTimeoutMs;
  #generateReqId;
  #signal;
  #fileUploadTimeoutMs;
  #queues = new Map();
  #pendingInteractions = new Map();
  #interactionKeys = new Map();
  // Keep the accepted configuration through the existing queue/reply lifecycle.
  #acceptedMessageIds = new Map();
  #approvalTasks = new Set();
  #commandTasks = new Set();
  #approvals;
  #batchInputs = new BatchInputManager();
  #prefetchedImageCount = 0;

  constructor({
    client,
    harness,
    state,
    contextEnhancement,
    accessPolicy,
    status = createWecomBridgeStatus(),
    logger = console,
    replyTimeoutMs = 600_000,
    generateStreamId = generateReqId,
    fileUploadTimeoutMs = DEFAULT_FILE_UPLOAD_TIMEOUT_MS,
    signal,
  }) {
    if (!client || typeof client.replyStream !== 'function' || typeof client.sendMessage !== 'function') {
      throw new TypeError('Enterprise WeChat client is required');
    }
    if (!harness || !state) throw new TypeError('Harness client and state store are required');
    if (!Number.isInteger(fileUploadTimeoutMs) || fileUploadTimeoutMs < 1) {
      throw new TypeError('fileUploadTimeoutMs must be a positive integer');
    }
    this.#client = client;
    this.#harness = harness;
    this.#state = state;
    this.#contextEnhancement = contextEnhancement;
    this.#accessPolicy = accessPolicy;
    this.#status = status;
    this.#logger = logger;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#generateReqId = generateStreamId;
    this.#fileUploadTimeoutMs = Math.min(fileUploadTimeoutMs, DEFAULT_FILE_UPLOAD_TIMEOUT_MS);
    this.#signal = signal;
    this.#approvals = new HarnessApprovalQueue({ label: 'wecom', logger });
  }

  get status() {
    return structuredClone(this.#status);
  }

  accept(frame) {
    if (this.#signal?.aborted) return Promise.resolve();
    const body = bodyOf(frame);
    const messageId = nonEmptyString(body.msgid);
    const senderId = nonEmptyString(body.from?.userid);
    const chatId = body.chattype === 'group'
      ? nonEmptyString(body.chatid)
      : senderId;
    if (!messageId || !senderId || !chatId
      || !['single', 'group'].includes(body.chattype)
      || this.#state.hasSeen(messageId)
      || this.#acceptedMessageIds.has(messageId)) return Promise.resolve();

    const key = conversationKey(frame);
    const pending = this.#pendingInteractions.get(key);
    const commandMessage = wecomInboundMessage(frame, this.#client);
    const commandText = nonEmptyString(commandMessage.content) ?? '';
    const conversationType = body.chattype === 'single' ? 'direct' : 'group';
    const access = evaluateInboundAccess(this.#accessPolicy, {
      conversationType,
      senderIds: senderId,
      text: commandText,
      hasImages: hasInboundImages(commandMessage),
      hasFiles: hasInboundFiles(commandMessage),
    });
    if (!access.allowed) {
      this.#acceptedMessageIds.set(messageId, null);
      return this.#finishAccessDecision(frame, messageId, chatId, access);
    }
    this.#acceptedMessageIds.set(messageId, captureContextEnhancement(
      this.#contextEnhancement,
      conversationType,
    ));
    if (body.chattype === 'single') {
      rememberConnectionTestTarget(this.#state, { chatId });
    }
    const batchCommand = isBatchInputCommand(commandText);
    const batchStatus = this.#batchInputs.status(key);
    if (batchCommand && body.chattype === 'group') {
      return this.#finishBatchResult(
        frame,
        messageId,
        chatId,
        { message: batchInputGroupUnsupportedMessage() },
      );
    }
    if (body.chattype === 'single'
      && (batchCommand || batchStatus.phase === 'collecting')) {
      const exactBatchStart = /^\/batch$/iu.test(commandText);
      const result = exactBatchStart
        && batchStatus.phase === 'idle'
        && (this.#queues.has(key) || pending || this.#approvals.hasPending(key))
        ? { handled: true, kind: 'busy', message: batchInputBusyMessage() }
        : this.#batchInputs.handle(key, commandText, {
            plainText: isNativeWecomText(frame) && !hasReplyReference(commandMessage),
          });
      if (result.handled) {
        if (result.kind === 'submit') {
          return this.#enqueueMessage({
            ...frame,
            body: {
              ...body,
              msgtype: 'text',
              text: { content: result.prompt },
            },
          }, messageId, key, { batchSubmission: result });
        }
        return this.#finishBatchResult(frame, messageId, chatId, result);
      }
    }
    const commandRunner = isHistoryCommand(commandText) ? runHistoryCommand
      : hasInboundFiles(commandMessage) ? null : isControlCommand(commandText)
      ? runControlCommand
      : (isModelCommand(commandText)
          ? runModelCommand
          : (isPresetCommand(commandText) ? runPresetCommand : null));
    if (commandRunner) {
      let task;
      task = this.#processFastCommand(
        frame,
        messageId,
        chatId,
        key,
        commandMessage,
        commandRunner,
      ).catch((error) => {
        if (error?.code === 'turn-stopped' || this.#signal?.aborted) return;
        this.#status.lastError = error?.message ?? String(error);
        const failure = setLastMessageFailure(this.#status, error);
        this.#logger.error?.(
          `[dsh-im:wecom] failed to process a command [${failure.referenceId}]`,
        );
        return this.#sendImmediate(frame, chatId, messageFailureText(failure))
          .catch(() => undefined);
      }).finally(() => {
        this.#acceptedMessageIds.delete(messageId);
        this.#commandTasks.delete(task);
      });
      this.#commandTasks.add(task);
      return task;
    }
    const approval = this.#approvals.claimReply({
      key,
      actor: senderId,
      messageId,
      text: interactionReplyText(frame),
      addressed: true,
      hasPendingQuestion: Boolean(pending),
      questionCompletion: pending?.submitting || pending?.claimedReplyMessageId
        ? pending.queue
        : null,
      isQuestionPending: () => this.#pendingInteractions.has(key),
      send: (text) => this.#sendImmediate(frame, chatId, text),
    });
    if (approval) {
      let task;
      task = approval.process(async () => {
          if (this.#state.hasSeen(messageId)) return false;
          await this.#state.markSeen(messageId);
          this.#status.messagesReceived += 1;
          this.#status.lastMessageAt = new Date().toISOString();
          return true;
        })
        .finally(() => {
          this.#acceptedMessageIds.delete(messageId);
          this.#approvalTasks.delete(task);
        });
      this.#approvalTasks.add(task);
      return task;
    }
    if (pending && pending.actor !== senderId) {
      return this.#enqueueMessage(frame, messageId, key);
    }
    if (pending?.submitting || pending?.claimedReplyMessageId) {
      return this.#enqueueMessage(frame, messageId, key);
    }
    if (pending) {
      if (canClaimInteractionReply(frame, pending)) {
        pending.claimedReplyMessageId = messageId;
      }
      const previous = pending.queue ?? Promise.resolve();
      const current = previous
        .catch(() => undefined)
        .then(() => this.#processInteractionReply(
          frame,
          messageId,
          senderId,
          chatId,
          key,
          pending,
        ))
        .finally(() => {
          this.#acceptedMessageIds.delete(messageId);
          if (pending.claimedReplyMessageId === messageId) {
            pending.claimedReplyMessageId = null;
          }
          if (pending.queue === current) pending.queue = null;
        });
      pending.queue = current;
      return current;
    }
    return this.#enqueueMessage(frame, messageId, key);
  }

  #enqueueMessage(frame, messageId, key, {
    releaseMessageId = true,
    alreadyRecorded = false,
    batchSubmission = null,
  } = {}) {
    // WeCom image URLs expire after five minutes, while a conversation turn
    // may legally stay queued longer. Start the authenticated SDK download as
    // soon as the validated callback is accepted, then consume it in order.
    const inboundMessage = wecomInboundMessage(frame, this.#client);
    const imageCount = inboundMessage.images.length;
    let reservedImages = 0;
    let preparedMessage = inboundMessage;
    if (imageCount > 0) {
      if (this.#prefetchedImageCount + imageCount <= MAX_PREFETCHED_IMAGES) {
        reservedImages = imageCount;
        this.#prefetchedImageCount += reservedImages;
        preparedMessage = prefetchInboundImages(inboundMessage, this.#signal);
      } else {
        preparedMessage = imageQueueFullMessage(inboundMessage);
      }
    }
    preparedMessage = prefetchInboundFiles(preparedMessage, this.#signal);
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.#process(frame, {
        alreadyRecorded,
        preparedMessage,
        batchSubmission,
      }))
      .finally(() => {
        this.#prefetchedImageCount -= reservedImages;
        if (releaseMessageId) this.#acceptedMessageIds.delete(messageId);
        if (this.#queues.get(key) === current) this.#queues.delete(key);
      });
    this.#queues.set(key, current);
    return current;
  }

  #finishBatchResult(frame, messageId, chatId, result) {
    let task;
    task = Promise.resolve().then(async () => {
      if (this.#state.hasSeen(messageId)) return;
      await this.#state.markSeen(messageId);
      this.#status.messagesReceived += 1;
      this.#status.lastMessageAt = new Date().toISOString();
      if (result.message) await this.#sendImmediate(frame, chatId, result.message);
      this.#status.lastError = null;
    }).catch(async (error) => {
      if (this.#signal?.aborted) return;
      this.#status.lastError = error?.message ?? String(error);
      const failure = setLastMessageFailure(this.#status, error);
      this.#logger.error?.(
        `[dsh-im:wecom] failed to process a batch input message [${failure.referenceId}]`,
      );
      await this.#sendImmediate(frame, chatId, messageFailureText(failure))
        .catch(() => undefined);
    }).finally(() => {
      this.#acceptedMessageIds.delete(messageId);
      this.#commandTasks.delete(task);
    });
    this.#commandTasks.add(task);
    return task;
  }

  #finishAccessDecision(frame, messageId, chatId, access) {
    let task;
    task = Promise.resolve().then(async () => {
      if (this.#state.hasSeen(messageId)) return;
      await this.#state.markSeen(messageId);
      if (access.reason === 'command-not-allowed') {
        this.#status.messagesReceived += 1;
        this.#status.lastMessageAt = new Date().toISOString();
        await this.#sendImmediate(frame, chatId, t(COMMAND_PERMISSION_DENIED_MESSAGE));
        this.#status.messagesReplied += 1;
        this.#status.lastReplyAt = new Date().toISOString();
      } else {
        this.#status.messagesRejected += 1;
        this.#status.lastRejectedAt = new Date().toISOString();
      }
      this.#status.lastError = null;
    }).catch((error) => {
      if (this.#signal?.aborted) return;
      this.#status.lastError = error?.message ?? String(error);
      this.#logger.error?.('[dsh-im:wecom] failed to apply inbound access policy', error);
    }).finally(() => {
      this.#acceptedMessageIds.delete(messageId);
      this.#commandTasks.delete(task);
    });
    this.#commandTasks.add(task);
    return task;
  }

  async waitForIdle() {
    await Promise.allSettled([
      ...this.#queues.values(),
      ...[...this.#pendingInteractions.values()].flatMap((pending) => (
        pending.queue ? [pending.queue] : []
      )),
      ...this.#approvalTasks,
      ...this.#commandTasks,
    ]);
  }

  async #processFastCommand(frame, messageId, chatId, key, message, runner) {
    this.#signal?.throwIfAborted();
    if (this.#state.hasSeen(messageId)) return;
    await this.#state.markSeen(messageId);
    this.#status.messagesReceived += 1;
    this.#status.lastMessageAt = new Date().toISOString();
    const result = await runner(message.content, this.#harness, this.#state, key, {
      signal: this.#signal,
      isDirect: bodyOf(frame).chattype === 'single',
      hasImages: hasInboundImages(message),
      hasFiles: hasInboundFiles(message),
      pendingInteraction: this.#pendingInteractions.has(key)
        || this.#approvals.hasPending(key),
      control: { owner: this, key },
    });
    if (result?.stopped) {
      await Promise.allSettled([
        this.#cancelPendingInteraction(key),
        this.#approvals.closeRoute(key),
      ]);
    }
    for (const reply of result?.messages ?? [result?.message]) {
      if (reply) await this.#sendImmediate(frame, chatId, reply);
    }
    this.#status.lastError = null;
  }

  async #sendActive(chatId, text) {
    const providerMessageIds = [];
    for (const chunk of splitUtf8(text)) {
      this.#signal?.throwIfAborted();
      const result = await this.#client.sendMessage(
        chatId,
        { msgtype: 'markdown', markdown: { content: chunk } },
      );
      const messageId = providerMessageId(result);
      if (messageId) providerMessageIds.push(messageId);
    }
    return providerMessageIds;
  }

  async #sendImmediate(frame, chatId, text) {
    this.#signal?.throwIfAborted();
    const chunks = splitUtf8(text);
    if (chunks.length === 0) return;
    try {
      await this.#client.replyStream(frame, this.#generateReqId('stream'), chunks[0], true);
      for (const chunk of chunks.slice(1)) {
        await this.#client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: chunk } });
      }
    } catch {
      await this.#sendActive(chatId, text);
    }
  }

  async #deliverArtifacts(chatId, replyTo, artifacts = [], baseReceipt = null) {
    if (artifacts.length === 0) {
      return { receipt: baseReceipt, failureNoticeVisible: false, artifactSendErrors: 0 };
    }
    const delivery = await deliverOutboundArtifacts({
      artifacts,
      baseReceipt,
      deliveryId: replyTo,
      aggregatePresentation: baseReceipt ? 'wecom-text-and-files' : 'wecom-files',
      alwaysMerge: true,
      channelKey: 'wecom',
      signal: this.#signal,
      sendImage: (file) => sendWecomImage(this.#client, chatId, file, {
        signal: this.#signal,
        timeoutMs: this.#fileUploadTimeoutMs,
      }),
      sendFile: (file) => sendWecomFile(this.#client, chatId, file, {
        signal: this.#signal,
        timeoutMs: this.#fileUploadTimeoutMs,
      }),
      onFailure: (artifact, error) => setLastMessageFailure(this.#status, error, {
        userMessage: artifactFailureText(artifact?.fileName, error),
        reason: error?.code,
      }),
      sendFailureNotice: (_artifact, _error, failure) => this.#sendActive(
        chatId,
        messageFailureText(failure),
      ),
      logger: this.#logger,
    });
    this.#status.artifactsSent = (this.#status.artifactsSent ?? 0)
      + delivery.artifactsSent;
    this.#status.artifactSendErrors = (this.#status.artifactSendErrors ?? 0)
      + delivery.artifactSendErrors;
    return {
      receipt: delivery.receipt,
      failureNoticeVisible: delivery.failureNoticeVisible,
      artifactSendErrors: delivery.artifactSendErrors,
    };
  }

  async #process(frame, {
    alreadyRecorded = false,
    preparedMessage,
    batchSubmission = null,
  } = {}) {
    if (this.#signal?.aborted) return;
    const body = bodyOf(frame);
    const messageId = typeof body.msgid === 'string' ? body.msgid : '';
    const senderId = typeof body.from?.userid === 'string' ? body.from.userid : '';
    const chatId = body.chattype === 'group' ? body.chatid : senderId;
    if (!messageId || !senderId || !chatId || !['single', 'group'].includes(body.chattype)) return;
    if (!alreadyRecorded) {
      if (this.#state.hasSeen(messageId)) return;
      this.#status.messagesReceived += 1;
      this.#status.lastMessageAt = new Date().toISOString();
    }
    const message = preparedMessage ?? wecomInboundMessage(frame, this.#client);
    const text = message.content;
    const hasImages = hasInboundImages(message);
    const hasFiles = hasInboundFiles(message);
    const hasReply = hasReplyReference(message);
    const key = conversationKey(frame);
    let streamId = null;
    let streamStarted = false;
    let streamThinkingText = t('正在思考中…');
    let streamAnswerText = '';
    let batchSettled = batchSubmission === null;
    let promptRecorded = false;
    try {
      if (!text && !hasImages && !hasFiles && !hasReply) {
        await this.#sendImmediate(frame, chatId, t('目前支持文字、图片、文件和语音转写消息。'));
        await this.#state.markSeen(messageId);
        return;
      }
      const command = text.toLowerCase();
      if (!hasImages && !hasFiles && command === '/help') {
        await this.#sendImmediate(frame, chatId, helpText());
        await this.#state.markSeen(messageId);
        return;
      }
      if (!hasImages && !hasFiles && command === '/status') {
        await this.#harness.ensureRunning({ signal: this.#signal });
        await this.#sendImmediate(frame, chatId, t('企业微信机器人与 DeepSeek Harness 连接正常。'));
        await this.#state.markSeen(messageId);
        return;
      }
      if (!hasImages && !hasFiles && command === '/new') {
        await this.#state.clearSession(key);
        await this.#sendImmediate(frame, chatId, t('已开启新会话。请发送你的问题。'));
        await this.#state.markSeen(messageId);
        return;
      }
      const workspaceCommand = hasImages || hasFiles
        ? null
        : await runWorkspaceCommand(text, this.#harness, key);
      if (workspaceCommand) {
        for (const reply of workspaceCommand.messages ?? [workspaceCommand.message]) {
          await this.#sendImmediate(frame, chatId, reply);
        }
        await this.#state.markSeen(messageId);
        return;
      }
      const compactCommand = hasImages || hasFiles
        ? null
        : await runCompactCommand(
            text,
            this.#harness,
            this.#state,
            key,
            { signal: this.#signal },
          );
      if (compactCommand) {
        await this.#sendImmediate(frame, chatId, compactCommand.message);
        await this.#state.markSeen(messageId);
        return;
      }

      streamId = this.#generateReqId('stream');
      try {
        await this.#client.replyStream(
          frame,
          streamId,
          streamContent(streamThinkingText),
          false,
        );
        streamStarted = true;
      } catch (error) {
        this.#logger.warn?.('[dsh-im:wecom] unable to start a stream; using an active reply:', error);
      }

      let content = hasImages || hasReply
        ? await promptContentForInboundMessage(message, { signal: this.#signal })
        : undefined;
      const snapshot = this.#acceptedMessageIds.get(messageId);
      let contextEnhanced = false;
      if (snapshot) {
        const originalContent = content ?? text;
        content = enhanceContextContent(originalContent, snapshot, () => ({
          channel: 'wecom',
          senderId,
          chatId,
        }));
        contextEnhanced = content !== originalContent;
      }
      await this.#state.markSeen(messageId);
      promptRecorded = true;
      const { answer, artifacts = [] } = await askInWorkspaceSession({
        harness: this.#harness,
        state: this.#state,
        key,
        text,
        content,
        contextEnhanced,
        createOptions: { signal: this.#signal },
        existsOptions: { signal: this.#signal },
        askOptions: {
          timeoutMs: this.#replyTimeoutMs,
          signal: this.#signal,
          control: { owner: this, key },
          onUpdate: streamStarted && typeof this.#client.replyStreamNonBlocking === 'function'
            ? async (update) => {
                if (update?.type === 'text') {
                  streamAnswerText = update.text;
                } else {
                  streamThinkingText = thinkingProgressText(update) || streamThinkingText;
                }
                const preview = splitUtf8(
                  streamContent(streamThinkingText, streamAnswerText),
                )[0];
                if (preview) await this.#client.replyStreamNonBlocking(frame, streamId, preview, false);
              }
            : undefined,
          onInteraction: (interaction) => this.#handleInteraction(interaction, {
            key,
            actor: senderId,
            chatId,
            requiresMention: body.chattype === 'group',
          }),
          onInteractionResolved: (resolution) => this.#handleInteractionResolved(resolution),
          files: message.files,
        },
      });
      if (batchSubmission) {
        this.#batchInputs.complete(key, batchSubmission.token);
        batchSettled = true;
      }

      this.#signal?.throwIfAborted();
      const displayAnswer = answerTextForDelivery(answer, artifacts);
      const streamChunks = splitUtf8(
        streamContent(streamThinkingText, displayAnswer, { finish: true }),
      );
      let finalSent = false;
      let textReceipt = null;
      let textSendError = null;
      try {
        if (streamStarted && streamChunks.length > 0) {
          try {
            const providerMessageIds = [];
            const streamed = await this.#client.replyStream(frame, streamId, streamChunks[0], true);
            const streamedMessageId = providerMessageId(streamed);
            if (streamedMessageId) providerMessageIds.push(streamedMessageId);
            for (const chunk of streamChunks.slice(1)) {
              const sent = await this.#client.sendMessage(
                chatId,
                { msgtype: 'markdown', markdown: { content: chunk } },
              );
              const messageId = providerMessageId(sent);
              if (messageId) providerMessageIds.push(messageId);
            }
            finalSent = true;
            textReceipt = createDeliveryReceipt({
              deliveryId: messageId,
              presentation: 'wecom-text',
              providerMessageIds,
            });
          } catch (error) {
            this.#logger.warn?.('[dsh-im:wecom] stream finalization failed; using an active reply:', error);
          }
        }
        if (!finalSent) {
          const providerMessageIds = await this.#sendActive(chatId, displayAnswer);
          textReceipt = createDeliveryReceipt({
            deliveryId: messageId,
            presentation: 'wecom-text',
            providerMessageIds,
          });
        }
      } catch (error) {
        textSendError = channelDeliveryFailure(error);
        this.#logger.warn?.(
          '[dsh-im:wecom] final text delivery failed; continuing with result files:',
          error,
        );
      }
      const delivery = await this.#deliverArtifacts(chatId, messageId, artifacts, textReceipt);
      const artifactDispatched = delivery.receipt?.artifacts?.some(
        ({ outcome }) => outcome === 'sent' || outcome === 'unknown',
      );
      if (textSendError && !artifactDispatched && !delivery.failureNoticeVisible) {
        throw textSendError;
      }
      if (textSendError && delivery.artifactSendErrors === 0) {
        setLastMessageFailure(this.#status, textSendError);
      }
      if (!promptRecorded) await this.#state.markSeen(messageId);
      this.#status.messagesReplied += 1;
      this.#status.lastReplyAt = new Date().toISOString();
      this.#status.lastError = null;
      if (!textSendError && delivery.artifactSendErrors === 0) {
        clearLastMessageFailure(this.#status);
      }
      return delivery.receipt;
    } catch (error) {
      let batchFailureMessage = null;
      if (!batchSettled && batchSubmission) {
        if (error?.code === 'turn-stopped') {
          this.#batchInputs.complete(key, batchSubmission.token);
        } else {
          batchFailureMessage = this.#batchInputs.fail(key, batchSubmission.token).message ?? null;
        }
        batchSettled = true;
      }
      if (error?.code === 'turn-stopped') {
        if (streamStarted && streamId) {
          await this.#client.replyStream(
            frame,
            streamId,
            streamContent(streamThinkingText, t('已停止。'), { finish: true }),
            true,
          )
            .catch(() => undefined);
        }
        if (!promptRecorded) await this.#state.markSeen(messageId);
        return;
      }
      if (this.#signal?.aborted) return;
      this.#status.lastError = error?.message ?? String(error);
      const userMessage = inboundFileUserMessage(error)
        ?? imagePromptUserMessage(error);
      const failure = setLastMessageFailure(this.#status, error, {
        userMessage,
        reason: imagePromptDiagnostic(error)?.reason,
      });
      this.#logger.error?.(
        `[dsh-im:wecom] failed to process an inbound message [${failure.referenceId}]`,
      );
      const errorText = messageFailureText(failure);
      const visibleError = batchFailureMessage
        ? `${errorText}\n\n${batchFailureMessage}`
        : errorText;
      try {
        if (streamStarted && streamId) {
          await this.#client.replyStream(
            frame,
            streamId,
            streamContent(streamThinkingText, visibleError, { finish: true }),
            true,
          );
        } else {
          await this.#sendImmediate(frame, chatId, visibleError);
        }
        if (!promptRecorded) await this.#state.markSeen(messageId);
      } catch {
        this.#logger.error?.('[dsh-im:wecom] failed to send the safe error reply');
      }
    } finally {
      await Promise.allSettled([
        this.#cancelPendingInteraction(key),
        this.#approvals.closeRoute(key),
      ]);
    }
  }

  async #processInteractionReply(frame, messageId, senderId, chatId, key, expected) {
    if (this.#signal?.aborted) return;
    const current = this.#pendingInteractions.get(key);
    const claimed = expected.claimedReplyMessageId === messageId;
    if (!current || current !== expected || current.submitting) {
      if (claimed && (!current || current !== expected)) {
        return this.#discardResolvedInteractionReply(frame, messageId, chatId);
      }
      return this.#enqueueMessage(frame, messageId, key, { releaseMessageId: false });
    }
    if (this.#state.hasSeen(messageId)) return;
    await this.#state.markSeen(messageId);
    this.#status.messagesReceived += 1;
    this.#status.lastMessageAt = new Date().toISOString();

    const text = nonEmptyString(interactionReplyText(frame));
    if (!text) {
      await this.#sendImmediate(frame, chatId, t('请用文字回答当前问题。'))
        .catch(() => undefined);
      return;
    }

    const pending = this.#pendingInteractions.get(key);
    if (!pending || pending !== expected || pending.submitting) {
      if (claimed && (!pending || pending !== expected)) {
        await this.#sendImmediate(frame, chatId, t('这个问题已在其他客户端处理，无需再次回答。'))
          .catch(() => undefined);
        return;
      }
      return this.#enqueueMessage(frame, messageId, key, {
        releaseMessageId: false,
        alreadyRecorded: true,
      });
    }
    if (pending.actor !== senderId) {
      return this.#enqueueMessage(frame, messageId, key, {
        releaseMessageId: false,
        alreadyRecorded: true,
      });
    }

    pending.chatId = chatId;
    if (pending.needsPresentation) {
      try {
        await this.#presentInteraction(pending);
      } catch {
        this.#status.lastError = t('企业微信交互问题发送失败。');
        this.#logger.error?.('[dsh-im:wecom] failed to retry an interaction question');
        pending.interaction.reconnect?.();
        return;
      }
      const presentedPending = this.#pendingInteractions.get(key);
      if (!presentedPending || presentedPending !== expected || presentedPending.submitting) {
        if (claimed && (!presentedPending || presentedPending !== expected)) {
          await this.#sendImmediate(frame, chatId, t('这个问题已在其他客户端处理，无需再次回答。'))
            .catch(() => undefined);
          return;
        }
        return this.#enqueueMessage(frame, messageId, key, {
          releaseMessageId: false,
          alreadyRecorded: true,
        });
      }
    }

    const question = pending.questions[pending.index];
    if (!question) return;
    pending.answers.push(harnessAnswerForQuestion(question, text));
    pending.index += 1;
    if (pending.index < pending.questions.length) {
      if (pending.claimedReplyMessageId === messageId) {
        pending.claimedReplyMessageId = null;
      }
      pending.needsPresentation = true;
      try {
        await this.#presentInteraction(pending);
      } catch {
        this.#status.lastError = t('企业微信交互问题发送失败。');
        this.#logger.error?.('[dsh-im:wecom] failed to send the next interaction question');
        pending.interaction.reconnect?.();
      }
      return;
    }

    pending.submitting = true;
    try {
      await pending.interaction.respond({
        ok: true,
        value: {
          sessionId: pending.sessionId,
          answer: { answers: pending.answers },
        },
      });
      this.#clearPendingInteraction(key, pending.interactionId);
      this.#status.lastError = null;
    } catch (error) {
      if (this.#signal?.aborted) return;
      if (error?.code === 'interaction-not-pending') {
        if (this.#pendingInteractions.get(key) === pending) {
          this.#clearPendingInteraction(key, pending.interactionId);
        }
        await this.#sendImmediate(frame, chatId, t('这个问题已在其他客户端处理，无需再次回答。'))
          .catch(() => undefined);
        return;
      }
      if (this.#pendingInteractions.get(key) !== pending) return;
      pending.submitting = false;
      pending.answers.pop();
      pending.index -= 1;
      this.#status.lastError = t('回答提交失败。');
      this.#logger.error?.('[dsh-im:wecom] failed to answer a Harness interaction');
      await this.#sendImmediate(frame, chatId, t('回答提交失败，请重新发送当前问题的答案。'))
        .catch(() => undefined);
    }
  }

  async #handleInteraction(interaction, {
    key,
    actor,
    chatId,
    requiresMention,
  }) {
    if (interaction?.kind === 'approval') {
      return this.#approvals.handleRequested(interaction, {
        key,
        actor,
        requiresMention,
        send: (text) => this.#sendActive(chatId, text),
      });
    }
    if (interaction?.kind !== 'question') return;
    const questions = interaction?.payload?.questions;
    const interactionId = typeof interaction?.interactionId === 'string'
      ? interaction.interactionId
      : interaction?.rpcId;
    if (typeof interaction?.rpcId !== 'string'
      || typeof interactionId !== 'string'
      || typeof interaction.sessionId !== 'string'
      || !Array.isArray(questions)
      || questions.length === 0
      || questions.some((question) => !validHarnessQuestion(question))) {
      this.#logger.warn?.('[dsh-im:wecom] ignored an invalid Harness question interaction');
      return;
    }

    if (interaction.recovered === true) {
      await interaction.respond({
        ok: false,
        error: {
          code: 'cancelled',
          message: 'Enterprise WeChat safely cancelled an interaction left by an earlier client.',
          details: {},
        },
      });
      await this.#sendActive(
        chatId,
        t('检测到这个 Session 中遗留的待回答问题，已安全取消并继续处理你刚才的消息。'),
      ).catch(() => undefined);
      return;
    }

    const existing = this.#pendingInteractions.get(key);
    if (existing?.interactionId === interactionId) {
      existing.interaction = interaction;
      if (existing.needsPresentation) await this.#presentInteraction(existing);
      return;
    }
    if (this.#interactionKeys.has(interactionId)) return;
    if (existing) {
      this.#logger.warn?.('[dsh-im:wecom] cancelled a second pending Harness question');
      await interaction.respond({
        ok: false,
        error: {
          code: 'cancelled',
          message: 'Enterprise WeChat is already handling another user interaction.',
          details: {},
        },
      });
      return;
    }

    const pending = {
      kind: 'question',
      interactionId,
      sessionId: interaction.sessionId,
      interaction,
      actor,
      requiresMention,
      questions,
      answers: [],
      index: 0,
      chatId,
      queue: null,
      claimedReplyMessageId: null,
      submitting: false,
      needsPresentation: true,
      presentationPromise: null,
    };
    this.#pendingInteractions.set(key, pending);
    this.#interactionKeys.set(pending.interactionId, key);
    await this.#presentInteraction(pending);
  }

  async #handleInteractionResolved(resolution) {
    if (resolution?.kind === 'approval') {
      await this.#approvals.handleResolved(resolution);
      return;
    }
    const interactionId = resolution?.interactionId;
    if (resolution?.kind !== 'question' || typeof interactionId !== 'string') return;
    const key = this.#interactionKeys.get(interactionId);
    if (!key) return;
    this.#clearPendingInteraction(key, interactionId);
  }

  #presentInteraction(pending) {
    if (!pending.needsPresentation) return Promise.resolve();
    if (pending.presentationPromise) return pending.presentationPromise;
    const question = pending.questions[pending.index];
    if (!question) return Promise.resolve();
    const presentation = this.#sendActive(
      pending.chatId,
      harnessQuestionText(
        question,
        pending.index,
        pending.questions.length,
        { requiresMention: pending.requiresMention },
      ),
    ).then(() => {
      pending.needsPresentation = false;
    }).finally(() => {
      if (pending.presentationPromise === presentation) {
        pending.presentationPromise = null;
      }
    });
    pending.presentationPromise = presentation;
    return presentation;
  }

  async #discardResolvedInteractionReply(frame, messageId, chatId) {
    if (this.#state.hasSeen(messageId)) return;
    await this.#state.markSeen(messageId);
    this.#status.messagesReceived += 1;
    this.#status.lastMessageAt = new Date().toISOString();
    await this.#sendImmediate(frame, chatId, t('这个问题已在其他客户端处理，无需再次回答。')).catch(() => undefined);
  }

  #takePendingInteraction(key, interactionId) {
    const pending = this.#pendingInteractions.get(key);
    if (!pending
      || (interactionId !== undefined && pending.interactionId !== interactionId)) return null;
    this.#pendingInteractions.delete(key);
    this.#interactionKeys.delete(pending.interactionId);
    return pending;
  }

  #clearPendingInteraction(key, interactionId) {
    return this.#takePendingInteraction(key, interactionId) !== null;
  }

  async #cancelPendingInteraction(key) {
    const pending = this.#takePendingInteraction(key);
    if (!pending || pending.kind !== 'question') return;
    try {
      await pending.interaction.respond({
        ok: false,
        error: {
          code: 'cancelled',
          message: 'The Enterprise WeChat interaction ended before the user answered.',
          details: {},
        },
      }, { signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      if (error?.code !== 'interaction-not-pending') {
        this.#logger.warn?.('[dsh-im:wecom] failed to cancel a pending Harness interaction');
      }
    }
  }
}
