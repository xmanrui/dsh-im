import { t } from '../shared/i18n.mjs';
import {
  ACTION_CARD_STATUS,
  ActionCardRegistry,
  actionCardStateText,
  createCallbackNamespace,
  truncateButtonText,
  withActionCardRetry,
} from '../shared/action-card.mjs';
import {
  PRESENTATION_LEVELS,
  normalizePresentationLevel,
  presentationLevelLabel,
} from '../shared/presentation-level.mjs';

/**
 * Telegram picker for `/display`: how much of a turn this chat shows.
 *
 * The card exists because the setting has three values and a phone user should
 * not have to remember the words: one tap switches, and the card repaints itself
 * so the current rung is always the one marked with ✓. Everything else keeps the
 * text behaviour:
 *
 *   - a channel without a keyboard, a refused card send, or `displayCard: null`
 *     answers with the same three names as text — `/display` is never a dead end;
 *   - callbacks carry only `d1|<nonce>|<level>`: no bot id, no config path, and
 *     the payload stays far under Telegram's 64-byte budget;
 *   - one registry entry per conversation gives the first press a synchronous
 *     claim (a double tap saves once), a TTL (a card found tomorrow cannot change
 *     the setting), and "one live card per conversation".
 */

/** Telegram rejects callback_data longer than 64 bytes; the shared namespace enforces it. */
export const TELEGRAM_DISPLAY_CARD_NAMESPACE_PREFIX = 'd1';
export const TELEGRAM_DISPLAY_CARD_CALLBACK = createCallbackNamespace(
  TELEGRAM_DISPLAY_CARD_NAMESPACE_PREFIX,
);

/** A picker older than this no longer describes a bot whose config may have moved. */
export const TELEGRAM_DISPLAY_CARD_TTL_MS = 30 * 60 * 1000;
const MAX_CARD_RECORDS = 32;

const EMPTY_KEYBOARD = Object.freeze({ inline_keyboard: [] });

const RUNG_LINE = Object.freeze({
  minimal: '极简 · 只看最终答案',
  standard: '标准 · 一条进度消息，结束时收成一行',
  full: '全面 · 思考与工具调用逐条显示',
});

/** The card body: the current rung, then what each rung means in one line. */
export function displayCardText(current) {
  const level = normalizePresentationLevel(current);
  return [
    t('🎛 显示挡位'),
    '',
    t('当前：{level}', { level: presentationLevelLabel(level) }),
    t(RUNG_LINE.minimal),
    t(RUNG_LINE.standard),
    t(RUNG_LINE.full),
  ].join('\n');
}

/** Paint the three buttons; the current rung keeps its ✓ instead of a press. */
export function renderDisplayCard(nonce, current) {
  const level = normalizePresentationLevel(current);
  return {
    text: displayCardText(level),
    markup: {
      inline_keyboard: PRESENTATION_LEVELS.map((rung) => [{
        text: truncateButtonText(rung === level
          ? t('✓ {level}（当前）', { level: presentationLevelLabel(rung) })
          : `◻️ ${presentationLevelLabel(rung)}`),
        callback_data: TELEGRAM_DISPLAY_CARD_CALLBACK.encode({ nonce, action: rung }),
      }]),
    },
  };
}

/** Parse a press produced by {@link renderDisplayCard}; null for foreign payloads. */
export function parseTelegramDisplayCardCallback(data) {
  const parsed = TELEGRAM_DISPLAY_CARD_CALLBACK.parse(data);
  if (!parsed) return null;
  if (!PRESENTATION_LEVELS.includes(parsed.action)) return null;
  return { ...parsed, level: parsed.action };
}

/**
 * Telegram adapter for the `/display` picker.
 *
 * One instance lives per bridge: it owns the nonce registry and the message ids
 * of the pickers it still has to repaint or retire.
 */
export class TelegramDisplayCard {
  #registry;
  #records = new Map();
  #logger;
  #notices;

  constructor({
    logger = console,
    registry,
    ttlMs = TELEGRAM_DISPLAY_CARD_TTL_MS,
    maxEntries = 32,
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
    this.#notices = { ...stateTexts };
  }

  get registry() {
    return this.#registry;
  }

  /**
   * Send one picker. Returns false — leaving the caller free to send the text
   * answer — when the channel has no keyboard or the send fails.
   */
  async present({ bot, target, conversationKey, current } = {}) {
    if (!target || typeof conversationKey !== 'string' || !conversationKey) return false;
    if (typeof bot?.sendInteractionCard !== 'function') return false;
    const level = normalizePresentationLevel(current);
    const previous = this.#registry.activeFor(conversationKey);
    const entry = this.#registry.issue({ conversationKey, kind: 'display' });
    const card = renderDisplayCard(entry.nonce, level);
    let sent;
    try {
      sent = await bot.sendInteractionCard(target, card);
    } catch (error) {
      this.#registry.settle(entry.nonce, ACTION_CARD_STATUS.REVOKED);
      this.#logger.warn?.(
        '[dsh-im:telegram] could not deliver the /display picker; using text:',
        error?.message ?? error,
      );
      return false;
    }
    const messageId = Array.isArray(sent?.providerMessageIds) && sent.providerMessageIds.length > 0
      ? String(sent.providerMessageIds[0])
      : null;
    this.#records.set(entry.nonce, { messageId, target, conversationKey });
    this.#pruneRecords();
    if (previous && previous.nonce !== entry.nonce) {
      await this.#retireKeyboard(bot, previous.nonce);
    }
    return true;
  }

  /**
   * Handle one press. Returns false for payloads this card did not produce.
   *
   * `apply` persists the chosen level and resolves to the stored value, so the
   * repainted card always shows what the bot will actually use.
   */
  async handlePress(callback, { bot, answer, conversationKey, current, apply } = {}) {
    const press = parseTelegramDisplayCardCallback(callback?.data);
    if (!press) return false;
    const notice = (text) => answer?.(text);
    const key = typeof conversationKey === 'string' ? conversationKey : '';
    const entry = this.#registry.get(press.nonce);
    const owned = entry && key && entry.conversationKey === key ? entry : null;
    if (!owned) {
      await notice(actionCardStateText(ACTION_CARD_STATUS.UNKNOWN, this.#notices));
      return true;
    }
    // Synchronous claim, before the first await: a double tap saves once.
    const claimed = this.#registry.claim(press.nonce);
    if (claimed.status !== ACTION_CARD_STATUS.ACTIVE) {
      await notice(actionCardStateText(claimed.status, this.#notices));
      if (claimed.status !== ACTION_CARD_STATUS.CLAIMED) {
        await this.#retireKeyboard(bot, owned.nonce);
      }
      return true;
    }

    const before = normalizePresentationLevel(current);
    // Pressing the rung already in use is not an error: acknowledge it and keep
    // the picker alive, because the user may simply have tapped the marked one.
    if (press.level === before) {
      await this.#repaintFresh(bot, owned, before);
      await notice(t('已经是「{level}」了。', { level: presentationLevelLabel(before) }));
      return true;
    }

    let stored = press.level;
    try {
      if (typeof apply === 'function') stored = await apply(press.level);
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-im:telegram] a /display press failed to save the level:',
        error?.message ?? error,
      );
      // The card stays usable so the user can retry a different rung.
      await this.#repaintFresh(bot, owned, before);
      await notice(t('显示挡位保存失败，请稍后重试。'));
      return true;
    }
    const level = normalizePresentationLevel(stored, press.level);
    // Every press finishes the nonce it claimed, so the repaint must carry a new
    // one: repainting under the dead nonce would answer "already handled" to the
    // next tap.
    await this.#repaintFresh(bot, owned, level);
    await notice(t('显示挡位已设为「{level}」。', { level: presentationLevelLabel(level) }));
    return true;
  }

  /**
   * Retire this presentation and paint the same message with a fresh nonce.
   *
   * One nonce = one press, which is what lets the registry reject double taps;
   * a live picker therefore has to hand itself a new identity after every
   * accepted press.
   */
  async #repaintFresh(bot, entry, level) {
    this.#registry.settle(entry.nonce, ACTION_CARD_STATUS.RESOLVED);
    const record = this.#records.get(entry.nonce);
    const messageId = Number(record?.messageId);
    if (!record?.target || !Number.isSafeInteger(messageId)) return false;
    const next = this.#registry.issue({ conversationKey: entry.conversationKey, kind: 'display' });
    this.#records.delete(entry.nonce);
    this.#records.set(next.nonce, {
      messageId: record.messageId,
      target: record.target,
      conversationKey: entry.conversationKey,
    });
    this.#pruneRecords();
    if (typeof bot?.editInteractionCard !== 'function') return false;
    try {
      await withActionCardRetry(() => bot.editInteractionCard(record.target, messageId, {
        text: displayCardText(level),
        markup: renderDisplayCard(next.nonce, level).markup,
      }));
      return true;
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-im:telegram] could not repaint the /display picker:',
        error?.message ?? error,
      );
      this.#records.delete(next.nonce);
      await this.#retireKeyboard(bot, next.nonce);
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
        '[dsh-im:telegram] could not clear a stale /display keyboard:',
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
