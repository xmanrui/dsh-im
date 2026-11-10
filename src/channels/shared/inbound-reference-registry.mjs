// Ephemeral host-side provider evidence; never derives identity from prompt text.
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 4096;
const FIELDS = ['channel', 'botId', 'chatId', 'messageId', 'replyToMessageId'];
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 512;

export function createInboundReferenceRegistry({ now = Date.now, ttlMs = TTL_MS, maxEntries = MAX_ENTRIES } = {}) {
  const records = new Map();
  const key = (sessionId, rpcId) => JSON.stringify([sessionId, rpcId]);
  function prune() {
    const current = now();
    for (const [id, entry] of records) if (entry.expiresAt <= current) records.delete(id);
  }
  return Object.freeze({
    record(sessionId, rpcId, source) {
      if (!identifier(sessionId) || !identifier(rpcId) || !source || !FIELDS.every(field => identifier(source[field]))) return;
      prune();
      const id = key(sessionId, rpcId);
      const value = Object.fromEntries(FIELDS.map(field => [field, source[field]]));
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
