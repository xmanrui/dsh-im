import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { atConnectionStage, connectionErrorChain, connectionStageError, createConnectionDiagnostics, diagnosticRpcResult, extractConnectionEvidence } from '../../../src/channels/shared/connection-error.mjs';
import { normalizeDiagnosticDetails, DIAGNOSTIC_CHANNELS } from '../../../src/channels/shared/diagnostic-details.mjs';
import { ConnectionError, formatConnectionDiagnostic } from '../../../plugin-src/client/connection-error.js';
import { TokenBotController } from '../../../src/channels/shared/token-bot-controller.mjs';
import { RegistrationManager } from '../../../src/channels/feishu/registration-manager.mjs';
import { publicConnectionTestResult } from '../../../src/channels/shared/connection-test.mjs';
import { classifyMessageFailure, publicMessageFailure } from '../../../src/channels/shared/message-failure.mjs';
import { callManagementRpc } from '../../../plugin-src/management-rpc.mjs';

const cause = code => Object.assign(new Error('private-token https://user:password@private.example/?secret=secret'), { code });
function fixture(channel = 'qq') {
  const logs = [];
  const logger = Object.fromEntries(['error', 'warn', 'info'].map(level => [level, (...args) => logs.push({ level, text: args.join(' ') })]));
  return { logs, logger, diagnostics: createConnectionDiagnostics({ channel, logger }) };
}

test('extracts deep and aggregate causes, bounds cycles and ignores arbitrary SDK fields', () => {
  const leaf = cause('ENOTFOUND');
  const error = new Error('wrapper', { cause: new AggregateError([new Error('wrapper', { cause: leaf }), cause('ECONNREFUSED'), leaf]) });
  error.cause.errors.push(error);
  const evidence = extractConnectionEvidence(error);
  assert.equal(evidence.details.reason, 'multiple-causes');
  assert.deepEqual(new Set(evidence.details.reasons), new Set(['ENOTFOUND', 'ECONNREFUSED']));
  assert.equal(evidence.chain.length, 5);
  assert.equal(evidence.details.truncated, undefined);
  const giant = new AggregateError(Array.from({ length: 100 }, () => cause('ENOTFOUND')));
  assert.equal(connectionErrorChain(giant).chain.length, 16);
  assert.equal(extractConnectionEvidence(giant).details.truncated, true);
  const { chain, ...safe } = evidence;
  assert.doesNotMatch(JSON.stringify(safe), /private-token|password|private.example|secret=/);
  assert.equal(extractConnectionEvidence(new Error('ENOTFOUND TLS timeout')).details.reason, 'unknown');
  assert.deepEqual(normalizeDiagnosticDetails({ reason: 'private-token', host: 'private.example', file: '/private/secrets', providerCode: 'secret', stack: 'secret' }), {});
});

test('keeps valid HTTP evidence, stages and timings without diagnosing login expiry from a status', async () => {
  const { diagnostics, logs } = fixture();
  let error;
  try { await atConnectionStage('credential.read', async () => { throw Object.assign(cause('EACCES'), { status: 403, durationMs: 125.4, timeoutMs: 5000, host: 'api.telegram.org' }); }, 'credential-store'); }
  catch (caught) { error = caught; }
  const result = diagnostics.report(error, { operation: 'bot.reconnect' }).publicError;
  assert.equal(result.details.stage, 'credential.read');
  assert.equal(result.details.durationMs, 125);
  assert.equal(result.details.httpStatus, 403);
  assert.equal(result.details.resource, 'credential-store');
  assert.equal(result.details.host, 'api.telegram.org');
  assert.doesNotMatch(JSON.stringify([result, logs]), /private-token|password|secret=/);
  const http = diagnostics.report(Object.assign(new Error(), { status: 401 })).publicError;
  assert.match(http.details.hint, /不能确认登录失效/);
  assert.match(diagnostics.report(cause('ETIMEDOUT')).publicError.details.hint, /请求超时/);
});

test('Controller and RPC share a reference; retries deduplicate until recovery while user actions remain distinct', () => {
  let time = 0;
  const logs = [];
  const diagnostics = createConnectionDiagnostics({ channel: 'qq', now: () => time, logger: { error: s => logs.push(s), info: s => logs.push(s), warn: s => logs.push(s) } });
  const raw = cause('ECONNRESET');
  const first = diagnostics.report(raw, { operation: 'connection.monitor', automatic: true, botId: 'one' });
  const rpc = diagnosticRpcResult(diagnostics, raw, { ok: false, error: { code: 'legacy-code', message: '安全提示' } }, { operation: 'bot.reconnect' });
  assert.equal(rpc.error.code, 'legacy-code');
  assert.equal(rpc.error.details.referenceId, first.publicError.details.referenceId);
  assert.equal(logs.length, 1);
  time += 1000;
  assert.equal(diagnostics.report(cause('ECONNRESET'), { operation: 'connection.monitor', automatic: true, botId: 'one' }).publicError.details.referenceId, rpc.error.details.referenceId);
  assert.equal(logs.length, 1);
  diagnostics.clear('one');
  const next = diagnostics.report(cause('ECONNRESET'), { operation: 'connection.monitor', automatic: true, botId: 'one' });
  assert.notEqual(next.publicError.details.referenceId, rpc.error.details.referenceId);
  assert.notEqual(diagnostics.report(raw).publicError.details.referenceId, diagnostics.report(raw).publicError.details.referenceId);
  const before = logs.length;
  assert.equal(diagnosticRpcResult(diagnostics, new DOMException('private', 'AbortError'), { ok: false, error: { code: 'internal' } }).error.code, 'cancelled');
  assert.equal(logs.length, before);
});

for (const channel of DIAGNOSTIC_CHANNELS) {
  test(`${channel}: actual RPC handler, client projection, rendering and copy retain nested diagnostics`, async () => {
    const fx = fixture(channel);
    const error = new Error('private outer', { cause: new AggregateError([cause('ENOTFOUND'), cause('ECONNREFUSED')]) });
    const controller = new Proxy({ diagnostics: fx.diagnostics, disabled: undefined }, { get: (target, key) => key in target ? target[key] : () => { throw error; } });
    const module = await import(`../../../plugin-src/host/channels/${channel}/rpc.mjs`);
    const factory = Object.entries(module).find(([name]) => /^create.*RpcHandler$/.test(name))[1];
    const handler = factory(controller, { diagnostics: fx.diagnostics, logger: fx.logger });
    const result = await handler('connection.status', {});
    assert.equal(result.ok, false);
    assert.equal(result.error.details.reason, 'multiple-causes');
    assert.equal(result.error.details.channel, channel);
    assert.equal(result.error.details.stage, 'status.read');
    assert.equal(fx.logs.length, 1);
    const api = await import(`../../../plugin-src/client/channels/${channel}/api.js`);
    let displayed;
    try { (api.unwrapRpcResult ?? api.unwrapOfficeRpc)(result); } catch (caught) { displayed = api.presentError?.(caught) ?? caught; }
    assert.equal(displayed.details.referenceId, result.error.details.referenceId);
    const text = formatConnectionDiagnostic(displayed);
    const markup = renderToStaticMarkup(React.createElement(ConnectionError, { error: displayed }));
    assert.match(text, /ENOTFOUND/);
    assert.match(text, /ECONNREFUSED/);
    assert.match(markup, /诊断详情/);
    assert.ok(markup.includes(result.error.details.referenceId));
    assert.doesNotMatch(JSON.stringify([result, text, markup, fx.logs]), /private outer|private-token|password|private.example/);
  });
}

function tokenControllerFixture() {
  const fx = fixture('telegram');
  const configs = new Map([['one', { botId: 'one', platformId: '123', tokenRef: 'ref', name: 'Bot' }], ['two', { botId: 'two', platformId: '456', tokenRef: 'ref2', name: 'Bot 2' }]]);
  const credentials = { resolve: async ref => { if (ref === 'ref') throw cause('EACCES'); return { value: 'token' }; }, set: async () => {}, unset: async () => {} };
  const runtimes = [];
  const configStore = { list: () => [...configs.values()], get: id => configs.get(id), save: async config => configs.set(config.botId, config), remove: async id => configs.delete(id) };
  const controller = new TokenBotController({ descriptor: { key: 'telegram', label: 'Telegram', connectionLabel: 'Polling' }, credentials,
    configStore,
    inspectToken: async () => ({}), deriveIdentity: () => ({}), maskPlatformId: () => '***', logger: fx.logger,
    createRuntime: async () => { const runtime = { status: { ready: true, connectionState: 'connected', harnessReachable: true }, start: async () => {}, stop: async () => {} }; runtimes.push(runtime); return runtime; },
    deleteState: async () => { throw cause('EPERM'); },
  });
  return { ...fx, controller, credentials, runtimes, configs, configStore };
}

test('cleanup failure after a committed removal does not restore credentials or restart the deleted account', async t => {
  const fx = tokenControllerFixture();
  t.after(() => fx.controller.close());
  fx.credentials.resolve = async () => ({ value: 'token' });
  await fx.controller.initialize();
  const runtimeCount = fx.runtimes.length;
  let restoredCredentials = 0;
  fx.credentials.set = async () => { restoredCredentials += 1; };
  fx.configStore.remove = async id => {
    fx.configs.delete(id);
    throw connectionStageError(cause('EACCES'), 'workspace.cleanup', 'workspace-config');
  };
  const result = await fx.controller.deleteBot('one');
  assert.deepEqual(result.bots.map(bot => bot.botId), ['two']);
  assert.equal(result.warnings[0].details.stage, 'workspace.cleanup');
  assert.equal(result.warnings[0].details.reason, 'EACCES');
  assert.equal(restoredCredentials, 0);
  assert.equal(fx.runtimes.length, runtimeCount);
});

test('credential read failure remains per account; another account restores and deletion preserves cleanup warnings', async t => {
  const fx = tokenControllerFixture();
  t.after(() => fx.controller.close());
  const status = await fx.controller.initialize();
  assert.equal(status.bots[0].error.details.stage, 'credential.read');
  assert.equal(status.bots[0].error.details.reason, 'EACCES');
  assert.equal(status.bots[1].connected, true);
  fx.credentials.resolve = async () => ({ value: 'token' });
  await fx.controller.reconnectBot('one');
  assert.equal(fx.controller.status().bots[0].error, null);
  fx.runtimes.at(-1).status.error = fx.diagnostics.report(cause('ENOTFOUND'), { operation: 'connection.monitor' }).publicError;
  assert.equal(fx.controller.status().bots[0].error.details.reason, 'ENOTFOUND');
  const removed = await fx.controller.deleteBot('one');
  assert.equal(removed.bots.length, 1);
  assert.equal(removed.warnings[0].details.stage, 'state.cleanup');
  assert.equal(removed.warnings[0].details.reason, 'EPERM');
});

test('background Feishu QR failures retain a log reference and cancellation stays quiet', async () => {
  const fx = fixture('feishu');
  const manager = new RegistrationManager({ diagnostics: fx.diagnostics, registerApp: async () => { throw new Error('outer', { cause: cause('ENOTFOUND') }); }, onCredentials: async () => {} });
  manager.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.status().error.details.stage, 'qr.begin');
  assert.equal(manager.status().error.details.reason, 'ENOTFOUND');
  assert.equal(fx.logs.length, 1);
  const pending = new RegistrationManager({ diagnostics: fx.diagnostics, registerApp: async ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Abort', 'AbortError')))), onCredentials: async () => {} });
  pending.start(); await Promise.resolve(); pending.cancel(); await Promise.resolve();
  assert.equal(pending.status().state, 'cancelled');
  assert.equal(fx.logs.length, 1);
});

test('test-message errors and message failures retain diagnostics without replacing business codes', () => {
  const fx = fixture();
  const result = publicConnectionTestResult(cause('ECONNRESET'), { diagnostics: fx.diagnostics });
  assert.equal(result.sent, false);
  assert.equal(result.code, 'test-message-failed');
  assert.equal(result.error.details.stage, 'connection.test');
  const failure = publicMessageFailure(classifyMessageFailure(Object.assign(cause('harness-turn-failed'), { providerCode: 'QUOTA', cause: cause('ECONNRESET') })));
  assert.equal(failure.code, 'MODEL_QUOTA');
  assert.equal(failure.details.reason, 'ECONNRESET');
  assert.equal(failure.details.referenceId, failure.referenceId);
});

test('management transport failures stay distinct from provider failures and cancellation is preserved', async () => {
  await assert.rejects(callManagementRpc({ rpc: { call: async () => { throw Object.assign(cause('ENOTFOUND'), { status: 403 }); } } }, '/weixin', 'provision.begin', {}), error => {
    assert.equal(error.code, 'management-unreachable');
    assert.equal(error.details.stage, 'management.request');
    assert.equal(error.details.referenceId, undefined);
    assert.equal(error.details.httpStatus, 403);
    assert.doesNotMatch(error.message, /private-token/);
    return true;
  });
  const abort = new DOMException('Cancelled', 'AbortError');
  await assert.rejects(callManagementRpc({ rpc: { call: async () => { throw abort; } } }, '/weixin', 'provision.begin', {}), error => error === abort);
});

test('copying diagnostics falls back to selectable text when the clipboard is unavailable', async t => {
  const error = fixture().diagnostics.report(cause('ENOTFOUND')).publicError;
  let renderer;
  await act(async () => { renderer = create(React.createElement(ConnectionError, { error })); });
  t.after(() => renderer.unmount());
  await act(async () => { await renderer.root.findByType('button').props.onClick(); });
  assert.equal(renderer.root.findByType('textarea').props.value, formatConnectionDiagnostic(error));
});

const transportCases = [
  ['weixin', async fetchImpl => (await import('../../../src/channels/weixin/weixin-api.mjs')).createWeixinApi({ fetchImpl }).beginLogin()],
  ['dingtalk', async fetchImpl => new (await import('../../../src/channels/dingtalk/device-auth.mjs')).DingtalkDeviceAuth({ fetch: fetchImpl }).start()],
  ['slack', async fetchImpl => new (await import('../../../src/channels/slack/slack-api.mjs')).SlackApi({ botToken: `xoxb-${'a'.repeat(30)}`, fetchImpl }).authTest()],
  ['discord', async fetchImpl => new (await import('../../../src/channels/discord/discord-api.mjs')).DiscordApi({ token: `${'a'.repeat(25)}.aaaa.${'b'.repeat(25)}`, fetchImpl }).getCurrentUser()],
  ['telegram', async fetchImpl => new (await import('../../../src/channels/telegram/telegram-api.mjs')).TelegramApi({ token: `123456:${'a'.repeat(30)}`, fetchImpl }).getMe()],
  ['office', async fetchImpl => new (await import('../../../src/channels/office/office-transport.mjs')).OfficeTransport({ baseUrl: 'https://office.example.com', deviceId: 'device', token: 'x'.repeat(32), fetchImpl }).heartbeat({})],
];
for (const [channel, request] of transportCases) {
  test(`${channel}: actual HTTP client preserves fetch causes and parser failures`, async () => {
    const fx = fixture(channel);
    for (const [fetchImpl, reason] of [
      [async () => { throw new TypeError('fetch failed', { cause: new AggregateError([cause('ENOTFOUND'), cause('ECONNREFUSED')]) }); }, 'multiple-causes'],
      [async () => new Response('private-invalid-json', { status: 200, headers: { 'content-type': 'application/json' } }), 'invalid-json'],
    ]) {
      await assert.rejects(request(fetchImpl), error => {
        const result = fx.diagnostics.report(error, { operation: 'bot.bind-credentials' }).publicError;
        // Some APIs have a typed response-invalid code in addition to the parser cause.
        assert.ok(result.details.reason === reason || (reason === 'invalid-json' && result.details.reasons?.includes('invalid-json')));
        assert.doesNotMatch(JSON.stringify([result, fx.logs]), /private-invalid-json|private-token|password|private.example/);
        return true;
      });
    }
  });
}

test('DingTalk and Office retain HTTP rejection status instead of only a generic failure', async () => {
  for (const [channel, request] of transportCases.filter(([channel]) => ['dingtalk', 'office'].includes(channel))) {
    await assert.rejects(request(async () => new Response('{}', { status: 403 })), error => {
      assert.equal(fixture(channel).diagnostics.report(error).publicError.details.httpStatus, 403);
      return true;
    });
  }
});

test('copy button writes the normalized diagnostic and confirms success', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let copied;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async text => { copied = text; } } } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator; });
  const error = fixture().diagnostics.report(cause('ECONNREFUSED')).publicError;
  let renderer;
  await act(async () => { renderer = create(React.createElement(ConnectionError, { error })); });
  t.after(() => renderer.unmount());
  await act(async () => { await renderer.root.findByType('button').props.onClick(); });
  assert.equal(copied, formatConnectionDiagnostic(error));
  assert.equal(renderer.root.findByType('button').children.join(''), '诊断信息已复制');
});
