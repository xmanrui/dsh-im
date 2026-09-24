import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeProvisioning,
  normalizeSnapshot,
  safeQrSource,
  safeVerificationUrl,
  unwrapRpcResult,
} from '../plugin-src/client/channels/weixin/api.js';

test('client normalizes the exact redacted Host account view', () => {
  const snapshot = normalizeSnapshot({
    schemaVersion: 1,
    revision: 5,
    bots: [{
      botId: 'wx_safe',
      state: 'connected',
      connected: true,
      configured: true,
      bot: { name: '微信机器人', accountIdMasked: 'abc••••bot' },
      health: { status: 'healthy', summary: '正常', lastCheckedAt: 123 },
      stats: { messagesReceived: 3, messagesReplied: 2 },
      token: 'host-secret-that-must-be-dropped',
    }],
  });
  assert.equal(snapshot.totals.connected, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /host-secret|token/);
});

test('client accepts only image data URLs and Tencent Weixin or WeChat HTTPS links', () => {
  assert.match(safeQrSource('data:image/png;base64,AAAA'), /^data:image/);
  assert.equal(safeQrSource('javascript:alert(1)'), undefined);
  assert.equal(safeVerificationUrl('https://liteapp.weixin.qq.com/q/test'), 'https://liteapp.weixin.qq.com/q/test');
  assert.equal(safeVerificationUrl('https://liteapp.wechat.com/q/test'), 'https://liteapp.wechat.com/q/test');
  assert.equal(safeVerificationUrl('https://attacker.test/q/test'), undefined);
  assert.equal(safeVerificationUrl('https://liteapp.wechat.com.attacker.test/q/test'), undefined);
});

test('client preserves verification-required provisioning without accepting unknown states', () => {
  const value = normalizeProvisioning({
    attemptId: 'attempt',
    status: 'needs_verification',
    expiresAt: Date.now() + 1000,
    verificationRequired: true,
  });
  assert.equal(value.status, 'needs_verification');
  assert.equal(value.verificationRequired, true);
  assert.equal(normalizeProvisioning({ attemptId: 'attempt', status: 'mystery' }).status, 'failed');
});

test('RPC errors are surfaced with their safe code', () => {
  assert.throws(
    () => unwrapRpcResult({ ok: false, error: { code: 'safe-code', message: '安全消息' } }),
    (error) => error.code === 'safe-code' && error.message === '安全消息',
  );
});
