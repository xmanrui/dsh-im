const MAX_EVENTS_PER_WRITE = 50;
const MAX_EVENT_CONTENT_CHARS = 4096;
const MAX_TOOL_RESULT_CHARS = 1500;
// Feishu publishes no COT-specific rate limit; space requests conservatively.
const MIN_COT_REQUEST_INTERVAL_MS = 65;

// The user stopped the turn: close it as interrupted, not as a failed run.
const INTERRUPTED_KINDS = new Set(['interrupted', 'stopped', 'cancelled', 'canceled']);
const INTERRUPTED_ERROR_CODES = new Set(['turn-stopped', 'turn-interrupted']);

const TOOL_ICONS = Object.freeze({
  read: 'read',
  edit: 'write',
  delete: 'write',
  move: 'write',
  search: 'search',
  fetch: 'search',
  execute: 'bash',
});

let lastTimestamp = 0;

function boundedEventContent(content) {
  const encoded = JSON.stringify(content);
  if (encoded.length <= MAX_EVENT_CONTENT_CHARS) return encoded;
  const field = typeof content?.delta === 'string'
    ? 'delta'
    : typeof content?.message === 'string' ? 'message' : null;
  if (!field) return JSON.stringify({ ...content, truncated: true });

  const truncated = { ...content, truncated: true, [field]: content[field] };
  while (truncated[field].length > 0
    && JSON.stringify(truncated).length > MAX_EVENT_CONTENT_CHARS) {
    truncated[field] = truncated[field].slice(0, Math.max(0, truncated[field].length - 256));
  }
  if (truncated[field].length === 0
    && JSON.stringify(truncated).length > MAX_EVENT_CONTENT_CHARS) {
    return JSON.stringify({ truncated: true });
  }
  return JSON.stringify(truncated);
}

function cotEvent(eventType, content) {
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
  return {
    event_type: eventType,
    content: boundedEventContent(content),
    timestamp: String(lastTimestamp),
  };
}

function boundedResult(value) {
  const text = String(value ?? '');
  return text.length <= MAX_TOOL_RESULT_CHARS
    ? text
    : `${text.slice(0, MAX_TOOL_RESULT_CHARS - 1)}…`;
}

function toolKind(name) {
  const value = String(name ?? '').toLowerCase();
  if (/read|view|list|get/.test(value)) return 'read';
  if (/edit|write|create|patch|update/.test(value)) return 'edit';
  if (/delete|remove/.test(value)) return 'delete';
  if (/move|rename/.test(value)) return 'move';
  if (/search|grep|glob|find/.test(value)) return 'search';
  if (/fetch|web|http|download/.test(value)) return 'fetch';
  if (/shell|bash|command|exec|terminal/.test(value)) return 'execute';
  return '';
}

function turnOutcome(reason) {
  if (reason instanceof Error) {
    return INTERRUPTED_ERROR_CODES.has(reason.code)
      ? { status: 'interrupted' }
      : { failure: reason.message || 'Turn failed' };
  }
  const kind = typeof reason === 'string' ? reason : reason?.kind;
  if (reason === null || reason === undefined || kind === 'completed') return { status: 'done' };
  if (INTERRUPTED_KINDS.has(kind)) return { status: 'interrupted' };
  if (kind !== 'error') {
    return { failure: kind ? `Turn ended: ${kind}` : 'Turn failed' };
  }
  const error = reason.error ?? reason.failure;
  if (!error) return { failure: 'Turn failed' };
  return { failure: [error.code, error.message].filter(Boolean).join(': ') || 'Turn failed' };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Maps Harness progress updates to Feishu's native thinking-process events.
 * Process failures are contained here so they can never suppress the answer.
 */
export class FeishuLiveCot {
  #channel;
  #chatId;
  #replyTo;
  #replyInThread;
  #onReplyThreadId;
  #hidden;
  #onFailure;
  #requestIntervalMs;
  #turn = null;
  #opening = null;
  #handle = null;
  #lastRequestAt = 0;
  #chain = Promise.resolve();
  #pending = [];
  #closing = null;
  // Set once the terminal event is queued: a stop can land while handle() is
  // mid-update, and nothing may follow RUN_FINISHED/RUN_ERROR.
  #sealed = false;
  #reasoningOpen = false;
  #heldAssistant = null;
  #finished = false;
  #broken = false;
  #messageIndex = 0;

  constructor(channel, chatId, {
    replyTo,
    replyInThread = false,
    onReplyThreadId,
    hidden = false,
    onFailure = () => {},
    requestIntervalMs = MIN_COT_REQUEST_INTERVAL_MS,
  } = {}) {
    this.#channel = channel;
    this.#chatId = chatId;
    this.#replyTo = replyTo;
    this.#replyInThread = replyInThread === true && Boolean(replyTo);
    this.#onReplyThreadId = onReplyThreadId;
    this.#hidden = hidden === true;
    this.#onFailure = onFailure;
    this.#requestIntervalMs = requestIntervalMs;
  }

  async #start(turn) {
    if (this.#turn !== null || this.#broken) return;
    this.#turn = Number.isSafeInteger(turn) ? turn : 0;
    this.#opening = this.#channel.createCot(this.#chatId, {
      ...(this.#replyTo ? { replyTo: this.#replyTo } : {}),
      // A topic turn keeps its process inside the topic (reply_in_thread).
      ...(this.#replyInThread ? { replyInThread: true } : {}),
      hidden: this.#hidden,
    }).then(async (handle) => {
      this.#handle = handle;
      this.#lastRequestAt = Date.now();
      if (this.#replyInThread && typeof this.#onReplyThreadId === 'function') {
        try {
          await this.#onReplyThreadId(handle?.threadId ?? null);
        } catch (error) {
          this.#onFailure(error);
        }
      }
      return handle;
    }, (error) => {
      this.#broken = true;
      this.#onFailure(error);
      return null;
    });
    await this.#write([
      cotEvent('RUN_STARTED', {
        threadId: this.#chatId,
        runId: `turn-${this.#turn}`,
      }),
    ]);
  }

  /** Space requests on this process; deltas arriving meanwhile share a batch. */
  async #throttle() {
    const wait = this.#lastRequestAt + this.#requestIntervalMs - Date.now();
    if (wait > 0) await delay(wait);
    this.#lastRequestAt = Date.now();
  }

  #write(events) {
    if (this.#broken || this.#sealed || events.length === 0) return;
    this.#pending.push(...events);
    this.#chain = this.#chain.then(async () => {
      const handle = await this.#opening;
      if (!handle || this.#broken) {
        this.#pending.length = 0;
        return;
      }
      while (this.#pending.length > 0) {
        await this.#throttle();
        await this.#channel.writeCotEvents(
          handle,
          this.#pending.splice(0, MAX_EVENTS_PER_WRITE),
        );
      }
    }).catch((error) => {
      this.#broken = true;
      this.#pending.length = 0;
      this.#onFailure(error);
    });
  }

  /**
   * Close the native process lifecycle. Terminal events alone leave the IM
   * message spinning, so this runs even after an earlier write failed.
   */
  async #complete(reason) {
    await this.#opening;
    const handle = this.#handle;
    if (!handle || typeof this.#channel.completeCot !== 'function') return;
    try {
      await this.#throttle();
      await this.#channel.completeCot(handle, reason);
    } catch (error) {
      this.#onFailure(error);
    }
  }

  async #closeReasoning() {
    if (!this.#reasoningOpen) return;
    this.#reasoningOpen = false;
    await this.#write([
      cotEvent('REASONING_MESSAGE_END', {
        messageId: `reasoning-${this.#turn}`,
      }),
    ]);
  }

  async #flushHeldAssistant() {
    const held = this.#heldAssistant;
    this.#heldAssistant = null;
    if (!held?.text) return;
    const messageId = `text-${this.#turn}-${this.#messageIndex++}`;
    await this.#write([
      cotEvent('TEXT_MESSAGE_START', { messageId, role: 'assistant' }),
      cotEvent('TEXT_MESSAGE_CONTENT', { messageId, delta: held.text }),
      cotEvent('TEXT_MESSAGE_END', { messageId }),
    ]);
  }

  async handle(update) {
    if (!update || this.#finished || this.#broken) return;
    if (update.type === 'turn-start') {
      await this.#start(update.turn);
      return;
    }
    await this.#start(update.turn);
    if (update.type === 'reasoning') {
      if (!update.text) return;
      const messageId = `reasoning-${this.#turn}`;
      if (!this.#reasoningOpen) {
        this.#reasoningOpen = true;
        await this.#write([
          cotEvent('REASONING_MESSAGE_START', { messageId, role: 'reasoning' }),
        ]);
      }
      await this.#write([
        cotEvent('REASONING_MESSAGE_CONTENT', { messageId, delta: update.text }),
      ]);
      return;
    }
    if (update.type === 'assistant-message') {
      if (this.#heldAssistant) await this.#flushHeldAssistant();
      this.#heldAssistant = update;
      return;
    }
    if (update.type === 'tool') {
      await this.#flushHeldAssistant();
      await this.#closeReasoning();
      const toolCallId = update.callId ?? `tool-${this.#turn}-${this.#messageIndex++}`;
      const kind = toolKind(update.name);
      await this.#write([
        cotEvent('TOOL_CALL_START', {
          toolCallId,
          icon: TOOL_ICONS[kind] ?? 'default',
          title: update.name || 'Tool',
          toolCallName: update.name || 'tool',
        }),
        cotEvent('TOOL_CALL_ARGS', {
          toolCallId,
          delta: update.arguments ?? '',
        }),
        cotEvent('TOOL_CALL_END', { toolCallId }),
      ]);
      return;
    }
    if (update.type === 'tool-result' && update.callId) {
      await this.#write([
        cotEvent('TOOL_CALL_RESULT', {
          messageId: `result-${update.callId}`,
          toolCallId: update.callId,
          role: 'tool',
          content: { type: 'code', code: boundedResult(update.text) },
          ...(update.errorCode ? { error: update.errorCode } : {}),
        }),
      ]);
      return;
    }
    if (update.type === 'turn-end') {
      await this.finish(update.reason);
    }
  }

  /**
   * Write the terminal event, then CompleteCOT. A user stop writes
   * RUN_FINISHED(interrupted) and completes with reason=error instead of
   * reporting RUN_ERROR; repeated calls share one close and never reject.
   */
  finish(reason) {
    this.#closing ??= this.#close(reason);
    return this.#closing;
  }

  async #close(reason) {
    this.#finished = true;
    this.#heldAssistant = null;
    if (this.#turn === null) {
      await this.#chain;
      return;
    }
    const outcome = turnOutcome(reason);
    if (!this.#broken) {
      const events = [];
      if (this.#reasoningOpen) {
        this.#reasoningOpen = false;
        events.push(cotEvent('REASONING_MESSAGE_END', { messageId: `reasoning-${this.#turn}` }));
      }
      events.push(outcome.failure
        ? cotEvent('RUN_ERROR', { message: outcome.failure, code: 'TURN_FAILED' })
        : cotEvent('RUN_FINISHED', {
            threadId: this.#chatId,
            runId: `turn-${this.#turn}`,
            status: outcome.status,
          }));
      this.#write(events);
    }
    this.#sealed = true;
    await this.#chain;
    await this.#complete(outcome.status === 'done' ? 'done' : 'error');
  }
}
