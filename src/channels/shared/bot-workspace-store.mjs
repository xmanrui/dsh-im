import {
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import {
  normalizeAgentPresetCatalog,
  validateAgentPresetId,
} from './agent-preset.mjs';
import {
  normalizeAccessPolicy,
  validateAccessPolicy,
} from './access-policy.mjs';
import { CONNECTION_TEST_STATE_IDENTITY } from './connection-test.mjs';
import {
  deleteInboundAttachments,
  normalizeInboundRetention,
} from './inbound-file.mjs';
import {
  DEFAULT_CONTEXT_ENHANCEMENT_CONFIG,
  normalizeContextEnhancementConfig,
  validateContextEnhancementConfig,
} from './context-enhancement.mjs';
import { WORKSPACE_SESSION_STALE } from './workspace-session.mjs';

const EMPTY_DOCUMENT = Object.freeze({ version: 1, workspaces: Object.freeze({}) });

function workspaceSessionStale(message) {
  const error = new Error(message);
  error.code = WORKSPACE_SESSION_STALE;
  return error;
}

async function canonicalWorkspacePath(value) {
  return resolve(await realpath(value));
}

async function sameWorkspacePath(left, right) {
  if (left === right) return true;
  try {
    return await canonicalWorkspacePath(left) === await canonicalWorkspacePath(right);
  } catch {
    return false;
  }
}

function botIdOf(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError('Invalid bot id');
  }
  return value;
}

function deliveryTargetError(code, message, options) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

function targetIdOf(value) {
  if (typeof value !== 'string'
    || !/^[A-Za-z0-9._:@-]{1,128}$/.test(value)) {
    throw deliveryTargetError('invalid-target', 'Invalid target id');
  }
  return value;
}

function jsonRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw deliveryTargetError('invalid-target', 'Invalid target route');
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('route is not JSON');
    const route = JSON.parse(serialized);
    if (!route || typeof route !== 'object' || Array.isArray(route)) {
      throw new TypeError('route is not an object');
    }
    return route;
  } catch (cause) {
    throw deliveryTargetError('invalid-target', 'Invalid target route', { cause });
  }
}

function normalizeDeliveryTarget(value, { targetId } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw deliveryTargetError('invalid-target', 'Invalid delivery target');
  }
  const allowed = targetId === undefined
    ? new Set(['targetId', 'name', 'kind', 'route'])
    : new Set(['name', 'kind', 'route']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw deliveryTargetError('invalid-target', 'Invalid delivery target');
  }
  const id = targetIdOf(targetId ?? value.targetId);
  if (typeof value.kind !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(value.kind)) {
    throw deliveryTargetError('invalid-target', 'Invalid target kind');
  }
  let name;
  if (value.name !== undefined) {
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80) {
      throw deliveryTargetError('invalid-target', 'Invalid target name');
    }
    name = value.name.trim();
  }
  return {
    targetId: id,
    ...(name === undefined ? {} : { name }),
    kind: value.kind,
    route: jsonRecord(value.route),
  };
}

function normalizeDeliveryTargets(value) {
  const deliveryTargets = Object.create(null);
  if (value === undefined) return deliveryTargets;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    for (const [botId, targets] of Object.entries(value)) {
      botIdOf(botId);
      if (!targets || typeof targets !== 'object' || Array.isArray(targets)) return null;
      const normalizedTargets = Object.create(null);
      for (const [targetId, target] of Object.entries(targets)) {
        const normalized = normalizeDeliveryTarget(target, { targetId });
        const { targetId: _targetId, ...stored } = normalized;
        normalizedTargets[targetId] = stored;
      }
      deliveryTargets[botId] = normalizedTargets;
    }
  } catch {
    return null;
  }
  return deliveryTargets;
}

function normalizeAccessPolicies(value, workspaces) {
  const accessPolicies = Object.create(null);
  if (value === undefined) return accessPolicies;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    // Preserve the distinction between a missing policy (eligible for startup
    // initialization) and damaged persisted data (fail closed).
    for (const botId of Object.keys(workspaces)) accessPolicies[botId] = null;
    return accessPolicies;
  }
  for (const [botId, policy] of Object.entries(value)) {
    try {
      botIdOf(botId);
      accessPolicies[botId] = normalizeAccessPolicy(policy);
    } catch {
      // An invalid key cannot identify a bot, so it is isolated and ignored.
    }
  }
  return accessPolicies;
}

function normalizeDocument(value) {
  if (!value || ![1, 2].includes(value.version) || !value.workspaces
    || typeof value.workspaces !== 'object' || Array.isArray(value.workspaces)) return null;
  const workspaces = {};
  for (const [botId, workspace] of Object.entries(value.workspaces)) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(botId)
      || typeof workspace !== 'string' || !isAbsolute(workspace)) return null;
    workspaces[botId] = resolve(workspace);
  }
  let agentPresets = {};
  if (value.agentPresets !== undefined) {
    if (!value.agentPresets || typeof value.agentPresets !== 'object'
      || Array.isArray(value.agentPresets)) return null;
    for (const [botId, agentPreset] of Object.entries(value.agentPresets)) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(botId)) return null;
      try {
        const normalized = validateAgentPresetId(agentPreset);
        if (!normalized) return null;
        agentPresets[botId] = normalized;
      } catch {
        return null;
      }
    }
  }
  const contextEnhancement = Object.create(null);
  // Enhancement damage is isolated from the existing workspace/preset document.
  if (value.contextEnhancement && typeof value.contextEnhancement === 'object'
    && !Array.isArray(value.contextEnhancement)) {
    for (const [botId, config] of Object.entries(value.contextEnhancement)) {
      if (/^[A-Za-z0-9_-]{1,128}$/.test(botId)) {
        contextEnhancement[botId] = normalizeContextEnhancementConfig(config);
      }
    }
  }
  if (value.version === 1 && value.deliveryTargets !== undefined) return null;
  const deliveryTargets = normalizeDeliveryTargets(value.deliveryTargets);
  if (!deliveryTargets) return null;
  const accessPolicies = normalizeAccessPolicies(value.accessPolicies, workspaces);
  const version = value.accessPolicies === undefined ? value.version : 2;
  const inboundRetention = Object.create(null);
  // Retention damage is isolated per bot, like other per-bot sections.
  if (value.inboundRetention && typeof value.inboundRetention === 'object'
    && !Array.isArray(value.inboundRetention)) {
    for (const [botId, retention] of Object.entries(value.inboundRetention)) {
      if (/^[A-Za-z0-9_-]{1,128}$/.test(botId)) {
        const normalized = normalizeInboundRetention(retention);
        // 'turn' is the default; only meaningful values are stored.
        if (normalized === 'forever') inboundRetention[botId] = normalized;
      }
    }
  }
  return {
    // A v1 file cannot be emitted with this optional v2 section. If one is
    // recovered from an interrupted/manual edit, retain it on the next write.
    version,
    workspaces,
    agentPresets,
    contextEnhancement,
    deliveryTargets,
    accessPolicies,
    inboundRetention,
  };
}

function storedDocument({
  version,
  workspaces,
  agentPresets,
  contextEnhancement,
  deliveryTargets,
  accessPolicies,
  inboundRetention,
}) {
  const document = { version, workspaces };
  if (Object.keys(agentPresets).length > 0) document.agentPresets = agentPresets;
  if (Object.keys(contextEnhancement).length > 0) {
    document.contextEnhancement = contextEnhancement;
  }
  if (version >= 2 && Object.keys(deliveryTargets).length > 0) {
    document.deliveryTargets = deliveryTargets;
  }
  if (version >= 2 && Object.keys(accessPolicies).length > 0) {
    document.accessPolicies = accessPolicies;
  }
  if (Object.keys(inboundRetention).length > 0) {
    document.inboundRetention = inboundRetention;
  }
  return document;
}

async function writeStoredDocument(path, document) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, path);
}

export async function validateWorkspacePath(value) {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value.trim())) {
    const error = new Error('工作区必须是绝对路径。');
    error.code = 'workspace-not-absolute';
    throw error;
  }
  const workspace = resolve(value.trim());
  let info;
  try {
    info = await stat(workspace);
  } catch (cause) {
    const error = new Error('工作区路径不存在。', { cause });
    error.code = 'workspace-not-found';
    throw error;
  }
  if (!info.isDirectory()) {
    const error = new Error('工作区路径必须指向一个目录。');
    error.code = 'workspace-not-directory';
    throw error;
  }
  return workspace;
}

export class BotWorkspaceStore {
  #path;
  #defaultWorkspace;
  #version = 1;
  #workspaces = {};
  #agentPresets = {};
  #contextEnhancement = {};
  #inboundRetention = Object.create(null);
  #deliveryTargets = Object.create(null);
  #accessPolicies = Object.create(null);
  #generations = new Map();
  #nextGeneration = 1;
  #incarnations = new Map();
  #nextIncarnation = 1;
  #removals = new Map();
  #removalDetails = new WeakMap();
  #dirtyRemovals = new Set();
  #writeQueue = Promise.resolve();
  #botQueues = new Map();

  constructor(path, { defaultWorkspace = process.cwd() } = {}) {
    if (typeof path !== 'string' || !path) throw new TypeError('workspace store path is required');
    this.#path = path;
    this.#defaultWorkspace = resolve(defaultWorkspace);
  }

  async load() {
    try {
      const normalized = normalizeDocument(JSON.parse(await readFile(this.#path, 'utf8')));
      if (!normalized) throw new Error('dsh-im workspace config is invalid');
      this.#version = normalized.version;
      this.#workspaces = normalized.workspaces;
      this.#agentPresets = normalized.agentPresets;
      this.#contextEnhancement = normalized.contextEnhancement;
      this.#inboundRetention = normalized.inboundRetention;
      this.#deliveryTargets = normalized.deliveryTargets;
      this.#accessPolicies = normalized.accessPolicies;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.#version = 1;
      this.#workspaces = {};
      this.#agentPresets = {};
      this.#contextEnhancement = {};
      this.#inboundRetention = Object.create(null);
      this.#deliveryTargets = Object.create(null);
      this.#accessPolicies = Object.create(null);
    }
    this.#generations.clear();
    this.#nextGeneration = 1;
    this.#incarnations.clear();
    this.#nextIncarnation = 1;
    this.#removals.clear();
    this.#dirtyRemovals.clear();
    for (const botId of Object.keys(this.#workspaces)) {
      this.#generations.set(botId, this.#freshGeneration());
      this.#incarnations.set(botId, this.#freshIncarnation());
    }
    return this;
  }

  has(botId) {
    const id = botIdOf(botId);
    return Object.hasOwn(this.#workspaces, id) && !this.#removals.has(id);
  }

  incarnationFor(botId) {
    return this.#incarnations.get(botIdOf(botId)) ?? null;
  }

  workspaceFor(botId) {
    return this.#workspaces[botIdOf(botId)] ?? this.#defaultWorkspace;
  }

  agentPresetFor(botId) {
    return this.#agentPresets[botIdOf(botId)] ?? null;
  }

  contextEnhancementFor(botId) {
    const id = botIdOf(botId);
    return this.has(id) && Object.hasOwn(this.#contextEnhancement, id)
      ? this.#contextEnhancement[id]
      : DEFAULT_CONTEXT_ENHANCEMENT_CONFIG;
  }

  /** 'turn' (auto cleanup) by default; 'forever' keeps attachments until manual deletion. */
  inboundRetentionFor(botId) {
    const id = botIdOf(botId);
    return this.has(id) && this.#inboundRetention[id] === 'forever'
      ? 'forever'
      : 'turn';
  }

  async setInboundRetention(botId, value, { incarnation } = {}) {
    const id = botIdOf(botId);
    if (!this.has(id)
      || (incarnation !== undefined && incarnation !== this.incarnationFor(id))) {
      const error = new Error('找不到要修改的机器人。');
      error.code = 'workspace-bot-not-found';
      throw error;
    }
    const retention = normalizeInboundRetention(value);
    if (!retention) {
      const error = new TypeError('inboundRetention must be "turn" or "forever"');
      error.code = 'workspace-inbound-retention-invalid';
      throw error;
    }
    return this.#enqueue(id, async () => {
      if (!this.has(id)
        || (incarnation !== undefined && incarnation !== this.incarnationFor(id))) {
        const error = new Error('找不到要修改的机器人。');
        error.code = 'workspace-bot-not-found';
        throw error;
      }
      if (this.inboundRetentionFor(id) === retention) return retention;
      const next = { ...this.#inboundRetention };
      // 'turn' is the default; only meaningful values are stored.
      if (retention === 'forever') next[id] = retention;
      else delete next[id];
      await this.#persist(
        this.#contextEnhancement,
        this.#deliveryTargets,
        this.#version,
        this.#accessPolicies,
        next,
      );
      this.#inboundRetention = next;
      return retention;
    });
  }

  accessPolicyFor(botId) {
    const id = botIdOf(botId);
    return this.has(id) && Object.hasOwn(this.#accessPolicies, id)
      ? this.#accessPolicies[id]
      : null;
  }

  listDeliveryTargets(botId) {
    const id = botIdOf(botId);
    if (!this.has(id)) throw deliveryTargetError('unknown-bot', 'Unknown bot');
    return Object.entries(this.#deliveryTargets[id] ?? {})
      .map(([targetId, target]) => normalizeDeliveryTarget(target, { targetId }))
      .sort((left, right) => left.targetId.localeCompare(right.targetId));
  }

  deliveryTargetFor(botId, targetId) {
    const id = botIdOf(botId);
    const targetKey = targetIdOf(targetId);
    if (!this.has(id)) throw deliveryTargetError('unknown-bot', 'Unknown bot');
    const target = this.#deliveryTargets[id]?.[targetKey];
    return target ? normalizeDeliveryTarget(target, { targetId: targetKey }) : null;
  }

  async createDeliveryTarget(botId, value) {
    const id = botIdOf(botId);
    const target = normalizeDeliveryTarget(value);
    return this.#enqueue(id, async () => {
      if (!this.has(id)) throw deliveryTargetError('unknown-bot', 'Unknown bot');
      if (Object.hasOwn(this.#deliveryTargets[id] ?? {}, target.targetId)) {
        throw deliveryTargetError('target-conflict', 'Target already exists');
      }
      const { targetId, ...stored } = target;
      const next = {
        ...this.#deliveryTargets,
        [id]: { ...(this.#deliveryTargets[id] ?? {}), [targetId]: stored },
      };
      await this.#persist(this.#contextEnhancement, next, 2);
      this.#deliveryTargets = next;
      this.#version = 2;
      return normalizeDeliveryTarget(stored, { targetId });
    });
  }

  async updateDeliveryTarget(botId, targetId, value) {
    const id = botIdOf(botId);
    const targetKey = targetIdOf(targetId);
    const replacement = normalizeDeliveryTarget(value, { targetId: targetKey });
    return this.#enqueue(id, async () => {
      if (!this.has(id)) throw deliveryTargetError('unknown-bot', 'Unknown bot');
      if (!Object.hasOwn(this.#deliveryTargets[id] ?? {}, targetKey)) {
        throw deliveryTargetError('unknown-target', 'Unknown target');
      }
      const { targetId: _targetId, ...stored } = replacement;
      const next = {
        ...this.#deliveryTargets,
        [id]: { ...this.#deliveryTargets[id], [targetKey]: stored },
      };
      await this.#persist(this.#contextEnhancement, next, 2);
      this.#deliveryTargets = next;
      this.#version = 2;
      return normalizeDeliveryTarget(stored, { targetId: targetKey });
    });
  }

  async deleteDeliveryTarget(botId, targetId) {
    const id = botIdOf(botId);
    const targetKey = targetIdOf(targetId);
    return this.#enqueue(id, async () => {
      if (!this.has(id)) throw deliveryTargetError('unknown-bot', 'Unknown bot');
      if (!Object.hasOwn(this.#deliveryTargets[id] ?? {}, targetKey)) {
        throw deliveryTargetError('unknown-target', 'Unknown target');
      }
      const botTargets = { ...this.#deliveryTargets[id] };
      delete botTargets[targetKey];
      const next = { ...this.#deliveryTargets };
      if (Object.keys(botTargets).length > 0) next[id] = botTargets;
      else delete next[id];
      await this.#persist(this.#contextEnhancement, next, 2);
      this.#deliveryTargets = next;
      this.#version = 2;
      return true;
    });
  }

  generationFor(botId) {
    return this.#generations.get(botIdOf(botId)) ?? null;
  }

  async whenIdle() {
    await this.#writeQueue;
  }

  async whenBotIdle(botId) {
    const id = botIdOf(botId);
    while (true) {
      const pending = this.#botQueues.get(id);
      if (!pending) return;
      await pending;
      if (this.#botQueues.get(id) === pending) return;
    }
  }

  async ensure(botId, {
    workspace = this.#defaultWorkspace,
    defaultAgentPreset,
    initialAccessPolicy,
  } = {}) {
    const id = botIdOf(botId);
    const initialWorkspace = resolve(workspace);
    return this.#enqueue(id, async () => {
      const createsBot = !this.#workspaces[id];
      const initializesAccessPolicy = initialAccessPolicy !== undefined
        && !Object.hasOwn(this.#accessPolicies, id);
      if (createsBot || initializesAccessPolicy) {
        const accessPolicy = initializesAccessPolicy
          ? validateAccessPolicy(initialAccessPolicy)
          : undefined;
        const agentPreset = createsBot ? validateAgentPresetId(defaultAgentPreset) : null;
        const hadAgentPreset = Object.hasOwn(this.#agentPresets, id);
        const previousAgentPreset = this.#agentPresets[id];
        const nextAccessPolicies = initializesAccessPolicy
          ? { ...this.#accessPolicies, [id]: accessPolicy }
          : this.#accessPolicies;
        if (createsBot) {
          this.#workspaces[id] = initialWorkspace;
          if (agentPreset) this.#agentPresets[id] = agentPreset;
          this.#generations.set(id, this.#freshGeneration());
          this.#incarnations.set(id, this.#freshIncarnation());
        }
        const nextVersion = initializesAccessPolicy ? 2 : this.#version;
        try {
          await this.#persist(
            this.#contextEnhancement,
            this.#deliveryTargets,
            nextVersion,
            nextAccessPolicies,
          );
        } catch (error) {
          if (createsBot) {
            delete this.#workspaces[id];
            if (hadAgentPreset) this.#agentPresets[id] = previousAgentPreset;
            else delete this.#agentPresets[id];
            this.#generations.delete(id);
            this.#incarnations.delete(id);
          }
          throw error;
        }
        this.#accessPolicies = nextAccessPolicies;
        this.#version = nextVersion;
      } else if (!this.#generations.has(id)) {
        this.#generations.set(id, this.#freshGeneration());
      }
      return this.#workspaces[id];
    });
  }

  async setWorkspace(botId, value, { clearSessions, incarnation } = {}) {
    const id = botIdOf(botId);
    if (!this.has(id)
      || (incarnation !== undefined && incarnation !== this.incarnationFor(id))) {
      const error = new Error('找不到要修改的机器人。');
      error.code = 'workspace-bot-not-found';
      throw error;
    }
    const workspace = await validateWorkspacePath(value);
    return this.#enqueue(id, async () => {
      if (!this.has(id)
        || (incarnation !== undefined && incarnation !== this.incarnationFor(id))) {
        const error = new Error('找不到要修改的机器人。');
        error.code = 'workspace-bot-not-found';
        throw error;
      }
      if (workspace === this.workspaceFor(id)) return workspace;
      const previous = this.#workspaces[id];
      // Advance first so a session creation that started before this queued
      // transition can never be written back after the clear.
      this.#generations.set(id, this.#freshGeneration());
      // Clear the old session mapping before publishing the new workspace.
      // A crash can then lose conversation continuity, but can never pair the
      // new workspace with sessions created in the old one.
      await clearSessions?.();
      this.#workspaces[id] = workspace;
      try {
        await this.#persist();
      } catch (error) {
        this.#workspaces[id] = previous;
        throw error;
      }
      return workspace;
    });
  }

  async setAgentPreset(botId, value, { incarnation } = {}) {
    const id = botIdOf(botId);
    if (!this.has(id)
      || (incarnation !== undefined && incarnation !== this.incarnationFor(id))) {
      const error = new Error('找不到要修改的机器人。');
      error.code = 'workspace-bot-not-found';
      throw error;
    }
    const agentPreset = validateAgentPresetId(value);
    return this.#enqueue(id, async () => {
      if (!this.has(id)
        || (incarnation !== undefined && incarnation !== this.incarnationFor(id))) {
        const error = new Error('找不到要修改的机器人。');
        error.code = 'workspace-bot-not-found';
        throw error;
      }
      const previous = this.#agentPresets[id] ?? null;
      if (previous === agentPreset) return agentPreset;
      if (agentPreset) this.#agentPresets[id] = agentPreset;
      else delete this.#agentPresets[id];
      try {
        await this.#persist();
      } catch (error) {
        if (previous) this.#agentPresets[id] = previous;
        else delete this.#agentPresets[id];
        throw error;
      }
      return agentPreset;
    });
  }

  async setContextEnhancement(botId, value, { incarnation } = {}) {
    const id = botIdOf(botId);
    const expectedIncarnation = incarnation === undefined ? this.incarnationFor(id) : incarnation;
    const config = validateContextEnhancementConfig(value);
    return this.#enqueue(id, async () => {
      if (!this.has(id) || expectedIncarnation !== this.incarnationFor(id)) {
        const error = new Error('找不到要修改的机器人。');
        error.code = 'workspace-bot-not-found';
        throw error;
      }
      const next = { ...this.#contextEnhancement, [id]: config };
      // Messages keep the previous committed snapshot until rename succeeds.
      await this.#persist(next);
      this.#contextEnhancement = next;
      return config;
    });
  }

  async setAccessPolicy(botId, value, { incarnation } = {}) {
    const id = botIdOf(botId);
    const expectedIncarnation = incarnation === undefined ? this.incarnationFor(id) : incarnation;
    const policy = validateAccessPolicy(value);
    return this.#enqueue(id, async () => {
      if (!this.has(id) || expectedIncarnation !== this.incarnationFor(id)) {
        const error = new Error('找不到要修改的机器人。');
        error.code = 'workspace-bot-not-found';
        throw error;
      }
      const next = { ...this.#accessPolicies, [id]: policy };
      // Inbound messages keep the previous committed snapshot until rename succeeds.
      await this.#persist(
        this.#contextEnhancement,
        this.#deliveryTargets,
        2,
        next,
      );
      this.#accessPolicies = next;
      this.#version = 2;
      return policy;
    });
  }

  async bindWorkspaceSession(botId, value, {
    conversationKey,
    sessionId,
    clearSessions,
    setSession,
    incarnation,
    expectedGeneration,
  } = {}) {
    const id = botIdOf(botId);
    if (typeof conversationKey !== 'string' || !conversationKey
      || typeof sessionId !== 'string' || !sessionId) {
      throw new TypeError('conversationKey and sessionId are required');
    }
    if (typeof clearSessions !== 'function' || typeof setSession !== 'function') {
      throw new TypeError('session state callbacks are required');
    }
    if (!this.has(id)
      || (incarnation !== undefined && incarnation !== this.incarnationFor(id))) {
      const error = new Error('找不到要修改的机器人。');
      error.code = 'workspace-bot-not-found';
      throw error;
    }
    const workspace = await canonicalWorkspacePath(await validateWorkspacePath(value));
    return this.#enqueue(id, async () => {
      if (!this.has(id)
        || (incarnation !== undefined && incarnation !== this.incarnationFor(id))) {
        const error = new Error('找不到要修改的机器人。');
        error.code = 'workspace-bot-not-found';
        throw error;
      }
      if (expectedGeneration !== undefined
        && expectedGeneration !== this.generationFor(id)) {
        throw workspaceSessionStale(
          'The bot workspace changed before the session binding could be committed.',
        );
      }

      if (!(await sameWorkspacePath(workspace, this.workspaceFor(id)))) {
        const previous = this.#workspaces[id];
        // Fence every session resolved before this transition, then remove
        // the old workspace mappings before publishing the new workspace.
        this.#generations.set(id, this.#freshGeneration());
        await clearSessions();
        this.#workspaces[id] = workspace;
        try {
          await this.#persist();
        } catch (error) {
          // Session mappings stay cleared and the advanced generation stays
          // fenced. Restoring either could pair an old session with a state
          // transition whose durable outcome is unknown.
          this.#workspaces[id] = previous;
          throw error;
        }
      }

      // This write remains inside the same bot transition as the workspace
      // mutation, so another switch or bind cannot interleave between them.
      await setSession(conversationKey, sessionId);
      return {
        workspace,
        sessionId,
        generation: this.#generations.get(id),
      };
    });
  }

  async invalidateSessions(botId, { clearSessions } = {}) {
    const id = botIdOf(botId);
    return this.#enqueue(id, async () => {
      this.#generations.set(id, this.#freshGeneration());
      await clearSessions?.();
    });
  }

  /** Fence one lifecycle and return the opaque token required to abort/finish it. */
  async beginRemoval(botId, { clearSessions } = {}) {
    const id = botIdOf(botId);
    return this.#enqueue(id, async () => {
      const existing = this.#removals.get(id);
      if (existing) return existing;
      const transaction = Object.freeze({});
      this.#removals.set(id, transaction);
      this.#removalDetails.set(transaction, {
        botId: id,
        incarnation: this.incarnationFor(id),
      });
      this.#generations.set(id, this.#freshGeneration());
      try {
        await clearSessions?.();
      } catch (error) {
        if (this.#removals.get(id) === transaction) this.#removals.delete(id);
        throw error;
      }
      return transaction;
    });
  }

  /** Re-open only the lifecycle represented by transaction; stale tokens are no-ops. */
  async abortRemoval(transaction) {
    const { botId: id } = this.#removalDetailsFor(transaction);
    return this.#enqueue(id, async () => {
      if (this.#removals.get(id) !== transaction) return false;
      this.#removals.delete(id);
      if (Object.hasOwn(this.#workspaces, id)) {
        this.#generations.set(id, this.#freshGeneration());
        if (!this.#incarnations.has(id)) {
          this.#incarnations.set(id, this.#freshIncarnation());
        }
      }
      return true;
    });
  }

  /** Retire only the lifecycle represented by transaction; stale tokens are no-ops. */
  async finishRemoval(transaction) {
    const { botId: id, incarnation } = this.#removalDetailsFor(transaction);
    return this.#enqueue(id, async () => {
      if (this.#removals.get(id) !== transaction) {
        return { removed: false, persisted: true, error: null, stale: true };
      }
      if (this.incarnationFor(id) !== incarnation) {
        this.#removals.delete(id);
        return { removed: false, persisted: true, error: null, stale: true };
      }
      this.#removals.delete(id);
      return this.#retireCurrentIncarnation(id);
    });
  }

  /** Commit the workspace lifecycle after the config store durably removed a bot. */
  async retireAfterConfigCommit(botId) {
    const id = botIdOf(botId);
    return this.#enqueue(id, async () => {
      this.#removals.delete(id);
      return this.#retireCurrentIncarnation(id);
    });
  }

  /** A failed retirement must reach disk before the same config ID can be rebound. */
  flushPendingRemoval(botId) {
    if (!this.#dirtyRemovals.has(botId)) return undefined;
    return this.#enqueue(botId, async () => {
      if (this.#dirtyRemovals.has(botId)) await this.#persistCurrentDocument();
    });
  }

  async remove(botId) {
    const result = await this.retireAfterConfigCommit(botId);
    if (result.error) throw result.error;
    return result.removed;
  }

  async reconcile(activeBotIds) {
    const active = new Set([...activeBotIds].map(botIdOf));
    const candidates = new Set([
      ...Object.keys(this.#workspaces),
      ...Object.keys(this.#agentPresets),
      ...Object.keys(this.#contextEnhancement),
      ...Object.keys(this.#deliveryTargets),
      ...Object.keys(this.#accessPolicies),
      ...Object.keys(this.#inboundRetention),
      ...this.#dirtyRemovals,
    ]);
    for (const botId of candidates) {
      if (!active.has(botId)) await this.remove(botId);
    }
  }

  decorateStatus(status) {
    if (!status || typeof status !== 'object' || !Array.isArray(status.bots)) return status;
    return {
      ...status,
      bots: status.bots.map((bot) => bot?.botId
        ? {
          ...bot,
          workspace: this.workspaceFor(bot.botId),
          agentPreset: this.agentPresetFor(bot.botId),
          contextEnhancement: this.contextEnhancementFor(bot.botId),
          accessPolicy: this.accessPolicyFor(bot.botId),
          inboundRetention: this.inboundRetentionFor(bot.botId),
        }
        : bot),
    };
  }

  #freshGeneration() {
    const generation = this.#nextGeneration;
    this.#nextGeneration += 1;
    return generation;
  }

  #freshIncarnation() {
    const incarnation = this.#nextIncarnation;
    this.#nextIncarnation += 1;
    return incarnation;
  }

  #removalDetailsFor(transaction) {
    if (!transaction || typeof transaction !== 'object') {
      throw new TypeError('Invalid workspace removal transaction');
    }
    const details = this.#removalDetails.get(transaction);
    if (!details) throw new TypeError('Invalid workspace removal transaction');
    return details;
  }

  async #retireCurrentIncarnation(id) {
    const hadWorkspace = Object.hasOwn(this.#workspaces, id);
    const hadPreset = Object.hasOwn(this.#agentPresets, id);
    const hadContextEnhancement = Object.hasOwn(this.#contextEnhancement, id);
    const hadDeliveryTargets = Object.hasOwn(this.#deliveryTargets, id);
    const hadAccessPolicy = Object.hasOwn(this.#accessPolicies, id);
    const hadInboundRetention = Object.hasOwn(this.#inboundRetention, id);
    const needsCleanup = hadWorkspace || hadPreset || hadContextEnhancement
      || hadDeliveryTargets || hadAccessPolicy || hadInboundRetention
      || this.#dirtyRemovals.has(id);
    delete this.#workspaces[id];
    delete this.#agentPresets[id];
    delete this.#contextEnhancement[id];
    delete this.#deliveryTargets[id];
    delete this.#accessPolicies[id];
    delete this.#inboundRetention[id];
    this.#generations.delete(id);
    this.#incarnations.delete(id);
    if (!needsCleanup) return {
      removed: false, persisted: true, error: null, stale: false,
    };
    try {
      await this.#persistCurrentDocument();
      return {
        removed: hadWorkspace, persisted: true, error: null, stale: false,
      };
    } catch (error) {
      this.#dirtyRemovals.add(id);
      return {
        removed: hadWorkspace, persisted: false, error, stale: false,
      };
    }
  }

  async #enqueue(botId, operation) {
    const queued = this.#writeQueue.then(operation, operation);
    const settled = queued.then(() => undefined, () => undefined);
    this.#writeQueue = settled;
    this.#botQueues.set(botId, settled);
    void settled.finally(() => {
      if (this.#botQueues.get(botId) === settled) this.#botQueues.delete(botId);
    });
    return queued;
  }

  async #persist(
    contextEnhancement = this.#contextEnhancement,
    deliveryTargets = this.#deliveryTargets,
    version = this.#version,
    accessPolicies = this.#accessPolicies,
    inboundRetention = this.#inboundRetention,
  ) {
    await writeStoredDocument(this.#path, storedDocument({
      version,
      workspaces: this.#workspaces,
      agentPresets: this.#agentPresets,
      contextEnhancement,
      deliveryTargets,
      accessPolicies,
      inboundRetention,
    }));
    this.#dirtyRemovals.clear();
  }

  async #persistCurrentDocument() {
    if (Object.keys(this.#workspaces).length > 0
      || Object.keys(this.#agentPresets).length > 0
      || Object.keys(this.#contextEnhancement).length > 0
      || Object.keys(this.#deliveryTargets).length > 0
      || Object.keys(this.#accessPolicies).length > 0
      || Object.keys(this.#inboundRetention).length > 0) {
      await this.#persist();
      return;
    }
    try {
      await unlink(this.#path);
      this.#dirtyRemovals.clear();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.#dirtyRemovals.clear();
    }
  }
}

function resolveAgentPresetCatalog(catalog) {
  if (!catalog) return null;
  const value = typeof catalog === 'function' ? catalog() : catalog;
  return value && typeof value.then === 'function'
    ? value.then(normalizeAgentPresetCatalog)
    : normalizeAgentPresetCatalog(value);
}

function unavailableAgentPreset() {
  const error = new Error('Agent Preset 不存在或不可用。');
  error.code = 'agent-preset-unavailable';
  return error;
}

function assertCurrentBotScope(isCurrentScope) {
  if (isCurrentScope()) return;
  const error = new Error('找不到要修改的机器人。');
  error.code = 'workspace-bot-not-found';
  throw error;
}

function decorateResult(workspaces, result, catalog) {
  const decorate = (value) => {
    const decorated = workspaces.decorateStatus(value);
    if (!catalog || !decorated || typeof decorated !== 'object') return decorated;
    const attachCatalog = (agentPresetCatalog) => (
      agentPresetCatalog ? { ...decorated, agentPresetCatalog } : decorated
    );
    const agentPresetCatalog = resolveAgentPresetCatalog(catalog);
    return agentPresetCatalog && typeof agentPresetCatalog.then === 'function'
      ? agentPresetCatalog.then(attachCatalog)
      : attachCatalog(agentPresetCatalog);
  };
  return result && typeof result.then === 'function'
    ? result.then(decorate)
    : decorate(result);
}

function targetStatus(controller) {
  return Promise.resolve(controller.status());
}

/** Observe durable removals and finish failed cleanup before a same-ID config save. */
export function observeBotWorkspaceRemovals(
  configStore,
  {
    workspaces,
    method = 'remove',
    botIdFromRemoved = (removed) => removed?.botId,
    saveMethod = 'save',
    botIdFromSave = (config) => config?.botId,
  },
) {
  if (!configStore || !workspaces || typeof configStore[method] !== 'function') {
    throw new TypeError('configStore removal observer dependencies are required');
  }
  return new Proxy(configStore, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === method) {
        return async (...args) => {
          const removed = await value.apply(target, args);
          const botId = removed ? botIdFromRemoved(removed, args) : null;
          if (botId) await workspaces.retireAfterConfigCommit(botId);
          return removed;
        };
      }
      if (property === saveMethod && typeof value === 'function') {
        return (...args) => {
          const cleanup = workspaces.flushPendingRemoval(botIdFromSave(args[0], args));
          return cleanup ? cleanup.then(() => value.apply(target, args)) : value.apply(target, args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function createBotWorkspaceScope(
  harness,
  { botId, workspaces, state, agentPresetCatalog } = {},
) {
  if (!harness || !workspaces || !state) throw new TypeError('harness, workspaces, and state are required');
  const incarnation = workspaces.incarnationFor(botId);
  const isCurrentScope = () => workspaces.has(botId)
    && workspaces.incarnationFor(botId) === incarnation;
  const presetSettings = async (catalog = agentPresetCatalog) => {
    let normalizedCatalog;
    try {
      normalizedCatalog = await resolveAgentPresetCatalog(catalog)
        ?? normalizeAgentPresetCatalog(null);
    } catch (error) {
      assertCurrentBotScope(isCurrentScope);
      throw error;
    }
    assertCurrentBotScope(isCurrentScope);
    return {
      agentPreset: workspaces.agentPresetFor(botId),
      agentPresetCatalog: normalizedCatalog,
    };
  };
  const sessionGenerations = new Map();
  // Attach the bot's configured attachment retention to every prompt so the
  // file ingress executor stages uploads with the right lifecycle.
  const injectInboundRetention = (args) => {
    const [prompt, options, ...rest] = args;
    const normalizedOptions = typeof options === 'number'
      ? { timeoutMs: options }
      : (options && typeof options === 'object' ? { ...options } : {});
    normalizedOptions.inboundFileRetention = workspaces.inboundRetentionFor(botId);
    return [prompt, normalizedOptions, ...rest];
  };
  const scopedHarness = new Proxy(harness, {
    get(target, property) {
      if (property === 'agentPresetSettings') {
        return async (options = {}) => {
          options?.signal?.throwIfAborted();
          assertCurrentBotScope(isCurrentScope);
          const settings = await presetSettings();
          options?.signal?.throwIfAborted();
          return settings;
        };
      }
      if (property === 'updateAgentPreset') {
        return async (value, options = {}) => {
          options?.signal?.throwIfAborted();
          assertCurrentBotScope(isCurrentScope);
          const agentPreset = value === '--default' ? null : validateAgentPresetId(value);
          let catalog = null;
          if (agentPreset) {
            ({ agentPresetCatalog: catalog } = await presetSettings());
            options?.signal?.throwIfAborted();
            if (!catalog.items.some((item) => item.id === agentPreset)) {
              throw unavailableAgentPreset();
            }
          }
          await workspaces.setAgentPreset(botId, agentPreset, { incarnation });
          assertCurrentBotScope(isCurrentScope);
          if (catalog) {
            return {
              agentPreset: workspaces.agentPresetFor(botId),
              agentPresetCatalog: catalog,
            };
          }
          try {
            return await presetSettings();
          } catch (error) {
            if (error?.code === 'workspace-bot-not-found') throw error;
            assertCurrentBotScope(isCurrentScope);
            return {
              agentPreset: workspaces.agentPresetFor(botId),
              agentPresetCatalog: normalizeAgentPresetCatalog(null),
            };
          }
        };
      }
      if (property === 'currentWorkspace') {
        return () => {
          if (!isCurrentScope()) {
            const error = new Error('找不到要修改的机器人。');
            error.code = 'workspace-bot-not-found';
            throw error;
          }
          return workspaces.workspaceFor(botId);
        };
      }
      if (property === 'assertWorkspaceScope') {
        return () => {
          if (!isCurrentScope()) {
            const error = new Error('找不到要修改的机器人。');
            error.code = 'workspace-bot-not-found';
            throw error;
          }
        };
      }
      if ((property === 'listWorkspaces'
        || property === 'listWorkspaceSessions'
        || property === 'listModels')
        && typeof target[property] === 'function') {
        return async (...args) => {
          if (!isCurrentScope()) {
            const error = new Error('找不到要修改的机器人。');
            error.code = 'workspace-bot-not-found';
            throw error;
          }
          const result = await target[property](...args);
          if (!isCurrentScope()) {
            const error = new Error('找不到要修改的机器人。');
            error.code = 'workspace-bot-not-found';
            throw error;
          }
          return result;
        };
      }
      if (property === 'switchWorkspace') {
        return (workspace) => {
          if (!isCurrentScope()) {
            const error = new Error('找不到要修改的机器人。');
            error.code = 'workspace-bot-not-found';
            return Promise.reject(error);
          }
          return workspaces.setWorkspace(botId, workspace, {
            clearSessions: () => state.clearSessions(),
            incarnation,
          });
        };
      }
      if (property === 'bindWorkspaceSession') {
        return async (conversationKey, sessionId) => {
          if (typeof conversationKey !== 'string' || !conversationKey
            || typeof sessionId !== 'string' || !sessionId) {
            throw new TypeError('conversationKey and sessionId are required');
          }
          if (!isCurrentScope()) {
            const error = new Error('找不到要修改的机器人。');
            error.code = 'workspace-bot-not-found';
            throw error;
          }
          if (typeof target.adoptWorkspaceSession !== 'function') {
            throw new TypeError('Harness does not support adopting workspace sessions');
          }
          const expectedGeneration = workspaces.generationFor(botId);
          const adopted = await target.adoptWorkspaceSession(sessionId);
          if (!isCurrentScope()) {
            const error = new Error('找不到要修改的机器人。');
            error.code = 'workspace-bot-not-found';
            throw error;
          }
          if (expectedGeneration !== workspaces.generationFor(botId)) {
            throw workspaceSessionStale(
              'The bot workspace changed while the session was being adopted.',
            );
          }
          if (!adopted || typeof adopted !== 'object'
            || adopted.sessionId !== sessionId || typeof adopted.workspace !== 'string') {
            throw new TypeError('Harness returned an invalid adopted workspace session');
          }
          const bound = await workspaces.bindWorkspaceSession(botId, adopted.workspace, {
            conversationKey,
            sessionId,
            clearSessions: () => state.clearSessions(),
            setSession: (key, selectedSessionId) => state.setSession(key, selectedSessionId),
            incarnation,
            expectedGeneration,
          });
          if (!isCurrentScope()) {
            const error = new Error('找不到要修改的机器人。');
            error.code = 'workspace-bot-not-found';
            throw error;
          }
          if (bound.generation !== workspaces.generationFor(botId)) {
            throw workspaceSessionStale(
              'The bot workspace changed before the session binding completed.',
            );
          }
          sessionGenerations.set(sessionId, bound.generation);
          return {
            ...adopted,
            workspace: bound.workspace,
            sessionId: bound.sessionId,
          };
        };
      }
      if (property === 'createSession') {
        return async (options = {}) => {
          await workspaces.whenBotIdle(botId);
          if (!isCurrentScope()) {
            const error = new Error('找不到要修改的机器人。');
            error.code = 'workspace-bot-not-found';
            throw error;
          }
          const generation = workspaces.generationFor(botId);
          const agentPreset = workspaces.agentPresetFor(botId);
          const sessionId = await target.createSession({
            ...options,
            workspace: workspaces.workspaceFor(botId),
            ...(agentPreset == null ? {} : { agentPreset }),
          });
          sessionGenerations.set(sessionId, generation);
          return sessionId;
        };
      }
      if (property === 'workspaceSession') {
        return (sessionId) => {
          if (typeof sessionId !== 'string' || !sessionId) {
            throw new TypeError('sessionId is required');
          }
          const generation = sessionGenerations.get(sessionId)
            ?? workspaces.generationFor(botId);
          // Transfer the mutable provenance entry into this immutable handle.
          // A later handle for the same id captures its own generation instead
          // of sharing deletion or rebinding state with this call.
          sessionGenerations.delete(sessionId);
          const isCurrentSession = () => isCurrentScope()
            && generation === workspaces.generationFor(botId);
          const invokeCurrentSession = async (method, args, action) => {
            if (!isCurrentSession()) {
              throw workspaceSessionStale(
                `The bot workspace changed before this ${action} started.`,
              );
            }
            const result = await target[method](sessionId, ...args);
            if (!isCurrentSession()) {
              throw workspaceSessionStale(
                `The bot workspace changed while this ${action} was running.`,
              );
            }
            return result;
          };
          const invokeStartedSessionMutation = async (method, args, action) => {
            if (!isCurrentSession()) {
              throw workspaceSessionStale(
                `The bot workspace changed before this ${action} started.`,
              );
            }
            // Once an irreversible control mutation has started, preserve its
            // actual outcome even if a workspace switch commits concurrently.
            return target[method](sessionId, ...args);
          };
          return Object.freeze({
            sessionId,
            async sessionExists(...args) {
              if (!isCurrentSession()) return false;
              const exists = await target.sessionExists(sessionId, ...args);
              return isCurrentSession() && exists;
            },
            models(...args) {
              return invokeCurrentSession('getSessionModels', args, 'model listing');
            },
            readHistory(...args) {
              return invokeCurrentSession('readSessionHistory', args, 'history read');
            },
            ...(typeof target.renameSession === 'function' ? {
              renameTitle(...args) {
                return invokeStartedSessionMutation('renameSession', args, 'title rename');
              },
            } : {}),
            selectModel(...args) {
              return invokeCurrentSession('selectSessionModel', args, 'model selection');
            },
            isRunning(...args) {
              return invokeCurrentSession('isSessionRunning', args, 'run-state check');
            },
            hasActiveTurn(...args) {
              return invokeCurrentSession('hasActiveTurn', args, 'turn ownership check');
            },
            stopActiveTurn(...args) {
              return invokeStartedSessionMutation('stopActiveTurn', args, 'turn stop');
            },
            steerActiveTurn(...args) {
              return invokeStartedSessionMutation('steerActiveTurn', args, 'turn steering');
            },
            ask(...args) {
              if (!isCurrentSession()) {
                throw workspaceSessionStale(
                  'The bot workspace changed before this prompt started.',
                );
              }
              return target.ask(sessionId, ...injectInboundRetention(args));
            },
          });
        };
      }
      if (property === 'sessionExists') {
        return (sessionId, ...args) => {
          if (!isCurrentScope()) return false;
          const generation = sessionGenerations.get(sessionId);
          if (generation !== undefined && generation !== workspaces.generationFor(botId)) {
            sessionGenerations.delete(sessionId);
            return false;
          }
          return target.sessionExists(sessionId, ...args);
        };
      }
      if (property === 'ask') {
        return (sessionId, ...args) => {
          const generation = sessionGenerations.get(sessionId);
          sessionGenerations.delete(sessionId);
          if (!isCurrentScope()
            || (generation !== undefined && generation !== workspaces.generationFor(botId))) {
            const error = new Error('The bot workspace changed before this prompt started.');
            error.code = WORKSPACE_SESSION_STALE;
            throw error;
          }
          return target.ask(sessionId, ...injectInboundRetention(args));
        };
      }
      if (property === 'executeCommand' && typeof target.executeCommand === 'function') {
        return (sessionId, ...args) => {
          const generation = sessionGenerations.get(sessionId);
          sessionGenerations.delete(sessionId);
          if (!isCurrentScope()
            || (generation !== undefined && generation !== workspaces.generationFor(botId))) {
            const error = new Error('The bot workspace changed before this command started.');
            error.code = WORKSPACE_SESSION_STALE;
            throw error;
          }
          return target.executeCommand(sessionId, ...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const scopedState = new Proxy(state, {
    get(target, property) {
      if (property === CONNECTION_TEST_STATE_IDENTITY) return target;
      if (property === 'sessionFor') {
        return (key, ...args) => {
          if (!isCurrentScope()) return null;
          const sessionId = target.sessionFor(key, ...args);
          if (sessionId && !sessionGenerations.has(sessionId)) {
            sessionGenerations.set(sessionId, workspaces.generationFor(botId));
          }
          return sessionId;
        };
      }
      if (property === 'setSession') {
        return (key, sessionId, ...args) => {
          const generation = sessionGenerations.get(sessionId);
          if (!isCurrentScope()
            || (generation !== undefined && generation !== workspaces.generationFor(botId))) {
            sessionGenerations.delete(sessionId);
            return false;
          }
          return target.setSession(key, sessionId, ...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return Object.freeze({ harness: scopedHarness, state: scopedState });
}

export function createBotScopedHarness(harness, options) {
  return createBotWorkspaceScope(harness, options).harness;
}

export function createWorkspaceAwareController(controller, { workspaces, stateFor, agentPresetCatalog } = {}) {
  if (!controller || !workspaces || typeof stateFor !== 'function') {
    throw new TypeError('controller, workspaces, and stateFor are required');
  }
  const transitions = new Map();
  const withBotTransition = (botId, operation) => {
    const previous = transitions.get(botId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    transitions.set(botId, current);
    return current.finally(() => {
      if (transitions.get(botId) === current) transitions.delete(botId);
    });
  };
  const decorate = (value) => decorateResult(workspaces, value, agentPresetCatalog);
  const updateWorkspace = (botId, workspace) => {
    // Capture at API invocation, before even waiting for an older outer
    // transition. A queued request still belongs to the incarnation that the
    // caller observed, not a deterministic same-id rebind that appears later.
    const incarnation = workspaces.incarnationFor(botId);
    return withBotTransition(botId, async () => {
      const snapshot = await controller.status();
      if (!snapshot?.bots?.some((bot) => bot?.botId === botId)) {
        const error = new Error('找不到要修改的机器人。');
        error.code = 'workspace-bot-not-found';
        throw error;
      }
      const state = await stateFor(botId);
      await workspaces.setWorkspace(botId, workspace, {
        clearSessions: () => state.clearSessions(),
        incarnation,
      });
      return decorate(await controller.status());
    });
  };
  const updateAgentPreset = (botId, agentPreset) => {
    const incarnation = workspaces.incarnationFor(botId);
    const normalizedAgentPreset = validateAgentPresetId(agentPreset);
    return withBotTransition(botId, async () => {
      const snapshot = await controller.status();
      if (!snapshot?.bots?.some((bot) => bot?.botId === botId)) {
        const error = new Error('找不到要修改的机器人。');
        error.code = 'workspace-bot-not-found';
        throw error;
      }
      const catalog = normalizedAgentPreset && agentPresetCatalog
        ? await resolveAgentPresetCatalog(agentPresetCatalog)
        : null;
      if (normalizedAgentPreset && agentPresetCatalog
        && !catalog?.items.some((item) => item.id === normalizedAgentPreset)) {
        throw unavailableAgentPreset();
      }
      await workspaces.setAgentPreset(botId, normalizedAgentPreset, { incarnation });
      return decorateResult(
        workspaces,
        await controller.status(),
        catalog ?? agentPresetCatalog,
      );
    });
  };
  const updateInboundRetention = (botId, value, projectStatus) => {
    const incarnation = workspaces.incarnationFor(botId);
    const retention = normalizeInboundRetention(value);
    if (!retention) {
      const error = new TypeError('inboundRetention must be "turn" or "forever"');
      error.code = 'workspace-inbound-retention-invalid';
      throw error;
    }
    return withBotTransition(botId, async () => {
      const snapshot = await controller.status();
      if (!snapshot?.bots?.some((bot) => bot?.botId === botId)) {
        const error = new Error('找不到要修改的机器人。');
        error.code = 'workspace-bot-not-found';
        throw error;
      }
      await workspaces.setInboundRetention(botId, retention, { incarnation });
      const decorated = workspaces.decorateStatus(await controller.status());
      return projectStatus ? await projectStatus(decorated) : decorated;
    });
  };
  const clearInboundAttachments = async (botId) => {
    const snapshot = await controller.status();
    if (!snapshot?.bots?.some((bot) => bot?.botId === botId)) {
      const error = new Error('找不到要修改的机器人。');
      error.code = 'workspace-bot-not-found';
      throw error;
    }
    const workspace = workspaces.workspaceFor(botId);
    await deleteInboundAttachments(workspace, 'all');
    // Channel settings pages parse the RPC result as a full status snapshot
    // (normalizeSnapshot/normalizeBotsSnapshot require a bots array), so the
    // clear response must be decorated exactly like updateInboundRetention.
    return workspaces.decorateStatus(await controller.status());
  };
  const updateContextEnhancement = (botId, value, projectStatus) => {
    const incarnation = workspaces.incarnationFor(botId);
    const config = validateContextEnhancementConfig(value);
    return withBotTransition(botId, async () => {
      const snapshot = await controller.status();
      if (!snapshot?.bots?.some((bot) => bot?.botId === botId)) {
        const error = new Error('找不到要修改的机器人。');
        error.code = 'workspace-bot-not-found';
        throw error;
      }
      const catalog = await resolveAgentPresetCatalog(agentPresetCatalog);
      const decorated = workspaces.decorateStatus(snapshot);
      const updated = {
        ...decorated,
        bots: decorated.bots.map((bot) => bot?.botId === botId
          ? { ...bot, contextEnhancement: config } : bot),
        ...(catalog ? { agentPresetCatalog: catalog } : {}),
      };
      // QR/status projection can fail too. Prepare the complete response before
      // commit so a failed save never publishes new running settings.
      const result = projectStatus ? await projectStatus(updated) : updated;
      await workspaces.setContextEnhancement(botId, config, { incarnation });
      return result;
    });
  };
  const updateAccessPolicy = (botId, value, projectStatus) => {
    const incarnation = workspaces.incarnationFor(botId);
    const policy = validateAccessPolicy(value);
    return withBotTransition(botId, async () => {
      const snapshot = await controller.status();
      if (!snapshot?.bots?.some((bot) => bot?.botId === botId)) {
        const error = new Error('找不到要修改的机器人。');
        error.code = 'workspace-bot-not-found';
        throw error;
      }
      const catalog = await resolveAgentPresetCatalog(agentPresetCatalog);
      const decorated = workspaces.decorateStatus(snapshot);
      const updated = {
        ...decorated,
        bots: decorated.bots.map((bot) => bot?.botId === botId
          ? { ...bot, accessPolicy: policy } : bot),
        ...(catalog ? { agentPresetCatalog: catalog } : {}),
      };
      // Prepare the complete channel-specific response before commit. Failed
      // projections and disk writes must leave the live policy unchanged.
      const result = projectStatus ? await projectStatus(updated) : updated;
      await workspaces.setAccessPolicy(botId, policy, { incarnation });
      return result;
    });
  };
  const deleteWithWorkspace = (botId, invokeDelete) => withBotTransition(botId, async () => {
    // Fence the old runtime without changing the durable mapping. A crash
    // before the controller removes its config therefore keeps the bot's
    // workspace, while a crash after that commit is healed by startup
    // reconciliation.
    const removal = await workspaces.beginRemoval(botId, {
      clearSessions: async () => {
        try {
          const state = await stateFor(botId);
          if (!state || typeof state.clearSessions !== 'function') {
            throw new TypeError('bot state does not support session cleanup');
          }
          await state.clearSessions();
        } catch (error) {
          console.warn(
            `[dsh-im] ignored session cleanup failure while deleting bot ${botId}:`,
            error?.message ?? error,
          );
        }
      },
    });
    try {
      const result = await invokeDelete();
      await workspaces.finishRemoval(removal);
      return decorate(result);
    } catch (error) {
      const after = await targetStatus(controller).catch(() => null);
      const knownAbsent = Array.isArray(after?.bots)
        && !after.bots.some((bot) => bot?.botId === botId);
      if (knownAbsent) await workspaces.finishRemoval(removal);
      else await workspaces.abortRemoval(removal);
      throw error;
    }
  });

  return new Proxy(controller, {
    get(target, property) {
      if (property === 'updateWorkspace') return updateWorkspace;
      if (property === 'updateAgentPreset') return updateAgentPreset;
      if (property === 'updateContextEnhancement') return updateContextEnhancement;
      if (property === 'updateInboundRetention') return updateInboundRetention;
      if (property === 'clearInboundAttachments') return clearInboundAttachments;
      if (property === 'updateAccessPolicy') return updateAccessPolicy;
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property === 'deleteBot') {
        return (botId, ...args) => deleteWithWorkspace(
          botId,
          () => value.call(target, botId, ...args),
        );
      }
      if (property === 'disconnect') {
        return async (...args) => {
          const before = await target.status();
          const botId = before?.bots?.[0]?.botId;
          if (!botId) return decorate(value.apply(target, args));
          return deleteWithWorkspace(botId, () => value.apply(target, args));
        };
      }
      return (...args) => decorate(value.apply(target, args));
    },
  });
}
