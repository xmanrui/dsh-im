import { isSessionNotFound } from './session-error.mjs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { t } from './i18n.mjs';
import { WORKSPACE_SESSION_STALE } from './workspace-session.mjs';

const WORKSPACE_COMMAND = /^\/(?:workspace|ws)(?:\s+([\s\S]+))?$/i;
const WORKSPACE_LIST_COMMAND = /^\/(?:workspacelist|workspaces|wsl)(?:\s+([\s\S]+))?$/i;
const THREAD_WORKSPACE_COMMAND = /^\/(?:conv|conversation|thread)(?:\s+([\s\S]+))?$/i;
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
  '不带工作区参数时，默认列出当前对话的有效工作区（未设置对话专属工作区时即 bot 默认工作区）。',
].join('\n');

function commandResult(message, messages = [message], extra = {}) {
  return { handled: true, message, messages, ...extra };
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

async function existingWorkspacePath(value) {
  const workspace = normalizedWorkspacePath(value);
  if (!workspace) return null;
  try {
    if (!(await stat(workspace)).isDirectory()) return null;
    return normalizedWorkspacePath(await realpath(workspace));
  } catch {
    return null;
  }
}

async function existingWorkspacePaths(values) {
  const checked = await Promise.all(values.map(existingWorkspacePath));
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

export async function workspacePathSnapshot(harness, { includeTitles = false, includeConversationDirectories = false, conversationKey, ...options } = {}) {
  const withEntries = includeTitles && typeof harness.listWorkspaceEntries === 'function';
  const listed = await (withEntries ? harness.listWorkspaceEntries(options) : harness.listWorkspaces(options));
  const currentValue = await conversationSessionWorkspace(harness, conversationKey, options);
  const current = await existingWorkspacePath(currentValue);
  const entries = await Promise.all((Array.isArray(listed) ? listed : []).map(async (item) => ({
    path: await existingWorkspacePath(withEntries ? item?.path : item),
    title: withEntries ? safeDisplayText(item?.title) : '',
  })));
  const directoryPaths = new Set(harness.conversationDirectoryPaths?.() ?? []);
  const paths = [...new Set([...(current ? [current] : []), ...entries.map((item) => item.path).filter(Boolean)])]
    .filter((path) => includeConversationDirectories || path === current || !directoryPaths.has(path));
  const titles = {};
  if (includeTitles) {
    for (const item of entries) {
      if (item.path && item.title && !titles[item.path]) titles[item.path] = item.title;
    }
  }
  harness.assertWorkspaceScope?.();
  return { current: current ?? null, paths, ...(includeTitles ? { titles } : {}) };
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

/**
 * The shared listing behind /ws, /workspace, /wsl, /workspaces and
 * /workspacelist. Text stays byte-compatible with the pre-merge list so a
 * channel without an interactive picker keeps exactly what it always showed;
 * `listing` is the machine-readable half a channel may render as a picker.
 */
async function workspaceListingCommand(harness, { includeConversationDirectories = false } = {}) {
  if (typeof harness?.listWorkspaces !== 'function') {
    return commandResult(t('当前机器人暂不支持列出工作区。'));
  }
  try {
    const { current, paths, titles } = await workspacePathSnapshot(harness, {
      includeTitles: true, includeConversationDirectories,
    });
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
      t('对话专属：/conv 工作区序号或绝对路径（仅影响当前对话）'),
      t('查看会话：/sessionlist 工作区序号或绝对路径'),
      t('不带工作区参数时，/sessionlist 默认列出当前对话的有效工作区。'),
    ];
    const message = lines.join('\n');
    return commandResult(message, splitWorkspaceCommandMessage(message), {
      listing: { current: current ?? null, paths, titles: titles ?? {} },
    });
  } catch (error) {
    if (error?.code === 'workspace-bot-not-found') {
      return commandResult(t('机器人正在移除或已重新接入，无法列出原会话的工作区。'));
    }
    return commandResult(t('暂时无法获取工作区列表，请稍后重试。'));
  }
}

async function runWorkspaceListCommand(match, harness) {
  const includeConversationDirectories = match[1]?.trim().toLowerCase() === 'all';
  if (match[1]?.trim() && !includeConversationDirectories) return commandResult(t('用法：/workspacelist'));
  return workspaceListingCommand(harness, { includeConversationDirectories });
}

export async function conversationSessionWorkspace(harness, conversationKey, options = {}) {
  if (typeof conversationKey === 'string' && conversationKey) {
    if (typeof harness?.resolveConversationWorkspace === 'function') {
      return harness.resolveConversationWorkspace(conversationKey, options);
    }
    if (typeof harness?.currentConversationWorkspace === 'function') {
      return harness.currentConversationWorkspace(conversationKey);
    }
  }
  return harness?.currentWorkspace?.() ?? null;
}

async function conversationEffectiveWorkspace(harness, conversationKey, options) {
  if (typeof conversationKey !== 'string' || !conversationKey) return null;
  const [current] = await existingWorkspacePaths([await conversationSessionWorkspace(harness, conversationKey, options)]);
  harness.assertWorkspaceScope?.();
  return current ?? null;
}

export async function resolveSessionListWorkspace(selector, harness, options = {}) {
  if (!selector) {
    // With no explicit selector the listing follows the conversation's effective
    // workspace, so /conv B makes /sessionlist list B instead of the bot default.
    if (options.conversationKey) {
      const effective = await conversationEffectiveWorkspace(harness, options.conversationKey, options);
      if (effective) return { workspace: effective };
    }
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
    // Explicit workspace numbers must keep the bot-wide /workspacelist order;
    // only a missing selector follows the bound conversation's actual group.
    const { paths } = await workspacePathSnapshot(harness, { ...options, conversationKey: undefined });
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

/**
 * The machine-readable half of one session list, for channels that render the
 * listing as a picker. It carries only what a button needs (title, short id
 * source, archived/summary flags), never the display text — that stays the
 * byte-compatible `sessionListMessage` below.
 */
function sessionListingSnapshot(workspace, sessions) {
  // Archived sessions stay in the byte-compatible text list (with the
  // 「已归档」 marker) but never become picker buttons: a picker exists to bind a
  // live Session, and hiding retired rows keeps that list short and safe.
  const bindable = sessions.filter((session) => session?.archived !== true);
  return {
    workspace,
    // Cards never render archived rows; the count lets an adapter say "there are
    // sessions, but all of them are archived" instead of falling back to the
    // archived-bearing text list.
    archivedCount: sessions.length - bindable.length,
    sessions: bindable.map((session) => ({
      sessionId: safeDisplayText(session?.sessionId),
      title: safeDisplayText(session?.title),
      archived: false,
      summaryAvailable: session?.summaryAvailable !== false,
    })),
  };
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

async function currentSessionListWorkspace(harness, conversationKey) {
  const effective = await conversationEffectiveWorkspace(harness, conversationKey);
  if (effective) return effective;
  if (typeof harness?.currentWorkspace !== 'function') return null;
  const [current] = await existingWorkspacePaths([harness.currentWorkspace()]);
  harness.assertWorkspaceScope?.();
  return current ?? null;
}

async function runSessionListCommand(match, harness, conversationKey) {
  const request = parseSessionListArgument(match[1]);
  if (request.error) return commandResult(request.error);
  if (typeof harness?.listWorkspaceSessions !== 'function') {
    return commandResult(t('当前机器人暂不支持列出工作区会话。'));
  }
  try {
    const resolved = await resolveSessionListWorkspace(request.selector, harness, { conversationKey });
    if (resolved.error) return commandResult(resolved.error);
    const listed = await harness.listWorkspaceSessions(resolved.workspace);
    if (!listed || !Array.isArray(listed.sessions)) {
      throw new TypeError('Harness returned an invalid workspace session list');
    }
    harness.assertWorkspaceScope?.();
    const workspace = normalizedWorkspacePath(listed.workspace) ?? resolved.workspace;
    const currentWorkspace = await currentSessionListWorkspace(harness, conversationKey);
    const sessions = request.limit === null
      ? listed.sessions
      : listed.sessions.slice(0, request.limit);
    const message = sessionListMessage(workspace, sessions, {
      currentWorkspace: workspace === currentWorkspace,
    });
    // Only the bare list exposes a picker snapshot. A selector or --limit is a
    // one-off textual question, so its text reply stays the whole answer.
    const picker = request.selector === '' && request.limit === null
      ? { sessionListing: sessionListingSnapshot(workspace, sessions) }
      : {};
    return commandResult(message, splitWorkspaceCommandMessage(message), picker);
  } catch (error) {
    if (error?.code === 'workspace-bot-not-found') {
      return commandResult(t('机器人正在移除或已重新接入，无法列出原会话的工作区会话。'));
    }
    return commandResult(t('暂时无法获取工作区会话列表，请稍后重试。'));
  }
}

export function sessionBindErrorMessage(error) {
  if (error?.code === 'session-id-invalid') {
    return t(`Session ID 格式无效。
{usage}`, { usage: t(SESSION_BIND_USAGE) });
  }
  if (error?.code === 'session-not-registered' || isSessionNotFound(error?.code)) {
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
    // Use the same effective-workspace resolver as /sessionlist, so its indexes
    // cannot select a session from the bot default after /conv sets an override.
    if (typeof harness?.listWorkspaceSessions !== 'function'
      || (typeof harness?.currentWorkspace !== 'function'
        && typeof harness?.currentConversationWorkspace !== 'function')) {
      return commandResult(t('当前机器人暂不支持按序号绑定，请使用 /session Session ID。'));
    }
    try {
      const selected = await resolveSessionListWorkspace('', harness, { conversationKey });
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
    // The same receipt in machine-readable form, so a picker card can re-mark
    // the bound row and word its toast without parsing the text receipt.
    return commandResult(message, splitWorkspaceCommandMessage(message), {
      bound: {
        workspace,
        sessionId: boundSessionId,
        title: safeDisplayText(bound?.title),
        archived: bound?.archived === true,
      },
    });
  } catch (error) {
    return commandResult(sessionBindErrorMessage(error));
  }
}

async function runConversationWorkspaceCommand(command, harness, conversationKey) {
  if (typeof harness?.currentConversationWorkspace !== 'function') {
    return commandResult(t('当前机器人暂不支持按对话设置专属工作区。'));
  }
  if (typeof conversationKey !== 'string' || !conversationKey) {
    return commandResult(t('当前消息缺少可设置的对话上下文。'));
  }
  const argument = THREAD_WORKSPACE_COMMAND.exec(command)?.[1]?.trim() ?? '';
  if (!argument) {
    try {
      const current = harness.currentConversationWorkspace(conversationKey);
      harness.assertWorkspaceScope?.();
      const lines = [t('当前对话工作区：{workspace}', { workspace: current })];
      // 明确区分「显式绑定」与「回落 bot 默认」，否则用户无法判断之后改默认值会不会影响本对话。
      const bound = typeof harness?.hasConversationWorkspaceOverride === 'function'
        && harness.hasConversationWorkspaceOverride(conversationKey) === true;
      lines.push(bound
        ? t('状态：已为该对话显式绑定，之后修改 bot 默认工作区不会影响本对话。')
        : t('状态：未显式绑定，当前跟随 bot 默认工作区。'));
      // 顺带列出可切换的工作区，省得先跑一次 /workspacelist 再回来切。
      let conversationListing = null;
      try {
        const { paths } = await workspacePathSnapshot(harness);
        if (paths.length > 0) {
          lines.push('', t('可切换的工作区（{count}）：', { count: paths.length }));
          for (const [index, workspace] of paths.entries()) {
            lines.push(`${index + 1}. ${workspace}${workspace === current ? t('（当前）') : ''}`);
          }
        }
        // `conversationWorkspaceListing` is the machine-readable half a channel may
        // render as a picker; the text above stays authoritative and byte-stable.
        conversationListing = { current, bound, paths };
      } catch { /* 列表拿不到不影响主信息 */ }
      lines.push('', t('用法：/conv 工作区序号或绝对路径'), t('清除：/conv clear'));
      const message = lines.join('\n');
      return commandResult(message, splitWorkspaceCommandMessage(message), {
        ...(conversationListing ? { conversationWorkspaceListing: conversationListing } : {}),
      });
    } catch (error) {
      if (error?.code === 'workspace-bot-not-found') {
        return commandResult(t('机器人正在移除或已重新接入，无法读取对话工作区。'));
      }
      return commandResult(t('暂时无法读取当前对话工作区，请稍后重试。'));
    }
  }
  if (/^(?:--default|clear)$/iu.test(argument)) {
    try {
      const current = await harness.clearConversationWorkspace(conversationKey);
      harness.assertWorkspaceScope?.();
      return commandResult(t('已清除对话专属工作区，当前使用 bot 默认工作区：{workspace}（之后默认工作区的变化会同步到本对话）', { workspace: current }));
    } catch (error) {
      if (error?.code === 'workspace-bot-not-found') {
        return commandResult(t('机器人正在移除或已重新接入，无法清除对话工作区。'));
      }
      return commandResult(t('暂时无法清除对话工作区，请稍后重试。'));
    }
  }
  if (typeof harness?.switchConversationWorkspace !== 'function') {
    return commandResult(t('当前机器人暂不支持设置对话工作区。'));
  }
  try {
    let selected = argument;
    if (/^\d+$/u.test(argument)) {
      // Match the ordering shown by /workspacelist, /ws and bare /conv.
      const { paths } = await workspacePathSnapshot(harness);
      const position = Number(argument);
      if (!Number.isSafeInteger(position) || position < 1 || position > paths.length) {
        return commandResult(t('工作区序号不存在，请先执行 /workspacelist。'));
      }
      selected = paths[position - 1];
    }
    const current = await harness.switchConversationWorkspace(conversationKey, selected);
    return commandResult(t('当前对话工作区已切换为：{workspace}', { workspace: current }));
  } catch (error) {
    if (['workspace-not-absolute', 'workspace-not-found', 'workspace-not-directory'].includes(error?.code)) {
      return commandResult(t(`{message}
用法：/conv 工作区绝对路径`, { message: error.message }));
    }
    if (error?.code === 'workspace-bot-not-found') {
      return commandResult(t('机器人正在移除或已重新接入，无法切换对话工作区。'));
    }
    throw error;
  }
}

/**
 * One failure mapping for every workspace-switch surface. The text command and
 * the Telegram picker card call the same switch, so their receipts must not
 * drift; returns null for errors this layer deliberately does not classify
 * (the caller decides whether to rethrow or degrade).
 */
export function workspaceSwitchFailureText(error) {
  if (['workspace-not-absolute', 'workspace-not-found', 'workspace-not-directory']
    .includes(error?.code)) {
    return t(`{message}
用法：/workspace 工作区序号或绝对路径`, { message: error.message });
  }
  if (error?.code === 'workspace-bot-not-found') {
    return t('机器人正在移除或已重新接入，无法切换原会话的工作区。');
  }
  return null;
}

export async function runWorkspaceCommand(text, harness, conversationKey) {
  if (!isWorkspaceCommand(text)) return null;
  const config = harness.conversationDirectoryConfig?.();
  if (config?.enabled === true && /^(?:\/(?:workspace|ws|conv|conversation|thread))(?:\s|$)/iu.test(text.trim())) {
    return { message: '', messages: [] };
  }
  const command = text.trim();
  const threadMatch = THREAD_WORKSPACE_COMMAND.exec(command);
  if (threadMatch) {
    return runConversationWorkspaceCommand(command, harness, conversationKey);
  }
  if (SESSION_BIND_PREFIX.test(command)) {
    return runSessionBindCommand(command, harness, conversationKey);
  }
  const sessionListMatch = SESSION_LIST_COMMAND.exec(command);
  if (sessionListMatch) return runSessionListCommand(sessionListMatch, harness, conversationKey);
  const listMatch = WORKSPACE_LIST_COMMAND.exec(command);
  if (listMatch) return runWorkspaceListCommand(listMatch, harness);
  const match = WORKSPACE_COMMAND.exec(command);
  if (!match) return null;
  const workspace = match[1]?.trim();
  // Merged command: no argument opens the same listing as /wsl, so a channel
  // with an inline keyboard can make the list itself the switcher.
  if (!workspace) return workspaceListingCommand(harness);
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
    const failure = workspaceSwitchFailureText(error);
    if (failure) return commandResult(failure);
    throw error;
  }
}

export function isWorkspaceCommand(text) {
  if (typeof text !== 'string') return false;
  const command = text.trim();
  return SESSION_BIND_PREFIX.test(command)
    || SESSION_LIST_COMMAND.test(command)
    || WORKSPACE_LIST_COMMAND.test(command)
    || WORKSPACE_COMMAND.test(command)
    || THREAD_WORKSPACE_COMMAND.test(command);
}
