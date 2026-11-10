export const SET_PRESENTATION_LEVEL_ENDPOINT = 'bot.presentation-level.set';

export function validPresentationLevelPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Reflect.ownKeys(payload).length !== 2
    || !Object.hasOwn(payload, 'botId') || !Object.hasOwn(payload, 'presentationLevel')
    || typeof payload.botId !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.botId)
    || typeof payload.presentationLevel !== 'string') return false;
  return ['minimal', 'standard', 'full'].includes(payload.presentationLevel);
}
