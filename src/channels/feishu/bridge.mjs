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
  imagePromptUserMessage,
  promptContentForMessage,
} from '../shared/image-prompt.mjs';
import {
  harnessAnswerForQuestion,
  harnessQuestionText,
  validHarnessQuestion,
} from '../shared/harness-question.mjs';
import { HarnessApprovalQueue } from '../shared/harness-approval.mjs';
import { runCompactCommand } from '../shared/compact-command.mjs';
import { rememberConnectionTestTarget } from '../shared/connection-test.mjs';
import { runWorkspaceCommand, resolveSessionListWorkspace, workspacePathSnapshot } from '../shared/workspace-command.mjs';
import { askInWorkspaceSession } from '../shared/workspace-session.mjs';
import {
  completionCard,
  MENU_PAGE_SIZE,
  menuCard,
  menuHelpText,
  sessionListCard,
  watchListCard,
  workspaceListCard,
} from './feishu-cards.mjs';

const INTERACTION_RESOLVED_TEXT = '这个问题已在其他客户端处理，无需再次回答。';
const RESOLVED_REPLY_TTL_MS = 30 * 60_000;

const MENU_COMMAND = /^\/m(?:enu)?$/i;
const WATCH_COMMAND = /^\/watch(?:\s+([^\s]+))?$/i;
const UNWATCH_COMMAND = /^\/unwatch(?:\s+([^\s]+))?$/i;
const WATCHLIST_COMMAND = /^\/watchlist$/i;
const SESSION_LIST_PREFIX = /^\/sessionlist(?:\s|$)/i;
const WORKSPACE_LIST_COMMAND = /^\/workspacelist$/i;
const NUMBER_REPLY = /^\d{1,2}$/;
/** A displayed menu stays number-tappable for this long. */
const MENU_TTL_MS = 10 * 60_000;
const MAX_TRACKED_MENUS = 50;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Human text for a turn-end reason (completion notifications). */
function describeTurnEnd(reason) {
  switch (reason?.kind) {
    case 'error': return '处理出错';
    case 'aborted': return '已停止';
    case 'max-tokens': return '达到输出上限，已截断';
    default: return '已完成';
  }
}

function senderOpenId(event) {
  return nonEmptyString(event?.sender?.sender_id?.open_id)
    ?? nonEmptyString(event?.sender?.sender_id?.user_id);
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
}

export class FeishuHarnessBridge {
  #client;
  #channel;
  #harness;
  #state;
  #queues = new Map();
  #pendingInteractions = new Map();
  #interactionKeys = new Map();
  #resolvedQuestionReplies = new Map();
  #acceptedMessageIds = new Set();
  #interactionTasks = new Set();
  #approvals;
  #status;
  #allowedSenderOpenIds;
  #replyTimeoutMs;
  #logger;
  #signal;
  /** Number-tappable menus: conversation key → menu state. */
  #menus = new Map();
  /** Interactive-card message id → { key, chatId } for button callbacks. */
  #cardKeys = new Map();
  /** Whether the global completion-event watcher has started. */
  #eventWatcherStarted = false;
  /** sessionId → { turn, at } for watched-session durations. */
  #turnStarts = new Map();
  /** Conversation key → last known chat id (completion-push targets). */
  #chatKeys = new Map();
  /** sessionId → { title, at } short-lived title cache for pushes. */
  #titleCache = new Map();

  constructor({
    client,
    channel,
    harness,
    state,
    status,
    allowedSenderOpenIds = new Set(),
    replyTimeoutMs = 600_000,
    logger = console,
    signal,
  }) {
    if (!client || !harness || !state || !status) {
      throw new TypeError('Feishu bridge dependencies are required');
    }
    this.#client = client;
    this.#channel = channel;
    this.#harness = harness;
    this.#state = state;
    this.#status = status;
    this.#allowedSenderOpenIds = allowedSenderOpenIds;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#logger = logger;
    this.#approvals = new HarnessApprovalQueue({ label: 'Feishu', logger });
    this.#signal = signal;
    ensureStatus(this.#status);
  }

  accept(event) {
    if (this.#signal?.aborted) return Promise.resolve();
    const messageId = nonEmptyString(event?.message?.message_id);
    if (!messageId || isBotSender(event)) return Promise.resolve();
    if (!isAllowedSender(event, this.#allowedSenderOpenIds)) {
      this.#status.messagesRejected += 1;
      this.#status.lastRejectedAt = new Date().toISOString();
      this.#logger.warn?.('[dsh-feishu] ignored a message from a sender outside the allowlist');
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

    if (event.message.chat_type === 'p2p') {
      const chatId = nonEmptyString(event.message.chat_id);
      if (chatId) rememberConnectionTestTarget(this.#state, { chatId });
    }

    this.#acceptedMessageIds.add(messageId);
    const processingReaction = this.#addReaction(messageId, 'OnIt');
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
    const pending = this.#pendingInteractions.get(key);
    const approvalReply = this.#approvals.claimReply({
      key,
      actor: senderOpenId(event),
      messageId,
      text: extractText(event) ?? '',
      addressed: event?.message?.chat_type === 'p2p'
        || (Array.isArray(event?.message?.mentions) && event.message.mentions.length > 0),
      hasPendingQuestion: Boolean(pending),
      questionCompletion: pending?.submitting || pending?.claimedReplyMessageId
        ? pending.queue
        : null,
      isQuestionPending: () => this.#pendingInteractions.has(key),
      send: (text) => this.#send(event.message.chat_id, text),
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
        .then(() => this.#finishReaction(messageId, processingReaction, 'DONE'))
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

  async #handleMessageFailure(event, messageId, processingReaction, error) {
    if (this.#signal?.aborted) {
      await this.#removeProcessingReaction(messageId, processingReaction);
      return;
    }
    this.#logger.error?.('[dsh-feishu] message handling failed:', error?.message ?? String(error));
    this.#status.lastError = error?.message ?? String(error);
    await this.#finishReaction(messageId, processingReaction, 'ERROR');
    await this.#send(
      event.message.chat_id,
      imagePromptUserMessage(error)
        ?? '处理失败，请稍后重试。如果问题持续，请在 DeepSeek Harness 的飞书插件页面检查连接状态。',
    ).catch(() => undefined);
  }

  async waitForIdle() {
    await Promise.allSettled([
      ...this.#queues.values(),
      ...[...this.#pendingInteractions.values()].flatMap((pending) => (
        pending.queue ? [pending.queue] : []
      )),
      ...this.#interactionTasks,
    ]);
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
    // Remember this conversation's chat id and keep the global event
    // watcher alive so bound-session completions push even without /watch.
    this.#chatKeys.set(key, event.message.chat_id);
    this.#ensureEventWatcher();

    const message = extractInboundMessage(event, this.#client);
    const text = message.content;
    const hasImages = hasInboundImages(message);
    const commandText = event.message.message_type === 'text' && !hasImages ? text : null;
    if (!text && !hasImages) {
      await this.#send(event.message.chat_id, '目前支持文字和图片消息。');
      return;
    }

    const chatId = event.message.chat_id;
    if (commandText === '/help') {
      await this.#send(chatId, menuHelpText());
      return;
    }
    if (MENU_COMMAND.test(commandText)) {
      this.#rememberMenu(key, { kind: 'menu', chatId });
      await this.#sendCard(chatId, menuCard(), { key });
      return;
    }
    if (commandText === '/new') {
      await this.#state.clearSession(key);
      await this.#send(chatId, '已开启全新 Harness 会话。');
      return;
    }
    if (commandText === '/status') {
      await this.#harness.ensureRunning({ signal: this.#signal });
      await this.#send(chatId, '飞书机器人与 DeepSeek Harness 连接正常。');
      return;
    }
    if (SESSION_LIST_PREFIX.test(commandText)) {
      const selector = commandText.slice('/sessionlist'.length).trim() || null;
      await this.#showSessions({ chatId, key }, selector);
      return;
    }
    if (WORKSPACE_LIST_COMMAND.test(commandText)) {
      await this.#showWorkspaces({ chatId, key });
      return;
    }
    const watchMatch = WATCH_COMMAND.exec(commandText);
    if (watchMatch) {
      await this.#runWatch({ chatId, key }, watchMatch[1] ?? null);
      return;
    }
    const unwatchMatch = UNWATCH_COMMAND.exec(commandText);
    if (unwatchMatch) {
      await this.#runUnwatch({ chatId, key }, unwatchMatch[1] ?? null);
      return;
    }
    if (WATCHLIST_COMMAND.test(commandText)) {
      await this.#showWatchlist({ chatId, key });
      return;
    }
    if (NUMBER_REPLY.test(commandText)) {
      const menu = this.#takeMenu(key);
      if (menu) {
        await this.#handleMenuPick(menu, Number(commandText), { chatId, key });
        return;
      }
    }
    const workspaceCommand = commandText === null
      ? null
      : await runWorkspaceCommand(text, this.#harness, key);
    if (workspaceCommand) {
      for (const reply of workspaceCommand.messages ?? [workspaceCommand.message]) {
        await this.#send(chatId, reply);
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
      await this.#send(event.message.chat_id, compactCommand.message);
      return;
    }

    this.#logger.info?.(`[dsh-feishu] processing ${event.message.chat_type} message ${messageId}`);
    try {
      await this.#answerWithStream(event, key, message);
      this.#status.messagesReplied += 1;
      this.#status.lastReplyAt = new Date().toISOString();
      this.#status.lastError = null;
    } finally {
      await this.#cancelPendingInteraction(key);
      await this.#approvals.closeRoute(key);
    }
  }

  #interactionAskOptions(event, key) {
    return {
      timeoutMs: this.#replyTimeoutMs,
      signal: this.#signal,
      onInteraction: (interaction) => this.#handleInteraction(interaction, {
        key,
        actor: senderOpenId(event),
        chatId: event.message.chat_id,
        requiresMention: event.message.chat_type !== 'p2p',
      }),
      onInteractionResolved: (resolution) => this.#handleInteractionResolved(resolution),
    };
  }

  async #answerWithStream(event, key, message) {
    const chatId = event.message.chat_id;
    const messageId = event.message.message_id;
    const text = message.content;
    const content = hasInboundImages(message)
      ? await promptContentForMessage(message, { signal: this.#signal })
      : undefined;
    if (!this.#channel?.stream) {
      const { answer } = await askInWorkspaceSession({
        harness: this.#harness,
        state: this.#state,
        key,
        text,
        content,
        createOptions: { signal: this.#signal },
        existsOptions: { signal: this.#signal },
        askOptions: this.#interactionAskOptions(event, key),
      });
      for (const chunk of splitText(answer)) await this.#send(chatId, chunk);
      this.#status.streamFallbacks = (this.#status.streamFallbacks ?? 0) + 1;
      return;
    }

    let promptStarted = false;
    let completedAnswer = '';
    try {
      await this.#channel.stream(chatId, {
        markdown: async (controller) => {
          promptStarted = true;
          const askOptions = {
            ...this.#interactionAskOptions(event, key),
            onUpdate: async (update) => {
              await controller.setContent(this.#progressText(update));
              this.#status.streamUpdates = (this.#status.streamUpdates ?? 0) + 1;
            },
          };
          ({ answer: completedAnswer } = await askInWorkspaceSession({
            harness: this.#harness,
            state: this.#state,
            key,
            text,
            content,
            createOptions: { signal: this.#signal },
            existsOptions: { signal: this.#signal },
            askOptions,
          }));
          await controller.setContent(completedAnswer);
        },
      }, { replyTo: messageId });
      this.#status.streamResponses = (this.#status.streamResponses ?? 0) + 1;
    } catch (error) {
      this.#status.streamErrors = (this.#status.streamErrors ?? 0) + 1;
      if (completedAnswer) {
        this.#logger.warn?.(
          '[dsh-feishu] native stream failed after generation; sending final text:',
          error.message,
        );
        for (const chunk of splitText(completedAnswer)) await this.#send(chatId, chunk);
        this.#status.streamFallbacks = (this.#status.streamFallbacks ?? 0) + 1;
        return;
      }
      if (promptStarted) throw error;

      this.#logger.warn?.('[dsh-feishu] native stream unavailable; using text fallback:', error.message);
      const { answer } = await askInWorkspaceSession({
        harness: this.#harness,
        state: this.#state,
        key,
        text,
        content,
        createOptions: { signal: this.#signal },
        existsOptions: { signal: this.#signal },
        askOptions: this.#interactionAskOptions(event, key),
      });
      for (const chunk of splitText(answer)) await this.#send(chatId, chunk);
      this.#status.streamFallbacks = (this.#status.streamFallbacks ?? 0) + 1;
    }
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
      await this.#send(event.message.chat_id, '请用文字回答当前问题。');
      return;
    }

    const pending = this.#pendingInteractions.get(key);
    if (!pending || pending !== expected || pending.submitting) {
      if (this.#isResolvedQuestionReply(event, key)) {
        await this.#send(event.message.chat_id, INTERACTION_RESOLVED_TEXT).catch(() => undefined);
        return;
      }
      if (claimed && (!pending || pending !== expected)) {
        await this.#send(event.message.chat_id, INTERACTION_RESOLVED_TEXT);
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
        await this.#send(event.message.chat_id, INTERACTION_RESOLVED_TEXT).catch(() => undefined);
        return;
      }
      pending.submitting = false;
      pending.answers.pop();
      pending.index -= 1;
      this.#status.lastError = '回答提交失败。';
      this.#logger.error?.('[dsh-feishu] failed to answer a Harness interaction');
      await this.#send(event.message.chat_id, '回答提交失败，请重新发送当前问题的答案。')
        .catch(() => undefined);
    }
  }

  async #handleInteraction(interaction, {
    key,
    actor,
    chatId,
    requiresMention,
  }) {
    if (await this.#approvals.handleRequested(interaction, {
      key,
      actor,
      requiresMention,
      send: (text) => this.#send(chatId, text),
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
        '检测到这个 Session 中遗留的待回答问题，已安全取消并继续处理你刚才的消息。',
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
    await this.#send(event.message.chat_id, INTERACTION_RESOLVED_TEXT).catch(() => undefined);
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
      if (update.name === 'web_search') return '_正在搜索网络并整理信息…_';
      return `_正在使用 ${update.name || '工具'}…_`;
    }
    return `_${update.text || '正在处理…'}_`;
  }

  async #addReaction(messageId, emojiType) {
    if (!this.#channel?.addReaction) return null;
    try {
      const reactionId = await this.#channel.addReaction(messageId, emojiType);
      this.#status.reactionsAdded = (this.#status.reactionsAdded ?? 0) + 1;
      return reactionId;
    } catch (error) {
      this.#status.reactionErrors = (this.#status.reactionErrors ?? 0) + 1;
      this.#logger.warn?.(`[dsh-feishu] unable to add ${emojiType} reaction:`, error.message);
      return null;
    }
  }

  async #removeProcessingReaction(messageId, processingReaction) {
    const reactionId = await processingReaction;
    if (reactionId && this.#channel?.removeReaction) {
      try {
        await this.#channel.removeReaction(messageId, reactionId);
        this.#status.reactionsRemoved = (this.#status.reactionsRemoved ?? 0) + 1;
      } catch (error) {
        this.#status.reactionErrors = (this.#status.reactionErrors ?? 0) + 1;
        this.#logger.warn?.('[dsh-feishu] unable to remove processing reaction:', error.message);
      }
    }
  }

  async #finishReaction(messageId, processingReaction, finalEmojiType) {
    await this.#removeProcessingReaction(messageId, processingReaction);
    await this.#addReaction(messageId, finalEmojiType);
  }

  // ── Interactive cards: menus, session lists, completion pushes ─────────

  /** Card button callback (card.action.trigger); routed by the card's message id. */
  onCardAction(event) {
    const action = typeof event?.action?.value?.action === 'string'
      ? event.action.value.action
      : null;
    if (!action) return;
    const messageId = nonEmptyString(event?.context?.open_message_id);
    const entry = messageId ? this.#cardKeys.get(messageId) : null;
    if (!entry) return;
    void this.#handleCardAction(action, entry).catch((error) => {
      this.#logger.warn?.('[dsh-feishu] card action failed:', error.message);
    });
  }

  async #handleCardAction(action, { chatId, key }) {
    if (action === 'sessions' || /^sessions:\d+$/.test(action)) {
      const page = action === 'sessions' ? 0 : Number(action.slice('sessions:'.length));
      await this.#showSessions({ chatId, key }, null, page);
      return;
    }
    if (action === 'workspaces') {
      await this.#showWorkspaces({ chatId, key });
      return;
    }
    if (action === 'new') {
      await this.#state.clearSession(key);
      await this.#send(chatId, '已开启全新 Harness 会话。');
      return;
    }
    if (action === 'status') {
      await this.#harness.ensureRunning({ signal: this.#signal });
      await this.#send(chatId, '飞书机器人与 DeepSeek Harness 连接正常。');
      return;
    }
    if (action === 'watchlist') {
      await this.#showWatchlist({ chatId, key });
      return;
    }
    if (action === 'help') {
      await this.#send(chatId, menuHelpText());
      return;
    }
    if (action.startsWith('use:')) {
      await this.#bindSession(key, chatId, action.slice('use:'.length));
      return;
    }
    if (action.startsWith('workspace:')) {
      await this.#switchWorkspace(key, chatId, action.slice('workspace:'.length));
      return;
    }
    if (action.startsWith('unwatch:')) {
      await this.#state.clearWatch(key, action.slice('unwatch:'.length));
      await this.#send(chatId, '已取消关注。');
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

  async #handleMenuPick(menu, number, { chatId, key }) {
    if (menu.kind === 'menu') {
      const action = ['sessions', 'workspaces', 'new', 'status', 'watchlist', 'help'][number - 1];
      if (!action) {
        await this.#send(chatId, '菜单没有这个编号，回复 /m 重新打开。');
        return;
      }
      await this.#handleCardAction(action, { chatId, key });
      return;
    }
    if (menu.kind === 'sessions') {
      const session = menu.sessions[number - 1];
      if (!session?.sessionId) {
        await this.#send(chatId, `本页只有 ${menu.sessions.length} 个会话，回复 /sessionlist 重新查看。`);
        return;
      }
      await this.#handleCardAction(`use:${session.sessionId}`, { chatId, key });
      return;
    }
    if (menu.kind === 'workspaces') {
      const workspace = menu.paths[number - 1];
      if (!workspace) {
        await this.#send(chatId, `只有 ${menu.paths.length} 个工作区，回复 /workspacelist 重新查看。`);
        return;
      }
      await this.#handleCardAction(`workspace:${workspace}`, { chatId, key });
    }
  }

  async #showSessions({ chatId, key }, selector, page = 0) {
    try {
      const resolved = await resolveSessionListWorkspace(selector ?? '', this.#harness);
      if (resolved.error) {
        await this.#send(chatId, resolved.error);
        return;
      }
      const listed = await this.#harness.listWorkspaceSessions(resolved.workspace);
      const sessions = Array.isArray(listed?.sessions) ? listed.sessions : [];
      const workspace = listed?.workspace ?? resolved.workspace;
      if (sessions.length === 0) {
        await this.#send(chatId, `工作区：${workspace}\n该工作区暂无会话。`);
        return;
      }
      const pageCount = Math.ceil(sessions.length / MENU_PAGE_SIZE);
      const start = Number.isSafeInteger(page) && page > 0
        ? Math.min(page, pageCount - 1) * MENU_PAGE_SIZE
        : 0;
      this.#rememberMenu(key, { kind: 'sessions', sessions, workspace, start });
      await this.#sendCard(chatId, sessionListCard(workspace, sessions, start, sessions.length), { key });
    } catch (error) {
      this.#logger.warn?.('[dsh-feishu] session list failed:', error.message);
      await this.#send(chatId, '暂时无法获取会话列表，请稍后重试。');
    }
  }

  async #showWorkspaces({ chatId, key }) {
    try {
      const { current, paths } = await workspacePathSnapshot(this.#harness);
      this.#rememberMenu(key, { kind: 'workspaces', paths, current });
      await this.#sendCard(chatId, workspaceListCard(paths, current), { key });
    } catch (error) {
      this.#logger.warn?.('[dsh-feishu] workspace list failed:', error.message);
      await this.#send(chatId, '暂时无法获取工作区列表，请稍后重试。');
    }
  }

  async #bindSession(key, chatId, sessionId) {
    try {
      const bound = await this.#harness.bindWorkspaceSession(key, sessionId);
      const title = String(bound?.title ?? '').replace(/\s+/gu, ' ').trim() || '暂无标题';
      await this.#send(chatId, `已绑定会话「${title}」\nID：${bound?.sessionId ?? sessionId}`);
    } catch (error) {
      await this.#send(chatId, `绑定失败：${error?.message ?? error?.code ?? '未知错误'}`);
    }
  }

  async #switchWorkspace(key, chatId, workspace) {
    try {
      const current = await this.#harness.switchWorkspace(workspace);
      await this.#send(chatId, `工作区已切换为：${current}`);
    } catch (error) {
      await this.#send(chatId, `切换失败：${error?.message ?? error?.code ?? '未知错误'}`);
    }
  }

  // ── Completion watches ──────────────────────────────────────────────────

  async #runWatch({ chatId, key }, rawSelector) {
    try {
      let sessionId = rawSelector;
      if (!sessionId) {
        sessionId = this.#state.sessionFor(key);
        if (!sessionId) {
          await this.#send(chatId, '当前聊天还没有绑定会话。用法：/watch Session ID 或序号。');
          return;
        }
      } else if (/^\d+$/u.test(sessionId)) {
        const selected = await resolveSessionListWorkspace(null, this.#harness);
        if (selected.error) {
          await this.#send(chatId, selected.error);
          return;
        }
        const listed = await this.#harness.listWorkspaceSessions(selected.workspace);
        const entry = listed?.sessions?.[Number(sessionId) - 1];
        if (!entry?.sessionId) {
          await this.#send(chatId, '会话序号不存在，请先执行 /sessionlist。');
          return;
        }
        sessionId = entry.sessionId;
      }
      const bound = await this.#harness.bindWorkspaceSession(key, sessionId);
      const title = String(bound?.title ?? '').replace(/\s+/gu, ' ').trim() || '暂无标题';
      await this.#state.setWatch(key, chatId, {
        sessionId,
        title,
        workspace: typeof bound?.workspace === 'string' ? bound.workspace : undefined,
      });
      this.#ensureEventWatcher();
      await this.#send(chatId, `已关注「${title}」，任务完成后会在这里推送通知。`);
    } catch (error) {
      await this.#send(chatId, `关注失败：${error?.message ?? error?.code ?? '未知错误'}`);
    }
  }

  async #runUnwatch({ chatId, key }, selector) {
    const watches = this.#state.watchesFor(key);
    if (!selector) {
      await this.#showWatchlist({ chatId, key });
      return;
    }
    let sessionId = selector;
    if (/^\d+$/u.test(selector)) {
      const entry = watches[Number(selector) - 1];
      if (!entry) {
        await this.#send(chatId, '关注列表没有这个编号，回复 /watchlist 查看。');
        return;
      }
      sessionId = entry.sessionId;
    }
    await this.#state.clearWatch(key, sessionId);
    await this.#send(chatId, '已取消关注。');
  }

  async #showWatchlist({ chatId, key }) {
    await this.#sendCard(chatId, watchListCard(this.#state.watchesFor(key)), { key });
  }

  #ensureEventWatcher() {
    if (this.#eventWatcherStarted) return;
    // Completion pushes are an optional capability: test doubles and older
    // harness clients without the global mux watcher simply skip them.
    if (typeof this.#harness?.watchHarnessEvents !== 'function') return;
    this.#eventWatcherStarted = true;
    const signal = this.#signal ?? new AbortController().signal;
    void this.#harness.watchHarnessEvents({
      signal,
      onSessionEvent: ({ sessionId, event }) => this.#onHarnessEvent(sessionId, event),
    }).catch((error) => {
      if (!signal.aborted) {
        this.#logger.warn?.('[dsh-feishu] global event watcher failed:', error?.message ?? String(error));
      }
    });
  }

  async #onHarnessEvent(sessionId, event) {
    if (event.type === 'turn/start') {
      this.#turnStarts.set(sessionId, { turn: event.data?.turn, at: Date.now() });
      return;
    }
    if (event.type !== 'turn/end') return;
    const started = this.#turnStarts.get(sessionId);
    this.#turnStarts.delete(sessionId);
    const durationMs = started && started.turn === event.data?.turn
      ? Date.now() - started.at
      : null;
    const reasonText = describeTurnEnd(event.data?.reason);
    // Delivery targets: explicit watches plus every conversation whose
    // bound session just finished (chatId from the last message seen).
    const targets = new Map();
    for (const { chatId, entry } of this.#state.watchKeysFor(sessionId)) {
      if (chatId) targets.set(chatId, entry);
    }
    for (const key of (this.#state.sessionKeysFor?.(sessionId) ?? [])) {
      const chatId = this.#chatKeys.get(key);
      if (!chatId || targets.has(chatId)) continue;
      targets.set(chatId, { sessionId, title: await this.#sessionTitle(sessionId) });
    }
    if (targets.size === 0) return;
    for (const [chatId, entry] of targets) {
      try {
        await this.#sendCard(chatId, completionCard(entry, { durationMs, reasonText }));
      } catch (error) {
        this.#logger.warn?.('[dsh-feishu] completion push failed:', error.message);
      }
    }
  }

  async #sessionTitle(sessionId) {
    const cached = this.#titleCache.get(sessionId);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.title;
    let title = '暂无标题';
    try {
      const current = this.#harness.currentWorkspace();
      const listed = await this.#harness.listWorkspaceSessions(current);
      const found = listed?.sessions?.find((session) => session?.sessionId === sessionId);
      const cleaned = String(found?.title ?? '').replace(/\s+/gu, ' ').trim();
      if (cleaned) title = cleaned;
    } catch (error) {
      this.#logger.debug?.('[dsh-feishu] session title lookup failed:', error.message);
    }
    this.#titleCache.set(sessionId, { title, at: Date.now() });
    return title;
  }

  async #sendCard(chatId, cardJson, options = {}) {
    const response = await this.#client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content: cardJson },
    });
    if (response?.code && response.code !== 0) {
      throw new Error(`Feishu card send failed: ${response.msg || response.code}`);
    }
    const messageId = nonEmptyString(response?.data?.message_id);
    if (options.key && messageId) {
      this.#cardKeys.set(messageId, { key: options.key, chatId });
      if (this.#cardKeys.size > 200) {
        const oldest = this.#cardKeys.keys().next().value;
        if (oldest !== undefined) this.#cardKeys.delete(oldest);
      }
    }
    return messageId;
  }

  async #send(chatId, text) {
    const response = await this.#client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    if (response?.code && response.code !== 0) {
      throw new Error(`Feishu send failed: ${response.msg || response.code}`);
    }
    return nonEmptyString(response?.data?.message_id);
  }
}
