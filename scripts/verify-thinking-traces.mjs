/**
 * One-shot live demo of the thinking-traces pipeline.
 *
 * Drives the REAL production bridge (TextHarnessBridge with
 * thinkingTraces: true) + REAL Telegram API (outbound messages land in the
 * user's bot chat) + REAL dsh harness at 127.0.0.1:9377, with one simulated
 * inbound user message. The running bot's poller is untouched (no
 * getUpdates), and the state store is only read — no file is written.
 *
 * Usage: node scripts/demo-thinking-traces.mjs
 */
import { readFile } from 'node:fs/promises';

import { TelegramApi } from '../src/channels/telegram/telegram-api.mjs';
import { TelegramHarnessClient } from '../src/channels/telegram/harness-client.mjs';
import { TelegramHarnessBridge } from '../src/channels/telegram/telegram-bridge.mjs';
import { TelegramBotClient } from '../src/channels/telegram/telegram-runtime.mjs';

const STATE_PATH = '/home/gin/.dsh/integrations/dsh-telegram/bots/telegram_33572038edb2f5da13f2cca7/state.json';
const CREDENTIALS_PATH = '/home/gin/.dsh/.credentials.yaml';
const CHAT_ID = 5716716841;
const REPLY_TO_MESSAGE_ID = 275060582; // the user's most recent real message
const WORKSPACE = '/home/gin';
const HARNESS_BASE_URL = 'http://127.0.0.1:9377';

const TASK = [
  '做一次复杂的只读审查任务：',
  '1. 完整读取 /home/gin/.tmp-dsh-im/THINKING-TRACES-PLAN.md；',
  '2. 对照 §4 的逐文件行为契约，检查 src/channels/telegram/telegram-runtime.mjs、src/channels/shared/text-harness-bridge.mjs、src/channels/shared/harness-client.mjs 的实现是否一致；',
  '3. 逐项列出：已实现 / 明确推迟（reasoningMaxChars、answerTargetLimit 等）/ 与契约有偏差的地方，并给出代码位置；',
  '4. 结论部分请用至少四个自然段，每段聚焦一个方面（格式规则、消息切分、回退行为、配置与开关）。',
].join('\n');

const logger = {
  debug: () => {},
  info: () => {},
  warn: (message, ...rest) => console.error('[warn]', message, ...rest),
  error: (message, ...rest) => console.error('[error]', message, ...rest),
};

// --- token (read-only) ---
const credentials = await readFile(CREDENTIALS_PATH, 'utf8');
const tokenMatch = credentials.match(/DSH_TELEGRAM_BOT_TOKEN_\w+:\s*(\S+)/);
if (!tokenMatch) throw new Error('bot token not found in credentials');
const token = tokenMatch[1];

// --- real session binding (read-only) ---
const stateJson = JSON.parse(await readFile(STATE_PATH, 'utf8'));
const boundSession = stateJson.sessions?.[`direct:${CHAT_ID}`];

// --- in-memory state: same binding, zero file writes ---
const sessions = new Map();
if (boundSession) sessions.set(`direct:${CHAT_ID}`, boundSession);
const seen = new Set();
const state = {
  sessionFor: (key) => sessions.get(key) ?? null,
  setSession: async (key, value) => sessions.set(key, value),
  clearSession: async (key) => sessions.delete(key),
  hasSeen: (id) => seen.has(id),
  markSeen: async (id) => seen.add(id),
};

// --- real pieces ---
const api = new TelegramApi({ token });
const bot = new TelegramBotClient({ api, signal: undefined, logger });
const harness = new TelegramHarnessClient({
  baseUrl: HARNESS_BASE_URL,
  workspace: WORKSPACE,
});
const bridge = new TelegramHarnessBridge({
  bot,
  harness,
  state,
  thinkingTraces: true,
  logger,
});

console.log(`session: ${boundSession ?? '(new)'}`);
console.log(`sending demo task to chat ${CHAT_ID}…`);
const startedAt = Date.now();
try {
  await bridge.accept({
    messageId: `demo-thinking-${Date.now()}`,
    senderId: String(CHAT_ID),
    kind: 'direct',
    conversationId: String(CHAT_ID),
    content: TASK,
    addressed: true,
    replyTarget: { chatId: CHAT_ID, replyToMessageId: REPLY_TO_MESSAGE_ID },
  });
  console.log(`done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — check the Telegram chat`);
} catch (error) {
  console.error(`failed after ${((Date.now() - startedAt) / 1000).toFixed(1)}s:`, error);
  process.exitCode = 1;
}
