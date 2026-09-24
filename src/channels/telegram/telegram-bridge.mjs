import { harnessQuestionText } from '../shared/harness-question.mjs';
import { TextHarnessBridge, createTextBridgeStatus } from '../shared/text-harness-bridge.mjs';

export const TELEGRAM_DESCRIPTOR = Object.freeze({
  key: 'telegram',
  label: 'Telegram',
  connectionLabel: ' Bot API 长轮询',
  reactions: Object.freeze({ processing: '👀', success: '👍', error: '👎' }),
});

/** One keyboard row per option; beyond this the list stops being scannable. */
const MAX_CARD_OPTIONS = 8;

/**
 * Encode a press. Carries the presentation nonce so a keyboard left over from an
 * earlier question cannot answer a later one — a new request restarts its indexes
 * at zero, so the index alone would collide. Still far under Telegram's 64-byte
 * callback_data budget, so no server-side id table is needed.
 */
function cardCallbackData(nonce, questionIndex, optionIndex) {
  return `q|${nonce}|${questionIndex}|${optionIndex}`;
}

/** Parse a press produced by {@link cardCallbackData}; null for foreign payloads. */
export function parseTelegramCardCallback(data) {
  const match = typeof data === 'string'
    ? /^q\|([A-Za-z0-9_-]{1,16})\|(\d{1,4})\|(\d{1,4})$/u.exec(data)
    : null;
  if (!match) return null;
  return {
    nonce: match[1],
    questionIndex: Number(match[2]),
    optionIndex: Number(match[3]),
  };
}

/**
 * Inline-keyboard presentation for single-choice questions.
 *
 * Returns null — leaving the plain-text flow in charge — when a keyboard cannot
 * express every answer the request allows: no options, an unusable button label,
 * more options than fit, or multi-select (which needs an accumulating keyboard
 * plus a submit action this channel does not have yet).
 */
export const TELEGRAM_INTERACTION_CARD = Object.freeze({
  render(question, { questionIndex = 0, total = 1, requiresMention = false, nonce } = {}) {
    // Without an identity the press could not be attributed to this presentation.
    if (typeof nonce !== 'string' || !nonce) return null;
    const options = Array.isArray(question?.options) ? question.options : [];
    if (options.length === 0 || options.length > MAX_CARD_OPTIONS) return null;
    if (question.multiSelect === true) return null;
    if (options.some((option) => typeof option?.label !== 'string' || !option.label.trim())) {
      return null;
    }
    return {
      text: harnessQuestionText(question, questionIndex, total, {
        requiresMention,
        hasButtons: true,
      }),
      markup: {
        inline_keyboard: options.map((option, optionIndex) => [{
          text: option.label,
          callback_data: cardCallbackData(nonce, questionIndex, optionIndex),
        }]),
      },
    };
  },
  parse: parseTelegramCardCallback,
});

export class TelegramHarnessBridge extends TextHarnessBridge {
  constructor(options) {
    super({
      descriptor: TELEGRAM_DESCRIPTOR,
      interactionCard: TELEGRAM_INTERACTION_CARD,
      ...options,
    });
  }
}

export { createTextBridgeStatus as createTelegramBridgeStatus };
