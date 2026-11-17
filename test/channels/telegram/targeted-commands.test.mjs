import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeTelegramUpdate } from '../../../src/channels/telegram/telegram-runtime.mjs';
import { normalizeGroupTriggers } from '../../../src/channels/telegram/group-triggers.mjs';

const GROUP = '-1001234567890';
const BOT_ID = '999';
const USERNAME = 'thisbot';
// Telegram puts the `@bot` suffix of a targeted command inside the same
// `bot_command` entity instead of emitting a separate `mention` entity.
const mentionOnlyRules = normalizeGroupTriggers({ version: 1, defaults: { mode: 'mention' } });

function update({ text = 'hello', entities, chatType = 'supergroup' } = {}) {
  return {
    update_id: 10,
    message: {
      message_id: 20,
      chat: { id: Number(GROUP), type: chatType, title: 'Team' },
      from: { id: 111, first_name: 'Ann', is_bot: false },
      text,
      ...(entities ? { entities } : {}),
    },
  };
}

function normalize(messageUpdate) {
  return normalizeTelegramUpdate(messageUpdate, {
    botId: BOT_ID,
    username: USERNAME,
    groupTriggers: mentionOnlyRules,
  });
}

function botCommand(text) {
  return [{ type: 'bot_command', offset: 0, length: text.length }];
}

test('a command targeted at this bot addresses it in a mention-only group', () => {
  const text = '/menu@thisbot';
  const message = normalize(update({ text, entities: botCommand(text) }));
  assert.equal(message.addressed, true, '`/menu@thisbot` must wake this bot');
  assert.equal(message.content, '/menu', 'the local command keeps its bare form');
});

test('a targeted /start addresses this bot in a mention-only group', () => {
  const text = '/start@thisbot';
  const message = normalize(update({ text, entities: botCommand(text) }));
  assert.equal(message.addressed, true, '`/start@thisbot` must wake this bot');
  assert.equal(message.content, '/start');
});

test('commands targeted at another bot never address this bot', () => {
  for (const text of ['/menu@otherbot', '/start@otherbot']) {
    const message = normalize(update({ text, entities: botCommand(text) }));
    assert.equal(message.addressed, false, `${text} belongs to the other bot`);
    assert.equal(message.content, text, 'another bot\'s command is not rewritten');
  }
});

test('an @mention in ordinary text still tags this bot and is stripped', () => {
  const text = '@thisbot 你好';
  const message = normalize(update({
    text,
    entities: [{ type: 'mention', offset: 0, length: '@thisbot'.length }],
  }));
  assert.equal(message.addressed, true);
  assert.equal(message.content, '你好');
});

test('ordinary text without a mention still stays silent in a mention-only group', () => {
  assert.equal(normalize(update({ text: 'hello team' })).addressed, false);
  // A slash command for a bot that is not this one is ordinary text, too.
  assert.equal(normalize(update({
    text: '/menu@otherbot',
    entities: botCommand('/menu@otherbot'),
  })).addressed, false);
});
