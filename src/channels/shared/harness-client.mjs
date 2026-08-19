import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { adoptRegisteredWorkspaceSession } from './harness-session-binding.mjs';

// Every channel plugin runs in the same Host process. Sharing ownership by
// Harness origin prevents two channel-specific clients bound to one Session
// from claiming or cancelling each other's interactions.
const interactionRegistries = new Map();

function interactionRegistry(origin) {
  let registry = interactionRegistries.get(origin);
  if (!registry) {
    registry = { ownerships: new Map(), claims: new Map(), nextOrder: 0 };
    interactionRegistries.set(origin, registry);
  }
  return registry;
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

export class HarnessReplyTracker {
  #promptRpcId;
  #lastSeq;
  #openTurn = null;
  #targetTurn = null;
  #stepText = new Map();
  #latestText = '';
  #finished = false;
  #reason = null;

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

  consume(entries) {
    let update = null;
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
          update = { type: 'text', text };
        }
        continue;
      }

      if (event.type === 'assistant/message') {
        const text = assistantMessageText(event);
        if (text && text !== this.#latestText) {
          this.#latestText = text;
          update = { type: 'text', text };
        }
        continue;
      }

      if (event.type === 'tool/call') {
        update = { type: 'tool', name: event.data?.name ?? '工具' };
      } else if (event.type === 'tool/result') {
        update = { type: 'status', text: '正在整理结果…' };
      }
    }
    return update;
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

export class HarnessInteractionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HarnessInteractionError';
    this.code = code;
  }
}

export class HarnessClient {
  #baseUrl;
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
  #managedProcess = null;
  #interactionRegistry;
  #interactionOwnerships;
  #interactionClaims;

  constructor({
    baseUrl,
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
    this.#baseUrl = new URL(baseUrl);
    this.#workspace = workspace;
    // Keep an omitted preset absent so session.create resolves the Host's current default.
    this.#agentPreset = agentPreset ?? undefined;
    this.#autostart = autostart;
    this.#dshBin = dshBin;
    this.#fetch = fetchImpl;
    this.#createWebSocket = createWebSocket;
    this.#interactionReconnectDelayMs = interactionReconnectDelayMs;
    this.#rpcIdPrefix = rpcIdPrefix.trim();
    this.#logPrefix = logPrefix.trim();
    this.#commandExecutor = commandExecutor;
    this.#interactionRegistry = interactionRegistry(this.#baseUrl.origin);
    this.#interactionOwnerships = this.#interactionRegistry.ownerships;
    this.#interactionClaims = this.#interactionRegistry.claims;
  }

  async rpc(method, payload = {}, timeoutMs = 30_000, options = {}) {
    const rpcId = options.rpcId ?? `${this.#rpcIdPrefix}-${randomUUID()}`;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const response = await this.#fetch(new URL(`/api/${method}`, this.#baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      signal,
    });
    if (!response.ok) throw new Error(`Harness transport ${method} failed: HTTP ${response.status}`);
    const body = await response.json();
    if (body?.type !== 'server-response' || body?.rpcId !== rpcId) {
      throw new Error(`Harness returned an invalid response for ${method}`);
    }
    if (!body.result?.ok) throw new HarnessRpcError(method, body.result?.error);
    return body.result.value;
  }

  async health(options = {}) {
    await this.rpc('host.describe', {}, 5_000, options);
    return true;
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
    throw new Error(`Harness did not become ready: ${lastError?.message ?? 'timeout'}`);
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
    await this.ensureRunning(options);
    const workspaceId = await this.workspaceId(options);
    const payload = { workspaceId };
    if (this.#agentPreset !== undefined) payload.agentPreset = this.#agentPreset;
    const created = await this.rpc('session.create', payload, 30_000, options);
    return created.sessionId;
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
    const response = await this.#fetch(new URL('/api/respond', this.#baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId, result }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Harness transport respond failed: HTTP ${response.status}`);
    }
    const receipt = await response.json();
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
        await this.#watchInteractionSocket(sessionId, {
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

  async ask(sessionId, prompt, options = {}) {
    if (typeof options === 'number') options = { timeoutMs: options };
    const timeoutMs = options.timeoutMs ?? 600_000;
    const signal = options.signal;
    const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : null;
    const onInteraction = typeof options.onInteraction === 'function'
      ? options.onInteraction
      : undefined;
    const onInteractionResolved = typeof options.onInteractionResolved === 'function'
      ? options.onInteractionResolved
      : undefined;
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
    const ownership = interactionController
      ? {
          promptRpcId,
          active: false,
          started: false,
          completed: false,
          turn: null,
          openTurn: null,
          lastSeq: baselineSeq,
          reconnect: null,
          order: -1,
          toolCalls: new Map(),
        }
      : null;
    let interactionTask = null;

    if (ownership) this.#registerInteractionOwnership(sessionId, ownership);

    try {
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
      await this.rpc('session.prompt', {
        sessionId,
        mode: 'queue',
        content,
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, 30_000, { rpcId: promptRpcId, signal });

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
        const update = tracker.consume(history.events ?? []);
        if (update && onUpdate) {
          try {
            await onUpdate(update);
          } catch (error) {
            console.warn(`[${this.#logPrefix}] ignored a progress update failure:`, error.message);
          }
        }
        if (!tracker.finished) continue;
        if (tracker.answer) return tracker.answer;
        throw new Error(
          `Harness turn ended without a text reply${tracker.reason ? ` (${JSON.stringify(tracker.reason)})` : ''}`,
        );
      }
      throw new Error(`Harness reply timed out after ${Math.round(timeoutMs / 1_000)} seconds`);
    } finally {
      interactionController?.abort(new DOMException('Harness turn finished', 'AbortError'));
      if (interactionTask) await interactionTask.catch(() => undefined);
      if (ownership) this.#unregisterInteractionOwnership(sessionId, ownership);
    }
  }

  #watchInteractionSocket(sessionId, {
    signal,
    onInteraction,
    onResolved,
    onOpen,
    ownership,
  }) {
    const url = new URL('/api/events.mux', this.#baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

    return new Promise((resolve, reject) => {
      let socket;
      try {
        socket = this.#createWebSocket(url.toString());
      } catch (error) {
        reject(error);
        return;
      }
      let opened = false;
      let settled = false;
      let callbackFailure = null;
      let callbackTail = Promise.resolve();
      let ownershipReady = ownership === undefined || ownership === null;
      const bufferedEnvelopes = [];
      const finish = (error) => {
        if (settled) return;
        settled = true;
        socket.removeEventListener('open', handleOpen);
        socket.removeEventListener('message', handleMessage);
        socket.removeEventListener('close', handleClose);
        socket.removeEventListener('error', handleError);
        signal.removeEventListener('abort', handleAbort);
        if (ownership?.reconnect === close) ownership.reconnect = null;
        void callbackTail.then(() => {
          const failure = error ?? callbackFailure;
          if (failure) reject(failure);
          else resolve();
        }, reject);
      };
      const close = () => {
        try {
          if (socket.readyState === 0 || socket.readyState === 1) socket.close();
        } catch {
          // Cleanup must still settle the watcher if a WebSocket rejects close while connecting.
        }
      };
      const handleOpen = () => {
        opened = true;
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
            finish(error);
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
            finish(callbackFailure);
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
      const handleMessage = (event) => {
        try {
          if (typeof event.data !== 'string') throw new Error('binary WebSocket frame');
          const envelope = JSON.parse(event.data);
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
      const handleClose = () => finish(opened ? null : new Error(
        'Harness interaction WebSocket closed before opening',
      ));
      const handleError = () => {
        finish(new Error(opened
          ? 'Harness interaction WebSocket failed'
          : 'Harness interaction WebSocket failed before opening'));
        close();
      };
      const handleAbort = () => {
        close();
        finish();
      };

      socket.addEventListener('open', handleOpen);
      socket.addEventListener('message', handleMessage);
      socket.addEventListener('close', handleClose, { once: true });
      socket.addEventListener('error', handleError, { once: true });
      signal.addEventListener('abort', handleAbort, { once: true });
      if (signal.aborted) handleAbort();
    });
  }

  /**
   * Watch the global Harness event mux (all sessions) until `signal`
   * aborts, reconnecting on drop. The Desktop host serves the mux as a
   * WebSocket downlink whose frames are `server-request` envelopes
   * (plain GET answers 426). Dispatches only `session/event` frames
   * through `onSessionEvent({ sessionId, event })`. The per-ask
   * interaction watcher above filters to one session; this surface
   * exists for cross-session notifications (e.g. completion pushes).
   */
  watchHarnessEvents({ signal, onSessionEvent }) {
    if (typeof onSessionEvent !== 'function') {
      return Promise.reject(new TypeError('watchHarnessEvents requires onSessionEvent'));
    }
    const url = new URL('/api/events.mux', this.#baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let stopped = false;
    const connect = () => {
      if (stopped || signal.aborted) return Promise.resolve();
      return new Promise((resolve) => {
        const socket = this.#createWebSocket(url.toString());
        const settle = () => {
          socket.removeEventListener('open', handleOpen);
          socket.removeEventListener('message', handleMessage);
          socket.removeEventListener('close', handleClose);
          socket.removeEventListener('error', handleError);
          signal.removeEventListener('abort', handleAbort);
          resolve();
        };
        const handleOpen = () => undefined;
        const handleMessage = (event) => {
          try {
            if (typeof event.data !== 'string') return;
            const envelope = JSON.parse(event.data);
            const payload = envelope?.payload;
            if (envelope?.type !== 'server-request' || !payload || typeof payload !== 'object') return;
            if (payload.type !== 'session/event') return;
            if (typeof payload.sessionId !== 'string' || !payload.event || typeof payload.event !== 'object') return;
            onSessionEvent({ sessionId: payload.sessionId, event: payload.event });
          } catch (error) {
            console.warn(`[${this.#logPrefix}] ignored a malformed global mux frame:`, error.message);
          }
        };
        const handleClose = () => {
          settle();
          if (!stopped && !signal.aborted) {
            setTimeout(() => { void connect(); }, 2000);
          }
        };
        const handleError = () => {
          try {
            socket.close();
          } catch {
            // The close event drives reconnection; nothing to do here.
          }
        };
        const handleAbort = () => {
          stopped = true;
          try {
            socket.close();
          } catch {
            // Already closed.
          }
        };
        socket.addEventListener('open', handleOpen);
        socket.addEventListener('message', handleMessage);
        socket.addEventListener('close', handleClose, { once: true });
        socket.addEventListener('error', handleError, { once: true });
        signal.addEventListener('abort', handleAbort, { once: true });
        if (signal.aborted) handleAbort();
      });
    };
    return connect();
  }

  stopManagedProcess() {
    if (this.#managedProcess?.exitCode === null) this.#managedProcess.kill('SIGTERM');
  }
}
