import test from 'node:test';
import assert from 'node:assert/strict';
import { createInboundReferenceRegistry, referenceFromSemanticMessage } from '../src/channels/shared/inbound-reference-registry.mjs';

test('correlates provider references with the exact session and prompt', () => {
  const registry = createInboundReferenceRegistry();
  const source = { channel: 'feishu', botId: 'bot', chatId: 'chat', messageId: 'reply', replyToMessageId: 'original' };
  registry.record('session-a', 'rpc-a', source);
  assert.deepEqual(registry.get('session-a', 'rpc-a'), source);
  assert.equal(registry.get('session-b', 'rpc-a'), undefined);
  assert.equal(registry.get('session-a', 'rpc-b'), undefined);
  source.replyToMessageId = 'changed';
  assert.equal(registry.get('session-a', 'rpc-a').replyToMessageId, 'original');
});

test('missing identifiers never fabricate a reference and entries expire', () => {
  let now = 0;
  const registry = createInboundReferenceRegistry({ now: () => now, ttlMs: 10 });
  registry.record('session', 'rpc', { channel: 'feishu', botId: 'bot', chatId: 'chat', messageId: 'reply' });
  assert.equal(registry.get('session', 'rpc'), undefined);
  registry.record('session', 'rpc', { channel: 'feishu', botId: 'bot', chatId: 'chat', messageId: 'reply', replyToMessageId: 'original' });
  now = 11;
  assert.equal(registry.get('session', 'rpc'), undefined);
});

test('interleaved prompts never overwrite or claim each other; storage is bounded', () => {
  const registry = createInboundReferenceRegistry({ maxEntries: 2 });
  const base = { channel: 'feishu', botId: 'bot', chatId: 'chat', messageId: 'one', replyToMessageId: 'first' };
  registry.record('session', 'one', base);
  registry.record('session', 'two', { ...base, messageId: 'two', replyToMessageId: 'second' });
  registry.record('session', 'one', { ...base, replyToMessageId: 'wrong' });
  assert.equal(registry.get('session', 'one').replyToMessageId, 'first');
  assert.equal(registry.get('session', 'two').replyToMessageId, 'second');
  registry.record('other', 'three', base);
  assert.equal(registry.get('session', 'one'), undefined);
  assert.equal(registry.get('session', 'two').replyToMessageId, 'second');
});

test('shared channels preserve provider identifier types and distinguish thread roots', () => {
  const registry = createInboundReferenceRegistry();
  const cases = [
    ['telegram', { messageId: 'update-id', replyTarget: { replyToMessageId: 43 }, replyTo: { messageId: '42' } }, '43', '42', 'reply'],
    ['whatsapp', { messageId: 'composite', providerMessageId: 'provider', replyTo: { messageId: 'parent' } }, 'provider', 'parent', 'reply'],
    ['slack', { messageId: 'event-id', reactionTarget: { messageTs: 'timestamp' }, replyTo: { messageId: 'root' } }, 'timestamp', 'root', 'thread-root'],
    ['matrix', { messageId: '$event', replyToEventId: '$parent' }, '$event', '$parent', 'reply'],
  ];
  for (const [channel, message, current, target, relationKind] of cases) {
    registry.record('session', channel, referenceFromSemanticMessage(channel, { ...message, conversationId: 'chat' }));
    assert.deepEqual(registry.get('session', channel), { channel, chatId: 'chat', messageId: current, replyToMessageId: target, relationKind });
  }
  registry.record('session', 'cross-chat', referenceFromSemanticMessage('discord', {
    conversationId: 'chat', messageId: 'reply', replyTo: { messageId: 'other', unavailableReason: 'not-found' },
  }));
  assert.equal(registry.get('session', 'cross-chat'), undefined);
});
