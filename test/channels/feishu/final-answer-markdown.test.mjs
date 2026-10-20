import assert from 'node:assert/strict';
import test from 'node:test';
import { FeishuHarnessBridge } from '../../../src/channels/feishu/bridge.mjs';

const answer = '### 运营摘要\n\n**重点**与[文档](https://example.com/report)\n\n```js\nconst value = 1;\n```';

async function runAnswer({ failure, thread = false, rejectPost = false, result = answer } = {}) {
  const sent = [];
  const sessions = new Map();
  const seen = new Set();
  let asks = 0;
  const respond = async (request) => {
    sent.push(request);
    if (rejectPost && request.data.msg_type === 'post') {
      return { code: 230099, msg: 'post format rejected' };
    }
    return { code: 0, data: { message_id: `om_answer_${sent.length}` } };
  };
  const channel = failure ? {
    stream: async (_chatId, input) => {
      if (failure === 'finalization') {
        await input.markdown({ setContent: async () => {} });
      }
      throw new Error('streaming mode is closed');
    },
  } : {};
  const status = {};
  const bridge = new FeishuHarnessBridge({
    client: { im: { v1: { message: { reply: respond, create: respond } } } },
    channel,
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      createSession: async () => 'session-markdown',
      ask: async () => { asks += 1; return result; },
    },
    state: {
      hasSeen: (id) => seen.has(id),
      markSeen: async (id) => seen.add(id),
      sessionFor: (key) => sessions.get(key) ?? null,
      setSession: async (key, id) => sessions.set(key, id),
      clearSession: async (key) => sessions.delete(key),
    },
    status,
    allowedSenderOpenIds: new Set(['ou_user']),
    botOpenId: 'ou_bot',
    mentionTopicReply: false,
    stepPush: false,
    logger: { info() {}, warn() {}, error() {} },
  });
  await bridge.accept({
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
    message: {
      message_id: 'om_question',
      message_type: 'text',
      chat_type: thread ? 'group' : 'p2p',
      chat_id: 'oc_chat',
      ...(thread ? { thread_id: 'omt_existing', mentions: [{ id: { open_id: 'ou_bot' } }] } : {}),
      content: JSON.stringify({ text: '只发送最终答案，保留 Markdown' }),
    },
  });
  await bridge.waitForIdle();
  return { sent, asks, status };
}

function markdown(request) {
  return JSON.parse(request.data.content).zh_cn.content
    .flat().filter((element) => element.tag === 'md').map((element) => element.text).join('');
}

for (const failure of [undefined, 'creation', 'finalization']) {
  test(`final-only Feishu answers retain Markdown without a working CardKit stream (${failure ?? 'no stream'})`, async () => {
    const { sent, asks } = await runAnswer({ failure });
    assert.equal(asks, 1, '投递失败不能再次提交模型请求');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].data.msg_type, 'post');
    assert.equal(markdown(sent[0]), answer);
    assert.equal(sent[0].path.message_id, 'om_question');
    assert.notEqual(sent[0].data.reply_in_thread, true);
  });
}

test('final-only Markdown answers remain inside an existing topic', async () => {
  const { sent, asks } = await runAnswer({ thread: true });
  assert.equal(asks, 1);
  assert.equal(sent[0].data.msg_type, 'post');
  assert.equal(sent[0].data.reply_in_thread, true);
});

test('final-only Markdown answers fall back to text when Feishu rejects rich text', async () => {
  const { sent, asks } = await runAnswer({ rejectPost: true });
  assert.equal(asks, 1);
  assert.deepEqual(sent.map((request) => request.data.msg_type), ['post', 'text']);
  assert.equal(JSON.parse(sent[1].data.content).text, answer);
});

test('oversized final-only Markdown answers are delivered completely in bounded posts', async () => {
  const result = Array.from({ length: 800 }, (_, index) => `段落 ${index}：**完整内容**。\n\n`).join('');
  const { sent, asks } = await runAnswer({ result });
  assert.equal(asks, 1);
  assert.ok(sent.length > 1);
  assert.ok(sent.every((request) => request.data.msg_type === 'post'));
  assert.ok(sent.every((request) => Buffer.byteLength(request.data.content) <= 30_000));
  assert.equal(sent.map(markdown).join('').replace(/\n/g, ''), result.replace(/\n/g, ''));
});
