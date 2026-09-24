import assert from 'node:assert/strict';
import test from 'node:test';

import {
  connectionTestFeedback,
  normalizeProvisioning,
  normalizeSnapshot,
  safeQrSource,
} from '../../../plugin-src/client/channels/qq/api.js';

test('QQ client keeps only redacted bot and host-rendered QR state', () => {
  const qr = 'data:image/png;base64,YWJjZA==';
  assert.equal(safeQrSource(qr), qr);
  const provision = normalizeProvisioning({
    attemptId: 'attempt_1', status: 'pending', expiresAt: Date.now() + 1_000, qrCodeDataUrl: qr,
  });
  assert.equal(provision.qrCodeDataUrl, qr);
  const snapshot = normalizeSnapshot({
    bots: [{
      botId: 'qq_abc', connected: true, state: 'connected',
      bot: { name: 'QQ机器人', appIdMasked: '123••••456' },
      health: { summary: '运行正常' },
    }],
  });
  assert.equal(snapshot.totals.connected, 1);
  assert.equal(snapshot.bots[0].bot.appIdMasked, '123••••456');
});

test('QQ client normalizes and presents connection-test outcomes', () => {
  const sent = normalizeSnapshot({ bots: [], testMessage: { sent: true, code: 'ignored' } });
  assert.deepEqual(sent.testMessage, { sent: true });
  assert.equal(
    connectionTestFeedback(sent.testMessage),
    '测试消息已发送，请到对应机器人会话中确认。',
  );

  const unavailable = normalizeSnapshot({
    bots: [], testMessage: { sent: false, code: 'test-target-unavailable' },
  });
  assert.deepEqual(unavailable.testMessage, {
    sent: false, code: 'test-target-unavailable',
  });
  assert.equal(
    connectionTestFeedback(unavailable.testMessage),
    '连接检查完成。机器人尚未收到可用于测试的私聊消息。',
  );

  const invalid = normalizeSnapshot({
    bots: [], testMessage: { sent: false, code: 'private-provider-error' },
  });
  assert.deepEqual(invalid.testMessage, { sent: false, code: 'test-message-failed' });
  assert.equal(connectionTestFeedback(undefined), null);
});
