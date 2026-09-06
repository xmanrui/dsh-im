import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { runCompactCommand } from '../src/channels/shared/compact-command.mjs';
import {
  HarnessClient,
  HarnessRpcError,
} from '../src/channels/shared/harness-client.mjs';
import { createHarnessCommandExecutor } from '../plugin-src/host/harness-command-executor.mjs';

const PRODUCTION_FILES = [
  'plugin-src/host/channels/feishu/production.mjs',
  'plugin-src/host/channels/weixin/production.mjs',
  'plugin-src/host/channels/dingtalk/production.mjs',
  'plugin-src/host/channels/wecom/production.mjs',
  'plugin-src/host/channels/qq/production.mjs',
  'plugin-src/host/channels/slack/production.mjs',
  'plugin-src/host/channels/shared/production.mjs',
  'plugin-src/host/channels/whatsapp/production.mjs',
];

function state(sessionId = 'session-one') {
  return { sessionFor: () => sessionId };
}

function legacyImagesArgumentError(overrides = {}) {
  return Object.assign(new Error(
    'typert gateway: commands/execute: args fields do not match the descriptor: unexpected "images"',
  ), {
    name: 'TypertGatewayError',
    code: 'arguments-invalid',
    endpoint: 'commands/execute',
    ...overrides,
  });
}

test('compact command validates syntax and requires an existing conversation Session', async () => {
  assert.equal(await runCompactCommand('hello', {}, state(), 'direct:one'), null);
  assert.match(
    (await runCompactCommand('/compact now', {}, state(), 'direct:one')).message,
    /不带参数/,
  );
  assert.match(
    (await runCompactCommand('/COMPACT', {}, state(null), 'direct:one')).message,
    /还没有可压缩的会话/,
  );
  assert.match(
    (await runCompactCommand('/compact', {}, state(), 'direct:one')).message,
    /暂不支持/,
  );
});

test('compact command renders Harness outcomes and never changes the command line', async () => {
  const calls = [];
  const harness = {
    executeCommand: async (sessionId, line, options) => {
      calls.push({ sessionId, line, options });
      return {
        commandId: 'command-one',
        result: { kind: 'error', text: 'Compaction cancelled.' },
      };
    },
  };
  const signal = new AbortController().signal;
  const result = await runCompactCommand(
    ' /COMPACT ',
    harness,
    state(),
    'direct:one',
    { signal },
  );

  assert.equal(result.message, '上下文压缩已取消。');
  assert.deepEqual(calls, [{
    sessionId: 'session-one',
    line: '/compact',
    options: { signal },
  }]);
});

test('compact command contains unavailable, busy, stale, and invalid command failures', async () => {
  for (const [failure, pattern] of [
    [{ code: 'session-not-found' }, /会话已不存在/],
    [{ code: 'agent-busy' }, /正在生成回复/],
    [{ code: 'workspace-session-stale' }, /状态已发生变化/],
    [{ code: 'commands-unavailable' }, /暂不支持/],
    [new Error('private internal detail'), /压缩失败/],
  ]) {
    const result = await runCompactCommand('/compact', {
      executeCommand: async () => { throw failure; },
    }, state(), 'direct:one');
    assert.match(result.message, pattern);
    assert.doesNotMatch(result.message, /private internal detail/);
  }

  assert.match((await runCompactCommand('/compact', {
    executeCommand: async () => undefined,
  }, state(), 'direct:one')).message, /未注册/);
  assert.match((await runCompactCommand('/compact', {
    executeCommand: async () => ({ commandId: 'bad', result: { kind: 'other' } }),
  }, state(), 'direct:one')).message, /压缩失败/);
});

test('HarnessClient delegates command execution and normalizes Typert lookup failures', async () => {
  const calls = [];
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:1',
    workspace: '/tmp',
    commandExecutor: async (...args) => {
      calls.push(args);
      return { commandId: 'command-one', result: { kind: 'success' } };
    },
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await client.executeCommand('session-one', '/compact', { signal }), {
    commandId: 'command-one',
    result: { kind: 'success' },
  });
  assert.deepEqual(calls, [['session-one', '/compact', { signal }]]);

  const unavailable = new HarnessClient({ baseUrl: 'http://127.0.0.1:1', workspace: '/tmp' });
  await assert.rejects(unavailable.executeCommand('session-one', '/compact'), {
    code: 'commands-unavailable',
  });

  const rejected = new HarnessClient({
    baseUrl: 'http://127.0.0.1:1',
    workspace: '/tmp',
    commandExecutor: async () => {
      const error = new Error('lookup rejected');
      error.failure = { code: 'agent-busy', message: 'busy', details: { reason: 'turn active' } };
      throw error;
    },
  });
  await assert.rejects(
    rejected.executeCommand('session-one', '/compact'),
    (error) => error instanceof HarnessRpcError && error.code === 'agent-busy',
  );
});

test('Host command executor invokes the commands Typert endpoint with the Session identity', async () => {
  const requests = [];
  const executor = createHarnessCommandExecutor({
    typertGateway: { invoke: async (request) => {
      requests.push(request);
      return { commandId: 'command-one', result: { kind: 'success' } };
    } },
  });
  const signal = new AbortController().signal;

  assert.deepEqual(await executor('session-one', '/compact', { signal }), {
    commandId: 'command-one',
    result: { kind: 'success' },
  });
  assert.deepEqual(requests, [{
    namespace: 'commands',
    method: 'execute',
    // Newer Harness descriptors require images even for plain commands.
    args: { agentId: 'session-one', line: '/compact', images: [] },
    signal,
  }]);
  assert.equal(createHarnessCommandExecutor({}), undefined);
  assert.throws(() => createHarnessCommandExecutor({}, 'invalid'), /must be a function/);
});

test('compact executes once on older Harness after its gateway rejects the images field', async () => {
  const requests = [];
  let executions = 0;
  const signal = new AbortController().signal;
  const executor = createHarnessCommandExecutor({
    typertGateway: { invoke: async (request) => {
      requests.push(request);
      if (Object.hasOwn(request.args, 'images')) throw legacyImagesArgumentError();
      executions += 1;
      return {
        commandId: 'command-one',
        result: { kind: 'success', text: 'Compacted 5 history items (~200 tokens).' },
      };
    } },
  });
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:1', workspace: '/tmp', commandExecutor: executor,
  });

  const result = await runCompactCommand('/compact', client, state(), 'direct:one', { signal });
  assert.equal(result.message, '已压缩 5 条历史记录（约 200 个 token）。');
  assert.equal(executions, 1);
  assert.deepEqual(requests, [
    {
      namespace: 'commands', method: 'execute',
      args: { agentId: 'session-one', line: '/compact', images: [] }, signal,
    },
    {
      namespace: 'commands', method: 'execute',
      args: { agentId: 'session-one', line: '/compact' }, signal,
    },
  ]);
});

test('Host command executor never retries other gateway or business failures', async () => {
  const message = legacyImagesArgumentError().message;
  for (const failure of [
    new Error(message),
    legacyImagesArgumentError({ name: 'CommandError' }),
    legacyImagesArgumentError({ code: 'result-invalid' }),
    legacyImagesArgumentError({ endpoint: 'other/execute' }),
    legacyImagesArgumentError({ message: message.replace('unexpected "images"', 'missing "images"') }),
    legacyImagesArgumentError({ message: `${message}, "other"` }),
    Object.assign(new Error('busy'), { failure: { code: 'agent-busy' } }),
    new Error('compaction failed after starting'),
  ]) {
    let attempts = 0;
    const executor = createHarnessCommandExecutor({
      typertGateway: { invoke: async () => { attempts += 1; throw failure; } },
    });
    await assert.rejects(executor('session-one', '/compact'), (error) => error === failure);
    assert.equal(attempts, 1);
  }
});

test('compact adapts to submittedAttachments descriptors and never retries dispatched failures', async () => {
  const mismatch = () => legacyImagesArgumentError({ code: 'gateway/arguments-invalid', message:
    'typert gateway: commands/execute: args fields do not match the descriptor: missing "submittedAttachments"; unexpected "images"' });
  for (const failure of [null, new Error('compaction failed after starting')]) {
    const requests = [];
    let executions = 0;
    const executor = createHarnessCommandExecutor({ typertGateway: { invoke: async (request) => {
      requests.push(request);
      if (Object.hasOwn(request.args, 'images')) throw mismatch();
      assert.deepEqual(request.args, { agentId: 'session-one', line: '/compact', submittedAttachments: [] });
      executions += 1;
      if (failure) throw failure;
      return { commandId: 'compact-one', result: { kind: 'success', text: 'Compacted 2 history items (~40 tokens).' } };
    } } });
    if (failure) await assert.rejects(executor('session-one', '/compact'), (error) => error === failure);
    else assert.equal((await executor('session-one', '/compact')).result.kind, 'success');
    assert.equal(executions, 1);
    assert.equal(requests.length, 2);
  }
  const controller = new AbortController();
  let attempts = 0;
  const executor = createHarnessCommandExecutor({ typertGateway: { invoke: async () => {
    attempts += 1;
    controller.abort();
    throw mismatch();
  } } });
  await assert.rejects(executor('session-one', '/compact', { signal: controller.signal }), (error) => error === controller.signal.reason);
  assert.equal(attempts, 1);
});

test('Host command executor does not repeat a failed legacy invocation', async () => {
  let attempts = 0;
  const failure = new Error('compaction failed after starting');
  const executor = createHarnessCommandExecutor({
    typertGateway: { invoke: async () => {
      attempts += 1;
      if (attempts === 1) throw legacyImagesArgumentError();
      throw failure;
    } },
  });
  await assert.rejects(executor('session-one', '/compact'), (error) => error === failure);
  assert.equal(attempts, 2);
});

test('Host command executor preserves an unresolved command on the legacy endpoint', async () => {
  let attempts = 0;
  const executor = createHarnessCommandExecutor({
    typertGateway: { invoke: async () => {
      attempts += 1;
      if (attempts === 1) throw legacyImagesArgumentError();
      return undefined;
    } },
  });
  assert.equal(await executor('session-one', '/compact'), undefined);
  assert.equal(attempts, 2);
});

test('Host command executor honours cancellation before retrying the legacy endpoint', async () => {
  let attempts = 0;
  const controller = new AbortController();
  const executor = createHarnessCommandExecutor({
    typertGateway: { invoke: async () => {
      attempts += 1;
      controller.abort();
      throw legacyImagesArgumentError();
    } },
  });
  await assert.rejects(
    executor('session-one', '/compact', { signal: controller.signal }),
    (error) => error === controller.signal.reason,
  );
  assert.equal(attempts, 1);
});

test('all nine production channels receive the Host command executor', async () => {
  for (const path of PRODUCTION_FILES) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.match(source, /createHarnessCommandExecutor\(ctx, internals\.commandExecutor\)/, path);
    assert.match(source, /commandExecutor \? \{ commandExecutor \} : \{\}/, path);
  }

  for (const channel of [
    'feishu', 'weixin', 'dingtalk', 'wecom', 'qq',
    'slack', 'telegram', 'discord', 'whatsapp',
  ]) {
    const source = await readFile(
      new URL(`../plugin-src/host/channels/${channel}/index.mjs`, import.meta.url),
      'utf8',
    );
    assert.match(source, /'typertGateway'/, channel);
  }
});

test('all nine production channels use channel presets only as bot creation defaults', async () => {
  for (const path of PRODUCTION_FILES) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bagentPreset:\s*config\.agentPreset/, path);
    const creationDefaults = (source.match(
      /workspaces\.ensure\((?:(?!workspaces\.ensure)[\s\S])*?\n\s*\}\)/g,
    ) ?? []).filter((call) => (
      /\bdefaultAgentPreset:\s*config\.agentPreset\b/.test(call)
    ));
    assert.equal(
      creationDefaults.length,
      2,
      `${path} must initialize both restored and newly connected bots`,
    );
    assert.match(
      source,
      /const agentPresetCatalog\s*=\s*\(\)\s*=>\s*listAgentPresetCatalog\(ctx\)/,
      `${path} must read the Host preset catalog dynamically`,
    );
    assert.match(
      source,
      /createBotWorkspaceScope\([^;]*agentPresetCatalog[^;]*\)/,
      `${path} must expose the same dynamic catalog to bot commands`,
    );
    assert.match(
      source,
      /createWorkspaceAwareController\([^;]*agentPresetCatalog,?[^;]*\)/,
      `${path} must expose the same dynamic catalog to RPC updates`,
    );
  }

  for (const channel of ['telegram', 'discord']) {
    const source = await readFile(
      new URL(`../plugin-src/host/channels/${channel}/production.mjs`, import.meta.url),
      'utf8',
    );
    assert.match(
      source,
      /createTokenProductionController\(ctx, config, internals,/,
      `${channel} must delegate to the shared production assembly`,
    );
  }
});
