import { HarnessReplyTracker } from '../shared/harness-client.mjs';
import { t } from '../shared/i18n.mjs';

// sessionWebhook 窗口（每条入站消息的 sessionWebhookExpiredTime）收口前，
// 为 POST 本身与时钟偏差留出的安全余量。
const WEBHOOK_EXPIRY_MARGIN_MS = 120_000;

export function deferredTerminalText(reason, answer) {
  const kind = reason?.kind ?? reason ?? null;
  if (kind === null || kind === 'completed') {
    if (typeof answer === 'string' && answer.trim()) return answer;
    return t('任务已结束，但没有可发送的文本结果。');
  }
  if (kind === 'error') {
    const detail = reason?.error?.message ?? reason?.failure?.message;
    return detail
      ? t('任务失败：{detail}', { detail: String(detail) })
      : t('任务失败：模型运行出错。');
  }
  if (kind === 'max-tokens') return t('任务已达到回复长度上限并结束。');
  if (kind === 'blocked') return t('任务被安全策略拦截。');
  if (['interrupted', 'stopped', 'cancelled', 'canceled'].includes(kind)) {
    return t('任务已停止。');
  }
  if (kind === 'aborted') return t('任务已中止。');
  return t('任务已结束。');
}

function webhookUsable(route, now = Date.now()) {
  const expiry = Number(route?.sessionWebhookExpiredTime) || 0;
  return expiry <= 0 || now < expiry - WEBHOOK_EXPIRY_MARGIN_MS;
}

/**
 * 钉钉延迟交付：ask 以 deferOnTimeout 交回仍在运行的 turn 后，
 * 在其终态（turn/end，任意 reason）时投递结果。路由优先当次会话的
 * sessionWebhook（未明确过期时），否则回退主动推送 sendRobotText。
 * 无看门狗、无持久化：条目仅存于内存（范围裁定见实施计划）。
 */
export function createDeferredDeliverer({
  api,
  clientId,
  clientSecret,
  harness,
  state,
  status = null,
  logger = console,
  signal,
  sendText,
}) {
  const entries = new Map(); // `${sessionId}\0${turn}` → entry
  const watcherSignal = signal ?? new AbortController().signal;
  const scans = new Map(); // entryKey → 在途 scan promise（串行防重复）
  let watcherStarted = false;

  const entryKeyOf = (deferred) => `${deferred.sessionId}\0${deferred.turn}`;

  async function deliverCard(entry, text) {
    const cardTarget = entry.route.cardTarget;
    if (!cardTarget
      || typeof api.createAiCard !== 'function'
      || typeof api.finishAiCard !== 'function') return null;
    let cardInstanceId = null;
    try {
      ({ cardInstanceId } = await api.createAiCard({
        clientId,
        clientSecret,
        target: cardTarget,
        initialText: text,
        signal: watcherSignal,
      }));
      await api.finishAiCard({
        clientId,
        clientSecret,
        cardInstanceId,
        target: cardTarget,
        text,
        signal: watcherSignal,
      });
      return cardInstanceId;
    } catch (error) {
      logger.warn?.(
        '[dsh-dingtalk] deferred card delivery failed, falling back to text:',
        error?.message ?? error,
      );
      // finalize 失败时卡片可能停在“处理中”——尽力打成错误态；结果随后以文本送达。
      if (cardInstanceId && typeof api.failAiCard === 'function') {
        await api.failAiCard({
          clientId,
          clientSecret,
          cardInstanceId,
          text: t('卡片已结束，请查看后续消息。'),
          target: cardTarget,
          signal: AbortSignal.timeout(5_000),
        }).catch(() => undefined);
      }
      return null;
    }
  }

  async function deliverText(entry, text, providerMessageIds = []) {
    // 卡片已送达（providerMessageIds 来自卡片实例）时直接进入收尾，不再
    // 叠加 webhook 文本；文本链仍由显式 delivered 旗标驱动（webhook 成功后
    // id 可能为空，不能用 id 判定是否已投递）。
    let delivered = providerMessageIds.length > 0;
    if (!delivered && webhookUsable(entry.route)) {
      try {
        providerMessageIds = await sendText(
          entry.route.sessionWebhook,
          text,
          entry.route.at,
        );
        delivered = true;
      } catch (error) {
        logger.warn?.(
          '[dsh-dingtalk] deferred webhook delivery failed, falling back to proactive send:',
          error?.message ?? error,
        );
      }
    }
    if (!delivered) {
      await api.sendRobotText({
        clientId,
        clientSecret,
        target: entry.route.fallbackTarget,
        text,
        signal: watcherSignal,
      });
    }
    entry.deferred.releaseOwnership?.();
    try {
      await state.rememberOutboundMessage?.({
        conversationKey: entry.key,
        text,
        sentAt: Date.now(),
        completedAt: Date.now(),
        providerMessageIds,
      });
    } catch (error) {
      logger.warn?.('[dsh-dingtalk] failed to remember a deferred outbound message:', error);
    }
    if (status) {
      status.messagesReplied = (status.messagesReplied ?? 0) + 1;
      status.lastReplyAt = new Date().toISOString();
    }
  }

  async function deliver(entry, tracker) {
    const text = deferredTerminalText(tracker.reason, tracker.answer);
    const cardInstanceId = await deliverCard(entry, text);
    if (cardInstanceId !== null) {
      return deliverText(entry, text, [cardInstanceId]);
    }
    return deliverText(entry, text);
  }

  async function scanEntry(entry) {
    const key = entryKeyOf(entry.deferred);
    if (scans.has(key)) return scans.get(key);
    const task = (async () => {
      if (watcherSignal.aborted) return;
      const tracker = new HarnessReplyTracker({
        promptRpcId: entry.deferred.promptRpcId,
        afterSeq: entry.deferred.afterSeq,
      });
      const history = await harness.rpc(
        'session.history',
        { sessionId: entry.deferred.sessionId, maxMessages: 50 },
        30_000,
        { signal: watcherSignal },
      );
      tracker.consumeAll(history.events ?? []);
      if (tracker.finished && entries.delete(key)) {
        await deliver(entry, tracker);
      }
    })().catch((error) => {
      if (!watcherSignal.aborted) {
        logger.warn?.('[dsh-dingtalk] deferred turn scan failed:', error?.message ?? error);
      }
    }).finally(() => scans.delete(key));
    scans.set(key, task);
    return task;
  }

  function ensureWatcher() {
    if (watcherStarted || typeof harness?.watchHarnessEvents !== 'function') return;
    watcherStarted = true;
    try {
      const watcher = harness.watchHarnessEvents({
        signal: watcherSignal,
        onSessionEvent: ({ sessionId, event }) => {
          if (watcherSignal.aborted
            || event?.type !== 'turn/end'
            || event?.data?.turn === undefined
            || event?.data?.turn === null) return;
          const entry = entries.get(`${sessionId}\0${event.data.turn}`);
          if (entry) void scanEntry(entry);
        },
        onReconnect: () => {
          // 断连期间可能错过 turn/end，重连后对账。
          for (const entry of [...entries.values()]) void scanEntry(entry);
        },
      });
      Promise.resolve(watcher).catch((error) => {
        if (!watcherSignal.aborted) {
          logger.warn?.('[dsh-dingtalk] deferred event watcher stopped:', error.message);
        }
      });
    } catch (error) {
      watcherStarted = false;
      logger.warn?.('[dsh-dingtalk] deferred event watcher failed to start:', error.message);
    }
  }

  async function register({ key, deferred, route }) {
    if (!deferred || deferred.deferred !== true
      || typeof deferred.sessionId !== 'string' || !deferred.sessionId
      || deferred.turn === undefined || deferred.turn === null) {
      throw new TypeError('A deferred ask handle is required');
    }
    if (!route?.sessionWebhook || !route?.fallbackTarget) {
      throw new TypeError('A delivery route with sessionWebhook and fallbackTarget is required');
    }
    const entry = { key, deferred, route };
    entries.set(entryKeyOf(deferred), entry);
    ensureWatcher();
    // 竞态兜底：turn 可能在 ask 超时与本次注册之间已结束；history 是权威。
    await scanEntry(entry);
  }

  return { register };
}
