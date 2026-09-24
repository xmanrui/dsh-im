import { loadDeferredImages } from '../../helpers/deferred-images.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createWeixinBridgeStatus,
  weixinInboundMessage,
  WeixinHarnessBridge,
} from '../../../src/channels/weixin/weixin-bridge.mjs';
import { WeixinStateStore } from '../../../src/channels/weixin/state-store.mjs';
import { connectionTestTarget } from '../../../src/channels/shared/connection-test.mjs';
import { HarnessRpcError } from '../../../src/channels/shared/harness-client.mjs';
import {
  OUTBOUND_ARTIFACT_TOOL,
  OutboundArtifactRegistry,
  createOutboundArtifactTool,
  releaseOutboundArtifact,
} from '../../../src/channels/shared/semantic/artifact.mjs';
import {
  COMMAND_PERMISSION_DENIED_MESSAGE,
  directAccessPolicy,
} from '../access-policy-fixture.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function eventually(predicate, messageText = 'condition was not met', timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(messageText);
}

async function within(promise, milliseconds, messageText) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(messageText)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function message(id, text, overrides = {}) {
  return {
    message_id: id,
    message_type: 1,
    from_user_id: 'owner-user',
    context_token: `context-${id}`,
    item_list: [{ type: 1, text_item: { text } }],
    ...overrides,
  };
}

test('Weixin bridge sends ref_msg context to Harness but does not execute quoted commands', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-quote');
  let clears = 0;
  let prompt;
  fixture.state.clearSession = async () => { clears += 1; };
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async () => ({ messageId: 'weixin-quote-answer' }) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, content) => { prompt = content; return '已处理'; },
    },
    state: fixture.state,
  });

  await bridge.accept(message('weixin-quote-prompt', '这条指令是什么意思？', {
    item_list: [{
      type: 1,
      text_item: { text: '这条指令是什么意思？' },
      ref_msg: {
        message_item: {
          type: 1,
          msg_id: 'quoted-command',
          text_item: { text: '/new' },
        },
      },
    }],
  }));

  assert.equal(clears, 0);
  assert.equal(Array.isArray(prompt), true);
  assert.match(prompt[0].text, /<dsh_im_reply_to>/);
  assert.match(prompt[0].text, /"content":"\/new"/);
  assert.deepEqual(prompt.at(-1), { type: 'text', text: '这条指令是什么意思？' });
});

test('Weixin bridge restores a metadata-only bot quote from its recent outbound index', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-weixin-quote-index-'));
  const state = await new WeixinStateStore(join(root, 'state.json')).load();
  await state.setSession('p2p:owner-user', 'session-quote-index');
  const prompts = [];
  let sends = 0;
  const bridge = new WeixinHarnessBridge({
    api: {
      sendText: async () => ({ messageId: `outbound-${++sends}` }),
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, content) => {
        prompts.push(content);
        return prompts.length === 1 ? 'deepseek-v4-flash' : '已识别引用';
      },
    },
    state,
  });

  await bridge.accept(message('weixin-original-question', '这是什么模型？'));
  const remembered = state.snapshot().recentOutboundMessages.at(-1);
  assert.equal(remembered.text, 'deepseek-v4-flash');

  await bridge.accept(message('weixin-metadata-quote', '这里说的是什么模型？', {
    item_list: [{
      type: 1,
      text_item: { text: '这里说的是什么模型？' },
      ref_msg: {
        message_item: {
          type: 8,
          create_time_ms: remembered.sentAt,
          update_time_ms: remembered.completedAt,
        },
      },
    }],
  }));

  assert.match(prompts[1][0].text, /<dsh_im_reply_to>/);
  assert.match(prompts[1][0].text, /"content":"deepseek-v4-flash"/);
  await rm(root, { recursive: true, force: true });
});

test('Weixin bridge recovers a pre-index bot quote from bounded Session history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-weixin-quote-history-'));
  const state = await new WeixinStateStore(join(root, 'state.json')).load();
  await state.setSession('p2p:owner-user', 'session-quote-history');
  const quotedAt = Date.now() - 2_000;
  const quotedMessageId = ((BigInt(quotedAt) << 22n) | 456n).toString();
  const prompts = [];
  const historyReads = [];
  const session = {
    sessionExists: async () => true,
    readHistory: async (options) => {
      historyReads.push(options);
      return {
        events: [{ event: {
          type: 'assistant/message',
          seq: 10,
          time: quotedAt - 7_400,
          data: {
            turn: 1,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'DeepSeek V4 Flash' }],
            },
          },
        } }, { event: {
          type: 'turn/end',
          seq: 11,
          time: quotedAt - 7_399,
          data: { turn: 1, reason: { kind: 'completed' } },
        } }],
        hasMore: false,
      };
    },
    ask: async (content) => {
      prompts.push(content);
      return '已识别旧引用';
    },
  };
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async () => ({ messageId: 'history-answer' }) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: { workspaceSession: () => session },
    state,
  });

  await bridge.accept(message('weixin-history-quote', '说的是什么模型？', {
    item_list: [{
      type: 1,
      text_item: { text: '说的是什么模型？' },
      ref_msg: {
        message_item: { type: 7, msg_id: quotedMessageId },
      },
    }],
  }));

  assert.equal(historyReads.length, 1);
  assert.match(prompts[0][0].text, /"content":"DeepSeek V4 Flash"/);
  assert.doesNotMatch(prompts[0][0].text, /unavailableReason/);
  assert.equal(state.recentOutboundTextFor({
    toUserId: 'owner-user', messageId: quotedMessageId,
  }), 'DeepSeek V4 Flash');
  await rm(root, { recursive: true, force: true });
});

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

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x01, 0x02, 0x03,
]);

test('Weixin bridge normalization keeps native file items separate from images', async () => {
  const bytes = Buffer.from('weixin-file');
  const source = { name: '微信文档.docx', load: async () => bytes };
  const calls = [];
  const inbound = weixinInboundMessage(message('weixin-file', '', {
    item_list: [{ type: 4, file_item: { file_name: '微信文档.docx', media: {} } }],
  }), {
    inboundImages: () => [],
    inboundFiles: (value) => {
      calls.push(value);
      return [source];
    },
  });

  assert.equal(inbound.content, '');
  assert.deepEqual(inbound.images, []);
  assert.deepEqual(inbound.files, [source]);
  assert.equal(calls.length, 1);
  assert.deepEqual(await inbound.files[0].load({}), bytes);
});

test('Weixin bridge hands a native file source to the current Harness turn', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-native-file');
  const bytes = Buffer.from('weixin-bridge-file');
  const prompts = [];
  const sent = [];
  const bridge = new WeixinHarnessBridge({
    api: {
      inboundImages: () => [],
      inboundFiles: () => [{ name: '微信报告.zip', load: async () => bytes }],
      sendText: async ({ text }) => sent.push(text),
    },
    baseUrl: 'https://ilinkai.weixin.qq.com',
    token: 'token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async (sessionId, prompt, options) => {
        prompts.push({
          sessionId,
          prompt,
          name: options.files[0].name,
          bytes: await options.files[0].load({ signal: options.signal }),
        });
        return '文件已收到';
      },
    },
    state: fixture.state,
    status: createWeixinBridgeStatus(),
  });

  await bridge.accept(message('weixin-native-file-turn', '', {
    item_list: [{
      type: 4,
      file_item: { file_name: '微信报告.zip', media: {} },
    }],
  }));

  assert.deepEqual(prompts, [{
    sessionId: 'session-native-file',
    prompt: '',
    name: '微信报告.zip',
    bytes,
  }]);
  assert.deepEqual(sent, ['文件已收到']);
});

test('Weixin splits long replies below the iLink text limit', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-long-reply');
  const chunks = [];
  const answer = '答案'.repeat(1_000);
  const bridge = new WeixinHarnessBridge({
    api: {
      sendText: async ({ text }) => {
        chunks.push(text);
        return { messageId: `weixin-long-${chunks.length}` };
      },
    },
    baseUrl: 'https://ilinkai.weixin.qq.com',
    token: 'token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async () => answer,
    },
    state: fixture.state,
  });

  const receipt = await bridge.accept(message('weixin-long-reply', '生成一段长回答'));

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 1_800));
  assert.equal(chunks.join(''), answer);
  assert.equal(receipt.providerMessageIds.length, chunks.length);
  assert.equal(bridge.status.messagesReplied, 1);
  assert.equal(bridge.status.lastMessageError, null);
});

test('Weixin reports safe chunk diagnostics when a long reply is rejected', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-long-reply-rejected');
  const answer = '答'.repeat(2_000);
  const attempts = [];
  const status = createWeixinBridgeStatus();
  const bridge = new WeixinHarnessBridge({
    api: {
      sendText: async ({ text }) => {
        attempts.push(text);
        if (text === answer.slice(1_800)) {
          const error = new Error('private provider detail with token-shaped-value');
          error.code = 'send-rejected';
          error.providerCode = '-2';
          throw error;
        }
        return { messageId: `weixin-long-${attempts.length}` };
      },
    },
    baseUrl: 'https://ilinkai.wechat.com/',
    token: 'private-host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async () => answer,
    },
    state: fixture.state,
    status,
    logger: { error() {} },
  });

  await bridge.accept(message('weixin-long-reply-rejected', '生成一段长回答'));

  const failure = status.lastMessageError;
  assert.equal(failure.code, 'CHANNEL_DELIVERY_UNCERTAIN');
  assert.equal(failure.reason, 'WEIXIN_SEND_FAILED');
  assert.match(failure.message, /可能只收到部分内容/);
  assert.match(failure.message, /endpoint=sendmessage/);
  assert.match(failure.message, /host=ilinkai\.wechat\.com/);
  assert.match(failure.message, /chunk=2\/2/);
  assert.match(failure.message, /chunkChars=200/);
  assert.match(failure.message, /chunkUtf8Bytes=600/);
  assert.match(failure.message, /totalChars=2000/);
  assert.match(failure.message, /totalUtf8Bytes=6000/);
  assert.match(failure.message, /limitChars=1800/);
  assert.match(failure.message, /contextToken=yes/);
  assert.match(failure.message, /runId=no/);
  assert.match(failure.message, /http=2xx/);
  assert.match(failure.message, /provider=-2/);
  assert.match(failure.message, /cause=send-rejected/);
  assert.match(attempts.at(-1), /微信发送诊断：/);
  assert.match(attempts.at(-1), /错误码：CHANNEL_DELIVERY_UNCERTAIN/);
  assert.doesNotMatch(
    JSON.stringify({ failure, safeReply: attempts.at(-1) }),
    /private provider detail|token-shaped-value|private-host-token|context-weixin/,
  );
});

test('Weixin starts a native-file download before an earlier queued turn finishes', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-prefetch-file');
  const firstTurn = deferred();
  const bytes = Buffer.from('weixin-prefetched-file');
  let asks = 0;
  let downloads = 0;
  const bridge = new WeixinHarnessBridge({
    api: {
      inboundImages: () => [],
      inboundFiles: (value) => value.item_list?.some((item) => item.file_item)
        ? [{
            name: 'queued.bin',
            load: async () => {
              downloads += 1;
              return bytes;
            },
          }]
        : [],
      sendText: async () => {},
    },
    baseUrl: 'https://ilinkai.weixin.qq.com',
    token: 'token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _prompt, options) => {
        asks += 1;
        if (asks === 1) return firstTurn.promise;
        assert.deepEqual(await options.files[0].load({ signal: options.signal }), bytes);
        return '第二条完成';
      },
    },
    state: fixture.state,
  });

  const first = bridge.accept(message('weixin-prefetch-first', '先等待'));
  await eventually(() => asks === 1, 'busy turn did not start before /batch assertion', 5_000);
  const second = bridge.accept(message('weixin-prefetch-second', '', {
    item_list: [{
      type: 4,
      file_item: { file_name: 'queued.bin', media: {} },
    }],
  }));

  await eventually(() => downloads === 1, 'queued Weixin file did not start downloading');
  assert.equal(asks, 1, 'the second Harness turn must remain queued');
  firstTurn.resolve('第一条完成');
  await Promise.all([first, second]);
});

async function committedArtifact(t, fileName, content) {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-im-weixin-artifact-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const registry = new OutboundArtifactRegistry({ uuid: () => 'weixin-artifact-one' });
  t.after(() => registry.clear());
  const agent = {
    session: {
      header: { id: 'artifact-session', cwd: workspace },
      events: [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { turn: 1, source: { rpcId: 'artifact-rpc' } } },
      ],
    },
  };
  await writeFile(join(workspace, fileName), content);
  const tool = createOutboundArtifactTool({ registry });
  const exec = {
    name: OUTBOUND_ARTIFACT_TOOL,
    callId: 'weixin-artifact-call',
    rootCallId: 'weixin-artifact-call',
    token: Symbol('weixin-artifact-call'),
    agent,
  };
  await tool.definition.execute({ path: fileName }, exec);
  tool.onResult(exec, { isError: false });
  const artifact = registry.take('artifact-session', 1)[0];
  t.after(() => releaseOutboundArtifact(artifact));
  return artifact;
}

test('Weixin remembers any authorized private inbound as a connection-test target', async () => {
  const fixture = stateFixture();
  const sent = [];
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: { ensureRunning: async () => true },
    state: fixture.state,
  });

  await bridge.accept(message('help-owner', '/help'));
  assert.deepEqual(connectionTestTarget(fixture.state), { toUserId: 'owner-user' });
  assert.match(sent.at(-1).text, /\/help/);

  const rejectedFixture = stateFixture();
  const rejectedBridge = new WeixinHarnessBridge({
    api: { sendText: async () => assert.fail('unauthorized message must not be answered') },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: { ensureRunning: async () => true },
    state: rejectedFixture.state,
  });
  await rejectedBridge.accept(message('help-other', '/help', { from_user_id: 'other-user' }));
  assert.equal(connectionTestTarget(rejectedFixture.state), null);
});

test('Weixin returns a registered result file with native context after its existing text path', async (t) => {
  const artifact = await committedArtifact(t, 'result.txt', 'weixin-result');
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-artifact');
  const order = [];
  const bridge = new WeixinHarnessBridge({
    api: {
      inboundImages: () => [],
      sendText: async ({ text }) => {
        order.push(`text:${text}`);
        return { messageId: 'weixin-text-one' };
      },
      sendFile: async (request) => {
        order.push(`file:${request.file.fileName}`);
        assert.equal(request.toUserId, 'owner-user');
        assert.equal(request.contextToken, 'context-weixin-artifact');
        assert.equal(request.runId, 'run-artifact');
        assert.equal(request.file.bytes.toString(), 'weixin-result');
        return { messageId: 'weixin-file-one' };
      },
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '';
      },
    },
    state: fixture.state,
  });

  const receipt = await bridge.accept(message(
    'weixin-artifact',
    '生成文件',
    { run_id: 'run-artifact' },
  ));

  assert.deepEqual(order, ['text:结果文件已生成。', 'file:result.txt']);
  assert.equal(bridge.status.artifactsSent, 1);
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    deliveryId: 'weixin-artifact',
    presentation: 'weixin-text-and-files',
    providerMessageIds: ['weixin-text-one', 'weixin-file-one'],
    artifacts: [{ artifactId: 'weixin-artifact-one', outcome: 'sent' }],
  });
});

test('Weixin routes Artifact images natively and preserves the shared fallback boundary', async (t) => {
  const scenarios = [
    {
      name: 'native image',
      fileName: 'native.png',
      content: PNG_BYTES,
      expectedCalls: ['image'],
      expectedPresentation: 'weixin-image',
      expectedProviderIds: ['weixin-native-image'],
    },
    {
      name: 'ordinary file',
      fileName: 'ordinary.txt',
      content: 'ordinary file',
      expectedCalls: ['file'],
      expectedPresentation: 'weixin-file',
      expectedProviderIds: ['weixin-native-file'],
    },
    {
      name: 'definite image rejection falls back',
      fileName: 'fallback.png',
      content: PNG_BYTES,
      imageError: 'artifact-provider-rejected',
      expectedCalls: ['image', 'file'],
      expectedPresentation: 'weixin-file',
      expectedProviderIds: ['weixin-native-file'],
    },
    {
      name: 'uncertain image never falls back',
      fileName: 'uncertain.png',
      content: PNG_BYTES,
      imageError: 'artifact-delivery-uncertain',
      expectedCalls: ['image'],
      expectedPresentation: 'text-fallback',
      expectedProviderIds: [],
      expectedOutcome: 'unknown',
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    await t.test(scenario.name, async (subtest) => {
      const artifact = await committedArtifact(subtest, scenario.fileName, scenario.content);
      const fixture = stateFixture();
      fixture.sessions.set('p2p:owner-user', `session-image-route-${index}`);
      const calls = [];
      const bridge = new WeixinHarnessBridge({
        api: {
          inboundImages: () => [],
          sendText: async () => { throw new Error('text intentionally unavailable'); },
          sendImage: async ({ file }) => {
            calls.push('image');
            assert.equal(file.fileName, scenario.fileName);
            assert.equal(file.mediaType, 'image/png');
            if (scenario.imageError) {
              const error = new Error('private image result');
              error.code = scenario.imageError;
              throw error;
            }
            return { messageId: 'weixin-native-image' };
          },
          sendFile: async ({ file }) => {
            calls.push('file');
            assert.equal(file.fileName, scenario.fileName);
            return { messageId: 'weixin-native-file' };
          },
        },
        baseUrl: 'https://ilinkai.weixin.qq.com/',
        token: 'host-token',
        ownerUserId: 'owner-user',
        harness: {
          sessionExists: async () => true,
          ask: async (_sessionId, _text, options) => {
            await options.onArtifact(artifact);
            return '';
          },
        },
        state: fixture.state,
        logger: { warn() {}, error() {} },
      });

      const receipt = await bridge.accept(message(`weixin-image-route-${index}`, '生成产物'));

      assert.deepEqual(calls, scenario.expectedCalls);
      assert.equal(receipt.presentation, scenario.expectedPresentation);
      assert.deepEqual(receipt.providerMessageIds, scenario.expectedProviderIds);
      assert.deepEqual(receipt.artifacts, [{
        artifactId: artifact.artifactId,
        outcome: scenario.expectedOutcome ?? 'sent',
        ...(scenario.imageError === 'artifact-delivery-uncertain'
          ? { reason: 'artifact-delivery-uncertain' }
          : {}),
      }]);
      assert.equal(bridge.status.artifactsSent, scenario.expectedOutcome === 'unknown' ? 0 : 1);
      assert.equal(bridge.status.artifactSendErrors, scenario.expectedOutcome === 'unknown' ? 1 : 0);
    });
  }
});

test('Weixin still attempts a registered file when the final text transport fails', async (t) => {
  const artifact = await committedArtifact(t, 'weixin-text-failed.txt', 'weixin-file');
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-artifact-text-failed');
  const files = [];
  let textAttempts = 0;
  const bridge = new WeixinHarnessBridge({
    api: {
      inboundImages: () => [],
      sendText: async () => {
        textAttempts += 1;
        throw new Error('private text failure');
      },
      sendFile: async ({ file }) => {
        files.push(file.fileName);
        return { messageId: 'weixin-file-after-text-failure' };
      },
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '文字回答';
      },
    },
    state: fixture.state,
  });

  const receipt = await bridge.accept(message('weixin-artifact-text-failed', '生成文件'));

  assert.deepEqual(files, ['weixin-text-failed.txt']);
  assert.equal(textAttempts, 1, 'must not send a generic retry notice after the file succeeds');
  assert.equal(bridge.status.artifactsSent, 1);
  assert.equal(bridge.status.lastMessageError.code, 'CHANNEL_DELIVERY_UNCERTAIN');
  assert.match(bridge.status.lastMessageError.referenceId, /^MF-[A-F0-9]{8}$/);
  assert.deepEqual(receipt.providerMessageIds, ['weixin-file-after-text-failure']);
  assert.deepEqual(receipt.artifacts, [{ artifactId: 'weixin-artifact-one', outcome: 'sent' }]);
});

test('Weixin tells users to inspect the chat instead of retrying an uncertain file delivery', async (t) => {
  const artifact = await committedArtifact(t, 'weixin-uncertain.txt', 'weixin-file');
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-artifact-uncertain');
  const sent = [];
  const bridge = new WeixinHarnessBridge({
    api: {
      inboundImages: () => [],
      sendText: async ({ text }) => {
        sent.push(text);
        return { messageId: `weixin-text-${sent.length}` };
      },
      sendFile: async () => {
        const error = new Error('private provider transport detail');
        error.code = 'artifact-delivery-uncertain';
        throw error;
      },
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '';
      },
    },
    state: fixture.state,
    logger: { warn() {}, error() {} },
  });

  const receipt = await bridge.accept(message('weixin-artifact-uncertain', '生成文件'));

  const failure = bridge.status.lastMessageError;
  assert.match(sent.at(-1), /^结果文件「weixin-uncertain\.txt」发送结果未能确认/);
  assert.equal(failure.code, 'CHANNEL_DELIVERY_UNCERTAIN');
  assert.equal(failure.reason, 'ARTIFACT_DELIVERY_UNCERTAIN');
  assert.equal(sent.at(-1).endsWith(`参考号：${failure.referenceId}`), true);
  assert.doesNotMatch(sent.join('\n'), /private provider transport detail/);
  assert.equal(bridge.status.artifactSendErrors, 1);
  assert.deepEqual(receipt.artifacts, [{
    artifactId: 'weixin-artifact-one',
    outcome: 'unknown',
    reason: 'artifact-delivery-uncertain',
  }]);
});

test('Weixin explains that an upload timeout happened before the file was sent', async (t) => {
  const artifact = await committedArtifact(t, 'large.zip', 'weixin-file');
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-upload-timeout');
  const sent = [];
  const bridge = new WeixinHarnessBridge({
    api: {
      inboundImages: () => [],
      sendText: async ({ text }) => {
        sent.push(text);
        return { messageId: `weixin-text-${sent.length}` };
      },
      sendFile: async () => {
        throw Object.assign(new Error('private CDN URL and token'), { code: 'artifact-upload-timeout' });
      },
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '';
      },
    },
    state: fixture.state,
    logger: { warn() {}, error() {} },
  });

  const receipt = await bridge.accept(message('weixin-upload-timeout', '发文件'));
  const failure = bridge.status.lastMessageError;
  assert.match(sent.at(-1), /上传微信.*超时，文件尚未发送/);
  assert.match(sent.at(-1), /检查网络/);
  assert.doesNotMatch(sent.join('\n'), /private CDN URL and token/);
  assert.equal(failure.code, 'CHANNEL_DELIVERY');
  assert.equal(failure.reason, 'ARTIFACT_UPLOAD_TIMEOUT');
  assert.equal(bridge.status.artifactsSent, 0);
  assert.equal(bridge.status.artifactSendErrors, 1);
  assert.deepEqual(receipt.artifacts, [{
    artifactId: artifact.artifactId,
    outcome: 'failed',
    reason: 'artifact-upload-timeout',
  }]);
});

test('Weixin sends image-only messages to Harness as structured content', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-image');
  const prompts = [];
  const sent = [];
  const bridge = new WeixinHarnessBridge({
    api: {
      inboundImages: () => [{ name: 'image', data: PNG_BYTES }],
      sendText: async (request) => sent.push(request),
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async (sessionId, content, options) => {
        content = await loadDeferredImages(content, options);
        prompts.push({ sessionId, content });
        return '微信图片已识别';
      },
    },
    state: fixture.state,
  });

  await bridge.accept(message('weixin-image', '', {
    item_list: [{ type: 2, image_item: { media: {} } }],
  }));

  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].sessionId, 'session-image');
  assert.deepEqual(prompts[0].content.map(({ type }) => type), ['text', 'image']);
  assert.equal(prompts[0].content[0].text, '请分析这张图片。');
  assert.equal(prompts[0].content[1].mediaType, 'image/png');
  assert.equal(Buffer.from(prompts[0].content[1].data, 'base64').equals(PNG_BYTES), true);
  assert.equal(sent.at(-1).text, '微信图片已识别');
  assert.equal(sent.at(-1).contextToken, 'context-weixin-image');
  assert.equal(fixture.seen.has('weixin-image'), true);
});

test('Weixin authorizes the sender before resolving encrypted image references', async () => {
  let imageExtractions = 0;
  let asks = 0;
  const bridge = new WeixinHarnessBridge({
    api: {
      inboundImages: () => { imageExtractions += 1; return [{ data: PNG_BYTES }]; },
      sendText: async () => assert.fail('an unauthorized sender must not receive a reply'),
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: { ask: async () => { asks += 1; return 'unexpected'; } },
    state: stateFixture().state,
  });

  await bridge.accept(message('weixin-image-other', '', {
    from_user_id: 'other-user',
    item_list: [{ type: 2, image_item: { media: {} } }],
  }));

  assert.equal(imageExtractions, 0);
  assert.equal(asks, 0);
});

test('Weixin applies the unified access policy before attachments or Harness work', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:member-user', 'session-member');
  let imageExtractions = 0;
  const harnessCalls = [];
  const sent = [];
  const accessPolicy = directAccessPolicy({
    users: [{ id: 'member-user', canExecuteCommands: false }],
    privilegedIds: ['owner-user'],
  });
  const bridge = new WeixinHarnessBridge({
    api: {
      inboundImages: (value) => {
        imageExtractions += 1;
        return value?.item_list?.some((item) => item?.image_item) ? [{ data: PNG_BYTES }] : [];
      },
      sendText: async (request) => sent.push(request.text),
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
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
    state: fixture.state,
  });

  await bridge.accept(message('policy-blocked-image', '', {
    from_user_id: 'blocked-user',
    item_list: [{ type: 2, image_item: { media: {} } }],
  }));
  assert.equal(imageExtractions, 0);
  assert.deepEqual(harnessCalls, []);
  assert.deepEqual(sent, []);

  await bridge.accept(message('policy-member-text', '普通消息', {
    from_user_id: 'member-user',
  }));
  assert.equal(harnessCalls.some(([operation]) => operation === 'ask'), true);
  assert.deepEqual(sent, ['白名单消息已处理']);

  const callsBeforeDeniedCommand = harnessCalls.length;
  const repliesBeforeDeniedCommand = sent.length;
  await bridge.accept(message('policy-member-command', '/help', {
    from_user_id: 'member-user',
  }));
  assert.equal(harnessCalls.length, callsBeforeDeniedCommand);
  assert.deepEqual(sent.slice(repliesBeforeDeniedCommand), [COMMAND_PERMISSION_DENIED_MESSAGE]);

  accessPolicy.getSettings().direct.allowlist.users = [];
  await bridge.accept(message('policy-owner-command', '/help'));
  assert.match(sent.at(-1), /\/help/);
});

test('Weixin returns a specific retry message when encrypted image loading fails', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-image');
  const sent = [];
  const bridge = new WeixinHarnessBridge({
    api: {
      inboundImages: () => [{ load: async () => { throw new Error('CDN unavailable'); } }],
      sendText: async (request) => sent.push(request),
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, content, options) => { await loadDeferredImages(content, options); assert.fail('invalid images must not reach the model'); },
    },
    state: fixture.state,
    logger: { error() {} },
  });

  await bridge.accept(message('weixin-image-error', '', {
    item_list: [{ type: 2, image_item: { media: {} } }],
  }));

  assert.match(sent.at(-1).text, /^图片下载失败，请重新发送后再试。/);
  assert.match(sent.at(-1).text, /错误码：INPUT_INVALID；参考号：MF-[A-F0-9]{8}$/);
  assert.equal(fixture.seen.has('weixin-image-error'), true);
});

test('Weixin explains model image rejection and records only safe structured diagnostics', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-image');
  const sent = [];
  const status = createWeixinBridgeStatus();
  const bridge = new WeixinHarnessBridge({
    api: {
      inboundImages: () => [{ name: 'image', data: PNG_BYTES }],
      sendText: async (request) => sent.push(request),
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async () => {
        throw Object.assign(new Error('Model detail at /private/path with provider-token'), {
          code: 'attachment-error',
          details: {
            reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES',
            providerDetail: 'must-not-cross-status-boundary',
          },
        });
      },
    },
    state: fixture.state,
    status,
    logger: { error() {} },
  });

  await bridge.accept(message('weixin-model-image-error', '', {
    item_list: [{ type: 2, image_item: { media: {} } }],
  }));

  assert.match(sent.at(-1).text, /当前模型不支持图片/);
  assert.match(sent.at(-1).text, /\/models/);
  assert.equal(fixture.seen.has('weixin-model-image-error'), true);
  assert.deepEqual(status.lastMessageError, {
    code: 'INPUT_INVALID',
    reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES',
    message: '当前模型不支持图片，请用 /models 查看可用模型，再用 /model <序号> 切换后重发。',
    referenceId: status.lastMessageError.referenceId,
    at: status.lastMessageError.at,
  });
  assert.match(status.lastMessageError.referenceId, /^MF-[A-F0-9]{8}$/);
  assert.equal(Number.isFinite(status.lastMessageError.at), true);
  assert.doesNotMatch(JSON.stringify(status.lastMessageError), /private|provider-token|providerDetail/);
});

test('Weixin executes /compact for the bound Session without prompting the model', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-compact');
  const sent = [];
  const executed = [];
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      executeCommand: async (sessionId, line) => {
        executed.push({ sessionId, line });
        return { commandId: 'compact-weixin', result: { kind: 'success', text: 'No compactable history yet.' } };
      },
      ask: async () => assert.fail('/compact must not be submitted to the model'),
    },
    state: fixture.state,
  });

  await bridge.accept(message('compact-weixin', '/compact'));

  assert.deepEqual(executed, [{ sessionId: 'session-compact', line: '/compact' }]);
  assert.equal(sent.at(-1).text, '暂无可压缩的历史记录。');
  assert.equal(fixture.seen.has('compact-weixin'), true);
});

test('Weixin lists models and presets without prompting and advertises fast commands', async () => {
  const fixture = stateFixture();
  const sent = [];
  const presetUpdates = [];
  let agentPreset = null;
  let asks = 0;
  let creates = 0;
  const agentPresetCatalog = {
    defaultId: 'preset-001',
    items: Array.from({ length: 70 }, (_, index) => ({
      id: `preset-${String(index + 1).padStart(3, '0')}`,
      label: `Weixin Preset ${index + 1} ${'x'.repeat(64)}`,
    })),
  };
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      listModels: async () => ({
        groups: [{
          id: 'weixin-provider',
          name: 'Weixin Provider',
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
      createSession: async () => { creates += 1; return 'weixin-session'; },
      ask: async () => { asks += 1; return 'unexpected model reply'; },
    },
    state: fixture.state,
  });

  await bridge.accept(message('models-weixin', '/models'));
  assert.match(sent.at(-1).text, /1\. weixin-provider\/model-one/);
  assert.equal(asks, 0);
  assert.equal(creates, 0);
  assert.equal(fixture.sessions.size, 0);

  await bridge.accept(message('reasoning-weixin', '/reasoninglist'));
  assert.match(sent.at(-1).text, /还没有会话/);
  assert.equal(asks, 0);
  assert.equal(creates, 0);
  assert.equal(fixture.sessions.size, 0);

  const presetReplyStart = sent.length;
  await bridge.accept(message('presets-weixin', '/presetlist'));
  const presetReplies = sent.slice(presetReplyStart).map((entry) => entry.text);
  assert.ok(presetReplies.length > 1);
  assert.match(presetReplies.join('\n'), /preset-070/);
  assert.equal(asks, 0);
  assert.equal(creates, 0);
  assert.equal(fixture.sessions.size, 0);

  await bridge.accept(message('preset-current-weixin', '/preset'));
  assert.match(sent.at(-1).text, /跟随 Host 默认/);
  assert.equal(asks, 0);
  assert.equal(creates, 0);

  const selectReplyStart = sent.length;
  await bridge.accept(message('preset-select-weixin', '/preset 2'));
  assert.deepEqual(presetUpdates, ['preset-002']);
  assert.equal(sent.length, selectReplyStart + 1);
  assert.match(sent.at(-1).text, /preset-002/);

  const defaultReplyStart = sent.length;
  await bridge.accept(message('preset-default-weixin', '/preset --default'));
  assert.deepEqual(presetUpdates, ['preset-002', null]);
  assert.equal(sent.length, defaultReplyStart + 1);
  assert.match(sent.at(-1).text, /跟随 Host 默认/);
  assert.equal(asks, 0);
  assert.equal(creates, 0);
  assert.equal(fixture.sessions.size, 0);

  await bridge.accept(message('help-models-weixin', '/help'));
  const help = sent.at(-1).text;
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

test('bridge maps the scanning Weixin user to one persistent Harness session and echoes context_token', async () => {
  const sent = [];
  const asked = [];
  const fixture = stateFixture();
  const status = createWeixinBridgeStatus();
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async (sessionId) => sessionId === 'session-1',
      createSession: async () => 'session-1',
      ask: async (sessionId, text) => {
        asked.push({ sessionId, text });
        return 'Harness 的回答';
      },
    },
    state: fixture.state,
    status,
  });

  await bridge.accept(message('1', '你好'));
  await bridge.accept(message('2', '继续'));

  assert.deepEqual(asked, [
    { sessionId: 'session-1', text: '你好' },
    { sessionId: 'session-1', text: '继续' },
  ]);
  assert.equal(fixture.sessions.get('p2p:owner-user'), 'session-1');
  assert.deepEqual(sent.map(({ toUserId, text, contextToken }) => ({ toUserId, text, contextToken })), [
    { toUserId: 'owner-user', text: 'Harness 的回答', contextToken: 'context-1' },
    { toUserId: 'owner-user', text: 'Harness 的回答', contextToken: 'context-2' },
  ]);
  assert.equal(status.messagesReceived, 2);
  assert.equal(status.messagesReplied, 2);
});

test('Weixin keeps the typing indicator alive until the final reply with one ticket lookup', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-typing');
  const releaseAnswer = deferred();
  const events = [];
  let configCalls = 0;
  const bridge = new WeixinHarnessBridge({
    api: {
      getConfig: async ({ toUserId, contextToken }) => {
        configCalls += 1;
        events.push(`config:${toUserId}:${contextToken}`);
        return { typingTicket: 'typing-ticket' };
      },
      sendTyping: async ({ status }) => events.push(`typing:${status}`),
      sendText: async ({ text }) => events.push(`text:${text}`),
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    typingKeepaliveMs: 5,
    harness: {
      sessionExists: async () => true,
      ask: async () => releaseAnswer.promise,
    },
    state: fixture.state,
  });

  const turn = bridge.accept(message('typing', '慢一点回答'));
  await eventually(() => events.filter((event) => event === 'typing:1').length >= 2);
  releaseAnswer.resolve('回答完成');
  await turn;

  assert.equal(configCalls, 1);
  assert.equal(events[0], 'config:owner-user:context-typing');
  assert.equal(events[1], 'typing:1');
  assert.equal(events.filter((event) => event === 'typing:1').length >= 2, true);
  assert.deepEqual(events.slice(-2), ['typing:2', 'text:回答完成']);

  const startsAfterFirstTurn = events.filter((event) => event === 'typing:1').length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    events.filter((event) => event === 'typing:1').length,
    startsAfterFirstTurn,
    'a completed turn must not leave a keepalive timer behind',
  );

  const secondTurnStart = events.length;
  await bridge.accept(message('typing-again', '再次回答'));
  assert.equal(configCalls, 1, 'the typing ticket should be reused across turns');
  assert.deepEqual(events.slice(secondTurnStart), [
    'typing:1',
    'typing:2',
    'text:回答完成',
  ]);
});

test('Weixin typing failures never prevent the Harness reply', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-typing-fallback');
  const sent = [];
  const warnings = [];
  const bridge = new WeixinHarnessBridge({
    api: {
      getConfig: async () => { throw new Error('typing unavailable'); },
      sendTyping: async () => assert.fail('typing cannot start without a ticket'),
      sendText: async ({ text }) => sent.push(text),
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async () => '仍然正常回答',
    },
    state: fixture.state,
    logger: { warn: (...args) => warnings.push(args), error() {} },
  });

  await bridge.accept(message('typing-fallback', '测试降级'));

  assert.deepEqual(sent, ['仍然正常回答']);
  assert.equal(warnings.length, 1);
});

test('Weixin best-effort cancels after a typing start or keepalive failure', async (suite) => {
  for (const failAtStart of [1, 2]) {
    await suite.test(`status 1 attempt ${failAtStart}`, async () => {
      const fixture = stateFixture();
      fixture.sessions.set('p2p:owner-user', `session-typing-failure-${failAtStart}`);
      const releaseAnswer = deferred();
      const askStarted = deferred();
      const statuses = [];
      const sent = [];
      const warnings = [];
      let starts = 0;
      const bridge = new WeixinHarnessBridge({
        api: {
          getConfig: async () => ({ typingTicket: 'typing-ticket' }),
          sendTyping: async ({ status }) => {
            statuses.push(status);
            if (status === 1) {
              starts += 1;
              if (starts === failAtStart) throw new Error('typing status failed');
            }
          },
          sendText: async ({ text }) => sent.push(text),
        },
        baseUrl: 'https://ilinkai.weixin.qq.com/',
        token: 'host-token',
        ownerUserId: 'owner-user',
        typingKeepaliveMs: 5,
        harness: {
          sessionExists: async () => true,
          ask: async () => {
            askStarted.resolve();
            return releaseAnswer.promise;
          },
        },
        state: fixture.state,
        logger: { warn: (...args) => warnings.push(args), error() {} },
      });

      const turn = bridge.accept(message(`typing-failure-${failAtStart}`, '测试输入状态失败'));
      await askStarted.promise;
      await eventually(() => warnings.length === 1);
      releaseAnswer.resolve('最终回答仍然发送');
      await turn;

      assert.deepEqual(statuses, failAtStart === 1 ? [1, 2] : [1, 1, 2]);
      assert.deepEqual(sent, ['最终回答仍然发送']);
    });
  }
});

test('Weixin stops typing while a Harness question is visible', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-typing-question');
  const events = [];
  const bridge = new WeixinHarnessBridge({
    api: {
      getConfig: async () => ({ typingTicket: 'typing-ticket' }),
      sendTyping: async ({ status }) => events.push(`typing:${status}`),
      sendText: async ({ text }) => events.push(`text:${text}`),
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async (sessionId, _text, options) => {
        await options.onInteraction({
          kind: 'question',
          interactionId: 'typing-question',
          rpcId: 'typing-question',
          sessionId,
          payload: {
            type: 'question/requested',
            sessionId,
            questions: [{ id: 'answer', question: '需要你的回答' }],
          },
          respond: async () => ({ accepted: true }),
        });
        await options.onUpdate({ type: 'text', text: '不应在待回答时恢复' });
        return '任务结束';
      },
    },
    state: fixture.state,
  });

  await bridge.accept(message('typing-question', '触发问题'));

  assert.equal(events[0], 'typing:1');
  assert.equal(events[1], 'typing:2');
  assert.match(events[2], /^text:DeepSeek Harness 需要你补充信息/);
  assert.equal(events.filter((event) => event === 'typing:1').length, 1);
  assert.equal(events.at(-1), 'text:任务结束');
});

test('Weixin resumes typing after the visible Harness question is resolved', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-typing-question-resolved');
  const events = [];
  const bridge = new WeixinHarnessBridge({
    api: {
      getConfig: async () => ({ typingTicket: 'typing-ticket' }),
      sendTyping: async ({ status }) => events.push(`typing:${status}`),
      sendText: async ({ text }) => events.push(`text:${text}`),
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async (sessionId, _text, options) => {
        await options.onInteraction({
          kind: 'question',
          interactionId: 'typing-question-resolved',
          rpcId: 'typing-question-resolved',
          sessionId,
          payload: {
            type: 'question/requested',
            sessionId,
            questions: [{ id: 'answer', question: '需要你的回答' }],
          },
          respond: async () => ({ accepted: true }),
        });
        await options.onInteractionResolved({
          kind: 'question',
          interactionId: 'typing-question-resolved',
        });
        return '继续处理完成';
      },
    },
    state: fixture.state,
  });

  await bridge.accept(message('typing-question-resolved', '触发后解决问题'));

  assert.deepEqual(
    events.filter((event) => event.startsWith('typing:')),
    ['typing:1', 'typing:2', 'typing:1', 'typing:2'],
  );
  assert.equal(events.at(-1), 'text:继续处理完成');
});

test('Weixin restarts typing when an out-of-band notice races an in-flight keepalive', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-typing-race');
  const releaseAnswer = deferred();
  const askStarted = deferred();
  const releaseHeartbeat = deferred();
  const events = [];
  let askOptions;
  let starts = 0;
  const bridge = new WeixinHarnessBridge({
    api: {
      getConfig: async () => ({ typingTicket: 'typing-ticket' }),
      sendTyping: async ({ status }) => {
        events.push(`typing:${status}`);
        if (status === 1) {
          starts += 1;
          if (starts === 2) {
            await releaseHeartbeat.promise;
          }
        }
      },
      sendText: async ({ text }) => events.push(`text:${text}`),
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    typingKeepaliveMs: 5,
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        askOptions = options;
        askStarted.resolve();
        return releaseAnswer.promise;
      },
    },
    state: fixture.state,
  });

  const turn = bridge.accept(message('typing-race', '执行一个长任务'));
  await askStarted.promise;
  await eventually(() => starts === 2);

  const busyNotice = bridge.accept(message('typing-race-batch', '/batch'));
  await new Promise((resolve) => setImmediate(resolve));
  let startsWhenProgressResolved = 0;
  const progressUpdate = askOptions.onUpdate({ type: 'text', text: '继续处理' }).then((result) => {
    startsWhenProgressResolved = starts;
    return result;
  });
  releaseHeartbeat.resolve();
  await Promise.all([busyNotice, progressUpdate]);

  assert.deepEqual(
    events.filter((event) => event.startsWith('typing:')),
    ['typing:1', 'typing:1', 'typing:2', 'typing:1'],
  );
  assert.equal(
    startsWhenProgressResolved,
    3,
    'the concurrent progress update must wait for cancellation and actually restart typing',
  );

  releaseAnswer.resolve('长任务完成');
  await turn;
  assert.deepEqual(
    events.filter((event) => event.startsWith('typing:')),
    ['typing:1', 'typing:1', 'typing:2', 'typing:1', 'typing:2'],
  );
  assert.equal(events.at(-1), 'text:长任务完成');
});

test('Weixin cancels typing with an independent signal when the runtime aborts', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-typing-abort');
  const controller = new AbortController();
  const typingCalls = [];
  const bridge = new WeixinHarnessBridge({
    api: {
      getConfig: async () => ({ typingTicket: 'typing-ticket' }),
      sendTyping: async ({ status, signal }) => typingCalls.push({ status, signal }),
      sendText: async () => assert.fail('an aborted turn must not send a reply'),
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    signal: controller.signal,
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      }),
    },
    state: fixture.state,
    logger: { warn() {}, error() {} },
  });

  const turn = bridge.accept(message('typing-abort', '启动后关闭'));
  await eventually(() => typingCalls.some(({ status }) => status === 1));
  controller.abort(new Error('runtime stopped'));
  await Promise.all([bridge.close(), turn]);

  assert.deepEqual(typingCalls.map(({ status }) => status), [1, 2]);
  assert.notEqual(typingCalls[1].signal, controller.signal);
  assert.equal(typingCalls[1].signal.aborted, false);
});

test('Weixin answers a multi-question interaction before the original turn queue', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-question');
  const sent = [];
  const asked = [];
  const submitted = deferred();
  const secondQuestionDelivered = deferred();
  const releaseSecondQuestion = deferred();
  const bridge = new WeixinHarnessBridge({
    api: {
      sendText: async (request) => {
        sent.push(request);
        if (request.text.includes('选择交付物')) {
          secondQuestionDelivered.resolve();
          await releaseSecondQuestion.promise;
        }
      },
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      createSession: async () => assert.fail('the existing session should be reused'),
      ask: async (sessionId, text, options) => {
        asked.push(text);
        await options.onInteraction({
          kind: 'question',
          interactionId: 'weixin-multi',
          rpcId: 'weixin-multi',
          sessionId,
          payload: {
            type: 'question/requested',
            sessionId,
            questions: [
              {
                id: 'language',
                question: '选择语言',
                options: [{ label: '中文' }, { label: 'English' }],
              },
              {
                id: 'deliverables',
                question: '选择交付物',
                multiSelect: true,
                options: [{ label: '测试' }, { label: '文档' }],
              },
            ],
          },
          respond: async (result) => {
            submitted.resolve(result);
            return { accepted: true };
          },
        });
        await submitted.promise;
        return '交互完成';
      },
    },
    state: fixture.state,
  });

  const first = bridge.accept(message('multi-start', '请分步提问'));
  await eventually(() => sent.some(({ text }) => text.includes('选择语言')));
  const firstAnswer = bridge.accept(message('multi-language', '2'));
  await secondQuestionDelivered.promise;
  const secondAnswer = bridge.accept(message('multi-deliverables', '1，文档，发布说明'));
  releaseSecondQuestion.resolve();
  await within(
    Promise.all([firstAnswer, secondAnswer]),
    500,
    'the second Weixin answer deadlocked behind delivery of the second question',
  );

  assert.deepEqual(await submitted.promise, {
    ok: true,
    value: {
      sessionId: 'session-question',
      answer: {
        answers: [
          { id: 'language', selected: ['English'] },
          { id: 'deliverables', selected: ['测试', '文档'], custom: '发布说明' },
        ],
      },
    },
  });
  await first;
  assert.deepEqual(asked, ['请分步提问']);
  assert.equal(sent.at(-1).text, '交互完成');
  assert.equal(sent.find(({ text }) => text.includes('选择交付物')).contextToken, 'context-multi-language');
});

test('Weixin consumes an exact rejection as the pending approval response', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-approval');
  const sent = [];
  const asked = [];
  const completed = deferred();
  const responses = [];
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      createSession: async () => assert.fail('the existing session should be reused'),
      ask: async (sessionId, text, options) => {
        asked.push(text);
        await options.onInteraction({
          kind: 'approval',
          interactionId: 'weixin-approval-exact',
          rpcId: 'weixin-approval-exact-rpc',
          sessionId,
          payload: {
            type: 'approval/requested',
            sessionId,
            approvalId: 'weixin-approval-exact',
            toolName: 'bash',
            callId: 'weixin-approval-exact-call',
            reason: '允许执行微信审批测试',
          },
          toolCall: {
            callId: 'weixin-approval-exact-call',
            name: 'bash',
            arguments: JSON.stringify({ command: "printf 'weixin-approval\\n'" }),
          },
          respond: async (result) => {
            responses.push(result);
            completed.resolve();
            return { accepted: true };
          },
        });
        await completed.promise;
        return '审批已拒绝';
      },
    },
    state: fixture.state,
  });

  const prompt = bridge.accept(message('approval-start', '启动审批'));
  await eventually(() => sent.some(({ text }) => text.includes('允许执行微信审批测试')));
  const presentation = sent.find(({ text }) => text.includes('允许执行微信审批测试')).text;
  assert.match(presentation, /bash/);
  assert.match(presentation, /批准.*拒绝/s);

  await Promise.all([
    bridge.accept(message('approval-reject', '  不同意  ')),
    prompt,
  ]);

  assert.deepEqual(responses, [{
    ok: true,
    value: {
      sessionId: 'session-approval',
      approvalId: 'weixin-approval-exact',
      outcome: 'rejected',
    },
  }]);
  assert.deepEqual(asked, ['启动审批']);
  assert.equal(sent.at(-1).text, '审批已拒绝');
});

test('Weixin deduplicates question replays, rejects parallel questions, and keeps approvals fail-closed', async () => {
  const fixture = stateFixture();
  const sent = [];
  let approvalResponse;
  let parallelResponse;
  let orphanResponse;
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => false,
      createSession: async () => 'session-replay',
      ask: async (sessionId, _text, options) => {
        const replayedQuestion = {
          kind: 'question',
          interactionId: 'weixin-replayed-question',
          rpcId: 'weixin-replayed-question',
          sessionId,
          payload: {
            type: 'question/requested',
            sessionId,
            questions: [{ id: 'choice', question: '只应显示一次' }],
          },
          respond: async () => ({ accepted: true }),
        };
        await options.onInteraction(replayedQuestion);
        await options.onInteraction(replayedQuestion);
        await options.onInteraction({
          kind: 'question',
          interactionId: 'weixin-parallel-question',
          rpcId: 'weixin-parallel-question',
          sessionId,
          payload: {
            type: 'question/requested',
            sessionId,
            questions: [{ id: 'parallel', question: '不应展示的并行问题' }],
          },
          respond: async (result) => {
            parallelResponse = result;
            return { accepted: true };
          },
        });
        await options.onInteraction({
          kind: 'approval',
          interactionId: 'weixin-approval',
          rpcId: 'weixin-approval',
          sessionId,
          payload: {
            type: 'approval/requested',
            sessionId,
            approvalId: 'weixin-approval',
            toolName: 'bash',
          },
          respond: async (result) => { approvalResponse = result; },
        });
        await options.onInteractionResolved({
          kind: 'question',
          interactionId: 'weixin-replayed-question',
          sessionId,
          outcome: 'cancelled',
        });
        await options.onInteraction({
          kind: 'question',
          interactionId: 'weixin-orphan-question',
          rpcId: 'weixin-orphan-question',
          sessionId,
          recovered: true,
          payload: {
            type: 'question/requested',
            sessionId,
            questions: [{ id: 'secret', question: '旧会话中的敏感问题内容' }],
          },
          respond: async (result) => {
            orphanResponse = result;
            return { accepted: true };
          },
        });
        return '交互恢复完成';
      },
    },
    state: fixture.state,
    logger: { warn() {}, error() {} },
  });

  await bridge.accept(message('replay', '测试交互重放'));

  assert.equal(sent.filter(({ text }) => text.includes('只应显示一次')).length, 1);
  assert.deepEqual(parallelResponse, {
    ok: false,
    error: {
      code: 'cancelled',
      message: 'Weixin is already handling another user interaction.',
      details: {},
    },
  });
  assert.deepEqual(approvalResponse, {
    ok: true,
    value: {
      sessionId: 'session-replay',
      approvalId: 'weixin-approval',
      outcome: 'rejected',
    },
  });
  assert.equal(sent.some(({ text }) => text.includes('approval')), false);
  assert.deepEqual(orphanResponse, {
    ok: false,
    error: {
      code: 'cancelled',
      message: 'Weixin safely cancelled an interaction left by an earlier client.',
      details: {},
    },
  });
  assert.equal(sent.some(({ text }) => text.includes('旧会话中的敏感问题内容')), false);
  assert.equal(sent.some(({ text }) => text.includes('遗留的待回答问题')), true);
  assert.equal(sent.at(-1).text, '交互恢复完成');
});

test('Weixin keeps a queued prompt separate while a failed interaction answer is retried', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-submit-retry');
  const sent = [];
  const asked = [];
  const firstSubmitStarted = deferred();
  const releaseFirstSubmit = deferred();
  const answered = deferred();
  const submittedAnswers = [];
  let submitAttempts = 0;
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      createSession: async () => assert.fail('the existing session should be reused'),
      ask: async (sessionId, text, options) => {
        asked.push(text);
        if (text === '排队的下一个问题') return '第二轮完成';
        await options.onInteraction({
          kind: 'question',
          interactionId: 'weixin-submit-retry',
          rpcId: 'weixin-submit-retry',
          sessionId,
          payload: {
            type: 'question/requested',
            sessionId,
            questions: [{ id: 'answer', question: '请回答后再继续' }],
          },
          respond: async (result) => {
            submittedAnswers.push(result.value.answer.answers[0].custom);
            submitAttempts += 1;
            if (submitAttempts === 1) {
              firstSubmitStarted.resolve();
              await releaseFirstSubmit.promise;
              throw new Error('temporary response failure');
            }
            answered.resolve();
            return { accepted: true };
          },
        });
        await answered.promise;
        return '第一轮完成';
      },
    },
    state: fixture.state,
    logger: { warn() {}, error() {} },
  });

  const first = bridge.accept(message('retry-start', '启动可重试交互'));
  await eventually(() => sent.some(({ text }) => text.includes('请回答后再继续')));
  const firstAnswer = bridge.accept(message('retry-first-answer', '第一次答案'));
  await firstSubmitStarted.promise;

  let nextSettled = false;
  const next = bridge.accept(message('retry-next', '排队的下一个问题'))
    .finally(() => { nextSettled = true; });
  releaseFirstSubmit.resolve();
  await firstAnswer;
  await eventually(() => sent.some(({ text }) => text.includes('回答提交失败')));
  assert.equal(nextSettled, false);
  assert.deepEqual(asked, ['启动可重试交互']);

  await Promise.all([
    bridge.accept(message('retry-second-answer', '重试后的答案')),
    first,
    next,
  ]);

  assert.deepEqual(submittedAnswers, ['第一次答案', '重试后的答案']);
  assert.deepEqual(asked, ['启动可重试交互', '排队的下一个问题']);
  assert.deepEqual(sent.slice(-2).map(({ text }) => text), ['第一轮完成', '第二轮完成']);
});

test('Weixin serializes an invalid pending reply before the following valid answer', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-invalid-answer');
  const sent = [];
  const invalidNoticeStarted = deferred();
  const releaseInvalidNotice = deferred();
  const answered = deferred();
  let submitted;
  const bridge = new WeixinHarnessBridge({
    api: {
      sendText: async (request) => {
        if (request.text === '请用文字回答当前问题。') {
          invalidNoticeStarted.resolve();
          await releaseInvalidNotice.promise;
        }
        sent.push(request);
      },
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      createSession: async () => assert.fail('the existing session should be reused'),
      ask: async (sessionId, _text, options) => {
        await options.onInteraction({
          kind: 'question',
          interactionId: 'weixin-invalid-answer',
          rpcId: 'weixin-invalid-answer',
          sessionId,
          payload: {
            type: 'question/requested',
            sessionId,
            questions: [{ id: 'answer', question: '请给出有效文字答案' }],
          },
          respond: async (result) => {
            submitted = result;
            answered.resolve();
            return { accepted: true };
          },
        });
        await answered.promise;
        return '有效答案已收到';
      },
    },
    state: fixture.state,
  });

  const first = bridge.accept(message('invalid-start', '启动交互'));
  await eventually(() => sent.some(({ text }) => text.includes('请给出有效文字答案')));
  const invalid = bridge.accept(message('invalid-image', '', {
    message_type: 3,
    item_list: [
      { type: 1, text_item: { text: '伪装成答案的图片说明' } },
      { type: 2, image_item: { media: {} } },
    ],
  }));
  await invalidNoticeStarted.promise;
  const valid = bridge.accept(message('invalid-valid', '真正的答案'));
  releaseInvalidNotice.resolve();

  await Promise.all([invalid, valid, first]);
  assert.deepEqual(submitted.value.answer.answers, [{
    id: 'answer',
    selected: [],
    custom: '真正的答案',
  }]);
  assert.equal(sent.at(-1).text, '有效答案已收到');
});

test('Weixin discards an already-claimed answer when the interaction resolves elsewhere', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-resolved-race');
  const originalMarkSeen = fixture.state.markSeen;
  const answerMarkStarted = deferred();
  const releaseAnswerMark = deferred();
  fixture.state.markSeen = async (id) => {
    if (id === 'resolved-answer') {
      answerMarkStarted.resolve();
      await releaseAnswerMark.promise;
    }
    await originalMarkSeen(id);
  };
  const sent = [];
  const asked = [];
  const resolved = deferred();
  let resolveInteraction;
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      createSession: async () => assert.fail('the existing session should be reused'),
      ask: async (sessionId, text, options) => {
        asked.push(text);
        if (text === '后来的普通问题') return '后来问题的回答';
        await options.onInteraction({
          kind: 'question',
          interactionId: 'weixin-resolved-race',
          rpcId: 'weixin-resolved-race',
          sessionId,
          payload: {
            type: 'question/requested',
            sessionId,
            questions: [{ id: 'answer', question: '可能在其他客户端回答' }],
          },
          respond: async () => ({ accepted: true }),
        });
        resolveInteraction = async () => {
          await options.onInteractionResolved({
            kind: 'question',
            interactionId: 'weixin-resolved-race',
            sessionId,
            outcome: 'answered',
          });
          resolved.resolve();
        };
        await resolved.promise;
        return '第一轮已由其他客户端完成';
      },
    },
    state: fixture.state,
  });

  const first = bridge.accept(message('resolved-start', '启动外部解决竞态'));
  await eventually(() => typeof resolveInteraction === 'function');
  const answer = bridge.accept(message('resolved-answer', '原本的问题答案'));
  await answerMarkStarted.promise;
  const later = bridge.accept(message('resolved-later', '后来的普通问题'));
  await resolveInteraction();
  releaseAnswerMark.resolve();

  await Promise.all([answer, first, later]);
  assert.deepEqual(asked, ['启动外部解决竞态', '后来的普通问题']);
  assert.equal(asked.includes('原本的问题答案'), false);
  assert.equal(sent.some(({ text }) => text.includes('已在其他客户端处理')), true);
});

test('Weixin keeps an answer that arrives after the first question is delivered but before its send ACK', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-first-delivery');
  const questionDelivered = deferred();
  const releaseQuestionAck = deferred();
  const answered = deferred();
  const sent = [];
  const asked = [];
  let submitted;
  let questionSends = 0;
  const bridge = new WeixinHarnessBridge({
    api: {
      sendText: async (request) => {
        sent.push(request);
        if (request.text.includes('首问 ACK 窗口')) {
          questionSends += 1;
          questionDelivered.resolve();
          await releaseQuestionAck.promise;
        }
      },
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async (sessionId, text, options) => {
        asked.push(text);
        await options.onInteraction({
          kind: 'question',
          interactionId: 'weixin-first-delivery',
          rpcId: 'weixin-first-delivery',
          sessionId,
          payload: {
            type: 'question/requested',
            sessionId,
            questions: [{ id: 'answer', question: '首问 ACK 窗口' }],
          },
          respond: async (result) => {
            submitted = result;
            answered.resolve();
            return { accepted: true };
          },
        });
        await answered.promise;
        return '首问已完成';
      },
    },
    state: fixture.state,
  });

  const first = bridge.accept(message('first-delivery-start', '启动首问窗口'));
  await questionDelivered.promise;
  const answer = bridge.accept(message('first-delivery-answer', '窗口内答案'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submitted, undefined);
  releaseQuestionAck.resolve();
  await Promise.all([first, answer]);

  assert.equal(questionSends, 1);
  assert.deepEqual(asked, ['启动首问窗口']);
  assert.deepEqual(submitted.value.answer.answers, [{
    id: 'answer',
    selected: [],
    custom: '窗口内答案',
  }]);
  assert.equal(fixture.seen.has('first-delivery-answer'), true);
});

test('Weixin tombstones a q2 answer accepted before its send ACK when the interaction resolves', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-q2-resolved');
  const secondQuestionDelivered = deferred();
  const releaseSecondQuestionAck = deferred();
  const turnResolved = deferred();
  const sent = [];
  const asked = [];
  let resolveInteraction;
  const bridge = new WeixinHarnessBridge({
    api: {
      sendText: async (request) => {
        sent.push(request);
        if (request.text.includes('会在 ACK 前 resolved 的第二问')) {
          secondQuestionDelivered.resolve();
          await releaseSecondQuestionAck.promise;
        }
      },
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async (sessionId, text, options) => {
        asked.push(text);
        await options.onInteraction({
          kind: 'question',
          interactionId: 'weixin-q2-resolved',
          rpcId: 'weixin-q2-resolved',
          sessionId,
          payload: {
            type: 'question/requested',
            sessionId,
            questions: [
              { id: 'first', question: '先回答第一问' },
              { id: 'second', question: '会在 ACK 前 resolved 的第二问' },
            ],
          },
          respond: async () => assert.fail('the externally resolved interaction must not be answered'),
        });
        resolveInteraction = () => {
          options.onInteractionResolved({
            kind: 'question',
            interactionId: 'weixin-q2-resolved',
            sessionId,
            outcome: 'answered',
          });
          turnResolved.resolve();
        };
        await turnResolved.promise;
        return '已由其他客户端完成';
      },
    },
    state: fixture.state,
  });

  const first = bridge.accept(message('q2-resolved-start', '启动 q2 resolved 窗口'));
  await eventually(() => typeof resolveInteraction === 'function');
  const firstAnswer = bridge.accept(message('q2-resolved-first', '第一问答案'));
  await secondQuestionDelivered.promise;
  const secondAnswer = bridge.accept(message('q2-resolved-second', '第二问答案'));
  resolveInteraction();
  releaseSecondQuestionAck.resolve();
  await Promise.all([firstAnswer, secondAnswer, first]);

  assert.deepEqual(asked, ['启动 q2 resolved 窗口']);
  assert.equal(fixture.seen.has('q2-resolved-second'), true);
  assert.equal(sent.some(({ text }) => text.includes('已在其他客户端处理')), true);
});

test('Weixin reports resolved when an in-flight response becomes not-pending', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-respond-resolved');
  const responseStarted = deferred();
  const releaseResponse = deferred();
  const turnResolved = deferred();
  const sent = [];
  let resolveInteraction;
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async (sessionId, _text, options) => {
        await options.onInteraction({
          kind: 'question',
          interactionId: 'weixin-respond-resolved',
          rpcId: 'weixin-respond-resolved',
          sessionId,
          payload: {
            type: 'question/requested',
            sessionId,
            questions: [{ id: 'answer', question: '提交中会被外部解决' }],
          },
          respond: async () => {
            responseStarted.resolve();
            await releaseResponse.promise;
            const error = new Error('already resolved');
            error.code = 'interaction-not-pending';
            throw error;
          },
        });
        resolveInteraction = () => {
          options.onInteractionResolved({
            kind: 'question',
            interactionId: 'weixin-respond-resolved',
            sessionId,
            outcome: 'answered',
          });
          turnResolved.resolve();
        };
        await turnResolved.promise;
        return '外部处理完成';
      },
    },
    state: fixture.state,
  });

  const first = bridge.accept(message('respond-resolved-start', '启动提交竞态'));
  await eventually(() => typeof resolveInteraction === 'function');
  const answer = bridge.accept(message('respond-resolved-answer', '我的答案'));
  await responseStarted.promise;
  resolveInteraction();
  releaseResponse.resolve();
  await Promise.all([answer, first]);

  assert.equal(sent.some(({ text, contextToken }) => (
    contextToken === 'context-respond-resolved-answer'
      && text.includes('已在其他客户端处理')
  )), true);
});

test('Weixin propagates the stop signal and cancels its pending question on abort', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'stale-session');
  const controller = new AbortController();
  const interactionReady = deferred();
  let existsSignal;
  let createSignal;
  let askSignal;
  let cancellation;
  let cancellationSignal;
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async () => {} },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    signal: controller.signal,
    harness: {
      sessionExists: async (_sessionId, options) => {
        existsSignal = options.signal;
        return false;
      },
      createSession: async (options) => {
        createSignal = options.signal;
        return 'session-abort';
      },
      ask: async (sessionId, _text, options) => {
        askSignal = options.signal;
        await options.onInteraction({
          kind: 'question',
          interactionId: 'weixin-abort-question',
          rpcId: 'weixin-abort-question',
          sessionId,
          payload: {
            type: 'question/requested',
            sessionId,
            questions: [{ id: 'answer', question: '等待进程停止' }],
          },
          respond: async (result, respondOptions) => {
            cancellation = result;
            cancellationSignal = respondOptions.signal;
            return { accepted: true };
          },
        });
        interactionReady.resolve();
        await new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      },
    },
    state: fixture.state,
    logger: { warn() {}, error() {} },
  });

  const turn = bridge.accept(message('abort-start', '启动后停止'));
  await interactionReady.promise;
  controller.abort(new Error('runtime stopped'));
  await turn;

  assert.equal(existsSignal, controller.signal);
  assert.equal(createSignal, controller.signal);
  assert.equal(askSignal, controller.signal);
  assert.deepEqual(cancellation, {
    ok: false,
    error: {
      code: 'cancelled',
      message: 'The Weixin interaction ended before the user answered.',
      details: {},
    },
  });
  assert.notEqual(cancellationSignal, controller.signal);
  assert.equal(cancellationSignal.aborted, false);
});

test('bridge rejects every user except the account owner returned by QR login', async () => {
  const fixture = stateFixture();
  let asked = 0;
  const status = createWeixinBridgeStatus();
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async () => assert.fail('unauthorized users must not receive a reply') },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: { ask: async () => { asked += 1; } },
    state: fixture.state,
    status,
  });

  await bridge.accept(message('unauthorized', '越权', { from_user_id: 'other-user' }));
  assert.equal(asked, 0);
  assert.equal(status.messagesRejected, 1);
});

test('bridge commands are local and internal failures return a safe traceable message', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'old-session');
  const sent = [];
  const status = createWeixinBridgeStatus();
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async (request) => sent.push(request.text) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      ask: async () => { throw new Error('private path /secret and token-shaped detail'); },
    },
    state: fixture.state,
    status,
    logger: { error() {} },
  });

  await bridge.accept(message('new', '/new'));
  assert.equal(fixture.sessions.has('p2p:owner-user'), false);
  await bridge.accept(message('failure', '触发失败'));
  assert.match(sent.at(-1), /任务未完成，暂时无法确定原因/);
  assert.match(sent.at(-1), /错误码：INTERNAL_UNKNOWN；参考号：MF-[A-F0-9]{8}$/);
  assert.doesNotMatch(sent.at(-1), /private path|secret|token-shaped/);
  assert.deepEqual(status.lastMessageError, {
    details: { reason: 'unknown' },
    code: 'INTERNAL_UNKNOWN',
    reason: 'INTERNAL_UNKNOWN',
    message: '任务未完成，暂时无法确定原因。请重试；若持续发生，请将参考号提供给管理员。',
    referenceId: status.lastMessageError.referenceId,
    at: status.lastMessageError.at,
  });
  assert.match(status.lastMessageError.referenceId, /^MF-[A-F0-9]{8}$/);
  assert.doesNotMatch(JSON.stringify(status.lastMessageError), /private path|secret|token-shaped/);
});

test('Weixin reports a missing preset with recovery steps and the same reference in its log', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-missing-preset');
  const sent = [];
  const logs = [];
  const error = new HarnessRpcError('session.prompt', {
    code: 'agent-preset/not-found',
    message: 'private preset path /secret',
    details: { agentPreset: 'removed-preset' },
  });
  const status = createWeixinBridgeStatus();
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async ({ text }) => sent.push(text) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async () => { throw error; },
    },
    state: fixture.state,
    status,
    logger: { error: (...args) => logs.push(args) },
  });

  await bridge.accept(message('missing-preset', '继续之前的会话'));

  const failure = status.lastMessageError;
  assert.equal(failure.code, 'PRESET_UNAVAILABLE');
  assert.equal(failure.reason, 'AGENT_PRESET_NOT_FOUND');
  assert.match(sent.at(-1), /\/presetlist.*\/preset <序号或 ID>.*\/new/u);
  assert.equal(sent.at(-1).endsWith(`参考号：${failure.referenceId}`), true);
  const log = logs.find(([text]) => text.includes(`[${failure.referenceId}]`));
  assert.ok(log, 'the reply reference must identify the logged failure');
  assert.equal(log[1].code, failure.code);
  assert.equal(log[1].referenceId, failure.referenceId);
  assert.equal(log[1].details.reason, 'unknown');
  assert.equal(error.code, 'agent-preset/not-found');
  assert.doesNotMatch(JSON.stringify({ failure, sent, log }), /private|secret|removed-preset/u);
});

test('Weixin exposes a structured model rate limit without changing connection state', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-rate-limit');
  const sent = [];
  const status = {
    ...createWeixinBridgeStatus(),
    connected: true,
    connectionState: 'connected',
  };
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async ({ text }) => sent.push(text) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async () => {
        const error = new Error('private Weixin provider rate-limit detail');
        error.code = 'harness-turn-failed';
        error.providerCode = 'RATE_LIMIT';
        throw error;
      },
    },
    state: fixture.state,
    status,
    logger: { error() {} },
  });

  await bridge.accept(message('weixin-rate-limit', '触发模型限流'));

  const failure = status.lastMessageError;
  assert.equal(failure.code, 'MODEL_RATE_LIMIT');
  assert.equal(failure.reason, 'HARNESS_TURN_FAILED');
  assert.match(failure.referenceId, /^MF-[A-F0-9]{8}$/);
  assert.match(sent.at(-1), /模型服务正在限流，本次任务未完成。请稍后重试。/);
  assert.equal(sent.at(-1).endsWith(`参考号：${failure.referenceId}`), true);
  assert.doesNotMatch(sent.at(-1), /private Weixin provider rate-limit detail/);
  assert.equal(status.connected, true);
  assert.equal(status.connectionState, 'connected');
});

test('Weixin does not resubmit a recorded prompt when the safe error reply fails', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-safe-error-replay');
  let asks = 0;
  let safeReplyAttempts = 0;
  const bridge = new WeixinHarnessBridge({
    api: {
      sendText: async () => {
        safeReplyAttempts += 1;
        throw new Error('safe reply unavailable');
      },
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
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
    state: fixture.state,
    logger: { error() {} },
  });
  const inbound = message('weixin-safe-error-replay', '请执行一次');

  await bridge.accept(inbound);
  await bridge.accept(inbound);

  assert.equal(asks, 1);
  assert.equal(safeReplyAttempts, 1);
  assert.equal(fixture.seen.has('weixin-safe-error-replay'), true);
});

test('Weixin batch input collects up to ten native text messages and submits one ordered turn', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-batch');
  const sent = [];
  const prompts = [];
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async (sessionId, prompt) => {
        prompts.push({ sessionId, prompt });
        return '批量完成';
      },
    },
    state: fixture.state,
  });

  await bridge.accept(message('batch-start', '/batch'));
  await bridge.accept(message('batch-quote', '微信引用不能收录', {
    item_list: [{
      type: 1,
      text_item: { text: '微信引用不能收录' },
      ref_msg: { message_item: { type: 1, text_item: { text: '被引用内容' } } },
    }],
  }));
  await bridge.accept(message('batch-voice', '', {
    item_list: [{ type: 3, voice_item: { text: '语音转写不能收录' } }],
  }));
  await bridge.accept(message('batch-image', '', {
    item_list: [{ type: 2, image_item: { media: {} } }],
  }));
  for (let index = 1; index <= 10; index += 1) {
    await bridge.accept(message(`batch-item-${index}`, `内容 ${index}`));
  }
  await bridge.accept(message('batch-overflow', '不会收录'));

  assert.equal(prompts.length, 0);
  assert.equal(sent.some(({ text }) => /目前仅支持文字.*未收录/s.test(text)), true);
  assert.equal(sent.some(({ text }) => /10\/10.*已满/.test(text)), true);
  assert.equal(sent.some(({ text }) => /这条消息未收录/.test(text)), true);

  await bridge.accept(message('batch-send', '/send'));

  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].sessionId, 'session-batch');
  assert.match(prompts[0].prompt, /\[消息 1\]\n内容 1/);
  assert.match(prompts[0].prompt, /\[消息 10\]\n内容 10/);
  assert.doesNotMatch(prompts[0].prompt, /微信引用不能收录|语音转写不能收录|不会收录/);
  assert.equal(sent.at(-1).text, '批量完成');

  await bridge.accept(message('after-batch', '恢复普通聊天'));
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].prompt, '恢复普通聊天');
});

test('Weixin batch cancellation is local and a failed submission remains retryable', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-batch-retry');
  const sent = [];
  let attempts = 0;
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async ({ text }) => sent.push(text) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary failure');
        return '重试成功';
      },
    },
    state: fixture.state,
    logger: { error() {} },
  });

  await bridge.accept(message('retry-start', '/batch'));
  await bridge.accept(message('retry-content', '需要重试'));
  await bridge.accept(message('retry-send-1', '/send'));
  assert.match(sent.at(-1), /错误码：INTERNAL_UNKNOWN.*已保留 1 条消息/s);

  await bridge.accept(message('retry-send-2', '/send'));
  assert.equal(attempts, 2);
  assert.equal(sent.at(-1), '重试成功');

  await bridge.accept(message('cancel-start', '/batch'));
  await bridge.accept(message('cancel-content', '丢弃我'));
  await bridge.accept(message('cancel-command', '/cancel'));
  assert.match(sent.at(-1), /已取消批量输入.*丢弃 1 条消息/s);
  assert.equal(attempts, 2);
});

test('Weixin clears a submitted batch when the Harness turn is stopped', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-batch-stopped');
  const sent = [];
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async ({ text }) => sent.push(text) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async () => {
        const error = new Error('turn stopped');
        error.code = 'turn-stopped';
        throw error;
      },
    },
    state: fixture.state,
  });

  await bridge.accept(message('stopped-start', '/batch'));
  await bridge.accept(message('stopped-content', '不要重试'));
  await bridge.accept(message('stopped-send', '/send'));
  assert.doesNotMatch(sent.join('\n'), /已保留/);

  await bridge.accept(message('stopped-cancel', '/cancel'));
  assert.match(sent.at(-1), /没有正在进行的批量输入/);
});

test('Weixin refuses /batch while the existing conversation queue is running', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'session-batch-busy');
  const running = deferred();
  const sent = [];
  let asks = 0;
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async ({ text }) => sent.push(text) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      ask: async () => {
        asks += 1;
        await running.promise;
        return '原任务完成';
      },
    },
    state: fixture.state,
  });

  const turn = bridge.accept(message('busy-turn', '正在运行'));
  await eventually(() => asks === 1, 'busy turn did not start before /batch assertion', 5_000);
  await bridge.accept(message('busy-batch', '/batch'));
  assert.match(sent.at(-1), /正在运行的任务.*\/stop.*\/batch/s);

  running.resolve();
  await turn;
  await bridge.accept(message('busy-send', '/send'));
  assert.match(sent.at(-1), /没有待提交的批量内容/);
});
