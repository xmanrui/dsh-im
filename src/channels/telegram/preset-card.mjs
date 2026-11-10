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
 * Telegram Agent Preset picker on top of the shared action-card foundation.
 *
 * `/presetlist` renders the bot's preset catalog as an inline keyboard; a press
 * sets that preset through the very same `runPresetCommand('/preset <id>')` path
 * the typed command uses. The card is a view of the same snapshot the text list
 * already prints, so:
 *
 *   - the text list stays the fallback for channels without a keyboard, for a
 *     refused card send, and for catalogs too long to fit a phone screen;
 *   - callbacks carry only `p1|<nonce>|i<index>` / `p1|<nonce>|d`: no Agent
 *     Preset ID can ride in the 64-byte budget (IDs may be long and are not
 *     URL-safe in general);
 *   - one nonce registry entry per presentation gives the first press a
 *     synchronous claim (a double tap switches once), a TTL, and "one live card
 *     per conversation" (a newer list retires the previous keyboard).
 */

/** Telegram rejects callback_data longer than 64 bytes; the shared namespace enforces it. */
export const TELEGRAM_PRESET_CARD_NAMESPACE_PREFIX = 'p1';
export const TELEGRAM_PRESET_CARD_CALLBACK = createCallbackNamespace(
  TELEGRAM_PRESET_CARD_NAMESPACE_PREFIX,
);

/**
 * Above this a keyboard stops being scannable on a phone. The bridge keeps the
 * text list instead — explicit degradation, never a lost listing.
 */
export const TELEGRAM_PRESET_CARD_MAX_ITEMS = 60;
export const TELEGRAM_PRESET_CARD_TTL_MS = 60 * 60 * 1000;
const MAX_CARD_RECORDS = 64;

const EMPTY_KEYBOARD = Object.freeze({ inline_keyboard: [] });
const UNSAFE_DISPLAY_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** The follow-host-default row is a real action, not a catalog entry. */
const FOLLOW_DEFAULT_ACTION = 'd';

const DEFAULT_STATE_TEXTS = Object.freeze({
  [ACTION_CARD_STATUS.CLAIMED]: '正在应用 Agent Preset，请稍候。',
  [ACTION_CARD_STATUS.RESOLVED]: '该 Agent Preset 卡片已处理，无需重复操作。',
  [ACTION_CARD_STATUS.EXPIRED]: '该 Agent Preset 卡片已过期，请重新发送 /presetlist。',
  [ACTION_CARD_STATUS.SUPERSEDED]: '已显示更新的 Agent Preset 列表，请使用最新一条。',
  [ACTION_CARD_STATUS.STALE]: '该 Agent Preset 列表已失效，请重新发送 /presetlist。',
  [ACTION_CARD_STATUS.REVOKED]: '该 Agent Preset 列表已失效，请重新发送 /presetlist。',
  [ACTION_CARD_STATUS.UNKNOWN]: '该 Agent Preset 卡片已失效或不存在，发送 /presetlist 可重新打开。',
});

const NOTICES = Object.freeze({
  alreadyCurrent: '已经是当前 Agent Preset。',
  followDefaultApplied: '已改为跟随 Host 默认。',
  refreshed: '已应用，卡片已更新。',
  updateFailed: '暂时无法应用 Agent Preset，请稍后重试。',
  refreshFailed: '无法更新 Agent Preset 卡片，请重新发送 /presetlist。',
  staleCommand: '暂时无法应用 Agent Preset，请发送 /preset 命令。',
});

function catalogItems(catalog) {
  const items = catalog?.items;
  return Array.isArray(items) ? items : [];
}

/** The preset the bot currently uses, or null when it follows the host default. */
function selectedId(catalog) {
  const value = catalog?.agentPreset;
  return typeof value === 'string' && value ? value : null;
}

/**
 * Build the card body and one row per catalog entry plus the follow-default row.
 *
 * Returns null when the snapshot cannot be rendered as a keyboard (no catalog,
 * empty, too many entries, or an id/label Telegram would choke on): every one of
 * those keeps the caller's text listing, so no information is ever lost.
 */
export function presetCardView(catalog) {
  if (!catalog || typeof catalog !== 'object') return null;
  const items = catalogItems(catalog);
  if (items.length === 0 || items.length > TELEGRAM_PRESET_CARD_MAX_ITEMS) return null;
  for (const item of items) {
    if (typeof item?.id !== 'string' || !item.id) return null;
    if (UNSAFE_DISPLAY_TEXT.test(item.id)) return null;
    if (typeof item.label === 'string' && UNSAFE_DISPLAY_TEXT.test(item.label)) return null;
  }
  const currentId = selectedId(catalog);
  const effectiveId = currentId ?? (typeof catalog.defaultId === 'string' ? catalog.defaultId : null);
  const lines = [t('选择要使用的 Agent Preset（共 {count} 个）', { count: items.length })];
  if (currentId) {
    const current = items.find((item) => item.id === currentId);
    lines.push(t('当前选择：{preset}', {
      preset: current ? `${safeButtonText(current.label) || current.id}（${current.id}）` : currentId,
    }));
  } else {
    lines.push(t('当前选择：跟随 Host 默认'));
  }
  return {
    kind: 'preset',
    items: items.map((item, index) => ({
      index: index + 1,
      id: item.id,
      label: safeButtonText(item.label) || item.id,
      current: item.id === effectiveId,
    })),
    currentId,
    effectiveId,
    text: lines.join('\n'),
  };
}

/** Paint one preset card. Every button is attributable to this presentation. */
export function renderPresetCard(view, nonce) {
  const callback = (action) => TELEGRAM_PRESET_CARD_CALLBACK.encode({ nonce, action });
  const rows = view.items.map((item) => {
    const text = truncateButtonText(`${item.current ? '✓ ' : ''}${item.index}. ${item.label}`);
    // The already-selected row is a label: Bot API 10.3 `disabled` makes it
    // genuinely unpressable instead of a button that answers "already current".
    if (item.current && view.currentId) return [{ text, disabled: {} }];
    return [{ text, callback_data: callback(`i${item.index}`) }];
  });
  rows.push([{
    text: truncateButtonText(t('跟随 Host 默认')),
    callback_data: callback(FOLLOW_DEFAULT_ACTION),
  }]);
  return { text: view.text, markup: { inline_keyboard: rows } };
}

/** Parse a press produced by {@link renderPresetCard}; null for foreign payloads. */
export function parseTelegramPresetCardCallback(data) {
  const parsed = TELEGRAM_PRESET_CARD_CALLBACK.parse(data);
  return parsed ? { ...parsed, kind: 'preset' } : null;
}

/**
 * Telegram adapter for the Agent Preset picker.
 *
 * One instance lives per bridge: it owns the nonce registry and the message ids
 * of the keyboards it still needs to retire. `present` is called by the shared
 * bridge right after a read-only `/presetlist`; `handlePress` owns the `p1|`
 * namespace inside `acceptCallback`.
 */
export class TelegramPresetCard {
  #registry;
  #records = new Map();
  #logger;
  #notices;

  constructor({
    logger = console,
    registry,
    ttlMs = TELEGRAM_PRESET_CARD_TTL_MS,
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
   * Send one picker. Returns false — leaving the caller's text output in charge
   * — when the channel has no keyboard, the snapshot is unrenderable, or the
   * card delivery fails.
   */
  async present({ bot, target, conversationKey, presetCatalog } = {}) {
    if (!target || typeof conversationKey !== 'string' || !conversationKey) return false;
    if (typeof bot?.sendInteractionCard !== 'function') return false;
    const view = presetCardView(presetCatalog);
    if (!view) return false;
    // One live picker per conversation: the registry retires the previous entry,
    // and its keyboard is dropped once the replacement is actually delivered.
    const previous = this.#registry.activeFor(conversationKey);
    const entry = this.#registry.issue({
      conversationKey,
      kind: view.kind,
      payload: { kind: view.kind, catalog: presetCatalog },
    });
    let sent;
    try {
      sent = await bot.sendInteractionCard(target, renderPresetCard(view, entry.nonce));
    } catch (error) {
      this.#registry.settle(entry.nonce, ACTION_CARD_STATUS.REVOKED);
      this.#logger.warn?.(
        '[dsh-im:telegram] could not deliver an Agent Preset picker; '
        + 'falling back to the text list:',
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
   * Handle one inline-keyboard press. Returns false for payloads this picker did
   * not produce, so every other callback path keeps working unchanged.
   *
   * `apply` runs the typed command for one selection: it resolves to the same
   * command result the text path returns (or null when the command did not
   * handle the text), so the card can never invent behavior the command lacks.
   */
  async handlePress(callback, { bot, answer, conversationKey, apply } = {}) {
    const press = parseTelegramPresetCardCallback(callback?.data);
    if (!press) return false;
    const notice = (text) => answer?.(text);
    const key = typeof conversationKey === 'string' ? conversationKey : '';
    const entry = this.#registry.get(press.nonce);
    const owned = entry && key && entry.conversationKey === key ? entry : null;
    if (!owned) {
      await notice(actionCardStateText(ACTION_CARD_STATUS.UNKNOWN, this.#notices));
      return true;
    }

    // A label row must never claim the card or execute anything.
    if (press.action === 'c') {
      await notice(t(NOTICES.alreadyCurrent));
      return true;
    }

    // Synchronous claim, before the first await: whoever gets here first owns the
    // switch; a second tap (or a second client) is told what happened.
    const claimed = this.#registry.claim(press.nonce);
    if (claimed.status !== ACTION_CARD_STATUS.ACTIVE) {
      await notice(actionCardStateText(claimed.status, this.#notices));
      if (claimed.status !== ACTION_CARD_STATUS.CLAIMED) {
        await this.#retireKeyboard(bot, owned.nonce);
      }
      return true;
    }

    const catalog = owned.payload?.catalog;
    let command;
    if (press.action === FOLLOW_DEFAULT_ACTION) {
      command = '/preset --default';
    } else {
      const indexMatch = /^i(\d{1,3})$/u.exec(press.action);
      const index = indexMatch ? Number(indexMatch[1]) : 0;
      const item = presetCardView(catalog)?.items.find((entry) => entry.index === index);
      if (!item) {
        this.#registry.settle(owned.nonce, ACTION_CARD_STATUS.STALE);
        await this.#retireKeyboard(bot, owned.nonce);
        await notice(t(this.#notices[ACTION_CARD_STATUS.STALE]));
        return true;
      }
      // A plain numeric ID would read as a list index; `id:` addresses it exactly.
      command = /^\d+$/u.test(item.id) ? `/preset id:${item.id}` : `/preset ${item.id}`;
    }

    let result;
    try {
      result = typeof apply === 'function' ? await apply(command, key) : null;
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-im:telegram] an Agent Preset card press failed to apply:',
        error?.message ?? error,
      );
      result = null;
    }
    if (!result?.handled) {
      // Never drop the action: tell the user the command is the way to do it.
      this.#registry.settle(owned.nonce, ACTION_CARD_STATUS.STALE);
      await notice(t(NOTICES.staleCommand));
      return true;
    }

    this.#registry.settle(owned.nonce, ACTION_CARD_STATUS.RESOLVED);
    // Repaint from the selection the command reported. The command does not
    // re-read the catalog after an update (one update stays one RPC), so the
    // card derives the new ✓ row and the new "current choice" line itself.
    const applied = presetCardView(this.#withSelection(catalog, result.presetSelection));
    const edited = applied
      ? await this.#editInPlace(bot, owned.nonce, renderPresetCard(applied, owned.nonce))
      : false;
    if (edited) {
      await notice(t(press.action === FOLLOW_DEFAULT_ACTION
        ? NOTICES.followDefaultApplied
        : NOTICES.refreshed));
      return true;
    }
    // The card could not be repainted: still deliver the command's own text, so
    // the outcome is never lost, and drop the now-stale keyboard.
    for (const reply of commandResultMessages(result)) {
      await bot?.sendText?.(callback?.replyTarget, reply);
    }
    await this.#retireKeyboard(bot, owned.nonce);
    await notice(t(press.action === FOLLOW_DEFAULT_ACTION
      ? NOTICES.followDefaultApplied
      : NOTICES.refreshed));
    return true;
  }

  /** Apply an update's reported selection to the snapshot the card was built from. */
  #withSelection(catalog, selection) {
    if (!catalog || !selection || typeof selection !== 'object') return catalog;
    const next = selection.agentPreset;
    return {
      ...catalog,
      agentPreset: typeof next === 'string' && next ? next : null,
    };
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
        '[dsh-im:telegram] could not repaint an Agent Preset card:',
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
        '[dsh-im:telegram] could not clear a stale Agent Preset keyboard:',
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

/** The command result's own text, in the shape every text channel already sends. */
export function commandResultMessages(result) {
  if (Array.isArray(result?.messages) && result.messages.length > 0) return result.messages;
  return typeof result?.message === 'string' && result.message ? [result.message] : [];
}
