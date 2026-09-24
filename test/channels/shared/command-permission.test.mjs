import assert from 'node:assert/strict';
import test from 'node:test';

import { isSharedLocalCommand } from '../../../src/channels/shared/command-permission.mjs';
import { evaluateInboundAccess } from '../../../src/channels/shared/inbound-access.mjs';

test('isSharedLocalCommand matches existing local command families', () => {
  for (const command of [
    '/help', '/status', '/new', '/version', '/stop', '/steer more',
    '/batch', '/send', '/cancel', '/history 3', '/workspace /tmp',
    '/workspacelist', '/sessionlist', '/sessions /tmp', '/session 2',
    '/compact', '/models', '/model 2', '/reasonings', '/reasoning high',
    '/presetlist', '/preset default',
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
