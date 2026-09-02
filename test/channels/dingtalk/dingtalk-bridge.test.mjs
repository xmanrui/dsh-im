import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createDingtalkBridgeStatus,
  dingtalkInboundMessage,
  DingtalkHarnessBridge,
  DINGTALK_DEFAULT_REPLY_TIMEOUT_MS,
} from '../../../src/channels/dingtalk/dingtalk-bridge.mjs';
import {
  DINGTALK_DONE_REACTION_NAME,
  DINGTALK_ERROR_REACTION_NAME,
  DINGTALK_THINKING_REACTION_NAME,
} from '../../../src/channels/dingtalk/dingtalk-api.mjs';
import { connectionTestTarget } from '../../../src/channels/shared/connection-test.mjs';
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

async function eventually(predicate, message = 'condition was not met') {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function message(id, text, overrides = {}) {
  return {
    msgId: id,
    msgtype: 'text',
    text: { content: text },
    conversationType: '1',
    conversationId: `conversation-${id}`,
    senderStaffId: 'staff-approved',
    senderNick: '钉钉用户',
    sessionWebhook: `https://oapi.dingtalk.com/robot/reply?ticket=${id}`,
    ...overrides,
  };
}

test('DingTalk maps undocumented repliedMsg runtime fields into a reply snapshot', () => {
  const inbound = dingtalkInboundMessage(message('dingtalk-quote-normalize', '继续分析', {
    text: {
      content: '继续分析',
      isReplyMsg: true,
      repliedMsg: {
        msgType: 'richText',
        msgId: 'quoted-ding-message',
        senderId: 'quoted-staff',
        senderNick: '引用用户',
        content: {
          richText: [
            { type: 'text', text: '被引用的说明' },
            { type: 'picture', downloadCode: 'quoted-picture' },
          ],
        },
      },
    },
  }));

  assert.equal(inbound.content, '继续分析');
  assert.deepEqual(inbound.replyTo, {
    messageId: 'quoted-ding-message',
    authorId: 'quoted-staff',
    authorName: '引用用户',
    content: '被引用的说明',
    attachments: [{ kind: 'image' }],
  });
});

test('DingTalk sends quote context to Harness but does not execute quoted commands', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:staff-approved', 'session-quote');
  let clears = 0;
  let prompt;
  fixture.state.clearSession = async () => { clears += 1; };
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async () => ({ messageId: 'ding-quote-answer' }) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, content) => { prompt = content; return '已处理'; },
    },
    state: fixture.state,
  });

  await bridge.accept(message('dingtalk-quote-prompt', '这条指令是什么意思？', {
    text: {
      content: '这条指令是什么意思？',
      isReplyMsg: true,
      repliedMsg: { msgType: 'text', msgId: 'quoted-command', content: { text: '/new' } },
    },
  }));

  assert.equal(clears, 0);
  assert.equal(Array.isArray(prompt), true);
  assert.match(prompt[0].text, /<dsh_im_reply_to>/);
  assert.match(prompt[0].text, /"content":"\/new"/);
  assert.deepEqual(prompt.at(-1), { type: 'text', text: '这条指令是什么意思？' });
});

test('DingTalk resolves an Interactive Card reply by originalProcessQueryKey', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:staff-approved', 'session-card-quote');
  await fixture.state.rememberOutboundMessage({
    conversationKey: 'p2p:staff-approved',
    text: '钉钉卡片里的完整回答',
    sentAt: Date.now() - 2_000,
    completedAt: Date.now() - 1_000,
    providerMessageIds: ['dsh-card-answer'],
  });
  let prompt;
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async () => ({ messageId: 'ding-card-followup' }) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, content) => { prompt = content; return '已识别卡片'; },
    },
    state: fixture.state,
  });

  await bridge.accept(message('dingtalk-card-quote', '卡片说了什么？', {
    chatbotUserId: 'ding-client',
    originalProcessQueryKey: 'dsh-card-answer',
    text: {
      content: '卡片说了什么？',
      isReplyMsg: true,
      repliedMsg: {
        msgType: 'interactiveCard',
        msgId: 'quoted-interactive-card',
        senderId: 'ding-client',
        createdAt: Date.now() - 2_000,
        content: { text: '[Interactive Card Message]' },
      },
    },
  }));

  assert.match(prompt[0].text, /"content":"钉钉卡片里的完整回答"/);
  assert.doesNotMatch(prompt[0].text, /unavailableReason/);
});

test('DingTalk recovers a pre-index Interactive Card reply from bounded Session history', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:staff-approved', 'session-old-card');
  const quotedAt = Date.now() - 5_000;
  let prompt;
  const session = {
    sessionExists: async () => true,
    readHistory: async () => ({
      events: [
        { event: { type: 'turn/start', seq: 1, time: quotedAt, data: { turn: 2 } } },
        { event: {
          type: 'assistant/message',
          seq: 2,
          time: quotedAt + 2_000,
          data: {
            turn: 2,
            message: { content: [{ type: 'text', text: '旧钉钉卡片正文' }] },
          },
        } },
        { event: {
          type: 'turn/end',
          seq: 3,
          time: quotedAt + 2_001,
          data: { turn: 2, reason: { kind: 'completed' } },
        } },
      ],
      hasMore: false,
    }),
    ask: async (content) => { prompt = content; return '已恢复旧卡片'; },
  };
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async () => ({ messageId: 'ding-old-card-answer' }) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: { workspaceSession: () => session },
    state: fixture.state,
  });

  await bridge.accept(message('dingtalk-old-card-quote', '旧卡片说了什么？', {
    chatbotUserId: 'ding-client',
    text: {
      content: '旧卡片说了什么？',
      isReplyMsg: true,
      repliedMsg: {
        msgType: 'interactiveCard',
        msgId: 'old-interactive-card',
        senderId: 'ding-client',
        createdAt: quotedAt,
      },
    },
  }));

  assert.match(prompt[0].text, /"content":"旧钉钉卡片正文"/);
  assert.doesNotMatch(prompt[0].text, /unavailableReason/);
});

function stateFixture() {
  const sessions = new Map();
  const seen = new Set();
  const pending = new Map();
  const outbound = [];
  return {
    sessions,
    seen,
    pending,
    outbound,
    state: {
      hasSeen: (id) => seen.has(id),
      markSeen: async (id) => seen.add(id),
      rememberOutboundMessage: async (entry) => outbound.push(structuredClone(entry)),
      recentOutboundTextFor: ({ conversationKey, processQueryKey, messageId }) => {
        const ids = [processQueryKey, messageId].filter(Boolean);
        const matches = outbound.filter((entry) => entry.conversationKey === conversationKey
          && ids.some((id) => entry.providerMessageIds?.includes(id)));
        return matches.length === 1 ? matches[0].text : null;
      },
      sessionFor: (key) => sessions.get(key) ?? null,
      setSession: async (key, sessionId) => sessions.set(key, sessionId),
      clearSession: async (key) => sessions.delete(key),
      pendingSenders: () => [...pending.values()].map((entry) => structuredClone(entry)),
      recordPendingSender: async ({ staffId, displayName, lastSeenAt }) => {
        const existing = [...pending.values()].find((entry) => entry.staffId === staffId);
        const entry = {
          requestId: existing?.requestId ?? `request-${staffId}`,
          staffId,
          displayName,
          requestedAt: existing?.requestedAt ?? lastSeenAt,
          lastSeenAt,
        };
        pending.set(entry.requestId, entry);
        return structuredClone(entry);
      },
      removePendingSenderByStaffId: async (staffId) => {
        const entry = [...pending.values()].find((value) => value.staffId === staffId);
        if (!entry) return false;
        pending.delete(entry.requestId);
        return true;
      },
    },
  };
}

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x01, 0x02, 0x03,
]);

async function committedArtifact(t, fileName, content) {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-im-dingtalk-artifact-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const registry = new OutboundArtifactRegistry({ uuid: () => 'dingtalk-artifact-one' });
  t.after(() => registry.clear());
  const fileContent = fileName.endsWith('.pdf') ? `%PDF-1.7\n${content}` : content;
  const agent = {
    session: {
      header: { id: 'artifact-session', cwd: workspace },
      events: [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { turn: 1, source: { rpcId: 'artifact-rpc' } } },
      ],
    },
  };
  await writeFile(join(workspace, fileName), fileContent);
  const tool = createOutboundArtifactTool({ registry });
  const exec = {
    name: OUTBOUND_ARTIFACT_TOOL,
    callId: 'dingtalk-artifact-call',
    rootCallId: 'dingtalk-artifact-call',
    token: Symbol('dingtalk-artifact-call'),
    agent,
  };
  await tool.definition.execute({ path: fileName }, exec);
  tool.onResult(exec, { isError: false });
  const artifact = registry.take('artifact-session', 1)[0];
  t.after(() => releaseOutboundArtifact(artifact));
  return artifact;
}

test('DingTalk normalizes a native file callback into one lazy ordinary file', async () => {
  const calls = [];
  const bytes = Buffer.from('dingtalk-native-file');
  const inbound = dingtalkInboundMessage({
    msgtype: 'file',
    robotCode: 'robot-from-callback',
    content: JSON.stringify({
      spaceId: 'space-one',
      fileId: 'file-one',
      fileName: '钉钉报告.zip',
      downloadCode: 'opaque-file-code',
    }),
  }, {
    api: {
      downloadFile: async (request) => {
        calls.push(request);
        return bytes;
      },
    },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
  });

  assert.equal(inbound.content, '');
  assert.deepEqual(inbound.images, []);
  assert.equal(inbound.files.length, 1);
  assert.equal(inbound.files[0].name, '钉钉报告.zip');
  assert.equal(calls.length, 0, 'file download stays lazy');
  assert.deepEqual(await inbound.files[0].load({}), bytes);
  assert.deepEqual(calls, [{
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    robotCode: 'robot-from-callback',
    downloadCode: 'opaque-file-code',
    signal: undefined,
  }]);
});

test('DingTalk bridge hands a native file source to the current Harness turn', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:staff-approved', 'session-native-file');
  const bytes = Buffer.from('dingtalk-bridge-file');
  const downloads = [];
  const prompts = [];
  const sent = [];
  const bridge = new DingtalkHarnessBridge({
    api: {
      downloadFile: async (request) => {
        downloads.push(request);
        return bytes;
      },
      sendText: async (request) => sent.push(request.text),
    },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
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
  });

  await bridge.accept(message('dingtalk-native-file', '', {
    msgtype: 'file',
    text: undefined,
    robotCode: 'robot-from-callback',
    content: {
      fileName: '钉钉报告.pdf',
      downloadCode: 'native-file-code',
    },
  }));

  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].downloadCode, 'native-file-code');
  assert.deepEqual(prompts, [{
    sessionId: 'session-native-file',
    prompt: '',
    name: '钉钉报告.pdf',
    bytes,
  }]);
  assert.equal(sent.at(-1), '文件已收到');
});

test('DingTalk starts a native-file download before an earlier queued turn finishes', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:staff-approved', 'session-prefetch-file');
  const firstTurn = deferred();
  const bytes = Buffer.from('dingtalk-prefetched-file');
  let asks = 0;
  let downloads = 0;
  const bridge = new DingtalkHarnessBridge({
    api: {
      downloadFile: async () => {
        downloads += 1;
        return bytes;
      },
      sendText: async () => {},
    },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
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

  const first = bridge.accept(message('dingtalk-prefetch-first', '先等待'));
  await eventually(() => asks === 1);
  const second = bridge.accept(message('dingtalk-prefetch-second', '', {
    msgtype: 'file',
    text: undefined,
    robotCode: 'robot-from-callback',
    content: { fileName: 'queued.bin', downloadCode: 'queued-file-code' },
  }));

  await eventually(() => downloads === 1, 'queued DingTalk file did not start downloading');
  assert.equal(asks, 1, 'the second Harness turn must remain queued');
  firstTurn.resolve('第一条完成');
  await Promise.all([first, second]);
});

test('DingTalk remembers any private inbound session webhook for connection tests', async () => {
  const privateFixture = stateFixture();
  const privateSent = [];
  const privateBridge = new DingtalkHarnessBridge({
    api: { sendText: async (request) => privateSent.push(request) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: { ensureRunning: async () => true },
    state: privateFixture.state,
  });
  await privateBridge.accept(message('help-private', '/help'));
  assert.deepEqual(connectionTestTarget(privateFixture.state), {
    sessionWebhook: 'https://oapi.dingtalk.com/robot/reply?ticket=help-private',
  });
  assert.match(privateSent.at(-1).text, /\/help/);

  const groupFixture = stateFixture();
  const groupBridge = new DingtalkHarnessBridge({
    api: { sendText: async () => {} },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: { ensureRunning: async () => true },
    state: groupFixture.state,
  });
  await groupBridge.accept(message('help-group', '/help', {
    conversationType: '2',
    conversationId: 'group-help',
    isInAtList: true,
  }));
  assert.equal(connectionTestTarget(groupFixture.state), null);
});

test('DingTalk returns a registered result file through the native robot conversation', async (t) => {
  const artifact = await committedArtifact(t, 'result.pdf', 'dingtalk-result');
  const fixture = stateFixture();
  fixture.sessions.set('p2p:staff-approved', 'session-artifact');
  const order = [];
  const bridge = new DingtalkHarnessBridge({
    api: {
      sendText: async ({ text }) => {
        order.push(`text:${text}`);
        return { messageId: 'dingtalk-text-one' };
      },
      sendFile: async (request) => {
        order.push(`file:${request.file.fileName}`);
        assert.deepEqual(request.target, {
          type: 'user', userId: 'staff-approved', robotCode: 'robot-code',
        });
        assert.equal(request.file.bytes.toString(), '%PDF-1.7\ndingtalk-result');
        return { processQueryKey: 'dingtalk-file-query-one' };
      },
    },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
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
    'dingtalk-artifact',
    '生成文件',
    { robotCode: 'robot-code' },
  ));

  assert.deepEqual(order, ['text:结果文件已生成。', 'file:result.pdf']);
  assert.equal(bridge.status.artifactsSent, 1);
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    deliveryId: 'dingtalk-artifact',
    presentation: 'dingtalk-text-and-files',
    providerMessageIds: ['dingtalk-text-one', 'dingtalk-file-query-one'],
    artifacts: [{ artifactId: 'dingtalk-artifact-one', outcome: 'sent' }],
  });
});

test('DingTalk routes Artifact images natively and preserves the shared fallback boundary', async (t) => {
  const scenarios = [
    {
      name: 'native image',
      fileName: 'native.png',
      content: PNG_BYTES,
      expectedCalls: ['image'],
      expectedPresentation: 'dingtalk-image',
      expectedProviderIds: ['dingtalk-native-image'],
    },
    {
      name: 'ordinary file',
      fileName: 'ordinary.txt',
      content: 'ordinary file',
      expectedCalls: ['file'],
      expectedPresentation: 'dingtalk-file',
      expectedProviderIds: ['dingtalk-native-file'],
    },
    {
      name: 'definite image rejection falls back',
      fileName: 'fallback.png',
      content: PNG_BYTES,
      imageError: 'artifact-provider-rejected',
      expectedCalls: ['image', 'file'],
      expectedPresentation: 'dingtalk-file',
      expectedProviderIds: ['dingtalk-native-file'],
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
      fixture.sessions.set('p2p:staff-approved', `session-image-route-${index}`);
      const calls = [];
      const bridge = new DingtalkHarnessBridge({
        api: {
          sendText: async () => { throw new Error('text intentionally unavailable'); },
          sendImage: async ({ file, target }) => {
            calls.push('image');
            assert.equal(file.fileName, scenario.fileName);
            assert.equal(file.mediaType, 'image/png');
            assert.deepEqual(target, {
              type: 'user', userId: 'staff-approved', robotCode: 'robot-code',
            });
            if (scenario.imageError) {
              const error = new Error('private image result');
              error.code = scenario.imageError;
              throw error;
            }
            return { processQueryKey: 'dingtalk-native-image' };
          },
          sendFile: async ({ file, target }) => {
            calls.push('file');
            assert.equal(file.fileName, scenario.fileName);
            assert.deepEqual(target, {
              type: 'user', userId: 'staff-approved', robotCode: 'robot-code',
            });
            return { processQueryKey: 'dingtalk-native-file' };
          },
        },
        clientId: 'ding-client',
        clientSecret: 'host-secret',
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

      const receipt = await bridge.accept(message(`dingtalk-image-route-${index}`, '生成产物', {
        robotCode: 'robot-code',
      }));

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

test('DingTalk still attempts a registered file when the final text transport fails', async (t) => {
  const artifact = await committedArtifact(t, 'dingtalk-text-failed.pdf', 'dingtalk-file');
  const fixture = stateFixture();
  fixture.sessions.set('p2p:staff-approved', 'session-artifact-text-failed');
  const files = [];
  let textAttempts = 0;
  const bridge = new DingtalkHarnessBridge({
    api: {
      sendText: async () => {
        textAttempts += 1;
        throw new Error('private text failure');
      },
      sendFile: async ({ file }) => {
        files.push(file.fileName);
        return { messageId: 'dingtalk-file-after-text-failure' };
      },
    },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '文字回答';
      },
    },
    state: fixture.state,
  });

  const receipt = await bridge.accept(message('dingtalk-artifact-text-failed', '生成文件', {
    robotCode: 'robot-code',
  }));

  assert.deepEqual(files, ['dingtalk-text-failed.pdf']);
  assert.equal(textAttempts, 1, 'must not send a generic retry notice after the file succeeds');
  assert.equal(bridge.status.artifactsSent, 1);
  assert.equal(bridge.status.lastMessageError.code, 'CHANNEL_DELIVERY_UNCERTAIN');
  assert.match(bridge.status.lastMessageError.referenceId, /^MF-[A-F0-9]{8}$/);
  assert.deepEqual(receipt.providerMessageIds, ['dingtalk-file-after-text-failure']);
  assert.deepEqual(receipt.artifacts, [{
    artifactId: 'dingtalk-artifact-one',
    outcome: 'sent',
  }]);
});

test('DingTalk gives safe, actionable file delivery failure guidance', async (t) => {
  const cases = [
    {
      name: 'uncertain delivery',
      code: 'artifact-delivery-uncertain',
      fileName: 'dingtalk-uncertain.pdf',
      expected: '结果文件「dingtalk-uncertain.pdf」发送结果未能确认，请先检查聊天内是否已收到，不要立即重试。',
    },
    {
      name: 'missing permission',
      code: 'artifact-permission-required',
      fileName: 'dingtalk-permission.pdf',
      expected: '结果文件「dingtalk-permission.pdf」已生成，但钉钉应用或机器人缺少文件消息权限。请开通应用 qyapi_base 权限，并确认机器人具备文件消息发送能力。',
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const artifact = await committedArtifact(subtest, scenario.fileName, 'dingtalk-file');
      const fixture = stateFixture();
      fixture.sessions.set('p2p:staff-approved', `session-${scenario.name}`);
      const sent = [];
      const bridge = new DingtalkHarnessBridge({
        api: {
          sendText: async ({ text }) => {
            sent.push(text);
            return { messageId: `dingtalk-text-${sent.length}` };
          },
          sendFile: async () => {
            const error = new Error('private provider rejection detail');
            error.code = scenario.code;
            throw error;
          },
        },
        clientId: 'ding-client',
        clientSecret: 'host-secret',
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

      const receipt = await bridge.accept(message(`dingtalk-artifact-${scenario.name}`, '生成文件', {
        robotCode: 'robot-code',
      }));

      const failure = bridge.status.lastMessageError;
      assert.equal(sent.at(-1).startsWith(`${scenario.expected}\n\n`), true);
      assert.equal(
        failure.code,
        scenario.code === 'artifact-delivery-uncertain'
          ? 'CHANNEL_DELIVERY_UNCERTAIN'
          : 'CHANNEL_PERMISSION',
      );
      assert.equal(failure.reason, scenario.code.toUpperCase().replaceAll('-', '_'));
      assert.equal(sent.at(-1).endsWith(`参考号：${failure.referenceId}`), true);
      assert.doesNotMatch(sent.join('\n'), /private provider rejection detail/);
      assert.equal(bridge.status.artifactSendErrors, 1);
      assert.deepEqual(receipt.artifacts, [{
        artifactId: 'dingtalk-artifact-one',
        outcome: scenario.code === 'artifact-delivery-uncertain' ? 'unknown' : 'rejected',
        reason: scenario.code,
      }]);
    });
  }
});

test('DingTalk resolves picture downloadCode lazily and sends image-only content to Harness', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:staff-approved', 'session-image');
  const downloads = [];
  const prompts = [];
  const sent = [];
  const bridge = new DingtalkHarnessBridge({
    api: {
      downloadImage: async (request) => {
        downloads.push(request);
        return PNG_BYTES;
      },
      sendText: async (request) => sent.push(request),
    },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => true,
      ask: async (sessionId, content) => {
        prompts.push({ sessionId, content });
        return '钉钉图片已识别';
      },
    },
    state: fixture.state,
  });

  await bridge.accept(message('dingtalk-picture', '', {
    msgtype: 'picture',
    text: undefined,
    content: JSON.stringify({ downloadCode: 'opaque-picture-code' }),
    robotCode: 'robot-from-callback',
  }));

  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].clientId, 'ding-client');
  assert.equal(downloads[0].clientSecret, 'host-secret');
  assert.equal(downloads[0].robotCode, 'robot-from-callback');
  assert.equal(downloads[0].downloadCode, 'opaque-picture-code');
  assert.equal(downloads[0].maxBytes, 5 * 1024 * 1024);
  assert.equal(prompts[0].sessionId, 'session-image');
  assert.deepEqual(prompts[0].content.map(({ type }) => type), ['text', 'image']);
  assert.equal(prompts[0].content[0].text, '请分析这张图片。');
  assert.equal(prompts[0].content[1].mediaType, 'image/png');
  assert.equal(Buffer.from(prompts[0].content[1].data, 'base64').equals(PNG_BYTES), true);
  assert.equal(sent.at(-1).text, '钉钉图片已识别');
});

test('DingTalk richText preserves its caption and all picture download codes', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:staff-approved', 'session-rich-image');
  const codes = [];
  let prompt;
  const bridge = new DingtalkHarnessBridge({
    api: {
      downloadImage: async ({ downloadCode }) => {
        codes.push(downloadCode);
        return PNG_BYTES;
      },
      sendText: async () => {},
    },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => true,
      ask: async (_sessionId, content) => { prompt = content; return '完成'; },
    },
    state: fixture.state,
  });

  await bridge.accept(message('dingtalk-rich-picture', '', {
    msgtype: 'richText',
    text: undefined,
    robotCode: 'robot-from-callback',
    content: {
      richText: [
        { type: 'text', text: '请对比' },
        { type: 'picture', pictureDownloadCode: 'picture-one' },
        { type: 'text', text: { content: '这两张图' } },
        { type: 'picture', downloadCode: 'picture-two' },
      ],
    },
  }));

  assert.deepEqual(codes, ['picture-one', 'picture-two']);
  assert.deepEqual(prompt.map(({ type }) => type), ['text', 'image', 'image']);
  assert.equal(prompt[0].text, '请对比\n这两张图');
});

test('DingTalk checks the group mention before downloading a picture', async () => {
  let downloads = 0;
  let asks = 0;
  const bridge = new DingtalkHarnessBridge({
    api: {
      downloadImage: async () => { downloads += 1; return PNG_BYTES; },
      sendText: async () => {},
    },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: { ask: async () => { asks += 1; return 'unexpected'; } },
    state: stateFixture().state,
  });

  await bridge.accept(message('dingtalk-unmentioned-picture', '', {
    msgtype: 'picture',
    text: undefined,
    content: { downloadCode: 'private-picture' },
    robotCode: 'robot-from-callback',
    conversationType: '2',
    conversationId: 'group-image',
    isInAtList: false,
  }));

  assert.equal(downloads, 0);
  assert.equal(asks, 0);
});

test('DingTalk applies the unified access policy before attachments or Harness work', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:staff-member', 'session-member');
  let downloads = 0;
  const harnessCalls = [];
  const sent = [];
  const accessPolicy = directAccessPolicy({
    users: [{ id: 'staff-member', canExecuteCommands: false }],
    privilegedIds: ['staff-owner'],
  });
  const bridge = new DingtalkHarnessBridge({
    api: {
      downloadImage: async () => {
        downloads += 1;
        return PNG_BYTES;
      },
      sendText: async ({ text }) => {
        sent.push(text);
        return { messageId: `dingtalk-policy-${sent.length}` };
      },
    },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
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

  await bridge.accept(message('policy-blocked-picture', '', {
    senderStaffId: 'staff-blocked',
    msgtype: 'picture',
    text: undefined,
    content: { downloadCode: 'blocked-picture' },
    robotCode: 'robot-code',
  }));
  assert.equal(downloads, 0);
  assert.deepEqual(harnessCalls, []);
  assert.deepEqual(sent, []);

  await bridge.accept(message('policy-member-text', '普通消息', {
    senderStaffId: 'staff-member',
  }));
  assert.equal(harnessCalls.some(([operation]) => operation === 'ask'), true);
  assert.deepEqual(sent, ['白名单消息已处理']);

  const callsBeforeDeniedCommand = harnessCalls.length;
  const repliesBeforeDeniedCommand = sent.length;
  await bridge.accept(message('policy-member-command', '/help', {
    senderStaffId: 'staff-member',
  }));
  assert.equal(harnessCalls.length, callsBeforeDeniedCommand);
  assert.deepEqual(sent.slice(repliesBeforeDeniedCommand), [COMMAND_PERMISSION_DENIED_MESSAGE]);

  accessPolicy.getSettings().direct.allowlist.users = [];
  await bridge.accept(message('policy-owner-command', '/help', {
    senderStaffId: 'staff-owner',
  }));
  assert.match(sent.at(-1), /\/help/);
});

test('DingTalk returns a specific retry message when picture download fails', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:staff-approved', 'session-image');
  const sent = [];
  const bridge = new DingtalkHarnessBridge({
    api: {
      downloadImage: async () => { throw new Error('temporary URL expired'); },
      sendText: async (request) => sent.push(request),
    },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => true,
      ask: async () => assert.fail('a failed image must not reach Harness'),
    },
    state: fixture.state,
    logger: { error() {} },
  });

  await bridge.accept(message('dingtalk-picture-error', '', {
    msgtype: 'picture',
    text: undefined,
    content: { downloadCode: 'expired-picture' },
    robotCode: 'robot-from-callback',
  }));

  assert.match(sent.at(-1).text, /^图片下载失败，请重新发送后再试。/);
  assert.match(sent.at(-1).text, /错误码：INPUT_INVALID；参考号：MF-[A-F0-9]{8}$/);
});

test('DingTalk exposes a structured model rate limit without changing connection state', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:staff-approved', 'session-rate-limit');
  const sent = [];
  const status = {
    ...createDingtalkBridgeStatus(),
    connected: true,
    connectionState: 'connected',
  };
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async (request) => sent.push(request.text) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => true,
      ask: async () => {
        const error = new Error('private DingTalk provider rate-limit detail');
        error.code = 'harness-turn-failed';
        error.providerCode = 'RATE_LIMIT';
        throw error;
      },
    },
    state: fixture.state,
    status,
    logger: { error() {} },
  });

  await bridge.accept(message('dingtalk-rate-limit', '触发模型限流'));

  const failure = status.lastMessageError;
  assert.equal(failure.code, 'MODEL_RATE_LIMIT');
  assert.equal(failure.reason, 'MODEL_RATE_LIMIT');
  assert.match(failure.referenceId, /^MF-[A-F0-9]{8}$/);
  assert.match(sent.at(-1), /模型服务正在限流，本次任务未完成。请稍后重试。/);
  assert.equal(sent.at(-1).endsWith(`参考号：${failure.referenceId}`), true);
  assert.doesNotMatch(sent.at(-1), /private DingTalk provider rate-limit detail/);
  assert.equal(status.connected, true);
  assert.equal(status.connectionState, 'connected');
});

test('DingTalk distinguishes download-address failures from temporary-file failures', async () => {
  for (const [code, expected] of [
    [
      'image-download-address-failed',
      '钉钉未能换取图片下载地址，请重新发送；若持续失败，请检查机器人的“企业内机器人发送消息权限”。',
    ],
    ['image-content-download-failed', '钉钉返回的图片临时地址无法读取，请重新发送。'],
  ]) {
    const fixture = stateFixture();
    const sent = [];
    const bridge = new DingtalkHarnessBridge({
      api: {
        downloadImage: async () => {
          const error = new Error('safe stage marker');
          error.code = code;
          throw error;
        },
        sendText: async (request) => sent.push(request),
      },
      clientId: 'ding-client',
      clientSecret: 'host-secret',
      harness: { ask: async () => assert.fail('a failed image must not reach Harness') },
      state: fixture.state,
      logger: { error() {} },
    });

    await bridge.accept(message(`dingtalk-${code}`, '', {
      msgtype: 'picture',
      text: undefined,
      content: { downloadCode: 'opaque-picture-code' },
      robotCode: 'robot-from-callback',
    }));

    assert.equal(sent.at(-1).text.startsWith(expected), true);
    assert.match(sent.at(-1).text, /错误码：INPUT_INVALID；参考号：MF-[A-F0-9]{8}$/);
  }
});

test('DingTalk executes /compact for the bound Session without prompting the model', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:staff-approved', 'session-compact');
  const sent = [];
  const executed = [];
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      executeCommand: async (sessionId, line) => {
        executed.push({ sessionId, line });
        return { commandId: 'compact-dingtalk', result: { kind: 'success', text: 'No compactable history yet.' } };
      },
      ask: async () => assert.fail('/compact must not be submitted to the model'),
    },
    state: fixture.state,
  });

  await bridge.accept(message('compact-dingtalk', '/compact'));

  assert.deepEqual(executed, [{ sessionId: 'session-compact', line: '/compact' }]);
  assert.equal(sent.at(-1).text, '暂无可压缩的历史记录。');
});

test('DingTalk lists models and presets without prompting and advertises fast commands', async () => {
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
      label: `DingTalk Preset ${index + 1} ${'x'.repeat(64)}`,
    })),
  };
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      listModels: async () => ({
        groups: [{
          id: 'dingtalk-provider',
          name: 'DingTalk Provider',
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
      createSession: async () => { creates += 1; return 'dingtalk-session'; },
      ask: async () => { asks += 1; return 'unexpected model reply'; },
    },
    state: fixture.state,
  });

  await bridge.accept(message('models-dingtalk', '/models'));
  assert.match(sent.at(-1).text, /1\. dingtalk-provider\/model-one/);
  assert.equal(asks, 0);
  assert.equal(creates, 0);
  assert.equal(fixture.sessions.size, 0);

  await bridge.accept(message('reasoning-dingtalk', '/reasoninglist'));
  assert.match(sent.at(-1).text, /还没有会话/);
  assert.equal(asks, 0);
  assert.equal(creates, 0);
  assert.equal(fixture.sessions.size, 0);

  const presetReplyStart = sent.length;
  await bridge.accept(message('presets-dingtalk', '/presetlist'));
  const presetReplies = sent.slice(presetReplyStart).map((entry) => entry.text);
  assert.ok(presetReplies.length > 1);
  assert.match(presetReplies.join('\n'), /preset-070/);
  assert.equal(asks, 0);
  assert.equal(creates, 0);
  assert.equal(fixture.sessions.size, 0);

  await bridge.accept(message('preset-current-dingtalk', '/preset'));
  assert.match(sent.at(-1).text, /跟随 Host 默认/);
  assert.equal(asks, 0);
  assert.equal(creates, 0);

  const selectReplyStart = sent.length;
  await bridge.accept(message('preset-select-dingtalk', '/preset 2'));
  assert.deepEqual(presetUpdates, ['preset-002']);
  assert.equal(sent.length, selectReplyStart + 1);
  assert.match(sent.at(-1).text, /preset-002/);

  const defaultReplyStart = sent.length;
  await bridge.accept(message('preset-default-dingtalk', '/preset --default'));
  assert.deepEqual(presetUpdates, ['preset-002', null]);
  assert.equal(sent.length, defaultReplyStart + 1);
  assert.match(sent.at(-1).text, /跟随 Host 默认/);
  assert.equal(asks, 0);
  assert.equal(creates, 0);
  assert.equal(fixture.sessions.size, 0);

  await bridge.accept(message('help-models-dingtalk', '/help'));
  const help = sent.at(-1).text;
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

test('bridge maps a DingTalk direct conversation to one persistent Harness session', async () => {
  const fixture = stateFixture();
  const sent = [];
  const asked = [];
  const status = createDingtalkBridgeStatus();
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async (sessionId) => sessionId === 'session-one',
      createSession: async () => 'session-one',
      ask: async (sessionId, text) => {
        asked.push({ sessionId, text });
        return 'Harness 回答';
      },
    },
    state: fixture.state,
    status,
  });

  await Promise.all([
    bridge.accept(message('one', '你好')),
    bridge.accept(message('one', '重复消息')),
  ]);
  await bridge.accept(message('two', '继续'));

  assert.equal(fixture.sessions.get('p2p:staff-approved'), 'session-one');
  assert.deepEqual(asked, [
    { sessionId: 'session-one', text: '你好' },
    { sessionId: 'session-one', text: '继续' },
  ]);
  assert.deepEqual(sent.map(({ text, sessionWebhook }) => ({ text, sessionWebhook })), [
    { text: 'Harness 回答', sessionWebhook: 'https://oapi.dingtalk.com/robot/reply?ticket=one' },
    { text: 'Harness 回答', sessionWebhook: 'https://oapi.dingtalk.com/robot/reply?ticket=two' },
  ]);
  assert.equal(status.messagesReceived, 2);
  assert.equal(status.messagesReplied, 2);
  assert.equal(status.stats.messagesReplied, 2);
});

test('bridge replaces the native thinking reaction with done after a successful reply', async () => {
  const fixture = stateFixture();
  const events = [];
  const recallPending = deferred();
  const bridge = new DingtalkHarnessBridge({
    api: {
      addReaction: async (request) => {
        events.push([
          'add',
          request.reactionName,
          request.messageId,
          request.conversationId,
          request.robotCode,
        ]);
      },
      recallReaction: async (request) => {
        events.push(['recall', request.reactionName, request.messageId, request.conversationId]);
        return recallPending.promise;
      },
      sendText: async ({ text }) => events.push(['reply', text]),
    },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => false,
      createSession: async () => 'session-reaction-success',
      ask: async () => '已完成',
    },
    state: fixture.state,
  });

  await bridge.accept(message('reaction-success', '请回答', {
    robotCode: 'robot-from-callback',
  }));
  await eventually(() => events.some(([event]) => event === 'recall'));

  assert.deepEqual(events, [
    [
      'add',
      DINGTALK_THINKING_REACTION_NAME,
      'reaction-success',
      'conversation-reaction-success',
      'robot-from-callback',
    ],
    ['reply', '已完成'],
    [
      'recall',
      DINGTALK_THINKING_REACTION_NAME,
      'reaction-success',
      'conversation-reaction-success',
    ],
  ]);
  assert.equal(bridge.status.messagesReplied, 1);
  assert.equal(bridge.status.reactionsAdded, 1);
  recallPending.resolve();
  await eventually(() => bridge.status.reactionsAdded === 2);
  assert.deepEqual(events.at(-1), [
    'add',
    DINGTALK_DONE_REACTION_NAME,
    'reaction-success',
    'conversation-reaction-success',
    'robot-from-callback',
  ]);
  assert.equal(bridge.status.reactionsRemoved, 1);
  assert.equal(bridge.status.reactionErrors, 0);
});

test('bridge reacts only to safe, addressed, non-duplicate messages', async () => {
  const fixture = stateFixture();
  const reactions = [];
  const bridge = new DingtalkHarnessBridge({
    api: {
      addReaction: async ({ messageId, reactionName }) => {
        reactions.push(`add:${messageId}:${reactionName}`);
      },
      recallReaction: async ({ messageId, reactionName }) => {
        reactions.push(`recall:${messageId}:${reactionName}`);
      },
      sendText: async () => true,
    },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => false,
      createSession: async () => 'session-reaction-validation',
      ask: async () => '已回复',
    },
    state: fixture.state,
  });

  await bridge.accept(message('reaction-unmentioned', '群聊噪音', {
    conversationType: '2',
    conversationId: 'reaction-group',
    isInAtList: false,
  }));
  await bridge.accept(message('reaction-unsafe', '不安全路由', {
    sessionWebhook: 'https://example.com/reply',
  }));
  await bridge.accept(message('reaction-valid', '正常问题'));
  await bridge.accept(message('reaction-valid', '重复问题'));
  await eventually(() => reactions.includes(
    `add:reaction-valid:${DINGTALK_DONE_REACTION_NAME}`,
  ));

  assert.deepEqual(reactions, [
    `add:reaction-valid:${DINGTALK_THINKING_REACTION_NAME}`,
    `recall:reaction-valid:${DINGTALK_THINKING_REACTION_NAME}`,
    `add:reaction-valid:${DINGTALK_DONE_REACTION_NAME}`,
  ]);
});

test('a hanging reaction cannot delay an error reply or the message queue', async () => {
  const fixture = stateFixture();
  const sent = [];
  let thinkingAdds = 0;
  let asks = 0;
  let recalls = 0;
  const terminals = [];
  const bridge = new DingtalkHarnessBridge({
    api: {
      addReaction: async ({ reactionName }) => {
        if (reactionName !== DINGTALK_THINKING_REACTION_NAME) {
          terminals.push(reactionName);
          return true;
        }
        thinkingAdds += 1;
        if (thinkingAdds === 1) throw new Error('reaction unavailable');
        return new Promise(() => {});
      },
      recallReaction: async () => { recalls += 1; },
      sendText: async ({ text }) => sent.push(text),
    },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => false,
      createSession: async () => 'session-reaction-failure',
      ask: async () => {
        asks += 1;
        if (asks === 1) throw new Error('private Harness failure');
        return '第二条正常';
      },
    },
    state: fixture.state,
    logger: { debug() {}, error() {} },
    reactionTimeoutMs: 20,
  });

  await Promise.race([
    bridge.accept(message('reaction-failure', '第一条')),
    new Promise((_, reject) => setTimeout(() => reject(new Error('error reply was blocked')), 100)),
  ]);
  await Promise.race([
    bridge.accept(message('reaction-next', '第二条')),
    new Promise((_, reject) => setTimeout(() => reject(new Error('next message was blocked')), 100)),
  ]);

  assert.equal(asks, 2);
  assert.equal(sent.length, 2, 'the safe error reply and next normal reply are both delivered');
  assert.equal(sent.some((text) => text.includes('private Harness failure')), false);
  assert.equal(sent.some((text) => text.includes('第二条正常')), true);
  await eventually(() => recalls === 4 && terminals.length === 2);
  assert.deepEqual(terminals, [DINGTALK_ERROR_REACTION_NAME, DINGTALK_DONE_REACTION_NAME]);
  assert.equal(bridge.status.reactionsRemoved, 4);
  assert.equal(bridge.status.reactionErrors, 2);
});

test('runtime abort recalls the native thinking reaction without delaying stop', async () => {
  const fixture = stateFixture();
  const controller = new AbortController();
  const askStarted = deferred();
  let recalls = 0;
  const added = [];
  const bridge = new DingtalkHarnessBridge({
    api: {
      addReaction: async ({ reactionName }) => {
        added.push(reactionName);
        return true;
      },
      recallReaction: async () => { recalls += 1; },
      sendText: async () => true,
    },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => false,
      createSession: async () => 'session-reaction-abort',
      ask: async (_sessionId, _text, options) => {
        askStarted.resolve();
        await new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
        });
      },
    },
    state: fixture.state,
    signal: controller.signal,
  });

  const task = bridge.accept(message('reaction-abort', '等待停止'));
  await askStarted.promise;
  controller.abort(new DOMException('runtime stopped', 'AbortError'));
  await Promise.race([
    task,
    new Promise((_, reject) => setTimeout(() => reject(new Error('abort was blocked')), 100)),
  ]);
  await eventually(() => recalls === 1);
  assert.deepEqual(added, [DINGTALK_THINKING_REACTION_NAME]);
});

test('a failed DingTalk reaction cleanup is retried once without delaying the reply', async () => {
  const fixture = stateFixture();
  let recalls = 0;
  const events = [];
  const bridge = new DingtalkHarnessBridge({
    api: {
      addReaction: async ({ reactionName }) => {
        events.push(`add:${reactionName}`);
        return true;
      },
      recallReaction: async ({ reactionName }) => {
        recalls += 1;
        events.push(`recall:${reactionName}:${recalls}`);
        if (recalls === 1) throw new Error('temporary cleanup failure');
        return true;
      },
      sendText: async () => true,
    },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => false,
      createSession: async () => 'session-reaction-retry',
      ask: async () => '已完成',
    },
    state: fixture.state,
    logger: { debug() {}, error() {} },
    reactionTimeoutMs: 20,
  });

  await bridge.accept(message('reaction-retry', '请回答'));
  await eventually(() => events.includes(`add:${DINGTALK_DONE_REACTION_NAME}`));
  assert.deepEqual(events, [
    `add:${DINGTALK_THINKING_REACTION_NAME}`,
    `recall:${DINGTALK_THINKING_REACTION_NAME}:1`,
    `recall:${DINGTALK_THINKING_REACTION_NAME}:2`,
    `add:${DINGTALK_DONE_REACTION_NAME}`,
  ]);
  assert.equal(bridge.status.reactionErrors, 1);
  assert.equal(bridge.status.reactionsRemoved, 1);
  assert.equal(bridge.status.reactionsAdded, 2);
});

test('senders in the bot visibility scope enter Harness without local approval', async () => {
  const fixture = stateFixture();
  const sent = [];
  const asked = [];
  const status = createDingtalkBridgeStatus();
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => false,
      createSession: async () => 'session-visible-sender',
      ask: async (sessionId, text) => {
        asked.push({ sessionId, text });
        return '直接回答';
      },
    },
    state: fixture.state,
    status,
  });

  await bridge.accept(message('visible', '可见范围内的问题', {
    senderStaffId: 'raw-staff-id',
    senderNick: '可见范围用户',
  }));

  assert.deepEqual(asked, [{
    sessionId: 'session-visible-sender',
    text: '可见范围内的问题',
  }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, '直接回答');
  assert.equal(fixture.pending.size, 0);
  assert.deepEqual(status.pendingSenders, []);
  assert.equal(status.messagesRejected, 0);
  assert.equal(status.messagesReplied, 1);
});

test('group messages require an explicit bot mention before Harness work', async () => {
  const fixture = stateFixture();
  const sent = [];
  const asked = [];
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => true,
      createSession: async () => 'session-group',
      ask: async (_sessionId, text) => {
        asked.push(text);
        return '群聊回答';
      },
    },
    state: fixture.state,
  });
  const group = {
    conversationType: '2',
    conversationId: 'group-one',
  };

  await bridge.accept(message('not-mentioned', '群聊噪音', { ...group, isInAtList: false }));
  await bridge.accept(message('mentioned', '明确问题', { ...group, isInAtList: true }));

  assert.deepEqual(asked, ['明确问题']);
  assert.deepEqual(sent.map(({ text }) => text), ['群聊回答']);
  assert.equal(bridge.status.messagesIgnored, 1);
  assert.equal(fixture.sessions.get('group:group-one'), 'session-group');
});

test('bridge streams one AI Card and mentions only the group sender without an extra text reply', async (t) => {
  for (const scenario of [
    {
      name: 'private reply',
      overrides: {},
      target: { type: 'user', userId: 'staff-approved' },
    },
    {
      name: 'group reply mentions the sender by name',
      overrides: { conversationType: '2', isInAtList: true },
      target: {
        type: 'group',
        openConversationId: 'conversation-stream',
        atUserIds: { 'staff-approved': '钉钉用户' },
      },
    },
    {
      name: 'group reply without a nickname falls back to the sender ID',
      overrides: { conversationType: 2, isInAtList: true, senderNick: undefined },
      target: {
        type: 'group',
        openConversationId: 'conversation-stream',
        atUserIds: { 'staff-approved': 'staff-approved' },
      },
    },
  ]) {
    await t.test(scenario.name, async () => {
      const fixture = stateFixture();
      const calls = { create: [], update: [], finish: [], text: [] };
      const bridge = new DingtalkHarnessBridge({
        api: {
          sendText: async (request) => calls.text.push(request),
          createAiCard: async (request) => {
            calls.create.push(request);
            return { cardInstanceId: 'card-one' };
          },
          updateAiCard: async (request) => calls.update.push(request),
          finishAiCard: async (request) => {
            calls.finish.push(request);
            return { delivered: true, completed: false };
          },
        },
        clientId: 'ding-client',
        clientSecret: 'host-secret',
        harness: {
          sessionExists: async () => false,
          createSession: async () => 'session-stream',
          ask: async (_sessionId, _text, options) => {
            options.onUpdate({ type: 'text', text: '生成中的完整快照' });
            await new Promise((resolve) => setTimeout(resolve, 510));
            return '最终完整回答';
          },
        },
        state: fixture.state,
      });

      await bridge.accept(message('stream', '请流式回答', scenario.overrides));

      assert.equal(calls.create.length, 1);
      assert.deepEqual(calls.create[0].target, scenario.target);
      assert.equal(calls.update.at(-1).text, '生成中的完整快照');
      assert.equal(calls.finish.length, 1);
      assert.equal(calls.finish[0].text, '最终完整回答');
      assert.equal(calls.text.length, 0);
      assert.deepEqual(fixture.outbound.at(-1).providerMessageIds, ['card-one']);
      assert.equal(fixture.outbound.at(-1).text, '最终完整回答');
      assert.equal(bridge.status.messagesReplied, 1);
    });
  }
});

test('bridge falls back to final text with group sender mentions when AI Card creation fails', async (t) => {
  for (const conversationType of ['1', '2']) {
    await t.test(`conversationType=${conversationType}`, async () => {
      const fixture = stateFixture();
      const sent = [];
      let asks = 0;
      const bridge = new DingtalkHarnessBridge({
        api: {
          sendText: async (request) => sent.push(request),
          createAiCard: async () => { throw new Error('card unavailable'); },
          updateAiCard: async () => undefined,
          finishAiCard: async () => undefined,
        },
        clientId: 'ding-client',
        clientSecret: 'host-secret',
        harness: {
          sessionExists: async () => false,
          createSession: async () => 'session-fallback',
          ask: async () => {
            asks += 1;
            return '文本降级回答';
          },
        },
        state: fixture.state,
        logger: { error() {} },
      });

      await bridge.accept(message('fallback', '卡片失败也要回答', {
        conversationType,
        isInAtList: true,
      }));

      assert.equal(asks, 1);
      assert.deepEqual(sent.map(({ text }) => text), ['文本降级回答']);
      assert.deepEqual(sent[0].at, conversationType === '2'
        ? { atUserIds: ['staff-approved'] }
        : undefined);
      assert.equal(bridge.status.messagesReplied, 1);
    });
  }
});

test('commands stay local and unsafe session webhooks are rejected before Harness', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:staff-approved', 'old-session');
  const sent = [];
  let asked = 0;
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async (request) => sent.push(request.text) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      ask: async () => { asked += 1; },
    },
    state: fixture.state,
    logger: { warn() {}, error() {} },
  });

  await bridge.accept(message('new', '/new'));
  assert.equal(fixture.sessions.has('p2p:staff-approved'), false);
  await bridge.accept(message('unsafe', '不应执行', {
    sessionWebhook: 'https://oapi.dingtalk.com.attacker.example/reply?private=one',
  }));
  assert.equal(asked, 0);
  assert.equal(sent[0], '已开启新会话。请发送你的问题。');
  assert.equal(sent.length, 1);
  assert.equal(bridge.status.lastError, '钉钉消息没有安全的回复地址。');
});

test('a DingTalk reply answers a pending Harness question before the original turn queue', async () => {
  const fixture = stateFixture();
  const sent = [];
  const asked = [];
  const response = deferred();
  const releaseTurn = deferred();
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => false,
      createSession: async () => 'session-question',
      ask: async (sessionId, text, options) => {
        asked.push({ sessionId, text });
        await options.onInteraction({
          kind: 'question',
          rpcId: 'question-rpc',
          sessionId,
          payload: {
            type: 'question/requested',
            sessionId,
            questions: [{
              id: 'environment',
              header: '运行环境',
              question: '请问要使用哪个环境？',
              options: [
                { label: '生产环境', description: '处理真实数据' },
                { label: '预发环境' },
              ],
            }],
          },
          respond: async (result) => {
            response.resolve(result);
            return { accepted: true };
          },
        });
        await response.promise;
        await releaseTurn.promise;
        return '已按测试环境继续。';
      },
    },
    state: fixture.state,
  });

  let firstSettled = false;
  const first = bridge.accept(message('prompt', '先问我一个问题'))
    .finally(() => { firstSettled = true; });
  await eventually(() => sent.some(({ text }) => text.includes('请问要使用哪个环境')));

  await Promise.race([
    bridge.accept(message('answer', '测试环境')),
    new Promise((_, reject) => setTimeout(() => reject(new Error('question reply deadlocked')), 500)),
  ]);

  assert.equal(firstSettled, false);
  assert.deepEqual(await response.promise, {
    ok: true,
    value: {
      sessionId: 'session-question',
      answer: {
        answers: [{ id: 'environment', selected: [], custom: '测试环境' }],
      },
    },
  });
  assert.deepEqual(asked, [{ sessionId: 'session-question', text: '先问我一个问题' }]);

  releaseTurn.resolve();
  await first;
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /DeepSeek Harness 需要你补充信息/);
  assert.equal(sent[1].text, '已按测试环境继续。');
  assert.equal(bridge.status.messagesReceived, 2);
  assert.equal(bridge.status.messagesReplied, 1);
});

test('pending questions are isolated by DingTalk conversation', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:staff-a', 'session-a');
  fixture.sessions.set('p2p:staff-b', 'session-b');
  const sent = [];
  const asked = [];
  const answeredA = deferred();
  const releaseA = deferred();
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => true,
      createSession: async () => assert.fail('existing sessions should be reused'),
      ask: async (sessionId, text, options) => {
        asked.push({ sessionId, text });
        if (sessionId === 'session-b') return '乙会话的普通回答';
        await options.onInteraction({
          kind: 'question',
          rpcId: 'rpc-a',
          sessionId,
          payload: {
            type: 'question/requested',
            sessionId,
            questions: [{ id: 'a', question: '甲会话的问题' }],
          },
          respond: async (result) => {
            answeredA.resolve(result);
            return { accepted: true };
          },
        });
        await answeredA.promise;
        await releaseA.promise;
        return '甲会话完成';
      },
    },
    state: fixture.state,
  });

  const firstA = bridge.accept(message('a-prompt', '启动甲会话', {
    senderStaffId: 'staff-a',
  }));
  await eventually(() => sent.some(({ text }) => text.includes('甲会话的问题')));

  await bridge.accept(message('b-message', '乙会话的消息', {
    senderStaffId: 'staff-b',
  }));
  assert.deepEqual(asked, [
    { sessionId: 'session-a', text: '启动甲会话' },
    { sessionId: 'session-b', text: '乙会话的消息' },
  ]);
  assert.equal(sent.some(({ text }) => text === '乙会话的普通回答'), true);

  await bridge.accept(message('a-answer', '甲的答案', { senderStaffId: 'staff-a' }));
  assert.deepEqual((await answeredA.promise).value.answer.answers, [
    { id: 'a', selected: [], custom: '甲的答案' },
  ]);
  releaseA.resolve();
  await firstA;
});

test('DingTalk handles approval replies on the fast lane and presents approvals in FIFO order', async () => {
  const fixture = stateFixture();
  const sent = [];
  const asked = [];
  const decisions = [];
  const decided = deferred();
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => false,
      createSession: async () => 'session-approval',
      ask: async (sessionId, text, options) => {
        asked.push({ sessionId, text });
        const approval = (approvalId, toolName, reason) => ({
          kind: 'approval',
          interactionId: approvalId,
          rpcId: `rpc-${approvalId}`,
          sessionId,
          payload: {
            type: 'approval/requested',
            sessionId,
            approvalId,
            toolName,
            callId: `call-${approvalId}`,
            reason,
          },
          toolCall: {
            callId: `call-${approvalId}`,
            name: toolName,
            arguments: JSON.stringify({ operation: reason }),
          },
          respond: async (result) => {
            decisions.push(result);
            if (decisions.length === 2) decided.resolve();
            return { accepted: true };
          },
        });
        await options.onInteraction(approval(
          'approval-build',
          'bash',
          '运行第一项构建操作',
        ));
        await options.onInteraction(approval(
          'approval-write',
          'write_file',
          '运行第二项写入操作',
        ));
        await decided.promise;
        return '两个审批均已处理';
      },
    },
    state: fixture.state,
  });

  const turn = bridge.accept(message('approval-start', '发起两个审批'));
  await eventually(() => sent.some(({ text }) => text.includes('运行第一项构建操作')));
  assert.equal(sent.some(({ text }) => text.includes('运行第二项写入操作')), false);
  assert.equal(sent.some(({ text }) => text.includes('approval-build')), false);

  await bridge.accept(message('approval-invalid', '好的'));
  assert.deepEqual(decisions, []);
  assert.deepEqual(asked, [{ sessionId: 'session-approval', text: '发起两个审批' }]);
  assert.match(sent.at(-1).text, /批准/);
  assert.match(sent.at(-1).text, /拒绝/);

  await bridge.accept(message('approval-allow', '批准'));
  assert.deepEqual(decisions, [{
    ok: true,
    value: {
      sessionId: 'session-approval',
      approvalId: 'approval-build',
      outcome: 'allowed-once',
    },
  }]);
  assert.equal(sent.filter(({ text }) => text.includes('运行第二项写入操作')).length, 1);
  assert.equal(sent.some(({ text }) => text.includes('approval-write')), false);

  await bridge.accept(message('approval-reject', '拒绝'));
  await turn;

  assert.deepEqual(decisions, [
    {
      ok: true,
      value: {
        sessionId: 'session-approval',
        approvalId: 'approval-build',
        outcome: 'allowed-once',
      },
    },
    {
      ok: true,
      value: {
        sessionId: 'session-approval',
        approvalId: 'approval-write',
        outcome: 'rejected',
      },
    },
  ]);
  assert.equal(sent.at(-1).text, '两个审批均已处理');
});

test('question replays are deduplicated and an unrenderable approval is safely rejected', async () => {
  const fixture = stateFixture();
  const sent = [];
  let approvalResponse;
  let secondQuestionResponse;
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => false,
      createSession: async () => 'session-replay',
      ask: async (sessionId, _text, options) => {
        const question = {
          kind: 'question',
          rpcId: 'replayed-question',
          sessionId,
          payload: {
            type: 'question/requested',
            sessionId,
            questions: [{ id: 'choice', question: '只应显示一次' }],
          },
          respond: async () => ({ accepted: true }),
        };
        await options.onInteraction(question);
        await options.onInteraction(question);
        await options.onInteraction({
          kind: 'question',
          interactionId: 'parallel-question',
          rpcId: 'parallel-question',
          sessionId,
          payload: {
            type: 'question/requested',
            sessionId,
            questions: [{ id: 'parallel', question: '不应无声丢弃' }],
          },
          respond: async (result) => {
            secondQuestionResponse = result;
            return { accepted: true };
          },
        });
        await options.onInteraction({
          kind: 'approval',
          rpcId: 'approval-rpc',
          sessionId,
          payload: {
            type: 'approval/requested',
            sessionId,
            approvalId: 'approval-one',
            toolName: 'bash',
          },
          respond: async (result) => {
            approvalResponse = result;
            return { accepted: true };
          },
        });
        await options.onInteractionResolved({
          kind: 'question',
          sessionId,
          interactionId: 'replayed-question',
          outcome: 'cancelled',
        });
        return '交互已取消';
      },
    },
    state: fixture.state,
    logger: { warn() {}, error() {} },
  });

  await bridge.accept(message('replay', '测试重放'));

  assert.equal(sent.filter(({ text }) => text.includes('只应显示一次')).length, 1);
  assert.deepEqual(secondQuestionResponse, {
    ok: false,
    error: {
      code: 'cancelled',
      message: 'DingTalk is already handling another user interaction.',
      details: {},
    },
  });
  assert.deepEqual(approvalResponse, {
    ok: true,
    value: {
      sessionId: 'session-replay',
      approvalId: 'approval-one',
      outcome: 'rejected',
    },
  });
  assert.equal(sent.some(({ text }) => text.includes('无法完整展示')), true);
  assert.equal(sent.at(-1).text, '交互已取消');
});

test('a message arriving during question submission is re-queued as the next normal prompt', async () => {
  const fixture = stateFixture();
  const sent = [];
  const asked = [];
  const submitStarted = deferred();
  const releaseSubmit = deferred();
  const answered = deferred();
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => true,
      createSession: async () => 'session-submit-race',
      ask: async (sessionId, text, options) => {
        asked.push(text);
        if (text === '下一个真实问题') return '第二轮回答';
        const interaction = {
          kind: 'question',
          interactionId: 'submit-race-question',
          rpcId: 'submit-race-question',
          sessionId,
          payload: {
            type: 'question/requested',
            sessionId,
            questions: [{ id: 'answer', question: '请先回答当前问题' }],
          },
          respond: async (result) => {
            submitStarted.resolve(result);
            await releaseSubmit.promise;
            answered.resolve();
            return { accepted: true };
          },
        };
        await options.onInteraction(interaction);
        await answered.promise;
        return '第一轮回答';
      },
    },
    state: fixture.state,
  });

  const first = bridge.accept(message('submit-start', '启动交互'));
  await eventually(() => sent.some(({ text }) => text.includes('请先回答当前问题')));
  const answer = bridge.accept(message('submit-answer', '当前问题的答案'));
  await submitStarted.promise;

  let nextSettled = false;
  const next = bridge.accept(message('submit-next', '下一个真实问题'))
    .finally(() => { nextSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(nextSettled, false);

  releaseSubmit.resolve();
  await Promise.all([answer, first, next]);
  assert.deepEqual(asked, ['启动交互', '下一个真实问题']);
  assert.equal(asked.includes('当前问题的答案'), false);
  assert.deepEqual(sent.slice(-2).map(({ text }) => text), ['第一轮回答', '第二轮回答']);
});

test('a queued next prompt stays separate when question submission must be retried', async () => {
  const fixture = stateFixture();
  const sent = [];
  const asked = [];
  const firstSubmitStarted = deferred();
  const releaseFirstSubmit = deferred();
  const answered = deferred();
  const submittedAnswers = [];
  let submitAttempts = 0;
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => true,
      createSession: async () => 'session-submit-retry-race',
      ask: async (sessionId, text, options) => {
        asked.push(text);
        if (text === '排队的下一个问题') return '第二轮完成';
        await options.onInteraction({
          kind: 'question',
          interactionId: 'submit-retry-question',
          rpcId: 'submit-retry-question',
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
    logger: { error() {}, warn() {} },
  });

  const first = bridge.accept(message('submit-retry-start', '启动可重试交互'));
  await eventually(() => sent.some(({ text }) => text.includes('请回答后再继续')));
  const firstAnswer = bridge.accept(message('submit-retry-answer', '第一次答案'));
  await firstSubmitStarted.promise;

  let nextSettled = false;
  const next = bridge.accept(message('submit-retry-next', '排队的下一个问题'))
    .finally(() => { nextSettled = true; });
  releaseFirstSubmit.resolve();
  await firstAnswer;
  await eventually(() => sent.some(({ text }) => text.includes('回答提交失败')));
  assert.equal(nextSettled, false);
  assert.deepEqual(asked, ['启动可重试交互']);

  const retry = bridge.accept(message('submit-retry-again', '重试后的答案'));
  await Promise.all([retry, first, next]);

  assert.deepEqual(submittedAnswers, ['第一次答案', '重试后的答案']);
  assert.deepEqual(asked, ['启动可重试交互', '排队的下一个问题']);
  assert.deepEqual(sent.slice(-2).map(({ text }) => text), ['第一轮完成', '第二轮完成']);
});

test('an invalid pending reply does not block the valid answer behind it', async () => {
  const fixture = stateFixture();
  const sent = [];
  const invalidNoticeStarted = deferred();
  const releaseInvalidNotice = deferred();
  const answered = deferred();
  let submitted;
  const bridge = new DingtalkHarnessBridge({
    api: {
      sendText: async (request) => {
        if (request.text === '请用文字回答当前问题。') {
          invalidNoticeStarted.resolve();
          await releaseInvalidNotice.promise;
        }
        sent.push(request);
      },
    },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => true,
      createSession: async () => 'session-invalid-reply',
      ask: async (sessionId, _text, options) => {
        await options.onInteraction({
          kind: 'question',
          interactionId: 'invalid-reply-question',
          rpcId: 'invalid-reply-question',
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

  const first = bridge.accept(message('invalid-reply-start', '启动交互'));
  await eventually(() => sent.some(({ text }) => text.includes('请给出有效文字答案')));
  const invalid = bridge.accept(message('invalid-reply-image', '', {
    msgtype: 'picture',
    text: undefined,
  }));
  await invalidNoticeStarted.promise;
  const valid = bridge.accept(message('invalid-reply-valid', '真正的答案'));
  releaseInvalidNotice.resolve();

  await Promise.all([invalid, valid, first]);
  assert.deepEqual(submitted.value.answer.answers, [{
    id: 'answer',
    selected: [],
    custom: '真正的答案',
  }]);
  assert.equal(sent.at(-1).text, '有效答案已收到');
});

test('an answer resolved elsewhere is not reinterpreted as a later prompt', async () => {
  const fixture = stateFixture();
  const originalMarkSeen = fixture.state.markSeen;
  const answerMarkStarted = deferred();
  const releaseAnswerMark = deferred();
  fixture.state.markSeen = async (id) => {
    if (id === 'resolved-answer-first') {
      answerMarkStarted.resolve();
      await releaseAnswerMark.promise;
    }
    await originalMarkSeen(id);
  };
  const sent = [];
  const asked = [];
  const resolved = deferred();
  let resolveInteraction;
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => true,
      createSession: async () => 'session-resolved-race',
      ask: async (sessionId, text, options) => {
        asked.push(text);
        if (text === '后来的普通问题') return '后来问题的回答';
        await options.onInteraction({
          kind: 'question',
          interactionId: 'resolved-race-question',
          rpcId: 'resolved-race-question',
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
            interactionId: 'resolved-race-question',
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

  const first = bridge.accept(message('resolved-race-start', '启动外部解决竞态'));
  await eventually(() => typeof resolveInteraction === 'function');
  const answer = bridge.accept(message('resolved-answer-first', '原本的问题答案'));
  await answerMarkStarted.promise;
  const later = bridge.accept(message('resolved-later-second', '后来的普通问题'));
  await resolveInteraction();
  releaseAnswerMark.resolve();

  await Promise.all([answer, first, later]);
  assert.deepEqual(asked, ['启动外部解决竞态', '后来的普通问题']);
  assert.equal(asked.includes('原本的问题答案'), false);
  assert.equal(sent.some(({ text }) => text.includes('已在其他客户端处理')), true);
});

test('an orphan question is cancelled without exposing it to a new conversation', async () => {
  const fixture = stateFixture();
  const sent = [];
  let recoveredResponse;
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => true,
      createSession: async () => 'session-orphan-recovery',
      ask: async (sessionId, _text, options) => {
        await options.onInteraction({
          kind: 'question',
          interactionId: 'orphan-secret-question',
          rpcId: 'orphan-secret-question',
          sessionId,
          recovered: true,
          payload: {
            type: 'question/requested',
            sessionId,
            questions: [{ id: 'secret', question: '旧会话中的敏感问题内容' }],
          },
          respond: async (result) => {
            recoveredResponse = result;
            return { accepted: true };
          },
        });
        return '新的消息已继续';
      },
    },
    state: fixture.state,
  });

  await bridge.accept(message('orphan-recovery', '新的会话消息'));
  assert.deepEqual(recoveredResponse, {
    ok: false,
    error: {
      code: 'cancelled',
      message: 'DingTalk safely cancelled an interaction left by an earlier client.',
      details: {},
    },
  });
  assert.equal(sent.some(({ text }) => text.includes('旧会话中的敏感问题内容')), false);
  assert.equal(sent.some(({ text }) => text.includes('遗留的待回答问题')), true);
  assert.equal(sent.at(-1).text, '新的消息已继续');
});

test('question delivery replays safely and a multi-question batch keeps canonical answers', async () => {
  const fixture = stateFixture();
  const sent = [];
  const response = deferred();
  let firstQuestionAttempts = 0;
  let secondQuestionAttempts = 0;
  let replayTask = Promise.resolve();
  const bridge = new DingtalkHarnessBridge({
    api: {
      sendText: async (request) => {
        if (request.text.includes('选择回答语言')) {
          firstQuestionAttempts += 1;
          if (firstQuestionAttempts === 1) throw new Error('temporary first question failure');
        }
        if (request.text.includes('选择交付内容')) {
          secondQuestionAttempts += 1;
          if (secondQuestionAttempts === 1) throw new Error('temporary second question failure');
        }
        sent.push(request);
      },
    },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => false,
      createSession: async () => 'session-question-batch',
      ask: async (sessionId, _text, options) => {
        // An already-started turn remains the owner even if a workspace switch
        // clears the conversation-to-session mapping while it is running.
        fixture.sessions.delete('p2p:staff-approved');
        const interaction = {
          kind: 'question',
          interactionId: 'batch-question',
          rpcId: 'batch-question',
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
          reconnect: () => {
            replayTask = new Promise((resolve, reject) => {
              queueMicrotask(() => options.onInteraction(interaction).then(resolve, reject));
            });
          },
          respond: async (result) => {
            response.resolve(result);
            return { accepted: true };
          },
        };
        await assert.rejects(
          options.onInteraction(interaction),
          /temporary first question failure/,
        );
        await options.onInteraction(interaction);
        await response.promise;
        return '批量问题已完成';
      },
    },
    state: fixture.state,
    logger: { error() {}, warn() {} },
  });

  const first = bridge.accept(message('batch-start', '请分步提问'));
  await eventually(() => sent.some(({ text }) => text.includes('选择回答语言')));
  await bridge.accept(message('batch-language', '2'));
  await eventually(() => sent.some(({ text }) => text.includes('选择交付内容')));
  await replayTask;
  await bridge.accept(message('batch-deliverables', '1，文档，发布说明'));

  assert.deepEqual(await response.promise, {
    ok: true,
    value: {
      sessionId: 'session-question-batch',
      answer: {
        answers: [
          { id: 'language', selected: ['English'] },
          { id: 'deliverables', selected: ['测试', '文档'], custom: '发布说明' },
        ],
      },
    },
  });
  assert.equal(firstQuestionAttempts, 2);
  assert.equal(secondQuestionAttempts, 2);
  await first;
  assert.equal(sent.at(-1).text, '批量问题已完成');
});

test('aborting a DingTalk turn cancels its pending Harness question', async () => {
  const fixture = stateFixture();
  const controller = new AbortController();
  const sent = [];
  const cancelled = deferred();
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => false,
      createSession: async () => 'session-cancel-question',
      ask: async (sessionId, _text, options) => {
        await options.onInteraction({
          kind: 'question',
          interactionId: 'question-to-cancel',
          rpcId: 'question-to-cancel',
          sessionId,
          payload: {
            type: 'question/requested',
            sessionId,
            questions: [{ id: 'cancel', question: '等待重连前取消' }],
          },
          respond: async (result) => {
            cancelled.resolve(result);
            return { accepted: true };
          },
        });
        await new Promise((resolve, reject) => {
          if (options.signal.aborted) {
            reject(options.signal.reason);
            return;
          }
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
        });
      },
    },
    state: fixture.state,
    signal: controller.signal,
  });

  const processing = bridge.accept(message('cancel-start', '启动后停止'));
  await eventually(() => sent.some(({ text }) => text.includes('等待重连前取消')));
  controller.abort(new DOMException('runtime stopped', 'AbortError'));
  await processing;

  assert.deepEqual(await cancelled.promise, {
    ok: false,
    error: {
      code: 'cancelled',
      message: 'The DingTalk interaction ended before the user answered.',
      details: {},
    },
  });
});

test('group questions tell users to mention the bot and ignore unmentioned answers', async () => {
  const fixture = stateFixture();
  const sent = [];
  const answered = deferred();
  let responseCalls = 0;
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => false,
      createSession: async () => 'session-group-question',
      ask: async (sessionId, _text, options) => {
        await options.onInteraction({
          kind: 'question',
          interactionId: 'group-question',
          rpcId: 'group-question',
          sessionId,
          payload: {
            type: 'question/requested',
            sessionId,
            questions: [{ id: 'group', question: '群聊问题' }],
          },
          respond: async () => {
            responseCalls += 1;
            answered.resolve();
            return { accepted: true };
          },
        });
        await answered.promise;
        return '群聊交互完成';
      },
    },
    state: fixture.state,
  });
  const group = {
    conversationType: '2',
    conversationId: 'group-question-room',
  };

  const first = bridge.accept(message('group-start', '开始群聊问答', {
    ...group,
    isInAtList: true,
  }));
  await eventually(() => sent.some(({ text }) => text.includes('群聊问题')));
  assert.match(sent[0].text, /群聊中请 @机器人/);

  await bridge.accept(message('group-unmentioned', '这条不算答案', {
    ...group,
    isInAtList: false,
  }));
  assert.equal(responseCalls, 0);
  await bridge.accept(message('group-mentioned', '这条才是答案', {
    ...group,
    isInAtList: true,
  }));
  await first;

  assert.equal(responseCalls, 1);
  assert.equal(bridge.status.messagesIgnored, 1);
  assert.equal(sent.at(-1).text, '群聊交互完成');
});

test('only the actor who started a DingTalk group interaction can answer it', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('group:actor-room', 'session-group-actor');
  const asked = [];
  const submitted = deferred();
  let interactionSubmitted = false;
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async () => undefined },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: {
      sessionExists: async () => true,
      createSession: async () => assert.fail('the group session should already exist'),
      ask: async (sessionId, text, options) => {
        asked.push(text);
        if (text !== '甲发起交互') return '普通群消息已处理';
        await options.onInteraction({
          kind: 'question',
          interactionId: 'dingtalk-group-actor',
          rpcId: 'dingtalk-group-actor',
          sessionId,
          payload: {
            type: 'question/requested',
            sessionId,
            questions: [{ id: 'actor', question: '只能由甲回答' }],
          },
          respond: async (result) => {
            interactionSubmitted = true;
            submitted.resolve(result);
            return { accepted: true };
          },
        });
        await submitted.promise;
        return '甲的交互已完成';
      },
    },
    state: fixture.state,
  });
  const group = {
    conversationType: '2',
    conversationId: 'actor-room',
    isInAtList: true,
  };

  const first = bridge.accept(message('actor-start', '甲发起交互', {
    ...group,
    senderStaffId: 'staff-a',
  }));
  await eventually(() => asked.length === 1);
  const intruder = bridge.accept(message('actor-b', '乙试图代答', {
    ...group,
    senderStaffId: 'staff-b',
  }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(interactionSubmitted, false);
  assert.deepEqual(asked, ['甲发起交互']);

  await bridge.accept(message('actor-a', '甲的答案', {
    ...group,
    senderStaffId: 'staff-a',
  }));
  assert.deepEqual((await submitted.promise).value.answer.answers, [{
    id: 'actor',
    selected: [],
    custom: '甲的答案',
  }]);
  await Promise.all([first, intruder]);
  assert.deepEqual(asked, ['甲发起交互', '乙试图代答']);
});

test('DingTalk private batch input submits once, cancels cleanly, and restores normal chat', async () => {
  const fixture = stateFixture();
  const asked = [];
  const sent = [];
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async ({ text }) => sent.push(text) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
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

  await bridge.accept(message('batch-start', '/batch'));
  await bridge.accept(message('batch-quote', '钉钉引用不能收录', {
    text: {
      content: '钉钉引用不能收录',
      isReplyMsg: true,
      repliedMsg: { msgType: 'text', content: { text: '被引用内容' } },
    },
  }));
  await bridge.accept(message('batch-one', '第一条'));
  await bridge.accept(message('batch-two', '第二条'));
  assert.deepEqual(asked, []);
  assert.equal(sent.length, 2, '/batch and the rejected quote acknowledge before submission');
  assert.match(sent[1], /引用消息.*未收录/s);

  await bridge.accept(message('batch-send', '/send'));
  assert.equal(asked.length, 1);
  assert.match(asked[0], /\[消息 1\]\n第一条/);
  assert.match(asked[0], /\[消息 2\]\n第二条/);
  assert.doesNotMatch(asked[0], /钉钉引用不能收录/);
  assert.equal(sent.at(-1), '批量完成');

  await bridge.accept(message('cancel-start', '/batch'));
  await bridge.accept(message('cancel-data', '不得提交'));
  await bridge.accept(message('cancel-command', '/cancel'));
  assert.equal(asked.length, 1);
  assert.match(sent.at(-1), /丢弃 1 条/);

  await bridge.accept(message('normal-after-batch', '普通问题'));
  assert.equal(asked.at(-1), '普通问题');
  assert.equal(sent.at(-1), '普通完成');
});

test('DingTalk retains a private batch after Harness ask fails and lets /send retry it', async () => {
  const fixture = stateFixture();
  const asked = [];
  const sent = [];
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async ({ text }) => sent.push(text) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
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

  await bridge.accept(message('batch-retry-start', '/batch'));
  await bridge.accept(message('batch-retry-data', '需要重试的内容'));
  await bridge.accept(message('batch-retry-first-send', '/send'));

  assert.equal(asked.length, 1);
  assert.match(sent.at(-1), /已保留 1 条消息/);
  assert.match(sent.at(-1), /再次发送 \/send 重试/);

  await bridge.accept(message('batch-retry-second-send', '/send'));

  assert.equal(asked.length, 2);
  assert.equal(asked[1], asked[0]);
  assert.equal(sent.at(-1), '重试成功');
});

test('DingTalk clears a private batch after turn-stopped without suggesting a batch retry', async () => {
  const fixture = stateFixture();
  const sent = [];
  let asks = 0;
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async ({ text }) => sent.push(text) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
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

  await bridge.accept(message('batch-stopped-start', '/batch'));
  await bridge.accept(message('batch-stopped-data', '停止后应清除'));
  await bridge.accept(message('batch-stopped-send', '/send'));

  assert.equal(asks, 1);
  assert.equal(sent.some((text) => text.includes('已保留')), false);

  await bridge.accept(message('batch-stopped-send-again', '/send'));

  assert.equal(asks, 1);
  assert.match(sent.at(-1), /当前没有待提交的批量内容/);
});

test('DingTalk mentions the sender in every group text chunk but not in private replies', async (t) => {
  for (const conversationType of ['1', '2', 2]) {
    await t.test(`conversationType=${JSON.stringify(conversationType)}`, async () => {
      const sent = [];
      const bridge = new DingtalkHarnessBridge({
        api: { sendText: async (request) => sent.push(request) },
        clientId: 'ding-client',
        clientSecret: 'host-secret',
        harness: { ensureRunning: async () => true },
        state: stateFixture().state,
        maxMessageChars: 10,
      });

      await bridge.accept(message('mention-status', '/status', {
        conversationType,
        isInAtList: true,
      }));

      assert.ok(sent.length > 1);
      assert.equal(sent.map(({ text }) => text).join(''), '钉钉机器人与 DeepSeek Harness 连接正常。');
      for (const request of sent) {
        assert.deepEqual(request.at, String(conversationType) === '2'
          ? { atUserIds: ['staff-approved'] }
          : undefined);
      }
    });
  }
});

test('DingTalk batch reply failures attempt a safe fallback and settle even if it also fails', async (t) => {
  for (const conversationType of ['1', '2']) {
    for (const fallbackFails of [false, true]) {
      await t.test(`conversationType=${conversationType}, fallbackFails=${fallbackFails}`, async () => {
        const sent = [];
        const bridge = new DingtalkHarnessBridge({
          api: {
            sendText: async (request) => {
              sent.push(request);
              if (sent.length === 1 || fallbackFails) throw new Error('private delivery failure');
            },
          },
          clientId: 'ding-client',
          clientSecret: 'host-secret',
          harness: { ask: async () => assert.fail('batch acknowledgement must not call Harness') },
          state: stateFixture().state,
          logger: { error() {} },
        });

        await assert.doesNotReject(bridge.accept(message('batch-reply-failure', '/batch', {
          conversationType,
          isInAtList: true,
        })));

        assert.equal(sent.length, 2);
        assert.match(sent[1].text, /参考号：MF-[A-F0-9]{8}/);
        assert.doesNotMatch(sent[1].text, /private delivery failure|ReferenceError/);
      });
    }
  }
});

test('DingTalk group batch commands are rejected without reaching Harness', async () => {
  const fixture = stateFixture();
  const sent = [];
  let asks = 0;
  const bridge = new DingtalkHarnessBridge({
    api: { sendText: async ({ text }) => sent.push(text) },
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: { ask: async () => { asks += 1; } },
    state: fixture.state,
  });

  await bridge.accept(message('group-batch-command', '/batch', {
    conversationType: '2',
    conversationId: 'batch-room',
    isInAtList: true,
  }));

  assert.equal(asks, 0);
  assert.match(sent.at(-1), /仅支持私聊/);
});

// ── Deferred handoff: slow turns notify, then push on completion ──────────

function deferredHarnessFixture({ history = { events: [] }, cards = null } = {}) {
  const listeners = [];
  const releaseCalls = [];
  const sent = [];
  const proactive = [];
  const cardCreates = [];
  const cardFinishes = [];
  return {
    listeners,
    releaseCalls,
    sent,
    proactive,
    cardCreates,
    cardFinishes,
    setHistory: (next) => { history = next; },
    harness: {
      sessionExists: async () => true,
      rpc: async (method) => (method === 'session.history' ? history : null),
      watchHarnessEvents: ({ signal, onSessionEvent, onReconnect }) => {
        listeners.push({ onSessionEvent, onReconnect });
        return new Promise((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', resolve, { once: true });
        });
      },
      ask: async () => ({
        deferred: true,
        sessionId: 'session-defer',
        turn: 1,
        promptRpcId: 'dingtalk-defer-1',
        afterSeq: -1,
        releaseOwnership: () => releaseCalls.push('release'),
      }),
    },
    api: {
      sendText: async ({ text }) => {
        sent.push(text);
        return { messageId: `ding-${sent.length}` };
      },
      sendRobotText: async ({ target, text }) => {
        proactive.push({ target, text });
        return {};
      },
      // cards = null 时不下发卡片函数：既有用例保持文本链可观察行为。
      ...(cards ? {
        createAiCard: async ({ initialText, target }) => {
          cardCreates.push({ initialText, target });
          return { cardInstanceId: 'card-bridge-defer' };
        },
        finishAiCard: async ({ cardInstanceId, text }) => {
          cardFinishes.push({ cardInstanceId, text });
          return { delivered: true, completed: true };
        },
      } : {}),
    },
  };
}

test('DingTalk defers a slow turn instead of erroring, then pushes the result', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:staff-approved', 'session-defer');
  const fx = deferredHarnessFixture();
  const bridge = new DingtalkHarnessBridge({
    api: fx.api,
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: fx.harness,
    state: fixture.state,
  });

  await bridge.accept(message('ding-defer-1', '慢任务', {
    sessionWebhookExpiredTime: Date.now() + 5_400_000,
  }));
  await bridge.waitForIdle();

  assert.match(fx.sent.at(-1), /任务仍在运行/);
  assert.equal(
    fx.sent.filter((text) => text.includes('MODEL_REPLY_TIMEOUT')
      || text.includes('等待模型回复超时')).length,
    0,
    'deferred handoff must not surface the timeout error',
  );

  fx.setHistory({ events: [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { turn: 1, source: { rpcId: 'dingtalk-defer-1' } } },
    {
      seq: 3,
      type: 'assistant/chunk',
      data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: '后台完成的结果' } },
    },
    { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ] });
  fx.listeners[0].onSessionEvent({
    sessionId: 'session-defer',
    event: { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  });
  await eventually(() => fx.sent.some((text) => text.includes('后台完成的结果')));
  assert.deepEqual(fx.releaseCalls, ['release']);
});

test('DingTalk deferred result falls back to proactive delivery after the webhook window', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:staff-approved', 'session-defer');
  const fx = deferredHarnessFixture({
    history: { events: [
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
      { seq: 2, type: 'user/message', data: { turn: 1, source: { rpcId: 'dingtalk-defer-1' } } },
      {
        seq: 3,
        type: 'assistant/chunk',
        data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: '后台完成的结果' } },
      },
      { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ] },
  });
  const bridge = new DingtalkHarnessBridge({
    api: fx.api,
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: fx.harness,
    state: fixture.state,
  });

  await bridge.accept(message('ding-defer-2', '慢任务', {
    sessionWebhookExpiredTime: Date.now() - 1_000,
  }));
  await bridge.waitForIdle();

  // 注册时 history 已终态 → 立即经主动推送交付，不等待 watcher 事件。
  assert.equal(fx.proactive.length, 1);
  assert.deepEqual(fx.proactive[0].target, {
    type: 'user',
    userId: 'staff-approved',
    robotCode: 'ding-client',
  });
  assert.match(fx.proactive[0].text, /后台完成的结果/);
});

test('DingTalk delivers a deferred group result as a finalized AI card', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('group:conversation-group-1', 'session-defer');
  const fx = deferredHarnessFixture({
    cards: true,
    history: { events: [
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
      { seq: 2, type: 'user/message', data: { turn: 1, source: { rpcId: 'dingtalk-defer-1' } } },
      {
        seq: 3,
        type: 'assistant/chunk',
        data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: '后台完成的结果' } },
      },
      { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ] },
  });
  const bridge = new DingtalkHarnessBridge({
    api: fx.api,
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    harness: fx.harness,
    state: fixture.state,
  });

  await bridge.accept(message('ding-defer-card-1', '慢任务', {
    conversationType: '2',
    conversationId: 'conversation-group-1',
    isInAtList: true,
  }));
  await bridge.waitForIdle();

  assert.deepEqual(fx.cardCreates[0].target, {
    type: 'group',
    openConversationId: 'conversation-group-1',
    atUserIds: { 'staff-approved': '钉钉用户' },
  });
  assert.equal(fx.cardFinishes[0].cardInstanceId, 'card-bridge-defer');
  assert.equal(
    fx.sent.some((text) => text.includes('后台完成的结果')),
    false,
    'card delivery must not also send the result as webhook text',
  );
});

test('DingTalk default reply timeout is a three-minute foreground window', () => {
  assert.equal(DINGTALK_DEFAULT_REPLY_TIMEOUT_MS, 180_000);
});
