import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationStateStore } from '../src/channels/shared/conversation-state-store.mjs';
import { QqStateStore } from '../src/channels/qq/state-store.mjs';
import { TelegramHarnessBridge } from '../src/channels/telegram/telegram-bridge.mjs';
import { QqHarnessBridge } from '../src/channels/qq/qq-bridge.mjs';

const logger = { info() {}, warn() {}, error() {} };

const channels = {
  telegram: {
    Store: ConversationStateStore,
    create: ({ harness, state, send }) => new TelegramHarnessBridge({
      harness, state, logger,
      bot: {
        sendText: async (target, text) => {
          send(target, text);
          return { messageId: 'out' };
        },
      },
    }),
    message: (id, text) => ({
      messageId: id, content: text, senderId: 'owner', senderIsBot: false,
      kind: 'direct', conversationId: 'chat', addressed: true, plainText: true,
      replyTarget: { chatId: 'chat' },
    }),
  },
  qq: {
    Store: QqStateStore,
    create: ({ harness, state, send }) => new QqHarnessBridge({
      harness, state, logger, ownerUserOpenid: 'owner',
      bot: {
        appId: 'app',
        sendText: async (target, text) => {
          send(target, text);
          return { messageId: 'out' };
        },
      },
    }),
    message: (id, text) => ({
      kind: 'c2c', rawEventType: 'C2C_MESSAGE_CREATE', senderId: 'owner', senderIsBot: false,
      messageId: id, content: text,
      replyTarget: { scope: 'c2c', targetId: 'owner', msgId: id },
    }),
  },
};

async function eventually(predicate, what) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** A harness whose first ask never settles; later asks answer immediately. */
function blockingHarness() {
  const asks = [];
  const active = new Set();
  const gate = new Promise(() => {});
  const session = (id) => ({
    sessionExists: async () => true,
    hasActiveTurn: async () => active.has(id),
    isRunning: async () => active.has(id),
    ask: async (text) => {
      asks.push({ id, text });
      active.add(id);
      if (asks.length === 1) await gate;
      active.delete(id);
      return 'answer';
    },
  });
  return {
    asks,
    harness: {
      ensureRunning: async () => true,
      currentWorkspace: () => null,
      sessionExists: async () => true,
      createSession: async () => 'session',
      hasActiveTurn: async (id) => active.has(id),
      isSessionRunning: async (id) => active.has(id),
      workspaceSession: (id) => session(id),
    },
  };
}

function answeringHarness() {
  const asks = [];
  const active = new Set();
  const session = (id) => ({
    sessionExists: async () => true,
    hasActiveTurn: async () => active.has(id),
    isRunning: async () => active.has(id),
    ask: async (text) => {
      asks.push({ id, text });
      active.add(id);
      active.delete(id);
      return 'answer';
    },
  });
  return {
    asks,
    harness: {
      ensureRunning: async () => true,
      currentWorkspace: () => null,
      sessionExists: async () => true,
      createSession: async () => 'session',
      hasActiveTurn: async (id) => active.has(id),
      isSessionRunning: async (id) => active.has(id),
      workspaceSession: (id) => session(id),
    },
  };
}

for (const [channel, fixture] of Object.entries(channels)) {
  test(`${channel}: a queued message is persisted, replayed when unsubmitted, reported when submitted`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), `dsh-pending-${channel}-`));
    const statePath = join(directory, 'state.json');
    t.after(() => rm(directory, { recursive: true, force: true }));

    const first = blockingHarness();
    const firstSent = [];
    const state = await new fixture.Store(statePath).load();
    const putPendingMessage = state.putPendingMessage.bind(state);
    let queuedPersisted = false;
    t.mock.method(state, 'putPendingMessage', async (entry) => {
      await putPendingMessage(entry);
      if (entry.messageId === 'two') queuedPersisted = true;
    });
    const firstBridge = fixture.create({
      harness: first.harness, state,
      send: (target, text) => firstSent.push({ target, text }),
    });

    // The first turn occupies the conversation; the second queues behind it and
    // receives the "queued" receipt.
    firstBridge.accept(fixture.message('one', 'first task'));
    await eventually(() => first.asks.length === 1, 'the first turn to reach the Harness');
    firstBridge.accept(fixture.message('two', 'queued task'));

    // 1) The queued message is on disk before it is ever submitted, and the
    // in-flight message is already marked submitted.
    // Wait for the real persistence promise before reading once. Polling the
    // destination with readFile can itself deny atomic rename on Windows.
    await eventually(() => queuedPersisted, 'the queued message write to finish');
    const persisted = JSON.parse(await readFile(statePath, 'utf8'));
    const queuedEntry = persisted.pendingMessages.find((entry) => entry.messageId === 'two');
    const inFlightEntry = persisted.pendingMessages.find((entry) => entry.messageId === 'one');
    assert.equal(queuedEntry.submitted, false);
    assert.equal(queuedEntry.text, 'queued task');
    assert.equal(queuedEntry.kind, channel === 'qq' ? 'c2c' : 'direct');
    assert.equal(queuedEntry.key, channel === 'qq' ? 'c2c:owner' : 'direct:chat');
    assert.equal(inFlightEntry.submitted, true);

    // 2) Simulated restart: a fresh bridge over the same state file replays the
    // unsubmitted entry and only reports the submitted one.
    const restartedState = await new fixture.Store(statePath).load();
    assert.equal(restartedState.pendingMessages().length, 2);
    const second = answeringHarness();
    const secondSent = [];
    const restarted = fixture.create({
      harness: second.harness, state: restartedState,
      send: (target, text) => secondSent.push({ target, text }),
    });
    await restarted.recoverPendingMessages();
    await restarted.waitForIdle();

    assert.equal(second.asks.length, 1, 'only the unsubmitted message is replayed');
    assert.equal(second.asks[0].text, 'queued task', 'the original text is replayed without rewriting');
    assert.equal(second.asks.some((ask) => ask.text === 'first task'), false,
      'the submitted message is never re-executed');
    const notices = secondSent.filter((row) => /重启/.test(row.text));
    assert.equal(notices.length, 1, 'the submitted message is reported exactly once');

    // 3) Recovery clears everything it handled, on disk as well as in memory.
    assert.deepEqual(restartedState.pendingMessages(), []);
    const reopened = JSON.parse(await readFile(statePath, 'utf8'));
    assert.deepEqual(reopened.pendingMessages ?? [], []);
  });

  test(`${channel}: a completed turn leaves no pending entry behind`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), `dsh-pending-done-${channel}-`));
    const statePath = join(directory, 'state.json');
    t.after(() => rm(directory, { recursive: true, force: true }));

    const state = await new fixture.Store(statePath).load();
    const harness = answeringHarness();
    const sent = [];
    const bridge = fixture.create({
      harness: harness.harness, state,
      send: (target, text) => sent.push({ target, text }),
    });
    await bridge.recoverPendingMessages();
    await bridge.accept(fixture.message('solo', 'solo task'));
    await bridge.waitForIdle();

    assert.equal(harness.asks.length, 1);
    assert.equal(harness.asks[0].text, 'solo task');
    assert.deepEqual(state.pendingMessages(), []);
    const persisted = JSON.parse(await readFile(statePath, 'utf8'));
    assert.deepEqual(persisted.pendingMessages ?? [], []);
  });
}
