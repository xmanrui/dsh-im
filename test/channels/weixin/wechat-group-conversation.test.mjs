import assert from 'node:assert/strict';
import test from 'node:test';

import {
  conversationKey,
  weixinConversation,
} from '../../../src/channels/weixin/wechat-group-conversation.mjs';

function groupMessage(overrides = {}) {
  return {
    source: 'uia-wechat-group/v1',
    message_id: 'group-message-1',
    message_type: 1,
    conversation_type: 'group',
    conversation_id: 'uia_group_alpha',
    conversation_title: 'Alpha Group',
    from_user_id: 'uia-name:Alice',
    sender_name: 'Alice',
    reply_target: 'uia_group_alpha',
    addressed: true,
    text: 'hello',
    raw_text: '/dsh hello',
    sent_at: 1_793_000_000_000,
    is_self: false,
    item_list: [{ type: 1, text_item: { text: 'hello' } }],
    ...overrides,
  };
}

test('weixinConversation preserves the legacy direct p2p route', () => {
  const direct = {
    message_id: 'direct-1',
    message_type: 1,
    from_user_id: 'owner-user',
    item_list: [{ type: 1, text_item: { text: 'hello' } }],
  };
  assert.deepEqual(weixinConversation(direct), {
    kind: 'direct',
    chatId: 'owner-user',
    senderId: 'owner-user',
    replyTarget: 'owner-user',
    addressed: true,
  });
  assert.equal(conversationKey(direct), 'p2p:owner-user');
});

test('weixinConversation normalizes a complete v1 group event without conflating member and target', () => {
  const group = groupMessage();
  assert.deepEqual(weixinConversation(group), {
    kind: 'group',
    chatId: 'uia_group_alpha',
    senderId: 'uia-name:Alice',
    senderName: 'Alice',
    conversationTitle: 'Alpha Group',
    replyTarget: 'uia_group_alpha',
    addressed: true,
  });
  assert.equal(conversationKey(group), 'group:uia_group_alpha');
});

test('weixinConversation fails closed for unknown sources and direct events masquerading as v1 groups', () => {
  assert.equal(weixinConversation(groupMessage({ source: 'iLink/group/v1' })), null);
  assert.equal(weixinConversation(groupMessage({ source: 'uia-wechat-group/v2' })), null);
  assert.equal(weixinConversation(groupMessage({ conversation_type: 'direct' })), null);
  assert.equal(weixinConversation({
    message_id: 'direct-unknown-source',
    from_user_id: 'owner-user',
    source: 'unknown',
    item_list: [{ type: 1, text_item: { text: 'hello' } }],
  }), null);
});

test('weixinConversation rejects every missing or malformed required v1 field', () => {
  const invalidEvents = [
    ['message_id', ''],
    ['message_type', 2],
    ['conversation_id', ''],
    ['conversation_title', ''],
    ['from_user_id', ''],
    ['sender_name', ''],
    ['reply_target', ''],
    ['reply_target', 'uia_group_other'],
    ['addressed', false],
    ['addressed', 'true'],
    ['text', ''],
    ['text', 1],
    ['raw_text', ''],
    ['sent_at', '1793000000000'],
    ['sent_at', -1],
    ['sent_at', 1.5],
    ['is_self', 'false'],
    ['item_list', []],
    ['item_list', [{ type: 1, text_item: { text: 'different' } }]],
    ['item_list', [{ type: 3, voice_item: { text: 'hello' } }]],
  ];
  for (const [field, value] of invalidEvents) {
    const event = groupMessage({ [field]: value });
    assert.equal(weixinConversation(event), null, field + ' must fail closed');
    assert.equal(conversationKey(event), null, field + ' must not produce a Session key');
  }
  for (const field of [
    'message_id', 'conversation_id', 'conversation_title', 'from_user_id',
    'sender_name', 'reply_target', 'addressed', 'text', 'raw_text', 'sent_at',
    'is_self', 'item_list',
  ]) {
    const event = groupMessage();
    delete event[field];
    assert.equal(weixinConversation(event), null, 'missing ' + field + ' must fail closed');
  }
  assert.equal(weixinConversation({ message_id: 'missing-sender' }), null);
  assert.equal(conversationKey({ message_id: 'missing-sender' }), null);
});
