import { normalizeDeliveryTarget } from './delivery-adapter.mjs';

const BOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TARGET_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;
const CHANNEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const DRAFT_TARGET_ID = '__test__';

const ADAPTER_METHODS = Object.freeze([
  'ownsBot',
  'listBots',
  'listTargets',
  'listSuggestions',
  'createTarget',
  'updateTarget',
  'deleteTarget',
  'sendText',
]);

const DELIVERY_ERROR_CODES = new Set([
  'bad-request',
  'unknown-bot',
  'unknown-target',
  'target-conflict',
  'invalid-target',
  'bot-not-connected',
  'target-rejected',
  'delivery-failed',
  'session-sync-unavailable',
  'cancelled',
]);

const SESSION_SYNC_METHODS = Object.freeze([
  'setSessionSync',
  'listSessionSyncTargets',
  'sendSessionSyncText',
]);

function deliveryError(code, message = code, options) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

function botIdOf(value) {
  if (typeof value !== 'string' || !BOT_ID_PATTERN.test(value)) {
    throw deliveryError('bad-request', 'Invalid bot id');
  }
  return value;
}

function targetIdOf(value) {
  if (typeof value !== 'string' || !TARGET_ID_PATTERN.test(value)) {
    throw deliveryError('bad-request', 'Invalid target id');
  }
  return value;
}

function targetObject(value, { includesTargetId } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw deliveryError('bad-request', 'Invalid target');
  }
  if (includesTargetId) targetIdOf(value.targetId);
  else if (Object.hasOwn(value, 'targetId')) {
    throw deliveryError('bad-request', 'A target id cannot be changed');
  }
  return value;
}

function draftTargetObject(value) {
  targetObject(value);
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('route')) {
    throw deliveryError('bad-request', 'Invalid draft target');
  }
  return value;
}

function cancellation(signal) {
  if (signal?.aborted) throw deliveryError('cancelled', 'Request cancelled');
}

function publicOperationError(error, fallback = 'delivery-failed') {
  if (error?.code === 'workspace-bot-not-found') {
    return deliveryError('unknown-bot', 'Unknown bot', { cause: error });
  }
  if (DELIVERY_ERROR_CODES.has(error?.code)) return error;
  return deliveryError(fallback, fallback, { cause: error });
}

function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object'
    || typeof adapter.channel !== 'string' || !CHANNEL_PATTERN.test(adapter.channel)) {
    throw new TypeError('A delivery adapter with a valid channel is required');
  }
  for (const method of ADAPTER_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new TypeError(`A complete delivery adapter is required (${method})`);
    }
  }
  return adapter;
}

function sessionSyncState(value, available) {
  const enabled = value?.enabled === true;
  if (!available) return { enabled, state: 'unavailable' };
  const state = value?.state;
  if (['off', 'active', 'waiting', 'unavailable'].includes(state)) {
    return { enabled, state };
  }
  return { enabled: false, state: 'unavailable' };
}

export class DeliveryService {
  #adapters = new Map();
  #unavailableSessionSyncChannels;

  constructor({ unavailableSessionSyncChannels = [] } = {}) {
    if (!Array.isArray(unavailableSessionSyncChannels)
      || unavailableSessionSyncChannels.some((channel) => (
        typeof channel !== 'string' || !CHANNEL_PATTERN.test(channel)
      ))) {
      throw new TypeError('unavailableSessionSyncChannels must contain valid channel ids');
    }
    this.#unavailableSessionSyncChannels = new Set(unavailableSessionSyncChannels);
  }

  registerAdapter(value) {
    const adapter = validateAdapter(value);
    const registration = Object.freeze({ adapter });
    this.#adapters.set(adapter.channel, registration);
    return () => {
      if (this.#adapters.get(adapter.channel) !== registration) return false;
      this.#adapters.delete(adapter.channel);
      return true;
    };
  }

  async listTargets(botId) {
    const id = botIdOf(botId);
    const adapter = await this.#adapterFor(id);
    try {
      const targets = await adapter.listTargets(id);
      if (!Array.isArray(targets)) throw new TypeError('Adapter returned invalid targets');
      const available = this.#supportsSessionSync(adapter);
      return {
        botId: id,
        channel: adapter.channel,
        targets: targets.map((target) => ({
          ...target,
          sessionSync: sessionSyncState(target?.sessionSync, available),
        })),
      };
    } catch (error) {
      throw publicOperationError(error);
    }
  }

  async listBots() {
    const bots = [];
    for (const { adapter } of this.#adapters.values()) {
      try {
        const ids = await adapter.listBots();
        if (!Array.isArray(ids)) throw new TypeError('Adapter returned invalid bots');
        for (const botId of ids) bots.push({ botId: botIdOf(botId), channel: adapter.channel });
      } catch (error) {
        throw publicOperationError(error);
      }
    }
    return bots;
  }

  async listSuggestions(botId) {
    const id = botIdOf(botId);
    const adapter = await this.#adapterFor(id);
    try {
      const suggestions = await adapter.listSuggestions(id);
      if (!Array.isArray(suggestions)) throw new TypeError('Adapter returned invalid suggestions');
      return {
        botId: id,
        channel: adapter.channel,
        suggestions: suggestions.map((suggestion) => normalizeDeliveryTarget(
          adapter.channel,
          suggestion,
          { targetIdRequired: false },
        )),
      };
    } catch (error) {
      throw publicOperationError(error);
    }
  }

  async createTarget(botId, target) {
    const id = botIdOf(botId);
    targetObject(target, { includesTargetId: true });
    const adapter = await this.#adapterFor(id);
    try {
      return await adapter.createTarget(id, target);
    } catch (error) {
      throw publicOperationError(error);
    }
  }

  async updateTarget(botId, targetId, replacement) {
    const id = botIdOf(botId);
    const targetKey = targetIdOf(targetId);
    targetObject(replacement);
    const adapter = await this.#adapterFor(id);
    try {
      return await adapter.updateTarget(id, targetKey, replacement);
    } catch (error) {
      throw publicOperationError(error);
    }
  }

  async deleteTarget(botId, targetId) {
    const id = botIdOf(botId);
    const targetKey = targetIdOf(targetId);
    const adapter = await this.#adapterFor(id);
    try {
      await adapter.deleteTarget(id, targetKey);
      return { deleted: true };
    } catch (error) {
      throw publicOperationError(error);
    }
  }

  async setSessionSync(botId, targetId, enabled) {
    const id = botIdOf(botId);
    const targetKey = targetIdOf(targetId);
    if (typeof enabled !== 'boolean') throw deliveryError('bad-request', 'Invalid enabled state');
    const adapter = await this.#adapterFor(id);
    const hasMethods = SESSION_SYNC_METHODS.every((method) => typeof adapter[method] === 'function');
    if (!hasMethods || (enabled && !this.#supportsSessionSync(adapter))) {
      throw deliveryError('session-sync-unavailable', 'Session sync is unavailable');
    }
    try {
      return await adapter.setSessionSync(id, targetKey, enabled);
    } catch (error) {
      throw publicOperationError(error);
    }
  }

  async listSessionSyncTargets(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) {
      throw deliveryError('bad-request', 'Invalid Session id');
    }
    const targets = [];
    for (const { adapter } of this.#adapters.values()) {
      if (!this.#supportsSessionSync(adapter)) continue;
      try {
        const listed = await adapter.listSessionSyncTargets(sessionId);
        if (!Array.isArray(listed)) throw new TypeError('Adapter returned invalid sync targets');
        for (const target of listed) {
          targets.push({
            channel: adapter.channel,
            botId: botIdOf(target?.botId),
            targetId: targetIdOf(target?.targetId),
          });
        }
      } catch (error) {
        console.warn(
          `[dsh-im] ignored ${adapter.channel} Session sync target lookup failure`
            + ` (${error?.code ?? error?.name ?? 'unknown-error'})`,
        );
      }
    }
    return targets;
  }

  async sendSessionSyncText(botId, targetId, sessionId, text, { signal } = {}) {
    const id = botIdOf(botId);
    const targetKey = targetIdOf(targetId);
    if (typeof sessionId !== 'string' || !sessionId
      || typeof text !== 'string' || !text.trim()) {
      throw deliveryError('bad-request', 'Invalid session sync delivery');
    }
    cancellation(signal);
    const adapter = await this.#adapterFor(id);
    if (!this.#supportsSessionSync(adapter)) {
      throw deliveryError('session-sync-unavailable', 'Session sync is unavailable');
    }
    try {
      await adapter.sendSessionSyncText(id, targetKey, sessionId, text, { signal });
      return { sent: true };
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
        throw deliveryError('cancelled', 'Request cancelled', { cause: error });
      }
      throw publicOperationError(error);
    }
  }

  async send(botId, targetIdOrDraft, text, { signal, format = 'plain' } = {}) {
    const id = botIdOf(botId);
    const targetKey = typeof targetIdOrDraft === 'string'
      ? targetIdOf(targetIdOrDraft)
      : null;
    const draft = targetKey === null ? draftTargetObject(targetIdOrDraft) : null;
    if (typeof text !== 'string' || !text.trim()) {
      throw deliveryError('bad-request', 'Message text is required');
    }
    if (format !== 'plain' && format !== 'markdown') {
      throw deliveryError('bad-request', 'Message format must be plain or markdown');
    }
    cancellation(signal);
    const adapter = await this.#adapterFor(id);
    try {
      let target;
      if (draft) {
        target = { targetId: DRAFT_TARGET_ID, ...draft };
      } else {
        const targets = await adapter.listTargets(id);
        if (!Array.isArray(targets)) throw new TypeError('Adapter returned invalid targets');
        target = targets.find((candidate) => candidate?.targetId === targetKey);
        if (!target) throw deliveryError('unknown-target', 'Unknown target');
      }
      cancellation(signal);
      await adapter.sendText(id, target, text, {
        signal,
        ...(format === 'markdown' ? { format } : {}),
      });
      return { sent: true };
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
        throw deliveryError('cancelled', 'Request cancelled', { cause: error });
      }
      throw publicOperationError(error);
    }
  }

  async #adapterFor(botId) {
    for (const { adapter } of this.#adapters.values()) {
      let ownsBot;
      try {
        ownsBot = await adapter.ownsBot(botId);
      } catch (error) {
        throw publicOperationError(error);
      }
      if (ownsBot) return adapter;
    }
    throw deliveryError('unknown-bot', 'Unknown bot');
  }

  #supportsSessionSync(adapter) {
    return !this.#unavailableSessionSyncChannels.has(adapter.channel)
      && SESSION_SYNC_METHODS.every((method) => typeof adapter[method] === 'function');
  }
}

export function createDeliveryService(options) {
  return new DeliveryService(options);
}
