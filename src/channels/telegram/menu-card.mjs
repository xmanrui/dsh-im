import { t } from '../shared/i18n.mjs';
import {
  ACTION_CARD_STATUS,
  ActionCardRegistry,
  actionCardStateText,
  createCallbackNamespace,
  truncateButtonText,
} from '../shared/action-card.mjs';

/**
 * Telegram `/menu` hub card: one summary plus one-tap entries into the pickers
 * this channel already has.
 *
 * Every other text channel either has its own menu (Feishu) or no pickers at
 * all, so this card is Telegram-only and never changes what a command means:
 * a button only *opens* the card the command would have sent anyway. That is the
 * whole design rule here:
 *
 *   - the hub renders a snapshot the bridge already reads for `/status`, so
 *     opening it costs no extra Host round-trip;
 *   - a press replays the exact command (`/sessionlist`, `/ws`, `/models`,
 *     `/presetlist`, `/status`, `/help`), so the hub can never show a state the
 *     command itself would not;
 *   - callbacks carry only `m3|<nonce>|<action>`: no workspace path, no Session
 *     id, nothing that could exceed Telegram's 64-byte budget;
 *   - a channel without a keyboard, an unreadable snapshot, or a refused send
 *     falls back to the plain `/help` text, so `/menu` is never a dead end.
 */

/** Telegram rejects callback_data longer than 64 bytes; the shared namespace enforces it. */
export const TELEGRAM_MENU_CARD_NAMESPACE_PREFIX = 'm3';
export const TELEGRAM_MENU_CARD_CALLBACK = createCallbackNamespace(
  TELEGRAM_MENU_CARD_NAMESPACE_PREFIX,
);

/** Entries that open one of the existing pickers. Order is the visual order. */
export const TELEGRAM_MENU_ACTIONS = Object.freeze({
  sessions: 's',
  workspace: 'w',
  models: 'm',
  presets: 'p',
  status: 't',
  help: 'h',
});

/** The command each entry replays. One source of truth, no duplicated logic. */
const COMMAND_BY_ACTION = Object.freeze({
  [TELEGRAM_MENU_ACTIONS.sessions]: '/sessionlist',
  [TELEGRAM_MENU_ACTIONS.workspace]: '/ws',
  [TELEGRAM_MENU_ACTIONS.models]: '/models',
  [TELEGRAM_MENU_ACTIONS.presets]: '/presetlist',
  [TELEGRAM_MENU_ACTIONS.status]: '/status',
  [TELEGRAM_MENU_ACTIONS.help]: '/help',
});

const LABEL_BY_ACTION = Object.freeze({
  [TELEGRAM_MENU_ACTIONS.sessions]: '💬 会话',
  [TELEGRAM_MENU_ACTIONS.workspace]: '📁 工作区',
  [TELEGRAM_MENU_ACTIONS.models]: '🤖 模型',
  [TELEGRAM_MENU_ACTIONS.presets]: '🧩 预设',
  [TELEGRAM_MENU_ACTIONS.status]: '📊 状态',
  [TELEGRAM_MENU_ACTIONS.help]: '❓ 帮助',
});

export const TELEGRAM_MENU_CARD_TTL_MS = 30 * 60 * 1000;
const MAX_CARD_RECORDS = 64;
const EMPTY_KEYBOARD = Object.freeze({ inline_keyboard: [] });

const DEFAULT_STATE_TEXTS = Object.freeze({
  [ACTION_CARD_STATUS.CLAIMED]: '正在打开，请稍候。',
  [ACTION_CARD_STATUS.RESOLVED]: '这条菜单已用过，发送 /menu 可再打开一次。',
  [ACTION_CARD_STATUS.EXPIRED]: '这个菜单已过期，发送 /menu 可重新打开。',
  [ACTION_CARD_STATUS.SUPERSEDED]: '已显示更新的菜单，请使用最新一条。',
  [ACTION_CARD_STATUS.STALE]: '这个菜单已失效，发送 /menu 可重新打开。',
  [ACTION_CARD_STATUS.REVOKED]: '这个菜单已失效，发送 /menu 可重新打开。',
  [ACTION_CARD_STATUS.UNKNOWN]: '这个菜单已失效或不存在，发送 /menu 可重新打开。',
});

const NOTICES = Object.freeze({
  opened: '已打开：{label}',
  failed: '暂时无法打开，请直接发送命令。',
});

/** The short last-path segment, which is what makes a workspace recognizable. */
function workspaceName(path) {
  const text = typeof path === 'string' ? path.replace(/\/+$/u, '') : '';
  if (!text) return '';
  const segment = text.slice(text.lastIndexOf('/') + 1);
  return segment || text;
}

/**
 * Render the hub body from data the bridge already has.
 *
 * Everything is optional: a missing field simply drops its line, so a channel
 * with a thin Harness still gets a usable menu instead of an error.
 */
export function menuCardText({
  workspace = null,
  sessionId = null,
  model = null,
  preset = null,
  running = false,
} = {}) {
  const lines = [t('DeepSeek Harness 控制台')];
  const name = workspaceName(workspace);
  if (name) lines.push(t('工作区：{workspace}', { workspace: name }));
  if (typeof sessionId === 'string' && sessionId) {
    lines.push(t('会话：{session}', { session: sessionId }));
  } else {
    lines.push(t('会话：未绑定（发送消息后自动创建）'));
  }
  if (typeof model === 'string' && model) lines.push(t('模型：{model}', { model }));
  if (typeof preset === 'string' && preset) lines.push(t('预设：{preset}', { preset }));
  if (running === true) lines.push(t('任务：正在运行（/stop 可停止）'));
  return lines.join('\n');
}

/** Paint the hub: two rows of three entries. */
export function renderMenuCard(nonce) {
  const callback = (action) => TELEGRAM_MENU_CARD_CALLBACK.encode({ nonce, action });
  const entries = Object.values(TELEGRAM_MENU_ACTIONS);
  const rows = [];
  for (let index = 0; index < entries.length; index += 3) {
    rows.push(entries.slice(index, index + 3).map((action) => ({
      text: truncateButtonText(t(LABEL_BY_ACTION[action])),
      callback_data: callback(action),
    })));
  }
  return { markup: { inline_keyboard: rows } };
}

/** Parse a press produced by {@link renderMenuCard}; null for foreign payloads. */
export function parseTelegramMenuCardCallback(data) {
  const parsed = TELEGRAM_MENU_CARD_CALLBACK.parse(data);
  if (!parsed) return null;
  if (!Object.values(TELEGRAM_MENU_ACTIONS).includes(parsed.action)) return null;
  return { ...parsed, kind: 'menu' };
}

/** The command one press replays; null for an action this hub does not own. */
export function menuActionCommand(action) {
  return COMMAND_BY_ACTION[action] ?? null;
}

export function menuActionLabel(action) {
  return LABEL_BY_ACTION[action] ?? '';
}

function resultMessages(result) {
  if (Array.isArray(result?.messages) && result.messages.length > 0) return result.messages;
  return typeof result?.message === 'string' && result.message ? [result.message] : [];
}

/**
 * Telegram adapter for the `/menu` hub.
 *
 * One instance lives per bridge and owns the nonce registry, so a hub opened ten
 * minutes ago still works while a hub from a previous process cannot be replayed.
 */
export class TelegramMenuCard {
  #registry;
  #records = new Map();
  #logger;
  #notices;

  constructor({
    logger = console,
    registry,
    ttlMs = TELEGRAM_MENU_CARD_TTL_MS,
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
   * Send the hub. Returns false when the channel has no keyboard or the send
   * fails, which leaves the caller free to answer `/menu` with the help text.
   */
  async present({ bot, target, conversationKey, snapshot } = {}) {
    if (!target || typeof conversationKey !== 'string' || !conversationKey) return false;
    if (typeof bot?.sendInteractionCard !== 'function') return false;
    const previous = this.#registry.activeFor(conversationKey);
    const entry = this.#registry.issue({ conversationKey, kind: 'menu' });
    const text = menuCardText(snapshot);
    let sent;
    try {
      sent = await bot.sendInteractionCard(target, {
        text,
        markup: renderMenuCard(entry.nonce).markup,
      });
    } catch (error) {
      this.#registry.settle(entry.nonce, ACTION_CARD_STATUS.REVOKED);
      this.#logger.warn?.(
        '[dsh-im:telegram] could not deliver the /menu hub; '
        + 'falling back to the help text:',
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
   * Handle one press. Returns false for payloads this hub did not produce.
   *
   * `run` replays the entry's command and returns its result, so the hub only
   * decides *which* command runs — never what it does.
   */
  async handlePress(callback, { bot, answer, conversationKey, run } = {}) {
    const press = parseTelegramMenuCardCallback(callback?.data);
    if (!press) return false;
    const notice = (text) => answer?.(text);
    const key = typeof conversationKey === 'string' ? conversationKey : '';
    const entry = this.#registry.get(press.nonce);
    const owned = entry && key && entry.conversationKey === key ? entry : null;
    if (!owned) {
      await notice(actionCardStateText(ACTION_CARD_STATUS.UNKNOWN, this.#notices));
      return true;
    }

    // A hub is a launcher, not a one-shot: it stays usable, so the press is
    // acknowledged without claiming or settling the card. It still has to be
    // alive, though: an expired or superseded hub must not drive anything.
    if (owned.status !== ACTION_CARD_STATUS.ACTIVE) {
      await notice(actionCardStateText(owned.status, this.#notices));
      if (owned.status !== ACTION_CARD_STATUS.CLAIMED) {
        await this.#retireKeyboard(bot, owned.nonce);
      }
      return true;
    }
    const command = menuActionCommand(press.action);
    if (!command) {
      await notice(actionCardStateText(ACTION_CARD_STATUS.STALE, this.#notices));
      return true;
    }
    let result = null;
    try {
      result = typeof run === 'function' ? await run(command) : null;
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-im:telegram] a /menu entry failed to run its command:',
        error?.message ?? error,
      );
      result = null;
    }
    if (!result?.handled) {
      await notice(t(NOTICES.failed));
      return true;
    }
    // Send the entry's own output as text. The picker entries render their cards
    // through the normal command path, so the hub never repaints itself.
    for (const reply of resultMessages(result)) {
      await bot?.sendText?.(callback?.replyTarget, reply);
    }
    await notice(t(NOTICES.opened, { label: truncateButtonText(t(menuActionLabel(press.action))) }));
    return true;
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
        '[dsh-im:telegram] could not clear a stale /menu keyboard:',
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
