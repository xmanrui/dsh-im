import { t } from '../shared/i18n.mjs';
import {
  ACTION_CARD_STATUS,
  ActionCardRegistry,
  actionCardStateText,
  createCallbackNamespace,
  withActionCardRetry,
  truncateButtonText,
} from '../shared/action-card.mjs';

/**
 * Telegram confirmation card for `/clear`, on top of the shared action-card
 * foundation.
 *
 * `/clear` throws the whole conversation context away and cannot be undone, so a
 * mistyped or fat-fingered command (very easy in a phone chat list) costs real
 * work. The card asks once: 「清空」runs the exact command the text path runs,
 * 「取消」does nothing. Everything else keeps today's behaviour:
 *
 *   - a channel without a keyboard, a refused card send, or `clearCard: null`
 *     executes `/clear` immediately, exactly as before — the confirmation is a
 *     Telegram nicety, never a new cross-channel requirement;
 *   - callbacks carry only `c2|<nonce>|y` / `c2|<nonce>|n`: no session id, no
 *     workspace path, nothing else can fit in 64 bytes anyway;
 *   - one nonce registry entry per presentation gives the first press a
 *     synchronous claim (a double tap clears once), a TTL (a stale prompt cannot
 *     clear a session hours later), and "one live card per conversation".
 */

/** Telegram rejects callback_data longer than 64 bytes; the shared namespace enforces it. */
export const TELEGRAM_CLEAR_CARD_NAMESPACE_PREFIX = 'c2';
export const TELEGRAM_CLEAR_CARD_CALLBACK = createCallbackNamespace(
  TELEGRAM_CLEAR_CARD_NAMESPACE_PREFIX,
);

/** A confirmation prompt older than this no longer describes the chat's state. */
export const TELEGRAM_CLEAR_CARD_TTL_MS = 5 * 60 * 1000;
const MAX_CARD_RECORDS = 64;

const EMPTY_KEYBOARD = Object.freeze({ inline_keyboard: [] });

export const CLEAR_CARD_CONFIRM = 'y';
export const CLEAR_CARD_CANCEL = 'n';

const NOTICES = Object.freeze({
  cancelled: '已取消，当前会话未修改。',
  cleared: '已清空。',
  failed: '清空没有完成，请查看上面的说明。',
  stale: '这条确认已失效，请重新发送 /clear。',
});

const DEFAULT_STATE_TEXTS = Object.freeze({
  [ACTION_CARD_STATUS.CLAIMED]: '正在清空上下文，请稍候。',
  [ACTION_CARD_STATUS.RESOLVED]: '这次清空已处理，无需重复操作。',
  [ACTION_CARD_STATUS.EXPIRED]: '这条清空确认已过期，请重新发送 /clear。',
  [ACTION_CARD_STATUS.SUPERSEDED]: '已显示新的清空确认，请使用最新一条。',
  [ACTION_CARD_STATUS.STALE]: '这条清空确认已失效，请重新发送 /clear。',
  [ACTION_CARD_STATUS.REVOKED]: '这条清空确认已失效，请重新发送 /clear。',
  [ACTION_CARD_STATUS.UNKNOWN]: '这条清空确认已失效或不存在，发送 /clear 可重新发起。',
});

/**
 * The card body. It has to say what survives the clear, because "清空上下文" reads
 * like "delete the conversation" to a user who has never seen the command.
 */
export function clearCardText({ workspace = null, sessionId = null } = {}) {
  const lines = [t('确定要清空当前会话的上下文吗？')];
  if (typeof sessionId === 'string' && sessionId) {
    lines.push(t('会话：{session}', { session: sessionId }));
  }
  if (typeof workspace === 'string' && workspace) {
    lines.push(t('工作区：{workspace}', { workspace }));
  }
  lines.push(
    t('清空后模型不再记得前面的对话内容。'),
    t('Session 绑定和历史记录仍会保留。'),
    t('这个操作不能撤销。'),
  );
  return lines.join('\n');
}

/** Paint the two-button confirmation. */
export function renderClearCard(nonce, text) {
  return {
    text,
    markup: {
      inline_keyboard: [[
        {
          text: truncateButtonText(t('🗑 清空上下文')),
          callback_data: TELEGRAM_CLEAR_CARD_CALLBACK.encode({
            nonce,
            action: CLEAR_CARD_CONFIRM,
          }),
        },
        {
          text: truncateButtonText(t('✖️ 取消')),
          callback_data: TELEGRAM_CLEAR_CARD_CALLBACK.encode({
            nonce,
            action: CLEAR_CARD_CANCEL,
          }),
        },
      ]],
    },
  };
}

/** Parse a press produced by {@link renderClearCard}; null for foreign payloads. */
export function parseTelegramClearCardCallback(data) {
  const parsed = TELEGRAM_CLEAR_CARD_CALLBACK.parse(data);
  if (!parsed) return null;
  if (parsed.action !== CLEAR_CARD_CONFIRM && parsed.action !== CLEAR_CARD_CANCEL) return null;
  return { ...parsed, kind: 'clear' };
}

function resultMessages(result) {
  if (Array.isArray(result?.messages) && result.messages.length > 0) return result.messages;
  return typeof result?.message === 'string' && result.message ? [result.message] : [];
}

/**
 * Telegram adapter for the `/clear` confirmation.
 *
 * One instance lives per bridge: it owns the nonce registry and the message ids
 * of the prompts it still has to retire.
 */
export class TelegramClearCard {
  #registry;
  #records = new Map();
  #logger;
  #notices;

  constructor({
    logger = console,
    registry,
    ttlMs = TELEGRAM_CLEAR_CARD_TTL_MS,
    maxEntries = 64,
    now,
    createNonce,
    stateTexts = {},
  } = {}) {
    this.#registry = registry instanceof ActionCardRegistry
      ? registry
      : new ActionCardRegistry({
        ttlMs,
        maxEntries,
        ...(typeof now === 'function' ? { now } : {}),
        ...(typeof createNonce === 'function' ? { createNonce } : {}),
      });
    this.#logger = logger;
    this.#notices = { ...DEFAULT_STATE_TEXTS, ...stateTexts };
  }

  get registry() {
    return this.#registry;
  }

  /**
   * Send one confirmation prompt. Returns false — leaving the caller free to run
   * `/clear` immediately — when the channel has no keyboard or the send fails.
   */
  async present({ bot, target, conversationKey, workspace, sessionId } = {}) {
    if (!target || typeof conversationKey !== 'string' || !conversationKey) return false;
    if (typeof bot?.sendInteractionCard !== 'function') return false;
    const previous = this.#registry.activeFor(conversationKey);
    const entry = this.#registry.issue({ conversationKey, kind: 'clear' });
    const card = renderClearCard(entry.nonce, clearCardText({ workspace, sessionId }));
    let sent;
    try {
      sent = await bot.sendInteractionCard(target, card);
    } catch (error) {
      this.#registry.settle(entry.nonce, ACTION_CARD_STATUS.REVOKED);
      this.#logger.warn?.(
        '[dsh-im:telegram] could not deliver a /clear confirmation; '
        + 'running /clear without it:',
        error?.message ?? error,
      );
      return false;
    }
    const messageId = Array.isArray(sent?.providerMessageIds) && sent.providerMessageIds.length > 0
      ? String(sent.providerMessageIds[0])
      : null;
    this.#records.set(entry.nonce, { messageId, target, conversationKey, text: card.text });
    this.#pruneRecords();
    if (previous && previous.nonce !== entry.nonce) {
      await this.#retireKeyboard(bot, previous.nonce);
    }
    return true;
  }

  /**
   * Handle one press. Returns false for payloads this card did not produce.
   *
   * `run` executes the real `/clear` for this conversation and resolves to the
   * same command result the text path returns, so the card never changes what
   * `/clear` means — only when it runs.
   */
  async handlePress(callback, { bot, answer, conversationKey, run, sessionId } = {}) {
    const press = parseTelegramClearCardCallback(callback?.data);
    if (!press) return false;
    const notice = (text) => answer?.(text);
    const key = typeof conversationKey === 'string' ? conversationKey : '';
    const entry = this.#registry.get(press.nonce);
    const owned = entry && key && entry.conversationKey === key ? entry : null;
    if (!owned) {
      await notice(actionCardStateText(ACTION_CARD_STATUS.UNKNOWN, this.#notices));
      return true;
    }

    // Synchronous claim, before the first await: a second tap (or a second
    // client) must not clear twice or race the cancel.
    const claimed = this.#registry.claim(press.nonce);
    if (claimed.status !== ACTION_CARD_STATUS.ACTIVE) {
      await notice(actionCardStateText(claimed.status, this.#notices));
      if (claimed.status !== ACTION_CARD_STATUS.CLAIMED) {
        await this.#retireKeyboard(bot, owned.nonce);
      }
      return true;
    }

    if (press.action === CLEAR_CARD_CANCEL) {
      this.#registry.settle(owned.nonce, ACTION_CARD_STATUS.RESOLVED);
      const edited = await this.#editInPlace(bot, owned.nonce, t(NOTICES.cancelled));
      if (!edited) await this.#retireKeyboard(bot, owned.nonce);
      await notice(t(NOTICES.cancelled));
      return true;
    }

    let result = null;
    try {
      result = typeof run === 'function'
        ? await run({ sessionId, callback })
        : null;
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-im:telegram] a /clear confirmation failed to run the command:',
        error?.message ?? error,
      );
      result = null;
    }
    this.#registry.settle(owned.nonce, ACTION_CARD_STATUS.RESOLVED);
    const text = resultMessages(result).join('\n\n').trim();
    const finalText = text || t(NOTICES.failed);
    const edited = await this.#editInPlace(bot, owned.nonce, finalText);
    if (!edited) await this.#retireKeyboard(bot, owned.nonce);
    await notice(t(result?.handled ? NOTICES.cleared : NOTICES.failed));
    return true;
  }

  async #editInPlace(bot, nonce, text) {
    const record = this.#records.get(nonce);
    const messageId = Number(record?.messageId);
    if (!record?.target || !Number.isSafeInteger(messageId)) return false;
    if (typeof bot?.editInteractionCard !== 'function') return false;
    try {
      await withActionCardRetry(() => bot.editInteractionCard(record.target, messageId, {
        text,
        markup: EMPTY_KEYBOARD,
      }));
      return true;
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-im:telegram] could not update a /clear confirmation:',
        error?.message ?? error,
      );
      return false;
    }
  }

  async #retireKeyboard(bot, nonce) {
    const record = this.#records.get(nonce);
    this.#records.delete(nonce);
    const messageId = Number(record?.messageId);
    if (!record?.target || !Number.isSafeInteger(messageId)) return;
    if (typeof bot?.editInteractionCard !== 'function') return;
    try {
      await bot.editInteractionCard(record.target, messageId, { markup: EMPTY_KEYBOARD });
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-im:telegram] could not clear a stale /clear keyboard:',
        error?.message ?? error,
      );
    }
  }

  #pruneRecords() {
    while (this.#records.size > MAX_CARD_RECORDS) {
      this.#records.delete(this.#records.keys().next().value);
    }
  }
}
