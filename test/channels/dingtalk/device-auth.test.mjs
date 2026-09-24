import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DingtalkDeviceAuth,
  DingtalkDeviceAuthError,
} from '../../../src/channels/dingtalk/device-auth.mjs';

function fetchFixture(responses) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => responses.shift(),
      };
    },
  };
}

test('device auth performs init then begin with the fixed DingTalk registration source', async () => {
  const fixture = fetchFixture([
    { errcode: 0, nonce: 'nonce-private' },
    {
      errcode: 0,
      device_code: 'device-private',
      user_code: 'user-code',
      verification_uri: 'https://oapi.dingtalk.com/verify',
      verification_uri_complete: 'https://oapi.dingtalk.com/verify?user_code=user-code',
      expires_in: 120,
      interval: 3,
    },
  ]);
  const auth = new DingtalkDeviceAuth({ fetch: fixture.fetch, clock: () => 10_000 });

  const result = await auth.start();

  assert.deepEqual(fixture.calls.map((call) => call.url), [
    'https://oapi.dingtalk.com/app/registration/init',
    'https://oapi.dingtalk.com/app/registration/begin',
  ]);
  assert.deepEqual(JSON.parse(fixture.calls[0].init.body), { source: 'DING_DWS_CLAW' });
  assert.deepEqual(JSON.parse(fixture.calls[1].init.body), { nonce: 'nonce-private' });
  assert.equal(fixture.calls[0].init.redirect, 'error');
  assert.equal(result.deviceCode, 'device-private');
  assert.equal(result.verificationUrl, 'https://oapi.dingtalk.com/verify?user_code=user-code');
  assert.equal(result.expiresAt, 130_000);
  assert.equal(result.pollIntervalMs, 3_000);
});

test('device auth polls with a host-only device code and normalizes credentials', async () => {
  const fixture = fetchFixture([{
    errcode: 0,
    status: 'success',
    client_id: 'ding-client',
    client_secret: 'private-secret',
  }]);
  const auth = new DingtalkDeviceAuth({ fetch: fixture.fetch });

  const result = await auth.poll({ deviceCode: 'device-private' });

  assert.equal(fixture.calls[0].url, 'https://oapi.dingtalk.com/app/registration/poll');
  assert.deepEqual(JSON.parse(fixture.calls[0].init.body), { device_code: 'device-private' });
  assert.deepEqual(result, {
    status: 'SUCCESS',
    clientId: 'ding-client',
    clientSecret: 'private-secret',
    failReason: null,
  });
});

test('device auth accepts only default-port HTTPS DingTalk registration hosts', () => {
  const fetch = async () => assert.fail('fetch must not run');
  for (const baseUrl of [
    'http://oapi.dingtalk.com',
    'https://oapi.dingtalk.com:8443',
    'https://example.com',
    'https://dingtalk.com@example.com',
  ]) {
    assert.throws(
      () => new DingtalkDeviceAuth({ fetch, baseUrl }),
      /valid HTTPS URL/,
    );
  }
  assert.doesNotThrow(
    () => new DingtalkDeviceAuth({ fetch, baseUrl: 'https://staging.dingtalk.com/root/' }),
  );
});

test('device auth API failures do not echo remote response details', async () => {
  const fixture = fetchFixture([{
    errcode: 400,
    errmsg: 'do not leak device-private or client-secret-private',
  }]);
  const auth = new DingtalkDeviceAuth({ fetch: fixture.fetch });

  await assert.rejects(
    auth.start(),
    (error) => {
      assert.ok(error instanceof DingtalkDeviceAuthError);
      assert.equal(error.code, 'api-error');
      assert.doesNotMatch(error.message, /device-private|client-secret-private/);
      return true;
    },
  );
});

test('device auth bounds a stalled registration request with a local timeout', async () => {
  const fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const auth = new DingtalkDeviceAuth({ fetch, timeoutMs: 5 });

  await assert.rejects(
    auth.start(),
    (error) => error instanceof DingtalkDeviceAuthError && error.code === 'timeout',
  );
});
