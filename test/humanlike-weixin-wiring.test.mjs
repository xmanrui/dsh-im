import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HarnessClient } from '../src/channels/shared/harness-client.mjs';
import { imPersona } from '../src/channels/shared/im-persona.mjs';
import { createEphemeralMemoryStore } from '../src/channels/shared/memory-store.mjs';
import { memoryScope } from '../src/channels/shared/memory-turn.mjs';
import { WeixinHarnessBridge } from '../src/channels/weixin/weixin-bridge.mjs';

// 这一套用例钉的是三件拟人能力的接线，而不是模块内部：
// 人设、记忆、拟人节奏都必须真的经过微信桥的入站-出站链路。
const LOGGER = { info() {}, warn() {}, error() {} };

function weixinEvent(id, text, options = {}) {
  return {
    message_id: String(id),
    message_type: 1,
    from_user_id: 'actor',
    ...(options.senderName ? { sender_name: options.senderName } : {}),
    context_token: 'context-token',
    item_list: [{ type: 1, text_item: { text } }],
  };
}

function createState() {
  const seen = new Set();
  const sessions = new Map();
  return {
    seen,
    sessions,
    hasSeen: (id) => seen.has(id),
    markSeen: async (id) => { seen.add(id); },
    sessionFor: (key) => sessions.get(key) ?? null,
    setSession: async (key, id) => { sessions.set(key, id); return true; },
    clearSession: async (key) => { sessions.delete(key); return true; },
    pendingSenders: () => [],
  };
}

function stubHarness({ answer = '好的', prompts = [], calls = [] } = {}) {
  return {
    prompts,
    calls,
    currentBusyMessageMode: () => 'queue',
    ensureRunning: async () => { calls.push(['ensureRunning']); },
    createSession: async () => 'session-stub',
    renameSession: async (sessionId, title) => ({ title, seq: 0 }),
    sessionExists: async () => true,
    hasActiveTurn: async () => false,
    isSessionRunning: async () => false,
    currentWorkspace: () => null,
    ask: async (sessionId, content) => {
      prompts.push(content);
      calls.push(['ask', sessionId]);
      return answer;
    },
  };
}

function stubApi(sentTexts) {
  return {
    sendText: async ({ text }) => {
      sentTexts.push(text);
      return { messageId: 'reply-' + sentTexts.length };
    },
  };
}

function buildBridge({ harness, state, api, persona, memory, botId, humanize }) {
  return new WeixinHarnessBridge({
    api,
    baseUrl: 'https://ilinkai.weixin.qq.com',
    token: 'private-token',
    ownerUserId: 'actor',
    harness,
    state,
    logger: LOGGER,
    ...(persona === undefined ? {} : { persona }),
    ...(memory === undefined ? {} : { memory }),
    ...(botId === undefined ? {} : { botId }),
    ...(humanize === undefined ? {} : { humanize }),
  });
}

test('人设接线：角色卡经桥与 Session 发布到 imPersona，且不混进用户消息', async () => {
  const sessionId = 'session-wiring-persona';
  imPersona.forget(sessionId);
  const prompts = [];
  let prompted = false;
  let polls = 0;
  let seq = 0;
  let promptRpcId;
  const client = new HarnessClient({ baseUrl: 'http://127.0.0.1:3080', workspace: '/tmp/humanlike-wiring' });
  client.ensureRunning = async () => undefined;
  // The real signature is (sessionId, { onOpen, ... }); resolving onOpen is what
  // releases the ask() path, which otherwise waits out its 30s interaction guard.
  client.watchInteractions = async (_sessionId, { onOpen } = {}) => {
    onOpen?.();
  };
  client.rpc = async (method, payload, _timeoutMs, options) => {
    if (method === 'workspace.list') return { items: [], archivedSessionIds: [] };
    if (method === 'session.history') {
      if (!prompted) return { events: [] };
      polls += 1;
      if (polls > 1) return { events: [] };
      const turn = 1;
      const events = [
        { type: 'turn/start', seq: ++seq, data: { turn } },
        { type: 'user/message', seq: ++seq, data: { turn, source: { rpcId: promptRpcId } } },
        { type: 'assistant/message', seq: ++seq, data: { turn, step: 1, message: { content: [{ type: 'text', text: '好的' }] } } },
        { type: 'turn/end', seq: ++seq, data: { turn, reason: { kind: 'completed' } } },
      ];
      return { events: events.map((event) => ({ event })) };
    }
    if (method === 'session.prompt') {
      prompts.push(payload);
      promptRpcId = options.rpcId;
      prompted = true;
      polls = 0;
      return {};
    }
    if (method === 'session.list') return { items: [{ sessionId, running: false }] };
    throw new Error('unexpected rpc ' + method);
  };
  const state = createState();
  state.sessions.set('p2p:actor', sessionId);
  const sentTexts = [];
  const bridge = buildBridge({
    harness: client,
    state,
    api: stubApi(sentTexts),
    persona: { get: () => ({ name: '接线肥鱼', identity: '你是接在微信链路上的角色。' }) },
  });
  try {
    await bridge.accept(weixinEvent(1, '在吗'));
    assert.equal(prompts.length, 1);
    const guidance = imPersona.get(sessionId);
    assert.ok(guidance, '角色卡必须发布到 imPersona');
    assert.ok(guidance.includes('接线肥鱼'));
    assert.equal(JSON.stringify(prompts[0].content).includes('接线肥鱼'), false, '角色卡不得混进用户 prompt');
    assert.deepEqual(sentTexts, ['好的']);
  } finally {
    imPersona.forget(sessionId);
  }
});

test('记忆接线：入站事实写进 MemoryStore，出站 prompt 前置 memory 上下文块', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-weixin-memory-'));
  const store = createEphemeralMemoryStore(root, { logger: LOGGER });
  try {
    const state = createState();
    const prompts = [];
    const sentTexts = [];
    const bridge = buildBridge({
      harness: stubHarness({ prompts }),
      state,
      api: stubApi(sentTexts),
      memory: store,
      botId: 'bot-1',
    });
    await bridge.accept(weixinEvent(1, '我喜欢手冲咖啡', { senderName: 'Ada' }));
    const scope = memoryScope({ channel: 'weixin', botId: 'bot-1', conversationKey: 'p2p:actor' });
    const facts = await store.recall({ scope, query: '手冲咖啡' });
    assert.ok(facts.length >= 1, '入站事实必须写进 MemoryStore');
    assert.ok(facts[0].object.includes('手冲咖啡'));
    assert.equal(sentTexts.length, 1);
    await bridge.accept(weixinEvent(2, '咖啡'));
    assert.equal(prompts.length, 2);
    const prompt = prompts[1];
    assert.equal(typeof prompt, 'string');
    const open = '<dsh_im_context>';
    const start = prompt.indexOf(open);
    assert.ok(start >= 0, '出站 prompt 必须前置记忆上下文块');
    const end = prompt.indexOf('</dsh_im_context>', start);
    const body = JSON.parse(prompt.slice(start + open.length, end));
    assert.equal(body.collector, 'memory');
    assert.ok(body.content.includes('手冲咖啡'));
    assert.ok(prompt.endsWith('咖啡'));
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('拟人节奏接线：humanize 开时分两条气泡，关时逐字走旧路径（负向对照）', async () => {
  const NL = String.fromCharCode(10);
  const answer = ['好热', '', '我不想出门了因为外面太阳很大', '', '晚上再说吧'].join(NL);
  const paced = [];
  const pacedBridge = buildBridge({
    harness: stubHarness({ answer }),
    state: createState(),
    api: stubApi(paced),
    humanize: true,
  });
  await pacedBridge.accept(weixinEvent(1, '在吗'));
  const plain = [];
  const plainBridge = buildBridge({
    harness: stubHarness({ answer }),
    state: createState(),
    api: stubApi(plain),
  });
  await plainBridge.accept(weixinEvent(1, '在吗'));
  assert.equal(paced.length, 2, 'humanize 开时必须分段多发');
  assert.equal(plain.length, 1, 'humanize 关时必须逐字单发');
  assert.notEqual(paced.length, plain.length);
  assert.equal(paced[0], '好热');
  assert.ok(paced[1].includes('我不想出门了因为外面太阳很大'));
  assert.ok(paced[1].includes('晚上再说吧'));
  assert.equal(plain[0], answer);
});
