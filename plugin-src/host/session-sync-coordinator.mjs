import {
  AssistantTextAccumulator,
  consumeDshImInputOrigin,
  textFromHarnessContent,
} from '../../src/channels/shared/harness-client.mjs';
import { deliverSessionSyncMirror } from '../../src/channels/shared/session-sync-registry.mjs';

const DSH_USER_PREFIX = '[来自 DSH]\n';
const DSH_ASSISTANT_PREFIX = '[DSH 助手]\n';

function completedTurn(reason) {
  return (typeof reason === 'string' ? reason : reason?.kind) === 'completed';
}

function recipientKey(target) {
  return JSON.stringify([target.channel, target.botId, target.targetId]);
}

function sessionIdOf(session) {
  const value = session?.id ?? session?.sessionId;
  return typeof value === 'string' && value ? value : null;
}

function userInputOrigin(scope, event) {
  const source = event?.data?.source;
  if (source?.kind !== 'user' || typeof source.rpcId !== 'string' || !source.rpcId) {
    return 'other';
  }
  return consumeDshImInputOrigin(scope, source.rpcId) ? 'im' : 'dsh';
}

function validRecipient(target) {
  return target && typeof target === 'object'
    && typeof target.channel === 'string' && target.channel
    && typeof target.botId === 'string' && target.botId
    && typeof target.targetId === 'string' && target.targetId;
}

export function createSessionSyncCoordinator({ deliveryService, logger = console }) {
  if (typeof deliveryService?.listSessionSyncTargets !== 'function'
    || typeof deliveryService?.sendSessionSyncText !== 'function') {
    throw new TypeError('Session sync requires a complete delivery service');
  }

  const turns = new Map();
  const tails = new Map();
  let closed = false;

  const logFailure = (phase, target, error) => {
    logger.warn?.(
      `[dsh-im] ignored Session sync ${phase} failure`
        + (target ? ` (${target.channel}/${target.botId}/${target.targetId})` : '')
        + ` [${error?.code ?? error?.name ?? 'unknown-error'}]`,
    );
  };

  const deliver = async (sessionId, targets, text, phase) => {
    const unique = new Map();
    for (const target of targets) {
      if (validRecipient(target)) unique.set(recipientKey(target), target);
    }
    const entries = [...unique.entries()];
    const results = await Promise.allSettled(entries.map(([, target]) => (
      deliveryService.sendSessionSyncText(
        target.botId,
        target.targetId,
        sessionId,
        text,
      )
    )));
    const successful = new Map();
    results.forEach((result, index) => {
      const [key, target] = entries[index];
      if (result.status === 'fulfilled') successful.set(key, target);
      else logFailure(phase, target, result.reason);
    });
    return successful;
  };

  const processEvent = async (sessionId, event, origin) => {
    if (closed || !event || typeof event !== 'object') return;

    if (event.type === 'turn/start') {
      const turn = event.data?.turn;
      if (!Number.isSafeInteger(turn)) return;
      turns.set(sessionId, {
        turn,
        step: null,
        origin: 'unknown',
        recipients: null,
        assistant: new AssistantTextAccumulator(),
      });
      return;
    }

    const state = turns.get(sessionId);
    if (!state) return;

    if (event.type === 'step/start') {
      if (event.data?.turn !== undefined && event.data.turn !== state.turn) return;
      state.step = Number.isSafeInteger(event.data?.step) ? event.data.step : null;
      return;
    }

    if (event.type === 'step/end') {
      if (event.data?.turn !== undefined && event.data.turn !== state.turn) return;
      if (event.data?.step === undefined || event.data.step === state.step) state.step = null;
      return;
    }

    if (event.type === 'user/message') {
      if (event.surfaceOp !== 'append') return;
      if (state.origin === 'unknown') state.origin = origin;
      if (state.origin !== 'dsh' || origin !== 'dsh') return;
      // The user echo stays as plain text even when the mirror owns the
      // turn: the card also quotes the question, but keeping the echo here
      // guarantees recipients are established so a failed mirror can still
      // fall back to the final-answer text delivery.
      const text = textFromHarnessContent(event.data?.content);
      if (!text) return;

      let targets;
      try {
        targets = await deliveryService.listSessionSyncTargets(sessionId);
      } catch (error) {
        logFailure('lookup', null, error);
        targets = [];
      }
      const successful = await deliver(
        sessionId,
        targets,
        `${DSH_USER_PREFIX}${text}`,
        'user delivery',
      );
      if (state.recipients === null) {
        state.recipients = successful;
      } else {
        for (const key of [...state.recipients.keys()]) {
          if (!successful.has(key)) state.recipients.delete(key);
        }
      }
      return;
    }

    if (event.type === 'assistant/message') {
      if (state.origin !== 'dsh' || event.surfaceOp !== 'append'
        || event.data?.interrupted === true
        || (event.data?.turn !== undefined && event.data.turn !== state.turn)) return;
      const text = textFromHarnessContent(event.data?.message?.content);
      const step = Number.isSafeInteger(event.data?.step) ? event.data.step : state.step;
      state.assistant.setCanonical(step, text);
      return;
    }

    if (event.type !== 'turn/end' || event.data?.turn !== state.turn) return;
    turns.delete(sessionId);
    if (state.origin !== 'dsh' || !completedTurn(event.data?.reason)
      || !state.recipients?.size || !state.assistant.text) return;
    // A pending card is not proof of delivery. Only suppress this target's
    // text after its renderer confirms the complete final answer is visible.
    // Targets without a renderer retain the original text delivery path.
    const recipients = [...state.recipients.values()];
    const rendered = await Promise.all(recipients.map(async (target) => {
      try {
        return await deliverSessionSyncMirror(target, sessionId, state.turn, state.assistant.text);
      } catch (error) {
        logFailure('card delivery', target, error);
        return false;
      }
    }));
    const plain = recipients.filter((_target, index) => !rendered[index]);
    if (plain.length === 0) return;
    await deliver(
      sessionId,
      plain,
      `${DSH_ASSISTANT_PREFIX}${state.assistant.text}`,
      'assistant delivery',
    );
  };

  const enqueue = (sessionId, event, origin = 'other') => {
    if (closed || typeof sessionId !== 'string' || !sessionId) return Promise.resolve();
    const previous = tails.get(sessionId) ?? Promise.resolve();
    const task = previous.then(
      () => processEvent(sessionId, event, origin),
      () => processEvent(sessionId, event, origin),
    );
    const tail = task.catch((error) => logFailure('event handling', null, error)).finally(() => {
      if (tails.get(sessionId) === tail) tails.delete(sessionId);
    });
    tails.set(sessionId, tail);
    return tail;
  };

  return Object.freeze({
    enqueue,
    async whenIdle() {
      while (tails.size > 0) await Promise.allSettled([...tails.values()]);
    },
    close() {
      closed = true;
      turns.clear();
    },
  });
}

export function installSessionSyncCoordinator(ctx, deliveryService, {
  logger = console,
  inputScope = ctx?.root ?? ctx,
} = {}) {
  if (typeof ctx?.on !== 'function') {
    throw new TypeError('Session sync requires Host session events');
  }
  const coordinator = createSessionSyncCoordinator({ deliveryService, logger });
  const disposeEvent = ctx.on('session/event', (session, event) => {
    const sessionId = sessionIdOf(session);
    if (!sessionId) return;
    // Origin lookup must be synchronous: the originating ask may clean its id
    // immediately after this event callback returns.
    const origin = event?.type === 'user/message'
      ? userInputOrigin(inputScope, event)
      : 'other';
    void coordinator.enqueue(sessionId, event, origin);
  }, { global: true });
  let disposed = false;
  const close = () => {
    if (disposed) return;
    disposed = true;
    disposeEvent?.();
    coordinator.close();
  };
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => close, 'dsh-im: Session sync coordinator');
  }
  return Object.freeze({ ...coordinator, close });
}
