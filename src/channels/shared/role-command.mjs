import {
  normalizeAgentPresetCatalog,
  normalizeAgentPresetId,
} from './agent-preset.mjs';
import { t } from './i18n.mjs';
import { withSessionBindingLock } from './session-binding-lock.mjs';
import { splitWorkspaceCommandMessage } from './workspace-command.mjs';

const ROLE_LIST_COMMAND = /^\/roles(?=$|\s)/iu;
const ROLE_COMMAND = /^\/role(?=$|\s)/iu;
const ROLE_USAGE = [
  '用法：',
  '/roles  列出可用角色（Agent Preset）与当前聊天角色',
  '/role  查看当前聊天角色',
  '/role <ID>  将当前聊天设置为指定角色',
  '/role --default  清除当前聊天角色，回退机器人默认',
].join('\n');

const UNSAFE_DISPLAY_TEXT_GLOBAL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

function commandResult(message) {
  return {
    handled: true,
    message,
    messages: splitWorkspaceCommandMessage(message),
  };
}

function safeDisplayText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(UNSAFE_DISPLAY_TEXT_GLOBAL, ' ').replace(/\s+/gu, ' ').trim();
}

function rpcOptions(signal) {
  return signal ? { signal } : {};
}

function normalizeSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !value.agentPresetCatalog || typeof value.agentPresetCatalog !== 'object'
    || !Array.isArray(value.agentPresetCatalog.items)) {
    throw new TypeError('Harness returned invalid Agent Preset settings');
  }
  const agentPreset = value.agentPreset === null
    ? null
    : normalizeAgentPresetId(value.agentPreset);
  if (value.agentPreset !== null && agentPreset === null) {
    throw new TypeError('Harness returned an invalid current Agent Preset');
  }
  return {
    agentPreset,
    agentPresetCatalog: normalizeAgentPresetCatalog(value.agentPresetCatalog),
  };
}

async function settings(harness, options) {
  if (typeof harness?.agentPresetSettings !== 'function') {
    throw new TypeError('Harness does not support Agent Preset settings');
  }
  return normalizeSettings(await harness.agentPresetSettings(options));
}

function itemFor(catalog, id) {
  return catalog.items.find((item) => item.id === id) ?? null;
}

function presetItemText(item) {
  const label = safeDisplayText(item.label) || item.id;
  return t('{label}（{id}）', { label, id: item.id });
}

function describePreset(catalog, id) {
  if (!id) return t('跟随机器人默认');
  const item = itemFor(catalog, id);
  return item ? presetItemText(item) : t('{id}（当前不可用）', { id });
}

function botDefaultDescription(catalog) {
  if (!catalog.defaultId) return t('未设置或当前不可用');
  const item = itemFor(catalog, catalog.defaultId);
  return item
    ? presetItemText(item)
    : t('{id}（当前不可用）', { id: catalog.defaultId });
}

function formatCurrent(chosen, catalog) {
  return [
    t('当前聊天角色：{preset}', { preset: describePreset(catalog, chosen) }),
    '',
    t('机器人默认：{preset}', { preset: botDefaultDescription(catalog) }),
    t('查看可用角色：/roles'),
    t('清除当前聊天角色：/role --default'),
  ].join('\n');
}

function formatList(chosen, catalog, available) {
  const lines = [
    t('当前聊天角色：{preset}', { preset: describePreset(catalog, chosen) }),
    t('机器人默认：{preset}', { preset: botDefaultDescription(catalog) }),
    '',
    t('可用角色（Agent Preset，{count}）：', { count: available.length }),
  ];
  if (available.length === 0) {
    lines.push(t('当前没有可用 Agent Preset。'));
  } else {
    available.forEach((item, index) => {
      const markers = [];
      if (item.id === chosen) markers.push(t('当前聊天'));
      if (item.id === catalog.defaultId) markers.push(t('Host 默认'));
      const annotation = markers.length > 0 ? `（${markers.join('，')}）` : '';
      lines.push(`${index + 1}. ${presetItemText(item)}${annotation}`);
    });
  }
  lines.push(
    '',
    t('选择：/role <序号或 ID>'),
    t('清除当前聊天角色：/role --default'),
  );
  return lines.join('\n');
}

function formatUpdated(chosen, catalog, cleared = false) {
  return [
    cleared
      ? t('已清除当前聊天角色，回退机器人默认。')
      : t('当前聊天角色已设置为：{preset}', { preset: describePreset(catalog, chosen) }),
    '',
    t('仅影响当前聊天；其他聊天与机器人默认不变。'),
    t('若当前聊天已有会话，请先发送 /new，再发送普通消息，才会使用新角色创建会话。'),
  ].join('\n');
}

function unavailableRole() {
  const error = new Error('Agent Preset 不存在或不可用。');
  error.code = 'agent-preset-unavailable';
  return error;
}

function roleErrorMessage(error, action) {
  const code = error?.code ?? error?.failure?.code;
  if (code === 'agent-preset-invalid') {
    return t(`Agent Preset ID 格式无效。
{usage}`, { usage: t(ROLE_USAGE) });
  }
  if (code === 'agent-preset-unavailable') {
    return t('该角色不存在或当前不可用，请重新执行 /roles。');
  }
  if (code === 'workspace-bot-not-found' || code === 'workspace-session-stale') {
    return t('工作区或机器人状态已发生变化，请重试。');
  }
  if (code === 'cancelled' || error?.name === 'AbortError') {
    if (action === 'list') return t('获取角色列表已取消。');
    if (action === 'current') return t('获取当前角色已取消。');
    return t('角色修改已取消。');
  }
  if (action === 'list') return t('暂时无法获取角色列表，请稍后重试。');
  if (action === 'current') return t('暂时无法获取当前角色，请稍后重试。');
  return t('角色修改失败，请稍后重试。');
}

export function isRoleCommand(text) {
  if (typeof text !== 'string') return false;
  const command = text.trim();
  return ROLE_LIST_COMMAND.test(command) || ROLE_COMMAND.test(command);
}

/**
 * Handle /roles and /role. `options` must carry a `roleStore`
 * (ConversationRoleStore) plus an `agentPresetCatalog` resolver or harness
 * that supports `agentPresetSettings`.
 */
export async function runRoleCommand(text, harness, state, key, options = {}) {
  if (!isRoleCommand(text)) return null;
  const command = text.trim();
  if (options.hasImages) {
    return commandResult(t('角色命令仅支持纯文字，请移除图片后重试。'));
  }
  const roleStore = options.roleStore;
  if (!roleStore || typeof roleStore.overrideFor !== 'function') {
    return commandResult(t('当前机器人未启用角色功能。'));
  }
  const requestOptions = rpcOptions(options.signal);

  async function currentSettings() {
    return typeof options.agentPresetCatalog === 'function'
      ? {
          agentPreset: roleStore.overrideFor(
            options.botId,
            key,
          ),
          agentPresetCatalog: normalizeAgentPresetCatalog(
            await options.agentPresetCatalog({ signal: options.signal }),
          ),
        }
      : settings(harness, requestOptions);
  }

  if (ROLE_LIST_COMMAND.test(command)) {
    if (!/^\/roles[ \t]*$/iu.test(command)) return commandResult(t(ROLE_USAGE));
    try {
      const current = await currentSettings();
      const chosen = roleStore.overrideFor(options.botId, key);
      return commandResult(formatList(chosen, current.agentPresetCatalog, current.agentPresetCatalog.items));
    } catch (error) {
      return commandResult(roleErrorMessage(error, 'list'));
    }
  }

  const match = /^\/role(?:[ \t]+([^\s]+))?[ \t]*$/iu.exec(command);
  if (!match) return commandResult(t(ROLE_USAGE));
  const requested = match[1];

  if (!requested) {
    try {
      const current = await currentSettings();
      const chosen = roleStore.overrideFor(options.botId, key);
      return commandResult(formatCurrent(chosen, current.agentPresetCatalog));
    } catch (error) {
      return commandResult(roleErrorMessage(error, 'current'));
    }
  }

  let selected;
  let cleared = false;
  if (requested.toLowerCase() === '--default') {
    selected = null;
    cleared = true;
  } else {
    const explicitNumericId = /^id:(\d+)$/iu.exec(requested);
    if (explicitNumericId) {
      selected = explicitNumericId[1];
    } else {
      selected = normalizeAgentPresetId(requested);
      if (!selected) return commandResult(t(`Agent Preset ID 格式无效。
{usage}`, { usage: t(ROLE_USAGE) }));
    }
  }

  try {
    return await withSessionBindingLock(state, key, async () => {
      let catalogForUpdate;
      if (selected) {
        const current = await currentSettings();
        catalogForUpdate = current.agentPresetCatalog;
        if (!catalogForUpdate.items.some((item) => item.id === selected)) {
          throw unavailableRole();
        }
      }
      const nextSelected = await roleStore.setOverride(options.botId, key, selected);
      const finalCatalog = catalogForUpdate ?? (await currentSettings()).agentPresetCatalog;
      return commandResult(formatUpdated(nextSelected, finalCatalog, cleared));
    });
  } catch (error) {
    return commandResult(roleErrorMessage(error, 'update'));
  }
}
