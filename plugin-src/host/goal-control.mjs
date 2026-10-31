import { harnessPeer } from './harness-peer.mjs';

/**
 * Durable phases that mean "a goal is parked and a human turn can bring it
 * back". `paused` is an explicit human pause; `active` + `disarmed` is what a
 * Host restart leaves behind (continuation eligibility is process-local and is
 * dropped on `agent/created`), and the product UI shows both as 已暂停.
 */
const RESUMABLE = goal => goal?.phase === 'paused'
  || (goal?.phase === 'active' && goal?.activation === 'disarmed');

/** Gateway rejections that mean this Host cannot serve goal control at all. */
const UNAVAILABLE_CODES = new Set([
  'gateway/definition-unavailable',
  'gateway/service-unavailable',
  'gateway/endpoint-unavailable',
  'gateway/arguments-invalid',
]);

function unavailable(error) {
  return UNAVAILABLE_CODES.has(error?.code);
}

/**
 * Adapt the Host goal service (Typert `goals/*`) to what an IM channel needs:
 * read the current goal and bring a parked one back before the turn starts.
 *
 * Returns `undefined` when the Host exposes no Typert gateway; the channel then
 * keeps its previous behaviour instead of failing every inbound message.
 */
export function createGoalControl(ctx, { logger } = {}) {
  const gateway = ctx?.typertGateway;
  if (!gateway || typeof gateway.invoke !== 'function') return undefined;
  const peer = harnessPeer(ctx);
  let disabled = false;

  const invoke = async (method, args) => {
    if (disabled) return undefined;
    try {
      return await gateway.invoke({
        namespace: 'goals',
        method,
        args,
        ...(peer === undefined ? {} : { peer }),
      });
    } catch (error) {
      if (!unavailable(error)) throw error;
      // Older Hosts (or a Host with the goal service off) must not cost one
      // failed gateway call per inbound message.
      disabled = true;
      logger?.debug?.('[dsh-im] goal control unavailable on this Host:', error?.message ?? String(error));
      return undefined;
    }
  };

  const resume = (sessionId, goal) => invoke('resume', {
    agentId: sessionId,
    ref: { id: goal.id, revision: goal.revision },
  });

  return Object.freeze({
    /** Current goal view, or `undefined` when the session has none / cannot answer. */
    async get(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined;
      return invoke('get', { agentId: sessionId });
    },

    /**
     * Resume a parked goal before a human turn starts. Resolves to
     * `{ resumed, goal }`; never throws for a missing goal or a lost race.
     */
    async resumeIfPaused(sessionId) {
      let goal = await this.get(sessionId);
      if (!RESUMABLE(goal)) return { resumed: false, goal };
      try {
        return { resumed: true, goal: await resume(sessionId, goal) };
      } catch (error) {
        // Another mutation (a goal round admitting itself, the Web UI) can bump
        // the revision between read and resume. Re-read once and retry only if
        // the goal is still parked under a newer revision.
        const latest = await this.get(sessionId);
        if (!RESUMABLE(latest) || latest.revision === goal.revision) throw error;
        return { resumed: true, goal: await resume(sessionId, latest) };
      }
    },
  });
}
