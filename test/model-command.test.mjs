import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isModelCommand,
  runModelCommand,
} from '../src/channels/shared/model-command.mjs';

const CATALOG = Object.freeze({
  groups: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ],
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      models: [{ id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' }],
    },
  ],
  failures: [],
});

const REASONING_CATALOG = Object.freeze({
  groups: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        {
          id: 'deepseek-v4-flash',
          name: 'DeepSeek V4 Flash',
          reasoning: {
            efforts: [
              { id: 'off', name: 'Off' },
              { id: 'high', name: 'High', description: '复杂任务' },
              { id: 'max', name: 'Max' },
            ],
            defaultEffort: 'high',
          },
        },
        {
          id: 'deepseek-v4-pro',
          name: 'DeepSeek V4 Pro',
          reasoning: {
            efforts: [
              { id: 'medium', name: 'Medium' },
              { id: 'xhigh', name: 'XHigh' },
            ],
            defaultEffort: 'medium',
          },
        },
      ],
    },
    CATALOG.groups[1],
  ],
  failures: [],
});

function reasoningSessionCatalog(current = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
}) {
  return {
    ...REASONING_CATALOG,
    current,
    routable: true,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function fixture({
  initialSessionId = null,
  existing = true,
  globalCatalog = CATALOG,
  sessionCatalog = {
    ...CATALOG,
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
  },
  running = false,
  activeTurn = false,
  selectionError = null,
  selectionResult,
  selectionReadback,
  selectModelHook,
  setSessionResult,
} = {}) {
  const calls = [];
  let boundId = initialSessionId;
  const selectedModels = new Map();
  const session = (sessionId) => ({
    async sessionExists(options) {
      calls.push(['sessionExists', sessionId, options]);
      return typeof existing === 'function' ? existing(sessionId) : existing;
    },
    async models(options) {
      calls.push(['models', sessionId, options]);
      if (sessionCatalog instanceof Error) throw sessionCatalog;
      const current = selectedModels.get(sessionId) ?? sessionCatalog.current;
      return { ...sessionCatalog, current };
    },
    async isRunning(options) {
      calls.push(['isRunning', sessionId, options]);
      return running;
    },
    async hasActiveTurn(control, options) {
      calls.push(['hasActiveTurn', sessionId, control, options]);
      return activeTurn;
    },
    async selectModel(selection, options) {
      calls.push(['selectModel', sessionId, selection, options]);
      if (selectModelHook) await selectModelHook({ sessionId, selection, options });
      if (selectionError) throw selectionError;
      const selected = selectionResult ?? selection;
      selectedModels.set(sessionId, selectionReadback ?? selection);
      return { selected };
    },
  });
  const state = {
    sessionFor(key) {
      calls.push(['sessionFor', key]);
      return boundId;
    },
    async setSession(key, sessionId) {
      calls.push(['setSession', key, sessionId]);
      if (setSessionResult === false) return false;
      boundId = sessionId;
      return setSessionResult;
    },
    async clearSession(key) {
      calls.push(['clearSession', key]);
      boundId = null;
    },
  };
  const harness = {
    async listModels(options) {
      calls.push(['listModels', options]);
      if (globalCatalog instanceof Error) throw globalCatalog;
      return globalCatalog;
    },
    workspaceSession(sessionId) {
      calls.push(['workspaceSession', sessionId]);
      return session(sessionId);
    },
    async createSession(options) {
      calls.push(['createSession', options]);
      return 'session-created';
    },
  };
  return { calls, harness, state, boundId: () => boundId };
}

function defaultModelFixture({
  current = null,
  catalog = CATALOG,
  catalogError = null,
} = {}) {
  const calls = [];
  let stored = current;
  const harness = {
    async listModels(options) {
      calls.push(['listModels', options]);
      if (catalogError) throw catalogError;
      return catalog;
    },
    async defaultModelSettings(options) {
      calls.push(['defaultModelSettings', options]);
      return { defaultModel: stored };
    },
    async updateDefaultModel(value, options) {
      calls.push(['updateDefaultModel', value, options]);
      stored = value;
      return { defaultModel: stored };
    },
  };
  const state = { sessionFor: () => null };
  return { calls, harness, state, stored: () => stored };
}

test('/model default reports the current bot default and the host default', async () => {
  const { harness, state } = defaultModelFixture({
    current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  });
  const result = await runModelCommand('/model default', harness, state, 'direct:one');
  assert.match(result.message, /当前机器人用于新会话的默认模型：/);
  assert.match(result.message, /deepseek-official\/deepseek-v4-pro/);
  assert.match(result.message, /\/model default clear/);
});

test('/model default without a selection follows the host default', async () => {
  const { harness, state } = defaultModelFixture({
    catalog: {
      ...CATALOG,
      current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    },
  });
  const result = await runModelCommand('/model default', harness, state, 'direct:one');
  assert.match(result.message, /跟随 Host 默认（当前：deepseek-official\/deepseek-v4-flash）/);
});

test('/model default resolves sequence numbers against the live catalog', async () => {
  const { calls, harness, state, stored } = defaultModelFixture();
  const result = await runModelCommand('/model default 2', harness, state, 'direct:one');
  assert.deepEqual(stored(), { provider: 'deepseek-official', model: 'deepseek-v4-pro' });
  assert.match(result.message, /已设置为：/);
  assert.match(result.message, /请先发送 \/new/);
  assert.deepEqual(calls.map(([name]) => name), ['listModels', 'updateDefaultModel']);
});

test('/model default accepts provider/model ids with a reasoning effort', async () => {
  const { harness, state, stored } = defaultModelFixture({
    catalog: REASONING_CATALOG,
  });
  const result = await runModelCommand(
    '/model default deepseek-official/deepseek-v4-flash high',
    harness,
    state,
    'direct:one',
  );
  assert.deepEqual(stored(), {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
  });
  assert.match(result.message, /deepseek-v4-flash · reasoningEffort=high/);
});

test('/model default clear and --default restore the host default', async () => {
  for (const command of ['/model default clear', '/model default --default']) {
    const { harness, state, stored } = defaultModelFixture({
      current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    });
    const result = await runModelCommand(command, harness, state, 'direct:one');
    assert.equal(stored(), null);
    assert.match(result.message, /跟随 Host 默认/);
  }
});

test('/model default rejects unknown models, bad numbers, and unknown efforts', async () => {
  const { harness, state } = defaultModelFixture();
  assert.match(
    (await runModelCommand('/model default missing/model', harness, state, 'direct:one')).message,
    /没有找到模型：missing\/model/,
  );
  assert.match(
    (await runModelCommand('/model default 99', harness, state, 'direct:one')).message,
    /模型序号无效/,
  );
  assert.match(
    (await runModelCommand(
      '/model default deepseek-official/deepseek-v4-flash nosuch',
      defaultModelFixture({ catalog: REASONING_CATALOG }).harness,
      defaultModelFixture({ catalog: REASONING_CATALOG }).state,
      'direct:one',
    )).message,
    /不支持推理等级|可用推理等级/,
  );
});

test('/model default surfaces harness and catalog failures', async () => {
  const unsupported = defaultModelFixture();
  unsupported.harness.defaultModelSettings = undefined;
  assert.match(
    (await runModelCommand('/model default', unsupported.harness, unsupported.state, 'direct:one')).message,
    /不支持默认模型设置/,
  );

  const unavailable = defaultModelFixture();
  const failure = new Error('默认模型不存在或当前不可用：x/y');
  failure.code = 'default-model-unavailable';
  unavailable.harness.updateDefaultModel = async () => { throw failure; };
  assert.match(
    (await runModelCommand('/model default clear', unavailable.harness, unavailable.state, 'direct:one')).message,
    /默认模型不存在或当前不可用/,
  );

  const down = defaultModelFixture({ catalogError: new Error('rpc down') });
  assert.match(
    (await runModelCommand('/model default 1', down.harness, down.state, 'direct:one')).message,
    /暂时无法获取模型列表/,
  );
});

test('isModelCommand recognizes model and reasoning command prefixes', () => {
  for (const command of [
    '/models', ' /MODELS ', '/models ignored', '/model', '/MoDeL openai/gpt-5',
    '/reasoning', '/REASONING high', '/reasoninglist', '/ReAsOnInGs',
  ]) {
    assert.equal(isModelCommand(command), true, command);
  }
  for (const value of [
    null, '', 'model', '/modelx', '/modelsx', 'hello /models',
    '/reasoningx', '/reasoninglists', 'hello /reasoning',
  ]) {
    assert.equal(isModelCommand(value), false, String(value));
  }
});

test('/models lists the global catalog without creating a Session', async () => {
  const { calls, harness, state } = fixture();
  const signal = new AbortController().signal;
  const result = await runModelCommand('/MODELS', harness, state, 'direct:one', { signal });

  assert.match(result.message, /DeepSeek/);
  assert.match(result.message, /1\. deepseek-official\/deepseek-v4-flash/);
  assert.match(result.message, /2\. deepseek-official\/deepseek-v4-pro/);
  assert.match(result.message, /3\. openrouter\/anthropic\/claude-sonnet-4/);
  assert.match(result.message, /切换模型：\/model <序号>/);
  assert.deepEqual(calls, [
    ['sessionFor', 'direct:one'],
    ['listModels', { signal }],
  ]);
});

test('/models marks the current Session model and contains provider-local failures', async () => {
  const sessionCatalog = {
    groups: CATALOG.groups,
    current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    routable: true,
    failures: [{
      id: 'private-provider',
      name: 'Private Provider',
      message: 'https://private.example.invalid failed with secret=abc',
    }],
  };
  const { harness, state } = fixture({ initialSessionId: 'session-one', sessionCatalog });
  const result = await runModelCommand('/models', harness, state, 'direct:one');

  assert.match(result.message, /2\. deepseek-official\/deepseek-v4-pro（当前）/);
  assert.match(result.message, /Private Provider/);
  assert.doesNotMatch(result.message, /private\.example|secret=abc/);
});

test('/models validates its no-argument and text-only syntax', async () => {
  const { harness, state } = fixture();
  assert.match(
    (await runModelCommand('/models openai', harness, state, 'direct:one')).message,
    /不带参数/,
  );
  assert.match(
    (await runModelCommand('/models', harness, state, 'direct:one', { hasImages: true })).message,
    /仅支持纯文字/,
  );
});

test('/models splits a long catalog into lossless 1,800-character messages', async () => {
  const longCatalog = {
    groups: [{
      id: 'provider',
      name: 'Large Provider',
      models: Array.from({ length: 80 }, (_, index) => ({
        id: `model-${String(index).padStart(3, '0')}-${'x'.repeat(40)}`,
        name: `Model ${index}`,
      })),
    }],
    failures: [],
  };
  const { harness, state } = fixture({ globalCatalog: longCatalog });
  const result = await runModelCommand('/models', harness, state, 'direct:one');

  assert.ok(result.messages.length > 1);
  assert.ok(result.messages.every((message) => message.length <= 1_800));
  assert.equal(result.messages.join(''), result.message);
  assert.match(result.message, /80\. provider\/model-079/);
});

test('/model reports current state without creating or selecting', async () => {
  const missing = fixture();
  const noSession = await runModelCommand('/model', missing.harness, missing.state, 'direct:one');
  assert.match(noSession.message, /还没有会话/);
  assert.equal(missing.calls.some(([name]) => name === 'createSession'), false);

  const existingFixture = fixture({ initialSessionId: 'session-one' });
  const existing = await runModelCommand(
    '/MODEL',
    existingFixture.harness,
    existingFixture.state,
    'direct:one',
  );
  assert.match(existing.message, /deepseek-official\/deepseek-v4-flash/);
  assert.equal(existingFixture.calls.some(([name]) => name === 'selectModel'), false);
});

test('/reasoninglist and /reasonings are identical read-only aliases', async () => {
  const first = fixture({
    initialSessionId: 'session-one',
    sessionCatalog: reasoningSessionCatalog(),
  });
  const second = fixture({
    initialSessionId: 'session-one',
    sessionCatalog: reasoningSessionCatalog(),
  });
  const listed = await runModelCommand(
    '/reasoninglist', first.harness, first.state, 'direct:one',
  );
  const aliased = await runModelCommand(
    '/REASONINGS', second.harness, second.state, 'direct:one',
  );

  assert.equal(aliased.message, listed.message);
  assert.match(listed.message, /deepseek-official\/deepseek-v4-flash/);
  assert.match(listed.message, /2\. High \(high\)（当前、默认）/);
  assert.match(listed.message, /复杂任务/);
  assert.match(listed.message, /\/reasoning --default/);
  assert.equal(first.calls.some(([name]) => name === 'selectModel'), false);
  assert.equal(second.calls.some(([name]) => name === 'selectModel'), false);
});

test('/reasoninglist keeps default reset available without current-model metadata', async () => {
  for (const sessionCatalog of [
    {
      ...CATALOG,
      current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      routable: true,
    },
    {
      ...CATALOG,
      current: {
        provider: 'private-provider',
        model: 'private-model',
        reasoningEffort: 'custom-high',
      },
      routable: true,
    },
  ]) {
    const current = fixture({ initialSessionId: 'session-one', sessionCatalog });
    const listed = await runModelCommand(
      '/reasoninglist', current.harness, current.state, 'direct:one',
    );

    assert.match(listed.message, /不提供可切换的推理等级/);
    assert.match(listed.message, /恢复默认等级：\/reasoning --default/);
    assert.equal(current.calls.some(([name]) => name === 'selectModel'), false);
  }
});

test('reasoning read commands require an existing Session and validate syntax', async () => {
  const missing = fixture();
  for (const command of ['/reasoning', '/reasoninglist', '/reasonings']) {
    const result = await runModelCommand(command, missing.harness, missing.state, 'direct:one');
    assert.match(result.message, /还没有会话/, command);
  }
  assert.equal(missing.calls.some(([name]) => name === 'createSession'), false);

  const existing = fixture({
    initialSessionId: 'session-one',
    sessionCatalog: reasoningSessionCatalog(),
  });
  assert.match(
    (await runModelCommand(
      '/reasoninglist extra', existing.harness, existing.state, 'direct:one',
    )).message,
    /不带参数/,
  );
  assert.match(
    (await runModelCommand(
      '/reasoning high extra', existing.harness, existing.state, 'direct:one',
    )).message,
    /用法/,
  );
});

test('/reasoning reports the explicit or model-default effort without selecting', async () => {
  const explicit = fixture({
    initialSessionId: 'session-one',
    sessionCatalog: reasoningSessionCatalog(),
  });
  const explicitResult = await runModelCommand(
    '/reasoning', explicit.harness, explicit.state, 'direct:one',
  );
  assert.match(explicitResult.message, /当前推理等级：High \(high\)/);

  const inherited = fixture({
    initialSessionId: 'session-one',
    sessionCatalog: reasoningSessionCatalog({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    }),
  });
  const inheritedResult = await runModelCommand(
    '/reasoning', inherited.harness, inherited.state, 'direct:one',
  );
  assert.match(inheritedResult.message, /当前推理等级：High \(high\)/);
  assert.equal(explicit.calls.some(([name]) => name === 'selectModel'), false);
  assert.equal(inherited.calls.some(([name]) => name === 'selectModel'), false);
});

test('/reasoning preserves an unknown current effort and represents Provider Default', async () => {
  const groups = structuredClone(REASONING_CATALOG.groups);
  delete groups[0].models[0].reasoning.defaultEffort;
  const raw = fixture({
    initialSessionId: 'session-one',
    sessionCatalog: {
      groups,
      failures: [],
      current: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'gateway-ultra',
      },
      routable: true,
    },
  });
  const listed = await runModelCommand(
    '/reasoninglist', raw.harness, raw.state, 'direct:one',
  );
  assert.match(listed.message, /当前推理等级：gateway-ultra/);
  assert.doesNotMatch(listed.message, /（当前/);

  const providerDefault = fixture({
    initialSessionId: 'session-one',
    sessionCatalog: {
      groups,
      failures: [],
      current: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      },
      routable: true,
    },
  });
  const current = await runModelCommand(
    '/reasoning', providerDefault.harness, providerDefault.state, 'direct:one',
  );
  assert.match(current.message, /Default（由模型或 Provider 决定）/);
});

test('/reasoning switches the current model effort by index or exact ID', async () => {
  for (const [requested, expected] of [['3', 'max'], ['off', 'off']]) {
    const { calls, harness, state } = fixture({
      initialSessionId: 'session-one',
      sessionCatalog: reasoningSessionCatalog(),
    });
    const result = await runModelCommand(
      `/reasoning ${requested}`, harness, state, 'direct:one',
    );

    assert.match(result.message, new RegExp(`推理等级已切换为：[\\s\\S]*${expected}`));
    assert.deepEqual(calls.find(([name]) => name === 'selectModel'), [
      'selectModel',
      'session-one',
      {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: expected,
      },
      {},
    ]);
  }
});

test('/reasoning prefers an exact opaque numeric effort ID before an index', async () => {
  const groups = structuredClone(REASONING_CATALOG.groups);
  groups[0].models[0].reasoning = {
    efforts: [
      { id: '3', name: 'Literal Three' },
      { id: '0', name: 'Literal Zero' },
      { id: '9007199254740992', name: 'Huge Numeric' },
    ],
    defaultEffort: '3',
  };

  for (const requested of ['3', '0', '9007199254740992']) {
    const { calls, harness, state } = fixture({
      initialSessionId: 'session-one',
      sessionCatalog: {
        groups,
        failures: [],
        current: {
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash',
          reasoningEffort: '3',
        },
        routable: true,
      },
    });
    const result = await runModelCommand(
      `/reasoning ${requested}`, harness, state, 'direct:one',
    );

    assert.match(result.message, /推理等级已切换为/);
    assert.equal(
      calls.find(([name]) => name === 'selectModel')?.[2]?.reasoningEffort,
      requested,
    );
  }
});

test('/reasoning --default restores the current model default effort', async () => {
  const { calls, harness, state } = fixture({
    initialSessionId: 'session-one',
    sessionCatalog: reasoningSessionCatalog({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max',
    }),
    selectionResult: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
    },
    selectionReadback: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
    },
  });
  const result = await runModelCommand(
    '/reasoning --default', harness, state, 'direct:one',
  );

  assert.match(result.message, /推理等级已切换为：[\s\S]*High \(high\)/);
  assert.deepEqual(calls.find(([name]) => name === 'selectModel')?.[2], {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  });
});

test('/reasoning --default can reset an advisory-unlisted current model', async () => {
  const sessionCatalog = {
    ...CATALOG,
    current: {
      provider: 'private-provider',
      model: 'private-model',
      reasoningEffort: 'custom-high',
    },
    routable: true,
  };
  const { calls, harness, state } = fixture({
    initialSessionId: 'session-one',
    sessionCatalog,
  });
  const result = await runModelCommand(
    '/reasoning --default', harness, state, 'direct:one',
  );

  assert.match(result.message, /推理等级已切换为/);
  assert.match(result.message, /Default/);
  assert.deepEqual(calls.find(([name]) => name === 'selectModel')?.[2], {
    provider: 'private-provider',
    model: 'private-model',
  });
});

test('/reasoning rejects unsupported levels without changing the selection', async () => {
  for (const requested of ['0', '4', '9007199254740992', 'medium']) {
    const { calls, harness, state } = fixture({
      initialSessionId: 'session-one',
      sessionCatalog: reasoningSessionCatalog(),
    });
    const result = await runModelCommand(
      `/reasoning ${requested}`, harness, state, 'direct:one',
    );
    assert.match(result.message, /序号无效|不支持推理等级/, requested);
    assert.equal(calls.some(([name]) => name === 'selectModel'), false, requested);
  }

  const unsupported = fixture({ initialSessionId: 'session-one' });
  const result = await runModelCommand(
    '/reasoning high', unsupported.harness, unsupported.state, 'direct:one',
  );
  assert.match(result.message, /不提供可切换的推理等级/);
  assert.equal(unsupported.calls.some(([name]) => name === 'selectModel'), false);

  const noSession = fixture({ globalCatalog: REASONING_CATALOG });
  const noSessionResult = await runModelCommand(
    '/reasoning high', noSession.harness, noSession.state, 'direct:one',
  );
  assert.match(noSessionResult.message, /还没有会话/);
  assert.equal(noSession.calls.some(([name]) => name === 'createSession'), false);
});

test('reasoning commands reject image-bearing control messages', async () => {
  const current = fixture({
    initialSessionId: 'session-one',
    sessionCatalog: reasoningSessionCatalog(),
  });
  for (const command of ['/reasoning', '/reasoninglist', '/reasonings', '/reasoning high']) {
    const result = await runModelCommand(
      command, current.harness, current.state, 'direct:one', { hasImages: true },
    );
    assert.match(result.message, /仅支持纯文字/, command);
  }
  assert.equal(current.calls.some(([name]) => name === 'models'), false);
  assert.equal(current.calls.some(([name]) => name === 'selectModel'), false);
});

test('/model uses an exact catalog ID and preserves slashes inside the model ID', async () => {
  const { calls, harness, state } = fixture({ initialSessionId: 'session-one' });
  const control = Object.freeze({ route: 'direct:one' });
  const result = await runModelCommand(
    '/model openrouter/anthropic/claude-sonnet-4',
    harness,
    state,
    'direct:one',
    { control },
  );

  assert.match(result.message, /openrouter\/anthropic\/claude-sonnet-4/);
  assert.deepEqual(calls.find(([name]) => name === 'selectModel'), [
    'selectModel',
    'session-one',
    { provider: 'openrouter', model: 'anthropic/claude-sonnet-4' },
    {},
  ]);
});

test('/model accepts the current catalog\'s global 1-based model number', async () => {
  const { calls, harness, state } = fixture({ initialSessionId: 'session-one' });
  const result = await runModelCommand('/model 3', harness, state, 'direct:one');

  assert.match(result.message, /openrouter\/anthropic\/claude-sonnet-4/);
  assert.deepEqual(calls.find(([name]) => name === 'selectModel'), [
    'selectModel',
    'session-one',
    { provider: 'openrouter', model: 'anthropic/claude-sonnet-4' },
    {},
  ]);
});

test('/model accepts an optional effort and otherwise applies the target model default', async () => {
  for (const [command, expectedEffort] of [
    ['/model 2 xhigh', 'xhigh'],
    ['/model deepseek-official/deepseek-v4-pro', 'medium'],
  ]) {
    const resolvedDefault = command.includes(' xhigh') ? undefined : {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'medium',
    };
    const { calls, harness, state } = fixture({
      initialSessionId: 'session-one',
      globalCatalog: REASONING_CATALOG,
      sessionCatalog: reasoningSessionCatalog(),
      selectionResult: resolvedDefault,
      selectionReadback: resolvedDefault,
    });
    const result = await runModelCommand(command, harness, state, 'direct:one');

    assert.match(result.message, /deepseek-official\/deepseek-v4-pro/);
    assert.match(result.message, new RegExp(`推理等级：.*${expectedEffort}`));
    assert.deepEqual(calls.find(([name]) => name === 'selectModel')?.[2], {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      ...(command.includes(' xhigh') ? { reasoningEffort: expectedEffort } : {}),
    });
  }
});

test('/model validates an optional effort against the target model atomically', async () => {
  const invalid = fixture({ globalCatalog: REASONING_CATALOG });
  const failed = await runModelCommand(
    '/model 2 high', invalid.harness, invalid.state, 'direct:one',
  );

  assert.match(failed.message, /不支持推理等级：high/);
  assert.match(failed.message, /medium, xhigh/);
  assert.equal(invalid.calls.some(([name]) => name === 'createSession'), false);
  assert.equal(invalid.calls.some(([name]) => name === 'selectModel'), false);

  const valid = fixture({ globalCatalog: REASONING_CATALOG });
  const switched = await runModelCommand(
    '/model 2 xhigh', valid.harness, valid.state, 'direct:one',
  );
  assert.match(switched.message, /模型已切换为/);
  assert.equal(valid.boundId(), 'session-created');
  assert.deepEqual(valid.calls.find(([name]) => name === 'selectModel')?.[2], {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'xhigh',
  });
});

test('/model reports the current reasoning effort when the Session exposes it', async () => {
  const current = fixture({
    initialSessionId: 'session-one',
    sessionCatalog: reasoningSessionCatalog(),
  });
  const result = await runModelCommand('/model', current.harness, current.state, 'direct:one');

  assert.match(result.message, /当前推理等级：High \(high\)/);
  assert.match(result.message, /\/reasoninglist/);
  assert.equal(current.calls.some(([name]) => name === 'selectModel'), false);
});

test('/model rejects invalid model numbers without creating or selecting a Session', async () => {
  for (const requested of ['0', '4', '9007199254740992']) {
    const { calls, harness, state } = fixture();
    const result = await runModelCommand(`/model ${requested}`, harness, state, 'direct:one');

    assert.match(result.message, /模型序号无效/, requested);
    assert.match(result.message, /\/models/, requested);
    assert.equal(calls.some(([name]) => name === 'createSession'), false, requested);
    assert.equal(calls.some(([name]) => name === 'selectModel'), false, requested);
  }
});

test('/model rejects unknown IDs before creating a Session', async () => {
  const { calls, harness, state } = fixture();
  const result = await runModelCommand(
    '/model DEEPSEEK-OFFICIAL/deepseek-v4-flash',
    harness,
    state,
    'direct:one',
  );

  assert.match(result.message, /没有找到模型/);
  assert.equal(calls.some(([name]) => name === 'createSession'), false);
  assert.equal(calls.some(([name]) => name === 'selectModel'), false);
  assert.match(
    (await runModelCommand('/model missing-slash', harness, state, 'direct:one')).message,
    /用法/,
  );
});

test('/model creates and selects a blank Session before exposing its binding', async () => {
  const { calls, harness, state, boundId } = fixture();
  const signal = new AbortController().signal;
  const result = await runModelCommand(
    '/model 2',
    harness,
    state,
    'direct:one',
    { signal, control: 'control-one' },
  );

  assert.match(result.message, /模型已切换为/);
  assert.equal(boundId(), 'session-created');
  const operations = calls.map(([name]) => name);
  assert.ok(operations.indexOf('listModels') < operations.indexOf('createSession'));
  assert.ok(operations.indexOf('createSession') < operations.indexOf('selectModel'));
  assert.ok(operations.lastIndexOf('models') > operations.indexOf('selectModel'));
  assert.ok(operations.lastIndexOf('models') < operations.indexOf('setSession'));
  assert.ok(operations.indexOf('selectModel') < operations.indexOf('setSession'));
  assert.deepEqual(calls.find(([name]) => name === 'selectModel'), [
    'selectModel',
    'session-created',
    { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    { signal },
  ]);
});

test('a mismatched selectModel result is reported as a failed switch', async () => {
  const { calls, harness, state } = fixture({
    initialSessionId: 'session-one',
    selectionResult: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  });

  const result = await runModelCommand(
    '/model deepseek-official/deepseek-v4-pro',
    harness,
    state,
    'direct:one',
  );

  assert.match(result.message, /模型切换失败/);
  assert.match(result.message, /requested: deepseek-official\/deepseek-v4-pro/);
  assert.match(result.message, /selectModel\.selected: deepseek-official\/deepseek-v4-flash/);
  assert.equal(calls.filter(([name]) => name === 'models').length, 1);
});

test('an authoritative current-model mismatch is reported and leaves a new Session unbound', async () => {
  const { calls, harness, state, boundId } = fixture({
    selectionReadback: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  });

  const result = await runModelCommand(
    '/model deepseek-official/deepseek-v4-pro',
    harness,
    state,
    'direct:one',
  );

  assert.match(result.message, /模型切换失败/);
  assert.match(result.message, /requested: deepseek-official\/deepseek-v4-pro/);
  assert.match(result.message, /当前模型： deepseek-official\/deepseek-v4-flash/);
  assert.equal(boundId(), null);
  assert.equal(calls.filter(([name]) => name === 'models').length, 1);
  assert.equal(calls.some(([name]) => name === 'setSession'), false);
});

test('a failed first model selection leaves the conversation unbound', async () => {
  const selectionError = new Error('provider unavailable');
  selectionError.code = 'model-unavailable';
  const { calls, harness, state, boundId } = fixture({ selectionError });

  const result = await runModelCommand(
    '/model deepseek-official/deepseek-v4-pro',
    harness,
    state,
    'direct:one',
  );

  assert.match(result.message, /当前不可用|图片/);
  assert.equal(boundId(), null);
  assert.equal(calls.some(([name]) => name === 'createSession'), true);
  assert.equal(calls.some(([name]) => name === 'selectModel'), true);
  assert.equal(calls.some(([name]) => name === 'setSession'), false);
});

test('two concurrent first model switches share one created Session', async () => {
  const { calls, harness, state, boundId } = fixture();

  const results = await Promise.all([
    runModelCommand(
      '/model 2',
      harness,
      state,
      'direct:one',
    ),
    runModelCommand(
      '/model openrouter/anthropic/claude-sonnet-4',
      harness,
      state,
      'direct:one',
    ),
  ]);

  assert.ok(results.every(({ message }) => /模型已切换为/.test(message)));
  assert.equal(boundId(), 'session-created');
  assert.equal(calls.filter(([name]) => name === 'createSession').length, 1);
  assert.equal(calls.filter(([name]) => name === 'setSession').length, 1);
  assert.deepEqual(
    calls.filter(([name]) => name === 'selectModel').map(([, sessionId]) => sessionId),
    ['session-created', 'session-created'],
  );
});

test('a concurrent external binding is preserved after selecting an unbound Session', async () => {
  const selectionStarted = deferred();
  const releaseSelection = deferred();
  const fixtureValue = fixture({
    selectModelHook: async ({ sessionId }) => {
      if (sessionId !== 'session-created') return;
      selectionStarted.resolve();
      await releaseSelection.promise;
    },
  });

  const switching = runModelCommand(
    '/model deepseek-official/deepseek-v4-pro',
    fixtureValue.harness,
    fixtureValue.state,
    'direct:one',
  );
  await selectionStarted.promise;
  await fixtureValue.state.setSession('direct:one', 'session-bound-elsewhere');
  releaseSelection.resolve();

  const result = await switching;
  assert.match(result.message, /会话已发生变化.*重试/);
  assert.equal(fixtureValue.boundId(), 'session-bound-elsewhere');
  assert.equal(fixtureValue.calls.some((call) => (
    call[0] === 'setSession' && call[2] === 'session-created'
  )), false);
});

test('a concurrent external rebind is preserved after selecting a bound Session', async () => {
  const selectionStarted = deferred();
  const releaseSelection = deferred();
  const fixtureValue = fixture({
    initialSessionId: 'session-one',
    selectModelHook: async ({ sessionId }) => {
      if (sessionId !== 'session-one') return;
      selectionStarted.resolve();
      await releaseSelection.promise;
    },
  });

  const switching = runModelCommand(
    '/model deepseek-official/deepseek-v4-pro',
    fixtureValue.harness,
    fixtureValue.state,
    'direct:one',
  );
  await selectionStarted.promise;
  await fixtureValue.state.setSession('direct:one', 'session-two');
  releaseSelection.resolve();

  const result = await switching;
  assert.match(result.message, /会话已发生变化.*重试/);
  assert.equal(fixtureValue.boundId(), 'session-two');
  assert.doesNotMatch(result.message, /模型已切换为/);
});

test('/model refuses pending interactions and active or running Sessions', async () => {
  const pending = fixture({ initialSessionId: 'session-one' });
  const pendingResult = await runModelCommand(
    '/model deepseek-official/deepseek-v4-pro',
    pending.harness,
    pending.state,
    'direct:one',
    { pendingInteraction: true },
  );
  assert.match(pendingResult.message, /等待你的回答或审批/);
  assert.equal(pending.calls.some(([name]) => name === 'selectModel'), false);

  for (const state of [{ running: true }, { activeTurn: true }]) {
    const active = fixture({ initialSessionId: 'session-one', ...state });
    const result = await runModelCommand(
      '/model deepseek-official/deepseek-v4-pro',
      active.harness,
      active.state,
      'direct:one',
      { control: 'owner-one' },
    );
    assert.match(result.message, /当前任务正在运行/);
    assert.equal(active.calls.some(([name]) => name === 'models'), false);
    assert.equal(active.calls.some(([name]) => name === 'selectModel'), false);
  }
});

test('/reasoning mutations refuse pending or busy Sessions while reads remain available', async () => {
  const pending = fixture({
    initialSessionId: 'session-one',
    sessionCatalog: reasoningSessionCatalog(),
  });
  const pendingResult = await runModelCommand(
    '/reasoning off', pending.harness, pending.state, 'direct:one',
    { pendingInteraction: true },
  );
  assert.match(pendingResult.message, /等待你的回答或审批/);
  assert.equal(pending.calls.some(([name]) => name === 'selectModel'), false);

  for (const runState of [{ running: true }, { activeTurn: true }]) {
    const active = fixture({
      initialSessionId: 'session-one',
      sessionCatalog: reasoningSessionCatalog(),
      ...runState,
    });
    const failed = await runModelCommand(
      '/reasoning off', active.harness, active.state, 'direct:one',
      { control: 'owner-one' },
    );
    assert.match(failed.message, /当前任务正在运行/);
    assert.equal(active.calls.some(([name]) => name === 'selectModel'), false);

    const listed = await runModelCommand(
      '/reasoninglist', active.harness, active.state, 'direct:one',
    );
    assert.match(listed.message, /可用推理等级/);
  }
});

test('/reasoning verifies both the selected effort and authoritative readback', async () => {
  const wrongSelection = fixture({
    initialSessionId: 'session-one',
    sessionCatalog: reasoningSessionCatalog(),
    selectionResult: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
    },
  });
  const selectionFailure = await runModelCommand(
    '/reasoning max',
    wrongSelection.harness,
    wrongSelection.state,
    'direct:one',
  );
  assert.match(selectionFailure.message, /推理等级切换失败/);
  assert.match(selectionFailure.message, /reasoningEffort=max/);
  assert.match(selectionFailure.message, /reasoningEffort=high/);

  const wrongReadback = fixture({
    initialSessionId: 'session-one',
    sessionCatalog: reasoningSessionCatalog(),
    selectionReadback: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'off',
    },
  });
  const readbackFailure = await runModelCommand(
    '/reasoning max',
    wrongReadback.harness,
    wrongReadback.state,
    'direct:one',
  );
  assert.match(readbackFailure.message, /推理等级切换失败/);
  assert.match(readbackFailure.message, /reasoningEffort=max/);
  assert.match(readbackFailure.message, /reasoningEffort=off/);
});

test('a missing bound Session is cleared and /models falls back to the global catalog', async () => {
  const { calls, harness, state, boundId } = fixture({
    initialSessionId: 'session-missing',
    existing: false,
  });
  const result = await runModelCommand('/models', harness, state, 'direct:one');

  assert.match(result.message, /deepseek-official\/deepseek-v4-flash/);
  assert.equal(boundId(), null);
  assert.equal(calls.some(([name]) => name === 'clearSession'), true);
  assert.equal(calls.some(([name]) => name === 'listModels'), true);
});

test('model command failures use safe user-facing messages', async () => {
  const privateError = new Error('provider leaked API key sk-private');
  privateError.code = 'model-unavailable';
  const selection = fixture({
    initialSessionId: 'session-one',
    selectionError: privateError,
  });
  const failed = await runModelCommand(
    '/model deepseek-official/deepseek-v4-pro',
    selection.harness,
    selection.state,
    'direct:one',
  );
  assert.match(failed.message, /当前不可用|图片/);
  assert.doesNotMatch(failed.message, /sk-private/);

  const listing = fixture({ globalCatalog: new Error('private endpoint') });
  const unavailable = await runModelCommand('/models', listing.harness, listing.state, 'direct:one');
  assert.match(unavailable.message, /暂时无法获取模型列表/);
  assert.doesNotMatch(unavailable.message, /private endpoint/);

  const bad = fixture({ globalCatalog: { groups: null, failures: [] } });
  assert.match(
    (await runModelCommand('/models', bad.harness, bad.state, 'direct:one')).message,
    /暂时无法获取模型列表/,
  );
});

test('non-model input is left for ordinary message routing', async () => {
  assert.equal(await runModelCommand('hello', {}, {}, 'direct:one'), null);
});
