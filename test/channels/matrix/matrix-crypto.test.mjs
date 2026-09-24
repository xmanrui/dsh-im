import test, { after } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deepStrictEqual, equal, match, ok, rejects } from 'node:assert';

import {
  MATRIX_MEGOLM_ALGORITHM,
  MATRIX_OLM_PK_ALGORITHM,
  MatrixCryptoEngine,
  MatrixCryptoError,
} from '../../../src/channels/matrix/matrix-crypto.mjs';
import { MatrixCryptoStore, matrixCryptoPathFor } from '../../../src/channels/matrix/matrix-crypto-store.mjs';

const BOT = '@bot:example.org';
const ALICE = '@alice:example.org';
const ROOM = '!room:example.org';

const tempDirectories = new Set();

async function makeTempDirectory(prefix) {
  const created = await mkdtemp(join(tmpdir(), prefix));
  tempDirectories.add(created);
  return created;
}

after(async () => {
  for (const directory of tempDirectories) await rm(directory, { recursive: true, force: true });
});

async function eventually(assertion, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

function loggerFixture() {
  const warnings = [];
  return {
    warnings,
    info: () => undefined,
    debug: () => undefined,
    warn: (...args) => { warnings.push(args.map((entry) => String(entry?.message ?? entry)).join(' ')); },
    error: () => undefined,
  };
}

// One in-memory homeserver for a whole test: device-key uploads, key queries and
// to-device routing between the engines that registered for their user|device pair.
function createHub() {
  const hub = {
    uploads: [],
    toDevice: [],
    members: new Set([ALICE, BOT]),
    engines: new Map(),
    apiFor(userId, deviceId) {
      return {
        uploadKeys: async (payload) => {
          hub.uploads.push({ userId, deviceId, payload });
          return {};
        },
        queryKeys: async (userIds) => ({
          device_keys: Object.fromEntries(userIds.map((userId) => [userId, Object.fromEntries(
            hub.uploads
              .filter((entry) => entry.userId === userId)
              .map((entry) => [entry.deviceId, structuredClone(entry.payload)]),
          )])),
        }),
        claimKeys: async () => ({ one_time_keys: {}, fallback_keys: {} }),
        sendToDevice: async (type, messages) => {
          hub.toDevice.push({ type, sender: userId, messages });
          for (const [targetUserId, byDevice] of Object.entries(messages ?? {})) {
            for (const [targetDeviceId, pkg] of Object.entries(byDevice ?? {})) {
              const engine = hub.engines.get(`${targetUserId}|${targetDeviceId}`);
              await engine?.handleToDeviceEvents([{
                type,
                sender: userId,
                content: { messages: { [targetUserId]: { [targetDeviceId]: pkg } } },
              }]);
            }
          }
          return {};
        },
        getJoinedMembers: async () => [...hub.members],
      };
    },
  };
  return hub;
}

async function startEngine(hub, { userId, deviceId, storePath, logger = loggerFixture() }) {
  const store = await new MatrixCryptoStore(storePath).load();
  const engine = new MatrixCryptoEngine({
    api: hub.apiFor(userId, deviceId),
    store,
    userId,
    deviceId,
    logger,
  });
  hub.engines.set(`${userId}|${deviceId}`, engine);
  await engine.start();
  return { engine, store, logger };
}

test('bootstrap registers device keys and a restart restores the same identity from the pickled store', async () => {
  const directory = await makeTempDirectory('dsh-im-matrix-crypto-boot-');
  const storePath = matrixCryptoPathFor(directory);
  const hub = createHub();
  const first = await startEngine(hub, { userId: BOT, deviceId: 'BOTDEV', storePath });
  ok(hub.uploads.length >= 1, 'the device keys are uploaded during bootstrap');
  const uploaded = hub.uploads.at(-1).payload;
  equal(uploaded.device_id, 'BOTDEV');
  ok(uploaded.keys?.curve25519 && uploaded.keys?.ed25519, 'both identity keys are published');
  ok(Object.keys(uploaded.one_time_keys ?? {}).length > 0, 'one-time keys are published on bootstrap');
  ok(Object.values(uploaded.signatures ?? {})[0], 'the device self-signature is uploaded');
  equal(hub.uploads.at(-1).payload.fallback_keys?.length, 1, 'a fallback key is published');
  const firstStats = first.engine.getStats();
  ok(firstStats.ready && firstStats.deviceId === 'BOTDEV');
  ok(firstStats.ed25519Fingerprint.length > 0);

  // A restart on the very same store must restore the pickled account instead of
  // generating a fresh device identity; this also proves the bootstrap passphrase
  // round-trips through the store (a mismatch throws on unpickle and fails here).
  const second = await startEngine(hub, { userId: BOT, deviceId: 'BOTDEV', storePath });
  equal(second.engine.getStats().ed25519Fingerprint, firstStats.ed25519Fingerprint,
    'the restored account keeps the original ed25519 identity');
  equal(second.engine.getStats().curve25519Fingerprint, firstStats.curve25519Fingerprint);
  await second.engine.stop();

  // The plan's device-drift gate: a store bound to another device refuses to start.
  const drifted = new MatrixCryptoEngine({
    api: hub.apiFor(BOT, 'OTHERDEV'),
    store: await new MatrixCryptoStore(storePath).load(),
    userId: BOT,
    deviceId: 'OTHERDEV',
    logger: loggerFixture(),
  });
  await rejects(() => drifted.start(), (error) => (
    error instanceof MatrixCryptoError && error.code === 'crypto-device-drift'
  ), 'the crypto state refuses to bind to a different device id');
});

test('room keys shared through to-device unlock decryption; buffered ciphertext flushes and replays drop', async () => {
  const hub = createHub();
  hub.members = new Set([ALICE]);
  const aliceDirectory = await makeTempDirectory('dsh-im-matrix-crypto-alice-');
  const botDirectory = await makeTempDirectory('dsh-im-matrix-crypto-bot-');
  const alice = await startEngine(hub, { userId: ALICE, deviceId: 'ALICEDEV', storePath: join(aliceDirectory, 'matrix-crypto.json') });
  const botLogger = loggerFixture();
  const bot = await startEngine(hub, { userId: BOT, deviceId: 'BOTDEV', storePath: join(botDirectory, 'matrix-crypto.json'), logger: botLogger });
  const botEngine = bot.engine;

  const flushed = [];
  botEngine.setPendingMessageHandler((roomId, event) => {
    flushed.push({ roomId, event });
    return Promise.resolve();
  });

  // The first send shares to nobody but the sender itself because the bot is not a
  // member yet; the bot therefore cannot decrypt and buffers the event for a key request.
  const encFirst = await alice.engine.encryptForRoom(ROOM, { msgtype: 'm.text', body: '第一条' });
  equal(encFirst.algorithm, MATRIX_MEGOLM_ALGORITHM);
  ok(encFirst.sender_key && encFirst.session_id && encFirst.ciphertext, 'the encrypted envelope carries the megolm locator fields');
  const early = await botEngine.decryptRoomEvent(ROOM, {
    type: 'm.room.encrypted',
    event_id: '$c1:example.org',
    sender: ALICE,
    origin_server_ts: Date.now(),
    content: structuredClone(encFirst),
  });
  equal(early, null, 'ciphertext without its room key cannot decrypt yet');
  await eventually(() => {
    ok(hub.toDevice.some((entry) => entry.type === 'm.room_key_request'),
      'the missing key raises one to-device key request');
  });
  equal(botEngine.getStats().undecryptable >= 1, true, 'the miss is counted for diagnostics');

  // The bot joins; the runtime reacts to a membership state event with invalidateRoomSharing,
  // which clears the member/device caches so the next send sees the new device and shares
  // the live session key over m.room_key; importing that key flushes the buffered event.
  hub.members = new Set([ALICE, BOT]);
  alice.engine.invalidateRoomSharing(ROOM);
  const encSecond = await alice.engine.encryptForRoom(ROOM, { msgtype: 'm.text', body: '第二条' });
  ok(hub.toDevice.some((entry) => entry.type === 'm.room_key'),
    'the session key is shared to the new device through to-device traffic');
  equal(flushed.length, 1, 'the buffered ciphertext is delivered once its key arrives');
  equal(flushed[0]?.event?.event_id, '$c1:example.org');
  equal(flushed[0]?.roomId, ROOM);

  const second = await botEngine.decryptRoomEvent(ROOM, {
    type: 'm.room.encrypted',
    event_id: '$c2:example.org',
    sender: ALICE,
    origin_server_ts: Date.now(),
    content: structuredClone(encSecond),
  });
  deepStrictEqual(second?.content, { msgtype: 'm.text', body: '第二条' }, 'the second message decrypts directly');
  equal(second?.senderDeviceId, 'ALICEDEV', 'the sending device is reported from the authenticated payload');

  const replay = await botEngine.decryptRoomEvent(ROOM, {
    type: 'm.room.encrypted',
    event_id: '$c2:example.org',
    sender: ALICE,
    origin_server_ts: Date.now(),
    content: structuredClone(encSecond),
  });
  equal(replay, null, 'a replayed megolm payload at the same index is dropped');

  ok(alice.engine.getStats().roomKeySends >= 1, 'the outbound room key share is counted on the sharing device');
  ok(alice.engine.getStats().shareFailures === 0, 'sharing to the verified device succeeded');

  // The outbound sharing state persists through the store queue so a restart re-shares only to new devices.
  // Read the in-memory snapshot (the store's applied authority), which the fire-and-forget persist updates.
  await eventually(() => {
    const shared = alice.store.snapshot?.groupOutbound?.[ROOM]?.sharedWith ?? [];
    ok(shared.includes('@bot:example.org|BOTDEV'),
      'the outbound session records the new device it shared with across the store queue');
  });
  await eventually(() => {
    const persisted = bot.store.snapshot?.groupInbound ?? [];
    ok(persisted.some((entry) => entry.roomId === ROOM), 'the imported inbound session is persisted on the receiving device');
  });
  await alice.engine.stop();
  await botEngine.stop();
});

test('ciphertext from an unknown sender key is refused, counted and leaves the engine ready', async () => {
  const hub = createHub();
  const botDirectory = await makeTempDirectory('dsh-im-matrix-crypto-forgery-');
  const bot = await startEngine(hub, { userId: BOT, deviceId: 'BOTDEV', storePath: join(botDirectory, 'matrix-crypto.json') });
  // An envelope whose sender_key was never seen on any imported session: no key can
  // exist for it, so it must be refused and counted instead of importing state.
  const alice = await startEngine(hub, {
    userId: ALICE, deviceId: 'ALICEDEV', storePath: join(botDirectory, 'alice-matrix-crypto.json'),
  });
  hub.members = new Set([ALICE, BOT]);
  const enc = await alice.engine.encryptForRoom(ROOM, { msgtype: 'm.text', body: '环回' });
  ok(enc.ciphertext, 'the loopback share path completed with genuine signatures before this check');
  const undecryptableBefore = bot.engine.getStats().undecryptable;
  const missing = await bot.engine.decryptRoomEvent(ROOM, {
    event_id: '$missing:example.org', sender: ALICE, origin_server_ts: Date.now(),
    content: { algorithm: MATRIX_MEGOLM_ALGORITHM, sender_key: 'not-a-real-ed25519-key', device_id: 'X', session_id: '$s', ciphertext: 'zzz' },
  });
  equal(missing, null, 'an unverifiable ciphertext is refused');
  ok(bot.engine.getStats().undecryptable > undecryptableBefore, 'the refusal is counted');
  equal(bot.engine.getStats().ready, true);
  await alice.engine.stop();
  await bot.engine.stop();
});

test('the pk algorithm constant and the store file layout stay in the documented form', async () => {
  equal(MATRIX_OLM_PK_ALGORITHM, 'm.olm.v1.curve25519');
  const directory = await makeTempDirectory('dsh-im-matrix-crypto-layout-');
  const hub = createHub();
  const { engine } = await startEngine(hub, { userId: BOT, deviceId: 'BOTDEV', storePath: matrixCryptoPathFor(directory) });
  await engine.stop();
  const document = JSON.parse(await readFile(matrixCryptoPathFor(directory), 'utf8'));
  equal(document.version, 1);
  equal(document.deviceId, 'BOTDEV');
  ok(document.accountPickle && document.pkDecryptionPickle, 'both pickles are stored');
  match(document.picklingPassphrase, /^[A-Za-z0-9+/=]+$/, 'the pickling passphrase is stored as the bootstrap secret');
  ok(document.pkEncryptionKey, 'the public pk-encryption key is stored beside it');
});
