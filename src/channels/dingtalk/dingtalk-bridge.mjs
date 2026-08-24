import {
  normalizeDingtalkSessionWebhook,
  splitDingtalkText,
} from './dingtalk-api.mjs';
import { createDingTalkCardStream } from './dingtalk-card-stream.mjs';
import {
  harnessAnswerForQuestion,
  harnessQuestionText,
  validHarnessQuestion,
} from '../shared/harness-question.mjs';
import { HarnessApprovalQueue } from '../shared/harness-approval.mjs';
import { runCompactCommand } from '../shared/compact-command.mjs';
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
import {
  hasInboundImages,
  imagePromptUserMessage,
  promptContentForMessage,
} from '../shared/image-prompt.mjs';
import {
  hasInboundFiles,
  inboundFileUserMessage,
  prefetchInboundFiles,
} from '../shared/inbound-file.mjs';
import { rememberConnectionTestTarget } from '../shared/connection-test.mjs';
import { deliverOutboundArtifacts } from '../shared/semantic/artifact-delivery.mjs';
import {
  createDeliveryReceipt,
  providerMessageIdsFor,
} from '../shared/semantic/delivery.mjs';
import { t } from '../shared/i18n.mjs';

const CARD_INITIAL_TEXT = '已连接 DeepSeek Harness，正在思考…';
const CARD_ERROR_TEXT = '消息处理失败，请稍后重试。';
const INTERACTION_RESOLVED_TEXT = '这个问题已在其他客户端处理，无需再次回答。';

const HELP_TEXT_LINES = [
  '钉钉机器人已连接 DeepSeek Harness。',
  '',
  '直接发送文字、图片或文件即可继续当前会话。',
  '/new  开启一个全新会话',
  '/compact  压缩当前会话的较早上下文',
  '/workspace 工作区绝对路径  切换工作区',
  '/workspacelist  列出工作区绝对路径',
  '/sessionlist [工作区序号或绝对路径]  列出会话 ID 和标题',
  '/session Session ID 或当前工作区序号  将当前聊天绑定到指定会话',
  '/models  按序号列出所有可用模型',
  '/model [序号或完整模型ID]  查看或切换当前会话模型',
  '示例：先发 /models，再发 /model 2',
  '/presetlist  按序号列出可用 Agent Preset',
  '/preset [序号或完整ID]  查看或设置当前机器人 Agent Preset',
  '纯数字 ID：/preset id:<ID>',
  '/preset --default  跟随 Host 默认',
  '/stop  停止当前任务',
  '/steer 补充指令  纠偏当前任务',
  '/status  检查连接状态',
  '/help  显示本帮助',
];

function helpText() {
  return HELP_TEXT_LINES.map((line) => t(line)).join('\n');
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function dingtalkFileProviderIds(result) {
  const ids = providerMessageIdsFor(result);
  const processQueryKey = nonEmptyString(result?.processQueryKey);
  if (processQueryKey && !ids.includes(processQueryKey)) ids.push(processQueryKey);
  return ids;
}

function safeErrorDiagnostic(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (current && typeof current === 'object' && chain.length < 3 && !seen.has(current)) {
    seen.add(current);
    const name = nonEmptyString(current.name)?.slice(0, 80);
    const code = nonEmptyString(current.code)?.slice(0, 80);
    const providerCode = nonEmptyString(current.providerCode)?.slice(0, 160);
    const status = Number.isInteger(current.status) ? current.status : undefined;
    chain.push({
      ...(name ? { name } : {}),
      ...(code ? { code } : {}),
      ...(providerCode ? { providerCode } : {}),
      ...(status ? { status } : {}),
    });
    current = current.cause;
  }
  return chain;
}

function dingtalkImageErrorUserMessage(error) {
  let current = error;
  const seen = new Set();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (current.code === 'image-download-address-failed') {
      return t('钉钉未能换取图片下载地址，请重新发送；若持续失败，请检查机器人的“企业内机器人发送消息权限”。');
    }
    if (current.code === 'invalid-image-download') {
      return t('钉钉没有返回图片下载地址，请重新发送。');
    }
    if (current.code === 'image-content-download-failed') {
      return t('钉钉返回的图片临时地址无法读取，请重新发送。');
    }
    current = current.cause;
  }
  return imagePromptUserMessage(error);
}

function senderStaffId(message) {
  return nonEmptyString(message?.senderStaffId) ?? nonEmptyString(message?.senderId);
}

function parsedMessageContent(message) {
  if (message?.content && typeof message.content === 'object') return message.content;
  if (typeof message?.content !== 'string') return null;
  try {
    const parsed = JSON.parse(message.content);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function richTextEntries(content) {
  const entries = content?.richText ?? content?.rich_text;
  return Array.isArray(entries) ? entries : [];
}

function richTextEntryText(entry) {
  if (typeof entry?.text === 'string') return nonEmptyString(entry.text);
  if (typeof entry?.text?.content === 'string') return nonEmptyString(entry.text.content);
  if (String(entry?.type).toLowerCase() === 'text' && typeof entry?.content === 'string') {
    return nonEmptyString(entry.content);
  }
  return null;
}

function downloadCodeFor(value) {
  return nonEmptyString(value?.downloadCode) ?? nonEmptyString(value?.pictureDownloadCode);
}

/** Normalize DingTalk picture and richText callbacks into lazy image references. */
export function dingtalkInboundMessage(message, {
  api,
  clientId,
  clientSecret,
} = {}) {
  const msgtype = String(message?.msgtype ?? '').toLowerCase();
  const content = parsedMessageContent(message);
  const richEntries = msgtype === 'richtext' ? richTextEntries(content) : [];
  const text = msgtype === 'text'
    ? nonEmptyString(message?.text?.content) ?? ''
    : richEntries.map(richTextEntryText).filter(Boolean).join('\n');
  const imageCodes = [];
  if (msgtype === 'picture') {
    const code = downloadCodeFor(content);
    if (code) imageCodes.push(code);
  } else if (msgtype === 'richtext') {
    for (const entry of richEntries) {
      if (String(entry?.type ?? '').toLowerCase() !== 'picture') continue;
      const code = downloadCodeFor(entry);
      if (code) imageCodes.push(code);
    }
  }
  const fileCode = msgtype === 'file' ? downloadCodeFor(content) : null;
  return {
    content: text,
    images: imageCodes.map((downloadCode, index) => ({
      name: index === 0 ? 'image' : `image-${index + 1}`,
      load: ({ signal, maxBytes }) => {
        if (typeof api?.downloadImage !== 'function') {
          throw new Error('DingTalk API does not support image downloads');
        }
        return api.downloadImage({
          clientId,
          clientSecret,
          robotCode: message?.robotCode,
          downloadCode,
          signal,
          maxBytes,
        });
      },
    })),
    files: fileCode ? [{
      name: nonEmptyString(content?.fileName ?? content?.file_name) ?? 'file',
      load: ({ signal } = {}) => {
        if (typeof api?.downloadFile !== 'function') {
          throw new Error('DingTalk API does not support file downloads');
        }
        return api.downloadFile({
          clientId,
          clientSecret,
          robotCode: message?.robotCode,
          downloadCode: fileCode,
          signal,
        });
      },
    }] : [],
  };
}

function conversationKey(message, sender) {
  if (String(message?.conversationType) === '2') {
    const conversationId = nonEmptyString(message?.conversationId);
    if (!conversationId) throw new Error('DingTalk group message has no conversation id');
    return `group:${conversationId}`;
  }
  return `p2p:${sender}`;
}

function cardTarget(message, sender) {
  if (String(message?.conversationType) === '2') {
    return { type: 'group', openConversationId: nonEmptyString(message?.conversationId) };
  }
  return { type: 'user', userId: sender };
}

function fileTarget(message, sender, clientId) {
  const robotCode = nonEmptyString(message?.robotCode) ?? clientId;
  if (String(message?.conversationType) === '2') {
    return {
      type: 'group',
      openConversationId: nonEmptyString(message?.conversationId),
      robotCode,
    };
  }
  return { type: 'user', userId: sender, robotCode };
}

function artifactFailureText(fileName, error) {
  const name = String(fileName ?? t('结果文件')).replace(/[\r\n]+/g, ' ').trim() || t('结果文件');
  switch (error?.code) {
    case 'artifact-delivery-uncertain':
      return t('结果文件「{name}」发送结果未能确认，请先检查聊天内是否已收到，不要立即重试。', { name });
    case 'artifact-permission-required':
      return t('结果文件「{name}」已生成，但钉钉应用或机器人缺少文件消息权限。请开通应用 qyapi_base 权限，并确认机器人具备文件消息发送能力。', { name });
    case 'artifact-too-large':
      return t('结果文件「{name}」超过当前钉钉机器人可发送的文件大小，未发送。', { name });
    case 'artifact-rate-limited':
      return t('结果文件「{name}」暂时被钉钉限流，未能发送，请稍后重试。', { name });
    case 'artifact-provider-rejected':
      return t('结果文件「{name}」已生成，但钉钉拒绝了该文件消息，请检查文件类型和机器人文件消息配置。', { name });
    case 'artifact-invalid':
    case 'artifact-changed':
    case 'artifact-unavailable':
      return t('结果文件「{name}」暂时无法读取或准备发送，请确认文件仍可访问后重试。', { name });
    default:
      return t('结果文件「{name}」已生成，但暂时未能通过钉钉发送，请稍后重试。', { name });
  }
}

function progressText(update) {
  if (update?.type === 'text' && nonEmptyString(update.text)) return update.text;
  if (update?.type === 'tool') {
    if (update.name === 'web_search') return t('_正在搜索网络并整理信息…_');
    return t('_正在使用 {name}…_', { name: nonEmptyString(update.name) ?? t('工具') });
  }
  return t('_{text}_', { text: nonEmptyString(update?.text) ?? t('正在处理…') });
}

function canClaimInteractionReply(message, pending, sender) {
  if (pending.needsPresentation || !pending.questions[pending.index]) return false;
  if (pending.actor !== sender) return false;
  if (String(message?.conversationType) === '2' && message?.isInAtList !== true) return false;
  if (message?.msgtype !== 'text' || !nonEmptyString(message?.text?.content)) return false;
  try {
    normalizeDingtalkSessionWebhook(message.sessionWebhook);
    return true;
  } catch {
    return false;
  }
}

function ensureStats(status) {
  status.stats ??= {};
  for (const key of ['messagesReceived', 'messagesReplied', 'messagesRejected', 'messagesIgnored']) {
    status[key] ??= 0;
    status.stats[key] = status[key];
  }
  status.pendingSenders ??= [];
}

function increment(status, key) {
  status[key] = (status[key] ?? 0) + 1;
  status.stats ??= {};
  status.stats[key] = status[key];
}

export function createDingtalkBridgeStatus({ pendingSenders = [] } = {}) {
  return {
    messagesReceived: 0,
    messagesReplied: 0,
    messagesRejected: 0,
    messagesIgnored: 0,
    lastMessageAt: null,
    lastReplyAt: null,
    lastRejectedAt: null,
    lastError: null,
    pendingSenders: structuredClone(pendingSenders),
    stats: {
      messagesReceived: 0,
      messagesReplied: 0,
      messagesRejected: 0,
      messagesIgnored: 0,
    },
  };
}

export class DingtalkHarnessBridge {
  #api;
  #clientId;
  #clientSecret;
  #harness;
  #state;
  #status;
  #logger;
  #replyTimeoutMs;
  #maxMessageChars;
  #signal;
  #queues = new Map();
  #pendingInteractions = new Map();
  #interactionKeys = new Map();
  #interactionTasks = new Set();
  #commandTasks = new Set();
  #acceptedMessageIds = new Set();
  #approvals;

  constructor({
    api,
    clientId,
    clientSecret,
    harness,
    state,
    status = createDingtalkBridgeStatus(),
    logger = console,
    replyTimeoutMs = 600_000,
    maxMessageChars = 4_000,
    signal,
  }) {
    if (!api || typeof api.sendText !== 'function') throw new TypeError('DingTalk API is required');
    if (!nonEmptyString(clientId) || !nonEmptyString(clientSecret)) {
      throw new TypeError('DingTalk app credentials are required');
    }
    if (!harness || !state) throw new TypeError('Harness client and state store are required');
    this.#api = api;
    this.#clientId = clientId.trim();
    this.#clientSecret = clientSecret.trim();
    this.#harness = harness;
    this.#state = state;
    this.#status = status;
    this.#logger = logger;
    this.#approvals = new HarnessApprovalQueue({ label: 'DingTalk', logger });
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#maxMessageChars = maxMessageChars;
    this.#signal = signal;
    ensureStats(this.#status);
    this.#refreshPendingSenders();
  }

  get status() {
    this.#refreshPendingSenders();
    return structuredClone(this.#status);
  }

  accept(message) {
    if (this.#signal?.aborted) return Promise.resolve();
    const messageId = nonEmptyString(message?.msgId);
    const sender = senderStaffId(message);
    if (!messageId || !sender || this.#state.hasSeen(messageId)
      || this.#acceptedMessageIds.has(messageId)) return Promise.resolve();
    this.#acceptedMessageIds.add(messageId);

    let key;
    try {
      key = conversationKey(message, sender);
    } catch {
      this.#acceptedMessageIds.delete(messageId);
      increment(this.#status, 'messagesRejected');
      this.#status.lastRejectedAt = new Date().toISOString();
      return Promise.resolve();
    }

    let sessionWebhook = null;
    try {
      sessionWebhook = normalizeDingtalkSessionWebhook(message.sessionWebhook);
    } catch {
      // An unsafe reply route must never be able to submit an approval.
    }
    if (sessionWebhook && String(message.conversationType) !== '2') {
      rememberConnectionTestTarget(this.#state, { sessionWebhook });
    }
    const pending = this.#pendingInteractions.get(key);
    const promptMessage = dingtalkInboundMessage(message, {
      api: this.#api,
      clientId: this.#clientId,
      clientSecret: this.#clientSecret,
    });
    const commandText = nonEmptyString(promptMessage.content) ?? '';
    const commandRunner = hasInboundFiles(promptMessage) ? null : isControlCommand(commandText)
      ? runControlCommand
      : (isModelCommand(commandText)
          ? runModelCommand
          : (isPresetCommand(commandText) ? runPresetCommand : null));
    const addressed = String(message.conversationType) !== '2' || message?.isInAtList === true;
    if (commandRunner && sessionWebhook && addressed) {
      let task;
      task = this.#processFastCommand(
        message,
        messageId,
        key,
        sessionWebhook,
        promptMessage,
        commandRunner,
      ).catch((error) => {
        if (error?.code === 'turn-stopped' || this.#signal?.aborted) return;
        this.#status.lastError = t('钉钉命令处理失败。');
        this.#logger.error?.('[dsh-dingtalk] failed to process a command', safeErrorDiagnostic(error));
        return this.#send(sessionWebhook, t(CARD_ERROR_TEXT), this.#atUsersFor(message)).catch(() => undefined);
      }).finally(() => {
        this.#acceptedMessageIds.delete(messageId);
        this.#commandTasks.delete(task);
      });
      this.#commandTasks.add(task);
      return task;
    }
    const approvalReply = this.#approvals.claimReply({
      key,
      actor: sender,
      messageId,
      text: sessionWebhook && message?.msgtype === 'text'
        ? nonEmptyString(message?.text?.content) ?? ''
        : '',
      addressed: String(message?.conversationType) !== '2' || message?.isInAtList === true,
      hasPendingQuestion: Boolean(pending),
      questionCompletion: pending?.submitting || pending?.claimedReplyMessageId
        ? pending.queue
        : null,
      isQuestionPending: () => this.#pendingInteractions.has(key),
      send: sessionWebhook
        ? (reply) => this.#send(sessionWebhook, reply, this.#atUsersFor(message))
        : async () => undefined,
    });
    if (approvalReply) {
      let current;
      current = approvalReply.process(async () => {
          if (this.#state.hasSeen(messageId)) return false;
          await this.#state.markSeen(messageId);
          increment(this.#status, 'messagesReceived');
          this.#status.lastMessageAt = new Date().toISOString();
          if (!sessionWebhook) {
            increment(this.#status, 'messagesRejected');
            this.#status.lastRejectedAt = new Date().toISOString();
            this.#status.lastError = t('钉钉消息没有安全的回复地址。');
          }
          return true;
        })
        .catch((error) => {
          if (this.#signal?.aborted) return;
          this.#status.lastError = t('钉钉审批处理失败。');
          this.#logger.error?.('[dsh-dingtalk] failed to process an approval reply', error);
        })
        .finally(() => {
          this.#acceptedMessageIds.delete(messageId);
          this.#interactionTasks.delete(current);
        });
      this.#interactionTasks.add(current);
      return current;
    }

    if (pending && pending.actor !== sender) {
      return this.#enqueueMessage(message, messageId, sender, key);
    }
    // Once one valid answer has been claimed, later messages are subsequent
    // prompts even if the network submission eventually needs a retry. Invalid
    // replies do not claim the question, so the next valid answer can still
    // pass through this interaction queue.
    if (pending?.submitting || pending?.claimedReplyMessageId) {
      return this.#enqueueMessage(message, messageId, sender, key);
    }
    if (pending) {
      if (canClaimInteractionReply(message, pending, sender)) {
        pending.claimedReplyMessageId = messageId;
      }
      const previous = pending.queue ?? Promise.resolve();
      const current = previous
        .catch(() => undefined)
        .then(() => this.#processInteractionReply(message, messageId, sender, key, pending))
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
    return this.#enqueueMessage(message, messageId, sender, key);
  }

  #enqueueMessage(message, messageId, sender, key, {
    releaseMessageId = true,
    alreadyRecorded = false,
  } = {}) {
    let hasSafeReplyRoute = false;
    try {
      normalizeDingtalkSessionWebhook(message.sessionWebhook);
      hasSafeReplyRoute = true;
    } catch {
      // Keep the existing rejection path without downloading an unusable file.
    }
    const addressed = String(message.conversationType) !== '2' || message.isInAtList === true;
    const preparedMessage = hasSafeReplyRoute && addressed
      ? prefetchInboundFiles(dingtalkInboundMessage(message, {
          api: this.#api,
          clientId: this.#clientId,
          clientSecret: this.#clientSecret,
        }), { signal: this.#signal })
      : undefined;
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.#process(message, messageId, sender, key, {
        alreadyRecorded,
        preparedMessage,
      }))
      .finally(() => {
        if (releaseMessageId) this.#acceptedMessageIds.delete(messageId);
        if (this.#queues.get(key) === current) this.#queues.delete(key);
      });
    this.#queues.set(key, current);
    return current;
  }

  async waitForIdle() {
    await Promise.allSettled([
      ...this.#queues.values(),
      ...[...this.#pendingInteractions.values()].flatMap((pending) => (
        pending.queue ? [pending.queue] : []
      )),
      ...this.#interactionTasks,
      ...this.#commandTasks,
    ]);
  }

  async #processFastCommand(message, messageId, key, sessionWebhook, prompt, runner) {
    this.#signal?.throwIfAborted();
    if (this.#state.hasSeen(messageId)) return;
    await this.#state.markSeen(messageId);
    increment(this.#status, 'messagesReceived');
    this.#status.lastMessageAt = new Date().toISOString();
    const result = await runner(
      nonEmptyString(prompt.content) ?? '',
      this.#harness,
      this.#state,
      key,
      {
        signal: this.#signal,
        hasImages: hasInboundImages(prompt),
        hasFiles: hasInboundFiles(prompt),
        pendingInteraction: this.#pendingInteractions.has(key)
          || this.#approvals.hasPending(key),
        control: { owner: this, key },
      },
    );
    if (result?.stopped) {
      await Promise.allSettled([
        this.#cancelPendingInteraction(key),
        this.#approvals.closeRoute(key),
      ]);
    }
    for (const reply of result?.messages ?? [result?.message]) {
      if (reply) await this.#send(sessionWebhook, reply, this.#atUsersFor(message));
    }
    this.#status.lastError = null;
  }

  async #process(message, messageId, sender, key, {
    alreadyRecorded = false,
    preparedMessage,
  } = {}) {
    this.#signal?.throwIfAborted();
    if (!alreadyRecorded) {
      if (this.#state.hasSeen(messageId)) return;
      await this.#state.markSeen(messageId);
      increment(this.#status, 'messagesReceived');
      this.#status.lastMessageAt = new Date().toISOString();
    }

    if (String(message.conversationType) === '2' && message.isInAtList !== true) {
      increment(this.#status, 'messagesIgnored');
      return;
    }

    let sessionWebhook;
    try {
      sessionWebhook = normalizeDingtalkSessionWebhook(message.sessionWebhook);
    } catch {
      increment(this.#status, 'messagesRejected');
      this.#status.lastRejectedAt = new Date().toISOString();
      this.#status.lastError = t('钉钉消息没有安全的回复地址。');
      return;
    }

    const promptMessage = preparedMessage ?? dingtalkInboundMessage(message, {
      api: this.#api,
      clientId: this.#clientId,
      clientSecret: this.#clientSecret,
    });
    const text = promptMessage.content;
    const hasImages = hasInboundImages(promptMessage);
    const hasFiles = hasInboundFiles(promptMessage);
    const isPlainText = String(message?.msgtype).toLowerCase() === 'text';
    let cardStream = null;
    let cardStarted = false;
    try {
      if (!text && !hasImages && !hasFiles) {
        await this.#send(sessionWebhook, t('目前支持文字、图片和文件消息。'), this.#atUsersFor(message));
        return;
      }

      const command = text.toLowerCase();
      if (isPlainText && !hasImages && !hasFiles && command === '/help') {
        await this.#send(sessionWebhook, helpText(), this.#atUsersFor(message));
        return;
      }
      if (isPlainText && !hasImages && !hasFiles && command === '/status') {
        await this.#harness.ensureRunning({ signal: this.#signal });
        await this.#send(sessionWebhook, t('钉钉机器人与 DeepSeek Harness 连接正常。'), this.#atUsersFor(message));
        return;
      }
      if (isPlainText && !hasImages && !hasFiles && command === '/new') {
        await this.#state.clearSession(key);
        await this.#send(sessionWebhook, t('已开启新会话。请发送你的问题。'), this.#atUsersFor(message));
        return;
      }
      const workspaceCommand = isPlainText && !hasImages && !hasFiles
        ? await runWorkspaceCommand(text, this.#harness, key)
        : null;
      if (workspaceCommand) {
        for (const reply of workspaceCommand.messages ?? [workspaceCommand.message]) {
          await this.#send(sessionWebhook, reply, this.#atUsersFor(message));
        }
        return;
      }
      const compactCommand = isPlainText && !hasImages && !hasFiles
        ? await runCompactCommand(
            text,
            this.#harness,
            this.#state,
            key,
            { signal: this.#signal },
          )
        : null;
      if (compactCommand) {
        await this.#send(sessionWebhook, compactCommand.message, this.#atUsersFor(message));
        return;
      }

      const content = hasImages
        ? await promptContentForMessage(promptMessage, { signal: this.#signal })
        : undefined;
      if (typeof this.#api.createAiCard === 'function'
        && typeof this.#api.updateAiCard === 'function'
        && typeof this.#api.finishAiCard === 'function') {
        cardStream = createDingTalkCardStream({
          api: this.#api,
          clientId: this.#clientId,
          clientSecret: this.#clientSecret,
          target: cardTarget(message, sender),
          signal: this.#signal,
          logger: this.#logger,
        });
        cardStarted = await cardStream.start(t(CARD_INITIAL_TEXT));
      }
      // 消息元数据注入：把钉钉回调的【完整原始消息对象】序列化为独立文本块，作为
      // session.prompt content 的第一块（多 text 块是官方支持的标准载荷），第二块为
      // 用户正文原文。agent 因此能读到 senderStaffId / senderNick / conversationId /
      // conversationType / atUsers / sessionWebhook 等回调全部字段（“几十个字段”）。
      const messageJson = JSON.stringify(message, null, 2);
      const { answer, artifacts = [] } = await askInWorkspaceSession({
        harness: this.#harness,
        state: this.#state,
        key,
        ...(hasImages
          ? { content: [{ type: 'text', text: messageJson }, { type: 'text', text: content }] }
          : { text: [{ type: 'text', text: messageJson }, { type: 'text', text }] }),
        createOptions: { signal: this.#signal },
        existsOptions: { signal: this.#signal },
        askOptions: {
          timeoutMs: this.#replyTimeoutMs,
          signal: this.#signal,
          control: { owner: this, key },
          onUpdate: cardStarted
            ? (update) => cardStream.push(progressText(update))
            : undefined,
          onInteraction: (interaction) => this.#handleInteraction(interaction, {
            key,
            actor: sender,
            sessionWebhook,
            requiresMention: String(message.conversationType) === '2',
          }),
          onInteractionResolved: (resolution) => this.#handleInteractionResolved(resolution),
          files: promptMessage.files,
        },
      });
      const answerText = typeof answer === 'string' && answer.trim()
        ? answer
        : artifacts.length > 0 ? t('结果文件已生成。') : answer;
      let textDeliveryError = null;
      let textReceipt = null;
      let streamed = false;
      try {
        streamed = cardStarted && await cardStream.finish(answerText);
        if (streamed) {
          textReceipt = createDeliveryReceipt({
            deliveryId: messageId,
            presentation: 'dingtalk-card',
          });
        } else {
          textReceipt = createDeliveryReceipt({
            deliveryId: messageId,
            presentation: 'dingtalk-text',
            providerMessageIds: await this.#send(sessionWebhook, answerText, this.#atUsersFor(message)),
          });
        }
      } catch (error) {
        textDeliveryError = error;
      }
      const delivery = await this.#deliverArtifacts(
        fileTarget(message, sender, this.#clientId),
        sessionWebhook,
        messageId,
        artifacts,
        textReceipt,
      );
      if (textDeliveryError && !delivery.userVisible) throw textDeliveryError;
      increment(this.#status, 'messagesReplied');
      this.#status.lastReplyAt = new Date().toISOString();
      this.#status.lastError = null;
      return delivery.receipt;
    } catch (error) {
      if (error?.code === 'turn-stopped') {
        if (cardStarted) await cardStream.finish(t('已停止。')).catch(() => undefined);
        return;
      }
      if (this.#signal?.aborted) return;
      this.#status.lastError = t('钉钉消息处理失败。');
      this.#logger.error?.(
        '[dsh-dingtalk] failed to process an inbound message',
        safeErrorDiagnostic(error),
      );
      try {
        const errorText = inboundFileUserMessage(error)
          ?? dingtalkImageErrorUserMessage(error)
          ?? t(CARD_ERROR_TEXT);
        const streamed = cardStarted && await cardStream.finish(errorText);
        if (!streamed) await this.#send(sessionWebhook, errorText, this.#atUsersFor(message));
      } catch {
        this.#logger.error?.('[dsh-dingtalk] failed to send the safe error reply');
      }
    } finally {
      await this.#cancelPendingInteraction(key);
      await this.#approvals.closeRoute(key);
    }
  }

  async #processInteractionReply(message, messageId, sender, key, expected) {
    this.#signal?.throwIfAborted();
    const current = this.#pendingInteractions.get(key);
    const claimed = expected.claimedReplyMessageId === messageId;
    if (!current || current !== expected || current.submitting) {
      if (claimed && (!current || current !== expected)) {
        return this.#discardResolvedInteractionReply(message, messageId);
      }
      return this.#enqueueMessage(message, messageId, sender, key, { releaseMessageId: false });
    }
    if (this.#state.hasSeen(messageId)) return;
    await this.#state.markSeen(messageId);
    increment(this.#status, 'messagesReceived');
    this.#status.lastMessageAt = new Date().toISOString();

    if (String(message.conversationType) === '2' && message.isInAtList !== true) {
      increment(this.#status, 'messagesIgnored');
      return;
    }

    let sessionWebhook;
    try {
      sessionWebhook = normalizeDingtalkSessionWebhook(message.sessionWebhook);
    } catch {
      increment(this.#status, 'messagesRejected');
      this.#status.lastRejectedAt = new Date().toISOString();
      this.#status.lastError = t('钉钉消息没有安全的回复地址。');
      return;
    }

    const text = message?.msgtype === 'text' ? nonEmptyString(message?.text?.content) : null;
    if (!text) {
      try {
        await this.#send(sessionWebhook, t('请用文字回答当前问题。'), this.#atUsersFor(message));
      } catch {
        this.#logger.error?.('[dsh-dingtalk] failed to reject a non-text interaction reply');
      }
      return;
    }

    const pending = this.#pendingInteractions.get(key);
    if (!pending || pending !== expected || pending.submitting) {
      if (claimed && (!pending || pending !== expected)) {
        try {
          await this.#send(sessionWebhook, t(INTERACTION_RESOLVED_TEXT), this.#atUsersFor(message));
        } catch {
          this.#logger.error?.('[dsh-dingtalk] failed to send an expired interaction notice');
        }
        return;
      }
      return this.#enqueueMessage(message, messageId, sender, key, {
        releaseMessageId: false,
        alreadyRecorded: true,
      });
    }
    pending.sessionWebhook = sessionWebhook;
    if (pending.needsPresentation) {
      try {
        await this.#presentInteraction(pending);
      } catch {
        this.#status.lastError = t('钉钉交互问题发送失败。');
        this.#logger.error?.('[dsh-dingtalk] failed to retry an interaction question');
        pending.interaction.reconnect?.();
      }
      return;
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
        this.#status.lastError = t('钉钉交互问题发送失败。');
        this.#logger.error?.('[dsh-dingtalk] failed to send the next interaction question');
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
      if (this.#pendingInteractions.get(key) !== pending) return;
      if (error?.code === 'interaction-not-pending') {
        this.#clearPendingInteraction(key, pending.interactionId);
        try {
          await this.#send(sessionWebhook, t(INTERACTION_RESOLVED_TEXT), this.#atUsersFor(message));
        } catch {
          this.#logger.error?.('[dsh-dingtalk] failed to send an expired interaction notice');
        }
        return;
      }
      pending.submitting = false;
      pending.answers.pop();
      pending.index -= 1;
      this.#status.lastError = t('回答提交失败。');
      this.#logger.error?.('[dsh-dingtalk] failed to answer a Harness interaction');
      try {
        await this.#send(sessionWebhook, t('回答提交失败，请重新发送当前问题的答案。'), this.#atUsersFor(message));
      } catch {
        this.#logger.error?.('[dsh-dingtalk] failed to send an interaction retry notice');
      }
    }
  }

  async #handleInteraction(interaction, {
    key,
    actor,
    sessionWebhook,
    requiresMention,
  }) {
    if (await this.#approvals.handleRequested(interaction, {
      key,
      actor,
      requiresMention,
      send: (text) => this.#send(sessionWebhook, text, this.#atUsersForActor(actor, requiresMention)),
    })) return;

    // Approval requests return above; the existing question state machine stays unchanged.
    if (interaction?.kind !== 'question') return;
    const questions = interaction?.payload?.questions;
    const interactionId = typeof interaction?.interactionId === 'string'
      ? interaction.interactionId
      : interaction?.rpcId;
    if (typeof interaction.rpcId !== 'string'
      || typeof interactionId !== 'string'
      || typeof interaction.sessionId !== 'string'
      || !Array.isArray(questions)
      || questions.length === 0
      || questions.some((question) => !validHarnessQuestion(question))) {
      this.#logger.warn?.('[dsh-dingtalk] ignored an invalid Harness question interaction');
      return;
    }

    if (interaction.recovered === true) {
      await interaction.respond({
        ok: false,
        error: {
          code: 'cancelled',
          message: 'DingTalk safely cancelled an interaction left by an earlier client.',
          details: {},
        },
      });
      try {
        await this.#send(sessionWebhook, t('检测到这个 Session 中遗留的待回答问题，已安全取消并继续处理你刚才的消息。'), this.#atUsersForActor(actor, requiresMention));
      } catch {
        this.#logger.error?.('[dsh-dingtalk] failed to send an interaction recovery notice');
      }
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
      this.#logger.warn?.('[dsh-dingtalk] cancelled a second pending Harness question');
      await interaction.respond({
        ok: false,
        error: {
          code: 'cancelled',
          message: 'DingTalk is already handling another user interaction.',
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
      sessionWebhook,
      queue: null,
      claimedReplyMessageId: null,
      submitting: false,
      needsPresentation: true,
    };
    this.#pendingInteractions.set(key, pending);
    this.#interactionKeys.set(pending.interactionId, key);
    await this.#presentInteraction(pending);
  }

  async #handleInteractionResolved(resolution) {
    if (await this.#approvals.handleResolved(resolution)) return;
    const interactionId = resolution?.interactionId;
    if (resolution?.kind !== 'question' || typeof interactionId !== 'string') return;
    const key = this.#interactionKeys.get(interactionId);
    if (!key) return;
    this.#clearPendingInteraction(key, interactionId);
  }

  async #presentInteraction(pending) {
    const question = pending.questions[pending.index];
    if (!question) return;
    await this.#send(
      pending.sessionWebhook,
      harnessQuestionText(
        question,
        pending.index,
        pending.questions.length,
        { requiresMention: pending.requiresMention },
      ),
      this.#atUsersForActor(pending.actor, pending.requiresMention),
    );
    pending.needsPresentation = false;
  }

  async #discardResolvedInteractionReply(message, messageId) {
    if (this.#state.hasSeen(messageId)) return;
    await this.#state.markSeen(messageId);
    increment(this.#status, 'messagesReceived');
    this.#status.lastMessageAt = new Date().toISOString();
    let sessionWebhook;
    try {
      sessionWebhook = normalizeDingtalkSessionWebhook(message.sessionWebhook);
    } catch {
      increment(this.#status, 'messagesRejected');
      this.#status.lastRejectedAt = new Date().toISOString();
      return;
    }
    try {
      await this.#send(sessionWebhook, t(INTERACTION_RESOLVED_TEXT), this.#atUsersFor(message));
    } catch {
      this.#logger.error?.('[dsh-dingtalk] failed to send an expired interaction notice');
    }
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
          message: 'The DingTalk interaction ended before the user answered.',
          details: {},
        },
      }, { signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      if (error?.code !== 'interaction-not-pending') {
        this.#logger.warn?.('[dsh-dingtalk] failed to cancel a pending Harness interaction');
      }
    }
  }

  #refreshPendingSenders() {
    if (typeof this.#state.pendingSenders === 'function') {
      this.#status.pendingSenders = this.#state.pendingSenders();
    }
  }

  // 群聊回复时真@发起人（企业内部机器人 userid=staffId）；单聊/魔法棒无需 @。
  // 为什么：用户 @机器人 提问后，机器人回复若不真@本人，用户收不到红点提醒；
  // 群内多人在线时，必须把回复明确指给发起者。@ 目标用 senderStaffId（= userid）。
  #atUsersFor(message) {
    const sender = senderStaffId(message);
    return String(message?.conversationType) === '2' && sender
      ? { atUserIds: [sender] }
      : undefined;
  }

  // 交互/审批场景：按发起人与会话类型决定是否真@。
  // 为什么单独一个：这类回复的指涉对象是“被询问的发起人/被审批人”，不是本条消息的
  // 发送者；requiresMention 表示当前会话是否为群聊（群聊必须真@才能通知到人，单聊天然直达）。
  #atUsersForActor(actor, requiresMention) {
    return requiresMention && nonEmptyString(actor)
      ? { atUserIds: [actor] }
      : undefined;
  }

  // 所有文本回复出口统一走 #send。at 为可选 @ 目标（如 { atUserIds: [...] }）。
  // 降级策略（fail-open）：钉钉服务端对带 at 消息体的兼容性未获官方正式确认，
  // 若被拒则去掉 at 重发一次，保证群回复永不中断；仅当本轮确实带了 at 才降级。
  async #send(sessionWebhook, text, at) {
    const providerMessageIds = [];
    for (const chunk of splitDingtalkText(text, this.#maxMessageChars)) {
      this.#signal?.throwIfAborted();
      try {
        const result = await this.#api.sendText({
          clientId: this.#clientId,
          clientSecret: this.#clientSecret,
          sessionWebhook,
          text: chunk,
          at,
          signal: this.#signal,
        });
        providerMessageIds.push(...providerMessageIdsFor(result));
      } catch (error) {
        // 若服务端拒绝带 at 的消息体（兼容性未定），降级为普通文本回复，保证群回复不中断。
        if (!at) throw error;
        this.#logger.warn?.('[dsh-dingtalk] reply with @ was rejected, falling back to plain text');
        const result = await this.#api.sendText({
          clientId: this.#clientId,
          clientSecret: this.#clientSecret,
          sessionWebhook,
          text: chunk,
          signal: this.#signal,
        });
        providerMessageIds.push(...providerMessageIdsFor(result));
      }
    }
    return providerMessageIds;
  }

  async #deliverArtifacts(target, sessionWebhook, replyTo, artifacts, baseReceipt) {
    const sendArtifact = async (method, file) => dingtalkFileProviderIds(
      await this.#api[method]({
        clientId: this.#clientId,
        clientSecret: this.#clientSecret,
        target,
        file,
        signal: this.#signal,
      }),
    );
    const delivery = await deliverOutboundArtifacts({
      artifacts,
      baseReceipt,
      deliveryId: replyTo,
      aggregatePresentation: baseReceipt ? 'dingtalk-text-and-files' : 'dingtalk-files',
      channelKey: 'dingtalk',
      signal: this.#signal,
      sendImage: typeof this.#api.sendImage === 'function'
        ? (file) => sendArtifact('sendImage', file)
        : undefined,
      sendFile: typeof this.#api.sendFile === 'function'
        ? (file) => sendArtifact('sendFile', file)
        : undefined,
      sendFailureNotice: (artifact, error) => this.#send(
        sessionWebhook,
        artifactFailureText(artifact?.fileName, error),
      ),
      logger: this.#logger,
    });
    this.#status.artifactsSent = (this.#status.artifactsSent ?? 0)
      + delivery.artifactsSent;
    this.#status.artifactSendErrors = (this.#status.artifactSendErrors ?? 0)
      + delivery.artifactSendErrors;
    return { receipt: delivery.receipt, userVisible: delivery.userVisible };
  }
}

export const DingTalkHarnessBridge = DingtalkHarnessBridge;
export const createDingTalkBridgeStatus = createDingtalkBridgeStatus;
