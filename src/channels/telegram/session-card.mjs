import { t } from '../shared/i18n.mjs';
import {
  ACTION_CARD_STATUS,
  ActionCardRegistry,
  actionCardStateText,
  createCallbackNamespace,
  withActionCardRetry,
} from '../shared/action-card.mjs';
import { sessionBindErrorMessage } from '../shared/workspace-command.mjs';

/**
 * Telegram session-list picker on top of the shared action-card foundation.
 *
 * `/sessionlist` (and bare `/session`) render the current workspace's sessions
 * as an inline keyboard; a press binds that Session to the chat through the very
 * same `runWorkspaceCommand('/session <id>')` path the typed command uses. The
 * card is a view of the same snapshot the text list already prints, so:
 *
 *   - the text list stays the fallback for channels without a keyboard, for a
 *     refused card send, and for lists too long to fit a phone screen (> 60);
 *   - callbacks carry only `s2|<nonce>|i<index>` / `s2|<nonce>|p<page>`: no
 *     Session ID and no workspace path can ride in the 64-byte budget;
 *   - one nonce registry entry per presentation gives the first press a
 *     synchronous claim (a double tap binds once), a TTL (an old keyboard is
 *     retired, never silently replayed), and "one live card per conversation"
 *     (a newer list retires the previous keyboard).
 */

/** Telegram rejects callback_data longer than 64 bytes; the shared namespace enforces it. */
export const TELEGRAM_SESSION_CARD_NAMESPACE_PREFIX = 's2';
export const TELEGRAM_SESSION_CARD_CALLBACK = createCallbackNamespace(
  TELEGRAM_SESSION_CARD_NAMESPACE_PREFIX,
);

/** Rows per page (the roadmap's 8–10 range; ten UUID rows already fill a phone). */
export const TELEGRAM_SESSION_CARD_PAGE_SIZE = 10;
/**
 * Above this a keyboard stops being scannable on a phone. The bridge keeps the
 * text list instead — explicit degradation, never a lost listing. Ten rows/page
 * keeps real workspaces clickable; 60 stays far below the platform button budget.
 */
export const TELEGRAM_SESSION_CARD_MAX_SESSIONS = 60;
/**
 * How many presentations this card remembers.
 *
 * `issue()` retires the previous card of the same conversation, so at most one
 * entry per conversation is live — this ceiling therefore bounds *conversations*,
 * not presses. 64 concurrent chats is far beyond a single bot's realistic load,
 * and unlike the registry default (256) it keeps the worst case small: each entry
 * holds a full session listing (up to 60 rows), so the default would spend a few
 * MB remembering cards nobody can press any more.
 */
const TELEGRAM_SESSION_CARD_MAX_RECORDS = 64;
/** Inline-keyboard button text is capped by Telegram; keep the label well under it. */
const SESSION_BUTTON_LABEL_MAX_CHARS = 64;
const SESSION_TITLE_MAX_CHARS = 24;

const MAX_SESSION_ID_LENGTH = 256;
const UNSAFE_DISPLAY_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const UNSAFE_DISPLAY_TEXT_GLOBAL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

const EMPTY_KEYBOARD = Object.freeze({ inline_keyboard: [] });

const ACTION_UNAVAILABLE_TEXT = '这个渠道暂时不能从卡片里执行该操作，请直接发送命令。';
const ACTION_FALLBACK_TEXT = '操作没有完成，请稍后重试或直接发送命令。';
const ACTION_DONE_TEXT = '已完成。';

const EXPIRED_LIST_TEXT = '这个会话列表已过期，请重新发送 /sessionlist 或 /session。';
const PAGE_UPDATE_FAILED_TEXT = '暂时无法更新会话列表，请重新发送 /sessionlist。';
const PAGE_ALREADY_TEXT = '已经是第 {page} 页。';
const ALREADY_BOUND_TEXT = '当前聊天已经绑定该会话。';
const BOUND_RECEIPT_TEXT = '已绑定会话：{title}';
const BIND_FALLBACK_TEXT = '暂时无法绑定会话，请稍后重试。';
/** Every session in the workspace is archived: say so instead of listing them. */
const NO_BINDABLE_SESSIONS_TEXT = '当前工作区没有可绑定的会话（已归档的会话不显示）。';

/**
 * Per-state notices; the wording names this card instead of the shared generic
 * action wording, so a pressed dead keyboard reads as "session list expired".
 */
const DEFAULT_STATE_TEXT_OVERRIDES = Object.freeze({
  [ACTION_CARD_STATUS.CLAIMED]: '正在绑定会话，请稍候。',
  [ACTION_CARD_STATUS.RESOLVED]: '这个会话列表已处理，请重新发送 /sessionlist。',
  [ACTION_CARD_STATUS.EXPIRED]: EXPIRED_LIST_TEXT,
  [ACTION_CARD_STATUS.SUPERSEDED]: '这个会话列表已被更新的列表取代，请使用最新一条。',
  [ACTION_CARD_STATUS.STALE]: '这个会话列表已失效，请重新发送 /sessionlist。',
  [ACTION_CARD_STATUS.REVOKED]: '这个会话列表已失效，请重新发送 /sessionlist。',
  [ACTION_CARD_STATUS.UNKNOWN]: EXPIRED_LIST_TEXT,
});

const TERMINAL_STATUSES = new Set([
  ACTION_CARD_STATUS.RESOLVED,
  ACTION_CARD_STATUS.EXPIRED,
  ACTION_CARD_STATUS.SUPERSEDED,
  ACTION_CARD_STATUS.STALE,
  ACTION_CARD_STATUS.REVOKED,
]);

function safeDisplayText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(UNSAFE_DISPLAY_TEXT_GLOBAL, ' ').replace(/\s+/gu, ' ').trim();
}

function validSessionId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_SESSION_ID_LENGTH
    && !/\p{White_Space}/u.test(value)
    && !UNSAFE_DISPLAY_TEXT.test(value);
}

/** First eight characters: enough to tell neighboring rows apart, short enough for a button. */
export function telegramSessionShortId(sessionId) {
  const value = typeof sessionId === 'string' ? sessionId : '';
  return Array.from(value).slice(0, 8).join('');
}

function truncateText(value, limit) {
  const characters = Array.from(value);
  return characters.length > limit ? `${characters.slice(0, limit).join('')}…` : value;
}

/** The visible label: `[✓] title · shortId[（已归档）]`, capped to Telegram's button budget. */
export function telegramSessionButtonText(session, { current = false } = {}) {
  const title = session?.summaryAvailable === false
    ? t('标题暂不可用')
    : safeDisplayText(session?.title) || t('暂无标题');
  const label = `${current ? '✓ ' : ''}${truncateText(title, SESSION_TITLE_MAX_CHARS)}`
    + ` · ${telegramSessionShortId(session?.sessionId)}`
    + `${session?.archived === true ? t('（已归档）') : ''}`;
  return truncateText(label, SESSION_BUTTON_LABEL_MAX_CHARS);
}

/** Encode one bind button. The index is page-global (0..19), never the Session ID. */
export function telegramSessionBindCallbackData(nonce, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index > 99) {
    throw new TypeError('A session card index must be an integer between 0 and 99');
  }
  return TELEGRAM_SESSION_CARD_CALLBACK.encode({ nonce, action: `i${index}` });
}

/**
 * Encode one row of the action strip.
 *
 * `u` releases the binding (the same `clearSession` `/new` performs) and `n`
 * opens a fresh session through the same path `/new` takes. Neither carries an
 * id: both act on this conversation, which is the only thing a card owns.
 */
export function telegramSessionActionCallbackData(nonce, action) {
  if (action !== 'unbind' && action !== 'new') {
    throw new TypeError('A session card action must be unbind or new');
  }
  return TELEGRAM_SESSION_CARD_CALLBACK.encode({
    nonce,
    action: action === 'unbind' ? 'u' : 'n',
  });
}

/** Encode one pager button (`p<page>`); the page is clamped again on press. */
export function telegramSessionPageCallbackData(nonce, page) {
  if (!Number.isSafeInteger(page) || page < 0 || page > 99) {
    throw new TypeError('A session card page must be an integer between 0 and 99');
  }
  return TELEGRAM_SESSION_CARD_CALLBACK.encode({ nonce, action: `p${page}` });
}

/** Parse a press from this card; null for any other callback namespace. */
export function parseTelegramSessionCallback(data) {
  const parsed = TELEGRAM_SESSION_CARD_CALLBACK.parse(data);
  if (!parsed) return null;
  const bind = /^i(\d{1,3})$/u.exec(parsed.action);
  if (bind) return { nonce: parsed.nonce, kind: 'bind', index: Number(bind[1]) };
  const page = /^p(\d{1,3})$/u.exec(parsed.action);
  if (page) return { nonce: parsed.nonce, kind: 'page', page: Number(page[1]) };
  if (parsed.action === 'u') return { nonce: parsed.nonce, kind: 'unbind' };
  if (parsed.action === 'n') return { nonce: parsed.nonce, kind: 'new' };
  return null;
}

/**
 * Keep only the fields the card needs and validate them once. A malformed
 * listing returns null, which makes the caller keep the byte-identical text
 * path instead of rendering half a keyboard.
 */
function sessionSnapshot(listing) {
  if (!listing || typeof listing !== 'object') return null;
  const workspace = typeof listing.workspace === 'string' ? listing.workspace.trim() : '';
  if (!workspace) return null;
  if (!Array.isArray(listing.sessions)) return null;
  const sessions = [];
  let archivedCount = 0;
  for (const session of listing.sessions) {
    if (!validSessionId(session?.sessionId)) return null;
    // Archived sessions never render as bind buttons; the text path still shows
    // them with the 「已归档」 marker when a card is impossible or refused.
    if (session?.archived === true) {
      archivedCount += 1;
      continue;
    }
    sessions.push({
      sessionId: session.sessionId,
      title: safeDisplayText(session?.title),
      archived: false,
      summaryAvailable: session?.summaryAvailable !== false,
    });
  }
  // The shared snapshot already withholds archived rows and reports how many it
  // hid; add any archived rows a caller passed raw (defensive, same contract).
  const hiddenArchived = Number.isSafeInteger(listing.archivedCount) && listing.archivedCount > 0
    ? listing.archivedCount
    : 0;
  return { workspace, sessions, archivedCount: archivedCount + hiddenArchived };
}

/**
 * Render one page of the session list. Returns null when a card cannot carry
 * the listing (empty, above the row ceiling, or an unusable nonce), leaving the
 * caller free to send the text list it already has.
 */
export function telegramSessionCardRender(listing, {
  nonce,
  page = 0,
  currentSessionId = null,
} = {}) {
  if (typeof nonce !== 'string' || !nonce) return null;
  const snapshot = sessionSnapshot(listing);
  if (!snapshot) return null;
  const total = snapshot.sessions.length;
  if (total === 0 || total > TELEGRAM_SESSION_CARD_MAX_SESSIONS) return null;
  const pageCount = Math.max(1, Math.ceil(total / TELEGRAM_SESSION_CARD_PAGE_SIZE));
  const safePage = Number.isSafeInteger(page) && page >= 0 && page < pageCount ? page : 0;
  const current = typeof currentSessionId === 'string' && currentSessionId
    ? currentSessionId
    : null;
  const start = safePage * TELEGRAM_SESSION_CARD_PAGE_SIZE;
  const rows = snapshot.sessions
    .slice(start, start + TELEGRAM_SESSION_CARD_PAGE_SIZE)
    .map((session, offset) => {
      const index = start + offset;
      return [{
        text: telegramSessionButtonText(session, { current: session.sessionId === current }),
        callback_data: telegramSessionBindCallbackData(nonce, index),
      }];
    });
  if (pageCount > 1) {
    const pager = [];
    if (safePage > 0) {
      pager.push({
        text: t('◀ 上一页'),
        callback_data: telegramSessionPageCallbackData(nonce, safePage - 1),
      });
    }
    // The page indicator is a label, not an action: Bot API 10.3 `disabled`
    // keeps the layout stable without a button that only says "already here".
    pager.push({
      text: t('第 {page}/{pageCount} 页', { page: safePage + 1, pageCount }),
      disabled: {},
    });
    if (safePage + 1 < pageCount) {
      pager.push({
        text: t('下一页 ▶'),
        callback_data: telegramSessionPageCallbackData(nonce, safePage + 1),
      });
    }
    rows.push(pager);
  }
  // Actions strip: only offer 解绑 when something is actually bound, so the row
  // never advertises an operation that would do nothing. 新会话 is always useful
  // (it starts a fresh session in this workspace).
  const actions = [];
  if (current) {
    actions.push({
      text: t('🔓 解绑当前会话'),
      callback_data: telegramSessionActionCallbackData(nonce, 'unbind'),
    });
  }
  actions.push({
    text: t('🆕 新会话'),
    callback_data: telegramSessionActionCallbackData(nonce, 'new'),
  });
  rows.push(actions);
  const header = [
    t('工作区：{workspace}', { workspace: snapshot.workspace }),
    [
      t('会话（{count}）：', { count: total }),
      pageCount > 1
        ? t('第 {page}/{pageCount} 页', { page: safePage + 1, pageCount })
        : '',
    ].filter(Boolean).join(' '),
    t('点击按钮把会话绑定到当前聊天。'),
  ];
  return {
    text: header.join('\n'),
    markup: { inline_keyboard: rows },
  };
}

/**
 * Telegram adapter for `/sessionlist` and bare `/session`, mirroring
 * `TelegramApprovalCard`: it owns the nonce registry and every card's full
 * lifecycle (present → press → claim → bind → in-place re-mark → retire).
 */
export class TelegramSessionCard {
  #registry;
  #logger;
  #notices;

  constructor({
    logger = console,
    registry,
    stateTexts = {},
    ttlMs = 60 * 60_000,
  } = {}) {
    this.#registry = registry instanceof ActionCardRegistry
      ? registry
      : new ActionCardRegistry({ ttlMs, maxEntries: TELEGRAM_SESSION_CARD_MAX_RECORDS });
    this.#logger = logger;
    this.#notices = {
      ...DEFAULT_STATE_TEXT_OVERRIDES,
      ...stateTexts,
    };
  }

  get registry() {
    return this.#registry;
  }

  /** Parse a press from this card; kept on the adapter so the bridge can route. */
  parse(data) {
    return parseTelegramSessionCallback(data);
  }

  /**
   * Register one presentation and send it. Returns false (no throw) whenever the
   * card cannot be delivered, so the bridge sends the text list it already has.
   */
  async present({
    target,
    conversationKey,
    listing,
    currentSessionId = null,
    bot,
  } = {}) {
    if (!bot || typeof bot.sendInteractionCard !== 'function') return false;
    if (typeof conversationKey !== 'string' || !conversationKey) return false;
    const snapshot = sessionSnapshot(listing);
    if (!snapshot) return false;
    if (snapshot.sessions.length === 0) {
      // No bindable rows. When the workspace truly has no sessions the caller's
      // legacy empty-list text stays authoritative (return false). When rows were
      // hidden because they are all archived, answer directly so the fallback text
      // never exposes the archived entries the picker is supposed to hide.
      if (snapshot.archivedCount === 0) return false;
      if (typeof bot.sendText === 'function') {
        await bot.sendText(target, t(NO_BINDABLE_SESSIONS_TEXT));
        return true;
      }
      return false;
    }
    const current = typeof currentSessionId === 'string' && currentSessionId
      ? currentSessionId
      : null;
    // Capture the live entry before issuing: issue() retires it, and its message
    // id is what the keyboard cleanup edits.
    const previous = this.#registry.activeFor(conversationKey);
    const entry = this.#registry.issue({
      conversationKey,
      kind: 'session-bind',
      payload: {
        listing: snapshot,
        page: 0,
        currentSessionId: current,
        target: target ?? null,
        messageId: null,
      },
    });
    const card = telegramSessionCardRender(snapshot, {
      nonce: entry.nonce,
      page: 0,
      currentSessionId: current,
    });
    if (!card) {
      this.#registry.settle(entry.nonce, ACTION_CARD_STATUS.REVOKED);
      return false;
    }
    try {
      const sent = await bot.sendInteractionCard(target, card);
      const ids = Array.isArray(sent?.providerMessageIds) ? sent.providerMessageIds : [];
      entry.payload.messageId = ids.length > 0 ? String(ids.at(-1)) : null;
      if (previous && previous.nonce !== entry.nonce && previous.payload?.messageId) {
        await this.#retireKeyboard(
          bot,
          previous.payload.target ?? target,
          previous.payload.messageId,
        );
      }
      return true;
    } catch (error) {
      this.#registry.settle(entry.nonce, ACTION_CARD_STATUS.REVOKED);
      this.#logger.warn?.(
        '[dsh-im:telegram] could not deliver a session card; falling back to the text list:',
        error?.message ?? error,
      );
      return false;
    }
  }

  /**
   * Handle one press. Returns false for payloads this card did not produce so
   * the bridge keeps routing other namespaces (question/approval/workspace).
   */
  async handlePress(callback, {
    key,
    bot,
    answer,
    currentSessionId,
    bind,
    release,
    startNew,
  } = {}) {
    const parsed = parseTelegramSessionCallback(callback?.data);
    if (!parsed) return false;
    const conversationKey = typeof key === 'string' ? key : '';
    const entry = this.#registry.get(parsed.nonce);
    const target = callback?.replyTarget ?? entry?.payload?.target ?? null;
    const messageId = entry?.payload?.messageId
      ?? (Number.isSafeInteger(callback?.providerMessageId)
        ? String(callback.providerMessageId)
        : null);
    const expiredText = t(EXPIRED_LIST_TEXT);

    if (!entry || !conversationKey || entry.conversationKey !== conversationKey) {
      // A card from another conversation (or a purged nonce) cannot bind.
      await this.#answerSafely(answer, expiredText);
      return true;
    }
    if (entry.status !== ACTION_CARD_STATUS.ACTIVE) {
      await this.#answerSafely(answer, actionCardStateText(entry.status, this.#notices));
      if (TERMINAL_STATUSES.has(entry.status)) {
        await this.#retireKeyboard(bot, target, messageId);
      }
      return true;
    }

    if (parsed.kind === 'page') {
      return this.#handlePagePress(callback, entry, parsed, {
        conversationKey, bot, answer, target, messageId,
      });
    }
    // The action strip acts on this conversation, not on a listed row, so it
    // bypasses the bind path entirely (no index, no listing lookup).
    if (parsed.kind === 'unbind' || parsed.kind === 'new') {
      return this.#handleActionPress(entry, parsed, {
        conversationKey, bot, answer, target, messageId, release, startNew,
      });
    }
    return this.#handleBindPress(callback, entry, parsed, {
      conversationKey, bot, answer, currentSessionId, bind, target, messageId,
    });
  }

  /**
   * Handle 解绑 / 新会话.
   *
   * Both act on this conversation only: releasing drops the binding through the
   * same `clearSession` that `/new` uses, and 新会话 takes the same path as the
   * typed command. The card is retired afterwards because its ✓ marker (and the
   * 解绑 row) describe a binding that no longer exists.
   */
  async #handleActionPress(entry, parsed, {
    conversationKey, bot, answer, target, messageId, release, startNew,
  }) {
    const handler = parsed.kind === 'unbind' ? release : startNew;
    if (typeof handler !== 'function') {
      await this.#answerSafely(answer, t(ACTION_UNAVAILABLE_TEXT));
      return true;
    }
    const claimed = this.#registry.claim(parsed.nonce);
    if (claimed.status !== ACTION_CARD_STATUS.ACTIVE) {
      await this.#answerSafely(answer, actionCardStateText(claimed.status, this.#notices));
      return true;
    }
    let outcome;
    try {
      outcome = await handler({ conversationKey });
    } catch (error) {
      // A failed release/restart must not leave the card claiming it happened.
      // `ACTIVE` is not a terminal status, so settle() would throw and the error
      // would escape into the outer handler (which reports a bogus "list
      // expired"); releasing the claim is what actually makes the card usable.
      this.#registry.releaseClaim(parsed.nonce);
      await this.#answerSafely(answer, t(ACTION_FALLBACK_TEXT));
      return true;
    }
    this.#registry.settle(parsed.nonce, ACTION_CARD_STATUS.RESOLVED);
    if (outcome?.text) {
      const edited = await this.#editCardText(bot, target, messageId, outcome.text);
      if (!edited && typeof bot?.sendText === 'function') {
        await bot.sendText(target, outcome.text);
      }
    }
    await this.#retireKeyboard(bot, target, messageId);
    await this.#answerSafely(answer, outcome?.notice ?? t(ACTION_DONE_TEXT));
    return true;
  }

  /** Replace the card body with a plain receipt (no keyboard). */
  async #editCardText(bot, target, messageId, text) {
    if (!target || messageId === null || typeof bot?.editInteractionCard !== 'function') return false;
    try {
      await bot.editInteractionCard(target, messageId, {
        text,
        markup: EMPTY_KEYBOARD,
      });
      return true;
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-im:telegram] could not rewrite a session card as a receipt:',
        error?.message ?? error,
      );
      return false;
    }
  }

  async #handlePagePress(callback, entry, parsed, {
    conversationKey, bot, answer, target, messageId,
  }) {
    const total = entry.payload?.listing?.sessions?.length ?? 0;
    const pageCount = Math.max(1, Math.ceil(total / TELEGRAM_SESSION_CARD_PAGE_SIZE));
    const wanted = Math.min(Math.max(parsed.page, 0), pageCount - 1);
    if (wanted === entry.payload.page) {
      await this.#answerSafely(answer, t(PAGE_ALREADY_TEXT, { page: wanted + 1 }));
      return true;
    }
    const claimed = this.#registry.claim(parsed.nonce);
    if (claimed.status !== ACTION_CARD_STATUS.ACTIVE) {
      await this.#answerSafely(answer, actionCardStateText(claimed.status, this.#notices));
      return true;
    }
    const next = this.#issue(conversationKey, entry.payload.listing, {
      page: wanted,
      currentSessionId: entry.payload.currentSessionId,
      target,
      messageId,
    });
    const card = telegramSessionCardRender(entry.payload.listing, {
      nonce: next.nonce,
      page: wanted,
      currentSessionId: entry.payload.currentSessionId,
    });
    try {
      if (!card || !target || messageId === null
        || typeof bot?.editInteractionCard !== 'function') {
        throw new Error('the channel cannot edit a session card');
      }
      await withActionCardRetry(() => bot.editInteractionCard(target, messageId, {
        text: card.text,
        markup: card.markup,
      }));
      await this.#answerSafely(answer);
    } catch (error) {
      // The pressed nonce is already consumed: retire the keyboard so a dead
      // card cannot keep answering, and send the user back to the command.
      this.#registry.settle(next.nonce, ACTION_CARD_STATUS.STALE);
      await this.#retireKeyboard(bot, target, messageId);
      this.#logger.warn?.(
        '[dsh-im:telegram] could not page a session card:',
        error?.message ?? error,
      );
      await this.#answerSafely(answer, t(PAGE_UPDATE_FAILED_TEXT));
    }
    return true;
  }

  async #handleBindPress(callback, entry, parsed, {
    conversationKey, bot, answer, currentSessionId, bind, target, messageId,
  }) {
    const session = entry.payload?.listing?.sessions?.[parsed.index];
    if (!session) {
      await this.#answerSafely(answer, t(EXPIRED_LIST_TEXT));
      return true;
    }
    // Idempotency follows the live binding, not the snapshot: a typed /session or
    // another card may have bound this chat since this one was sent. The check is
    // synchronous and happens before the claim, so a no-op does not consume it.
    const current = typeof currentSessionId === 'function' ? currentSessionId() : null;
    if (typeof current === 'string' && current === session.sessionId) {
      await this.#answerSafely(answer, t(ALREADY_BOUND_TEXT));
      return true;
    }
    // Synchronous claim before the first await: a second tap (or a second
    // client) sees CLAIMED and is told so instead of binding again.
    const claimed = this.#registry.claim(parsed.nonce);
    if (claimed.status !== ACTION_CARD_STATUS.ACTIVE) {
      await this.#answerSafely(answer, actionCardStateText(claimed.status, this.#notices));
      return true;
    }

    let result = null;
    let thrown = null;
    if (typeof bind !== 'function') {
      this.#registry.settle(parsed.nonce, ACTION_CARD_STATUS.STALE);
      await this.#retireKeyboard(bot, target, messageId);
      await this.#answerSafely(answer, t(BIND_FALLBACK_TEXT));
      return true;
    }
    try {
      result = await bind(session.sessionId);
    } catch (error) {
      thrown = error;
    }
    if (!result || !result.bound) {
      // One failure mapping for both entry points: reuse the typed command's
      // wording instead of inventing a second vocabulary for card presses.
      const failureText = thrown
        ? sessionBindErrorMessage(thrown)
        : (typeof result?.message === 'string' && result.message
          ? result.message
          : t(BIND_FALLBACK_TEXT));
      this.#registry.settle(parsed.nonce, ACTION_CARD_STATUS.STALE);
      await this.#retireKeyboard(bot, target, messageId);
      // A toast disappears; the explicit text keeps the reason in the chat.
      await this.#sendTextSafely(bot, target, failureText);
      await this.#answerSafely(answer, failureText);
      return true;
    }

    const bound = result.bound;
    const boundSessionId = typeof bound.sessionId === 'string' && bound.sessionId
      ? bound.sessionId
      : session.sessionId;
    const title = safeDisplayText(bound.title) || t('暂无标题');
    const receipt = t(BOUND_RECEIPT_TEXT, { title });
    // The refreshed list is a new presentation: later presses (another row, or a
    // page) work without re-sending the command, while the old nonce is spent.
    const next = this.#issue(conversationKey, entry.payload.listing, {
      page: entry.payload.page,
      currentSessionId: boundSessionId,
      target,
      messageId,
    });
    this.#registry.settle(parsed.nonce, ACTION_CARD_STATUS.RESOLVED);
    const card = telegramSessionCardRender(entry.payload.listing, {
      nonce: next.nonce,
      page: entry.payload.page,
      currentSessionId: boundSessionId,
    });
    let remarked = false;
    try {
      if (!card || !target || messageId === null
        || typeof bot?.updateInteractionCard !== 'function') {
        throw new Error('the channel cannot update a session card');
      }
      await bot.updateInteractionCard(target, messageId, { markup: card.markup });
      remarked = true;
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-im:telegram] could not move the session card marker:',
        error?.message ?? error,
      );
      this.#registry.settle(next.nonce, ACTION_CARD_STATUS.STALE);
      await this.#retireKeyboard(bot, target, messageId);
    }
    if (!remarked) await this.#sendTextSafely(bot, target, receipt);
    await this.#answerSafely(answer, receipt);
    return true;
  }

  #issue(conversationKey, listing, {
    page = 0,
    currentSessionId = null,
    target = null,
    messageId = null,
  } = {}) {
    return this.#registry.issue({
      conversationKey,
      kind: 'session-bind',
      payload: {
        listing,
        page,
        currentSessionId: typeof currentSessionId === 'string' && currentSessionId
          ? currentSessionId
          : null,
        target,
        messageId: messageId === null || messageId === undefined ? null : String(messageId),
      },
    });
  }

  async #retireKeyboard(bot, target, messageId) {
    if (!target || messageId === null || messageId === undefined) return;
    if (typeof bot?.updateInteractionCard !== 'function') return;
    try {
      await bot.updateInteractionCard(target, String(messageId), { markup: EMPTY_KEYBOARD });
    } catch (error) {
      // "message is not modified" and "message not found" are both end states.
      this.#logger.warn?.(
        '[dsh-im:telegram] could not retire a session card keyboard:',
        error?.message ?? error,
      );
    }
  }

  async #sendTextSafely(bot, target, text) {
    if (!target || typeof bot?.sendText !== 'function' || typeof text !== 'string' || !text) return;
    try {
      await bot.sendText(target, text);
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-im:telegram] could not send a session binding explanation:',
        error?.message ?? error,
      );
    }
  }

  async #answerSafely(answer, text) {
    if (typeof answer !== 'function') return;
    try {
      await answer(text);
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-im:telegram] could not acknowledge a session card press:',
        error?.message ?? error,
      );
    }
  }
}
