import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { t } from './i18n.mjs';
import { WORKSPACE_SESSION_STALE } from './workspace-session.mjs';
import {
  isAttachmentCommand,
  runAttachmentCommand,
} from './attachment-command.mjs';

const WORKSPACE_COMMAND = /^\/(?:workspace|ws)(?:\s+([\s\S]+))?$/i;
const WORKSPACE_LIST_COMMAND = /^\/(?:workspacelist|workspaces|wsl)(?:\s+([\s\S]+))?$/i;
const SESSION_LIST_COMMAND = /^\/(?:sessionlist|sessions)(?:\s+([\s\S]+))?$/i;
const SESSION_BIND_PREFIX = /^\/session(?=$|\s)/i;
const SESSION_BIND_COMMAND = /^\/session[ \t]+([^\s]+)$/i;
const MAX_WORKSPACE_PATH_LENGTH = 4_096;
const MAX_COMMAND_MESSAGE_LENGTH = 1_800;
const MAX_SESSION_ID_LENGTH = 256;
const UNSAFE_DISPLAY_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const UNSAFE_DISPLAY_TEXT_GLOBAL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
const SESSION_BIND_USAGE = '用法：/session Session ID 或当前工作区序号（/session N）';
const SESSION_LIST_USAGE = [
  '用法：',
  '/sessionlist  列出当前工作区会话',
  '/sessionlist --limit N  列出当前工作区前 N 个会话（N 为正整数）',
  '/sessionlist 工作区序号  按 /workspacelist 序号列出会话',
  '/sessionlist 工作区绝对路径  列出指定工作区会话',
].join('\n');

function commandResult(message, messages = [message]) {
  return { handled: true, message, messages };
}

function normalizedWorkspacePath(value) {
  if (typeof value !== 'string' || value.length > MAX_WORKSPACE_PATH_LENGTH
    || !isAbsolute(value) || UNSAFE_DISPLAY_TEXT.test(value)) return null;
  return resolve(value);
}

function safeDisplayText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(UNSAFE_DISPLAY_TEXT_GLOBAL, ' ').replace(/\s+/gu, ' ').trim();
}

function validSessionId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_SESSION_ID_LENGTH
    && !/\p{White_Space}/u.test(value)
    && !UNSAFE_DISPLAY_TEXT.test(value);
}

export function parseSessionListArgument(value) {
  const argument = typeof value === 'string' ? value.trim() : '';
  if (!argument) return { selector: '', limit: null };
  if (!argument.toLowerCase().startsWith('--limit')) {
    return { selector: argument, limit: null };
  }
  const match = /^--limit[ \t]+(\d+)$/iu.exec(argument);
  const limit = match ? Number(match[1]) : null;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return { error: t(SESSION_LIST_USAGE) };
  }
  return { selector: '', limit };
}

async function existingWorkspacePaths(values) {
  const checked = await Promise.all(values.map(async (value) => {
    const workspace = normalizedWorkspacePath(value);
    if (!workspace) return null;
    try {
      if (!(await stat(workspace)).isDirectory()) return null;
      return normalizedWorkspacePath(await realpath(workspace));
    } catch {
      return null;
    }
  }));
  return [...new Set(checked.filter(Boolean))];
}

async function selectedWorkspacePath(value) {
  if (typeof value !== 'string' || !isAbsolute(value.trim())) {
    return { error: t(`工作区必须是绝对路径。
{usage}`, { usage: t(SESSION_LIST_USAGE) }) };
  }
  const workspace = normalizedWorkspacePath(value.trim());
  if (!workspace) {
    return { error: t(`工作区路径包含不支持的字符或长度超过限制。
{usage}`, { usage: t(SESSION_LIST_USAGE) }) };
  }
  let info;
  try {
    info = await stat(workspace);
  } catch {
    return { error: t(`工作区路径不存在。
{usage}`, { usage: t(SESSION_LIST_USAGE) }) };
  }
  if (!info.isDirectory()) {
    return { error: t(`工作区路径必须指向一个目录。
{usage}`, { usage: t(SESSION_LIST_USAGE) }) };
  }
  try {
    const canonical = normalizedWorkspacePath(await realpath(workspace));
    return canonical
      ? { workspace: canonical }
      : { error: t(`工作区路径包含不支持的字符或长度超过限制。
{usage}`, { usage: t(SESSION_LIST_USAGE) }) };
  } catch {
    return { error: t(`工作区路径不存在。
{usage}`, { usage: t(SESSION_LIST_USAGE) }) };
  }
}

export async function workspacePathSnapshot(harness, options = {}) {
  const listed = await harness.listWorkspaces(options);
  const currentValue = typeof harness?.currentWorkspace === 'function'
    ? harness.currentWorkspace()
    : null;
  const [current] = currentValue ? await existingWorkspacePaths([currentValue]) : [];
  const registered = await existingWorkspacePaths(Array.isArray(listed) ? listed : []);
  const paths = [...new Set([...(current ? [current] : []), ...registered])];
  harness.assertWorkspaceScope?.();
  return { current: current ?? null, paths };
}

export function splitWorkspaceCommandMessage(message) {
  const messages = [];
  let offset = 0;
  while (offset < message.length) {
    let end = Math.min(offset + MAX_COMMAND_MESSAGE_LENGTH, message.length);
    if (end < message.length) {
      const lineBreak = message.lastIndexOf('\n', end - 1);
      if (lineBreak >= offset) {
        end = lineBreak + 1;
      } else {
        const trailing = message.charCodeAt(end - 1);
        const leading = message.charCodeAt(end);
        if (trailing >= 0xd800 && trailing <= 0xdbff
          && leading >= 0xdc00 && leading <= 0xdfff) end -= 1;
      }
    }
    messages.push(message.slice(offset, end));
    offset = end;
  }
  return messages;
}

async function runWorkspaceListCommand(match, harness) {
  if (match[1]?.trim()) return commandResult(t('用法：/workspacelist'));
  if (typeof harness?.listWorkspaces !== 'function') {
    return commandResult(t('当前机器人暂不支持列出工作区。'));
  }
  try {
    const { current, paths } = await workspacePathSnapshot(harness);
    if (paths.length === 0) {
      return commandResult(t('当前 Harness Host 上没有仍然存在的已登记工作区。'));
    }
    const lines = [
      t('当前 Harness Host 上存在的工作区（{count}）：', { count: paths.length }),
      ...paths.map((workspace, index) => (
        `${index + 1}. ${workspace}${workspace === current ? t('（当前）') : ''}`
      )),
      '',
      t('切换用法：/workspace 工作区序号或绝对路径'),
      t('查看会话：/sessionlist 工作区序号或绝对路径'),
    ];
    const message = lines.join('\n');
    return commandResult(message, splitWorkspaceCommandMessage(message));
  } catch (error) {
    if (error?.code === 'workspace-bot-not-found') {
      return commandResult(t('机器人正在移除或已重新接入，无法列出原会话的工作区。'));
    }
    return commandResult(t('暂时无法获取工作区列表，请稍后重试。'));
  }
}

export async function resolveSessionListWorkspace(selector, harness, options = {}) {
  if (!selector) {
    if (typeof harness?.currentWorkspace !== 'function') {
      return { error: t('当前机器人没有可用的工作区。') };
    }
    const selected = await selectedWorkspacePath(harness.currentWorkspace());
    harness.assertWorkspaceScope?.();
    return selected;
  }

  if (/^\d+$/u.test(selector)) {
    if (typeof harness?.listWorkspaces !== 'function') {
      return { error: t('当前机器人暂不支持按序号选择工作区。') };
    }
    const { paths } = await workspacePathSnapshot(harness, options);
    const position = Number(selector);
    if (!Number.isSafeInteger(position) || position < 1 || position > paths.length) {
      return { error: t('工作区序号不存在，请先执行 /workspacelist。') };
    }
    return { workspace: paths[position - 1] };
  }

  const selected = await selectedWorkspacePath(selector);
  harness.assertWorkspaceScope?.();
  return selected;
}

function formatSessionRelativeTime(value) {
  const ms = typeof value === 'number' && Number.isFinite(value) ? value : null;
  if (ms === null) return '';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const now = new Date();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (dayDiff === 0) return t('今天 {time}', { time: hm });
  if (dayDiff === 1) return t('昨天 {time}', { time: hm });
  if (dayDiff === 2) return t('前天 {time}', { time: hm });
  if (date.getFullYear() === now.getFullYear()) {
    return t('{month}月{day}日 {time}', { month: date.getMonth() + 1, day: date.getDate(), time: hm });
  }
  return t('{year}年{month}月{day}日', { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() });
}

function sessionListMessage(workspace, sessions, { currentWorkspace = false } = {}) {
  const rows = sessions.map((session) => {
    const sessionId = safeDisplayText(session?.sessionId);
    if (!sessionId) throw new TypeError('Harness returned an invalid session id');
    const title = session?.summaryAvailable === false
      ? t('标题暂不可用')
      : safeDisplayText(session?.title) || t('暂无标题');
    const timeText = formatSessionRelativeTime(session?.time);
    const annotation = `${timeText ? ` · ${timeText}` : ''}${session?.archived === true ? t('（已归档）') : ''}`;
    return `${title}${annotation}\n   ID: ${sessionId}`;
  });
  if (rows.length === 0) return t(`工作区：{workspace}
该工作区暂无会话。`, { workspace });
  return [
    t('工作区：{workspace}', { workspace }),
    t('会话（{count}）：', { count: rows.length }),
    '',
    ...rows.map((row, index) => `${index + 1}. ${row}`),
    '',
    currentWorkspace
      ? t('绑定用法：/session Session ID 或当前工作区序号（/session N）')
      : t(`绑定用法：/session Session ID
提示：/session N 只按机器人当前工作区的序号绑定。`),
  ].join('\n');
}

async function currentSessionListWorkspace(harness) {
  if (typeof harness?.currentWorkspace !== 'function') return null;
  const [current] = await existingWorkspacePaths([harness.currentWorkspace()]);
  harness.assertWorkspaceScope?.();
  return current ?? null;
}

async function runSessionListCommand(match, harness) {
  const request = parseSessionListArgument(match[1]);
  if (request.error) return commandResult(request.error);
  if (typeof harness?.listWorkspaceSessions !== 'function') {
    return commandResult(t('当前机器人暂不支持列出工作区会话。'));
  }
  try {
    const resolved = await resolveSessionListWorkspace(request.selector, harness);
    if (resolved.error) return commandResult(resolved.error);
    const listed = await harness.listWorkspaceSessions(resolved.workspace);
    if (!listed || !Array.isArray(listed.sessions)) {
      throw new TypeError('Harness returned an invalid workspace session list');
    }
    harness.assertWorkspaceScope?.();
    const workspace = normalizedWorkspacePath(listed.workspace) ?? resolved.workspace;
    const currentWorkspace = await currentSessionListWorkspace(harness);
    const sessions = request.limit === null
      ? listed.sessions
      : listed.sessions.slice(0, request.limit);
    const message = sessionListMessage(workspace, sessions, {
      currentWorkspace: workspace === currentWorkspace,
    });
    return commandResult(message, splitWorkspaceCommandMessage(message));
  } catch (error) {
    if (error?.code === 'workspace-bot-not-found') {
      return commandResult(t('机器人正在移除或已重新接入，无法列出原会话的工作区会话。'));
    }
    return commandResult(t('暂时无法获取工作区会话列表，请稍后重试。'));
  }
}

function sessionBindErrorMessage(error) {
  if (error?.code === 'session-id-invalid') {
    return t(`Session ID 格式无效。
{usage}`, { usage: t(SESSION_BIND_USAGE) });
  }
  if (['session-not-registered', 'session-not-found'].includes(error?.code)) {
    return t('未找到该会话，请先执行 /sessionlist 确认 Session ID。');
  }
  if (error?.code === 'session-subagent-unsupported') {
    return t('子代理会话不能绑定到机器人对话，请选择普通会话。');
  }
  if (error?.code === 'session-workspace-ambiguous') {
    return t('该会话的工作区归属不明确，暂时无法绑定。');
  }
  if (error?.code === 'session-summary-unavailable') {
    return t('暂时无法读取该会话的信息，请稍后重试。');
  }
  if (error?.code === 'workspace-bot-not-found') {
    return t('机器人正在移除或已重新接入，无法绑定原对话的会话。');
  }
  if ([WORKSPACE_SESSION_STALE, 'agent-busy', 'session-conflict', 'workspace-conflict']
    .includes(error?.code)) {
    return t('工作区或会话状态已发生变化，请重试。');
  }
  return t('暂时无法绑定会话，请稍后重试。');
}

async function runSessionBindCommand(command, harness, conversationKey) {
  const match = SESSION_BIND_COMMAND.exec(command);
  let sessionId = match?.[1];
  if (typeof sessionId === 'string' && /^\d+$/u.test(sessionId)) {
    // 序号模式：把 /session N 解析成当前工作区会话列表中的第 N 个会话
    if (typeof harness?.listWorkspaceSessions !== 'function'
      || typeof harness?.currentWorkspace !== 'function') {
      return commandResult(t('当前机器人暂不支持按序号绑定，请使用 /session Session ID。'));
    }
    try {
      const selected = await selectedWorkspacePath(harness.currentWorkspace());
      if (selected.error) return commandResult(selected.error);
      const listed = await harness.listWorkspaceSessions(selected.workspace);
      if (!listed || !Array.isArray(listed.sessions)) {
        throw new TypeError('Harness returned an invalid workspace session list');
      }
      harness.assertWorkspaceScope?.();
      const position = Number(sessionId);
      if (!Number.isSafeInteger(position) || position < 1
        || position > listed.sessions.length) {
        return commandResult(t('会话序号不存在，请先执行 /sessionlist 查看序号。'));
      }
      const selectedSessionId = listed.sessions[position - 1]?.sessionId;
      if (!validSessionId(selectedSessionId)) {
        throw new TypeError('Harness returned an invalid session id');
      }
      sessionId = selectedSessionId;
    } catch (error) {
      if (error?.code === 'workspace-bot-not-found') {
        return commandResult(sessionBindErrorMessage(error));
      }
      return commandResult(t('暂时无法获取会话列表，请稍后重试。'));
    }
  }
  if (!validSessionId(sessionId)) return commandResult(t(SESSION_BIND_USAGE));
  if (typeof harness?.bindWorkspaceSession !== 'function') {
    return commandResult(t('当前机器人暂不支持绑定已有会话。'));
  }
  if (typeof conversationKey !== 'string' || !conversationKey) {
    return commandResult(t('当前消息缺少可绑定的会话上下文。'));
  }
  try {
    const bound = await harness.bindWorkspaceSession(conversationKey, sessionId);
    harness.assertWorkspaceScope?.();
    const workspace = normalizedWorkspacePath(bound?.workspace);
    const boundSessionId = safeDisplayText(bound?.sessionId);
    if (!workspace || !boundSessionId) {
      throw new TypeError('Harness returned an invalid bound session');
    }
    const title = safeDisplayText(bound?.title) || t('暂无标题');
    const message = [
      t('当前聊天已绑定会话：'),
      t('工作区：{workspace}', { workspace }),
      t('标题：{title}', { title }),
      `ID：${boundSessionId}`,
      t('归档：{archived}', { archived: bound?.archived === true ? t('是') : t('否') }),
      t('发送 /history 查看最近对话。'),
    ].join('\n');
    return commandResult(message, splitWorkspaceCommandMessage(message));
  } catch (error) {
    return commandResult(sessionBindErrorMessage(error));
  }
}

export async function runWorkspaceCommand(text, harness, conversationKey) {
  const attachmentResult = await runAttachmentCommand(text, harness);
  if (attachmentResult) return attachmentResult;
  if (!isWorkspaceCommand(text)) return null;
  const command = text.trim();
  if (SESSION_BIND_PREFIX.test(command)) {
    return runSessionBindCommand(command, harness, conversationKey);
  }
  const sessionListMatch = SESSION_LIST_COMMAND.exec(command);
  if (sessionListMatch) return runSessionListCommand(sessionListMatch, harness);
  const listMatch = WORKSPACE_LIST_COMMAND.exec(command);
  if (listMatch) return runWorkspaceListCommand(listMatch, harness);
  const match = WORKSPACE_COMMAND.exec(command);
  if (!match) return null;
  const workspace = match[1]?.trim();
  if (!workspace) {
    return commandResult(t('用法：/workspace 工作区序号或绝对路径'));
  }
  if (typeof harness?.switchWorkspace !== 'function') {
    return commandResult(t('当前机器人暂不支持切换工作区。'));
  }
  try {
    let selected = workspace;
    if (/^\d+$/u.test(workspace)) {
      if (typeof harness?.listWorkspaces !== 'function') {
        return commandResult(t('当前机器人暂不支持按序号选择工作区。'));
      }
      const { paths } = await workspacePathSnapshot(harness);
      const position = Number(workspace);
      if (!Number.isSafeInteger(position) || position < 1 || position > paths.length) {
        return commandResult(t('工作区序号不存在，请先执行 /workspacelist。'));
      }
      selected = paths[position - 1];
    }
    const current = await harness.switchWorkspace(selected);
    return commandResult(t('工作区已切换为：{workspace}', { workspace: current }));
  } catch (error) {
    if (['workspace-not-absolute', 'workspace-not-found', 'workspace-not-directory'].includes(error?.code)) {
      return commandResult(t(`{message}
用法：/workspace 工作区序号或绝对路径`, { message: error.message }));
    }
    if (error?.code === 'workspace-bot-not-found') {
      return commandResult(t('机器人正在移除或已重新接入，无法切换原会话的工作区。'));
    }
    throw error;
  }
}

export function isWorkspaceCommand(text) {
  if (isAttachmentCommand(text)) return true;
  if (typeof text !== 'string') return false;
  const command = text.trim();
  return SESSION_BIND_PREFIX.test(command)
    || SESSION_LIST_COMMAND.test(command)
    || WORKSPACE_LIST_COMMAND.test(command)
    || WORKSPACE_COMMAND.test(command);
}
