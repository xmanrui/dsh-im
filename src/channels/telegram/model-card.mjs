import { t } from '../shared/i18n.mjs';
import {
  ACTION_CARD_STATUS,
  ActionCardRegistry,
  actionCardStateText,
  createCallbackNamespace,
  withActionCardRetry,
  truncateButtonText,
} from '../shared/action-card.mjs';
import {
  COMMAND_PERMISSION_DENIED_MESSAGE,
  evaluateInboundAccess,
} from '../shared/inbound-access.mjs';
import {
  currentReasoningEffortText,
  reasoningEffortText,
  runModelCommand,
} from '../shared/model-command.mjs';

/**
 * Telegram model / reasoning pickers on top of the shared action-card
 * foundation.
 *
 * `/models`, `/model`, `/reasoninglist`, `/reasonings` and `/reasoning` all
 * answer with a text listing today. A carded channel can present the same
 * snapshot as an inline keyboard instead, and every press replays the *typed*
 * command (`/model <provider>/<model>`, `/reasoning <effort>`), so a card and a
 * typed command share one switch implementation, one busy/pending check and one
 * set of error texts. The text path is never replaced: a channel without a
 * keyboard, a refused card send, an unrenderable snapshot (>20 entries) or a
 * failed in-place refresh all fall back to the exact text the command printed
 * before this feature.
 *
 * Safety follows the shared card contract:
 *   - one versioned namespace per picker kind (`m2|` / `r2|`) and a nonce per
 *     presentation, so a stale keyboard cannot act on a newer list;
 *   - a synchronous first-press claim, so a double tap switches once;
 *   - TTL expiry, plus a newer card retiring the previous keyboard;
 *   - callback payloads are `m2|<nonce>|<action>` — a few bytes, never a path,
 *     model id or session id (Telegram rejects >64 bytes).
 *
 * A picker is re-presented with a fresh nonce after every successful press (the
 * message is edited in place), which is what keeps the one-shot claim honest
 * while allowing the same card to switch models again and again.
 */

/** One button row per entry; eight keeps a phone-sized card scannable. */
export const TELEGRAM_MODEL_CARD_PAGE_SIZE = 8;
/**
 * Past this the picker stops being scannable and the text list takes over.
 * Pagination (8 rows/page) keeps real catalogs clickable; 60 is well below the
 * platform's tested button budget and covers a 32-model catalog like the GPD box.
 */
export const TELEGRAM_MODEL_CARD_MAX_ITEMS = 60;
export const TELEGRAM_MODEL_CARD_TTL_MS = 60 * 60 * 1000;
/** Telegram-native cards keep their keyboard for at most this long. */
/** Remembered message ids for keyboards that still need retiring. */
const MAX_CARD_RECORDS = 64;

/** Versioned namespaces: a future payload change can tell old cards apart. */
export const TELEGRAM_MODEL_CALLBACK = createCallbackNamespace('m2');
export const TELEGRAM_REASONING_CALLBACK = createCallbackNamespace('r2');

const EMPTY_KEYBOARD = Object.freeze({ inline_keyboard: [] });
const UNSAFE_DISPLAY_TEXT_GLOBAL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
// A model/effort id must be replayable as a single whitespace-free command
// argument; anything else keeps the (lossless) text path.
const UNSAFE_ARGUMENT = /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const MODEL_SWITCH_FAILED = '模型切换失败，请稍后重试。';

const DEFAULT_STATE_TEXTS = Object.freeze({
  [ACTION_CARD_STATUS.CLAIMED]: '正在切换，请稍候。',
  [ACTION_CARD_STATUS.RESOLVED]: '该操作已处理，无需重复操作。',
  [ACTION_CARD_STATUS.EXPIRED]: '该操作已过期，请重新发送命令。',
  [ACTION_CARD_STATUS.SUPERSEDED]: '该操作已被新操作取代，请使用最新一张卡片。',
  [ACTION_CARD_STATUS.STALE]: '该列表已变化，请重新发送命令。',
  [ACTION_CARD_STATUS.REVOKED]: '该操作已失效，请重新发送命令。',
  [ACTION_CARD_STATUS.UNKNOWN]: '这张卡片已失效或不存在，发送 /models 或 /reasoninglist 可重新打开。',
});

/**
 * A labelled row that is not an action.
 *
 * Bot API 10.3 added `InlineKeyboardButton.disabled` (a `DisabledButton`): the
 * client renders it greyed and never sends a callback. Group headers, page
 * indicators and the already-selected row use it instead of a no-op callback, so
 * a press can no longer "succeed" by answering "already the current model".
 *
 * `selected` adds the ✓ prefix convention; the field itself carries no data.
 */
function labelButton(text) {
  return { text, disabled: {} };
}

function displayText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(UNSAFE_DISPLAY_TEXT_GLOBAL, ' ').replace(/\s+/gu, ' ').trim();
}

function modelAt(catalog, provider, model) {
  return catalog?.groups
    ?.find(({ id }) => id === provider)
    ?.models?.find(({ id }) => id === model) ?? null;
}

function flattenedModels(catalog) {
  const items = [];
  let index = 0;
  for (const group of catalog?.groups ?? []) {
    for (const entry of group.models ?? []) {
      index += 1;
      items.push({
        index,
        provider: group.id,
        model: entry.id,
        groupId: group.id,
        groupName: displayText(group.name) || displayText(group.id),
        label: displayText(entry.name) || displayText(entry.id),
      });
    }
  }
  return items;
}

function currentCatalogId(catalog) {
  const current = catalog?.current;
  if (typeof current?.provider !== 'string' || !current.provider
    || typeof current.model !== 'string' || !current.model) return null;
  return `${current.provider}/${current.model}`;
}

function withCurrent(catalog, selection) {
  if (!selection?.provider || !selection?.model) return catalog;
  return {
    ...catalog,
    current: {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: selection.reasoningEffort }),
    },
  };
}

/**
 * The channel-agnostic half of a model picker: which entries exist, which page
 * is shown, and the body text. `null` means "this snapshot keeps the text
 * path" — empty, unrenderable, or bigger than the card cap.
 */
export function modelCardView(catalog, { page = 0 } = {}) {
  if (!catalog || !Array.isArray(catalog.groups)) return null;
  const items = flattenedModels(catalog);
  if (items.length === 0 || items.length > TELEGRAM_MODEL_CARD_MAX_ITEMS) return null;
  if (items.some((item) => (
    UNSAFE_ARGUMENT.test(item.provider) || UNSAFE_ARGUMENT.test(item.model)
  ))) return null;
  const pages = Math.ceil(items.length / TELEGRAM_MODEL_CARD_PAGE_SIZE);
  const requested = Number.isInteger(page) ? page : 0;
  const currentPage = Math.min(Math.max(requested, 0), pages - 1);
  const currentId = currentCatalogId(catalog);
  const currentMeta = currentId
    ? modelAt(catalog, catalog.current.provider, catalog.current.model)
    : null;
  const lines = [t('选择要使用的模型（共 {count} 个，第 {page}/{pages} 页）', {
    count: items.length,
    page: currentPage + 1,
    pages,
  })];
  if (currentId) lines.push(t('当前模型：{model}', { model: currentId }));
  if (currentMeta?.reasoning) {
    lines.push(t('当前推理等级：{effort}', {
      effort: currentReasoningEffortText(catalog),
    }));
  }
  return {
    kind: 'models',
    page: currentPage,
    pages,
    items,
    pageItems: items.slice(
      currentPage * TELEGRAM_MODEL_CARD_PAGE_SIZE,
      (currentPage + 1) * TELEGRAM_MODEL_CARD_PAGE_SIZE,
    ),
    currentId,
    currentMeta,
    currentEffortText: currentMeta?.reasoning ? currentReasoningEffortText(catalog) : '',
    text: lines.join('\n'),
  };
}

/** Paint one model page. Every button is attributable to this presentation. */
export function renderModelCard(view, nonce) {
  const callback = (action) => TELEGRAM_MODEL_CALLBACK.encode({ nonce, action });
  const rows = [];
  let groupId = null;
  for (const item of view.pageItems) {
    if (item.groupId !== groupId) {
      groupId = item.groupId;
      // A provider header is a label, not an action: Bot API 10.3 gives labels a
      // real representation (disabled), so it stops being a button that lies.
      rows.push([labelButton(truncateButtonText(item.groupName))]);
    }
    const isCurrent = view.currentId === `${item.provider}/${item.model}`;
    // Only the already-selected row is a label; every other row must stay a real
    // button or the picker cannot switch anything.
    rows.push([isCurrent
      ? labelButton(truncateButtonText(`✓ ${item.index}. ${item.label}`), true)
      : {
        text: truncateButtonText(`${item.index}. ${item.label}`),
        callback_data: callback(String(item.index)),
      }]);
  }
  if (view.currentMeta?.reasoning) {
    rows.push([{
      text: truncateButtonText(`⚙️ ${t('推理等级：{effort}', {
        effort: view.currentEffortText,
      })}`),
      callback_data: callback('e'),
    }]);
  }
  if (view.pages > 1) {
    rows.push([
      // The pager edges are only buttons when there is somewhere to go.
      view.page > 0
        ? { text: t('上一页'), callback_data: callback(`p${view.page - 1}`) }
        : labelButton(t('上一页')),
      labelButton(t('第 {page}/{pages} 页', { page: view.page + 1, pages: view.pages })),
      view.page < view.pages - 1
        ? { text: t('下一页'), callback_data: callback(`p${view.page + 1}`) }
        : labelButton(t('下一页')),
    ]);
  }
  return { text: view.text, markup: { inline_keyboard: rows } };
}

/**
 * The reasoning half: the current model's efforts plus the follow-default row.
 * `null` (no reasoning metadata, nothing to show, too many entries) keeps the
 * text path, which already explains the model has no switchable effort.
 */
export function reasoningCardView(catalog) {
  const current = catalog?.current;
  if (!current?.provider || !current?.model) return null;
  const meta = modelAt(catalog, current.provider, current.model);
  if (!meta?.reasoning) return null;
  const efforts = meta.reasoning.efforts;
  if (!Array.isArray(efforts) || efforts.length === 0
    || efforts.length > TELEGRAM_MODEL_CARD_MAX_ITEMS) return null;
  if (efforts.some((effort) => UNSAFE_ARGUMENT.test(effort.id))) return null;
  const effective = current.reasoningEffort ?? meta.reasoning.defaultEffort;
  const items = efforts.map((effort, index) => ({
    index: index + 1,
    id: effort.id,
    label: reasoningEffortText(meta, effort.id),
    current: effort.id === effective,
  }));
  return {
    kind: 'reasoning',
    items,
    modelLabel: `${current.provider}/${current.model}`,
    text: [
      t('选择推理等级（共 {count} 个）', { count: items.length }),
      t('当前模型：{model}', { model: `${current.provider}/${current.model}` }),
      t('当前推理等级：{effort}', { effort: reasoningEffortText(meta, effective) }),
    ].join('\n'),
  };
}

/** Paint the reasoning picker for one presentation nonce. */
export function renderReasoningCard(view, nonce) {
  const callback = (action) => TELEGRAM_REASONING_CALLBACK.encode({ nonce, action });
  const rows = view.items.map((item) => [{
    text: truncateButtonText(`${item.current ? '✓ ' : ''}${item.index}. ${item.label}`),
    callback_data: callback(item.current ? 'c' : String(item.index)),
  }]);
  rows.push([{
    text: truncateButtonText(t('跟随默认（由模型决定）')),
    callback_data: callback('d'),
  }]);
  return { text: view.text, markup: { inline_keyboard: rows } };
}

/** Parse a press produced by either picker; null for every foreign payload. */
export function parseTelegramModelCardCallback(data) {
  const model = TELEGRAM_MODEL_CALLBACK.parse(data);
  if (model) return { kind: 'models', ...model };
  const reasoning = TELEGRAM_REASONING_CALLBACK.parse(data);
  if (reasoning) return { kind: 'reasoning', ...reasoning };
  return null;
}

/**
 * Telegram adapter for the model/reasoning pickers.
 *
 * One instance lives per bridge: it owns the nonce registry and the message ids
 * of the keyboards it still needs to retire. `present` is called by the shared
 * bridge right after a read-only model command; `handlePress` owns the picker
 * namespaces inside `acceptCallback`.
 */
export class TelegramModelCard {
  #registry;
  #records = new Map();
  #logger;
  #notices;

  constructor({
    logger = console,
    registry,
    ttlMs = TELEGRAM_MODEL_CARD_TTL_MS,
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
  async present({
    bot,
    target,
    conversationKey,
    kind,
    modelCatalog,
    reasoningCatalog,
  } = {}) {
    if (!target || typeof conversationKey !== 'string' || !conversationKey) return false;
    if (typeof bot?.sendInteractionCard !== 'function') return false;
    const view = kind === 'reasoning'
      ? reasoningCardView(reasoningCatalog)
      : modelCardView(modelCatalog);
    if (!view) return false;
    const catalog = kind === 'reasoning' ? reasoningCatalog : modelCatalog;
    // One live picker per conversation: the registry retires the previous entry,
    // and its keyboard is dropped once the replacement is actually delivered.
    const previous = this.#registry.activeFor(conversationKey);
    const entry = this.#registry.issue({
      conversationKey,
      kind: view.kind,
      payload: { kind: view.kind, catalog, page: view.page ?? 0 },
    });
    const card = view.kind === 'reasoning'
      ? renderReasoningCard(view, entry.nonce)
      : renderModelCard(view, entry.nonce);
    let sent;
    try {
      sent = await bot.sendInteractionCard(target, card);
    } catch (error) {
      this.#registry.settle(entry.nonce, ACTION_CARD_STATUS.REVOKED);
      this.#logger.warn?.(
        '[dsh-im:telegram] could not deliver a model picker; falling back to the text list:',
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
   */
  async handlePress(callback, {
    bot,
    answer,
    conversationKey,
    harness,
    state,
    signal,
    accessPolicy,
    pendingInteraction,
    control,
  } = {}) {
    const press = parseTelegramModelCardCallback(callback?.data);
    if (!press) return false;
    const notice = (text) => answer?.(text);
    const key = typeof conversationKey === 'string' ? conversationKey : '';
    const callbackKind = callback?.kind === 'group' ? 'group' : 'direct';
    const senderId = typeof callback?.senderId === 'string' ? callback.senderId : '';

    // A card is a command surface: the same command-permission gate that guards
    // the typed command applies to a press, or a keyboard could bypass it.
    const decision = evaluateInboundAccess(accessPolicy, {
      conversationType: callbackKind,
      senderIds: [senderId].filter(Boolean),
      isCommand: true,
    });
    if (!decision.allowed) {
      await notice(t(COMMAND_PERMISSION_DENIED_MESSAGE));
      return true;
    }

    const entry = this.#registry.get(press.nonce);
    const owned = entry && key && entry.conversationKey === key ? entry : null;
    if (!owned || owned.kind !== press.kind) {
      await notice(actionCardStateText(ACTION_CARD_STATUS.UNKNOWN, this.#notices));
      return true;
    }

    // Header, page indicator and the already-selected row are labels: they must
    // never claim the card or execute anything.
    if (press.action === 'h') {
      await notice(undefined);
      return true;
    }
    if (press.action === 'c') {
      await notice(press.kind === 'reasoning'
        ? t('已经是当前推理等级。')
        : t('已经是当前模型。'));
      return true;
    }

    // Synchronous claim, before the first await: whoever gets here first owns the
    // switch; a second tap (or a second client) is told what happened.
    const claimed = this.#registry.claim(press.nonce);
    if (claimed.status !== ACTION_CARD_STATUS.ACTIVE) {
      await this.#refusePress({
        bot,
        notice,
        callback,
        entry: owned,
        key,
        status: claimed.status,
        kind: press.kind,
      });
      return true;
    }

    const context = {
      bot,
      notice,
      callback,
      entry: owned,
      key,
      harness,
      state,
      signal,
      pendingInteraction,
      control,
    };
    return press.kind === 'reasoning'
      ? this.#handleReasoningAction(context, press.action)
      : this.#handleModelAction(context, press.action);
  }

  async #handleModelAction(context, action) {
    const {
      bot, notice, callback, entry, key, harness, state, signal,
      pendingInteraction, control,
    } = context;
    const catalog = entry.payload?.catalog;
    const target = callback?.replyTarget;
    const messageId = callback?.providerMessageId;

    const pageMatch = /^p(\d{1,2})$/u.exec(action);
    if (pageMatch) {
      const view = await this.#renderInPlace({
        bot,
        target,
        messageId,
        conversationKey: key,
        kind: 'models',
        catalog,
        page: Number(pageMatch[1]),
        previousNonce: entry.nonce,
      });
      if (!view) {
        await this.#registry.settle(entry.nonce, ACTION_CARD_STATUS.STALE);
        await notice(t('无法更新选择卡片，请重新发送命令。'));
      } else {
        await notice(undefined);
      }
      return true;
    }

    // The reasoning row opens the reasoning picker for the current model.
    if (action === 'e') {
      const presented = await this.present({
        bot,
        target,
        conversationKey: key,
        kind: 'reasoning',
        reasoningCatalog: catalog,
      });
      if (presented) {
        await notice(t('已打开推理等级选择。'));
        return true;
      }
      await this.#registry.settle(entry.nonce, ACTION_CARD_STATUS.STALE);
      await this.#retireKeyboard(bot, entry.nonce);
      // Never drop the action: the exact text listing still answers it.
      const fallback = await this.#runCardCommand('/reasoninglist', {
        harness, state, key, signal, pendingInteraction, control,
      });
      for (const reply of this.#resultMessages(fallback)) {
        await bot.sendText(target, reply);
      }
      await notice(t('暂时无法打开推理等级列表，请发送 /reasoninglist。'));
      return true;
    }

    const indexMatch = /^(\d{1,3})$/u.exec(action);
    const item = indexMatch ? flattenedModels(catalog)[Number(indexMatch[1]) - 1] : null;
    if (!item || item.index !== Number(indexMatch[1])) {
      await this.#registry.settle(entry.nonce, ACTION_CARD_STATUS.STALE);
      await this.#retireKeyboardAt(bot, target, messageId);
      await notice(t('这个列表已过期，请重新发送 /models。'));
      return true;
    }

    const selection = `${item.provider}/${item.model}`;
    const result = await this.#runCardCommand(`/model ${selection}`, {
      harness, state, key, signal, pendingInteraction, control,
    });
    if (!result?.selection) {
      await this.#failSwitch({
        bot, notice, callback, entry, result, kind: 'models',
      });
      return true;
    }
    // The read-back catalog makes the refreshed card truthful about the new
    // model's reasoning metadata (not the old snapshot's).
    const refreshedCatalog = result.modelCatalog ?? withCurrent(catalog, result.selection);
    const view = await this.#renderInPlace({
      bot,
      target,
      messageId,
      conversationKey: key,
      kind: 'models',
      catalog: refreshedCatalog,
      page: entry.payload?.page ?? 0,
      previousNonce: entry.nonce,
    });
    if (!view) {
      await this.#deliverTextResult(bot, target, result);
      await notice(t('无法更新选择卡片，请重新发送命令。'));
      return true;
    }
    await notice(t('模型已切换为：{model}', { model: selection }));
    return true;
  }

  async #handleReasoningAction(context, action) {
    const {
      bot, notice, callback, entry, key, harness, state, signal,
      pendingInteraction, control,
    } = context;
    const catalog = entry.payload?.catalog;
    const target = callback?.replyTarget;
    const messageId = callback?.providerMessageId;

    let commandText;
    let receipt;
    if (action === 'd') {
      commandText = '/reasoning --default';
      receipt = t('已恢复默认推理等级。');
    } else {
      const indexMatch = /^(\d{1,3})$/u.exec(action);
      const view = reasoningCardView(catalog);
      const item = indexMatch && view ? view.items[Number(indexMatch[1]) - 1] : null;
      if (!item || item.index !== Number(indexMatch[1])) {
        await this.#registry.settle(entry.nonce, ACTION_CARD_STATUS.STALE);
        await this.#retireKeyboardAt(bot, target, messageId);
        await notice(t('这个列表已过期，请重新发送 /reasoninglist。'));
        return true;
      }
      commandText = `/reasoning ${item.id}`;
      receipt = t('推理等级已切换为：{effort}', { effort: item.label });
    }

    const result = await this.#runCardCommand(commandText, {
      harness, state, key, signal, pendingInteraction, control,
    });
    if (!result?.selection) {
      await this.#failSwitch({
        bot, notice, callback, entry, result, kind: 'reasoning',
      });
      return true;
    }
    const refreshedCatalog = result.modelCatalog ?? withCurrent(catalog, result.selection);
    const view = await this.#renderInPlace({
      bot,
      target,
      messageId,
      conversationKey: key,
      kind: 'reasoning',
      catalog: refreshedCatalog,
      previousNonce: entry.nonce,
    });
    if (!view) {
      await this.#deliverTextResult(bot, target, result);
      await notice(t('无法更新选择卡片，请重新发送命令。'));
      return true;
    }
    await notice(receipt);
    return true;
  }

  /** Replay the typed command; every switch check and error text stays shared. */
  async #runCardCommand(text, {
    harness, state, key, signal, pendingInteraction, control,
  }) {
    try {
      return await runModelCommand(text, harness, state, key, {
        ...(signal ? { signal } : {}),
        pendingInteraction: pendingInteraction === true,
        ...(control ? { control } : {}),
      });
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-im:telegram] a model picker switch failed unexpectedly:',
        error?.message ?? error,
      );
      return { message: t(MODEL_SWITCH_FAILED), messages: [t(MODEL_SWITCH_FAILED)] };
    }
  }

  #resultMessages(result) {
    if (Array.isArray(result?.messages) && result.messages.length > 0) return result.messages;
    return typeof result?.message === 'string' && result.message ? [result.message] : [];
  }

  async #deliverTextResult(bot, target, result) {
    for (const reply of this.#resultMessages(result)) {
      await bot.sendText(target, reply);
    }
  }

  /**
   * A switch was refused or failed: retire the dead keyboard and hand the user
   * the exact text the typed command prints, so a card failure is never silent.
   */
  async #failSwitch({ bot, notice, callback, entry, result, kind }) {
    this.#registry.settle(entry.nonce, ACTION_CARD_STATUS.STALE);
    this.#records.delete(entry.nonce);
    await this.#retireKeyboardAt(bot, callback?.replyTarget, callback?.providerMessageId);
    await this.#deliverTextResult(bot, callback?.replyTarget, result);
    await notice(kind === 'reasoning'
      ? t('无法切换推理等级，详情见上方提示。')
      : t('无法切换模型，详情见上方提示。'));
  }

  /**
   * Edit an existing picker into a fresh presentation (new nonce) and keep the
   * message id for later retirement. Failure clears the dead keyboard and
   * returns null so the caller can fall back to text.
   */
  async #renderInPlace({
    bot,
    target,
    messageId,
    conversationKey,
    kind,
    catalog,
    page = 0,
    previousNonce,
  }) {
    const view = kind === 'reasoning'
      ? reasoningCardView(catalog)
      : modelCardView(catalog, { page });
    if (!view) return null;
    const entry = this.#registry.issue({
      conversationKey,
      kind: view.kind,
      payload: { kind: view.kind, catalog, page: view.page ?? 0 },
    });
    const card = view.kind === 'reasoning'
      ? renderReasoningCard(view, entry.nonce)
      : renderModelCard(view, entry.nonce);
    try {
      if (typeof bot?.editInteractionCard !== 'function') {
        throw new TypeError('Telegram client cannot edit an interaction card');
      }
      await withActionCardRetry(() => bot.editInteractionCard(target, messageId, card));
    } catch (error) {
      this.#registry.settle(entry.nonce, ACTION_CARD_STATUS.REVOKED);
      this.#logger.warn?.(
        '[dsh-im:telegram] could not repaint a model picker:',
        error?.message ?? error,
      );
      if (previousNonce) this.#records.delete(previousNonce);
      await this.#retireKeyboardAt(bot, target, messageId);
      return null;
    }
    const previous = previousNonce ? this.#records.get(previousNonce) : null;
    if (previousNonce) this.#records.delete(previousNonce);
    this.#records.set(entry.nonce, {
      messageId: messageId === undefined || messageId === null
        ? (previous?.messageId ?? null)
        : String(messageId),
      target: target ?? previous?.target,
      conversationKey,
    });
    this.#pruneRecords();
    return view;
  }

  async #refusePress({ bot, notice, callback, entry, key, status, kind }) {
    if (status === ACTION_CARD_STATUS.CLAIMED) {
      await notice(actionCardStateText(status, this.#notices));
      return;
    }
    const expiredText = kind === 'reasoning'
      ? t('这个列表已过期，请重新发送 /reasoninglist。')
      : t('这个列表已过期，请重新发送 /models。');
    await notice(status === ACTION_CARD_STATUS.EXPIRED
      ? expiredText
      : actionCardStateText(status, this.#notices));
    // A dead card with no live replacement gets its keyboard removed; a card
    // that was merely re-presented in place must keep the fresh keyboard.
    const active = this.#registry.activeFor(key);
    if (!active) {
      this.#records.delete(entry.nonce);
      await this.#retireKeyboardAt(bot, callback?.replyTarget, callback?.providerMessageId);
    }
  }

  async #retireKeyboard(bot, nonce) {
    const record = this.#records.get(nonce);
    this.#records.delete(nonce);
    if (!record?.messageId) return;
    await this.#retireKeyboardAt(bot, record.target, record.messageId);
  }

  /** Drop a picker's keyboard in place; failures are diagnostics, never user-facing. */
  async #retireKeyboardAt(bot, target, providerMessageId) {
    if (typeof bot?.updateInteractionCard !== 'function') return;
    const messageId = Number(providerMessageId);
    if (!target || !Number.isSafeInteger(messageId)) return;
    try {
      await bot.updateInteractionCard(target, messageId, { markup: EMPTY_KEYBOARD });
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-im:telegram] could not clear a model picker keyboard:',
        error?.message ?? error,
      );
    }
  }

  #pruneRecords() {
    while (this.#records.size > MAX_CARD_RECORDS) {
      const oldest = this.#records.keys().next().value;
      if (oldest === undefined) break;
      this.#records.delete(oldest);
    }
  }
}
