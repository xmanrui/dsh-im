import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeixinStateStore } from '../../../src/channels/weixin/state-store.mjs';

import { WeixinApiError } from '../../../src/channels/weixin/weixin-api.mjs';
import {
  orderWeixinMessages,
  WeixinRuntime,
} from '../../../src/channels/weixin/weixin-runtime.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function eventually(predicate, message, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

test('Weixin orders one update batch by sequence instead of its unrelated message id', () => {
  const first = { seq: 101, message_id: 900 };
  const second = { seq: '102', message_id: 100 };
  const third = { seq: 103, message_id: 500 };
  assert.deepEqual(orderWeixinMessages([third, first, second]), [first, second, third]);

  const earlier = { create_time_ms: 1_000 };
  const later = { create_time_ms: 2_000 };
  assert.deepEqual(orderWeixinMessages([later, earlier]), [earlier, later]);

  const withoutOrder = { client_id: 'local-only' };
  assert.deepEqual(orderWeixinMessages([third, withoutOrder, first]), [third, withoutOrder, first]);
  assert.deepEqual(orderWeixinMessages(null), []);
});

test('runtime preserves rapid batch command order when getUpdates returns newest first', async () => {
  const sends = [];
  const seen = new Set();
  let polls = 0;
  const stopped = deferred();
  const inbound = (seq, messageId, text) => ({
    seq,
    message_id: messageId,
    message_type: 1,
    from_user_id: 'owner',
    context_token: `context-${messageId}`,
    item_list: [{ type: 1, text_item: { text } }],
  });
  const runtime = new WeixinRuntime({
    api: {
      notifyStart: async () => {},
      notifyStop: async () => {},
      sendText: async ({ text }) => sends.push(text),
      getUpdates: async ({ signal }) => {
        polls += 1;
        if (polls === 1) {
          return {
            ret: 0,
            get_updates_buf: 'ordered-batch',
            msgs: [
              inbound(303, 200, '/cancel'),
              inbound(302, 100, '这条内容必须被取消'),
              inbound(301, 900, '/batch'),
            ],
          };
        }
        return abortable(stopped.promise, signal);
      },
    },
    config: {
      botId: 'wx_ordered_batch',
      baseUrl: 'https://ilinkai.weixin.qq.com/',
      ownerUserId: 'owner',
    },
    token: 'bot-token',
    harness: {
      ensureRunning: async () => true,
      ask: async () => assert.fail('cancelled batch content must not reach Harness'),
    },
    state: {
      getUpdatesBuf: () => '',
      setGetUpdatesBuf: async () => {},
      hasSeen: (id) => seen.has(id),
      markSeen: async (id) => seen.add(id),
      sessionFor: () => null,
      setSession: async () => {},
      clearSession: async () => {},
    },
    logger: { warn() {}, error() {} },
  });

  await runtime.start();
  try {
    await eventually(
      () => sends.some((text) => /丢弃 1 条消息/.test(text)),
      'the reversed provider batch should be processed in sequence order',
    );
    assert.equal(sends.some((text) => /仅支持文字|没有正在进行/.test(text)), false);
  } finally {
    await runtime.stop();
    stopped.resolve({ ret: 0, msgs: [] });
  }
});

test('runtime sends a connection test to the bound Weixin owner without reply context', async () => {
  const sends = [];
  const runtime = new WeixinRuntime({
    api: {
      notifyStart: async () => {},
      notifyStop: async () => {},
      sendText: async (request) => sends.push(request),
      getUpdates: async ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    },
    config: {
      botId: 'wx_owner',
      baseUrl: 'https://ilinkai.weixin.qq.com/',
      ownerUserId: 'owner-user',
    },
    token: 'bot-token',
    harness: { ensureRunning: async () => true },
    state: { getUpdatesBuf: () => '' },
  });

  await runtime.start();
  assert.deepEqual(await runtime.sendConnectionTest('连接测试'), { sent: true });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].toUserId, 'owner-user');
  assert.equal(sends[0].text, '连接测试');
  assert.equal(sends[0].contextToken, undefined);
  assert.equal(sends[0].runId, undefined);
  assert.deepEqual(await runtime.sendProactiveText({
    kind: 'user',
    route: { toUserId: 'target-user' },
  }, '主动投递'), { sent: true });
  assert.equal(sends[1].toUserId, 'target-user');
  assert.equal(sends[1].text, '主动投递');
  assert.equal(sends[1].contextToken, undefined);
  assert.equal(sends[1].runId, undefined);
  await runtime.stop();
});

test('proactive delivery reuses authorized inbound context after restart without requiring a Harness session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-weixin-proactive-context-'));
  const path = join(root, 'state.json');
  const sends = [];
  let inbound = [
    { message_id: '1', seq: '10', message_type: 1, from_user_id: 'owner', context_token: 'fresh-context', item_list: [{ type: 1, text_item: { text: '/ping' } }] },
    { message_id: '2', seq: '11', message_type: 1, from_user_id: 'stranger', context_token: 'stranger-context', item_list: [{ type: 1, text_item: { text: '/ping' } }] },
  ];
  const makeRuntime = (state) => new WeixinRuntime({
    api: {
      notifyStart: async () => {}, notifyStop: async () => {},
      getUpdates: async ({ signal }) => {
        if (inbound.length) { const msgs = inbound; inbound = []; return { ret: 0, msgs, get_updates_buf: 'cursor' }; }
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
      sendText: async (request) => {
        sends.push(request);
        if (request.toUserId === 'owner' && request.contextToken !== 'fresh-context') {
          throw new WeixinApiError('send-rejected', 'prepare failed', { providerCode: '-2' });
        }
        return { ret: 0 };
      },
    },
    config: { botId: 'test-bot', baseUrl: 'https://ilinkai.weixin.qq.com/', ownerUserId: 'owner' },
    token: 'login', harness: { ensureRunning: async () => true }, state,
    logger: { warn() {}, error() {} },
  });
  const state = await new WeixinStateStore(path).load();
  let runtime = makeRuntime(state);
  try {
    await runtime.start();
    await eventually(() => state.hasSeen('1') && state.hasSeen('2'), 'inbound messages handled');
    assert.equal(state.contextTokenFor('stranger'), undefined);
    await runtime.sendProactiveText({ kind: 'user', route: { toUserId: 'owner' } }, 'proactive before restart');
    assert.equal(sends.at(-1).contextToken, 'fresh-context');
    assert.equal(sends.at(-1).runId, undefined);
    await runtime.stop();
    runtime = makeRuntime(await new WeixinStateStore(path).load());
    await runtime.start();
    await runtime.sendProactiveText({ kind: 'user', route: { toUserId: 'owner' } }, 'proactive after restart');
    assert.equal(sends.at(-1).contextToken, 'fresh-context');
    await runtime.sendConnectionTest('connection test');
    assert.equal(sends.at(-1).contextToken, 'fresh-context');
    await runtime.sendProactiveText({ kind: 'user', route: { toUserId: 'other-user' } }, 'other recipient');
    assert.equal(sends.at(-1).contextToken, undefined);
  } finally { await runtime.stop(); }
});

test('proactive rejection remains visible while polling is healthy, without retries or private diagnostics', async () => {
  let poll = deferred();
  let polls = 0;
  let sends = 0;
  let rejection = new WeixinApiError('send-rejected', 'private-provider-response', { providerCode: '-2' });
  const logs = [];
  const runtime = new WeixinRuntime({
    api: {
      notifyStart: async () => {}, notifyStop: async () => {},
      getUpdates: ({ signal }) => { polls += 1; return abortable(poll.promise, signal); },
      sendText: async () => { sends += 1; if (rejection) throw rejection; return {}; },
    },
    config: { botId: 'bot', baseUrl: 'https://ilinkai.weixin.qq.com/', ownerUserId: 'private-owner' },
    token: 'private-login', harness: { ensureRunning: async () => true },
    state: { getUpdatesBuf: () => '', contextTokenFor: () => 'private-context' },
    logger: { warn: (message) => logs.push(message), error() {} },
  });
  await runtime.start();
  try {
    await assert.rejects(runtime.sendProactiveText({ kind: 'user', route: { toUserId: 'private-owner' } }, 'private-content'),
      (error) => error.code === 'send-rejected' && error.providerCode === '-2');
    assert.equal(sends, 1, 'a rejected send must not trigger retries');
    const failure = runtime.status.lastMessageError;
    assert.equal(failure.code, 'CHANNEL_DELIVERY');
    assert.equal(failure.reason, 'WEIXIN_SEND_FAILED');
    assert.match(failure.message, /provider=-2/);
    assert.match(failure.message, /contextToken=yes/);
    assert.match(failure.message, /接收者发一条消息/);
    assert.doesNotMatch(JSON.stringify({ failure, logs }), /private-/);
    const previousPoll = poll;
    poll = deferred();
    previousPoll.resolve({ ret: 0, msgs: [] });
    await eventually(() => polls >= 2, 'healthy polling resumes');
    assert.equal(runtime.status.ready, true);
    assert.equal(runtime.status.weixinConnectionState, 'connected');
    assert.equal(runtime.status.lastMessageError.referenceId, failure.referenceId);

    rejection = new WeixinApiError('network-error', 'private-network-detail');
    await assert.rejects(runtime.sendConnectionTest('test'));
    assert.equal(runtime.status.lastMessageError.code, 'CHANNEL_DELIVERY_UNCERTAIN');
    assert.doesNotMatch(runtime.status.lastMessageError.message, /接收者发一条消息/);
    rejection = null;
    await runtime.sendConnectionTest('test');
    assert.equal(runtime.status.lastMessageError, null);
  } finally { await runtime.stop(); }
});

test('runtime cancels typing before notifying iLink that it stopped', async () => {
  const events = [];
  const seen = new Set();
  let polls = 0;
  const runtime = new WeixinRuntime({
    api: {
      notifyStart: async () => events.push({ type: 'notify-start' }),
      notifyStop: async () => events.push({ type: 'notify-stop' }),
      getConfig: async () => ({ typingTicket: 'typing-ticket' }),
      sendTyping: async ({ status, signal }) => events.push({ type: 'typing', status, signal }),
      sendText: async () => assert.fail('an aborted turn must not send a reply'),
      getUpdates: async ({ signal }) => {
        polls += 1;
        if (polls === 1) {
          return {
            ret: 0,
            msgs: [{
              seq: 1,
              message_id: 'runtime-typing-stop',
              message_type: 1,
              from_user_id: 'owner-user',
              context_token: 'runtime-typing-context',
              item_list: [{ type: 1, text_item: { text: '执行长任务' } }],
            }],
          };
        }
        return new Promise((_resolve, reject) => {
          const onAbort = () => reject(signal.reason);
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        });
      },
    },
    config: {
      botId: 'wx_typing_stop',
      baseUrl: 'https://ilinkai.weixin.qq.com/',
      ownerUserId: 'owner-user',
    },
    token: 'bot-token',
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      }),
    },
    state: {
      getUpdatesBuf: () => '',
      setGetUpdatesBuf: async () => {},
      hasSeen: (id) => seen.has(id),
      markSeen: async (id) => seen.add(id),
      sessionFor: () => 'session-runtime-typing-stop',
      setSession: async () => {},
      clearSession: async () => {},
    },
    logger: { warn() {}, error() {} },
  });

  await runtime.start();
  await eventually(
    () => events.some((event) => event.type === 'typing' && event.status === 1),
    'the runtime should start the typing indicator',
  );
  await runtime.stop();

  const cancellationIndex = events.findIndex(
    (event) => event.type === 'typing' && event.status === 2,
  );
  const stopIndex = events.findIndex((event) => event.type === 'notify-stop');
  assert.ok(cancellationIndex > -1);
  assert.ok(cancellationIndex < stopIndex);
  assert.equal(events[cancellationIndex].signal.aborted, false);
});

test('runtime verifies the token, consumes getUpdates, replies, persists cursor, and aborts on stop', async () => {
  const calls = [];
  let pollCount = 0;
  let askSignal;
  const answer = '答'.repeat(2_000);
  const stateData = { cursor: '', seen: new Set(), session: null };
  const api = {
    notifyStart: async (request) => calls.push(['start', request.token]),
    notifyStop: async (request) => calls.push(['stop', request.token]),
    sendText: async (request) => calls.push(['send', request.text, request.contextToken]),
    getUpdates: async ({ signal }) => {
      pollCount += 1;
      if (pollCount === 1) {
        return {
          ret: 0,
          get_updates_buf: 'cursor-next',
          msgs: [{
            message_id: 7,
            message_type: 1,
            from_user_id: 'owner',
            context_token: 'context-7',
            item_list: [{ type: 1, text_item: { text: '问题' } }],
          }],
        };
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    },
  };
  const state = {
    getUpdatesBuf: () => stateData.cursor,
    setGetUpdatesBuf: async (value) => { stateData.cursor = value; },
    hasSeen: (id) => stateData.seen.has(id),
    markSeen: async (id) => stateData.seen.add(id),
    sessionFor: () => stateData.session,
    setSession: async (_key, value) => { stateData.session = value; },
    clearSession: async () => { stateData.session = null; },
  };
  const runtime = new WeixinRuntime({
    api,
    config: {
      botId: 'wx_bot',
      baseUrl: 'https://ilinkai.weixin.qq.com/',
      ownerUserId: 'owner',
    },
    token: 'bot-token',
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      createSession: async () => 'session-1',
      ask: async (_sessionId, _text, options) => {
        askSignal = options.signal;
        return answer;
      },
    },
    state,
    logger: { warn() {}, error() {} },
  });

  const started = await runtime.start();
  assert.equal(started.ready, true);
  await flush();
  await flush();
  assert.equal(stateData.cursor, 'cursor-next');
  assert.equal(calls[0][0], 'start');
  assert.deepEqual(calls.slice(1, 3).map((call) => call[1].length), [1_800, 200]);
  assert.equal(calls.slice(1, 3).map((call) => call[1]).join(''), answer);
  assert.deepEqual(calls.slice(1, 3).map((call) => call[2]), [
    'context-7',
    'context-7',
  ]);
  assert.equal(runtime.status.messagesReplied, 1);
  assert.equal(askSignal.aborted, false);
  await runtime.stop();
  assert.equal(askSignal.aborted, true);
  assert.deepEqual(calls.at(-1), ['stop', 'bot-token']);
  assert.equal(runtime.status.ready, false);
});

test('runtime keeps polling while a Harness interaction waits and consumes its answer in the open turn', async () => {
  const questionPresented = deferred();
  const answerSubmitted = deferred();
  const sends = [];
  const askTexts = [];
  const interactionResponses = [];
  const polledCursors = [];
  const cursorWrites = [];
  let pollCount = 0;
  let turnFinished = false;
  let secondPollStartedWhileTurnOpen = false;
  let respondedWhileTurnOpen = false;
  const stateData = { cursor: '', seen: new Set(), session: 'session-1' };

  const api = {
    notifyStart: async () => {},
    notifyStop: async () => {},
    sendText: async (request) => sends.push(request),
    getUpdates: async ({ getUpdatesBuf, signal }) => {
      pollCount += 1;
      polledCursors.push(getUpdatesBuf);
      if (pollCount === 1) {
        return {
          ret: 0,
          get_updates_buf: 'cursor-question',
          msgs: [{
            message_id: 101,
            message_type: 1,
            from_user_id: 'owner',
            context_token: 'context-question',
            item_list: [{ type: 1, text_item: { text: '请调用 ask_user_question' } }],
          }],
        };
      }
      if (pollCount === 2) {
        secondPollStartedWhileTurnOpen = !turnFinished;
        await questionPresented.promise;
        return {
          ret: 0,
          get_updates_buf: 'cursor-answer',
          msgs: [{
            message_id: 102,
            message_type: 1,
            from_user_id: 'owner',
            context_token: 'context-answer',
            item_list: [{ type: 1, text_item: { text: '1' } }],
          }],
        };
      }
      return new Promise((_resolve, reject) => {
        const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    },
  };
  const state = {
    getUpdatesBuf: () => stateData.cursor,
    setGetUpdatesBuf: async (value) => {
      stateData.cursor = value;
      cursorWrites.push(value);
    },
    hasSeen: (id) => stateData.seen.has(id),
    markSeen: async (id) => stateData.seen.add(id),
    sessionFor: () => stateData.session,
    setSession: async (_key, value) => { stateData.session = value; },
    clearSession: async () => { stateData.session = null; },
  };
  const runtime = new WeixinRuntime({
    api,
    config: {
      botId: 'wx_interaction',
      baseUrl: 'https://ilinkai.weixin.qq.com/',
      ownerUserId: 'owner',
    },
    token: 'bot-token',
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      createSession: async () => 'session-1',
      ask: async (sessionId, text, options) => {
        askTexts.push(text);
        await options.onInteraction({
          kind: 'question',
          rpcId: 'rpc-runtime-question',
          interactionId: 'interaction-runtime-question',
          sessionId,
          payload: {
            questions: [{
              id: 'environment',
              question: '请选择测试环境',
              options: [{ label: '测试环境' }, { label: '生产环境' }],
            }],
          },
          respond: async (response) => {
            interactionResponses.push(response);
            respondedWhileTurnOpen = !turnFinished;
            answerSubmitted.resolve();
          },
        });
        questionPresented.resolve();
        await abortable(answerSubmitted.promise, options.signal);
        turnFinished = true;
        return '你选择了：测试环境';
      },
    },
    state,
    logger: { warn() {}, error() {} },
  });

  await runtime.start();
  try {
    await eventually(
      () => turnFinished && stateData.seen.size === 2
        && sends.some((request) => request.text === '你选择了：测试环境'),
      'the answer should resolve the original Harness turn',
    );

    assert.equal(secondPollStartedWhileTurnOpen, true);
    assert.equal(respondedWhileTurnOpen, true);
    assert.deepEqual(askTexts, ['请调用 ask_user_question']);
    assert.deepEqual(interactionResponses, [{
      ok: true,
      value: {
        sessionId: 'session-1',
        answer: { answers: [{ id: 'environment', selected: ['测试环境'] }] },
      },
    }]);
    assert.deepEqual(cursorWrites, ['cursor-question', 'cursor-answer']);
    assert.deepEqual(polledCursors.slice(0, 3), ['', 'cursor-question', 'cursor-answer']);
    assert.equal(stateData.cursor, 'cursor-answer');
  } finally {
    await runtime.stop();
  }
});

test('runtime refuses to report ready when notifyStart rejects the stored token', async () => {
  const runtime = new WeixinRuntime({
    api: {
      notifyStart: async () => { throw new Error('rejected'); },
      notifyStop: async () => {},
    },
    config: { botId: 'wx_bad', baseUrl: 'https://ilinkai.weixin.qq.com/', ownerUserId: 'owner' },
    token: 'bad-token',
    harness: { ensureRunning: async () => true },
    state: {},
  });
  await assert.rejects(runtime.start(), /rejected/);
  assert.equal(runtime.status.ready, false);
  assert.equal(runtime.status.weixinConnectionState, 'failed');
});

test('runtime uses an explicit unknown code for an unclassified Harness health failure', async () => {
  const runtime = new WeixinRuntime({
    api: {
      notifyStart: async () => assert.fail('notifyStart must not run while Harness is unavailable'),
      notifyStop: async () => {},
      sendText: async () => {},
      getUpdates: async () => ({ ret: 0, msgs: [] }),
    },
    config: { botId: 'wx_harness', baseUrl: 'https://ilinkai.weixin.qq.com/', ownerUserId: 'owner' },
    token: 'bot-token',
    harness: { ensureRunning: async () => { throw new Error('private loopback transport detail'); } },
    state: {},
  });

  await assert.rejects(runtime.start(), (error) => {
    assert.equal(error.code, 'harness-check-unknown-failed');
    assert.notEqual(error.code, 'harness-unreachable');
    assert.doesNotMatch(error.message, /private loopback transport detail/);
    assert.match(error.cause?.message ?? '', /private loopback transport detail/);
    return true;
  });
  assert.equal(runtime.status.ready, false);
  assert.equal(runtime.status.weixinConnectionState, 'failed');
});

test('runtime preserves classified Harness health codes without exposing their causes', async () => {
  for (const code of [
    'harness-connect-failed',
    'harness-timeout',
    'harness-auth-required',
    'harness-proxy-auth-required',
    'harness-loopback-forbidden',
    'harness-host-untrusted',
    'harness-request-forbidden',
    'harness-api-not-found',
    'harness-http-failed',
    'harness-response-invalid',
    'harness-rpc-rejected',
  ]) {
    const healthError = Object.assign(new Error(`private detail for ${code}`), { code });
    const runtime = new WeixinRuntime({
      api: {
        notifyStart: async () => assert.fail('notifyStart must not run after a failed health check'),
        notifyStop: async () => {},
      },
      config: { botId: `wx_${code}`, baseUrl: 'https://ilinkai.weixin.qq.com/', ownerUserId: 'owner' },
      token: 'bot-token',
      harness: { ensureRunning: async () => { throw healthError; } },
      state: {},
    });

    await assert.rejects(runtime.start(), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.cause, healthError);
      assert.doesNotMatch(error.message, /private detail/);
      return true;
    });
  }
});

test('runtime retries a transient notifyStart failure before reporting the account offline', async () => {
  let startCalls = 0;
  const runtime = new WeixinRuntime({
    api: {
      notifyStart: async () => {
        startCalls += 1;
        if (startCalls === 1) {
          throw new WeixinApiError('network-error', 'temporary DNS failure');
        }
      },
      notifyStop: async () => {},
      sendText: async () => {},
      getUpdates: async ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
    },
    config: { botId: 'wx_retry', baseUrl: 'https://ilinkai.weixin.qq.com/', ownerUserId: 'owner' },
    token: 'bot-token',
    harness: { ensureRunning: async () => true },
    state: {},
    startRetryDelaysMs: [0],
    logger: { warn() {}, error() {} },
  });

  const started = await runtime.start();
  assert.equal(started.ready, true);
  assert.equal(startCalls, 2);
  await runtime.stop();
});
