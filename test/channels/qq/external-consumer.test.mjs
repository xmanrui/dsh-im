import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ApiError } from '@tencent-connect/qqbot-nodejs/protocol';
import { QQBot } from '@tencent-connect/qqbot-nodejs';

import { QqConfigStore, deriveQqBotIdentity } from '../../../src/channels/qq/config-store.mjs';
import { QqController } from '../../../src/channels/qq/qq-controller.mjs';
import { QqRuntime } from '../../../src/channels/qq/qq-runtime.mjs';
import { QqExternalConsumer, verifiedQqAccount } from '../../../src/channels/qq/external-consumer.mjs';
import { createDeliveryService } from '../../../plugin-src/host/delivery-service.mjs';
import { createDeliveryAdapter } from '../../../plugin-src/host/delivery-adapter.mjs';

test('authenticated robot identity tolerates an omitted bot flag and refuses contradictory flags', () => {
  const account = verifiedQqAccount('12345678', { id: 'native-bot-id' });
  assert.equal(account.fingerprint, verifiedQqAccount('12345678', { id: 'native-bot-id', bot: true }).fingerprint);
  for (const bot of [false, null, 'true', 1, undefined])
    assert.throws(() => verifiedQqAccount('12345678', { id: 'native-bot-id', bot }), { code: 'account-unverified' });
  assert.throws(() => verifiedQqAccount('12345678', {}), { code: 'account-unverified' });
});

class PlatformBot extends EventEmitter {
  sent = [];
  api = { get: async () => ({ id: 'native-bot-id', username: 'QA Bot', bot: true }), getToken: async () => 'test-token' };
  apiClient = { request: async (_token, _method, path, body) => this.sendText({
    scope: 'group', targetId: path.split('/')[3], msgId: body.msg_id,
  }, body.content) };
  use() {}
  async start(signal) {
    queueMicrotask(() => this.emit('ready', {}));
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  }
  stop() {}
  async sendText(target, text) {
    this.sent.push({ target, text });
    return { id: 'native-reply-id', timestamp: Date.now() };
  }
  async deliver(message) {
    await Promise.all(this.listeners('message').map(listener => listener({}, message)));
  }
}

async function fixture(t, logger) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-qq-checked-'));
  const store = await new QqConfigStore(join(directory, 'config.json')).load();
  const identity = deriveQqBotIdentity('12345678');
  await store.save({ ...identity, appId: '12345678', ownerUserOpenid: 'owner' });
  let bot;
  let standaloneRuns = 0;
  const controller = new QqController({
    configStore: store,
    credentials: { resolve: async () => ({ value: 'test-secret' }), set: async () => {}, unset: async () => {} },
    qrAuth: { start() {} },
    createRuntime: async args => new QqRuntime({
      ...args, state: {}, harness: { ensureRunning: async () => { standaloneRuns++; } },
      ...(logger ? { logger } : {}),
      typingMiddleware: () => () => {}, connectTimeoutMs: 100,
      createBot: () => { bot = new PlatformBot(); return bot; },
    }),
  });
  t.after(() => controller.close());
  await controller.initialize();
  return { controller, store, botId: identity.botId, bot: () => bot, standaloneRuns: () => standaloneRuns };
}

function mention(overrides = {}) {
  return { kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', messageId: 'native-source-id',
    senderId: 'app-scoped-member', groupOpenid: 'app-scoped-group', content: 'hello',
    timestamp: new Date().toISOString(),
    replyTarget: { scope: 'group', targetId: 'app-scoped-group', msgId: 'native-source-id' },
    ...overrides };
}

test('public QQ proactive text returns an own-app native group receipt without source reply fields', async t => {
  const fx = await fixture(t);
  const fingerprint = (await fx.controller.describeDeliveryAccount(fx.botId)).account.fingerprint;
  await fx.controller.consumeInbound(fx.botId, { expectedFingerprint: fingerprint,
    onEvent: async () => ({ accepted: true }),
  });
  const target = { targetId: 'qa-group', kind: 'group', route: { groupOpenId: 'app-scoped-group' } };
  const service = createDeliveryService();
  service.registerAdapter(createDeliveryAdapter({ channel: 'qq', coreController: fx.controller,
    workspaces: { has: id => id === fx.botId, listDeliveryTargets: () => [target] },
    stateFor: async () => ({}),
  }));
  const requests = [];
  fx.bot().apiClient.request = async (token, method, path, body) => {
    requests.push({ token, method, path, body });
    return { id: 'native-proactive-id', timestamp: '2026-10-08T23:00:00+08:00' };
  };
  const expectedTargetDigest = createHash('sha256').update(JSON.stringify({ kind: 'group', route: target.route })).digest('hex');
  assert.deepEqual(await service.sendChecked(fx.botId, target.targetId, 'Delayed result', {
    expectedFingerprint: fingerprint, expectedTargetDigest, receipt: true, beforeSend: () => true,
  }), { sent: true, receipt: { version: 1, messageId: 'native-proactive-id', conversationId: 'app-scoped-group' } });
  assert.deepEqual(requests, [{ token: 'test-token', method: 'POST',
    path: '/v2/groups/app-scoped-group/messages', body: { msg_type: 0, content: 'Delayed result' } }]);
});

async function proactiveFixture(t, logger) {
  const fx = await fixture(t, logger);
  const fingerprint = (await fx.controller.describeDeliveryAccount(fx.botId)).account.fingerprint;
  const dispose = await fx.controller.consumeInbound(fx.botId, { expectedFingerprint: fingerprint,
    onEvent: async () => ({ accepted: true }),
  });
  const target = { targetId: 'qa-group', kind: 'group', route: { groupOpenId: 'app-scoped-group' } };
  const service = createDeliveryService();
  service.registerAdapter(createDeliveryAdapter({ channel: 'qq', coreController: fx.controller,
    workspaces: { has: id => id === fx.botId, listDeliveryTargets: () => [target] },
    stateFor: async () => ({}),
  }));
  const options = { expectedFingerprint: fingerprint,
    expectedTargetDigest: createHash('sha256').update(JSON.stringify({ kind: 'group', route: target.route })).digest('hex'),
    receipt: true, beforeSend: () => true };
  return { ...fx, options, dispose,
    send: (overrides = {}) => service.sendChecked(fx.botId, target.targetId, 'Delayed result', { ...options, ...overrides }) };
}

test('public QQ proactive post rechecks revocation and own-app identity after preparing the token', async t => {
  for (const scenario of ['blocked', 'cancelled', 'account-changed', 'receiver-disposed']) {
    const fx = await proactiveFixture(t);
    const abort = new AbortController();
    let allowed = true;
    let dispatched = 0;
    fx.bot().apiClient.request = async () => { dispatched++; return { id: 'must-not-send' }; };
    fx.bot().api.getToken = async () => {
      if (scenario === 'blocked') allowed = false;
      if (scenario === 'cancelled') abort.abort();
      if (scenario === 'account-changed') fx.bot().api.get = async () => ({ id: 'different-bot', bot: true });
      if (scenario === 'receiver-disposed') fx.dispose();
      return 'prepared-token';
    };
    await assert.rejects(() => fx.send({ signal: abort.signal, beforeSend: () => allowed }), {
      code: { blocked: 'send-permission-denied', cancelled: 'cancelled',
        'account-changed': 'account-changed', 'receiver-disposed': 'cancelled' }[scenario],
    });
    assert.equal(dispatched, 0);
  }
});

test('public QQ proactive post preserves native refusals and unknown without resending', async t => {
  const fx = await proactiveFixture(t);
  for (const [bizCode, httpStatus, code] of [
    [40034105, 403, 'send-permission-denied'], [40034101, 403, 'send-permission-denied'],
    [40054002, 403, 'send-permission-denied'], [40034100, 400, 'send-rate-limited'],
    [undefined, 429, 'send-rate-limited'], [40054007, 400, 'bad-request'],
    [50055001, 500, 'send-result-unknown'],
  ]) {
    let dispatched = 0;
    fx.bot().apiClient.request = async () => {
      dispatched++;
      throw new ApiError('native rejection', httpStatus, '/v2/groups/test/messages', bizCode);
    };
    await assert.rejects(() => fx.send(), { code });
    assert.equal(dispatched, 1);
  }
  for (const outcome of ['lost-response', 'missing-id', 'cancel-after-dispatch']) {
    const abort = new AbortController();
    let dispatched = 0;
    fx.bot().apiClient.request = async () => {
      dispatched++;
      if (outcome === 'lost-response') throw new Error('connection closed');
      if (outcome === 'cancel-after-dispatch') abort.abort();
      return outcome === 'missing-id' ? {} : { id: 'possibly-delivered' };
    };
    await assert.rejects(() => fx.send({ signal: abort.signal }), { code: 'send-result-unknown' });
    assert.equal(dispatched, 1);
  }
});

test('public QQ post diagnostics distinguish a native refusal from a local fence without leaking input', async t => {
  const records = [];
  const fx = await proactiveFixture(t, { info: (_label, record) => records.push(record) });
  fx.bot().apiClient.request = async () => {
    throw new ApiError('private token and URL must not be logged', 403, '/v2/groups/private-group/messages', 40034105);
  };
  await assert.rejects(() => fx.send(), { code: 'send-permission-denied' });
  assert.deepEqual(records.at(-1), { event: 'qq-external-post', initiator: 'external-consumer',
    phase: 'refused', durationMs: records.at(-1).durationMs, reason: 'send-permission-denied',
    stage: 'native-post', httpStatus: 403, providerCode: 40034105 });
  records.length = 0;
  await assert.rejects(() => fx.send({ beforeSend: () => false }), { code: 'send-permission-denied' });
  assert.equal(records.at(-1)?.stage, undefined);
  assert.equal(records.at(-1)?.httpStatus, undefined);
  assert.equal(records.at(-1)?.providerCode, undefined);
  assert.equal(JSON.stringify(records).includes('private'), false);
});

test('runtime diagnostics require a native refusal from the current post attempt', async t => {
  const records = [];
  const bot = new PlatformBot();
  let dispatches = 0;
  bot.apiClient.request = async () => {
    dispatches++;
    throw new ApiError('private native error', 403, '/private', 40034105);
  };
  const runtime = new QqRuntime({
    config: { botId: 'qq_test', appId: '12345678', consumerMode: 'external-consumer' },
    appSecret: 'test-secret', state: {}, harness: {}, connectTimeoutMs: 100,
    createBot: () => bot, logger: { info: (_label, record) => records.push(record) },
  });
  t.after(() => runtime.stop());
  await runtime.start();
  const target = { kind: 'group', route: { groupOpenId: 'app-scoped-group' } };
  const options = { expectedFingerprint: (await runtime.describeDeliveryAccount()).fingerprint,
    beforeSend: () => true, verifyAccount: async () => {} };
  let previous;
  await assert.rejects(() => runtime.sendProactiveText(target, 'private text', options), error => {
    previous = error;
    return error.code === 'send-permission-denied';
  });
  assert.equal(dispatches, 1);
  assert.equal(records.at(-1).providerCode, 40034105);
  const forged = Object.assign(new Error('private local error'), { code: 'send-permission-denied',
    nativePost: { httpStatus: 403, providerCode: 40034105 } });
  for (const error of [forged, previous]) {
    records.length = 0;
    await assert.rejects(() => runtime.sendProactiveText(target, 'private text', {
      ...options, beforeSend: () => { throw error; },
    }), { code: 'send-permission-denied' });
    assert.equal(dispatches, 1);
    assert.equal(records.at(-1).phase, 'refused');
    assert.equal(records.at(-1).stage, undefined);
    assert.equal(records.at(-1).httpStatus, undefined);
    assert.equal(records.at(-1).providerCode, undefined);
    assert.equal(JSON.stringify(records).includes('private'), false);
  }
  for (const code of [null, '', false, '  ', '1e2', -1]) {
    bot.apiClient.request = async () => { throw new ApiError('private', 500, '/private', code); };
    await assert.rejects(() => runtime.sendProactiveText(target, 'private text', options),
      { code: 'send-result-unknown' });
    assert.equal(records.at(-1).stage, 'native-post');
    assert.equal(records.at(-1).httpStatus, 500);
    assert.equal(records.at(-1).providerCode, undefined);
  }
});

test('public QQ proactive post refuses absent fences and changed targets before any effect', async t => {
  const fx = await proactiveFixture(t);
  let tokenRequests = 0;
  fx.bot().api.getToken = async () => { tokenRequests++; return 'token'; };
  await assert.rejects(() => fx.send({ beforeSend: undefined }), { code: 'capability-unavailable' });
  await assert.rejects(() => fx.send({ beforeSend: () => false }), { code: 'send-permission-denied' });
  await assert.rejects(() => fx.send({ expectedTargetDigest: '0'.repeat(64) }), { code: 'target-changed' });
  await assert.rejects(() => fx.send({ expectedFingerprint: '0'.repeat(64) }), { code: 'account-changed' });
  assert.equal(tokenRequests, 0);
});

test('public QQ proactive post uses the actual SDK HTTP carrier without a passive reply token', async t => {
  const fx = await proactiveFixture(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(String(url)).pathname;
    const value = path.endsWith('/getAppAccessToken') ? { access_token: 'sdk-test-token', expires_in: 7200 }
      : path === '/users/@me' ? { id: 'native-bot-id', bot: true }
        : { id: 'sdk-native-post' };
    if (path.includes('/messages')) requests.push({ path, body: JSON.parse(options.body) });
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  });
  const sdk = new QQBot({ appId: '12345678', appSecret: 'fake-secret' });
  fx.bot().api = sdk.api;
  fx.bot().apiClient = sdk.apiClient;
  assert.deepEqual(await fx.send(), { sent: true,
    receipt: { version: 1, messageId: 'sdk-native-post', conversationId: 'app-scoped-group' } });
  assert.deepEqual(requests, [{ path: '/v2/groups/app-scoped-group/messages',
    body: { msg_type: 0, content: 'Delayed result' } }]);
});

test('runtime observes native reply candidates independently without enabling Echo or ordinary-message admission', async t => {
  const bot = new PlatformBot();
  const admitted = [];
  const observations = [];
  const runtime = new QqRuntime({
    config: { botId: 'qq_test', appId: '12345678', consumerMode: 'external-consumer' },
    appSecret: 'test-secret', state: {}, harness: {}, connectTimeoutMs: 100,
    createBot: () => bot, externalConsumer: async event => {
      admitted.push(event); return { accepted: true };
    },
    logger: { info: (_label, record) => observations.push(record) },
  });
  t.after(() => runtime.stop());
  await runtime.start();
  await bot.deliver(mention());
  await runtime.replyChecked(admitted[0].reply, 'answer', { receipt: true });
  assert.deepEqual(observations, []);
  const native = mention({ rawEventType: 'GROUP_MESSAGE_CREATE', messageId: 'native-reply-id',
    senderIsBot: true, senderId: 'native-bot-id' });
  await bot.deliver(native);
  await bot.deliver(native);
  await bot.deliver(mention({ rawEventType: 'GROUP_MESSAGE_CREATE', messageId: 'ordinary' }));
  assert.equal(admitted.length, 1);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].receiptMatched, true);
  observations.length = 0;
  bot.apiClient.request = async () => ({ id: 'native-post-id' });
  await runtime.sendProactiveText({ kind: 'group', route: { groupOpenId: 'app-scoped-group' } }, 'post', {
    expectedFingerprint: (await runtime.describeDeliveryAccount()).fingerprint,
    beforeSend: () => true, verifyAccount: async () => {},
  });
  assert.equal(observations.filter(record => record?.event === 'qq.native-reply.observation').length, 0);
  await bot.deliver(mention({ ...native, messageId: 'native-post-id' }));
  const postObservations = observations.filter(record => record?.event === 'qq.native-reply.observation');
  assert.equal(postObservations.length, 1);
  assert.equal(postObservations[0].receiptMatched, true);
  observations.length = 0;
  await runtime.stop();
  await bot.deliver(mention({ ...native, messageId: 'after-stop' }));
  assert.equal(observations.length, 0);
});

test('public QQ reply cancellation at the qualified-runtime handoff refuses before native dispatch', async () => {
  const bot = new PlatformBot();
  const abort = new AbortController();
  const account = verifiedQqAccount('12345678', { id: 'native-bot-id', bot: true });
  let route;
  const consumer = new QqExternalConsumer({ bot, account, botId: 'qq_test',
    accept: async event => { route = event.reply; return { accepted: true }; },
  });
  await consumer.accept(mention(), abort.signal);
  const service = createDeliveryService();
  service.registerAdapter(createDeliveryAdapter({ channel: 'qq',
    workspaces: { has: id => id === 'qq_test' }, stateFor: async () => ({}),
    coreController: { replyChecked: async (_id, received, text, options) => {
      await Promise.resolve();
      abort.abort();
      return consumer.reply(received, text, options);
    } },
  }));
  await assert.rejects(() => service.replyChecked('qq_test', route, 'reply', {
    expectedFingerprint: account.fingerprint, signal: abort.signal,
  }), { code: 'cancelled' });
  assert.deepEqual(bot.sent, []);
});

test('public QQ reply cancellation during account verification refuses before native dispatch', async t => {
  const fx = await fixture(t);
  const account = await fx.controller.describeDeliveryAccount(fx.botId);
  const admitted = [];
  await fx.controller.consumeInbound(fx.botId, {
    expectedFingerprint: account.account.fingerprint,
    onEvent: async event => { admitted.push(event); return { accepted: true }; },
  });
  await fx.bot().deliver(mention());
  const service = createDeliveryService();
  service.registerAdapter(createDeliveryAdapter({ channel: 'qq',
    workspaces: { has: id => id === fx.botId },
    coreController: fx.controller, stateFor: async () => ({}),
  }));
  let started;
  let complete;
  const ready = new Promise(resolve => { started = resolve; });
  fx.bot().api.get = async () => {
    started();
    await new Promise(resolve => { complete = resolve; });
    return { id: 'native-bot-id', bot: true };
  };
  const abort = new AbortController();
  const pending = service.replyChecked(fx.botId, admitted[0].reply, 'reply', {
    expectedFingerprint: account.account.fingerprint, signal: abort.signal,
  });
  const rejected = assert.rejects(pending, { code: 'cancelled' });
  await ready;
  abort.abort();
  complete();
  await rejected;
  assert.deepEqual(fx.bot().sent, []);
});

test('a qualified QQ app takes over group mentions and replies with a native receipt in the original group', async t => {
  const fx = await fixture(t);
  const account = await fx.controller.describeDeliveryAccount(fx.botId);
  assert.equal(account.channel, 'qq');
  assert.match(account.account.fingerprint, /^[a-f0-9]{64}$/);
  const admitted = [];
  await fx.controller.consumeInbound(fx.botId, {
    expectedFingerprint: account.account.fingerprint,
    onEvent: async event => { admitted.push(event); return { accepted: true }; },
  });
  assert.equal(fx.store.get(fx.botId).consumerMode, 'external-consumer');
  const standaloneRuns = fx.standaloneRuns();
  await fx.bot().deliver(mention());
  assert.equal(admitted.length, 1);
  assert.deepEqual(admitted[0].reply, {
    messageId: 'native-source-id', conversationId: 'app-scoped-group', actorId: 'app-scoped-member',
  });
  const sent = await fx.controller.replyChecked(fx.botId, admitted[0].reply, 'reply', {
    expectedFingerprint: account.account.fingerprint, receipt: true, beforeSend: () => true,
  });
  assert.deepEqual(sent, { sent: true, receipt: {
    version: 1, messageId: 'native-reply-id', conversationId: 'app-scoped-group',
  } });
  assert.deepEqual(fx.bot().sent, [{ target: mention().replyTarget, text: 'reply' }]);
  assert.equal(fx.standaloneRuns(), standaloneRuns);
});

test('public QQ retains explicit self mentions in full reception without admitting ordinary or Bot messages', async t => {
  const fx = await fixture(t);
  const fingerprint = (await fx.controller.describeDeliveryAccount(fx.botId)).account.fingerprint;
  const admitted = [];
  await fx.controller.consumeInbound(fx.botId, { expectedFingerprint: fingerprint,
    onEvent: async event => { admitted.push(event); return { accepted: true }; },
  });
  for (const fields of [
    {}, { mentions: [{ is_you: false }] }, { mentions: [{ is_you: 'true' }] },
    { raw: { mentions: [{ is_you: true }] } },
    { senderIsBot: true, mentions: [{ is_you: true }] },
  ]) await fx.bot().deliver(mention({ rawEventType: 'GROUP_MESSAGE_CREATE', ...fields }));
  assert.equal(admitted.length, 0);
  await fx.bot().deliver(mention({ rawEventType: 'GROUP_MESSAGE_CREATE',
    mentions: [{ is_you: true, member_openid: 'app-qualified-bot' }],
  }));
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].mentionedAccount, true);
  assert.equal(admitted[0].text, mention().content);
  assert.equal(fx.controller.status().bots[0].health.lastInbound.explicitSelfMention, true);
  const result = await fx.controller.replyChecked(fx.botId, admitted[0].reply, 'reply', {
    expectedFingerprint: fingerprint, receipt: true, beforeSend: () => true,
  });
  assert.equal(result.receipt.messageId, 'native-reply-id');
  assert.equal(fx.bot().sent.length, 1);
});

test('QQ fences source routes, pending canonical admission, native send uncertainty, and revoked leases', async t => {
  const fx = await fixture(t);
  const fingerprint = (await fx.controller.describeDeliveryAccount(fx.botId)).account.fingerprint;
  const admitted = [];
  let commit;
  const committed = new Promise(resolve => { commit = resolve; });
  const dispose = await fx.controller.consumeInbound(fx.botId, { expectedFingerprint: fingerprint,
    onEvent: async event => { admitted.push(event); await committed; return { accepted: true }; },
  });
  await assert.rejects(() => fx.controller.consumeInbound(fx.botId, {
    expectedFingerprint: fingerprint, onEvent: async () => ({ accepted: true }),
  }), { code: 'consumer-conflict' });
  await fx.bot().deliver(mention({ kind: 'c2c', rawEventType: 'C2C_MESSAGE_CREATE' }));
  await fx.bot().deliver(mention({ rawEventType: 'GROUP_MESSAGE_CREATE' }));
  await fx.bot().deliver(mention({ attachments: [{ url: 'https://example.test/private' }] }));
  assert.equal(admitted.length, 0);
  let acknowledged = false;
  const delivery = fx.bot().deliver(mention()).then(() => { acknowledged = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(admitted.length, 1);
  assert.equal(acknowledged, false);
  commit(); await delivery;
  const route = admitted[0].reply;
  const options = { expectedFingerprint: fingerprint, receipt: true, beforeSend: () => true };
  await fx.bot().deliver(mention({ msgType: 103, msgElements: [{ content: 'quoted' }] }));
  assert.equal(admitted.length, 1);
  await assert.rejects(() => fx.controller.replyChecked(fx.botId, { ...route, conversationId: 'different-group' }, 'reply', options), { code: 'stale-route' });
  await assert.rejects(() => fx.controller.replyChecked(fx.botId, route, 'reply', { ...options, beforeSend: () => false }), { code: 'stale-route' });
  assert.equal(fx.bot().sent.length, 0);
  fx.bot().sendText = async (target, text) => { fx.bot().sent.push({ target, text }); throw new Error('lost response'); };
  await assert.rejects(() => fx.controller.replyChecked(fx.botId, route, 'reply', options), { code: 'reply-result-unknown' });
  assert.equal(fx.bot().sent.length, 1);
  dispose();
  await assert.rejects(() => fx.controller.replyChecked(fx.botId, route, 'again', options), { code: 'consumer-unavailable' });
  await fx.controller.reconnectBot(fx.botId);
  await fx.bot().deliver(mention());
  assert.equal(admitted.length, 1);
  assert.equal(fx.standaloneRuns(), 1);
  // Rebinding credentials must not restore the standalone conversation path.
  await fx.controller.bindCredentials({ appId: '12345678', appSecret: 'new-test-secret' });
  assert.equal(fx.store.get(fx.botId).consumerMode, 'external-consumer');
  assert.equal(fx.standaloneRuns(), 1);
});

test('QQ preserves definite native refusals, expiry and the five-reply budget without fallback sends', async t => {
  const fx = await fixture(t);
  const fingerprint = (await fx.controller.describeDeliveryAccount(fx.botId)).account.fingerprint;
  const admitted = [];
  await fx.controller.consumeInbound(fx.botId, { expectedFingerprint: fingerprint,
    onEvent: async event => { admitted.push(event); return { accepted: true }; },
  });
  const options = { expectedFingerprint: fingerprint, receipt: true, beforeSend: () => true };
  for (const [bizCode, httpStatus, code] of [
    [304103, 400, 'reply-window-expired'], [40034005, 400, 'reply-window-expired'],
    [40034128, 400, 'reply-limit-exceeded'], [40034100, 400, 'reply-rate-limited'],
    [undefined, 429, 'reply-rate-limited'], [40054002, 403, 'reply-permission-denied'],
    [40054003, 403, 'reply-permission-denied'], [40054007, 400, 'bad-request'],
    [50055001, 500, 'reply-result-unknown'],
  ]) {
    const messageId = `source-${bizCode ?? httpStatus}`;
    await fx.bot().deliver(mention({ messageId, replyTarget: { ...mention().replyTarget, msgId: messageId } }));
    const before = fx.bot().sent.length;
    fx.bot().sendText = async (target, text) => {
      fx.bot().sent.push({ target, text });
      throw new ApiError('native rejection', httpStatus, '/v2/groups/test/messages', bizCode);
    };
    await assert.rejects(() => fx.controller.replyChecked(fx.botId, admitted.at(-1).reply, 'reply', options), { code });
    assert.equal(fx.bot().sent.length, before + 1);
  }
  const messageId = 'expired';
  await fx.bot().deliver(mention({ messageId, timestamp: new Date(Date.now() - 300_001).toISOString(),
    replyTarget: { ...mention().replyTarget, msgId: messageId } }));
  await assert.rejects(() => fx.controller.qualifyReplyChecked(fx.botId, admitted.at(-1).reply, options), { code: 'reply-window-expired' });
  const fresh = 'five-replies';
  await fx.bot().deliver(mention({ messageId: fresh, replyTarget: { ...mention().replyTarget, msgId: fresh } }));
  fx.bot().sendText = PlatformBot.prototype.sendText;
  for (let index = 0; index < 5; index++) await fx.controller.replyChecked(fx.botId, admitted.at(-1).reply, 'reply', options);
  const before = fx.bot().sent.length;
  await assert.rejects(() => fx.controller.replyChecked(fx.botId, admitted.at(-1).reply, 'sixth', options), { code: 'reply-limit-exceeded' });
  assert.equal(fx.bot().sent.length, before);
});

test('consumer mutation cannot redirect QQ source proof and legacy replies retain the native message id', async t => {
  const fx = await fixture(t);
  const fingerprint = (await fx.controller.describeDeliveryAccount(fx.botId)).account.fingerprint;
  let route;
  await fx.controller.consumeInbound(fx.botId, { expectedFingerprint: fingerprint,
    onEvent: async event => {
      route = structuredClone(event.reply);
      event.reply.conversationId = 'forged-group';
      return { accepted: true };
    },
  });
  await fx.bot().deliver(mention());
  const options = { expectedFingerprint: fingerprint, beforeSend: () => true };
  await assert.rejects(() => fx.controller.replyChecked(fx.botId, { ...route, conversationId: 'forged-group' }, 'reply', options), { code: 'stale-route' });
  assert.equal(fx.bot().sent.length, 0);
  const result = await fx.controller.replyChecked(fx.botId, route, 'reply', options);
  assert.deepEqual(result, { sent: true, messageId: 'native-reply-id' });
  assert.equal(fx.bot().sent[0].target.targetId, 'app-scoped-group');
});
