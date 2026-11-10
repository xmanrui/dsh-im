import test from 'node:test';
import assert from 'node:assert/strict';
import { createInboundReferenceRegistry } from '../src/channels/shared/inbound-reference-registry.mjs';

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
