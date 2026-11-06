import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  MacOSMessagesApi,
  decodeAttributedBodyText,
  normalizeIMessage,
  normalizeIMessageTarget,
  IMESSAGE_BOT_REPLY_PREFIX,
} from '../../../src/channels/imessage/imessage-api.mjs';

// Shaped like an NSArchiver typedstream: class name, then the '+' inline-string
// tag, then the NXTypedStream length prefix and UTF-8 payload.
const TYPEDSTREAM_STRING_PREFIX = Buffer.from('streamtyped\0NSString\0', 'utf8');
const attributedBody = (lengthPrefix, payload) => Buffer.concat([
  TYPEDSTREAM_STRING_PREFIX, Buffer.from([0x2b]), Buffer.from(lengthPrefix), Buffer.from(payload),
]);
// Exact blob from a macOS 26 chat.db where message.text is NULL and the body is "你好🤝".
const MACOS_26_HEX_BODY = '040B73747265616D747970656481E803840140848484124E5341747472696275746564537472696E67008484084E534F626A656374008592848484084E53537472696E67019484012B0AE4BDA0E5A5BDF09FA49D86840269490104928484840C4E5344696374696F6E617279009484016901928496961D5F5F6B494D4D657373616765506172744174747269627574654E616D658692848484084E534E756D626572008484074E5356616C7565009484012A84999900868686';

test('decodes the typedstream body macOS 26 stores instead of message.text', () => {
  assert.equal(decodeAttributedBodyText(MACOS_26_HEX_BODY), '你好🤝');
  assert.equal(decodeAttributedBodyText(Buffer.from(MACOS_26_HEX_BODY, 'hex')), '你好🤝');
  assert.equal(decodeAttributedBodyText(attributedBody([0x03], 'abc')), 'abc');
  // Producer regression case from other typedstream readers: 292-byte run as 0x81 0x24 0x01.
  assert.equal(decodeAttributedBodyText(attributedBody([0x81, 0x24, 0x01], 'a'.repeat(292))), 'a'.repeat(292));
  assert.equal(decodeAttributedBodyText(null), null);
  assert.equal(decodeAttributedBodyText(''), null);
  assert.equal(decodeAttributedBodyText(attributedBody([0x02], [0xff, 0xfe])), null);
  assert.equal(decodeAttributedBodyText(attributedBody([0x81, 0xff, 0x00], 'short')), null);
  assert.equal(decodeAttributedBodyText(Buffer.from('no typedstream marker', 'utf8')), null);
  // Attachment-only bodies are U+FFFC; the text-only channel must keep ignoring them.
  assert.equal(decodeAttributedBodyText(attributedBody([0x03], Buffer.from('\ufffc', 'utf8'))), null);
  assert.equal(decodeAttributedBodyText(attributedBody([0x05], Buffer.from('hi\ufffc', 'utf8'))), 'hi');
});

test('normalizes a macOS 26 row that only carries attributedBody', () => {
  const message = normalizeIMessage({
    rowid: 5, guid: 'p:5', chatGuid: 'any;-;+8613800000000', serviceName: 'iMessage',
    text: null, attributedBodyHex: MACOS_26_HEX_BODY, sender: '+8613800000000',
  });
  assert.equal(message.content, '你好🤝');
  assert.equal(message.replyTarget.address, '+8613800000000');
  assert.equal(normalizeIMessage({
    rowid: 6, guid: 'p:6', chatGuid: 'any;-;+8613800000000', serviceName: 'iMessage',
    text: null, attributedBodyHex: attributedBody([0x03], Buffer.from('\ufffc', 'utf8')).toString('hex'),
    sender: '+8613800000000',
  }), null);
});

test('normalizes private native Messages rows and ignores bot identities', () => {
  const message = normalizeIMessage({
    rowid: 3, guid: 'p:1', chatGuid: 'any;-;+8613800000000', serviceName: 'iMessage', text: 'hello',
    sender: '+8613800000000', receivedAt: '2026-09-07T00:00:00.000Z',
  }, { botId: 'macos-messages' });
  assert.equal(message.conversationId, 'any;-;+8613800000000');
  assert.equal(message.content, 'hello');
  assert.equal(message.replyTarget.address, '+8613800000000');
  assert.equal(message.replyTarget.serviceName, 'iMessage');
  assert.equal(normalizeIMessage({ guid: 'p:2', chatGuid: 'c', text: 'echo', sender: 'macos-messages' }, { botId: 'macos-messages' }), null);
});

test('reads Messages database rows after a durable cursor', async () => {
  const calls = [];
  const api = new MacOSMessagesApi({
    dbPath: '/tmp/chat.db',
    execFileImpl: async (file, args) => {
      calls.push({ file, args });
      return { stdout: '[{"rowid":4,"guid":"p:4","chatGuid":"c","serviceName":"iMessage","text":"hello","sender":"+1"}]' };
    },
    osascriptImpl: async () => ({ stdout: 'Messages' }),
  });
  assert.deepEqual(await api.listMessages({ after: 3, limit: 10 }), [
    { rowid: 4, guid: 'p:4', chatGuid: 'c', serviceName: 'iMessage', text: 'hello', sender: '+1' },
  ]);
  assert.equal(calls[0].args[0], '-json');
  assert.match(calls[0].args.at(-1), /ROWID > 3/);
  assert.match(calls[0].args.at(-1), /c\.service_name = 'iMessage'/);
  assert.match(calls[0].args.at(-1), /m\.is_from_me = 0/);
  assert.match(calls[0].args.at(-1), /hex\(m\.attributedBody\) AS attributedBodyHex/);
  assert.match(calls[0].args.at(-1), /OR m\.attributedBody IS NOT NULL/);
});

test('reads the latest iMessage row id for safe first-start cursor initialization', async (t) => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', platformDescriptor));
  const api = new MacOSMessagesApi({
    dbPath: '/tmp/chat.db',
    execFileImpl: async (_file, args) => {
      assert.match(args.at(-1), /MAX\(m\.ROWID\)/);
      assert.match(args.at(-1), /c\.service_name = 'iMessage'/);
      return { stdout: '[{"rowid":744}]' };
    },
    osascriptImpl: async () => ({ stdout: 'Messages' }),
  });
  assert.equal(await api.getLatestMessageRowId(), 744);
});

test('sends text through the native Messages AppleScript bridge', async () => {
  const scripts = [];
  const api = new MacOSMessagesApi({
    execFileImpl: async () => ({ stdout: '' }),
    osascriptImpl: async (script) => { scripts.push(script); return { stdout: '' }; },
  });
  assert.deepEqual(await api.sendText({ chatGuid: 'any;-;+8613800000000', address: '+8613800000000', text: 'hi' }), { sent: true });
  assert.match(scripts[0], /buddy "\+8613800000000"/);
  assert.ok(scripts[0].includes(`send ${JSON.stringify(`${IMESSAGE_BOT_REPLY_PREFIX}hi`)}`));
});

test('self-chat accepts the owner once, ignores bot echoes and outgoing messages to others', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE message (guid TEXT, text TEXT, handle_id INTEGER, date INTEGER,
      is_from_me INTEGER, destination_caller_id TEXT, attributedBody BLOB);
    CREATE TABLE chat (guid TEXT, service_name TEXT, style INTEGER,
      chat_identifier TEXT, account_login TEXT, last_addressed_handle TEXT);
    CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);
    CREATE TABLE handle (id TEXT);
  `);
  const chat = db.prepare('INSERT INTO chat VALUES (?, ?, ?, ?, ?, ?)');
  chat.run('self-email', 'iMessage', 45, 'owner@example.com', 'E:OWNER@example.com', null);
  chat.run('friend', 'iMessage', 45, 'friend@example.com', 'E:owner@example.com', 'owner@example.com');
  chat.run('self-phone', 'iMessage', 45, '+15550001', 'E:owner@example.com', '+15550001');
  chat.run('self-destination', 'iMessage', 45, '+15550002', 'E:owner@example.com', null);
  chat.run('group', 'iMessage', 43, 'owner@example.com', 'E:owner@example.com', null);
  for (const address of ['owner@example.com', 'friend@example.com', '+15550001', '+15550002', 'owner@example.com']) {
    db.prepare('INSERT INTO handle VALUES (?)').run(address);
  }
  const insert = (guid, text, chatId, fromMe, destination = 'owner@example.com') => {
    const { lastInsertRowid } = db.prepare(`INSERT INTO message
      (guid, text, handle_id, date, is_from_me, destination_caller_id) VALUES (?, ?, ?, 0, ?, ?)`)
      .run(guid, text, chatId, fromMe, destination);
    db.prepare('INSERT INTO chat_message_join VALUES (?, ?)').run(lastInsertRowid, chatId);
  };
  insert('owner-input', null, 1, 1);
  insert('self-incoming-copy', 'hello AI', 1, 0);
  insert('bot-reply', `${IMESSAGE_BOT_REPLY_PREFIX}hello owner`, 1, 1);
  insert('bot-incoming-copy', `${IMESSAGE_BOT_REPLY_PREFIX}hello owner`, 1, 0);
  insert('outgoing-friend', 'private outgoing message', 2, 1);
  insert('incoming-friend', 'external input', 2, 0);
  insert('owner-phone', 'from phone alias', 3, 1);
  insert('owner-phone-copy', 'from phone alias', 3, 0);
  insert('owner-destination', 'from destination alias', 4, 1, '+15550002');
  insert('owner-destination-copy', 'from destination alias', 4, 0, '+15550002');
  insert('outgoing-group', 'group message', 5, 1);

  const makeApi = () => new MacOSMessagesApi({
    execFileImpl: async (_file, args) => ({ stdout: JSON.stringify(db.prepare(args.at(-1)).all()) }),
  });
  const normalize = (rows) => rows.map((row) => normalizeIMessage(row)).filter(Boolean);
  const rows = await makeApi().listMessages();
  assert.deepEqual(normalize(rows).map((row) => row.messageId),
    ['self-incoming-copy', 'incoming-friend', 'owner-phone-copy', 'owner-destination-copy']);
  assert.equal(normalize(rows)[0].senderId, 'owner@example.com');
  assert.equal(normalize(rows)[0].replyTarget.address, 'owner@example.com');
  assert.equal(normalize(rows)[1].replyTarget.address, 'friend@example.com');
  // No process-local send history is needed to reject an echo after restart.
  assert.deepEqual(normalize(await makeApi().listMessages({ after: 2, chatGuid: 'self-email' })), []);
});

test('reads macOS 26 rows whose body only lives in attributedBody', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE message (guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER,
      date INTEGER, is_from_me INTEGER);
    CREATE TABLE chat (guid TEXT, service_name TEXT);
    CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);
    CREATE TABLE handle (id TEXT);
  `);
  db.prepare('INSERT INTO chat VALUES (?, ?)').run('any;-;+15550001', 'iMessage');
  db.prepare('INSERT INTO handle VALUES (?)').run('+15550001');
  const { lastInsertRowid } = db.prepare(`INSERT INTO message
    (guid, text, attributedBody, handle_id, date, is_from_me) VALUES (?, ?, ?, 1, 0, 0)`)
    .run('tahoe-incoming', null, attributedBody([0x03], 'abc'));
  db.prepare('INSERT INTO chat_message_join VALUES (?, 1)').run(lastInsertRowid);

  const api = new MacOSMessagesApi({
    execFileImpl: async (_file, args) => ({ stdout: JSON.stringify(db.prepare(args.at(-1)).all()) }),
  });
  const [row] = await api.listMessages();
  assert.equal(row.text, null);
  assert.match(row.attributedBodyHex, /^[0-9A-F]+$/);
  const message = normalizeIMessage(row);
  assert.equal(message.messageId, 'tahoe-incoming');
  assert.equal(message.content, 'abc');
});

test('normalization never accepts an unmarked outgoing contact message', () => {
  const row = { guid: 'g', chatGuid: 'c', sender: 'friend@example.com', text: 'hello', isFromMe: 1 };
  assert.equal(normalizeIMessage(row), null);
  assert.equal(normalizeIMessage({ ...row, isFromMe: 0 }).content, 'hello');
  assert.equal(normalizeIMessage({ ...row, isFromMe: 0, text: `${IMESSAGE_BOT_REPLY_PREFIX}reply` }), null);
});

test('rejects malformed chat targets', () => {
  assert.throws(() => normalizeIMessageTarget(''), /chatGuid is required/);
  assert.equal(normalizeIMessage({
    guid: 'p:3', chatGuid: 'any;-;10000', serviceName: 'SMS', text: 'spam', sender: '10000',
  }), null);
});
