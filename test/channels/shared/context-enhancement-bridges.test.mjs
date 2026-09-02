import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { DingtalkHarnessBridge } from '../../../src/channels/dingtalk/dingtalk-bridge.mjs';
import { DiscordHarnessBridge } from '../../../src/channels/discord/discord-bridge.mjs';
import { normalizeDiscordMessage } from '../../../src/channels/discord/discord-runtime.mjs';
import { FeishuHarnessBridge } from '../../../src/channels/feishu/bridge.mjs';
import { QqHarnessBridge } from '../../../src/channels/qq/qq-bridge.mjs';
import { SlackHarnessBridge } from '../../../src/channels/slack/slack-bridge.mjs';
import { normalizeSlackEvent } from '../../../src/channels/slack/slack-runtime.mjs';
import { TelegramHarnessBridge } from '../../../src/channels/telegram/telegram-bridge.mjs';
import { normalizeTelegramUpdate } from '../../../src/channels/telegram/telegram-runtime.mjs';
import { WecomHarnessBridge } from '../../../src/channels/wecom/wecom-bridge.mjs';
import { WeixinHarnessBridge } from '../../../src/channels/weixin/weixin-bridge.mjs';
import { WhatsappHarnessBridge } from '../../../src/channels/whatsapp/whatsapp-bridge.mjs';
import { normalizeWhatsappMessage } from '../../../src/channels/whatsapp/whatsapp-runtime.mjs';
import { CONTEXT_ENHANCEMENT_FIELDS } from '../../../src/channels/shared/context-enhancement.mjs';

const CHANNELS = ['wecom', 'weixin', 'feishu', 'dingtalk', 'qq', 'slack', 'telegram', 'discord', 'whatsapp'];
const TEXT_BRIDGES = { slack: SlackHarnessBridge, telegram: TelegramHarnessBridge,
  discord: DiscordHarnessBridge, whatsapp: WhatsappHarnessBridge };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const FILE = Buffer.from('unchanged file bytes');
const logger = { info() {}, warn() {}, error() {} };

function settings(overrides = {}) {
  const {
    groupEnabled = true,
    directEnabled = true,
    fields = [...CONTEXT_ENHANCEMENT_FIELDS],
    guidance = '',
    group = {},
    direct = {},
    ...extra
  } = overrides;
  return {
    group: { enabled: groupEnabled, fields: [...fields], guidance, ...group },
    direct: { enabled: directEnabled, fields: [...fields], guidance, ...direct },
    ...extra,
  };
}

function provider(channel, config) {
  return { botId: `${channel}_internal`, getSettings: () => config };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function eventually(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Expected message processing did not finish');
}

function sourceOf(content) {
  const text = Array.isArray(content) ? content[0].text : content;
  const match = /^<dsh_im_source>(.*?)<\/dsh_im_source>/su.exec(text);
  assert.ok(match, `No source in ${text}`);
  return JSON.parse(match[1]);
}

function textOf(content) {
  return Array.isArray(content)
    ? content.filter((item) => item?.type === 'text').map((item) => item.text).join('\n\n')
    : content;
}

function withoutPrompt(calls) {
  return calls.map(([operation, ...args]) => operation === 'ask'
    ? [operation, args[0], '(prompt)', args[2]] : [operation, ...args]);
}

function fixture(channel, { contextEnhancement, onAsk } = {}) {
  const calls = [];
  const prompts = [];
  const sessions = new Map();
  const seen = new Set();
  let sourceReads = 0;
  const state = {
    hasSeen: (id) => seen.has(id),
    markSeen: async (id) => { seen.add(id); calls.push(['seen', id]); },
    sessionFor: (key) => sessions.get(key) ?? null,
    setSession: async (key, id) => { sessions.set(key, id); calls.push(['bind', key, id]); },
    clearSession: async (key) => { sessions.delete(key); calls.push(['clear', key]); },
    pendingSenders: () => [],
  };
  const harness = {
    ensureRunning: async () => { calls.push(['ensureRunning']); },
    createSession: async () => { calls.push(['createSession']); return 'session-existing'; },
    renameSession: async (sessionId, title) => {
      calls.push(['renameSession', sessionId, title]);
      return { title, seq: 0 };
    },
    sessionExists: async (id) => { calls.push(['sessionExists', id]); return true; },
    hasActiveTurn: async () => false,
    isSessionRunning: async () => false,
    currentWorkspace: () => null,
    ask: async (sessionId, content, options) => {
      prompts.push(content);
      calls.push(['ask', sessionId, content, Object.keys(options).sort()]);
      for (const file of options.files ?? []) {
        const loaded = await file.load({ signal: options.signal });
        calls.push(['file', file.name, Buffer.from(loaded?.data ?? loaded).toString('hex')]);
      }
      return onAsk ? onAsk({ sessionId, content, options, prompts }) : 'answer unchanged';
    },
  };
  const sendText = async (...args) => {
    calls.push(['sendText', ...args]);
    return { messageId: 'reply-one', id: 'reply-one' };
  };
  const image = (name) => ({ name, mediaType: 'image/png', load: async () => {
    calls.push(['image', name]); return PNG;
  } });
  const file = () => ({ name: 'report.txt', load: async () => {
    calls.push(['file-download']); return FILE;
  } });
  const dependencies = { harness, state, contextEnhancement, logger };
  let bridge;
  if (TEXT_BRIDGES[channel]) {
    bridge = new TEXT_BRIDGES[channel]({ ...dependencies, bot: { sendText } });
  } else if (channel === 'wecom') {
    bridge = new WecomHarnessBridge({ ...dependencies, generateStreamId: () => 'stream-one', client: {
      replyStream: async (frame, streamId, text, finish) => {
        calls.push(['replyStream', frame.body.msgid, streamId, text, finish]);
        return { body: { msgid: 'reply-one' } };
      },
      sendMessage: sendText,
      downloadFile: async (url) => {
        calls.push(['downloadFile', url]);
        return { buffer: url.endsWith('.png') ? PNG : FILE, filename: url.split('/').at(-1) };
      },
    } });
  } else if (channel === 'weixin') {
    bridge = new WeixinHarnessBridge({ ...dependencies, baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'private-token', ownerUserId: 'actor', api: {
        sendText: async ({ toUserId, text, contextToken, runId }) => sendText({ toUserId, text, contextToken, runId }),
        inboundImages: (event) => event.item_list.filter((item) => item.image_item).map((_item, index) => image(`image-${index}.png`)),
        inboundFiles: (event) => event.item_list.filter((item) => item.file_item).map(file),
      } });
  } else if (channel === 'dingtalk') {
    bridge = new DingtalkHarnessBridge({ ...dependencies, clientId: 'app', clientSecret: 'private-secret', api: {
      sendText: async ({ sessionWebhook, text, at }) => sendText({ sessionWebhook, text, at }),
      downloadImage: async ({ downloadCode }) => { calls.push(['downloadImage', downloadCode]); return PNG; },
      downloadFile: async ({ downloadCode }) => { calls.push(['downloadFile', downloadCode]); return FILE; },
    } });
  } else if (channel === 'qq') {
    bridge = new QqHarnessBridge({ ...dependencies, ownerUserOpenid: '*', bot: { sendText },
      fetchImpl: async (url) => {
        calls.push(['fetch', String(url)]);
        const isImage = String(url).endsWith('.png');
        return new Response(isImage ? PNG : FILE, { headers: { 'content-type': isImage ? 'image/png' : 'text/plain' } });
      },
    });
  } else {
    bridge = new FeishuHarnessBridge({ ...dependencies, status: {}, allowedSenderOpenIds: new Set(['*']),
      channel: {}, client: { im: { v1: {
        message: { create: async (request) => {
          calls.push(['createMessage', request]);
          return { code: 0, data: { message_id: 'reply-one' } };
        } },
        messageResource: { get: async ({ path, params }) => {
          calls.push(['messageResource', path, params]);
          const bytes = params.type === 'image' ? PNG : FILE;
          return { headers: { 'content-length': String(bytes.length) }, getReadableStream: () => Readable.from([bytes]) };
        } },
      } } },
    });
  }

  function event(id, text = ' \t user text\nsecond line  ', { kind = 'direct', name = 'Ada', actor = 'actor', media, poisonName = false } = {}) {
    const group = kind === 'group';
    const nameValue = (object, key) => Object.defineProperty(object, key, { configurable: true, get() {
      sourceReads += 1;
      if (poisonName) throw new Error('enhancement-only source must not be read');
      return name;
    } });
    let value;
    if (channel === 'telegram') {
      const from = { id: actor === 'actor' ? 42 : 43, is_bot: false };
      nameValue(from, 'first_name');
      value = normalizeTelegramUpdate({ update_id: id, message: {
        message_id: id, chat: { id: 100, type: group ? 'supergroup' : 'private',
          ...(group ? { title: 'Telegram群' } : {}) }, from,
        text: group ? `@testbot ${text}` : text, entities: group ? [{ type: 'mention', offset: 0, length: 8 }] : [],
      } }, { botId: 'bot', username: 'testbot' });
    } else if (channel === 'discord') {
      const author = { id: actor, bot: false };
      nameValue(author, 'global_name');
      value = normalizeDiscordMessage({ id: String(id), channel_id: 'chat', author,
        guild_id: group ? 'guild' : undefined, content: text, mentions: [{ id: 'bot' }],
      }, 'bot');
    } else if (channel === 'whatsapp') {
      const raw = { key: { id: String(id), remoteJid: group ? 'chat@g.us' : `${actor}@s.whatsapp.net`,
        participant: group ? `${actor}@s.whatsapp.net` : undefined, fromMe: false },
      message: { extendedTextMessage: { text, contextInfo: { mentionedJid: ['bot@s.whatsapp.net'] } } } };
      nameValue(raw, 'pushName');
      value = normalizeWhatsappMessage(raw, 'bot@s.whatsapp.net');
    } else if (channel === 'slack') {
      value = normalizeSlackEvent({ event_id: String(id), event: { type: group ? 'app_mention' : 'message',
        ts: String(id), channel: 'chat', channel_type: group ? 'channel' : 'im', user: actor,
        thread_ts: group ? 'thread-existing' : undefined,
        text: group ? `<@bot> ${text}` : text,
      } }, 'bot');
    } else if (channel === 'wecom') {
      value = { headers: { req_id: String(id) }, body: { msgid: String(id), from: { userid: actor },
        chattype: group ? 'group' : 'single', chatid: 'chat', msgtype: 'text', text: { content: text } } };
    } else if (channel === 'weixin') {
      value = { message_id: String(id), message_type: 1, from_user_id: actor, context_token: 'context',
        item_list: [{ type: 1, text_item: { text } }] };
    } else if (channel === 'dingtalk') {
      value = { msgId: String(id), msgtype: 'text', text: { content: text }, senderStaffId: actor,
        conversationType: group ? '2' : '1', conversationId: 'chat',
        conversationTitle: group ? '钉钉测试群' : undefined, isInAtList: true,
        sessionWebhook: 'https://oapi.dingtalk.com/robot/reply?ticket=test' };
      nameValue(value, 'senderNick');
    } else if (channel === 'qq') {
      value = { messageId: String(id), senderId: actor, kind: group ? 'group' : 'c2c', groupOpenid: 'chat',
        rawEventType: group ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE', senderIsBot: false, content: text,
        replyTarget: { scope: group ? 'group' : 'c2c', targetId: group ? 'chat' : actor, msgId: String(id) } };
      nameValue(value, 'senderName');
    } else {
      value = { sender: { sender_type: 'user', sender_id: { open_id: actor } }, message: {
        message_id: String(id), message_type: 'text', chat_id: 'chat', chat_type: group ? 'group' : 'p2p',
        content: JSON.stringify({ text }), mentions: group ? [{ key: '@bot', id: { open_id: 'bot' } }] : [],
      } };
    }
    assert.ok(value, `${channel} event should normalize`);
    if (!media) return value;
    const imageNames = media === 'mixed' ? ['first.png', 'second.png'] : media === 'image' ? ['first.png'] : [];
    const includeFile = media === 'file' || media === 'mixed';
    if (TEXT_BRIDGES[channel]) {
      value.images = imageNames.map(image);
      value.files = includeFile ? [file()] : [];
    } else if (channel === 'wecom') {
      value.body.msgtype = 'mixed';
      value.body.mixed = { msg_item: [
        { msgtype: 'text', text: { content: text } },
        ...imageNames.map((name) => ({ msgtype: 'image', image: { url: `https://wecom.test/${name}` } })),
        ...(includeFile ? [{ msgtype: 'file', file: { url: 'https://wecom.test/report.txt', filename: 'report.txt' } }] : []),
      ] };
    } else if (channel === 'weixin') {
      value.item_list.push(...imageNames.map(() => ({ type: 2, image_item: {} })),
        ...(includeFile ? [{ type: 4, file_item: { file_name: 'report.txt' } }] : []));
    } else if (channel === 'dingtalk') {
      value.msgtype = media === 'file' ? 'file' : 'richText';
      value.content = media === 'file' ? { downloadCode: 'file-one', fileName: 'report.txt' }
        : { richText: [{ text }, ...imageNames.map((downloadCode) => ({ type: 'picture', downloadCode }))] };
    } else if (channel === 'qq') {
      value.attachments = [
        ...imageNames.map((name) => ({ filename: name, url: `https://gchat.qpic.cn/${name}`, content_type: 'image/png' })),
        ...(includeFile ? [{ filename: 'report.txt', url: 'https://gchat.qpic.cn/report.txt', content_type: 'text/plain' }] : []),
      ];
    } else {
      value.message.message_type = media === 'file' ? 'file' : 'post';
      value.message.content = JSON.stringify(media === 'file' ? { file_key: 'file-one', file_name: 'report.txt' }
        : { content: [[{ tag: 'text', text }, ...imageNames.map((image_key) => ({ tag: 'img', image_key }))]] });
    }
    return value;
  }
  return { bridge, event, calls, prompts, sessions, seen, get sourceReads() { return sourceReads; } };
}

for (const channel of CHANNELS) {
  const kinds = channel === 'weixin' ? ['direct'] : ['direct', 'group'];
  for (const kind of kinds) {
    test(`${channel} ${kind}: disabled settings preserve text/media, calls and session bindings`, async () => {
      const oppositeOnly = settings({ groupEnabled: kind === 'direct', directEnabled: kind === 'group' });
      const poisonedOff = {
        groupEnabled: false, directEnabled: false,
        get fields() { throw new Error('off fields accessed'); },
        get guidance() { throw new Error('off guidance accessed'); },
      };
      const variants = [
        provider(channel, undefined),
        provider(channel, settings({ groupEnabled: false, directEnabled: false })),
        provider(channel, oppositeOnly),
        provider(channel, poisonedOff),
        provider(channel, { groupEnabled: 'true', directEnabled: 1 }),
        { getSettings() { throw new Error('damaged optional settings'); } },
      ];
      for (const media of [undefined, 'image', 'file', 'mixed']) {
        const baseline = fixture(channel);
        await baseline.bridge.accept(baseline.event(1, undefined, { kind, media, poisonName: true }));
        assert.equal(baseline.prompts.length, 1);
        assert.equal(baseline.sourceReads, 0);
        assert.equal(baseline.calls.some(([operation]) => operation === 'renameSession'), false);
        for (const contextEnhancement of variants) {
          const current = fixture(channel, { contextEnhancement });
          await current.bridge.accept(current.event(1, undefined, { kind, media, poisonName: true }));
          assert.deepEqual(current.calls, baseline.calls, `${media ?? 'text'}: preserve platform/Harness call order and arguments`);
          assert.deepEqual(current.sessions, baseline.sessions);
          assert.deepEqual(current.seen, baseline.seen);
          assert.equal(current.sourceReads, 0);
          assert.equal(current.bridge.status?.lastMessageError ?? null, null);
        }
      }
    });

    test(`${channel} ${kind}: enabled source uses the actual event, optional name and internal bot ID`, async () => {
      const current = fixture(channel, { contextEnhancement: provider(channel, settings()) });
      await current.bridge.accept(current.event(1, 'hello', { kind }));
      const chatId = channel === 'telegram' ? '100'
        : channel === 'whatsapp' ? (kind === 'group' ? 'chat@g.us' : 'actor@s.whatsapp.net')
          : channel === 'wecom' || channel === 'qq' || channel === 'weixin'
            ? (kind === 'group' ? 'chat' : 'actor') : 'chat';
      const expected = {
        channel, conversationType: kind,
        senderId: channel === 'telegram' ? '42' : channel === 'whatsapp' ? 'actor@s.whatsapp.net' : 'actor',
        ...(['dingtalk', 'telegram', 'discord', 'whatsapp'].includes(channel) || (channel === 'qq' && kind === 'group')
          ? { senderName: 'Ada' } : {}),
        ...(channel === 'dingtalk' && kind === 'group' ? { conversationTitle: '钉钉测试群' } : {}),
        ...(channel === 'telegram' && kind === 'group' ? { conversationTitle: 'Telegram群' } : {}),
        chatId,
        ...(channel === 'slack' && kind === 'group' ? { threadId: 'thread-existing' } : {}),
        botId: `${channel}_internal`,
      };
      assert.deepEqual(sourceOf(current.prompts[0]), expected);
      assert.ok(textOf(current.prompts[0]).endsWith('\n\nhello'));
      assert.doesNotMatch(textOf(current.prompts[0]), /source_guidance|private-token|private-secret/);
      assert.deepEqual(
        current.calls.filter(([operation]) => operation === 'renameSession'),
        [['renameSession', 'session-existing', 'hello']],
      );
      // Explicit null represents a provider event that does not include a nickname.
      await current.bridge.accept(current.event(2, 'missing name', { kind, name: null }));
      assert.equal(Object.hasOwn(sourceOf(current.prompts[1]), 'senderName'), false);
      if (kind === 'group') {
        await current.bridge.accept(current.event(3, 'another sender', { kind, name: 'Grace', actor: 'actor-two' }));
        const next = sourceOf(current.prompts[2]);
        assert.notEqual(next.senderId, expected.senderId);
        if (expected.senderName) assert.equal(next.senderName, 'Grace');
        assert.equal(current.sessions.size, 1, 'group speakers keep sharing the existing group Session');
      }
    });
  }

  if (channel !== 'weixin') {
    test(`${channel}: group and direct fields and guidance stay isolated`, async () => {
      const config = settings({
        group: { enabled: true, fields: ['channel'], guidance: 'GROUP-ONLY-TOKEN' },
        direct: { enabled: true, fields: ['botId'], guidance: 'DIRECT-ONLY-TOKEN' },
      });
      const current = fixture(channel, { contextEnhancement: provider(channel, config) });
      await current.bridge.accept(current.event(1, 'direct message', { kind: 'direct' }));
      await current.bridge.accept(current.event(2, 'group message', { kind: 'group' }));
      assert.deepEqual(sourceOf(current.prompts[0]), { botId: `${channel}_internal` });
      assert.match(textOf(current.prompts[0]), /DIRECT-ONLY-TOKEN/);
      assert.doesNotMatch(textOf(current.prompts[0]), /GROUP-ONLY-TOKEN|"channel"/);
      assert.deepEqual(sourceOf(current.prompts[1]), { channel });
      assert.match(textOf(current.prompts[1]), /GROUP-ONLY-TOKEN/);
      assert.doesNotMatch(textOf(current.prompts[1]), /DIRECT-ONLY-TOKEN|"botId"/);
    });
  }

  test(`${channel}: enabled image/file assembly adds one prefix and preserves the remaining payload`, async () => {
    for (const media of ['image', 'file', 'mixed']) {
      const plain = fixture(channel);
      const enabled = fixture(channel, { contextEnhancement: provider(channel, settings({ guidance: 'Use only provided fields.' })) });
      await plain.bridge.accept(plain.event(1, 'caption', { media }));
      await enabled.bridge.accept(enabled.event(1, 'caption', { media }));
      const original = plain.prompts[0];
      const enhanced = enabled.prompts[0];
      if (Array.isArray(original)) {
        assert.equal(enhanced[0].type, 'text');
        assert.deepEqual(enhanced.slice(1), original);
        assert.match(enhanced[0].text, /<dsh_im_source_guidance>\nUse only provided fields\./);
      } else {
        assert.ok(enhanced.endsWith(`\n\n${original}`));
      }
      assert.deepEqual(enabled.calls.filter(([op]) => op === 'file'), plain.calls.filter(([op]) => op === 'file'));
      const expectedTitle = media === 'file' && ['feishu', 'dingtalk'].includes(channel)
        ? 'report.txt'
        : 'caption';
      assert.deepEqual(
        enabled.calls.filter(([op]) => op === 'renameSession'),
        [['renameSession', 'session-existing', expectedTitle]],
      );
      assert.deepEqual(
        withoutPrompt(enabled.calls.filter(([op]) => op !== 'renameSession')),
        withoutPrompt(plain.calls),
        'enhancement only adds the initial title request',
      );
    }
  });

  test(`${channel}: queued messages keep their accepted snapshot across saves and disablement`, async () => {
    let config = settings({ fields: ['channel'], guidance: 'version one' });
    const started = deferred();
    const release = deferred();
    const current = fixture(channel, {
      contextEnhancement: { botId: `${channel}_internal`, getSettings: () => config },
      onAsk: async ({ prompts }) => {
        if (prompts.length === 1) { started.resolve(); await release.promise; }
        return 'answer unchanged';
      },
    });
    const first = current.bridge.accept(current.event(1, 'first'));
    await started.promise;
    const queued = current.bridge.accept(current.event(2, 'queued'));
    config.direct.guidance = 'mutated after acceptance';
    config = settings({ fields: ['botId'], guidance: 'version two' });
    const newer = current.bridge.accept(current.event(3, 'newer'));
    config = settings({ groupEnabled: false, directEnabled: false });
    const off = current.bridge.accept(current.event(4, 'off'));
    config = settings({ fields: ['botId'], guidance: 'version three' });
    const reenabled = current.bridge.accept(current.event(5, 'reenabled'));
    release.resolve();
    await Promise.all([first, queued, newer, off, reenabled]);
    assert.match(current.prompts[0], /version one/);
    assert.match(current.prompts[1], /version one/);
    assert.doesNotMatch(current.prompts[1], /mutated|version two/);
    assert.deepEqual(sourceOf(current.prompts[2]), { botId: `${channel}_internal` });
    assert.match(current.prompts[2], /version two/);
    assert.equal(current.prompts[3], 'off');
    assert.match(current.prompts[4], /version three/);
    assert.equal(current.calls.filter(([op]) => op === 'createSession').length, 1);
  });

  test(`${channel}: batches gain one prefix only at final submission`, async () => {
    const current = fixture(channel, { contextEnhancement: provider(channel, settings()) });
    await current.bridge.accept(current.event(1, '/batch'));
    await current.bridge.accept(current.event(2, 'first item'));
    await current.bridge.accept(current.event(3, 'second item'));
    assert.equal(current.prompts.length, 0);
    await current.bridge.accept(current.event(4, '/send'));
    assert.equal(current.prompts.length, 1);
    assert.equal(current.prompts[0].split('<dsh_im_source>').length - 1, 1);
    assert.match(current.prompts[0], /first item[\s\S]*second item/);
  });

  test(`${channel}: disabled batches retain the original one-submission behavior and calls`, async () => {
    const baseline = fixture(channel);
    const disabled = fixture(channel, {
      contextEnhancement: provider(channel, settings({ groupEnabled: false, directEnabled: false })),
    });
    for (const current of [baseline, disabled]) {
      for (const [index, text] of ['/batch', '  first item\n', 'second\nitem  ', '/send'].entries()) {
        await current.bridge.accept(current.event(index + 1, text, { poisonName: true }));
      }
      assert.equal(current.prompts.length, 1);
      assert.equal(current.sourceReads, 0);
    }
    assert.deepEqual(disabled.calls, baseline.calls);
    assert.deepEqual(disabled.sessions, baseline.sessions);
    assert.deepEqual(disabled.seen, baseline.seen);
  });

  test(`${channel}: filtered and duplicate events never assemble source metadata`, async () => {
    const current = fixture(channel, { contextEnhancement: provider(channel, settings()) });
    const rejected = current.event(1, 'ignored', { kind: channel === 'weixin' ? 'direct' : 'group', poisonName: true });
    if (TEXT_BRIDGES[channel]) rejected.addressed = false;
    else if (channel === 'wecom') rejected.body.chattype = 'unknown';
    else if (channel === 'weixin') rejected.from_user_id = 'not-the-owner';
    else if (channel === 'feishu') rejected.sender.sender_type = 'bot';
    else if (channel === 'dingtalk') rejected.isInAtList = false;
    else rejected.rawEventType = 'GROUP_MESSAGE_CREATE';
    await current.bridge.accept(rejected);
    assert.equal(current.prompts.length, 0);
    assert.equal(current.sourceReads, 0);
    await current.bridge.accept(current.event(2, 'accepted'));
    const reads = current.sourceReads;
    await current.bridge.accept(current.event(2, 'duplicate', { poisonName: true }));
    assert.equal(current.prompts.length, 1);
    assert.equal(current.sourceReads, reads);
  });

  test(`${channel}: field subsets and guidance-only/empty configurations do not restore defaults`, async () => {
    for (const config of [settings({ fields: ['channel'] }), settings({ fields: [], guidance: 'custom' }), settings({ fields: [], guidance: '' })]) {
      const current = fixture(channel, { contextEnhancement: provider(channel, config) });
      await current.bridge.accept(current.event(1, 'hello'));
      if (config.direct.fields.length) assert.deepEqual(sourceOf(current.prompts[0]), { channel });
      else if (config.direct.guidance) assert.equal(current.prompts[0], '<dsh_im_source_guidance>\ncustom\n</dsh_im_source_guidance>\n\nhello');
      else {
        assert.equal(current.prompts[0], 'hello');
        assert.equal(current.calls.some(([operation]) => operation === 'renameSession'), false);
      }
    }
  });

  test(`${channel}: local help/new/steer do not inspect enhancement-only sources`, async () => {
    const current = fixture(channel, { contextEnhancement: provider(channel, settings()) });
    for (const [index, text] of ['/help', '/new', '/steer supplement'].entries()) {
      await current.bridge.accept(current.event(index + 1, text, { poisonName: true }));
    }
    assert.equal(current.prompts.length, 0);
    assert.equal(current.sourceReads, 0);
    assert.doesNotMatch(JSON.stringify(current.calls), /<dsh_im_source/);
  });

  for (const kind of ['question', 'approval']) {
    test(`${channel}: ${kind} replies remain unenhanced while ordinary messages are enabled`, async () => {
      const finished = deferred();
      const responses = [];
      const current = fixture(channel, {
        contextEnhancement: provider(channel, settings()),
        onAsk: async ({ sessionId, options }) => {
          await options.onInteraction({
            kind, interactionId: 'interaction', rpcId: 'interaction', sessionId,
            payload: kind === 'question'
              ? { type: 'question/requested', sessionId, questions: [{ id: 'answer', question: 'waiting for answer' }] }
              : { type: 'approval/requested', sessionId, approvalId: 'interaction', toolName: 'fixture-tool', callId: 'call', reason: 'waiting for approval' },
            toolCall: kind === 'approval' ? { callId: 'call', name: 'fixture-tool', arguments: '{}' } : undefined,
            respond: async (result) => { responses.push(result); finished.resolve(); return { accepted: true }; },
          });
          await finished.promise;
          return 'answer unchanged';
        },
      });
      const processing = current.bridge.accept(current.event(1, 'ordinary question'));
      await eventually(() => JSON.stringify(current.calls).includes('waiting for'));
      const readsBeforeReply = current.sourceReads;
      await current.bridge.accept(current.event(2, kind === 'question' ? 'blue' : '批准', { poisonName: true }));
      await processing;
      assert.equal(current.prompts.length, 1);
      assert.equal(responses.length, 1);
      assert.equal(current.sourceReads, readsBeforeReply);
      assert.doesNotMatch(JSON.stringify(responses), /dsh_im_source/);
    });
  }
}

test('Telegram retains event first/last names and falls back only to an existing username', async () => {
  const current = fixture('telegram', { contextEnhancement: provider('telegram', settings()) });
  for (const [index, from] of [
    { first_name: 'Ada', last_name: 'Lovelace', username: 'ada' },
    { first_name: '', last_name: '  ', username: 'ada' },
    {},
  ].entries()) {
    const message = normalizeTelegramUpdate({ update_id: index + 1, message: {
      message_id: index + 1, chat: { id: 100, type: 'private' }, from: { id: 42, ...from }, text: 'hello',
    } }, { botId: 'bot', username: 'testbot' });
    await current.bridge.accept(message);
  }
  assert.equal(sourceOf(current.prompts[0]).senderName, 'Ada Lovelace');
  assert.equal(sourceOf(current.prompts[1]).senderName, 'ada');
  assert.equal(Object.hasOwn(sourceOf(current.prompts[2]), 'senderName'), false);
});

test('Discord prefers event member nickname, global name, then username without a profile lookup', async () => {
  const current = fixture('discord', { contextEnhancement: provider('discord', settings()) });
  for (const [index, names] of [
    { member: { nick: 'Group Nick' }, author: { global_name: 'Global Name', username: 'username' } },
    { member: { nick: '' }, author: { global_name: 'Global Name', username: 'username' } },
    { author: { global_name: null, username: 'username' } },
    { author: {} },
  ].entries()) {
    await current.bridge.accept(normalizeDiscordMessage({
      ...names, id: String(index + 1), channel_id: 'chat', guild_id: 'guild',
      author: { id: 'actor', ...names.author }, content: 'hello', mentions: [{ id: 'bot' }],
    }, 'bot'));
  }
  assert.deepEqual(current.prompts.map((content) => sourceOf(content).senderName),
    ['Group Nick', 'Global Name', 'username', undefined]);
});

test('Feishu topics expose chatId always and threadId only when the event carries a thread', async () => {
  const current = fixture('feishu', { contextEnhancement: provider('feishu', settings()) });
  await current.bridge.accept(current.event(1, 'main channel', { kind: 'group' }));
  const main = sourceOf(current.prompts[0]);
  assert.equal(main.chatId, 'chat');
  assert.equal(Object.hasOwn(main, 'threadId'), false);
  assert.deepEqual(main, {
    channel: 'feishu', conversationType: 'group', senderId: 'actor',
    chatId: 'chat', botId: 'feishu_internal',
  });
  const topic = current.event(2, 'inside a topic', { kind: 'group' });
  topic.message.thread_id = 'omt_topic';
  await current.bridge.accept(topic);
  const topicSource = sourceOf(current.prompts[1]);
  assert.equal(topicSource.chatId, 'chat');
  assert.equal(topicSource.threadId, 'omt_topic');
  assert.equal(current.sessions.size, 2, 'topic messages keep their own thread-scoped Session');
  await current.bridge.accept(current.event(3, 'direct chat', { kind: 'direct' }));
  assert.equal(sourceOf(current.prompts[2]).chatId, 'chat');
  assert.equal(Object.hasOwn(sourceOf(current.prompts[2]), 'threadId'), false);
});
