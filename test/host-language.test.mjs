import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';

import { getImHostLanguage, setImHostLanguage } from '../src/channels/shared/i18n.mjs';
import {
  HOST_LANGUAGE_SOURCES,
  normalizeInterfaceLanguageTag,
  resolveHostLanguageTag,
} from '../src/channels/shared/interface-language.mjs';
import { InterfaceLanguageStore } from '../src/channels/shared/interface-language-store.mjs';
import {
  DSH_LOCALE_NAMESPACE,
  DSH_LOCALE_PREFERENCE_FIELD,
  createHostLanguageController,
  installHostLanguage,
  interfaceLanguageSettingsPath,
} from '../plugin-src/host/host-language.mjs';
import {
  HOST_LANGUAGE_ENDPOINTS,
  HOST_LANGUAGE_RPC_CHANNEL,
  createHostLanguageRpcHandler,
  validHostLanguagePayload,
} from '../plugin-src/host/host-language-rpc.mjs';

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'dsh-im-language-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function restoreLanguage(t) {
  const previous = getImHostLanguage();
  t.after(() => setImHostLanguage(previous));
}

test('normalizeInterfaceLanguageTag keeps BCP 47-style tags and rejects everything else', () => {
  for (const [input, expected] of [
    ['en', 'en'], [' en-US ', 'en-US'], ['zh-CN', 'zh-CN'], ['english', 'english'],
  ]) {
    assert.equal(normalizeInterfaceLanguageTag(input), expected);
  }
  for (const value of [undefined, null, '', '   ', 'e', 'en_US', 'en US', 'toolongtag', 42, {}, ['en']]) {
    assert.equal(normalizeInterfaceLanguageTag(value), null, `expected ${String(value)} to be rejected`);
  }
});

test('resolveHostLanguageTag prefers the plugin config, then DSH settings, then the mirror', () => {
  assert.deepEqual(HOST_LANGUAGE_SOURCES, ['config', 'settings', 'mirror']);
  assert.deepEqual(
    resolveHostLanguageTag({ config: 'zh-CN', settings: 'en', mirror: 'en' }),
    { tag: 'zh-CN', source: 'config' },
  );
  assert.deepEqual(
    resolveHostLanguageTag({ settings: 'en', mirror: 'zh' }),
    { tag: 'en', source: 'settings' },
  );
  assert.deepEqual(
    resolveHostLanguageTag({ mirror: 'en-GB' }),
    { tag: 'en-GB', source: 'mirror' },
  );
  // Blank and malformed layers are skipped rather than winning as an override.
  assert.deepEqual(
    resolveHostLanguageTag({ config: '  ', settings: 'en_US', mirror: 'en' }),
    { tag: 'en', source: 'mirror' },
  );
  assert.deepEqual(resolveHostLanguageTag(), { tag: null, source: 'default' });
  assert.deepEqual(resolveHostLanguageTag({}), { tag: null, source: 'default' });
});

test('InterfaceLanguageStore persists the mirrored tag and survives a damaged document', async (t) => {
  const home = await directory(t);
  const path = interfaceLanguageSettingsPath({ dshHome: home });
  assert.equal(path, join(home, 'integrations', 'dsh-im', 'interface-language.json'));

  const store = await new InterfaceLanguageStore(path).load();
  assert.equal(store.getLanguageTag(), null, 'a first run has nothing mirrored yet');

  assert.equal(await store.setLanguageTag(' en-US '), 'en-US');
  assert.equal(store.getLanguageTag(), 'en-US');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    version: 1,
    interfaceLanguage: 'en-US',
  });
  assert.equal((await new InterfaceLanguageStore(path).load()).getLanguageTag(), 'en-US');

  // The settings page reports its locale on every mount, so an unchanged
  // value must not rewrite the document.
  const stamp = (await stat(path)).mtimeMs;
  assert.equal(await store.setLanguageTag('en-US'), 'en-US');
  assert.equal((await stat(path)).mtimeMs, stamp, 'an unchanged mirror is not rewritten');

  assert.equal(await store.setLanguageTag(null), null, 'a cleared mirror returns to the lower layers');
  assert.equal((await new InterfaceLanguageStore(path).load()).getLanguageTag(), null);
  const cleared = (await stat(path)).mtimeMs;
  assert.equal(await store.setLanguageTag(null), null);
  assert.equal((await stat(path)).mtimeMs, cleared, 'clearing an empty mirror is not rewritten');
  await assert.rejects(() => store.setLanguageTag('en_US'), (error) => {
    assert.equal(error.code, 'interface-language-invalid');
    return true;
  });

  // A damaged or future document must never be guessed at: an unreadable
  // mirror falls back to the layers below it instead of pinning a language.
  for (const contents of ['{not json', '[]', '{"version":999,"interfaceLanguage":"en"}', '{"version":1,"interfaceLanguage":"en_US"}']) {
    await writeFile(path, contents);
    assert.equal((await new InterfaceLanguageStore(path).load()).getLanguageTag(), null, contents);
  }
  assert.throws(() => new InterfaceLanguageStore(''), TypeError);
});

test('the controller applies the winning layer and never lets the mirror beat an explicit selection', async (t) => {
  restoreLanguage(t);
  const home = await directory(t);
  const store = await new InterfaceLanguageStore(interfaceLanguageSettingsPath({ dshHome: home })).load();
  let preference;
  const controller = createHostLanguageController({
    store,
    readSettingsPreference: () => preference,
  });

  setImHostLanguage('zh');
  assert.deepEqual(controller.apply(), { language: 'zh', tag: null, source: 'default', pinned: false });

  // A browser-derived interface locale reaches the Host only through the mirror.
  await controller.mirror('en');
  assert.equal(getImHostLanguage(), 'en');
  assert.deepEqual(controller.snapshot(), { language: 'en', tag: 'en', source: 'mirror', pinned: false });

  // An explicit DSH Language selection outranks the mirrored browser locale.
  preference = 'zh';
  assert.deepEqual(controller.apply(), { language: 'zh', tag: 'zh', source: 'settings', pinned: false });
  assert.equal(store.getLanguageTag(), 'en', 'the mirror is kept for when the selection is cleared');
  preference = undefined;
  assert.equal(controller.apply().language, 'en');

  // A subscriber sees exactly the committed switches, not every apply().
  const seen = [];
  const stop = controller.observe((next) => seen.push(next));
  preference = 'zh-CN';
  controller.apply();
  controller.apply();
  preference = 'en-GB';
  controller.apply();
  stop();
  preference = 'zh';
  controller.apply();
  assert.deepEqual(seen, ['zh', 'en']);
});

test('the controller keeps the operator pin authoritative and contains a failing preference read', async (t) => {
  restoreLanguage(t);
  const home = await directory(t);
  const store = await new InterfaceLanguageStore(interfaceLanguageSettingsPath({ dshHome: home })).load();
  const warnings = [];
  const controller = createHostLanguageController({
    store,
    config: 'en',
    readSettingsPreference: () => { throw new Error('settings service detached'); },
    logger: { warn: (...args) => warnings.push(args) },
  });
  assert.deepEqual(controller.apply(), { language: 'en', tag: 'en', source: 'config', pinned: true });
  await controller.mirror('zh');
  assert.equal(getImHostLanguage(), 'en', 'a pinned language ignores the lower layers');
  assert.deepEqual(controller.snapshot(), { language: 'en', tag: 'en', source: 'config', pinned: true });
  assert.equal(warnings.length, 0, 'a pinned language never consults the settings service');

  const unpinned = createHostLanguageController({
    store,
    readSettingsPreference: () => { throw new Error('settings service detached'); },
    logger: { warn: (...args) => warnings.push(args) },
  });
  assert.equal(unpinned.apply().source, 'mirror');
  assert.equal(getImHostLanguage(), 'zh');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /interface language/i);
});

test('installHostLanguage follows the DSH locale preference live and tolerates an absent settings service', async (t) => {
  restoreLanguage(t);
  const home = await directory(t);
  setImHostLanguage('zh');

  const bare = new Context();
  const withoutSettings = installHostLanguage(bare, { dshHome: home });
  await withoutSettings.ready;
  assert.equal(getImHostLanguage(), 'zh');
  await withoutSettings.mirror('en');
  assert.equal(getImHostLanguage(), 'en', 'the mirror still works without a settings provider');

  const ctx = new Context();
  let section = { [DSH_LOCALE_PREFERENCE_FIELD]: 'zh' };
  ctx.provide('settings', {
    get: (namespace) => (namespace === DSH_LOCALE_NAMESPACE ? section : undefined),
  });
  let language;
  let atInstall;
  const fiber = ctx.plugin({
    apply: (pluginCtx) => {
      language = installHostLanguage(pluginCtx, { dshHome: home });
      // Channels start inside this same activation, so an already-attached
      // settings service has to be read synchronously; waiting for the
      // injection callback would let the first bot register its command menu
      // in the previous language and then need a second push.
      atInstall = language.snapshot();
    },
  });
  await fiber.await();
  assert.deepEqual(atInstall, { language: 'zh', tag: 'zh', source: 'settings', pinned: false });
  await language.ready;
  assert.equal(getImHostLanguage(), 'zh', 'an explicit Chinese selection outranks the English mirror');

  section = { [DSH_LOCALE_PREFERENCE_FIELD]: 'en' };
  ctx.emit('settings/updated', DSH_LOCALE_NAMESPACE, section, {}, 'update');
  await new Promise(setImmediate);
  assert.equal(getImHostLanguage(), 'en', 'switching the DSH interface language switches the bot language');

  section = { [DSH_LOCALE_PREFERENCE_FIELD]: 'zh' };
  ctx.emit('settings/updated', 'llm-deepseek', {}, {}, 'update');
  await new Promise(setImmediate);
  assert.equal(getImHostLanguage(), 'en', 'an unrelated namespace must not re-resolve the language');

  ctx.emit('settings/updated', DSH_LOCALE_NAMESPACE, section, {}, 'update');
  await new Promise(setImmediate);
  assert.equal(getImHostLanguage(), 'zh');

  // Clearing the explicit selection returns to the mirrored interface locale.
  section = {};
  ctx.emit('settings/updated', DSH_LOCALE_NAMESPACE, section, {}, 'update');
  await new Promise(setImmediate);
  assert.equal(getImHostLanguage(), 'en');

  // Unloading the plugin releases the watcher instead of leaking it.
  await fiber.dispose();
  section = { [DSH_LOCALE_PREFERENCE_FIELD]: 'zh' };
  ctx.emit('settings/updated', DSH_LOCALE_NAMESPACE, section, {}, 'update');
  await new Promise(setImmediate);
  assert.equal(getImHostLanguage(), 'en');
});

test('the language RPC reports the resolved snapshot and mirrors the interface locale', async (t) => {
  restoreLanguage(t);
  const home = await directory(t);
  setImHostLanguage('zh');
  const store = await new InterfaceLanguageStore(interfaceLanguageSettingsPath({ dshHome: home })).load();
  const controller = createHostLanguageController({ store });
  const handler = createHostLanguageRpcHandler({ controller });

  assert.equal(HOST_LANGUAGE_RPC_CHANNEL, '/dsh-im-language');
  assert.deepEqual(HOST_LANGUAGE_ENDPOINTS, {
    get: 'settings.language.get',
    mirror: 'settings.language.mirror',
  });

  assert.deepEqual(await handler(HOST_LANGUAGE_ENDPOINTS.get, {}), {
    ok: true,
    value: { language: 'zh', tag: null, source: 'default', pinned: false },
  });
  assert.deepEqual(await handler(HOST_LANGUAGE_ENDPOINTS.mirror, { locale: 'en-US' }), {
    ok: true,
    value: { language: 'en', tag: 'en-US', source: 'mirror', pinned: false },
  });
  assert.equal(getImHostLanguage(), 'en');
  assert.equal(store.getLanguageTag(), 'en-US');
  assert.deepEqual(await handler(HOST_LANGUAGE_ENDPOINTS.mirror, { locale: null }), {
    ok: true,
    value: { language: 'zh', tag: null, source: 'default', pinned: false },
  });

  for (const [endpoint, payload] of [
    ['settings.language.unknown', {}],
    [HOST_LANGUAGE_ENDPOINTS.get, { locale: 'en' }],
    [HOST_LANGUAGE_ENDPOINTS.mirror, {}],
    [HOST_LANGUAGE_ENDPOINTS.mirror, { locale: 'en_US' }],
    [HOST_LANGUAGE_ENDPOINTS.mirror, { locale: 'en', extra: 1 }],
    [HOST_LANGUAGE_ENDPOINTS.mirror, null],
    [HOST_LANGUAGE_ENDPOINTS.mirror, []],
  ]) {
    assert.equal(validHostLanguagePayload(endpoint, payload), false, `${endpoint} ${JSON.stringify(payload)}`);
    assert.equal((await handler(endpoint, payload)).error.code, 'bad-request');
  }
  assert.equal((await handler(HOST_LANGUAGE_ENDPOINTS.get, {}, AbortSignal.abort())).error.code, 'cancelled');

  const failing = createHostLanguageRpcHandler({
    controller: {
      apply: () => controller.apply(),
      snapshot: () => controller.snapshot(),
      mirror: async () => { throw new Error('private-disk-failure'); },
    },
  });
  const failure = await failing(HOST_LANGUAGE_ENDPOINTS.mirror, { locale: 'en' });
  assert.equal(failure.error.code, 'interface-language-unavailable');
  assert.doesNotMatch(JSON.stringify(failure), /private/);
  assert.throws(() => createHostLanguageRpcHandler({}), TypeError);
});
