import assert from 'node:assert/strict';
import test from 'node:test';
import { beginStatusReaction } from '../../../src/channels/shared/status-reaction.mjs';

test('status reaction replaces processing with the successful terminal reaction in order', async () => {
  const calls = [];
  const status = {};
  const reaction = beginStatusReaction({
    adapter: {
      addReaction: async (target, emoji) => {
        calls.push(['add', target, emoji]);
        return `key:${emoji}`;
      },
      removeReaction: async (target, key) => calls.push(['remove', target, key]),
    },
    target: 'source-message',
    reactions: { processing: 'eyes', success: 'done', error: 'error' },
    status,
    logger: { warn() {} },
  });

  reaction.success();
  await reaction.settled();

  assert.deepEqual(calls, [
    ['add', 'source-message', 'eyes'],
    ['remove', 'source-message', 'key:eyes'],
    ['add', 'source-message', 'done'],
  ]);
  assert.equal(status.reactionsAdded, 2);
  assert.equal(status.reactionsRemoved, 1);
  assert.equal(status.reactionErrors ?? 0, 0);
});

test('status reaction has a hard timeout and absorbs provider failures', async () => {
  const status = {};
  const warnings = [];
  const reaction = beginStatusReaction({
    adapter: {
      addReaction: () => new Promise(() => {}),
      removeReaction: async () => undefined,
    },
    target: 'source-message',
    reactions: { processing: 'eyes', success: 'done', error: 'error' },
    status,
    logger: { warn: (...args) => warnings.push(args) },
    timeoutMs: 20,
  });

  reaction.error();
  await reaction.settled();

  assert.equal(status.reactionErrors, 2);
  assert.equal(status.reactionsAdded ?? 0, 0);
  assert.equal(warnings.length, 2);
});

test('the first terminal reaction wins', async () => {
  const added = [];
  const reaction = beginStatusReaction({
    adapter: {
      addReaction: async (_target, emoji) => {
        added.push(emoji);
        return emoji;
      },
      removeReaction: async () => undefined,
    },
    target: 'source-message',
    reactions: { processing: 'eyes', success: 'done', error: 'error' },
    logger: { warn() {} },
  });

  reaction.error();
  reaction.success();
  reaction.clear();
  await reaction.settled();

  assert.deepEqual(added, ['eyes', 'error']);
});
