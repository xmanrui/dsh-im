import assert from 'node:assert/strict';
import test from 'node:test';

import { isSharedLocalCommand } from '../../../src/channels/shared/command-permission.mjs';
import { evaluateInboundAccess } from '../../../src/channels/shared/inbound-access.mjs';
import {
  COMMAND_PERMISSION_GROUPS,
  COMMAND_PERMISSION_IDS,
  normalizeAllowedCommands,
  resolveCommandPermissionId,
} from '../../../src/channels/shared/command-permission-catalog.mjs';
import { SHARED_COMMAND_CATALOG } from '../../../src/channels/shared/command-catalog.mjs';

test('isSharedLocalCommand matches existing local command families', () => {
  for (const command of [
    '/help', '/status', '/new', '/version', '/stop', '/steer more',
    '/batch', '/send', '/cancel', '/history 3', '/workspace /tmp',
    '/workspacelist', '/sessionlist', '/sessions /tmp', '/session 2',
    '/compact', '/models', '/model 2', '/reasonings', '/reasoning high',
    '/presetlist', '/preset default',
    '/clear',
  ]) {
    assert.equal(isSharedLocalCommand(command), true, command);
  }
});

test('isSharedLocalCommand leaves unknown and channel-specific slash text as ordinary prompts', () => {
  for (const text of [
    '/foo', '/help me', 'hello', '/', '',
    '/menu', '/repair verify', '/watch session-id', '/unwatch session-id',
    '/watchlist', '/archived off',
  ]) {
    assert.equal(isSharedLocalCommand(text), false, text);
  }
});

test('isSharedLocalCommand follows current media command routing', () => {
  assert.equal(isSharedLocalCommand('/history', { hasFiles: true }), true);
  assert.equal(isSharedLocalCommand('/batch', { hasFiles: true }), true);
  assert.equal(isSharedLocalCommand('/status', { hasImages: true }), false);
  assert.equal(isSharedLocalCommand('/workspace /tmp', { hasFiles: true }), false);
  assert.equal(isSharedLocalCommand('/stop', { hasImages: true }), true);
  assert.equal(isSharedLocalCommand('/stop', { hasFiles: true }), false);
  assert.equal(isSharedLocalCommand('/clear', { hasFiles: true }), true);
});

test('evaluateInboundAccess always preserves an original owner privilege', () => {
  const deniedPolicy = {
    direct: {
      mode: 'allowlist',
      open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
      allowlist: { users: [] },
    },
    group: {
      mode: 'allowlist',
      open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
      allowlist: { users: [] },
    },
  };
  const accessPolicy = {
    getSettings: () => deniedPolicy,
    isPrivileged: (senderIds) => senderIds === 'owner-id',
  };
  assert.deepEqual(evaluateInboundAccess(accessPolicy, {
    conversationType: 'group',
    senderIds: 'owner-id',
    text: '/status',
  }), { allowed: true, reason: 'privileged-sender' });
  assert.equal(evaluateInboundAccess(accessPolicy, {
    conversationType: 'group',
    senderIds: 'another-user',
    text: '/status',
  }).allowed, false);
});

test('command permission catalog exposes unique ids and resolves every alias', () => {
  assert.equal(new Set(COMMAND_PERMISSION_IDS).size, COMMAND_PERMISSION_IDS.length);
  const aliases = new Map();
  for (const group of COMMAND_PERMISSION_GROUPS) {
    for (const command of group.commands) {
      assert.ok(!aliases.has(command.id), `duplicate command id ${command.id}`);
      aliases.set(command.id, command.aliases);
    }
  }
  assert.equal(aliases.size, COMMAND_PERMISSION_IDS.length);
  const expectations = {
    '/new': 'new',
    '/fork title': 'fork',
    '/ws 2': 'workspace',
    '/wsl': 'workspacelist',
    '/conversation /tmp': 'conv',
    '/sessions': 'sessionlist',
    '/sess session-1': 'session',
    '/sessarchive session-1': 'sessionarchive',
    '/list': 'ls',
    '/peek 2': 'tail',
    '/reasonings': 'reasoninglist',
    '/presets': 'presetlist',
    '/m': 'menu',
    '/menu': 'menu',
    '/permissionlist': 'permissionlist',
    '/repair verify': 'repair',
    '/watch session-1': 'watch',
    '/unwatch session-1': 'unwatch',
    '/archived off': 'archived',
  };
  for (const [text, id] of Object.entries(expectations)) {
    assert.equal(resolveCommandPermissionId(text), id, text);
  }
  assert.equal(resolveCommandPermissionId('/foo'), null);
  assert.equal(resolveCommandPermissionId('hello'), null);
  assert.equal(resolveCommandPermissionId('/help me'), 'help',
    'callers only resolve after their own isCommand check');
});

test('every shared menu catalog command has a stable permission id', () => {
  for (const command of SHARED_COMMAND_CATALOG) {
    assert.ok(COMMAND_PERMISSION_IDS.includes(command.name), command.name);
    assert.equal(resolveCommandPermissionId(`/${command.name}`), command.name);
  }
});

test('normalizeAllowedCommands rejects malformed lists and accepts catalog order', () => {
  assert.deepEqual(normalizeAllowedCommands(['status', 'help']), ['status', 'help']);
  assert.deepEqual(normalizeAllowedCommands([]), []);
  for (const value of [undefined, 'help', [null], [''], ['help', 'help'], ['unknown']]) {
    assert.throws(() => normalizeAllowedCommands(value), { code: 'access-policy-invalid' });
  }
});

test('an explicit command id gates card actions even without command text', () => {
  const settings = {
    direct: {
      mode: 'allowlist',
      open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
      allowlist: { users: [{ id: 'user', canExecuteCommands: true, allowedCommands: ['help'] }] },
    },
    group: {
      mode: 'allowlist',
      open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
      allowlist: { users: [] },
    },
  };
  const accessPolicy = { getSettings: () => settings };
  assert.deepEqual(evaluateInboundAccess(accessPolicy, {
    conversationType: 'direct', senderIds: 'user', commandId: 'help',
  }), { allowed: true, reason: 'allowed' });
  assert.deepEqual(evaluateInboundAccess(accessPolicy, {
    conversationType: 'direct', senderIds: 'user', commandId: 'new',
  }), { allowed: false, reason: 'command-not-allowed' });
});
