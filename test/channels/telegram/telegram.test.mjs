import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  OUTBOUND_ARTIFACT_TOOL,
  OutboundArtifactRegistry,
  createOutboundArtifactTool,
} from '../../../src/channels/shared/semantic/artifact.mjs';
import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import {
  TELEGRAM_ACCESS_MODES,
  TelegramConfigStore,
  deriveTelegramBotIdentity,
  normalizeTelegramAccessPolicy,
} from '../../../src/channels/telegram/config-store.mjs';
import { TelegramController } from '../../../src/channels/telegram/telegram-controller.mjs';
import {
  TelegramApi,
  COMMANDS_MENU_BUTTON,
  inspectTelegramToken,
  validTelegramToken,
} from '../../../src/channels/telegram/telegram-api.mjs';
import { TelegramHarnessBridge } from '../../../src/channels/telegram/telegram-bridge.mjs';
import {
  TelegramBotClient,
  TelegramRuntime,
  TELEGRAM_COMMAND_MENU,
  normalizeTelegramUpdate,
  telegramCommandMenu,
  telegramInboundAllowed,
} from '../../../src/channels/telegram/telegram-runtime.mjs';
import { TelegramStateStore } from '../../../src/channels/telegram/state-store.mjs';
import {
  TELEGRAM_ENDPOINTS,
  createTelegramRpcHandler,
} from '../../../plugin-src/host/channels/telegram/rpc.mjs';

const TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function credentials() {
  const values = new Map();
  return {
    values,
    async resolve(ref) {
      return values.has(ref) ? { value: values.get(ref), source: 'test' } : undefined;
    },
    async set(ref, value) { values.set(ref, value); },
    async unset(ref) { values.delete(ref); },
  };
}

function memoryState() {
  const sessions = new Map();
  const seen = new Set();
  return {
    sessionFor: (key) => sessions.get(key) ?? null,
    setSession: async (key, value) => sessions.set(key, value),
    clearSession: async (key) => sessions.delete(key),
    hasSeen: (id) => seen.has(id),
    markSeen: async (id) => seen.add(id),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

async function committedTelegramArtifact(t, {
  suffix,
  fileName,
  content,
}) {
  const workspace = await mkdtemp(join(tmpdir(), `dsh-im-telegram-artifact-${suffix}-`));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const sessionId = `session-telegram-artifact-${suffix}`;
  let nextId = 0;
  const registry = new OutboundArtifactRegistry({
    uuid: () => `${suffix}-${++nextId}`,
  });
  t.after(() => registry.clear());
  const agent = {
    session: {
      header: { id: sessionId, cwd: workspace },
      events: [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { turn: 1, source: { rpcId: `rpc-${suffix}` } } },
      ],
    },
  };
  await writeFile(join(workspace, fileName), content);
  const tool = createOutboundArtifactTool({ registry });
  const execution = {
    name: OUTBOUND_ARTIFACT_TOOL,
    callId: `call-${suffix}`,
    rootCallId: `call-${suffix}`,
    token: Symbol(`call-${suffix}`),
    agent,
  };
  await tool.definition.execute({ path: fileName }, execution);
  tool.onResult(execution, { isError: false });
  return registry.take(sessionId, 1)[0];
}

test('Telegram API validates a Bot Token without exposing it in requests or errors', async () => {
  assert.equal(validTelegramToken(TOKEN), true);
  assert.equal(validTelegramToken('short'), false);
  const calls = [];
  const bot = await inspectTelegramToken(TOKEN, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true, result: {
        id: 123456789,
        is_bot: true,
        first_name: 'Harness',
        username: 'HarnessBot',
      } });
    },
  });
  assert.deepEqual(bot, {
    platformId: '123456789',
    name: 'Harness',
    username: 'HarnessBot',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.protocol, 'https:');
  assert.equal(calls[0].url.hostname, 'api.telegram.org');
  assert.match(calls[0].url.pathname, /^\/bot/);
  assert.match(calls[0].url.pathname, /getMe$/);
  assert.equal(calls[0].options.method, 'POST');

  const api = new TelegramApi({
    token: TOKEN,
    fetchImpl: async () => jsonResponse({ ok: false, error_code: 401, description: 'Unauthorized' }, 401),
  });
  await assert.rejects(() => api.getMe(), (error) => {
    assert.equal(error.code, 'telegram-401');
    assert.doesNotMatch(error.message, new RegExp(TOKEN));
    return true;
  });
});

test('Telegram API resolves and downloads files without exposing arbitrary paths', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const calls = [];
  const api = new TelegramApi({
    token: TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.pathname.endsWith('/getFile')) {
        return jsonResponse({ ok: true, result: { file_path: 'photos/file_1.png' } });
      }
      return new Response(png, { status: 200, headers: { 'content-length': String(png.length) } });
    },
  });
  assert.deepEqual(await api.downloadFile({ fileId: 'AgAC_test-file', maxBytes: 100 }), png);
  const streamed = await api.downloadFileStream({ fileId: 'AgAC_test-file' });
  const streamedChunks = [];
  for await (const chunk of streamed.stream) streamedChunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(streamedChunks), png);
  assert.equal(calls.length, 4);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(calls[1].url.hostname, 'api.telegram.org');
  assert.match(calls[1].url.pathname, /\/file\/bot.+\/photos\/file_1\.png$/);
  assert.equal(calls[3].options.signal, undefined);

  const unsafeApi = new TelegramApi({
    token: TOKEN,
    fetchImpl: async () => jsonResponse({ ok: true, result: { file_path: '../secret' } }),
  });
  await assert.rejects(() => unsafeApi.downloadFile({ fileId: 'AgAC_test-file' }), (error) => {
    assert.match(error.message, /invalid file path/);
    assert.doesNotMatch(error.message, new RegExp(TOKEN.replaceAll(':', '\\:')));
    return true;
  });
});

test('Telegram API registers the command menu and commands-type menu button', async () => {
  const calls = [];
  const api = new TelegramApi({
    token: TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return jsonResponse({ ok: true, result: true });
    },
  });
  await api.setMyCommands({ commands: TELEGRAM_COMMAND_MENU });
  await api.setChatMenuButton();
  assert.equal(calls.length, 2);
  assert.deepEqual(
    TELEGRAM_COMMAND_MENU.filter(({ command }) => ['presetlist', 'presets', 'preset'].includes(command)),
    [
      { command: 'presetlist', description: '列出可用 Agent Preset' },
      { command: 'presets', description: '列出可用 Agent Preset' },
      { command: 'preset', description: '查看或设置新会话 Agent Preset' },
    ],
  );
  assert.match(calls[0].url.pathname, /setMyCommands$/);
  assert.deepEqual(calls[0].body, { commands: TELEGRAM_COMMAND_MENU });
  assert.match(calls[1].url.pathname, /setChatMenuButton$/);
  assert.deepEqual(calls[1].body, { menu_button: COMMANDS_MENU_BUTTON });

  const scopeCall = await api.setMyCommands({
    commands: [{ command: 'help', description: '帮助' }],
    scope: { type: 'chat', chat_id: 88 },
    languageCode: 'zh',
  });
  assert.equal(scopeCall, true);
  assert.deepEqual(calls[2].body.commands, [{ command: 'help', description: '帮助' }]);
  assert.deepEqual(calls[2].body.scope, { type: 'chat', chat_id: 88 });
  assert.equal(calls[2].body.language_code, 'zh');

  await assert.rejects(() => api.setMyCommands({ commands: [] }), /commands are invalid/);
  await assert.rejects(() => api.setMyCommands({
    commands: [{ command: 'Bad-Name', description: '非法命令名' }],
  }), /commands are invalid/);
  await assert.rejects(() => api.setMyCommands({
    commands: [{ command: 'help' }],
  }), /commands are invalid/);
  await assert.rejects(() => api.setChatMenuButton({ menuButton: 'commands' }), /menu button is invalid/);
});

test('Telegram command menu follows the host language at runtime', () => {
  assert.equal(TELEGRAM_COMMAND_MENU[0].description, '开启一个全新会话');
  assert.equal(TELEGRAM_COMMAND_MENU.some(({ command }) => command === 'version'), true);
  setImHostLanguage('en');
  try {
    assert.equal(telegramCommandMenu()[0].description, 'Start a brand-new Session');
  } finally {
    setImHostLanguage('zh');
  }
  assert.deepEqual(telegramCommandMenu(), TELEGRAM_COMMAND_MENU);
});

test('Telegram API preserves the legacy plain send and edit payloads', async () => {
  const calls = [];
  const api = new TelegramApi({
    token: TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ method: url.pathname.split('/').at(-1), body: JSON.parse(options.body) });
      return jsonResponse({ ok: true, result: { message_id: 501 } });
    },
  });

  await api.sendMessage({
    chatId: -100123,
    text: 'legacy send',
    replyToMessageId: 44,
    messageThreadId: 55,
  });
  await api.editMessageText({
    chatId: -100123,
    messageId: 501,
    text: 'legacy edit',
  });

  assert.deepEqual(calls, [{
    method: 'sendMessage',
    body: {
      chat_id: -100123,
      text: 'legacy send',
      link_preview_options: { is_disabled: true },
      reply_parameters: { message_id: 44, allow_sending_without_reply: true },
      message_thread_id: 55,
    },
  }, {
    method: 'editMessageText',
    body: {
      chat_id: -100123,
      message_id: 501,
      text: 'legacy edit',
      link_preview_options: { is_disabled: true },
    },
  }]);
  assert.equal(Object.hasOwn(calls[0].body, 'parse_mode'), false);
  assert.equal(Object.hasOwn(calls[1].body, 'parse_mode'), false);
});

test('Telegram API and bot client set and clear one reaction on the source message', async () => {
  const calls = [];
  const requestAbort = new AbortController();
  const api = new TelegramApi({
    token: TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({
        method: url.pathname.split('/').at(-1),
        body: JSON.parse(options.body),
        signal: options.signal,
      });
      return jsonResponse({ ok: true, result: true });
    },
  });
  await api.setMessageReaction({
    chatId: -100123,
    messageId: 44,
    emoji: ' 👀 ',
    signal: requestAbort.signal,
    timeoutMs: 5_000,
  });
  await api.setMessageReaction({
    chatId: -100123,
    messageId: 44,
    signal: requestAbort.signal,
    timeoutMs: 5_000,
  });
  assert.deepEqual(calls.map(({ method, body }) => ({ method, body })), [{
    method: 'setMessageReaction',
    body: {
      chat_id: -100123,
      message_id: 44,
      reaction: [{ type: 'emoji', emoji: '👀' }],
    },
  }, {
    method: 'setMessageReaction',
    body: { chat_id: -100123, message_id: 44, reaction: [] },
  }]);
  requestAbort.abort();
  assert.equal(calls.every(({ signal }) => signal.aborted), true);

  const adapterCalls = [];
  const runtimeAbort = new AbortController();
  const sidecarAbort = new AbortController();
  const client = new TelegramBotClient({
    api: {
      setMessageReaction: async (payload) => adapterCalls.push(payload),
    },
    signal: runtimeAbort.signal,
  });
  const target = { chatId: -100123, messageId: 45 };
  assert.equal(await client.addReaction(target, '👍', { signal: sidecarAbort.signal }), '👍');
  await client.removeReaction(target, '👍', { signal: sidecarAbort.signal });
  assert.deepEqual(adapterCalls.map(({ chatId, messageId, emoji }) => ({
    chatId, messageId, emoji,
  })), [{ chatId: -100123, messageId: 45, emoji: '👍' }, {
    chatId: -100123, messageId: 45, emoji: undefined,
  }]);
  sidecarAbort.abort();
  assert.equal(adapterCalls.every(({ signal }) => signal.aborted), true);
});

test('Telegram plain delivery keeps the 4000 boundary, reply, topic, and content', async () => {
  const calls = [];
  let nextMessageId = 600;
  const client = new TelegramBotClient({
    api: {
      sendMessage: async (payload) => {
        calls.push(payload);
        return { message_id: nextMessageId++ };
      },
    },
  });
  const target = { chatId: -100123, replyToMessageId: 44, messageThreadId: 55 };

  const exact = `\`\`\`js\n${'a'.repeat(3990)}\n\`\`\``;
  assert.equal(exact.length, 4000);
  await client.sendText(target, exact);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, exact);

  calls.length = 0;
  const long = `${'中'.repeat(3998)}😀Z`;
  assert.equal(long.length, 4001);
  const receipt = await client.sendText(target, long);
  assert.equal(calls.length, 2);
  assert.equal(calls.map((call) => call.text).join(''), long);
  assert.equal(calls[0].replyToMessageId, 44);
  assert.equal(calls[1].replyToMessageId, undefined);
  assert.deepEqual(calls.map((call) => call.messageThreadId), [55, 55]);
  assert.deepEqual(receipt.providerMessageIds, ['601', '602']);
});

test('Telegram API uploads a result file as a native document in the same topic and reply chain', async () => {
  let request;
  const api = new TelegramApi({
    token: TOKEN,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({ ok: true, result: { message_id: 901 } });
    },
  });
  const result = await api.sendDocument({
    chatId: -100123,
    replyToMessageId: 44,
    messageThreadId: 55,
    file: {
      fileName: 'result.txt',
      mediaType: 'text/plain',
      bytes: Buffer.from('telegram-result'),
    },
  });

  assert.equal(result.message_id, 901);
  assert.match(request.url.pathname, /sendDocument$/);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers, undefined);
  assert.ok(request.options.body instanceof FormData);
  assert.equal(request.options.body.get('chat_id'), '-100123');
  assert.equal(request.options.body.get('message_thread_id'), '55');
  assert.deepEqual(JSON.parse(request.options.body.get('reply_parameters')), {
    message_id: 44,
    allow_sending_without_reply: true,
  });
  const document = request.options.body.get('document');
  assert.equal(document.name, 'result.txt');
  assert.equal(document.type, 'text/plain');
  assert.equal(Buffer.from(await document.arrayBuffer()).toString(), 'telegram-result');
});

test('Telegram API uploads a result image as a native photo in the same topic and reply chain', async () => {
  let request;
  const api = new TelegramApi({
    token: TOKEN,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({ ok: true, result: { message_id: 902 } });
    },
  });
  const result = await api.sendPhoto({
    chatId: -100123,
    replyToMessageId: 44,
    messageThreadId: 55,
    file: {
      fileName: 'result.png',
      mediaType: 'image/png',
      bytes: Buffer.from('telegram-image'),
    },
  });

  assert.equal(result.message_id, 902);
  assert.match(request.url.pathname, /sendPhoto$/);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers, undefined);
  assert.ok(request.options.body instanceof FormData);
  assert.equal(request.options.body.get('chat_id'), '-100123');
  assert.equal(request.options.body.get('message_thread_id'), '55');
  assert.deepEqual(JSON.parse(request.options.body.get('reply_parameters')), {
    message_id: 44,
    allow_sending_without_reply: true,
  });
  const photo = request.options.body.get('photo');
  assert.equal(photo.name, 'result.png');
  assert.equal(photo.type, 'image/png');
  assert.equal(Buffer.from(await photo.arrayBuffer()).toString(), 'telegram-image');
});

test('Telegram bot client routes images through sendPhoto with the existing reply context', async () => {
  let request;
  const controller = new AbortController();
  const client = new TelegramBotClient({
    api: {
      sendPhoto: async (value) => {
        request = value;
        return { message_id: 903 };
      },
    },
    signal: controller.signal,
  });
  const file = {
    fileName: 'result.png',
    mediaType: 'image/png',
    bytes: Buffer.from('telegram-image'),
  };

  assert.deepEqual(await client.sendImage({
    chatId: -100456,
    replyToMessageId: 66,
    messageThreadId: 77,
  }, file), { message_id: 903 });
  assert.equal(request.chatId, -100456);
  assert.equal(request.file, file);
  assert.equal(request.replyToMessageId, 66);
  assert.equal(request.messageThreadId, 77);
  assert.equal(request.signal, controller.signal);
});

test('Telegram photo delivery reuses stable artifact error mapping', async () => {
  const rejectedApi = new TelegramApi({
    token: TOKEN,
    fetchImpl: async () => jsonResponse({
      ok: false,
      error_code: 400,
      description: 'Bad Request: unsupported photo',
    }, 400),
  });
  await assert.rejects(() => rejectedApi.sendPhoto({
    chatId: 123,
    file: { fileName: 'result.webp', bytes: Buffer.from('result') },
  }), (error) => error.code === 'artifact-provider-rejected'
    && error.providerCode === 400
    && error.status === 400);

  const uncertainApi = new TelegramApi({
    token: TOKEN,
    fetchImpl: async () => new Response('not-json', { status: 200 }),
  });
  await assert.rejects(() => uncertainApi.sendPhoto({
    chatId: 123,
    file: { fileName: 'result.png', bytes: Buffer.from('result') },
  }), (error) => error.code === 'artifact-delivery-uncertain');
});

test('Telegram document errors retain provider details and use stable artifact reasons', async () => {
  const cases = [{
    body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked' },
    status: 403,
    code: 'artifact-permission-required',
  }, {
    body: { ok: false, error_code: 400, description: 'Bad Request: file is too big' },
    status: 400,
    code: 'artifact-too-large',
  }, {
    body: {
      ok: false,
      error_code: 429,
      description: 'Too Many Requests',
      parameters: { retry_after: 7 },
    },
    status: 429,
    code: 'artifact-rate-limited',
    retryAfter: 7,
  }, {
    body: { ok: false, error_code: 400, description: 'Bad Request: unsupported document' },
    status: 400,
    code: 'artifact-provider-rejected',
  }, {
    body: { ok: false, error_code: 500, description: 'Internal Server Error' },
    status: 500,
    code: 'artifact-delivery-uncertain',
  }];

  for (const entry of cases) {
    const api = new TelegramApi({
      token: TOKEN,
      fetchImpl: async () => jsonResponse(entry.body, entry.status),
    });
    await assert.rejects(() => api.sendDocument({
      chatId: 123,
      file: { fileName: 'result.bin', bytes: Buffer.from('result') },
    }), (error) => {
      assert.equal(error.code, entry.code);
      assert.equal(error.providerCode, entry.body.error_code);
      assert.equal(error.status, entry.status);
      assert.equal(error.retry_after, entry.retryAfter);
      assert.equal(error.retryAfter, entry.retryAfter);
      return true;
    });
  }
});

test('Telegram document delivery marks post-dispatch failures uncertain but preserves caller aborts', async () => {
  for (const fetchImpl of [
    async () => { throw new TypeError('socket reset'); },
    async () => new Response('not-json', { status: 200 }),
  ]) {
    const api = new TelegramApi({ token: TOKEN, fetchImpl });
    await assert.rejects(() => api.sendDocument({
      chatId: 123,
      file: { fileName: 'result.bin', bytes: Buffer.from('result') },
    }), (error) => error.code === 'artifact-delivery-uncertain');
  }

  const timeoutApi = new TelegramApi({
    token: TOKEN,
    fileUploadTimeoutMs: 10,
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  await assert.rejects(() => timeoutApi.sendDocument({
    chatId: 123,
    file: { fileName: 'result.bin', bytes: Buffer.from('result') },
  }), (error) => error.code === 'artifact-delivery-uncertain'
    && error.cause?.name === 'TimeoutError');

  const caller = new AbortController();
  const reason = new DOMException('caller stopped', 'AbortError');
  caller.abort(reason);
  let calls = 0;
  const cancelledApi = new TelegramApi({
    token: TOKEN,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ ok: true, result: {} });
    },
  });
  await assert.rejects(() => cancelledApi.sendDocument({
    chatId: 123,
    file: { fileName: 'result.bin', bytes: Buffer.from('result') },
    signal: caller.signal,
  }), (error) => error === reason && error.code !== 'artifact-delivery-uncertain');
  assert.equal(calls, 0);
});

test('Telegram config and controller store only a credential reference in bot data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-telegram-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'config.json');
  const configStore = await new TelegramConfigStore(configPath).load();
  const credentialStore = credentials();
  const runtimes = [];
  const connectionTests = [];
  const proactiveSends = [];
  const controller = new TelegramController({
    credentials: credentialStore,
    configStore,
    inspectToken: async () => ({
      platformId: '123456789', name: 'Harness Telegram', username: 'harness_bot',
    }),
    createRuntime: async () => {
      const runtime = {
        status: {
          ready: true,
          connectionState: 'connected',
          harnessReachable: true,
          lastCheckedAt: 10,
        },
        async start() {},
        async stop() {},
        async sendConnectionTest(text) { connectionTests.push(text); },
        async sendProactiveText(...args) {
          proactiveSends.push(args);
          return { sent: true };
        },
      };
      runtimes.push(runtime);
      return runtime;
    },
  });

  const status = await controller.bindCredentials({ token: TOKEN });
  assert.equal(status.totals.connected, 1);
  assert.equal(status.bots[0].bot.name, 'Harness Telegram');
  assert.equal(status.bots[0].bot.username, 'harness_bot');
  assert.deepEqual(status.bots[0].accessPolicy, {
    accessMode: TELEGRAM_ACCESS_MODES.compatible,
    allowedUsers: [],
  });
  const identity = deriveTelegramBotIdentity('123456789');
  assert.equal(credentialStore.values.get(identity.tokenRef), TOKEN);
  const persisted = await readFile(configPath, 'utf8');
  assert.doesNotMatch(persisted, new RegExp(TOKEN));
  assert.match(persisted, new RegExp(identity.tokenRef));
  assert.doesNotMatch(persisted, /accessMode|allowedUsers/);

  await controller.reconnectBot(identity.botId);
  assert.equal(runtimes.length, 2);
  await controller.sendConnectionTest(identity.botId);
  assert.match(connectionTests[0], /Harness Telegram/);
  assert.match(connectionTests[0], /123•••/);
  const target = { kind: 'chat', route: { chatId: '123456' } };
  assert.deepEqual(await controller.sendProactiveText(identity.botId, target, 'proactive-test'), {
    sent: true,
  });
  assert.deepEqual(proactiveSends, [[target, 'proactive-test', {}]]);
  await controller.deleteBot(identity.botId);
  assert.equal(credentialStore.values.has(identity.tokenRef), false);
  assert.equal(controller.status().totals.configured, 0);
});

test('Telegram loads legacy bots without an access policy as compatible mode', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-telegram-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'config.json');
  const identity = deriveTelegramBotIdentity('123456789');
  await writeFile(configPath, `${JSON.stringify({
    version: 1,
    bots: [{
      ...identity,
      platformId: '123456789',
      name: 'Legacy Telegram',
      username: 'legacy_bot',
      createdAt: '2026-01-01T00:00:00.000Z',
      connectedAt: '2026-01-01T00:00:00.000Z',
    }],
  }, null, 2)}\n`);

  const store = await new TelegramConfigStore(configPath).load();
  const saved = store.get(identity.botId);
  assert.equal(saved.accessMode, undefined);
  assert.equal(saved.allowedUsers, undefined);
  assert.deepEqual(normalizeTelegramAccessPolicy(saved), {
    accessMode: TELEGRAM_ACCESS_MODES.compatible,
    allowedUsers: [],
  });
});

test('Telegram access policy persists per bot, switches freely, and restarts only that bot', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-telegram-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'config.json');
  const configStore = await new TelegramConfigStore(configPath).load();
  const runtimeRecords = [];
  let inspected = 0;
  const controller = new TelegramController({
    credentials: credentials(),
    configStore,
    inspectToken: async () => {
      inspected += 1;
      return {
        platformId: inspected === 1 ? '111111111' : inspected === 2 ? '222222222' : '111111111',
        name: inspected === 2 ? 'Bot B' : 'Bot A',
        username: inspected === 2 ? 'bot_b' : 'bot_a',
      };
    },
    createRuntime: async ({ botId, config }) => {
      const record = { botId, config: structuredClone(config), starts: 0, stops: 0 };
      runtimeRecords.push(record);
      return {
        status: {
          ready: true,
          connectionState: 'connected',
          harnessReachable: true,
          lastCheckedAt: 10,
        },
        async start() { record.starts += 1; },
        async stop() { record.stops += 1; },
      };
    },
  });

  await controller.bindCredentials({ token: TOKEN });
  await controller.bindCredentials({ token: '222222222:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456' });
  const botA = deriveTelegramBotIdentity('111111111').botId;
  const botB = deriveTelegramBotIdentity('222222222').botId;
  assert.deepEqual(controller.status().bots.map((bot) => bot.accessPolicy), [
    { accessMode: TELEGRAM_ACCESS_MODES.compatible, allowedUsers: [] },
    { accessMode: TELEGRAM_ACCESS_MODES.compatible, allowedUsers: [] },
  ]);

  await controller.setAccessPolicy(botA, {
    accessMode: TELEGRAM_ACCESS_MODES.privateAllowlist,
    allowedUsers: ['6087707998', '1202499116'],
  });
  assert.equal(runtimeRecords.filter((record) => record.botId === botA).length, 2);
  assert.equal(runtimeRecords.filter((record) => record.botId === botB).length, 1);
  assert.equal(runtimeRecords.find((record) => record.botId === botA).stops, 1);
  assert.equal(runtimeRecords.find((record) => record.botId === botB).stops, 0);
  assert.deepEqual(controller.status().bots.find((bot) => bot.botId === botA).accessPolicy, {
    accessMode: TELEGRAM_ACCESS_MODES.privateAllowlist,
    allowedUsers: ['6087707998', '1202499116'],
  });
  assert.deepEqual(controller.status().bots.find((bot) => bot.botId === botB).accessPolicy, {
    accessMode: TELEGRAM_ACCESS_MODES.compatible,
    allowedUsers: [],
  });

  await controller.setAccessPolicy(botA, {
    accessMode: TELEGRAM_ACCESS_MODES.compatible,
    allowedUsers: ['6087707998', '1202499116'],
  });
  assert.equal(configStore.get(botA).accessMode, TELEGRAM_ACCESS_MODES.compatible);
  assert.deepEqual(configStore.get(botA).allowedUsers, ['6087707998', '1202499116']);
  await controller.setAccessPolicy(botA, {
    accessMode: TELEGRAM_ACCESS_MODES.privateAllowlist,
    allowedUsers: ['6087707998', '1202499116'],
  });
  assert.deepEqual(controller.status().bots.find((bot) => bot.botId === botA).accessPolicy, {
    accessMode: TELEGRAM_ACCESS_MODES.privateAllowlist,
    allowedUsers: ['6087707998', '1202499116'],
  });

  await controller.bindCredentials({ token: TOKEN });
  assert.deepEqual(configStore.get(botA).allowedUsers, ['6087707998', '1202499116']);
  assert.equal(configStore.get(botA).accessMode, TELEGRAM_ACCESS_MODES.privateAllowlist);

  const reloaded = await new TelegramConfigStore(configPath).load();
  assert.deepEqual(reloaded.get(botA).allowedUsers, ['6087707998', '1202499116']);
  assert.equal(reloaded.get(botB).accessMode, undefined);
  await controller.close();
});

test('Telegram access policy rejects invalid modes and user IDs', () => {
  assert.throws(() => normalizeTelegramAccessPolicy({
    accessMode: 'allow-everything',
    allowedUsers: [],
  }), /accessMode/);
  assert.throws(() => normalizeTelegramAccessPolicy({
    accessMode: TELEGRAM_ACCESS_MODES.privateAllowlist,
    allowedUsers: ['0', '-1001', '@username'],
  }), /invalid Telegram User ID/);
});

test('Telegram policy update is serialized with deletion and cannot restore a deleted bot', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-telegram-policy-delete-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configStore = await new TelegramConfigStore(join(directory, 'config.json')).load();
  const credentialStore = credentials();
  const unsetStarted = deferred();
  const releaseUnset = deferred();
  const unset = credentialStore.unset;
  credentialStore.unset = async (ref) => {
    unsetStarted.resolve();
    await releaseUnset.promise;
    return unset(ref);
  };
  const controller = new TelegramController({
    credentials: credentialStore,
    configStore,
    inspectToken: async () => ({
      platformId: '123456789', name: 'Harness Telegram', username: 'harness_bot',
    }),
    createRuntime: async () => ({
      status: { ready: true, connectionState: 'connected', harnessReachable: true },
      async start() {},
      async stop() {},
    }),
  });
  await controller.bindCredentials({ token: TOKEN });
  const botId = deriveTelegramBotIdentity('123456789').botId;

  const deletion = controller.deleteBot(botId);
  await unsetStarted.promise;
  const policyUpdate = controller.setAccessPolicy(botId, {
    accessMode: TELEGRAM_ACCESS_MODES.privateAllowlist,
    allowedUsers: ['6087707998'],
  });
  releaseUnset.resolve();

  await deletion;
  await assert.rejects(policyUpdate, /Unknown Telegram bot/);
  assert.equal(configStore.get(botId), null);
  assert.equal(credentialStore.values.size, 0);
  assert.equal(controller.status().totals.configured, 0);
});

test('Telegram queued policy update cannot persist after controller close begins', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-telegram-policy-close-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configStore = await new TelegramConfigStore(join(directory, 'config.json')).load();
  const reconnectStarted = deferred();
  const releaseReconnect = deferred();
  let runtimeCount = 0;
  const controller = new TelegramController({
    credentials: credentials(),
    configStore,
    inspectToken: async () => ({
      platformId: '123456789', name: 'Harness Telegram', username: 'harness_bot',
    }),
    createRuntime: async () => {
      runtimeCount += 1;
      const current = runtimeCount;
      return {
        status: { ready: true, connectionState: 'connected', harnessReachable: true },
        async start() {
          if (current === 2) {
            reconnectStarted.resolve();
            await releaseReconnect.promise;
          }
        },
        async stop() {},
      };
    },
  });
  await controller.bindCredentials({ token: TOKEN });
  const botId = deriveTelegramBotIdentity('123456789').botId;

  const reconnect = controller.reconnectBot(botId);
  await reconnectStarted.promise;
  const policyUpdate = controller.setAccessPolicy(botId, {
    accessMode: TELEGRAM_ACCESS_MODES.privateAllowlist,
    allowedUsers: ['6087707998'],
  });
  const rejectedPolicy = assert.rejects(policyUpdate, /controller is closed/);
  const closing = controller.close();
  releaseReconnect.resolve();

  await reconnect;
  await rejectedPolicy;
  await closing;
  assert.equal(configStore.get(botId).accessMode, undefined);
  assert.equal(configStore.get(botId).allowedUsers, undefined);
});

test('Telegram RPC accepts the unified access policy and strips credential internals', async () => {
  const calls = [];
  const connectionTests = [];
  const controller = {
    status: () => ({ bots: [], totals: { configured: 0, connected: 0 } }),
    bindCredentials: async (payload) => {
      calls.push(payload);
      return {
        bots: [{
          botId: 'telegram_123',
          tokenRef: 'DSH_TELEGRAM_BOT_TOKEN_ABC',
          token: TOKEN,
          bot: { name: 'Telegram机器人', idMasked: '123•••' },
        }],
        totals: { configured: 1, connected: 0 },
      };
    },
    reconnectBot: async (botId) => ({
      bots: [{ botId, connected: true }],
      totals: { configured: 1, connected: 1 },
    }),
    sendConnectionTest: async (botId) => { connectionTests.push(botId); },
    deleteBot: async () => ({ bots: [], totals: { configured: 0, connected: 0 } }),
    updateAccessPolicy: async (botId, policy) => {
      calls.push({ botId, policy });
      return {
        bots: [{ botId, accessPolicy: policy }],
        totals: { configured: 1, connected: 0 },
      };
    },
  };
  const handler = createTelegramRpcHandler(controller);
  const result = await handler(TELEGRAM_ENDPOINTS.bindCredentials, { token: TOKEN });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ token: TOKEN }]);
  assert.equal(result.value.bots[0].token, undefined);
  assert.equal(result.value.bots[0].tokenRef, undefined);
  const rejected = await handler(TELEGRAM_ENDPOINTS.bindCredentials, { token: TOKEN, extra: true });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'bad-request');

  const legacyReconnect = await handler(TELEGRAM_ENDPOINTS.reconnectBot, {
    botId: 'telegram_123',
  });
  assert.equal(legacyReconnect.ok, true);
  assert.equal('testMessage' in legacyReconnect.value, false);
  assert.deepEqual(connectionTests, []);

  const tested = await handler(TELEGRAM_ENDPOINTS.reconnectBot, {
    botId: 'telegram_123',
    sendTest: true,
  });
  assert.equal(tested.ok, true);
  assert.deepEqual(tested.value.testMessage, { sent: true });
  assert.deepEqual(connectionTests, ['telegram_123']);

  controller.sendConnectionTest = async () => {
    const error = new Error('No explicit recipient');
    error.code = 'test-target-unavailable';
    throw error;
  };
  const missingTarget = await handler(TELEGRAM_ENDPOINTS.reconnectBot, {
    botId: 'telegram_123',
    sendTest: true,
  });
  assert.equal(missingTarget.ok, true);
  assert.deepEqual(missingTarget.value.testMessage, {
    sent: false,
    code: 'test-target-unavailable',
  });

  const unifiedPolicy = {
    direct: {
      mode: 'allowlist',
      open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
      allowlist: { users: [{ id: '6087707998', canExecuteCommands: true }] },
    },
    group: {
      mode: 'open',
      open: { defaultCanExecuteCommands: true, commandPermissionOverrides: [] },
      allowlist: { users: [] },
    },
  };
  const access = await handler(TELEGRAM_ENDPOINTS.setAccessPolicy, {
    botId: 'telegram_123',
    policy: unifiedPolicy,
  });
  assert.equal(access.ok, true);
  assert.deepEqual(calls.at(-1), {
    botId: 'telegram_123',
    policy: unifiedPolicy,
  });
  assert.equal((await handler(TELEGRAM_ENDPOINTS.setAccessPolicy, {
    botId: 'telegram_123',
    accessMode: TELEGRAM_ACCESS_MODES.privateAllowlist,
    allowedUsers: ['6087707998'],
  })).error.code, 'bad-request');
  assert.equal((await handler(TELEGRAM_ENDPOINTS.setAccessPolicy, {
    botId: 'telegram_123',
    policy: unifiedPolicy,
    extra: true,
  })).error.code, 'bad-request');
});

test('shared token RPC never sends a connection test after reconnect is cancelled', async () => {
  let resolveReconnect;
  let sendCalls = 0;
  const reconnect = new Promise((resolve) => { resolveReconnect = resolve; });
  const controller = {
    status: async () => ({ bots: [] }),
    bindCredentials: async () => ({ bots: [] }),
    reconnectBot: async () => reconnect,
    sendConnectionTest: async () => { sendCalls += 1; },
    deleteBot: async () => ({ bots: [] }),
    updateAccessPolicy: async () => ({ bots: [] }),
  };
  const abort = new AbortController();
  const result = createTelegramRpcHandler(controller)(TELEGRAM_ENDPOINTS.reconnectBot, {
    botId: 'telegram_123',
    sendTest: true,
  }, abort.signal);

  abort.abort();
  resolveReconnect({ bots: [{ botId: 'telegram_123', connected: true }] });

  assert.deepEqual(await result, {
    ok: false,
    error: { code: 'cancelled', message: 'The request was cancelled.' },
  });
  assert.equal(sendCalls, 0);
});

test('Telegram normalizes private messages and requires an explicit group address', () => {
  const privateMessage = normalizeTelegramUpdate({
    update_id: 10,
    message: {
      message_id: 4,
      chat: { id: 88, type: 'private' },
      from: { id: 42, is_bot: false },
      text: 'hello',
    },
  }, { botId: '123456789', username: 'HarnessBot' });
  assert.equal(privateMessage.kind, 'direct');
  assert.equal(privateMessage.addressed, true);
  assert.equal(privateMessage.replyTarget.chatType, 'private');
  assert.deepEqual(privateMessage.reactionTarget, { chatId: 88, messageId: 4 });
  assert.deepEqual(privateMessage.connectionTestTarget, { chatId: 88, messageThreadId: undefined });

  const groupMessage = normalizeTelegramUpdate({
    update_id: 11,
    message: {
      message_id: 5,
      chat: { id: -1001, type: 'supergroup' },
      from: { id: 43, is_bot: false },
      text: '@HarnessBot run this',
      entities: [{ type: 'mention', offset: 0, length: 11 }],
    },
  }, { botId: '123456789', username: 'HarnessBot' });
  assert.equal(groupMessage.kind, 'group');
  assert.equal(groupMessage.addressed, true);
  assert.equal(groupMessage.content, 'run this');
  assert.equal(groupMessage.replyTarget.chatType, 'supergroup');

  const topicOne = normalizeTelegramUpdate({
    update_id: 12,
    message: {
      message_id: 6,
      message_thread_id: 100,
      chat: { id: -1001, type: 'supergroup' },
      from: { id: 43, is_bot: false },
      text: '@HarnessBot first topic',
      entities: [{ type: 'mention', offset: 0, length: 11 }],
    },
  }, { botId: '123456789', username: 'HarnessBot' });
  const topicTwo = normalizeTelegramUpdate({
    update_id: 13,
    message: {
      message_id: 7,
      message_thread_id: 200,
      chat: { id: -1001, type: 'supergroup' },
      from: { id: 43, is_bot: false },
      text: '@HarnessBot second topic',
      entities: [{ type: 'mention', offset: 0, length: 11 }],
    },
  }, { botId: '123456789', username: 'HarnessBot' });
  assert.equal(topicOne.conversationId, '-1001:100');
  assert.equal(topicTwo.conversationId, '-1001:200');
  assert.notEqual(topicOne.conversationId, topicTwo.conversationId);
  assert.equal(topicOne.replyTarget.messageThreadId, 100);
  assert.equal(topicTwo.replyTarget.messageThreadId, 200);
  assert.deepEqual(topicOne.reactionTarget, { chatId: -1001, messageId: 6 });
  assert.deepEqual(topicTwo.reactionTarget, { chatId: -1001, messageId: 7 });
});

test('Telegram maps one reply_to_message snapshot without expanding nested replies', () => {
  const replied = normalizeTelegramUpdate({
    update_id: 14,
    message: {
      message_id: 8,
      chat: { id: -1001, type: 'supergroup' },
      from: { id: 43, is_bot: false },
      text: '这张图说明什么？',
      reply_to_message: {
        message_id: 7,
        chat: { id: -1001, type: 'supergroup' },
        from: { id: 123456789, is_bot: true, first_name: 'Harness', last_name: 'Bot' },
        caption: '第一层原文',
        photo: [{ file_id: 'photo-large', file_unique_id: 'quoted-photo', file_size: 2_000 }],
        reply_to_message: { message_id: 6, text: '不应递归进入 Prompt' },
      },
    },
  }, { botId: '123456789', username: 'HarnessBot' });
  assert.equal(replied.addressed, true);
  assert.deepEqual(replied.replyTo, {
    messageId: '7',
    authorId: '123456789',
    authorName: 'Harness Bot',
    content: '第一层原文',
    attachments: [{ kind: 'image' }],
  });
  assert.doesNotMatch(JSON.stringify(replied.replyTo), /不应递归/);

  const documentReply = normalizeTelegramUpdate({
    update_id: 15,
    message: {
      message_id: 9,
      chat: { id: 88, type: 'private' },
      from: { id: 42, is_bot: false },
      text: '总结附件',
      reply_to_message: {
        message_id: 5,
        from: { id: 41, username: 'alice' },
        document: { file_id: 'quoted-pdf', file_name: 'brief.pdf', mime_type: 'application/pdf' },
      },
    },
  }, { botId: '123456789', username: 'HarnessBot' });
  assert.deepEqual(documentReply.replyTo.attachments, [{ kind: 'file', name: 'brief.pdf' }]);
  assert.equal(documentReply.replyTo.authorName, 'alice');

  const stickerReply = normalizeTelegramUpdate({
    update_id: 18,
    message: {
      message_id: 12,
      chat: { id: 88, type: 'private' },
      from: { id: 42, is_bot: false },
      text: '这个贴纸是什么意思？',
      reply_to_message: {
        message_id: 6,
        from: { id: 41, username: 'alice' },
        sticker: { file_id: 'opaque-sticker-id', file_unique_id: 'opaque-unique-id' },
      },
    },
  }, { botId: '123456789', username: 'HarnessBot' });
  assert.deepEqual(stickerReply.replyTo.attachments, [{ kind: 'image' }]);
});

test('Telegram uses TextQuote and bounded history loading when reply_to_message omits text', async () => {
  let loads = 0;
  const quoted = normalizeTelegramUpdate({
    update_id: 16,
    message: {
      message_id: 10,
      chat: { id: 88, type: 'private' },
      from: { id: 42, is_bot: false },
      text: '说的是什么内容？',
      quote: { text: '明白了——是记录/标记用途。' },
      reply_to_message: {
        message_id: 323,
        date: 1_788_118_330,
        from: { id: 123456789, is_bot: true, first_name: '今天是梁子' },
      },
    },
  }, {
    botId: '123456789',
    username: 'HarnessBot',
    loadReplyContent: async () => { loads += 1; return { content: '不应读取历史' }; },
  });
  assert.equal(quoted.replyTo.content, '明白了——是记录/标记用途。');
  assert.equal(Object.hasOwn(quoted.replyTo, 'load'), false);
  assert.equal(loads, 0);

  let loadedReference;
  const historyBacked = normalizeTelegramUpdate({
    update_id: 17,
    message: {
      message_id: 11,
      chat: { id: 88, type: 'private' },
      from: { id: 42, is_bot: false },
      text: '老消息说了什么？',
      reply_to_message: {
        message_id: 322,
        date: 1_788_118_320,
        from: { id: 123456789, is_bot: true, first_name: '今天是梁子' },
      },
    },
  }, {
    botId: '123456789',
    username: 'HarnessBot',
    loadReplyContent: async (reference) => {
      loadedReference = reference;
      return { content: '从当前会话历史恢复的正文' };
    },
  });
  assert.equal(typeof historyBacked.replyTo.load, 'function');
  assert.deepEqual(await historyBacked.replyTo.load({}), { content: '从当前会话历史恢复的正文' });
  assert.deepEqual(loadedReference, {
    conversationKey: 'direct:88',
    messageId: '322',
    createdAt: 1_788_118_320_000,
  });
});

test('Telegram compatible mode preserves old routing and private allowlist mode restricts inbound messages', () => {
  const allowed = new Set(['6087707998', '1202499116']);
  assert.equal(telegramInboundAllowed({ kind: 'group', senderId: '6087707998' }), true);
  assert.equal(telegramInboundAllowed({ kind: 'direct', senderId: '999999999' }), true);
  const policy = {
    accessMode: TELEGRAM_ACCESS_MODES.privateAllowlist,
    allowedPrivateUserIds: allowed,
  };
  assert.equal(telegramInboundAllowed({ kind: 'group', senderId: '6087707998' }, policy), false);
  assert.equal(telegramInboundAllowed({ kind: 'direct', senderId: '6087707998' }, policy), true);
  assert.equal(telegramInboundAllowed({ kind: 'direct', senderId: '999999999' }, policy), false);
  assert.equal(telegramInboundAllowed({ kind: 'direct', senderId: '6087707998' }, {
    ...policy,
    allowedPrivateUserIds: new Set(),
  }), false);
});

test('Telegram keeps native photos and image documents as images and exposes ordinary documents as files', async () => {
  const loads = [];
  const groupPhoto = normalizeTelegramUpdate({
    update_id: 20,
    message: {
      message_id: 10,
      chat: { id: -1001, type: 'supergroup' },
      from: { id: 43, is_bot: false },
      caption: '@HarnessBot 看看这张图',
      caption_entities: [{ type: 'mention', offset: 0, length: 11 }],
      photo: [
        { file_id: 'small', file_unique_id: 'photo', width: 90, height: 90, file_size: 500 },
        { file_id: 'large', file_unique_id: 'photo', width: 1280, height: 720, file_size: 2_000 },
      ],
    },
  }, {
    botId: '123456789',
    username: 'HarnessBot',
    loadFile: async (fileId, options) => {
      loads.push({ fileId, options });
      return Buffer.from('image');
    },
  });
  assert.equal(groupPhoto.addressed, true);
  assert.equal(groupPhoto.content, '看看这张图');
  assert.equal(groupPhoto.images.length, 1);
  assert.equal(groupPhoto.images[0].size, 2_000);
  await groupPhoto.images[0].load({ maxBytes: 5_000 });
  assert.equal(loads[0].fileId, 'large');

  const document = normalizeTelegramUpdate({
    update_id: 21,
    message: {
      message_id: 11,
      chat: { id: 88, type: 'private' },
      from: { id: 42, is_bot: false },
      document: {
        file_id: 'png-document', file_name: 'diagram.png', mime_type: 'image/png', file_size: 3_000,
      },
    },
  }, {
    botId: '123456789',
    username: 'HarnessBot',
    loadFile: async (fileId, options) => {
      loads.push({ fileId, options });
      return Buffer.from('document');
    },
  });
  assert.equal(document.images[0].name, 'diagram.png');
  assert.equal(document.images[0].mediaType, 'image/png');
  assert.equal(document.images[0].size, 3_000);
  assert.deepEqual(document.files, []);
  await document.images[0].load({ maxBytes: 5_000 });
  assert.deepEqual(loads[1], {
    fileId: 'png-document',
    options: { maxBytes: 5_000 },
  });

  const documentWithoutMime = normalizeTelegramUpdate({
    update_id: 23,
    message: {
      message_id: 13,
      chat: { id: 88, type: 'private' },
      from: { id: 42, is_bot: false },
      document: { file_id: 'webp-document', file_name: 'diagram.webp', file_size: 2_000 },
    },
  }, { botId: '123456789', username: 'HarnessBot' });
  assert.equal(documentWithoutMime.images[0].name, 'diagram.webp');
  assert.equal(documentWithoutMime.images[0].mediaType, 'image/webp');
  assert.deepEqual(documentWithoutMime.files, []);

  const fileLoads = [];
  const pdf = normalizeTelegramUpdate({
    update_id: 22,
    message: {
      message_id: 12,
      chat: { id: 88, type: 'private' },
      from: { id: 42, is_bot: false },
      document: { file_id: 'pdf-document', file_name: 'file.pdf', mime_type: 'application/pdf' },
    },
  }, {
    botId: '123456789',
    username: 'HarnessBot',
    loadFileStream: async (fileId, options) => {
      fileLoads.push({ fileId, options });
      return { stream: (async function* content() { yield Buffer.from('pdf'); }()) };
    },
  });
  assert.deepEqual(pdf.images, []);
  assert.equal(pdf.files[0].name, 'file.pdf');
  assert.equal(pdf.files[0].mediaType, 'application/pdf');
  const controller = new AbortController();
  const loadedPdf = await pdf.files[0].load({ signal: controller.signal });
  const pdfChunks = [];
  for await (const chunk of loadedPdf.stream) pdfChunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(pdfChunks).toString(), 'pdf');
  assert.deepEqual(fileLoads, [{
    fileId: 'pdf-document',
    options: { signal: controller.signal },
  }]);
});

test('Telegram bridge ignores unaddressed groups and streams direct replies', async () => {
  const sent = [];
  const sentTargets = [];
  const updates = [];
  const bot = {
    sendText: async (target, text) => {
      sentTargets.push(target);
      sent.push(text);
    },
    sendTyping: async () => {},
    openStream: async () => ({
      update: async (text) => updates.push(text),
      finish: async (text) => sent.push(text),
    }),
  };
  let askCount = 0;
  const harness = {
    ensureRunning: async () => true,
    sessionExists: async () => true,
    createSession: async () => 'session-1',
    ask: async (_session, _text, options) => {
      askCount += 1;
      await options.onUpdate({ type: 'tool', name: '搜索' });
      await options.onUpdate({ type: 'text', text: '处理中' });
      return '完成';
    },
  };
  const state = memoryState();
  const bridge = new TelegramHarnessBridge({ bot, harness, state });
  await bridge.accept({
    messageId: '1', senderId: 'u1', kind: 'group', conversationId: 'g1', content: 'ignored',
    addressed: false, replyTarget: {},
  });
  assert.equal(askCount, 0);
  await bridge.accept({
    messageId: '2', senderId: 'u1', kind: 'direct', conversationId: 'u1', content: 'hello',
    addressed: true,
    replyTarget: { chatId: 88, replyToMessageId: 7 },
    connectionTestTarget: { chatId: 88 },
  });
  assert.equal(askCount, 1);
  assert.deepEqual(updates, ['正在使用搜索…', '处理中']);
  assert.deepEqual(sent, ['完成']);
  await bridge.sendConnectionTest('card test');
  assert.equal(sent.at(-1), 'card test');
  assert.deepEqual(sentTargets.at(-1), { chatId: 88 });
  const reconnectedBridge = new TelegramHarnessBridge({ bot, harness, state });
  await reconnectedBridge.sendConnectionTest('after reconnect');
  assert.equal(sent.at(-1), 'after reconnect');
  assert.deepEqual(sentTargets.at(-1), { chatId: 88 });
});

test('Telegram bridge routes outbound image artifacts natively with safe file fallback', async (t) => {
  const scenarios = [{
    name: 'native image',
    suffix: 'native-image',
    fileName: 'result.png',
    content: Buffer.from([1, 2, 3]),
    expectedCalls: ['image:result.png:image/png'],
    expectedOutcome: 'sent',
  }, {
    name: 'ordinary file',
    suffix: 'ordinary-file',
    fileName: 'result.txt',
    content: 'ordinary file',
    expectedCalls: ['file:result.txt:text/plain'],
    expectedOutcome: 'sent',
  }, {
    name: 'definitive image rejection',
    suffix: 'image-fallback',
    fileName: 'result.webp',
    content: Buffer.from([4, 5, 6]),
    imageErrorCode: 'artifact-provider-rejected',
    expectedCalls: ['image:result.webp:image/webp', 'file:result.webp:image/webp'],
    expectedOutcome: 'sent',
  }, {
    name: 'uncertain image result',
    suffix: 'image-uncertain',
    fileName: 'result.gif',
    content: Buffer.from([7, 8, 9]),
    imageErrorCode: 'artifact-delivery-uncertain',
    expectedCalls: ['image:result.gif:image/gif'],
    expectedOutcome: 'unknown',
  }];

  for (const scenario of scenarios) {
    const artifact = await committedTelegramArtifact(t, scenario);
    const calls = [];
    const bot = {
      sendText: async () => ({ message_id: `text-${scenario.suffix}` }),
      sendImage: async (_target, file) => {
        calls.push(`image:${file.fileName}:${file.mediaType}`);
        if (scenario.imageErrorCode) {
          const error = new Error(scenario.imageErrorCode);
          error.code = scenario.imageErrorCode;
          throw error;
        }
        return { message_id: `image-${scenario.suffix}` };
      },
      sendFile: async (_target, file) => {
        calls.push(`file:${file.fileName}:${file.mediaType}`);
        return { message_id: `file-${scenario.suffix}` };
      },
    };
    const bridge = new TelegramHarnessBridge({
      bot,
      state: memoryState(),
      logger: { warn() {}, error() {} },
      harness: {
        createSession: async () => `session-${scenario.suffix}`,
        ask: async (_sessionId, _text, options) => {
          await options.onArtifact(artifact);
          return '图片已生成。';
        },
      },
    });

    const receipt = await bridge.accept({
      messageId: `telegram-artifact-${scenario.suffix}`,
      senderId: '42',
      kind: 'direct',
      conversationId: `telegram-artifact-${scenario.suffix}`,
      content: '生成结果',
      addressed: true,
      replyTarget: { chatId: 88, replyToMessageId: 7, messageThreadId: 9 },
    });

    assert.deepEqual(calls, scenario.expectedCalls, scenario.name);
    assert.equal(receipt.artifacts[0].outcome, scenario.expectedOutcome, scenario.name);
  }
});

test('Telegram runtime validates webhook state and starts a cancellable long poll', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-telegram-runtime-'));
  const state = await new TelegramStateStore(join(directory, 'state.json')).load();
  const calls = [];
  const fakeApi = {
    getMe: async () => ({ id: 123456789, is_bot: true }),
    getWebhookInfo: async () => ({ url: '' }),
    setMyCommands: async ({ commands }) => {
      calls.push({ method: 'setMyCommands', commands });
      return true;
    },
    setChatMenuButton: async ({ menuButton }) => {
      calls.push({ method: 'setChatMenuButton', menuButton });
      return true;
    },
    getUpdates: async ({ offset, timeout, signal }) => {
      calls.push({ method: 'getUpdates', offset, timeout });
      if (timeout === 0) return [];
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true }));
    },
    sendMessage: async (request) => {
      calls.push({ method: 'sendMessage', ...request });
      return { message_id: 900 };
    },
  };
  const runtime = new TelegramRuntime({
    config: {
      botId: 'telegram_test',
      platformId: '123456789',
      username: 'HarnessBot',
    },
    token: TOKEN,
    harness: { ensureRunning: async () => true },
    state,
    createApi: () => fakeApi,
  });
  await runtime.start();
  assert.equal(runtime.status.ready, true);
  assert.equal(runtime.status.connectionState, 'connected');
  assert.deepEqual(await runtime.sendProactiveText({
    kind: 'topic',
    route: { chatId: '-1001234567890', messageThreadId: 42 },
  }, 'proactive-test'), { providerMessageIds: ['900'] });
  const proactiveCall = calls.find(({ method }) => method === 'sendMessage');
  assert.equal(proactiveCall.chatId, -1001234567890);
  assert.equal(proactiveCall.messageThreadId, 42);
  assert.equal(proactiveCall.replyToMessageId, undefined);
  assert.equal(proactiveCall.text, 'proactive-test');
  await runtime.stop();
  assert.equal(runtime.status.ready, false);
  assert.deepEqual(calls[0], { method: 'setMyCommands', commands: TELEGRAM_COMMAND_MENU });
  assert.deepEqual(calls[1], { method: 'setChatMenuButton', menuButton: COMMANDS_MENU_BUTTON });
  assert.deepEqual(calls[2], { method: 'getUpdates', offset: -1, timeout: 0 });
  await rm(directory, { recursive: true, force: true });
});

test('Telegram runtime recovers an old bot reply from its bound Session history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-telegram-reply-history-'));
  const state = await new TelegramStateStore(join(directory, 'state.json')).load();
  await state.setSession('direct:88', 'session-reply-history');
  const quotedAt = Math.floor((Date.now() - 5_000) / 1_000) * 1_000;
  let delivered = false;
  let prompt;
  const runtime = new TelegramRuntime({
    config: {
      botId: 'telegram_reply_history',
      platformId: '123456789',
      username: 'HarnessBot',
    },
    token: TOKEN,
    harness: {
      ensureRunning: async () => true,
      workspaceSession: () => ({
        sessionExists: async () => true,
        readHistory: async () => ({
          events: [
            { event: { type: 'turn/start', seq: 1, time: quotedAt - 1_000, data: { turn: 3 } } },
            { event: {
              type: 'assistant/message',
              seq: 2,
              time: quotedAt,
              data: {
                turn: 3,
                message: { content: [{ type: 'text', text: 'Telegram 老消息正文' }] },
              },
            } },
            { event: {
              type: 'turn/end',
              seq: 3,
              time: quotedAt + 1,
              data: { turn: 3, reason: { kind: 'completed' } },
            } },
          ],
          hasMore: false,
        }),
        ask: async (content) => { prompt = content; return '已识别 Telegram 引用'; },
      }),
    },
    state,
    createApi: () => ({
      getMe: async () => ({ id: 123456789, is_bot: true }),
      getWebhookInfo: async () => ({ url: '' }),
      setMyCommands: async () => true,
      setChatMenuButton: async () => true,
      getUpdates: async ({ timeout, signal }) => {
        if (timeout === 0) return [];
        if (!delivered) {
          delivered = true;
          return [{
            update_id: 0,
            message: {
              message_id: 400,
              chat: { id: 88, type: 'private' },
              from: { id: 42, is_bot: false },
              text: '这条老消息说了什么？',
              reply_to_message: {
                message_id: 323,
                date: quotedAt / 1_000,
                from: { id: 123456789, is_bot: true, first_name: '今天是梁子' },
              },
            },
          }];
        }
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      setMessageReaction: async () => true,
      sendChatAction: async () => true,
      sendRichMessageDraft: async () => true,
      sendRichMessage: async () => ({ message_id: 401 }),
      sendMessage: async () => ({ message_id: 401 }),
      editMessageText: async () => true,
    }),
  });

  try {
    await runtime.start();
    await bounded((async () => {
      while (state.cursor() !== 1 || prompt === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })(), 'Telegram reply history was not processed');
    assert.match(prompt[0].text, /"content":"Telegram 老消息正文"/);
    assert.doesNotMatch(prompt[0].text, /unavailableReason/);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Telegram runtime still starts when the command menu setup fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-telegram-menu-failure-'));
  const state = await new TelegramStateStore(join(directory, 'state.json')).load();
  const warnings = [];
  let delivered = false;
  const fakeApi = {
    getMe: async () => ({ id: 123456789, is_bot: true }),
    getWebhookInfo: async () => ({ url: '' }),
    setMyCommands: async () => {
      throw new Error('telegram-502 Bad Gateway');
    },
    setChatMenuButton: async () => {
      throw new Error('telegram-502 Bad Gateway');
    },
    getUpdates: async ({ timeout, signal }) => {
      if (timeout === 0) return [];
      if (!delivered) {
        delivered = true;
        return [];
      }
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true }));
    },
  };
  const runtime = new TelegramRuntime({
    config: {
      botId: 'telegram_menu_failure',
      platformId: '123456789',
      username: 'HarnessBot',
    },
    token: TOKEN,
    harness: { ensureRunning: async () => true },
    state,
    createApi: () => fakeApi,
    logger: { warn: (message) => warnings.push(message), error() {} },
  });
  try {
    await runtime.start();
    assert.equal(runtime.status.ready, true);
    assert.equal(runtime.status.connectionState, 'connected');
    assert.match(warnings.at(-1), /command menu setup failed/);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Telegram runtime enforces the unified direct and group access policy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-telegram-allowlist-runtime-'));
  const state = await new TelegramStateStore(join(directory, 'state.json')).load();
  const asked = [];
  let delivered = false;
  let nextMessageId = 500;
  const updates = [
    {
      update_id: 0,
      message: {
        message_id: 100,
        chat: { id: -1001, type: 'group' },
        from: { id: 7, is_bot: false },
        text: '@HarnessBot group',
        entities: [{ type: 'mention', offset: 0, length: 11 }],
      },
    },
    {
      update_id: 1,
      message: {
        message_id: 101,
        chat: { id: 7, type: 'private' },
        from: { id: 7, is_bot: false },
        text: 'allowed direct',
      },
    },
    {
      update_id: 2,
      message: {
        message_id: 102,
        chat: { id: 8, type: 'private' },
        from: { id: 8, is_bot: false },
        text: 'denied direct',
      },
    },
  ];
  const fakeApi = {
    getMe: async () => ({ id: 123456789, is_bot: true }),
    getWebhookInfo: async () => ({ url: '' }),
    setMyCommands: async () => true,
    setChatMenuButton: async () => true,
    getUpdates: async ({ timeout, signal }) => {
      if (timeout === 0) return [];
      if (!delivered) {
        delivered = true;
        return updates;
      }
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    sendChatAction: async () => true,
    sendRichMessageDraft: async () => true,
    sendRichMessage: async () => ({ message_id: nextMessageId++ }),
    sendMessage: async () => ({ message_id: nextMessageId++ }),
    editMessageText: async () => true,
  };
  const runtime = new TelegramRuntime({
    config: {
      botId: 'telegram_allowlist',
      platformId: '123456789',
      username: 'HarnessBot',
      // Kept deliberately contradictory: legacy fields are migration input,
      // not a second active Runtime gate after unified policy injection.
      accessMode: TELEGRAM_ACCESS_MODES.privateAllowlist,
      allowedUsers: ['999'],
    },
    token: TOKEN,
    harness: {
      ensureRunning: async () => true,
      createSession: async () => 'session-allowlist',
      ask: async (_sessionId, text) => {
        asked.push(text);
        return 'done';
      },
    },
    state,
    accessPolicy: {
      getSettings: () => ({
        direct: {
          mode: 'allowlist',
          open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
          allowlist: { users: [{ id: '7', canExecuteCommands: true }] },
        },
        group: {
          mode: 'allowlist',
          open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
          allowlist: { users: [] },
        },
      }),
    },
    createApi: () => fakeApi,
  });

  try {
    await runtime.start();
    await bounded((async () => {
      while (state.cursor() !== 3 || asked.length !== 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })(), 'Telegram safe-mode updates were not processed');
    assert.deepEqual(asked, ['allowed direct']);
    assert.equal(runtime.status.messagesRejected, 2);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: 'two private messages', kinds: ['private', 'private'], before: [true, true], after: [false, false] },
  { name: 'mixed private/group messages', kinds: ['private', 'supergroup'], before: [false, true], after: [true, false] },
  { name: 'disabled private messages before enabling', kinds: ['private', 'private'], before: [false, false], after: [true, true] },
]) {
  test(`Telegram received poll batch retains its settings across cursor writes: ${scenario.name}`, async () => {
    const firstCursorStarted = deferred();
    const releaseFirstCursor = deferred();
    const allPrompts = deferred();
    const seen = new Set();
    const asked = [];
    const pollOffsets = [];
    const cursorWrites = [];
    let cursor = 10;
    let settingsReads = 0;
    let nextMessageId = 500;
    const configFor = ([directEnabled, groupEnabled], guidance) => ({
      group: { enabled: groupEnabled, fields: ['channel', 'botId'], guidance },
      direct: { enabled: directEnabled, fields: ['channel', 'botId'], guidance },
    });
    let config = configFor(scenario.before, 'before cursor write');
    const update = (id, kind) => ({
      update_id: id,
      message: {
        message_id: id + 100,
        chat: { id: kind === 'private' ? 42 : -1001, type: kind },
        from: { id: 7, is_bot: false, first_name: 'Ada' },
        text: kind === 'private' ? `message ${id}` : `@HarnessBot message ${id}`,
        entities: kind === 'private' ? [] : [{ type: 'mention', offset: 0, length: 11 }],
      },
    });
    const firstBatch = scenario.kinds.map((kind, index) => update(10 + index, kind));
    const nextBatch = ['private', 'supergroup'].map((kind, index) => update(12 + index, kind));
    const runtime = new TelegramRuntime({
      config: { botId: 'telegram_poll', platformId: '123456789', username: 'HarnessBot' },
      token: TOKEN,
      contextEnhancement: {
        botId: 'telegram_poll',
        getSettings: () => { settingsReads += 1; return config; },
      },
      state: {
        cursor: () => cursor,
        setCursor: async (value) => {
          cursorWrites.push(value);
          if (value === 11) {
            firstCursorStarted.resolve();
            await releaseFirstCursor.promise;
          }
          cursor = value;
        },
        hasSeen: (id) => seen.has(id),
        markSeen: async (id) => seen.add(id),
        sessionFor: () => 'session-existing',
      },
      harness: {
        ensureRunning: async () => true,
        sessionExists: async () => true,
        ask: async (_sessionId, text) => {
          asked.push(text);
          if (asked.length === 4) allPrompts.resolve();
          return 'done';
        },
      },
      createApi: () => ({
        getMe: async () => ({ id: 123456789, is_bot: true }),
        getWebhookInfo: async () => ({ url: '' }),
        setMyCommands: async () => true,
        setChatMenuButton: async () => true,
        getUpdates: async ({ offset, signal }) => {
          pollOffsets.push(offset);
          if (offset === 10) return firstBatch;
          if (offset === 12) return nextBatch;
          assert.equal(offset, 14);
          return new Promise((_, reject) => {
            if (signal.aborted) return reject(signal.reason);
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
        setMessageReaction: async () => true,
        sendChatAction: async () => true,
        sendRichMessageDraft: async () => true,
        sendRichMessage: async () => ({ message_id: nextMessageId++ }),
        sendMessage: async () => ({ message_id: nextMessageId++ }),
        editMessageText: async () => true,
      }),
      logger: { warn() {}, error() {} },
    });
    try {
      await runtime.start();
      await bounded(firstCursorStarted.promise, 'first cursor write was not reached', 5_000);
      assert.equal(settingsReads, 2, 'every received update captures its settings before the first cursor await');
      config = configFor(scenario.after, 'after cursor write');
      releaseFirstCursor.resolve();
      await bounded(allPrompts.promise, 'both poll batches did not reach Harness', 5_000);
      for (const [index, event] of [...firstBatch, ...nextBatch].entries()) {
        const expectedText = `message ${event.update_id}`;
        const content = asked.find((text) => text.endsWith(expectedText));
        assert.ok(content, `Missing prompt ${event.update_id}`);
        const switches = index < 2 ? scenario.before : scenario.after;
        const enabled = switches[event.message.chat.type === 'private' ? 0 : 1];
        if (enabled) {
          assert.match(content, index < 2 ? /before cursor write/ : /after cursor write/);
          assert.deepEqual(JSON.parse(/^<dsh_im_source>(.*?)<\/dsh_im_source>/su.exec(content)[1]), {
            channel: 'telegram', botId: 'telegram_poll',
          });
        } else {
          assert.equal(content, expectedText);
        }
      }
      assert.equal(settingsReads, 4, 'Bridge reuses the snapshot instead of reading settings again');
      assert.deepEqual(pollOffsets, [10, 12, 14]);
      assert.deepEqual(cursorWrites, [11, 12, 13, 14]);
      assert.deepEqual([...seen].sort(), ['10', '11', '12', '13']);
    } finally {
      releaseFirstCursor.resolve();
      await runtime.stop();
    }
  });
}

test('Telegram runtime keeps polling while a Harness question waits for its answer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-telegram-interaction-'));
  const state = await new TelegramStateStore(join(directory, 'state.json')).load();
  const questionSent = deferred();
  const secondPollStarted = deferred();
  const answerSubmitted = deferred();
  const releaseTurn = deferred();
  const finalReplySent = deferred();
  const pollOffsets = [];
  const asked = [];
  let answerUpdateDelivered = false;
  let originalTurnEnded = false;
  let nextOutboundMessageId = 500;

  const promptUpdate = {
    update_id: 10,
    message: {
      message_id: 100,
      chat: { id: 42, type: 'private' },
      from: { id: 7, is_bot: false },
      text: '请先询问测试环境',
    },
  };
  const answerUpdate = {
    update_id: 11,
    message: {
      message_id: 101,
      chat: { id: 42, type: 'private' },
      from: { id: 7, is_bot: false },
      text: '2',
    },
  };
  const fakeApi = {
    getMe: async () => ({ id: 123456789, is_bot: true }),
    getWebhookInfo: async () => ({ url: '' }),
    getUpdates: async ({ offset, timeout, signal }) => {
      pollOffsets.push(offset);
      if (timeout === 0) return [];
      if (offset === 0) return [promptUpdate];
      if (offset === 11) {
        secondPollStarted.resolve(originalTurnEnded);
        await questionSent.promise;
        answerUpdateDelivered = true;
        return [answerUpdate];
      }
      assert.equal(offset, 12);
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    sendChatAction: async () => true,
    sendMessage: async ({ text }) => {
      const messageId = nextOutboundMessageId;
      nextOutboundMessageId += 1;
      if (text.includes('请选择测试环境')) questionSent.resolve();
      return { message_id: messageId };
    },
    sendRichMessageDraft: async () => true,
    sendRichMessage: async ({ richMessage }) => {
      if (richMessage.markdown === '已选择生产环境') finalReplySent.resolve();
      const messageId = nextOutboundMessageId;
      nextOutboundMessageId += 1;
      return { message_id: messageId };
    },
    editMessageText: async ({ text }) => {
      if (text === '已选择生产环境') finalReplySent.resolve();
      return true;
    },
  };
  const harness = {
    ensureRunning: async () => true,
    createSession: async () => 'session-runtime-interaction',
    ask: async (sessionId, text, options) => {
      asked.push({ sessionId, text });
      if (text !== '请先询问测试环境') return '不应将答案当成新 prompt';
      await options.onInteraction({
        kind: 'question',
        interactionId: 'telegram-runtime-question',
        rpcId: 'telegram-runtime-question',
        sessionId,
        payload: {
          type: 'question/requested',
          sessionId,
          questions: [{
            id: 'environment',
            question: '请选择测试环境',
            options: [{ label: '测试环境' }, { label: '生产环境' }],
          }],
        },
        respond: async (result) => {
          assert.equal(answerUpdateDelivered, true);
          assert.equal(originalTurnEnded, false);
          answerSubmitted.resolve(result);
          return { accepted: true };
        },
      });
      await Promise.race([
        answerSubmitted.promise,
        new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
        }),
      ]);
      await releaseTurn.promise;
      originalTurnEnded = true;
      return '已选择生产环境';
    },
  };
  const runtime = new TelegramRuntime({
    config: {
      botId: 'telegram_interaction',
      platformId: '123456789',
      username: 'HarnessBot',
    },
    token: TOKEN,
    harness,
    state,
    createApi: () => fakeApi,
    logger: { error() {}, warn() {} },
    allowedPrivateUserIds: ['7'],
  });

  try {
    await runtime.start();
    assert.equal(await bounded(
      secondPollStarted.promise,
      'poller did not request the answer update while the first turn was active',
    ), false);
    const submitted = await bounded(
      answerSubmitted.promise,
      'the Telegram answer was not submitted through the interaction fast path',
    );
    assert.deepEqual(submitted, {
      ok: true,
      value: {
        sessionId: 'session-runtime-interaction',
        answer: {
          answers: [{ id: 'environment', selected: ['生产环境'] }],
        },
      },
    });
    assert.equal(originalTurnEnded, false);
    assert.deepEqual(asked, [{
      sessionId: 'session-runtime-interaction',
      text: '请先询问测试环境',
    }]);

    await bounded((async () => {
      while (state.cursor() !== 12) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })(), 'Telegram cursor did not advance past the answer update');
    assert.deepEqual(pollOffsets.slice(0, 4), [-1, 0, 11, 12]);
    assert.equal(state.hasSeen('10'), true);
    assert.equal(state.hasSeen('11'), true);

    releaseTurn.resolve();
    await bounded(finalReplySent.promise, 'the original Harness turn did not finish');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(originalTurnEnded, true);
    assert.deepEqual(asked, [{
      sessionId: 'session-runtime-interaction',
      text: '请先询问测试环境',
    }]);
  } finally {
    releaseTurn.resolve();
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
