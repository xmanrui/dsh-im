import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  deriveWecomAppIdentity,
  generateCallbackSecret,
  WecomAppConfigStore,
} from '../../../src/channels/wecom-app/config-store.mjs';

const CORP_ID = 'ww1234567890abcdef';
const AGENT_ID = '1000002';

function botFixture(overrides = {}) {
  const identity = deriveWecomAppIdentity({ corpId: CORP_ID, agentId: AGENT_ID });
  return {
    botId: identity.botId,
    corpId: CORP_ID,
    agentId: AGENT_ID,
    secretRef: identity.secretRef,
    callbackTokenRef: identity.callbackTokenRef,
    callbackKeyRef: identity.callbackKeyRef,
    callbackSecret: generateCallbackSecret(),
    streamEnabled: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test('bot identity is stable per (corpId, agentId) and refs are derived', () => {
  const identity = deriveWecomAppIdentity({ corpId: CORP_ID, agentId: AGENT_ID });
  const again = deriveWecomAppIdentity({ corpId: CORP_ID, agentId: AGENT_ID });
  assert.equal(identity.botId, again.botId);
  assert.match(identity.botId, /^wecomapp_[a-f0-9]{24}$/);
  assert.match(identity.secretRef, /^DSH_WECOM_APP_SECRET_[A-F0-9]{24}$/);
  assert.match(identity.callbackTokenRef, /^DSH_WECOM_APP_TOKEN_[A-F0-9]{24}$/);
  assert.match(identity.callbackKeyRef, /^DSH_WECOM_APP_AESKEY_[A-F0-9]{24}$/);
});

test('config store persists bots and rejects duplicates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wecomapp-config-'));
  try {
    const store = await new WecomAppConfigStore(join(root, 'config.json')).load();
    const bot = botFixture();
    await store.save(bot);
    assert.equal(store.list().length, 1);
    assert.equal(store.get(bot.botId).corpId, CORP_ID);

    // botId is derived from (corpId, agentId), so re-saving the same identity
    // updates in place instead of creating a second bot.
    const rotated = botFixture({ callbackSecret: generateCallbackSecret() });
    const saved = await store.save(rotated);
    assert.equal(saved.botId, bot.botId);
    assert.equal(store.list().length, 1);
    assert.equal(store.get(bot.botId).callbackSecret, rotated.callbackSecret);

    const updated = await store.update(bot.botId, {
      apiBaseUrl: 'https://proxy.example.com',
      streamEnabled: false,
    });
    assert.equal(updated.apiBaseUrl, 'https://proxy.example.com');
    assert.equal(updated.streamEnabled, false);
    assert.equal(store.get(bot.botId).streamEnabled, false);

    await store.remove(bot.botId);
    assert.equal(store.list().length, 0);

    const reloaded = await new WecomAppConfigStore(join(root, 'config.json')).load();
    assert.deepEqual(reloaded.list(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('config store rejects bots with invalid data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wecomapp-config-invalid-'));
  try {
    const store = await new WecomAppConfigStore(join(root, 'config.json')).load();
    await assert.rejects(() => store.save(botFixture({ corpId: 'x' })));
    await assert.rejects(() => store.save(botFixture({ agentId: 'abc' })));
    await assert.rejects(() => store.save(botFixture({ callbackSecret: 'short' })));
    await assert.rejects(() => store.save(botFixture({ apiBaseUrl: 'ftp://x' })));
    await assert.rejects(() => store.save(botFixture({ secretRef: 'WRONG_PREFIX' })));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('updating with null clears the optional base URLs', async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-wecomapp-config-clear-"));
  try {
    const store = await new WecomAppConfigStore(join(root, "config.json")).load();
    const bot = botFixture({ apiBaseUrl: "https://proxy.example.com", callbackBaseUrl: "https://cb.example.com" });
    await store.save(bot);
    await store.update(bot.botId, { apiBaseUrl: null, callbackBaseUrl: null });
    const updated = store.get(bot.botId);
    assert.equal(updated.apiBaseUrl, undefined);
    assert.equal(updated.callbackBaseUrl, undefined);
    const reloaded = await new WecomAppConfigStore(join(root, "config.json")).load();
    assert.equal(reloaded.get(bot.botId).apiBaseUrl, undefined);
    assert.equal(reloaded.get(bot.botId).callbackBaseUrl, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
