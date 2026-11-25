import { isReplyContent } from '../../../../src/channels/shared/reply-content.mjs';

export { SET_REPLY_CONTENT_ENDPOINT } from '../../../../src/channels/shared/reply-content.mjs';

/**
 * `{ botId, replyContent: { narration, tools, thinking } }` and nothing else.
 * Every switch must be a boolean: the settings page sends the whole set, so a
 * partial set means the caller lost state rather than asked for a change.
 */
export function validReplyContentPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Reflect.ownKeys(payload).length !== 2
    || !Object.hasOwn(payload, 'botId') || !Object.hasOwn(payload, 'replyContent')
    || typeof payload.botId !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.botId)) return false;
  return isReplyContent(payload.replyContent);
}
