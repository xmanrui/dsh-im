import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionSyncTargetsFor } from '../plugin-src/host/session-sync-targets.mjs';
import { deliverySwitchesOff } from '../src/channels/shared/delivery-sync-settings.mjs';

/** One synced Feishu DM bound to `session-1`, the shape the workspace store keeps. */
function workspaces() {
  return {
    listSessionSyncTargets: () => [
      { botId: 'bot-a', targetId: 'owner', conversationKey: 'user:ou_owner' },
      { botId: 'bot-a', targetId: 'other', conversationKey: 'user:ou_other' },
    ],
    listDsBotBindings: () => [],
    deliveryTargetFor: (botId, targetId) => (botId === 'bot-a' && targetId === 'owner'
      ? { targetId, kind: 'desktop', route: { openId: 'ou_owner' } }
      : { targetId, kind: 'desktop', route: { openId: 'ou_other' } }),
  };
}

function stateForBotId() {
  return { snapshot: () => ({ sessions: { 'user:ou_owner': 'session-1', 'user:ou_other': 'session-2' } }) };
}

function resolver(settings, options = {}) {
  return createSessionSyncTargetsFor({
    channel: 'feishu',
    workspaces: options.workspaces ?? workspaces(),
    stateForBotId: options.stateForBotId ?? stateForBotId,
    loadSettings: () => {
      if (settings instanceof Error) throw settings;
      return settings;
    },
  });
}

test('the switches are a single predicate: both off silences every path', () => {
  assert.equal(deliverySwitchesOff({ mirrorUserInput: false, deliverModelAnswers: false }), true);
  assert.equal(deliverySwitchesOff({ mirrorUserInput: true, deliverModelAnswers: false }), false);
  assert.equal(deliverySwitchesOff({ mirrorUserInput: false, deliverModelAnswers: true }), false);
  // A damaged document fails closed, exactly like the coordinator treats it.
  assert.equal(deliverySwitchesOff(null), true);
  assert.equal(deliverySwitchesOff({ mirrorUserInput: 'yes', deliverModelAnswers: 'yes' }), true);
});

test('the Feishu card mirror honours both switches being off', async () => {
  const targetsFor = resolver({ mirrorUserInput: false, deliverModelAnswers: false });
  // This is the reviewer's probe: the bridge used to read the persisted targets
  // directly, so the card survived the master switch.
  assert.deepEqual(await targetsFor('session-1'), []);
});

test('one switch on keeps the card mirror alive', async () => {
  for (const settings of [
    { mirrorUserInput: true, deliverModelAnswers: false },
    { mirrorUserInput: false, deliverModelAnswers: true },
  ]) {
    const targetsFor = resolver(settings);
    assert.deepEqual(await targetsFor('session-1'), [
      { openId: 'ou_owner', botId: 'bot-a', targetId: 'owner' },
    ], JSON.stringify(settings));
  }
});

test('an unreadable settings document does not silence an existing mirror', async () => {
  const targetsFor = resolver(new Error('EACCES'));
  assert.deepEqual(await targetsFor('session-1'), [
    { openId: 'ou_owner', botId: 'bot-a', targetId: 'owner' },
  ]);
});

test('a Session no target is bound to still resolves to nothing', async () => {
  const targetsFor = resolver({ deliverModelAnswers: true });
  assert.deepEqual(await targetsFor('session-unknown'), []);
  assert.deepEqual(await targetsFor(''), []);
  assert.deepEqual(await targetsFor(undefined), []);
});

test('a store without session sync targets answers empty instead of failing', async () => {
  const targetsFor = resolver({ deliverModelAnswers: true }, { workspaces: {} });
  assert.deepEqual(await targetsFor('session-1'), []);
});
