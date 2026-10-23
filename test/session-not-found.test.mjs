import assert from 'node:assert/strict';
import test from 'node:test';
import { HarnessClient, HarnessRpcError } from '../src/channels/shared/harness-client.mjs';
import { askInWorkspaceSession } from '../src/channels/shared/workspace-session.mjs';
import { classifyMessageFailure } from '../src/channels/shared/message-failure.mjs';

const STALE = 'deleted-session';
const FRESH = 'fresh-session';
// DSH 0.2.x Hosts report a missing Session with the slash form.
const NOT_FOUND_CODES = ['session-not-found', 'session/not-found'];
const event = (seq, type, data) => ({ event: { seq, type, data } });

function fixture(missingCode, { archivedOnRecheck = false } = {}) {
  const f = { prompts: [], created: 0, events: [], archiveReads: 0 };
  const client = new HarnessClient({ baseUrl: 'http://127.0.0.1:3080', workspace: '/tmp' });
  client.rpc = async (method, payload, _timeout, options) => {
    options?.signal?.throwIfAborted();
    if (method === 'host.describe') return {};
    if (method === 'workspace.list') {
      f.archiveReads++;
      return { archivedSessionIds: archivedOnRecheck && f.archiveReads > 1 ? [STALE] : [] };
    }
    if (method === 'session.history') {
      if (payload.sessionId === STALE) throw new HarnessRpcError(method, { code: missingCode, message: 'gone' });
      return { events: [...f.events] };
    }
    if (method === 'session.list') return { items: [{ sessionId: FRESH, running: false }] };
    if (method === 'session.prompt') {
      f.prompts.push(payload.sessionId);
      f.events.push(event(1, 'turn/start', { turn: 1 }),
        event(2, 'user/message', { turn: 1, source: { rpcId: options.rpcId } }),
        event(3, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'ok' }] } }),
        event(4, 'turn/end', { turn: 1, reason: 'completed' }));
      return { accepted: true };
    }
    assert.fail(`Unexpected RPC ${method}`);
  };
  client.createSession = async () => { f.created++; return FRESH; };
  f.client = client;
  return f;
}

for (const code of NOT_FOUND_CODES) {
  test(`sessionExists treats ${code} as a missing Session`, async () => {
    assert.equal(await fixture(code).client.sessionExists(STALE), false);
  });

  test(`a binding to a Session reported as ${code} is rebound before the prompt`, async () => {
    const f = fixture(code);
    let bound = STALE;
    await askInWorkspaceSession({
      harness: f.client,
      state: { sessionFor: () => bound, setSession: async (_key, value) => { bound = value; } },
      key: 'direct:owner',
      text: 'hello',
      askOptions: { timeoutMs: 650 },
    });
    assert.equal(f.created, 1);
    assert.equal(bound, FRESH);
    assert.deepEqual(f.prompts, [FRESH]);
  });

  test(`a Session archived while ${code} is diagnosed still exists`, async () => {
    const f = fixture(code, { archivedOnRecheck: true });
    assert.equal(await f.client.sessionExists(STALE), true);
    assert.equal(f.archiveReads, 2);
  });

  test(`${code} is classified as SESSION_NOT_FOUND`, () => {
    assert.equal(classifyMessageFailure(new HarnessRpcError('session.history', { code })).code, 'SESSION_NOT_FOUND');
  });
}

test('other session.history failures still propagate from sessionExists', async () => {
  await assert.rejects(fixture('internal').client.sessionExists(STALE), { code: 'internal' });
});
