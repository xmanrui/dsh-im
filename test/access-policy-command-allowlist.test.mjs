import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateAccessPolicy,
  normalizeCommandName,
  validateAccessPolicy,
} from '../src/channels/shared/access-policy.mjs';

const admin = 'ou_admin';
const user = 'ou_user';

function policy(open) {
  return {
    direct: { mode: 'open', open, allowlist: { users: [] } },
    group: { mode: 'open', open, allowlist: { users: [] } },
  };
}

const open = {
  defaultCanExecuteCommands: false,
  commandAllowlist: ['new', 'stop'],
  commandPermissionOverrides: [{ id: admin, canExecuteCommands: true }],
};

test('normalizes a command token', () => {
  assert.equal(normalizeCommandName('/SessionList --limit 5'), 'sessionlist');
  assert.equal(normalizeCommandName('  /new  '), 'new');
  assert.equal(normalizeCommandName('hello'), 'hello');
  assert.equal(normalizeCommandName('/'), null);
  assert.equal(normalizeCommandName(''), null);
});

test('scope allowlist only admits listed commands', () => {
  const value = policy(open);
  assert.equal(evaluateAccessPolicy(value, {
    conversationType: 'direct', senderIds: [user], isCommand: true, command: 'new',
  }).allowed, true);
  assert.equal(evaluateAccessPolicy(value, {
    conversationType: 'direct', senderIds: [user], isCommand: true, command: '/stop',
  }).allowed, true);
  assert.deepEqual(evaluateAccessPolicy(value, {
    conversationType: 'direct', senderIds: [user], isCommand: true, command: 'history',
  }), { allowed: false, reason: 'command-not-allowed' });
  assert.equal(evaluateAccessPolicy(value, {
    conversationType: 'direct', senderIds: [user], isCommand: false, command: null,
  }).allowed, true);
});

test('owner override keeps full command access', () => {
  assert.equal(evaluateAccessPolicy(policy(open), {
    conversationType: 'direct', senderIds: [admin], isCommand: true, command: 'sessionlist',
  }).allowed, true);
});

test('per-user allowlist is honored when default is denied', () => {
  const value = policy({
    defaultCanExecuteCommands: false,
    commandAllowlist: ['help'],
    commandPermissionOverrides: [{
      id: user,
      canExecuteCommands: false,
      commandAllowlist: ['history'],
    }],
  });
  assert.equal(evaluateAccessPolicy(value, {
    conversationType: 'direct', senderIds: [user], isCommand: true, command: 'history',
  }).allowed, true);
  assert.equal(evaluateAccessPolicy(value, {
    conversationType: 'direct', senderIds: [user], isCommand: true, command: 'help',
  }).allowed, true);
  assert.equal(evaluateAccessPolicy(value, {
    conversationType: 'direct', senderIds: [user], isCommand: true, command: 'workspace',
  }).allowed, false);
});

test('legacy policies without commandAllowlist keep their previous meaning', () => {
  const legacy = {
    direct: {
      mode: 'open',
      open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
      allowlist: { users: [] },
    },
    group: {
      mode: 'open',
      open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
      allowlist: { users: [] },
    },
  };
  assert.equal(validateAccessPolicy(legacy).direct.open.commandAllowlist.length, 0);
  assert.equal(evaluateAccessPolicy(legacy, {
    conversationType: 'direct', senderIds: [user], isCommand: true, command: 'new',
  }).allowed, false);
});
