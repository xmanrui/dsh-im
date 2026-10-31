import assert from 'node:assert/strict';
import test from 'node:test';
import { HarnessReplyTracker } from '../src/channels/shared/harness-client.mjs';
import { classifyMessageFailure } from '../src/channels/shared/message-failure.mjs';

const reason = { kind: 'error', error: {
  code: 'UNKNOWN_MODEL', message: 'The previous model is no longer configured',
} };
const event = (seq, type, data) => ({ seq, type, data });
const insert = (seq, rpcId, start = 0, target = 'next-turn') => event(seq, 'agent/inbox/spliced', {
  target, start, inserted: [{ id: rpcId, source: { kind: 'user', rpcId }, content: [] }],
});
const claim = (seq, start = 0, target = 'next-turn', extra = {}) => event(seq, 'agent/inbox/spliced', {
  target, start, removedCount: 1, inserted: [], ...extra,
});
const start = (seq, turn) => event(seq, 'turn/start', { turn });
const end = (seq, turn, value = reason) => event(seq, 'turn/end', { turn, reason: value });

// The durable sequence recorded by both reported channels on DSH 0.2.1-rc.2:
// the inbox claims the prompt, but model resolution fails before user/message.
function failedPrompt(rpcId) {
  return [event(42, 'session/end-seed', {}), insert(43, rpcId), start(44, 4), claim(45),
    event(46, 'step/start', { turn: 4, step: 1 }),
    event(47, 'step/end', { turn: 4, step: 1 }), end(48, 4)];
}

test('a claimed prompt reports a model failure before user/message is written', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: 'im', afterSeq: 41 });
  tracker.consumeAll(failedPrompt('im'));
  assert.equal(tracker.finished, true);
  assert.equal(tracker.turn, 4);
  assert.deepEqual(tracker.reason, reason);
  assert.equal(tracker.answer, '');
});

test('partial and repeated history polls retain the exact inbox claim', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: 'im', afterSeq: 41 });
  const rows = failedPrompt('im');
  tracker.consumeAll(rows.slice(0, 2));
  tracker.consumeAll(rows.slice(0, 4));
  tracker.consumeAll(rows.slice(2, 6));
  assert.equal(tracker.turn, null, 'an inbox claim alone grants no live reply ownership');
  tracker.consumeAll(rows.slice(3));
  assert.equal(tracker.finished, true);
  assert.equal(tracker.turn, 4);
});

for (const target of ['next-turn', 'next-step']) {
  test(`a queued ${target} prompt does not inherit another request's failure`, () => {
    const tracker = new HarnessReplyTracker({ promptRpcId: 'im' });
    tracker.consumeAll([insert(0, 'desktop', 0, target), insert(1, 'im', 1, target),
      start(2, 1), claim(3, 0, target), end(4, 1)]);
    assert.equal(tracker.finished, false);
    tracker.consumeAll([start(5, 2), claim(6, 0, target), end(7, 2)]);
    assert.equal(tracker.finished, true);
    assert.equal(tracker.turn, 2);
  });
}

for (const variant of ['canceled', 'replaced', 'gap', 'unrelated', 'completed']) {
  test(`${variant} inbox history cannot establish an early failure for this prompt`, () => {
    const tracker = new HarnessReplyTracker({ promptRpcId: 'im' });
    const rows = [insert(0, variant === 'unrelated' ? 'desktop' : 'im'), start(1, 1)];
    rows.push(claim(variant === 'gap' ? 3 : 2, 0, 'next-turn',
      variant === 'canceled' ? { outcome: 'canceled' }
        : variant === 'replaced' ? { outcome: 'canceled', inserted: [{ source: { rpcId: 'desktop' } }] } : {}));
    rows.push(end(variant === 'gap' ? 4 : 3, 1, variant === 'completed' ? { kind: 'completed' } : reason));
    tracker.consumeAll(rows);
    assert.equal(tracker.finished, false);
    assert.equal(tracker.turn, null);
  });
}

const clients = [
  ['weixin', 'HarnessClient'], ['qq', 'QqHarnessClient'], ['feishu', 'HarnessClient'],
  ['dingtalk', 'HarnessClient'], ['wecom', 'WecomHarnessClient'], ['wecom-app', 'WecomAppHarnessClient'],
  ['telegram', 'TelegramHarnessClient'], ['discord', 'DiscordHarnessClient'], ['slack', 'SlackHarnessClient'],
  ['whatsapp', 'WhatsappHarnessClient'], ['imessage', 'IMessageHarnessClient'], ['email', 'EmailHarnessClient'],
  ['matrix', 'MatrixHarnessClient'], ['office', 'HarnessClient'],
];
for (const [channel, exportName] of clients) {
  test(`${channel} releases an early failed turn with MODEL_UNAVAILABLE instead of waiting for timeout`, async () => {
    const directory = channel === 'office' ? 'shared' : channel;
    const file = channel === 'matrix' ? 'matrix-harness-client' : 'harness-client';
    const { [exportName]: Client } = await import(`../src/channels/${directory}/${file}.mjs`);
    const client = new Client({ workspace: '/tmp', baseUrl: 'http://127.0.0.1:3080' });
    let events = [end(41, 3, { kind: 'completed' })];
    client.rpc = async (method, _payload, _timeout, options) => {
      if (method === 'host.describe') return {};
      if (method === 'workspace.list') return { archivedSessionIds: [] };
      if (method === 'session.history') return { events: events.map(event => ({ event })) };
      if (method === 'session.prompt') { events.push(...failedPrompt(options.rpcId)); return { accepted: true }; }
      assert.fail(`unexpected RPC ${method}`);
    };
    await assert.rejects(client.ask('session', 'hello', {
      timeoutMs: 600_000, signal: AbortSignal.timeout(2_000),
    }), error => {
      assert.equal(error.code, 'harness-turn-failed');
      assert.equal(error.providerCode, 'UNKNOWN_MODEL');
      assert.equal(classifyMessageFailure(error).code, 'MODEL_UNAVAILABLE');
      return true;
    });
  });
}

for (const channel of ['discord', 'whatsapp']) {
  test(`${channel} bridge reports the model error and drains a queued /new`, async (t) => {
    const title = channel === 'discord' ? 'Discord' : 'Whatsapp';
    const { [`${title}HarnessClient`]: Client } = await import(`../src/channels/${channel}/harness-client.mjs`);
    const { [`${title}HarnessBridge`]: Bridge } = await import(`../src/channels/${channel}/${channel}-bridge.mjs`);
    const client = new Client({ workspace: '/tmp', baseUrl: 'http://127.0.0.1:3080' });
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(2_000)]);
    let events = [end(41, 3, { kind: 'completed' })];
    client.sessionExists = async () => true;
    client.rpc = async (method, _payload, _timeout, options) => {
      if (method === 'host.describe') return {};
      if (method === 'workspace.list') return { archivedSessionIds: [] };
      if (method === 'session.history') return { events: events.map(event => ({ event })) };
      if (method === 'session.prompt') { events.push(...failedPrompt(options.rpcId)); return { accepted: true }; }
      assert.fail(`unexpected RPC ${method}`);
    };
    client.watchInteractions = async (_sessionId, { signal, onOpen }) => {
      onOpen?.();
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    };
    const seen = new Set(), sent = [];
    let binding = 'session';
    const bridge = new Bridge({ harness: client, signal, coalesceWindowMs: 0,
      state: { sessionFor: () => binding, hasSeen: id => seen.has(id),
        markSeen: async id => { seen.add(id); }, clearSession: async () => { binding = null; } },
      bot: { sendText: async (_target, text) => { sent.push(text); } },
      logger: { warn() {}, error() {}, info() {} },
    });
    t.after(async () => { controller.abort(); await bridge.waitForIdle(); });
    const message = (messageId, content) => ({ messageId, content, senderId: 'owner',
      senderIsBot: false, kind: 'direct', conversationId: 'chat', addressed: true,
      replyTarget: { jid: 'self', selfChat: true, id: 'chat' } });
    await Promise.all([bridge.accept(message('question', 'hello')), bridge.accept(message('new', '/new'))]);
    assert.equal(signal.aborted, false, 'the failure must release the queue before the guard timeout');
    assert.ok(sent.some(text => text.includes('当前模型不存在')));
    assert.ok(sent.some(text => text.includes('暂时无法创建新会话')));
    assert.equal(binding, 'session', 'a failed eager create keeps the previous binding');
  });
}
