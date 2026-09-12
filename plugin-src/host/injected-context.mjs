import { getImHostLanguage } from '../../src/channels/shared/i18n.mjs';
import { rewriteInjectedContextMessages } from '../../src/channels/shared/injected-context.mjs';

/** Row label for a quoted reply, in the mirrored Host interface language. */
const REPLY_LABELS = Object.freeze({ zh: '\u5f15\u7528', en: 'Quoted' });

/** Read the current reply-row label; an unknown language falls back to English. */
function replyLabel() {
  try {
    return getImHostLanguage() === 'en' ? REPLY_LABELS.en : REPLY_LABELS.zh;
  } catch {
    return REPLY_LABELS.en;
  }
}

/**
 * Pair every injected context block with the user message that carried it.
 *
 * The prompt RPC cannot carry a message source, so a channel writes its source
 * block, guidance and quoted reply into the prompt text. `agent/pre-step` is
 * the one point where the claimed messages are already known and nothing is
 * committed yet: splitting the blocks there records each as its own
 * plugin-sourced message next to exactly the user message it belongs to,
 * whatever the inbox interleaved meanwhile. A Host without the Agent loop never
 * dispatches the event, and the prompt then keeps its inline blocks.
 *
 * @param ctx - owning Host context.
 * @param options.logger - Host logger for a rewrite that could not be trusted.
 * @returns the Cordis disposer, or null when the context cannot listen.
 */
export function installInjectedContext(ctx, { logger } = {}) {
  if (typeof ctx?.on !== 'function') return null;
  const listener = async (_payload, next) => {
    const decision = await next();
    if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') {
      return decision;
    }
    try {
      const rewritten = rewriteInjectedContextMessages(decision.messages, {
        labels: { reply: replyLabel() },
      });
      return rewritten === null ? decision : { ...decision, messages: rewritten };
    } catch (error) {
      // A failed split must never cost the user their message: the blocks then
      // stay inline, which is the same fallback a Host without Agents uses.
      logger?.warn?.('[dsh-im] unable to split the injected context blocks:', error?.message ?? error);
      return decision;
    }
  };
  return ctx.on('agent/pre-step', listener, { global: true });
}
