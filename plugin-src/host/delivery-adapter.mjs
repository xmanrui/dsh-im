import {
  deliverySuggestionsFromSessions,
  privateConversationKeyMatchesTarget,
  resolvePrivateConversationKey,
} from './delivery-suggestions.mjs';

const CHANNELS = new Set([
  'weixin',
  'feishu',
  'dingtalk',
  'wecom',
  'wecom-app',
  'qq',
  'slack',
  'telegram',
  'discord',
  'whatsapp',
  'imessage',
  'email',
  'matrix',
]);

export function supportsDeliveryChannel(channel) {
  return CHANNELS.has(channel);
}

function invalidTarget(message) {
  const error = new Error(message);
  error.code = 'invalid-target';
  return error;
}

function sessionSyncUnavailable(message = 'Session sync is unavailable for this target') {
  const error = new Error(message);
  error.code = 'session-sync-unavailable';
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  if (!isRecord(value)) throw invalidTarget(`${label} must be an object`);
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw invalidTarget(`${label} contains an unknown field`);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw invalidTarget(`${label} must be a non-empty string without surrounding whitespace`);
  }
  return value;
}

function targetName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) {
    throw invalidTarget('target.name must contain 1 to 80 characters');
  }
  return value.trim();
}

function routeWithStrings(route, fields) {
  exactKeys(route, fields, 'route');
  const normalized = {};
  for (const field of fields) normalized[field] = requiredString(route[field], `route.${field}`);
  return normalized;
}

function oneOf(value, choices) {
  if (!choices.includes(value)) throw invalidTarget('target kind is not supported by this channel');
  return value;
}

function normalizeRoute(channel, kind, route) {
  switch (channel) {
    case 'weixin':
      oneOf(kind, ['user']);
      return routeWithStrings(route, ['toUserId']);
    case 'feishu':
      oneOf(kind, ['user', 'group']);
      return routeWithStrings(route, kind === 'user' ? ['openId'] : ['chatId']);
    case 'dingtalk':
      oneOf(kind, ['user', 'group']);
      return routeWithStrings(route, kind === 'user' ? ['userId'] : ['openConversationId']);
    case 'wecom':
      oneOf(kind, ['user', 'group']);
      return routeWithStrings(route, ['chatId']);
    case 'wecom-app':
      oneOf(kind, ['user']);
      return routeWithStrings(route, ['chatId']);
    case 'qq':
      oneOf(kind, ['user', 'group']);
      return routeWithStrings(route, kind === 'user' ? ['userOpenId'] : ['groupOpenId']);
    case 'slack': {
      oneOf(kind, ['conversation', 'thread']);
      const normalized = routeWithStrings(
        route,
        kind === 'conversation' ? ['channelId'] : ['channelId', 'threadTs'],
      );
      return normalized;
    }
    case 'telegram': {
      oneOf(kind, ['chat', 'topic']);
      exactKeys(route, kind === 'chat' ? ['chatId'] : ['chatId', 'messageThreadId'], 'route');
      const chatId = requiredString(route.chatId, 'route.chatId');
      if (!/^-?\d+$/.test(chatId)) throw invalidTarget('route.chatId must be a decimal string');
      if (kind === 'chat') return { chatId };
      if (!Number.isSafeInteger(route.messageThreadId) || route.messageThreadId <= 0) {
        throw invalidTarget('route.messageThreadId must be a positive integer');
      }
      return { chatId, messageThreadId: route.messageThreadId };
    }
    case 'discord':
      oneOf(kind, ['channel']);
      return routeWithStrings(route, ['channelId']);
    case 'whatsapp': {
      oneOf(kind, ['user', 'group']);
      const normalized = routeWithStrings(route, ['jid']);
      const valid = kind === 'user'
        ? /^\d{5,32}@(s\.whatsapp\.net|lid)$/.test(normalized.jid)
        : /^\d{5,32}(?:-\d{1,32})?@g\.us$/.test(normalized.jid);
      if (!valid) {
        throw invalidTarget(`route.jid must be a ${kind} WhatsApp JID`);
      }
      return normalized;
    }
    case 'imessage':
      oneOf(kind, ['user']);
      return routeWithStrings(route, ['chatGuid']);
    case 'email': {
      oneOf(kind, ['user']);
      const normalized = routeWithStrings(route, ['address']);
      // Mail addresses are normalized to lower case everywhere so a target
      // created from a mixed-case address still matches.
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(normalized.address)) {
        throw invalidTarget('route.address must be a valid email address');
      }
      return { address: normalized.address.toLowerCase() };
    }
    case 'matrix': {
      oneOf(kind, ['room', 'thread', 'dm']);
      const normalized = routeWithStrings(
        route,
        kind === 'room' ? ['roomId'] : kind === 'thread' ? ['roomId', 'threadId'] : ['userId'],
      );
      if (kind === 'dm' && !/^@[^:\s]+:[^\s:]+(?::\d{1,5})?$/u.test(normalized.userId)) {
        throw invalidTarget('route.userId must be a Matrix user id');
      }
      if (kind !== 'dm' && !/^[!][^:$\s]+:[^\s:$]+(?::\d{1,5})?$/.test(normalized.roomId)) {
        throw invalidTarget('route.roomId must be a Matrix room id');
      }
      if (kind === 'thread' && !/^\$[^\s]+/.test(normalized.threadId)) {
        throw invalidTarget('route.threadId must be a Matrix event id');
      }
      return normalized;
    }
    default:
      throw new TypeError(`Unsupported delivery channel: ${channel}`);
  }
}

/** Strictly validate and copy one channel delivery target. */
export function normalizeDeliveryTarget(channel, value, { targetIdRequired = true } = {}) {
  if (!supportsDeliveryChannel(channel)) throw new TypeError(`Unsupported delivery channel: ${channel}`);
  exactKeys(
    value,
    targetIdRequired ? ['targetId', 'name', 'kind', 'route'] : ['name', 'kind', 'route'],
    'target',
  );
  const normalized = {};
  if (targetIdRequired) normalized.targetId = requiredString(value.targetId, 'target.targetId');
  if (value.name !== undefined) normalized.name = targetName(value.name);
  normalized.kind = requiredString(value.kind, 'target.kind');
  normalized.route = normalizeRoute(channel, normalized.kind, value.route);
  return normalized;
}

function targetWithoutSessionSync(target) {
  return {
    targetId: target.targetId,
    ...(target.name === undefined ? {} : { name: target.name }),
    kind: target.kind,
    route: target.route,
  };
}

function sessionSyncConfigs(workspaces, botId) {
  if (typeof workspaces.listSessionSyncTargets !== 'function') return [];
  const targets = workspaces.listSessionSyncTargets();
  return botId === undefined ? targets : targets.filter((target) => target.botId === botId);
}

function stateSessions(state) {
  if (!state || typeof state.snapshot !== 'function') return null;
  const sessions = state.snapshot()?.sessions;
  return sessions && typeof sessions === 'object' && !Array.isArray(sessions) ? sessions : null;
}

function sessionSyncView(channel, target, sessions, configured) {
  if (configured) {
    const valid = privateConversationKeyMatchesTarget(
      channel,
      configured.conversationKey,
      target,
    );
    if (!valid || !sessions) return { enabled: true, state: 'unavailable' };
    return {
      enabled: true,
      state: typeof sessions[configured.conversationKey] === 'string'
        && Boolean(sessions[configured.conversationKey])
        ? 'active'
        : 'waiting',
    };
  }
  const conversationKey = sessions
    ? resolvePrivateConversationKey(channel, sessions, target)
    : null;
  return { enabled: false, state: conversationKey ? 'off' : 'unavailable' };
}

/** Bind one channel's existing workspace store and unwrapped controller to DeliveryService. */
export function createDeliveryAdapter({ channel, workspaces, coreController, stateFor }) {
  if (!supportsDeliveryChannel(channel)) throw new TypeError(`Unsupported delivery channel: ${channel}`);
  if (!workspaces || typeof workspaces !== 'object') {
    throw new TypeError('delivery adapter requires a workspace store');
  }
  if (!coreController || typeof coreController !== 'object') {
    throw new TypeError('delivery adapter requires a proactive text controller');
  }
  if (typeof stateFor !== 'function') {
    throw new TypeError('delivery adapter requires a bot state getter');
  }
  return Object.freeze({
    channel,
    ownsBot: (botId) => workspaces.has(botId),
    listBots: () => workspaces.listBotIds(),
    async listTargets(botId) {
      const targets = workspaces.listDeliveryTargets(botId);
      const configured = new Map(
        sessionSyncConfigs(workspaces, botId).map((target) => [target.targetId, target]),
      );
      let sessions = null;
      try {
        sessions = stateSessions(await stateFor(botId));
      } catch {
        // Target CRUD remains usable when its persisted conversation state cannot be read.
      }
      return targets.map((target) => ({
        ...target,
        sessionSync: sessionSyncView(channel, target, sessions, configured.get(target.targetId)),
      }));
    },
    async listSuggestions(botId) {
      const state = await stateFor(botId);
      if (!state || typeof state.snapshot !== 'function') {
        throw new TypeError('delivery suggestion state cannot be inspected');
      }
      const suggestions = deliverySuggestionsFromSessions(channel, state.snapshot()?.sessions);
      return suggestions.map((suggestion) => normalizeDeliveryTarget(
        channel,
        suggestion,
        { targetIdRequired: false },
      ));
    },
    createTarget: (botId, target) => workspaces.createDeliveryTarget(
      botId,
      normalizeDeliveryTarget(channel, target),
    ),
    updateTarget: (botId, targetId, replacement) => workspaces.updateDeliveryTarget(
      botId,
      targetId,
      normalizeDeliveryTarget(channel, replacement, { targetIdRequired: false }),
    ),
    deleteTarget: (botId, targetId) => workspaces.deleteDeliveryTarget(botId, targetId),
    async sendText(botId, target, text, options = {}) {
      const normalized = normalizeDeliveryTarget(channel, targetWithoutSessionSync(target));
      if (typeof coreController.sendProactiveText !== 'function') {
        throw new TypeError('delivery controller cannot send proactive text');
      }
      await coreController.sendProactiveText(botId, normalized, text, options);
      return { sent: true };
    },
    async setSessionSync(botId, targetId, enabled) {
      if (typeof workspaces.setDeliveryTargetSessionSync !== 'function') {
        throw sessionSyncUnavailable();
      }
      const target = workspaces.deliveryTargetFor(botId, targetId);
      if (!target) {
        const error = new Error('Unknown target');
        error.code = 'unknown-target';
        throw error;
      }
      if (!enabled) {
        await workspaces.setDeliveryTargetSessionSync(botId, targetId, null);
        let sessions = null;
        try {
          sessions = stateSessions(await stateFor(botId));
        } catch {
          // The setting is already safely disabled; only its availability is unknown.
        }
        return sessionSyncView(channel, target, sessions, null);
      }
      const sessions = stateSessions(await stateFor(botId));
      const conversationKey = resolvePrivateConversationKey(channel, sessions, target);
      if (!conversationKey) throw sessionSyncUnavailable();
      await workspaces.setDeliveryTargetSessionSync(botId, targetId, conversationKey);
      return { enabled: true, state: 'active' };
    },
    async listSessionSyncTargets(sessionId) {
      if (typeof sessionId !== 'string' || !sessionId) {
        throw new TypeError('sessionId is required');
      }
      const matches = [];
      for (const configured of sessionSyncConfigs(workspaces)) {
        const target = workspaces.deliveryTargetFor(configured.botId, configured.targetId);
        if (!target || !privateConversationKeyMatchesTarget(
          channel,
          configured.conversationKey,
          target,
        )) continue;
        let sessions;
        try {
          sessions = stateSessions(await stateFor(configured.botId));
        } catch {
          continue;
        }
        if (sessions?.[configured.conversationKey] === sessionId) {
          matches.push({ botId: configured.botId, targetId: configured.targetId });
        }
      }
      return matches;
    },
    async sendSessionSyncText(botId, targetId, sessionId, text, options = {}) {
      if (typeof text !== 'string' || !text.trim()) throw new TypeError('text is required');
      const configured = sessionSyncConfigs(workspaces, botId)
        .find((target) => target.targetId === targetId);
      const target = workspaces.deliveryTargetFor(botId, targetId);
      if (!configured || !target || !privateConversationKeyMatchesTarget(
        channel,
        configured.conversationKey,
        target,
      )) throw sessionSyncUnavailable('Session sync target is no longer enabled');
      const sessions = stateSessions(await stateFor(botId));
      if (sessions?.[configured.conversationKey] !== sessionId) {
        throw sessionSyncUnavailable('Session sync target is no longer bound to this Session');
      }
      if (typeof coreController.sendProactiveText !== 'function') {
        throw new TypeError('delivery controller cannot send proactive text');
      }
      await coreController.sendProactiveText(botId, target, text, options);
      return { sent: true };
    },
  });
}
