import { t } from './i18n.mjs';
import {
  deleteInboundAttachments,
  listInboundAttachments,
} from './inbound-file.mjs';

const ATTACHMENT_LIST_COMMAND = /^\/attachmentlist$/i;
const ATTACHMENT_DELETE_COMMAND = /^\/attachmentdelete(?:[ \t]+([\s\S]+))?$/i;
const MAX_DISPLAY_PATH_LENGTH = 4_096;
const UNSAFE_DISPLAY_TEXT_GLOBAL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

function commandResult(message, messages = [message]) {
  return { handled: true, message, messages };
}

function formatSize(sizeBytes) {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = sizeBytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(value) : value.toFixed(1);
  return `${text} ${units[unit]}`;
}

function formatTime(mtimeMs) {
  const date = new Date(mtimeMs);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function safeDisplayName(value) {
  return String(value ?? '')
    .replace(UNSAFE_DISPLAY_TEXT_GLOBAL, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 255);
}

function currentWorkspacePath(harness) {
  if (typeof harness?.currentWorkspace !== 'function') return null;
  const workspace = harness.currentWorkspace();
  return typeof workspace === 'string'
    && workspace
    && workspace.length <= MAX_DISPLAY_PATH_LENGTH
      ? workspace
      : null;
}

export function isAttachmentCommand(text) {
  if (typeof text !== 'string') return false;
  const command = text.trim();
  return ATTACHMENT_LIST_COMMAND.test(command)
    || ATTACHMENT_DELETE_COMMAND.test(command);
}

export async function runAttachmentCommand(text, harness) {
  if (!isAttachmentCommand(text)) return null;
  const command = text.trim();

  if (ATTACHMENT_LIST_COMMAND.test(command)) {
    const workspace = currentWorkspacePath(harness);
    if (!workspace) {
      return commandResult(t('当前机器人暂不支持列出附件。'));
    }
    const attachments = await listInboundAttachments(workspace);
    if (attachments.length === 0) {
      return commandResult(t('附件目录为空。'));
    }
    const lines = [
      t('入站附件（{count}）：', { count: attachments.length }),
      ...attachments.map((attachment, index) => `${index + 1}. ${safeDisplayName(attachment.name)}`
        + ` (${formatSize(attachment.sizeBytes)}, ${formatTime(attachment.mtimeMs)})`
        + (attachment.temporary ? t(' [临时残留]') : '')),
      '',
      t('删除用法：/attachmentdelete 序号；/attachmentdelete all 清空附件目录。'),
    ];
    return commandResult(lines.join('\n'), [lines.join('\n')]);
  }

  const match = ATTACHMENT_DELETE_COMMAND.exec(command);
  const argument = match?.[1]?.trim() ?? '';
  const workspace = currentWorkspacePath(harness);
  if (!workspace) {
    return commandResult(t('当前机器人暂不支持删除附件。'));
  }

  if (/^all$/iu.test(argument)) {
    return commandResult(t(
      '将清空整个附件目录（.dsh-im/inbound）。请再发送一次 /attachmentdelete all confirm 确认执行。',
    ));
  }
  if (/^all confirm$/iu.test(argument)) {
    await deleteInboundAttachments(workspace, 'all');
    return commandResult(t('已清空附件目录。'));
  }

  if (/^\d+$/.test(argument)) {
    const attachments = await listInboundAttachments(workspace);
    const position = Number(argument);
    if (position < 1 || position > attachments.length) {
      return commandResult(t('附件序号不存在，请先执行 /attachmentlist。'));
    }
    const target = attachments[position - 1];
    await deleteInboundAttachments(workspace, [target.path]);
    return commandResult(t('已删除附件：{name}', { name: safeDisplayName(target.name) }));
  }

  return commandResult(t('用法：/attachmentdelete 序号 删除单个附件；/attachmentdelete all confirm 清空附件目录。'));
}
