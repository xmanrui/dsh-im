import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyDeliverySyncPatch,
  DEFAULT_DELIVERY_SYNC_SETTINGS,
  DELIVERY_SYNC_ICON_MAX_LENGTH,
  normalizeDeliverySyncIcon,
  normalizeDeliverySyncSettings,
  withDeliverySyncIcon,
} from '../src/channels/shared/delivery-sync-settings.mjs';
import {
  DeliverySyncSettingsStore,
  deliverySyncSettingsPath,
  getDeliverySyncSettingsStore,
} from '../src/channels/shared/delivery-sync-settings-store.mjs';
import {
  createDeliverySyncRpcHandler,
  DELIVERY_SYNC_ENDPOINTS,
  validDeliverySyncPayload,
} from '../plugin-src/host/delivery-sync-rpc.mjs';
import { INBOUND_TTL_RPC_CHANNEL } from '../plugin-src/host/inbound-ttl-rpc.mjs';

async function home(t) {
  const path = await mkdtemp(join(tmpdir(), 'dsh-im-delivery-sync-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('the shipped defaults mirror nothing at all', () => {
  // Both switches ship off: a fresh install, and a document that cannot be
  // read, must never start mirroring a chat on its own.
  assert.deepEqual({ ...DEFAULT_DELIVERY_SYNC_SETTINGS }, {
    mirrorUserInput: false,
    deliverModelAnswers: false,
    inputIcon: '',
    modelIcon: '',
  });
});

test('an icon is trimmed, bounded, single-line, and degrades to no prefix', () => {
  assert.equal(normalizeDeliverySyncIcon('  🤖  '), '🤖');
  assert.equal(normalizeDeliverySyncIcon(''), '');
  assert.equal(normalizeDeliverySyncIcon('   '), '');
  assert.equal(normalizeDeliverySyncIcon(undefined), '');
  assert.equal(normalizeDeliverySyncIcon(42), '');
  assert.equal(normalizeDeliverySyncIcon('a'.repeat(DELIVERY_SYNC_ICON_MAX_LENGTH)), 'a'.repeat(32));
  assert.equal(normalizeDeliverySyncIcon('a'.repeat(DELIVERY_SYNC_ICON_MAX_LENGTH + 1)), '');
  assert.equal(normalizeDeliverySyncIcon('two\nlines'), '');
  assert.equal(normalizeDeliverySyncIcon('tab\there'), '');
  assert.equal(normalizeDeliverySyncIcon('bell\u0007'), '');
});

test('a settings body keeps known fields and fills the rest from the defaults', () => {
  assert.deepEqual({ ...normalizeDeliverySyncSettings({ mirrorUserInput: true }) }, {
    ...DEFAULT_DELIVERY_SYNC_SETTINGS,
    mirrorUserInput: true,
  });
  assert.deepEqual({ ...normalizeDeliverySyncSettings({ inputIcon: ' 👤 ', modelIcon: 'x'.repeat(99) }) }, {
    ...DEFAULT_DELIVERY_SYNC_SETTINGS,
    inputIcon: '👤',
    modelIcon: '',
  });
  assert.equal(normalizeDeliverySyncSettings(null), null);
  assert.equal(normalizeDeliverySyncSettings([]), null);
  assert.equal(normalizeDeliverySyncSettings('mirror'), null);
});

test('a partial patch applies only the fields it carries', () => {
  const current = { mirrorUserInput: true, deliverModelAnswers: false, inputIcon: '👤', modelIcon: '🤖' };
  assert.deepEqual({ ...applyDeliverySyncPatch(current, { modelIcon: '' }) }, {
    ...current,
    modelIcon: '',
  });
  assert.deepEqual({ ...applyDeliverySyncPatch(current, { mirrorUserInput: 'yes' }) }, current);
  assert.deepEqual({ ...applyDeliverySyncPatch(null, { deliverModelAnswers: true }) }, {
    ...DEFAULT_DELIVERY_SYNC_SETTINGS,
    deliverModelAnswers: true,
  });
});

test('the message body separates a non-empty icon with one blank line', () => {
  assert.equal(withDeliverySyncIcon('🤖', 'answer'), '🤖\n\nanswer');
  assert.equal(withDeliverySyncIcon('', 'answer'), 'answer');
  assert.equal(withDeliverySyncIcon('   ', 'answer'), 'answer');
  assert.equal(withDeliverySyncIcon('a'.repeat(40), 'answer'), 'answer');
});

test('the store writes the document atomically and reads it back', async (t) => {
  const root = await home(t);
  const path = deliverySyncSettingsPath({ dshHome: root });
  assert.equal(path, join(root, 'integrations', 'dsh-im', 'delivery-sync-settings.json'));

  const store = new DeliverySyncSettingsStore(path);
  assert.deepEqual(await store.get(), { ...DEFAULT_DELIVERY_SYNC_SETTINGS });

  assert.deepEqual(await store.set({ mirrorUserInput: true, inputIcon: '👤' }), {
    ...DEFAULT_DELIVERY_SYNC_SETTINGS,
    mirrorUserInput: true,
    inputIcon: '👤',
  });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    version: 1,
    deliverySync: {
      mirrorUserInput: true,
      deliverModelAnswers: false,
      inputIcon: '👤',
      modelIcon: '',
    },
  });
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  // A later save keeps the fields it did not touch.
  await store.set({ modelIcon: '🤖' });
  const reloaded = await new DeliverySyncSettingsStore(path).get();
  assert.equal(reloaded.mirrorUserInput, true);
  assert.equal(reloaded.inputIcon, '👤');
  assert.equal(reloaded.modelIcon, '🤖');
});

test('a damaged document falls back to the defaults instead of failing', async (t) => {
  const root = await home(t);
  const path = deliverySyncSettingsPath({ dshHome: root });
  await mkdir(join(root, 'integrations', 'dsh-im'), { recursive: true });
  await writeFile(path, JSON.stringify({ version: 1, deliverySync: { mirrorUserInput: true } }));
  assert.equal((await new DeliverySyncSettingsStore(path).get()).mirrorUserInput, true);
  for (const contents of ['{not json', '[]', '{"version":2,"deliverySync":{}}', '{"version":1,"deliverySync":"x"}']) {
    await writeFile(path, contents);
    assert.deepEqual(
      await new DeliverySyncSettingsStore(path).get(),
      { ...DEFAULT_DELIVERY_SYNC_SETTINGS },
      contents,
    );
  }
  assert.throws(() => new DeliverySyncSettingsStore(''), TypeError);
});

test('one settings owner is shared per DSH home', async (t) => {
  const root = await home(t);
  const first = getDeliverySyncSettingsStore({ dshHome: root });
  const second = getDeliverySyncSettingsStore({ dshHome: root });
  assert.equal(first, second);
  await first.set({ mirrorUserInput: true });
  assert.equal((await getDeliverySyncSettingsStore({ dshHome: root }).get()).mirrorUserInput, true);
});

test('the RPC validates get and set payloads', () => {
  assert.deepEqual(DELIVERY_SYNC_ENDPOINTS, {
    get: 'settings.delivery-sync.get',
    set: 'settings.delivery-sync.set',
  });
  // The delivery settings share the existing management channel.
  assert.equal(INBOUND_TTL_RPC_CHANNEL, '/dsh-im-settings');

  assert.equal(validDeliverySyncPayload(DELIVERY_SYNC_ENDPOINTS.get, {}), true);
  assert.equal(validDeliverySyncPayload(DELIVERY_SYNC_ENDPOINTS.set, { mirrorUserInput: true }), true);
  assert.equal(validDeliverySyncPayload(DELIVERY_SYNC_ENDPOINTS.set, {
    mirrorUserInput: true, deliverModelAnswers: false, inputIcon: '👤', modelIcon: '🤖',
  }), true);
  // An unusable icon is still a string: the store normalizes it to no prefix.
  assert.equal(validDeliverySyncPayload(DELIVERY_SYNC_ENDPOINTS.set, { modelIcon: 'x'.repeat(40) }), true);

  for (const [endpoint, payload] of [
    [DELIVERY_SYNC_ENDPOINTS.get, { mirrorUserInput: true }],
    [DELIVERY_SYNC_ENDPOINTS.get, null],
    [DELIVERY_SYNC_ENDPOINTS.get, []],
    [DELIVERY_SYNC_ENDPOINTS.set, {}],
    [DELIVERY_SYNC_ENDPOINTS.set, { mirrorUserInput: 'yes' }],
    [DELIVERY_SYNC_ENDPOINTS.set, { deliverModelAnswers: 1 }],
    [DELIVERY_SYNC_ENDPOINTS.set, { inputIcon: null }],
    [DELIVERY_SYNC_ENDPOINTS.set, { unknown: true }],
    ['settings.delivery-sync.unknown', {}],
  ]) {
    assert.equal(
      validDeliverySyncPayload(endpoint, payload),
      false,
      `${endpoint} ${JSON.stringify(payload)}`,
    );
  }
});

test('the RPC reads, saves, and reports failures without leaking them', async (t) => {
  const root = await home(t);
  const store = new DeliverySyncSettingsStore(deliverySyncSettingsPath({ dshHome: root }));
  const handler = createDeliverySyncRpcHandler(store);

  assert.deepEqual(await handler(DELIVERY_SYNC_ENDPOINTS.get, {}), {
    ok: true,
    value: { ...DEFAULT_DELIVERY_SYNC_SETTINGS },
  });
  assert.deepEqual(await handler(DELIVERY_SYNC_ENDPOINTS.set, {
    mirrorUserInput: true, modelIcon: '🤖',
  }), {
    ok: true,
    value: { ...DEFAULT_DELIVERY_SYNC_SETTINGS, mirrorUserInput: true, modelIcon: '🤖' },
  });
  assert.equal((await store.get()).mirrorUserInput, true);

  assert.equal((await handler(DELIVERY_SYNC_ENDPOINTS.get, { extra: 1 })).error.code, 'bad-request');
  assert.equal((await handler(DELIVERY_SYNC_ENDPOINTS.get, {}, AbortSignal.abort())).error.code, 'cancelled');

  const warnings = [];
  const failing = createDeliverySyncRpcHandler({
    async get() { throw new Error('private-disk-path'); },
    async set() { throw new Error('private-disk-path'); },
  }, { logger: { warn: (line) => warnings.push(line) } });
  const failure = await failing(DELIVERY_SYNC_ENDPOINTS.get, {});
  assert.equal(failure.error.code, 'delivery-sync-settings-unavailable');
  // The page only sees a stable code; the cause itself reaches the Host log
  // instead of disappearing inside the catch.
  assert.doesNotMatch(JSON.stringify(failure), /private/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /delivery-sync settings settings\.delivery-sync\.get failed/);
  assert.match(warnings[0], /private-disk-path/);
  assert.throws(() => createDeliverySyncRpcHandler({}), TypeError);
});
