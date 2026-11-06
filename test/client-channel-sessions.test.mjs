import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import {
  CHANNEL_SESSIONS_PANEL_ID,
  ChannelSessionsPanel,
  installChannelSessionsPage,
} from '../plugin-src/client/im-channels.js';
import { en, setImTranslator } from '../plugin-src/client/i18n.js';
import { IM_MAIN_PANEL_ID } from '../plugin-src/client/plugin-page.js';

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

function installPage(t, translate = (key) => key) {
  setImTranslator(translate);
  t.after(() => setImTranslator());
  const registrations = new Map();
  const slots = {
    inject(name, install) { return install(); },
    register(options, component) {
      registrations.set(options.name, { options, component });
      return () => registrations.delete(options.name);
    },
  };
  let stop;
  const selected = [];
  const ctx = { inject: (_services, install) => {
    stop = install({ slots, layout: { selectPanel: (id) => selected.push(id) } });
    return stop;
  } };
  const navigation = installChannelSessionsPage(ctx, { channelListRpcCall: async () => {} });
  t.after(() => stop());
  assert.equal(registrations.get('main').options.key, CHANNEL_SESSIONS_PANEL_ID);
  assert.equal(registrations.has('sidebar.panellist'), false);
  navigation.open();
  registrations.get('main').options.inject().onBackToIm();
  assert.deepEqual(selected, [CHANNEL_SESSIONS_PANEL_ID, IM_MAIN_PANEL_ID]);
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

test('session history opens as a secondary panel without a sidebar entry', (t) => {
  assert.equal(installPage(t), ChannelSessionsPanel);
});

test('history navigation follows late layout and main-slot availability', () => {
  let installLayout;
  let installMain;
  const navigation = installChannelSessionsPage({
    inject(_services, install) { installLayout = install; },
  }, { channelListRpcCall: async () => {} });
  const snapshots = [];
  const unsubscribe = navigation.subscribe(() => snapshots.push(navigation.available()));
  assert.equal(navigation.available(), false);
  const selected = [];
  const stopLayout = installLayout({
    layout: { selectPanel: (id) => selected.push(id) },
    slots: {
      inject(name, install) {
        assert.equal(name, 'main');
        installMain = install;
        return () => {};
      },
      register() { return () => {}; },
    },
  });
  assert.equal(navigation.available(), false);
  const stopMain = installMain();
  navigation.open();
  stopMain();
  navigation.open();
  assert.deepEqual(selected, [CHANNEL_SESSIONS_PANEL_ID]);
  assert.deepEqual(snapshots, [true, false]);
  unsubscribe();
  stopLayout();
});

test('both the history list and transcript offer a return to IM bots', async (t) => {
  const Page = installPage(t);
  let returned = 0;
  let renderer;
  await act(async () => {
    renderer = create(h(Page, {
      onBackToIm: () => { returned++; },
      channelListRpcCall: async (method) => method === 'list.channels'
        ? { ok: true, value: { channels: [{ channel: 'matrix', sessions: [row] }] } }
        : { ok: true, value: { messages: transcript(1), total: 1, hasMore: false } },
    }));
    await flush();
  });
  t.after(() => renderer.unmount());
  assert.deepEqual(renderer.root.findByType('h1').children, ['会话记录']);
  act(() => renderer.root.findByProps({ className: 'im-channel-back-to-im' }).props.onClick());
  await act(async () => {
    renderer.root.findByProps({ className: 'im-channel-session-open' }).props.onClick();
    await flush();
  });
  act(() => renderer.root.findByProps({ className: 'im-channel-back-to-im' }).props.onClick());
  assert.equal(returned, 2);
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

test('detail loading and empty states use exact localized dictionary entries', async (t) => {
  const Page = installPage(t, (key) => en[key] ?? key);
  const pending = deferred();
  const channelListRpcCall = async (method) => {
    if (method === 'list.channels') {
      return { ok: true, value: { channels: [{ channel: 'matrix', sessions: [row] }] } };
    }
    return pending.promise;
  };
  let renderer;
  await act(async () => {
    renderer = create(h(Page, { channelListRpcCall }));
    await flush();
  });
  t.after(() => renderer.unmount());
  act(() => {
    renderer.root.findByProps({ className: 'im-channel-session-open' }).props.onClick();
  });
  assert.ok(JSON.stringify(renderer.toJSON()).includes(en['加载中…']));

  await act(async () => {
    pending.resolve({ ok: true, value: {
      channel: 'matrix', key: channelKey, botId: row.botId, sessionId,
      total: 0, offset: 0, limit: 100, hasMore: false, nextOffset: 0, messages: [],
    } });
    await flush();
  });
  assert.ok(JSON.stringify(renderer.toJSON()).includes(en['没有可显示的用户或助手正文。']));
});
