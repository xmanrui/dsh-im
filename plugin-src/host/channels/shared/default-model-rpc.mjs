import { MODEL_COMPONENT_ID } from '../../../../src/channels/shared/default-model.mjs';

export const SET_DEFAULT_MODEL_ENDPOINT = 'bot.model.set';
export const MODEL_CATALOG_ENDPOINT = 'bot.model.catalog';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validSelection(value) {
  return isRecord(value)
    && Object.keys(value).every((key) => ['provider', 'model', 'reasoningEffort'].includes(key))
    && typeof value.provider === 'string' && MODEL_COMPONENT_ID.test(value.provider)
    && typeof value.model === 'string' && MODEL_COMPONENT_ID.test(value.model)
    && (value.reasoningEffort === undefined
      || (typeof value.reasoningEffort === 'string'
        && MODEL_COMPONENT_ID.test(value.reasoningEffort)));
}

export function validDefaultModelPayload(payload) {
  return isRecord(payload)
    && Object.keys(payload).every((key) => ['botId', 'model'].includes(key))
    && typeof payload.botId === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(payload.botId)
    && (payload.model === null || validSelection(payload.model));
}

export function publicDefaultModelError(error) {
  if (![
    'default-model-invalid',
    'default-model-unavailable',
    'default-model-unsupported',
    'model-catalog-unavailable',
    'workspace-bot-not-found',
  ].includes(error?.code)) return null;
  return { code: error.code, message: error.message };
}
