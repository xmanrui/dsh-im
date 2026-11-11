import assert from 'node:assert/strict';
import test from 'node:test';
import { FeishuHarnessBridge } from '../src/channels/feishu/bridge.mjs';
import { QqHarnessBridge } from '../src/channels/qq/qq-bridge.mjs';
import { directAccessPolicy } from './channels/access-policy-fixture.mjs';

function fixture(channel, canExecuteCommands = true) {
  const seen = new Set();
  const replies = [];
  const commands = [];
  const state = {
    hasSeen: (id) => seen.has(id), markSeen: async (id) => seen.add(id),
    sessionFor: () => 'permission-session', setSession: async () => {},
  };
  let announceStarted;
  let finishTurn;
  const started = new Promise((resolve) => { announceStarted = resolve; });
  const turn = new Promise((resolve) => { finishTurn = resolve; });
  const session = {
    sessionExists: async () => true,
    permissions: async () => ({ currentValue: 'workspace-write', options: [
      { value: 'workspace-write' }, { value: 'danger-full-access' },
    ] }),
    executeCommand: async (line) => {
      commands.push(line);
      return { result: { kind: 'success' } };
    },
    ask: async () => { announceStarted(); return turn; },
  };
  const harness = {
    workspaceSession: () => session,
    sessionExists: async () => true,
    ask: session.ask,
  };
  const accessPolicy = directAccessPolicy({ users: [{ id: 'owner', canExecuteCommands }] });
  let sequence = 0;
  let bridge;
  let event;
  if (channel === 'feishu') {
    bridge = new FeishuHarnessBridge({
      client: { im: { v1: { message: { create: async ({ data }) => {
        replies.push(JSON.parse(data.content).text);
        return { code: 0, data: { message_id: `reply-${++sequence}` } };
      } } } } },
      channel: {}, harness, state, allowedSenderOpenIds: new Set(['owner']), accessPolicy,
      status: { messagesReceived: 0, messagesReplied: 0, messagesRejected: 0 },
    });
    event = (id, content, media) => ({
      sender: { sender_type: 'user', sender_id: { open_id: 'owner' } },
      message: { chat_type: 'p2p', chat_id: 'chat', message_id: id,
        message_type: media ? 'post' : 'text', content: JSON.stringify(media
          ? { title: '', content: [[{ tag: 'text', text: content }, { tag: 'img', image_key: 'img' }]] }
          : { text: content }),
      },
    });
  } else {
    bridge = new QqHarnessBridge({
      bot: { sendText: async (_target, text) => replies.push(text) },
      ownerUserOpenid: 'owner', harness, state, accessPolicy,
    });
    event = (id, content, media) => ({
      kind: 'c2c', rawEventType: 'C2C_MESSAGE_CREATE', senderId: 'owner',
      messageId: id, content,
      replyTarget: { scope: 'c2c', targetId: 'owner', msgId: id },
      ...(media ? { attachments: [{ content_type: 'image/png', url: 'https://example.com/a.png' }] } : {}),
    });
  }
  return { bridge, event, replies, commands, started, finishTurn };
}

for (const channel of ['feishu', 'qq']) {
  test(`${channel} dispatches numbered permission commands locally and deduplicates them`, async () => {
    const f = fixture(channel);
    await f.bridge.accept(f.event('list', '/permissionlist'));
    assert.match(f.replies.at(-1), /2\. danger-full-access/);
    await f.bridge.accept(f.event('switch', '/permission 2'));
    await f.bridge.accept(f.event('switch', '/permission 2'));
    assert.deepEqual(f.commands, ['/permission danger-full-access']);
    assert.match(f.replies.at(-1), /已切换为：danger-full-access/);
  });

  test(`${channel} gates permission queries and writes through command access`, async () => {
    const f = fixture(channel, false);
    for (const [index, text] of ['/permissionlist', '/permission', '/permission danger-full-access'].entries()) {
      await f.bridge.accept(f.event(`denied-${index}`, text));
      assert.match(f.replies.at(-1), /没有执行该命令的权限/);
    }
    assert.deepEqual(f.commands, []);
  });

  test(`${channel} rejects permission commands with media locally`, async () => {
    const f = fixture(channel);
    await f.bridge.accept(f.event('media', '/permission danger-full-access', true));
    assert.match(f.replies.at(-1), /仅支持纯文字/);
    assert.deepEqual(f.commands, []);
  });

  test(`${channel} permission commands finish while a model turn remains pending`, async () => {
    const f = fixture(channel);
    const pending = f.bridge.accept(f.event('prompt', 'hello'));
    try {
      await Promise.race([f.started, new Promise((_, reject) => setTimeout(() => reject(new Error('Turn did not start')), 2000).unref())]);
      await f.bridge.accept(f.event('running-list', '/permissionlist'));
      await f.bridge.accept(f.event('running-set', '/permission 2'));
      assert.deepEqual(f.commands, ['/permission danger-full-access']);
    } finally {
      f.finishTurn('done');
      await pending;
    }
  });
}
