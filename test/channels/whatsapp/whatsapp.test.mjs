import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  mkdtemp,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DisconnectReason } from '@whiskeysockets/baileys';

import {
  OUTBOUND_ARTIFACT_TOOL,
  OutboundArtifactRegistry,
  createOutboundArtifactTool,
} from '../../../src/channels/shared/semantic/artifact.mjs';
import {
  WHATSAPP_ACCESS_MODES,
  WhatsappConfigStore,
  deriveWhatsappBotId,
  normalizeWhatsappAccessPolicy,
} from '../../../src/channels/whatsapp/config-store.mjs';
import { WhatsappController } from '../../../src/channels/whatsapp/whatsapp-controller.mjs';
import { WhatsappHarnessBridge } from '../../../src/channels/whatsapp/whatsapp-bridge.mjs';
import {
  WhatsappBotClient,
  WhatsappRuntime,
  createWhatsappMediaDownloader,
  normalizeWhatsappMessage,
  whatsappAccessPolicyIdsEqual,
  whatsappInboundAllowed,
} from '../../../src/channels/whatsapp/whatsapp-runtime.mjs';
import { createWhatsappWebSession } from '../../../src/channels/whatsapp/whatsapp-web-session.mjs';
import {
  WHATSAPP_ENDPOINTS,
  createWhatsappRpcHandler,
} from '../../../plugin-src/host/channels/whatsapp/rpc.mjs';

const ACCOUNT_JID = '16505550123@s.whatsapp.net';
const AUTH_DIRECTORY = '7fe8c17e-4fb7-4c5b-a9dc-c36525575dd1';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function within(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function eventually(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition was not met before timeout');
}

async function committedArtifact(t, {
  suffix,
  fileName = 'result.txt',
  content = 'WhatsApp result file',
} = {}) {
  const workspace = await mkdtemp(join(tmpdir(), `dsh-im-whatsapp-artifact-${suffix}-`));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const sessionId = `session-whatsapp-artifact-${suffix}`;
  const rpcId = `rpc-whatsapp-artifact-${suffix}`;
  let nextId = 0;
  const ids = [];
  const registry = new OutboundArtifactRegistry({
    uuid: () => {
      const id = `${suffix}-${++nextId}`;
      ids.push(id);
      return id;
    },
  });
  t.after(() => registry.clear());
  const agent = {
    session: {
      header: { id: sessionId, cwd: workspace },
      events: [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { turn: 1, source: { rpcId } } },
      ],
    },
  };
  await writeFile(join(workspace, fileName), content);
  const tool = createOutboundArtifactTool({ registry });
  const exec = {
    name: OUTBOUND_ARTIFACT_TOOL,
    callId: `call-${suffix}`,
    rootCallId: `call-${suffix}`,
    token: Symbol(`call-${suffix}`),
    agent,
  };
  await tool.definition.execute({ path: fileName }, exec);
  tool.onResult(exec, { isError: false });
  return {
    artifact: registry.take(sessionId, 1)[0],
    deliveryKey: ids[1],
  };
}

function artifactState(sessionId = 'session-whatsapp-artifact') {
  const seen = new Set();
  return {
    hasSeen: (messageId) => seen.has(messageId),
    markSeen: async (messageId) => { seen.add(messageId); },
    sessionFor: () => sessionId,
    sessionExists: async () => true,
    setSession: async () => {},
    clearSession: async () => {},
  };
}

function linkedConfig(overrides = {}) {
  return {
    botId: deriveWhatsappBotId(ACCOUNT_JID),
    accountJid: ACCOUNT_JID,
    authDirectory: AUTH_DIRECTORY,
    name: 'Harness WhatsApp',
    accessMode: WHATSAPP_ACCESS_MODES.open,
    allowedNumbers: [],
    createdAt: new Date().toISOString(),
    connectedAt: new Date().toISOString(),
    ...overrides,
  };
}

test('WhatsApp access-policy equality accepts phone and user-JID aliases and rejects invalid ids', () => {
  assert.equal(whatsappAccessPolicyIdsEqual(
    '16505550999', '16505550999@s.whatsapp.net',
  ), true, 'a bare phone number matches its PN JID');
  assert.equal(whatsappAccessPolicyIdsEqual(
    '+16505550999', '16505550999@s.whatsapp.net',
  ), true, 'a +number matches its PN JID');
  assert.equal(whatsappAccessPolicyIdsEqual(
    '16505550999@s.whatsapp.net', '16505550999:4@s.whatsapp.net',
  ), true, 'full and device-qualified PN JIDs retain Baileys alias matching');
  assert.equal(whatsappAccessPolicyIdsEqual(
    '987654321098765@lid', '987654321098765@s.whatsapp.net',
  ), true, 'PN and LID aliases retain Baileys user matching');
  assert.equal(whatsappAccessPolicyIdsEqual(
    '16505550999', '16505550888@s.whatsapp.net',
  ), false);
  for (const invalid of [undefined, null, '', 'not-a-jid', 'bad@', '@lid', '+']) {
    assert.equal(whatsappAccessPolicyIdsEqual(invalid, invalid), false,
      `invalid id must fail closed: ${String(invalid)}`);
    assert.equal(whatsappAccessPolicyIdsEqual(invalid, ACCOUNT_JID), false);
  }
});

test('WhatsApp config stores only linked-device metadata with restrictive permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-im-whatsapp-config-'));
  const path = join(root, 'config.json');
  const store = await new WhatsappConfigStore(path).load();
  await store.save(linkedConfig());
  assert.equal(store.list()[0].accountJid, ACCOUNT_JID);
  assert.equal(store.list()[0].accessMode, WHATSAPP_ACCESS_MODES.open);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(() => store.save(linkedConfig({ botId: 'whatsapp_invalid' })));
});

test('WhatsApp migrates existing bots to self-only mode and validates access policies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-im-whatsapp-access-migration-'));
  const path = join(root, 'config.json');
  const legacy = linkedConfig();
  delete legacy.accessMode;
  delete legacy.allowedNumbers;
  await writeFile(path, `${JSON.stringify({ version: 2, bots: [legacy] })}\n`);
  const store = await new WhatsappConfigStore(path).load();
  assert.deepEqual(store.get(legacy.botId), {
    ...legacy,
    accessMode: WHATSAPP_ACCESS_MODES.selfOnly,
    allowedNumbers: [],
  });
  assert.deepEqual(normalizeWhatsappAccessPolicy({
    accessMode: WHATSAPP_ACCESS_MODES.privateAllowlist,
    allowedNumbers: ['+16505550999', '16505550999'],
  }), {
    accessMode: WHATSAPP_ACCESS_MODES.privateAllowlist,
    allowedNumbers: ['16505550999'],
  });
  assert.throws(() => normalizeWhatsappAccessPolicy({
    accessMode: 'compatible',
    allowedNumbers: [],
  }), /accessMode/);
});

test('WhatsApp Web session reports QR and linked identity without printing either', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-im-whatsapp-session-'));
  const events = new EventEmitter();
  let ended = false;
  const socket = {
    ev: events,
    user: { id: '16505550123:4@s.whatsapp.net', name: 'Harness WhatsApp' },
    end: async () => { ended = true; },
    logout: async () => {},
  };
  const qrValues = [];
  const session = await createWhatsappWebSession({
    authDir: root,
    onQr: (value) => qrValues.push(value),
    makeSocket: () => socket,
    loadAuthState: async () => ({
      state: {
        creds: { me: socket.user },
        keys: { get: async () => ({}), set: async () => {} },
      },
      saveCreds: async () => {},
    }),
  });
  events.emit('connection.update', { qr: 'host-only-qr-value' });
  events.emit('connection.update', { connection: 'open' });
  assert.deepEqual(qrValues, ['host-only-qr-value']);
  assert.deepEqual(await session.ready, {
    accountJid: ACCOUNT_JID,
    name: 'Harness WhatsApp',
  });
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  await session.close();
  assert.equal(ended, true);
});

test('WhatsApp Web session restarts the socket after first-time QR pairing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-im-whatsapp-restart-'));
  const sockets = Array.from({ length: 2 }, (_, index) => ({
    ev: new EventEmitter(),
    user: index === 1
      ? { id: '16505550123:4@s.whatsapp.net', name: 'Harness WhatsApp' }
      : undefined,
    end: async () => {},
    logout: async () => {},
  }));
  let socketIndex = 0;
  let saveCount = 0;
  const authState = {
    creds: {},
    keys: { get: async () => ({}), set: async () => {} },
  };
  const session = await createWhatsappWebSession({
    authDir: root,
    onQr: () => {},
    makeSocket: () => sockets[socketIndex++],
    loadAuthState: async () => ({
      state: authState,
      saveCreds: async () => { saveCount += 1; },
    }),
  });
  authState.creds.me = sockets[1].user;
  sockets[0].ev.emit('creds.update', { me: sockets[1].user });
  sockets[0].ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: DisconnectReason.restartRequired } } },
  });
  for (let index = 0; index < 20 && socketIndex < 2; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(socketIndex, 2);
  assert.equal(saveCount, 1);
  assert.equal(session.socket, sockets[1]);
  sockets[1].ev.emit('connection.update', { connection: 'open' });
  assert.deepEqual(await session.ready, {
    accountJid: ACCOUNT_JID,
    name: 'Harness WhatsApp',
  });
  await session.close();
});

test('WhatsApp Web session accepts recent append events without replaying stale history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-im-whatsapp-append-'));
  const events = new EventEmitter();
  const received = [];
  const contexts = [];
  const socket = {
    ev: events,
    updateMediaMessage: async () => {},
    end: async () => {},
    logout: async () => {},
  };
  const session = await createWhatsappWebSession({
    authDir: root,
    onQr: () => {},
    onMessage: async (message, context) => {
      received.push(message.key.id);
      contexts.push(context);
    },
    makeSocket: () => socket,
    loadAuthState: async () => ({
      state: {
        creds: {},
        keys: { get: async () => ({}), set: async () => {} },
      },
      saveCreds: async () => {},
    }),
  });
  void session.ready.catch(() => undefined);
  events.emit('messages.upsert', {
    type: 'append',
    messages: [
      { key: { id: 'recent' }, messageTimestamp: Math.floor(Date.now() / 1_000) },
      { key: { id: 'stale' }, messageTimestamp: Math.floor(Date.now() / 1_000) - 300 },
    ],
  });
  events.emit('messages.upsert', {
    type: 'notify',
    messages: [{ key: { id: 'notify' } }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, ['recent', 'notify']);
  assert.equal(contexts[0].socket, socket);
  assert.equal(contexts[1].socket, socket);
  await session.close();
});

test('WhatsApp media downloader supplies Baileys reupload context', async () => {
  const reuploaded = [];
  const socket = {
    updateMediaMessage: async (message) => {
      reuploaded.push(message);
      return { ...message, reuploaded: true };
    },
  };
  let receivedContext;
  const download = createWhatsappMediaDownloader({
    socket,
    logger: { info() {} },
    download: async (_message, _type, _options, context) => {
      receivedContext = context;
      return context.reuploadRequest({ key: { id: 'expired-media' } });
    },
  });
  assert.equal((await download({}, 'stream', {})).reuploaded, true);
  assert.equal(typeof receivedContext.logger.info, 'function');
  assert.deepEqual(reuploaded, [{ key: { id: 'expired-media' } }]);
});

test('WhatsApp normalizes direct, linked-account, and explicitly mentioned group messages', () => {
  const directKey = {
    remoteJid: '16505550999@s.whatsapp.net',
    remoteJidAlt: '987654321098765@lid',
    participantAlt: '123456789012345@lid',
    addressingMode: 'lid',
    id: 'direct-1',
    fromMe: false,
  };
  const direct = normalizeWhatsappMessage({
    key: directKey,
    message: { conversation: 'hello' },
  }, ACCOUNT_JID);
  assert.equal(direct.kind, 'direct');
  assert.equal(direct.addressed, true);
  assert.equal(direct.content, 'hello');
  assert.equal(direct.reactionTarget.key, directKey);
  assert.deepEqual(direct.reactionTarget, {
    jid: '16505550999@s.whatsapp.net',
    key: directKey,
  });

  const group = normalizeWhatsappMessage({
    key: {
      remoteJid: '120363000000000000@g.us',
      participant: '16505550999@s.whatsapp.net',
      id: 'group-1',
      fromMe: false,
    },
    message: {
      extendedTextMessage: {
        text: 'question',
        contextInfo: { mentionedJid: [ACCOUNT_JID] },
      },
    },
  }, ACCOUNT_JID);
  assert.equal(group.kind, 'group');
  assert.equal(group.addressed, true);
  assert.equal(normalizeWhatsappMessage({
    key: { remoteJid: 'status@broadcast', id: 'ignored', fromMe: false },
    message: { conversation: 'ignored' },
  }, ACCOUNT_JID), null);

  const selfChat = normalizeWhatsappMessage({
    key: { remoteJid: ACCOUNT_JID, id: 'self-1', fromMe: true },
    message: { conversation: 'message yourself' },
  }, ACCOUNT_JID);
  assert.equal(selfChat.selfChat, true);
  assert.equal(selfChat.addressed, true);

  const linkedAccountGroup = normalizeWhatsappMessage({
    key: {
      remoteJid: '120363000000000001@g.us',
      id: 'owner-group-1',
      fromMe: true,
    },
    message: { conversation: 'message from linked account in a group' },
  }, ACCOUNT_JID);
  assert.equal(linkedAccountGroup.kind, 'group');
  assert.equal(linkedAccountGroup.senderId, ACCOUNT_JID);
  assert.equal(linkedAccountGroup.addressed, true);
  assert.equal(linkedAccountGroup.selfChat, false);

  assert.equal(normalizeWhatsappMessage({
    key: { remoteJid: '16505550999@s.whatsapp.net', id: 'outbound-1', fromMe: true },
    message: { conversation: 'ordinary outbound message' },
  }, ACCOUNT_JID), null);
});

test('WhatsApp maps contextInfo.quotedMessage snapshots without downloading or recursing', () => {
  const replied = normalizeWhatsappMessage({
    key: {
      remoteJid: '120363000000000000@g.us',
      participant: '16505550999@s.whatsapp.net',
      id: 'reply-1',
      fromMe: false,
    },
    message: {
      extendedTextMessage: {
        text: '解释这张图',
        contextInfo: {
          stanzaId: 'quoted-1',
          participant: ACCOUNT_JID,
          quotedMessage: {
            imageMessage: {
              mimetype: 'image/jpeg',
              caption: '第一层原文',
              contextInfo: {
                quotedMessage: { conversation: '不应递归进入 Prompt' },
              },
            },
          },
        },
      },
    },
  }, ACCOUNT_JID, {
    download: async () => { throw new Error('quoted media must not be downloaded'); },
  });
  assert.equal(replied.addressed, true);
  assert.deepEqual(replied.replyTo, {
    messageId: 'quoted-1',
    authorId: ACCOUNT_JID,
    content: '第一层原文',
    attachments: [{ kind: 'image' }],
  });
  assert.doesNotMatch(JSON.stringify(replied.replyTo), /不应递归/);

  const documentReply = normalizeWhatsappMessage({
    key: { remoteJid: '16505550999@s.whatsapp.net', id: 'reply-2', fromMe: false },
    message: {
      extendedTextMessage: {
        text: '总结附件',
        contextInfo: {
          stanzaId: 'quoted-2',
          participant: '16505550000@s.whatsapp.net',
          quotedMessage: {
            documentMessage: {
              mimetype: 'application/pdf',
              fileName: 'brief.pdf',
            },
          },
        },
      },
    },
  }, ACCOUNT_JID);
  assert.deepEqual(documentReply.replyTo.attachments, [{ kind: 'file', name: 'brief.pdf' }]);
});

test('WhatsApp access modes allow self-chat, selected contacts, or the existing open behavior', () => {
  const direct = normalizeWhatsappMessage({
    key: {
      remoteJid: '987654321098765@lid',
      remoteJidAlt: '16505550999@s.whatsapp.net',
      id: 'access-direct',
      fromMe: false,
    },
    message: { conversation: 'hello' },
  }, ACCOUNT_JID);
  const group = normalizeWhatsappMessage({
    key: {
      remoteJid: '120363000000000000@g.us',
      participant: '16505550999@s.whatsapp.net',
      id: 'access-group',
      fromMe: false,
    },
    message: { conversation: 'hello' },
  }, ACCOUNT_JID);
  const selfChat = normalizeWhatsappMessage({
    key: { remoteJid: ACCOUNT_JID, id: 'access-self', fromMe: true },
    message: { conversation: 'hello' },
  }, ACCOUNT_JID);
  const linkedAccountGroup = normalizeWhatsappMessage({
    key: {
      remoteJid: '120363000000000001@g.us',
      id: 'access-owner-group',
      fromMe: true,
    },
    message: { conversation: 'hello from the linked account' },
  }, ACCOUNT_JID);

  assert.equal(whatsappInboundAllowed(selfChat), true);
  assert.equal(whatsappInboundAllowed(direct), false);
  assert.equal(whatsappInboundAllowed(group), false);
  assert.equal(whatsappInboundAllowed(linkedAccountGroup), false);
  assert.equal(whatsappInboundAllowed(direct, {
    accessMode: WHATSAPP_ACCESS_MODES.privateAllowlist,
    allowedNumbers: new Set(['16505550999']),
  }), true);
  assert.equal(whatsappInboundAllowed(direct, {
    accessMode: WHATSAPP_ACCESS_MODES.privateAllowlist,
    allowedNumbers: new Set(['16505550000']),
  }), false);
  assert.equal(whatsappInboundAllowed(group, {
    accessMode: WHATSAPP_ACCESS_MODES.open,
  }), true);
  assert.equal(whatsappInboundAllowed(linkedAccountGroup, {
    accessMode: WHATSAPP_ACCESS_MODES.open,
  }), true);
});

test('WhatsApp keeps native and document images as images and exposes ordinary documents as files', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const calls = [];
  const controller = new AbortController();
  const group = normalizeWhatsappMessage({
    key: {
      remoteJid: '120363000000000000@g.us',
      participant: '16505550999@s.whatsapp.net',
      id: 'group-image-1',
      fromMe: false,
    },
    message: {
      imageMessage: {
        mimetype: 'image/png',
        caption: '看看这张图',
        fileLength: { toString: () => String(png.length) },
        url: 'https://mmg.whatsapp.net/image',
        contextInfo: { mentionedJid: [ACCOUNT_JID] },
      },
    },
  }, ACCOUNT_JID, {
    download: async (raw, type, options) => {
      calls.push({ raw, type, options });
      return {
        async *[Symbol.asyncIterator]() { yield png; },
      };
    },
  });
  assert.equal(group.addressed, true);
  assert.equal(group.content, '看看这张图');
  assert.equal(group.images.length, 1);
  assert.equal(group.images[0].size, png.length);
  assert.deepEqual(await group.images[0].load({ signal: controller.signal, maxBytes: 100 }), png);
  assert.equal(calls[0].type, 'stream');
  assert.equal(calls[0].options.options.signal instanceof AbortSignal, true);

  const downloadStarted = Promise.withResolvers();
  const lateStream = Promise.withResolvers();
  let lateStreamDestroyed = false;
  const cancelled = normalizeWhatsappMessage({
    key: { remoteJid: '16505550999@s.whatsapp.net', id: 'cancelled-1', fromMe: false },
    message: {
      imageMessage: { mimetype: 'image/png', url: 'https://mmg.whatsapp.net/cancelled' },
    },
  }, ACCOUNT_JID, {
    download: async () => {
      downloadStarted.resolve();
      return lateStream.promise;
    },
  });
  const cancelledController = new AbortController();
  const cancelledLoad = cancelled.images[0].load({
    signal: cancelledController.signal,
    maxBytes: 100,
  });
  await downloadStarted.promise;
  cancelledController.abort(new DOMException('Stopped', 'AbortError'));
  await assert.rejects(cancelledLoad, { name: 'AbortError' });
  lateStream.resolve({ destroy() { lateStreamDestroyed = true; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateStreamDestroyed, true);

  const document = normalizeWhatsappMessage({
    key: { remoteJid: '16505550999@s.whatsapp.net', id: 'document-image-1', fromMe: false },
    message: {
      documentMessage: {
        mimetype: 'image/webp', fileName: 'diagram.webp', fileLength: 2_000,
        url: 'https://mmg.whatsapp.net/document',
      },
    },
  }, ACCOUNT_JID, {
    download: async (raw, type, options) => {
      calls.push({ raw, type, options });
      return {
        async *[Symbol.asyncIterator]() { yield Buffer.from('document'); },
      };
    },
  });
  assert.equal(document.images[0].name, 'diagram.webp');
  assert.equal(document.images[0].mediaType, 'image/webp');
  assert.equal(document.images[0].size, 2_000);
  assert.deepEqual(document.files, []);
  const documentController = new AbortController();
  assert.equal((await document.images[0].load({
    signal: documentController.signal,
    maxBytes: 5_000,
  })).toString(), 'document');
  assert.equal(calls[1].type, 'stream');
  assert.equal(calls[1].options.options.signal instanceof AbortSignal, true);

  const ordinaryDocument = normalizeWhatsappMessage({
    key: { remoteJid: '16505550999@s.whatsapp.net', id: 'document-pdf-1', fromMe: false },
    message: {
      documentMessage: {
        mimetype: 'application/pdf', fileName: 'report.pdf', fileLength: 4_000,
        url: 'https://mmg.whatsapp.net/document-pdf',
      },
    },
  }, ACCOUNT_JID, {
    download: async (raw, type, options) => {
      calls.push({ raw, type, options });
      return {
        async *[Symbol.asyncIterator]() { yield Buffer.from('pdf'); },
      };
    },
  });
  assert.deepEqual(ordinaryDocument.images, []);
  assert.equal(ordinaryDocument.files[0].name, 'report.pdf');
  assert.equal(ordinaryDocument.files[0].mediaType, 'application/pdf');
  assert.equal(ordinaryDocument.files[0].size, 4_000);
  const loadedDocument = await ordinaryDocument.files[0].load({ signal: documentController.signal });
  const documentChunks = [];
  for await (const chunk of loadedDocument.stream) documentChunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(documentChunks).toString(), 'pdf');
  assert.equal(calls[2].type, 'stream');
  assert.equal(calls[2].options.options.signal, documentController.signal);

  for (const [index, wrapper] of [
    'viewOnceMessage',
    'viewOnceMessageV2',
    'viewOnceMessageV2Extension',
  ].entries()) {
    const wrappedMessage = {
      [wrapper]: {
        message: {
          imageMessage: {
            mimetype: 'image/jpeg', url: `https://mmg.whatsapp.net/view-once-${index}`,
          },
        },
      },
    };
    const viewOnce = normalizeWhatsappMessage({
      key: {
        remoteJid: '16505550999@s.whatsapp.net',
        id: `view-once-${index}`,
        fromMe: false,
      },
      message: index === 1
        ? { ephemeralMessage: { message: wrappedMessage } }
        : wrappedMessage,
    }, ACCOUNT_JID);
    assert.deepEqual(viewOnce.images, []);
  }

  const oversized = normalizeWhatsappMessage({
    key: { remoteJid: '16505550999@s.whatsapp.net', id: 'oversized-1', fromMe: false },
    message: {
      imageMessage: { mimetype: 'image/jpeg', url: 'https://mmg.whatsapp.net/oversized' },
    },
  }, ACCOUNT_JID, {
    download: async () => ({
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(4);
        yield Buffer.alloc(4);
      },
      destroy() {},
    }),
  });
  await assert.rejects(() => oversized.images[0].load({ maxBytes: 5 }), (error) => {
    assert.equal(error.code, 'image-too-large');
    return true;
  });
});

test('WhatsApp runtime uses live unified policy settings and existing JID alias matching', async () => {
  let callbacks;
  let accessSettings = {
    direct: {
      mode: 'allowlist',
      open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
      allowlist: { users: [] },
    },
    group: {
      mode: 'allowlist',
      open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
      allowlist: { users: [] },
    },
  };
  const calls = [];
  const socket = {
    sendPresenceUpdate: async (...args) => calls.push(['presence', ...args]),
    readMessages: async () => {},
    sendMessage: async (jid, content) => {
      calls.push(['message', jid, content]);
      return { key: { id: 'reply-1' } };
    },
  };
  const state = {
    hasSeen: () => false,
    markSeen: async () => {},
    sessionFor: () => 'session-1',
    sessionExists: async () => true,
  };
  const harness = {
    ensureRunning: async () => {},
    sessionExists: async () => true,
    ask: async () => 'Harness answer',
  };
  const runtime = new WhatsappRuntime({
    config: linkedConfig({ accessMode: WHATSAPP_ACCESS_MODES.selfOnly }),
    authDir: '/tmp/test-whatsapp-auth',
    harness,
    state,
    accessPolicy: {
      getSettings: () => accessSettings,
      isPrivileged: (senderIds) => senderIds.includes(ACCOUNT_JID),
    },
    createSession: async (options) => {
      callbacks = options;
      return {
        socket,
        ready: Promise.resolve({ accountJid: ACCOUNT_JID, name: 'Harness WhatsApp' }),
        close: async () => {},
        logout: async () => {},
      };
    },
  });
  await runtime.start();
  await callbacks.onMessage({
    key: { remoteJid: '16505550999@s.whatsapp.net', id: 'direct-2', fromMe: false },
    message: { conversation: 'hello' },
  });
  assert.equal(runtime.status.ready, true);
  assert.equal(runtime.status.messagesRejected, 1);
  assert.equal(calls.length, 0);
  await callbacks.onMessage({
    key: { remoteJid: ACCOUNT_JID, id: 'owner-1', fromMe: true },
    message: { conversation: 'owner bypass' },
  });
  assert.ok(calls.some((call) => call[0] === 'message'
    && call[2].text === 'Harness answer'), 'linked owner bypasses an empty allowlist');
  accessSettings = {
    ...accessSettings,
    direct: {
      mode: 'allowlist',
      open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
      allowlist: {
        users: [{ id: '16505550999', canExecuteCommands: true }],
      },
    },
  };
  const answerCountBeforeAlternate = calls.filter((call) => (
    call[0] === 'message' && call[2].text === 'Harness answer'
  )).length;
  await callbacks.onMessage({
    key: {
      remoteJid: '987654321098765@lid',
      remoteJidAlt: '16505550999@s.whatsapp.net',
      id: 'direct-3',
      fromMe: false,
    },
    message: { conversation: 'hello again' },
  });
  assert.equal(calls.filter((call) => (
    call[0] === 'message' && call[2].text === 'Harness answer'
  )).length, answerCountBeforeAlternate + 1,
  'a bare allowlist number matches the PN alternate for an inbound LID');
  await runtime.stop();
});

test('WhatsApp open mode answers linked-account group messages without processing reply echoes', async (t) => {
  const groupJid = '120363000000000001@g.us';
  let callbacks;
  let replyEchoTask;
  let askCount = 0;
  const sent = [];
  const socket = {
    sendPresenceUpdate: async () => {},
    readMessages: async () => {},
    sendMessage: async (jid, content, options = {}) => {
      sent.push({ jid, content, options });
      if (typeof content.text === 'string') {
        replyEchoTask = callbacks.onMessage({
          key: { remoteJid: groupJid, id: options.messageId, fromMe: true },
          message: { conversation: content.text },
        });
      }
      return { key: { id: options.messageId } };
    },
  };
  const runtime = new WhatsappRuntime({
    config: linkedConfig({ accessMode: WHATSAPP_ACCESS_MODES.open }),
    authDir: '/tmp/test-whatsapp-linked-account-group',
    harness: {
      ensureRunning: async () => {},
      sessionExists: async () => true,
      ask: async () => {
        askCount += 1;
        return 'Harness group answer';
      },
    },
    state: artifactState('session-linked-account-group'),
    createSession: async (options) => {
      callbacks = options;
      return {
        socket,
        ready: Promise.resolve({ accountJid: ACCOUNT_JID, name: 'Harness WhatsApp' }),
        close: async () => {},
        logout: async () => {},
      };
    },
  });
  t.after(() => runtime.stop());
  await runtime.start();

  const inbound = {
    key: { remoteJid: groupJid, id: 'linked-account-group-1', fromMe: true },
    message: { conversation: 'hello from my group' },
  };
  await callbacks.onMessage(inbound);
  await replyEchoTask;
  await eventually(() => sent.filter(({ content }) => content.react).length === 2);

  assert.equal(askCount, 1);
  const textSends = sent.filter(({ content }) => typeof content.text === 'string');
  assert.equal(textSends.length, 2);
  assert.equal(textSends[0].jid, groupJid);
  assert.equal(textSends[0].content.text, '正在处理…');
  assert.equal(textSends[0].options.quoted, inbound);
  assert.match(textSends[0].options.messageId, /^[0-9A-F]{20}$/);
  assert.equal(textSends[1].jid, groupJid);
  assert.equal(textSends[1].content.text, 'Harness group answer');
  assert.deepEqual(textSends[1].content.edit, {
    remoteJid: groupJid, fromMe: true, id: textSends[0].options.messageId,
  });
  assert.equal(textSends[1].options.quoted, undefined);
  const reactionSends = sent.filter(({ content }) => content.react);
  assert.deepEqual(reactionSends.map(({ content }) => content.react.text), ['👀', '']);
  assert.equal(reactionSends.every(({ jid }) => jid === groupJid), true);
  assert.equal(reactionSends.every(({ content }) => content.react.key === inbound.key), true);
});

test('WhatsApp runtime sends result files with native metadata, quote, stable id, and upload timeout', async (t) => {
  const { artifact, deliveryKey } = await committedArtifact(t, {
    suffix: 'native-file',
    fileName: 'report.txt',
    content: 'native WhatsApp artifact',
  });
  let callbacks;
  const calls = [];
  const socket = {
    sendPresenceUpdate: async () => {},
    readMessages: async () => {},
    sendMessage: async (jid, content, options) => {
      calls.push({ jid, content, options });
      return { key: { id: content.document ? 'file-message-1' : 'text-message-1' } };
    },
  };
  const runtime = new WhatsappRuntime({
    config: linkedConfig(),
    authDir: '/tmp/test-whatsapp-native-file',
    harness: {
      ensureRunning: async () => {},
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        assert.equal(typeof options.onArtifact, 'function');
        await options.onArtifact(artifact);
        return '结果文件如下。';
      },
    },
    state: artifactState(),
    createSession: async (options) => {
      callbacks = options;
      return {
        socket,
        ready: Promise.resolve({ accountJid: ACCOUNT_JID, name: 'Harness WhatsApp' }),
        close: async () => {},
        logout: async () => {},
      };
    },
  });
  t.after(() => runtime.stop());
  await runtime.start();
  const inbound = {
    key: { remoteJid: '16505550999@s.whatsapp.net', id: 'native-file-1', fromMe: false },
    message: { conversation: '生成结果文件' },
  };

  await callbacks.onMessage(inbound);

  const textCall = calls.find((call) => call.content.text === '结果文件如下。');
  const fileCall = calls.find((call) => call.content.document);
  assert.ok(textCall);
  assert.ok(fileCall);
  assert.equal(fileCall.jid, '16505550999@s.whatsapp.net');
  assert.equal(fileCall.content.document.toString(), 'native WhatsApp artifact');
  assert.equal(fileCall.content.mimetype, 'text/plain');
  assert.equal(fileCall.content.fileName, 'report.txt');
  assert.equal(fileCall.options.quoted, inbound);
  assert.equal(fileCall.options.mediaUploadTimeoutMs, 120_000);
  assert.equal(
    fileCall.options.messageId,
    createHash('sha256').update(deliveryKey).digest('hex').slice(0, 20).toUpperCase(),
  );
  assert.equal(fileCall.options.messageId.length, 20);
  assert.equal(calls.indexOf(textCall) < calls.indexOf(fileCall), true);
});

test('WhatsApp bot client sends native images with stable id and early echo suppression', async () => {
  const remembered = [];
  const calls = [];
  const outboundIds = {
    remember: (id) => remembered.push(id),
  };
  const quoted = { key: { id: 'quoted-image-message' } };
  const deliveryKey = 'whatsapp-native-image-delivery';
  const expectedMessageId = createHash('sha256')
    .update(`${deliveryKey}:image`)
    .digest('hex')
    .slice(0, 20)
    .toUpperCase();
  const socket = {
    sendPresenceUpdate: async () => {},
    sendMessage: async (jid, content, options) => {
      assert.equal(remembered.includes(options.messageId), true);
      calls.push({ jid, content, options });
      return { key: { id: 'provider-image-message' } };
    },
  };
  const client = new WhatsappBotClient(socket, outboundIds);
  const bytes = Buffer.from('whatsapp-image');

  assert.deepEqual(await client.sendImage({
    jid: '16505550999@s.whatsapp.net',
    quoted,
  }, {
    deliveryKey,
    fileName: 'result.png',
    mediaType: 'image/png',
    bytes,
  }), { key: { id: 'provider-image-message' } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].jid, '16505550999@s.whatsapp.net');
  assert.equal(calls[0].content.image, bytes);
  assert.equal(calls[0].content.mimetype, 'image/png');
  assert.equal(calls[0].content.document, undefined);
  assert.equal(calls[0].options.quoted, quoted);
  assert.equal(calls[0].options.messageId, expectedMessageId);
  assert.equal(calls[0].options.mediaUploadTimeoutMs, 120_000);
  assert.deepEqual(remembered, [expectedMessageId, 'provider-image-message']);
});

test('WhatsApp bot client adds and clears a reaction against the full source key', async () => {
  const calls = [];
  const reserved = [];
  const remembered = [];
  const sourceKey = {
    remoteJid: '120363000000000000@g.us',
    participant: '16505550999@s.whatsapp.net',
    participantAlt: '987654321098765@lid',
    addressingMode: 'lid',
    id: 'reaction-source-1',
    fromMe: false,
  };
  const socket = {
    sendMessage: async (jid, content, options) => {
      calls.push({ jid, content, options });
      return { key: { id: `reaction-result-${calls.length}` } };
    },
  };
  const client = new WhatsappBotClient(socket, {
    reserve: (id) => reserved.push(id),
    remember: (id) => remembered.push(id),
  });
  const target = { jid: sourceKey.remoteJid, key: sourceKey };

  const reactionKey = await client.addReaction(target, '👀');
  await client.removeReaction(target, reactionKey);

  assert.equal(reactionKey, '👀');
  assert.deepEqual(calls.map(({ jid, content }) => ({ jid, content })), [{
    jid: sourceKey.remoteJid,
    content: { react: { text: '👀', key: sourceKey } },
  }, {
    jid: sourceKey.remoteJid,
    content: { react: { text: '', key: sourceKey } },
  }]);
  assert.equal(calls.every(({ content }) => content.react.key === sourceKey), true);
  assert.equal(calls.every(({ options }) => /^[0-9A-F]{20}$/.test(options.messageId)), true);
  assert.notEqual(calls[0].options.messageId, calls[1].options.messageId);
  assert.deepEqual(reserved, calls.map(({ options }) => options.messageId));
  assert.deepEqual(remembered, ['reaction-result-1', 'reaction-result-2']);
});

test('WhatsApp reaction operations obey an upper-layer hard timeout', async () => {
  const socket = {
    sendMessage: async () => new Promise(() => {}),
  };
  const client = new WhatsappBotClient(socket, {
    reserve() {},
    remember() {},
  });

  await assert.rejects(() => client.addReaction({
    jid: '16505550999@s.whatsapp.net',
    key: {
      remoteJid: '16505550999@s.whatsapp.net',
      id: 'reaction-timeout-source',
      fromMe: false,
    },
  }, '👀', { signal: AbortSignal.timeout(10) }), (error) => error.name === 'TimeoutError');
});

test('WhatsApp classifies a definite image rejection and uses a distinct fallback file id', async () => {
  const calls = [];
  const deliveryKey = 'whatsapp-image-fallback-delivery';
  const socket = {
    sendPresenceUpdate: async () => {},
    sendMessage: async (_jid, content, options) => {
      calls.push({ content, options });
      if (content.image) {
        const error = new Error('unsupported image');
        error.output = { statusCode: 415 };
        throw error;
      }
      return { key: { id: 'provider-file-fallback' } };
    },
  };
  const client = new WhatsappBotClient(socket, { remember() {} });
  const file = {
    artifactId: 'whatsapp-image-fallback',
    deliveryKey,
    fileName: 'result.png',
    mediaType: 'image/png',
    bytes: Buffer.from('whatsapp-image'),
  };

  await assert.rejects(
    () => client.sendImage({ jid: '16505550999@s.whatsapp.net' }, file),
    (error) => error.code === 'artifact-provider-rejected',
  );
  assert.deepEqual(
    await client.sendFile({ jid: '16505550999@s.whatsapp.net' }, file),
    { key: { id: 'provider-file-fallback' } },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.messageId, createHash('sha256')
    .update(`${deliveryKey}:image`).digest('hex').slice(0, 20).toUpperCase());
  assert.equal(calls[1].options.messageId, createHash('sha256')
    .update(deliveryKey).digest('hex').slice(0, 20).toUpperCase());
  assert.notEqual(calls[0].options.messageId, calls[1].options.messageId);
});

test('WhatsApp native image timeout remains an uncertain artifact delivery', async () => {
  const socket = {
    sendPresenceUpdate: async () => {},
    sendMessage: async () => new Promise(() => {}),
  };
  const client = new WhatsappBotClient(socket, { remember() {} }, {
    mediaUploadTimeoutMs: 10,
  });

  await assert.rejects(() => client.sendImage({
    jid: '16505550999@s.whatsapp.net',
  }, {
    artifactId: 'whatsapp-image-timeout',
    fileName: 'result.png',
    mediaType: 'image/png',
    bytes: Buffer.from('whatsapp-image'),
  }), (error) => error.code === 'artifact-delivery-uncertain'
    && error.cause?.name === 'TimeoutError');
});

test('WhatsApp bridge routes outbound image artifacts natively with safe file fallback', async (t) => {
  const scenarios = [{
    name: 'native image',
    suffix: 'native-image-route',
    fileName: 'result.png',
    content: Buffer.from([1, 2, 3]),
    expectedCalls: ['image:result.png:image/png'],
    expectedOutcome: 'sent',
  }, {
    name: 'ordinary file',
    suffix: 'ordinary-file-route',
    fileName: 'result.txt',
    content: 'ordinary file',
    expectedCalls: ['file:result.txt:text/plain'],
    expectedOutcome: 'sent',
  }, {
    name: 'definitive image rejection',
    suffix: 'image-fallback-route',
    fileName: 'result.webp',
    content: Buffer.from([4, 5, 6]),
    imageErrorCode: 'artifact-provider-rejected',
    expectedCalls: ['image:result.webp:image/webp', 'file:result.webp:image/webp'],
    expectedOutcome: 'sent',
  }, {
    name: 'uncertain image result',
    suffix: 'image-uncertain-route',
    fileName: 'result.gif',
    content: Buffer.from([7, 8, 9]),
    imageErrorCode: 'artifact-delivery-uncertain',
    expectedCalls: ['image:result.gif:image/gif'],
    expectedOutcome: 'unknown',
  }];

  for (const scenario of scenarios) {
    const { artifact } = await committedArtifact(t, scenario);
    const calls = [];
    const bot = {
      sendText: async () => ({ key: { id: `text-${scenario.suffix}` } }),
      sendImage: async (_target, file) => {
        calls.push(`image:${file.fileName}:${file.mediaType}`);
        if (scenario.imageErrorCode) {
          const error = new Error(scenario.imageErrorCode);
          error.code = scenario.imageErrorCode;
          throw error;
        }
        return { key: { id: `image-${scenario.suffix}` } };
      },
      sendFile: async (_target, file) => {
        calls.push(`file:${file.fileName}:${file.mediaType}`);
        return { key: { id: `file-${scenario.suffix}` } };
      },
    };
    const bridge = new WhatsappHarnessBridge({
      bot,
      state: artifactState(`session-${scenario.suffix}`),
      logger: { warn() {}, error() {} },
      harness: {
        sessionExists: async () => true,
        ask: async (_sessionId, _text, options) => {
          await options.onArtifact(artifact);
          return '图片已生成。';
        },
      },
    });

    const receipt = await bridge.accept({
      messageId: `whatsapp:artifact-${scenario.suffix}`,
      senderId: '16505550999@s.whatsapp.net',
      kind: 'direct',
      conversationId: `whatsapp-artifact-${scenario.suffix}`,
      content: '生成结果',
      addressed: true,
      replyTarget: { jid: '16505550999@s.whatsapp.net' },
    });

    assert.deepEqual(calls, scenario.expectedCalls, scenario.name);
    assert.equal(receipt.artifacts[0].outcome, scenario.expectedOutcome, scenario.name);
  }
});

test('WhatsApp suppresses a self-chat file echo that arrives before the provider ACK', async (t) => {
  const { artifact } = await committedArtifact(t, {
    suffix: 'early-self-file-echo',
    fileName: 'self-report.txt',
    content: 'self chat artifact',
  });
  let callbacks;
  let echoTask;
  let askCount = 0;
  const sent = [];
  const socket = {
    sendPresenceUpdate: async () => {},
    readMessages: async () => {},
    sendMessage: async (jid, content, options = {}) => {
      sent.push({ jid, content, options });
      if (content.document) {
        echoTask = callbacks.onMessage({
          key: { remoteJid: ACCOUNT_JID, id: options.messageId, fromMe: true },
          message: {
            documentMessage: {
              fileName: content.fileName,
              mimetype: content.mimetype,
            },
          },
        });
        return { key: { id: options.messageId } };
      }
      return { key: { id: `text-${sent.length}` } };
    },
  };
  const runtime = new WhatsappRuntime({
    config: linkedConfig(),
    authDir: '/tmp/test-whatsapp-early-self-file-echo',
    harness: {
      ensureRunning: async () => {},
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        askCount += 1;
        await options.onArtifact(artifact);
        return '结果文件如下。';
      },
    },
    state: artifactState('session-whatsapp-early-self-file-echo'),
    createSession: async (options) => {
      callbacks = options;
      return {
        socket,
        ready: Promise.resolve({ accountJid: ACCOUNT_JID, name: 'Harness WhatsApp' }),
        close: async () => {},
        logout: async () => {},
      };
    },
  });
  t.after(() => runtime.stop());
  await runtime.start();

  await callbacks.onMessage({
    key: { remoteJid: ACCOUNT_JID, id: 'self-file-request-1', fromMe: true },
    message: { conversation: '生成结果文件' },
  });
  await echoTask;

  assert.equal(askCount, 1);
  assert.equal(sent.filter(({ content }) => content.document).length, 1);
  assert.equal(sent.some(({ content }) => content.text === '目前支持文字和图片消息。'), false);
});

test('WhatsApp runtime treats a lost file-send response as uncertain delivery', async (t) => {
  const { artifact } = await committedArtifact(t, {
    suffix: 'uncertain-file',
    fileName: 'uncertain.txt',
  });
  let callbacks;
  const warnings = [];
  const sent = [];
  const socket = {
    sendPresenceUpdate: async () => {},
    readMessages: async () => {},
    sendMessage: async (_jid, content) => {
      sent.push(content);
      if (content.document) return new Promise(() => {});
      return { key: { id: `text-${sent.length}` } };
    },
  };
  const runtime = new WhatsappRuntime({
    config: linkedConfig(),
    authDir: '/tmp/test-whatsapp-uncertain-file',
    harness: {
      ensureRunning: async () => {},
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '已生成文件。';
      },
    },
    state: artifactState('session-whatsapp-uncertain'),
    logger: {
      warn: (...args) => warnings.push(args.join(' ')),
      error() {},
    },
    mediaUploadTimeoutMs: 20,
    createSession: async (options) => {
      callbacks = options;
      return {
        socket,
        ready: Promise.resolve({ accountJid: ACCOUNT_JID, name: 'Harness WhatsApp' }),
        close: async () => {},
        logout: async () => {},
      };
    },
  });
  t.after(() => runtime.stop());
  await runtime.start();

  await callbacks.onMessage({
    key: { remoteJid: '16505550999@s.whatsapp.net', id: 'uncertain-file-1', fromMe: false },
    message: { conversation: '生成文件' },
  });

  assert.equal(sent.filter((content) => content.document).length, 1);
  assert.equal(warnings.some((warning) => warning.includes('artifact-delivery-uncertain')), true);
  assert.equal(sent.some((content) => content.text?.includes('发送结果未能确认')), true);
});

test('stopping WhatsApp aborts a pending upload without another file or failure notice', async (t) => {
  const first = await committedArtifact(t, {
    suffix: 'cancel-first',
    fileName: 'first.txt',
  });
  const second = await committedArtifact(t, {
    suffix: 'cancel-second',
    fileName: 'second.txt',
  });
  let callbacks;
  const uploadStarted = deferred();
  const uploadResponse = deferred();
  const sent = [];
  const socket = {
    sendPresenceUpdate: async () => {},
    readMessages: async () => {},
    sendMessage: async (_jid, content) => {
      sent.push(content);
      if (content.document) {
        uploadStarted.resolve();
        return uploadResponse.promise;
      }
      return { key: { id: `text-${sent.length}` } };
    },
  };
  const runtime = new WhatsappRuntime({
    config: linkedConfig(),
    authDir: '/tmp/test-whatsapp-cancel-upload',
    harness: {
      ensureRunning: async () => {},
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(first.artifact);
        await options.onArtifact(second.artifact);
        return '结果文件如下。';
      },
    },
    state: artifactState('session-whatsapp-cancel'),
    logger: { warn() {}, error() {} },
    createSession: async (options) => {
      callbacks = options;
      return {
        socket,
        ready: Promise.resolve({ accountJid: ACCOUNT_JID, name: 'Harness WhatsApp' }),
        close: async () => {},
        logout: async () => {},
      };
    },
  });
  await runtime.start();
  const processing = callbacks.onMessage({
    key: { remoteJid: '16505550999@s.whatsapp.net', id: 'cancel-upload-1', fromMe: false },
    message: { conversation: '生成两个文件' },
  });
  await uploadStarted.promise;

  await within(runtime.stop(), 500, 'WhatsApp runtime did not stop a pending upload promptly');
  await within(processing, 500, 'WhatsApp message processing remained blocked after stop');
  uploadResponse.resolve({ key: { id: 'late-provider-response' } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    sent.filter((content) => content.document).map((content) => content.fileName),
    ['first.txt'],
  );
  assert.equal(sent.some((content) => content.text?.includes('暂时未能发送')), false);
  assert.equal(sent.some((content) => content.text === '消息处理失败，请稍后重试。'), false);
});

test('WhatsApp runtime answers self-chat without processing its own reply echo', async () => {
  let callbacks;
  let askCount = 0;
  const sent = [];
  const socket = {
    sendPresenceUpdate: async () => {},
    readMessages: async () => { throw new Error('self-chat must not send a read receipt'); },
    sendMessage: async (jid, content) => {
      sent.push([jid, content]);
      return { key: { id: 'bot-reply-1' } };
    },
  };
  const runtime = new WhatsappRuntime({
    config: linkedConfig(),
    authDir: '/tmp/test-whatsapp-self-chat',
    harness: {
      ensureRunning: async () => {},
      sessionExists: async () => true,
      ask: async () => { askCount += 1; return 'Harness self-chat answer'; },
    },
    state: {
      hasSeen: () => false,
      markSeen: async () => {},
      sessionFor: () => 'session-self',
      sessionExists: async () => true,
    },
    createSession: async (options) => {
      callbacks = options;
      return {
        socket,
        ready: Promise.resolve({ accountJid: ACCOUNT_JID, name: 'Harness WhatsApp' }),
        close: async () => {},
        logout: async () => {},
      };
    },
  });
  await runtime.start();
  const inbound = {
    key: { remoteJid: ACCOUNT_JID, id: 'owner-message-1', fromMe: true },
    message: { conversation: 'hello from message yourself' },
  };
  await callbacks.onMessage(inbound);
  await callbacks.onMessage({
    key: { remoteJid: ACCOUNT_JID, id: 'bot-reply-1', fromMe: true },
    message: { conversation: 'Harness self-chat answer' },
  });
  await eventually(() => sent.filter(([, content]) => content.react).length === 2);
  assert.equal(askCount, 1);
  assert.deepEqual(
    sent.filter(([, content]) => typeof content.text === 'string'),
    [
      [ACCOUNT_JID, { text: '正在处理…' }],
      [ACCOUNT_JID, {
        text: 'Harness self-chat answer',
        edit: { remoteJid: ACCOUNT_JID, fromMe: true, id: 'bot-reply-1' },
      }],
    ],
  );
  const reactionSends = sent.filter(([, content]) => content.react);
  assert.deepEqual(reactionSends.map(([, content]) => content.react.text), ['👀', '']);
  assert.equal(reactionSends.every(([jid]) => jid === ACCOUNT_JID), true);
  assert.equal(reactionSends.every(([, content]) => content.react.key === inbound.key), true);
  await runtime.stop();
});

test('WhatsApp runtime sends a connection test to self and suppresses its outbound echo', async () => {
  let callbacks;
  let askCount = 0;
  const sent = [];
  const socket = {
    sendPresenceUpdate: async () => {},
    readMessages: async () => {},
    sendMessage: async (jid, content) => {
      sent.push([jid, content]);
      return { key: { id: 'connection-test-1' } };
    },
  };
  const runtime = new WhatsappRuntime({
    config: linkedConfig(),
    authDir: '/tmp/test-whatsapp-connection-test',
    harness: {
      ensureRunning: async () => {},
      sessionExists: async () => true,
      ask: async () => { askCount += 1; return 'unexpected'; },
    },
    state: {
      hasSeen: () => false,
      markSeen: async () => {},
      sessionFor: () => 'session-connection-test',
      sessionExists: async () => true,
    },
    createSession: async (options) => {
      callbacks = options;
      return {
        socket,
        ready: Promise.resolve({ accountJid: ACCOUNT_JID, name: 'Harness WhatsApp' }),
        close: async () => {},
        logout: async () => {},
      };
    },
  });

  await runtime.start();
  assert.deepEqual(await runtime.sendConnectionTest('连接测试'), { sent: true });
  assert.deepEqual(await runtime.sendProactiveText({
    kind: 'group',
    route: { jid: '120363000000000000@g.us' },
  }, '主动投递'), { providerMessageIds: ['connection-test-1'] });
  assert.deepEqual(sent, [
    [ACCOUNT_JID, { text: '连接测试' }],
    ['120363000000000000@g.us', { text: '主动投递' }],
  ]);
  await callbacks.onMessage({
    key: { remoteJid: ACCOUNT_JID, id: 'connection-test-1', fromMe: true },
    message: { conversation: '连接测试' },
  });
  assert.equal(askCount, 0);
  await runtime.stop();
});

test('WhatsApp controller delegates connection test copy to the current runtime', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-im-whatsapp-test-message-'));
  const configStore = await new WhatsappConfigStore(join(root, 'config.json')).load();
  const config = await configStore.save(linkedConfig());
  const sent = [];
  const proactiveSends = [];
  const controller = new WhatsappController({
    configStore,
    authPath: (name) => join(root, 'auth', name),
    createSession: async () => { throw new Error('not used'); },
    createRuntime: async () => ({
      status: {
        ready: true,
        connectionState: 'connected',
        harnessReachable: true,
      },
      start: async () => {},
      stop: async () => {},
      sendConnectionTest: async (text) => {
        sent.push(text);
        return { sent: true };
      },
      sendProactiveText: async (...args) => {
        proactiveSends.push(args);
        return { sent: true };
      },
    }),
  });
  t.after(() => controller.close());

  await controller.initialize();
  assert.deepEqual(await controller.sendConnectionTest(config.botId), { sent: true });
  assert.deepEqual(sent, [
    '✅ DeepSeek Harness 连接测试成功\n这条消息由「IM机器人」设置页中的“Harness WhatsApp（1650••••0123）”机器人卡片发出。',
  ]);
  const target = { kind: 'user', route: { jid: '16505550199@s.whatsapp.net' } };
  assert.deepEqual(await controller.sendProactiveText(config.botId, target, 'proactive-test'), {
    sent: true,
  });
  assert.deepEqual(proactiveSends, [[target, 'proactive-test', {}]]);
});

test('WhatsApp reconnect RPC sends tests only for the connected target and keeps failures non-fatal', async () => {
  const botId = deriveWhatsappBotId(ACCOUNT_JID);
  let connected = true;
  let sendFailure = false;
  let sendCalls = 0;
  const snapshot = () => ({
    schemaVersion: 1,
    revision: 1,
    bots: [{
      botId,
      state: connected ? 'connected' : 'offline',
      connected,
      configured: true,
      bot: { name: 'Harness WhatsApp', idMasked: '1650••••0123' },
      health: { summary: 'status', lastCheckedAt: Date.now() },
    }],
    totals: { configured: 1, connected: connected ? 1 : 0 },
  });
  const controller = {
    status: async () => snapshot(),
    startProvisioning: async () => null,
    registrationStatus: async () => null,
    cancelProvisioning: async () => null,
    reconnectBot: async () => snapshot(),
    deleteBot: async () => snapshot(),
    updateAccessPolicy: async () => snapshot(),
    sendConnectionTest: async () => {
      sendCalls += 1;
      if (sendFailure) throw new Error('private provider failure');
      return { sent: true };
    },
  };
  const handler = createWhatsappRpcHandler(controller);

  const legacy = await handler(WHATSAPP_ENDPOINTS.reconnectBot, { botId });
  assert.equal(legacy.ok, true);
  assert.equal('testMessage' in legacy.value, false);
  assert.equal(sendCalls, 0);

  const success = await handler(
    WHATSAPP_ENDPOINTS.reconnectBot,
    { botId, sendTest: true },
  );
  assert.deepEqual(success.value.testMessage, { sent: true });
  assert.equal(sendCalls, 1);

  sendFailure = true;
  const failedSend = await handler(
    WHATSAPP_ENDPOINTS.reconnectBot,
    { botId, sendTest: true },
  );
  assert.equal(failedSend.ok, true);
  assert.deepEqual(failedSend.value.testMessage, {
    sent: false,
    code: 'test-message-failed',
  });
  assert.doesNotMatch(JSON.stringify(failedSend), /private provider failure/);

  connected = false;
  const unavailable = await handler(
    WHATSAPP_ENDPOINTS.reconnectBot,
    { botId, sendTest: true },
  );
  assert.equal(unavailable.ok, true);
  assert.deepEqual(unavailable.value.testMessage, {
    sent: false,
    code: 'test-target-unavailable',
  });
  assert.equal(sendCalls, 2);

  const invalid = await handler(
    WHATSAPP_ENDPOINTS.reconnectBot,
    { botId, sendTest: 'yes' },
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'bad-request');
});

test('WhatsApp RPC never sends a connection test after reconnect is cancelled', async () => {
  let resolveReconnect;
  let sendCalls = 0;
  const reconnect = new Promise((resolve) => { resolveReconnect = resolve; });
  const botId = deriveWhatsappBotId(ACCOUNT_JID);
  const controller = {
    status: async () => ({ bots: [] }),
    startProvisioning: async () => null,
    registrationStatus: async () => null,
    cancelProvisioning: async () => null,
    reconnectBot: async () => reconnect,
    sendConnectionTest: async () => { sendCalls += 1; },
    deleteBot: async () => ({ bots: [] }),
    updateAccessPolicy: async () => ({ bots: [] }),
  };
  const abort = new AbortController();
  const result = createWhatsappRpcHandler(controller)(WHATSAPP_ENDPOINTS.reconnectBot, {
    botId,
    sendTest: true,
  }, abort.signal);

  abort.abort();
  resolveReconnect({ bots: [{ botId, connected: true }] });

  assert.deepEqual(await result, {
    ok: false,
    error: { code: 'cancelled', message: 'The request was cancelled.' },
  });
  assert.equal(sendCalls, 0);
});

test('WhatsApp QR controller and RPC keep the raw QR and linked identity host-only', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-im-whatsapp-controller-'));
  const configStore = await new WhatsappConfigStore(join(root, 'config.json')).load();
  let sessionOptions;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const deletedAuth = [];
  const appliedPolicies = [];
  const controller = new WhatsappController({
    configStore,
    authPath: (name) => join(root, 'auth', name),
    createSession: async (options) => {
      sessionOptions = options;
      queueMicrotask(() => options.onQr('raw-linked-device-qr'));
      return { ready, close: async () => {} };
    },
    createRuntime: async () => ({
      status: {
        ready: true,
        connectionState: 'connected',
        harnessReachable: true,
        lastCheckedAt: Date.now(),
      },
      start: async () => {},
      stop: async () => {},
    }),
    deleteAuth: async (name) => deletedAuth.push(name),
  });
  t.after(() => controller.close());
  const handler = createWhatsappRpcHandler(controller, {
    encodeQr: async () => 'data:image/png;base64,QUJDRA==',
  });
  controller.updateAccessPolicy = async (botId, policy, projectStatus) => {
    appliedPolicies.push(policy);
    const current = await controller.status();
    const updated = {
      ...current,
      bots: current.bots.map((bot) => bot.botId === botId
        ? { ...bot, accessPolicy: policy }
        : bot),
    };
    return projectStatus ? projectStatus(updated) : updated;
  };
  const started = await handler(WHATSAPP_ENDPOINTS.beginProvisioning, {});
  assert.equal(started.ok, true);
  assert.match(started.value.qrCodeDataUrl, /^data:image\/png/);
  assert.doesNotMatch(JSON.stringify(started.value), /raw-linked-device-qr|accountJid|authDirectory/);
  resolveReady({ accountJid: ACCOUNT_JID, name: 'Harness WhatsApp' });
  let status;
  for (let index = 0; index < 20; index += 1) {
    status = await handler(WHATSAPP_ENDPOINTS.status, {});
    if (status.value?.bots?.length) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(status.ok, true);
  assert.equal(status.value.bots[0].connected, true);
  assert.deepEqual(status.value.bots[0].accessPolicy, {
    accessMode: WHATSAPP_ACCESS_MODES.selfOnly,
    allowedNumbers: [],
  });
  assert.doesNotMatch(JSON.stringify(status.value), /16505550123@s\.whatsapp\.net|authDirectory/);
  const unifiedPolicy = {
    direct: {
      mode: 'allowlist',
      open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
      allowlist: {
        users: [{
          id: '16505550999@s.whatsapp.net',
          canExecuteCommands: true,
        }],
      },
    },
    group: {
      mode: 'allowlist',
      open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
      allowlist: { users: [] },
    },
  };
  const updated = await handler(WHATSAPP_ENDPOINTS.setAccessPolicy, {
    botId: status.value.bots[0].botId,
    policy: unifiedPolicy,
  });
  assert.equal(updated.ok, true);
  assert.deepEqual(updated.value.bots[0].accessPolicy, unifiedPolicy);
  assert.deepEqual(appliedPolicies, [unifiedPolicy]);
  const invalidPolicy = await handler(WHATSAPP_ENDPOINTS.setAccessPolicy, {
    botId: status.value.bots[0].botId,
    accessMode: 'compatible',
    allowedNumbers: [],
  });
  assert.equal(invalidPolicy.ok, false);
  assert.equal(invalidPolicy.error.code, 'bad-request');
  assert.equal(sessionOptions.signal.aborted, false);
  assert.deepEqual(deletedAuth, []);
});
