import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const UNKNOWN_SEND_CODES = new Set([
  'outcome_unknown', 'readback_ambiguous', 'input_not_cleared', 'restore_failed',
]);

function protocolError(code, message, options = {}) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

function nonEmptyCode(value) {
  return typeof value === 'string' && value ? value : null;
}

function errorCodeForJournal(error) {
  return nonEmptyCode(error?.code) ?? 'journal-unavailable';
}

function positiveTimeout(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(label + ' must be a positive number');
  }
  return value;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

/**
 * Own the hidden Python adapter and its JSONL boundary. No method in this class
 * retries a send: once a request ID is reserved, every later submission shares
 * the original success, unknown outcome, or failure.
 */
export class WechatGroupProcess extends EventEmitter {
  #groups;
  #scriptPath;
  #configPath;
  #spawnImpl;
  #logger;
  #healthTimeoutMs;
  #sendTimeoutMs;
  #stopTimeoutMs;
  #startTimeoutMs;
  #requestIdFactory;
  #allowUnverifiedRead = false;
  #allowSend = false;
  #allowWindowRestore = false;
  #child = null;
  #buffer = '';
  #decoder = null;
  #pending = new Map();
  #outbound = new Map();
  #journalPath = null;
  #closedChildren = new WeakSet();
  #running = false;
  #ready = false;
  #starting = null;
  #startWait = null;
  #stopping = null;
  #generation = 0;
  #lastError = null;
  #adapterError = null;

  constructor({
    config,
    scriptPath,
    configPath,
    journalPath,
    spawnImpl = spawn,
    logger = console,
    healthTimeoutMs = 5_000,
    sendTimeoutMs = 30_000,
    stopTimeoutMs = 5_000,
    startTimeoutMs = 15_000,
    requestIdFactory = randomUUID,
  }) {
    super();
    if (!config || !Array.isArray(config.groups) || config.groups.length === 0) {
      throw new TypeError('WechatGroupProcess requires configured groups');
    }
    if (typeof scriptPath !== 'string' || !scriptPath) {
      throw new TypeError('scriptPath is required');
    }
    if (typeof configPath !== 'string' || !configPath) {
      throw new TypeError('configPath is required');
    }
    if (typeof spawnImpl !== 'function' || typeof requestIdFactory !== 'function') {
      throw new TypeError('spawnImpl and requestIdFactory must be functions');
    }
    this.#groups = new Map(config.groups.map((group) => [group.id, group]));
    // Config defaults are false, so a config that omits both switches stays
    // observe-safe: the adapter refuses to read or write until told otherwise.
    this.#allowUnverifiedRead = config.allowUnverifiedRead === true;
    this.#allowSend = config.allowSend === true;
    this.#allowWindowRestore = config.allowWindowRestore === true;
    this.#scriptPath = scriptPath;
    this.#configPath = configPath;
    this.#spawnImpl = spawnImpl;
    this.#logger = logger;
    this.#healthTimeoutMs = positiveTimeout(healthTimeoutMs, 'healthTimeoutMs');
    this.#sendTimeoutMs = positiveTimeout(sendTimeoutMs, 'sendTimeoutMs');
    this.#stopTimeoutMs = positiveTimeout(stopTimeoutMs, 'stopTimeoutMs');
    this.#startTimeoutMs = positiveTimeout(startTimeoutMs, 'startTimeoutMs');
    this.#requestIdFactory = requestIdFactory;
    if (journalPath !== undefined && journalPath !== null && typeof journalPath !== 'string') {
      throw new TypeError('journalPath must be a string or null');
    }
    this.#journalPath = journalPath === undefined
      ? join(dirname(configPath), 'group-outbound-journal.jsonl')
      : journalPath;
    this.#loadJournal();
  }

  get status() {
    return {
      ready: this.#ready,
      running: this.#running,
      pid: this.#running ? this.#child?.pid ?? null : null,
      pendingRequests: this.#pending.size,
      lastError: this.#lastError,
    };
  }

  // Translate the account config switches into the adapter's environment.
  // The Python adapter keeps its own environment gates (an operator may also
  // set them directly); this only propagates the config so a running host does
  // not need a restart to pick up an operator decision.
  #adapterEnv() {
    const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1' };
    if (this.#allowUnverifiedRead) env.DSH_WECHAT_GROUP_ALLOW_UNVERIFIED = '1';
    if (this.#allowSend) env.DSH_WECHAT_GROUP_ALLOW_SEND = '1';
    if (this.#allowWindowRestore) env.DSH_WECHAT_GROUP_ALLOW_WINDOW_RESTORE = '1';
    return env;
  }

  /** Start a new adapter generation and wait until its baseline emits ready. */
  start() {
    if (this.#running && this.#ready) return Promise.resolve(this.status);
    if (this.#starting) return this.#starting;
    if (this.#stopping) {
      return this.#stopping.then(() => this.start());
    }

    const generation = ++this.#generation;
    let child;
    try {
      child = this.#spawnImpl('py', [
        '-3.12', '-B', this.#scriptPath, '--config', this.#configPath,
      ], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.#adapterEnv(),
      });
    } catch (cause) {
      const error = protocolError('process-spawn-failed', 'Unable to start WeChat group adapter', { cause });
      this.#lastError = error.code;
      return Promise.reject(error);
    }
    if (!child?.stdin || !child?.stdout || typeof child.on !== 'function') {
      return Promise.reject(protocolError('process-spawn-failed', 'Invalid child process boundary'));
    }

    this.#child = child;
    this.#running = true;
    this.#ready = false;
    this.#lastError = null;
    this.#buffer = '';
    this.#decoder = new StringDecoder('utf8');

    // A generation-local latch makes error and close idempotent and prevents an
    // old child from changing the state of a newer adapter after a restart.
    let exitHandled = false;
    const handleExit = (exitCode, cause = null) => {
      if (exitHandled) return;
      exitHandled = true;
      this.#closedChildren.add(child);
      this.#handleChildExit(generation, child, exitCode, cause);
    };
    child.stdout.on('data', (chunk) => this.#onStdout(generation, child, chunk));
    child.stderr?.on('data', (chunk) => {
      // stderr can contain message text from third-party tracebacks; only its
      // size is useful to operators and safe to retain.
      this.#logger.warn?.('[dsh-weixin] group adapter stderr (' + chunk.length + ' bytes)');
    });
    child.on('error', (cause) => {
      try { child.kill('SIGTERM'); } catch { /* The process may already be gone. */ }
      handleExit(null, cause);
    });
    child.on('close', (exitCode) => handleExit(exitCode));

    const wait = deferred();
    const timer = setTimeout(() => {
      if (this.#startWait?.generation !== generation) return;
      const error = protocolError('start-timeout', 'WeChat group adapter baseline timed out');
      this.#ready = false;
      this.#running = false;
      this.#lastError = error.code;
      this.#rejectStart(error);
      try { child.kill('SIGTERM'); } catch { /* Already exited. */ }
    }, this.#startTimeoutMs);
    timer.unref?.();
    this.#startWait = { generation, ...wait, timer };
    this.#starting = wait.promise;
    wait.promise.then(
      () => { if (this.#starting === wait.promise) this.#starting = null; },
      () => { if (this.#starting === wait.promise) this.#starting = null; },
    );
    return wait.promise;
  }

  health() {
    return this.#request('health', {}, this.#healthTimeoutMs, 'health-timeout');
  }

  /** Reserve the outbound ID before writing one byte to the adapter. */
  sendText({ toUserId, text, requestId, request_id: legacyRequestId } = {}) {
    if (!this.#groups.has(toUserId)) {
      return Promise.reject(protocolError('unknown-group', 'Refusing to send to an unconfigured WeChat group'));
    }
    if (typeof text !== 'string' || !text.trim()) {
      return Promise.reject(new TypeError('text must be a non-empty string'));
    }
    const id = requestId ?? legacyRequestId ?? this.#requestIdFactory();
    if (typeof id !== 'string' || !id.trim()) {
      return Promise.reject(new TypeError('requestId must be a non-empty string'));
    }
    const payloadHash = createHash('sha256').update(JSON.stringify([toUserId, text])).digest('hex');
    const existing = this.#outbound.get(id);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        return Promise.reject(protocolError('request-id-conflict', 'Outbound request ID was reused for different content'));
      }
      return existing.promise;
    }

    const wait = deferred();
    this.#outbound.set(id, { chatId: toUserId, payloadHash, promise: wait.promise });
    // Both durable transitions precede stdin. A crash after this point reloads
    // as unknown instead of risking a second UIA bubble.
    try {
      this.#journalTransition(id, 'reserved');
      this.#journalTransition(id, 'sending');
    } catch (error) {
      wait.reject(error);
      return wait.promise;
    }
    this.#request('send_text', {
      request_id: id,
      chat_id: toUserId,
      text,
    }, this.#sendTimeoutMs, 'send-timeout', wait);
    return wait.promise;
  }

  /** Stop intake, settle the stop request, and reap even an uncooperative child. */
  async stop() {
    if (this.#stopping) return this.#stopping;
    const child = this.#child;
    if (!child) {
      this.#ready = false;
      this.#running = false;
      return this.status;
    }

    this.#ready = false;
    this.#rejectStart(protocolError('process-stopped', 'WeChat group adapter stopped'));
    this.#rejectAll(protocolError('process-stopped', 'WeChat group adapter stopped'));
    const stopping = (async () => {
      let failure = null;
      if (this.#running && !this.#closedChildren.has(child)) {
        try {
          await this.#request('stop', {}, this.#stopTimeoutMs, 'stop-timeout', null, true);
        } catch (error) {
          failure = error;
        }
      }
      await this.#reap(child);
      if (failure) {
        this.#lastError = failure.code;
        throw failure;
      }
      this.#lastError = null;
      return this.status;
    })();
    this.#stopping = stopping;
    try {
      return await stopping;
    } finally {
      if (this.#stopping === stopping) this.#stopping = null;
    }
  }

  #request(type, fields, timeoutMs, timeoutCode, existingWait = null, allowNotReady = false) {
    const wait = existingWait ?? deferred();
    const child = this.#child;
    if (!child || !this.#running || (!this.#ready && !allowNotReady)) {
      if (type === 'send_text') this.#markUnknown(fields.request_id, 'process-not-ready');
      wait.reject(protocolError('process-not-ready', 'WeChat group adapter is not ready'));
      return wait.promise;
    }
    const requestId = fields.request_id ?? this.#requestIdFactory();
    if (typeof requestId !== 'string' || !requestId) {
      wait.reject(new TypeError('request_id must be a non-empty string'));
      return wait.promise;
    }
    const request = { type, ...fields, request_id: requestId };
    const timer = setTimeout(() => {
      const pending = this.#pending.get(requestId);
      if (!pending) return;
      this.#pending.delete(requestId);
      if (type === 'send_text') this.#markUnknown(requestId, timeoutCode);
      pending.reject(protocolError(timeoutCode, type + ' request timed out'));
    }, timeoutMs);
    timer.unref?.();
    this.#pending.set(requestId, { type, resolve: wait.resolve, reject: wait.reject, timer });
    try {
      child.stdin.write(JSON.stringify(request) + '\n');
    } catch (cause) {
      const pending = this.#pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pending.delete(requestId);
      }
      if (type === 'send_text') this.#markUnknown(requestId, 'process-write-failed');
      wait.reject(protocolError('process-write-failed', 'Unable to write to WeChat group adapter', { cause }));
    }
    return wait.promise;
  }

  #onStdout(generation, child, chunk) {
    if (generation !== this.#generation || child !== this.#child || !this.#running) return;
    this.#buffer += this.#decoder.write(chunk);
    const lines = this.#buffer.split(/\r?\n/);
    this.#buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch (cause) {
        this.#protocolFailure(generation, child, protocolError(
          'invalid-jsonl', 'WeChat group adapter emitted invalid JSONL', { cause },
        ));
        return;
      }
      if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.type !== 'string') {
        this.#protocolFailure(generation, child, protocolError(
          'invalid-jsonl', 'WeChat group adapter emitted an invalid protocol record',
        ));
        return;
      }
      this.#onRecord(generation, child, record);
      if (!this.#running) return;
    }
  }

  #onRecord(generation, child, record) {
    if (record.type === 'ready') {
      if (generation !== this.#generation || child !== this.#child || this.#startWait?.generation !== generation) return;
      clearTimeout(this.#startWait.timer);
      const wait = this.#startWait;
      this.#startWait = null;
      this.#ready = true;
      this.#lastError = null;
      this.emit('ready');
      wait.resolve(this.status);
      return;
    }
    if (record.type === 'message') {
      // Python establishes its visible baseline before ready. Dropping anything
      // earlier here is a second defense against historical replay on restart.
      if (this.#ready && this.#running && child === this.#child) this.emit('message', record.message);
      return;
    }
    if (record.type === 'error') {
      const pending = this.#pending.get(record.request_id);
      if (pending) {
        this.#settlePending(record.request_id, pending);
        if (pending.type === 'send_text') this.#markUnknown(record.request_id, 'adapter-error');
        pending.reject(protocolError('adapter-error', 'WeChat group adapter rejected the request'));
      } else {
        // A startup failure arrives as a bare error frame before the child
        // exits. Dropping its code here is what made every real cause surface
        // as 'process-exit', so keep it and let the exit handler prefer it.
        const code = nonEmptyCode(record?.error?.code) ?? 'adapter-error';
        this.#adapterError = code;
        this.#lastError = code;
        this.#logger.warn?.('[dsh-weixin] group adapter reported a sanitized error (' + code + ')');
      }
      return;
    }
    if (!['health_result', 'send_result', 'stop_result'].includes(record.type)) {
      this.#protocolFailure(generation, child, protocolError(
        'invalid-protocol', 'WeChat group adapter emitted an unknown record type',
      ));
      return;
    }
    const pending = this.#pending.get(record.request_id);
    // Late responses and duplicate results have no pending entry. They must not
    // settle a newer request or unlock a second send.
    if (!pending) return;
    const expectedType = {
      health: 'health_result', send_text: 'send_result', stop: 'stop_result',
    }[pending.type];
    if (record.type !== expectedType) {
      this.#protocolFailure(generation, child, protocolError(
        'invalid-protocol', 'WeChat group adapter response type does not match request ID',
      ));
      return;
    }
    this.#settlePending(record.request_id, pending);
    if (record.type === 'health_result') {
      if (record.ok === true) pending.resolve(record);
      else pending.reject(protocolError('health-failed', 'WeChat group adapter is unhealthy'));
      return;
    }
    if (record.type === 'stop_result') {
      if (record.ok === true) pending.resolve(record);
      else pending.reject(protocolError('stop-failed', 'WeChat group adapter refused to stop'));
      return;
    }

    if (record.ok === true) {
      const ids = Array.isArray(record.provider_message_ids)
        ? record.provider_message_ids.filter((id) => typeof id === 'string' || Number.isSafeInteger(id)).map(String)
        : [];
      const result = {
        ok: true,
        status: 'sent',
        requestId: record.request_id,
        providerMessageIds: ids,
        provider_message_ids: ids,
      };
      try {
        this.#journalTransition(record.request_id, 'succeeded', { providerMessageIds: ids });
      } catch (error) {
        // The UIA send already happened but its success was not durable. Report
        // unknown rather than falsely acknowledging an unrecoverable receipt.
        this.#markUnknown(record.request_id, error.code);
        pending.resolve(this.#unknownResult(record.request_id, error.code));
        return;
      }
      pending.resolve(result);
      return;
    }
    const sendCode = nonEmptyCode(record.error?.code);
    if (record.status === 'unknown' || record.ok === 'unknown' || UNKNOWN_SEND_CODES.has(sendCode)) {
      this.#markUnknown(record.request_id, sendCode ?? 'outcome_unknown');
      pending.resolve(this.#unknownResult(record.request_id, sendCode));
      return;
    }
    this.#markUnknown(record.request_id, sendCode ?? 'send-rejected');
    pending.reject(protocolError('send-rejected', 'WeChat group adapter rejected the send'));
  }

  #loadJournal() {
    if (!this.#journalPath) return;
    let source;
    try {
      source = readFileSync(this.#journalPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw protocolError('journal-unavailable', 'Unable to read the outbound journal', { cause: error });
    }
    for (const line of source.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch (cause) {
        throw protocolError('journal-invalid', 'Outbound journal contains invalid JSONL', { cause });
      }
      const valid = record?.version === 1
        && nonEmptyCode(record.requestId)
        && nonEmptyCode(record.chatId)
        && typeof record.payloadHash === 'string'
        && /^[a-f0-9]{64}$/.test(record.payloadHash)
        && ['reserved', 'sending', 'succeeded', 'unknown'].includes(record.state);
      if (!valid) throw protocolError('journal-invalid', 'Outbound journal record is invalid');
      const providerMessageIds = Array.isArray(record.providerMessageIds)
        ? record.providerMessageIds.filter((id) => typeof id === 'string').map(String)
        : [];
      const result = record.state === 'succeeded'
        ? {
            ok: true,
            status: 'sent',
            requestId: record.requestId,
            providerMessageIds,
            provider_message_ids: providerMessageIds,
          }
        : {
            ok: false,
            status: 'unknown',
            code: nonEmptyCode(record.code) ?? 'outcome_unknown',
            requestId: record.requestId,
            providerMessageIds: [],
            provider_message_ids: [],
          };
      // Fold append-only transitions into one in-memory reservation. Unfinished
      // records intentionally take the unknown branch and can never resend.
      this.#outbound.set(record.requestId, {
        chatId: record.chatId,
        payloadHash: record.payloadHash,
        promise: Promise.resolve(result),
      });
    }
  }

  #unknownResult(requestId, code) {
    return {
      ok: false,
      status: 'unknown',
      code: nonEmptyCode(code) ?? 'outcome_unknown',
      requestId,
      providerMessageIds: [],
      provider_message_ids: [],
    };
  }

  #journalTransition(requestId, state, { code = null, providerMessageIds = [] } = {}) {
    if (!this.#journalPath) return;
    const reservation = this.#outbound.get(requestId);
    if (!reservation) return;
    const record = {
      version: 1,
      requestId,
      chatId: reservation.chatId,
      payloadHash: reservation.payloadHash,
      state,
      code,
      providerMessageIds,
      updatedAt: new Date().toISOString(),
    };
    try {
      // Only hashes and lifecycle metadata cross the disk boundary; message
      // bodies never appear in this journal or in its error messages.
      appendFileSync(this.#journalPath, JSON.stringify(record) + '\n', 'utf8');
    } catch (cause) {
      throw protocolError('journal-unavailable', 'Unable to persist the outbound journal', { cause });
    }
  }

  #markUnknown(requestId, code) {
    try {
      this.#journalTransition(requestId, 'unknown', { code: nonEmptyCode(code) });
    } catch (error) {
      this.#lastError = errorCodeForJournal(error);
    }
  }

  #settlePending(requestId, pending) {
    clearTimeout(pending.timer);
    this.#pending.delete(requestId);
  }

  #protocolFailure(generation, child, error) {
    if (generation !== this.#generation || child !== this.#child) return;
    this.#ready = false;
    this.#running = false;
    this.#lastError = error.code;
    this.#rejectStart(error);
    this.#rejectAll(error);
    this.#logger.error?.('[dsh-weixin] group adapter protocol failure: ' + error.code);
    this.emit('protocolError', error);
    try { child.kill('SIGTERM'); } catch { /* Already exited. */ }
  }

  #handleChildExit(generation, child, exitCode, cause) {
    if (generation !== this.#generation || child !== this.#child) return;
    const wasStopping = Boolean(this.#stopping);
    this.#child = null;
    this.#ready = false;
    this.#running = false;
    this.#buffer = '';
    // Prefer the adapter's own stable code: an exit is only the mechanical
    // result of it, and 'process-exit' would hide why the bridge could not run.
    const adapterCode = wasStopping ? null : this.#adapterError;
    this.#adapterError = null;
    const error = cause
      ? protocolError('process-error', 'WeChat group adapter failed', { cause })
      : adapterCode
        ? protocolError(adapterCode, 'WeChat group adapter could not start')
        : protocolError('process-exit', 'WeChat group adapter exited');
    if (!wasStopping) this.#lastError = error.code;
    this.#rejectStart(error);
    this.#rejectAll(error);
    this.emit('exit', { code: exitCode, error: wasStopping ? null : error.code });
  }

  #rejectStart(error) {
    const wait = this.#startWait;
    if (!wait) return;
    clearTimeout(wait.timer);
    this.#startWait = null;
    wait.reject(error);
  }

  #rejectAll(error) {
    for (const [requestId, pending] of this.#pending) {
      clearTimeout(pending.timer);
      if (pending.type === 'send_text') this.#markUnknown(requestId, error.code);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  async #reap(child) {
    if (this.#closedChildren.has(child)) {
      if (this.#child === child) this.#child = null;
      this.#ready = false;
      this.#running = false;
      return;
    }
    try { child.kill('SIGTERM'); } catch { /* Continue to the close wait. */ }
    let closed = await this.#waitForClose(child, this.#stopTimeoutMs);
    if (!closed) {
      try { child.kill('SIGKILL'); } catch { /* The close event may have raced us. */ }
      closed = await this.#waitForClose(child, this.#stopTimeoutMs);
    }
    if (this.#child === child) this.#child = null;
    this.#ready = false;
    this.#running = false;
    if (!closed) {
      throw protocolError('stop-timeout', 'WeChat group adapter did not exit after termination');
    }
  }

  #waitForClose(child, timeoutMs) {
    if (this.#closedChildren.has(child)) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener('close', onClose);
        resolve(value);
      };
      const onClose = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      child.once('close', onClose);
    });
  }
}
