import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createWecomBridgeStatus,
  sendWecomImage,
  WecomHarnessBridge,
  wecomInboundMessage,
} from '../../../src/channels/wecom/wecom-bridge.mjs';
import { DEFAULT_IMAGE_PROMPT } from '../../../src/channels/shared/image-prompt.mjs';
import { connectionTestTarget } from '../../../src/channels/shared/connection-test.mjs';
import {
  OUTBOUND_ARTIFACT_TOOL,
  OutboundArtifactRegistry,
  createOutboundArtifactTool,
} from '../../../src/channels/shared/semantic/artifact.mjs';
import {
  COMMAND_PERMISSION_DENIED_MESSAGE,
  directAccessPolicy,
} from '../access-policy-fixture.mjs';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const INITIAL_THINKING_TEXT = '正在思考中…';
const INITIAL_THINKING_STREAM = `<think>${INITIAL_THINKING_TEXT}`;

function streamPreview(answer, thinking = INITIAL_THINKING_TEXT) {
  return `<think>${thinking}</think>\n${answer}`;
}

test('Enterprise WeChat native image adapter uploads and sends an image media message', async () => {
  const calls = [];
  const result = { body: { msgid: 'wecom-image-1', errcode: 0 } };
  const file = {
    artifactId: 'image-artifact',
    deliveryKey: 'image-delivery',
    fileName: 'diagram.png',
    mediaType: 'image/png',
    bytes: PNG_1X1,
  };
  const returned = await sendWecomImage({
    uploadMedia: async (bytes, options) => {
      calls.push({ operation: 'upload', bytes: Buffer.from(bytes), options });
      return { media_id: 'image-media-1' };
    },
    sendMediaMessage: async (chatId, type, mediaId) => {
      calls.push({ operation: 'send', chatId, type, mediaId });
      return result;
    },
  }, 'chat-1', file);

  assert.equal(returned, result);
  assert.deepEqual(calls, [{
    operation: 'upload',
    bytes: PNG_1X1,
    options: { type: 'image', filename: 'diagram.png' },
  }, {
    operation: 'send',
    chatId: 'chat-1',
    type: 'image',
    mediaId: 'image-media-1',
  }]);
});

test('Enterprise WeChat native image adapter preserves definite upload errors', async () => {
  let sends = 0;
  await assert.rejects(sendWecomImage({
    uploadMedia: async () => {
      const error = new Error('forbidden');
      error.httpStatus = 403;
      throw error;
    },
    sendMediaMessage: async () => { sends += 1; },
  }, 'chat-1', {
    fileName: 'diagram.png',
    bytes: PNG_1X1,
  }), (error) => error.code === 'artifact-permission-required');
  assert.equal(sends, 0);
});

test('Enterprise WeChat native image adapter marks an unacknowledged message as uncertain', async () => {
  await assert.rejects(sendWecomImage({
    uploadMedia: async () => ({ media_id: 'image-media-uncertain' }),
    sendMediaMessage: async () => new Promise(() => {}),
  }, 'chat-1', {
    fileName: 'diagram.png',
    bytes: PNG_1X1,
  }, { timeoutMs: 20 }), (error) => error.code === 'artifact-delivery-uncertain');
});

test('Enterprise WeChat sends an image artifact as a native image message', async (t) => {
  const artifact = await committedArtifact(t, 'native.png', PNG_1X1, 'native-image');
  const uploads = [];
  const messages = [];
  const bridge = new WecomHarnessBridge({
    client: {
      replyStream: async (_source, _streamId, _content, finish) => (
        finish ? { body: { msgid: 'wecom-text' } } : undefined
      ),
      replyStreamNonBlocking: async () => {},
      sendMessage: async () => {},
      uploadMedia: async (bytes, options) => {
        uploads.push({ bytes: Buffer.from(bytes), options });
        return { media_id: 'native-image-media' };
      },
      sendMediaMessage: async (chatId, type, mediaId) => {
        messages.push({ chatId, type, mediaId });
        return { body: { msgid: 'wecom-image', errcode: 0 } };
      },
    },
    generateStreamId: () => 'native-image-stream',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '图片已生成。';
      },
    },
    state: state(),
  });

  const receipt = await bridge.accept(frame({ msgid: 'wecom-native-image' }));

  assert.deepEqual(uploads, [{
    bytes: PNG_1X1,
    options: { type: 'image', filename: 'native.png' },
  }]);
  assert.deepEqual(messages, [{
    chatId: 'member-1',
    type: 'image',
    mediaId: 'native-image-media',
  }]);
  assert.equal(receipt.artifacts[0].artifactId, artifact.artifactId);
  assert.equal(receipt.artifacts[0].outcome, 'sent');
  assert.equal(receipt.providerMessageIds.includes('wecom-image'), true);
});

test('Enterprise WeChat falls back to a file after a definite native-image rejection', async (t) => {
  const artifact = await committedArtifact(t, 'fallback.png', PNG_1X1, 'image-fallback');
  const uploads = [];
  const messages = [];
  const bridge = new WecomHarnessBridge({
    client: {
      replyStream: async () => {},
      replyStreamNonBlocking: async () => {},
      sendMessage: async () => {},
      uploadMedia: async (_bytes, options) => {
        uploads.push(options.type);
        if (options.type === 'image') {
          const error = new Error('image format rejected');
          error.providerCode = 40014;
          throw error;
        }
        return { media_id: 'fallback-file-media' };
      },
      sendMediaMessage: async (_chatId, type, mediaId) => {
        messages.push({ type, mediaId });
        return { body: { msgid: 'wecom-file', errcode: 0 } };
      },
    },
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '图片已生成。';
      },
    },
    state: state(),
  });

  const receipt = await bridge.accept(frame({ msgid: 'wecom-image-fallback' }));

  assert.deepEqual(uploads, ['image', 'file']);
  assert.deepEqual(messages, [{ type: 'file', mediaId: 'fallback-file-media' }]);
  assert.equal(receipt.artifacts[0].outcome, 'sent');
});

test('Enterprise WeChat does not file-fallback after an uncertain native image send', async (t) => {
  const artifact = await committedArtifact(t, 'uncertain.png', PNG_1X1, 'image-uncertain');
  const uploads = [];
  const notices = [];
  const bridge = new WecomHarnessBridge({
    client: {
      replyStream: async () => {},
      replyStreamNonBlocking: async () => {},
      sendMessage: async (_chatId, body) => {
        notices.push(body.markdown.content);
        return { body: { msgid: 'wecom-uncertain-notice' } };
      },
      uploadMedia: async (_bytes, options) => {
        uploads.push(options.type);
        return { media_id: 'uncertain-image-media' };
      },
      sendMediaMessage: async () => new Promise(() => {}),
    },
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '图片已生成。';
      },
    },
    state: state(),
    fileUploadTimeoutMs: 20,
    logger: { warn() {}, error() {} },
  });

  const receipt = await bridge.accept(frame({ msgid: 'wecom-image-uncertain' }));

  assert.deepEqual(uploads, ['image']);
  assert.match(notices[0], /发送结果未能确认.*不要立即重试/);
  assert.equal(receipt.artifacts[0].outcome, 'unknown');
});

function frame(overrides = {}) {
  return {
    headers: { req_id: 'req-1' },
    body: {
      msgid: 'msg-1',
      chattype: 'single',
      from: { userid: 'member-1' },
      msgtype: 'text',
      text: { content: '请回答' },
      ...overrides,
    },
  };
}

function state() {
  const seen = new Set();
  return {
    seen,
    hasSeen: (id) => seen.has(id),
    markSeen: async (id) => seen.add(id),
    sessionFor: () => 'session-existing',
    sessionExists: async () => true,
    setSession: async () => {},
    clearSession: async () => {},
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function eventually(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition did not become true');
}

function testClient() {
  const streamed = [];
  const active = [];
  return {
    streamed,
    active,
    client: {
      replyStream: async (source, streamId, content, finish) => {
        streamed.push({ messageId: source.body.msgid, streamId, content, finish });
      },
      replyStreamNonBlocking: async (source, streamId, content, finish) => {
        streamed.push({ messageId: source.body.msgid, streamId, content, finish });
      },
      sendMessage: async (chatId, body) => active.push({ chatId, body }),
    },
  };
}

test('Enterprise WeChat maps its native quote snapshot without changing current content', () => {
  const inbound = wecomInboundMessage(frame({
    msgid: 'wecom-quote-normalize',
    text: { content: '继续分析' },
    quote: {
      msgtype: 'mixed',
      mixed: { msg_item: [
        { msgtype: 'text', text: { content: '被引用的结论' } },
        { msgtype: 'image', image: { url: 'https://wecom.example/quoted-image' } },
      ] },
    },
  }), {});

  assert.equal(inbound.content, '继续分析');
  assert.deepEqual(inbound.replyTo, {
    content: '被引用的结论',
    attachments: [{ kind: 'image' }],
  });
});

test('Enterprise WeChat sends quote context to Harness but does not execute quoted commands', async () => {
  const transport = testClient();
  const fixture = state();
  let prompt;
  let clears = 0;
  fixture.clearSession = async () => { clears += 1; };
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    generateStreamId: () => 'stream-quote',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, content) => { prompt = content; return '已处理'; },
    },
    state: fixture,
  });

  await bridge.accept(frame({
    msgid: 'wecom-quote-prompt',
    text: { content: '这条指令是什么意思？' },
    quote: { msgtype: 'text', text: { content: '/new' } },
  }));

  assert.equal(clears, 0);
  assert.equal(Array.isArray(prompt), true);
  assert.match(prompt[0].text, /<dsh_im_reply_to>/);
  assert.match(prompt[0].text, /"content":"\/new"/);
  assert.deepEqual(prompt.at(-1), { type: 'text', text: '这条指令是什么意思？' });
});

async function committedArtifact(t, fileName, content, suffix) {
  const workspace = await mkdtemp(join(tmpdir(), `dsh-im-wecom-artifact-${suffix}-`));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let nextId = 0;
  const registry = new OutboundArtifactRegistry({ uuid: () => `${suffix}-${++nextId}` });
  t.after(() => registry.clear());
  const rpcId = `rpc-${suffix}`;
  const agent = {
    session: {
      header: { id: `session-${suffix}`, cwd: workspace },
      events: [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { turn: 1, source: { rpcId } } },
      ],
    },
  };
  const tool = createOutboundArtifactTool({ registry });
  const exec = {
    name: OUTBOUND_ARTIFACT_TOOL,
    callId: `call-${suffix}`,
    rootCallId: `call-${suffix}`,
    token: Symbol(`call-${suffix}`),
    agent,
  };
  await writeFile(join(workspace, fileName), content);
  await tool.definition.execute({ path: fileName }, exec);
  tool.onResult(exec, { isError: false });
  const [artifact] = registry.take(agent.session.header.id, 1);
  return artifact;
}

function questionInteraction({
  interactionId = 'question-1',
  sessionId = 'session-existing',
  questions = [{
    id: 'environment',
    question: '请选择测试环境',
    options: [{ label: '测试环境' }, { label: '生产环境' }],
  }],
  recovered = false,
  respond = async () => {},
  reconnect = () => {},
} = {}) {
  return {
    kind: 'question',
    interactionId,
    rpcId: interactionId,
    sessionId,
    payload: { questions },
    recovered,
    respond,
    reconnect,
  };
}

test('Enterprise WeChat remembers any private inbound as a connection-test target', async () => {
  const privateState = state();
  const privateTransport = testClient();
  const privateBridge = new WecomHarnessBridge({
    client: privateTransport.client,
    harness: { ensureRunning: async () => true },
    state: privateState,
  });
  await privateBridge.accept(frame({ msgid: 'help-private', text: { content: '/help' } }));
  assert.deepEqual(connectionTestTarget(privateState), { chatId: 'member-1' });

  const groupState = state();
  const groupTransport = testClient();
  const groupBridge = new WecomHarnessBridge({
    client: groupTransport.client,
    harness: { ensureRunning: async () => true },
    state: groupState,
  });
  await groupBridge.accept(frame({
    msgid: 'help-group',
    chattype: 'group',
    chatid: 'group-1',
    text: { content: '@机器人 /help' },
  }));
  assert.equal(connectionTestTarget(groupState), null);
});

test('Enterprise WeChat executes /compact for the bound Session without prompting the model', async () => {
  const store = state();
  const transport = testClient();
  const executed = [];
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    generateStreamId: () => 'unused-stream',
    harness: {
      executeCommand: async (sessionId, line) => {
        executed.push({ sessionId, line });
        return { commandId: 'compact-wecom', result: { kind: 'success', text: 'No compactable history yet.' } };
      },
      ask: async () => assert.fail('/compact must not be submitted to the model'),
    },
    state: store,
  });

  await bridge.accept(frame({ msgid: 'compact-wecom', text: { content: '/compact' } }));

  assert.deepEqual(executed, [{ sessionId: 'session-existing', line: '/compact' }]);
  assert.equal(transport.streamed.at(-1).content, '暂无可压缩的历史记录。');
  assert.equal(transport.streamed.at(-1).finish, true);
  assert.deepEqual(transport.active, []);
});

test('Enterprise WeChat lists models and presets without prompting and advertises fast commands', async () => {
  const store = state();
  store.sessionFor = () => null;
  const transport = testClient();
  const presetUpdates = [];
  let agentPreset = null;
  let asks = 0;
  let creates = 0;
  const agentPresetCatalog = {
    defaultId: 'preset-001',
    items: Array.from({ length: 70 }, (_, index) => ({
      id: `preset-${String(index + 1).padStart(3, '0')}`,
      label: `WeCom Preset ${index + 1} ${'x'.repeat(64)}`,
    })),
  };
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    generateStreamId: () => 'models-stream',
    harness: {
      listModels: async () => ({
        groups: [{
          id: 'wecom-provider',
          name: 'WeCom Provider',
          models: [{ id: 'model-one', name: 'Model One' }],
        }],
        failures: [],
      }),
      agentPresetSettings: async () => ({ agentPreset, agentPresetCatalog }),
      updateAgentPreset: async (value) => {
        presetUpdates.push(value);
        agentPreset = value;
        return { agentPreset, agentPresetCatalog };
      },
      createSession: async () => { creates += 1; return 'wecom-session'; },
      ask: async () => { asks += 1; return 'unexpected model reply'; },
    },
    state: store,
  });

  await bridge.accept(frame({ msgid: 'models-wecom', text: { content: '/models' } }));
  assert.match(transport.streamed.at(-1).content, /1\. wecom-provider\/model-one/);
  assert.equal(asks, 0);
  assert.equal(creates, 0);

  await bridge.accept(frame({ msgid: 'reasoning-wecom', text: { content: '/reasoninglist' } }));
  assert.match(transport.streamed.at(-1).content, /还没有会话/);
  assert.equal(asks, 0);
  assert.equal(creates, 0);

  const presetReplyStart = transport.streamed.length;
  await bridge.accept(frame({ msgid: 'presets-wecom', text: { content: '/presetlist' } }));
  const presetReplies = transport.streamed
    .slice(presetReplyStart)
    .map((entry) => entry.content);
  assert.ok(presetReplies.length > 1);
  assert.match(presetReplies.join('\n'), /preset-070/);
  assert.equal(asks, 0);
  assert.equal(creates, 0);

  await bridge.accept(frame({ msgid: 'preset-current-wecom', text: { content: '/preset' } }));
  assert.match(transport.streamed.at(-1).content, /跟随 Host 默认/);
  assert.equal(asks, 0);
  assert.equal(creates, 0);

  const selectReplyStart = transport.streamed.length;
  await bridge.accept(frame({ msgid: 'preset-select-wecom', text: { content: '/preset 2' } }));
  assert.deepEqual(presetUpdates, ['preset-002']);
  assert.equal(transport.streamed.length, selectReplyStart + 1);
  assert.match(transport.streamed.at(-1).content, /preset-002/);
  assert.equal(transport.streamed.at(-1).finish, true);

  const defaultReplyStart = transport.streamed.length;
  await bridge.accept(frame({ msgid: 'preset-default-wecom', text: { content: '/preset --default' } }));
  assert.deepEqual(presetUpdates, ['preset-002', null]);
  assert.equal(transport.streamed.length, defaultReplyStart + 1);
  assert.match(transport.streamed.at(-1).content, /跟随 Host 默认/);
  assert.equal(transport.streamed.at(-1).finish, true);
  assert.equal(asks, 0);
  assert.equal(creates, 0);

  await bridge.accept(frame({ msgid: 'help-models-wecom', text: { content: '/help' } }));
  const help = transport.streamed.at(-1).content;
  for (const command of [
    '/models', '/model', '/reasoninglist', '/reasonings', '/reasoning',
    '/presetlist', '/preset', '/preset --default', '/stop', '/steer',
    '/version',
    '/batch', '/send', '/cancel',
  ]) {
    assert.equal(help.includes(command), true, command);
  }
  assert.match(help, /\/model .*\[推理等级ID\]/);
  assert.match(help, /示例：先发 \/models，再发 \/model 2 \[推理等级ID\]/);
  assert.doesNotMatch(help, /\/model 2 high\b/);
  assert.match(help, /\/preset id:<ID>/);
});

test('Enterprise WeChat messages stream Harness progress and finalize once', async () => {
  const replies = [];
  const active = [];
  const store = state();
  const bridge = new WecomHarnessBridge({
    client: {
      replyStream: async (_frame, streamId, content, finish) => replies.push({ streamId, content, finish }),
      replyStreamNonBlocking: async (_frame, streamId, content, finish) => replies.push({ streamId, content, finish }),
      sendMessage: async (chatId, body) => active.push({ chatId, body }),
    },
    generateStreamId: () => 'stream-1',
    harness: {
      sessionExists: async () => true,
      createSession: async () => 'session-new',
      ensureRunning: async () => true,
      ask: async (_session, _text, { onUpdate }) => {
        await onUpdate({ type: 'tool', name: '网页搜索' });
        await onUpdate({ type: 'status', text: '正在整理结果…' });
        await onUpdate({ type: 'text', text: '回答中' });
        return '最终回答';
      },
    },
    state: store,
  });

  await bridge.accept(frame());
  assert.deepEqual(replies, [
    { streamId: 'stream-1', content: INITIAL_THINKING_STREAM, finish: false },
    { streamId: 'stream-1', content: '<think>正在使用网页搜索…', finish: false },
    { streamId: 'stream-1', content: '<think>正在整理结果…', finish: false },
    {
      streamId: 'stream-1',
      content: streamPreview('回答中', '正在整理结果…'),
      finish: false,
    },
    {
      streamId: 'stream-1',
      content: '最终回答',
      finish: true,
    },
  ]);
  assert.deepEqual(active, []);
  assert.equal(store.seen.has('msg-1'), true);
  assert.equal(bridge.status.messagesReplied, 1);
});

test('Enterprise WeChat final frames discard progress while preserving the answer', async (t) => {
  const cases = [
    { name: 'no tools', updates: [], answer: '直接回答', expected: '直接回答' },
    {
      name: 'multiple tools',
      updates: [
        { type: 'tool', name: '搜索' },
        { type: 'status', text: '正在整理结果…' },
        { type: 'text', text: '初步回答' },
        { type: 'tool', name: '读取' },
        { type: 'status', text: '正在整理结果…' },
      ],
      answer: '完整回答', expected: '完整回答',
    },
    { name: 'empty answer', updates: [], answer: '', expected: '任务已完成，但没有生成可显示的文本。' },
    {
      name: 'literal think tags in answer', updates: [],
      answer: '示例：`<think>正在整理结果…</think>` 是正文。',
      expected: '示例：`<think>正在整理结果…</think>` 是正文。',
    },
    {
      name: 'stopped after progress',
      updates: [{ type: 'status', text: '正在整理结果…' }],
      error: Object.assign(new Error('turn stopped'), { code: 'turn-stopped' }),
      expected: '已停止。',
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const transport = testClient();
      const bridge = new WecomHarnessBridge({
        client: transport.client,
        generateStreamId: () => 'final-content-stream',
        harness: {
          sessionExists: async () => true,
          ask: async (_session, _text, { onUpdate }) => {
            for (const update of scenario.updates) await onUpdate(update);
            if (scenario.error) throw scenario.error;
            return scenario.answer;
          },
        },
        state: state(),
      });

      await bridge.accept(frame());

      const final = transport.streamed.filter(({ finish }) => finish);
      assert.deepEqual(final, [{
        messageId: 'msg-1', streamId: 'final-content-stream',
        content: scenario.expected, finish: true,
      }]);
      assert.equal(transport.streamed.at(-1), final[0]);
      assert.deepEqual(transport.active, []);
    });
  }
});

test('Enterprise WeChat finalizes a failed turn without its last progress text', async () => {
  const transport = testClient();
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    generateStreamId: () => 'error-content-stream',
    harness: {
      sessionExists: async () => true,
      ask: async (_session, _text, { onUpdate }) => {
        await onUpdate({ type: 'tool', name: '搜索' });
        await onUpdate({ type: 'status', text: '正在整理结果…' });
        throw new Error('private provider failure');
      },
    },
    state: state(),
    logger: { error() {} },
  });

  await bridge.accept(frame());

  const final = transport.streamed.filter(({ finish }) => finish);
  assert.equal(final.length, 1);
  assert.equal(final[0].streamId, 'error-content-stream');
  assert.match(final[0].content, /^任务未完成/);
  assert.match(final[0].content, /错误码：INTERNAL_UNKNOWN；参考号：MF-[A-F0-9]{8}$/);
  assert.doesNotMatch(final[0].content, /<\/?think>|正在整理结果|private provider failure/);
  assert.equal(transport.streamed.at(-1), final[0]);
  assert.deepEqual(transport.active, []);
});

test('Enterprise WeChat splits the final answer without progress or lost Unicode text', async () => {
  const replies = [];
  const active = [];
  const answer = '结🙂'.repeat(4_000);
  const bridge = new WecomHarnessBridge({
    client: {
      replyStream: async (_frame, streamId, content, finish) => {
        replies.push({ streamId, content, finish });
      },
      replyStreamNonBlocking: async () => {},
      sendMessage: async (chatId, body) => active.push({ chatId, body }),
    },
    generateStreamId: () => 'stream-long',
    harness: {
      sessionExists: async () => true,
      ask: async () => answer,
    },
    state: state(),
  });

  await bridge.accept(frame({ msgid: 'wecom-long-answer' }));

  const final = replies.find(({ finish }) => finish);
  assert.ok(final);
  assert.doesNotMatch(final.content, /<\/?think>|正在思考中/);
  assert.ok(Buffer.byteLength(final.content) <= 18_000);
  assert.ok(active.length > 0);
  assert.equal(
    [final.content, ...active.map(({ body }) => body.markdown.content)].join(''),
    answer,
  );
  assert.equal(active.every(({ body }) => Buffer.byteLength(body.markdown.content) <= 18_000), true);
});

test('Enterprise WeChat falls back to a plain active reply when the stream cannot start', async () => {
  const active = [];
  let streamAttempts = 0;
  const bridge = new WecomHarnessBridge({
    client: {
      replyStream: async () => {
        streamAttempts += 1;
        throw new Error('stream unavailable');
      },
      replyStreamNonBlocking: async () => assert.fail('an unopened stream cannot be updated'),
      sendMessage: async (chatId, body) => active.push({ chatId, body }),
    },
    generateStreamId: () => 'stream-unavailable',
    harness: {
      sessionExists: async () => true,
      ask: async () => '最终回答',
    },
    state: state(),
    logger: { warn() {} },
  });

  await bridge.accept(frame({ msgid: 'wecom-stream-unavailable' }));

  assert.equal(streamAttempts, 1);
  assert.deepEqual(active, [{
    chatId: 'member-1',
    body: { msgtype: 'markdown', markdown: { content: '最终回答' } },
  }]);
});

test('Enterprise WeChat falls back to the full plain answer when stream finalization fails', async () => {
  const transport = testClient();
  const sendStream = transport.client.replyStream;
  const attemptedFinals = [];
  transport.client.replyStream = async (source, streamId, content, finish) => {
    if (finish) {
      attemptedFinals.push(content);
      throw new Error('stream finalization unavailable');
    }
    return sendStream(source, streamId, content, finish);
  };
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    harness: {
      sessionExists: async () => true,
      ask: async (_session, _text, { onUpdate }) => {
        await onUpdate({ type: 'status', text: '正在整理结果…' });
        return '完整最终回答';
      },
    },
    state: state(),
    logger: { warn() {} },
  });

  await bridge.accept(frame());

  assert.deepEqual(attemptedFinals, ['完整最终回答']);
  assert.deepEqual(transport.active, [{
    chatId: 'member-1',
    body: { msgtype: 'markdown', markdown: { content: '完整最终回答' } },
  }]);
  assert.equal(bridge.status.messagesReplied, 1);
});

test('Enterprise WeChat downloads an image with its AES key and submits structured content once', async () => {
  const transport = testClient();
  const downloads = [];
  const asked = [];
  transport.client.downloadFile = async (url, aeskey) => {
    downloads.push({ url, aeskey });
    return { buffer: PNG_1X1, filename: 'photo.png' };
  };
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    generateStreamId: () => 'stream-image',
    harness: {
      sessionExists: async () => true,
      ask: async (sessionId, content) => {
        asked.push({ sessionId, content });
        return '图片识别完成';
      },
    },
    state: state(),
  });
  const imageFrame = frame({
    msgid: 'image-1',
    msgtype: 'image',
    text: undefined,
    image: { url: 'https://wecom.example/image', aeskey: 'aes-image' },
  });

  await bridge.accept(imageFrame);
  await bridge.accept(imageFrame);

  assert.deepEqual(downloads, [{
    url: 'https://wecom.example/image',
    aeskey: 'aes-image',
  }]);
  assert.deepEqual(asked, [{
    sessionId: 'session-existing',
    content: [
      { type: 'text', text: DEFAULT_IMAGE_PROMPT },
      {
        type: 'image',
        mediaType: 'image/png',
        data: PNG_1X1.toString('base64'),
        name: 'photo.png',
      },
    ],
  }]);
  assert.equal(transport.streamed.at(-1).content, '图片识别完成');
});

test('Enterprise WeChat preserves mixed-message text and image order', async () => {
  const transport = testClient();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const gif = Buffer.from('GIF89a payload');
  transport.client.downloadFile = async (url) => ({
    buffer: url.endsWith('/one') ? jpeg : gif,
  });
  let prompt;
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    generateStreamId: () => 'stream-mixed',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, content) => { prompt = content; return 'ok'; },
    },
    state: state(),
  });

  await bridge.accept(frame({
    msgid: 'mixed-image',
    msgtype: 'mixed',
    text: undefined,
    mixed: { msg_item: [
      { msgtype: 'text', text: { content: '比较这两张图' } },
      { msgtype: 'image', image: { url: 'https://wecom.example/one', aeskey: 'one' } },
      { msgtype: 'image', image: { url: 'https://wecom.example/two', aeskey: 'two' } },
    ] },
  }));

  assert.deepEqual(prompt, [
    { type: 'text', text: '比较这两张图' },
    { type: 'image', mediaType: 'image/jpeg', data: jpeg.toString('base64') },
    { type: 'image', mediaType: 'image/gif', data: gif.toString('base64') },
  ]);
});

test('Enterprise WeChat exposes native file callbacks through the SDK downloader without file limits', async () => {
  const calls = [];
  const bytes = Buffer.from('wecom-native-file');
  const message = wecomInboundMessage(frame({
    msgtype: 'file',
    text: undefined,
    file: {
      url: 'https://wecom.example/encrypted-file',
      aeskey: 'file-specific-key',
    },
  }), {
    downloadFile: async (url, aeskey) => {
      calls.push({ url, aeskey });
      return { buffer: bytes, filename: '企业微信报告.pdf' };
    },
  });

  assert.equal(message.content, '');
  assert.deepEqual(message.images, []);
  assert.equal(message.files.length, 1);
  assert.equal(message.files[0].name, 'file');
  assert.equal(calls.length, 0, 'file download stays lazy at normalization time');
  assert.deepEqual(await message.files[0].load({}), {
    data: bytes,
    name: '企业微信报告.pdf',
  });
  assert.deepEqual(calls, [{
    url: 'https://wecom.example/encrypted-file',
    aeskey: 'file-specific-key',
  }]);
});

test('Enterprise WeChat applies the unified access policy before attachments or Harness work', async () => {
  const transport = testClient();
  let downloads = 0;
  const harnessCalls = [];
  const accessPolicy = directAccessPolicy({
    users: [{ id: 'member-1', canExecuteCommands: false }],
    privilegedIds: ['owner-1'],
  });
  transport.client.downloadFile = async () => {
    downloads += 1;
    return { buffer: PNG_1X1, filename: 'blocked.png' };
  };
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    generateStreamId: (() => {
      let sequence = 0;
      return () => `policy-stream-${++sequence}`;
    })(),
    accessPolicy,
    harness: {
      sessionExists: async (sessionId) => {
        harnessCalls.push(['sessionExists', sessionId]);
        return true;
      },
      ask: async (sessionId, prompt) => {
        harnessCalls.push(['ask', sessionId, prompt]);
        return '白名单消息已处理';
      },
    },
    state: state(),
  });

  await bridge.accept(frame({
    msgid: 'policy-blocked-image',
    from: { userid: 'blocked-1' },
    msgtype: 'image',
    text: undefined,
    image: { url: 'https://wecom.example/blocked', aeskey: 'blocked-key' },
  }));
  assert.equal(downloads, 0);
  assert.deepEqual(harnessCalls, []);
  assert.deepEqual(transport.streamed, []);
  assert.deepEqual(transport.active, []);

  await bridge.accept(frame({
    msgid: 'policy-member-text',
    text: { content: '普通消息' },
  }));
  assert.equal(harnessCalls.some(([operation]) => operation === 'ask'), true);
  assert.equal(transport.streamed.at(-1).content, '白名单消息已处理');

  const callsBeforeDeniedCommand = harnessCalls.length;
  const repliesBeforeDeniedCommand = transport.streamed.length;
  await bridge.accept(frame({
    msgid: 'policy-member-command',
    text: { content: '/help' },
  }));
  assert.equal(harnessCalls.length, callsBeforeDeniedCommand);
  assert.deepEqual(transport.streamed.slice(repliesBeforeDeniedCommand).map(({ content, finish }) => ({
    content,
    finish,
  })), [{ content: COMMAND_PERMISSION_DENIED_MESSAGE, finish: true }]);

  accessPolicy.getSettings().direct.allowlist.users = [];
  await bridge.accept(frame({
    msgid: 'policy-owner-command',
    from: { userid: 'owner-1' },
    text: { content: '/help' },
  }));
  assert.match(transport.streamed.at(-1).content, /\/help/);
});

test('Enterprise WeChat bridge hands its prefetched native file to the current Harness turn', async () => {
  const transport = testClient();
  const bytes = Buffer.from('wecom-bridge-file');
  const downloads = [];
  const prompts = [];
  transport.client.downloadFile = async (url, aeskey) => {
    downloads.push({ url, aeskey });
    return { buffer: bytes, filename: '企微报告.docx' };
  };
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    generateStreamId: () => 'file-stream',
    harness: {
      sessionExists: async () => true,
      ask: async (sessionId, prompt, options) => {
        const loaded = await options.files[0].load({ signal: options.signal });
        prompts.push({ sessionId, prompt, name: options.files[0].name, loaded });
        return '文件已收到';
      },
    },
    state: state(),
  });

  await bridge.accept(frame({
    msgid: 'wecom-native-file',
    msgtype: 'file',
    text: undefined,
    file: { url: 'https://wecom.example/file', aeskey: 'file-key' },
  }));

  assert.deepEqual(downloads, [{ url: 'https://wecom.example/file', aeskey: 'file-key' }]);
  assert.deepEqual(prompts, [{
    sessionId: 'session-existing',
    prompt: '',
    name: 'file',
    loaded: { data: bytes, name: '企微报告.docx' },
  }]);
  assert.equal(transport.streamed.at(-1).content, '文件已收到');
});

test('Enterprise WeChat starts image download before an earlier conversation turn finishes', async () => {
  const transport = testClient();
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const downloads = [];
  const prompts = [];
  transport.client.downloadFile = async (url, aeskey) => {
    downloads.push({ url, aeskey });
    return { buffer: PNG_1X1, filename: 'queued.png' };
  };
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    generateStreamId: (() => { let index = 0; return () => `queued-${++index}`; })(),
    harness: {
      sessionExists: async () => true,
      async ask(_sessionId, prompt) {
        prompts.push(prompt);
        if (prompt === '先处理这个慢任务') {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return 'ok';
      },
    },
    state: state(),
  });

  const first = bridge.accept(frame({
    msgid: 'queued-text',
    text: { content: '先处理这个慢任务' },
  }));
  await firstStarted.promise;
  const second = bridge.accept(frame({
    msgid: 'queued-image',
    msgtype: 'image',
    text: undefined,
    image: { url: 'https://wecom.example/expiring', aeskey: 'queued-key' },
  }));

  await eventually(() => downloads.length === 1);
  assert.deepEqual(prompts, ['先处理这个慢任务']);
  releaseFirst.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(downloads, [{
    url: 'https://wecom.example/expiring',
    aeskey: 'queued-key',
  }]);
  assert.equal(Array.isArray(prompts[1]), true);
  assert.equal(prompts[1][1].mediaType, 'image/png');
});

test('Enterprise WeChat bounds prefetched image memory while a conversation is queued', async () => {
  const transport = testClient();
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const downloads = [];
  const prompts = [];
  transport.client.downloadFile = async (url) => {
    downloads.push(url);
    return { buffer: PNG_1X1 };
  };
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    generateStreamId: (() => { let index = 0; return () => `bounded-${++index}`; })(),
    harness: {
      sessionExists: async () => true,
      async ask(_sessionId, prompt) {
        prompts.push(prompt);
        if (prompt === '阻塞队列') {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return 'ok';
      },
    },
    state: state(),
    logger: { error() {}, warn() {} },
  });

  const pending = [bridge.accept(frame({
    msgid: 'bounded-start',
    text: { content: '阻塞队列' },
  }))];
  await firstStarted.promise;
  for (let index = 0; index < 5; index += 1) {
    pending.push(bridge.accept(frame({
      msgid: `bounded-image-${index}`,
      msgtype: 'image',
      text: undefined,
      image: { url: `https://wecom.example/bounded-${index}`, aeskey: `key-${index}` },
    })));
  }

  await eventually(() => downloads.length === 4);
  releaseFirst.resolve();
  await Promise.all(pending);
  assert.equal(downloads.length, 4);
  assert.equal(prompts.length, 5);
  assert.equal(transport.streamed.some(({ content }) => (
    content.includes('当前待处理图片较多，请稍后重新发送。')
      && /错误码：INPUT_INVALID；参考号：MF-[A-F0-9]{8}$/.test(content)
  )), true);
});

test('Enterprise WeChat image references enforce the caller byte limit after SDK decryption', async () => {
  const message = wecomInboundMessage(frame({
    msgtype: 'image',
    image: { url: 'https://wecom.example/large', aeskey: 'large-key' },
  }), {
    downloadFile: async () => ({ buffer: Buffer.alloc(5) }),
  });
  await assert.rejects(message.images[0].load({ maxBytes: 4 }), /exceeds/);
});

test('Enterprise WeChat visibility scope accepts direct and group conversations without local approval', async () => {
  let asks = 0;
  const client = {
    replyStream: async () => {},
    replyStreamNonBlocking: async () => {},
    sendMessage: async () => {},
  };
  const harness = {
    sessionExists: async () => true,
    ask: async () => { asks += 1; return 'ok'; },
  };
  const bridge = new WecomHarnessBridge({ client, harness, state: state(), generateStreamId: () => 'stream' });
  await bridge.accept(frame({ msgid: 'direct', from: { userid: 'member-a' } }));
  await bridge.accept(frame({ msgid: 'group', chattype: 'group', chatid: 'group-1', from: { userid: 'member-b' } }));
  assert.equal(asks, 2);
});

test('Enterprise WeChat finalizes an existing progress stream when Harness fails', async () => {
  const replies = [];
  const store = state();
  const bridge = new WecomHarnessBridge({
    client: {
      replyStream: async (_frame, streamId, content, finish) => replies.push({ streamId, content, finish }),
      replyStreamNonBlocking: async () => {},
      sendMessage: async () => {},
    },
    generateStreamId: () => 'stream-failure',
    harness: {
      sessionExists: async () => true,
      ensureRunning: async () => true,
      ask: async () => { throw new Error('Harness unavailable'); },
    },
    state: store,
    logger: { error() {} },
  });

  await bridge.accept(frame());
  assert.deepEqual(replies[0], {
    streamId: 'stream-failure', content: INITIAL_THINKING_STREAM, finish: false,
  });
  assert.equal(replies[1].streamId, 'stream-failure');
  assert.equal(replies[1].finish, true);
  assert.doesNotMatch(replies[1].content, /<\/?think>|正在思考中/);
  assert.match(replies[1].content, /任务未完成，暂时无法确定原因/);
  assert.match(replies[1].content, /错误码：INTERNAL_UNKNOWN；参考号：MF-[A-F0-9]{8}$/);
  assert.equal(store.seen.has('msg-1'), true);
});

test('Enterprise WeChat exposes a structured model rate limit without changing connection state', async () => {
  const transport = testClient();
  const status = {
    ...createWecomBridgeStatus(),
    connected: true,
    connectionState: 'connected',
  };
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    generateStreamId: () => 'rate-limit-stream',
    harness: {
      sessionExists: async () => true,
      ask: async () => {
        const error = new Error('private Enterprise WeChat provider rate-limit detail');
        error.code = 'harness-turn-failed';
        error.providerCode = 'RATE_LIMIT';
        throw error;
      },
    },
    state: state(),
    status,
    logger: { error() {} },
  });

  await bridge.accept(frame({
    msgid: 'wecom-rate-limit',
    text: { content: '触发模型限流' },
  }));

  const failure = status.lastMessageError;
  const visibleError = transport.streamed.at(-1).content;
  assert.equal(failure.code, 'MODEL_RATE_LIMIT');
  assert.equal(failure.reason, 'MODEL_RATE_LIMIT');
  assert.match(failure.referenceId, /^MF-[A-F0-9]{8}$/);
  assert.match(visibleError, /模型服务正在限流，本次任务未完成。请稍后重试。/);
  assert.equal(visibleError.endsWith(`参考号：${failure.referenceId}`), true);
  assert.doesNotMatch(visibleError, /private Enterprise WeChat provider rate-limit detail/);
  assert.equal(status.connected, true);
  assert.equal(status.connectionState, 'connected');
});

test('Enterprise WeChat does not resubmit a recorded prompt when the safe error reply fails', async () => {
  const store = state();
  let asks = 0;
  let safeReplyAttempts = 0;
  const bridge = new WecomHarnessBridge({
    client: {
      replyStream: async (_frame, _streamId, _content, finish) => {
        if (!finish) return;
        safeReplyAttempts += 1;
        throw new Error('safe reply unavailable');
      },
      replyStreamNonBlocking: async () => {},
      sendMessage: async () => {},
    },
    generateStreamId: () => 'safe-error-replay-stream',
    harness: {
      sessionExists: async () => true,
      ask: async () => {
        asks += 1;
        const error = new Error('private provider failure');
        error.code = 'harness-turn-failed';
        error.providerCode = 'RATE_LIMIT';
        throw error;
      },
    },
    state: store,
    logger: { error() {}, warn() {} },
  });
  const inbound = frame({
    msgid: 'wecom-safe-error-replay',
    text: { content: '请执行一次' },
  });

  await bridge.accept(inbound);
  await bridge.accept(inbound);

  assert.equal(asks, 1);
  assert.equal(safeReplyAttempts, 1);
  assert.equal(store.seen.has('wecom-safe-error-replay'), true);
});

test('an Enterprise WeChat answer bypasses the original conversation queue', async () => {
  const transport = testClient();
  const answered = deferred();
  const responses = [];
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    generateStreamId: (() => { let index = 0; return () => `stream-${++index}`; })(),
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onInteraction(questionInteraction({
          respond: async (result) => {
            responses.push(result);
            answered.resolve();
          },
        }));
        await answered.promise;
        return '你选择了：测试环境';
      },
    },
    state: state(),
  });

  const prompt = bridge.accept(frame({ msgid: 'question-start' }));
  await eventually(() => transport.active.some(({ body }) => (
    body.markdown.content.includes('请选择测试环境')
  )));
  const answer = bridge.accept(frame({
    msgid: 'question-answer',
    text: { content: '1' },
  }));
  await Promise.all([prompt, answer]);

  assert.deepEqual(responses, [{
    ok: true,
    value: {
      sessionId: 'session-existing',
      answer: { answers: [{ id: 'environment', selected: ['测试环境'] }] },
    },
  }]);
  assert.equal(transport.streamed.at(-1).content, '你选择了：测试环境');
  assert.equal(transport.streamed.at(-1).finish, true);
});

test('an answer waits for the first Enterprise WeChat question delivery acknowledgement', async () => {
  const questionSendStarted = deferred();
  const questionAcknowledged = deferred();
  const answered = deferred();
  const streamed = [];
  const active = [];
  const prompts = [];
  const responses = [];
  const bridge = new WecomHarnessBridge({
    client: {
      replyStream: async (source, streamId, content, finish) => {
        streamed.push({ messageId: source.body.msgid, streamId, content, finish });
      },
      sendMessage: async (chatId, body) => {
        active.push({ chatId, body });
        questionSendStarted.resolve();
        await questionAcknowledged.promise;
      },
    },
    generateStreamId: (() => { let index = 0; return () => `first-ack-${++index}`; })(),
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, text, options) => {
        prompts.push(text);
        await options.onInteraction(questionInteraction({
          interactionId: 'first-ack-question',
          respond: async (result) => {
            responses.push(result);
            answered.resolve();
          },
        }));
        await answered.promise;
        return '首问回答完成';
      },
    },
    state: state(),
  });

  const prompt = bridge.accept(frame({ msgid: 'first-ack-start' }));
  await questionSendStarted.promise;
  let answerSettled = false;
  const answer = bridge.accept(frame({
    msgid: 'first-ack-answer',
    text: { content: '1' },
  }));
  answer.then(
    () => { answerSettled = true; },
    () => { answerSettled = true; },
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(answerSettled, false);
  assert.equal(active.length, 1);
  assert.deepEqual(responses, []);

  questionAcknowledged.resolve();
  await eventually(() => responses.length === 1);
  await Promise.all([prompt, answer]);

  assert.deepEqual(prompts, ['请回答']);
  assert.equal(active.length, 1);
  assert.deepEqual(responses[0].value.answer.answers, [
    { id: 'environment', selected: ['测试环境'] },
  ]);
  assert.equal(streamed.at(-1).content, '首问回答完成');
});

test('pending Enterprise WeChat questions stay isolated by conversation', async () => {
  const transport = testClient();
  const gates = new Map([
    ['ask-a', deferred()],
    ['ask-b', deferred()],
  ]);
  const responses = [];
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    generateStreamId: (() => { let index = 0; return () => `isolation-${++index}`; })(),
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, text, options) => {
        const gate = gates.get(text);
        await options.onInteraction(questionInteraction({
          interactionId: `question-${text}`,
          respond: async (result) => {
            responses.push({ text, result });
            gate.resolve();
          },
        }));
        await gate.promise;
        return `done-${text}`;
      },
    },
    state: state(),
  });

  const first = bridge.accept(frame({
    msgid: 'isolation-a',
    from: { userid: 'member-a' },
    text: { content: 'ask-a' },
  }));
  const second = bridge.accept(frame({
    msgid: 'isolation-b',
    from: { userid: 'member-b' },
    text: { content: 'ask-b' },
  }));
  await eventually(() => transport.active.filter(({ body }) => (
    body.markdown.content.includes('请选择测试环境')
  )).length === 2);

  const answerA = bridge.accept(frame({
    msgid: 'isolation-answer-a',
    from: { userid: 'member-a' },
    text: { content: '1' },
  }));
  await Promise.all([first, answerA]);
  assert.deepEqual(responses.map(({ text }) => text), ['ask-a']);

  const answerB = bridge.accept(frame({
    msgid: 'isolation-answer-b',
    from: { userid: 'member-b' },
    text: { content: '2' },
  }));
  await Promise.all([second, answerB]);
  assert.deepEqual(responses.map(({ text }) => text), ['ask-a', 'ask-b']);
  assert.deepEqual(
    responses[1].result.value.answer.answers,
    [{ id: 'environment', selected: ['生产环境'] }],
  );
});

test('Enterprise WeChat accepts only an exact approval decision and never forwards a fuzzy reply', async () => {
  const transport = testClient();
  const completed = deferred();
  const prompts = [];
  const responses = [];
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    generateStreamId: (() => { let index = 0; return () => `approval-${++index}`; })(),
    harness: {
      sessionExists: async () => true,
      ask: async (sessionId, text, options) => {
        prompts.push(text);
        await options.onInteraction({
          kind: 'approval',
          interactionId: 'wecom-approval',
          rpcId: 'wecom-approval-rpc',
          sessionId,
          payload: {
            type: 'approval/requested',
            sessionId,
            approvalId: 'wecom-approval',
            toolName: 'bash',
            callId: 'wecom-approval-call',
            reason: '允许执行企业微信审批测试',
          },
          toolCall: {
            callId: 'wecom-approval-call',
            name: 'bash',
            arguments: JSON.stringify({ command: "printf 'wecom-approval\\n'" }),
          },
          respond: async (result) => {
            responses.push(result);
            completed.resolve();
            return { accepted: true };
          },
        });
        await completed.promise;
        return '审批已继续';
      },
    },
    state: state(),
  });

  const outputTexts = () => [
    ...transport.active.map(({ body }) => body.markdown.content),
    ...transport.streamed.map(({ content }) => content),
  ];
  const prompt = bridge.accept(frame({
    msgid: 'approval-start',
    text: { content: '启动审批' },
  }));
  await eventually(() => outputTexts().some((text) => text.includes('允许执行企业微信审批测试')));

  const outputCountBeforeFuzzyReply = outputTexts().length;
  const fuzzy = bridge.accept(frame({
    msgid: 'approval-fuzzy',
    text: { content: '可以' },
  }));
  await eventually(() => outputTexts().slice(outputCountBeforeFuzzyReply).some((text) => text.includes('回复')
    && text.includes('批准') && text.includes('拒绝')));
  assert.deepEqual(responses, []);
  assert.deepEqual(prompts, ['启动审批']);

  await Promise.all([
    fuzzy,
    bridge.accept(frame({
      msgid: 'approval-exact',
      text: { content: '  YES  ' },
    })),
    prompt,
  ]);

  assert.deepEqual(responses, [{
    ok: true,
    value: {
      sessionId: 'session-existing',
      approvalId: 'wecom-approval',
      outcome: 'allowed-once',
    },
  }]);
  assert.deepEqual(prompts, ['启动审批']);
});

test('question replays are deduplicated and approvals remain fail-closed', async () => {
  const transport = testClient();
  const answered = deferred();
  let approvalResponses = 0;
  let questionResponses = 0;
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    generateStreamId: () => 'replay-stream',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onInteraction({
          kind: 'approval',
          interactionId: 'approval-1',
          rpcId: 'approval-rpc-1',
          sessionId: 'session-existing',
          payload: { type: 'approval/requested', toolName: 'bash' },
          respond: async () => { approvalResponses += 1; },
        });
        const interaction = questionInteraction({
          interactionId: 'replayed-question',
          respond: async () => {
            questionResponses += 1;
            answered.resolve();
          },
        });
        await options.onInteraction(interaction);
        await options.onInteraction({ ...interaction });
        await answered.promise;
        return 'done';
      },
    },
    state: state(),
  });

  const prompt = bridge.accept(frame({ msgid: 'replay-start' }));
  await eventually(() => transport.active.length === 1);
  const answer = bridge.accept(frame({ msgid: 'replay-answer', text: { content: '1' } }));
  await Promise.all([prompt, answer]);

  assert.equal(transport.active.length, 1);
  assert.equal(approvalResponses, 0);
  assert.equal(questionResponses, 1);
});

test('a failed Enterprise WeChat interaction response can be retried', async () => {
  const transport = testClient();
  const answered = deferred();
  const attempts = [];
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    generateStreamId: (() => { let index = 0; return () => `retry-${++index}`; })(),
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onInteraction(questionInteraction({
          respond: async (result) => {
            attempts.push(structuredClone(result.value.answer.answers));
            if (attempts.length === 1) throw new Error('temporary response failure');
            answered.resolve();
          },
        }));
        await answered.promise;
        return 'retry complete';
      },
    },
    state: state(),
    logger: { error() {} },
  });

  const prompt = bridge.accept(frame({ msgid: 'retry-start' }));
  await eventually(() => transport.active.length === 1);
  await bridge.accept(frame({ msgid: 'retry-first', text: { content: '1' } }));
  assert.equal(transport.streamed.some(({ content }) => content.includes('回答提交失败')), true);

  const second = bridge.accept(frame({ msgid: 'retry-second', text: { content: '2' } }));
  await Promise.all([prompt, second]);
  assert.deepEqual(attempts, [
    [{ id: 'environment', selected: ['测试环境'] }],
    [{ id: 'environment', selected: ['生产环境'] }],
  ]);
});

test('an externally resolved Enterprise WeChat answer is not submitted as a new prompt', async () => {
  const transport = testClient();
  const resolved = deferred();
  let interactionOptions;
  const prompts = [];
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    generateStreamId: (() => { let index = 0; return () => `resolved-${++index}`; })(),
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, text, options) => {
        prompts.push(text);
        interactionOptions = options;
        await options.onInteraction(questionInteraction({ interactionId: 'resolved-question' }));
        await resolved.promise;
        return '外部客户端已处理';
      },
    },
    state: state(),
  });

  const prompt = bridge.accept(frame({ msgid: 'resolved-start' }));
  await eventually(() => transport.active.length === 1 && interactionOptions);
  const lateAnswer = bridge.accept(frame({
    msgid: 'resolved-answer',
    text: { content: '1' },
  }));
  interactionOptions.onInteractionResolved({
    kind: 'question',
    interactionId: 'resolved-question',
  });
  resolved.resolve();
  await Promise.all([prompt, lateAnswer]);

  assert.deepEqual(prompts, ['请回答']);
  assert.equal(transport.streamed.some(({ messageId, content }) => (
    messageId === 'resolved-answer' && content === '这个问题已在其他客户端处理，无需再次回答。'
  )), true);
});

test('an Enterprise WeChat answer reports resolution when respond loses an in-flight race', async () => {
  const transport = testClient();
  const responseStarted = deferred();
  const releaseResponse = deferred();
  const turnResolved = deferred();
  const prompts = [];
  let interactionOptions;
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    generateStreamId: (() => { let index = 0; return () => `respond-race-${++index}`; })(),
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, text, options) => {
        prompts.push(text);
        interactionOptions = options;
        await options.onInteraction(questionInteraction({
          interactionId: 'respond-race-question',
          respond: async () => {
            responseStarted.resolve();
            await releaseResponse.promise;
            const error = new Error('interaction resolved elsewhere');
            error.code = 'interaction-not-pending';
            throw error;
          },
        }));
        await turnResolved.promise;
        return '外部客户端已完成';
      },
    },
    state: state(),
  });

  const prompt = bridge.accept(frame({ msgid: 'respond-race-start' }));
  await eventually(() => transport.active.length === 1 && interactionOptions);
  const answer = bridge.accept(frame({
    msgid: 'respond-race-answer',
    text: { content: '1' },
  }));
  await responseStarted.promise;

  interactionOptions.onInteractionResolved({
    kind: 'question',
    interactionId: 'respond-race-question',
  });
  turnResolved.resolve();
  releaseResponse.resolve();
  await Promise.all([prompt, answer]);

  assert.deepEqual(prompts, ['请回答']);
  assert.equal(transport.streamed.filter(({ messageId, content }) => (
    messageId === 'respond-race-answer'
      && content === '这个问题已在其他客户端处理，无需再次回答。'
  )).length, 1);
});

test('a recovered orphan question is cancelled without exposing its content', async () => {
  const transport = testClient();
  const responses = [];
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    generateStreamId: () => 'orphan-stream',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onInteraction(questionInteraction({
          recovered: true,
          questions: [{ id: 'secret', question: '不应显示的旧问题' }],
          respond: async (result) => responses.push(result),
        }));
        return '新消息继续完成';
      },
    },
    state: state(),
  });

  await bridge.accept(frame({ msgid: 'orphan-start' }));
  assert.equal(responses[0].ok, false);
  assert.equal(responses[0].error.code, 'cancelled');
  assert.equal(transport.active.some(({ body }) => (
    body.markdown.content.includes('不应显示的旧问题')
  )), false);
  assert.equal(transport.active.some(({ body }) => (
    body.markdown.content.includes('遗留的待回答问题')
  )), true);
});

test('multi-question Enterprise WeChat interactions preserve canonical answer order', async () => {
  const transport = testClient();
  const answered = deferred();
  let submitted;
  const questions = [
    {
      id: 'environment',
      question: '请选择环境',
      options: [{ label: '测试环境' }, { label: '生产环境' }],
    },
    {
      id: 'features',
      question: '请选择功能',
      multiSelect: true,
      options: [{ label: '日志' }, { label: '指标' }],
    },
  ];
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    generateStreamId: (() => { let index = 0; return () => `batch-${++index}`; })(),
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onInteraction(questionInteraction({
          interactionId: 'batch-question',
          questions,
          respond: async (result) => {
            submitted = result;
            answered.resolve();
          },
        }));
        await answered.promise;
        return 'batch complete';
      },
    },
    state: state(),
  });

  const prompt = bridge.accept(frame({ msgid: 'batch-start' }));
  await eventually(() => transport.active.length === 1);
  await bridge.accept(frame({ msgid: 'batch-first', text: { content: '2' } }));
  await eventually(() => transport.active.length === 2);
  const second = bridge.accept(frame({
    msgid: 'batch-second',
    text: { content: '1, 指标, 自定义' },
  }));
  await Promise.all([prompt, second]);

  assert.deepEqual(submitted.value.answer.answers, [
    { id: 'environment', selected: ['生产环境'] },
    { id: 'features', selected: ['日志', '指标'], custom: '自定义' },
  ]);
});

test('a second answer stays claimed while its Enterprise WeChat question awaits acknowledgement', async () => {
  const secondQuestionStarted = deferred();
  const secondQuestionAcknowledged = deferred();
  const turnResolved = deferred();
  const streamed = [];
  const active = [];
  const prompts = [];
  let interactionOptions;
  let responseCalls = 0;
  const bridge = new WecomHarnessBridge({
    client: {
      replyStream: async (source, streamId, content, finish) => {
        streamed.push({ messageId: source.body.msgid, streamId, content, finish });
      },
      sendMessage: async (chatId, body) => {
        active.push({ chatId, body });
        if (body.markdown.content.includes('请选择功能')) {
          secondQuestionStarted.resolve();
          await secondQuestionAcknowledged.promise;
        }
      },
    },
    generateStreamId: (() => { let index = 0; return () => `second-ack-${++index}`; })(),
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, text, options) => {
        prompts.push(text);
        interactionOptions = options;
        await options.onInteraction(questionInteraction({
          interactionId: 'second-ack-question',
          questions: [
            {
              id: 'environment',
              question: '请选择环境',
              options: [{ label: '测试环境' }, { label: '生产环境' }],
            },
            {
              id: 'features',
              question: '请选择功能',
              options: [{ label: '日志' }, { label: '指标' }],
            },
          ],
          respond: async () => { responseCalls += 1; },
        }));
        await turnResolved.promise;
        return '外部客户端已处理多问';
      },
    },
    state: state(),
  });

  const prompt = bridge.accept(frame({ msgid: 'second-ack-start' }));
  await eventually(() => active.some(({ body }) => body.markdown.content.includes('请选择环境')));
  const firstAnswer = bridge.accept(frame({
    msgid: 'second-ack-first',
    text: { content: '1' },
  }));
  await secondQuestionStarted.promise;
  const secondAnswer = bridge.accept(frame({
    msgid: 'second-ack-answer',
    text: { content: '2' },
  }));

  interactionOptions.onInteractionResolved({
    kind: 'question',
    interactionId: 'second-ack-question',
  });
  turnResolved.resolve();
  secondQuestionAcknowledged.resolve();
  await Promise.all([prompt, firstAnswer, secondAnswer]);

  assert.deepEqual(prompts, ['请回答']);
  assert.equal(responseCalls, 0);
  assert.equal(streamed.filter(({ messageId, content }) => (
    messageId === 'second-ack-answer'
      && content === '这个问题已在其他客户端处理，无需再次回答。'
  )).length, 1);
});

test('only the initiating actor can answer an Enterprise WeChat group question', async () => {
  const transport = testClient();
  const answered = deferred();
  const order = [];
  let groupResponse;
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    generateStreamId: (() => { let index = 0; return () => `group-${++index}`; })(),
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, text, options) => {
        if (text !== '启动问题') {
          order.push(`normal:${text}`);
          return '普通消息完成';
        }
        await options.onInteraction(questionInteraction({
          interactionId: 'group-question',
          respond: async (result) => {
            groupResponse = result;
            order.push('answered');
            answered.resolve();
          },
        }));
        await answered.promise;
        return '问题完成';
      },
    },
    state: state(),
  });

  const prompt = bridge.accept(frame({
    msgid: 'group-start',
    chattype: 'group',
    chatid: 'group-1',
    from: { userid: 'member-a' },
    text: { content: '@RobotA 启动问题' },
  }));
  await eventually(() => transport.active.some(({ chatId }) => chatId === 'group-1'));
  assert.match(
    transport.active.find(({ chatId }) => chatId === 'group-1').body.markdown.content,
    /群聊中请 @机器人 后发送答案/,
  );
  const outsider = bridge.accept(frame({
    msgid: 'group-outsider',
    chattype: 'group',
    chatid: 'group-1',
    from: { userid: 'member-b' },
    text: { content: '@RobotA 1' },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, []);

  const actor = bridge.accept(frame({
    msgid: 'group-actor',
    chattype: 'group',
    chatid: 'group-1',
    from: { userid: 'member-a' },
    text: { content: '@RobotA 2' },
  }));
  await Promise.all([prompt, actor, outsider]);
  assert.deepEqual(order, ['answered', 'normal:1']);
  assert.deepEqual(groupResponse.value.answer.answers, [
    { id: 'environment', selected: ['生产环境'] },
  ]);
});

test('aborting Enterprise WeChat work cancels its pending question without a failure reply', async () => {
  const transport = testClient();
  const controller = new AbortController();
  const cancellations = [];
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    generateStreamId: () => 'abort-stream',
    signal: controller.signal,
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        assert.equal(options.signal, controller.signal);
        await options.onInteraction(questionInteraction({
          interactionId: 'abort-question',
          respond: async (result, responseOptions) => {
            cancellations.push({ result, responseOptions });
          },
        }));
        await new Promise((resolve, reject) => {
          if (options.signal.aborted) reject(options.signal.reason);
          else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
        return 'unreachable';
      },
    },
    state: state(),
  });

  const prompt = bridge.accept(frame({ msgid: 'abort-start' }));
  await eventually(() => transport.active.length === 1);
  controller.abort(new DOMException('runtime stopped', 'AbortError'));
  await prompt;

  assert.equal(cancellations.length, 1);
  assert.equal(cancellations[0].result.ok, false);
  assert.equal(cancellations[0].result.error.code, 'cancelled');
  assert.equal(cancellations[0].responseOptions.signal.aborted, false);
  assert.equal(transport.streamed.some(({ content }) => content === '消息处理失败，请稍后重试。'), false);
});

test('Enterprise WeChat sends registered files after the final text and continues after one file fails', async (t) => {
  const first = await committedArtifact(t, 'first.txt', 'first bytes', 'partial-first');
  const second = await committedArtifact(t, 'second.html', '<h1>second</h1>', 'partial-second');
  const order = [];
  const uploads = [];
  const active = [];
  const status = {
    messagesReceived: 0,
    messagesReplied: 0,
    messagesRejected: 0,
    artifactsSent: 0,
    artifactSendErrors: 0,
    lastMessageAt: null,
    lastReplyAt: null,
    lastRejectedAt: null,
    lastError: null,
  };
  const client = {
    replyStream: async (_source, _streamId, content, finish) => {
      if (finish) order.push(`text:${content}`);
    },
    replyStreamNonBlocking: async () => {},
    sendMessage: async (chatId, body) => {
      const content = body.markdown.content;
      active.push({ chatId, content });
      order.push(`notice:${content}`);
      return { body: { msgid: `notice-${active.length}` } };
    },
    uploadMedia: async (bytes, options) => {
      uploads.push({ bytes: Buffer.from(bytes), options });
      order.push(`upload:${options.filename}`);
      return { media_id: `media-${options.filename}` };
    },
    sendMediaMessage: async (chatId, type, mediaId) => {
      order.push(`file:${mediaId}`);
      if (mediaId === 'media-first.txt') {
        const error = new Error('private provider detail');
        error.code = 'artifact-provider-failed';
        throw error;
      }
      return { body: { msgid: 'wecom-file-2' }, chatId, type };
    },
  };
  const bridge = new WecomHarnessBridge({
    client,
    generateStreamId: () => 'artifact-stream',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(first);
        await options.onArtifact(second);
        return '文件处理完成。';
      },
    },
    state: state(),
    status,
    logger: { warn() {}, error() {} },
  });

  await bridge.accept(frame({ msgid: 'wecom-artifact-partial' }));

  assert.deepEqual(order.map((entry) => entry.split(':', 1)[0]), [
    'text', 'upload', 'file', 'notice', 'upload', 'file',
  ]);
  assert.deepEqual(uploads.map(({ options }) => options), [
    { type: 'file', filename: 'first.txt' },
    { type: 'file', filename: 'second.html' },
  ]);
  assert.equal(uploads[0].bytes.toString(), 'first bytes');
  assert.equal(uploads[1].bytes.toString(), '<h1>second</h1>');
  assert.equal(active.length, 1);
  assert.match(active[0].content, /first\.txt.*暂时未能/);
  assert.equal(status.lastMessageError.code, 'CHANNEL_DELIVERY');
  assert.equal(status.lastMessageError.reason, 'ARTIFACT_PROVIDER_FAILED');
  assert.equal(active[0].content.endsWith(`参考号：${status.lastMessageError.referenceId}`), true);
  assert.doesNotMatch(active[0].content, /private provider detail/);
  assert.equal(status.artifactsSent, 1);
  assert.equal(status.artifactSendErrors, 1);
});

test('Enterprise WeChat still delivers registered files when final text delivery fails', async (t) => {
  const artifact = await committedArtifact(
    t,
    'survives-text-failure.txt',
    'file bytes',
    'text-failure',
  );
  const files = [];
  let finalTextAttempts = 0;
  let activeTextAttempts = 0;
  const bridge = new WecomHarnessBridge({
    client: {
      replyStream: async (_source, _streamId, _content, finish) => {
        if (finish) {
          finalTextAttempts += 1;
          throw new Error('stream finalization unavailable');
        }
      },
      replyStreamNonBlocking: async () => {},
      sendMessage: async () => {
        activeTextAttempts += 1;
        throw new Error('active text unavailable');
      },
      uploadMedia: async () => ({ media_id: 'media-after-text-failure' }),
      sendMediaMessage: async (chatId, type, mediaId) => {
        files.push({ chatId, type, mediaId });
        return { body: { msgid: 'wecom-file-after-text-failure' } };
      },
    },
    generateStreamId: () => 'text-failure-stream',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '文字结果';
      },
    },
    state: state(),
    logger: { warn() {}, error() {} },
  });

  await bridge.accept(frame({ msgid: 'wecom-text-failure' }));

  assert.deepEqual(files, [{
    chatId: 'member-1',
    type: 'file',
    mediaId: 'media-after-text-failure',
  }]);
  assert.equal(finalTextAttempts, 1, 'must not append a generic retry stream after file success');
  assert.equal(activeTextAttempts, 1);
  assert.equal(bridge.status.lastMessageError.code, 'CHANNEL_DELIVERY_UNCERTAIN');
  assert.match(bridge.status.lastMessageError.referenceId, /^MF-[A-F0-9]{8}$/);
});

test('Enterprise WeChat returns the authoritative receipt and one safe notice when text and file delivery fail', async (t) => {
  const artifact = await committedArtifact(t, 'mismatch.txt', 'file bytes', 'all-fail');
  const attemptedActiveTexts = [];
  const visibleActiveTexts = [];
  const finalStreamTexts = [];
  const bridge = new WecomHarnessBridge({
    client: {
      replyStream: async (_source, _streamId, content, finish) => {
        if (finish) {
          finalStreamTexts.push(content);
          throw new Error('stream finalization unavailable');
        }
      },
      replyStreamNonBlocking: async () => {},
      sendMessage: async (_chatId, body) => {
        const text = body.markdown.content;
        attemptedActiveTexts.push(text);
        if (text === '文字结果') throw new Error('active text unavailable');
        visibleActiveTexts.push(text);
        return {};
      },
      uploadMedia: async () => {
        const error = new Error('mismatched file signature');
        error.code = 'artifact-invalid';
        throw error;
      },
      sendMediaMessage: async () => assert.fail('a rejected upload must not be sent'),
    },
    generateStreamId: () => 'all-fail-stream',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '文字结果';
      },
    },
    state: state(),
    logger: { warn() {}, error() {} },
  });

  const receipt = await bridge.accept(frame({ msgid: 'wecom-all-fail' }));

  assert.deepEqual(finalStreamTexts, ['文字结果']);
  assert.equal(attemptedActiveTexts.length, 2, 'must not append a generic error after the safe notice');
  assert.equal(visibleActiveTexts.length, 1);
  assert.match(visibleActiveTexts[0], /暂时无法读取或准备发送.*仍可访问/);
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    deliveryId: 'wecom-all-fail',
    presentation: 'wecom-files',
    providerMessageIds: [],
    artifacts: [{
      artifactId: artifact.artifactId,
      outcome: 'rejected',
      reason: 'artifact-invalid',
    }],
  });
});

test('Enterprise WeChat keeps the generic error when no answer or file failure notice is visible', async (t) => {
  const artifact = await committedArtifact(t, 'unavailable.txt', 'file bytes', 'no-visible-failure');
  const attemptedActiveTexts = [];
  const finalStreamTexts = [];
  const bridge = new WecomHarnessBridge({
    client: {
      replyStream: async (_source, _streamId, content, finish) => {
        if (!finish) return;
        finalStreamTexts.push(content);
        if (finalStreamTexts.length === 1) throw new Error('stream finalization unavailable');
      },
      replyStreamNonBlocking: async () => {},
      sendMessage: async (_chatId, body) => {
        attemptedActiveTexts.push(body.markdown.content);
        throw new Error('active text unavailable');
      },
      uploadMedia: async () => {
        const error = new Error('file transport unavailable');
        error.code = 'artifact-provider-failed';
        throw error;
      },
      sendMediaMessage: async () => assert.fail('a rejected upload must not be sent'),
    },
    generateStreamId: () => 'no-visible-failure-stream',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '文字结果';
      },
    },
    state: state(),
    logger: { warn() {}, error() {} },
  });

  await bridge.accept(frame({ msgid: 'wecom-no-visible-failure' }));

  assert.equal(attemptedActiveTexts.length, 2);
  assert.equal(finalStreamTexts[0], '文字结果');
  assert.match(
    finalStreamTexts[1],
    /^回复发送结果未能确认/,
  );
  assert.match(finalStreamTexts[1], /错误码：CHANNEL_DELIVERY_UNCERTAIN；参考号：MF-[A-F0-9]{8}$/);
});

test('Enterprise WeChat reports an unacknowledged file message as uncertain', async (t) => {
  const artifact = await committedArtifact(t, 'uncertain.txt', 'file bytes', 'uncertain');
  const active = [];
  const bridge = new WecomHarnessBridge({
    client: {
      replyStream: async () => {},
      replyStreamNonBlocking: async () => {},
      sendMessage: async (_chatId, body) => active.push(body.markdown.content),
      uploadMedia: async () => ({ media_id: 'media-uncertain' }),
      sendMediaMessage: async () => new Promise(() => {}),
    },
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '文件已生成。';
      },
    },
    state: state(),
    fileUploadTimeoutMs: 20,
    logger: { warn() {}, error() {} },
  });

  await bridge.accept(frame({ msgid: 'wecom-uncertain-file' }));

  assert.match(active[0], /发送结果未能确认.*先检查聊天内是否已收到.*不要立即重试/);
});

test('Enterprise WeChat cancellation interrupts an in-flight file send and skips later files', async (t) => {
  const first = await committedArtifact(t, 'first.txt', 'first', 'abort-first');
  const second = await committedArtifact(t, 'second.txt', 'second', 'abort-second');
  const started = deferred();
  const controller = new AbortController();
  const uploads = [];
  const active = [];
  const bridge = new WecomHarnessBridge({
    client: {
      replyStream: async () => {},
      replyStreamNonBlocking: async () => {},
      sendMessage: async (_chatId, body) => active.push(body.markdown.content),
      uploadMedia: async (_bytes, options) => {
        uploads.push(options.filename);
        return { media_id: `media-${options.filename}` };
      },
      sendMediaMessage: async () => {
        started.resolve();
        return new Promise(() => {});
      },
    },
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(first);
        await options.onArtifact(second);
        return '文件如下。';
      },
    },
    state: state(),
    signal: controller.signal,
    logger: { warn() {}, error() {} },
  });

  const processing = bridge.accept(frame({ msgid: 'wecom-abort-file' }));
  await started.promise;
  controller.abort(new DOMException('runtime stopped', 'AbortError'));
  await Promise.race([
    processing,
    new Promise((_, reject) => setTimeout(() => reject(new Error('WeCom abort timed out')), 500)),
  ]);

  assert.deepEqual(uploads, ['first.txt']);
  assert.equal(active.some((text) => text.includes('发送结果未能确认')), false);
  assert.equal(active.some((text) => text === '消息处理失败，请稍后重试。'), false);
});

test('Enterprise WeChat uses a neutral final text for a file-only Turn', async (t) => {
  const artifact = await committedArtifact(t, 'only.txt', 'only bytes', 'file-only');
  const finalTexts = [];
  const files = [];
  const bridge = new WecomHarnessBridge({
    client: {
      replyStream: async (_source, _streamId, content, finish) => {
        if (finish) finalTexts.push(content);
      },
      replyStreamNonBlocking: async () => {},
      sendMessage: async () => {},
      uploadMedia: async () => ({ media_id: 'media-only' }),
      sendMediaMessage: async (chatId, type, mediaId) => {
        files.push({ chatId, type, mediaId });
        return {};
      },
    },
    generateStreamId: () => 'file-only-stream',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '';
      },
    },
    state: state(),
  });

  await bridge.accept(frame({ msgid: 'wecom-file-only' }));

  assert.deepEqual(finalTexts, ['结果文件已生成。']);
  assert.deepEqual(files, [{ chatId: 'member-1', type: 'file', mediaId: 'media-only' }]);
});

test('Enterprise WeChat cancellation prevents SDK upload', async (t) => {
  let uploads = 0;
  const artifact = await committedArtifact(t, 'cancelled.txt', 'cancelled bytes', 'cancelled');
  const controller = new AbortController();
  const cancelledBridge = new WecomHarnessBridge({
    client: {
      replyStream: async () => {},
      replyStreamNonBlocking: async () => {},
      sendMessage: async () => {},
      uploadMedia: async () => { uploads += 1; return { media_id: 'must-not-upload' }; },
      sendMediaMessage: async () => {},
    },
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        controller.abort(new DOMException('stopped', 'AbortError'));
        return '停止前的回答';
      },
    },
    state: state(),
    signal: controller.signal,
  });
  await cancelledBridge.accept(frame({ msgid: 'wecom-artifact-cancelled' }));
  assert.equal(uploads, 0);
});

test('Enterprise WeChat batch input collects ten texts and submits one ordered Harness turn', async () => {
  const transport = testClient();
  const prompts = [];
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    generateStreamId: () => 'batch-stream',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, prompt) => {
        prompts.push(prompt);
        return '批量完成';
      },
    },
    state: state(),
  });

  await bridge.accept(frame({ msgid: 'batch-start', text: { content: '/batch' } }));
  await bridge.accept(frame({
    msgid: 'batch-quote',
    text: { content: '企微引用不能收录' },
    quote: { msgtype: 'text', text: { content: '被引用内容' } },
  }));
  for (let index = 1; index <= 10; index += 1) {
    await bridge.accept(frame({
      msgid: `batch-item-${index}`,
      text: { content: `企微内容 ${index}` },
    }));
  }
  await bridge.accept(frame({ msgid: 'batch-overflow', text: { content: '不会收录' } }));

  assert.equal(prompts.length, 0);
  assert.equal(transport.streamed.some(({ content }) => /引用消息.*未收录/s.test(content)), true);
  assert.equal(transport.streamed.some(({ content }) => /10\/10.*已满/.test(content)), true);
  assert.equal(transport.streamed.some(({ content }) => /这条消息未收录/.test(content)), true);

  await bridge.accept(frame({ msgid: 'batch-send', text: { content: '/send' } }));
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /\[消息 1\]\n企微内容 1/);
  assert.match(prompts[0], /\[消息 10\]\n企微内容 10/);
  assert.doesNotMatch(prompts[0], /企微引用不能收录|不会收录/);
  assert.equal(transport.streamed.at(-1).content, '批量完成');
});

test('Enterprise WeChat rejects batch commands in groups without invoking Harness', async () => {
  const transport = testClient();
  let asks = 0;
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    harness: { ask: async () => { asks += 1; return 'unexpected'; } },
    state: state(),
  });

  for (const [index, command] of ['/batch', '/send', '/cancel'].entries()) {
    await bridge.accept(frame({
      msgid: `group-batch-${index}`,
      chattype: 'group',
      chatid: 'group-batch',
      text: { content: `@机器人 ${command}` },
    }));
  }

  assert.equal(asks, 0);
  assert.equal(transport.streamed.length, 3);
  assert.equal(transport.streamed.every(({ content }) => /仅支持私聊/.test(content)), true);
});

test('Enterprise WeChat keeps a failed batch for retry and queues later ordinary messages normally', async () => {
  const transport = testClient();
  const firstBatch = deferred();
  const prompts = [];
  let failFirst = true;
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    generateStreamId: (() => { let index = 0; return () => `batch-retry-${++index}`; })(),
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, prompt) => {
        prompts.push(prompt);
        if (failFirst) {
          failFirst = false;
          throw new Error('temporary failure');
        }
        if (/\[消息 1\]/.test(prompt)) await firstBatch.promise;
        return `完成：${prompt}`;
      },
    },
    state: state(),
    logger: { warn() {}, error() {} },
  });

  await bridge.accept(frame({ msgid: 'retry-start', text: { content: '/batch' } }));
  await bridge.accept(frame({ msgid: 'retry-content', text: { content: '需要重试' } }));
  await bridge.accept(frame({ msgid: 'retry-send-1', text: { content: '/send' } }));
  assert.match(transport.streamed.at(-1).content, /错误码：INTERNAL_UNKNOWN.*已保留 1 条消息/s);

  const retry = bridge.accept(frame({ msgid: 'retry-send-2', text: { content: '/send' } }));
  await eventually(() => prompts.length === 2);
  const ordinary = bridge.accept(frame({
    msgid: 'ordinary-after-send',
    text: { content: '提交期间的普通消息' },
  }));
  assert.equal(prompts.length, 2);

  firstBatch.resolve();
  await Promise.all([retry, ordinary]);
  assert.equal(prompts.length, 3);
  assert.equal(prompts[2], '提交期间的普通消息');

  await bridge.accept(frame({ msgid: 'cancel-start', text: { content: '/batch' } }));
  await bridge.accept(frame({ msgid: 'cancel-content', text: { content: '丢弃' } }));
  await bridge.accept(frame({ msgid: 'cancel-command', text: { content: '/cancel' } }));
  assert.match(transport.streamed.at(-1).content, /已取消批量输入.*丢弃 1 条消息/s);
});

test('Enterprise WeChat clears a submitted batch when the Harness turn is stopped', async () => {
  const transport = testClient();
  const bridge = new WecomHarnessBridge({
    client: transport.client,
    harness: {
      sessionExists: async () => true,
      ask: async () => {
        const error = new Error('turn stopped');
        error.code = 'turn-stopped';
        throw error;
      },
    },
    state: state(),
  });

  await bridge.accept(frame({ msgid: 'stopped-start', text: { content: '/batch' } }));
  await bridge.accept(frame({ msgid: 'stopped-content', text: { content: '不要重试' } }));
  await bridge.accept(frame({ msgid: 'stopped-send', text: { content: '/send' } }));
  assert.equal(transport.streamed.some(({ content }) => /已保留/.test(content)), false);

  await bridge.accept(frame({ msgid: 'stopped-cancel', text: { content: '/cancel' } }));
  assert.match(transport.streamed.at(-1).content, /没有正在进行的批量输入/);
});
