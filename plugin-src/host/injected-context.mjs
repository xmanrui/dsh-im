import { rewriteInjectedContextMessages } from '../../src/channels/shared/injected-context.mjs';

/**
 * Pair every injected context prefix with the user message that carried it.
 *
 * The prompt RPC cannot carry a message source, so a channel writes its source
 * block into the prompt text. `agent/pre-step` is the one point where the
 * claimed messages are already known and nothing is committed yet: splitting
 * the prefix there records the source as its own plugin-sourced message next to
 * exactly the user message it described, whatever the inbox interleaved
 * meanwhile. A Host without the Agent loop never dispatches the event, and the
 * prompt then keeps its inline prefix.
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
      const rewritten = rewriteInjectedContextMessages(decision.messages);
      return rewritten === null ? decision : { ...decision, messages: rewritten };
    } catch (error) {
      // A failed split must never cost the user their message: the prefix then
      // stays inline, which is the same fallback a Host without Agents uses.
      logger?.warn?.('[dsh-im] unable to split the injected context prefix:', error?.message ?? error);
      return decision;
    }
  };
  return ctx.on('agent/pre-step', listener, { global: true });
}
