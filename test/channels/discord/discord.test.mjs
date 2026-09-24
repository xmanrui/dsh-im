import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DiscordConfigStore,
  deriveDiscordBotIdentity,
} from '../../../src/channels/discord/config-store.mjs';
import { DiscordController } from '../../../src/channels/discord/discord-controller.mjs';
import {
  DiscordApi,
  inspectDiscordToken,
  validDiscordToken,
} from '../../../src/channels/discord/discord-api.mjs';
import {
  DiscordBotClient,
  DiscordRuntime,
  normalizeDiscordMessage,
  resolveDiscordMessageRoute,
} from '../../../src/channels/discord/discord-runtime.mjs';
import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import { COMMAND_PERMISSION_DENIED_MESSAGE } from '../../../src/channels/shared/inbound-access.mjs';
import {
  DISCORD_ENDPOINTS,
  createDiscordRpcHandler,
} from '../../../plugin-src/host/channels/discord/rpc.mjs';

const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.ABCD.abcdefghijklmnopqrstuvwxyz123456';

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function eventually(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition was not met before timeout');
}

test('Discord API authenticates with a Bot header and validates the current bot', async () => {
  assert.equal(validDiscordToken(TOKEN), true);
  assert.equal(validDiscordToken('not-a-token'), false);
  const calls = [];
  const bot = await inspectDiscordToken(TOKEN, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        id: '1234567890123456789',
        bot: true,
        username: 'HarnessBot',
        global_name: 'Harness Discord',
      });
    },
  });
  assert.deepEqual(bot, {
    platformId: '1234567890123456789',
    name: 'Harness Discord',
    username: 'HarnessBot',
  });
  assert.equal(calls[0].options.headers.authorization, `Bot ${TOKEN}`);
  assert.match(calls[0].url.pathname, /users\/@me$/);

  const api = new DiscordApi({
    token: TOKEN,
    fetchImpl: async () => jsonResponse({ message: '401: Unauthorized' }, 401),
  });
  await assert.rejects(() => api.getCurrentUser(), (error) => {
    assert.equal(error.code, 'discord-401');
    assert.doesNotMatch(error.message, new RegExp(TOKEN.replaceAll('.', '\\.')));
    return true;
  });
});

test('Discord API retries one rate-limited message request', async () => {
  let attempts = 0;
  const api = new DiscordApi({
    token: TOKEN,
    fetchImpl: async () => {
      attempts += 1;
      return attempts === 1
        ? jsonResponse({ message: 'rate limited', retry_after: 0.001 }, 429)
        : jsonResponse({ id: '987654321012345678', content: 'hello' });
    },
  });
  const message = await api.createMessage({
    channelId: '123456789012345678',
    content: 'hello',
  });
  assert.equal(message.id, '987654321012345678');
  assert.equal(attempts, 2);
});

test('Discord API reads a referenced message from the current channel', async () => {
  let request;
  const api = new DiscordApi({
    token: TOKEN,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({
        id: '987654321012345678',
        channel_id: '123456789012345678',
        content: 'quoted',
      });
    },
  });
  const message = await api.getMessage({
    channelId: '123456789012345678',
    messageId: '987654321012345678',
  });
  assert.equal(message.content, 'quoted');
  assert.equal(
    request.url.pathname,
    '/api/v10/channels/123456789012345678/messages/987654321012345678',
  );
  assert.equal(request.options.method, 'GET');
});

test('Discord API gets a channel and starts one thread from a source message', async () => {
  const requests = [];
  const api = new DiscordApi({
    token: TOKEN,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (options.method === 'GET') {
        return jsonResponse({ id: '222222222222222223', type: 0 });
      }
      return jsonResponse({
        id: '111111111111111112',
        type: 11,
        parent_id: '222222222222222223',
      });
    },
  });

  const channel = await api.getChannel({ channelId: '222222222222222223' });
  const thread = await api.startThreadFromMessage({
    channelId: channel.id,
    messageId: '111111111111111112',
    name: 'one focused task',
  });

  assert.equal(channel.type, 0);
  assert.equal(thread.type, 11);
  assert.equal(requests[0].url.pathname, '/api/v10/channels/222222222222222223');
  assert.equal(
    requests[1].url.pathname,
    '/api/v10/channels/222222222222222223/messages/111111111111111112/threads',
  );
  assert.equal(requests[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[1].options.body), { name: 'one focused task' });

  const controller = new AbortController();
  const reason = new DOMException('stopped before routing', 'AbortError');
  controller.abort(reason);
  assert.throws(() => api.startThreadFromMessage({
    channelId: channel.id,
    messageId: '111111111111111113',
    name: 'cancelled',
    signal: controller.signal,
  }), (error) => error === reason);
  assert.equal(requests.length, 2);
});

test('Discord API adds and removes the current bot reaction with an encoded emoji', async () => {
  const requests = [];
  const api = new DiscordApi({
    token: TOKEN,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(null, { status: 204 });
    },
  });
  const target = {
    channelId: '123456789012345678',
    messageId: '987654321012345678',
  };

  assert.equal(await api.addOwnReaction({ ...target, emoji: '👀' }), '👀');
  await api.removeOwnReaction({ ...target, emoji: '👀' });

  assert.deepEqual(requests.map(({ options }) => options.method), ['PUT', 'DELETE']);
  assert.equal(
    decodeURIComponent(requests[0].url.pathname),
    '/api/v10/channels/123456789012345678/messages/987654321012345678/reactions/👀/@me',
  );
  assert.equal(requests[1].url.pathname, requests[0].url.pathname);
  assert.equal(requests[0].options.body, undefined);
});

test('Discord API uploads a result file as a native attachment and preserves the reply', async () => {
  let request;
  const api = new DiscordApi({
    token: TOKEN,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({ id: '987654321012345679', attachments: [{ id: '1' }] });
    },
  });
  const result = await api.createFileMessage({
    channelId: '123456789012345678',
    replyToMessageId: '123456789012345679',
    file: {
      artifactId: 'artifact-discord-one',
      deliveryKey: 'session:turn:artifact-discord-one',
      fileName: 'result.html',
      mediaType: 'text/html',
      bytes: Buffer.from('<p>discord-result</p>'),
    },
  });

  assert.equal(result.id, '987654321012345679');
  assert.match(request.url.pathname, /channels\/123456789012345678\/messages$/);
  assert.equal(request.options.headers['content-type'], undefined);
  assert.ok(request.options.body instanceof FormData);
  const payload = JSON.parse(request.options.body.get('payload_json'));
  assert.deepEqual(payload.attachments, [{ id: 0, filename: 'result.html' }]);
  assert.match(payload.nonce, /^[0-9a-f]{25}$/);
  assert.equal(payload.enforce_nonce, true);
  assert.equal(payload.message_reference.message_id, '123456789012345679');
  assert.deepEqual(payload.allowed_mentions, { parse: [], replied_user: false });
  const attachment = request.options.body.get('files[0]');
  assert.equal(attachment.name, 'result.html');
  assert.equal(attachment.type, 'text/html');
  assert.equal(Buffer.from(await attachment.arrayBuffer()).toString(), '<p>discord-result</p>');
});

test('Discord sends PNG and JPEG artifacts as one native inline-preview attachment each', async () => {
  const requests = [];
  const api = new DiscordApi({
    token: TOKEN,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({ id: '987654321012345681', attachments: [{ id: '1' }] });
    },
  });

  for (const [index, image] of [{
    fileName: 'result.png',
    mediaType: 'image/png',
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  }, {
    fileName: 'result.jpg',
    mediaType: 'image/jpeg',
    bytes: Buffer.from([0xff, 0xd8, 0xff]),
  }].entries()) {
    await api.createFileMessage({
      channelId: '123456789012345678',
      file: {
        artifactId: `artifact-discord-image-${index}`,
        deliveryKey: `session:turn:artifact-discord-image-${index}`,
        ...image,
      },
    });

    const request = requests[index];
    assert.match(request.url.pathname, /channels\/123456789012345678\/messages$/);
    const payload = JSON.parse(request.options.body.get('payload_json'));
    assert.deepEqual(payload.attachments, [{ id: 0, filename: image.fileName }]);
    const attachment = request.options.body.get('files[0]');
    assert.equal(attachment.name, image.fileName);
    assert.equal(attachment.type, image.mediaType);
  }
  assert.equal(requests.length, 2);
});

test('Discord attachment retry reuses one FormData body and one stable nonce', async () => {
  const bodies = [];
  const nonces = [];
  let attempts = 0;
  const api = new DiscordApi({
    token: TOKEN,
    fetchImpl: async (_url, options) => {
      attempts += 1;
      bodies.push(options.body);
      nonces.push(JSON.parse(options.body.get('payload_json')).nonce);
      return attempts === 1
        ? jsonResponse({ code: 20028, message: 'rate limited', retry_after: 0.001 }, 429)
        : jsonResponse({ id: '987654321012345680', attachments: [{ id: '1' }] });
    },
  });
  const result = await api.createFileMessage({
    channelId: '123456789012345678',
    file: {
      deliveryKey: 'session:turn:artifact-retry',
      fileName: 'result.txt',
      bytes: Buffer.from('retry-safe'),
    },
  });

  assert.equal(result.id, '987654321012345680');
  assert.equal(attempts, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(nonces[0], nonces[1]);
  assert.match(nonces[0], /^[0-9a-f]{25}$/);
});

test('Discord attachment errors retain provider details and use stable artifact reasons', async () => {
  const cases = [{
    body: { code: 50013, message: 'Missing Permissions' },
    status: 403,
    code: 'artifact-permission-required',
  }, {
    body: { code: 40005, message: 'Request entity too large' },
    status: 413,
    code: 'artifact-too-large',
  }, {
    body: { code: 20028, message: 'rate limited', retry_after: 0.001 },
    status: 429,
    code: 'artifact-rate-limited',
    retryAfter: 0.001,
  }, {
    body: { code: 50035, message: 'Invalid Form Body' },
    status: 400,
    code: 'artifact-provider-rejected',
  }, {
    body: { code: 0, message: 'Internal Server Error' },
    status: 500,
    code: 'artifact-delivery-uncertain',
  }];

  for (const entry of cases) {
    const api = new DiscordApi({
      token: TOKEN,
      fetchImpl: async () => jsonResponse(entry.body, entry.status),
    });
    await assert.rejects(() => api.createFileMessage({
      channelId: '123456789012345678',
      file: { fileName: 'result.bin', bytes: Buffer.from('result') },
    }), (error) => {
      assert.equal(error.code, entry.code);
      assert.equal(error.providerCode, entry.body.code);
      assert.equal(error.status, entry.status);
      assert.equal(error.retry_after, entry.retryAfter);
      assert.equal(error.retryAfter, entry.retryAfter);
      return true;
    });
  }
});

test('Discord attachment delivery marks post-dispatch failures uncertain but preserves caller aborts', async () => {
  for (const fetchImpl of [
    async () => { throw new TypeError('socket reset'); },
    async () => new Response('not-json', { status: 200 }),
  ]) {
    const api = new DiscordApi({ token: TOKEN, fetchImpl });
    await assert.rejects(() => api.createFileMessage({
      channelId: '123456789012345678',
      file: { fileName: 'result.bin', bytes: Buffer.from('result') },
    }), (error) => error.code === 'artifact-delivery-uncertain');
  }

  const timeoutApi = new DiscordApi({
    token: TOKEN,
    fileUploadTimeoutMs: 10,
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  await assert.rejects(() => timeoutApi.createFileMessage({
    channelId: '123456789012345678',
    file: { fileName: 'result.bin', bytes: Buffer.from('result') },
  }), (error) => error.code === 'artifact-delivery-uncertain'
    && error.cause?.name === 'TimeoutError');

  const caller = new AbortController();
  const reason = new DOMException('caller stopped', 'AbortError');
  caller.abort(reason);
  let calls = 0;
  const cancelledApi = new DiscordApi({
    token: TOKEN,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ id: '987654321012345680' });
    },
  });
  await assert.rejects(() => cancelledApi.createFileMessage({
    channelId: '123456789012345678',
    file: { fileName: 'result.bin', bytes: Buffer.from('result') },
    signal: caller.signal,
  }), (error) => error === reason && error.code !== 'artifact-delivery-uncertain');
  assert.equal(calls, 0);
});

test('Discord controller persists a credential reference and exposes only masked identity', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-discord-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'config.json');
  const configStore = await new DiscordConfigStore(configPath).load();
  const credentialStore = credentials();
  const proactiveSends = [];
  const controller = new DiscordController({
    credentials: credentialStore,
    configStore,
    inspectToken: async () => ({
      platformId: '1234567890123456789',
      name: 'Harness Discord',
      username: 'HarnessBot',
    }),
    createRuntime: async () => ({
      status: {
        ready: true,
        connectionState: 'connected',
        harnessReachable: true,
        lastCheckedAt: 20,
      },
      async start() {},
      async stop() {},
      async sendProactiveText(...args) {
        proactiveSends.push(args);
        return { sent: true };
      },
    }),
  });
  const status = await controller.bindCredentials({ token: TOKEN });
  assert.equal(status.totals.connected, 1);
  assert.equal(status.bots[0].bot.name, 'Harness Discord');
  setImHostLanguage('en');
  try {
    assert.equal(
      controller.status().bots[0].health.summary,
      'The Discord Gateway long-lived connection is running normally',
    );
  } finally {
    setImHostLanguage('zh');
  }
  const identity = deriveDiscordBotIdentity('1234567890123456789');
  assert.equal(credentialStore.values.get(identity.tokenRef), TOKEN);
  assert.doesNotMatch(await readFile(configPath, 'utf8'), new RegExp(TOKEN.replaceAll('.', '\\.')));
  const target = { kind: 'channel', route: { channelId: '222222222222222222' } };
  assert.deepEqual(await controller.sendProactiveText(identity.botId, target, 'proactive-test'), {
    sent: true,
  });
  assert.deepEqual(proactiveSends, [[target, 'proactive-test', {}]]);
  await controller.deleteBot(identity.botId);
  assert.equal(credentialStore.values.has(identity.tokenRef), false);
});

test('Discord RPC rejects extra credential fields and removes token internals', async () => {
  const controller = {
    status: () => ({ bots: [], totals: { configured: 0, connected: 0 } }),
    bindCredentials: async () => ({
      bots: [{
        botId: 'discord_123',
        token: TOKEN,
        tokenRef: 'DSH_DISCORD_BOT_TOKEN_ABC',
        bot: { name: 'Discord机器人', idMasked: '123•••' },
      }],
      totals: { configured: 1, connected: 0 },
    }),
    reconnectBot: async () => ({ bots: [], totals: { configured: 0, connected: 0 } }),
    deleteBot: async () => ({ bots: [], totals: { configured: 0, connected: 0 } }),
  };
  const handler = createDiscordRpcHandler(controller);
  const result = await handler(DISCORD_ENDPOINTS.bindCredentials, { token: TOKEN });
  assert.equal(result.ok, true);
  assert.equal(result.value.bots[0].token, undefined);
  assert.equal(result.value.bots[0].tokenRef, undefined);
  const rejected = await handler(DISCORD_ENDPOINTS.bindCredentials, { token: TOKEN, appId: 'x' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'bad-request');
});

test('Discord normalizes DMs and only addressed server messages', () => {
  const direct = normalizeDiscordMessage({
    id: '111111111111111111',
    channel_id: '222222222222222222',
    author: { id: '333333333333333333', bot: false },
    content: 'hello',
  }, '1234567890123456789');
  assert.equal(direct.kind, 'direct');
  assert.equal(direct.addressed, true);
  assert.equal(direct.plainText, true);
  assert.deepEqual(direct.connectionTestTarget, { channelId: '222222222222222222' });
  assert.deepEqual(direct.reactionTarget, {
    channelId: '222222222222222222',
    messageId: '111111111111111111',
  });

  const sticker = normalizeDiscordMessage({
    id: '111111111111111115',
    channel_id: '222222222222222222',
    author: { id: '333333333333333333', bot: false },
    content: 'sticker caption',
    sticker_items: [{ id: '555555555555555555', name: 'wave' }],
  }, '1234567890123456789');
  assert.equal(sticker.plainText, false);

  const poll = normalizeDiscordMessage({
    id: '111111111111111116',
    channel_id: '222222222222222222',
    author: { id: '333333333333333333', bot: false },
    content: 'poll caption',
    poll: { question: { text: 'choose one' } },
  }, '1234567890123456789');
  assert.equal(poll.plainText, false);

  const group = normalizeDiscordMessage({
    id: '111111111111111112',
    channel_id: '222222222222222223',
    guild_id: '444444444444444444',
    author: { id: '333333333333333334', bot: false },
    mentions: [{ id: '1234567890123456789' }],
    content: '<@1234567890123456789> run this',
  }, '1234567890123456789');
  assert.equal(group.kind, 'group');
  assert.equal(group.addressed, true);
  assert.equal(group.content, 'run this');

  const unmentionedReply = normalizeDiscordMessage({
    id: '111111111111111113',
    channel_id: '222222222222222223',
    guild_id: '444444444444444444',
    author: { id: '333333333333333334', bot: false },
    mentions: [],
    referenced_message: { author: { id: '1234567890123456789', bot: true } },
    content: '',
  }, '1234567890123456789');
  assert.equal(unmentionedReply.addressed, false);

  assert.equal(normalizeDiscordMessage({
    id: '111111111111111114',
    channel_id: '222222222222222224',
    guild_id: '444444444444444444',
    type: 21,
    author: { id: '333333333333333334', bot: false },
    content: '',
  }, '1234567890123456789'), null);
});

test('Discord uses reply snapshots, respects deleted markers, and loads absent snapshots lazily', async () => {
  const botId = '1234567890123456789';
  let loads = 0;
  const snapshot = normalizeDiscordMessage({
    id: '111111111111111170',
    channel_id: '222222222222222270',
    author: { id: '333333333333333370', bot: false },
    content: '解释原文',
    message_reference: { message_id: '111111111111111169' },
    referenced_message: {
      id: '111111111111111169',
      channel_id: '222222222222222270',
      author: { id: '333333333333333369', username: 'alice' },
      content: '第一层原文',
      attachments: [
        { filename: 'screen.png', content_type: 'image/png' },
        { filename: 'voice.ogg', content_type: 'audio/ogg' },
        { filename: 'clip.mp4', content_type: 'video/mp4' },
        { filename: 'brief.pdf', content_type: 'application/pdf' },
      ],
      referenced_message: { content: '不应递归进入 Prompt' },
    },
  }, botId, { loadReply: async () => { loads += 1; } });
  assert.equal(loads, 0);
  assert.deepEqual(snapshot.replyTo, {
    messageId: '111111111111111169',
    authorId: '333333333333333369',
    authorName: 'alice',
    content: '第一层原文',
    attachments: [
      { kind: 'image', name: 'screen.png' },
      { kind: 'audio', name: 'voice.ogg' },
      { kind: 'video', name: 'clip.mp4' },
      { kind: 'file', name: 'brief.pdf' },
    ],
  });
  assert.doesNotMatch(JSON.stringify(snapshot.replyTo), /不应递归/);

  const deleted = normalizeDiscordMessage({
    id: '111111111111111171',
    channel_id: '222222222222222270',
    author: { id: '333333333333333370', bot: false },
    content: '原文呢？',
    message_reference: { message_id: '111111111111111168' },
    referenced_message: null,
  }, botId, { loadReply: async () => { loads += 1; } });
  assert.deepEqual(deleted.replyTo, {
    messageId: '111111111111111168',
    unavailableReason: 'deleted',
  });
  assert.equal(loads, 0);

  const controller = new AbortController();
  const fallback = normalizeDiscordMessage({
    id: '111111111111111172',
    channel_id: '222222222222222270',
    author: { id: '333333333333333370', bot: false },
    content: '加载原文',
    message_reference: { message_id: '111111111111111167' },
  }, botId, {
    loadReply: async (options) => {
      loads += 1;
      assert.deepEqual(options, {
        channelId: '222222222222222270',
        messageId: '111111111111111167',
        signal: controller.signal,
      });
      return {
        id: '111111111111111167',
        channel_id: '222222222222222270',
        author: { id: '333333333333333367', global_name: 'Bob' },
        content: 'API 原文',
      };
    },
  });
  assert.equal(loads, 0);
  assert.deepEqual(await fallback.replyTo.load({ signal: controller.signal }), {
    messageId: '111111111111111167',
    authorId: '333333333333333367',
    authorName: 'Bob',
    content: 'API 原文',
    attachments: [],
  });
  assert.equal(loads, 1);

  for (const [label, reference, referencedMessage] of [
    ['reference channel', {
      message_id: '111111111111111166', channel_id: '222222222222222999',
    }, {
      id: '111111111111111166', channel_id: '222222222222222270',
      author: { id: '333333333333333366' }, content: 'wrong reference channel',
    }],
    ['snapshot channel', {
      message_id: '111111111111111165', channel_id: '222222222222222270',
    }, {
      id: '111111111111111165', channel_id: '222222222222222999',
      author: { id: '333333333333333365' }, content: 'wrong snapshot channel',
    }],
    ['snapshot id', {
      message_id: '111111111111111164', channel_id: '222222222222222270',
    }, {
      id: '111111111111111999', channel_id: '222222222222222270',
      author: { id: '333333333333333364' }, content: 'wrong snapshot id',
    }],
  ]) {
    const invalid = normalizeDiscordMessage({
      id: `11111111111111118${label.length}`,
      channel_id: '222222222222222270',
      author: { id: '333333333333333370', bot: false },
      content: 'do not trust mismatched quote',
      message_reference: reference,
      referenced_message: referencedMessage,
    }, botId, { loadReply: async () => { loads += 1; } });
    assert.deepEqual(invalid.replyTo, {
      messageId: reference.message_id,
      unavailableReason: 'not-found',
    }, label);
  }
  assert.equal(loads, 1, 'invalid Gateway snapshots never trigger a fallback fetch');
});

test('Discord preserves existing channel and thread addressing before native routing', () => {
  const botId = '1234567890123456789';
  const parentChannelId = '222222222222222223';
  const fixtures = [
    { label: 'guild text', channelId: parentChannelId, channelType: 0 },
    { label: 'announcement', channelId: '222222222222222224', channelType: 5 },
    { label: 'announcement thread', channelId: '222222222222222225', channelType: 10 },
    { label: 'public thread', channelId: '222222222222222226', channelType: 11 },
    { label: 'private thread', channelId: '222222222222222227', channelType: 12 },
  ];

  for (const [index, fixture] of fixtures.entries()) {
    const message = normalizeDiscordMessage({
      id: `11111111111111112${index}`,
      channel_id: fixture.channelId,
      guild_id: '444444444444444444',
      channel_type: fixture.channelType,
      author: { id: `33333333333333333${index}`, bot: false },
      mentions: [{ id: botId }],
      content: `<@${botId}> ${fixture.label}`,
    }, botId);
    assert.equal(message.kind, 'group');
    assert.equal(message.addressed, true);
    assert.equal(message.conversationId, fixture.channelId);
    assert.deepEqual(message.replyTarget, {
      channelId: fixture.channelId,
      replyToMessageId: `11111111111111112${index}`,
    });
  }

  const firstUser = normalizeDiscordMessage({
    id: '111111111111111130',
    channel_id: parentChannelId,
    guild_id: '444444444444444444',
    author: { id: '333333333333333330', bot: false },
    mentions: [{ id: botId }],
    content: `<@${botId}> first`,
  }, botId);
  const secondUser = normalizeDiscordMessage({
    id: '111111111111111131',
    channel_id: parentChannelId,
    guild_id: '444444444444444444',
    author: { id: '333333333333333331', bot: false },
    mentions: [{ id: botId }],
    content: `<@${botId}> second`,
  }, botId);
  assert.equal(firstUser.conversationId, secondUser.conversationId);

  const unmentionedThread = normalizeDiscordMessage({
    id: '111111111111111132',
    channel_id: '222222222222222226',
    guild_id: '444444444444444444',
    author: { id: '333333333333333330', bot: false },
    mentions: [],
    content: 'continue',
  }, botId);
  assert.equal(unmentionedThread.addressed, false);
});

test('Discord routes mentioned text and announcement messages into native threads', async () => {
  const botId = '1234567890123456789';
  for (const fixture of [
    { parentType: 0, threadType: 11, content: 'build the report' },
    { parentType: 5, threadType: 10, content: 'publish the report' },
  ]) {
    const starts = [];
    const cached = [];
    const message = {
      id: fixture.parentType === 0 ? '111111111111111140' : '111111111111111141',
      channel_id: fixture.parentType === 0
        ? '222222222222222240' : '222222222222222241',
      guild_id: '444444444444444444',
      author: { id: '333333333333333333', bot: false },
      mentions: [{ id: botId }],
      content: `<@${botId}> ${fixture.content}`,
    };
    const route = await resolveDiscordMessageRoute(message, botId, {
      api: {
        async getChannel({ channelId }) {
          assert.equal(channelId, message.channel_id);
          return { id: channelId, type: fixture.parentType };
        },
        async startThreadFromMessage(options) {
          starts.push(options);
          return {
            id: message.id,
            type: fixture.threadType,
            parent_id: message.channel_id,
            owner_id: botId,
          };
        },
      },
      onChannel: (channel) => cached.push(channel.id),
    });

    assert.equal(starts.length, 1);
    assert.deepEqual({
      channelId: starts[0].channelId,
      messageId: starts[0].messageId,
      name: starts[0].name,
    }, {
      channelId: message.channel_id,
      messageId: message.id,
      name: fixture.content,
    });
    assert.equal(route.conversationId, message.id);
    assert.deepEqual(route.replyTarget, { channelId: message.id });
    assert.deepEqual(route.reactionTarget, {
      channelId: message.channel_id,
      messageId: message.id,
    });
    assert.deepEqual(route.conversationRoute, {
      peerId: message.channel_id,
      threadId: message.id,
      managed: true,
    });
    assert.equal(route.addressed, true);
    assert.equal(route.requiresMention, false);
    assert.deepEqual(cached, [message.channel_id, message.id]);
  }
});

test('Discord keeps direct-message routing stable without a channel lookup', async () => {
  const route = await resolveDiscordMessageRoute({
    id: '111111111111111142',
    channel_id: '222222222222222242',
    author: { id: '333333333333333333', bot: false },
    content: 'private task',
  }, '1234567890123456789', {
    api: {
      async getChannel() { assert.fail('DM routing must not query a Guild channel'); },
    },
  });
  assert.equal(route.conversationId, '222222222222222242');
  assert.deepEqual(route.conversationRoute, { peerId: '222222222222222242' });
  assert.deepEqual(route.replyTarget, {
    channelId: '222222222222222242',
    replyToMessageId: '111111111111111142',
  });
});

test('Discord reuses all native thread types and only relaxes mentions for bot-owned threads', async () => {
  const botId = '1234567890123456789';
  for (const type of [10, 11, 12]) {
    for (const managed of [false, true]) {
      const channelId = `2222222222222222${type}${managed ? 1 : 0}`;
      const message = {
        id: `1111111111111112${type}${managed ? 1 : 0}`,
        channel_id: channelId,
        guild_id: '444444444444444444',
        author: { id: '333333333333333333', bot: false },
        mentions: [],
        content: 'continue',
      };
      const route = await resolveDiscordMessageRoute(message, botId, {
        channel: {
          id: channelId,
          type,
          parent_id: '222222222222222299',
          owner_id: managed ? botId : '999999999999999999',
        },
        api: {
          async getChannel() { assert.fail('cached thread must be reused'); },
          async startThreadFromMessage() { assert.fail('must not create a nested thread'); },
        },
      });
      assert.equal(route.conversationId, channelId);
      assert.equal(route.addressed, managed);
      assert.equal(route.requiresMention, !managed);
      assert.deepEqual(route.replyTarget, {
        channelId,
        replyToMessageId: message.id,
      });
    }
  }
});

test('Discord recovers an already-created thread after an uncertain or duplicate create result', async () => {
  const botId = '1234567890123456789';
  const message = {
    id: '111111111111111150',
    channel_id: '222222222222222250',
    guild_id: '444444444444444444',
    author: { id: '333333333333333333', bot: false },
    mentions: [{ id: botId }],
    content: `<@${botId}> recover`,
  };
  let starts = 0;
  const route = await resolveDiscordMessageRoute(message, botId, {
    channel: { id: message.channel_id, type: 0 },
    api: {
      async getChannel({ channelId }) {
        assert.equal(channelId, message.id);
        return {
          id: message.id,
          type: 11,
          parent_id: message.channel_id,
          owner_id: botId,
        };
      },
      async startThreadFromMessage() {
        starts += 1;
        const error = new Error('request outcome unknown');
        error.status = 500;
        throw error;
      },
    },
  });
  assert.equal(starts, 1);
  assert.equal(route.conversationRoute.threadId, message.id);
  assert.equal(route.conversationRoute.managed, true);
  assert.deepEqual(route.replyTarget, { channelId: message.id });

  const foreignMessage = {
    ...message,
    id: '111111111111111151',
    content: `<@${botId}> recover foreign thread`,
  };
  const foreign = await resolveDiscordMessageRoute(foreignMessage, botId, {
    channel: { id: foreignMessage.channel_id, type: 0 },
    api: {
      async getChannel({ channelId }) {
        assert.equal(channelId, foreignMessage.id);
        return {
          id: foreignMessage.id,
          type: 11,
          parent_id: foreignMessage.channel_id,
          owner_id: '999999999999999999',
        };
      },
      async startThreadFromMessage() {
        const error = new Error('Thread already exists');
        error.status = 400;
        throw error;
      },
    },
  });
  assert.equal(foreign.addressed, true, 'the explicit source mention still starts this turn');
  assert.equal(foreign.requiresMention, true);
  assert.equal(foreign.conversationRoute.managed, false);
  assert.deepEqual(foreign.replyTarget, { channelId: foreignMessage.id });
});

test('Discord converges a post-dispatch abort but sends no create request after a pre-dispatch abort', async () => {
  const botId = '1234567890123456789';
  const base = {
    channel_id: '222222222222222252',
    guild_id: '444444444444444444',
    author: { id: '333333333333333333', bot: false },
    mentions: [{ id: botId }],
    content: `<@${botId}> abort boundary`,
  };
  const before = new AbortController();
  const beforeReason = new DOMException('cancelled before dispatch', 'AbortError');
  before.abort(beforeReason);
  let preDispatchCalls = 0;
  await assert.rejects(() => resolveDiscordMessageRoute({
    ...base,
    id: '111111111111111152',
  }, botId, {
    channel: { id: base.channel_id, type: 0 },
    signal: before.signal,
    api: {
      async getChannel() { preDispatchCalls += 1; },
      async startThreadFromMessage() { preDispatchCalls += 1; },
    },
  }), (error) => error === beforeReason);
  assert.equal(preDispatchCalls, 0);

  const after = new AbortController();
  const afterReason = new DOMException('cancelled after dispatch', 'AbortError');
  const message = { ...base, id: '111111111111111153' };
  let starts = 0;
  let lookups = 0;
  const recovered = await resolveDiscordMessageRoute(message, botId, {
    channel: { id: message.channel_id, type: 0 },
    signal: after.signal,
    api: {
      async startThreadFromMessage() {
        starts += 1;
        after.abort(afterReason);
        throw afterReason;
      },
      async getChannel({ channelId, signal }) {
        lookups += 1;
        assert.equal(channelId, message.id);
        assert.notEqual(signal, after.signal);
        assert.equal(signal.aborted, false);
        return {
          id: message.id,
          type: 11,
          parent_id: message.channel_id,
          owner_id: botId,
        };
      },
    },
  });
  assert.equal(starts, 1);
  assert.equal(lookups, 1);
  assert.equal(recovered.conversationId, message.id);
  assert.equal(recovered.conversationRoute.managed, true);
});

test('Discord falls back before routing when the parent is unsupported or thread creation is rejected', async () => {
  const botId = '1234567890123456789';
  const base = {
    guild_id: '444444444444444444',
    author: { id: '333333333333333333', bot: false },
    mentions: [{ id: botId }],
    content: `<@${botId}> fallback`,
  };

  const unsupported = await resolveDiscordMessageRoute({
    ...base,
    id: '111111111111111160',
    channel_id: '222222222222222260',
  }, botId, {
    channel: { id: '222222222222222260', type: 15 },
    api: {
      async getChannel() { assert.fail('cached forum channel must be reused'); },
      async startThreadFromMessage() { assert.fail('Forum must not use Start Thread from Message'); },
    },
  });
  assert.equal(unsupported.conversationId, '222222222222222260');
  assert.equal(unsupported.conversationRoute.fallback, 'unsupported-channel');
  assert.equal(
    unsupported.replyTarget.notice,
    '当前频道不支持自动创建 Thread，已直接在当前频道回复。',
  );

  const rejected = await resolveDiscordMessageRoute({
    ...base,
    id: '111111111111111161',
    channel_id: '222222222222222261',
  }, botId, {
    channel: { id: '222222222222222261', type: 0 },
    api: {
      async getChannel({ channelId }) {
        assert.equal(channelId, '111111111111111161');
        const error = new Error('Unknown Channel');
        error.status = 404;
        throw error;
      },
      async startThreadFromMessage() {
        const error = new Error('Missing Permissions');
        error.status = 403;
        throw error;
      },
    },
  });
  assert.equal(rejected.conversationId, '222222222222222261');
  assert.equal(rejected.conversationRoute.fallback, 'thread-create-failed');
  assert.equal(rejected.replyTarget.notice, '无法创建 Thread，已直接在当前频道回复。');
});

test('Discord never runs a parent-channel fallback when thread creation remains uncertain', async () => {
  const botId = '1234567890123456789';
  const notices = [];
  const message = {
    id: '111111111111111162',
    channel_id: '222222222222222262',
    guild_id: '444444444444444444',
    author: { id: '333333333333333333', bot: false },
    mentions: [{ id: botId }],
    content: `<@${botId}> uncertain`,
  };
  await assert.rejects(() => resolveDiscordMessageRoute(message, botId, {
    channel: { id: message.channel_id, type: 0 },
    api: {
      async startThreadFromMessage() { throw new TypeError('socket reset after dispatch'); },
      async getChannel({ channelId }) {
        assert.equal(channelId, message.id);
        const error = new Error('Unknown Channel');
        error.status = 404;
        throw error;
      },
      async createMessage(options) {
        notices.push(options);
        return { id: '777777777777777773' };
      },
    },
  }), (error) => error.code === 'discord-thread-create-uncertain');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].channelId, message.channel_id);
  assert.equal(notices[0].replyToMessageId, message.id);
  assert.match(notices[0].content, /结果暂时无法确认/);
});

test('Discord merges a deterministic Thread fallback notice into one delivered answer', async () => {
  const creates = [];
  const edits = [];
  const client = new DiscordBotClient({
    api: {
      async createMessage(options) {
        creates.push(options);
        return { id: `88888888888888888${creates.length}` };
      },
      async editMessage(options) {
        edits.push(options);
        return { id: options.messageId };
      },
    },
  });
  const target = {
    channelId: '222222222222222263',
    replyToMessageId: '111111111111111163',
    notice: '无法创建 Thread，已直接在当前频道回复。',
  };
  await client.sendText(target, 'final answer');
  assert.equal(creates.length, 1);
  assert.equal(creates[0].content, `${target.notice}\n\nfinal answer`);
  await client.sendText(target, 'follow-up notice');
  assert.equal(creates[1].content, 'follow-up notice');

  const streamTarget = {
    channelId: '222222222222222264',
    notice: '当前频道不支持自动创建 Thread，已直接在当前频道回复。',
  };
  const stream = await client.openStream(streamTarget);
  await stream.finish('streamed answer');
  assert.equal(creates[2].content, `${streamTarget.notice}\n\n正在处理…`);
  assert.equal(edits[0].content, `${streamTarget.notice}\n\nstreamed answer`);
});

test('Discord bot client exposes cancellable add and remove reaction operations', async () => {
  const operations = [];
  const api = {
    async addOwnReaction(options) {
      operations.push({ operation: 'add', ...options });
      return options.emoji;
    },
    async removeOwnReaction(options) {
      operations.push({ operation: 'remove', ...options });
    },
  };
  const client = new DiscordBotClient({ api });
  const target = {
    channelId: '222222222222222266',
    messageId: '111111111111111166',
  };
  const controller = new AbortController();

  const reactionKey = await client.addReaction(target, '👀', { signal: controller.signal });
  await client.removeReaction(target, reactionKey, { signal: controller.signal });

  assert.equal(reactionKey, '👀');
  assert.deepEqual(operations.map(({ operation, channelId, messageId, emoji, signal }) => ({
    operation, channelId, messageId, emoji, signal,
  })), [{
    operation: 'add', ...target, emoji: '👀', signal: controller.signal,
  }, {
    operation: 'remove', ...target, emoji: '👀', signal: controller.signal,
  }]);
});

test('Discord keeps streamed text and result files on the final created Thread target', async () => {
  const botId = '1234567890123456789';
  const message = {
    id: '111111111111111165',
    channel_id: '222222222222222265',
    guild_id: '444444444444444444',
    author: { id: '333333333333333333', bot: false },
    mentions: [{ id: botId }],
    content: `<@${botId}> deliver in thread`,
  };
  const operations = [];
  const api = {
    async getChannel() {
      assert.fail('the cached parent channel must be reused');
    },
    async startThreadFromMessage() {
      return {
        id: message.id,
        type: 11,
        parent_id: message.channel_id,
        owner_id: botId,
      };
    },
    async createMessage(options) {
      operations.push({ operation: 'create', ...options });
      return { id: '888888888888888881' };
    },
    async editMessage(options) {
      operations.push({ operation: 'edit', ...options });
      return { id: options.messageId };
    },
    async createFileMessage(options) {
      operations.push({ operation: 'file', ...options });
      return { id: '888888888888888882' };
    },
    async sendTyping(options) {
      operations.push({ operation: 'typing', ...options });
    },
  };
  const route = await resolveDiscordMessageRoute(message, botId, {
    channel: { id: message.channel_id, type: 0 },
    api,
  });
  const client = new DiscordBotClient({ api });
  await client.sendTyping(route.replyTarget);
  const stream = await client.openStream(route.replyTarget);
  await stream.finish('thread final answer');
  await client.sendFile(route.replyTarget, {
    fileName: 'result.txt',
    bytes: Buffer.from('thread result'),
  });

  assert.deepEqual(operations.map(({ operation }) => operation), [
    'typing', 'create', 'edit', 'file',
  ]);
  assert.equal(operations.every(({ channelId }) => channelId === message.id), true);
  assert.equal(operations.some(({ channelId }) => channelId === message.channel_id), false);
  assert.equal(operations.find(({ operation }) => operation === 'create').replyToMessageId, undefined);
  assert.equal(operations.find(({ operation }) => operation === 'file').replyToMessageId, undefined);
});

test('Discord keeps image attachments in images and exposes ordinary attachments as files', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const calls = [];
  const message = normalizeDiscordMessage({
    id: '111111111111111120',
    channel_id: '222222222222222220',
    author: { id: '333333333333333330', bot: false },
    content: '',
    attachments: [{
      id: '555555555555555550',
      filename: 'screen.png',
      content_type: 'image/png',
      size: png.length,
      url: 'https://cdn.discordapp.com/attachments/222/555/screen.png?ex=test',
    }, {
      id: '555555555555555551',
      filename: 'notes.txt',
      content_type: 'text/plain',
      size: 4,
      url: 'https://cdn.discordapp.com/attachments/222/555/notes.txt',
    }, {
      id: '555555555555555552',
      filename: 'camera.jpg',
      size: png.length,
      url: 'https://cdn.discordapp.com/attachments/222/555/camera.jpg',
    }],
  }, '1234567890123456789', {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(png, { status: 200, headers: { 'content-length': String(png.length) } });
    },
  });

  assert.equal(message.content, '');
  assert.equal(message.plainText, false);
  assert.equal(message.images.length, 2);
  assert.deepEqual({
    name: message.images[0].name,
    mediaType: message.images[0].mediaType,
    size: message.images[0].size,
  }, { name: 'screen.png', mediaType: 'image/png', size: png.length });
  assert.equal(message.images[1].mediaType, 'image/jpeg');
  assert.deepEqual(await message.images[0].load({ maxBytes: 100 }), png);
  assert.equal(calls[0].url.hostname, 'cdn.discordapp.com');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(message.files.length, 1);
  assert.deepEqual({
    name: message.files[0].name,
    mediaType: message.files[0].mediaType,
    size: message.files[0].size,
  }, { name: 'notes.txt', mediaType: 'text/plain', size: 4 });
  const controller = new AbortController();
  const loadedFile = await message.files[0].load({ signal: controller.signal });
  const fileChunks = [];
  for await (const chunk of loadedFile.stream) fileChunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(fileChunks), png);
  assert.equal(calls[1].url.pathname.endsWith('/notes.txt'), true);
  assert.equal(calls[1].options.signal, controller.signal);

  const unsafe = normalizeDiscordMessage({
    id: '111111111111111121',
    channel_id: '222222222222222220',
    author: { id: '333333333333333330', bot: false },
    attachments: [{
      filename: 'screen.png', content_type: 'image/png', size: 8,
      url: 'https://example.com/internal.png',
    }],
  }, '1234567890123456789', { fetchImpl: async () => assert.fail('must not fetch') });
  await assert.rejects(() => unsafe.images[0].load({ maxBytes: 100 }), /messaging platform/);
});

class FakeSocket {
  #listeners = new Map();
  sent = [];
  readyState = 1;

  addEventListener(name, listener) {
    const listeners = this.#listeners.get(name) ?? [];
    listeners.push(listener);
    this.#listeners.set(name, listeners);
  }

  send(value) {
    const packet = JSON.parse(value);
    this.sent.push(packet);
    if (packet.op === 2) {
      queueMicrotask(() => this.emit('message', {
        data: JSON.stringify({
          op: 0,
          t: 'READY',
          s: 1,
          d: {
            session_id: 'session',
            resume_gateway_url: 'wss://gateway.discord.gg',
          },
        }),
      }));
    }
  }

  close(code = 1000) {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.emit('close', { code });
  }

  emit(name, event) {
    for (const listener of this.#listeners.get(name) ?? []) listener(event);
  }
}

test('Discord runtime keeps one isolated Session per managed thread and reuses it without mentions', async () => {
  const botId = '1234567890123456789';
  const parentChannelId = '222222222222222270';
  const unrelatedThreadId = '222222222222222271';
  const sessions = new Map();
  const seen = new Set();
  const starts = [];
  const asks = [];
  const deliveries = [];
  let nextSession = 1;
  let nextProviderMessage = 1;
  let socket;

  const api = {
    getCurrentUser: async () => ({ id: botId, bot: true }),
    getGatewayBot: async () => ({ url: 'wss://gateway.discord.gg' }),
    async getChannel({ channelId }) {
      assert.fail(`cached channel expected, got API lookup for ${channelId}`);
    },
    async startThreadFromMessage({ channelId, messageId, name }) {
      starts.push({ channelId, messageId, name });
      await new Promise((resolve) => setImmediate(resolve));
      return {
        id: messageId,
        type: 11,
        parent_id: channelId,
        owner_id: botId,
      };
    },
    async sendTyping({ channelId }) {
      deliveries.push({ operation: 'typing', channelId });
    },
    async createMessage({ channelId, content, replyToMessageId }) {
      const id = `8888888888888888${String(nextProviderMessage).padStart(2, '0')}`;
      nextProviderMessage += 1;
      deliveries.push({ operation: 'create', channelId, content, replyToMessageId, id });
      return { id };
    },
    async editMessage({ channelId, messageId, content }) {
      deliveries.push({ operation: 'edit', channelId, messageId, content });
      return { id: messageId };
    },
  };
  const harness = {
    ensureRunning: async () => true,
    async createSession() {
      const sessionId = `session-${nextSession}`;
      nextSession += 1;
      return sessionId;
    },
    sessionExists: async () => true,
    async ask(sessionId, text, options) {
      asks.push({ sessionId, text, files: options?.files?.length ?? 0 });
      return `answer:${text}`;
    },
  };
  const state = {
    sessionFor: (key) => sessions.get(key) ?? null,
    async setSession(key, sessionId) { sessions.set(key, sessionId); },
    async clearSession(key) { sessions.delete(key); },
    hasSeen: (messageId) => seen.has(messageId),
    async markSeen(messageId) { seen.add(messageId); },
  };
  const createRuntime = () => new DiscordRuntime({
    config: { botId: 'discord_test', platformId: botId, name: 'Harness Discord' },
    token: TOKEN,
    harness,
    state,
    createApi: () => api,
    createWebSocket: () => {
      socket = new FakeSocket();
      queueMicrotask(() => socket.emit('message', {
        data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }),
      }));
      return socket;
    },
    random: () => 0.5,
    logger: { warn() {}, error(...args) { assert.fail(args.join(' ')); } },
  });
  let runtime = createRuntime();
  await runtime.start();
  socket.emit('message', {
    data: JSON.stringify({
      op: 0,
      t: 'GUILD_CREATE',
      s: 2,
      d: {
        id: '444444444444444444',
        channels: [{ id: parentChannelId, type: 0 }],
        threads: [{
          id: unrelatedThreadId,
          type: 11,
          parent_id: parentChannelId,
          owner_id: '999999999999999999',
        }],
      },
    }),
  });

  const firstMessage = {
    id: '111111111111111170',
    channel_id: parentChannelId,
    guild_id: '444444444444444444',
    author: { id: '333333333333333330', bot: false },
    mentions: [{ id: botId }],
    content: `<@${botId}> first task`,
  };
  const firstPacket = JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: firstMessage });
  socket.emit('message', { data: firstPacket });
  socket.emit('message', { data: firstPacket });
  await eventually(() => runtime.status.messagesReplied === 1);

  assert.equal(starts.length, 1);
  assert.equal(sessions.has(`group:${parentChannelId}`), false);
  assert.equal(sessions.get(`group:${firstMessage.id}`), 'session-1');
  assert.deepEqual(asks, [{ sessionId: 'session-1', text: 'first task', files: 0 }]);
  assert.equal(deliveries.every((entry) => entry.channelId === firstMessage.id), true);
  assert.equal(deliveries.find((entry) => entry.operation === 'create').replyToMessageId, undefined);

  socket.emit('message', {
    data: JSON.stringify({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 4,
      d: {
        id: '111111111111111171',
        channel_id: firstMessage.id,
        guild_id: '444444444444444444',
        author: { id: '333333333333333330', bot: false },
        mentions: [],
        content: 'continue task',
        attachments: [{
          id: '555555555555555571',
          filename: 'notes.txt',
          content_type: 'text/plain',
          size: 4,
          url: 'https://cdn.discordapp.com/attachments/222/555/notes.txt',
        }],
      },
    }),
  });
  await eventually(() => runtime.status.messagesReplied === 2);
  assert.deepEqual(asks[1], { sessionId: 'session-1', text: 'continue task', files: 1 });

  const statusMessageId = '111111111111111179';
  socket.emit('message', {
    data: JSON.stringify({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 5,
      d: {
        id: statusMessageId,
        channel_id: firstMessage.id,
        guild_id: '444444444444444444',
        author: { id: '333333333333333330', bot: false },
        mentions: [],
        content: '/status',
      },
    }),
  });
  await eventually(() => seen.has(statusMessageId));
  assert.equal(asks.length, 2);
  assert.equal(deliveries.some((entry) => entry.operation === 'create'
    && entry.channelId === firstMessage.id
    && entry.replyToMessageId === statusMessageId
    && /连接正常/.test(entry.content)), true);

  socket.emit('message', {
    data: JSON.stringify({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 6,
      d: {
        id: '111111111111111172',
        channel_id: unrelatedThreadId,
        guild_id: '444444444444444444',
        author: { id: '333333333333333331', bot: false },
        mentions: [],
        content: 'must be ignored',
      },
    }),
  });
  await eventually(() => seen.has('111111111111111172'));
  assert.equal(runtime.status.messagesRejected, 1);
  assert.equal(asks.length, 2);

  socket.emit('message', {
    data: JSON.stringify({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 7,
      d: {
        id: '111111111111111173',
        channel_id: unrelatedThreadId,
        guild_id: '444444444444444444',
        author: { id: '333333333333333331', bot: false },
        mentions: [{ id: botId }],
        content: `<@${botId}> explicit thread task`,
      },
    }),
  });
  await eventually(() => runtime.status.messagesReplied === 3);
  assert.equal(sessions.get(`group:${unrelatedThreadId}`), 'session-2');
  assert.deepEqual(asks[2], { sessionId: 'session-2', text: 'explicit thread task', files: 0 });

  for (const [index, senderId] of ['333333333333333332', '333333333333333333'].entries()) {
    socket.emit('message', {
      data: JSON.stringify({
        op: 0,
        t: 'MESSAGE_CREATE',
        s: 8 + index,
        d: {
          id: `11111111111111118${index}`,
          channel_id: parentChannelId,
          guild_id: '444444444444444444',
          author: { id: senderId, bot: false },
          mentions: [{ id: botId }],
          content: `<@${botId}> user ${index}`,
        },
      }),
    });
  }
  await eventually(() => runtime.status.messagesReplied === 5);
  assert.equal(starts.length, 3);
  assert.notEqual(
    sessions.get('group:111111111111111180'),
    sessions.get('group:111111111111111181'),
  );
  assert.equal(sessions.has(`group:${parentChannelId}`), false);
  await runtime.stop();

  runtime = createRuntime();
  await runtime.start();
  socket.emit('message', {
    data: JSON.stringify({
      op: 0,
      t: 'GUILD_CREATE',
      s: 20,
      d: {
        id: '444444444444444444',
        channels: [{ id: parentChannelId, type: 0 }],
        threads: [{
          id: firstMessage.id,
          type: 11,
          parent_id: parentChannelId,
          owner_id: botId,
        }],
      },
    }),
  });
  socket.emit('message', {
    data: JSON.stringify({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 21,
      d: {
        id: '111111111111111174',
        channel_id: firstMessage.id,
        guild_id: '444444444444444444',
        author: { id: '333333333333333330', bot: false },
        mentions: [],
        content: 'continue after restart',
      },
    }),
  });
  await eventually(() => runtime.status.messagesReplied === 1);
  assert.deepEqual(asks[5], {
    sessionId: 'session-1',
    text: 'continue after restart',
    files: 0,
  });
  assert.equal(starts.length, 3, 'restart must reuse the persisted bot-owned Thread');
  assert.equal(sessions.get(`group:${firstMessage.id}`), 'session-1');
  await runtime.stop();
});

test('Discord captures context settings before asynchronous Thread routing and updates future messages live', async (t) => {
  const botId = '1234567890123456789';
  const parentId = '222222222222222290';
  const threadId = '111111111111111190';
  const routingStarted = deferred();
  const releaseRouting = deferred();
  const seen = new Set();
  const deliveries = [];
  const prompts = [];
  let socket;
  let reads = 0;
  let accessReads = 0;
  let threadStarts = 0;
  let config = {
    group: {
      enabled: true,
      fields: ['channel', 'conversationType', 'senderId', 'senderName', 'botId'],
      guidance: 'accepted before routing',
    },
    direct: { enabled: false, fields: [], guidance: 'direct must not leak' },
  };
  const allowedAccessSettings = {
    direct: {
      mode: 'open',
      open: { defaultCanExecuteCommands: true, commandPermissionOverrides: [] },
      allowlist: { users: [] },
    },
    group: {
      mode: 'allowlist',
      open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
      allowlist: {
        users: [
          { id: '333333333333333333', canExecuteCommands: true },
          { id: '333333333333333334', canExecuteCommands: false },
        ],
      },
    },
  };
  let accessSettings = allowedAccessSettings;
  const runtime = new DiscordRuntime({
    config: { botId: 'discord_internal', platformId: botId, name: 'Harness Discord' },
    token: TOKEN,
    contextEnhancement: {
      botId: 'discord_internal',
      getSettings: () => { reads += 1; return config; },
    },
    accessPolicy: {
      getSettings: () => {
        accessReads += 1;
        return accessSettings;
      },
    },
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      ask: async (_sessionId, content) => { prompts.push(content); return 'answer'; },
    },
    state: {
      hasSeen: (id) => seen.has(id),
      markSeen: async (id) => seen.add(id),
      sessionFor: () => 'session-existing',
    },
    createApi: () => ({
      getCurrentUser: async () => ({ id: botId, bot: true }),
      getGatewayBot: async () => ({ url: 'wss://gateway.discord.gg' }),
      getChannel: async () => assert.fail('The channel is already in the gateway cache'),
      startThreadFromMessage: async () => {
        threadStarts += 1;
        routingStarted.resolve();
        await releaseRouting.promise;
        return { id: threadId, type: 11, parent_id: parentId, owner_id: botId };
      },
      sendTyping: async () => {},
      createMessage: async (request) => {
        deliveries.push(request);
        return { id: '888888888888888890' };
      },
      editMessage: async ({ messageId }) => ({ id: messageId }),
    }),
    createWebSocket: () => {
      socket = new FakeSocket();
      queueMicrotask(() => socket.emit('message', {
        data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }),
      }));
      return socket;
    },
    random: () => 0.5,
    logger: { warn() {}, error(...args) { assert.fail(args.join(' ')); } },
  });
  t.after(async () => { releaseRouting.resolve(); await runtime.stop(); });
  await runtime.start();
  socket.emit('message', { data: JSON.stringify({ op: 0, t: 'GUILD_CREATE', s: 2,
    d: { id: '444444444444444444', channels: [{ id: parentId, type: 0 }], threads: [] },
  }) });
  socket.emit('message', { data: JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: {
    id: '111111111111111189', channel_id: parentId, guild_id: '444444444444444444',
    author: { id: '333333333333333332', bot: false },
    mentions: [{ id: botId }], content: `<@${botId}> denied before Thread`,
  } }) });
  await eventually(() => runtime.status.messagesRejected === 1);
  assert.equal(threadStarts, 0, 'a denied member must not create a Discord Thread');
  socket.emit('message', { data: JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 4, d: {
    id: '111111111111111188', channel_id: parentId, guild_id: '444444444444444444',
    author: { id: '333333333333333334', bot: false },
    mentions: [{ id: botId }], content: `<@${botId}> /new`,
  } }) });
  await eventually(() => runtime.status.messagesRejected === 2);
  assert.equal(threadStarts, 0, 'a command-denied member must not create a Discord Thread');
  assert.equal(deliveries.at(-1)?.channelId, parentId);
  assert.equal(deliveries.at(-1)?.content, COMMAND_PERMISSION_DENIED_MESSAGE);
  socket.emit('message', { data: JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: {
    id: threadId, channel_id: parentId, guild_id: '444444444444444444',
    author: { id: '333333333333333333', bot: false, global_name: 'Global Name', username: 'username' },
    member: { nick: 'Group Nick' }, mentions: [{ id: botId }], content: `<@${botId}> first`,
  } }) });
  await routingStarted.promise;
  assert.equal(threadStarts, 1);
  config = { ...config, group: { ...config.group, enabled: false } };
  accessSettings = {
    ...allowedAccessSettings,
    group: {
      ...allowedAccessSettings.group,
      allowlist: { users: [] },
    },
  };
  releaseRouting.resolve();
  await eventually(() => runtime.status.messagesReplied === 1);
  assert.match(prompts[0], /accepted before routing/);
  assert.deepEqual(JSON.parse(/^<dsh_im_source>(.*?)<\/dsh_im_source>/su.exec(prompts[0])[1]), {
    channel: 'discord', conversationType: 'group', senderId: '333333333333333333',
    senderName: 'Group Nick', botId: 'discord_internal',
  });
  assert.equal(reads, 1, 'routing and Bridge share one accepted configuration read');
  assert.equal(accessReads, 3,
    'each source event reads access once and the Thread keeps its arrival decision');

  accessSettings = allowedAccessSettings;
  socket.emit('message', { data: JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 4, d: {
    id: '111111111111111191', channel_id: threadId, guild_id: '444444444444444444',
    author: { id: '333333333333333333', bot: false }, content: 'second without enhancement',
  } }) });
  await eventually(() => runtime.status.messagesReplied === 2);
  assert.equal(prompts[1], 'second without enhancement');
  assert.equal(reads, 2);
  assert.equal(accessReads, 4, 'the next managed-Thread event reads the latest policy once');
});

test('Discord runtime records one uncertain Thread result and suppresses Gateway replays', async () => {
  const botId = '1234567890123456789';
  const parentChannelId = '222222222222222290';
  const messageId = '111111111111111190';
  const seen = new Set();
  const notices = [];
  const errors = [];
  let starts = 0;
  let socket;
  const runtime = new DiscordRuntime({
    config: { botId: 'discord_test', platformId: botId, name: 'Harness Discord' },
    token: TOKEN,
    harness: {
      ensureRunning: async () => true,
      createSession: async () => assert.fail('uncertain routing must not create a Session'),
      ask: async () => assert.fail('uncertain routing must not run a Prompt'),
    },
    state: {
      hasSeen: (id) => seen.has(id),
      async markSeen(id) { seen.add(id); },
    },
    createApi: () => ({
      getCurrentUser: async () => ({ id: botId, bot: true }),
      getGatewayBot: async () => ({ url: 'wss://gateway.discord.gg' }),
      async startThreadFromMessage() {
        starts += 1;
        throw new TypeError('connection closed after dispatch');
      },
      async getChannel({ channelId }) {
        assert.equal(channelId, messageId);
        const error = new Error('Unknown Channel');
        error.status = 404;
        throw error;
      },
      async createMessage(options) {
        notices.push(options);
        return { id: '777777777777777790' };
      },
    }),
    createWebSocket: () => {
      socket = new FakeSocket();
      queueMicrotask(() => socket.emit('message', {
        data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }),
      }));
      return socket;
    },
    random: () => 0.5,
    logger: { warn() {}, error(...args) { errors.push(args); } },
  });
  await runtime.start();
  socket.emit('message', {
    data: JSON.stringify({
      op: 0,
      t: 'GUILD_CREATE',
      s: 2,
      d: {
        id: '444444444444444444',
        channels: [{ id: parentChannelId, type: 0 }],
        threads: [],
      },
    }),
  });
  const packet = {
    op: 0,
    t: 'MESSAGE_CREATE',
    s: 3,
    d: {
      id: messageId,
      channel_id: parentChannelId,
      guild_id: '444444444444444444',
      author: { id: '333333333333333333', bot: false },
      mentions: [{ id: botId }],
      content: `<@${botId}> uncertain task`,
    },
  };
  socket.emit('message', { data: JSON.stringify(packet) });
  socket.emit('message', { data: JSON.stringify(packet) });
  await eventually(() => seen.has(messageId));
  assert.equal(starts, 1);
  assert.equal(notices.length, 1);
  assert.match(notices[0].content, /结果暂时无法确认/);
  assert.equal(runtime.status.messagesReceived, 0);
  assert.equal(runtime.status.messagesReplied, 0);

  socket.emit('message', { data: JSON.stringify({ ...packet, s: 4 }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  assert.equal(notices.length, 1);
  assert.ok(errors.length >= 1);
  await runtime.stop();
});

test('Discord runtime identifies on Gateway v10 and becomes ready', async () => {
  let socket;
  const abortMark = deferred();
  let abortMarkStarted = false;
  const errors = [];
  const proactiveCalls = [];
  const runtime = new DiscordRuntime({
    config: {
      botId: 'discord_test',
      platformId: '1234567890123456789',
      name: 'Harness Discord',
    },
    token: TOKEN,
    harness: { ensureRunning: async () => true },
    state: {
      sessionFor: () => null,
      setSession: async () => {},
      clearSession: async () => {},
      hasSeen: () => false,
      markSeen: async (messageId) => {
        if (messageId === '111111111111111199') {
          abortMarkStarted = true;
          return abortMark.promise;
        }
        throw new Error(`Discord state write failed for ${messageId}`);
      },
    },
    createApi: () => ({
      getCurrentUser: async () => ({ id: '1234567890123456789', bot: true }),
      getGatewayBot: async () => ({ url: 'wss://gateway.discord.gg' }),
      createMessage: async (request) => {
        proactiveCalls.push(request);
        return { id: '111111111111111900' };
      },
    }),
    createWebSocket: () => {
      socket = new FakeSocket();
      queueMicrotask(() => socket.emit('message', {
        data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }),
      }));
      return socket;
    },
    random: () => 0.5,
    logger: {
      warn() {},
      error(...args) { errors.push(args); },
    },
  });
  await runtime.start();
  assert.equal(runtime.status.ready, true);
  assert.deepEqual(await runtime.sendProactiveText({
    kind: 'channel',
    route: { channelId: '222222222222222900' },
  }, 'proactive-test'), { providerMessageIds: ['111111111111111900'] });
  assert.equal(proactiveCalls.length, 1);
  assert.equal(proactiveCalls[0].channelId, '222222222222222900');
  assert.equal(proactiveCalls[0].content, 'proactive-test');
  assert.equal(proactiveCalls[0].replyToMessageId, undefined);
  const identify = socket.sent.find((packet) => packet.op === 2);
  assert.equal(identify.d.token, TOKEN);
  assert.equal(identify.d.intents, 37_377);
  assert.equal(identify.d.properties.browser, 'dsh-im');

  for (const [id, sequence] of [
    ['111111111111111190', 2],
    ['111111111111111191', 3],
  ]) {
    socket.emit('message', {
      data: JSON.stringify({
        op: 0,
        t: 'MESSAGE_CREATE',
        s: sequence,
        d: {
          id,
          channel_id: '222222222222222222',
          author: { id: '333333333333333333', bot: false },
          content: 'trigger state failure',
        },
      }),
    });
  }
  await eventually(() => errors.length === 2);
  assert.equal(errors.every((args) => args[0].includes('message handling failed')), true);

  socket.emit('message', {
    data: JSON.stringify({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 4,
      d: {
        id: '111111111111111199',
        channel_id: '222222222222222222',
        author: { id: '333333333333333333', bot: false },
        content: 'abort state write',
      },
    }),
  });
  await eventually(() => abortMarkStarted);
  const stopping = runtime.stop();
  abortMark.reject(new Error('Discord state write aborted'));
  await stopping;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 2);
  assert.equal(runtime.status.ready, false);
});
