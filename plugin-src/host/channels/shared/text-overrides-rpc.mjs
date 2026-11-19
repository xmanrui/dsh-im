import { validateTextOverrides } from '../../../../src/channels/shared/text-overrides.mjs';

export const SET_TEXT_OVERRIDES_ENDPOINT = 'bot.texts.set';

export function validTextOverridesPayload(payload) {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Reflect.ownKeys(payload).length !== 2
      || !Object.hasOwn(payload, 'botId') || !Object.hasOwn(payload, 'texts')
      || typeof payload.botId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.botId)) return false;
    validateTextOverrides(payload.texts);
    return true;
  } catch {
    return false;
  }
}
