import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { runHistoryCommand } from '../src/channels/shared/history-command.mjs';
import { getImHostLanguage, setImHostLanguage, t } from '../src/channels/shared/i18n.mjs';

let previousLanguage;
beforeEach(() => {
  previousLanguage = getImHostLanguage();
  setImHostLanguage('en');
});
afterEach(() => setImHostLanguage(previousLanguage));

function entry(seq, type, data) {
  return { event: { seq, type, data, surfaceOp: 'append' } };
}

function user(seq, content) {
  return entry(seq, 'user/message', { source: { kind: 'user' }, content });
}

function assistant(seq, turn, content) {
  return entry(seq, 'assistant/message', { turn, message: { content } });
}

function end(seq, turn) {
  return entry(seq, 'turn/end', { turn, reason: { kind: 'completed' } });
}

function textBlock(text) {
  return { type: 'text', text };
}

function run(text, { events = [], error, sessionId = 'history-test', ...options } = {}) {
  return runHistoryCommand(text, {
    workspaceSession() {
      return {
        async readHistory() {
          if (error) throw error;
          return { events, hasMore: false };
        },
      };
    },
  }, { sessionFor: () => sessionId }, 'direct:test', { isDirect: true, ...options });
}

test('/history English preview translates labels, truncation, and media placeholders', async () => {
  const result = await run('/history', {
    events: [
      user(1, [textBlock('Earlier user message')]),
      assistant(2, 1, [textBlock('Earlier assistant answer')]),
      end(3, 1),
      user(4, [textBlock('Recent user message'), { type: 'image' }, { type: 'file' }]),
      assistant(5, 2, [textBlock('Long final answer. '.repeat(100))]),
      end(6, 2),
    ],
  });
  assert.match(result.message, /^Session history \| history-test \| Recent messages: 3/);
  assert.match(result.message, /1\. Assistant\nEarlier assistant answer/);
  assert.match(result.message, /2\. User\nRecent user message\n\[Image\]\n\[File\]/);
  assert.match(result.message, /3\. Assistant\nLong final answer\./);
  assert.match(result.message, / \(truncated\)/);
  assert.ok(result.message.endsWith('These are history records, not a new reply.'));
  assert.doesNotMatch(result.message, /Earlier user message|[一-鿿]/);
  assert.ok(result.messages.length <= 3);
});

test('/history English usage covers the indirect HISTORY_USAGE translation key', async () => {
  for (const command of ['/history 0', '/history -1', '/history 1.5', '/history abc', '/history 1 2']) {
    assert.equal((await run(command)).message, 'Usage: /history [count] (default 3, maximum 5)');
  }
  assert.equal(
    t('/history [数量]  查看最近历史消息（默认 3 条，最多 5 条）'),
    '/history [count]  Preview recent messages (default 3, maximum 5)',
  );
  assert.equal(t('发送 /history 查看最近对话。'), 'Send /history to preview recent conversation messages.');
});

test('/history English validation and empty-history messages never fall back to Chinese', async () => {
  assert.equal((await run('/history', { isDirect: false })).message, 'Please use /history in a direct chat with the bot.');
  for (const options of [{ hasImages: true }, { hasFiles: true }]) {
    assert.equal((await run('/history', options)).message, '/history supports text commands only. Remove images or files and try again.');
  }
  assert.equal((await run('/history', { sessionId: null })).message, 'This chat has no bound Session. Send a message or use /session to bind one first.');
  assert.equal((await run('/history')).message, 'This Session has no history messages available to preview yet.');
  const result = await run('/history', {
    events: [assistant(1, 1, []), end(2, 1)],
  });
  assert.match(result.message, /1\. Assistant\nThis message has no text to preview\./);
  assert.match(result.message, /Messages available to preview in this Session: 1\./);
  assert.doesNotMatch(result.message, /[一-鿿]/);
});

test('/history English errors preserve safe messages and hide raw details', async () => {
  const cases = [
    [{ code: 'session-not-found' }, 'The Session bound to this chat no longer exists. Please bind a Session again.'],
    [{ code: 'workspace-session-stale' }, 'The Session, workspace, or bot state has changed. Please run /history again.'],
    [{ code: 'workspace-bot-not-found' }, 'The Session, workspace, or bot state has changed. Please run /history again.'],
    [{ code: 'session-binding-changed' }, 'The Session, workspace, or bot state has changed. Please run /history again.'],
    [{ code: 'harness-api-not-found' }, 'This Harness does not support reading Session history.'],
    [{ name: 'AbortError' }, 'History reading was cancelled.'],
    [{ name: 'TimeoutError' }, 'Reading history timed out. Please try again later.'],
    [{ code: 'harness-timeout' }, 'Reading history timed out. Please try again later.'],
    [{}, 'Unable to read Session history right now. Please try again later.'],
  ];
  for (const [properties, expected] of cases) {
    const error = Object.assign(new Error('private upstream history details'), properties);
    assert.equal((await run('/history', { error })).message, expected);
  }
});
