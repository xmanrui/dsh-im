import assert from 'node:assert/strict';
import test from 'node:test';

import { DiscordBotClient } from '../../../src/channels/discord/discord-runtime.mjs';
import { createEditableMessageStream } from '../../../src/channels/shared/editable-message-stream.mjs';
import { TextHarnessBridge } from '../../../src/channels/shared/text-harness-bridge.mjs';
import { SlackBotClient } from '../../../src/channels/slack/slack-runtime.mjs';
import { TelegramBotClient } from '../../../src/channels/telegram/telegram-runtime.mjs';
import { WhatsappBotClient } from '../../../src/channels/whatsapp/whatsapp-runtime.mjs';

function memoryState() {
  const sessions = new Map();
  const seen = new Set();
  return {
    sessionFor: (key) => sessions.get(key) ?? null,
    setSession: async (key, sessionId) => { sessions.set(key, sessionId); },
    clearSession: async (key) => { sessions.delete(key); },
    hasSeen: (messageId) => seen.has(messageId),
    markSeen: async (messageId) => { seen.add(messageId); },
  };
}

function inboundMessage(messageId, replyTarget) {
  return {
    messageId,
    senderId: 'message-id-test-user',
    senderIsBot: false,
    kind: 'direct',
    conversationId: `conversation-${messageId}`,
    content: '请返回长文本',
    addressed: true,
    replyTarget,
  };
}

async function textReceipt({ key, bot, answer, replyTarget }) {
  const bridge = new TextHarnessBridge({
    descriptor: { key, label: key },
    bot,
    state: memoryState(),
    logger: { warn() {}, error() {} },
    harness: {
      createSession: async () => `session-${key}`,
      ask: async () => answer,
    },
  });
  return bridge.accept(inboundMessage(`inbound-${key}`, replyTarget));
}

test('editable message streams retain the initial and every remainder message id', async () => {
  let nextMessageId = 101;
  const edited = [];
  const remainders = [];
  const stream = createEditableMessageStream({
    initialText: 'working',
    limit: 5,
    create: async () => 100,
    edit: async (messageId, text) => { edited.push({ messageId, text }); },
    sendRemainder: async (text) => {
      remainders.push(text);
      return { message_id: nextMessageId++ };
    },
    messageIdForResult: (result) => result.message_id,
  });

  await stream.start();
  await stream.finish('ABCDEFGHIJKLM');

  assert.deepEqual(edited, [{ messageId: 100, text: 'ABCDE' }]);
  assert.deepEqual(remainders, ['FGHIJ', 'KLM']);
  assert.deepEqual(stream.providerMessageIds, ['100', '101', '102']);
  const copy = stream.providerMessageIds;
  copy.push('not-stored');
  assert.deepEqual(stream.providerMessageIds, ['100', '101', '102']);
});

test('plain Slack, Telegram, Discord, and WhatsApp receipts retain every split message id', async () => {
  let slackId = 0;
  const slack = new SlackBotClient({
    api: {
      postMessage: async () => ({ ts: `slack-${++slackId}` }),
    },
  });
  const slackReceipt = await textReceipt({
    key: 'slack',
    bot: { sendText: slack.sendText.bind(slack) },
    answer: 'S'.repeat(38_001),
    replyTarget: { channelId: 'C-message-ids', threadTs: '1.0' },
  });
  assert.deepEqual(slackReceipt.providerMessageIds, ['slack-1', 'slack-2']);

  let telegramId = 200;
  const telegram = new TelegramBotClient({
    api: {
      sendMessage: async () => ({ message_id: ++telegramId }),
    },
  });
  const telegramReceipt = await textReceipt({
    key: 'telegram',
    bot: { sendText: telegram.sendText.bind(telegram) },
    answer: 'T'.repeat(4_001),
    replyTarget: { chatId: 42, replyToMessageId: 7, messageThreadId: 8 },
  });
  assert.deepEqual(telegramReceipt.providerMessageIds, ['201', '202']);

  let discordId = 0;
  const discord = new DiscordBotClient({
    api: {
      createMessage: async () => ({ id: `discord-${++discordId}` }),
    },
  });
  const discordReceipt = await textReceipt({
    key: 'discord',
    bot: { sendText: discord.sendText.bind(discord) },
    answer: 'D'.repeat(1_901),
    replyTarget: { channelId: 'discord-channel', replyToMessageId: 'discord-inbound' },
  });
  assert.deepEqual(discordReceipt.providerMessageIds, ['discord-1', 'discord-2']);

  let whatsappId = 0;
  const remembered = [];
  const reserved = [];
  const whatsapp = new WhatsappBotClient({
    sendPresenceUpdate: async () => {},
    sendMessage: async () => ({ key: { id: `whatsapp-${++whatsappId}` } }),
  }, {
    remember: (messageId) => remembered.push(messageId),
    reserve: (messageId) => reserved.push(messageId),
  });
  const whatsappReceipt = await textReceipt({
    key: 'whatsapp',
    bot: { sendText: whatsapp.sendText.bind(whatsapp) },
    answer: 'W'.repeat(4_001),
    replyTarget: { jid: '16505550123@s.whatsapp.net' },
  });
  assert.deepEqual(whatsappReceipt.providerMessageIds, ['whatsapp-1', 'whatsapp-2']);
  assert.deepEqual(remembered, ['whatsapp-1', 'whatsapp-2']);
  assert.equal(reserved.length, 2);
  assert.equal(reserved.every((messageId) => /^[0-9A-F]{20}$/.test(messageId)), true);
  assert.notEqual(reserved[0], reserved[1]);
});

test('Slack, Telegram, and Discord stream receipts retain the initial and remainder ids', async () => {
  let slackRemainder = 0;
  const slack = new SlackBotClient({
    api: {
      startStream: async () => ({ ts: 'slack-stream-first' }),
      appendStream: async () => ({ ok: true }),
      stopStream: async () => ({ ok: true }),
      updateMessage: async () => ({ ok: true }),
      postMessage: async () => ({ ts: `slack-stream-rest-${++slackRemainder}` }),
    },
    logger: { warn() {} },
  });
  const slackReceipt = await textReceipt({
    key: 'slack-stream',
    bot: slack,
    answer: 'S'.repeat(38_001),
    replyTarget: { channelId: 'C-stream', threadTs: '2.0' },
  });
  assert.deepEqual(slackReceipt.providerMessageIds, [
    'slack-stream-first',
    'slack-stream-rest-1',
  ]);

  let telegramId = 300;
  const telegram = new TelegramBotClient({
    api: {
      sendChatAction: async () => true,
      sendMessage: async () => ({ message_id: ++telegramId }),
      editMessageText: async () => true,
    },
  });
  const telegramReceipt = await textReceipt({
    key: 'telegram-stream',
    bot: telegram,
    answer: 'T'.repeat(4_001),
    replyTarget: {
      chatId: 42,
      chatType: 'supergroup',
      replyToMessageId: 7,
      messageThreadId: 8,
    },
  });
  assert.deepEqual(telegramReceipt.providerMessageIds, ['301']);
  assert.equal(telegramReceipt.presentation, 'telegram-rich-final');

  let discordId = 0;
  const discord = new DiscordBotClient({
    api: {
      sendTyping: async () => true,
      createMessage: async () => ({ id: `discord-stream-${++discordId}` }),
      editMessage: async () => ({ id: 'ignored-edit-id' }),
    },
  });
  const discordReceipt = await textReceipt({
    key: 'discord-stream',
    bot: discord,
    answer: 'D'.repeat(1_901),
    replyTarget: { channelId: 'discord-channel', replyToMessageId: 'discord-inbound' },
  });
  assert.deepEqual(discordReceipt.providerMessageIds, [
    'discord-stream-1',
    'discord-stream-2',
  ]);
});

test('the text bridge preserves stream ids before any ids returned only by finish', async () => {
  const stream = {
    messageId: 'stream-first',
    providerMessageIds: ['stream-first', 'stream-remainder'],
    update() {},
    async finish() {
      return { providerMessageIds: ['stream-remainder', 'finish-only'] };
    },
    cancel() {},
  };
  const receipt = await textReceipt({
    key: 'custom-stream',
    bot: {
      sendText: async () => assert.fail('stream finalization must not fall back to plain text'),
      openStream: async () => stream,
    },
    answer: 'done',
    replyTarget: { channelId: 'custom-stream' },
  });

  assert.deepEqual(receipt.providerMessageIds, [
    'stream-first',
    'stream-remainder',
    'finish-only',
  ]);
});
