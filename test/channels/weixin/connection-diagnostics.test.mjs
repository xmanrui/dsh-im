import assert from 'node:assert/strict';
import test from 'node:test';
import { WeixinController } from '../../../src/channels/weixin/weixin-controller.mjs';
import { WeixinApiError } from '../../../src/channels/weixin/weixin-api.mjs';
import { deriveWeixinBotIdentity } from '../../../src/channels/weixin/config-store.mjs';
import { createWeixinRpcHandler } from '../../../plugin-src/host/channels/weixin/rpc.mjs';
import { createWeixinDiagnostics, weixinStageError } from '../../../src/channels/weixin/connection-error.mjs';
import { WeixinRuntime } from '../../../src/channels/weixin/weixin-runtime.mjs';
import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';

function fixture({ configured = false } = {}) {
  const config = { ...deriveWeixinBotIdentity('test-account'), accountId: 'test-account', ownerUserId: 'owner', baseUrl: 'https://ilinkai.weixin.qq.com/' };
  const accounts = new Map(configured ? [[config.botId, config]] : []);
  const tokens = new Map(configured ? [[config.tokenRef, 'private-token']] : []);
  const logs = [];
  const logger = { warn: (...args) => logs.push(args), error: (...args) => logs.push(args), info: (...args) => logs.push(args) };
  const credentials = { resolve: async ref => tokens.has(ref) ? { value: tokens.get(ref) } : undefined,
    set: async (ref, value) => tokens.set(ref, value), unset: async ref => tokens.delete(ref) };
  const configStore = { list: () => [...accounts.values()], get: id => accounts.get(id),
    getByAccountId: id => [...accounts.values()].find(account => account.accountId === id),
    save: async account => { accounts.set(account.botId, account); return account; },
    remove: async id => { const previous = accounts.get(id); accounts.delete(id); return previous; } };
  const api = { beginLogin: async () => { throw new Error('override beginLogin'); }, pollLogin: async () => ({ status: 'expired' }) };
  const runtimes = [];
  const options = { api, configStore, credentials, logger, createRuntime: async () => {
    const runtime = { status: { ready: false, weixinConnectionState: 'idle', harnessReachable: true },
      start: async () => { runtime.status.ready = true; runtime.status.weixinConnectionState = 'connected'; },
      stop: async () => { runtime.status.ready = false; }, sendConnectionTest: async () => {} };
    runtimes.push(runtime);
    return runtime;
  } };
  return { config, accounts, tokens, logs, options, credentials, configStore, api, runtimes };
}

test('QR failures retain their cause and one log reference across controller and RPC', async t => {
  for (const code of ['network-error', 'timeout', 'http-error', 'invalid-qr']) {
    const fx = fixture();
    fx.api.beginLogin = async () => { throw new WeixinApiError(code, 'private-token https://secret.test/?qrcode=secret', {
      status: code === 'http-error' ? 403 : undefined,
      cause: Object.assign(new Error('private-network-detail'), { code: 'ENOTFOUND' }),
    }); };
    const controller = new WeixinController(fx.options);
    t.after(() => controller.close());
    const result = await createWeixinRpcHandler(controller, { logger: fx.options.logger })('provision.begin', {});
    assert.equal(result.error.code, code);
    assert.equal(result.error.details.stage, 'qr.begin');
    assert.match(result.error.details.referenceId, /^WX-CONN-[A-F0-9]{8}$/);
    assert.match(JSON.stringify(fx.logs), new RegExp(result.error.details.referenceId));
    assert.equal(fx.logs.length, 1);
    assert.doesNotMatch(JSON.stringify([result, fx.logs]), /private-token|private-network-detail|secret\.test/);
  }
});

test('restore and manual reconnect distinguish unreadable credentials from missing credentials', async t => {
  const fx = fixture({ configured: true });
  fx.credentials.resolve = async () => { throw Object.assign(new Error('private credential path'), { code: 'EACCES' }); };
  const controller = new WeixinController(fx.options);
  t.after(() => controller.close());
  await controller.initialize();
  assert.equal(controller.status().bots[0].error.code, 'credential-read-failed');
  const result = await createWeixinRpcHandler(controller, { logger: fx.options.logger })('bot.reconnect', { botId: fx.config.botId });
  assert.equal(result.error.code, 'credential-read-failed');
  assert.equal(result.error.details.reason, 'EACCES');
  assert.equal(result.error.details.referenceId, controller.status().bots[0].error.details.referenceId);
  fx.credentials.resolve = async () => undefined;
  await controller.initialize();
  assert.equal(controller.status().bots[0].error.code, 'missing-token');
  assert.equal(fx.runtimes.length, 0);
});

test('removal identifies credential failure and leaves the configured account recoverable', async t => {
  const fx = fixture({ configured: true });
  fx.credentials.unset = async () => { throw Object.assign(new Error('private credential backend'), { code: 'EPERM' }); };
  const controller = new WeixinController(fx.options);
  t.after(() => controller.close());
  await controller.initialize();
  const result = await createWeixinRpcHandler(controller, { logger: fx.options.logger })('bot.delete', { botId: fx.config.botId, confirm: true });
  assert.equal(result.error.code, 'credential-remove-failed');
  assert.equal(result.error.details.reason, 'EPERM');
  assert.equal(result.error.details.rollback, 'succeeded');
  assert.equal(controller.status().totals.connected, 1);
  assert.equal(fx.tokens.size, 1);
});

test('successful removal returns a cleanup warning without restoring the deleted account', async t => {
  const fx = fixture({ configured: true });
  fx.options.deleteState = async () => { throw Object.assign(new Error('private state path'), { code: 'EACCES' }); };
  const controller = new WeixinController(fx.options);
  t.after(() => controller.close());
  const result = await createWeixinRpcHandler(controller, { logger: fx.options.logger })('bot.delete', { botId: fx.config.botId, confirm: true });
  assert.equal(result.ok, true);
  assert.equal(result.value.totals.configured, 0);
  assert.equal(result.value.warnings[0].code, 'account-state-cleanup-failed');
  assert.equal(fx.tokens.size, 0);
});

test('diagnostics redact arbitrary error data, deduplicate retries, and survive a broken logger', () => {
  const logs = [];
  let time = 0;
  const diagnostics = createWeixinDiagnostics({ now: () => time, logger: {
    error: text => logs.push(text), warn: text => logs.push(text), info: text => logs.push(text),
  } });
  const secret = 'private-token-should-never-appear';
  const cause = Object.assign(new Error(secret), { code: secret, providerCode: secret, status: 999, token: secret });
  cause.cause = cause;
  const context = { operation: 'connection.restore', stage: 'connection.start', automatic: true };
  const first = diagnostics.report(cause, context);
  const second = diagnostics.report(cause, context);
  assert.equal(first.publicError.details.referenceId, second.publicError.details.referenceId);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(JSON.stringify([first.publicError, logs]), new RegExp(secret));
  time += 60_001;
  const third = diagnostics.report(cause, context);
  assert.notEqual(first.publicError.details.referenceId, third.publicError.details.referenceId);
  assert.match(logs[1], /connection-retries/);
  assert.equal(diagnostics.report(third), third);
  assert.doesNotThrow(() => createWeixinDiagnostics({ logger: { error() { throw new Error('logger failed'); } } }).report(cause));
});

test('read-only credential errors use provider evidence and never error-message guesses', async t => {
  const fx = fixture({ configured: true });
  fx.credentials.unset = async () => { throw new Error('private readonly-source detail'); };
  fx.credentials.describe = async () => ({ writable: false });
  const controller = new WeixinController(fx.options);
  t.after(() => controller.close());
  const handler = createWeixinRpcHandler(controller, { logger: fx.options.logger });
  let result = await handler('bot.delete', { botId: fx.config.botId, confirm: true });
  assert.equal(result.error.details.reason, 'read-only');
  fx.credentials.describe = () => { throw new Error('description failed'); };
  result = await handler('bot.delete', { botId: fx.config.botId, confirm: true });
  assert.equal(result.error.code, 'credential-remove-failed');
  assert.equal(result.error.details.reason, 'unknown');
});

test('committed removal observer failure is a warning and never resurrects a token', async t => {
  const fx = fixture({ configured: true });
  fx.configStore.remove = async id => { fx.accounts.delete(id); throw new Error('workspace cleanup failed'); };
  const controller = new WeixinController(fx.options);
  t.after(() => controller.close());
  const result = await createWeixinRpcHandler(controller)('bot.delete', { botId: fx.config.botId, confirm: true });
  assert.equal(result.ok, true);
  assert.equal(result.value.warnings[0].code, 'workspace-cleanup-failed');
  assert.equal(fx.tokens.size, 0);
  assert.equal(fx.runtimes.length, 0);
});

test('rollback failures retain the primary removal failure and link their log references', async t => {
  const fx = fixture({ configured: true });
  fx.credentials.unset = async () => { throw Object.assign(new Error('private original'), { code: 'EACCES' }); };
  fx.credentials.set = async () => { throw new Error('private rollback'); };
  const controller = new WeixinController(fx.options);
  t.after(() => controller.close());
  const result = await createWeixinRpcHandler(controller)('bot.delete', { botId: fx.config.botId, confirm: true });
  assert.equal(result.error.code, 'credential-remove-failed');
  assert.equal(result.error.details.rollback, 'failed');
  assert.ok(fx.logs.some(args => args[0].includes(`"parentReferenceId":"${result.error.details.referenceId}"`)));
  assert.doesNotMatch(JSON.stringify([result, fx.logs]), /private original|private rollback/);
});

test('a stale login reported by the real monitor reaches the account card with its business code', async t => {
  const fx = fixture({ configured: true });
  fx.options.createRuntime = async ({ config, token }) => new WeixinRuntime({
    config, token, logger: fx.options.logger,
    harness: { ensureRunning: async () => {} },
    state: { bindContextTokens: async () => {}, getUpdatesBuf: () => '' },
    api: { sendText: async () => {}, notifyStart: async () => {}, notifyStop: async () => {}, getUpdates: async () => ({ ret: '0', errcode: -14 }) },
  });
  const controller = new WeixinController(fx.options);
  t.after(() => controller.close());
  await controller.initialize();
  await new Promise(resolve => setImmediate(resolve));
  const error = controller.status().bots[0].error;
  assert.equal(error.code, 'stale-token');
  assert.equal(error.details.providerCode, '-14');
  assert.equal(error.details.stage, 'connection.poll');
  assert.doesNotMatch(JSON.stringify(fx.logs), /private-token/);
});

test('front-door Harness failure explains offline accounts without changing healthy ones', async t => {
  const fx = fixture({ configured: true });
  const controller = new WeixinController(fx.options);
  t.after(() => controller.close());
  const error = Object.assign(new Error('private Harness detail'), { code: 'harness-api-not-found' });
  controller.reportRestoreFailure(error);
  assert.equal(controller.status().bots[0].error.code, 'harness-api-not-found');
  await controller.initialize();
  controller.reportRestoreFailure(error);
  assert.equal(controller.status().totals.connected, 1);
  assert.equal(controller.status().bots[0].error, null);
});

test('missing attempts and QR encoding failure have their own safe stages', async t => {
  const fx = fixture();
  fx.api.beginLogin = async () => ({ qrcode: 'private-qr', qrcodeUrl: 'https://liteapp.weixin.qq.com/q/private' });
  const controller = new WeixinController(fx.options);
  t.after(() => controller.close());
  const handler = createWeixinRpcHandler(controller, { logger: fx.options.logger, encodeQr: async () => { throw new Error('private QR url'); } });
  assert.equal((await handler('provision.poll', { attemptId: 'old-attempt' })).error.code, 'provision-attempt-not-found');
  const result = await handler('provision.begin', {});
  assert.equal(result.error.code, 'qr-encode-failed');
  assert.equal(result.error.details.stage, 'qr.encode');
  assert.doesNotMatch(JSON.stringify([result, fx.logs]), /private/);
});

test('diagnostic copy is translated and never guesses a credential error from an HTTP status', () => {
  setImHostLanguage('en');
  try {
    const error = createWeixinDiagnostics({ logger: {} }).report(new WeixinApiError('http-error', 'private', { status: 403 }), { operation: 'provision.begin', stage: 'qr.begin' }).publicError;
    assert.equal(error.code, 'http-error');
    assert.match(error.message, /HTTP 403/);
    assert.doesNotMatch(JSON.stringify(error), /[\p{Script=Han}]/u);
    const stored = createWeixinDiagnostics({ logger: {} }).report(weixinStageError('account-state-read-failed', new SyntaxError('private JSON'))).publicError;
    assert.equal(stored.details.reason, 'invalid-json');
    assert.doesNotMatch(JSON.stringify(stored), /[\p{Script=Han}]/u);
  } finally { setImHostLanguage('zh'); }
});

test('network evidence and response parsing advice identify the service that actually failed', () => {
  const diagnostics = createWeixinDiagnostics({ logger: {} });
  for (const reason of ['ENOTFOUND', 'ECONNREFUSED', 'CERT_HAS_EXPIRED', 'ECONNRESET']) {
    const error = diagnostics.report(new WeixinApiError('network-error', 'private URL and proxy password', {
      cause: Object.assign(new Error('private'), { code: reason }),
    }), { operation: 'provision.begin', stage: 'qr.begin' }).publicError;
    assert.equal(error.details.reason, reason);
    assert.doesNotMatch(JSON.stringify(error), /private/);
  }
  const harnessError = diagnostics.report(Object.assign(new Error('private'), {
    code: 'harness-connect-failed', cause: Object.assign(new Error(), { code: 'ENOTFOUND' }),
  })).publicError;
  assert.doesNotMatch(harnessError.details.hint, /微信服务域名/);
  const responseError = diagnostics.report(new WeixinApiError('invalid-response', 'private response', { cause: new SyntaxError('private JSON') })).publicError;
  assert.doesNotMatch(responseError.details.hint, /本机文件/);
});

test('an unreadable post-delete response is reported as uncertain status, not an account removal failure', async t => {
  const fx = fixture({ configured: true });
  const controller = new WeixinController(fx.options);
  t.after(() => controller.close());
  const remove = controller.deleteBot.bind(controller);
  controller.deleteBot = async id => ({ ...await remove(id), invalid: () => {} });
  const result = await createWeixinRpcHandler(controller, { logger: fx.options.logger })('bot.delete', { botId: fx.config.botId, confirm: true });
  assert.equal(result.error.code, 'status-read-failed');
  assert.equal(result.error.details.stage, 'status.read');
  assert.equal(fx.accounts.size, 0);
  assert.equal(fx.tokens.size, 0);
});
