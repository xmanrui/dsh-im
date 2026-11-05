import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { TextHarnessBridge } from '../src/channels/shared/text-harness-bridge.mjs';
import { runWorkspaceCommand } from '../src/channels/shared/workspace-command.mjs';
import { toPosixPath } from './support/filesystem.mjs';

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
  assert.match(toPosixPath(result.message), /工作区：(?:[A-Z]:)?\/workspace\/project/);
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
    ['../src/channels/feishu/bridge.mjs', 'key'],
    ['../src/channels/dingtalk/dingtalk-bridge.mjs', 'key'],
    ['../src/channels/wecom/wecom-bridge.mjs', 'key'],
    ['../src/channels/qq/qq-bridge.mjs', 'key'],
  ];
  for (const [file, key] of bridgeFamilies) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    if (file.endsWith('/shared/text-harness-bridge.mjs')) {
      // Full rendered help for all four consumers is covered by command-help.test.mjs.
      assert.match(source, /commandHelpLines\(this\.#descriptor\.key, availableCommandCatalog/);
    } else {
      assert.match(source, /\/sessionlist --all  跨工作区汇总会话/);
      assert.match(source, /\/session Session ID、当前工作区序号或标题关键词  将当前聊天绑定到指定会话/);
    }
    assert.ok(
      source.includes(`runWorkspaceCommand(text, this.#harness, ${key})`),
      `${file} must pass ${key} to the shared command`,
    );
  }

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

test('every non-text bridge lists the session-navigation commands in its help', async () => {
  const files = [
    '../src/channels/dingtalk/dingtalk-bridge.mjs',
    '../src/channels/wecom/wecom-bridge.mjs',
    '../src/channels/wecom-app/wecom-app-bridge.mjs',
    '../src/channels/weixin/weixin-bridge.mjs',
    '../src/channels/qq/qq-bridge.mjs',
    '../src/channels/feishu/feishu-cards.mjs',
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /SESSION_NAV_HELP_LINES/, `${file} must list the shared nav help lines`);
  }
});

function titleHarness(sessions, workspace = process.cwd()) {
  const queries = [];
  const bindings = [];
  return {
    queries,
    bindings,
    harness: {
      currentWorkspace() { return workspace; },
      async listWorkspaces() { return [workspace]; },
      async listWorkspaceSessions(requested) {
        queries.push(requested);
        return { workspace: requested, sessions };
      },
      async bindWorkspaceSession(key, sessionId) {
        bindings.push({ key, sessionId });
        return { sessionId, workspace, title: 'bound by title' };
      },
    },
  };
}

test('/session <keyword> binds the single title match in the current workspace', async () => {
  const { harness, bindings, queries } = titleHarness([
    { sessionId: 'session-alpha', title: '重构 dsh-im 会话选择' },
    { sessionId: 'session-beta', title: '无关话题' },
  ]);

  const result = await runWorkspaceCommand('/session 会话选择', harness, 'direct:conversation-1');
  assert.deepEqual(queries, [process.cwd()]);
  assert.deepEqual(bindings, [{ key: 'direct:conversation-1', sessionId: 'session-alpha' }]);
  assert.match(result.message, /^当前聊天已绑定会话：/);
  assert.match(result.message, /ID：session-alpha/);
});

test('/session <keyword> lists candidates instead of guessing between matches', async () => {
  const workspace = process.cwd();
  const { harness, bindings } = titleHarness([
    { sessionId: 'session-one', title: '周报 2024' },
    { sessionId: 'session-two', title: '周报 2025' },
  ], workspace);

  let attempted = 0;
  harness.bindWorkspaceSession = async () => {
    attempted += 1;
    throw new Error('must not bind an ambiguous keyword');
  };

  const result = await runWorkspaceCommand('/session 周报', harness, 'direct:conversation-1');
  assert.equal(attempted, 0);
  assert.equal(bindings.length, 0);
  assert.match(result.message, /标题包含「周报」的会话有多个/);
  assert.match(result.message, /1\. 周报 2024/);
  assert.match(result.message, /2\. 周报 2025/);
  assert.match(result.message, /ID: session-one/);
  assert.match(result.message, /ID: session-two/);
  assert.match(result.message, /工作区：/);
  assert.match(result.message, /用法：\/session Session ID/);
  assert.equal(result.messages.join(''), result.message);
});

test('/session <keyword> falls back to the Session ID path when nothing matches', async () => {
  const workspace = process.cwd();
  const { harness, bindings } = titleHarness([], workspace);
  let mode = 'missing';
  harness.bindWorkspaceSession = async (key, sessionId) => {
    if (mode === 'missing') {
      const error = new Error('private harvester detail');
      error.code = 'session-not-registered';
      throw error;
    }
    bindings.push({ key, sessionId });
    return { sessionId, workspace, title: 'legacy binding' };
  };

  const missed = await runWorkspaceCommand('/session 不存在的标题', harness, 'direct:conversation-1');
  assert.match(missed.message, /没有标题包含「不存在的标题」的会话/);
  assert.match(missed.message, /\/sessionlist --all/);
  assert.doesNotMatch(missed.message, /private harvester detail/);

  mode = 'ok';
  const bound = await runWorkspaceCommand('/session legacy-session-id', harness, 'direct:conversation-1');
  assert.deepEqual(bindings, [{ key: 'direct:conversation-1', sessionId: 'legacy-session-id' }]);
  assert.match(bound.message, /当前聊天已绑定会话/);
});

test('/session session-<ID> binds by ID without searching titles', async () => {
  let searches = 0;
  const result = await runWorkspaceCommand('/session session-direct', {
    async listWorkspaces() { searches += 1; return []; },
    async listWorkspaceSessions() { searches += 1; return { sessions: [] }; },
    async bindWorkspaceSession(_key, sessionId) {
      return { sessionId, workspace: '/workspace/project', title: 'Direct' };
    },
  }, 'direct:conversation-1');

  assert.equal(searches, 0);
  assert.match(result.message, /ID：session-direct/);
});

test('/session rejects unsafe keywords and prefers an explicit Session ID over title matches', async () => {
  const unsafe = await runWorkspaceCommand('/session 标题\u202ekey', {
    async bindWorkspaceSession() { throw new Error('must not be called'); },
  }, 'direct:conversation-1');
  assert.match(unsafe.message, /用法：\/session Session ID/);

  // A token that names a Session directly is never treated as a keyword, even
  // when that same text appears inside several titles.
  const workspace = process.cwd();
  const { harness, bindings } = titleHarness([
    { sessionId: 'session-exact', title: '话题 session-exact 讨论' },
    { sessionId: 'session-other', title: '话题 session-exact 也出现' },
  ], workspace);
  const bound = await runWorkspaceCommand('/session session-exact', harness, 'direct:conversation-1');
  assert.deepEqual(bindings, [{ key: 'direct:conversation-1', sessionId: 'session-exact' }]);
  assert.match(bound.message, /ID：session-exact/);
});

async function twoWorkspaces(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-session-bind-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = join(root, 'local');
  const remote = join(root, 'remote');
  await Promise.all([mkdir(local), mkdir(remote)]);
  return { local, remote };
}

test('/session <keyword> lists a unique match in another workspace instead of binding it', async (t) => {
  const { local, remote } = await twoWorkspaces(t);
  let bindCalls = 0;
  const harness = {
    currentWorkspace() { return local; },
    async listWorkspaces() { return [local, remote]; },
    async listWorkspaceSessions(workspace) {
      return {
        workspace,
        sessions: workspace === remote
          ? [{ sessionId: 'remote-session', title: '目标 远程会话' }]
          : [],
      };
    },
    async bindWorkspaceSession() {
      bindCalls += 1;
      throw new Error('must not bind a remote title match');
    },
  };

  const result = await runWorkspaceCommand('/session 目标', harness, 'direct:conversation-1');
  assert.equal(bindCalls, 0);
  assert.match(result.message, /标题包含「目标」的会话位于其他工作区/);
  assert.match(result.message, /ID: remote-session/);
  assert.match(result.message, /用法：\/session Session ID/);
});

test('/session <keyword> does not bind when a workspace cannot be read', async (t) => {
  const { local, remote } = await twoWorkspaces(t);
  let bindCalls = 0;
  const harness = {
    currentWorkspace() { return local; },
    async listWorkspaces() { return [local, remote]; },
    async listWorkspaceSessions(workspace) {
      if (workspace === remote) throw new Error('private workspace detail');
      return {
        workspace,
        sessions: [{ sessionId: 'local-session', title: '目标 本地会话' }],
      };
    },
    async bindWorkspaceSession() {
      bindCalls += 1;
      throw new Error('must not bind an incomplete search');
    },
  };

  const result = await runWorkspaceCommand('/session 目标', harness, 'direct:conversation-1');
  assert.equal(bindCalls, 0);
  assert.match(result.message, /部分工作区暂时无法读取，搜索结果可能不完整/);
  assert.match(result.message, /ID: local-session/);
  assert.doesNotMatch(result.message, /private workspace detail/);
});

test('/session <keyword> reports an incomplete search when every workspace fails', async (t) => {
  const { local, remote } = await twoWorkspaces(t);
  const harness = {
    currentWorkspace() { return local; },
    async listWorkspaces() { return [local, remote]; },
    async listWorkspaceSessions() { throw new Error('private workspace detail'); },
    async bindWorkspaceSession() {
      const error = new Error('private harvester detail');
      error.code = 'session-not-registered';
      throw error;
    },
  };

  const result = await runWorkspaceCommand('/session 目标', harness, 'direct:conversation-1');
  assert.match(result.message, /部分工作区暂时无法读取，未能确认标题包含「目标」的会话/);
  assert.doesNotMatch(result.message, /private/);
});

test('/session prefers an exact non-prefixed Session ID over title matches', async () => {
  const workspace = process.cwd();
  const bindings = [];
  const harness = {
    currentWorkspace() { return workspace; },
    async listWorkspaces() { return [workspace]; },
    async listWorkspaceSessions() {
      return {
        workspace,
        sessions: [
          { sessionId: 'legacy-exact', title: 'legacy-exact 讨论' },
          { sessionId: 'legacy-other', title: 'legacy-exact 也出现' },
        ],
      };
    },
    async bindWorkspaceSession(key, sessionId) {
      bindings.push({ key, sessionId });
      return { sessionId, workspace, title: 'bound by exact ID' };
    },
  };

  const result = await runWorkspaceCommand('/session legacy-exact', harness, 'direct:conversation-1');
  assert.deepEqual(bindings, [{ key: 'direct:conversation-1', sessionId: 'legacy-exact' }]);
  assert.match(result.message, /ID：legacy-exact/);
});

test('/session prefers a bare UUID whose title does not contain the ID', async () => {
  const sessionId = '123e4567-e89b-12d3-a456-426614174000';
  const { harness, bindings } = titleHarness([
    { sessionId, title: 'Original conversation' },
    { sessionId: 'session-other', title: `Discussion of ${sessionId}` },
  ]);

  const result = await runWorkspaceCommand(`/session ${sessionId}`, harness, 'direct:conversation-1');

  assert.deepEqual(bindings, [{ key: 'direct:conversation-1', sessionId }]);
  assert.match(result.message, new RegExp(`ID：${sessionId}`));
});

test('/session finds an untitled exact ID after the title candidate cap in another workspace', async (t) => {
  const { local, remote } = await twoWorkspaces(t);
  const sessionId = '123e4567-e89b-12d3-a456-426614174000';
  const bindings = [];
  const harness = {
    currentWorkspace: () => local,
    listWorkspaces: async () => [local, remote],
    async listWorkspaceSessions(workspace) {
      return {
        workspace,
        sessions: workspace === local
          ? Array.from({ length: 12 }, (_, index) => ({
            sessionId: `session-other-${index}`, title: `Discussion of ${sessionId}`,
          }))
          : [{ sessionId, title: null, summaryAvailable: false }],
      };
    },
    async bindWorkspaceSession(key, selected, ...options) {
      bindings.push({ key, sessionId: selected });
      assert.deepEqual(options, [], 'exact IDs keep the existing binding semantics');
      return { sessionId: selected, workspace: remote };
    },
  };

  const result = await runWorkspaceCommand(`/session ${sessionId}`, harness, 'direct:conversation-1');

  assert.deepEqual(bindings, [{ key: 'direct:conversation-1', sessionId }]);
  assert.match(result.message, /当前聊天已绑定会话/);
});

test('/sessionlist --all preserves bindable indices when invalid rows are skipped', async () => {
  const { harness, bindings } = titleHarness([
    { title: 'Invalid record' },
    { sessionId: 'session-a', title: 'Session A' },
    { sessionId: 'session-b', title: 'Session B' },
  ]);

  const listed = await runWorkspaceCommand('/sessionlist --all', harness, 'direct:conversation-1');
  assert.match(listed.message, /2\. Session A\n   ID: session-a/);
  assert.match(listed.message, /3\. Session B\n   ID: session-b/);
  assert.match(listed.message, /1 条会话记录无效，已跳过/);

  await runWorkspaceCommand('/session 2', harness, 'direct:conversation-1');
  await runWorkspaceCommand('/session 3', harness, 'direct:conversation-1');
  assert.deepEqual(bindings.map((entry) => entry.sessionId), ['session-a', 'session-b']);
});


test('/session <keyword> names the match when the Harness refuses to adopt it', async () => {
  const { harness, bindings } = titleHarness([
    { sessionId: 'session-web', title: '我想开发一个web页面，部署到本台机器' },
  ]);
  harness.bindWorkspaceSession = async () => {
    const error = new Error('private harvest detail');
    error.code = 'session-summary-unavailable';
    throw error;
  };

  const result = await runWorkspaceCommand('/session web页面', harness, 'direct:conversation-1');
  assert.equal(bindings.length, 0);
  assert.match(result.message, /按标题匹配到「我想开发一个web页面，部署到本台机器」/);
  assert.match(result.message, /ID: session-web/);
  assert.match(result.message, /工作区: /);
  assert.match(result.message, /Harness 当前无法接管这个会话/);
  assert.doesNotMatch(result.message, /private harvest detail/);
  assert.doesNotMatch(result.message, /暂时无法读取该会话的信息/);
});


test('/session <keyword> never binds an archived Session by title', async () => {
  const { harness, bindings } = titleHarness([
    { sessionId: 'session-archived', title: 'web页面 旧会话', archived: true },
  ]);

  const result = await runWorkspaceCommand('/session web页面', harness, 'direct:conversation-1');
  assert.equal(bindings.length, 0);
  assert.match(result.message, /标题包含「web页面」的会话已归档/);
  assert.match(result.message, /ID: session-archived/);
  assert.match(result.message, /用法：\/session Session ID/);
  assert.equal(result.messages.join(''), result.message);
});

test('/session <keyword> ignores a matching archived Session when a live one exists', async () => {
  const { harness, bindings } = titleHarness([
    { sessionId: 'session-archived', title: '周报 2023', archived: true },
    { sessionId: 'session-live', title: '周报 2026', archived: false },
  ]);

  const result = await runWorkspaceCommand('/session 周报', harness, 'direct:conversation-1');
  assert.deepEqual(bindings, [{ key: 'direct:conversation-1', sessionId: 'session-live' }]);
  assert.match(result.message, /当前聊天已绑定会话/);
  assert.match(result.message, /ID：session-live/);
});

test('/session <archived Session ID> still binds by ID', async () => {
  const { harness, bindings } = titleHarness([
    { sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: '旧会话', archived: true },
  ]);

  const result = await runWorkspaceCommand(
    '/session aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    harness,
    'direct:conversation-1',
  );
  assert.deepEqual(bindings, [
    { key: 'direct:conversation-1', sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
  ]);
  assert.match(result.message, /当前聊天已绑定会话/);
});


test('/session stays the advertised name and /sess is a working alias', async () => {
  const calls = [];
  const bind = async (command) => {
    calls.length = 0;
    const result = await runWorkspaceCommand(command, {
      async bindWorkspaceSession(key, sessionId) {
        calls.push({ key, sessionId });
        return { sessionId, workspace: '/workspace/project', title: 'Bound' };
      },
    }, 'direct:conversation-1');
    return result;
  };

  const primary = await bind('/session session-primary');
  assert.deepEqual(calls, [{ key: 'direct:conversation-1', sessionId: 'session-primary' }]);
  assert.match(primary.message, /^当前聊天已绑定会话：/);

  // The short alias exists for clients that claim /session for themselves.
  const shorthand = await bind('/SESS session-alias');
  assert.deepEqual(calls, [{ key: 'direct:conversation-1', sessionId: 'session-alias' }]);
  assert.match(shorthand.message, /^当前聊天已绑定会话：/);

  const shorthandIndex = await runWorkspaceCommand('/sess 1', {
    currentWorkspace: () => process.cwd(),
    async listWorkspaceSessions(workspace) {
      return { workspace, sessions: [{ sessionId: 'session-by-index' }] };
    },
    async bindWorkspaceSession(key, sessionId) {
      calls.push({ key, sessionId });
      return { sessionId, workspace: process.cwd(), title: 'Index' };
    },
  }, 'direct:conversation-1');
  assert.equal(calls.at(-1).sessionId, 'session-by-index');
  assert.match(shorthandIndex.message, /ID：session-by-index/);

  // The list command keeps its own prefix and is not swallowed by the alias.
  const listed = await runWorkspaceCommand('/sessionlist', {
    currentWorkspace: () => process.cwd(),
    async listWorkspaceSessions(workspace) { return { workspace, sessions: [] }; },
  }, 'direct:conversation-1');
  assert.match(listed.message, /该工作区暂无会话/);

  // Both names fall back to the same usage text.
  for (const command of ['/session', '/sess']) {
    const usage = await runWorkspaceCommand(command, {}, 'direct:conversation-1');
    assert.match(usage.message, /用法：\/session Session ID/);
  }
});


test('/session N counts only live Sessions; archived ones bind by ID', async () => {
  const workspace = process.cwd();
  const bindings = [];
  const harness = {
    currentWorkspace() { return workspace; },
    async listWorkspaceSessions(requested) {
      return {
        workspace: requested,
        sessions: [
          { sessionId: 'session-live-a', archived: false },
          { sessionId: 'session-archived', archived: true },
          { sessionId: 'session-live-b', archived: false },
        ],
      };
    },
    async bindWorkspaceSession(_key, sessionId) {
      bindings.push(sessionId);
      return { sessionId, workspace, title: 't' };
    },
  };

  const second = await runWorkspaceCommand('/session 2', harness, 'direct:conversation-1');
  assert.equal(bindings.at(-1), 'session-live-b');
  assert.match(second.message, /ID：session-live-b/);

  const third = await runWorkspaceCommand('/session 3', harness, 'direct:conversation-1');
  assert.match(third.message, /会话序号不存在/);

  const byId = await runWorkspaceCommand('/session session-archived', harness, 'direct:conversation-1');
  assert.equal(bindings.at(-1), 'session-archived');
  assert.match(byId.message, /ID：session-archived/);
});
