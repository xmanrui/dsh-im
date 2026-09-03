import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HarnessClient,
  HarnessReplyTracker,
} from '../../../src/channels/feishu/harness-client.mjs';
import {
  OUTBOUND_ARTIFACT_TOOL,
  createOutboundArtifactTool,
  materializeOutboundArtifact,
  outboundArtifactRegistry,
  releaseOutboundArtifact,
} from '../../../src/channels/shared/semantic/artifact.mjs';

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
    this.#emit('open', {});
  }

  frame(value) {
    this.#emit('message', { data: JSON.stringify(value) });
  }

  close(code = 1000) {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.#emit('close', { code });
  }

  #emit(name, event) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(event);
  }
}

test('interaction watcher uses the real Harness wire protocol and leaves approvals fail-closed', async () => {
  const requests = [];
  const opened = deferred();
  let socket;
  let socketUrl;
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080/base',
    workspace: '/tmp/dsh-feishu-workspace',
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
  const watching = client.watchInteractions('session-feishu', {
    signal: controller.signal,
    onOpen: opened.resolve,
    onInteraction: (interaction) => interactions.push(interaction),
  });
  await opened.promise;

  socket.frame({
    type: 'server-request',
    rpcId: 'approval-rpc',
    method: 'approval/requested',
    payload: {
      type: 'approval/requested',
      sessionId: 'session-feishu',
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
      sessionId: 'session-feishu',
      questions: [{
        id: 'environment',
        question: '请选择测试环境',
        options: [{ label: '测试环境' }, { label: '生产环境' }],
      }],
    },
  });

  await eventually(() => interactions.length === 2);
  assert.equal(socketUrl, 'ws://127.0.0.1:3080/api/events.mux');
  assert.deepEqual(interactions.map((interaction) => ({
    kind: interaction.kind,
    interactionId: interaction.interactionId,
    rpcId: interaction.rpcId,
    sessionId: interaction.sessionId,
  })), [
    {
      kind: 'approval',
      interactionId: 'approval-one',
      rpcId: 'approval-rpc',
      sessionId: 'session-feishu',
    },
    {
      kind: 'question',
      interactionId: 'question-rpc',
      rpcId: 'question-rpc',
      sessionId: 'session-feishu',
    },
  ]);
  assert.equal(requests.length, 0, 'receiving an approval must never approve it automatically');

  const result = {
    ok: true,
    value: {
      sessionId: 'session-feishu',
      answer: { answers: [{ id: 'environment', selected: ['测试环境'] }] },
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

test('global event watcher reconnects without resolving until abort', async () => {
  const sockets = [];
  const socketUrls = [];
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080/base',
    workspace: '/tmp/dsh-feishu-workspace',
    interactionReconnectDelayMs: 0,
    createWebSocket: (url) => {
      const socket = new FakeSocket();
      sockets.push(socket);
      socketUrls.push(url);
      queueMicrotask(() => socket.open());
      return socket;
    },
  });
  const controller = new AbortController();
  const events = [];
  let reconnects = 0;
  let settled = false;
  const watching = client.watchHarnessEvents({
    signal: controller.signal,
    onReconnect: () => { reconnects += 1; },
    onSessionEvent: (payload) => events.push(payload),
  });
  watching.finally(() => { settled = true; });

  await eventually(() => reconnects === 1);
  sockets[0].frame({
    type: 'server-request',
    rpcId: 'event-one',
    method: 'session/event',
    payload: {
      type: 'session/event',
      sessionId: 'session-one',
      event: { type: 'turn/end', seq: 1 },
    },
  });
  sockets[0].frame({
    type: 'server-request',
    rpcId: 'invalid-method',
    method: 'different/method',
    payload: {
      type: 'session/event',
      sessionId: 'ignored',
      event: { type: 'turn/end', seq: 2 },
    },
  });
  await eventually(() => events.length === 1);

  sockets[0].close();
  await eventually(() => reconnects === 2);
  assert.equal(settled, false, 'a dropped socket must not complete the watcher');
  sockets[1].frame({
    type: 'server-request',
    rpcId: 'event-two',
    method: 'session/event',
    payload: {
      type: 'session/event',
      sessionId: 'session-two',
      event: { type: 'turn/end', seq: 3 },
    },
  });
  await eventually(() => events.length === 2);

  assert.deepEqual(socketUrls, [
    'ws://127.0.0.1:3080/api/events.mux',
    'ws://127.0.0.1:3080/api/events.mux',
  ]);
  assert.deepEqual(events.map(({ sessionId, event }) => [sessionId, event.seq]), [
    ['session-one', 1],
    ['session-two', 3],
  ]);
  controller.abort();
  await watching;
  assert.equal(sockets[1].readyState, 3);
  assert.equal(settled, true);
});

test('HarnessClient lists only absolute workspace paths', async () => {
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/default-workspace',
  });
  const options = { rpcId: 'feishu-workspace-list' };
  const calls = [];
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
  client.ensureRunning = async () => { calls.push({ method: 'ensureRunning' }); };
  client.rpc = async (method, payload, timeoutMs, rpcOptions) => {
    calls.push({ method, payload, timeoutMs, options: rpcOptions });
    return response;
  };

  assert.deepEqual(await client.listWorkspaces(options), [
    '/tmp/workspace-one',
    '/tmp/workspace two',
  ]);
  assert.deepEqual(calls, [
    { method: 'ensureRunning' },
    { method: 'workspace.list', payload: {}, timeoutMs: 30000, options },
  ]);

  response = { items: 'invalid' };
  assert.deepEqual(await client.listWorkspaces(), []);
});

test('HarnessClient lists sessions by workspace accounting in its stored order', async () => {
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/default-workspace',
  });
  const options = { rpcId: 'feishu-session-list' };
  const calls = [];
  let invalidWorkspaceResponse = false;
  let invalidSessionResponse = false;
  client.ensureRunning = async () => { calls.push({ method: 'ensureRunning' }); };
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
    { method: 'ensureRunning' },
    { method: 'workspace.list', payload: {}, timeoutMs: 30000, options },
    { method: 'session.list', payload: {}, timeoutMs: 30000, options },
  ]);

  calls.length = 0;
  assert.deepEqual(await client.listWorkspaceSessions('/tmp/unregistered'), {
    workspace: '/tmp/unregistered',
    sessions: [],
  });
  assert.deepEqual(calls, [
    { method: 'ensureRunning' },
    { method: 'workspace.list', payload: {}, timeoutMs: 30000, options: {} },
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

test('HarnessClient adopts one registered ordinary session without changing its preset', async () => {
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/default-workspace',
    agentPreset: 'custom-preset',
  });
  const options = {
    signal: new AbortController().signal,
    rpcId: 'feishu-session-adopt',
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
    { method: 'workspace.list', payload: {}, timeoutMs: 30000, options },
    { method: 'session.list', payload: {}, timeoutMs: 30000, options },
    {
      method: 'session.create',
      payload: { workspaceId: 'workspace-target', sessionId: 'session-target' },
      timeoutMs: 30000,
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

test('HarnessClient reads the nested workspace.create response used by DSH rc.6', async (t) => {
  const methods = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body);
    methods.push(request.method);
    const value = request.method === 'workspace.list'
      ? { items: [], archivedSessionIds: [] }
      : {
          workspace: {
            workspaceId: 'workspace-new',
            path: '/tmp/dsh-feishu-workspace',
          },
          created: true,
        };
    return {
      ok: true,
      async json() {
        return {
          type: 'server-response',
          rpcId: request.rpcId,
          result: { ok: true, value },
        };
      },
    };
  });

  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/dsh-feishu-workspace',
    agentPreset: 'standard',
    autostart: false,
    dshBin: 'dsh',
  });

  assert.equal(await client.workspaceId(), 'workspace-new');
  assert.deepEqual(methods, ['workspace.list', 'workspace.create']);
});

test('HarnessClient asks do not control file-return tool availability', async () => {
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/dsh-feishu-workspace',
  });
  client.ensureRunning = async () => undefined;
  let promptRpcId;
  let prompted = false;
  const agent = {
    session: {
      header: { id: 'session-artifact-availability', cwd: '/tmp/dsh-feishu-workspace' },
      events: [],
    },
  };
  client.rpc = async (method, _payload, _timeoutMs, options) => {
    if (method === 'session.history' && !prompted) return { events: [] };
    if (method === 'session.prompt') {
      prompted = true;
      promptRpcId = options.rpcId;
      agent.session.events = [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { turn: 1, source: { rpcId: promptRpcId } } },
      ];
      return {};
    }
    return {
      events: [
        { event: { type: 'turn/start', seq: 1, data: { turn: 1 } } },
        {
          event: {
            type: 'user/message',
            seq: 2,
            data: { turn: 1, source: { rpcId: promptRpcId } },
          },
        },
        {
          event: {
            type: 'assistant/message',
            seq: 3,
            data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'done' }] } },
          },
        },
        { event: { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } } },
      ],
    };
  };

  assert.equal(await client.ask('session-artifact-availability', 'create a file', {
    onArtifact: async () => undefined,
  }), 'done');
});

test('HarnessClient stages inbound files, appends a neutral manifest, and cleans after turn end', async () => {
  const inboundSources = [{ name: '用户报告.bin', load: async () => Buffer.from('bytes') }];
  const ingressCalls = [];
  let cleanupCalls = 0;
  let promptPayload;
  let promptRpcId;
  let prompted = false;
  const stagedFiles = [{
    name: '用户报告.bin',
    path: '.dsh-im/inbound/turn-abc/01-用户报告.bin',
    mediaType: 'application/octet-stream',
  }];
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/must-not-select-the-session-cwd',
    fileIngressExecutor: async (request) => {
      ingressCalls.push(request);
      return {
        files: stagedFiles,
        async cleanup() { cleanupCalls += 1; },
      };
    },
  });
  client.ensureRunning = async () => undefined;
  client.rpc = async (method, payload, _timeoutMs, options) => {
    if (method === 'session.history' && !prompted) return { events: [] };
    if (method === 'session.list') {
      return { items: [{ sessionId: 'session-inbound-files', cwd: '/tmp/exact-session-cwd' }] };
    }
    if (method === 'session.prompt') {
      prompted = true;
      promptPayload = payload;
      promptRpcId = options.rpcId;
      assert.equal(cleanupCalls, 0, 'files remain available while the prompt is running');
      return {};
    }
    return {
      events: [
        { event: { type: 'turn/start', seq: 1, data: { turn: 3 } } },
        {
          event: {
            type: 'user/message',
            seq: 2,
            data: { turn: 3, source: { rpcId: promptRpcId } },
          },
        },
        {
          event: {
            type: 'assistant/message',
            seq: 3,
            data: {
              turn: 3,
              step: 1,
              message: { content: [{ type: 'text', text: '已读取附件。' }] },
            },
          },
        },
        { event: { type: 'turn/end', seq: 4, data: { turn: 3, reason: { kind: 'completed' } } } },
      ],
    };
  };

  assert.equal(await client.ask('session-inbound-files', '请查看附件', {
    files: inboundSources,
  }), '已读取附件。');

  assert.equal(ingressCalls.length, 1);
  assert.equal(ingressCalls[0].sessionId, 'session-inbound-files');
  assert.equal(ingressCalls[0].workspace, '/tmp/exact-session-cwd');
  assert.deepEqual(ingressCalls[0].files, inboundSources);
  assert.equal(ingressCalls[0].files[0], inboundSources[0]);
  assert.equal(ingressCalls[0].signal, undefined);
  assert.equal(promptPayload.sessionId, 'session-inbound-files');
  assert.equal(promptPayload.mode, 'queue');
  assert.equal(promptPayload.content.length, 1);
  assert.equal(promptPayload.content[0].type, 'text');
  const promptText = promptPayload.content[0].text;
  assert.match(promptText, /^请查看附件\n\n<dsh_im_files>\n/);
  assert.match(promptText, /\n<\/dsh_im_files>$/);
  const manifest = JSON.parse(promptText.match(/<dsh_im_files>\n(.+)\n<\/dsh_im_files>$/s)[1]);
  assert.deepEqual(manifest, {
    description: 'Files uploaded with this user message. Paths are relative to the current Harness workspace.',
    files: stagedFiles,
  });
  assert.doesNotMatch(promptText, /summari[sz]e|解析|总结|处理这些文件/i);
  assert.equal(cleanupCalls, 1);
});

test('HarnessClient cleans staged inbound files when session.prompt rejects them', async () => {
  const promptFailure = new Error('Harness rejected prompt');
  let cleanupCalls = 0;
  let prompted = false;
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/default-workspace',
    fileIngressExecutor: async () => ({
      files: [{ name: 'rejected.dat', path: '.dsh-im/inbound/turn-rejected/01-rejected.dat' }],
      async cleanup() { cleanupCalls += 1; },
    }),
  });
  client.ensureRunning = async () => undefined;
  client.rpc = async (method) => {
    if (method === 'session.history' && !prompted) return { events: [] };
    if (method === 'session.list') {
      return { items: [{ sessionId: 'session-rejected-file', cwd: '/tmp/rejected-cwd' }] };
    }
    assert.equal(method, 'session.prompt');
    prompted = true;
    throw promptFailure;
  };

  await assert.rejects(
    client.ask('session-rejected-file', '', {
      files: [{ name: 'rejected.dat', data: Buffer.from('bytes') }],
    }),
    (error) => error === promptFailure,
  );
  assert.equal(cleanupCalls, 1);
});

test('HarnessClient retains staged files when an accepted turn outcome is unknown', async () => {
  const uncertainFailure = new Error('history transport failed after prompt acceptance');
  let cleanupCalls = 0;
  let prompted = false;
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/default-workspace',
    fileIngressExecutor: async () => ({
      files: [{ name: 'uncertain.dat', path: '.dsh-im/inbound/turn-unknown/01-uncertain.dat' }],
      async cleanup() { cleanupCalls += 1; },
    }),
  });
  client.ensureRunning = async () => undefined;
  client.rpc = async (method) => {
    if (method === 'session.history' && !prompted) return { events: [] };
    if (method === 'session.list') {
      return { items: [{ sessionId: 'session-uncertain-file', cwd: '/tmp/uncertain-cwd' }] };
    }
    if (method === 'session.prompt') {
      prompted = true;
      return { accepted: true };
    }
    assert.equal(method, 'session.history');
    throw uncertainFailure;
  };

  await assert.rejects(
    client.ask('session-uncertain-file', 'use the attached file', {
      files: [{ name: 'uncertain.dat', data: Buffer.from('bytes') }],
      timeoutMs: 1_000,
    }),
    (error) => error === uncertainFailure,
  );
  assert.equal(cleanupCalls, 0, 'uncertain accepted turns may still be reading the staged path');
});

test('HarnessClient delivers an existing file-only Turn directly', async (t) => {
  outboundArtifactRegistry.clear();
  t.after(() => outboundArtifactRegistry.clear());
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-im-file-only-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace,
  });
  client.ensureRunning = async () => undefined;
  const tool = createOutboundArtifactTool({ registry: outboundArtifactRegistry });
  const delivered = [];
  await writeFile(join(workspace, 'file-only.txt'), 'file only');
  let promptRpcId;
  let prompted = false;
  const agent = {
    session: {
      header: { id: 'session-file-only', cwd: workspace },
      events: [],
    },
  };
  client.rpc = async (method, _payload, _timeoutMs, options) => {
    if (method === 'session.history' && !prompted) return { events: [] };
    if (method === 'session.prompt') {
      prompted = true;
      promptRpcId = options.rpcId;
      agent.session.events = [
        { type: 'turn/start', data: { turn: 2 } },
        { type: 'user/message', data: { turn: 2, source: { rpcId: promptRpcId } } },
      ];
      const exec = {
        name: OUTBOUND_ARTIFACT_TOOL,
        callId: 'file-only-call',
        token: Symbol('file-only-call'),
        agent,
        signal: new AbortController().signal,
      };
      await tool.definition.execute({ path: 'file-only.txt' }, exec);
      tool.onResult(exec, { isError: false });
      return {};
    }
    return {
      events: [
        { event: { type: 'turn/start', seq: 1, data: { turn: 2 } } },
        {
          event: {
            type: 'user/message',
            seq: 2,
            data: { turn: 2, source: { rpcId: promptRpcId } },
          },
        },
        { event: { type: 'turn/end', seq: 3, data: { turn: 2, reason: { kind: 'completed' } } } },
      ],
    };
  };

  const answer = await client.ask('session-file-only', 'create and return a file', {
    onArtifact: async (artifact) => delivered.push(artifact),
  });
  assert.equal(answer, '');
  assert.equal(delivered.length, 1);
  const file = await materializeOutboundArtifact(delivered[0]);
  assert.equal(file.bytes.toString(), 'file only');
  releaseOutboundArtifact(delivered[0]);
});

test('HarnessReplyTracker correlates the prompt and emits only answer text', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: 'prompt-1', afterSeq: 10 });

  assert.equal(tracker.consume([
    { event: { type: 'turn/start', seq: 11, data: { turn: 4 } } },
    { event: {
      type: 'user/message',
      seq: 12,
      data: { source: { rpcId: 'someone-else' } },
    } },
    { event: {
      type: 'assistant/chunk',
      seq: 13,
      data: { turn: 4, step: 1, chunk: { type: 'text-delta', index: 0, text: '忽略' } },
    } },
    { event: { type: 'turn/end', seq: 14, data: { turn: 4, reason: { kind: 'completed' } } } },
  ]), null);
  assert.equal(tracker.finished, false);

  const first = tracker.consume([
    { event: { type: 'turn/start', seq: 15, data: { turn: 5 } } },
    { event: {
      type: 'user/message',
      seq: 16,
      data: { source: { rpcId: 'prompt-1' } },
    } },
    { event: {
      type: 'assistant/chunk',
      seq: 17,
      data: { turn: 5, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '不能泄露' } },
    } },
    { event: {
      type: 'assistant/chunk',
      seq: 18,
      data: { turn: 5, step: 1, chunk: { type: 'text-delta', index: 1, text: '深圳' } },
    } },
  ]);
  assert.deepEqual(first, { type: 'text', text: '深圳' });

  const second = tracker.consume([
    { event: {
      type: 'assistant/chunk',
      seq: 18,
      data: { turn: 5, step: 1, chunk: { type: 'text-delta', index: 1, text: '重复' } },
    } },
    { event: {
      type: 'assistant/chunk',
      seq: 19,
      data: { turn: 5, step: 1, chunk: { type: 'text-delta', index: 1, text: '明天有雨' } },
    } },
  ]);
  assert.deepEqual(second, { type: 'text', text: '深圳明天有雨' });

  const final = tracker.consume([
    { event: {
      type: 'assistant/message',
      seq: 20,
      data: {
        turn: 5,
        step: 1,
        message: { content: [
          { type: 'reasoning', text: '仍然不能泄露' },
          { type: 'text', text: '深圳明天有阵雨。' },
        ] },
      },
    } },
    { event: { type: 'turn/end', seq: 21, data: { turn: 5, reason: { kind: 'completed' } } } },
  ]);
  assert.deepEqual(final, { type: 'text', text: '深圳明天有阵雨。' });
  assert.equal(tracker.finished, true);
  assert.equal(tracker.answer, '深圳明天有阵雨。');
  assert.deepEqual(tracker.reason, { kind: 'completed' });
});

test('HarnessReplyTracker emits tool progress without exposing tool results', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: 'prompt-tool' });
  const update = tracker.consume([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { source: { rpcId: 'prompt-tool' } } },
    { type: 'tool/call', seq: 3, data: { turn: 1, step: 1, name: 'web_search' } },
  ]);
  assert.deepEqual(update, { type: 'tool', name: 'web_search' });

  assert.deepEqual(tracker.consume([
    { type: 'tool/result', seq: 4, data: { turn: 1, step: 1, secret: 'not rendered' } },
  ]), { type: 'status', text: '正在整理结果…', toolName: 'web_search' });
});

test('HarnessReplyTracker keeps every frame of a batched turn in order', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: 'prompt-batch' });
  const updates = tracker.consumeAll([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { source: { rpcId: 'prompt-batch' } } },
    { type: 'assistant/chunk', seq: 3, data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: '先创建再观察：' } } },
    { type: 'tool/call', seq: 4, data: { turn: 1, step: 1, name: 'add_observations' } },
    { type: 'tool/result', seq: 5, data: { turn: 1, step: 1, error: { message: 'Status code: 404.' } } },
    { type: 'tool/call', seq: 6, data: { turn: 1, step: 2, name: 'create_entities' } },
  ]);
  assert.deepEqual(updates, [
    { type: 'text', text: '先创建再观察：' },
    { type: 'tool', name: 'add_observations' },
    { type: 'status', text: '正在整理结果…', toolName: 'add_observations', error: 'Status code: 404.' },
    { type: 'tool', name: 'create_entities' },
  ]);
  assert.equal(tracker.answer, '先创建再观察：');
});

test('new turn events renew the stall window beyond the original fixed deadline', async () => {
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/dsh-feishu-workspace',
  });
  client.ensureRunning = async () => undefined;
  let promptRpcId;
  let prompted = false;
  let seq = 0;
  let historyPolls = 0;
  let sessionListPolls = 0;
  const events = [];
  client.rpc = async (method, _payload, _timeoutMs, options) => {
    if (method === 'session.history') {
      if (!prompted) return { events: [] };
      historyPolls += 1;
      if (historyPolls === 1) {
        events.push(
          { type: 'turn/start', seq: ++seq, data: { turn: 1 } },
          { type: 'user/message', seq: ++seq, data: { turn: 1, source: { rpcId: promptRpcId } } },
          { type: 'assistant/chunk', seq: ++seq, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '第一段' } } },
        );
      } else if (historyPolls === 2) {
        events.push(
          { type: 'assistant/chunk', seq: ++seq, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '第二段' } } },
        );
      } else if (historyPolls === 3) {
        events.push(
          { type: 'assistant/message', seq: ++seq, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '最终结果' }] } } },
          { type: 'turn/end', seq: ++seq, data: { turn: 1, reason: { kind: 'completed' } } },
        );
      }
      return { events: events.map((event) => ({ event })) };
    }
    if (method === 'session.prompt') {
      prompted = true;
      promptRpcId = options.rpcId;
      return {};
    }
    if (method === 'session.list') {
      sessionListPolls += 1;
      return { items: [{ sessionId: 'session-renewal-events', running: false }] };
    }
    throw new Error(`unexpected rpc ${method}`);
  };

  // The third poll lands around 900ms. The old 450ms fixed deadline exits after
  // the second poll; the stall window reaches the third poll because seq advances.
  const answer = await client.ask('session-renewal-events', 'long task', {
    timeoutMs: 450,
    control: { owner: {}, key: 'route' },
  });
  assert.equal(answer, '最终结果');
  assert.equal(historyPolls, 3);
  assert.equal(sessionListPolls, 0);
});

test('a production-owned turn that starts and then stalls still times out', async () => {
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/dsh-feishu-workspace',
  });
  client.ensureRunning = async () => undefined;
  let promptRpcId;
  let prompted = false;
  let historyPolls = 0;
  let sessionListPolls = 0;
  let events = [];
  client.rpc = async (method, _payload, _timeoutMs, options) => {
    if (method === 'session.history') {
      if (!prompted) return { events: [] };
      historyPolls += 1;
      if (historyPolls === 1) {
        events = [
          { event: { type: 'turn/start', seq: 1, data: { turn: 1 } } },
          { event: { type: 'user/message', seq: 2, data: { turn: 1, source: { rpcId: promptRpcId } } } },
        ];
      }
      return { events };
    }
    if (method === 'session.prompt') {
      prompted = true;
      promptRpcId = options.rpcId;
      return {};
    }
    if (method === 'session.list') {
      sessionListPolls += 1;
      return { items: [{ sessionId: 'session-stalled-owned', running: false }] };
    }
    throw new Error(`unexpected rpc ${method}`);
  };

  await assert.rejects(
    client.ask('session-stalled-owned', 'stall after starting', {
      timeoutMs: 120,
      control: { owner: {}, key: 'route' },
    }),
    (error) => error?.code === 'harness-reply-timeout',
    'stale control ownership must not keep a stalled turn alive',
  );
  assert.equal(historyPolls, 2);
  assert.equal(sessionListPolls, 1);
});

test('a silent turn renews only after Harness confirms the Session is running', async () => {
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/dsh-feishu-workspace',
  });
  client.ensureRunning = async () => undefined;
  let promptRpcId;
  let prompted = false;
  let historyPolls = 0;
  let sessionListPolls = 0;
  const events = [];
  client.rpc = async (method, _payload, _timeoutMs, options) => {
    if (method === 'session.history') {
      if (!prompted) return { events: [] };
      historyPolls += 1;
      if (historyPolls === 1) {
        events.push(
          { event: { type: 'turn/start', seq: 1, data: { turn: 1 } } },
          { event: { type: 'user/message', seq: 2, data: { turn: 1, source: { rpcId: promptRpcId } } } },
        );
      } else if (historyPolls === 3) {
        events.push(
          { event: { type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '静默任务完成' }] } } } },
          { event: { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } } },
        );
      }
      return { events };
    }
    if (method === 'session.prompt') {
      prompted = true;
      promptRpcId = options.rpcId;
      return {};
    }
    if (method === 'session.list') {
      sessionListPolls += 1;
      return { items: [{ sessionId: 'session-silent-running', running: true }] };
    }
    throw new Error(`unexpected rpc ${method}`);
  };

  const answer = await client.ask('session-silent-running', 'silent long task', {
    timeoutMs: 120,
    control: { owner: {}, key: 'route' },
  });
  assert.equal(answer, '静默任务完成');
  assert.equal(historyPolls, 3);
  assert.equal(sessionListPolls, 1);
});

test('a failed liveness probe does not renew a stalled turn', async () => {
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/dsh-feishu-workspace',
  });
  client.ensureRunning = async () => undefined;
  let prompted = false;
  let promptRpcId;
  let historyPolls = 0;
  let sessionListPolls = 0;
  let events = [];
  client.rpc = async (method, _payload, _timeoutMs, options) => {
    if (method === 'session.history') {
      if (!prompted) return { events: [] };
      historyPolls += 1;
      if (historyPolls === 1) {
        events = [
          { event: { type: 'turn/start', seq: 1, data: { turn: 1 } } },
          { event: { type: 'user/message', seq: 2, data: { turn: 1, source: { rpcId: promptRpcId } } } },
        ];
      }
      return { events };
    }
    if (method === 'session.prompt') {
      prompted = true;
      promptRpcId = options.rpcId;
      return {};
    }
    if (method === 'session.list') {
      sessionListPolls += 1;
      throw new Error('probe unavailable');
    }
    throw new Error(`unexpected rpc ${method}`);
  };

  await assert.rejects(
    client.ask('session-probe-fails', 'stall after starting', {
      timeoutMs: 120,
      control: { owner: {}, key: 'route' },
    }),
    (error) => error?.code === 'harness-reply-timeout',
  );
  assert.equal(historyPolls, 2);
  assert.equal(sessionListPolls, 1);
});
