import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeishuHarnessBridge } from '../src/channels/feishu/bridge.mjs';
import { StateStore } from '../src/channels/feishu/state-store.mjs';
import { HarnessReplyTracker } from '../src/channels/shared/harness-client.mjs';
import { extractCompletedTurnAnswer } from '../src/channels/shared/deferred-delivery.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function gate() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(5); } throw new Error('repro setup timed out'); }
const key = 'p2p:ou_owner';
const sessionId = 'session-timeout';
const answer = { type: 'assistant/message', seq: 7, data: { turn: 3, step: 0, message: { content: [{ type: 'text', text: '计算结果：42' }] } } };
const end = { type: 'turn/end', seq: 8, data: { turn: 3, reason: 'completed' } };
const entry = (patch = {}) => ({ id: `${key} ${sessionId} 3`, key, chatId: 'oc_chat', replyToMessageId: 'om_input', sessionId, turn: 3, afterSeq: 6, lastSeenEndSeq: -1, attempts: 0, status: 'pending', createdAt: 1, ...patch });

async function fixture(t, { history = [answer, end], seed = null, channel = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pr153-repro-'));
  const state = await new StateStore(join(dir, 'state.json')).load();
  await state.setSession(key, sessionId);
  if (seed) await state.putDeferred(seed);
  const abort = new AbortController();
  const sent = [];
  const cancels = [];
  const listeners = [];
  let historyCalls = 0;
  let currentHistory = history;
  const harness = {
    ensureRunning: async () => true,
    rpc: async (method, params) => {
      if (method === 'session.history') { historyCalls++; return { events: currentHistory }; }
      if (method === 'session.cancel') { cancels.push(params); return {}; }
      throw new Error(`unexpected rpc ${method}`);
    },
    workspaceSession: () => ({ stopActiveTurn: async () => false }),
    watchHarnessEvents: (callbacks) => { listeners.push(callbacks); return new Promise((resolve) => abort.signal.addEventListener('abort', resolve, { once: true })); },
  };
  const send = async (request) => { sent.push(JSON.parse(request.data.content).text); return { code: 0, data: { message_id: `out-${sent.length}` } }; };
  const bridge = new FeishuHarnessBridge({
    client: { im: { v1: { message: { create: send, reply: send } } } },
    channel, harness, state, signal: abort.signal,
    status: { messagesReceived: 0, messagesReplied: 0, messagesRejected: 0 },
    allowedSenderOpenIds: new Set(['ou_owner']),
    groupTopicReply: true,
    logger: { warn() {}, error() {}, info() {} },
  });
  t.after(async () => { abort.abort(); await bridge.waitForIdle(); await sleep(20); await rm(dir, { recursive: true, force: true }); });
  await bridge.waitForIdle();
  return { state, bridge, harness, sent, cancels, listeners, historyCalls: () => historyCalls, setHistory: (events) => { currentHistory = events; } };
}

test('V2: a slow compensation snapshot must not re-send an already consumed entry', async (t) => {
  const f = await fixture(t);
  await f.state.putDeferred(entry());
  const slowHistory = gate();
  let reads = 0;
  f.harness.rpc = async (method) => {
    assert.equal(method, 'session.history');
    reads++;
    if (reads === 1) await slowHistory.promise;
    return { events: [answer, end] };
  };
  f.listeners[0].onReconnect();
  await until(() => reads === 1);
  // Reconnect has an entry snapshot, but its RPC is slower than the live path.
  f.listeners[0].onSessionEvent({ sessionId, event: end });
  await f.bridge.waitForIdle();
  assert.equal(f.sent.length, 1);
  assert.equal(f.state.deferredEntries().length, 0);
  slowHistory.resolve();
  await sleep(40);
  assert.equal(f.sent.length, 1, 'slow compensation must re-check whether its snapshot is still pending');
});

test('V2: /stop must not cancel a newer turn started between history and run-state checks', async (t) => {
  const f = await fixture(t, { history: [
    { type: 'turn/start', seq: 5, data: { turn: 3 } },
    { type: 'user/message', seq: 6, data: { turn: 3, source: { rpcId: 'im-old' } } },
  ] });
  await f.state.putDeferred(entry());
  let actualRunningTurn = 3;
  const cancelledTurns = [];
  const originalRpc = f.harness.rpc;
  f.harness.rpc = async (method, params) => {
    if (method === 'session.cancel') cancelledTurns.push(actualRunningTurn);
    return originalRpc(method, params);
  };
  f.harness.isSessionRunning = async () => {
    // The old turn finishes and a desktop prompt starts during these RPCs.
    actualRunningTurn = 4;
    f.setHistory([answer, end,
      { type: 'turn/start', seq: 9, data: { turn: 4 } },
      { type: 'user/message', seq: 10, data: { source: { rpcId: 'desktop-new' } } },
    ]);
    return true;
  };
  await f.bridge.accept({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } }, message: { message_id: 'stop-race', message_type: 'text', chat_type: 'p2p', chat_id: 'oc_chat', content: JSON.stringify({ text: '/stop' }) } });
  await f.bridge.waitForIdle();
  assert.deepEqual(cancelledTurns, [], 'turn 4 is not owned by the pending entry for turn 3');
});

test('V2: /stop must not infer target ownership from its absence in a truncated history', async (t) => {
  const f = await fixture(t, { history: [
    { type: 'turn/end', seq: 500, data: { turn: 98, reason: 'completed' } },
    { type: 'turn/start', seq: 501, data: { turn: 99 } },
    { type: 'user/message', seq: 502, data: { source: { rpcId: 'desktop-new' } } },
  ] });
  await f.state.putDeferred(entry({ attempts: 1 }));
  f.harness.isSessionRunning = async () => true;
  await f.bridge.accept({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } }, message: { message_id: 'stop-truncated', message_type: 'text', chat_type: 'p2p', chat_id: 'oc_chat', content: JSON.stringify({ text: '/stop' }) } });
  await f.bridge.waitForIdle();
  assert.deepEqual(f.cancels, [], 'history lacks turn 3, but explicitly shows a different open turn');
});

test('V2: delayed follow-up delivery must not replace the existing managed topic root', async (t) => {
  const threadId = 'omt-existing';
  const f = await fixture(t, { channel: {
    stream: async (chatId, input, options) => {
      await options.onReplyThreadId?.(threadId);
      await input.markdown({ setContent: async () => {} });
    },
  } });
  const topicKey = 'group:oc_chat:managed:om_root';
  await f.state.setTopic(threadId, { rootMessageId: 'om_root', chatId: 'oc_chat' });
  await f.state.setSession(topicKey, sessionId);
  await f.state.putDeferred(entry({ key: topicKey, id: `${topicKey} ${sessionId} 3`, replyToMessageId: 'om_followup' }));
  f.listeners[0].onSessionEvent({ sessionId, event: end });
  await f.bridge.waitForIdle();
  assert.deepEqual(f.state.topicRootFor(threadId), { rootMessageId: 'om_root', chatId: 'oc_chat' }, 'replying to a follow-up is not creating a new managed topic');
});
