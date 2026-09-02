import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { adoptRegisteredWorkspaceSession } from './harness-session-binding.mjs';
import {
  appendInboundFilesToPrompt,
  InboundFileError,
  normalizeInboundRetention,
} from './inbound-file.mjs';
import {
  IMAGE_FILE_FALLBACK_PROMPT,
  contentWithoutImages,
  imageFileSourcesFromContent,
  isModelImageRejection,
} from './image-prompt.mjs';
import { outboundArtifactRegistry } from './semantic/artifact.mjs';
import { t } from './i18n.mjs';
import { watchHarnessMux } from './harness-mux.mjs';

// Every channel plugin runs in the same Host process. Sharing ownership by
// Host identity (or an explicitly configured HTTP origin) prevents clients
// bound to one Session
// from claiming or cancelling each other's interactions.
const interactionRegistries = new Map();
const hostInteractionRegistries = new WeakMap();
const MAX_ERROR_CLASSIFICATION_BYTES = 64;

async function smallResponseText(response) {
  const stream = response?.body;
  if (!stream || typeof stream.getReader !== 'function') return null;

  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)
        || length + value.byteLength > MAX_ERROR_CLASSIFICATION_BYTES) return null;
      chunks.push(value);
      length += value.byteLength;
    }
  } catch {
    return null;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The response body is diagnostic-only; cancellation failures do not
      // replace the HTTP status that caused the transport error.
    }
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function isLoopbackHarnessHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

async function harnessHttpErrorCode(response, hostname) {
  if (response.status === 401) return 'harness-auth-required';
  if (response.status === 407) return 'harness-proxy-auth-required';
  if (response.status === 403) {
    const body = await smallResponseText(response);
    if (body?.trim() !== 'forbidden') return 'harness-request-forbidden';
    return isLoopbackHarnessHostname(hostname)
      ? 'harness-loopback-forbidden'
      : 'harness-host-untrusted';
  }
  if (response.status === 404) return 'harness-api-not-found';
  return 'harness-http-failed';
}

function interactionRegistry(scope) {
  const registries = typeof scope === 'string' ? interactionRegistries : hostInteractionRegistries;
  let registry = registries.get(scope);
  if (!registry) {
    registry = {
      ownerships: new Map(),
      claims: new Map(),
      controls: new WeakMap(),
      nextOrder: 0,
    };
    registries.set(scope, registry);
  }
  return registry;
}

// A Host RPC may not accept cancellation itself. Bound the caller's wait
// without retrying an operation that the Host may already have accepted.
function callWithSignal(call, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', handleAbort);
    const handleAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    if (signal.aborted) {
      handleAbort();
      return;
    }
    signal.addEventListener('abort', handleAbort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return call();
    }).then((value) => {
      cleanup();
      resolve(value);
    }, (error) => {
      cleanup();
      reject(error);
    });
  });
}

function normalizeControl(control) {
  const ownerType = typeof control?.owner;
  if ((ownerType !== 'object' && ownerType !== 'function')
    || control.owner === null
    || typeof control.key !== 'string'
    || !control.key) return null;
  return { owner: control.owner, key: control.key };
}

function validModelSelection(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.provider === 'string'
    && Boolean(value.provider)
    && typeof value.model === 'string'
    && Boolean(value.model)
    && (value.reasoningEffort === undefined
      || (typeof value.reasoningEffort === 'string' && Boolean(value.reasoningEffort)));
}

function validModelReasoning(value) {
  return value !== null
    && typeof value === 'object'
    && Array.isArray(value.efforts)
    && value.efforts.length > 0
    && value.efforts.every((effort) => (
      effort !== null
      && typeof effort === 'object'
      && typeof effort.id === 'string'
      && Boolean(effort.id)
      && typeof effort.name === 'string'
      && Boolean(effort.name)
      && (effort.description === undefined || typeof effort.description === 'string')
    ))
    && (value.defaultEffort === undefined
      || (typeof value.defaultEffort === 'string' && Boolean(value.defaultEffort)));
}

function validateModelCatalog(value, method, { session = false } = {}) {
  if (!value || typeof value !== 'object'
    || !Array.isArray(value.groups)
    || !Array.isArray(value.failures)) {
    throw new Error(`Harness returned an invalid response for ${method}`);
  }
  for (const group of value.groups) {
    if (!group || typeof group !== 'object'
      || typeof group.id !== 'string' || !group.id
      || typeof group.name !== 'string' || !group.name
      || !Array.isArray(group.models)) {
      throw new Error(`Harness returned an invalid response for ${method}`);
    }
    for (const model of group.models) {
      if (!model || typeof model !== 'object'
        || typeof model.id !== 'string' || !model.id
        || typeof model.name !== 'string' || !model.name
        || (model.description !== undefined && typeof model.description !== 'string')
        || (model.reasoning !== undefined && !validModelReasoning(model.reasoning))) {
        throw new Error(`Harness returned an invalid response for ${method}`);
      }
    }
  }
  for (const failure of value.failures) {
    if (!failure || typeof failure !== 'object'
      || typeof failure.id !== 'string' || !failure.id
      || typeof failure.name !== 'string' || !failure.name
      || (failure.message !== undefined && typeof failure.message !== 'string')) {
      throw new Error(`Harness returned an invalid response for ${method}`);
    }
  }
  if (session && (!validModelSelection(value.current) || typeof value.routable !== 'boolean')) {
    throw new Error(`Harness returned an invalid response for ${method}`);
  }
  return value;
}

function turnStoppedError() {
  const error = new Error('Harness turn was stopped before producing a text reply');
  error.code = 'turn-stopped';
  return error;
}

function workspacePaths(value) {
  if (!Array.isArray(value?.items)) return [];
  return value.items.flatMap((item) => (
    typeof item?.path === 'string' && isAbsolute(item.path) ? [item.path] : []
  ));
}

function workspaceFromList(workspacePath, workspaceList) {
  if (!Array.isArray(workspaceList?.items)
    || !Array.isArray(workspaceList?.archivedSessionIds)) {
    throw new Error('Harness returned an invalid response for workspace.list');
  }

  const workspace = workspaceList.items.find((item) => item?.path === workspacePath);
  if (!workspace) return null;
  if (!Array.isArray(workspace.sessionIds)
    || workspace.sessionIds.some((sessionId) => typeof sessionId !== 'string')) {
    throw new Error('Harness returned invalid session IDs for workspace.list');
  }
  return workspace;
}

function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function sessionTimeMs(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const candidates = [
    summary?.header?.lastActivityAt,
    summary?.header?.updatedAt,
    summary?.header?.createdAt,
    summary?.projections?.values?.lastActivityAt,
    summary?.projections?.values?.updatedAt,
    summary?.projections?.values?.createdAt,
    summary?.lastActivityAt,
    summary?.updatedAt,
    summary?.createdAt,
  ];
  for (const value of candidates) {
    const ms = toEpochMs(value);
    if (ms !== null) return ms;
  }
  return null;
}

function workspaceSessions(workspace, archivedSessionIds, sessionList) {
  if (!Array.isArray(sessionList?.items)) {
    throw new Error('Harness returned an invalid response for session.list');
  }

  const archived = new Set(archivedSessionIds);
  const summaries = new Map(sessionList.items.flatMap((item) => (
    typeof item?.sessionId === 'string' ? [[item.sessionId, item]] : []
  )));
  return {
    workspace: workspace.path,
    sessions: workspace.sessionIds.map((sessionId) => {
      const summary = summaries.get(sessionId);
      const title = summary?.projections?.values?.title;
      const session = {
        sessionId,
        title: typeof title === 'string' ? title : null,
        archived: archived.has(sessionId),
        blank: summary?.blank === true,
        origin: summary?.origin === 'subagent' ? 'subagent' : null,
        summaryAvailable: summary !== undefined,
      };
      const lastSeq = summary?.projections?.asOfSeq;
      // This is the projection's durable lower bound, not necessarily the live
      // log tail for a cold session. Harness uses -1 as the legitimate bound
      // for a session with no projected events yet.
      if (Number.isSafeInteger(lastSeq) && lastSeq >= -1) session.lastSeq = lastSeq;
      const time = sessionTimeMs(summary);
      if (time !== null) session.time = time;
      return session;
    }),
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function assistantMessageText(event) {
  return (event?.data?.message?.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Flatten a tool/result error payload into a displayable one-line reason. */
function toolResultErrorText(error) {
  if (!error || typeof error !== 'object') return null;
  const message = nonEmptyText(error.message);
  if (message) return message;
  const name = nonEmptyText(error.name);
  const code = nonEmptyText(error.code);
  if (name || code) return [name ?? 'Error', code].filter(Boolean).join(': ');
  return null;
}

function consumeInteractionOwnership(ownership, entries) {
  const ordered = [...entries]
    .map((entry) => entry?.event ?? entry)
    .filter(Boolean)
    .sort((left, right) => (left.seq ?? -1) - (right.seq ?? -1));

  for (const event of ordered) {
    const seq = event.seq ?? -1;
    if (seq <= ownership.lastSeq) continue;
    ownership.lastSeq = seq;

    if (event.type === 'turn/start') {
      const turn = event.data?.turn ?? null;
      if (ownership.active && turn !== ownership.turn) ownership.active = false;
      if (ownership.turn !== null && turn !== ownership.turn) ownership.completed = true;
      ownership.openTurn = turn;
      continue;
    }
    if (event.type === 'user/message' && event.data?.source?.rpcId === ownership.promptRpcId) {
      ownership.active = true;
      ownership.started = true;
      ownership.completed = false;
      ownership.turn = event.data?.turn ?? ownership.openTurn;
      continue;
    }
    if (event.type === 'turn/end' && event.data?.turn === ownership.turn) {
      ownership.active = false;
      ownership.completed = true;
      continue;
    }
    let toolCall = null;
    if (event.type === 'tool/call'
      && ownership.active
      && event.data?.turn === ownership.turn
      && typeof event.data?.callId === 'string'
      && event.data.callId) {
      toolCall = {
        callId: event.data.callId,
        name: event.data?.name,
        arguments: event.data?.arguments,
      };
    } else if (event.type === 'tool/code-dispatch-start'
      && ownership.active
      && typeof event.data?.subCallId === 'string'
      && event.data.subCallId) {
      let argumentsText;
      try {
        argumentsText = JSON.stringify(event.data?.arguments);
      } catch {
        argumentsText = undefined;
      }
      toolCall = {
        callId: event.data.subCallId,
        name: event.data?.name,
        arguments: argumentsText,
      };
    }
    if (toolCall) ownership.toolCalls.set(toolCall.callId, Object.freeze(toolCall));
  }
}

/**
 * Decide whether the current Host has a live dsh-im interaction watcher for
 * this Session.  The modern Harness adapter uses the same ownership registry
 * as HarnessClient so it never steals a browser-owned question or approval.
 */
export function hasActiveHarnessInteractionOwner(scope, sessionId, entries = []) {
  if (!scope || !['object', 'function', 'string'].includes(typeof scope)
    || typeof sessionId !== 'string' || !sessionId) return false;
  const owners = interactionRegistry(scope).ownerships.get(sessionId);
  if (!owners || owners.size === 0) return false;
  for (const ownership of owners) consumeInteractionOwnership(ownership, entries);
  return [...owners].some((ownership) => (
    ownership.active
    && !ownership.completed
    && typeof ownership.reconnect === 'function'
  ));
}

export class HarnessReplyTracker {
  #promptRpcId;
  #lastSeq;
  #openTurn = null;
  #targetTurn = null;
  #stepText = new Map();
  #latestText = '';
  #finished = false;
  #reason = null;
  #toolNames = new Map();
  #lastToolName = null;

  constructor({ promptRpcId, afterSeq = -1 }) {
    this.#promptRpcId = promptRpcId;
    this.#lastSeq = afterSeq;
  }

  get finished() {
    return this.#finished;
  }

  get answer() {
    return this.#latestText.trim();
  }

  get reason() {
    return this.#reason;
  }

  get tracking() {
    return this.#targetTurn !== null && !this.#finished;
  }

  get turn() {
    return this.#targetTurn;
  }

  consumeAll(entries) {
    const updates = [];
    // 同一批轮询内的 text 帧只保留最新累积，其余事件逐帧透出，
    // 让消费方能按顺序看到每个工具调用与结果。
    const pushUpdate = (update) => {
      if (update.type === 'text' && updates.length > 0) {
        const last = updates[updates.length - 1];
        if (last.type === 'text') {
          updates[updates.length - 1] = update;
          return;
        }
      }
      updates.push(update);
    };
    const ordered = [...entries]
      .map((entry) => entry?.event ?? entry)
      .filter(Boolean)
      .sort((left, right) => (left.seq ?? -1) - (right.seq ?? -1));

    for (const event of ordered) {
      const seq = event.seq ?? -1;
      if (seq <= this.#lastSeq) continue;
      this.#lastSeq = seq;

      if (event.type === 'turn/start') this.#openTurn = event.data?.turn ?? null;

      if (event.type === 'user/message' && event.data?.source?.rpcId === this.#promptRpcId) {
        this.#targetTurn = this.#openTurn;
        continue;
      }
      if (this.#targetTurn === null) continue;

      if (event.type === 'turn/end') {
        if (event.data?.turn !== this.#targetTurn) continue;
        this.#finished = true;
        this.#reason = event.data?.reason ?? null;
        this.#openTurn = null;
        continue;
      }
      if (event.data?.turn !== this.#targetTurn) continue;

      if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'text-delta') {
        const step = event.data?.step ?? 0;
        const index = event.data.chunk.index ?? 0;
        const key = `${step}:${index}`;
        this.#stepText.set(key, (this.#stepText.get(key) ?? '') + event.data.chunk.text);
        const prefix = `${step}:`;
        const text = [...this.#stepText.entries()]
          .filter(([partKey]) => partKey.startsWith(prefix))
          .sort(([left], [right]) => Number(left.split(':')[1]) - Number(right.split(':')[1]))
          .map(([, part]) => part)
          .join('\n')
          .trim();
        if (text && text !== this.#latestText) {
          this.#latestText = text;
          pushUpdate({ type: 'text', text });
        }
        continue;
      }

      if (event.type === 'assistant/message') {
        const text = assistantMessageText(event);
        if (text && text !== this.#latestText) {
          this.#latestText = text;
          pushUpdate({ type: 'text', text });
        }
        continue;
      }

      if (event.type === 'tool/call') {
        const name = nonEmptyText(event.data?.name) ?? t('工具');
        const callId = nonEmptyText(event.data?.callId)
          ?? nonEmptyText(event.data?.subCallId);
        if (callId) this.#toolNames.set(callId, name);
        this.#lastToolName = name;
        pushUpdate({ type: 'tool', name, ...(callId ? { callId } : {}) });
      } else if (event.type === 'tool/result') {
        const callId = nonEmptyText(event.data?.message?.source?.callId)
          ?? nonEmptyText(event.data?.callId)
          ?? nonEmptyText(event.data?.subCallId);
        const toolName = (callId ? this.#toolNames.get(callId) : null)
          ?? this.#lastToolName;
        const error = toolResultErrorText(event.data?.error);
        pushUpdate({
          type: 'status',
          text: t('正在整理结果…'),
          ...(toolName ? { toolName } : {}),
          ...(error ? { error } : {}),
        });
      }
    }
    return updates;
  }

  consume(entries) {
    return this.consumeAll(entries).at(-1) ?? null;
  }
}

export class HarnessRpcError extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message ?? 'unknown Harness RPC error'}`);
    this.name = 'HarnessRpcError';
    this.method = method;
    this.code = error?.code ?? 'internal';
    this.details = error?.details ?? {};
  }
}

export class HarnessTransportError extends Error {
  constructor(code, method, { cause, status } = {}) {
    const statusDetail = Number.isInteger(status) ? `, HTTP ${status}` : '';
    super(`Harness ${method} transport failed (${code}${statusDetail})`, { cause });
    this.name = 'HarnessTransportError';
    this.code = code;
    this.method = method;
    if (Number.isInteger(status)) this.status = status;
  }
}

export class HarnessHealthError extends Error {
  constructor(cause) {
    super('Harness health RPC was rejected', { cause });
    this.name = 'HarnessHealthError';
    this.code = 'harness-rpc-rejected';
    this.method = 'host.describe';
  }
}

export class HarnessInteractionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HarnessInteractionError';
    this.code = code;
  }
}

export class HarnessTurnError extends Error {
  constructor(code, { reason, providerCode } = {}) {
    super(`Harness turn failed (${code})`);
    this.name = 'HarnessTurnError';
    this.code = code;
    this.promptAccepted = true;
    if (reason && typeof reason === 'object') this.reason = reason;
    if (typeof providerCode === 'string' && providerCode) this.providerCode = providerCode;
  }
}

function harnessTurnError(reason) {
  const kind = nonEmptyText(reason?.kind) ?? nonEmptyText(reason);
  if (kind === 'error') {
    const failure = reason?.error ?? reason?.failure;
    return new HarnessTurnError('harness-turn-failed', {
      reason,
      providerCode: nonEmptyText(failure?.code) ?? undefined,
    });
  }
  if (kind === 'max-tokens') return new HarnessTurnError('model-max-tokens', { reason });
  if (kind === 'blocked') return new HarnessTurnError('turn-blocked', { reason });
  if (['interrupted', 'stopped', 'cancelled', 'canceled'].includes(kind)) {
    return new HarnessTurnError('turn-interrupted', { reason });
  }
  if (kind === 'aborted') return new HarnessTurnError('turn-aborted', { reason });
  if (kind === 'completed') return new HarnessTurnError('model-empty-response', { reason });
  return new HarnessTurnError('harness-turn-failed', { reason });
}

function harnessTurnSucceeded(reason) {
  if (reason === null || reason === undefined) return true;
  return (nonEmptyText(reason?.kind) ?? nonEmptyText(reason)) === 'completed';
}

export class HarnessClient {
  #baseUrl;
  #apiProxy;
  #workspace;
  #agentPreset;
  #autostart;
  #dshBin;
  #fetch;
  #createWebSocket;
  #interactionReconnectDelayMs;
  #rpcIdPrefix;
  #logPrefix;
  #commandExecutor;
  #controlExecutor;
  #sessionMaintenanceExecutor;
  #fileIngressExecutor;
  #managedProcess = null;
  #interactionRegistry;
  #interactionOwnerships;
  #interactionClaims;
  #controlOwnerships;

  constructor({
    baseUrl,
    apiProxy,
    interactionScope = apiProxy,
    workspace,
    agentPreset,
    autostart = false,
    dshBin = 'dsh',
    fetchImpl = fetch,
    createWebSocket = (url) => new WebSocket(url),
    interactionReconnectDelayMs = 500,
    rpcIdPrefix = 'im',
    logPrefix = 'dsh-im',
    commandExecutor,
    controlExecutor,
    sessionMaintenanceExecutor,
    fileIngressExecutor,
  }) {
    if (typeof createWebSocket !== 'function') {
      throw new TypeError('createWebSocket must be a function');
    }
    if (!Number.isFinite(interactionReconnectDelayMs) || interactionReconnectDelayMs < 0) {
      throw new TypeError('interactionReconnectDelayMs must be a non-negative number');
    }
    if (typeof rpcIdPrefix !== 'string' || !rpcIdPrefix.trim()) {
      throw new TypeError('rpcIdPrefix must be a non-empty string');
    }
    if (typeof logPrefix !== 'string' || !logPrefix.trim()) {
      throw new TypeError('logPrefix must be a non-empty string');
    }
    if (commandExecutor !== undefined && typeof commandExecutor !== 'function') {
      throw new TypeError('commandExecutor must be a function');
    }
    if (controlExecutor !== undefined && typeof controlExecutor !== 'function') {
      throw new TypeError('controlExecutor must be a function');
    }
    if (sessionMaintenanceExecutor !== undefined
      && typeof sessionMaintenanceExecutor !== 'function') {
      throw new TypeError('sessionMaintenanceExecutor must be a function');
    }
    if (fileIngressExecutor !== undefined && typeof fileIngressExecutor !== 'function') {
      throw new TypeError('fileIngressExecutor must be a function');
    }
    this.#baseUrl = baseUrl === undefined ? null : new URL(baseUrl);
    this.#apiProxy = this.#baseUrl ? null : apiProxy;
    if (!this.#baseUrl && (!this.#apiProxy || typeof this.#apiProxy !== 'object')) {
      throw new TypeError('HarnessClient requires the current Host apiProxy or an explicit baseUrl');
    }
    if (this.#apiProxy && (!interactionScope
      || !['object', 'function'].includes(typeof interactionScope))) {
      throw new TypeError('interactionScope must identify the current Host');
    }
    this.#workspace = workspace;
    // Keep an omitted preset absent so session.create resolves the Host's current default.
    this.#agentPreset = agentPreset ?? undefined;
    this.#autostart = Boolean(this.#baseUrl && autostart);
    this.#dshBin = dshBin;
    this.#fetch = fetchImpl;
    this.#createWebSocket = createWebSocket;
    this.#interactionReconnectDelayMs = interactionReconnectDelayMs;
    this.#rpcIdPrefix = rpcIdPrefix.trim();
    this.#logPrefix = logPrefix.trim();
    this.#commandExecutor = commandExecutor;
    this.#controlExecutor = controlExecutor;
    this.#sessionMaintenanceExecutor = sessionMaintenanceExecutor;
    this.#fileIngressExecutor = fileIngressExecutor;
    this.#interactionRegistry = interactionRegistry(this.#baseUrl?.origin ?? interactionScope);
    this.#interactionOwnerships = this.#interactionRegistry.ownerships;
    this.#interactionClaims = this.#interactionRegistry.claims;
    this.#controlOwnerships = this.#interactionRegistry.controls;
  }

  async rpc(method, payload = {}, timeoutMs = 30_000, options = {}) {
    const rpcId = options.rpcId ?? `${this.#rpcIdPrefix}-${randomUUID()}`;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    let body;
    try {
      if (this.#apiProxy) {
        const [domain, action, extra] = method.split('.');
        const namespace = { host: 'host', workspace: 'workspace', session: 'sessions', llm: 'llm' }[domain];
        const api = namespace && this.#apiProxy[namespace];
        if (extra !== undefined || !Object.hasOwn(api ?? {}, action)
          || typeof api[action] !== 'function') {
          throw new HarnessTransportError('harness-api-not-found', method);
        }
        const response = await callWithSignal(() => api[action]({ rpcId, payload }, signal), signal);
        body = { type: 'server-response', ...response };
      } else {
        const response = await this.#fetch(new URL(`/api/${method}`, this.#baseUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
          signal,
        });
        if (!response.ok) {
          const code = await harnessHttpErrorCode(response, this.#baseUrl.hostname);
          throw new HarnessTransportError(code, method, { status: response.status });
        }
        try {
          body = await response.json();
        } catch (error) {
          throw new HarnessTransportError('harness-response-invalid', method, { cause: error });
        }
      }
    } catch (error) {
      // Preserve an explicit caller cancellation; it is control flow, not a
      // Harness availability diagnosis.
      if (options.signal?.aborted) throw error;
      if (error instanceof HarnessTransportError) throw error;
      throw new HarnessTransportError(
        timeoutSignal.aborted ? 'harness-timeout' : 'harness-connect-failed',
        method,
        { cause: error },
      );
    }
    if (body?.type !== 'server-response' || body?.rpcId !== rpcId) {
      throw new HarnessTransportError('harness-response-invalid', method, {
        cause: new Error(`Harness returned an invalid response for ${method}`),
      });
    }
    if (!body.result || typeof body.result !== 'object' || typeof body.result.ok !== 'boolean') {
      throw new HarnessTransportError('harness-response-invalid', method, {
        cause: new Error(`Harness returned an invalid result for ${method}`),
      });
    }
    if (!body.result?.ok) throw new HarnessRpcError(method, body.result?.error);
    return body.result.value;
  }

  async health(options = {}) {
    try {
      await this.rpc('host.describe', {}, 5_000, options);
      return true;
    } catch (error) {
      if (error instanceof HarnessRpcError) throw new HarnessHealthError(error);
      throw error;
    }
  }

  async ensureRunning(options = {}) {
    try {
      return await this.health(options);
    } catch (firstError) {
      if (!this.#autostart) throw firstError;
    }

    if (!this.#managedProcess || this.#managedProcess.exitCode !== null) {
      const port = this.#baseUrl.port || (this.#baseUrl.protocol === 'https:' ? '443' : '80');
      this.#managedProcess = spawn(this.#dshBin, [
        'web', '--host', this.#baseUrl.hostname, '--port', port,
      ], {
        cwd: this.#workspace,
        env: process.env,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      this.#managedProcess.on('error', (error) => {
        console.error(`[${this.#logPrefix}] failed to start Harness:`, error.message);
      });
    }

    const deadline = Date.now() + 60_000;
    let lastError;
    while (Date.now() < deadline) {
      await sleep(1_000, options.signal);
      try {
        return await this.health(options);
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    throw new HarnessTransportError('harness-timeout', 'host.describe');
  }

  async listWorkspaces(options = {}) {
    await this.ensureRunning(options);
    return workspacePaths(await this.rpc('workspace.list', {}, 30_000, options));
  }

  async listWorkspaceSessions(workspacePath, options = {}) {
    await this.ensureRunning(options);
    const workspaceList = await this.rpc('workspace.list', {}, 30_000, options);
    const workspace = workspaceFromList(workspacePath, workspaceList);
    if (!workspace) return { workspace: workspacePath, sessions: [] };
    const sessionList = await this.rpc('session.list', {}, 30_000, options);
    return workspaceSessions(workspace, workspaceList.archivedSessionIds, sessionList);
  }

  async listModels(options = {}) {
    await this.ensureRunning(options);
    const value = await this.rpc('llm.models', {}, 30_000, options);
    return validateModelCatalog(value, 'llm.models');
  }

  async getSessionModels(sessionId, options = {}) {
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId is required');
    await this.ensureRunning(options);
    const value = await this.rpc('session.models', { sessionId }, 30_000, options);
    return validateModelCatalog(value, 'session.models', { session: true });
  }

  async selectSessionModel(sessionId, selection, options = {}) {
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId is required');
    if (!validModelSelection(selection)) {
      throw new TypeError('A provider and model are required');
    }
    await this.ensureRunning(options);
    const operation = (maintenanceSignal) => {
      const signal = maintenanceSignal && options.signal
        ? AbortSignal.any([maintenanceSignal, options.signal])
        : (maintenanceSignal ?? options.signal);
      return this.rpc('session.selectModel', {
        sessionId,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selection.reasoningEffort }),
      }, 30_000, signal ? { ...options, signal } : options);
    };
    const value = this.#sessionMaintenanceExecutor
      ? await this.#sessionMaintenanceExecutor({ sessionId, operation })
      : await operation();
    if (!value || typeof value !== 'object' || !validModelSelection(value.selected)) {
      throw new Error('Harness returned an invalid response for session.selectModel');
    }
    return value;
  }

  async isSessionRunning(sessionId, options = {}) {
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId is required');
    await this.ensureRunning(options);
    const value = await this.rpc('session.list', {}, 30_000, options);
    if (!value || typeof value !== 'object' || !Array.isArray(value.items)) {
      throw new Error('Harness returned an invalid response for session.list');
    }
    for (const item of value.items) {
      if (!item || typeof item !== 'object'
        || typeof item.sessionId !== 'string' || !item.sessionId
        || typeof item.running !== 'boolean') {
        throw new Error('Harness returned an invalid response for session.list');
      }
    }
    return value.items.find((item) => item.sessionId === sessionId)?.running ?? false;
  }

  async adoptWorkspaceSession(value, options = {}) {
    return adoptRegisteredWorkspaceSession(this, value, options);
  }

  async workspaceId(options = {}) {
    const { workspace = this.#workspace, ...rpcOptions } = options;
    const { items } = await this.rpc('workspace.list', {}, 30_000, rpcOptions);
    const existing = items.find((item) => item.path === workspace);
    if (existing) return existing.workspaceId;
    const created = await this.rpc('workspace.create', { path: workspace }, 30_000, rpcOptions);
    return created.workspace.workspaceId;
  }

  async createSession(options = {}) {
    const { agentPreset: requestedPreset, ...rpcOptions } = options;
    await this.ensureRunning(rpcOptions);
    const workspaceId = await this.workspaceId(rpcOptions);
    const payload = { workspaceId };
    const agentPreset = requestedPreset !== undefined ? requestedPreset : this.#agentPreset;
    if (agentPreset != null) payload.agentPreset = agentPreset;
    const created = await this.rpc('session.create', payload, 30_000, rpcOptions);
    return created.sessionId;
  }

  async renameSession(sessionId, title, options = {}) {
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId is required');
    if (typeof title !== 'string' || !title.trim()) throw new TypeError('session title is required');
    return this.rpc('session.rename', { sessionId, title }, 30_000, options);
  }

  async executeCommand(sessionId, line, options = {}) {
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId is required');
    if (typeof line !== 'string' || !line) throw new TypeError('command line is required');
    if (!this.#commandExecutor) {
      const error = new Error('Harness command execution is unavailable');
      error.code = 'commands-unavailable';
      throw error;
    }
    try {
      return await this.#commandExecutor(sessionId, line, options);
    } catch (error) {
      if (error?.failure && typeof error.failure === 'object') {
        throw new HarnessRpcError('commands.execute', error.failure);
      }
      throw error;
    }
  }

  async readSessionHistory(sessionId, { maxMessages = 50, beforeSeq, timeoutMs = 10_000, ...options } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId is required');
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 1
      || (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0))) {
      throw new TypeError('Invalid history pagination');
    }
    return this.rpc('session.history', {
      sessionId,
      maxMessages,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    }, timeoutMs, options);
  }

  async sessionExists(sessionId, options = {}) {
    try {
      await this.rpc('session.history', { sessionId, maxMessages: 1 }, 30_000, options);
      return true;
    } catch (error) {
      if (error instanceof HarnessRpcError && error.code === 'session-not-found') return false;
      throw error;
    }
  }

  async respondInteraction(rpcId, result, options = {}) {
    if (typeof rpcId !== 'string' || !rpcId) throw new TypeError('rpcId is required');
    if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
      throw new TypeError('A Harness RPC result is required');
    }
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const envelope = { type: 'client-response', rpcId, result };
    let receipt;
    if (this.#apiProxy) {
      receipt = await callWithSignal(() => this.#apiProxy.respond(envelope), signal);
    } else {
      const response = await this.#fetch(new URL('/api/respond', this.#baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
        signal,
      });
      if (!response.ok) {
        throw new Error(`Harness transport respond failed: HTTP ${response.status}`);
      }
      receipt = await response.json();
    }
    if (receipt?.accepted === true) return receipt;
    if (receipt?.accepted !== false
      || (receipt.reason !== 'bad-response' && receipt.reason !== 'not-pending')) {
      throw new Error('Harness returned an invalid interaction response receipt');
    }
    const reason = receipt.reason;
    throw new HarnessInteractionError(
      `interaction-${reason}`,
      `Harness interaction response was rejected (${reason})`,
    );
  }

  async watchInteractions(sessionId, {
    signal,
    onInteraction,
    onResolved,
    onOpen,
    ownership,
  } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId is required');
    if (!signal || typeof signal.addEventListener !== 'function') {
      throw new TypeError('watchInteractions requires an AbortSignal');
    }
    if (onInteraction !== undefined && typeof onInteraction !== 'function') {
      throw new TypeError('onInteraction must be a function');
    }
    if (onResolved !== undefined && typeof onResolved !== 'function') {
      throw new TypeError('onResolved must be a function');
    }
    if (onOpen !== undefined && typeof onOpen !== 'function') {
      throw new TypeError('onOpen must be a function');
    }

    while (!signal.aborted) {
      try {
        await this.#watchInteractionStream(sessionId, {
          signal,
          onInteraction,
          onResolved,
          onOpen,
          ownership,
        });
      } catch (error) {
        if (signal.aborted) return;
        console.warn(`[${this.#logPrefix}] Harness interaction stream disconnected:`, error.message);
      }
      if (signal.aborted) return;
      try {
        await sleep(this.#interactionReconnectDelayMs, signal);
      } catch {
        if (signal.aborted) return;
        throw new Error('Harness interaction reconnect wait failed');
      }
    }
  }

  #registerInteractionOwnership(sessionId, ownership) {
    const owners = this.#interactionOwnerships.get(sessionId) ?? new Set();
    ownership.order = this.#interactionRegistry.nextOrder;
    this.#interactionRegistry.nextOrder += 1;
    owners.add(ownership);
    this.#interactionOwnerships.set(sessionId, owners);
  }

  #unregisterInteractionOwnership(sessionId, ownership) {
    const owners = this.#interactionOwnerships.get(sessionId);
    owners?.delete(ownership);
    if (owners?.size === 0) this.#interactionOwnerships.delete(sessionId);
    for (const [key, claim] of this.#interactionClaims) {
      if (claim.ownership === ownership) this.#interactionClaims.delete(key);
    }
  }

  #registerControlOwnership(ownership) {
    if (!ownership.control) return;
    let routes = this.#controlOwnerships.get(ownership.control.owner);
    if (!routes) {
      routes = new Map();
      this.#controlOwnerships.set(ownership.control.owner, routes);
    }
    const owners = routes.get(ownership.control.key) ?? new Set();
    owners.add(ownership);
    routes.set(ownership.control.key, owners);
  }

  #unregisterControlOwnership(ownership) {
    if (!ownership.control) return;
    const routes = this.#controlOwnerships.get(ownership.control.owner);
    const owners = routes?.get(ownership.control.key);
    owners?.delete(ownership);
    if (owners?.size === 0) routes.delete(ownership.control.key);
    if (routes?.size === 0) this.#controlOwnerships.delete(ownership.control.owner);
  }

  #controlCandidates(sessionId, control) {
    const normalized = normalizeControl(control);
    if (!normalized) return [];
    const owners = this.#controlOwnerships.get(normalized.owner)?.get(normalized.key);
    return [...(owners ?? [])]
      .filter((ownership) => ownership.sessionId === sessionId)
      .sort((left, right) => left.order - right.order);
  }

  #activeControlOwnership(sessionId, control) {
    return this.#controlCandidates(sessionId, control).find((ownership) => (
      ownership.started
      && ownership.active
      && !ownership.completed
      && ownership.turn !== null
    )) ?? null;
  }

  async #refreshControlOwnership(sessionId, control, options) {
    const candidates = this.#controlCandidates(sessionId, control);
    // An exact local owner is mandatory before even observing the Session.
    // This prevents an unrelated chat bound to the same Session from using
    // run state as authority to cancel or steer somebody else's turn.
    if (candidates.length === 0) return null;
    try {
      const history = await this.rpc(
        'session.history',
        { sessionId, maxMessages: 50 },
        30_000,
        options,
      );
      this.#consumeInteractionOwnerships(sessionId, history.events ?? []);
    } catch (error) {
      if (!(error instanceof HarnessRpcError) || error.code !== 'session-not-found') throw error;
      for (const ownership of candidates) {
        ownership.active = false;
        ownership.completed = true;
      }
      return null;
    }
    return this.#activeControlOwnership(sessionId, control);
  }

  async hasActiveTurn(sessionId, control, options = {}) {
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId is required');
    return Boolean(await this.#refreshControlOwnership(sessionId, control, options));
  }

  async stopActiveTurn(sessionId, control, options = {}) {
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId is required');
    const ownership = await this.#refreshControlOwnership(sessionId, control, options);
    if (!ownership) return false;
    if (ownership.stopRequested) return true;
    // Re-check after the refresh await. The owning ask may have completed and
    // unregistered while session.history was in flight.
    if (this.#activeControlOwnership(sessionId, control) !== ownership) return false;
    ownership.stopRequested = true;
    try {
      if (this.#controlExecutor) {
        const accepted = this.#controlExecutor({
          sessionId,
          expectedTurn: ownership.turn,
          promptRpcId: ownership.promptRpcId,
          action: 'stop',
        });
        if (accepted && typeof accepted.then === 'function') {
          throw new TypeError('controlExecutor must return synchronously');
        }
        if (accepted !== undefined) {
          if (typeof accepted !== 'boolean') {
            throw new TypeError('controlExecutor must return a boolean or undefined');
          }
          if (!accepted) ownership.stopRequested = false;
          return accepted;
        }
      }
      await this.rpc(
        'session.cancel',
        { sessionId, keepInbox: true },
        30_000,
        options,
      );
      return true;
    } catch (error) {
      if (this.#activeControlOwnership(sessionId, control) === ownership) {
        ownership.stopRequested = false;
      }
      if (error instanceof HarnessRpcError && error.code === 'session-not-found') return false;
      throw error;
    }
  }

  async steerActiveTurn(sessionId, text, control, options = {}) {
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId is required');
    if (typeof text !== 'string' || !text.trim()) {
      throw new TypeError('Steering text is required');
    }
    const ownership = await this.#refreshControlOwnership(sessionId, control, options);
    if (!ownership || ownership.stopRequested) return false;
    if (this.#activeControlOwnership(sessionId, control) !== ownership) return false;
    if (this.#controlExecutor) {
      const accepted = this.#controlExecutor({
        sessionId,
        expectedTurn: ownership.turn,
        promptRpcId: ownership.promptRpcId,
        action: 'steer',
        text,
      });
      if (accepted && typeof accepted.then === 'function') {
        throw new TypeError('controlExecutor must return synchronously');
      }
      if (accepted !== undefined) {
        if (typeof accepted !== 'boolean') {
          throw new TypeError('controlExecutor must return a boolean or undefined');
        }
        return accepted;
      }
    }
    await this.rpc('session.prompt', {
      sessionId,
      mode: 'steer',
      content: [{ type: 'text', text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, 30_000, options);
    return true;
  }

  #consumeInteractionOwnerships(sessionId, entries) {
    for (const ownership of this.#interactionOwnerships.get(sessionId) ?? []) {
      consumeInteractionOwnership(ownership, entries);
    }
  }

  async #refreshInteractionOwnerships(sessionId, signal) {
    const history = await this.rpc(
      'session.history',
      { sessionId, maxMessages: 50 },
      30_000,
      { signal },
    );
    this.#consumeInteractionOwnerships(sessionId, history.events ?? []);
  }

  #interactionOwner(sessionId, claimKey, kind) {
    const claim = this.#interactionClaims.get(claimKey);
    if (claim && this.#interactionOwnerships.get(sessionId)?.has(claim.ownership)) return claim;

    const owners = [...(this.#interactionOwnerships.get(sessionId) ?? [])];
    const active = owners
      .filter((ownership) => ownership.active)
      .sort((left, right) => left.order - right.order);
    if (active.length > 0) return { ownership: active[0], recovered: false };

    // A newly attached IM conversation may encounter a question left by
    // an earlier runtime before its queued prompt starts. Let the oldest such
    // ask adopt that replay so the Session can recover instead of deadlocking.
    // Approval adopters receive recovered=true and must reject it without ever
    // presenting it as approvable; the original actor/route cannot be proven
    // after a runtime restart.
    const ownership = owners
      .filter((ownership) => !ownership.started && !ownership.completed)
      .sort((left, right) => left.order - right.order)[0] ?? null;
    return ownership ? { ownership, recovered: true } : null;
  }

  /** Stage inbound file sources into the Session workspace via the Host executor. */
  async #stageWorkspaceFiles(sessionId, files, signal, retention) {
    if (!this.#fileIngressExecutor) {
      throw new InboundFileError(
        'inbound-file-ingress-unavailable',
        'Harness file ingress is unavailable in this Host process.',
      );
    }
    const sessionList = await this.rpc(
      'session.list',
      {},
      30_000,
      { signal },
    );
    const sessionWorkspace = sessionList?.items?.find(
      (item) => item?.sessionId === sessionId,
    )?.cwd;
    return this.#fileIngressExecutor({
      sessionId,
      workspace: sessionWorkspace,
      files,
      signal,
      retention,
    });
  }

  async ask(sessionId, prompt, options = {}) {
    if (typeof options === 'number') options = { timeoutMs: options };
    const timeoutMs = options.timeoutMs ?? 600_000;
    const signal = options.signal;
    const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : null;
    const progressMode = options.progressMode === 'all' ? 'all' : 'latest';
    const onArtifact = typeof options.onArtifact === 'function' ? options.onArtifact : null;
    const onInteraction = typeof options.onInteraction === 'function'
      ? options.onInteraction
      : undefined;
    const onInteractionResolved = typeof options.onInteractionResolved === 'function'
      ? options.onInteractionResolved
      : undefined;
    const control = normalizeControl(options.control);
    const inboundFiles = Array.isArray(options.files) ? options.files.filter(Boolean) : [];
  const inboundFileRetention = normalizeInboundRetention(options.inboundFileRetention) ?? 'turn';
  await this.ensureRunning({ signal });
    const before = await this.rpc(
      'session.history',
      { sessionId, maxMessages: 1 },
      30_000,
      { signal },
    );
    const baselineSeq = Math.max(-1, ...(before.events ?? []).map(({ event }) => event.seq ?? -1));
    const promptRpcId = `${this.#rpcIdPrefix}-${randomUUID()}`;
    const tracker = new HarnessReplyTracker({ promptRpcId, afterSeq: baselineSeq });
    const interactionController = onInteraction || onInteractionResolved
      ? new AbortController()
      : null;
    const interactionSignal = interactionController
      ? (signal
          ? AbortSignal.any([signal, interactionController.signal])
          : interactionController.signal)
      : null;
    // The mux is host-global. A prompt RPC becomes the owner only when its
    // durable user/message starts a turn, so two chats bound to one Session
    // cannot answer each other's questions or approvals.
    const ownership = interactionController || control
      ? {
          sessionId,
          promptRpcId,
          active: false,
          started: false,
          completed: false,
          stopRequested: false,
          turn: null,
          openTurn: null,
          lastSeq: baselineSeq,
          reconnect: null,
          order: -1,
          toolCalls: new Map(),
          control,
        }
      : null;
    let interactionTask = null;
    let artifactsDelivered = false;
    let deliveredArtifactCount = 0;
    const stagedBatches = [];
    let promptAccepted = false;
    let turnFinished = false;

    const deliverArtifacts = async () => {
      if (!onArtifact || artifactsDelivered || tracker.turn === null) {
        return deliveredArtifactCount;
      }
      artifactsDelivered = true;
      const artifacts = outboundArtifactRegistry.take(sessionId, tracker.turn, { signal });
      for (const artifact of artifacts) {
        try {
          await onArtifact(artifact);
          deliveredArtifactCount += 1;
        } catch (error) {
          outboundArtifactRegistry.release(artifact);
          console.warn(`[${this.#logPrefix}] ignored an artifact handoff failure:`, error.message);
        }
      }
      return deliveredArtifactCount;
    };

    if (ownership) {
      this.#registerInteractionOwnership(sessionId, ownership);
      this.#registerControlOwnership(ownership);
    }
    // This is resource ownership, not a feature Gate: it lets the Host retain
    // this Turn's snapshots until the channel has polled and claimed them.
    const closeArtifactConsumer = outboundArtifactRegistry.openConsumer(sessionId, promptRpcId);

    try {
      const basePrompt = prompt;
      if (inboundFiles.length > 0) {
        const staged = await this.#stageWorkspaceFiles(sessionId, inboundFiles, signal, inboundFileRetention);
        stagedBatches.push(staged);
        prompt = appendInboundFilesToPrompt(prompt, staged);
      }
      if (interactionSignal) {
        let markOpen;
        const opened = new Promise((resolve) => { markOpen = resolve; });
        interactionTask = this.watchInteractions(sessionId, {
          signal: interactionSignal,
          onInteraction,
          onResolved: onInteractionResolved,
          onOpen: markOpen,
          ownership,
        });
        void interactionTask.catch(() => undefined);
        await Promise.race([
          opened,
          sleep(30_000, interactionSignal).then(() => {
            throw new Error('Harness interaction stream did not open within 30 seconds');
          }),
        ]);
      }

      const content = typeof prompt === 'string'
        ? [{ type: 'text', text: prompt }]
        : prompt;
      if (!Array.isArray(content) || content.length === 0) {
        throw new TypeError('Harness prompt content is required');
      }
      const clientTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const sendPrompt = (promptContent) => this.rpc('session.prompt', {
        sessionId,
        mode: 'queue',
        content: promptContent,
        clientTimeZone,
      }, 30_000, { rpcId: promptRpcId, signal });
      try {
        await sendPrompt(content);
      } catch (error) {
        // The Host refuses image blocks for a non-vision model before any
        // durable user message exists. Re-deliver the same bytes the way
        // ordinary uploads (zip, documents) already travel — staged into the
        // Session workspace and named in a text manifest — then retry once
        // with a text-only prompt. The retry reuses promptRpcId so reply
        // tracking, control and interaction ownership stay bound to this ask.
        const imageSources = isModelImageRejection(error)
          ? imageFileSourcesFromContent(content)
          : [];
        if (imageSources.length === 0) throw error;
        let stagedImages;
        try {
          stagedImages = await this.#stageWorkspaceFiles(sessionId, imageSources, signal, inboundFileRetention);
        } catch (stagingError) {
          if (signal?.aborted) throw signal.reason ?? stagingError;
          console.warn(
            `[${this.#logPrefix}] unable to restage rejected images as workspace files:`,
            stagingError?.message ?? String(stagingError),
          );
          throw error;
        }
        stagedBatches.push(stagedImages);
        const baseContent = typeof basePrompt === 'string'
          ? [{ type: 'text', text: basePrompt }]
          : basePrompt;
        const fallbackPrompt = appendInboundFilesToPrompt([
          ...contentWithoutImages(baseContent),
          { type: 'text', text: t(IMAGE_FILE_FALLBACK_PROMPT) },
        ], { files: stagedBatches.flatMap((batch) => batch?.files ?? []) });
        await sendPrompt(fallbackPrompt);
      }
      promptAccepted = true;

      try {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          await sleep(300, signal);
          const history = await this.rpc(
            'session.history',
            { sessionId, maxMessages: 50 },
            30_000,
            { signal },
          );
          const wasActive = ownership?.active === true;
          if (ownership) {
            this.#consumeInteractionOwnerships(sessionId, history.events ?? []);
            if (!wasActive && ownership.active) ownership.reconnect?.();
          }
          const updates = tracker.consumeAll(history.events ?? []);
          if (onUpdate) {
            const visibleUpdates = progressMode === 'all' ? updates : updates.slice(-1);
            for (const update of visibleUpdates) {
              try {
                await onUpdate(update);
              } catch (error) {
                console.warn(`[${this.#logPrefix}] ignored a progress update failure:`, error.message);
              }
            }
          }
          if (!tracker.finished) continue;
          turnFinished = true;
          if (!ownership?.stopRequested && !harnessTurnSucceeded(tracker.reason)) {
            throw harnessTurnError(tracker.reason);
          }
          // An accepted /stop revokes attachment delivery even when Harness
          // preserved a useful partial text answer for the existing UX.
          const artifactCount = ownership?.stopRequested
            ? 0
            : await deliverArtifacts();
          if (tracker.answer) {
            return tracker.answer;
          }
          if (artifactCount > 0) return '';
          if (ownership?.stopRequested) throw turnStoppedError();
          throw harnessTurnError(tracker.reason);
        }
        throw new HarnessTurnError('harness-reply-timeout');
      } catch (error) {
        // Once cancellation was accepted, transport/poll failures and timeouts
        // describe the convergence of that stop, not an unrelated ask failure.
        if (!ownership?.stopRequested) throw error;
        if (tracker.answer) {
          return tracker.answer;
        }
        if (error?.code === 'turn-stopped') throw error;
        throw turnStoppedError();
      }
    } finally {
      if (!promptAccepted || turnFinished) {
        for (const staged of stagedBatches) {
          try {
            await staged?.cleanup?.();
          } catch (error) {
            console.warn(`[${this.#logPrefix}] unable to clean inbound files:`, error.message);
          }
        }
      }
      closeArtifactConsumer();
      if (ownership) {
        this.#unregisterControlOwnership(ownership);
        this.#unregisterInteractionOwnership(sessionId, ownership);
      }
      if (tracker.turn !== null) outboundArtifactRegistry.discard(sessionId, tracker.turn);
      interactionController?.abort(new DOMException('Harness turn finished', 'AbortError'));
      if (interactionTask) await interactionTask.catch(() => undefined);
    }
  }

  async #watchInteractionStream(sessionId, {
    signal,
    onInteraction,
    onResolved,
    onOpen,
    ownership,
  }) {
    let settled = false;
    let callbackFailure = null;
    let callbackTail = Promise.resolve();
    let ownershipReady = ownership === undefined || ownership === null;
    const bufferedEnvelopes = [];
    let close = () => {};
    const handleOpen = (closeStream) => {
      close = closeStream;
      if (ownership) ownership.reconnect = close;
      try {
        onOpen?.();
      } catch (error) {
        console.warn(`[${this.#logPrefix}] ignored an interaction open callback failure:`, error.message);
      }
      if (ownership) {
        void this.#refreshInteractionOwnerships(sessionId, signal).then(() => {
          if (settled) return;
          ownershipReady = true;
          for (const envelope of bufferedEnvelopes.splice(0)) processEnvelope(envelope);
        }).catch((error) => {
          callbackFailure ??= error;
          close();
        });
      }
    };
    const dispatch = (callback, value) => {
      if (!callback) return;
      callbackTail = callbackTail
        .then(() => callback(value))
        .catch((error) => {
          callbackFailure ??= error;
          close();
        });
    };
    const processEnvelope = (envelope) => {
      const payload = envelope.payload;
      if (ownership && payload.type === 'session/event') {
        this.#consumeInteractionOwnerships(sessionId, [payload.event]);
        return;
      }
      if (payload.type === 'question/requested' || payload.type === 'approval/requested') {
        const kind = payload.type === 'question/requested' ? 'question' : 'approval';
        const interactionId = kind === 'question' ? envelope.rpcId : payload.approvalId;
        const claimKey = `${kind}:${interactionId}`;
        if (ownership) {
          const claim = this.#interactionOwner(sessionId, claimKey, kind);
          if (claim?.ownership !== ownership) return;
          this.#interactionClaims.set(claimKey, claim);
        }
        const toolCall = kind === 'approval' && ownership && typeof payload.callId === 'string'
          ? this.#interactionClaims.get(claimKey)?.ownership.toolCalls.get(payload.callId)
          : undefined;
        dispatch(onInteraction, Object.freeze({
          kind,
          interactionId,
          rpcId: envelope.rpcId,
          sessionId,
          payload,
          recovered: ownership
            ? this.#interactionClaims.get(claimKey)?.recovered === true
            : false,
          ...(toolCall ? { toolCall } : {}),
          reconnect: close,
          respond: (result, options = {}) => this.respondInteraction(
            envelope.rpcId,
            result,
            { ...options, signal: options.signal ?? signal },
          ),
        }));
        return;
      }
      if (payload.type === 'question/resolved' || payload.type === 'approval/resolved') {
        const kind = payload.type === 'question/resolved' ? 'question' : 'approval';
        const interactionId = kind === 'question'
          ? payload.questionRpcId
          : payload.approvalId;
        const claimKey = `${kind}:${interactionId}`;
        if (ownership) {
          const claim = this.#interactionClaims.get(claimKey);
          if (claim?.ownership !== ownership) return;
          this.#interactionClaims.delete(claimKey);
        }
        dispatch(onResolved, Object.freeze({
          kind,
          interactionId,
          sessionId,
          outcome: payload.outcome,
          payload,
        }));
      }
    };
    const handleEnvelope = (envelope) => {
      try {
        const payload = envelope?.payload;
        if (envelope?.type !== 'server-request'
          || typeof envelope.rpcId !== 'string'
          || !payload || typeof payload !== 'object'
          || envelope.method !== payload.type) {
          throw new Error('invalid server-request envelope');
        }
        if (payload.sessionId !== sessionId) return;
        if (!ownershipReady) bufferedEnvelopes.push(envelope);
        else processEnvelope(envelope);
      } catch (error) {
        console.warn(`[${this.#logPrefix}] ignored a malformed Harness interaction frame:`, error.message);
      }
    };
    try {
      await this.#watchMux({ signal, onOpen: handleOpen, onEnvelope: handleEnvelope });
    } finally {
      settled = true;
      if (ownership?.reconnect === close) ownership.reconnect = null;
      if (!signal.aborted) await callbackTail;
    }
    if (!signal.aborted && callbackFailure) throw callbackFailure;
  }

  /**
   * Watch the global Harness event mux (all sessions) until `signal`
   * aborts, reconnecting on drop. Both transports deliver the same envelopes;
   * only session/event payloads are forwarded. onReconnect fires after every
   * (re)connection so callers can compensate for events missed while offline.
   */
  async watchHarnessEvents({ signal, onSessionEvent, onReconnect } = {}) {
    if (typeof onSessionEvent !== 'function') {
      throw new TypeError('watchHarnessEvents requires onSessionEvent');
    }
    if (!signal || typeof signal.addEventListener !== 'function') {
      throw new TypeError('watchHarnessEvents requires an AbortSignal');
    }
    if (onReconnect !== undefined && typeof onReconnect !== 'function') {
      throw new TypeError('onReconnect must be a function');
    }
    while (!signal.aborted) {
      try {
        await this.#watchMux({
          signal,
          onOpen: () => {
            try {
              onReconnect?.();
            } catch (error) {
              console.warn(`[${this.#logPrefix}] mux reconnect hook failed:`, error.message);
            }
          },
          onEnvelope: (envelope) => {
            try {
              const payload = envelope?.payload;
              if (envelope?.type !== 'server-request'
                || !payload
                || typeof payload !== 'object'
                || envelope.method !== payload.type
                || payload.type !== 'session/event'
                || typeof payload.sessionId !== 'string'
                || !payload.event
                || typeof payload.event !== 'object') return;
              onSessionEvent({ sessionId: payload.sessionId, event: payload.event });
            } catch (error) {
              console.warn(`[${this.#logPrefix}] ignored a malformed global mux frame:`, error.message);
            }
          },
        });
      } catch (error) {
        if (signal.aborted) return;
        console.warn(`[${this.#logPrefix}] Harness event mux disconnected:`, error.message);
      }
      if (signal.aborted) return;
      try {
        await sleep(this.#interactionReconnectDelayMs, signal);
      } catch {
        if (signal.aborted) return;
        throw new Error('Harness event mux reconnect wait failed');
      }
    }
  }

  #watchMux(options) {
    return watchHarnessMux({
      apiProxy: this.#apiProxy,
      baseUrl: this.#baseUrl,
      createWebSocket: this.#createWebSocket,
      rpcId: `${this.#rpcIdPrefix}-${randomUUID()}`,
      ...options,
      onMalformed: (error) => {
        console.warn(`[${this.#logPrefix}] ignored a malformed Harness mux frame:`, error.message);
      },
    });
  }

  stopManagedProcess() {
    if (this.#managedProcess?.exitCode === null) this.#managedProcess.kill('SIGTERM');
  }
}
