import test from 'node:test';
import assert from 'node:assert/strict';
import { HarnessClient } from '../src/channels/shared/harness-client.mjs';
import { createHarnessSessionExecutors } from '../plugin-src/host/harness-session-coordinator.mjs';

test('deferred stop checks the exact live prompt and turn at execution, without RPC fallback', () => {
  const calls = [];
  const agent = { status: 'running', cancel: (...args) => calls.push(args), session: { events: [
    { type: 'turn/start', data: { turn: 3 } },
    { type: 'user/message', data: { source: { rpcId: 'owned' } } },
  ] } };
  const { controlExecutor } = createHarnessSessionExecutors({ get: () => ({ get: () => agent }) });
  const harness = new HarnessClient({ apiProxy: {}, controlExecutor });
  harness.rpc = () => { throw new Error('must not cancel a session through RPC'); };
  assert.equal(harness.stopDeferredTurn('s', { turn: 3, promptRpcId: 'foreign' }), false);
  assert.equal(harness.stopDeferredTurn('s', { turn: 3, promptRpcId: 'owned' }, { isCurrent: () => false }), false);
  assert.equal(harness.stopDeferredTurn('s', { turn: 3, promptRpcId: 'owned' }), true);
  agent.session.events.push(
    { type: 'turn/end', data: { turn: 3 } },
    { type: 'turn/start', data: { turn: 4 } },
    { type: 'user/message', data: { source: { rpcId: 'desktop' } } },
  );
  assert.equal(harness.stopDeferredTurn('s', { turn: 3, promptRpcId: 'owned' }), false);
  assert.equal(calls.length, 1);
  const remote = new HarnessClient({ baseUrl: 'http://127.0.0.1:1234', controlExecutor: () => undefined });
  remote.rpc = harness.rpc;
  assert.equal(remote.stopDeferredTurn('s', { turn: 3, promptRpcId: 'owned' }), false);
});
