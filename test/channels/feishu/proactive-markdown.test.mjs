import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeliveryAdapter } from '../../../plugin-src/host/delivery-adapter.mjs';
import { createDeliveryService } from '../../../plugin-src/host/delivery-service.mjs';
import { createDeliveryRpcHandler } from '../../../plugin-src/host/delivery-rpc.mjs';
import { FeishuRuntime } from '../../../src/channels/feishu/feishu-runtime.mjs';

const text = '# GitHub 巡检\n\n**没有变化**\n\n- [仓库](https://github.com/example/repo)\n\n```js\nconst value = "中文 😀";\n```\n';
const targets = [
  { targetId: 'dm', kind: 'user', route: { openId: 'ou_fixture_user' } },
  { targetId: 'group', kind: 'group', route: { chatId: 'oc_fixture_group' } },
];

async function fixture(t, domain = 'feishu') {
  const sends = [];
  const clientOptions = [];
  let respond = () => ({ code: 0, data: { message_id: 'fixture-message' } });
  class Client {
    constructor(options) {
      clientOptions.push(options);
      this.im = { v1: { message: { create: async (payload) => {
        sends.push(payload);
        return respond();
      } } } };
    }
  }
  class EventDispatcher { register() { return this; } }
  class WSClient {
    constructor(options) { this.options = options; this.state = 'idle'; }
    async start() { this.state = 'connected'; queueMicrotask(() => this.options.onReady()); }
    getConnectionStatus() { return { state: this.state }; }
    close() { this.state = 'closed'; }
  }
  const runtime = new FeishuRuntime({
    lark: { Client, EventDispatcher, WSClient,
      Domain: { Feishu: 'fixture-feishu', Lark: 'fixture-lark' }, LoggerLevel: { info: 'info' } },
    appId: 'fixture-app', appSecret: 'fixture-secret', ownerOpenIds: ['ou_fixture_owner'],
    domain, slashCommands: false,
    harness: { async ensureRunning() {} }, state: { hasSeen: () => false },
  });
  t.after(() => runtime.stop());
  await runtime.start();
  const service = createDeliveryService();
  service.registerAdapter(createDeliveryAdapter({
    channel: 'feishu',
    workspaces: {
      has: (id) => id === 'fixture-bot', listBotIds: () => ['fixture-bot'],
      listDeliveryTargets: () => targets,
    },
    stateFor: async () => ({ snapshot: () => ({ sessions: {} }) }),
    coreController: { sendProactiveText: (_id, target, value, options) => (
      runtime.sendProactiveText(target, value, options)
    ) },
  }));
  return { service, runtime, sends, clientOptions, respondWith: (fn) => { respond = fn; } };
}

for (const domain of ['feishu', 'lark']) {
  test(`${domain}: Host/RPC Markdown crosses service and adapter into a native card`, async (t) => {
    const { service, sends, clientOptions } = await fixture(t, domain);
    assert.equal(clientOptions[0].domain, `fixture-${domain}`);
    const signal = new AbortController().signal;
    const rpc = createDeliveryRpcHandler(service);
    for (const target of targets) {
      for (const format of [undefined, 'plain', 'markdown']) {
        assert.deepEqual(await service.send('fixture-bot', target.targetId, text, { signal, format }), { sent: true });
        assert.deepEqual(await rpc('message.send', {
          botId: 'fixture-bot', targetId: target.targetId, text,
          ...(format === undefined ? {} : { format }),
        }, signal), { ok: true, value: { sent: true } });
        for (const sent of sends.slice(-2)) {
          assert.equal(sent.params.receive_id_type, target.kind === 'user' ? 'open_id' : 'chat_id');
          assert.equal(sent.data.receive_id, target.route.openId ?? target.route.chatId);
          assert.equal(sent.data.msg_type, format === 'markdown' ? 'interactive' : 'text');
          assert.deepEqual(JSON.parse(sent.data.content), format === 'markdown'
            ? { schema: '2.0', body: { elements: [{ tag: 'markdown', content: text }] } }
            : { text });
        }
      }
    }
    assert.equal(sends.length, 12, 'Exactly one platform call per request, no stream or retry');
  });
}

test('proactive format validation and cancellation never send a message', async (t) => {
  const { service, runtime, sends } = await fixture(t);
  const rpc = createDeliveryRpcHandler(service);
  for (const format of ['html', '', null, true, {}, ['markdown']]) {
    await assert.rejects(service.send('fixture-bot', 'dm', text, { format }), { code: 'bad-request' });
    await assert.rejects(runtime.sendProactiveText(targets[0], text, { format }), { code: 'bad-request' });
    assert.equal((await rpc('message.send', {
      botId: 'fixture-bot', targetId: 'dm', text, format,
    })).error.code, 'bad-request');
  }
  assert.equal((await rpc('message.send', {
    botId: 'fixture-bot', targetId: 'dm', text, format: 'markdown', sessionId: 'forbidden',
  })).error.code, 'bad-request');
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(service.send('fixture-bot', 'dm', text, {
    format: 'markdown', signal: abort.signal,
  }), { code: 'cancelled' });
  await assert.rejects(runtime.sendProactiveText(targets[0], text, {
    format: 'markdown', signal: abort.signal,
  }), { name: 'AbortError' });
  assert.equal(sends.length, 0);
});

test('Markdown rejection and uncertain network failure do not retry as plain text', async (t) => {
  const { service, sends, respondWith } = await fixture(t);
  respondWith(() => ({ code: 230001, msg: 'Fixture card rejected' }));
  await assert.rejects(service.send('fixture-bot', 'dm', text, { format: 'markdown' }), {
    code: 'target-rejected',
  });
  assert.equal(sends.length, 1);
  respondWith(() => { throw new Error('Fixture network timeout after possible acceptance'); });
  await assert.rejects(service.send('fixture-bot', 'group', text, { format: 'markdown' }), {
    code: 'delivery-failed',
  });
  assert.equal(sends.length, 2);
  assert.ok(sends.every((payload) => payload.data.msg_type === 'interactive'));
});
