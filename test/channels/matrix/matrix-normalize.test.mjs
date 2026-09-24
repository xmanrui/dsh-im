import test from 'node:test';
import { deepEqual, deepStrictEqual, notEqual, ok } from 'node:assert';

import {
  ClockSkewGuard,
  EventDedupeRing,
  compileIgnorePatterns,
  detectMatrixMention,
  isBridgeOrSystemSender,
  isMatrixCommandLike,
  isSelfSender,
  matchesIgnoredSender,
  matrixConversationKeyFromTarget,
  normalizeMatrixDeliveryTarget,
  normalizeMatrixTimelineEvent,
  resolveBangMatrixCommand,
  stripMatrixMentions,
} from '../../../src/channels/matrix/matrix-normalize.mjs';

const BOT = '@bot:example.org';
const ROOM = '!roomA:example.org';

function event(overrides = {}, content = {}) {
  return {
    type: 'm.room.message',
    event_id: '$evt1:example.org',
    sender: '@alice:example.org',
    origin_server_ts: Date.now(),
    ...overrides,
    content: { msgtype: 'm.text', body: '你好', ...content },
  };
}

function funnel(eventInput, options = {}) {
  return normalizeMatrixTimelineEvent({
    event: eventInput,
    roomId: ROOM,
    botUserId: BOT,
    isDirect: false,
    config: {},
    ...options,
  });
}

test('dedupe ring marks each id once, survives seeding and evicts by capacity', () => {
  const ring = new EventDedupeRing(3);
  ring.seed(['$a', '$b']);
  ok(ring.has('$a'));
  ok(ring.mark('$c'));
  ok(!ring.mark('$c'), 'a repeat observation is not new');
  ok(!ring.mark('$a'), 'seeded ids stay known');
  ring.mark('$d');
  ring.mark('$e');
  ok(!ring.has('$b'), 'the oldest seeded id rotated out at capacity');
  ok(ring.has('$e'));
  deepEqual(ring.snapshot(), ['$c', '$d', '$e']);
});

test('the clock guard drops pre-startup backlog, warns once on persistent skew, then keeps dropping', () => {
  const startup = 1_700_000_000_000;
  const guard = new ClockSkewGuard({ startupTsMs: startup });
  const verdict = guard.evaluate(startup - 600_000, startup + 1_000);
  ok(verdict.drop && !verdict.warnSkew, 'pre-startup backlog is dropped without any warning');
  deepStrictEqual(guard.evaluate(startup + 1_000, startup + 2_000), { drop: false, warnSkew: false });
  const farPast = (atMs) => guard.evaluate(atMs - 301_000, atMs);
  deepStrictEqual(farPast(startup + 310_000), { drop: false, warnSkew: false },
    'the first skewed events are still accepted while the streak builds');
  deepStrictEqual(farPast(startup + 311_000), { drop: false, warnSkew: false });
  deepStrictEqual(farPast(startup + 312_000), { drop: true, warnSkew: true },
    'the streak crossing the guard line warns exactly once and starts dropping');
  deepStrictEqual(farPast(startup + 313_000), { drop: true, warnSkew: false },
    'later events drop silently after the one-time warning');
  ok(guard.warned);
});

test('identity guards fail closed for self, bridges and malformed senders', () => {
  ok(isSelfSender('@Bot:Example.ORG', BOT), 'self identity is case-insensitive');
  ok(!isSelfSender('@alice:example.org', BOT));
  ok(isSelfSender('@anyone:example.org', null), 'an unresolved own identity is treated as self');
  ok(isBridgeOrSystemSender('@_github-bridge:example.org'));
  ok(isBridgeOrSystemSender('not-a-mxid'));
  ok(!isBridgeOrSystemSender('@alice:example.org'));
  const patterns = compileIgnorePatterns(['^@spammer', 'bad(pcre', '']);
  ok(matchesIgnoredSender('@spammer:example.org', patterns));
  ok(!matchesIgnoredSender('@alice:example.org', patterns));
});

test('mention detection trusts m.mentions first and falls back through the whole chain', () => {
  ok(detectMatrixMention({ 'm.mentions': { user_ids: ['@BOT:Example.ORG'] } }, BOT));
  ok(detectMatrixMention({ body: '<@bot:example.org> hello' }, BOT));
  ok(detectMatrixMention({ body: 'hey @bot:example.org look' }, BOT));
  ok(detectMatrixMention({
    body: 'plain',
    formatted_body: '<a href="https://matrix.to/#/@bot:example.org">pill</a>',
  }, BOT));
  ok(detectMatrixMention({ body: 'hey @bot look' }, BOT), 'a word-bounded at-localpart pill counts');
  ok(!detectMatrixMention({ body: 'mybot is mentioned but the bot is not' }, BOT),
    'a bare localpart inside a word never counts');
  ok(!detectMatrixMention({ body: 'just text' }, BOT));
});

test('mention stripping removes bot forms and keeps innocent words intact', () => {
  deepStrictEqual(stripMatrixMentions('<@Bot:Example.ORG> 请帮我', BOT), '请帮我');
  deepStrictEqual(stripMatrixMentions('@bot:example.org 请帮我', BOT), '请帮我');
  deepStrictEqual(
    stripMatrixMentions('[<@bot:example.org>](https://matrix.to/#/@bot:example.org) 继续', BOT),
    '继续',
  );
  deepStrictEqual(stripMatrixMentions('Hermes Agent 与 @bot:example.org', BOT), 'Hermes Agent 与',
    'only the bot mention is stripped, never an innocent @word');
  notEqual(stripMatrixMentions('contact mybot team', BOT), '');
});

test('command gates recognize slash and bang forms', () => {
  ok(isMatrixCommandLike('/new'));
  ok(isMatrixCommandLike('!compact now'));
  ok(!isMatrixCommandLike('run /deploy please'));
  const known = (name) => ['new', 'compact', 'help'].includes(String(name).replace(/^\/+/, ''));
  deepStrictEqual(resolveBangMatrixCommand('!compact now', known), '/compact now');
  deepStrictEqual(resolveBangMatrixCommand('!deploy now', known), '!deploy now',
    'an unknown bang command is kept verbatim');
  deepStrictEqual(resolveBangMatrixCommand('!!urgent', known), '!!urgent');
});

test('the funnel drops by fixed gate order and keeps shapes well', () => {
  deepStrictEqual(funnel(event({ sender: BOT })), { drop: 'self' });
  deepStrictEqual(funnel(event({ sender: '@_bridge:example.org' })), { drop: 'bridge' });
  const patterns = compileIgnorePatterns(['^@spammer:']);
  deepStrictEqual(funnel(event({ sender: '@spammer:example.org' }), { patterns }), { drop: 'ignored' });
  const ring = new EventDedupeRing(50);
  const accepted = event();
  const outcome = funnel(accepted, { ring, config: { requireMention: false } });
  deepStrictEqual({ ...outcome.message, contextSource: outcome.message.contextSource() }, {
    kind: 'group',
    roomId: ROOM,
    messageId: '$evt1:example.org',
    senderId: '@alice:example.org',
    senderIsBot: false,
    conversationId: 'room:!roomA:example.org',
    contextSource: { chatId: ROOM },
    content: '你好',
    plainText: true,
    images: [],
    files: [],
    addressed: false,
    mentioned: false,
    threadId: null,
    replyToEventId: null,
    reactionTarget: { roomId: ROOM, eventId: '$evt1:example.org' },
    replyTarget: { roomId: ROOM, recipientUserId: '@alice:example.org' },
  });
  deepStrictEqual(funnel(accepted, { ring }), { drop: 'duplicate' });
  deepStrictEqual(funnel(event({ type: 'm.room.typing' })), { drop: 'type' });
  deepStrictEqual(funnel(event({}, { msgtype: 'm.notice' })), { drop: 'notice' });
  deepStrictEqual(funnel(event({}, { msgtype: 'm.notice', 'm.relates_to': { rel_type: 'm.replace' } })),
    { drop: 'notice' }, 'the notice gate runs before the edit gate');
  deepStrictEqual(funnel(event({}, { 'm.relates_to': { rel_type: 'm.replace' } })), { drop: 'edit' });
  deepStrictEqual(funnel(event({}, { msgtype: 'm.image', body: 'pic', url: 'mxc://x/y' }),
    { config: { requireMention: false } }),
  { drop: 'media-unusable' }, 'media without a usable source is dropped');
  const media = funnel(event({}, { msgtype: 'm.image', body: 'pic', url: 'mxc://x/y' }), {
    config: { requireMention: false },
    deps: { createMediaSource: () => ({ images: [{ name: 'pic' }], files: [] }) },
  });
  ok(media.message && media.message.images.length === 1);
});

test('group messages pass only through mention, command or reply relations', () => {
  deepStrictEqual(funnel(event()), { drop: 'mention-required' });
  const mentioned = funnel(event({}, { body: 'hi <@bot:example.org>', 'm.mentions': { user_ids: ['@bot:example.org'] } }));
  ok(mentioned.message.addressed && mentioned.message.mentioned);
  const command = funnel(event({}, { body: '/help' }));
  ok(command.message.addressed && !command.message.mentioned);
  const replied = funnel(event({}, {
    body: 'follow up',
    'm.relates_to': { 'm.in_reply_to': { event_id: '$orig:example.org' } },
  }));
  ok(replied.message.addressed, 'a reply relation counts as addressed');
  deepStrictEqual(replied.message.replyTarget,
    { roomId: ROOM, recipientUserId: '@alice:example.org', replyToEventId: '$orig:example.org' });
  const threaded = funnel(event({}, {
    body: 'hi <@bot:example.org>',
    'm.mentions': { user_ids: ['@BOT:Example.ORG'] },
    'm.relates_to': { chain: [{ event_id: '$threadA:example.org', rel_type: 'm.thread' }] },
  }));
  deepStrictEqual(threaded.message.threadId, '$threadA:example.org');
  deepStrictEqual(threaded.message.conversationId, 'room:!roomA:example.org$$threadA:example.org');
  deepStrictEqual(threaded.message.contextSource(), { chatId: ROOM, threadId: '$threadA:example.org' });
  const free = funnel(event(), { config: { freeResponseRooms: new Set([ROOM]) } });
  ok(free.message, 'a free-response room skips the mention gate');
  const gated = funnel(event({ sender: '@alice:other.org' }), { config: { allowedRooms: new Set(['!other:example.org']) } });
  deepStrictEqual(gated, { drop: 'room-not-allowed' });
  const dm = funnel(event({}, { body: '你好' }), { isDirect: true });
  ok(dm.message.addressed && dm.message.conversationId === 'dm:@alice:example.org');
  ok(dm.message.connectionTestTarget && dm.message.connectionTestTarget.roomId === ROOM);
});

test('delivery targets round-trip through the conversation-key grammar', () => {
  deepStrictEqual(normalizeMatrixDeliveryTarget({ kind: 'room', route: { roomId: ROOM } }),
    { value: { kind: 'room', roomId: ROOM } });
  deepStrictEqual(normalizeMatrixDeliveryTarget({ kind: 'thread', route: { roomId: ROOM, threadId: '$t:x.org' } }),
    { value: { kind: 'thread', roomId: ROOM, threadId: '$t:x.org' } });
  deepStrictEqual(normalizeMatrixDeliveryTarget({ kind: 'dm', route: { userId: '@Alice:Example.ORG' } }),
    { value: { kind: 'dm', userId: '@Alice:Example.ORG' } });
  deepStrictEqual(normalizeMatrixDeliveryTarget({ kind: 'dm', route: { userId: '@u:x.org', extra: 1 } }),
    { error: 'route' });
  deepStrictEqual(normalizeMatrixDeliveryTarget({ kind: 'dm', route: { userId: 'garbage' } }),
    { error: 'userId' });
  deepStrictEqual(normalizeMatrixDeliveryTarget({ kind: 'dm', route: {} }), { error: 'route' });
  deepStrictEqual(normalizeMatrixDeliveryTarget({ kind: 'room', route: { roomId: 'not-a-room' } }),
    { error: 'roomId' });
  deepStrictEqual(normalizeMatrixDeliveryTarget({ kind: 'unknown', route: {} }), { error: 'kind' });
  deepStrictEqual(
    matrixConversationKeyFromTarget({ kind: 'dm', userId: '@Alice:Example.ORG' }),
    'dm:@alice:example.org',
  );
  deepStrictEqual(
    matrixConversationKeyFromTarget({ kind: 'thread', roomId: ROOM, threadId: '$t:x.org' }),
    'room:!roomA:example.org$$t:x.org',
  );
});
