import { withSessionBindingLock } from './session-binding-lock.mjs';
import { initialSessionTitle } from './session-title.mjs';

export const WORKSPACE_SESSION_STALE = 'workspace-session-stale';

function workspaceSessionStaleError() {
  const error = new Error('The conversation workspace changed before the prompt was sent.');
  error.code = WORKSPACE_SESSION_STALE;
  return error;
}

/**
 * Read the conversation's effective-workspace generation. A bot-scoped Harness
 * exposes it; anything else (plain fixtures, older Harnesses) yields null and
 * disables the conversation-level fence without changing existing behavior.
 */
function readConversationGeneration(harness, conversationKey) {
  return typeof harness?.conversationWorkspaceGeneration === 'function'
    ? harness.conversationWorkspaceGeneration(conversationKey) ?? null
    : null;
}

function conversationGenerationMoved(harness, conversationKey, generation) {
  if (generation === null) return false;
  return readConversationGeneration(harness, conversationKey) !== generation;
}

/**
 * Wait for a conversation-level workspace switch that is still committing.
 * An explicit /conv publishes its fence before it persists, so a message that
 * is already in flight must settle on the new workspace instead of resolving a
 * session in the one being left behind.
 */
async function awaitPendingConversationSwitch(harness, conversationKey) {
  if (typeof harness?.pendingConversationWorkspaceSwitch !== 'function') return;
  const pending = harness.pendingConversationWorkspaceSwitch(conversationKey);
  if (pending && typeof pending.then === 'function') await pending.catch(() => undefined);
}

function workspaceSession(harness, sessionId, conversationKey) {
  if (typeof harness.workspaceSession === 'function') {
    return conversationKey
      ? harness.workspaceSession(sessionId, conversationKey)
      : harness.workspaceSession(sessionId);
  }
  const session = {
    sessionId,
    sessionExists: (...args) => harness.sessionExists(sessionId, ...args),
    models: (...args) => harness.getSessionModels(sessionId, ...args),
    selectModel: (...args) => harness.selectSessionModel(sessionId, ...args),
    isRunning: (...args) => harness.isSessionRunning(sessionId, ...args),
    hasActiveTurn: (...args) => harness.hasActiveTurn(sessionId, ...args),
    stopActiveTurn: (...args) => harness.stopActiveTurn(sessionId, ...args),
    stopDeferredTurn: (...args) => harness.stopDeferredTurn?.(sessionId, ...args) ?? false,
    steerActiveTurn: (...args) => harness.steerActiveTurn(sessionId, ...args),
    ask: (...args) => harness.ask(sessionId, ...args),
  };
  if (typeof harness.renameSession === 'function') {
    session.renameTitle = (...args) => harness.renameSession(sessionId, ...args);
  }
  return Object.freeze(session);
}

async function sessionExists(session, options) {
  return options === undefined
    ? session.sessionExists()
    : session.sessionExists(options);
}

async function createSession(harness, options) {
  return options === undefined
    ? harness.createSession()
    : harness.createSession(options);
}

/**
 * Resolve, persist, and ask through a session that belongs to the bot's
 * current workspace. A concurrent workspace switch invalidates the scoped
 * session and retries before any prompt is sent to the stale session.
 *
 * `titleText` names the conversation title when the prompt itself is not the
 * user's own words -- a batch submission composes dsh-im's framing sentence and
 * message labels into one prompt, and only the collected text may name the
 * conversation.
 */
export async function askInWorkspaceSession({
  harness,
  state,
  key,
  text,
  content,
  titleText,
  contextEnhanced = false,
  createOptions,
  existsOptions,
  askOptions,
  deferredDelivery,
}) {
  const initialTitle = contextEnhanced
    ? initialSessionTitle({
        text: titleText ?? text,
        content,
        files: typeof askOptions === 'object' ? askOptions?.files : undefined,
      })
    : null;
  const renameSignal = createOptions?.signal
    ?? (typeof askOptions === 'object' ? askOptions?.signal : undefined);
  const renameOptions = renameSignal ? { signal: renameSignal } : undefined;
  while (true) {
    try {
      const binding = await withSessionBindingLock(state, key, async () => {
        await awaitPendingConversationSwitch(harness, key);
        let sessionId = state.sessionFor(key);
        let session = sessionId ? workspaceSession(harness, sessionId, key) : null;
        if (!session || !(await sessionExists(session, existsOptions))) {
          sessionId = await createSession(harness, {
            conversationKey: key,
            ...(createOptions ?? {}),
          });
          if (await state.setSession(key, sessionId) === false) return null;
          // Binding committed: capture the conversation's effective-workspace
          // generation together with the session, so the prompt below is fenced
          // against a conversation switch that only commits after the bind.
          const conversationGeneration = readConversationGeneration(harness, key);
          session = workspaceSession(harness, sessionId, key);
          if (initialTitle && typeof session.renameTitle === 'function') {
            try {
              await session.renameTitle(initialTitle, renameOptions);
            } catch (error) {
              if (error?.code === WORKSPACE_SESSION_STALE || renameOptions?.signal?.aborted) {
                throw error;
              }
              console.warn('[dsh-im] unable to set the initial Session title:', error?.message ?? error);
            }
          }
          // A switch that committed while the title was being set has already
          // cleared the mapping and must not receive this prompt.
          if (conversationGenerationMoved(harness, key, conversationGeneration)) {
            throw workspaceSessionStaleError();
          }
          return { sessionId, session };
        }
        return { sessionId, session };
      });
      if (!binding) continue;
      const artifacts = [];
      const originalOnArtifact = typeof askOptions === 'object'
        && typeof askOptions?.onArtifact === 'function'
        ? askOptions.onArtifact
        : null;
      const artifactOptions = typeof askOptions === 'number'
        ? { timeoutMs: askOptions }
        : { ...askOptions };
      artifactOptions.onArtifact = async (artifact) => {
        artifacts.push(artifact);
        await originalOnArtifact?.(artifact);
      };
      let answer;
      try {
        answer = await binding.session.ask(content ?? text, artifactOptions);
      } catch (error) {
        if (error?.code === 'harness-reply-timeout' && deferredDelivery) {
          try {
            const { coordinator, ...destination } = deferredDelivery();
            await coordinator.trackTimeout(error, { ...destination, key, sessionId: binding.sessionId });
          } catch (registrationError) {
            console.warn('[dsh-im] unable to persist deferred delivery:', registrationError.message);
          }
        }
        throw error;
      }
      return {
        sessionId: binding.sessionId,
        answer,
        ...(artifacts.length > 0 ? { artifacts } : {}),
      };
    } catch (error) {
      if (error?.code !== WORKSPACE_SESSION_STALE) throw error;
    }
  }
}
