/**
 * Name the model that produced a reply, when the operator asked for it.
 *
 * The lookup is deliberately best-effort: `session.models` is an RPC, and a
 * reply must never wait on — or fail because of — an annotation. Any problem
 * resolving the model resolves to null, and the answer goes out unchanged.
 */
import {
  modelAttributionLine,
  replyModelAttributionEnabled,
} from './reply-model-attribution.mjs';

/** Resolve the current model id for a session, or null when unavailable. */
export async function modelAttributionFor(harness, sessionId) {
  if (!replyModelAttributionEnabled()) return null;
  if (typeof harness?.getSessionModels !== 'function') return null;
  if (typeof sessionId !== 'string' || !sessionId) return null;
  try {
    const catalog = await harness.getSessionModels(sessionId);
    const current = catalog?.current;
    if (!current?.provider || !current?.model) return null;
    return `${current.provider}/${current.model}`;
  } catch {
    // Annotation only. A failed lookup must not change or block the reply.
    return null;
  }
}

/**
 * Append the model line to an answer. Returns the answer untouched when
 * attribution is off or the model could not be resolved.
 */
export function withModelAttribution(answer, modelId) {
  const line = modelAttributionLine(modelId);
  if (!line) return answer;
  if (typeof answer !== 'string' || !answer.trim()) return answer;
  return `${answer}\n\n${line}`;
}
