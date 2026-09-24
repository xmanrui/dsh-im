import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  DingtalkConfigStore,
  deriveDingtalkBotIdentity,
  deriveDingtalkSenderKey,
} from '../../../src/channels/dingtalk/config-store.mjs';
import { assertRestrictiveMode } from '../../support/filesystem.mjs';

async function temporaryConfig(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-dingtalk-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'nested', 'bots.json');
}

test('bot identity is deterministic while sender keys are random opaque values', () => {
  const clientId = 'ding-client-one';
  const clientDigest = createHash('sha256').update(clientId).digest('hex').slice(0, 24);
  assert.deepEqual(deriveDingtalkBotIdentity(clientId), {
    botId: `dt_${clientDigest}`,
    secretRef: `DSH_DINGTALK_BOT_SECRET_${clientDigest.toUpperCase()}`,
  });

  const firstSenderKey = deriveDingtalkSenderKey();
  const secondSenderKey = deriveDingtalkSenderKey();
  assert.match(firstSenderKey, /^dt_sender_[a-f0-9]{32}$/);
  assert.notEqual(firstSenderKey, secondSenderKey);
});

test('config persists only clientId, derived secretRef, and approvedSenders with mode 0600', async (t) => {
  const path = await temporaryConfig(t);
  const store = await new DingtalkConfigStore(path).load();
  const identity = deriveDingtalkBotIdentity('ding-client-one');
  await store.save({
    ...identity,
    clientId: 'ding-client-one',
    approvedSenders: [{
      senderKey: 'dt_sender_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      staffId: 'staff-private-one',
      displayName: '测试用户',
      approvedAt: '2026-08-15T00:00:00.000Z',
    }],
    ignoredMetadata: 'not-persisted',
  });

  const document = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(Object.keys(document.bots[0]).sort(), [
    'approvedSenders',
    'clientId',
    'secretRef',
  ]);
  assert.equal('botId' in document.bots[0], false);
  assert.equal('clientSecret' in document.bots[0], false);
  await assertRestrictiveMode(path, 0o600);

  const reloaded = await new DingtalkConfigStore(path).load();
  assert.deepEqual(reloaded.get(identity.botId), {
    botId: identity.botId,
    clientId: 'ding-client-one',
    secretRef: identity.secretRef,
    approvedSenders: [{
      senderKey: 'dt_sender_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      staffId: 'staff-private-one',
      displayName: '测试用户',
      approvedAt: '2026-08-15T00:00:00.000Z',
    }],
  });
});

test('config rejects a persisted secret or a non-derived secret reference', async (t) => {
  const path = await temporaryConfig(t);
  const identity = deriveDingtalkBotIdentity('ding-client-one');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    version: 1,
    bots: [{
      clientId: 'ding-client-one',
      secretRef: identity.secretRef,
      clientSecret: 'must-not-be-here',
      approvedSenders: [],
    }],
  }));
  await assert.rejects(
    new DingtalkConfigStore(path).load(),
    /invalid bot data/,
  );

  const store = await new DingtalkConfigStore(`${path}.other`).load();
  await assert.rejects(
    store.save({
      ...identity,
      clientId: 'ding-client-one',
      clientSecret: 'must-not-be-here',
      approvedSenders: [],
    }),
    /invalid dsh-dingtalk bot data/,
  );
  await assert.rejects(
    store.save({
      botId: identity.botId,
      clientId: 'ding-client-one',
      secretRef: 'DSH_DINGTALK_BOT_SECRET_000000000000000000000000',
      approvedSenders: [],
    }),
    /invalid dsh-dingtalk bot data/,
  );
});

test('queued concurrent saves retain every bot and remove by derived bot ID', async (t) => {
  const path = await temporaryConfig(t);
  const store = await new DingtalkConfigStore(path).load();
  const first = deriveDingtalkBotIdentity('ding-client-one');
  const second = deriveDingtalkBotIdentity('ding-client-two');

  await Promise.all([
    store.save({ ...first, clientId: 'ding-client-one', approvedSenders: [] }),
    store.save({ ...second, clientId: 'ding-client-two', approvedSenders: [] }),
  ]);
  assert.equal(store.list().length, 2);
  assert.equal(store.getByClientId('ding-client-two').botId, second.botId);
  assert.equal((await store.remove(first.botId)).clientId, 'ding-client-one');
  assert.deepEqual(store.list().map((bot) => bot.botId), [second.botId]);
});
