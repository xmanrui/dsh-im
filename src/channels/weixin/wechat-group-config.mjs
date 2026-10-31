import { readFile } from 'node:fs/promises';

const ROOT_KEYS = new Set(['version', 'pollIntervalMs', 'groups']);
const GROUP_KEYS = new Set(['id', 'title', 'commandPrefix', 'mentionMode', 'allowSelf']);
const GROUP_ID_PATTERN = /^uia_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const COMMAND_PREFIX_PATTERN = /^\/[^\s]+$/;

function invalid(message, options = {}) {
  const error = new Error('Invalid WeChat group config: ' + message, options);
  error.code = 'invalid-group-config';
  return error;
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(label + ' must be an object');
  }
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw invalid(label + ' contains unknown key ' + key);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalid(label + ' must be a non-empty string');
  }
  return value;
}

function normalizeGroup(value, index) {
  const group = plainObject(value, 'groups[' + index + ']');
  exactKeys(group, GROUP_KEYS, 'groups[' + index + ']');

  const id = nonEmptyString(group.id, 'groups[' + index + '].id');
  if (!GROUP_ID_PATTERN.test(id)) {
    throw invalid('groups[' + index + '].id must be a stable uia_ identifier');
  }

  // UIA selection depends on an exact title. Refuse surrounding whitespace and
  // line controls instead of silently normalizing into a different chat.
  const title = nonEmptyString(group.title, 'groups[' + index + '].title');
  if (title !== title.trim() || /[\0\r\n]/.test(title)) {
    throw invalid('groups[' + index + '].title must be an exact single-line title');
  }

  const commandPrefix = nonEmptyString(
    group.commandPrefix,
    'groups[' + index + '].commandPrefix',
  );
  if (!COMMAND_PREFIX_PATTERN.test(commandPrefix)) {
    throw invalid('groups[' + index + '].commandPrefix must be one command token');
  }
  if (group.mentionMode !== 'command') {
    throw invalid('groups[' + index + '].mentionMode must be command');
  }
  if (group.allowSelf !== undefined && typeof group.allowSelf !== 'boolean') {
    throw invalid('groups[' + index + '].allowSelf must be boolean');
  }

  return {
    id,
    title,
    commandPrefix,
    mentionMode: 'command',
    allowSelf: group.allowSelf ?? false,
  };
}

/**
 * Load the optional account-scoped UIA configuration. Every validation error is
 * fatal: returning a partial group list could make the adapter read or send to
 * an ambiguous chat.
 */
export async function loadWechatGroupConfig(path) {
  if (typeof path !== 'string' || !path.trim()) {
    throw new TypeError('WeChat group config path must be a non-empty string');
  }

  let source;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  let value;
  try {
    value = JSON.parse(source);
  } catch (cause) {
    throw invalid('malformed JSON', { cause });
  }

  const root = plainObject(value, 'root');
  exactKeys(root, ROOT_KEYS, 'root');
  if (root.version !== 1) throw invalid('version must be 1');
  if (!Number.isSafeInteger(root.pollIntervalMs) || root.pollIntervalMs <= 0) {
    throw invalid('pollIntervalMs must be a positive integer');
  }
  if (!Array.isArray(root.groups) || root.groups.length === 0) {
    throw invalid('groups must be a non-empty array');
  }

  const groups = root.groups.map(normalizeGroup);
  const ids = new Set();
  const titles = new Set();
  for (const group of groups) {
    if (ids.has(group.id)) throw invalid('duplicate group id ' + group.id);
    if (titles.has(group.title)) throw invalid('duplicate group title');
    ids.add(group.id);
    titles.add(group.title);
  }

  return { pollIntervalMs: root.pollIntervalMs, groups };
}
