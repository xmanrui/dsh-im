import assert from 'node:assert/strict';
import test from 'node:test';

import { DingtalkHarnessBridge } from '../src/channels/dingtalk/dingtalk-bridge.mjs';
import { DiscordHarnessBridge } from '../src/channels/discord/discord-bridge.mjs';
import { FeishuHarnessBridge } from '../src/channels/feishu/bridge.mjs';
import { QqHarnessBridge } from '../src/channels/qq/qq-bridge.mjs';
import { setImHostLanguage } from '../src/channels/shared/i18n.mjs';
import { SlackHarnessBridge } from '../src/channels/slack/slack-bridge.mjs';
import { normalizeSlackEvent } from '../src/channels/slack/slack-runtime.mjs';
import { TelegramHarnessBridge } from '../src/channels/telegram/telegram-bridge.mjs';
import { WecomHarnessBridge } from '../src/channels/wecom/wecom-bridge.mjs';
import { WeixinHarnessBridge } from '../src/channels/weixin/weixin-bridge.mjs';
import { WhatsappHarnessBridge } from '../src/channels/whatsapp/whatsapp-bridge.mjs';

const CHANNELS = ['weixin', 'feishu', 'dingtalk', 'wecom', 'qq', 'slack', 'telegram', 'discord', 'whatsapp'];
const TEXT_BRIDGES = {
  slack: SlackHarnessBridge,
  telegram: TelegramHarnessBridge,
  discord: DiscordHarnessBridge,
  whatsapp: WhatsappHarnessBridge,
};
const SESSION_ID = 'history-session';
const MARKERS = [
  'history-user-1', 'history-assistant-1',
  'history-user-2', 'history-assistant-2',
  'history-user-3', 'history-assistant-3',
];

function history() {
  let seq = 0;
  const entry = (type, data, surfaceOp) => ({
    event: { seq: ++seq, time: seq, type, data, ...(surfaceOp ? { surfaceOp } : {}) },
  });
  return {
    hasMore: false,
    events: [1, 2, 3].flatMap((turn) => [
      entry('turn/start', { turn }),
      entry('user/message', {
        turn,
        source: { kind: 'user' },
        content: [{ type: 'text', text: `history-user-${turn}` }],
      }, 'append'),
      entry('assistant/message', {
        turn,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: `history-assistant-${turn}` }] },
      }, 'append'),
      entry('turn/end', { turn, reason: 'completed' }),
    ]),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function within(promise, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(description)), 1_500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Real bridge entrypoints with only the platform transport and Host replaced. */
function fixture(channel, { sessionId = SESSION_ID, ask, readHistory, send } = {}) {
  const sent = [];
  const seen = new Set();
  const calls = { reads: [], asks: [], mutations: [], downloads: [] };
  const key = ['weixin', 'feishu', 'dingtalk'].includes(channel) ? 'p2p:owner'
    : channel === 'qq' ? 'c2c:owner'
      : channel === 'wecom' ? 'direct:owner' : 'direct:chat';
  const sessions = new Map(sessionId ? [[key, sessionId]] : []);
  const forbidden = (name) => async (...args) => {
    calls.mutations.push({ name, args });
    throw new Error(`unexpected ${name}`);
  };
  const state = {
    hasSeen: (id) => seen.has(id),
    markSeen: async (id) => seen.add(id),
    sessionFor: (requestedKey) => sessions.get(requestedKey) ?? null,
    setSession: forbidden('setSession'),
    clearSession: forbidden('clearSession'),
  };
  const harness = {
    sessionExists: async () => true,
    readSessionHistory: async (id, options) => {
      calls.reads.push({ id, options });
      return readHistory ? readHistory(id, options) : history();
    },
    ask: async (id, text, options) => {
      calls.asks.push({ id, text });
      if (!ask) throw new Error('history must not reach the model');
      return ask(id, text, options);
    },
    createSession: forbidden('createSession'),
    ensureRunning: forbidden('ensureRunning'),
    executeCommand: forbidden('executeCommand'),
    stopActiveTurn: forbidden('stopActiveTurn'),
    steerActiveTurn: forbidden('steerActiveTurn'),
    workspaceSession(id) {
      return {
        readHistory: (options) => harness.readSessionHistory(id, options),
        sessionExists: () => harness.sessionExists(id),
        ask: (text, options) => harness.ask(id, text, options),
      };
    },
  };
  const record = async (target, text) => {
    sent.push({ target, text });
    if (send) await send(target, text);
    return { messageId: `out-${sent.length}` };
  };
  const download = async () => {
    calls.downloads.push('download');
    throw new Error('history must not download attachments');
  };
  const options = { harness, state, logger: { warn() {}, error() {} } };
  let bridge;
  let message;
  if (channel === 'weixin') {
    bridge = new WeixinHarnessBridge({
      ...options,
      baseUrl: 'https://ilinkai.weixin.qq.com/', token: 'test-token', ownerUserId: 'owner',
      api: { sendText: ({ toUserId, contextToken, runId, text }) => record({ toUserId, contextToken, runId }, text) },
    });
    message = (id, text, { image = false, file = false, sender = 'owner', echo = false } = {}) => ({
      message_id: id, message_type: echo ? 2 : 1, from_user_id: sender,
      context_token: `context-${id}`, run_id: `run-${id}`,
      item_list: [
        { type: 1, text_item: { text } },
        ...(image ? [{ type: 2, image_item: { media: {} } }] : []),
        ...(file ? [{ type: 4, file_item: { file_name: 'test.txt', media: {} } }] : []),
      ],
    });
  } else if (channel === 'feishu') {
    bridge = new FeishuHarnessBridge({
      ...options,
      channel: {}, status: {}, allowedSenderOpenIds: new Set(['owner']),
      client: { im: { v1: { message: { create: async ({ data }) => {
        await record(data.receive_id, data.msg_type === 'text' ? JSON.parse(data.content).text : data.content);
        return { code: 0, data: { message_id: `out-${sent.length}` } };
      } }, messageResource: { get: download } } } },
    });
    message = (id, text, { image = false, group = false, sender = 'owner', echo = false, post = false, addressed = true } = {}) => ({
      sender: { sender_type: echo ? 'bot' : 'user', sender_id: { open_id: sender } },
      message: {
        message_id: id, message_type: image || post ? 'post' : 'text',
        chat_type: group ? 'group' : 'p2p', chat_id: group ? 'group-chat' : 'chat',
        mentions: group && addressed ? [{ key: '@bot', id: { open_id: 'bot' } }] : [],
        content: JSON.stringify(image || post ? {
          content: [[{ tag: 'text', text }, ...(image ? [{ tag: 'img', image_key: 'image' }] : [])]],
        } : { text }),
      },
    });
  } else if (channel === 'dingtalk') {
    bridge = new DingtalkHarnessBridge({
      ...options, clientId: 'test-client', clientSecret: 'test-secret',
      api: { sendText: ({ sessionWebhook, text }) => record(sessionWebhook, text), downloadImage: download },
    });
    message = (id, text, { image = false, group = false, addressed = true } = {}) => ({
      msgId: id, msgtype: image ? 'richText' : 'text', text: { content: text },
      ...(image ? { content: { richText: [{ type: 'text', text }, { type: 'picture', downloadCode: 'image' }] } } : {}),
      conversationType: group ? '2' : '1', conversationId: group ? 'group-chat' : 'chat',
      senderStaffId: 'owner', isInAtList: addressed,
      sessionWebhook: `https://oapi.dingtalk.com/robot/reply?ticket=${id}`,
    });
  } else if (channel === 'wecom') {
    bridge = new WecomHarnessBridge({
      ...options,
      client: {
        replyStream: async (frame, _streamId, text, finish) => {
          if (finish) return record(frame.body.chattype === 'group' ? frame.body.chatid : frame.body.from.userid, text);
          return undefined;
        },
        replyStreamNonBlocking: async () => {},
        sendMessage: (target, body) => record(target, body.markdown?.content ?? body.text?.content),
        downloadFile: download,
      },
    });
    message = (id, text, { image = false, group = false } = {}) => ({
      headers: { req_id: id },
      body: {
        msgid: id, chattype: group ? 'group' : 'single', chatid: group ? 'group-chat' : 'chat',
        from: { userid: 'owner' }, msgtype: image ? 'mixed' : 'text', text: { content: text },
        ...(image ? { mixed: { msg_item: [
          { msgtype: 'text', text: { content: text } },
          { msgtype: 'image', image: { url: 'https://example.invalid/image' } },
        ] } } : {}),
      },
    });
  } else if (channel === 'qq') {
    bridge = new QqHarnessBridge({ ...options, ownerUserOpenid: 'owner', bot: { sendText: record }, fetchImpl: download });
    message = (id, text, { image = false, file = false, group = false, sender = 'owner', echo = false } = {}) => ({
      messageId: id, senderId: sender, senderIsBot: echo, content: text,
      kind: group ? 'group' : 'c2c', groupOpenid: group ? 'group-chat' : undefined,
      rawEventType: group ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE',
      replyTarget: { scope: group ? 'group' : 'c2c', targetId: group ? 'group-chat' : sender, msgId: id },
      attachments: image || file ? [{ content_type: image ? 'image/png' : 'text/plain', filename: image ? 'test.png' : 'test.txt', url: 'https://example.invalid/attachment' }] : [],
    });
  } else {
    bridge = new TEXT_BRIDGES[channel]({ ...options, bot: { sendText: record } });
    message = (id, text, { image = false, file = false, group = false, echo = false, addressed = true } = {}) => ({
      messageId: id, senderId: 'owner', senderIsBot: echo, content: text,
      kind: group ? 'group' : 'direct', conversationId: group ? 'group-chat' : 'chat', addressed,
      replyTarget: { channel, chat: group ? 'group-chat' : 'chat', messageId: id },
      images: image ? [{ load: download }] : [],
      files: file ? [{ name: 'test.txt', load: download }] : [],
    });
  }
  return { bridge, message, sent, calls, sessions, key, seen };
}

function previewMarkers(sent) {
  return sent.map(({ text }) => text).join('\n').match(/history-(?:user|assistant)-[123]/g) ?? [];
}

for (const channel of CHANNELS) {
  test(`${channel}: /history defaults to 3 and /history 10 clamps to 5 on its existing reply route`, async () => {
    const f = fixture(channel);
    for (const [text, count] of [['/history', 3], ['/history 10', 5]]) {
      f.sent.length = 0;
      const id = `count-${count}`;
      await f.bridge.accept(f.message(id, text));
      assert.deepEqual(previewMarkers(f.sent), MARKERS.slice(-count));
      assert.ok(f.sent.length > 0 && f.sent.length <= 3);
      assert.ok(f.sent.every(({ text: reply }) => reply.length <= 1_800));
      if (channel === 'weixin') {
        assert.deepEqual(f.sent[0].target, { toUserId: 'owner', contextToken: `context-${id}`, runId: `run-${id}` });
      } else if (channel === 'dingtalk') {
        assert.equal(f.sent[0].target, `https://oapi.dingtalk.com/robot/reply?ticket=${id}`);
      } else if (channel === 'feishu') {
        assert.equal(f.sent[0].target, 'chat');
      } else if (channel === 'wecom') {
        assert.equal(f.sent[0].target, 'owner');
      } else {
        assert.deepEqual(f.sent[0].target, f.message(id, text).replyTarget);
      }
    }
    assert.equal(f.calls.reads.length, 2);
    assert.ok(f.calls.reads.every(({ id }) => id === SESSION_ID));
    assert.deepEqual(f.calls.asks, []);
    assert.deepEqual(f.calls.mutations, []);
  });

  test(`${channel}: invalid counts, attachments and missing bindings stay local`, async () => {
    const f = fixture(channel);
    for (const [index, text] of ['/history 0', '/history -1', '/history 1.5', '/history foo', '/history 1 2'].entries()) {
      await f.bridge.accept(f.message(`invalid-${index}`, text));
      assert.match(f.sent.at(-1).text, /用法/);
    }
    await f.bridge.accept(f.message('with-image', '/history', { image: true }));
    assert.match(f.sent.at(-1).text, /文字/);
    // These native envelopes can carry both text and ordinary files. The other
    // adapters have standalone file messages, not a text command plus a file.
    if (['weixin', 'qq', ...Object.keys(TEXT_BRIDGES)].includes(channel)) {
      await f.bridge.accept(f.message('with-file', '/history', { file: true }));
      assert.match(f.sent.at(-1).text, /文字/);
    }
    f.sessions.clear();
    await f.bridge.accept(f.message('unbound', '/history'));
    assert.match(f.sent.at(-1).text, /会话/);
    assert.deepEqual(f.calls, { reads: [], asks: [], mutations: [], downloads: [] });
  });

  test(`${channel}: duplicate history delivery is processed once`, async () => {
    const f = fixture(channel);
    const event = f.message('duplicate', '/history');
    await Promise.all([f.bridge.accept(event), f.bridge.accept(event)]);
    await f.bridge.accept(event);
    assert.equal(f.calls.reads.length, 1);
    assert.deepEqual(previewMarkers(f.sent), MARKERS.slice(-3));
    assert.deepEqual(f.calls.asks, []);
  });

  test(`${channel}: a history read failure is safe and never becomes a model prompt`, async () => {
    const f = fixture(channel, { readHistory: async () => { throw new Error('private-host-history-detail'); } });
    await f.bridge.accept(f.message('failed-read', '/history'));
    assert.equal(f.calls.reads.length, 1);
    assert.match(f.sent.at(-1).text, /无法读取/);
    assert.doesNotMatch(f.sent.at(-1).text, /private-host-history-detail/);
    assert.deepEqual(f.calls.asks, []);
    assert.deepEqual(f.calls.mutations, []);
  });

  test(`${channel}: existing transport failure handling never re-reads history or prompts`, async () => {
    let attempts = 0;
    const f = fixture(channel, { send: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('private-channel-failure-detail');
    } });
    await f.bridge.accept(f.message('failed-delivery', '/history'));
    assert.equal(f.calls.reads.length, 1);
    assert.ok(attempts >= 1);
    assert.doesNotMatch(f.sent.map(({ text }) => text).join('\n'), /private-channel-failure-detail/);
    assert.deepEqual(f.calls.asks, []);
    assert.deepEqual(f.calls.mutations, []);
  });

  test(`${channel}: collecting /batch blocks history without recording it as input`, async () => {
    const f = fixture(channel, { ask: async () => 'batch complete' });
    await f.bridge.accept(f.message('batch', '/batch'));
    await f.bridge.accept(f.message('batch-text', 'the only batch input'));
    await f.bridge.accept(f.message('batch-history', '/history 10'));
    assert.match(f.sent.at(-1).text, /\/send.*\/cancel/);
    assert.deepEqual(f.calls.reads, []);
    await f.bridge.accept(f.message('batch-send', '/send'));
    assert.equal(f.calls.asks.length, 1);
    assert.match(f.calls.asks[0].text, /the only batch input/);
    assert.doesNotMatch(f.calls.asks[0].text, /\/history/);
    assert.deepEqual(f.calls.mutations, []);
  });

  for (const kind of ['running', 'question', 'approval']) {
    test(`${channel}: history bypasses a ${kind} task without answering or stopping it`, async (t) => {
      const ready = deferred();
      const release = deferred();
      const responses = [];
      const f = fixture(channel, { ask: async (sessionId, _text, options) => {
        if (kind !== 'running') {
          await options.onInteraction({
            kind,
            interactionId: `${kind}-history`, rpcId: `${kind}-history`, sessionId,
            payload: kind === 'question'
              ? { type: 'question/requested', sessionId, questions: [{ id: 'answer', question: 'choose an answer' }] }
              : { type: 'approval/requested', sessionId, approvalId: 'approval-history', toolName: 'bash', callId: 'call-history' },
            ...(kind === 'approval' ? { toolCall: { name: 'bash', callId: 'call-history', arguments: '{}' } } : {}),
            respond: async (value) => { responses.push(value); return { accepted: true }; },
          });
        }
        ready.resolve();
        await release.promise;
        return 'original task complete';
      } });
      const processing = f.bridge.accept(f.message('active-task', 'original task'));
      t.after(async () => { release.resolve(); await processing; });
      await within(ready.promise, `${channel} did not begin the ${kind} task`);
      const before = f.sent.length;
      await within(f.bridge.accept(f.message('during-task', '/history 10')), `${channel} history waited for the active task`);
      assert.deepEqual(previewMarkers(f.sent.slice(before)), MARKERS.slice(-5));
      assert.equal(f.calls.reads.length, 1);
      assert.deepEqual(responses, []);
      assert.deepEqual(f.calls.asks.map(({ text }) => text), ['original task']);
      assert.deepEqual(f.calls.mutations, []);
      release.resolve();
      await processing;
    });
  }

  test(`${channel}: /help advertises the same history defaults in both languages`, async () => {
    for (const language of ['zh', 'en']) {
      setImHostLanguage(language);
      try {
        const f = fixture(channel);
        await f.bridge.accept(f.message(`help-${language}`, '/help'));
        const help = f.sent.map(({ text }) => text).join('\n');
        assert.match(help, /\/history.*3.*5/);
        if (language === 'en') assert.doesNotMatch(help, /[\u3400-\u9fff]/u);
        assert.deepEqual(f.calls.reads, []);
        assert.deepEqual(f.calls.asks, []);
      } finally {
        setImHostLanguage('zh');
      }
    }
  });

  if (channel !== 'weixin') {
    test(`${channel}: an accepted group history command refuses before reading any Session`, async () => {
      const f = fixture(channel);
      f.sessions.set('group:group-chat', SESSION_ID);
      await f.bridge.accept(f.message('group-history', '/history', { group: true }));
      assert.match(f.sent.at(-1).text, /私聊/);
      assert.deepEqual(f.calls, { reads: [], asks: [], mutations: [], downloads: [] });
    });
  }

  if (['weixin', 'feishu', 'qq', ...Object.keys(TEXT_BRIDGES)].includes(channel)) {
    test(`${channel}: a bot echo cannot trigger history or a new model request`, async () => {
      const f = fixture(channel);
      await f.bridge.accept(f.message('history-echo', '/history', { echo: true }));
      assert.deepEqual(f.sent, []);
      assert.deepEqual(f.calls, { reads: [], asks: [], mutations: [], downloads: [] });
    });
  }
}

for (const channel of ['weixin', 'feishu', 'qq']) {
  test(`${channel}: the existing owner/allowlist guard still blocks history`, async () => {
    const f = fixture(channel);
    await f.bridge.accept(f.message('denied-history', '/history', { sender: 'untrusted' }));
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.calls, { reads: [], asks: [], mutations: [], downloads: [] });
  });
}

test('Feishu accepts its existing plain post normalization for /history', async () => {
  const f = fixture('feishu');
  await f.bridge.accept(f.message('post-history', '/history 1', { post: true }));
  assert.deepEqual(previewMarkers(f.sent), MARKERS.slice(-1));
  assert.deepEqual(f.calls.asks, []);
});

test('Feishu all-message group mode refuses unmentioned history without prompting', async () => {
  const f = fixture('feishu');
  f.sessions.set('group:group-chat', SESSION_ID);
  await f.bridge.accept(f.message('group-unmentioned-history', '/history', { group: true, addressed: false }));
  assert.match(f.sent.at(-1).text, /私聊/);
  assert.deepEqual(f.calls, { reads: [], asks: [], mutations: [], downloads: [] });
});

test('Feishu mention-only group mode still ignores an unmentioned history command', async () => {
  const f = fixture('feishu');
  f.bridge.setGroupResponseMode('mention');
  await f.bridge.accept(f.message('group-unmentioned-ignored', '/history', { group: true, addressed: false }));
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.calls, { reads: [], asks: [], mutations: [], downloads: [] });
});

test('Slack leading-space history messages normalize into the shared command without prompting', async () => {
  const f = fixture('slack');
  for (const [text, count] of [[' /history', 3], [' /history 10', 5]]) {
    f.sent.length = 0;
    const message = normalizeSlackEvent({
      event_id: `history-leading-space-${count}`,
      team_id: 'team',
      event: {
        type: 'message', channel_type: 'im', channel: 'chat', user: 'owner',
        ts: `1700000000.00${count}`, text,
      },
    }, 'bot');
    assert.equal(message.content, text.trim());
    await f.bridge.accept(message);
    assert.deepEqual(previewMarkers(f.sent), MARKERS.slice(-count));
    assert.deepEqual(f.sent[0].target, message.replyTarget);
  }
  assert.equal(f.calls.reads.length, 2);
  assert.ok(f.calls.reads.every(({ id }) => id === SESSION_ID));
  assert.deepEqual(f.calls.asks, []);
  assert.deepEqual(f.calls.mutations, []);
});
