import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyMessageFailure } from '../../../src/channels/shared/message-failure.mjs';
import { wecomSendDiagnostic, wecomSendError } from '../../../src/channels/wecom/send-error.mjs';

test('WeCom SDK send failures distinguish rejection, rate limits, permissions and uncertain delivery', () => {
  for (const [cause, expected] of [
    [{ errcode: 45009, errmsg: 'rate limit' }, 'CHANNEL_RATE_LIMIT'],
    [{ errcode: 48002, errmsg: 'permission denied' }, 'CHANNEL_PERMISSION'],
    [{ body: { errcode: -1, errmsg: 'rejected' } }, 'CHANNEL_DELIVERY'],
    [{ errcode: '99999', errmsg: 'unknown provider rejection' }, 'CHANNEL_DELIVERY'],
    [{ status: 429 }, 'CHANNEL_RATE_LIMIT'],
    [{ httpStatus: 403 }, 'CHANNEL_PERMISSION'],
    [{ errcode: true }, 'CHANNEL_DELIVERY_UNCERTAIN'],
    [new Error('Reply ack timeout (5000ms) for reqId: request-1'), 'CHANNEL_DELIVERY_UNCERTAIN'],
    [new Error('WebSocket closed, reply for reqId: request-1 cancelled'), 'CHANNEL_DELIVERY_UNCERTAIN'],
    [new Error('WebSocket not connected, unable to send data'), 'CHANNEL_DELIVERY'],
  ]) {
    const error = wecomSendError(cause, 'sendMessage');
    assert.equal(classifyMessageFailure(error).code, expected);
    assert.equal(error.cause, cause);
    assert.equal(wecomSendError(error, 'sendMessage'), error);
  }
});

test('WeCom send normalization preserves programming errors and cancellation', () => {
  for (const error of [new TypeError('invalid card'), new ReferenceError('missing binding'),
    new SyntaxError('invalid data'), new DOMException('cancelled', 'AbortError')]) {
    assert.equal(wecomSendError(error, 'replyTemplateCard'), error);
  }
});

test('WeCom send diagnostics retain provider codes without exposing the SDK frame', () => {
  const cause = { errcode: 45009, errmsg: 'private provider message',
    headers: { req_id: 'private-request' }, body: { secret: 'private-secret' } };
  const error = wecomSendError(cause, 'sendMessage');
  assert.deepEqual(wecomSendDiagnostic(error), {
    operation: 'sendMessage', code: 'channel-rate-limit', providerCode: 45009, status: undefined,
  });
  assert.doesNotMatch(JSON.stringify({ failure: classifyMessageFailure(error),
    diagnostic: wecomSendDiagnostic(error), message: error.message }), /private/);
});
