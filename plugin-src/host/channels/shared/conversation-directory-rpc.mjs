import { validateConversationDirectorySettings } from '../../../../src/channels/shared/conversation-directory.mjs';

export const SET_CONVERSATION_DIRECTORY_ENDPOINT = 'bot.conversation-directory.set';
export const SET_CONVERSATION_DIRECTORY_DEFAULT_ENDPOINT = 'bot.conversation-directory.default.set';

/**
 * Validate the atomic settings save for conversation-directory isolation.
 * Delegates the field rules to the shared module so the Host and the settings
 * UI cannot drift apart.
 *
 * @param {unknown} payload `{ botId, config }`.
 * @returns {boolean} True when the payload is a complete, valid save.
 */
export function validConversationDirectoryPayload(payload) {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Reflect.ownKeys(payload).length !== 2
      || !Object.hasOwn(payload, 'botId') || !Object.hasOwn(payload, 'config')
      || typeof payload.botId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.botId)) return false;
    validateConversationDirectorySettings(payload.config);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a channel-wide default save. `config: null` clears the default and
 * returns bots without a per-bot override to isolation off.
 *
 * @param {unknown} payload `{ config }`.
 * @returns {boolean} True when the payload is a complete, valid save.
 */
export function validConversationDirectoryDefaultPayload(payload) {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Reflect.ownKeys(payload).length !== 1
      || !Object.hasOwn(payload, 'config')) return false;
    if (payload.config === null) return true;
    validateConversationDirectorySettings(payload.config);
    return true;
  } catch {
    return false;
  }
}
