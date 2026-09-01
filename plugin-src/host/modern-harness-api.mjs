import { randomUUID } from 'node:crypto';

import { hasActiveHarnessInteractionOwner } from '../../src/channels/shared/harness-client.mjs';

const modernApis = new WeakMap();

function failureOf(error) {
  const failure = error?.failure;
  if (failure && typeof failure === 'object'
    && typeof failure.code === 'string'
    && typeof failure.message === 'string') {
    return {
      code: failure.code,
      message: failure.message,
      details: failure.details && typeof failure.details === 'object' ? failure.details : {},
    };
  }
  if (error?.name === 'AbortError' || error?.name === 'RemoteInvocationCancelled') {
    return {
      code: 'cancelled',
      message: error instanceof Error ? error.message : 'Harness request was cancelled',
      details: {},
    };
  }
  return {
    code: 'internal',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  };
}

function rpcResult(request, operation) {
  return Promise.resolve().then(operation).then(
    (value) => ({ rpcId: request.rpcId, result: { ok: true, value } }),
    (error) => ({ rpcId: request.rpcId, result: { ok: false, error: failureOf(error) } }),
  );
}

function remoteRequest(namespace, method, args, signal) {
  return {
    namespace,
    method,
    args,
    ...(signal === undefined ? {} : { signal }),
  };
}

function questionError(message, code) {
  const error = new Error(message);
  error.name = 'UserQuestionError';
  error.code = code;
  return error;
}

function matchesQuestions(value, pending) {
  if (!value || typeof value !== 'object'
    || value.sessionId !== pending.sessionId
    || !value.answer || typeof value.answer !== 'object'
    || !Array.isArray(value.answer.answers)
    || value.answer.answers.length !== pending.questions.length) return false;
  return value.answer.answers.every((answer, index) => {
    const question = pending.questions[index];
    if (!answer || typeof answer !== 'object'
      || answer.id !== question.id
      || !Array.isArray(answer.selected)
      || answer.selected.some((label) => typeof label !== 'string')
      || new Set(answer.selected).size !== answer.selected.length
      || (answer.custom !== undefined && typeof answer.custom !== 'string')) return false;
    const custom = answer.custom?.trim();
    if (custom !== undefined && !custom) return false;
    if (question.multiSelect !== true
      && ((custom !== undefined && answer.selected.length > 0) || answer.selected.length > 1)) return false;
    const labels = new Set(question.options?.map((option) => option.label) ?? []);
    return answer.selected.every((label) => labels.has(label));
  });
}

function expandChunkRecord(record) {
  if (record?.type === 'event' && record.event && typeof record.event === 'object') {
    return [{ event: record.event }];
  }
  const packed = record?.type === 'chunks' ? record.event : null;
  if (!packed || typeof packed !== 'object') {
    throw new Error('Harness returned an invalid session history record');
  }
  const { data } = packed;
  const kind = packed.type;
  const members = kind === 'chunkrow/tool-call-chunks' ? data?.args : data?.texts;
  if (!data || !Array.isArray(members) || members.length === 0
    || members.some((member) => typeof member !== 'string')
    || !Array.isArray(data.dt) || data.dt.length !== members.length - 1) {
    throw new Error('Harness returned an invalid packed session chunk');
  }
  let time = packed.time;
  return members.map((member, index) => {
    if (index > 0) time += data.dt[index - 1];
    let chunk;
    if (kind === 'chunkrow/text-chunks') {
      chunk = { type: 'text-delta', index: data.index, text: member };
    } else if (kind === 'chunkrow/reasoning-chunks') {
      chunk = { type: 'reasoning-delta', index: data.index, text: member };
    } else if (kind === 'chunkrow/tool-call-chunks') {
      chunk = {
        type: 'tool-call-delta',
        index: data.index,
        id: data.id,
        ...(Object.hasOwn(data, 'name') ? { name: data.name } : {}),
        argumentsDelta: member,
      };
    } else {
      throw new Error(`Harness returned an unsupported packed session chunk: ${String(kind)}`);
    }
    return {
      event: {
        type: 'assistant/chunk',
        seq: packed.seq + index,
        time,
        data: { turn: data.turn, step: data.step, chunk },
      },
    };
  });
}

function historyEntries(records) {
  if (!Array.isArray(records)) throw new Error('Harness returned invalid session history records');
  return records.flatMap(expandChunkRecord);
}

class MuxSubscription {
  #frames = [];
  #waiting = null;
  #closed = false;
  #signal;
  #onAbort;
  #dispose;

  constructor(signal, dispose) {
    this.#signal = signal;
    this.#dispose = dispose;
    this.#onAbort = () => this.close();
    signal?.addEventListener('abort', this.#onAbort, { once: true });
    if (signal?.aborted) this.close();
  }

  push(frame) {
    if (this.#closed) return;
    if (this.#waiting) {
      const resolve = this.#waiting;
      this.#waiting = null;
      resolve({ value: frame, done: false });
    } else {
      this.#frames.push(frame);
    }
  }

  next() {
    if (this.#frames.length > 0) {
      return Promise.resolve({ value: this.#frames.shift(), done: false });
    }
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => { this.#waiting = resolve; });
  }

  return() {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#signal?.removeEventListener('abort', this.#onAbort);
    this.#dispose?.();
    this.#dispose = null;
    if (this.#waiting) {
      const resolve = this.#waiting;
      this.#waiting = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator]() {
    return this;
  }
}

class ModernHarnessApi {
  #gateway;
  #scope;
  #mux = new Set();
  #pendingQuestions = new Map();
  #pendingApprovals = new Map();
  #sessionCursors = new Map();
  #disposers = [];
  #disposed = false;

  constructor(ctx, gateway, scope) {
    this.#gateway = gateway;
    this.#scope = scope;

    this.host = Object.freeze({
      describe: (request) => rpcResult(request, () => ({ ready: true, transport: 'typert' })),
    });
    this.workspace = Object.freeze({
      list: (request, signal) => rpcResult(request, () => this.#workspaceList(signal)),
      create: (request, signal) => rpcResult(request, () => this.#invoke(
        'workspace', 'create', { request: request.payload }, signal,
      )),
    });
    this.sessions = Object.freeze({
      list: (request, signal) => rpcResult(request, () => this.#invoke(
        'session', 'list', { _request: request.payload }, signal,
      )),
      create: (request, signal) => rpcResult(request, () => this.#invoke(
        'session', 'create', { request: request.payload }, signal,
      )),
      history: (request, signal) => rpcResult(request, () => this.#history(request.payload, signal)),
      prompt: (request, signal) => rpcResult(request, () => this.#invoke(
        'session',
        'prompt',
        { request: { requestId: request.rpcId, ...request.payload } },
        signal,
      )),
      rename: (request, signal) => rpcResult(request, () => this.#invoke(
        'session', 'rename', { request: request.payload }, signal,
      )),
      cancel: (request, signal) => rpcResult(request, () => this.#invoke(
        'session', 'cancel', { request: { sessionId: request.payload.sessionId } }, signal,
      )),
      models: (request, signal) => rpcResult(request, () => this.#sessionModels(
        request.payload.sessionId, signal,
      )),
      selectModel: (request, signal) => rpcResult(request, () => this.#invoke(
        'session', 'selectModel', { request: request.payload }, signal,
      )),
    });
    this.llm = Object.freeze({
      models: (request, signal) => rpcResult(request, async () => {
        const catalog = await this.#modelCatalog(signal);
        return { groups: catalog.groups, failures: catalog.failures };
      }),
    });
    this.events = Object.freeze({
      mux: (_request, signal) => this.#openMux(signal),
    });
    this.respond = (message) => Promise.resolve(this.#respond(message));

    if (typeof ctx?.on === 'function') {
      this.#disposers.push(ctx.on('session/event', (session, event) => {
        const sessionId = session?.id;
        if (typeof sessionId !== 'string' || !event || typeof event !== 'object') return;
        if (Number.isSafeInteger(event.seq)) this.#rememberCursor(sessionId, event.seq);
        this.#broadcast({ type: 'session/event', sessionId, event });
      }, { global: true }));
      this.#disposers.push(ctx.on(
        'approval/request',
        (request, next) => this.#requestApproval(request, next),
        { global: true, prepend: true },
      ));
      this.#disposers.push(ctx.on(
        'user-questions/request',
        (request, next) => this.#requestQuestion(request, next),
        { global: true, prepend: true },
      ));
    }
  }

  async #invoke(namespace, method, args, signal) {
    return this.#gateway.invoke(remoteRequest(namespace, method, args, signal));
  }

  async #streamFirst(namespace, method, args, signal) {
    const controller = new AbortController();
    const streamSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    let iterator;
    try {
      const source = await this.#gateway.stream(remoteRequest(
        namespace, method, args, streamSignal,
      ));
      iterator = source[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done) throw new Error(`Harness ${namespace}.${method} stream ended before its baseline`);
      return first.value;
    } finally {
      controller.abort(new DOMException('Baseline received', 'AbortError'));
      await Promise.resolve(iterator?.return?.()).catch(() => undefined);
    }
  }

  async #workspaceList(signal) {
    const frame = await this.#streamFirst('workspace', 'follow', {}, signal);
    if (frame?.type !== 'baseline' || !frame.value || typeof frame.value !== 'object') {
      throw new Error('Harness workspace.follow returned no baseline');
    }
    return frame.value;
  }

  async #sessionSnapshot(sessionId, maxMessages, signal) {
    const frame = await this.#streamFirst('session', 'follow', {
      request: {
        address: { kind: 'session', sessionId },
        maxMessages,
      },
    }, signal);
    if (frame?.type !== 'snapshot' || !Number.isSafeInteger(frame.cursor)) {
      throw new Error('Harness session.follow returned no snapshot');
    }
    this.#rememberCursor(sessionId, frame.cursor);
    return frame;
  }

  async #history(payload, signal) {
    const { sessionId, maxMessages = 50, beforeSeq } = payload;
    let cursor = this.#sessionCursors.get(sessionId);
    if (cursor === undefined) {
      const snapshot = await this.#sessionSnapshot(sessionId, maxMessages, signal);
      cursor = this.#sessionCursors.get(sessionId) ?? snapshot.cursor;
      if (beforeSeq === undefined && cursor === snapshot.cursor) {
        return {
          events: historyEntries(snapshot.records),
          hasMore: snapshot.hasMore === true,
          ...(snapshot.projections === undefined ? {} : { projections: snapshot.projections }),
        };
      }
    }
    const page = await this.#invoke('session', 'page', {
      request: {
        address: { kind: 'session', sessionId },
        throughSeq: cursor,
        maxMessages,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      },
    }, signal);
    return { events: historyEntries(page.records), hasMore: page.hasMore === true };
  }

  #rememberCursor(sessionId, cursor) {
    const previous = this.#sessionCursors.get(sessionId);
    if (previous === undefined || cursor > previous) this.#sessionCursors.set(sessionId, cursor);
  }

  #modelCatalog(signal) {
    return this.#invoke('session', 'modelCatalog', {}, signal);
  }

  async #sessionModels(sessionId, signal) {
    const [catalog, list] = await Promise.all([
      this.#modelCatalog(signal),
      this.#invoke('session', 'list', { _request: {} }, signal),
    ]);
    const summary = list?.items?.find((item) => item?.sessionId === sessionId);
    if (!summary) {
      const error = new Error(`session "${sessionId}" not found`);
      error.failure = {
        code: 'session-not-found',
        message: error.message,
        details: { sessionId },
      };
      throw error;
    }
    const selection = summary.projections?.values?.modelSelection;
    const current = selection?.next ?? selection?.lastUsed ?? catalog.default;
    return {
      current,
      routable: catalog.routableProviders.includes(current.provider),
      groups: catalog.groups,
      failures: catalog.failures,
    };
  }

  #openMux(signal) {
    let subscription;
    subscription = new MuxSubscription(signal, () => this.#mux.delete(subscription));
    this.#mux.add(subscription);
    for (const pending of this.#pendingQuestions.values()) subscription.push(this.#questionFrame(pending));
    for (const pending of this.#pendingApprovals.values()) subscription.push(this.#approvalFrame(pending));
    return subscription;
  }

  #broadcast(payload, rpcId = randomUUID()) {
    const frame = { rpcId, payload };
    for (const subscription of this.#mux) subscription.push(frame);
  }

  #claimableAgent(agent) {
    const sessionId = agent?.session?.id ?? agent?.id;
    if (typeof sessionId !== 'string' || !agent?.session || !Array.isArray(agent.session.events)) {
      return null;
    }
    return hasActiveHarnessInteractionOwner(
      this.#scope,
      sessionId,
      agent.session.events,
    ) ? { sessionId, session: agent.session } : null;
  }

  #questionFrame(pending) {
    return {
      rpcId: pending.rpcId,
      payload: {
        type: 'question/requested',
        sessionId: pending.sessionId,
        questions: pending.questions,
      },
    };
  }

  #requestQuestion(request, next) {
    const owner = this.#claimableAgent(request?.agent);
    if (!owner) return next();
    if (request.signal?.aborted) {
      return Promise.reject(questionError(
        'ask_user_question was aborted before the user answered', 'ASK_ABORTED',
      ));
    }
    return new Promise((resolve, reject) => {
      const pending = {
        rpcId: randomUUID(),
        sessionId: owner.sessionId,
        questions: request.questions,
        signal: request.signal,
        settle: (outcome, value) => {
          if (!this.#pendingQuestions.delete(pending.rpcId)) return;
          request.signal?.removeEventListener('abort', onAbort);
          this.#broadcast({
            type: 'question/resolved',
            sessionId: pending.sessionId,
            questionRpcId: pending.rpcId,
            outcome,
          });
          if (outcome === 'answered') resolve(value);
          else reject(value);
        },
      };
      const onAbort = () => pending.settle('cancelled', questionError(
        'ask_user_question was aborted before the user answered', 'ASK_ABORTED',
      ));
      this.#pendingQuestions.set(pending.rpcId, pending);
      request.signal?.addEventListener('abort', onAbort, { once: true });
      this.#broadcast(this.#questionFrame(pending).payload, pending.rpcId);
    });
  }

  #approvalFrame(pending) {
    return {
      rpcId: pending.rpcId,
      payload: {
        type: 'approval/requested',
        sessionId: pending.sessionId,
        approvalId: pending.approvalId,
        toolName: pending.toolName,
        ...(pending.callId === undefined ? {} : { callId: pending.callId }),
        ...(pending.reason === undefined ? {} : { reason: pending.reason }),
      },
    };
  }

  #requestApproval(request, next) {
    const owner = this.#claimableAgent(request?.agent);
    if (!owner) return next();
    if (request.signal?.aborted) return Promise.resolve('cancelled');
    const claimed = new Set([...this.#pendingApprovals.values()].map((entry) => entry.approvalId));
    const decided = new Set();
    let approvalId;
    for (let index = owner.session.events.length - 1; index >= 0; index -= 1) {
      const event = owner.session.events[index];
      if (event.type === 'approval/decided') {
        decided.add(event.data?.id);
      } else if (event.type === 'approval/asked') {
        const id = event.data?.id;
        if (!id || decided.has(id) || claimed.has(id)) continue;
        if ((request.callId ?? null) !== (event.data?.callId ?? null)) continue;
        approvalId = id;
        break;
      }
    }
    if (approvalId === undefined) return next();
    return new Promise((resolve) => {
      const pending = {
        rpcId: randomUUID(),
        sessionId: owner.sessionId,
        approvalId,
        toolName: request.toolName,
        callId: request.callId,
        reason: request.reason,
        settle: (outcome) => {
          if (!this.#pendingApprovals.delete(pending.rpcId)) return;
          request.signal?.removeEventListener('abort', onAbort);
          this.#broadcast({
            type: 'approval/resolved',
            sessionId: pending.sessionId,
            approvalId: pending.approvalId,
            outcome,
          });
          resolve(outcome);
        },
      };
      const onAbort = () => pending.settle('cancelled');
      this.#pendingApprovals.set(pending.rpcId, pending);
      request.signal?.addEventListener('abort', onAbort, { once: true });
      this.#broadcast(this.#approvalFrame(pending).payload, pending.rpcId);
    });
  }

  #respond(message) {
    const approval = this.#pendingApprovals.get(message?.rpcId);
    if (approval) {
      const value = message?.result?.value;
      if (message?.result?.ok !== true
        || !value || typeof value !== 'object'
        || value.sessionId !== approval.sessionId
        || value.approvalId !== approval.approvalId
        || (value.outcome !== 'allowed-once' && value.outcome !== 'rejected')) {
        return { accepted: false, reason: 'bad-response' };
      }
      approval.settle(value.outcome);
      return { accepted: true };
    }
    const question = this.#pendingQuestions.get(message?.rpcId);
    if (!question) return { accepted: false, reason: 'not-pending' };
    if (message?.result?.ok !== true) {
      if (message?.result?.error?.code !== 'cancelled') {
        return { accepted: false, reason: 'bad-response' };
      }
      question.settle('cancelled', questionError(
        'the user cancelled ask_user_question', 'ASK_CANCELLED',
      ));
      return { accepted: true };
    }
    if (!matchesQuestions(message.result.value, question)) {
      return { accepted: false, reason: 'bad-response' };
    }
    const answer = {
      answers: message.result.value.answer.answers.map((item) => ({
        id: item.id,
        selected: [...item.selected],
        ...(item.custom === undefined ? {} : { custom: item.custom }),
      })),
    };
    question.settle('answered', answer);
    return { accepted: true };
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const subscription of [...this.#mux]) subscription.close();
    for (const pending of [...this.#pendingApprovals.values()]) pending.settle('cancelled');
    for (const pending of [...this.#pendingQuestions.values()]) pending.settle(
      'cancelled',
      questionError('dsh-im interaction adapter was disposed', 'ASK_ABORTED'),
    );
    for (const dispose of this.#disposers.splice(0).reverse()) dispose?.();
  }
}

/** Create one modern compatibility API per Cordis Host root. */
export function modernHarnessApi(ctx) {
  const scope = ctx?.root ?? ctx;
  if (!scope || !['object', 'function'].includes(typeof scope)) {
    throw new TypeError('dsh-im requires a Cordis Host context');
  }
  const cached = modernApis.get(scope);
  if (cached) return cached;
  const gateway = ctx?.typertGateway;
  if (!gateway || typeof gateway.invoke !== 'function' || typeof gateway.stream !== 'function') {
    throw new TypeError('dsh-im requires the modern Host Typert gateway');
  }
  const api = new ModernHarnessApi(ctx, gateway, scope);
  modernApis.set(scope, api);
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      if (modernApis.get(scope) === api) modernApis.delete(scope);
      api.dispose();
    }, 'dsh-im: modern Harness compatibility API');
  }
  return api;
}
