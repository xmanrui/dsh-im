import { randomBytes } from 'node:crypto';

import { t } from './i18n.mjs';

/**
 * Shared foundation for interactive cards that carry a one-shot button press.
 *
 * Every carded channel needs the same four things, and four independent
 * implementations already existed (Feishu card keys, QQ opaque tokens, DingTalk
 * revisions, Telegram question nonces). This module provides them once:
 *
 * - a versioned, bounded callback namespace (`<prefix>|<nonce>|<action>`) so a
 *   keyboard press is attributable to exactly one presentation;
 * - a nonce registry with TTL and capacity limits, so a dead card cannot grow
 *   memory forever;
 * - a synchronous first-press claim, so two taps (or two clients) execute once;
 * - one set of Chinese notices for pressed/expired/superseded cards.
 *
 * Cards that also need to re-check live data (a list shrank, a session was
 * deleted) should `claim()` first and then `settle(nonce, 'stale')` when the
 * re-check fails.
 */

/** Telegram rejects callback_data longer than 64 bytes. */
export const ACTION_CARD_CALLBACK_MAX_BYTES = 64;

const CALLBACK_PREFIX_PATTERN = /^[a-z][a-z0-9]{0,7}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u;
const ACTION_PATTERN = /^[A-Za-z0-9_-]{1,16}$/u;
const DEFAULT_NONCE_BYTES = 9;

export const ACTION_CARD_STATUS = Object.freeze({
  /** Rendered, waiting for its first press. */
  ACTIVE: 'active',
  /** Pressed; the handler owns the outcome now. */
  CLAIMED: 'claimed',
  /** Handled successfully. */
  RESOLVED: 'resolved',
  /** TTL elapsed (approval timeout, dead keyboard). */
  EXPIRED: 'expired',
  /** A newer card replaced this one in the same conversation. */
  SUPERSEDED: 'superseded',
  /** The live re-check after a press found the underlying state changed. */
  STALE: 'stale',
  /** The owner revoked the card (route closed, approval withdrawn). */
  REVOKED: 'revoked',
  /** No such nonce (process restarted, foreign payload). */
  UNKNOWN: 'unknown',
});

const LIVE_STATUSES = new Set([ACTION_CARD_STATUS.ACTIVE, ACTION_CARD_STATUS.CLAIMED]);
const TERMINAL_STATUSES = new Set([
  ACTION_CARD_STATUS.RESOLVED,
  ACTION_CARD_STATUS.EXPIRED,
  ACTION_CARD_STATUS.SUPERSEDED,
  ACTION_CARD_STATUS.STALE,
  ACTION_CARD_STATUS.REVOKED,
]);

/** One notice per card state; channels override the wording per surface. */
export const ACTION_CARD_STATE_TEXTS = Object.freeze({
  [ACTION_CARD_STATUS.ACTIVE]: '正在处理，请稍候。',
  [ACTION_CARD_STATUS.CLAIMED]: '正在提交，请稍候。',
  [ACTION_CARD_STATUS.RESOLVED]: '该操作已处理，无需重复操作。',
  [ACTION_CARD_STATUS.EXPIRED]: '该操作已过期，请重新打开。',
  [ACTION_CARD_STATUS.SUPERSEDED]: '该操作已被新操作取代，请使用最新一条。',
  [ACTION_CARD_STATUS.STALE]: '该内容已变化，请重新打开后再操作。',
  [ACTION_CARD_STATUS.REVOKED]: '该操作已失效，请重新打开。',
  [ACTION_CARD_STATUS.UNKNOWN]: '该操作已失效或不存在。',
});

/**
 * A random, URL-safe presentation identity.
 * 9 bytes → 12 base64url characters: collision-safe per conversation and small
 * enough that the whole callback payload stays far under 64 bytes.
 */
export function createActionNonce(byteLength = DEFAULT_NONCE_BYTES) {
  if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > 24) {
    throw new TypeError('An action card nonce needs 1..24 random bytes');
  }
  return randomBytes(byteLength).toString('base64url');
}

/**
 * Build one versioned callback namespace, e.g. `ap1|<nonce>|<action>`.
 * Encoding validates every token before emitting it, so a button can always be
 * attributed and can never exceed Telegram's callback budget.
 */
export function createCallbackNamespace(prefix) {
  if (typeof prefix !== 'string' || !CALLBACK_PREFIX_PATTERN.test(prefix)) {
    throw new TypeError('An action card callback prefix is invalid');
  }
  const maxBytes = ACTION_CARD_CALLBACK_MAX_BYTES;
  return Object.freeze({
    prefix,
    maxBytes,
    encode({ nonce, action } = {}) {
      if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) {
        throw new TypeError('An action card nonce is invalid');
      }
      if (typeof action !== 'string' || !ACTION_PATTERN.test(action)) {
        throw new TypeError('An action card action is invalid');
      }
      const data = `${prefix}|${nonce}|${action}`;
      if (Buffer.byteLength(data, 'utf8') > maxBytes) {
        throw new TypeError(`An action card callback must be at most ${maxBytes} bytes`);
      }
      return data;
    },
    parse(data) {
      if (typeof data !== 'string') return null;
      const parts = data.split('|');
      if (parts.length !== 3 || parts[0] !== prefix) return null;
      const [, nonce, action] = parts;
      if (!NONCE_PATTERN.test(nonce) || !ACTION_PATTERN.test(action)) return null;
      return { nonce, action };
    },
  });
}

/** The notice shown for a dead or already-handled card. */
export function actionCardStateText(status, texts = {}) {
  const override = texts && typeof texts === 'object' ? texts[status] : undefined;
  const fallback = ACTION_CARD_STATE_TEXTS[status]
    ?? (texts && typeof texts === 'object' ? texts[ACTION_CARD_STATUS.UNKNOWN] : undefined)
    ?? ACTION_CARD_STATE_TEXTS[ACTION_CARD_STATUS.UNKNOWN];
  return t(typeof override === 'string' && override ? override : fallback);
}

/**
 * In-memory presentation registry for one channel.
 *
 * Entries live for `ttlMs`; a terminal entry is kept until then so a late press
 * still gets "已处理/已过期" instead of a generic "不存在". At most
 * `maxEntries` cards are remembered (oldest is evicted first) and a new card in
 * a conversation supersedes the previous live one.
 */
export class ActionCardRegistry {
  #ttlMs;
  #maxEntries;
  #now;
  #createNonce;
  #entries = new Map();

  constructor({
    ttlMs = 3_600_000,
    maxEntries = 256,
    now = Date.now,
    createNonce = createActionNonce,
  } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new TypeError('An action card TTL must be a positive number');
    }
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError('An action card capacity must be a positive integer');
    }
    if (typeof now !== 'function') throw new TypeError('An action card clock must be a function');
    if (typeof createNonce !== 'function') {
      throw new TypeError('An action card nonce factory must be a function');
    }
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
    this.#now = now;
    this.#createNonce = createNonce;
  }

  get size() {
    return this.#entries.size;
  }

  /**
   * Register one presentation. Issuing a new card in the same conversation
   * retires the previous live one — one conversation shows one working card.
   */
  issue({ conversationKey, kind = '', payload = {}, ttlMs } = {}) {
    const key = typeof conversationKey === 'string' ? conversationKey.trim() : '';
    if (!key) throw new TypeError('An action card requires a conversation key');
    const now = this.#now();
    const lifetime = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : this.#ttlMs;
    // Drop long-dead cards so TTL memory is reclaimed even when presses stop.
    this.purge();
    this.revokeConversation(key, { status: ACTION_CARD_STATUS.SUPERSEDED });

    let nonce = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.#createNonce();
      if (typeof candidate !== 'string' || !NONCE_PATTERN.test(candidate)) {
        throw new TypeError('An action card nonce must be 1..32 URL-safe characters');
      }
      if (!this.#entries.has(candidate)) {
        nonce = candidate;
        break;
      }
    }
    if (nonce === null) throw new Error('Could not allocate a unique action card nonce');

    const entry = {
      nonce,
      conversationKey: key,
      kind: typeof kind === 'string' ? kind : '',
      payload: payload && typeof payload === 'object' ? payload : {},
      status: ACTION_CARD_STATUS.ACTIVE,
      createdAt: now,
      expiresAt: now + lifetime,
      claimedAt: null,
      settledAt: null,
    };
    this.#entries.set(nonce, entry);
    this.#enforceCapacity();
    return entry;
  }

  /** Read an entry (and lazily mark it expired when its TTL elapsed). */
  get(nonce) {
    const entry = this.#lookup(nonce);
    if (!entry) return null;
    this.#expireIfNeeded(entry);
    return entry;
  }

  /**
   * Claim the first press synchronously. The caller must call this before its
   * first `await`, so a second tap cannot also see the card as active.
   */
  claim(nonce) {
    const entry = this.#lookup(nonce);
    if (!entry) return { status: ACTION_CARD_STATUS.UNKNOWN, entry: null };
    this.#expireIfNeeded(entry);
    const liveStatus = entry.status;
    if (liveStatus === ACTION_CARD_STATUS.ACTIVE) {
      entry.status = ACTION_CARD_STATUS.CLAIMED;
      entry.claimedAt = this.#now();
    }
    // `active` means this caller won the claim; any other value is a refusal.
    return { status: liveStatus, entry };
  }

  /**
   * Move a live card to a terminal state. Returns false when there is nothing
   * left to settle (unknown, expired, or already settled).
   */
  settle(nonce, status = ACTION_CARD_STATUS.RESOLVED) {
    if (!TERMINAL_STATUSES.has(status)) {
      throw new TypeError('An action card can only settle to a terminal status');
    }
    const entry = this.#lookup(nonce);
    if (!entry) return false;
    this.#expireIfNeeded(entry);
    if (!LIVE_STATUSES.has(entry.status)) return false;
    entry.status = status;
    entry.settledAt = this.#now();
    return true;
  }

  /** The one live card of a conversation, if any. */
  activeFor(conversationKey) {
    for (const entry of this.#entries.values()) {
      if (entry.conversationKey !== conversationKey) continue;
      this.#expireIfNeeded(entry);
      if (LIVE_STATUSES.has(entry.status)) return entry;
    }
    return null;
  }

  /** Retire every live card of one conversation (route closed, list changed). */
  revokeConversation(conversationKey, { status = ACTION_CARD_STATUS.SUPERSEDED } = {}) {
    if (!TERMINAL_STATUSES.has(status)) {
      throw new TypeError('An action card can only be revoked to a terminal status');
    }
    let revoked = 0;
    for (const entry of this.#entries.values()) {
      if (entry.conversationKey !== conversationKey) continue;
      this.#expireIfNeeded(entry);
      if (!LIVE_STATUSES.has(entry.status)) continue;
      entry.status = status;
      entry.settledAt = this.#now();
      revoked += 1;
    }
    return revoked;
  }

  /** Drop every entry whose TTL elapsed; returns how many were removed. */
  purge() {
    const now = this.#now();
    let removed = 0;
    for (const [nonce, entry] of this.#entries) {
      if (now >= entry.expiresAt) {
        this.#entries.delete(nonce);
        removed += 1;
      }
    }
    return removed;
  }

  #lookup(nonce) {
    return typeof nonce === 'string' ? this.#entries.get(nonce) ?? null : null;
  }

  #expireIfNeeded(entry) {
    if (!LIVE_STATUSES.has(entry.status)) return;
    if (this.#now() < entry.expiresAt) return;
    entry.status = ACTION_CARD_STATUS.EXPIRED;
    entry.settledAt = entry.expiresAt;
  }

  #enforceCapacity() {
    while (this.#entries.size > this.#maxEntries) {
      this.#entries.delete(this.#entries.keys().next().value);
    }
  }
}
