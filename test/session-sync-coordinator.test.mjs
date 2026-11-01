import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HarnessClient,
  consumeDshImInputOrigin,
  isDshImInputOrigin,
} from '../src/channels/shared/harness-client.mjs';
import {
  classifyTurnInput,
  createSessionSyncCoordinator,
  installSessionSyncCoordinator,
  isImOwnedInput,
} from '../plugin-src/host/session-sync-coordinator.mjs';
import { registerSessionSyncMirror } from '../src/channels/shared/session-sync-registry.mjs';

const WEB_SOURCE = Object.freeze({ kind: 'user', rpcId: 'web-rpc' });
const CONTEXT_SOURCE = Object.freeze({ kind: 'runtime-context' });
const IM_SCOPE = 'http://127.0.0.1:3983';

function turnStart(turn = 1) {
  return { type: 'turn/start', data: { turn } };
}

function userMessage(text, source = WEB_SOURCE) {
  return {
    type: 'user/message',
    surfaceOp: 'append',
    data: { source, content: [{ type: 'text', text }] },
  };
}

function assistantMessage(step, text, turn = 1) {
  return {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      turn,
      step,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
  };
}

function toolCall(name = 'bash', turn = 1) {
  return { type: 'tool/call', surfaceOp: 'append', data: { turn, name } };
}

function turnEnd(reason = { kind: 'completed' }, turn = 1) {
  return { type: 'turn/end', data: { turn, reason } };
}

function settings(overrides = {}) {
  return async () => ({
    mirrorUserInput: false,
    deliverModelAnswers: true,
    inputIcon: '',
    modelIcon: '',
    ...overrides,
  });
}

/** A delivery service that follows one Session binding and records the sends. */
function deliveryService(sends, { failOn = () => false, result = () => ({ sent: true }) } = {}) {
  return {
    async deliverSessionText(sessionId, text, options) {
      if (failOn(text, options)) {
        const error = new Error('provider failure');
        error.code = 'delivery-failed';
        throw error;
      }
      sends.push({ sessionId, text, options });
      return result(text);
    },
  };
}

function hostContext() {
  const listeners = [];
  return {
    root: {},
    on(name, callback, options) {
      assert.equal(name, 'session/event');
      assert.deepEqual(options, { global: true });
      listeners.push(callback);
      return () => {
        listeners.splice(listeners.indexOf(callback), 1);
      };
    },
    effect(effect) { effect(); },
    emit(session, event) {
      for (const listener of [...listeners]) listener(session, event);
    },
  };
}

/**
 * Register one messenger prompt id the way a channel does: by asking the
 * harness. Only the registry interaction matters here, not the reply.
 */
async function messengerPrompt(sessionId) {
  let admit;
  const admitted = new Promise((resolve) => { admit = resolve; });
  let promptRpcId = null;
  const client = new HarnessClient({ baseUrl: IM_SCOPE, workspace: '/tmp/workspace' });
  client.ensureRunning = async () => true;
  client.rpc = async (method, payload, _timeoutMs, options = {}) => {
    if (method === 'workspace.list') return { items: [], archivedSessionIds: [] };
    if (method === 'session.history') return { events: [] };
    if (method === 'session.prompt' && payload.mode === 'queue') {
      promptRpcId = options.rpcId;
      admit();
      return {};
    }
    if (method === 'session.prompt') return {};
    if (method === 'session.cancel') return {};
    throw new Error(`Unexpected RPC ${method}`);
  };
  const asking = client.ask(sessionId, 'hello', { timeoutMs: 20 });
  asking.catch(() => {});
  await admitted;
  return { sessionId, rpcId: promptRpcId, asking };
}

test('classifyTurnInput splits IM, Web, and internal turns by their first input', () => {
  assert.equal(classifyTurnInput({ kind: 'user', rpcId: 'x' }, { imOwned: true }), 'im');
  assert.equal(classifyTurnInput({ kind: 'user', rpcId: 'x' }), 'web');
  assert.equal(classifyTurnInput(undefined), 'internal', 'a message without a source is Host framing');
  assert.equal(classifyTurnInput({ kind: 'runtime-context' }), 'internal');
  assert.equal(classifyTurnInput({ kind: 'schedule' }), 'internal');
  assert.equal(classifyTurnInput({ kind: 'user-question-reply' }), 'internal');
  assert.equal(classifyTurnInput({ kind: 'subagent-settled', form: 'notice' }), 'internal');
  assert.equal(classifyTurnInput({ kind: 'notice', form: 'notice' }), 'internal');
  assert.equal(classifyTurnInput({ kind: 'future-kind' }), 'internal');
  // A notice stays internal even if it borrows the `user` kind.
  assert.equal(classifyTurnInput({ kind: 'user', form: 'notice' }), 'internal');
});

test('a Session sync coordinator needs a service that can follow the binding', () => {
  assert.throws(() => createSessionSyncCoordinator({ deliveryService: {} }), {
    name: 'TypeError',
  });
  assert.throws(() => createSessionSyncCoordinator({
    deliveryService: { listSessionSyncTargets: async () => [], sendSessionSyncText: async () => {} },
  }), { name: 'TypeError' });
});

test('an IM-owned turn delivers nothing at all', async () => {
  const sends = [];
  const coordinator = createSessionSyncCoordinator({
    deliveryService: deliveryService(sends),
    loadSettings: settings({ mirrorUserInput: true, inputIcon: '👤', modelIcon: '🤖' }),
  });

  void coordinator.enqueue('session-im', turnStart(), 'im');
  void coordinator.enqueue('session-im', userMessage('IM question'), 'im');
  void coordinator.enqueue('session-im', assistantMessage(0, 'IM answer'), 'im');
  void coordinator.enqueue('session-im', turnEnd(), 'im');
  await coordinator.whenIdle();

  assert.deepEqual(sends, []);
});

test('Host framing inside a Web turn is never echoed', async () => {
  const sends = [];
  const coordinator = createSessionSyncCoordinator({
    deliveryService: deliveryService(sends),
    loadSettings: settings({ mirrorUserInput: true, inputIcon: '👤', modelIcon: '🤖' }),
  });

  void coordinator.enqueue('session-context', turnStart());
  void coordinator.enqueue('session-context', userMessage('desktop input'));
  // The Host injects its own context snapshot, a reminder, and a notice in the
  // middle of the same turn: none of them is the reader's own input.
  void coordinator.enqueue('session-context', userMessage('context snapshot', CONTEXT_SOURCE));
  void coordinator.enqueue('session-context', userMessage('reminder framing', { kind: 'schedule' }));
  void coordinator.enqueue('session-context', userMessage(
    'subagent finished',
    { kind: 'subagent-settled', form: 'notice' },
  ));
  void coordinator.enqueue('session-context', assistantMessage(0, 'answered the desktop'));
  void coordinator.enqueue('session-context', turnEnd());
  await coordinator.whenIdle();

  assert.deepEqual(sends, [
    { sessionId: 'session-context', text: '👤\n\ndesktop input', options: { format: 'plain' } },
    { sessionId: 'session-context', text: '🤖\n\nanswered the desktop', options: { format: 'markdown' } },
  ]);
});

test('an injection before the reader never makes the turn service-owned', async () => {
  for (const [label, events] of Object.entries({
    // The chat itself asked after the context snapshot: the messenger answers,
    // so a mirrored answer would be a duplicate.
    'injection before an IM prompt': [
      turnStart(),
      userMessage('runtime context', CONTEXT_SOURCE),
      userMessage('chat question', { kind: 'user', rpcId: 'im-rpc' }),
      assistantMessage(0, 'answered in the chat'),
      turnEnd(),
    ],
    // ...and the reverse order must stay silent for the same reason.
    'IM prompt before an injection': [
      turnStart(),
      userMessage('chat question', { kind: 'user', rpcId: 'im-rpc' }),
      userMessage('runtime context', CONTEXT_SOURCE),
      userMessage('subagent finished', { kind: 'subagent-settled', form: 'notice' }),
      assistantMessage(0, 'answered in the chat'),
      turnEnd(),
    ],
  })) {
    const sends = [];
    const warnings = [];
    const coordinator = createSessionSyncCoordinator({
      deliveryService: deliveryService(sends),
      loadSettings: settings({ mirrorUserInput: true, deliverModelAnswers: true, inputIcon: '👤', modelIcon: '🤖' }),
      logger: { warn: (line) => warnings.push(line) },
    });

    for (const event of events) {
      const origin = event.type === 'user/message' && event.data?.source?.rpcId === 'im-rpc' ? 'im' : 'other';
      void coordinator.enqueue('session-injected-im', event, origin);
    }
    await coordinator.whenIdle();

    assert.deepEqual(sends, [], label);
    assert.deepEqual(warnings, [], label);
  }
});

test('a chat message later in the turn still keeps the whole answer out of the chat', async () => {
  const sends = [];
  const coordinator = createSessionSyncCoordinator({
    deliveryService: deliveryService(sends),
    loadSettings: settings({ mirrorUserInput: true, deliverModelAnswers: true }),
  });

  // The turn started in the Web GUI, so its input is echoed there, but the
  // reader then steered it from the chat: the chat answers that part itself.
  void coordinator.enqueue('session-mixed', turnStart());
  void coordinator.enqueue('session-mixed', userMessage('desktop input'));
  void coordinator.enqueue('session-mixed', userMessage('steered from the chat', { kind: 'user', rpcId: 'im-rpc' }), 'im');
  void coordinator.enqueue('session-mixed', assistantMessage(0, 'answer'));
  void coordinator.enqueue('session-mixed', turnEnd());
  await coordinator.whenIdle();

  assert.deepEqual(sends.map((entry) => entry.text), ['desktop input']);
});

test('a Web turn survives an injection that arrived first and is delivered exactly once', async () => {
  for (const order of ['injection first', 'input first']) {
    const sends = [];
    const coordinator = createSessionSyncCoordinator({
      deliveryService: deliveryService(sends),
      loadSettings: settings({ mirrorUserInput: true, deliverModelAnswers: true, inputIcon: '👤', modelIcon: '🤖' }),
    });
    const injection = userMessage('runtime context', CONTEXT_SOURCE);
    const input = userMessage('desktop input');
    const events = [
      turnStart(),
      ...(order === 'injection first' ? [injection, input] : [input, injection]),
      assistantMessage(0, 'desktop answer'),
      turnEnd(),
    ];
    for (const event of events) void coordinator.enqueue('session-order', event);
    await coordinator.whenIdle();

    assert.deepEqual(sends, [
      { sessionId: 'session-order', text: '👤\n\ndesktop input', options: { format: 'plain' } },
      { sessionId: 'session-order', text: '🤖\n\ndesktop answer', options: { format: 'markdown' } },
    ], order);
  }
});

test('a refused markdown answer is sent once more as plain text', async () => {
  const sends = [];
  const coordinator = createSessionSyncCoordinator({
    deliveryService: deliveryService(sends, { failOn: (_text, options) => options?.format === 'markdown' }),
    loadSettings: settings({ deliverModelAnswers: true, modelIcon: '' }),
    logger: { warn: () => {} },
  });

  void coordinator.enqueue('session-plain', turnStart());
  void coordinator.enqueue('session-plain', userMessage('input', { kind: 'schedule' }));
  void coordinator.enqueue('session-plain', assistantMessage(0, '**answer**'));
  void coordinator.enqueue('session-plain', turnEnd());
  await coordinator.whenIdle();

  assert.deepEqual(sends, [{
    sessionId: 'session-plain',
    text: '**answer**',
    options: { format: 'plain' },
  }]);
});

test('an uncertain markdown send is never repeated', async () => {
  let attempts = 0;
  const warnings = [];
  const coordinator = createSessionSyncCoordinator({
    deliveryService: {
      async deliverSessionText() {
        attempts += 1;
        const error = new Error('delivery result unknown');
        error.code = 'send-result-unknown';
        throw error;
      },
    },
    loadSettings: settings({ deliverModelAnswers: true }),
    logger: { warn: (line) => warnings.push(line) },
  });

  void coordinator.enqueue('session-uncertain', turnStart());
  void coordinator.enqueue('session-uncertain', userMessage('input', { kind: 'schedule' }));
  void coordinator.enqueue('session-uncertain', assistantMessage(0, 'answer'));
  void coordinator.enqueue('session-uncertain', turnEnd());
  await coordinator.whenIdle();

  // A visible answer plus a plain retry would duplicate it in the chat.
  assert.equal(attempts, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /send-result-unknown/);
});

test('the chat receives the final answer after the last tool call, not the step transcript', async () => {
  const sends = [];
  const coordinator = createSessionSyncCoordinator({
    deliveryService: deliveryService(sends),
    loadSettings: settings({ deliverModelAnswers: true, modelIcon: '🤖' }),
  });

  void coordinator.enqueue('session-final', turnStart());
  void coordinator.enqueue('session-final', userMessage('what is in this repo?', { kind: 'schedule' }));
  void coordinator.enqueue('session-final', assistantMessage(0, 'Let me look at the files first.'));
  void coordinator.enqueue('session-final', toolCall('bash'));
  void coordinator.enqueue('session-final', assistantMessage(1, 'It is the dsh-im plugin.'));
  void coordinator.enqueue('session-final', turnEnd());
  await coordinator.whenIdle();

  assert.deepEqual(sends.map((entry) => entry.text), ['🤖\n\nIt is the dsh-im plugin.']);
});

test('an answer that follows a tool call loses the preamble, even when it arrives in fragments', async () => {
  const sends = [];
  const coordinator = createSessionSyncCoordinator({
    deliveryService: deliveryService(sends),
    loadSettings: settings({ modelIcon: '' }),
  });

  void coordinator.enqueue('session-chunks', turnStart());
  void coordinator.enqueue('session-chunks', userMessage('go', { kind: 'schedule' }));
  void coordinator.enqueue('session-chunks', assistantMessage(0, 'preamble'));
  void coordinator.enqueue('session-chunks', toolCall('bash'));
  void coordinator.enqueue('session-chunks', {
    type: 'assistant/chunk',
    surfaceOp: 'append',
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'final ' } },
  });
  void coordinator.enqueue('session-chunks', {
    type: 'assistant/chunk',
    surfaceOp: 'append',
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'answer' } },
  });
  void coordinator.enqueue('session-chunks', turnEnd());
  await coordinator.whenIdle();

  assert.deepEqual(sends.map((entry) => entry.text), ['final answer']);
});

for (const kind of ['schedule', 'user-question-reply']) {
  test(`a ${kind} turn is internal: no echo, answer delivered without icons`, async () => {
    const sends = [];
    const coordinator = createSessionSyncCoordinator({
      deliveryService: deliveryService(sends),
      loadSettings: settings(),
    });

    void coordinator.enqueue('session-internal', turnStart());
    void coordinator.enqueue('session-internal', userMessage('reminder framing', { kind }));
    void coordinator.enqueue('session-internal', assistantMessage(0, 'the answer'));
    assert.deepEqual(sends, [], 'nothing is sent before the turn completes');
    void coordinator.enqueue('session-internal', turnEnd());
    await coordinator.whenIdle();

    assert.deepEqual(sends, [{
      sessionId: 'session-internal',
      text: 'the answer',
      options: { format: 'markdown' },
    }]);
  });
}

test('a Web turn with the input mirror off sends no echo but still delivers the answer', async () => {
  const sends = [];
  const coordinator = createSessionSyncCoordinator({
    deliveryService: deliveryService(sends),
    loadSettings: settings({ mirrorUserInput: false }),
  });

  void coordinator.enqueue('session-web', turnStart());
  void coordinator.enqueue('session-web', userMessage('desktop input'));
  void coordinator.enqueue('session-web', assistantMessage(0, 'desktop answer'));
  void coordinator.enqueue('session-web', turnEnd());
  await coordinator.whenIdle();

  assert.deepEqual(sends.map((entry) => [entry.sessionId, entry.text]), [
    ['session-web', 'desktop answer'],
  ]);
});

test('a Web turn with the input mirror on echoes the input and delivers the answer to the same binding', async () => {
  const sends = [];
  const coordinator = createSessionSyncCoordinator({
    deliveryService: deliveryService(sends),
    loadSettings: settings({ mirrorUserInput: true, inputIcon: '👤', modelIcon: '🤖' }),
  });

  void coordinator.enqueue('session-mirror', turnStart());
  void coordinator.enqueue('session-mirror', userMessage('first input'));
  void coordinator.enqueue('session-mirror', userMessage('second input', { kind: 'user', rpcId: 'steer-rpc' }));
  void coordinator.enqueue('session-mirror', assistantMessage(0, 'mirrored answer'));
  void coordinator.enqueue('session-mirror', turnEnd());
  await coordinator.whenIdle();

  assert.deepEqual(sends, [
    { sessionId: 'session-mirror', text: '👤\n\nfirst input', options: { format: 'plain' } },
    { sessionId: 'session-mirror', text: '👤\n\nsecond input', options: { format: 'plain' } },
    { sessionId: 'session-mirror', text: '🤖\n\nmirrored answer', options: { format: 'markdown' } },
  ]);
});

test('repeating the same Web input in one turn is echoed once', async () => {
  const sends = [];
  const coordinator = createSessionSyncCoordinator({
    deliveryService: deliveryService(sends),
    loadSettings: settings({ mirrorUserInput: true }),
  });

  void coordinator.enqueue('session-repeat', turnStart());
  void coordinator.enqueue('session-repeat', userMessage('same text'));
  void coordinator.enqueue('session-repeat', userMessage('same text'));
  void coordinator.enqueue('session-repeat', assistantMessage(0, 'answer'));
  void coordinator.enqueue('session-repeat', turnEnd());
  await coordinator.whenIdle();

  assert.deepEqual(sends.map((entry) => entry.text), ['same text', 'answer']);
});

test('an undelivered input mirror keeps the answer back', async () => {
  const sends = [];
  const coordinator = createSessionSyncCoordinator({
    deliveryService: deliveryService(sends, { failOn: (text) => text.startsWith('👤') }),
    loadSettings: settings({ mirrorUserInput: true, inputIcon: '👤', modelIcon: '🤖' }),
    logger: { warn: () => {} },
  });

  void coordinator.enqueue('session-broken', turnStart());
  void coordinator.enqueue('session-broken', userMessage('input nobody saw'));
  void coordinator.enqueue('session-broken', assistantMessage(0, 'answer nobody should see'));
  void coordinator.enqueue('session-broken', turnEnd());
  await coordinator.whenIdle();

  assert.deepEqual(sends, []);
});

test('an unbound Session and an unroutable conversation are logged, never swallowed', async () => {
  for (const reason of ['unbound', 'unroutable']) {
    const sends = [];
    const warnings = [];
    const coordinator = createSessionSyncCoordinator({
      deliveryService: deliveryService(sends, { result: () => ({ sent: false, reason }) }),
      loadSettings: settings({ deliverModelAnswers: true }),
      logger: { warn: (line) => warnings.push(line) },
    });

    void coordinator.enqueue(`session-${reason}`, turnStart());
    void coordinator.enqueue(`session-${reason}`, userMessage('desktop input', { kind: 'schedule' }));
    void coordinator.enqueue(`session-${reason}`, assistantMessage(0, 'answer'));
    void coordinator.enqueue(`session-${reason}`, turnEnd());
    await coordinator.whenIdle();

    // The answer was offered and found no address. That is not an error, but it
    // must be visible: one warning names the Session and the reason, and never
    // repeats the text that was not delivered.
    assert.deepEqual(sends.map((entry) => entry.text), ['answer'], reason);
    assert.equal(warnings.length, 1, reason);
    assert.match(warnings[0], new RegExp(`\\[${reason}\\]`), reason);
    assert.match(warnings[0], new RegExp(`session=session-${reason}`), reason);
    assert.doesNotMatch(warnings[0], /answer/, reason);
  }
});

test('turn settings decide delivery: a disabled answer is dropped, a broken document fails closed', async () => {
  const cases = [
    ['a disabled answer', settings({ deliverModelAnswers: false }), [], false],
    ['an unreadable document', async () => { throw new Error('disk failure'); }, [], true],
    ['the default document', null, [], false],
  ];
  for (const [label, loadSettings, expected, warned] of cases) {
    const sends = [];
    const warnings = [];
    const coordinator = createSessionSyncCoordinator({
      deliveryService: deliveryService(sends),
      ...(loadSettings ? { loadSettings } : {}),
      logger: { warn: (line) => warnings.push(line) },
    });
    void coordinator.enqueue('session-settings', turnStart());
    void coordinator.enqueue('session-settings', userMessage('input', { kind: 'schedule' }));
    void coordinator.enqueue('session-settings', assistantMessage(0, 'answer'));
    void coordinator.enqueue('session-settings', turnEnd());
    await coordinator.whenIdle();
    assert.deepEqual(sends.map((entry) => entry.text), expected, label);
    assert.equal(warnings.length, warned ? 1 : 0, label);
    if (warned) assert.match(warnings[0], /ignored Session sync settings failure/);
  }
});

test('unsuccessful turns and replaced input never deliver an answer', async () => {
  const sends = [];
  const coordinator = createSessionSyncCoordinator({
    deliveryService: deliveryService(sends),
    loadSettings: settings({ mirrorUserInput: true }),
  });

  void coordinator.enqueue('session-failed', turnStart());
  void coordinator.enqueue('session-failed', userMessage('failing input'));
  void coordinator.enqueue('session-failed', assistantMessage(0, 'never delivered'));
  void coordinator.enqueue('session-failed', turnEnd({ kind: 'error' }));

  void coordinator.enqueue('session-replace', turnStart());
  void coordinator.enqueue('session-replace', { ...userMessage('replaced input'), surfaceOp: 'replace' });
  void coordinator.enqueue('session-replace', assistantMessage(0, 'nobody asked'));
  void coordinator.enqueue('session-replace', turnEnd());
  await coordinator.whenIdle();

  // The mirrored input is already visible in the chat, so it stays; only the
  // answer of a failed or replaced turn is dropped.
  assert.deepEqual(sends.map((entry) => [entry.sessionId, entry.text]), [
    ['session-failed', 'failing input'],
  ]);
});

test('the ownership lookup is not destructive and never blocks the channel', async () => {
  const prompt = await messengerPrompt('session-peek');

  assert.equal(isImOwnedInput(IM_SCOPE, userMessage('x', { kind: 'user', rpcId: prompt.rpcId })), true);
  // Any number of observers in any order read the same answer.
  assert.equal(isDshImInputOrigin(IM_SCOPE, prompt.rpcId), true);
  assert.equal(isDshImInputOrigin(IM_SCOPE, prompt.rpcId), true);
  assert.equal(isImOwnedInput(IM_SCOPE, userMessage('x', { kind: 'user', rpcId: 'unknown' })), false);
  assert.equal(isImOwnedInput(IM_SCOPE, { data: { source: { kind: 'runtime-context' } } }), false);
  // The channel that owns the id can still claim it afterwards.
  assert.equal(consumeDshImInputOrigin(IM_SCOPE, prompt.rpcId), true);
  assert.equal(isDshImInputOrigin(IM_SCOPE, prompt.rpcId), false);
  await prompt.asking.catch(() => {});
});

test('an installed coordinator never mirrors a messenger turn a channel also observes', async () => {
  for (const order of ['channel first', 'coordinator first']) {
    const prompt = await messengerPrompt(`session-im-${order.replace(' ', '-')}`);
    const sends = [];
    const ctx = hostContext();
    const installed = installSessionSyncCoordinator(ctx, deliveryService(sends), {
      inputScope: IM_SCOPE,
      loadSettings: settings({ mirrorUserInput: true, inputIcon: '👤', modelIcon: '🤖' }),
    });
    const channelObserves = () => assert.equal(isDshImInputOrigin(IM_SCOPE, prompt.rpcId), true);
    if (order === 'channel first') {
      channelObserves();
      channelObserves();
    }

    for (const event of [
      turnStart(),
      userMessage('from the chat', { kind: 'user', rpcId: prompt.rpcId }),
      assistantMessage(0, 'answer in the chat'),
      turnEnd(),
    ]) {
      ctx.emit({ id: prompt.sessionId }, event);
    }
    await installed.whenIdle();

    // The chat already shows this answer: nothing is echoed and nothing is
    // delivered a second time, whatever the order of the observers.
    assert.deepEqual(sends, [], order);
    // ...and the id is still there for the channel that owns it.
    assert.equal(consumeDshImInputOrigin(IM_SCOPE, prompt.rpcId), true, order);
    installed.close();
    await prompt.asking.catch(() => {});
  }
});

test('a bot with configured targets delivers through the target path, never the binding', async () => {
  const calls = [];
  const service = {
    async describeConversation() {
      return { channel: 'telegram', botId: 'bot-1', conversationKey: 'group:-100' };
    },
    async listTargets(botId) {
      assert.equal(botId, 'bot-1');
      return { targets: [{ targetId: 't1', sessionSync: { enabled: true, state: 'active' } }] };
    },
    async listSessionSyncTargets(sessionId) {
      assert.equal(sessionId, 'session-1');
      return [{ channel: 'telegram', botId: 'bot-1', targetId: 't1' }];
    },
    async sendSessionSyncText(botId, targetId, sessionId, text, options) {
      calls.push({ path: 'target', botId, targetId, text, options });
    },
    async deliverSessionText() {
      calls.push({ path: 'binding' });
      return { sent: true };
    },
  };
  const coordinator = createSessionSyncCoordinator({
    deliveryService: service,
    loadSettings: settings({ deliverModelAnswers: true, modelIcon: '🤖' }),
  });
  void coordinator.enqueue('session-1', turnStart());
  void coordinator.enqueue('session-1', userMessage('hello'));
  void coordinator.enqueue('session-1', assistantMessage(0, 'answer'));
  void coordinator.enqueue('session-1', turnEnd());
  await coordinator.whenIdle();

  assert.ok(calls.some((call) => call.path === 'target'), 'the old target path sent the answer');
  assert.ok(!calls.some((call) => call.path === 'binding'), 'the binding path must not also send');
  assert.equal(calls.find((call) => call.path === 'target').options.format, 'markdown', 'non-Feishu keeps rich text');
  coordinator.close();
});

test('a bot without configured targets delivers through the Session binding', async () => {
  const sends = [];
  const service = {
    async describeConversation() {
      return { channel: 'telegram', botId: 'bot-1', conversationKey: 'group:-100' };
    },
    async listTargets() {
      return { targets: [] };
    },
    async deliverSessionText(sessionId, text, options) {
      sends.push({ sessionId, text, options });
      return { sent: true };
    },
  };
  const coordinator = createSessionSyncCoordinator({
    deliveryService: service,
    loadSettings: settings({ deliverModelAnswers: true, modelIcon: '🤖' }),
  });
  void coordinator.enqueue('session-1', turnStart());
  void coordinator.enqueue('session-1', userMessage('hello'));
  void coordinator.enqueue('session-1', assistantMessage(0, 'answer'));
  void coordinator.enqueue('session-1', turnEnd());
  await coordinator.whenIdle();

  assert.equal(sends.length, 1);
  assert.equal(sends[0].sessionId, 'session-1');
  coordinator.close();
});

/**
 * A delivery service for a bot with configured targets. `sends` records what the
 * text path delivered, so a test can prove the card replaced it.
 */
function targetService(sends, targets) {
  return {
    async describeConversation() {
      return { channel: targets[0].channel, botId: targets[0].botId, conversationKey: 'dm:1' };
    },
    async listTargets() {
      return { targets: targets.map((target) => ({ targetId: target.targetId })) };
    },
    async listSessionSyncTargets() {
      return targets;
    },
    async sendSessionSyncText(botId, targetId, sessionId, text, options) {
      sends.push({ botId, targetId, text, options });
    },
    async deliverSessionText() {
      throw new Error('the target path must own a bot that has targets');
    },
  };
}

/** Drive one completed scheduled turn: no echo, only the final answer. */
async function scheduledTurn(coordinator, text, sessionId = 'session-1', turn = 1) {
  void coordinator.enqueue(sessionId, { type: 'turn/start', data: { turn } });
  void coordinator.enqueue(sessionId, {
    type: 'user/message',
    surfaceOp: 'append',
    data: { source: { kind: 'schedule' }, content: [{ type: 'text', text: 'reminder' }] },
  });
  void coordinator.enqueue(sessionId, assistantMessage(0, text, turn));
  void coordinator.enqueue(sessionId, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
  await coordinator.whenIdle();
}

test('disabled saved targets never fall through to Session binding delivery', async (t) => {
  const sends = [];
  const service = targetService(sends, [{ channel: 'feishu', botId: 'bot-1', targetId: 't1' }]);
  service.listSessionSyncTargets = async () => [];
  service.deliverSessionText = async () => { sends.push('binding'); return { sent: true }; };
  const coordinator = createSessionSyncCoordinator({
    deliveryService: service,
    loadSettings: settings({ deliverModelAnswers: true }),
    logger: { warn() {} },
  });
  t.after(() => coordinator.close());
  await scheduledTurn(coordinator, 'scheduled answer');
  assert.deepEqual(sends, []);
});

test('a confirmed card is the answer: the coordinator sends no second copy', async (t) => {
  const rendered = [];
  const unregister = registerSessionSyncMirror({ channel: 'feishu', botId: 'bot-1' },
    async (request) => {
      rendered.push(request);
      return true;
    });
  t.after(unregister);
  const sends = [];
  const coordinator = createSessionSyncCoordinator({
    deliveryService: targetService(sends, [{ channel: 'feishu', botId: 'bot-1', targetId: 't1' }]),
    loadSettings: settings({ deliverModelAnswers: true, modelIcon: '🤖' }),
  });
  await scheduledTurn(coordinator, 'scheduled answer');
  coordinator.close();

  assert.deepEqual(sends, [], 'the card already carries the answer');
  assert.equal(rendered.length, 1);
  assert.deepEqual(rendered[0].target, { channel: 'feishu', botId: 'bot-1', targetId: 't1' });
  assert.equal(rendered[0].sessionId, 'session-1');
  assert.equal(rendered[0].turn, 1);
  // The card shows the answer itself, without the label that marks a message.
  assert.equal(rendered[0].text, 'scheduled answer');
});

test('an unconfirmed card falls back to exactly one text delivery', async (t) => {
  for (const [label, render] of Object.entries({
    'renders nothing': async () => false,
    'throws': async () => { throw new Error('provider failure'); },
  })) {
    const unregister = registerSessionSyncMirror({ channel: 'feishu', botId: 'bot-1' }, render);
    const sends = [];
    const warnings = [];
    const coordinator = createSessionSyncCoordinator({
      deliveryService: targetService(sends, [{ channel: 'feishu', botId: 'bot-1', targetId: 't1' }]),
      loadSettings: settings({ deliverModelAnswers: true, modelIcon: '🤖' }),
      logger: { warn: (line) => warnings.push(line) },
    });
    await scheduledTurn(coordinator, 'scheduled answer');
    coordinator.close();
    unregister();

    assert.equal(sends.length, 1, label);
    assert.equal(sends[0].targetId, 't1', label);
    assert.equal(sends[0].options.format, 'plain', label);
    assert.equal(sends[0].text, '🤖\n\nscheduled answer', label);
  }
});

test('only the targets whose card did not confirm receive text', async (t) => {
  const unregister = registerSessionSyncMirror({ channel: 'feishu', botId: 'bot-1' },
    async () => true);
  t.after(unregister);
  const sends = [];
  const targets = [
    { channel: 'feishu', botId: 'bot-1', targetId: 't1' },
    { channel: 'telegram', botId: 'bot-2', targetId: 't2' },
  ];
  const coordinator = createSessionSyncCoordinator({
    deliveryService: targetService(sends, targets),
    loadSettings: settings({ deliverModelAnswers: true }),
  });
  await scheduledTurn(coordinator, 'scheduled answer');
  coordinator.close();

  assert.deepEqual(sends.map((entry) => [entry.botId, entry.targetId]), [['bot-2', 't2']]);
  assert.equal(sends[0].options.format, 'markdown', 'a text target keeps its rich rendering');
});

test('a mirrored user input never waits for a card receipt', async (t) => {
  const rendered = [];
  const unregister = registerSessionSyncMirror({ channel: 'feishu', botId: 'bot-1' },
    async (request) => { rendered.push(request); return true; });
  t.after(unregister);
  const sends = [];
  const coordinator = createSessionSyncCoordinator({
    deliveryService: targetService(sends, [{ channel: 'feishu', botId: 'bot-1', targetId: 't1' }]),
    loadSettings: settings({ mirrorUserInput: true, deliverModelAnswers: true, inputIcon: '👤' }),
  });
  void coordinator.enqueue('session-1', turnStart());
  void coordinator.enqueue('session-1', userMessage('desktop input'));
  void coordinator.enqueue('session-1', assistantMessage(0, 'answer'));
  void coordinator.enqueue('session-1', turnEnd());
  await coordinator.whenIdle();
  coordinator.close();

  // The input has no card of its own, so its echo stays a text message; only the
  // final answer is owned by the card.
  assert.deepEqual(sends.map((entry) => entry.text), ['👤\n\ndesktop input']);
  assert.deepEqual(rendered.map((entry) => entry.text), ['answer']);
});
