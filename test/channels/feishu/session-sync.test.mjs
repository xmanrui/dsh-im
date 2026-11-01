import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeishuHarnessBridge } from '../../../src/channels/feishu/bridge.mjs';
import { StateStore } from '../../../src/channels/feishu/state-store.mjs';
import { createSessionSyncCoordinator } from '../../../plugin-src/host/session-sync-coordinator.mjs';
import { createDeliveryAdapter } from '../../../plugin-src/host/delivery-adapter.mjs';
import { DeliveryService } from '../../../plugin-src/host/delivery-service.mjs';
import { createSessionSyncTargetsFor } from '../../../plugin-src/host/session-sync-targets.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { for (let i = 0; i < 8; i++) await tick(); };
const target = { channel: 'feishu', botId: 'bot-a', targetId: 'owner' };
const other = { channel: 'telegram', botId: 'bot-b', targetId: 'owner' };
const start = (turn = 1) => ({ type: 'turn/start', seq: turn * 100, data: { turn } });
const user = (turn = 1) => ({ type: 'user/message', seq: turn * 100 + 1, surfaceOp: 'append', data: { content: [{ type: 'text', text: `question ${turn}` }] } });
const scheduled = (turn = 1) => ({ ...user(turn), data: { ...user(turn).data, source: { kind: 'schedule' } } });
const answer = (text = 'complete answer', turn = 1) => ({ type: 'assistant/message', seq: turn * 100 + 2, surfaceOp: 'append', data: { turn, step: 1, message: { content: [{ type: 'text', text }] } } });
const end = (turn = 1, kind = 'completed') => ({ type: 'turn/end', seq: turn * 100 + 3, data: { turn, reason: { kind } } });

async function fixture(t, {
  state, targets = [target], create, patch, history = [], sync = true, resolver,
  botId = 'bot-a', bridgeOptions = {}, deliveryService: customDeliveryService,
  settings = { mirrorUserInput: false, deliverModelAnswers: true },
} = {}) {
  let listener;
  const controller = new AbortController();
  const creates = [], patches = [], texts = [], warnings = [], historyCalls = [], visible = new Map(), mirrors = new Map();
  let savedHistory = history;
  state ??= {
    sessionFor: () => 'session', hasSeen: () => false, markSeen: async () => {},
    setMirror: async (key, entry) => mirrors.set(key, structuredClone(entry)),
    clearMirror: async key => mirrors.delete(key),
    mirrorEntries: () => [...mirrors],
  };
  const harness = {
    watchHarnessEvents: ({ onSessionEvent, signal }) => {
      listener = onSessionEvent;
      return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
    rpc: async (method, params) => {
      assert.equal(method, 'session.history');
      historyCalls.push(params);
      if (typeof savedHistory === 'function') return savedHistory(params);
      return { events: savedHistory, hasMore: false };
    },
    ensureRunning: async () => true, sessionExists: async () => true,
  };
  const bridge = new FeishuHarnessBridge({
    botId, harness, state, status: {}, channel: {}, signal: controller.signal,
    allowedSenderOpenIds: new Set(['ou_owner']),
    logger: { warn: (...args) => warnings.push(args), debug() {}, error() {} },
    sessionSyncTargetsFor: resolver ?? (async () => (
      targets.length > 0 ? [{ ...target, botId, openId: 'ou_owner' }] : [])),
    stepPushClock: { now: () => Date.now(), delay: async () => {} },
    client: { im: { v1: { message: {
      create: async request => {
        creates.push(structuredClone(request));
        const id = `card-${creates.length}`;
        await create?.(request);
        visible.set(id, request.data.content);
        return { code: 0, data: { message_id: id } };
      },
      patch: async request => {
        patches.push(structuredClone(request));
        const response = await patch?.(request);
        if (response?.code) return response;
        visible.set(request.path.message_id, request.data.content);
        return { code: 0 };
      },
    } } } },
    ...bridgeOptions,
  });
  // The coordinator sees the same configured targets the bridge mirrors into, so
  // both of its paths run here against the real card: the target path when this
  // bot has targets, the binding path when it has none.
  const deliveryService = customDeliveryService ?? {
    async describeConversation() {
      return targets.length > 0
        ? { channel: 'feishu', botId, conversationKey: 'oc_sync' }
        : null;
    },
    async listTargets() {
      return { targets: targets.map(item => ({ targetId: item.targetId })) };
    },
    async listSessionSyncTargets() {
      return targets;
    },
    async sendSessionSyncText(botIdArg, targetId, sessionId, text, options) {
      const channel = targets.find(item => item.botId === botIdArg && item.targetId === targetId)?.channel;
      texts.push([sessionId, text, options, `target:${channel}`]);
    },
    async deliverSessionText(sessionId, text, options) {
      texts.push([sessionId, text, options, 'binding']);
      return { sent: true };
    },
  };
  const coordinator = sync ? createSessionSyncCoordinator({
    deliveryService,
    logger: { warn: (...args) => warnings.push(args) },
    // The shipped defaults mirror nothing, so a test that expects a delivered
    // answer has to be the reader who switched it on.
    loadSettings: async () => settings,
  }) : null;
  const close = () => { controller.abort(); coordinator?.close(); };
  t.after(close);
  await flush();
  const emit = event => {
    listener({ sessionId: 'session', event });
    void coordinator?.enqueue('session', event, event.type === 'user/message' ? 'dsh' : 'other');
  };
  const drain = async () => {
    await Promise.all([bridge.waitForIdle(), coordinator?.whenIdle()]);
    await flush();
  };
  return { bridge, harness, state, mirrors, visible, creates, patches, texts, warnings, historyCalls, emit, drain, close,
    raw: event => listener({ sessionId: 'session', event }),
    history: events => { savedHistory = events; }, coordinator,
  };
}

test('mirror keeps every long code segment fenced across cards without losing indentation or Unicode', async t => {
  const f = await fixture(t);
  const rows = Array.from({ length: 400 }, (_, i) => `  ROW_${String(i + 1).padStart(4, '0')}=${'abc'.repeat(20)}中文😀`);
  f.emit(start()); f.emit(user()); await f.drain();
  f.emit(answer(`## Long code\n\n\`\`\`text\n${rows.join('\n')}\n\`\`\`\n\nEND_LONG_CODE`));
  f.emit(end()); await f.drain();
  const cards = [...f.visible.values()];
  assert.ok(cards.length > 1);
  const receivedRows = [];
  for (const card of cards) {
    assert.ok(Buffer.byteLength(card, 'utf8') < 30_000);
    for (const element of JSON.parse(card).body.elements) {
      if (element.tag !== 'markdown' || !element.content.includes('ROW_')) continue;
      const code = /```text\n([\s\S]*?)\n```/.exec(element.content);
      assert.ok(code, 'each Markdown element containing code must have its own fences');
      receivedRows.push(...code[1].split('\n').filter(line => line.includes('ROW_')));
    }
  }
  assert.deepEqual(receivedRows, rows);
  assert.match(cards.at(-1), /END_LONG_CODE/);
  assert.match(cards.at(-1), /已完成/);
  // The cards carry the answer, so the coordinator sends no second copy of it.
  assert.deepEqual(f.texts, [], 'the confirmed card is the only delivery');
});

test('mirror snapshots match the delivered expansion even if preferences change during PATCH', async t => {
  const original = { thinkingExpanded: true, toolsExpanded: false };
  const next = { thinkingExpanded: false, toolsExpanded: true };
  let switched = false;
  const panels = content => JSON.parse(content).body.elements.filter(element => element.tag === 'collapsible_panel');
  const f = await fixture(t, {
    sync: false, bridgeOptions: { stepCardPanels: original },
    patch: async request => {
      if (!switched && panels(request.data.content).length === 2) {
        switched = true;
        f.bridge.setStepCardPanels(next);
      }
    },
  });
  f.emit(start()); f.emit(user()); await f.drain();
  f.emit(answer('earlier explanation')); await f.drain();
  const tool = { type: 'tool/call', seq: 103, data: { turn: 1, name: 'bash', arguments: '{"command":"echo first"}' } };
  f.emit(tool); await f.drain();
  assert.equal(switched, true);
  let entry = [...f.mirrors.values()][0];
  assert.equal(entry.lastContent, f.visible.get(entry.cardIds.at(-1)));
  assert.deepEqual(panels(entry.lastContent).map(panel => panel.expanded), [true, false]);
  f.emit({ ...tool, seq: 104 }); await f.drain();
  entry = [...f.mirrors.values()][0];
  assert.equal(entry.lastContent, f.visible.get(entry.cardIds.at(-1)));
  assert.deepEqual(panels(entry.lastContent).map(panel => panel.expanded), [false, true]);
  f.close();
  const final = { ...answer('recovered answer'), seq: 105 };
  const ended = { ...end(), seq: 106 };
  const recovered = await fixture(t, { sync: false, state: f.state,
    bridgeOptions: { stepCardPanels: original }, history: [start(), user(), tool, final, ended] });
  await recovered.drain();
  const last = recovered.patches.at(-1).data.content;
  assert.equal(panels(last)[0].expanded, false);
  assert.match(last, /recovered answer/);
  assert.equal(f.mirrors.size, 0);
});

for (const input of [user, scheduled]) {
  for (const phase of ['create', 'final patch']) {
    test(`${input === scheduled ? 'scheduled ' : ''}mirror ${phase} failure neither blocks nor duplicates the Session text`, async t => {
      let release;
      const gate = new Promise((_resolve, reject) => { release = () => reject(new Error('provider failure')); });
      let failed = false;
      const f = await fixture(t, {
        [phase === 'create' ? 'create' : 'patch']: async () => {
          if (!failed) { failed = true; await gate; }
        },
      });
      f.emit(start()); f.emit(input());
      await flush();
      f.emit(answer());
      await flush();
      f.emit(end());
      await flush();
      // The answer waits for the card's verdict: a pending card is not proof of
      // delivery, so nothing is sent while the request hangs.
      assert.equal(f.texts.filter(r => r[1] === 'complete answer').length, 0);
      release();
      await f.drain();
      // The card did not carry the answer, so the text fallback does, once.
      assert.equal(f.texts.filter(r => r[1] === 'complete answer').length, 1);
      if (input === scheduled) assert.equal(f.texts.filter(r => r[1].startsWith('[来自 DSH]')).length, 0);
      f.emit(start(2)); f.emit(input(2)); f.emit(answer('next answer', 2)); f.emit(end(2));
      await f.drain();
      assert.ok([...f.visible.values()].some(text => text.includes('next answer')));
      assert.equal(f.texts.filter(r => r[1] === 'next answer').length, 0,
        'the second card confirmed its answer, so no text follows it');
    });
  }
}

for (const phase of ['create', 'running patch', 'final patch']) {
  for (const lateOutcome of ['success', 'failure']) {
    test(`mirror ${phase} timeout permits the next turn and ignores late ${lateOutcome}`, { timeout: 5_000 }, async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      let release, reject;
      const gate = new Promise((resolve, fail) => { release = resolve; reject = fail; });
      t.after(release);
      let held = false;
      const f = await fixture(t, {
        targets: [target, other],
        bridgeOptions: { requestTimeoutMs: 15_000 },
        [phase === 'create' ? 'create' : 'patch']: async request => {
          const final = request.data.content.includes('_已完成_');
          if (!held && (phase === 'create' || (phase === 'final patch' ? final : !final))) {
            held = true;
            await gate;
          }
        },
      });
      f.emit(start()); f.emit(user()); await flush();
      f.emit(answer()); await flush();
      f.emit(end()); await flush();
      assert.equal(held, true, 'the selected SDK request is in flight');
      f.emit(start(2)); f.emit(user(2)); f.emit(answer('next answer', 2)); f.emit(end(2));
      t.mock.timers.tick(15_000); await flush();
      assert.ok([...f.visible.values()].some(text => text.includes('next answer')),
        'a hanging request must not block the next turn');
      await f.drain();
      // The Feishu card timed out, so its answer falls back to text; the other
      // target has no card renderer and keeps its own text. One delivery each.
      assert.deepEqual(
        f.texts.filter(r => r[1] === 'complete answer').map(r => r[3]),
        ['target:feishu', 'target:telegram'],
      );
      assert.ok(f.warnings.some(args => args.some(arg => String(arg).includes('timed out'))));
      const saved = structuredClone(f.state.mirrorEntries());
      const delivered = structuredClone(f.texts);
      const requests = [f.creates.length, f.patches.length];
      if (lateOutcome === 'success') release();
      else reject(new Error('late SDK failure'));
      await flush();
      assert.deepEqual(f.state.mirrorEntries(), saved, 'late results must not resume mirror persistence');
      assert.deepEqual(f.texts, delivered, 'late results must not resend the final answer');
      assert.deepEqual([f.creates.length, f.patches.length], requests, 'late results must not resume rendering');
    });
  }
}

test('runtime abort releases a mirror sealing wait before the request deadline', { timeout: 5_000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(release);
  const f = await fixture(t, { patch: async () => gate });
  f.emit(start()); f.emit(user()); await f.drain();
  f.emit(answer()); await flush();
  f.emit(end()); await flush();
  const drained = f.drain();
  f.close();
  // The mocked deadline has not advanced: only cancellation can release it.
  await drained;
  const requests = [f.creates.length, f.patches.length];
  t.mock.timers.tick(60_000); await flush();
  assert.deepEqual([f.creates.length, f.patches.length], requests);
});

test('a scheduled turn delivers its answer once, in its card', async t => {
  const f = await fixture(t);
  for (const event of [start(), scheduled(), answer(), end()]) f.emit(event);
  await f.drain();
  assert.equal(f.creates.length, 1);
  assert.ok([...f.visible.values()].some(text => text.includes('complete answer')));
  // The confirmed card is the delivery: no second copy of the same answer.
  assert.deepEqual(f.texts, []);
});

test('a Web turn with targets delivers its answer once, in its card', async t => {
  const f = await fixture(t);
  for (const event of [start(), user(), answer(), end()]) f.emit(event);
  await f.drain();
  assert.deepEqual(f.texts, []);
  assert.ok([...f.visible.values()].some(text => text.includes('complete answer')));
});

test('a bot without targets delivers its answer once through the Session binding', async t => {
  const f = await fixture(t, { targets: [] });
  for (const event of [start(), user(), answer(), end()]) f.emit(event);
  await f.drain();
  // No target means no card either, so the binding is the only delivery.
  assert.equal(f.creates.length, 0);
  assert.deepEqual(f.texts.map(r => r.slice(0, 2)), [['session', 'complete answer']]);
  assert.equal(f.texts[0][3], 'binding');
});

for (const scenario of ['current session', 'rolled-over session', 'failed card', 'switches off']) {
  test(`a DS Bot without saved delivery targets: ${scenario}`, async t => {
    const settings = { mirrorUserInput: false, deliverModelAnswers: scenario !== 'switches off' };
    const bot = { id: 'ds-one', sessionId: 'session', parts: ['old-session'] };
    const dsBot = {
      status: async () => ({ state: 'ready', bots: [bot] }),
      resolve: async () => bot,
    };
    const workspaces = {
      has: botId => botId === 'bot-a',
      listBotIds: () => ['bot-a'],
      listDeliveryTargets: () => [],
      listSessionSyncTargets: () => [],
      listDsBotBindings: () => [{ botId: 'bot-a', conversationKey: 'p2p:ou_owner', dsBotId: bot.id }],
    };
    const stateFor = async () => ({ snapshot: () => ({ sessions: {
      'p2p:ou_owner': scenario === 'rolled-over session' ? 'old-session' : 'session',
    } }) });
    const sends = [];
    const service = new DeliveryService({ dsBot });
    service.registerAdapter(createDeliveryAdapter({
      channel: 'feishu', workspaces, dsBot, stateFor,
      coreController: { sendProactiveText: async (...args) => { sends.push(args); return { sent: true }; } },
    }));
    const resolver = createSessionSyncTargetsFor({
      channel: 'feishu', workspaces, stateForBotId: stateFor,
      deliveryService: service, loadSettings: async () => settings,
    });
    const f = await fixture(t, {
      targets: [], resolver, deliveryService: service, settings,
      create: scenario === 'failed card' ? async () => { throw new Error('provider failure'); } : undefined,
    });
    for (const event of [start(), scheduled(), answer(), end()]) f.emit(event);
    await f.drain();

    if (scenario === 'failed card') {
      assert.equal(sends.length, 1, 'a failed card receives exactly one text fallback');
      assert.equal(sends[0][2], 'complete answer');
      assert.equal(sends[0][3].format, 'plain');
    } else if (scenario === 'switches off') {
      assert.equal(f.creates.length, 0);
      assert.deepEqual(sends, []);
    } else {
      assert.equal(f.creates.length, 1);
      assert.ok([...f.visible.values()].some(text => text.includes('complete answer')));
      assert.deepEqual(sends, [], 'the confirmed DS Bot card must not be duplicated as text');
    }
  });
}

test('two rapid surfaced turns have separate cards and retain both answers', async t => {
  const f = await fixture(t, { sync: false });
  f.emit(answer('first answer', 1));
  await f.drain();
  f.emit(answer('second answer', 2));
  await f.drain();
  assert.equal(f.creates.length, 2);
  assert.ok(f.visible.get('card-1').includes('first answer'));
  assert.ok(f.visible.get('card-2').includes('second answer'));
});

test('silence checks history without finishing a live tool; true stopped boundary seals it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const tool = { type: 'tool/call', seq: 102, data: { turn: 1, name: 'bash', arguments: '{"command":"long build"}' } };
  const f = await fixture(t, { sync: false, history: [start(), tool] });
  f.emit(tool); await f.drain();
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(30000); await f.drain(); }
  assert.ok([...f.visible.values()].every(text => !text.includes('已完成')));
  f.history([start(), tool, end(1, 'aborted')]);
  t.mock.timers.tick(30000); await f.drain();
  assert.ok([...f.visible.values()].some(text => text.includes('已停止')));
  assert.equal(f.mirrors.size, 0);
});

test('restart resynchronizes every overflow chunk from the latest snapshot', async t => {
  const f = await fixture(t, { sync: false });
  f.emit(start()); f.emit(user()); await f.drain();
  f.emit(answer('prefix '.repeat(5000) + 'last answer')); await f.drain();
  const [key, entry] = [...f.mirrors][0];
  assert.ok(entry.cardIds.length >= 2);
  assert.ok(entry.lastContent.includes('last answer'));
  f.close();
  const recovered = await fixture(t, { sync: false, state: f.state, history: [start(), answer('prefix '.repeat(5000) + 'last answer'), end()] });
  await recovered.drain();
  assert.deepEqual(recovered.patches.map(patch => patch.path.message_id), entry.cardIds);
  assert.ok(recovered.patches.at(-1).data.content.includes('last answer'));
  const delivered = recovered.patches.map(patch => patch.data.content).join('\n');
  const bodyText = content => JSON.parse(content).body.elements
    .filter(element => element.tag === 'markdown' && !/^_(运行中|已完成)_$/.test(element.content))
    .map(element => element.content).join('\n');
  assert.deepEqual(recovered.patches.map(patch => bodyText(patch.data.content)),
    entry.cardIds.map(id => bodyText(f.visible.get(id))));
  assert.equal(delivered.split('last answer').length - 1, 1);
  assert.equal(f.mirrors.has(key), false);
});

test('ordinary PATCH persists latest content; failed recovery retains snapshot for retry', async t => {
  const f = await fixture(t, { sync: false });
  f.emit(start()); f.emit(user()); await f.drain();
  f.emit(answer('latest final answer')); await f.drain();
  const [key, entry] = [...f.mirrors][0];
  assert.ok(entry.lastContent.includes('latest final answer'));
  f.close();
  const recovered = await fixture(t, { sync: false, state: f.state, history: [start(), answer('latest final answer'), end()], patch: async () => { throw new Error('offline'); } });
  await recovered.drain();
  assert.equal(f.mirrors.has(key), true);
  assert.equal(f.mirrors.get(key).lastContent, entry.lastContent);
});

test('recovery uses the durable final answer when it is newer than the last card snapshot', async t => {
  const f = await fixture(t, { sync: false });
  f.emit(start()); f.emit(user()); await f.drain();
  f.emit(answer('partial answer')); await f.drain();
  const entry = [...f.mirrors.values()][0];
  f.close();
  const recovered = await fixture(t, { sync: false, state: f.state,
    history: [start(), user(), answer('complete recovered answer'), end()] });
  await recovered.drain();
  assert.equal(recovered.creates.length, 0);
  assert.equal(recovered.patches.at(-1).path.message_id, entry.cardIds.at(-1));
  assert.ok(recovered.patches.at(-1).data.content.includes('complete recovered answer'));
  assert.equal(f.mirrors.size, 0);
});

test('a running turn resumes its existing card after restart and retains earlier assistant steps', async t => {
  const tool = { type: 'tool/call', seq: 103, data: { turn: 1, name: 'bash', arguments: '{"command":"long build"}' } };
  const initial = [start(), user(), answer('earlier explanation'), tool];
  const f = await fixture(t, { sync: false });
  for (const event of initial) f.emit(event);
  await f.drain();
  const entry = [...f.mirrors.values()][0];
  f.close();
  const recovered = await fixture(t, { sync: false, state: f.state, history: initial });
  await recovered.drain();
  assert.equal(recovered.patches.length, 0, 'do not finish the still running turn');
  const final = { ...answer('final answer'), seq: 104, data: { ...answer('final answer').data, step: 2 } };
  const ended = { ...end(), seq: 105 };
  recovered.history([...initial, final, ended]);
  recovered.emit(final); recovered.emit(ended); await recovered.drain();
  assert.equal(recovered.creates.length, 0);
  assert.equal(recovered.patches.at(-1).path.message_id, entry.cardIds.at(-1));
  assert.ok(recovered.patches.at(-1).data.content.includes('earlier explanation'));
  assert.ok(recovered.patches.at(-1).data.content.includes('final answer'));
  assert.equal(f.mirrors.size, 0);
});

test('a resumed mirror retries from its snapshot when final card delivery fails', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const initial = [start(), user()];
  const f = await fixture(t, { sync: false });
  for (const event of initial) f.emit(event);
  await f.drain(); f.close();
  let offline = true;
  const recovered = await fixture(t, { sync: false, state: f.state, history: initial,
    patch: async () => { if (offline) throw new Error('offline'); } });
  await recovered.drain();
  recovered.history([...initial, answer(), end()]);
  recovered.emit(answer()); recovered.emit(end()); await recovered.drain();
  assert.equal(f.mirrors.size, 1);
  offline = false;
  t.mock.timers.tick(30000); await recovered.drain();
  assert.equal(f.mirrors.size, 0);
  assert.ok([...recovered.visible.values()].some(content => content.includes('complete answer')));
});

test('default IM reply captures ownership before queued events and never mirrors', async t => {
  const f = await fixture(t);
  f.harness.ask = async () => {
    for (const event of [start(), user(), answer(), end()]) f.raw(event);
    return 'ordinary IM answer';
  };
  await f.bridge.accept({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
    message: { message_id: 'im-one', message_type: 'text', chat_type: 'p2p', chat_id: 'oc_im', content: JSON.stringify({ text: 'question' }) } });
  await f.drain();
  assert.equal(f.creates.filter(r => r.data.msg_type === 'interactive').length, 0);
  assert.ok(f.creates.some(r => r.data.content.includes('ordinary IM answer')));
});

test('aborting runtime cancels mirror history timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t, { sync: false });
  f.emit(answer()); await f.drain();
  const before = f.patches.length;
  f.close();
  t.mock.timers.tick(120000); await flush();
  assert.equal(f.patches.length, before);
});

const MIRROR_TTL = 14 * 24 * 60 * 60_000;
const expiredMessage = 'Message has expired when updating message, ext=Message can only be updated within fourteen days.';
const completedHistory = [start(), user(), answer(), end()];

async function savedMirror(t, changes = {}) {
  const f = await fixture(t, { sync: false });
  f.emit(start()); f.emit(user()); await f.drain();
  f.close();
  const [key, saved] = [...f.mirrors][0];
  const entry = { ...saved, ...changes };
  await f.state.setMirror(key, entry);
  return { ...f, key, entry };
}

for (const age of [MIRROR_TTL, 27 * 24 * 60 * 60_000]) {
  test(`orphan snapshot aged ${age} is cleared before history or provider requests`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
    const saved = await savedMirror(t, { claimedAt: Date.now() - age });
    const f = await fixture(t, { sync: false, state: saved.state, history: completedHistory });
    await f.drain();
    assert.deepEqual(saved.state.mirrorEntries(), []);
    assert.equal(f.historyCalls.length, 0);
    assert.equal(f.patches.length, 0);
    t.mock.timers.tick(90_000); await f.drain();
    assert.equal(f.patches.length, 0);
    assert.equal(f.warnings.length, 1);
  });
}

test('orphan just inside retention still recovers on its original card', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const saved = await savedMirror(t, { claimedAt: Date.now() - MIRROR_TTL + 1 });
  const f = await fixture(t, { sync: false, state: saved.state, history: completedHistory });
  await f.drain();
  assert.equal(f.patches.length, 1);
  assert.equal(f.patches[0].path.message_id, saved.entry.cardIds[0]);
  assert.deepEqual(saved.state.mirrorEntries(), []);
});

for (const legacy of [false, true]) {
  for (const shape of ['sdk', 'message', 'business']) {
    test(`expired ${legacy ? 'legacy' : 'block'} mirror stops after one ${shape} error`, async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const saved = await savedMirror(t, legacy ? { blocks: undefined } : {});
      const f = await fixture(t, { sync: false, state: saved.state, history: completedHistory,
        patch: async () => {
          if (shape === 'business') return { code: 1, msg: expiredMessage };
          if (shape === 'message') throw new Error(expiredMessage.toUpperCase());
          throw Object.assign(new Error('Request failed with status code 400'), {
            response: { status: 400, data: { msg: expiredMessage } },
          });
        },
      });
      await f.drain();
      assert.deepEqual(saved.state.mirrorEntries(), []);
      assert.equal(f.patches.length, 1);
      t.mock.timers.tick(90_000); await f.drain();
      assert.equal(f.patches.length, 1);
      assert.ok(JSON.stringify(f.warnings).toLowerCase().includes('expired'));
      f.close();
      const restarted = await fixture(t, { sync: false, state: saved.state, history: completedHistory });
      assert.equal(restarted.patches.length, 0);
    });
  }
}

for (const phase of ['running', 'finish']) {
  test(`expired card at ${phase} keeps text fallback and retires the snapshot`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = await fixture(t, { patch: async request => {
      if (phase === 'running' || request.data.content.includes('_已完成_')) {
        throw Object.assign(new Error('HTTP 400'), { response: { data: { msg: expiredMessage } } });
      }
    } });
    f.emit(start()); f.emit(user()); await f.drain();
    f.emit(answer()); await f.drain();
    f.emit(end()); await f.drain();
    assert.equal(f.texts.filter(row => row[1] === 'complete answer').length, 1);
    assert.equal(f.mirrors.size, 0);
    const count = f.patches.length;
    t.mock.timers.tick(90_000); await f.drain();
    assert.equal(f.patches.length, count);
  });
}

test('recovery failure budget survives file reload and expires on the twentieth failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = await savedMirror(t);
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const state = await new StateStore(path).load();
  await state.setMirror(saved.key, saved.entry);
  const options = { sync: false, history: completedHistory, patch: async () => {
    throw Object.assign(new Error('Request failed with status code 400'), {
      response: { data: { msg: 'Unrelated temporary provider failure' } },
    });
  } };
  const first = await fixture(t, { ...options, state });
  await first.drain();
  for (let i = 1; i < 18; i++) { t.mock.timers.tick(30_000); await first.drain(); }
  assert.equal(first.patches.length, 18);
  assert.equal(state.mirrorEntries()[0][1].recoveryFailures, 18);
  assert.equal(state.mirrorEntries()[0][1].claimedAt, saved.entry.claimedAt);
  assert.equal(state.mirrorEntries()[0][1].lastContent, saved.entry.lastContent);
  first.close();
  const reloaded = await new StateStore(path).load();
  const second = await fixture(t, { ...options, state: reloaded });
  await second.drain();
  assert.equal(reloaded.mirrorEntries()[0][1].recoveryFailures, 19);
  t.mock.timers.tick(30_000); await second.drain();
  assert.equal(second.patches.length, 2);
  assert.deepEqual(reloaded.mirrorEntries(), []);
  t.mock.timers.tick(90_000); await second.drain();
  assert.equal(second.patches.length, 2);
  assert.deepEqual((await new StateStore(path).load()).mirrorEntries(), []);
});

test('each failed orphan retries only itself and deleted entries never reappear', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = await savedMirror(t);
  const secondKey = saved.key.slice(0, -1) + '2';
  await saved.state.setMirror(secondKey, { ...saved.entry, turn: 2, cardIds: ['card-two'] });
  const f = await fixture(t, { sync: false, state: saved.state,
    history: [...completedHistory, start(2), user(2), answer('second', 2), end(2)],
    patch: async () => { throw new Error('offline'); },
  });
  await f.drain();
  assert.equal(f.patches.length, 2);
  t.mock.timers.tick(30_000); await f.drain();
  assert.equal(f.patches.length, 4);
  await saved.state.clearMirror(secondKey);
  t.mock.timers.tick(30_000); await f.drain();
  assert.equal(f.patches.length, 5);
  assert.deepEqual(saved.state.mirrorEntries().map(([key]) => key), [saved.key]);
});

for (const claimedAt of [undefined, null, 'invalid', -1, 1_900_000_000_000]) {
  test(`legacy timestamp ${claimedAt} receives one finite retention window`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
    const saved = await savedMirror(t, { claimedAt });
    const f = await fixture(t, { sync: false, state: saved.state, history: [start(), user()] });
    await f.drain();
    const normalized = saved.state.mirrorEntries()[0][1].claimedAt;
    assert.equal(normalized, Date.now());
    t.mock.timers.tick(30_000); await f.drain();
    assert.equal(saved.state.mirrorEntries()[0][1].claimedAt, normalized);
    assert.equal(saved.state.mirrorEntries()[0][1].recoveryFailures, undefined);
    assert.equal(f.patches.length, 0);
    t.mock.timers.tick(MIRROR_TTL); await f.drain();
    assert.deepEqual(saved.state.mirrorEntries(), []);
    assert.equal(f.patches.length, 0);
  });
}

test('history errors use the failure budget; incomplete history does not finish or reset it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const saved = await savedMirror(t);
  const f = await fixture(t, { sync: false, state: saved.state, history: () => { throw new Error('history offline'); } });
  await f.drain();
  assert.equal(saved.state.mirrorEntries()[0][1].recoveryFailures, 1);
  // A history page that never reaches the requested turn is insufficient.
  f.history(() => ({ events: [answer('unrelated', 2)], hasMore: true }));
  t.mock.timers.tick(30_000); await f.drain();
  assert.equal(saved.state.mirrorEntries()[0][1].recoveryFailures, 1);
  assert.equal(f.patches.length, 0);
  t.mock.timers.tick(MIRROR_TTL); await f.drain();
  assert.deepEqual(saved.state.mirrorEntries(), []);
});

test('an exhausted recovery record is cleared before making another request on restart', async t => {
  const saved = await savedMirror(t, { recoveryFailures: 20 });
  const f = await fixture(t, { sync: false, state: saved.state, history: completedHistory });
  await f.drain();
  assert.deepEqual(saved.state.mirrorEntries(), []);
  assert.equal(f.historyCalls.length, 0);
  assert.equal(f.patches.length, 0);
});

test('successful orphan recovery cancels its timer and keeps the original message', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = await savedMirror(t);
  let offline = true;
  const f = await fixture(t, { sync: false, state: saved.state, history: completedHistory,
    patch: async () => { if (offline) throw new Error('offline'); },
  });
  await f.drain();
  assert.equal(saved.state.mirrorEntries()[0][1].recoveryFailures, 1);
  offline = false;
  t.mock.timers.tick(30_000); await f.drain();
  assert.deepEqual(saved.state.mirrorEntries(), []);
  assert.equal(f.creates.length, 0);
  assert.ok(f.visible.get(saved.entry.cardIds[0]).includes('complete answer'));
  const calls = f.historyCalls.length;
  t.mock.timers.tick(90_000); await f.drain();
  assert.equal(f.historyCalls.length, calls);
});

test('a pending orphan patch cancelled by runtime stop neither increments nor retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = await savedMirror(t);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  t.after(release);
  const f = await fixture(t, { sync: false, state: saved.state, history: completedHistory, patch: () => pending });
  assert.equal(f.patches.length, 1);
  f.close(); await f.drain();
  assert.deepEqual(saved.state.mirrorEntries(), [[saved.key, saved.entry]]);
  release(); await flush();
  t.mock.timers.tick(90_000); await f.drain();
  assert.equal(f.patches.length, 1);
  assert.deepEqual(saved.state.mirrorEntries(), [[saved.key, saved.entry]]);
});

test('a queued orphan timer rereads state after another session task deletes its entry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = await savedMirror(t);
  const secondKey = saved.key.slice(0, -1) + '2';
  await saved.state.setMirror(secondKey, { ...saved.entry, turn: 2, cardIds: ['card-two'] });
  const history = [...completedHistory, start(2), user(2), answer('second', 2), end(2)];
  const f = await fixture(t, { sync: false, state: saved.state, history,
    patch: async () => { throw new Error('offline'); },
  });
  await f.drain();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  t.after(() => release({ events: history, hasMore: false }));
  f.history(() => pending);
  t.mock.timers.tick(30_000); await flush();
  await saved.state.clearMirror(secondKey);
  release({ events: history, hasMore: false }); await f.drain();
  assert.equal(f.patches.length, 3, 'only the first timer may patch after the queued second entry was deleted');
  assert.deepEqual(saved.state.mirrorEntries().map(([key]) => key), [saved.key]);
});

test('overflow recovery stops at the first expired chunk', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = await savedMirror(t, { cardIds: ['old-first', 'old-second'] });
  const f = await fixture(t, { sync: false, state: saved.state, history: completedHistory,
    patch: async () => { throw new Error(expiredMessage); },
  });
  await f.drain();
  assert.deepEqual(f.patches.map(request => request.path.message_id), ['old-first']);
  assert.deepEqual(saved.state.mirrorEntries(), []);
  t.mock.timers.tick(60_000); await f.drain();
  assert.equal(f.patches.length, 1);
});
