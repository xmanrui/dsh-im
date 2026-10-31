import assert from 'node:assert/strict';
import test from 'node:test';

import { FeishuHarnessBridge } from '../../../src/channels/feishu/bridge.mjs';

const KEY = 'p2p:ou_owner';

function event(messageId, text, overrides = {}) {
  const { senderOpenId = 'ou_owner', ...messageOverrides } = overrides;
  return {
    sender: { sender_type: 'user', sender_id: { open_id: senderOpenId } },
    message: {
      message_id: messageId,
      message_type: 'text',
      chat_type: 'p2p',
      chat_id: 'oc_chat',
      content: JSON.stringify({ text }),
      ...messageOverrides,
    },
  };
}

function bridgeStatus() {
  return {
    messagesReceived: 0,
    messagesReplied: 0,
    messagesRejected: 0,
    lastMessageAt: null,
    lastReplyAt: null,
    lastRejectedAt: null,
    lastError: null,
  };
}

function fixture(t, { sessionId = 'session-1', resumeIfPaused, stepPush = false } = {}) {
  const sent = [];
  const cards = [];
  let sequence = 0;
  const sessions = new Map();
  if (sessionId) sessions.set(KEY, sessionId);
  const state = {
    hasSeen: () => false,
    markSeen: async () => {},
    sessionFor: key => sessions.get(key) ?? null,
    setSession: async (key, value) => sessions.set(key, value),
    clearSession: async key => sessions.delete(key),
    keysWatching: () => [],
    watchEntry: () => undefined,
    setMirror: async () => {},
    clearMirror: async () => {},
    mirrorEntries: () => [],
    snapshot: () => ({ sessions: Object.fromEntries(sessions) }),
  };
  const harness = {
    ensureRunning: async () => true,
    workspaceSession: () => ({
      sessionExists: async () => true,
      ask: async () => '好的，继续。',
    }),
  };
  const resumeCalls = [];
  const goalControl = resumeIfPaused === false ? null : {
    async resumeIfPaused(target) {
      resumeCalls.push(target);
      return resumeIfPaused === 'throw'
        ? Promise.reject(new Error('gateway down'))
        : { resumed: resumeIfPaused === 'report-only' ? false : true };
    },
  };
  let cardSequence = 0;
  const controller = new AbortController();
  const bridge = new FeishuHarnessBridge({
    client: {
      im: {
        v1: {
          message: {
            create: async (request) => {
              sequence += 1;
              const content = request.data.content;
              if (request.data.msg_type === 'interactive') {
                cardSequence += 1;
                cards.push(content);
                return { code: 0, data: { message_id: `om_card_${cardSequence}` } };
              }
              sent.push({ text: JSON.parse(content).text });
              return { code: 0, data: { message_id: `om_out_${sequence}` } };
            },
            reply: async (request) => {
              sequence += 1;
              if (request.data.msg_type === 'interactive') {
                cardSequence += 1;
                cards.push(request.data.content);
                return { code: 0, data: { message_id: `om_card_${cardSequence}` } };
              }
              sent.push({ text: JSON.parse(request.data.content).text });
              return { code: 0, data: { message_id: `om_out_${sequence}` } };
            },
            patch: async (request) => {
              cards.push(request.data.content);
              return { code: 0 };
            },
          },
        },
      },
    },
    channel: stepPush ? { stream: true } : {},
    harness,
    state,
    status: bridgeStatus(),
    allowedSenderOpenIds: new Set(['ou_owner']),
    stepPush,
    ...(stepPush ? { stepPushMode: 'streaming_card' } : {}),
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    goalControl,
    signal: controller.signal,
  });
  t.after(() => controller.abort());
  return { bridge, sent, cards, resumeCalls };
}

test('an inbound message resumes a parked goal before the turn starts', async (t) => {
  const { bridge, sent, resumeCalls } = fixture(t);
  await bridge.accept(event('om-1', '继续'));
  assert.deepEqual(resumeCalls, ['session-1']);
  assert.equal(sent.filter(entry => entry.text.includes('目标已恢复自动续跑')).length, 1);
});

test('a goal that is not parked costs nothing and shows nothing', async (t) => {
  const { bridge, sent, resumeCalls } = fixture(t, { resumeIfPaused: 'report-only' });
  await bridge.accept(event('om-1', '继续'));
  assert.deepEqual(resumeCalls, ['session-1']);
  assert.equal(sent.some(entry => entry.text.includes('目标已恢复自动续跑')), false);
});

test('the process card carries the resumed-goal note as its first block', async (t) => {
  const { bridge, cards, sent } = fixture(t, { stepPush: true });
  await bridge.accept(event('om-1', '继续'));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(sent.length, 0, 'card mode must not fall back to a plain text note');
  assert.equal(cards.some(json => json.includes('目标已恢复自动续跑')), true);
});

test('a conversation without a bound session never asks the goal service', async (t) => {
  const { bridge, resumeCalls } = fixture(t, { sessionId: null });
  await bridge.accept(event('om-1', '继续'));
  assert.deepEqual(resumeCalls, []);
});

test('a failing resume still answers the user message', async (t) => {
  const { bridge, sent, resumeCalls } = fixture(t, { resumeIfPaused: 'throw' });
  await bridge.accept(event('om-1', '继续'));
  assert.deepEqual(resumeCalls, ['session-1']);
  assert.equal(sent.some(entry => entry.text.includes('目标已恢复自动续跑')), false);
  assert.equal(sent.length > 0, true, 'the turn must still produce a reply');
});

test('a bridge without host goal control keeps its previous behaviour', async (t) => {
  const { bridge, sent } = fixture(t, { resumeIfPaused: false });
  await bridge.accept(event('om-1', '继续'));
  assert.equal(sent.some(entry => entry.text.includes('目标已恢复自动续跑')), false);
  assert.equal(sent.length > 0, true);
});
