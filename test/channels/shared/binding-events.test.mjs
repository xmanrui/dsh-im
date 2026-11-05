import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createAnnouncedStateStore,
  createBindingAnnouncer,
} from '../../../plugin-src/host/channels/shared/binding-events.mjs';

const GROUP_KEY = 'group:-1004337494578:67';
const DIRECT_KEY = 'direct:161161619';

function recorder({ authors = null } = {}) {
  const events = [];
  const announcer = createBindingAnnouncer({
    channel: 'telegram',
    emit: (event, payload) => events.push({ event, payload }),
    authorsOf: () => authors,
  });
  return { announcer, events };
}

/** Minimal state store shaped like the channel one: sessions map, snapshot, setSession. */
function createState(initial = {}) {
  const state = {
    sessions: { ...initial },
    authors: {},
    writes: [],
    async setSession(key, sessionId) {
      state.writes.push([key, sessionId]);
      state.sessions[key] = sessionId;
    },
    async clearSession(key) {
      delete state.sessions[key];
    },
    async clearSessions() {
      state.sessions = {};
    },
    sessionFor(key) {
      return state.sessions[key] ?? null;
    },
    snapshot() {
      return structuredClone({ sessions: state.sessions, authors: state.authors });
    },
  };
  return state;
}

test('a first bind announces only the bind, never an unbind', async () => {
  const { announcer, events } = recorder();
  const state = announcer.wrap('bot_1', createState());

  await state.setSession(GROUP_KEY, 'session-a');

  assert.deepEqual(events.map((entry) => entry.event), ['dsh-im/session-pre-bind']);
  assert.equal(events[0].payload.sessionId, 'session-a');
  assert.equal(events[0].payload.conversationKey, GROUP_KEY);
  assert.equal(events[0].payload.chatType, 'thread');
  assert.equal(events[0].payload.chatId, '-1004337494578');
  assert.equal(events[0].payload.threadId, '67');
  assert.equal(events[0].payload.channel, 'telegram');
  assert.equal(events[0].payload.botId, 'bot_1');
});

test('switching a conversation unbinds the previous session before binding the new one', async () => {
  const { announcer, events } = recorder();
  const state = announcer.wrap('bot_1', createState({ [GROUP_KEY]: 'session-a' }));

  await state.setSession(GROUP_KEY, 'session-b');

  assert.deepEqual(events.map((entry) => entry.event), [
    'dsh-im/session-unbind',
    'dsh-im/session-pre-bind',
  ]);
  assert.equal(events[0].payload.sessionId, 'session-a');
  assert.equal(events[0].payload.conversationKey, GROUP_KEY);
  assert.equal(events[0].payload.threadId, '67');
  assert.equal(events[1].payload.sessionId, 'session-b');
});

test('rewriting the same session is not a switch and announces no unbind', async () => {
  const { announcer, events } = recorder();
  const state = announcer.wrap('bot_1', createState({ [GROUP_KEY]: 'session-a' }));

  await state.setSession(GROUP_KEY, 'session-a');

  assert.deepEqual(events.map((entry) => entry.event), ['dsh-im/session-pre-bind']);
});

test('a refused write announces nothing', async () => {
  const { announcer, events } = recorder();
  const state = createState({ [GROUP_KEY]: 'session-a' });
  state.setSession = async () => false;
  announcer.wrap('bot_1', state);

  const result = await state.setSession(GROUP_KEY, 'session-b');

  assert.equal(result, false);
  assert.deepEqual(events, []);
});

test('clearing one binding unbinds the session it held', async () => {
  const { announcer, events } = recorder();
  const state = announcer.wrap('bot_1', createState({ [GROUP_KEY]: 'session-a', [DIRECT_KEY]: 'session-b' }));

  await state.clearSession(GROUP_KEY);

  assert.deepEqual(events.map((entry) => entry.event), ['dsh-im/session-unbind']);
  assert.equal(events[0].payload.sessionId, 'session-a');
  assert.equal(events[0].payload.conversationKey, GROUP_KEY);
  assert.equal(events[0].payload.chatType, 'thread');
});

test('clearing every binding unbinds each conversation it held', async () => {
  const { announcer, events } = recorder();
  const state = announcer.wrap('bot_1', createState({ [GROUP_KEY]: 'session-a', [DIRECT_KEY]: 'session-b' }));

  await state.clearSessions();

  const unbound = events
    .filter((entry) => entry.event === 'dsh-im/session-unbind')
    .map((entry) => [entry.payload.conversationKey, entry.payload.sessionId])
    .sort();
  assert.deepEqual(unbound, [[DIRECT_KEY, 'session-b'], [GROUP_KEY, 'session-a']].sort());
});

test('the remembered author wins over the key for the sender', async () => {
  const authors = { [GROUP_KEY]: { senderId: '161161619', senderName: 'Dmitry' } };
  const { announcer, events } = recorder({ authors });
  const state = announcer.wrap('bot_1', createState());

  await state.setSession(GROUP_KEY, 'session-a');

  assert.equal(events[0].payload.senderId, '161161619');
  assert.equal(events[0].payload.senderName, 'Dmitry');
});

test('a throwing subscriber does not break the write', async () => {
  const announcer = createBindingAnnouncer({
    channel: 'telegram',
    emit: () => {
      throw new Error('subscriber exploded');
    },
  });
  const state = announcer.wrap('bot_1', createState({ [GROUP_KEY]: 'session-a' }));

  await state.setSession(GROUP_KEY, 'session-b');

  assert.equal(state.sessions[GROUP_KEY], 'session-b');
});

test('wrapping the same store twice keeps the first wrapper', async () => {
  const { announcer, events } = recorder();
  const state = announcer.wrap('bot_1', createState());
  const again = announcer.wrap('bot_1', state);

  assert.equal(again, state);
  await state.setSession(GROUP_KEY, 'session-a');
  assert.deepEqual(events.map((entry) => entry.event), ['dsh-im/session-pre-bind']);
});

/** A store class whose instance is the store itself, like every channel's. */
function createStateStoreClass(instances, { failing = new Set() } = {}) {
  return class StateStore {
    constructor(path, options) {
      this.path = path;
      this.options = options;
      this.sessions = {};
      this.authors = {};
      this.writes = [];
      instances.push(this);
    }

    async load() {
      if (failing.has(this.path)) throw new Error(`cannot read ${this.path}`);
      return this;
    }

    async save() {
      return this;
    }

    sessionFor(key) {
      return this.sessions[key] ?? null;
    }

    snapshot() {
      return structuredClone({ sessions: this.sessions, authors: this.authors });
    }

    async setSession(key, sessionId) {
      this.writes.push([key, sessionId]);
      this.sessions[key] = sessionId;
      return true;
    }

    async clearSession(key) {
      delete this.sessions[key];
      return true;
    }

    async clearSessions() {
      this.sessions = {};
      return true;
    }
  };
}

test('the announced store answers the synchronous lookup only after a prime', async () => {  const instances = [];
  const { announcer } = recorder();
  const { stateFor, stateForSync, prime } = createAnnouncedStateStore({
    announcer,
    StateStore: createStateStoreClass(instances),
    statePath: (botId) => `/tmp/${botId}/state.json`,
  });

  assert.equal(stateForSync('bot_1'), null, 'nothing is loaded before the prime');
  await prime(['bot_1', 'bot_2']);

  const primed = stateForSync('bot_1');
  assert.equal(primed.__announces, true, 'the memo must hold the wrapped store');
  assert.equal(stateForSync('bot_2').__announces, true);
  assert.equal(await stateFor('bot_1'), primed);
  assert.equal(instances.length, 2, 'one load per bot');
});

test('a bind through the announced store reaches the subscriber', async () => {
  const instances = [];
  const { announcer, events } = recorder();
  const { stateFor } = createAnnouncedStateStore({
    announcer,
    StateStore: createStateStoreClass(instances),
    statePath: (botId) => `/tmp/${botId}/state.json`,
  });

  const state = await stateFor('bot_1');
  await state.setSession(GROUP_KEY, 'session-a');
  await state.clearSession(GROUP_KEY);

  assert.deepEqual(events.map((entry) => entry.event), [
    'dsh-im/session-pre-bind',
    'dsh-im/session-unbind',
  ]);
  assert.equal(events[0].payload.botId, 'bot_1');
  assert.equal(events[0].payload.sessionId, 'session-a');
  assert.equal(events[0].payload.chatType, 'thread');
  assert.equal(state.writes.length, 1);
});

test('concurrent loads of one bot share a single store', async () => {
  const instances = [];
  const { announcer } = recorder();
  const { stateFor } = createAnnouncedStateStore({
    announcer,
    StateStore: createStateStoreClass(instances),
    statePath: (botId) => `/tmp/${botId}/state.json`,
  });

  const [first, second] = await Promise.all([stateFor('bot_1'), stateFor('bot_1')]);
  assert.equal(first, second);
  assert.equal(instances.length, 1);
});

test('a bot whose state cannot be read does not fail the prime', async () => {
  const instances = [];
  const { announcer } = recorder();
  const { prime, stateForSync } = createAnnouncedStateStore({
    announcer,
    StateStore: createStateStoreClass(instances, { failing: new Set(['/tmp/broken/state.json']) }),
    statePath: (botId) => `/tmp/${botId}/state.json`,
  });

  const primed = await prime(['healthy', 'broken']);
  assert.deepEqual(primed.map((state) => state === null), [false, true]);
  assert.notEqual(stateForSync('healthy'), null);
  assert.equal(stateForSync('broken'), null);
});

test('the memo key can differ from the subject the channel identifies a bot by', async () => {
  const instances = [];
  const { announcer } = recorder();
  const states = new Map();
  const { stateFor, stateForSync, prime } = createAnnouncedStateStore({
    announcer,
    StateStore: createStateStoreClass(instances),
    statePath: (subject) => `/tmp/${subject.id ?? 'legacy'}/state.json`,
    keyOf: (subject) => (typeof subject === 'string' ? subject : subject?.id ?? '__legacy__'),
    states,
  });

  await prime([{ id: 'bot_1' }, { secretRef: 'legacy' }]);
  assert.equal(states.size, 2);
  assert.equal(stateForSync('bot_1').__announces, true);
  assert.equal(stateForSync('__legacy__').__announces, true);
  assert.equal((await stateFor({ id: 'bot_1' })), states.get('bot_1'));
});

test('the announced store refuses to be built without its pieces', () => {
  const { announcer } = recorder();
  assert.throws(() => createAnnouncedStateStore({ StateStore: class {}, statePath: () => '' }), TypeError);
  assert.throws(() => createAnnouncedStateStore({ announcer, statePath: () => '' }), /StateStore/);
  assert.throws(() => createAnnouncedStateStore({ announcer, StateStore: class {} }), /statePath/);
  assert.throws(() => createAnnouncedStateStore({ announcer, StateStore: class {}, statePath: () => '', states: {} }), /Map/);
});

test('forget drops the memo, including a load that finishes afterwards', async () => {
  const instances = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  class SlowStore {
    constructor(path) {
      this.path = path;
      this.sessions = {};
      instances.push(this);
    }

    async load() {
      await gate;
      return this;
    }

    sessionFor(key) { return this.sessions[key] ?? null; }

    async setSession(key, sessionId) { this.sessions[key] = sessionId; return true; }
  }
  const { announcer } = recorder();
  const { stateFor, stateForSync, forget } = createAnnouncedStateStore({
    announcer,
    StateStore: SlowStore,
    statePath: (botId) => `/tmp/${botId}/state.json`,
  });

  const first = stateFor('bot-1');
  forget('bot-1');
  release();
  const loaded = await first;

  assert.equal(loaded instanceof SlowStore, true, 'the caller still gets the store it asked for');
  assert.equal(stateForSync('bot-1'), null, 'a store that finished after the delete is not memoisd');

  // The next read starts over instead of serving the state of a deleted bot.
  const second = await stateFor('bot-1');
  assert.equal(instances.length, 2, 'the memo was really dropped');
  assert.notEqual(second, loaded);
  assert.equal(stateForSync('bot-1'), second);
});

/**
 * The production half of the contract: a channel with its own controller has to
 * load its state through the announcer and keep the memo the synchronous lookup
 * reads. A channel missing either leaves every one of its sessions unknown to
 * the plugins that assemble a persona - and does so silently.
 */
const ANNOUNCING_CHANNELS = [
  {
    name: 'dingtalk',
    storeModule: '../../../src/channels/dingtalk/state-store.mjs',
    storeExport: 'DingtalkStateStore',
    bot: { botId: 'dt_1', clientId: 'dingclient' },
    conversationKey: 'p2p:staff-1',
    internals: { DeviceAuth: class { constructor() {} } },
  },
  {
    name: 'feishu',
    storeModule: '../../../src/channels/feishu/state-store.mjs',
    storeExport: 'StateStore',
    bot: { id: 'fs_1', secretRef: 'DSH_FEISHU_APP_SECRET_FS1' },
    botId: 'fs_1',
    conversationKey: 'p2p:ou_1',
    internals: { lark: { defaultHttpInstance: {} }, verifyFeishuApp: async () => ({}) },
  },
  {
    name: 'matrix',
    storeModule: '../../../src/channels/shared/conversation-state-store.mjs',
    storeExport: 'ConversationStateStore',
    bot: { botId: 'mx_1' },
    conversationKey: 'group:room:!room:example.org',
    internals: {
      SidecarStore: class { async load() { return {}; } },
      CryptoStore: class { async load() { return {}; } },
      RoomHistoryStore: class { async load() { return {}; } },
    },
  },
  {
    name: 'qq',
    storeModule: '../../../src/channels/qq/state-store.mjs',
    storeExport: 'QqStateStore',
    bot: { botId: 'qq_1' },
    conversationKey: 'c2c:openid-1',
    internals: { QrAuth: class { constructor() {} } },
  },
  {
    name: 'slack',
    storeModule: '../../../src/channels/slack/state-store.mjs',
    storeExport: 'SlackStateStore',
    bot: { botId: 'sl_1' },
    conversationKey: 'group:C0123ABC',
  },
  {
    name: 'wecom',
    storeModule: '../../../src/channels/wecom/state-store.mjs',
    storeExport: 'WecomStateStore',
    bot: { botId: 'wc_1' },
    conversationKey: 'p2p:zhangsan',
    internals: { QrAuth: class { constructor() {} } },
  },
  {
    name: 'wecom-app',
    storeModule: '../../../src/channels/wecom-app/state-store.mjs',
    storeExport: 'WecomAppStateStore',
    bot: { botId: 'wca_1' },
    conversationKey: 'p2p:zhangsan',
    internals: {
      callbackServer: {
        listening: false,
        registerRoute() {},
        unregisterRoute() {},
        routeCount() { return 0; },
        routePath() { return '/callback'; },
      },
    },
  },
  {
    name: 'weixin',
    storeModule: '../../../src/channels/weixin/state-store.mjs',
    storeExport: 'WeixinStateStore',
    bot: { botId: 'wx_1' },
    conversationKey: 'p2p:o9cq@im.wechat',
    internals: { api: { beginLogin() {}, pollLogin() {} } },
  },
  {
    name: 'whatsapp',
    storeModule: '../../../src/channels/whatsapp/state-store.mjs',
    storeExport: 'WhatsappStateStore',
    bot: { botId: 'wa_1' },
    conversationKey: 'direct:16505550123@s.whatsapp.net',
    internals: { createSession: async () => ({}) },
  },
];

for (const channel of ANNOUNCING_CHANNELS) {
  test(`${channel.name} production loads its state through the announcer`, async (t) => {
    const { createProductionController } = await import(
      `../../../plugin-src/host/channels/${channel.name}/production.mjs`);
    const dataDir = await mkdtemp(join(tmpdir(), `dsh-${channel.name}-binding-`));
    t.after(() => rm(dataDir, { recursive: true, force: true }));

    // The wrapper is a no-op on a store without `setSession` - the channel would
    // then keep every session unknown, silently. Bind the real class, not only the
    // fake one the production is handed below.
    const RealStore = (await import(channel.storeModule))[channel.storeExport];
    assert.equal(typeof RealStore, 'function', `${channel.name}: real store class is exported`);
    assert.equal(typeof RealStore.prototype.setSession, 'function',
      `${channel.name}: the real store must expose setSession, or the wrapper does nothing`);
    assert.equal(typeof RealStore.prototype.sessionFor, 'function',
      `${channel.name}: the real store must expose sessionFor for the unbind bookkeeping`);

    const botId = channel.botId ?? channel.bot.botId;
    const instances = [];
    const StateStore = createStateStoreClass(instances);
    const events = [];
    class ConfigStore {
      constructor(path) { this.path = path; }
      async load() { return this; }
      list() { return [channel.bot]; }
      get(id) { return id === botId ? channel.bot : null; }
    }
    class Harness { stopManagedProcess() {} }
    class Controller {
      constructor(options) { this.options = options; }
      async close() {}
    }
    class Runtime { constructor(options) { Object.assign(this, options ?? {}); } }
    const ctx = {
      credentials: {},
      typertGateway: { invoke() {}, stream() {} },
      logger: () => ({ error() {}, warn() {}, info() {}, debug() {} }),
      emit: (event, payload) => events.push({ event, payload }),
    };
    const production = await createProductionController(ctx, { dataDir }, {
      ConfigStore,
      StateStore,
      HarnessClient: Harness,
      Controller,
      Runtime,
      createConnectionSupervisor: () => ({
        ready: Promise.resolve(),
        start() { return this; },
        async close() {},
      }),
      ...channel.internals,
    });
    t.after(() => production.close().catch(() => {}));

    assert.equal(instances.length, 1, 'the configured bot is primed at start');
    const state = instances[0];
    assert.equal(state.__announces, true, 'the primed store must be the wrapped one');
    // Only the two binding events are this test's subject: a channel may emit
    // other host events during start-up.
    const bindingEvents = () => events
      .filter((entry) => entry.event === 'dsh-im/session-pre-bind'
        || entry.event === 'dsh-im/session-unbind')
      .map((entry) => [entry.event, entry.payload.sessionId]);

    await state.setSession(channel.conversationKey, 'session-1');
    const bind = events.find((entry) => entry.event === 'dsh-im/session-pre-bind');
    assert.ok(bind, 'a binding written by the production store announces itself');
    assert.equal(bind.payload.channel, channel.name);
    assert.equal(bind.payload.botId, botId);
    assert.equal(bind.payload.conversationKey, channel.conversationKey);
    assert.equal(bind.payload.sessionId, 'session-1');

    // The same memo answers the synchronous lookup the delivery service exposes.
    const described = production.deliveryAdapter?.describeConversationBySessionSync('session-1');
    assert.ok(described, 'the primed memo answers the synchronous lookup');
    assert.equal(described.channel, channel.name);
    assert.equal(described.botId, botId);
    assert.equal(described.conversationKey, channel.conversationKey);

    // A switch is one straight line: the old session is detached before the new one
    // is bound, and the lookup follows the conversation afterwards.
    await state.setSession(channel.conversationKey, 'session-2');
    assert.deepEqual(
      bindingEvents(),
      [
        ['dsh-im/session-pre-bind', 'session-1'],
        ['dsh-im/session-unbind', 'session-1'],
        ['dsh-im/session-pre-bind', 'session-2'],
      ],
    );
    assert.equal(
      production.deliveryAdapter?.describeConversationBySessionSync('session-2')?.botId,
      botId,
      'the memo follows the conversation to the new session',
    );

    // Rewriting the same session is not a switch, and it is announced again: the
    // protocol carries no marker a subscriber could dedupe on by itself.
    await state.setSession(channel.conversationKey, 'session-2');
    assert.deepEqual(
      bindingEvents().slice(-2),
      [
        ['dsh-im/session-pre-bind', 'session-2'],
        ['dsh-im/session-pre-bind', 'session-2'],
      ],
      'a rewritten binding announces the bind again',
    );

    // Clearing the binding detaches the session the conversation held.
    await state.clearSession(channel.conversationKey);
    assert.deepEqual(bindingEvents().slice(-1), [['dsh-im/session-unbind', 'session-2']]);
    assert.equal(
      production.deliveryAdapter?.describeConversationBySessionSync('session-2'),
      null,
      'a cleared conversation no longer answers the lookup',
    );
  });
}
