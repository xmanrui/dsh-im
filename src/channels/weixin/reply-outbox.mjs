/**
 * Weixin outbound reply planning and per-user send budget.
 *
 * iLink accepts about ten `sendmessage` calls for one inbound user message
 * (one `context_token`); the eleventh is rejected. The outbox keeps the
 * remaining segments in memory and flushes them when the user sends the next
 * message, which starts a new budget.
 *
 * This module is deliberately transport-free: callers provide `sendText` and
 * `sendFile`, so the same planner can be used by the bridge without importing
 * the iLink API or the i18n layer.
 */

export const WEIXIN_REPLY_QUOTA = 10;
export const DEFAULT_MAX_TEXT_CHARS = 1_800;

/**
 * @typedef {{ kind: 'image' | 'file' }} OutboundFile
 * @typedef {{ sendText: (text: string) => Promise<unknown>, sendFile: (file: OutboundFile) => Promise<unknown> }} OutboxApi
 */

export class WeixinQuotaExceededError extends Error {
  constructor(limit = WEIXIN_REPLY_QUOTA) {
    super(`Weixin reply budget exhausted (${limit} messages per inbound message)`);
    this.name = 'WeixinQuotaExceededError';
    this.code = 'weixin-quota-exceeded';
  }
}

/**
 * Shared counter for every `sendmessage` call made to one Weixin user.
 *
 * @param {{ quota?: number }} [options]
 */
export function createSendBudget({ quota = WEIXIN_REPLY_QUOTA } = {}) {
  if (!Number.isInteger(quota) || quota < 1) throw new TypeError('quota must be a positive integer');
  /** @type {Map<string, number>} */
  const used = new Map();

  return {
    /** Consume one slot; returns false when the budget is already exhausted. */
    consume(key) {
      const current = used.get(key) ?? 0;
      if (current >= quota) return false;
      used.set(key, current + 1);
      return true;
    },
    remaining(key) {
      return Math.max(0, quota - (used.get(key) ?? 0));
    },
    reset(key) {
      used.delete(key);
    },
    used(key) {
      return used.get(key) ?? 0;
    },
  };
}

/**
 * Split a reply into media first, text last.
 *
 * Media is sent before the text on purpose: Weixin renders new messages at the
 * bottom. Sending text first would push it upward as the images arrive, so the
 * reader would have to scroll up for the text and back down for the images.
 *
 * @param {string} text
 * @param {readonly OutboundFile[]} files
 * @param {number} [maxTextChars]
 * @returns {Array<{ kind: 'text', text: string } | { kind: 'media', file: OutboundFile }>}
 */
export function planReply(text, files = [], maxTextChars = DEFAULT_MAX_TEXT_CHARS) {
  const media = files.map((file) => ({ kind: 'media', file }));
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return media;
  return [
    ...media,
    ...splitText(trimmed, maxTextChars).map((chunk) => ({ kind: 'text', text: chunk })),
  ];
}

/**
 * Split text on paragraph or space boundaries, falling back to a hard cut.
 * Mirrors the channel's 1,800-character send limit so every chunk consumes one
 * `sendmessage` slot.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
export function splitText(text, maxChars) {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new TypeError('maxChars must be a positive integer');
  }
  const chunks = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n', maxChars);
    if (cut < Math.floor(maxChars / 2)) cut = rest.lastIndexOf(' ', maxChars);
    if (cut < Math.floor(maxChars / 2)) cut = maxChars;
    const chunk = rest.slice(0, cut).trimEnd();
    if (chunk) chunks.push(chunk);
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Continue replies used only to flush a deferred outbox, never submitted to the Agent. */
export function isContinueReply(text) {
  return /^(?:继续|继续发|接着发|接着|发吧|ok|okay|好|好的|好滴|好嘞|嗯|嗯嗯|\[OK\]|👌)[\s,，.。!！~～]*$/iu.test(
    String(text ?? '').trim(),
  );
}

/**
 * @typedef {object} ReplyOutbox
 * @property {(key: string, text: string, files: readonly OutboundFile[], api: OutboxApi) => Promise<void>} send
 * @property {(key: string, contextToken?: string) => ({ sending: Promise<void>, asked: boolean } | undefined)} resume
 * @property {(key: string) => string | undefined} contextToken
 */

/**
 * @param {{
 *   quota?: number,
 *   maxTextChars?: number,
 *   formatNotice: (count: number) => string,
 *   budget?: ReturnType<typeof createSendBudget>,
 * }} options
 * @returns {ReplyOutbox}
 */
export function createReplyOutbox({
  quota = WEIXIN_REPLY_QUOTA,
  maxTextChars = DEFAULT_MAX_TEXT_CHARS,
  formatNotice,
  budget = createSendBudget({ quota }),
} = {}) {
  if (typeof formatNotice !== 'function') throw new TypeError('formatNotice must be a function');

  /** @type {Map<string, { pending: Array<{ segment: any, api: OutboxApi }>, asked: boolean, draining: boolean, done: Promise<void>, contextToken?: string }>} */
  const queues = new Map();

  const queueOf = (key) => {
    let queue = queues.get(key);
    if (!queue) {
      queue = { pending: [], asked: false, draining: false, done: Promise.resolve() };
      queues.set(key, queue);
    }
    return queue;
  };

  const drain = (key, queue) => {
    if (!queue.draining) {
      queue.draining = true;
      queue.done = drainQueue(key, queue).finally(() => {
        queue.draining = false;
      });
    }
    return queue.done;
  };

  const drainQueue = async (key, queue) => {
    try {
      while (queue.pending.length > 0) {
        const left = budget.remaining(key);
        if (left <= 0) return;
        if (left === 1 && queue.pending.length > 1) {
          await sendDeferredNotice(key, queue);
          return;
        }
        const item = queue.pending.shift();
        if (!budget.consume(key)) {
          queue.pending.unshift(item);
          return;
        }
        if (item.segment.kind === 'text') await item.api.sendText(item.segment.text);
        else await item.api.sendFile(item.segment.file);
      }
    } catch (error) {
      queue.pending = [];
      queue.asked = false;
      throw error;
    }
  };

  const sendDeferredNotice = async (key, queue) => {
    const next = queue.pending[0];
    if (!budget.consume(key)) return;
    await next.api.sendText(formatNotice(queue.pending.length));
    queue.asked = true;
  };

  return {
    send(key, text, files, api) {
      const queue = queueOf(key);
      queue.pending.push(
        ...planReply(text, files, maxTextChars).map((segment) => ({ segment, api })),
      );
      return drain(key, queue);
    },

    resume(key, contextToken) {
      const queue = queueOf(key);
      if (contextToken) queue.contextToken = contextToken;
      budget.reset(key);
      const asked = queue.asked;
      queue.asked = false;
      if (queue.draining || queue.pending.length === 0) return undefined;
      return { sending: drain(key, queue), asked };
    },

    contextToken: (key) => queues.get(key)?.contextToken,
  };
}
