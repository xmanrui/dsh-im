import assert from 'node:assert/strict';
import test from 'node:test';

import { parseConversationKey } from '../src/channels/shared/conversation/describe.mjs';
import { createDeliveryAdapter } from '../plugin-src/host/delivery-adapter.mjs';

/** Minimal workspace store: only the calls describeConversationBySession makes. */
function fakeWorkspaces(botIds) {
  return {
    listBotIds: () => [...botIds],
    has: (botId) => botIds.includes(botId),
  };
}

function fakeState(sessionsByBot) {
  return async (botId) => {
    const sessions = sessionsByBot[botId];
    if (!sessions) throw new Error(`no state for ${botId}`);
    return { snapshot: () => ({ sessions }) };
  };
}

function adapterWith({ botIds = ['botA'], sessionsByBot, accounts = {}, loaded = null, stats = { loads: 0 } }) {
  return createDeliveryAdapter({
    channel: 'telegram',
    workspaces: fakeWorkspaces(botIds),
    coreController: {
      describeDeliveryAccount: async (botId) => accounts[botId] ?? { name: null },
    },
    stateFor: (botId) => {
      stats.loads += 1;
      return fakeState(sessionsByBot)(botId);
    },
    // `loaded` is the memo of states already in memory; null means nothing is.
    ...(loaded === null ? {} : { stateForSync: (botId) => loaded[botId] ?? null }),
  });
}

test('a group without a thread yields the chat id only', () => {
  assert.deepEqual(parseConversationKey('group:-1004337494578'), {
    chatType: 'group', chatId: '-1004337494578', threadId: null, senderId: null,
  });
});

test('a telegram forum topic yields chat id and thread id', () => {
  assert.deepEqual(parseConversationKey('group:-1004337494578:64'), {
    chatType: 'thread', chatId: '-1004337494578', threadId: '64', senderId: null,
  });
});

test('a feishu thread keeps both ids', () => {
  assert.deepEqual(parseConversationKey('group:oc_abc:thread:om_1'), {
    chatType: 'thread', chatId: 'oc_abc', threadId: 'om_1', senderId: null,
  });
});

test('a matrix room thread splits on the dollar sign', () => {
  assert.deepEqual(parseConversationKey('group:room:!a:x.org$$root:y.org'), {
    chatType: 'thread', chatId: '!a:x.org', threadId: '$root:y.org', senderId: null,
  });
});

test('a telegram direct chat carries the sender id', () => {
  assert.deepEqual(parseConversationKey('direct:161161619', { channel: 'telegram' }), {
    chatType: 'dm', chatId: '161161619', threadId: null, senderId: '161161619',
  });
});

test('a matrix direct chat keeps the whole user id, colons included', () => {
  assert.deepEqual(parseConversationKey('direct:dm:@alice:example.org', { channel: 'matrix' }), {
    chatType: 'dm', chatId: null, threadId: null, senderId: '@alice:example.org',
  });
});

test('p2p and c2c private keys name the sender', () => {
  for (const [key, channel, id] of [
    ['p2p:ou_abc', 'feishu', 'ou_abc'],
    ['p2p:wxid_1', 'weixin', 'wxid_1'],
    ['c2c:OPENID1', 'qq', 'OPENID1'],
  ]) {
    assert.deepEqual(parseConversationKey(key, { channel }), {
      chatType: 'dm', chatId: null, threadId: null, senderId: id,
    }, key);
  }
});

test('a direct key that names a dm channel is never reported as a user', () => {
  for (const [key, channel, id] of [
    ['direct:D123', 'slack', 'D123'],
    ['direct:998877', 'discord', '998877'],
    ['direct:123@s.whatsapp.net', 'whatsapp', '123@s.whatsapp.net'],
    ['direct:D123', undefined, 'D123'],
  ]) {
    assert.deepEqual(parseConversationKey(key, { channel }), {
      chatType: 'dm', chatId: id, threadId: null, senderId: null,
    }, `${channel}: ${key}`);
  }
});

test('an unknown shape is not guessed', () => {
  for (const key of [null, undefined, '', 'group:', 'direct:', 'channel:1', 42]) {
    assert.equal(parseConversationKey(key), null, `expected null for ${String(key)}`);
  }
});

test('the adapter finds the conversation that owns a session', async () => {
  const adapter = adapterWith({
    sessionsByBot: { botA: { 'group:-100:64': 'session-1' } },
    accounts: { botA: { name: 'DSH Assistant' } },
  });
  const described = await adapter.describeConversationBySession('session-1');
  assert.equal(described.channel, 'telegram');
  assert.equal(described.botId, 'botA');
  assert.equal(described.botName, 'DSH Assistant');
  assert.equal(described.conversationKey, 'group:-100:64');
  assert.equal(described.chatType, 'thread');
  assert.equal(described.chatId, '-100');
  assert.equal(described.threadId, '64');
  assert.equal(described.senderId, null);
});

test('an unknown session is null, not an error', async () => {
  const adapter = adapterWith({ sessionsByBot: { botA: { 'group:-100': 'session-1' } } });
  assert.equal(await adapter.describeConversationBySession('session-other'), null);
  assert.equal(await adapter.describeConversationBySession(''), null);
  assert.equal(await adapter.describeConversationBySession(undefined), null);
});

test('a channel whose state cannot be read does not break the lookup', async () => {
  const adapter = adapterWith({ botIds: ['broken', 'botA'], sessionsByBot: { botA: { 'direct:1': 'session-9' } } });
  const described = await adapter.describeConversationBySession('session-9');
  assert.equal(described.botId, 'botA');
  assert.equal(described.chatType, 'dm');
  assert.equal(described.senderId, '1');
});

test('a missing account name does not throw', async () => {
  const adapter = createDeliveryAdapter({
    channel: 'telegram',
    workspaces: fakeWorkspaces(['botA']),
    coreController: {},
    stateFor: fakeState({ botA: { 'group:1': 'session-1' } }),
  });
  const described = await adapter.describeConversationBySession('session-1');
  assert.equal(described.botName, null);
  assert.equal(described.chatId, '1');
});

// --- persisted authors -------------------------------------------------------

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationStateStore } from '../src/channels/shared/conversation-state-store.mjs';

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-authors-'));
  try {
    return await run(join(dir, 'state.json'), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a conversation without an inbound message has no author', async () => {
  await withStore(async (file) => {
    const store = new ConversationStateStore(file);
    await store.load();
    await store.setSession('group:-100', 'session-1');
    assert.equal(store.authorFor('group:-100'), null);
  });
});

test('an inbound message records the author and it survives a reload', async () => {
  await withStore(async (file) => {
    const store = new ConversationStateStore(file);
    await store.load();
    await store.setSession('group:-100:7', 'session-1');
    await store.rememberAuthor('group:-100:7', {
      senderId: '781', senderName: 'Marish', senderUsername: 'marish', isBot: false,
    });

    const persisted = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(persisted.authors['group:-100:7'].senderId, '781');
    assert.equal(persisted.authors['group:-100:7'].senderName, 'Marish');

    const reopened = new ConversationStateStore(file);
    await reopened.load();
    assert.deepEqual(reopened.authorFor('group:-100:7'), {
      senderId: '781', senderName: 'Marish', senderUsername: 'marish', isBot: false,
      at: persisted.authors['group:-100:7'].at,
    });
  });
});

test('a new message overwrites the previous author without keeping text', async () => {
  await withStore(async (file) => {
    const store = new ConversationStateStore(file);
    await store.load();
    await store.rememberAuthor('group:-100', { senderId: '1', senderName: 'One' });
    await store.rememberAuthor('group:-100', { senderId: '2', isBot: true, text: 'must not persist' });
    const author = store.authorFor('group:-100');
    assert.equal(author.senderId, '2');
    assert.equal(author.isBot, true);
    assert.equal(author.senderName, undefined);
    assert.equal(author.text, undefined);
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(JSON.stringify(persisted.authors).includes('must not persist'), false);
  });
});

test('the adapter reports the group sender once the bridge recorded it', async () => {
  const adapter = createDeliveryAdapter({
    channel: 'telegram',
    workspaces: fakeWorkspaces(['botA']),
    coreController: {},
    stateFor: async () => ({
      snapshot: () => ({
        sessions: { 'group:-100:7': 'session-1' },
        authors: {
          'group:-100:7': { senderId: '781', senderName: 'Marish', senderUsername: 'marish', isBot: false },
        },
      }),
    }),
  });
  const described = await adapter.describeConversationBySession('session-1');
  assert.equal(described.chatId, '-100');
  assert.equal(described.threadId, '7');
  assert.equal(described.senderId, '781');
  assert.equal(described.senderName, 'Marish');
  assert.equal(described.senderUsername, 'marish');
  assert.equal(described.senderIsBot, false);
});

test('a recorded bot sender is flagged, and a direct chat keeps its key sender', async () => {
  const adapter = createDeliveryAdapter({
    channel: 'telegram',
    workspaces: fakeWorkspaces(['botA']),
    coreController: {},
    stateFor: async () => ({
      snapshot: () => ({
        sessions: { 'group:-1': 'session-a', 'direct:161161619': 'session-b' },
        authors: { 'group:-1': { senderId: '42', isBot: true } },
      }),
    }),
  });
  const group = await adapter.describeConversationBySession('session-a');
  assert.equal(group.senderIsBot, true);
  assert.equal(group.senderName, null);
  const direct = await adapter.describeConversationBySession('session-b');
  assert.equal(direct.senderId, '161161619');
  assert.equal(direct.senderIsBot, null);
});

test('the synchronous lookup answers from states already in memory', () => {
  const loaded = { botA: { snapshot: () => ({ sessions: { 'group:-100:64': 'session-1' }, authors: {} }) } };
  const stats = { loads: 0 };
  const adapter = adapterWith({
    sessionsByBot: { botA: { 'group:-100:64': 'session-1' } },
    loaded,
    stats,
  });
  const described = adapter.describeConversationBySessionSync('session-1');
  assert.equal(described.channel, 'telegram');
  assert.equal(described.botId, 'botA');
  assert.equal(described.conversationKey, 'group:-100:64');
  assert.equal(described.threadId, '64');
  assert.equal(described.botName, null, 'a name needs the network, and this lookup never waits');
  assert.equal(stats.loads, 0, 'the sync path must not start a load');
});

test('the synchronous lookup is null when the state was never loaded', () => {
  const stats = { loads: 0 };
  const adapter = adapterWith({ sessionsByBot: { botA: { 'group:-100': 'session-1' } }, stats });
  assert.equal(adapter.describeConversationBySessionSync('session-1'), null);
  assert.equal(stats.loads, 0);
});

test('the synchronous lookup skips a bot whose state throws', () => {
  const loaded = {
    broken: { snapshot: () => { throw new Error('boom'); } },
    botA: { snapshot: () => ({ sessions: { 'direct:1': 'session-9' }, authors: { 'direct:1': { senderId: '1' } } }) },
  };
  const adapter = adapterWith({ botIds: ['broken', 'botA'], sessionsByBot: {}, loaded });
  const described = adapter.describeConversationBySessionSync('session-9');
  assert.equal(described.botId, 'botA');
  assert.equal(described.senderId, '1');
});

// --- end to end: normalized inbound -> bridge -> state -> lookup ------------

import { TextHarnessBridge } from '../src/channels/shared/text-harness-bridge.mjs';
import { normalizeTelegramUpdate } from '../src/channels/telegram/telegram-runtime.mjs';
import { CONTEXT_ENHANCEMENT_FIELDS } from '../src/channels/shared/context-enhancement.mjs';

const ENHANCEMENT_ON = {
  botId: 'telegram_internal',
  getSettings: () => ({
    group: { enabled: true, fields: [...CONTEXT_ENHANCEMENT_FIELDS], guidance: '' },
    direct: { enabled: true, fields: [...CONTEXT_ENHANCEMENT_FIELDS], guidance: '' },
  }),
};

for (const enhanced of [false, true]) test(`a normalized telegram message is recorded by the bridge and named by the lookup (enhancement ${enhanced ? 'on' : 'off'})`, async () => {
  await withStore(async (file) => {
    const store = new ConversationStateStore(file);
    await store.load();
    const warnings = [];
    const bridge = new TextHarnessBridge({
      descriptor: { key: 'telegram', label: 'Telegram' },
      state: store,
      bot: { sendText: async () => undefined },
      harness: {
        sessionExists: async () => false,
        createSession: async () => 'session-e2e',
        ask: async () => 'ok',
      },
      ...(enhanced ? { contextEnhancement: ENHANCEMENT_ON } : {}),
      logger: { warn: (...args) => warnings.push(args.join(' ')), error() {} },
    });
    const normalized = normalizeTelegramUpdate({
      update_id: 501,
      message: {
        message_id: 9,
        chat: { id: 781, type: 'private' },
        from: { id: 781, is_bot: false, first_name: 'Marish', username: 'marish' },
        text: 'hello',
      },
    }, { botId: 1, username: 'bot' });
    await bridge.accept(normalized);
    await bridge.waitForIdle?.();
    for (let i = 0; i < 200 && !store.authorFor('direct:781'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(warnings.filter((line) => line.includes('author')), []);
    const author = store.authorFor('direct:781');
    assert.equal(author?.senderId, '781');
    // Names are personal data: kept only when context enhancement read them.
    assert.equal(author?.senderName, enhanced ? 'Marish' : undefined);
    assert.equal(author?.senderUsername, enhanced ? 'marish' : undefined);
    assert.equal(author?.isBot, false);

    const adapter = createDeliveryAdapter({
      channel: 'telegram',
      workspaces: fakeWorkspaces(['botA']),
      coreController: {},
      stateFor: async () => store,
    });
    const described = await adapter.describeConversationBySession('session-e2e');
    assert.equal(described.conversationKey, 'direct:781');
    assert.equal(described.senderId, '781');
    assert.equal(described.senderName, enhanced ? 'Marish' : null);
    assert.equal(described.senderUsername, enhanced ? 'marish' : null);
    assert.equal(described.senderIsBot, false);
  });
});
