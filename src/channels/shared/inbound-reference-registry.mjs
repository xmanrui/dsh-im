// Ephemeral host-side provider evidence; never derives identity from prompt text.
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 4096;
const REQUIRED_FIELDS = ['channel', 'chatId', 'messageId'];
const OPTIONAL_FIELDS = ['botId', 'relationKind'];
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 512;

export function referenceFromSemanticMessage(channel, message) {
  if (!message || typeof message !== 'object') return undefined;
  // The generic messageId may be an update/event id. Use the provider's actual
  // message id where an adapter explicitly normalizes one; replyTarget itself
  // is not generally the inbound message (e.g. Discord may route into a thread).
  const currentId = channel === 'telegram' ? message.replyTarget?.replyToMessageId
    : channel === 'slack' ? message.reactionTarget?.messageTs
      : channel === 'whatsapp' ? message.providerMessageId : message.messageId;
  return {
    channel,
    chatId: message.conversationId,
    messageId: currentId === undefined || currentId === null ? '' : String(currentId),
    replyToMessageId: message.replyTo?.unavailableReason === 'not-found'
      ? undefined : message.replyTo?.messageId ?? message.replyToEventId,
    hasReference: Boolean(message.replyTo || message.replyToEventId),
    relationKind: channel === 'slack' ? 'thread-root' : 'reply',
  };
}

export function createInboundReferenceRegistry({ now = Date.now, ttlMs = TTL_MS, maxEntries = MAX_ENTRIES } = {}) {
  const records = new Map();
  const key = (sessionId, rpcId) => JSON.stringify([sessionId, rpcId]);
  function prune() {
    const current = now();
    for (const [id, entry] of records) if (entry.expiresAt <= current) records.delete(id);
  }
  return Object.freeze({
    record(sessionId, rpcId, source) {
      if (!identifier(sessionId) || !identifier(rpcId) || !source || !REQUIRED_FIELDS.every(field => identifier(source[field]))
        || (!identifier(source.replyToMessageId) && source.hasReference !== true)) return;
      prune();
      const id = key(sessionId, rpcId);
      const fields = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS.filter(field => identifier(source[field]))];
      const value = Object.fromEntries(fields.map(field => [field, source[field]]));
      if (identifier(source.replyToMessageId)) value.replyToMessageId = source.replyToMessageId;
      else value.referenceStatus = 'unknown';
      // RPC identifiers are immutable; never let another message replace one.
      if (records.has(id)) return;
      records.set(id, { value: Object.freeze(value), expiresAt: now() + ttlMs });
      while (records.size > maxEntries) records.delete(records.keys().next().value);
    },
    get(sessionId, rpcId) {
      if (!identifier(sessionId) || !identifier(rpcId)) return undefined;
      prune();
      const entry = records.get(key(sessionId, rpcId));
      return entry ? { ...entry.value } : undefined;
    },
  });
}

export const inboundReferenceRegistry = createInboundReferenceRegistry();
