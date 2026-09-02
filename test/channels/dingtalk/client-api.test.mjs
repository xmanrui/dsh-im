import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DINGTALK_ENDPOINTS,
  DINGTALK_RPC_CHANNEL,
  connectionTestFeedback,
  formatRemaining,
  normalizeProvisioning,
  normalizeSnapshot,
  presentError,
  safeQrSource,
  unwrapRpcResult,
} from '../../../plugin-src/client/channels/dingtalk/api.js';

test('client exposes the fixed DingTalk RPC channel and endpoint names', () => {
  assert.equal(DINGTALK_RPC_CHANNEL, '/dingtalk');
  assert.deepEqual(DINGTALK_ENDPOINTS, {
    status: 'connection.status',
    beginProvisioning: 'provision.begin',
    pollProvisioning: 'provision.poll',
    cancelProvisioning: 'provision.cancel',
    bindCredentials: 'bot.bind-credentials',
    reconnectBot: 'bot.reconnect',
    deleteBot: 'bot.delete',
    setWorkspace: 'bot.workspace.set',
    setAgentPreset: 'bot.preset.set',
    setContextEnhancement: 'bot.context-enhancement.set',
    setInboundRetention: 'bot.inbound-retention.set',
    clearInboundAttachments: 'bot.inbound-attachments.clear',
    setAccessPolicy: 'bot.access-policy.set',
  });
});

test('RPC envelopes are required and sensitive error details are replaced', () => {
  assert.equal(unwrapRpcResult({ ok: true, value: { ready: true } }).ready, true);
  assert.throws(
    () => unwrapRpcResult({ value: {} }),
    /无法识别/,
  );
  assert.throws(
    () => unwrapRpcResult({
      ok: false,
      error: {
        code: 'clientSecret=should-not-escape',
        message: 'clientSecret=super-secret-value',
      },
    }),
    (error) => error.code === 'DINGTALK_RPC_ERROR'
      && error.message === '钉钉操作失败'
      && !error.message.includes('super-secret-value'),
  );
});

test('QR images accept only bounded base64 PNG or WebP data URLs', () => {
  assert.equal(safeQrSource('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(safeQrSource('data:image/webp;base64,AAAA'), 'data:image/webp;base64,AAAA');
  assert.equal(safeQrSource('data:image/svg+xml;base64,AAAA'), undefined);
  assert.equal(safeQrSource('data:image/png;base64,AAAA\n<script>'), undefined);
  assert.equal(safeQrSource('javascript:alert(1)'), undefined);
});

test('provisioning keeps only the browser-safe attempt projection', () => {
  const now = 1_000;
  const value = normalizeProvisioning({
    attemptId: 'attempt-safe',
    status: 'pending',
    expiresIn: 90,
    pollIntervalMs: 10,
    qrCodeDataUrl: 'data:image/png;base64,AAAA',
    verificationUrl: 'https://login.dingtalk.com/device',
    deviceCode: 'raw-device-code',
    clientSecret: 'raw-client-secret',
    secretRef: 'credential-ref',
  }, now);
  assert.deepEqual(value, {
    attemptId: 'attempt-safe',
    status: 'pending',
    expiresAt: 91_000,
    pollIntervalMs: 1_000,
    qrCodeDataUrl: 'data:image/png;base64,AAAA',
  });
  assert.equal(normalizeProvisioning({ attemptId: 'safe', status: 'unknown' }, now).status, 'failed');
  assert.doesNotMatch(JSON.stringify(value), /raw-device|raw-client|credential-ref/);
});

test('snapshot derives totals and exposes only browser-safe bot state', () => {
  const snapshot = normalizeSnapshot({
    schemaVersion: 1,
    revision: 7,
    totals: { configured: 99, connected: 99 },
    testMessage: {
      sent: false,
      code: 'test-target-unavailable',
      providerDetail: 'must-not-cross-normalization',
    },
    bots: [{
      botId: 'bot-safe',
      connected: true,
      state: 'offline',
      bot: {
        name: '研发助手',
        clientIdMasked: 'ding••••6f2a',
        clientId: 'raw-client-id',
        clientSecret: 'raw-client-secret',
      },
      secretRef: 'credential-ref',
      deviceCode: 'device-code',
      health: { status: 'healthy', summary: '连接正常', lastCheckedAt: 123 },
      stats: { messagesReceived: 8, messagesReplied: 6 },
      senders: { pending: [{ senderId: 'raw-staff-id' }] },
    }],
  });

  assert.deepEqual(snapshot.totals, { configured: 1, connected: 1 });
  assert.equal(snapshot.bots[0].state, 'connected');
  assert.equal('senders' in snapshot.bots[0], false);
  assert.deepEqual(snapshot.testMessage, {
    sent: false, code: 'test-target-unavailable',
  });
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /raw-client-id|raw-client-secret|credential-ref|device-code|raw-staff-id/,
  );
});

test('connection-test feedback uses fixed client-owned messages', () => {
  assert.equal(
    connectionTestFeedback({ sent: true }),
    '钉钉连接检查完成，测试消息已发送。',
  );
  assert.equal(
    connectionTestFeedback({ sent: false, code: 'test-target-unavailable' }),
    '连接检查完成。机器人尚未收到可用于测试的私聊消息。',
  );
  assert.equal(
    connectionTestFeedback({ sent: false, code: 'test-message-failed' }),
    '钉钉连接检查完成，但测试消息发送失败。',
  );
  assert.equal(connectionTestFeedback(null), null);
});

test('presentation helpers redact sensitive messages and format countdowns', () => {
  assert.deepEqual(
    presentError({ code: 'UPSTREAM_FAILED', message: 'accessToken: visible-value' }),
    { code: 'UPSTREAM_FAILED', message: '钉钉操作失败，请稍后重试' },
  );
  assert.equal(formatRemaining(61_000), '01:01');
  assert.equal(formatRemaining(-1), '00:00');
});
