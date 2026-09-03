import { withSessionBindingLock } from './session-binding-lock.mjs';
import { initialSessionTitle } from './session-title.mjs';

export const WORKSPACE_SESSION_STALE = 'workspace-session-stale';

function workspaceSession(harness, sessionId) {
  if (typeof harness.workspaceSession === 'function') {
    return harness.workspaceSession(sessionId);
  }
  const session = {
    sessionId,
    sessionExists: (...args) => harness.sessionExists(sessionId, ...args),
    models: (...args) => harness.getSessionModels(sessionId, ...args),
    selectModel: (...args) => harness.selectSessionModel(sessionId, ...args),
    isRunning: (...args) => harness.isSessionRunning(sessionId, ...args),
    hasActiveTurn: (...args) => harness.hasActiveTurn(sessionId, ...args),
    stopActiveTurn: (...args) => harness.stopActiveTurn(sessionId, ...args),
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
 */
/**
 * When a role store is present and the conversation has a role override, the
 * session binding is scoped to that role (`<key>:<presetId>`) and the role
 * preset is injected when creating a fresh session. Without an override this
 * is a no-op, keeping the default bot-preset behavior unchanged.
 */
function resolveRoleBinding(roleStore, botId, key, state) {
  if (!roleStore || !botId || typeof roleStore.overrideFor !== 'function') return null;
  const presetId = roleStore.overrideFor(botId, key);
  if (!presetId) return null;
  return { presetId, roleKey: `${key}:${presetId}` };
}

export async function askInWorkspaceSession({
  harness,
  state,
  key,
  text,
  content,
  contextEnhanced = false,
  createOptions,
  existsOptions,
  askOptions,
  roleStore,
  botId,
}) {
  const initialTitle = contextEnhanced
    ? initialSessionTitle({
        text,
        content,
        files: typeof askOptions === 'object' ? askOptions?.files : undefined,
      })
    : null;
  const renameSignal = createOptions?.signal
    ?? (typeof askOptions === 'object' ? askOptions?.signal : undefined);
  const renameOptions = renameSignal ? { signal: renameSignal } : undefined;
  const roleBinding = resolveRoleBinding(roleStore, botId, key, state);
  const bindKey = roleBinding?.roleKey ?? key;
  const scopedCreateOptions = roleBinding
    ? { ...createOptions, agentPreset: roleBinding.presetId }
    : createOptions;
  while (true) {
    try {
      const binding = await withSessionBindingLock(state, bindKey, async () => {
        let sessionId = state.sessionFor(bindKey);
        let session = sessionId ? workspaceSession(harness, sessionId) : null;
        if (!session || !(await sessionExists(session, existsOptions))) {
          sessionId = await createSession(harness, scopedCreateOptions);
          if (await state.setSession(bindKey, sessionId) === false) return null;
          session = workspaceSession(harness, sessionId);
          if (roleBinding && typeof roleStore?.setRoleSession === 'function') {
            try {
              await roleStore.setRoleSession(botId, key, roleBinding.presetId, sessionId);
            } catch (error) {
              // Persisting the role session is best-effort; a failure here must
              // not break the active prompt.
              console.warn('[dsh-im] unable to persist role session:', error?.message ?? error);
            }
          }
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
      const answer = await binding.session.ask(content ?? text, artifactOptions);
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
