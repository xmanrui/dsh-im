import assert from 'node:assert/strict';
import test from 'node:test';

import { Agent, ProxyAgent } from 'undici';

import {
  createChannelHttp,
  createProxyDispatcher,
  createProxyFetch,
  describeProxy,
  hasEnvProxy,
  parseProxySpec,
  resolveChannelProxy,
  SUPPORTED_PROXY_SCHEMES,
} from '../../../src/channels/shared/proxy.mjs';

test('a URL string becomes a spec, credentials included', () => {
  const spec = parseProxySpec('http://user:p%40ss@proxy.example:3128');
  assert.deepEqual({ ...spec }, {
    protocol: 'http',
    host: 'proxy.example',
    port: 3128,
    username: 'user',
    password: 'p@ss',
  });
});

test('a bare host:port is read as socks5h, which resolves names on the proxy', () => {
  const spec = parseProxySpec('proxy.example:1080');
  assert.equal(spec.protocol, 'socks5h');
  assert.equal(spec.port, 1080);
});

test('socks5 and socks5h stay different', () => {
  assert.equal(parseProxySpec('socks5://p:1080').protocol, 'socks5');
  assert.equal(parseProxySpec('socks5h://p:1080').protocol, 'socks5h');
  assert.equal(parseProxySpec('socks://p:1080').protocol, 'socks5h');
});

test('the object form carries the same fields and defaults the scheme', () => {
  const spec = parseProxySpec({ host: '10.0.0.1', port: 1080, username: 'u', password: 'p' });
  assert.equal(spec.protocol, 'socks5h');
  assert.equal(spec.host, '10.0.0.1');
  assert.equal(spec.username, 'u');
  assert.equal(parseProxySpec({ host: '10.0.0.1', protocol: 'http' }).port, 8080);
});

test('absent and refused proxies are null, not an error', () => {
  for (const value of [null, undefined, false, '', '   ', { disabled: true }]) {
    assert.equal(parseProxySpec(value), null, `expected null for ${JSON.stringify(value)}`);
  }
});

test('an unusable proxy says what to fix', () => {
  assert.throws(() => parseProxySpec('ftp://proxy:21'), /unsupported proxy scheme "ftp"/);
  assert.throws(() => parseProxySpec({ port: 1080 }), /proxy\.host is required/);
  assert.throws(() => parseProxySpec({ host: 'p', port: 0 }), /proxy port must be an integer/);
  assert.ok(SUPPORTED_PROXY_SCHEMES.includes('socks5h'));
});

test('diagnostics name the proxy without leaking the password', () => {
  const spec = parseProxySpec('http://user:secret@proxy.example:3128');
  assert.equal(describeProxy(spec), 'http://proxy.example:3128');
  assert.equal(describeProxy(null), 'none');
});

test('http proxies use undici ProxyAgent, socks uses the custom connector', () => {
  const http = createProxyDispatcher(parseProxySpec('http://proxy.example:3128'));
  const socks = createProxyDispatcher(parseProxySpec('socks5h://proxy.example:1080'));
  try {
    assert.ok(http instanceof ProxyAgent);
    assert.ok(socks instanceof Agent);
    assert.equal(typeof socks.connect, 'function');
  } finally {
    http.destroy();
    socks.destroy();
  }
});

test('the dispatcher reaches the fetch it wraps', async () => {
  const seen = [];
  const baseFetch = async (url, options) => {
    seen.push({ url, dispatcher: options.dispatcher });
    return { ok: true };
  };
  const spec = parseProxySpec('socks5h://proxy.example:1080');
  const proxy = createProxyFetch(spec, { baseFetch });
  try {
    await proxy.fetchImpl('https://api.telegram.org/bot');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].dispatcher, proxy.dispatcher);
    assert.equal(proxy.label, 'socks5h://proxy.example:1080');
  } finally {
    await proxy.destroy();
  }
});

test('a channel switch beats the plugin proxy, and env is the last resort', () => {
  const plugin = { proxy: 'http://proxy.example:3128' };
  const off = resolveChannelProxy({ proxy: plugin.proxy, override: false, channelId: 'email' });
  assert.equal(off.spec, null);
  assert.equal(off.source, 'channel-off');

  const own = resolveChannelProxy({ proxy: plugin.proxy, override: 'socks5h://own:1080', channelId: 'discord' });
  assert.equal(own.source, 'channel');
  assert.equal(own.spec.host, 'own');

  const shared = resolveChannelProxy({ proxy: plugin.proxy, channelId: 'telegram' });
  assert.equal(shared.source, 'plugin');
  assert.equal(shared.spec.port, 3128);

  const fromEnv = resolveChannelProxy({ proxy: null, env: { HTTPS_PROXY: 'http://env:3128' } });
  assert.equal(fromEnv.source, 'env');
  assert.equal(fromEnv.spec, null, 'env proxies stay undici business');

  const none = resolveChannelProxy({ proxy: null, env: {} });
  assert.equal(none.source, 'none');
  assert.equal(hasEnvProxy({ http_proxy: 'http://x:3128' }), true);
  assert.equal(hasEnvProxy({}), false);
});

test('a channel without a proxy keeps plain fetch and destroys quietly', async () => {
  const http = createChannelHttp({ spec: null, useEnv: false });
  assert.equal(http.proxy, 'none');
  await http.destroy();
  assert.equal(typeof http.fetchImpl, 'function');

  const proxied = createChannelHttp({ spec: parseProxySpec('http://proxy.example:3128'), useEnv: false });
  assert.equal(proxied.proxy, 'http://proxy.example:3128');
  await proxied.destroy();
});
