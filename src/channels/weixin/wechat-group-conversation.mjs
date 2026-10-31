const UIA_WECHAT_GROUP_SOURCE = 'uia-wechat-group/v1';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Normalize only the legacy direct shape and the documented local UIA v1 shape.
 * No iLink group payload is inferred: an explicit unknown source is rejected,
 * while the absence of source retains the historical direct-message fallback.
 */
export function weixinConversation(message) {
  if (message?.source !== undefined) {
    if (message.source !== UIA_WECHAT_GROUP_SOURCE) return null;
    return groupConversation(message);
  }
  const senderId = nonEmptyString(message?.from_user_id);
  if (!senderId) return null;
  const senderName = nonEmptyString(message?.sender_name);
  const conversationTitle = nonEmptyString(message?.conversation_title);
  return {
    kind: 'direct',
    chatId: senderId,
    senderId,
    ...(senderName ? { senderName } : {}),
    ...(conversationTitle ? { conversationTitle } : {}),
    replyTarget: senderId,
    addressed: true,
  };
}

function groupConversation(message) {
  // Validate every field the UIA producer promised before any access, Session,
  // dedup, or outbound side effect can consume the event.
  if (message?.conversation_type !== 'group'
    || message?.message_type !== 1
    || !nonEmptyString(message?.message_id)
    || message?.addressed !== true
    || typeof message?.text !== 'string'
    || !message.text.trim()
    || typeof message?.raw_text !== 'string'
    || !message.raw_text.trim()
    || !Number.isSafeInteger(message?.sent_at)
    || message.sent_at < 0
    || typeof message?.is_self !== 'boolean') return null;

  const chatId = nonEmptyString(message?.conversation_id);
  const senderId = nonEmptyString(message?.from_user_id);
  const senderName = nonEmptyString(message?.sender_name);
  const conversationTitle = nonEmptyString(message?.conversation_title);
  const replyTarget = nonEmptyString(message?.reply_target);
  if (!chatId || !senderId || !senderName || !conversationTitle || !replyTarget
    || replyTarget !== chatId) return null;

  // v1 currently carries one normalized text item. Its body must agree with
  // the top-level text so downstream extraction cannot process different words
  // from the ones that passed schema validation.
  if (!Array.isArray(message?.item_list) || message.item_list.length !== 1) return null;
  const [item] = message.item_list;
  if (item?.type !== 1 || typeof item?.text_item?.text !== 'string'
    || item.text_item.text.trim() !== message.text.trim()) return null;

  return {
    kind: 'group',
    chatId,
    senderId,
    senderName,
    conversationTitle,
    replyTarget,
    addressed: true,
  };
}

/** Return the sole Session key for a valid event, never a best-effort fallback. */
export function conversationKey(message) {
  const conversation = weixinConversation(message);
  if (!conversation) return null;
  return (conversation.kind === 'group' ? 'group:' : 'p2p:') + conversation.chatId;
}
