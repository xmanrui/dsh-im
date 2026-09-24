import { extractConnectionEvidence } from './connection-error.mjs';
import { diagnosticFields } from './diagnostic-details.mjs';
import { randomUUID } from 'node:crypto';

import { t } from './i18n.mjs';

const PROVIDER_FAILURES = Object.freeze({
  AUTH: 'MODEL_AUTH',
  MISSING_CREDENTIAL: 'MODEL_AUTH',
  INVALID_CREDENTIAL: 'MODEL_AUTH',
  QUOTA: 'MODEL_QUOTA',
  RATE_LIMIT: 'MODEL_RATE_LIMIT',
  CONTEXT_WINDOW_EXCEEDED: 'MODEL_CONTEXT_LIMIT',
  UNKNOWN_MODEL: 'MODEL_UNAVAILABLE',
  NO_ADAPTER: 'MODEL_UNAVAILABLE',
  UNSUPPORTED_OPTION: 'MODEL_CONFIG',
  UNSUPPORTED_REASONING_EFFORT: 'MODEL_CONFIG',
  TIMEOUT: 'MODEL_TIMEOUT',
  TRANSPORT: 'MODEL_TRANSPORT',
  SERVER: 'MODEL_SERVICE',
  STREAM_CLOSED: 'MODEL_STREAM',
  MALFORMED_RESPONSE: 'MODEL_STREAM',
  EMPTY_RESPONSE: 'MODEL_EMPTY_REPLY',
  CONTENT_FILTER: 'MODEL_CONTENT_REJECTED',
  UNSUPPORTED_CONTENT: 'MODEL_CONFIG',
});

const FAILURE_MESSAGES = Object.freeze({
  HARNESS_CONNECT:
    '无法连接处理服务，消息尚未提交。请确认 DeepSeek Harness 正在运行后重试。',
  HARNESS_TIMEOUT:
    '处理服务响应超时，消息尚未开始处理。请稍后重试。',
  HARNESS_RESULT_UNCERTAIN:
    '暂时无法确认任务状态，任务可能已经开始。请先等待或发送 /stop，不要立即重复提交。',
  HARNESS_ACCESS:
    '处理服务拒绝了机器人连接。请管理员检查 Harness 地址、代理或访问配置后重试。',
  HARNESS_PROTOCOL:
    '机器人与 DeepSeek Harness 的接口不兼容。请管理员检查 Harness 地址并更新相关版本。',
  HARNESS_SERVICE:
    'DeepSeek Harness 暂时无法完成请求，请稍后重试。',
  MODEL_REPLY_TIMEOUT:
    '等待模型回复超时，任务可能仍在运行。请先等待或发送 /stop，不要立即重复提交。',
  MODEL_AUTH:
    '模型凭据缺失或已失效。请管理员检查模型配置后重试。',
  MODEL_QUOTA:
    '模型额度或余额不足，本次任务未完成。请管理员补充额度或切换模型后重试。',
  MODEL_RATE_LIMIT:
    '模型服务正在限流，本次任务未完成。请稍后重试。',
  MODEL_CONTEXT_LIMIT:
    '当前会话内容超过模型上下文上限。请发送 /compact 或 /new 后重试。',
  MODEL_UNAVAILABLE:
    '当前模型不存在或不支持所选配置。请发送 /models，再用 /model <序号> 为当前聊天重新选择。若要修改后续新会话的默认模型，请到 DSH 设置 → IM机器人 → 对应机器人卡片修改。',
  MODEL_CONFIG:
    '当前模型不支持这类内容或所选配置。请调整内容、模型或推理等级后重试。',
  MODEL_TIMEOUT:
    '模型服务响应超时，本次任务未完成。请稍后重试。',
  MODEL_TRANSPORT:
    '暂时无法连接模型服务，本次任务未完成。请稍后重试。',
  MODEL_SERVICE:
    '模型服务暂时异常，本次任务未完成。请稍后重试。',
  MODEL_STREAM:
    '模型回复中断或格式异常，本次任务未完成。请重试。',
  MODEL_EMPTY_REPLY:
    '模型没有返回可显示的内容。请重试；若持续发生，请切换模型。',
  MODEL_CONTENT_REJECTED:
    '模型拒绝处理当前内容。请调整问题内容后重试。',
  MODEL_OUTPUT_LIMIT:
    '模型达到输出长度上限，但没有生成可显示的结果。请缩小任务范围后重试。',
  TURN_BLOCKED:
    '任务正在等待无法在当前渠道完成的操作。请在 DeepSeek Harness 中处理后再试。',
  TURN_INTERRUPTED:
    '任务被意外中断，本次未完成。请重试。',
  SESSION_NOT_FOUND:
    '当前会话已不存在。请发送 /new 创建新会话后重试。',
  SESSION_BUSY:
    '当前会话仍在处理上一项任务。请等待完成，或发送 /stop 后重试。',
  SESSION_STALE:
    '工作区或会话状态刚刚发生变化。请重新发送这条消息。',
  WORKSPACE_UNAVAILABLE:
    '当前工作区不存在或暂不可用。请重新选择工作区后重试。',
  PRESET_UNAVAILABLE:
    '当前 Agent Preset 无法使用。请发送 /presetlist 查看可用项，使用 /preset <序号或 ID> 重新选择，再发送 /new 创建新会话后重试。如需继续原会话，请联系管理员恢复原 Preset。',
  CHANNEL_PERMISSION:
    '回复已经生成，但机器人没有发送权限。请联系管理员检查渠道权限或重新绑定机器人。',
  CHANNEL_RATE_LIMIT:
    '回复已经生成，但当前渠道正在限流，暂时无法发送。请稍后重试。',
  CHANNEL_DELIVERY_UNCERTAIN:
    '回复发送结果未能确认。请先检查聊天内是否已经收到，不要立即重复提交。',
  CHANNEL_DELIVERY:
    '回复已经生成，但当前渠道暂时无法发送。请稍后重试。',
  INPUT_INVALID:
    '当前消息包含无法处理的图片或文件。请调整后重新发送。',
  INTERNAL_UNKNOWN:
    '任务未完成，暂时无法确定原因。请重试；若持续发生，请将参考号提供给管理员。',
});

function providerFailureCode(error) {
  if (error?.code !== 'harness-turn-failed') return null;
  const value = error?.providerCode ?? error?.details?.providerCode;
  if (typeof value !== 'string') return null;
  return PROVIDER_FAILURES[value.trim().toUpperCase()] ?? null;
}

function failureCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const providerCode = providerFailureCode(error);
  if (providerCode) return providerCode;

  if (code === 'harness-connect-failed') {
    return ['session.prompt', 'session.history'].includes(error?.method)
      ? 'HARNESS_RESULT_UNCERTAIN'
      : 'HARNESS_CONNECT';
  }
  if (code === 'harness-timeout') {
    return ['session.prompt', 'session.history'].includes(error?.method)
      ? 'HARNESS_RESULT_UNCERTAIN'
      : 'HARNESS_TIMEOUT';
  }
  if (code === 'harness-reply-timeout') return 'MODEL_REPLY_TIMEOUT';
  if ([
    'harness-auth-required', 'harness-proxy-auth-required',
    'harness-loopback-forbidden', 'harness-host-untrusted',
    'harness-request-forbidden',
  ].includes(code)) return 'HARNESS_ACCESS';
  if (['harness-api-not-found', 'harness-response-invalid'].includes(code)) {
    return 'HARNESS_PROTOCOL';
  }
  if (code === 'harness-turn-failed') return 'INTERNAL_UNKNOWN';
  if (['harness-http-failed', 'harness-rpc-rejected'].includes(code)) return 'HARNESS_SERVICE';
  if (code === 'model-unavailable' || code === 'session/model-unavailable') return 'MODEL_UNAVAILABLE';
  if (code === 'model-empty-response') return 'MODEL_EMPTY_REPLY';
  if (code === 'model-max-tokens') return 'MODEL_OUTPUT_LIMIT';
  if (code === 'turn-blocked') return 'TURN_BLOCKED';
  if (['turn-interrupted', 'turn-aborted'].includes(code)) return 'TURN_INTERRUPTED';
  if (code === 'session-not-found') return 'SESSION_NOT_FOUND';
  if (code === 'agent-busy') return 'SESSION_BUSY';
  if (code === 'workspace-session-stale') return 'SESSION_STALE';
  if (code.startsWith('workspace-')) return 'WORKSPACE_UNAVAILABLE';
  if (/^agent-preset[-/]/u.test(code)) return 'PRESET_UNAVAILABLE';
  if (code.startsWith('image-') || code.startsWith('inbound-file-')
    || code === 'attachment-error') return 'INPUT_INVALID';

  const status = Number(error?.status ?? error?.httpStatus);
  if (status === 401 || status === 403
    || [
      'channel-permission',
      'permission-required',
      'artifact-permission-required',
      'forbidden',
      'stale-token',
    ].includes(code)) {
    return 'CHANNEL_PERMISSION';
  }
  if (status === 429
    || ['channel-rate-limit', 'rate-limited', 'artifact-rate-limited'].includes(code)) {
    return 'CHANNEL_RATE_LIMIT';
  }
  if (['channel-delivery-uncertain', 'delivery-uncertain', 'artifact-delivery-uncertain']
    .includes(code)) {
    return 'CHANNEL_DELIVERY_UNCERTAIN';
  }
  if (code === 'channel-delivery-failed' || code.startsWith('artifact-')
    || ['network-error', 'timeout'].includes(code)) {
    return 'CHANNEL_DELIVERY';
  }
  return 'INTERNAL_UNKNOWN';
}

function safeReferenceId(value) {
  return typeof value === 'string' && /^[A-Z0-9-]{6,40}$/u.test(value)
    ? value
    : `MF-${randomUUID().slice(0, 8).toUpperCase()}`;
}

function safeFailureReason(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_/-]{1,64}$/u.test(value)) return null;
  return value.toUpperCase().replace(/[-/]/gu, '_');
}

export function classifyMessageFailure(error, {
  userMessage,
  reason,
  referenceId,
  at = Date.now(),
} = {}) {
  const safeReason = safeFailureReason(reason);
  const classifiedCode = failureCode(error);
  const code = classifiedCode === 'INTERNAL_UNKNOWN'
    && safeReason
    && typeof userMessage === 'string'
    && userMessage.trim()
    ? 'INPUT_INVALID'
    : classifiedCode;
  const details = extractConnectionEvidence(error).details;
  return Object.freeze({
    ...(code === 'INTERNAL_UNKNOWN' || details.reason !== 'unknown' || details.httpStatus || details.providerCode ? { details } : {}),
    code,
    reason: safeReason ?? safeFailureReason(error?.code) ?? code,
    message: typeof userMessage === 'string' && userMessage.trim()
      ? userMessage.trim()
      : t(FAILURE_MESSAGES[code]),
    referenceId: safeReferenceId(referenceId),
    at: Number.isFinite(at) ? at : Date.now(),
  });
}

export function messageFailureText(failure) {
  return `${failure.message}\n\n${t('错误码：{code}；参考号：{referenceId}', failure)}`;
}

export function messageFailureDiagnostic(error, failure) {
  const evidence = extractConnectionEvidence(error);
  return { code: failure.code, reason: failure.reason, referenceId: failure.referenceId,
    details: evidence.details, errors: evidence.errors };
}

export function setLastMessageFailure(status, error, options) {
  const failure = classifyMessageFailure(error, options);
  status.lastMessageError = failure;
  status.lastError = failure.message;
  return failure;
}

export function clearLastMessageFailure(status) {
  status.lastMessageError = null;
}

export function channelDeliveryFailure(error, { uncertain = true } = {}) {
  const wrapped = new Error('Channel message delivery failed', { cause: error });
  const status = Number(error?.status ?? error?.httpStatus);
  wrapped.code = status === 401 || status === 403
    ? 'channel-permission'
    : status === 429
      ? 'channel-rate-limit'
      : uncertain
        ? 'channel-delivery-uncertain'
        : 'channel-delivery-failed';
  if (Number.isInteger(status)) wrapped.status = status;
  return wrapped;
}

export function publicMessageFailure(value) {
  if (!value || typeof value !== 'object'
    || typeof value.code !== 'string' || !value.code
    || typeof value.reason !== 'string' || !value.reason
    || typeof value.message !== 'string' || !value.message
    || typeof value.referenceId !== 'string' || !value.referenceId
    || !Number.isFinite(value.at)) return null;
  return {
    code: value.code.slice(0, 64),
    reason: value.reason.slice(0, 64),
    message: value.message.slice(0, 500),
    referenceId: value.referenceId.slice(0, 40),
    at: value.at,
    ...(value.details ? diagnosticFields(value) : {}),
  };
}
