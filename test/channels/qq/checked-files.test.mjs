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

const input = Buffer.from('name,quantity\napple,2\npear,3\n');
const privateUrl = 'https://multimedia.nt.qq.com.cn/download?private-ticket=secret';
function mention(overrides = {}) {
  return { kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', messageId: 'file-source',
    senderId: 'app-member', groupOpenid: 'app-group', content: 'Sum the quantities',
    timestamp: new Date().toISOString(),
    replyTarget: { scope: 'group', targetId: 'app-group', msgId: 'file-source' },
    attachments: [{ url: privateUrl, content_type: 'file', filename: 'input.csv', size: input.length }],
    ...overrides };
}
class PlatformBot extends EventEmitter {
  sent = [];
  uploads = [];
  api = { get: async () => ({ id: 'native-bot', bot: true }), getToken: async () => 'test-token' };
  apiClient = { request: async (_token, method, path, body) => {
    this.sent.push({ method, path, body }); return { id: 'native-file-reply' };
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
async function fixture(t, { sourceImages = false, sourceFiles = true, production = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-qq-files-'));
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
  const dispose = await service.consumeInbound(identity.botId, { expectedFingerprint: fingerprint, sourceImages, sourceFiles,
    onEvent: async event => { admitted.push(event); return { accepted: true }; } });
  return { service, controller, bot: () => bot, botId: identity.botId, fingerprint, admitted, dispose, unregister, observations,
    options: { expectedFingerprint: fingerprint, beforeSend: () => true } };
}

test('installed QQ file contract acquires a private source and sends a distinct result in the same group', async t => {
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    downloads++;
    assert.equal(options.redirect, 'manual');
    return new Response(input);
  });
  const fx = await fixture(t, { production: true });
  await fx.bot().deliver(mention());
  assert.equal(fx.admitted.length, 1);
  const event = fx.admitted[0];
  assert.equal(event.fingerprint, fx.fingerprint);
  assert.deepEqual(event.reply, { messageId: 'file-source', conversationId: 'app-group', actorId: 'app-member' });
  assert.equal(event.attachments[0].mediaType, 'application/octet-stream');
  assert.equal(event.attachments[0].name, 'input.csv');
  assert.equal(event.attachments[0].messageId, 'file-source');
  assert.equal(JSON.stringify(event).includes('private-ticket'), false);
  assert.equal(downloads, 0);
  const stream = await fx.service.externalFileChecked(fx.botId, event.reply, event.attachments[0], fx.options);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const workingCopy = Buffer.concat(chunks);
  assert.deepEqual(workingCopy, input);
  workingCopy.fill(0);
  assert.equal(input.toString(), 'name,quantity\napple,2\npear,3\n');
  const resultBytes = Buffer.from('total_quantity\n5\n');
  const result = await fx.service.externalFileChecked(fx.botId, event.reply,
    { id: 'result', name: 'total.csv', mediaType: 'text/csv', bytes: resultBytes }, { ...fx.options, reply: true });
  assert.deepEqual(result, { sent: true, receipt: {
    version: 1, messageId: 'native-file-reply', conversationId: 'app-group',
  } });
  assert.equal(fx.bot().uploads.length, 1);
  assert.equal(fx.bot().uploads[0].fileType, 4);
  assert.equal(fx.bot().uploads[0].srvSendMsg, false);
  assert.equal(fx.bot().uploads[0].fileName, 'total.csv');
  assert.deepEqual(fx.bot().uploads[0].buffer, resultBytes);
  assert.equal(fx.bot().sent.length, 1);
  assert.equal(fx.bot().sent[0].path, '/v2/groups/app-group/messages');
  assert.equal(fx.bot().sent[0].body.msg_id, 'file-source');
  assert.deepEqual(fx.bot().sent[0].body.media, { file_info: 'private-upload-ticket' });
});

test('QQ native files require explicit opt-in and never borrow a neighbouring message or an unproven quote', async t => {
  const disabled = await fixture(t, { sourceFiles: false });
  await disabled.bot().deliver(mention());
  assert.deepEqual(disabled.admitted, []);
  const fx = await fixture(t);
  for (const change of [
    { rawEventType: 'GROUP_MESSAGE_CREATE' }, { senderIsBot: true },
    { msgElements: [{ content: 'quoted file' }] },
    { attachments: [{ url: privateUrl, content_type: 'audio/silk' }] },
    { attachments: [{ url: privateUrl, content_type: 'video/mp4' }] },
    { attachments: [{ url: 'https://example.test/private', content_type: 'file' }] },
  ]) await fx.bot().deliver(mention(change));
  assert.deepEqual(fx.admitted, []);
});

test('installed QQ contract acquires an explicitly quoted native file under the current mention authority', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(input));
  const fx = await fixture(t, { production: true });
  const native = mention();
  const elements = [{ msg_idx: 'quoted-file-index', content: '', message_type: 103, attachments: native.attachments }];
  await fx.bot().deliver(mention({ attachments: undefined, msgType: 103,
    refMsgIdx: 'quoted-file-index', msgElements: elements,
    raw: { id: 'file-source', group_openid: 'app-group', author: { member_openid: 'app-member' },
      message_type: 103, msg_elements: elements,
      message_scene: { ext: ['ref_msg_idx=quoted-file-index'] } } }));
  assert.equal(fx.admitted.length, 1);
  const event = fx.admitted[0];
  assert.equal(event.messageId, 'file-source');
  assert.equal(event.attachments[0].messageId, 'file-source');
  assert.equal(event.attachments[0].name, 'input.csv');
  assert.match(event.text, /Quoted file/);
  assert.equal(JSON.stringify(event).includes('private-ticket'), false);
  const chunks = [];
  for await (const bytes of await fx.service.externalFileChecked(fx.botId, event.reply, event.attachments[0], fx.options))
    chunks.push(bytes);
  assert.deepEqual(Buffer.concat(chunks), input);
  const result = await fx.service.externalFileChecked(fx.botId, event.reply,
    { id: 'quoted-result', name: 'total.csv', mediaType: 'text/csv', bytes: Buffer.from('total_quantity\n5\n') },
    { ...fx.options, reply: true });
  assert.equal(result.receipt.conversationId, 'app-group');
  assert.equal(fx.bot().sent[0].body.msg_id, 'file-source');
  const evidence = (await fx.controller.status()).bots[0].health.lastInbound;
  assert.equal(evidence.messageType, 103);
  assert.equal(evidence.quotedFiles, 1);
  assert.equal(evidence.quoteIndexMatches, true);
  assert.deepEqual(evidence.quoteShape, {
    directAttachments: 'absent', rawDirectAttachments: 'absent',
    elementFields: ['attachments', 'content', 'message_type', 'msg_idx'], normalizedElementMatches: true,
    elementMessageType: 103,
    files: [{ urlPresent: true, httpsUrl: true, sizeType: 'number', sizeValid: true }],
  });
  assert.equal(JSON.stringify(evidence).includes('private-ticket'), false);
});

test('private QQ file acquisition enforces exact descriptors, bounded bytes and current authority', async t => {
  const fx = await fixture(t);
  await fx.bot().deliver(mention());
  const event = fx.admitted[0];
  let downloads = 0;
  let response = () => new Response(input);
  t.mock.method(globalThis, 'fetch', async () => { downloads++; return response(); });
  await assert.rejects(() => fx.service.externalFileChecked(fx.botId, event.reply,
    { ...event.attachments[0], resourceKey: 'other-source' }, fx.options), { code: 'stale-route' });
  assert.equal(downloads, 0);
  for (const [make, code] of [
    [() => new Response(null, { status: 302 }), 'resource-unavailable'],
    [() => new Response(input, { headers: { 'content-length': String(25 * 1024 * 1024 + 1) } }), 'artifact-too-large'],
    [() => new Response(Buffer.from('truncated')), 'resource-unavailable'],
    [() => { fx.bot().api.get = async () => ({ id: 'different-bot', bot: true }); return new Response(input); }, 'account-changed'],
  ]) {
    response = make;
    await assert.rejects(() => fx.service.externalFileChecked(fx.botId, event.reply, event.attachments[0], fx.options), { code });
  }
});

test('quoted QQ files reject missing native proof, conflicting indices and neighbouring messages', async t => {
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async () => { downloads++; return new Response(input); });
  const native = mention();
  const elements = [{ msg_idx: 'quoted-file-index', attachments: native.attachments }];
  const raw = { id: native.messageId, group_openid: native.groupOpenid, author: { member_openid: native.senderId },
    message_type: 103, msg_elements: elements, message_scene: { ext: ['ref_msg_idx=quoted-file-index'] } };
  const quoted = { attachments: undefined, msgType: 103, refMsgIdx: 'quoted-file-index', msgElements: elements, raw };
  const disabled = await fixture(t, { sourceFiles: false });
  await disabled.bot().deliver(mention(quoted));
  assert.deepEqual(disabled.admitted, []);
  const fx = await fixture(t);
  for (const change of [
    { raw: undefined }, { rawEventType: 'GROUP_MESSAGE_CREATE' }, { senderIsBot: true },
    { refMsgIdx: 'another-index' }, { msgElements: [{ ...elements[0], msg_idx: 'another-index' }] },
    { attachments: native.attachments },
    { attachments: {} },
    { raw: { ...raw, id: 'another-mention' } }, { raw: { ...raw, group_openid: 'another-app-group' } },
    { raw: { ...raw, message_scene: { ext: ['ref_msg_idx=another-index'] } } },
    { raw: { ...raw, msg_elements: [elements[0], elements[0]] } },
    { raw: { ...raw, msg_elements: [{ msg_idx: 'quoted-file-index' }] } },
    { raw: { ...raw, msg_elements: [{ ...elements[0], msg_elements: elements }] } },
    { raw: { ...raw, msg_elements: [{ ...elements[0], message_type: { msg_elements: elements } }] } },
    { raw: { ...raw, msg_elements: [{ ...elements[0], message_type: '4' }] } },
    { raw: { ...raw, msg_elements: [{ ...elements[0], message_type: -1 }] } },
    { raw: { ...raw, msg_elements: [{ ...elements[0], attachments: [{ content_type: 'voice', url: privateUrl }] }] } },
  ]) await fx.bot().deliver(mention({ ...quoted, ...change }));
  assert.deepEqual(fx.admitted, []);
  assert.equal(downloads, 0);
  assert.deepEqual(fx.bot().sent, []);
  const evidence = (await fx.controller.status()).bots[0].health.lastInbound;
  assert.equal(evidence.refusalCode, 'invalid-inbound');
  assert.equal(JSON.stringify(evidence).includes(privateUrl), false);
});

test('installed QQ file diagnostics distinguish quote proof and file descriptor refusals without private values', async t => {
  const fx = await fixture(t, { production: true });
  const native = mention();
  const quoted = (element, changes = {}) => mention({ attachments: undefined, msgType: 103,
    refMsgIdx: 'quoted-file-index', msgElements: [element],
    raw: { id: native.messageId, group_openid: native.groupOpenid,
      author: { member_openid: native.senderId }, message_type: 103, msg_elements: [element] }, ...changes });
  const element = { msg_idx: 'quoted-file-index', attachments: native.attachments };
  for (const [message, reason] of [
    [quoted(element, { raw: undefined }), 'quote-envelope-invalid'],
    [quoted(element, { refMsgIdx: 'another-index' }), 'quote-reference-invalid'],
    [quoted({ ...element, unknown_field: 'private-value' }), 'quote-elements-invalid'],
    [quoted({ ...element, attachments: [{ content_type: 'file', filename: 'input.csv' }] }), 'file-url-invalid'],
    [quoted({ ...element, attachments: [{ ...native.attachments[0], size: '29' }] }), 'file-size-invalid'],
  ]) {
    await fx.bot().deliver(message);
    const evidence = (await fx.controller.status()).bots[0].health.lastInbound;
    assert.equal(evidence.refusalCode, 'invalid-inbound');
    assert.equal(evidence.refusalReason, reason);
    assert.equal(JSON.stringify(evidence).includes('private-value'), false);
    assert.equal(JSON.stringify(evidence).includes(privateUrl), false);
  }
  assert.deepEqual(fx.admitted, []);
  assert.deepEqual(fx.bot().sent, []);
});

test('revoked QQ file upload never dispatches and a lost native file response remains unknown', async t => {
  for (const revoke of ['lease', 'registration', 'account', 'core-fence', 'token', 'cancel']) {
    const fx = await fixture(t);
    await fx.bot().deliver(mention());
    let authorized = true;
    const cancellation = new AbortController();
    const options = { ...fx.options, reply: true, signal: cancellation.signal, beforeSend: () => authorized };
    fx.bot().uploadMedia = async () => {
      if (revoke === 'lease') fx.dispose();
      if (revoke === 'registration') fx.unregister();
      if (revoke === 'account') fx.bot().api.get = async () => ({ id: 'different-bot', bot: true });
      if (revoke === 'core-fence') authorized = false;
      if (revoke === 'cancel') cancellation.abort();
      return { file_info: 'private-upload-ticket' };
    };
    if (revoke === 'token') fx.bot().api.getToken = async () => { authorized = false; return 'test-token'; };
    await assert.rejects(() => fx.service.externalFileChecked(fx.botId, fx.admitted[0].reply,
      { id: 'result', name: 'result.csv', bytes: input, mediaType: 'text/csv' }, options));
    assert.deepEqual(fx.bot().sent, []);
  }
  const fx = await fixture(t);
  await fx.bot().deliver(mention());
  fx.bot().apiClient.request = async (...request) => { fx.bot().sent.push(request); throw new Error('lost response'); };
  await assert.rejects(() => fx.service.externalFileChecked(fx.botId, fx.admitted[0].reply,
    { id: 'result', name: 'result.csv', bytes: input, mediaType: 'text/csv' }, { ...fx.options, reply: true }),
  { code: 'reply-result-unknown' });
  assert.equal(fx.bot().sent.length, 1);
});
