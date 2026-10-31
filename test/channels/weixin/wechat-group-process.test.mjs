import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WechatGroupProcess } from '../../../src/channels/weixin/wechat-group-process.mjs';

const CONFIG = {
  pollIntervalMs: 750,
  groups: [{
    id: 'uia_group_one',
    title: '精确群名',
    commandPrefix: '/dsh',
    mentionMode: 'command',
    allowSelf: false,
  }],
};

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.pid = 4100;
    this.killed = false;
    this.onRequest = null;
    this.requests = [];
    this.stdin = {
      write: (line) => {
        const request = JSON.parse(line);
        this.requests.push(request);
        this.onRequest?.(request);
        return true;
      },
      end: () => {},
    };
  }

  emitRaw(value) {
    this.stdout.emit('data', Buffer.from(value, 'utf8'));
  }

  emitLine(value) {
    this.emitRaw((typeof value === 'string' ? value : JSON.stringify(value)) + '\n');
  }

  kill(signal = 'SIGTERM') {
    this.killed = true;
    this.killSignal = signal;
    queueMicrotask(() => this.emit('close', 0, signal));
    return true;
  }
}

function makeProcess(t, options = {}) {
  const children = [];
  const spawnCalls = [];
  const logs = [];
  const logger = {
    warn: (...args) => logs.push(args.join(' ')),
    error: (...args) => logs.push(args.join(' ')),
  };
  const groupProcess = new WechatGroupProcess({
    config: options.config ?? CONFIG,
    scriptPath: 'D:/fake/wechat_group_uia.py',
    configPath: 'D:/fake/group-chats.json',
    healthTimeoutMs: 100,
    sendTimeoutMs: 100,
    stopTimeoutMs: 100,
    journalPath: null,
    requestIdFactory: (() => {
      let sequence = 0;
      return () => 'generated-' + ++sequence;
    })(),
    spawnImpl: (command, args, spawnOptions) => {
      const child = new FakeChild();
      child.pid += children.length;
      child.onRequest = (request) => {
        if (request.type === 'stop') {
          queueMicrotask(() => child.emitLine({
            type: 'stop_result', request_id: request.request_id, ok: true,
          }));
        }
      };
      children.push(child);
      spawnCalls.push({ command, args, options: spawnOptions });
      return child;
    },
    logger,
    ...options,
  });
  t.after(async () => {
    if (groupProcess.status.running) await groupProcess.stop().catch(() => undefined);
  });
  return { groupProcess, children, spawnCalls, logs };
}

async function startReady(groupProcess, children) {
  const starting = groupProcess.start();
  const child = children.at(-1);
  child.emitLine({ type: 'ready' });
  await starting;
  return child;
}

function requestsOf(children, type) {
  return children.flatMap((child) => child.requests).filter((request) => request.type === type);
}

test('config switches travel into the adapter environment without touching the host env', async (t) => {
  const off = makeProcess(t);
  await startReady(off.groupProcess, off.children);
  const offEnv = off.spawnCalls[0].options.env;
  // Default config means observe-safe: the adapter must not be told to read or write.
  assert.equal(offEnv.DSH_WECHAT_GROUP_ALLOW_UNVERIFIED, undefined);
  assert.equal(offEnv.DSH_WECHAT_GROUP_ALLOW_SEND, undefined);

  const on = makeProcess(t, { config: { ...CONFIG, allowUnverifiedRead: true, allowSend: true } });
  await startReady(on.groupProcess, on.children);
  const onEnv = on.spawnCalls[0].options.env;
  assert.equal(onEnv.DSH_WECHAT_GROUP_ALLOW_UNVERIFIED, '1');
  assert.equal(onEnv.DSH_WECHAT_GROUP_ALLOW_SEND, '1');
  // The switches are passed down, never written into the host process itself.
  assert.equal(process.env.DSH_WECHAT_GROUP_ALLOW_SEND, undefined);
});

test('start uses hidden py -3.12 -B and health correlates request IDs across fragmented JSONL', async (t) => {
  const { groupProcess, children, spawnCalls } = makeProcess(t);
  const child = await startReady(groupProcess, children);
  assert.equal(spawnCalls[0].command, 'py');
  assert.deepEqual(spawnCalls[0].args, [
    '-3.12', '-B', 'D:/fake/wechat_group_uia.py',
    '--config', 'D:/fake/group-chats.json',
  ]);
  assert.equal(spawnCalls[0].options.windowsHide, true);
  assert.equal(spawnCalls[0].options.stdio[0], 'pipe');

  const checking = groupProcess.health();
  const request = requestsOf(children, 'health')[0];
  assert.ok(request.request_id);
  child.emitLine({ type: 'health_result', request_id: 'unrelated', ok: true });
  const response = JSON.stringify({ type: 'health_result', request_id: request.request_id, ok: true }) + '\n';
  child.emitRaw(response.slice(0, 11));
  child.emitRaw(response.slice(11));
  assert.equal((await checking).ok, true);
  assert.equal(groupProcess.status.ready, true);
});

test('sendText maps group ID to chat_id and returns provider IDs; unknown groups never reach stdin', async (t) => {
  const { groupProcess, children } = makeProcess(t);
  const child = await startReady(groupProcess, children);
  const sending = groupProcess.sendText({
    toUserId: 'uia_group_one', text: '受控正文', requestId: 'out-1',
  });
  assert.deepEqual(requestsOf(children, 'send_text'), [{
    type: 'send_text', request_id: 'out-1', chat_id: 'uia_group_one', text: '受控正文',
  }]);
  child.emitLine({
    type: 'send_result', request_id: 'out-1', ok: true, provider_message_ids: ['provider-1'],
  });
  const result = await sending;
  assert.equal(result.ok, true);
  assert.deepEqual(result.providerMessageIds, ['provider-1']);

  const before = requestsOf(children, 'send_text').length;
  await assert.rejects(
    () => groupProcess.sendText({ toUserId: 'uia_unknown', text: '绝不发送', requestId: 'out-2' }),
    (error) => error.code === 'unknown-group',
  );
  assert.equal(requestsOf(children, 'send_text').length, before);
});

test('duplicate outbound request ID shares its result before and after completion', async (t) => {
  const { groupProcess, children } = makeProcess(t);
  const child = await startReady(groupProcess, children);
  const input = { toUserId: 'uia_group_one', text: '只发一次', requestId: 'out-dup' };
  const first = groupProcess.sendText(input);
  const second = groupProcess.sendText(input);
  assert.equal(requestsOf(children, 'send_text').length, 1);
  child.emitLine({
    type: 'send_result', request_id: 'out-dup', ok: true, provider_message_ids: ['provider-dup'],
  });
  assert.deepEqual(await first, await second);
  await groupProcess.sendText(input);
  assert.equal(requestsOf(children, 'send_text').length, 1);
  await assert.rejects(
    () => groupProcess.sendText({ ...input, text: '同 ID 不同正文' }),
    (error) => error.code === 'request-id-conflict',
  );
  assert.equal(requestsOf(children, 'send_text').length, 1);
});

test('unknown send outcome is returned for reconciliation and is never blindly retried', async (t) => {
  const { groupProcess, children } = makeProcess(t);
  const child = await startReady(groupProcess, children);
  const input = { toUserId: 'uia_group_one', text: '结果未知', requestId: 'out-unknown' };
  const sending = groupProcess.sendText(input);
  child.emitLine({
    type: 'send_result',
    request_id: 'out-unknown',
    ok: false,
    provider_message_ids: [],
    error: { code: 'outcome_unknown', message: 'sanitized provider detail' },
  });
  const result = await sending;
  assert.equal(result.ok, false);
  assert.equal(result.status, 'unknown');
  assert.equal(result.code, 'outcome_unknown');
  assert.deepEqual(await groupProcess.sendText(input), result);
  assert.equal(requestsOf(children, 'send_text').length, 1);
});

test('invalid JSONL rejects pending work, closes the child, and never logs the full line', async (t) => {
  const { groupProcess, children, logs } = makeProcess(t);
  const child = await startReady(groupProcess, children);
  const checking = groupProcess.health();
  child.emitRaw('not-json complete-secret-body\n');
  await assert.rejects(checking, (error) => error.code === 'invalid-jsonl');
  assert.equal(child.killed, true);
  assert.equal(groupProcess.status.ready, false);
  assert.equal(logs.join('\n').includes('complete-secret-body'), false);
});

test('health timeout fails with a bounded error', async (t) => {
  const { groupProcess, children } = makeProcess(t, { healthTimeoutMs: 15 });
  await startReady(groupProcess, children);
  await assert.rejects(groupProcess.health(), (error) => error.code === 'health-timeout');
});

test('send timeout fails once and duplicate submission cannot cause another send', async (t) => {
  const { groupProcess, children } = makeProcess(t, { sendTimeoutMs: 15 });
  await startReady(groupProcess, children);
  const input = { toUserId: 'uia_group_one', text: '超时后对账', requestId: 'out-timeout' };
  await assert.rejects(groupProcess.sendText(input), (error) => error.code === 'send-timeout');
  await assert.rejects(groupProcess.sendText(input), (error) => error.code === 'send-timeout');
  assert.equal(requestsOf(children, 'send_text').length, 1);
});

test('stop result still reaps a child that does not exit by itself', async (t) => {
  const { groupProcess, children } = makeProcess(t);
  const child = await startReady(groupProcess, children);
  await groupProcess.stop();
  assert.equal(child.killed, true);
  assert.equal(groupProcess.status.running, false);
  assert.equal(groupProcess.status.ready, false);
});

test('stop timeout fails and force-kills without leaving an orphan', async (t) => {
  const { groupProcess, children } = makeProcess(t, { stopTimeoutMs: 15 });
  const child = await startReady(groupProcess, children);
  child.onRequest = () => {};
  await assert.rejects(groupProcess.stop(), (error) => error.code === 'stop-timeout');
  assert.equal(child.killed, true);
  assert.equal(groupProcess.status.running, false);
});

test('restart establishes a fresh ready baseline and drops pre-ready historical events', async (t) => {
  const { groupProcess, children } = makeProcess(t);
  const events = [];
  groupProcess.on('message', (event) => events.push(event));
  const first = await startReady(groupProcess, children);
  first.emitLine({ type: 'message', message: { message_id: 'new-before-crash' } });
  first.emit('close', 1, null);
  assert.equal(groupProcess.status.ready, false);

  const restarting = groupProcess.start();
  const second = children.at(-1);
  second.emitLine({ type: 'message', message: { message_id: 'historical-replay' } });
  assert.deepEqual(events.map((event) => event.message_id), ['new-before-crash']);
  second.emitLine({ type: 'ready' });
  await restarting;
  second.emitLine({ type: 'message', message: { message_id: 'new-after-restart' } });
  assert.deepEqual(events.map((event) => event.message_id), ['new-before-crash', 'new-after-restart']);
});

test('persistent success journal prevents a second send after a Node restart and contains no body', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wechat-group-journal-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const journalPath = join(root, 'group-outbound-journal.jsonl');
  const configPath = join(root, 'group-chats.json');
  const first = makeProcess(t, { journalPath, configPath });
  const firstChild = await startReady(first.groupProcess, first.children);
  const input = { toUserId: 'uia_group_one', text: '持久正文绝不落日志', requestId: 'out-persistent' };
  const sending = first.groupProcess.sendText(input);
  firstChild.emitLine({
    type: 'send_result', request_id: input.requestId, ok: true, provider_message_ids: ['provider-persistent'],
  });
  assert.equal((await sending).ok, true);
  await first.groupProcess.stop();

  const second = makeProcess(t, { journalPath, configPath });
  await startReady(second.groupProcess, second.children);
  const replay = await second.groupProcess.sendText(input);
  assert.deepEqual(replay.providerMessageIds, ['provider-persistent']);
  await assert.rejects(
    () => second.groupProcess.sendText({ ...input, text: '同 ID 不同哈希' }),
    (error) => error.code === 'request-id-conflict',
  );
  assert.equal(requestsOf(second.children, 'send_text').length, 0);
  const journal = await readFile(journalPath, 'utf8');
  assert.equal(journal.includes(input.text), false);
  assert.match(journal, /"state":"reserved"/);
  assert.match(journal, /"state":"sending"/);
  assert.match(journal, /"state":"succeeded"/);
});

test('unfinished journal becomes unknown after restart and cannot blind-retry', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wechat-group-journal-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const journalPath = join(root, 'group-outbound-journal.jsonl');
  const configPath = join(root, 'group-chats.json');
  const first = makeProcess(t, { journalPath, configPath });
  const firstChild = await startReady(first.groupProcess, first.children);
  const input = { toUserId: 'uia_group_one', text: '崩溃后只对账', requestId: 'out-unfinished' };
  const sending = first.groupProcess.sendText(input);
  firstChild.emit('close', 1, null);
  await assert.rejects(sending, (error) => error.code === 'process-exit');

  const second = makeProcess(t, { journalPath, configPath, sendTimeoutMs: 20 });
  await startReady(second.groupProcess, second.children);
  const replay = await second.groupProcess.sendText(input);
  assert.equal(replay.status, 'unknown');
  assert.equal(requestsOf(second.children, 'send_text').length, 0);
  const journal = await readFile(journalPath, 'utf8');
  assert.equal(journal.includes(input.text), false);
});

test('corrupt persistent journal fails closed before any child can start', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wechat-group-journal-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const journalPath = join(root, 'group-outbound-journal.jsonl');
  await writeFile(journalPath, 'not-json-with-secret-body\n', 'utf8');
  assert.throws(
    () => new WechatGroupProcess({
      config: CONFIG,
      scriptPath: 'D:/fake/wechat_group_uia.py',
      configPath: join(root, 'group-chats.json'),
      journalPath,
      spawnImpl: () => { throw new Error('must not spawn'); },
    }),
    (error) => error.code === 'journal-invalid',
  );
});

test('child crash rejects correlated work without automatic resubmission', async (t) => {
  const { groupProcess, children } = makeProcess(t);
  const child = await startReady(groupProcess, children);
  const sending = groupProcess.sendText({
    toUserId: 'uia_group_one', text: '崩溃不得重发', requestId: 'out-crash',
  });
  child.emit('close', 1, null);
  await assert.rejects(sending, (error) => error.code === 'process-exit');
  assert.equal(requestsOf(children, 'send_text').length, 1);
});
