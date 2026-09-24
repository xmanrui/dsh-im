import { t } from './i18n.mjs';
import { atConnectionStage, connectionStageError, extractConnectionEvidence } from './connection-error.mjs';
import { validateBotAlias, withBotAlias } from './bot-alias.mjs';
import { defaultImWorkspace, ensureImWorkspaceDirectory, sameWorkspacePath } from './default-workspace.mjs';
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
  DEFAULT_CONTEXT_ENHANCEMENT_CONFIG,
  normalizeContextEnhancementConfig,
  validateContextEnhancementConfig,
} from './context-enhancement.mjs';
import {
  confirmsModelSelection,
  modelCatalogEntry,
  normalizeModelCatalog,
  sameModelSelection,
  validateModelSelection,
} from './model-setting.mjs';
import { WORKSPACE_SESSION_STALE } from './workspace-session.mjs';
import { configValidationError, withConfigResource } from './config-read-error.mjs';

const DELIVERY_DOCUMENT_VERSION = 2;
export const CURRENT_DOCUMENT_VERSION = 3;
const EMPTY_DOCUMENT = Object.freeze({ version: 1, workspaces: Object.freeze({}) });

function invalidWorkspaceConfig(field, issue) {
  throw configValidationError('dsh-im workspace config is invalid', field, issue);
}

function workspaceSessionStale(message) {
  const error = new Error(message);
  error.code = WORKSPACE_SESSION_STALE;
  return error;
}

async function canonicalWorkspacePath(value) {
  return resolve(await realpath(value));
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

function conversationKeyOf(value) {
  if (typeof value !== 'string' || !value || value.length > 1_024
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw deliveryTargetError('invalid-target', 'Invalid private conversation key');
  }
  return value;
}

function conversationWorkspaceGenerationKey(botId, conversationKey) {
  // Conversation keys validated by conversationKeyOf never contain the null
  // separator, so the compound key stays unambiguous.
  return `${botIdOf(botId)}\u0000${conversationKeyOf(conversationKey)}`;
}

function normalizeConversationWorkspaces(value) {
  const conversationWorkspaces = Object.create(null);
  if (value === undefined) return conversationWorkspaces;
  // Override damage is isolated: an invalid entry is dropped rather than
  // failing the whole document, because a missing/invalid override falls back
  // to the bot workspace safely.
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return conversationWorkspaces;
  }
  for (const [botId, overrides] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(botId)) continue;
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) continue;
    const normalized = Object.create(null);
    for (const [conversationKey, workspace] of Object.entries(overrides)) {
      if (typeof conversationKey !== 'string' || !conversationKey
        || typeof workspace !== 'string' || !isAbsolute(workspace)) continue;
      normalized[conversationKey] = resolve(workspace);
    }
    if (Object.keys(normalized).length > 0) conversationWorkspaces[botId] = normalized;
  }
  return conversationWorkspaces;
}

function normalizeDeliveryTarget(value, { targetId, allowSessionSync = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw deliveryTargetError('invalid-target', 'Invalid delivery target');
  }
  const allowed = targetId === undefined
    ? new Set(['targetId', 'name', 'kind', 'route', ...(allowSessionSync ? ['sessionSync'] : [])])
    : new Set(['name', 'kind', 'route', ...(allowSessionSync ? ['sessionSync'] : [])]);
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
  let sessionSync;
  if (value.sessionSync !== undefined) {
    if (!allowSessionSync || !value.sessionSync || typeof value.sessionSync !== 'object'
      || Array.isArray(value.sessionSync)
      || Object.keys(value.sessionSync).length !== 1
      || !Object.hasOwn(value.sessionSync, 'conversationKey')) {
      throw deliveryTargetError('invalid-target', 'Invalid delivery target session sync');
    }
    sessionSync = { conversationKey: conversationKeyOf(value.sessionSync.conversationKey) };
  }
  return {
    targetId: id,
    ...(name === undefined ? {} : { name }),
    kind: value.kind,
    route: jsonRecord(value.route),
    ...(sessionSync === undefined ? {} : { sessionSync }),
  };
}

function publicDeliveryTarget(value, { targetId } = {}) {
  const normalized = normalizeDeliveryTarget(value, { targetId, allowSessionSync: true });
  const { sessionSync: _sessionSync, ...target } = normalized;
  return target;
}

function sameDeliveryRoute(left, right) {
  return left?.kind === right?.kind
    && JSON.stringify(left?.route) === JSON.stringify(right?.route);
}

function normalizeDeliveryTargets(value, { version } = {}) {
  const deliveryTargets = Object.create(null);
  if (value === undefined) return deliveryTargets;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidWorkspaceConfig('deliveryTargets', 'expected-object');
  let field = 'deliveryTargets';
  try {
    for (const [botIndex, [botId, targets]] of Object.entries(value).entries()) {
      field = `deliveryTargets[${botIndex}].key`;
      botIdOf(botId);
      field = `deliveryTargets[${botIndex}].targets`;
      if (!targets || typeof targets !== 'object' || Array.isArray(targets)) throw new TypeError('Invalid targets');
      const normalizedTargets = Object.create(null);
      for (const [targetIndex, [targetId, target]] of Object.entries(targets).entries()) {
        field = `deliveryTargets[${botIndex}].targets[${targetIndex}]`;
        // Backward compatibility: some released builds persisted the target id
        // inside the stored object as well. Accept a redundant targetId that
        // matches the map key when loading a stored document; a mismatch stays
        // invalid so a corrupted file still fails closed.
        let candidate = target;
        if (target && typeof target === 'object' && !Array.isArray(target)
          && target.targetId !== undefined) {
          if (target.targetId !== targetId) {
            throw deliveryTargetError('invalid-target', 'Invalid target id');
          }
          const { targetId: _legacyTargetId, ...withoutLegacyId } = target;
          candidate = withoutLegacyId;
        }
        const normalized = normalizeDeliveryTarget(candidate, {
          targetId,
          allowSessionSync: version >= CURRENT_DOCUMENT_VERSION,
        });
        const { targetId: _targetId, ...stored } = normalized;
        normalizedTargets[targetId] = stored;
      }
      deliveryTargets[botId] = normalizedTargets;
    }
  } catch {
    return invalidWorkspaceConfig(field, 'invalid-delivery-target');
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidWorkspaceConfig('$', 'expected-object');
  if (![1, DELIVERY_DOCUMENT_VERSION, CURRENT_DOCUMENT_VERSION].includes(value.version)) return invalidWorkspaceConfig('version', 'unsupported-version');
  if (!value.workspaces || typeof value.workspaces !== 'object' || Array.isArray(value.workspaces)) return invalidWorkspaceConfig('workspaces', 'expected-object');
  const workspaces = {};
  for (const [index, [botId, workspace]] of Object.entries(value.workspaces).entries()) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(botId)) return invalidWorkspaceConfig(`workspaces[${index}].key`, 'invalid-identifier');
    if (typeof workspace !== 'string' || !isAbsolute(workspace)) return invalidWorkspaceConfig(`workspaces[${index}].value`, 'invalid-workspace-path');
    workspaces[botId] = resolve(workspace);
  }
  const conversationWorkspaces = normalizeConversationWorkspaces(value.conversationWorkspaces);
  let agentPresets = {};
  if (value.agentPresets !== undefined) {
    if (!value.agentPresets || typeof value.agentPresets !== 'object'
      || Array.isArray(value.agentPresets)) return invalidWorkspaceConfig('agentPresets', 'expected-object');
    for (const [index, [botId, agentPreset]] of Object.entries(value.agentPresets).entries()) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(botId)) return invalidWorkspaceConfig(`agentPresets[${index}].key`, 'invalid-identifier');
      try {
        const normalized = validateAgentPresetId(agentPreset);
        if (!normalized) return invalidWorkspaceConfig(`agentPresets[${index}].value`, 'invalid-agent-preset');
        agentPresets[botId] = normalized;
      } catch {
        return invalidWorkspaceConfig(`agentPresets[${index}].value`, 'invalid-agent-preset');
      }
    }
  }
  const models = {};
  if (value.models !== undefined) {
    if (!value.models || typeof value.models !== 'object' || Array.isArray(value.models)) {
      return invalidWorkspaceConfig('models', 'expected-object');
    }
    for (const [index, [botId, model]] of Object.entries(value.models).entries()) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(botId)) return invalidWorkspaceConfig(`models[${index}].key`, 'invalid-identifier');
      try {
        const normalized = validateModelSelection(model);
        if (!normalized) return invalidWorkspaceConfig(`models[${index}].value`, 'invalid-model-selection');
        models[botId] = normalized;
      } catch {
        return invalidWorkspaceConfig(`models[${index}].value`, 'invalid-model-selection');
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
  if (value.version === 1 && value.deliveryTargets !== undefined) return invalidWorkspaceConfig('deliveryTargets', 'unexpected-field');
  const deliveryTargets = normalizeDeliveryTargets(value.deliveryTargets, { version: value.version });
  const aliases = Object.create(null);
  if (value.aliases && typeof value.aliases === 'object' && !Array.isArray(value.aliases)) {
    for (const [botId, alias] of Object.entries(value.aliases)) {
      try {
        botIdOf(botId);
        const normalized = validateBotAlias(alias);
        if (normalized) aliases[botId] = normalized;
      } catch { /* A damaged display name must not disable the bot. */ }
    }
  }
  const accessPolicies = normalizeAccessPolicies(value.accessPolicies, workspaces);
  const version = Math.max(
    value.version,
    value.accessPolicies === undefined ? 1 : DELIVERY_DOCUMENT_VERSION,
  );
  return {
    // A v1 file cannot be emitted with this optional v2 section. If one is
    // recovered from an interrupted/manual edit, retain it on the next write.
    version,
    workspaces,
    conversationWorkspaces,
    agentPresets,
    models,
    contextEnhancement,
    deliveryTargets,
    accessPolicies,
    aliases,
  };
}

function storedDocument({
  version,
  workspaces,
  conversationWorkspaces,
  agentPresets,
  models,
  contextEnhancement,
  deliveryTargets,
  accessPolicies,
  aliases,
}) {
  const document = { version, workspaces };
  if (Object.keys(aliases).length > 0) document.aliases = aliases;
  if (Object.keys(conversationWorkspaces).length > 0) {
    document.conversationWorkspaces = conversationWorkspaces;
  }
  if (Object.keys(agentPresets).length > 0) document.agentPresets = agentPresets;
  if (Object.keys(models).length > 0) document.models = models;
  if (Object.keys(contextEnhancement).length > 0) {
    document.contextEnhancement = contextEnhancement;
  }
  if (version >= DELIVERY_DOCUMENT_VERSION && Object.keys(deliveryTargets).length > 0) {
    document.deliveryTargets = deliveryTargets;
  }
  if (version >= DELIVERY_DOCUMENT_VERSION && Object.keys(accessPolicies).length > 0) {
    document.accessPolicies = accessPolicies;
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

export async function validateWorkspacePath(value, { ungroupedWorkspace } = {}) {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value.trim())) {
    const error = new Error('工作区必须是绝对路径。');
    error.code = 'workspace-not-absolute';
    throw error;
  }
  const workspace = resolve(value.trim());
  await ensureImWorkspaceDirectory(workspace, ungroupedWorkspace);
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
  #ungroupedWorkspace;
  #version = 1;
  #workspaces = {};
  #agentPresets = {};
  #models = {};
  #aliases = Object.create(null);
  #contextEnhancement = {};
  #deliveryTargets = Object.create(null);
  #accessPolicies = Object.create(null);
  #conversationWorkspaces = Object.create(null);
  #generations = new Map();
  #nextGeneration = 1;
  #conversationGenerations = new Map();
  #nextConversationGeneration = 1;
  #incarnations = new Map();
  #nextIncarnation = 1;
  #removals = new Map();
  #removalDetails = new WeakMap();
  #dirtyRemovals = new Set();
  #writeQueue = Promise.resolve();
  #botQueues = new Map();

  constructor(path, { defaultWorkspace = defaultImWorkspace(), ungroupedWorkspace } = {}) {
    if (typeof path !== 'string' || !path) throw new TypeError('workspace store path is required');
    this.#path = path;
    this.#defaultWorkspace = resolve(defaultWorkspace);
    this.#ungroupedWorkspace = ungroupedWorkspace;
  }

  async load() {
    try {
      const normalized = normalizeDocument(JSON.parse(await readFile(this.#path, 'utf8')));
      this.#version = normalized.version;
      this.#workspaces = normalized.workspaces;
      this.#agentPresets = normalized.agentPresets;
      this.#models = normalized.models;
      this.#aliases = normalized.aliases;
      this.#contextEnhancement = normalized.contextEnhancement;
      this.#deliveryTargets = normalized.deliveryTargets;
      this.#accessPolicies = normalized.accessPolicies;
      this.#conversationWorkspaces = normalized.conversationWorkspaces;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw withConfigResource(error, 'workspace-config');
      this.#version = 1;
      this.#workspaces = {};
      this.#agentPresets = {};
      this.#models = {};
      this.#aliases = Object.create(null);
      this.#contextEnhancement = {};
      this.#deliveryTargets = Object.create(null);
      this.#accessPolicies = Object.create(null);
      this.#conversationWorkspaces = Object.create(null);
    }
    this.#generations.clear();
    this.#nextGeneration = 1;
    this.#conversationGenerations.clear();
    this.#nextConversationGeneration = 1;
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

  listBotIds() {
    return Object.keys(this.#workspaces)
      .filter((botId) => !this.#removals.has(botId))
      .sort();
  }

  incarnationFor(botId) {
    return this.#incarnations.get(botIdOf(botId)) ?? null;
  }

  workspaceFor(botId) {
    return this.#workspaces[botIdOf(botId)] ?? this.#defaultWorkspace;
  }

  /**
   * An explicit override is stored even when it equals the current bot default,
   * so a later default change must never move a conversation that pinned its
   * own workspace.
   */
  hasConversationWorkspaceOverride(botId, conversationKey) {
    const id = botIdOf(botId);
    return Boolean(conversationKey) && Boolean(this.#conversationWorkspaces[id]?.[conversationKey]);
  }

  conversationWorkspaceFor(botId, conversationKey) {
    const id = botIdOf(botId);
    const override = this.#conversationWorkspaces[id]?.[conversationKey];
    if (override) return override;
    return this.workspaceFor(id);
  }

  conversationGenerationFor(botId, conversationKey) {
    if (typeof conversationKey !== 'string' || !conversationKey) return null;
    return this.#conversationGenerations.get(
      conversationWorkspaceGenerationKey(botId, conversationKey),
    ) ?? null;
  }

  agentPresetFor(botId) {
    return this.#agentPresets[botIdOf(botId)] ?? null;
  }

  modelFor(botId) {
    const selection = this.#models[botIdOf(botId)];
    return selection ? { ...selection } : null;
  }

  aliasFor(botId) {
    const id = botIdOf(botId);
    return this.has(id) && Object.hasOwn(this.#aliases, id) ? this.#aliases[id] : '';
  }

  contextEnhancementFor(botId) {
    const id = botIdOf(botId);
    return this.has(id) && Object.hasOwn(this.#contextEnhancement, id)
      ? this.#contextEnhancement[id]
      : DEFAULT_CONTEXT_ENHANCEMENT_CONFIG;
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
      .map(([targetId, target]) => publicDeliveryTarget(target, { targetId }))
      .sort((left, right) => left.targetId.localeCompare(right.targetId));
  }

  deliveryTargetFor(botId, targetId) {
    const id = botIdOf(botId);
    const targetKey = targetIdOf(targetId);
    if (!this.has(id)) throw deliveryTargetError('unknown-bot', 'Unknown bot');
    const target = this.#deliveryTargets[id]?.[targetKey];
    return target ? publicDeliveryTarget(target, { targetId: targetKey }) : null;
  }

  listSessionSyncTargets() {
    const targets = [];
    for (const [botId, botTargets] of Object.entries(this.#deliveryTargets)) {
      if (!this.has(botId)) continue;
      for (const [targetId, target] of Object.entries(botTargets)) {
        const normalized = normalizeDeliveryTarget(target, {
          targetId,
          allowSessionSync: true,
        });
        if (!normalized.sessionSync) continue;
        targets.push({
          botId,
          targetId,
          conversationKey: normalized.sessionSync.conversationKey,
        });
      }
    }
    return targets.sort((left, right) => (
      left.botId.localeCompare(right.botId) || left.targetId.localeCompare(right.targetId)
    ));
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
      const nextVersion = Math.max(this.#version, DELIVERY_DOCUMENT_VERSION);
      await this.#persist(this.#contextEnhancement, next, nextVersion);
      this.#deliveryTargets = next;
      this.#version = nextVersion;
      return publicDeliveryTarget(stored, { targetId });
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
      const previous = this.#deliveryTargets[id][targetKey];
      const nextStored = previous.sessionSync && sameDeliveryRoute(previous, stored)
        ? { ...stored, sessionSync: previous.sessionSync }
        : stored;
      const next = {
        ...this.#deliveryTargets,
        [id]: { ...this.#deliveryTargets[id], [targetKey]: nextStored },
      };
      const nextVersion = Math.max(this.#version, DELIVERY_DOCUMENT_VERSION);
      await this.#persist(this.#contextEnhancement, next, nextVersion);
      this.#deliveryTargets = next;
      this.#version = nextVersion;
      return publicDeliveryTarget(nextStored, { targetId: targetKey });
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
      const nextVersion = Math.max(this.#version, DELIVERY_DOCUMENT_VERSION);
      await this.#persist(this.#contextEnhancement, next, nextVersion);
      this.#deliveryTargets = next;
      this.#version = nextVersion;
      return true;
    });
  }

  async setDeliveryTargetSessionSync(botId, targetId, conversationKeyOrNull) {
    const id = botIdOf(botId);
    const targetKey = targetIdOf(targetId);
    const conversationKey = conversationKeyOrNull === null
      ? null
      : conversationKeyOf(conversationKeyOrNull);
    return this.#enqueue(id, async () => {
      if (!this.has(id)) throw deliveryTargetError('unknown-bot', 'Unknown bot');
      const previous = this.#deliveryTargets[id]?.[targetKey];
      if (!previous) throw deliveryTargetError('unknown-target', 'Unknown target');
      const previousKey = previous.sessionSync?.conversationKey ?? null;
      if (previousKey === conversationKey) return conversationKey !== null;
      const nextStored = { ...previous };
      if (conversationKey === null) delete nextStored.sessionSync;
      else nextStored.sessionSync = { conversationKey };
      const next = {
        ...this.#deliveryTargets,
        [id]: { ...this.#deliveryTargets[id], [targetKey]: nextStored },
      };
      await this.#persist(this.#contextEnhancement, next, CURRENT_DOCUMENT_VERSION);
      this.#deliveryTargets = next;
      this.#version = CURRENT_DOCUMENT_VERSION;
      return conversationKey !== null;
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
      const accessPolicy = initializesAccessPolicy
        ? validateAccessPolicy(initialAccessPolicy)
        : undefined;
      const agentPreset = createsBot ? validateAgentPresetId(defaultAgentPreset) : null;
      // Resolve saved bot/conversation choices before preparing the shared IM
      // directory. Merely loading a channel must not create an unused fallback.
      const selectedWorkspaces = new Set([
        this.#workspaces[id] ?? initialWorkspace,
        ...Object.values(this.#conversationWorkspaces[id] ?? {}),
      ]);
      for (const selected of selectedWorkspaces) {
        await ensureImWorkspaceDirectory(selected, this.#ungroupedWorkspace);
      }
      if (createsBot || initializesAccessPolicy) {
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
        const nextVersion = initializesAccessPolicy
          ? Math.max(this.#version, DELIVERY_DOCUMENT_VERSION)
          : this.#version;
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
    const workspace = await validateWorkspacePath(value, { ungroupedWorkspace: this.#ungroupedWorkspace });
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

  async setConversationWorkspace(botId, conversationKey, value, {
    clearSession,
    incarnation,
  } = {}) {
    const id = botIdOf(botId);
    if (typeof conversationKey !== 'string' || !conversationKey
      || conversationKey.length > 1_024 || conversationKey.trim() !== conversationKey
      || /[\u0000-\u001f\u007f]/u.test(conversationKey)) {
      throw new TypeError('conversationKey is required');
    }
    if (!this.has(id)
      || (incarnation !== undefined && incarnation !== this.incarnationFor(id))) {
      const error = new Error('找不到要修改的机器人。');
      error.code = 'workspace-bot-not-found';
      throw error;
    }
    const token = this.publishConversationWorkspaceSwitch(id, conversationKey);
    return this.applyConversationWorkspaceSwitch(id, conversationKey, value, {
      token,
      clearSession,
      incarnation,
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

  async setModel(botId, value, { incarnation } = {}) {
    const id = botIdOf(botId);
    if (!this.has(id)
      || (incarnation !== undefined && incarnation !== this.incarnationFor(id))) {
      const error = new Error('找不到要修改的机器人。');
      error.code = 'workspace-bot-not-found';
      throw error;
    }
    const model = validateModelSelection(value);
    return this.#enqueue(id, async () => {
      if (!this.has(id)
        || (incarnation !== undefined && incarnation !== this.incarnationFor(id))) {
        const error = new Error('找不到要修改的机器人。');
        error.code = 'workspace-bot-not-found';
        throw error;
      }
      const previous = this.#models[id] ?? null;
      if (sameModelSelection(previous, model)) return model ? { ...model } : null;
      if (model) this.#models[id] = model;
      else delete this.#models[id];
      try {
        await this.#persist();
      } catch (error) {
        if (previous) this.#models[id] = previous;
        else delete this.#models[id];
        throw error;
      }
      return model ? { ...model } : null;
    });
  }

  async setAlias(botId, value, { incarnation } = {}) {
    const id = botIdOf(botId);
    const expectedIncarnation = incarnation === undefined ? this.incarnationFor(id) : incarnation;
    const alias = validateBotAlias(value);
    return this.#enqueue(id, async () => {
      if (!this.has(id) || expectedIncarnation !== this.incarnationFor(id)) {
        const error = new Error('找不到要修改的机器人。');
        error.code = 'workspace-bot-not-found';
        throw error;
      }
      const next = { ...this.#aliases };
      if (alias) next[id] = alias;
      else delete next[id];
      await this.#persist(this.#contextEnhancement, this.#deliveryTargets,
        this.#version, this.#accessPolicies, next);
      this.#aliases = next;
      return alias;
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
        Math.max(this.#version, DELIVERY_DOCUMENT_VERSION),
        next,
      );
      this.#accessPolicies = next;
      this.#version = Math.max(this.#version, DELIVERY_DOCUMENT_VERSION);
      return policy;
    });
  }

  /**
   * Publish the fence for a conversation-level switch before its asynchronous
   * work starts. Every session that was resolved for this conversation is
   * invalidated from this moment on: a bind or prompt already in flight must
   * not keep running (or be written back) in the workspace being left behind.
   * Returns the opaque token that applyConversationWorkspaceSwitch requires, so
   * two overlapping switches cannot adopt each other's fence.
   */
  publishConversationWorkspaceSwitch(botId, conversationKey) {
    const id = botIdOf(botId);
    conversationKeyOf(conversationKey);
    const token = this.#freshConversationGeneration();
    this.#conversationGenerations.set(
      conversationWorkspaceGenerationKey(id, conversationKey),
      token,
    );
    return token;
  }

  /** True while this token is still the current fence for the conversation. */
  isConversationWorkspaceSwitchCurrent(botId, conversationKey, token) {
    const id = botIdOf(botId);
    conversationKeyOf(conversationKey);
    return this.#conversationGenerations.get(
      conversationWorkspaceGenerationKey(id, conversationKey),
    ) === token;
  }

  async applyConversationWorkspaceSwitch(botId, conversationKey, value, {
    token,
    clearSession,
    sessionMatchesWorkspace,
    incarnation,
  } = {}) {
    const id = botIdOf(botId);
    const key = conversationKeyOf(conversationKey);
    if (typeof token !== 'number') throw new TypeError('token is required');
    if (!this.has(id)
      || (incarnation !== undefined && incarnation !== this.incarnationFor(id))) {
      const error = new Error('找不到要修改的机器人。');
      error.code = 'workspace-bot-not-found';
      throw error;
    }
    // Validate before queueing so an invalid path fails without disturbing the
    // conversation's current workspace or its session.
    const workspace = value === null ? null : await validateWorkspacePath(value, {
      ungroupedWorkspace: this.#ungroupedWorkspace,
    });
    return this.#enqueue(id, async () => {
      const assertCurrentSwitch = () => {
        if (!this.has(id)
          || (incarnation !== undefined && incarnation !== this.incarnationFor(id))) {
          const error = new Error('找不到要修改的机器人。');
          error.code = 'workspace-bot-not-found';
          throw error;
        }
        if (!this.isConversationWorkspaceSwitchCurrent(id, key, token)) {
          throw workspaceSessionStale(
            'The conversation workspace changed before this switch could be committed.',
          );
        }
      };
      assertCurrentSwitch();
      if (workspace === null) {
        await ensureImWorkspaceDirectory(this.workspaceFor(id), this.#ungroupedWorkspace);
        assertCurrentSwitch();
      }
      const previousOverrides = this.#conversationWorkspaces[id];
      const previous = previousOverrides?.[key];
      const hadOverride = Boolean(previousOverrides)
        && Object.hasOwn(previousOverrides, key);
      if (workspace === null ? !hadOverride : (hadOverride && previous === workspace)) {
        // The override may be unchanged while a binding persisted by an older
        // version still points elsewhere. Only preserve a verified matching
        // Session; never acknowledge /conv while keeping a foreign cwd.
        const matches = await sessionMatchesWorkspace?.(this.conversationWorkspaceFor(id, key));
        assertCurrentSwitch();
        if (matches === false) {
          await clearSession?.();
          assertCurrentSwitch();
        }
        return this.conversationWorkspaceFor(id, key);
      }
      const next = workspace === null
        ? (() => {
          const overrides = { ...previousOverrides };
          delete overrides[key];
          return overrides;
        })()
        : { ...previousOverrides, [key]: workspace };
      await clearSession?.();
      assertCurrentSwitch();
      if (Object.keys(next).length > 0) this.#conversationWorkspaces[id] = next;
      else delete this.#conversationWorkspaces[id];
      try {
        // Binding a conversation to its own current default is still persisted:
        // a later bot-default change must not move a conversation that pinned
        // the workspace it was using.
        await this.#persist();
      } catch (error) {
        if (Object.keys(next).length > 0 || hadOverride) {
          this.#conversationWorkspaces[id] = {
            ...(previousOverrides ?? {}),
            ...(hadOverride ? { [key]: previous } : {}),
          };
        } else {
          delete this.#conversationWorkspaces[id];
        }
        throw error;
      }
      return this.conversationWorkspaceFor(id, key);
    });
  }

  async bindWorkspaceSession(botId, value, {
    conversationKey,
    sessionId,
    clearSessions,
    clearSession,
    setSession,
    onConversationGeneration,
    incarnation,
    expectedGeneration,
    expectedConversationGeneration,
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
    // Capture before any asynchronous lookup, unless the caller already captured
    // the fence before adopting the Session.
    let conversationGeneration = expectedConversationGeneration === undefined
      ? this.conversationGenerationFor(id, conversationKey)
      : expectedConversationGeneration;
    const assertConversationCurrent = () => {
      if (conversationGeneration !== this.conversationGenerationFor(id, conversationKey)) {
        throw workspaceSessionStale(
          'The conversation workspace changed before the session binding could be committed.',
        );
      }
    };
    const workspace = await canonicalWorkspacePath(await validateWorkspacePath(value, {
      ungroupedWorkspace: this.#ungroupedWorkspace,
    }));
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
      // An explicit session binding is also a conversation-level statement: a
      // workspace switch queued while the session was being adopted must not be
      // silently overwritten by the binding that started before it.
      assertConversationCurrent();
      const sameWorkspace = await sameWorkspacePath(workspace, this.workspaceFor(id));
      const previousOverrides = this.#conversationWorkspaces[id];
      const override = previousOverrides?.[conversationKey];
      const clearsOverride = override !== undefined && !(await sameWorkspacePath(workspace, override));
      assertConversationCurrent();
      if (!sameWorkspace || clearsOverride) {
        if (sameWorkspace && typeof clearSession !== 'function') {
          throw new TypeError('clearSession is required to reconcile a conversation workspace');
        }
        const previous = this.#workspaces[id];
        if (clearsOverride) {
          // /session keeps its bot-default semantics, but cannot leave this
          // conversation pinned to a different cwd from the adopted Session.
          // Publish the new fence to the scope before any asynchronous work.
          conversationGeneration = this.publishConversationWorkspaceSwitch(id, conversationKey);
          onConversationGeneration?.(conversationGeneration);
        }
        if (!sameWorkspace) {
          this.#generations.set(id, this.#freshGeneration());
          await clearSessions();
        } else {
          await clearSession(conversationKey);
        }
        assertConversationCurrent();
        if (!sameWorkspace) this.#workspaces[id] = workspace;
        if (clearsOverride) {
          const next = { ...previousOverrides };
          delete next[conversationKey];
          if (Object.keys(next).length) this.#conversationWorkspaces[id] = next;
          else delete this.#conversationWorkspaces[id];
        }
        try {
          await this.#persist();
        } catch (error) {
          // Session mappings stay cleared and the advanced generation stays
          // fenced. Restoring either could pair an old session with a state
          // transition whose durable outcome is unknown.
          this.#workspaces[id] = previous;
          if (clearsOverride) this.#conversationWorkspaces[id] = previousOverrides;
          throw error;
        }
      }

      // This write remains inside the same bot transition as the workspace
      // mutation, so another switch or bind cannot interleave between them.
      assertConversationCurrent();
      await setSession(conversationKey, sessionId);
      assertConversationCurrent();
      return {
        workspace,
        sessionId,
        generation: this.#generations.get(id),
        conversationGeneration,
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
      ...Object.keys(this.#models),
      ...Object.keys(this.#aliases),
      ...Object.keys(this.#contextEnhancement),
      ...Object.keys(this.#deliveryTargets),
      ...Object.keys(this.#accessPolicies),
      ...Object.keys(this.#conversationWorkspaces),
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
          ...(this.aliasFor(bot.botId) ? { bot: withBotAlias(bot.bot, this.aliasFor(bot.botId)) } : {}),
          workspace: this.workspaceFor(bot.botId),
          agentPreset: this.agentPresetFor(bot.botId),
          model: this.modelFor(bot.botId),
          contextEnhancement: this.contextEnhancementFor(bot.botId),
          accessPolicy: this.accessPolicyFor(bot.botId),
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

  #freshConversationGeneration() {
    const generation = this.#nextConversationGeneration;
    this.#nextConversationGeneration += 1;
    return generation;
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
    const hadModel = Object.hasOwn(this.#models, id);
    const hadAlias = Object.hasOwn(this.#aliases, id);
    const hadContextEnhancement = Object.hasOwn(this.#contextEnhancement, id);
    const hadDeliveryTargets = Object.hasOwn(this.#deliveryTargets, id);
    const hadAccessPolicy = Object.hasOwn(this.#accessPolicies, id);
    const hadConversationWorkspaces = Object.hasOwn(this.#conversationWorkspaces, id);
    const needsCleanup = hadWorkspace || hadPreset || hadModel || hadAlias || hadContextEnhancement
      || hadDeliveryTargets || hadAccessPolicy || hadConversationWorkspaces
      || this.#dirtyRemovals.has(id);
    delete this.#workspaces[id];
    delete this.#agentPresets[id];
    delete this.#models[id];
    delete this.#aliases[id];
    delete this.#contextEnhancement[id];
    delete this.#deliveryTargets[id];
    delete this.#accessPolicies[id];
    delete this.#conversationWorkspaces[id];
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
    aliases = this.#aliases,
    conversationWorkspaces = this.#conversationWorkspaces,
  ) {
    await writeStoredDocument(this.#path, storedDocument({
      version,
      workspaces: this.#workspaces,
      conversationWorkspaces,
      agentPresets: this.#agentPresets,
      models: this.#models,
      contextEnhancement,
      deliveryTargets,
      accessPolicies,
      aliases,
    }));
    this.#dirtyRemovals.clear();
  }

  async #persistCurrentDocument() {
    if (Object.keys(this.#workspaces).length > 0
      || Object.keys(this.#agentPresets).length > 0
      || Object.keys(this.#models).length > 0
      || Object.keys(this.#aliases).length > 0
      || Object.keys(this.#contextEnhancement).length > 0
      || Object.keys(this.#deliveryTargets).length > 0
      || Object.keys(this.#accessPolicies).length > 0
      || Object.keys(this.#conversationWorkspaces).length > 0) {
      await this.#persist();
      return;
    }
    try {
      const parent = await stat(dirname(this.#path));
      if (!parent.isDirectory()) {
        const error = new Error('workspace config parent is not a directory');
        error.code = 'ENOTDIR';
        throw error;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.#dirtyRemovals.clear();
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

function resolveModelCatalog(catalog) {
  if (!catalog) return null;
  const value = typeof catalog === 'function' ? catalog() : catalog;
  return value && typeof value.then === 'function'
    ? value.then(normalizeModelCatalog)
    : normalizeModelCatalog(value);
}

function unavailableAgentPreset() {
  const error = new Error('Agent Preset 不存在或不可用。');
  error.code = 'agent-preset-unavailable';
  return error;
}

function unavailableModel() {
  const error = new Error('模型不存在或不可用。');
  error.code = 'model-selection-unavailable';
  return error;
}

function assertCurrentBotScope(isCurrentScope) {
  if (isCurrentScope()) return;
  const error = new Error('找不到要修改的机器人。');
  error.code = 'workspace-bot-not-found';
  throw error;
}

function decorateResult(workspaces, result, agentPresetCatalogSource, modelCatalogSource) {
  const decorate = (value) => {
    const decorated = workspaces.decorateStatus(value);
    if ((!agentPresetCatalogSource && !modelCatalogSource)
      || !decorated || typeof decorated !== 'object') return decorated;
    const attachCatalogs = ([agentPresetCatalog, modelCatalog]) => ({
      ...decorated,
      ...(agentPresetCatalog ? { agentPresetCatalog } : {}),
      ...(modelCatalog ? { modelCatalog } : {}),
    });
    const catalogs = [
      resolveAgentPresetCatalog(agentPresetCatalogSource),
      resolveModelCatalog(modelCatalogSource),
    ];
    return catalogs.some((catalog) => catalog && typeof catalog.then === 'function')
      ? Promise.all(catalogs).then(attachCatalogs)
      : attachCatalogs(catalogs);
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
          if (botId) {
            const cleanup = await atConnectionStage('workspace.cleanup', () => workspaces.retireAfterConfigCommit(botId), 'workspace-config');
            if (cleanup?.error) throw connectionStageError(cleanup.error, 'workspace.cleanup', 'workspace-config');
          }
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
  // A conversation-level switch/clear publishes an opaque mask token before it
  // starts its asynchronous work, so a bind or prompt that was already resolved
  // for that conversation is rejected instead of running in the old workspace.
  // The store keeps the same token as the conversation's generation, so the
  // scope marker and the durable generation never disagree.
  const conversationSwitchMasks = new Map();
  // The in-flight switch of each conversation, so a message that starts while
  // /conv is still committing waits for the new workspace instead of resolving
  // a session in the old one.
  const pendingConversationSwitches = new Map();

  function trackConversationSwitch(conversationKey, promise) {
    pendingConversationSwitches.set(conversationKey, promise);
    return promise.finally(() => {
      if (pendingConversationSwitches.get(conversationKey) === promise) {
        pendingConversationSwitches.delete(conversationKey);
        if (isCurrentScope()) refreshRetainedSession(conversationKey);
      }
    });
  }

  function currentConversationGeneration(conversationKey) {
    // The store reports "no override recorded yet" as null; map it to an opaque
    // token so "before the first switch" is still a comparable state.
    const generation = workspaces.conversationGenerationFor(botId, conversationKey);
    return generation ?? 0;
  }

  function maskConversationSwitch(conversationKey, token) {
    if (!conversationKey) return;
    conversationSwitchMasks.set(
      conversationKey,
      token === undefined ? currentConversationGeneration(conversationKey) : token,
    );
  }

  function conversationGenerationIsStale(conversationKey, expected) {
    if (typeof conversationKey !== 'string' || !conversationKey) return false;
    const mask = conversationSwitchMasks.get(conversationKey);
    if (mask !== undefined && mask !== currentConversationGeneration(conversationKey)) {
      return true;
    }
    if (expected === undefined) return false;
    return expected !== currentConversationGeneration(conversationKey);
  }

  function generationIsStale(entry, conversationKey = entry?.conversationKey) {
    return Boolean(entry)
      && ((entry.generation !== undefined && entry.generation !== workspaces.generationFor(botId))
        || (entry.conversationKey === conversationKey
          && conversationGenerationIsStale(conversationKey, entry.conversationGeneration)));
  }

  /**
   * Refresh provenance only for a mapping that survived an unchanged/failed
   * switch. Removed mappings and pending creates retain their old fence, so a
   * delayed setSession cannot resurrect them after the switch finishes.
   */
  function refreshRetainedSession(conversationKey) {
    const sessionId = state.sessionFor?.(conversationKey);
    const entry = sessionGenerations.get(sessionId);
    if (entry?.conversationKey === conversationKey
      && entry.generation === workspaces.generationFor(botId)) {
      sessionGenerations.set(sessionId, {
        ...entry,
        conversationGeneration: currentConversationGeneration(conversationKey),
      });
    }
  }

  async function conversationSessionMatchesWorkspace(conversationKey, workspace) {
    const sessionId = state.sessionFor?.(conversationKey);
    if (!sessionId) return true;
    let sessionWorkspace = sessionGenerations.get(sessionId)?.workspace;
    let matches = false;
    let unregistered = true;
    if (!sessionWorkspace && typeof harness.rpc === 'function') {
      // Read registration metadata only: adopting a Session is not a lookup.
      // Resolve by id before comparing real paths so symlink pins remain valid.
      const listed = await harness.rpc('workspace.list', {}, 30_000);
      if (!Array.isArray(listed?.items)) {
        throw new TypeError('Harness returned an invalid workspace list');
      }
      const owners = listed.items.filter((item) => Array.isArray(item?.sessionIds)
        && item.sessionIds.includes(sessionId));
      if (owners.length === 1 && typeof owners[0].path === 'string' && isAbsolute(owners[0].path)) {
        sessionWorkspace = owners[0].path;
      }
      unregistered = owners.length === 0;
    }
    if (!sessionWorkspace && unregistered && typeof harness.listWorkspaceSessions === 'function') {
      // After a restart, default IM sessions have no registry owner. Reuse
      // the read-only list, which also recognizes ungrouped default sessions.
      const listed = await harness.listWorkspaceSessions(await canonicalWorkspacePath(workspace));
      if (!Array.isArray(listed?.sessions)) {
        throw new TypeError('Harness returned an invalid workspace session list');
      }
      matches = listed.sessions.some((session) => session?.sessionId === sessionId);
    }
    if (sessionWorkspace) matches = await sameWorkspacePath(sessionWorkspace, workspace);
    if (state.sessionFor(conversationKey) !== sessionId) {
      throw workspaceSessionStale('The session binding changed while its workspace was being checked.');
    }
    return matches;
  }

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
      if (property === 'currentConversationWorkspace') {
        return (conversationKey) => {
          if (!isCurrentScope()) {
            const error = new Error('找不到要修改的机器人。');
            error.code = 'workspace-bot-not-found';
            throw error;
          }
          return workspaces.conversationWorkspaceFor(botId, conversationKey);
        };
      }
      if (property === 'hasConversationWorkspaceOverride') {
        return (conversationKey) => {
          assertCurrentBotScope(isCurrentScope);
          return workspaces.hasConversationWorkspaceOverride(botId, conversationKey);
        };
      }
      if (property === 'pendingConversationWorkspaceSwitch') {
        // Read-only: callers in the message path wait for a switch that is
        // still committing before they resolve a session for this conversation.
        return (conversationKey) => pendingConversationSwitches.get(conversationKey) ?? null;
      }
      if (property === 'conversationWorkspaceGeneration') {
        // Read-only fence token for the conversation's effective workspace.
        // Callers outside this scope (message bridging) compare it across the
        // bind and the send so a late switch cannot be outrun.
        return (conversationKey) => currentConversationGeneration(conversationKey);
      }
      if (property === 'switchConversationWorkspace') {
        return (conversationKey, workspace) => {
          if (!isCurrentScope()) {
            const error = new Error('找不到要修改的机器人。');
            error.code = 'workspace-bot-not-found';
            return Promise.reject(error);
          }
          const token = workspaces.publishConversationWorkspaceSwitch(botId, conversationKey);
          maskConversationSwitch(conversationKey, token);
          return trackConversationSwitch(conversationKey, workspaces.applyConversationWorkspaceSwitch(botId, conversationKey, workspace, {
            token,
            sessionMatchesWorkspace: (selected) => conversationSessionMatchesWorkspace(conversationKey, selected),
            clearSession: async () => {
              await state.clearSession(conversationKey);
              // A handle resolved before this switch must not stay usable: the
              // conversation now belongs to another workspace.
            },
            incarnation,
          }));
        };
      }
      if (property === 'clearConversationWorkspace') {
        return (conversationKey) => {
          if (!isCurrentScope()) {
            const error = new Error('找不到要修改的机器人。');
            error.code = 'workspace-bot-not-found';
            return Promise.reject(error);
          }
          const token = workspaces.publishConversationWorkspaceSwitch(botId, conversationKey);
          maskConversationSwitch(conversationKey, token);
          return trackConversationSwitch(conversationKey, workspaces.applyConversationWorkspaceSwitch(botId, conversationKey, null, {
            token,
            sessionMatchesWorkspace: (selected) => conversationSessionMatchesWorkspace(conversationKey, selected),
            clearSession: async () => {
              await state.clearSession(conversationKey);
            },
            incarnation,
          }));
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
          const expectedConversationGeneration = workspaces.conversationGenerationFor(botId, conversationKey);
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
          if (expectedConversationGeneration
            !== workspaces.conversationGenerationFor(botId, conversationKey)) {
            throw workspaceSessionStale(
              'The conversation workspace changed while the session was being adopted.',
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
            clearSession: (key) => state.clearSession(key),
            setSession: (key, selectedSessionId) => state.setSession(key, selectedSessionId),
            onConversationGeneration: (generation) => maskConversationSwitch(conversationKey, generation),
            incarnation,
            expectedGeneration,
            expectedConversationGeneration,
          });
          if (!isCurrentScope()) {
            const error = new Error('找不到要修改的机器人。');
            error.code = 'workspace-bot-not-found';
            throw error;
          }
          if (bound.generation !== workspaces.generationFor(botId)
            || bound.conversationGeneration
              !== workspaces.conversationGenerationFor(botId, conversationKey)) {
            throw workspaceSessionStale(
              'The bot workspace changed before the session binding completed.',
            );
          }
          sessionGenerations.set(sessionId, {
            generation: bound.generation,
            workspace: bound.workspace,
            conversationKey,
            conversationGeneration: bound.conversationGeneration ?? 0,
          });
          return {
            ...adopted,
            workspace: bound.workspace,
            sessionId: bound.sessionId,
          };
        };
      }
      if (property === 'createSession') {
        return async (options = {}) => {
          const { inheritBotModel = true, conversationKey, ...createOptions } = options;
          // /conv publishes its generation before path validation enters the
          // bot queue. Wait for both phases before pairing a workspace with its
          // generation; otherwise a new session can carry a new fence but old cwd.
          while (true) {
            const pendingSwitch = pendingConversationSwitches.get(conversationKey);
            if (pendingSwitch) await pendingSwitch;
            await workspaces.whenBotIdle(botId);
            if (!pendingConversationSwitches.has(conversationKey)) break;
          }
          if (!isCurrentScope()) {
            const error = new Error('找不到要修改的机器人。');
            error.code = 'workspace-bot-not-found';
            throw error;
          }
          const generation = workspaces.generationFor(botId);
          const conversationGeneration = conversationKey
            ? currentConversationGeneration(conversationKey)
            : null;
          const agentPreset = workspaces.agentPresetFor(botId);
          const model = inheritBotModel === false ? null : workspaces.modelFor(botId);
          const workspace = workspaces.conversationWorkspaceFor(botId, conversationKey);
          const sessionId = await target.createSession({
            ...createOptions,
            workspace,
            ...(agentPreset == null ? {} : { agentPreset }),
          });
          // A conversation-level workspace switch can commit while the session is
          // being created; never bind a session created in the stale workspace to
          // a conversation whose override already moved on.
          if (conversationGenerationIsStale(conversationKey, conversationGeneration)) {
            throw workspaceSessionStale(
              'The conversation workspace changed while the session was being created.',
            );
          }
          if (model) {
            if (typeof target.selectSessionModel !== 'function') {
              throw new TypeError('Harness does not support model selection');
            }
            const selected = await target.selectSessionModel(
              sessionId,
              model,
              options.signal ? { signal: options.signal } : {},
            );
            if (!confirmsModelSelection(selected?.selected, model)) {
              const error = new Error('Harness did not confirm the selected model');
              error.code = 'model-selection-mismatch';
              throw error;
            }
          }
          sessionGenerations.set(sessionId, {
            generation,
            workspace,
            conversationKey,
            conversationGeneration,
          });
          return sessionId;
        };
      }
      if (property === 'workspaceSession') {
        return (sessionId, sessionConversationKey) => {
          if (typeof sessionId !== 'string' || !sessionId) {
            // A caller whose mapping was cleared under it must retry the
            // resolution instead of crashing on a handle it cannot use.
            return null;
          }
          const entry = sessionGenerations.get(sessionId);
          const generation = entry?.generation
            ?? workspaces.generationFor(botId);
          // A session handle that names its conversation also fences the
          // conversation's effective workspace: a switch that starts after the
          // bind but before the prompt is sent must not run in the old workspace.
          const conversationKey = typeof sessionConversationKey === 'string'
            && sessionConversationKey
            ? sessionConversationKey
            : entry?.conversationKey ?? null;
          const conversationGeneration = conversationKey
            ? (entry?.conversationKey === conversationKey
              ? entry.conversationGeneration
              : currentConversationGeneration(conversationKey))
            : null;
          // Copy provenance into the immutable handle, but retain it for a later
          // setSession (notably /model, which binds after asynchronous selection).
          const isCurrentSession = () => isCurrentScope()
            && generation === workspaces.generationFor(botId)
            && !conversationGenerationIsStale(conversationKey, conversationGeneration);
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
            stopDeferredTurn(...args) {
              return invokeStartedSessionMutation('stopDeferredTurn', args, 'deferred turn stop');
            },
            steerActiveTurn(...args) {
              return invokeStartedSessionMutation('steerActiveTurn', args, 'turn steering');
            },
            ...(typeof target.executeCommand === 'function' ? {
              executeCommand(...args) {
                return invokeStartedSessionMutation('executeCommand', args, 'command execution');
              },
            } : {}),
            ask(...args) {
              if (!isCurrentSession()) {
                throw workspaceSessionStale(
                  'The bot workspace changed before this prompt started.',
                );
              }
              return target.ask(sessionId, ...args);
            },
          });
        };
      }
      if (property === 'sessionExists') {
        return (sessionId, ...args) => {
          if (!isCurrentScope()) return false;
          const entry = sessionGenerations.get(sessionId);
          if (generationIsStale(entry)) {
            return false;
          }
          return target.sessionExists(sessionId, ...args);
        };
      }
      if (property === 'ask') {
        return (sessionId, ...args) => {
          const entry = sessionGenerations.get(sessionId);
          if (!isCurrentScope() || generationIsStale(entry)) {
            const error = new Error('The bot workspace changed before this prompt started.');
            error.code = WORKSPACE_SESSION_STALE;
            throw error;
          }
          return target.ask(sessionId, ...args);
        };
      }
      if (property === 'executeCommand' && typeof target.executeCommand === 'function') {
        return (sessionId, ...args) => {
          const entry = sessionGenerations.get(sessionId);
          if (!isCurrentScope() || generationIsStale(entry)) {
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
          if (sessionId) {
            const entry = sessionGenerations.get(sessionId);
            if (generationIsStale(entry, key)) {
              // The conversation's effective workspace already moved on, so the
              // stored mapping must not be treated as a usable session. The
              // caller re-resolves one in the current workspace instead.
              return null;
            }
            if (!entry) {
              sessionGenerations.set(sessionId, {
                generation: workspaces.generationFor(botId),
                conversationKey: key,
                conversationGeneration: currentConversationGeneration(key),
              });
            }
          }
          return sessionId;
        };
      }
      if (property === 'setSession') {
        return (key, sessionId, ...args) => {
          const entry = sessionGenerations.get(sessionId);
          if (!isCurrentScope() || generationIsStale(entry, key)) {
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

export function createWorkspaceAwareController(controller, {
  workspaces,
  stateFor,
  agentPresetCatalog,
  modelCatalog,
} = {}) {
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
  const decorate = (value) => decorateResult(
    workspaces,
    value,
    agentPresetCatalog,
    modelCatalog,
  );
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
        modelCatalog,
      );
    });
  };
  const updateModel = (botId, value) => {
    const incarnation = workspaces.incarnationFor(botId);
    const model = validateModelSelection(value);
    return withBotTransition(botId, async () => {
      const snapshot = await controller.status();
      if (!snapshot?.bots?.some((bot) => bot?.botId === botId)) {
        const error = new Error('找不到要修改的机器人。');
        error.code = 'workspace-bot-not-found';
        throw error;
      }
      const catalog = model && modelCatalog
        ? await resolveModelCatalog(modelCatalog)
        : null;
      const entry = modelCatalogEntry(catalog, model);
      if (model && (!modelCatalog || !entry)) {
        throw unavailableModel();
      }
      if (model?.reasoningEffort !== undefined
        && !entry.reasoning?.efforts.some((effort) => effort.id === model.reasoningEffort)) {
        const error = new Error('当前模型不支持所选思考强度，请重新选择。');
        error.code = 'model-reasoning-unavailable';
        throw error;
      }
      await workspaces.setModel(botId, model, { incarnation });
      return decorateResult(
        workspaces,
        await controller.status(),
        agentPresetCatalog,
        catalog ?? modelCatalog,
      );
    });
  };
  const updateAlias = (botId, value, projectStatus) => {
    const incarnation = workspaces.incarnationFor(botId);
    const alias = validateBotAlias(value);
    return withBotTransition(botId, async () => {
      const snapshot = await decorate(await controller.status());
      if (!snapshot?.bots?.some((bot) => bot?.botId === botId)) {
        const error = new Error('找不到要修改的机器人。');
        error.code = 'workspace-bot-not-found';
        throw error;
      }
      const updated = { ...snapshot, bots: snapshot.bots.map((bot) => bot.botId === botId
        ? { ...bot, bot: withBotAlias(bot.bot, alias) } : bot) };
      const result = projectStatus ? await projectStatus(updated) : updated;
      await workspaces.setAlias(botId, alias, { incarnation });
      return result;
    });
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
      const [catalog, models] = await Promise.all([
        resolveAgentPresetCatalog(agentPresetCatalog),
        resolveModelCatalog(modelCatalog),
      ]);
      const decorated = workspaces.decorateStatus(snapshot);
      const updated = {
        ...decorated,
        bots: decorated.bots.map((bot) => bot?.botId === botId
          ? { ...bot, contextEnhancement: config } : bot),
        ...(catalog ? { agentPresetCatalog: catalog } : {}),
        ...(models ? { modelCatalog: models } : {}),
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
      const [catalog, models] = await Promise.all([
        resolveAgentPresetCatalog(agentPresetCatalog),
        resolveModelCatalog(modelCatalog),
      ]);
      const decorated = workspaces.decorateStatus(snapshot);
      const updated = {
        ...decorated,
        bots: decorated.bots.map((bot) => bot?.botId === botId
          ? { ...bot, accessPolicy: policy } : bot),
        ...(catalog ? { agentPresetCatalog: catalog } : {}),
        ...(models ? { modelCatalog: models } : {}),
      };
      // Prepare the complete channel-specific response before commit. Failed
      // projections and disk writes must leave the live policy unchanged.
      const result = projectStatus ? await projectStatus(updated) : updated;
      await workspaces.setAccessPolicy(botId, policy, { incarnation });
      return result;
    });
  };
  const deleteWithWorkspace = (botId, invokeDelete) => withBotTransition(botId, async () => {
    const warnings = [];
    const cleanupWarning = (error, stage = 'workspace.cleanup') => {
      if (!controller.diagnostics) return;
      warnings.push(controller.diagnostics.report(error, { operation: 'bot.delete', stage, botId, warning: true,
        publicError: { code: 'workspace-cleanup-failed', message: stage === 'state.cleanup'
          ? t('本地会话状态清理失败，请查看诊断详情。') : t('账号已移除，但本地状态清理失败。') } }).publicError);
    };
    const finishRemoval = async () => {
      const outcome = await workspaces.finishRemoval(removal);
      if (outcome?.error) cleanupWarning(outcome.error);
    };
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
          if (controller.diagnostics) cleanupWarning(error, 'state.cleanup');
          else console.warn('[dsh-im] ignored session cleanup failure while deleting bot:', extractConnectionEvidence(error).details);
        }
      },
    });
    try {
      const result = await invokeDelete();
      await finishRemoval();
      return decorate({ ...result, ...(warnings.length ? { warnings: [...(result?.warnings ?? []), ...warnings] } : {}) });
    } catch (error) {
      const after = await targetStatus(controller).catch(() => null);
      const knownAbsent = Array.isArray(after?.bots)
        && !after.bots.some((bot) => bot?.botId === botId);
      if (knownAbsent) {
        if (controller.diagnostics) {
          cleanupWarning(error);
          try { await finishRemoval(); } catch (cleanupError) { cleanupWarning(cleanupError); }
          return decorate({ ...after, warnings });
        }
        await workspaces.finishRemoval(removal);
      } else await workspaces.abortRemoval(removal);
      throw error;
    }
  });

  return new Proxy(controller, {
    get(target, property) {
      if (property === 'updateWorkspace') return updateWorkspace;
      if (property === 'updateAgentPreset') return updateAgentPreset;
      if (property === 'updateModel') return updateModel;
      if (property === 'updateAlias') return updateAlias;
      if (property === 'updateContextEnhancement') return updateContextEnhancement;
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
