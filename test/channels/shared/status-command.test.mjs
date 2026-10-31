import assert from 'node:assert/strict';
import test from 'node:test';

import { getImHostLanguage, setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import {
  STATUS_FIELD_TIMEOUT_MS,
  runStatusCommand,
} from '../../../src/channels/shared/status-command.mjs';
import {
  createTextBridgeStatus,
  TextHarnessBridge,
} from '../../../src/channels/shared/text-harness-bridge.mjs';

const SESSION_ID = 'session-abcdef1234567890';
const WORKSPACE = '/home/wings/project';

function stateWithSession(sessionId) {
  const sessions = new Map();
  if (sessionId) sessions.set('direct:chat-a', sessionId);
  const seen = new Set();
  return {
    sessionFor(key) { return sessions.get(key) ?? null; },
    async setSession(key, value) { sessions.set(key, value); },
    async clearSession(key) { sessions.delete(key); },
    hasSeen(messageId) { return seen.has(messageId); },
    async markSeen(messageId) { seen.add(messageId); },
    async unmarkSeen(messageId) { return seen.delete(messageId); },
  };
}

function harnessFixture({
  sessionId = SESSION_ID,
  session = {},
  workspace = WORKSPACE,
  settings = {
    agentPreset: 'marketing-jeep',
    agentPresetCatalog: { items: [{ id: 'marketing-jeep', label: '营销预设' }] },
  },
} = {}) {
  const fullSession = sessionId
    ? {
        async sessionExists() { return true; },
        async models() {
          return {
            groups: [],
            failures: [],
            current: {
              provider: 'deepseek-official',
              model: 'deepseek-v4-pro',
              reasoningEffort: 'high',
            },
          };
        },
        async isRunning() { return true; },
        ...session,
      }
    : null;
  return {
    async ensureRunning() {},
    currentWorkspace: () => workspace,
    currentConversationWorkspace: () => workspace,
    workspaceSession: (id) => (sessionId && id === sessionId ? fullSession : null),
    agentPresetSettings: async () => settings,
  };
}

function bridgeFor({ harness, state, bot }) {
  return new TextHarnessBridge({
    descriptor: { key: 'telegram', label: 'Telegram' },
    bot,
    harness,
    state,
    logger: { warn() {}, error() {} },
  });
}


/** A state whose Session binding answers for any conversation key. */
function stateWithAnySession(sessionId) {
  const sessions = new Map([['direct:1', sessionId], ['group:-100123', sessionId]]);
  const seen = new Set();
  return {
    sessionFor(key) { return sessions.get(key) ?? null; },
    async setSession(key, value) { sessions.set(key, value); },
    async clearSession(key) { sessions.delete(key); },
    hasSeen(messageId) { return seen.has(messageId); },
    async markSeen(messageId) { seen.add(messageId); },
    async unmarkSeen(messageId) { return seen.delete(messageId); },
  };
}

function statusMessage(messageId) {
  return {
    messageId,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    content: '/status',
    addressed: true,
    replyTarget: { id: 'target-status' },
  };
}

async function askStatus({ harness, state }) {
  const sent = [];
  const bridge = bridgeFor({
    harness,
    state,
    bot: {
      async sendText(target, text) { sent.push({ target, text }); },
    },
  });
  await bridge.accept(statusMessage('status-message-1'));
  assert.equal(sent.length, 1, 'one /status message, not several');
  return sent[0].text;
}

test('status reports connection, workspace, session, model, preset and a running task', async () => {
  const text = await askStatus({
    harness: harnessFixture(),
    state: stateWithSession(SESSION_ID),
  });
  assert.deepEqual(text.split('\n'), [
    'Telegram机器人与 DeepSeek Harness 连接正常。',
    `工作区：${WORKSPACE}`,
    '绑定会话：session-abcd…',
    '当前模型：deepseek-official/deepseek-v4-pro',
    'Agent Preset（预设）：营销预设（marketing-jeep）',
    '运行中任务：有（发送 /stop 可停止）',
  ]);
});

test('status stays one readable message when the chat has no session or task', async () => {
  const text = await askStatus({
    harness: harnessFixture({
      sessionId: null,
      settings: { agentPreset: null, agentPresetCatalog: { items: [] } },
    }),
    state: stateWithSession(null),
  });
  assert.deepEqual(text.split('\n'), [
    'Telegram机器人与 DeepSeek Harness 连接正常。',
    `工作区：${WORKSPACE}`,
    '绑定会话：未绑定（发送消息后自动创建）',
    '当前模型：暂无（创建会话后显示）',
    'Agent Preset（预设）：跟随 Host 默认',
  ]);
  assert.doesNotMatch(text, /运行中任务/);
});

test('a failing status field degrades independently instead of failing the command', async () => {
  const broken = {
    async models() { throw new Error('models rpc failed'); },
    async isRunning() { throw new Error('run-state rpc failed'); },
  };
  const harness = harnessFixture({ session: broken });
  harness.agentPresetSettings = async () => {
    throw new Error('preset rpc failed');
  };
  const text = await askStatus({ harness, state: stateWithSession(SESSION_ID) });
  assert.deepEqual(text.split('\n'), [
    'Telegram机器人与 DeepSeek Harness 连接正常。',
    `工作区：${WORKSPACE}`,
    '绑定会话：session-abcd…',
  ]);
});

test('status localizes every added line', async (t) => {
  const previous = getImHostLanguage();
  t.after(() => setImHostLanguage(previous));
  setImHostLanguage('en');
  const text = await askStatus({
    harness: harnessFixture({
      settings: {
        agentPreset: 'marketing-jeep',
        agentPresetCatalog: { items: [{ id: 'marketing-jeep', label: 'Marketing Preset' }] },
      },
    }),
    state: stateWithSession(SESSION_ID),
  });
  assert.deepEqual(text.split('\n'), [
    'The Telegram bot is connected to DeepSeek Harness and working normally.',
    `Workspace: ${WORKSPACE}`,
    'Session: session-abcd…',
    'Current model: deepseek-official/deepseek-v4-pro',
    'Agent Preset: Marketing Preset（marketing-jeep）',
    'Running task: yes (send /stop to stop it)',
  ]);
});


test('a stuck Host cannot hold /status open: optional reads are bounded', async () => {
  assert.ok(Number.isSafeInteger(STATUS_FIELD_TIMEOUT_MS) && STATUS_FIELD_TIMEOUT_MS > 0
    && STATUS_FIELD_TIMEOUT_MS <= 5_000, 'the shared field timeout stays short');
  const never = (options) => new Promise((_, reject) => {
    options?.signal?.addEventListener(
      'abort',
      () => reject(options.signal.reason ?? new Error('aborted')),
      { once: true },
    );
  });
  const harness = {
    async ensureRunning() {},
    currentWorkspace: () => WORKSPACE,
    currentConversationWorkspace: () => WORKSPACE,
    workspaceSession: () => ({ sessionExists: async () => true, models: never, isRunning: never }),
    agentPresetSettings: never,
  };
  let timer;
  let result;
  try {
    result = await Promise.race([
      runStatusCommand({
        descriptor: { label: 'Telegram' },
        harness,
        state: stateWithSession(SESSION_ID),
        conversationKey: 'direct:chat-a',
        fieldTimeoutMs: 20,
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('/status did not return within the field timeout')), 1_500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  assert.deepEqual(result.message.split('\n'), [
    'Telegram机器人与 DeepSeek Harness 连接正常。',
    `工作区：${WORKSPACE}`,
    '绑定会话：session-abcd…',
  ], 'timed-out fields are omitted, the connection line still arrives');
});

test('text channels without workspace or preset APIs (iMessage/Email) still answer /status', async () => {
  const sent = [];
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'imessage', label: 'iMessage' },
    bot: { async sendText(target, text) { sent.push(text); } },
    harness: { async ensureRunning() {} },
    state: stateWithSession(null),
    logger: { warn() {}, error() {} },
  });
  await bridge.accept({
    messageId: 'status-minimal-channel',
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    content: '/status',
    addressed: true,
    replyTarget: { id: 'target-status' },
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].split('\n'), [
    'iMessage机器人与 DeepSeek Harness 连接正常。',
    '绑定会话：未绑定（发送消息后自动创建）',
    '当前模型：暂无（创建会话后显示）',
  ], 'missing optional harness APIs degrade to the connection + binding lines');
});

/* ---------------------------------------------------------------------------
 * Group chats do not get the operator's private details
 *
 * A group is a room full of people: the absolute workspace path, the Session id
 * and the model name describe the operator's machine, not the group's business.
 * The direct chat is the operator's own chat and must stay exactly as it was.
 * ------------------------------------------------------------------------- */

function groupHarness() {
  return harnessFixture();
}

test('a group chat gets a redacted status, a direct chat does not', async () => {
  const workspace = '/home/operator/private-project';
  const harness = {
    async ensureRunning() {},
    currentWorkspace: () => workspace,
    currentConversationWorkspace: () => workspace,
    async agentPresetSettings() {
      return { agentPreset: null, agentPresetCatalog: { defaultId: '', items: [] } };
    },
    workspaceSession: () => ({
      async sessionExists() { return true; },
      async models() {
        return { groups: [], failures: [], current: { provider: 'secret-provider', model: 'secret-model' } };
      },
      async isRunning() { return false; },
    }),
  };
  const state = stateWithAnySession(SESSION_ID);
  const group = await runStatusCommand({
    descriptor: { label: 'Telegram' }, harness, state, conversationKey: 'group:-100123',
  });
  const direct = await runStatusCommand({
    descriptor: { label: 'Telegram' }, harness, state, conversationKey: 'direct:1',
  });

  // Group: no absolute path, no full Session id, no model name.
  assert.doesNotMatch(group.message, /\/home\/operator/u, 'the absolute path stays private');
  assert.match(group.message, /private-project/u, 'the last segment still identifies the workspace');
  assert.match(group.message, /群聊中仅显示末段/u);
  assert.doesNotMatch(group.message, new RegExp(SESSION_ID, 'u'), 'the full Session id stays private');
  assert.match(group.message, /…567890/u, 'the tail is enough to tell sessions apart');
  assert.doesNotMatch(group.message, /secret-model/u, 'the model name stays private');
  assert.match(group.message, /群聊中不显示具体名称/u);

  // Direct: byte-for-byte the behaviour it always had.
  assert.match(direct.message, new RegExp(workspace.replaceAll('/', '\\/'), 'u'));
  assert.match(direct.message, /session-abcd…/u);
  assert.match(direct.message, /secret-provider\/secret-model/u);
  assert.doesNotMatch(direct.message, /群聊中/u);
});

test('the card snapshot carries the same redaction as the text', async () => {
  const workspace = '/home/operator/private-project';
  const harness = {
    async ensureRunning() {},
    currentWorkspace: () => workspace,
    currentConversationWorkspace: () => workspace,
    async agentPresetSettings() {
      return { agentPreset: null, agentPresetCatalog: { defaultId: '', items: [] } };
    },
    workspaceSession: () => ({
      async sessionExists() { return true; },
      async models() {
        return { groups: [], failures: [], current: { provider: 'p', model: 'secret-model' } };
      },
      async isRunning() { return false; },
    }),
  };
  const state = stateWithAnySession(SESSION_ID);
  const group = await runStatusCommand({
    descriptor: { label: 'Telegram' }, harness, state, conversationKey: 'group:-100123',
  });
  const { statusSnapshot: snapshot } = group;
  assert.equal(snapshot.shared, true);
  assert.equal(snapshot.workspace, 'private-project', 'the snapshot is shortened too');
  assert.equal(snapshot.model, null, 'the snapshot does not carry the model name');
  assert.equal(snapshot.modelHidden, true, 'the card is told why it is missing');

  const direct = await runStatusCommand({
    descriptor: { label: 'Telegram' }, harness, state, conversationKey: 'direct:1',
  });
  assert.equal(direct.statusSnapshot.shared, false);
  assert.equal(direct.statusSnapshot.workspace, workspace);
  assert.equal(direct.statusSnapshot.model, 'p/secret-model');
  assert.equal(direct.statusSnapshot.modelHidden, false);
});

test('a group chat with no bound session still answers usefully', async () => {
  const harness = harnessFixture({ sessionId: null });
  const result = await runStatusCommand({
    descriptor: { label: 'Telegram' },
    harness,
    state: stateWithSession(null),
    conversationKey: 'group:-100123',
  });
  assert.match(result.message, /连接正常/u);
  assert.match(result.message, /未绑定/u);
});
