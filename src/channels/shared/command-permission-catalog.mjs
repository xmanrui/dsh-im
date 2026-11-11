// Browser-safe command permission catalog shared by the Host access policy and
// the settings UI. Keep this module free of Node built-ins: the client bundle
// imports it to render the per-command picker.
//
// A permission entry is a stable command id (the primary command name without
// the slash). All accepted aliases resolve to that id, so granting `/ws` and
// `/workspace` is one decision, not two.

const COMMAND_PERMISSION_GROUPS_INPUT = [
  {
    id: 'session',
    label: '会话管理',
    commands: [
      { id: 'new', aliases: ['new'] },
      { id: 'fork', aliases: ['fork'] },
      { id: 'reset', aliases: ['reset'] },
      { id: 'compact', aliases: ['compact'] },
      { id: 'clear', aliases: ['clear'] },
      { id: 'history', aliases: ['history'] },
      { id: 'ls', aliases: ['ls', 'list'] },
      { id: 'go', aliases: ['go'] },
      { id: 'prev', aliases: ['prev'] },
      { id: 'next', aliases: ['next'] },
      { id: 'drop', aliases: ['drop'] },
      { id: 'title', aliases: ['title'] },
      { id: 'tail', aliases: ['tail', 'peek'] },
      { id: 'session', aliases: ['session', 'sess'] },
      { id: 'sessionlist', aliases: ['sessionlist', 'sessions'] },
      { id: 'sessionarchive', aliases: ['sessionarchive', 'sessarchive'] },
    ],
  },
  {
    id: 'workspace',
    label: '工作区',
    commands: [
      { id: 'workspace', aliases: ['workspace', 'ws'] },
      { id: 'workspacelist', aliases: ['workspacelist', 'workspaces', 'wsl'] },
      { id: 'conv', aliases: ['conv', 'conversation', 'thread'] },
    ],
  },
  {
    id: 'model',
    label: '模型与推理',
    commands: [
      { id: 'models', aliases: ['models'] },
      { id: 'model', aliases: ['model'] },
      { id: 'reasoninglist', aliases: ['reasoninglist', 'reasonings'] },
      { id: 'reasoning', aliases: ['reasoning'] },
    ],
  },
  {
    id: 'preset',
    label: '预设与权限',
    commands: [
      { id: 'presetlist', aliases: ['presetlist', 'presets'] },
      { id: 'preset', aliases: ['preset'] },
      { id: 'permissionlist', aliases: ['permissionlist'] },
      { id: 'permission', aliases: ['permission'] },
    ],
  },
  {
    id: 'control',
    label: '任务控制',
    commands: [
      { id: 'stop', aliases: ['stop'] },
      { id: 'steer', aliases: ['steer'] },
      { id: 'plan', aliases: ['plan'] },
      { id: 'goal', aliases: ['goal'] },
    ],
  },
  {
    id: 'input',
    label: '批量输入',
    commands: [
      { id: 'batch', aliases: ['batch'] },
      { id: 'send', aliases: ['send'] },
      { id: 'cancel', aliases: ['cancel'] },
    ],
  },
  {
    id: 'info',
    label: '信息',
    commands: [
      { id: 'help', aliases: ['help'] },
      { id: 'status', aliases: ['status'] },
      { id: 'version', aliases: ['version'] },
    ],
  },
  {
    id: 'channel',
    label: '渠道命令',
    commands: [
      { id: 'menu', aliases: ['menu', 'm'] },
      { id: 'repair', aliases: ['repair'] },
      { id: 'watch', aliases: ['watch'] },
      { id: 'unwatch', aliases: ['unwatch'] },
      { id: 'watchlist', aliases: ['watchlist'] },
      { id: 'archived', aliases: ['archived'] },
    ],
  },
];

export const COMMAND_PERMISSION_GROUPS = Object.freeze(
  COMMAND_PERMISSION_GROUPS_INPUT.map((group) => Object.freeze({
    id: group.id,
    label: group.label,
    commands: Object.freeze(group.commands.map((command) => Object.freeze({
      id: command.id,
      aliases: Object.freeze([...command.aliases]),
    }))),
  })),
);

export const COMMAND_PERMISSION_IDS = Object.freeze(
  COMMAND_PERMISSION_GROUPS.flatMap((group) => group.commands.map((command) => command.id)),
);

export const COMMAND_PERMISSION_MAX_LIST = 128;
export const COMMAND_PERMISSION_ID_MAX_LENGTH = 64;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const COMMAND_TOKEN = /^\/([a-z][a-z0-9_-]*)/iu;
const COMMAND_ID_PATTERN = /^[a-z][a-z0-9_-]*$/u;

const ALIAS_TO_ID = new Map();
for (const group of COMMAND_PERMISSION_GROUPS) {
  for (const command of group.commands) {
    for (const alias of command.aliases) ALIAS_TO_ID.set(alias.toLowerCase(), command.id);
  }
}

function invalidCommandPermission(message) {
  const error = new TypeError(message);
  error.code = 'access-policy-invalid';
  return error;
}

/** Resolve the first slash token of an already-recognized command to its id. */
export function resolveCommandPermissionId(text) {
  if (typeof text !== 'string') return null;
  const match = COMMAND_TOKEN.exec(text.trim());
  if (!match) return null;
  return ALIAS_TO_ID.get(match[1].toLowerCase()) ?? null;
}

/**
 * Validate one command allowlist. Unknown ids are rejected so a typo cannot
 * silently deny commands forever, and duplicates/empty values are rejected
 * rather than silently cleaned.
 */
export function normalizeAllowedCommands(value) {
  if (!Array.isArray(value)) {
    throw invalidCommandPermission('命令权限必须是命令标识数组。');
  }
  if (value.length > COMMAND_PERMISSION_MAX_LIST) {
    throw invalidCommandPermission(`命令权限最多包含 ${COMMAND_PERMISSION_MAX_LIST} 个命令。`);
  }
  const seen = new Set();
  const commands = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw invalidCommandPermission('命令标识必须是字符串。');
    }
    const id = entry.trim();
    if (!id || id.length > COMMAND_PERMISSION_ID_MAX_LENGTH
      || CONTROL_CHARACTERS.test(id) || !COMMAND_ID_PATTERN.test(id)) {
      throw invalidCommandPermission(
        `命令标识不能为空、包含控制字符、超过 ${COMMAND_PERMISSION_ID_MAX_LENGTH} 个字符或包含非法字符。`,
      );
    }
    if (!COMMAND_PERMISSION_IDS.includes(id)) {
      throw invalidCommandPermission(`未知的命令标识：${id}。`);
    }
    if (seen.has(id)) {
      throw invalidCommandPermission('命令权限不能包含重复的命令标识。');
    }
    seen.add(id);
    commands.push(id);
  }
  return Object.freeze(commands);
}

/** Whether an id is one of the catalog commands. */
export function isCommandPermissionId(value) {
  return typeof value === 'string' && COMMAND_PERMISSION_IDS.includes(value);
}
