import assert from 'node:assert/strict';
import test from 'node:test';

import {
  conversationKeyMatchesTarget,
  deliverySuggestionFromConversationKey,
  privateConversationKeyMatchesTarget,
  privateDeliverySuggestionFromConversationKey,
  resolveConversationKey,
  resolvePrivateConversationKey,
} from '../plugin-src/host/delivery-suggestions.mjs';

const TOPIC_TARGET = { kind: 'topic', route: { chatId: '-1001234567890', messageThreadId: 42 } };
const CHAT_TARGET = { kind: 'chat', route: { chatId: '88' } };

test('a Telegram forum topic key matches its own topic target only', () => {
  const key = 'group:-1001234567890:42';
  assert.deepEqual(deliverySuggestionFromConversationKey('telegram', key), TOPIC_TARGET);
  assert.equal(conversationKeyMatchesTarget('telegram', key, TOPIC_TARGET), true);
  assert.equal(conversationKeyMatchesTarget('telegram', key, CHAT_TARGET), false);
  assert.equal(conversationKeyMatchesTarget('telegram', 'group:-1001234567890', TOPIC_TARGET), false,
    'a thread id is part of the route');
  assert.equal(conversationKeyMatchesTarget('telegram', key, { ...TOPIC_TARGET, targetId: 'daily' }), true,
    'targetId and name are not part of the route identity');
  assert.equal(conversationKeyMatchesTarget('telegram', key, {
    kind: 'topic',
    route: { chatId: '-1001234567890', messageThreadId: 43 },
  }), false);
});

test('Session sync resolves a topic conversation key the same way as a private one', () => {
  const sessions = {
    'direct:88': 'session-private',
    'group:-1001234567890:42': 'session-topic',
    'direct:99': 'session-other',
  };
  assert.equal(resolveConversationKey('telegram', sessions, TOPIC_TARGET), 'group:-1001234567890:42');
  assert.equal(resolveConversationKey('telegram', sessions, CHAT_TARGET), 'direct:88');
  assert.equal(resolveConversationKey('telegram', sessions, {
    kind: 'topic', route: { chatId: '-1001234567890', messageThreadId: 7 },
  }), null, 'an unknown topic cannot be enabled');
  assert.equal(resolveConversationKey('telegram', {}, TOPIC_TARGET), null);
  assert.equal(resolveConversationKey('unknown', sessions, TOPIC_TARGET), null);
  assert.equal(resolveConversationKey('telegram', null, TOPIC_TARGET), null);
});

test('group, thread, and channel routes resolve beyond private chat', () => {
  const slackThread = { kind: 'thread', route: { channelId: 'C123', threadTs: '1712345678.123456' } };
  assert.equal(
    resolveConversationKey('slack', { 'group:C123:1712345678.123456': 'session-thread' }, slackThread),
    'group:C123:1712345678.123456',
  );
  const discordChannel = { kind: 'channel', route: { channelId: '123456789012345678' } };
  assert.equal(
    resolveConversationKey('discord', { 'group:123456789012345678': 'session-channel' }, discordChannel),
    'group:123456789012345678',
  );
  const feishuGroup = { kind: 'group', route: { chatId: 'oc_group' } };
  assert.equal(
    resolveConversationKey('feishu', { 'group:oc_group': 'session-group' }, feishuGroup),
    'group:oc_group',
  );
});

test('an ambiguous route refuses to resolve instead of guessing', () => {
  const sessions = {
    'direct:88': 'session-private',
    'group:88': 'session-duplicate-chat',
  };
  // Both keys describe the Telegram chat 88, so neither can be chosen safely.
  assert.equal(resolveConversationKey('telegram', sessions, CHAT_TARGET), null);
  assert.equal(privateConversationKeyMatchesTarget('telegram', 'direct:88', CHAT_TARGET), true);
});

test('the private helpers stay private-chat only, as the target hints need', () => {
  assert.equal(privateDeliverySuggestionFromConversationKey('telegram', 'group:-100:42'), null);
  assert.equal(privateConversationKeyMatchesTarget('telegram', 'group:-100:42', TOPIC_TARGET), false);
  assert.equal(resolvePrivateConversationKey('telegram', {
    'group:-100:42': 'session-topic',
    'direct:88': 'session-private',
  }, TOPIC_TARGET), null);
  assert.equal(conversationKeyMatchesTarget('telegram', 'direct:88', TOPIC_TARGET), false);
});
