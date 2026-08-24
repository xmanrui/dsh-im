import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';

import { fetchImageBuffer, ImagePromptError } from '../shared/image-prompt.mjs';
import { t } from '../shared/i18n.mjs';

export const DINGTALK_REGISTRATION_BASE_URL = 'https://oapi.dingtalk.com/';
export const DINGTALK_API_BASE_URL = 'https://api.dingtalk.com/';
export const DINGTALK_REGISTRATION_SOURCE = 'DING_DWS_CLAW';
export const DINGTALK_AI_CARD_TEMPLATE_ID = '02fcf2f4-5e02-4a85-b672-46d1f715543e.schema';

const DEFAULT_TIMEOUT_MS = 15_000;
const REGISTRATION_STATUSES = new Set(['WAITING', 'SUCCESS', 'FAIL', 'EXPIRED']);

export class DingtalkApiError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'DingtalkApiError';
    this.code = code;
    this.status = options.status;
    this.providerCode = options.providerCode;
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeProviderCode(value) {
  const code = value === undefined || value === null ? null : String(value).trim();
  return code && /^-?[A-Za-z0-9_.:-]{1,160}$/.test(code) ? code : undefined;
}

function preserveArtifactMetadata(target, source) {
  if (Number.isInteger(source?.status)) target.status = source.status;
  if (source?.providerCode !== undefined) target.providerCode = source.providerCode;
  return target;
}

function dingtalkArtifactError(cause, { fallback = 'artifact-provider-rejected' } = {}) {
  if (cause?.code?.startsWith?.('artifact-')) return cause;
  const status = Number(cause?.status);
  const providerCode = safeProviderCode(cause?.providerCode);
  const providerText = providerCode ?? '';
  let code = fallback;
  let message = 'DingTalk could not prepare the file for delivery.';
  if (status === 401 || status === 403 || providerCode === '401' || providerCode === '403'
    || /(?:permission|forbidden|unauthor|access.?denied|\.auth(?:\.|$))/i.test(providerText)) {
    code = 'artifact-permission-required';
    message = 'DingTalk denied permission to send the file.';
  } else if (status === 413 || providerCode === '413'
    || /(?:too.?large|size.?limit)/i.test(providerText)) {
    code = 'artifact-too-large';
    message = 'The file exceeds DingTalk\'s size limit.';
  } else if (status === 429 || providerCode === '429'
    || /(?:rate.?limit|too.?many|throttl)/i.test(providerText)) {
    code = 'artifact-rate-limited';
    message = 'DingTalk rate-limited file delivery.';
  } else if (fallback === 'artifact-provider-rejected') {
    message = 'DingTalk rejected the file message.';
  }
  const error = new Error(message, { cause });
  error.code = code;
  return preserveArtifactMetadata(error, cause);
}

function uncertainDingtalkDelivery(cause) {
  const error = new Error('DingTalk file delivery result is uncertain', { cause });
  error.code = 'artifact-delivery-uncertain';
  return preserveArtifactMetadata(error, cause);
}

function rejectedProviderResponse(value) {
  if (!value || typeof value !== 'object') return null;
  for (const field of ['errcode', 'code']) {
    if (value[field] !== undefined && value[field] !== 0 && value[field] !== '0') {
      return safeProviderCode(value[field]) ?? 'rejected';
    }
  }
  return null;
}

function classifyDingtalkFinalDeliveryError(error, signal) {
  if (signal?.aborted) throw abortError(signal);
  const status = Number(error?.status);
  if (error?.code === 'network-error' || error?.code === 'timeout'
    || error?.code === 'invalid-response' || (status >= 500 && status < 600)) {
    return uncertainDingtalkDelivery(error);
  }
  return dingtalkArtifactError(error);
}

function secureDingtalkDownloadUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new DingtalkApiError('invalid-image-download', '钉钉服务返回了无效的图片下载地址。', { cause: error });
  }
  if (url.protocol === 'http:' && (!url.port || url.port === '80')) {
    url.protocol = 'https:';
    url.port = '';
  }
  return url;
}

function isDingtalkHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return normalized === 'dingtalk.com' || normalized.endsWith('.dingtalk.com');
}

function normalizeTrustedUrl(value, { label, requireSubdomain = true } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new DingtalkApiError('invalid-url', `${label ?? '钉钉服务'}返回了无效地址。`);
  }
  const normalizedHost = url.hostname.toLowerCase().replace(/\.$/, '');
  const trustedHost = requireSubdomain
    ? normalizedHost !== 'dingtalk.com' && isDingtalkHost(normalizedHost)
    : isDingtalkHost(normalizedHost);
  if (url.protocol !== 'https:' || !trustedHost || (url.port && url.port !== '443')) {
    throw new DingtalkApiError('untrusted-url', `${label ?? '钉钉服务'}地址不受信任。`);
  }
  if (url.username || url.password) {
    throw new DingtalkApiError('untrusted-url', `${label ?? '钉钉服务'}地址不受信任。`);
  }
  return url;
}

export function normalizeDingtalkSessionWebhook(value) {
  const text = nonEmptyString(value);
  if (!text) throw new DingtalkApiError('invalid-session-webhook', '钉钉消息没有可用的回复地址。');
  const url = normalizeTrustedUrl(text, { label: '钉钉回复', requireSubdomain: false });
  url.hash = '';
  return url.toString();
}

export function splitDingtalkText(value, maxChars = 4_000) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return [];
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new TypeError('maxChars must be a positive integer');
  if (text.length <= maxChars) return [text];

  const chunks = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf('\n', maxChars);
    if (splitAt < Math.floor(maxChars * 0.6)) splitAt = maxChars;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('The operation was aborted', 'AbortError');
}

function abortableDelay(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function requestJson(fetchImpl, url, {
  body,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  headers = {},
  method = 'POST',
  action = 'request',
} = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) throw abortError(signal);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs) : null;

  try {
    const response = await fetchImpl(url, {
      method,
      redirect: 'error',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    if (!response.ok) {
      let providerCode;
      try {
        const errorBody = await response.json();
        providerCode = safeProviderCode(errorBody?.code ?? errorBody?.errcode);
      } catch {
        // DingTalk occasionally returns an empty or non-JSON error body.
      }
      throw new DingtalkApiError(
        'http-error',
        `钉钉服务请求失败（HTTP ${response.status}）。`,
        { status: response.status, providerCode },
      );
    }
    try {
      return await response.json();
    } catch (error) {
      throw new DingtalkApiError('invalid-response', '钉钉服务返回了无法解析的响应。', { cause: error });
    }
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    if (timedOut) throw new DingtalkApiError('timeout', '钉钉服务请求超时。', { cause: error });
    if (error instanceof DingtalkApiError) throw error;
    throw new DingtalkApiError('network-error', `暂时无法完成钉钉${action}请求。`, { cause: error });
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function requestMultipart(fetchImpl, url, { body, signal, timeoutMs = 60_000 } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) throw abortError(signal);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      body,
      signal: controller.signal,
      redirect: 'error',
    });
    let value;
    let parseError;
    try {
      value = await response.json();
    } catch (error) {
      parseError = error;
    }
    if (!response.ok) {
      throw new DingtalkApiError(
        'http-error',
        `钉钉服务请求失败（HTTP ${response.status}）。`,
        { status: response.status, providerCode: safeProviderCode(value?.code ?? value?.errcode) },
      );
    }
    if (parseError) {
      throw new DingtalkApiError(
        'invalid-response',
        '钉钉服务返回了无法解析的响应。',
        { cause: parseError },
      );
    }
    return value;
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    if (timedOut) throw new DingtalkApiError('timeout', '钉钉服务请求超时。', { cause: error });
    if (error instanceof DingtalkApiError) throw error;
    throw new DingtalkApiError('network-error', '暂时无法完成钉钉文件上传请求。', { cause: error });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function normalizeFileTarget(target) {
  const robotCode = nonEmptyString(target?.robotCode);
  if (!robotCode) throw new TypeError('DingTalk robotCode is required');
  if (target?.type === 'group') {
    const openConversationId = nonEmptyString(target.openConversationId);
    if (openConversationId) return { type: 'group', robotCode, openConversationId };
  }
  if (target?.type === 'user') {
    const userId = nonEmptyString(target.userId);
    if (userId) return { type: 'user', robotCode, userId };
  }
  throw new TypeError('DingTalk file target is invalid');
}

function dingtalkFileType(fileName) {
  return extname(fileName).slice(1).toLowerCase();
}

function normalizeCardTarget(target) {
  if (target?.type === 'user') {
    const userId = nonEmptyString(target.userId);
    if (userId) return { type: 'user', userId };
  }
  if (target?.type === 'group') {
    const openConversationId = nonEmptyString(target.openConversationId);
    if (openConversationId) return { type: 'group', openConversationId };
  }
  throw new TypeError('DingTalk AI Card target is invalid');
}

function cardData(text, flowStatus) {
  return {
    cardParamMap: {
      flowStatus,
      msgContent: normalizeDingtalkCardMarkdown(text),
      staticMsgContent: '',
      sys_full_json_obj: JSON.stringify({ order: ['msgContent'] }),
      config: JSON.stringify({ autoLayout: true }),
    },
  };
}

function cardDeliverBody(cardInstanceId, target, robotCode) {
  const base = { outTrackId: cardInstanceId, userIdType: 1 };
  if (target.type === 'group') {
    return {
      ...base,
      openSpaceId: `dtv1.card//IM_GROUP.${target.openConversationId}`,
      imGroupOpenDeliverModel: { robotCode },
    };
  }
  return {
    ...base,
    openSpaceId: `dtv1.card//IM_ROBOT.${target.userId}`,
    imRobotOpenDeliverModel: {
      spaceType: 'IM_ROBOT',
      robotCode,
      extension: { dynamicSummary: 'true' },
    },
  };
}

export function normalizeDingtalkCardMarkdown(value) {
  const text = typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : '';
  const lines = text.split('\n');
  let inCodeBlock = false;
  return lines.map((line, index) => {
    const fenced = /^\s{0,3}```/.test(line);
    const currentInCodeBlock = inCodeBlock;
    if (fenced) inCodeBlock = !inCodeBlock;
    if (index === lines.length - 1) return line;
    if (currentInCodeBlock || fenced || inCodeBlock || !line || !lines[index + 1]) return `${line}\n`;
    if (/^\s{0,3}(?:[-*+] |\d+[.)] |#{1,6} |\||> )/.test(lines[index + 1])) return `${line}\n`;
    return `${line}<br>`;
  }).join('');
}

function assertRegistrationOk(value, action) {
  if (!value || typeof value !== 'object' || value.errcode !== 0) {
    throw new DingtalkApiError(
      'registration-rejected',
      `钉钉扫码${action}失败。`,
    );
  }
  return value;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function createDingtalkApi({
  fetchImpl = fetch,
  registrationBaseUrl = process.env.DINGTALK_REGISTRATION_BASE_URL
    || DINGTALK_REGISTRATION_BASE_URL,
  registrationSource = process.env.DINGTALK_REGISTRATION_SOURCE
    || DINGTALK_REGISTRATION_SOURCE,
  now = () => Date.now(),
  cardMinIntervalMs = 50,
  cardBackoffMs = 1_000,
  delay = abortableDelay,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (!Number.isFinite(cardMinIntervalMs) || cardMinIntervalMs < 0) {
    throw new TypeError('cardMinIntervalMs must be a non-negative number');
  }
  if (!Number.isFinite(cardBackoffMs) || cardBackoffMs < 0) {
    throw new TypeError('cardBackoffMs must be a non-negative number');
  }
  if (typeof delay !== 'function') throw new TypeError('delay must be a function');
  const registrationBase = normalizeTrustedUrl(registrationBaseUrl, {
    label: '钉钉注册服务',
    requireSubdomain: false,
  });
  const apiBase = new URL(DINGTALK_API_BASE_URL);
  const source = nonEmptyString(registrationSource);
  if (!source) throw new TypeError('registrationSource is required');
  const tokenCache = new Map();
  const tokenRequests = new Map();
  let cardSlotTail = Promise.resolve();
  let nextCardRequestAt = 0;

  const endpoint = (base, pathname) => new URL(pathname.replace(/^\//, ''), base);

  async function accessToken({ clientId, clientSecret, signal }) {
    const appKey = nonEmptyString(clientId);
    const appSecret = nonEmptyString(clientSecret);
    if (!appKey || !appSecret) throw new TypeError('clientId and clientSecret are required');
    const cached = tokenCache.get(appKey);
    if (cached && cached.expiresAt > now()) return cached.token;
    if (tokenRequests.has(appKey)) return tokenRequests.get(appKey);

    const request = (async () => {
      const value = await requestJson(fetchImpl, endpoint(apiBase, 'v1.0/oauth2/accessToken'), {
        body: { appKey, appSecret },
        signal,
        action: '鉴权',
      });
      const token = nonEmptyString(value?.accessToken);
      if (!token) throw new DingtalkApiError('invalid-access-token', '钉钉服务没有返回访问令牌。');
      const expiresInSeconds = positiveNumber(value?.expireIn ?? value?.expiresIn, 7_200);
      const refreshAfterMs = Math.max(1_000, (expiresInSeconds - 60) * 1_000);
      tokenCache.set(appKey, { token, expiresAt: now() + refreshAfterMs });
      return token;
    })().finally(() => tokenRequests.delete(appKey));
    tokenRequests.set(appKey, request);
    return request;
  }

  async function messageFileDownloadUrl({
    clientId,
    clientSecret,
    robotCode,
    downloadCode,
    signal,
    kind,
  }) {
    const botCode = nonEmptyString(robotCode);
    const fileCode = nonEmptyString(downloadCode);
    if (!botCode || !fileCode) throw new TypeError('robotCode and downloadCode are required');
    const token = await accessToken({ clientId, clientSecret, signal });
    let response;
    try {
      response = await requestJson(
        fetchImpl,
        endpoint(apiBase, 'v1.0/robot/messageFiles/download'),
        {
          body: { downloadCode: fileCode, robotCode: botCode },
          headers: { 'x-acs-dingtalk-access-token': token },
          signal,
          action: `${kind === 'image' ? '图片' : '文件'}下载地址`,
        },
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new DingtalkApiError(
        `${kind}-download-address-failed`,
        `钉钉${kind === 'image' ? '图片' : '文件'}下载地址获取失败。`,
        { cause: error, status: error?.status, providerCode: error?.providerCode },
      );
    }
    const downloadUrl = nonEmptyString(response?.downloadUrl ?? response?.download_url);
    if (!downloadUrl) {
      throw new DingtalkApiError(
        `invalid-${kind}-download`,
        `钉钉服务没有返回${kind === 'image' ? '图片' : '文件'}下载地址。`,
      );
    }
    return secureDingtalkDownloadUrl(downloadUrl);
  }

  function acquireCardRequestSlot(signal) {
    const acquire = async () => {
      const waitMs = Math.max(0, nextCardRequestAt - now());
      if (waitMs > 0) await delay(waitMs, signal);
      nextCardRequestAt = Math.max(nextCardRequestAt, now()) + cardMinIntervalMs;
    };
    const slot = cardSlotTail.then(acquire, acquire);
    cardSlotTail = slot.catch(() => undefined);
    return slot;
  }

  async function cardRequest(pathname, options) {
    await acquireCardRequestSlot(options.signal);
    try {
      return await requestJson(fetchImpl, endpoint(apiBase, pathname), options);
    } catch (error) {
      if (!(error instanceof DingtalkApiError) || error.status !== 403) throw error;
      await delay(cardBackoffMs, options.signal);
      await acquireCardRequestSlot(options.signal);
      return requestJson(fetchImpl, endpoint(apiBase, pathname), options);
    }
  }

  async function failCard({ clientId, clientSecret, cardInstanceId, text, signal }) {
    const instanceId = nonEmptyString(cardInstanceId);
    const content = nonEmptyString(text);
    if (!instanceId) throw new TypeError('cardInstanceId is required');
    if (!content) throw new TypeError('text is required');
    const token = await accessToken({ clientId, clientSecret, signal });
    const headers = { 'x-acs-dingtalk-access-token': token };
    const requests = [
      cardRequest('v1.0/card/streaming', {
        method: 'PUT',
        body: {
          outTrackId: instanceId,
          guid: randomUUID(),
          key: 'msgContent',
          content: normalizeDingtalkCardMarkdown(content),
          isFull: true,
          isFinalize: false,
          isError: true,
        },
        headers,
        signal,
        action: 'AI Card 失败收口',
      }),
      cardRequest('v1.0/card/instances', {
        method: 'PUT',
        body: {
          outTrackId: instanceId,
          cardData: cardData(content, '5'),
          cardUpdateOptions: { updateCardDataByKey: true },
        },
        headers,
        signal,
        action: 'AI Card 失败状态',
      }),
    ];
    const results = await Promise.allSettled(requests);
    if (results.every(({ status }) => status === 'rejected')) throw results[0].reason;
    return true;
  }

  async function sendArtifact({
    clientId,
    clientSecret,
    target,
    file,
    signal,
  }, { uploadType, messageKey, createMessageParams }) {
    if (!file || typeof file !== 'object'
      || typeof file.fileName !== 'string' || !file.fileName
      || !Buffer.isBuffer(file.bytes)) {
      throw new TypeError('A DingTalk file is required');
    }
    const normalizedTarget = normalizeFileTarget(target);
    let token;
    try {
      token = await accessToken({ clientId, clientSecret, signal });
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      const status = Number(error?.status);
      const fallback = error?.code === 'http-error' && status >= 400 && status < 500
        ? 'artifact-provider-rejected'
        : 'artifact-provider-failed';
      throw dingtalkArtifactError(error, { fallback });
    }
    const uploadUrl = new URL('media/upload', DINGTALK_REGISTRATION_BASE_URL);
    uploadUrl.searchParams.set('access_token', token);
    uploadUrl.searchParams.set('type', uploadType);
    const form = new FormData();
    form.append(
      'media',
      new Blob([file.bytes], { type: file.mediaType ?? 'application/octet-stream' }),
      file.fileName,
    );
    let uploaded;
    try {
      uploaded = await requestMultipart(fetchImpl, uploadUrl, { body: form, signal });
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      const status = Number(error?.status);
      const fallback = error?.code === 'http-error' && status >= 400 && status < 500
        ? 'artifact-provider-rejected'
        : 'artifact-provider-failed';
      throw dingtalkArtifactError(error, { fallback });
    }
    const uploadRejection = rejectedProviderResponse(uploaded);
    const mediaId = nonEmptyString(uploaded?.media_id);
    if (uploadRejection || !mediaId) {
      throw dingtalkArtifactError(new DingtalkApiError(
        'upload-rejected',
        '钉钉服务拒绝了文件上传。',
        { providerCode: uploadRejection ?? 'missing-media-id' },
      ));
    }
    signal?.throwIfAborted();
    const messageBody = {
      robotCode: normalizedTarget.robotCode,
      msgKey: messageKey,
      msgParam: JSON.stringify(createMessageParams(mediaId, file)),
      ...(normalizedTarget.type === 'group'
        ? { openConversationId: normalizedTarget.openConversationId }
        : { userIds: [normalizedTarget.userId] }),
    };
    const pathname = normalizedTarget.type === 'group'
      ? 'v1.0/robot/groupMessages/send'
      : 'v1.0/robot/oToMessages/batchSend';
    let response;
    try {
      response = await requestJson(fetchImpl, endpoint(apiBase, pathname), {
        body: messageBody,
        headers: { 'x-acs-dingtalk-access-token': token },
        signal,
        action: '文件消息发送',
      });
    } catch (error) {
      throw classifyDingtalkFinalDeliveryError(error, signal);
    }
    const sendRejection = rejectedProviderResponse(response);
    if (sendRejection) {
      throw dingtalkArtifactError(new DingtalkApiError(
        'send-rejected',
        '钉钉服务拒绝了文件消息。',
        { providerCode: sendRejection },
      ));
    }
    return response;
  }

  return Object.freeze({
    async beginRegistration({ signal } = {}) {
      const initialized = assertRegistrationOk(await requestJson(
        fetchImpl,
        endpoint(registrationBase, 'app/registration/init'),
        { body: { source }, signal, action: '初始化' },
      ), '初始化');
      const nonce = nonEmptyString(initialized.nonce);
      if (!nonce) throw new DingtalkApiError('invalid-registration', '钉钉扫码初始化缺少 nonce。');

      const begun = assertRegistrationOk(await requestJson(
        fetchImpl,
        endpoint(registrationBase, 'app/registration/begin'),
        { body: { nonce }, signal, action: '创建' },
      ), '创建');
      const deviceCode = nonEmptyString(begun.device_code);
      const verificationUriComplete = nonEmptyString(begun.verification_uri_complete);
      if (!deviceCode || !verificationUriComplete) {
        throw new DingtalkApiError('invalid-registration', '钉钉扫码服务返回的信息不完整。');
      }
      const verificationUrl = normalizeTrustedUrl(verificationUriComplete, {
        label: '钉钉扫码',
        requireSubdomain: false,
      }).toString();
      return {
        deviceCode,
        userCode: nonEmptyString(begun.user_code) ?? undefined,
        verificationUri: nonEmptyString(begun.verification_uri) ?? undefined,
        verificationUriComplete: verificationUrl,
        expiresInSeconds: positiveNumber(begun.expires_in, 7_200),
        intervalSeconds: positiveNumber(begun.interval, 5),
      };
    },

    async pollRegistration({ deviceCode, signal } = {}) {
      const code = nonEmptyString(deviceCode);
      if (!code) throw new TypeError('deviceCode is required');
      const polled = assertRegistrationOk(await requestJson(
        fetchImpl,
        endpoint(registrationBase, 'app/registration/poll'),
        { body: { device_code: code }, signal, action: '状态查询' },
      ), '状态查询');
      const status = nonEmptyString(polled.status)?.toUpperCase();
      if (!status || !REGISTRATION_STATUSES.has(status)) {
        throw new DingtalkApiError('invalid-registration-status', '钉钉扫码服务返回了无法识别的状态。');
      }
      const result = {
        status,
        failReason: nonEmptyString(polled.fail_reason) ?? undefined,
      };
      if (status === 'SUCCESS') {
        result.clientId = nonEmptyString(polled.client_id) ?? undefined;
        result.clientSecret = nonEmptyString(polled.client_secret) ?? undefined;
        if (!result.clientId || !result.clientSecret) {
          throw new DingtalkApiError('missing-credentials', '钉钉扫码已确认，但没有返回机器人凭据。');
        }
      }
      return result;
    },

    accessToken,

    async downloadImage({
      clientId,
      clientSecret,
      robotCode,
      downloadCode,
      signal,
      maxBytes,
    }) {
      const downloadUrl = await messageFileDownloadUrl({
        clientId,
        clientSecret,
        robotCode,
        downloadCode,
        signal,
        kind: 'image',
      });
      try {
        return await fetchImageBuffer(downloadUrl, {
          fetchImpl,
          signal,
          maxBytes,
        });
      } catch (error) {
        if (signal?.aborted || error instanceof ImagePromptError) throw error;
        throw new DingtalkApiError(
          'image-content-download-failed',
          '钉钉图片内容下载失败。',
          { cause: error },
        );
      }
    },

    async downloadFile({
      clientId,
      clientSecret,
      robotCode,
      downloadCode,
      signal,
    }) {
      const downloadUrl = await messageFileDownloadUrl({
        clientId,
        clientSecret,
        robotCode,
        downloadCode,
        signal,
        kind: 'file',
      });
      if (downloadUrl.protocol !== 'https:') {
        throw new DingtalkApiError('invalid-file-download', '钉钉服务返回了无效的文件下载地址。');
      }
      try {
        const response = await fetchImpl(downloadUrl, {
          method: 'GET',
          redirect: 'follow',
          signal,
        });
        if (!response?.ok) {
          await response?.body?.cancel?.().catch?.(() => undefined);
          throw new DingtalkApiError(
            'file-content-download-failed',
            `钉钉文件内容下载失败（HTTP ${response?.status ?? 'unknown'}）。`,
            { status: response?.status },
          );
        }
        return Buffer.from(await response.arrayBuffer());
      } catch (error) {
        if (signal?.aborted) throw abortError(signal);
        if (error instanceof DingtalkApiError) throw error;
        throw new DingtalkApiError(
          'file-content-download-failed',
          '钉钉文件内容下载失败。',
          { cause: error },
        );
      }
    },

    async createAiCard({ clientId, clientSecret, target, initialText, signal }) {
      const appKey = nonEmptyString(clientId);
      const appSecret = nonEmptyString(clientSecret);
      const content = nonEmptyString(initialText);
      if (!appKey || !appSecret) throw new TypeError('clientId and clientSecret are required');
      if (!content) throw new TypeError('initialText is required');
      const normalizedTarget = normalizeCardTarget(target);
      const token = await accessToken({ clientId: appKey, clientSecret: appSecret, signal });
      const cardInstanceId = `dsh_${randomUUID()}`;
      const headers = { 'x-acs-dingtalk-access-token': token };

      let delivered = false;
      try {
        await cardRequest('v1.0/card/instances', {
          body: {
            cardTemplateId: DINGTALK_AI_CARD_TEMPLATE_ID,
            outTrackId: cardInstanceId,
            cardData: {
              cardParamMap: { config: JSON.stringify({ autoLayout: true }) },
            },
            callbackType: 'STREAM',
            imGroupOpenSpaceModel: { supportForward: true },
            imRobotOpenSpaceModel: { supportForward: true },
          },
          headers,
          signal,
          action: 'AI Card 创建',
        });
        await cardRequest('v1.0/card/instances/deliver', {
          body: cardDeliverBody(cardInstanceId, normalizedTarget, appKey),
          headers,
          signal,
          action: 'AI Card 投放',
        });
        delivered = true;
        await cardRequest('v1.0/card/instances', {
          method: 'PUT',
          body: { outTrackId: cardInstanceId, cardData: cardData(content, '2') },
          headers,
          signal,
          action: 'AI Card 启动',
        });
        await cardRequest('v1.0/card/streaming', {
          method: 'PUT',
          body: {
            outTrackId: cardInstanceId,
            guid: randomUUID(),
            key: 'msgContent',
            content: normalizeDingtalkCardMarkdown(content).replace(/\n+$/, ''),
            isFull: true,
            isFinalize: false,
            isError: false,
          },
          headers,
          signal,
          action: 'AI Card 启动',
        });
      } catch (error) {
        if (delivered) {
          const cleanupSignal = AbortSignal.timeout(5_000);
          await failCard({
            clientId: appKey,
            clientSecret: appSecret,
            cardInstanceId,
            text: t('消息处理失败，请稍后重试。'),
            signal: cleanupSignal,
          }).catch(() => undefined);
        }
        throw error;
      }
      return { cardInstanceId };
    },

    async updateAiCard({ clientId, clientSecret, cardInstanceId, text, signal }) {
      const instanceId = nonEmptyString(cardInstanceId);
      const content = nonEmptyString(text);
      if (!instanceId) throw new TypeError('cardInstanceId is required');
      if (!content) throw new TypeError('text is required');
      const token = await accessToken({ clientId, clientSecret, signal });
      await cardRequest('v1.0/card/streaming', {
        method: 'PUT',
        body: {
          outTrackId: instanceId,
          guid: randomUUID(),
          key: 'msgContent',
          content: normalizeDingtalkCardMarkdown(content).replace(/\n+$/, ''),
          isFull: true,
          isFinalize: false,
          isError: false,
        },
        headers: { 'x-acs-dingtalk-access-token': token },
        signal,
        action: 'AI Card 更新',
      });
      return true;
    },

    async finishAiCard({ clientId, clientSecret, cardInstanceId, text, signal }) {
      const instanceId = nonEmptyString(cardInstanceId);
      const content = nonEmptyString(text);
      if (!instanceId) throw new TypeError('cardInstanceId is required');
      if (!content) throw new TypeError('text is required');
      const token = await accessToken({ clientId, clientSecret, signal });
      const headers = { 'x-acs-dingtalk-access-token': token };
      const normalizedContent = normalizeDingtalkCardMarkdown(content);
      await cardRequest('v1.0/card/streaming', {
        method: 'PUT',
        body: {
          outTrackId: instanceId,
          guid: randomUUID(),
          key: 'msgContent',
          content: normalizedContent,
          isFull: true,
          isFinalize: true,
          isError: false,
        },
        headers,
        signal,
        action: 'AI Card 完成',
      });
      let completed = true;
      const completionRequest = {
        method: 'PUT',
        body: {
          outTrackId: instanceId,
          cardData: cardData(content, '3'),
          cardUpdateOptions: { updateCardDataByKey: true },
        },
        headers,
        signal,
        action: 'AI Card 收口',
      };
      try {
        await cardRequest('v1.0/card/instances', completionRequest);
      } catch {
        try {
          await cardRequest('v1.0/card/instances', completionRequest);
        } catch {
          completed = false;
        }
      }
      return { delivered: true, completed };
    },

    failAiCard: failCard,

    async sendText({ clientId, clientSecret, sessionWebhook, text, at, signal }) {
      const content = nonEmptyString(text);
      if (!content) throw new TypeError('text is required');
      const webhook = normalizeDingtalkSessionWebhook(sessionWebhook);
      const token = await accessToken({ clientId, clientSecret, signal });
      // 为什么带 at：钉钉新版群消息 API（robot/groupMessages/send）不支持 @ 群成员，
      // 群内“真@通知”（红点提醒）只能走回复消息模式的 sessionWebhook webhook 协议，
      // 在请求体携带 `at` 字段（atUserIds / atMobiles / isAtAll）实现。
      // 这里对调用方传入的 @ 目标做有效性校验：任一目标有效才拼入消息体，空 at 直接丢弃。
      const replyAt = at && typeof at === 'object'
        && ((Array.isArray(at.atUserIds) && at.atUserIds.length > 0)
          || (Array.isArray(at.atMobiles) && at.atMobiles.length > 0)
          || at.isAtAll === true)
        ? { at }
        : {};
      const response = await requestJson(fetchImpl, webhook, {
        body: { msgtype: 'text', text: { content }, ...replyAt },
        headers: { 'x-acs-dingtalk-access-token': token },
        signal,
        action: '消息回复',
      });
      if ((response?.errcode !== undefined && response.errcode !== 0)
        || (response?.code !== undefined && response.code !== 0)) {
        throw new DingtalkApiError('send-rejected', '钉钉服务拒绝了回复消息。');
      }
      return true;
    },

    async sendFile(request) {
      return sendArtifact(request, {
        uploadType: 'file',
        messageKey: 'sampleFile',
        createMessageParams: (mediaId, file) => ({
          mediaId,
          fileName: file.fileName,
          fileType: dingtalkFileType(file.fileName),
        }),
      });
    },

    async sendImage(request) {
      return sendArtifact(request, {
        uploadType: 'image',
        messageKey: 'sampleImageMsg',
        createMessageParams: (mediaId) => ({ photoURL: mediaId }),
      });
    },

    clearAccessToken(clientId) {
      const appKey = nonEmptyString(clientId);
      if (appKey) tokenCache.delete(appKey);
    },
  });
}

export const createDingTalkApi = createDingtalkApi;
export const normalizeDingTalkSessionWebhook = normalizeDingtalkSessionWebhook;
export const splitDingTalkText = splitDingtalkText;
