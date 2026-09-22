import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  EMAIL_CHANNEL_ENABLED_ENV,
  emailChannelGate,
  isEmailChannelEnabled,
} from '../plugin-src/host/channels/email/availability.mjs';
import { createEmailRpcHandler, EMAIL_ENDPOINTS } from '../plugin-src/host/channels/email/rpc.mjs';

/**
 * The email channel is enabled by default. These tests pin what opting out does — refuse
 * the entry point and start no runtime — and that nothing is deleted, so
 * reopening the single switch brings every mailbox back.
 */

test('the email switch is enabled by default and supports explicit opt-out', () => {
  assert.equal(isEmailChannelEnabled({}, {}), true, 'enabled with nothing configured');
  assert.equal(isEmailChannelEnabled({}, { [EMAIL_CHANNEL_ENABLED_ENV]: '0' }), false);
  assert.equal(isEmailChannelEnabled({}, { [EMAIL_CHANNEL_ENABLED_ENV]: 'false' }), false);
  assert.equal(isEmailChannelEnabled({}, { [EMAIL_CHANNEL_ENABLED_ENV]: '' }), false);
  assert.equal(isEmailChannelEnabled({}, { [EMAIL_CHANNEL_ENABLED_ENV]: 'yes' }), true);
  assert.equal(isEmailChannelEnabled({}, { [EMAIL_CHANNEL_ENABLED_ENV]: '1' }), true);
  assert.equal(isEmailChannelEnabled({ emailChannelEnabled: true }, {}), true,
    'the config switch opens it without an environment change');
  assert.equal(isEmailChannelEnabled({ emailChannelEnabled: false },
    { [EMAIL_CHANNEL_ENABLED_ENV]: '1' }), false,
  'an explicit config value wins over the environment');
});

test('the host gate reports a closed channel without throwing', () => {
  assert.equal(emailChannelGate({ emailChannelEnabled: true }, {}), null,
    'an open channel has no gate');
  const closed = emailChannelGate({ emailChannelEnabled: false }, {});
  assert.equal(closed.ok, false);
  assert.equal(closed.error.code, 'email-channel-disabled');
});

test('a closed channel serves the closed state to the client and refuses every action', async () => {
  // The Host mounts the RPC with a disabled controller in this state; the
  // handler is what the settings page talks to.
  const handler = createEmailRpcHandler({
    disabled: () => ({
      ok: false,
      error: { code: 'email-channel-disabled', message: 'Email is not available yet.', details: {} },
    }),
  });

  const availability = await handler(EMAIL_ENDPOINTS.availability);
  assert.deepEqual(availability, { ok: true, value: { enabled: false } },
    'the client learns the channel is closed and hides the entry point');

  const bind = await handler(EMAIL_ENDPOINTS.bindMailbox, { address: 'new@example.com' });
  assert.equal(bind.ok, false, 'a closed channel cannot bind a new mailbox');
  assert.equal(bind.error.code, 'email-channel-disabled');
});

test('availability is answered before the controller is consulted', async () => {
  // The client asks this endpoint to decide whether to render the mailbox entry
  // point at all, so it must answer in both states without a fully wired
  // controller — including the closed one, where no controller exists.
  assert.deepEqual(
    await createEmailRpcHandler({ disabled: () => ({ ok: false }) })(EMAIL_ENDPOINTS.availability),
    { ok: true, value: { enabled: false } },
    'the closed state is reported without touching the controller',
  );
});

test('closing starts no runtime and deletes nothing, so reopening keeps every mailbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-im-email-gate-'));
  try {
    await mkdir(join(root, 'bots'), { recursive: true });
    const configPath = join(root, 'config.json');
    const seeded = {
      bots: [{
        botId: 'existing-mailbox',
        address: 'existing@example.com',
        transport: 'agent-mail',
        allowedSenders: ['owner@example.com'],
        tokenRef: 'ref-existing',
      }],
    };
    await writeFile(configPath, JSON.stringify(seeded));

    // Closing is a gate decision, not a migration: it never touches the store.
    assert.notEqual(emailChannelGate({ emailChannelEnabled: false }, {}), null, 'the channel is closed');

    const onDisk = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(onDisk, seeded,
      'a closed channel leaves the mailbox configuration byte for byte intact');
    assert.equal(onDisk.bots[0].tokenRef, 'ref-existing',
      'the credential reference survives, so reopening needs no re-authorization');
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test('the host entry point installs no production controller while closed', async () => {
  const source = await readFile(
    new URL('../plugin-src/host/channels/email/index.mjs', import.meta.url),
    'utf8',
  );
  // The closed branch must return before createProduction is ever reached;
  // otherwise a configured mailbox would still be connected at startup.
  const gateIndex = source.indexOf('emailChannelGate(config)');
  const productionIndex = source.indexOf('createProduction:');
  assert.ok(gateIndex !== -1, 'the entry point consults the switch');
  assert.ok(productionIndex !== -1, 'the entry point still wires production');
  assert.ok(gateIndex < productionIndex,
    'the switch is checked before any production controller is constructed');
  assert.match(source.slice(gateIndex, productionIndex),
    /return installEmailRpc\(/u,
    'the closed branch returns the RPC-only mount and never starts a runtime');
});
