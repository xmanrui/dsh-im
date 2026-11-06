import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ImapFlow } from 'imapflow';

import { EmailRuntime } from '../../../src/channels/email/email-runtime.mjs';
import { EmailStateStore } from '../../../src/channels/email/state-store.mjs';
import { ImapSmtpTransport } from '../../../src/channels/email/transports/imap-smtp.mjs';

const config = {
  address: 'bot@example.com', password: 'test-password',
  imapHost: 'imap.example.com', imapPort: 993, mailbox: 'INBOX',
};
const disconnected = () => Object.assign(new Error('Connection closed'), { code: 'NoConnection' });

// Replace network commands only; use ImapFlow's real close(), usable flag and
// events so the transport exercises the same lifecycle as a dropped socket.
function mockMailbox(t) {
  const mailbox = { clients: [], uids: [], connectError: null, openError: null, bodyError: null };
  function requireConnection(client) {
    if (!client.usable) throw disconnected();
  }
  t.mock.method(ImapFlow.prototype, 'connect', async function () {
    mailbox.clients.push(this);
    if (mailbox.connectError) throw mailbox.connectError;
    this.usable = true;
  });
  t.mock.method(ImapFlow.prototype, 'mailboxOpen', async function () {
    requireConnection(this);
    if (mailbox.openError) throw mailbox.openError;
  });
  t.mock.method(ImapFlow.prototype, 'logout', async function () { this.close(); });
  t.mock.method(ImapFlow.prototype, 'status', async function () {
    requireConnection(this);
    return { uidNext: Math.max(0, ...mailbox.uids) + 1 };
  });
  t.mock.method(ImapFlow.prototype, 'fetch', async function* (range) {
    requireConnection(this);
    const firstUid = Number(range.uid.split(':')[0]);
    for (const uid of mailbox.uids.filter((value) => value >= firstUid)) {
      yield { uid, envelope: { from: [{ address: 'user@example.com' }] } };
    }
  });
  t.mock.method(ImapFlow.prototype, 'fetchOne', async function (uid) {
    requireConnection(this);
    if (mailbox.bodyError) {
      const error = mailbox.bodyError;
      mailbox.bodyError = null;
      throw error;
    }
    return { source: Buffer.from([
      'From: user@example.com', 'To: bot@example.com',
      `Message-ID: <mail-${uid}@example.com>`, `Subject: Mail ${uid}`,
      '', `body ${uid}`,
    ].join('\r\n')) };
  });
  return mailbox;
}

for (const event of ['close', 'error', 'unusable']) {
  test(`IMAP reconnects after ${event} and ignores late events from the old client`, async (t) => {
    const mailbox = mockMailbox(t);
    const transport = new ImapSmtpTransport({ config });
    t.after(() => transport.disconnect());

    await transport.latestUid();
    const old = mailbox.clients[0];
    if (event === 'close') old.close();
    else if (event === 'error') old.emit('error', disconnected());
    else old.usable = false;

    mailbox.uids.push(240, 241);
    const messages = await transport.listMessages({ afterUid: 239 });
    assert.deepEqual(messages.map((message) => message.uid), [240, 241]);
    assert.equal(mailbox.clients.length, 2, 'the next poll opens a fresh connection');
    assert.equal(old.isClosed, true, 'the obsolete client is disposed');

    old.emit('close');
    old.emit('error', disconnected());
    assert.equal(await transport.latestUid(), 241);
    assert.equal(mailbox.clients.length, 2, 'late events must not discard the healthy replacement');
  });
}

for (const stage of ['connectError', 'openError']) {
  test(`IMAP disposes a client after ${stage} and can retry`, async (t) => {
    const mailbox = mockMailbox(t);
    const transport = new ImapSmtpTransport({ config });
    t.after(() => transport.disconnect());
    mailbox[stage] = new Error('Temporary mailbox failure');

    await assert.rejects(transport.connect(), mailbox[stage]);
    assert.equal(mailbox.clients[0].isClosed, true, 'a failed connection attempt must not leak');

    mailbox[stage] = null;
    assert.equal(await transport.latestUid(), 0);
    assert.equal(mailbox.clients.length, 2);
  });
}

test('IMAP propagates body-fetch failures so polling cannot skip an unread message', async (t) => {
  const mailbox = mockMailbox(t);
  const transport = new ImapSmtpTransport({ config });
  t.after(() => transport.disconnect());
  mailbox.uids.push(240, 241);
  mailbox.bodyError = disconnected();

  await assert.rejects(transport.listMessages({ afterUid: 239 }), { code: 'NoConnection' });
  mailbox.clients[0].close();
  mailbox.bodyError = null;
  const messages = await transport.listMessages({ afterUid: 239 });
  assert.deepEqual(messages.map((message) => message.uid), [240, 241]);
});

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test('email polling reconnects automatically and delivers the backlog once without resetting its cursor', async (t) => {
  const mailbox = mockMailbox(t);
  mailbox.uids.push(239);
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-reconnect-'));
  const state = await new EmailStateStore(join(dir, 'state.json')).load();
  const transport = new ImapSmtpTransport({ config });
  const asks = [];
  const replies = [];
  t.mock.method(transport, 'sendReply', async (reply) => { replies.push(reply); });
  const runtime = new EmailRuntime({
    config: { platformId: config.address, transport: 'imap-smtp', allowedSenders: ['user@example.com'] },
    state,
    harness: {
      ensureRunning: async () => {},
      sessionExists: async (sessionId) => Boolean(sessionId),
      createSession: async () => 'email-test-session',
      ask: async (_sessionId, text) => { asks.push(text); return { answer: 'done', artifacts: [] }; },
    },
    logger: { warn() {}, info() {}, error() {}, log() {} },
    pollIntervalMs: 20,
    createApi: () => transport,
  });
  t.after(async () => {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  });

  await runtime.start();
  await waitFor(() => state.cursor() === 239 && replies.length === 1, 'initial mail was not processed');
  const bridge = runtime.bridge;
  const firstClient = mailbox.clients[0];
  firstClient.close();
  mailbox.uids.push(240, 241);
  mailbox.connectError = disconnected();

  await waitFor(() => runtime.status.connectionState === 'failed', 'a failed reconnect was not reported');
  assert.equal(state.cursor(), 239, 'failed polling must preserve the last delivered UID');
  assert.equal(asks.length, 1);

  mailbox.connectError = null;
  await waitFor(
    () => state.cursor() === 241 && replies.length === 3 && runtime.status.connectionState === 'connected',
    'polling did not reconnect and process the backlog automatically',
  );
  const recoveredCheck = runtime.status.lastCheckedAt;
  await waitFor(() => runtime.status.lastCheckedAt > recoveredCheck, 'polling stopped after recovery');

  assert.equal(runtime.bridge, bridge, 'recovery must not restart the runtime or its conversations');
  assert.equal(runtime.status.lastError, null);
  assert.equal(asks.length, 3, 'already handled mail must not be replayed');
  assert.match(asks[0], /body 239/);
  assert.match(asks[1], /body 240/);
  assert.match(asks[2], /body 241/);
  assert.ok(mailbox.clients.length >= 3, 'the loop retries even if the first reconnect fails');
  assert.ok(mailbox.clients.slice(0, -1).every((client) => client.isClosed));
});
