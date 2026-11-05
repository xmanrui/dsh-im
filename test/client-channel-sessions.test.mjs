import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import {
  CHANNEL_SESSIONS_PANEL_ID,
  ChannelSessionsPanel,
  installChannelSessionsPage,
} from '../plugin-src/client/im-channels.js';

const { act, create } = TestRenderer;
const h = React.createElement;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};
const sessionId = 'session-11111111-1111-4111-8111-111111111111';
const channelKey = 'group:room:!example:test.invalid';
const row = { key: channelKey, sessionId, botId: 'matrix_test' };

function installPage(t) {
  const registrations = new Map();
  const slots = {
    inject(name, install) { return install(); },
    register(options, component) {
      registrations.set(options.name, { options, component });
      return () => registrations.delete(options.name);
    },
  };
  const ctx = { inject: (_services, install) => install({
    slots, locale: { bind: () => (key) => key },
  }) };
  const stop = installChannelSessionsPage(ctx, { channelListRpcCall: async () => {} });
  t.after(stop);
  assert.equal(registrations.get('main').options.key, CHANNEL_SESSIONS_PANEL_ID);
  assert.equal(registrations.get('sidebar.panellist').options.id, CHANNEL_SESSIONS_PANEL_ID);
  return registrations.get('main').component;
}

function transcript(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index + 1}`,
    seq: index + 1,
    time: 1_700_000_000_000 + index * 1000,
    role: index % 2 ? 'assistant' : 'user',
    text: `message ${index + 1}`,
  }));
}

test('channel sessions register one matching global main/sidebar panel pair', (t) => {
  assert.equal(installPage(t), ChannelSessionsPanel);
});

test('loading every earlier page keeps each transcript message exactly once', async (t) => {
  const Page = installPage(t);
  const messages = transcript(250);
  const calls = [];
  const channelListRpcCall = async (method, payload = {}) => {
    calls.push({ method, payload });
    if (method === 'list.channels') {
      return { ok: true, value: { channels: [{ channel: 'matrix', sessions: [row] }] } };
    }
    assert.equal(method, 'session.read');
    const limit = payload.limit ?? 100;
    const offset = payload.offset ?? Math.max(0, messages.length - limit);
    return {
      ok: true,
      value: {
        channel: 'matrix', key: channelKey, botId: row.botId, sessionId,
        total: messages.length, offset, limit,
        hasMore: offset > 0,
        nextOffset: Math.max(0, offset - limit),
        messages: messages.slice(offset, offset + limit),
      },
    };
  };

  let renderer;
  await act(async () => {
    renderer = create(h(Page, { channelListRpcCall }));
    await flush();
  });
  t.after(() => renderer.unmount());
  await act(async () => {
    renderer.root.findByProps({ className: 'im-channel-session-open' }).props.onClick();
    await flush();
  });
  const instance = renderer.root.findByType(ChannelSessionsPanel({}).type).instance;
  assert.equal(instance.state.detail.messages.length, 100);
  assert.equal(instance.state.detail.hasMore, true);

  await act(async () => {
    renderer.root.findByProps({ className: 'im-channel-load-earlier' }).props.onClick();
    await flush();
  });
  assert.equal(instance.state.detail.messages.length, 200);
  assert.equal(instance.state.detail.hasMore, true);

  await act(async () => {
    renderer.root.findByProps({ className: 'im-channel-load-earlier' }).props.onClick();
    await flush();
  });
  const ids = instance.state.detail.messages.map((message) => message.id);
  assert.deepEqual(ids, messages.map((message) => message.id));
  assert.equal(new Set(ids).size, messages.length);
  assert.equal(instance.state.detail.hasMore, false);
  assert.equal(calls.filter((call) => call.method === 'session.read').length, 3);
});

test('a stale detail response cannot replace a newer navigation', async (t) => {
  const Page = installPage(t);
  const otherSessionId = 'session-22222222-2222-4222-8222-222222222222';
  const otherRow = { key: 'group:room:!other:test.invalid', sessionId: otherSessionId, botId: 'matrix_test' };
  const pending = new Map([[sessionId, deferred()], [otherSessionId, deferred()]]);
  const channelListRpcCall = async (method) => {
    if (method === 'list.channels') {
      return { ok: true, value: { channels: [{ channel: 'matrix', sessions: [row, otherRow] }] } };
    }
    throw new Error('session.read is deferred below');
  };
  const rpc = (method, payload) => method === 'session.read'
    ? pending.get(payload.sessionId).promise
    : channelListRpcCall(method, payload);
  let renderer;
  await act(async () => {
    renderer = create(h(Page, { channelListRpcCall: rpc }));
    await flush();
  });
  t.after(() => renderer.unmount());
  const instance = renderer.root.findByType(ChannelSessionsPanel({}).type).instance;

  act(() => { void instance.openSession({ channel: 'matrix' }, row); });
  act(() => { instance.backToList(); });
  act(() => { void instance.openSession({ channel: 'matrix' }, otherRow); });
  await act(async () => {
    pending.get(otherSessionId).resolve({ ok: true, value: {
      channel: 'matrix', key: otherRow.key, botId: otherRow.botId, sessionId: otherSessionId,
      total: 1, offset: 0, limit: 100, hasMore: false, nextOffset: 0,
      messages: [{ id: 'newer', seq: 1, time: 1, role: 'assistant', text: 'newer response' }],
    } });
    await flush();
  });
  assert.equal(instance.state.selected.sessionId, otherSessionId);
  assert.equal(instance.state.detail.messages[0].text, 'newer response');

  await act(async () => {
    pending.get(sessionId).resolve({ ok: true, value: {
      channel: 'matrix', key: row.key, botId: row.botId, sessionId,
      total: 1, offset: 0, limit: 100, hasMore: false, nextOffset: 0,
      messages: [{ id: 'stale', seq: 1, time: 1, role: 'assistant', text: 'stale response' }],
    } });
    await flush();
  });
  assert.equal(instance.state.selected.sessionId, otherSessionId);
  assert.equal(instance.state.detail.messages[0].text, 'newer response');
});

test('unmount aborts and ignores a late detail response', async (t) => {
  const Page = installPage(t);
  const pending = deferred();
  let detailSignal;
  const channelListRpcCall = async (method, _payload, signal) => {
    if (method === 'list.channels') {
      return { ok: true, value: { channels: [{ channel: 'matrix', sessions: [row] }] } };
    }
    detailSignal = signal;
    return pending.promise;
  };
  let renderer;
  await act(async () => {
    renderer = create(h(Page, { channelListRpcCall }));
    await flush();
  });
  let mounted = true;
  t.after(() => { if (mounted) renderer.unmount(); });
  const instance = renderer.root.findByType(ChannelSessionsPanel({}).type).instance;
  act(() => { void instance.openSession({ channel: 'matrix' }, row); });
  assert.equal(instance.state.selected.sessionId, sessionId);
  act(() => {
    renderer.unmount();
    mounted = false;
  });
  assert.equal(detailSignal.aborted, true);

  await act(async () => {
    pending.resolve({ ok: true, value: {
      channel: 'matrix', key: row.key, botId: row.botId, sessionId,
      total: 1, offset: 0, limit: 100, hasMore: false, nextOffset: 0,
      messages: [{ id: 'late', seq: 1, time: 1, role: 'assistant', text: 'late response' }],
    } });
    await flush();
  });
  assert.equal(instance.state.detail, null);
});
