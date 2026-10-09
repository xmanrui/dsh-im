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
async function fixture(t, { sourceImages = false, sourceFiles = false, sourceVoiceTranscripts = true, sourceVoiceAudio = false, production = true } = {}) {
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
  const dispose = await service.consumeInbound(identity.botId, { expectedFingerprint: fingerprint, sourceImages, sourceFiles, sourceVoiceTranscripts, sourceVoiceAudio,
    onEvent: async event => { admitted.push(event); return { accepted: true }; } });
  return { service, controller, bot: () => bot, botId: identity.botId, fingerprint, admitted, dispose, unregister, observations,
    options: { expectedFingerprint: fingerprint, beforeSend: () => true } };
}

test('installed QQ voice contract preserves native platform ASR and replies under the current mention', async t => {
  const fx = await fixture(t);
  const voice = { content_type: 'voice', url: privateUrl, asr_refer_text: 'What is seventeen times twenty three?' };
  await fx.bot().deliver(mention({ content: '', attachments: [voice] }));
  assert.equal(fx.admitted.length, 1);
  const event = fx.admitted[0];
  assert.deepEqual(event.voice, { transcript: 'platform' });
  assert.equal(event.text, voice.asr_refer_text);
  assert.equal(event.attachments, undefined);
  assert.equal(JSON.stringify(event).includes('private-ticket'), false);
  assert.equal(event.messageId, 'file-source');
  assert.equal(event.mentionedAccount, true);
  const result = await fx.service.replyChecked(fx.botId, event.reply, '391', { ...fx.options, receipt: true });
  assert.equal(result.receipt.conversationId, 'app-group');
  assert.equal(fx.bot().sent.length, 1);
  assert.equal(fx.bot().sent[0].body.msg_id, event.messageId);
  assert.equal(fx.bot().sent[0].body.content, '391');
});

test('QQ voice ASR requires its own opt-in and preserves explicit unavailable provenance', async t => {
  const disabled = await fixture(t, { sourceVoiceTranscripts: false });
  await disabled.bot().deliver(mention({ attachments: [{ content_type: 'voice', url: privateUrl, asr_refer_text: 'Do not admit' }] }));
  assert.deepEqual(disabled.admitted, []);
  const fx = await fixture(t);
  await fx.bot().deliver(mention({ content: 'Please listen', attachments: [{ content_type: 'voice', url: privateUrl }] }));
  assert.equal(fx.admitted.length, 1);
  assert.equal(fx.admitted[0].voice.transcript, 'unavailable');
  assert.match(fx.admitted[0].text, /did not provide a transcript/);
  for (const change of [
    { rawEventType: 'GROUP_MESSAGE_CREATE' }, { senderIsBot: true },
    { attachments: [{ content_type: 'file', url: privateUrl, asr_refer_text: 'Forged ASR' }] },
    { attachments: [{ content_type: 'voice', url: privateUrl, asr_refer_text: {} }] },
    { attachments: [{ content_type: 'voice', url: privateUrl, asr_refer_text: 'x'.repeat(12001) }] },
    { replyTarget: { scope: 'group', targetId: 'other-group', msgId: 'file-source' } },
  ]) await fx.bot().deliver(mention(change));
  assert.equal(fx.admitted.length, 1);
});

test('QQ quoted voice ASR belongs to the current mention even without a separate text instruction', async t => {
  const fx = await fixture(t, { sourceFiles: true });
  const voice = { content_type: 'voice', url: privateUrl, asr_refer_text: 'forty one times forty three' };
  const elements = [{ msg_idx: 'quoted-voice-index', content: '', message_type: 4, attachments: [voice] }];
  const native = mention({ content: '', attachments: undefined, msgType: 103,
    refMsgIdx: 'quoted-voice-index', msgElements: elements,
    raw: { id: 'file-source', group_openid: 'app-group', author: { member_openid: 'app-member' },
      message_type: 103, msg_elements: elements, message_scene: { ext: ['ref_msg_idx=quoted-voice-index'] } } });
  await fx.bot().deliver(native);
  assert.equal(fx.admitted.length, 1);
  assert.equal(fx.admitted[0].voice.transcript, 'platform');
  assert.match(fx.admitted[0].text, /forty one times forty three/);
  assert.equal(fx.admitted[0].reply.messageId, native.messageId);
  assert.deepEqual((await fx.controller.status()).bots[0].health.lastInbound.voice, {
    count: 1, quotedAttachmentCount: 1, quotedCategories: ['voice'], platformTranscriptPresent: true, platformWavPresent: false,
  });
  for (const change of [
    { raw: undefined }, { refMsgIdx: 'other-voice' },
    { raw: { ...native.raw, id: 'other-mention' } },
    { raw: { ...native.raw, message_scene: { ext: ['ref_msg_idx=conflict'] } } },
    { raw: { ...native.raw, msg_elements: [elements[0], elements[0]] } },
    { attachments: [voice] },
  ]) await fx.bot().deliver({ ...native, ...change });
  assert.equal(fx.admitted.length, 1);
});

test('QQ original voice can opt in without disclosing the optional platform transcript', async t => {
  const fx = await fixture(t, { sourceVoiceAudio: true, sourceVoiceTranscripts: false });
  await fx.bot().deliver(mention({ attachments: [{ content_type: 'voice', url: privateUrl,
    asr_refer_text: 'Not opted into transcript disclosure' }] }));
  assert.equal(fx.admitted.length, 1);
  assert.equal(fx.admitted[0].attachments.length, 1);
  assert.equal(fx.admitted[0].voice.transcript, 'unavailable');
  assert.equal(JSON.stringify(fx.admitted).includes('Not opted into transcript disclosure'), false);
});

test('QQ original voice bytes are lazy, source-bound and revoked with their consumer', async t => {
  const bytes = Buffer.from('synthetic-native-voice');
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async () => { downloads++; return new Response(bytes); });
  const fx = await fixture(t, { sourceVoiceAudio: true });
  await fx.bot().deliver(mention({ attachments: [{ content_type: 'voice', url: privateUrl,
    filename: 'voice.silk', size: bytes.length, asr_refer_text: 'spoken request' }] }));
  const event = fx.admitted[0];
  assert.equal(event.attachments?.length, 1);
  const attachment = event.attachments[0];
  assert.equal(attachment.mediaType, 'audio/unknown');
  assert.equal(attachment.messageId, event.messageId);
  assert.equal(downloads, 0);
  assert.equal(JSON.stringify(event).includes('private-ticket'), false);
  const chunks = [];
  for await (const chunk of await fx.service.externalFileChecked(fx.botId, event.reply, attachment, fx.options)) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.equal(downloads, 1);
  await assert.rejects(() => fx.service.externalFileChecked(fx.botId, event.reply,
    { ...attachment, resourceKey: 'neighbouring-voice' }, fx.options), { code: 'stale-route' });
  fx.dispose();
  await assert.rejects(() => fx.service.externalFileChecked(fx.botId, event.reply, attachment, fx.options));
  assert.equal(downloads, 1);
});
