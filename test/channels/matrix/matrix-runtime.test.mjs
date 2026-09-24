import test, { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deepStrictEqual, equal, match, ok, rejects } from 'node:assert';

import { MatrixRuntime } from '../../../src/channels/matrix/matrix-runtime.mjs';
import { MatrixSidecarStore } from '../../../src/channels/matrix/matrix-config-store.mjs';
import { MatrixApiError } from '../../../src/channels/matrix/matrix-api.mjs';
import { MatrixRoomHistoryStore } from '../../../src/channels/matrix/matrix-room-history.mjs';

const HOME = 'https://matrix.example.org';
const BOT = '@bot:example.org';

const tempDirectories = new Set();

async function makeTempDirectory(prefix) {
  const created = await mkdtemp(join(tmpdir(), prefix));
  tempDirectories.add(created);
  return created;
}

after(async () => {
  for (const directory of tempDirectories) await rm(directory, { recursive: true, force: true });
});

async function eventually(predicate, timeoutOrLabel = 2_000, labelMaybe) {
  const timeoutMs = typeof timeoutOrLabel === 'number' ? timeoutOrLabel : 2_000;
  const label = typeof timeoutOrLabel === 'string' ? timeoutOrLabel : labelMaybe;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let satisfied = false;
    try {
      satisfied = Boolean(predicate());
    } catch {
      satisfied = false;
    }
    if (satisfied) return;
    if (Date.now() > deadline) throw new Error(`condition was never reached in time${label ? `: ${label}` : ''}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function messageEvent({ sender = '@alice:example.org', body = '你好', ts = Date.now(), content = {} } = {}) {
  return {
    type: 'm.room.message',
    event_id: `$e${Math.floor(Math.random() * 1e9).toString(36)}:example.org`,
    sender,
    origin_server_ts: ts,
    content: { msgtype: 'm.text', body, ...content },
  };
}

function createFakeApi({ initial = {}, accountData = {}, memberCounts = {}, overrides = {} } = {}) {
  const calls = [];
  const queue = [];
  const pendings = [];
  const fake = {
    calls,
    queue,
    whoami: async () => ({ user_id: BOT, device_id: 'DSHDEV' }),
    sync: async ({ since } = {}) => {
      calls.push({ op: 'sync', since: since ?? null });
      if (since === undefined) return structuredClone(initial);
      if (queue.length > 0) {
        const item = queue.shift();
        if (item.error) throw item.error;
        return item.batch;
      }
      return await new Promise((resolve, reject) => { pendings.push({ resolve, reject }); });
    },
    getAccountData: async (type) => accountData[type] ?? {},
    setAccountData: async (type, body) => {
      accountData[type] = structuredClone(body);
      calls.push({ op: 'accountData', type });
      return {};
    },
    sendEvent: async (roomId, type, content) => {
      calls.push({ op: 'send', roomId, type, content });
      return { event_id: `$sent-${calls.length}:example.org` };
    },
    setTyping: async (roomId) => {
      calls.push({ op: 'typing', roomId });
      return {};
    },
    sendReceipt: async () => ({}),
    joinRoom: async (roomId) => {
      calls.push({ op: 'join', roomId });
      return { room_id: roomId };
    },
    leaveRoom: async (roomId) => {
      calls.push({ op: 'leave', roomId });
      return {};
    },
    createRoom: async (body) => {
      calls.push({ op: 'createRoom', body });
      return { room_id: '!created:example.org' };
    },
    redactEvent: async () => ({}),
    listRelations: async () => ({ events: [] }),
    getRoomStateEvent: async () => null,
    getJoinedMemberCount: async (roomId) => memberCounts[roomId] ?? null,
    uploadMedia: async () => 'mxc://media.example.org/up1',
    downloadContent: async () => null,
    drainPendings: () => {
      for (const pending of pendings.splice(0)) pending.reject(new Error('test teardown'));
    },
  };
  return Object.assign(fake, overrides);
}

function harnessStub(answer = '好的') {
  const prompts = [];
  return {
    prompts,
    ensureRunning: async () => true,
    sessionExists: async () => false,
    createSession: async () => 'sess-matrix-1',
    ask: async (...args) => {
      const text = args.find((entry) => typeof entry === 'string' && !entry.startsWith('sess-')) ?? '';
      prompts.push(text);
      return answer;
    },
    stopManagedProcess: () => undefined,
  };
}

function stateStub() {
  const seen = new Set();
  const sessions = new Map();
  return {
    seen,
    sessions,
    hasSeen: (id) => seen.has(id),
    markSeen: async (id) => {
      seen.add(id);
    },
    sessionFor: (key) => sessions.get(key) ?? null,
    getSession: (key) => sessions.get(key) ?? null,
    setSession: async (key, id) => {
      sessions.set(key, id);
    },
    clearSession: async (key) => {
      sessions.delete(key);
    },
    snapshot: () => ({ seenMessageIds: [...seen].slice(-50), sessions: Object.fromEntries(sessions) }),
  };
}

function loggerStub() {
  const warnings = [];
  const errors = [];
  return {
    warnings,
    errors,
    info: () => undefined,
    debug: () => undefined,
    warn: (...args) => { warnings.push(args.map((entry) => String(entry?.message ?? entry)).join(' ')); },
    error: (...args) => { errors.push(args.map((entry) => String(entry?.message ?? entry)).join(' ')); },
  };
}

async function createContext(options = {}) {
  const directory = await makeTempDirectory('dsh-im-matrix-runtime-');
  const sidecar = await new MatrixSidecarStore(join(directory, 'matrix.json')).load();
  const state = stateStub();
  const logger = loggerStub();
  const harness = options.harness ?? harnessStub();
  const fake = options.api ?? createFakeApi(options.apiOptions ?? {});
  const accessPolicy = options.accessPolicy ?? {
    getSettings: () => ({
      direct: { mode: 'open', open: { defaultCanExecuteCommands: true, commandPermissionOverrides: [] }, allowlist: { users: [] } },
      group: { mode: 'open', open: { defaultCanExecuteCommands: true, commandPermissionOverrides: [] }, allowlist: { users: [] } },
    }),
  };
  const runtime = new MatrixRuntime({
    config: {
      botId: `matrix_${'a'.repeat(24)}`,
      name: 'Matrix 测试',
      homeserver: HOME,
      userId: BOT,
      ...(options.config ?? {}),
    },
    accessToken: 'syt_token',
    harness,
    state,
    sidecar,
    roomHistory: options.roomHistory ?? null,
    accessPolicy,
    logger,
    createApi: () => fake,
    cryptoStore: options.cryptoStore ?? null,
    createCrypto: options.createCrypto ?? null,
    isKnownCommand: options.isKnownCommand ?? (() => false),
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await runtime.stop();
    fake.drainPendings?.();
  };
  return { runtime, fake, sidecar, state, logger, harness, stop };
}

const sentMessages = (fake) => fake.calls.filter((call) => call.op === 'send' && call.type === 'm.room.message');
const sentReactions = (fake) => fake.calls.filter((call) => call.op === 'send' && call.type === 'm.reaction');
const deliveredAnswers = (fake, answer) => sentMessages(fake).some((call) =>
  call.content['m.new_content']?.body === answer || call.content.body === answer);

test('a two-member room stays an ordinary room: unaddressed chatter is ignored and only a mention answers', async () => {
  const plain = messageEvent({ sender: '@carol:example.org', body: '二人小群的闲聊' });
  const mentioned = messageEvent({
    sender: '@carol:example.org',
    body: '帮帮我 <@BOT:Example.org>',
    content: { 'm.mentions': { user_ids: ['@Bot:Example.org'] } },
  });
  const context = await createContext({
    apiOptions: {
      memberCounts: { '!group:example.org': 2 },
      initial: {
        next_batch: 'b0',
        rooms: { join: { '!group:example.org': { timeline: { events: [plain, mentioned] } } } },
      },
    },
  });
  try {
    await context.runtime.start();
    await eventually(() => deliveredAnswers(context.fake, '好的'));
    deepStrictEqual(context.runtime.status.messagesReceived, 1,
      'the joined member count alone must not classify the room as a direct chat');
    deepStrictEqual(context.sidecar.dmRooms().includes('!group:example.org'), false);
    ok(sentMessages(context.fake).every((call) => call.roomId === '!group:example.org'));
  } finally {
    await context.stop();
  }
});

test('a room the retired member-count rule had recorded as a direct chat is forgotten on load', async () => {
  const plain = messageEvent({ sender: '@carol:example.org', body: '群里随口一句' });
  const context = await createContext({
    apiOptions: {
      initial: {
        next_batch: 'b0',
        rooms: { join: { '!group:example.org': { timeline: { events: [plain] } } } },
      },
    },
  });
  try {
    await context.sidecar.apply({ dmRooms: ['!group:example.org'], joinedRooms: ['!group:example.org'] });
    await context.runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 160));
    deepStrictEqual(context.runtime.status.messagesReceived, 0,
      'the stale direct-chat record alone must not let unaddressed room chatter through the gate');
    deepStrictEqual(context.sidecar.dmRooms().includes('!group:example.org'), false,
      'the stale direct-chat record is dropped once the runtime persists its classification again');
  } finally {
    await context.stop();
  }
});

test('an invite whose membership event carries is_direct registers a direct room', async () => {
  const context = await createContext({
    apiOptions: {
      initial: {
        next_batch: 'b0',
        rooms: {
          invite: {
            '!dm-invite:example.org': {
              invite_state: { events: [{
                type: 'm.room.member',
                sender: '@owner:example.org',
                state_key: '@bot:example.org',
                content: { membership: 'invite', is_direct: true },
              }] },
            },
          },
        },
      },
    },
  });
  try {
    await context.runtime.start();
    await eventually(() => context.sidecar.dmRooms().includes('!dm-invite:example.org'),
      'the authoritative is_direct invite registers the room as a direct chat');
  } finally {
    await context.stop();
  }
});
test('the DM round trip reaches the harness and streams the answer with typing, preview and reaction', async () => {
  const event = messageEvent();
  const context = await createContext({
    apiOptions: {
      initial: {
        next_batch: 's2178_1',
        rooms: {
          join: {
            '!dm:example.org': { timeline: { events: [event] } },
            '!group:example.org': { timeline: { events: [messageEvent({ sender: '@carol:example.org', body: '闲聊' })] } },
          },
        },
      },
      accountData: { 'm.direct': { '@alice:example.org': ['!dm:example.org'] } },
    },
  });
  try {
    await context.runtime.start();
    ok(context.runtime.status.ready);
    deepStrictEqual(context.sidecar.nextBatch(), 's2178_1', 'the sync cursor is persisted as soon as it advances');
    await eventually(() => deliveredAnswers(context.fake, '好的'));
    deepStrictEqual(context.runtime.status.messagesReceived, 1,
      'the unaddressed group chatter never reaches the bridge');
    ok(sentMessages(context.fake).every((call) => call.roomId === '!dm:example.org'));
    ok(sentMessages(context.fake).some((call) => call.content.body === '正在处理…'),
      'the stream preview message is sent before the harness answers');
    ok(sentReactions(context.fake).length >= 1, 'status reactions ride the processing lifecycle');
    ok(context.fake.calls.some((call) => call.op === 'typing' && call.roomId === '!dm:example.org'));
    deepStrictEqual(context.harness.prompts.length, 1, 'exactly one prompt reached the harness');
    ok(context.harness.prompts[0].includes('你好'));
  } finally {
    await context.stop();
  }
});

test('group messages pass only with authoritative mentions and threads keep their conversation identity', async () => {
  const plain = messageEvent({ sender: '@carol:example.org', body: '安静' });
  const mentioned = messageEvent({
    sender: '@carol:example.org',
    body: '帮帮我 <@BOT:Example.org>',
    content: { 'm.mentions': { user_ids: ['@Bot:Example.org'] } },
  });
  const context = await createContext({
    apiOptions: {
      initial: {
        next_batch: 'b0',
        rooms: { join: { '!group:example.org': { timeline: { events: [plain, mentioned] } } } },
      },
    },
  });
  try {
    await context.runtime.start();
    await eventually(() => deliveredAnswers(context.fake, '好的'));
    deepStrictEqual(context.runtime.status.messagesReceived, 1);
    const answer = sentMessages(context.fake).find((call) =>
      call.content['m.new_content']?.body === '好的');
    ok(answer.roomId === '!group:example.org');
    ok(context.fake.calls.some((call) => call.op === 'typing'));
  } finally {
    await context.stop();
  }
});

test('threaded mentions answer inside the thread with a thread relation on the wire', async () => {
  const threaded = messageEvent({
    body: '跟进 <@bot:example.org>',
    content: {
      'm.mentions': { user_ids: ['@bot:example.org'] },
      'm.relates_to': { chain: [{ event_id: '$thr1:example.org', rel_type: 'm.thread' }] },
    },
  });
  const context = await createContext({
    apiOptions: {
      initial: {
        next_batch: 'b0',
        rooms: { join: { '!group:example.org': { timeline: { events: [threaded] } } } },
      },
    },
  });
  try {
    await context.runtime.start();
    await eventually(() => sentMessages(context.fake).some((call) => {
      if (call.content['m.new_content']?.body !== '好的') return false;
      const relates = call.content['m.relates_to'] ?? {};
      const chain = Array.isArray(relates.chain) ? relates.chain : [];
      return chain.some((entry) => entry?.event_id === '$thr1:example.org' && entry?.rel_type === 'm.thread')
        || (relates.event_id === '$thr1:example.org' && relates.rel_type === 'm.thread');
    }));
  } finally {
    await context.stop();
  }
});

test('edits, notices, encrypted payloads and bot traffic are all dropped without touching the harness', async () => {
  const context = await createContext({
    apiOptions: {
      initial: {
        next_batch: 'b0',
        rooms: {
          join: {
            '!group:example.org': {
              state: { events: [{ type: 'm.room.encryption', sender: BOT, content: { algorithm: 'm.megolm.v1_aes_sha2' } }] },
              timeline: {
                events: [
                  { type: 'm.room.encrypted', event_id: '$enc1:x', sender: '@alice:example.org', content: { algorithm: 'm.megolm.v1_aes_sha2' } },
                  messageEvent({ body: '已修改', content: { 'm.relates_to': { rel_type: 'm.replace' }, 'm.new_content': { body: 'x' } } }),
                  messageEvent({ body: '公告', content: { msgtype: 'm.notice' } }),
                  messageEvent({ sender: '@_github:x.org', body: '<@bot:example.org> 机器人噪音' }),
                ],
              },
            },
          },
        },
      },
    },
  });
  try {
    await context.runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    deepStrictEqual(context.runtime.status.messagesReceived, 0);
    deepStrictEqual(sentMessages(context.fake).length, 0);
    deepStrictEqual(context.runtime.status.encryptedRoomsSeen, 1);
    ok(context.logger.warnings.some((line) => line.includes('端到端加密')),
      'the encrypted-room degradation notice is surfaced once, visibly');
  } finally {
    await context.stop();
  }
});

test('the dedupe ring swallows replayed events inside one runtime lifetime', async () => {
  const replay = messageEvent({ body: '<@bot:example.org> 重放' });
  const api = createFakeApi({
    initial: { next_batch: 'b1', rooms: { join: { '!group:example.org': { timeline: { events: [replay, replay] } } } } },
  });
  const context = await createContext({ api });
  try {
    await context.runtime.start();
    await eventually(() => deliveredAnswers(context.fake, '好的'));
    deepStrictEqual(context.runtime.status.messagesReceived, 1, 'the second copy dedupes away in the ring');
    ok(context.state.seen.has(replay.event_id));
  } finally {
    await context.stop();
  }
});

test('invites honor the access policy, decline dead rooms permanently and respect the all mode', async () => {
  const inviteState = (sender, { isDirect = false } = {}) => ({
    '!inv:example.org': {
      invite_state: { events: [{
        type: 'm.room.member',
        sender,
        content: { membership: 'invite', ...(isDirect ? { is_direct: true } : {}) },
        state_key: '@victim:example.org',
      }] },
    },
  });
  const allowlisted = {
    getSettings: () => ({
      direct: { mode: 'allowlist', allowlist: { users: [{ id: '@Owner:Example.org' }] } },
      group: { mode: 'allowlist', allowlist: { users: [] } },
    }),
  };
  const denied = await createContext({
    accessPolicy: allowlisted,
    apiOptions: { initial: { next_batch: 'b0', rooms: { invite: inviteState('@stranger:evil.org') } } },
  });
  try {
    await denied.runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    deepStrictEqual(denied.fake.calls.filter((call) => call.op === 'join'), []);
    ok(denied.logger.warnings.some((line) => line.includes('拒绝了')),
      'an unauthorized invite is refused with a visible note');
  } finally {
    await denied.stop();
  }

  const joined = await createContext({
    accessPolicy: allowlisted,
    apiOptions: { initial: { next_batch: 'b0', rooms: { invite: inviteState('@owner:example.org') } } },
  });
  try {
    await joined.runtime.start();
    await eventually(() => joined.fake.calls.some((call) => call.op === 'join' && call.roomId === '!inv:example.org'));
    await eventually(() => joined.sidecar.dmRoomByUser()['@owner:example.org'] === '!inv:example.org');
    deepStrictEqual(joined.sidecar.dmRoomByUser()['@owner:example.org'], '!inv:example.org',
      'the inviter gains a cached room so outbound replies route there');
    deepStrictEqual(joined.sidecar.dmRooms().includes('!inv:example.org'), false,
      'an invite without an authoritative direct flag stays an ordinary room, so the mention gate keeps applying');
  } finally {
    await joined.stop();
  }

  const dead = await createContext({
    accessPolicy: allowlisted,
    apiOptions: {
      initial: { next_batch: 'b0', rooms: { invite: inviteState('@owner:example.org') } },
      overrides: {
        joinRoom: async () => { throw new Error('404 no servers were found'); },
      },
    },
  });
  try {
    await dead.runtime.start();
    await eventually(() => dead.fake.calls.some((call) => call.op === 'leave' && call.roomId === '!inv:example.org')
      && dead.sidecar.isDeclined('!inv:example.org'));
    ok(dead.sidecar.isDeclined('!inv:example.org'), 'a dead room is remembered as declined');
  } finally {
    await dead.stop();
  }

  const skipped = await createContext({
    accessPolicy: allowlisted,
    apiOptions: { initial: { next_batch: 'b0', rooms: { invite: inviteState('@owner:example.org') } } },
  });
  await skipped.sidecar.apply({ declinedRooms: ['!inv:example.org'] });
  try {
    await skipped.runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    deepStrictEqual(skipped.fake.calls.filter((call) => call.op === 'join' || call.op === 'leave'), [],
      'declined rooms are never re-contacted');
  } finally {
    await skipped.stop();
  }

  const wildcard = await createContext({
    config: { autoJoinInvites: 'all' },
    apiOptions: {
      initial: { next_batch: 'b0', rooms: { invite: { '!inv:example.org': { invite_state: { events: [] } } } } },
    },
  });
  try {
    await wildcard.runtime.start();
    await eventually(() => wildcard.fake.calls.some((call) => call.op === 'join' && call.roomId === '!inv:example.org'));
  } finally {
    await wildcard.stop();
  }
});

test('password boot logs in through the module fetch path and keeps the server-assigned device', async () => {
  const directory = await makeTempDirectory('dsh-im-matrix-runtime-');
  const sidecar = await new MatrixSidecarStore(join(directory, 'matrix.json')).load();
  const logger = loggerStub();
  const loginCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    loginCalls.push({ url: String(url), ...init });
    return new Response(JSON.stringify({
      access_token: 'syt_from_login',
      user_id: '@bot:example.org',
      device_id: 'SRVDEV',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const fake = createFakeApi({ initial: { next_batch: 'b0', rooms: {} } });
  const runtime = new MatrixRuntime({
    config: { botId: `matrix_${'b'.repeat(24)}`, homeserver: HOME, userId: '@bot:example.org', deviceId: 'CFGDEV' },
    password: 'sekret',
    harness: harnessStub(),
    state: stateStub(),
    sidecar,
    logger,
    createApi: () => fake,
  });
  try {
    await runtime.start();
    ok(runtime.status.ready, 'the password flow reaches ready through the real login helper');
    deepStrictEqual(loginCalls.length, 1);
    match(loginCalls[0].url, /\/_matrix\/client\/v3\/login$/u);
    deepStrictEqual(JSON.parse(loginCalls[0].body).type, 'm.login.password');
    ok(logger.warnings.some((line) => line.includes('device_id')),
      'the configured-vs-server device drift is surfaced, never silently overridden');
    ok(logger.warnings.some((line) => line.includes('令牌') && line.includes('设备')),
      'the whoami-verified device identity mismatch is reported in the drift warning');
  } finally {
    globalThis.fetch = originalFetch;
    await runtime.stop();
    fake.drainPendings();
  }
});

test('sync failures re-arm through reconnect on permanent walls and keep retrying transient ones', async () => {
  const api = createFakeApi({ initial: { next_batch: 'b0', rooms: {} } });
  api.queue.push({ error: new MatrixApiError('token revoked', { code: 'matrix-auth', permanent: true, status: 401 }) });
  const context = await createContext({ api });
  try {
    await context.runtime.start();
    await eventually(() => context.runtime.status.connectionState === 'failed');
    deepStrictEqual(context.runtime.status.lastError?.code, 'matrix-auth');
    ok(context.logger.warnings.some((line) => line.includes('permanent')),
      'the permanent auth wall is logged before the supervisor handover');
  } finally {
    await context.stop();
  }

  const flaky = createFakeApi({ initial: { next_batch: 'b0', rooms: {} } });
  flaky.queue.push({ error: new Error('socket reset by peer') });
  const flakyContext = await createContext({ api: flaky });
  try {
    await flakyContext.runtime.start();
    await eventually(() => flakyContext.logger.warnings.some((line) => line.includes('retrying')));
    deepStrictEqual(flakyContext.runtime.status.connectionState, 'connected',
      'a transient blip keeps the loop alive instead of failing the bot');
  } finally {
    await flakyContext.stop();
  }
});

test('bang commands resolve only through the known command catalog', async () => {
  const bang = messageEvent({ body: '!new', content: {} });
  const unknown = messageEvent({ body: '!deploy', content: {} });
  const context = await createContext({
    isKnownCommand: (name) => ['new', 'compact', 'help', 'stop'].includes(name.replace(/^\/+/, '')),
    apiOptions: {
      initial: {
        next_batch: 'b0',
        rooms: { join: { '!dm:example.org': { timeline: { events: [bang, unknown] } } } },
      },
      accountData: { 'm.direct': { '@alice:example.org': ['!dm:example.org'] } },
    },
  });
  try {
    await context.runtime.start();
    await eventually(() => sentMessages(context.fake).some((call) => call.content.body?.includes('新会话'))
      && context.harness.prompts.length >= 1);
    deepStrictEqual(context.runtime.status.messagesReceived, 2);
    ok(!context.harness.prompts.some((prompt) => prompt.includes('/new')),
      'a resolved slash command is consumed by the bridge, never forwarded as prose');
    ok(context.harness.prompts.some((prompt) => prompt.includes('!deploy')),
      'an unknown bang token stays verbatim and reaches the harness as prose');
  } finally {
    await context.stop();
  }
});

test('proactive delivery routes rooms directly, creates dm rooms once and rejects bad targets', async () => {
  const context = await createContext({
    apiOptions: { initial: { next_batch: 'b0', rooms: {} } },
  });
  try {
    await context.runtime.start();
    await context.runtime.sendProactiveText({ kind: 'room', route: { roomId: '!group:example.org' } }, '主动消息');
    const roomSend = sentMessages(context.fake).find((call) => call.roomId === '!group:example.org');
    deepStrictEqual(roomSend.content.body, '主动消息');
    deepStrictEqual(roomSend.content['m.relates_to'], undefined, 'plain room sends carry no relation');

    await context.runtime.sendProactiveText({ kind: 'dm', route: { userId: '@newcomer:example.org' } }, '初次见面');
    const created = context.fake.calls.find((call) => call.op === 'createRoom');
    deepStrictEqual(created.body.preset, 'private_chat');
    ok(created.body.is_direct === true && created.body.invite.includes('@newcomer:example.org'));
    deepStrictEqual(context.sidecar.dmRoomByUser()['@newcomer:example.org'], '!created:example.org',
      'the minted dm room is cached for later deliveries');
    ok(sentMessages(context.fake).some((call) => call.roomId === '!created:example.org'
      && call.content.body === '初次见面'));

    await context.runtime.sendProactiveText({ kind: 'dm', route: { userId: '@newcomer:example.org' } }, '再会');
    deepStrictEqual(context.fake.calls.filter((call) => call.op === 'createRoom').length, 1,
      'the cached dm room short-circuits a second create');

    await context.runtime.sendProactiveText({ kind: 'thread', route: { roomId: '!group:example.org', threadId: '$thr1:example.org' } },
      '线内');
    const threadSend = sentMessages(context.fake).find((call) => call.content.body === '线内');
    deepStrictEqual(threadSend.content['m.relates_to']?.event_id, '$thr1:example.org');

    await rejects(() => context.runtime.sendProactiveText({ kind: 'post', route: {} }, 'x'),
      (error) => error.code === 'invalid-target');
    await rejects(() => context.runtime.sendProactiveText({ kind: 'room', route: { roomId: 'garbage' } }, 'x'),
      (error) => error.code === 'invalid-target');
  } finally {
    await context.stop();
  }
});

// ---- 端到端加密（E2EE）接线 -------------------------------------------------
// The runtime-side contract with the crypto engine: the three e2eeMode gates, the
// decrypt-then-normalise inbound rewrite, the encrypt wrap on outbound sends into an
// encrypted room, to-device dispatch, membership-driven re-share invalidation, the
// periodic maintain hook and teardown. The engine is a controllable stand-in; the real
// olm loopback is covered by matrix-crypto.test.mjs.

function cryptoStub({ startError = null, decrypt = null } = {}) {
  const engine = {
    started: false,
    stopped: false,
    maintained: 0,
    toDevice: [],
    invalidated: [],
    encrypts: [],
    decrypts: [],
    pendingHandler: null,
    setPendingMessageHandler(handler) { engine.pendingHandler = handler; },
    async start() { engine.started = true; if (startError) throw startError; },
    async stop() { engine.stopped = true; },
    async maintain() { engine.maintained += 1; },
    getStats() {
      return {
        ready: !startError,
        deviceId: 'DSHDEV',
        ed25519Fingerprint: 'edfprefix',
        curve25519Fingerprint: 'cfprefix',
        inboundSessions: 1,
        outboundRooms: 1,
        pendingEvents: 0,
        undecryptable: 0,
        keyUploads: 1,
        roomKeySends: 1,
        shareFailures: 0,
      };
    },
    async handleToDeviceEvents(events) { engine.toDevice.push(...(events ?? [])); },
    async decryptRoomEvent(roomId, event) {
      engine.decrypts.push({ roomId, event });
      if (typeof decrypt === 'function') return decrypt(roomId, event);
      return { content: { msgtype: 'm.text', body: '解密正文' }, senderKey: 'ed', sessionId: 's1', senderDeviceId: 'ALICEDEV' };
    },
    async encryptForRoom(roomId, content) {
      engine.encrypts.push({ roomId, content });
      return {
        algorithm: 'm.megolm.v1.aes_sha2',
        sender_key: 'edkey',
        device_id: 'DSHDEV',
        session_id: 'sess-1',
        ciphertext: JSON.stringify(content),
      };
    },
    invalidateRoomSharing(roomId) { engine.invalidated.push(roomId); },
  };
  const store = {
    loaded: false,
    bootstrapped: 0,
    applied: 0,
    async load() { store.loaded = true; },
    async bootstrap() { store.bootstrapped += 1; return { deviceId: 'DSHDEV' }; },
    async apply() { store.applied += 1; },
    async remove() {},
    get snapshot() { return { version: 1, deviceId: 'DSHDEV', groupInbound: [], groupOutbound: {} }; },
  };
  return { engine, store };
}

function encryptedRoomBatch() {
  return {
    accountData: { 'm.direct': { '@alice:example.org': ['!enc:example.org'] } },
    initial: {
      next_batch: 'b0',
      to_device: { events: [{ type: 'm.room_key', sender: '@alice:example.org', content: { messages: {} } }] },
      rooms: {
        join: {
          '!enc:example.org': {
            timeline: {
              events: [
                { type: 'm.room.encryption', event_id: '$enc-cfg:example.org', sender: '@alice:example.org', content: { algorithm: 'm.megolm.v1.aes_sha2' } },
                {
                  type: 'm.room.encrypted',
                  event_id: '$e1:example.org',
                  sender: '@alice:example.org',
                  origin_server_ts: Date.now(),
                  content: { algorithm: 'm.megolm.v1.aes_sha2', ciphertext: 'HELLO', sender_key: 'ed', device_id: 'ALICEDEV', session_id: 's1' },
                },
              ],
            },
          },
        },
      },
    },
  };
}

test('required mode refuses to connect when no crypto store is configured', async () => {
  const context = await createContext({
    config: { e2eeMode: 'required' },
    cryptoStore: null,
    apiOptions: { initial: { next_batch: 'b0', rooms: {} } },
  });
  try {
    await rejects(() => context.runtime.start(), (error) => /未配置加密状态存储/.test(String(error?.message)));
    equal(context.runtime.status.e2eeActive, false);
    ok(context.runtime.status.lastCryptoError, 'the missing store is recorded as a crypto error');
  } finally {
    await context.stop();
  }
});

test('required mode rejects the connection and records the failure when the engine cannot start', async () => {
  const { engine, store } = cryptoStub({ startError: Object.assign(new Error('olm init failed'), { code: 'crypto-init' }) });
  const context = await createContext({
    config: { e2eeMode: 'required' },
    cryptoStore: store,
    createCrypto: () => engine,
    apiOptions: { initial: { next_batch: 'b0', rooms: {} } },
  });
  try {
    await rejects(() => context.runtime.start(),
      (error) => /required/.test(String(error?.message)) && /olm init failed/.test(String(error?.message)));
    equal(context.runtime.status.e2eeActive, false);
    deepStrictEqual(context.runtime.status.cryptoStats, null);
    deepStrictEqual(context.runtime.status.lastCryptoError?.code, 'crypto-init', 'the engine error code is surfaced on status');
    ok(context.runtime.status.lastCryptoError?.message.includes('olm init failed'));
    ok(engine.started, 'the engine was at least attempted');
    equal(engine.stopped, true, 'a half-started engine is stopped during the failed attempt');
  } finally {
    await context.stop();
  }
});

test('optional mode degrades loudly and drops encrypted traffic when the engine cannot start', async () => {
  const { engine, store } = cryptoStub({ startError: new Error('wasm missing') });
  const context = await createContext({
    cryptoStore: store,
    createCrypto: () => engine,
    apiOptions: encryptedRoomBatch(),
  });
  try {
    await context.runtime.start();
    ok(context.runtime.status.ready, 'optional mode still connects when crypto is unavailable');
    equal(context.runtime.status.e2eeActive, false, 'the engine is not marked active after a failed start');
    ok(context.runtime.status.lastCryptoError);
    await new Promise((resolve) => setTimeout(resolve, 40));
    deepStrictEqual(context.harness.prompts.length, 0, 'encrypted timeline events are dropped while crypto is unavailable');
    deepStrictEqual(engine.decrypts.length, 0, 'no decrypt is attempted without a live engine');
    ok(context.logger.warnings.some((line) => line.includes('端到端加密')), 'the degradation is warned about');
  } finally {
    await context.stop();
  }
});

test('a live crypto engine decrypts inbound megolm traffic, seals outbound sends and follows room lifecycle', async () => {
  const { engine, store } = cryptoStub({
    decrypt: (roomId, event) => ({
      content: { msgtype: 'm.text', body: `解密:${event?.content?.ciphertext ?? ''}` },
      senderKey: 'ed',
      sessionId: 's1',
      senderDeviceId: 'ALICEDEV',
    }),
  });
  const context = await createContext({
    cryptoStore: store,
    createCrypto: () => engine,
    api: (() => {
      const api = createFakeApi(encryptedRoomBatch());
      // Pre-queue the membership batch before start so the loop consumes it on its first
      // post-initial poll; feeding the queue mid-test would race an already-blocked sync call.
      api.queue.push({
        batch: {
          next_batch: 'b1',
          rooms: {
            join: {
              '!enc:example.org': {
                state: {
                  events: [
                    { type: 'm.room.member', state_key: '@bob:example.org', sender: '@bob:example.org', content: { membership: 'join' } },
                  ],
                },
              },
            },
          },
        },
      });
      return api;
    })(),
  });
  try {
    await context.runtime.start();
    ok(context.runtime.status.e2eeActive, 'the engine is active once it starts');
    ok(engine.started);
    deepStrictEqual(context.runtime.status.cryptoStats?.inboundSessions, 1, 'engine stats are summarised onto status');
    ok(engine.toDevice.some((event) => event.type === 'm.room_key'), 'to-device crypto events reach the engine');

    await eventually(() => context.harness.prompts.some((prompt) => prompt.includes('解密:HELLO')),
      'the decrypted body reaches the bridge as a prompt');
    ok(engine.decrypts.some((entry) => entry.roomId === '!enc:example.org' && entry.event?.event_id === '$e1:example.org'),
      'the encrypted event is offered to the engine for decryption');

    await eventually(() => context.fake.calls.some((call) => call.op === 'send'
      && call.type === 'm.room.encrypted' && call.roomId === '!enc:example.org'),
    'the answer is wrapped into an m.room.encrypted envelope for the encrypted room');
    const sealed = context.fake.calls.find((call) => call.op === 'send'
      && call.type === 'm.room.encrypted' && call.roomId === '!enc:example.org');
    ok(typeof sealed?.content?.ciphertext === 'string' && sealed.content.ciphertext.length > 0,
      'the outbound event body is sealed to ciphertext before sending');
    ok(engine.encrypts.some((entry) => entry.roomId === '!enc:example.org'), 'the plaintext answer passed through the engine for sealing');

    await eventually(() => engine.invalidated.includes('!enc:example.org'),
      'a membership change re-invalidates the room share set through the engine');
    await eventually(() => engine.maintained >= 1, 'the engine is maintained after a sync pass');

    await context.stop();
    ok(engine.stopped, 'stopping the runtime stops the crypto engine');
  } finally {
    await context.stop();
  }
});

test('the bot own room messages are neither recorded nor presented as other member speech', async () => {
  const own = messageEvent({ sender: BOT, body: '我上一轮答过的内容' });
  const ambient = messageEvent({ sender: '@carol:example.org', body: '今天的构建报错了' });
  const mention = messageEvent({
    sender: '@alice:example.org',
    body: '@bot:example.org 怎么办',
    content: { 'm.mentions': { user_ids: [BOT] } },
  });
  const directory = await makeTempDirectory('dsh-im-matrix-history-own-');
  const history = await new MatrixRoomHistoryStore(join(directory, 'matrix-history.json')).load();
  const context = await createContext({
    roomHistory: history,
    apiOptions: {
      initial: {
        next_batch: 's1',
        rooms: { join: { '!group:example.org': { timeline: { events: [own, ambient, mention] } } } },
      },
    },
  });
  try {
    await context.runtime.start();
    await eventually(() => context.harness.prompts.some((prompt) => prompt.includes('怎么办')),
      'the mention reaches the harness');
    const prompt = context.harness.prompts.at(-1);
    ok(prompt.includes('今天的构建报错了'), 'third-party chatter is still offered as background');
    ok(!prompt.includes('我上一轮答过的内容'), 'the bot own echoed message is not presented as other member speech');
    deepStrictEqual(history.search({ roomId: '!group:example.org', query: '我上一轮答过的内容' }), [],
      'the bot own message stays out of the shared room record');
  } finally {
    await context.stop();
  }
});
test('a mentioned group reply is conditioned on unaddressed same-day room chatter', async () => {
  const ambient = messageEvent({ sender: '@carol:example.org', body: '今天的构建报错了' });
  const mention = messageEvent({
    sender: '@alice:example.org',
    body: '@bot:example.org 帮我看看怎么办',
    content: { 'm.mentions': { user_ids: [BOT] } },
  });
  const directory = await makeTempDirectory('dsh-im-matrix-history-');
  const history = await new MatrixRoomHistoryStore(join(directory, 'matrix-history.json')).load();
  const context = await createContext({
    roomHistory: history,
    apiOptions: {
      initial: {
        next_batch: 's1',
        rooms: { join: { '!group:example.org': { timeline: { events: [ambient, mention] } } } } },
    },
  });
  try {
    await context.runtime.start();
    await eventually(() => context.harness.prompts.some((prompt) => prompt.includes('帮我看看怎么办')),
      'the mention reaches the harness');
    deepStrictEqual(context.harness.prompts.length, 1,
      'the unaddressed chatter alone never triggers a harness turn');
    const prompt = context.harness.prompts[0];
    ok(prompt.includes('今天的构建报错了'), 'the unaddressed same-day chatter is injected as context');
    ok(prompt.includes('【群聊背景】'), 'the injected history is labelled as third-party background');
    ok(prompt.includes('请勿逐条回应'), 'the block states that the background must not be answered line by line');
    ok(prompt.includes('—— 背景开始 ——') && prompt.includes('—— 背景结束'), 'the background run is fenced');
    ok(prompt.indexOf('—— 背景结束') < prompt.indexOf('【下面这条才是对你的提问'),
      'the fenced background closes before the addressed question is introduced');
    ok(prompt.indexOf('【下面这条才是对你的提问') < prompt.indexOf('帮我看看怎么办'),
      'the addressed question follows its own label and stays outside the background fences');
    ok(prompt.includes('carol'), 'the injected context attributes the earlier speaker');
    ok(prompt.indexOf('今天的构建报错了') < prompt.indexOf('帮我看看怎么办'),
      'the injected context precedes the addressed turn');
    const retained = history.search({ roomId: '!group:example.org', query: '构建' });
    ok(retained.some((entry) => entry.kind === 'human' && entry.text === '今天的构建报错了'),
      'the room record retains the shared unaddressed message for later search');
    const mentionedRecord = history.search({ roomId: '!group:example.org', query: '帮我看看怎么办' });
    ok(mentionedRecord.length === 1 && mentionedRecord[0].injected === true,
      'the addressed turn is retained as already consumed, without the injected block leaking into it');
    deepStrictEqual(history.pending({ roomId: '!group:example.org' }), [],
      'injected chatter is consumed and is not re-sent on a later turn');
    ok(sentMessages(context.fake).some((call) => call.roomId === '!group:example.org'
      && (call.content.body === '好的' || call.content['m.new_content']?.body === '好的')),
      'the reply is delivered back to the room that triggered it');
  } finally {
    await context.stop();
  }
});
