import assert from 'node:assert/strict';
import test from 'node:test';
import { FeishuHarnessBridge } from '../../../src/channels/feishu/bridge.mjs';

// 桥接层的语音回合(渠道能力):音频消息经转写进入正常文字流水线,
// 完整答案投递后追加音频回复;转写失败走"仅支持文字/图片/文件"的明确降级。
function audioEvent(messageId, fileKey) {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
    message: {
      message_id: messageId,
      message_type: 'audio',
      chat_type: 'p2p',
      chat_id: 'oc_chat',
      content: JSON.stringify({ file_key: fileKey }),
    },
  };
}

function textEvent(messageId, text) {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
    message: {
      message_id: messageId,
      message_type: 'text',
      chat_type: 'p2p',
      chat_id: 'oc_chat',
      content: JSON.stringify({ text }),
    },
  };
}

function stateFixture() {
  const sessions = new Map();
  const seen = new Set();
  return {
    sessions,
    seen,
    state: {
      hasSeen: (id) => seen.has(id),
      markSeen: async (id) => seen.add(id),
      sessionFor: (key) => sessions.get(key) ?? null,
      setSession: async (key, sessionId) => sessions.set(key, sessionId),
      clearSession: async (key) => sessions.delete(key),
    },
  };
}

function statusFixture() {
  return {
    messagesReceived: 0,
    messagesReplied: 0,
    messagesRejected: 0,
    lastMessageAt: null,
    lastReplyAt: null,
    lastRejectedAt: null,
    lastError: null,
  };
}

function fakeVoice(transcript) {
  const instance = {
    enabled: true,
    transcripts: [],
    syntheses: [],
    transcribeIncoming: async (event) => {
      instance.transcripts.push(event.message.message_id);
      return transcript;
    },
    synthesize: async (text) => {
      instance.syntheses.push(text);
      return Buffer.from('opus-bytes');
    },
  };
  return instance;
}

function runBridge({
  voice = null,
  replyThrows = false,
  stepPush = false,
  stepPushMode,
  stepPushClock,
  askUpdates = [{ type: 'text', text: 'Harness' }],
} = {}) {
  const creates = [];
  const replies = [];
  const uploads = [];
  const patches = [];
  const streamed = [];
  const asked = [];
  const client = {
    im: { v1: {
      message: {
        create: async (request) => {
          creates.push(request);
          return { code: 0, data: { message_id: 'om_created' } };
        },
        reply: async (request) => {
          replies.push(request);
          if (replyThrows) throw new Error('reply api unavailable');
          return { code: 0, data: { message_id: 'om_audio_reply' } };
        },
        patch: async (request) => {
          patches.push(request);
          return { code: 0 };
        },
      },
      file: { create: async (request) => {
        uploads.push(request);
        return { code: 0, data: { file_key: 'file_key_voice' } };
      } },
    } },
  };
  const channel = {
    addReaction: async () => 'reaction-id',
    removeReaction: async () => {},
    stream: async (chatId, input, options) => {
      const updates = [];
      await input.markdown({
        setContent: async (content) => updates.push(content),
      });
      streamed.push({ chatId, options, updates });
      return { messageId: 'om_reply' };
    },
  };
  const harness = {
    ensureRunning: async () => true,
    createSession: async () => 'session-test',
    sessionExists: async () => true,
    ask: async (sessionId, text, options) => {
      asked.push({ sessionId, text });
      for (const update of askUpdates) await options.onUpdate(update);
      return 'Harness reply';
    },
  };
  const fixture = stateFixture();
  const bridge = new FeishuHarnessBridge({
    client,
    channel,
    harness,
    state: fixture.state,
    status: statusFixture(),
    allowedSenderOpenIds: new Set(['ou_user']),
    voice,
    stepPush,
    stepPushMode,
    stepPushClock,
  });
  return { bridge, creates, replies, uploads, patches, streamed, asked };
}

test('voice transcripts an audio message into the normal pipeline and replies with audio', async () => {
  const voice = fakeVoice('请讲个故事');
  const { bridge, creates, replies, uploads, streamed, asked } = runBridge({ voice });

  bridge.accept(audioEvent('om_voice_1', 'file_key_1'));
  await bridge.waitForIdle();

  assert.deepEqual(asked, [{ sessionId: 'session-test', text: '请讲个故事' }]);
  assert.deepEqual(voice.transcripts, ['om_voice_1']);
  assert.deepEqual(streamed, [{
    chatId: 'oc_chat',
    options: { replyTo: 'om_voice_1' },
    updates: ['Harness', 'Harness reply'],
  }]);
  assert.deepEqual(voice.syntheses, ['Harness reply']);
  assert.equal(creates.length, 0);
  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0].data, {
    file_type: 'opus',
    file_name: 'dsh-im-voice-reply.opus',
    file: Buffer.from('opus-bytes'),
  });
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0].path, { message_id: 'om_voice_1' });
  assert.deepEqual(replies[0].data, {
    msg_type: 'audio',
    content: JSON.stringify({ file_key: 'file_key_voice' }),
  });
});

test('a failed transcription keeps the explicit text fallback and no voice reply', async () => {
  const voice = fakeVoice(null);
  const { bridge, creates, replies, uploads, asked } = runBridge({ voice });

  bridge.accept(audioEvent('om_voice_2', 'file_key_2'));
  await bridge.waitForIdle();

  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0].path, { message_id: 'om_voice_2' });
  assert.equal(replies[0].data.msg_type, 'text');
  assert.match(JSON.parse(replies[0].data.content).text, /目前支持文字/);
  assert.equal(asked.length, 0);
  assert.equal(creates.length, 0);
  assert.equal(uploads.length, 0);
});

test('voice disabled keeps the original text/image/file fallback for audio messages', async () => {
  const { bridge, creates, replies, uploads, asked } = runBridge({ voice: null });

  bridge.accept(audioEvent('om_voice_3', 'file_key_3'));
  await bridge.waitForIdle();

  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0].path, { message_id: 'om_voice_3' });
  assert.equal(replies[0].data.msg_type, 'text');
  assert.match(JSON.parse(replies[0].data.content).text, /目前支持文字/);
  assert.equal(asked.length, 0);
  assert.equal(creates.length, 0);
  assert.equal(uploads.length, 0);
});

test('audio reply falls back to a plain audio message when the reply API fails', async () => {
  const voice = fakeVoice('请讲个故事');
  const { bridge, creates, uploads, replies } = runBridge({ voice, replyThrows: true });

  bridge.accept(audioEvent('om_voice_4', 'file_key_4'));
  await bridge.waitForIdle();

  assert.equal(replies.length, 1);
  assert.equal(uploads.length, 1);
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].params, { receive_id_type: 'chat_id' });
  assert.deepEqual(creates[0].data, {
    receive_id: 'oc_chat',
    msg_type: 'audio',
    content: JSON.stringify({ file_key: 'file_key_voice' }),
  });
});

test('a voice transcript handled as a command leaves no voice turn for later messages', async () => {
  const voice = fakeVoice('/help');
  const { bridge, creates, uploads, asked, streamed } = runBridge({ voice });

  bridge.accept(audioEvent('om_voice_help', 'file_key_help'));
  await bridge.waitForIdle();

  // /help 分支提前返回:本回合不产生音频回复(命令类回复不触发语音)。
  assert.equal(voice.syntheses.length, 0);
  assert.equal(uploads.length, 0);
  assert.equal(asked.length, 0);

  bridge.accept(textEvent('om_text_after', '请讲个故事'));
  await bridge.waitForIdle();

  // 修复前:上一回合遗留的语音状态会让这条普通文字的答案被合成为音频,
  // 并回复到已经结束的语音消息上。
  assert.deepEqual(asked, [{ sessionId: 'session-test', text: '请讲个故事' }]);
  assert.deepEqual(voice.syntheses, []);
  assert.equal(uploads.length, 0);
  assert.equal(streamed.length, 1);
  assert.equal(creates.filter((request) => request.data?.msg_type === 'audio').length, 0);
});

test('consecutive voice turns in the same chat each voice their own answer', async () => {
  const voice = fakeVoice('第一个问题');
  const { bridge, replies, uploads } = runBridge({ voice });

  bridge.accept(audioEvent('om_voice_a', 'file_key_a'));
  await bridge.waitForIdle();
  bridge.accept(audioEvent('om_voice_b', 'file_key_b'));
  await bridge.waitForIdle();

  // 回合状态随各自消息处理结束清理,后一回合不得沿用或覆盖前一回合,
  // 音频回复必须各自回到发起语音的那条消息上。
  assert.deepEqual(voice.syntheses, ['Harness reply', 'Harness reply']);
  assert.equal(uploads.length, 2);
  assert.deepEqual(replies.map((reply) => reply.path.message_id), ['om_voice_a', 'om_voice_b']);
});

test('a voice turn answered via streaming step card still gets its audio reply', async () => {
  const voice = fakeVoice('请讲个故事');
  const { bridge, patches, replies, uploads, asked } = runBridge({
    voice,
    stepPush: true,
    stepPushMode: 'streaming_card',
    stepPushClock: { now: () => Date.now(), delay: async () => {} },
    askUpdates: [{ type: 'tool', name: 'search', arguments: { q: '测试' } }],
  });

  bridge.accept(audioEvent('om_voice_card', 'file_key_card'));
  await bridge.waitForIdle();

  // 前提:答案确实走流式卡封存路径(卡消息已投递且密封时重绘过),
  // 而不是悄悄回退到 post/纯文本阶梯——否则本测试测不到目标分支。
  assert.ok(replies.some((reply) => reply.data?.msg_type === 'interactive'));
  assert.ok(patches.length >= 1);
  assert.deepEqual(asked, [{ sessionId: 'session-test', text: '请讲个故事' }]);

  // 修复前:卡封存成功分支提前 return,语音回合未被消费,音频哑火且
  // 状态泄漏到下一回合。修复后:合成、上传、音频回复原语音消息。
  assert.deepEqual(voice.syntheses, ['Harness reply']);
  assert.equal(uploads.length, 1);
  const audioReplies = replies.filter((reply) => reply.data?.msg_type === 'audio');
  assert.equal(audioReplies.length, 1);
  assert.deepEqual(audioReplies[0].path, { message_id: 'om_voice_card' });
  assert.deepEqual(audioReplies[0].data, {
    msg_type: 'audio',
    content: JSON.stringify({ file_key: 'file_key_voice' }),
  });
});
