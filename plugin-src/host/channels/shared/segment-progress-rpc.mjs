import { SEGMENT_PREFIX_MAX_CHARS } from '../../../../src/channels/shared/progress-segment.mjs';

export const SET_SEGMENT_PROGRESS_ENDPOINT = 'bot.segment-progress.set';
export const SET_SEGMENT_PREFIX_ENDPOINT = 'bot.segment-prefix.set';

const BOT_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export function validSegmentProgressPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Reflect.ownKeys(payload).length !== 2
    || !Object.hasOwn(payload, 'botId') || !Object.hasOwn(payload, 'segmentProgress')
    || typeof payload.botId !== 'string' || !BOT_ID.test(payload.botId)
    || typeof payload.segmentProgress !== 'boolean') return false;
  return true;
}

export function validSegmentPrefixPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Reflect.ownKeys(payload).length !== 2
    || !Object.hasOwn(payload, 'botId') || !Object.hasOwn(payload, 'segmentPrefix')
    || typeof payload.botId !== 'string' || !BOT_ID.test(payload.botId)
    || typeof payload.segmentPrefix !== 'string') return false;
  // Counted in code points: one emoji must not consume two units of the limit.
  return [...payload.segmentPrefix].length <= SEGMENT_PREFIX_MAX_CHARS;
}
