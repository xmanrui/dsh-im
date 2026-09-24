import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { OfficeConfigStore } from '../../../src/channels/office/config-store.mjs';
import { OfficeController } from '../../../src/channels/office/office-controller.mjs';
import { OfficeTransport } from '../../../src/channels/office/office-transport.mjs';
import { OfficeJobExecutor } from '../../../src/channels/office/office-job-executor.mjs';
import { OfficeRuntime } from '../../../src/channels/office/office-runtime.mjs';
import {
  OFFICE_PROTOCOL_VERSION,
  OFFICE_RPC_ENDPOINTS,
  officeHookUrls,
} from '../../../src/channels/office/protocol.mjs';
import { createOfficeRpcHandler } from '../../../plugin-src/host/channels/office/rpc.mjs';
import { OfficeSettingsTab } from '../../../plugin-src/client/channels/office/index.js';
import { assertRestrictiveMode } from '../../support/filesystem.mjs';

const TOKEN = 'office-device-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ-123456';

async function eventually(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition did not become true');
}

function controlledSleep() {
  const calls = [];
  const sleep = (delay, _value, { signal } = {}) => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(
      reject,
      signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'),
    );
    const call = {
      delay,
      get settled() { return settled; },
      resolve: () => finish(resolve),
    };
    calls.push(call);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
  return { calls, sleep };
}

function pendingUntilAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', () => {
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    }, { once: true });
  });
}

function config(overrides = {}) {
  return {
    version: 1,
    baseUrl: 'https://office.example.com',
    deviceId: 'mac-a004',
    deviceTokenRef: 'DSH_OFFICE_DEVICE_TOKEN_1234567890ABCDEF12345678',
    maxConcurrency: 1,
    heartbeatSeconds: 30,
    workspaces: { 'office-project': '/Users/a004/glassespaw-ai-office-web' },
    instructionPresets: { 'action-items': 'Convert into executable action items.' },
    ...overrides,
  };
}

function credentials() {
  const values = new Map();
  return {
    values,
    resolve: async (ref) => values.has(ref) ? { value: values.get(ref), source: 'test' } : undefined,
    set: async (ref, value) => values.set(ref, value),
    unset: async (ref) => values.delete(ref),
  };
}

test('AI Office protocol derives every fixed hook from one HTTPS origin', () => {
  const hooks = officeHookUrls('https://office.example.com');
  assert.equal(OFFICE_PROTOCOL_VERSION, 'office-harness.v1');
  assert.equal(hooks.stream, 'https://office.example.com/api/harness/connector/stream');
  assert.equal(hooks.result, 'https://office.example.com/api/harness/connector/jobs/:id/result');
  assert.throws(() => officeHookUrls('http://public.example'), /must use HTTPS/);
  assert.equal(officeHookUrls('http://127.0.0.1:4300').heartbeat, 'http://127.0.0.1:4300/api/harness/connector/heartbeat');
});

test('AI Office config persists safe aliases without a Device Token', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-office-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json');
  const store = await new OfficeConfigStore(path).load();
  await store.save(config());
  const raw = await readFile(path, 'utf8');
  assert.doesNotMatch(raw, /office-device-token/);
  assert.match(raw, /office-project/);
  await assertRestrictiveMode(path, 0o600);
  assert.deepEqual(store.get().workspaces, { 'office-project': '/Users/a004/glassespaw-ai-office-web' });
  await assert.rejects(() => store.save(config({ workspaces: { unsafe: 'relative/path' } })), /invalid/);
});

test('AI Office transport authenticates heartbeat and parses SSE frames', async () => {
  const calls = [];
  const encoder = new TextEncoder();
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/heartbeat')) {
      return Response.json({ ok: true, protocolVersion: OFFICE_PROTOCOL_VERSION });
    }
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('id: evt-1\nevent: job.available\ndata: {"type":"job.available","jobId":"job-1"}\n\n'));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const transport = new OfficeTransport({
    baseUrl: 'https://office.example.com', deviceId: 'mac-a004', token: TOKEN, fetchImpl,
  });
  await transport.heartbeat({ protocolVersion: OFFICE_PROTOCOL_VERSION });
  const events = [];
  await assert.rejects(() => transport.stream({ onEvent: (event) => events.push(event) }), /stream ended/);
  assert.equal(calls[0].options.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].options.headers['x-harness-device-id'], 'mac-a004');
  assert.deepEqual(events, [{
    id: 'evt-1', type: 'job.available', data: { type: 'job.available', jobId: 'job-1' },
  }]);
});

test('AI Office transport uses fixed Job hooks and keeps the lease outside JSON bodies', async () => {
  const calls = [];
  const transport = new OfficeTransport({
    baseUrl: 'https://office.example.com',
    deviceId: 'mac-a004',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return Response.json({ ok: true });
    },
  });
  const jobId = 'job-1234567890abcdef1234567890abcdef';
  await transport.getJob(jobId);
  await transport.acceptJob(jobId);
  await transport.progressJob(jobId, 'lease-secret', { kind: 'status', message: 'running' });
  assert.equal(calls[0].url, `https://office.example.com/api/harness/connector/jobs/${jobId}`);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[1].url.endsWith(`/${jobId}/accept`), true);
  assert.equal(calls[2].options.headers['x-harness-lease-token'], 'lease-secret');
  assert.equal(calls[2].options.body.includes('lease-secret'), false);
});

test('AI Office transport satisfies the loopback Office HTTP and SSE contract', async (t) => {
  const jobId = 'job-1234567890abcdef1234567890abcdef';
  const leaseToken = 'lease-local-contract-1234567890';
  const records = [];
  const json = (response, value, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const path = new URL(request.url, 'http://127.0.0.1').pathname;
      records.push({
        path,
        method: request.method,
        headers: { ...request.headers },
        body: rawBody ? JSON.parse(rawBody) : undefined,
      });
      if (path.endsWith('/heartbeat')) {
        json(response, { ok: true, protocolVersion: OFFICE_PROTOCOL_VERSION, jobs: [] });
        return;
      }
      if (path.endsWith('/stream')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end([
          `id: evt-available\nevent: job.available\ndata: {"type":"job.available","jobId":"${jobId}"}\n\n`,
          `id: evt-approval\nevent: approval.reply\ndata: {"type":"approval.reply","jobId":"${jobId}","approvalId":"approval-local","decision":"approved"}\n\n`,
          `id: evt-cancel\nevent: job.cancel\ndata: {"type":"job.cancel","jobId":"${jobId}"}\n\n`,
        ].join(''));
        return;
      }
      if (path === `/api/harness/connector/jobs/${jobId}`) {
        json(response, { job: { id: jobId } });
        return;
      }
      if (path.endsWith('/accept')) {
        json(response, { leaseToken });
        return;
      }
      if (/\/(renew|progress|approval|result|fail)$/.test(path)) {
        json(response, { ok: true });
        return;
      }
      json(response, { error: 'not-found' }, 404);
    })().catch((error) => {
      json(response, { error: error.message }, 500);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const transport = new OfficeTransport({
    baseUrl: `http://127.0.0.1:${address.port}`,
    deviceId: 'local-contract-device',
    token: TOKEN,
  });

  await transport.heartbeat({ protocolVersion: OFFICE_PROTOCOL_VERSION });
  const events = [];
  let opened = false;
  await assert.rejects(() => transport.stream({
    lastEventId: 'evt-previous',
    onOpen: () => { opened = true; },
    onEvent: (event) => events.push(event),
  }), /stream ended/);
  await transport.getJob(jobId);
  assert.equal((await transport.acceptJob(jobId)).leaseToken, leaseToken);
  await transport.renewJob(jobId, leaseToken);
  await transport.progressJob(jobId, leaseToken, { kind: 'status', message: 'running' });
  await transport.requestApproval(jobId, leaseToken, { id: 'approval-local', kind: 'approval' });
  await transport.completeJob(jobId, leaseToken, { resultMarkdown: 'done', sessionId: 'session-local' });
  await transport.failJob(jobId, leaseToken, { error: 'contract-only failure payload' });

  assert.equal(opened, true);
  assert.deepEqual(events.map((event) => event.type), [
    'job.available', 'approval.reply', 'job.cancel',
  ]);
  assert.ok(records.every((record) => record.headers.authorization === `Bearer ${TOKEN}`));
  assert.ok(records.every((record) => record.headers['x-harness-device-id'] === 'local-contract-device'));
  assert.equal(records.find((record) => record.path.endsWith('/stream')).headers['last-event-id'], 'evt-previous');
  const leased = records.filter((record) => /\/(renew|progress|approval|result|fail)$/.test(record.path));
  assert.equal(leased.length, 5);
  for (const record of leased) {
    assert.equal(record.headers['x-harness-lease-token'], leaseToken);
    assert.equal(JSON.stringify(record.body ?? null).includes(leaseToken), false);
  }
  assert.equal(records.find((record) => record.path.endsWith('/progress')).body.message, 'running');
  assert.equal(records.find((record) => record.path.endsWith('/result')).body.resultMarkdown, 'done');
  assert.equal(records.find((record) => record.path.endsWith('/approval')).body.id, 'approval-local');
});

test('AI Office controller stores the token in credentials and returns only safe status', async () => {
  let stored = null;
  const credentialStore = credentials();
  const runtimes = [];
  const controller = new OfficeController({
    credentials: credentialStore,
    configStore: {
      get: () => stored,
      save: async (value) => { stored = structuredClone(value); return stored; },
      clear: async () => { stored = null; },
    },
    createRuntime: (options) => {
      const runtime = {
        options,
        status: { state: 'connected', connected: true, reconnects: 0 },
        start() {},
        stop: async () => {},
        testConnection: async () => ({ ok: true }),
      };
      runtimes.push(runtime);
      return runtime;
    },
  });
  const status = await controller.configure({
    baseUrl: 'https://office.example.com', deviceId: 'mac-a004', deviceToken: TOKEN,
    maxConcurrency: 1, heartbeatSeconds: 30,
    workspaces: { 'office-project': '/Users/a004/project' },
    instructionPresets: { 'action-items': 'Make tasks.' },
  });
  assert.equal(status.connected, true);
  assert.equal(status.tokenConfigured, true);
  assert.equal(JSON.stringify(status).includes(TOKEN), false);
  assert.equal(credentialStore.values.size, 1);
  assert.equal(runtimes[0].options.token, TOKEN);
  await controller.remove();
  assert.equal(credentialStore.values.size, 0);
});

test('AI Office controller normalizes the origin and tolerates a missing local credential on startup', async () => {
  const credentialStore = credentials();
  let stored = config();
  const configStore = {
    get: () => stored,
    save: async (value) => { stored = structuredClone(value); return stored; },
    clear: async () => { stored = null; },
  };
  const controller = new OfficeController({
    credentials: credentialStore,
    configStore,
    createRuntime: () => ({
      status: { state: 'connected', connected: true },
      start() {},
      stop: async () => {},
    }),
  });
  const initial = await controller.initialize();
  assert.equal(initial.configured, true);
  assert.equal(initial.state, 'missing-token');

  await controller.configure({
    baseUrl: 'https://office.example.com/path/', deviceId: 'mac-a004', deviceToken: TOKEN,
    maxConcurrency: 1, heartbeatSeconds: 30, workspaces: {}, instructionPresets: {},
  });
  assert.equal(stored.baseUrl, 'https://office.example.com');
  assert.equal(credentialStore.values.size, 1);
  await controller.close();
});

test('AI Office RPC validates configuration and keeps transport failures safe', async () => {
  const calls = [];
  const handler = createOfficeRpcHandler({
    status: async () => ({ configured: false }),
    configure: async (payload) => { calls.push(payload); return { configured: true }; },
    reconnect: async () => ({ configured: true }),
    test: async () => { const error = new Error('HTTP 404 internal URL'); error.code = 'office-hook-unavailable'; throw error; },
    remove: async () => ({ configured: false }),
  });
  assert.deepEqual(await handler(OFFICE_RPC_ENDPOINTS.configure, { baseUrl: 'x' }), {
    ok: false, error: { code: 'bad-request', message: 'Invalid AI Office connector request.' },
  });
  assert.equal((await handler(OFFICE_RPC_ENDPOINTS.configure, {
    baseUrl: 'https://office.example.com', deviceId: 'mac-a004', deviceToken: TOKEN,
    workspaces: {}, instructionPresets: {},
  })).ok, true);
  assert.equal(calls.length, 1);
  const result = await handler(OFFICE_RPC_ENDPOINTS.test, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'office-hook-unavailable');
  assert.equal(result.error.message, 'AI Office Hook 尚未上线或地址不正确。');
  assert.equal(result.error.details.stage, 'connection.test');
  assert.match(result.error.details.referenceId, /^IM-CONN-[A-F0-9]{8}$/);
  assert.doesNotMatch(JSON.stringify(result), /internal URL/);
});

test('AI Office settings renders connection fields and fixed hook preview', () => {
  const markup = renderToStaticMarkup(React.createElement(OfficeSettingsTab, {
    rpcCall: async () => ({ ok: true, value: { configured: false } }),
    initialStatus: { configured: false },
  }));
  assert.match(markup, /AI Office Connector/);
  assert.match(markup, /Office Base URL/);
  assert.match(markup, /<input placeholder="https:\/\/office\.example\.com" value=""\/>/);
  assert.doesNotMatch(markup, /fission\.gridmind\.ai/);
  assert.match(markup, /Device Token/);
  assert.match(markup, /Workspace 映射/);
  assert.match(markup, /Base URL 无效/);
});

test('AI Office Job executor claims, reports, approves, and returns one Harness result', async () => {
  const jobId = 'job-1234567890abcdef1234567890abcdef';
  const progress = [];
  const approvals = [];
  const results = [];
  const responses = [];
  let executor;
  const transport = {
    getJob: async () => ({ job: {
      id: jobId,
      workspaceAlias: 'office-project',
      instructionPreset: 'execute',
      instruction: 'Return evidence.',
      markdown: '# Office timeline',
    } }),
    acceptJob: async () => ({ leaseToken: 'lease-token-1234567890' }),
    renewJob: async () => ({ leaseExpiresAt: new Date(Date.now() + 90_000).toISOString() }),
    progressJob: async (_id, _lease, value) => { progress.push(value); return { ok: true }; },
    requestApproval: async (_id, _lease, value) => {
      approvals.push(value);
      queueMicrotask(() => executor.handleEvent({
        type: 'approval.reply',
        data: { jobId, approvalId: value.id, decision: 'approved' },
      }));
      return { ok: true };
    },
    completeJob: async (_id, _lease, value) => { results.push(value); return { ok: true }; },
    failJob: async () => { throw new Error('must not fail'); },
  };
  const harness = {
    createSession: async () => 'session-office-one',
    ask: async (_sessionId, prompt, options) => {
      assert.match(prompt, /Return evidence/);
      await options.onUpdate({ type: 'tool', name: 'apply_patch' });
      await options.onInteraction({
        kind: 'approval',
        interactionId: 'approval-one',
        sessionId: 'session-office-one',
        payload: {
          type: 'approval/requested', sessionId: 'session-office-one',
          approvalId: 'approval-one', toolName: 'apply_patch', callId: 'call-one',
        },
        toolCall: { callId: 'call-one', name: 'apply_patch', arguments: '{"patch":"safe"}' },
        respond: async (value) => { responses.push(value); return { accepted: true }; },
      });
      return '# Completed\n\nVerified.';
    },
    rpc: async () => ({ ok: true }),
  };
  executor = new OfficeJobExecutor({
    config: {
      maxConcurrency: 1,
      workspaces: { 'office-project': '/Users/a004/project' },
      instructionPresets: { execute: 'Execute carefully.' },
    },
    transport,
    createHarness: () => harness,
  });
  assert.equal(executor.offer(jobId), true);
  await eventually(() => executor.status.completed === 1);
  assert.equal(approvals[0].kind, 'approval');
  assert.equal(responses[0].value.outcome, 'allowed-once');
  assert.ok(progress.some((item) => item.kind === 'tool'));
  assert.deepEqual(results, [{ resultMarkdown: '# Completed\n\nVerified.', sessionId: 'session-office-one' }]);
  await executor.close();
});

test('AI Office Job continues when approval polling fails after a successful renewal', async () => {
  const jobId = 'job-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const clock = controlledSleep();
  const warnings = [];
  let getJobCalls = 0;
  let renewals = 0;
  let cancellations = 0;
  let completions = 0;
  let failures = 0;
  let approvalRequests = 0;
  const responses = [];
  const transport = {
    getJob: async () => {
      getJobCalls += 1;
      if (getJobCalls === 1) return { job: {
        id: jobId,
        workspaceAlias: 'office-project',
        instructionPreset: 'execute',
        markdown: '# Poll recovery test',
      } };
      if (getJobCalls === 2) throw new Error('temporary approval poll outage');
      return { job: { approval: {
        id: 'approval-poll-recovery',
        status: 'approved',
      } } };
    },
    acceptJob: async () => ({ leaseToken: 'lease-poll-recovery' }),
    renewJob: async () => { renewals += 1; return { ok: true }; },
    progressJob: async () => ({ ok: true }),
    requestApproval: async () => { approvalRequests += 1; return { ok: true }; },
    completeJob: async () => { completions += 1; return { ok: true }; },
    failJob: async () => { failures += 1; return { ok: true }; },
  };
  const executor = new OfficeJobExecutor({
    config: {
      maxConcurrency: 1,
      workspaces: { 'office-project': '/tmp/office-project' },
      instructionPresets: { execute: 'Execute carefully.' },
    },
    transport,
    createHarness: () => ({
      createSession: async () => 'session-poll-recovery',
      ask: async (_sessionId, _prompt, options) => {
        await options.onInteraction({
          kind: 'approval',
          interactionId: 'approval-poll-recovery',
          sessionId: 'session-poll-recovery',
          payload: {
            type: 'approval/requested',
            sessionId: 'session-poll-recovery',
            approvalId: 'approval-poll-recovery',
            toolName: 'apply_patch',
            callId: 'call-poll-recovery',
          },
          toolCall: {
            callId: 'call-poll-recovery',
            name: 'apply_patch',
            arguments: '{"patch":"safe"}',
          },
          respond: async (value) => { responses.push(value); return { accepted: true }; },
        });
        return '# Completed after transient poll failure';
      },
      rpc: async () => { cancellations += 1; return { ok: true }; },
    }),
    logger: { warn: (...args) => warnings.push(args) },
    sleepImpl: clock.sleep,
  });

  assert.equal(executor.offer(jobId), true);
  await eventually(() => approvalRequests === 1
    && clock.calls.some((call) => call.delay === 30_000 && !call.settled));
  clock.calls.find((call) => call.delay === 30_000 && !call.settled).resolve();
  await eventually(() => renewals === 1 && warnings.length === 1
    && clock.calls.some((call) => call.delay === 30_000 && !call.settled));
  assert.equal(executor.status.running, 1);
  assert.equal(cancellations, 0);
  assert.equal(responses.length, 0);
  assert.match(warnings[0].join(' '), /approval poll failed/);

  clock.calls.find((call) => call.delay === 30_000 && !call.settled).resolve();
  await eventually(() => executor.status.completed === 1);
  assert.equal(getJobCalls, 3);
  assert.equal(renewals, 2);
  assert.equal(responses[0].value.outcome, 'allowed-once');
  assert.equal(completions, 1);
  assert.equal(failures, 0);
  assert.equal(cancellations, 0);
  await executor.close();
});

test('AI Office Job safely cancels the Harness session when lease renewal fails', async () => {
  const jobId = 'job-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const clock = controlledSleep();
  let sessionStarted = false;
  let cancellations = 0;
  let completions = 0;
  let failures = 0;
  const transport = {
    getJob: async () => ({ job: {
      id: jobId,
      workspaceAlias: 'office-project',
      instructionPreset: 'execute',
      markdown: '# Renewal failure test',
    } }),
    acceptJob: async () => ({ leaseToken: 'lease-renew-failure' }),
    renewJob: async () => { throw new Error('lease renewal unavailable'); },
    progressJob: async () => ({ ok: true }),
    completeJob: async () => { completions += 1; return { ok: true }; },
    failJob: async () => { failures += 1; return { ok: true }; },
  };
  const executor = new OfficeJobExecutor({
    config: {
      maxConcurrency: 1,
      workspaces: { 'office-project': '/tmp/office-project' },
      instructionPresets: { execute: 'Execute carefully.' },
    },
    transport,
    createHarness: () => ({
      createSession: async () => 'session-renew-failure',
      ask: async (_sessionId, _prompt, { signal }) => {
        sessionStarted = true;
        return pendingUntilAbort(signal);
      },
      rpc: async (method, payload) => {
        assert.equal(method, 'session.cancel');
        assert.equal(payload.sessionId, 'session-renew-failure');
        cancellations += 1;
        return { ok: true };
      },
    }),
    sleepImpl: clock.sleep,
  });

  assert.equal(executor.offer(jobId), true);
  await eventually(() => sessionStarted
    && clock.calls.some((call) => call.delay === 30_000 && !call.settled));
  clock.calls.find((call) => call.delay === 30_000 && !call.settled).resolve();
  await eventually(() => executor.status.running === 0 && cancellations === 1);
  assert.equal(completions, 0);
  assert.equal(failures, 0);
  await executor.close();
});

test('AI Office job.cancel SSE event stops only the active Harness job', async () => {
  const jobId = 'job-cccccccccccccccccccccccccccccccc';
  const clock = controlledSleep();
  let sessionStarted = false;
  let cancellations = 0;
  let completions = 0;
  let failures = 0;
  const executor = new OfficeJobExecutor({
    config: {
      maxConcurrency: 1,
      workspaces: { 'office-project': '/tmp/office-project' },
      instructionPresets: { execute: 'Execute carefully.' },
    },
    transport: {
      getJob: async () => ({ job: {
        id: jobId,
        workspaceAlias: 'office-project',
        instructionPreset: 'execute',
        markdown: '# Cancellation test',
      } }),
      acceptJob: async () => ({ leaseToken: 'lease-cancellation' }),
      renewJob: async () => ({ ok: true }),
      progressJob: async () => ({ ok: true }),
      completeJob: async () => { completions += 1; return { ok: true }; },
      failJob: async () => { failures += 1; return { ok: true }; },
    },
    createHarness: () => ({
      createSession: async () => 'session-cancellation',
      ask: async (_sessionId, _prompt, { signal }) => {
        sessionStarted = true;
        return pendingUntilAbort(signal);
      },
      rpc: async (method, payload) => {
        assert.equal(method, 'session.cancel');
        assert.equal(payload.sessionId, 'session-cancellation');
        cancellations += 1;
        return { ok: true };
      },
    }),
    sleepImpl: clock.sleep,
  });

  assert.equal(executor.offer(jobId), true);
  await eventually(() => sessionStarted);
  assert.equal(executor.handleEvent({ type: 'job.cancel', data: { jobId } }), true);
  await eventually(() => executor.status.running === 0 && cancellations === 1);
  assert.equal(completions, 0);
  assert.equal(failures, 0);
  await executor.close();
});

test('AI Office SSE short connections keep increasing retry backoff', async () => {
  const clock = controlledSleep();
  let streamCalls = 0;
  const jobs = {
    status: { running: 0 },
    offer: () => false,
    handleEvent() {},
    close: async () => {},
  };
  const runtime = new OfficeRuntime({
    config: config({ heartbeatSeconds: 60 }),
    token: TOKEN,
    transport: {
      heartbeat: async () => ({ ok: true, jobs: [] }),
      stream: async ({ signal, onOpen }) => {
        streamCalls += 1;
        onOpen();
        if (streamCalls <= 4) throw new Error('short-lived SSE connection');
        return pendingUntilAbort(signal);
      },
    },
    jobExecutor: jobs,
    sleepImpl: clock.sleep,
    logger: { error() {} },
  });

  runtime.start();
  for (const expected of [1_000, 3_000, 10_000, 30_000]) {
    await eventually(() => clock.calls.some((call) => call.delay === expected && !call.settled));
    clock.calls.find((call) => call.delay === expected && !call.settled).resolve();
  }
  await eventually(() => streamCalls === 5);
  assert.deepEqual(
    clock.calls.filter((call) => call.delay < 60_000).map((call) => call.delay),
    [1_000, 3_000, 10_000, 30_000],
  );
  assert.equal(runtime.status.reconnects, 4);
  await Promise.race([
    runtime.stop(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Office Runtime stop timed out')), 250)),
  ]);
  assert.equal(runtime.status.state, 'idle');
});

test('AI Office resets retry backoff only after a post-open heartbeat', async () => {
  const clock = controlledSleep();
  let heartbeatCalls = 0;
  let streamCalls = 0;
  let rejectStableStream;
  const runtime = new OfficeRuntime({
    config: config({ heartbeatSeconds: 60 }),
    token: TOKEN,
    transport: {
      heartbeat: async () => { heartbeatCalls += 1; return { ok: true, jobs: [] }; },
      stream: async ({ signal, onOpen }) => {
        streamCalls += 1;
        onOpen();
        if (streamCalls === 1) throw new Error('first short-lived SSE connection');
        return new Promise((resolve, reject) => {
          rejectStableStream = reject;
          signal.addEventListener('abort', () => {
            reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
          }, { once: true });
        });
      },
    },
    jobExecutor: {
      status: { running: 0 },
      offer: () => false,
      handleEvent() {},
      close: async () => {},
    },
    sleepImpl: clock.sleep,
    logger: { error() {} },
  });

  runtime.start();
  await eventually(() => clock.calls.some((call) => call.delay === 1_000 && !call.settled));
  clock.calls.find((call) => call.delay === 1_000 && !call.settled).resolve();
  await eventually(() => streamCalls === 2
    && clock.calls.some((call) => call.delay === 60_000 && !call.settled));
  const heartbeatSleep = clock.calls.filter(
    (call) => call.delay === 60_000 && !call.settled,
  ).at(-1);
  heartbeatSleep.resolve();
  await eventually(() => heartbeatCalls === 3
    && clock.calls.filter((call) => call.delay === 60_000 && !call.settled).length === 1);
  rejectStableStream(new Error('stable SSE connection later ended'));
  await eventually(() => clock.calls.filter(
    (call) => call.delay === 1_000 && !call.settled,
  ).length === 1);
  assert.deepEqual(
    clock.calls.filter((call) => call.delay < 60_000).map((call) => call.delay),
    [1_000, 1_000],
  );

  await Promise.race([
    runtime.stop(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Office Runtime stop timed out')), 250)),
  ]);
  assert.equal(runtime.status.state, 'idle');
});
