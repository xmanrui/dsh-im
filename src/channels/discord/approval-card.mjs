import { t } from '../shared/i18n.mjs';
import {
  ACTION_CARD_STATUS,
  ActionCardRegistry,
  actionCardStateText,
  createCallbackNamespace,
} from '../shared/action-card.mjs';
import { APPROVAL_SUBMIT_RESULT, harnessApprovalText } from '../shared/harness-approval.mjs';

/**
 * Discord approval buttons on top of the shared HarnessApprovalQueue `render`
 * hook.
 *
 * Discord carries buttons as message components: one ACTION_ROW with two BUTTON
 * components whose `custom_id` names this presentation. A press arrives as a
 * Gateway INTERACTION_CREATE packet, so the flow is:
 *   1. acknowledge the interaction first — Discord drops a press that is not
 *      acknowledged within three seconds, and a deferred update is the only ack
 *      that does not add a message;
 *   2. check the actor (only the user who started the turn may decide);
 *   3. claim the nonce synchronously so duplicate/concurrent presses submit once;
 *   4. submit through the shared queue, then edit the original message into a
 *      terminal receipt with the buttons removed.
 *
 * A card that cannot be delivered falls back to the exact plain-text prompt the
 * bridge used before, so an approval can never be lost to a broken button.
 */

/** Versioned namespace so a stale `a1|`/future `ap2|` payload can never be replayed. */
export const DISCORD_APPROVAL_NAMESPACE_PREFIX = 'ap1';
export const DISCORD_APPROVAL_ACTIONS = Object.freeze({ approve: 'a', reject: 'd' });
export const DISCORD_APPROVAL_CALLBACK = createCallbackNamespace(
  DISCORD_APPROVAL_NAMESPACE_PREFIX,
);

/** Discord rejects a message whose content exceeds 2 000 characters. */
export const DISCORD_APPROVAL_CARD_MAX_CHARS = 1_950;

const COMPONENT_ACTION_ROW = 1;
const COMPONENT_BUTTON = 2;
const BUTTON_STYLE_SUCCESS = 3;
const BUTTON_STYLE_DANGER = 4;
const NO_COMPONENTS = Object.freeze([]);

const OUTCOME_BY_DECISION = Object.freeze({
  approve: 'allowed-once',
  reject: 'rejected',
});
const ACTION_BY_DECISION = Object.freeze({
  approve: DISCORD_APPROVAL_ACTIONS.approve,
  reject: DISCORD_APPROVAL_ACTIONS.reject,
});
const DECISION_BY_ACTION = Object.freeze({
  [DISCORD_APPROVAL_ACTIONS.approve]: 'approve',
  [DISCORD_APPROVAL_ACTIONS.reject]: 'reject',
});
const BUTTON_TEXT = Object.freeze({
  approve: '✅ 批准一次',
  reject: '❌ 拒绝',
});
/** The card body keeps the tool/argument summary; the buttons replace the prompt. */
const TERMINAL_LABEL = Object.freeze({
  'allowed-once': '✅ 已批准（仅本次）',
  rejected: '❌ 已拒绝',
  expired: '⏰ 已过期',
  unavailable: '⛔ 已失效',
});
const TERMINAL_STATUS_BY_OUTCOME = Object.freeze({
  'allowed-once': ACTION_CARD_STATUS.RESOLVED,
  rejected: ACTION_CARD_STATUS.RESOLVED,
  expired: ACTION_CARD_STATUS.EXPIRED,
  unavailable: ACTION_CARD_STATUS.REVOKED,
});
const DEFAULT_STATE_TEXT_OVERRIDES = Object.freeze({
  [ACTION_CARD_STATUS.CLAIMED]: '正在提交审批决定，请稍候。',
  [ACTION_CARD_STATUS.RESOLVED]: '该审批已处理，无需重复操作。',
  [ACTION_CARD_STATUS.EXPIRED]: '该审批已过期，已自动拒绝。',
  [ACTION_CARD_STATUS.SUPERSEDED]: '该审批已被新提示取代，请使用最新一条。',
  [ACTION_CARD_STATUS.STALE]: '该审批已失效，请等待新的审批提示。',
  [ACTION_CARD_STATUS.REVOKED]: '该审批已失效，请等待新的审批提示。',
  [ACTION_CARD_STATUS.UNKNOWN]: '该审批已处理或不存在，无需重复操作。',
});
const APPROVAL_CARD_NOTICES = Object.freeze({
  ownerOnly: '只有发起当前任务的用户可以处理这条审批。',
});

/** Encode one approval button payload (`ap1|<nonce>|<a|d>`). */
export function discordApprovalCustomId(nonce, decision) {
  const action = ACTION_BY_DECISION[decision];
  if (!action) throw new TypeError('An approval decision must be approve or reject');
  return DISCORD_APPROVAL_CALLBACK.encode({ nonce, action });
}

/** Parse one of our button payloads; null for anything else. */
export function parseDiscordApprovalCustomId(data) {
  const parsed = DISCORD_APPROVAL_CALLBACK.parse(data);
  if (!parsed) return null;
  const decision = DECISION_BY_ACTION[parsed.action];
  if (!decision) return null;
  return { nonce: parsed.nonce, action: decision };
}

/** The two-button action row for one presentation. */
export function discordApprovalComponents(nonce) {
  return [{
    type: COMPONENT_ACTION_ROW,
    components: [
      {
        type: COMPONENT_BUTTON,
        style: BUTTON_STYLE_SUCCESS,
        label: t(BUTTON_TEXT.approve),
        custom_id: discordApprovalCustomId(nonce, 'approve'),
      },
      {
        type: COMPONENT_BUTTON,
        style: BUTTON_STYLE_DANGER,
        label: t(BUTTON_TEXT.reject),
        custom_id: discordApprovalCustomId(nonce, 'reject'),
      },
    ],
  }];
}

/**
 * The card body: today's approval text (tool + arguments + reason) without the
 * "type 批准/拒绝" prompt, which a button makes obsolete. The plain-text path
 * still uses the unmodified `harnessApprovalText` output.
 */
export function discordApprovalCardText(pending) {
  const text = harnessApprovalText(pending?.interaction?.payload, {
    toolCall: pending?.toolCall,
    requiresMention: pending?.requiresMention === true,
    hasButtons: true,
  });
  return typeof text === 'string' && text ? text : (pending?.text ?? '');
}

function terminalCardText(cardText, outcome, resolvedText) {
  const label = TERMINAL_LABEL[outcome]
    ? t(TERMINAL_LABEL[outcome])
    : (typeof resolvedText === 'string' ? resolvedText : '');
  return label ? `${cardText}\n\n${label}` : cardText;
}

/**
 * Discord adapter for the shared approval queue. One instance lives per bridge
 * and owns the nonce registry, so a stale card from an earlier turn is
 * recognisable and a new approval in the same conversation supersedes it.
 */
export class DiscordApprovalCard {
  #registry;
  #logger;
  #notices;

  constructor({
    logger = console,
    registry,
    stateTexts = {},
    ttlMs = 65 * 60_000,
  } = {}) {
    this.#registry = registry instanceof ActionCardRegistry
      ? registry
      : new ActionCardRegistry({ ttlMs });
    this.#logger = logger;
    this.#notices = {
      ...DEFAULT_STATE_TEXT_OVERRIDES,
      ...stateTexts,
    };
  }

  get registry() {
    return this.#registry;
  }

  /**
   * Build the `render` / `onResolved` / `send` context handed to
   * HarnessApprovalQueue. Returns an empty object when the bot cannot carry
   * components, leaving the queue's plain-text flow completely untouched.
   */
  createContext({ key, actor, target, send, bot } = {}) {
    if (typeof bot?.sendInteractionCard !== 'function'
      || typeof bot?.editInteractionCard !== 'function') {
      return {};
    }
    const rawSend = typeof send === 'function' ? send : async () => {};
    let card = null;
    // Nonce of the card being rendered, known before its message id is.
    let cardNonce = null;
    // A decision can land while the card send is still in flight: the buttons are
    // visible but `card` (and therefore the message id) is not set yet. Store the
    // outcome so the terminal state is applied once the id arrives.
    let pendingResolution = null;
    // The queue sends the terminal receipt as a separate text right after
    // `onResolved`; when the card edit already delivered it, that copy is noise.
    let swallowResolvedText = null;

    const guardedSend = async (text) => {
      if (swallowResolvedText !== null && text === swallowResolvedText) {
        swallowResolvedText = null;
        return;
      }
      return rawSend(text);
    };

    /** Replace the card body with the receipt and remove its components. */
    const applyTerminalState = async (settledCard, resolvedText, outcome) => {
      if (settledCard.messageId === null) return false;
      try {
        await bot.editInteractionCard(target, settledCard.messageId, {
          text: terminalCardText(settledCard.text, outcome, resolvedText),
          components: NO_COMPONENTS,
        });
        return true;
      } catch (error) {
        this.#logger.warn?.(
          '[dsh-im:discord] could not update a resolved approval card; the text receipt follows:',
          error?.message ?? error,
        );
        await this.#updateCard(bot, target, settledCard.messageId, { components: NO_COMPONENTS });
        return false;
      }
    };

    return {
      send: guardedSend,
      render: async (pending) => {
        const text = discordApprovalCardText(pending);
        // A component message still carries content; a body that would exceed the
        // Discord limit keeps the text path instead of a doomed 400.
        if (text.length > DISCORD_APPROVAL_CARD_MAX_CHARS) {
          this.#logger.warn?.(
            '[dsh-im:discord] approval body exceeds the Discord message limit; using the plain-text approval:',
            `${text.length} chars`,
          );
          await rawSend(pending.text);
          return;
        }
        const entry = this.#registry.issue({
          conversationKey: key,
          kind: 'approval',
          payload: { approvalId: pending.approvalId, actor },
        });
        cardNonce = entry.nonce;
        try {
          const sent = await bot.sendInteractionCard(target, {
            text,
            components: discordApprovalComponents(entry.nonce),
          });
          card = {
            nonce: entry.nonce,
            approvalId: pending.approvalId,
            messageId: sent?.providerMessageIds?.at(-1) ?? null,
            text,
          };
          // The card now owns the decision guidance and the terminal receipt.
          pending.interactiveCard = true;
          // A decision raced the send: finish the terminal edit that
          // `onResolved` could not do while the message id was unknown.
          if (pendingResolution) {
            const { resolvedText, outcome } = pendingResolution;
            pendingResolution = null;
            await applyTerminalState(card, resolvedText, outcome);
          }
        } catch (error) {
          // A channel that refuses components must not lose the approval: clear
          // the registration and send the exact pre-card prompt instead.
          this.#registry.settle(entry.nonce, ACTION_CARD_STATUS.REVOKED);
          card = null;
          pendingResolution = null;
          this.#logger.warn?.(
            '[dsh-im:discord] could not deliver an approval card; falling back to the plain-text approval:',
            error?.message ?? error,
          );
          await rawSend(pending.text);
        }
      },
      onResolved: async (resolvedText, outcome) => {
        const nonce = card?.nonce ?? cardNonce;
        if (!nonce) return false;
        // Settle first: a press arriving while the edit is in flight must be
        // refused instead of submitting the same decision twice.
        this.#registry.settle(
          nonce,
          TERMINAL_STATUS_BY_OUTCOME[outcome] ?? ACTION_CARD_STATUS.RESOLVED,
        );
        if (!card) {
          // The send response is still pending. Let the queue deliver the text
          // receipt now — the decision must never be lost — and remember the
          // outcome so `render` clears the buttons once the id is known.
          pendingResolution = { resolvedText, outcome };
          return false;
        }
        const delivered = await applyTerminalState(card, resolvedText, outcome);
        // The edit landed (or the client already shows it): tell the queue the
        // receipt is delivered so it skips the duplicate terminal text.
        if (delivered) swallowResolvedText = resolvedText;
        return delivered;
      },
    };
  }

  /**
   * Handle one component press. Returns false for payloads this card did not
   * produce, so future button namespaces keep their own path.
   */
  async handlePress(callback, { bot, answer, submit } = {}) {
    const parsed = parseDiscordApprovalCustomId(callback?.data);
    if (!parsed) return false;
    const senderId = typeof callback?.senderId === 'string' ? callback.senderId : '';
    const entry = this.#registry.get(parsed.nonce);

    // Check the actor before claiming: a stranger's press must not consume the
    // owner's only chance to decide. The reply is ephemeral, so it never adds a
    // message to the channel.
    if (entry
      && (entry.status === ACTION_CARD_STATUS.ACTIVE || entry.status === ACTION_CARD_STATUS.CLAIMED)
      && typeof entry.payload?.actor === 'string'
      && entry.payload.actor !== senderId) {
      await answer?.(t(APPROVAL_CARD_NOTICES.ownerOnly));
      return true;
    }

    // Synchronous claim: whoever gets here first owns the decision; a second tap
    // (or a second client) is told what happened without submitting again.
    const claimed = this.#registry.claim(parsed.nonce);
    if (claimed.status !== ACTION_CARD_STATUS.ACTIVE) {
      await answer?.(actionCardStateText(claimed.status, this.#notices));
      if (claimed.status !== ACTION_CARD_STATUS.CLAIMED) {
        await this.#updateCard(bot, callback?.replyTarget, callback?.providerMessageId, {
          components: NO_COMPONENTS,
        });
      }
      return true;
    }

    const live = claimed.entry;
    // Acknowledge before doing anything that can fail or take time. The ack is a
    // deferred message update; a later edit (terminal receipt or a restored
    // keyboard) is what the client finally shows.
    await answer?.();
    if (typeof submit !== 'function') {
      this.#registry.settle(parsed.nonce, ACTION_CARD_STATUS.STALE);
      await this.#updateCard(bot, callback?.replyTarget, callback?.providerMessageId, {
        components: NO_COMPONENTS,
      });
      return true;
    }
    const outcome = OUTCOME_BY_DECISION[parsed.action];
    let submitted = APPROVAL_SUBMIT_RESULT.RETRYABLE;
    try {
      submitted = await submit(live.payload?.approvalId, outcome, {
        actor: senderId,
        detailed: true,
      });
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-im:discord] failed to submit an approval card decision:',
        error?.message ?? error,
      );
      submitted = APPROVAL_SUBMIT_RESULT.RETRYABLE;
    }
    if (submitted === APPROVAL_SUBMIT_RESULT.SUBMITTED) return true;
    if (submitted === APPROVAL_SUBMIT_RESULT.RETRYABLE
      || submitted === APPROVAL_SUBMIT_RESULT.BUSY) {
      // The deferred ack must be resolved; put the live buttons back so the user
      // can retry with the same card. The queue blocks duplicate submissions and
      // its resolution hook retires the card on success.
      this.#registry.releaseClaim(parsed.nonce);
      await this.#updateCard(bot, callback?.replyTarget, callback?.providerMessageId, {
        components: discordApprovalComponents(parsed.nonce),
      });
      return true;
    }
    // The live queue no longer has this approval (resolved elsewhere, route
    // closed). Retire the card instead of leaving buttons that keep failing.
    this.#registry.settle(parsed.nonce, ACTION_CARD_STATUS.STALE);
    await this.#updateCard(bot, callback?.replyTarget, callback?.providerMessageId, {
      components: NO_COMPONENTS,
    });
    return true;
  }

  async #updateCard(bot, target, providerMessageId, body) {
    if (typeof bot?.updateInteractionCard !== 'function') return;
    if (!target || typeof providerMessageId !== 'string' || !providerMessageId) return;
    try {
      await bot.updateInteractionCard(target, providerMessageId, body);
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-im:discord] could not update an approval card:',
        error?.message ?? error,
      );
    }
  }
}
