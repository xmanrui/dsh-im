import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyProxySettingsPatch,
  DEFAULT_PROXY_SETTINGS,
  normalizeProxySettings,
  proxySettingsPatchKeys,
  proxySettingsProblem,
  proxySettingsToSpec,
} from '../../../src/channels/shared/proxy-settings.mjs';
import { ProxySettingsStore } from '../../../src/channels/shared/proxy-settings-store.mjs';
import { resolveProxyForChannel } from '../../../src/channels/shared/proxy.mjs';

test('the default document describes no proxy', () => {
  assert.equal(DEFAULT_PROXY_SETTINGS.enabled, false);
  assert.equal(proxySettingsToSpec(DEFAULT_PROXY_SETTINGS), null);
  assert.equal(proxySettingsProblem(DEFAULT_PROXY_SETTINGS), null);
});

test('an enabled document becomes a spec of the chosen type', () => {
  const settings = normalizeProxySettings({
    enabled: true, type: 'socks5', host: ' proxy.example ', port: '1080',
  });
  const spec = proxySettingsToSpec(settings);
  assert.equal(settings.host, 'proxy.example');
  assert.equal(spec.protocol, 'socks5');
  assert.equal(spec.port, 1080);
  assert.equal(spec.username, null);
});

test('anonymous drops the credentials, unticking keeps them for later', () => {
  const withLogin = normalizeProxySettings({
    enabled: true, type: 'http', host: 'p', port: '3128',
    anonymous: false, username: 'user', password: 'secret',
  });
  const spec = proxySettingsToSpec(withLogin);
  assert.equal(spec.username, 'user');
  assert.equal(spec.password, 'secret');

  const anonymous = normalizeProxySettings({ ...withLogin, anonymous: true });
  assert.equal(anonymous.username, 'user', 'the login survives the checkbox');
  assert.equal(proxySettingsToSpec(anonymous).username, null);
});

test('enabled without a host is half-typed form, not a proxy', () => {
  const settings = normalizeProxySettings({ enabled: true, type: 'http', host: '' });
  assert.equal(proxySettingsToSpec(settings), null);
  assert.equal(proxySettingsProblem(settings), 'host-required');
  assert.equal(
    proxySettingsProblem(normalizeProxySettings({ enabled: true, host: 'p', anonymous: false })),
    'username-required',
  );
});

test('a port outside the range is dropped instead of breaking the save', () => {
  assert.equal(normalizeProxySettings({ port: '70000' }).port, '');
  assert.equal(normalizeProxySettings({ port: 'abc' }).port, '');
  assert.equal(normalizeProxySettings({ port: '' }).port, '');
  assert.equal(normalizeProxySettings({ port: 1080 }).port, '1080');
});

test('a patch may only carry known fields, and unknown ones are refused', () => {
  assert.deepEqual(proxySettingsPatchKeys({ host: 'p', port: '1' }), ['host', 'port']);
  assert.equal(proxySettingsPatchKeys({ host: 'p', password2: 'x' }), null);
  assert.equal(proxySettingsPatchKeys(null), null);

  const merged = applyProxySettingsPatch({ enabled: true, host: 'old' }, { host: 'new' });
  assert.equal(merged.enabled, true);
  assert.equal(merged.host, 'new');
});

test('the store writes a 0600 document and reads it back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-settings-'));
  const path = join(dir, 'proxy-settings.json');
  const store = new ProxySettingsStore(path);

  assert.deepEqual(await store.get(), { ...DEFAULT_PROXY_SETTINGS });
  await store.set({ enabled: true, type: 'socks5h', host: 'proxy.example', port: '1080' });
  assert.equal((await store.get()).host, 'proxy.example');

  const document = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(document.version, 1);
  assert.equal(document.proxy.enabled, true);

  // A damaged document falls back to the defaults rather than failing the load.
  await writeFile(path, '{ not json');
  const damaged = new ProxySettingsStore(path);
  assert.equal((await damaged.get()).enabled, false);
});

test('the channel switch beats the dashboard, the dashboard beats the config file', () => {
  const spec = { protocol: 'http', host: 'settings', port: 3128, username: null, password: null };
  assert.equal(resolveProxyForChannel({ settingsSpec: spec, override: false }).source, 'channel-off');
  assert.equal(resolveProxyForChannel({ settingsSpec: spec, override: 'socks5h://own:1080' }).spec.host, 'own');
  assert.equal(resolveProxyForChannel({ settingsSpec: spec, configProxy: 'http://file:3128' }).spec.host, 'settings');
  assert.equal(resolveProxyForChannel({ settingsSpec: null, configProxy: 'http://file:3128' }).spec.host, 'file');
  assert.equal(resolveProxyForChannel({ env: { HTTPS_PROXY: 'http://env:3128' } }).source, 'env');
  assert.equal(resolveProxyForChannel({}).source, 'none');
});

test('a broken config value is reported, and the channel runs direct', () => {
  const result = resolveProxyForChannel({ configProxy: 'ftp://nope:21' });
  assert.equal(result.source, 'config-invalid');
  assert.equal(result.spec, null);
  assert.match(result.error, /unsupported proxy scheme/);
});
