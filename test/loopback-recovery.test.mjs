import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { LoopbackRecoveryNotice } from '../plugin-src/client/index.js';
import {
  createLoopbackAwareRpcCall,
  createLoopbackAwareRpcCalls,
  createLoopbackRecovery,
  LOOPBACK_RECOVERY_ERROR_CODE,
  LOOPBACK_RECOVERY_ERROR_MESSAGE,
  replacePageLocation,
} from '../plugin-src/client/loopback-recovery.js';

const WEIXIN_FORBIDDEN = new Error(
  'transport failure for /weixin/connection.status: HTTP 403',
);

test('creates a localhost recovery target for the known loopback transport 403', () => {
  const recovery = createLoopbackRecovery(WEIXIN_FORBIDDEN, {
    href: 'http://127.0.0.1:3080/settings',
  });

  assert.deepEqual(recovery, {
    url: 'http://localhost:3080/settings',
    origin: 'http://localhost:3080',
  });
  assert.deepEqual(createLoopbackRecovery(WEIXIN_FORBIDDEN, {
    href: 'http://127.8.9.10:4111/',
  }), {
    url: 'http://localhost:4111/',
    origin: 'http://localhost:4111',
  });
});

test('does not reinterpret unrelated 403s, protocols, or hosts', () => {
  const cases = [
    [new Error('transport failure for /weixin/connection.status: HTTP 404'), 'http://127.0.0.1:3080/'],
    [new Error('request failed: HTTP 403'), 'http://127.0.0.1:3080/'],
    [WEIXIN_FORBIDDEN, 'http://localhost:3080/'],
    [WEIXIN_FORBIDDEN, 'http://192.168.1.20:3080/'],
    [WEIXIN_FORBIDDEN, 'https://127.0.0.1:3080/'],
    [WEIXIN_FORBIDDEN, 'not a URL'],
  ];

  for (const [error, href] of cases) {
    assert.equal(createLoopbackRecovery(error, { href }), null);
  }
});

test('RPC wrapper reports the recovery and presents a safe actionable error', async () => {
  const original = new Error(
    'transport failure for /whatsapp/connection.status: HTTP 403',
  );
  let observed;
  const rpcCall = createLoopbackAwareRpcCall(async () => {
    throw original;
  }, {
    location: { href: 'http://127.0.0.1:3080/settings' },
    onRecovery: (recovery) => { observed = recovery; },
  });

  await assert.rejects(rpcCall('connection.status', {}), (error) => {
    assert.equal(error.code, LOOPBACK_RECOVERY_ERROR_CODE);
    assert.equal(error.message, LOOPBACK_RECOVERY_ERROR_MESSAGE);
    assert.equal(error.cause, original);
    assert.equal(error.recoveryUrl, 'http://localhost:3080/settings');
    return true;
  });
  assert.deepEqual(observed, {
    url: 'http://localhost:3080/settings',
    origin: 'http://localhost:3080',
  });
});

test('RPC wrappers preserve successful results, unrelated errors, and missing optional calls', async () => {
  const result = { ok: true, value: { connected: true } };
  const successful = createLoopbackAwareRpcCall(async (...args) => ({ result, args }), {
    location: { href: 'http://127.0.0.1:3080/' },
  });
  assert.deepEqual(await successful('connection.status', { botId: 'bot-1' }), {
    result,
    args: ['connection.status', { botId: 'bot-1' }],
  });

  const original = new Error('transport failure for /weixin/connection.status: HTTP 500');
  const failing = createLoopbackAwareRpcCall(async () => { throw original; }, {
    location: { href: 'http://127.0.0.1:3080/' },
  });
  await assert.rejects(failing(), (error) => error === original);

  const calls = createLoopbackAwareRpcCalls({
    weixinRpcCall: async () => result,
    optionalRpcCall: undefined,
  }, {
    location: { href: 'http://127.0.0.1:3080/' },
  });
  assert.equal(calls.optionalRpcCall, undefined);
  assert.equal(await calls.weixinRpcCall(), result);
});

test('recovery notice exposes one localized navigation action', () => {
  const recovery = {
    url: 'http://localhost:3080/settings',
    origin: 'http://localhost:3080',
  };
  const element = LoopbackRecoveryNotice({ recovery, onNavigate() {} });
  const markup = renderToStaticMarkup(element);

  assert.match(markup, /role="alert"/);
  assert.match(markup, /请改用 localhost 重新打开/);
  assert.match(markup, /http:\/\/localhost:3080/);
  assert.match(markup, /<button[^>]*>使用 localhost 重新打开<\/button>/);
});

test('recovery navigation replaces the current history entry', () => {
  let replacedWith;
  replacePageLocation('http://localhost:3080/settings', {
    replace(url) { replacedWith = url; },
  });
  assert.equal(replacedWith, 'http://localhost:3080/settings');
});
