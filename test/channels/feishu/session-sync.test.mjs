import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuHarnessBridge } from '../../../src/channels/feishu/bridge.mjs';
import { createSessionSyncCoordinator } from '../../../plugin-src/host/session-sync-coordinator.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { for (let i = 0; i < 8; i++) await tick(); };
const target = { channel: 'feishu', botId: 'bot-a', targetId: 'owner' };
const other = { channel: 'telegram', botId: 'bot-b', targetId: 'owner' };
const start = (turn = 1) => ({ type: 'turn/start', seq: turn * 100, data: { turn } });
const user = (turn = 1) => ({ type: 'user/message', seq: turn * 100 + 1, surfaceOp: 'append', data: { content: [{ type: 'text', text: `question ${turn}` }] } });
const scheduled = (turn = 1) => ({ ...user(turn), data: { ...user(turn).data, source: { kind: 'schedule' } } });
const answer = (text = 'complete answer', turn = 1) => ({ type: 'assistant/message', seq: turn * 100 + 2, surfaceOp: 'append', data: { turn, step: 1, message: { content: [{ type: 'text', text }] } } });
const end = (turn = 1, kind = 'completed') => ({ type: 'turn/end', seq: turn * 100 + 3, data: { turn, reason: { kind } } });

async function fixture(t, { state, targets = [target], create, patch, history = [], sync = true, resolver, botId = 'bot-a', bridgeOptions = {} } = {}) {
  let listener;
  const controller = new AbortController();
  const creates = [], patches = [], texts = [], warnings = [], visible = new Map(), mirrors = new Map();
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
    rpc: async (method) => {
      assert.equal(method, 'session.history');
      return { events: savedHistory, hasMore: false };
    },
    ensureRunning: async () => true, sessionExists: async () => true,
  };
  const bridge = new FeishuHarnessBridge({
    botId, harness, state, status: {}, channel: {}, signal: controller.signal,
    allowedSenderOpenIds: new Set(['ou_owner']),
    logger: { warn: (...args) => warnings.push(args), debug() {}, error() {} },
    sessionSyncTargetsFor: resolver ?? (async () => [{ ...target, botId, openId: 'ou_owner' }]),
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
        await patch?.(request);
        visible.set(request.path.message_id, request.data.content);
        return { code: 0 };
      },
    } } } },
    ...bridgeOptions,
  });
  const coordinator = sync ? createSessionSyncCoordinator({ deliveryService: {
    listSessionSyncTargets: async () => targets,
    sendSessionSyncText: async (...args) => texts.push(args),
  }, logger: { warn: (...args) => warnings.push(args) } }) : null;
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
  return { bridge, harness, state, mirrors, visible, creates, patches, texts, warnings, emit, drain, close,
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
  assert.equal(f.texts.filter(args => args[3].startsWith('[DSH 助手]')).length, 0);
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
    test(`${input === scheduled ? 'scheduled ' : ''}mirror ${phase} failure preserves final text fallback and permits next turn`, async t => {
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
      assert.equal(f.texts.filter(r => r[3].startsWith('[DSH 助手]')).length, 0, 'wait for real card outcome');
      release();
      await f.drain();
      assert.equal(f.texts.filter(r => r[3] === '[DSH 助手]\n\ncomplete answer').length, 1);
      if (input === scheduled) assert.equal(f.texts.filter(r => r[3].startsWith('[来自 DSH]')).length, 0);
      f.emit(start(2)); f.emit(input(2)); f.emit(answer('next answer', 2)); f.emit(end(2));
      await f.drain();
      assert.ok([...f.visible.values()].some(text => text.includes('next answer')));
      assert.equal(f.texts.filter(r => r[3].includes('[DSH 助手]\n\nnext answer')).length, 0);
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
      assert.equal(f.texts.filter(r => r[0] === 'bot-a' && r[3] === '[DSH 助手]\n\ncomplete answer').length, 1);
      assert.ok(f.texts.some(r => r[0] === 'bot-b' && r[3] === '[DSH 助手]\n\ncomplete answer'));
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

test('scheduled sync accepts the existing card receipt without duplicate text', async t => {
  const f = await fixture(t);
  for (const event of [start(), scheduled(), answer(), end()]) f.emit(event);
  await f.drain();
  assert.equal(f.creates.length, 1);
  assert.ok([...f.visible.values()].some(text => text.includes('complete answer')));
  assert.deepEqual(f.texts, []);
});

test('same target id on another channel/bot still receives its answer', async t => {
  const f = await fixture(t, { targets: [target, other, { ...target, botId: 'bot-c' }, { ...target, targetId: 'second' }] });
  for (const event of [start(), user(), answer(), end()]) f.emit(event);
  await f.drain();
  assert.deepEqual(f.texts.filter(r => r[3].startsWith('[DSH 助手]')).map(r => r.slice(0, 2)),
    [['bot-b', 'owner'], ['bot-c', 'owner'], ['bot-a', 'second']]);
});

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
