import test, { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deepStrictEqual, ok } from 'node:assert';

import { MatrixRuntime } from '../../../src/channels/matrix/matrix-runtime.mjs';
import { MatrixSidecarStore } from '../../../src/channels/matrix/matrix-config-store.mjs';
import { MatrixRoomHistoryStore } from '../../../src/channels/matrix/matrix-room-history.mjs';

const HOME = 'https://matrix.example.org';
const BOT = '@bot:example.org';
const ROOM = '!group:example.org';
const MAIN_KEY = `group:room:${ROOM}`;

/** Read the context block bodies out of one prompt, in arrival order, as the splitter would. */
function contextBlockBodies(text) {
  return [...text.matchAll(/<dsh_im_context>([\s\S]*?)<\/dsh_im_context>/g)]
    .map(([, body]) => JSON.parse(body));
}

const tempDirectories = new Set();
let eventSequence = 0;

async function makeTempDirectory(prefix) {
  const created = await mkdtemp(join(tmpdir(), prefix));
  tempDirectories.add(created);
  return created;
}

after(async () => {
  // Windows transient locks (antivirus, straggling handles) surface as EBUSY on
  // recursive deletes under the full-suite's 200+ worker concurrency; fs.rm's
  // built-in retry absorbs them without turning cleanup into a test failure.
  for (const directory of tempDirectories) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function eventually(predicate, label = 'condition', timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let satisfied = false;
    try {
      satisfied = Boolean(predicate());
    } catch {
      satisfied = false;
    }
    if (satisfied) return;
    if (Date.now() > deadline) throw new Error(`condition was never reached in time: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function nextEventId() {
  eventSequence += 1;
  return `$ctx${eventSequence}:example.org`;
}

function mentionContent() {
  return { 'm.mentions': { user_ids: [BOT] } };
}

function addressedBody(body) {
  return `${body} <@BOT:Example.ORG>`;
}

function groupMessage({ sender = '@carol:example.org', body = '问一个问题', ts = Date.now(), content = {} } = {}) {
  return {
    type: 'm.room.message',
    event_id: nextEventId(),
    sender,
    origin_server_ts: ts,
    content: { msgtype: 'm.text', body, ...content },
  };
}

function createFakeApi({ initial = {}, events = {} } = {}) {
  const calls = [];
  const queue = [];
  const pendings = [];
  let batch = 0;
  let deliveredInitial = false;
  const fake = {
    calls,
    // Deliver the next timeline chunk the way one server event arrives: either the
    // waiting long-poll takes it immediately, or it waits for the next poll the
    // sync loop issues.
    pushEvents(eventsToDeliver, roomId = ROOM) {
      const chunk = {
        next_batch: `b${batch += 1}`,
        rooms: { join: { [roomId]: { timeline: { events: eventsToDeliver } } } },
      };
      if (pendings.length > 0) pendings.shift().resolve(structuredClone(chunk));
      else queue.push(chunk);
    },
    whoami: async () => ({ user_id: BOT, device_id: 'DSHDEV' }),
    sync: async ({ since } = {}) => {
      calls.push({ op: 'sync', since: since ?? null });
      if (!deliveredInitial && since === undefined) {
        deliveredInitial = true;
        return structuredClone(initial);
      }
      if (queue.length > 0) return structuredClone(queue.shift());
      return await new Promise((resolve, reject) => { pendings.push({ resolve, reject }); });
    },
    getAccountData: async () => ({}),
    setAccountData: async () => ({}),
    sendEvent: async (roomId, type, content) => {
      const sentEventId = `$sent${calls.length + 1}:example.org`;
      calls.push({ op: 'send', roomId, type, content, sentEventId });
      return { event_id: sentEventId };
    },
    setTyping: async () => ({}),
    sendReceipt: async () => ({}),
    getEvent: async (roomId, eventId) => events[eventId] ?? null,
    redactEvent: async () => ({}),
    listRelations: async () => ({ events: [] }),
    getRoomStateEvent: async () => null,
    getJoinedMemberCount: async () => 3,
    getRoomMemberDisplayName: async () => null,
    uploadMedia: async () => 'mxc://media.example.org/up1',
    downloadContent: async () => null,
    drainPendings: () => {
      for (const pending of pendings.splice(0)) pending.reject(new Error('test teardown'));
    },
  };
  return fake;
}

function harnessStub(answer = '好的') {
  const prompts = [];
  return {
    prompts,
    ensureRunning: async () => true,
    sessionExists: async () => false,
    createSession: async () => 'sess-matrix-1',
    ask: async (...args) => {
      const prompt = args.find((entry) => typeof entry === 'string' && !entry.startsWith('sess-')) ?? '';
      prompts.push(prompt);
      return answer;
    },
    stopManagedProcess: () => undefined,
  };
}

function stateStub() {
  const seen = new Set();
  const sessions = new Map();
  const anchors = Object.create(null);
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
    // The root anchor table rides the same extension mechanism the production
    // conversation state store exposes, so the registry under test exercises
    // its persisted code path rather than the in-process fallback.
    extensionState: () => ({ rootAnchors: anchors }),
    persist: async () => undefined,
    snapshot: () => ({ seenMessageIds: [...seen].slice(-50), sessions: Object.fromEntries(sessions) }),
  };
}

function loggerStub() {
  const notices = [];
  return {
    notices,
    info: () => undefined,
    debug: () => undefined,
    warn: (...args) => { notices.push(args.map((entry) => String(entry?.message ?? entry)).join(' ')); },
    error: (...args) => { notices.push(args.map((entry) => String(entry?.message ?? entry)).join(' ')); },
  };
}

async function createContext({ config = {}, initialEvents = [], events = {}, withRoomHistory = false, answer, historyFile = null } = {}) {
  const directory = await makeTempDirectory('dsh-im-matrix-context-');
  const sidecar = await new MatrixSidecarStore(join(directory, 'matrix.json')).load();
  const state = stateStub();
  const logger = loggerStub();
  const harness = harnessStub(answer);
  const initial = initialEvents.length > 0
    ? { next_batch: 'b0', rooms: { join: { [ROOM]: { timeline: { events: initialEvents } } } } }
    : { next_batch: 'b0' };
  const fake = createFakeApi({ initial, events });
  const historyPath = historyFile ?? join(directory, 'matrix-history.json');
  const roomHistory = withRoomHistory ? await new MatrixRoomHistoryStore(historyPath).load() : null;
  const accessPolicy = {
    getSettings: () => ({
      direct: { mode: 'open', open: { defaultCanExecuteCommands: true, commandPermissionOverrides: [] }, allowlist: { users: [] } },
      group: { mode: 'open', open: { defaultCanExecuteCommands: true, commandPermissionOverrides: [] }, allowlist: { users: [] } },
    }),
  };
  const runtime = new MatrixRuntime({
    config: {
      botId: `matrix_${'a'.repeat(24)}`,
      name: 'Matrix 上下文',
      homeserver: HOME,
      userId: BOT,
      ...config,
    },
    accessToken: 'syt_token',
    harness,
    state,
    sidecar,
    roomHistory,
    accessPolicy,
    logger,
    createApi: () => fake,
    cryptoStore: null,
    createCrypto: null,
    isKnownCommand: () => false,
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await runtime.stop();
    fake.drainPendings();
  };
  const waitForPromptCount = (count) => eventually(() => harness.prompts.length >= count, `${count} prompts`);
  return { runtime, fake, state, harness, logger, sidecar, roomHistory, historyFile: historyPath, stop, waitForPromptCount };
}

const sentRoomMessages = (fake) => fake.calls.filter((call) => call.op === 'send' && call.type === 'm.room.message');

test('a reply that opens a thread at its target inherits the main conversation while isolate mode still forks', async () => {
  const repliedTo = nextEventId();
  const replyOpeningThread = () => groupMessage({
    body: addressedBody('这个怎么改'),
    content: {
      ...mentionContent(),
      'm.relates_to': {
        chain: [{ event_id: repliedTo, rel_type: 'm.thread' }],
        'm.in_reply_to': { event_id: repliedTo },
      },
    },
  });
  const inherited = await createContext({ initialEvents: [replyOpeningThread()] });
  try {
    await inherited.runtime.start();
    await inherited.waitForPromptCount(1);
    deepStrictEqual([...inherited.state.sessions.keys()], [MAIN_KEY],
      'an Element-style reply-threading of a main-feed message continues the main conversation');
  } finally {
    await inherited.stop();
  }
  const forked = await createContext({ config: { threadsMode: 'isolate' }, initialEvents: [replyOpeningThread()] });
  try {
    await forked.runtime.start();
    await forked.waitForPromptCount(1);
    ok([...forked.state.sessions.keys()].includes(`${MAIN_KEY}$${repliedTo}`),
      'the legacy isolate mode keeps a reply-opened thread in its own conversation');
  } finally {
    await forked.stop();
  }
});

test('a reply trigger rides along its resolved reply chain framed by attribution lines', async () => {
  const grandparent = '$grand:x.org';
  const parent = '$parent:x.org';
  const resolvable = {
    [parent]: {
      type: 'm.room.message',
      event_id: parent,
      sender: '@dave:example.org',
      origin_server_ts: 1_712_345_678_000,
      content: {
        msgtype: 'm.text',
        body: '母亲的消息说的是配额',
        'm.relates_to': { 'm.in_reply_to': { event_id: grandparent } },
      },
    },
    [grandparent]: {
      type: 'm.room.message',
      event_id: grandparent,
      sender: '@erin:example.org',
      origin_server_ts: 1_712_345_600_000,
      content: { msgtype: 'm.text', body: '祖先的消息讨论限流' },
    },
  };
  const trigger = groupMessage({
    body: addressedBody('这到底读的是什么'),
    content: {
      ...mentionContent(),
      'm.relates_to': { 'm.in_reply_to': { event_id: parent } },
    },
  });
  const context = await createContext({ config: { replyContextEnabled: true }, initialEvents: [trigger], events: resolvable });
  try {
    await context.runtime.start();
    await context.waitForPromptCount(1);
    const prompt = context.harness.prompts[0];
    const bodies = contextBlockBodies(prompt);
    deepStrictEqual(bodies.map((body) => [body.collector, body.event, body.content]), [
      ['reply', '$grand:x.org', '祖先的消息讨论限流'],
      ['reply', '$parent:x.org', '母亲的消息说的是配额'],
    ], 'the resolved chain arrives as two reply-collected blocks, cause before effect');
    ok(bodies.every((body) => body.room === '!group:example.org'), 'each block names the room it was collected from');
    ok(prompt.indexOf('祖先的消息讨论限流') < prompt.indexOf('母亲的消息说的是配额'), 'the chain reads cause before effect');
    ok(prompt.trimEnd().endsWith('这到底读的是什么'), 'the question survives exactly as the human typed it');
    ok(!prompt.includes('【下面这条才是对你的提问'), 'the structured framing replaces the legacy prose block');
  } finally {
    await context.stop();
  }
});

test('the same-sender burst ahead of the trigger arrives as attributed ambient context and is consumed once', async () => {
  const now = Date.now();
  const context = await createContext({
    config: { ambientContextEnabled: true, visibleContextEnabled: false },
    withRoomHistory: true,
  });
  try {
    await context.runtime.start();
    // The room record is the ambient source; seed it the way the runtime records unaddressed chatter.
    context.roomHistory.append({ roomId: ROOM, eventId: '$a1:x.org', sender: '@carol:example.org', name: 'carol', text: '连珠第一条', ts: now - 50_000 });
    context.roomHistory.append({ roomId: ROOM, eventId: '$a2:x.org', sender: '@carol:example.org', name: 'carol', text: '连珠第二条', ts: now - 30_000 });
    context.roomHistory.append({ roomId: ROOM, eventId: '$b1:x.org', sender: '@bob:example.org', name: 'bob', text: '路人的旁注', ts: now - 120_000 });
    context.fake.pushEvents([groupMessage({ body: addressedBody('总结一下'), content: mentionContent() })]);
    await context.waitForPromptCount(1);
    const prompt = context.harness.prompts[0];
    const bodies = contextBlockBodies(prompt);
    ok(bodies.some((body) => body.collector === 'ambient-burst' && body.content === '连珠第一条')
      && bodies.some((body) => body.collector === 'ambient-burst' && body.content === '连珠第二条'),
    'the trailing same-sender run arrives as verbatim burst blocks');
    ok(bodies.some((body) => body.collector === 'ambient-recent' && body.content === '路人的旁注'),
    'the rest of the window arrives as a recent block');
    ok(prompt.indexOf('连珠第一条') < prompt.indexOf('连珠第二条')
      && prompt.indexOf('连珠第二条') < prompt.indexOf('路人的旁注'), 'ambient context reads older to newer');
    ok(prompt.trimEnd().endsWith('总结一下'), 'the question survives exactly as the human typed it');
    ok(!prompt.includes('【下面这条才是对你的提问'), 'the structured framing replaces the legacy prose block');
    await eventually(
      () => context.roomHistory.pending({ roomId: ROOM, limit: 50 }).length === 0,
      'ambient entries are marked consumed after the successful turn',
    );
    await context.roomHistory.flush();
    const reloaded = await new MatrixRoomHistoryStore(context.historyFile).load();
    deepStrictEqual(reloaded.pending({ roomId: ROOM, limit: 50 }), [],
      'the consumption markers survive a reload so a restart re-offers nothing');
  } finally {
    await context.stop();
  }
});

test('the thread root rides along until one successful turn consumes it and /new re-arms it', async () => {
  const rootId = '$root:x.org';
  const resolvable = {
    [rootId]: {
      type: 'm.room.message',
      event_id: rootId,
      sender: '@carol:example.org',
      origin_server_ts: 1_712_345_000_000,
      content: { msgtype: 'm.text', body: '话题的根消息' },
    },
  };
  const inThread = (body, { command = false } = {}) => groupMessage({
    body: command ? body : addressedBody(body),
    content: command
      ? { 'm.relates_to': { chain: [{ event_id: rootId, rel_type: 'm.thread' }] } }
      : { ...mentionContent(), 'm.relates_to': { chain: [{ event_id: rootId, rel_type: 'm.thread' }] } },
  });
  const context = await createContext({
    config: { rootContextOnceEnabled: true },
    initialEvents: [inThread('第一条讨论')],
    events: resolvable,
  });
  try {
    await context.runtime.start();
    await context.waitForPromptCount(1);
    ok(contextBlockBodies(context.harness.prompts[0])
      .some((body) => body.collector === 'thread-root' && body.content === '话题的根消息'),
    'the first turn of a new thread conversation receives the resolved root');
    ok([...context.state.sessions.keys()].includes(`${MAIN_KEY}$${rootId}`),
      'a post made inside an existing thread keeps its own conversation');

    context.fake.pushEvents([inThread('第二条讨论')]);
    await context.waitForPromptCount(2);
    ok(!contextBlockBodies(context.harness.prompts[1]).some((body) => body.collector === 'thread-root'),
      'the consumed root is not re-injected while the same session continues');

    context.fake.pushEvents([inThread('/new', { command: true })]);
    await eventually(
      () => sentRoomMessages(context.fake)
        .some((call) => typeof call.content?.body === 'string' && call.content.body.includes('已开启全新 Harness 会话')),
      'the /new confirmation',
    );
    context.fake.pushEvents([inThread('第三条讨论')]);
    await context.waitForPromptCount(3);
    ok(contextBlockBodies(context.harness.prompts[2])
      .some((body) => body.collector === 'thread-root' && body.content === '话题的根消息'),
    'after the session was cleared the root context rides along again');
  } finally {
    await context.stop();
  }
});

test('the shipped room policy wakes the bot only through a mention or a command', async () => {
  const context = await createContext({
    initialEvents: [
      groupMessage({
        sender: '@carol:example.org',
        body: '不@直接回复某条人类消息',
        content: { 'm.relates_to': { 'm.in_reply_to': { event_id: '$human:x.org' } } },
      }),
      groupMessage({ sender: '@dave:example.org', body: '主时间线的普通闲聊' }),
      groupMessage({
        sender: '@erin:example.org',
        body: '不@但在线程内的回复',
        content: { 'm.relates_to': { chain: [{ event_id: '$thread:x.org', rel_type: 'm.thread' }], 'm.in_reply_to': { event_id: '$in-thread:x.org' } } },
      }),
    ],
    withRoomHistory: true,
  });
  try {
    await context.runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 250));
    deepStrictEqual(context.harness.prompts.length, 0,
      'unaddressed replies on the timeline or inside a thread stay recorded facts and never wake the bot');
    context.fake.pushEvents([groupMessage({ body: '这次是 @ 提问', content: mentionContent() })]);
    await context.waitForPromptCount(1);
    ok(context.harness.prompts[0].includes('这次是 @ 提问'), 'the @-mention wakes the bot');
    context.fake.pushEvents([groupMessage({ sender: '@erin:example.org', body: '/notacommand-but-shaped', content: {} })]);
    await context.waitForPromptCount(2);
    ok(context.harness.prompts[1].includes('/notacommand-but-shaped'), 'a command-shaped message wakes the bot without a mention');
  } finally {
    await context.stop();
  }
});

test('bot-only replies answer only replies that provably address the bot and record the rest as ambient facts', async () => {
  const context = await createContext({
    config: { triggerOnReply: 'bot-only' },
    initialEvents: [groupMessage({ sender: '@carol:example.org', body: addressedBody('第一个问题'), content: mentionContent() })],
    withRoomHistory: true,
  });
  try {
    await context.runtime.start();
    await context.waitForPromptCount(1);
    await eventually(() => sentRoomMessages(context.fake).length > 0, 'the bot answer');
    const botMessageId = sentRoomMessages(context.fake)[0].sentEventId;
    context.fake.pushEvents([groupMessage({
      sender: '@dave:example.org',
      body: '这个回答很好',
      content: { 'm.relates_to': { 'm.in_reply_to': { event_id: botMessageId } } },
    })]);
    await context.waitForPromptCount(2);
    ok(context.harness.prompts[1].includes('这个回答很好'), 'a reply to a bound bot message triggers the bot');

    context.fake.pushEvents([groupMessage({
      sender: '@erin:example.org',
      body: '回复群里同学的发言',
      content: { 'm.relates_to': { 'm.in_reply_to': { event_id: '$humanmsg:x.org' } } },
    })]);
    await eventually(
      () => context.roomHistory.pending({ roomId: ROOM, limit: 50 }).some((entry) => entry.text === '回复群里同学的发言'),
      'the human-directed reply lands in the ambient record',
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    deepStrictEqual(context.harness.prompts.length, 2, 'a reply to an unbound target never wakes the bot');
  } finally {
    await context.stop();
  }
});

test('thread membership falls back out of reply context and every conversation injects an event at most once', async () => {
  const rootId = nextEventId();
  const ancientId = nextEventId();
  const now = Date.now();
  const events = {
    [rootId]: { type: 'm.room.message', event_id: rootId, sender: '@carol:example.org', origin_server_ts: now, content: { msgtype: 'm.text', body: 'shijian' } },
    [ancientId]: { type: 'm.room.message', event_id: ancientId, sender: '@erin:example.org', origin_server_ts: now, content: { msgtype: 'm.text', body: '祖先的消息讨论限流' } },
  };
  const threadContinuation = (body) => groupMessage({
    body: addressedBody(body),
    content: {
      ...mentionContent(),
      'm.in_reply_to': { event_id: rootId },
      'm.relates_to': {
        chain: [{ event_id: rootId, rel_type: 'm.thread' }],
        is_falling_back: true,
      },
    },
  });
  const realReply = (body, target) => groupMessage({
    body: addressedBody(body),
    content: { ...mentionContent(), 'm.in_reply_to': { event_id: target } },
  });
  const context = await createContext({ config: { rootContextOnceEnabled: true, replyContextEnabled: true }, events });
  try {
    await context.runtime.start();
    context.fake.pushEvents([threadContinuation('第一问话题')]);
    await context.waitForPromptCount(1);
    deepStrictEqual(contextBlockBodies(context.harness.prompts[0]).map((body) => [body.collector, body.event, body.content]),
      [['thread-root', rootId, 'shijian']],
      'the thread root serves once through the root collector and membership stays out of reply context');
    ok(context.harness.prompts[0].trimEnd().endsWith('第一问话题'), 'the direct question stays verbatim at the end');

    context.fake.pushEvents([threadContinuation('第二问话题')]);
    await context.waitForPromptCount(2);
    deepStrictEqual(contextBlockBodies(context.harness.prompts[1]), [],
      'later continuations in the thread carry no re-served root and no fake reply context');
    ok(context.harness.prompts[1].trimEnd().endsWith('第二问话题'));

    context.fake.pushEvents([realReply('第一次真回复祖先', ancientId)]);
    await context.waitForPromptCount(3);
    deepStrictEqual(contextBlockBodies(context.harness.prompts[2]).map((body) => [body.collector, body.event, body.content]),
      [['reply', ancientId, '祖先的消息讨论限流']],
      'a real reply serves its chain the first time it is seen');

    context.fake.pushEvents([realReply('第二次真回复祖先', ancientId)]);
    await context.waitForPromptCount(4);
    deepStrictEqual(contextBlockBodies(context.harness.prompts[3]), [],
      'an event already injected into this conversation is not injected again');
    ok(context.harness.prompts[3].trimEnd().endsWith('第二次真回复祖先'));
  } finally {
    await context.stop();
  }
});

test('a room-shared conversation labels each turn with its speaker once the profile name is cached', async () => {
  const context = await createContext();
  context.fake.getRoomMemberDisplayName = async (roomId, userId) => (
    roomId === ROOM && userId === '@bob:example.org' ? 'Bob' : null
  );
  try {
    await context.runtime.start();
    context.fake.pushEvents([groupMessage({
      sender: '@bob:example.org',
      body: addressedBody('描述一下这个图片'),
      content: mentionContent(),
    })]);
    await context.waitForPromptCount(1);
    ok(context.harness.prompts[0].startsWith('bob: 描述一下这个图片'),
      'the first turn labels with the MXID localpart while the room state read is still in flight');

    context.fake.pushEvents([groupMessage({
      sender: '@bob:example.org',
      body: addressedBody('再看一眼颜色'),
      content: mentionContent(),
    })]);
    await context.waitForPromptCount(2);
    ok(context.harness.prompts[1].startsWith('Bob: 再看一眼颜色'),
      'later turns ride the cached room profile display name');

    context.fake.pushEvents([groupMessage({
      sender: '@carol:example.org',
      body: addressedBody('我这里又有一个问题'),
      content: mentionContent(),
    })]);
    await context.waitForPromptCount(3);
    ok(context.harness.prompts[2].startsWith('carol: 我这里又有一个问题'),
      'another member is labelled with its own identity in the shared conversation');
  } finally {
    await context.stop();
  }
});

test('a thread conversation keeps its own message list in view and never borrows from the mainline', async () => {
  const answer = '成都今天多云转晴，18~27°C，降水概率低';
  const questionId = '$q1:example.org';
  const placeholderId = '$ph:example.org';
  const chongqingId = '$cq1:example.org';
  const roomEvent = ({ eventId, sender, body, content = {} }) => ({
    type: 'm.room.message',
    event_id: eventId,
    sender,
    origin_server_ts: Date.now(),
    content: { msgtype: 'm.text', body, ...content },
  });
  const threadChain = { chain: [{ event_id: placeholderId, rel_type: 'm.thread' }] };
  const questionEvent = roomEvent({
    eventId: questionId,
    sender: '@rjd:example.org',
    body: addressedBody('成都今天天气'),
    content: mentionContent(),
  });
  const placeholderEvent = roomEvent({
    eventId: placeholderId,
    sender: BOT,
    body: '正在处理…',
    content: { 'm.relates_to': { 'm.in_reply_to': { event_id: questionId } } },
  });
  const context = await createContext({
    withRoomHistory: true,
    answer,
    events: { [questionId]: questionEvent, [placeholderId]: placeholderEvent },
    config: { ambientContextEnabled: true, rootContextOnceEnabled: true, replyContextEnabled: true },
  });
  try {
    await context.runtime.start();
    // The mainline question is answered from the send face; the homeserver in this
    // deployment pattern echoes no bot-authored events back onto the timeline.
    context.fake.pushEvents([questionEvent]);
    await context.waitForPromptCount(1);
    await eventually(() => context.roomHistory
      .recent({ roomId: ROOM, threadId: null, limit: 20 })
      .some((entry) => entry.kind === 'bot' && entry.text === answer), 'the send-face answer is stored on the mainline');

    // The answer began as a pending placeholder sent in reply to the question,
    // which is the event that opened the thread; it carries no content and is
    // never stored.
    context.fake.pushEvents([placeholderEvent]);
    deepStrictEqual(context.roomHistory
      .recent({ roomId: ROOM, limit: 50 })
      .some((entry) => entry.text === '正在处理…'), false, 'the placeholder stays out of the room record');

    // Inside the thread, an unmentioned elliptical question is recorded with its
    // thread membership for the same-list windows.
    context.fake.pushEvents([roomEvent({
      eventId: chongqingId,
      sender: '@rjd:example.org',
      body: '重庆呢',
      content: { 'm.relates_to': threadChain },
    })]);
    await eventually(() => context.roomHistory
      .recent({ roomId: ROOM, threadId: placeholderId, limit: 20 })
      .some((entry) => entry.text === '重庆呢'), 'the in-thread follow-up is stored under its thread');

    // The in-thread question also carries a genuine reply to the thread's
    // placeholder root event: the homeserver hands back that event's pre-edit
    // receipt body, and the collection gate must keep it out of the context.
    context.fake.pushEvents([roomEvent({
      eventId: nextEventId(),
      sender: '@rjd:example.org',
      body: addressedBody('上海呢'),
      content: {
        ...mentionContent(),
        'm.relates_to': { ...threadChain, 'm.in_reply_to': { event_id: placeholderId } },
      },
    })]);
    await context.waitForPromptCount(2);
    const bodies = contextBlockBodies(context.harness.prompts[1]);
    deepStrictEqual(bodies.map((body) => [body.collector, body.event, body.sender, body.content]), [
      ['room-visible', chongqingId, '@rjd:example.org', '重庆呢'],
    ], 'the placeholder root contributes no entry of its own: the collection opens with what the thread itself shows, and the mainline question behind the placeholder is not borrowed in');
    ok(!bodies.some((body) => body.content === answer),
      'the mainline answer visible on the other message list is not injected into the thread');
    ok(context.harness.prompts[1].endsWith('rjd: 上海呢'), 'the direct question stays the last verbatim word');

    // The thread's own previous answer is this session's word: it lives in the
    // transcript already, so the window serves it to no later turn either.
    context.fake.pushEvents([roomEvent({
      eventId: nextEventId(),
      sender: '@rjd:example.org',
      body: addressedBody('广州呢'),
      content: { ...mentionContent(), 'm.relates_to': threadChain },
    })]);
    await context.waitForPromptCount(3);
    deepStrictEqual(contextBlockBodies(context.harness.prompts[2]), [],
      'the answer this same session produced is transcript content already, so the window keeps it out of the next prompt');
    ok(context.harness.prompts[2].endsWith('rjd: 广州呢'));
  } finally {
    await context.stop();
  }
});

test('a conversation never re-reads the answers it produced, while third-party room speech still rides along', async () => {
  const answer = '这段回答由本场会话自己产出';
  const context = await createContext({
    withRoomHistory: true,
    answer,
    initialEvents: [groupMessage({ sender: '@alice:example.org', body: addressedBody('第一个问题'), content: mentionContent() })],
  });
  try {
    await context.runtime.start();
    await context.waitForPromptCount(1);
    await eventually(() => sentRoomMessages(context.fake).length > 0, 'the bot answer left the send face');
    context.fake.pushEvents([
      groupMessage({ sender: '@dave:example.org', body: '回答之后的旁聊' }),
      groupMessage({ sender: '@alice:example.org', body: addressedBody('第二个问题'), content: mentionContent() }),
    ]);
    await context.waitForPromptCount(2);
    const bodies = contextBlockBodies(context.harness.prompts[1]);
    ok(!bodies.some((body) => body.content === answer),
      'the answer the same conversation produced is transcript content already, so the window keeps it out');
    ok(bodies.some((body) => body.collector === 'room-visible' && body.content === '回答之后的旁聊'),
      'third-party speech the session cannot know stays served through the window');
    const stored = context.roomHistory.search({ roomId: ROOM, query: answer });
    ok(stored.length > 0 && stored.every((entry) => entry.kind === 'bot' && entry.turnKey === MAIN_KEY && entry.turnEpoch === 0),
      'the send-face record carries the provenance that retired it: its own conversation key and the current session generation');
  } finally {
    await context.stop();
  }
});

test('another conversation keeps reading a bot answer that its own conversation stopped re-serving', async () => {
  const answer = '主线里给出的那一条回答全文';
  const context = await createContext({
    withRoomHistory: true,
    answer,
    initialEvents: [groupMessage({ sender: '@alice:example.org', body: addressedBody('主线提问'), content: mentionContent() })],
  });
  try {
    await context.runtime.start();
    await context.waitForPromptCount(1);
    await eventually(() => sentRoomMessages(context.fake).length > 0, 'the bot answer left the send face');
    const answerEventId = sentRoomMessages(context.fake)[0].sentEventId;
    context.fake.pushEvents([groupMessage({
      sender: '@bob:example.org',
      body: addressedBody('在这条回答下开线追问'),
      content: {
        ...mentionContent(),
        'm.in_reply_to': { event_id: answerEventId },
        'm.relates_to': {
          chain: [{ event_id: answerEventId, rel_type: 'm.thread' }],
          is_falling_back: true,
        },
      },
    })]);
    await context.waitForPromptCount(2);
    ok(context.harness.prompts[1].includes(answer),
      'a member opening the panel under the bot answer still reads that bubble: the retirement is scoped to the producing conversation');
    ok(!context.harness.prompts[1].includes('主线提问'),
      'the mainline question behind the panel stays out of the thread window, provenance-stamped or not');
  } finally {
    await context.stop();
  }
});

test('folded same-sender triggers never resurface as room-visible context entries', async () => {
  const first = groupMessage({ sender: '@alice:example.org', body: addressedBody('第一问先落地'), content: mentionContent() });
  const second = groupMessage({ sender: '@alice:example.org', body: addressedBody('第二问随后到'), content: mentionContent() });
  const context = await createContext({
    withRoomHistory: true,
    answer: '两问合答的一条回答',
    initialEvents: [first, second],
    config: { coalesceWindowMs: 250 },
  });
  try {
    await context.runtime.start();
    await context.waitForPromptCount(1);
    const prompt = context.harness.prompts[0];
    ok(prompt.includes('第一问先落地') && prompt.includes('第二问随后到'),
      'both folded questions reach the turn once, as the dispatch body');
    deepStrictEqual(
      contextBlockBodies(prompt)
        .filter((entry) => entry.event === first.event_id || entry.event === second.event_id)
        .map((entry) => entry.event),
      [],
      'no folded member reappears inside the injected context blocks',
    );
  } finally {
    await context.stop();
  }
});

test('a fresh session reads back the answers of the session it replaced, once', async () => {
  const answer = '旧会话留下的那条回答';
  const context = await createContext({
    withRoomHistory: true,
    answer,
    initialEvents: [groupMessage({ sender: '@alice:example.org', body: addressedBody('旧会话提问'), content: mentionContent() })],
  });
  try {
    await context.runtime.start();
    await context.waitForPromptCount(1);
    await eventually(() => sentRoomMessages(context.fake).length > 0, 'the bot answer left the send face');
    context.fake.pushEvents([groupMessage({ sender: '@alice:example.org', body: addressedBody('继续追问'), content: mentionContent() })]);
    await context.waitForPromptCount(2);
    ok(!contextBlockBodies(context.harness.prompts[1]).some((body) => body.content === answer),
      'the running session does not re-read its own answer');
    context.fake.pushEvents([groupMessage({ sender: '@alice:example.org', body: '/new' })]);
    await eventually(() => sentRoomMessages(context.fake).some((call) =>
      typeof call.content?.body === 'string' && call.content.body.includes('已开启全新 Harness 会话')), 'the /new confirmation');
    context.fake.pushEvents([groupMessage({ sender: '@alice:example.org', body: addressedBody('新会话首问'), content: mentionContent() })]);
    await context.waitForPromptCount(3);
    ok(contextBlockBodies(context.harness.prompts[2]).some((body) => body.content === answer),
      'the successor session never saw that answer, so the generation bump lets it read back once');
    ok(context.roomHistory.search({ roomId: ROOM, query: answer }).some((entry) => entry.turnEpoch === 0),
      'the stored provenance still names the generation that produced the bubble');
  } finally {
    await context.stop();
  }
});

test('the self-answer retirement holds on the reply-chain lane as well, while a fresh session still reads the quoted answer once', async () => {
  const answer = '本会话刚给出的那条天气回答';
  const events = {};
  const context = await createContext({
    withRoomHistory: true,
    answer,
    events,
    config: { replyContextEnabled: true },
    initialEvents: [groupMessage({ sender: '@alice:example.org', body: addressedBody('第一个问题'), content: mentionContent() })],
  });
  try {
    await context.runtime.start();
    await context.waitForPromptCount(1);
    await eventually(() => sentRoomMessages(context.fake).length > 0, 'the bot answer left the send face');
    const answerEventId = sentRoomMessages(context.fake)[0].sentEventId;
    // The homeserver resolves the quoted bubble to its readable final body — the
    // whole-send shape of an answer delivered as fresh events, where no pending
    // placeholder receipt truncates the walk and the ledger has never seen it.
    events[answerEventId] = {
      type: 'm.room.message',
      event_id: answerEventId,
      sender: BOT,
      origin_server_ts: Date.now(),
      content: { msgtype: 'm.text', body: answer },
    };
    context.fake.pushEvents([groupMessage({
      sender: '@alice:example.org',
      body: addressedBody('那穿衣呢'),
      content: { ...mentionContent(), 'm.relates_to': { 'm.in_reply_to': { event_id: answerEventId } } },
    })]);
    await context.waitForPromptCount(2);
    const bodies = contextBlockBodies(context.harness.prompts[1]);
    deepStrictEqual(bodies, [],
      'the quote is a platform fact, but the bubble behind it is this conversation\'s own word of the current generation: transcript content already, so the reply-chain lane holds it out exactly as the room window does');
    // A cleared conversation no longer claims its predecessor's bubbles: under the
    // bumped generation the same quote resolves into the fresh session's context.
    context.fake.pushEvents([groupMessage({ sender: '@alice:example.org', body: '/new' })]);
    await eventually(() => sentRoomMessages(context.fake).some((call) =>
      typeof call.content?.body === 'string' && call.content.body.includes('已开启全新 Harness 会话')), 'the /new confirmation');
    context.fake.pushEvents([groupMessage({
      sender: '@alice:example.org',
      body: addressedBody('继续说天气'),
      content: { ...mentionContent(), 'm.relates_to': { 'm.in_reply_to': { event_id: answerEventId } } },
    })]);
    await context.waitForPromptCount(3);
    ok(contextBlockBodies(context.harness.prompts[2]).some((body) => body.event === answerEventId && body.content === answer),
      'the successor session never saw that answer, so the quoted bubble reads back into its context once');
  } finally {
    await context.stop();
  }
});

test('the room window read-once retirement survives a restarted runtime, and a cleared conversation reads the entry back once', async () => {
  const now = Date.now();
  const context = await createContext({ withRoomHistory: true });
  try {
    await context.runtime.start();
    context.roomHistory.append({ roomId: ROOM, eventId: '$side:x.org', sender: '@carol:example.org', name: 'carol', text: '旁人的留言', ts: now - 40_000 });
    context.fake.pushEvents([groupMessage({ sender: '@alice:example.org', body: addressedBody('首问'), content: mentionContent() })]);
    await context.waitForPromptCount(1);
    ok(contextBlockBodies(context.harness.prompts[0]).some((entry) => entry.content === '旁人的留言'),
      'the room-visible window offers the unaddressed bubble to the first question');
    await eventually(() => context.roomHistory.contextInjected({ conversationKey: MAIN_KEY, eventId: '$side:x.org' }),
      'the consumption marker reaches the durable ledger with the successful turn');
    await context.roomHistory.flush();
  } finally {
    await context.stop();
  }
  const revived = await createContext({ withRoomHistory: true, historyFile: context.historyFile });
  try {
    await revived.runtime.start();
    revived.fake.pushEvents([groupMessage({ sender: '@bob:example.org', body: addressedBody('重启后的提问'), content: mentionContent() })]);
    await revived.waitForPromptCount(1);
    ok(!contextBlockBodies(revived.harness.prompts[0]).some((entry) => entry.content === '旁人的留言'),
      'the restarted runtime re-offers nothing its conversation has already been shown: the ledger is durable, not process-local');
    revived.fake.pushEvents([groupMessage({ sender: '@bob:example.org', body: '/new' })]);
    await eventually(() => sentRoomMessages(revived.fake).some((call) =>
      typeof call.content?.body === 'string' && call.content.body.includes('已开启全新 Harness 会话')), 'the /new confirmation');
    revived.fake.pushEvents([groupMessage({ sender: '@bob:example.org', body: addressedBody('新会话首问'), content: mentionContent() })]);
    await revived.waitForPromptCount(2);
    ok(contextBlockBodies(revived.harness.prompts[1]).some((entry) => entry.content === '旁人的留言'),
      'the cleared conversation releases the retirement, so the successor session reads the bubble back once');
    await eventually(() => revived.roomHistory.contextInjected({ conversationKey: MAIN_KEY, eventId: '$side:x.org' }),
      'the read-back is recorded in the durable ledger again');
  } finally {
    await revived.stop();
  }
});
