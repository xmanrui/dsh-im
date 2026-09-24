import test, { after } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deepStrictEqual, match, ok, rejects } from 'node:assert';

import {
  MatrixConfigStore,
  MatrixSidecarStore,
  deriveMatrixBotIdentity,
  maskMatrixBotId,
} from '../../../src/channels/matrix/matrix-config-store.mjs';

const HOMESERVER = 'https://matrix.example.org';
const USER = '@Bot:Example.org';

const tempDirectories = new Set();

async function makeTempDirectory(prefix) {
  const created = await mkdtemp(join(tmpdir(), prefix));
  tempDirectories.add(created);
  return created;
}

after(async () => {
  for (const directory of tempDirectories) await rm(directory, { recursive: true, force: true });
});

async function freshStore() {
  const directory = await makeTempDirectory('dsh-im-matrix-store-');
  const path = join(directory, 'matrix-bots.json');
  const store = new MatrixConfigStore(path);
  await store.load();
  return { store, path };
}

function botFixture(overrides = {}) {
  const derived = deriveMatrixBotIdentity({ homeserver: HOMESERVER, userId: USER });
  return {
    botId: derived.botId,
    platformId: 'matrix.example.org|@bot:example.org',
    homeserver: HOMESERVER,
    userId: USER,
    deviceId: 'DSHDEVICE1',
    tokenRef: derived.tokenRef,
    passwordRef: derived.passwordRef,
    name: 'Bot',
    username: 'bot',
    createdAt: '2026-09-18T00:00:00.000Z',
    connectedAt: null,
    ...overrides,
  };
}

test('identity derivation is stable, hash-shaped and homeserver-port sensitive', () => {
  const first = deriveMatrixBotIdentity({ homeserver: 'https://matrix.example.org/', userId: USER });
  const second = deriveMatrixBotIdentity({ homeserver: 'https://matrix.example.org', userId: '@bot:example.org' });
  deepStrictEqual(first, second, 'identity is case- and slash-insensitive');
  match(first.botId, /^matrix_[a-f0-9]{24}$/);
  match(first.tokenRef, /^DSH_MATRIX_TOKEN_[A-F0-9]{24}$/);
  match(first.passwordRef, /^DSH_MATRIX_PASSWORD_[A-F0-9]{24}$/);
  ok(deriveMatrixBotIdentity({ homeserver: 'https://a.example.org:8448', userId: '@b:a.example.org:8448' })
    .botId !== first.botId, 'a different homeserver authority yields a different identity');
  let identityFault = null;
  try {
    deriveMatrixBotIdentity({ homeserver: 'ftp://x', userId: USER });
  } catch (error) {
    identityFault = error;
  }
  ok(identityFault instanceof TypeError, 'a non-https homeserver cannot mint a bot identity');
});

test('the bot document round-trips through disk and rejects tampered or incomplete records', async () => {
  const { store, path } = await freshStore();
  await store.save(botFixture());
  deepStrictEqual(store.get(`matrix_${'f'.repeat(24)}`), null);
  const saved = store.list()[0];
  deepStrictEqual(saved.deviceId, 'DSHDEVICE1');
  match(maskMatrixBotId(saved.platformId), /^matrix/u);

  const reread = new MatrixConfigStore(path);
  await reread.load();
  deepStrictEqual(reread.list(), store.list());

  await rejects(() => store.save({ ...botFixture(), botId: 'matrix_deadbeef' }),
    /Refusing to persist incomplete Matrix bot data/u);
  await rejects(() => store.save({ ...botFixture(), userId: 'not-an-mxid' }),
    /Refusing to persist incomplete Matrix bot data/u);
  await rejects(() => store.save({ ...botFixture(), deviceId: 'bad device id!' }),
    /Refusing to persist incomplete Matrix bot data/u);

  const removed = await store.remove(saved.botId);
  ok(removed && removed.botId === saved.botId);
  deepStrictEqual(store.list(), []);
  deepStrictEqual(await store.remove(saved.botId), null, 'removing twice is a no-op');
});

test('a corrupt-looking document fails closed on load and an absent file starts empty', async () => {
  const directory = await makeTempDirectory('dsh-im-matrix-store-');
  const path = join(directory, 'matrix-bots.json');
  const absent = new MatrixConfigStore(path);
  await absent.load();
  deepStrictEqual(absent.list(), []);
  await writeFile(path, '{ not json', 'utf8');
  const broken = new MatrixConfigStore(path);
  await rejects(() => broken.load(), /invalid bot data|Unexpected token|JSON/u);
});

test('the sidecar persists the sync cursor, rooms, dm map and declines across reloads', async () => {
  const directory = await makeTempDirectory('dsh-im-matrix-store-');
  const path = join(directory, 'matrix.json');
  const sidecar = await new MatrixSidecarStore(path).load();
  deepStrictEqual(sidecar.nextBatch(), null);
  await sidecar.apply({
    nextBatch: 's2178_9_1',
    joinedRooms: ['!a:example.org', '!a:example.org', '  '],
    dmRooms: ['!dm:example.org'],
    dmRoomByUser: { '@alice:example.org': '!dm:example.org' },
    declinedRooms: ['!dead:example.org'],
  });
  const reread = await new MatrixSidecarStore(path).load();
  deepStrictEqual(reread.nextBatch(), 's2178_9_1');
  deepStrictEqual(reread.joinedRooms(), ['!a:example.org']);
  deepStrictEqual(reread.dmRoomByUser(), { '@alice:example.org': '!dm:example.org' });
  ok(reread.isDeclined('!dead:example.org') && !reread.isDeclined('!a:example.org'));
  await reread.apply({ nextBatch: null });
  deepStrictEqual((await new MatrixSidecarStore(path).load()).nextBatch(), null);
  deepStrictEqual(JSON.parse(await readFile(path, 'utf8')).version, undefined,
    'the sidecar keeps a plain shape without the bot document envelope');
  await reread.remove();
});
