import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEphemeralMemoryStore } from '../src/channels/shared/memory-store.mjs';
import { memoryScope } from '../src/channels/shared/memory-turn.mjs';
import { WeixinHarnessBridge } from '../src/channels/weixin/weixin-bridge.mjs';

//
// 大肥鱼真正的用法是在**群里被 @**，不是私聊。群消息走的是
// `uia-wechat-group/v1` 那条形状（source 字段 + conversation_id/reply_target 同值 +
// item_list 与 text 一致），和私聊事件的字段完全不同。
// 这套用例钉住：群消息也确实带着人设与记忆进模型，而不是只有私聊那条路生效。
//
const LOGGER = { info() {}, warn() {}, error() {} };
const SOURCE = 'uia-wechat-group/v1';

/** The canonical open policy: both scopes open, no per-user overrides. */
const OPEN_POLICY = {
  group: {
    mode: 'open',
    open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
    allowlist: { users: [] },
  },
  direct: {
    mode: 'open',
    open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
    allowlist: { users: [] },
  },
};

/** 一条真实形状的群消息事件（字段集照 wechat-group-conversation 的校验来）。 */
function groupEvent(id, text, { senderName = 'uia-unverified:row' } = {}) {
  return {
    source: SOURCE,
    message_id: String(id),
    message_type: 1,
    conversation_type: 'group',
    conversation_id: 'uia_group_room',
    conversation_title: '零食快递洗鞋打扫外卖代写',
    from_user_id: senderName,
    sender_name: senderName,
    reply_target: 'uia_group_room',
    addressed: true,
    text,
    raw_text: text,
    sent_at: 1_700_000_000_000,
    is_self: false,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

function createState() {
  const seen = new Set();
  const sessions = new Map();
  return {
    hasSeen: (id) => seen.has(id),
    markSeen: async (id) => { seen.add(id); },
    sessionFor: (key) => sessions.get(key) ?? null,
    setSession: async (key, id) => { sessions.set(key, id); return true; },
    clearSession: async () => true,
    pendingSenders: () => [],
  };
}

function stubHarness(sent) {
  return {
    currentBusyMessageMode: () => 'queue',
    ensureRunning: async () => {},
    createSession: async () => 'session-group',
    renameSession: async (sessionId, title) => ({ title, seq: 0 }),
    sessionExists: async () => true,
    hasActiveTurn: async () => false,
    isSessionRunning: async () => false,
    currentWorkspace: () => null,
    ask: async (_sessionId, content) => { sent.push(content); return '在'; },
  };
}

test('群消息也吃人设与记忆：@ 大肥鱼 的那条路同样带 personaGuidance 与记忆块', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-group-memory-'));
  const store = createEphemeralMemoryStore(join(dir, 'memory'), { logger: LOGGER });
  try {
    const state = createState();
    const prompts = [];
    const sentTexts = [];
    const asked = [];
    const harness = stubHarness(prompts);
    // Record the ask options so personaGuidance can be asserted directly.
    const realAsk = harness.ask;
    harness.ask = async (sessionId, content, options) => {
      asked.push(options);
      return realAsk(sessionId, content, options);
    };
    const bridge = new WeixinHarnessBridge({
      api: {
        sendText: async ({ text }) => { sentTexts.push(text); return { messageId: 'r' + sentTexts.length }; },
      },
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'private-token',
      ownerUserId: 'actor',
      harness,
      state,
      logger: LOGGER,
      // A group sender is never the owner, so the legacy fallback would deny it.
      // A real deployment carries an explicit policy; this is the canonical open
      // shape the access-policy module accepts.
      accessPolicy: { getSettings: () => OPEN_POLICY },
      persona: { get: () => ({ name: '大肥鱼', personality: '嘴贫但心不坏' }) },
      memory: store,
      // The group id must match the bot id the scope is built from.
      botId: 'wx_demo',
    });
    await bridge.accept(groupEvent(1, '@大肥鱼 我喜欢喝手冲咖啡'));
    // The write is fire-and-forget by design; yield so this test observes the
    // eventual state rather than racing it (production reads on a later message).
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(prompts.length, 1,
      '群消息必须进模型; status=' + JSON.stringify(bridge.status));
    // 人设：走带外发布，不进用户消息。
    assert.ok(typeof asked[0].personaGuidance === 'string');
    assert.match(asked[0].personaGuidance, /嘴贫但心不坏/u);
    assert.equal(JSON.stringify(prompts[0]).includes('嘴贫但心不坏'), false, '人设不得进入用户 prompt');
    // 记忆：第二条群消息应当带着上一条抽出来的事实。
    console.log('SCOPE_ROW', (await store.stats(memoryScope({ channel: 'weixin', botId: 'wx_demo', conversationKey: 'group:uia_group_room' }))).facts);
    // Recall is keyword-based: the second message has to share a word with the
    // first, exactly as a real conversation about coffee would.
    await bridge.accept(groupEvent(2, '@大肥鱼 咖啡豆哪种好'));
    const second = prompts[1];
    const text = typeof second === 'string' ? second : JSON.stringify(second);
    assert.match(text, /dsh_im_context/u, '记忆块必须以注入上下文的形式出现');
    assert.match(text, /咖啡/u, '上一条说的喜好必须被召回');
    // 没署名也不许把占位符写进提示。
    assert.equal(text.includes('uia-unverified'), false);
    // Store really got the fact, in the group scope.
    // conversationKey() prefixes a group key with 'group:', and the memory scope
    // is built from that key -- so the assertion has to use the same shape,
    // otherwise it checks a scope nothing ever writes to.
    const scope = memoryScope({ channel: 'weixin', botId: 'wx_demo', conversationKey: 'group:uia_group_room' });
    assert.ok(await store.stats(scope), '群 scope 必须存在');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});