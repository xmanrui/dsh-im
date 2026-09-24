import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createProductionController,
  normalizeTelegramAllowedUsers,
} from '../../../plugin-src/host/channels/telegram/production.mjs';

test('Telegram per-bot policy normalizes and validates private-message allowlists', () => {
  assert.deepEqual(normalizeTelegramAllowedUsers(undefined), []);
  assert.deepEqual(
    normalizeTelegramAllowedUsers([6087707998, '1202499116', '6087707998']),
    ['6087707998', '1202499116'],
  );
  assert.throws(
    () => normalizeTelegramAllowedUsers('6087707998'),
    /must be an array/,
  );
  assert.throws(
    () => normalizeTelegramAllowedUsers([0, '-100123', 'username']),
    /invalid Telegram User ID/,
  );
});

test('Telegram production has no per-bot result-file Gate', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-telegram-production-artifacts-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const runtimes = [];
  let controllerOptions;

  class ConfigStore {
    async load() { return this; }
    list() { return []; }
  }
  class StateStore {
    async load() { return this; }
  }
  class Harness {
    stopManagedProcess() {}
  }
  class Runtime {
    constructor(options) { runtimes.push(options); }
  }
  class Controller {
    constructor(options) { controllerOptions = options; }
    async close() {}
  }
  const supervisor = {
    ready: Promise.resolve(),
    start() { return this; },
    async close() {},
  };

  const production = await createProductionController({
    credentials: {},
    apiProxy: {},
    logger: () => ({ error() {}, warn() {}, info() {}, debug() {} }),
  }, { dataDir }, {
    ConfigStore,
    StateStore,
    HarnessClient: Harness,
    Controller,
    Runtime,
    createConnectionSupervisor: () => supervisor,
  });
  await controllerOptions.createRuntime({
    botId: 'telegram_default',
    config: { botId: 'telegram_default' },
    token: 'host-only',
  });

  assert.equal(Object.hasOwn(runtimes[0], 'outboundArtifactsEnabled'), false);
  await production.close();
});
