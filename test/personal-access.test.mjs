import assert from 'node:assert/strict';
import test from 'node:test';
import { accessPolicyProvider } from '../plugin-src/host/channels/shared/access-policy-production.mjs';
import { createAccessPolicy, createAccessPolicyScope } from '../src/channels/shared/access-policy.mjs';
import { evaluateInboundAccess } from '../src/channels/shared/inbound-access.mjs';
import { resolveDiscordMessageRoute } from '../src/channels/discord/discord-runtime.mjs';
import { createImHostPlugin } from '../plugin-src/host/index.mjs';

const policy = ids => createAccessPolicy({ direct: createAccessPolicyScope({ mode: 'open', open: { defaultCanExecuteCommands: true, commandPermissionOverrides: [] }, allowlist: { users: ids.map(id => ({ id, canExecuteCommands: true })) } }) });

test('personal access denies strangers and every non-Discord group even when persisted rules are open', () => {
  for (const channel of ['weixin', 'feishu', 'qq', 'dingtalk', 'wecom', 'wecom-app', 'telegram', 'slack', 'whatsapp', 'imessage', 'matrix', 'email', 'discord']) {
    const provider = accessPolicyProvider({ accessPolicyFor: () => policy(['owner']) }, 'bot-one', { channel, personalAccess: true, config: { ownerUserId: 'stranger' } });
    const decide = (senderId, type) => evaluateInboundAccess(provider, { conversationType: type, senderIds: [senderId], text: 'hello' }).allowed;
    assert.equal(decide('owner', 'direct'), true, channel);
    assert.equal(decide('stranger', 'direct'), false, channel);
    assert.equal(decide('stranger', 'group'), false, channel);
    assert.equal(decide('owner', 'group'), channel === 'discord', channel);
  }
});

test('empty or missing owner lists deny everyone and committed owner changes apply immediately', () => {
  let current = policy([]);
  const provider = accessPolicyProvider({ accessPolicyFor: () => current }, 'bot', { channel: 'telegram', personalAccess: true });
  const decide = id => evaluateInboundAccess(provider, { conversationType: 'direct', senderIds: [id], text: 'hello' }).allowed;
  assert.equal(decide('owner'), false);
  current = policy(['owner']); assert.equal(decide('owner'), true);
  current = null; assert.equal(decide('owner'), false);
});

test('personal Discord replies in the source channel and requires every message to mention the bot', async () => {
  const bot = '123456789012345678';
  const message = { id: '423456789012345678', channel_id: '523456789012345678', guild_id: '623456789012345678', author: { id: '223456789012345678' }, content: `<@${bot}> hello`, mentions: [{ id: bot }] };
  const api = { getChannel: () => assert.fail('must not create or resolve a thread'), startThreadFromMessage: () => assert.fail('must not create a thread') };
  const route = await resolveDiscordMessageRoute(message, bot, { api, replyInSourceChannel: true });
  assert.equal(route.replyTarget.channelId, message.channel_id);
  assert.equal(route.requiresMention, true);
  assert.equal(await resolveDiscordMessageRoute({ ...message, mentions: [], content: 'followup' }, bot, { api, replyInSourceChannel: true }), null);
});

test('host forwards personal access and does not start disabled channels', async () => {
  const started = [];
  const internals = Object.fromEntries(['Feishu','Weixin','Dingtalk','Wecom','WecomApp','Qq','Slack','Telegram','Discord','Whatsapp','IMessage','Email','Matrix','Office'].map(name => [`apply${name}`, async (_ctx, config) => { started.push({ name, config }); }]));
  const host = createImHostPlugin({ ...internals, installHostLanguage: () => undefined, installInjectedContext: () => undefined, installUpdateRpc: () => undefined, installInboundTtlRpc: () => undefined });
  await host.apply({ effect: () => undefined, logger: { error() {} } }, { personalAccess: true, disabledChannels: ['whatsapp'] });
  assert.equal(started.some(({ name }) => name === 'Whatsapp'), false);
  assert.ok(started.filter(({ name }) => name !== 'Office').every(({ config }) => config.personalAccess === true));
  await assert.rejects(host.apply({}, { personalAccess: 'open' }), /boolean/);
});

test('personal access preserves an allowlisted user’s disabled command permission', () => {
  const direct = createAccessPolicyScope({ mode: 'open', open: { defaultCanExecuteCommands: true, commandPermissionOverrides: [] }, allowlist: { users: [{ id: 'owner', canExecuteCommands: false }] } });
  const provider = accessPolicyProvider({ accessPolicyFor: () => createAccessPolicy({ direct }) }, 'bot', { channel: 'telegram', personalAccess: true });
  assert.equal(evaluateInboundAccess(provider, { conversationType: 'direct', senderIds: ['owner'], text: 'hello' }).allowed, true);
  assert.equal(evaluateInboundAccess(provider, { conversationType: 'direct', senderIds: ['owner'], text: '/new', isCommand: true }).allowed, false);
});
