import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { SidecarClient, sidecarEnvironment } from '../../src/channels/xiaoai/sidecar-client.mjs';

// The POSIX case is covered by transport.test.mjs with /usr/bin/python3. This
// one exercises the Windows path, where the child's stdin pipe is not opened
// for overlapped I/O: asyncio's Proactor loop cannot register it with an IOCP
// and every read fails with 'WinError 6 句柄无效' unless the sidecar reads
// sys.stdin.buffer on a worker thread. It runs only when a Python with
// miservice is named, so it stays inert on machines without one.
const python = process.platform === 'win32' ? process.env.XIAOAI_TEST_PYTHON : undefined;
const script = fileURLToPath(new URL('../../sidecar/xiaoai_sidecar.py', import.meta.url));
const credential = { account: 'test-account', accountId: 'a'.repeat(24), deviceId: 'test-device', hardware: 'LX01' };

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > end) throw new Error('Condition timed out');
    await pause(25);
  }
}

test('real child speaks JSONL on Windows stdin', { skip: !python, timeout: 25000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoai-win-stdin-'));
  const client = new SidecarClient({ python, script, stateDir: root, mock: true });
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  const messages = [];
  client.on('message', (message) => messages.push(message));
  const exited = new Promise((resolve) => client.once('exit', resolve));

  await client.start(credential, 'listen');
  const ready = await until(() => messages.find((message) => message.type === 'ready'));
  assert.equal(ready.accountId, credential.accountId);

  await client.send({
    type: 'mock_utterance',
    text: '让大肥鱼回答传输测试',
    timestamp: Date.now() + 100,
    providerRequestId: 'windows-child-test',
  });
  const utterance = await until(() => messages.find((message) => message.type === 'utterance'));
  assert.equal(utterance.text, '让大肥鱼回答传输测试');
  assert.equal(utterance.deviceId, credential.deviceId);

  await client.send({ type: 'accepted', eventId: utterance.eventId });
  const first = await client.request('speak', { deviceId: credential.deviceId, text: '测试完成' }, { requestId: 'fixed-request' });
  const second = await client.request('speak', { deviceId: credential.deviceId, text: '不得重复播报' }, { requestId: 'fixed-request' });
  assert.equal(first.status, 'accepted');
  assert.deepEqual(first, second);
  assert.equal(first.completionConfirmed, false);

  await client.send({ type: 'shutdown' });
  await until(() => messages.find((message) => message.type === 'stopped'));
  await client.close();
  assert.equal((await exited).code, 0);
});

async function rawChild(t) {
  const root = await mkdtemp(join(tmpdir(), 'xiaoai-win-framing-'));
  const child = spawn(python, ['-B', '-u', script, '--state-dir', root, '--mock'], {
    cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: sidecarEnvironment({ stateDir: root, mock: true }),
  });
  const messages = [];
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.resume();
  child.stdin.on('error', () => {}); // An oversized frame deliberately closes stdin.
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      for (const line of output.trim().split('\n').filter(Boolean)) messages.push(JSON.parse(line));
      resolve(code);
    });
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    await rm(root, { recursive: true, force: true });
  });
  return { child, messages, exited };
}

test('Windows stdin preserves CRLF and an unterminated final JSONL frame at EOF', { skip: !python, timeout: 15000 }, async (t) => {
  const { child, messages, exited } = await rawChild(t);
  child.stdin.end('{"v":1,"type":"health"}\r\n{"v":1,"type":"health"}');
  assert.equal(await exited, 0);
  assert.equal(messages.filter((message) => message.type === 'health').length, 2);
  assert.equal(messages.at(-1).type, 'stopped');
});

test('Windows stdin rejects oversized frames without consuming their tail as commands', { skip: !python, timeout: 15000 }, async (t) => {
  const { child, messages, exited } = await rawChild(t);
  const health = '{"v":1,"type":"health"}';
  const maxLine = 256 * 1024;
  // A payload of exactly MAX_LINE plus its newline is allowed, as on POSIX.
  child.stdin.end(health.padEnd(maxLine, ' ') + '\n'
    + ' '.repeat(maxLine + 1) + '\n' + health + '\n');
  assert.equal(await exited, 0);
  assert.equal(messages.filter((message) => message.type === 'health').length, 1);
  assert.ok(messages.some((message) => message.type === 'error' && message.code === 'line-too-long'));
  assert.equal(messages.at(-1).type, 'stopped');
});
