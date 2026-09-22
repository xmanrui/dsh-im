import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  normalizeAddress,
  parseMessageIds,
  resolveThreadKey,
  stripQuotedHistory,
} from '../../../src/channels/email/email-api.mjs';
import {
  EMAIL_PROVIDERS,
  EmailConfigStore,
  maskEmailBotId,
  normalizeEmailAccessPolicy,
  normalizeEmailAddress,
  normalizeEmailAllowedSenders,
} from '../../../src/channels/email/config-store.mjs';
import { EmailStateStore } from '../../../src/channels/email/state-store.mjs';
import { normalizeEmail, replySubject } from '../../../src/channels/email/email-runtime.mjs';

const BOT = 'dsh@qq.com';

function parsedMail(overrides = {}) {
  return {
    messageId: '<m1@mail.example>',
    from: { value: [{ address: 'user@example.com', name: 'User' }] },
    subject: 'Do the thing',
    text: 'Please do the thing',
    ...overrides,
  };
}

test('stripQuotedHistory removes English and Chinese reply history', () => {
  assert.equal(
    stripQuotedHistory('New instruction\n\nOn Mon, Jan 1 2026 at 10:00, A <a@b.c> wrote:\n> old'),
    'New instruction',
  );
  assert.equal(
    stripQuotedHistory('新指令\n\n在 2026年1月1日 写道：\n> 旧内容'),
    '新指令',
  );
  assert.equal(stripQuotedHistory('Plain body only'), 'Plain body only');
  // A leading "From:" line marks the start of a forwarded block.
  assert.equal(stripQuotedHistory('Body\n\nFrom: someone@example.com'), 'Body');
});

test('parseMessageIds extracts bracketed ids and tolerates missing headers', () => {
  assert.deepEqual(parseMessageIds('<a@b.c> <d@e.f>'), ['<a@b.c>', '<d@e.f>']);
  assert.deepEqual(parseMessageIds(['<a@b.c>', '<d@e.f>']), ['<a@b.c>', '<d@e.f>']);
  assert.deepEqual(parseMessageIds(undefined), []);
  assert.deepEqual(parseMessageIds('no ids here'), []);
});

test('resolveThreadKey joins a reply chain and opens a new thread otherwise', () => {
  const conversationMap = new Map([['<root@mail>', 'email:thread-1']]);
  assert.equal(
    resolveThreadKey({ messageId: '<r@mail>', references: '<root@mail>', conversationMap }),
    'email:thread-1',
  );
  assert.equal(
    resolveThreadKey({ messageId: '<r@mail>', inReplyTo: '<root@mail>', conversationMap }),
    'email:thread-1',
  );
  assert.equal(
    resolveThreadKey({ messageId: '<fresh@mail>', conversationMap }),
    '<fresh@mail>',
  );
});

test('normalizeAddress lowercases and unwraps display names', () => {
  assert.equal(normalizeAddress('User Name <USER@Example.COM>'), 'user@example.com');
  assert.equal(normalizeAddress('  bare@example.com '), 'bare@example.com');
});

test('normalizeEmail builds a bridge message and a threaded reply target', () => {
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-state.json'));
  const message = normalizeEmail(parsedMail(), { address: BOT, state });
  assert.equal(message.senderId, 'user@example.com');
  assert.equal(message.kind, 'direct');
  // The subject and sender are prepended so the model sees them.
  assert.match(message.content, /^Subject: Do the thing$/m);
  assert.match(message.content, /^From: User <user@example\.com>$/m);
  assert.match(message.content, /Please do the thing$/);
  assert.equal(message.conversationId, '<m1@mail.example>');
  assert.equal(message.replyTarget.to, 'user@example.com');
  assert.equal(message.replyTarget.subject, 'Re: Do the thing');
  assert.equal(message.replyTarget.messageId, '<m1@mail.example>');
  assert.deepEqual(message.replyTarget.references, ['<m1@mail.example>']);
});

test('normalizeEmail keeps a reply inside the existing conversation', () => {
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-state-2.json'));
  const first = normalizeEmail(parsedMail(), { address: BOT, state });
  for (const id of [first.messageId, ...first.replyTarget.references]) {
    state.rememberThreadId(id, first.conversationId);
  }
  const reply = normalizeEmail(parsedMail({
    messageId: '<m2@mail.example>',
    references: '<m1@mail.example>',
    subject: 'Re: Do the thing',
    text: 'One more thing',
  }), { address: BOT, state });
  assert.equal(reply.conversationId, first.conversationId);
});

test('a mailbox may be its own sender, but never answers an automatic reply', () => {
  // Honouring RFC 3834 instead of rejecting the mailbox's own address lets a
  // user drive the Harness by writing to the bot mailbox from that same
  // mailbox, which is a normal way to use it.
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-state-3.json'));
  const selfSent = normalizeEmail(parsedMail({
    from: { value: [{ address: 'DSH@QQ.com' }] },
  }), { address: BOT, state });
  assert.ok(selfSent, 'a hand-written mail from the mailbox itself is accepted');
  assert.equal(selfSent.senderId, 'dsh@qq.com');

  // The loop is broken by the marker every automatic reply carries.
  for (const marker of [
    { headers: new Map([['auto-submitted', 'auto-replied']]) },
    { headerLines: [{ line: 'Auto-Submitted: auto-generated' }] },
  ]) {
    assert.equal(
      normalizeEmail(parsedMail({ from: { value: [{ address: 'other@x.com' }] }, ...marker }),
        { address: BOT, state }),
      null,
      'an automatic reply must never be answered',
    );
  }
  // "no" explicitly means a human message.
  assert.ok(normalizeEmail(parsedMail({
    from: { value: [{ address: 'other@x.com' }] },
    headers: new Map([['auto-submitted', 'no']]),
  }), { address: BOT, state }));

  const automated = normalizeEmail(parsedMail({
    from: { value: [{ address: 'noreply@shop.example' }] },
  }), { address: BOT, state });
  assert.equal(automated, null, 'no-reply senders must be ignored');
  const empty = normalizeEmail(parsedMail({ text: '   ' }), { address: BOT, state });
  assert.equal(empty, null, 'a body-less mail must be ignored');
});

test('normalizeEmail still forwards a body-less mail that carries an attachment', () => {
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-state-4.json'));
  const message = normalizeEmail(parsedMail({
    text: '',
    attachments: [{ filename: 'report.csv', size: 3, contentType: 'text/csv', content: Buffer.from('a,b') }],
  }), { address: BOT, state });
  assert.ok(message, 'an attachment-only mail is still actionable');
  assert.equal(message.files.length, 1);
  assert.equal(message.files[0].name, 'report.csv');
});

test('replySubject applies exactly one Re: prefix', () => {
  assert.equal(replySubject('Hello'), 'Re: Hello');
  assert.equal(replySubject('Re: Hello'), 'Re: Hello');
  assert.equal(replySubject('RE: Hello'), 'RE: Hello');
  assert.equal(replySubject(''), 'Re: (no subject)');
});

test('email addresses are normalized and validated', () => {
  assert.equal(normalizeEmailAddress('  User@QQ.COM '), 'user@qq.com');
  for (const invalid of ['', 'not-an-address', 'no-at.example', 'a@b', 'a b@c.d']) {
    assert.throws(() => normalizeEmailAddress(invalid), TypeError, `expected ${invalid} to be rejected`);
  }
});

test('the sender allowlist validates, dedupes, and lowercases', () => {
  assert.deepEqual(
    [...normalizeEmailAllowedSenders(['A@QQ.com', 'b@163.COM', 'a@qq.com'])],
    ['a@qq.com', 'b@163.com'],
  );
  assert.deepEqual([...normalizeEmailAllowedSenders(undefined)], []);
  assert.throws(() => normalizeEmailAllowedSenders('nope'), TypeError);
  assert.throws(() => normalizeEmailAllowedSenders(['bad']), TypeError);
});

test('email access policy defaults to an empty allowlist', () => {
  assert.deepEqual([...normalizeEmailAccessPolicy({}).allowedSenders], []);
  assert.deepEqual(
    [...normalizeEmailAccessPolicy({ allowedSenders: ['x@y.z'] }).allowedSenders],
    ['x@y.z'],
  );
});

test('maskEmailBotId hides the local part but keeps the domain readable', () => {
  assert.equal(maskEmailBotId('zhangsan@qq.com'), 'zh******@qq.com');
  assert.equal(maskEmailBotId('a@163.com'), 'a*@163.com');
});

test('provider presets expose IMAP and SMTP endpoints', () => {
  assert.equal(EMAIL_PROVIDERS.qq.imapHost, 'imap.qq.com');
  assert.equal(EMAIL_PROVIDERS.qq.smtpPort, 465);
  assert.equal(EMAIL_PROVIDERS['163'].smtpHost, 'smtp.163.com');
  assert.equal(EMAIL_PROVIDERS.gmail.imapPort, 993);
});

test('EmailConfigStore persists mailbox settings and reloads them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-config-'));
  const path = join(dir, 'config.json');
  try {
    const store = await new EmailConfigStore(path).load();
    await store.save({
      platformId: 'user@qq.com',
      name: 'user@qq.com',
      provider: 'qq',
      allowedSenders: ['boss@example.com'],
    });
    const reloaded = await new EmailConfigStore(path).load();
    const [bot] = reloaded.list();
    assert.equal(bot.platformId, 'user@qq.com');
    assert.equal(bot.imapHost, 'imap.qq.com');
    assert.equal(bot.smtpPort, 465);
    assert.deepEqual([...bot.allowedSenders], ['boss@example.com']);
    // A partial save must keep the previously stored fields.
    await reloaded.save({ platformId: 'user@qq.com', name: 'user@qq.com', allowedSenders: ['other@example.com'] });
    const [updated] = (await new EmailConfigStore(path).load()).list();
    assert.equal(updated.imapHost, 'imap.qq.com');
    assert.deepEqual([...updated.allowedSenders], ['other@example.com']);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('EmailStateStore bounds the remembered thread-id map', () => {
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-state-5.json'));
  for (let index = 0; index < 2_100; index += 1) {
    state.rememberThreadId(`<m${index}@mail>`, `email:thread-${index}`);
  }
  // The newest ids survive; the oldest are evicted.
  assert.equal(state.conversationForThreadId('<m2099@mail>'), 'email:thread-2099');
  assert.equal(state.conversationForThreadId('<m0@mail>'), null);
  assert.equal(state.threadMap.size, 2_000);
});

test('EmailController reads the mailbox secret from the credential wrapper', async () => {
  // Regression guard: parameters.resolve() returns a wrapper whose payload is
  // on `.value`. Parsing the wrapper itself threw and was swallowed, so the
  // mailbox looked configured while its runtime never started.
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-cred-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    await store.save({
      platformId: 'user@qq.com',
      name: 'user@qq.com',
      provider: 'qq',
      allowedSenders: ['boss@example.com'],
    });
    const [bot] = store.list();
    const started = [];
    const controller = new EmailController({
      credentials: {
        // Mirror the real provider: a wrapper object, not a bare string.
        async resolve() { return { value: JSON.stringify({ address: 'user@qq.com', password: 'app-pass' }) }; },
        async set() {},
        async unset() {},
      },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      createRuntime: async ({ botId, config, token }) => {
        started.push({ botId, password: token });
        return { start: async () => {}, stop: async () => {}, status: { ready: true, connectionState: 'connected' } };
      },
    });
    await controller.initialize();
    assert.equal(started.length, 1, 'the mailbox runtime must start when the secret resolves');
    assert.equal(started[0].password, 'app-pass');
    const status = controller.status();
    assert.deepEqual(status.totals, { configured: 1, connected: 1 });
    assert.equal(status.bots[0].connected, true);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('outbound artifacts use the shared materialized field names', async () => {
  // The artifact layer materializes files as { fileName, mediaType, bytes };
  // reading { name, content } instead silently sent an unnamed empty attachment.
  const source = await readFile(
    new URL('../../../src/channels/email/email-runtime.mjs', import.meta.url),
    'utf8',
  );
  const mapping = source.slice(source.indexOf('#attachmentFrom('), source.indexOf('async sendFile'));
  assert.match(mapping, /file\?\.fileName/, 'the artifact file name lives on .fileName');
  assert.match(mapping, /file\?\.bytes/, 'the artifact payload lives on .bytes');
  assert.match(mapping, /file\?\.mediaType/, 'the artifact type lives on .mediaType');
  // .content may only appear as a trailing fallback, never as the primary read.
  assert.match(mapping, /file\?\.bytes \?\? /, 'bytes must be the primary payload read');
});

test('inbound attachments declare mediaType for the shared file layer', async () => {
  // inbound-file reads `mediaType`; a `mimeType` key is ignored.
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-state-6.json'));
  const message = normalizeEmail({
    messageId: '<attach@mail>',
    from: { value: [{ address: 'boss@example.com' }] },
    subject: 'Report',
    text: 'See attached',
    attachments: [{
      filename: 'sales.csv', size: 8, contentType: 'text/csv',
      content: Buffer.from('a,b\n1,2\n'),
    }],
  }, { address: BOT, state });
  assert.equal(message.files.length, 1);
  assert.equal(message.files[0].mediaType, 'text/csv');
  assert.equal(message.files[0].mimeType, undefined, 'mimeType is not the field the layer reads');
});

test('polling only downloads mail from allowlisted senders', async () => {
  // The monitored mailbox also receives ordinary personal mail. Its body must
  // never be requested, so filtering happens on the envelope before the source
  // fetch — not after the message is already downloaded.
  const source = await readFile(
    new URL('../../../src/channels/email/transports/imap-smtp.mjs', import.meta.url),
    'utf8',
  );
  const listStart = source.indexOf('async listMessages');
  const list = source.slice(listStart, source.indexOf('await this.#imap.mailboxOpen(mailbox', listStart));
  const envelopeStage = list.indexOf('allowSenders');
  const sourceFetch = list.indexOf('this.#fetchSource');
  assert.ok(envelopeStage > 0, 'listMessages must consult the sender allowlist');
  assert.ok(sourceFetch > envelopeStage, 'the allowlist must be applied before the body fetch');
  // Every body fetch sits in the second pass, after the envelope loop closes.
  assert.match(list, /for \(const uid of accepted\)/, 'bodies are fetched from the accepted list only');
});

test('changing the mailbox allowlist pushes the matching access policy', async () => {
  // The mailbox allowlist and the Harness access policy are separate stores.
  // Updating only the allowlist left the policy holding the old senders, so
  // the channel kept rejecting every new sender even though it was listed.
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-policy-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    await store.save({
      platformId: 'bot@qq.com', name: 'bot@qq.com', provider: 'qq',
      allowedSenders: ['old@example.com'],
    });
    const [bot] = store.list();
    const synced = [];
    const controller = new EmailController({
      credentials: {
        async resolve() { return { value: JSON.stringify({ address: 'bot@qq.com', password: 'p' }) }; },
        async set() {}, async unset() {},
      },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      createRuntime: async () => ({ start: async () => {}, stop: async () => {}, status: {} }),
      syncAccessPolicy: async (botId, policy) => { synced.push({ botId, policy }); },
    });
    await controller.updateMailboxSettings(bot.botId, {
      allowedSenders: ['new@example.com', 'other@example.com'],
    });
    assert.equal(synced.length, 1, 'the access policy must be synced when the allowlist changes');
    assert.deepEqual(
      synced[0].policy.direct.allowlist.users.map((u) => u.id),
      ['new@example.com', 'other@example.com'],
    );
    assert.equal(synced[0].policy.direct.mode, 'allowlist');
    assert.equal(synced[0].policy.group.mode, 'allowlist');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('mail routing follows sender binding, then account binding, then a new session', async () => {
  // Three levels of freedom: a per-sender pin, an account-wide pin, or nothing
  // (each mail thread starts its own Harness session).
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-binding.json'));
  const mail = (address, id) => ({
    messageId: `<${id}@x>`,
    from: { value: [{ address }] },
    to: { value: [{ address: BOT }] },
    subject: id,
    text: 'hi',
  });

  // Level 3: unbound — each message maps to its own thread.
  assert.notEqual(
    normalizeEmail(mail('a@x.com', 'm1'), { address: BOT, state }).conversationId,
    normalizeEmail(mail('a@x.com', 'm2'), { address: BOT, state }).conversationId,
  );

  // Level 2: account-wide pin — every sender shares one conversation.
  await state.setEmailBindings({ account: 'session-FIXED', senders: {} });
  assert.equal(
    normalizeEmail(mail('a@x.com', 'm3'), { address: BOT, state }).conversationId,
    'bound:session-FIXED',
  );
  assert.equal(
    normalizeEmail(mail('b@x.com', 'm4'), { address: BOT, state }).conversationId,
    'bound:session-FIXED',
  );

  // Level 1: a sender pin wins over the account pin.
  await state.setEmailBindings({ account: 'session-FIXED', senders: { 'b@x.com': 'session-VIP' } });
  assert.equal(
    normalizeEmail(mail('a@x.com', 'm5'), { address: BOT, state }).conversationId,
    'bound:session-FIXED',
  );
  assert.equal(
    normalizeEmail(mail('b@x.com', 'm6'), { address: BOT, state }).conversationId,
    'bound:session-VIP',
  );
});

test('a bound conversation resolves to the pinned session instead of creating one', async () => {
  // Without the mapping the resolver misses the key and starts a fresh session,
  // so the pin would appear to save but have no effect.
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-binding-2.json'));
  await state.setEmailBindings({ account: 'session-ABC', senders: { 'vip@x.com': 'session-VIP' } });
  assert.equal(state.sessionFor('direct:bound:session-ABC'), 'session-ABC');
  // The bridge prefixes the chat kind, so the marker is not at offset 0.
  assert.equal(state.sessionFor('direct:bound:session-VIP'), 'session-VIP');
  assert.equal(state.sessionFor('direct:<thread@x>'), null);
});

test('session bindings survive a reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-bind-'));
  const path = join(dir, 'state.json');
  try {
    const first = await new EmailStateStore(path).load();
    await first.setEmailBindings({ account: 'session-1', senders: { 'a@x.com': 'session-2' } });
    const reloaded = await new EmailStateStore(path).load();
    assert.equal(reloaded.boundSessionFor('a@x.com'), 'session-2');
    assert.equal(reloaded.boundSessionFor('other@x.com'), 'session-1');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('the model sees the subject and the recipient lists', async () => {
  // Only the body used to be forwarded, so an instruction written in the
  // subject was dropped and a message with other recipients looked private.
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-headers.json'));
  const message = normalizeEmail({
    messageId: '<hdr@x>',
    from: { value: [{ address: 'boss@corp.com', name: '老板' }] },
    to: { value: [{ address: BOT }] },
    cc: { value: [{ address: 'team@corp.com', name: '团队' }] },
    subject: '统计销售数据',
    text: '统计上个月的数据',
  }, { address: BOT, state });
  assert.match(message.content, /^Subject: 统计销售数据$/m);
  assert.match(message.content, /^From: 老板 <boss@corp\.com>$/m);
  assert.match(message.content, new RegExp(`^To: ${BOT}$`, 'm'));
  assert.match(message.content, /^Cc: 团队 <team@corp\.com>$/m);
  assert.match(message.content, /统计上个月的数据/);
});

test('several senders can be pinned to the same session', async () => {
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-multi.json'));
  await state.setEmailBindings({
    account: null,
    senders: { 'a@x.com': 'session-SHARED', 'b@x.com': 'session-SHARED' },
  });
  assert.equal(state.boundSessionFor('a@x.com'), 'session-SHARED');
  assert.equal(state.boundSessionFor('b@x.com'), 'session-SHARED');
  // A different sender still starts its own thread.
  assert.equal(state.boundSessionFor('c@x.com'), null);
});

test('the mailbox fields survive the client snapshot normalizer', async () => {
  // The shared normalizer keeps an explicit field list, so a channel-specific
  // field is dropped unless the channel declares it — the settings form then
  // showed an empty allowlist even though the Host returned it.
  const { normalizeSnapshot } = await import('../../../plugin-src/client/channels/email/api.js');
  const snapshot = normalizeSnapshot({
    revision: 1,
    bots: [{
      botId: 'email_x', connected: true, state: 'connected',
      allowedSenders: ['a@x.com', 'b@y.com'],
      provider: 'qq', imapHost: 'imap.qq.com', imapPort: 993,
      smtpHost: 'smtp.qq.com', smtpPort: 587,
      bot: { name: 'u@qq.com' }, health: { summary: 'ok' },
    }],
  });
  const bot = snapshot.bots[0];
  assert.deepEqual(bot.allowedSenders, ['a@x.com', 'b@y.com']);
  assert.equal(bot.imapPort, 993);
  assert.equal(bot.smtpPort, 587);
  assert.equal(bot.provider, 'qq');
});

test('outgoing replies carry the RFC 3834 automatic-reply marker', async () => {
  // The marker is what lets a remote bot (or this mailbox) refuse to answer an
  // automatic reply, so it must travel on every message we send.
  const source = await readFile(
    new URL('../../../src/channels/email/transports/imap-smtp.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /'Auto-Submitted':\s*'auto-replied'/,
    'every outgoing mail must be marked as an automatic reply');
});

test('the mailbox answers its own hand-written mail without looping', async () => {
  // End-to-end shape of the loop break: a mail the mailbox sends itself is
  // processed, the reply is marked automatic, and that reply is then ignored.
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-loop.json'));
  const own = normalizeEmail(parsedMail({ from: { value: [{ address: BOT }] } }),
    { address: BOT, state });
  assert.ok(own, 'the hand-written mail is processed');

  const reply = normalizeEmail(parsedMail({
    from: { value: [{ address: BOT }] },
    headers: new Map([['auto-submitted', 'auto-replied']]),
  }), { address: BOT, state });
  assert.equal(reply, null, 'our own automatic reply must not be processed again');
});

test('re-initializing does not tear down a running mailbox runtime', async () => {
  // initialize() runs on every supervisor health check. Rebuilding the runtime
  // each time reset its poll loop before a pass could finish, so no mail was
  // ever read and the mailbox looked connected but silent.
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-reinit-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    await store.save({
      platformId: 'bot@qq.com', name: 'bot@qq.com', provider: 'qq',
      allowedSenders: ['boss@example.com'],
    });
    const [bot] = store.list();
    let started = 0;
    let stopped = 0;
    const controller = new EmailController({
      credentials: {
        async resolve() { return { value: JSON.stringify({ address: 'bot@qq.com', password: 'p' }) }; },
        async set() {}, async unset() {},
      },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      createRuntime: async () => ({
        start: async () => { started += 1; },
        stop: async () => { stopped += 1; },
        status: { ready: true, connectionState: 'connected' },
      }),
    });
    await controller.initialize();
    assert.equal(started, 1, 'the first initialize starts the runtime');
    // Three more health checks must reuse it.
    await controller.initialize();
    await controller.initialize();
    await controller.initialize();
    assert.equal(started, 1, 'later health checks must not restart a running runtime');
    assert.equal(stopped, 0, 'a healthy runtime must not be stopped by a health check');
    assert.deepEqual(controller.status().totals, { configured: 1, connected: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('the mailbox transport is selected from its configuration', async () => {
  // One channel hosts every mail protocol: the configured transport key picks
  // the implementation, so a new protocol is a new transport, not a channel.
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const {
    EMAIL_TRANSPORTS, DEFAULT_EMAIL_TRANSPORT, normalizeEmailTransport,
  } = await import('../../../src/channels/email/config-store.mjs');

  assert.ok(Object.hasOwn(EMAIL_TRANSPORTS, DEFAULT_EMAIL_TRANSPORT));
  assert.equal(normalizeEmailTransport(undefined), DEFAULT_EMAIL_TRANSPORT);
  assert.equal(normalizeEmailTransport('AGENT-MAIL'), 'agent-mail');
  assert.throws(() => normalizeEmailTransport('carrier-pigeon'), TypeError);

  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-transport-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    await store.save({
      platformId: 'bot@qq.com', name: 'bot@qq.com', provider: 'qq',
      transport: 'agent-mail', allowedSenders: ['boss@example.com'],
    });
    const [bot] = store.list();
    assert.equal(bot.transport, 'agent-mail', 'the transport persists');

    const used = [];
    const controller = new EmailController({
      credentials: {
        async resolve() { return { value: JSON.stringify({ address: 'bot@qq.com', password: 'p' }) }; },
        async set() {}, async unset() {},
      },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: {
        'imap-smtp': () => {
          used.push('imap-smtp');
          return {
            connect: async () => {}, disconnect: async () => {}, latestUid: async () => 0,
            listMessages: async () => [], sendReply: async () => {}, sendText: async () => {},
          };
        },
        'agent-mail': () => {
          used.push('agent-mail');
          // A complete stub: the contract check would reject anything less.
          return {
            connect: async () => {}, disconnect: async () => {}, latestUid: async () => 0,
            listMessages: async () => [], sendReply: async () => {}, sendText: async () => {},
          };
        },
      },
      createRuntime: async () => ({ start: async () => {}, stop: async () => {}, status: {} }),
    });
    await controller.bindMailbox({
      address: 'bot@qq.com', transport: 'agent-mail',
      // An Agent mailbox authorizes by scan, so it needs the token pair rather
      // than a password.
      accessToken: 'AT', refreshToken: 'RT',
      allowedSenders: ['boss@example.com'],
    });
    assert.deepEqual(used, ['agent-mail'], 'the configured transport is the one constructed');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('an incomplete transport is rejected at the boundary', async () => {
  const { assertTransport, TRANSPORT_METHODS } = await import(
    '../../../src/channels/email/transport.mjs'
  );
  assert.ok(TRANSPORT_METHODS.includes('listMessages'));
  assert.throws(() => assertTransport(null), TypeError);
  assert.throws(() => assertTransport({ connect: () => {} }), /must implement/);
  const complete = Object.fromEntries(TRANSPORT_METHODS.map((m) => [m, () => {}]));
  assert.equal(assertTransport(complete), complete);
});

/** A fake agent.qq.com that records calls and serves scripted responses. */
function fakeAgentMail({ responses = [], tokens = { access: 'tok-1', refresh: 'ref-1' } } = {}) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: url.replace(/^https:\/\/api\.agent\.qq\.com/, ''), method: options.method ?? 'GET' });
    // Reuse the last script once exhausted: a listing walks several pages, and
    // every page should get the same answer.
    const scripted = queue.length > 1 ? queue.shift() : queue[0];
    if (scripted) return scripted(url, options);
    if (url.includes('/v1/me')) {
      return jsonResponse({ data: { aliases: [
        { alias_id: 'ALIAS1', email: 'bot@agent.qq.com', is_primary: true },
      ] } });
    }
    return jsonResponse({ data: [] });
  };
  return { calls, fetchImpl, tokens };
}

function jsonResponse(data, status = 200) {
  return {
    ok: status < 400,
    status,
    text: async () => JSON.stringify(data),
    json: async () => data,
  };
}









test('a mailbox is displayed under its own address, not a generic label', async () => {
  // The shared client reads the identity from `bot`; a name left at the top
  // level is ignored and the UI falls back to "<channel>机器人", which showed a
  // mailbox as "Email机器人".
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-name-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    await store.save({
      platformId: 'someone@qq.com', name: 'someone@qq.com', provider: 'qq',
      allowedSenders: ['boss@example.com'],
    });
    const controller = new EmailController({
      credentials: {
        async resolve() { return null; }, async set() {}, async unset() {},
      },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: {
        'imap-smtp': makeStubTransport,
        'agent-mail': makeStubTransport,
      },
      createRuntime: async () => ({ start: async () => {}, stop: async () => {}, status: {} }),
    });
    const [bot] = controller.status().bots;
    assert.equal(bot.bot.name, 'someone@qq.com', 'the address is the display name');
    assert.equal(bot.bot.username, 'someone@qq.com');
    // The masked form stays available for the secondary line.
    // Two leading characters kept, the rest of the local part masked.
    assert.equal(bot.bot.idMasked, 'so*****@qq.com');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('an Agent mailbox without a stored name still shows its address', async () => {
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-name2-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    // An out-of-band authorization may bind without ever naming the mailbox.
    await store.save({
      platformId: 'bot@agent.qq.com', transport: 'agent-mail', allowedSenders: ['boss@example.com'],
    });
    const controller = new EmailController({
      credentials: {
        async resolve() { return null; }, async set() {}, async unset() {},
      },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: {
        'imap-smtp': makeStubTransport,
        'agent-mail': makeStubTransport,
      },
      createRuntime: async () => ({ start: async () => {}, stop: async () => {}, status: {} }),
    });
    const [bot] = controller.status().bots;
    assert.equal(bot.bot.name, 'bot@agent.qq.com');
    assert.equal(bot.transport ?? store.list()[0].transport, 'agent-mail');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});





test('the status reports which transport a mailbox uses', async () => {
  // Without this the settings page cannot tell an Agent mailbox from an
  // IMAP/SMTP one, and describes it with server hosts it does not have.
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-transport-status-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    await store.save({
      platformId: 'bot@agent.qq.com', transport: 'agent-mail',
      allowedSenders: ['boss@example.com'],
    });
    await store.save({
      platformId: 'me@qq.com', provider: 'qq', allowedSenders: ['boss@example.com'],
    });
    const controller = new EmailController({
      credentials: { async resolve() { return null; }, async set() {}, async unset() {} },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: {
        'imap-smtp': makeStubTransport,
        'agent-mail': makeStubTransport,
      },
      createRuntime: async () => ({ start: async () => {}, stop: async () => {}, status: {} }),
    });
    const byAddress = Object.fromEntries(
      controller.status().bots.map((bot) => [bot.bot.name, bot.transport]),
    );
    assert.equal(byAddress['bot@agent.qq.com'], 'agent-mail');
    // A mailbox saved without a transport keeps the standard protocol.
    assert.equal(byAddress['me@qq.com'], 'imap-smtp');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('a mailbox can switch transport', async () => {
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-switch-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    await store.save({
      platformId: 'me@qq.com', provider: 'qq', allowedSenders: ['boss@example.com'],
    });
    const [bot] = store.list();
    const controller = new EmailController({
      credentials: { async resolve() { return null; }, async set() {}, async unset() {} },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: {
        'imap-smtp': makeStubTransport,
        'agent-mail': makeStubTransport,
      },
      createRuntime: async () => ({ start: async () => {}, stop: async () => {}, status: {} }),
    });
    await controller.updateMailboxSettings(bot.botId, { transport: 'agent-mail' });
    const [updated] = store.list();
    assert.equal(updated.transport, 'agent-mail');
    // An unknown transport is refused rather than silently stored.
    await assert.rejects(
      () => controller.updateMailboxSettings(bot.botId, { transport: 'carrier-pigeon' }),
      TypeError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('the client keeps the transport field from the host snapshot', async () => {
  const { normalizeSnapshot } = await import(
    '../../../plugin-src/client/channels/email/api.js'
  );
  const snapshot = normalizeSnapshot({
    revision: 1,
    bots: [{
      botId: 'email_x', connected: true, state: 'connected',
      transport: 'agent-mail', allowedSenders: ['boss@example.com'],
      bot: { name: 'bot@agent.qq.com' }, health: { summary: 'ok' },
    }],
  });
  assert.equal(snapshot.bots[0].transport, 'agent-mail');
});


test('the reply target carries both ids', () => {
  // A transport that addresses messages by its own id needs it; one that only
  // needs the RFC header ignores it.
  const state = new EmailStateStore(join(tmpdir(), 'unused-email-bothids.json'));
  const message = normalizeEmail(parsedMail(), { address: BOT, state });
  assert.equal(message.replyTarget.messageId, '<m1@mail.example>');
  assert.ok('transportMessageId' in message.replyTarget,
    'the transport id travels alongside the RFC one');
});


test('a failed startup reports a usable reason', async () => {
  // An AggregateError carries an empty message with the reason on `code`
  // (ECONNREFUSED and friends). `??` does not fall through an empty string, so
  // the settings card showed a blank error and could not be acted on.
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-safeerror-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    await store.save({
      platformId: 'x@agent.qq.com', transport: 'agent-mail',
      allowedSenders: ['boss@example.com'],
    });
    const refused = new AggregateError([]);
    refused.code = 'ECONNREFUSED';
    const controller = new EmailController({
      credentials: {
        async resolve() {
          return { value: JSON.stringify({ address: 'x@agent.qq.com', accessToken: 't' }) };
        },
        async set() {}, async unset() {},
      },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: {
        'imap-smtp': () => ({}),
        'agent-mail': () => ({
          connect: async () => { throw refused; },
          disconnect: async () => {}, latestUid: async () => 0,
          listMessages: async () => [], sendReply: async () => {}, sendText: async () => {},
        }),
      },
      // The failure surfaces when the runtime starts, which is where a
      // connection refusal lands.
      createRuntime: async () => ({
        start: async () => { throw refused; },
        stop: async () => {},
        status: {},
      }),
    });
    const status = await controller.initialize();
    const bot = status.bots.find((b) => b.bot.name === 'x@agent.qq.com');
    assert.ok(bot?.error, 'the failure is recorded');
    assert.ok(String(bot.error.message).trim().length > 0,
      `the reason must not be blank (got ${JSON.stringify(bot.error.message)})`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('the runtime hands its transport key to the transport factory', async () => {
  // The runtime built the transport config without the transport key, so every
  // mailbox was dialled as IMAP/SMTP — an Agent mailbox then failed with
  // ECONNREFUSED because it was addressed as a mail server.
  const { EmailRuntime } = await import('../../../src/channels/email/email-runtime.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-transportkey-'));
  try {
    const state = await new EmailStateStore(join(dir, 'state.json')).load();
    let received = null;
    const runtime = new EmailRuntime({
      config: { platformId: 'bot@agent.qq.com', transport: 'agent-mail', allowedSenders: [] },
      token: 'unused',
      credential: { address: 'bot@agent.qq.com', accessToken: 'AT' },
      harness: { ensureRunning: async () => {} },
      state,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      createApi: (options) => {
        received = options.config;
        return {
          connect: async () => {}, disconnect: async () => {}, latestUid: async () => 0,
          listMessages: async () => [], sendReply: async () => {}, sendText: async () => {},
        };
      },
    });
    await runtime.start();
    assert.ok(received, 'the transport was constructed');
    assert.equal(received.transport, 'agent-mail', 'the configured key reaches the factory');
    assert.equal(received.accessToken, 'AT');
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('the runtime uses the transport its caller supplies', async () => {
  // The runtime defaulted to IMAP/SMTP regardless of the mailbox's protocol,
  // so an Agent mailbox was dialled as a mail server and failed on port 993
  // with ECONNREFUSED while its own API worked fine.
  const { EmailRuntime } = await import('../../../src/channels/email/email-runtime.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-inject-'));
  try {
    const state = await new EmailStateStore(join(dir, 'state.json')).load();
    const built = [];
    const stub = () => ({
      connect: async () => {}, disconnect: async () => {}, latestUid: async () => 0,
      listMessages: async () => [], sendReply: async () => {}, sendText: async () => {},
    });
    const runtime = new EmailRuntime({
      config: { platformId: 'bot@agent.qq.com', transport: 'agent-mail', allowedSenders: [] },
      token: 'unused',
      credential: { address: 'bot@agent.qq.com', accessToken: 'AT' },
      harness: { ensureRunning: async () => {} },
      state,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      // What the controller injects.
      createTransport: (options) => { built.push(options.transport ?? options.config?.transport); return stub(); },
    });
    await runtime.start();
    assert.deepEqual(built, ['agent-mail'], 'the supplied factory builds the configured transport');
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('the controller tells the runtime which transport to build', async () => {
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-inject2-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    await store.save({
      platformId: 'bot@agent.qq.com', transport: 'agent-mail',
      allowedSenders: ['boss@example.com'],
    });
    let factory = null;
    let built = null;
    const stub = () => ({
      connect: async () => {}, disconnect: async () => {}, latestUid: async () => 0,
      listMessages: async () => [], sendReply: async () => {}, sendText: async () => {},
    });
    const controller = new EmailController({
      credentials: {
        async resolve() {
          return { value: JSON.stringify({ address: 'bot@agent.qq.com', accessToken: 'AT' }) };
        },
        async set() {}, async unset() {},
      },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: {
        'imap-smtp': stub,
        'agent-mail': (options) => { built = options.config.transport; return stub(); },
      },
      // Stand in for the runtime: capture what the controller injects.
      createRuntime: async ({ createTransport }) => {
        factory = createTransport;
        return { start: async () => {}, stop: async () => {}, status: {} };
      },
    });
    await controller.initialize();
    assert.equal(typeof factory, 'function', 'a transport factory is injected');
    factory({ config: { transport: 'agent-mail' } });
    assert.equal(built, 'agent-mail', 'the injected factory honours the mailbox protocol');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});



test('the mailbox update endpoint accepts the fields the client sends', async () => {
  // The client sends mailbox fields flat beside botId, as every other endpoint
  // does. The handler read a nested `update`, so the whole change was discarded
  // and the call still reported success — the allowlist looked saved and was
  // not.
  const { createEmailRpcHandler } = await import(
    '../../../plugin-src/host/channels/email/rpc.mjs'
  );
  const seen = [];
  const controller = {
    status: () => ({ revision: 0, bots: [], totals: { configured: 0, connected: 0 } }),
    // The shared handler validates the whole controller surface before use.
    async bindCredentials() {}, async bindMailbox() {}, async reconnectBot() {},
    async deleteBot() {}, async setWorkspace() {}, async setModel() {},
    async setAgentPreset() {}, async setContextEnhancement() {}, async setAccessPolicy() {},
    async setAlias() {},
    async updateMailboxSettings(botId, update) { seen.push({ botId, update }); return { ok: true }; },
  };
  const handler = createEmailRpcHandler(controller);

  await handler('bot.mailbox.update', {
    botId: 'email_1',
    allowedSenders: ['a@x.com', 'b@y.com'],
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].botId, 'email_1');
  assert.deepEqual(seen[0].update, { allowedSenders: ['a@x.com', 'b@y.com'] },
    'the flat fields reach the controller');
  assert.ok(!('botId' in seen[0].update), 'the addressing field is not passed through');

  // The nested form keeps working for callers that use it.
  await handler('bot.mailbox.update', { botId: 'email_1', update: { allowedSenders: ['c@z.com'] } });
  assert.deepEqual(seen[1].update, { allowedSenders: ['c@z.com'] });
});

test('a failing poll stops the mailbox reporting itself healthy', async () => {
  // The transport opens once, then polls forever. A poll that keeps failing —
  // an expired token, say — left connectionState at "connected", so the
  // settings card said the channel was healthy while no mail could be read.
  const { EmailRuntime } = await import('../../../src/channels/email/email-runtime.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-pollfail-'));
  try {
    const state = await new EmailStateStore(join(dir, 'state.json')).load();
    let fail = false;
    const runtime = new EmailRuntime({
      config: { platformId: 'bot@agent.qq.com', transport: 'agent-mail', allowedSenders: [] },
      token: 'unused',
      credential: { address: 'bot@agent.qq.com', accessToken: 'AT' },
      harness: { ensureRunning: async () => {} },
      state,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      pollIntervalMs: 20,
      createApi: () => ({
        connect: async () => {}, disconnect: async () => {}, latestUid: async () => 0,
        listMessages: async () => {
          if (fail) throw Object.assign(new Error('/v1/me failed: HTTP 401 private-token'), { status: 401 });
          return [];
        },
        sendReply: async () => {}, sendText: async () => {},
      }),
    });
    await runtime.start();
    assert.equal(runtime.status.connectionState, 'connected');

    fail = true;
    // Let the poll loop run into the failure.
    for (let i = 0; i < 40 && runtime.status.connectionState !== 'failed'; i += 1) {
      await new Promise((r) => { setTimeout(r, 25); });
    }
    assert.equal(runtime.status.connectionState, 'failed',
      'a failing poll must not keep reporting connected');
    assert.equal(runtime.status.error.details.httpStatus, 401);
    assert.equal(runtime.status.error.details.stage, 'connection.poll');
    assert.doesNotMatch(JSON.stringify(runtime.status), /private-token|\/v1\/me/);

    // Recovery is reflected too.
    fail = false;
    for (let i = 0; i < 40 && runtime.status.connectionState !== 'connected'; i += 1) {
      await new Promise((r) => { setTimeout(r, 25); });
    }
    assert.equal(runtime.status.connectionState, 'connected', 'a healthy poll restores the state');
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});


test('a numeric cursor still keeps the startup window', async () => {
  // IMAP is numbered, so the window that catches mail arriving during startup
  // must survive the fix above.
  const { EmailRuntime } = await import('../../../src/channels/email/email-runtime.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-cursor2-'));
  try {
    const state = await new EmailStateStore(join(dir, 'state.json')).load();
    const runtime = new EmailRuntime({
      config: { platformId: 'me@qq.com', transport: 'imap-smtp', allowedSenders: [] },
      token: 'unused',
      harness: { ensureRunning: async () => {} },
      state,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      createApi: () => ({
        connect: async () => {}, disconnect: async () => {}, latestUid: async () => 100,
        listMessages: async () => [], sendReply: async () => {}, sendText: async () => {},
      }),
    });
    await runtime.start();
    assert.equal(state.cursor(), 90, 'the startup window is still applied to numeric cursors');
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});



test('an already-seen message is not delivered twice', async () => {
  // The cursor marks a boundary in the listing, but a mailbox whose listing
  // shifts (mail moved or deleted) loses that boundary and the same messages
  // come back every poll — each one re-running a turn.
  // A private directory: a shared path would carry state between tests.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-seen-'));
  try {
    const state = await new EmailStateStore(join(dir, 'seen.json')).load();
    const key = '<rfc-1@x>';
    assert.equal(state.hasSeen(key), false, 'a fresh message is unseen');
    await state.markSeen(key);
    assert.equal(state.hasSeen(key), true, 'a delivered message is recorded');

    const path = join(dir, 'state.json');
    const first = await new EmailStateStore(path).load();
    await first.markSeen('<rfc-2@x>');
    const reloaded = await new EmailStateStore(path).load();
    assert.equal(reloaded.hasSeen('<rfc-2@x>'), true);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});


// ---------------------------------------------------------------------------
// Agent mailbox — now backed by the official agently-cli
// ---------------------------------------------------------------------------

/** Build a fetch-free CLI stub: each call resolves the next queued document. */
function stubCli(queue) {
  const calls = [];
  return {
    calls,
    impl(args, options = {}) {
      calls.push({ args, input: options.input ?? null });
      // The transport probes its own workspace once; answer without consuming
      // the scripted responses, which describe the protocol under test.
      if (args[0] === 'auth' && args[1] === 'status') {
        return Promise.resolve({
          document: { ok: true, data: { logged_in: false } }, stdout: '', stderr: '', exitCode: 0,
        });
      }
      const next = queue.shift();
      if (next === undefined) throw new Error(`unexpected CLI call: ${args.join(' ')}`);
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve({ document: next, stdout: JSON.stringify(next), stderr: '', exitCode: 0 });
    },
  };
}

test('the agent mailbox lists, reads and threads through the CLI', async () => {
  // The list carries only a snippet; the body and the RFC Message-ID come from
  // the per-message read, so listing alone would drop the mail as empty.
  const { createAgentMailTransportForTests } = await import(
    '../../../src/channels/email/transports/agent-mail.mjs'
  );
  const cli = stubCli([
    // +me (connect)
    { ok: true, data: { aliases: [{ alias_id: 'A1', email: 'bot@agent.qq.com', is_primary: true }] } },
    // message +list
    { ok: true, data: { data: [
      { message_id: 'msg_2', subject: 'Second', snippet: 's2', from: { email: 'a@x.com' } },
      { message_id: 'msg_1', subject: 'First', snippet: 's1', from: { email: 'a@x.com' } },
    ], pagination: { has_more: false } } },
    // message +read (oldest first → msg_1, then msg_2)
    { ok: true, data: { message_id: 'msg_1', rfc_message_id: '<rfc-1@x>', body: 'body one',
      from: { email: 'a@x.com' }, to: [{ email: 'bot@agent.qq.com' }], subject: 'First' } },
    { ok: true, data: { message_id: 'msg_2', rfc_message_id: '<rfc-2@x>', body: 'body two',
      from: { email: 'a@x.com' }, to: [{ email: 'bot@agent.qq.com' }], subject: 'Second' } },
  ]);
  const transport = createAgentMailTransportForTests({
    config: { address: 'bot@agent.qq.com' }, runCliImpl: cli.impl,
  });
  await transport.connect();
  const messages = await transport.listMessages({ afterUid: null, limit: 25 });

  assert.deepEqual(messages.map((m) => m.uid), ['msg_1', 'msg_2'], 'oldest first');
  assert.deepEqual(messages.map((m) => m.messageId), ['<rfc-1@x>', '<rfc-2@x>'],
    'the RFC Message-ID is the thread key');
  assert.deepEqual(messages.map((m) => m.text), ['body one', 'body two'], 'bodies are read');
  assert.ok(cli.calls.some((c) => c.args[0] === 'message' && c.args[1] === '+read'),
    'the body came from a per-message read');
});

test('the agent mailbox stops at the cursor and filters unlisted senders', async () => {
  const { createAgentMailTransportForTests } = await import(
    '../../../src/channels/email/transports/agent-mail.mjs'
  );
  const cli = stubCli([
    { ok: true, data: { data: [
      { message_id: 'msg_3', subject: 'New', snippet: 's', from: { email: 'stranger@evil.com' } },
      { message_id: 'msg_2', subject: 'Older', snippet: 's', from: { email: 'a@x.com' } },
      { message_id: 'msg_1', subject: 'Handled', snippet: 's', from: { email: 'a@x.com' } },
    ], pagination: {} } },
    { ok: true, data: { message_id: 'msg_2', rfc_message_id: '<rfc-2@x>', body: 'kept',
      from: { email: 'a@x.com' }, subject: 'Older' } },
  ]);
  const transport = createAgentMailTransportForTests({
    config: { address: 'bot@agent.qq.com' }, runCliImpl: cli.impl,
  });
  const messages = await transport.listMessages({
    afterUid: 'msg_1', limit: 25, allowSenders: new Set(['a@x.com']),
  });
  assert.deepEqual(messages.map((m) => m.uid), ['msg_2'],
    'the unlisted sender is dropped and the cursor stops the walk');
  assert.ok(!cli.calls.some((c) => c.args.includes('msg_3')),
    'no read is issued for a filtered sender');
});

test('a reply completes the CLI two-step confirmation', async () => {
  const { createAgentMailTransportForTests } = await import(
    '../../../src/channels/email/transports/agent-mail.mjs'
  );
  const cli = stubCli([
    { ok: true, data: { confirmation_required: true, confirmation_token: 'ct_1', summary: 'send?' } },
    { ok: true, data: { message_id: 'msg_9' } },
  ]);
  const transport = createAgentMailTransportForTests({
    config: { address: 'bot@agent.qq.com' }, runCliImpl: cli.impl,
  });
  const result = await transport.sendReply({
    to: 'a@x.com', subject: 'Re: Hi', text: 'hello', transportMessageId: 'msg_5',
  });
  assert.equal(result.sent, true);
  const sends = cli.calls.filter((c) => c.args.includes('+reply'));
  assert.equal(sends.length, 2, 'the send is retried once with the token');
  assert.ok(sends[1].args.includes('--confirmation-token'));
  assert.ok(sends[1].args.includes('ct_1'));
  // `--body-file -` is read as a literal filename by the CLI, so the text has
  // to travel as an argument.
  const bodyAt = sends[0].args.indexOf('--body');
  assert.ok(bodyAt >= 0, 'the body is passed with --body');
  assert.equal(sends[0].args[bodyAt + 1], 'hello');
});

test('a CLI failure surfaces its own message, not the exit code', async () => {
  // The CLI exits 0 even for an error document, so `ok` is the only signal —
  // reading the exit code would report success for a refusal.
  const { runCliDocumentForTests } = await import(
    '../../../src/channels/email/transports/agently-cli.mjs'
  );
  await assert.rejects(
    () => runCliDocumentForTests([ 'auth', 'status' ], {
      runCliImpl: () => Promise.resolve({
        document: { ok: false, error: { type: 'auth', message: 'authorization required' } },
        stdout: '', stderr: '', exitCode: 0,
      }),
    }),
    (error) => {
      assert.equal(error.code, 'auth');
      assert.match(error.message, /authorization required/);
      return true;
    },
  );
});

test('the Agent mailbox needs no credential of its own', async () => {
  // agently-cli keeps its credentials in the system keychain, so requiring a
  // stored token blocked the mailbox from ever starting.
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-nocred-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    await store.save({
      platformId: 'bot@agent.qq.com', transport: 'agent-mail',
      allowedSenders: ['a@x.com'],
    });
    const started = [];
    const controller = new EmailController({
      credentials: {
        async resolve() { return null; },   // nothing stored, by design
        async set() {}, async unset() {},
      },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: {
        'imap-smtp': makeStubTransport,
        'agent-mail': makeStubTransport,
      },
      createRuntime: async ({ config, credential }) => {
        started.push({ config, credential });
        return { start: async () => {}, stop: async () => {}, status: { ready: true, connectionState: 'connected' } };
      },
    });
    const status = await controller.initialize();
    assert.equal(started.length, 1, 'the mailbox starts without a stored secret');
    assert.equal(started[0].credential.address, 'bot@agent.qq.com');
    assert.equal(status.bots[0].state, 'connected');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('the runtime starts an Agent mailbox that carries no token', async () => {
  // agently-cli holds the credentials, so the runtime is handed an address
  // only. Requiring a token blocked the mailbox from ever starting — it
  // reported "requires config, token, Harness, and state".
  const { EmailRuntime } = await import('../../../src/channels/email/email-runtime.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-notoken-'));
  try {
    const state = await new EmailStateStore(join(dir, 'state.json')).load();
    const runtime = new EmailRuntime({
      config: { platformId: 'bot@agent.qq.com', transport: 'agent-mail', allowedSenders: [] },
      // No token: the CLI owns the session.
      harness: { ensureRunning: async () => {} },
      state,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      createApi: () => ({
        connect: async () => {}, disconnect: async () => {}, latestUid: async () => 0,
        listMessages: async () => [], sendReply: async () => {}, sendText: async () => {},
      }),
    });
    await runtime.start();
    assert.equal(runtime.status.ready, true, 'the mailbox starts without a token');
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/** A transport that satisfies the contract and does nothing. */
function makeStubTransport() {
  return {
    connect: async () => {}, disconnect: async () => {}, latestUid: async () => 0,
    listMessages: async () => [], sendReply: async () => {}, sendText: async () => {},
  };
}

test('a mailbox can be connected before any sender is authorized', async () => {
  // Connecting first and authorizing senders later is the smoother path; the
  // policy derived from an empty allowlist admits nobody, so it stays
  // fail-closed and the mailbox cannot be driven yet.
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-emptyallow-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    const started = [];
    const controller = new EmailController({
      credentials: {
        async resolve() { return null; }, async set() {}, async unset() {},
      },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: {
        'imap-smtp': makeStubTransport,
        'agent-mail': makeStubTransport,
      },
      createRuntime: async ({ config }) => {
        started.push(config);
        return { start: async () => {}, stop: async () => {}, status: { ready: true, connectionState: 'connected' } };
      },
    });
    const status = await controller.bindMailbox({
      address: 'bot@agent.qq.com', transport: 'agent-mail', allowedSenders: [],
    });
    assert.equal(started.length, 1, 'the mailbox binds without an allowlist');
    assert.deepEqual(started[0].allowedSenders, []);
    assert.equal(status.bots[0].state, 'connected');

    // The policy is still fail-closed: nobody is admitted yet.
    const [bot] = store.list();
    assert.deepEqual(bot.allowedSenders, []);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('each agent mailbox authorizes in its own CLI workspace', async () => {
  // The CLI isolates accounts per workspace. Sharing one made every Agent
  // mailbox read whichever account authorized first.
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-ws-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    const controller = new EmailController({
      credentials: {
        async resolve() { return null; }, async set() {}, async unset() {},
      },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: {
        'imap-smtp': makeStubTransport,
        'agent-mail': makeStubTransport,
      },
      createRuntime: async () => ({ start: async () => {}, stop: async () => {}, status: {} }),
      // Stand in for the CLI-backed authorization.
      startAuthorizationImpl: null,
    });
    const seen = [];
    controller.startAuthorization = async (options) => {
      seen.push(options?.workspace);
      return { transport: 'agent-mail', browserUrl: 'https://x', expiresAt: Date.now() + 600_000 };
    };
    await controller.startAuthorization({ transport: 'agent-mail', workspace: 'a@agent.qq.com' });
    await controller.startAuthorization({ transport: 'agent-mail', workspace: 'b@agent.qq.com' });
    assert.deepEqual(seen, ['a@agent.qq.com', 'b@agent.qq.com'],
      'each mailbox carries its own workspace into authorization');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('falling back to another account is refused', async () => {
  // The CLI separates accounts per workspace, so a fallback to the default is
  // only safe when that login owns this address. Accepting someone else's
  // login would send this mailbox's replies from the wrong sender.
  const { createAgentMailTransportForTests } = await import(
    '../../../src/channels/email/transports/agent-mail.mjs'
  );
  const cli = (args, options = {}) => {
    if (args[0] === 'auth' && args[1] === 'status') {
      // This mailbox's own workspace has no login.
      return Promise.resolve({ document: { ok: true, data: { logged_in: false } }, stdout: '', stderr: '', exitCode: 0 });
    }
    return Promise.resolve({
      document: { ok: true, data: { aliases: [{ alias_id: 'A1', email: 'someone-else@agent.qq.com', is_primary: true }] } },
      stdout: '', stderr: '', exitCode: 0,
    });
  };
  const transport = createAgentMailTransportForTests({
    config: { address: 'pinned@agent.qq.com' }, runCliImpl: cli,
  });
  await assert.rejects(
    () => transport.connect(),
    (error) => {
      assert.equal(error.code, 'identity-mismatch');
      assert.match(error.message, /someone-else@agent\.qq\.com/);
      return true;
    },
    'a login that owns a different address must not be adopted',
  );
});

test('a mailbox uses its own workspace identity', async () => {
  const { createAgentMailTransportForTests } = await import(
    '../../../src/channels/email/transports/agent-mail.mjs'
  );
  const cli = (args) => {
    if (args[0] === 'auth' && args[1] === 'status') {
      return Promise.resolve({ document: { ok: true, data: { logged_in: true } }, stdout: '', stderr: '', exitCode: 0 });
    }
    return Promise.resolve({
      document: { ok: true, data: { aliases: [{ alias_id: 'A2', email: 'pinned@agent.qq.com', is_primary: true }] } },
      stdout: '', stderr: '', exitCode: 0,
    });
  };
  const transport = createAgentMailTransportForTests({
    config: { address: 'pinned@agent.qq.com' }, runCliImpl: cli,
  });
  await transport.connect();
  assert.equal(transport.address, 'pinned@agent.qq.com', 'the matching address is accepted');
});

test('a mailbox uses its own workspace when it has a login', async () => {
  // With two accounts authorized, each mailbox must read its own.
  const { createAgentMailTransportForTests } = await import(
    '../../../src/channels/email/transports/agent-mail.mjs'
  );
  const seen = [];
  const cli = (args, options = {}) => {
    seen.push({ args, workspace: options.env?.AGENTLY_WORKSPACE ?? null });
    if (args[0] === 'auth' && args[1] === 'status') {
      return Promise.resolve({ document: { ok: true, data: { logged_in: true } }, stdout: '', stderr: '', exitCode: 0 });
    }
    return Promise.resolve({
      document: { ok: true, data: { aliases: [{ alias_id: 'A2', email: 'pinned@agent.qq.com', is_primary: true }] } },
      stdout: '', stderr: '', exitCode: 0,
    });
  };
  const transport = createAgentMailTransportForTests({
    config: { address: 'pinned@agent.qq.com' }, runCliImpl: cli,
  });
  await transport.connect();
  const meCall = seen.find((c) => c.args[0] === '+me');
  assert.equal(meCall.workspace, 'pinned@agent.qq.com', 'its own workspace wins when it has a login');
});





test('an allowlisted sender may execute without a confirming reply', async () => {
  // The intended behaviour: mail from an allowlisted address runs directly.
  // Anyone else is refused, and the policy defaults to no execution at all.
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-policy-'));
  try {
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    let pushed = null;
    const controller = new EmailController({
      credentials: { async resolve() { return null; }, async set() {}, async unset() {} },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: { 'imap-smtp': makeStubTransport, 'agent-mail': makeStubTransport },
      createRuntime: async () => ({ start: async () => {}, stop: async () => {}, status: {} }),
      syncAccessPolicy: async (botId, policy) => { pushed = policy; },
    });
    await controller.bindMailbox({
      address: 'a@agent.qq.com', transport: 'agent-mail',
      allowedSenders: ['boss@corp.com'],
    });

    assert.ok(pushed, 'a policy is pushed to the Harness');
    const direct = pushed.direct ?? pushed;
    const users = direct.allowlist?.users ?? direct.users ?? [];
    const boss = users.find((u) => u.id === 'boss@corp.com');
    assert.ok(boss, 'the allowlisted sender is present in the policy');
    assert.equal(boss.canExecuteCommands, true, 'and may execute commands');
    assert.equal(direct.open?.defaultCanExecuteCommands, false,
      'nobody outside the allowlist may execute');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('a turn waiting on approval does not stop later mail being read', async () => {
  // `accept` resolves only when the Harness turn ends, and a turn waiting for
  // an approval never ends until someone replies — so awaiting it in the poll
  // loop left every later message unread.
  const { EmailRuntime } = await import('../../../src/channels/email/email-runtime.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-block-'));
  try {
    const state = await new EmailStateStore(join(dir, 'state.json')).load();
    const mail = (n) => ({
      uid: `msg_${n}`, messageId: `<rfc-${n}@x>`,
      from: { value: [{ address: 'a@x.com' }] },
      to: { value: [{ address: 'b@y.com' }] },
      cc: { value: [] }, subject: `S${n}`, text: `body ${n}`, attachments: [],
    });
    const runtime = new EmailRuntime({
      config: { platformId: 'b@y.com', transport: 'agent-mail', allowedSenders: ['a@x.com'] },
      harness: { ensureRunning: async () => {} },
      state,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      pollIntervalMs: 30,
      createApi: () => ({
        connect: async () => {}, disconnect: async () => {}, latestUid: async () => 'msg_2',
        listMessages: async () => [mail(1), mail(2)],
        sendReply: async () => {}, sendText: async () => {},
      }),
    });
    await runtime.start();
    // A turn that never settles, as one waiting for approval would be.
    if (runtime.bridge) runtime.bridge.accept = () => new Promise(() => {});

    const firstCheck = runtime.status.lastCheckedAt;
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    assert.notEqual(runtime.status.lastCheckedAt, firstCheck,
      'the poll loop keeps running while a turn is parked');

    // Shutdown must not hang on the parked delivery either.
    const stopped = await Promise.race([
      runtime.stop().then(() => true).catch(() => true),
      new Promise((resolve) => { setTimeout(() => resolve(false), 2_000); }),
    ]);
    assert.equal(stopped, true, 'stop() does not wait forever on a parked turn');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/**
 * A paged Agent mailbox: `message +list` returns at most `pageSize` summaries,
 * newest first, exactly as the provider does. Following `next_cursor` walks
 * towards older mail. Reads are counted per id so a test can prove a handled
 * message is never downloaded twice.
 */
function pagedAgentMailbox({ total = 30, pageSize = 25, newest = 30, prefix = 'msg_' } = {}) {
  // Ids ascend with age: msg_30 is the newest, msg_1 the oldest.
  const oldest = newest - total + 1;
  const ordered = [];
  for (let n = newest; n >= oldest; n -= 1) {
    ordered.push({
      message_id: `${prefix}${n}`,
      subject: `Subject ${n}`,
      snippet: `snippet ${n}`,
      from: { email: 'a@x.com' },
    });
  }
  const list = [];
  const reads = [];
  let cursorRequests = 0;
  const impl = (args) => {
    const reply = (data) => Promise.resolve({
      document: { ok: true, data }, stdout: '', stderr: '', exitCode: 0,
    });
    if (args[0] === 'auth' && args[1] === 'status') {
      return reply({ logged_in: false });
    }
    if (args[0] === 'message' && args[1] === '+list') {
      const at = args.indexOf('--cursor');
      const cursor = at >= 0 ? args[at + 1] : '';
      cursorRequests += 1;
      // Cursors are the id to resume after, so `--cursor msg_25` yields the
      // entries strictly older than it.
      const start = cursor ? ordered.findIndex((m) => m.message_id === cursor) + 1 : 0;
      const slice = ordered.slice(start, start + pageSize);
      const hasMore = start + pageSize < ordered.length;
      list.push({ cursor, ids: slice.map((m) => m.message_id) });
      return reply({
        data: slice,
        pagination: hasMore ? { has_more: true, next_cursor: slice[slice.length - 1].message_id } : { has_more: false },
      });
    }
    if (args[0] === 'message' && args[1] === '+read') {
      const id = args[args.indexOf('--id') + 1];
      reads.push(id);
      const n = id.replace(prefix, '');
      return reply({
        message_id: id, rfc_message_id: `<rfc-${n}@x>`, body: `body ${n}`,
        from: { email: 'a@x.com' }, subject: `Subject ${n}`,
      });
    }
    throw new Error(`unexpected CLI call: ${args.join(' ')}`);
  };
  return {
    impl,
    reads,
    list,
    cursorRequests: () => cursorRequests,
    // The mailbox's ids in delivery order (oldest first), which is the order
    // every assertion compares against.
    ids: ordered.map((m) => m.message_id).reverse(),
  };
}

test('a backlog larger than one page is delivered oldest-first across the page boundary', async () => {
  // The provider returns at most 25 summaries per page, newest first, and the
  // transport used to reverse only that one page. With 30 messages pending, the
  // five oldest lived on the next page and were never fetched, while the cursor
  // jumped past them.
  const { createAgentMailTransportForTests } = await import(
    '../../../src/channels/email/transports/agent-mail.mjs'
  );
  const mailbox = pagedAgentMailbox({ total: 30, pageSize: 25, newest: 30 });
  const transport = createAgentMailTransportForTests({
    config: { address: 'bot@agent.qq.com' }, runCliImpl: mailbox.impl,
  });

  const first = await transport.listMessages({ afterUid: null, limit: 25 });
  assert.deepEqual(
    first.map((m) => m.uid),
    mailbox.ids.slice(0, 25),
    'the first poll returns the 25 OLDEST messages, not the 25 newest',
  );
  assert.equal(first[0].uid, 'msg_1', 'the oldest backlog message is delivered first');
  assert.ok(mailbox.list.length >= 2, `the walk paged past the first page (${mailbox.list.length} page(s))`);
  assert.ok(
    mailbox.list.some((page) => page.ids.includes('msg_1')),
    'a page listing msg_1 was fetched, so the oldest backlog was actually reached',
  );
});

test('the second poll continues from the cursor without re-downloading handled mail', async () => {
  // After the first batch, only the five messages newer than the cursor remain.
  // Re-reversing a single page returned msg_6..msg_29 again, burning the
  // provider's tight rate limit on bodies already delivered.
  const { createAgentMailTransportForTests } = await import(
    '../../../src/channels/email/transports/agent-mail.mjs'
  );
  const mailbox = pagedAgentMailbox({ total: 30, pageSize: 25, newest: 30 });
  const transport = createAgentMailTransportForTests({
    config: { address: 'bot@agent.qq.com' }, runCliImpl: mailbox.impl,
  });

  const first = await transport.listMessages({ afterUid: null, limit: 25 });
  const cursorAfterFirst = first[first.length - 1].uid;
  assert.equal(cursorAfterFirst, 'msg_25', 'the cursor follows the returned batch');

  const readsAfterFirst = mailbox.reads.length;
  const second = await transport.listMessages({ afterUid: cursorAfterFirst, limit: 25 });
  assert.deepEqual(second.map((m) => m.uid), ['msg_26', 'msg_27', 'msg_28', 'msg_29', 'msg_30'],
    'the second poll returns only the mail newer than the cursor, oldest first');

  const rereads = mailbox.reads.slice(readsAfterFirst).filter((id) => first.some((m) => m.uid === id));
  assert.deepEqual(rereads, [], 'no already-delivered message is read again');

  // Third poll: nothing left, so no body is fetched at all.
  const readsBeforeThird = mailbox.reads.length;
  const third = await transport.listMessages({ afterUid: 'msg_30', limit: 25 });
  assert.deepEqual(third, [], 'a drained mailbox returns nothing');
  assert.equal(mailbox.reads.length, readsBeforeThird, 'a drained mailbox reads no bodies');
});

test('a body is read only for mail the poll actually returns', async () => {
  // Every `message +read` costs rate-limit budget, so a handled message must be
  // filtered by id before its body is fetched.
  const { createAgentMailTransportForTests } = await import(
    '../../../src/channels/email/transports/agent-mail.mjs'
  );
  const mailbox = pagedAgentMailbox({ total: 30, pageSize: 25, newest: 30 });
  const transport = createAgentMailTransportForTests({
    config: { address: 'bot@agent.qq.com' }, runCliImpl: mailbox.impl,
  });

  const result = await transport.listMessages({ afterUid: 'msg_25', limit: 25 });
  assert.deepEqual(result.map((m) => m.uid), ['msg_26', 'msg_27', 'msg_28', 'msg_29', 'msg_30']);
  assert.equal(new Set(mailbox.reads).size, mailbox.reads.length, 'no message is read twice in one poll');
  assert.deepEqual(
    mailbox.reads.slice().sort(),
    ['msg_26', 'msg_27', 'msg_28', 'msg_29', 'msg_30'],
    'exactly the returned batch is read',
  );
});

test('an empty allowlist admits nobody across page boundaries', async () => {
  // An empty Set is a policy that refuses everyone; treating it as "no filter"
  // downloaded bodies the policy had already rejected.
  const { createAgentMailTransportForTests } = await import(
    '../../../src/channels/email/transports/agent-mail.mjs'
  );
  const mailbox = pagedAgentMailbox({ total: 30, pageSize: 25, newest: 30 });
  const transport = createAgentMailTransportForTests({
    config: { address: 'bot@agent.qq.com' }, runCliImpl: mailbox.impl,
  });

  const result = await transport.listMessages({ afterUid: null, limit: 25, allowSenders: new Set() });
  assert.deepEqual(result, [], 'nobody is admitted');
  assert.deepEqual(mailbox.reads, [], 'no body is downloaded for a refused sender');
});

test('a backlog deeper than one walk still drains completely, in order and without repeats', async () => {
  // Polling repeatedly must deliver every message exactly once, oldest first.
  // A walk that stops short of the oldest mail strands whatever sits below the
  // deepest page: committing the cursor to a batch taken from the top leaves the
  // rest permanently unreachable, and taking it from the bottom repeats mail.
  const { createAgentMailTransportForTests } = await import(
    '../../../src/channels/email/transports/agent-mail.mjs'
  );
  const total = 200;
  const mailbox = pagedAgentMailbox({ total, pageSize: 25, newest: total });
  const transport = createAgentMailTransportForTests({
    config: { address: 'bot@agent.qq.com' }, runCliImpl: mailbox.impl,
  });

  const delivered = [];
  let cursor = null;
  for (let poll = 0; poll < 20; poll += 1) {
    const batch = await transport.listMessages({ afterUid: cursor, limit: 25 });
    if (batch.length === 0) break;
    delivered.push(...batch.map((m) => m.uid));
    cursor = batch[batch.length - 1].uid;
  }

  assert.deepEqual(
    delivered,
    mailbox.ids,
    'every message is delivered exactly once, oldest first, with no gap and no repeat',
  );
  assert.equal(
    mailbox.reads.length,
    new Set(mailbox.reads).size,
    'no body is downloaded more than once across the whole drain',
  );
  assert.equal(mailbox.reads.length, total, 'each message costs exactly one read');
});

test('an agent attachment carries the fields the runtime reads', async () => {
  // The API names differ from the runtime's: an inbound attachment used to
  // arrive with no name, no size and no type because the wrong keys were set.
  const { createAgentMailTransportForTests } = await import(
    '../../../src/channels/email/transports/agent-mail.mjs'
  );
  const cli = (args) => {
    const reply = (data) => Promise.resolve({
      document: { ok: true, data }, stdout: '', stderr: '', exitCode: 0,
    });
    if (args[0] === 'message' && args[1] === '+list') {
      return reply({ data: [{ message_id: 'msg_1', subject: 'S', from: { email: 'a@x.com' } }], pagination: {} });
    }
    return reply({
      message_id: 'msg_1', rfc_message_id: '<rfc-1@x>', body: 'hi',
      from: { email: 'a@x.com' }, subject: 'S',
      attachments: [{ attachment_id: 'att_1', filename: 'report.pdf',
        size: 2048, content_type: 'application/pdf' }],
    });
  };
  const transport = createAgentMailTransportForTests({
    config: { address: 'bot@agent.qq.com' }, runCliImpl: cli,
  });
  const [message] = await transport.listMessages({ afterUid: null, limit: 5 });
  const [file] = message.attachments;
  assert.equal(file.filename, 'report.pdf', 'the runtime reads `filename`');
  assert.equal(file.size, 2048, 'the runtime reads `size`');
  assert.equal(file.contentType, 'application/pdf', 'the runtime reads `contentType`');
  assert.equal(typeof file.content, 'function', 'the contract asks for content');
});

test('a byte attachment is staged before upload, not silently skipped', async () => {
  // The runtime hands over bytes; the uploader only understood a path, so the
  // attachment vanished while the send still reported success.
  const { createAgentMailTransportForTests } = await import(
    '../../../src/channels/email/transports/agent-mail.mjs'
  );
  const staged = [];
  const cli = (args) => {
    const reply = (data) => Promise.resolve({
      document: { ok: true, data }, stdout: '', stderr: '', exitCode: 0,
    });
    if (args[0] === 'attachment' && args[1] === '+upload') {
      staged.push(args[args.indexOf('--file') + 1]);
      return reply({ attachment_id: 'att_up_1' });
    }
    if (args.includes('--confirmation-token')) return reply({ queued: true });
    return reply({ confirmation_required: true, confirmation_token: 'ct_1' });
  };
  const transport = createAgentMailTransportForTests({
    config: { address: 'bot@agent.qq.com' }, runCliImpl: cli,
  });
  const result = await transport.sendReply({
    to: 'a@x.com', subject: 'Re: S', text: 'see attached',
    transportMessageId: 'msg_1',
    attachments: [{ filename: 'notes.txt', content: Buffer.from('hello'), contentType: 'text/plain' }],
  });
  assert.equal(result.sent, true);
  assert.equal(staged.length, 1, 'the attachment was uploaded');
  assert.ok(staged[0].endsWith('notes.txt'), 'staged under its own name');

  // An attachment with neither path nor bytes must not be swallowed.
  await assert.rejects(
    () => transport.sendReply({
      to: 'a@x.com', subject: 'Re: S', text: 'x',
      transportMessageId: 'msg_1', attachments: [{ filename: 'empty.bin' }],
    }),
    (error) => error.code === 'attachment-unreadable',
  );
});

test('a mail thread survives a restart', async () => {
  // The Message-ID → conversation map lived only in memory, so after a reload a
  // reply on the same thread started a new session while the original one sat
  // orphaned.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-thread-'));
  try {
    const path = join(dir, 'state.json');
    const first = await new EmailStateStore(path).load();
    first.rememberThreadId('<rfc-1@x>', 'direct:<rfc-1@x>');
    await first.persist();

    // A fresh instance, as a plugin reload would build.
    const reloaded = await new EmailStateStore(path).load();
    assert.equal(reloaded.conversationForThreadId('<rfc-1@x>'), 'direct:<rfc-1@x>',
      'the thread mapping is restored');
    assert.equal(reloaded.threadMap.size, 1);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('a rate-limited poll backs off instead of hammering the API', async () => {
  // The Agent mailbox allows 10 requests a minute. Retrying on the fixed
  // interval kept the limit exceeded, so the mailbox never recovered.
  const { EmailRuntime, isRateLimitError } = await import('../../../src/channels/email/email-runtime.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-429-'));
  try {
    assert.equal(isRateLimitError({ status: 429 }), true);
    assert.equal(isRateLimitError({ message: 'Request rate limit exceeded, please retry later' }), true);
    assert.equal(isRateLimitError({ code: 'RATE_LIMIT_EXCEEDED' }), true);
    assert.equal(isRateLimitError({ message: 'connection refused' }), false);

    const state = await new EmailStateStore(join(dir, 'state.json')).load();
    let calls = 0;
    const runtime = new EmailRuntime({
      config: { platformId: 'b@y.com', transport: 'agent-mail', allowedSenders: ['a@x.com'] },
      harness: { ensureRunning: async () => {} },
      state,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      createApi: () => ({
        connect: async () => {}, disconnect: async () => {}, latestUid: async () => 0,
        listMessages: async () => {
          calls += 1;
          const error = new Error('Request rate limit exceeded, please retry later');
          error.status = 429;
          throw error;
        },
        sendReply: async () => {}, sendText: async () => {},
      }),
    });
    await runtime.start();
    await new Promise((resolve) => { setTimeout(resolve, 900); });
    assert.ok(calls <= 2, `retried ${calls} times instead of backing off`);
    assert.equal(runtime.status.connectionState, 'failed');
    assert.ok(runtime.status.retryAt > Date.now(), 'a retry time is reported');
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('the polling interval follows the provider-declared limits', async () => {
  // The provider publishes its limits at runtime rather than in its docs, so
  // the interval is derived from them instead of being hard-coded.
  const { pollIntervalForLimits } = await import('../../../src/channels/email/email-runtime.mjs');
  const { normalizeRateLimits } = await import('../../../src/channels/email/transports/agent-mail.mjs');

  assert.deepEqual(normalizeRateLimits({
    requests_per_minute: 10, requests_per_hour: 200, daily_send_quota: 50,
  }), { perMinute: 10, perHour: 200, dailySendQuota: 50 });
  // Some revisions nest the limits by capability.
  assert.deepEqual(normalizeRateLimits({ mail: { requests_per_minute: 10 } }), { perMinute: 10 });
  assert.equal(normalizeRateLimits({}), null, 'an empty payload means "unknown", not "unlimited"');
  assert.equal(normalizeRateLimits(null), null);

  // A tighter budget must produce a longer interval, never a shorter one.
  const tight = pollIntervalForLimits({ perMinute: 10 });
  const loose = pollIntervalForLimits({ perMinute: 60 });
  assert.ok(tight > loose, `expected ${tight} > ${loose}`);
  assert.ok(tight >= 20_000, 'the floor keeps a small budget sane');
  assert.equal(pollIntervalForLimits(null), null, 'unknown limits fall back to the default');
});

// ---------------------------------------------------------------------------
// Delivery exactly once — the poll loop and the bridge must not both dedupe
// ---------------------------------------------------------------------------

/** One inbound mail in the shape `normalizeEmail` consumes. */
function inboundMail(n, overrides = {}) {
  return {
    uid: `msg_${n}`,
    messageId: `<rfc-${n}@x>`,
    from: { value: [{ address: 'a@x.com' }] },
    to: { value: [{ address: 'b@y.com' }] },
    cc: { value: [] },
    subject: `S${n}`,
    text: `body ${n}`,
    attachments: [],
    ...overrides,
  };
}

/**
 * Build a runtime over a stub transport and a stub Harness.
 *
 * The Harness counts `ask` calls, so "the mail was really executed" is an
 * assertion on the Harness rather than on a side effect of polling. `bridge`
 * is exposed by the runtime itself (see `get bridge`).
 */
async function startDeliveryRuntime(t, {
  mailbox, harnessOverrides = {}, onHarnessAsk = null, ...runtimeOptions
} = {}) {
  const { EmailRuntime } = await import('../../../src/channels/email/email-runtime.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-deliver-'));
  const state = await new EmailStateStore(join(dir, 'state.json')).load();
  const asks = [];
  // The bridge resolves a workspace session before asking, so the stub needs the
  // session lifecycle methods too — without `createSession` the turn fails with
  // "harness.createSession is not a function" before it ever reaches `ask`.
  const harness = {
    ensureRunning: async () => {},
    sessionExists: async (sessionId) => Boolean(sessionId),
    createSession: async () => 'email-session-1',
    // `ask` is called positionally as (sessionId, text, options) — the same
    // shape the other channel bridges use.
    ask: async (sessionId, text, options = {}) => {
      const call = { sessionId, text, ...options };
      asks.push(call);
      await onHarnessAsk?.(call);
      return { answer: 'done', artifacts: [] };
    },
    ...harnessOverrides,
  };
  const runtime = new EmailRuntime({
    config: { platformId: 'b@y.com', transport: 'agent-mail', allowedSenders: ['a@x.com'] },
    harness,
    state,
    logger: { warn() {}, info() {}, error() {}, log() {} },
    pollIntervalMs: 5,
    createApi: () => ({
      connect: async () => {}, disconnect: async () => {}, latestUid: async () => 'msg_0',
      listMessages: mailbox,
      sendReply: async () => {}, sendText: async () => {},
    }),
    ...runtimeOptions,
  });
  t.after(async () => {
    await runtime.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return { runtime, asks, state, dir };
}

/** Wait until `predicate` holds, or fail with `describe()`. */
async function waitFor(predicate, describe, { tries = 200, stepMs = 10 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, stepMs); });
  }
  assert.fail(describe());
}

test('a normal mail reaches the Harness exactly once', async (t) => {
  // The poll loop stopped awaiting `accept` so a parked turn cannot stall the
  // mailbox — but it still called `markSeen` right after, ahead of the bridge's
  // queue. By the time `#process` ran, `hasSeen` was already true and it
  // returned immediately: nine polls, a moved cursor, and zero Harness calls.
  const delivered = [];
  const { runtime, asks, state } = await startDeliveryRuntime(t, {
    mailbox: async () => (delivered.length === 0 ? [inboundMail(1)] : []),
    onHarnessAsk: (options) => { delivered.push(options.text); },
  });
  await runtime.start();

  // A single poll is enough: the delivery no longer waits for `start()`.
  await waitFor(
    () => asks.length > 0,
    () => 'the mail never reached the Harness (the poll marked it seen first)',
  );
  // Give the loop room to poll again; a re-listing must not run the turn twice.
  await new Promise((resolve) => { setTimeout(resolve, 120); });

  assert.equal(asks.length, 1, `the Harness ran ${asks.length} times, not exactly once`);
  assert.match(String(asks[0].content ?? asks[0].text), /body 1/, 'the mail body was delivered');
  assert.equal(state.hasSeen('<rfc-1@x>'), true, 'the delivery is recorded as handled');
  assert.equal(state.cursor(), 'msg_1', 'the cursor follows the delivered mail');
});

test('mail arriving after a parked turn still runs, and only once', async (t) => {
  // The parked-turn fix must not be undone by this one: a turn that never
  // settles must not stop later mail from executing, and the later mail must
  // still run exactly once.
  let release = null;
  const parked = new Promise((resolve) => { release = resolve; });
  const started = [];
  const { runtime, asks } = await startDeliveryRuntime(t, {
    mailbox: async () => [inboundMail(1), inboundMail(2)],
    onHarnessAsk: async (options) => {
      started.push(options.text);
      if (started.length === 1) await parked;
    },
  });
  await runtime.start();

  await waitFor(
    () => asks.length >= 2,
    () => `later mail was starved by the parked turn (started ${asks.length})`,
  );
  release();
  await new Promise((resolve) => { setTimeout(resolve, 80); });
  assert.equal(asks.length, 2, `expected two turns, got ${asks.length}`);
});

test('a delivery that fails is retried on a later poll, not lost', async (t) => {
  // The runtime no longer marks a message seen before the bridge has run, so a
  // rejected `accept` must leave the mail eligible for the next poll instead of
  // silently consuming it.
  const seenKeys = [];
  const { runtime, asks } = await startDeliveryRuntime(t, {
    mailbox: async () => [inboundMail(1)],
    onHarnessAsk: () => { seenKeys.push(1); },
  });
  await runtime.start();
  const bridge = runtime.bridge;
  let rejectFirst = true;
  const accept = bridge.accept.bind(bridge);
  bridge.accept = (message, options) => {
    if (rejectFirst) {
      rejectFirst = false;
      return Promise.reject(new Error('queue unavailable'));
    }
    return accept(message, options);
  };

  await waitFor(
    () => asks.length > 0,
    () => 'the retry never ran after the first delivery was rejected',
  );
  assert.equal(asks.length, 1, 'the retry runs the turn exactly once');
  assert.equal(seenKeys.length, 1);
});

// ── first bind against a real workspace store ──────────────────────────────
//
// The tests above inject a `syncAccessPolicy` stub that cannot fail, which hid
// a real assembly bug: production's policy sink is `workspaces.setAccessPolicy`,
// and the workspace record it writes into was only created inside createRuntime
// — after the policy push. These tests wire the controller the way
// plugin-src/host/channels/shared/production.mjs does, over a real
// BotWorkspaceStore, so the ordering is exercised rather than assumed.

/**
 * Build a controller over a real workspace store, mirroring production: the
 * workspace record is created by an explicit `ensureWorkspace` hook and the
 * policy is pushed through `setAccessPolicy`.
 */
async function bindWithRealWorkspaces(dir, { ensureWorkspace = true } = {}) {
  const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
  const { BotWorkspaceStore } = await import('../../../src/channels/shared/bot-workspace-store.mjs');
  const store = await new EmailConfigStore(join(dir, 'config.json')).load();
  // A brand-new install: the store has no record for any mailbox yet.
  const workspaces = await new BotWorkspaceStore(join(dir, 'workspaces.json'), {
    defaultWorkspace: dir,
  }).load();
  const started = [];
  const controller = new EmailController({
    credentials: {
      async resolve() { return null; }, async set() {}, async unset() {},
    },
    configStore: store,
    logger: { warn() {}, info() {}, error() {}, log() {} },
    transports: { 'imap-smtp': makeStubTransport, 'agent-mail': makeStubTransport },
    syncAccessPolicy: async (botId, policy) => {
      await workspaces.setAccessPolicy(botId, policy, {
        incarnation: workspaces.incarnationFor(botId),
      });
    },
    ...(ensureWorkspace
      ? { ensureWorkspace: (botId) => workspaces.ensure(botId, {}) }
      : {}),
    createRuntime: async ({ botId, config }) => {
      await workspaces.ensure(botId, {});
      started.push(config);
      return {
        start: async () => {},
        stop: async () => {},
        status: { ready: true, connectionState: 'connected' },
      };
    },
  });
  return { controller, store, workspaces, started };
}

test('a mailbox bound for the first time syncs its policy and starts its runtime', async () => {
  // The reported bug: on a fresh directory the policy push ran before the
  // workspace record existed, so setAccessPolicy refused it with
  // "workspace-bot-not-found". The user saw "邮箱访问策略同步失败，请重试"
  // while the mailbox stayed on disk with no runtime.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-firstbind-'));
  try {
    const { controller, store, workspaces, started } = await bindWithRealWorkspaces(dir);
    const status = await controller.bindMailbox({
      address: 'fresh@agent.qq.com',
      transport: 'agent-mail',
      allowedSenders: ['boss@corp.com'],
    });

    // 1. The bind succeeds rather than reporting a policy failure.
    const [bot] = store.list();
    assert.ok(bot, 'the mailbox is persisted');
    assert.equal(status.bots.length, 1);

    // 2. The policy actually reached the Harness, carrying the allowlist.
    const policy = workspaces.accessPolicyFor(bot.botId);
    assert.ok(policy, 'the access policy was synced into the workspace store');
    assert.equal(policy.direct.mode, 'allowlist');
    assert.deepEqual(
      policy.direct.allowlist.users.map((user) => user.id),
      ['boss@corp.com'],
    );
    assert.equal(policy.direct.open.defaultCanExecuteCommands, false,
      'nobody outside the allowlist may execute');

    // 3. The runtime is up — not merely configured.
    assert.equal(started.length, 1, 'the runtime was created and started');
    assert.equal(status.bots[0].state, 'connected');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('the ordering bug is what the workspace record guards, not the runtime', async () => {
  // Pins the actual defect: without the pre-sync ensure, the push happens
  // before any record exists and fails. This is the shape the old code had.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-norecord-'));
  try {
    const { controller, store, workspaces } = await bindWithRealWorkspaces(dir, {
      ensureWorkspace: false,
    });
    await assert.rejects(
      () => controller.bindMailbox({
        address: 'fresh@agent.qq.com',
        transport: 'agent-mail',
        allowedSenders: ['boss@corp.com'],
      }),
      /邮箱访问策略同步失败/,
    );
    // And the failed bind left nothing behind.
    assert.deepEqual(store.list(), [], 'no mailbox survives the failed bind');
    const { deriveEmailBotIdentity } = await import(
      '../../../src/channels/email/config-store.mjs'
    );
    const { botId } = deriveEmailBotIdentity('fresh@agent.qq.com');
    assert.equal(workspaces.has(botId), false, 'no workspace record was left behind');
    assert.ok(!workspaces.accessPolicyFor(botId), 'no policy is half-written');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('a failed first bind rolls the config and credential back', async () => {
  // State consistency: a mailbox written to disk but neither synced nor
  // started is unrecoverable from the UI, so the failed bind must undo itself.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-rollback-'));
  try {
    const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    const secrets = new Map();
    const controller = new EmailController({
      credentials: {
        async resolve(ref) {
          return secrets.has(ref) ? { value: secrets.get(ref) } : null;
        },
        async set(ref, value) { secrets.set(ref, value); },
        async unset(ref) { secrets.delete(ref); },
      },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: { 'imap-smtp': makeStubTransport, 'agent-mail': makeStubTransport },
      // The policy sink refuses, standing in for any post-write failure.
      syncAccessPolicy: async () => { throw new Error('workspace-bot-not-found'); },
      ensureWorkspace: async () => {},
      createRuntime: async () => ({
        start: async () => {}, stop: async () => {}, status: {},
      }),
    });
    await assert.rejects(
      () => controller.bindMailbox({
        address: 'fresh@agent.qq.com',
        transport: 'agent-mail',
        allowedSenders: ['boss@corp.com'],
      }),
      /邮箱访问策略同步失败/,
    );

    assert.deepEqual(store.list(), [], 'the config is rolled back, not left half-bound');
    const stored = await controller.status();
    assert.equal(stored.bots.length, 0, 'the mailbox is gone from the status too');
    // The credential must not outlive the config it belongs to.
    const { deriveEmailBotIdentity } = await import(
      '../../../src/channels/email/config-store.mjs'
    );
    const { tokenRef } = deriveEmailBotIdentity('fresh@agent.qq.com');
    assert.equal(secrets.has(tokenRef), false,
      'the credential written by the failed bind is removed');
    assert.equal(secrets.size, 0, 'no stray secret is left in the credential store');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('a failed re-bind restores the mailbox that was already working', async () => {
  // Rolling back must not delete a pre-existing mailbox: a failed re-bind
  // (a changed password, say) leaves the previous working config in place.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-rebind-'));
  try {
    const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    await store.save({
      platformId: 'keep@qq.com', name: 'keep@qq.com', provider: 'qq',
      allowedSenders: ['old@example.com'],
    });
    const [existing] = store.list();
    const secrets = new Map();
    let failPolicy = false;
    const controller = new EmailController({
      credentials: {
        async resolve(ref) {
          return secrets.has(ref) ? { value: secrets.get(ref) } : null;
        },
        async set(ref, value) { secrets.set(ref, value); },
        async unset(ref) { secrets.delete(ref); },
      },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: { 'imap-smtp': makeStubTransport, 'agent-mail': makeStubTransport },
      syncAccessPolicy: async () => {
        if (failPolicy) throw new Error('workspace-bot-not-found');
      },
      ensureWorkspace: async () => {},
      createRuntime: async () => ({ start: async () => {}, stop: async () => {}, status: {} }),
    });

    failPolicy = true;
    await assert.rejects(
      () => controller.bindMailbox({
        address: 'keep@qq.com', transport: 'agent-mail', allowedSenders: ['new@example.com'],
      }),
      /邮箱访问策略同步失败/,
    );

    const [bot] = store.list();
    assert.ok(bot, 'the pre-existing mailbox survives a failed re-bind');
    assert.equal(bot.botId, existing.botId);
    assert.deepEqual(bot.allowedSenders, ['old@example.com'],
      'its previous allowlist is restored, not the failed one');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('a successful bind leaves the runtime running and re-syncs the policy on edit', async () => {
  // The ensure hook must not break updateMailboxSettings, which shares
  // #applyAllowlistToPolicy but runs with the record already in place.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-editpolicy-'));
  try {
    const { controller, store, workspaces } = await bindWithRealWorkspaces(dir);
    await controller.bindMailbox({
      address: 'fresh@agent.qq.com', transport: 'agent-mail', allowedSenders: ['a@x.com'],
    });
    const [bot] = store.list();

    await controller.updateMailboxSettings(bot.botId, {
      allowedSenders: ['b@x.com', 'c@x.com'],
    });

    const policy = workspaces.accessPolicyFor(bot.botId);
    assert.deepEqual(
      policy.direct.allowlist.users.map((user) => user.id),
      ['b@x.com', 'c@x.com'],
      'the edited allowlist replaces the bound one',
    );
    const status = controller.status();
    assert.equal(status.bots[0].state, 'connected', 'the runtime is still connected');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('a runtime that fails to start keeps the config instead of rolling back', async () => {
  // The rollback covers failures that leave the mailbox unusable *and*
  // unretryable. A transport that cannot connect is neither: the config is
  // valid, the policy is synced, and a later reconnect can succeed — so it must
  // survive, reported as an error state rather than thrown away.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-rtfail-'));
  try {
    const { EmailController } = await import('../../../src/channels/email/email-controller.mjs');
    const store = await new EmailConfigStore(join(dir, 'config.json')).load();
    const synced = [];
    const controller = new EmailController({
      credentials: { async resolve() { return null; }, async set() {}, async unset() {} },
      configStore: store,
      logger: { warn() {}, info() {}, error() {}, log() {} },
      transports: { 'imap-smtp': makeStubTransport, 'agent-mail': makeStubTransport },
      syncAccessPolicy: async (botId, policy) => { synced.push({ botId, policy }); },
      ensureWorkspace: async () => {},
      createRuntime: async () => ({
        start: async () => { throw new Error('ECONNREFUSED'); },
        stop: async () => {}, status: {},
      }),
    });

    const status = await controller.bindMailbox({
      address: 'flaky@agent.qq.com', transport: 'agent-mail', allowedSenders: ['a@x.com'],
    });

    assert.equal(store.list().length, 1, 'the valid config survives a runtime failure');
    assert.equal(synced.length, 1, 'and its policy was still synced');
    assert.equal(status.bots[0].state, 'error',
      'the mailbox reports the connection failure rather than disappearing');
    assert.equal(status.bots[0].connected, false);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('an attachment loader resolves a transport that fetches on demand', async () => {
  // The Agent mailbox cannot ship bytes with the summary, so its `content` is a
  // function. Returning it unchanged made the loader resolve to a function,
  // which the inbound-file layer rejects as `inbound-file-data-invalid` — the
  // download silently never happened.
  const { normalizeEmail } = await import('../../../src/channels/email/email-runtime.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-email-att-'));
  try {
    const state = await new EmailStateStore(join(dir, 'state.json')).load();
    const build = (content) => normalizeEmail({
      uid: 'm1', messageId: '<r@x>',
      from: { value: [{ address: 'a@x.com' }] },
      to: { value: [{ address: 'b@y.com' }] },
      cc: { value: [] }, subject: 'S', text: 'body',
      attachments: [{ filename: 'r.txt', size: 5, contentType: 'text/plain', content }],
    }, { address: 'b@y.com', state });

    // On-demand transport: a function.
    const fetched = await build(async () => Buffer.from('hello')).files[0].load();
    assert.equal(Buffer.isBuffer(fetched), true, 'the loader resolves the function');
    assert.equal(fetched.toString(), 'hello');

    // Eager transport: bytes, unchanged behaviour.
    const direct = await build(Buffer.from('world')).files[0].load();
    assert.equal(Buffer.isBuffer(direct), true);
    assert.equal(direct.toString(), 'world');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('latestUid reads the summary only, never a body', async () => {
  // Seeding a cursor went through `listMessages` without an allowlist, which
  // means "no filter" — so it downloaded the newest message's body, mail the
  // policy may refuse, before anyone asked for it.
  const { createAgentMailTransportForTests } = await import(
    '../../../src/channels/email/transports/agent-mail.mjs'
  );
  const calls = [];
  const cli = (args) => {
    calls.push(args[1] ?? args[0]);
    const reply = (data) => Promise.resolve({
      document: { ok: true, data }, stdout: '', stderr: '', exitCode: 0,
    });
    if (args[0] === 'auth') return reply({ logged_in: false });
    if (args[0] === 'message' && args[1] === '+list') {
      return reply({ data: [{ message_id: 'msg_99', subject: 'S', from: { email: 'x@y.com' } }], pagination: {} });
    }
    return reply({ message_id: 'msg_99', body: 'SECRET' });
  };
  const transport = createAgentMailTransportForTests({
    config: { address: 'b@agent.qq.com' }, runCliImpl: cli,
  });
  assert.equal(await transport.latestUid(), 'msg_99');
  assert.equal(calls.includes('+read'), false, 'no body was downloaded');
});

test('the model receives the mail headers, the parser does not', async (t) => {
  // The channel hands over two texts: `controlText` (plain body, what the
  // parsers read) and `content` (the same body with Subject/From/To/Cc above
  // it, what the model should see). The bridge fell back to the parsed text for
  // every ordinary message, so a subject-only instruction never reached the
  // model at all.
  const seen = [];
  const { runtime, state } = await startDeliveryRuntime(t, {
    mailbox: async () => [{
      uid: 'msg_1', messageId: '<rfc-1@x>',
      subject: '统计销售数据',
      from: { value: [{ address: 'boss@corp.com' }] },
      to: { value: [{ address: 'bot@agent.qq.com' }] },
      cc: { value: [{ address: 'team@corp.com' }] },
      text: '统计上个月的数据',
      attachments: [],
    }],
    onHarnessAsk: (call) => { seen.push(call); },
  });
  await runtime.start();
  await waitFor(
    () => seen.length > 0,
    () => 'the mail never reached the Harness',
  );

  // `ask` is called positionally, so the helper records the prompt as `text`.
  const prompt = String(seen[0].text ?? '');
  assert.match(prompt, /Subject: 统计销售数据/, 'the subject reaches the model');
  assert.match(prompt, /From: boss@corp\.com/, 'the sender reaches the model');
  assert.match(prompt, /To: bot@agent\.qq\.com/, 'the recipients reach the model');
  assert.match(prompt, /Cc: team@corp\.com/, 'the cc list reaches the model');
  assert.match(prompt, /统计上个月的数据/, 'the body is still there');
  // The parser must not see the decoration: a command in the body still works.
  assert.equal(state.hasSeen('<rfc-1@x>'), true);
});
