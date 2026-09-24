import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WecomAppBridge } from '../../../src/channels/wecom-app/wecom-app-bridge.mjs';
import { WecomAppStateStore } from '../../../src/channels/wecom-app/state-store.mjs';

function textMessage(id, text, overrides = {}) {
  return {
    msgid: id,
    msgtype: 'text',
    from: { userid: 'user-1' },
    text: { content: text },
    ...overrides,
  };
}

function fakeStreamSink({ refreshes = 0 } = {}) {
  const calls = { appended: [], finished: false, finishErrors: [] };
  return {
    calls,
    streamId: 'stream-1',
    append: (chunk, options) => {
      calls.appended.push({ chunk, options: options ?? null });
      return true;
    },
    finish: (error) => {
      calls.finished = true;
      if (error) calls.finishErrors.push(error);
      return true;
    },
    refreshes: () => refreshes,
    finished: () => calls.finished,
  };
}

function fakeHarness(answer = 'final answer', { onUpdate = false } = {}) {
  return {
    ensureRunning: async () => {},
    sessionExists: async () => true,
    createSession: async () => 'session-1',
    ask: async (_sessionId, _prompt, options = {}) => {
      if (onUpdate) options.onUpdate?.({ type: 'text', text: 'partial answer' });
      return answer;
    },
  };
}

async function stateFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wecomapp-bridge-'));
  const state = await new WecomAppStateStore(join(root, 'state.json')).load();
  return { root, state };
}

async function eventually(predicate, messageText = 'condition was not met') {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(messageText);
}

test('stream answer appends updates and falls back to text when never refreshed', async () => {
  const { root, state } = await stateFixture();
  const sink = fakeStreamSink({ refreshes: 0 });
  const sends = [];
  const bridge = new WecomAppBridge({
    api: { sendText: async ({ userId, content }) => {
      sends.push({ userId, content });
      return { message_id: 'outbound-' + sends.length };
    } },
    harness: fakeHarness('final answer', { onUpdate: true }),
    state,
    status: { messagesReceived: 0, messagesReplied: 0 },
    streamRegistry: {
      appendStream: (streamId, chunk, options) => sink.append(chunk, options),
      finishStream: (streamId, options) => sink.finish(options?.error),
      getStream: () => ({ refreshes: sink.calls.appended.length > 0 ? 0 : 0 }),
    },
  });

  await bridge.accept(textMessage('m-1', '你好'), { sink });
  await eventually(() => sends.length > 0);
  assert.equal(sends.at(-1).content, 'final answer');
  assert.equal(sink.calls.finished, true);
  assert.equal(sink.calls.appended.some((call) => call.options?.replace === true), true);
  await bridge.close();
  await rm(root, { recursive: true, force: true });
});

test('stream answer is not duplicated over the API when the client refreshed', async () => {
  const { root, state } = await stateFixture();
  const sink = fakeStreamSink({ refreshes: 2 });
  const sends = [];
  const bridge = new WecomAppBridge({
    api: { sendText: async ({ content }) => {
      sends.push(content);
      return { message_id: 'outbound' };
    } },
    harness: fakeHarness('final answer'),
    state,
    status: { messagesReceived: 0, messagesReplied: 0 },
    streamRegistry: {
      appendStream: (streamId, chunk, options) => sink.append(chunk, options),
      finishStream: (streamId, options) => sink.finish(options?.error),
      getStream: () => ({ refreshes: 2 }),
    },
  });

  await bridge.accept(textMessage('m-2', '你好'), { sink });
  await eventually(() => sink.calls.finished);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(sends, []);
  await bridge.close();
  await rm(root, { recursive: true, force: true });
});

test('the /help command replies through the API without touching Harness', async () => {
  const { root, state } = await stateFixture();
  const sends = [];
  let askCalls = 0;
  const bridge = new WecomAppBridge({
    api: { sendText: async ({ content }) => {
      sends.push(content);
      return { message_id: 'outbound' };
    } },
    harness: fakeHarness(() => { askCalls += 1; return ''; }),
    state,
    status: { messagesReceived: 0, messagesReplied: 0 },
  });

  await bridge.accept(textMessage('m-3', '/help'));
  await eventually(() => sends.length > 0);
  assert.match(sends.at(-1), /\/help/);
  assert.equal(askCalls, 0);
  await bridge.close();
  await rm(root, { recursive: true, force: true });
});

test('welcome events are sent as plain text', async () => {
  const { root, state } = await stateFixture();
  const sends = [];
  const bridge = new WecomAppBridge({
    api: { sendText: async ({ content }) => {
      sends.push(content);
      return { message_id: 'outbound' };
    } },
    harness: fakeHarness('unused'),
    state,
    status: { messagesReceived: 0, messagesReplied: 0 },
  });

  await bridge.acceptEvent({ msgtype: 'event', event: 'subscribe', from: { userid: 'user-1' } });
  await eventually(() => sends.length > 0);
  assert.match(sends.at(-1), /企业微信应用已连接/);
  await bridge.close();
  await rm(root, { recursive: true, force: true });
});

test('rejected senders never reach Harness and never get replies', async () => {
  const { root, state } = await stateFixture();
  const sends = [];
  let asked = false;
  const bridge = new WecomAppBridge({
    api: { sendText: async ({ content }) => {
      sends.push(content);
      return { message_id: 'outbound' };
    } },
    harness: { ensureRunning: async () => {}, sessionExists: async () => true, createSession: async () => 's', ask: async () => { asked = true; return 'x'; } },
    state,
    status: { messagesReceived: 0, messagesReplied: 0 },
    accessPolicy: {
      botId: 'wecomapp_test',
      getSettings: async () => ({
        direct: { mode: 'allowlist', allowlist: { users: [] } },
        group: { mode: 'allowlist', allowlist: { users: [] } },
      }),
      isPrivileged: () => false,
    },
  });

  await bridge.accept(textMessage('m-4', 'hello'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(sends, []);
  assert.equal(asked, false);
  assert.equal(state.hasSeen('m-4'), true);
  await bridge.close();
  await rm(root, { recursive: true, force: true });
});
