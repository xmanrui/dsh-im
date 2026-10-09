import { ApiError, messagePath } from '@tencent-connect/qqbot-nodejs/protocol';
import { qqNativeIdentifier } from './native-reply-observations.mjs';
import { qqRefusal } from './external-consumer.mjs';

function nativePostFailure(error) {
  let reason = 'send-result-unknown';
  const nativePost = {};
  if (error instanceof ApiError) {
    const rawCode = error.bizCode;
    const code = typeof rawCode === 'number' ? rawCode
      : typeof rawCode === 'string' && /^\d+$/.test(rawCode) ? Number(rawCode) : undefined;
    if (Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599)
      nativePost.httpStatus = error.httpStatus;
    if (Number.isSafeInteger(code) && code >= 0) nativePost.providerCode = code;
    if (error.httpStatus === 429 || code === 40034100) reason = 'send-rate-limited';
    else if ([40034101, 40034105, 40054002, 40054003, 40054016].includes(code))
      reason = 'send-permission-denied';
    else if ([22006, 304061, 40034006, 40054007, 40054010].includes(code)) reason = 'bad-request';
  }
  return { refusal: qqRefusal(reason), evidence: Object.freeze(nativePost) };
}

export async function postQqText({ bot, target, text, signal, beforeSend, verifyAccount, assertCurrent, onNativeFailure }) {
  const groupId = target?.route?.groupOpenId;
  if (target?.kind !== 'group' || !qqNativeIdentifier(groupId)) throw qqRefusal('invalid-target');
  if (typeof text !== 'string' || !text.trim() || text.length > 4000
    || typeof beforeSend !== 'function' || typeof verifyAccount !== 'function') throw qqRefusal('bad-request');
  const fence = () => {
    if (signal?.aborted) throw qqRefusal('cancelled');
    assertCurrent();
    if (beforeSend() !== true) throw qqRefusal('send-permission-denied');
    if (signal?.aborted) throw qqRefusal('cancelled');
  };
  fence();
  let token;
  try { token = await bot.api.getToken(); }
  catch { throw qqRefusal(signal?.aborted ? 'cancelled' : 'provider-unavailable'); }
  await verifyAccount();
  fence();
  let response;
  try {
    response = await bot.apiClient.request(token, 'POST', messagePath('group', groupId),
      { msg_type: 0, content: text });
  } catch (error) {
    const { refusal, evidence } = nativePostFailure(error);
    onNativeFailure?.(evidence);
    throw refusal;
  }
  if (signal?.aborted || !qqNativeIdentifier(response?.id)) throw qqRefusal('send-result-unknown');
  return { sent: true, receipt: { version: 1, messageId: response.id, conversationId: groupId } };
}
