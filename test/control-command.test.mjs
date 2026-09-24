import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isControlCommand,
  runControlCommand,
} from '../src/channels/shared/control-command.mjs';
import { HarnessApprovalQueue } from '../src/channels/shared/harness-approval.mjs';
import { captureContextEnhancementSource } from '../src/channels/shared/context-enhancement.mjs';

function fixture({ sessionId = 'session-one', stopped = true, steered = true } = {}) {
  const calls = [];
  const state = {
    sessionFor(key) {
      calls.push(['sessionFor', key]);
      return sessionId;
    },
  };
  const harness = {
    workspaceSession(id) {
      calls.push(['workspaceSession', id]);
      return {
        async stopActiveTurn(control, options) {
          calls.push(['stopActiveTurn', id, control, options]);
          return stopped;
        },
        async steerActiveTurn(text, control, options) {
          calls.push(['steerActiveTurn', id, text, control, options]);
          return steered;
        },
      };
    },
  };
  return { calls, harness, state };
}

test('isControlCommand reserves valid and malformed control command forms', () => {
  for (const value of [
    '/stop', ' /STOP ', '/stop now', '/steer', '/StEeR do this', '/steer line one\nline two',
    '/version', ' /VERSION ', '/version now',
  ]) {
    assert.equal(isControlCommand(value), true, value);
  }
  for (const value of [null, '', 'stop', '/stopping', '/steering', '/versions', 'hello /stop']) {
    assert.equal(isControlCommand(value), false, String(value));
  }
});

test('/version returns the package version without touching Harness or Session state', async () => {
  const { calls, harness, state } = fixture();
  const { version } = await import('../package.json', { with: { type: 'json' } })
    .then((module) => module.default);

  assert.deepEqual(
    await runControlCommand('/VERSION', harness, state, 'direct:one'),
    { message: `dsh-im v${version}` },
  );
  assert.match(
    (await runControlCommand('/version details', harness, state, 'direct:one')).message,
    /用法/,
  );
  assert.equal(calls.length, 0);
});

test('/stop is exact, text-only, and never creates a Session', async () => {
  const { calls, harness, state } = fixture();
  assert.match((await runControlCommand('/stop later', harness, state, 'direct:one')).message, /用法/);
  assert.match((await runControlCommand('/stop', harness, state, 'direct:one', {
    hasImages: true,
  })).message, /纯文字/);
  assert.equal(calls.length, 0);
});

test('/stop controls only the bound active turn and marks accepted cancellation', async () => {
  const active = fixture();
  const signal = new AbortController().signal;
  const owner = {};
  const control = { owner, key: 'direct:one' };
  const result = await runControlCommand(
    '/STOP',
    active.harness,
    active.state,
    'direct:one',
    { signal, pendingInteraction: true, control },
  );
  assert.deepEqual(result, { message: '已请求停止当前任务。', stopped: true });
  assert.deepEqual(active.calls, [
    ['sessionFor', 'direct:one'],
    ['workspaceSession', 'session-one'],
    ['stopActiveTurn', 'session-one', control, { signal }],
  ]);

  const inactive = fixture({ stopped: false });
  const missing = await runControlCommand(
    '/stop', inactive.harness, inactive.state, 'direct:one', { control },
  );
  assert.match(missing.message, /没有正在运行/);
  assert.equal(missing.stopped, undefined);
});

test('/stop and /steer return friendly no-session messages without creating one', async () => {
  const { harness, state, calls } = fixture({ sessionId: null });
  assert.match(
    (await runControlCommand('/stop', harness, state, 'direct:one')).message,
    /没有正在运行/,
  );
  assert.match(
    (await runControlCommand('/steer 补充', harness, state, 'direct:one')).message,
    /没有绑定会话/,
  );
  assert.equal(calls.some(([method]) => method === 'workspaceSession'), false);
});

test('/steer requires text, preserves multiple lines, and rejects images', async () => {
  const { harness, state, calls } = fixture();
  assert.match((await runControlCommand('/steer', harness, state, 'direct:one')).message, /用法/);
  assert.match((await runControlCommand('/steer   ', harness, state, 'direct:one')).message, /用法/);
  assert.match((await runControlCommand('/steer text', harness, state, 'direct:one', {
    hasImages: true,
  })).message, /纯文字/);
  assert.equal(calls.length, 0);

  const control = { owner: {}, key: 'direct:one' };
  const result = await runControlCommand(
    '/steer first line\nsecond line',
    harness,
    state,
    'direct:one',
    { control },
  );
  assert.match(result.message, /已提交/);
  assert.deepEqual(calls.find(([method]) => method === 'steerActiveTurn'), [
    'steerActiveTurn',
    'session-one',
    'first line\nsecond line',
    control,
    {},
  ]);
});

test('/steer never reaches Harness while an interaction is pending', async () => {
  const { harness, state, calls } = fixture();
  const result = await runControlCommand('/steer continue', harness, state, 'direct:one', {
    pendingInteraction: true,
    control: { owner: {}, key: 'direct:one' },
  });
  assert.match(result.message, /等待你的回答或审批/);
  assert.equal(calls.length, 0);
});

test('/steer reports a lost active-turn race instead of starting new work', async () => {
  const { harness, state, calls } = fixture({ steered: false });
  const result = await runControlCommand('/steer continue', harness, state, 'direct:one', {
    control: { owner: {}, key: 'direct:one' },
  });
  assert.match(result.message, /没有正在运行/);
  assert.equal(calls.filter(([method]) => method === 'steerActiveTurn').length, 1);
});

test('HarnessApprovalQueue exposes whether a route has a live approval', async () => {
  const queue = new HarnessApprovalQueue({ logger: { warn() {}, error() {} } });
  const replies = [];
  const interaction = {
    kind: 'approval',
    rpcId: 'approval-rpc',
    sessionId: 'session-one',
    toolCall: { callId: 'call-one', name: 'bash', arguments: '{}' },
    payload: {
      type: 'approval/requested',
      sessionId: 'session-one',
      approvalId: 'approval-one',
      toolName: 'bash',
      callId: 'call-one',
    },
    async respond() {},
  };
  await queue.handleRequested(interaction, {
    key: 'direct:one',
    actor: 'user-one',
    send: async (text) => replies.push(text),
  });
  assert.equal(queue.hasPending('direct:one'), true);
  assert.equal(queue.hasPending('direct:other'), false);
  await queue.closeRoute('direct:one');
  assert.equal(queue.hasPending('direct:one'), false);
});

test('/steer carries the source block of whoever issued it', async () => {
  const { harness, state, calls } = fixture();
  const enhancement = captureContextEnhancementSource({
    botId: 'bot_one',
    getSettings: () => ({
      group: { enabled: true, fields: ['channel', 'senderId'], guidance: '' },
      direct: { enabled: false, fields: [], guidance: '' },
    }),
  }, 'group', () => ({ channel: 'weixin', senderId: 'wx-1' }));
  assert.notEqual(enhancement, null);

  const control = { owner: {}, key: 'group:g1' };
  const result = await runControlCommand('/steer 别删这个文件', harness, state, 'group:g1', {
    control,
    enhancement,
  });
  assert.match(result.message, /已提交/);
  assert.deepEqual(calls.find(([method]) => method === 'steerActiveTurn'), [
    'steerActiveTurn',
    'session-one',
    '<dsh_im_source>{"channel":"weixin","senderId":"wx-1"}</dsh_im_source>\n\n别删这个文件',
    control,
    {},
  ]);
});

test('/steer without an enhancement still sends the bare instruction', async () => {
  const { harness, state, calls } = fixture();
  await runControlCommand('/steer 原样发送', harness, state, 'direct:one', {
    control: { owner: {}, key: 'direct:one' },
  });
  assert.equal(calls.find(([method]) => method === 'steerActiveTurn')[2], '原样发送');
});

test('a scope that is off captures no enhancement for a command', () => {
  assert.equal(captureContextEnhancementSource({
    botId: 'bot_one',
    getSettings: () => ({
      group: { enabled: false, fields: [], guidance: '' },
      direct: { enabled: false, fields: [], guidance: '' },
    }),
  }, 'group', () => ({ channel: 'weixin' })), null);
});
