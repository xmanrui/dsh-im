import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import manifest from '../../../package.json' with { type: 'json' };

import { DiscordHarnessBridge } from '../../../src/channels/discord/discord-bridge.mjs';
import { connectionTestTarget } from '../../../src/channels/shared/connection-test.mjs';
import { COMMAND_PERMISSION_DENIED_MESSAGE } from '../../../src/channels/shared/inbound-access.mjs';
import { InboundFileError } from '../../../src/channels/shared/inbound-file.mjs';
import {
  OUTBOUND_ARTIFACT_TOOL,
  OutboundArtifactRegistry,
  createOutboundArtifactTool,
  releaseOutboundArtifact,
} from '../../../src/channels/shared/semantic/artifact.mjs';
import {
  createTextBridgeStatus,
  TextHarnessBridge,
} from '../../../src/channels/shared/text-harness-bridge.mjs';
import { SlackHarnessBridge } from '../../../src/channels/slack/slack-bridge.mjs';
import { TelegramHarnessBridge } from '../../../src/channels/telegram/telegram-bridge.mjs';
import { TelegramBotClient } from '../../../src/channels/telegram/telegram-runtime.mjs';
import { WhatsappHarnessBridge } from '../../../src/channels/whatsapp/whatsapp-bridge.mjs';

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
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition was not met before timeout');
}

async function within(promise, timeoutMs, messageText) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(messageText)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function stateFixture(initialSessions = {}) {
  const sessions = new Map(Object.entries(initialSessions));
  const seen = new Set();
  return {
    sessions,
    seen,
    state: {
      sessionFor(key) { return sessions.get(key) ?? null; },
      async setSession(key, sessionId) {
        sessions.set(key, sessionId);
        return true;
      },
      async clearSession(key) { sessions.delete(key); },
      hasSeen(messageId) { return seen.has(messageId); },
      async markSeen(messageId) { seen.add(messageId); },
    },
  };
}

function message(messageId, content, overrides = {}) {
  return {
    messageId,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    content,
    addressed: true,
    replyTarget: { id: `target-${messageId}` },
    ...overrides,
  };
}

function accessPolicy({ canExecuteCommands = false } = {}) {
  return {
    direct: {
      mode: 'allowlist',
      open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
      allowlist: { users: [{ id: 'actor-a', canExecuteCommands }] },
    },
    group: {
      mode: 'allowlist',
      open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
      allowlist: { users: [] },
    },
  };
}

function questionInteraction({
  id = 'question-one',
  sessionId = 'session-one',
  questions = [{ id: 'answer', question: '请回答' }],
  respond = async () => ({ accepted: true }),
  ...rest
} = {}) {
  return {
    kind: 'question',
    interactionId: id,
    rpcId: id,
    sessionId,
    payload: { type: 'question/requested', sessionId, questions },
    respond,
    ...rest,
  };
}

function approvalInteraction({
  id = 'approval-one',
  sessionId = 'session-one',
  toolName = 'bash',
  callId = 'call-one',
  reason = '测试审批链路',
  argumentsText = JSON.stringify({ command: "printf 'approval-test\\n'" }),
  respond = async () => ({ accepted: true }),
  ...rest
} = {}) {
  return {
    kind: 'approval',
    interactionId: id,
    rpcId: `rpc-${id}`,
    sessionId,
    payload: {
      type: 'approval/requested',
      sessionId,
      approvalId: id,
      toolName,
      callId,
      reason,
    },
    toolCall: { callId, name: toolName, arguments: argumentsText },
    respond,
    ...rest,
  };
}

function createBridge({
  harness,
  state,
  bot,
  signal,
  logger,
  reactions,
} = {}) {
  return new TextHarnessBridge({
    descriptor: { key: 'test', label: 'Test', reactions },
    bot,
    harness,
    state,
    signal,
    logger: logger ?? { warn() {}, error() {} },
  });
}

async function committedArtifact(t, fileName, content, suffix) {
  const workspace = await mkdtemp(join(tmpdir(), `dsh-im-text-artifact-${suffix}-`));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const sessionId = `session-artifact-${suffix}`;
  const rpcId = `rpc-artifact-${suffix}`;
  let nextId = 0;
  const registry = new OutboundArtifactRegistry({
    uuid: () => `${suffix}-${++nextId}`,
  });
  t.after(() => registry.clear());
  const agent = {
    session: {
      header: { id: sessionId, cwd: workspace },
      events: [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { turn: 1, source: { rpcId } } },
      ],
    },
  };
  await writeFile(join(workspace, fileName), content);
  const tool = createOutboundArtifactTool({ registry });
  const exec = {
    name: OUTBOUND_ARTIFACT_TOOL,
    callId: `call-${suffix}`,
    rootCallId: `call-${suffix}`,
    token: Symbol(`call-${suffix}`),
    agent,
  };
  await tool.definition.execute({ path: fileName }, exec);
  tool.onResult(exec, { isError: false });
  const artifact = registry.take(sessionId, 1)[0];
  t.after(() => releaseOutboundArtifact(artifact));
  return artifact;
}

test('status reactions never delay safe errors, the conversation queue, or waitForIdle', async () => {
  const fixture = stateFixture();
  const sent = [];
  let asks = 0;
  let reactionAdds = 0;
  const bridge = new TextHarnessBridge({
    descriptor: {
      key: 'test',
      label: 'Test',
      reactions: { processing: 'eyes', success: 'done', error: 'error' },
    },
    state: fixture.state,
    status: createTextBridgeStatus(),
    bot: {
      addReaction: () => {
        reactionAdds += 1;
        return new Promise(() => {});
      },
      removeReaction: async () => undefined,
      sendText: async (_target, text) => sent.push(text),
    },
    harness: {
      sessionExists: async () => false,
      createSession: async () => 'session-reaction-sidecar',
      ask: async () => {
        asks += 1;
        if (asks === 1) throw new Error('private failure detail');
        return '第二条正常完成';
      },
    },
    logger: { warn() {}, error() {} },
  });

  const first = bridge.accept(message('reaction-hang-one', '第一条', {
    reactionTarget: { id: 'source-one' },
  }));
  const second = bridge.accept(message('reaction-hang-two', '第二条', {
    reactionTarget: { id: 'source-two' },
  }));

  await within(Promise.all([first, second, bridge.waitForIdle()]), 100,
    'a hanging status reaction blocked normal message processing');

  assert.equal(asks, 2);
  assert.equal(reactionAdds, 2);
  assert.equal(sent.some((text) => text.includes('第二条正常完成')), true);
  assert.equal(sent.some((text) => text.includes('private failure detail')), false);
});

test('shared status reactions replace processing with success without joining the main task', async () => {
  const fixture = stateFixture();
  const reactions = [];
  const bridge = new TextHarnessBridge({
    descriptor: {
      key: 'test',
      label: 'Test',
      reactions: { processing: 'eyes', success: 'done', error: 'error' },
    },
    state: fixture.state,
    bot: {
      addReaction: async (target, emoji) => {
        reactions.push(['add', target.id, emoji]);
        return emoji;
      },
      removeReaction: async (target, emoji) => {
        reactions.push(['remove', target.id, emoji]);
      },
      sendText: async () => undefined,
    },
    harness: {
      sessionExists: async () => false,
      createSession: async () => 'session-reaction-success',
      ask: async () => '完成',
    },
    logger: { warn() {}, error() {} },
  });

  await bridge.accept(message('reaction-success', '执行', {
    reactionTarget: { id: 'source-success' },
  }));
  await eventually(() => reactions.length === 3);

  assert.deepEqual(reactions, [
    ['add', 'source-success', 'eyes'],
    ['remove', 'source-success', 'eyes'],
    ['add', 'source-success', 'done'],
  ]);
});

test('all four shared text channels enforce fail-closed live access before side effects', async () => {
  for (const [name, Bridge] of [
    ['slack', SlackHarnessBridge],
    ['telegram', TelegramHarnessBridge],
    ['discord', DiscordHarnessBridge],
    ['whatsapp', WhatsappHarnessBridge],
  ]) {
    const fixture = stateFixture();
    const sent = [];
    const asks = [];
    let imageLoads = 0;
    let sessionClears = 0;
    let policyReadFails = true;
    let settings = null;
    const originalClearSession = fixture.state.clearSession.bind(fixture.state);
    fixture.state.clearSession = async (...args) => {
      sessionClears += 1;
      return originalClearSession(...args);
    };
    const bridge = new Bridge({
      accessPolicy: {
        getSettings() {
          if (policyReadFails) throw new Error('private policy read detail');
          return settings;
        },
        isPrivileged: (senderIds) => senderIds.includes('owner-a'),
      },
      bot: { sendText: async (_target, text) => sent.push(text) },
      state: fixture.state,
      harness: {
        createSession: async () => `session-access-${name}`,
        sessionExists: async () => true,
        ask: async (_sessionId, content) => {
          asks.push(content);
          return `${name} allowed reply`;
        },
      },
    });

    await bridge.accept(message(`access-blocked-${name}`, 'blocked attachment', {
      images: [{
        mediaType: 'image/png',
        load: async () => {
          imageLoads += 1;
          return Buffer.from('must not load');
        },
      }],
    }));
    assert.equal(imageLoads, 0, `${name} authorizes before downloading attachments`);
    assert.deepEqual(asks, [], `${name} fail-closed denial never reaches Harness`);
    assert.equal(fixture.seen.has(`access-blocked-${name}`), true,
      `${name} records a denial for replay suppression`);

    await bridge.accept(message(`access-owner-${name}`, '/help', { senderId: 'owner-a' }));
    assert.match(sent.at(-1), /\/help/, `${name} owner bypasses a failed policy read`);
    assert.deepEqual(asks, [], `${name} owner command remains local`);

    policyReadFails = false;
    settings = accessPolicy();
    await bridge.accept(message(`access-blocked-${name}`, 'replayed after policy update'));
    assert.deepEqual(asks, [], `${name} a denied replay cannot bypass the new policy`);

    await bridge.accept(message(`access-ordinary-${name}`, 'allowed ordinary message'));
    assert.equal(asks.length, 1, `${name} applies the live policy to a new event`);
    assert.equal(sent.at(-1), `${name} allowed reply`, `${name} keeps the normal reply path`);

    await bridge.accept(message(`access-command-denied-${name}`, '/new'));
    assert.equal(asks.length, 1, `${name} denied command never reaches Harness`);
    assert.equal(sessionClears, 0, `${name} denied command has no command side effect`);
    assert.equal(sent.at(-1), COMMAND_PERMISSION_DENIED_MESSAGE, `${name} explains command denial`);

    settings = accessPolicy({ canExecuteCommands: true });
    await bridge.accept(message(`access-command-allowed-${name}`, '/new'));
    assert.equal(sessionClears, 1, `${name} policy hot-update applies without rebuilding the bridge`);
    assert.equal(asks.length, 1, `${name} allowed local command is not a model prompt`);
  }
});

test('all four shared text channels resolve replies only after trigger and command gates', async () => {
  for (const [name, Bridge] of [
    ['slack', SlackHarnessBridge],
    ['telegram', TelegramHarnessBridge],
    ['discord', DiscordHarnessBridge],
    ['whatsapp', WhatsappHarnessBridge],
  ]) {
    const fixture = stateFixture();
    const sent = [];
    const asks = [];
    let replyLoads = 0;
    const replyTo = () => ({
      messageId: `quoted-${name}`,
      load: async () => {
        replyLoads += 1;
        return {
          messageId: `quoted-${name}`,
          authorName: 'Original author',
          content: '/new 只是被引用的原文',
          attachments: [{ kind: 'file', name: 'brief.pdf' }],
        };
      },
    });
    const bridge = new Bridge({
      bot: { sendText: async (_target, text) => sent.push(text) },
      state: fixture.state,
      harness: {
        createSession: async () => `session-reply-${name}`,
        sessionExists: async () => true,
        ask: async (_sessionId, content) => {
          asks.push(content);
          return `${name} reply`;
        },
      },
    });

    await bridge.accept(message(`reply-unaddressed-${name}`, 'ignored', {
      kind: 'group',
      conversationId: `group-${name}`,
      addressed: false,
      replyTo: replyTo(),
    }));
    await bridge.accept(message(`reply-help-${name}`, '/help', { replyTo: replyTo() }));
    assert.equal(replyLoads, 0, `${name} does not fetch before trigger and command gates`);
    assert.equal(asks.length, 0, name);

    await bridge.accept(message(`reply-question-${name}`, '当前问题', { replyTo: replyTo() }));
    assert.equal(replyLoads, 1, `${name} resolves once at the model prompt stage`);
    assert.equal(asks.length, 1, name);
    assert.equal(Array.isArray(asks[0]), true, name);
    assert.match(asks[0][0].text, /^<dsh_im_reply_to>/, name);
    assert.match(asks[0][0].text, /\/new 只是被引用的原文/, name);
    assert.deepEqual(asks[0][1], { type: 'text', text: '当前问题' }, name);
  }
});

test('runtime abort clears a queued interaction reply reaction instead of marking success', async () => {
  const fixture = stateFixture();
  const controller = new AbortController();
  const invalidStarted = deferred();
  const releaseInvalid = deferred();
  const originalMarkSeen = fixture.state.markSeen.bind(fixture.state);
  fixture.state.markSeen = async (messageId) => {
    await originalMarkSeen(messageId);
    if (messageId === 'blocking-invalid') {
      invalidStarted.resolve();
      await releaseInvalid.promise;
    }
  };
  const sent = [];
  const reactions = [];
  const bridge = new TextHarnessBridge({
    descriptor: {
      key: 'test',
      label: 'Test',
      reactions: { processing: 'eyes', success: 'done', error: 'error' },
    },
    state: fixture.state,
    signal: controller.signal,
    bot: {
      addReaction: async (target, emoji) => {
        reactions.push(['add', target.id, emoji]);
        return emoji;
      },
      removeReaction: async (target, emoji) => {
        reactions.push(['remove', target.id, emoji]);
      },
      sendText: async (_target, text) => sent.push(text),
    },
    harness: {
      sessionExists: async () => false,
      createSession: async () => 'session-reaction-abort',
      ask: async (sessionId, _text, options) => {
        await options.onInteraction(questionInteraction({ sessionId }));
        await new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
        });
      },
    },
    logger: { warn() {}, error() {} },
  });

  const processing = bridge.accept(message('interaction-start', '启动交互'));
  await eventually(() => sent.some((text) => text.includes('请回答')));
  const invalid = bridge.accept(message('blocking-invalid', ''));
  await invalidStarted.promise;
  const answer = bridge.accept(message('queued-answer', '有效回答', {
    reactionTarget: { id: 'source-answer' },
  }));
  await eventually(() => reactions.some((call) => call[0] === 'add'));

  controller.abort(new DOMException('runtime stopped', 'AbortError'));
  releaseInvalid.resolve();
  await Promise.all([processing, invalid, answer]);
  await eventually(() => reactions.some((call) => call[0] === 'remove'));

  assert.deepEqual(reactions, [
    ['add', 'source-answer', 'eyes'],
    ['remove', 'source-answer', 'eyes'],
  ]);
});

test('all four shared text channels execute /compact outside the model prompt path', async () => {
  for (const [name, Bridge] of [
    ['slack', SlackHarnessBridge],
    ['telegram', TelegramHarnessBridge],
    ['discord', DiscordHarnessBridge],
    ['whatsapp', WhatsappHarnessBridge],
  ]) {
    const fixture = stateFixture({ 'direct:chat-a': `session-${name}` });
    const sent = [];
    const executed = [];
    const bridge = new Bridge({
      bot: { sendText: async (_target, text) => sent.push(text) },
      state: fixture.state,
      harness: {
        executeCommand: async (sessionId, line) => {
          executed.push({ sessionId, line });
          return {
            commandId: `command-${name}`,
            result: { kind: 'success', text: 'Compacted 12 history items (~3456 tokens).' },
          };
        },
        ask: async () => assert.fail('/compact must not be submitted to the model'),
      },
    });

    await bridge.accept(message(`compact-${name}`, '/compact'));

    assert.deepEqual(executed, [{ sessionId: `session-${name}`, line: '/compact' }]);
    assert.deepEqual(sent, ['已压缩 12 条历史记录（约 3456 个 token）。']);
  }
});

test('all four shared text channels expose structured model rate limits without changing connection state', async () => {
  for (const [name, Bridge] of [
    ['slack', SlackHarnessBridge],
    ['telegram', TelegramHarnessBridge],
    ['discord', DiscordHarnessBridge],
    ['whatsapp', WhatsappHarnessBridge],
  ]) {
    const fixture = stateFixture({ 'direct:chat-a': `session-${name}` });
    const sent = [];
    const status = {
      ...createTextBridgeStatus(),
      connected: true,
      connectionState: 'connected',
    };
    const bridge = new Bridge({
      bot: { sendText: async (_target, text) => sent.push(text) },
      state: fixture.state,
      status,
      harness: {
        sessionExists: async () => true,
        ask: async () => {
          const error = new Error('private provider rate-limit detail');
          error.code = 'harness-turn-failed';
          error.providerCode = 'RATE_LIMIT';
          throw error;
        },
      },
      logger: { error() {} },
    });

    await bridge.accept(message(`rate-limit-${name}`, '触发模型限流'));

    const failure = status.lastMessageError;
    assert.equal(failure.code, 'MODEL_RATE_LIMIT', name);
    assert.equal(failure.reason, 'HARNESS_TURN_FAILED', name);
    assert.match(failure.referenceId, /^MF-[A-F0-9]{8}$/, name);
    assert.match(sent.at(-1), /模型服务正在限流，本次任务未完成。请稍后重试。/, name);
    assert.equal(sent.at(-1).endsWith(`参考号：${failure.referenceId}`), true, name);
    assert.doesNotMatch(sent.at(-1), /private provider rate-limit detail/, name);
    assert.equal(status.connected, true, name);
    assert.equal(status.connectionState, 'connected', name);
  }
});

test('all four shared text channels retain a traceable artifact failure until a clean turn succeeds', async (t) => {
  for (const [name, Bridge] of [
    ['slack', SlackHarnessBridge],
    ['telegram', TelegramHarnessBridge],
    ['discord', DiscordHarnessBridge],
    ['whatsapp', WhatsappHarnessBridge],
  ]) {
    const failedArtifact = await committedArtifact(
      t,
      `${name}-blocked.txt`,
      'blocked',
      `${name}-blocked`,
    );
    const sentArtifact = await committedArtifact(
      t,
      `${name}-sent.txt`,
      'sent',
      `${name}-sent`,
    );
    const fixture = stateFixture();
    const sent = [];
    const status = {
      ...createTextBridgeStatus(),
      connected: true,
      connectionState: 'connected',
    };
    let askCount = 0;
    const bridge = new Bridge({
      bot: {
        sendText: async (_target, text) => {
          sent.push(text);
          return { id: `${name}-text-${sent.length}` };
        },
        sendFile: async (_target, file) => {
          if (file.fileName.endsWith('-blocked.txt')) {
            const error = new Error('private permission detail');
            error.code = 'artifact-permission-required';
            throw error;
          }
          return { id: `${name}-file` };
        },
      },
      state: fixture.state,
      status,
      harness: {
        createSession: async () => `session-${name}`,
        sessionExists: async () => true,
        ask: async (_sessionId, _text, options) => {
          const artifact = askCount === 0 ? failedArtifact : sentArtifact;
          askCount += 1;
          await options.onArtifact(artifact);
          return '文件已生成。';
        },
      },
      logger: { warn() {}, error() {} },
    });

    await bridge.accept(message(`artifact-failed-${name}`, '生成文件'));

    const failure = status.lastMessageError;
    assert.equal(failure.code, 'CHANNEL_PERMISSION', name);
    assert.equal(failure.reason, 'ARTIFACT_PERMISSION_REQUIRED', name);
    assert.match(failure.referenceId, /^MF-[A-F0-9]{8}$/, name);
    assert.equal(sent.at(-1).endsWith(`参考号：${failure.referenceId}`), true, name);
    assert.doesNotMatch(sent.at(-1), /private permission detail/, name);
    assert.equal(status.connected, true, name);
    assert.equal(status.connectionState, 'connected', name);

    await bridge.accept(message(`artifact-clean-${name}`, '再生成一个文件'));
    assert.equal(status.lastMessageError, null, `${name} clears the prior failure after a clean turn`);
  }
});

test('all four shared text channels collect a private batch and submit it in one ordered ask', async () => {
  for (const [name, Bridge] of [
    ['slack', SlackHarnessBridge],
    ['telegram', TelegramHarnessBridge],
    ['discord', DiscordHarnessBridge],
    ['whatsapp', WhatsappHarnessBridge],
  ]) {
    const fixture = stateFixture();
    const sent = [];
    const asks = [];
    const bridge = new Bridge({
      bot: { sendText: async (_target, text) => sent.push(text) },
      state: fixture.state,
      harness: {
        createSession: async () => `session-batch-${name}`,
        sessionExists: async () => true,
        ask: async (sessionId, text) => {
          asks.push({ sessionId, text });
          return `batch reply ${name}`;
        },
      },
    });

    const accepted = [
      bridge.accept(message(`batch-start-${name}`, '/batch')),
      bridge.accept(message(`batch-first-${name}`, 'first line')),
      bridge.accept(message(`batch-last-${name}`, 'last line')),
      bridge.accept(message(`batch-send-${name}`, '/send')),
    ];
    await Promise.all(accepted);

    assert.equal(asks.length, 1, `${name} sends one ask`);
    assert.equal(asks[0].sessionId, `session-batch-${name}`, name);
    assert.match(asks[0].text, /\[消息 1\]\nfirst line/, name);
    assert.match(asks[0].text, /\[消息 2\]\nlast line/, name);
    assert.ok(
      asks[0].text.indexOf('first line') < asks[0].text.indexOf('last line'),
      `${name} preserves order`,
    );
    assert.equal(sent.filter((text) => text === `batch reply ${name}`).length, 1, name);
    assert.equal(fixture.seen.has(`batch-first-${name}`), true, `${name} records first item`);
    assert.equal(fixture.seen.has(`batch-last-${name}`), true, `${name} records last item`);

    await bridge.accept(message(`normal-after-batch-${name}`, 'ordinary message'));
    assert.equal(asks.length, 2, `${name} resumes ordinary chat`);
    assert.equal(asks[1].text, 'ordinary message', `${name} ordinary prompt stays unchanged`);
  }
});

test('shared text channels reserve addressed group batch commands without changing group chat', async () => {
  const commands = ['/batch', '/BATCH now', '/send', '/send later', '/cancel', '/cancel all'];
  for (const [name, Bridge] of [
    ['slack', SlackHarnessBridge],
    ['telegram', TelegramHarnessBridge],
    ['discord', DiscordHarnessBridge],
    ['whatsapp', WhatsappHarnessBridge],
  ]) {
    const fixture = stateFixture();
    const sent = [];
    const asks = [];
    const bridge = new Bridge({
      bot: { sendText: async (_target, text) => sent.push(text) },
      state: fixture.state,
      harness: {
        createSession: async () => `group-session-${name}`,
        sessionExists: async () => true,
        ask: async (_sessionId, text) => {
          asks.push(text);
          return `${name} group reply`;
        },
      },
    });

    for (const [index, command] of commands.entries()) {
      await bridge.accept(message(`group-batch-${name}-${index}`, command, {
        kind: 'group',
        conversationId: `group-${name}`,
        addressed: true,
      }));
    }
    assert.equal(asks.length, 0, `${name} never submits a group batch command`);
    assert.equal(sent.length, commands.length, `${name} replies to every addressed form`);
    assert.equal(
      sent.every((text) => text.includes('仅支持私聊')),
      true,
      `${name} explains the private-only boundary`,
    );

    const beforeUnaddressed = sent.length;
    await bridge.accept(message(`group-unaddressed-${name}`, '/batch', {
      kind: 'group',
      conversationId: `group-${name}`,
      addressed: false,
    }));
    assert.equal(sent.length, beforeUnaddressed, `${name} keeps mention rules intact`);
    assert.equal(asks.length, 0, `${name} ignores an unaddressed group command`);

    await bridge.accept(message(`group-normal-${name}`, 'ordinary addressed group message', {
      kind: 'group',
      conversationId: `group-${name}`,
      addressed: true,
    }));
    assert.deepEqual(asks, ['ordinary addressed group message'], `${name} group chat is unchanged`);
  }
});

test('private batch input enforces text-only collection, command blocking, the limit, and cancel', async () => {
  const fixture = stateFixture();
  const sent = [];
  let asks = 0;
  const bridge = createBridge({
    state: fixture.state,
    bot: { sendText: async (_target, text) => sent.push(text) },
    harness: {
      createSession: async () => 'unused-batch-session',
      ask: async () => { asks += 1; return 'unexpected'; },
    },
  });

  await bridge.accept(message('limited-start', '/batch'));
  await bridge.accept(message('limited-image', 'image caption', {
    images: [{ data: Buffer.from('image') }],
  }));
  await bridge.accept(message('limited-file', 'file caption', {
    files: [{ name: 'data.txt', data: Buffer.from('data') }],
  }));
  let replyLoads = 0;
  await bridge.accept(message('limited-reply', 'quoted caption', {
    replyTo: {
      content: 'quoted text',
      load: async () => { replyLoads += 1; return { content: 'must not load' }; },
    },
  }));
  await bridge.accept(message('limited-unsupported-media', 'video caption', {
    plainText: false,
  }));
  await bridge.accept(message('limited-command', '/new'));

  const itemPromises = [];
  for (let index = 1; index <= 11; index += 1) {
    itemPromises.push(bridge.accept(message(`limited-item-${index}`, `item ${index}`)));
  }
  await Promise.all(itemPromises);
  await bridge.accept(message('limited-item-10', 'item 10 replay'));
  await bridge.accept(message('limited-cancel', '/cancel'));

  assert.equal(asks, 0, 'collection and cancellation never call Harness');
  assert.equal(replyLoads, 0, 'batch collection never resolves quoted content');
  assert.equal(sent.filter((text) => text.includes('目前仅支持文字')).length, 4);
  assert.equal(sent.some((text) => text.includes('先发送 /send 提交或 /cancel 取消')), true);
  assert.equal(sent.some((text) => /10\/10.*已满/.test(text)), true);
  assert.equal(sent.some((text) => text.includes('这条消息未收录')), true);
  assert.equal(sent.at(-1).includes('共丢弃 10 条消息'), true);
  assert.equal(fixture.seen.has('limited-item-11'), true, 'a rejected eleventh item is recorded');

  await bridge.accept(message('normal-after-cancel', 'normal after cancel'));
  assert.equal(asks, 1, 'cancel restores the ordinary prompt path');
});

test('batch commands cannot answer a pending Harness question or approval', async () => {
  for (const interactionKind of ['question', 'approval']) {
    const fixture = stateFixture();
    const sent = [];
    const interactionDone = deferred();
    let interactionResponses = 0;
    const bridge = createBridge({
      state: fixture.state,
      bot: { sendText: async (_target, text) => sent.push(text) },
      harness: {
        createSession: async () => `session-pending-${interactionKind}`,
        ask: async (sessionId, _text, options) => {
          const interaction = interactionKind === 'question'
            ? questionInteraction({
                id: 'pending-batch-question',
                sessionId,
                questions: [{ id: 'answer', question: 'question waiting' }],
                respond: async () => {
                  interactionResponses += 1;
                  interactionDone.resolve();
                  return { accepted: true };
                },
              })
            : approvalInteraction({
                id: 'pending-batch-approval',
                sessionId,
                reason: 'approval waiting',
                respond: async () => {
                  interactionResponses += 1;
                  interactionDone.resolve();
                  return { accepted: true };
                },
              });
          await options.onInteraction(interaction);
          await interactionDone.promise;
          return `${interactionKind} complete`;
        },
      },
    });

    const processing = bridge.accept(message(
      `pending-${interactionKind}-start`,
      `start ${interactionKind}`,
    ));
    await eventually(() => sent.some((text) => text.includes(`${interactionKind} waiting`)));

    await within(
      Promise.all([
        bridge.accept(message(`pending-${interactionKind}-batch`, '/batch')),
        bridge.accept(message(`pending-${interactionKind}-send`, '/send')),
        bridge.accept(message(`pending-${interactionKind}-cancel`, '/cancel')),
      ]),
      250,
      `batch commands waited behind a pending ${interactionKind}`,
    );
    assert.equal(interactionResponses, 0, `${interactionKind} was not answered by a batch command`);
    assert.equal(sent.some((text) => text.includes('先完成当前交互')), true, interactionKind);
    assert.equal(sent.some((text) => text.includes('没有待提交')), true, interactionKind);
    assert.equal(sent.some((text) => text.includes('没有正在进行')), true, interactionKind);

    await bridge.accept(message(
      `pending-${interactionKind}-answer`,
      interactionKind === 'question' ? 'yes' : '批准',
    ));
    await processing;
    assert.equal(interactionResponses, 1, `${interactionKind} accepts its real answer`);
  }
});

test('a submitting batch rejects duplicate controls while a later ordinary message stays ordinary', async () => {
  const fixture = stateFixture();
  const sent = [];
  const batchStarted = deferred();
  const releaseBatch = deferred();
  const asks = [];
  const bridge = createBridge({
    state: fixture.state,
    bot: { sendText: async (_target, text) => sent.push(text) },
    harness: {
      createSession: async () => 'session-submitting-batch',
      sessionExists: async () => true,
      ask: async (_sessionId, text) => {
        asks.push(text);
        if (asks.length === 1) {
          batchStarted.resolve();
          await releaseBatch.promise;
          return 'batch complete';
        }
        return 'ordinary complete';
      },
    },
  });

  await bridge.accept(message('submitting-start', '/batch'));
  await bridge.accept(message('submitting-item', 'batched item'));
  const submission = bridge.accept(message('submitting-send', '/send'));
  await batchStarted.promise;

  await within(
    Promise.all([
      bridge.accept(message('submitting-send-again', '/send')),
      bridge.accept(message('submitting-cancel', '/cancel')),
    ]),
    250,
    'submitting controls waited behind the batch ask',
  );
  const ordinary = bridge.accept(message('submitting-ordinary', 'ordinary after send'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asks.length, 1, 'the later ordinary message waits in the existing queue');
  assert.equal(sent.some((text) => text.includes('请勿重复发送 /send')), true);
  assert.equal(sent.some((text) => text.includes('已经提交，无法取消')), true);

  releaseBatch.resolve();
  await Promise.all([submission, ordinary]);
  assert.equal(asks.length, 2);
  assert.equal(asks[1], 'ordinary after send');
});

test('a failed batch submission is retained with an explicit retry and can be sent once again', async () => {
  const fixture = stateFixture();
  const sent = [];
  const asks = [];
  let attempt = 0;
  const bridge = createBridge({
    state: fixture.state,
    bot: { sendText: async (_target, text) => sent.push(text) },
    harness: {
      createSession: async () => 'session-retry-batch',
      sessionExists: async () => true,
      ask: async (_sessionId, text) => {
        asks.push(text);
        attempt += 1;
        if (attempt === 1) throw new Error('transient Harness failure');
        return 'retry complete';
      },
    },
  });

  await bridge.accept(message('retry-batch-start', '/batch'));
  await bridge.accept(message('retry-batch-item', 'keep this item'));
  await bridge.accept(message('retry-batch-send-one', '/send'));

  assert.equal(asks.length, 1);
  assert.equal(sent.at(-1).includes('已保留 1 条消息'), true);
  assert.equal(sent.at(-1).includes('/send 重试'), true);

  await bridge.accept(message('retry-batch-send-two', '/send'));
  assert.equal(asks.length, 2);
  assert.equal(asks[1], asks[0], 'retry reuses the retained immutable batch content');
  assert.equal(sent.at(-1), 'retry complete');

  await bridge.accept(message('retry-no-batch', '/send'));
  assert.equal(sent.at(-1).includes('没有待提交'), true, 'successful retry clears the batch');
});

test('stopping a submitted batch clears it instead of offering a duplicate retry', async () => {
  const fixture = stateFixture();
  const sent = [];
  let asks = 0;
  const stopped = new Error('stopped by user');
  stopped.code = 'turn-stopped';
  const bridge = createBridge({
    state: fixture.state,
    bot: { sendText: async (_target, text) => sent.push(text) },
    harness: {
      createSession: async () => 'session-stopped-batch',
      ask: async () => {
        asks += 1;
        throw stopped;
      },
    },
  });

  await bridge.accept(message('stopped-batch-start', '/batch'));
  await bridge.accept(message('stopped-batch-item', 'do this once'));
  await bridge.accept(message('stopped-batch-send', '/send'));
  assert.equal(asks, 1);
  assert.equal(sent.some((text) => text.includes('已保留')), false);

  await bridge.accept(message('stopped-batch-send-again', '/send'));
  assert.equal(asks, 1, 'a stopped submission cannot be retried as the same batch');
  assert.equal(sent.at(-1).includes('没有待提交'), true);
});

test('shared text bridge passes a file-only message through askOptions.files', async () => {
  const fixture = stateFixture();
  const source = Object.freeze({
    name: 'report.bin',
    load: async () => Buffer.from([0x00, 0xff]),
  });
  const asks = [];
  const sent = [];
  const bridge = createBridge({
    state: fixture.state,
    bot: { sendText: async (_target, text) => sent.push(text) },
    harness: {
      createSession: async () => 'session-file-only-inbound',
      ask: async (sessionId, text, options) => {
        asks.push({ sessionId, text, files: options.files });
        return '文件已交给 Harness。';
      },
    },
  });

  await bridge.accept(message('inbound-file-only', '', { files: [source] }));

  assert.deepEqual(asks, [{
    sessionId: 'session-file-only-inbound',
    text: '',
    files: [source],
  }]);
  assert.deepEqual(sent, ['文件已交给 Harness。']);
});

test('shared text bridge keeps caption and native files in one Harness ask', async () => {
  const fixture = stateFixture();
  const sources = [
    { name: 'one.txt', data: Buffer.from('one') },
    { name: 'two.zip', load: async () => Buffer.from('two') },
  ];
  const asks = [];
  const bridge = createBridge({
    state: fixture.state,
    bot: { sendText: async () => undefined },
    harness: {
      createSession: async () => 'session-text-and-files',
      ask: async (sessionId, text, options) => {
        asks.push({ sessionId, text, files: options.files });
        return '完成';
      },
    },
  });

  await bridge.accept(message('inbound-text-and-files', '请检查这两个文件', { files: sources }));

  assert.deepEqual(asks, [{
    sessionId: 'session-text-and-files',
    text: '请检查这两个文件',
    files: sources,
  }]);
});

test('a command-looking file caption is an ordinary Harness prompt, not a bridge command', async () => {
  const fixture = stateFixture({ 'direct:chat-a': 'session-existing' });
  const source = { name: 'new.txt', data: Buffer.from('not a command') };
  const asks = [];
  const sent = [];
  const bridge = createBridge({
    state: fixture.state,
    bot: { sendText: async (_target, text) => sent.push(text) },
    harness: {
      sessionExists: async () => true,
      ask: async (sessionId, text, options) => {
        asks.push({ sessionId, text, files: options.files });
        return '附件消息已处理';
      },
    },
  });

  await bridge.accept(message('file-caption-command', '/new', { files: [source] }));

  assert.equal(fixture.sessions.get('direct:chat-a'), 'session-existing');
  assert.deepEqual(asks, [{
    sessionId: 'session-existing',
    text: '/new',
    files: [source],
  }]);
  assert.deepEqual(sent, ['附件消息已处理']);
});

test('an inbound file cannot claim a pending Harness interaction answer', async () => {
  const fixture = stateFixture();
  const sent = [];
  const questionAnswered = deferred();
  let interactionResponses = 0;
  const asks = [];
  const bridge = createBridge({
    state: fixture.state,
    bot: { sendText: async (_target, text) => sent.push(text) },
    harness: {
      createSession: async () => 'session-file-during-question',
      ask: async (sessionId, text, options) => {
        asks.push({ sessionId, text, files: options.files });
        await options.onInteraction(questionInteraction({
          sessionId,
          questions: [{ id: 'confirm', question: '是否继续？' }],
          respond: async (result) => {
            interactionResponses += 1;
            questionAnswered.resolve(result);
            return { accepted: true };
          },
        }));
        await questionAnswered.promise;
        return '继续执行';
      },
    },
  });

  const processing = bridge.accept(message('question-with-file-start', '先询问我'));
  await eventually(() => sent.some((text) => text.includes('是否继续？')));
  await bridge.accept(message('question-file-attempt', 'yes', {
    files: [{ name: 'answer.txt', data: Buffer.from('yes') }],
  }));

  assert.equal(interactionResponses, 0);
  assert.equal(asks.length, 1, 'the attachment must not become a sibling ask while interaction is open');
  assert.equal(sent.at(-1), '请用文字回答当前问题。');

  await bridge.accept(message('question-text-answer', 'yes'));
  await processing;
  assert.equal(interactionResponses, 1);
  assert.equal(sent.at(-1), '继续执行');
});

test('shared text bridge reports a safe native-file download failure', async () => {
  const fixture = stateFixture();
  const sent = [];
  const bridge = createBridge({
    state: fixture.state,
    bot: { sendText: async (_target, text) => sent.push(text) },
    harness: {
      createSession: async () => 'session-file-download-failure',
      ask: async () => {
        throw new InboundFileError(
          'inbound-file-download-failed',
          'private channel URL https://secret.example/token failed',
          '文件下载失败，请重新发送后再试。',
        );
      },
    },
  });

  await bridge.accept(message('file-download-failure', '', {
    files: [{ name: 'failed.txt', load: async () => Buffer.from('unused') }],
  }));

  assert.equal(sent.length, 1);
  assert.match(sent[0], /^文件下载失败，请重新发送后再试。/);
  assert.match(sent[0], /错误码：INPUT_INVALID；参考号：MF-[A-F0-9]{8}$/);
  assert.doesNotMatch(sent[0], /secret|token|https:/i);
});

test('all four shared text channels list models and presets locally and advertise fast commands', async () => {
  for (const [name, Bridge] of [
    ['slack', SlackHarnessBridge],
    ['telegram', TelegramHarnessBridge],
    ['discord', DiscordHarnessBridge],
    ['whatsapp', WhatsappHarnessBridge],
  ]) {
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
        label: `${name} Preset ${index + 1} ${'x'.repeat(64)}`,
      })),
    };
    const bridge = new Bridge({
      bot: { sendText: async (_target, text) => sent.push(text) },
      state: fixture.state,
      harness: {
        listModels: async () => ({
          groups: [{
            id: `${name}-provider`,
            name: `${name} Provider`,
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
        createSession: async () => { creates += 1; return `${name}-session`; },
        ask: async () => { asks += 1; return 'unexpected model reply'; },
      },
    });

    await bridge.accept(message(`models-${name}`, '/models'));
    assert.match(sent.at(-1), new RegExp(`1\\. ${name}-provider/model-one`), name);
    assert.equal(asks, 0, `${name} ask`);
    assert.equal(creates, 0, `${name} create`);
    assert.equal(fixture.sessions.size, 0, `${name} session binding`);

    await bridge.accept(message(`reasoning-${name}`, '/reasoninglist'));
    assert.match(sent.at(-1), /还没有会话/, `${name} reasoning command`);
    assert.equal(asks, 0, `${name} reasoning ask`);
    assert.equal(creates, 0, `${name} reasoning create`);
    assert.equal(fixture.sessions.size, 0, `${name} reasoning session binding`);

    const presetReplyStart = sent.length;
    await bridge.accept(message(`presets-${name}`, '/presetlist'));
    const presetReplies = sent.slice(presetReplyStart);
    assert.ok(presetReplies.length > 1, `${name} sends every preset-list chunk`);
    assert.match(presetReplies.join('\n'), /preset-070/, name);
    assert.equal(asks, 0, `${name} preset ask`);
    assert.equal(creates, 0, `${name} preset create`);
    assert.equal(fixture.sessions.size, 0, `${name} preset session binding`);

    await bridge.accept(message(`preset-current-${name}`, '/preset'));
    assert.match(sent.at(-1), /跟随 Host 默认/, name);
    assert.equal(asks, 0, `${name} preset current ask`);
    assert.equal(creates, 0, `${name} preset current create`);

    const selectReplyStart = sent.length;
    await bridge.accept(message(`preset-select-${name}`, '/preset 2'));
    assert.deepEqual(presetUpdates, ['preset-002'], `${name} scoped preset update`);
    assert.equal(sent.length, selectReplyStart + 1, `${name} sends the complete select reply`);
    assert.match(sent.at(-1), /preset-002/, name);

    const defaultReplyStart = sent.length;
    await bridge.accept(message(`preset-default-${name}`, '/preset --default'));
    assert.deepEqual(presetUpdates, ['preset-002', null], `${name} scoped preset reset`);
    assert.equal(sent.length, defaultReplyStart + 1, `${name} sends the complete default reply`);
    assert.match(sent.at(-1), /跟随 Host 默认/, name);
    assert.equal(asks, 0, `${name} mutation ask`);
    assert.equal(creates, 0, `${name} mutation create`);
    assert.equal(fixture.sessions.size, 0, `${name} mutation session binding`);

    await bridge.accept(message(`help-${name}`, '/help'));
    const help = sent.at(-1);
    for (const command of [
      '/models', '/model', '/reasoninglist', '/reasonings', '/reasoning',
      '/presetlist', '/preset', '/preset --default', '/stop', '/steer', '/version',
    ]) {
      assert.match(help, new RegExp(`\\${command}`), `${name} ${command}`);
    }
    assert.match(help, /\/model .*\[推理等级ID\]/, `${name} optional model reasoning effort`);
    assert.match(help, /示例：先发 \/models，再发 \/model 2 \[推理等级ID\]/, `${name} model effort placeholder`);
    assert.doesNotMatch(help, /\/model 2 high\b/, `${name} does not assume a reasoning effort ID`);
    assert.match(help, /\/preset id:<ID>/, `${name} numeric preset ID selection`);
  }
});

test('/version uses the shared command fast lane without accessing Harness', async () => {
  const fixture = stateFixture();
  const sent = [];
  const bridge = createBridge({
    state: fixture.state,
    bot: { sendText: async (_target, text) => sent.push(text) },
    harness: {},
  });

  await bridge.accept(message('plugin-version', '/version'));

  assert.deepEqual(sent, [`dsh-im v${manifest.version}`]);
  assert.equal(fixture.sessions.size, 0);
});

test('/stop uses the shared command fast lane without waiting for the running prompt', async () => {
  const fixture = stateFixture({ 'direct:chat-a': 'session-running' });
  const askStarted = deferred();
  const releaseAsk = deferred();
  const sent = [];
  const controls = {};
  let promptSettled = false;
  const session = {
    sessionExists: async () => true,
    ask: async (_text, options) => {
      controls.prompt = options.control;
      askStarted.resolve();
      await releaseAsk.promise;
      return '原任务完成';
    },
    stopActiveTurn: async (control) => {
      controls.stop = control;
      return true;
    },
  };
  const bridge = createBridge({
    state: fixture.state,
    bot: { sendText: async (_target, text) => sent.push(text) },
    harness: { workspaceSession: () => session },
  });

  const prompt = bridge.accept(message('running-prompt', '执行一个长任务'))
    .finally(() => { promptSettled = true; });
  await askStarted.promise;

  await within(
    bridge.accept(message('running-stop', '/stop')),
    250,
    '/stop waited for the ordinary conversation queue',
  );
  assert.equal(promptSettled, false);
  assert.equal(sent.includes('已请求停止当前任务。'), true);
  assert.equal(controls.stop.owner, controls.prompt.owner);
  assert.equal(controls.stop.key, controls.prompt.key);

  releaseAsk.resolve();
  await prompt;
  assert.equal(sent.at(-1), '原任务完成');
});

test('a stopped shared-channel turn closes an opened stream instead of leaving a processing placeholder', async () => {
  const fixture = stateFixture({ 'direct:chat-a': 'session-running' });
  const finished = [];
  let cancelled = 0;
  const sent = [];
  const stopped = new Error('stopped');
  stopped.code = 'turn-stopped';
  const bridge = createBridge({
    state: fixture.state,
    bot: {
      sendText: async (_target, text) => sent.push(text),
      openStream: async () => ({
        update() {},
        async finish(text) { finished.push(text); },
        cancel() { cancelled += 1; },
      }),
    },
    harness: {
      workspaceSession: () => ({
        sessionExists: async () => true,
        ask: async () => { throw stopped; },
      }),
    },
  });

  await bridge.accept(message('stopped-stream', '执行长任务'));

  assert.deepEqual(finished, ['已停止。']);
  assert.equal(cancelled, 0);
  assert.deepEqual(sent, []);
});

test('a failed shared-channel turn finalizes an editable stream when fail is unavailable', async () => {
  const fixture = stateFixture({ 'direct:chat-a': 'session-failed-stream' });
  const finished = [];
  const sent = [];
  let cancelled = 0;
  const bridge = createBridge({
    state: fixture.state,
    bot: {
      sendText: async (_target, text) => sent.push(text),
      openStream: async () => ({
        update() {},
        async finish(text) { finished.push(text); },
        cancel() { cancelled += 1; },
      }),
    },
    harness: {
      workspaceSession: () => ({
        sessionExists: async () => true,
        ask: async () => {
          const error = new Error('private provider rate-limit details');
          error.code = 'harness-turn-failed';
          error.providerCode = 'RATE_LIMIT';
          throw error;
        },
      }),
    },
  });

  await bridge.accept(message('failed-editable-stream', '执行任务'));

  assert.equal(finished.length, 1);
  assert.match(finished[0], /模型服务正在限流/);
  assert.match(finished[0], /错误码：MODEL_RATE_LIMIT；参考号：MF-[A-F0-9]{8}/);
  assert.doesNotMatch(finished[0], /private provider rate-limit details/);
  assert.equal(cancelled, 0);
  assert.deepEqual(sent, []);
});

test('an unknown final delivery receipt is reported without rerunning the prompt', async () => {
  const fixture = stateFixture({ 'direct:chat-a': 'session-unknown-delivery' });
  const notices = [];
  let asks = 0;
  const status = {
    ...createTextBridgeStatus(),
    connected: true,
    connectionState: 'connected',
  };
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'test', label: 'Test' },
    state: fixture.state,
    status,
    bot: {
      sendDelivery: async () => ({
        presentation: 'test-final',
        providerMessageIds: ['possibly-sent-answer'],
        deliveryOutcome: 'unknown',
        reason: 'provider-timeout',
      }),
      sendText: async (_target, text) => {
        notices.push(text);
        return { providerMessageIds: ['uncertain-notice'] };
      },
    },
    harness: {
      workspaceSession: () => ({
        sessionExists: async () => true,
        ask: async () => {
          asks += 1;
          return '可能已经送达的回答';
        },
      }),
    },
    logger: { warn() {}, error() {} },
  });

  const receipt = await bridge.accept(message('unknown-final-delivery', '回答问题'));

  assert.equal(asks, 1);
  assert.equal(status.lastMessageError.code, 'CHANNEL_DELIVERY_UNCERTAIN');
  assert.match(notices.at(-1), /发送结果未能确认.*不要立即重复提交/);
  assert.equal(notices.at(-1).endsWith(`参考号：${status.lastMessageError.referenceId}`), true);
  assert.deepEqual(receipt.providerMessageIds, ['possibly-sent-answer']);
  assert.equal(receipt.deliveryOutcome, 'unknown');
  assert.equal(status.connected, true);
  assert.equal(status.connectionState, 'connected');
});

test('shared text artifact delivery sends text first and each materialized file in order', async (t) => {
  const first = await committedArtifact(t, 'result.html', '<h1>result</h1>', 'success-html');
  const second = await committedArtifact(t, 'notes.txt', 'notes', 'success-text');
  const fixture = stateFixture();
  const order = [];
  const files = [];
  const target = { id: 'artifact-success-target' };
  const bridge = createBridge({
    state: fixture.state,
    bot: {
      sendText: async (_target, text) => {
        order.push(`text:${text}`);
        return { id: 'text-success' };
      },
      sendFile: async (receivedTarget, file) => {
        order.push(`file:${file.fileName}`);
        files.push({ target: receivedTarget, file });
        return { message_id: `file-${files.length}` };
      },
    },
    harness: {
      createSession: async () => 'session-artifact-success',
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(first);
        await options.onArtifact(second);
        return '结果文件如下。';
      },
    },
  });

  const receipt = await bridge.accept(message(
    'artifact-success',
    '生成结果文件',
    { replyTarget: target },
  ));

  assert.deepEqual(order, [
    'text:结果文件如下。',
    'file:result.html',
    'file:notes.txt',
  ]);
  assert.equal(files[0].target, target);
  assert.equal(files[0].file.bytes.toString(), '<h1>result</h1>');
  assert.equal(files[1].file.bytes.toString(), 'notes');
  assert.equal(bridge.status.artifactsSent, 2);
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    deliveryId: 'artifact-success',
    presentation: 'test-text-and-files',
    providerMessageIds: ['text-success', 'file-1', 'file-2'],
    artifacts: [
      { artifactId: 'success-html-1', outcome: 'sent' },
      { artifactId: 'success-text-1', outcome: 'sent' },
    ],
  });
});

test('a file-only shared text reply shows one neutral completion message before the file', async (t) => {
  const artifact = await committedArtifact(t, 'only.txt', 'only file', 'file-only');
  const fixture = stateFixture();
  const order = [];
  const bridge = createBridge({
    state: fixture.state,
    bot: {
      sendText: async (_target, text) => order.push(`text:${text}`),
      sendFile: async (_target, file) => order.push(`file:${file.fileName}`),
    },
    harness: {
      createSession: async () => 'session-file-only',
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '   ';
      },
    },
  });

  await bridge.accept(message('artifact-file-only', '只生成并发送文件'));

  assert.deepEqual(order, ['text:任务已完成。', 'file:only.txt']);
});

test('shared text delivery still attempts registered files when its final text cannot be sent', async (t) => {
  const artifact = await committedArtifact(t, 'text-failed.txt', 'still delivered', 'text-failed');
  const fixture = stateFixture();
  const files = [];
  const texts = [];
  const bridge = createBridge({
    state: fixture.state,
    bot: {
      sendText: async (_target, text) => {
        texts.push(text);
        if (texts.length === 1) throw new Error('private text transport failure');
      },
      sendFile: async (_target, file) => {
        files.push(file.fileName);
        return { key: { id: 'file-after-text-failure' } };
      },
    },
    harness: {
      createSession: async () => 'session-text-failed',
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '文字回答';
      },
    },
  });

  const receipt = await bridge.accept(message('artifact-text-failed', '生成文件'));

  assert.deepEqual(files, ['text-failed.txt']);
  assert.deepEqual(texts, ['文字回答']);
  assert.equal(bridge.status.artifactsSent, 1);
  assert.equal(bridge.status.messagesReplied, 1);
  assert.equal(bridge.status.lastMessageError.code, 'CHANNEL_DELIVERY_UNCERTAIN');
  assert.match(bridge.status.lastMessageError.referenceId, /^MF-[A-F0-9]{8}$/);
  assert.deepEqual(receipt.providerMessageIds, ['file-after-text-failure']);
  assert.deepEqual(receipt.artifacts, [{ artifactId: 'text-failed-1', outcome: 'sent' }]);
});

test('shared text artifact provider failures are isolated from text and later files', async (t) => {
  const providerFailure = await committedArtifact(t, 'provider.txt', 'bad', 'provider-failure');
  const oversized = await committedArtifact(t, 'oversized.txt', '123456789', 'oversized');
  const success = await committedArtifact(t, 'success.txt', 'ok', 'partial-success');
  const fixture = stateFixture();
  const sent = [];
  const attempted = [];
  const bridge = createBridge({
    state: fixture.state,
    bot: {
      sendText: async (_target, text) => {
        sent.push(text);
        return { id: `text-partial-${sent.length}` };
      },
      sendFile: async (_target, file) => {
        attempted.push(file.fileName);
        if (file.fileName === 'provider.txt') {
          throw new Error('private provider diagnostic');
        }
        if (file.fileName === 'oversized.txt') {
          const error = new Error('provider upload limit');
          error.code = 'artifact-too-large';
          throw error;
        }
        return { id: 'file-partial-success' };
      },
    },
    harness: {
      createSession: async () => 'session-artifact-partial',
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(providerFailure);
        await options.onArtifact(oversized);
        await options.onArtifact(success);
        return '三个文件已生成。';
      },
    },
  });

  const receipt = await bridge.accept(message('artifact-partial', '生成三个文件'));

  assert.deepEqual(attempted, ['provider.txt', 'oversized.txt', 'success.txt']);
  assert.equal(sent[0], '三个文件已生成。');
  assert.match(sent[1], /provider\.txt.*暂时未能发送/);
  assert.doesNotMatch(sent[1], /private provider diagnostic/);
  assert.match(sent[2], /oversized\.txt.*超过当前渠道大小上限/);
  assert.equal(bridge.status.artifactsSent, 1);
  assert.equal(bridge.status.artifactSendErrors, 2);
  assert.deepEqual(receipt.providerMessageIds, [
    'text-partial-1',
    'text-partial-2',
    'text-partial-3',
    'file-partial-success',
  ]);
  assert.deepEqual(receipt.artifacts, [
    {
      artifactId: 'provider-failure-1',
      outcome: 'failed',
      reason: 'artifact-provider-failed',
    },
    { artifactId: 'oversized-1', outcome: 'rejected', reason: 'artifact-too-large' },
    { artifactId: 'partial-success-1', outcome: 'sent' },
  ]);
});

test('shared text bridge tells users to check the chat before retrying an uncertain file send', async (t) => {
  const artifact = await committedArtifact(t, 'uncertain.txt', 'bytes', 'uncertain');
  const sent = [];
  let textAttempts = 0;
  const bridge = createBridge({
    state: stateFixture().state,
    bot: {
      sendText: async (_target, text) => {
        textAttempts += 1;
        if (textAttempts === 1) throw new Error('initial text delivery failed');
        sent.push(text);
        return { ts: 'unknown-notice' };
      },
      sendFile: async () => {
        const error = new Error('private timeout detail');
        error.code = 'artifact-delivery-uncertain';
        throw error;
      },
    },
    harness: {
      createSession: async () => 'session-uncertain',
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '文件已生成。';
      },
    },
  });

  const receipt = await bridge.accept(message('artifact-uncertain', '生成文件'));

  assert.equal(textAttempts, 2, 'must not append a contradictory generic retry notice');
  assert.match(sent[0], /发送结果未能确认.*先检查聊天内是否已收到.*不要立即重试/);
  assert.doesNotMatch(sent[0], /private timeout detail/);
  assert.deepEqual(receipt.providerMessageIds, ['unknown-notice']);
  assert.deepEqual(receipt.artifacts, [{
    artifactId: 'uncertain-1',
    outcome: 'unknown',
    reason: 'artifact-delivery-uncertain',
  }]);
});

test('shared text streaming finalizes once before delivering result files', async (t) => {
  const artifact = await committedArtifact(t, 'stream.txt', 'stream file', 'stream');
  const fixture = stateFixture();
  const order = [];
  const bridge = createBridge({
    state: fixture.state,
    bot: {
      sendText: async (_target, text) => order.push(`text:${text}`),
      sendTyping: async () => order.push('typing'),
      openStream: async () => {
        order.push('open');
        return {
          messageId: 'stream-message',
          update: async (text) => order.push(`update:${text}`),
          finish: async (text) => order.push(`finish:${text}`),
          cancel: () => order.push('cancel'),
        };
      },
      sendFile: async (_target, file) => order.push(`file:${file.fileName}`),
    },
    harness: {
      createSession: async () => 'session-artifact-stream',
      ask: async (_sessionId, _text, options) => {
        await options.onUpdate({ type: 'text', text: '处理中' });
        await options.onArtifact(artifact);
        return '流式回答完成';
      },
    },
  });

  const receipt = await bridge.accept(message('artifact-stream', '流式生成文件'));

  assert.deepEqual(order, [
    'typing',
    'open',
    'update:处理中',
    'finish:流式回答完成',
    'file:stream.txt',
  ]);
  assert.deepEqual(receipt.providerMessageIds, ['stream-message']);
});

test('aborting shared text delivery stops before any registered file is sent', async (t) => {
  const artifact = await committedArtifact(t, 'cancelled.txt', 'cancelled', 'cancelled');
  const fixture = stateFixture();
  const controller = new AbortController();
  const sent = [];
  const files = [];
  const bridge = createBridge({
    state: fixture.state,
    signal: controller.signal,
    bot: {
      sendText: async (_target, text) => {
        sent.push(text);
        controller.abort(new DOMException('runtime stopped', 'AbortError'));
      },
      sendFile: async (_target, file) => files.push(file.fileName),
    },
    harness: {
      createSession: async () => 'session-artifact-cancelled',
      ask: async (_sessionId, _text, options) => {
        await options.onArtifact(artifact);
        return '回答完成';
      },
    },
  });

  await bridge.accept(message('artifact-cancelled', '生成后取消'));

  assert.deepEqual(sent, ['回答完成']);
  assert.deepEqual(files, []);
});

test('Slack, Telegram, and Discord remember any valid direct message per bot', async () => {
  for (const [name, Bridge] of [
    ['slack', SlackHarnessBridge],
    ['telegram', TelegramHarnessBridge],
    ['discord', DiscordHarnessBridge],
  ]) {
    let sessionSequence = 0;
    const harness = {
      createSession: async () => `${name}-session-${++sessionSequence}`,
      ask: async () => `${name} reply`,
    };
    const first = stateFixture();
    const second = stateFixture();
    const firstSent = [];
    const secondSent = [];
    const firstBot = {
      sendText: async (target, text) => firstSent.push({ target, text }),
    };
    const secondBot = {
      sendText: async (target, text) => secondSent.push({ target, text }),
    };
    const firstBridge = new Bridge({ bot: firstBot, harness, state: first.state });
    const secondBridge = new Bridge({ bot: secondBot, harness, state: second.state });
    const firstTarget = { channelId: `${name}-private-a` };
    const secondTarget = { channelId: `${name}-private-b` };

    await firstBridge.accept(message(`${name}-direct-a`, 'hello', {
      conversationId: `${name}-private-a`,
      replyTarget: { ...firstTarget, replyToMessageId: 'reply-a' },
      connectionTestTarget: firstTarget,
    }));
    assert.deepEqual(connectionTestTarget(first.state), firstTarget, name);

    await firstBridge.accept(message(`${name}-group`, 'hello group', {
      kind: 'group',
      conversationId: `${name}-group`,
      addressed: true,
      replyTarget: { channelId: `${name}-group` },
      connectionTestTarget: { channelId: `${name}-group` },
    }));
    assert.deepEqual(connectionTestTarget(first.state), firstTarget, `${name} group`);

    await firstBridge.accept(message(`${name}-direct-a`, 'duplicate', {
      conversationId: `${name}-private-replay`,
      replyTarget: { channelId: `${name}-private-replay` },
      connectionTestTarget: { channelId: `${name}-private-replay` },
    }));
    assert.deepEqual(connectionTestTarget(first.state), firstTarget, `${name} duplicate`);

    await secondBridge.accept(message(`${name}-direct-b`, 'hello', {
      conversationId: `${name}-private-b`,
      replyTarget: { ...secondTarget, replyToMessageId: 'reply-b' },
      connectionTestTarget: secondTarget,
    }));
    assert.deepEqual(connectionTestTarget(second.state), secondTarget, `${name} second bot`);

    const reconnectedFirstBridge = new Bridge({ bot: firstBot, harness, state: first.state });
    await reconnectedFirstBridge.sendConnectionTest(`${name} first test`);
    await secondBridge.sendConnectionTest(`${name} second test`);
    assert.deepEqual(
      firstSent.find(({ text }) => text === `${name} first test`)?.target,
      firstTarget,
      `${name} reconnect`,
    );
    assert.deepEqual(
      secondSent.find(({ text }) => text === `${name} second test`)?.target,
      secondTarget,
      `${name} bot isolation`,
    );
  }
});

test('answers a multi-question interaction on the fast lane with canonical values', async () => {
  const fixture = stateFixture();
  const sent = [];
  const asked = [];
  const submitted = deferred();
  const bridge = createBridge({
    state: fixture.state,
    bot: { sendText: async (target, text) => sent.push({ target, text }) },
    harness: {
      createSession: async () => 'session-one',
      ask: async (sessionId, text, options) => {
        asked.push({ sessionId, text });
        await options.onInteraction(questionInteraction({
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
          respond: async (result) => {
            submitted.resolve(result);
            return { accepted: true };
          },
        }));
        await submitted.promise;
        return '交互已完成';
      },
    },
  });

  const processing = bridge.accept(message('prompt', '请分步提问'));
  await eventually(() => sent.some(({ text }) => text.includes('选择回答语言')));
  await bridge.accept(message('language', '2'));
  await eventually(() => sent.some(({ text }) => text.includes('选择交付内容')));
  await bridge.accept(message('deliverables', '1，文档，发布说明'));

  assert.deepEqual(await submitted.promise, {
    ok: true,
    value: {
      sessionId: 'session-one',
      answer: {
        answers: [
          { id: 'language', selected: ['English'] },
          { id: 'deliverables', selected: ['测试', '文档'], custom: '发布说明' },
        ],
      },
    },
  });
  await processing;
  assert.deepEqual(asked, [{ sessionId: 'session-one', text: '请分步提问' }]);
  assert.equal(sent.at(-1).text, '交互已完成');
  assert.deepEqual(sent[1].target, { id: 'target-language' });
});

test('answers approvals on the interaction fast lane with precise text decisions', async () => {
  const fixture = stateFixture();
  const sent = [];
  const asked = [];
  const submitted = [];
  const cases = [
    { reply: '批准', outcome: 'allowed-once' },
    { reply: '同意', outcome: 'allowed-once' },
    { reply: '  YeS  ', outcome: 'allowed-once' },
    { reply: '拒绝', outcome: 'rejected' },
    { reply: '不同意', outcome: 'rejected' },
    { reply: '  NO  ', outcome: 'rejected' },
  ];
  const bridge = createBridge({
    state: fixture.state,
    bot: { sendText: async (target, text) => sent.push({ target, text }) },
    harness: {
      createSession: async () => 'session-one',
      ask: async (sessionId, text, options) => {
        asked.push({ sessionId, text });
        for (const [index, approvalCase] of cases.entries()) {
          const answered = deferred();
          await options.onInteraction(approvalInteraction({
            id: `approval-${index + 1}`,
            sessionId,
            toolName: `tool-${index + 1}`,
            reason: `精准回复测试 ${index + 1}`,
            respond: async (result) => {
              submitted.push(result);
              answered.resolve();
              return { accepted: true };
            },
          }));
          await answered.promise;
          assert.equal(submitted.at(-1).value.outcome, approvalCase.outcome);
        }
        return '所有审批已完成';
      },
    },
  });

  const processing = bridge.accept(message('approval-start', '启动审批测试'));
  for (const [index, approvalCase] of cases.entries()) {
    await eventually(() => sent.some(({ text }) => text.includes(`tool-${index + 1}`)));
    await bridge.accept(message(`approval-reply-${index + 1}`, approvalCase.reply));
  }
  await processing;

  assert.deepEqual(submitted, cases.map(({ outcome }, index) => ({
    ok: true,
    value: {
      sessionId: 'session-one',
      approvalId: `approval-${index + 1}`,
      outcome,
    },
  })));
  assert.deepEqual(asked, [{ sessionId: 'session-one', text: '启动审批测试' }]);
  assert.equal(sent.at(-1).text, '所有审批已完成');
});

test('all four shared text channel bridges inherit the approval fast lane', async () => {
  const channels = [
    ['Slack', SlackHarnessBridge],
    ['Discord', DiscordHarnessBridge],
    ['Telegram', TelegramHarnessBridge],
    ['WhatsApp', WhatsappHarnessBridge],
  ];

  for (const [label, Bridge] of channels) {
    const fixture = stateFixture();
    const sent = [];
    const submitted = deferred();
    const asked = [];
    const bridge = new Bridge({
      state: fixture.state,
      logger: { warn() {}, error() {} },
      bot: { sendText: async (target, text) => sent.push({ target, text }) },
      harness: {
        createSession: async () => 'session-one',
        ask: async (sessionId, text, options) => {
          asked.push(text);
          await options.onInteraction(approvalInteraction({
            id: `${label.toLowerCase()}-approval`,
            sessionId,
            toolName: `${label.toLowerCase()}-tool`,
            respond: async (result) => {
              submitted.resolve(result);
              return { accepted: true };
            },
          }));
          await submitted.promise;
          return `${label} 审批完成`;
        },
      },
    });

    const processing = bridge.accept(message(`${label}-prompt`, `${label} 启动审批`));
    await eventually(() => sent.some(({ text }) => text.includes(`${label.toLowerCase()}-tool`)));
    await bridge.accept(message(`${label}-decision`, '批准'));
    await processing;

    assert.equal((await submitted.promise).value.outcome, 'allowed-once', label);
    assert.deepEqual(asked, [`${label} 启动审批`], label);
    assert.equal(sent.at(-1).text, `${label} 审批完成`, label);
  }
});

test('keeps an imprecise approval reply out of the Harness prompt queue', async () => {
  const fixture = stateFixture();
  const sent = [];
  const asked = [];
  const submitted = deferred();
  let responseCalls = 0;
  const bridge = createBridge({
    state: fixture.state,
    bot: { sendText: async (target, text) => sent.push({ target, text }) },
    harness: {
      createSession: async () => 'session-one',
      ask: async (sessionId, text, options) => {
        asked.push(text);
        await options.onInteraction(approvalInteraction({
          sessionId,
          respond: async (result) => {
            responseCalls += 1;
            submitted.resolve(result);
            return { accepted: true };
          },
        }));
        await submitted.promise;
        return '审批已继续';
      },
    },
  });

  const processing = bridge.accept(message('imprecise-start', '启动精准匹配测试'));
  await eventually(() => sent.some(({ text }) => text.includes('测试审批链路')));
  const imprecise = bridge.accept(message('imprecise-reply', '好的'));
  await imprecise;
  assert.equal(responseCalls, 0);
  assert.deepEqual(asked, ['启动精准匹配测试']);

  const approval = bridge.accept(message('precise-reply', '批准'));
  await Promise.all([processing, approval]);

  assert.deepEqual(await submitted.promise, {
    ok: true,
    value: {
      sessionId: 'session-one',
      approvalId: 'approval-one',
      outcome: 'allowed-once',
    },
  });
  assert.deepEqual(asked, ['启动精准匹配测试']);
});

test('presents parallel approvals from one conversation in fifo order without codes', async () => {
  const fixture = stateFixture();
  const sent = [];
  const submitted = [];
  const firstAnswered = deferred();
  const secondAnswered = deferred();
  const bridge = createBridge({
    state: fixture.state,
    bot: { sendText: async (target, text) => sent.push({ target, text }) },
    harness: {
      createSession: async () => 'session-one',
      ask: async (sessionId, _text, options) => {
        await Promise.all([
          options.onInteraction(approvalInteraction({
            id: 'fifo-first-id',
            sessionId,
            toolName: 'first-tool',
            reason: '第一条审批',
            respond: async (result) => {
              submitted.push(result);
              firstAnswered.resolve();
              return { accepted: true };
            },
          })),
          options.onInteraction(approvalInteraction({
            id: 'fifo-second-id',
            sessionId,
            toolName: 'second-tool',
            reason: '第二条审批',
            respond: async (result) => {
              submitted.push(result);
              secondAnswered.resolve();
              return { accepted: true };
            },
          })),
        ]);
        await Promise.all([firstAnswered.promise, secondAnswered.promise]);
        return '并行审批已完成';
      },
    },
  });

  const processing = bridge.accept(message('fifo-start', '启动并行审批'));
  await eventually(() => sent.some(({ text }) => text.includes('first-tool')));
  assert.equal(sent.some(({ text }) => text.includes('second-tool')), false);

  await bridge.accept(message('fifo-first-reply', '批准'));
  await eventually(() => sent.some(({ text }) => text.includes('second-tool')));
  await bridge.accept(message('fifo-second-reply', '拒绝'));
  await processing;

  const approvalMessages = sent.filter(({ text }) => (
    text.includes('first-tool') || text.includes('second-tool')
  ));
  assert.equal(approvalMessages.length, 2);
  assert.match(approvalMessages[0].text, /first-tool/);
  assert.match(approvalMessages[1].text, /second-tool/);
  assert.equal(approvalMessages.some(({ text }) => (
    text.includes('fifo-first-id') || text.includes('fifo-second-id')
  )), false);
  assert.deepEqual(submitted.map(({ value }) => ({
    approvalId: value.approvalId,
    outcome: value.outcome,
  })), [
    { approvalId: 'fifo-first-id', outcome: 'allowed-once' },
    { approvalId: 'fifo-second-id', outcome: 'rejected' },
  ]);
});

test('a completed approval tombstone never steals yes or no from a live question', async () => {
  const fixture = stateFixture();
  const sent = [];
  const approvalDone = deferred();
  const questionDone = deferred();
  let questionResponse;
  const asked = [];
  const bridge = createBridge({
    state: fixture.state,
    bot: { sendText: async (target, text) => sent.push({ target, text }) },
    harness: {
      createSession: async () => 'session-one',
      ask: async (sessionId, text, options) => {
        asked.push(text);
        await options.onInteraction(approvalInteraction({
          sessionId,
          respond: async () => {
            approvalDone.resolve();
            return { accepted: true };
          },
        }));
        await approvalDone.promise;
        await options.onInteraction(questionInteraction({
          id: 'question-after-approval',
          sessionId,
          questions: [{ id: 'continue', question: '是否继续？' }],
          respond: async (result) => {
            questionResponse = result;
            questionDone.resolve();
            return { accepted: true };
          },
        }));
        await questionDone.promise;
        return '审批和提问均已完成';
      },
    },
  });

  const processing = bridge.accept(message('approval-then-question', '开始组合交互'));
  await eventually(() => sent.some(({ text }) => text.includes("printf 'approval-test")));
  await bridge.accept(message('approval-before-question', '批准'));
  await eventually(() => sent.some(({ text }) => text.includes('是否继续？')));
  await bridge.accept(message('question-yes', 'yes'));
  await processing;

  assert.deepEqual(questionResponse.value.answer.answers, [{
    id: 'continue',
    selected: [],
    custom: 'yes',
  }]);
  assert.deepEqual(asked, ['开始组合交互']);
  assert.equal(sent.at(-1).text, '审批和提问均已完成');
});

test('a sibling approval waits for an in-flight question answer without deadlocking', async () => {
  const fixture = stateFixture();
  const sent = [];
  const questionResponseStarted = deferred();
  const releaseQuestionResponse = deferred();
  const questionDone = deferred();
  const approvalDone = deferred();
  const asked = [];
  const questionResponses = [];
  const approvalResponses = [];
  const bridge = createBridge({
    state: fixture.state,
    bot: { sendText: async (target, text) => sent.push({ target, text }) },
    harness: {
      createSession: async () => 'session-one',
      ask: async (sessionId, text, options) => {
        asked.push(text);
        await options.onInteraction(approvalInteraction({
          id: 'sibling-approval',
          sessionId,
          respond: async (result) => {
            approvalResponses.push(result);
            approvalDone.resolve();
            return { accepted: true };
          },
        }));
        await options.onInteraction(questionInteraction({
          id: 'sibling-question',
          sessionId,
          questions: [{ id: 'continue', question: '是否继续执行？' }],
          respond: async (result) => {
            questionResponses.push(result);
            questionResponseStarted.resolve();
            await releaseQuestionResponse.promise;
            questionDone.resolve();
            return { accepted: true };
          },
        }));
        await Promise.all([questionDone.promise, approvalDone.promise]);
        return '组合交互已完成';
      },
    },
  });

  const processing = bridge.accept(message('sibling-start', '启动并行交互'));
  await eventually(() => sent.some(({ text }) => text.includes('是否继续执行？')));
  const answeringQuestion = bridge.accept(message('sibling-question-answer', 'yes'));
  await questionResponseStarted.promise;
  const approving = bridge.accept(message('sibling-approval-answer', '批准'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(approvalResponses.length, 0);

  releaseQuestionResponse.resolve();
  await Promise.all([answeringQuestion, approving, processing]);
  assert.deepEqual(questionResponses[0].value.answer.answers, [{
    id: 'continue',
    selected: [],
    custom: 'yes',
  }]);
  assert.equal(approvalResponses[0].value.outcome, 'allowed-once');
  assert.deepEqual(asked, ['启动并行交互']);
  assert.equal(sent.at(-1).text, '组合交互已完成');
});

test('isolates pending questions by normalized conversation key', async () => {
  const fixture = stateFixture({
    'direct:chat-a': 'session-a',
    'direct:chat-b': 'session-b',
  });
  const sent = [];
  const answeredA = deferred();
  const asked = [];
  const bridge = createBridge({
    state: fixture.state,
    bot: { sendText: async (target, text) => sent.push({ target, text }) },
    harness: {
      sessionExists: async () => true,
      ask: async (sessionId, text, options) => {
        asked.push({ sessionId, text });
        if (sessionId === 'session-b') return '乙会话完成';
        await options.onInteraction(questionInteraction({
          id: 'question-a',
          sessionId,
          questions: [{ id: 'a', question: '甲会话的问题' }],
          respond: async (result) => {
            answeredA.resolve(result);
            return { accepted: true };
          },
        }));
        await answeredA.promise;
        return '甲会话完成';
      },
    },
  });

  const first = bridge.accept(message('a-start', '启动甲'));
  await eventually(() => sent.some(({ text }) => text.includes('甲会话的问题')));
  await bridge.accept(message('b-normal', '乙的普通问题', {
    senderId: 'actor-b',
    conversationId: 'chat-b',
  }));
  assert.deepEqual(asked, [
    { sessionId: 'session-a', text: '启动甲' },
    { sessionId: 'session-b', text: '乙的普通问题' },
  ]);

  await bridge.accept(message('a-answer', '甲的答案'));
  assert.deepEqual((await answeredA.promise).value.answer.answers, [
    { id: 'a', selected: [], custom: '甲的答案' },
  ]);
  await first;
});

test('a group question only accepts an addressed reply from the initiating actor', async () => {
  const fixture = stateFixture({ 'group:room': 'session-group' });
  const sent = [];
  const submitted = deferred();
  const asked = [];
  let responseCalls = 0;
  const bridge = createBridge({
    state: fixture.state,
    bot: { sendText: async (target, text) => sent.push({ target, text }) },
    harness: {
      sessionExists: async () => true,
      ask: async (sessionId, text, options) => {
        asked.push(text);
        if (text !== '甲发起交互') return '普通群消息已处理';
        await options.onInteraction(questionInteraction({
          id: 'group-question',
          sessionId,
          questions: [{ id: 'actor', question: '只能由甲回答' }],
          respond: async (result) => {
            responseCalls += 1;
            submitted.resolve(result);
            return { accepted: true };
          },
        }));
        await submitted.promise;
        return '甲的交互完成';
      },
    },
  });
  const group = { kind: 'group', conversationId: 'room' };

  const first = bridge.accept(message('group-start', '甲发起交互', { ...group }));
  await eventually(() => sent.some(({ text }) => text.includes('只能由甲回答')));
  assert.match(sent[0].text, /群聊中请 @机器人/);

  await bridge.accept(message('group-unaddressed', '没有 @ 的回答', {
    ...group,
    addressed: false,
  }));
  const intruder = bridge.accept(message('group-intruder', '乙试图代答', {
    ...group,
    senderId: 'actor-b',
  }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(responseCalls, 0);
  assert.deepEqual(asked, ['甲发起交互']);

  await bridge.accept(message('group-answer', '甲的真正答案', { ...group }));
  assert.deepEqual((await submitted.promise).value.answer.answers, [{
    id: 'actor',
    selected: [],
    custom: '甲的真正答案',
  }]);
  await Promise.all([first, intruder]);
  assert.deepEqual(asked, ['甲发起交互', '乙试图代答']);
  assert.equal(bridge.status.messagesRejected, 1);
});

test('a managed native thread can keep group isolation without asking for another mention', async () => {
  const fixture = stateFixture({ 'group:managed-thread': 'session-managed' });
  const sent = [];
  const submitted = deferred();
  const bridge = createBridge({
    state: fixture.state,
    bot: { sendText: async (target, text) => sent.push({ target, text }) },
    harness: {
      sessionExists: async () => true,
      ask: async (sessionId, _text, options) => {
        await options.onInteraction(questionInteraction({
          id: 'managed-thread-question',
          sessionId,
          questions: [{ id: 'choice', question: '请选择下一步' }],
          respond: async (result) => {
            submitted.resolve(result);
            return { accepted: true };
          },
        }));
        await submitted.promise;
        return '已继续';
      },
    },
  });
  const route = {
    kind: 'group',
    conversationId: 'managed-thread',
    addressed: true,
    requiresMention: false,
  };

  const processing = bridge.accept(message('managed-start', '开始', route));
  await eventually(() => sent.some(({ text }) => text.includes('请选择下一步')));
  assert.doesNotMatch(sent[0].text, /群聊中请 @机器人/);
  await bridge.accept(message('managed-answer', '继续', route));
  assert.deepEqual((await submitted.promise).value.answer.answers, [{
    id: 'choice',
    selected: [],
    custom: '继续',
  }]);
  await processing;
});

test('deduplicates replays and safely closes recovered questions and approvals', async () => {
  const fixture = stateFixture();
  const sent = [];
  let parallelResponse;
  let recoveredResponse;
  let approvalResponse;
  const bridge = createBridge({
    state: fixture.state,
    bot: { sendText: async (target, text) => sent.push({ target, text }) },
    harness: {
      createSession: async () => 'session-one',
      ask: async (sessionId, _text, options) => {
        const current = questionInteraction({
          id: 'replayed-question',
          sessionId,
          questions: [{ id: 'current', question: '只应显示一次' }],
        });
        await options.onInteraction(current);
        await options.onInteraction(current);
        await options.onInteraction(questionInteraction({
          id: 'parallel-question',
          sessionId,
          questions: [{ id: 'parallel', question: '不应显示的并行问题' }],
          respond: async (result) => { parallelResponse = result; },
        }));
        await options.onInteraction(approvalInteraction({
          id: 'orphan-approval',
          sessionId,
          recovered: true,
          respond: async (result) => { approvalResponse = result; },
        }));
        await options.onInteraction(questionInteraction({
          id: 'orphan-question',
          sessionId,
          recovered: true,
          questions: [{ id: 'secret', question: '旧会话中的敏感问题内容' }],
          respond: async (result) => { recoveredResponse = result; },
        }));
        await options.onInteractionResolved({
          kind: 'question',
          interactionId: 'replayed-question',
          sessionId,
          outcome: 'cancelled',
        });
        return '已继续处理';
      },
    },
  });

  await bridge.accept(message('replay', '测试交互重放'));
  assert.equal(sent.filter(({ text }) => text.includes('只应显示一次')).length, 1);
  assert.equal(sent.some(({ text }) => text.includes('旧会话中的敏感问题内容')), false);
  assert.equal(sent.some(({ text }) => text.includes('遗留的待回答问题')), true);
  assert.deepEqual(parallelResponse?.error, {
    code: 'cancelled',
    message: 'Test is already handling another user interaction.',
    details: {},
  });
  assert.deepEqual(recoveredResponse?.error, {
    code: 'cancelled',
    message: 'Test safely cancelled an interaction left by an earlier client.',
    details: {},
  });
  assert.deepEqual(approvalResponse, {
    ok: true,
    value: {
      sessionId: 'session-one',
      approvalId: 'orphan-approval',
      outcome: 'rejected',
    },
  });
  assert.equal(sent.some(({ text }) => text.includes("printf 'approval-test")), false);
});

test('keeps a failed interaction response pending so the actor can retry', async () => {
  const fixture = stateFixture();
  const sent = [];
  const reactions = [];
  const completed = deferred();
  const submittedAnswers = [];
  const bridge = createBridge({
    state: fixture.state,
    reactions: { processing: 'eyes', success: 'done', error: 'error' },
    bot: {
      addReaction: async (target, emoji) => {
        reactions.push(['add', target.id, emoji]);
        return emoji;
      },
      removeReaction: async (target, emoji) => {
        reactions.push(['remove', target.id, emoji]);
      },
      sendText: async (target, text) => sent.push({ target, text }),
    },
    harness: {
      createSession: async () => 'session-one',
      ask: async (sessionId, _text, options) => {
        await options.onInteraction(questionInteraction({
          id: 'retry-question',
          sessionId,
          respond: async (result) => {
            submittedAnswers.push(result.value.answer.answers[0].custom);
            if (submittedAnswers.length === 1) throw new Error('temporary failure');
            completed.resolve();
            return { accepted: true };
          },
        }));
        await completed.promise;
        return '重试成功';
      },
    },
  });

  const processing = bridge.accept(message('retry-start', '启动可重试交互'));
  await eventually(() => sent.some(({ text }) => text.includes('请回答')));
  await bridge.accept(message('retry-first', '第一次答案', {
    reactionTarget: { id: 'source-retry-first' },
  }));
  await eventually(() => reactions.length === 3);
  assert.equal(sent.some(({ text }) => text.includes('回答提交失败')), true);
  await bridge.accept(message('retry-second', '重试后的答案'));
  await processing;

  assert.deepEqual(submittedAnswers, ['第一次答案', '重试后的答案']);
  assert.equal(sent.at(-1).text, '重试成功');
  assert.deepEqual(reactions, [
    ['add', 'source-retry-first', 'eyes'],
    ['remove', 'source-retry-first', 'eyes'],
    ['add', 'source-retry-first', 'error'],
  ]);
});

test('notifies the actor when an in-flight response resolves elsewhere before rejection', async () => {
  const fixture = stateFixture();
  const sent = [];
  const responseStarted = deferred();
  const asked = [];
  const bridge = createBridge({
    state: fixture.state,
    bot: { sendText: async (target, text) => sent.push({ target, text }) },
    harness: {
      createSession: async () => 'session-one',
      ask: async (sessionId, text, options) => {
        asked.push(text);
        await options.onInteraction(questionInteraction({
          id: 'response-resolved-race',
          sessionId,
          respond: async () => {
            options.onInteractionResolved({
              kind: 'question',
              interactionId: 'response-resolved-race',
              sessionId,
              outcome: 'answered',
            });
            responseStarted.resolve();
            const error = new Error('interaction no longer pending');
            error.code = 'interaction-not-pending';
            throw error;
          },
        }));
        await responseStarted.promise;
        return '原会话已结束';
      },
    },
  });

  const processing = bridge.accept(message('response-race-start', '启动提交竞态'));
  await eventually(() => sent.some(({ text }) => text.includes('请回答')));
  await bridge.accept(message('response-race-answer', '已经收到的答案'));
  await processing;

  assert.deepEqual(asked, ['启动提交竞态']);
  assert.equal(sent.some(({ text }) => text.includes('已在其他客户端处理')), true);
});

test('discards a claimed answer when the interaction resolves during message recording', async () => {
  const fixture = stateFixture({ 'direct:chat-a': 'session-one' });
  const originalMarkSeen = fixture.state.markSeen;
  const answerMarkStarted = deferred();
  const releaseAnswerMark = deferred();
  fixture.state.markSeen = async (messageId) => {
    if (messageId === 'racing-answer') {
      answerMarkStarted.resolve();
      await releaseAnswerMark.promise;
    }
    await originalMarkSeen(messageId);
  };
  const sent = [];
  const asked = [];
  const externallyResolved = deferred();
  let resolveInteraction;
  const bridge = createBridge({
    state: fixture.state,
    bot: { sendText: async (target, text) => sent.push({ target, text }) },
    harness: {
      sessionExists: async () => true,
      ask: async (sessionId, text, options) => {
        asked.push(text);
        if (text === '后来的普通问题') return '后来问题的回答';
        await options.onInteraction(questionInteraction({
          id: 'resolved-race-question',
          sessionId,
        }));
        resolveInteraction = () => {
          options.onInteractionResolved({
            kind: 'question',
            interactionId: 'resolved-race-question',
            sessionId,
            outcome: 'answered',
          });
          externallyResolved.resolve();
        };
        await externallyResolved.promise;
        return '第一轮已由其他客户端完成';
      },
    },
  });

  const processing = bridge.accept(message('race-start', '启动外部解决竞态'));
  await eventually(() => typeof resolveInteraction === 'function');
  const answer = bridge.accept(message('racing-answer', '原本的问题答案'));
  await answerMarkStarted.promise;
  resolveInteraction();
  releaseAnswerMark.resolve();
  await Promise.all([processing, answer]);
  await bridge.accept(message('later-prompt', '后来的普通问题'));

  assert.deepEqual(asked, ['启动外部解决竞态', '后来的普通问题']);
  assert.equal(asked.includes('原本的问题答案'), false);
  assert.equal(sent.some(({ text }) => text.includes('已在其他客户端处理')), true);
});

test('accepts a first answer received while its question presentation is still in flight', async () => {
  const fixture = stateFixture();
  const presentationStarted = deferred();
  const releasePresentation = deferred();
  const submitted = deferred();
  const sent = [];
  const asked = [];
  let questionPresentations = 0;
  const bridge = createBridge({
    state: fixture.state,
    bot: {
      sendText: async (target, text) => {
        sent.push({ target, text });
        if (text.includes('发送仍在进行的问题')) {
          questionPresentations += 1;
          presentationStarted.resolve();
          await releasePresentation.promise;
        }
      },
    },
    harness: {
      createSession: async () => 'session-one',
      ask: async (sessionId, text, options) => {
        asked.push(text);
        await options.onInteraction(questionInteraction({
          id: 'first-presentation-race',
          sessionId,
          questions: [{ id: 'first', question: '发送仍在进行的问题' }],
          respond: async (result) => {
            submitted.resolve(result);
            return { accepted: true };
          },
        }));
        await submitted.promise;
        return '首问已回答';
      },
    },
  });

  const processing = bridge.accept(message('presentation-start', '启动首问竞态'));
  await presentationStarted.promise;
  const answer = bridge.accept(message('presentation-answer', '首问答案'));
  releasePresentation.resolve();
  await Promise.all([processing, answer]);

  assert.deepEqual((await submitted.promise).value.answer.answers, [{
    id: 'first',
    selected: [],
    custom: '首问答案',
  }]);
  assert.deepEqual(asked, ['启动首问竞态']);
  assert.equal(questionPresentations, 1);
  assert.equal(sent.at(-1).text, '首问已回答');
});

test('discards an answer already received when a later question resolves during presentation', async () => {
  const fixture = stateFixture();
  const secondPresentationStarted = deferred();
  const releaseSecondPresentation = deferred();
  const externallyResolved = deferred();
  const sent = [];
  const asked = [];
  let resolveInteraction;
  const bridge = createBridge({
    state: fixture.state,
    bot: {
      sendText: async (target, text) => {
        sent.push({ target, text });
        if (text.includes('仍在发送的第二问')) {
          secondPresentationStarted.resolve();
          await releaseSecondPresentation.promise;
        }
      },
    },
    harness: {
      createSession: async () => 'session-one',
      ask: async (sessionId, text, options) => {
        asked.push(text);
        if (text !== '启动第二问竞态') return '不应把第二问答案作为新 prompt';
        await options.onInteraction(questionInteraction({
          id: 'second-presentation-race',
          sessionId,
          questions: [
            { id: 'first', question: '第一问' },
            { id: 'second', question: '仍在发送的第二问' },
          ],
        }));
        resolveInteraction = () => {
          options.onInteractionResolved({
            kind: 'question',
            interactionId: 'second-presentation-race',
            sessionId,
            outcome: 'answered',
          });
          externallyResolved.resolve();
        };
        await externallyResolved.promise;
        return '已由其他客户端完成';
      },
    },
  });

  const processing = bridge.accept(message('second-race-start', '启动第二问竞态'));
  await eventually(() => typeof resolveInteraction === 'function');
  const firstAnswer = bridge.accept(message('second-race-first', '第一问答案'));
  await secondPresentationStarted.promise;
  const secondAnswer = bridge.accept(message('second-race-second', '第二问已收到的答案'));
  resolveInteraction();
  releaseSecondPresentation.resolve();
  await Promise.all([processing, firstAnswer, secondAnswer]);

  assert.deepEqual(asked, ['启动第二问竞态']);
  assert.equal(asked.includes('第二问已收到的答案'), false);
  assert.equal(sent.some(({ text }) => text.includes('已在其他客户端处理')), true);
});

test('passes the runtime signal to Harness and safely cancels a pending question on abort', async () => {
  const controller = new AbortController();
  const fixture = stateFixture({ 'direct:chat-a': 'stale-session' });
  const sent = [];
  const cancelled = deferred();
  let existsSignal;
  let createSignal;
  let askSignal;
  const bridge = createBridge({
    state: fixture.state,
    signal: controller.signal,
    bot: { sendText: async (target, text) => sent.push({ target, text }) },
    harness: {
      sessionExists: async (_sessionId, options) => {
        existsSignal = options?.signal;
        return false;
      },
      createSession: async (options) => {
        createSignal = options?.signal;
        return 'session-one';
      },
      ask: async (sessionId, _text, options) => {
        askSignal = options.signal;
        await options.onInteraction(questionInteraction({
          id: 'abort-question',
          sessionId,
          respond: async (result) => {
            cancelled.resolve(result);
            return { accepted: true };
          },
        }));
        await new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
        });
      },
    },
  });

  const processing = bridge.accept(message('abort-start', '启动后停止'));
  await eventually(() => sent.some(({ text }) => text.includes('请回答')));
  controller.abort(new DOMException('runtime stopped', 'AbortError'));
  await processing;

  assert.equal(existsSignal, controller.signal);
  assert.equal(createSignal, controller.signal);
  assert.equal(askSignal, controller.signal);
  assert.deepEqual(await cancelled.promise, {
    ok: false,
    error: {
      code: 'cancelled',
      message: 'The Test interaction ended before the user answered.',
      details: {},
    },
  });
});

test('shared bridge keepalives a short-lived draft stream and stops the timer on completion', async () => {
  const fixture = stateFixture();
  const refreshes = [];
  const typings = [];
  let releaseAsk;
  const gate = new Promise((resolve) => { releaseAsk = resolve; });
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'test', label: 'Test' },
    bot: {
      sendText: async () => 'done',
      sendTyping: async () => { typings.push(Date.now()); },
      openDeliveryStream: async () => ({
        keepalive: true,
        refresh: async () => { refreshes.push(Date.now()); },
        update: async () => undefined,
        finish: async () => undefined,
        fail: async () => undefined,
      }),
    },
    harness: {
      createSession: async () => 'session-keepalive',
      ask: async () => {
        await gate;
        return 'long answer';
      },
    },
    state: fixture.state,
    logger: { warn() {}, error() {} },
    keepaliveIntervalMs: 15,
  });

  const accepted = bridge.accept(message('keepalive-draft', '跑一个长任务'));
  await eventually(() => refreshes.length >= 2, 2_000);
  assert.ok(refreshes.length >= 2, 'heartbeat refreshes the draft repeatedly during the long turn');
  assert.ok(typings.length >= 1, 'heartbeat also refreshes the typing indicator');
  releaseAsk();
  await accepted;

  const stoppedAt = refreshes.length;
  const typingAt = typings.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(refreshes.length, stoppedAt, 'no refresh after the turn ends');
  assert.equal(typings.length, typingAt, 'no typing after the turn ends');
});

test('shared bridge clears the keepalive timer when a long turn fails', async () => {
  const fixture = stateFixture();
  const refreshes = [];
  let releaseAsk;
  const gate = new Promise((resolve) => { releaseAsk = resolve; });
  const failure = new Error('private provider failure');
  failure.code = 'harness-turn-failed';
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'test', label: 'Test' },
    bot: {
      sendText: async () => 'done',
      openDeliveryStream: async () => ({
        keepalive: true,
        refresh: async () => { refreshes.push(Date.now()); },
        update: async () => undefined,
        finish: async () => undefined,
        fail: async () => undefined,
      }),
    },
    harness: {
      createSession: async () => 'session-keepalive-fail',
      ask: async () => {
        await gate;
        throw failure;
      },
    },
    state: fixture.state,
    logger: { warn() {}, error() {} },
    keepaliveIntervalMs: 15,
  });

  const accepted = bridge.accept(message('keepalive-fail', '会失败的長任务'));
  await eventually(() => refreshes.length >= 2, 2_000);
  releaseAsk();
  await accepted;

  const stoppedAt = refreshes.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(refreshes.length, stoppedAt, 'no refresh leaks after a failed turn');
});

test('shared bridge never starts a keepalive timer for a non-keepalive stream', async () => {
  const fixture = stateFixture();
  const refreshes = [];
  const typings = [];
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'test', label: 'Test' },
    bot: {
      sendText: async () => 'done',
      sendTyping: async () => { typings.push(Date.now()); },
      openDeliveryStream: async () => ({
        keepalive: false,
        refresh: async () => { refreshes.push(Date.now()); },
        update: async () => undefined,
        finish: async () => undefined,
      }),
    },
    harness: {
      createSession: async () => 'session-non-keepalive',
      ask: async () => 'plain answer',
    },
    state: fixture.state,
    logger: { warn() {}, error() {} },
    keepaliveIntervalMs: 10,
  });

  await bridge.accept(message('non-keepalive', '普通任务'));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(refreshes.length, 0, 'non-keepalive carriers are never heartbeat-refreshed');
  assert.equal(typings.length, 1, 'only the initial typing indicator is sent');
});

test('Telegram question clears the draft after pending writes and keeps replies enabled until the final answer', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fixture = stateFixture();
  const refreshGate = deferred();
  const answered = deferred();
  const drafts = [];
  const messages = [];
  const finals = [];
  let options;
  let draftActive = false;
  const target = { chatId: 42, chatType: 'private' };
  const bot = new TelegramBotClient({
    api: {
      sendChatAction: async () => true,
      sendRichMessageDraft: async (payload) => {
        drafts.push(payload);
        if (drafts.length === 2) await refreshGate.promise;
        draftActive = true;
        return true;
      },
      sendMessage: async (payload) => {
        // Telegram clears a live draft when a regular message arrives.
        draftActive = false;
        messages.push(payload);
        return { message_id: 199 };
      },
      sendRichMessage: async (payload) => {
        finals.push(payload);
        return { message_id: 200 };
      },
    },
  });
  const bridge = new TelegramHarnessBridge({
    bot,
    state: fixture.state,
    harness: {
      createSession: async () => 'session-one',
      ask: async (_sessionId, _text, askOptions) => {
        options = askOptions;
        await answered.promise;
        return 'ISSUE199_DONE Green';
      },
    },
  });
  const processing = bridge.accept(message('draft-question', 'Choose a color', { replyTarget: target }));
  t.after(async () => {
    refreshGate.resolve();
    answered.resolve();
    await processing;
  });
  await eventually(() => options !== undefined);
  t.mock.timers.tick(4_000);
  await eventually(() => drafts.length === 2);
  const presentation = options.onInteraction(questionInteraction({
    questions: [{ id: 'color', question: 'Choose a color', options: [{ label: 'Blue' }, { label: 'Green' }] }],
    respond: async (response) => {
      if (!response.ok) return { accepted: true };
      assert.deepEqual(response.value.answer.answers, [{ id: 'color', selected: ['Green'] }]);
      answered.resolve();
      return { accepted: true };
    },
  }));
  const lateProgress = options.onUpdate({ type: 'tool', name: 'ask_user_question' });
  await new Promise(setImmediate);
  assert.equal(messages.length, 0, 'the question must wait for an in-flight draft to finish');
  refreshGate.resolve();
  await Promise.all([presentation, lateProgress]);
  assert.equal(messages.length, 1);
  assert.equal(draftActive, false, 'a late draft must not replace the question and block replies');
  t.mock.timers.tick(40_000);
  await options.onUpdate({ type: 'text', text: 'Waiting for your choice' });
  assert.equal(drafts.length, 2, 'neither heartbeat nor progress may restart the draft');
  await bridge.accept(message('draft-answer', '2', { replyTarget: target }));
  await processing;
  assert.equal(finals.length, 1);
  assert.equal(finals[0].richMessage.markdown, 'ISSUE199_DONE Green');
});

test('slow Telegram heartbeat does not queue redundant drafts ahead of the final answer', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fixture = stateFixture();
  const askGate = deferred();
  const refreshGate = deferred();
  const drafts = [];
  const finals = [];
  let asked = false;
  const bot = new TelegramBotClient({
    api: {
      // A failed typing request must not release the still-pending draft guard.
      sendChatAction: async () => { throw new Error('typing unavailable'); },
      sendRichMessageDraft: async (payload) => {
        drafts.push(payload);
        if (drafts.length === 2) await refreshGate.promise;
        return true;
      },
      sendRichMessage: async (payload) => {
        finals.push(payload);
        return { message_id: 175 };
      },
    },
    logger: { warn() {} },
  });
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: {
      createSession: async () => 'session-slow-heartbeat',
      ask: async () => { asked = true; return askGate.promise; },
    },
    state: fixture.state,
    logger: { warn() {}, error() {} },
  });
  const accepted = bridge.accept(message('slow-heartbeat', 'long task', {
    replyTarget: { chatId: 42, chatType: 'private' },
  }));
  t.after(async () => {
    refreshGate.resolve();
    askGate.resolve('final answer');
    await accepted;
  });
  await eventually(() => asked);
  t.mock.timers.tick(4_000);
  await eventually(() => drafts.length === 2);
  t.mock.timers.tick(40_000);
  await new Promise(setImmediate);
  askGate.resolve('final answer');
  await new Promise(setImmediate);
  assert.equal(finals.length, 0, 'the final frame still waits for the in-flight draft');
  refreshGate.resolve();
  await accepted;
  assert.equal(drafts.length, 2, 'only the initial draft and one heartbeat were sent');
  assert.equal(finals.length, 1);
  assert.equal(finals[0].richMessage.markdown, 'final answer');
  t.mock.timers.tick(40_000);
  await new Promise(setImmediate);
  assert.equal(drafts.length, 2, 'no heartbeat after final delivery');
});

for (const outcome of ['success', 'failure']) {
  test(`heartbeat recovers after rejection and stops before ${outcome} delivery completes`, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const fixture = stateFixture();
    const askGate = deferred();
    const deliveryGate = deferred();
    let asked = false;
    let finalizing = false;
    let refreshes = 0;
    let typings = 0;
    const finalize = async () => {
      finalizing = true;
      await deliveryGate.promise;
      return { deliveryOutcome: 'sent', providerMessageIds: ['175'] };
    };
    const bridge = new TextHarnessBridge({
      descriptor: { key: 'test', label: 'Test' },
      bot: {
        sendText: async () => 'done',
        sendTyping: async () => { typings += 1; },
        openDeliveryStream: async () => ({
          keepalive: true,
          refresh: async () => {
            refreshes += 1;
            if (refreshes === 1) throw new Error('temporary refresh failure');
          },
          update: async () => undefined,
          finish: finalize,
          fail: finalize,
        }),
      },
      harness: {
        createSession: async () => `session-heartbeat-${outcome}`,
        ask: async () => { asked = true; return askGate.promise; },
      },
      state: fixture.state,
      logger: { warn() {}, error() {} },
    });
    const accepted = bridge.accept(message(`heartbeat-${outcome}`, 'long task'));
    t.after(async () => {
      askGate.resolve('answer');
      deliveryGate.resolve();
      await accepted;
    });
    await eventually(() => asked);
    t.mock.timers.tick(4_000);
    await new Promise(setImmediate);
    t.mock.timers.tick(4_000);
    await new Promise(setImmediate);
    assert.equal(refreshes, 2, 'a rejected heartbeat does not disable later refreshes');
    if (outcome === 'success') askGate.resolve('answer');
    else askGate.reject(new Error('turn failed'));
    await eventually(() => finalizing);
    const typingAt = typings;
    t.mock.timers.tick(40_000);
    await new Promise(setImmediate);
    assert.equal(refreshes, 2, 'no new refresh while final delivery is pending');
    assert.equal(typings, typingAt, 'no typing while final delivery is pending');
    deliveryGate.resolve();
    await accepted;
  });
}
