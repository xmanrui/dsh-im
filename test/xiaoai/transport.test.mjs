import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SidecarClient, sidecarEnvironment, waitReady } from '../../src/channels/xiaoai/sidecar-client.mjs';
import { XiaoAIRuntime, voiceText } from '../../src/channels/xiaoai/runtime.mjs';
import { XiaoAIStateStore, ReceiptStore } from '../../src/channels/xiaoai/state-store.mjs';
import { parseCredential, deriveXiaoAIIdentity, XiaoAIConfigStore } from '../../src/channels/xiaoai/config-store.mjs';
import { XiaoAIController } from '../../src/channels/xiaoai/controller.mjs';
import { createXiaoAIRpcHandler } from '../../plugin-src/host/channels/xiaoai/rpc.mjs';
import { normalizeDeliveryTarget } from '../../plugin-src/host/delivery-adapter.mjs';
import { deliverySuggestionsFromSessions, resolvePrivateConversationKey } from '../../plugin-src/host/delivery-suggestions.mjs';

const tmpRoot = tmpdir();
const credential = { account: 'test-account', password: 'test-secret-never-log', accountId: 'a'.repeat(24), deviceId: 'test-device', hardware: 'LX01', name: 'Test speaker', keyword: '让大肥鱼回答' };
const pause = (ms) => new Promise(r => setTimeout(r, ms));
async function until(predicate, timeout = 5000) { const end = Date.now() + timeout; while (!predicate()) { if (Date.now() > end) throw new Error('Condition timed out'); await pause(10); } }
async function directory(t) {
  const dir = await mkdtemp(join(tmpRoot, 'xiaoai-test-'));
  t.disposers = [() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })];
  t.after(async () => { for (const dispose of [...t.disposers].reverse()) await dispose(); });
  return dir;
}

test('voice triggers, spoken controls, strict account/device identity', () => {
  assert.equal(voiceText('让大肥鱼回答，什么是路由', '让大肥鱼回答'), '什么是路由');
  assert.equal(voiceText('打开台灯', '让大肥鱼回答'), null);
  assert.equal(voiceText('停止回答', '让大肥鱼回答'), null);
  assert.equal(voiceText('让大肥鱼回答！', '让大肥鱼回答'), '');
  assert.equal(voiceText('让大肥鱼回答，停止回答', '让大肥鱼回答'), '/stop');
  assert.equal(voiceText('请回答，连接测试', '让大肥鱼回答'), null);
  assert.equal(voiceText('让大肥鱼回答连接测试', '让大肥鱼回答'), '连接测试');
  assert.equal(voiceText('第二个', ''), null);
  assert.throws(() => parseCredential('{}'));
  assert.equal(parseCredential(JSON.stringify(credential)).hardware, 'LX01');
  const { password: _password, ...passwordless } = credential;
  assert.equal(parseCredential(JSON.stringify(passwordless)).account, 'test-account');
  assert.throws(() => parseCredential(JSON.stringify({ ...passwordless, password: 42 })));
  assert.notEqual(deriveXiaoAIIdentity('account-A:device').botId, deriveXiaoAIIdentity('account-B:device').botId);
});

test('uncertain receipt recovery never silently replays a dispatch or TTS', async t => {
  const root = await directory(t); const path = join(root, 'receipts.json');
  const store = await new ReceiptStore(path).load();
  await store.receive({ eventId: 'event', text: 'private test question' });
  await store.patchInbound('event', 'dispatching');
  await store.outboundIntent('speech', 'digest');
  const recovered = await new ReceiptStore(path).load();
  assert.equal(recovered.inbound.event.state, 'uncertain');
  assert.equal((await recovered.outboundIntent('speech', 'digest')).state, 'unknown');
  assert.deepEqual(recovered.summary(), { uncertainInbound: 1, uncertainOutbound: 1 });
  assert.equal(recovered.getInbound('event').state, 'uncertain');
  await recovered.reviewUncertain();
  assert.deepEqual(recovered.summary(), { uncertainInbound: 0, uncertainOutbound: 0 });
  assert.equal(recovered.getInbound('event').state, 'reviewed');
});

test('proactive device routes use the same direct session key', () => {
  const sessions = { 'direct:test-device': 'session-test' };
  const [target] = deliverySuggestionsFromSessions('xiaoai', sessions);
  assert.deepEqual(target, { kind: 'device', route: { deviceId: 'test-device' } });
  assert.equal(resolvePrivateConversationKey('xiaoai', sessions, target), 'direct:test-device');
  assert.throws(() => normalizeDeliveryTarget('xiaoai', { targetId: 'x', kind: 'device', route: { deviceId: 'd', command: 'bad' } }));
});

class FakeSidecar extends EventEmitter {
  constructor() { super(); this.ready = Promise.resolve({ capabilities: { tts: 'mock' } }); this.sent = []; this.requests = []; }
  async start() { return this; }
  async send(value) { this.sent.push(value); }
  async request(type, fields, options) { this.requests.push({ type, fields, options }); return { status: 'accepted', completionConfirmed: false }; }
  async close() { this.closed = true; this.emit('exit', { expected: true }); }
}

test('runtime acknowledgements and heartbeats stay live while a model turn waits; duplicate speech is suppressed', async t => {
  const root = await directory(t); const state = await new XiaoAIStateStore(join(root, 'state.json')).load();
  const client = new FakeSidecar(); let asks = 0; let release;
  const answer = new Promise(r => { release = r; });
  const harness = { ensureRunning: async () => {}, createSession: async () => 'session-test', sessionExists: async () => true,
    ask: async () => { asks++; return answer; } };
  const runtime = new XiaoAIRuntime({ config: { botId: 'xiaoai_test' }, token: JSON.stringify(credential), state, harness,
    stateRoot: root, createSidecar: () => client, logger: { warn() {}, error() {} } });
  t.disposers.push(() => runtime.stop());
  await runtime.start();
  const event = { v: 1, type: 'utterance', deviceId: credential.deviceId, eventId: 'b'.repeat(64), timestamp: Date.now(), text: '让大肥鱼回答测试' };
  client.emit('message', event); client.emit('message', event);
  await until(() => asks === 1);
  await until(() => client.sent.filter(e => e.type === 'accepted').length === 2);
  client.emit('message', { type: 'health', connected: true, lastSuccessAt: 123 });
  assert.equal(runtime.status.lastCheckedAt, 123);
  assert.equal(asks, 1);
  release('测试完成');
  await until(() => client.requests.some(r => r.type === 'speak'));
  assert.equal(state.sessionFor('direct:test-device'), 'session-test');
  assert.equal(client.requests.filter(r => r.type === 'speak').length, 1);
  assert.equal(client.requests.find(r => r.type === 'speak').fields.text, '测试完成');
});

test('pending native questions also require the routing prefix before resuming the model', async t => {
  const root = await directory(t); const state = await new XiaoAIStateStore(join(root, 'state.json')).load();
  const client = new FakeSidecar(); let asks = 0; let response;
  const harness = { ensureRunning: async () => {}, createSession: async () => 'session-question', sessionExists: async () => true,
    ask: async (sessionId, prompt, options) => {
      asks++;
      const answered = new Promise(resolve => { response = resolve; });
      const interaction = { kind: 'question', interactionId: 'question-id', rpcId: 'question-rpc', sessionId,
        payload: { questions: [{ id: 'q', question: '请选择方案', options: [{ label: '方案一' }, { label: '方案二' }] }] },
        respond: async value => { response(value); await options.onInteractionResolved?.({ kind: 'question', interactionId: 'question-id' }); } };
      await options.onInteraction(interaction);
      const value = await answered;
      assert.deepEqual(value.value.answer.answers, [{ id: 'q', selected: ['方案二'] }]);
      return '已选择方案二';
    } };
  const runtime = new XiaoAIRuntime({ config: { botId: 'xiaoai_test' }, token: JSON.stringify(credential), state, harness,
    stateRoot: root, createSidecar: () => client, logger: { warn() {}, error() {} } });
  t.disposers.push(() => runtime.stop()); await runtime.start();
  const event = (id, text) => ({ type: 'utterance', deviceId: credential.deviceId, eventId: id.repeat(64), timestamp: Date.now(), text });
  client.emit('message', event('c', '让大肥鱼回答帮我选方案'));
  await until(() => runtime.status.waitingInteraction === 'question' && client.requests.length > 0);
  client.emit('message', event('d', '方案二'));
  await until(() => client.sent.length >= 2); await pause(30);
  assert.equal(runtime.status.waitingInteraction, 'question');
  client.emit('message', event('e', '让大肥鱼回答，方案二'));
  await until(() => client.requests.some(r => r.fields.text === '已选择方案二'));
  assert.equal(asks, 1); assert.equal(runtime.status.waitingInteraction, null);
});

test('strict routing ignores standalone prefixes, later unprefixed speech and old armed receipts; live updates preserve the session', async t => {
  const root = await directory(t); const state = await new XiaoAIStateStore(join(root, 'state.json')).load();
  const client = new FakeSidecar(); const prompts = [];
  const harness = { ensureRunning: async () => {}, createSession: async () => 'session-strict', sessionExists: async () => true,
    ask: async (id, prompt) => { prompts.push(prompt); return '严格前缀测试成功'; } };
  const stamp = Date.now();
  const event = (id, text) => ({ type: 'utterance', deviceId: credential.deviceId, eventId: id.repeat(64), timestamp: stamp, text });
  const receipts = await new ReceiptStore(join(root, 'xiaoai_test', 'receipts.json')).load();
  await receipts.receive(event('a', '请回答')); await receipts.patchInbound('a'.repeat(64), 'armed');
  const runtime = new XiaoAIRuntime({ config: { botId: 'xiaoai_test' }, token: JSON.stringify(credential), state, harness,
    stateRoot: root, createSidecar: () => client, logger: { warn() {}, error() {} } });
  t.disposers.push(() => runtime.stop()); await runtime.start();
  const migrated = JSON.parse(await readFile(join(root, 'xiaoai_test', 'receipts.json'), 'utf8'));
  assert.equal(migrated.inbound['a'.repeat(64)].state, 'trigger-cancelled');
  client.emit('message', event('b', '让大肥鱼回答'));
  client.emit('message', event('c', '连接测试'));
  client.emit('message', event('d', '查看状态'));
  client.emit('message', event('e', '请回答旧前缀也不可进入'));
  await until(() => client.sent.length === 4); await pause(30);
  assert.equal(prompts.length, 0); assert.equal(client.requests.length, 0);
  assert.equal(runtime.status.routingMode, 'required-prefix');
  client.emit('message', event('f', '让大肥鱼回答，连接测试'));
  await until(() => prompts.length === 1 && !runtime.active);
  assert.equal(prompts[0], '连接测试');
  let saved = false;
  await assert.rejects(runtime.setKeyword('另一个前缀', async () => { throw new Error('credential write failed'); }));
  assert.equal(runtime.status.device.keyword, '让大肥鱼回答');
  await runtime.setKeyword('另一个前缀', async () => { saved = true; });
  assert.equal(saved, true);
  client.emit('message', event('0', '让大肥鱼回答旧前缀不可接入'));
  client.emit('message', event('1', '另一个前缀新前缀已生效'));
  await until(() => prompts.length === 2);
  assert.equal(prompts[1], '新前缀已生效');
  assert.equal(state.sessionFor('direct:test-device'), 'session-strict');
});

test('sidecar environment is a minimal allowlist and keeps runtime state private', () => {
  process.env.XIAOAI_TEST_SECRET_ONLY = 'must-not-pass';
  try {
    const env = sidecarEnvironment({ stateDir: '/private/state', dependencyDir: '/private/vendor', mock: true });
    assert.equal(env.XIAOAI_TEST_SECRET_ONLY, undefined);
    assert.equal(env.HOME, '/private/state');
    assert.equal(env.XDG_CACHE_HOME, join('/private/state', 'cache'));
    assert.equal(env.TMPDIR, join('/private/state', 'tmp'));
    assert.equal(env.PYTHONPATH, '/private/vendor');
    assert.equal(env.PYTHONIOENCODING, 'utf-8');
    assert.equal(env.XIAOAI_TEST_MODE, '1');
  } finally { delete process.env.XIAOAI_TEST_SECRET_ONLY; }
});

test('approval words are ordinary text when no approval is pending', async t => {
  const root = await directory(t); const state = await new XiaoAIStateStore(join(root, 'state.json')).load();
  const client = new FakeSidecar(); const prompts = [];
  const harness = { ensureRunning: async () => {}, createSession: async () => 'session-yes', sessionExists: async () => true,
    ask: async (id, prompt) => { prompts.push(prompt); return '好的'; } };
  const runtime = new XiaoAIRuntime({ config: { botId: 'xiaoai_test' }, token: JSON.stringify(credential), state, harness,
    stateRoot: root, createSidecar: () => client, logger: { warn() {}, error() {} } });
  t.disposers.push(() => runtime.stop()); await runtime.start();
  client.emit('message', { type: 'utterance', deviceId: credential.deviceId, eventId: '9'.repeat(64), timestamp: Date.now(), text: '让大肥鱼回答，yes' });
  await until(() => prompts.length === 1); await pause(50);
  assert.equal(prompts[0], 'yes');
  assert.equal(client.requests.some(request => request.type === 'speak' && request.fields.text.includes('审批')), false);
});

test('auth_required stops the sidecar and marks a permanent failure', async t => {
  const root = await directory(t); const state = await new XiaoAIStateStore(join(root, 'state.json')).load();
  const client = new FakeSidecar();
  const harness = { ensureRunning: async () => {}, createSession: async () => 'session-auth', sessionExists: async () => true,
    ask: async () => '不应被调用' };
  const runtime = new XiaoAIRuntime({ config: { botId: 'xiaoai_test' }, token: JSON.stringify(credential), state, harness,
    stateRoot: root, createSidecar: () => client, logger: { warn() {}, error() {} } });
  t.disposers.push(() => runtime.stop()); await runtime.start();
  client.emit('message', { type: 'auth_required', reason: 'expired' });
  await until(() => runtime.status.permanentFailure === true && runtime.status.ready === false);
  await until(() => client.closed === true);
  assert.equal(runtime.status.connectionState, 'failed');
  assert.equal(runtime.status.auth, 'expired');
});

test('controller blocks supervisor restarts after a permanent auth failure and strips stored passwords', async t => {
  const root = await directory(t); const configStore = await new XiaoAIConfigStore(join(root, 'config.json')).load();
  const secrets = new Map(); let starts = 0;
  const createRuntime = async () => ({
    active: false,
    status: { ready: false, connectionState: 'failed', harnessReachable: false, permanentFailure: true, auth: 'expired' },
    start: async () => { starts += 1; throw new Error('auth required'); },
    stop: async () => {},
    setKeyword: async (keyword, persist) => persist(),
  });
  const controller = new XiaoAIController({ configStore, stateRoot: root,
    credentials: { resolve: async ref => ({ value: secrets.get(ref) }), set: async (ref, value) => secrets.set(ref, value), unset: async ref => secrets.delete(ref) },
    sidecar: {}, stateFor: async () => ({ sessionFor: () => null }), botWorkspaceFor: () => '/approved-workspace',
    listWorkspaceSessions: async () => ({ sessions: [] }), createRuntime,
    logger: { warn() {}, error() {} },
  });
  t.disposers.push(() => controller.close());
  await controller.bindCredentials({ token: JSON.stringify(credential) });
  assert.equal(starts, 1);
  assert.deepEqual(controller.authStatus('missing-session'), { authId: 'missing-session', state: 'expired', devices: [] });
  const tokenRef = [...secrets.keys()][0];
  assert.equal(Object.hasOwn(JSON.parse(secrets.get(tokenRef)), 'password'), true);
  await controller.initialize();
  assert.equal(Object.hasOwn(JSON.parse(secrets.get(tokenRef)), 'password'), false);
  assert.equal(starts, 1, 'a blocked bot must not be restarted by the supervisor');
  const bot = controller.status().bots[0];
  assert.equal(bot.xiaoai.retryBlocked, true);
  assert.equal(bot.error.code, 'xiaoai-auth-required');
  await controller.reconnectBot(bot.botId).catch(() => {});
  assert.equal(starts, 2, 'manual reconnect may attempt exactly once');
  assert.equal(controller.status().bots[0].xiaoai.retryBlocked, true);
});

test('user-facing controller errors survive the RPC boundary and device.test is bounded', async () => {
  const botId = 'xiaoai_' + 'a'.repeat(24);
  const controller = { status() { return { bots: [] }; }, bindCredentials() {}, reconnectBot() {}, deleteBot() {},
    async setKeyword() { throw new Error('请等待当前任务结束再修改触发前缀'); },
    async sendConnectionTest(id) { assert.equal(id, botId); return { sent: true }; } };
  const rpc = createXiaoAIRpcHandler(controller);
  const keyword = await rpc('device.keyword.set', { botId, keyword: '新前缀' });
  assert.equal(keyword.ok, false);
  assert.equal(keyword.error.message, '请等待当前任务结束再修改触发前缀');
  const testResult = await rpc('device.test', { botId });
  assert.deepEqual(testResult, { ok: true, value: { sent: true } });
});

test('management failures redact provider errors and reject unbounded client fields', async () => {
  const controller = { status() { return { bots: [] }; }, bindCredentials() {}, reconnectBot() {}, deleteBot() {},
    async beginAuth() { throw new Error('test-secret-never-log serviceToken=PRIVATE'); } };
  const rpc = createXiaoAIRpcHandler(controller);
  for (const payload of [{ account: 'a', password: 'p' }, { account: 'a', password: 'p', stateDir: '/tmp/not-allowed' }]) {
    const result = await rpc('auth.begin', payload);
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes('test-secret-never-log'));
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});

test('auth status waits for async controller results and preserves verification state on the JSON wire', async () => {
  const authId = '12345678-1234-1234-1234-123456789abc';
  const controller = { status() { return { bots: [] }; }, bindCredentials() {}, reconnectBot() {}, deleteBot() {},
    authentication: { authStatus: async id => ({ authId: id, state: 'verification-required', method: 'Phone', devices: [] }) } };
  const result = await createXiaoAIRpcHandler(controller)('auth.status', { authId });
  const wire = JSON.parse(JSON.stringify(result));
  assert.equal(wire.value.authId, authId);
  assert.equal(wire.value.state, 'verification-required');
  assert.equal(wire.value.method, 'Phone');
});

test('device controller accepts nested native session catalog, isolates accounts and removes device credentials', async t => {
  const root = await directory(t); const configStore = await new XiaoAIConfigStore(join(root, 'config.json')).load();
  const secrets = new Map(); const states = new Map();
  const stateFor = async id => {
    if (!states.has(id)) states.set(id, await new XiaoAIStateStore(join(root, id, 'state.json')).load());
    return states.get(id);
  };
  const controller = new XiaoAIController({ configStore, stateRoot: root,
    credentials: { resolve: async ref => ({ value: secrets.get(ref) }), set: async (ref, value) => secrets.set(ref, value), unset: async ref => secrets.delete(ref) },
    sidecar: {}, stateFor, botWorkspaceFor: () => '/approved-workspace',
    listWorkspaceSessions: async () => ({ workspace: '/approved-workspace', sessions: [{ sessionId: 'session-existing', title: 'Existing' }] }),
    createRuntime: async () => ({ active: false, status: { ready: true, connectionState: 'connected', harnessReachable: true }, start: async () => {}, stop: async () => {}, setKeyword: async (keyword, persist) => persist() }),
    logger: { warn() {}, error() {} },
  });
  t.disposers.push(() => controller.close());
  await controller.bindCredentials({ token: JSON.stringify({ ...credential, keyword: '请回答' }) });
  await controller.bindCredentials({ token: JSON.stringify({ ...credential, accountId: 'f'.repeat(24) }) });
  const bots = controller.status().bots;
  assert.equal(bots.length, 2); assert.notEqual(bots[0].botId, bots[1].botId);
  await controller.bindSession(bots[0].botId, 'session-existing');
  assert.equal((await controller.deviceSessions(bots[0].botId)).currentSessionId, 'session-existing');
  assert.equal((await controller.deviceSessions(bots[1].botId)).currentSessionId, null);
  const result = await createXiaoAIRpcHandler(controller)('device.keyword.set', { botId: bots[0].botId, keyword: '让大肥鱼回答' });
  assert.equal(result.ok, true);
  assert.equal(JSON.parse([...secrets.values()].find(value => JSON.parse(value).accountId === credential.accountId)).keyword, '让大肥鱼回答');
  assert.equal((await controller.deviceSessions(bots[0].botId)).currentSessionId, 'session-existing');
  await assert.rejects(controller.setKeyword(bots[0].botId, 'x'.repeat(81)));
  await assert.rejects(controller.setKeyword(bots[0].botId, 'bad\nvalue'));
  await assert.rejects(controller.setKeyword(bots[0].botId, '   '));
  await assert.rejects(controller.bindSession(bots[0].botId, 'session-other-workspace'));
  await controller.deleteBot(bots[0].botId);
  assert.equal(secrets.size, 1); assert.equal(controller.status().bots.length, 1);
});

test('real JSONL child handles invalid input, replay/ack and idempotent TTS, exits without orphaning', { skip: process.platform === 'win32' }, async t => {
  const root = await directory(t);
  const script = fileURLToPath(new URL('../../sidecar/xiaoai_sidecar.py', import.meta.url));
  const client = new SidecarClient({ python: '/usr/bin/python3', script, stateDir: root, mock: true });
  const messages = [];
  client.on('message', message => messages.push(message));
  await client.start(credential); await waitReady(client);
  t.disposers.push(() => client.close());
  const timestamp = Date.now() + 100;
  await client.send({ type: 'mock_utterance', text: '让大肥鱼回答传输测试', timestamp, providerRequestId: 'real-child-test' });
  await until(() => messages.some(m => m.type === 'utterance'), 5000);
  const event = messages.find(m => m.type === 'utterance');
  await client.send({ type: 'accepted', eventId: event.eventId });
  const first = await client.request('speak', { deviceId: credential.deviceId, text: '测试完成' }, { requestId: 'fixed-request' });
  const second = await client.request('speak', { deviceId: credential.deviceId, text: '不得重复播报' }, { requestId: 'fixed-request' });
  assert.equal(first.status, 'accepted'); assert.deepEqual(first, second);
  assert.equal(first.completionConfirmed, false);
  await client.close();
});

test('partial UTF-8 JSONL, malformed stdout, and child death return bounded failures', { skip: process.platform === 'win32' }, async t => {
  const root = await directory(t);
  const script = fileURLToPath(new URL('./fixtures/protocol_peer.py', import.meta.url));
  const client = new SidecarClient({ python: '/usr/bin/python3', script, stateDir: join(root, 'partial') });
  t.disposers.push(() => client.close());
  await client.start(credential); assert.equal((await waitReady(client)).accountId, 'test');
  const result = await client.request('speak', { deviceId: credential.deviceId, text: 'test' }, { timeoutMs: 1000 });
  assert.equal(result.status, 'unknown'); assert.equal(result.code, 'sidecar-exited');
  const invalid = new SidecarClient({ python: '/usr/bin/python3', script, stateDir: join(root, 'invalid') });
  t.disposers.push(() => invalid.close());
  await invalid.start(credential);
  await assert.rejects(waitReady(invalid, 1000), /sidecar-invalid-json/);
});
