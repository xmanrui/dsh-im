import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GROUP_TRIGGER_DEFAULT_SCOPE,
  GROUP_TRIGGER_MODES,
  groupTriggerAddressed,
  groupTriggerModeFor,
  groupTriggersSettings,
  normalizeGroupTriggers,
  parseGroupReference,
  resolveGroupReference,
} from '../../../src/channels/telegram/group-triggers.mjs';
import { normalizeTelegramUpdate } from '../../../src/channels/telegram/telegram-runtime.mjs';

const GROUP = '-1001234567890';

function update({ chatId = GROUP, chatType = 'supergroup', senderId = 111, text = 'hello', mention = false } = {}) {
  return {
    update_id: 10,
    message: {
      message_id: 20,
      chat: { id: Number(chatId), type: chatType, title: 'Team' },
      from: { id: senderId, first_name: 'Ann', is_bot: false },
      text: mention ? '@harness_bot hello' : text,
      ...(mention ? { entities: [{ type: 'mention', offset: 0, length: 12 }] } : {}),
    },
  };
}

test('normalization defaults to "mention" and tolerates junk', () => {
  const empty = normalizeGroupTriggers(undefined);
  assert.equal(empty.version, 1);
  assert.deepEqual(empty.defaults, GROUP_TRIGGER_DEFAULT_SCOPE);
  assert.deepEqual(empty.groups, {});
  assert.deepEqual(empty.hiddenGroupIds, []);

  const junk = normalizeGroupTriggers({
    defaults: { mode: 'everything', senders: [' 42 ', 42, '42'] },
    groups: { [GROUP]: { mode: 'all-list', senders: [7, '8'] }, '': { mode: 'all' } },
    hiddenGroupIds: ['  ', 'x', 'x'],
  });
  assert.equal(junk.defaults.mode, 'mention');
  assert.deepEqual(junk.defaults.senders, ['42']);
  assert.deepEqual(junk.groups[GROUP], { mode: 'all-list', senders: ['7', '8'] });
  assert.deepEqual(Object.keys(junk.groups), [GROUP]);
  assert.deepEqual(junk.hiddenGroupIds, ['x']);
});

test('every mode decides group messages as specified', () => {
  const config = normalizeGroupTriggers({
    defaults: { mode: 'off' },
    groups: {
      '-1': { mode: 'off' },
      '-2': { mode: 'mention' },
      '-3': { mode: 'mention-list', senders: ['111'] },
      '-4': { mode: 'all' },
      '-5': { mode: 'all-list', senders: ['111'] },
      '-6': { mode: 'all-list', senders: [] },
    },
  });
  const addressed = (chatId, senderId, tagged) => groupTriggerAddressed(config, {
    chatId, senderId, tagged,
  });
  assert.equal(addressed('-1', '111', true), false, 'off ignores even a mention');
  assert.equal(addressed('-2', '111', true), true, 'mention accepts anyone');
  assert.equal(addressed('-2', '111', false), false);
  assert.equal(addressed('-3', '111', true), true, 'listed member may mention');
  assert.equal(addressed('-3', '111', false), false, 'listed member still needs the tag');
  assert.equal(addressed('-3', '222', true), false, 'unlisted member is ignored');
  assert.equal(addressed('-4', '222', false), true, 'all accepts anyone untagged');
  assert.equal(addressed('-5', '111', false), true);
  assert.equal(addressed('-5', '222', false), false);
  assert.equal(addressed('-6', '111', false), false, 'empty list triggers nobody');
  assert.equal(addressed('-404', '111', false), false, 'unknown chats fall back to defaults');
  assert.equal(addressed('-404', '111', true), false, 'unknown chats fall back to the explicit defaults');
  assert.equal(groupTriggerModeFor(config, '-4'), 'all');
  assert.equal(groupTriggerModeFor(config, '-404'), 'off');
  assert.ok(GROUP_TRIGGER_MODES.includes('mention-list'));
});

test('defaults apply to chats without their own rule', () => {
  const config = normalizeGroupTriggers({ defaults: { mode: 'all', senders: [] } });
  assert.equal(groupTriggerAddressed(config, { chatId: '-77', senderId: '1' }), true);
});

test('runtime normalization turns group rules into addressed flags', () => {
  const options = { botId: 999, username: 'harness_bot' };
  const off = normalizeGroupTriggers({ defaults: { mode: 'off' } });
  const all = normalizeGroupTriggers({ defaults: { mode: 'all' } });
  const listed = normalizeGroupTriggers({ groups: { [GROUP]: { mode: 'all-list', senders: ['111'] } } });

  assert.equal(normalizeTelegramUpdate(update(), { ...options, groupTriggers: off }).addressed, false);
  assert.equal(normalizeTelegramUpdate(update(), { ...options, groupTriggers: all }).addressed, true);
  assert.equal(normalizeTelegramUpdate(update(), { ...options, groupTriggers: listed }).addressed, true);
  assert.equal(normalizeTelegramUpdate(update({ senderId: 222 }), { ...options, groupTriggers: listed }).addressed, false);

  // Direct chats ignore the rules entirely.
  const direct = normalizeTelegramUpdate(update({ chatType: 'private', chatId: 42 }), {
    ...options, groupTriggers: off,
  });
  assert.equal(direct.addressed, true);

  // Mentions keep working under list rules for listed members only.
  const mention = normalizeGroupTriggers({ groups: { [GROUP]: { mode: 'mention-list', senders: ['111'] } } });
  assert.equal(normalizeTelegramUpdate(update({ mention: true }), { ...options, groupTriggers: mention }).addressed, true);
  assert.equal(normalizeTelegramUpdate(update({ mention: true, senderId: 222 }), {
    ...options, groupTriggers: mention,
  }).addressed, false);
});

test('group references parse without the network', () => {
  assert.deepEqual(parseGroupReference(' -1001234567890 '), {
    chatId: '-1001234567890', query: '-1001234567890', numeric: true,
  });
  assert.equal(parseGroupReference('https://t.me/c/1234567890/45').chatId, '-1001234567890');
  assert.equal(parseGroupReference('t.me/c/1234567890/1/33').chatId, '-1001234567890');
  assert.equal(parseGroupReference('t.me/team_chat').query, '@team_chat');
  assert.equal(parseGroupReference('https://t.me/team_chat/12').query, '@team_chat');
  assert.equal(parseGroupReference('@team_chat').query, '@team_chat');
  // The Bot API cannot resolve an invite link: `getChat` takes an id or @username.
  assert.throws(() => parseGroupReference('https://t.me/+AbCdEf123'),
    /Invite links cannot be resolved through the Bot API/u);
  assert.throws(() => parseGroupReference('t.me/joinchat/AbCdEf123'),
    /Invite links cannot be resolved through the Bot API/u);
  assert.throws(() => parseGroupReference('   '), /Enter a group ID/u);
  assert.throws(() => parseGroupReference('https://example.com/team_chat'), /Unrecognized group reference/u);
});

test('resolving a reference uses getChat and keeps numeric ids offline', async () => {
  const calls = [];
  const getChat = async (query) => {
    calls.push(query);
    if (query === '@team_chat') return { id: -1009876543210, title: 'Team', type: 'supergroup' };
    const error = new Error('Bad Request: chat not found');
    throw error;
  };

  const numeric = await resolveGroupReference('-1001234567890', { getChat });
  assert.deepEqual(numeric, {
    chatId: '-1001234567890', title: null, type: null, verified: false,
  });

  const named = await resolveGroupReference('t.me/team_chat', { getChat });
  assert.deepEqual(named, { chatId: '-1009876543210', title: 'Team', type: 'supergroup', verified: true });

  // A public numeric id is retried with the -100 supergroup prefix.
  const retried = await resolveGroupReference('1234567890', {
    getChat: async (query) => {
      if (query === '-1001234567890') return { id: -1001234567890, title: 'By prefix', type: 'supergroup' };
      throw new Error('chat not found');
    },
  });
  assert.equal(retried.chatId, '-1001234567890');
  assert.equal(retried.verified, true);

  await assert.rejects(
    resolveGroupReference('@unknown_chat', { getChat }),
    /Retry later or enter the numeric group ID/u,
  );
  await assert.rejects(
    resolveGroupReference('@team_chat', { getChat: async () => ({ id: 5, type: 'private' }) }),
    /private chat/u,
  );
  await assert.rejects(
    resolveGroupReference('@team_chat', {}),
    /Retry later or enter the numeric group ID/u,
  );
  assert.deepEqual(calls, ['-1001234567890', '@team_chat', '@unknown_chat']);
});

test('settings projection hides removed chats and lists seen groups', () => {
  const config = normalizeGroupTriggers({
    defaults: { mode: 'mention' },
    groups: { '-1': { mode: 'all' }, '-2': { mode: 'off' }, '-3': { mode: 'all' } },
    hiddenGroupIds: ['-3'],
  });
  const view = groupTriggersSettings(config, [
    { chatId: '-1', title: 'One', lastSeenAt: '2026-01-02T03:04:05.000Z', lastSenderName: 'Ann' },
    { chatId: '-3', title: 'Three' },
    { chatId: '', title: 'broken' },
  ]);
  assert.deepEqual(view.defaults, { mode: 'mention', senders: [] });
  assert.deepEqual(Object.keys(view.groups).sort(), ['-1', '-2']);
  assert.deepEqual(view.seen, [{
    chatId: '-1',
    title: 'One',
    type: null,
    lastSeenAt: '2026-01-02T03:04:05.000Z',
    lastSenderName: 'Ann',
  }]);
});
