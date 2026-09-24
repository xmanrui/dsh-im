import test from 'node:test';
import assert from 'node:assert/strict';
import { RegistrationManager } from '../../../src/channels/feishu/registration-manager.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeClock() {
  let time = 0;
  let sequence = 0;
  const timers = new Map();

  return {
    now: () => time,
    setTimeout(fn, delay) {
      const id = ++sequence;
      timers.set(id, { at: time + delay, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(milliseconds) {
      const target = time + milliseconds;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        time = timer.at;
        timer.fn();
      }
      time = target;
    },
  };
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('RegistrationManager captures QR countdown and SDK polling states', async () => {
  const clock = fakeClock();
  const registration = deferred();
  let sdkOptions;
  const manager = new RegistrationManager({
    registerApp: (options) => {
      sdkOptions = options;
      return registration.promise;
    },
    onCredentials: async () => {},
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });

  assert.deepEqual(manager.start({ source: 'dsh-feishu' }), {
    state: 'starting',
    attempt: 1,
    updatedAt: 0,
  });
  await flushPromises();
  assert.equal(sdkOptions.source, 'dsh-feishu');
  assert.ok(sdkOptions.signal instanceof AbortSignal);

  sdkOptions.onQRCodeReady({ url: 'https://accounts.feishu.cn/device', expireIn: 5 });
  assert.deepEqual(manager.status(), {
    state: 'qr_ready',
    attempt: 1,
    updatedAt: 0,
    qrCodeUrl: 'https://accounts.feishu.cn/device',
    expiresAt: 5000,
    remainingSeconds: 5,
  });

  clock.advance(1200);
  assert.equal(manager.status().remainingSeconds, 4);

  sdkOptions.onStatusChange({ status: 'polling' });
  assert.equal(manager.status().state, 'polling');

  sdkOptions.onStatusChange({ status: 'slow_down', interval: 10 });
  assert.equal(manager.status().state, 'slow_down');
  assert.equal(manager.status().pollIntervalSeconds, 10);

  sdkOptions.onStatusChange({ status: 'domain_switched' });
  assert.equal(manager.status().state, 'domain_switched');
  assert.equal(manager.status().remainingSeconds, 4);

  manager.cancel();
});

test('RegistrationManager only sends credentials to callback and never exposes the secret', async () => {
  const registration = deferred();
  const persistence = deferred();
  const received = [];
  let sdkOptions;
  const manager = new RegistrationManager({
    registerApp: (options) => {
      sdkOptions = options;
      return registration.promise;
    },
    onCredentials: (credentials) => {
      received.push(credentials);
      return persistence.promise;
    },
  });

  manager.start();
  await flushPromises();
  sdkOptions.onQRCodeReady({ url: 'https://example.test/qr', expireIn: 60 });
  registration.resolve({
    client_id: 'cli_test',
    client_secret: 'super-secret-value',
    user_info: { open_id: 'ou_test', tenant_brand: 'feishu' },
    unexpected: 'must-not-be-forwarded',
  });
  await flushPromises();

  assert.deepEqual(received, [{
    client_id: 'cli_test',
    client_secret: 'super-secret-value',
    user_info: { open_id: 'ou_test', tenant_brand: 'feishu' },
  }]);
  assert.equal(manager.status().state, 'saving');
  assert.equal('qrCodeUrl' in manager.status(), false);
  assert.equal('remainingSeconds' in manager.status(), false);
  assert.doesNotMatch(JSON.stringify(manager.status()), /super-secret-value|client_secret/);

  persistence.resolve();
  await flushPromises();
  assert.equal(manager.status().state, 'succeeded');
  assert.doesNotMatch(JSON.stringify(manager.status()), /super-secret-value|client_secret|cli_test|ou_test/);
});

test('a concurrent start aborts and ignores the previous attempt', async () => {
  const registrations = [deferred(), deferred()];
  const sdkCalls = [];
  const received = [];
  const manager = new RegistrationManager({
    registerApp: (options) => {
      const index = sdkCalls.length;
      sdkCalls.push(options);
      return registrations[index].promise;
    },
    onCredentials: async (credentials) => received.push(credentials.client_id),
  });

  manager.start();
  await flushPromises();
  manager.start();
  assert.equal(sdkCalls[0].signal.aborted, true);
  assert.equal(manager.status().attempt, 2);
  await flushPromises();

  sdkCalls[0].onQRCodeReady({ url: 'https://stale.test', expireIn: 30 });
  registrations[0].resolve({ client_id: 'cli_stale', client_secret: 'stale-secret' });
  registrations[1].resolve({ client_id: 'cli_current', client_secret: 'current-secret' });
  await flushPromises();
  await flushPromises();

  assert.deepEqual(received, ['cli_current']);
  assert.equal(manager.status().state, 'succeeded');
  assert.doesNotMatch(JSON.stringify(manager.status()), /stale-secret|current-secret/);
});

test('cancel is terminal and ignores a late SDK result', async () => {
  const registration = deferred();
  const received = [];
  let sdkOptions;
  const manager = new RegistrationManager({
    registerApp: (options) => {
      sdkOptions = options;
      return registration.promise;
    },
    onCredentials: async (credentials) => received.push(credentials),
  });

  manager.start();
  await flushPromises();
  const status = manager.cancel();

  assert.equal(status.state, 'cancelled');
  assert.equal(status.error.code, 'abort');
  assert.equal(sdkOptions.signal.aborted, true);

  registration.resolve({ client_id: 'cli_late', client_secret: 'late-secret' });
  await flushPromises();
  assert.deepEqual(received, []);
  assert.equal(manager.status().state, 'cancelled');
  assert.doesNotMatch(JSON.stringify(manager.status()), /late-secret/);
});

test('QR expiry aborts polling and reports an explicit expired state', async () => {
  const clock = fakeClock();
  const registration = deferred();
  let sdkOptions;
  const manager = new RegistrationManager({
    registerApp: (options) => {
      sdkOptions = options;
      return registration.promise;
    },
    onCredentials: async () => assert.fail('expired credentials must not be stored'),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });

  manager.start();
  await flushPromises();
  sdkOptions.onQRCodeReady({ url: 'https://example.test/expiring', expireIn: 3 });
  clock.advance(2999);
  assert.equal(manager.status().remainingSeconds, 1);
  clock.advance(1);

  assert.equal(manager.status().state, 'expired');
  assert.equal(manager.status().error.code, 'expired_token');
  assert.equal('qrCodeUrl' in manager.status(), false);
  assert.equal(sdkOptions.signal.aborted, true);
});

test('SDK expiration and errors become distinct safe terminal states', async (t) => {
  await t.test('expired_token is expired', async () => {
    const manager = new RegistrationManager({
      registerApp: async () => {
        throw { code: 'expired_token', description: 'Polling timed out' };
      },
      onCredentials: async () => {},
    });
    manager.start();
    await flushPromises();
    assert.equal(manager.status().state, 'expired');
    assert.equal(manager.status().error.code, 'expired_token');
  });

  await t.test('unknown error does not reflect its message', async () => {
    const manager = new RegistrationManager({
      registerApp: async () => {
        throw new Error('request failed with client_secret=do-not-leak');
      },
      onCredentials: async () => {},
    });
    manager.start();
    await flushPromises();
    const status = manager.status();
    assert.equal(status.state, 'error');
    assert.equal(status.error.code, 'registration_failed');
    assert.doesNotMatch(JSON.stringify(status), /do-not-leak|client_secret/);
  });
});

test('credential persistence failure is safe and does not expose the secret', async () => {
  const manager = new RegistrationManager({
    registerApp: async () => ({
      client_id: 'cli_test',
      client_secret: 'secret-mentioned-by-callback',
      user_info: { open_id: 'ou_test' },
    }),
    onCredentials: async ({ client_secret: secret }) => {
      throw new Error(`failed to persist ${secret}`);
    },
  });

  manager.start();
  await flushPromises();
  await flushPromises();
  const status = manager.status();
  assert.equal(status.state, 'error');
  assert.equal(status.error.code, 'credentials_callback_failed');
  assert.doesNotMatch(JSON.stringify(status), /secret-mentioned-by-callback|client_secret/);
});
