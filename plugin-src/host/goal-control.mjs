import { harnessPeer } from './harness-peer.mjs';

/**
 * Parked goal states an inbound message may bring back. The product UI shows
 * both as 已暂停, and DSH writes `paused` for an aborted round as well as for
 * the pause button, so a channel cannot tell the two apart afterwards: leaving
 * `paused` alone would leave the goal that just lost its round parked for good.
 * Channels that only want restart leftovers set `resumePaused: false`.
 */
const resumableGoal = (goal, resumePaused) => (goal?.phase === 'active' && goal?.activation === 'disarmed')
  || (resumePaused !== false && goal?.phase === 'paused');

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
export function createGoalControl(ctx, { logger, resumePaused = true } = {}) {
  const resumable = goal => resumableGoal(goal, resumePaused);
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
      const goal = await this.get(sessionId);
      if (!resumable(goal)) return { resumed: false, goal };
      try {
        const resumed = await resume(sessionId, goal);
        // The gateway answers `undefined` when this Host turned out not to
        // serve goal control after all: the goal did not move, so do not
        // report a success the caller would announce to the user.
        return resumed === undefined ? { resumed: false, goal } : { resumed: true, goal: resumed };
      } catch (error) {
        // Another mutation (a goal round admitting itself, the Web UI) can bump
        // the revision between read and resume. Re-read once and retry only if
        // the goal is still parked under a newer revision.
        const latest = await this.get(sessionId);
        if (!resumable(latest) || latest.revision === goal.revision) throw error;
        const resumed = await resume(sessionId, latest);
        return resumed === undefined ? { resumed: false, goal: latest } : { resumed: true, goal: resumed };
      }
    },
  });
}
