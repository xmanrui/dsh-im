// Shared by the Host and settings UI; keep this module browser-compatible.
export const ACCESS_POLICY_MODES = Object.freeze(['open', 'allowlist']);
export const ACCESS_POLICY_CONVERSATION_TYPES = Object.freeze(['direct', 'group']);
export const ACCESS_POLICY_USER_ID_MAX_LENGTH = 256;

const POLICY_KEYS = ['direct', 'group'];
const SCOPE_KEYS = ['mode', 'open', 'allowlist'];
const OPEN_KEYS = ['defaultCanExecuteCommands', 'commandPermissionOverrides', 'commandAllowlist'];
const OPEN_REQUIRED_KEYS = ['defaultCanExecuteCommands', 'commandPermissionOverrides'];
const ALLOWLIST_KEYS = ['users'];
const USER_KEYS = ['id', 'canExecuteCommands', 'commandAllowlist'];
const USER_REQUIRED_KEYS = ['id', 'canExecuteCommands'];
const COMMAND_ALLOWLIST_LIMIT = 100;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

function invalidAccessPolicy(message) {
  const error = new TypeError(message);
  error.code = 'access-policy-invalid';
  return error;
}

function hasExactKeys(input, keys) {
  return input && typeof input === 'object' && !Array.isArray(input)
    && [Object.prototype, null].includes(Object.getPrototypeOf(input))
    && Reflect.ownKeys(input).length === keys.length
    && keys.every((key) => Object.hasOwn(input, key));
}

/** Accept required keys plus a bounded set of optional keys. */
function hasAllowedKeys(input, required, optional = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return false;
  const keys = Reflect.ownKeys(input);
  return required.every((key) => Object.hasOwn(input, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

/**
 * Canonical command name: first token, optional leading slash, lower case.
 * `/sessionlist --limit 5` and `/SessionList` both become `sessionlist`.
 */
export function normalizeCommandName(value) {
  if (typeof value !== 'string') return null;
  const first = value.trim().split(/\s+/u)[0];
  if (!first) return null;
  const name = (first.startsWith('/') ? first.slice(1) : first).toLowerCase();
  return /^[a-z0-9][a-z0-9:_-]{0,63}$/u.test(name) ? name : null;
}

function validateCommandAllowlist(input, label) {
  if (input === undefined) return null;
  if (!Array.isArray(input)) throw invalidAccessPolicy(`${label}必须是命令名数组。`);
  if (input.length > COMMAND_ALLOWLIST_LIMIT) {
    throw invalidAccessPolicy(`${label}最多包含 ${COMMAND_ALLOWLIST_LIMIT} 个命令。`);
  }
  const names = input.map((value) => {
    const name = normalizeCommandName(value);
    if (!name) throw invalidAccessPolicy(`${label}包含无效命令名。`);
    return name;
  });
  return Object.freeze([...new Set(names)]);
}

/** Normalize one opaque channel identity without interpreting its contents. */
export function normalizeAccessPolicyUserId(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidAccessPolicy('用户标识无效。');
    value = String(value);
  } else if (typeof value === 'bigint') {
    value = String(value);
  }
  if (typeof value !== 'string') throw invalidAccessPolicy('用户标识必须是字符串。');
  const id = value.trim();
  if (!id || id.length > ACCESS_POLICY_USER_ID_MAX_LENGTH || CONTROL_CHARACTERS.test(id)) {
    throw invalidAccessPolicy(`用户标识不能为空、包含控制字符或超过 ${ACCESS_POLICY_USER_ID_MAX_LENGTH} 个字符。`);
  }
  return id;
}

function validateAccessPolicyUser(input) {
  if (!hasAllowedKeys(input, USER_REQUIRED_KEYS, USER_KEYS)) {
    throw invalidAccessPolicy('用户条目必须包含用户标识、命令权限和可选的命令白名单。');
  }
  if (typeof input.canExecuteCommands !== 'boolean') {
    throw invalidAccessPolicy('命令权限必须是布尔值。');
  }
  const commandAllowlist = validateCommandAllowlist(input.commandAllowlist, '用户命令白名单');
  return Object.freeze({
    id: normalizeAccessPolicyUserId(input.id),
    canExecuteCommands: input.canExecuteCommands,
    ...(commandAllowlist === null ? {} : { commandAllowlist }),
  });
}

function validateUsers(input, { listMessage, duplicateMessage }) {
  if (!Array.isArray(input)) throw invalidAccessPolicy(listMessage);
  const users = input.map(validateAccessPolicyUser);
  if (new Set(users.map(({ id }) => id)).size !== users.length) {
    throw invalidAccessPolicy(duplicateMessage);
  }
  return Object.freeze(users);
}

function validateOpenSettings(input) {
  if (!hasAllowedKeys(input, OPEN_REQUIRED_KEYS, OPEN_KEYS)) {
    throw invalidAccessPolicy('开放模式设置必须完整（可选的 commandAllowlist 除外）。');
  }
  if (typeof input.defaultCanExecuteCommands !== 'boolean') {
    throw invalidAccessPolicy('开放模式默认命令权限必须是布尔值。');
  }
  return Object.freeze({
    defaultCanExecuteCommands: input.defaultCanExecuteCommands,
    commandPermissionOverrides: validateUsers(input.commandPermissionOverrides, {
      listMessage: '开放模式命令权限覆盖用户必须是数组。',
      duplicateMessage: '开放模式命令权限覆盖用户不能包含重复的用户标识。',
    }),
    ...(input.commandAllowlist === undefined
      ? {}
      : { commandAllowlist: validateCommandAllowlist(input.commandAllowlist, '开放模式命令白名单') }),
  });
}

function validateAllowlistSettings(input) {
  if (!hasExactKeys(input, ALLOWLIST_KEYS)) {
    throw invalidAccessPolicy('白名单模式设置必须完整。');
  }
  return Object.freeze({
    users: validateUsers(input.users, {
      listMessage: '白名单模式用户必须是数组。',
      duplicateMessage: '白名单模式用户不能包含重复的用户标识。',
    }),
  });
}

function validateAccessPolicyScope(input) {
  if (!hasExactKeys(input, SCOPE_KEYS)) {
    throw invalidAccessPolicy('访问场景设置必须同时包含模式、开放模式设置和白名单模式设置。');
  }
  if (!ACCESS_POLICY_MODES.includes(input.mode)) {
    throw invalidAccessPolicy('访问模式只能是 open 或 allowlist。');
  }
  return Object.freeze({
    mode: input.mode,
    open: validateOpenSettings(input.open),
    allowlist: validateAllowlistSettings(input.allowlist),
  });
}

/** Validate one canonical direct + group atomic save. */
export function validateAccessPolicy(input) {
  if (!hasExactKeys(input, POLICY_KEYS)) {
    throw invalidAccessPolicy('请同时提交完整的私聊和群聊访问设置。');
  }
  return Object.freeze({
    direct: validateAccessPolicyScope(input.direct),
    group: validateAccessPolicyScope(input.group),
  });
}

/** Normalize canonical persisted/runtime data; damaged settings fail closed. */
export function normalizeAccessPolicy(input) {
  try {
    return validateAccessPolicy(input);
  } catch {
    return null;
  }
}

/** Small canonical constructor used by channel initialization. */
export function createAccessPolicyScope(options) {
  return validateAccessPolicyScope(options === undefined ? {
    mode: 'allowlist',
    open: {
      defaultCanExecuteCommands: false,
      commandPermissionOverrides: [],
    },
    allowlist: { users: [] },
  } : options);
}

const DENY_SCOPE = createAccessPolicyScope();

export const DEFAULT_ACCESS_POLICY = Object.freeze({
  direct: DENY_SCOPE,
  group: DENY_SCOPE,
});

export const DENY_ALL_ACCESS_POLICY = DEFAULT_ACCESS_POLICY;

export function createAccessPolicy({
  direct = DEFAULT_ACCESS_POLICY.direct,
  group = DEFAULT_ACCESS_POLICY.group,
} = {}) {
  return validateAccessPolicy({ direct, group });
}

const ALLOWED = Object.freeze({ allowed: true, reason: 'allowed' });
const POLICY_UNAVAILABLE = Object.freeze({ allowed: false, reason: 'policy-unavailable' });
const INVALID_CONTEXT = Object.freeze({ allowed: false, reason: 'invalid-context' });
const SENDER_UNAVAILABLE = Object.freeze({ allowed: false, reason: 'sender-unavailable' });
const SENDER_NOT_ALLOWED = Object.freeze({ allowed: false, reason: 'sender-not-allowed' });
const COMMAND_NOT_ALLOWED = Object.freeze({ allowed: false, reason: 'command-not-allowed' });

/**
 * Decide access for one ordinary message or one already-recognized command.
 * `senderIds` accepts multiple identities so WhatsApp can reuse its JID aliases.
 * Privileged/owner bypass is intentionally handled by the inbound adapter.
 */
export function evaluateAccessPolicy(policy, {
  conversationType,
  senderIds,
  isCommand = false,
  command = null,
  equals = (left, right) => left === right,
} = {}) {
  const normalizedPolicy = normalizeAccessPolicy(policy);
  if (!normalizedPolicy) return POLICY_UNAVAILABLE;
  if (!ACCESS_POLICY_CONVERSATION_TYPES.includes(conversationType)
    || typeof isCommand !== 'boolean' || typeof equals !== 'function') {
    return INVALID_CONTEXT;
  }
  const normalizedCommand = normalizeCommandName(command);
  const candidates = (Array.isArray(senderIds) ? senderIds : [senderIds])
    .flatMap((candidate) => {
      try {
        return [normalizeAccessPolicyUserId(candidate)];
      } catch {
        return [];
      }
    });
  if (candidates.length === 0) return SENDER_UNAVAILABLE;

  const scope = normalizedPolicy[conversationType];
  const users = scope.mode === 'open'
    ? scope.open.commandPermissionOverrides
    : scope.allowlist.users;
  let matchedUsers;
  try {
    matchedUsers = users.filter((user) => (
      candidates.some((candidate) => equals(candidate, user.id) === true)
    ));
  } catch {
    return INVALID_CONTEXT;
  }
  if (scope.mode === 'allowlist' && matchedUsers.length === 0) return SENDER_NOT_ALLOWED;
  if (isCommand) {
    const canExecuteCommands = scope.mode === 'open'
      ? (matchedUsers.length > 0
        ? matchedUsers.every((user) => user.canExecuteCommands)
        : scope.open.defaultCanExecuteCommands)
      : matchedUsers.every((user) => user.canExecuteCommands);
    if (!canExecuteCommands) {
      const scopeAllowsCommand = scope.mode === 'open'
        && normalizedCommand !== null
        && (scope.open.commandAllowlist ?? []).includes(normalizedCommand);
      const usersAllowCommand = matchedUsers.length > 0
        && normalizedCommand !== null
        && matchedUsers.every((user) => user.commandAllowlist?.includes(normalizedCommand) === true);
      if (!scopeAllowsCommand && !usersAllowCommand) return COMMAND_NOT_ALLOWED;
    }
  }
  return ALLOWED;
}
