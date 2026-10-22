import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTION_CARD_CALLBACK_MAX_BYTES,
  ACTION_CARD_STATUS,
  ActionCardRegistry,
  actionCardStateText,
  createActionNonce,
  createCallbackNamespace,
} from '../../../src/channels/shared/action-card.mjs';

function fakeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) { current += ms; },
  };
}

test('the versioned callback namespace round-trips and rejects everything else', () => {
  const namespace = createCallbackNamespace('ap1');
  const data = namespace.encode({ nonce: 'abcd1234EFGH', action: 'a' });
  assert.equal(data, 'ap1|abcd1234EFGH|a');
  assert.deepEqual(namespace.parse(data), { nonce: 'abcd1234EFGH', action: 'a' });
  assert.equal(namespace.maxBytes, ACTION_CARD_CALLBACK_MAX_BYTES);
  assert.equal(ACTION_CARD_CALLBACK_MAX_BYTES, 64);

  for (const invalid of [
    '',
    'ap1',
    'ap1|nonce',
    'ap1|nonce|a|extra',
    'ap2|nonce|a',
    'ap1||a',
    'ap1|nonce|',
    'ap1|nonce|approve!',
    'ap1|n once|a',
    null,
    undefined,
    7,
  ]) {
    assert.equal(namespace.parse(invalid), null, `foreign payload rejected: ${String(invalid)}`);
  }

  assert.throws(
    () => namespace.encode({ nonce: '', action: 'a' }),
    /nonce is invalid/u,
  );
  assert.throws(
    () => namespace.encode({ nonce: 'n', action: 'approve!' }),
    /action is invalid/u,
  );
  assert.throws(
    () => createCallbackNamespace('Bad Prefix'),
    /prefix is invalid/u,
  );
  assert.throws(
    () => createCallbackNamespace('x'.repeat(9)),
    /prefix is invalid/u,
  );
});

test('the widest tokens still fit the Telegram callback budget', () => {
  const namespace = createCallbackNamespace('abcdefgh');
  const data = namespace.encode({ nonce: 'n'.repeat(32), action: 'a'.repeat(16) });
  assert.ok(
    Buffer.byteLength(data, 'utf8') <= ACTION_CARD_CALLBACK_MAX_BYTES,
    `callback data must fit 64 UTF-8 bytes, got ${Buffer.byteLength(data, 'utf8')}`,
  );
  assert.deepEqual(namespace.parse(data), {
    nonce: 'n'.repeat(32),
    action: 'a'.repeat(16),
  });
});

test('nonces are unique, URL-safe and short enough for a callback', () => {
  const nonces = new Set(Array.from({ length: 64 }, () => createActionNonce()));
  assert.equal(nonces.size, 64);
  for (const nonce of nonces) {
    assert.match(nonce, /^[A-Za-z0-9_-]{8,32}$/u);
    assert.ok(Buffer.byteLength(nonce, 'utf8') < 33);
  }
});

test('a press is claimed synchronously so only the first one wins', () => {
  const clock = fakeClock();
  const registry = new ActionCardRegistry({
    now: clock.now,
    createNonce: () => 'nonce-one',
  });
  const entry = registry.issue({
    conversationKey: 'direct:42',
    kind: 'approval',
    payload: { approvalId: 'approval-one', actor: 'actor-a' },
  });
  assert.equal(entry.nonce, 'nonce-one');
  assert.equal(entry.status, ACTION_CARD_STATUS.ACTIVE);

  const first = registry.claim('nonce-one');
  assert.equal(first.status, ACTION_CARD_STATUS.ACTIVE);
  assert.deepEqual(first.entry.payload, { approvalId: 'approval-one', actor: 'actor-a' });

  // No await in between: the second press is told the card is already claimed.
  const second = registry.claim('nonce-one');
  assert.equal(second.status, ACTION_CARD_STATUS.CLAIMED);
  assert.equal(second.entry.status, ACTION_CARD_STATUS.CLAIMED);
  assert.equal(registry.claim('missing').status, ACTION_CARD_STATUS.UNKNOWN);
});

test('a claimed card can be settled from a live recheck or resolved', () => {
  const registry = new ActionCardRegistry({ createNonce: () => 'nonce-one' });
  registry.issue({ conversationKey: 'direct:42', payload: { approvalId: 'approval-one' } });
  registry.claim('nonce-one');

  assert.equal(
    registry.settle('nonce-one', ACTION_CARD_STATUS.STALE),
    true,
    'a failed recheck must be able to retire the pressed card',
  );
  assert.equal(registry.claim('nonce-one').status, ACTION_CARD_STATUS.STALE);
  assert.equal(registry.settle('nonce-one', ACTION_CARD_STATUS.RESOLVED), false);
  assert.equal(registry.settle('missing', ACTION_CARD_STATUS.RESOLVED), false);
});

test('a card expires on its own TTL and sweeping drops the stale entry', () => {
  const clock = fakeClock();
  const registry = new ActionCardRegistry({
    now: clock.now,
    ttlMs: 50,
    createNonce: () => 'nonce-one',
  });
  registry.issue({ conversationKey: 'direct:42' });
  assert.equal(registry.claim('nonce-one').status, ACTION_CARD_STATUS.ACTIVE);

  clock.advance(50);
  assert.equal(registry.claim('nonce-one').status, ACTION_CARD_STATUS.EXPIRED);
  assert.equal(registry.size, 1, 'a terminal entry sticks around for one last stale toast');
  assert.equal(registry.purge(), 1);
  assert.equal(registry.get('nonce-one'), null);
  assert.equal(registry.size, 0);
});

test('one conversation keeps a single live card and supersedes the old one', () => {
  const registry = new ActionCardRegistry({
    createNonce: (() => {
      let index = 0;
      return () => `nonce-${++index}`;
    })(),
  });
  const first = registry.issue({ conversationKey: 'group:9', kind: 'menu' });
  const second = registry.issue({ conversationKey: 'group:9', kind: 'menu' });
  assert.equal(first.status, ACTION_CARD_STATUS.SUPERSEDED);
  assert.equal(registry.activeFor('group:9').nonce, second.nonce);

  const press = registry.claim(first.nonce);
  assert.equal(press.status, ACTION_CARD_STATUS.SUPERSEDED);
  assert.ok(actionCardStateText(press.status).length > 0);
});

test('capacity evicts the oldest card instead of growing without bound', () => {
  const registry = new ActionCardRegistry({
    maxEntries: 2,
    createNonce: (() => {
      let index = 0;
      return () => `nonce-${++index}`;
    })(),
  });
  for (const key of ['a', 'b', 'c']) registry.issue({ conversationKey: `direct:${key}` });
  assert.equal(registry.size, 2);
  assert.equal(registry.get('nonce-1'), null);
  assert.equal(registry.get('nonce-3').conversationKey, 'direct:c');
});

test('every card state has a non-empty unified notice and channels can override it', () => {
  for (const status of Object.values(ACTION_CARD_STATUS)) {
    assert.equal(typeof actionCardStateText(status), 'string');
    assert.ok(actionCardStateText(status).length > 0, status);
  }
  assert.equal(
    actionCardStateText(ACTION_CARD_STATUS.EXPIRED, { expired: '这张卡过期了' }),
    '这张卡过期了',
  );
  assert.equal(actionCardStateText('made-up'), actionCardStateText(ACTION_CARD_STATUS.UNKNOWN));
});
