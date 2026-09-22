import { loadDeferredImages } from '../../helpers/deferred-images.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ApiError } from '@tencent-connect/qqbot-nodejs';

import {
  createQqBridgeStatus,
  qqInboundMessage,
  QqHarnessBridge,
  sendQqImage,
} from '../../../src/channels/qq/qq-bridge.mjs';
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function eventually(predicate, messageText = 'condition was not met') {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(messageText);
}

function stateFixture(initialSessions = []) {
  const sessions = new Map(initialSessions);
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

function message(overrides = {}) {
  return {
    kind: 'c2c',
    rawEventType: 'C2C_MESSAGE_CREATE',
    senderId: 'owner-openid',
    senderIsBot: false,
    content: '请回答',
    messageId: 'msg-1',
    replyTarget: { scope: 'c2c', targetId: 'owner-openid', msgId: 'msg-1' },
    ...overrides,
  };
}

test('QQ maps msgElements quote snapshots and prefers voice ASR text', () => {
  const inbound = qqInboundMessage(message({
    refMsgIdx: 'quoted-index-7',
    msgElements: [{
      content: '语音占位文字',
      attachments: [
        {
          content_type: 'audio/silk',
          filename: 'voice.silk',
          asr_refer_text: '引用语音的识别文字',
        },
        { content_type: 'application/pdf', filename: '说明.pdf' },
      ],
    }],
  }));

  assert.equal(inbound.content, '请回答');
  assert.deepEqual(inbound.replyTo, {
    messageId: 'quoted-index-7',
    content: '引用语音的识别文字',
    attachments: [
      { kind: 'audio', name: 'voice.silk' },
      { kind: 'file', name: '说明.pdf' },
    ],
  });
});

test('QQ sends quote context to Harness but does not execute quoted commands', async () => {
  const fixture = stateFixture([['c2c:owner-openid', 'session-quote']]);
  let clears = 0;
  let prompt;
  fixture.state.clearSession = async () => { clears += 1; };
  const bridge = new QqHarnessBridge({
    bot: { sendText: async () => ({ id: 'qq-quote-answer' }) },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, content) => { prompt = content; return '已处理'; },
    },
    state: fixture.state,
  });

  await bridge.accept(message({
    messageId: 'qq-quote-prompt',
    content: '这条指令是什么意思？',
    refMsgIdx: 'quoted-command',
    msgElements: [{ content: '/new' }],
  }));

  assert.equal(clears, 0);
  assert.equal(Array.isArray(prompt), true);
  assert.match(prompt[0].text, /<dsh_im_reply_to>/);
  assert.match(prompt[0].text, /"content":"\/new"/);
  assert.deepEqual(prompt.at(-1), { type: 'text', text: '这条指令是什么意思？' });
});

async function committedArtifact(t, fileName, content, suffix) {
  const workspace = await mkdtemp(join(tmpdir(), `dsh-im-qq-artifact-${suffix}-`));
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

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
]);

test('QQ native image adapter delegates to the SDK sendImage method', async () => {
  const target = { scope: 'c2c', targetId: 'owner-openid', msgId: 'image-request' };
  const calls = [];
  const result = { message: { id: 'qq-image-1' } };
  const returned = await sendQqImage({
    sendImage: async (replyTarget, source, options) => {
      calls.push({ replyTarget, source, options });
      return result;
    },
  }, target, {
    artifactId: 'image-artifact',
    deliveryKey: 'image-delivery',
    fileName: 'diagram.png',
    mediaType: 'image/png',
    bytes: PNG_BYTES,
  });

  assert.equal(returned, result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].replyTarget, target);
  assert.deepEqual(calls[0].source.buffer, PNG_BYTES);
  assert.equal(typeof calls[0].options.onProgress, 'function');
});

test('QQ native image adapter preserves definite SDK rejections', async () => {
  await assert.rejects(sendQqImage({
    sendImage: async () => {
      const error = new Error('unsupported image');
      error.httpStatus = 415;
      throw error;
    },
  }, { scope: 'c2c', targetId: 'owner-openid' }, {
    fileName: 'diagram.png',
    bytes: PNG_BYTES,
  }), (error) => error.code === 'artifact-provider-rejected');
});

test('QQ native image adapter marks an unacknowledged SDK send as uncertain', async () => {
  await assert.rejects(sendQqImage({
    sendImage: async () => new Promise(() => {}),
  }, { scope: 'c2c', targetId: 'owner-openid' }, {
    fileName: 'diagram.png',
    bytes: PNG_BYTES,
  }, { timeoutMs: 20 }), (error) => error.code === 'artifact-delivery-uncertain');
});

test('QQ sends an image artifact with the native SDK image method', async (t) => {
  const artifact = await committedArtifact(t, 'native.png', PNG_BYTES, 'native-image');
  const images = [];
  let files = 0;
  const target = { scope: 'c2c', targetId: 'owner-openid', msgId: 'qq-native-image' };
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async () => ({ id: 'qq-text' }),
      sendImage: async (replyTarget, source, options) => {
        images.push({ replyTarget, bytes: Buffer.from(source.buffer), options });
        return { message: { id: 'qq-image' } };
      },
      sendFile: async () => { files += 1; },
    },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '图片已生成。';
      },
    },
    state: stateFixture([['c2c:owner-openid', 'session-native-image']]).state,
  });

  const receipt = await bridge.accept(message({
    messageId: 'qq-native-image',
    replyTarget: target,
  }));

  assert.equal(images.length, 1);
  assert.equal(images[0].replyTarget, target);
  assert.deepEqual(images[0].bytes, PNG_BYTES);
  assert.equal(typeof images[0].options.onProgress, 'function');
  assert.equal(files, 0);
  assert.equal(receipt.artifacts[0].artifactId, artifact.artifactId);
  assert.equal(receipt.artifacts[0].outcome, 'sent');
});

test('QQ falls back to a native file after a definite native-image rejection', async (t) => {
  const artifact = await committedArtifact(t, 'fallback.png', PNG_BYTES, 'image-fallback');
  const order = [];
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async () => ({ id: 'qq-text' }),
      sendImage: async () => {
        order.push('image');
        const error = new Error('unsupported image');
        error.httpStatus = 422;
        throw error;
      },
      sendFile: async (_target, source, options) => {
        order.push(`file:${options.fileName}:${source.buffer.length}`);
        return { message: { id: 'qq-file' } };
      },
    },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '图片已生成。';
      },
    },
    state: stateFixture([['c2c:owner-openid', 'session-image-fallback']]).state,
  });

  const receipt = await bridge.accept(message({ messageId: 'qq-image-fallback' }));

  assert.deepEqual(order, [`image`, `file:fallback.png:${PNG_BYTES.length}`]);
  assert.equal(receipt.artifacts[0].outcome, 'sent');
});

test('QQ does not file-fallback after an uncertain native image send', async (t) => {
  const artifact = await committedArtifact(t, 'uncertain.png', PNG_BYTES, 'image-uncertain');
  const texts = [];
  let files = 0;
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async (_target, text) => {
        texts.push(text);
        return { id: `qq-text-${texts.length}` };
      },
      sendImage: async () => new Promise(() => {}),
      sendFile: async () => { files += 1; },
    },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '图片已生成。';
      },
    },
    state: stateFixture([['c2c:owner-openid', 'session-image-uncertain']]).state,
    fileUploadTimeoutMs: 20,
    logger: { warn() {}, error() {} },
  });

  const receipt = await bridge.accept(message({ messageId: 'qq-image-uncertain' }));

  assert.equal(files, 0);
  assert.match(texts.at(-1), /发送结果未能确认.*不要立即重试/);
  assert.equal(receipt.artifacts[0].outcome, 'unknown');
});

test('QQ normalizes protocol-relative ordinary-file URLs and lets the CDN redirect', async () => {
  const bytes = Buffer.from('qq-native-file');
  const calls = [];
  const inbound = qqInboundMessage(message({
    content: '请读取附件',
    attachments: [{
      content_type: 'application/pdf',
      filename: 'QQ 报告.pdf',
      size: bytes.length,
      url: '//provider-issued-download.example/native-file',
    }],
  }), {
    fetchImpl: async (url, init) => {
      calls.push({ url: url.toString(), init });
      return new Response(bytes);
    },
  });

  assert.equal(inbound.content, '请读取附件');
  assert.deepEqual(inbound.images, []);
  assert.equal(inbound.files.length, 1);
  assert.equal(inbound.files[0].name, 'QQ 报告.pdf');
  assert.equal(inbound.files[0].mediaType, 'application/pdf');
  assert.equal(inbound.files[0].size, bytes.length);
  assert.equal(calls.length, 0, 'file download stays lazy');
  assert.deepEqual(await inbound.files[0].load({}), bytes);
  assert.deepEqual(calls, [{
    url: 'https://provider-issued-download.example/native-file',
    init: { method: 'GET', signal: undefined, redirect: 'follow' },
  }]);
});

test('QQ does not duplicate image attachments in ordinary files', () => {
  const inbound = qqInboundMessage(message({
    attachments: [{
      content_type: 'file',
      filename: 'diagram.PNG',
      url: 'https://multimedia.nt.qq.com.cn/download/opaque',
    }],
  }));
  assert.equal(inbound.images.length, 1);
  assert.deepEqual(inbound.files, []);
});

test('QQ bridge hands a native non-image attachment to the current Harness turn', async () => {
  const fixture = stateFixture([['c2c:owner-openid', 'session-native-file']]);
  const bytes = Buffer.from('qq-bridge-file');
  const downloads = [];
  const prompts = [];
  const sent = [];
  const bridge = new QqHarnessBridge({
    bot: { sendText: async (_target, text) => sent.push(text) },
    ownerUserOpenid: 'owner-openid',
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
    fetchImpl: async (url, init) => {
      downloads.push({ url: url.toString(), init });
      return new Response(bytes);
    },
  });

  await bridge.accept(message({
    messageId: 'qq-native-file',
    content: '',
    attachments: [{
      content_type: 'application/octet-stream',
      filename: 'QQ报告.bin',
      url: 'https://provider-issued-download.example/qq-file',
    }],
  }));

  assert.equal(downloads.length, 1);
  assert.deepEqual(prompts, [{
    sessionId: 'session-native-file',
    prompt: '',
    name: 'QQ报告.bin',
    bytes,
  }]);
  assert.deepEqual(sent, ['文件已收到']);
});

test('QQ starts an ordinary-file download before an earlier queued turn finishes', async () => {
  const fixture = stateFixture([['c2c:owner-openid', 'session-prefetch-file']]);
  const firstTurn = deferred();
  const bytes = Buffer.from('qq-prefetched-file');
  let asks = 0;
  let downloads = 0;
  const bridge = new QqHarnessBridge({
    bot: { sendText: async () => {} },
    ownerUserOpenid: 'owner-openid',
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
    fetchImpl: async () => {
      downloads += 1;
      return new Response(bytes);
    },
  });

  const first = bridge.accept(message({ messageId: 'qq-prefetch-first', content: '先等待' }));
  await eventually(() => asks === 1);
  const second = bridge.accept(message({
    messageId: 'qq-prefetch-second',
    content: '',
    attachments: [{
      content_type: 'application/octet-stream',
      filename: 'queued.bin',
      url: '//provider-issued-download.example/queued-file',
    }],
  }));

  await eventually(() => downloads === 1, 'queued QQ file did not start downloading');
  assert.equal(asks, 1, 'the second Harness turn must remain queued');
  firstTurn.resolve('第一条完成');
  await Promise.all([first, second]);
});

test('QQ sends image-only attachments to Harness and accepts the SDK file MIME fallback', async () => {
  const fixture = stateFixture([['c2c:owner-openid', 'session-image']]);
  const prompts = [];
  const downloads = [];
  const sent = [];
  const bridge = new QqHarnessBridge({
    bot: { sendText: async (_target, text) => sent.push(text) },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async (sessionId, content, options) => {
        content = await loadDeferredImages(content, options);
        prompts.push({ sessionId, content });
        return '看到图片了';
      },
    },
    state: fixture.state,
    fetchImpl: async (url, init) => {
      downloads.push({ url: url.toString(), init });
      return new Response(PNG_BYTES, { headers: { 'content-type': 'application/octet-stream' } });
    },
  });

  await bridge.accept(message({
    messageId: 'qq-image',
    content: '',
    attachments: [{
      content_type: 'file',
      filename: 'diagram.PNG',
      size: PNG_BYTES.length,
      url: 'https://multimedia.nt.qq.com.cn/download/opaque',
    }],
  }));

  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].init.method, 'GET');
  assert.equal(downloads[0].init.redirect, 'manual');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].sessionId, 'session-image');
  assert.deepEqual(prompts[0].content.map(({ type }) => type), ['text', 'image']);
  assert.equal(prompts[0].content[0].text, '请分析这张图片。');
  assert.equal(prompts[0].content[1].mediaType, 'image/png');
  assert.equal(prompts[0].content[1].name, 'diagram.PNG');
  assert.equal(Buffer.from(prompts[0].content[1].data, 'base64').equals(PNG_BYTES), true);
  assert.deepEqual(sent, ['看到图片了']);
  assert.equal(fixture.seen.has('qq-image'), true);
});

test('QQ checks sender and group mention before downloading image attachments', async () => {
  let downloads = 0;
  let asks = 0;
  const bridge = new QqHarnessBridge({
    bot: { sendText: async () => {} },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async () => { asks += 1; return 'unexpected'; },
    },
    state: stateFixture().state,
    fetchImpl: async () => { downloads += 1; return new Response(PNG_BYTES); },
  });
  const attachment = {
    content_type: 'image/png',
    filename: 'private.png',
    url: 'https://multimedia.nt.qq.com.cn/download/private',
  };

  await bridge.accept(message({
    messageId: 'qq-image-other',
    senderId: 'other-openid',
    content: '',
    attachments: [attachment],
  }));
  await bridge.accept(message({
    kind: 'group',
    rawEventType: 'GROUP_MESSAGE_CREATE',
    groupOpenid: 'group-1',
    messageId: 'qq-image-unmentioned',
    content: '',
    attachments: [attachment],
    replyTarget: { scope: 'group', targetId: 'group-1', msgId: 'qq-image-unmentioned' },
  }));

  assert.equal(downloads, 0);
  assert.equal(asks, 0);
});

test('QQ applies the unified access policy before attachments or Harness work', async () => {
  const fixture = stateFixture([['c2c:member-openid', 'session-member']]);
  let downloads = 0;
  const harnessCalls = [];
  const sent = [];
  const accessPolicy = directAccessPolicy({
    users: [{ id: 'member-openid', canExecuteCommands: false }],
    privilegedIds: ['owner-openid'],
  });
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async (_target, text) => {
        sent.push(text);
        return { id: `qq-policy-${sent.length}` };
      },
    },
    ownerUserOpenid: 'owner-openid',
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
    fetchImpl: async () => {
      downloads += 1;
      return new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' } });
    },
  });
  const directMessage = (messageId, senderId, content, overrides = {}) => message({
    messageId,
    senderId,
    content,
    replyTarget: { scope: 'c2c', targetId: senderId, msgId: messageId },
    ...overrides,
  });

  await bridge.accept(directMessage('policy-blocked-image', 'blocked-openid', '', {
    attachments: [{
      content_type: 'image/png',
      filename: 'blocked.png',
      url: 'https://multimedia.nt.qq.com.cn/download/blocked',
    }],
  }));
  assert.equal(downloads, 0);
  assert.deepEqual(harnessCalls, []);
  assert.deepEqual(sent, []);

  await bridge.accept(directMessage('policy-member-text', 'member-openid', '普通消息'));
  assert.equal(harnessCalls.some(([operation]) => operation === 'ask'), true);
  assert.deepEqual(sent, ['白名单消息已处理']);

  const callsBeforeDeniedCommand = harnessCalls.length;
  const repliesBeforeDeniedCommand = sent.length;
  await bridge.accept(directMessage('policy-member-command', 'member-openid', '/help'));
  assert.equal(harnessCalls.length, callsBeforeDeniedCommand);
  assert.deepEqual(sent.slice(repliesBeforeDeniedCommand), [COMMAND_PERMISSION_DENIED_MESSAGE]);

  accessPolicy.getSettings().direct.allowlist.users = [];
  await bridge.accept(directMessage('policy-owner-command', 'owner-openid', '/help'));
  assert.match(sent.at(-1), /\/help/);
});

test('QQ rejects non-platform image URLs without fetching and returns a retryable image error', async () => {
  const fixture = stateFixture([['c2c:owner-openid', 'session-image']]);
  const sent = [];
  let downloads = 0;
  const bridge = new QqHarnessBridge({
    bot: { sendText: async (_target, text) => sent.push(text) },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, content, options) => { await loadDeferredImages(content, options); assert.fail('invalid images must not reach the model'); },
    },
    state: fixture.state,
    logger: { error() {} },
    fetchImpl: async () => { downloads += 1; return new Response(PNG_BYTES); },
  });

  await bridge.accept(message({
    messageId: 'qq-image-untrusted',
    content: '这是什么',
    attachments: [{
      content_type: 'image/png',
      filename: 'photo.png',
      url: 'https://attacker.example/photo.png',
    }],
  }));

  assert.equal(downloads, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^图片下载失败，请重新发送后再试。/);
  assert.match(sent[0], /错误码：INPUT_INVALID；参考号：MF-[A-F0-9]{8}$/);
  assert.equal(fixture.seen.has('qq-image-untrusted'), true);
});

test('QQ exposes a structured model rate limit without changing connection state', async () => {
  const fixture = stateFixture([['c2c:owner-openid', 'session-rate-limit']]);
  const sent = [];
  const status = {
    ...createQqBridgeStatus(),
    connected: true,
    connectionState: 'connected',
  };
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async (_target, text) => {
        sent.push(text);
        return { id: 'qq-rate-limit-reply' };
      },
    },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async () => {
        const error = new Error('private QQ provider rate-limit detail');
        error.code = 'harness-turn-failed';
        error.providerCode = 'RATE_LIMIT';
        throw error;
      },
    },
    state: fixture.state,
    status,
    logger: { error() {} },
  });

  await bridge.accept(message({
    messageId: 'qq-rate-limit',
    content: '触发模型限流',
    replyTarget: {
      scope: 'c2c',
      targetId: 'owner-openid',
      msgId: 'qq-rate-limit',
    },
  }));

  const failure = status.lastMessageError;
  assert.equal(failure.code, 'MODEL_RATE_LIMIT');
  assert.equal(failure.reason, 'HARNESS_TURN_FAILED');
  assert.match(failure.referenceId, /^MF-[A-F0-9]{8}$/);
  assert.match(sent.at(-1), /模型服务正在限流，本次任务未完成。请稍后重试。/);
  assert.equal(sent.at(-1).endsWith(`参考号：${failure.referenceId}`), true);
  assert.doesNotMatch(sent.at(-1), /private QQ provider rate-limit detail/);
  assert.equal(status.connected, true);
  assert.equal(status.connectionState, 'connected');
});

test('QQ does not submit a redelivered message twice when the safe failure reply cannot send', async () => {
  const fixture = stateFixture([['c2c:owner-openid', 'session-redelivery']]);
  let asks = 0;
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async () => {
        throw new Error('QQ reply transport unavailable');
      },
    },
    ownerUserOpenid: 'owner-openid',
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
    logger: { warn() {}, error() {} },
  });
  const inbound = message({ messageId: 'qq-redelivered-after-failure' });

  await bridge.accept(inbound);
  await bridge.accept(inbound);

  assert.equal(asks, 1);
  assert.equal(fixture.seen.has(inbound.messageId), true);
});

test('QQ does not use an image caption as a pending Harness answer', async () => {
  const fixture = stateFixture([['c2c:owner-openid', 'session-question-image']]);
  const sent = [];
  const answered = deferred();
  let submitted;
  let downloads = 0;
  const bridge = new QqHarnessBridge({
    bot: { sendText: async (_target, text) => sent.push(text) },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      async ask(sessionId, _text, options) {
        await options.onInteraction({
          kind: 'question',
          interactionId: 'qq-question-image',
          rpcId: 'qq-question-image',
          sessionId,
          payload: {
            questions: [{
              id: 'environment',
              question: '请选择环境',
              options: [{ label: '生产环境' }],
            }],
          },
          async respond(result) {
            submitted = result;
            answered.resolve();
            return { accepted: true };
          },
        });
        await answered.promise;
        return '已完成';
      },
    },
    state: fixture.state,
    fetchImpl: async () => { downloads += 1; return new Response(PNG_BYTES); },
  });

  const first = bridge.accept(message({ messageId: 'qq-question-start', content: '开始提问' }));
  await eventually(() => sent.some((text) => text.includes('请选择环境')));
  await bridge.accept(message({
    messageId: 'qq-question-image-answer',
    content: '生产环境',
    attachments: [{
      content_type: 'image/png',
      filename: 'answer.png',
      url: 'https://multimedia.nt.qq.com.cn/download/answer',
    }],
  }));
  assert.equal(downloads, 0);
  assert.equal(submitted, undefined);
  assert.equal(sent.at(-1), '请用文字回答当前问题。');

  await bridge.accept(message({ messageId: 'qq-question-text-answer', content: '生产环境' }));
  await first;
  assert.deepEqual(submitted.value.answer.answers, [{
    id: 'environment',
    selected: ['生产环境'],
  }]);
});

test('QQ executes /compact for the bound Session without prompting the model', async () => {
  const fixture = stateFixture([['c2c:owner-openid', 'session-compact']]);
  const sent = [];
  const executed = [];
  const bridge = new QqHarnessBridge({
    bot: { sendText: async (_target, text) => sent.push(text) },
    ownerUserOpenid: 'owner-openid',
    harness: {
      executeCommand: async (sessionId, line) => {
        executed.push({ sessionId, line });
        return { commandId: 'compact-qq', result: { kind: 'success', text: 'Compacted 3 history items (~900 tokens).' } };
      },
      ask: async () => assert.fail('/compact must not be submitted to the model'),
    },
    state: fixture.state,
  });

  await bridge.accept(message({ messageId: 'compact-qq', content: '/compact' }));

  assert.deepEqual(executed, [{ sessionId: 'session-compact', line: '/compact' }]);
  assert.deepEqual(sent, ['已压缩 3 条历史记录（约 900 个 token）。']);
  assert.equal(fixture.seen.has('compact-qq'), true);
});

test('QQ lists models and presets without prompting and advertises fast commands', async () => {
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
      label: `QQ Preset ${index + 1} ${'x'.repeat(64)}`,
    })),
  };
  const bridge = new QqHarnessBridge({
    bot: { sendText: async (_target, text) => sent.push(text) },
    ownerUserOpenid: 'owner-openid',
    harness: {
      listModels: async () => ({
        groups: [{
          id: 'qq-provider',
          name: 'QQ Provider',
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
      createSession: async () => { creates += 1; return 'qq-session'; },
      ask: async () => { asks += 1; return 'unexpected model reply'; },
    },
    state: fixture.state,
  });

  await bridge.accept(message({ messageId: 'models-qq', content: '/models' }));
  assert.match(sent.at(-1), /1\. qq-provider\/model-one/);
  assert.equal(asks, 0);
  assert.equal(creates, 0);
  assert.equal(fixture.sessions.size, 0);

  await bridge.accept(message({ messageId: 'reasoning-qq', content: '/reasoninglist' }));
  assert.match(sent.at(-1), /还没有会话/);
  assert.equal(asks, 0);
  assert.equal(creates, 0);
  assert.equal(fixture.sessions.size, 0);

  const presetReplyStart = sent.length;
  await bridge.accept(message({ messageId: 'presets-qq', content: '/presetlist' }));
  const presetReplies = sent.slice(presetReplyStart);
  assert.ok(presetReplies.length > 1);
  assert.match(presetReplies.join('\n'), /preset-070/);
  assert.equal(asks, 0);
  assert.equal(creates, 0);
  assert.equal(fixture.sessions.size, 0);

  await bridge.accept(message({ messageId: 'preset-current-qq', content: '/preset' }));
  assert.match(sent.at(-1), /跟随 Host 默认/);
  assert.equal(asks, 0);
  assert.equal(creates, 0);

  const selectReplyStart = sent.length;
  await bridge.accept(message({ messageId: 'preset-select-qq', content: '/preset 2' }));
  assert.deepEqual(presetUpdates, ['preset-002']);
  assert.equal(sent.length, selectReplyStart + 1);
  assert.match(sent.at(-1), /preset-002/);

  const defaultReplyStart = sent.length;
  await bridge.accept(message({ messageId: 'preset-default-qq', content: '/preset --default' }));
  assert.deepEqual(presetUpdates, ['preset-002', null]);
  assert.equal(sent.length, defaultReplyStart + 1);
  assert.match(sent.at(-1), /跟随 Host 默认/);
  assert.equal(asks, 0);
  assert.equal(creates, 0);
  assert.equal(fixture.sessions.size, 0);

  await bridge.accept(message({ messageId: 'help-models-qq', content: '/help' }));
  const help = sent.at(-1);
  for (const command of [
    '/models', '/model', '/reasoninglist', '/reasonings', '/reasoning',
    '/presetlist', '/preset', '/preset --default', '/stop', '/steer',
    '/version',
  ]) {
    assert.equal(help.includes(command), true, command);
  }
  assert.match(help, /\/model .*\[推理等级ID\]/);
  assert.match(help, /示例：先发 \/models，再发 \/model 2 \[推理等级ID\]/);
  assert.doesNotMatch(help, /\/model 2 high\b/);
  assert.match(help, /\/preset id:<ID>/);
});

test('QQ remembers any authorized private inbound as a connection-test target', async () => {
  const fixture = stateFixture();
  const sent = [];
  const bridge = new QqHarnessBridge({
    bot: { sendText: async (target, text) => sent.push({ target, text }) },
    ownerUserOpenid: 'owner-openid',
    harness: { ensureRunning: async () => true },
    state: fixture.state,
  });

  await bridge.accept(message({
    messageId: 'help-rejected',
    senderId: 'other-openid',
    content: '/help',
    replyTarget: { scope: 'c2c', targetId: 'other-openid', msgId: 'help-rejected' },
  }));
  await bridge.accept(message({
    kind: 'group',
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    senderId: 'group-member-openid',
    groupOpenid: 'group-1',
    messageId: 'help-group',
    content: '/help',
    replyTarget: { scope: 'group', targetId: 'group-1', msgId: 'help-group' },
  }));
  assert.equal(connectionTestTarget(fixture.state), null);

  const privateTarget = {
    scope: 'c2c', targetId: 'owner-openid', msgId: 'help-private',
  };
  await bridge.accept(message({
    messageId: 'help-private',
    content: '/help',
    replyTarget: privateTarget,
  }));

  assert.deepEqual(connectionTestTarget(fixture.state), privateTarget);
  assert.equal(sent.length, 2);
});

test('QQ private messages deliver the final answer as Markdown without opening a stream', async () => {
  const markdown = [];
  const sentText = [];
  let streamCalls = 0;
  const seen = new Set();
  const bridge = new QqHarnessBridge({
    bot: {
      send: async (options) => {
        markdown.push(options);
        return { message: { id: 'qq-private-markdown' } };
      },
      sendText: async (_target, text) => sentText.push(text),
      openStream: () => { streamCalls += 1; },
    },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      createSession: async () => 'session-new',
      ensureRunning: async () => true,
      ask: async (_session, _text, { onUpdate, progressMode }) => {
        assert.equal(progressMode, 'all');
        await onUpdate({ type: 'text', text: '最终回' });
        await onUpdate({ type: 'text', text: '最终回答' });
        return '最终回答';
      },
    },
    state: {
      hasSeen: (id) => seen.has(id),
      markSeen: async (id) => seen.add(id),
      sessionFor: () => 'session-existing',
      setSession: async () => {},
      clearSession: async () => {},
    },
  });

  const receipt = await bridge.accept(message());
  assert.equal(markdown.length, 1);
  assert.equal(markdown[0].msgType, 2);
  assert.equal(markdown[0].markdown.content, '最终回答');
  assert.deepEqual(markdown[0].target, {
    scope: 'c2c', targetId: 'owner-openid', msgId: 'msg-1',
  });
  assert.equal(Number.isInteger(markdown[0].extra.msg_seq), true);
  assert.deepEqual(sentText, []);
  assert.equal(streamCalls, 0);
  assert.equal(seen.has('msg-1'), true);
  assert.equal(bridge.status.messagesReplied, 1);
  assert.deepEqual(receipt.providerMessageIds, ['qq-private-markdown']);
});

test('QQ group messages suppress every successful progress update', async () => {
  const sent = [];
  let streamCalls = 0;
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async (_target, text) => sent.push(text),
      openStream: () => { streamCalls += 1; throw new Error('group stream must not open'); },
    },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async (_session, _text, { onUpdate }) => {
        await onUpdate({ type: 'tool', name: 'bash' });
        // 工具结束后 Harness 客户端会下发 status 帧“正在整理结果…”。
        await onUpdate({ type: 'status', text: '正在整理结果…', toolName: 'bash' });
        await onUpdate({ type: 'tool', name: 'read' });
        await onUpdate({ type: 'status', text: '正在整理结果…', toolName: 'read' });
        return '最终回答';
      },
    },
    state: {
      hasSeen: () => false,
      markSeen: async () => {},
      sessionFor: () => 'session-status',
      setSession: async () => {},
      clearSession: async () => {},
    },
  });

  await bridge.accept(message({
    kind: 'group',
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    groupOpenid: 'group-progress',
    messageId: 'msg-status-frame',
    replyTarget: { scope: 'group', targetId: 'group-progress', msgId: 'msg-status-frame' },
  }));
  assert.deepEqual(sent, ['最终回答']);
  assert.equal(streamCalls, 0);
});

test('QQ group messages append a stable tool failure notice without exposing provider details', async () => {
  const sent = [];
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async (_target, text) => sent.push(text),
    },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async (_session, _text, { onUpdate }) => {
        await onUpdate({ type: 'text', text: '实体不存在，先创建再添加观察：' });
        await onUpdate({ type: 'tool', name: 'add_observations' });
        await onUpdate({
          type: 'status',
          text: '正在整理结果…',
          toolName: 'add_observations',
          error: 'Error calling add_observations. Status code: 404.',
        });
        await onUpdate({ type: 'text', text: '改用创建实体的方式：' });
        await onUpdate({ type: 'tool', name: 'create_entities' });
        await onUpdate({ type: 'status', text: '正在整理结果…', toolName: 'create_entities' });
        return '已存入两套记忆。';
      },
    },
    state: {
      hasSeen: () => false,
      markSeen: async () => {},
      sessionFor: () => 'session-tool-error',
      setSession: async () => {},
      clearSession: async () => {},
    },
  });

  await bridge.accept(message({
    kind: 'group',
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    groupOpenid: 'group-error',
    messageId: 'msg-tool-error',
    replyTarget: { scope: 'group', targetId: 'group-error', msgId: 'msg-tool-error' },
  }));
  assert.deepEqual(sent, [
    '已存入两套记忆。\n\n---\n\n工具调用「add_observations」未成功，请检查工具配置或稍后重试。',
  ]);
  assert.doesNotMatch(sent[0], /Error calling|Status code|404/);
});

test('QQ sends neutral completion replies and retains tool failure notices', async () => {
  for (const toolFailed of [false, true]) {
    const sent = [];
    const status = createQqBridgeStatus();
    status.lastError = 'previous failure';
    status.lastMessageError = { code: 'MODEL_EMPTY_REPLY' };
    const fixture = stateFixture([['c2c:owner-openid', 'session-empty-completed']]);
    const bridge = new QqHarnessBridge({
      bot: { sendText: async (_target, text) => sent.push(text) },
      ownerUserOpenid: 'owner-openid',
      status,
      harness: {
        sessionExists: async () => true,
        ask: async (_session, _text, { onUpdate }) => {
          if (toolFailed) await onUpdate({ type: 'status', toolName: 'bash', error: 'private detail' });
          return '本轮处理已结束，没有文本回复。';
        },
      },
      state: fixture.state,
    });
    await bridge.accept(message());
    assert.deepEqual(sent, [toolFailed
      ? '本轮处理已结束，没有文本回复。\n\n---\n\n工具调用「bash」未成功，请检查工具配置或稍后重试。'
      : '本轮处理已结束，没有文本回复。']);
    assert.equal(status.messagesReplied, 1);
    assert.equal(status.lastError, null);
    assert.equal(status.lastMessageError, null);
  }
});

test('QQ delivers final group answers as markdown messages', async () => {
  const sentText = [];
  const markdownCalls = [];
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async (_target, text) => sentText.push(text),
      send: async (options) => {
        markdownCalls.push(options);
        return { id: `md-${markdownCalls.length}` };
      },
    },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async () => '## 标题\n\n**加粗**与 `代码`',
    },
    state: {
      hasSeen: () => false,
      markSeen: async () => {},
      sessionFor: () => 'session-group',
      setSession: async () => {},
      clearSession: async () => {},
    },
  });

  await bridge.accept(message({
    kind: 'group',
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    groupOpenid: 'group-md',
    messageId: 'msg-group-md',
    content: '请回答',
    replyTarget: { scope: 'group', targetId: 'group-md', msgId: 'msg-group-md' },
  }));
  assert.equal(markdownCalls.length, 1);
  assert.equal(markdownCalls[0].msgType, 2);
  assert.equal(markdownCalls[0].markdown.content, '## 标题\n\n**加粗**与 `代码`');
  assert.equal(Number.isInteger(markdownCalls[0].extra.msg_seq), true);
  assert.deepEqual(sentText, []);
  assert.equal(bridge.status.messagesReplied, 1);
});

test('QQ falls back to plain text when the platform rejects markdown', async () => {
  const sentText = [];
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async () => { throw new Error('fallback must explicitly use msg_type=0'); },
      send: async (options) => {
        if (options.msgType === 2) {
          throw new ApiError(
            'markdown rejected',
            400,
            '/v2/users/test/messages',
            40_034_090,
            'markdown rejected',
          );
        }
        sentText.push(options.content);
        return { id: 'plain-fallback' };
      },
    },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async () => '**回答**内容',
    },
    state: {
      hasSeen: () => false,
      markSeen: async () => {},
      sessionFor: () => 'session-fallback',
      setSession: async () => {},
      clearSession: async () => {},
    },
    logger: { warn() {}, error() {} },
  });

  await bridge.accept(message({
    messageId: 'msg-md-fallback',
    replyTarget: { scope: 'c2c', targetId: 'owner-openid', msgId: 'msg-md-fallback' },
  }));
  assert.deepEqual(sentText, ['**回答**内容']);
  assert.equal(bridge.status.messagesReplied, 1);
  assert.equal(bridge.status.lastError, null);
});

test('QQ announces a stopped turn and closes its unused private stream', async () => {
  const fixture = stateFixture([['c2c:owner-openid', 'session-stopped']]);
  const sent = [];
  let loggedErrors = 0;
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async (_target, text) => sent.push(text),
    },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, { onUpdate }) => {
        await onUpdate({ type: 'tool', name: 'bash' });
        const error = new Error('turn stopped');
        error.code = 'turn-stopped';
        throw error;
      },
    },
    state: fixture.state,
    logger: { warn() {}, error() { loggedErrors += 1; } },
  });

  await bridge.accept(message({ messageId: 'qq-stopped-stream' }));

  assert.deepEqual(sent, ['已停止。']);
  assert.equal(loggedErrors, 0);
  assert.equal(fixture.seen.has('qq-stopped-stream'), true);
});

test('QQ keeps a stopped turn terminal when its notice cannot be sent', async () => {
  const fixture = stateFixture([['c2c:owner-openid', 'session-stopped-fallback']]);
  let warnings = 0;
  let loggedErrors = 0;
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async () => { throw new Error('send unavailable'); },
    },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async () => {
        const error = new Error('turn stopped');
        error.code = 'turn-stopped';
        throw error;
      },
    },
    state: fixture.state,
    logger: {
      warn() { warnings += 1; },
      error() { loggedErrors += 1; },
    },
  });

  await bridge.accept(message({ messageId: 'qq-stopped-stream-fallback' }));

  assert.equal(warnings, 1);
  assert.equal(loggedErrors, 0);
  assert.equal(fixture.seen.has('qq-stopped-stream-fallback'), true);
});

test('QQ bridge keeps private chats scanner-only and accepts any mentioned group member', async () => {
  const asks = [];
  const state = {
    hasSeen: () => false,
    markSeen: async () => {},
    sessionFor: () => 'session',
    sessionExists: async () => true,
    setSession: async () => {},
    clearSession: async () => {},
  };
  const bridge = new QqHarnessBridge({
    bot: { sendText: async () => {} },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async (sessionId, text) => { asks.push({ sessionId, text }); return 'ok'; },
    },
    state,
  });
  await bridge.accept(message({ messageId: 'other', senderId: 'other-openid' }));
  await bridge.accept(message({
    messageId: 'group-unmentioned',
    kind: 'group',
    senderId: 'other-member-openid',
    groupOpenid: 'group-1',
    rawEventType: 'GROUP_MESSAGE_CREATE',
    replyTarget: { scope: 'group', targetId: 'group-1', msgId: 'group-unmentioned' },
  }));
  await bridge.accept(message({
    messageId: 'group-mentioned',
    kind: 'group',
    senderId: 'other-member-openid',
    groupOpenid: 'group-1',
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    content: '群成员的问题',
    replyTarget: { scope: 'group', targetId: 'group-1', msgId: 'group-mentioned' },
  }));
  assert.deepEqual(asks, [{ sessionId: 'session', text: '群成员的问题' }]);
  assert.equal(bridge.status.messagesRejected, 1);
});

test('QQ credential-bound bots accept senders within the platform visibility scope', async () => {
  let asks = 0;
  const bridge = new QqHarnessBridge({
    bot: { sendText: async () => {} },
    ownerUserOpenid: '*',
    harness: {
      sessionExists: async () => true,
      ask: async () => { asks += 1; return 'ok'; },
    },
    state: {
      hasSeen: () => false,
      markSeen: async () => {},
      sessionFor: () => 'session',
      setSession: async () => {},
      clearSession: async () => {},
    },
  });
  await bridge.accept(message({ messageId: 'visible', senderId: 'visible-user' }));
  assert.equal(asks, 1);
  assert.equal(bridge.status.messagesRejected, 0);
});

test('QQ group questions require the initiating actor to mention the bot and preserve multi-question answers', async () => {
  const fixture = stateFixture([['group:group-1', 'session-group']]);
  const sent = [];
  const asked = [];
  const submitted = deferred();
  const secondQuestionDelivered = deferred();
  const releaseSecondQuestion = deferred();
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async (target, text) => {
        sent.push({ target, text });
        if (text.includes('选择交付内容')) {
          secondQuestionDelivered.resolve();
          await releaseSecondQuestion.promise;
        }
      },
    },
    ownerUserOpenid: '*',
    harness: {
      sessionExists: async () => true,
      createSession: async () => assert.fail('the existing session should be reused'),
      ask: async (sessionId, text, options) => {
        asked.push({ sessionId, text });
        if (text === '旁观者的普通问题') return '旁观者问题已回答';
        await options.onInteraction({
          kind: 'question',
          interactionId: 'qq-group-multi',
          rpcId: 'qq-group-multi',
          sessionId,
          payload: {
            type: 'question/requested',
            sessionId,
            questions: [
              {
                id: 'language',
                question: '选择回答语言',
                options: [{ label: '中文' }, { label: 'English' }],
              },
              {
                id: 'deliverables',
                question: '选择交付内容',
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
        return '发起者交互完成';
      },
    },
    state: fixture.state,
  });

  const first = bridge.accept(message({
    kind: 'group',
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    senderId: 'initiator',
    groupOpenid: 'group-1',
    content: '启动群聊交互',
    messageId: 'group-start',
    replyTarget: { scope: 'group', targetId: 'group-1', msgId: 'group-start' },
  }));
  await eventually(() => sent.some(({ text }) => text.includes('选择回答语言')));
  assert.equal(sent.find(({ text }) => text.includes('选择回答语言')).text
    .includes('群聊中请 @机器人 后发送答案。'), true);

  let submittedResult;
  submitted.promise.then((result) => { submittedResult = result; });
  const bystander = bridge.accept(message({
    kind: 'group',
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    senderId: 'bystander',
    groupOpenid: 'group-1',
    content: '旁观者的普通问题',
    messageId: 'group-bystander',
    replyTarget: { scope: 'group', targetId: 'group-1', msgId: 'group-bystander' },
  }));
  await bridge.accept(message({
    kind: 'group',
    rawEventType: 'GROUP_MESSAGE_CREATE',
    senderId: 'initiator',
    groupOpenid: 'group-1',
    content: '未提及机器人的答案',
    messageId: 'group-unmentioned',
    replyTarget: { scope: 'group', targetId: 'group-1', msgId: 'group-unmentioned' },
  }));
  assert.equal(submittedResult, undefined);

  const firstAnswer = bridge.accept(message({
    kind: 'group',
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    senderId: 'initiator',
    groupOpenid: 'group-1',
    content: '2',
    messageId: 'group-language',
    replyTarget: { scope: 'group', targetId: 'group-1', msgId: 'group-language' },
  }));
  await secondQuestionDelivered.promise;
  const secondAnswer = bridge.accept(message({
    kind: 'group',
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    senderId: 'initiator',
    groupOpenid: 'group-1',
    content: '1，文档，发布说明',
    messageId: 'group-deliverables',
    replyTarget: { scope: 'group', targetId: 'group-1', msgId: 'group-deliverables' },
  }));
  releaseSecondQuestion.resolve();
  await Promise.all([firstAnswer, secondAnswer]);

  assert.deepEqual(await submitted.promise, {
    ok: true,
    value: {
      sessionId: 'session-group',
      answer: {
        answers: [
          { id: 'language', selected: ['English'] },
          { id: 'deliverables', selected: ['测试', '文档'], custom: '发布说明' },
        ],
      },
    },
  });
  await Promise.all([first, bystander]);
  assert.deepEqual(asked, [
    { sessionId: 'session-group', text: '启动群聊交互' },
    { sessionId: 'session-group', text: '旁观者的普通问题' },
  ]);
  assert.equal(asked.some(({ text }) => [
    '未提及机器人的答案',
    '2',
    '1，文档，发布说明',
  ].includes(text)), false);
  assert.deepEqual(sent.slice(-2).map(({ text }) => text), ['发起者交互完成', '旁观者问题已回答']);
});

test('QQ pending questions stay isolated between private conversations', async () => {
  const fixture = stateFixture([
    ['c2c:user-a', 'session-a'],
    ['c2c:user-b', 'session-b'],
  ]);
  const sent = [];
  const asked = [];
  const answeredA = deferred();
  const responseA = deferred();
  const bridge = new QqHarnessBridge({
    bot: { sendText: async (target, text) => sent.push({ target, text }) },
    ownerUserOpenid: '*',
    harness: {
      sessionExists: async () => true,
      createSession: async () => assert.fail('the existing sessions should be reused'),
      ask: async (sessionId, text, options) => {
        asked.push({ sessionId, text });
        if (sessionId === 'session-b') return '乙会话的普通回答';
        await options.onInteraction({
          kind: 'question',
          interactionId: 'qq-isolated-a',
          rpcId: 'qq-isolated-a',
          sessionId,
          payload: {
            type: 'question/requested',
            sessionId,
            questions: [{ id: 'answer-a', question: '甲会话的问题' }],
          },
          respond: async (result) => {
            responseA.resolve(result);
            answeredA.resolve();
            return { accepted: true };
          },
        });
        await answeredA.promise;
        return '甲会话完成';
      },
    },
    state: fixture.state,
  });

  const firstA = bridge.accept(message({
    senderId: 'user-a',
    content: '启动甲会话',
    messageId: 'private-a-start',
    replyTarget: { scope: 'c2c', targetId: 'user-a', msgId: 'private-a-start' },
  }));
  await eventually(() => sent.some(({ text }) => text.includes('甲会话的问题')));
  await bridge.accept(message({
    senderId: 'user-b',
    content: '乙会话的消息',
    messageId: 'private-b',
    replyTarget: { scope: 'c2c', targetId: 'user-b', msgId: 'private-b' },
  }));
  assert.equal(sent.some(({ target, text }) => (
    target.targetId === 'user-b' && text === '乙会话的普通回答'
  )), true);

  await bridge.accept(message({
    senderId: 'user-a',
    content: '甲的答案',
    messageId: 'private-a-answer',
    replyTarget: { scope: 'c2c', targetId: 'user-a', msgId: 'private-a-answer' },
  }));
  await firstA;
  assert.deepEqual((await responseA.promise).value.answer.answers, [
    { id: 'answer-a', selected: [], custom: '甲的答案' },
  ]);
  assert.deepEqual(asked, [
    { sessionId: 'session-a', text: '启动甲会话' },
    { sessionId: 'session-b', text: '乙会话的消息' },
  ]);
});

test('QQ presents concurrent approvals in FIFO order without a code and consumes exact decisions', async () => {
  const fixture = stateFixture([['c2c:owner-openid', 'session-approval']]);
  const sent = [];
  const asked = [];
  const completed = deferred();
  const responses = [];
  const bridge = new QqHarnessBridge({
    bot: { sendText: async (target, text) => sent.push({ target, text }) },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      createSession: async () => assert.fail('the existing session should be reused'),
      ask: async (sessionId, text, options) => {
        asked.push(text);
        for (const [approvalId, reason, command] of [
          ['qq-approval-one', '允许执行第一步', "printf 'first-step\\n'"],
          ['qq-approval-two', '允许执行第二步', "printf 'second-step\\n'"],
        ]) {
          await options.onInteraction({
            kind: 'approval',
            interactionId: approvalId,
            rpcId: `${approvalId}-rpc`,
            sessionId,
            payload: {
              type: 'approval/requested',
              sessionId,
              approvalId,
              toolName: 'bash',
              callId: `${approvalId}-call`,
              reason,
            },
            toolCall: {
              callId: `${approvalId}-call`,
              name: 'bash',
              arguments: JSON.stringify({ command }),
            },
            respond: async (result) => {
              responses.push(result);
              if (responses.length === 2) completed.resolve();
              return { accepted: true };
            },
          });
        }
        await completed.promise;
        return '审批完成';
      },
    },
    state: fixture.state,
  });

  const prompt = bridge.accept(message({
    messageId: 'approval-start',
    content: '启动两个审批',
  }));
  await eventually(() => sent.some(({ text }) => text.includes('允许执行第一步')));
  assert.equal(sent.some(({ text }) => text.includes('允许执行第二步')), false);
  assert.match(sent.find(({ text }) => text.includes('允许执行第一步')).text, /bash/);
  assert.match(sent.find(({ text }) => text.includes('允许执行第一步')).text, /批准.*拒绝/s);
  assert.doesNotMatch(sent.find(({ text }) => text.includes('允许执行第一步')).text, /qq-approval-one/);

  await bridge.accept(message({
    messageId: 'approval-allow',
    content: '批准',
    replyTarget: { scope: 'c2c', targetId: 'owner-openid', msgId: 'approval-allow' },
  }));
  await eventually(() => sent.some(({ text }) => text.includes('允许执行第二步')));
  assert.doesNotMatch(sent.find(({ text }) => text.includes('允许执行第二步')).text, /qq-approval-two/);

  await Promise.all([
    bridge.accept(message({
      messageId: 'approval-reject',
      content: '拒绝',
      replyTarget: { scope: 'c2c', targetId: 'owner-openid', msgId: 'approval-reject' },
    })),
    prompt,
  ]);

  assert.deepEqual(responses, [
    {
      ok: true,
      value: {
        sessionId: 'session-approval',
        approvalId: 'qq-approval-one',
        outcome: 'allowed-once',
      },
    },
    {
      ok: true,
      value: {
        sessionId: 'session-approval',
        approvalId: 'qq-approval-two',
        outcome: 'rejected',
      },
    },
  ]);
  assert.deepEqual(asked, ['启动两个审批']);
  assert.equal(sent.at(-1).text, '审批完成');
});

test('QQ deduplicates question replays, cancels orphan questions, and keeps approvals fail-closed', async () => {
  const fixture = stateFixture();
  const sent = [];
  let approvalResponse;
  let parallelResponse;
  let orphanResponse;
  const bridge = new QqHarnessBridge({
    bot: { sendText: async (target, text) => sent.push({ target, text }) },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => false,
      createSession: async () => 'session-replay',
      ask: async (sessionId, _text, options) => {
        const replayedQuestion = {
          kind: 'question',
          interactionId: 'qq-replayed-question',
          rpcId: 'qq-replayed-question',
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
          interactionId: 'qq-parallel-question',
          rpcId: 'qq-parallel-question',
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
          interactionId: 'qq-approval',
          rpcId: 'qq-approval',
          sessionId,
          payload: {
            type: 'approval/requested',
            sessionId,
            approvalId: 'qq-approval',
            toolName: 'bash',
          },
          respond: async (result) => { approvalResponse = result; },
        });
        await options.onInteractionResolved({
          kind: 'question',
          interactionId: 'qq-replayed-question',
          sessionId,
          outcome: 'cancelled',
        });
        await options.onInteraction({
          kind: 'question',
          interactionId: 'qq-orphan-question',
          rpcId: 'qq-orphan-question',
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

  await bridge.accept(message({ messageId: 'qq-replay', content: '测试交互重放' }));

  assert.equal(sent.filter(({ text }) => text.includes('只应显示一次')).length, 1);
  assert.deepEqual(parallelResponse, {
    ok: false,
    error: {
      code: 'cancelled',
      message: 'QQ is already handling another user interaction.',
      details: {},
    },
  });
  assert.deepEqual(approvalResponse, {
    ok: true,
    value: {
      sessionId: 'session-replay',
      approvalId: 'qq-approval',
      outcome: 'rejected',
    },
  });
  assert.equal(sent.some(({ text }) => text.includes('approval')), false);
  assert.deepEqual(orphanResponse, {
    ok: false,
    error: {
      code: 'cancelled',
      message: 'QQ safely cancelled an interaction left by an earlier client.',
      details: {},
    },
  });
  assert.equal(sent.some(({ text }) => text.includes('旧会话中的敏感问题内容')), false);
  assert.equal(sent.some(({ text }) => text.includes('遗留的待回答问题')), true);
  assert.equal(sent.at(-1).text, '交互恢复完成');
});

test('QQ keeps a queued prompt separate while a failed interaction answer is retried', async () => {
  const fixture = stateFixture([['c2c:owner-openid', 'session-submit-retry']]);
  const sent = [];
  const asked = [];
  const firstSubmitStarted = deferred();
  const releaseFirstSubmit = deferred();
  const answered = deferred();
  const submittedAnswers = [];
  let submitAttempts = 0;
  const bridge = new QqHarnessBridge({
    bot: { sendText: async (target, text) => sent.push({ target, text }) },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      createSession: async () => assert.fail('the existing session should be reused'),
      ask: async (sessionId, text, options) => {
        asked.push(text);
        if (text === '排队的下一个问题') return '第二轮完成';
        await options.onInteraction({
          kind: 'question',
          interactionId: 'qq-submit-retry',
          rpcId: 'qq-submit-retry',
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

  const first = bridge.accept(message({ messageId: 'retry-start', content: '启动可重试交互' }));
  await eventually(() => sent.some(({ text }) => text.includes('请回答后再继续')));
  const firstAnswer = bridge.accept(message({
    messageId: 'retry-first-answer',
    content: '第一次答案',
    replyTarget: { scope: 'c2c', targetId: 'owner-openid', msgId: 'retry-first-answer' },
  }));
  await firstSubmitStarted.promise;

  let nextSettled = false;
  const next = bridge.accept(message({
    messageId: 'retry-next',
    content: '排队的下一个问题',
    replyTarget: { scope: 'c2c', targetId: 'owner-openid', msgId: 'retry-next' },
  })).finally(() => { nextSettled = true; });
  releaseFirstSubmit.resolve();
  await firstAnswer;
  await eventually(() => sent.some(({ text }) => text.includes('回答提交失败')));
  assert.equal(nextSettled, false);
  assert.deepEqual(asked, ['启动可重试交互']);

  await Promise.all([
    bridge.accept(message({
      messageId: 'retry-second-answer',
      content: '重试后的答案',
      replyTarget: { scope: 'c2c', targetId: 'owner-openid', msgId: 'retry-second-answer' },
    })),
    first,
    next,
  ]);

  assert.deepEqual(submittedAnswers, ['第一次答案', '重试后的答案']);
  assert.deepEqual(asked, ['启动可重试交互', '排队的下一个问题']);
  assert.deepEqual(sent.slice(-2).map(({ text }) => text), ['第一轮完成', '第二轮完成']);
});

test('QQ discards an already-claimed answer when the interaction resolves elsewhere', async () => {
  const fixture = stateFixture([['c2c:owner-openid', 'session-resolved-race']]);
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
  const bridge = new QqHarnessBridge({
    bot: { sendText: async (target, text) => sent.push({ target, text }) },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      createSession: async () => assert.fail('the existing session should be reused'),
      ask: async (sessionId, text, options) => {
        asked.push(text);
        if (text === '后来的普通问题') return '后来问题的回答';
        await options.onInteraction({
          kind: 'question',
          interactionId: 'qq-resolved-race',
          rpcId: 'qq-resolved-race',
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
            interactionId: 'qq-resolved-race',
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

  const first = bridge.accept(message({ messageId: 'resolved-start', content: '启动外部解决竞态' }));
  await eventually(() => typeof resolveInteraction === 'function');
  const answer = bridge.accept(message({
    messageId: 'resolved-answer',
    content: '原本的问题答案',
    replyTarget: { scope: 'c2c', targetId: 'owner-openid', msgId: 'resolved-answer' },
  }));
  await answerMarkStarted.promise;
  const later = bridge.accept(message({
    messageId: 'resolved-later',
    content: '后来的普通问题',
    replyTarget: { scope: 'c2c', targetId: 'owner-openid', msgId: 'resolved-later' },
  }));
  await resolveInteraction();
  releaseAnswerMark.resolve();

  await Promise.all([answer, first, later]);
  assert.deepEqual(asked, ['启动外部解决竞态', '后来的普通问题']);
  assert.equal(asked.includes('原本的问题答案'), false);
  assert.equal(sent.some(({ text }) => text.includes('已在其他客户端处理')), true);
});

test('QQ keeps an answer that arrives after the first question is delivered but before its send ACK', async () => {
  const fixture = stateFixture([['c2c:owner-openid', 'session-first-delivery']]);
  const questionDelivered = deferred();
  const releaseQuestionAck = deferred();
  const answered = deferred();
  const sent = [];
  const asked = [];
  let submitted;
  let questionSends = 0;
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async (target, text) => {
        sent.push({ target, text });
        if (text.includes('首问 ACK 窗口')) {
          questionSends += 1;
          questionDelivered.resolve();
          await releaseQuestionAck.promise;
        }
      },
    },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async (sessionId, text, options) => {
        asked.push(text);
        await options.onInteraction({
          kind: 'question',
          interactionId: 'qq-first-delivery',
          rpcId: 'qq-first-delivery',
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

  const first = bridge.accept(message({
    messageId: 'first-delivery-start',
    content: '启动首问窗口',
  }));
  await questionDelivered.promise;
  const answer = bridge.accept(message({
    messageId: 'first-delivery-answer',
    content: '窗口内答案',
    replyTarget: { scope: 'c2c', targetId: 'owner-openid', msgId: 'first-delivery-answer' },
  }));
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

test('QQ tombstones a q2 answer accepted before its send ACK when the interaction resolves', async () => {
  const fixture = stateFixture([['c2c:owner-openid', 'session-q2-resolved']]);
  const secondQuestionDelivered = deferred();
  const releaseSecondQuestionAck = deferred();
  const turnResolved = deferred();
  const sent = [];
  const asked = [];
  let resolveInteraction;
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async (target, text) => {
        sent.push({ target, text });
        if (text.includes('会在 ACK 前 resolved 的第二问')) {
          secondQuestionDelivered.resolve();
          await releaseSecondQuestionAck.promise;
        }
      },
    },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async (sessionId, text, options) => {
        asked.push(text);
        await options.onInteraction({
          kind: 'question',
          interactionId: 'qq-q2-resolved',
          rpcId: 'qq-q2-resolved',
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
            interactionId: 'qq-q2-resolved',
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

  const first = bridge.accept(message({
    messageId: 'q2-resolved-start',
    content: '启动 q2 resolved 窗口',
  }));
  await eventually(() => typeof resolveInteraction === 'function');
  const firstAnswer = bridge.accept(message({
    messageId: 'q2-resolved-first',
    content: '第一问答案',
    replyTarget: { scope: 'c2c', targetId: 'owner-openid', msgId: 'q2-resolved-first' },
  }));
  await secondQuestionDelivered.promise;
  const secondAnswer = bridge.accept(message({
    messageId: 'q2-resolved-second',
    content: '第二问答案',
    replyTarget: { scope: 'c2c', targetId: 'owner-openid', msgId: 'q2-resolved-second' },
  }));
  resolveInteraction();
  releaseSecondQuestionAck.resolve();
  await Promise.all([firstAnswer, secondAnswer, first]);

  assert.deepEqual(asked, ['启动 q2 resolved 窗口']);
  assert.equal(fixture.seen.has('q2-resolved-second'), true);
  assert.equal(sent.some(({ text }) => text.includes('已在其他客户端处理')), true);
});

test('QQ reports resolved when an in-flight response becomes not-pending', async () => {
  const fixture = stateFixture([['c2c:owner-openid', 'session-respond-resolved']]);
  const responseStarted = deferred();
  const releaseResponse = deferred();
  const turnResolved = deferred();
  const sent = [];
  let resolveInteraction;
  const bridge = new QqHarnessBridge({
    bot: { sendText: async (target, text) => sent.push({ target, text }) },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async (sessionId, _text, options) => {
        await options.onInteraction({
          kind: 'question',
          interactionId: 'qq-respond-resolved',
          rpcId: 'qq-respond-resolved',
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
            interactionId: 'qq-respond-resolved',
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

  const first = bridge.accept(message({
    messageId: 'respond-resolved-start',
    content: '启动提交竞态',
  }));
  await eventually(() => typeof resolveInteraction === 'function');
  const answer = bridge.accept(message({
    messageId: 'respond-resolved-answer',
    content: '我的答案',
    replyTarget: { scope: 'c2c', targetId: 'owner-openid', msgId: 'respond-resolved-answer' },
  }));
  await responseStarted.promise;
  resolveInteraction();
  releaseResponse.resolve();
  await Promise.all([answer, first]);

  assert.equal(sent.some(({ text, target }) => (
    target.msgId === 'respond-resolved-answer'
      && text.includes('已在其他客户端处理')
  )), true);
});

test('QQ propagates the stop signal and cancels its pending question on abort', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('c2c:owner-openid', 'stale-session');
  const controller = new AbortController();
  const interactionReady = deferred();
  let existsSignal;
  let createSignal;
  let askSignal;
  let cancellation;
  let cancellationSignal;
  const bridge = new QqHarnessBridge({
    bot: { sendText: async () => {} },
    ownerUserOpenid: 'owner-openid',
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
          interactionId: 'qq-abort-question',
          rpcId: 'qq-abort-question',
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

  const turn = bridge.accept(message({ messageId: 'abort-start', content: '启动后停止' }));
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
      message: 'The QQ interaction ended before the user answered.',
      details: {},
    },
  });
  assert.notEqual(cancellationSignal, controller.signal);
  assert.equal(cancellationSignal.aborted, false);
});

test('QQ sends registered files after text with the native SDK and continues after one file fails', async (t) => {
  const first = await committedArtifact(t, 'first.txt', 'first bytes', 'partial-first');
  const second = await committedArtifact(t, 'second.html', '<h1>second</h1>', 'partial-second');
  const order = [];
  const sentTexts = [];
  const files = [];
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
  const target = { scope: 'c2c', targetId: 'owner-openid', msgId: 'qq-artifact-partial' };
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async (replyTarget, text) => {
        sentTexts.push({ replyTarget, text });
        order.push(`text:${text}`);
        return { id: `text-${sentTexts.length}` };
      },
      sendFile: async (replyTarget, source, options) => {
        files.push({ replyTarget, source, options });
        order.push(`file:${options.fileName}`);
        if (options.fileName === 'first.txt') {
          const error = new Error('private quota detail');
          error.name = 'UploadDailyLimitExceededError';
          throw error;
        }
        return { message: { id: 'qq-file-2' } };
      },
    },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(first);
        await options.onArtifact(second);
        return '文件处理完成。';
      },
    },
    state: stateFixture([['c2c:owner-openid', 'session-artifacts']]).state,
    status,
    logger: { warn() {}, error() {} },
  });

  await bridge.accept(message({
    messageId: 'qq-artifact-partial',
    replyTarget: target,
  }));

  assert.deepEqual(order.map((entry) => entry.split(':', 1)[0]), [
    'text', 'file', 'text', 'file',
  ]);
  assert.equal(files[0].replyTarget, target);
  assert.equal(files[0].source.buffer.toString(), 'first bytes');
  assert.equal(files[0].options.fileName, 'first.txt');
  assert.equal(typeof files[0].options.onProgress, 'function');
  assert.equal(files[1].source.buffer.toString(), '<h1>second</h1>');
  assert.equal(files[1].options.fileName, 'second.html');
  assert.match(sentTexts[1].text, /first\.txt.*上传额度/);
  assert.equal(status.lastMessageError.code, 'CHANNEL_RATE_LIMIT');
  assert.equal(status.lastMessageError.reason, 'ARTIFACT_RATE_LIMITED');
  assert.equal(
    sentTexts[1].text.endsWith(`参考号：${status.lastMessageError.referenceId}`),
    true,
  );
  assert.doesNotMatch(sentTexts[1].text, /private quota detail/);
  assert.equal(status.artifactsSent, 1);
  assert.equal(status.artifactSendErrors, 1);
});

test('QQ still delivers registered files when every final text delivery attempt fails', async (t) => {
  const artifact = await committedArtifact(t, 'survives-text-failure.txt', 'file bytes', 'text-failure');
  const files = [];
  let textAttempts = 0;
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async () => {
        textAttempts += 1;
        throw new Error('text transport unavailable');
      },
      sendFile: async (_target, source, options) => {
        files.push({ bytes: Buffer.from(source.buffer), fileName: options.fileName });
        return { message: { id: 'qq-file-after-text-failure' } };
      },
    },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '文字结果';
      },
    },
    state: stateFixture([['c2c:owner-openid', 'session-text-failure']]).state,
    logger: { warn() {}, error() {} },
  });

  await bridge.accept(message({ messageId: 'qq-text-failure' }));

  assert.deepEqual(files, [{ bytes: Buffer.from('file bytes'), fileName: 'survives-text-failure.txt' }]);
  assert.equal(textAttempts, 1, 'must not send a generic retry notice after the file succeeds');
  assert.equal(bridge.status.lastMessageError.code, 'CHANNEL_DELIVERY_UNCERTAIN');
  assert.match(bridge.status.lastMessageError.referenceId, /^MF-[A-F0-9]{8}$/);
});

test('QQ returns the authoritative receipt and sends one safe notice when text and file delivery fail', async (t) => {
  const artifact = await committedArtifact(t, 'mismatch.txt', 'file bytes', 'all-fail');
  const attemptedTexts = [];
  const visibleTexts = [];
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async (_target, text) => {
        attemptedTexts.push(text);
        if (text === '文字结果') throw new Error('text transport unavailable');
        visibleTexts.push(text);
        return undefined;
      },
      sendFile: async () => {
        const error = new Error('mismatched file signature');
        error.code = 'artifact-invalid';
        throw error;
      },
    },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '文字结果';
      },
    },
    state: stateFixture([['c2c:owner-openid', 'session-all-fail']]).state,
    logger: { warn() {}, error() {} },
  });

  const receipt = await bridge.accept(message({ messageId: 'qq-all-fail' }));

  assert.equal(attemptedTexts.length, 2, 'must not append a generic error after the safe notice');
  assert.equal(visibleTexts.length, 1);
  assert.match(visibleTexts[0], /暂时无法读取或准备发送.*仍可访问/);
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    deliveryId: 'qq-all-fail',
    presentation: 'qq-files',
    providerMessageIds: [],
    artifacts: [{
      artifactId: artifact.artifactId,
      outcome: 'rejected',
      reason: 'artifact-invalid',
    }],
  });
});

test('QQ keeps the generic error when neither the answer nor the file failure notice is visible', async (t) => {
  const artifact = await committedArtifact(t, 'unavailable.txt', 'file bytes', 'no-visible-failure');
  const attemptedTexts = [];
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async (_target, text) => {
        attemptedTexts.push(text);
        if (attemptedTexts.length < 3) throw new Error('text transport unavailable');
        return { id: 'qq-generic-error' };
      },
      sendFile: async () => {
        const error = new Error('file transport unavailable');
        error.code = 'artifact-provider-failed';
        throw error;
      },
    },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '文字结果';
      },
    },
    state: stateFixture([['c2c:owner-openid', 'session-no-visible-failure']]).state,
    logger: { warn() {}, error() {} },
  });

  await bridge.accept(message({ messageId: 'qq-no-visible-failure' }));

  assert.equal(attemptedTexts.length, 3);
  assert.match(attemptedTexts.at(-1), /^回复发送结果未能确认/);
  assert.match(attemptedTexts.at(-1), /错误码：CHANNEL_DELIVERY_UNCERTAIN；参考号：MF-[A-F0-9]{8}$/);
});

test('QQ reports an unacknowledged native file send as uncertain instead of inviting a blind retry', async (t) => {
  const artifact = await committedArtifact(t, 'uncertain.txt', 'file bytes', 'uncertain');
  const texts = [];
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async (_target, text) => texts.push(text),
      sendFile: async () => new Promise(() => {}),
    },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '文件已生成。';
      },
    },
    state: stateFixture([['c2c:owner-openid', 'session-uncertain']]).state,
    fileUploadTimeoutMs: 20,
    logger: { warn() {}, error() {} },
  });

  await bridge.accept(message({ messageId: 'qq-uncertain-file' }));

  assert.match(texts[1], /发送结果未能确认.*先检查聊天内是否已收到.*不要立即重试/);
});

test('QQ runtime cancellation interrupts an in-flight file send and skips later files and notices', async (t) => {
  const first = await committedArtifact(t, 'first.txt', 'first', 'abort-first');
  const second = await committedArtifact(t, 'second.txt', 'second', 'abort-second');
  const started = deferred();
  const controller = new AbortController();
  const texts = [];
  const files = [];
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async (_target, text) => texts.push(text),
      sendFile: async (_target, _source, options) => {
        files.push(options.fileName);
        started.resolve();
        return new Promise(() => {});
      },
    },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(first);
        await options.onArtifact(second);
        return '文件如下。';
      },
    },
    state: stateFixture([['c2c:owner-openid', 'session-abort-files']]).state,
    signal: controller.signal,
    logger: { warn() {}, error() {} },
  });

  const processing = bridge.accept(message({ messageId: 'qq-abort-file' }));
  await started.promise;
  controller.abort(new DOMException('runtime stopped', 'AbortError'));
  await Promise.race([
    processing,
    new Promise((_, reject) => setTimeout(() => reject(new Error('QQ abort timed out')), 500)),
  ]);

  assert.deepEqual(files, ['first.txt']);
  assert.equal(texts.some((text) => text.includes('发送结果未能确认')), false);
  assert.equal(texts.some((text) => text === '消息处理失败，请稍后重试。'), false);
});

test('QQ uses a neutral final text for a file-only Turn', async (t) => {
  const artifact = await committedArtifact(t, 'only.txt', 'only bytes', 'file-only');
  const texts = [];
  const files = [];
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async (_target, text) => texts.push(text),
      sendFile: async (_target, source, options) => {
        files.push({ bytes: Buffer.from(source.buffer), fileName: options.fileName });
        return { message: { id: 'qq-file-only' } };
      },
    },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '';
      },
    },
    state: stateFixture([['c2c:owner-openid', 'session-file-only']]).state,
  });

  await bridge.accept(message({ messageId: 'qq-file-only' }));

  assert.deepEqual(texts, ['结果文件已生成。']);
  assert.deepEqual(files, [{ bytes: Buffer.from('only bytes'), fileName: 'only.txt' }]);
});

test('QQ cancellation prevents SDK sendFile', async (t) => {
  let fileCalls = 0;
  const artifact = await committedArtifact(t, 'cancelled.txt', 'cancelled bytes', 'cancelled');
  const controller = new AbortController();
  const cancelledBridge = new QqHarnessBridge({
    bot: {
      sendText: async () => {},
      sendFile: async () => { fileCalls += 1; },
    },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        controller.abort(new DOMException('stopped', 'AbortError'));
        return '停止前的回答';
      },
    },
    state: stateFixture([['c2c:owner-openid', 'session-cancelled']]).state,
    signal: controller.signal,
  });
  await cancelledBridge.accept(message({ messageId: 'qq-artifact-cancelled' }));
  assert.equal(fileCalls, 0);
});

test('QQ private batch input submits once, cancels cleanly, and restores normal chat', async () => {
  const fixture = stateFixture();
  const asked = [];
  const sent = [];
  const bridge = new QqHarnessBridge({
    bot: { sendText: async (_target, text) => sent.push(text) },
    ownerUserOpenid: 'owner-openid',
    harness: {
      createSession: async () => 'session-batch',
      sessionExists: async () => true,
      ask: async (_sessionId, prompt) => {
        asked.push(prompt);
        return asked.length === 1 ? '批量完成' : '普通完成';
      },
    },
    state: fixture.state,
  });
  const inbound = (messageId, content, extra = {}) => message({
    messageId,
    content,
    replyTarget: { scope: 'c2c', targetId: 'owner-openid', msgId: messageId },
    ...extra,
  });

  await bridge.accept(inbound('qq-batch-start', '/batch'));
  await bridge.accept(inbound('qq-batch-quote', 'QQ 引用不能收录', {
    refMsgIdx: 'qq-batch-ref',
    msgElements: [{ content: '被引用内容' }],
  }));
  await bridge.accept(inbound('qq-batch-one', '第一条'));
  await bridge.accept(inbound('qq-batch-two', '第二条'));
  assert.deepEqual(asked, []);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /引用消息.*未收录/s);

  await bridge.accept(inbound('qq-batch-send', '/send'));
  assert.equal(asked.length, 1);
  assert.match(asked[0], /\[消息 1\]\n第一条/);
  assert.match(asked[0], /\[消息 2\]\n第二条/);
  assert.doesNotMatch(asked[0], /QQ 引用不能收录/);
  assert.equal(sent.at(-1), '批量完成');

  await bridge.accept(inbound('qq-cancel-start', '/batch'));
  await bridge.accept(inbound('qq-cancel-data', '不得提交'));
  await bridge.accept(inbound('qq-cancel-command', '/cancel'));
  assert.equal(asked.length, 1);
  assert.match(sent.at(-1), /丢弃 1 条/);

  await bridge.accept(inbound('qq-normal-after-batch', '普通问题'));
  assert.equal(asked.at(-1), '普通问题');
  assert.equal(sent.at(-1), '普通完成');
});

test('QQ retains a private batch after Harness ask fails and lets /send retry it', async () => {
  const fixture = stateFixture();
  const asked = [];
  const sent = [];
  const bridge = new QqHarnessBridge({
    bot: { sendText: async (_target, text) => sent.push(text) },
    ownerUserOpenid: 'owner-openid',
    harness: {
      createSession: async () => 'session-batch-retry',
      sessionExists: async () => true,
      ask: async (_sessionId, prompt) => {
        asked.push(prompt);
        if (asked.length === 1) throw new Error('temporary Harness failure');
        return '重试成功';
      },
    },
    state: fixture.state,
    logger: { warn() {}, error() {} },
  });
  const inbound = (messageId, content) => message({
    messageId,
    content,
    replyTarget: { scope: 'c2c', targetId: 'owner-openid', msgId: messageId },
  });

  await bridge.accept(inbound('qq-batch-retry-start', '/batch'));
  await bridge.accept(inbound('qq-batch-retry-data', '需要重试的内容'));
  await bridge.accept(inbound('qq-batch-retry-first-send', '/send'));

  assert.equal(asked.length, 1);
  assert.match(sent.at(-1), /已保留 1 条消息/);
  assert.match(sent.at(-1), /再次发送 \/send 重试/);

  await bridge.accept(inbound('qq-batch-retry-second-send', '/send'));

  assert.equal(asked.length, 2);
  assert.equal(asked[1], asked[0]);
  assert.equal(sent.at(-1), '重试成功');
});

test('QQ clears a private batch after turn-stopped without suggesting a batch retry', async () => {
  const fixture = stateFixture();
  const sent = [];
  let asks = 0;
  const bridge = new QqHarnessBridge({
    bot: { sendText: async (_target, text) => sent.push(text) },
    ownerUserOpenid: 'owner-openid',
    harness: {
      createSession: async () => 'session-batch-stopped',
      sessionExists: async () => true,
      ask: async () => {
        asks += 1;
        const error = new Error('turn stopped');
        error.code = 'turn-stopped';
        throw error;
      },
    },
    state: fixture.state,
    logger: { warn() {}, error() {} },
  });
  const inbound = (messageId, content) => message({
    messageId,
    content,
    replyTarget: { scope: 'c2c', targetId: 'owner-openid', msgId: messageId },
  });

  await bridge.accept(inbound('qq-batch-stopped-start', '/batch'));
  await bridge.accept(inbound('qq-batch-stopped-data', '停止后应清除'));
  await bridge.accept(inbound('qq-batch-stopped-send', '/send'));

  assert.equal(asks, 1);
  assert.equal(sent.at(-1), '已停止。');
  assert.equal(sent.some((text) => text.includes('已保留')), false);

  await bridge.accept(inbound('qq-batch-stopped-send-again', '/send'));

  assert.equal(asks, 1);
  assert.match(sent.at(-1), /当前没有待提交的批量内容/);
});

test('QQ group batch commands are rejected without reaching Harness', async () => {
  const fixture = stateFixture();
  const sent = [];
  let asks = 0;
  const bridge = new QqHarnessBridge({
    bot: { sendText: async (_target, text) => sent.push(text) },
    ownerUserOpenid: 'owner-openid',
    harness: { ask: async () => { asks += 1; } },
    state: fixture.state,
  });

  await bridge.accept(message({
    kind: 'group',
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    groupOpenid: 'batch-group',
    content: '/batch',
    messageId: 'qq-group-batch',
    replyTarget: { scope: 'group', targetId: 'batch-group', msgId: 'qq-group-batch' },
  }));

  assert.equal(asks, 0);
  assert.match(sent.at(-1), /仅支持私聊/);
});
