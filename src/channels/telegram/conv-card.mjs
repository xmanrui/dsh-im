import { t } from '../shared/i18n.mjs';
import { workspaceLabels } from '../shared/workspace-labels.mjs';
import {
  ACTION_CARD_STATUS,
  ActionCardRegistry,
  actionCardStateText,
  createCallbackNamespace,
  truncateButtonText,
} from '../shared/action-card.mjs';
import { runWorkspaceCommand } from '../shared/workspace-command.mjs';

/**
 * Telegram card for `/conv` — the *conversation-scoped* workspace.
 *
 * This is deliberately a separate card from `/ws`, not a variant of it: the two
 * commands mean different things and mixing them up is the expensive mistake.
 *
 *   - `/ws`   changes the bot's default workspace for every conversation;
 *   - `/conv` pins *this* conversation, and 清除 returns it to following the
 *     default.
 *
 * So the card says which one it is, shows whether this conversation is pinned or
 * merely following the default, and offers 清除 only when clearing means
 * something. Every press replays the typed command, so the card cannot drift from
 * `/conv`'s own behaviour.
 */

/** Telegram rejects callback_data longer than 64 bytes; the shared namespace enforces it. */
export const TELEGRAM_CONV_CARD_NAMESPACE_PREFIX = 'v1';
export const TELEGRAM_CONV_CARD_CALLBACK = createCallbackNamespace(
  TELEGRAM_CONV_CARD_NAMESPACE_PREFIX,
);

export const TELEGRAM_CONV_CARD_MAX_ITEMS = 40;
export const TELEGRAM_CONV_CARD_TTL_MS = 30 * 60 * 1000;
const MAX_CARD_RECORDS = 64;
const EMPTY_KEYBOARD = Object.freeze({ inline_keyboard: [] });
const UNSAFE_DISPLAY_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export const TELEGRAM_CONV_CLEAR_ACTION = 'x';

const DEFAULT_STATE_TEXTS = Object.freeze({
  [ACTION_CARD_STATUS.CLAIMED]: '正在切换本对话的工作区，请稍候。',
  [ACTION_CARD_STATUS.RESOLVED]: '这条对话工作区卡已处理，发送 /conv 可再看一次。',
  [ACTION_CARD_STATUS.EXPIRED]: '这条对话工作区卡已过期，发送 /conv 可重新打开。',
  [ACTION_CARD_STATUS.SUPERSEDED]: '已显示更新的对话工作区卡，请使用最新一条。',
  [ACTION_CARD_STATUS.STALE]: '这条对话工作区卡已失效，发送 /conv 可重新打开。',
  [ACTION_CARD_STATUS.REVOKED]: '这条对话工作区卡已失效，发送 /conv 可重新打开。',
  [ACTION_CARD_STATUS.UNKNOWN]: '这条对话工作区卡已失效或不存在，发送 /conv 可重新打开。',
});

const NOTICES = Object.freeze({
  switched: '本对话工作区已切换。',
  cleared: '已清除对话专属工作区。',
  failed: '操作没有完成，请直接发送 /conv 命令。',
});

/**
 * Build the body: which conversation, whether it is pinned, and what happens to
 * the default. The distinction is spelled out because that is the one thing users
 * get wrong about `/conv` versus `/ws`.
 */
export function convCardText({ current = null, bound = false, paths = [] } = {}) {
  const lines = [t('本对话专属工作区')];
  lines.push(typeof current === 'string' && current
    ? t('当前：{workspace}', { workspace: current })
    : t('当前：未设置'));
  lines.push(bound
    ? t('状态：已为本对话显式绑定，之后修改 bot 默认工作区不影响本对话。')
    : t('状态：未显式绑定，当前跟随 bot 默认工作区。'));
  // Say out loud what the other command does, so a press here is never mistaken
  // for changing the bot-wide default.
  lines.push(t('注意：这里只影响本对话；改所有对话请用 /ws。'));
  if (Array.isArray(paths) && paths.length > 0) {
    lines.push('', t('可切换的工作区（{count}）：', { count: paths.length }));
  }
  return lines.join('\n');
}

/**
 * Paint the picker. Returns null when the listing cannot be rendered as a
 * keyboard, which keeps the caller's text output in charge.
 */
export function renderConvCard(listing, nonce) {
  if (!listing || typeof listing !== 'object') return null;
  const paths = Array.isArray(listing.paths) ? listing.paths : [];
  if (paths.length === 0 || paths.length > TELEGRAM_CONV_CARD_MAX_ITEMS) return null;
  // A path with control characters would break the callback budget / rendering.
  if (paths.some((path) => typeof path !== 'string' || !path || UNSAFE_DISPLAY_TEXT.test(path))) {
    return null;
  }
  const labels = workspaceLabels(paths);
  const callback = (action) => TELEGRAM_CONV_CARD_CALLBACK.encode({ nonce, action });
  const rows = paths.map((path, index) => [{
    text: truncateButtonText(
      `${path === listing.current ? '✓ ' : ''}${index + 1}. ${labels[index].label}`,
    ),
    // A path cannot ride in the 64-byte budget, so the button carries its index
    // and the press resolves it against this same listing.
    callback_data: callback(`i${index + 1}`),
  }]);
  // 清除 only means something when this conversation is actually pinned.
  if (listing.bound) {
    rows.push([{
      text: truncateButtonText(t('✖️ 清除专属（回到默认）')),
      callback_data: callback(TELEGRAM_CONV_CLEAR_ACTION),
    }]);
  }
  return { text: convCardText(listing), markup: { inline_keyboard: rows } };
}

/** Parse a press produced by {@link renderConvCard}; null for foreign payloads. */
export function parseTelegramConvCardCallback(data) {
  const parsed = TELEGRAM_CONV_CARD_CALLBACK.parse(data);
  if (!parsed) return null;
  if (parsed.action === TELEGRAM_CONV_CLEAR_ACTION) {
    return { ...parsed, kind: 'conv-clear' };
  }
  const index = /^i(\d{1,2})$/u.exec(parsed.action);
  if (!index) return null;
  return { ...parsed, kind: 'conv-pick', index: Number(index[1]) };
}

function resultMessages(result) {
  if (Array.isArray(result?.messages) && result.messages.length > 0) return result.messages;
  return typeof result?.message === 'string' && result.message ? [result.message] : [];
}

/**
 * Telegram adapter for `/conv`.
 *
 * One instance lives per bridge. Picking a workspace re-runs `/conv <path>`
 * through the shared command, so adoption, validation and every failure wording
 * stay in one place.
 */
export class TelegramConvCard {
  #registry;
  #records = new Map();
  #logger;
  #notices;

  constructor({
    logger = console,
    registry,
    ttlMs = TELEGRAM_CONV_CARD_TTL_MS,
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

  /** Send the card. Returns false so the caller can keep the text output. */
  async present({ bot, target, conversationKey, listing } = {}) {
    if (!target || typeof conversationKey !== 'string' || !conversationKey) return false;
    if (typeof bot?.sendInteractionCard !== 'function') return false;
    const previous = this.#registry.activeFor(conversationKey);
    const entry = this.#registry.issue({
      conversationKey,
      kind: 'conv',
      payload: { listing, target, messageId: null },
    });
    const card = renderConvCard(listing, entry.nonce);
    if (!card) {
      this.#registry.settle(entry.nonce, ACTION_CARD_STATUS.REVOKED);
      return false;
    }
    let sent;
    try {
      sent = await bot.sendInteractionCard(target, card);
    } catch (error) {
      this.#registry.settle(entry.nonce, ACTION_CARD_STATUS.REVOKED);
      this.#logger.warn?.(
        '[dsh-im:telegram] could not deliver the /conv card; '
        + 'falling back to the text output:',
        error?.message ?? error,
      );
      return false;
    }
    const messageId = Array.isArray(sent?.providerMessageIds) && sent.providerMessageIds.length > 0
      ? String(sent.providerMessageIds[0])
      : null;
    entry.payload.messageId = messageId;
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
   * `switchTo` takes the workspace path and returns the command result; the card
   * repaints itself from the fresh listing the command returns.
   */
  async handlePress(callback, { bot, answer, conversationKey, switchTo, clear } = {}) {
    const press = parseTelegramConvCardCallback(callback?.data);
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

    const listing = owned.payload?.listing ?? {};
    let command = null;
    if (press.kind === 'conv-clear') {
      if (!listing.bound) {
        // Nothing is pinned: clearing would be a no-op dressed as an action.
        await notice(actionCardStateText(ACTION_CARD_STATUS.STALE, this.#notices));
        return true;
      }
      command = '/conv clear';
    } else {
      const path = Array.isArray(listing.paths) ? listing.paths[press.index - 1] : null;
      if (typeof path !== 'string' || !path) {
        await notice(actionCardStateText(ACTION_CARD_STATUS.STALE, this.#notices));
        return true;
      }
      command = `/conv ${path}`;
    }

    const claimed = this.#registry.claim(press.nonce);
    if (claimed.status !== ACTION_CARD_STATUS.ACTIVE) {
      await notice(actionCardStateText(claimed.status, this.#notices));
      return true;
    }

    let result = null;
    try {
      result = press.kind === 'conv-clear'
        ? (typeof clear === 'function' ? await clear() : null)
        : (typeof switchTo === 'function' ? await switchTo(command) : null);
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-im:telegram] a /conv card press failed:',
        error?.message ?? error,
      );
      result = null;
    }
    if (!result?.handled) {
      // Keep the card usable: a failed switch must not consume the picker.
      this.#registry.releaseClaim(press.nonce);
      await notice(t(NOTICES.failed));
      return true;
    }

    this.#registry.settle(owned.nonce, ACTION_CARD_STATUS.RESOLVED);
    // Deliver the command's own wording, then retire the keyboard: the listing it
    // was built from has just changed, so keeping it pressable would be a lie.
    for (const reply of resultMessages(result)) {
      await bot?.sendText?.(callback?.replyTarget, reply);
    }
    await this.#retireKeyboard(bot, owned.nonce);
    await notice(t(press.kind === 'conv-clear' ? NOTICES.cleared : NOTICES.switched));
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
        '[dsh-im:telegram] could not clear a stale /conv keyboard:',
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

/** Replay `/conv <path>` through the shared command, so behaviour has one home. */
export async function runConvCardCommand(command, harness, conversationKey) {
  return runWorkspaceCommand(command, harness, conversationKey);
}
