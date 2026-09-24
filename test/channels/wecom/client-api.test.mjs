import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeProvisioning,
  normalizeSnapshot,
  safeQrSource,
} from '../../../plugin-src/client/channels/wecom/api.js';

test('Enterprise WeChat client keeps only redacted bot and Host-rendered QR state', () => {
  const qr = 'data:image/png;base64,YWJjZA==';
  assert.equal(safeQrSource(qr), qr);
  const provision = normalizeProvisioning({
    attemptId: 'attempt_1', status: 'pending', expiresAt: Date.now() + 1_000, qrCodeDataUrl: qr,
  });
  assert.equal(provision.qrCodeDataUrl, qr);
  const snapshot = normalizeSnapshot({
    testMessage: { sent: false, code: 'test-target-unavailable', ignored: 'secret' },
    bots: [{
      botId: 'wecom_abc', connected: true, state: 'connected',
      bot: { name: '企业微信机器人', appIdMasked: 'bot••••001' },
      health: { summary: '运行正常' },
    }],
  });
  assert.equal(snapshot.totals.connected, 1);
  assert.equal(snapshot.bots[0].bot.appIdMasked, 'bot••••001');
  assert.deepEqual(snapshot.testMessage, {
    sent: false, code: 'test-target-unavailable',
  });
});
