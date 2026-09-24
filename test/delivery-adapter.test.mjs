import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DingtalkStateStore } from '../src/channels/dingtalk/state-store.mjs';
import { DiscordStateStore } from '../src/channels/discord/state-store.mjs';
import { StateStore as FeishuStateStore } from '../src/channels/feishu/state-store.mjs';
import { QqStateStore } from '../src/channels/qq/state-store.mjs';
import { SlackStateStore } from '../src/channels/slack/state-store.mjs';
import { TelegramStateStore } from '../src/channels/telegram/state-store.mjs';
import { WecomStateStore } from '../src/channels/wecom/state-store.mjs';
import { WecomAppStateStore } from '../src/channels/wecom-app/state-store.mjs';
import { WeixinStateStore } from '../src/channels/weixin/state-store.mjs';
import { WhatsappStateStore } from '../src/channels/whatsapp/state-store.mjs';
import {
  createDeliveryAdapter,
  normalizeDeliveryTarget,
} from '../plugin-src/host/delivery-adapter.mjs';
import { deliverySuggestionsFromSessions } from '../plugin-src/host/delivery-suggestions.mjs';

const TARGETS = {
  weixin: { targetId: 'daily', kind: 'user', route: { toUserId: 'wx-user' } },
  feishu: { targetId: 'daily', kind: 'group', route: { chatId: 'oc_group' } },
  dingtalk: {
    targetId: 'daily', kind: 'group', route: { openConversationId: 'cid_group' },
  },
  wecom: { targetId: 'daily', kind: 'user', route: { chatId: 'wecom-user' } },
  'wecom-app': { targetId: 'daily', kind: 'user', route: { chatId: 'wecomapp-user' } },
  qq: { targetId: 'daily', kind: 'group', route: { groupOpenId: 'qq-group' } },
  slack: {
    targetId: 'daily', kind: 'thread', route: { channelId: 'C123', threadTs: '123.456' },
  },
  telegram: {
    targetId: 'daily', kind: 'topic', route: { chatId: '-100123', messageThreadId: 42 },
  },
  discord: { targetId: 'daily', kind: 'channel', route: { channelId: '123456789' } },
  whatsapp: {
    targetId: 'daily', kind: 'group', route: { jid: '123456789-120363000000000000@g.us' },
  },
};

const STATE_STORES = {
  weixin: WeixinStateStore,
  feishu: FeishuStateStore,
  dingtalk: DingtalkStateStore,
  wecom: WecomStateStore,
  'wecom-app': WecomAppStateStore,
  qq: QqStateStore,
  slack: SlackStateStore,
  telegram: TelegramStateStore,
  discord: DiscordStateStore,
  whatsapp: WhatsappStateStore,
};

const SESSION_SUGGESTIONS = {
  weixin: {
    sessions: { 'p2p:wx-user': 'session-weixin', 'group:ignored': 'session-ignored' },
    suggestions: [{ kind: 'user', route: { toUserId: 'wx-user' } }],
  },
  feishu: {
    sessions: {
      'p2p:ou_user': 'session-user',
      'p2p:legacy-user-id': 'session-without-open-id',
      'group:oc_group': 'session-group',
    },
    suggestions: [
      { kind: 'user', route: { openId: 'ou_user' } },
      { kind: 'group', route: { chatId: 'oc_group' } },
    ],
  },
  dingtalk: {
    sessions: { 'p2p:staff-one': 'session-user', 'group:cid_group': 'session-group' },
    suggestions: [
      { kind: 'user', route: { userId: 'staff-one' } },
      { kind: 'group', route: { openConversationId: 'cid_group' } },
    ],
  },
  wecom: {
    sessions: { 'direct:member-one': 'session-user', 'group:wr_group': 'session-group' },
    suggestions: [
      { kind: 'user', route: { chatId: 'member-one' } },
      { kind: 'group', route: { chatId: 'wr_group' } },
    ],
  },
  'wecom-app': {
    sessions: { 'p2p:wecomapp-user': 'session-user' },
    suggestions: [{ kind: 'user', route: { chatId: 'wecomapp-user' } }],
  },
  qq: {
    sessions: { 'c2c:user-openid': 'session-user', 'group:group-openid': 'session-group' },
    suggestions: [
      { kind: 'user', route: { userOpenId: 'user-openid' } },
      { kind: 'group', route: { groupOpenId: 'group-openid' } },
    ],
  },
  slack: {
    sessions: {
      'direct:D123456': 'session-direct',
      'group:C123456:1712345678.123456': 'session-thread',
    },
    suggestions: [
      { kind: 'conversation', route: { channelId: 'D123456' } },
      { kind: 'thread', route: { channelId: 'C123456', threadTs: '1712345678.123456' } },
    ],
  },
  telegram: {
    sessions: {
      'direct:88': 'session-direct',
      'group:88': 'session-duplicate-chat',
      'group:-1001234567890:42': 'session-topic',
    },
    suggestions: [
      { kind: 'chat', route: { chatId: '88' } },
      { kind: 'topic', route: { chatId: '-1001234567890', messageThreadId: 42 } },
    ],
  },
  discord: {
    sessions: {
      'direct:123456789012345678': 'session-direct',
      'group:123456789012345678': 'session-duplicate-channel',
      'group:223456789012345678': 'session-thread',
    },
    suggestions: [
      { kind: 'channel', route: { channelId: '123456789012345678' } },
      { kind: 'channel', route: { channelId: '223456789012345678' } },
    ],
  },
  whatsapp: {
    sessions: {
      'direct:16505550123@s.whatsapp.net': 'session-user',
      'group:120363000000000000@g.us': 'session-group',
      'group:123456789-120363000000000001@g.us': 'session-legacy-group',
    },
    suggestions: [
      { kind: 'user', route: { jid: '16505550123@s.whatsapp.net' } },
      { kind: 'group', route: { jid: '120363000000000000@g.us' } },
      { kind: 'group', route: { jid: '123456789-120363000000000001@g.us' } },
    ],
  },
};

const PRIVATE_TARGETS = {
  weixin: { targetId: 'private', kind: 'user', route: { toUserId: 'wx-user' } },
  feishu: { targetId: 'private', kind: 'user', route: { openId: 'ou_user' } },
  dingtalk: { targetId: 'private', kind: 'user', route: { userId: 'staff-one' } },
  wecom: { targetId: 'private', kind: 'user', route: { chatId: 'member-one' } },
  'wecom-app': { targetId: 'private', kind: 'user', route: { chatId: 'wecomapp-user' } },
  qq: { targetId: 'private', kind: 'user', route: { userOpenId: 'user-openid' } },
  slack: { targetId: 'private', kind: 'conversation', route: { channelId: 'D123456' } },
  telegram: { targetId: 'private', kind: 'chat', route: { chatId: '88' } },
  discord: {
    targetId: 'private', kind: 'channel', route: { channelId: '123456789012345678' },
  },
  whatsapp: {
    targetId: 'private', kind: 'user', route: { jid: '16505550123@s.whatsapp.net' },
  },
};

test('all ten delivery adapters validate and forward one stable target', async () => {
  for (const [channel, target] of Object.entries(TARGETS)) {
    const calls = [];
    const workspaces = {
      has: (botId) => botId === `bot-${channel}`,
      listDeliveryTargets: () => [target],
      createDeliveryTarget: async (...args) => calls.push(['create', ...args]),
      updateDeliveryTarget: async (...args) => calls.push(['update', ...args]),
      deleteDeliveryTarget: async (...args) => calls.push(['delete', ...args]),
    };
    const coreController = {
      async sendProactiveText(...args) { calls.push(['send', ...args]); },
    };
    const { sessions, suggestions } = SESSION_SUGGESTIONS[channel];
    const adapter = createDeliveryAdapter({
      channel,
      workspaces,
      coreController,
      stateFor: async () => ({ snapshot: () => ({ sessions }) }),
    });

    assert.equal(adapter.channel, channel);
    assert.equal(adapter.ownsBot(`bot-${channel}`), true);
    assert.equal(adapter.ownsBot('bot-other'), false);
    const listed = await adapter.listTargets(`bot-${channel}`);
    assert.deepEqual(listed.map(({ sessionSync: _sessionSync, ...entry }) => entry), [target]);
    assert.equal(listed[0].sessionSync.enabled, false);
    assert.deepEqual(await adapter.listSuggestions(`bot-${channel}`), suggestions);
    assert.deepEqual(
      await adapter.sendText(`bot-${channel}`, target, 'hello', { signal: undefined }),
      { sent: true },
    );
    assert.deepEqual(calls[0], [
      'send', `bot-${channel}`, target, 'hello', { signal: undefined },
    ]);
  }
});

test('all ten adapters enable, resolve, and revalidate one private Session target', async () => {
  for (const [channel, target] of Object.entries(PRIVATE_TARGETS)) {
    const botId = `bot-${channel}`;
    const sessions = { ...SESSION_SUGGESTIONS[channel].sessions };
    const conversationKey = Object.keys(sessions).find((key) => (
      sessions[key] === SESSION_SUGGESTIONS[channel].sessions[Object.keys(sessions)[0]]
    ));
    const sessionId = sessions[conversationKey];
    let syncKey = null;
    const sends = [];
    const workspaces = {
      has: (candidate) => candidate === botId,
      listBotIds: () => [botId],
      listDeliveryTargets: () => [structuredClone(target)],
      deliveryTargetFor: (_botId, targetId) => (
        targetId === target.targetId ? structuredClone(target) : null
      ),
      listSessionSyncTargets: () => syncKey
        ? [{ botId, targetId: target.targetId, conversationKey: syncKey }]
        : [],
      async setDeliveryTargetSessionSync(_botId, _targetId, value) { syncKey = value; },
      createDeliveryTarget() {},
      updateDeliveryTarget() {},
      deleteDeliveryTarget() {},
    };
    const adapter = createDeliveryAdapter({
      channel,
      workspaces,
      coreController: {
        async sendProactiveText(...args) { sends.push(args); },
      },
      stateFor: async () => ({ snapshot: () => ({ sessions }) }),
    });

    assert.deepEqual((await adapter.listTargets(botId))[0].sessionSync, {
      enabled: false, state: 'off',
    }, channel);
    assert.deepEqual(await adapter.setSessionSync(botId, target.targetId, true), {
      enabled: true, state: 'active',
    }, channel);
    assert.equal(syncKey, conversationKey, channel);
    assert.deepEqual(await adapter.listSessionSyncTargets(sessionId), [{
      botId, targetId: target.targetId,
    }], channel);
    assert.deepEqual(
      await adapter.sendSessionSyncText(botId, target.targetId, sessionId, 'synced'),
      { sent: true },
      channel,
    );
    assert.deepEqual(sends.at(-1), [botId, target, 'synced', {}], channel);

    sessions[conversationKey] = `${sessionId}-new`;
    assert.deepEqual(await adapter.listSessionSyncTargets(sessionId), [], channel);
    await assert.rejects(
      adapter.sendSessionSyncText(botId, target.targetId, sessionId, 'stale'),
      { code: 'session-sync-unavailable' },
      channel,
    );
    delete sessions[conversationKey];
    assert.deepEqual((await adapter.listTargets(botId))[0].sessionSync, {
      enabled: true, state: 'waiting',
    }, channel);
    await adapter.setSessionSync(botId, target.targetId, false);
    assert.equal(syncKey, null, channel);
  }
});

test('delivery adapter delegates target CRUD to the existing workspace store', async () => {
  const calls = [];
  const workspaces = {
    has: () => true,
    listDeliveryTargets: () => [],
    createDeliveryTarget: async (...args) => calls.push(['create', ...args]),
    updateDeliveryTarget: async (...args) => calls.push(['update', ...args]),
    deleteDeliveryTarget: async (...args) => calls.push(['delete', ...args]),
  };
  const adapter = createDeliveryAdapter({
    channel: 'feishu',
    workspaces,
    coreController: { sendProactiveText() {} },
    stateFor: async () => ({ snapshot: () => ({ sessions: {} }) }),
  });
  const target = {
    targetId: 'ops', name: '  Ops  ', kind: 'user', route: { openId: 'ou_ops' },
  };

  await adapter.createTarget('bot-one', target);
  await adapter.updateTarget('bot-one', 'ops', {
    name: 'On call', kind: 'group', route: { chatId: 'oc_oncall' },
  });
  await adapter.deleteTarget('bot-one', 'ops');

  assert.deepEqual(calls, [
    ['create', 'bot-one', {
      targetId: 'ops', name: 'Ops', kind: 'user', route: { openId: 'ou_ops' },
    }],
    ['update', 'bot-one', 'ops', {
      name: 'On call', kind: 'group', route: { chatId: 'oc_oncall' },
    }],
    ['delete', 'bot-one', 'ops'],
  ]);
});

test('suggestion parser strictly filters malformed keys, de-duplicates routes, and never leaks state values', () => {
  const sessions = {
    'direct:88': 'secret-session-one',
    'group:88': { sessionId: 'secret-session-two', replyToMessageId: 7 },
    'group:-100:42': 'secret-topic-session',
    'direct:88:7': 'transient-reply-key',
    'group:-100:0': 'invalid-topic',
    'group:not-a-number': 'invalid-chat',
    'other:88': 'wrong-prefix',
  };
  const suggestions = deliverySuggestionsFromSessions('telegram', sessions);
  assert.deepEqual(suggestions, [
    { kind: 'chat', route: { chatId: '88' } },
    { kind: 'topic', route: { chatId: '-100', messageThreadId: 42 } },
  ]);
  assert.deepEqual(
    suggestions.map((suggestion) => Object.keys(suggestion)),
    [['kind', 'route'], ['kind', 'route']],
  );
  assert.doesNotMatch(JSON.stringify(suggestions), /session|reply|secret/i);
  assert.deepEqual(deliverySuggestionsFromSessions('telegram', null), []);
  assert.deepEqual(deliverySuggestionsFromSessions('unknown', sessions), []);
});

test('all ten adapters list suggestions from reloaded bot state while no runtime is connected', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-delivery-suggestions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [channel, StateStore] of Object.entries(STATE_STORES)) {
    const path = join(directory, `${channel}.json`);
    const [conversationKey] = Object.keys(SESSION_SUGGESTIONS[channel].sessions);
    await (await new StateStore(path).load()).setSession(conversationKey, `session-${channel}`);
    const reloaded = await new StateStore(path).load();
    const adapter = createDeliveryAdapter({
      channel,
      workspaces: {
        has: () => true,
        listDeliveryTargets: () => [],
        createDeliveryTarget() {},
        updateDeliveryTarget() {},
        deleteDeliveryTarget() {},
      },
      coreController: {},
      stateFor: async () => reloaded,
    });
    assert.deepEqual(
      await adapter.listSuggestions(`bot-${channel}`),
      SESSION_SUGGESTIONS[channel].suggestions.slice(0, 1),
      channel,
    );
  }
});

test('every channel rejects unknown or transient route fields', () => {
  for (const [channel, target] of Object.entries(TARGETS)) {
    assert.throws(
      () => normalizeDeliveryTarget(channel, {
        ...target,
        route: { ...target.route, sessionId: 'unstable' },
      }),
      (error) => error?.code === 'invalid-target',
      channel,
    );
  }
});

test('channel-specific route kinds stay strict', () => {
  assert.throws(
    () => normalizeDeliveryTarget('weixin', {
      targetId: 'group', kind: 'group', route: { toUserId: 'wx-user' },
    }),
    (error) => error?.code === 'invalid-target',
  );
  assert.throws(
    () => normalizeDeliveryTarget('telegram', {
      targetId: 'topic', kind: 'topic', route: { chatId: '-100', messageThreadId: '42' },
    }),
    (error) => error?.code === 'invalid-target',
  );
  assert.throws(
    () => normalizeDeliveryTarget('whatsapp', {
      targetId: 'broadcast', kind: 'group', route: { jid: 'status@broadcast' },
    }),
    (error) => error?.code === 'invalid-target',
  );
});
