import assert from 'node:assert/strict';
import test from 'node:test';
import { QqHarnessBridge } from '../../../src/channels/qq/qq-bridge.mjs';
import { FeishuHarnessBridge } from '../../../src/channels/feishu/bridge.mjs';
import { WeixinHarnessBridge } from '../../../src/channels/weixin/weixin-bridge.mjs';
import { WecomHarnessBridge } from '../../../src/channels/wecom/wecom-bridge.mjs';
import { WecomAppBridge } from '../../../src/channels/wecom-app/wecom-app-bridge.mjs';
import { DingtalkHarnessBridge } from '../../../src/channels/dingtalk/dingtalk-bridge.mjs';

const shared = Object.fromEntries(await Promise.all([
  ['slack', 'Slack'], ['telegram', 'Telegram'], ['discord', 'Discord'],
  ['whatsapp', 'Whatsapp'], ['imessage', 'IMessage'], ['email', 'Email'], ['matrix', 'Matrix'],
].map(async ([channel, name]) => [channel,
  (await import(`../../../src/channels/${channel}/${channel}-bridge.mjs`))[`${name}HarnessBridge`]])));
const channels = [...Object.keys(shared), 'qq', 'feishu', 'weixin', 'wecom', 'wecom-app', 'dingtalk'];
const logger = { info() {}, warn() {}, error() {} };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
async function eventually(predicate) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.fail('expected bridge action was not reached');
}
function fixture(channel, { mode = 'queue', canCommand = true } = {}) {
  const sessions = new Map();
  const seen = new Set();
  const asks = [];
  const steers = [];
  const replies = [];
  const active = new Map();
  const status = { messagesReceived: 0, messagesReplied: 0, messagesRejected: 0 };
  const first = deferred();
  let failSteer = false;
  let refuseSteer = false;
  let failReceipt = false;
  const state = {
    sessionFor: (key) => sessions.get(key),
    setSession: async (key, id) => { sessions.set(key, id); },
    clearSession: async (key) => { sessions.delete(key); },
    hasSeen: (id) => seen.has(id), markSeen: async (id) => { seen.add(id); },
    unmarkSeen: async (id) => seen.delete(id), pendingSenders: () => [],
  };
  const harness = {
    currentBusyMessageMode: () => mode,
    ensureRunning: async () => {}, currentWorkspace: () => null,
    createSession: async () => `session-${sessions.size + 1}`,
    sessionExists: async () => true, hasActiveTurn: async () => active.size > 0,
    isSessionRunning: async () => active.size > 0,
    workspaceSession: (id) => ({
      sessionExists: async () => true,
      hasActiveTurn: async () => active.has(id),
      isRunning: async () => active.has(id),
      ask: async (text, options) => {
        asks.push({ id, text, options });
        active.set(id, options.control);
        if (asks.length === 1) await first.promise;
        active.delete(id);
        return 'answer';
      },
      steerActiveTurn: async (text, control) => {
        const owner = active.get(id);
        if (!owner || owner.owner !== control.owner || owner.key !== control.key || refuseSteer) return false;
        steers.push({ id, text, control });
        if (failSteer) throw new Error('submission result uncertain');
        return true;
      },
    }),
  };
  const sendText = async (...args) => {
    const serialized = JSON.stringify(args);
    if (failReceipt && serialized.includes('已提交补充指令')) throw new Error('receipt failed');
    replies.push(serialized);
    return { messageId: 'reply', message_id: 'reply', id: 'reply' };
  };
  const scope = { mode: 'open', open: { defaultCanExecuteCommands: canCommand, commandPermissionOverrides: [] }, allowlist: { users: [] } };
  const accessPolicy = { getSettings: () => ({ direct: scope, group: scope }) };
  const contextEnhancement = { botId: 'test-bot', getSettings: () => ({
    direct: { enabled: true, fields: ['channel', 'senderId'], guidance: '' },
    group: { enabled: true, fields: ['channel', 'senderId'], guidance: '' },
  }) };
  const options = { harness, state, status, logger, accessPolicy, contextEnhancement };
  let bridge;
  if (shared[channel]) bridge = new shared[channel]({ ...options, bot: { sendText } });
  if (channel === 'qq') bridge = new QqHarnessBridge({ ...options, ownerUserOpenid: '*', bot: { sendText } });
  if (channel === 'weixin') bridge = new WeixinHarnessBridge({ ...options, ownerUserId: 'actor',
    baseUrl: 'https://ilinkai.weixin.qq.com', token: 'fixture', api: { sendText,
      inboundImages: () => [], inboundFiles: () => [] } });
  if (channel === 'wecom') bridge = new WecomHarnessBridge({ ...options,
    client: { sendMessage: sendText, replyStream: sendText }, generateStreamId: () => 'stream' });
  if (channel === 'wecom-app') bridge = new WecomAppBridge({ ...options, api: { sendText } });
  if (channel === 'dingtalk') bridge = new DingtalkHarnessBridge({ ...options,
    clientId: 'fixture', clientSecret: 'fixture', api: { sendText } });
  if (channel === 'feishu') bridge = new FeishuHarnessBridge({ ...options,
    allowedSenderOpenIds: new Set(['*']), interactionCards: false, mentionTopicReply: false,
    channel: {}, client: { im: { v1: { message: { create: async (request) => {
      await sendText(request); return { code: 0, data: { message_id: 'reply' } };
    } } } } } });
  function message(id, text, { actor = 'actor', group = false } = {}) {
    if (shared[channel]) return { messageId: id, content: text, senderId: actor, kind: group ? 'group' : 'direct',
      conversationId: 'chat', addressed: true, plainText: true, replyTarget: { id } };
    if (channel === 'qq') return { messageId: id, content: text, senderId: actor, kind: group ? 'group' : 'c2c',
      rawEventType: group ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE', groupOpenid: 'chat',
      replyTarget: { scope: group ? 'group' : 'c2c', targetId: group ? 'chat' : actor, msgId: id } };
    if (channel === 'weixin') return { message_id: id, message_type: 1, from_user_id: actor, context_token: 'context',
      item_list: [{ type: 1, text_item: { text } }] };
    if (channel === 'wecom') return { headers: { req_id: id }, body: { msgid: id, from: { userid: actor },
      chattype: group ? 'group' : 'single', chatid: 'chat', msgtype: 'text', text: { content: text } } };
    if (channel === 'wecom-app') return { msgid: id, from: { userid: actor }, msgtype: 'text', text: { content: text } };
    if (channel === 'dingtalk') return { msgId: id, msgtype: 'text', text: { content: text }, senderStaffId: actor,
      conversationType: group ? '2' : '1', conversationId: 'chat', isInAtList: true,
      sessionWebhook: 'https://oapi.dingtalk.com/robot/reply?ticket=test' };
    return { sender: { sender_type: 'user', sender_id: { open_id: actor } }, message: {
      message_id: id, message_type: 'text', chat_type: group ? 'group' : 'p2p', chat_id: 'chat',
      content: JSON.stringify({ text }), mentions: group ? [{ key: '@bot', id: { open_id: 'bot' } }] : [],
    } };
  }
  return { bridge, harness, state, sessions, asks, steers, replies, status, first, message,
    mode: (value) => { mode = value; }, failSteer: () => { failSteer = true; },
    refuseSteer: () => { refuseSteer = true; }, failReceipt: () => { failReceipt = true; } };
}

for (const channel of channels) {
  test(`${channel}: live steering retains sender, skips queue, deduplicates and preserves commands`, async (t) => {
    const f = fixture(channel, { mode: 'steer' });
    t.after(() => f.first.resolve());
    const group = !['weixin', 'wecom-app'].includes(channel);
    const first = f.bridge.accept(f.message('one', 'long task', { group }));
    await eventually(() => f.asks.length === 1);
    const correction = f.message('two', 'correct the task', { group, actor: group ? 'second-actor' : 'actor' });
    await f.bridge.accept(correction);
    await f.bridge.accept(correction);
    assert.equal(f.asks.length, 1);
    assert.equal(f.steers.length, 1);
    assert.match(f.steers[0].text, /correct the task/);
    assert.match(f.steers[0].text, new RegExp(`"senderId":"${group ? 'second-actor' : 'actor'}"`));
    assert.equal(
      f.replies.some((text) => text.includes('已提交补充指令')),
      channel !== 'weixin',
    );
    await f.bridge.accept(f.message('version', '/version', { group }));
    assert.equal(f.steers.length, 1);
    await f.bridge.accept(f.message('clear', '/clear', { group }));
    assert.equal(f.steers.length, 1, '/clear remains a local command in steer mode');
    assert.equal(f.asks.length, 1);
    assert.ok(f.replies.some((text) => text.includes('当前会话正在生成回复或等待交互')));
    await f.bridge.accept(f.message('unknown', '/unknown user text', { group }));
    assert.equal(f.steers.length, 2);
    f.first.resolve();
    await first;
    await f.bridge.waitForIdle();
    assert.equal(f.asks.length, 1);
    assert.equal(f.status.messagesReceived, 5);
  });
  test(`${channel}: queue is default, mode changes leave queued input intact, manual steer still works`, async (t) => {
    const f = fixture(channel);
    t.after(() => f.first.resolve());
    const first = f.bridge.accept(f.message('one', 'long task'));
    await eventually(() => f.asks.length === 1);
    const queued = f.bridge.accept(f.message('two', 'next task'));
    await eventually(() => f.replies.some((text) => text.includes('已排队')));
    assert.equal(f.asks.length, 1);
    assert.equal(f.steers.length, 0);
    await f.bridge.accept(f.message('manual', '/steer correction'));
    assert.equal(f.steers.length, 1);
    f.mode('steer');
    await f.bridge.accept(f.message('three', 'automatic correction'));
    assert.equal(f.steers.length, 2);
    f.first.resolve();
    await Promise.all([first, queued]);
    assert.equal(f.asks.length, 2);
    assert.match(f.asks[1].text, /next task/);
  });
  test(`${channel}: ordinary chat permission cannot gain steer control`, async (t) => {
    const f = fixture(channel, { mode: 'steer', canCommand: false });
    t.after(() => f.first.resolve());
    const first = f.bridge.accept(f.message('one', 'long task'));
    await eventually(() => f.asks.length === 1);
    const next = f.bridge.accept(f.message('two', 'ordinary followup'));
    await eventually(() => f.replies.some((text) => text.includes('已排队')));
    assert.equal(f.steers.length, 0);
    f.first.resolve();
    await Promise.all([first, next]);
    assert.equal(f.asks.length, 2);
  });
  for (const outcome of ['refuseSteer', 'failSteer', 'failReceipt']) {
    test(`${channel}: ${outcome} preserves exactly one message path`, async (t) => {
      const f = fixture(channel, { mode: 'steer' });
      t.after(() => f.first.resolve());
      const first = f.bridge.accept(f.message('one', 'long task'));
      await eventually(() => f.asks.length === 1);
      f[outcome]();
      const next = f.bridge.accept(f.message('two', 'followup'));
      if (outcome === 'refuseSteer') await eventually(() => f.replies.some((text) => text.includes('已排队')));
      else await next;
      assert.equal(f.asks.length, 1);
      f.first.resolve();
      await Promise.all([first, next]);
      await f.bridge.accept(f.message('two', 'followup'));
      assert.equal(f.asks.length, outcome === 'refuseSteer' ? 2 : 1);
      assert.equal(f.status.messagesReceived, 2);
    });
  }
}
