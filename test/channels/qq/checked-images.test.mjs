import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { QqConfigStore, deriveQqBotIdentity } from '../../../src/channels/qq/config-store.mjs';
import { QqController } from '../../../src/channels/qq/qq-controller.mjs';
import { QqRuntime } from '../../../src/channels/qq/qq-runtime.mjs';
import { createDeliveryService } from '../../../plugin-src/host/delivery-service.mjs';
import { createDeliveryAdapter } from '../../../plugin-src/host/delivery-adapter.mjs';
import { createProductionController } from '../../../plugin-src/host/channels/qq/production.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const privateUrl = 'https://multimedia.nt.qq.com.cn/download?private-ticket=secret';
function mention(overrides = {}) {
  return { kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', messageId: 'image-source',
    senderId: 'app-member', groupOpenid: 'app-group', content: 'Inspect the shapes',
    timestamp: new Date().toISOString(),
    replyTarget: { scope: 'group', targetId: 'app-group', msgId: 'image-source' },
    attachments: [{ url: privateUrl, content_type: 'image/png', filename: 'source.png', size: png.length }],
    ...overrides };
}
class PlatformBot extends EventEmitter {
  sent = [];
  uploads = [];
  api = { get: async () => ({ id: 'native-bot', bot: true }), getToken: async () => 'test-token' };
  apiClient = { request: async (_token, method, path, body) => {
    this.sent.push({ method, path, body }); return { id: 'native-image-reply' };
  } };
  use() {}
  async start(signal) {
    queueMicrotask(() => this.emit('ready', {}));
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  }
  stop() {}
  async sendText() { throw new Error('Standalone text output must remain unused'); }
  async uploadMedia(request) { this.uploads.push(request); return { file_info: 'private-upload-ticket' }; }
  async deliver(message) { await Promise.all(this.listeners('message').map(listener => listener({}, message))); }
}
async function fixture(t, { sourceImages = true, production = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-qq-images-'));
  const store = await new QqConfigStore(join(directory, 'config.json')).load();
  const identity = deriveQqBotIdentity('12345678');
  await store.save({ ...identity, appId: '12345678', ownerUserOpenid: 'owner' });
  let bot;
  const observations = [];
  const credentials = { resolve: async () => ({ value: 'test-secret' }), set: async () => {}, unset: async () => {} };
  let controller = new QqController({ configStore: store, credentials,
    qrAuth: { start() {} },
    createRuntime: async args => new QqRuntime({ ...args, state: {}, harness: { ensureRunning: async () => {} }, connectTimeoutMs: 100,
      typingMiddleware: () => () => {},
      logger: { info: (_label, record) => observations.push(record), error() {}, warn() {} },
      createBot: () => { bot = new PlatformBot(); return bot; } }),
  });
  let productionAdapter;
  if (production) {
    const created = await createProductionController({ credentials, typertGateway: { invoke() {}, stream() {} },
      logger: () => ({ error() {}, warn() {}, info() {}, debug() {} }) },
    { dataDir: directory, dshHome: directory, configPath: join(directory, 'config.json') }, {
      HarnessClient: class { async ensureRunning() {} stopManagedProcess() {} },
      Runtime: class extends QqRuntime {
        constructor(args) { super({ ...args, connectTimeoutMs: 100, typingMiddleware: () => () => {},
          createBot: () => { bot = new PlatformBot(); return bot; } }); }
      },
      createConnectionSupervisor: () => ({ ready: Promise.resolve(), start() { return this; }, async close() {} }),
    });
    controller = created.controller;
    productionAdapter = created.deliveryAdapter;
    t.after(() => created.close());
  }
  t.after(() => controller.close());
  await controller.initialize();
  const service = createDeliveryService();
  const unregister = service.registerAdapter(productionAdapter ?? createDeliveryAdapter({ channel: 'qq',
    workspaces: { has: id => id === identity.botId }, coreController: controller, stateFor: async () => ({}) }));
  t.after(unregister);
  const fingerprint = (await service.describeBot(identity.botId)).account.fingerprint;
  const admitted = [];
  const dispose = await service.consumeInbound(identity.botId, { expectedFingerprint: fingerprint, sourceImages,
    onEvent: async event => { admitted.push(event); return { accepted: true }; } });
  return { service, controller, bot: () => bot, botId: identity.botId, fingerprint, admitted, dispose, unregister, observations,
    options: { expectedFingerprint: fingerprint, beforeSend: () => true } };
}

test('public checked QQ image intake retains source association while URL acquisition stays private and lazy', async t => {
  const downloads = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    downloads.push({ url: String(url), options }); return new Response(png);
  });
  const fx = await fixture(t);
  await fx.bot().deliver(mention());
  assert.equal(fx.admitted.length, 1);
  assert.equal(downloads.length, 0);
  const event = fx.admitted[0];
  assert.equal(event.channel, 'qq');
  assert.equal(event.botId, fx.botId);
  assert.equal(event.fingerprint, fx.fingerprint);
  assert.deepEqual(event.reply, { messageId: 'image-source', conversationId: 'app-group', actorId: 'app-member' });
  assert.equal(event.text, 'Inspect the shapes');
  assert.equal(event.mentionedAccount, true);
  assert.equal(event.attachments.length, 1);
  assert.equal(event.attachments[0].messageId, 'image-source');
  assert.equal(event.attachments[0].mediaType, 'image/png');
  assert.deepEqual(event.contentParts, [{ kind: 'text', text: 'Inspect the shapes' },
    { kind: 'attachment', id: event.attachments[0].id }]);
  assert.equal(JSON.stringify(event).includes(privateUrl), false);
  assert.equal(JSON.stringify(event).includes('private-ticket'), false);
  const stream = await fx.service.externalFileChecked(fx.botId, event.reply, event.attachments[0], fx.options);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), png);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].url, privateUrl);
  assert.equal(downloads[0].options.redirect, 'manual');
});

test('installed production QQ factory carries image opt-in into real runtime and checked native output', async t => {
  const fx = await fixture(t, { production: true });
  await fx.bot().deliver(mention());
  assert.equal(fx.admitted.length, 1);
  assert.equal(fx.admitted[0].attachments[0].messageId, 'image-source');
  const result = await fx.service.externalFileChecked(fx.botId, fx.admitted[0].reply,
    { id: 'result', name: 'result.png', bytes: png, mediaType: 'image/png' }, { ...fx.options, reply: true });
  assert.equal(result.receipt.messageId, 'native-image-reply');
  assert.equal(fx.bot().sent.length, 1);
});

test('public checked QQ image output uploads without sending then returns one original-group native receipt', async t => {
  const fx = await fixture(t);
  await fx.bot().deliver(mention());
  const file = { id: 'canonical-result', name: 'result.png', mediaType: 'image/png', bytes: png };
  const result = await fx.service.externalFileChecked(fx.botId, fx.admitted[0].reply, file,
    { ...fx.options, reply: true });
  assert.deepEqual(result, { sent: true, receipt: {
    version: 1, messageId: 'native-image-reply', conversationId: 'app-group',
  } });
  assert.equal(fx.bot().uploads.length, 1);
  assert.equal(fx.bot().uploads[0].srvSendMsg, false);
  assert.equal(fx.bot().uploads[0].fileType, 1);
  assert.deepEqual(fx.bot().uploads[0].target, { scope: 'group', targetId: 'app-group', msgId: 'image-source' });
  assert.deepEqual(fx.bot().uploads[0].buffer, png);
  assert.equal(fx.bot().sent.length, 1);
  assert.equal(fx.bot().sent[0].method, 'POST');
  assert.equal(fx.bot().sent[0].path, '/v2/groups/app-group/messages');
  assert.equal(fx.bot().sent[0].body.msg_type, 7);
  assert.equal(fx.bot().sent[0].body.msg_id, 'image-source');
  assert.deepEqual(fx.bot().sent[0].body.media, { file_info: 'private-upload-ticket' });
});

test('account changes during private image acquisition prevent bytes from reaching the external consumer', async t => {
  const fx = await fixture(t);
  await fx.bot().deliver(mention());
  t.mock.method(globalThis, 'fetch', async () => {
    fx.bot().api.get = async () => ({ id: 'different-native-bot', bot: true });
    return new Response(png);
  });
  await assert.rejects(async () => {
    const stream = await fx.service.externalFileChecked(fx.botId, fx.admitted[0].reply,
      fx.admitted[0].attachments[0], fx.options);
    for await (const chunk of stream) assert.fail('Unqualified image bytes escaped');
  }, { code: 'account-changed' });
});

test('QQ images require opt-in and reject quoted, ordinary and unsupported native media', async t => {
  const disabled = await fixture(t, { sourceImages: false });
  await disabled.bot().deliver(mention());
  assert.deepEqual(disabled.admitted, []);
  const fx = await fixture(t);
  await fx.bot().deliver(mention({ rawEventType: 'GROUP_MESSAGE_CREATE' }));
  await fx.bot().deliver(mention({ senderIsBot: true }));
  await fx.bot().deliver(mention({ msgElements: [{ content: 'quoted image' }] }));
  await fx.bot().deliver(mention({ attachments: [{ url: privateUrl, content_type: 'application/pdf' }] }));
  await fx.bot().deliver(mention({ attachments: [{ url: 'https://example.test/private', content_type: 'image/png' }] }));
  assert.deepEqual(fx.admitted, []);
  await fx.bot().deliver(mention({ content: '' }));
  assert.equal(fx.admitted.length, 1);
  assert.equal(fx.admitted[0].text, '[Image]');
  assert.deepEqual(fx.admitted[0].contentParts, [{ kind: 'attachment', id: fx.admitted[0].attachments[0].id }]);
});

test('private QQ acquisition refuses descriptor substitution, redirects, oversize, invalid bytes and revoked leases', async t => {
  const fx = await fixture(t);
  await fx.bot().deliver(mention());
  const event = fx.admitted[0];
  let downloads = 0;
  let response = () => new Response(png);
  t.mock.method(globalThis, 'fetch', async () => { downloads++; return response(); });
  await assert.rejects(() => fx.service.externalFileChecked(fx.botId, event.reply,
    { ...event.attachments[0], resourceKey: 'different' }, fx.options), { code: 'stale-route' });
  assert.equal(downloads, 0);
  for (const [make, code] of [
    [() => new Response(null, { status: 302, headers: { location: 'https://example.test' } }), 'resource-unavailable'],
    [() => new Response(png, { headers: { 'content-length': String(25 * 1024 * 1024 + 1) } }), 'artifact-too-large'],
    [() => new Response(Buffer.from('not an image')), 'resource-unavailable'],
  ]) {
    response = make;
    await assert.rejects(() => fx.service.externalFileChecked(fx.botId, event.reply, event.attachments[0], fx.options), { code });
  }
  const prior = downloads;
  fx.dispose();
  await assert.rejects(() => fx.service.externalFileChecked(fx.botId, event.reply, event.attachments[0], fx.options),
    { code: 'consumer-unavailable' });
  assert.equal(downloads, prior);
});

test('revocation during QQ upload and after token acquisition prevents the final native image POST', async t => {
  for (const revoke of ['lease', 'registration', 'account', 'core-fence', 'token']) {
    const fx = await fixture(t);
    await fx.bot().deliver(mention());
    let authorized = true;
    const options = { ...fx.options, reply: true, beforeSend: () => authorized };
    fx.bot().uploadMedia = async () => {
      if (revoke === 'lease') fx.dispose();
      if (revoke === 'account') fx.bot().api.get = async () => ({ id: 'different-bot', bot: true });
      if (revoke === 'core-fence') authorized = false;
      if (revoke === 'registration') fx.unregister();
      return { file_info: 'private-upload-ticket' };
    };
    if (revoke === 'token') fx.bot().api.getToken = async () => { authorized = false; return 'test-token'; };
    await assert.rejects(() => fx.service.externalFileChecked(fx.botId, fx.admitted[0].reply,
      { id: 'result', name: 'result.png', bytes: png, mediaType: 'image/png' }, options));
    assert.deepEqual(fx.bot().sent, []);
  }
});

test('a lost QQ image response remains unknown after exactly one native POST', async t => {
  const fx = await fixture(t);
  await fx.bot().deliver(mention());
  fx.bot().apiClient.request = async (...request) => { fx.bot().sent.push(request); throw new Error('lost response'); };
  await assert.rejects(() => fx.service.externalFileChecked(fx.botId, fx.admitted[0].reply,
    { id: 'result', name: 'result.png', bytes: png, mediaType: 'image/png' }, { ...fx.options, reply: true }),
  { code: 'reply-result-unknown' });
  assert.equal(fx.bot().sent.length, 1);
  assert.equal(fx.bot().uploads.length, 1);
});

test('an actual native image reply callback correlates its checked receipt without creating another admission', async t => {
  const fx = await fixture(t);
  await fx.bot().deliver(mention());
  await fx.service.externalFileChecked(fx.botId, fx.admitted[0].reply,
    { id: 'result', name: 'result.png', bytes: png, mediaType: 'image/png' }, { ...fx.options, reply: true });
  assert.deepEqual(fx.observations, []);
  await fx.bot().deliver(mention({ rawEventType: 'GROUP_MESSAGE_CREATE', messageId: 'native-image-reply',
    senderIsBot: true, senderId: 'native-bot' }));
  assert.equal(fx.observations.length, 1);
  assert.equal(fx.observations[0].receiptMatched, true);
  assert.equal(fx.admitted.length, 1);
});
