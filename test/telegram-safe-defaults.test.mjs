import assert from 'node:assert/strict';
import test from 'node:test';
import { newBotAccessPolicyFor, initialAccessPolicyFor, accessPolicyProvider } from '../plugin-src/host/channels/shared/access-policy-production.mjs';
import { evaluateInboundAccess } from '../src/channels/shared/inbound-access.mjs';

test('new Telegram bots deny unknown senders in private chats and groups', () => {
  const policy = newBotAccessPolicyFor('telegram', { allowedUsers: ['101', ' 101 ', 202] });
  const provider = accessPolicyProvider({ accessPolicyFor: () => policy }, 'fixture', { channel: 'telegram' });
  for (const conversationType of ['direct', 'group']) {
    assert.equal(policy[conversationType].mode, 'allowlist');
    assert.equal(policy[conversationType].open.defaultCanExecuteCommands, false);
    for (const text of ['hello', '/permission danger-full-access', '/new']) {
      for (const sender of ['101', '202']) {
        assert.equal(evaluateInboundAccess(provider, { conversationType, senderIds: [sender], text }).allowed, true);
      }
      for (const senderIds of [['303'], [], [''], [null]]) {
        assert.equal(evaluateInboundAccess(provider, { conversationType, senderIds, text }).allowed, false);
      }
    }
  }
});

test('unconfigured new Telegram bots fail closed; legacy seeding is unchanged', () => {
  const policy = newBotAccessPolicyFor('telegram');
  const provider = accessPolicyProvider({ accessPolicyFor: () => policy }, 'fixture', { channel: 'telegram' });
  for (const conversationType of ['direct', 'group']) {
    assert.equal(evaluateInboundAccess(provider, { conversationType, senderIds: ['101'], text: '/new' }).allowed, false);
  }
  assert.equal(initialAccessPolicyFor('telegram').group.mode, 'open');
  // Explicit saved policies remain the authority, not the new-bot default.
  const saved = initialAccessPolicyFor('telegram');
  const savedProvider = accessPolicyProvider({ accessPolicyFor: () => saved }, 'existing', { channel: 'telegram' });
  assert.equal(evaluateInboundAccess(savedProvider, { conversationType: 'group', senderIds: ['303'], text: '/new' }).allowed, true);
});
