import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  deriveWeixinBotIdentity,
  WeixinConfigStore,
} from '../../../src/channels/weixin/config-store.mjs';
import {
  WEIXIN_RECENT_OUTBOUND_LIMIT,
  WEIXIN_RECENT_OUTBOUND_TTL_MS,
  WeixinStateStore,
} from '../../../src/channels/weixin/state-store.mjs';

test('config store persists non-secret account facts atomically with restrictive permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-weixin-config-'));
  const path = join(root, 'nested', 'config.json');
  const store = await new WeixinConfigStore(path).load();
  const identity = deriveWeixinBotIdentity('account@im.bot');
  await store.save({
    ...identity,
    accountId: 'account@im.bot',
    ownerUserId: 'owner-user',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    createdAt: '2026-08-15T00:00:00.000Z',
  });

  const raw = await readFile(path, 'utf8');
  assert.match(raw, /"accountId": "account@im\.bot"/);
  assert.doesNotMatch(raw, /bot_token|secret-token/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual((await new WeixinConfigStore(path).load()).list(), store.list());
});

test('config store rejects duplicate or tampered identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-weixin-invalid-'));
  const path = join(root, 'config.json');
  await writeFile(path, JSON.stringify({
    version: 1,
    accounts: [{
      botId: 'wx_000000000000000000000000',
      accountId: 'real@im.bot',
      tokenRef: 'DSH_WEIXIN_BOT_TOKEN_000000000000000000000000',
      ownerUserId: 'owner',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    }],
  }));
  await assert.rejects(new WeixinConfigStore(path).load(), /invalid account data/);
});

test('state store retains sessions, deduplication, and the getUpdates cursor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-weixin-state-'));
  const path = join(root, 'account', 'state.json');
  const state = await new WeixinStateStore(path).load();
  await state.setSession('p2p:user', 'session-1');
  await state.markSeen('message-1');
  await state.setGetUpdatesBuf('cursor-2');

  const restored = await new WeixinStateStore(path).load();
  assert.equal(restored.sessionFor('p2p:user'), 'session-1');
  assert.equal(restored.hasSeen('message-1'), true);
  assert.equal(restored.getUpdatesBuf(), 'cursor-2');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('context tokens survive restart and workspace changes, remain private, and are cleared on login change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-weixin-context-'));
  const path = join(root, 'state.json');
  const state = await new WeixinStateStore(path).load();
  await state.bindContextTokens('bot-login');
  await state.rememberContextToken({ userId: 'alice', contextToken: 'alice-context', seq: '90071992547409931' });
  await state.rememberContextToken({ userId: 'bob', contextToken: 'bob-context', seq: '2' });
  await state.clearSessions();
  assert.equal(state.contextTokenFor('alice'), 'alice-context');
  assert.equal(state.contextTokenFor('bob'), 'bob-context');
  assert.equal(state.contextTokenFor('unknown'), undefined);
  assert.doesNotMatch(JSON.stringify(state.snapshot()), /alice-context|bob-context/);
  assert.doesNotMatch(await readFile(path, 'utf8'), /bot-login/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  const restored = await new WeixinStateStore(path).load();
  await restored.bindContextTokens('bot-login');
  assert.equal(restored.contextTokenFor('alice'), 'alice-context');
  await restored.bindContextTokens('replacement-login');
  assert.equal(restored.contextTokenFor('alice'), undefined);
  assert.equal((await new WeixinStateStore(path).load()).contextTokenFor('bob'), undefined);
});

test('context tokens ignore empty, duplicate and older inbound updates across restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-weixin-context-order-'));
  const path = join(root, 'state.json');
  let state = await new WeixinStateStore(path).load();
  await state.bindContextTokens('login');
  await state.rememberContextToken({ userId: 'owner', contextToken: 'new', seq: '90071992547409932', messageTimeMs: 2000 });
  state = await new WeixinStateStore(path).load();
  for (const change of [
    { contextToken: 'old', seq: '90071992547409931' },
    { contextToken: 'duplicate', seq: '90071992547409932' },
    { contextToken: 'late', messageTimeMs: 1000 },
    { contextToken: ' ' },
    {},
  ]) await state.rememberContextToken({ userId: 'owner', ...change });
  assert.equal(state.contextTokenFor('owner'), 'new');
  await state.rememberContextToken({ userId: 'owner', contextToken: 'newest', seq: '90071992547409933', messageTimeMs: 3000 });
  assert.equal(state.contextTokenFor('owner'), 'newest');
  await state.remove();
  assert.equal(state.contextTokenFor('owner'), undefined);
});

test('state store resolves recent Weixin bot replies by exact id or one unambiguous timestamp', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-weixin-outbound-state-'));
  const path = join(root, 'account', 'state.json');
  const state = await new WeixinStateStore(path).load();
  const now = Date.now();
  await state.rememberOutboundMessage({
    toUserId: 'owner-user',
    text: '第一条机器人回复',
    sentAt: now - 40_000,
    completedAt: now - 39_900,
    providerMessageIds: ['client-first'],
  });
  await state.rememberOutboundMessage({
    toUserId: 'owner-user',
    text: '第二条机器人回复',
    sentAt: now - 10_000,
    completedAt: now - 9_900,
    providerMessageIds: ['client-second'],
  });

  const restored = await new WeixinStateStore(path).load();
  assert.equal(restored.recentOutboundTextFor({
    toUserId: 'owner-user',
    messageId: 'client-first',
    now,
  }), '第一条机器人回复');
  assert.equal(restored.recentOutboundTextFor({
    toUserId: 'owner-user',
    createTimeMs: now - 10_000,
    now,
  }), '第二条机器人回复');
  assert.equal(restored.recentOutboundTextFor({
    toUserId: 'another-user',
    messageId: 'client-first',
    now,
  }), null);
});

test('state store refuses to guess when a Weixin quote timestamp matches multiple bot replies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-weixin-outbound-ambiguous-'));
  const state = await new WeixinStateStore(join(root, 'state.json')).load();
  const now = Date.now();
  await state.rememberOutboundMessage({
    toUserId: 'owner-user', text: '候选一', sentAt: now - 1_000, completedAt: now - 900,
  });
  await state.rememberOutboundMessage({
    toUserId: 'owner-user', text: '候选二', sentAt: now - 800, completedAt: now - 700,
  });
  assert.equal(state.recentOutboundTextFor({
    toUserId: 'owner-user', createTimeMs: now - 850, now,
  }), null);
});

test('state store bounds the Weixin outbound index by count and age on load', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-weixin-outbound-bounds-'));
  const path = join(root, 'state.json');
  const now = Date.now();
  const recentOutboundMessages = Array.from({
    length: WEIXIN_RECENT_OUTBOUND_LIMIT + 1,
  }, (_, index) => ({
    toUserId: 'owner-user',
    text: `最近回复 ${index}`,
    sentAt: now - 1_000,
    completedAt: now - 900,
    providerMessageIds: [`recent-${index}`],
  }));
  recentOutboundMessages.unshift({
    toUserId: 'owner-user',
    text: '已过期回复',
    sentAt: now - WEIXIN_RECENT_OUTBOUND_TTL_MS - 2_000,
    completedAt: now - WEIXIN_RECENT_OUTBOUND_TTL_MS - 1_000,
    providerMessageIds: ['expired'],
  });
  await writeFile(path, JSON.stringify({
    version: 1,
    sessions: {},
    seenMessageIds: [],
    getUpdatesBuf: '',
    recentOutboundMessages,
  }));

  const state = await new WeixinStateStore(path).load();
  assert.equal(state.snapshot().recentOutboundMessages.length, WEIXIN_RECENT_OUTBOUND_LIMIT);
  assert.equal(state.recentOutboundTextFor({
    toUserId: 'owner-user', messageId: 'expired', now,
  }), null);
  assert.equal(state.recentOutboundTextFor({
    toUserId: 'owner-user', messageId: 'recent-0', now,
  }), null);
  assert.equal(state.recentOutboundTextFor({
    toUserId: 'owner-user', messageId: `recent-${WEIXIN_RECENT_OUTBOUND_LIMIT}`, now,
  }), `最近回复 ${WEIXIN_RECENT_OUTBOUND_LIMIT}`);
});

test('state store matches a recent bot reply from the timestamp encoded in msg_id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-weixin-outbound-msg-id-'));
  const state = await new WeixinStateStore(join(root, 'state.json')).load();
  const now = Date.now();
  const providerTimestamp = now - 1_000;
  const messageId = ((BigInt(providerTimestamp) << 22n) | 123n).toString();
  await state.rememberOutboundMessage({
    toUserId: 'owner-user',
    text: '由真实微信消息 ID 恢复',
    sentAt: providerTimestamp - 7_500,
    completedAt: providerTimestamp - 7_400,
  });
  assert.equal(state.recentOutboundTextFor({
    toUserId: 'owner-user', messageId, now,
  }), '由真实微信消息 ID 恢复');
});
