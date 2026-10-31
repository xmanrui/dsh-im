import { t } from '../shared/i18n.mjs';
import {
  ACTION_CARD_STATUS,
  ActionCardRegistry,
  actionCardStateText,
  createCallbackNamespace,
  withActionCardRetry,
  safeButtonText,
  truncateButtonText,
} from '../shared/action-card.mjs';

/**
 * Telegram `/status` as a card instead of a paragraph.
 *
 * The card exists to make the status *actionable*: every line that has a picker
 * gets a button that opens it, so "which model am I on?" and "switch it" stop
 * being two separate commands. It follows the same rules as the other cards:
 *
 *   - the text output stays authoritative and byte-identical for channels
 *     without a keyboard (that text is a pinned cross-channel regression);
 *   - callbacks carry only `t1|<nonce>|<action>`: no workspace path, no Session
 *     id, nothing that could exceed Telegram's 64-byte budget;
 *   - every entry replays the command the user could have typed, so the card can
 *     never do something no command does;
 *   - the card is a view of one snapshot. It does not auto-refresh: a stale
 *     status is worse than an obviously old one, so the button says 「刷新」.
 */

/** Telegram rejects callback_data longer than 64 bytes; the shared namespace enforces it. */
export const TELEGRAM_STATUS_CARD_NAMESPACE_PREFIX = 't1';
export const TELEGRAM_STATUS_CARD_CALLBACK = createCallbackNamespace(
  TELEGRAM_STATUS_CARD_NAMESPACE_PREFIX,
);

export const TELEGRAM_STATUS_CARD_TTL_MS = 30 * 60 * 1000;
const MAX_CARD_RECORDS = 64;
const EMPTY_KEYBOARD = Object.freeze({ inline_keyboard: [] });

/** One action per entry; `refresh` re-reads the snapshot, the rest open pickers. */
export const TELEGRAM_STATUS_ACTIONS = Object.freeze({
  refresh: 'r',
  sessions: 's',
  workspace: 'w',
  models: 'm',
  presets: 'p',
  menu: 'u',
  help: 'h',
});

const COMMAND_BY_ACTION = Object.freeze({
  [TELEGRAM_STATUS_ACTIONS.sessions]: '/sessionlist',
  [TELEGRAM_STATUS_ACTIONS.workspace]: '/ws',
  [TELEGRAM_STATUS_ACTIONS.models]: '/models',
  [TELEGRAM_STATUS_ACTIONS.presets]: '/presetlist',
  [TELEGRAM_STATUS_ACTIONS.menu]: '/menu',
  [TELEGRAM_STATUS_ACTIONS.help]: '/help',
});

const LABEL_BY_ACTION = Object.freeze({
  [TELEGRAM_STATUS_ACTIONS.refresh]: '🔄 刷新',
  [TELEGRAM_STATUS_ACTIONS.sessions]: '💬 会话',
  [TELEGRAM_STATUS_ACTIONS.workspace]: '📁 工作区',
  [TELEGRAM_STATUS_ACTIONS.models]: '🤖 模型',
  [TELEGRAM_STATUS_ACTIONS.presets]: '🧩 预设',
  [TELEGRAM_STATUS_ACTIONS.menu]: '🏠 菜单',
  [TELEGRAM_STATUS_ACTIONS.help]: '❓ 帮助',
});

const DEFAULT_STATE_TEXTS = Object.freeze({
  [ACTION_CARD_STATUS.CLAIMED]: '正在刷新，请稍候。',
  [ACTION_CARD_STATUS.RESOLVED]: '这条状态已处理，发送 /status 可再看一次。',
  [ACTION_CARD_STATUS.EXPIRED]: '这个状态卡已过期，发送 /status 可刷新。',
  [ACTION_CARD_STATUS.SUPERSEDED]: '已显示更新的状态，请使用最新一条。',
  [ACTION_CARD_STATUS.STALE]: '这个状态卡已失效，发送 /status 可刷新。',
  [ACTION_CARD_STATUS.REVOKED]: '这个状态卡已失效，发送 /status 可刷新。',
  [ACTION_CARD_STATUS.UNKNOWN]: '这个状态卡已失效或不存在，发送 /status 可重新打开。',
});

const NOTICES = Object.freeze({
  refreshed: '已刷新。',
  refreshFailed: '刷新失败，请发送 /status。',
  opened: '已打开：{label}',
  openFailed: '暂时无法打开，请直接发送命令。',
});

/** The last path segment, which is what makes a workspace recognizable. */
function workspaceName(path) {
  const text = safeButtonText(path).replace(/\/+$/u, '');
  if (!text) return '';
  return text.slice(text.lastIndexOf('/') + 1) || text;
}

/**
 * Render the card body from one status snapshot.
 *
 * Every line the text version prints is kept: the card is a re-presentation, not
 * a summary, so a user who learned to read `/status` does not have to relearn it.
 */
export function statusCardText(snapshot = {}) {
  const {
    label = 'Telegram',
    workspace = null,
    sessionId = null,
    model = null,
    preset = null,
    running = false,
  } = snapshot ?? {};
  const lines = [t('{label}机器人与 DeepSeek Harness 连接正常。', { label })];
  const shared = snapshot?.shared === true;
  const name = workspaceName(workspace);
  if (name) {
    // The status command already shortened this in a group; say so, because a
    // bare last segment otherwise reads like a full path that got truncated.
    lines.push(shared
      ? t('工作区：{workspace}（群聊中仅显示末段）', { workspace: name })
      : t('工作区：{workspace}', { workspace: name }));
  }
  if (typeof sessionId === 'string' && sessionId) {
    // A group only needs enough to tell sessions apart.
    lines.push(t('绑定会话：{session}', { session: shared ? `…${sessionId.slice(-6)}` : sessionId }));
  } else {
    lines.push(t('绑定会话：未绑定（发送消息后自动创建）'));
  }
  if (typeof model === 'string' && model) {
    lines.push(t('当前模型：{model}', { model }));
  } else if (snapshot?.modelHidden === true) {
    lines.push(t('当前模型：已设置（群聊中不显示具体名称）'));
  } else if (!sessionId) {
    lines.push(t('当前模型：暂无（创建会话后显示）'));
  }
  if (typeof preset === 'string' && preset) {
    lines.push(t('Agent Preset（预设）：{preset}', { preset }));
  }
  if (running === true) lines.push(t('运行中任务：有（发送 /stop 可停止）'));
  return lines.join('\n');
}

/**
 * Paint the card: a refresh row first (the thing people reach for), then the
 * pickers. Two per row keeps it compact on a phone.
 */
export function renderStatusCard(snapshot, nonce, { sessionId = null } = {}) {
  const callback = (action) => TELEGRAM_STATUS_CARD_CALLBACK.encode({ nonce, action });
  const rows = [[
    {
      text: truncateButtonText(t(LABEL_BY_ACTION[TELEGRAM_STATUS_ACTIONS.refresh])),
      callback_data: callback(TELEGRAM_STATUS_ACTIONS.refresh),
    },
    {
      text: truncateButtonText(t(LABEL_BY_ACTION[TELEGRAM_STATUS_ACTIONS.menu])),
      callback_data: callback(TELEGRAM_STATUS_ACTIONS.menu),
    },
  ]];
  // The session picker is pointless without a session to pick from, but the card
  // still offers it: /sessionlist answers with the workspace's own list.
  const entries = [
    TELEGRAM_STATUS_ACTIONS.sessions,
    TELEGRAM_STATUS_ACTIONS.workspace,
    TELEGRAM_STATUS_ACTIONS.models,
  ];
  // Presets only make sense when the Host reports a preset at all.
  if (snapshot?.preset) entries.push(TELEGRAM_STATUS_ACTIONS.presets);
  entries.push(TELEGRAM_STATUS_ACTIONS.help);
  for (let index = 0; index < entries.length; index += 2) {
    rows.push(entries.slice(index, index + 2).map((action) => ({
      text: truncateButtonText(t(LABEL_BY_ACTION[action])),
      callback_data: callback(action),
    })));
  }
  return {
    text: statusCardText(snapshot),
    markup: { inline_keyboard: rows },
  };
}

/** Parse a press produced by {@link renderStatusCard}; null for foreign payloads. */
export function parseTelegramStatusCardCallback(data) {
  const parsed = TELEGRAM_STATUS_CARD_CALLBACK.parse(data);
  if (!parsed) return null;
  if (!Object.values(TELEGRAM_STATUS_ACTIONS).includes(parsed.action)) return null;
  return { ...parsed, kind: 'status' };
}

/** The command one press replays; null for `refresh`, which is handled directly. */
export function statusActionCommand(action) {
  return COMMAND_BY_ACTION[action] ?? null;
}

export function statusActionLabel(action) {
  return LABEL_BY_ACTION[action] ?? '';
}

function resultMessages(result) {
  if (Array.isArray(result?.messages) && result.messages.length > 0) return result.messages;
  return typeof result?.message === 'string' && result.message ? [result.message] : [];
}

/**
 * Telegram adapter for the `/status` card.
 *
 * One instance lives per bridge and owns the nonce registry. Refreshing repaints
 * the same message (that is the whole point of the button), while the pickers
 * hand off to their own cards and leave this one alone.
 */
export class TelegramStatusCard {
  #registry;
  #records = new Map();
  #logger;
  #notices;

  constructor({
    logger = console,
    registry,
    ttlMs = TELEGRAM_STATUS_CARD_TTL_MS,
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
   * Send the card. Returns false when the channel has no keyboard or the send
   * fails, which leaves the caller free to send the text status instead.
   */
  async present({ bot, target, conversationKey, snapshot } = {}) {
    if (!target || typeof conversationKey !== 'string' || !conversationKey) return false;
    if (typeof bot?.sendInteractionCard !== 'function') return false;
    if (!snapshot || typeof snapshot !== 'object') return false;
    const previous = this.#registry.activeFor(conversationKey);
    const entry = this.#registry.issue({ conversationKey, kind: 'status' });
    const card = renderStatusCard(snapshot, entry.nonce);
    let sent;
    try {
      sent = await bot.sendInteractionCard(target, card);
    } catch (error) {
      this.#registry.settle(entry.nonce, ACTION_CARD_STATUS.REVOKED);
      this.#logger.warn?.(
        '[dsh-im:telegram] could not deliver the /status card; '
        + 'falling back to the text status:',
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
   * `refresh` re-reads the status through the same command the text path uses and
   * repaints in place; `run` replays a picker command and leaves this card as is.
   */
  async handlePress(callback, {
    bot,
    answer,
    conversationKey,
    refresh,
    run,
  } = {}) {
    const press = parseTelegramStatusCardCallback(callback?.data);
    if (!press) return false;
    const notice = (text) => answer?.(text);
    const key = typeof conversationKey === 'string' ? conversationKey : '';
    const entry = this.#registry.get(press.nonce);
    const owned = entry && key && entry.conversationKey === key ? entry : null;
    if (!owned) {
      await notice(actionCardStateText(ACTION_CARD_STATUS.UNKNOWN, this.#notices));
      return true;
    }
    if (owned.status !== ACTION_CARD_STATUS.ACTIVE) {
      await notice(actionCardStateText(owned.status, this.#notices));
      if (owned.status !== ACTION_CARD_STATUS.CLAIMED) {
        await this.#retireKeyboard(bot, owned.nonce);
      }
      return true;
    }

    if (press.action === TELEGRAM_STATUS_ACTIONS.refresh) {
      // Claim before the read: a double tap must not fire two refreshes.
      const claimed = this.#registry.claim(press.nonce);
      if (claimed.status !== ACTION_CARD_STATUS.ACTIVE) {
        await notice(actionCardStateText(claimed.status, this.#notices));
        return true;
      }
      let snapshot = null;
      try {
        snapshot = typeof refresh === 'function' ? await refresh() : null;
      } catch (error) {
        this.#logger.warn?.(
          '[dsh-im:telegram] a /status refresh failed:',
          error?.message ?? error,
        );
        snapshot = null;
      }
      if (!snapshot) {
        // Keep the card usable: a failed read must not consume the button.
        this.#registry.releaseClaim(press.nonce);
        await notice(t(NOTICES.refreshFailed));
        return true;
      }
      const repainted = await this.#editInPlace(
        bot,
        press.nonce,
        renderStatusCard(snapshot, press.nonce),
      );
      if (!repainted) {
        this.#registry.releaseClaim(press.nonce);
        await notice(t(NOTICES.refreshFailed));
        return true;
      }
      // The card stays live so 刷新 can be pressed again.
      this.#registry.releaseClaim(press.nonce);
      await notice(t(NOTICES.refreshed));
      return true;
    }

    const command = statusActionCommand(press.action);
    if (!command) {
      await notice(actionCardStateText(ACTION_CARD_STATUS.STALE, this.#notices));
      return true;
    }
    let result = null;
    try {
      result = typeof run === 'function' ? await run(command) : null;
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-im:telegram] a /status entry failed to run its command:',
        error?.message ?? error,
      );
      result = null;
    }
    if (!result?.handled) {
      await notice(t(NOTICES.openFailed));
      return true;
    }
    for (const reply of resultMessages(result)) {
      await bot?.sendText?.(callback?.replyTarget, reply);
    }
    await notice(t(NOTICES.opened, { label: truncateButtonText(t(statusActionLabel(press.action))) }));
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
        '[dsh-im:telegram] could not repaint the /status card:',
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
        '[dsh-im:telegram] could not clear a stale /status keyboard:',
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
