import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeDingtalkConnectionFailure,
  dingtalkPublicConnectionError,
  dingtalkRuntimeStartError,
  installedDingtalkConnectionDependencies,
} from '../../../src/channels/dingtalk/connection-error.mjs';

const FIXED_REFERENCE = 'DT-CONN-DEADBEEF';

test('connection diagnostics identify the pnpm mirror proxy dependency failure without leaking values', () => {
  const cause = new Error(
    'request for client-id-private failed via https://name:password@proxy.example because clientSecret=secret-private',
  );
  cause.name = 'AxiosError';
  cause.code = 'ECONNRESET';
  cause.response = { status: 502, data: { code: 'GatewayFailure' } };
  const error = dingtalkRuntimeStartError('dingtalk-stream-connect-failed', cause);

  const failure = describeDingtalkConnectionFailure(error, {
    clientId: 'client-id-private',
    clientSecret: 'secret-private',
    environment: { HTTPS_PROXY: 'https://name:password@proxy.example' },
    dependencies: {
      dingtalkStream: '2.1.4',
      axios: '1.19.0',
      httpsProxyAgent: '5.0.1',
      agentBase: '6.0.0',
    },
    nodeVersion: '24.19.0',
    referenceId: FIXED_REFERENCE,
  });

  assert.deepEqual(failure.publicError, {
    code: 'stream-proxy-dependency-incompatible',
    message: '钉钉 Stream 连接失败：检测到代理依赖 agent-base 6.0.0。',
    hint: '请将 DSH profile 中的 agent-base@6 固定为 6.0.2 后重新安装依赖，或升级 pnpm 后重新解析 lockfile。',
    referenceId: FIXED_REFERENCE,
  });
  assert.equal(failure.diagnostic.stage, 'dingtalk-stream-connect-failed');
  assert.deepEqual(failure.diagnostic.proxy, {
    configured: true,
    variables: ['HTTPS_PROXY'],
  });
  assert.equal(failure.diagnostic.dependencies.agentBase, '6.0.0');
  assert.equal(failure.diagnostic.errors.at(-1).providerCode, 'GatewayFailure');
  assert.doesNotMatch(
    JSON.stringify(failure.diagnostic),
    /client-id-private|secret-private|name:password/,
  );
});

test('connection diagnostics classify common stages and keep a public-only RPC projection', () => {
  const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.dingtalk.com'), {
    code: 'ENOTFOUND',
  });
  const staged = dingtalkRuntimeStartError('dingtalk-stream-connect-failed', cause);
  const failure = describeDingtalkConnectionFailure(staged, {
    environment: {},
    dependencies: { agentBase: '6.0.2' },
    referenceId: FIXED_REFERENCE,
  });

  assert.equal(failure.publicError.code, 'stream-dns-failed');
  assert.match(failure.publicError.message, /无法解析/);
  const outward = dingtalkPublicConnectionError(failure.publicError, staged);
  assert.equal(outward.name, 'DingtalkPublicConnectionError');
  assert.deepEqual(outward.publicError, failure.publicError);
  assert.equal(outward.cause, staged);
});

test('installed connection diagnostics follow the DingTalk dependency chain', () => {
  const versions = installedDingtalkConnectionDependencies();
  assert.match(versions.dingtalkStream, /^\d+\.\d+\.\d+/);
  assert.match(versions.axios, /^\d+\.\d+\.\d+/);
  assert.match(versions.httpsProxyAgent, /^\d+\.\d+\.\d+/);
  assert.match(versions.agentBase, /^6\./);
});
