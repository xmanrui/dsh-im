import assert from 'node:assert/strict';
import test from 'node:test';

import { WecomHarnessClient } from '../src/channels/wecom/harness-client.mjs';
import { HarnessRpcError } from '../src/channels/shared/harness-client.mjs';
import { askInWorkspaceSession } from '../src/channels/shared/workspace-session.mjs';

for (const code of ['session-not-found', 'session/not-found']) {
  for (const transport of ['host-api', 'http']) {
    test(`${transport} rebuilds a missing binding for ${code} and reuses its replacement`, async () => {
      const calls = [], events = [], bindings = [];
      let bound = 'deleted-session';
      const handle = (method, { rpcId, payload }) => {
        calls.push({ method, payload });
        if (method === 'session.history' && payload.sessionId === 'deleted-session') {
          return { rpcId, result: { ok: false, error: { code, message: 'session missing' } } };
        }
        let value;
        if (method === 'host.describe') value = {};
        else if (method === 'workspace.list') value = {
          items: [{ workspaceId: 'workspace', path: '/workspace' }], archivedSessionIds: [],
        };
        else if (method === 'session.create') value = { sessionId: 'replacement-session' };
        else if (method === 'session.list') value = { items: [{ sessionId: bound, running: false }] };
        else if (method === 'session.history') value = { events: [...events] };
        else if (method === 'session.prompt') {
          assert.equal(payload.sessionId, 'replacement-session');
          const turn = events.length;
          for (const [type, data] of [
            ['user/message', { turn, source: { rpcId } }],
            ['assistant/message', { turn, message: { content: [{ type: 'text', text: 'recovered' }] } }],
            ['turn/end', { turn, reason: 'completed' }],
          ]) events.push({ event: { seq: events.length, type, data } });
          value = { accepted: true };
        } else assert.fail(`Unexpected RPC ${method}`);
        return { rpcId, result: { ok: true, value } };
      };
      const apiProxy = {};
      for (const method of ['host.describe', 'workspace.list', 'session.create',
        'session.list', 'session.history', 'session.prompt']) {
        const [domain, action] = method.split('.');
        const namespace = domain === 'session' ? 'sessions' : domain;
        (apiProxy[namespace] ??= {})[action] = request => handle(method, request);
      }
      const harness = new WecomHarnessClient({ workspace: '/workspace',
        ...(transport === 'host-api' ? { apiProxy } : {
          baseUrl: 'http://127.0.0.1:3080',
          fetchImpl: async (_url, options) => {
            const request = JSON.parse(options.body);
            return { ok: true, json: async () => ({
              type: 'server-response', ...handle(request.method, request),
            }) };
          },
        }),
      });
      const state = {
        sessionFor: () => bound,
        setSession: async (_key, id) => { bindings.push(id); bound = id; },
      };
      for (const text of ['first message', 'next message']) {
        assert.deepEqual(await askInWorkspaceSession({
          harness, state, key: 'direct:owner', text, askOptions: { timeoutMs: 2_000 },
        }), { sessionId: 'replacement-session', answer: 'recovered' });
      }
      // The conversation is bound to a planned id before creation, then to the id the
      // Harness actually returned; only the last binding has to be the replacement.
      assert.equal(bindings.at(-1), 'replacement-session');
      assert.ok(bindings.slice(0, -1).every(id => /^session-[0-9a-f-]{36}$/u.test(id)));
      assert.equal(calls.filter(call => call.method === 'session.create').length, 1);
      assert.equal(calls.filter(call => call.method === 'session.prompt').length, 2);
    });
  }
}

test('an unreadable or inaccessible Session does not silently replace its binding', async () => {
  for (const code of ['internal', 'gateway/internal', 'session/forbidden']) {
    const harness = new WecomHarnessClient({ apiProxy: {}, workspace: '/workspace' });
    harness.rpc = async method => {
      if (method === 'workspace.list') return { archivedSessionIds: [] };
      assert.equal(method, 'session.history');
      throw new HarnessRpcError(method, { code });
    };
    await assert.rejects(askInWorkspaceSession({
      harness, key: 'direct:owner', text: 'hello',
      state: { sessionFor: () => 'existing-session', setSession: () => assert.fail('rebound') },
    }), { code });
  }
});
