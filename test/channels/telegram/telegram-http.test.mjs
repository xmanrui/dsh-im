import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import test from 'node:test';

import { TelegramApi } from '../../../src/channels/telegram/telegram-api.mjs';
import { createTelegramHttpTransport } from '../../../src/channels/telegram/telegram-http.mjs';
import { TelegramRuntime } from '../../../src/channels/telegram/telegram-runtime.mjs';

const TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456';
const execFileAsync = promisify(execFile);
const packageRoot = resolve(import.meta.dirname, '../../..');

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function bounded(promise, message, timeoutMs = 1_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function listen(server) {
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}/`;
}

async function close(server) {
  await new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
}

function withLocalhostProxyBypass() {
  const names = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.no_proxy = '127.0.0.1,localhost';
  process.env.NO_PROXY = '127.0.0.1,localhost';
  return () => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  };
}

test('Telegram private transport sends while a long poll remains open', async () => {
  const pollStarted = deferred();
  const releasePoll = deferred();
  const events = [];
  const server = createServer((request, response) => {
    request.resume();
    if (request.url.endsWith('/getUpdates')) {
      events.push('poll-started');
      pollStarted.resolve();
      void releasePoll.promise.then(() => {
        events.push('poll-released');
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ ok: true, result: [] }));
      });
      return;
    }
    events.push('send-completed');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, result: true }));
  });
  const baseUrl = await listen(server);
  const restoreProxy = withLocalhostProxyBypass();
  const transport = createTelegramHttpTransport();
  const api = new TelegramApi({
    token: TOKEN,
    baseUrl,
    fetchImpl: transport.fetchImpl,
    FormDataImpl: transport.FormDataImpl,
  });
  let pollSettled = false;
  const poll = api.getUpdates().finally(() => { pollSettled = true; });

  try {
    await bounded(pollStarted.promise, 'Telegram long poll did not start');
    assert.equal(await bounded(
      api.sendChatAction({ chatId: 42 }),
      'Telegram send was blocked behind its long poll',
    ), true);
    assert.equal(pollSettled, false);
    assert.deepEqual(events, ['poll-started', 'send-completed']);
    releasePoll.resolve();
    assert.deepEqual(await poll, []);
    assert.deepEqual(events, ['poll-started', 'send-completed', 'poll-released']);
  } finally {
    releasePoll.resolve();
    await poll.catch(() => undefined);
    await transport.destroy();
    restoreProxy();
    await close(server);
  }
});

test('Telegram private transport is independent from a saturated global dispatcher', async () => {
  const source = String.raw`
    import { createServer } from 'node:http';
    import { Agent, fetch, setGlobalDispatcher } from 'undici';
    import { createTelegramHttpTransport } from './src/channels/telegram/telegram-http.mjs';

    let releaseHold;
    let markHoldStarted;
    const holdStarted = new Promise((resolve) => { markHoldStarted = resolve; });
    const holdReleased = new Promise((resolve) => { releaseHold = resolve; });
    const server = createServer((request, response) => {
      request.resume();
      if (request.url === '/hold') {
        markHoldStarted();
        void holdReleased.then(() => response.end('held'));
        return;
      }
      response.end('private');
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const globalAgent = new Agent({ connections: 1 });
    setGlobalDispatcher(globalAgent);
    const occupied = fetch(origin + '/hold');
    await holdStarted;
    const transport = createTelegramHttpTransport();
    let timeout;
    try {
      const response = await Promise.race([
        transport.fetchImpl(origin + '/send'),
        new Promise((_, reject) => { timeout = setTimeout(
          () => reject(new Error('private transport used the saturated global dispatcher')),
          1_000,
        ); }),
      ]);
      if (await response.text() !== 'private') throw new Error('unexpected private response');
      process.stdout.write('independent');
    } finally {
      clearTimeout(timeout);
      releaseHold();
      await occupied;
      await transport.destroy();
      await globalAgent.destroy();
      await new Promise((resolve, reject) => server.close(
        (error) => error ? reject(error) : resolve(),
      ));
    }
  `;
  const childEnv = { ...process.env };
  for (const name of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY']) {
    delete childEnv[name];
  }
  childEnv.no_proxy = '127.0.0.1,localhost';
  childEnv.NO_PROXY = '127.0.0.1,localhost';
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    '--input-type=module',
    '--eval',
    source,
  ], {
    cwd: packageRoot,
    env: childEnv,
    timeout: 5_000,
  });
  assert.equal(stderr, '');
  assert.equal(stdout, 'independent');
});

test('Telegram API sends real undici multipart data without losing metadata or bytes', async () => {
  const received = deferred();
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received.resolve({
        contentType: request.headers['content-type'],
        body: Buffer.concat(chunks),
      });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, result: { message_id: 901 } }));
    });
  });
  const baseUrl = await listen(server);
  const restoreProxy = withLocalhostProxyBypass();
  const transport = createTelegramHttpTransport();
  const bytes = Buffer.from([0, 1, 2, 3, 0xff, 0x80, 0x41]);
  const api = new TelegramApi({
    token: TOKEN,
    baseUrl,
    fetchImpl: transport.fetchImpl,
    FormDataImpl: transport.FormDataImpl,
  });

  try {
    assert.deepEqual(await api.sendDocument({
      chatId: -100123,
      replyToMessageId: 44,
      messageThreadId: 55,
      file: {
        fileName: 'result.bin',
        mediaType: 'application/octet-stream',
        bytes,
      },
    }), { message_id: 901 });
    const request = await bounded(received.promise, 'Telegram multipart request was not received');
    assert.match(request.contentType, /^multipart\/form-data; boundary=/);
    assert.ok(request.body.includes(Buffer.from('name="chat_id"\r\n\r\n-100123')));
    assert.ok(request.body.includes(Buffer.from('name="message_thread_id"\r\n\r\n55')));
    assert.ok(request.body.includes(Buffer.from('name="reply_parameters"')));
    assert.ok(request.body.includes(Buffer.from('"message_id":44')));
    assert.ok(request.body.includes(Buffer.from(
      'name="document"; filename="result.bin"\r\nContent-Type: application/octet-stream',
    )));
    assert.ok(request.body.includes(bytes));
  } finally {
    await transport.destroy();
    restoreProxy();
    await close(server);
  }
});

function runtimeState(cursor = 0) {
  return {
    cursor: () => cursor,
    setCursor: async (value) => { cursor = value; },
    hasSeen: () => false,
    markSeen: async () => undefined,
    sessionFor: () => null,
  };
}

function runtimeConfig() {
  return {
    botId: 'telegram_transport_test',
    platformId: '123456789',
    username: 'HarnessBot',
  };
}

function healthyApi() {
  return {
    getMe: async () => ({ id: 123456789, is_bot: true }),
    getWebhookInfo: async () => ({ url: '' }),
    setMyCommands: async () => true,
    setChatMenuButton: async () => true,
    getUpdates: async ({ signal }) => new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  };
}

function fakeTransport() {
  let destroyCalls = 0;
  class FakeFormData {}
  const fetchImpl = async () => undefined;
  return {
    fetchImpl,
    FormDataImpl: FakeFormData,
    destroy: async () => { destroyCalls += 1; },
    get destroyCalls() { return destroyCalls; },
  };
}

test('Telegram Runtime injects and destroys one private transport exactly once', async () => {
  const transport = fakeTransport();
  let apiOptions;
  const runtime = new TelegramRuntime({
    config: runtimeConfig(),
    token: TOKEN,
    harness: { ensureRunning: async () => true },
    state: runtimeState(),
    createHttpTransport: () => transport,
    createApi: (options) => {
      apiOptions = options;
      return healthyApi();
    },
  });

  await runtime.start();
  assert.equal(apiOptions.fetchImpl, transport.fetchImpl);
  assert.equal(apiOptions.FormDataImpl, transport.FormDataImpl);
  await runtime.stop();
  await runtime.stop();
  assert.equal(transport.destroyCalls, 1);
});

for (const failurePoint of ['getMe', 'createApi']) {
  test(`Telegram Runtime destroys its private transport when ${failurePoint} fails`, async () => {
    const transport = fakeTransport();
    const failure = new Error(`${failurePoint} failed`);
    const runtime = new TelegramRuntime({
      config: runtimeConfig(),
      token: TOKEN,
      harness: { ensureRunning: async () => true },
      state: runtimeState(),
      createHttpTransport: () => transport,
      createApi: failurePoint === 'createApi'
        ? () => { throw failure; }
        : () => ({ ...healthyApi(), getMe: async () => { throw failure; } }),
    });

    await assert.rejects(runtime.start(), (error) => error === failure);
    assert.equal(transport.destroyCalls, 1);
    await runtime.stop();
    assert.equal(transport.destroyCalls, 1);
  });
}
