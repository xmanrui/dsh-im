import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export const AIRUMO_API = 'https://api.airumo.cn/_airumo/bot/v1';
const MAX_JSON = 16384;
const HALT = new Set(['BOT_INVALID_TOKEN', 'BOT_PAUSED']);
const TERMINAL = new Set([
  'BOT_REQUEST_FORBIDDEN',
  'BOT_REQUEST_NOT_FOUND',
  'M_NOT_FOUND',
  'BOT_REQUEST_TERMINAL',
]);

export class AirumoError extends Error {
  constructor(code, status = 0, retryAfterMs = 0) {
    super(`AIRumo ${code}`);
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.halt = HALT.has(code);
    this.terminal = TERMINAL.has(code);
    this.retryable =
      !this.halt &&
      !this.terminal &&
      (status === 0 ||
        status >= 500 ||
        status === 429 ||
        ['BOT_POLL_CONFLICT', 'BOT_CONSUMER_CONFLICT'].includes(code));
  }
}

async function bytes(response, limit) {
  const chunks = [];
  let size = 0;
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new AirumoError('RESPONSE_TOO_LARGE', 413);
  }
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit) throw new AirumoError('RESPONSE_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export class AirumoApi {
  constructor(token, { fetchImpl = fetch, baseUrl = AIRUMO_API } = {}) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new TypeError('AIRumo API requires a trusted HTTPS base URL');
    this.base = url.href.replace(/\/$/, '');
    this.origin = url.origin;
    this.token = token;
    this.fetch = fetchImpl;
  }

  async call(method, path, data, signal, { binary = false, timeout = 20000 } = {}) {
    const body = data === undefined ? undefined : binary ? data : JSON.stringify(data);
    if (!binary && body && Buffer.byteLength(body) > MAX_JSON)
      throw new AirumoError('LOCAL_JSON_TOO_LARGE', 413);
    let response;
    try {
      response = await this.fetch(`${this.base}${path}`, {
        method,
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined
            ? {}
            : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' }),
        },
        body,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
          : AbortSignal.timeout(timeout),
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw new AirumoError('NETWORK_ERROR');
    }
    let value;
    try {
      value = JSON.parse((await bytes(response, 512000)).toString('utf8'));
    } catch {
      throw new AirumoError('INVALID_RESPONSE', response.ok ? 502 : response.status);
    }
    if (!response.ok) {
      const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(value.errcode)
        ? value.errcode
        : `HTTP_${response.status}`;
      throw new AirumoError(
        code,
        response.status,
        Number.isFinite(value.retry_after_ms) ? Math.max(0, value.retry_after_ms) : 0,
      );
    }
    return value;
  }

  async me(signal) {
    const me = await this.call('GET', '/me', undefined, signal);
    if (
      me.protocol !== 'airumo.bot.v1' ||
      typeof me.user_agent_id !== 'string' ||
      !me.user_agent_id ||
      typeof me.name !== 'string' ||
      !me.name ||
      me.api_base_url?.replace(/\/$/, '') !== this.base
    )
      throw new AirumoError('IDENTITY_INVALID', 400);
    return me;
  }

  async updates(consumer, signal) {
    const result = await this.call(
      'POST',
      '/updates',
      { timeout: 30, limit: 10, consumer_id: consumer },
      signal,
      { timeout: 45000 },
    );
    if (!Array.isArray(result.updates) || result.updates.length > 50)
      throw new AirumoError('INVALID_UPDATES', 502);
    return result.updates;
  }

  request(id, signal) {
    return this.call('GET', `/requests/${encodeURIComponent(id)}`, undefined, signal);
  }
  accept(id, consumer, signal) {
    return this.call(
      'POST',
      `/requests/${encodeURIComponent(id)}/accept`,
      { consumer_id: consumer },
      signal,
    );
  }
  result(id, value, signal) {
    return this.call('POST', `/requests/${encodeURIComponent(id)}/results`, value, signal);
  }
  status(agent_state, error_code, signal) {
    return this.call('POST', '/status', { agent_state, error_code }, signal);
  }
  progress(id, execution_id, text, signal) {
    return this.call(
      'POST',
      `/requests/${encodeURIComponent(id)}/progress`,
      { execution_id, text },
      signal,
    );
  }

  async download(id, mediaId, signal) {
    const info = await this.call(
      'GET',
      `/requests/${encodeURIComponent(id)}/media/${encodeURIComponent(mediaId)}`,
      undefined,
      signal,
    );
    if (
      !Number.isSafeInteger(info.size_bytes) ||
      info.size_bytes < 0 ||
      info.size_bytes > 30 * 1024 * 1024
    )
      throw new AirumoError('INPUT_FILE_TOO_LARGE', 413);
    const url = new URL(info.url);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new AirumoError('INVALID_MEDIA_URL', 400);
    const response = await this.fetch(url.href, {
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      // Signed media URLs carry their own authorization. Never forward the Bot Token.
    });
    if (!response.ok) throw new AirumoError('MEDIA_DOWNLOAD_FAILED', response.status);
    const data = await bytes(response, info.size_bytes);
    if (
      data.length !== info.size_bytes ||
      (info.sha256 && createHash('sha256').update(data).digest('hex') !== info.sha256)
    )
      throw new AirumoError('MEDIA_DIGEST_MISMATCH', 400);
    return { data, name: info.original_filename, mediaType: info.mime_type };
  }

  async upload(id, file, signal) {
    const repeat = async (operation) => {
      for (let n = 0; ; n++) {
        try {
          return await operation();
        } catch (error) {
          if (signal?.aborted || !error.retryable) throw error;
          await sleep(
            Math.max(error.retryAfterMs, Math.min(30000, 1000 * 2 ** Math.min(n, 5))),
            undefined,
            { signal },
          );
        }
      }
    };
    const prefix = `/requests/${encodeURIComponent(id)}`;
    const upload = await this.call(
      'POST',
      `${prefix}/uploads`,
      {
        filename: file.fileName,
        mime_type: file.mediaType,
        size_bytes: file.bytes.length,
        sha256: createHash('sha256').update(file.bytes).digest('hex'),
      },
      signal,
    );
    if (
      typeof upload.upload_id !== 'string' ||
      !Number.isSafeInteger(upload.part_size) ||
      upload.part_size <= 0 ||
      upload.part_count !== Math.ceil(file.bytes.length / upload.part_size)
    )
      throw new AirumoError('INVALID_UPLOAD', 502);
    const path = `${prefix}/uploads/${encodeURIComponent(upload.upload_id)}`;
    for (let n = 1; n <= upload.part_count; n++) {
      await repeat(() =>
        this.call(
          'PUT',
          `${path}/parts/${n}`,
          file.bytes.subarray((n - 1) * upload.part_size, n * upload.part_size),
          signal,
          { binary: true, timeout: 60000 },
        ),
      );
    }
    const done = await repeat(() => this.call('POST', `${path}/complete`, {}, signal));
    if (typeof done.media_id !== 'string' || !done.media_id)
      throw new AirumoError('INVALID_UPLOAD_RESULT', 502);
    return { media_id: done.media_id };
  }
}

export async function inspectAirumoToken(token) {
  const me = await new AirumoApi(token).me();
  return { platformId: me.user_agent_id, name: me.name };
}

export function validateUpdate(u) {
  for (const key of ['request_id', 'session_id', 'room_id']) {
    if (typeof u?.[key] !== 'string' || !u[key] || u[key].length > 512)
      throw new AirumoError('INVALID_UPDATE', 400);
  }
  if (
    !Number.isSafeInteger(u.deadline_ts) ||
    typeof u.message?.sender !== 'string' ||
    typeof u.message?.content?.body !== 'string' ||
    u.message.content.body.length > 64000 ||
    !Array.isArray(u.attachments ?? []) ||
    (u.attachments ?? []).some((a) => typeof a.media_id !== 'string')
  )
    throw new AirumoError('INVALID_UPDATE', 400);
  return u;
}
