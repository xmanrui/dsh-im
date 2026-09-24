// The `/new` command body, shared by every channel bridge.
//
// Extracted so the directory-isolation step cannot be wired into some channels
// and forgotten in others: whichever platform received `/new`, the reset must
// clear the old Session binding and then put the conversation's directory in
// force before the next message creates a Session.
//
// The confirmation text stays the channel's own literal and only gains an
// appended line when isolation actually applies, so a deployment that never
// opted in sends exactly the message it sent before.

import { conversationDirectoryFailureReason } from './conversation-directory.mjs';
import { ensureConversationDirectory } from './conversation-directory-ensure.mjs';
import { t } from './i18n.mjs';

/**
 * The appended line naming the directory now in force; reused by a channel that
 * renders its own confirmation.
 *
 * @param {string} directory Absolute directory path.
 * @returns {string} A localized line.
 */
export function conversationDirectoryNotice(directory) {
  return t('会话目录：{directory}', { directory });
}

/**
 * The appended line explaining that isolation did not apply to this Session.
 *
 * @param {string | null | undefined} reason Degradation code.
 * @returns {string} A localized line.
 */
export function conversationDirectoryFailureNotice(reason) {
  return t('（会话目录未生效：{reason}；本次仍在原工作区运行）', {
    reason: t(conversationDirectoryFailureReason(reason)),
  });
}

/**
 * Clear the conversation's Session binding and prepare its next directory.
 *
 * Never throws for an environmental failure: `/new` must still release the old
 * binding, and the caller needs a sentence to send rather than a stack trace.
 *
 * @param {object} options Reset options.
 * @param {object} options.harness Bot workspace scope.
 * @param {object} options.state Conversation state store.
 * @param {string} options.key Conversation key.
 * @param {string} options.message The channel's own confirmation literal.
 * @param {object} [options.logger] Logger for degraded paths.
 * @returns {Promise<{ prepared: object | null, message: string }>} The
 *   preparation outcome and the confirmation to send.
 */
export async function resetConversationSession({
  harness,
  state,
  key,
  message,
  logger,
} = {}) {
  await state.clearSession(key);
  let prepared = null;
  try {
    prepared = await ensureConversationDirectory({ harness, key, fresh: true, logger });
  } catch (error) {
    logger?.warn?.('[dsh-im] conversation directory preparation failed:', error?.message ?? error);
    return { prepared: null, message };
  }
  if (!prepared?.enabled) return { prepared, message };
  if (prepared.degraded) {
    return {
      prepared,
      message: `${message}\n${conversationDirectoryFailureNotice(prepared.reason)}`,
    };
  }
  return {
    prepared,
    message: `${message}\n${conversationDirectoryNotice(prepared.directory)}`,
  };
}
