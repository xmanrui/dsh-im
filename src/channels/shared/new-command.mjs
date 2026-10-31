import { randomUUID } from 'node:crypto';

import { t } from './i18n.mjs';
import { normalizeSessionTitle } from './session-title.mjs';
import { renderSessionNumber } from './session-nav-command.mjs';

const NEW_COMMAND = /^\/new(?=$|\s)/iu;

/** Whether `text` is a /new command, with or without an inline title. */
export function isNewCommand(text) {
  return typeof text === 'string' && NEW_COMMAND.test(text.trim());
}

/** The normalized inline title of `/new <title>`, or null when none/empty. */
export function newCommandTitle(text) {
  if (typeof text !== 'string') return null;
  const rest = text.trim().replace(/^\/new/iu, '').trim();
  return normalizeSessionTitle(rest);
}

async function renameCreatedSession(harness, key, sessionId, title) {
  const session = typeof harness?.workspaceSession === 'function'
    ? harness.workspaceSession(sessionId, key)
    : null;
  if (session && typeof session.renameTitle === 'function') {
    await session.renameTitle(title);
    return true;
  }
  if (typeof harness?.renameSession === 'function') {
    await harness.renameSession(sessionId, title);
    return true;
  }
  return false;
}

/**
 * Eagerly create and bind the next Session for a conversation, reusing the
 * same conversation-level creation path as the first message (bot model, agent
 * preset and workspace). An inline `title` is applied immediately and marked
 * user-titled so the first-message and provider titles never overwrite it.
 * A create/bind failure restores the previous binding (it is never cleared)
 * and returns `failed: true` so callers report an honest error; ring recording
 * and the inline rename are best-effort and never fail the command.
 */
export async function createConversationSession({ state, harness, key, title = null }) {
  const directory = await harness.prepareConversationDirectory?.(key, { explicitNew: true });
  const warning = directory?.warning ? t(directory.warning) : null;
  // A Harness without createSession keeps the old lazy path: clear the binding
  // and let the next message create the Session. No eager side effects.
  if (typeof harness?.createSession !== 'function') {
    await state.clearSession(key);
    return { sessionId: null, entry: null, warning, failed: false };
  }
  const previousSessionId = state.sessionFor?.(key) ?? null;
  const plannedSessionId = harness?.canChooseSessionId === true ? `session-${randomUUID()}` : null;
  let sessionId = null;
  try {
    if (plannedSessionId !== null && await state.setSession(key, plannedSessionId) === false) {
      throw new Error('the conversation refused to pre-bind the new Session');
    }
    sessionId = await harness.createSession({
      conversationKey: key,
      ...(plannedSessionId === null ? {} : { sessionId: plannedSessionId }),
    });
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new TypeError('createSession returned no session id');
    }
    if (sessionId !== plannedSessionId && await state.setSession(key, sessionId) === false) {
      throw new Error('the conversation refused to bind the new Session');
    }
  } catch (error) {
    console.warn('[dsh-im] unable to eagerly create the new Session:', error?.message ?? error);
    // Only a pre-bound id needs restoring; a plain create failure never touched
    // the binding, and the previous session (or none) must stay bound.
    if (plannedSessionId !== null) {
      if (previousSessionId === null) await state.clearSession?.(key);
      else await state.setSession?.(key, previousSessionId);
    }
    return { sessionId: null, entry: null, warning, failed: true };
  }
  let entry = null;
  try {
    const result = await state.ensureSessionRing?.(key, sessionId, {
      title: typeof title === 'string' && title ? title : undefined,
    });
    entry = result?.entry ?? null;
    if (entry) {
      await state.appendRing?.(key, entry.n);
      if (typeof title === 'string' && title) {
        await renameCreatedSession(harness, key, sessionId, title);
        await state.markSessionRingUserTitled?.(key, entry.n);
      }
    }
  } catch (error) {
    console.warn('[dsh-im] unable to record or rename the new Session:', error?.message ?? error);
  }
  return { sessionId, entry, warning, failed: false };
}

export async function startNewConversation({ state, harness, key, title = null }) {
  const { entry, warning, failed } = await createConversationSession({ state, harness, key, title });
  if (failed) {
    return [t('暂时无法创建新会话，请稍后重试。'), warning].filter(Boolean).join('\n');
  }
  const parts = [t('已开启全新 Harness 会话。')];
  if (typeof title === 'string' && title && entry) {
    parts.push(t('会话 {n}：{title}', {
      n: renderSessionNumber(entry, { currentSessionId: entry.sessionId }),
      title: entry.title || t('无标题'),
    }));
  }
  if (warning) parts.push(warning);
  return parts.join('\n');
}
