import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HarnessClient, HarnessInteractionError, HarnessTransportError, HarnessTurnError } from '../../../src/channels/shared/harness-client.mjs';
import { extractConnectionEvidence, messageDiagnosticError, atConnectionStage } from '../../../src/channels/shared/connection-error.mjs';
import { normalizeDiagnosticDetails } from '../../../src/channels/shared/diagnostic-details.mjs';
import { classifyMessageFailure, messageFailureDiagnostic, publicMessageFailure, channelDeliveryFailure } from '../../../src/channels/shared/message-failure.mjs';
import { askInWorkspaceSession } from '../../../src/channels/shared/workspace-session.mjs';
import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import { normalizeLastMessageError } from '../../../plugin-src/client/last-message-error.js';
import { LastMessageErrorSummary } from '../../../plugin-src/client/channel-card-meta.js';
import { formatConnectionDiagnostic } from '../../../plugin-src/client/connection-error.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const evidence = error => extractConnectionEvidence(error).details;
class Socket extends EventTarget {
  readyState = 0;
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

function fixture({ native = false, fail, complete = true } = {}) {
  const requests = [], sockets = [];
  let events = [], promptCount = 0;
  const rpc = (method, request) => {
    requests.push({ method, ...request });
    fail?.(method, promptCount);
    let value = {};
    if (method === 'workspace.list') value = { items: [], archivedSessionIds: [] };
    if (method === 'session.list') value = { items: [] };
    if (method === 'session.history') value = { events };
    if (method === 'session.prompt') {
      promptCount++;
      if (complete) events = [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { turn: 1, source: { rpcId: request.rpcId } } },
        { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'OK' }] } } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ].map((event, seq) => ({ event: { ...event, seq } }));
    }
    return { rpcId: request.rpcId, result: { ok: true, value } };
  };
  const apiProxy = {
    host: { describe: r => rpc('host.describe', r) },
    workspace: { list: r => rpc('workspace.list', r) },
    sessions: Object.fromEntries(['history', 'prompt', 'list', 'selectModel'].map(action => [action, r => rpc(`session.${action}`, r)])),
    events: { mux(_request, signal) {
      let finish;
      const pending = new Promise(resolve => { finish = () => resolve({ done: true }); });
      signal.addEventListener('abort', finish, { once: true });
      return {
        [Symbol.asyncIterator]() { return this; },
        next() { return pending; },
        return() { signal.removeEventListener('abort', finish); return Promise.resolve({ done: true }); },
      };
    } },
  };
  const client = new HarnessClient({
    ...(native ? { apiProxy } : { baseUrl: 'http://127.0.0.1:1234' }),
    interactionReconnectDelayMs: 500,
    fetchImpl: async (_url, options) => ({ ok: true, json: async () => {
      const request = JSON.parse(options.body);
      return { type: 'server-response', ...rpc(request.method, request) };
    } }),
    createWebSocket: () => { const socket = new Socket(); sockets.push(socket); return socket; },
  });
  return { client, requests, sockets, get promptCount() { return promptCount; } };
}

function clock(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  t.mock.method(performance, 'now', () => Date.now());
  return async ms => { t.mock.timers.tick(ms); await flush(); };
}

test('a stalled handshake remains before prompt and survives logging, UI projection and copying', async t => {
  const tick = clock(t);
  const f = fixture();
  const pending = f.client.ask('session-one', 'private-prompt', { onInteraction() {} }).catch(e => e);
  await flush();
  assert.equal(f.sockets.length, 1);
  await tick(30_000);
  const error = await pending;
  assert.ok(error instanceof HarnessInteractionError);
  assert.equal(f.promptCount, 0);
  const failure = classifyMessageFailure(error, { referenceId: 'MF-12AB34CD' });
  assert.equal(failure.code, 'HARNESS_INTERACTION_TIMEOUT');
  assert.match(failure.message, /尚未提交执行/);
  const expected = { stage: 'interaction.open', submissionState: 'not-submitted', transport: 'websocket',
    durationMs: 30_000, timeoutMs: 30_000, attempts: 1, reason: 'timeout' };
  for (const [key, value] of Object.entries(expected)) assert.equal(failure.details[key], value, key);
  assert.equal(failure.details.lastFailureReason, undefined);
  assert.ok(failure.details.pluginVersion);
  const logged = messageFailureDiagnostic(error, failure);
  assert.equal(logged.sessionId, 'session-one');
  assert.match(logged.promptRpcId, /^im-/);
  const displayed = normalizeLastMessageError(publicMessageFailure(failure));
  const copied = formatConnectionDiagnostic(displayed);
  const markup = renderToStaticMarkup(React.createElement(LastMessageErrorSummary, { error: displayed }));
  for (const [key, value] of Object.entries(expected)) assert.ok(copied.includes(`${key}: ${value}`), key);
  for (const value of ['建立交互通道', '未提交', 'WebSocket', '连接尝试次数', 'MF-12AB34CD']) assert.ok(markup.includes(value), value);
  assert.doesNotMatch(JSON.stringify([logged, displayed, copied, markup]), /private-prompt/);
  assert.doesNotMatch(copied, /session-one|promptRpcId/);
  assert.equal(f.sockets[0].readyState, 3);
  setImHostLanguage('en');
  try { assert.match(classifyMessageFailure(error).message, /not ready within 30 seconds/); }
  finally { setImHostLanguage('zh'); }
});

test('repeated open failures retain attempts and last observed failure, without submitting', async t => {
  const tick = clock(t);
  t.mock.method(console, 'warn', () => {});
  const f = fixture();
  const pending = f.client.ask('session-retries', 'hello', { onInteraction() {} }).catch(e => e);
  await flush();
  f.sockets[0].close();
  await flush();
  await tick(500);
  f.sockets[1].dispatchEvent(new Event('error'));
  await flush();
  await tick(500);
  await tick(29_000);
  const error = await pending;
  assert.equal(evidence(error).attempts, 3);
  assert.equal(evidence(error).lastFailureReason, 'stream-failed-before-open');
  assert.equal(f.promptCount, 0);
});

test('reconnecting successfully retains normal prompt and reply behavior', async t => {
  const tick = clock(t);
  t.mock.method(console, 'warn', () => {});
  const f = fixture();
  const pending = f.client.ask('session-recovered', 'hello', { onInteraction() {} });
  await flush();
  f.sockets[0].close();
  await flush();
  await tick(500);
  f.sockets[1].open();
  await flush();
  await tick(300);
  assert.equal(await pending, 'OK');
  assert.equal(f.promptCount, 1);
});

test('native readiness needs no frames and diagnostic callback errors are ignored', async t => {
  const tick = clock(t);
  const f = fixture({ native: true });
  const pending = f.client.ask('session-native', 'hello', { onInteraction() {} });
  await flush();
  await tick(300);
  assert.equal(await pending, 'OK');
  assert.equal(f.sockets.length, 0);
  const controller = new AbortController();
  const watching = f.client.watchInteractions('session-native', {
    signal: controller.signal, onOpen() { controller.abort(); },
    async onDiagnostic() { throw new Error('observer failure'); },
  });
  await watching;
});

for (const phase of ['before', 'submit', 'after']) {
  test(`RPC failure at ${phase} submission preserves its actual message state`, async t => {
    const tick = clock(t);
    const f = fixture({ native: true, fail(method, prompts) {
      if ((phase === 'before' && method === 'session.history' && !prompts)
        || (phase === 'submit' && method === 'session.prompt')
        || (phase === 'after' && method === 'session.history' && prompts)) {
        throw Object.assign(new Error('private-network-detail'), { code: 'ECONNRESET' });
      }
    } });
    const pending = f.client.ask('session-rpc', 'hello').catch(e => e);
    await flush();
    if (phase === 'after') await tick(300);
    const error = await pending;
    const details = evidence(error);
    assert.equal(details.stage, { before: 'prompt.prepare', submit: 'prompt.submit', after: 'reply.wait' }[phase]);
    assert.equal(details.submissionState, { before: 'not-submitted', submit: 'unknown', after: 'accepted' }[phase]);
    assert.equal(classifyMessageFailure(error).code, phase === 'before' ? 'HARNESS_CONNECT' : 'HARNESS_RESULT_UNCERTAIN');
    assert.equal(f.promptCount, phase === 'after' ? 1 : 0);
    assert.equal(error.cause.code, 'ECONNRESET');
  });
}

test('a prompt-submit timeout stays a failure only after the durable ledger misses it', async t => {
  const tick = clock(t);
  const f = fixture({ native: true, fail(method) {
    if (method === 'session.prompt') throw new HarnessTransportError('harness-timeout', 'session.prompt');
  } });
  const pending = f.client.ask('session-unconfirmed', 'hello').catch(e => e);
  await flush();
  for (let attempt = 0; attempt < 4; attempt += 1) await tick(2_000);
  const error = await pending;
  assert.ok(error instanceof HarnessTransportError);
  assert.equal(error.code, 'harness-timeout');
  // fail 钩子在 fixture 计数前抛错（与上方 submit 阶段测试同语义）；
  // 6 次 session.history = 1 次 baseline + 5 次入库确认轮询。
  assert.equal(f.promptCount, 0);
  assert.equal(f.requests.filter(request => request.method === 'session.history').length, 6);
  const details = evidence(error);
  assert.equal(details.stage, 'prompt.submit');
  assert.equal(details.submissionState, 'unknown');
  const failure = classifyMessageFailure(error, { referenceId: 'MF-TEST01' });
  assert.equal(failure.code, 'HARNESS_RESULT_UNCERTAIN');
  assert.match(failure.message, /提交请求超时/u);
  assert.match(failure.message, /不要立即重复提交/u);
  setImHostLanguage('en');
  try {
    assert.doesNotMatch(JSON.stringify(classifyMessageFailure(error, { referenceId: 'MF-TEST01' }).message), /[\u4e00-\u9fff]/u);
  }
  finally { setImHostLanguage('zh'); }
});

test('a cancellation during the final confirmation probe surfaces the cancel reason', async t => {
  const tick = clock(t);
  const controller = new AbortController();
  const f = fixture({ native: true, fail(method) {
    if (method === 'session.prompt') throw new HarnessTransportError('harness-timeout', 'session.prompt');
    // requests.push 先于 fail：probe5 是第 6 次 session.history，进入前在这里取消。
    if (method === 'session.history'
      && f.requests.filter(request => request.method === 'session.history').length >= 6) {
      controller.abort(new Error('cancelled during probe'));
    }
  } });
  const pending = f.client.ask('session-cancelled-probe', 'hello', { signal: controller.signal }).catch(e => e);
  await flush();
  for (let attempt = 0; attempt < 5; attempt += 1) await tick(2_000);
  const error = await pending;
  // 取消原因优先于原始提交超时透出，不能被 harness-timeout 覆盖。
  assert.equal(error.message, 'cancelled during probe');
  assert.ok(!(error instanceof HarnessTransportError));
});

test('an accepted prompt with no progress retains reply timeout and deferred-delivery context', async t => {
  const tick = clock(t);
  const f = fixture({ native: true, complete: false });
  const pending = f.client.ask('session-stalled', 'hello', { timeoutMs: 300 }).catch(e => e);
  await flush();
  await tick(300);
  const error = await pending;
  assert.ok(error instanceof HarnessTurnError);
  assert.equal(error.code, 'harness-reply-timeout');
  assert.equal(error.details.sessionId, 'session-stalled');
  assert.equal(evidence(error).submissionState, 'accepted');
  assert.equal(evidence(error).timeoutMs, 300);
  assert.equal(classifyMessageFailure(error).code, 'MODEL_REPLY_TIMEOUT');
});

test('caller cancellation is not converted into an interaction timeout', async t => {
  const tick = clock(t);
  const f = fixture();
  const controller = new AbortController();
  const reason = new DOMException('Cancelled', 'AbortError');
  const pending = f.client.ask('session-cancelled', 'hello', { signal: controller.signal, onInteraction() {} }).catch(e => e);
  await flush();
  controller.abort(reason);
  const error = await pending;
  assert.equal(error, reason);
  await tick(30_000);
  assert.equal(f.promptCount, 0);
});

test('shared errors keep separate request snapshots and business/DOMException semantics', () => {
  const original = new HarnessTurnError('harness-turn-failed', { providerCode: 'RATE_LIMIT' });
  original.details = { turn: 2, lastSeq: 9 };
  const a = messageDiagnosticError(original, { stage: 'reply.wait', submissionState: 'accepted', sessionId: 'session-a' });
  const b = messageDiagnosticError(original, { stage: 'prompt.prepare', submissionState: 'not-submitted', sessionId: 'session-b' });
  assert.ok(a instanceof HarnessTurnError);
  assert.equal(a.details, original.details);
  assert.equal(classifyMessageFailure(a).code, 'MODEL_RATE_LIMIT');
  assert.equal(evidence(original).stage, undefined);
  assert.equal(extractConnectionEvidence(a).correlation.sessionId, 'session-a');
  assert.equal(extractConnectionEvidence(b).correlation.sessionId, 'session-b');
  const timeout = messageDiagnosticError(new DOMException('private', 'TimeoutError'), { stage: 'prompt.prepare' });
  assert.equal(timeout.name, 'TimeoutError');
  assert.equal(evidence(timeout).reason, 'timeout');
});

test('session/content preparation failures get context and inner stages win', async () => {
  for (const preparingContent of [false, true]) {
    const state = { sessionFor: () => 'session-prepare' };
    const error = await askInWorkspaceSession({
      harness: { sessionExists: async () => { if (!preparingContent) throw new Error('private'); return true; } },
      state, key: 'conversation', text: 'hello',
      prepareContent: async () => { throw new Error('private'); },
    }).catch(e => e);
    assert.equal(evidence(error).stage, preparingContent ? 'prompt.prepare' : 'session.prepare');
    assert.equal(evidence(error).submissionState, 'not-submitted');
    assert.equal(extractConnectionEvidence(error).correlation.sessionId, 'session-prepare');
  }
  const staged = await atConnectionStage('credential.read', async () => { throw new Error('private'); }).catch(e => e);
  assert.equal(evidence(staged).stage, 'credential.read');
  const delivery = messageDiagnosticError(channelDeliveryFailure(new Error('private')), { stage: 'reply.wait', submissionState: 'accepted' });
  assert.equal(evidence(delivery).stage, 'message.send');
  assert.equal(classifyMessageFailure(delivery).code, 'CHANNEL_DELIVERY_UNCERTAIN');
});

test('malformed model selection uses protocol classification and a local session reference', async () => {
  const f = fixture({ native: true });
  const error = await f.client.selectSessionModel('session-model', { provider: 'test', model: 'test' }).catch(e => e);
  assert.equal(classifyMessageFailure(error).code, 'HARNESS_PROTOCOL');
  assert.equal(evidence(error).method, 'session.selectModel');
  assert.equal(extractConnectionEvidence(error).correlation.sessionId, 'session-model');
});

test('new diagnostic fields remain allowlisted and raw RPC identities do not enter logs', () => {
  assert.deepEqual(normalizeDiagnosticDetails({ stage: 'private', transport: 'private', submissionState: 'private',
    attempts: -1, lastFailureReason: 'private', sessionId: 'private', promptRpcId: 'private' }), {});
  assert.deepEqual(extractConnectionEvidence({ details: { sessionId: 'private', promptRpcId: 'private' } }).correlation, {});
});
