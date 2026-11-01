import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEphemeralMemoryStore } from '../src/channels/shared/memory-store.mjs';
import { memoryScope } from '../src/channels/shared/memory-turn.mjs';
import { WeixinHarnessBridge } from '../src/channels/weixin/weixin-bridge.mjs';

//
// 机器人只听得见 @ 它的那几句，就永远不会知道群里在聊什么 ——
// 而「记得这个群」大半就是这件事。
// 观察模式给了记忆，但**一个字节的回答权都没有**：这条用例钉的就是这个边界。
//
const LOGGER = { info() {}, warn() {}, error() {} };
const SOURCE = 'uia-wechat-group/v1';

function row(text, { addressed = false } = {}) {
  return {
    source: SOURCE,
    message_id: 'm-' + text,
    message_type: 1,
    conversation_type: 'group',
    conversation_id: 'uia_group_room',
    conversation_title: '群',
    from_user_id: 'uia-unverified:row',
    sender_name: 'uia-unverified:row',
    reply_target: 'uia_group_room',
    addressed,
    text,
    raw_text: text,
    sent_at: 1_700_000_000_000,
    is_self: false,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

function build(sent, asked) {
  const harness = {
    currentBusyMessageMode: () => 'queue',
    ensureRunning: async () => {},
    createSession: async () => 's',
    renameSession: async (id, title) => ({ title, seq: 0 }),
    sessionExists: async () => true,
    hasActiveTurn: async () => false,
    isSessionRunning: async () => false,
    currentWorkspace: () => null,
    ask: async (_id, content) => { asked.push(content); return '在'; },
  };
  return { harness, sent, asked };
}

test('观察到的消息进记忆，但一次都不回答', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-observe-'));
  const store = createEphemeralMemoryStore(join(dir, 'memory'), { logger: LOGGER });
  const sent = [];
  const asked = [];
  const { harness } = build(sent, asked);
  const backend = {
    api: { sendText: async ({ text }) => { sent.push(text); return { messageId: String(sent.length) }; } },
    baseUrl: 'https://ilinkai.weixin.qq.com',
    token: 't',
    ownerUserId: 'actor',
    harness,
    state: { hasSeen: () => false, markSeen: async () => {}, sessionFor: () => null, setSession: async () => true, clearSession: async () => true, pendingSenders: () => [] },
    logger: LOGGER,
    botId: 'wx_demo',
    memory: store,
  };
  const bridge = new WeixinHarnessBridge(backend);
  try {
    await bridge.observe(row('我喜欢喝手冲咖啡'));
    // 没有回答、没有提问、没有发送。
    assert.deepEqual(asked, []);
    assert.deepEqual(sent, []);
    // 但记忆里有了。
    // The bridge derives 'group:' + chatId and the encoder escapes the colon, so the
    // assertion has to build the scope the same way rather than guess its spelling.
    const scope = memoryScope({ channel: 'weixin', botId: 'wx_demo', conversationKey: 'group:uia_group_room' });
    const stats = await store.stats(scope);
    assert.equal(stats.activeFacts, 1, '观察到的内容必须进记忆');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('观察路径遇到坏输入不抛错，更不会回答', async () => {
  const asked = [];
  const sent = [];
  const { harness } = build(sent, asked);
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async () => { sent.push('x'); return {}; } },
    baseUrl: 'https://ilinkai.weixin.qq.com',
    token: 't',
    ownerUserId: 'actor',
    harness,
    state: { hasSeen: () => false, markSeen: async () => {}, sessionFor: () => null, setSession: async () => true, clearSession: async () => true, pendingSenders: () => [] },
    logger: LOGGER,
    botId: 'wx_demo',
  });
  await bridge.observe(null);
  await bridge.observe({});
  await bridge.observe(row('我喜欢茶'));
  assert.deepEqual(asked, []);
  assert.deepEqual(sent, []);
});
