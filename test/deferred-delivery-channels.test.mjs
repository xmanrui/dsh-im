import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../src/channels/feishu/state-store.mjs';
import { WecomStateStore } from '../src/channels/wecom/state-store.mjs';
import { WeixinStateStore } from '../src/channels/weixin/state-store.mjs';
import { QqStateStore } from '../src/channels/qq/state-store.mjs';
import { DingtalkStateStore } from '../src/channels/dingtalk/state-store.mjs';
import { ConversationStateStore } from '../src/channels/shared/conversation-state-store.mjs';
import { FeishuHarnessBridge } from '../src/channels/feishu/bridge.mjs';
import { WecomHarnessBridge } from '../src/channels/wecom/wecom-bridge.mjs';
import { WeixinHarnessBridge } from '../src/channels/weixin/weixin-bridge.mjs';
import { QqHarnessBridge } from '../src/channels/qq/qq-bridge.mjs';
import { DingtalkHarnessBridge } from '../src/channels/dingtalk/dingtalk-bridge.mjs';
import { TelegramHarnessBridge } from '../src/channels/telegram/telegram-bridge.mjs';
import { DiscordHarnessBridge } from '../src/channels/discord/discord-bridge.mjs';
import { SlackHarnessBridge } from '../src/channels/slack/slack-bridge.mjs';
import { WhatsappHarnessBridge } from '../src/channels/whatsapp/whatsapp-bridge.mjs';

const logger = { warn() {}, error() {}, info() {} };
const ANSWER = 'The deferred result is 42.';
const end = { seq: 4, type: 'turn/end', data: { turn: 3, reason: 'completed' } };
const openHistory = [
  { seq: 1, type: 'turn/start', data: { turn: 3 } },
  { seq: 2, type: 'user/message', data: { source: { rpcId: 'im-prompt' } } },
];
const completeHistory = [...openHistory,
  { seq: 3, type: 'assistant/message', data: { turn: 3, step: 0, message: { content: [{ type: 'text', text: ANSWER }] } } }, end];
const textChannels = {
  telegram: [TelegramHarnessBridge, { chatId: '-100', chatType: 'supergroup', replyToMessageId: 123, messageThreadId: 456 }],
  discord: [DiscordHarnessBridge, { channelId: 'discord-thread', replyToMessageId: 'source' }],
  slack: [SlackHarnessBridge, { channelId: 'slack-channel', threadTs: '123.456', recipientUserId: 'owner', recipientTeamId: 'team' }],
  whatsapp: [WhatsappHarnessBridge, { jid: 'owner@s.whatsapp.net', selfChat: true }],
};

function channelFixture(channel, record) {
  if (textChannels[channel]) {
    const [Bridge, target] = textChannels[channel];
    return {
      Store: ConversationStateStore, target,
      create: (options) => new Bridge({ ...options, bot: {
        sendText: async (to, text) => record(to, text),
        sendDelivery: async (to, block) => record(to, block.text),
      } }),
      message: (messageId, content) => ({ messageId, content, senderId: 'owner', senderIsBot: false,
        kind: 'direct', conversationId: 'chat', addressed: true,
        replyTarget: { ...target, ...(channel === 'whatsapp' ? { quoted: { key: { id: 'ephemeral' }, message: { conversation: 'original' } } } : {}) },
      }),
    };
  }
  if (channel === 'feishu') {
    const send = async (request) => {
      record({ chatId: 'chat', replyTo: request.path?.message_id }, JSON.parse(request.data.content).text);
      return { code: 0, data: { message_id: 'out' } };
    };
    return { Store: StateStore, target: { chatId: 'chat', replyTo: 'input' },
      create: (options) => new FeishuHarnessBridge({ ...options, client: { im: { v1: { message: { create: send, reply: send } } } },
        channel: {}, allowedSenderOpenIds: new Set(['owner']), status: { messagesReceived: 0, messagesReplied: 0, messagesRejected: 0 } }),
      message: (id, text) => ({ sender: { sender_type: 'user', sender_id: { open_id: 'owner' } },
        message: { message_id: id, chat_id: 'chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }) } }),
    };
  }
  if (channel === 'wecom') return { Store: WecomStateStore, target: { chatId: 'owner' },
    create: (options) => new WecomHarnessBridge({ ...options, client: {
      replyStream: async (_frame, _id, text) => record({ passive: true }, text),
      replyStreamNonBlocking: async () => {},
      sendMessage: async (chatId, body) => record({ chatId }, body.markdown.content),
    } }),
    message: (id, text) => ({ headers: { req_id: id }, body: { msgid: id, chattype: 'single', from: { userid: 'owner' }, msgtype: 'text', text: { content: text } } }),
  };
  if (channel === 'qq') return { Store: QqStateStore, target: { scope: 'c2c', targetId: 'owner' },
    create: (options) => new QqHarnessBridge({ ...options, ownerUserOpenid: 'owner', bot: { sendText: async (target, text) => record(target, text) } }),
    message: (messageId, content) => ({ kind: 'c2c', rawEventType: 'C2C_MESSAGE_CREATE', senderId: 'owner', senderIsBot: false, messageId, content,
      replyTarget: { scope: 'c2c', targetId: 'owner', msgId: messageId } }),
  };
  if (channel === 'weixin') return { Store: WeixinStateStore, target: { toUserId: 'owner' },
    create: (options) => new WeixinHarnessBridge({ ...options, baseUrl: 'https://ilinkai.weixin.qq.com/', token: 'fixture', ownerUserId: 'owner',
      api: { sendText: async ({ toUserId, text, contextToken }) => {
        if (text === ANSWER) assert.equal(contextToken, 'context-stop', 'deferred result uses the latest persisted recipient context');
        return record({ toUserId }, text);
      } } }),
    message: (id, text) => ({ message_id: id, message_type: 1, from_user_id: 'owner', context_token: `context-${id}`, item_list: [{ type: 1, text_item: { text } }] }),
  };
  return { Store: DingtalkStateStore, target: { type: 'user', userId: 'owner', robotCode: 'client' },
    create: (options) => new DingtalkHarnessBridge({ ...options, clientId: 'client', clientSecret: 'fixture', api: {
      sendText: async ({ text }) => record({ passive: true }, text),
      sendRobotText: async ({ target, text }) => record(target, text),
    } }),
    message: (id, text) => ({ msgId: id, msgtype: 'text', text: { content: text }, conversationType: '1', conversationId: 'chat', senderStaffId: 'owner',
      sessionWebhook: `https://oapi.dingtalk.com/robot/reply?ticket=${id}` }),
  };
}

for (const channel of ['feishu', 'wecom', 'weixin', 'dingtalk', 'qq', ...Object.keys(textChannels)]) {
  test(`${channel}: real message entry tracks timeout, supports scoped stop, resumes after restart and sends once to the original route`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), `dsh-deferred-${channel}-`));
    const path = join(dir, 'state.json');
    const sent = [];
    const f = channelFixture(channel, (target, text) => { sent.push({ target, text }); return { messageId: 'out' }; });
    const stops = [];
    const listeners = [];
    let history = openHistory;
    let asks = 0;
    const harness = {
      sessionExists: async () => true, createSession: async () => 'session',
      ensureRunning: async () => true, stopActiveTurn: async () => false,
      stopDeferredTurn: async (sessionId, identity, options) => { stops.push({ sessionId, identity }); return options.isCurrent(); },
      ask: async () => { asks++; throw Object.assign(new Error('Harness stalled'), { code: 'harness-reply-timeout',
        details: { sessionId: 'session', promptRpcId: 'im-prompt', turn: 3, baselineSeq: 0 } }); },
      rpc: async (method) => { assert.equal(method, 'session.history'); return { events: history, hasMore: false }; },
      watchHarnessEvents: (listener) => { listeners.push(listener); },
    };
    harness.workspaceSession = (sessionId) => ({
      sessionId, sessionExists: harness.sessionExists, ask: harness.ask,
      stopActiveTurn: harness.stopActiveTurn,
      stopDeferredTurn: (identity, options) => harness.stopDeferredTurn(sessionId, identity, options),
    });
    const aborts = [];
    const bridges = [];
    const create = (state) => {
      const abort = new AbortController(); aborts.push(abort);
      const bridge = f.create({ harness, state, signal: abort.signal, logger }); bridges.push(bridge);
      return bridge;
    };
    t.after(async () => { aborts.forEach((a) => a.abort()); await Promise.all(bridges.map((b) => b.waitForIdle())); await rm(dir, { recursive: true, force: true }); });
    const state = await new f.Store(path).load();
    if (channel === 'weixin') await state.bindContextTokens('fixture');
    const bridge = create(state);
    await bridge.accept(f.message('input', 'please compute'));
    await bridge.waitForIdle();
    assert.equal(asks, 1);
    assert.equal(state.deferredEntries().length, 1);
    assert.equal(state.deferredEntries()[0].promptRpcId, 'im-prompt');
    await bridge.accept(f.message('stop', '/stop'));
    await bridge.waitForIdle();
    assert.deepEqual(stops, [{ sessionId: 'session', identity: { turn: 3, promptRpcId: 'im-prompt' } }]);
    aborts[0].abort();
    await bridge.waitForIdle();

    const restored = await new f.Store(path).load();
    if (channel === 'weixin') await restored.bindContextTokens('fixture');
    assert.equal(restored.deferredEntries().length, 1);
    const restarted = create(restored);
    await restarted.waitForIdle();
    assert.equal(sent.filter((row) => row.text === ANSWER).length, 0);
    history = completeHistory;
    await Promise.all([listeners.at(-1).onReconnect(), listeners.at(-1).onSessionEvent({ sessionId: 'session', event: end })]);
    await restarted.waitForIdle();
    const results = sent.filter((row) => row.text === ANSWER);
    assert.deepEqual(results, [{ target: f.target, text: ANSWER }]);
    assert.deepEqual(restored.deferredEntries(), []);
    const reopened = await new f.Store(path).load();
    assert.deepEqual(reopened.deferredEntries(), []);
    assert.equal(asks, 1, 'recovery must not submit the prompt again');
  });
}
