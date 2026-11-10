import { t } from '../shared/i18n.mjs';
import {
  ACTION_CARD_STATUS,
  ActionCardRegistry,
  actionCardStateText,
  createCallbackNamespace,
  truncateButtonText,
} from '../shared/action-card.mjs';

/**
 * Telegram `/start` welcome card.
 *
 * Telegram sends `/start` the first time someone opens the bot (and every time
 * they tap the menu button's Start entry), so it is the one message a new reader
 * is guaranteed to see. Forwarding that literal string to the model — which is
 * what a channel without a handler does — answers a question nobody asked.
 *
 * The card is a launcher, not a manual: three entries that each replay a command
 * the bridge already owns (`/menu`, `/display`, `/help`), so it can never show a
 * state or do something the typed command would not.
 */

/** Telegram rejects callback_data longer than 64 bytes; the shared namespace enforces it. */
export const TELEGRAM_WELCOME_CARD_NAMESPACE_PREFIX = 'w2';
export const TELEGRAM_WELCOME_CARD_CALLBACK = createCallbackNamespace(
  TELEGRAM_WELCOME_CARD_NAMESPACE_PREFIX,
);

export const TELEGRAM_WELCOME_ACTIONS = Object.freeze({
  menu: 'm',
  display: 'd',
  help: 'h',
});

const COMMAND_BY_ACTION = Object.freeze({
  [TELEGRAM_WELCOME_ACTIONS.menu]: '/menu',
  [TELEGRAM_WELCOME_ACTIONS.display]: '/display',
  [TELEGRAM_WELCOME_ACTIONS.help]: '/help',
});

const LABEL_BY_ACTION = Object.freeze({
  [TELEGRAM_WELCOME_ACTIONS.menu]: '🏠 菜单',
  [TELEGRAM_WELCOME_ACTIONS.display]: '🎛 显示挡位',
  [TELEGRAM_WELCOME_ACTIONS.help]: '❓ 帮助',
});

/** A welcome is a greeting, not a console: it does not need to live long. */
export const TELEGRAM_WELCOME_CARD_TTL_MS = 10 * 60 * 1000;
const MAX_CARD_RECORDS = 16;

const DEFAULT_STATE_TEXTS = Object.freeze({
  [ACTION_CARD_STATUS.CLAIMED]: '正在打开，请稍候。',
  [ACTION_CARD_STATUS.RESOLVED]: '这条欢迎卡已经用过了，直接发消息即可。',
  [ACTION_CARD_STATUS.EXPIRED]: '这条欢迎卡已过期，发 /menu 可以打开控制台。',
  [ACTION_CARD_STATUS.SUPERSEDED]: '已显示更新的欢迎卡，请使用最新一条。',
  [ACTION_CARD_STATUS.STALE]: '这条欢迎卡已失效，发 /menu 可以打开控制台。',
  [ACTION_CARD_STATUS.REVOKED]: '这条欢迎卡已失效，发 /menu 可以打开控制台。',
  [ACTION_CARD_STATUS.UNKNOWN]: '这条欢迎卡已失效，发 /menu 可以打开控制台。',
});

/** The greeting body: what this bot is, and the three things worth knowing. */
export function welcomeCardText({ label = 'Telegram', levelLabel = null } = {}) {
  const lines = [
    t('👋 你好，{label} 已连接 DeepSeek Harness。', { label }),
    '',
    t('直接发消息（文字、图片、文件）就能开始，过程和答案都在这条对话里。'),
  ];
  if (levelLabel) {
    lines.push(t('当前过程显示：{level}（可随时切换，不会刷屏）。', { level: levelLabel }));
  }
  lines.push(t('想看全部命令就点「菜单」，想调过程显示就点「显示挡位」。'));
  return lines.join('\n');
}

/** Paint the three entries. */
export function renderWelcomeCard(nonce, { levelLabel = null } = {}) {
  return {
    text: welcomeCardText({ levelLabel }),
    markup: {
      inline_keyboard: [[
        ...Object.values(TELEGRAM_WELCOME_ACTIONS).map((action) => ({
          text: truncateButtonText(t(LABEL_BY_ACTION[action])),
          callback_data: TELEGRAM_WELCOME_CARD_CALLBACK.encode({ nonce, action }),
        })),
      ]],
    },
  };
}

/** Parse a press produced by {@link renderWelcomeCard}; null for foreign payloads. */
export function parseTelegramWelcomeCardCallback(data) {
  const parsed = TELEGRAM_WELCOME_CARD_CALLBACK.parse(data);
  if (!parsed) return null;
  if (!Object.values(TELEGRAM_WELCOME_ACTIONS).includes(parsed.action)) return null;
  return { ...parsed, kind: 'welcome' };
}

/** The command one press replays. */
export function welcomeActionCommand(action) {
  return COMMAND_BY_ACTION[action] ?? null;
}

/**
 * One instance lives per bridge: it owns the nonce registry and the message ids
 * of the greetings it still has to retire.
 */
export class TelegramWelcomeCard {
  #registry;
  #records = new Map();
  #logger;
  #notices;

  constructor({
    logger = console,
    registry,
    ttlMs = TELEGRAM_WELCOME_CARD_TTL_MS,
    maxEntries = MAX_CARD_RECORDS,
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

  /** Send the greeting. False leaves the caller free to answer with text. */
  async present({ bot, target, conversationKey, levelLabel = null } = {}) {
    if (!target || typeof conversationKey !== 'string' || !conversationKey) return false;
    if (typeof bot?.sendInteractionCard !== 'function') return false;
    const entry = this.#registry.issue({ conversationKey, kind: 'welcome' });
    const card = renderWelcomeCard(entry.nonce, { levelLabel });
    let sent;
    try {
      sent = await bot.sendInteractionCard(target, card);
    } catch (error) {
      this.#registry.settle(entry.nonce, ACTION_CARD_STATUS.REVOKED);
      this.#logger.warn?.(
        '[dsh-im:telegram] could not deliver the /start greeting; using text:',
        error?.message ?? error,
      );
      return false;
    }
    const messageId = Array.isArray(sent?.providerMessageIds) && sent.providerMessageIds.length > 0
      ? String(sent.providerMessageIds[0])
      : null;
    this.#records.set(entry.nonce, { messageId, target, conversationKey });
    this.#pruneRecords();
    return true;
  }

  /**
   * Handle one press: replay the command the entry names.
   *
   * `answer` acknowledges the press; `run` returns the command result. The card
   * is a launcher, so it keeps its keyboard — the reader may tap the next entry
   * without sending `/start` again.
   */
  async handlePress(callback, { bot, answer, conversationKey, run } = {}) {
    const press = parseTelegramWelcomeCardCallback(callback?.data);
    if (!press) return false;
    const notice = (text) => answer?.(text);
    const key = typeof conversationKey === 'string' ? conversationKey : '';
    const entry = this.#registry.get(press.nonce);
    const owned = entry && key && entry.conversationKey === key ? entry : null;
    if (!owned) {
      await notice(actionCardStateText(ACTION_CARD_STATUS.UNKNOWN, this.#notices));
      return true;
    }
    // An old greeting must not open the console ten minutes later, and a card a
    // newer greeting replaced must not answer: the registry already knows both.
    if (owned.status !== ACTION_CARD_STATUS.ACTIVE) {
      await notice(actionCardStateText(owned.status, this.#notices));
      if (owned.status !== ACTION_CARD_STATUS.CLAIMED) {
        await this.#retireKeyboard(bot, owned.nonce);
      }
      return true;
    }
    const claim = this.#registry.claim(press.nonce);
    if (claim.status !== ACTION_CARD_STATUS.ACTIVE) {
      await notice(actionCardStateText(claim.status, this.#notices));
      return true;
    }
    const command = welcomeActionCommand(press.action);
    if (!command) {
      await notice(actionCardStateText(ACTION_CARD_STATUS.STALE, this.#notices));
      return true;
    }
    let result = null;
    try {
      result = typeof run === 'function' ? await run(command) : null;
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-im:telegram] a /start entry failed to run its command:',
        error?.message ?? error,
      );
      result = null;
    }
    if (!result?.handled) {
      this.#registry.releaseClaim(owned.nonce);
      await notice(t('暂时无法打开，请直接发送命令。'));
      return true;
    }
    // Release the claim instead of settling: the greeting stays usable for the
    // next entry (it is a launcher, not a one-shot confirmation).
    this.#registry.releaseClaim(owned.nonce);
    for (const reply of result.messages ?? (result.message ? [result.message] : [])) {
      await bot?.sendText?.(callback?.replyTarget, reply);
    }
    await notice(t('已打开。'));
    return true;
  }

  async #retireKeyboard(bot, nonce) {
    const record = this.#records.get(nonce);
    this.#records.delete(nonce);
    // `editInteractionCard` rewrites text *and* keyboard, and the Bot API refuses a
    // text-less edit — retiring a dead greeting only needs the keyboard removed,
    // which is `updateInteractionCard`'s job (approval-card does the same).
    if (!record || typeof bot?.updateInteractionCard !== 'function') return;
    const messageId = Number(record.messageId);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return;
    try {
      await bot.updateInteractionCard(record.target, messageId, { markup: { inline_keyboard: [] } });
    } catch {
      // Best effort: the greeting is already dead.
    }
  }

  #pruneRecords() {
    while (this.#records.size > MAX_CARD_RECORDS) {
      this.#records.delete(this.#records.keys().next().value);
    }
  }
}
