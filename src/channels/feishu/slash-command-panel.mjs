/**
 * The Feishu "/" command panel of one bot: which commands it offers and in
 * which order.
 *
 * The panel is stored server-side per Feishu app and is NOT pushed by
 * dsh/Harness, so dsh-im holds a manifest and registers it through
 * `slash-command-registry.mjs`. This module owns that manifest plus the per-bot
 * configuration that narrows and orders it.
 *
 * Reference (official):
 *   https://open.feishu.cn/document/mcp_open_tools/agent-best-practices/agent-supports-slash-commands
 */

/**
 * Icon keys are the documented values in the Feishu Slash Command doc.
 */
export const DEFAULT_SLASH_COMMAND_ICON = 'ai-agent_outlined';

/**
 * The dsh-im Feishu command manifest. Every entry's `command` is registered
 * WITHOUT the leading slash; Feishu displays it as "/<command>" in the panel
 * and sends "/<command>" back as text, which matches the bridge's regexes.
 *
 * Descriptions should stay short and match what the command actually does in
 * bridge.mjs / the shared command modules.
 */
export const SLASH_COMMAND_MANIFEST = Object.freeze([
  { command: 'menu', icon: 'skill_outlined', default: '打开功能菜单', en_us: 'Open the feature menu' },
  { command: 'new', icon: 'ai-deepthink_outlined', default: '开启全新会话', en_us: 'Start a fresh session' },
  { command: 'help', icon: 'promptword_outlined', default: '查看帮助', en_us: 'Show help' },
  { command: 'status', icon: 'ai-functions_outlined', default: '查看机器人状态', en_us: 'Show bot status' },
  { command: 'compact', icon: 'ai-block_outlined', default: '压缩当前会话上下文', en_us: 'Compact the current session' },
  { command: 'sessionlist', icon: 'chat-ai_outlined', default: '列出会话', en_us: 'List sessions' },
  { command: 'workspacelist', icon: 'folder_outlined', default: '列出工作区', en_us: 'List workspaces' },
  { command: 'workspaces', icon: 'folder_outlined', default: '列出工作区', en_us: 'List workspaces' },
  { command: 'wsl', icon: 'folder_outlined', default: '列出工作区', en_us: 'List workspaces' },
  { command: 'ws', icon: 'folder_outlined', default: '切换工作区', en_us: 'Switch workspace' },
  { command: 'watch', icon: 'flag_outlined', default: '关注一个会话', en_us: 'Watch a session' },
  { command: 'unwatch', icon: 'clear_outlined', default: '取消关注会话', en_us: 'Unwatch a session' },
  { command: 'watchlist', icon: 'flag_outlined', default: '查看关注列表', en_us: 'List watched sessions' },
  { command: 'archived', icon: 'folder_outlined', default: '设置归档会话显隐（on/off）', en_us: 'Show or hide archived sessions (on/off)' },
  { command: 'history', icon: 'chat-ai_outlined', default: '查看最近历史消息（仅私聊）', en_us: 'Show recent history (private chats only)' },
  { command: 'workspace', icon: 'folder_outlined', default: '切换工作区', en_us: 'Switch workspace' },
  { command: 'conv', icon: 'folder_outlined', default: '设置当前对话专属工作区', en_us: 'Set the workspace for this conversation' },
  { command: 'session', icon: 'chat-ai_outlined', default: '绑定已有会话', en_us: 'Bind an existing session' },
  { command: 'models', icon: 'ai-functions_outlined', default: '列出可用模型', en_us: 'List available models' },
  { command: 'model', icon: 'ai-agent_outlined', default: '查看或切换当前模型', en_us: 'Show or switch the current model' },
  { command: 'reasoninglist', icon: 'ai-deepthink_outlined', default: '列出可用推理等级', en_us: 'List available reasoning efforts' },
  { command: 'reasoning', icon: 'ai-deepthink_outlined', default: '查看或切换推理等级', en_us: 'Show or switch the reasoning effort' },
  { command: 'presetlist', icon: 'skill_outlined', default: '列出可用 Agent 预设', en_us: 'List available Agent Presets' },
  { command: 'preset', icon: 'skill_outlined', default: '查看或切换 Agent 预设', en_us: 'Show or switch the Agent Preset' },
  { command: 'stop', icon: 'clear_outlined', default: '停止当前任务', en_us: 'Stop the current task' },
  { command: 'steer', icon: 'promptword_outlined', default: '给当前任务补充指令', en_us: 'Send additional instructions to the current task' },
  { command: 'batch', icon: 'chat-ai_outlined', default: '开始批量输入（仅私聊）', en_us: 'Start batch input (private chats only)' },
  { command: 'send', icon: 'chat-ai_outlined', default: '提交当前批次（仅私聊）', en_us: 'Submit the current batch (private chats only)' },
  { command: 'cancel', icon: 'clear_outlined', default: '取消当前批次（仅私聊）', en_us: 'Cancel the current batch (private chats only)' },
  { command: 'version', icon: 'ai-functions_outlined', default: '查看插件版本', en_us: 'Show the plugin version' },
  { command: 'repair', icon: 'ai-functions_outlined', default: '补全飞书权限与卡片回调（仅私聊）', en_us: 'Complete Feishu permissions and card callbacks (private chats only)' },
]);

/**
 * How the "/" panel of one bot is built.
 *
 * - `default` follows the shipped manifest: every command is registered, in the
 *   manifest's own order, and nothing already registered is removed. This is
 *   what every bot did before the panel became configurable.
 * - `custom` follows `order`: exactly those commands, in that order. Commands
 *   from the manifest that are not listed are removed from the app, and the
 *   panel is rebuilt when its order no longer matches — Feishu returns the
 *   panel in creation order, so holding a chosen order means recreating the
 *   commands.
 *
 * Hidden is not the same as disabled: the panel only decides what the input box
 * offers, and a command removed from it still works when typed.
 */
export const SLASH_PANEL_MODES = Object.freeze({
  DEFAULT: 'default',
  CUSTOM: 'custom',
});

export const DEFAULT_SLASH_PANEL_CONFIG = Object.freeze({
  mode: SLASH_PANEL_MODES.DEFAULT,
  order: Object.freeze([]),
});

/** A bot may pin at most this many commands; the shipped manifest is smaller. */
export const MAX_SLASH_PANEL_COMMANDS = 100;

/** Command names as the API and the stored config spell them (no leading "/"). */
function normalizeCommandName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/^\//u, '').toLowerCase();
  return name || null;
}

function manifestHas(name) {
  return SLASH_COMMAND_MANIFEST.some((entry) => entry.command === name);
}

/**
 * Normalize a stored panel config, dropping anything the code cannot serve: an
 * unknown name would put a dead command in the panel, and a duplicate would
 * register twice. Never throws — a damaged value falls back to the default.
 */
export function normalizeSlashPanelConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_SLASH_PANEL_CONFIG;
  }
  if (value.mode !== SLASH_PANEL_MODES.CUSTOM) return DEFAULT_SLASH_PANEL_CONFIG;
  const order = [];
  const seen = new Set();
  for (const candidate of Array.isArray(value.order) ? value.order : []) {
    const name = normalizeCommandName(candidate);
    if (!name || seen.has(name) || !manifestHas(name)) continue;
    seen.add(name);
    order.push(name);
    if (order.length >= MAX_SLASH_PANEL_COMMANDS) break;
  }
  return Object.freeze({ mode: SLASH_PANEL_MODES.CUSTOM, order: Object.freeze(order) });
}

/**
 * Strict counterpart of `normalizeSlashPanelConfig` for RPC payloads: a caller
 * has to send exactly what it means, and damaged input is reported instead of
 * being silently rewritten into a different panel.
 */
export function isSlashPanelConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('mode') || !keys.includes('order')) return false;
  if (!Array.isArray(value.order) || value.order.length > MAX_SLASH_PANEL_COMMANDS) return false;
  // Following the shipped manifest carries no list of its own: the manifest is
  // the list, and it moves with the plugin version.
  if (value.mode === SLASH_PANEL_MODES.DEFAULT) return value.order.length === 0;
  if (value.mode !== SLASH_PANEL_MODES.CUSTOM) return false;
  if (new Set(value.order).size !== value.order.length) return false;
  return value.order.every((entry) => normalizeCommandName(entry) === entry
    && manifestHas(entry));
}

/** Whether the config asks the panel to be exactly its `order`. */
export function isCustomSlashPanel(config) {
  return normalizeSlashPanelConfig(config).mode === SLASH_PANEL_MODES.CUSTOM;
}

/**
 * The manifest entries a bot should offer, in panel order. `default` returns the
 * shipped manifest untouched, so an upgrade never reshapes an existing bot.
 */
export function resolveSlashPanelManifest(config, manifest = SLASH_COMMAND_MANIFEST) {
  const normalized = normalizeSlashPanelConfig(config);
  if (normalized.mode !== SLASH_PANEL_MODES.CUSTOM) return manifest;
  const byName = new Map(manifest.map((entry) => [entry.command, entry]));
  return normalized.order.map((name) => byName.get(name)).filter(Boolean);
}
