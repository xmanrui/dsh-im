import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { getImHostLanguage, setImHostLanguage } from '../src/channels/shared/i18n.mjs';
import {
  MESSAGE_LANGUAGE_TAGS,
  normalizeMessageLanguageChoice,
} from '../src/channels/shared/interface-language.mjs';
import { InterfaceLanguageStore } from '../src/channels/shared/interface-language-store.mjs';
import {
  createHostLanguageController,
  interfaceLanguageSettingsPath,
} from '../plugin-src/host/host-language.mjs';
import {
  createHostLanguageRpcHandler,
  HOST_LANGUAGE_ENDPOINTS,
  validHostLanguagePayload,
} from '../plugin-src/host/host-language-rpc.mjs';

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'dsh-im-message-language-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function fixture(t, { language, settings } = {}) {
  const previous = getImHostLanguage();
  t.after(() => setImHostLanguage(previous));
  const home = await directory(t);
  const path = interfaceLanguageSettingsPath({ dshHome: home });
  const store = await new InterfaceLanguageStore(path).load();
  const controller = createHostLanguageController({
    store,
    config: language,
    readSettingsPreference: () => settings,
  });
  controller.apply();
  return { store, controller, path };
}

test('only auto and the three shipped dictionary languages are accepted', () => {
  assert.deepEqual([...MESSAGE_LANGUAGE_TAGS], ['zh', 'en', 'ru']);
  for (const [input, expected] of [['auto', 'auto'], [' ru ', 'ru'], ['zh', 'zh'], ['en', 'en']]) {
    assert.equal(normalizeMessageLanguageChoice(input), expected);
  }
  for (const value of [undefined, null, '', 'en-US', 'de', 42, {}]) {
    assert.equal(normalizeMessageLanguageChoice(value), null, String(value));
  }
});

test('an explicit selection outranks the DSH locale and can be cleared again', async (t) => {
  const { store, controller, path } = await fixture(t, { settings: 'en' });
  assert.deepEqual(controller.snapshot(), {
    language: 'en', tag: 'en', source: 'settings', pinned: false,
  });

  assert.deepEqual(await controller.select('ru'), {
    language: 'ru', tag: 'ru', source: 'explicit', pinned: false,
  });
  assert.equal(getImHostLanguage(), 'ru');
  assert.equal(store.getExplicitTag(), 'ru');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).explicitLanguage, 'ru');

  // Both selections live in one document: mirroring must not drop the choice.
  await controller.mirror('en-GB');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).explicitLanguage, 'ru');
  assert.equal(controller.snapshot().source, 'explicit');
  assert.equal(controller.snapshot().language, 'ru');

  assert.deepEqual(await controller.select(null), {
    language: 'en', tag: 'en', source: 'settings', pinned: false,
  });
  assert.equal(store.getExplicitTag(), null);
});

test('an operator-pinned language still wins, and the mirror stays the last resort', async (t) => {
  const pinned = await fixture(t, { language: 'zh', settings: 'en' });
  assert.deepEqual(await pinned.controller.select('ru'), {
    language: 'zh', tag: 'zh', source: 'config', pinned: true,
  });
  // The choice is still recorded, so it applies once the pin is removed.
  assert.equal(pinned.store.getExplicitTag(), 'ru');

  const mirrored = await fixture(t);
  assert.equal(mirrored.controller.snapshot().source, 'default');
  await mirrored.controller.mirror('ru-RU');
  assert.deepEqual(mirrored.controller.snapshot(), {
    language: 'ru', tag: 'ru-RU', source: 'mirror', pinned: false,
  });
});

test('the RPC validates and serves the language selection', async (t) => {
  const { controller } = await fixture(t, { settings: 'en' });
  const handler = createHostLanguageRpcHandler({ controller });

  assert.equal(validHostLanguagePayload(HOST_LANGUAGE_ENDPOINTS.set, { language: 'auto' }), true);
  assert.equal(validHostLanguagePayload(HOST_LANGUAGE_ENDPOINTS.set, { language: 'ru' }), true);
  for (const [endpoint, payload] of [
    [HOST_LANGUAGE_ENDPOINTS.set, {}],
    [HOST_LANGUAGE_ENDPOINTS.set, { language: 'en-US' }],
    [HOST_LANGUAGE_ENDPOINTS.set, { language: 'auto', extra: 1 }],
    [HOST_LANGUAGE_ENDPOINTS.set, { language: null }],
    [HOST_LANGUAGE_ENDPOINTS.set, { locale: 'ru' }],
  ]) {
    assert.equal(validHostLanguagePayload(endpoint, payload), false, JSON.stringify(payload));
    assert.equal((await handler(endpoint, payload)).error.code, 'bad-request');
  }

  assert.deepEqual(await handler(HOST_LANGUAGE_ENDPOINTS.set, { language: 'ru' }), {
    ok: true,
    value: { language: 'ru', tag: 'ru', source: 'explicit', pinned: false },
  });
  assert.equal(getImHostLanguage(), 'ru');
  assert.deepEqual(await handler(HOST_LANGUAGE_ENDPOINTS.get, {}), {
    ok: true,
    value: { language: 'ru', tag: 'ru', source: 'explicit', pinned: false },
  });
  assert.deepEqual(await handler(HOST_LANGUAGE_ENDPOINTS.set, { language: 'auto' }), {
    ok: true,
    value: { language: 'en', tag: 'en', source: 'settings', pinned: false },
  });

  const failing = createHostLanguageRpcHandler({
    controller: {
      apply: () => controller.apply(),
      snapshot: () => controller.snapshot(),
      mirror: async () => controller.apply(),
      select: async () => { throw new Error('private-disk-failure'); },
    },
  });
  const failure = await failing(HOST_LANGUAGE_ENDPOINTS.set, { language: 'ru' });
  assert.equal(failure.error.code, 'interface-language-unavailable');
  assert.doesNotMatch(JSON.stringify(failure), /private/);
});
