import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BotWorkspaceStore,
  createBotWorkspaceScope,
} from '../src/channels/shared/bot-workspace-store.mjs';
import { runModelCommand } from '../src/channels/shared/model-command.mjs';
import { askInWorkspaceSession } from '../src/channels/shared/workspace-session.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-session-bind-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const defaultWorkspace = join(root, 'default');
  const alternateWorkspace = join(root, 'alternate');
  const thirdWorkspace = join(root, 'third');
  await Promise.all([
    mkdir(defaultWorkspace),
    mkdir(alternateWorkspace),
    mkdir(thirdWorkspace),
  ]);
  return {
    root,
    defaultWorkspace,
    alternateWorkspace,
    thirdWorkspace,
    path: join(root, 'workspaces.json'),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function within(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function memoryState(initial = {}) {
  let sessions = { ...initial };
  let clears = 0;
  let sets = 0;
  return {
    sessionFor(key) { return sessions[key] ?? null; },
    async setSession(key, sessionId) {
      sets += 1;
      sessions[key] = sessionId;
    },
    async clearSessions() {
      clears += 1;
      sessions = {};
    },
    snapshot() { return { ...sessions }; },
    get clears() { return clears; },
    get sets() { return sets; },
  };
}

test('binding across workspaces clears old mappings, fences the generation, and binds one conversation', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_bind');
  const previousGeneration = workspaces.generationFor('bot_bind');
  const state = memoryState({ 'direct:one': 'old-one', 'group:two': 'old-two' });
  const calls = [];
  const harness = {
    async adoptWorkspaceSession(sessionId) {
      calls.push(sessionId);
      return {
        sessionId,
        workspace: alternateWorkspace,
        title: 'Existing conversation',
        archived: true,
      };
    },
  };
  const scope = createBotWorkspaceScope(harness, { botId: 'bot_bind', workspaces, state });

  const result = await scope.harness.bindWorkspaceSession('direct:one', 'session-target');

  assert.deepEqual(calls, ['session-target']);
  assert.deepEqual(result, {
    sessionId: 'session-target',
    workspace: alternateWorkspace,
    title: 'Existing conversation',
    archived: true,
  });
  assert.equal(workspaces.workspaceFor('bot_bind'), alternateWorkspace);
  assert.notEqual(workspaces.generationFor('bot_bind'), previousGeneration);
  assert.deepEqual(state.snapshot(), { 'direct:one': 'session-target' });
  assert.equal(state.clears, 1);
  assert.equal(state.sets, 1);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    version: 1,
    workspaces: { bot_bind: alternateWorkspace },
  });
});

test('binding inside the current workspace only replaces the selected conversation', async (t) => {
  const { path, defaultWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_same');
  const generation = workspaces.generationFor('bot_same');
  const state = memoryState({ 'direct:one': 'old-one', 'group:two': 'kept-two' });
  const scope = createBotWorkspaceScope({
    async adoptWorkspaceSession(sessionId) {
      return { sessionId, workspace: defaultWorkspace };
    },
  }, { botId: 'bot_same', workspaces, state });

  await scope.harness.bindWorkspaceSession('direct:one', 'session-current-workspace');

  assert.equal(workspaces.workspaceFor('bot_same'), defaultWorkspace);
  assert.equal(workspaces.generationFor('bot_same'), generation);
  assert.equal(state.clears, 0);
  assert.deepEqual(state.snapshot(), {
    'direct:one': 'session-current-workspace',
    'group:two': 'kept-two',
  });
});

test('binding through an equivalent real path does not clear a symlink workspace', async (t) => {
  const { root, path, defaultWorkspace } = await fixture(t);
  const linkedWorkspace = join(root, 'default-link');
  await symlink(defaultWorkspace, linkedWorkspace);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace: linkedWorkspace }).load();
  await workspaces.ensure('bot_symlink', { workspace: linkedWorkspace });
  const generation = workspaces.generationFor('bot_symlink');
  const state = memoryState({ selected: 'session-old', other: 'session-kept' });
  const scope = createBotWorkspaceScope({
    async adoptWorkspaceSession(sessionId) {
      return { sessionId, workspace: defaultWorkspace };
    },
  }, { botId: 'bot_symlink', workspaces, state });

  await scope.harness.bindWorkspaceSession('selected', 'session-target');

  assert.equal(workspaces.workspaceFor('bot_symlink'), linkedWorkspace);
  assert.equal(workspaces.generationFor('bot_symlink'), generation);
  assert.equal(state.clears, 0);
  assert.deepEqual(state.snapshot(), {
    selected: 'session-target',
    other: 'session-kept',
  });
});

test('the next message continues the bound Session without creating a new one', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_continue');
  const state = memoryState({ conversation: 'session-old' });
  const asked = [];
  let createCalls = 0;
  let renameCalls = 0;
  const scope = createBotWorkspaceScope({
    async adoptWorkspaceSession(sessionId) {
      return { sessionId, workspace: alternateWorkspace };
    },
    async sessionExists(sessionId) { return sessionId === 'session-target'; },
    async createSession() {
      createCalls += 1;
      return 'session-created-unexpectedly';
    },
    async renameSession() { renameCalls += 1; },
    async ask(sessionId, text) {
      asked.push({ sessionId, text });
      return 'continued answer';
    },
  }, { botId: 'bot_continue', workspaces, state });

  await scope.harness.bindWorkspaceSession('conversation', 'session-target');
  const reply = await askInWorkspaceSession({
    harness: scope.harness,
    state: scope.state,
    key: 'conversation',
    text: 'continue here',
  });

  assert.deepEqual(reply, { sessionId: 'session-target', answer: 'continued answer' });
  assert.deepEqual(asked, [{ sessionId: 'session-target', text: 'continue here' }]);
  assert.equal(createCalls, 0);
  assert.equal(renameCalls, 0);
});

test('a newly created enhanced Session is renamed from the first prompt before ask', async (t) => {
  const { path, defaultWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_title');
  const state = memoryState();
  const calls = [];
  const scope = createBotWorkspaceScope({
    async createSession() {
      calls.push(['create']);
      return 'session-titled';
    },
    async renameSession(sessionId, title) {
      calls.push(['rename', sessionId, title]);
      return { title, seq: 0 };
    },
    async ask(sessionId, prompt) {
      calls.push(['ask', sessionId, prompt]);
      return 'answer';
    },
  }, { botId: 'bot_title', workspaces, state });

  const result = await askInWorkspaceSession({
    harness: scope.harness,
    state: scope.state,
    key: 'conversation',
    text: '请检查今天的订单',
    content: '<dsh_im_source>{"channel":"qq"}</dsh_im_source>\n\n请检查今天的订单',
    contextEnhanced: true,
  });

  assert.deepEqual(result, { sessionId: 'session-titled', answer: 'answer' });
  assert.deepEqual(calls, [
    ['create'],
    ['rename', 'session-titled', '请检查今天的订单'],
    ['ask', 'session-titled', '<dsh_im_source>{"channel":"qq"}</dsh_im_source>\n\n请检查今天的订单'],
  ]);
});

test('an ordinary first prompt keeps DSH title handling while model switch shares its binding', async () => {
  const state = memoryState();
  const askStarted = deferred();
  const releaseAsk = deferred();
  const calls = [];
  let creations = 0;
  const catalog = {
    groups: [{
      id: 'provider',
      name: 'Provider',
      models: [{ id: 'model', name: 'Model' }],
    }],
    failures: [],
  };
  const harness = {
    async createSession() {
      creations += 1;
      calls.push(['createSession']);
      return `session-${creations}`;
    },
    workspaceSession(sessionId) {
      return {
        async sessionExists() { return true; },
        async renameTitle(title) {
          calls.push(['renameTitle', sessionId, title]);
        },
        async ask(text) {
          calls.push(['ask', sessionId, text]);
          askStarted.resolve();
          await releaseAsk.promise;
          return 'answer';
        },
        async isRunning() { return false; },
        async hasActiveTurn() { return false; },
        async models() {
          return {
            ...catalog,
            current: { provider: 'provider', model: 'model' },
            routable: true,
          };
        },
        async selectModel(selection) {
          calls.push(['selectModel', sessionId, selection]);
          return { selected: selection };
        },
      };
    },
    async listModels() { return catalog; },
  };

  const prompting = askInWorkspaceSession({
    harness,
    state,
    key: 'conversation',
    text: 'first prompt',
  });
  const switching = runModelCommand(
    '/model provider/model',
    harness,
    state,
    'conversation',
  );
  await askStarted.promise;

  let switchResult;
  try {
    switchResult = await within(
      switching,
      500,
      'model switching waited for the running ask instead of only the binding transaction',
    );
  } finally {
    releaseAsk.resolve();
  }
  const promptResult = await prompting;

  assert.match(switchResult.message, /模型已切换为/);
  assert.deepEqual(promptResult, { sessionId: 'session-1', answer: 'answer' });
  assert.equal(creations, 1);
  assert.deepEqual(state.snapshot(), { conversation: 'session-1' });
  assert.deepEqual(calls, [
    ['createSession'],
    ['ask', 'session-1', 'first prompt'],
    ['selectModel', 'session-1', { provider: 'provider', model: 'model' }],
  ]);
});

test('workspace sessions forward structured multimodal prompt content unchanged', async (t) => {
  const { path, defaultWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_multimodal');
  const state = memoryState({ conversation: 'session-image' });
  const prompts = [];
  const content = [
    { type: 'text', text: '这是什么？' },
    { type: 'image', mediaType: 'image/png', data: 'AAAA' },
  ];
  const scope = createBotWorkspaceScope({
    async sessionExists() { return true; },
    async ask(sessionId, prompt) {
      prompts.push({ sessionId, prompt });
      return 'image answer';
    },
  }, { botId: 'bot_multimodal', workspaces, state });

  assert.deepEqual(await askInWorkspaceSession({
    harness: scope.harness,
    state: scope.state,
    key: 'conversation',
    content,
  }), { sessionId: 'session-image', answer: 'image answer' });
  assert.deepEqual(prompts, [{ sessionId: 'session-image', prompt: content }]);
});

test('adoption errors and invalid adoption responses leave local state unchanged', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_reject');
  const state = memoryState({ conversation: 'session-old' });
  const rejection = Object.assign(new Error('subagent sessions cannot be adopted'), {
    code: 'agent-busy',
  });
  const rejectedScope = createBotWorkspaceScope({
    async adoptWorkspaceSession() { throw rejection; },
  }, { botId: 'bot_reject', workspaces, state });

  await assert.rejects(
    rejectedScope.harness.bindWorkspaceSession('conversation', 'session-child'),
    { code: 'agent-busy' },
  );
  assert.equal(workspaces.workspaceFor('bot_reject'), defaultWorkspace);
  assert.deepEqual(state.snapshot(), { conversation: 'session-old' });

  const invalidScope = createBotWorkspaceScope({
    async adoptWorkspaceSession() {
      return { sessionId: 'different-session', workspace: alternateWorkspace };
    },
  }, { botId: 'bot_reject', workspaces, state });
  await assert.rejects(
    invalidScope.harness.bindWorkspaceSession('conversation', 'session-requested'),
    /invalid adopted workspace session/,
  );
  assert.equal(workspaces.workspaceFor('bot_reject'), defaultWorkspace);
  assert.deepEqual(state.snapshot(), { conversation: 'session-old' });
});

test('a workspace switch during adoption wins instead of being overwritten by the stale bind', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_adoption_race');
  const state = memoryState({ conversation: 'session-old', other: 'session-other' });
  const adoptionStarted = deferred();
  const releaseAdoption = deferred();
  const scope = createBotWorkspaceScope({
    async adoptWorkspaceSession(sessionId) {
      adoptionStarted.resolve();
      await releaseAdoption.promise;
      return { sessionId, workspace: defaultWorkspace };
    },
  }, { botId: 'bot_adoption_race', workspaces, state });

  const binding = scope.harness.bindWorkspaceSession('conversation', 'session-target');
  await adoptionStarted.promise;
  await scope.harness.switchWorkspace(alternateWorkspace);
  releaseAdoption.resolve();

  await assert.rejects(binding, { code: 'workspace-session-stale' });
  assert.equal(workspaces.workspaceFor('bot_adoption_race'), alternateWorkspace);
  assert.deepEqual(state.snapshot(), {});
  assert.equal(state.sets, 0);
});

test('the store queue rejects a generation change after adoption validation', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_queue_fence');
  const state = memoryState({ conversation: 'session-old', other: 'session-other' });
  const bindInQueue = workspaces.bindWorkspaceSession.bind(workspaces);
  workspaces.bindWorkspaceSession = async (...args) => {
    await workspaces.setWorkspace('bot_queue_fence', alternateWorkspace, {
      clearSessions: () => state.clearSessions(),
    });
    return bindInQueue(...args);
  };
  const scope = createBotWorkspaceScope({
    async adoptWorkspaceSession(sessionId) {
      return { sessionId, workspace: defaultWorkspace };
    },
  }, { botId: 'bot_queue_fence', workspaces, state });

  await assert.rejects(
    scope.harness.bindWorkspaceSession('conversation', 'session-target'),
    { code: 'workspace-session-stale' },
  );

  assert.equal(workspaces.workspaceFor('bot_queue_fence'), alternateWorkspace);
  assert.deepEqual(state.snapshot(), {});
  assert.equal(state.sets, 0);
});

test('a workspace switch cannot interleave between bind persistence and its session write', async (t) => {
  const {
    path, defaultWorkspace, alternateWorkspace, thirdWorkspace,
  } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_serial');
  let sessions = { first: 'session-old', second: 'session-other' };
  const setStarted = deferred();
  const releaseSet = deferred();
  const state = {
    sessionFor(key) { return sessions[key] ?? null; },
    async clearSessions() { sessions = {}; },
    async setSession(key, sessionId) {
      setStarted.resolve();
      await releaseSet.promise;
      sessions[key] = sessionId;
    },
    snapshot() { return { ...sessions }; },
  };
  const scope = createBotWorkspaceScope({
    async adoptWorkspaceSession(sessionId) {
      return { sessionId, workspace: alternateWorkspace };
    },
  }, { botId: 'bot_serial', workspaces, state });

  const binding = scope.harness.bindWorkspaceSession('first', 'session-target');
  await setStarted.promise;
  const switching = scope.harness.switchWorkspace(thirdWorkspace);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(workspaces.workspaceFor('bot_serial'), alternateWorkspace);
  assert.deepEqual(state.snapshot(), {});

  releaseSet.resolve();
  await binding;
  await switching;

  assert.equal(workspaces.workspaceFor('bot_serial'), thirdWorkspace);
  assert.deepEqual(state.snapshot(), {});
});

test('a later workspace generation cannot be reported as the completed binding', async (t) => {
  const {
    path, defaultWorkspace, alternateWorkspace, thirdWorkspace,
  } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_late_switch');
  const state = memoryState({ conversation: 'session-old' });
  const bindInQueue = workspaces.bindWorkspaceSession.bind(workspaces);
  workspaces.bindWorkspaceSession = async (...args) => {
    const bound = await bindInQueue(...args);
    await workspaces.setWorkspace('bot_late_switch', thirdWorkspace, {
      clearSessions: () => state.clearSessions(),
    });
    return bound;
  };
  const scope = createBotWorkspaceScope({
    async adoptWorkspaceSession(sessionId) {
      return { sessionId, workspace: alternateWorkspace };
    },
  }, { botId: 'bot_late_switch', workspaces, state });

  await assert.rejects(
    scope.harness.bindWorkspaceSession('conversation', 'session-target'),
    { code: 'workspace-session-stale' },
  );

  assert.equal(workspaces.workspaceFor('bot_late_switch'), thirdWorkspace);
  assert.deepEqual(state.snapshot(), {});
});

test('a bind started by an old bot incarnation cannot mutate a same-id replacement', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_rebound');
  const oldState = memoryState({ conversation: 'session-old' });
  const adoptionStarted = deferred();
  const releaseAdoption = deferred();
  const oldScope = createBotWorkspaceScope({
    async adoptWorkspaceSession(sessionId) {
      adoptionStarted.resolve();
      await releaseAdoption.promise;
      return { sessionId, workspace: alternateWorkspace };
    },
  }, { botId: 'bot_rebound', workspaces, state: oldState });

  const staleBinding = oldScope.harness.bindWorkspaceSession('conversation', 'session-target');
  await adoptionStarted.promise;
  const removal = await workspaces.beginRemoval('bot_rebound', {
    clearSessions: () => oldState.clearSessions(),
  });
  await workspaces.finishRemoval(removal);
  await workspaces.ensure('bot_rebound', { workspace: defaultWorkspace });
  const replacementIncarnation = workspaces.incarnationFor('bot_rebound');

  releaseAdoption.resolve();
  await assert.rejects(staleBinding, { code: 'workspace-bot-not-found' });

  assert.equal(workspaces.incarnationFor('bot_rebound'), replacementIncarnation);
  assert.equal(workspaces.workspaceFor('bot_rebound'), defaultWorkspace);
  assert.deepEqual(oldState.snapshot(), {});
  assert.equal(oldState.sets, 0);
});

test('binding fences a session creation that started in the previous workspace generation', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_creation');
  const creationStarted = deferred();
  const releaseCreation = deferred();
  const state = memoryState();
  const scope = createBotWorkspaceScope({
    async createSession() {
      creationStarted.resolve();
      await releaseCreation.promise;
      return 'session-from-old-workspace';
    },
    async adoptWorkspaceSession(sessionId) {
      return { sessionId, workspace: alternateWorkspace };
    },
  }, { botId: 'bot_creation', workspaces, state });

  const oldCreation = scope.harness.createSession();
  await creationStarted.promise;
  await scope.harness.bindWorkspaceSession('bound', 'session-target');
  releaseCreation.resolve();
  const staleSessionId = await oldCreation;

  assert.equal(await scope.state.setSession('other', staleSessionId), false);
  assert.deepEqual(state.snapshot(), { bound: 'session-target' });
});

test('two conversations sharing one Session keep independent generation handles', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_shared_session');
  const state = memoryState({ first: 'session-shared', second: 'session-shared' });
  const bothExistenceChecksStarted = deferred();
  const releaseExistenceChecks = deferred();
  let existenceChecks = 0;
  let creations = 0;
  const asked = [];
  const scope = createBotWorkspaceScope({
    async sessionExists(sessionId) {
      assert.equal(sessionId, 'session-shared');
      existenceChecks += 1;
      if (existenceChecks === 2) bothExistenceChecksStarted.resolve();
      await releaseExistenceChecks.promise;
      return true;
    },
    async createSession({ workspace }) {
      assert.equal(workspace, alternateWorkspace);
      creations += 1;
      return `session-current-${creations}`;
    },
    async ask(sessionId, text) {
      asked.push({ sessionId, text });
      return `answer:${text}`;
    },
  }, { botId: 'bot_shared_session', workspaces, state });

  const first = askInWorkspaceSession({
    harness: scope.harness,
    state: scope.state,
    key: 'first',
    text: 'first prompt',
  });
  const second = askInWorkspaceSession({
    harness: scope.harness,
    state: scope.state,
    key: 'second',
    text: 'second prompt',
  });
  await bothExistenceChecksStarted.promise;
  await scope.harness.switchWorkspace(alternateWorkspace);
  releaseExistenceChecks.resolve();

  const replies = await Promise.all([first, second]);
  assert.equal(replies.length, 2);
  assert.equal(asked.some(({ sessionId }) => sessionId === 'session-shared'), false);
  assert.deepEqual(new Set(asked.map(({ sessionId }) => sessionId)), new Set([
    'session-current-1',
    'session-current-2',
  ]));
  assert.equal(workspaces.workspaceFor('bot_shared_session'), alternateWorkspace);
});

test('an old handle stays stale after switching away and rebinding the same Session id', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_rebind_same_id');
  const state = memoryState({ first: 'session-shared' });
  const existenceStarted = deferred();
  const releaseExistence = deferred();
  const asked = [];
  const scope = createBotWorkspaceScope({
    async adoptWorkspaceSession(sessionId) {
      return { sessionId, workspace: defaultWorkspace };
    },
    async sessionExists(sessionId) {
      assert.equal(sessionId, 'session-shared');
      existenceStarted.resolve();
      await releaseExistence.promise;
      return true;
    },
    async createSession({ workspace }) {
      assert.equal(workspace, defaultWorkspace);
      return 'session-after-rebind';
    },
    async ask(sessionId, text) {
      asked.push({ sessionId, text });
      return 'answer';
    },
  }, { botId: 'bot_rebind_same_id', workspaces, state });

  const oldPrompt = askInWorkspaceSession({
    harness: scope.harness,
    state: scope.state,
    key: 'first',
    text: 'old prompt',
  });
  await existenceStarted.promise;
  await scope.harness.switchWorkspace(alternateWorkspace);
  await scope.harness.bindWorkspaceSession('second', 'session-shared');
  releaseExistence.resolve();

  assert.deepEqual(await oldPrompt, { sessionId: 'session-after-rebind', answer: 'answer' });
  assert.deepEqual(asked, [{ sessionId: 'session-after-rebind', text: 'old prompt' }]);
  assert.equal(workspaces.workspaceFor('bot_rebind_same_id'), defaultWorkspace);
  assert.deepEqual(state.snapshot(), {
    second: 'session-shared',
    first: 'session-after-rebind',
  });
});

test('a Session created before a switch keeps its original generation provenance', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_create_provenance');
  const state = memoryState();
  const creationStarted = deferred();
  const releaseCreation = deferred();
  const createdIn = [];
  const asked = [];
  const scope = createBotWorkspaceScope({
    async createSession({ workspace }) {
      createdIn.push(workspace);
      if (createdIn.length === 1) {
        creationStarted.resolve();
        await releaseCreation.promise;
        return 'session-created-before-switch';
      }
      return 'session-created-after-switch';
    },
    async ask(sessionId, text) {
      asked.push({ sessionId, text });
      return 'answer';
    },
  }, { botId: 'bot_create_provenance', workspaces, state });

  const prompting = askInWorkspaceSession({
    harness: scope.harness,
    state: scope.state,
    key: 'conversation',
    text: 'prompt',
  });
  await creationStarted.promise;
  await scope.harness.switchWorkspace(alternateWorkspace);
  releaseCreation.resolve();

  assert.deepEqual(await prompting, {
    sessionId: 'session-created-after-switch',
    answer: 'answer',
  });
  assert.deepEqual(createdIn, [defaultWorkspace, alternateWorkspace]);
  assert.deepEqual(asked, [{ sessionId: 'session-created-after-switch', text: 'prompt' }]);
  assert.deepEqual(state.snapshot(), { conversation: 'session-created-after-switch' });
});

test('workspace persistence failure leaves old mappings cleared and never writes the target session', async (t) => {
  const { root, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const storeDirectory = join(root, 'store');
  const storePath = join(storeDirectory, 'workspaces.json');
  await mkdir(storeDirectory);
  const workspaces = await new BotWorkspaceStore(storePath, { defaultWorkspace }).load();
  await workspaces.ensure('bot_persist');
  const generation = workspaces.generationFor('bot_persist');
  const state = memoryState({ first: 'session-old', second: 'session-other' });
  const scope = createBotWorkspaceScope({
    async adoptWorkspaceSession(sessionId) {
      return { sessionId, workspace: alternateWorkspace };
    },
  }, { botId: 'bot_persist', workspaces, state });

  const savedDirectory = `${storeDirectory}-saved`;
  await rename(storeDirectory, savedDirectory);
  await writeFile(storeDirectory, 'blocks persistence');
  await assert.rejects(scope.harness.bindWorkspaceSession('first', 'session-target'));

  assert.equal(workspaces.workspaceFor('bot_persist'), defaultWorkspace);
  assert.notEqual(workspaces.generationFor('bot_persist'), generation);
  assert.deepEqual(state.snapshot(), {});
  assert.equal(state.sets, 0);

  await rm(storeDirectory, { force: true });
  await rename(savedDirectory, storeDirectory);
});

test('session persistence failure keeps the new workspace and does not restore old mappings', async (t) => {
  const { path, defaultWorkspace, alternateWorkspace } = await fixture(t);
  const workspaces = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await workspaces.ensure('bot_state_failure');
  let sessions = { first: 'session-old', second: 'session-other' };
  const state = {
    sessionFor(key) { return sessions[key] ?? null; },
    async clearSessions() { sessions = {}; },
    async setSession() { throw new Error('state persistence failed'); },
    snapshot() { return { ...sessions }; },
  };
  const scope = createBotWorkspaceScope({
    async adoptWorkspaceSession(sessionId) {
      return { sessionId, workspace: alternateWorkspace };
    },
  }, { botId: 'bot_state_failure', workspaces, state });

  await assert.rejects(
    scope.harness.bindWorkspaceSession('first', 'session-target'),
    /state persistence failed/,
  );

  assert.equal(workspaces.workspaceFor('bot_state_failure'), alternateWorkspace);
  assert.deepEqual(state.snapshot(), {});
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    version: 1,
    workspaces: { bot_state_failure: alternateWorkspace },
  });
});
