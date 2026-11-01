import { withSessionBindingLock } from './session-binding-lock.mjs';
import { initialSessionTitle } from './session-title.mjs';
import { extractConnectionEvidence, messageDiagnosticError } from './connection-error.mjs';
import { t } from './i18n.mjs';

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
 * A binding that can never serve another message, paired with the repair reason
 * reported to the user. Both codes mean the stored Session is intact but the
 * Harness refuses to use it, so the only way to answer this message is a new
 * Session -- never a silent rewrite of the old one.
 */
const REPAIRABLE_BINDING_LOSS = Object.freeze({
  'session-unreadable': 'corrupt',
  'session-archived': 'archived',
});

/**
 * Decide whether this failure may replace the binding and replay once.
 *
 * Every guard is a reason not to replay: a DS Bot owns its Session, an alternate
 * Harness may not be able to create one, one replacement per message is enough,
 * and any failure that might already be queued in the Session (an accepted
 * prompt, an unknown submission state) must surface instead of being duplicated.
 */
function repairableBindingLoss(error, failure, {
  alreadyReplaced, canCreate, dsBotSession, signal, existsSignal,
}) {
  const reason = REPAIRABLE_BINDING_LOSS[error?.code];
  if (!reason) return null;
  if (alreadyReplaced || !canCreate || dsBotSession) return null;
  if (signal?.aborted || existsSignal?.aborted) return null;
  if (extractConnectionEvidence(failure).details.submissionState !== 'not-submitted') return null;
  // The archive guard can fire after DSH accepted the prompt and the turn was
  // then stopped by the archive; replaying that would submit a second copy.
  if (reason === 'archived' && error?.promptAccepted === true) return null;
  return reason;
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
 *
 * `sourceGuidance` is the guidance the channel's captured enhancement settings
 * applied, carried to the Host out of band so it can materialize it as session
 * prompt context. It is never re-derived from the prompt, which also carries
 * whatever the user typed.
 */
export async function askInWorkspaceSession({
  harness,
  state,
  key,
  text,
  content,
  prepareContent,
  titleText,
  sourceGuidance,
  contextEnhanced = false,
  createOptions,
  existsOptions,
  askOptions,
  deferredDelivery,
  onNotice,
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
  // One-shot binding repair. `replacedSessionId` is the Session this message
  // was first tried against and `replacementReason` says why it had to go.
  // At most one replacement per message: a Harness that keeps failing must not
  // spawn one new Session per retry.
  let replacedSessionId;
  let replacementReason;
  const canCreateSession = typeof harness?.createSession === 'function';
  while (true) {
    const diagnostic = { stage: 'session.prepare', submissionState: 'not-submitted' };
    let dsBotSession = false;
    try {
      const binding = await withSessionBindingLock(state, key, async () => {
        await awaitPendingConversationSwitch(harness, key);
        const dsBotSessionId = await harness.resolveDsBotSession?.(key);
        dsBotSession = Boolean(dsBotSessionId);
        let sessionId = dsBotSessionId || state.sessionFor(key);
        diagnostic.sessionId = sessionId;
        let session = sessionId ? workspaceSession(harness, sessionId, key) : null;
        const replacingStale = Boolean(sessionId) && sessionId === replacedSessionId;
        if (!session || replacingStale || !(await sessionExists(session, existsOptions))) {
          if (dsBotSessionId) {
            throw Object.assign(new Error('DS Bot 的当前会话不可用。'), { code: 'ds-bot-unavailable' });
          }
          sessionId = await createSession(harness, {
            conversationKey: key,
            ...(createOptions ?? {}),
          });
          diagnostic.sessionId = sessionId;
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
          return { sessionId, session, recovered: replacingStale ? replacementReason : null };
        }
        return { sessionId, session };
      });
      if (!binding) continue;
      diagnostic.sessionId = binding.sessionId;
      if (binding.recovered === 'corrupt') {
        await onNotice?.(t('绑定会话的日志已损坏，已切换到新会话并继续处理本条消息。原会话记录已保留，历史上下文不会自动带入。'));
      } else if (binding.recovered === 'archived') {
        await onNotice?.(t('绑定的会话已在 DSH 中归档，已自动切换到新会话继续处理本条消息。原会话记录已保留，历史上下文不会自动带入。'));
      }
      diagnostic.stage = 'prompt.prepare';
      const artifacts = [];
      const originalOnArtifact = typeof askOptions === 'object'
        && typeof askOptions?.onArtifact === 'function'
        ? askOptions.onArtifact
        : null;
      const artifactOptions = typeof askOptions === 'number'
        ? { timeoutMs: askOptions }
        : { ...askOptions };
      // The guidance the channel's captured settings applied, carried out of
      // band so the Host never has to read configuration out of the prompt.
      artifactOptions.sourceGuidance = sourceGuidance;
      artifactOptions.onArtifact = async (artifact) => {
        artifacts.push(artifact);
        await originalOnArtifact?.(artifact);
      };
      let answer;
      // Prepare session-dependent context after binding, outside the binding
      // lock. A stale-workspace retry must prepare it for the new session too.
      const prompt = prepareContent
        ? await prepareContent({ sessionId: binding.sessionId, content, text })
        : content ?? text;
      try {
        // An alternate Harness adapter may not supply finer ask() diagnostics.
        diagnostic.stage = 'operation';
        diagnostic.submissionState = 'unknown';
        answer = await binding.session.ask(prompt, artifactOptions);
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
      const failure = messageDiagnosticError(error, diagnostic);
      // Retry once, only with positive evidence that no prompt was submitted.
      // The binding lock rechecks identity so a concurrent /new or workspace
      // switch cannot be overwritten by recovery of the previous Session.
      const repair = repairableBindingLoss(error, failure, {
        alreadyReplaced: replacedSessionId !== undefined,
        canCreate: canCreateSession,
        dsBotSession,
        signal: renameSignal,
        existsSignal: existsOptions?.signal,
      });
      if (repair && diagnostic.sessionId) {
        replacedSessionId = diagnostic.sessionId;
        replacementReason = repair;
        continue;
      }
      if (error?.code !== WORKSPACE_SESSION_STALE) throw failure;
    }
  }
}
