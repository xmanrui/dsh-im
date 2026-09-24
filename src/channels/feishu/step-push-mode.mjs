export const FEISHU_STEP_PUSH_MODES = Object.freeze({
  POST: 'post',
  STREAMING_CARD: 'streaming_card',
  LIVE_COT: 'live_cot',
});

/** New connections explicitly opt into the process-card presentation. */
export const DEFAULT_FEISHU_STEP_PUSH_MODE = FEISHU_STEP_PUSH_MODES.STREAMING_CARD;

export function normalizeFeishuStepPushMode(value) {
  // Bots created before modes existed used posts when step push was enabled.
  if (value === FEISHU_STEP_PUSH_MODES.STREAMING_CARD) {
    return FEISHU_STEP_PUSH_MODES.STREAMING_CARD;
  }
  if (value === FEISHU_STEP_PUSH_MODES.LIVE_COT) {
    return FEISHU_STEP_PUSH_MODES.LIVE_COT;
  }
  return FEISHU_STEP_PUSH_MODES.POST;
}

export function isFeishuStepPushMode(value) {
  return value === FEISHU_STEP_PUSH_MODES.POST
    || value === FEISHU_STEP_PUSH_MODES.STREAMING_CARD
    || value === FEISHU_STEP_PUSH_MODES.LIVE_COT;
}
