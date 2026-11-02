import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuHarnessBridge } from '../../../src/channels/feishu/bridge.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { for (let i = 0; i < 8; i++) await tick(); };

const TOPIC = 'group:chat-1:thread:thread-1';
const DM = 'p2p:ou_owner';
const SESSION = 'session';
const OTHER_SESSION = 'session-2';

// A real goal round's user/message carries no `data.turn`; only the
// turn/start right before it does.
const goal = (round = 1, seq = 100) => ({
  type: 'user/message',
  seq,
  surfaceOp: 'append',
  data: {
    source: { kind: 'goal', goalId: 'goal-1', revision: 1, round },
    content: [{
      type: 'text',
      text: `<goal_round>\nObjective: "keep building the service"\nRound: ${round}/256\n\nContinue working toward the objective.`,
    }],
  },
});
const start = (turn = 4, seq = 99) => ({ type: 'turn/start', seq, data: { turn } });
const tool = (turn = 4, seq = 102) => ({
  type: 'tool/call', seq, data: { turn, name: 'bash', arguments: '{"command":"ls"}' },
});
const answer = (text, turn = 4, seq = 103) => ({
  type: 'assistant/message',
  seq,
  surfaceOp: 'append',
  data: { turn, step: 1, message: { content: [{ type: 'text', text }] } },
});
const end = (turn = 4, seq = 104, kind = 'completed') => ({
  type: 'turn/end', seq, data: { turn, reason: { kind } },
});

async function fixture(t, {
  resolver = async () => [],
  keys = [[TOPIC, 'chat-1', 'om-topic-1']],
} = {}) {
  let listener;
  const controller = new AbortController();
  const creates = [];
  const replies = [];
  const patches = [];
  const visible = new Map();
  const bindings = new Map(keys.map(([key, , , sessionId]) => [key, sessionId ?? SESSION]));
  const state = {
    sessionFor: key => bindings.get(key),
    hasSeen: () => false,
    markSeen: async () => {},
    keysWatching: () => [],
    watchEntry: () => undefined,
    setMirror: async () => {},
    clearMirror: async () => {},
    mirrorEntries: () => [],
  };
  const harness = {
    watchHarnessEvents: ({ onSessionEvent, signal }) => {
      listener = onSessionEvent;
      return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
    rpc: async () => ({ events: [], hasMore: false }),
    ensureRunning: async () => true,
    sessionExists: async () => true,
  };
  const bridge = new FeishuHarnessBridge({
    botId: 'bot-a',
    harness,
    state,
    status: {},
    channel: {},
    signal: controller.signal,
    allowedSenderOpenIds: new Set(['ou_owner']),
    logger: { warn() {}, debug() {}, error() {} },
    sessionSyncTargetsFor: resolver,
    stepPushClock: { now: () => Date.now(), delay: async () => {} },
    client: {
      im: {
        v1: {
          message: {
            create: async request => {
              creates.push(structuredClone(request));
              const id = `card-${creates.length}`;
              visible.set(id, request.data.content);
              return { code: 0, data: { message_id: id } };
            },
            patch: async request => {
              patches.push(structuredClone(request));
              visible.set(request.path.message_id, request.data.content);
              return { code: 0 };
            },
            reply: async request => {
              replies.push(structuredClone(request));
              const id = `reply-${replies.length}`;
              visible.set(id, request.data.content);
              return { code: 0, data: { message_id: id } };
            },
          },
        },
      },
    },
  });
  t.after(() => controller.abort());
  await flush();
  for (const [key, chatId, replyToMessageId] of keys) {
    bridge.rememberConversationRoute(key, { chatId, replyToMessageId });
  }
  const emit = (event, sessionId = SESSION) => listener({ sessionId, event });
  const drain = async () => {
    await bridge.waitForIdle();
    await flush();
  };
  const cardFor = id => visible.get(id) ?? '';
  return {
    bridge, emit, drain, creates, replies, patches, visible, cardFor,
    bind: (key, sessionId) => bindings.set(key, sessionId),
  };
}

const syncedTarget = { channel: 'feishu', botId: 'bot-a', openId: 'ou_owner', targetId: 'owner' };

test('a goal round opened outside the IM shows its progress and result in the bound conversation', async t => {
  const f = await fixture(t);

  f.emit(start(4, 99));
  f.emit(goal(1, 100));
  await f.drain();

  assert.equal(f.replies.length, 1, 'the round opens a card in the conversation');
  const opening = f.replies[0];
  assert.equal(opening.path.message_id, 'om-topic-1', 'the card replies to the conversation anchor');
  assert.match(opening.data.content, /目标自动续跑（第 1 轮）/);
  assert.doesNotMatch(opening.data.content, /goal_round/);
  assert.doesNotMatch(opening.data.content, /Objective:/);

  f.emit(tool());
  await f.drain();
  f.emit(answer('本轮完成：PvE 战斗改为逐回合结算。'));
  await f.drain();
  f.emit(end());
  await f.drain();

  const card = f.cardFor('reply-1');
  assert.match(card, /bash/);
  assert.match(card, /目标自动续跑（第 1 轮）/);
  assert.match(card, /PvE 战斗改为逐回合结算/);
  assert.match(card, /已完成/);
  assert.doesNotMatch(card, /goal_round/);
});

test('each continuation round starts a new card and delivers its own result', async t => {
  const f = await fixture(t);

  f.emit(start(4, 99));
  f.emit(goal(1, 100));
  await f.drain();
  f.emit(answer('第一轮结果', 4));
  await f.drain();
  f.emit(end(4));
  await f.drain();

  f.emit(start(5, 200));
  f.emit(goal(2, 205));
  await f.drain();
  f.emit(answer('第二轮结果', 5));
  await f.drain();
  f.emit(end(5, 208));
  await f.drain();

  assert.equal(f.replies.length, 2);
  assert.match(f.replies[0].data.content, /第 1 轮/);
  assert.match(f.replies[1].data.content, /第 2 轮/);
  assert.match(f.cardFor('reply-2'), /第二轮结果/);
});

test('a lost turn/end does not block the next round and closes the stale card', async t => {
  const f = await fixture(t);

  f.emit(start(4, 99));
  f.emit(goal(1, 100));
  await f.drain();
  f.emit(tool(4));
  await f.drain();
  f.emit(answer('第一轮结果', 4));
  await f.drain();
  // The connection drops here: turn/end for turn 4 never arrives.

  f.emit(start(5, 200));
  f.emit(goal(2, 205));
  await f.drain();
  f.emit(answer('第二轮结果', 5));
  await f.drain();
  f.emit(end(5, 208));
  await f.drain();

  assert.equal(f.replies.length, 2, 'the next round gets its own card');
  assert.match(f.replies[1].data.content, /第 2 轮/);
  assert.match(f.cardFor('reply-1'), /已完成/, 'the orphaned round is sealed, not left open');
  assert.match(f.cardFor('reply-2'), /第二轮结果/);
});

test('a synced DM does not suppress the group topic bound to the same session', async t => {
  const f = await fixture(t, { resolver: async () => [syncedTarget] });

  f.emit(start(4, 99));
  f.emit(goal(1, 100));
  await f.drain();

  assert.equal(f.replies.length, 1, 'the topic still gets its own card');
  assert.equal(f.creates.length, 1, 'the synced DM still gets its mirror card');
  assert.equal(f.creates[0].params?.receive_id_type, 'open_id');
  assert.match(f.replies[0].data.content, /目标自动续跑（第 1 轮）/);
});

test('the synced DM itself is not rendered twice', async t => {
  const f = await fixture(t, {
    resolver: async () => [syncedTarget],
    keys: [[DM, 'ou_owner', 'om-dm-1']],
  });

  f.emit(start(4, 99));
  f.emit(goal(1, 100));
  await f.drain();

  assert.equal(f.replies.length, 0, 'the mirror owns the direct chat');
  assert.equal(f.creates.length, 1, 'only the mirror card exists');
  assert.match(f.creates[0].data.content, /目标自动续跑（第 1 轮）/);
  assert.doesNotMatch(f.creates[0].data.content, /goal_round/);
});

test('rebinding the conversation stops the old round from writing into it', async t => {
  const f = await fixture(t);

  f.emit(start(4, 99));
  f.emit(goal(1, 100));
  await f.drain();
  f.emit(answer('旧会话半截答案', 4));
  await f.drain();

  f.bind(TOPIC, OTHER_SESSION);
  f.emit(answer('旧会话不该出现的结论', 4, 105));
  await f.drain();
  f.emit(end(4, 106));
  await f.drain();

  const card = f.cardFor('reply-1');
  assert.doesNotMatch(card, /旧会话不该出现的结论/);
  assert.match(card, /已完成/, 'the round is closed instead of staying open');
});

const OTHER_TOPIC = 'group:chat-2:thread:thread-2';

test('a goal in one bound conversation does not seal another session\'s running card', async t => {
  const f = await fixture(t, {
    keys: [
      [TOPIC, 'chat-1', 'om-topic-1', SESSION],
      [OTHER_TOPIC, 'chat-2', 'om-topic-2', OTHER_SESSION],
    ],
  });

  f.emit(start(4, 99));
  f.emit(goal(1, 100));
  await f.drain();
  f.emit(tool(4, 102));
  await f.drain();

  // Session B starts its own goal while A is still running.
  f.emit(start(4, 299), OTHER_SESSION);
  f.emit(goal(1, 300), OTHER_SESSION);
  await f.drain();

  assert.equal(f.replies.length, 2, 'both conversations open their own card');
  assert.equal(f.replies[0].path.message_id, 'om-topic-1');
  assert.equal(f.replies[1].path.message_id, 'om-topic-2');
  assert.match(f.cardFor('reply-1'), /bash/);
  assert.doesNotMatch(f.cardFor('reply-1'), /已完成/, 'A must stay open while its turn runs');

  f.emit(answer('会话 A 的最终结论', 4, 104));
  await f.drain();
  f.emit(end(4, 105));
  await f.drain();

  assert.match(f.cardFor('reply-1'), /bash/);
  assert.match(f.cardFor('reply-1'), /会话 A 的最终结论/);
  assert.match(f.cardFor('reply-1'), /已完成/);

  f.emit(answer('会话 B 的最终结论', 4, 303), OTHER_SESSION);
  await f.drain();
  f.emit(end(4, 304), OTHER_SESSION);
  await f.drain();

  assert.match(f.cardFor('reply-2'), /会话 B 的最终结论/);
  assert.match(f.cardFor('reply-2'), /已完成/);
  assert.match(f.cardFor('reply-1'), /会话 A 的最终结论/, 'A keeps its result');
});

test('a goal in a session with no Feishu conversation leaves bound cards alone', async t => {
  const f = await fixture(t);

  f.emit(start(4, 99));
  f.emit(goal(1, 100));
  await f.drain();
  f.emit(tool(4, 102));
  await f.drain();

  // A plain `dsh web` session starts a goal; it has no conversation here.
  f.emit(start(9, 499), 'web-only-session');
  f.emit(goal(1, 500), 'web-only-session');
  await f.drain();

  assert.equal(f.replies.length, 1, 'the unbound session opens nothing');
  assert.doesNotMatch(f.cardFor('reply-1'), /已完成/);

  f.emit(answer('飞书会话的结果', 4, 104));
  await f.drain();
  f.emit(end(4, 105));
  await f.drain();

  assert.match(f.cardFor('reply-1'), /bash/);
  assert.match(f.cardFor('reply-1'), /飞书会话的结果/);
  assert.match(f.cardFor('reply-1'), /已完成/);
});
