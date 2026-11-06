import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildList, installChannelListRpc } from '../plugin-src/host/channel-list-rpc.mjs';

async function temporaryHome(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-im-channel-list-'));
  t.after(async () => {
    assert.ok(root.startsWith(join(tmpdir(), 'dsh-im-channel-list-')));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function putState(root, channel, botId, value, container = 'bots') {
  const dir = join(root, 'integrations', `dsh-${channel}`, container, botId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.json'), typeof value === 'string' ? value : JSON.stringify(value));
}

test('buildList reads standard bot, Weixin account, and configured Feishu legacy state', async t => {
  const root = await temporaryHome(t);
  await putState(root, 'matrix', 'matrix-bot', {
    sessions: { 'group:room:!room:example.org': 'session-matrix' },
  });
  await putState(root, 'telegram', 'telegram-a', {
    sessions: { z_chat: 'session-z', a_chat: 'session-a' },
  });
  await putState(root, 'telegram', 'telegram-empty', { sessions: {} });
  await putState(root, 'wecom-app', 'wecom-a', {
    sessions: { 'group:room:42': 'session-wecom' },
  });
  await putState(root, 'weixin', 'wx-account', {
    sessions: { 'direct:wx-user': 'session-weixin' },
  }, 'accounts');
  await putState(root, 'feishu', 'feishu-modern', {
    sessions: { 'group:modern': 'session-feishu-modern' },
  });
  await putState(root, 'feishu', 'feishu-legacy', {
    sessions: { decoy: 'session-feishu-decoy' },
  });
  const feishuRoot = join(root, 'integrations', 'dsh-feishu');
  await mkdir(feishuRoot, { recursive: true });
  await writeFile(join(feishuRoot, 'config.json'), JSON.stringify({
    version: 2,
    bots: [
      { id: 'feishu-modern', appId: 'cli-modern', secretRef: 'FEISHU_MODERN_SECRET', ownerOpenIds: ['ou-modern'] },
      { id: 'feishu-legacy', appId: 'cli-legacy', secretRef: 'DSH_FEISHU_APP_SECRET', ownerOpenIds: ['ou-legacy'] },
    ],
  }));
  await writeFile(join(feishuRoot, 'state.json'), JSON.stringify({
    sessions: { 'group:legacy': 'session-feishu-legacy' },
  }));
  await putState(root, 'discord', 'broken-bot', '{not-json');

  // A legacy/top-level JSON lookalike must not be mistaken for a bot binding.
  await writeFile(join(root, 'integrations', 'dsh-telegram', 'decoy.json'), JSON.stringify({
    sessions: { decoy: 'must-not-appear' },
  }));

  const result = await buildList({ dshHome: root });
  assert.deepEqual(result.channels.map(group => group.channel), ['feishu', 'matrix', 'telegram', 'wecom-app', 'weixin']);
  assert.equal(result.scannedFiles, 7);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /dsh-discord\/broken-bot/);

  const feishu = result.channels[0];
  assert.deepEqual(feishu.sessions, [
    { key: 'group:legacy', sessionId: 'session-feishu-legacy', botId: 'feishu-legacy' },
    { key: 'group:modern', sessionId: 'session-feishu-modern', botId: 'feishu-modern' },
  ]);

  const matrix = result.channels[1];
  assert.deepEqual(matrix.sessions, [{
    key: 'group:room:!room:example.org', sessionId: 'session-matrix', botId: 'matrix-bot',
  }]);

  const telegram = result.channels[2];
  assert.deepEqual(telegram.sessions.map(row => row.key), ['a_chat', 'z_chat']);
  assert.ok(telegram.sessions.every(row => row.botId === 'telegram-a'));
  assert.ok(!telegram.sessions.some(row => row.sessionId === 'must-not-appear'));

  const wecom = result.channels[3];
  assert.equal(wecom.sessions[0].botId, 'wecom-a');
  assert.equal(wecom.sessions[0].sessionId, 'session-wecom');

  const weixin = result.channels[4];
  assert.deepEqual(weixin.sessions, [
    { key: 'direct:wx-user', sessionId: 'session-weixin', botId: 'wx-account' },
  ]);
});

test('buildList returns an empty directory when integrations do not exist', async t => {
  const root = await temporaryHome(t);
  assert.deepEqual(await buildList({ dshHome: root }), { channels: [], scannedFiles: 0, warnings: [] });
});

test('buildList derives the Feishu v1 legacy identity without migrating its config', async t => {
  const root = await temporaryHome(t);
  const integrationRoot = join(root, 'integrations', 'dsh-feishu');
  await mkdir(integrationRoot, { recursive: true });
  const configText = JSON.stringify({ appId: 'cli_v1_legacy', ownerOpenId: 'ou_owner' });
  await writeFile(join(integrationRoot, 'config.json'), configText);
  await writeFile(join(integrationRoot, 'state.json'), JSON.stringify({
    sessions: { 'group:legacy-v1': 'session-feishu-v1' },
  }));
  const result = await buildList({ dshHome: root });
  const botId = `bot_${createHash('sha256').update('cli_v1_legacy').digest('hex').slice(0, 24)}`;
  assert.deepEqual(result.channels, [{ channel: 'feishu', sessions: [
    { key: 'group:legacy-v1', sessionId: 'session-feishu-v1', botId },
  ] }]);
  assert.equal(await readFile(join(integrationRoot, 'config.json'), 'utf8'), configText);
});

test('buildList trims Feishu v2 legacy identity fields without rewriting config', async t => {
  const root = await temporaryHome(t);
  const integrationRoot = join(root, 'integrations', 'dsh-feishu');
  await putState(root, 'feishu', 'feishu-legacy', {
    sessions: { decoy: 'session-feishu-decoy' },
  });
  const configText = JSON.stringify({
    version: 2,
    bots: [{
      id: '  feishu-legacy  ',
      appId: '  cli-legacy  ',
      secretRef: '  DSH_FEISHU_APP_SECRET  ',
      ownerOpenIds: ['ou-legacy'],
    }],
  });
  await writeFile(join(integrationRoot, 'config.json'), configText);
  await writeFile(join(integrationRoot, 'state.json'), JSON.stringify({
    sessions: { 'group:legacy': 'session-feishu-legacy' },
  }));
  const result = await buildList({ dshHome: root });
  assert.deepEqual(result.channels, [{ channel: 'feishu', sessions: [
    { key: 'group:legacy', sessionId: 'session-feishu-legacy', botId: 'feishu-legacy' },
  ] }]);
  assert.equal(await readFile(join(integrationRoot, 'config.json'), 'utf8'), configText);
});

test('buildList trims Feishu v1 legacy identity fields without rewriting config', async t => {
  const root = await temporaryHome(t);
  const integrationRoot = join(root, 'integrations', 'dsh-feishu');
  await putState(root, 'feishu', 'feishu-v1-id', {
    sessions: { decoy: 'session-feishu-decoy' },
  });
  const configText = JSON.stringify({
    id: '  feishu-v1-id  ',
    appId: '  cli-v1-legacy  ',
    secretRef: '  DSH_FEISHU_APP_SECRET  ',
    ownerOpenId: 'ou-owner',
  });
  await writeFile(join(integrationRoot, 'config.json'), configText);
  await writeFile(join(integrationRoot, 'state.json'), JSON.stringify({
    sessions: { 'group:legacy-v1': 'session-feishu-v1' },
  }));
  const result = await buildList({ dshHome: root });
  assert.deepEqual(result.channels, [{ channel: 'feishu', sessions: [
    { key: 'group:legacy-v1', sessionId: 'session-feishu-v1', botId: 'feishu-v1-id' },
  ] }]);
  assert.equal(await readFile(join(integrationRoot, 'config.json'), 'utf8'), configText);
});

test('buildList ignores Feishu root state without a legacy bot config', async t => {
  const root = await temporaryHome(t);
  await putState(root, 'feishu', 'feishu-modern', {
    sessions: { 'group:modern': 'session-feishu-modern' },
  });
  const integrationRoot = join(root, 'integrations', 'dsh-feishu');
  await writeFile(join(integrationRoot, 'config.json'), JSON.stringify({
    version: 2,
    bots: [{ id: 'feishu-modern', appId: 'cli-modern', secretRef: 'FEISHU_MODERN_SECRET', ownerOpenIds: ['ou-modern'] }],
  }));
  await writeFile(join(integrationRoot, 'state.json'), JSON.stringify({
    sessions: { decoy: 'session-feishu-decoy' },
  }));
  const result = await buildList({ dshHome: root });
  assert.deepEqual(result.channels, [{ channel: 'feishu', sessions: [
    { key: 'group:modern', sessionId: 'session-feishu-modern', botId: 'feishu-modern' },
  ] }]);
  assert.equal(result.scannedFiles, 1);
});

test('list.channels returns its payload in the connection RPC value field', async t => {
  const root = await temporaryHome(t);
  await putState(root, 'matrix', 'matrix-bot', { sessions: { room: 'session-matrix' } });
  let fetch;
  const ctx = { connection: { fetch: { register(definition) {
    fetch = definition.fetch;
    return () => {};
  } } } };
  installChannelListRpc(ctx, undefined, { dshHome: root });
  assert.equal(typeof fetch, 'function');

  const response = await fetch(new Request('http://127.0.0.1/api/dsh-im/dsh-im-channels', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request', rpcId: 'rpc-test', method: 'dsh-im/dsh-im-channels',
      payload: { method: 'list.channels', payload: {} },
    }),
  }));
  assert.equal(response.status, 200);
  const envelope = await response.json();
  assert.equal(envelope.result.ok, true);
  // dsh-client-connection discards every success field except `value`.
  assert.equal(Object.hasOwn(envelope.result, 'data'), false);
  assert.equal(envelope.result.value.channels[0].channel, 'matrix');
  assert.equal(envelope.result.value.channels[0].sessions[0].sessionId, 'session-matrix');
});

test('session.read returns only the bound session append-origin human transcript', async t => {
  const root = await temporaryHome(t);
  await putState(root, 'matrix', 'matrix-bot', { sessions: { room: 'session-matrix' } });
  await putState(root, 'matrix', 'matrix-other', { sessions: { room: 'session-other' } });
  await putState(root, 'weixin', 'wx-account', {
    sessions: { 'direct:wx-user': 'session-weixin' },
  }, 'accounts');
  const reads = [];
  const events = [
    { type: 'user/message', seq: 0, time: 100, surfaceOp: 'append', data: {
      source: { kind: 'user' }, content: [{ type: 'text', text: '第一条用户消息' }],
    } },
    { type: 'user/message', seq: 1, time: 101, surfaceOp: 'append', data: {
      source: { kind: 'plugin:memory' }, content: [{ type: 'text', text: '内部记忆不得显示' }],
    } },
    { type: 'assistant/message', seq: 2, time: 102, surfaceOp: 'append', data: { message: {
      role: 'assistant', content: [
        { type: 'reasoning', text: '内部推理不得显示' },
        { type: 'text', text: '第一条助手回复' },
      ],
    } } },
    { type: 'user/message', seq: 3, time: 103, surfaceOp: 'append', data: {
      source: { kind: 'user' }, content: [{ type: 'text', text: '第二条用户消息' }],
    } },
    { type: 'assistant/message', seq: 4, time: 104, surfaceOp: { replace: [2] }, data: { message: {
      role: 'assistant', content: [{ type: 'text', text: '替换副本不得覆盖人类历史' }],
    } } },
    { type: 'assistant/message', seq: 5, time: 105, surfaceOp: 'append', data: { message: {
      role: 'assistant', content: [{ type: 'tool-call', name: 'bash', arguments: '{}' }],
    } } },
  ];
  let fetch;
  const sessionQuery = { async readSession(sessionId) {
    reads.push(sessionId);
    return { session: { id: sessionId }, inheritedEventCount: 0, events };
  } };
  const ctx = {
    // Cordis throws on an undeclared service read; it does not return undefined.
    get sessionQuery() { throw new Error('cannot get property "sessionQuery" without inject'); },
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['sessionQuery']);
      callback({ sessionQuery });
      return { dispose() {} };
    },
    connection: { fetch: { register(definition) {
      fetch = definition.fetch;
      return () => {};
    } } },
  };
  installChannelListRpc(ctx, undefined, { dshHome: root });

  async function call(payload) {
    const response = await fetch(new Request('http://127.0.0.1/api/dsh-im/dsh-im-channels', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: `rpc-${Math.random()}`, method: 'dsh-im/dsh-im-channels',
        payload: { method: 'session.read', payload },
      }),
    }));
    assert.equal(response.status, 200);
    return (await response.json()).result;
  }

  const latest = await call({
    channel: 'matrix', key: 'room', botId: 'matrix-bot', sessionId: 'session-matrix', limit: 2,
  });
  assert.equal(latest.ok, true);
  assert.equal(latest.value.total, 3);
  assert.equal(latest.value.hasMore, true);
  assert.equal(latest.value.nextOffset, 0);
  assert.deepEqual(latest.value.messages.map(message => message.text), ['第一条助手回复', '第二条用户消息']);
  assert.ok(latest.value.messages.every(message => !message.text.includes('不得')));
  assert.deepEqual(reads, ['session-matrix']);

  const earlier = await call({
    channel: 'matrix', key: 'room', botId: 'matrix-bot', sessionId: 'session-matrix',
    limit: 2, offset: latest.value.nextOffset,
  });
  assert.equal(earlier.ok, true);
  assert.equal(earlier.value.hasMore, false);
  assert.deepEqual(earlier.value.messages.map(message => message.text), ['第一条用户消息', '第一条助手回复']);

  const weixin = await call({
    channel: 'weixin', key: 'direct:wx-user', botId: 'wx-account', sessionId: 'session-weixin',
  });
  assert.equal(weixin.ok, true);
  assert.equal(weixin.value.total, 3);
  assert.deepEqual(weixin.value.messages.map(message => message.text), [
    '第一条用户消息', '第一条助手回复', '第二条用户消息',
  ]);

  for (const payload of [
    { channel: 'matrix', key: 'room', botId: 'matrix-other', sessionId: 'session-matrix' },
    { channel: 'matrix', key: 'room', sessionId: 'session-matrix' },
    { channel: 'matrix', key: 'room', botId: 'matrix-bot', sessionId: 'session-unbound' },
  ]) {
    const denied = await call(payload);
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'channel-session/not-bound');
  }
  assert.deepEqual(reads, ['session-matrix', 'session-matrix', 'session-weixin']);
});

test('installer disposes both the RPC route and the Cordis query injection', () => {
  let rpcDisposals = 0;
  let queryDisposals = 0;
  let queryCallbackDisposals = 0;
  const ctx = {
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['sessionQuery']);
      const cleanup = callback({ sessionQuery: { async readSession() {} } });
      return {
        dispose() {
          queryDisposals++;
          cleanup();
        },
      };
    },
    connection: { fetch: { register() {
      return () => { rpcDisposals++; };
    } } },
  };
  const stopQueryCallback = () => { queryCallbackDisposals++; };
  // Replace the callback's cleanup through the same shape used by Cordis.
  const originalInject = ctx.inject;
  ctx.inject = (dependencies, callback) => originalInject(dependencies, queryCtx => {
    callback(queryCtx);
    return stopQueryCallback;
  });

  const dispose = installChannelListRpc(ctx);
  dispose();
  assert.equal(rpcDisposals, 1);
  assert.equal(queryDisposals, 1);
  assert.equal(queryCallbackDisposals, 1);
});
