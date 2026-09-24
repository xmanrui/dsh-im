import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_ACCESS_POLICY,
  createAccessPolicy,
  createAccessPolicyScope,
  evaluateAccessPolicy,
  normalizeAccessPolicy,
  validateAccessPolicy,
} from '../src/channels/shared/access-policy.mjs';
import {
  BotWorkspaceStore,
  createWorkspaceAwareController,
} from '../src/channels/shared/bot-workspace-store.mjs';

function user(id, canExecuteCommands = true) {
  return { id, canExecuteCommands };
}

function scope({
  mode = 'open',
  defaultCanExecuteCommands = true,
  commandPermissionOverrides = [],
  users = [],
} = {}) {
  return {
    mode,
    open: { defaultCanExecuteCommands, commandPermissionOverrides },
    allowlist: { users },
  };
}

function openScope({
  defaultCanExecuteCommands = true,
  commandPermissionOverrides = [],
  allowlistUsers = [],
} = {}) {
  return scope({
    mode: 'open',
    defaultCanExecuteCommands,
    commandPermissionOverrides,
    users: allowlistUsers,
  });
}

function allowlistScope(users = [], {
  defaultCanExecuteCommands = false,
  commandPermissionOverrides = [],
} = {}) {
  return scope({
    mode: 'allowlist',
    defaultCanExecuteCommands,
    commandPermissionOverrides,
    users,
  });
}

function policy({ direct = openScope(), group = openScope() } = {}) {
  return { direct, group };
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-access-policy-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const defaultWorkspace = join(root, 'workspace');
  await mkdir(defaultWorkspace);
  return {
    root,
    defaultWorkspace,
    path: join(root, 'workspaces.json'),
  };
}

test('access policy validates and normalizes one complete atomic config', () => {
  const normalized = validateAccessPolicy(policy({
    direct: openScope({
      defaultCanExecuteCommands: false,
      commandPermissionOverrides: [user('  user-one  ')],
      allowlistUsers: [user('inactive-member', false)],
    }),
    group: allowlistScope([user(8672352515, false)], {
      commandPermissionOverrides: [user('inactive-admin')],
    }),
  }));

  assert.deepEqual(normalized, {
    direct: {
      mode: 'open',
      open: {
        defaultCanExecuteCommands: false,
        commandPermissionOverrides: [user('user-one')],
      },
      allowlist: { users: [user('inactive-member', false)] },
    },
    group: {
      mode: 'allowlist',
      open: {
        defaultCanExecuteCommands: false,
        commandPermissionOverrides: [user('inactive-admin')],
      },
      allowlist: { users: [user('8672352515', false)] },
    },
  });
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.direct.open.commandPermissionOverrides), true);
  assert.equal(Object.isFrozen(normalized.direct.allowlist.users), true);
  assert.equal(normalizeAccessPolicy({ damaged: true }), null);

  const invalid = [
    {},
    { ...policy(), extra: true },
    policy({ direct: { ...openScope(), extra: true } }),
    policy({ direct: { ...openScope(), mode: 'private' } }),
    policy({ direct: { ...openScope(), open: { defaultCanExecuteCommands: true } } }),
    policy({ direct: openScope({ defaultCanExecuteCommands: 'yes' }) }),
    policy({ direct: openScope({ commandPermissionOverrides: 'user-one' }) }),
    policy({ direct: { ...openScope(), allowlist: { users: 'user-one' } } }),
    policy({ direct: openScope({ commandPermissionOverrides: [user('')] }) }),
    policy({ direct: openScope({ commandPermissionOverrides: [user('bad\u0000id')] }) }),
    policy({ direct: openScope({ commandPermissionOverrides: [user('x'.repeat(257))] }) }),
    policy({ direct: openScope({ commandPermissionOverrides: [user('user', 'yes')] }) }),
    policy({ direct: openScope({
      commandPermissionOverrides: [{ ...user('user'), extra: true }],
    }) }),
    policy({ direct: openScope({
      commandPermissionOverrides: [user(' duplicate '), user('duplicate', false)],
    }) }),
    policy({ direct: allowlistScope([user(' duplicate '), user('duplicate', false)]) }),
    {
      direct: { mode: 'open', defaultCanExecuteCommands: true, users: [] },
      group: { mode: 'open', defaultCanExecuteCommands: true, users: [] },
    },
  ];
  for (const input of invalid) {
    assert.throws(() => validateAccessPolicy(input), { code: 'access-policy-invalid' });
  }
});

test('access policy constructors default closed and accept only canonical scopes', () => {
  assert.deepEqual(DEFAULT_ACCESS_POLICY, policy({
    direct: allowlistScope(),
    group: allowlistScope(),
  }));
  assert.deepEqual(createAccessPolicy({
    direct: createAccessPolicyScope(allowlistScope([
      user('owner'),
      user(1234n),
    ])),
    group: createAccessPolicyScope(openScope()),
  }), policy({
    direct: allowlistScope([
      user('owner'),
      user('1234'),
    ]),
    group: openScope(),
  }));
  assert.deepEqual(createAccessPolicyScope({
    mode: 'open',
    open: {
      defaultCanExecuteCommands: false,
      commandPermissionOverrides: [user('admin')],
    },
    allowlist: { users: [user('member')] },
  }), openScope({
    defaultCanExecuteCommands: false,
    commandPermissionOverrides: [user('admin')],
    allowlistUsers: [user('member')],
  }));
  assert.throws(() => createAccessPolicyScope({
    mode: 'allowlist',
    defaultCanExecuteCommands: false,
    users: [],
  }), { code: 'access-policy-invalid' });
});

test('access decisions keep direct, group, ordinary-message and command permissions separate', () => {
  const settings = policy({
    direct: openScope({
      defaultCanExecuteCommands: false,
      commandPermissionOverrides: [user('admin')],
      allowlistUsers: [user('guest-deny', false)],
    }),
    group: allowlistScope([
      user('member', false),
      user('operator'),
    ], { commandPermissionOverrides: [user('unknown')] }),
  });

  assert.deepEqual(evaluateAccessPolicy(settings, {
    conversationType: 'direct', senderIds: ['guest'],
  }), { allowed: true, reason: 'allowed' });
  assert.deepEqual(evaluateAccessPolicy(settings, {
    conversationType: 'direct', senderIds: ['guest'], isCommand: true,
  }), { allowed: false, reason: 'command-not-allowed' });
  assert.deepEqual(evaluateAccessPolicy(settings, {
    conversationType: 'direct', senderIds: ['admin'], isCommand: true,
  }), { allowed: true, reason: 'allowed' });
  assert.deepEqual(evaluateAccessPolicy(settings, {
    conversationType: 'direct', senderIds: ['guest-deny'], isCommand: true,
  }), { allowed: false, reason: 'command-not-allowed' },
  'the inactive allowlist does not override open-mode command defaults');
  assert.deepEqual(evaluateAccessPolicy(settings, {
    conversationType: 'group', senderIds: ['unknown'],
  }), { allowed: false, reason: 'sender-not-allowed' });
  assert.deepEqual(evaluateAccessPolicy(settings, {
    conversationType: 'group', senderIds: ['member'],
  }), { allowed: true, reason: 'allowed' });
  assert.deepEqual(evaluateAccessPolicy(settings, {
    conversationType: 'group', senderIds: ['member'], isCommand: true,
  }), { allowed: false, reason: 'command-not-allowed' });
  assert.deepEqual(evaluateAccessPolicy(settings, {
    conversationType: 'group',
    senderIds: ['alternate', 'OPERATOR'],
    isCommand: true,
    equals: (left, right) => left.toLowerCase() === right.toLowerCase(),
  }), { allowed: true, reason: 'allowed' });
  const nonCanonical = {
    direct: {
      mode: 'allowlist',
      defaultCanExecuteCommands: false,
      users: [user('old-member', false)],
    },
    group: { mode: 'open', defaultCanExecuteCommands: true, users: [] },
  };
  assert.equal(normalizeAccessPolicy(nonCanonical), null);
  assert.deepEqual(evaluateAccessPolicy(nonCanonical, {
    conversationType: 'direct', senderIds: ['old-member'],
  }), { allowed: false, reason: 'policy-unavailable' });
  assert.deepEqual(evaluateAccessPolicy(null, {
    conversationType: 'direct', senderIds: ['admin'],
  }), { allowed: false, reason: 'policy-unavailable' });
  assert.deepEqual(evaluateAccessPolicy(settings, {
    conversationType: 'channel', senderIds: ['admin'],
  }), { allowed: false, reason: 'invalid-context' });
  assert.deepEqual(evaluateAccessPolicy(settings, {
    conversationType: 'direct', senderIds: [null, 'bad\u0000id'],
  }), { allowed: false, reason: 'sender-unavailable' });
});

test('access decisions read only the active scenario when one id exists in both lists', () => {
  const sameId = policy({
    direct: openScope({
      defaultCanExecuteCommands: false,
      commandPermissionOverrides: [user('same-user', true)],
      allowlistUsers: [user('same-user', false)],
    }),
    group: allowlistScope([user('same-user', false)], {
      defaultCanExecuteCommands: false,
      commandPermissionOverrides: [user('same-user', true)],
    }),
  });

  assert.doesNotThrow(() => validateAccessPolicy(sameId),
    'the same id may appear once in each independent scenario');
  assert.deepEqual(evaluateAccessPolicy(sameId, {
    conversationType: 'direct', senderIds: ['same-user'], isCommand: true,
  }), { allowed: true, reason: 'allowed' },
  'open mode reads its override and ignores the conflicting allowlist row');
  assert.deepEqual(evaluateAccessPolicy(sameId, {
    conversationType: 'group', senderIds: ['same-user'], isCommand: true,
  }), { allowed: false, reason: 'command-not-allowed' },
  'allowlist mode reads its row and ignores the conflicting open override');
});

test('access decisions deny commands when equivalent sender aliases match conflicting rows', () => {
  const settings = policy({
    direct: openScope({
      defaultCanExecuteCommands: true,
      commandPermissionOverrides: [
        user('configured-pn', true),
        user('configured-lid', false),
      ],
    }),
    group: allowlistScope([
      user('configured-pn', true),
      user('configured-lid', false),
    ]),
  });
  const aliases = new Set([
    'sender-pn', 'sender-lid', 'configured-pn', 'configured-lid',
  ]);
  const equals = (left, right) => aliases.has(left) && aliases.has(right);
  const senderIds = ['sender-pn', 'sender-lid'];

  assert.deepEqual(evaluateAccessPolicy(settings, {
    conversationType: 'direct', senderIds, isCommand: true, equals,
  }), { allowed: false, reason: 'command-not-allowed' });
  assert.deepEqual(evaluateAccessPolicy(settings, {
    conversationType: 'group', senderIds, equals,
  }), { allowed: true, reason: 'allowed' },
  'any matching allowlist alias permits an ordinary message');
  assert.deepEqual(evaluateAccessPolicy(settings, {
    conversationType: 'group', senderIds, isCommand: true, equals,
  }), { allowed: false, reason: 'command-not-allowed' });

  const allAllowed = policy({
    direct: openScope({
      defaultCanExecuteCommands: false,
      commandPermissionOverrides: [
        user('configured-pn', true),
        user('configured-lid', true),
      ],
    }),
  });
  assert.deepEqual(evaluateAccessPolicy(allAllowed, {
    conversationType: 'direct', senderIds, isCommand: true, equals,
  }), { allowed: true, reason: 'allowed' },
  'all equivalent matching rows must explicitly allow commands');
});

test('BotWorkspaceStore initializes a missing policy once and upgrades v1 to v2', async (t) => {
  const { path, defaultWorkspace } = await fixture(t);
  await writeFile(path, `${JSON.stringify({
    version: 1,
    workspaces: { bot_one: defaultWorkspace },
    agentPresets: { bot_one: 'router-standard' },
  })}\n`);
  const store = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  const initial = policy({ direct: allowlistScope([
    { id: 'owner', canExecuteCommands: true },
  ]) });

  await store.ensure('bot_one', { initialAccessPolicy: initial });
  assert.deepEqual(store.accessPolicyFor('bot_one'), initial);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(saved.workspaces.bot_one, defaultWorkspace);
  assert.equal(saved.agentPresets.bot_one, 'router-standard');
  assert.deepEqual(saved.accessPolicies.bot_one, initial);

  const replacementSeed = policy({ direct: openScope() });
  await store.ensure('bot_one', { initialAccessPolicy: replacementSeed });
  assert.deepEqual(store.accessPolicyFor('bot_one'), initial, 'initialization is idempotent');

  const reloaded = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  assert.deepEqual(reloaded.accessPolicyFor('bot_one'), initial);
  assert.deepEqual(reloaded.decorateStatus({ bots: [{ botId: 'bot_one' }] }).bots[0].accessPolicy, initial);
});

test('BotWorkspaceStore fail-closes non-canonical v2 policies without rewriting on load', async (t) => {
  const { path, defaultWorkspace } = await fixture(t);
  const valid = policy({
    direct: allowlistScope([user('member')]),
    group: openScope({ defaultCanExecuteCommands: false }),
  });
  const nonCanonical = {
    direct: {
      mode: 'open',
      defaultCanExecuteCommands: false,
      users: [user('old-override')],
    },
    group: {
      mode: 'allowlist',
      defaultCanExecuteCommands: true,
      users: [user('old-member', false)],
    },
  };
  const original = JSON.stringify({
    version: 2,
    workspaces: {
      bot_good: defaultWorkspace,
      bot_noncanonical: defaultWorkspace,
    },
    agentPresets: { bot_good: 'router-standard' },
    contextEnhancement: {
      bot_good: {
        group: { enabled: false, fields: ['senderId'], guidance: '' },
        direct: { enabled: true, fields: ['senderId', 'senderName'], guidance: 'direct' },
      },
    },
    deliveryTargets: {
      bot_good: { target: { kind: 'user', route: { userId: 'one' } } },
    },
    accessPolicies: {
      bot_good: valid,
      bot_noncanonical: nonCanonical,
    },
  });
  await writeFile(path, original);

  const store = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  assert.deepEqual(store.accessPolicyFor('bot_good'), valid);
  assert.equal(store.accessPolicyFor('bot_noncanonical'), null);
  assert.equal(store.agentPresetFor('bot_good'), 'router-standard');
  assert.equal(store.deliveryTargetFor('bot_good', 'target').route.userId, 'one');
  assert.equal(await readFile(path, 'utf8'), original,
    'loading invalid policy data must be read-only');
  await store.ensure('bot_noncanonical', { initialAccessPolicy: policy() });
  assert.equal(store.accessPolicyFor('bot_noncanonical'), null,
    'invalid policy data is not treated as a missing seed');
  assert.equal(await readFile(path, 'utf8'), original);
});

test('BotWorkspaceStore isolates damaged policies and does not initialize over them', async (t) => {
  const { path, defaultWorkspace } = await fixture(t);
  const valid = policy({ group: allowlistScope([
    { id: 'member', canExecuteCommands: true },
  ]) });
  await writeFile(path, `${JSON.stringify({
    version: 2,
    workspaces: {
      bot_good: defaultWorkspace,
      bot_damaged: defaultWorkspace,
      bot_missing: defaultWorkspace,
    },
    deliveryTargets: {
      bot_good: { target: { kind: 'user', route: { userId: 'one' } } },
    },
    accessPolicies: {
      bot_good: valid,
      bot_damaged: { direct: { mode: 'open' } },
    },
  })}\n`);
  const store = await new BotWorkspaceStore(path, { defaultWorkspace }).load();

  assert.deepEqual(store.accessPolicyFor('bot_good'), valid);
  assert.equal(store.accessPolicyFor('bot_damaged'), null);
  assert.equal(store.accessPolicyFor('bot_missing'), null);
  await store.ensure('bot_damaged', { initialAccessPolicy: policy() });
  await store.ensure('bot_missing', { initialAccessPolicy: policy() });

  assert.equal(store.accessPolicyFor('bot_damaged'), null, 'damaged is not treated as missing');
  assert.deepEqual(store.accessPolicyFor('bot_missing'), policy());
  assert.equal(store.deliveryTargetFor('bot_good', 'target').route.userId, 'one');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.accessPolicies.bot_damaged, null);
  assert.deepEqual(saved.accessPolicies.bot_good, valid);
  assert.deepEqual(saved.accessPolicies.bot_missing, policy());
});

test('BotWorkspaceStore fail-closes a damaged policy section without poisoning other bot data', async (t) => {
  const { path, defaultWorkspace } = await fixture(t);
  await writeFile(path, `${JSON.stringify({
    version: 2,
    workspaces: { bot_one: defaultWorkspace },
    agentPresets: { bot_one: 'router-standard' },
    deliveryTargets: {
      bot_one: { target: { kind: 'user', route: { userId: 'one' } } },
    },
    accessPolicies: 'damaged-section',
  })}\n`);
  const store = await new BotWorkspaceStore(path, { defaultWorkspace }).load();

  assert.equal(store.workspaceFor('bot_one'), defaultWorkspace);
  assert.equal(store.agentPresetFor('bot_one'), 'router-standard');
  assert.equal(store.deliveryTargetFor('bot_one', 'target').route.userId, 'one');
  assert.equal(store.accessPolicyFor('bot_one'), null);
  await store.ensure('bot_one', { initialAccessPolicy: policy() });
  assert.equal(store.accessPolicyFor('bot_one'), null,
    'startup initialization must not overwrite a damaged policy section');
});

test('BotWorkspaceStore publishes policy snapshots only after atomic persistence', async (t) => {
  const { root, defaultWorkspace } = await fixture(t);
  const storeDirectory = join(root, 'store');
  const storePath = join(storeDirectory, 'workspaces.json');
  await mkdir(storeDirectory);
  const store = await new BotWorkspaceStore(storePath, { defaultWorkspace }).load();
  const initial = policy({ direct: allowlistScope([
    { id: 'owner', canExecuteCommands: true },
  ]) });
  await store.ensure('bot_io', { initialAccessPolicy: initial });

  await rename(storeDirectory, `${storeDirectory}-saved`);
  await writeFile(storeDirectory, 'blocks policy persistence');
  await assert.rejects(store.setAccessPolicy('bot_io', policy()));
  assert.deepEqual(store.accessPolicyFor('bot_io'), initial);

  await rm(storeDirectory, { force: true });
  await rename(`${storeDirectory}-saved`, storeDirectory);
  assert.deepEqual(JSON.parse(await readFile(storePath, 'utf8')).accessPolicies.bot_io, initial);
});

test('BotWorkspaceStore cleans policies on reconcile and fences same-id stale updates', async (t) => {
  const { path, defaultWorkspace } = await fixture(t);
  const store = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  await store.ensure('bot_one', { initialAccessPolicy: policy() });
  await store.ensure('bot_two', { initialAccessPolicy: policy({ group: allowlistScope() }) });
  const staleIncarnation = store.incarnationFor('bot_one');

  await store.remove('bot_one');
  await store.ensure('bot_one', {
    initialAccessPolicy: policy({ direct: allowlistScope([
      { id: 'new-owner', canExecuteCommands: true },
    ]) }),
  });
  await assert.rejects(store.setAccessPolicy('bot_one', policy(), {
    incarnation: staleIncarnation,
  }), { code: 'workspace-bot-not-found' });
  assert.equal(store.accessPolicyFor('bot_one').direct.allowlist.users[0].id, 'new-owner');

  await store.reconcile(['bot_one']);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.workspaces.bot_two, undefined);
  assert.equal(saved.accessPolicies.bot_two, undefined);
  assert.equal(saved.accessPolicies.bot_one.direct.allowlist.users[0].id, 'new-owner');
});

test('workspace-aware controller preprojects a full policy status before commit', async (t) => {
  const { path, defaultWorkspace } = await fixture(t);
  const store = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  const initial = policy({ direct: allowlistScope() });
  const updated = policy({ direct: openScope({ defaultCanExecuteCommands: false }) });
  await store.ensure('bot_one', { initialAccessPolicy: initial });
  const base = {
    status() { return { bots: [{ botId: 'bot_one', connected: true }] }; },
  };
  const controller = createWorkspaceAwareController(base, {
    workspaces: store,
    stateFor: async () => ({ async clearSessions() {} }),
  });

  const result = await controller.updateAccessPolicy('bot_one', updated, async (projected) => {
    assert.deepEqual(projected.bots[0].accessPolicy, updated);
    assert.deepEqual(store.accessPolicyFor('bot_one'), initial, 'projection happens before commit');
    return { ...projected, projected: true };
  });
  assert.equal(result.projected, true);
  assert.deepEqual(result.bots[0].accessPolicy, updated);
  assert.deepEqual(store.accessPolicyFor('bot_one'), updated);

  await assert.rejects(controller.updateAccessPolicy('bot_one', initial, async () => {
    throw new Error('projection failed');
  }), /projection failed/);
  assert.deepEqual(store.accessPolicyFor('bot_one'), updated);
  assert.throws(() => controller.updateAccessPolicy('bot_one', {
    direct: { mode: 'open', defaultCanExecuteCommands: true, users: [] },
    group: { mode: 'open', defaultCanExecuteCommands: true, users: [] },
  }), {
    code: 'access-policy-invalid',
  });
  assert.deepEqual(store.accessPolicyFor('bot_one'), updated,
    'strict writes reject non-canonical payloads without changing the committed policy');
  await assert.rejects(controller.updateAccessPolicy('missing', initial), {
    code: 'workspace-bot-not-found',
  });
});

test('workspace-aware controller cannot write a policy into a same-id rebound bot', async (t) => {
  const { path, defaultWorkspace } = await fixture(t);
  const store = await new BotWorkspaceStore(path, { defaultWorkspace }).load();
  const oldPolicy = policy({ direct: allowlistScope([
    { id: 'old-owner', canExecuteCommands: true },
  ]) });
  const reboundPolicy = policy({ direct: allowlistScope([
    { id: 'new-owner', canExecuteCommands: true },
  ]) });
  await store.ensure('bot_rebound', { initialAccessPolicy: oldPolicy });
  let markStatusStarted;
  let releaseStatus;
  const statusStarted = new Promise((resolveStarted) => { markStatusStarted = resolveStarted; });
  const statusGate = new Promise((resolveStatus) => { releaseStatus = resolveStatus; });
  const controller = createWorkspaceAwareController({
    async status() {
      markStatusStarted();
      await statusGate;
      return { bots: [{ botId: 'bot_rebound' }] };
    },
  }, {
    workspaces: store,
    stateFor: async () => ({ async clearSessions() {} }),
  });

  const updating = controller.updateAccessPolicy('bot_rebound', policy());
  await statusStarted;
  await store.remove('bot_rebound');
  await store.ensure('bot_rebound', { initialAccessPolicy: reboundPolicy });
  releaseStatus();

  await assert.rejects(updating, { code: 'workspace-bot-not-found' });
  assert.deepEqual(store.accessPolicyFor('bot_rebound'), reboundPolicy);
});
