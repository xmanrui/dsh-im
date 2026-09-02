import QRCode from 'qrcode';
import {
  conversationKey,
  extractInboundMessage,
  extractText,
  isAllowedSender,
  isBotSender,
  splitText,
} from './message-utils.mjs';
import {
  hasInboundImages,
  imagePromptDiagnostic,
  imagePromptUserMessage,
} from '../shared/image-prompt.mjs';
import {
  hasReplyReference,
  promptContentForInboundMessage,
} from '../shared/semantic/reply-reference.mjs';
import {
  hasInboundFiles,
  inboundFileUserMessage,
} from '../shared/inbound-file.mjs';
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
import { rememberConnectionTestTarget } from '../shared/connection-test.mjs';
import {
  isModelCommand,
  runModelCommand,
} from '../shared/model-command.mjs';
import {
  isPresetCommand,
  runPresetCommand,
} from '../shared/preset-command.mjs';
import {
  parseSessionListArgument,
  resolveSessionListWorkspace,
  runWorkspaceCommand,
  workspacePathSnapshot,
} from '../shared/workspace-command.mjs';
import { askInWorkspaceSession } from '../shared/workspace-session.mjs';
import { captureContextEnhancement, enhanceContextContent } from '../shared/context-enhancement.mjs';
import { deliverOutboundArtifacts } from '../shared/semantic/artifact-delivery.mjs';
import {
  createDeliveryReceipt,
  providerMessageIdsFor,
} from '../shared/semantic/delivery.mjs';
import {
  channelDeliveryFailure,
  clearLastMessageFailure,
  messageFailureText,
  setLastMessageFailure,
} from '../shared/message-failure.mjs';
import { beginStatusReaction } from '../shared/status-reaction.mjs';
import {
  COMMAND_PERMISSION_DENIED_MESSAGE,
  evaluateInboundAccess,
} from '../shared/inbound-access.mjs';
import { isSharedLocalCommand } from '../shared/command-permission.mjs';
import {
  MENU_PAGE_SIZE,
  PRESET_FOLLOW_DEFAULT_SENTINEL,
  STEER_CUSTOM_SENTINEL,
  completionCard,
  customSteerCard,
  helpCard,
  menuCard,
  menuHelpText,
  modelCard,
  presetCard,
  sessionListCard,
  statusCard,
  steerCard,
  watchListCard,
  workspaceListCard,
} from './feishu-cards.mjs';
import { t } from '../shared/i18n.mjs';
import { MAX_WATCHES_PER_KEY } from './state-store.mjs';
import {
  FEISHU_GROUP_RESPONSE_MODES,
  normalizeFeishuGroupResponseMode,
} from './group-response-mode.mjs';

// Lazily evaluated: t() must run after setImHostLanguage, not at import time.
const INTERACTION_RESOLVED_TEXT = () => t('这个问题已在其他客户端处理，无需再次回答。');
const RESOLVED_REPLY_TTL_MS = 30 * 60_000;

const MENU_COMMAND = /^\/m(?:enu)?$/i;
const REPAIR_COMMAND_PREFIX = /^\/repair(?:\s|$)/i;
const REPAIR_COMMAND = /^\/repair(?:\s+(qr|status|cancel|verify))?\s*$/i;
const WATCH_COMMAND = /^\/watch(?:\s+([^\s]+))?$/i;
const UNWATCH_COMMAND = /^\/unwatch(?:\s+([^\s]+))?$/i;
const WATCHLIST_COMMAND = /^\/watchlist$/i;
const SESSION_LIST_PREFIX = /^\/(?:sessionlist|sessions)(?:\s|$)/i;
const WORKSPACE_LIST_COMMAND = /^\/workspacelist$/i;
const NUMBER_REPLY = /^\d{1,2}$/;
/** A displayed menu stays number-tappable for this long. */
const MENU_TTL_MS = 10 * 60_000;
const MAX_TRACKED_MENUS = 50;
/** Bound callback work per conversation so retries cannot exhaust Host RPCs. */
const MAX_PENDING_CARD_ACTIONS_PER_KEY = 8;
/** Bound actual stop/steer submissions independently from ordinary card UI work. */
const MAX_PENDING_CARD_CONTROLS_PER_KEY = 8;
/** Provider retries may arrive after the original callback has already settled. */
const CARD_ACTION_DEDUPE_TTL_MS = 10 * 60_000;
const MAX_COMPLETED_CARD_ACTIONS = 400;
/** Keep pre-persistence completion arrivals long enough for a new watch to baseline. */
const COMPLETION_OBSERVATION_TTL_MS = 10 * 60_000;
const MAX_OBSERVED_COMPLETION_SESSIONS = 100;
const MAX_OBSERVED_COMPLETIONS_PER_SESSION = 50;
const MAX_OBSERVED_COMPLETIONS = 500;
/** Collapse callback-flood notices instead of amplifying overload into more API calls. */
const CARD_OVERLOAD_NOTICE_COOLDOWN_MS = 5_000;
/** Cards should degrade promptly when one optional Host data source is slow. */
const CARD_DATA_TIMEOUT_MS = 5_000;
const REPAIR_LINK_WAIT_MS = 15_000;
const REPAIR_POLL_INTERVAL_MS = 1_000;
const REPAIR_AUTHORIZATION_STATES = new Set([
  'starting', 'qr_ready', 'polling', 'slow_down', 'domain_switched',
]);
const REPAIR_ACTIVE_STATES = new Set([...REPAIR_AUTHORIZATION_STATES, 'saving']);
const REPAIR_TERMINAL_STATES = new Set([
  'succeeded', 'expired', 'cancelled', 'error',
]);
const REPAIR_URL_HOSTS = new Set([
  'accounts.feishu.cn',
  'open.feishu.cn',
  'accounts.larksuite.com',
  'open.larksuite.com',
]);

const ARCHIVED_COMMAND = /^\/archived(?:\s+(on|off))?$/i;
/** Matches fast card commands that should not be queued behind a running task. */
const CARD_COMMAND = /^\/(?:m(?:enu)?|new|help|status|compact|(?:sessionlist|sessions)(?:\s|$)|workspacelist|watchlist|archived(?:\s+(on|off))?)$/i;

function isFeishuLocalCommand(text, { hasImages = false, hasFiles = false } = {}) {
  if (hasImages || hasFiles || typeof text !== 'string') return false;
  const command = text.trim();
  return MENU_COMMAND.test(command)
    || REPAIR_COMMAND_PREFIX.test(command)
    || WATCH_COMMAND.test(command)
    || UNWATCH_COMMAND.test(command)
    || WATCHLIST_COMMAND.test(command)
    || ARCHIVED_COMMAND.test(command);
}

/** Canonical workspace/session help advertised by every bridge family. */
const WORKSPACE_HELP_LINES = [
  '/workspace 工作区序号或绝对路径  切换工作区',
  '/session Session ID 或当前工作区序号  将当前聊天绑定到指定会话',
  '/workspacelist  列出工作区绝对路径',
  '/sessionlist 或 /sessions [工作区序号或绝对路径]  列出会话 ID 和标题',
  '/sessionlist --limit N  仅列出当前工作区前 N 个会话',
];

/** Safe user-facing text for bind/workspace failures (no raw messages). */
function safeErrorText(error) {
  switch (error?.code) {
    case 'workspace-not-absolute':
      return t('工作区必须是绝对路径。');
    case 'workspace-not-found':
      return t('工作区路径不存在。');
    case 'workspace-not-directory':
      return t('工作区路径必须指向一个目录。');
    case 'workspace-bot-not-found':
      return t('机器人正在移除或已重新接入，无法操作原会话的工作区。');
    default:
      return t('操作失败，请稍后重试。');
  }
}

function artifactFailureText(fileName, error) {
  const name = String(fileName ?? t('结果文件')).replace(/[\r\n]+/g, ' ').trim() || t('结果文件');
  switch (error?.code) {
    case 'artifact-permission-required':
      return t('结果文件「{name}」已生成，但机器人缺少飞书文件上传权限 im:resource。请私聊机器人执行 /repair 命令，或者在「IM机器人」设置页点击“补全权限”按钮并扫码。完成飞书要求的发布审批后重试。', { name });
    case 'artifact-too-large':
      return t('结果文件「{name}」超过飞书 30 MB 上限，未发送。', { name });
    case 'artifact-empty':
      return t('结果文件「{name}」为空，飞书不允许发送空文件。', { name });
    case 'artifact-changed':
    case 'artifact-invalid':
    case 'artifact-unavailable':
      return t('结果文件「{name}」暂时无法读取或准备发送，请确认文件仍可访问后重试。', { name });
    case 'artifact-rate-limited':
      return t('结果文件「{name}」暂时被飞书限流，未能发送，请稍后重试。', { name });
    case 'artifact-delivery-uncertain':
      return t('结果文件「{name}」发送结果未能确认，请先检查聊天内是否已收到，不要立即重试。', { name });
    default:
      return t('结果文件「{name}」已生成，但暂时未能发送，请稍后重试。', { name });
  }
}

function answerTextForDelivery(answer, artifacts) {
  if (typeof answer === 'string' && answer.trim()) return answer;
  return artifacts.length > 0 ? t('结果文件已生成。') : answer;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Accept SDK payload fields that may already be objects or JSON strings. */
function callbackObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Normalize a single-select value without corrupting valid commas in an id/path. */
function callbackSingleOption(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const selected = callbackSingleOption(entry);
      if (selected !== null) return selected;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    if ('value' in value) return callbackSingleOption(value.value);
    if ('option' in value) return callbackSingleOption(value.option);
    return null;
  }
  if (typeof value !== 'string') return null;
  const source = value.trim();
  if (!source) return null;
  if (source.startsWith('[') || source.startsWith('{') || source.startsWith('"')) {
    try {
      const parsed = JSON.parse(source);
      if (parsed !== value) return callbackSingleOption(parsed);
    } catch { /* plain value below */ }
  }
  return source;
}

/** Normalize multi-select values across current and legacy SDK shapes. */
function callbackMultiOptionValues(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((entry) => callbackMultiOptionValues(entry));
  if (value && typeof value === 'object') {
    if ('value' in value) return callbackMultiOptionValues(value.value);
    if ('option' in value) return callbackMultiOptionValues(value.option);
    return [];
  }
  if (typeof value !== 'string') return [];
  const source = value.trim();
  if (!source) return [];
  if (source.startsWith('[') || source.startsWith('{') || source.startsWith('"')) {
    try {
      const parsed = JSON.parse(source);
      if (parsed !== value) return callbackMultiOptionValues(parsed);
    } catch { /* plain value below */ }
  }
  return source.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function validLastSeq(value) {
  return Number.isSafeInteger(value) && value >= -1;
}

function validEventSeq(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function watchBoundary(entry) {
  return Number.isSafeInteger(entry?.watchStartedAt) && entry.watchStartedAt >= 0
    ? entry.watchStartedAt
    : null;
}

function watchNeedsBaseline(entry) {
  return entry && (watchBoundary(entry) !== null || !validLastSeq(entry.lastSeq));
}

function orderedHistoryEvents(history) {
  return (Array.isArray(history?.events) ? history.events : [])
    .map((entry) => entry?.event ?? entry)
    .filter((entry) => entry && typeof entry === 'object' && validEventSeq(entry.seq))
    .sort((left, right) => left.seq - right.seq);
}

function senderOpenId(event) {
  return nonEmptyString(event?.sender?.sender_id?.open_id)
    ?? nonEmptyString(event?.sender?.sender_id?.user_id);
}

function strictSenderOpenId(event) {
  return nonEmptyString(event?.sender?.sender_id?.open_id);
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(done, milliseconds);
    timer.unref?.();
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function repairSnapshot(value, { botId } = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const registration = source.registration && typeof source.registration === 'object'
    ? source.registration
    : source;
  const operation = nonEmptyString(registration.operation) ?? nonEmptyString(source.operation);
  if (operation && operation !== 'callback_repair') {
    throw new Error('The active Feishu operation is not a callback repair');
  }
  const selectedBotId = nonEmptyString(registration.botId) ?? nonEmptyString(source.botId);
  if (botId && selectedBotId && selectedBotId !== botId) {
    throw new Error('The Feishu repair belongs to another bot');
  }
  const state = nonEmptyString(registration.state);
  const attempt = registration.attemptId ?? registration.attempt;
  const attemptId = typeof attempt === 'string' || Number.isFinite(attempt)
    ? String(attempt)
    : null;
  if (!state || !attemptId) throw new Error('Feishu returned an invalid repair status');
  const verificationUrl = nonEmptyString(registration.verificationUrl)
    ?? nonEmptyString(registration.qrCodeUrl);
  const expiresAt = Number(registration.expiresAt);
  const remainingSeconds = Number(registration.remainingSeconds);
  const pollIntervalMs = Number(registration.pollIntervalMs)
    || (Number(registration.pollIntervalSeconds) * 1000);
  return {
    state,
    attemptId,
    botId: selectedBotId,
    verificationUrl,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    remainingSeconds: Number.isFinite(remainingSeconds) ? remainingSeconds : null,
    pollIntervalMs: Number.isFinite(pollIntervalMs) && pollIntervalMs > 0
      ? pollIntervalMs
      : null,
    error: registration.error && typeof registration.error === 'object'
      ? { code: nonEmptyString(registration.error.code), message: nonEmptyString(registration.error.message) }
      : null,
  };
}

function safeRepairUrl(rawUrl, expectedAppId) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || !REPAIR_URL_HOSTS.has(url.hostname)) {
    throw new Error('Feishu returned an untrusted repair URL');
  }
  if (url.searchParams.get('tp') !== 'sdk'
    || url.searchParams.get('clientID') !== expectedAppId
    || url.searchParams.has('createOnly')) {
    throw new Error('Feishu returned an invalid existing-app repair URL');
  }
  if (url.toString().includes('{{client_id}}') || url.toString().includes('%7B%7Bclient_id%7D%7D')) {
    throw new Error('Feishu returned an unresolved client id placeholder');
  }
  return url.toString();
}

function canClaimInteractionReply(event, pending) {
  return pending.needsPresentation !== true
    && pending.questions[pending.index]
    && senderOpenId(event) === pending.actor
    && event?.message?.message_type === 'text'
    && nonEmptyString(extractText(event));
}

function ensureStatus(status) {
  for (const key of ['messagesReceived', 'messagesReplied', 'messagesRejected']) {
    status[key] ??= 0;
  }
  status.lastMessageAt ??= null;
  status.lastReplyAt ??= null;
  status.lastRejectedAt ??= null;
  status.lastError ??= null;
  status.lastMessageError ??= null;
}

export class FeishuHarnessBridge {
  #client;
  #channel;
  #harness;
  #state;
  #contextEnhancement;
  #accessPolicy;
  #queues = new Map();
  #batchInputs = new BatchInputManager();
  #pendingInteractions = new Map();
  #interactionKeys = new Map();
  #resolvedQuestionReplies = new Map();
  // Keep the accepted configuration through the existing queue/reply lifecycle.
  #acceptedMessageIds = new Map();
  #interactionTasks = new Set();
  #commandTasks = new Set();
  /** All accepted card work, including tasks waiting behind an earlier click. */
  #cardActionTasks = new Set();
  /** Per-conversation navigation/configuration serialization tails. */
  #cardActionTails = new Map();
  /** Per-conversation serialization for actual stop/steer side effects. */
  #cardControlTails = new Map();
  /** Pending callback count per conversation, used for bounded backpressure. */
  #cardActionCounts = new Map();
  /** Pending control count per conversation, isolated from ordinary UI work. */
  #cardControlCounts = new Map();
  /** Same callback retry joins the original task instead of repeating side effects. */
  #cardActionInFlight = new Map();
  /** Stop is idempotent per conversation; coalesce floods while one stop is pending. */
  #cardStopInFlight = new Map();
  /** Stable ids coalesced into a stop move to the completed cache when it settles. */
  #cardStopFollowers = new Map();
  /** Settled provider event ids stay deduplicated for a bounded retry window. */
  #completedCardActions = new Map();
  /** Last overload notice time per conversation. */
  #cardOverloadNoticeAt = new Map();
  #approvals;
  #status;
  #allowedSenderOpenIds;
  #replyTimeoutMs;
  #logger;
  #signal;
  #botId;
  #appId;
  #botOpenId;
  #groupResponseMode;
  #repair;
  #repairAttempt = null;
  #repairMonitorVersion = 0;
  #repairPollIntervalMs;
  #repairLinkWaitMs;
  /** Number-tappable menus: conversation key → menu state. */
  #menus = new Map();
  /** Interactive-card message id → route context for button callbacks. */
  #cardKeys = new Map();
  /** The global event-mux watcher (one per bridge). */
  #eventWatcher = null;
  /** Serializes completion work per session without blocking unrelated sessions. */
  #eventTails = new Map();
  /** Coalesces baseline compensation and records whether a trailing pass is needed. */
  #pendingCompensations = new Map();
  /** Bounded live arrivals bridge target-list, persistence, and history-projection races. */
  #observedCompletionEvents = new Map();
  /** Earliest completion that still needs delivery for each watch. */
  #failedWatchSeqs = new Map();
  #cardDataTimeoutMs;

  constructor({
    client,
    channel,
    harness,
    state,
    contextEnhancement,
    accessPolicy,
    status,
    allowedSenderOpenIds = new Set(),
    botId,
    appId,
    botOpenId,
    groupResponseMode = FEISHU_GROUP_RESPONSE_MODES.ALL,
    repair,
    repairPollIntervalMs = REPAIR_POLL_INTERVAL_MS,
    repairLinkWaitMs = REPAIR_LINK_WAIT_MS,
    cardDataTimeoutMs = CARD_DATA_TIMEOUT_MS,
    replyTimeoutMs = 600_000,
    logger = console,
    signal,
  }) {
    if (!client || !harness || !state || !status) {
      throw new TypeError('Feishu bridge dependencies are required');
    }
    if (repair !== undefined && repair !== null) {
      if (!repair || typeof repair.start !== 'function'
        || typeof repair.status !== 'function'
        || typeof repair.cancel !== 'function') {
        throw new TypeError('Feishu repair capability requires start/status/cancel');
      }
      if (!nonEmptyString(botId) || !nonEmptyString(appId)) {
        throw new TypeError('Feishu repair capability requires botId and appId');
      }
    }
    if (!Number.isFinite(repairPollIntervalMs) || repairPollIntervalMs <= 0
      || !Number.isFinite(repairLinkWaitMs) || repairLinkWaitMs <= 0
      || !Number.isFinite(cardDataTimeoutMs) || cardDataTimeoutMs <= 0) {
      throw new TypeError('Feishu timing values must be positive numbers');
    }
    this.#client = client;
    this.#channel = channel;
    this.#harness = harness;
    this.#state = state;
    this.#contextEnhancement = contextEnhancement;
    this.#accessPolicy = accessPolicy;
    this.#status = status;
    this.#allowedSenderOpenIds = allowedSenderOpenIds;
    this.#botId = nonEmptyString(botId);
    this.#appId = nonEmptyString(appId);
    this.#botOpenId = nonEmptyString(botOpenId);
    this.#groupResponseMode = normalizeFeishuGroupResponseMode(groupResponseMode);
    this.#repair = repair ?? null;
    this.#repairPollIntervalMs = repairPollIntervalMs;
    this.#repairLinkWaitMs = repairLinkWaitMs;
    this.#cardDataTimeoutMs = cardDataTimeoutMs;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#logger = logger;
    this.#approvals = new HarnessApprovalQueue({ label: 'Feishu', logger });
    this.#signal = signal;
    ensureStatus(this.#status);
    // Persisted watches must resume at runtime start, not on the first
    // message. Older hosts without the mux watcher simply skip this.
    if (typeof this.#harness?.watchHarnessEvents === 'function') {
      queueMicrotask(() => this.#ensureEventWatcher());
    }
  }

  setGroupResponseMode(value) {
    this.#groupResponseMode = normalizeFeishuGroupResponseMode(value);
  }

  #isAddressed(event) {
    if (event?.message?.chat_type === 'p2p') return true;
    const mentions = Array.isArray(event?.message?.mentions) ? event.message.mentions : [];
    if (!this.#botOpenId) return mentions.length > 0;
    return mentions.some((mention) => mention?.id?.open_id === this.#botOpenId
      || mention?.open_id === this.#botOpenId);
  }

  accept(event) {
    if (this.#signal?.aborted) return Promise.resolve();
    const messageId = nonEmptyString(event?.message?.message_id);
    if (!messageId || isBotSender(event)) return Promise.resolve();
    if (!this.#accessPolicy && !isAllowedSender(event, this.#allowedSenderOpenIds)) {
      this.#status.messagesRejected += 1;
      this.#status.lastRejectedAt = new Date().toISOString();
      this.#logger.warn?.('[dsh-feishu] ignored a message from a sender outside the legacy allowlist');
      return Promise.resolve();
    }
    const addressed = this.#isAddressed(event);
    if (event?.message?.chat_type !== 'p2p'
      && this.#groupResponseMode === FEISHU_GROUP_RESPONSE_MODES.MENTION
      && !addressed) {
      return Promise.resolve();
    }
    if (this.#state.hasSeen(messageId) || this.#acceptedMessageIds.has(messageId)) {
      return Promise.resolve();
    }

    let key;
    try {
      key = conversationKey(event);
    } catch {
      this.#status.messagesRejected += 1;
      this.#status.lastRejectedAt = new Date().toISOString();
      return Promise.resolve();
    }

    const commandMessage = extractInboundMessage(event, this.#client);
    const commandText = nonEmptyString(commandMessage.content) ?? '';
    const hasImages = hasInboundImages(commandMessage);
    const hasFiles = hasInboundFiles(commandMessage);
    const conversationType = event.message.chat_type === 'p2p' ? 'direct'
      : event.message.chat_type === 'group' ? 'group' : null;
    const access = evaluateInboundAccess(this.#accessPolicy, {
      conversationType,
      senderIds: senderOpenId(event),
      text: commandText,
      hasImages,
      hasFiles,
      isCommand: isSharedLocalCommand(commandText, {
        hasImages,
        hasFiles,
      }) || isFeishuLocalCommand(commandText, { hasImages, hasFiles })
        || (!hasImages && !hasFiles && NUMBER_REPLY.test(commandText) && this.#menus.has(key)),
    });
    if (!access.allowed) {
      this.#acceptedMessageIds.set(messageId, null);
      return this.#finishAccessDecision(event, messageId, access);
    }
    if (event.message.chat_type === 'p2p') {
      const chatId = nonEmptyString(event.message.chat_id);
      if (chatId) rememberConnectionTestTarget(this.#state, { chatId });
    }

    this.#acceptedMessageIds.set(messageId, captureContextEnhancement(
      this.#contextEnhancement,
      conversationType,
    ));
    const processingReaction = this.#beginReaction(messageId);
    const batchText = event.message.message_type === 'text'
      ? nonEmptyString(extractText(event)) ?? ''
      : '';
    const batchCommand = event.message.message_type === 'text'
      && isBatchInputCommand(batchText);
    const pending = this.#pendingInteractions.get(key);
    const batchStatus = this.#batchInputs.status(key);
    if (batchCommand && event.message.chat_type !== 'p2p') {
      return this.#finishBatchResult(
        event,
        messageId,
        processingReaction,
        { message: batchInputGroupUnsupportedMessage() },
      );
    }
    if (event.message.chat_type === 'p2p'
      && (batchCommand || batchStatus.phase === 'collecting')) {
      const exactBatchStart = /^\/batch$/iu.test(batchText);
      const result = exactBatchStart
        && batchStatus.phase === 'idle'
        && (this.#queues.has(key) || pending || this.#approvals.hasPending(key))
        ? { handled: true, kind: 'busy', message: batchInputBusyMessage() }
        : this.#batchInputs.handle(key, batchText, {
            plainText: event.message.message_type === 'text'
              && Boolean(batchText)
              && !hasReplyReference(commandMessage),
          });
      if (result.handled) {
        if (result.kind === 'submit') {
          const submissionEvent = {
            ...event,
            batchSubmission: { token: result.token },
            message: {
              ...event.message,
              message_type: 'text',
              content: JSON.stringify({ text: result.prompt }),
              mentions: [],
            },
          };
          return this.#enqueueMessage(
            submissionEvent,
            messageId,
            key,
            processingReaction,
          );
        }
        return this.#finishBatchResult(
          event,
          messageId,
          processingReaction,
          result,
        );
      }
    }
    // Card commands (/m, /help, /status, etc.) bypass the queue so they
    // respond immediately even when a harness task is still streaming.
    if (CARD_COMMAND.test(commandText)) {
      const processing = Promise.resolve()
        .then(() => this.#handle(event, key, { alreadyRecorded: false }))
        .then(() => this.#finishReaction(messageId, processingReaction, 'DONE'))
        .catch((error) => this.#handleMessageFailure(
          event,
          messageId,
          processingReaction,
          error,
        ))
        .finally(() => this.#acceptedMessageIds.delete(messageId));
      return processing;
    }
    const commandRunner = isHistoryCommand(commandText) ? runHistoryCommand
      : hasInboundFiles(commandMessage) ? null : isControlCommand(commandText)
      ? runControlCommand
      : (isModelCommand(commandText)
          ? runModelCommand
          : (isPresetCommand(commandText) ? runPresetCommand : null));
    // In all-message group mode, history must still be refused locally rather
    // than becoming a normal prompt when no mention is present.
    if (commandRunner && (addressed || commandRunner === runHistoryCommand)) {
      const processing = this.#processFastCommand(
        event,
        messageId,
        key,
        commandMessage,
        commandRunner,
      );
      let current;
      current = processing
        .then(() => this.#finishReaction(messageId, processingReaction, 'DONE'))
        .catch((error) => this.#handleMessageFailure(
          event,
          messageId,
          processingReaction,
          error,
        ))
        .finally(() => {
          this.#acceptedMessageIds.delete(messageId);
          this.#commandTasks.delete(current);
        });
      this.#commandTasks.add(current);
      return current;
    }
    if (this.#isResolvedQuestionReply(event, key)) {
      const current = Promise.resolve()
        .then(() => this.#discardResolvedInteractionReply(event, messageId))
        .then(() => this.#finishReaction(messageId, processingReaction, 'DONE'))
        .catch((error) => this.#handleMessageFailure(
          event,
          messageId,
          processingReaction,
          error,
        ))
        .finally(() => this.#acceptedMessageIds.delete(messageId));
      return current;
    }
    const approvalReply = this.#approvals.claimReply({
      key,
      actor: senderOpenId(event),
      messageId,
      text: extractText(event) ?? '',
      addressed,
      hasPendingQuestion: Boolean(pending),
      questionCompletion: pending?.submitting || pending?.claimedReplyMessageId
        ? pending.queue
        : null,
      isQuestionPending: () => this.#pendingInteractions.has(key),
      send: (text) => this.#send(event.message.chat_id, text, { replyTo: event.message.message_id }),
    });
    if (approvalReply) {
      const processing = approvalReply.process(async () => {
        if (this.#state.hasSeen(messageId)) return false;
        await this.#state.markSeen(messageId);
        this.#status.lastMessageAt = new Date().toISOString();
        this.#status.messagesReceived += 1;
        return true;
      });
      let current;
      current = processing
        .then(() => this.#finishReaction(messageId, processingReaction, 'DONE'))
        .catch((error) => this.#handleMessageFailure(
          event,
          messageId,
          processingReaction,
          error,
        ))
        .finally(() => {
          this.#acceptedMessageIds.delete(messageId);
          this.#interactionTasks.delete(current);
        });
      this.#interactionTasks.add(current);
      return current;
    }
    if (pending && senderOpenId(event) !== pending.actor) {
      return this.#enqueueMessage(event, messageId, key, processingReaction);
    }
    if (pending?.submitting || pending?.claimedReplyMessageId) {
      return this.#enqueueMessage(event, messageId, key, processingReaction);
    }
    if (pending) {
      if (canClaimInteractionReply(event, pending)) pending.claimedReplyMessageId = messageId;
      const previous = pending.queue ?? Promise.resolve();
      const processing = previous
        .catch(() => undefined)
        .then(() => this.#processInteractionReply(
          event,
          messageId,
          key,
          pending,
          processingReaction,
        ));
      pending.queue = processing;

      const releaseInteraction = () => {
        if (pending.claimedReplyMessageId === messageId) {
          pending.claimedReplyMessageId = null;
        }
        if (pending.queue === processing) pending.queue = null;
      };
      let current;
      current = processing
        .then(
          () => {
            releaseInteraction();
            return this.#finishReaction(messageId, processingReaction, 'DONE');
          },
          (error) => {
            releaseInteraction();
            return this.#handleMessageFailure(
              event,
              messageId,
              processingReaction,
              error,
            );
          },
        )
        .finally(() => {
          releaseInteraction();
          this.#acceptedMessageIds.delete(messageId);
          this.#interactionTasks.delete(current);
        });
      this.#interactionTasks.add(current);
      return current;
    }
    return this.#enqueueMessage(event, messageId, key, processingReaction);
  }

  #finishBatchResult(event, messageId, processingReaction, result) {
    let current;
    current = Promise.resolve()
      .then(async () => {
        if (this.#state.hasSeen(messageId)) return;
        await this.#state.markSeen(messageId);
        this.#status.lastMessageAt = new Date().toISOString();
        this.#status.messagesReceived += 1;
        if (result?.message) await this.#send(event.message.chat_id, result.message, { replyTo: event.message.message_id });
        this.#status.lastError = null;
      })
      .then(() => this.#finishReaction(messageId, processingReaction, 'DONE'))
      .catch((error) => this.#handleMessageFailure(
        event,
        messageId,
        processingReaction,
        error,
      ))
      .finally(() => {
        this.#acceptedMessageIds.delete(messageId);
        this.#commandTasks.delete(current);
      });
    this.#commandTasks.add(current);
    return current;
  }

  #finishAccessDecision(event, messageId, access) {
    let current;
    current = Promise.resolve().then(async () => {
      if (this.#state.hasSeen(messageId)) return;
      await this.#state.markSeen(messageId);
      if (access.reason === 'command-not-allowed') {
        this.#status.lastMessageAt = new Date().toISOString();
        this.#status.messagesReceived += 1;
        await this.#send(
          event.message.chat_id,
          t(COMMAND_PERMISSION_DENIED_MESSAGE),
          { replyTo: event.message.message_id },
        );
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
      this.#logger.warn?.('[dsh-feishu] failed to apply inbound access policy');
    }).finally(() => {
      this.#acceptedMessageIds.delete(messageId);
      this.#commandTasks.delete(current);
    });
    this.#commandTasks.add(current);
    return current;
  }

  #enqueueMessage(event, messageId, key, processingReaction, {
    releaseMessageId = true,
    alreadyRecorded = false,
    finalize = true,
  } = {}) {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const work = previous
      .catch(() => undefined)
      .then(() => this.#handle(event, key, { alreadyRecorded }));
    const settled = finalize
      ? work
        .then(async (receipt) => {
          await this.#finishReaction(messageId, processingReaction, 'DONE');
          return receipt;
        })
        .catch((error) => this.#handleMessageFailure(
          event,
          messageId,
          processingReaction,
          error,
        ))
      : work;
    let current;
    current = settled.finally(() => {
      if (releaseMessageId) this.#acceptedMessageIds.delete(messageId);
      if (this.#queues.get(key) === current) this.#queues.delete(key);
    });
    this.#queues.set(key, current);
    return current;
  }

  #recordFailure(error, {
    logLabel = 'operation',
    logLevel = 'warn',
    userMessage,
    reason,
  } = {}) {
    this.#status.lastError = error?.message ?? String(error);
    const failure = setLastMessageFailure(this.#status, error, { userMessage, reason });
    this.#logger?.[logLevel]?.(
      `[dsh-feishu] ${logLabel} failed [${failure.referenceId}]:`,
      error?.message ?? String(error),
    );
    return failure;
  }

  async #sendFailure(chatId, error, options = {}) {
    const failure = this.#recordFailure(error, options);
    const text = options.appendMessage
      ? `${messageFailureText(failure)}\n\n${options.appendMessage}`
      : messageFailureText(failure);
    await this.#send(chatId, text, { replyTo: options.replyTo }).catch(() => undefined);
    return failure;
  }

  async #handleMessageFailure(event, messageId, processingReaction, error) {
    if (error?.code === 'turn-stopped') {
      await this.#removeProcessingReaction(messageId, processingReaction);
      if (error?.batchInputMessage) {
        await this.#send(event.message.chat_id, error.batchInputMessage, { replyTo: event.message.message_id }).catch(() => undefined);
      }
      return;
    }
    if (this.#signal?.aborted) {
      await this.#removeProcessingReaction(messageId, processingReaction);
      return;
    }
    const userMessage = inboundFileUserMessage(error)
      ?? imagePromptUserMessage(error);
    const failure = this.#recordFailure(error, {
      logLabel: 'message handling',
      logLevel: 'error',
      userMessage,
      reason: imagePromptDiagnostic(error)?.reason,
    });
    await this.#finishReaction(messageId, processingReaction, 'ERROR');
    const failureText = error?.batchInputMessage
      ? `${messageFailureText(failure)}\n\n${error.batchInputMessage}`
      : messageFailureText(failure);
    await this.#send(
      event.message.chat_id,
      failureText,
      { replyTo: event.message.message_id },
    ).catch(() => undefined);
  }

  async waitForIdle() {
    // Drain to a fixed point: awaited work can register compensation or
    // another serialized tail before it settles.
    for (;;) {
      const tasks = [
        ...this.#queues.values(),
        ...[...this.#pendingInteractions.values()].flatMap((pending) => (
          pending.queue ? [pending.queue] : []
        )),
        ...this.#interactionTasks,
        ...this.#commandTasks,
        ...this.#cardActionTasks,
        ...this.#eventTails.values(),
        ...[...this.#pendingCompensations.values()].map((pending) => pending.promise),
      ];
      if (tasks.length === 0) return;
      await Promise.allSettled(tasks);
      if (this.#queues.size === 0
        && this.#interactionTasks.size === 0
        && this.#commandTasks.size === 0
        && this.#cardActionTasks.size === 0
        && this.#eventTails.size === 0
        && this.#pendingCompensations.size === 0
        && ![...this.#pendingInteractions.values()].some((pending) => pending.queue)) return;
    }
  }

  #cardDataSignal() {
    const timeout = AbortSignal.timeout(this.#cardDataTimeoutMs);
    return this.#signal ? AbortSignal.any([this.#signal, timeout]) : timeout;
  }

  #hasPendingInteraction(key) {
    return this.#pendingInteractions.has(key) || this.#approvals.hasPending(key);
  }

  async #processFastCommand(event, messageId, key, message, runner) {
    this.#signal?.throwIfAborted();
    if (this.#state.hasSeen(messageId)) return;
    await this.#state.markSeen(messageId);
    this.#status.lastMessageAt = new Date().toISOString();
    this.#status.messagesReceived += 1;
    const result = await runner(
      nonEmptyString(message.content) ?? '',
      this.#harness,
      this.#state,
      key,
      {
        signal: this.#signal,
        isDirect: event.message.chat_type === 'p2p',
        hasImages: hasInboundImages(message),
        hasFiles: hasInboundFiles(message),
        pendingInteraction: this.#hasPendingInteraction(key),
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
      if (reply) await this.#send(event.message.chat_id, reply, { replyTo: event.message.message_id });
    }
    this.#status.lastError = null;
  }

  async #handle(event, key, { alreadyRecorded = false } = {}) {
    this.#signal?.throwIfAborted();
    const messageId = event.message.message_id;
    if (!alreadyRecorded) {
      if (this.#state.hasSeen(messageId)) return;
      await this.#state.markSeen(messageId);
      this.#status.lastMessageAt = new Date().toISOString();
      this.#status.messagesReceived += 1;
    }

    const message = extractInboundMessage(event, this.#client);
    const text = message.content;
    const hasImages = hasInboundImages(message);
    const hasFiles = hasInboundFiles(message);
    const hasReply = hasReplyReference(message);
    // 命令识别对 text 与纯文本 post 一视同仁：post 富文本若仅含单个
    // 文本段落（如复制粘贴的 /new），同样按命令处理；带图片/文件不认。
    // accept() 侧已用 nonEmptyString(content) 判定，两侧保持一致。
    const commandText = !hasImages && !hasFiles && text ? text.trim() : null;
    if (!text && !hasImages && !hasFiles && !hasReply) {
      await this.#send(event.message.chat_id, t('目前支持文字、图片和文件消息。'), { replyTo: event.message.message_id });
      return;
    }

    if (commandText !== null && REPAIR_COMMAND_PREFIX.test(commandText)) {
      await this.#handleRepairCommand(event, commandText);
      return;
    }
    if (commandText === '/help') {
      await this.#send(event.message.chat_id, menuHelpText(), { replyTo: event.message.message_id });
      return;
    }
    if (MENU_COMMAND.test(commandText)) {
      await this.#sendMenuCard(key, event.message.chat_id, { replyTo: event.message.message_id });
      return;
    }
    if (commandText === '/new') {
      if (this.#queues.has(key) || this.#hasPendingInteraction(key)) {
        await this.#send(
          event.message.chat_id,
          t('当前任务仍在运行，请先停止任务或等待任务完成后再开启新会话。'),
          { replyTo: event.message.message_id },
        );
        return;
      }
      await this.#state.clearSession(key);
      await this.#send(event.message.chat_id, t('已开启全新 Harness 会话。'), { replyTo: event.message.message_id });
      await this.#sendMenuCard(key, event.message.chat_id, { replyTo: event.message.message_id });
      return;
    }
    if (commandText === '/status') {
      await this.#showStatusText(key, event.message.chat_id, event.message.message_id);
      return;
    }
    if (commandText === '/compact') {
      const compactCommand = await runCompactCommand(commandText, this.#harness, this.#state, key, { signal: this.#signal });
      if (compactCommand) {
        await this.#send(event.message.chat_id, compactCommand.message, { replyTo: event.message.message_id });
      }
      return;
    }
    if (SESSION_LIST_PREFIX.test(commandText)) {
      const argument = commandText.replace(/^\/(?:sessionlist|sessions)/i, '').trim();
      const request = parseSessionListArgument(argument);
      if (request.error) {
        await this.#send(event.message.chat_id, request.error, { replyTo: event.message.message_id });
        return;
      }
      await this.#showSessions(
        { chatId: event.message.chat_id, key, replyTo: event.message.message_id },
        request.selector || null,
        0,
        { limit: request.limit },
      );
      return;
    }
    if (WORKSPACE_LIST_COMMAND.test(commandText)) {
      await this.#showWorkspaces({ chatId: event.message.chat_id, key, replyTo: event.message.message_id });
      return;
    }
    if (WATCH_COMMAND.test(commandText)) {
      const target = (WATCH_COMMAND.exec(commandText)?.[1] ?? '').trim() || null;
      await this.#runWatch(key, event.message.chat_id, target, { replyTo: event.message.message_id });
      return;
    }
    if (UNWATCH_COMMAND.test(commandText)) {
      const target = (UNWATCH_COMMAND.exec(commandText)?.[1] ?? '').trim() || null;
      await this.#runUnwatch(key, event.message.chat_id, target, { replyTo: event.message.message_id });
      return;
    }
    if (WATCHLIST_COMMAND.test(commandText)) {
      await this.#showWatchList(key, event.message.chat_id, { replyTo: event.message.message_id });
      return;
    }
    if (ARCHIVED_COMMAND.test(commandText)) {
      const match = ARCHIVED_COMMAND.exec(commandText);
      const value = match[1]?.toLowerCase();
      if (value !== 'on' && value !== 'off') {
        await this.#send(event.message.chat_id, t('用法：/archived on（包含归档会话）或 /archived off（隐藏归档会话）'), { replyTo: event.message.message_id });
        return;
      }
      if (typeof this.#state?.setIncludeArchivedSessions === 'function') {
        await this.#state.setIncludeArchivedSessions(value === 'on');
      }
      await this.#send(
        event.message.chat_id,
        value === 'on' ? t('已开启：会话列表包含归档会话。') : t('已关闭：会话列表隐藏归档会话。'),
        { replyTo: event.message.message_id },
      );
      return;
    }
    if (NUMBER_REPLY.test(commandText)) {
      const menu = this.#takeMenu(key);
      if (menu) {
        await this.#handleMenuPick(menu, Number(commandText), {
          chatId: event.message.chat_id,
          key,
          event,
        });
        return;
      }
    }
    const workspaceCommand = commandText === null
      ? null
      : await runWorkspaceCommand(text, this.#harness, key);
    if (workspaceCommand) {
      for (const reply of workspaceCommand.messages ?? [workspaceCommand.message]) {
        await this.#send(event.message.chat_id, reply, { replyTo: event.message.message_id });
      }
      return;
    }
    const compactCommand = commandText === null
      ? null
      : await runCompactCommand(
          commandText,
          this.#harness,
          this.#state,
          key,
          { signal: this.#signal },
        );
    if (compactCommand) {
      await this.#send(event.message.chat_id, compactCommand.message, { replyTo: event.message.message_id });
      return;
    }

    this.#logger.info?.(`[dsh-feishu] processing ${event.message.chat_type} message ${messageId}`);
    const batchSubmission = event.batchSubmission ?? null;
    let batchAskCompleted = false;
    try {
      const {
        receipt,
        artifactSendErrors,
        textDeliveryErrors = 0,
      } = await this.#answerWithStream(event, key, message, {
        onAskComplete: batchSubmission
          ? () => {
              batchAskCompleted = this.#batchInputs.complete(
                key,
                batchSubmission.token,
              ).completed;
            }
          : undefined,
      });
      this.#status.messagesReplied += 1;
      this.#status.lastReplyAt = new Date().toISOString();
      this.#status.lastError = null;
      if (textDeliveryErrors === 0 && artifactSendErrors === 0) {
        clearLastMessageFailure(this.#status);
      }
      return receipt;
    } catch (error) {
      if (batchSubmission && !batchAskCompleted) {
        if (error?.code === 'turn-stopped') {
          this.#batchInputs.complete(key, batchSubmission.token);
          throw error;
        }
        const failed = this.#batchInputs.fail(key, batchSubmission.token);
        if (failed.retained) {
          const batchError = new Error(error?.message ?? String(error), { cause: error });
          batchError.code = error?.code;
          batchError.providerCode = error?.providerCode;
          batchError.method = error?.method;
          if (Number.isInteger(error?.status)) batchError.status = error.status;
          batchError.batchInputMessage = failed.message;
          throw batchError;
        }
      }
      throw error;
    } finally {
      await this.#cancelPendingInteraction(key);
      await this.#approvals.closeRoute(key);
    }
  }

  // ── Interactive cards: menus and session/workspace lists ────────────────

  // Existing-app callback repair. This path deliberately uses ordinary text
  // and number replies because callback buttons are the capability being fixed.
  async #handleRepairCommand(event, commandText) {
    if (event?.message?.chat_type !== 'p2p') {
      await this.#send(event.message.chat_id, t('为避免授权链接暴露，请私聊机器人发送 /repair。'));
      return;
    }
    const actorOpenId = strictSenderOpenId(event);
    if (!actorOpenId) {
      await this.#send(event.message.chat_id, t('无法识别当前发送者，未发起修复。'));
      return;
    }
    if (!this.#repair) {
      await this.#send(event.message.chat_id, t('当前 Host 版本暂不支持聊天内修复，请先更新插件。'));
      return;
    }

    const parsed = REPAIR_COMMAND.exec(commandText);
    if (!parsed) {
      await this.#send(event.message.chat_id, t('用法：/repair、/repair qr、/repair status、/repair cancel 或 /repair verify'));
      return;
    }
    const operation = parsed[1]?.toLowerCase() ?? 'start';
    const chatId = event.message.chat_id;
    if (operation === 'start') {
      await this.#startRepair({ actorOpenId, chatId });
      return;
    }

    const attempt = this.#repairAttempt;
    if (!attempt) {
      await this.#send(
        chatId,
        t('当前 Runtime 没有可恢复的修复任务记录（机器人可能刚完成密钥更新并重启）。本命令不会启动新的授权；请查看机器人发送的验证结果，确认上一次任务已结束后再发送 /repair。'),
      );
      return;
    }
    if (attempt.actorOpenId !== actorOpenId) {
      await this.#send(chatId, t('另一位用户正在修复该机器人，本次不会显示其授权信息。'));
      return;
    }
    if (operation === 'cancel') {
      let snapshot;
      try {
        const result = await this.#repair.cancel(this.#repairArgs(attempt));
        snapshot = repairSnapshot(result, { botId: this.#botId });
        attempt.snapshot = snapshot;
      } catch {
        await this.#send(chatId, t('暂时无法取消修复任务，请稍后重试。'));
        return;
      }
      if (snapshot.state === 'cancelled') {
        attempt.stopped = true;
        this.#repairMonitorVersion += 1;
      }
      await this.#send(chatId, this.#repairStatusText(snapshot));
      return;
    }

    let snapshot;
    try {
      snapshot = await this.#refreshRepairAttempt(attempt);
    } catch {
      await this.#send(chatId, t('暂时无法查询修复状态，请稍后重试。'));
      return;
    }
    if (operation === 'qr') {
      if (!REPAIR_ACTIVE_STATES.has(snapshot.state) || !attempt.verificationUrl) {
        await this.#send(chatId, this.#repairStatusText(snapshot, { verificationFocused: true }));
        return;
      }
      await this.#sendRepairQr(chatId, attempt.verificationUrl, snapshot);
      return;
    }
    await this.#send(chatId, this.#repairStatusText(snapshot, {
      verificationFocused: operation === 'verify',
    }));
  }

  #repairArgs(attempt) {
    return {
      botId: this.#botId,
      attemptId: attempt.attemptId,
      actorOpenId: attempt.actorOpenId,
      chatId: attempt.chatId,
    };
  }

  async #startRepair({ actorOpenId, chatId }) {
    const previous = this.#repairAttempt;
    let restarted = false;
    if (previous && REPAIR_ACTIVE_STATES.has(previous.snapshot.state)) {
      if (previous.actorOpenId !== actorOpenId) {
        await this.#send(chatId, t('另一位用户正在修复该机器人，本次不会显示其授权信息。'));
        return;
      }
      let current;
      try {
        current = await this.#refreshRepairAttempt(previous);
      } catch {
        await this.#send(chatId, t('暂时无法查询修复状态，请稍后重试。'));
        return;
      }
      // Once Feishu has accepted the update, starting another attempt could
      // race the credential swap and callback probe. Status commands remain
      // available while that non-cancellable convergence is in progress.
      if (current.state === 'saving') {
        await this.#send(chatId, this.#repairStatusText(current));
        return;
      }
      // Feishu launcher links carry one-time user codes. Opening one with the
      // wrong Open Platform account can consume it even though authorization
      // did not succeed, so a fresh bare /repair must replace a still-waiting
      // attempt instead of redisplaying the same unusable URL.
      if (REPAIR_AUTHORIZATION_STATES.has(current.state)) {
        let cancelled;
        try {
          cancelled = repairSnapshot(
            await this.#repair.cancel(this.#repairArgs(previous)),
            { botId: this.#botId },
          );
          previous.snapshot = cancelled;
        } catch {
          await this.#send(chatId, t('暂时无法取消旧修复任务，未生成新链接；请稍后重试。'));
          return;
        }
        if (!REPAIR_TERMINAL_STATES.has(cancelled.state)) {
          await this.#send(chatId, this.#repairStatusText(cancelled));
          return;
        }
        previous.stopped = true;
        this.#repairMonitorVersion += 1;
        restarted = cancelled.state === 'cancelled';
      } else if (REPAIR_TERMINAL_STATES.has(current.state)) {
        previous.stopped = true;
        this.#repairMonitorVersion += 1;
      }
    }

    let snapshot;
    try {
      snapshot = repairSnapshot(await this.#repair.start({
        botId: this.#botId,
        actorOpenId,
        chatId,
      }), { botId: this.#botId });
      snapshot = await this.#waitForRepairLink(snapshot, { actorOpenId, chatId });
    } catch {
      await this.#send(chatId, t('修复流程暂时失败，现有机器人连接不受影响；请稍后发送 /repair 重试。'));
      return;
    }
    const attempt = {
      attemptId: snapshot.attemptId,
      actorOpenId,
      chatId,
      snapshot,
      verificationUrl: null,
      stopped: false,
      announcedSaving: false,
      announcedTerminal: false,
    };
    this.#repairAttempt = attempt;

    if (snapshot.verificationUrl) {
      try {
        attempt.verificationUrl = safeRepairUrl(snapshot.verificationUrl, this.#appId);
      } catch {
        attempt.stopped = true;
        await this.#repair.cancel(this.#repairArgs(attempt)).catch(() => undefined);
        await this.#send(chatId, t('飞书返回了无法安全验证的授权链接，已中止本次修复。'));
        return;
      }
    }
    if (REPAIR_TERMINAL_STATES.has(snapshot.state)) {
      attempt.announcedTerminal = true;
      if (snapshot.state !== 'succeeded') {
        await this.#send(chatId, this.#repairStatusText(snapshot));
      }
      return;
    }
    if (!attempt.verificationUrl) {
      attempt.stopped = true;
      await this.#send(chatId, t('飞书未返回授权链接，已中止本次修复。'));
      return;
    }
    await this.#sendRepairLink(chatId, attempt.verificationUrl, snapshot, { restarted });
    this.#monitorRepair(attempt);
  }

  async #waitForRepairLink(initial, context) {
    let current = initial;
    const deadline = Date.now() + this.#repairLinkWaitMs;
    while (!current.verificationUrl && REPAIR_ACTIVE_STATES.has(current.state)) {
      if (Date.now() >= deadline) throw new Error('Feishu repair link timed out');
      await abortableDelay(Math.min(100, this.#repairPollIntervalMs), this.#signal);
      current = repairSnapshot(await this.#repair.status({
        botId: this.#botId,
        attemptId: current.attemptId,
        actorOpenId: context.actorOpenId,
        chatId: context.chatId,
      }), { botId: this.#botId });
    }
    return current;
  }

  async #refreshRepairAttempt(attempt) {
    const snapshot = repairSnapshot(
      await this.#repair.status(this.#repairArgs(attempt)),
      { botId: this.#botId },
    );
    if (snapshot.attemptId !== attempt.attemptId) {
      throw new Error('Feishu repair attempt changed unexpectedly');
    }
    attempt.snapshot = snapshot;
    if (snapshot.verificationUrl) {
      attempt.verificationUrl = safeRepairUrl(snapshot.verificationUrl, this.#appId);
    }
    return snapshot;
  }

  #monitorRepair(attempt) {
    const version = ++this.#repairMonitorVersion;
    void (async () => {
      while (!attempt.stopped && this.#repairAttempt === attempt
        && this.#repairMonitorVersion === version
        && !this.#signal?.aborted) {
        const delayMs = Math.max(
          250,
          Math.min(10_000, attempt.snapshot.pollIntervalMs ?? this.#repairPollIntervalMs),
        );
        await abortableDelay(delayMs, this.#signal);
        if (attempt.stopped || this.#repairAttempt !== attempt || this.#repairMonitorVersion !== version) return;
        const snapshot = await this.#refreshRepairAttempt(attempt);
        if (snapshot.state === 'saving' && !attempt.announcedSaving) {
          attempt.announcedSaving = true;
          await this.#send(
            attempt.chatId,
            t('授权已确认，正在发送并等待测试按钮回调；收到真实回调后才会完成。'),
          );
        }
        if (REPAIR_TERMINAL_STATES.has(snapshot.state)) {
          attempt.stopped = true;
          // Runtime sends the verified-success notice before resolving the
          // controller probe. Avoid duplicating it here; failure terminals
          // still need an explicit chat-side explanation.
          if (snapshot.state !== 'succeeded' && !attempt.announcedTerminal) {
            attempt.announcedTerminal = true;
            await this.#send(attempt.chatId, this.#repairStatusText(snapshot));
          }
          return;
        }
      }
    })().catch(async () => {
      if (this.#signal?.aborted || attempt.stopped || this.#repairAttempt !== attempt) return;
      attempt.stopped = true;
      this.#logger.warn?.('[dsh-feishu] callback repair status monitoring failed');
      await this.#send(
        attempt.chatId,
        t('修复状态查询中断，现有机器人连接不受影响；发送 /repair status 重试查询。'),
      ).catch(() => undefined);
    });
  }

  async #sendRepairLink(chatId, url, snapshot, { restarted = false } = {}) {
    const remaining = snapshot.remainingSeconds
      ?? (snapshot.expiresAt ? Math.max(0, Math.ceil((snapshot.expiresAt - Date.now()) / 1000)) : null);
    const expiry = remaining === null
      ? t('链接为短期有效')
      : t('链接约 {minutes} 分钟后过期', { minutes: Math.max(1, Math.ceil(remaining / 60)) });
    await this.#send(chatId, [
      restarted ? t('旧授权链接已作废，已生成新的修复链接。') : t('🔧 准备补全权限与回调。'),
      t('本次会增量添加当前缺少项：卡片回调 card.action.trigger；飞书显示为“获取单聊、群组消息”的租户权限 im:message:readonly（用于读取用户消息中的图片或文件）；im:resource（用于上传机器人发送的图片或文件）；以及原生命令面板所需的 application:app_slash_command:read / write。确认页只会显示当前缺少的项；若出现上述范围之外的配置，请取消。'),
      '',
      t('当前设备直接打开：'),
      url,
      '',
      t('若要用另一台设备扫码，发送 /repair qr。{expiry}。', { expiry }),
    ].join('\n'));
  }

  async #sendRepairQr(chatId, url, snapshot) {
    try {
      const image = await QRCode.toBuffer(url, {
        errorCorrectionLevel: 'M', margin: 1, width: 480, type: 'png',
      });
      const uploaded = await this.#client.im.v1.image.create({
        data: { image_type: 'message', image },
      });
      const imageKey = nonEmptyString(uploaded?.image_key) ?? nonEmptyString(uploaded?.data?.image_key);
      if (!imageKey) throw new Error('Feishu QR upload returned no image key');
      const remaining = snapshot.remainingSeconds
        ?? (snapshot.expiresAt ? Math.max(0, Math.ceil((snapshot.expiresAt - Date.now()) / 1000)) : null);
      const remainingText = remaining === null
        ? ''
        : t('（剩余约 {minutes} 分钟）', { minutes: Math.max(1, Math.ceil(remaining / 60)) });
      await this.#send(
        chatId,
        t('请用另一台设备扫码完成授权{remaining}。', { remaining: remainingText }),
      );
      const response = await this.#client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
        },
      });
      if (response?.code && response.code !== 0) throw new Error('Feishu QR message send failed');
    } catch {
      await this.#send(chatId, t('二维码暂时无法发送，请直接打开授权链接：\n{url}', { url }));
    }
  }

  #repairStatusText(snapshot, { verificationFocused = false } = {}) {
    if (snapshot.state === 'succeeded') {
      return t('✅ 修复完成：已实测收到 card.action.trigger，菜单按钮现在可用。');
    }
    if (snapshot.state === 'expired' || snapshot.error?.code === 'expired_token') {
      return t('授权链接已过期；平台未返回成功结果，无法确认已修复。发送 /repair 生成新链接。');
    }
    if (snapshot.state === 'cancelled' || snapshot.error?.code === 'abort') {
      return t('已取消本次修复授权，未确认完成修复。');
    }
    if (snapshot.error?.code === 'access_denied') {
      return t('你已取消或拒绝授权，没有确认修复；发送 /repair 可重试。');
    }
    if (snapshot.error?.code === 'card_action_probe_timeout'
      || snapshot.error?.code === 'card-action-probe-timeout') {
      return t('授权已提交，但未收到测试按钮回调。可能尚未点击或配置仍在传播；稍后发送 /repair verify 查询，不要盲目重复授权。');
    }
    if (snapshot.state === 'error') {
      return t('修复流程暂时失败，现有机器人连接不受影响；发送 /repair 可重试。');
    }
    if (snapshot.state === 'saving') {
      return t('授权已确认，正在等待专用测试按钮的真实回调；回调到达前不会宣告成功。');
    }
    if (verificationFocused) {
      return t('授权尚未完成，暂时不能验证卡片按钮。请先打开授权链接并确认。');
    }
    const remaining = snapshot.remainingSeconds === null
      ? ''
      : t('，剩余约 {minutes} 分钟', { minutes: Math.max(1, Math.ceil(snapshot.remainingSeconds / 60)) });
    return t('修复任务正在等待授权{remaining}。发送 /repair qr 可获取二维码，/repair cancel 可取消。', { remaining });
  }

  /**
   * Card button callback (card.action.trigger). The operator must be an
   * allowed sender: group members outside the allowlist must never drive
   * session binding, workspace switches or other card actions.
   */
  onCardAction(event) {
    const operatorOpenId = nonEmptyString(event?.operator?.open_id)
      ?? nonEmptyString(event?.operator?.user_id)
      // Keep accepting the legacy nested shape while preferring the current
      // card.action.trigger v2 payload used by the official SDK.
      ?? nonEmptyString(event?.operator?.operator_id?.open_id)
      ?? nonEmptyString(event?.operator?.operator_id?.user_id)
      ?? nonEmptyString(event?.open_id)
      ?? nonEmptyString(event?.user_id);
    if (!operatorOpenId) return Promise.resolve();
    if (!this.#accessPolicy
      && !this.#allowedSenderOpenIds.has('*')
      && !this.#allowedSenderOpenIds.has(operatorOpenId)) {
      this.#logger.warn?.('[dsh-feishu] ignoring card action from an unallowed legacy sender');
      return Promise.resolve();
    }
    const actionValue = callbackObject(event?.action?.value);
    const formValue = callbackObject(event?.action?.form_value);
    const action = nonEmptyString(actionValue.action)
      ?? nonEmptyString(event?.action?.action);
    if (!action) return Promise.resolve();
    // select_static dropdown: resolve pickers to their target actions
    const option = callbackSingleOption(event?.action?.option)
      ?? (action.endsWith('_pick') ? callbackMultiOptionValues(event?.action?.options)[0] : null);
    // The official Card 2.0 callback currently uses a comma-separated string
    // for multi-select values; older SDKs emitted arrays or value objects.
    const multiValues = [...new Set([
      ...callbackMultiOptionValues(actionValue.options),
      ...callbackMultiOptionValues(event?.action?.options),
      ...callbackMultiOptionValues(formValue[action]),
      ...(action === 'watch_add' || action === 'watch_remove'
        ? callbackMultiOptionValues(event?.action?.option)
        : []),
    ])];
    const resolvedAction = action === 'workspace_pick' && typeof option === 'string'
      ? `workspace:${option}`
      : action === 'session_pick' && typeof option === 'string'
        ? `use:${option}`
        : action === 'preset_pick' && typeof option === 'string'
          ? `preset:select:${option}`
          : action === 'model_pick' && typeof option === 'string'
            ? `model:select:${option}`
            : action === 'archive_pick' && typeof option === 'string'
              ? `archive:${option}`
              : action === 'steer_pick' && typeof option === 'string'
                ? `steer:${option}`
                : action;
    const messageId = nonEmptyString(event?.context?.open_message_id)
      ?? nonEmptyString(event?.open_message_id)
      ?? nonEmptyString(event?.message_id);
    const route = messageId ? this.#cardKeys.get(messageId) : null;
    if (!route) {
      // A route is also the trusted direct/group scope for the unified policy.
      // Without it, fail closed instead of producing an unauthorised side effect.
      if (this.#accessPolicy) return Promise.resolve();
      // Legacy callers without a unified policy still receive the current
      // expired-card guidance introduced by the upstream thread-reply fix.
      // The card predates this process (the in-memory mapping resets on
      // restart) or never came from us: nudge instead of staying silent.
      const chatId = nonEmptyString(event?.context?.open_chat_id)
        ?? nonEmptyString(event?.open_chat_id)
        ?? nonEmptyString(event?.chat_id);
      if (chatId) {
        this.#send(chatId, t('这个菜单已过期，请回复 /m 重新打开。'), { replyTo: messageId }).catch(() => undefined);
      }
      return Promise.resolve();
    }
    const conversationType = route.key.startsWith('p2p:') ? 'direct'
      : route.key.startsWith('group:') ? 'group' : null;
    const access = evaluateInboundAccess(this.#accessPolicy, {
      conversationType,
      senderIds: operatorOpenId,
      isCommand: true,
    });
    if (!access.allowed) {
      if (access.reason === 'command-not-allowed') {
        return this.#send(route.chatId, t(COMMAND_PERMISSION_DENIED_MESSAGE))
          .catch(() => undefined);
      }
      this.#logger.warn?.('[dsh-feishu] ignoring card action blocked by access policy');
      return Promise.resolve();
    }
    // A used card is recent even if it was first created long ago.
    this.#cardKeys.delete(messageId);
    this.#cardKeys.set(messageId, route);
    const entry = { ...route, messageId, selections: multiValues, operatorOpenId };
    const source = nonEmptyString(actionValue.source);
    const formText = nonEmptyString(formValue.steer_text);
    const eventId = nonEmptyString(event?.event_id)
      ?? nonEmptyString(event?.header?.event_id)
      ?? nonEmptyString(event?.uuid)
      ?? nonEmptyString(event?.header?.uuid);
    const identity = JSON.stringify({
      messageId,
      resolvedAction,
      option,
      multiValues,
      source,
      formText,
    });
    const isStop = resolvedAction === 'stop';
    const rawSteer = resolvedAction.startsWith('steer:')
      ? resolvedAction.slice('steer:'.length)
      : null;
    const isCustomSteer = rawSteer === 'custom' || rawSteer === STEER_CUSTOM_SENTINEL;
    const isRealSteer = (action === 'steer'
      && source === 'quick'
      && option !== null
      && option !== STEER_CUSTOM_SENTINEL)
      || (action === 'steer' && source === 'form' && formText !== null)
      || (rawSteer !== null && rawSteer !== '' && !isCustomSteer);

    return this.#queueCardAction(entry, identity, async () => {
      // 补充指令卡片：快捷下拉(source=quick, option=指令) / 表单提交(source=form)
      if (action === 'steer') {
        if (source === 'quick' && option) {
          if (option === STEER_CUSTOM_SENTINEL) {
            await this.#sendCard(entry.chatId, customSteerCard(), {
              key: entry.key,
              updateMessageId: entry.messageId,
            });
            return;
          }
          await this.#sendSteer(entry, option);
          return;
        }
        if (source === 'form') {
          if (formText) {
            await this.#sendSteer(entry, formText);
            return;
          }
          await this.#send(entry.chatId, t('请输入补充指令后再提交。'), { replyTo: entry.messageId ?? null });
          return;
        }
      }
      await this.#handleCardAction(resolvedAction, entry);
    }, {
      lane: isStop || isRealSteer ? 'control' : 'regular',
      coalesceStop: isStop,
      eventId,
      operatorOpenId,
    });
  }

  #pruneCompletedCardActions(now = Date.now()) {
    for (const [key, expiresAt] of this.#completedCardActions) {
      if (expiresAt <= now) this.#completedCardActions.delete(key);
    }
    while (this.#completedCardActions.size > MAX_COMPLETED_CARD_ACTIONS) {
      const oldest = this.#completedCardActions.keys().next().value;
      if (oldest === undefined) break;
      this.#completedCardActions.delete(oldest);
    }
  }

  #rememberCompletedCardAction(key, now = Date.now()) {
    if (!key) return;
    this.#completedCardActions.delete(key);
    this.#completedCardActions.set(key, now + CARD_ACTION_DEDUPE_TTL_MS);
    this.#pruneCompletedCardActions(now);
  }

  #notifyCardOverflow(entry) {
    const conversation = entry.key;
    const now = Date.now();
    const existing = this.#cardOverloadNoticeAt.get(conversation);
    if (existing?.task || (existing && now - existing.at < CARD_OVERLOAD_NOTICE_COOLDOWN_MS)) {
      return existing?.task ?? Promise.resolve();
    }
    this.#logger.warn?.('[dsh-feishu] card action queue is full; dropping callbacks');
    let tracked;
    tracked = this.#send(entry.chatId, t('操作过于频繁，请稍后再试。'), { replyTo: entry.messageId ?? null })
      .catch(() => undefined)
      .finally(() => {
        this.#cardActionTasks.delete(tracked);
        const current = this.#cardOverloadNoticeAt.get(conversation);
        if (current?.task === tracked) this.#cardOverloadNoticeAt.set(conversation, { at: current.at, task: null });
      });
    this.#cardOverloadNoticeAt.delete(conversation);
    this.#cardOverloadNoticeAt.set(conversation, { at: now, task: tracked });
    this.#cardActionTasks.add(tracked);
    while (this.#cardOverloadNoticeAt.size > 200) {
      const oldest = this.#cardOverloadNoticeAt.keys().next().value;
      if (oldest === undefined) break;
      this.#cardOverloadNoticeAt.delete(oldest);
    }
    return tracked;
  }

  #queueCardAction(entry, identity, task, {
    lane = 'regular',
    coalesceStop = false,
    eventId = null,
    operatorOpenId = null,
  } = {}) {
    const conversation = entry.key;
    const completedKey = eventId
      ? `${conversation}\0${operatorOpenId ?? ''}\0event:${eventId}`
      : null;
    const dedupeKey = completedKey
      ?? `${conversation}\0${operatorOpenId ?? ''}\0action:${identity}`;
    const now = Date.now();
    this.#pruneCompletedCardActions(now);
    if (completedKey && (this.#completedCardActions.get(completedKey) ?? 0) > now) {
      return Promise.resolve();
    }
    const duplicate = this.#cardActionInFlight.get(dedupeKey);
    if (duplicate) return duplicate;
    if (coalesceStop) {
      const pendingStop = this.#cardStopInFlight.get(conversation);
      if (pendingStop) {
        if (completedKey) {
          // Remember only a bounded LRU of provider ids while the shared stop
          // is unresolved. They become completed only after that stop settles.
          this.#cardStopFollowers.delete(completedKey);
          this.#cardStopFollowers.set(completedKey, pendingStop);
          while (this.#cardStopFollowers.size > MAX_COMPLETED_CARD_ACTIONS) {
            const oldest = this.#cardStopFollowers.keys().next().value;
            if (oldest === undefined) break;
            this.#cardStopFollowers.delete(oldest);
          }
        }
        return pendingStop;
      }
    }

    const control = lane === 'control';
    const tails = control ? this.#cardControlTails : this.#cardActionTails;
    const counts = control ? this.#cardControlCounts : this.#cardActionCounts;
    const limit = control ? MAX_PENDING_CARD_CONTROLS_PER_KEY : MAX_PENDING_CARD_ACTIONS_PER_KEY;
    const pending = counts.get(conversation) ?? 0;
    // Reserve one bounded control slot for stop. All further stop clicks join
    // that task, so a flood cannot grow the queue beyond limit + 1.
    const pendingLimit = coalesceStop ? limit + 1 : limit;
    if (pending >= pendingLimit) {
      return this.#notifyCardOverflow(entry);
    }

    const previous = tails.get(conversation) ?? Promise.resolve();
    counts.set(conversation, pending + 1);

    let tracked;
    let started = false;
    tracked = previous
      .catch(() => undefined)
      .then(async () => {
        this.#signal?.throwIfAborted();
        started = true;
        await task();
      })
      .catch(async (error) => {
        if (this.#signal?.aborted) return;
        await this.#sendFailure(entry.chatId, error, { logLabel: 'card action', replyTo: entry.messageId });
      })
      .finally(() => {
        if (this.#cardActionInFlight.get(dedupeKey) === tracked) {
          this.#cardActionInFlight.delete(dedupeKey);
        }
        if (started && completedKey) {
          this.#rememberCompletedCardAction(completedKey);
        }
        if (coalesceStop && this.#cardStopInFlight.get(conversation) === tracked) {
          this.#cardStopInFlight.delete(conversation);
        }
        if (coalesceStop) {
          const settledAt = Date.now();
          for (const [followerKey, pendingStop] of this.#cardStopFollowers) {
            if (pendingStop !== tracked) continue;
            this.#cardStopFollowers.delete(followerKey);
            this.#rememberCompletedCardAction(followerKey, settledAt);
          }
        }
        if (tails.get(conversation) === tracked) tails.delete(conversation);
        const remaining = (counts.get(conversation) ?? 1) - 1;
        if (remaining > 0) counts.set(conversation, remaining);
        else counts.delete(conversation);
        this.#cardActionTasks.delete(tracked);
      });
    this.#cardActionInFlight.set(dedupeKey, tracked);
    if (coalesceStop) this.#cardStopInFlight.set(conversation, tracked);
    this.#cardActionTasks.add(tracked);
    tails.set(conversation, tracked);
    return tracked;
  }

  async #handleCardAction(action, {
    chatId,
    key,
    messageId = null,
    sessionWorkspace = null,
    sessionPage = 0,
    sessionLimit = null,
    selections = [],
  }) {
    // Confirmations triggered by a card interaction stay anchored to the
    // card's message so they land inside the same Feishu topic.
    const reply = (text) => this.#send(chatId, text, { replyTo: messageId });
    if (action === 'sessions' || /^sessions:\d+$/.test(action)) {
      const page = action === 'sessions' ? 0 : Number(action.slice('sessions:'.length));
      await this.#showSessions(
        { chatId, key, replyTo: messageId },
        sessionWorkspace,
        page,
        { updateMessageId: messageId, limit: sessionLimit },
      );
      return;
    }
    if (action === 'workspaces') {
      await this.#showWorkspaces({ chatId, key, replyTo: messageId }, { updateMessageId: messageId });
      return;
    }
    if (action === 'watchlist') {
      await this.#showWatchList(key, chatId, { updateMessageId: messageId, replyTo: messageId });
      return;
    }
    // 多选关注下拉：action=watch_add / watch_remove，选中项在 selections 数组
    if (action === 'watch_add' || action === 'watch_remove') {
      if (selections.length === 0) {
        await reply(t('请先选择至少一个会话。'));
        return;
      }
      let changed = 0;
      let failed = 0;
      if (action === 'watch_add') {
        let freshTargets = new Map();
        try {
          freshTargets = await this.#freshWatchTargets(sessionWorkspace);
        } catch (error) {
          this.#logger.warn?.('[dsh-feishu] batch watch validation failed:', error.message);
        }
        for (const sessionId of selections) {
          const validatedTarget = freshTargets.get(sessionId);
          if (!validatedTarget) {
            failed += 1;
            continue;
          }
          const result = await this.#runWatch(key, chatId, sessionId, {
            notify: false,
            validatedTarget,
            replyTo: messageId,
          });
          if (result.changed) changed += 1;
          else if (!result.ok) failed += 1;
        }
      } else {
        for (const sessionId of selections) {
          const result = await this.#runUnwatch(key, chatId, sessionId, { notify: false });
          if (result.changed) changed += 1;
          else if (!result.ok) failed += 1;
        }
      }
      const summary = changed > 0 && failed > 0
        ? action === 'watch_add'
          ? t('已批量关注 {count} 个会话，另有 {failed} 个未成功。', { count: changed, failed })
          : t('已取消关注 {count} 个会话，另有 {failed} 个未成功。', { count: changed, failed })
        : changed > 0
          ? action === 'watch_add'
            ? t('已批量关注 {count} 个会话。', { count: changed })
            : t('已取消关注 {count} 个会话。', { count: changed })
          : failed > 0
            ? t('所选会话均未处理成功，请稍后重试。')
            : action === 'watch_add'
              ? t('所选会话已在关注列表中。')
              : t('所选会话已不在关注列表中。');
      try {
        await this.#showWatchList(key, chatId, { updateMessageId: messageId, replyTo: messageId });
      } catch (error) {
        this.#logger.warn?.('[dsh-feishu] watch list refresh failed:', error.message);
      }
      await reply(summary).catch((error) => {
        this.#logger.warn?.('[dsh-feishu] watch batch summary failed:', error.message);
      });
      return;
    }
    if (action === 'new') {
      if (this.#queues.has(key) || this.#hasPendingInteraction(key)) {
        await reply(t('当前任务仍在运行，请先停止任务或等待任务完成后再开启新会话。'));
        return;
      }
      await this.#state.clearSession(key);
      await reply(t('已开启全新 Harness 会话。'));
      await this.#sendMenuCard(key, chatId, { updateMessageId: messageId, replyTo: messageId });
      return;
    }
    if (action === 'use:current') {
      const sessionId = this.#state.sessionFor(key);
      if (typeof sessionId !== 'string' || !sessionId) {
        await reply(t('当前没有绑定的会话，请先从会话列表选择。'));
        return;
      }
      await reply(t('已就绪，直接发消息即可继续当前会话。'));
      return;
    }
    if (action === 'archive_toggle' || action === 'archive:on' || action === 'archive:off') {
      const next = action === 'archive:on' ? true : action === 'archive:off' ? false : !(this.#state?.includesArchivedSessions?.() ?? false);
      await this.#state?.setIncludeArchivedSessions?.(next);
      await reply(
        next ? t('已开启：会话列表包含归档会话。') : t('已关闭：会话列表隐藏归档会话。'),
      );
      await this.#sendMenuCard(key, chatId, { updateMessageId: messageId, replyTo: messageId });
      return;
    }
    if (action === 'repair') {
      await reply(t('修复需在私聊中验证接入者身份，请直接发送 /repair 开始。'));
      return;
    }
    if (action === 'compact') {
      await this.#handleCompact(key, chatId, messageId);
      return;
    }
    if (action === 'stop') {
      await this.#handleStop(key, chatId, messageId);
      return;
    }
    if (action === 'steer') {
      await this.#showSteerCard(key, chatId, { updateMessageId: messageId });
      return;
    }
    // 主菜单「补充指令」下拉：option = steer:<指令> / steer:custom
    if (action.startsWith('steer:')) {
      const raw = action.slice('steer:'.length);
      if (raw === 'custom') {
        await this.#sendCard(chatId, customSteerCard(), { key, updateMessageId: messageId, replyTo: messageId });
        return;
      }
      await this.#sendSteer({ key, chatId, messageId }, raw);
      return;
    }
    if (action === 'presets') {
      await this.#showPresetCard(key, chatId, { updateMessageId: messageId });
      return;
    }
    if (action === 'models') {
      await this.#showModelCard(key, chatId, { updateMessageId: messageId });
      return;
    }
    if (action === 'status') {
      await this.#showStatusCard(key, chatId, { updateMessageId: messageId });
      return;
    }
    if (action === 'help') {
      await this.#showHelpCard(key, chatId, { updateMessageId: messageId });
      return;
    }
    if (action === 'back_to_menu') {
      await this.#sendMenuCard(key, chatId, { updateMessageId: messageId, replyTo: messageId });
      return;
    }
    if (action === 'preset_default') {
      await this.#handlePresetDefault(key, chatId, { updateMessageId: messageId });
      return;
    }
    if (action.startsWith('preset:select:')) {
      const presetId = action.slice('preset:select:'.length);
      // 哨兵值 = 用户在预设下拉里选了「跟随默认」
      if (presetId === PRESET_FOLLOW_DEFAULT_SENTINEL) {
        await this.#handlePresetDefault(key, chatId, { updateMessageId: messageId });
        return;
      }
      await this.#handlePresetSelect(key, chatId, presetId, { updateMessageId: messageId });
      return;
    }
    if (action.startsWith('model:select:')) {
      const modelId = action.slice('model:select:'.length);
      await this.#handleModelSelect(key, chatId, modelId, { updateMessageId: messageId });
      return;
    }
    if (action.startsWith('use:')) {
      await this.#bindSession(key, chatId, action.slice('use:'.length), { updateMessageId: messageId, replyTo: messageId });
      return;
    }
    if (action.startsWith('workspace:')) {
      await this.#switchWorkspace(key, chatId, action.slice('workspace:'.length), { updateMessageId: messageId, replyTo: messageId });
      return;
    }
    if (action.startsWith('unwatch:')) {
      const result = await this.#runUnwatch(key, chatId, action.slice('unwatch:'.length), { replyTo: messageId });
      if (result.ok && messageId) {
        await this.#showSessions(
          { chatId, key, replyTo: messageId },
          sessionWorkspace,
          sessionPage,
          { updateMessageId: messageId, limit: sessionLimit },
        );
      }
      return;
    }
    if (action.startsWith('watch:')) {
      const sessionId = action.slice('watch:'.length);
      const result = await this.#runWatch(key, chatId, sessionId, {
        workspaceHint: sessionWorkspace,
        replyTo: messageId,
      });
      if (result.ok && messageId) {
        await this.#showSessions(
          { chatId, key, replyTo: messageId },
          sessionWorkspace,
          sessionPage,
          { updateMessageId: messageId, limit: sessionLimit },
        );
      }
    }
  }

  #rememberMenu(key, menu) {
    if (this.#menus.size >= MAX_TRACKED_MENUS) {
      const oldest = this.#menus.keys().next().value;
      if (oldest !== undefined) this.#menus.delete(oldest);
    }
    this.#menus.delete(key);
    this.#menus.set(key, { ...menu, expiresAt: Date.now() + MENU_TTL_MS });
  }

  #takeMenu(key) {
    const menu = this.#menus.get(key);
    if (!menu) return null;
    if (menu.expiresAt < Date.now()) {
      this.#menus.delete(key);
      return null;
    }
    return menu;
  }

  async #handleMenuPick(menu, number, { chatId, key, event }) {
    const replyTo = event?.message?.message_id ?? null;
    const reply = (text) => this.#send(chatId, text, { replyTo });
    if (menu.kind === 'menu') {
      // Number fallback for the total menu:
      // 1=工作区列表 2=新会话 3=会话列表 4=状态 5=修复 6=帮助
      const actions = ['workspaces', 'new', 'sessions', 'status', 'repair', 'help'];
      const action = actions[number - 1];
      if (!action) {
        await reply(t('菜单没有这个编号，回复 /m 重新打开。'));
        return;
      }
      if (action === 'repair') {
        await this.#handleRepairCommand(event, '/repair');
        return;
      }
      await this.#handleCardAction(action, { chatId, key, messageId: replyTo });
      return;
    }
    if (menu.kind === 'sessions') {
      const session = menu.sessions[number - 1];
      if (!session?.sessionId) {
        await reply(t('本页只有 {count} 个会话，回复 /sessionlist 重新查看。', { count: menu.sessions.length }));
        return;
      }
      // The number label sits on the session (bind) button of the row.
      await this.#handleCardAction(`use:${session.sessionId}`, { chatId, key, messageId: replyTo });
      return;
    }
    if (menu.kind === 'workspaces') {
      const workspace = menu.paths[number - 1];
      if (!workspace) {
        await reply(t('只有 {count} 个工作区，回复 /workspacelist 重新查看。', { count: menu.paths.length }));
        return;
      }
      await this.#handleCardAction(`workspace:${workspace}`, { chatId, key, messageId: replyTo });
      return;
    }
    if (menu.kind === 'watches') {
      const entry = menu.entries[number - 1];
      if (!entry?.sessionId) {
        await reply(t('关注列表只有 {count} 个会话。', { count: menu.entries.length }));
        return;
      }
      await this.#handleCardAction(`unwatch:${entry.sessionId}`, { chatId, key, messageId: replyTo });
    }
  }

  /** The sessions visible under the bot's archived policy. */
  #visibleSessions(sessions) {
    if (this.#state?.includesArchivedSessions?.() === false) {
      return sessions.filter((session) => session.archived !== true);
    }
    return sessions;
  }

  async #showSessions(
    { chatId, key, replyTo = null },
    selector,
    page = 0,
    { updateMessageId = null, limit = null } = {},
  ) {
    try {
      const signal = this.#cardDataSignal();
      const resolved = await resolveSessionListWorkspace(selector ?? '', this.#harness, { signal });
      if (resolved.error) {
        await this.#send(chatId, resolved.error, { replyTo });
        return;
      }
      const listed = await this.#harness.listWorkspaceSessions(resolved.workspace, { signal });
      const visibleSessions = this.#visibleSessions(Array.isArray(listed?.sessions) ? listed.sessions : []);
      const sessionLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : null;
      const sessions = sessionLimit === null
        ? visibleSessions
        : visibleSessions.slice(0, sessionLimit);
      const workspace = listed?.workspace ?? resolved.workspace;
      if (sessions.length === 0) {
        await this.#send(chatId, t('工作区：{workspace}\n该工作区暂无会话。', { workspace }), { replyTo });
        return;
      }
      const pageCount = Math.ceil(sessions.length / MENU_PAGE_SIZE);
      const safePage = Number.isSafeInteger(page) && page > 0 ? Math.min(page, pageCount - 1) : 0;
      const watchedSet = new Set(
        (this.#state.watchEntries?.(key) ?? []).map((entry) => entry.sessionId),
      );
      const pageSlice = sessions.slice(safePage * MENU_PAGE_SIZE, (safePage + 1) * MENU_PAGE_SIZE);
      this.#rememberMenu(key, {
        kind: 'sessions',
        sessions: pageSlice.map((session) => ({ ...session, watched: watchedSet.has(session.sessionId) })),
      });
      await this.#sendCard(
        chatId,
        sessionListCard(workspace, sessions, safePage, sessions.length, watchedSet),
        {
          key,
          updateMessageId,
          replyTo,
          // Keep the canonical selector result for later page callbacks. The
          // list response's workspace is display data and is not authoritative.
          sessionWorkspace: resolved.workspace,
          sessionPage: safePage,
          sessionLimit,
        },
      );
    } catch (error) {
      await this.#sendFailure(chatId, error, { logLabel: 'session list', replyTo });
    }
  }

  async #showWorkspaces({ chatId, key, replyTo = null }, { updateMessageId = null } = {}) {
    try {
      const { current, paths } = await workspacePathSnapshot(
        this.#harness,
        { signal: this.#cardDataSignal() },
      );
      this.#rememberMenu(key, { kind: 'workspaces', paths });
      await this.#sendCard(
        chatId,
        workspaceListCard(paths, current),
        { key, updateMessageId, replyTo },
      );
    } catch (error) {
      await this.#sendFailure(chatId, error, { logLabel: 'workspace list', replyTo });
    }
  }

  async #bindSession(key, chatId, sessionId, { updateMessageId = null, replyTo = null } = {}) {
    try {
      const bound = await this.#harness.bindWorkspaceSession(key, sessionId);
      const title = String(bound?.title ?? '').replace(/\s+/gu, ' ').trim() || t('暂无标题');
      await this.#send(chatId, [
        t('已绑定会话「{title}」\nID：{id}', { title, id: bound?.sessionId ?? sessionId }),
        t('发送 /history 查看最近对话。'),
      ].join('\n'), { replyTo });
      await this.#sendMenuCard(key, chatId, { updateMessageId, replyTo });
    } catch (error) {
      await this.#sendFailure(chatId, error, {
        logLabel: 'session binding',
        replyTo,
        userMessage: t('绑定失败：{message}', { message: safeErrorText(error) }),
      });
    }
  }

  async #switchWorkspace(key, chatId, workspace, { updateMessageId = null, replyTo = null } = {}) {
    try {
      const current = await this.#harness.switchWorkspace(workspace);
      await this.#send(chatId, t('工作区已切换为：{workspace}', { workspace: current }), { replyTo });
      await this.#sendMenuCard(key, chatId, { updateMessageId, replyTo });
    } catch (error) {
      await this.#sendFailure(chatId, error, {
        logLabel: 'workspace switch',
        replyTo,
        userMessage: t('切换失败：{message}', { message: safeErrorText(error) }),
      });
    }
  }

  #rememberCardRoute(messageId, chatId, options) {
    if (!options.key || !messageId) return;
    this.#cardKeys.delete(messageId);
    this.#cardKeys.set(messageId, {
      key: options.key,
      chatId,
      sessionWorkspace: typeof options.sessionWorkspace === 'string' && options.sessionWorkspace
        ? options.sessionWorkspace
        : null,
      sessionPage: Number.isSafeInteger(options.sessionPage) && options.sessionPage >= 0
        ? options.sessionPage
        : 0,
      sessionLimit: Number.isSafeInteger(options.sessionLimit) && options.sessionLimit > 0
        ? options.sessionLimit
        : null,
    });
    if (this.#cardKeys.size > 200) {
      const oldest = this.#cardKeys.keys().next().value;
      if (oldest !== undefined) this.#cardKeys.delete(oldest);
    }
  }

  async #sendCard(chatId, cardJson, options = {}) {
    const updateMessageId = nonEmptyString(options.updateMessageId);
    const replyTo = nonEmptyString(options.replyTo);

    if (updateMessageId) {
      try {
        const response = await this.#client.im.v1.message.patch({
          path: { message_id: updateMessageId },
          data: { content: cardJson },
        });
        if (response?.code && response.code !== 0) {
          throw new Error(`Feishu card update failed: ${response.msg || response.code}`);
        }
        this.#rememberCardRoute(updateMessageId, chatId, options);
        return updateMessageId;
      } catch (error) {
        this.#logger.warn?.('[dsh-feishu] card update failed:', error?.code ?? error?.message ?? error, 'sending new');
      }
    }

    // A brand-new card triggered by an inbound message is delivered as a
    // threaded reply so it lands inside the same Feishu topic. Falls back to
    // a plain chat message when the referenced message is gone.
    const content = cardJson;
    if (replyTo) {
      try {
        const response = await this.#client.im.v1.message.reply({
          path: { message_id: replyTo },
          data: { msg_type: 'interactive', content },
        });
        if (response?.code && response.code !== 0) {
          throw new Error(`Feishu card reply failed: ${response.msg || response.code}`);
        }
        const repliedMessageId = nonEmptyString(response?.data?.message_id);
        if (repliedMessageId) {
          this.#rememberCardRoute(repliedMessageId, chatId, options);
          return repliedMessageId;
        }
      } catch (error) {
        this.#logger.warn?.('[dsh-feishu] threaded card reply failed; sending a plain card:', error?.message ?? String(error));
      }
    }
    const response = await this.#client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content: cardJson },
    });
    if (response?.code && response.code !== 0) {
      throw new Error(`Feishu card send failed: ${response.msg || response.code}`);
    }
    const messageId = nonEmptyString(response?.data?.message_id);
    this.#rememberCardRoute(messageId, chatId, options);
    return messageId;
  }

  async #sendMenuCard(key, chatId, { updateMessageId = null, replyTo = null } = {}) {
    let currentSessionId = null;
    let directSessionTitle = null;
    try {
      const sessionId = this.#state.sessionFor(key);
      if (typeof sessionId === 'string' && sessionId) {
        currentSessionId = sessionId;
        const session = this.#harness.workspaceSession?.(sessionId);
        directSessionTitle = nonEmptyString(session?.title)
          ?? nonEmptyString(session?.name)
          ?? nonEmptyString(session?.displayName);
      }
    } catch { /* render without a selected session */ }

    const dataSignal = this.#cardDataSignal();
    // Independent sections start together. Each one degrades on its own so a
    // slow preset/model RPC cannot force redundant session-list scans.
    const workspaceTask = workspacePathSnapshot(this.#harness, { signal: dataSignal })
      .catch(() => {
        const current = typeof this.#harness.currentWorkspace === 'function'
          ? this.#harness.currentWorkspace()
          : null;
        return { current, paths: current ? [current] : [] };
      });
    const sessionTask = (async () => {
      const current = typeof this.#harness.currentWorkspace === 'function'
        ? this.#harness.currentWorkspace()
        : null;
      if (!current || typeof this.#harness.listWorkspaceSessions !== 'function') return [];
      try {
        const listed = await this.#harness.listWorkspaceSessions(current, { signal: dataSignal });
        return this.#visibleSessions(Array.isArray(listed?.sessions) ? listed.sessions : []);
      } catch {
        return [];
      }
    })();
    const presetTask = (async () => {
      try {
        const settings = await this.#harness.agentPresetSettings({ signal: dataSignal });
        return { ...settings.agentPresetCatalog, _currentId: settings.agentPreset };
      } catch {
        return null;
      }
    })();
    const modelTask = (async () => {
      try {
        if (currentSessionId) {
          const session = this.#harness.workspaceSession?.(currentSessionId);
          if (typeof session?.models === 'function') {
            return await session.models({ signal: dataSignal });
          }
        }
        return await this.#harness.listModels({ signal: dataSignal });
      } catch {
        return null;
      }
    })();

    const [snapshot, listedSessions, presetCatalog, modelCatalog] = await Promise.all([
      workspaceTask,
      sessionTask,
      presetTask,
      modelTask,
    ]);
    const workspaces = Array.isArray(snapshot.paths) ? snapshot.paths : [];
    const currentWorkspace = snapshot.current ?? null;
    const currentMatch = listedSessions.find((session) => session.sessionId === currentSessionId);
    const currentSessionTitle = currentSessionId
      ? nonEmptyString(currentMatch?.title)
        ?? nonEmptyString(currentMatch?.name)
        ?? directSessionTitle
        ?? currentSessionId
      : null;
    let sessions = listedSessions
      .map((session) => ({
        id: session.sessionId,
        title: session.title ?? session.name ?? session.sessionId,
      }))
      .slice(0, 20);
    // 确保当前绑定会话始终出现在下拉最前（它可能不在最近列表里），
    // 否则 initial_index 找不到默认展示项，下拉会显示占位文本。
    if (currentSessionId) {
      sessions = sessions.filter((s) => s.id !== currentSessionId);
      sessions.unshift({ id: currentSessionId, title: currentSessionTitle ?? currentSessionId });
      sessions = sessions.slice(0, 20);
    }
    const archiveVisible = this.#state?.includesArchivedSessions?.() ?? false;
    this.#rememberMenu(key, { kind: 'menu', chatId });
    await this.#sendCard(
      chatId,
      menuCard({
        workspaces, currentWorkspace,
        currentSession: currentSessionId ? { id: currentSessionId, title: currentSessionTitle } : null,
        sessions, archiveVisible, presetCatalog, modelCatalog,
      }),
      { key, updateMessageId, replyTo },
    );
  }

  /**
   * Resolve a human-readable title for a bound session when available.
   * Attempts the workspace-session object first, then falls back to the
   * current workspace's session list. Returns null on any failure.
   */
  async #resolveSessionTitle(key, sessionId) {
    try {
      if (typeof this.#harness.workspaceSession === 'function') {
        const session = this.#harness.workspaceSession(sessionId);
        if (session && typeof session === 'object') {
          const direct = nonEmptyString(session.title)
            ?? nonEmptyString(session.name)
            ?? nonEmptyString(session.displayName);
          if (direct) return direct;
        }
      }
      // Fallback: scan the current workspace session list for this id
      const current = typeof this.#harness.currentWorkspace === 'function'
        ? this.#harness.currentWorkspace()
        : null;
      if (current && typeof this.#harness.listWorkspaceSessions === 'function') {
        const listed = await this.#harness.listWorkspaceSessions(current);
        const match = (Array.isArray(listed?.sessions) ? listed.sessions : [])
          .find((s) => s.sessionId === sessionId);
        if (match) {
          const title = nonEmptyString(match.title) ?? nonEmptyString(match.name);
          if (title) return title;
        }
      }
    } catch { /* best-effort */ }
    return null;
  }

  // ── Sub-card handlers: preset, model, status, help, compact ──────────────

  /**
   * Fetch the preset catalog and show the preset selection card.
   */
  async #showPresetCard(key, chatId, { updateMessageId = null } = {}) {
    try {
      const settings = await this.#harness.agentPresetSettings({ signal: this.#cardDataSignal() });
      const catalog = settings.agentPresetCatalog;
      // Inject the current preset id so the card can render the selection
      catalog._currentId = settings.agentPreset;
      await this.#sendCard(chatId, presetCard(catalog), { key, updateMessageId });
    } catch (error) {
      await this.#sendFailure(chatId, error, { logLabel: 'preset card', replyTo: updateMessageId });
    }
  }

  /**
   * Fetch the model catalog and show the model selection card.
   */
  async #showModelCard(key, chatId, { updateMessageId = null } = {}) {
    try {
      const signal = this.#cardDataSignal();
      await this.#harness.ensureRunning({ signal });
      // Try to get the session-bound catalog first, fall back to harness-level
      const sessionId = this.#state?.sessionFor?.(key);
      let catalog;
      if (typeof sessionId === 'string' && sessionId) {
        const session = this.#harness.workspaceSession(sessionId);
        if (session?.models) {
          catalog = await session.models({ signal });
        }
      }
      if (!catalog) {
        catalog = await this.#harness.listModels({ signal });
      }
      await this.#sendCard(chatId, modelCard(catalog), { key, updateMessageId });
    } catch (error) {
      await this.#sendFailure(chatId, error, { logLabel: 'model card', replyTo: updateMessageId });
    }
  }

  /**
   * Gather system status and show the status card.
   */
  async #showStatusText(key, chatId, replyTo = null) {
    try {
      await this.#harness.ensureRunning({ signal: this.#signal });
      const lines = [t('连接正常')];
      const ws = typeof this.#harness.currentWorkspace === 'function'
        ? this.#harness.currentWorkspace()
        : null;
      if (ws) lines.push(t('工作区：{workspace}', { workspace: ws }));
      const settings = typeof this.#harness.agentPresetSettings === 'function'
        ? await this.#harness.agentPresetSettings({ signal: this.#signal }).catch(() => null)
        : null;
      if (settings) {
        const item = settings.agentPresetCatalog?.items?.find((i) => i.id === settings.agentPreset);
        lines.push(t('预设：{preset}', {
          preset: item
            ? `${item.label}（${item.id}）`
            : (settings.agentPreset || t('跟随默认')),
        }));
      }
      await this.#send(chatId, lines.join('\n'), { replyTo });
    } catch (error) {
      await this.#sendFailure(chatId, error, { logLabel: 'status text', replyTo });
    }
  }

  async #showStatusCard(key, chatId, { updateMessageId = null } = {}) {
    try {
      const signal = this.#cardDataSignal();
      await this.#harness.ensureRunning({ signal });
      const info = { connected: true, workspace: null, preset: null, model: null, sessionCount: 0 };

      // Current workspace
      try {
        const ws = typeof this.#harness.currentWorkspace === 'function'
          ? this.#harness.currentWorkspace()
          : null;
        info.workspace = ws || t('未知');
      } catch { /* ignore */ }

      // Preset
      try {
        const settings = await this.#harness.agentPresetSettings({ signal });
        const item = settings.agentPresetCatalog.items.find((i) => i.id === settings.agentPreset);
        info.preset = item
          ? `${item.label}（${item.id}）`
          : (settings.agentPreset || t('跟随默认'));
      } catch { /* ignore */ }

      // Model (from bound session or harness)
      try {
        const sessionId = this.#state?.sessionFor?.(key);
        if (typeof sessionId === 'string' && sessionId) {
          const session = this.#harness.workspaceSession(sessionId);
          if (session?.models) {
            const cat = await session.models({ signal });
            if (cat.current) info.model = `${cat.current.provider}/${cat.current.model}`;
          }
        }
      } catch { /* ignore */ }

      // Session count
      try {
        const ws = typeof this.#harness.currentWorkspace === 'function'
          ? this.#harness.currentWorkspace()
          : null;
        if (ws) {
          const listed = await this.#harness.listWorkspaceSessions(ws, { signal });
          if (Array.isArray(listed?.sessions)) info.sessionCount = listed.sessions.length;
        }
      } catch { /* ignore */ }

      await this.#sendCard(chatId, statusCard(info), { key, updateMessageId });
    } catch (error) {
      await this.#sendFailure(chatId, error, { logLabel: 'status card', replyTo: updateMessageId });
    }
  }

  /**
   * Show the help card with all command descriptions.
   */
  async #showHelpCard(key, chatId, { updateMessageId = null } = {}) {
    await this.#sendCard(
      chatId,
      helpCard(WORKSPACE_HELP_LINES.map((line) => t(line))),
      { key, updateMessageId },
    );
  }

  /**
   * Run the /compact command and show the result.
   */
  async #handleCompact(key, chatId, replyTo = null) {
    try {
      const result = await runCompactCommand(
        '/compact', this.#harness, this.#state, key, { signal: this.#signal },
      );
      await this.#send(chatId, result?.message || t('上下文压缩失败。'), { replyTo });
    } catch (error) {
      await this.#sendFailure(chatId, error, { logLabel: 'compact', replyTo });
    }
  }

  /**
   * Stop the running task in the bound session (mirrors `/stop`).
   */
  async #handleStop(key, chatId, replyTo = null) {
    try {
      const result = await runControlCommand(
        '/stop', this.#harness, this.#state, key, {
          signal: this.#signal,
          control: { owner: this, key },
        },
      );
      if (result?.stopped) {
        await Promise.allSettled([
          this.#cancelPendingInteraction(key),
          this.#approvals.closeRoute(key),
        ]);
      }
      await this.#send(chatId, result?.message || t('/stop 执行完成。'), { replyTo });
    } catch (error) {
      await this.#sendFailure(chatId, error, { logLabel: 'stop', replyTo });
    }
  }

  /**
   * Show the steer card (quick-select dropdown + free-text input).
   */
  async #showSteerCard(key, chatId, { updateMessageId = null } = {}) {
    const hasSession = Boolean(this.#state.sessionFor?.(key));
    this.#rememberMenu(key, { kind: 'steer' });
    await this.#sendCard(chatId, steerCard({ hasSession }), { key, updateMessageId });
  }

  /**
   * Send a steer instruction to the bound session (mirrors `/steer <text>`).
   */
  async #sendSteer(entry, text) {
    const { key, chatId } = entry;
    const result = await runControlCommand(
      `/steer ${text}`, this.#harness, this.#state, key, {
        signal: this.#signal,
        pendingInteraction: this.#hasPendingInteraction(key),
        control: { owner: this, key },
      },
    );
    await this.#send(chatId, result?.message || t('已提交补充指令。'), { replyTo: entry.messageId ?? null });
  }

  /**
   * Reset the preset to follow the Host default.
   */
  async #handlePresetDefault(key, chatId, { updateMessageId = null, replyTo = null } = {}) {
    try {
      const result = await runPresetCommand(
        '/preset --default', this.#harness, this.#state, key, { signal: this.#signal },
      );
      for (const reply of result?.messages ?? [result?.message]) {
        if (reply) await this.#send(chatId, reply, { replyTo });
      }
    } catch (error) {
      await this.#sendFailure(chatId, error, { logLabel: 'preset reset', replyTo: updateMessageId });
      return;
    }
    try {
      await this.#sendMenuCard(key, chatId, { updateMessageId, replyTo });
    } catch (error) {
      this.#logger.warn?.('[dsh-feishu] menu refresh failed after preset reset:', error.message);
    }
  }

  /**
   * Handle preset selection from the preset dropdown.
   */
  async #handlePresetSelect(key, chatId, presetId, { updateMessageId = null, replyTo = null } = {}) {
    try {
      const selector = /^\d+$/u.test(presetId) ? `id:${presetId}` : presetId;
      const result = await runPresetCommand(
        `/preset ${selector}`, this.#harness, this.#state, key, { signal: this.#signal },
      );
      for (const reply of result?.messages ?? [result?.message]) {
        if (reply) await this.#send(chatId, reply, { replyTo });
      }
    } catch (error) {
      await this.#sendFailure(chatId, error, { logLabel: 'preset selection', replyTo: updateMessageId });
      return;
    }
    try {
      await this.#sendMenuCard(key, chatId, { updateMessageId, replyTo });
    } catch (error) {
      this.#logger.warn?.('[dsh-feishu] menu refresh failed after preset select:', error.message);
    }
  }

  /**
   * Handle model selection from the model dropdown.
   *
   * Reuses `runModelCommand` (the same path as the `/model <id>` text
   * command) so model IDs containing `/` (e.g.
   * `openrouter/anthropic/claude-sonnet-4`) keep working, and all the
   * catalog validation, busy checks, pending-interaction checks and the
   * session binding lock stay in one place.
   */
  async #handleModelSelect(key, chatId, modelId, { updateMessageId = null, replyTo = null } = {}) {
    try {
      const result = await runModelCommand(
        `/model ${modelId}`, this.#harness, this.#state, key, {
          signal: this.#signal,
          pendingInteraction: this.#hasPendingInteraction(key),
          control: { owner: this, key },
        },
      );
      for (const reply of result?.messages ?? [result?.message]) {
        if (reply) await this.#send(chatId, reply, { replyTo });
      }
    } catch (error) {
      await this.#sendFailure(chatId, error, { logLabel: 'model selection', replyTo: updateMessageId });
      return;
    }
    try {
      await this.#sendMenuCard(key, chatId, { updateMessageId, replyTo });
    } catch (error) {
      this.#logger.warn?.('[dsh-feishu] menu refresh failed after model select:', error.message);
    }
  }

  // ── Watches: read-only session tracking + completion pushes ─────────────

  #ensureEventWatcher() {
    if (this.#eventWatcher) return;
    if (typeof this.#harness?.watchHarnessEvents !== 'function') return;
    if (this.#signal?.aborted) return;
    const signal = this.#signal ?? new AbortController().signal;
    try {
      this.#eventWatcher = this.#harness.watchHarnessEvents({
        signal,
        onSessionEvent: (payload) => this.#onHarnessEvent(payload),
        onReconnect: () => {
          void this.#compensateMissedEvents();
        },
      });
      Promise.resolve(this.#eventWatcher).catch((error) => {
        if (!signal.aborted) {
          this.#logger.warn?.('[dsh-feishu] event watcher stopped:', error.message);
        }
      });
    } catch (error) {
      this.#eventWatcher = null;
      this.#logger.warn?.('[dsh-feishu] event watcher failed to start:', error.message);
    }
  }

  #queueEventTask(sessionId, task) {
    const previous = this.#eventTails.get(sessionId) ?? Promise.resolve();
    let next;
    next = previous.then(task, task).catch((error) => {
      if (!this.#signal?.aborted) {
        this.#logger.warn?.('[dsh-feishu] completion event failed:', error.message);
      }
    }).finally(() => {
      if (this.#eventTails.get(sessionId) === next) this.#eventTails.delete(sessionId);
    });
    this.#eventTails.set(sessionId, next);
    return next;
  }

  #pruneObservedCompletionEvents(now = Date.now()) {
    let total = 0;
    for (const [sessionId, observed] of this.#observedCompletionEvents) {
      for (const [seq, record] of observed) {
        if (!Number.isSafeInteger(record?.arrivalAt)
          || record.arrivalAt < 0
          || record.arrivalAt + COMPLETION_OBSERVATION_TTL_MS <= now) {
          observed.delete(seq);
        }
      }
      while (observed.size > MAX_OBSERVED_COMPLETIONS_PER_SESSION) {
        const oldest = observed.keys().next().value;
        if (oldest === undefined) break;
        observed.delete(oldest);
      }
      if (observed.size === 0) this.#observedCompletionEvents.delete(sessionId);
      else total += observed.size;
    }
    while (this.#observedCompletionEvents.size > MAX_OBSERVED_COMPLETION_SESSIONS) {
      const oldestSessionId = this.#observedCompletionEvents.keys().next().value;
      if (oldestSessionId === undefined) break;
      total -= this.#observedCompletionEvents.get(oldestSessionId)?.size ?? 0;
      this.#observedCompletionEvents.delete(oldestSessionId);
    }
    while (total > MAX_OBSERVED_COMPLETIONS) {
      const oldestSessionId = this.#observedCompletionEvents.keys().next().value;
      if (oldestSessionId === undefined) break;
      const observed = this.#observedCompletionEvents.get(oldestSessionId);
      const oldestSeq = observed?.keys().next().value;
      if (oldestSeq === undefined) {
        this.#observedCompletionEvents.delete(oldestSessionId);
        continue;
      }
      observed.delete(oldestSeq);
      total -= 1;
      if (observed.size === 0) this.#observedCompletionEvents.delete(oldestSessionId);
    }
  }

  #recordObservedCompletion(sessionId, event, now = Date.now()) {
    this.#pruneObservedCompletionEvents(now);
    let observed = this.#observedCompletionEvents.get(sessionId);
    if (!observed) observed = new Map();
    const rawReason = event?.data?.reason;
    const reason = typeof rawReason === 'string'
      ? rawReason
      : typeof rawReason?.kind === 'string'
        ? { kind: rawReason.kind }
        : null;
    observed.delete(event.seq);
    observed.set(event.seq, {
      arrivalAt: now,
      event: {
        type: 'turn/end',
        seq: event.seq,
        ...(Number.isSafeInteger(event.time) && event.time >= 0 ? { time: event.time } : {}),
        data: { reason },
      },
    });
    // Refresh the session as a unit so both session and entry eviction are LRU.
    this.#observedCompletionEvents.delete(sessionId);
    this.#observedCompletionEvents.set(sessionId, observed);
    this.#pruneObservedCompletionEvents(now);
  }

  /**
   * Resolve a /watch target READ-ONLY: a session id is validated against
   * the registered workspaces' listings, an index against the current
   * workspace. Nothing is bound and no workspace is switched.
   */
  async #resolveWatchTarget(target, { workspaceHint = null, signal = this.#signal } = {}) {
    if (typeof target !== 'string' || target === '') {
      return { error: t('用法：/watch <Session ID 或当前工作区序号>') };
    }
    const numeric = /^\d{1,4}$/.test(target) ? Number(target) : null;
    const currentPath = typeof this.#harness?.currentWorkspace === 'function'
      ? this.#harness.currentWorkspace()
      : null;
    const listSessions = async (workspace) => {
      const listed = await this.#harness.listWorkspaceSessions(workspace, { signal });
      return Array.isArray(listed?.sessions) ? listed.sessions : [];
    };
    if (numeric !== null) {
      if (!currentPath) return { error: t('当前机器人没有可用的工作区，无法按序号解析会话。') };
      const sessions = this.#visibleSessions(await listSessions(currentPath));
      const session = sessions[numeric - 1];
      if (!session?.sessionId) {
        return { error: t('当前工作区只有 {count} 个会话。', { count: sessions.length }) };
      }
      return {
        sessionId: session.sessionId,
        title: session.title ?? t('暂无标题'),
        workspace: currentPath,
        ...(validLastSeq(session.lastSeq) ? { lastSeq: session.lastSeq } : {}),
      };
    }
    let paths;
    if (nonEmptyString(workspaceHint)) {
      paths = [workspaceHint];
    } else {
      const extraPaths = typeof this.#harness?.listWorkspaces === 'function'
        ? (await this.#harness.listWorkspaces({ signal })).filter((path) => path !== currentPath)
        : [];
      paths = [currentPath, ...extraPaths].filter(Boolean);
    }
    for (const workspace of paths) {
      const sessions = await listSessions(workspace);
      const session = sessions.find((candidate) => candidate.sessionId === target);
      if (session) {
        return {
          sessionId: target,
          title: session.title ?? t('暂无标题'),
          workspace,
          ...(validLastSeq(session.lastSeq) ? { lastSeq: session.lastSeq } : {}),
        };
      }
    }
    return { error: t('没有找到这个会话，请用 /sessionlist 查看可用会话。') };
  }

  async #freshWatchTargets(workspace) {
    const selectedWorkspace = nonEmptyString(workspace)
      ?? (typeof this.#harness?.currentWorkspace === 'function'
        ? nonEmptyString(this.#harness.currentWorkspace())
        : null);
    if (!selectedWorkspace || typeof this.#harness?.listWorkspaceSessions !== 'function') {
      return new Map();
    }
    const listed = await this.#harness.listWorkspaceSessions(
      selectedWorkspace,
      { signal: this.#cardDataSignal() },
    );
    return new Map(this.#visibleSessions(Array.isArray(listed?.sessions) ? listed.sessions : [])
      .filter((session) => nonEmptyString(session?.sessionId))
      .map((session) => [session.sessionId, {
        sessionId: session.sessionId,
        title: session.title ?? session.name ?? t('暂无标题'),
        workspace: selectedWorkspace,
        ...(validLastSeq(session.lastSeq) ? { lastSeq: session.lastSeq } : {}),
      }]));
  }

  #scheduleCompensation(sessionId) {
    const pending = this.#pendingCompensations.get(sessionId);
    if (pending) {
      pending.requested = true;
      return pending.promise;
    }
    const state = { requested: true, promise: null };
    this.#pendingCompensations.set(sessionId, state);
    state.promise = Promise.resolve().then(async () => {
      try {
        // A watch can be persisted after an in-progress compensation already
        // snapshotted its keys. Remember that request and run one trailing pass.
        do {
          state.requested = false;
          await this.#queueEventTask(sessionId, () => this.#compensateSession(sessionId));
        } while (state.requested && !this.#signal?.aborted);
      } finally {
        if (this.#pendingCompensations.get(sessionId) === state) {
          this.#pendingCompensations.delete(sessionId);
        }
      }
    });
    return state.promise;
  }

  async #runWatch(key, chatId, target, {
    notify = true,
    validatedTarget = null,
    workspaceHint = null,
    replyTo = null,
  } = {}) {
    const watchRequestedAt = Date.now();
    const reply = async (message) => {
      if (!notify) return;
      await this.#send(chatId, message, { replyTo }).catch((error) => {
        this.#logger.warn?.('[dsh-feishu] watch notification failed:', error.message);
      });
    };
    this.#ensureEventWatcher();
    if (typeof this.#state?.setWatch !== 'function') {
      await reply(t('当前状态存储不支持关注。'));
      return { ok: false, changed: false, reason: 'unsupported' };
    }
    let resolved;
    try {
      resolved = validatedTarget?.sessionId === target
        ? validatedTarget
        : await this.#resolveWatchTarget(target, {
          workspaceHint,
          signal: workspaceHint ? this.#cardDataSignal() : this.#signal,
        });
    } catch (error) {
      await reply(t('无法解析会话：{message}', { message: safeErrorText(error) }));
      return { ok: false, changed: false, reason: 'resolve' };
    }
    if (resolved.error) {
      await reply(resolved.error);
      return { ok: false, changed: false, reason: 'not-found' };
    }
    const existing = this.#state.watchEntries?.(key) ?? [];
    const existingEntry = existing.find((entry) => entry.sessionId === resolved.sessionId);
    if (!existingEntry && existing.length >= MAX_WATCHES_PER_KEY) {
      await reply(t('每个聊天最多关注 {count} 个会话。', { count: MAX_WATCHES_PER_KEY }));
      return { ok: false, changed: false, reason: 'limit' };
    }
    const lastSeq = validLastSeq(existingEntry?.lastSeq)
      ? existingEntry.lastSeq
      : validLastSeq(resolved.lastSeq)
        ? resolved.lastSeq
        : null;
    // session.list's projection asOfSeq can be stale for a cold session. Every
    // new watch therefore keeps a durable wall-clock boundary; lastSeq is only
    // a lower bound for the history scan. Existing settled and legacy entries
    // keep their prior semantics when /watch is repeated.
    const existingBoundary = watchBoundary(existingEntry);
    const watchStartedAt = existingBoundary ?? (existingEntry ? null : watchRequestedAt);
    try {
      await this.#state.setWatch(key, {
        sessionId: resolved.sessionId,
        title: resolved.title,
        chatId,
        lastSeq,
        ...(watchStartedAt !== null ? { watchStartedAt } : {}),
        // Remember where the watch was created so completion pushes can be
        // delivered as replies inside the same Feishu topic.
        ...(replyTo
          ? { replyToMessageId: replyTo }
          : existingEntry?.replyToMessageId
            ? { replyToMessageId: existingEntry.replyToMessageId }
            : {}),
      });
    } catch (error) {
      await reply(t('关注失败：{message}', { message: safeErrorText(error) }));
      return { ok: false, changed: false, reason: 'persist' };
    }
    // Always compensate a newly created or still-unsettled watch. This closes
    // both target-list and durable-persistence windows.
    if (!existingEntry || watchStartedAt !== null || !validLastSeq(lastSeq)) {
      void this.#scheduleCompensation(resolved.sessionId);
    }
    await reply(t('已关注会话「{title}」，任务完成会推送结果。', { title: String(resolved.title).replace(/\s+/gu, ' ') }));
    return { ok: true, changed: !existingEntry, entry: this.#state.watchEntry?.(key, resolved.sessionId) };
  }

  async #runUnwatch(key, chatId, target, { notify = true, replyTo = null } = {}) {
    const reply = async (message) => {
      if (!notify) return;
      await this.#send(chatId, message, { replyTo }).catch((error) => {
        this.#logger.warn?.('[dsh-feishu] unwatch notification failed:', error.message);
      });
    };
    if (typeof this.#state?.removeWatch !== 'function') {
      return { ok: false, changed: false, reason: 'unsupported' };
    }
    const entries = this.#state.watchEntries?.(key) ?? [];
    const entry = typeof target === 'string' && /^\d{1,4}$/.test(target)
      ? entries[Number(target) - 1]
      : entries.find((candidate) => candidate.sessionId === target);
    if (!entry) {
      await reply(t('关注列表里没有这个会话，回复 /watchlist 查看。'));
      return { ok: true, changed: false, reason: 'absent' };
    }
    try {
      await this.#state.removeWatch(key, entry.sessionId);
      this.#failedWatchSeqs.delete(`${key}\0${entry.sessionId}`);
    } catch (error) {
      await reply(t('取消失败：{message}', { message: safeErrorText(error) }));
      return { ok: false, changed: false, reason: 'persist' };
    }
    await reply(t('已取消关注「{title}」。', { title: String(entry.title ?? '').replace(/\s+/gu, ' ') }));
    return { ok: true, changed: true, entry };
  }

  async #showWatchList(key, chatId, { updateMessageId = null, replyTo = null } = {}) {
    const entries = this.#state.watchEntries?.(key) ?? [];
    // 收集可选会话（用于「添加关注」多选下拉）；失败则传空数组 → 只渲染移除/列表。
    let availableSessions = [];
    let currentWorkspace = null;
    try {
      currentWorkspace = typeof this.#harness?.currentWorkspace === 'function'
        ? this.#harness.currentWorkspace()
        : null;
      if (currentWorkspace && typeof this.#harness?.listWorkspaceSessions === 'function') {
        const listed = await this.#harness.listWorkspaceSessions(
          currentWorkspace,
          { signal: this.#cardDataSignal() },
        );
        availableSessions = this.#visibleSessions(
          Array.isArray(listed?.sessions) ? listed.sessions : [],
        )
          .map((session) => ({
            sessionId: session.sessionId,
            title: session.title ?? session.name ?? session.sessionId,
          }));
      }
    } catch { /* add-select section degrades to remove-only */ }
    this.#rememberMenu(key, { kind: 'watches', entries });
    await this.#sendCard(
      chatId,
      watchListCard(entries, availableSessions),
      {
        key,
        updateMessageId,
        replyTo,
        sessionWorkspace: currentWorkspace,
      },
    );
  }

  /** Queue live turn completions behind any reconnect compensation. */
  #onHarnessEvent({ sessionId, event }) {
    if (this.#signal?.aborted
      || !sessionId
      || !event
      || typeof event !== 'object'
      || event.type !== 'turn/end'
      || !validEventSeq(event.seq)) return;
    // Record before consulting state: /watch may still be resolving its target
    // or waiting for setWatch persistence and therefore have no visible entry.
    this.#recordObservedCompletion(sessionId, event);
    void this.#queueEventTask(sessionId, async () => {
      const keys = this.#state.keysWatching?.(sessionId) ?? [];
      const needsBaseline = keys.some((key) => (
        watchNeedsBaseline(this.#state.watchEntry?.(key, sessionId))
      ));
      const hasFailedDelivery = keys
        .some((key) => this.#failedWatchSeqs.has(`${key}\0${sessionId}`));
      if (needsBaseline || hasFailedDelivery) await this.#compensateSession(sessionId);
      await this.#deliverCompletion(sessionId, event);
    });
  }

  async #deliverCompletion(sessionId, event, { keys: targetKeys = null } = {}) {
    if (this.#signal?.aborted || typeof this.#state?.keysWatching !== 'function') return;
    const reason = event?.data?.reason?.kind ?? event?.data?.reason ?? null;
    const keys = targetKeys ?? this.#state.keysWatching(sessionId);
    for (const key of keys) {
      if (this.#signal?.aborted) return;
      const entry = this.#state.watchEntry?.(key, sessionId);
      const deliveryKey = `${key}\0${sessionId}`;
      let failedSeq = this.#failedWatchSeqs.get(deliveryKey);
      if (validEventSeq(failedSeq)
        && validLastSeq(entry?.lastSeq)
        && entry.lastSeq >= failedSeq) {
        this.#failedWatchSeqs.delete(deliveryKey);
        failedSeq = undefined;
      }
      if (!entry?.chatId
        || watchNeedsBaseline(entry)
        || (validLastSeq(entry.lastSeq) && entry.lastSeq >= event.seq)
        || (validEventSeq(failedSeq) && event.seq > failedSeq)) continue;
      try {
        await this.#sendCard(
          entry.chatId,
          completionCard(sessionId, entry.title, reason),
          { key, replyTo: entry.replyToMessageId ?? null },
        );
        const current = this.#state.watchEntry?.(key, sessionId);
        if (!current
          || current.chatId !== entry.chatId
          || watchNeedsBaseline(current)
          || (validLastSeq(current.lastSeq) && current.lastSeq >= event.seq)) continue;
        await this.#state.setWatch(key, { ...current, lastSeq: event.seq });
        if (failedSeq === event.seq) this.#failedWatchSeqs.delete(deliveryKey);
      } catch (error) {
        this.#failedWatchSeqs.set(
          deliveryKey,
          validEventSeq(failedSeq) ? Math.min(failedSeq, event.seq) : event.seq,
        );
        this.#logger.warn?.('[dsh-feishu] completion push failed:', error.message);
      }
    }
  }

  async #compensateSession(sessionId) {
    if (this.#signal?.aborted || typeof this.#harness?.rpc !== 'function') return;
    try {
      const history = await this.#harness.rpc(
        'session.history',
        { sessionId, maxMessages: 20 },
        30_000,
        { signal: this.#signal },
      );
      const historicalEvents = orderedHistoryEvents(history);
      this.#pruneObservedCompletionEvents();
      const observed = this.#observedCompletionEvents.get(sessionId) ?? new Map();
      const eventsBySeq = new Map(historicalEvents.map((event) => [event.seq, event]));
      // The event mux can be ahead of the history projection. Retain a bounded,
      // minimal completion payload so a pre-persistence live frame is not lost.
      for (const [seq, record] of observed) {
        if (!eventsBySeq.has(seq)) eventsBySeq.set(seq, record.event);
      }
      const events = [...eventsBySeq.values()].sort((left, right) => left.seq - right.seq);
      const latestSeq = events.at(-1)?.seq ?? -1;
      const keys = typeof this.#state?.keysWatching === 'function'
        ? this.#state.keysWatching(sessionId)
        : [];

      // Establish independent baselines for every chat watching this Session.
      // New watches carry a durable wall-clock boundary; old persisted null
      // watches retain the legacy "baseline latest without replay" behavior.
      for (const key of keys) {
        const entry = this.#state.watchEntry?.(key, sessionId);
        if (!watchNeedsBaseline(entry)) continue;
        const watchStartedAt = watchBoundary(entry);
        const lowerBound = validLastSeq(entry.lastSeq) ? entry.lastSeq : -1;
        const firstKnownNew = watchStartedAt === null
          ? null
          : events.find((event) => {
            if (event.seq <= lowerBound) return false;
            const eventTime = Number.isSafeInteger(event.time) && event.time >= 0
              ? event.time
              : observed.get(event.seq)?.arrivalAt;
            return Number.isSafeInteger(eventTime) && eventTime >= watchStartedAt;
          });
        // Unknown events before the first event proven post-boundary are
        // conservatively part of the baseline. Sequence order proves all later
        // events are post-boundary. With no proof, replay nothing.
        const baselineSeq = firstKnownNew
          ? Math.max(lowerBound, firstKnownNew.seq - 1)
          : Math.max(lowerBound, latestSeq);
        const current = this.#state.watchEntry?.(key, sessionId);
        if (!current
          || current.chatId !== entry.chatId
          || current.lastSeq !== entry.lastSeq
          || watchBoundary(current) !== watchStartedAt) continue;
        const { watchStartedAt: _watchStartedAt, ...settled } = current;
        await this.#state.setWatch(key, { ...settled, lastSeq: baselineSeq });
      }

      for (const event of events) {
        if (event.type === 'turn/end') await this.#deliverCompletion(sessionId, event, { keys });
      }
    } catch (error) {
      if (!this.#signal?.aborted) {
        this.#logger.warn?.(`[dsh-feishu] watch compensation failed for ${sessionId}:`, error.message);
      }
    }
  }

  /** Replay recent turn completions missed while the mux was disconnected. */
  async #compensateMissedEvents() {
    const sessionIds = typeof this.#state?.watchedSessionIds === 'function'
      ? this.#state.watchedSessionIds()
      : [];
    if (this.#signal?.aborted) return;
    await Promise.allSettled(sessionIds.map((sessionId) => this.#scheduleCompensation(sessionId)));
  }

  #interactionAskOptions(event, key, files) {
    return {
      timeoutMs: this.#replyTimeoutMs,
      signal: this.#signal,
      control: { owner: this, key },
      onInteraction: (interaction) => this.#handleInteraction(interaction, {
        key,
        actor: senderOpenId(event),
        chatId: event.message.chat_id,
        requiresMention: event.message.chat_type !== 'p2p',
        replyToMessageId: event.message.message_id,
      }),
      onInteractionResolved: (resolution) => this.#handleInteractionResolved(resolution),
      files,
    };
  }

  async #sendAnswerText(chatId, answer, { deliveryId, presentation, replyTo = null }) {
    const providerMessageIds = [];
    for (const chunk of splitText(answer)) {
      this.#signal?.throwIfAborted();
      const messageId = await this.#send(chatId, chunk, { replyTo });
      if (messageId) providerMessageIds.push(messageId);
    }
    return createDeliveryReceipt({
      deliveryId,
      presentation,
      providerMessageIds,
    });
  }

  async #deliverArtifacts(chatId, replyTo, artifacts = [], baseReceipt) {
    const delivery = await deliverOutboundArtifacts({
      artifacts,
      baseReceipt,
      deliveryId: baseReceipt?.deliveryId ?? artifacts[0]?.deliveryKey ?? replyTo,
      aggregatePresentation: baseReceipt ? 'feishu-text-and-files' : 'feishu-files',
      channelKey: 'feishu',
      signal: this.#signal,
      sendImage: typeof this.#channel?.sendImage === 'function'
        ? (file) => this.#channel.sendImage(chatId, file, {
            replyTo,
            signal: this.#signal,
          })
        : undefined,
      sendFile: typeof this.#channel?.sendFile === 'function'
        ? (file) => this.#channel.sendFile(chatId, file, {
            replyTo,
            signal: this.#signal,
          })
        : undefined,
      onFailure: (artifact, error) => setLastMessageFailure(this.#status, error, {
        userMessage: artifactFailureText(artifact?.fileName, error),
        reason: error?.code,
      }),
      sendFailureNotice: async (_artifact, _error, failure) => ({
        messageId: await this.#send(
          chatId,
          messageFailureText(failure),
        ),
      }),
      logger: this.#logger,
    });
    this.#status.artifactsSent = (this.#status.artifactsSent ?? 0)
      + delivery.artifactsSent;
    this.#status.artifactSendErrors = (this.#status.artifactSendErrors ?? 0)
      + delivery.artifactSendErrors;
    if (!delivery.receipt) {
      return {
        receipt: createDeliveryReceipt({
          deliveryId: replyTo,
          presentation: 'feishu-files',
        }),
        failureNoticeVisible: delivery.failureNoticeVisible,
        artifactSendErrors: delivery.artifactSendErrors,
      };
    }
    return {
      receipt: delivery.receipt,
      failureNoticeVisible: delivery.failureNoticeVisible,
      artifactSendErrors: delivery.artifactSendErrors,
    };
  }

  async #answerWithStream(event, key, message, { onAskComplete } = {}) {
    const chatId = event.message.chat_id;
    const messageId = event.message.message_id;
    const text = message.content;
    let askCompleted = false;
    const markAskComplete = () => {
      if (askCompleted) return;
      askCompleted = true;
      onAskComplete?.();
    };
    let content = hasInboundImages(message) || hasReplyReference(message)
      ? await promptContentForInboundMessage(message, { signal: this.#signal })
      : undefined;
    const snapshot = this.#acceptedMessageIds.get(messageId);
    let contextEnhanced = false;
    if (snapshot) {
      const originalContent = content ?? text;
      content = enhanceContextContent(originalContent, snapshot, () => ({
        channel: 'feishu',
        senderId: senderOpenId(event),
        chatId: event.message.chat_id,
        threadId: event.message.thread_id,
      }));
      contextEnhanced = content !== originalContent;
    }
    if (!this.#channel?.stream) {
      const { answer, artifacts = [] } = await askInWorkspaceSession({
        harness: this.#harness,
        state: this.#state,
        key,
        text,
        content,
        contextEnhanced,
        createOptions: { signal: this.#signal },
        existsOptions: { signal: this.#signal },
        askOptions: this.#interactionAskOptions(event, key, message.files),
      });
      markAskComplete();
      let textReceipt;
      let textSendError = null;
      try {
        textReceipt = await this.#sendAnswerText(
          chatId,
          answerTextForDelivery(answer, artifacts),
          {
            deliveryId: messageId,
            presentation: 'feishu-text',
            replyTo: messageId,
          },
        );
      } catch (error) {
        textSendError = channelDeliveryFailure(error);
        this.#logger.warn?.(
          '[dsh-feishu] final text delivery failed; continuing with result files:',
          error,
        );
      }
      const delivery = await this.#deliverArtifacts(chatId, messageId, artifacts, textReceipt);
      const artifactDispatched = delivery.receipt.artifacts.some(
        ({ outcome }) => outcome === 'sent' || outcome === 'unknown',
      );
      if (textSendError && !artifactDispatched && !delivery.failureNoticeVisible) {
        throw textSendError;
      }
      if (textSendError && delivery.artifactSendErrors === 0) {
        setLastMessageFailure(this.#status, textSendError);
      }
      this.#status.streamFallbacks = (this.#status.streamFallbacks ?? 0) + 1;
      return { ...delivery, textDeliveryErrors: textSendError ? 1 : 0 };
    }

    let promptStarted = false;
    let completedAnswer = '';
    let completedArtifacts = [];
    let stream;
    try {
      stream = await this.#channel.stream(chatId, {
        markdown: async (controller) => {
          promptStarted = true;
          const baseAskOptions = this.#interactionAskOptions(event, key, message.files);
          const askOptions = {
            ...baseAskOptions,
            // issue #86：独立交互消息（提问/审批）会落在占位卡下方，呈现前
            // 先换卡，让最终答案落在交互消息之后的新流式卡上。
            onInteraction: async (interaction) => {
              if ((interaction?.kind === 'question' || interaction?.kind === 'approval')
                && typeof controller?.rotate === 'function') {
                await controller.rotate();
              }
              await baseAskOptions.onInteraction(interaction);
            },
            onUpdate: async (update) => {
              await controller.setContent(this.#progressText(update));
              this.#status.streamUpdates = (this.#status.streamUpdates ?? 0) + 1;
            },
          };
          const completed = await askInWorkspaceSession({
            harness: this.#harness,
            state: this.#state,
            key,
            text,
            content,
            contextEnhanced,
            createOptions: { signal: this.#signal },
            existsOptions: { signal: this.#signal },
            askOptions,
          });
          markAskComplete();
          completedAnswer = completed.answer;
          completedArtifacts = completed.artifacts ?? [];
          await controller.setContent(answerTextForDelivery(completedAnswer, completedArtifacts));
        },
      }, { replyTo: messageId });
    } catch (error) {
      this.#status.streamErrors = (this.#status.streamErrors ?? 0) + 1;
      if (completedAnswer || completedArtifacts.length > 0) {
        this.#logger.warn?.(
          '[dsh-feishu] native stream failed after generation; sending final text:',
          error.message,
        );
        let textReceipt;
        let textSendError = null;
        try {
          textReceipt = await this.#sendAnswerText(
            chatId,
            answerTextForDelivery(completedAnswer, completedArtifacts),
            {
              deliveryId: messageId,
              presentation: 'feishu-text-fallback',
              replyTo: messageId,
            },
          );
        } catch (fallbackError) {
          textSendError = channelDeliveryFailure(fallbackError);
          this.#logger.warn?.(
            '[dsh-feishu] fallback text delivery failed; continuing with result files:',
            fallbackError,
          );
        }
        const delivery = await this.#deliverArtifacts(
          chatId,
          messageId,
          completedArtifacts,
          textReceipt,
        );
        const artifactDispatched = delivery.receipt.artifacts.some(
          ({ outcome }) => outcome === 'sent' || outcome === 'unknown',
        );
        if (textSendError && !artifactDispatched && !delivery.failureNoticeVisible) {
          throw textSendError;
        }
        if (textSendError && delivery.artifactSendErrors === 0) {
          setLastMessageFailure(this.#status, textSendError);
        }
        this.#status.streamFallbacks = (this.#status.streamFallbacks ?? 0) + 1;
        return { ...delivery, textDeliveryErrors: textSendError ? 1 : 0 };
      }
      if (promptStarted) throw error;

      this.#logger.warn?.('[dsh-feishu] native stream unavailable; using text fallback:', error.message);
      const { answer, artifacts = [] } = await askInWorkspaceSession({
        harness: this.#harness,
        state: this.#state,
        key,
        text,
        content,
        contextEnhanced,
        createOptions: { signal: this.#signal },
        existsOptions: { signal: this.#signal },
        askOptions: this.#interactionAskOptions(event, key, message.files),
      });
      markAskComplete();
      let textReceipt;
      let textSendError = null;
      try {
        textReceipt = await this.#sendAnswerText(
          chatId,
          answerTextForDelivery(answer, artifacts),
          {
            deliveryId: messageId,
            presentation: 'feishu-text-fallback',
            replyTo: messageId,
          },
        );
      } catch (fallbackError) {
        textSendError = channelDeliveryFailure(fallbackError);
        this.#logger.warn?.(
          '[dsh-feishu] fallback text delivery failed; continuing with result files:',
          fallbackError,
        );
      }
      const delivery = await this.#deliverArtifacts(chatId, messageId, artifacts, textReceipt);
      const artifactDispatched = delivery.receipt.artifacts.some(
        ({ outcome }) => outcome === 'sent' || outcome === 'unknown',
      );
      if (textSendError && !artifactDispatched && !delivery.failureNoticeVisible) {
        throw textSendError;
      }
      if (textSendError && delivery.artifactSendErrors === 0) {
        setLastMessageFailure(this.#status, textSendError);
      }
      this.#status.streamFallbacks = (this.#status.streamFallbacks ?? 0) + 1;
      return { ...delivery, textDeliveryErrors: textSendError ? 1 : 0 };
    }
    const delivery = await this.#deliverArtifacts(
      chatId,
      messageId,
      completedArtifacts,
      createDeliveryReceipt({
        deliveryId: messageId,
        presentation: 'feishu-cardkit',
        providerMessageIds: providerMessageIdsFor(stream),
      }),
    );
    this.#status.streamResponses = (this.#status.streamResponses ?? 0) + 1;
    return delivery;
  }

  async #processInteractionReply(event, messageId, key, expected, processingReaction) {
    this.#signal?.throwIfAborted();
    const current = this.#pendingInteractions.get(key);
    const claimed = expected.claimedReplyMessageId === messageId;
    if (!current || current !== expected || current.submitting) {
      if (this.#isResolvedQuestionReply(event, key)) {
        return this.#discardResolvedInteractionReply(event, messageId);
      }
      if (claimed && (!current || current !== expected)) {
        return this.#discardResolvedInteractionReply(event, messageId);
      }
      return this.#enqueueMessage(event, messageId, key, processingReaction, {
        releaseMessageId: false,
        finalize: false,
      });
    }
    if (this.#state.hasSeen(messageId)) return;
    await this.#state.markSeen(messageId);
    this.#status.lastMessageAt = new Date().toISOString();
    this.#status.messagesReceived += 1;

    const text = extractText(event);
    if (!text) {
      await this.#send(event.message.chat_id, t('请用文字回答当前问题。'));
      return;
    }

    const pending = this.#pendingInteractions.get(key);
    if (!pending || pending !== expected || pending.submitting) {
      if (this.#isResolvedQuestionReply(event, key)) {
        await this.#send(event.message.chat_id, INTERACTION_RESOLVED_TEXT(), { replyTo: event.message.message_id }).catch(() => undefined);
        return;
      }
      if (claimed && (!pending || pending !== expected)) {
        await this.#send(event.message.chat_id, INTERACTION_RESOLVED_TEXT(), { replyTo: event.message.message_id });
        return;
      }
      return this.#enqueueMessage(event, messageId, key, processingReaction, {
        releaseMessageId: false,
        alreadyRecorded: true,
        finalize: false,
      });
    }
    pending.chatId = event.message.chat_id;
    if (pending.needsPresentation) {
      try {
        await this.#presentInteraction(pending);
      } catch {
        this.#status.lastError = '飞书交互问题发送失败。';
        this.#logger.error?.('[dsh-feishu] failed to retry an interaction question');
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
        this.#status.lastError = '飞书交互问题发送失败。';
        this.#logger.error?.('[dsh-feishu] failed to send the next interaction question');
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
      this.#rememberResolvedInteraction(key, pending);
      this.#clearPendingInteraction(key, pending.interactionId);
      this.#status.lastError = null;
    } catch (error) {
      if (this.#signal?.aborted) return;
      if (this.#pendingInteractions.get(key) !== pending) return;
      if (error?.code === 'interaction-not-pending') {
        this.#rememberResolvedInteraction(key, pending);
        this.#clearPendingInteraction(key, pending.interactionId);
        await this.#send(event.message.chat_id, INTERACTION_RESOLVED_TEXT(), { replyTo: event.message.message_id }).catch(() => undefined);
        return;
      }
      pending.submitting = false;
      pending.answers.pop();
      pending.index -= 1;
      this.#status.lastError = '回答提交失败。';
      this.#logger.error?.('[dsh-feishu] failed to answer a Harness interaction');
      await this.#send(event.message.chat_id, t('回答提交失败，请重新发送当前问题的答案。'))
        .catch(() => undefined);
    }
  }

  async #handleInteraction(interaction, {
    key,
    actor,
    chatId,
    requiresMention,
    replyToMessageId,
  }) {
    if (await this.#approvals.handleRequested(interaction, {
      key,
      actor,
      requiresMention,
      send: (text) => this.#send(chatId, text, { replyTo: replyToMessageId }),
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
      this.#logger.warn?.('[dsh-feishu] ignored an invalid Harness question interaction');
      return;
    }

    if (interaction.recovered === true) {
      await interaction.respond({
        ok: false,
        error: {
          code: 'cancelled',
          message: 'Feishu safely cancelled an interaction left by an earlier client.',
          details: {},
        },
      });
      await this.#send(
        chatId,
        t('检测到这个 Session 中遗留的待回答问题，已安全取消并继续处理你刚才的消息。'),
        { replyTo: replyToMessageId },
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
      await interaction.respond({
        ok: false,
        error: {
          code: 'cancelled',
          message: 'Feishu is already handling another user interaction.',
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
      key,
      actor,
      requiresMention,
      questions,
      answers: [],
      index: 0,
      chatId,
      replyToMessageId,
      queue: null,
      claimedReplyMessageId: null,
      submitting: false,
      needsPresentation: true,
      questionMessageIds: new Set(),
      inactive: false,
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
    const pending = this.#pendingInteractions.get(key);
    if (pending) this.#rememberResolvedInteraction(key, pending);
    this.#clearPendingInteraction(key, interactionId);
  }

  async #presentInteraction(pending) {
    const question = pending.questions[pending.index];
    if (!question) return;
    const messageId = await this.#send(
      pending.chatId,
      harnessQuestionText(
        question,
        pending.index,
        pending.questions.length,
        { requiresMention: pending.requiresMention },
      ),
      // Reply to the message that started the turn so the question lands in
      // the same Feishu thread/topic instead of the group's default area.
      { replyTo: pending.replyToMessageId },
    );
    if (messageId) {
      pending.questionMessageIds.add(messageId);
      if (pending.inactive) this.#rememberResolvedInteraction(pending.key, pending);
    }
    pending.needsPresentation = false;
  }

  #rememberResolvedInteraction(key, pending) {
    const expiresAt = Date.now() + RESOLVED_REPLY_TTL_MS;
    for (const messageId of pending.questionMessageIds ?? []) {
      this.#resolvedQuestionReplies.set(messageId, { key, expiresAt });
    }
  }

  #isResolvedQuestionReply(event, key) {
    const now = Date.now();
    for (const [messageId, resolution] of this.#resolvedQuestionReplies) {
      if (resolution.expiresAt <= now) this.#resolvedQuestionReplies.delete(messageId);
    }
    for (const reference of [event?.message?.parent_id, event?.message?.root_id]) {
      const resolution = this.#resolvedQuestionReplies.get(reference);
      if (resolution?.key === key && resolution.expiresAt > now) return true;
    }
    return false;
  }

  async #discardResolvedInteractionReply(event, messageId) {
    if (this.#state.hasSeen(messageId)) return;
    await this.#state.markSeen(messageId);
    this.#status.lastMessageAt = new Date().toISOString();
    this.#status.messagesReceived += 1;
    await this.#send(event.message.chat_id, INTERACTION_RESOLVED_TEXT(), { replyTo: event.message.message_id }).catch(() => undefined);
  }

  #takePendingInteraction(key, interactionId) {
    const pending = this.#pendingInteractions.get(key);
    if (!pending
      || (interactionId !== undefined && pending.interactionId !== interactionId)) return null;
    this.#pendingInteractions.delete(key);
    this.#interactionKeys.delete(pending.interactionId);
    pending.inactive = true;
    return pending;
  }

  #clearPendingInteraction(key, interactionId) {
    return this.#takePendingInteraction(key, interactionId) !== null;
  }

  async #cancelPendingInteraction(key) {
    const pending = this.#takePendingInteraction(key);
    if (!pending || pending.kind !== 'question') return;
    this.#rememberResolvedInteraction(key, pending);
    try {
      await pending.interaction.respond({
        ok: false,
        error: {
          code: 'cancelled',
          message: 'The Feishu interaction ended before the user answered.',
          details: {},
        },
      }, { signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      if (error?.code !== 'interaction-not-pending') {
        this.#logger.warn?.('[dsh-feishu] failed to cancel a pending Harness interaction');
      }
    }
  }

  #progressText(update) {
    if (update.type === 'text' && update.text) return update.text;
    if (update.type === 'tool') {
      if (update.name === 'web_search') return t('_正在搜索网络并整理信息…_');
      return t('_正在使用 {name}…_', { name: update.name || t('工具') });
    }
    return t('_{text}_', { text: update.text || t('正在处理…') });
  }

  #beginReaction(messageId) {
    return beginStatusReaction({
      adapter: this.#channel,
      target: messageId,
      reactions: { processing: 'OnIt', success: 'DONE', error: 'ERROR' },
      status: this.#status,
      logger: this.#logger,
      label: 'feishu',
    });
  }

  #removeProcessingReaction(_messageId, processingReaction) {
    processingReaction.clear();
  }

  #finishReaction(_messageId, processingReaction, finalEmojiType) {
    if (finalEmojiType === 'ERROR') processingReaction.error();
    else processingReaction.success();
  }

  async #send(chatId, text, { replyTo } = {}) {
    const content = JSON.stringify({ text });
    if (replyTo) {
      try {
        const response = await this.#client.im.v1.message.reply({
          path: { message_id: replyTo },
          data: { msg_type: 'text', content },
        });
        if (response?.code && response.code !== 0) {
          throw new Error(`Feishu reply failed: ${response.msg || response.code}`);
        }
        return nonEmptyString(response?.data?.message_id);
      } catch (error) {
        // The referenced message may be gone (recalled/deleted); keep the
        // delivery promise by falling back to a plain chat message.
        this.#logger.warn?.(
          '[dsh-feishu] threaded reply failed; falling back to a plain message:',
          error?.message ?? String(error),
        );
      }
    }
    const response = await this.#client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content,
      },
    });
    if (response?.code && response.code !== 0) {
      throw new Error(`Feishu send failed: ${response.msg || response.code}`);
    }
    return nonEmptyString(response?.data?.message_id);
  }
}
