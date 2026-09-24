import assert from 'node:assert/strict';
import test from 'node:test';

import {
  accessPolicyProvider,
  initialAccessPolicyFor,
  privilegedSenderIdsFor,
} from '../plugin-src/host/channels/shared/access-policy-production.mjs';
import {
  SET_ACCESS_POLICY_ENDPOINT,
  validAccessPolicyPayload,
} from '../plugin-src/host/channels/shared/access-policy-rpc.mjs';
import { createWeixinRpcHandler, WEIXIN_ENDPOINTS } from '../plugin-src/host/channels/weixin/rpc.mjs';
import { createFeishuRpcHandler, FEISHU_ENDPOINTS } from '../plugin-src/host/channels/feishu/rpc.mjs';
import { createDingtalkRpcHandler, DINGTALK_ENDPOINTS } from '../plugin-src/host/channels/dingtalk/rpc.mjs';
import { createWecomRpcHandler, WECOM_ENDPOINTS } from '../plugin-src/host/channels/wecom/rpc.mjs';
import { createQqRpcHandler, QQ_ENDPOINTS } from '../plugin-src/host/channels/qq/rpc.mjs';
import { createSlackRpcHandler, SLACK_ENDPOINTS } from '../plugin-src/host/channels/slack/rpc.mjs';
import { createTelegramRpcHandler, TELEGRAM_ENDPOINTS } from '../plugin-src/host/channels/telegram/rpc.mjs';
import { createDiscordRpcHandler, DISCORD_ENDPOINTS } from '../plugin-src/host/channels/discord/rpc.mjs';
import { createWhatsappRpcHandler, WHATSAPP_ENDPOINTS } from '../plugin-src/host/channels/whatsapp/rpc.mjs';

const users = (values = []) => values.map((value) => (
  value && typeof value === 'object'
    ? value
    : { id: value, canExecuteCommands: true }
));
const scope = ({
  mode,
  defaultCanExecuteCommands,
  commandPermissionOverrides = [],
  allowlistUsers = [],
}) => ({
  mode,
  open: {
    defaultCanExecuteCommands,
    commandPermissionOverrides: users(commandPermissionOverrides),
  },
  allowlist: { users: users(allowlistUsers) },
});
const open = (allowlistUsers = [], defaultCanExecuteCommands = true) => scope({
  mode: 'open', defaultCanExecuteCommands, allowlistUsers,
});
const allowlist = (allowlistUsers = []) => scope({
  mode: 'allowlist', defaultCanExecuteCommands: false, allowlistUsers,
});
const policy = (direct = open(), group = open()) => ({ direct, group });

test('Host initialization preserves the nine channel access baselines and legacy migrations', () => {
  assert.deepEqual(initialAccessPolicyFor('weixin', { ownerUserId: 'wx-owner' }),
    policy(allowlist(), allowlist()));
  assert.deepEqual(initialAccessPolicyFor('feishu', { ownerOpenIds: ['ou_owner'] }),
    policy(allowlist(), allowlist()));
  assert.deepEqual(initialAccessPolicyFor('feishu', { ownerOpenIds: ['*'] }), policy());
  for (const channel of ['dingtalk', 'wecom', 'slack', 'discord']) {
    assert.deepEqual(initialAccessPolicyFor(channel), policy());
  }
  assert.deepEqual(initialAccessPolicyFor('qq', { ownerUserOpenid: 'qq-owner' }),
    policy(allowlist(), open()));
  assert.deepEqual(initialAccessPolicyFor('qq', { ownerUserOpenid: '*' }), policy());
  assert.deepEqual(initialAccessPolicyFor('telegram', {
    accessMode: 'compatible', allowedUsers: ['101'],
  }), policy(open(['101']), open()));
  assert.deepEqual(initialAccessPolicyFor('telegram', {
    accessMode: 'private-allowlist', allowedUsers: ['101'],
  }), policy(allowlist(['101']), allowlist()));
  assert.deepEqual(initialAccessPolicyFor('whatsapp', {
    accessMode: 'self-only', accountJid: '886900000000@s.whatsapp.net',
  }), policy(allowlist(), allowlist()));
  assert.deepEqual(initialAccessPolicyFor('whatsapp', {
    accessMode: 'private-allowlist',
    accountJid: '886900000000@lid',
    allowedNumbers: ['16505550999'],
  }), policy(allowlist(['16505550999@s.whatsapp.net']), allowlist()));
  assert.deepEqual(initialAccessPolicyFor('whatsapp', {
    accessMode: 'open', allowedNumbers: ['16505550999'],
  }), policy(open(['16505550999@s.whatsapp.net']), open()));
});

test('Host-only owner identities are not copied into public access-policy rows', () => {
  const cases = [
    ['weixin', { ownerUserId: 'wx-private-owner' }, 'wx-private-owner'],
    ['feishu', { ownerOpenIds: ['ou_private_owner'] }, 'ou_private_owner'],
    ['qq', { ownerUserOpenid: 'qq-private-owner' }, 'qq-private-owner'],
    ['whatsapp', {
      accessMode: 'private-allowlist',
      accountJid: '886900000000@lid',
      allowedNumbers: ['16505550999'],
    }, '886900000000@lid'],
  ];
  for (const [channel, config, ownerId] of cases) {
    assert.equal(JSON.stringify(initialAccessPolicyFor(channel, config)).includes(ownerId), false, channel);
  }
});

test('Host access provider reads the latest committed workspace policy', () => {
  let current = policy(allowlist(), allowlist());
  const provider = accessPolicyProvider({ accessPolicyFor: () => current }, 'bot_one', {
    channel: 'feishu', config: { ownerOpenIds: ['ou_owner', '*'] },
  });
  assert.equal(provider.botId, 'bot_one');
  assert.equal(provider.getSettings(), current);
  current = policy();
  assert.equal(provider.getSettings(), current);
  assert.equal(provider.isPrivileged(['ou_owner'], 'direct'), true);
  assert.equal(provider.isPrivileged(['*'], 'group'), false);
  assert.equal(provider.isPrivileged(['ou_other'], 'direct'), false);
  assert.equal(provider.isPrivileged(['ou_owner'], 'unknown'), false);
  const whatsapp = accessPolicyProvider({ accessPolicyFor: () => current }, 'bot_wa', {
    channel: 'whatsapp',
    config: { accountJid: '16505550100@s.whatsapp.net' },
    equals: (left, right) => left.split('@')[0] === right.split('@')[0],
  });
  assert.equal(whatsapp.isPrivileged(['16505550100@lid'], 'group'), true);
});

test('Host privileged identities come only from durable owner or legacy authorization fields', () => {
  assert.deepEqual(privilegedSenderIdsFor('weixin', { ownerUserId: 'wx-owner' }), ['wx-owner']);
  assert.deepEqual(privilegedSenderIdsFor('feishu', { ownerOpenIds: ['*', 'ou_owner'] }), ['ou_owner']);
  assert.deepEqual(privilegedSenderIdsFor('dingtalk', {
    approvedSenders: [{ staffId: 'ding-owner' }, { staffId: 'ding-owner' }],
  }), ['ding-owner']);
  assert.deepEqual(privilegedSenderIdsFor('qq', { ownerUserOpenid: '*' }), []);
  assert.deepEqual(privilegedSenderIdsFor('qq', { ownerUserOpenid: 'qq-owner' }), ['qq-owner']);
  assert.deepEqual(privilegedSenderIdsFor('whatsapp', {
    accountJid: '886900000000@s.whatsapp.net',
  }), ['886900000000@s.whatsapp.net']);
  for (const channel of ['wecom', 'slack', 'telegram', 'discord']) {
    assert.deepEqual(privilegedSenderIdsFor(channel, { allowedUsers: ['legacy'] }), []);
  }
});

test('shared access-policy RPC payload is exact and validates the full atomic policy', () => {
  const value = policy(open([], false), allowlist());
  assert.equal(validAccessPolicyPayload({ botId: 'bot_one', policy: value }), true);
  assert.equal(validAccessPolicyPayload({ botId: 'bot_one', policy: value, extra: true }), false);
  assert.equal(validAccessPolicyPayload({ botId: '../bad', policy: value }), false);
  assert.equal(validAccessPolicyPayload({ botId: 'bot_one', accessMode: 'open' }), false);
  assert.equal(validAccessPolicyPayload({
    botId: 'bot_one',
    policy: {
      direct: { mode: 'open', defaultCanExecuteCommands: true, users: [] },
      group: { mode: 'open', defaultCanExecuteCommands: true, users: [] },
    },
  }), false, 'RPC accepts canonical scopes only');
  assert.equal(validAccessPolicyPayload({
    botId: 'bot_one',
    policy: { ...value, direct: { ...value.direct, mode: 'legacy' } },
  }), false);
});

function controllerFixture() {
  const calls = [];
  const snapshot = (accessPolicy = policy()) => ({
    schemaVersion: 2,
    revision: 1,
    bots: [{
      botId: 'bot_one',
      configured: true,
      connected: true,
      state: 'connected',
      accessPolicy,
    }],
  });
  const controller = {
    status: async () => snapshot(),
    bindCredentials: async () => snapshot(),
    reconnectBot: async () => snapshot(),
    deleteBot: async () => snapshot(),
    startProvisioning: async () => ({}),
    registrationStatus: async () => ({}),
    cancelProvisioning: async () => ({}),
    submitVerification: async () => ({}),
    approveSender: async () => snapshot(),
    revokeSender: async () => snapshot(),
    startRegistration: async () => ({}),
    cancelRegistration: async () => ({}),
    disconnect: async () => snapshot(),
    async updateAccessPolicy(botId, accessPolicy, projectStatus) {
      calls.push({ botId, policy: accessPolicy });
      const value = snapshot(accessPolicy);
      return projectStatus ? projectStatus(value) : value;
    },
  };
  return { controller, calls };
}

test('all nine Host RPCs accept only the unified bot.access-policy.set contract', async () => {
  const factories = [
    ['weixin', createWeixinRpcHandler, WEIXIN_ENDPOINTS],
    ['feishu', createFeishuRpcHandler, FEISHU_ENDPOINTS],
    ['dingtalk', createDingtalkRpcHandler, DINGTALK_ENDPOINTS],
    ['wecom', createWecomRpcHandler, WECOM_ENDPOINTS],
    ['qq', createQqRpcHandler, QQ_ENDPOINTS],
    ['slack', createSlackRpcHandler, SLACK_ENDPOINTS],
    ['telegram', createTelegramRpcHandler, TELEGRAM_ENDPOINTS],
    ['discord', createDiscordRpcHandler, DISCORD_ENDPOINTS],
    ['whatsapp', createWhatsappRpcHandler, WHATSAPP_ENDPOINTS],
  ];
  const next = policy(open([], false), allowlist(['operator']));
  for (const [channel, createHandler, endpoints] of factories) {
    const { controller, calls } = controllerFixture();
    const handler = createHandler(controller);
    assert.equal(endpoints.setAccessPolicy, SET_ACCESS_POLICY_ENDPOINT, channel);
    const result = await handler(endpoints.setAccessPolicy, { botId: 'bot_one', policy: next });
    assert.equal(result.ok, true, `${channel}: ${JSON.stringify(result)}`);
    assert.deepEqual(calls, [{ botId: 'bot_one', policy: next }], channel);
    assert.deepEqual(result.value?.bots?.[0]?.accessPolicy, next, `${channel} update projection`);
    const status = await handler(endpoints.status, {});
    assert.equal(status.ok, true, `${channel} status: ${JSON.stringify(status)}`);
    assert.deepEqual(status.value?.bots?.[0]?.accessPolicy, policy(), `${channel} status projection`);
    const legacy = await handler(endpoints.setAccessPolicy, {
      botId: 'bot_one', accessMode: 'open', allowedUsers: [],
    });
    assert.equal(legacy.ok, false, channel);
    assert.equal(legacy.error.code, 'bad-request', channel);
    assert.equal(calls.length, 1, channel);
  }
});
