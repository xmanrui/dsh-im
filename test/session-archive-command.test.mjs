import assert from 'node:assert/strict';
import test from 'node:test';

import { isWorkspaceCommand, runWorkspaceCommand } from '../src/channels/shared/workspace-command.mjs';

const WORKSPACE = process.cwd();
const KEY = 'direct:archive-command';

function archiveHarness(sessions, overrides = {}) {
  const archived = [];
  return {
    archived,
    harness: {
      currentWorkspace: () => WORKSPACE,
      async listWorkspaces() { return [WORKSPACE]; },
      async listWorkspaceSessions(workspace) { return { workspace, sessions }; },
      async archiveWorkspaceSession(sessionId, options = {}) {
        archived.push({ sessionId, stopActivity: options.stopActivity === true });
        return { archivedSessionIds: [sessionId] };
      },
      sessionFor: () => null,
      ...overrides,
    },
  };
}

const SESSIONS = [
  { sessionId: 'session-live-a', title: '在用会话 A', archived: false },
  { sessionId: 'session-old', title: '旧会话', archived: true },
  { sessionId: 'session-live-b', title: '在用会话 B', archived: false },
];

test('/sessionarchive archives one Session by id and reports what it archived', async () => {
  const { harness, archived } = archiveHarness(SESSIONS);
  const result = await runWorkspaceCommand('/sessionarchive session-live-a', harness, KEY);

  assert.deepEqual(archived, [{ sessionId: 'session-live-a', stopActivity: false }]);
  assert.match(result.message, /^已归档会话：/);
  assert.match(result.message, /标题：在用会话 A/);
  assert.match(result.message, /ID：session-live-a/);
  assert.equal(result.messages.join(''), result.message);
});

test('/sessionarchive N previews the live Session behind that index and never archives', async () => {
  const { harness, archived } = archiveHarness(SESSIONS);

  // Index 2 among the live Sessions is session-live-b; archived rows are skipped.
  const preview = await runWorkspaceCommand('/sessionarchive 2', harness, KEY);
  assert.deepEqual(archived, [], 'an index must not archive anything');
  assert.match(preview.message, /按序号归档只做预览/);
  assert.match(preview.message, /标题：在用会话 B/);
  assert.match(preview.message, /ID：session-live-b/);
  assert.match(preview.message, /确认归档请发送：\/sessionarchive session-live-b/);

  const missing = await runWorkspaceCommand('/sessionarchive 9', harness, KEY);
  assert.match(missing.message, /会话序号不存在/);
  assert.deepEqual(archived, []);
});

test('/sessionarchive with a full ID archives and passes --stop through', async () => {
  const { harness, archived } = archiveHarness(SESSIONS);

  const plain = await runWorkspaceCommand('/sessionarchive session-live-a', harness, KEY);
  assert.deepEqual(archived, [{ sessionId: 'session-live-a', stopActivity: false }]);
  assert.match(plain.message, /ID：session-live-a/);

  const withStop = await runWorkspaceCommand('/sessionarchive session-live-b --stop', harness, KEY);
  assert.deepEqual(archived.at(-1), { sessionId: 'session-live-b', stopActivity: true });
  assert.match(withStop.message, /ID：session-live-b/);
});

test('/sessionarchive refuses the bound Session and already archived Sessions', async () => {
  const bound = archiveHarness(SESSIONS, { sessionFor: () => 'session-live-a' });
  const refused = await runWorkspaceCommand('/sessionarchive session-live-a', bound.harness, KEY);
  assert.match(refused.message, /这是本对话当前绑定的会话/);
  assert.deepEqual(bound.archived, []);

  const already = archiveHarness(SESSIONS);
  const archived = await runWorkspaceCommand('/sessionarchive session-old', already.harness, KEY);
  assert.match(archived.message, /该会话已经归档/);
  assert.deepEqual(already.archived, []);
});

test('/sessionarchive explains a Host without the archive capability', async () => {
  const unsupported = await runWorkspaceCommand('/sessionarchive session-live-a', {
    currentWorkspace: () => WORKSPACE,
    async listWorkspaces() { return [WORKSPACE]; },
    async listWorkspaceSessions(workspace) { return { workspace, sessions: SESSIONS }; },
  }, KEY);
  assert.match(unsupported.message, /暂不支持归档会话/);

  const notFound = archiveHarness(SESSIONS, {
    async archiveWorkspaceSession() {
      const error = new Error('harness-api-not-found');
      error.code = 'harness-api-not-found';
      throw error;
    },
  });
  const replied = await runWorkspaceCommand('/sessionarchive session-live-a', notFound.harness, KEY);
  assert.match(replied.message, /当前 DSH 版本不支持通过机器人归档会话/);
});

test('/sessionarchive covers usage, missing index, aliases and dispatch', async () => {
  const { harness } = archiveHarness(SESSIONS);

  const usage = await runWorkspaceCommand('/sessionarchive', harness, KEY);
  assert.match(usage.message, /用法：\/sessionarchive Session ID/);

  const alias = await runWorkspaceCommand('/sessarchive session-live-a', harness, KEY);
  assert.match(alias.message, /ID：session-live-a/);

  for (const command of ['/sessionarchive x', '/sessarchive x']) {
    assert.equal(isWorkspaceCommand(command), true, command);
  }
  // The bind and list commands keep their own prefixes.
  assert.match((await runWorkspaceCommand('/sessionlist', harness, KEY)).message, /会话（2）/);
});
