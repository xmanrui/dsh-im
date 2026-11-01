import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessClient as RealHarnessClient, HarnessRpcError } from '../src/channels/shared/harness-client.mjs';
import { BotWorkspaceStore, createBotWorkspaceScope } from '../src/channels/shared/bot-workspace-store.mjs';
import { ConversationStateStore } from '../src/channels/shared/conversation-state-store.mjs';
import { askInWorkspaceSession } from '../src/channels/shared/workspace-session.mjs';
import { createDeliveryAdapter } from '../plugin-src/host/delivery-adapter.mjs';
import { DeliveryService } from '../plugin-src/host/delivery-service.mjs';
const bot = { id: 'ds-one', name: 'stepBot', sessionId: 'session-one' };

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dsbot-handoff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = 'c2c:user-one';
  const workspaces = await new BotWorkspaceStore(join(dir, 'workspaces.json'), { defaultWorkspace: dir }).load();
  await workspaces.ensure('im-one');
  await workspaces.createDeliveryTarget('im-one', {
    targetId: 'private', kind: 'user', route: { userOpenId: 'user-one' },
  });
  const state = await new ConversationStateStore(join(dir, 'state.json')).load();
  await state.setSession(key, 'old-session');
  let current = { ...bot };
  const dsBot = {
    async status() { return { state: 'ready', bots: [current] }; },
    async resolve(id) { assert.equal(id, bot.id); return current; },
  };
  const adapter = createDeliveryAdapter({
    channel: 'qq', workspaces, dsBot, stateFor: async () => state,
    coreController: { async sendProactiveText() {} },
  });
  const service = new DeliveryService({ dsBot });
  service.registerAdapter(adapter);
  return { dir, key, workspaces, state, dsBot, service, setCurrent: (value) => { current = value; } };
}

function event(seq, type, data) {
  return { event: { seq, type, data } };
}
function replyEvents(turn, rpcId, text, startSeq = 1) {
  return [
    event(startSeq, 'turn/start', { turn }),
    event(startSeq + 1, 'user/message', { turn, source: { kind: 'user', rpcId } }),
    event(startSeq + 2, 'assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text }] } }),
    event(startSeq + 3, 'turn/end', { turn, reason: 'completed' }),
  ];
}
async function handoffFixture(t, { archiveOld, unrelatedFirst = false, cancelDuringHistory = false, unclaimed = false, failedSubmit = false, freshHistory, clientOptions = {} } = {}) {
  const f = await fixture(t);
  await f.service.bindDsBot('im-one', f.key, bot.id);
  let promptRpcId;
  const controller = new AbortController();
  const oldEvents = [];
  const rpcCalls = [];
  let newReads = 0;
  const client = new RealHarnessClient({ baseUrl: 'http://127.0.0.1:3080', workspace: f.dir, ...clientOptions });
  client.rpc = async (method, payload, timeoutMs, options) => {
    rpcCalls.push({ method, payload });
    options?.signal?.throwIfAborted();
    if (method === 'host.describe') return {};
    if (method === 'workspace.list') {
      return { archivedSessionIds: archiveOld && promptRpcId ? ['session-one'] : [] };
    }
    if (method === 'session.list') return { items: [{ sessionId: 'session-two', running: false }] };
    if (method === 'session.history') {
      if (payload.sessionId === 'session-one') return { events: [...oldEvents] };
      newReads++;
      if (freshHistory) return freshHistory({ f, client, controller, payload, options, promptRpcId, read: newReads });
      assert.equal(payload.sessionId, 'session-two');
      if (cancelDuringHistory) {
        controller.abort();
        options?.signal?.throwIfAborted();
      }
      const prior = unrelatedFirst ? replyEvents(1, 'desktop-other-prompt', 'UNRELATED DESKTOP ANSWER') : [];
      if (unrelatedFirst && newReads === 1) return { events: prior };
      return { events: [...prior, ...replyEvents(2, promptRpcId, 'ANSWER TO TRANSFERRED IM MESSAGE', 10)] };
    }
    if (method === 'session.prompt') {
      assert.equal(payload.sessionId, 'session-one', 'accepted prompt must not be submitted again');
      promptRpcId = options.rpcId;
      oldEvents.push(
        event(1, 'turn/start', { turn: 7 }),
        ...(unclaimed ? [] : [event(2, 'user/message', { turn: 7, source: { rpcId: promptRpcId } })]),
        event(3, 'turn/end', { turn: 7, reason: { kind: 'blocked' } }),
      );
      f.setCurrent({ ...bot, sessionId: 'session-two', parts: ['session-one'] });
      if (failedSubmit) throw new HarnessRpcError('session.prompt', { code: 'internal' });
      return { accepted: true };
    }
    assert.fail(`Unexpected RPC: ${method}`);
  };
  const scope = createBotWorkspaceScope(client, { botId: 'im-one', workspaces: f.workspaces, state: f.state, dsBot: f.dsBot });
  return {
    f, client, scope, rpcCalls,
    ask: (askOptions = {}, deferredDelivery) => askInWorkspaceSession({ harness: scope.harness, state: scope.state, key: f.key,
      text: 'hello', deferredDelivery, askOptions: { timeoutMs: 2000, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]), ...askOptions } }),
  };
}

test('accepted archived handoff follows the carried reply with the real HarnessClient', async (t) => {
  const r = await handoffFixture(t, { archiveOld: true });
  const result = await r.ask();
  assert.equal(result.sessionId, 'session-two');
  assert.equal(result.answer, 'ANSWER TO TRANSFERRED IM MESSAGE');
  assert.equal(r.rpcCalls.filter((c) => c.method === 'session.prompt').length, 1);
});

test('transferred tracking ignores a completed desktop turn with a different rpcId', async (t) => {
  const r = await handoffFixture(t, { archiveOld: false, unrelatedFirst: true });
  const result = await r.ask();
  assert.equal(result.answer, 'ANSWER TO TRANSFERRED IM MESSAGE');
  assert.equal(r.rpcCalls.filter((c) => c.method === 'session.prompt').length, 1);
});


test('cancelling during transferred history must reject instead of returning a reply', async (t) => {
  const r = await handoffFixture(t, { archiveOld: false, cancelDuringHistory: true });
  await assert.rejects(r.ask(), { name: 'AbortError' });
});

test('control - nonarchived blocked handoff submits only once and returns its reply', async (t) => {
  const r = await handoffFixture(t, { archiveOld: false });
  const result = await r.ask();
  assert.equal(result.sessionId, 'session-two');
  assert.equal(result.answer, 'ANSWER TO TRANSFERRED IM MESSAGE');
  assert.equal(r.rpcCalls.filter((c) => c.method === 'session.prompt').length, 1);
});


test('pre-step handoff before user/message follows the accepted message after archive', async (t) => {
  const r = await handoffFixture(t, { archiveOld: true, unclaimed: true });
  assert.equal((await r.ask()).answer, 'ANSWER TO TRANSFERRED IM MESSAGE');
  assert.equal(r.rpcCalls.filter((c) => c.method === 'session.prompt').length, 1);
});

test('an archived submit with an unknown outcome must not be replayed', async (t) => {
  const r = await handoffFixture(t, { archiveOld: true, failedSubmit: true });
  await assert.rejects(r.ask(), { code: 'session-archived' });
  assert.equal(r.rpcCalls.filter((c) => c.method === 'session.prompt').length, 1);
});

test('transferred history paginates to the original prompt before selecting its result', async (t) => {
  const r = await handoffFixture(t, { archiveOld: true, freshHistory: ({ payload, promptRpcId }) => {
    const ours = replyEvents(2, promptRpcId, 'PAGINATED OWN REPLY', 10);
    if (payload.beforeSeq === undefined) return { hasMore: true, events: [
      ...ours.slice(2), ...replyEvents(3, 'another-prompt', 'UNRELATED LATER ANSWER', 20),
    ] };
    assert.equal(payload.beforeSeq, 12);
    return { hasMore: false, events: ours.slice(0, 2) };
  } });
  assert.equal((await r.ask()).answer, 'PAGINATED OWN REPLY');
});

test('timeout retains the new session and prompt identity for deferred delivery', async (t) => {
  const registrations = [];
  const r = await handoffFixture(t, { archiveOld: true, freshHistory: () => ({ events: [] }) });
  await assert.rejects(r.ask({ timeoutMs: 10 }, () => ({ coordinator: {
    async trackTimeout(error, destination) { registrations.push({ error, destination }); },
  } })), (error) => {
    assert.equal(error.code, 'harness-reply-timeout');
    assert.equal(error.details.sessionId, 'session-two');
    assert.match(error.details.promptRpcId, /^im-/);
    assert.equal(error.details.baselineSeq, -1);
    assert.equal(error.promptAccepted, true);
    return true;
  });
  assert.equal(registrations.length, 1);
  assert.equal(r.f.state.sessionFor(r.f.key), 'session-two');
});

test('unbind during transferred history neither delivers a reply nor resubmits', async (t) => {
  const r = await handoffFixture(t, { archiveOld: true, freshHistory: async ({ f, promptRpcId }) => {
    await f.service.unbindDsBot('im-one', f.key);
    return { events: replyEvents(2, promptRpcId, 'late reply') };
  } });
  await assert.rejects(r.ask(), { name: 'AbortError' });
  assert.equal(r.f.state.sessionFor(r.f.key), null);
  assert.equal(r.rpcCalls.filter((c) => c.method === 'session.prompt').length, 1);
});

test('a second rollover follows the same input identity without a second submission', async (t) => {
  const r = await handoffFixture(t, { archiveOld: true, freshHistory: ({ f, payload, promptRpcId }) => {
    if (payload.sessionId === 'session-two') {
      f.setCurrent({ ...bot, sessionId: 'session-three', parts: ['session-one', 'session-two'] });
      const error = Object.assign(new Error('archived again'), { code: 'session-archived' });
      throw error;
    }
    assert.equal(payload.sessionId, 'session-three');
    return { events: replyEvents(2, promptRpcId, 'THIRD PART REPLY') };
  } });
  const result = await r.ask();
  assert.equal(result.sessionId, 'session-three');
  assert.equal(result.answer, 'THIRD PART REPLY');
  assert.equal(r.rpcCalls.filter((c) => c.method === 'session.prompt').length, 1);
});


for (const archiveOld of [false, true]) {
  test(`handoff retains inbound files until the transferred turn finishes (archive=${archiveOld})`, async (t) => {
    let staged = 0;
    let cleaned = 0;
    const r = await handoffFixture(t, { archiveOld,
      clientOptions: { fileIngressExecutor: async () => {
        staged++;
        return { files: [{ name: 'input.txt', path: '/tmp/input.txt', size: 4 }], cleanup: async () => { cleaned++; } };
      } },
      freshHistory: ({ promptRpcId }) => {
        assert.equal(cleaned, 0, 'the forwarded input still refers to the staged file');
        return { events: replyEvents(2, promptRpcId, 'FILE PROCESSED') };
      },
    });
    assert.equal((await r.ask({ files: [{ name: 'input.txt', data: Buffer.from('data') }] })).answer, 'FILE PROCESSED');
    assert.equal(staged, 1);
    assert.equal(cleaned, 1);
  });
}

test('the transferred watcher preserves progress updates and does not claim another prompt', async (t) => {
  const updates = [];
  const r = await handoffFixture(t, { archiveOld: true, unrelatedFirst: true });
  await r.ask({ onUpdate: (value) => updates.push(value) });
  assert.ok(updates.some((update) => update.text === 'ANSWER TO TRANSFERRED IM MESSAGE'));
  assert.ok(updates.every((update) => !String(update.text).includes('UNRELATED')));
});
