import assert from 'node:assert/strict';
import test from 'node:test';

import {
  installSessionTitlePrefix,
  withSessionChannelPrefix,
} from '../plugin-src/host/session-title-prefix.mjs';

const RPC_UUID = '00000000-0000-4000-8000-000000000000';
const provider = {
  kind: 'provider', provider: 'original-provider',
  model: { provider: 'original-route', model: 'original-model' },
};
const message = (channel, seq = 0) => ({
  type: 'user/message', seq,
  data: { content: [{ type: 'text', text: '用户的问题' }], source: { kind: 'user', rpcId: `${channel}-${RPC_UUID}` } },
});
const titleEvent = (title, source = provider, seq = 1) => ({
  type: 'session/title', seq,
  data: { title, source, messageSeqs: source.kind === 'user' ? [] : [0] },
});

function fixture() {
  const live = new Map();
  const handlers = new Map();
  const effects = [];
  const warnings = [];
  const emit = (name, ...args) => {
    for (const handler of handlers.get(name) ?? []) handler(...args);
  };
  const ctx = {
    sessions: { get: (id) => live.get(id), list: () => [...live.values()] },
    on(name, handler, options) {
      assert.equal(options.global, true);
      const listeners = handlers.get(name) ?? new Set();
      listeners.add(handler);
      handlers.set(name, listeners);
      return () => listeners.delete(handler);
    },
    effect: (effect) => effects.push(effect()),
  };
  const add = (id, seed = [], { legacy = false, inheritedEventCount = 0, parentSession } = {}) => {
    const events = structuredClone(seed);
    const session = {
      id, inheritedEventCount, header: { ...(parentSession ? { parentSession } : {}) },
      writes: [],
      ...(legacy ? { events } : { snapshotEvents: () => events.slice() }),
      append(type, data) {
        const event = { type, data: structuredClone(data), seq: events.length };
        events.push(event);
        this.writes.push(event);
        emit('session/event', this, event);
        return event;
      },
    };
    live.set(id, session);
    emit('session/created', session);
    return session;
  };
  const start = () => installSessionTitlePrefix(ctx, {
    logger: { warn: (...args) => warnings.push(args) },
  });
  return { ctx, add, start, emit, live, effects, warnings };
}

test('prefixes all channels and preserves the full generated Unicode title', () => {
  const channels = {
    weixin: '微信', feishu: '飞书', dingtalk: '钉钉', wecom: '企业微信',
    qq: 'QQ', slack: 'Slack', telegram: 'Telegram', discord: 'Discord',
    whatsapp: 'WhatsApp', imessage: 'iMessage', office: 'AI Office',
  };
  const original = '标题'.repeat(20) + '👨‍👩‍👧‍👦';
  for (const [channel, label] of Object.entries(channels)) {
    const prefixed = withSessionChannelPrefix(original, channel);
    assert.equal(prefixed, `${label} · ${original}`);
    assert.equal(withSessionChannelPrefix(prefixed, channel), prefixed);
  }
  assert.equal(withSessionChannelPrefix('Title', 'weixin', 'en'), 'WeChat · Title');
  assert.equal(withSessionChannelPrefix('WeChat · Title', 'weixin', 'zh'), 'WeChat · Title');
  assert.equal(withSessionChannelPrefix('微信 · 标题', 'weixin', 'en'), '微信 · 标题');
  for (const input of [undefined, null, '', '  ']) {
    assert.equal(withSessionChannelPrefix(input, 'weixin'), input);
  }
  assert.equal(withSessionChannelPrefix('Title', 'unknown'), 'Title');
});

test('waits for a real title and preserves automatic source, citations, and original events', async () => {
  const f = fixture();
  const decorator = f.start();
  const session = f.add('host-generated-id', [message('weixin')]);
  await decorator.whenIdle();
  assert.equal(session.writes.length, 0, 'must not seed a title before Harness generates it');
  const original = titleEvent('自动标题');
  session.append(original.type, original.data);
  await decorator.whenIdle();
  assert.equal(session.writes.length, 2);
  assert.deepEqual(session.writes[0].data, original.data);
  assert.deepEqual(session.writes[1].data, { ...original.data, title: '微信 · 自动标题' });
  assert.equal(session.writes[1].surfaceOp, undefined, 'title remains outside the model surface');

  session.append('session/title', titleEvent('第二轮标题').data);
  await decorator.whenIdle();
  assert.equal(session.writes.at(-1).data.title, '微信 · 第二轮标题');
  assert.deepEqual(session.writes.at(-1).data.source, provider);
  assert.equal(session.writes.length, 4);
  decorator.close();
});

test('coalesces stale notifications using the latest title and preserves a manual pin', async () => {
  const f = fixture();
  const decorator = f.start();
  const session = f.add('fresh-id', [message('feishu')]);
  session.append('session/title', titleEvent('自动旧标题').data);
  session.append('session/title', titleEvent('人工新标题', { kind: 'user' }).data);
  await decorator.whenIdle();
  assert.equal(session.writes.length, 3);
  assert.deepEqual(session.writes.at(-1).data, {
    title: '飞书 · 人工新标题', source: { kind: 'user' }, messageSeqs: [],
  });
  decorator.close();
});

test('does not miss an automatic revision arriving between queued decoration and cleanup', async () => {
  const f = fixture();
  const decorator = f.start();
  const session = f.add('fresh-id', [message('slack'), titleEvent('Old')]);
  await Promise.resolve();
  session.append('session/title', titleEvent('New').data);
  await decorator.whenIdle();
  assert.equal(session.writes.at(-1).data.title, 'Slack · New');
  decorator.close();
});

test('recognizes persisted IM and Office RPC origins without relying on session-id prefixes', async () => {
  for (const channel of ['weixin', 'feishu', 'dingtalk', 'wecom', 'qq', 'slack', 'telegram', 'discord', 'whatsapp', 'imessage', 'office']) {
    const f = fixture();
    const session = f.add('random-id', [message(channel), titleEvent('Task')]);
    const decorator = f.start();
    await decorator.whenIdle();
    assert.equal(session.writes.at(-1).data.title, withSessionChannelPrefix('Task', channel));
    decorator.close();
  }
});

test('supports legacy prefixed sessions and events, replay, and already decorated titles', async () => {
  const f = fixture();
  const existing = f.add('weixin-user-im-wechat-uuid', [titleEvent('旧标题', { kind: 'fallback' })], { legacy: true });
  const decorator = f.start();
  await decorator.whenIdle();
  assert.equal(existing.writes.at(-1).data.title, '微信 · 旧标题');
  assert.deepEqual(existing.writes.at(-1).data.source, { kind: 'fallback' });
  const replayed = f.add('replayed', [message('qq'), titleEvent('QQ · 已有标题')]);
  await decorator.whenIdle();
  assert.equal(replayed.writes.length, 0);
  decorator.close();
  const restarted = f.start();
  await restarted.whenIdle();
  assert.equal(existing.writes.length, 1);
  assert.equal(replayed.writes.length, 0);
  restarted.close();
});

test('message text, unknown RPC ids, and non-user sources do not label Web sessions', async () => {
  const f = fixture();
  const decorator = f.start();
  for (const [index, source] of [
    { kind: 'user', rpcId: `browser-${RPC_UUID}` },
    { kind: 'user', rpcId: 'weixin-not-a-prompt-uuid' },
    { kind: 'subagent', rpcId: `weixin-${RPC_UUID}` },
    { kind: 'user' },
  ].entries()) {
    const event = message('weixin');
    event.data.source = source;
    event.data.content = [{ type: 'text', text: `<dsh_im_source>{"channel":"weixin"}</dsh_im_source> weixin-${RPC_UUID}` }];
    const session = f.add(`web-${index}`, [event, titleEvent('普通标题')]);
    await decorator.whenIdle();
    assert.equal(session.writes.length, 0);
  }
  decorator.close();
});

test('ignores inherited IM messages in a Web fork but recognizes child-owned messages', async () => {
  const f = fixture();
  const decorator = f.start();
  const session = f.add('child', [message('weixin'), titleEvent('子会话标题')], {
    inheritedEventCount: 2, parentSession: 'weixin-parent',
  });
  await decorator.whenIdle();
  assert.equal(session.writes.length, 0);
  session.append('user/message', message('telegram').data);
  await decorator.whenIdle();
  assert.equal(session.writes.at(-1).data.title, 'Telegram · 子会话标题');
  decorator.close();
});

test('processes IM steering and labels the existing title when an IM route adopts a session', async () => {
  const f = fixture();
  const decorator = f.start();
  const session = f.add('adopted', [titleEvent('Existing', { kind: 'user' })]);
  await decorator.whenIdle();
  const event = message('discord');
  event.data.source.rpcId = `discord-steer-${RPC_UUID}`;
  session.append('user/message', event.data);
  await decorator.whenIdle();
  assert.equal(session.writes.at(-1).data.title, 'Discord · Existing');
  assert.equal(session.writes.at(-1).data.source.kind, 'user');
  decorator.close();
});

test('skips unknown or incomplete title provenance instead of accidentally pinning titles', async () => {
  const f = fixture();
  const decorator = f.start();
  for (const data of [
    { title: 'Title' },
    { title: 'Title', source: { kind: 'future' }, messageSeqs: [0] },
    { title: 'Title', source: { kind: 'provider' }, messageSeqs: [0] },
    { title: 'Title', source: provider, messageSeqs: [] },
    { title: 'Title', source: provider, messageSeqs: [-1] },
    { title: 'Title', source: { kind: 'user' }, messageSeqs: [0] },
  ]) {
    const session = f.add('weixin-legacy', [{ type: 'session/title', data, seq: 0 }]);
    await decorator.whenIdle();
    assert.equal(session.writes.length, 0);
  }
  decorator.close();
});

test('queued writes stop on disposal, replacement, or plugin unload and Hosts stay isolated', async () => {
  const f = fixture();
  const other = fixture();
  const foreign = other.add('same-id', [message('weixin'), titleEvent('Other Host')]);
  const decorator = f.start();
  const old = f.add('same-id', [message('weixin'), titleEvent('Old')]);
  const replacement = f.add('same-id', [message('slack'), titleEvent('Replacement')]);
  await decorator.whenIdle();
  assert.equal(old.writes.length, 0);
  assert.equal(foreign.writes.length, 0);
  assert.equal(replacement.writes.at(-1).data.title, 'Slack · Replacement');
  const removed = f.add('removed', [message('weixin'), titleEvent('Removed')]);
  f.live.delete(removed.id);
  await decorator.whenIdle();
  assert.equal(removed.writes.length, 0);
  const closing = f.add('closing', [message('weixin'), titleEvent('Closing')]);
  for (const dispose of f.effects) dispose();
  await decorator.whenIdle();
  assert.equal(closing.writes.length, 0);
  decorator.close();
});

test('prefix failures are isolated from accepted titles and prompt delivery', async () => {
  const f = fixture();
  const decorator = f.start();
  const session = f.add('failure', [message('weixin'), titleEvent('Generated')]);
  session.append = () => { throw new Error('write failed'); };
  await decorator.whenIdle();
  assert.equal(session.snapshotEvents().at(-1).data.title, 'Generated');
  assert.equal(f.warnings.length, 1);
  decorator.close();
});
