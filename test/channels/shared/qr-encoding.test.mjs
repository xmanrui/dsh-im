import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PNG } from 'pngjs';
import { createWeixinRpcHandler } from '../../../plugin-src/host/channels/weixin/rpc.mjs';
import { createFeishuRpcHandler } from '../../../plugin-src/host/channels/feishu/rpc.mjs';
import { createDingtalkRpcHandler } from '../../../plugin-src/host/channels/dingtalk/rpc.mjs';
import { createWecomRpcHandler } from '../../../plugin-src/host/channels/wecom/rpc.mjs';
import { createQqRpcHandler } from '../../../plugin-src/host/channels/qq/rpc.mjs';
import { createWhatsappRpcHandler } from '../../../plugin-src/host/channels/whatsapp/rpc.mjs';
import { createConnectionDiagnostics } from '../../../src/channels/shared/connection-error.mjs';
import { normalizeDiagnosticDetails, safeDiagnosticMessage } from '../../../src/channels/shared/diagnostic-details.mjs';
import { qrEncodingError } from '../../../src/channels/shared/qr-encoding-error.mjs';
import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import { ConnectionError, formatConnectionDiagnostic, normalizeConnectionError } from '../../../plugin-src/client/connection-error.js';

const factories = {
  weixin: createWeixinRpcHandler, feishu: createFeishuRpcHandler,
  dingtalk: createDingtalkRpcHandler, wecom: createWecomRpcHandler,
  qq: createQqRpcHandler, whatsapp: createWhatsappRpcHandler,
};
const fakePng = 'data:image/png;base64,YWJjZA==';
const privateText = 'private-token https://user:password@private.example/?secret=secret';
const require = createRequire(import.meta.url);
const qrcodeRequire = createRequire(require.resolve('qrcode/package.json'));
const expectedDependencies = normalizeDiagnosticDetails({ dependencies: {
  qrcode: require('qrcode/package.json').version,
  pngjs: qrcodeRequire('pngjs/package.json').version,
  zlib: process.versions.zlib,
} }).dependencies;

function fixture(channel, encodeQr) {
  let url = 'https://accounts.feishu.cn/private-qr-value';
  let begins = 0;
  const logs = [];
  const logger = { error: value => logs.push(value), warn: value => logs.push(value) };
  const attempt = () => ({ attemptId: '1', status: 'pending', verificationUrl: url, qrValue: url });
  const status = () => channel === 'feishu'
    ? { phase: 'registering', registration: { state: 'qr_ready', attempt: 1, qrCodeUrl: url, expiresAt: Date.now() + 60_000 } }
    : { bots: [], provisioning: attempt() };
  const controller = {
    diagnostics: createConnectionDiagnostics({ channel, logger }),
    status,
    startProvisioning: async () => { begins += 1; return attempt(); },
    startRegistration: async () => { begins += 1; return status(); },
    registrationStatus: async () => channel === 'feishu' ? status() : attempt(),
    submitVerification: async () => attempt(),
    cancelProvisioning: async () => attempt(), cancelRegistration: async () => status(),
    disconnect: async () => status(), bindCredentials: async () => status(),
    reconnectBot: async () => status(), deleteBot: async () => status(),
    approveSender: async () => status(), revokeSender: async () => status(),
  };
  const handler = factories[channel](controller, { logger, ...(encodeQr ? { encodeQr } : {}) });
  return { handler, logs, setUrl(value) { url = value; }, get begins() { return begins; } };
}

function qrImage(result) {
  return result.value?.qrCodeDataUrl ?? result.value?.provisioning?.qrCodeDataUrl;
}

for (const channel of Object.keys(factories)) {
  for (const synchronous of [true, false]) {
    test(`${channel}: ${synchronous ? 'thrown' : 'rejected'} QR failure remains diagnosable and the same attempt can retry`, async () => {
      let calls = 0;
      const code = synchronous ? 'ERR_INVALID_ARG_TYPE' : 'ERR_ZLIB_INITIALIZATION_FAILED';
      const leaf = Object.assign(new TypeError(privateText), { code });
      const cause = new Error(privateText, { cause: leaf });
      const fx = fixture(channel, () => {
        calls += 1;
        if (calls !== 1) return fakePng;
        if (synchronous) throw cause;
        return Promise.reject(cause);
      });
      const failed = await fx.handler('provision.begin', {});
      assert.equal(failed.ok, false);
      if (channel === 'weixin') assert.equal(failed.error.code, 'qr-encode-failed');
      const details = failed.error.details;
      assert.equal(details.stage, 'qr.encode');
      assert.equal(details.operation, 'provision.begin');
      assert.equal(details.reason, code);
      assert.deepEqual(details.errorTypes, ['Error', 'TypeError']);
      assert.equal(details.qrEncoder, 'qrcode');
      assert.equal(details.qrRenderer, 'png');
      assert.deepEqual(details.dependencies, expectedDependencies);
      assert.equal(fx.logs.length, 1);
      assert.ok(fx.logs[0].includes(details.referenceId));
      assert.ok(fx.logs[0].includes(code));

      const api = await import(`../../../plugin-src/client/channels/${channel}/api.js`);
      let displayed;
      assert.throws(() => api.unwrapRpcResult(failed), error => {
        displayed = api.presentError?.(error) ?? error;
        return true;
      });
      assert.deepEqual(displayed.details.dependencies, expectedDependencies);
      const text = formatConnectionDiagnostic(displayed);
      const markup = renderToStaticMarkup(React.createElement(ConnectionError, { error: displayed }));
      for (const output of [text, markup]) {
        assert.ok(output.includes(code));
        assert.ok(output.includes('TypeError'));
        assert.ok(output.includes('qrcode'));
        assert.ok(output.includes(expectedDependencies.pngjs));
      }
      assert.doesNotMatch(JSON.stringify([failed, fx.logs, text, markup]), /private-token|password|private.example|private-qr-value/);

      const retried = await fx.handler('provision.poll', { attemptId: '1' });
      assert.equal(retried.ok, true);
      assert.equal(qrImage(retried), fakePng);
      assert.equal(calls, 2);
      assert.equal(fx.begins, 1, 'retry must reuse the active login attempt');
      const cached = await fx.handler('connection.status', {});
      assert.equal(qrImage(cached), fakePng);
      assert.equal(calls, 2, 'successful encodings remain cached');
    });
  }

  test(`${channel}: concurrent requests share an encoding failure and then retry`, async () => {
    const pending = Promise.withResolvers();
    const entered = Promise.withResolvers();
    let calls = 0;
    const fx = fixture(channel, () => {
      calls += 1;
      entered.resolve();
      return calls === 1 ? pending.promise : fakePng;
    });
    const requests = [fx.handler('connection.status', {}), fx.handler('connection.status', {})];
    await entered.promise;
    pending.reject(new RangeError(privateText));
    const results = await Promise.all(requests);
    assert.equal(calls, 1);
    for (const result of results) {
      assert.equal(result.ok, false);
      assert.equal(result.error.details.stage, 'qr.encode');
      assert.deepEqual(result.error.details.errorTypes, ['RangeError']);
    }
    assert.equal(qrImage(await fx.handler('connection.status', {})), fakePng);
    assert.equal(calls, 2);
  });

  test(`${channel}: late failure of an evicted encoding cannot delete its replacement`, async () => {
    const old = Promise.withResolvers();
    const entered = Promise.withResolvers();
    let calls = 0;
    const fx = fixture(channel, () => {
      calls += 1;
      entered.resolve();
      return calls === 1 ? old.promise : fakePng;
    });
    const first = fx.handler('connection.status', {});
    await entered.promise;
    const limit = channel === 'feishu' ? 32 : 16;
    for (let i = 0; i < limit; i += 1) {
      fx.setUrl(`https://accounts.feishu.cn/private-qr-${i}`);
      assert.equal((await fx.handler('connection.status', {})).ok, true);
    }
    fx.setUrl('https://accounts.feishu.cn/private-qr-value');
    assert.equal(qrImage(await fx.handler('connection.status', {})), fakePng);
    const before = calls;
    old.reject(new Error(privateText));
    assert.equal((await first).ok, false);
    assert.equal(qrImage(await fx.handler('connection.status', {})), fakePng);
    assert.equal(calls, before);
  });

  test(`${channel}: the real default encoder still produces a decodable PNG`, async () => {
    const fx = fixture(channel);
    const result = await fx.handler('provision.begin', {});
    assert.equal(result.ok, true);
    const image = qrImage(result);
    assert.match(image, /^data:image\/png;base64,/);
    const decoded = PNG.sync.read(Buffer.from(image.split(',')[1], 'base64'));
    assert.equal(decoded.width, 320);
    assert.equal(decoded.height, 320);
    assert.equal(fx.logs.length, 0);
  });
}

test('QR diagnostics retain standard errors but exclude untrusted fields and exception text', () => {
  const logger = { error() {} };
  const diagnostics = createConnectionDiagnostics({ channel: 'feishu', logger });
  for (const code of ['ERR_INVALID_ARG_VALUE', 'ERR_OUT_OF_RANGE', 'ERR_BUFFER_OUT_OF_BOUNDS',
    'ERR_STREAM_DESTROYED', 'ERR_STREAM_PREMATURE_CLOSE', 'Z_STREAM_ERROR', 'Z_DATA_ERROR',
    'Z_MEM_ERROR', 'Z_BUF_ERROR', 'Z_VERSION_ERROR', 'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND']) {
    const error = Object.assign(new ReferenceError(privateText), { code });
    const result = diagnostics.report(qrEncodingError(error)).publicError;
    assert.equal(result.details.reason, code);
    assert.deepEqual(result.details.errorTypes, ['ReferenceError']);
    assert.doesNotMatch(JSON.stringify(result), /private-token|password|private.example/);
  }
  const untrusted = Object.assign(new Error(privateText), {
    name: privateText, code: privateText,
    details: { errorTypes: [privateText], qrEncoder: privateText, qrRenderer: privateText, dependencies: { qrcode: privateText } },
  });
  const result = diagnostics.report(qrEncodingError(untrusted)).publicError;
  assert.equal(result.details.reason, 'unknown');
  assert.deepEqual(result.details.errorTypes, ['Error']);
  assert.doesNotMatch(JSON.stringify(result), /private-token|password|private.example/);
  assert.deepEqual(normalizeDiagnosticDetails(untrusted.details), {});
  assert.deepEqual(normalizeDiagnosticDetails({ dependencies: { qrcode: '1.5.4', pngjs: '5.0.0', secret: '1.0.0' }, errorTypes: ['RangeError', privateText, 'RangeError'] }), {
    errorTypes: ['RangeError'], dependencies: { qrcode: '1.5.4', pngjs: '5.0.0' },
  });
});

test('QR diagnostics preserve cancellation and translate the actionable hint', () => {
  const abort = new DOMException(privateText, 'AbortError');
  assert.equal(qrEncodingError(abort), abort);
  setImHostLanguage('en');
  try {
    const result = createConnectionDiagnostics({ channel: 'qq', logger: {} })
      .report(qrEncodingError(new Error(privateText))).publicError;
    assert.match(result.details.hint, /QR-code image/);
    assert.doesNotMatch(result.details.hint, /[\p{Script=Han}]/u);
  } finally { setImHostLanguage('zh'); }
});

test('QR diagnostics keep the local library message that identifies the failure', () => {
  const diagnostics = createConnectionDiagnostics({ channel: 'feishu', logger: { error() {} } });
  const leaf = Object.assign(new TypeError('QRCode.toDataURL is not a function'), { code: 'ERR_INVALID_ARG_TYPE' });
  const result = diagnostics.report(qrEncodingError(new Error('QR encode failed', { cause: leaf }))).publicError;
  assert.equal(result.details.causeMessage, 'QRCode.toDataURL is not a function');
  assert.equal(result.details.reason, 'ERR_INVALID_ARG_TYPE');
  assert.deepEqual(result.details.errorTypes, ['Error', 'TypeError']);

  // The message reaches the copyable diagnostics the reporter sends upstream.
  const text = formatConnectionDiagnostic(normalizeConnectionError(result));
  assert.match(text, /causeMessage: QRCode\.toDataURL is not a function/);
});

test('safeDiagnosticMessage admits local library diagnostics only', () => {
  for (const accepted of [
    'QRCode.toDataURL is not a function',
    'PNG.sync.write is not a constructor',
    'String required as first argument',
    "Cannot read properties of undefined (reading 'length')",
    'invalid stored block lengths',
    'incorrect header check',
    'padding not multiple of block size',
  ]) assert.equal(safeDiagnosticMessage(accepted), accepted, accepted);

  for (const rejected of [
    'private QR url',
    'failed to open the verification page',
    'failed to open https://accounts.feishu.cn/page/verify?code=abc',
    'invalid token abcdef',
    'auth for user@example.com failed',
    'A'.repeat(32),
    '本机二维码图片生成失败',
    '',
    undefined,
    null,
  ]) assert.equal(safeDiagnosticMessage(rejected), undefined, String(rejected));

  assert.deepEqual(normalizeDiagnosticDetails({ causeMessage: 'https://example.com/secret' }), {});
  assert.deepEqual(normalizeDiagnosticDetails({ causeMessage: 'private QR url' }), {});
  assert.deepEqual(normalizeDiagnosticDetails({ causeMessage: 'Invalid data' }), {
    causeMessage: 'Invalid data',
  });
});
