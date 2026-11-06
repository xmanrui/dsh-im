import assert from 'node:assert/strict';
import test from 'node:test';
import { HarnessClient, HarnessRpcError, HarnessTransportError } from '../src/channels/shared/harness-client.mjs';
import { askInWorkspaceSession } from '../src/channels/shared/workspace-session.mjs';
import { classifyMessageFailure } from '../src/channels/shared/message-failure.mjs';
import { getImHostLanguage, setImHostLanguage, t as translate } from '../src/channels/shared/i18n.mjs';
import { COMMAND_PERMISSION_DENIED_MESSAGE } from '../src/channels/shared/inbound-access.mjs';

const SESSION = 'archive-session';
const event = (seq, type, data) => ({ event: { seq, type, data } });

test('HTTP RPC archive checks preserve the binding and never load a corrupt log', async () => {
  const calls = [];
  const client = new HarnessClient({ baseUrl: 'http://127.0.0.1:3080', workspace: '/tmp',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      calls.push(request.method);
      assert.ok(['host.describe', 'workspace.list'].includes(request.method));
      return { ok: true, json: async () => ({ type: 'server-response', rpcId: request.rpcId,
        result: { ok: true, value: request.method === 'workspace.list' ? { archivedSessionIds: [SESSION] } : {} },
      }) };
    },
  });
  assert.equal(await client.sessionExists(SESSION), true);
  await assert.rejects(client.ask(SESSION, 'hello'), { code: 'session-archived', promptAccepted: false });
  assert.deepEqual(calls, ['workspace.list', 'host.describe', 'workspace.list']);
});

function fixture(options = {}) {
  const f = { archived: false, calls: [], events: [], prompt: null, archiveReads: 0 };
  const client = new HarnessClient({ baseUrl: 'http://127.0.0.1:3080', workspace: '/tmp', ...options });
  client.rpc = async (method, payload, _timeout, options) => {
    f.calls.push(method);
    options?.signal?.throwIfAborted();
    if (method === 'host.describe') return {};
    if (method === 'workspace.list') {
      f.archiveReads++;
      return f.readArchive ? f.readArchive() : { archivedSessionIds: f.archived ? [SESSION] : [] };
    }
    if (method === 'session.history') return f.readHistory ? f.readHistory() : { events: [...f.events] };
    if (method === 'session.list') return { items: [{ sessionId: SESSION, running: false }] };
    if (method === 'session.prompt') {
      f.prompt = options.rpcId;
      if (f.onPrompt) return f.onPrompt();
      f.events.push(event(1, 'turn/start', { turn: 1 }),
        event(2, 'user/message', { turn: 1, source: { rpcId: f.prompt } }),
        event(3, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '正常回复' }] } }),
        event(4, 'turn/end', { turn: 1, reason: 'completed' }));
      return { accepted: true };
    }
    assert.fail(`Unexpected RPC ${method}`);
  };
  f.client = client;
  f.ask = (options = {}) => client.ask(SESSION, 'hello', { timeoutMs: 650, ...options });
  return f;
}

test('archived bindings remain present and fail before history, files, subscriptions or prompt', async () => {
  const f = fixture(); f.archived = true;
  assert.equal(await f.client.sessionExists(SESSION), true);
  let bound = SESSION;
  await assert.rejects(askInWorkspaceSession({
    harness: f.client,
    state: { sessionFor: () => bound, setSession: async (_key, value) => { bound = value; assert.fail('rebound'); } },
    key: 'direct:owner', text: 'hello',
    askOptions: { files: [{ name: 'test.txt', load: () => assert.fail('loaded') }],
      onInteraction: () => assert.fail('interaction') },
  }), (error) => {
    assert.equal(error.code, 'session-archived');
    assert.equal(error.promptAccepted, false);
    assert.equal(classifyMessageFailure(error).code, 'SESSION_ARCHIVED');
    return true;
  });
  assert.equal(bound, SESSION);
  assert.deepEqual(f.calls, ['workspace.list', 'workspace.list', 'host.describe', 'workspace.list']);
  f.archived = false;
  assert.equal(await f.ask(), '正常回复', 'unarchiving works without clearing or caching the binding');
});

for (const phase of ['exists', 'initial-history', 'prompt', 'poll']) {
  test(`archive racing ${phase} preserves the original internal failure`, async () => {
    const f = fixture();
    const original = new HarnessRpcError(phase === 'prompt' ? 'session.prompt' : 'session.history',
      { code: 'internal', message: 'corrupt Zstandard session log' });
    if (phase === 'prompt') f.onPrompt = () => { f.archived = true; throw original; };
    else f.readHistory = () => {
      if (phase === 'poll' && !f.prompt) return { events: [] };
      f.archived = true; throw original;
    };
    if (phase === 'exists') assert.equal(await f.client.sessionExists(SESSION), true);
    else await assert.rejects(f.ask(), (error) => {
      assert.equal(error.code, 'session-archived');
      assert.equal(error.cause, original);
      assert.equal(error.promptAccepted, phase === 'poll');
      return true;
    });
  });
}

for (const owned of [false, true]) {
  test(`blocked archive exits promptly with correct ownership (owned=${owned})`, async () => {
    const f = fixture();
    f.onPrompt = () => {
      f.archived = true;
      f.events.push(event(1, 'turn/start', { turn: 7 }));
      if (owned) f.events.push(event(2, 'user/message', { turn: 7, source: { rpcId: f.prompt } }));
      f.events.push(event(3, 'turn/end', { turn: 7, reason: { kind: 'blocked' } }));
    };
    await assert.rejects(f.ask({ timeoutMs: 60_000, signal: AbortSignal.timeout(2500) }), (error) => {
      assert.equal(error.code, 'session-archived');
      assert.equal(error.promptAccepted, true);
      assert.equal(error.details.turn, owned ? 7 : null);
      assert.match(classifyMessageFailure(error).message, /仍在会话队列/);
      return true;
    });
    assert.equal(f.calls.filter((method) => method === 'session.prompt').length, 1);
  });
}

test('owned non-archive blocking retains TURN_BLOCKED and successful replies beat an archive race', async () => {
  const f = fixture();
  f.onPrompt = () => f.events.push(event(1, 'user/message', { turn: 1, source: { rpcId: f.prompt } }),
    event(2, 'turn/end', { turn: 1, reason: 'blocked' }));
  await assert.rejects(f.ask(), (error) => {
    assert.equal(error.code, 'turn-blocked');
    assert.match(classifyMessageFailure(error).message, /本轮处理被阻止/);
    return true;
  });
  const success = fixture();
  success.readHistory = () => { if (success.prompt) success.archived = true; return { events: success.events }; };
  assert.equal(await success.ask(), '正常回复');
});

test('unowned blocked events only trigger one recheck and never claim another request', async () => {
  const f = fixture();
  f.events.push(event(8, 'turn/end', { turn: 1, reason: 'blocked' }));
  f.onPrompt = () => f.events.push(event(9, 'turn/start', { turn: 2 }),
    event(10, 'user/message', { turn: 2, source: { rpcId: 'web-request' } }),
    event(11, 'turn/end', { turn: 2, reason: 'blocked' }));
  await assert.rejects(f.ask(), (error) => {
    assert.equal(error.code, 'harness-reply-timeout');
    assert.equal(error.details.turn, null);
    return true;
  });
  assert.equal(f.archiveReads, 3, 'preflight, one blocked check and timeout; no repeated history checks');
});

test('old blocked history does not trigger a new archive lookup', async () => {
  const f = fixture();
  f.events.push(event(8, 'turn/end', { turn: 1, reason: 'blocked' }));
  f.onPrompt = () => {};
  await assert.rejects(f.ask(), { code: 'harness-reply-timeout' });
  assert.equal(f.archiveReads, 2);
});

test('unowned archive blocking releases the watcher but retains files the accepted prompt may still need', async () => {
  let cleaned = false;
  let watcherClosed = false;
  const f = fixture({ fileIngressExecutor: async () => ({
    files: [{ name: 'test.txt', path: '/tmp/test.txt', size: 4 }],
    cleanup: async () => { cleaned = true; },
  }) });
  f.client.watchInteractions = async (_id, { signal, onOpen }) => {
    onOpen();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    watcherClosed = true;
  };
  f.onPrompt = () => {
    f.archived = true;
    f.events.push(event(1, 'turn/start', { turn: 1 }), event(2, 'turn/end', { turn: 1, reason: 'blocked' }));
  };
  await assert.rejects(f.ask({ files: [{ name: 'test.txt', data: Buffer.from('test') }],
    onInteraction() {}, signal: AbortSignal.timeout(2500),
  }), { code: 'session-archived', promptAccepted: true });
  assert.equal(watcherClosed, true);
  assert.equal(cleaned, false);
});

test('failed blocked recheck retries at timeout and preserves cancellation', async () => {
  const f = fixture();
  f.readArchive = () => {
    if (f.archiveReads === 2) throw new Error('lookup failed');
    return { archivedSessionIds: f.prompt ? [SESSION] : [] };
  };
  f.onPrompt = () => f.events.push(event(1, 'turn/end', { turn: 1, reason: 'blocked' }));
  await assert.rejects(f.ask(), { code: 'session-archived', promptAccepted: true });
  assert.equal(f.archiveReads, 3);
  const controller = new AbortController();
  const canceled = fixture();
  canceled.readHistory = () => { controller.abort(); throw new HarnessRpcError('session.history', { code: 'internal' }); };
  await assert.rejects(canceled.ask({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(canceled.archiveReads, 1);
});

test('unknown archive state is an error; confirmed non-archive corruption and failed diagnosis preserve the cause', async () => {
  for (const value of [undefined, {}, { archivedSessionIds: [null] }]) {
    const f = fixture(); f.readArchive = () => value;
    await assert.rejects(f.ask(), { code: 'harness-response-invalid', method: 'workspace.list' });
    assert.equal(f.prompt, null);
  }
  for (const failLookup of [false, true]) {
    const f = fixture();
    const original = new HarnessRpcError('session.history', { code: 'internal', message: 'real corruption' });
    f.readHistory = () => { throw original; };
    f.readArchive = () => {
      if (failLookup && f.archiveReads > 1) throw new Error('diagnostic failed');
      return { archivedSessionIds: [] };
    };
    await assert.rejects(f.ask(), (error) => {
      assert.deepEqual(error, original);
      return true;
    });
  }
});

test('network, model and attachment failures are not replaced by archive diagnostics', async () => {
  for (const error of [new HarnessTransportError('harness-timeout', 'session.prompt'),
    new HarnessRpcError('session.prompt', { code: 'model-unavailable' }),
    new HarnessRpcError('session.prompt', { code: 'attachment-error' })]) {
    const f = fixture(); f.onPrompt = () => { f.archived = true; throw error; };
    await assert.rejects(f.ask(), (actual) => {
      assert.deepEqual(actual, error);
      return true;
    });
    assert.equal(f.archiveReads, 1);
  }
});

test('archive notices and blocked notices translate and retain references without leaking causes', (t) => {
  const original = getImHostLanguage(); t.after(() => setImHostLanguage(original));
  for (const language of ['zh-CN', 'en']) {
    setImHostLanguage(language);
    for (const accepted of [false, true]) {
      const failure = classifyMessageFailure({ code: 'session-archived', promptAccepted: accepted,
        cause: new Error('private Zstandard detail') }, { referenceId: 'MF-ARCHIVE' });
      assert.equal(failure.code, 'SESSION_ARCHIVED');
      assert.equal(failure.message.includes(language === 'en' ? 'queued' : '队列'), accepted);
      assert.match(failure.message, language === 'en'
        ? /If you have command permission.*\/new.*administrator.*unarchive.*grant/u
        : /有命令权限.*\/new.*管理员.*取消归档.*开启命令权限/u);
      assert.doesNotMatch(JSON.stringify(failure), /private Zstandard/);
      if (language === 'en') assert.doesNotMatch(failure.message, /[\u4e00-\u9fff]/);
    }
    const denied = translate(COMMAND_PERMISSION_DENIED_MESSAGE);
    assert.match(denied, language === 'en'
      ? /administrator.*command permission.*direct or group chat.*Access Settings/u
      : /管理员.*访问设置.*私聊或群聊.*命令权限/u);
    if (language === 'en') assert.doesNotMatch(denied, /[\u4e00-\u9fff]/u);
  }
});
