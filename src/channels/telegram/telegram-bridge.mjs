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
 * Encode a press. The question index is carried so a keyboard left over from an
 * earlier question cannot answer the one currently on screen. Well under
 * Telegram's 64-byte callback_data budget, so no server-side id table is needed.
 */
function cardCallbackData(questionIndex, optionIndex) {
  return `q|${questionIndex}|${optionIndex}`;
}

/** Parse a press produced by {@link cardCallbackData}; null for foreign payloads. */
export function parseTelegramCardCallback(data) {
  const match = typeof data === 'string' ? /^q\|(\d{1,3})\|(\d{1,3})$/u.exec(data) : null;
  if (!match) return null;
  return { questionIndex: Number(match[1]), optionIndex: Number(match[2]) };
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
  render(question, { questionIndex = 0, total = 1, requiresMention = false } = {}) {
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
          callback_data: cardCallbackData(questionIndex, optionIndex),
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
