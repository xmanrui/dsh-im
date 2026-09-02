import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBotWorkspaceScope } from '../../../src/channels/shared/bot-workspace-store.mjs';
import {
  HarnessClient,
  HarnessTurnError,
} from '../../../src/channels/shared/harness-client.mjs';
import {
  OUTBOUND_ARTIFACT_TOOL,
  createOutboundArtifactTool,
  outboundArtifactRegistry,
} from '../../../src/channels/shared/semantic/artifact.mjs';
import { WORKSPACE_SESSION_STALE } from '../../../src/channels/shared/workspace-session.mjs';

const CATALOG = {
  groups: [{
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [{ id: 'deepseek-v4', name: 'DeepSeek V4' }],
  }],
  failures: [],
};

function deferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => { resolve = promiseResolve; });
  return { promise, resolve };
}

function modelClient(options = {}) {
  const calls = [];
  const responses = new Map([
    ['llm.models', CATALOG],
    ['session.models', {
      ...CATALOG,
      current: { provider: 'deepseek-official', model: 'deepseek-v4' },
      routable: true,
    }],
    ['session.selectModel', {
      selected: { provider: 'deepseek-official', model: 'deepseek-v4' },
    }],
    ['session.list', {
      items: [
        { sessionId: 'session-one', running: true },
        { sessionId: 'session-two', running: false },
      ],
    }],
  ]);
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3981',
    workspace: '/tmp/workspace',
    ...options,
  });
  client.ensureRunning = async (options) => calls.push(['ensureRunning', options]);
  client.rpc = async (method, payload, timeoutMs, options) => {
    calls.push(['rpc', method, payload, timeoutMs, options]);
    return responses.get(method);
  };
  return { calls, client, responses };
}

test('HarnessClient exposes and validates model and run-state RPCs', async () => {
  const { calls, client } = modelClient();
  const signal = new AbortController().signal;
  const options = { signal };

  assert.equal(await client.listModels(options), CATALOG);
  assert.deepEqual((await client.getSessionModels('session-one', options)).current, {
    provider: 'deepseek-official', model: 'deepseek-v4',
  });
  assert.deepEqual(await client.selectSessionModel('session-one', {
    provider: 'deepseek-official', model: 'deepseek-v4',
  }, options), {
    selected: { provider: 'deepseek-official', model: 'deepseek-v4' },
  });
  assert.equal(await client.isSessionRunning('session-one', options), true);
  assert.equal(await client.isSessionRunning('missing', options), false);

  assert.deepEqual(calls.filter(([type]) => type === 'rpc').map(([, method, payload]) => (
    [method, payload]
  )), [
    ['llm.models', {}],
    ['session.models', { sessionId: 'session-one' }],
    ['session.selectModel', {
      sessionId: 'session-one',
      provider: 'deepseek-official',
      model: 'deepseek-v4',
    }],
    ['session.list', {}],
    ['session.list', {}],
  ]);
  assert.ok(calls.filter(([type]) => type === 'ensureRunning').every(([, value]) => value === options));
});

test('HarnessClient preserves reasoning metadata and forwards an optional reasoning effort', async () => {
  const { calls, client, responses } = modelClient();
  const reasoningCatalog = {
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{
        id: 'deepseek-v4',
        name: 'DeepSeek V4',
        description: 'Reasoning model',
        reasoning: {
          efforts: [
            { id: 'off', name: 'Off' },
            { id: 'high', name: 'High', description: 'More thinking' },
          ],
          defaultEffort: 'high',
        },
      }],
    }],
    failures: [],
  };
  responses.set('llm.models', reasoningCatalog);
  responses.set('session.models', {
    ...reasoningCatalog,
    current: {
      provider: 'deepseek-official',
      model: 'deepseek-v4',
      reasoningEffort: 'high',
    },
    routable: true,
  });
  responses.set('session.selectModel', {
    selected: {
      provider: 'deepseek-official',
      model: 'deepseek-v4',
      reasoningEffort: 'off',
    },
  });

  assert.equal((await client.listModels()).groups[0].models[0].reasoning.defaultEffort, 'high');
  assert.equal((await client.getSessionModels('session-one')).current.reasoningEffort, 'high');
  await client.selectSessionModel('session-one', {
    provider: 'deepseek-official',
    model: 'deepseek-v4',
    reasoningEffort: 'off',
  });

  assert.deepEqual(
    calls.find((entry) => entry[0] === 'rpc' && entry[1] === 'session.selectModel')?.[2],
    {
      sessionId: 'session-one',
      provider: 'deepseek-official',
      model: 'deepseek-v4',
      reasoningEffort: 'off',
    },
  );
});

test('HarnessClient rejects malformed model and run-state responses', async () => {
  const { client, responses } = modelClient();
  responses.set('llm.models', { groups: null, failures: [] });
  await assert.rejects(client.listModels(), /invalid response for llm\.models/);

  responses.set('llm.models', {
    ...CATALOG,
    groups: [{
      ...CATALOG.groups[0],
      models: [{
        ...CATALOG.groups[0].models[0],
        reasoning: { efforts: [] },
      }],
    }],
  });
  await assert.rejects(client.listModels(), /invalid response for llm\.models/);

  responses.set('session.models', {
    ...CATALOG,
    current: { provider: 'deepseek-official' },
    routable: true,
  });
  await assert.rejects(
    client.getSessionModels('session-one'),
    /invalid response for session\.models/,
  );

  responses.set('session.models', {
    ...CATALOG,
    current: {
      provider: 'deepseek-official',
      model: 'deepseek-v4',
      reasoningEffort: '',
    },
    routable: true,
  });
  await assert.rejects(
    client.getSessionModels('session-one'),
    /invalid response for session\.models/,
  );

  responses.set('session.selectModel', { selected: { provider: '', model: 'bad' } });
  await assert.rejects(
    client.selectSessionModel('session-one', { provider: 'p', model: 'm' }),
    /invalid response for session\.selectModel/,
  );

  await assert.rejects(
    client.selectSessionModel('session-one', {
      provider: 'deepseek-official',
      model: 'deepseek-v4',
      reasoningEffort: '',
    }),
    /provider and model are required/,
  );

  responses.set('session.list', { items: [{ sessionId: 'session-one', running: 'yes' }] });
  await assert.rejects(client.isSessionRunning('session-one'), /invalid response for session\.list/);
});

test('selectSessionModel holds the maintenance executor across its RPC', async () => {
  const maintenanceController = new AbortController();
  const stages = [];
  const { calls, client } = modelClient({
    sessionMaintenanceExecutor({ sessionId, operation }) {
      stages.push(['maintenance', sessionId]);
      const result = operation(maintenanceController.signal);
      stages.push(['operation-started']);
      return result;
    },
  });
  const callerController = new AbortController();
  await client.selectSessionModel('session-one', {
    provider: 'deepseek-official', model: 'deepseek-v4',
  }, { signal: callerController.signal });

  assert.deepEqual(stages, [
    ['maintenance', 'session-one'],
    ['operation-started'],
  ]);
  const rpcOptions = calls.find((entry) => entry[0] === 'rpc' && entry[1] === 'session.selectModel')[4];
  assert.notEqual(rpcOptions.signal, callerController.signal);
  assert.equal(rpcOptions.signal.aborted, false);
  maintenanceController.abort();
  assert.equal(rpcOptions.signal.aborted, true, 'maintenance cancellation must abort the RPC');
});

function controlledTurn({ sessionId, initialEnd = false, controlExecutor } = {}) {
  const id = sessionId ?? `session-${Math.random()}`;
  const calls = [];
  const admitted = deferred();
  let promptRpcId = null;
  let ended = initialEnd;
  let answer = initialEnd ? 'already complete' : '';
  let endReason = initialEnd ? 'completed' : null;
  let historyFailure = null;
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3982',
    workspace: '/tmp/workspace',
    ...(controlExecutor ? { controlExecutor } : {}),
  });
  client.ensureRunning = async () => true;
  const history = () => {
    if (!promptRpcId) return { events: [] };
    const events = [
      { event: { seq: 1, type: 'turn/start', data: { turn: 7 } } },
      { event: {
        seq: 2,
        type: 'user/message',
        data: { turn: 7, source: { rpcId: promptRpcId } },
      } },
    ];
    if (answer) {
      events.push({ event: {
        seq: 3,
        type: 'assistant/message',
        data: {
          turn: 7,
          message: { content: [{ type: 'text', text: answer }] },
        },
      } });
    }
    if (ended) {
      events.push({ event: {
        seq: 4,
        type: 'turn/end',
        data: { turn: 7, reason: endReason },
      } });
    }
    return { events };
  };
  client.rpc = async (method, payload, _timeoutMs, options) => {
    calls.push({ method, payload, options });
    if (method === 'session.history') {
      if (historyFailure) throw historyFailure;
      return history();
    }
    if (method === 'session.prompt' && payload.mode === 'queue') {
      promptRpcId = options.rpcId;
      admitted.resolve();
      return {};
    }
    if (method === 'session.prompt' && payload.mode === 'steer') return {};
    if (method === 'session.cancel') return {};
    throw new Error(`Unexpected RPC ${method}`);
  };
  return {
    id,
    calls,
    client,
    admitted: admitted.promise,
    promptRpcId: () => promptRpcId,
    setText(text) { answer = text; },
    failHistory(error = new Error('history unavailable')) { historyFailure = error; },
    finish({ text = '', reason = 'cancelled' } = {}) {
      answer = text;
      endReason = reason;
      ended = true;
    },
  };
}

test('HarnessClient preserves structured turn failures for channel classification', async () => {
  for (const [reason, expectedCode, expectedProviderCode] of [
    [{ kind: 'error', error: { code: 'RATE_LIMIT', message: 'private provider detail' } },
      'harness-turn-failed', 'RATE_LIMIT'],
    [{ kind: 'max-tokens' }, 'model-max-tokens', undefined],
    [{ kind: 'completed' }, 'model-empty-response', undefined],
    ['completed', 'model-empty-response', undefined],
    ['stopped', 'turn-interrupted', undefined],
  ]) {
    const turn = controlledTurn();
    const asking = turn.client.ask(turn.id, 'work', { timeoutMs: 2_000 });
    await turn.admitted;
    turn.finish({ reason });
    await assert.rejects(asking, (error) => {
      assert.ok(error instanceof HarnessTurnError);
      assert.equal(error.code, expectedCode);
      assert.equal(error.providerCode, expectedProviderCode);
      assert.equal(error.promptAccepted, true);
      assert.doesNotMatch(error.message, /private provider detail/);
      return true;
    });
  }
});

test('HarnessClient does not treat partial text from a failed turn as success', async () => {
  for (const [reason, expectedCode, expectedProviderCode] of [
    [{ kind: 'error', error: { code: 'RATE_LIMIT' } },
      'harness-turn-failed', 'RATE_LIMIT'],
    [{ kind: 'error', error: { code: 'CONTENT_FILTER' } },
      'harness-turn-failed', 'CONTENT_FILTER'],
    [{ kind: 'max-tokens' }, 'model-max-tokens', undefined],
    [{ kind: 'blocked' }, 'turn-blocked', undefined],
    ['interrupted', 'turn-interrupted', undefined],
    ['stopped', 'turn-interrupted', undefined],
    ['cancelled', 'turn-interrupted', undefined],
    ['aborted', 'turn-aborted', undefined],
  ]) {
    const turn = controlledTurn();
    const asking = turn.client.ask(turn.id, 'work', { timeoutMs: 2_000 });
    await turn.admitted;
    turn.finish({ text: 'partial result must not escape', reason });
    await assert.rejects(asking, (error) => {
      assert.ok(error instanceof HarnessTurnError);
      assert.equal(error.code, expectedCode);
      assert.equal(error.providerCode, expectedProviderCode);
      return true;
    });
  }
});

test('HarnessClient accepts partial text only for completed or omitted end reasons', async () => {
  for (const reason of ['completed', { kind: 'completed' }, null]) {
    const turn = controlledTurn();
    const asking = turn.client.ask(turn.id, 'work', { timeoutMs: 2_000 });
    await turn.admitted;
    turn.finish({ text: 'valid partial result', reason });
    assert.equal(await asking, 'valid partial result');
  }
});

test('HarnessClient marks a reply timeout after prompt admission', async () => {
  const turn = controlledTurn();
  const asking = turn.client.ask(turn.id, 'work', { timeoutMs: 1 });
  await turn.admitted;
  await assert.rejects(asking, (error) => {
    assert.ok(error instanceof HarnessTurnError);
    assert.equal(error.code, 'harness-reply-timeout');
    assert.equal(error.promptAccepted, true);
    return true;
  });
});

test('HarnessClient defers a reply timeout with a delivery handle when asked', async () => {
  const turn = controlledTurn();
  const owner = {};
  const control = { owner, key: 'direct:defer' };
  const asking = turn.client.ask(turn.id, 'work', {
    timeoutMs: 1_500,
    deferOnTimeout: true,
    control,
  });
  await turn.admitted;
  const handle = await asking;
  assert.equal(handle.deferred, true);
  assert.equal(handle.sessionId, turn.id);
  assert.equal(typeof handle.turn, 'number');
  assert.equal(typeof handle.promptRpcId, 'string');
  assert.equal(typeof handle.afterSeq, 'number');
  assert.equal(typeof handle.releaseOwnership, 'function');
  // Ownership 在交接后保留，/stop 语义不丢失。
  assert.equal(await turn.client.hasActiveTurn(turn.id, control), true);
  handle.releaseOwnership();
  assert.equal(await turn.client.hasActiveTurn(turn.id, control), false);
});

test('HarnessClient keeps throwing reply timeouts without deferOnTimeout', async () => {
  const turn = controlledTurn();
  const asking = turn.client.ask(turn.id, 'work', { timeoutMs: 1_500 });
  await turn.admitted;
  await assert.rejects(asking, (error) => {
    assert.ok(error instanceof HarnessTurnError);
    assert.equal(error.code, 'harness-reply-timeout');
    assert.equal(error.promptAccepted, true);
    return true;
  });
});

test('control methods require exact owner identity, key, and Session before any RPC', async () => {
  const turn = controlledTurn();
  const owner = {};
  const control = { owner, key: 'direct:one' };
  const asking = turn.client.ask(turn.id, 'work', { control, timeoutMs: 2_000 });
  void asking.catch(() => undefined);
  await turn.admitted;

  for (const wrong of [
    { owner: {}, key: 'direct:one' },
    { owner, key: 'direct:two' },
    null,
  ]) {
    const before = turn.calls.length;
    assert.equal(await turn.client.hasActiveTurn(turn.id, wrong), false);
    assert.equal(await turn.client.stopActiveTurn(turn.id, wrong), false);
    assert.equal(await turn.client.steerActiveTurn(turn.id, 'do more', wrong), false);
    assert.equal(turn.calls.length, before, 'unowned controls must not observe or mutate Session');
  }
  const beforeOtherSession = turn.calls.length;
  assert.equal(await turn.client.stopActiveTurn('different-session', control), false);
  assert.equal(turn.calls.length, beforeOtherSession);

  assert.equal(await turn.client.hasActiveTurn(turn.id, control), true);
  assert.equal(await turn.client.stopActiveTurn(turn.id, control), true);
  const cancelCount = () => turn.calls.filter(({ method }) => method === 'session.cancel').length;
  assert.equal(cancelCount(), 1);
  assert.equal(await turn.client.stopActiveTurn(turn.id, control), true, 'stop is idempotent');
  assert.equal(cancelCount(), 1, 'an idempotent stop must not issue a second cancel RPC');

  turn.finish();
  await assert.rejects(asking, (error) => error?.code === 'turn-stopped');
  assert.deepEqual(
    turn.calls.find(({ method }) => method === 'session.cancel')?.payload,
    { sessionId: turn.id, keepInbox: true },
  );
});

test('a stopped turn returns partial text instead of a generic failure', async () => {
  const turn = controlledTurn();
  const control = { owner: {}, key: 'direct:partial' };
  const asking = turn.client.ask(turn.id, 'work', { control, timeoutMs: 2_000 });
  await turn.admitted;
  assert.equal(await turn.client.stopActiveTurn(turn.id, control), true);
  turn.finish({ text: 'partial result' });
  assert.equal(await asking, 'partial result');
});

test('an accepted stop preserves partial text but never hands off a registered artifact', async (t) => {
  outboundArtifactRegistry.clear();
  t.after(() => outboundArtifactRegistry.clear());
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-im-stopped-artifact-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const turn = controlledTurn({ sessionId: 'session-stopped-artifact' });
  const control = { owner: {}, key: 'direct:stopped-artifact' };
  const handedOff = [];
  const asking = turn.client.ask(turn.id, 'work', {
    control,
    timeoutMs: 2_000,
    onArtifact: async (artifact) => handedOff.push(artifact),
  });
  await turn.admitted;
  const agent = {
    session: {
      header: { id: turn.id, cwd: workspace },
      events: [
        { type: 'turn/start', data: { turn: 7 } },
        {
          type: 'user/message',
          data: { turn: 7, source: { rpcId: turn.promptRpcId() } },
        },
      ],
    },
  };
  await writeFile(join(workspace, 'must-not-send.txt'), 'cancelled result');
  const tool = createOutboundArtifactTool({ registry: outboundArtifactRegistry });
  const exec = {
    name: OUTBOUND_ARTIFACT_TOOL,
    callId: 'stopped-artifact-call',
    rootCallId: 'stopped-artifact-call',
    token: Symbol('stopped-artifact-call'),
    agent,
  };
  await tool.definition.execute({ path: 'must-not-send.txt' }, exec);
  tool.onResult(exec, { isError: false });

  assert.equal(await turn.client.stopActiveTurn(turn.id, control), true);
  turn.finish({ text: 'partial result', reason: 'stopped' });
  assert.equal(await asking, 'partial result');
  assert.deepEqual(handedOff, []);
  assert.deepEqual(outboundArtifactRegistry.take(turn.id, 7), []);
});

test('an accepted stop also discards a file-only result instead of handing it off', async (t) => {
  outboundArtifactRegistry.clear();
  t.after(() => outboundArtifactRegistry.clear());
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-im-stopped-file-only-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const turn = controlledTurn({ sessionId: 'session-stopped-file-only' });
  const control = { owner: {}, key: 'direct:stopped-file-only' };
  const handedOff = [];
  const asking = turn.client.ask(turn.id, 'work', {
    control,
    timeoutMs: 2_000,
    onArtifact: async (artifact) => handedOff.push(artifact),
  });
  await turn.admitted;
  const agent = {
    session: {
      header: { id: turn.id, cwd: workspace },
      events: [
        { type: 'turn/start', data: { turn: 7 } },
        {
          type: 'user/message',
          data: { turn: 7, source: { rpcId: turn.promptRpcId() } },
        },
      ],
    },
  };
  await writeFile(join(workspace, 'must-not-send.txt'), 'cancelled file-only result');
  const tool = createOutboundArtifactTool({ registry: outboundArtifactRegistry });
  const exec = {
    name: OUTBOUND_ARTIFACT_TOOL,
    callId: 'stopped-file-only-call',
    rootCallId: 'stopped-file-only-call',
    token: Symbol('stopped-file-only-call'),
    agent,
  };
  await tool.definition.execute({ path: 'must-not-send.txt' }, exec);
  tool.onResult(exec, { isError: false });

  assert.equal(await turn.client.stopActiveTurn(turn.id, control), true);
  turn.finish({ reason: 'stopped' });
  await assert.rejects(asking, (error) => error?.code === 'turn-stopped');
  assert.deepEqual(handedOff, []);
  assert.deepEqual(outboundArtifactRegistry.take(turn.id, 7), []);
});

test('accepted stop converts later polling failures to turn-stopped and preserves streamed text', async () => {
  const withoutText = controlledTurn();
  const firstControl = { owner: {}, key: 'direct:poll-error' };
  const firstAsk = withoutText.client.ask(withoutText.id, 'work', {
    control: firstControl, timeoutMs: 2_000,
  });
  await withoutText.admitted;
  assert.equal(await withoutText.client.stopActiveTurn(withoutText.id, firstControl), true);
  withoutText.failHistory();
  await assert.rejects(firstAsk, (error) => error?.code === 'turn-stopped');

  const withText = controlledTurn();
  const secondControl = { owner: {}, key: 'direct:partial-poll-error' };
  const updateSeen = deferred();
  const secondAsk = withText.client.ask(withText.id, 'work', {
    control: secondControl,
    timeoutMs: 2_000,
    onUpdate(update) {
      if (update.type === 'text') updateSeen.resolve();
    },
  });
  await withText.admitted;
  withText.setText('partial before transport failure');
  await updateSeen.promise;
  assert.equal(await withText.client.stopActiveTurn(withText.id, secondControl), true);
  withText.failHistory();
  assert.equal(await secondAsk, 'partial before transport failure');
});

test('in-process control executor receives exact ownership and suppresses control RPCs', async () => {
  const executions = [];
  const turn = controlledTurn({
    controlExecutor(request) {
      executions.push(request);
      return true;
    },
  });
  const control = { owner: {}, key: 'direct:executor' };
  const asking = turn.client.ask(turn.id, 'work', { control, timeoutMs: 2_000 });
  await turn.admitted;

  assert.equal(await turn.client.steerActiveTurn(turn.id, 'stay in this turn', control), true);
  assert.equal(await turn.client.stopActiveTurn(turn.id, control), true);
  assert.deepEqual(executions.map(({ sessionId, expectedTurn, action, text }) => ({
    sessionId, expectedTurn, action, text,
  })), [
    { sessionId: turn.id, expectedTurn: 7, action: 'steer', text: 'stay in this turn' },
    { sessionId: turn.id, expectedTurn: 7, action: 'stop', text: undefined },
  ]);
  assert.ok(executions.every(({ promptRpcId }) => typeof promptRpcId === 'string' && promptRpcId));
  assert.equal(turn.calls.some(({ method, payload }) => (
    method === 'session.cancel' || (method === 'session.prompt' && payload.mode === 'steer')
  )), false);

  turn.finish();
  await assert.rejects(asking, (error) => error?.code === 'turn-stopped');
});

test('a refused in-process control action never falls through to HTTP', async () => {
  const turn = controlledTurn({ controlExecutor: () => false });
  const control = { owner: {}, key: 'direct:executor-race' };
  const asking = turn.client.ask(turn.id, 'work', { control, timeoutMs: 2_000 });
  await turn.admitted;
  assert.equal(await turn.client.steerActiveTurn(turn.id, 'must not wake', control), false);
  assert.equal(await turn.client.stopActiveTurn(turn.id, control), false);
  assert.equal(turn.calls.some(({ method, payload }) => (
    method === 'session.cancel' || (method === 'session.prompt' && payload.mode === 'steer')
  )), false);
  turn.finish({ text: 'normal completion', reason: 'completed' });
  assert.equal(await asking, 'normal completion');
});

test('steer uses mode steer only while the exact owned turn is still active', async () => {
  const turn = controlledTurn();
  const control = { owner: {}, key: 'direct:steer' };
  const asking = turn.client.ask(turn.id, 'work', { control, timeoutMs: 2_000 });
  await turn.admitted;

  assert.equal(await turn.client.steerActiveTurn(
    turn.id,
    'first line\nsecond line',
    control,
  ), true);
  const steer = turn.calls.find(({ method, payload }) => (
    method === 'session.prompt' && payload.mode === 'steer'
  ));
  assert.deepEqual(steer.payload, {
    sessionId: turn.id,
    mode: 'steer',
    content: [{ type: 'text', text: 'first line\nsecond line' }],
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  turn.finish({ text: 'done', reason: 'completed' });
  assert.equal(await asking, 'done');
});

test('steer refuses a turn that ended during its ownership refresh', async () => {
  const turn = controlledTurn({ initialEnd: true });
  const control = { owner: {}, key: 'direct:ended' };
  const asking = turn.client.ask(turn.id, 'work', { control, timeoutMs: 2_000 });
  await turn.admitted;

  assert.equal(await turn.client.steerActiveTurn(turn.id, 'must not wake', control), false);
  assert.equal(turn.calls.some(({ method, payload }) => (
    method === 'session.prompt' && payload.mode === 'steer'
  )), false);
  assert.equal(await asking, 'already complete');
});

function scopedHarnessFixture() {
  const calls = [];
  let generation = 1;
  let present = true;
  const workspaces = {
    incarnationFor() { return 'incarnation-one'; },
    has() { return present; },
    generationFor() { return generation; },
    workspaceFor() { return '/tmp/workspace'; },
  };
  const harness = {
    async listModels(...args) {
      calls.push(['listModels', ...args]);
      return CATALOG;
    },
    async getSessionModels(...args) {
      calls.push(['getSessionModels', ...args]);
      return { ...CATALOG, current: { provider: 'p', model: 'm' }, routable: true };
    },
    async selectSessionModel(...args) {
      calls.push(['selectSessionModel', ...args]);
      return { selected: args[1] };
    },
    async isSessionRunning(...args) {
      calls.push(['isSessionRunning', ...args]);
      return true;
    },
    async hasActiveTurn(...args) {
      calls.push(['hasActiveTurn', ...args]);
      return true;
    },
    async stopActiveTurn(...args) {
      calls.push(['stopActiveTurn', ...args]);
      return true;
    },
    async steerActiveTurn(...args) {
      calls.push(['steerActiveTurn', ...args]);
      return true;
    },
  };
  const scope = createBotWorkspaceScope(harness, {
    botId: 'bot-one', workspaces, state: {},
  });
  return {
    calls,
    harness,
    scope,
    advanceGeneration() { generation += 1; },
    removeBot() { present = false; },
  };
}

test('workspace session handles forward every model and control API through one generation fence', async () => {
  const fixture = scopedHarnessFixture();
  const session = fixture.scope.harness.workspaceSession('session-one');
  const signal = new AbortController().signal;
  const options = { signal };
  const control = { owner: {}, key: 'direct:one' };

  await session.models(options);
  await session.selectModel({ provider: 'p', model: 'm' }, options);
  assert.equal(await session.isRunning(options), true);
  assert.equal(await session.hasActiveTurn(control, options), true);
  assert.equal(await session.stopActiveTurn(control, options), true);
  assert.equal(await session.steerActiveTurn('more', control, options), true);
  assert.deepEqual(fixture.calls, [
    ['getSessionModels', 'session-one', options],
    ['selectSessionModel', 'session-one', { provider: 'p', model: 'm' }, options],
    ['isSessionRunning', 'session-one', options],
    ['hasActiveTurn', 'session-one', control, options],
    ['stopActiveTurn', 'session-one', control, options],
    ['steerActiveTurn', 'session-one', 'more', control, options],
  ]);

  const methods = [
    ['models', [options]],
    ['selectModel', [{ provider: 'p', model: 'm' }, options]],
    ['isRunning', [options]],
    ['hasActiveTurn', [control, options]],
    ['stopActiveTurn', [control, options]],
    ['steerActiveTurn', ['more', control, options]],
  ];
  for (const [method, args] of methods) {
    const stale = fixture.scope.harness.workspaceSession(`stale-${method}`);
    fixture.advanceGeneration();
    const before = fixture.calls.length;
    await assert.rejects(
      stale[method](...args),
      (error) => error?.code === WORKSPACE_SESSION_STALE,
      method,
    );
    assert.equal(fixture.calls.length, before, `${method} crossed a stale generation`);
  }
});

test('workspace session and listModels re-check their scope after an in-flight RPC', async () => {
  const fixture = scopedHarnessFixture();
  const modelGate = deferred();
  fixture.harness.getSessionModels = async () => modelGate.promise;
  const session = fixture.scope.harness.workspaceSession('session-race');
  const listing = session.models();
  fixture.advanceGeneration();
  modelGate.resolve({ ...CATALOG, current: { provider: 'p', model: 'm' }, routable: true });
  await assert.rejects(listing, (error) => error?.code === WORKSPACE_SESSION_STALE);

  const listGate = deferred();
  fixture.harness.listModels = async () => listGate.promise;
  const globalListing = fixture.scope.harness.listModels();
  fixture.removeBot();
  listGate.resolve(CATALOG);
  await assert.rejects(globalListing, (error) => error?.code === 'workspace-bot-not-found');
});
