import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  HarnessClient,
  HarnessHealthError,
  HarnessInteractionError,
  HarnessRpcError,
  HarnessTransportError,
} from '../../../src/channels/shared/harness-client.mjs';

function localClient(apiProxy, options = {}) {
  return new HarnessClient({
    apiProxy,
    workspace: '/tmp/dsh-im-test',
    interactionReconnectDelayMs: 0,
    fetchImpl: () => assert.fail('in-process calls must not use HTTP'),
    createWebSocket: () => assert.fail('in-process events must not use WebSocket'),
    ...options,
  });
}

async function eventually(predicate) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail('condition was not met');
}

// The real Host registers eagerly, then exposes a signal-controlled iterator.
// Reopening replays pending questions; since is deliberately not used.
function hostFixture() {
  const streams = new Set();
  const pending = new Map();
  const history = [];
  const prompts = [];
  const responses = [];
  let historyReads = 0;
  let opened = 0;
  const host = { streams, pending, history, prompts, responses, onPrompt: () => {} };
  const success = (rpcId, value) => ({ rpcId, result: { ok: true, value } });
  host.emit = (frame) => { for (const stream of streams) stream.push(frame); };
  host.append = (event) => {
    history.push({ event });
    host.emit({ rpcId: `event-${event.seq}`, payload: { type: 'session/event', sessionId: 'session', event } });
  };
  host.question = () => {
    const frame = {
      rpcId: 'question-rpc',
      payload: { type: 'question/requested', sessionId: 'session', questions: [] },
    };
    pending.set(frame.rpcId, frame);
    host.emit(frame);
  };
  host.apiProxy = {
    host: { describe: ({ rpcId }) => success(rpcId, {}) },
    sessions: {
      history: ({ rpcId }) => {
        historyReads += 1;
        return success(rpcId, { events: [...history] });
      },
      prompt: ({ rpcId, payload }) => {
        assert.equal(streams.size > 0, true, 'subscribe before submitting a prompt');
        prompts.push({ rpcId, payload });
        host.onPrompt(rpcId, payload);
        return success(rpcId, {});
      },
    },
    events: {
      mux(request, signal) {
        assert.deepEqual(request.payload, {});
        opened += 1;
        const queue = [...pending.values()];
        let wake;
        let ended = false;
        const stream = {
          push(frame) { queue.push(frame); wake?.(); },
          end() { ended = true; wake?.(); },
        };
        streams.add(stream);
        return (async function* () {
          const abort = () => stream.end();
          signal.addEventListener('abort', abort, { once: true });
          try {
            while (!ended && !signal.aborted) {
              if (queue.length) yield queue.shift();
              else await new Promise((resolve) => { wake = resolve; });
            }
          } finally {
            signal.removeEventListener('abort', abort);
            streams.delete(stream);
          }
        })();
      },
    },
    respond(envelope) {
      responses.push(envelope);
      pending.delete(envelope.rpcId);
      return { accepted: true };
    },
  };
  Object.defineProperties(host, {
    historyReads: { get: () => historyReads },
    opened: { get: () => opened },
  });
  return host;
}

test('in-process RPC preserves IDs, payloads, namespace receivers and errors', async () => {
  const calls = [];
  const apiProxy = {};
  const methods = ['host.describe', 'workspace.list', 'workspace.create', 'session.list',
    'session.create', 'session.history', 'session.prompt', 'session.rename', 'session.cancel',
    'session.models', 'session.selectModel', 'llm.models'];
  for (const method of methods) {
    const [domain, action] = method.split('.');
    const namespace = domain === 'session' ? 'sessions' : domain;
    const api = apiProxy[namespace] ??= {};
    api[action] = function (request, signal) {
      assert.equal(this, api);
      assert.ok(signal instanceof AbortSignal);
      calls.push({ method, request });
      return { rpcId: request.rpcId, result: { ok: true, value: method } };
    };
  }
  const client = localClient(apiProxy);
  const payload = { sessionId: 'session', content: [{ type: 'text', text: 'hello' }] };
  for (const method of methods) {
    assert.equal(await client.rpc(method, payload, 1000, { rpcId: `fixed-${method}` }), method);
  }
  assert.deepEqual(calls, methods.map((method) => ({
    method, request: { rpcId: `fixed-${method}`, payload },
  })));

  apiProxy.sessions.prompt = ({ rpcId }) => ({
    rpcId, result: { ok: false, error: { code: 'queue-full', message: 'queue full' } },
  });
  await assert.rejects(client.rpc('session.prompt'), (error) => (
    error instanceof HarnessRpcError && error.code === 'queue-full'
  ));
  apiProxy.host.describe = ({ rpcId }) => ({ rpcId, result: { ok: false, error: { code: 'internal' } } });
  await assert.rejects(client.health(), HarnessHealthError);
  for (const response of [null, { rpcId: 'wrong' }, { rpcId: 'fixed', result: {} }]) {
    apiProxy.host.describe = () => response;
    await assert.rejects(client.rpc('host.describe', {}, 1000, { rpcId: 'fixed' }), (error) => (
      error instanceof HarnessTransportError && error.code === 'harness-response-invalid'
    ));
  }
  await assert.rejects(client.rpc('session.missing'), { code: 'harness-api-not-found' });
});

test('in-process RPC bounds waits without retrying accepted calls or falling back to HTTP', async () => {
  let calls = 0;
  const client = localClient({
    sessions: {
      prompt: async ({ rpcId }) => {
        calls += 1;
        await delay(40); // Deliberately ignores the caller's AbortSignal.
        return { rpcId, result: { ok: true, value: {} } };
      },
    },
  });
  await assert.rejects(client.rpc('session.prompt', {}, 2), { code: 'harness-timeout' });
  assert.equal(calls, 1);
  const controller = new AbortController();
  const reason = new Error('caller cancelled');
  const pending = client.rpc('session.prompt', {}, 1000, { signal: controller.signal });
  await eventually(() => calls === 2);
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  await assert.rejects(client.rpc('session.prompt', {}, 1000, { signal: controller.signal }), (error) => error === reason);
  await delay(50);
  assert.equal(calls, 2, 'late success must not trigger another prompt');
});

test('explicit baseUrl still selects the existing HTTP transport', async () => {
  let requests = 0;
  const client = localClient({ get host() { assert.fail('must not call local Host'); } }, {
    baseUrl: 'http://127.0.0.1:1234',
    fetchImpl: async (url, options) => {
      requests += 1;
      assert.equal(url.href, 'http://127.0.0.1:1234/api/host.describe');
      return { ok: true, json: async () => ({
        type: 'server-response', rpcId: JSON.parse(options.body).rpcId, result: { ok: true, value: {} },
      }) };
    },
  });
  assert.equal(await client.health(), true);
  assert.equal(requests, 1);
});

test('Session rename uses the public Harness RPC and validates local input', async () => {
  const calls = [];
  const success = (rpcId, value) => ({ rpcId, result: { ok: true, value } });
  const client = localClient({
    host: { describe: ({ rpcId }) => success(rpcId, {}) },
    sessions: {
      rename: ({ rpcId, payload }) => {
        calls.push(payload);
        return success(rpcId, { title: payload.title, seq: 3 });
      },
    },
  });

  assert.deepEqual(await client.renameSession('session', '查询订单'), {
    title: '查询订单',
    seq: 3,
  });
  assert.deepEqual(calls, [{ sessionId: 'session', title: '查询订单' }]);
  await assert.rejects(client.renameSession('', 'title'), TypeError);
  await assert.rejects(client.renameSession('session', '  '), TypeError);
  assert.equal(calls.length, 1);
});

test('history reading uses only the existing read RPC in both Host connection modes', async () => {
  const page = { events: [], hasMore: false };
  for (const mode of ['local', 'http']) {
    const calls = [];
    const client = localClient({
      sessions: {
        history({ rpcId, payload }, signal) {
          assert.equal(mode, 'local');
          assert.ok(signal instanceof AbortSignal);
          calls.push(payload);
          return { rpcId, result: { ok: true, value: page } };
        },
      },
    }, mode === 'http' ? {
      baseUrl: 'http://127.0.0.1:1234',
      fetchImpl: async (url, options) => {
        assert.equal(url.pathname, '/api/session.history');
        const request = JSON.parse(options.body);
        calls.push(request.payload);
        return { ok: true, json: async () => ({
          type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: page },
        }) };
      },
    } : {});
    assert.deepEqual(await client.readSessionHistory('cold-session'), page);
    assert.deepEqual(await client.readSessionHistory('cold-session', { beforeSeq: 40, maxMessages: 10 }), page);
    assert.deepEqual(calls, [
      { sessionId: 'cold-session', maxMessages: 50 },
      { sessionId: 'cold-session', beforeSeq: 40, maxMessages: 10 },
    ]);
    await assert.rejects(client.readSessionHistory('', {}), TypeError);
    await assert.rejects(client.readSessionHistory('cold-session', { maxMessages: 0 }), TypeError);
    await assert.rejects(client.readSessionHistory('cold-session', { beforeSeq: -1 }), TypeError);
    assert.equal(calls.length, 2, 'invalid input must not make another RPC');
  }
});

test('history reads preserve cancellation, timeout and missing-session errors without retrying', async () => {
  let calls = 0;
  const client = localClient({ sessions: {
    async history({ rpcId, payload }) {
      calls += 1;
      if (payload.sessionId === 'missing') {
        return { rpcId, result: { ok: false, error: { code: 'session-not-found', message: 'missing' } } };
      }
      await delay(30);
      return { rpcId, result: { ok: true, value: { events: [], hasMore: false } } };
    },
  } });
  await assert.rejects(client.readSessionHistory('missing'), { code: 'session-not-found' });
  await assert.rejects(client.readSessionHistory('slow', { timeoutMs: 2 }), { code: 'harness-timeout' });
  const signal = AbortSignal.abort(new DOMException('Cancelled', 'AbortError'));
  await assert.rejects(client.readSessionHistory('cancelled', { signal }), { name: 'AbortError' });
  assert.equal(calls, 2);
});

test('in-process interaction responses preserve the full envelope and rejection receipts', async () => {
  let received;
  let receipt = { accepted: true };
  const client = localClient({ respond: (envelope) => { received = envelope; return receipt; } });
  const result = { ok: true, value: { sessionId: 'session', answer: { answers: [] } } };
  assert.deepEqual(await client.respondInteraction('question', result), receipt);
  assert.deepEqual(received, { type: 'client-response', rpcId: 'question', result });
  for (const reason of ['not-pending', 'bad-response']) {
    receipt = { accepted: false, reason };
    await assert.rejects(client.respondInteraction('question', result), (error) => (
      error instanceof HarnessInteractionError && error.code === `interaction-${reason}`
    ));
  }
  receipt = {};
  await assert.rejects(client.respondInteraction('question', result), /invalid interaction response receipt/);
});

test('ask uses an initially empty in-process mux and correlates replies with its original prompt ID', async () => {
  const host = hostFixture();
  host.onPrompt = (rpcId) => {
    host.append({ type: 'turn/start', seq: 0, data: { turn: 1 } });
    host.append({ type: 'user/message', seq: 1, data: { turn: 1, source: { rpcId } } });
    host.append({ type: 'assistant/message', seq: 2, data: {
      turn: 1, step: 1, message: { content: [{ type: 'text', text: 'answer' }] },
    } });
    host.append({ type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } });
  };
  const client = localClient(host.apiProxy, { rpcIdPrefix: 'local-test' });
  assert.equal(await client.ask('session', 'hello', { onInteraction: () => {}, timeoutMs: 1000 }), 'answer');
  assert.equal(host.prompts.length, 1);
  assert.match(host.prompts[0].rpcId, /^local-test-/);
  assert.equal(host.prompts[0].payload.mode, 'queue');
  assert.equal(host.streams.size, 0, 'ask completion must dispose its mux subscription');
});

test('clients on one Host share interaction ownership across context wrappers and reconnect safely', async () => {
  const host = hostFixture();
  const scope = {};
  const abort = new AbortController();
  const received = [[], []];
  const clients = [0, 1].map(() => localClient({ ...host.apiProxy }, { interactionScope: scope }));
  host.onPrompt = (rpcId) => {
    if (host.prompts.length !== 1) return; // Second queued prompt has not started a Turn.
    host.append({ type: 'turn/start', seq: 0, data: { turn: 1 } });
    host.append({ type: 'user/message', seq: 1, data: { turn: 1, source: { rpcId } } });
  };
  const asks = [];
  try {
    for (let index = 0; index < clients.length; index += 1) {
      const ask = clients[index].ask('session', 'hello', {
        signal: abort.signal,
        onInteraction: (interaction) => { received[index].push(interaction); },
      });
      asks.push(ask.catch(() => {}));
      await eventually(() => host.prompts.length === index + 1);
    }
    host.question();
    await eventually(() => received[0].length === 1);
    assert.equal(received[1].length, 0, 'queued client must not claim the active client question');
    const historyReads = host.historyReads;
    received[0][0].reconnect();
    await eventually(() => received[0].length === 2);
    assert.ok(host.historyReads > historyReads, 'reconnect must refresh ownership history');
    assert.equal(received[0][1].rpcId, 'question-rpc', 'replay keeps the pending request ID');
    assert.equal(received[1].length, 0);
    await received[0][1].respond({ ok: true, value: { sessionId: 'session', answer: { answers: [] } } });
    assert.equal(host.responses.length, 1);
    assert.equal(host.responses[0].rpcId, 'question-rpc');
  } finally {
    abort.abort();
    await Promise.all(asks);
  }
  assert.equal(host.streams.size, 0);
});

test('different Hosts never share interaction claims, even with identical session/request IDs', async () => {
  const hosts = [hostFixture(), hostFixture()];
  const controllers = hosts.map(() => new AbortController());
  const received = [[], []];
  const asks = hosts.map((host, index) => {
    host.onPrompt = (rpcId) => {
      host.append({ type: 'turn/start', seq: 0, data: { turn: 1 } });
      host.append({ type: 'user/message', seq: 1, data: { turn: 1, source: { rpcId } } });
    };
    return localClient(host.apiProxy).ask('session', 'hello', {
      signal: controllers[index].signal,
      onInteraction: (interaction) => { received[index].push(interaction); },
    }).catch(() => {});
  });
  try {
    await eventually(() => hosts.every((host) => host.prompts.length === 1));
    hosts.forEach((host) => host.question());
    await eventually(() => received.every((items) => items.length === 1));
    controllers[0].abort();
    await asks[0];
    assert.equal(hosts[0].streams.size, 0);
    assert.equal(hosts[1].streams.size, 1, 'closing one Host client must not stop another');
  } finally {
    controllers.forEach((controller) => controller.abort());
    await Promise.all(asks);
  }
  assert.ok(hosts.every((host) => host.streams.size === 0));
});
