import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { TextHarnessBridge } from '../src/channels/shared/text-harness-bridge.mjs';
import { runWorkspaceCommand } from '../src/channels/shared/workspace-command.mjs';

test('/session binds exactly one safe Session ID to the current conversation', async () => {
  const calls = [];
  const result = await runWorkspaceCommand('/SESSION session-123', {
    async bindWorkspaceSession(key, sessionId) {
      calls.push({ key, sessionId });
      return {
        sessionId,
        workspace: '/workspace/project',
        title: '安全标题\u202e伪造\n下一行',
        archived: true,
      };
    },
  }, 'direct:conversation-1');

  assert.deepEqual(calls, [{ key: 'direct:conversation-1', sessionId: 'session-123' }]);
  assert.match(result.message, /^当前聊天已绑定会话：/);
  assert.match(result.message, /工作区：\/workspace\/project/);
  assert.match(result.message, /标题：安全标题 伪造 下一行/);
  assert.doesNotMatch(result.message, /\u202e|\n下一行/);
  assert.match(result.message, /ID：session-123/);
  assert.match(result.message, /归档：是/);
  assert.equal(result.messages.join(''), result.message);
});

test('/session N binds the selected position from the current workspace', async () => {
  const workspace = process.cwd();
  const calls = [];
  const harness = {
    currentWorkspace() { return workspace; },
    async listWorkspaceSessions(requestedWorkspace) {
      assert.equal(requestedWorkspace, workspace);
      return {
        workspace,
        sessions: [
          { sessionId: 'session-first' },
          { sessionId: 'session-second' },
        ],
      };
    },
    async bindWorkspaceSession(key, sessionId) {
      calls.push({ key, sessionId });
      return { workspace, sessionId, title: 'Selected session' };
    },
  };

  const result = await runWorkspaceCommand('/session 2', harness, 'direct:conversation-1');
  assert.deepEqual(calls, [{ key: 'direct:conversation-1', sessionId: 'session-second' }]);
  assert.match(result.message, /ID：session-second/);

  const missing = await runWorkspaceCommand('/session 3', harness, 'direct:conversation-1');
  assert.match(missing.message, /会话序号不存在/);
  assert.equal(calls.length, 1);
});

test('/session N maps position lookup failures to safe messages', async () => {
  const stale = new Error('private old bot lifecycle');
  stale.code = 'workspace-bot-not-found';
  const staleCurrent = await runWorkspaceCommand('/session 1', {
    currentWorkspace() { throw stale; },
    async listWorkspaceSessions() { throw new Error('must not be called'); },
  }, 'direct:conversation-1');
  assert.match(staleCurrent.message, /正在移除或已重新接入/);
  assert.doesNotMatch(staleCurrent.message, /private old bot lifecycle/);

  const staleList = await runWorkspaceCommand('/session 1', {
    currentWorkspace() { return process.cwd(); },
    async listWorkspaceSessions() { throw stale; },
  }, 'direct:conversation-1');
  assert.match(staleList.message, /正在移除或已重新接入/);

  const unavailable = await runWorkspaceCommand('/session 1', {
    currentWorkspace() { return process.cwd(); },
    async listWorkspaceSessions() { throw new Error('private Harness detail'); },
  }, 'direct:conversation-1');
  assert.match(unavailable.message, /暂时无法获取会话列表/);
  assert.doesNotMatch(unavailable.message, /private Harness detail/);
});

test('/session strictly rejects missing, multiple, oversized, and unsafe IDs', async () => {
  let bindCalls = 0;
  const harness = {
    async bindWorkspaceSession() {
      bindCalls += 1;
      throw new Error('must not be called');
    },
  };
  const invalid = [
    '/session',
    '/session first second',
    '/session\nsecond-line',
    `/session ${'x'.repeat(257)}`,
    '/session unsafe\u202eid',
    '/session unsafe\u0000id',
  ];

  for (const command of invalid) {
    const result = await runWorkspaceCommand(command, harness, 'direct:conversation-1');
    assert.match(result.message, /用法：\/session Session ID/);
  }
  assert.equal(bindCalls, 0);
});

test('/session requires binding support and a conversation key', async () => {
  assert.match(
    (await runWorkspaceCommand('/session session-1', {}, 'direct:conversation-1')).message,
    /暂不支持绑定已有会话/,
  );
  assert.match(
    (await runWorkspaceCommand('/session session-1', {
      async bindWorkspaceSession() { throw new Error('must not be called'); },
    })).message,
    /缺少可绑定的会话上下文/,
  );
});

test('/session maps adoption, lifecycle, and concurrent failures to safe messages', async () => {
  const cases = [
    ['session-id-invalid', /Session ID 格式无效/],
    ['session-not-registered', /未找到该会话/],
    ['session-workspace-ambiguous', /工作区归属不明确/],
    ['session-summary-unavailable', /暂时无法读取该会话的信息/],
    ['session-subagent-unsupported', /子代理会话不能绑定/],
    ['workspace-bot-not-found', /正在移除或已重新接入/],
    ['workspace-session-stale', /状态已发生变化/],
    ['agent-busy', /状态已发生变化/],
    ['session-conflict', /状态已发生变化/],
    ['internal', /暂时无法绑定会话/],
  ];

  for (const [code, expected] of cases) {
    const internal = new Error(`private detail for ${code}`);
    internal.code = code;
    const result = await runWorkspaceCommand('/session session-1', {
      async bindWorkspaceSession() { throw internal; },
    }, 'direct:conversation-1');
    assert.match(result.message, expected);
    assert.doesNotMatch(result.message, /private detail/);
  }

  const stale = new Error('old bot lifecycle');
  stale.code = 'workspace-bot-not-found';
  const staleAfterBinding = await runWorkspaceCommand('/session session-1', {
    async bindWorkspaceSession(sessionKey, sessionId) {
      return { sessionId, workspace: '/workspace/project', sessionKey };
    },
    assertWorkspaceScope() { throw stale; },
  }, 'direct:conversation-1');
  assert.match(staleAfterBinding.message, /正在移除或已重新接入/);
});

test('the shared bridge binds locally with its conversation key and never prompts or creates', async () => {
  const sent = [];
  const seen = new Set();
  const calls = [];
  let forbiddenCalls = 0;
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'test', label: 'Test' },
    bot: { async sendText(_target, text) { sent.push(text); } },
    harness: {
      async bindWorkspaceSession(key, sessionId) {
        calls.push({ key, sessionId });
        return {
          sessionId,
          workspace: '/workspace/project',
          title: null,
          archived: false,
        };
      },
      async createSession() { forbiddenCalls += 1; },
      async ask() { forbiddenCalls += 1; },
    },
    state: {
      hasSeen(messageId) { return seen.has(messageId); },
      async markSeen(messageId) { seen.add(messageId); },
    },
  });

  await bridge.accept({
    messageId: 'message-session-bind',
    senderId: 'sender',
    conversationId: 'conversation-1',
    kind: 'direct',
    content: '/session session-123',
    replyTarget: 'target',
  });

  assert.deepEqual(calls, [{ key: 'direct:conversation-1', sessionId: 'session-123' }]);
  assert.equal(forbiddenCalls, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /当前聊天已绑定会话/);
  assert.match(sent[0], /标题：暂无标题/);
  assert.match(sent[0], /归档：否/);
  assert.equal(seen.has('message-session-bind'), true);
});

test('all nine channel bridges advertise /session and pass their current conversation key', async () => {
  const bridgeFamilies = [
    ['../src/channels/shared/text-harness-bridge.mjs', 'conversationKey'],
    ['../src/channels/weixin/weixin-bridge.mjs', 'key'],
    ['../src/channels/dingtalk/dingtalk-bridge.mjs', 'key'],
    ['../src/channels/wecom/wecom-bridge.mjs', 'key'],
    ['../src/channels/qq/qq-bridge.mjs', 'key'],
  ];
  for (const [file, key] of bridgeFamilies) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /\/session Session ID 或当前工作区序号  将当前聊天绑定到指定会话/);
    assert.ok(
      source.includes(`runWorkspaceCommand(text, this.#harness, ${key})`),
      `${file} must pass ${key} to the shared command`,
    );
  }

  // The Feishu bridge advertises through its interactive-card help module.
  const feishuSource = await readFile(new URL('../src/channels/feishu/bridge.mjs', import.meta.url), 'utf8');
  assert.match(feishuSource, /menuHelpText/);
  assert.ok(
    feishuSource.includes('runWorkspaceCommand(text, this.#harness, key)'),
    'the Feishu bridge must pass its conversation key to the shared command',
  );
  const feishuCards = await readFile(new URL('../src/channels/feishu/feishu-cards.mjs', import.meta.url), 'utf8');
  assert.match(feishuCards, /\/session ID 或序号  绑定已有会话/);

  for (const file of [
    '../src/channels/discord/discord-bridge.mjs',
    '../src/channels/slack/slack-bridge.mjs',
    '../src/channels/telegram/telegram-bridge.mjs',
    '../src/channels/whatsapp/whatsapp-bridge.mjs',
  ]) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /extends TextHarnessBridge/);
  }
});
