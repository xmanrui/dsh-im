import { t } from './i18n.mjs';

const MENU_COMMAND = /^\/menu(?=$|\s)/iu;
const MENU_USAGE = '用法：/menu（不带参数）';

function commandResult(message) {
  return { handled: true, message, messages: [message] };
}

export function isMenuCommand(text) {
  if (typeof text !== 'string') return false;
  return MENU_COMMAND.test(text.trim());
}

/**
 * `/menu` on a channel that cannot render the hub card.
 *
 * The hub itself lives in the channel adapter (Telegram `menu-card.mjs`), because
 * only the channel knows which pickers it has. This text path is what every
 * other channel — and any refused card send — answers with, and it deliberately
 * lists the commands instead of pretending to be a menu.
 */
export async function runMenuCommand(text, _harness, _state, _conversationKey, options = {}) {
  if (!isMenuCommand(text)) return null;
  if (options.hasImages || options.hasFiles) {
    return commandResult(t('菜单命令仅支持纯文字，请移除图片或文件后重试。'));
  }
  if (text.trim() !== '/menu' && !/^\/menu[ \t]*$/iu.test(text.trim())) {
    return commandResult(t(MENU_USAGE));
  }
  return commandResult([
    t('菜单在当前渠道以文字方式提供：'),
    '/sessionlist  会话列表',
    '/ws  切换工作区',
    '/models  切换模型',
    '/reasoninglist  切换推理等级',
    '/presetlist  切换 Agent Preset',
    '/status  查看连接状态',
    '/help  全部命令',
  ].join('\n'));
}
