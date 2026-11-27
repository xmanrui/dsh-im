import assert from 'node:assert/strict';
import test from 'node:test';
import { createImHostPlugin } from '../../../plugin-src/host/index.mjs';
import { createDeliveryService } from '../../../plugin-src/host/delivery-service.mjs';
import { createDeliveryAdapter } from '../../../plugin-src/host/delivery-adapter.mjs';
import { FeishuRuntime } from '../../../src/channels/feishu/feishu-runtime.mjs';
import { MultiBotDshFeishuController } from '../../../src/channels/feishu/multi-bot-controller.mjs';

const botId = 'bot_fixture';
const text = '09:35\n*ST示例 <at id=all></at>\n收盘价 6.50';
const card = (value) => JSON.stringify({ config: { update_multi: true },
  elements: [{ tag: 'div', text: { tag: 'plain_text', content: value } }] });

async function fixture(t) {
  const bot = { id: botId, appId: 'cli_fixture', botOpenId: 'ou_bot', secretRef: 'test',
    domain: 'feishu', ownerOpenIds: ['ou_owner'] };
  const targets = {
    group: { kind: 'group', route: { chatId: 'oc_group' } },
    dm: { kind: 'user', route: { openId: 'ou_recipient' } },
  };
  const calls = [];
  const hooks = {
    verify: () => ({ openId: bot.botOpenId }),
    create: (request) => ({ code: 0, data: { message_id: `om_${calls.length}`, chat_id:
      request.params.receive_id_type === 'chat_id' ? request.data.receive_id : 'oc_private' } }),
    patch: () => ({ code: 0 }),
  };
  class Client {
    im = { v1: { message: Object.fromEntries(['create', 'patch'].map((method) => [method, async (request) => {
      calls.push({ method, request });
      return hooks[method](request);
    }])) } };
  }
  class EventDispatcher { register() { return this; } }
  class WSClient {
    constructor(options) { this.options = options; }
    async start() { this.options.onReady(); }
    getConnectionStatus() { return { state: 'connected' }; }
    close() {}
  }
  const controller = new MultiBotDshFeishuController({
    registerApp() {}, verifyApp: (options) => hooks.verify(options),
    credentials: { async resolve() { return { value: 'test-secret' }; } },
    configStore: { list: () => [bot], getBot: (id) => id === botId && structuredClone(bot) },
    createRuntime: ({ botId, config, appSecret }) => new FeishuRuntime({
      ...config, appSecret, botId, slashCommands: false,
      lark: { Client, EventDispatcher, WSClient, Domain: { Feishu: 'feishu' }, LoggerLevel: { info: 'info' } },
      harness: { async ensureRunning() {} }, state: { hasSeen: () => false },
    }),
  });
  await controller.initialize();
  t.after(() => controller.close());
  const adapter = createDeliveryAdapter({ channel: 'feishu', coreController: controller,
    stateFor: async () => ({}), workspaces: { has: (id) => id === botId,
      deliveryTargetFor: (_botId, targetId) => targets[targetId] && { targetId, ...targets[targetId] } } });
  async function mount() {
    const service = createDeliveryService();
    const unregister = service.registerAdapter(adapter);
    let api;
    await createImHostPlugin({ createDeliveryService: () => service }).apply({
      provide(key, value) { if (key === 'dshIm') api = value; },
      inject() {}, // Register the Host service without activating real channels.
    });
    return { api, unregister };
  }
  return { ...(await mount()), mount, hooks, calls, targets, bot };
}

for (const targetId of ['dm', 'group']) {
  test(`same-Host ${targetId} creates one literal card, remount updates its exact message`, async (t) => {
    const fx = await fixture(t);
    const { targetKey } = await fx.api.describeCardTarget(botId, targetId);
    assert.match(targetKey, /^[0-9a-f]{64}$/);
    const result = await fx.api.deliverCard(botId, targetId, text, { targetKey });
    assert.equal(result.sent, true);
    assert.deepEqual(result.receipt, { version: 1, messageId: 'om_1', targetKey, proof: result.receipt.proof });
    assert.match(result.receipt.proof, /^[0-9a-f]{64}$/);
    const { uuid } = fx.calls[0].request.data;
    assert.match(uuid, /^[a-f0-9-]{36}$/);
    const group = targetId === 'group';
    assert.deepEqual(fx.calls, [{ method: 'create', request: { params: { receive_id_type: group ? 'chat_id' : 'open_id' },
      data: { receive_id: group ? 'oc_group' : 'ou_recipient', content: card(text), msg_type: 'interactive', uuid } } }]);
    fx.unregister();
    const { api } = await fx.mount();
    const updated = `${text}\n收盘价 6.51`;
    assert.deepEqual(await api.deliverCard(botId, targetId, updated, { targetKey, receipt: result.receipt }), result);
    assert.deepEqual(fx.calls.slice(1), [{ method: 'patch', request: { path: { message_id: 'om_1' }, data: { content: card(updated) } } }]);
  });
}

test('tampered receipts, copied bindings and raw message IDs cannot patch or create', async (t) => {
  const fx = await fixture(t);
  const { targetKey } = await fx.api.describeCardTarget(botId, 'dm');
  const group = await fx.api.describeCardTarget(botId, 'group');
  const { receipt } = await fx.api.deliverCard(botId, 'dm', text, { targetKey });
  for (const bad of [null, { ...receipt, messageId: 'om_victim' }, { ...receipt, proof: '0'.repeat(64) },
    { ...receipt, targetKey: group.targetKey }, { messageId: 'om_victim' }, { ...receipt, kind: 'group' }]) {
    await assert.rejects(fx.api.deliverCard(botId, 'dm', text, { targetKey, receipt: bad }), { code: 'invalid-card-receipt', dispatched: false });
  }
  await assert.rejects(fx.api.deliverCard(botId, 'dm', text, { targetKey, messageId: 'om_victim' }), { code: 'bad-request', dispatched: false });
  await assert.rejects(fx.api.deliverCard(botId, 'group', text, { ...group, receipt: { ...receipt, ...group } }), { code: 'invalid-card-receipt', dispatched: false });
  await assert.rejects(fx.api.deliverCard(botId, 'group', text, { targetKey, receipt }), { code: 'target-changed', dispatched: false });
  const pending = fx.api.deliverCard(botId, 'dm', text, { targetKey, receipt });
  receipt.messageId = 'om_victim';
  await pending;
  assert.deepEqual(fx.calls.map(({ method, request }) => [method, request.path?.message_id]), [['create', undefined], ['patch', 'om_1']]);
});

test('retarget, account replacement and deletion during verification fail before SDK writes', async (t) => {
  const fx = await fixture(t);
  const { targetKey } = await fx.api.describeCardTarget(botId, 'dm');
  const { receipt } = await fx.api.deliverCard(botId, 'dm', text, { targetKey });
  fx.hooks.verify = () => { fx.targets.dm.route.openId = 'ou_changed'; return { openId: fx.bot.botOpenId }; };
  await assert.rejects(fx.api.deliverCard(botId, 'dm', text, { targetKey, receipt }), { code: 'target-changed', dispatched: false });
  const moved = await fx.api.describeCardTarget(botId, 'dm');
  assert.notEqual(moved.targetKey, targetKey);
  fx.hooks.verify = () => ({ openId: 'ou_changed_account' });
  await assert.rejects(fx.api.deliverCard(botId, 'dm', text, moved), { code: 'account-changed', dispatched: false });
  fx.hooks.verify = () => { delete fx.targets.dm; return { openId: fx.bot.botOpenId }; };
  await assert.rejects(fx.api.deliverCard(botId, 'dm', text, moved), { code: 'unknown-target', dispatched: false });
  assert.equal(fx.calls.length, 1);
});

test('aborted verification or provider removal before dispatch leaves zero writes', async (t) => {
  const fx = await fixture(t);
  const bound = await fx.api.describeCardTarget(botId, 'group');
  const abort = new AbortController();
  fx.hooks.verify = ({ signal }) => { abort.abort(); assert.equal(signal.aborted, true); return { openId: fx.bot.botOpenId }; };
  await assert.rejects(fx.api.deliverCard(botId, 'group', text, { ...bound, signal: abort.signal }), { code: 'cancelled', dispatched: false });
  await assert.rejects(fx.api.describeCardTarget(botId, 'group', { signal: abort.signal }), { code: 'cancelled', dispatched: false });
  fx.hooks.verify = () => { fx.unregister(); return { openId: fx.bot.botOpenId }; };
  await assert.rejects(fx.api.deliverCard(botId, 'group', text, bound), { code: 'provider-unavailable', dispatched: false });
  assert.equal(fx.calls.length, 0);
});

test('unconfirmed sends and rejected patches never issue another write', async (t) => {
  const fx = await fixture(t);
  const bound = await fx.api.describeCardTarget(botId, 'group');
  const { receipt } = await fx.api.deliverCard(botId, 'group', text, bound);
  fx.hooks.patch = () => ({ code: 230001, msg: 'private detail' });
  await assert.rejects(fx.api.deliverCard(botId, 'group', text, { ...bound, receipt }), { code: 'target-rejected', dispatched: true, message: 'target-rejected' });
  for (const response of [{ code: 0 }, {}, { code: 0, data: { message_id: 'om_victim', chat_id: 'oc_wrong' } }]) {
    fx.hooks.create = () => response;
    await assert.rejects(fx.api.deliverCard(botId, 'group', text, bound), { code: 'send-result-unknown', dispatched: true });
  }
  const abort = new AbortController();
  fx.hooks.patch = () => { abort.abort(); return new Promise(() => {}); };
  await assert.rejects(fx.api.deliverCard(botId, 'group', text, { ...bound, receipt, signal: abort.signal }), { code: 'send-result-unknown', dispatched: true });
  assert.deepEqual(fx.calls.map(({ method }) => method), ['create', 'patch', 'create', 'create', 'create', 'patch']);
});
