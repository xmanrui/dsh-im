import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HarnessClient,
  HarnessInteractionError,
  HarnessReplyTracker,
  HarnessRpcError,
} from '../../../src/channels/dingtalk/harness-client.mjs';
import {
  HarnessClient as FeishuHarnessClient,
} from '../../../src/channels/feishu/harness-client.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function eventually(predicate, message = 'condition was not met') {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

class FakeSocket {
  #listeners = new Map();
  readyState = 0;

  addEventListener(name, listener) {
    const listeners = this.#listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(name, listeners);
  }

  removeEventListener(name, listener) {
    this.#listeners.get(name)?.delete(listener);
  }

  open() {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.emit('open', {});
  }

  frame(value) {
    this.emit('message', { data: JSON.stringify(value) });
  }

  close(code = 1000) {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.emit('close', { code });
  }

  emit(name, event) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(event);
  }
}

test('HarnessClient lists only absolute workspace paths and forwards request options', async () => {
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/default-workspace',
  });
  const options = {
    signal: new AbortController().signal,
    rpcId: 'dingtalk-workspace-list',
  };
  let ensuredWith;
  let rpcCall;
  let response = {
    items: [
      {
        workspaceId: 'workspace-one',
        path: '/tmp/workspace-one',
        title: 'private title',
        sessionIds: ['private-session'],
      },
      { workspaceId: 'relative', path: 'relative/workspace' },
      null,
      { workspaceId: 'workspace-two', path: '/tmp/workspace two' },
    ],
    archivedSessionIds: ['private-archive'],
  };
  client.ensureRunning = async (received) => { ensuredWith = received; };
  client.rpc = async (method, payload, timeoutMs, rpcOptions) => {
    rpcCall = { method, payload, timeoutMs, options: rpcOptions };
    return response;
  };

  assert.deepEqual(await client.listWorkspaces(options), [
    '/tmp/workspace-one',
    '/tmp/workspace two',
  ]);
  assert.equal(ensuredWith, options);
  assert.deepEqual(rpcCall, {
    method: 'workspace.list',
    payload: {},
    timeoutMs: 30_000,
    options,
  });

  response = null;
  assert.deepEqual(await client.listWorkspaces(), []);
});

test('HarnessClient lists sessions by workspace accounting and forwards request options', async () => {
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/default-workspace',
  });
  const options = {
    signal: new AbortController().signal,
    rpcId: 'dingtalk-session-list',
  };
  const calls = [];
  let invalidWorkspaceResponse = false;
  let invalidSessionResponse = false;
  client.ensureRunning = async (received) => {
    calls.push({ method: 'ensureRunning', options: received });
  };
  client.rpc = async (method, payload, timeoutMs, rpcOptions) => {
    calls.push({ method, payload, timeoutMs, options: rpcOptions });
    if (method === 'workspace.list') {
      if (invalidWorkspaceResponse) return null;
      return {
        items: [
          {
            workspaceId: 'target',
            path: '/tmp/target',
            sessionIds: ['session-two', 'session-missing', 'session-one'],
          },
          { workspaceId: 'other', path: '/tmp/other', sessionIds: ['cwd-only'] },
        ],
        archivedSessionIds: ['session-missing', 'session-one'],
      };
    }
    assert.equal(method, 'session.list');
    if (invalidSessionResponse) return null;
    return {
      items: [
        {
          sessionId: 'session-one',
          blank: false,
          cwd: '/tmp/target',
          projections: { asOfSeq: -1, values: { title: null } },
        },
        {
          sessionId: 'session-two',
          blank: true,
          origin: 'subagent',
          cwd: '/tmp/different',
          projections: { asOfSeq: 0, values: { title: 'Second session' } },
        },
        {
          sessionId: 'cwd-only',
          blank: false,
          cwd: '/tmp/target',
          projections: { values: { title: 'Must not leak into target' } },
        },
      ],
    };
  };

  assert.deepEqual(await client.listWorkspaceSessions('/tmp/target', options), {
    workspace: '/tmp/target',
    sessions: [
      {
        sessionId: 'session-two',
        title: 'Second session',
        archived: false,
        blank: true,
        origin: 'subagent',
        summaryAvailable: true,
        lastSeq: 0,
      },
      {
        sessionId: 'session-missing',
        title: null,
        archived: true,
        blank: false,
        origin: null,
        summaryAvailable: false,
      },
      {
        sessionId: 'session-one',
        title: null,
        archived: true,
        blank: false,
        origin: null,
        summaryAvailable: true,
        lastSeq: -1,
      },
    ],
  });
  assert.deepEqual(calls, [
    { method: 'ensureRunning', options },
    { method: 'workspace.list', payload: {}, timeoutMs: 30_000, options },
    { method: 'session.list', payload: {}, timeoutMs: 30_000, options },
  ]);

  calls.length = 0;
  assert.deepEqual(await client.listWorkspaceSessions('/tmp/unregistered'), {
    workspace: '/tmp/unregistered',
    sessions: [],
  });
  assert.deepEqual(calls, [
    { method: 'ensureRunning', options: {} },
    { method: 'workspace.list', payload: {}, timeoutMs: 30_000, options: {} },
  ]);

  invalidWorkspaceResponse = true;
  await assert.rejects(
    client.listWorkspaceSessions('/tmp/target'),
    /invalid response for workspace\.list/,
  );
  invalidWorkspaceResponse = false;
  invalidSessionResponse = true;
  await assert.rejects(
    client.listWorkspaceSessions('/tmp/target'),
    /invalid response for session\.list/,
  );
});

test('HarnessClient adopts one registered ordinary session and forwards request options', async () => {
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/default-workspace',
    agentPreset: 'custom-preset',
  });
  const options = {
    signal: new AbortController().signal,
    rpcId: 'dingtalk-session-adopt',
  };
  const calls = [];
  client.ensureRunning = async (received) => {
    calls.push({ method: 'ensureRunning', options: received });
  };
  client.rpc = async (method, payload, timeoutMs, rpcOptions) => {
    calls.push({ method, payload, timeoutMs, options: rpcOptions });
    if (method === 'workspace.list') {
      return {
        items: [
          {
            workspaceId: 'workspace-target',
            path: '/tmp/target',
            sessionIds: ['session-other', 'session-target'],
          },
          { workspaceId: 'workspace-unsafe', path: '/tmp/unsafe\u202e', sessionIds: [] },
          { workspaceId: 'workspace-other', path: '/tmp/other', sessionIds: [] },
        ],
        archivedSessionIds: ['session-target'],
      };
    }
    if (method === 'session.list') {
      return {
        items: [{
          sessionId: 'session-target',
          projections: { values: { title: 'Existing conversation' } },
        }],
      };
    }
    assert.equal(method, 'session.create');
    return { sessionId: 'session-target', agentPreset: 'persisted-preset' };
  };

  assert.deepEqual(await client.adoptWorkspaceSession('session-target', options), {
    sessionId: 'session-target',
    workspace: '/tmp/target',
    title: 'Existing conversation',
    archived: true,
  });
  assert.deepEqual(calls, [
    { method: 'ensureRunning', options },
    { method: 'workspace.list', payload: {}, timeoutMs: 30_000, options },
    { method: 'session.list', payload: {}, timeoutMs: 30_000, options },
    {
      method: 'session.create',
      payload: { workspaceId: 'workspace-target', sessionId: 'session-target' },
      timeoutMs: 30_000,
      options,
    },
  ]);
});

test('HarnessClient safely rejects invalid, unregistered, ambiguous, and subagent adoption', async () => {
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/default-workspace',
  });
  let mode = 'unregistered';
  let createCalls = 0;
  client.ensureRunning = async () => undefined;
  client.rpc = async (method) => {
    if (method === 'workspace.list') {
      if (mode === 'invalid-workspaces') return { items: null, archivedSessionIds: [] };
      if (mode === 'unregistered') {
        return {
          items: [{ workspaceId: 'workspace', path: '/tmp/workspace', sessionIds: [] }],
          archivedSessionIds: [],
        };
      }
      return {
        items: [
          {
            workspaceId: 'workspace-one',
            path: '/tmp/one',
            sessionIds: ['session-target'],
          },
          ...(mode === 'ambiguous' ? [{
            workspaceId: 'workspace-two',
            path: '/tmp/two',
            sessionIds: ['session-target'],
          }] : []),
        ],
        archivedSessionIds: [],
      };
    }
    if (method === 'session.list') {
      if (mode === 'summary-missing') return { items: [] };
      return {
        items: [{
          sessionId: 'session-target',
          ...(mode === 'subagent' ? { origin: 'subagent' } : {}),
        }],
      };
    }
    createCalls += 1;
    return mode === 'bad-create'
      ? { sessionId: 'different-session' }
      : { sessionId: 'session-target' };
  };

  for (const invalid of [
    undefined,
    '',
    '   ',
    'session target',
    'session\u0000target',
    's'.repeat(257),
  ]) {
    await assert.rejects(
      client.adoptWorkspaceSession(invalid),
      (error) => error?.code === 'session-id-invalid',
    );
  }
  await assert.rejects(
    client.adoptWorkspaceSession('session-target'),
    (error) => error?.code === 'session-not-registered',
  );
  mode = 'ambiguous';
  await assert.rejects(
    client.adoptWorkspaceSession('session-target'),
    (error) => error?.code === 'session-workspace-ambiguous',
  );
  mode = 'summary-missing';
  await assert.rejects(
    client.adoptWorkspaceSession('session-target'),
    (error) => error?.code === 'session-summary-unavailable',
  );
  mode = 'subagent';
  await assert.rejects(
    client.adoptWorkspaceSession('session-target'),
    (error) => error?.code === 'session-subagent-unsupported',
  );
  assert.equal(createCalls, 0);

  mode = 'invalid-workspaces';
  await assert.rejects(
    client.adoptWorkspaceSession('session-target'),
    /invalid response for workspace\.list/,
  );
  mode = 'bad-create';
  await assert.rejects(
    client.adoptWorkspaceSession('session-target'),
    /invalid response for session\.create/,
  );
  assert.equal(createCalls, 1);
});

test('reply tracker associates only the Harness turn created by the DingTalk prompt RPC', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: 'dingtalk-prompt', afterSeq: 2 });
  const update = tracker.consume([
    { event: { seq: 3, type: 'turn/start', data: { turn: 9 } } },
    { event: {
      seq: 4,
      type: 'user/message',
      data: { turn: 9, source: { rpcId: 'dingtalk-prompt' } },
    } },
    { event: {
      seq: 5,
      type: 'assistant/chunk',
      data: { turn: 9, step: 0, chunk: { type: 'text-delta', index: 0, text: '钉钉' } },
    } },
  ]);
  assert.deepEqual(update, { type: 'text', text: '钉钉' });
  tracker.consume([
    { event: {
      seq: 6,
      type: 'assistant/message',
      data: { turn: 9, message: { content: [{ type: 'text', text: '钉钉回复完成' }] } },
    } },
    { event: { seq: 7, type: 'turn/end', data: { turn: 9, reason: 'completed' } } },
  ]);
  assert.equal(tracker.finished, true);
  assert.equal(tracker.answer, '钉钉回复完成');
});

test('reply tracker ignores interleaved turns and events at or before the baseline', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: 'target', afterSeq: 10 });
  tracker.consume([
    { event: { seq: 9, type: 'turn/start', data: { turn: 1 } } },
    { event: { seq: 11, type: 'turn/start', data: { turn: 2 } } },
    { event: { seq: 12, type: 'user/message', data: { turn: 2, source: { rpcId: 'other' } } } },
    { event: {
      seq: 13,
      type: 'assistant/message',
      data: { turn: 2, message: { content: [{ type: 'text', text: 'wrong' }] } },
    } },
  ]);
  assert.equal(tracker.answer, '');
  assert.equal(tracker.finished, false);
});

test('Harness client validates the RPC envelope and preserves server error codes', async () => {
  let request;
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/workspace',
    fetchImpl: async (url, options) => {
      request = { url: url.toString(), body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({
          type: 'server-response',
          rpcId: request.body.rpcId,
          result: { ok: false, error: { code: 'session-not-found', message: 'missing' } },
        }),
      };
    },
  });

  await assert.rejects(
    client.rpc('session.history', { sessionId: 'one' }),
    (error) => error instanceof HarnessRpcError && error.code === 'session-not-found',
  );
  assert.equal(request.url, 'http://127.0.0.1:3080/api/session.history');
  assert.match(request.body.rpcId, /^dingtalk-/);
});

test('interaction watcher decodes mux requests, filters sessions, and posts exact responses', async () => {
  const requests = [];
  const opened = deferred();
  let socket;
  let socketUrl;
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080/base',
    workspace: '/tmp/workspace',
    fetchImpl: async (url, options) => {
      requests.push({
        url: url.toString(),
        method: options.method,
        body: JSON.parse(options.body),
      });
      return { ok: true, json: async () => ({ accepted: true }) };
    },
    createWebSocket: (url) => {
      socketUrl = url;
      socket = new FakeSocket();
      queueMicrotask(() => socket.open());
      return socket;
    },
  });
  const controller = new AbortController();
  const interactions = [];
  const resolutions = [];
  const watching = client.watchInteractions('session-one', {
    signal: controller.signal,
    onOpen: opened.resolve,
    onInteraction: (interaction) => interactions.push(interaction),
    onResolved: (resolution) => resolutions.push(resolution),
  });
  await opened.promise;

  socket.frame({
    type: 'server-request',
    rpcId: 'other-rpc',
    method: 'question/requested',
    payload: {
      type: 'question/requested',
      sessionId: 'session-other',
      questions: [{ id: 'ignored', question: 'ignore me' }],
    },
  });
  socket.frame({
    type: 'server-request',
    rpcId: 'approval-rpc',
    method: 'approval/requested',
    payload: {
      type: 'approval/requested',
      sessionId: 'session-one',
      approvalId: 'approval-one',
      toolName: 'bash',
    },
  });
  socket.frame({
    type: 'server-request',
    rpcId: 'question-rpc',
    method: 'question/requested',
    payload: {
      type: 'question/requested',
      sessionId: 'session-one',
      questions: [{ id: 'language', question: 'Which language?' }],
    },
  });
  socket.frame({
    type: 'server-request',
    rpcId: 'resolution-envelope',
    method: 'question/resolved',
    payload: {
      type: 'question/resolved',
      sessionId: 'session-one',
      questionRpcId: 'question-rpc',
      outcome: 'answered',
    },
  });
  socket.frame({
    type: 'server-request',
    rpcId: 'approval-resolution-envelope',
    method: 'approval/resolved',
    payload: {
      type: 'approval/resolved',
      sessionId: 'session-one',
      approvalId: 'approval-one',
      outcome: 'rejected',
    },
  });

  await eventually(() => interactions.length === 2 && resolutions.length === 2);

  assert.equal(socketUrl, 'ws://127.0.0.1:3080/api/events.mux');
  assert.equal(interactions.length, 2);
  assert.deepEqual({
    kind: interactions[0].kind,
    interactionId: interactions[0].interactionId,
    rpcId: interactions[0].rpcId,
    sessionId: interactions[0].sessionId,
  }, {
    kind: 'approval',
    interactionId: 'approval-one',
    rpcId: 'approval-rpc',
    sessionId: 'session-one',
  });
  assert.deepEqual({
    kind: interactions[1].kind,
    interactionId: interactions[1].interactionId,
    rpcId: interactions[1].rpcId,
    sessionId: interactions[1].sessionId,
  }, {
    kind: 'question',
    interactionId: 'question-rpc',
    rpcId: 'question-rpc',
    sessionId: 'session-one',
  });
  assert.deepEqual(resolutions.map(({ kind, interactionId, outcome }) => ({
    kind,
    interactionId,
    outcome,
  })), [
    {
      kind: 'question',
      interactionId: 'question-rpc',
      outcome: 'answered',
    },
    {
      kind: 'approval',
      interactionId: 'approval-one',
      outcome: 'rejected',
    },
  ]);
  assert.equal(requests.length, 0, 'receiving an approval must not approve it automatically');

  const result = {
    ok: true,
    value: {
      sessionId: 'session-one',
      answer: { answers: [{ id: 'language', selected: [], custom: 'Chinese' }] },
    },
  };
  assert.deepEqual(await interactions[1].respond(result), { accepted: true });
  assert.deepEqual(requests, [{
    url: 'http://127.0.0.1:3080/api/respond',
    method: 'POST',
    body: { type: 'client-response', rpcId: 'question-rpc', result },
  }]);

  controller.abort();
  await watching;
  assert.equal(socket.readyState, 3);
});

test('interaction watcher reconnects over wss and exposes replayed stable request ids', async () => {
  const sockets = [];
  const seen = [];
  const controller = new AbortController();
  const client = new HarnessClient({
    baseUrl: 'https://harness.example/nested',
    workspace: '/tmp/workspace',
    interactionReconnectDelayMs: 0,
    createWebSocket: (url) => {
      const socket = new FakeSocket();
      sockets.push({ socket, url });
      queueMicrotask(() => socket.open());
      return socket;
    },
  });
  const watching = client.watchInteractions('session-replay', {
    signal: controller.signal,
    onInteraction: ({ rpcId }) => seen.push(rpcId),
  });
  await eventually(() => sockets[0]?.socket.readyState === 1);
  const frame = {
    type: 'server-request',
    rpcId: 'stable-question-rpc',
    method: 'question/requested',
    payload: {
      type: 'question/requested',
      sessionId: 'session-replay',
      questions: [{ id: 'replay', question: 'Still pending?' }],
    },
  };
  sockets[0].socket.frame(frame);
  sockets[0].socket.close(1006);
  await eventually(() => sockets[1]?.socket.readyState === 1, 'watcher did not reconnect');
  sockets[1].socket.frame(frame);

  await eventually(() => seen.length === 2);

  assert.deepEqual(seen, ['stable-question-rpc', 'stable-question-rpc']);
  assert.deepEqual(sockets.map(({ url }) => url), [
    'wss://harness.example/api/events.mux',
    'wss://harness.example/api/events.mux',
  ]);
  controller.abort();
  await watching;
});

test('interaction response receipts distinguish protocol rejection from invalid transport data', async () => {
  let receipt = { accepted: false, reason: 'not-pending' };
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/workspace',
    fetchImpl: async () => ({ ok: true, json: async () => receipt }),
  });
  const result = { ok: true, value: { sessionId: 'session-one' } };

  await assert.rejects(
    client.respondInteraction('question-rpc', result),
    (error) => error instanceof HarnessInteractionError
      && error.code === 'interaction-not-pending',
  );
  receipt = { accepted: false, reason: 'bad-response' };
  await assert.rejects(
    client.respondInteraction('question-rpc', result),
    (error) => error instanceof HarnessInteractionError
      && error.code === 'interaction-bad-response',
  );
  receipt = { type: 'server-response', accepted: false };
  await assert.rejects(
    client.respondInteraction('question-rpc', result),
    /invalid interaction response receipt/,
  );
});

test('ask opens the interaction watcher before prompting and closes it with the turn', async () => {
  let socket;
  let promptRpcId;
  let historyCalls = 0;
  const responses = [];
  const interactions = [];
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/workspace',
    fetchImpl: async (_url, options) => {
      responses.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ accepted: true }) };
    },
    createWebSocket: () => {
      const createdSocket = new FakeSocket();
      socket = createdSocket;
      queueMicrotask(() => createdSocket.open());
      return createdSocket;
    },
  });
  client.ensureRunning = async () => true;
  client.rpc = async (method, payload, _timeoutMs, options) => {
    if (method === 'session.history') {
      historyCalls += 1;
      if (historyCalls === 1) return { events: [] };
      return {
        events: [
          { event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
          { event: {
            seq: 2,
            type: 'user/message',
            data: { turn: 1, source: { rpcId: promptRpcId } },
          } },
          { event: {
            seq: 3,
            type: 'assistant/message',
            data: {
              turn: 1,
              message: { content: [{ type: 'text', text: '已收到回答' }] },
            },
          } },
          { event: { seq: 4, type: 'turn/end', data: { turn: 1, reason: 'completed' } } },
        ],
      };
    }
    assert.equal(method, 'session.prompt');
    assert.equal(socket.readyState, 1, 'interaction watcher must open before session.prompt');
    assert.equal(payload.sessionId, 'session-one');
    promptRpcId = options.rpcId;
    socket.frame({
      type: 'server-request',
      rpcId: 'turn-start-frame',
      method: 'session/event',
      payload: {
        type: 'session/event',
        sessionId: 'session-one',
        event: { seq: 1, type: 'turn/start', data: { turn: 1 } },
      },
    });
    socket.frame({
      type: 'server-request',
      rpcId: 'user-message-frame',
      method: 'session/event',
      payload: {
        type: 'session/event',
        sessionId: 'session-one',
        event: {
          seq: 2,
          type: 'user/message',
          data: { turn: 1, source: { rpcId: promptRpcId } },
        },
      },
    });
    socket.frame({
      type: 'server-request',
      rpcId: 'question-during-ask',
      method: 'question/requested',
      payload: {
        type: 'question/requested',
        sessionId: 'session-one',
        questions: [{
          id: 'ready',
          question: 'Ready?',
          options: [{ label: 'Yes' }, { label: 'No' }],
        }],
      },
    });
    return {};
  };

  const answer = await client.ask('session-one', '请先提问', {
    onInteraction: async (interaction) => {
      interactions.push(interaction.rpcId);
      await interaction.respond({
        ok: true,
        value: {
          sessionId: interaction.sessionId,
          answer: { answers: [{ id: 'ready', selected: ['Yes'] }] },
        },
      });
    },
  });

  assert.equal(answer, '已收到回答');
  assert.deepEqual(interactions, ['question-during-ask']);
  assert.deepEqual(responses, [{
    type: 'client-response',
    rpcId: 'question-during-ask',
    result: {
      ok: true,
      value: {
        sessionId: 'session-one',
        answer: { answers: [{ id: 'ready', selected: ['Yes'] }] },
      },
    },
  }]);
  assert.equal(socket.readyState, 3);
});

test('approval interactions expose only matching tool calls from the active turn', async () => {
  let socket;
  let promptRpcId;
  let historyCalls = 0;
  const interactions = [];
  const currentToolCall = {
    callId: 'call-current-0',
    name: 'bash',
    arguments: JSON.stringify({ cmd: 'pwd-0' }),
  };
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/workspace',
    createWebSocket: () => {
      const createdSocket = new FakeSocket();
      socket = createdSocket;
      queueMicrotask(() => createdSocket.open());
      return createdSocket;
    },
  });
  client.ensureRunning = async () => true;
  client.rpc = async (method, payload, _timeoutMs, options) => {
    if (method === 'session.history') {
      historyCalls += 1;
      // Baseline and mux-open refresh both precede this new prompt. The mux
      // session/event frames below establish ownership before approvals arrive.
      if (historyCalls <= 2) return { events: [] };
      return {
        events: [
          { event: { seq: 1, type: 'turn/start', data: { turn: 7 } } },
          { event: {
            seq: 2,
            type: 'user/message',
            data: { turn: 7, source: { rpcId: promptRpcId } },
          } },
          { event: {
            seq: 3,
            type: 'assistant/message',
            data: {
              turn: 7,
              message: { content: [{ type: 'text', text: '审批上下文已捕获' }] },
            },
          } },
          { event: { seq: 4, type: 'turn/end', data: { turn: 7, reason: 'completed' } } },
        ],
      };
    }
    assert.equal(method, 'session.prompt');
    assert.equal(socket.readyState, 1);
    assert.equal(payload.sessionId, 'session-tool-call');
    promptRpcId = options.rpcId;

    const emitEvent = (rpcId, event) => socket.frame({
      type: 'server-request',
      rpcId,
      method: 'session/event',
      payload: { type: 'session/event', sessionId: 'session-tool-call', event },
    });
    const emitApproval = (rpcId, approvalId, callId) => socket.frame({
      type: 'server-request',
      rpcId,
      method: 'approval/requested',
      payload: {
        type: 'approval/requested',
        sessionId: 'session-tool-call',
        approvalId,
        toolName: 'bash',
        callId,
        reason: '测试工具调用展示',
      },
    });

    emitEvent('turn-start-frame', {
      seq: 1,
      type: 'turn/start',
      data: { turn: 7 },
    });
    emitEvent('user-message-frame', {
      seq: 2,
      type: 'user/message',
      data: { turn: 7, source: { rpcId: promptRpcId } },
    });
    emitEvent('other-turn-tool-frame', {
      seq: 3,
      type: 'tool/call',
      data: {
        turn: 6,
        step: 1,
        callId: 'call-other-turn',
        name: 'bash',
        arguments: JSON.stringify({ cmd: 'whoami' }),
      },
    });
    for (let index = 0; index < 40; index += 1) {
      emitEvent(`current-tool-frame-${index}`, {
        seq: 4 + index,
        type: 'tool/call',
        data: {
          turn: 7,
          step: 1,
          callId: `call-current-${index}`,
          name: 'bash',
          arguments: JSON.stringify({ cmd: `pwd-${index}` }),
        },
      });
    }
    emitEvent('code-dispatch-tool-frame', {
      seq: 44,
      type: 'tool/code-dispatch-start',
      data: {
        rootCallId: 'run-code-root',
        parentCallId: 'run-code-root',
        subCallId: 'call-code-1',
        name: 'bash',
        arguments: { cmd: 'echo code-mode' },
      },
    });
    emitApproval('matching-approval-rpc', 'matching-approval', 'call-current-0');
    emitApproval('code-mode-approval-rpc', 'code-mode-approval', 'call-code-1');
    emitApproval('missing-approval-rpc', 'missing-approval', 'call-missing');
    emitApproval('other-turn-approval-rpc', 'other-turn-approval', 'call-other-turn');
    return {};
  };

  const answer = await client.ask('session-tool-call', '请测试审批上下文', {
    onInteraction: (interaction) => interactions.push(interaction),
  });

  assert.equal(answer, '审批上下文已捕获');
  assert.deepEqual(interactions.map((interaction) => ({
    approvalId: interaction.interactionId,
    hasToolCall: Object.hasOwn(interaction, 'toolCall'),
    toolCall: interaction.toolCall,
  })), [
    {
      approvalId: 'matching-approval',
      hasToolCall: true,
      toolCall: currentToolCall,
    },
    {
      approvalId: 'code-mode-approval',
      hasToolCall: true,
      toolCall: {
        callId: 'call-code-1',
        name: 'bash',
        arguments: JSON.stringify({ cmd: 'echo code-mode' }),
      },
    },
    {
      approvalId: 'missing-approval',
      hasToolCall: false,
      toolCall: undefined,
    },
    {
      approvalId: 'other-turn-approval',
      hasToolCall: false,
      toolCall: undefined,
    },
  ]);
  assert.equal(socket.readyState, 3);
});

test('reconnect history restores a Code Mode sub-call before replaying its approval', async () => {
  const sockets = [];
  const controller = new AbortController();
  let historyEvents = [];
  let received;
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/workspace',
    interactionReconnectDelayMs: 0,
    createWebSocket: () => {
      const socket = new FakeSocket();
      const index = sockets.push(socket) - 1;
      queueMicrotask(() => {
        socket.open();
        if (index === 1) {
          socket.frame({
            type: 'server-request',
            rpcId: 'replayed-code-approval-rpc',
            method: 'approval/requested',
            payload: {
              type: 'approval/requested',
              sessionId: 'code-reconnect-session',
              approvalId: 'replayed-code-approval',
              toolName: 'bash',
              callId: 'root-call:code:1',
            },
          });
        }
      });
      return socket;
    },
  });
  client.ensureRunning = async () => true;
  client.rpc = async (method, _payload, _timeoutMs, options) => {
    if (method === 'session.history') return { events: historyEvents };
    assert.equal(method, 'session.prompt');
    const events = [
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
      {
        seq: 2,
        type: 'user/message',
        data: { turn: 1, source: { rpcId: options.rpcId } },
      },
      {
        seq: 3,
        type: 'tool/code-dispatch-start',
        data: {
          rootCallId: 'root-call',
          parentCallId: 'root-call',
          subCallId: 'root-call:code:1',
          name: 'bash',
          arguments: { command: 'echo restored' },
        },
      },
    ];
    historyEvents = events.map((event) => ({ event }));
    sockets[0].frame({
      type: 'server-request',
      rpcId: 'code-reconnect-start',
      method: 'session/event',
      payload: { type: 'session/event', sessionId: 'code-reconnect-session', event: events[0] },
    });
    sockets[0].frame({
      type: 'server-request',
      rpcId: 'code-reconnect-user',
      method: 'session/event',
      payload: { type: 'session/event', sessionId: 'code-reconnect-session', event: events[1] },
    });
    sockets[0].close(1006);
    return {};
  };

  const asking = client.ask('code-reconnect-session', '测试 Code Mode 重连', {
    signal: controller.signal,
    onInteraction: (interaction) => { received = interaction; },
  });
  await eventually(() => received !== undefined);

  assert.equal(received.recovered, false);
  assert.deepEqual(received.toolCall, {
    callId: 'root-call:code:1',
    name: 'bash',
    arguments: JSON.stringify({ command: 'echo restored' }),
  });
  controller.abort();
  await Promise.allSettled([asking]);
});

test('interaction callbacks preserve frame order but watcher abort does not await a hanging callback', async () => {
  const opened = deferred();
  const releaseRequested = deferred();
  const order = [];
  let socket;
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/workspace',
    createWebSocket: () => {
      socket = new FakeSocket();
      queueMicrotask(() => socket.open());
      return socket;
    },
  });
  const controller = new AbortController();
  const watching = client.watchInteractions('session-ordered', {
    signal: controller.signal,
    onOpen: opened.resolve,
    onInteraction: async () => {
      order.push('requested:start');
      await releaseRequested.promise;
      order.push('requested:end');
    },
    onResolved: () => order.push('resolved'),
  });
  await opened.promise;

  socket.frame({
    type: 'server-request',
    rpcId: 'ordered-question',
    method: 'question/requested',
    payload: {
      type: 'question/requested',
      sessionId: 'session-ordered',
      questions: [{ id: 'ordered', question: 'Wait for delivery' }],
    },
  });
  socket.frame({
    type: 'server-request',
    rpcId: 'ordered-resolution',
    method: 'question/resolved',
    payload: {
      type: 'question/resolved',
      sessionId: 'session-ordered',
      questionRpcId: 'ordered-question',
      outcome: 'cancelled',
    },
  });
  controller.abort();

  await eventually(() => order.length > 0);
  assert.deepEqual(order, ['requested:start']);
  let settled = false;
  void watching.finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, true);

  releaseRequested.resolve();
  await eventually(() => order.length === 3);
  assert.deepEqual(order, ['requested:start', 'requested:end', 'resolved']);
});

test('concurrent asks on one Harness session receive interactions only for their own active turn', async () => {
  const sockets = [];
  const prompts = [];
  const received = { first: [], second: [] };
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/workspace',
    createWebSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket;
    },
  });
  client.ensureRunning = async () => true;
  client.rpc = async (method, payload, _timeoutMs, options) => {
    if (method === 'session.history') return { events: [] };
    assert.equal(method, 'session.prompt');
    prompts.push({ text: payload.content[0].text, rpcId: options.rpcId });
    return {};
  };
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = client.ask('shared-session', 'first', {
    signal: firstController.signal,
    onInteraction: ({ rpcId }) => received.first.push(rpcId),
  });
  const second = client.ask('shared-session', 'second', {
    signal: secondController.signal,
    onInteraction: ({ rpcId }) => received.second.push(rpcId),
  });
  await eventually(() => prompts.length === 2 && sockets.length === 2);

  const active = prompts[0];
  const frames = [
    {
      type: 'server-request',
      rpcId: 'shared-turn-start',
      method: 'session/event',
      payload: {
        type: 'session/event',
        sessionId: 'shared-session',
        event: { seq: 1, type: 'turn/start', data: { turn: 1 } },
      },
    },
    {
      type: 'server-request',
      rpcId: 'shared-user-message',
      method: 'session/event',
      payload: {
        type: 'session/event',
        sessionId: 'shared-session',
        event: {
          seq: 2,
          type: 'user/message',
          data: { source: { rpcId: active.rpcId } },
        },
      },
    },
    {
      type: 'server-request',
      rpcId: 'shared-plugin-context',
      method: 'session/event',
      payload: {
        type: 'session/event',
        sessionId: 'shared-session',
        event: {
          seq: 3,
          type: 'user/message',
          data: { source: { kind: 'plugin', pluginId: 'time-context' } },
        },
      },
    },
    {
      type: 'server-request',
      rpcId: 'shared-question',
      method: 'question/requested',
      payload: {
        type: 'question/requested',
        sessionId: 'shared-session',
        questions: [{ id: 'owner', question: 'Who owns this turn?' }],
      },
    },
  ];
  for (const frame of frames) {
    for (const socket of sockets) socket.frame(frame);
  }
  await eventually(() => received.first.length + received.second.length === 1);

  assert.deepEqual(received[active.text], ['shared-question']);
  assert.deepEqual(received[active.text === 'first' ? 'second' : 'first'], []);
  firstController.abort();
  secondController.abort();
  await Promise.allSettled([first, second]);
});

test('channel-specific clients share interaction ownership for the same Harness origin', async () => {
  const sockets = [];
  const prompts = [];
  const received = { dingtalk: [], feishu: [] };
  const makeClient = (Client, channel) => {
    const client = new Client({
      baseUrl: 'http://127.0.0.1:3080',
      workspace: '/tmp/workspace',
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push({ channel, socket });
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    client.ensureRunning = async () => true;
    client.rpc = async (method, payload, _timeoutMs, options) => {
      if (method === 'session.history') return { events: [] };
      assert.equal(method, 'session.prompt');
      prompts.push({ channel, rpcId: options.rpcId, text: payload.content[0].text });
      return {};
    };
    return client;
  };
  const dingtalk = makeClient(HarnessClient, 'dingtalk');
  const feishu = makeClient(FeishuHarnessClient, 'feishu');
  const dingtalkController = new AbortController();
  const feishuController = new AbortController();
  const first = dingtalk.ask('cross-channel-session', 'dingtalk prompt', {
    signal: dingtalkController.signal,
    onInteraction: ({ rpcId }) => received.dingtalk.push(rpcId),
  });
  await eventually(() => prompts.length === 1);
  const second = feishu.ask('cross-channel-session', 'feishu prompt', {
    signal: feishuController.signal,
    onInteraction: ({ rpcId }) => received.feishu.push(rpcId),
  });
  await eventually(() => prompts.length === 2 && sockets.length === 2);

  const activePrompt = prompts[0];
  const frames = [
    {
      type: 'server-request', rpcId: 'cross-start', method: 'session/event',
      payload: {
        type: 'session/event', sessionId: 'cross-channel-session',
        event: { seq: 1, type: 'turn/start', data: { turn: 1 } },
      },
    },
    {
      type: 'server-request', rpcId: 'cross-user', method: 'session/event',
      payload: {
        type: 'session/event', sessionId: 'cross-channel-session',
        event: {
          seq: 2,
          type: 'user/message',
          data: { source: { rpcId: activePrompt.rpcId } },
        },
      },
    },
    {
      type: 'server-request', rpcId: 'cross-question', method: 'question/requested',
      payload: {
        type: 'question/requested', sessionId: 'cross-channel-session',
        questions: [{ id: 'owner', question: 'Which channel owns this turn?' }],
      },
    },
  ];
  for (const frame of frames) {
    for (const { socket } of sockets) socket.frame(frame);
  }
  await eventually(() => received.dingtalk.length + received.feishu.length === 1);

  assert.deepEqual(received, { dingtalk: ['cross-question'], feishu: [] });
  dingtalkController.abort();
  feishuController.abort();
  await Promise.allSettled([first, second]);
});

test('a reconnect revalidates same-session ownership before accepting replayed questions', async () => {
  const sockets = [];
  const prompts = [];
  const received = { first: [], second: [] };
  let historyEvents = [];
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/workspace',
    interactionReconnectDelayMs: 0,
    createWebSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket;
    },
  });
  client.ensureRunning = async () => true;
  client.rpc = async (method, payload, _timeoutMs, options) => {
    if (method === 'session.history') return { events: historyEvents };
    assert.equal(method, 'session.prompt');
    prompts.push({ text: payload.content[0].text, rpcId: options.rpcId });
    return {};
  };
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = client.ask('handoff-session', 'first', {
    signal: firstController.signal,
    onInteraction: ({ rpcId }) => received.first.push(rpcId),
  });
  await eventually(() => prompts.length === 1 && sockets.length === 1);
  const second = client.ask('handoff-session', 'second', {
    signal: secondController.signal,
    onInteraction: ({ rpcId }) => received.second.push(rpcId),
  });
  await eventually(() => prompts.length === 2 && sockets.length === 2);

  const firstPrompt = prompts.find(({ text }) => text === 'first');
  const secondPrompt = prompts.find(({ text }) => text === 'second');
  const firstTurnFrames = [
    {
      type: 'server-request', rpcId: 'handoff-start-one', method: 'session/event',
      payload: {
        type: 'session/event', sessionId: 'handoff-session',
        event: { seq: 1, type: 'turn/start', data: { turn: 1 } },
      },
    },
    {
      type: 'server-request', rpcId: 'handoff-user-one', method: 'session/event',
      payload: {
        type: 'session/event', sessionId: 'handoff-session',
        event: {
          seq: 2,
          type: 'user/message',
          data: { source: { rpcId: firstPrompt.rpcId } },
        },
      },
    },
    {
      type: 'server-request', rpcId: 'handoff-plugin-one', method: 'session/event',
      payload: {
        type: 'session/event', sessionId: 'handoff-session',
        event: {
          seq: 3,
          type: 'user/message',
          data: { source: { kind: 'plugin', pluginId: 'time-context' } },
        },
      },
    },
  ];
  for (const frame of firstTurnFrames) {
    historyEvents.push({ event: frame.payload.event });
    for (const socket of sockets.slice(0, 2)) socket.frame(frame);
  }
  const firstQuestion = {
    type: 'server-request', rpcId: 'handoff-question-one', method: 'question/requested',
    payload: {
      type: 'question/requested', sessionId: 'handoff-session',
      questions: [{ id: 'one', question: 'First turn question' }],
    },
  };
  for (const socket of sockets.slice(0, 2)) socket.frame(firstQuestion);
  await eventually(() => received.first.length === 1);

  sockets[0].close(1006);
  const secondTurnEvents = [
    { seq: 4, type: 'turn/end', data: { turn: 1, reason: 'completed' } },
    { seq: 5, type: 'turn/start', data: { turn: 2 } },
    {
      seq: 6,
      type: 'user/message',
      data: { source: { rpcId: secondPrompt.rpcId } },
    },
  ];
  historyEvents.push(...secondTurnEvents.map((event) => ({ event })));
  for (const event of secondTurnEvents) {
    sockets[1].frame({
      type: 'server-request',
      rpcId: `handoff-event-${event.seq}`,
      method: 'session/event',
      payload: { type: 'session/event', sessionId: 'handoff-session', event },
    });
  }
  const secondQuestion = {
    type: 'server-request', rpcId: 'handoff-question-two', method: 'question/requested',
    payload: {
      type: 'question/requested', sessionId: 'handoff-session',
      questions: [{ id: 'two', question: 'Second turn question' }],
    },
  };
  sockets[1].frame(secondQuestion);
  await eventually(() => received.second.length === 1);
  await eventually(() => sockets.length >= 3 && sockets[2].readyState === 1);
  sockets[2].frame(secondQuestion);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(received, {
    first: ['handoff-question-one'],
    second: ['handoff-question-two'],
  });
  firstController.abort();
  secondController.abort();
  await Promise.allSettled([first, second]);
});

test('a new ask adopts a replayed orphan question before its queued prompt can run', async () => {
  const oldHistory = [
    { event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
    {
      event: {
        seq: 2,
        type: 'user/message',
        data: { turn: 1, source: { rpcId: 'prompt-from-old-runtime' } },
      },
    },
  ];
  const received = [];
  const prompted = deferred();
  let socket;
  const controller = new AbortController();
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/workspace',
    createWebSocket: () => {
      socket = new FakeSocket();
      queueMicrotask(() => {
        socket.open();
        socket.frame({
          type: 'server-request',
          rpcId: 'orphan-question',
          method: 'question/requested',
          payload: {
            type: 'question/requested',
            sessionId: 'orphan-session',
            questions: [{ id: 'orphan', question: 'Recovered question' }],
          },
        });
      });
      return socket;
    },
  });
  client.ensureRunning = async () => true;
  client.rpc = async (method) => {
    if (method === 'session.history') return { events: oldHistory };
    assert.equal(method, 'session.prompt');
    prompted.resolve();
    return {};
  };

  const asking = client.ask('orphan-session', 'new queued prompt', {
    signal: controller.signal,
    onInteraction: ({ rpcId, recovered }) => received.push({ rpcId, recovered }),
  });
  await prompted.promise;
  await eventually(() => received.length === 1);
  assert.deepEqual(received, [{ rpcId: 'orphan-question', recovered: true }]);

  controller.abort();
  await Promise.allSettled([asking]);
});

test('an orphan approval is delivered only as a recovered interaction for safe rejection', async () => {
  const oldHistory = [
    { event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
    {
      event: {
        seq: 2,
        type: 'user/message',
        data: { source: { rpcId: 'approval-prompt-from-old-runtime' } },
      },
    },
  ];
  const received = [];
  const prompted = deferred();
  const controller = new AbortController();
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/workspace',
    createWebSocket: () => {
      const socket = new FakeSocket();
      queueMicrotask(() => {
        socket.open();
        socket.frame({
          type: 'server-request',
          rpcId: 'orphan-approval-rpc',
          method: 'approval/requested',
          payload: {
            type: 'approval/requested',
            sessionId: 'orphan-approval-session',
            approvalId: 'orphan-approval-id',
            toolName: 'bash',
          },
        });
      });
      return socket;
    },
  });
  client.ensureRunning = async () => true;
  client.rpc = async (method) => {
    if (method === 'session.history') return { events: oldHistory };
    assert.equal(method, 'session.prompt');
    prompted.resolve();
    return {};
  };

  const asking = client.ask('orphan-approval-session', 'new queued prompt', {
    signal: controller.signal,
    onInteraction: (interaction) => received.push(interaction),
  });
  await prompted.promise;
  await eventually(() => received.length === 1);
  assert.equal(received[0].kind, 'approval');
  assert.equal(received[0].interactionId, 'orphan-approval-id');
  assert.equal(received[0].recovered, true);
  assert.equal(Object.hasOwn(received[0], 'toolCall'), false);

  controller.abort();
  await Promise.allSettled([asking]);
});
