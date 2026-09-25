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

function runBridge({ voice = null, replyThrows = false } = {}) {
  const creates = [];
  const replies = [];
  const uploads = [];
  const streamed = [];
  const asked = [];
  const client = {
    im: { v1: {
      message: {
        create: async (request) => {
          creates.push(request);
          return { code: 0 };
        },
        reply: async (request) => {
          replies.push(request);
          if (replyThrows) throw new Error('reply api unavailable');
          return { code: 0, data: { message_id: 'om_audio_reply' } };
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
    ask: async (sessionId, text, options) => {
      asked.push({ sessionId, text });
      await options.onUpdate({ type: 'text', text: 'Harness' });
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
  });
  return { bridge, creates, replies, uploads, streamed, asked };
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
