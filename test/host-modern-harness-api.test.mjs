import assert from 'node:assert/strict';
import test from 'node:test';

import { harnessConnection } from '../plugin-src/host/harness-connection.mjs';
import { modernHarnessApi } from '../plugin-src/host/modern-harness-api.mjs';
import { HarnessClient, HarnessRpcError } from '../src/channels/shared/harness-client.mjs';
import { classifyMessageFailure } from '../src/channels/shared/message-failure.mjs';

function asyncValues(...values) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* values;
    },
  };
}

function fakeContext(gateway) {
  const listeners = new Map();
  const root = {};
  const ctx = {
    root,
    typertGateway: gateway,
    on(event, listener) {
      const entries = listeners.get(event) ?? [];
      entries.push(listener);
      listeners.set(event, entries);
      return () => {
        const index = entries.indexOf(listener);
        if (index >= 0) entries.splice(index, 1);
      };
    },
  };
  return {
    ctx,
    emit(event, ...args) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    },
    waterfall(event, request, next = () => Promise.resolve('delegated')) {
      const [listener] = listeners.get(event) ?? [];
      return listener ? listener(request, next) : next();
    },
  };
}

function sessionFixture(api, id = 'session') {
  const events = [];
  if (api === 'snapshotEvents') {
    return {
      events,
      session: {
        id,
        snapshotEvents: () => Object.freeze([...events]),
      },
    };
  }
  if (api === 'events') return { events, session: { id, events } };
  if (api === 'both') {
    return {
      events,
      session: {
        id,
        events: [],
        snapshotEvents: () => Object.freeze([...events]),
      },
    };
  }
  throw new TypeError(`unsupported Session API fixture: ${api}`);
}

function forEachSessionApi(interaction, run) {
  for (const sessionApi of ['snapshotEvents', 'events', 'both']) {
    test(
      `modern adapter routes ${interaction} through ${sessionApi} only to the active dsh-im turn`,
      () => run(sessionApi),
    );
  }
}

test('modern adapter maps the narrow legacy API without changing HarnessClient', async () => {
  const calls = [];
  let pageCalls = 0;
  const catalog = {
    default: { provider: 'deepseek', model: 'chat' },
    routableProviders: ['deepseek'],
    groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat' }] }],
    failures: [],
  };
  const gateway = {
    async invoke(request) {
      calls.push(request);
      const endpoint = `${request.namespace}/${request.method}`;
      if (endpoint === 'workspace/create') {
        return { workspace: { workspaceId: 'workspace', path: request.args.request.path }, created: true };
      }
      if (endpoint === 'session/list') {
        return {
          items: [{
            sessionId: 'session', running: false, blank: false,
            projections: {
              asOfSeq: 8,
              values: {
                modelSelection: {
                  lastUsed: { provider: 'deepseek', model: 'chat' },
                  next: null,
                },
              },
            },
          }],
        };
      }
      if (endpoint === 'session/modelCatalog') return catalog;
      if (endpoint === 'session/page') {
        pageCalls += 1;
        return {
          records: [{
            type: 'event',
            event: { type: 'turn/end', seq: 8, time: 8, data: { turn: 1, reason: { kind: 'completed' } } },
          }],
          hasMore: false,
        };
      }
      if (endpoint === 'session/prompt') return { accepted: true };
      if (endpoint === 'session/rename') {
        return { title: request.args.request.title, seq: 9 };
      }
      if (endpoint === 'session/cancel') return { accepted: true };
      if (endpoint === 'session/selectModel') return { selected: request.args.request };
      throw new Error(`unexpected invoke ${endpoint}`);
    },
    async stream(request) {
      calls.push(request);
      const endpoint = `${request.namespace}/${request.method}`;
      if (endpoint === 'workspace/follow') {
        return asyncValues({
          type: 'baseline',
          value: {
            items: [{ workspaceId: 'workspace', path: '/workspace', sessionIds: ['session'] }],
            archivedSessionIds: [],
          },
        });
      }
      if (endpoint === 'session/follow') {
        return asyncValues({
          type: 'snapshot',
          cursor: 7,
          records: [{
            type: 'chunks',
            event: {
              type: 'chunkrow/text-chunks',
              seq: 5,
              time: 100,
              data: { turn: 1, step: 0, index: 0, texts: ['a', 'b', 'c'], dt: [1, 2] },
            },
          }],
          hasMore: true,
          projections: { asOfSeq: 7, values: {} },
        });
      }
      throw new Error(`unexpected stream ${endpoint}`);
    },
  };
  const { ctx } = fakeContext(gateway);
  const first = harnessConnection(ctx);
  const second = harnessConnection(ctx);
  assert.equal(first.apiProxy, second.apiProxy);
  assert.equal(first.interactionScope, ctx.root);

  const workspace = await first.apiProxy.workspace.list({ rpcId: 'workspace-list', payload: {} });
  assert.equal(workspace.result.value.items[0].path, '/workspace');

  const history = await first.apiProxy.sessions.history({
    rpcId: 'history-one', payload: { sessionId: 'session', maxMessages: 50 },
  });
  assert.deepEqual(history.result.value.events.map(({ event }) => [
    event.seq, event.time, event.data.chunk.text,
  ]), [[5, 100, 'a'], [6, 101, 'b'], [7, 103, 'c']]);
  assert.equal(history.result.value.projections.asOfSeq, 7);

  const nextHistory = await first.apiProxy.sessions.history({
    rpcId: 'history-two', payload: { sessionId: 'session', maxMessages: 50 },
  });
  assert.equal(nextHistory.result.value.events[0].event.seq, 8);
  assert.equal(pageCalls, 1);

  const models = await first.apiProxy.sessions.models({
    rpcId: 'models', payload: { sessionId: 'session' },
  });
  assert.deepEqual(models.result.value.current, { provider: 'deepseek', model: 'chat' });
  assert.equal(models.result.value.routable, true);

  await first.apiProxy.sessions.prompt({
    rpcId: 'prompt-correlation',
    payload: { sessionId: 'session', mode: 'queue', content: [{ type: 'text', text: 'hi' }] },
  });
  const promptCall = calls.find((call) => call.namespace === 'session' && call.method === 'prompt');
  assert.equal(promptCall.args.request.requestId, 'prompt-correlation');
  assert.equal(Object.hasOwn(promptCall.args.request, 'rpcId'), false);

  const renamed = await first.apiProxy.sessions.rename({
    rpcId: 'rename-correlation',
    payload: { sessionId: 'session', title: '订单查询' },
  });
  assert.deepEqual(renamed.result.value, { title: '订单查询', seq: 9 });
  const renameCall = calls.find((call) => call.namespace === 'session' && call.method === 'rename');
  assert.deepEqual(renameCall.args, {
    request: { sessionId: 'session', title: '订单查询' },
  });
});

test('modern adapter preserves Typert business failures as Harness RPC errors', async () => {
  const gateway = {
    async invoke() {
      const error = new Error('missing');
      error.failure = {
        code: 'session-not-found',
        message: 'missing',
        details: { sessionId: 'missing' },
      };
      throw error;
    },
    async stream() { throw new Error('unused'); },
  };
  const { ctx } = fakeContext(gateway);
  const client = new HarnessClient({
    apiProxy: modernHarnessApi(ctx),
    interactionScope: ctx.root,
    workspace: '/workspace',
  });
  await assert.rejects(
    () => client.rpc('session.list'),
    (error) => error instanceof HarnessRpcError
      && error.code === 'session-not-found'
      && error.details.sessionId === 'missing',
  );
});

test('modern adapter preserves direct DSH RemoteErrors through message classification', async () => {
  const sourceError = Object.assign(new Error('preset "removed" not found'), {
    name: 'RemoteError',
    isDSHRemoteError: true,
    code: 'agent-preset/not-found',
    details: { agentPreset: 'removed', available: ['standard'] },
  });
  const { ctx } = fakeContext({
    async invoke() { throw sourceError; },
    async stream() { throw new Error('unused'); },
  });
  const client = new HarnessClient({ apiProxy: modernHarnessApi(ctx), workspace: '/workspace' });
  await assert.rejects(() => client.rpc('session.prompt', { sessionId: 'session', text: 'test' }), (error) => {
    assert.ok(error instanceof HarnessRpcError);
    assert.equal(error.code, sourceError.code);
    assert.deepEqual(error.details, sourceError.details);
    const failure = classifyMessageFailure(error);
    assert.equal(failure.code, 'PRESET_UNAVAILABLE');
    assert.equal(failure.reason, 'AGENT_PRESET_NOT_FOUND');
    return true;
  });
});

test('modern adapter keeps unmarked internal errors internal', async () => {
  const { ctx } = fakeContext({
    async invoke() { throw Object.assign(new Error('local error'), { code: 'agent-preset/not-found' }); },
    async stream() { throw new Error('unused'); },
  });
  const client = new HarnessClient({ apiProxy: modernHarnessApi(ctx), workspace: '/workspace' });
  await assert.rejects(() => client.rpc('session.prompt', { sessionId: 'session', text: 'test' }), {
    code: 'internal',
  });
});

test('modern adapter exposes DSH v2 live assistant chunks through legacy history', async () => {
  const records = [
    {
      type: 'event',
      event: { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    },
    {
      type: 'event',
      event: {
        type: 'user/message', seq: 1, time: 1,
        data: { turn: 1, source: { kind: 'user', rpcId: 'prompt' }, message: { content: [] } },
      },
    },
  ];
  const gateway = {
    async invoke(request) {
      if (`${request.namespace}/${request.method}` !== 'session/page') {
        throw new Error('unexpected invoke');
      }
      return { records, hasMore: false };
    },
    async stream(request) {
      if (`${request.namespace}/${request.method}` !== 'session/follow') {
        throw new Error('unexpected stream');
      }
      return asyncValues({
        type: 'snapshot', cursor: 1, records, hasMore: false,
        projections: { asOfSeq: 1, values: {} },
      });
    },
  };
  const fixture = fakeContext(gateway);
  const api = modernHarnessApi(fixture.ctx);

  await api.sessions.history({ rpcId: 'baseline', payload: { sessionId: 'session' } });
  const agent = { session: { id: 'session', seq: 2 } };
  fixture.emit('agent/assistant-stream', {
    agent,
    frame: {
      type: 'start', attemptId: 'session:1', revision: 1, turn: 1, step: 1,
    },
  });
  fixture.emit('agent/assistant-stream', {
    agent,
    frame: {
      type: 'chunk', attemptId: 'session:1', revision: 2, index: 0, time: 2,
      chunk: { type: 'text-delta', index: 0, text: '你好' },
    },
  });
  fixture.emit('agent/assistant-stream', {
    agent,
    frame: {
      type: 'chunk', attemptId: 'session:1', revision: 3, index: 1, time: 3,
      chunk: { type: 'text-delta', index: 0, text: '，世界' },
    },
  });

  const live = await api.sessions.history({
    rpcId: 'live', payload: { sessionId: 'session' },
  });
  const chunks = live.result.value.events.filter(
    ({ event }) => event.type === 'assistant/chunk',
  );
  assert.deepEqual(chunks.map(({ event }) => event.data.chunk.text), ['你好', '，世界']);
  assert.ok(chunks.every(({ event }) => event.seq > 1 && event.seq < 2));
  assert.ok(chunks[0].event.seq < chunks[1].event.seq);

  fixture.emit('agent/assistant-stream', {
    agent,
    frame: {
      type: 'end', attemptId: 'session:1', revision: 4, index: 2,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: 2 },
    },
  });
  const settled = await api.sessions.history({
    rpcId: 'settled', payload: { sessionId: 'session' },
  });
  assert.equal(settled.result.value.events.some(
    ({ event }) => event.type === 'assistant/chunk',
  ), false);
});

forEachSessionApi('an approval', async (sessionApi) => {
  const { events, session } = sessionFixture(sessionApi);
  const eventRecord = (event) => ({ type: 'event', event });
  let fixture;
  let turnTask;
  const append = (event) => {
    events.push(event);
    fixture.emit('session/event', session, event);
  };
  const gateway = {
    async invoke(request) {
      const endpoint = `${request.namespace}/${request.method}`;
      if (endpoint === 'session/page') {
        return { records: events.map(eventRecord), hasMore: false };
      }
      if (endpoint === 'session/prompt') {
        const rpcId = request.args.request.requestId;
        turnTask = (async () => {
          append({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } });
          append({
            type: 'user/message', seq: 1, time: 1,
            data: { turn: 1, source: { kind: 'user', rpcId }, message: { content: [] } },
          });
          append({
            type: 'approval/asked', seq: 2, time: 2,
            data: { id: 'approval-one', toolName: 'bash', callId: 'call-one' },
          });
          const outcome = await fixture.waterfall('approval/request', {
            agent: { id: 'session', session },
            toolName: 'bash',
            callId: 'call-one',
          }, () => Promise.resolve('unavailable'));
          append({
            type: 'approval/decided', seq: 3, time: 3,
            data: { id: 'approval-one', outcome },
          });
          append({
            type: 'assistant/message', seq: 4, time: 4,
            data: { turn: 1, message: { content: [{ type: 'text', text: 'approved' }] } },
          });
          append({
            type: 'turn/end', seq: 5, time: 5,
            data: { turn: 1, reason: { kind: 'completed' } },
          });
        })();
        return { accepted: true };
      }
      throw new Error(`unexpected invoke ${endpoint}`);
    },
    async stream(request) {
      if (`${request.namespace}/${request.method}` !== 'session/follow') {
        throw new Error('unexpected stream');
      }
      return asyncValues({
        type: 'snapshot', cursor: -1, records: [], hasMore: false,
        projections: { asOfSeq: -1, values: {} },
      });
    },
  };
  fixture = fakeContext(gateway);
  const connection = harnessConnection(fixture.ctx);
  const client = new HarnessClient({
    ...connection,
    workspace: '/workspace',
    rpcIdPrefix: 'modern-test',
    logPrefix: 'modern-test',
  });
  const interactions = [];
  const resolutions = [];
  const answer = await client.ask('session', 'approve it', {
    timeoutMs: 5_000,
    onInteraction: async (interaction) => {
      interactions.push(interaction);
      await interaction.respond({
        ok: true,
        value: {
          sessionId: interaction.sessionId,
          approvalId: interaction.payload.approvalId,
          outcome: 'allowed-once',
        },
      });
    },
    onInteractionResolved: (resolution) => resolutions.push(resolution),
  });
  await turnTask;
  assert.equal(answer, 'approved');
  assert.equal(interactions.length, 1);
  assert.equal(interactions[0].kind, 'approval');
  assert.equal(events[3].data.outcome, 'allowed-once');
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].kind, 'approval');
  assert.equal(resolutions[0].outcome, 'allowed-once');

  const other = sessionFixture(sessionApi, 'other').session;
  const delegated = await fixture.waterfall('approval/request', {
    agent: { id: 'other', session: other },
    toolName: 'bash',
  }, () => Promise.resolve('browser-owned'));
  assert.equal(delegated, 'browser-owned');
});

forEachSessionApi('structured questions', async (sessionApi) => {
  const { events, session } = sessionFixture(sessionApi);
  const eventRecord = (event) => ({ type: 'event', event });
  let fixture;
  let turnTask;
  let structuredAnswer;
  const append = (event) => {
    events.push(event);
    fixture.emit('session/event', session, event);
  };
  const gateway = {
    async invoke(request) {
      const endpoint = `${request.namespace}/${request.method}`;
      if (endpoint === 'session/page') {
        return { records: events.map(eventRecord), hasMore: false };
      }
      if (endpoint === 'session/prompt') {
        const rpcId = request.args.request.requestId;
        turnTask = (async () => {
          append({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } });
          append({
            type: 'user/message', seq: 1, time: 1,
            data: { turn: 1, source: { kind: 'user', rpcId }, message: { content: [] } },
          });
          structuredAnswer = await fixture.waterfall('user-questions/request', {
            agent: { id: 'session', session },
            questions: [{
              id: 'environment',
              question: 'Choose an environment',
              options: [{ label: 'Test' }, { label: 'Production' }],
            }],
          }, () => Promise.reject(new Error('unavailable')));
          append({
            type: 'assistant/message', seq: 2, time: 2,
            data: { turn: 1, message: { content: [{ type: 'text', text: 'question answered' }] } },
          });
          append({
            type: 'turn/end', seq: 3, time: 3,
            data: { turn: 1, reason: { kind: 'completed' } },
          });
        })();
        return { accepted: true };
      }
      throw new Error(`unexpected invoke ${endpoint}`);
    },
    async stream(request) {
      if (`${request.namespace}/${request.method}` !== 'session/follow') {
        throw new Error('unexpected stream');
      }
      return asyncValues({
        type: 'snapshot', cursor: -1, records: [], hasMore: false,
        projections: { asOfSeq: -1, values: {} },
      });
    },
  };
  fixture = fakeContext(gateway);
  const client = new HarnessClient({
    ...harnessConnection(fixture.ctx),
    workspace: '/workspace',
    rpcIdPrefix: 'modern-question-test',
    logPrefix: 'modern-question-test',
  });
  const interactions = [];
  const resolutions = [];
  const answer = await client.ask('session', 'ask a question', {
    timeoutMs: 5_000,
    onInteraction: async (interaction) => {
      interactions.push(interaction);
      await interaction.respond({
        ok: true,
        value: {
          sessionId: interaction.sessionId,
          answer: { answers: [{ id: 'environment', selected: ['Test'] }] },
        },
      });
    },
    onInteractionResolved: (resolution) => resolutions.push(resolution),
  });
  await turnTask;
  assert.equal(answer, 'question answered');
  assert.equal(interactions.length, 1);
  assert.equal(interactions[0].kind, 'question');
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].kind, 'question');
  assert.equal(resolutions[0].outcome, 'answered');
  assert.deepEqual(structuredAnswer, {
    answers: [{ id: 'environment', selected: ['Test'] }],
  });

  const other = sessionFixture(sessionApi, 'other').session;
  const delegated = await fixture.waterfall('user-questions/request', {
    agent: { id: 'other', session: other },
    questions: [{ id: 'other', question: 'Browser-owned?' }],
  }, () => Promise.resolve({ answers: [{ id: 'other', selected: [], custom: 'yes' }] }));
  assert.deepEqual(delegated, {
    answers: [{ id: 'other', selected: [], custom: 'yes' }],
  });
});

test('modern adapter delegates interactions when a Session exposes no readable events', async () => {
  const gateway = {
    async invoke() { throw new Error('unused'); },
    async stream() { throw new Error('unused'); },
  };
  const fixture = fakeContext(gateway);
  modernHarnessApi(fixture.ctx);
  const session = { id: 'unsupported' };

  const approval = await fixture.waterfall('approval/request', {
    agent: { id: session.id, session },
    toolName: 'bash',
  }, () => Promise.resolve('browser-owned'));
  assert.equal(approval, 'browser-owned');

  const questionAnswer = { answers: [{ id: 'other', selected: [], custom: 'yes' }] };
  const question = await fixture.waterfall('user-questions/request', {
    agent: { id: session.id, session },
    questions: [{ id: 'other', question: 'Browser-owned?' }],
  }, () => Promise.resolve(questionAnswer));
  assert.deepEqual(question, questionAnswer);
});

forEachSessionApi('concurrent questions', async (sessionApi) => {
  const { events, session } = sessionFixture(sessionApi);
  const eventRecord = (event) => ({ type: 'event', event });
  let fixture;
  let turnTask;
  const append = (event) => {
    events.push(event);
    fixture.emit('session/event', session, event);
  };
  const browserAnswer = { answers: [{ id: 'environment', selected: ['Production'] }] };
  const gateway = {
    async invoke(request) {
      const endpoint = `${request.namespace}/${request.method}`;
      if (endpoint === 'session/page') {
        return { records: events.map(eventRecord), hasMore: false };
      }
      if (endpoint === 'session/prompt') {
        const rpcId = request.args.request.requestId;
        turnTask = (async () => {
          append({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } });
          append({
            type: 'user/message', seq: 1, time: 1,
            data: { turn: 1, source: { kind: 'user', rpcId }, message: { content: [] } },
          });
          // The host answers; the IM side is offered the question but stays silent.
          const raced = await fixture.waterfall('user-questions/request', {
            agent: { id: 'session', session },
            questions: [{
              id: 'environment',
              question: 'Choose an environment',
              options: [{ label: 'Test' }, { label: 'Production' }],
            }],
          }, () => Promise.resolve(browserAnswer));
          assert.deepEqual(raced, browserAnswer);
          append({
            type: 'assistant/message', seq: 2, time: 2,
            data: { turn: 1, message: { content: [{ type: 'text', text: 'answered by the host' }] } },
          });
          append({
            type: 'turn/end', seq: 3, time: 3,
            data: { turn: 1, reason: { kind: 'completed' } },
          });
        })();
        return { accepted: true };
      }
      throw new Error(`unexpected invoke ${endpoint}`);
    },
    async stream(request) {
      if (`${request.namespace}/${request.method}` !== 'session/follow') {
        throw new Error('unexpected stream');
      }
      return asyncValues({
        type: 'snapshot', cursor: -1, records: [], hasMore: false,
        projections: { asOfSeq: -1, values: {} },
      });
    },
  };
  fixture = fakeContext(gateway);
  const client = new HarnessClient({
    ...harnessConnection(fixture.ctx),
    workspace: '/workspace',
    rpcIdPrefix: 'modern-race-test',
    logPrefix: 'modern-race-test',
  });
  const interactions = [];
  const resolutions = [];
  const answer = await client.ask('session', 'ask a question', {
    timeoutMs: 5_000,
    onInteraction: async (interaction) => { interactions.push(interaction); },
    onInteractionResolved: (resolution) => resolutions.push(resolution),
  });
  await turnTask;

  assert.equal(answer, 'answered by the host');
  assert.equal(interactions.length, 1, 'IM is still offered an active-turn question');
  assert.equal(resolutions.length, 1, 'the IM pending is retired once the host answers');
  assert.equal(resolutions[0].outcome, 'cancelled');
});
