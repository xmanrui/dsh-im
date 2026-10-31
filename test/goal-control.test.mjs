import assert from 'node:assert/strict';
import test from 'node:test';

import { createGoalControl } from '../plugin-src/host/goal-control.mjs';

const PAUSED = Object.freeze({ id: 'goal-1', revision: 2, phase: 'paused', activation: 'disarmed', roundsStarted: 3 });

function fixture({ goals = [], resumeError, resumeErrors = [], evolve = false, unavailable = false } = {}) {
  const lifetime = new AbortController();
  const calls = [];
  const peer = {
    principal: { kind: 'owner' },
    signal: lifetime.signal,
    dispose() { lifetime.abort(); },
  };
  let remaining = [...goals];
  let reads = 0;
  const ctx = {
    root: {},
    connection: { createPeer: () => peer },
    effect: () => () => {},
    typertGateway: {
      async invoke(request) {
        if (unavailable) {
          const error = new Error('typert gateway: goals/get: no such endpoint');
          error.name = 'TypertGatewayError';
          error.code = 'gateway/definition-unavailable';
          throw error;
        }
        assert.equal(request.namespace, 'goals');
        assert.equal(request.peer, peer);
        calls.push({ method: request.method, args: request.args });
        if (request.method === 'get') {
          reads += 1;
          // A live Host keeps mutating the goal: model that as a bumped
          // revision so the retry path can be exercised.
          if (evolve && reads > 1 && remaining[0]) {
            remaining = [{ ...remaining[0], revision: remaining[0].revision + 1 }];
          }
          return remaining[0];
        }
        if (request.method === 'resume') {
          const nextError = resumeErrors.length > 0 ? resumeErrors.shift() : resumeError;
          if (nextError) throw nextError;
          const view = { ...remaining[0], phase: 'active', activation: 'armed', revision: remaining[0].revision + 1 };
          remaining = [view];
          return view;
        }
        throw new Error(`unexpected ${request.method}`);
      },
    },
  };
  const control = createGoalControl(ctx, { logger: { debug() {}, info() {}, warn() {} } });
  return { control, calls, lifetime };
}

test('a paused goal is resumed with its current revision', async () => {
  const { control, calls } = fixture({ goals: [PAUSED] });
  const outcome = await control.resumeIfPaused('session-1');
  assert.equal(outcome.resumed, true);
  assert.deepEqual(calls, [
    { method: 'get', args: { agentId: 'session-1' } },
    { method: 'resume', args: { agentId: 'session-1', ref: { id: 'goal-1', revision: 2 } } },
  ]);
});

test('an active but disarmed goal (Host restart) is resumed too', async () => {
  const { control, calls } = fixture({ goals: [{ ...PAUSED, phase: 'active' }] });
  const outcome = await control.resumeIfPaused('session-1');
  assert.equal(outcome.resumed, true);
  assert.equal(calls.filter(call => call.method === 'resume').length, 1);
});

test('an armed goal, a blocked goal, and a missing goal are left alone', async () => {
  for (const goal of [
    { ...PAUSED, phase: 'active', activation: 'armed' },
    { ...PAUSED, phase: 'blocked' },
    { ...PAUSED, phase: 'complete' },
    undefined,
  ]) {
    const { control, calls } = fixture({ goals: [goal] });
    const outcome = await control.resumeIfPaused('session-1');
    assert.equal(outcome.resumed, false, `goal ${goal?.phase ?? 'missing'} must stay parked`);
    assert.equal(calls.filter(call => call.method === 'resume').length, 0);
  }
});

test('a lost revision race re-reads once and resumes the newer revision', async () => {
  const conflict = Object.assign(new Error('goal revision is stale'), { code: 'goal/stale-revision' });
  const { control, calls } = fixture({ goals: [PAUSED], resumeErrors: [conflict], evolve: true });
  const outcome = await control.resumeIfPaused('session-1');
  assert.equal(outcome.resumed, true);
  assert.deepEqual(calls.map(call => call.method), ['get', 'resume', 'get', 'resume']);
  assert.deepEqual(calls.at(-1).args.ref, { id: 'goal-1', revision: 3 });
});

test('a conflict that does not change the revision is reported, not retried forever', async () => {
  const conflict = Object.assign(new Error('goal revision is stale'), { code: 'goal/stale-revision' });
  const { control, calls } = fixture({ goals: [PAUSED], resumeError: conflict });
  await assert.rejects(() => control.resumeIfPaused('session-1'), /stale/);
  assert.deepEqual(calls.map(call => call.method), ['get', 'resume', 'get']);
});

test('a Host without goal endpoints disables control instead of failing every message', async () => {
  const { control, calls } = fixture({ unavailable: true });
  assert.equal((await control.resumeIfPaused('session-1')).resumed, false);
  assert.equal(await control.get('session-1'), undefined);
  assert.equal(calls.length, 0);
});
