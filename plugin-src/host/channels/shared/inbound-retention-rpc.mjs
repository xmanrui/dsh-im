import { normalizeInboundRetention } from '../../../../src/channels/shared/inbound-retention.mjs';

export const SET_INBOUND_RETENTION_ENDPOINT = 'bot.inbound-retention.set';
export const CLEAR_INBOUND_ATTACHMENTS_ENDPOINT = 'bot.inbound-attachments.clear';

function validBotId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function validInboundRetentionPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (!Object.keys(payload).every((key) => ['botId', 'retention'].includes(key))) return false;
  if (!validBotId(payload.botId)) return false;
  return normalizeInboundRetention(payload.retention) !== null;
}

export function validClearInboundAttachmentsPayload(payload) {
  return payload !== null
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && Object.keys(payload).length === 1
    && Object.hasOwn(payload, 'botId')
    && validBotId(payload.botId);
}
