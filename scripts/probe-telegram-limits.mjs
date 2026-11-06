#!/usr/bin/env node
/**
 * Probe the Telegram Bot API limits that batch-0 (native menu + /status) relies
 * on. Nothing here is fetched from the production bot by default:
 *
 *   node scripts/probe-telegram-limits.mjs
 *     Prints the documented facts, the local code guards and the live plan.
 *     Zero network calls, zero token reads.
 *
 *   TELEGRAM_PROBE_TOKEN=... TELEGRAM_PROBE_CHAT_ID=... \
 *     node scripts/probe-telegram-limits.mjs --live
 *     Sends a handful of temporary messages to that one chat, records what the
 *     platform accepts/rejects, then deletes every message it created. Use a
 *     dedicated probe bot/chat; the token is never printed.
 *
 *   ... --live --json   Machine-readable output for the evidence document.
 *
 * Optional: TELEGRAM_PROBE_THREAD_ID (forum topic), TELEGRAM_PROBE_BASE_URL
 * (defaults to https://api.telegram.org; a local mock server can be used).
 *
 * Facts still requiring a human: answerCallbackQuery has no documented hard
 * deadline, and a button press cannot be synthesised by a bot. That probe is
 * reported as 未实测 with its official documentation URL.
 */
import { Buffer } from 'node:buffer';
import process from 'node:process';

const DEFAULT_BASE_URL = 'https://api.telegram.org';
const LIVE_TIMEOUT_MS = 15_000;
const PROBE_TAG = '[dsh-im probe]';

const DOCUMENTED_FACTS = Object.freeze([
  {
    id: 'callback-data',
    claim: 'callback_data 必须是 1-64 字节（UTF-8 字节数，不是字符数）',
    source: 'https://core.telegram.org/bots/api#inlinekeyboardbutton',
  },
  {
    id: 'inline-keyboard',
    claim: 'inline_keyboard 是 InlineKeyboardButton 二维数组；官方未公布按钮数量上限',
    source: 'https://core.telegram.org/bots/api#inlinekeyboardmarkup',
  },
  {
    id: 'edit-with-markup',
    claim: 'editMessageText 支持同时传 text 与 reply_markup',
    source: 'https://core.telegram.org/bots/api#editmessagetext',
  },
  {
    id: 'answer-callback',
    claim: '用户按下按钮后客户端显示进度条，直到机器人调用 answerCallbackQuery；官方未公布超时秒数',
    source: 'https://core.telegram.org/bots/api#answercallbackquery',
  },
  {
    id: 'rate-limit',
    claim: '429 响应在 parameters.retry_after 里给出需要等待的秒数',
    source: 'https://core.telegram.org/bots/api#responseparameters',
  },
  {
    id: 'commands-limit',
    claim: 'setMyCommands 每个 scope 最多 100 条；命令名 [a-z0-9_]{1,32}；描述 1-256 字符',
    source: 'https://core.telegram.org/bots/api#setmycommands',
  },
  {
    id: 'command-scopes',
    claim: 'BotCommandScope 有 default / all_private_chats / all_group_chats / Chat / ChatAdministrators / ChatMember；更具体的 scope 覆盖 default',
    source: 'https://core.telegram.org/bots/api#botcommandscope',
  },
]);

const LOCAL_GUARDS = Object.freeze([
  'callback_data ≤ 64 字节（src/channels/telegram/telegram-api.mjs CALLBACK_DATA_MAX_BYTES）',
  '每条命令名 [a-z0-9_]{1,32}、描述 1-256 字符、每 scope ≤100 条（validateTelegramCommands）',
  '单条常规文本 ≤4096 字符（telegram-rich-message.mjs 切分常量）',
  '提问卡每行 1 个、上限 8 个按钮（telegram-bridge.mjs）',
  '工作区卡上限 20 个按钮只存在于 /ws 分支；合并 feat/tg-workspace-picker 后成立',
]);

const LIVE_PLAN = Object.freeze([
  '只读 getMyCommands 三个 scope：default / all_private_chats / all_group_chats 的条目数（验证默认 scope 已清空）',
  '发送临时消息，验证 callback_data 64/65 ASCII 字节与 63/66 UTF-8 字节的边界',
  '逐步增大单条消息的 inline_keyboard 按钮数量（8→200），记录平台首次拒绝的位置',
  '对同一条消息调用 editMessageText(text + reply_markup)，验证键盘能否与正文一次更新',
  '对同一条消息连续编辑 30 次，记录是否出现 429 以及 retry_after',
  '清理：删除本次探测创建的全部临时消息',
]);

function usage() {
  return [
    'Usage:',
    '  node scripts/probe-telegram-limits.mjs [--json] [--help]',
    '  TELEGRAM_PROBE_TOKEN=... TELEGRAM_PROBE_CHAT_ID=... \\',
    '    node scripts/probe-telegram-limits.mjs --live [--json]',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { live: false, json: false, help: false };
  for (const argument of argv) {
    if (argument === '--live') options.live = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function redact(value, token) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  if (token) text = text.split(token).join('[redacted]');
  return text;
}

function probeConfig() {
  const token = (process.env.TELEGRAM_PROBE_TOKEN ?? '').trim();
  if (!/^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new Error('TELEGRAM_PROBE_TOKEN is missing or not a bot token; refusing to guess.');
  }
  const chatIdText = (process.env.TELEGRAM_PROBE_CHAT_ID ?? '').trim();
  if (!/^-?\d+$/.test(chatIdText) || !Number.isSafeInteger(Number(chatIdText))) {
    throw new Error('TELEGRAM_PROBE_CHAT_ID must be an integer chat id.');
  }
  const threadText = (process.env.TELEGRAM_PROBE_THREAD_ID ?? '').trim();
  const messageThreadId = /^\d+$/.test(threadText) ? Number(threadText) : undefined;
  const baseUrl = (process.env.TELEGRAM_PROBE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  return { token, chatId: Number(chatIdText), messageThreadId, baseUrl };
}

function createClient({ token, baseUrl }) {
  async function call(method, payload = {}) {
    const url = `${baseUrl}/bot${token}/${method}`;
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
      });
    } catch (error) {
      return { ok: false, code: 'transport', description: redact(error?.message ?? error, token) };
    }
    let body;
    try {
      body = await response.json();
    } catch {
      return { ok: false, code: 'invalid-json', status: response.status, description: 'response was not JSON' };
    }
    if (!response.ok || body?.ok !== true) {
      return {
        ok: false,
        status: response.status,
        code: Number.isInteger(body?.error_code) ? body.error_code : 'api',
        description: redact(body?.description ?? `HTTP ${response.status}`, token),
        ...(Number.isFinite(Number(body?.parameters?.retry_after))
          ? { retryAfter: Number(body.parameters.retry_after) }
          : {}),
      };
    }
    return { ok: true, result: body.result };
  }
  return { call };
}

function probeMessage(text) {
  return `${PROBE_TAG} ${text}`;
}

async function cleanup(client, chatId, messageIds) {
  const failures = [];
  for (const messageId of messageIds) {
    const result = await client.call('deleteMessage', { chat_id: chatId, message_id: messageId });
    if (!result.ok) failures.push({ messageId, description: result.description });
  }
  return failures;
}

async function sendProbeMessage(client, chatId, messageThreadId, text, replyMarkup) {
  const result = await client.call('sendMessage', {
    chat_id: chatId,
    text,
    ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  return result;
}

function keyboardOf(callbackData) {
  return { inline_keyboard: [[{ text: 'probe', callback_data: callbackData }]] };
}

async function probeCommandScopes(client) {
  const scopes = [
    { scope: 'default', payload: {} },
    { scope: 'all_private_chats', payload: { scope: { type: 'all_private_chats' } } },
    { scope: 'all_group_chats', payload: { scope: { type: 'all_group_chats' } } },
  ];
  const results = [];
  for (const { scope, payload } of scopes) {
    const result = await client.call('getMyCommands', payload);
    results.push(result.ok
      ? {
          scope,
          entries: result.result.length,
          commands: result.result.map((item) => item.command),
        }
      : {
          scope,
          observed: 'failed',
          status: result.status ?? null,
          description: result.description ?? null,
        });
  }
  return results;
}

async function probeCallbackDataBoundary(client, ctx) {
  const size = (text) => Buffer.byteLength(text, 'utf8');
  const cases = [
    { label: '64 ASCII bytes', data: 'a'.repeat(64), expect: 'accepted' },
    { label: '65 ASCII bytes', data: 'a'.repeat(65), expect: 'rejected' },
    { label: '63 UTF-8 bytes (21 CJK chars)', data: '中'.repeat(21), expect: 'accepted' },
    { label: '66 UTF-8 bytes (22 CJK chars)', data: '中'.repeat(22), expect: 'rejected' },
  ];
  const results = [];
  for (const testCase of cases) {
    const result = await sendProbeMessage(
      client, ctx.chatId, ctx.messageThreadId,
      probeMessage(`callback_data ${testCase.label}`),
      keyboardOf(testCase.data),
    );
    if (result.ok) ctx.createdMessageIds.push(result.result.message_id);
    results.push({
      label: testCase.label,
      bytes: size(testCase.data),
      expected: testCase.expect,
      observed: result.ok ? 'accepted' : 'rejected',
      status: result.status ?? null,
      code: result.code ?? null,
      description: result.description ?? null,
      matchesExpectation: (testCase.expect === 'accepted') === result.ok,
    });
  }
  return results;
}

async function probeButtonCount(client, ctx) {
  const counts = [8, 20, 40, 60, 100, 200];
  const results = [];
  for (const count of counts) {
    const buttons = Array.from({ length: count }, (_, index) => ({
      text: `b${index}`,
      callback_data: `b${index}`,
    }));
    const result = await sendProbeMessage(
      client, ctx.chatId, ctx.messageThreadId,
      probeMessage(`${count} inline buttons`),
      { inline_keyboard: buttons.map((button) => [button]) },
    );
    if (result.ok) ctx.createdMessageIds.push(result.result.message_id);
    results.push({
      buttons: count,
      observed: result.ok ? 'accepted' : 'rejected',
      status: result.status ?? null,
      code: result.code ?? null,
      description: result.description ?? null,
    });
    if (!result.ok) break;
  }
  return results;
}

async function probeEditWithMarkup(client, ctx) {
  const sent = await sendProbeMessage(
    client, ctx.chatId, ctx.messageThreadId,
    probeMessage('editMessageText reply_markup probe'),
    keyboardOf('probe-open'),
  );
  if (!sent.ok) {
    return { observed: 'send failed', status: sent.status ?? null, description: sent.description ?? null };
  }
  const messageId = sent.result.message_id;
  ctx.createdMessageIds.push(messageId);
  const edited = await client.call('editMessageText', {
    chat_id: ctx.chatId,
    message_id: messageId,
    text: probeMessage('editMessageText updated text and keyboard'),
    reply_markup: keyboardOf('probe-edit'),
  });
  return {
    observed: edited.ok ? 'accepted (text + reply_markup in one call)' : 'rejected',
    status: edited.status ?? null,
    code: edited.code ?? null,
    description: edited.description ?? null,
  };
}

async function probeRateLimit(client, ctx) {
  const sent = await sendProbeMessage(
    client, ctx.chatId, ctx.messageThreadId,
    probeMessage('rate-limit probe'),
  );
  if (!sent.ok) {
    return { observed: 'send failed', status: sent.status ?? null, description: sent.description ?? null };
  }
  const messageId = sent.result.message_id;
  ctx.createdMessageIds.push(messageId);
  const attempts = 30;
  let limited = null;
  for (let index = 0; index < attempts; index += 1) {
    const result = await client.call('editMessageText', {
      chat_id: ctx.chatId,
      message_id: messageId,
      text: probeMessage(`rate-limit probe frame ${index + 1}/${attempts}`),
    });
    if (!result.ok && (result.code === 429 || result.status === 429)) {
      limited = { atAttempt: index + 1, retryAfter: result.retryAfter ?? null, description: result.description };
      break;
    }
  }
  return {
    attempts,
    observed: limited ? '429 observed' : 'no 429 within probe window',
    ...(limited ?? {}),
    note: limited
      ? 'retry_after 与官方文档一致时，发送方只需退避，不要重放旧帧'
      : '未触发限流不代表没有上限；编辑频率阈值未实测，方案中按官方文档与保守节流处理',
  };
}

async function runLive() {
  const config = probeConfig();
  const client = createClient(config);
  const ctx = {
    chatId: config.chatId,
    messageThreadId: config.messageThreadId,
    createdMessageIds: [],
  };
  const results = {
    mode: 'live',
    baseUrl: config.baseUrl,
    bot: null,
    probes: {},
    cleanup: null,
  };
  try {
    const me = await client.call('getMe');
    if (!me.ok) throw new Error(`getMe failed: ${me.description}`);
    results.bot = {
      id: String(me.result?.id ?? ''),
      username: me.result?.username ?? null,
      isBot: me.result?.is_bot === true,
    };
    results.probes.commandScopes = await probeCommandScopes(client);
    results.probes.callbackData = await probeCallbackDataBoundary(client, ctx);
    results.probes.buttonCount = await probeButtonCount(client, ctx);
    results.probes.editWithMarkup = await probeEditWithMarkup(client, ctx);
    results.probes.rateLimit = await probeRateLimit(client, ctx);
    results.probes.answerCallbackQuery = {
      observed: '未实测',
      reason: '需要真人按下按钮，机器人无法合成 callback_query',
      source: 'https://core.telegram.org/bots/api#answercallbackquery',
    };
  } finally {
    results.cleanup = await cleanup(client, ctx.chatId, ctx.createdMessageIds);
  }
  return results;
}

function printOffline(options) {
  if (options.json) {
    console.log(JSON.stringify({
      mode: 'offline',
      documentedFacts: DOCUMENTED_FACTS,
      localGuards: LOCAL_GUARDS,
      livePlan: LIVE_PLAN,
      note: '未发起任何网络请求；加 --live 且在环境变量里提供探测 bot token/chat 才会实测。',
    }, null, 2));
    return;
  }
  console.log('Telegram 平台限制探测（离线模式：未发起任何网络请求）\n');
  console.log('官方文档事实：');
  for (const fact of DOCUMENTED_FACTS) {
    console.log(`- [${fact.id}] ${fact.claim}`);
    console.log(`  来源：${fact.source}`);
  }
  console.log('\n仓内已强制的本地约束：');
  for (const guard of LOCAL_GUARDS) console.log(`- ${guard}`);
  console.log('\n真机实测计划（--live）：');
  for (const item of LIVE_PLAN) console.log(`- ${item}`);
  console.log('\n未实测项：answerCallbackQuery 的超时秒数（官方未公布，需真人按键）。');
  console.log('用法：TELEGRAM_PROBE_TOKEN=... TELEGRAM_PROBE_CHAT_ID=... node scripts/probe-telegram-limits.mjs --live');
}

function printLive(results, options) {
  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  console.log('Telegram 平台限制探测（真机）\n');
  console.log(`bot: ${results.bot?.username ?? '?'} (${results.bot?.id ?? '?'})`);
  const { commandScopes, callbackData, buttonCount, editWithMarkup, rateLimit, answerCallbackQuery } = results.probes;
  console.log('\ngetMyCommands（只读；default 应为 0，其余为当前注册条目数）：');
  for (const item of commandScopes) {
    console.log(`- ${item.scope}: ${item.observed === 'failed'
      ? `failed（${item.description}）`
      : `${item.entries} 条`}`);
  }
  console.log('\ncallback_data 字节边界：');
  for (const item of callbackData) {
    console.log(`- ${item.label}: ${item.observed}${item.description ? `（${item.description}）` : ''}`);
  }
  console.log('\ninline_keyboard 按钮数量：');
  for (const item of buttonCount) {
    console.log(`- ${item.buttons} 个: ${item.observed}${item.description ? `（${item.description}）` : ''}`);
  }
  console.log('\neditMessageText + reply_markup：');
  console.log(`- ${editWithMarkup.observed}${editWithMarkup.description ? `（${editWithMarkup.description}）` : ''}`);
  console.log('\n429 / retry_after：');
  console.log(`- ${rateLimit.observed}${rateLimit.atAttempt ? `（第 ${rateLimit.atAttempt} 次；retry_after=${rateLimit.retryAfter}）` : ''}`);
  console.log(`- ${rateLimit.note}`);
  console.log('\nanswerCallbackQuery 时限：');
  console.log(`- ${answerCallbackQuery.observed}（${answerCallbackQuery.reason}）`);
  console.log('\n清理：');
  console.log(results.cleanup.length === 0
    ? '- 已删除本次创建的全部探测消息'
    : `- ${results.cleanup.length} 条临时消息删除失败：${JSON.stringify(results.cleanup)}`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.live) {
    printOffline(options);
    return;
  }
  try {
    const results = await runLive();
    printLive(results, options);
  } catch (error) {
    const token = (process.env.TELEGRAM_PROBE_TOKEN ?? '').trim();
    console.error(`probe failed: ${redact(error?.message ?? error, token)}`);
    process.exitCode = 1;
  }
}

await main();
