import assert from 'node:assert/strict';
import test from 'node:test';
import { HarnessClient } from '../src/channels/shared/harness-client.mjs';
import { askInWorkspaceSession } from '../src/channels/shared/workspace-session.mjs';
import { classifyMessageFailure, messageFailureDiagnostic } from '../src/channels/shared/message-failure.mjs';
import { getImHostLanguage, setImHostLanguage } from '../src/channels/shared/i18n.mjs';

const corruptMessage = 'stored session "old-session" is corrupt: stored log is corrupt: SessionFormatError: PTC dispatch repeats subCallId (raw log: /private/session.v4.jsonl.zstd)';

function fixture({ transport = 'host-api', code = 'internal', message = corruptMessage, phase = 'exists' } = {}) {
  const f = { bound: 'old-session', calls: [], notices: [], created: 0, submitted: 0, archived: false,
    archiveReads: 0, historyReads: 0, events: [] };
  const handle = (method, { rpcId, payload }) => {
    f.calls.push([method, payload]);
    const fail = () => ({ rpcId, result: { ok: false, error: { code, message, details: { reason: 'unknown' } } } });
    const isOld = payload.sessionId === 'old-session';
    let value;
    if (method === 'workspace.list') {
      f.archiveReads++;
      if (f.failRecheck && f.archiveReads > 1) return { rpcId, result: { ok: false, error: { code: 'internal', message: 'temporary lookup failure' } } };
      value = { items: [{ workspaceId: 'workspace', path: '/workspace' }], archivedSessionIds: f.archived ? ['old-session'] : [] };
    } else if (method === 'host.describe') value = {};
    else if (method === 'session.history') {
      f.historyReads++;
      if ((isOld || f.corruptReplacement) && (phase === 'exists'
        || (phase === 'initial-history' && f.historyReads >= 2)
        || (phase === 'poll' && f.submitted))) {
        if (f.archiveOnFailure) f.archived = true;
        return fail();
      }
      value = { events: [...f.events] };
    } else if (method === 'session.create') {
      f.created++;
      if (f.failCreate) return { rpcId, result: { ok: false, error: { code: 'internal', message: 'create failed' } } };
      value = { sessionId: 'new-session' };
    } else if (method === 'session.list') value = { items: [{ sessionId: f.bound, running: false }] };
    else if (method === 'session.prompt') {
      f.submitted++;
      if (phase === 'submit') return fail();
      const turn = f.submitted;
      for (const [type, data] of [
        ['user/message', { turn, source: { rpcId } }],
        ['assistant/message', { turn, message: { content: [{ type: 'text', text: 'recovered answer' }] } }],
        ['turn/end', { turn, reason: 'completed' }],
      ]) f.events.push({ event: { seq: f.events.length, type, data } });
      value = { accepted: true };
    } else assert.fail(`Unexpected RPC ${method}`);
    return { rpcId, result: { ok: true, value } };
  };
  const apiProxy = {};
  for (const method of ['workspace.list', 'host.describe', 'session.history', 'session.create', 'session.list', 'session.prompt']) {
    const [domain, action] = method.split('.');
    (apiProxy[domain === 'session' ? 'sessions' : domain] ??= {})[action] = request => handle(method, request);
  }
  f.harness = new HarnessClient({ workspace: '/workspace', ...(transport === 'host-api' ? { apiProxy } : {
    baseUrl: 'http://127.0.0.1:3080', fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      return { ok: true, json: async () => ({ type: 'server-response', ...handle(request.method, request) }) };
    },
  }) });
  f.state = { sessionFor: () => f.bound, setSession: async (_key, id) => {
    if (f.failPersist) throw new Error('state write failed');
    f.bound = id;
  } };
  f.ask = (overrides = {}) => askInWorkspaceSession({ harness: f.harness, state: f.state,
    key: 'direct:owner', text: 'hello', askOptions: { timeoutMs: 2_000 },
    onNotice: async notice => {
      assert.equal(f.bound, 'new-session', 'persist before notifying');
      assert.equal(f.submitted, 0, 'notify before submitting');
      f.notices.push(notice);
    }, ...overrides,
  });
  return f;
}

for (const transport of ['host-api', 'http']) {
  for (const code of ['internal', 'gateway/internal']) {
    for (const phase of ['exists', 'initial-history']) {
      test(`${transport} ${code} recovers ${phase} corruption once and reuses the new binding`, async () => {
        const f = fixture({ transport, code, phase });
        for (let i = 0; i < 2; i++) assert.deepEqual(await f.ask(), { sessionId: 'new-session', answer: 'recovered answer' });
        assert.equal(f.created, 1);
        assert.equal(f.submitted, 2);
        assert.equal(f.notices.length, 1);
        assert.match(f.notices[0], /日志已损坏.*新会话.*原会话记录已保留.*上下文/u);
        assert.doesNotMatch(f.notices[0], /private|SessionFormatError/u);
        assert.ok(f.calls.filter(([method]) => method === 'session.prompt').every(([, p]) => p.sessionId === 'new-session'));
      });
    }
  }
}

for (const phase of ['submit', 'poll']) {
  test(`corruption during ${phase} is diagnosed without rebinding or replaying a possibly submitted prompt`, async () => {
    const f = fixture({ phase });
    await assert.rejects(f.ask(), error => {
      const failure = classifyMessageFailure(error);
      assert.equal(failure.code, 'SESSION_UNREADABLE');
      assert.equal(failure.details.reason, 'session-log-corrupt');
      assert.equal(failure.details.submissionState, phase === 'submit' ? 'unknown' : 'accepted');
      assert.equal(failure.details.transport, 'host-api');
      assert.match(error.cause.message, /SessionFormatError/u);
      assert.doesNotMatch(JSON.stringify(messageFailureDiagnostic(error, failure)), /private|SessionFormatError/u);
      return true;
    });
    assert.equal(f.created, 0);
    assert.equal(f.submitted, 1);
    assert.equal(f.bound, 'old-session');
    assert.deepEqual(f.notices, []);
  });
}

for (const [code, message] of [
  ['internal', 'temporary backend failure'], ['gateway/internal', 'connection reset'],
  ['session/forbidden', corruptMessage], ['harness-timeout', corruptMessage],
  ['internal', 'tool response is corrupt'], ['internal', 'PTC dispatch repeats subCallId'],
]) {
  test(`${code}: ${message.slice(0, 30)} does not replace a binding`, async () => {
    const f = fixture({ code, message });
    await assert.rejects(f.ask(), { code });
    assert.equal(f.created, 0);
    assert.equal(f.submitted, 0);
    assert.equal(f.bound, 'old-session');
    assert.deepEqual(f.notices, []);
  });
}

for (const race of [false, true]) {
  test(`archive takes priority over corruption (race=${race})`, async () => {
    const f = fixture();
    f.archived = !race;
    f.archiveOnFailure = race;
    await assert.rejects(f.ask(), { code: 'session-archived' });
    assert.equal(f.created, 0);
    assert.equal(f.submitted, 0);
    assert.equal(f.bound, 'old-session');
    assert.deepEqual(f.notices, []);
  });
}

test('failed archive diagnosis keeps the original failure and binding', async () => {
  const f = fixture(); f.failRecheck = true;
  await assert.rejects(f.ask(), { code: 'internal' });
  assert.equal(f.created, 0);
  assert.equal(f.bound, 'old-session');
});

test('a DS Bot owns its Session and is never silently rebound', async () => {
  const f = fixture(); f.harness.resolveDsBotSession = async () => 'old-session';
  await assert.rejects(f.ask(), { code: 'session-unreadable' });
  assert.equal(f.created, 0);
  assert.equal(f.bound, 'old-session');
});

test('a corrupt replacement stops recovery after one creation', async () => {
  const f = fixture(); f.corruptReplacement = true;
  await assert.rejects(f.ask(), { code: 'session-unreadable' });
  assert.equal(f.created, 1);
  assert.equal(f.submitted, 0);
  assert.equal(f.notices.length, 1);
});

for (const failing of ['failCreate', 'failPersist']) {
  test(`${failing} preserves the old binding and sends no success notice`, async () => {
    const f = fixture(); f[failing] = true;
    await assert.rejects(f.ask());
    assert.equal(f.bound, 'old-session');
    assert.equal(f.submitted, 0);
    assert.deepEqual(f.notices, []);
  });
}

test('a failed recovery notice does not submit the message', async () => {
  const f = fixture();
  await assert.rejects(f.ask({ onNotice: async () => { throw new Error('delivery failed'); } }), /delivery failed/u);
  assert.equal(f.bound, 'new-session');
  assert.equal(f.submitted, 0);
});

test('concurrent corruption failures share one replacement', async () => {
  const f = fixture();
  f.harness.ask = async id => { assert.equal(id, 'new-session'); return 'ok'; };
  const results = await Promise.all([f.ask(), f.ask()]);
  assert.ok(results.every(result => result.sessionId === 'new-session'));
  assert.equal(f.created, 1);
  assert.equal(f.notices.length, 1);
});

test('cancellation does not replace the binding', async () => {
  const f = fixture();
  await assert.rejects(f.ask({ existsOptions: { signal: AbortSignal.abort() } }), { name: 'AbortError' });
  assert.equal(f.created, 0);
});

test('recovery notices and unreadable errors are translated', async t => {
  const language = getImHostLanguage(); t.after(() => setImHostLanguage(language));
  for (const locale of ['en', 'ru']) {
    setImHostLanguage(locale);
    const f = fixture(); await f.ask();
    assert.doesNotMatch(f.notices[0], /[\u4e00-\u9fff]/u);
    const failure = classifyMessageFailure({ code: 'session-unreadable' });
    assert.equal(failure.code, 'SESSION_UNREADABLE');
    assert.doesNotMatch(failure.message, /[\u4e00-\u9fff]/u);
  }
});

test('an alternate adapter with unknown submission state is never replayed', async () => {
  const f = fixture({ phase: 'submit' });
  f.harness.ask = async () => {
    f.submitted++;
    throw Object.assign(new Error('unreadable'), { code: 'session-unreadable' });
  };
  await assert.rejects(f.ask(), { code: 'session-unreadable' });
  assert.equal(f.submitted, 1);
  assert.equal(f.created, 0);
  assert.equal(f.bound, 'old-session');
});

test('recovery does not overwrite a binding changed while the corrupt history was loading', async () => {
  const f = fixture();
  const exists = f.harness.sessionExists.bind(f.harness);
  f.harness.sessionExists = async (...args) => {
    try { return await exists(...args); }
    catch (error) { f.bound = 'manually-selected-session'; throw error; }
  };
  assert.deepEqual(await f.ask(), { sessionId: 'manually-selected-session', answer: 'recovered answer' });
  assert.equal(f.bound, 'manually-selected-session');
  assert.equal(f.created, 0);
  assert.deepEqual(f.notices, []);
});
