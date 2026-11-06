import assert from 'node:assert/strict';
import test from 'node:test';

import { getImHostLanguage, setImHostLanguage } from '../src/channels/shared/i18n.mjs';
import {
  channelDeliveryFailure,
  classifyMessageFailure,
  messageFailureText,
  publicMessageFailure,
} from '../src/channels/shared/message-failure.mjs';

const options = { referenceId: 'MF-TEST01', at: 123 };

test('missing Sessions accept both RPC codes without changing the original error', () => {
  for (const code of ['session-not-found', 'session/not-found']) {
    const error = Object.freeze({ code, message: 'private session path' });
    const failure = classifyMessageFailure(error, options);
    assert.equal(failure.code, 'SESSION_NOT_FOUND');
    assert.equal(failure.reason, 'SESSION_NOT_FOUND');
    assert.match(failure.message, /\/new/u);
    assert.doesNotMatch(JSON.stringify(failure), /private session path/u);
    assert.equal(error.code, code);
  }
});

test('unknown transport failures reuse normalized timeout and network evidence', () => {
  for (const [error, code, reason] of [
    [new DOMException('private timeout detail', 'TimeoutError'), 'REQUEST_TIMEOUT', 'timeout'],
    [{ code: 'telegram-timeout' }, 'REQUEST_TIMEOUT', 'timeout'],
    [{ code: 'timeout' }, 'REQUEST_TIMEOUT', 'timeout'],
    [{ code: 'UND_ERR_HEADERS_TIMEOUT' }, 'REQUEST_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'],
    [new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }), 'NETWORK_ERROR', 'ENOTFOUND'],
    [new Error('outer', { cause: { code: 'ECONNRESET' } }), 'NETWORK_ERROR', 'ECONNRESET'],
    [{ code: 'CERT_HAS_EXPIRED' }, 'NETWORK_ERROR', 'CERT_HAS_EXPIRED'],
    [new AggregateError([{ code: 'ETIMEDOUT' }, { code: 'UND_ERR_CONNECT_TIMEOUT' }]), 'REQUEST_TIMEOUT', 'multiple-causes'],
    [new AggregateError([{ code: 'ENOTFOUND' }, { code: 'ECONNREFUSED' }]), 'NETWORK_ERROR', 'multiple-causes'],
    [new AggregateError([{ code: 'ETIMEDOUT' }, { code: 'ECONNREFUSED' }]), 'NETWORK_ERROR', 'multiple-causes'],
  ]) {
    const failure = classifyMessageFailure(error, options);
    assert.equal(failure.code, code);
    assert.equal(failure.details.reason, reason);
    assert.ok(failure.details.hint);
    assert.match(failure.message, /结果尚未确认.*不要立即重复提交/u);
    assert.doesNotMatch(JSON.stringify(publicMessageFailure(failure)), /private|fetch failed|outer/u);
  }
});

test('known business failures and explicit input guidance keep priority over transport causes', () => {
  for (const [error, expected] of [
    [{ code: 'harness-timeout', method: 'session.prompt' }, 'HARNESS_RESULT_UNCERTAIN'],
    [{ code: 'harness-timeout', method: 'host.describe' }, 'HARNESS_TIMEOUT'],
    [{ code: 'harness-turn-failed', providerCode: 'QUOTA' }, 'MODEL_QUOTA'],
    [{ code: 'harness-turn-failed', providerCode: 'TIMEOUT' }, 'MODEL_TIMEOUT'],
    [{ code: 'agent-busy' }, 'SESSION_BUSY'],
    [{ code: 'channel-permission' }, 'CHANNEL_PERMISSION'],
    [{ code: 'channel-rate-limit' }, 'CHANNEL_RATE_LIMIT'],
    [channelDeliveryFailure(new DOMException('private', 'TimeoutError')), 'CHANNEL_DELIVERY_UNCERTAIN'],
    [channelDeliveryFailure(new Error('private'), { uncertain: false }), 'CHANNEL_DELIVERY'],
  ]) {
    assert.equal(classifyMessageFailure({ ...error, cause: { code: 'ECONNRESET' } }, options).code, expected);
  }
  assert.equal(classifyMessageFailure({ code: 'ETIMEDOUT' }, {
    ...options, reason: 'image-invalid', userMessage: '当前图片无法处理。',
  }).code, 'INPUT_INVALID');
});

test('prompt-submit timeouts keep a distinct submission-timeout notice', () => {
  const failure = classifyMessageFailure({
    code: 'harness-timeout', method: 'session.prompt',
    details: { stage: 'prompt.submit', submissionState: 'unknown' },
  }, options);
  assert.equal(failure.code, 'HARNESS_RESULT_UNCERTAIN');
  assert.match(failure.message, /提交请求超时/u);
  assert.match(failure.message, /不要立即重复提交/u);
  assert.doesNotMatch(failure.message, /任务可能已经开始/u);

  const replyStage = classifyMessageFailure({
    code: 'harness-timeout', method: 'session.history',
    details: { stage: 'reply.wait', submissionState: 'accepted' },
  }, options);
  assert.equal(replyStage.code, 'HARNESS_RESULT_UNCERTAIN');
  assert.match(replyStage.message, /任务可能已经开始/u);
  assert.doesNotMatch(replyStage.message, /提交请求超时/u);
});

test('uncertain Telegram delivery does not become a safe-to-retry timeout', () => {
  const failure = classifyMessageFailure({
    code: 'telegram-timeout', deliveryOutcome: 'unknown',
    cause: new DOMException('private timeout detail', 'TimeoutError'),
  }, options);
  assert.equal(failure.code, 'CHANNEL_DELIVERY_UNCERTAIN');
  assert.equal(failure.details.reason, 'timeout');
  assert.match(failure.message, /先检查聊天.*不要立即重复提交/u);
});

test('cancellation, mixed unrelated causes and unstructured text remain unclassified', () => {
  for (const error of [
    new DOMException('timeout', 'AbortError'),
    { code: 'cancelled', cause: { code: 'ETIMEDOUT' } },
    new AggregateError([{ code: 'ENOSPC' }, { code: 'ETIMEDOUT' }]),
    new Error('timeout ECONNRESET https://private.example/'),
    { code: 'private-TIMEOUT' },
  ]) assert.equal(classifyMessageFailure(error, options).code, 'INTERNAL_UNKNOWN');
});

test('English transport failures include translated diagnostics and preserve uncertainty', (t) => {
  const language = getImHostLanguage();
  t.after(() => setImHostLanguage(language));
  setImHostLanguage('en');
  for (const error of [new DOMException('private', 'TimeoutError'), { code: 'ENOTFOUND' }]) {
    const failure = classifyMessageFailure(error, options);
    assert.match(failure.message, /outcome is unconfirmed/u);
    assert.match(messageFailureText(failure), /Error code: .*reference: MF-TEST01/u);
    assert.doesNotMatch(JSON.stringify(failure), /[\u4e00-\u9fff]/u);
  }
});

for (const code of ['model-unavailable', 'session/model-unavailable'])
test(`${code} RPC failures provide conversation and bot-default recovery paths`, () => {
  const failure = classifyMessageFailure({
    code, message: 'private provider detail',
  }, options);
  assert.equal(failure.code, 'MODEL_UNAVAILABLE');
  assert.equal(failure.reason, code.toUpperCase().replaceAll('-', '_').replaceAll('/', '_'));
  assert.match(failure.message, /\/models.*\/model <序号>.*当前聊天/u);
  assert.match(failure.message, /后续新会话.*DSH 设置.*IM机器人/u);
  assert.doesNotMatch(JSON.stringify(failure), /private provider detail/u);
});

test('English model failures distinguish the current conversation from bot defaults', (t) => {
  const language = getImHostLanguage();
  t.after(() => setImHostLanguage(language));
  setImHostLanguage('en');
  const failure = classifyMessageFailure({ code: 'session/model-unavailable' }, options);
  assert.equal(failure.code, 'MODEL_UNAVAILABLE');
  assert.match(failure.message, /\/models.*\/model <index>.*current conversation/u);
  assert.match(failure.message, /new conversations.*DSH Settings.*IM Bots/u);
  assert.doesNotMatch(failure.message, /[\u4e00-\u9fff]/u);
});

test('preset failures accept both RPC code formats and preserve the underlying reason', () => {
  for (const suffix of ['not-found', 'invalid', 'locked', 'read-only']) {
    for (const separator of ['-', '/']) {
      const code = `agent-preset${separator}${suffix}`;
      const error = Object.freeze({ code, message: 'private preset path /secret' });
      const failure = classifyMessageFailure(error, options);
      assert.equal(failure.code, 'PRESET_UNAVAILABLE', code);
      assert.equal(failure.reason, `AGENT_PRESET_${suffix.toUpperCase().replaceAll('-', '_')}`);
      assert.match(failure.message, /\/presetlist.*\/preset <序号或 ID>.*\/new/u);
      assert.match(failure.message, /继续原会话.*恢复原 Preset/u);
      assert.doesNotMatch(JSON.stringify(failure), /private|secret/u);
      assert.equal(error.code, code);
    }
  }
});

test('failure reasons prefer explicit diagnostics and fall back to a safe RPC code', () => {
  const error = { code: 'agent-preset/not-found' };
  assert.equal(classifyMessageFailure(error, {
    ...options, reason: 'preset/recovery-required',
  }).reason, 'PRESET_RECOVERY_REQUIRED');
  assert.equal(classifyMessageFailure(error, {
    ...options, reason: 'private detail with spaces',
  }).reason, 'AGENT_PRESET_NOT_FOUND');

  for (const code of [undefined, 123, '', 'private detail', 'https://secret', 'x'.repeat(65)]) {
    const failure = classifyMessageFailure({ code }, options);
    assert.equal(failure.code, 'INTERNAL_UNKNOWN');
    assert.equal(failure.reason, 'INTERNAL_UNKNOWN');
  }
});

test('gateway input validation failures reuse protocol guidance and retain their reason', (t) => {
  const language = getImHostLanguage();
  t.after(() => setImHostLanguage(language));
  for (const locale of ['zh', 'en']) {
    setImHostLanguage(locale);
    const failure = classifyMessageFailure({
      code: 'gateway/input-invalid', message: 'private boundary validation detail',
    }, options);
    assert.equal(failure.code, 'HARNESS_PROTOCOL');
    assert.equal(failure.reason, 'GATEWAY_INPUT_INVALID');
    assert.equal(failure.referenceId, options.referenceId);
    assert.equal(failure.message, classifyMessageFailure({ code: 'harness-response-invalid' }, options).message);
    assert.doesNotMatch(JSON.stringify(publicMessageFailure(failure)), /private boundary/);
    assert.match(messageFailureText(failure), /HARNESS_PROTOCOL.*MF-TEST01/s);
  }
});

test('diagnostic fallback does not turn an unknown RPC error into invalid input', () => {
  const error = { code: 'gateway/internal' };
  const failure = classifyMessageFailure(error, { ...options, userMessage: '请求失败。' });
  assert.equal(failure.code, 'INTERNAL_UNKNOWN');
  assert.equal(failure.reason, 'GATEWAY_INTERNAL');

  const imageFailure = classifyMessageFailure(error, {
    ...options, userMessage: '当前模型不支持图片。', reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES',
  });
  assert.equal(imageFailure.code, 'INPUT_INVALID');
  assert.equal(imageFailure.reason, 'MODEL_DOES_NOT_SUPPORT_IMAGES');
  assert.equal(classifyMessageFailure({ code: 'image-invalid' }, options).code, 'INPUT_INVALID');
});

test('English preset failures include all recovery steps', (t) => {
  const language = getImHostLanguage();
  t.after(() => setImHostLanguage(language));
  setImHostLanguage('en');
  const failure = classifyMessageFailure({ code: 'agent-preset/not-found' }, options);
  assert.match(failure.message, /\/presetlist.*\/preset <index or ID>.*\/new/u);
  assert.match(failure.message, /original Session.*restore the original Preset/u);
  assert.doesNotMatch(failure.message, /[\u4e00-\u9fff]/u);
});

test('message failures distinguish stable Harness transport errors', () => {
  assert.equal(classifyMessageFailure({
    code: 'harness-connect-failed', method: 'host.describe',
  }, options).code, 'HARNESS_CONNECT');
  assert.equal(classifyMessageFailure({
    code: 'harness-connect-failed', method: 'session.history',
  }, options).code, 'HARNESS_RESULT_UNCERTAIN');
  assert.equal(classifyMessageFailure({
    code: 'harness-timeout', method: 'session.prompt',
  }, options).code, 'HARNESS_RESULT_UNCERTAIN');
  assert.equal(classifyMessageFailure({
    code: 'harness-auth-required', method: 'host.describe',
  }, options).code, 'HARNESS_ACCESS');
  assert.equal(classifyMessageFailure({
    code: 'harness-api-not-found', method: 'session.history',
  }, options).code, 'HARNESS_PROTOCOL');
});

test('message failures use verified turn-end provider codes without exposing provider detail', () => {
  for (const [providerCode, code] of [
    ['AUTH', 'MODEL_AUTH'],
    ['QUOTA', 'MODEL_QUOTA'],
    ['RATE_LIMIT', 'MODEL_RATE_LIMIT'],
    ['CONTEXT_WINDOW_EXCEEDED', 'MODEL_CONTEXT_LIMIT'],
    ['UNKNOWN_MODEL', 'MODEL_UNAVAILABLE'],
    ['TIMEOUT', 'MODEL_TIMEOUT'],
    ['TRANSPORT', 'MODEL_TRANSPORT'],
    ['SERVER', 'MODEL_SERVICE'],
    ['STREAM_CLOSED', 'MODEL_STREAM'],
    ['EMPTY_RESPONSE', 'MODEL_EMPTY_REPLY'],
    ['CONTENT_FILTER', 'MODEL_CONTENT_REJECTED'],
  ]) {
    const failure = classifyMessageFailure({
      code: 'harness-turn-failed',
      providerCode,
      message: 'provider-token /private/path',
      reason: { error: { message: 'secret provider payload' } },
    }, options);
    assert.equal(failure.code, code);
    assert.doesNotMatch(JSON.stringify(failure), /provider-token|private|secret provider/);
  }

  assert.equal(classifyMessageFailure({
    code: 'channel-send-failed', providerCode: 'RATE_LIMIT', status: 429,
  }, options).code, 'CHANNEL_RATE_LIMIT');
  assert.equal(classifyMessageFailure({
    code: 'harness-turn-failed', providerCode: 'PRIVATE_PROVIDER_CODE',
  }, options).code, 'INTERNAL_UNKNOWN');
});

test('message failure text contains a safe code and traceable reference', () => {
  const failure = classifyMessageFailure(new Error('secret-shaped internal detail'), options);
  assert.deepEqual(failure, {
    details: { reason: 'unknown' },
    code: 'INTERNAL_UNKNOWN',
    reason: 'INTERNAL_UNKNOWN',
    message: '任务未完成，暂时无法确定原因。请重试；若持续发生，请将参考号提供给管理员。',
    referenceId: 'MF-TEST01',
    at: 123,
  });
  assert.match(messageFailureText(failure), /错误码：INTERNAL_UNKNOWN；参考号：MF-TEST01/);
  assert.doesNotMatch(messageFailureText(failure), /secret-shaped/);
});

test('public message failure keeps only bounded safe fields', () => {
  assert.deepEqual(publicMessageFailure({
    ...classifyMessageFailure({ code: 'agent-busy' }, options),
    providerDetail: 'secret',
    stack: '/private/path',
  }), {
    code: 'SESSION_BUSY',
    reason: 'AGENT_BUSY',
    message: '当前会话仍在处理上一项任务。请等待完成，或发送 /stop 后重试。',
    referenceId: 'MF-TEST01',
    at: 123,
  });
});

test('artifact permission failures use the shared channel permission classification', () => {
  const error = new Error('private provider permission detail');
  error.code = 'artifact-permission-required';

  const failure = classifyMessageFailure(error, {
    userMessage: '结果文件已生成，但机器人没有文件发送权限。',
    reason: error.code,
    referenceId: 'MF-ART12345',
    at: 123,
  });

  assert.deepEqual(failure, {
    code: 'CHANNEL_PERMISSION',
    reason: 'ARTIFACT_PERMISSION_REQUIRED',
    message: '结果文件已生成，但机器人没有文件发送权限。',
    referenceId: 'MF-ART12345',
    at: 123,
  });
});
