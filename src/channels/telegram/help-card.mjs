import { t } from '../shared/i18n.mjs';
import { COMMAND_HELP_GROUPS } from '../shared/command-catalog.mjs';
import {
  ACTION_CARD_STATUS,
  ActionCardRegistry,
  actionCardStateText,
  createCallbackNamespace,
  withActionCardRetry,
  truncateButtonText,
} from '../shared/action-card.mjs';

/**
 * Telegram `/help` as a sectioned card instead of a 30-line text wall.
 *
 * The text `/help` output is pinned byte for byte by a cross-channel regression
 * (Feishu/Slack/Discord/WhatsApp share the same catalog), so this card never
 * replaces it: the card is an additional surface a keyboard channel gets, and a
 * channel without one still receives exactly the text it always did.
 *
 * Design rules, same as the other pickers:
 *   - the home card groups commands by area and opens one section per press;
 *   - a section lists that area's commands with their real usage lines, which
 *     come from the catalog, so help text has exactly one source;
 *   - callbacks carry only `h1|<nonce>|<section>`: no command names, no paths;
 *   - navigation reuses the same nonce, so pressing 返回 keeps working and an
 *     old card cannot be replayed after its TTL.
 */

/** Telegram rejects callback_data longer than 64 bytes; the shared namespace enforces it. */
export const TELEGRAM_HELP_CARD_NAMESPACE_PREFIX = 'h1';
export const TELEGRAM_HELP_CARD_CALLBACK = createCallbackNamespace(
  TELEGRAM_HELP_CARD_NAMESPACE_PREFIX,
);

export const TELEGRAM_HELP_CARD_TTL_MS = 30 * 60 * 1000;
const MAX_CARD_RECORDS = 64;
const EMPTY_KEYBOARD = Object.freeze({ inline_keyboard: [] });

/** Home screen sentinel, and the "back to home" action. */
const HOME = 'home';
/** Commands that are not a section of their own but belong in 「其他」. */
const OTHER = 'other';

/** Button label per section, with the emoji the card shows. */
const SECTION_BUTTON_LABEL = Object.freeze({
  [COMMAND_HELP_GROUPS.session]: '💬 会话',
  [COMMAND_HELP_GROUPS.workspace]: '📁 工作区',
  [COMMAND_HELP_GROUPS.model]: '🤖 模型与预设',
  [COMMAND_HELP_GROUPS.task]: '⚙️ 任务与状态',
  [OTHER]: '📦 其他',
});

/** Body title per section (no emoji: the body is a plain list of usage lines). */
const SECTION_TITLE = Object.freeze({
  [COMMAND_HELP_GROUPS.session]: '会话',
  [COMMAND_HELP_GROUPS.workspace]: '工作区',
  [COMMAND_HELP_GROUPS.model]: '模型与预设',
  [COMMAND_HELP_GROUPS.task]: '任务与状态',
  [OTHER]: '其他',
});

/** The one place a section's display strings are resolved. */
function sectionLabel(group) {
  return SECTION_BUTTON_LABEL[group] ?? group;
}

function sectionTitle(group) {
  return SECTION_TITLE[group] ?? group;
}

/**
 * The order sections appear in. `other` is last and only rendered when it has
 * commands, so a catalog addition cannot silently vanish from the card.
 */
const SECTION_ORDER = Object.freeze([
  COMMAND_HELP_GROUPS.session,
  COMMAND_HELP_GROUPS.workspace,
  COMMAND_HELP_GROUPS.model,
  COMMAND_HELP_GROUPS.task,
  OTHER,
]);

const DEFAULT_STATE_TEXTS = Object.freeze({
  [ACTION_CARD_STATUS.CLAIMED]: '正在打开，请稍候。',
  [ACTION_CARD_STATUS.RESOLVED]: '这条帮助已用过，发送 /help 可再打开一次。',
  [ACTION_CARD_STATUS.EXPIRED]: '这个帮助已过期，发送 /help 可重新打开。',
  [ACTION_CARD_STATUS.SUPERSEDED]: '已显示更新的帮助，请使用最新一条。',
  [ACTION_CARD_STATUS.STALE]: '这个帮助已失效，发送 /help 可重新打开。',
  [ACTION_CARD_STATUS.REVOKED]: '这个帮助已失效，发送 /help 可重新打开。',
  [ACTION_CARD_STATUS.UNKNOWN]: '这个帮助已失效或不存在，发送 /help 可重新打开。',
});

/** The home body: one line per section with how many commands it holds. */
export function helpHomeText(sections) {
  const total = sections.reduce((count, section) => count + section.items.length, 0);
  return [
    t('DeepSeek Harness 帮助'),
    t('共 {count} 条命令，点按钮查看分组：', { count: total }),
  ].join('\n');
}

/** The section body: each command's usage lines, translated. */
export function helpSectionText(section) {
  const lines = [t(sectionTitle(section.group))];
  for (const item of section.items) {
    for (const line of item.lines) lines.push(t(line));
  }
  return lines.join('\n');
}

/**
 * Paint the home screen: one row per section, plus the `/menu` shortcut.
 * Sections are grouped two per row so the card stays short on a phone.
 */
export function renderHelpHome(sections, nonce) {
  const callback = (action) => TELEGRAM_HELP_CARD_CALLBACK.encode({ nonce, action });
  const rows = [];
  const buttons = sections.map((section) => ({
    text: truncateButtonText(`${t(sectionLabel(section.group))}（${section.items.length}）`),
    callback_data: callback(section.group),
  }));
  for (let index = 0; index < buttons.length; index += 2) {
    rows.push(buttons.slice(index, index + 2));
  }
  rows.push([{
    text: truncateButtonText(t('🏠 控制台（/menu）')),
    callback_data: callback('menu'),
  }]);
  return { text: helpHomeText(sections), markup: { inline_keyboard: rows } };
}

/** Paint one section, with a 返回 row. */
export function renderHelpSection(section, nonce) {
  const callback = (action) => TELEGRAM_HELP_CARD_CALLBACK.encode({ nonce, action });
  return {
    text: helpSectionText(section),
    markup: {
      inline_keyboard: [[
        { text: truncateButtonText(t('← 返回')), callback_data: callback(HOME) },
      ]],
    },
  };
}

/** Parse a press produced by either help screen; null for foreign payloads. */
export function parseTelegramHelpCardCallback(data, { sections } = {}) {
  const parsed = TELEGRAM_HELP_CARD_CALLBACK.parse(data);
  if (!parsed) return null;
  const action = parsed.action;
  if (action === HOME || action === 'menu') return { ...parsed, kind: 'help' };
  // Only groups this card actually rendered are legal actions.
  const groups = (sections ?? []).map((section) => section.group);
  if (!groups.includes(action)) return null;
  return { ...parsed, kind: 'help' };
}

/**
 * Telegram adapter for the sectioned `/help`.
 *
 * One instance lives per bridge and owns the nonce registry, so 返回 keeps
 * working on the same message while a card from a previous process cannot.
 */
export class TelegramHelpCard {
  #registry;
  #records = new Map();
  #logger;
  #notices;

  constructor({
    logger = console,
    registry,
    ttlMs = TELEGRAM_HELP_CARD_TTL_MS,
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
   * Send the home screen. Returns false when the channel has no keyboard or the
   * send fails, which leaves the caller free to answer `/help` with the text.
   */
  async present({ bot, target, conversationKey, sections } = {}) {
    if (!target || typeof conversationKey !== 'string' || !conversationKey) return false;
    if (typeof bot?.sendInteractionCard !== 'function') return false;
    if (!Array.isArray(sections) || sections.length === 0) return false;
    const previous = this.#registry.activeFor(conversationKey);
    const entry = this.#registry.issue({ conversationKey, kind: 'help' });
    const card = renderHelpHome(sections, entry.nonce);
    let sent;
    try {
      sent = await bot.sendInteractionCard(target, card);
    } catch (error) {
      this.#registry.settle(entry.nonce, ACTION_CARD_STATUS.REVOKED);
      this.#logger.warn?.(
        '[dsh-im:telegram] could not deliver the /help card; '
        + 'falling back to the text help:',
        error?.message ?? error,
      );
      return false;
    }
    const messageId = Array.isArray(sent?.providerMessageIds) && sent.providerMessageIds.length > 0
      ? String(sent.providerMessageIds[0])
      : null;
    this.#records.set(entry.nonce, { messageId, target, conversationKey, sections });
    this.#pruneRecords();
    if (previous && previous.nonce !== entry.nonce) {
      await this.#retireKeyboard(bot, previous.nonce);
    }
    return true;
  }

  /**
   * Handle one press. Returns false for payloads this card did not produce.
   *
   * Sections navigate in place on the same message, so a help press never spams
   * the chat with a new card per section.
   */
  async handlePress(callback, { bot, answer, conversationKey, openMenu } = {}) {
    const key = typeof conversationKey === 'string' ? conversationKey : '';
    const entry = this.#registry.get(
      typeof callback?.data === 'string' ? /^h1\|([A-Za-z0-9_-]{1,32})\|/u.exec(callback.data)?.[1] : null,
    );
    const record = entry && entry.conversationKey === key ? this.#records.get(entry.nonce) : null;
    const press = parseTelegramHelpCardCallback(callback?.data, { sections: record?.sections ?? [] });
    if (!press) return false;
    const notice = (text) => answer?.(text);
    if (!entry || !record) {
      await notice(actionCardStateText(ACTION_CARD_STATUS.UNKNOWN, this.#notices));
      return true;
    }
    if (entry.status !== ACTION_CARD_STATUS.ACTIVE) {
      await notice(actionCardStateText(entry.status, this.#notices));
      if (entry.status !== ACTION_CARD_STATUS.CLAIMED) {
        await this.#retireKeyboard(bot, entry.nonce);
      }
      return true;
    }

    // The `/menu` shortcut hands off to the hub; it does not repaint this card.
    if (press.action === 'menu') {
      const opened = typeof openMenu === 'function' ? await openMenu() : false;
      await notice(opened ? t('已打开控制台菜单。') : t('暂时无法打开菜单，请发送 /menu。'));
      return true;
    }

    const section = press.action === HOME
      ? null
      : record.sections.find((item) => item.group === press.action) ?? null;
    const card = section
      ? renderHelpSection(section, entry.nonce)
      : renderHelpHome(record.sections, entry.nonce);
    const edited = await this.#editInPlace(bot, entry.nonce, card);
    if (!edited) {
      await this.#retireKeyboard(bot, entry.nonce);
      await notice(t('无法更新帮助卡片，请重新发送 /help。'));
      return true;
    }
    await notice(undefined);
    return true;
  }

  async #editInPlace(bot, nonce, card) {
    const record = this.#records.get(nonce);
    const messageId = Number(record?.messageId);
    if (!record?.target || !Number.isSafeInteger(messageId)) return false;
    if (typeof bot?.editInteractionCard !== 'function') return false;
    try {
      await withActionCardRetry(() => bot.editInteractionCard(record.target, messageId, {
        text: card.text,
        markup: card.markup,
      }));
      return true;
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-im:telegram] could not repaint the /help card:',
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
        '[dsh-im:telegram] could not clear a stale /help keyboard:',
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
