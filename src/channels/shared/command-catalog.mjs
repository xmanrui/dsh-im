import { t } from './i18n.mjs';

const TEXT_CHANNELS = Object.freeze(['telegram', 'slack', 'discord', 'whatsapp']);

function defineCatalogCommand(name, description, help, { aliases = [], ...options } = {}) {
  return Object.freeze({
    name,
    description,
    channels: TEXT_CHANNELS,
    menuVisible: true,
    ...options,
    aliases: Object.freeze(aliases.map((alias) => Object.freeze({
      menuVisible: true,
      ...(typeof alias === 'string' ? { name: alias } : alias),
    }))),
    help: Object.freeze(help),
  });
}

// Presentation metadata for TextHarnessBridge commands, in help order.
// Keep each command's aliases, short description and full usage together here.
// Handlers still own parsing and authorization; privateOnly is descriptive.
// enabled: false removes a definition from both consumers; menuVisible: false
// hides a command (or alias) only from the native menu, leaving help available.
export const SHARED_COMMAND_CATALOG = Object.freeze([
  defineCatalogCommand('new', '开启一个全新会话', [
    '/new  开启一个全新会话',
  ]),
  defineCatalogCommand('compact', '压缩当前会话的较早上下文', [
    '/compact  压缩当前会话的较早上下文',
  ]),
  defineCatalogCommand('history', '查看最近历史消息（仅私聊）', [
    '/history [数量]  查看最近历史消息（默认 3 条，最多 5 条）',
  ], { privateOnly: true }),
  defineCatalogCommand('workspace', '切换工作区', [
    '/workspace 工作区序号或绝对路径  切换工作区',
  ], { aliases: ['ws'] }),
  defineCatalogCommand('workspacelist', '列出工作区绝对路径', [
    '/workspacelist  列出工作区绝对路径',
    '/ws、/wsl、/workspaces  工作区命令别名',
  ], { aliases: ['workspaces', 'wsl'] }),
  defineCatalogCommand('guidance', '查看或设置增强提示词', [
    '/guidance [提示词 | --clear]  查看或设置当前聊天的增强提示词',
  ], { aliases: ['prompt'] }),
  defineCatalogCommand('sessionlist', '列出会话 ID 和标题', [
    '/sessionlist 或 /sessions [工作区序号或绝对路径]  列出会话 ID 和标题',
    '/sessionlist --limit N  仅列出当前工作区前 N 个会话',
  ], { aliases: ['sessions'] }),
  defineCatalogCommand('session', '将当前聊天绑定到指定会话', [
    '/session Session ID 或当前工作区序号  将当前聊天绑定到指定会话',
  ]),
  defineCatalogCommand('models', '按序号列出所有可用模型', [
    '/models  按序号列出所有可用模型',
  ]),
  defineCatalogCommand('reasoninglist', '按序号列出当前模型可用推理等级', [
    '/reasoninglist 或 /reasonings  按序号列出当前模型可用推理等级',
  ], { aliases: ['reasonings'] }),
  defineCatalogCommand('reasoning', '查看或切换当前推理等级', [
    '/reasoning [序号、等级ID或 --default]  查看或切换当前推理等级',
  ]),
  defineCatalogCommand('model', '查看或切换当前会话模型', [
    '/model [序号或完整模型ID] [推理等级ID]  查看或切换当前会话模型',
    '示例：先发 /models，再发 /model 2 [推理等级ID]',
  ]),
  defineCatalogCommand('presetlist', '列出可用 Agent Preset', [
    '/presetlist 或 /presets  按序号列出可用 Agent Preset',
  ], { aliases: ['presets'] }),
  defineCatalogCommand('preset', '查看或设置新会话 Agent Preset', [
    '/preset [序号或完整ID]  查看或设置当前机器人 Agent Preset',
    '纯数字 ID：/preset id:<ID>',
    '/preset --default  跟随 Host 默认',
  ]),
  defineCatalogCommand('stop', '停止当前任务', [
    '/stop  停止当前任务',
  ]),
  defineCatalogCommand('steer', '纠偏当前任务', [
    '/steer 补充指令  纠偏当前任务',
  ]),
  defineCatalogCommand('batch', '开始批量输入（仅私聊）', [
    '/batch  开始批量输入（仅私聊，最多 10 条文字）',
  ], { privateOnly: true }),
  defineCatalogCommand('send', '提交当前批次', [
    '/send  提交当前批次',
  ], { privateOnly: true }),
  defineCatalogCommand('cancel', '取消当前批次', [
    '/cancel  取消当前批次',
  ], { privateOnly: true }),
  defineCatalogCommand('status', '检查连接状态', [
    '/status  检查连接状态',
  ]),
  defineCatalogCommand('version', '查看插件版本', [
    '/version  查看插件版本',
  ]),
  defineCatalogCommand('help', '显示帮助', [
    '/help  显示本帮助',
  ]),
]);

export function commandsForChannel(channel, catalog = SHARED_COMMAND_CATALOG) {
  return catalog.filter((item) => item.enabled !== false && item.channels.includes(channel));
}

export function commandHelpLines(channel, catalog = SHARED_COMMAND_CATALOG) {
  return commandsForChannel(channel, catalog).flatMap((item) => item.help.map((line) => t(line)));
}
