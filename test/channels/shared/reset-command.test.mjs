import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ConversationStateStore } from '../../../src/channels/shared/conversation-state-store.mjs';
import { isResetCommand, runResetCommand } from '../../../src/channels/shared/reset-command.mjs';
import { runSessionNavCommand } from '../../../src/channels/shared/session-nav-command.mjs';

const tempDirectories = new Set();

async function makeState() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-im-reset-'));
  tempDirectories.add(root);
  return new ConversationStateStore(join(root, 'state.json')).load();
}

async function resetFixture() {
  const state = await makeState();
  const key = 'direct:chat-1';
  const sessions = new Map();
  let serial = 0;
  const harness = {
    canChooseSessionId: true,
    async prepareConversationDirectory() { return null; },
    async createSession(opts) {
      serial += 1;
      return opts.sessionId ?? `session-new-${serial}`;
    },
    async bindWorkspaceSession(k, sessionId) {
      const meta = sessions.get(sessionId);
      await state.setSession(k, sessionId);
      await state.ensureSessionRing(k, sessionId, { title: meta?.title });
      return { sessionId, workspace: '/workspace', title: meta?.title ?? null, archived: meta?.archived === true };
    },
    workspaceSession(sessionId) {
      return {
        sessionId,
        async sessionExists() { return true; },
        async renameTitle(title) {
          sessions.set(sessionId, { ...(sessions.get(sessionId) ?? {}), title });
          return title;
        },
        readHistory() { return Promise.resolve([]); },
      };
    },
    async listWorkspaceSessions() {
      return { sessions: [...sessions.entries()].map(([sessionId, meta]) => ({ sessionId, title: meta?.title })) };
    },
    async isSessionArchived() { return false; },
  };
  const addSession = (sessionId, meta = {}) => sessions.set(sessionId, meta);
  const bind = (sessionId) => harness.bindWorkspaceSession(key, sessionId);
  return { state, harness, key, addSession, bind, sessions };
}

test('isResetCommand recognises /reset only', () => {
  assert.equal(isResetCommand('/reset'), true);
  assert.equal(isResetCommand('/reset  '), true);
  assert.equal(isResetCommand('/clear'), false);
  assert.equal(isResetCommand('/new'), false);
});

test('/reset reuses the same ring number and carries title and userTitled', async () => {
  const f = await resetFixture();
  f.addSession('old-session', { title: 'Custom' });
  await f.bind('old-session');
  await f.state.renameSessionRing(f.key, 1, 'Custom');
  await f.state.markSessionRingUserTitled(f.key, 1);

  const before = f.state.ringFor(f.key);
  const result = await runResetCommand('/reset', f.harness, f.state, f.key);

  assert.match(result.message, /编号保持不变/u);
  assert.match(result.message, /old-session/u, 'the old session id is named in the reply');

  const after = f.state.ringFor(f.key);
  assert.equal(after.entries.length, before.entries.length, '/ls does not grow');
  assert.deepEqual(after.entries.map((e) => e.n), before.entries.map((e) => e.n), 'numbers are unchanged');
  assert.notEqual(after.entries[0].sessionId, 'old-session', 'the session id changed');
  assert.equal(after.entries[0].title, 'Custom', 'the title is carried over');
  assert.equal(after.entries[0].userTitled, true, 'userTitled is carried over');

  const ls = await runSessionNavCommand('/ls', f.harness, f.state, f.key);
  assert.match(ls.message, /● 1\. /u, 'the same number is still the current entry');
});

test('/reset leaves the replaced session reachable via /session and session.list', async () => {
  const f = await resetFixture();
  f.addSession('old-session', { title: 'Old' });
  await f.bind('old-session');

  await runResetCommand('/reset', f.harness, f.state, f.key);

  const listed = await f.harness.listWorkspaceSessions('/workspace');
  assert.ok(listed.sessions.some((s) => s.sessionId === 'old-session'), 'the old session is still listed');
  assert.equal(f.state.sessionFor(f.key) !== 'old-session', true, 'the chat is no longer bound to the old session');

  // /session old-session rebinds it (reachable, not deleted).
  await f.harness.bindWorkspaceSession(f.key, 'old-session');
  assert.equal(f.state.sessionFor(f.key), 'old-session');
});

test('/reset with no prior session creates entry 1 like /new', async () => {
  const f = await resetFixture();
  const result = await runResetCommand('/reset', f.harness, f.state, f.key);
  assert.match(result.message, /已开启全新会话/u);
  const ring = f.state.ringFor(f.key);
  assert.equal(ring.entries.length, 1);
  assert.equal(ring.entries[0].n, 1);
});

test('/reset creation failure leaves the binding and ring untouched', async () => {
  const f = await resetFixture();
  f.addSession('old-session', { title: 'Custom' });
  await f.bind('old-session');
  await f.state.renameSessionRing(f.key, 1, 'Custom');
  await f.state.markSessionRingUserTitled(f.key, 1);

  f.harness.createSession = async () => { throw new Error('create failed'); };

  const result = await runResetCommand('/reset', f.harness, f.state, f.key);
  assert.match(result.message, /失败/u);

  const ring = f.state.ringFor(f.key);
  assert.equal(ring.entries.length, 1);
  assert.equal(ring.entries[0].sessionId, 'old-session', 'the entry keeps its session id');
  assert.equal(ring.entries[0].title, 'Custom');
  assert.equal(f.state.sessionFor(f.key), 'old-session', 'the binding is unchanged');
});

test('/reset never reaches the Host command registry', async () => {
  const f = await resetFixture();
  f.addSession('old-session', { title: 'Old' });
  await f.bind('old-session');
  let executeCalls = 0;
  f.harness.executeCommand = async () => { executeCalls += 1; return { result: { kind: 'success' } }; };

  await runResetCommand('/reset', f.harness, f.state, f.key);
  assert.equal(executeCalls, 0, '/reset must not call commands.execute');
});

test.after(() => Promise.all([...tempDirectories].map((d) => rm(d, { recursive: true, force: true }))));
