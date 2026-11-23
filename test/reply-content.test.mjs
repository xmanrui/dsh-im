import assert from 'node:assert/strict';
import test from 'node:test';
import { selectProgressUpdates } from '../src/channels/shared/harness-client.mjs';
import {
  DEFAULT_REPLY_CONTENT,
  allowsReplyContent,
  filtersProcessContent,
  isDefaultReplyContent,
  normalizeReplyContent,
  replyContentFinalAnswerOnly,
  validateReplyContent,
} from '../src/channels/shared/reply-content.mjs';

test('reply content keeps the full turn when nothing is configured', () => {
  assert.deepEqual({ ...normalizeReplyContent(undefined) }, { narration: true, tools: true, thinking: true });
  assert.equal(filtersProcessContent(undefined), false);
  assert.equal(replyContentFinalAnswerOnly(undefined), false);
  assert.equal(isDefaultReplyContent(undefined), true);
  assert.deepEqual({ ...DEFAULT_REPLY_CONTENT }, { narration: true, tools: true, thinking: true });
});

test('a single switch is enough to filter, and every key stays independent', () => {
  const answerOnly = normalizeReplyContent({ narration: false });
  assert.equal(filtersProcessContent(answerOnly), true);
  assert.equal(replyContentFinalAnswerOnly(answerOnly), true);
  assert.equal(allowsReplyContent(answerOnly, 'narration'), false);
  assert.equal(allowsReplyContent(answerOnly, 'tools'), true);
  assert.equal(allowsReplyContent(answerOnly, 'thinking'), true);

  const toolsOnly = normalizeReplyContent({ narration: false, thinking: false });
  assert.equal(allowsReplyContent(toolsOnly, 'tools'), true);
  assert.equal(isDefaultReplyContent(toolsOnly), false);

  // Hiding tools must not change how the answer is extracted.
  assert.equal(replyContentFinalAnswerOnly({ tools: false }), false);
});

test('damaged values fall back per key instead of silencing the bot', () => {
  const damaged = normalizeReplyContent({ narration: 'false', tools: 0, thinking: true });
  assert.deepEqual({ ...damaged }, { narration: true, tools: true, thinking: true });
  assert.deepEqual({ ...normalizeReplyContent([]) }, { ...DEFAULT_REPLY_CONTENT });
  assert.deepEqual({ ...normalizeReplyContent(null) }, { ...DEFAULT_REPLY_CONTENT });
});

test('the settings endpoint only accepts a complete boolean set', () => {
  assert.deepEqual({ ...validateReplyContent({ narration: false, tools: true, thinking: true }) },
    { narration: false, tools: true, thinking: true });
  for (const invalid of [
    undefined, null, [], {}, { narration: false },
    { narration: false, tools: true, thinking: true, extra: true },
    { narration: 'false', tools: true, thinking: true },
  ]) {
    assert.throws(() => validateReplyContent(invalid), (error) => error.code === 'reply-content-invalid');
  }
});

test('latest mode filters by the bot switches before it keeps the last update', () => {
  const updates = [
    { type: 'text', text: 'Checking' },
    { type: 'tool', name: 'bash' },
  ];
  // The tool update is hidden, so it must not take the single "latest" slot and
  // drop the allowed narration text that arrived in the same poll.
  assert.deepEqual(
    selectProgressUpdates(updates, {
      mode: 'latest',
      replyContent: { narration: true, tools: false, thinking: true },
    }).map((update) => update.type),
    ['text'],
  );
  assert.deepEqual(
    selectProgressUpdates(updates, {
      mode: 'latest',
      replyContent: { narration: false, tools: false, thinking: true },
    }),
    [],
  );
  assert.deepEqual(
    selectProgressUpdates(updates, {
      mode: 'all',
      replyContent: { narration: false, tools: true, thinking: true },
    }).map((update) => update.type),
    ['tool'],
  );
});

