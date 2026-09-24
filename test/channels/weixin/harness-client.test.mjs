import assert from 'node:assert/strict';
import test from 'node:test';

import { DiscordHarnessClient } from '../../../src/channels/discord/harness-client.mjs';
import { QqHarnessClient } from '../../../src/channels/qq/harness-client.mjs';
import { SlackHarnessClient } from '../../../src/channels/slack/harness-client.mjs';
import { TelegramHarnessClient } from '../../../src/channels/telegram/harness-client.mjs';
import { WecomHarnessClient } from '../../../src/channels/wecom/harness-client.mjs';
import {
  HarnessHealthError,
  HarnessTransportError,
} from '../../../src/channels/shared/harness-client.mjs';
import { HarnessClient, HarnessReplyTracker } from '../../../src/channels/weixin/harness-client.mjs';
import { WhatsappHarnessClient } from '../../../src/channels/whatsapp/harness-client.mjs';

test('all legacy channel clients now use the shared Harness RPC transport', async () => {
  const channelClients = [
    [HarnessClient, 'weixin'],
    [WecomHarnessClient, 'wecom'],
    [QqHarnessClient, 'qq'],
    [SlackHarnessClient, 'slack'],
    [DiscordHarnessClient, 'discord'],
    [TelegramHarnessClient, 'telegram'],
    [WhatsappHarnessClient, 'whatsapp'],
  ];

  for (const [Client, prefix] of channelClients) {
    let request;
    const client = new Client({
      baseUrl: 'http://127.0.0.1:3080',
      workspace: '/tmp/default-workspace',
      fetchImpl: async (url, options) => {
        request = { url: String(url), ...options, body: JSON.parse(options.body) };
        return {
          ok: true,
          json: async () => ({
            type: 'server-response',
            rpcId: request.body.rpcId,
            result: { ok: true, value: { ready: true } },
          }),
        };
      },
    });

    assert.deepEqual(await client.rpc('host.describe'), { ready: true });
    assert.equal(request.url, 'http://127.0.0.1:3080/api/host.describe');
    assert.match(request.body.rpcId, new RegExp(`^${prefix}-`));
    assert.equal(request.body.type, 'client-request');
  }
});

test('shared Harness health checks expose precise safe availability codes', async () => {
  const clientWithFetch = (fetchImpl, baseUrl = 'http://127.0.0.1:3080') => new HarnessClient({
    baseUrl,
    workspace: '/tmp/default-workspace',
    fetchImpl,
  });

  const privateConnectionError = new Error('ECONNREFUSED at private loopback port');
  await assert.rejects(
    clientWithFetch(async () => { throw privateConnectionError; }).health(),
    (error) => {
      assert.ok(error instanceof HarnessTransportError);
      assert.equal(error.code, 'harness-connect-failed');
      assert.equal(error.cause, privateConnectionError);
      assert.doesNotMatch(error.message, /private loopback port/);
      return true;
    },
  );

  const timeoutClient = clientWithFetch((_url, { signal }) => new Promise((_resolve, reject) => {
    const rejectTimeout = () => reject(signal.reason);
    if (signal.aborted) rejectTimeout();
    else signal.addEventListener('abort', rejectTimeout, { once: true });
  }));
  await assert.rejects(timeoutClient.rpc('host.describe', {}, 1), (error) => {
    assert.ok(error instanceof HarnessTransportError);
    assert.equal(error.code, 'harness-timeout');
    return true;
  });

  for (const [baseUrl, status, responseBody, expectedCode] of [
    ['http://127.0.0.1:3080', 401, 'authentication required', 'harness-auth-required'],
    ['http://127.0.0.1:3080', 407, 'proxy authentication required', 'harness-proxy-auth-required'],
    ['http://127.0.0.1:3080', 403, 'forbidden', 'harness-loopback-forbidden'],
    ['http://127.9.8.7:3080', 403, 'forbidden\n', 'harness-loopback-forbidden'],
    ['http://localhost:3080', 403, 'forbidden', 'harness-loopback-forbidden'],
    ['http://[::1]:3080', 403, 'forbidden', 'harness-loopback-forbidden'],
    ['http://harness.internal:3080', 403, 'forbidden', 'harness-host-untrusted'],
    ['http://127.0.0.1:3080', 403, 'proxy policy rejected: private detail', 'harness-request-forbidden'],
    ['http://127.0.0.1:3080', 404, 'not found', 'harness-api-not-found'],
    ['http://127.0.0.1:3080', 500, 'service unavailable', 'harness-http-failed'],
  ]) {
    await assert.rejects(
      clientWithFetch(async () => new Response(responseBody, { status }), baseUrl).health(),
      (error) => {
        assert.ok(error instanceof HarnessTransportError);
        assert.equal(error.code, expectedCode);
        assert.equal(error.status, status);
        assert.doesNotMatch(error.message, /private detail/);
        return true;
      },
    );
  }

  await assert.rejects(
    clientWithFetch(async () => ({
      ok: true,
      json: async () => { throw new SyntaxError('private malformed response body'); },
    })).health(),
    (error) => {
      assert.ok(error instanceof HarnessTransportError);
      assert.equal(error.code, 'harness-response-invalid');
      assert.doesNotMatch(error.message, /private malformed response body/);
      return true;
    },
  );

  await assert.rejects(
    clientWithFetch(async (_url, options) => {
      const { rpcId } = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          type: 'server-response',
          rpcId,
          result: {
            ok: false,
            error: { code: 'private-host-code', message: 'private Host RPC detail' },
          },
        }),
      };
    }).health(),
    (error) => {
      assert.ok(error instanceof HarnessHealthError);
      assert.equal(error.code, 'harness-rpc-rejected');
      assert.match(error.cause?.message ?? '', /private Host RPC detail/);
      assert.doesNotMatch(error.message, /private-host-code|private Host RPC detail/);
      return true;
    },
  );
});

test('HarnessClient lets the Host resolve an omitted agent preset and forwards an explicit override', async () => {
  const createPayload = async (options = {}) => {
    const client = new HarnessClient({
      baseUrl: 'http://127.0.0.1:3080',
      workspace: '/tmp/default-workspace',
      ...options,
    });
    let payload;
    client.ensureRunning = async () => true;
    client.workspaceId = async () => 'workspace-one';
    client.rpc = async (method, value) => {
      assert.equal(method, 'session.create');
      payload = value;
      return { sessionId: 'session-one' };
    };

    assert.equal(await client.createSession(), 'session-one');
    return payload;
  };

  assert.deepEqual(await createPayload(), { workspaceId: 'workspace-one' });
  assert.deepEqual(await createPayload({ agentPreset: 'router-standard' }), {
    workspaceId: 'workspace-one',
    agentPreset: 'router-standard',
  });
  assert.deepEqual(await createPayload({ agentPreset: null }), { workspaceId: 'workspace-one' });
});

test('HarnessClient forwards a per-session agent preset override', async () => {
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/default-workspace',
    agentPreset: 'router-standard',
  });
  let payload;
  client.ensureRunning = async () => true;
  client.workspaceId = async () => 'workspace-one';
  client.rpc = async (method, value) => {
    assert.equal(method, 'session.create');
    payload = value;
    return { sessionId: 'session-one' };
  };

  assert.equal(await client.createSession({ agentPreset: 'marketing-jeep' }), 'session-one');
  assert.deepEqual(payload, {
    workspaceId: 'workspace-one',
    agentPreset: 'marketing-jeep',
  });
});

test('HarnessClient lists only absolute workspace paths', async () => {
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/default-workspace',
  });
  const options = { rpcId: 'weixin-workspace-list' };
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
    { method: 'workspace.list', payload: {}, timeoutMs: 30_000, options },
  ]);

  response = { items: 'invalid' };
  assert.deepEqual(await client.listWorkspaces(), []);
});

test('HarnessClient lists sessions by workspace accounting in its stored order', async () => {
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/default-workspace',
  });
  const options = { rpcId: 'weixin-session-list' };
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
    { method: 'workspace.list', payload: {}, timeoutMs: 30_000, options },
    { method: 'session.list', payload: {}, timeoutMs: 30_000, options },
  ]);

  calls.length = 0;
  assert.deepEqual(await client.listWorkspaceSessions('/tmp/unregistered'), {
    workspace: '/tmp/unregistered',
    sessions: [],
  });
  assert.deepEqual(calls, [
    { method: 'ensureRunning' },
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

test('HarnessClient adopts one registered ordinary session without changing its preset', async () => {
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/default-workspace',
    agentPreset: 'custom-preset',
  });
  const options = {
    signal: new AbortController().signal,
    rpcId: 'weixin-session-adopt',
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

test('reply tracker associates only the Harness turn created by the Weixin prompt RPC', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: 'weixin-prompt', afterSeq: 2 });
  const first = tracker.consume([
    { event: { seq: 3, type: 'turn/start', data: { turn: 9 } } },
    { event: {
      seq: 4,
      type: 'user/message',
      data: { turn: 9, source: { rpcId: 'weixin-prompt' } },
    } },
    { event: {
      seq: 5,
      type: 'assistant/chunk',
      data: { turn: 9, step: 0, chunk: { type: 'text-delta', index: 0, text: '微信' } },
    } },
  ]);
  assert.deepEqual(first, { type: 'text', text: '微信' });
  tracker.consume([
    { event: {
      seq: 6,
      type: 'assistant/message',
      data: { turn: 9, message: { content: [{ type: 'text', text: '微信回复完成' }] } },
    } },
    { event: { seq: 7, type: 'turn/end', data: { turn: 9, reason: 'completed' } } },
  ]);
  assert.equal(tracker.finished, true);
  assert.equal(tracker.answer, '微信回复完成');
});

test('reply tracker ignores interleaved turns and older events', () => {
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
