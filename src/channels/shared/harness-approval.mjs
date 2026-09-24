import { t } from './i18n.mjs';

const APPROVAL_REPLIES = new Map([
  ['批准', 'allowed-once'],
  ['同意', 'allowed-once'],
  ['yes', 'allowed-once'],
  ['拒绝', 'rejected'],
  ['不同意', 'rejected'],
  ['no', 'rejected'],
]);

const APPROVAL_PROMPT = '请精准回复「批准」或「拒绝」（也支持：同意 / 不同意 / yes / no）。';
const APPROVAL_AFTER_QUESTION_PROMPT = '请先完成当前问题，再精准回复「批准」或「拒绝」。';
const APPROVAL_RESOLVED_TEXT = '该审批已处理，无需再次回复。';
const RESOLVED_ROUTE_TTL_MS = 5 * 60_000;
const MAX_RESOLVED_ROUTES = 2_048;

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function printableText(value) {
  return cleanText(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export function harnessApprovalDecision(text) {
  return APPROVAL_REPLIES.get(cleanText(text).toLowerCase()) ?? null;
}

export function validHarnessApproval(payload) {
  return payload?.type === 'approval/requested'
    && Boolean(cleanText(payload.sessionId))
    && Boolean(cleanText(payload.approvalId))
    && Boolean(cleanText(payload.toolName))
    && (payload.callId === undefined || Boolean(cleanText(payload.callId)))
    && (payload.reason === undefined || typeof payload.reason === 'string');
}

function toolArguments(toolCall) {
  const source = toolCall?.arguments;
  if (source !== null && typeof source === 'object') {
    try {
      return JSON.stringify(source, null, 2);
    } catch {
      return null;
    }
  }
  if (typeof source !== 'string') return null;
  const raw = printableText(source);
  // Harness treats an empty tool argument string as an empty object.
  if (!raw) return source === '' ? '{}' : null;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function harnessApprovalText(payload, {
  toolCall,
  requiresMention = false,
  maxArgumentsLength = 6_000,
} = {}) {
  if (!validHarnessApproval(payload)) return null;
  const callId = cleanText(payload.callId);
  if (!callId
    || cleanText(toolCall?.callId) !== callId
    || cleanText(toolCall?.name) !== cleanText(payload.toolName)) return null;
  const operation = toolArguments(toolCall);
  if (!operation || operation.length > maxArgumentsLength) return null;

  const lines = [
    t('DeepSeek Harness 需要你的审批：'),
    '',
    t('工具：{tool}', { tool: printableText(payload.toolName) }),
    t('操作参数：'),
    operation,
  ];
  const reason = printableText(payload.reason);
  if (reason) lines.push(t('原因：{reason}', { reason }));
  lines.push('', t(APPROVAL_PROMPT));
  if (requiresMention) lines.push('', t('群聊中请 @机器人 后发送审批决定。'));
  return lines.join('\n');
}

function approvalResult(pending, outcome) {
  return {
    ok: true,
    value: {
      sessionId: pending.sessionId,
      approvalId: pending.approvalId,
      outcome,
    },
  };
}

function approvalOutcomeText(outcome) {
  if (outcome === 'allowed-once') return t('已批准，仅对本次操作有效。');
  if (outcome === 'rejected') return t('已拒绝此次操作。');
  return t(APPROVAL_RESOLVED_TEXT);
}

export class HarnessApprovalQueue {
  #label;
  #logger;
  #byId = new Map();
  #routes = new Map();
  #resolvedRoutes = new Map();

  constructor({ label = 'IM', logger = console } = {}) {
    this.#label = label;
    this.#logger = logger;
  }

  hasPending(key) {
    return this.#routes.get(key)?.items.some((pending) => !pending.inactive) === true;
  }

  claimReply({
    key,
    actor,
    text,
    addressed = true,
    hasPendingQuestion = false,
    questionCompletion,
    isQuestionPending,
    send,
  }) {
    const route = this.#routes.get(key);
    const pending = route?.items[0];
    const decision = harnessApprovalDecision(text);
    const notice = (value, resolved = false) => ({
      ...(resolved ? { resolved: true } : {}),
      process: async (before) => {
        if (typeof before === 'function' && await before() === false) return;
        await send(value);
      },
    });
    // Match Harness' own interaction precedence: a live ask_user_question
    // outranks sibling approvals. Otherwise a question answer such as "yes"
    // could accidentally authorize a tool call.
    const deferredByQuestion = hasPendingQuestion
      && pending
      && questionCompletion
      && typeof questionCompletion.then === 'function';
    if (hasPendingQuestion && !deferredByQuestion) return null;
    if (!pending || pending.inactive) {
      const resolvedUntil = this.#resolvedRoutes.get(key) ?? 0;
      if (resolvedUntil <= Date.now()) {
        this.#resolvedRoutes.delete(key);
        return null;
      }
      if (!decision) return null;
      return notice(t(APPROVAL_RESOLVED_TEXT), true);
    }
    if (pending.actor !== actor || (pending.requiresMention && addressed !== true)) {
      if (!decision) return null;
      return notice(t('只有发起当前任务的用户可以处理这条审批。'));
    }

    return {
      process: async (before) => {
        const presentedWhenClaimed = pending.presented;
        const previous = pending.replyTail ?? Promise.resolve();
        const task = previous
          .catch(() => undefined)
          .then(async () => {
            if (typeof before === 'function' && await before() === false) return;
            if (deferredByQuestion) {
              await questionCompletion.catch(() => undefined);
              if (pending.inactive || pending.resolving) return;
              if (typeof isQuestionPending === 'function' && isQuestionPending()) {
                await send(t(APPROVAL_AFTER_QUESTION_PROMPT));
                return;
              }
            }
            await pending.activationTask?.catch(() => undefined);
            await pending.presentationTask?.catch(() => undefined);
            if (pending.inactive || pending.resolving) {
              await send(t(APPROVAL_RESOLVED_TEXT));
              return;
            }
            pending.send = send;
            // Never turn a decision sent before the operation was visibly
            // presented into an approval. This also covers a failed presentation
            // and the small FIFO promotion window before the next item is shown.
            if (!presentedWhenClaimed || !pending.presented) {
              if (!pending.presented) await this.#present(pending);
              if (pending.inactive || pending.resolving) return;
              await send(t(APPROVAL_PROMPT));
              return;
            }
            if (pending.submitting) {
              await send(t('审批决定正在提交，请稍候。'));
              return;
            }
            if (!decision) {
              await send(t(APPROVAL_PROMPT));
              return;
            }
            await this.#submit(pending, decision);
          });
        pending.replyTail = task;
        try {
          await task;
        } finally {
          if (pending.replyTail === task) pending.replyTail = null;
        }
      },
    };
  }

  async handleRequested(interaction, context) {
    if (interaction?.kind !== 'approval') return false;
    const payload = interaction.payload;
    const approvalId = cleanText(payload?.approvalId);
    if (!cleanText(interaction.rpcId)
      || !cleanText(interaction.sessionId)
      || !approvalId
      || !validHarnessApproval(payload)
      || payload.sessionId !== interaction.sessionId
      || typeof interaction.respond !== 'function') {
      this.#logger.warn?.(`[dsh-im:${this.#label}] ignored an invalid Harness approval`);
      return true;
    }

    if (interaction.recovered === true) {
      await this.#rejectInteraction(interaction, payload);
      return true;
    }

    const existing = this.#byId.get(approvalId);
    if (existing) {
      existing.interaction = interaction;
      existing.toolCall = interaction.toolCall;
      if (!existing.presented) await this.#present(existing);
      return true;
    }

    const send = context?.send;
    const key = cleanText(context?.key);
    const actor = cleanText(context?.actor);
    if (!key || !actor || typeof send !== 'function') {
      this.#logger.warn?.(`[dsh-im:${this.#label}] ignored an approval without a reply route`);
      await this.#rejectInteraction(interaction, payload);
      return true;
    }
    // Optional channel-provided renderer. When present, the approval is shown
    // as an interactive card (e.g. Feishu approve/reject buttons) instead of
    // plain text. Channels that don't provide one keep the text-reply path.
    const render = typeof context?.render === 'function' ? context.render : null;

    const text = harnessApprovalText(payload, {
      toolCall: interaction.toolCall,
      requiresMention: context.requiresMention === true,
    });
    if (!text) {
      const rejected = await this.#rejectInteraction(interaction, payload);
      await send(rejected
        ? t('无法完整展示这次操作，已安全拒绝此次审批。')
        : t(APPROVAL_RESOLVED_TEXT));
      return true;
    }

    const pending = {
      approvalId,
      sessionId: interaction.sessionId,
      interaction,
      toolCall: interaction.toolCall,
      key,
      actor,
      requiresMention: context.requiresMention === true,
      send,
      render,
      text,
      presented: false,
      presentationTask: null,
      deliveryCompleted: false,
      replyTail: null,
      submitting: false,
      inactive: false,
      resolving: false,
      closedOutcome: null,
      resolutionNotified: false,
      activationTask: null,
    };
    this.#byId.set(approvalId, pending);
    const route = this.#routes.get(key) ?? { items: [] };
    route.items.push(pending);
    this.#routes.set(key, route);
    if (route.items[0] === pending) await this.#present(pending);
    return true;
  }

  /**
   * Submit an approval decision by id, as triggered by a channel card button
   * (e.g. Feishu approve/reject). Returns false when no matching pending
   * approval is found. Callers may pass the acting user to enforce that only
   * the originating actor can decide.
   */
  async submitByApprovalId(approvalId, outcome, { actor } = {}) {
    const pending = this.#byId.get(cleanText(approvalId));
    if (!pending || pending.inactive || pending.resolving || pending.submitting) return false;
    if (actor !== undefined && pending.actor !== actor) return false;
    await this.#submit(pending, outcome);
    return true;
  }

  async handleResolved(resolution) {
    if (resolution?.kind !== 'approval') return false;
    const pending = this.#byId.get(cleanText(resolution.interactionId));
    if (!pending) return true;
    // A queued item may already be the next route head while the previous
    // item's confirmation is still in flight. Preserve that route barrier so
    // resolving this item cannot expose a later approval out of order.
    pending.resolving = true;
    if (pending.activationTask) {
      await pending.activationTask.catch(() => undefined);
    }
    if (pending.inactive || this.#byId.get(pending.approvalId) !== pending) return true;
    const presentationTask = pending.presentationTask;
    const shouldNotify = pending.presented || presentationTask;
    const send = pending.send;
    const next = this.#remove(pending);
    await this.#transition(next, async () => {
      let delivered = pending.presented;
      if (presentationTask) {
        delivered = await presentationTask.then(() => true, () => false);
      }
      if (shouldNotify && delivered) {
        pending.resolutionNotified = true;
        await send(approvalOutcomeText(resolution.outcome)).catch(() => undefined);
      }
    });
    return true;
  }

  async closeRoute(key) {
    const route = this.#routes.get(key);
    if (!route) return;
    const pendingItems = [...route.items];
    for (const pending of pendingItems) this.#remove(pending);
    await Promise.all(pendingItems.map(async (pending) => {
      try {
        await pending.interaction.respond(
          approvalResult(pending, 'rejected'),
          { signal: AbortSignal.timeout(5_000) },
        );
        pending.closedOutcome = 'rejected';
        if ((pending.presented || pending.deliveryCompleted) && !pending.resolutionNotified) {
          pending.resolutionNotified = true;
          await pending.send(approvalOutcomeText('rejected')).catch(() => undefined);
        }
      } catch (error) {
        if (error?.code === 'interaction-not-pending') {
          pending.closedOutcome = 'resolved';
          if ((pending.presented || pending.deliveryCompleted) && !pending.resolutionNotified) {
            pending.resolutionNotified = true;
            await pending.send(t(APPROVAL_RESOLVED_TEXT)).catch(() => undefined);
          }
        } else {
          this.#logger.warn?.(`[dsh-im:${this.#label}] failed to reject a closing approval:`, error);
        }
      }
    }));
  }

  async #present(pending) {
    if (this.#routes.get(pending.key)?.items[0] !== pending
      || pending.inactive || pending.resolving || pending.presented) return;
    await pending.activationTask?.catch(() => undefined);
    if (this.#routes.get(pending.key)?.items[0] !== pending
      || pending.inactive || pending.resolving || pending.presented) return;
    if (pending.presentationTask) return pending.presentationTask;
    // A channel-provided renderer shows the approval as an interactive card
    // (e.g. approve/reject buttons); otherwise fall back to plain text.
    const task = pending.render
      ? Promise.resolve().then(() => pending.render(pending, pending.send))
      : Promise.resolve().then(() => pending.send(pending.text));
    pending.presentationTask = task;
    try {
      await task;
      pending.deliveryCompleted = true;
      if (!pending.inactive) {
        pending.presented = true;
      } else if (pending.closedOutcome && !pending.resolutionNotified) {
        pending.resolutionNotified = true;
        await pending.send(approvalOutcomeText(pending.closedOutcome)).catch(() => undefined);
      }
    } finally {
      if (pending.presentationTask === task) pending.presentationTask = null;
    }
  }

  async #submit(pending, outcome) {
    pending.submitting = true;
    try {
      await pending.interaction.respond(approvalResult(pending, outcome));
    } catch (error) {
      if (error?.code === 'interaction-not-pending') {
        const send = pending.send;
        const next = this.#remove(pending);
        await this.#transition(next, async () => {
          if (!pending.resolutionNotified) {
            await send(t(APPROVAL_RESOLVED_TEXT)).catch(() => undefined);
          }
        });
        return;
      }
      if (pending.inactive) return;
      pending.submitting = false;
      this.#logger.error?.(`[dsh-im:${this.#label}] failed to submit an approval:`, error);
      await pending.send(t('审批提交失败，请重新回复「批准」或「拒绝」。')).catch(() => undefined);
      return;
    }

    const send = pending.send;
    const next = this.#remove(pending);
    await this.#transition(next, async () => {
      if (!pending.resolutionNotified) {
        await send(approvalOutcomeText(outcome)).catch(() => undefined);
      }
    });
  }

  async #transition(next, work) {
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    if (next) next.activationTask = barrier;
    try {
      await work();
    } finally {
      release();
      if (next?.activationTask === barrier) next.activationTask = null;
    }
    await this.#promote(next);
  }

  async #promote(pending) {
    if (!pending) return;
    try {
      await this.#present(pending);
    } catch (error) {
      this.#logger.error?.(
        `[dsh-im:${this.#label}] failed to present the next approval:`,
        error,
      );
      try {
        pending.interaction.reconnect?.();
      } catch {
        // A replay will retry presentation when the transport can reconnect.
      }
    }
  }

  #remove(pending) {
    if (pending.inactive) return null;
    pending.inactive = true;
    this.#rememberResolvedRoute(pending.key);
    this.#byId.delete(pending.approvalId);
    const route = this.#routes.get(pending.key);
    if (!route) return null;
    const wasCurrent = route.items[0] === pending;
    const index = route.items.indexOf(pending);
    if (index !== -1) route.items.splice(index, 1);
    if (route.items.length === 0) {
      this.#routes.delete(pending.key);
      return null;
    }
    return wasCurrent ? route.items[0] : null;
  }

  #rememberResolvedRoute(key) {
    const now = Date.now();
    for (const [routeKey, expiresAt] of this.#resolvedRoutes) {
      if (expiresAt <= now) this.#resolvedRoutes.delete(routeKey);
    }
    this.#resolvedRoutes.delete(key);
    this.#resolvedRoutes.set(key, now + RESOLVED_ROUTE_TTL_MS);
    while (this.#resolvedRoutes.size > MAX_RESOLVED_ROUTES) {
      this.#resolvedRoutes.delete(this.#resolvedRoutes.keys().next().value);
    }
  }

  async #rejectInteraction(interaction, payload) {
    try {
      await interaction.respond({
        ok: true,
        value: {
          sessionId: interaction.sessionId,
          approvalId: payload.approvalId,
          outcome: 'rejected',
        },
      }, { signal: AbortSignal.timeout(5_000) });
      return true;
    } catch (error) {
      if (error?.code === 'interaction-not-pending') return false;
      throw error;
    }
  }
}
