import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  SlackConfigStore,
  deriveSlackBotIdentity,
} from '../../../src/channels/slack/config-store.mjs';
import { SlackController } from '../../../src/channels/slack/slack-controller.mjs';
import {
  SlackApi,
  inspectSlackCredentials,
  validSlackAppToken,
  validSlackBotToken,
} from '../../../src/channels/slack/slack-api.mjs';
import {
  SlackBotClient,
  SlackRuntime,
  isSlackToolProgress,
  normalizeSlackEvent,
} from '../../../src/channels/slack/slack-runtime.mjs';
import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import { SLACK_APP_MANIFEST_YAML } from '../../../src/channels/slack/manifest.mjs';
import {
  SLACK_ENDPOINTS,
  createSlackRpcHandler,
} from '../../../plugin-src/host/channels/slack/rpc.mjs';

const BOT_TOKEN = `xoxb-${'0'.repeat(24)}-not-a-real-token`;
const APP_TOKEN = `xapp-${'0'.repeat(24)}-not-a-real-token`;

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

test('Slack recognizes localized tool progress without hiding ordinary text', () => {
  assert.equal(isSlackToolProgress('正在使用搜索…'), true);
  assert.equal(isSlackToolProgress('正在使用…'), false);
  assert.equal(isSlackToolProgress('普通回复'), false);
  setImHostLanguage('en');
  try {
    assert.equal(isSlackToolProgress('Using search…'), true);
    assert.equal(isSlackToolProgress('Using …'), false);
    assert.equal(isSlackToolProgress('Ordinary reply'), false);
  } finally {
    setImHostLanguage('zh');
  }
});

async function eventually(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition was not met before timeout');
}

test('Slack validates both tokens and inspects Bot and Socket Mode credentials', async () => {
  assert.equal(validSlackBotToken(BOT_TOKEN), true);
  assert.equal(validSlackAppToken(APP_TOKEN), true);
  assert.equal(validSlackBotToken(APP_TOKEN), false);
  assert.equal(validSlackAppToken(BOT_TOKEN), false);
  const calls = [];
  const identity = await inspectSlackCredentials({ botToken: BOT_TOKEN, appToken: APP_TOKEN }, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.pathname.endsWith('/auth.test')) {
        return jsonResponse({
          ok: true,
          team: 'Harness Lab',
          team_id: 'T12345678',
          user: 'deepseek-harness',
          user_id: 'U12345678',
          bot_id: 'B12345678',
        });
      }
      return jsonResponse({ ok: true, url: 'wss://wss-primary.slack.com/link/?ticket=test' });
    },
  });
  assert.deepEqual(identity, {
    platformId: 'T12345678:U12345678',
    name: 'deepseek-harness',
    username: 'deepseek-harness',
    teamId: 'T12345678',
    teamName: 'Harness Lab',
  });
  assert.equal(calls.find((call) => call.url.pathname.endsWith('/auth.test')).options.headers.authorization, `Bearer ${BOT_TOKEN}`);
  assert.equal(calls.find((call) => call.url.pathname.endsWith('/apps.connections.open')).options.headers.authorization, `Bearer ${APP_TOKEN}`);
});

test('Slack API uses native streaming methods and suppresses generated mass mentions', async () => {
  const calls = [];
  const api = new SlackApi({
    botToken: BOT_TOKEN,
    appToken: APP_TOKEN,
    fetchImpl: async (url, options) => {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ method: url.pathname.split('/').pop(), body });
      return jsonResponse({ ok: true, ts: '1700000000.100' });
    },
  });
  await api.startStream({
    channelId: 'C12345678',
    threadTs: '1700000000.001',
    recipientTeamId: 'T12345678',
    recipientUserId: 'U12345678',
  });
  await api.appendStream({
    channelId: 'C12345678',
    ts: '1700000000.100',
    markdownText: 'hello ',
  });
  await api.stopStream({ channelId: 'C12345678', ts: '1700000000.100' });
  await api.postMessage({
    channelId: 'C12345678',
    threadTs: '1700000000.001',
    text: '请通知 <!channel> 和 <@U99999999>',
  });
  assert.deepEqual(calls.slice(0, 3).map((call) => call.method), [
    'chat.startStream', 'chat.appendStream', 'chat.stopStream',
  ]);
  assert.equal(calls[1].body.markdown_text, 'hello ');
  assert.equal(calls[3].body.text, '请通知 @channel 和 @U99999999');
});

test('Slack API reads one exact thread root from the current channel', async () => {
  let request;
  const api = new SlackApi({
    botToken: BOT_TOKEN,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({
        ok: true,
        messages: [{ ts: '1700000000.001', user: 'U87654321', text: 'root' }],
      });
    },
  });
  const message = await api.getMessage({
    channelId: 'C12345678',
    messageTs: '1700000000.001',
  });
  assert.equal(message.text, 'root');
  assert.equal(request.url.pathname.endsWith('/conversations.history'), true);
  assert.deepEqual(JSON.parse(request.options.body), {
    channel: 'C12345678',
    oldest: '1700000000.001',
    latest: '1700000000.001',
    inclusive: true,
    limit: 1,
  });
});

test('Slack API and bot client add and remove reactions on the source message', async () => {
  const calls = [];
  const requestAbort = new AbortController();
  const api = new SlackApi({
    botToken: BOT_TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({
        method: url.pathname.split('/').pop(),
        body: JSON.parse(options.body),
        signal: options.signal,
      });
      return jsonResponse({ ok: true });
    },
  });
  await api.addReaction({
    channelId: 'C12345678',
    messageTs: '1700000000.123',
    emojiName: 'eyes',
    signal: requestAbort.signal,
    timeoutMs: 5_000,
  });
  await api.removeReaction({
    channelId: 'C12345678',
    messageTs: '1700000000.123',
    emojiName: 'eyes',
    signal: requestAbort.signal,
    timeoutMs: 5_000,
  });
  assert.deepEqual(calls.map(({ method, body }) => ({ method, body })), [{
    method: 'reactions.add',
    body: { channel: 'C12345678', timestamp: '1700000000.123', name: 'eyes' },
  }, {
    method: 'reactions.remove',
    body: { channel: 'C12345678', timestamp: '1700000000.123', name: 'eyes' },
  }]);
  requestAbort.abort();
  assert.equal(calls.every(({ signal }) => signal.aborted), true);

  const adapterCalls = [];
  const runtimeAbort = new AbortController();
  const sidecarAbort = new AbortController();
  const client = new SlackBotClient({
    api: {
      addReaction: async (payload) => adapterCalls.push({ action: 'add', ...payload }),
      removeReaction: async (payload) => adapterCalls.push({ action: 'remove', ...payload }),
    },
    signal: runtimeAbort.signal,
  });
  const target = { channelId: 'C12345678', messageTs: '1700000000.456' };
  assert.equal(await client.addReaction(target, 'white_check_mark', {
    signal: sidecarAbort.signal,
  }), 'white_check_mark');
  await client.removeReaction(target, 'white_check_mark', { signal: sidecarAbort.signal });
  assert.deepEqual(adapterCalls.map(({ action, channelId, messageTs, emojiName }) => ({
    action, channelId, messageTs, emojiName,
  })), [{
    action: 'add',
    channelId: 'C12345678',
    messageTs: '1700000000.456',
    emojiName: 'white_check_mark',
  }, {
    action: 'remove',
    channelId: 'C12345678',
    messageTs: '1700000000.456',
    emojiName: 'white_check_mark',
  }]);
  runtimeAbort.abort();
  assert.equal(adapterCalls.every(({ signal }) => signal.aborted), false);
  sidecarAbort.abort();
  assert.equal(adapterCalls.every(({ signal }) => signal.aborted), true);
  assert.match(SLACK_APP_MANIFEST_YAML, /\n\s+- reactions:write\n/);
});

test('Slack API completes the native external-upload flow in the original thread', async () => {
  const calls = [];
  const api = new SlackApi({
    botToken: BOT_TOKEN,
    appToken: APP_TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.pathname.endsWith('/files.getUploadURLExternal')) {
        return jsonResponse({
          ok: true,
          upload_url: 'https://files.slack.com/upload/v1/TICKET',
          file_id: 'F12345678',
        });
      }
      if (url.pathname.startsWith('/upload/')) return new Response('OK', { status: 200 });
      return jsonResponse({ ok: true, files: [{ id: 'F12345678', title: 'result.txt' }] });
    },
  });
  const result = await api.uploadFile({
    channelId: 'C12345678',
    threadTs: '1700000000.001',
    file: {
      fileName: 'result.txt',
      mediaType: 'text/plain',
      bytes: Buffer.from('slack-result'),
    },
  });

  assert.equal(result.files[0].id, 'F12345678');
  assert.deepEqual(calls.map(({ url }) => url.pathname), [
    '/api/files.getUploadURLExternal',
    '/upload/v1/TICKET',
    '/api/files.completeUploadExternal',
  ]);
  assert.equal(
    calls[0].options.headers['content-type'],
    'application/x-www-form-urlencoded;charset=utf-8',
  );
  assert.equal(calls[0].options.body, 'filename=result.txt&length=12');
  assert.equal(calls[1].options.headers.authorization, undefined);
  assert.equal(Buffer.from(calls[1].options.body).toString(), 'slack-result');
  assert.equal(calls[2].options.headers['content-type'], 'application/json;charset=utf-8');
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    files: [{ id: 'F12345678', title: 'result.txt' }],
    channel_id: 'C12345678',
    thread_ts: '1700000000.001',
  });
  assert.match(SLACK_APP_MANIFEST_YAML, /\n\s+- files:write\n/);
});

test('Slack sends PNG and JPEG artifacts through one native image-preview upload flow each', async () => {
  const calls = [];
  const api = new SlackApi({
    botToken: BOT_TOKEN,
    appToken: APP_TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.pathname.endsWith('/files.getUploadURLExternal')) {
        return jsonResponse({
          ok: true,
          upload_url: 'https://files.slack.com/upload/v1/IMAGE',
          file_id: `FIMAGE${calls.length}`,
        });
      }
      if (url.pathname.startsWith('/upload/')) return new Response('OK', { status: 200 });
      const completed = JSON.parse(options.body);
      return jsonResponse({ ok: true, files: completed.files });
    },
  });

  for (const image of [{
    fileName: 'result.png',
    mediaType: 'image/png',
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  }, {
    fileName: 'result.jpg',
    mediaType: 'image/jpeg',
    bytes: Buffer.from([0xff, 0xd8, 0xff]),
  }]) {
    const offset = calls.length;
    await api.uploadFile({ channelId: 'C12345678', file: image });

    assert.equal(calls.length, offset + 3);
    assert.equal(
      calls[offset].options.body,
      `filename=${image.fileName}&length=${image.bytes.length}`,
    );
    assert.equal(calls[offset + 1].options.headers['content-type'], image.mediaType);
    assert.deepEqual(JSON.parse(calls[offset + 2].options.body).files, [{
      id: `FIMAGE${offset + 1}`,
      title: image.fileName,
    }]);
  }
});

test('Slack file preparation maps missing scope and pre-delivery failures without claiming uncertainty', async () => {
  const missingScopeApi = new SlackApi({
    botToken: BOT_TOKEN,
    fetchImpl: async () => jsonResponse({ ok: false, error: 'missing_scope' }),
  });
  await assert.rejects(() => missingScopeApi.uploadFile({
    channelId: 'C12345678',
    file: { fileName: 'result.txt', bytes: Buffer.from('result') },
  }), (error) => error.code === 'artifact-permission-required'
    && error.providerCode === 'missing_scope');

  const invalidArgumentsApi = new SlackApi({
    botToken: BOT_TOKEN,
    fetchImpl: async () => jsonResponse({ ok: false, error: 'invalid_arguments' }),
  });
  await assert.rejects(() => invalidArgumentsApi.uploadFile({
    channelId: 'C12345678',
    file: { fileName: 'result.txt', bytes: Buffer.from('result') },
  }), (error) => error.code === 'artifact-provider-rejected'
    && error.providerCode === 'invalid_arguments'
    && error.status === 200);

  const sizeRestrictedApi = new SlackApi({
    botToken: BOT_TOKEN,
    fetchImpl: async () => jsonResponse({
      ok: false,
      error: 'file_upload_size_restricted',
    }),
  });
  await assert.rejects(() => sizeRestrictedApi.uploadFile({
    channelId: 'C12345678',
    file: { fileName: 'result.txt', bytes: Buffer.from('result') },
  }), (error) => error.code === 'artifact-too-large'
    && error.providerCode === 'file_upload_size_restricted'
    && error.status === 200);

  for (const ticketResponse of [
    new Response('not-json', { status: 200 }),
    jsonResponse({
      ok: true,
      upload_url: 'https://example.com/untrusted',
      file_id: 'F12345678',
    }),
  ]) {
    const api = new SlackApi({
      botToken: BOT_TOKEN,
      fetchImpl: async () => ticketResponse,
    });
    await assert.rejects(() => api.uploadFile({
      channelId: 'C12345678',
      file: { fileName: 'result.txt', bytes: Buffer.from('result') },
    }), (error) => error.code === 'artifact-provider-failed');
  }

  const rawUploadTimeoutApi = new SlackApi({
    botToken: BOT_TOKEN,
    fileUploadTimeoutMs: 10,
    fetchImpl: async (url, options) => {
      if (url.pathname.endsWith('/files.getUploadURLExternal')) {
        return jsonResponse({
          ok: true,
          upload_url: 'https://files.slack.com/upload/v1/TICKET',
          file_id: 'F12345678',
        });
      }
      return new Promise((resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
  });
  await assert.rejects(() => rawUploadTimeoutApi.uploadFile({
    channelId: 'C12345678',
    file: { fileName: 'result.txt', bytes: Buffer.from('result') },
  }), (error) => error.code === 'artifact-provider-failed'
    && error.cause?.name === 'TimeoutError');

  for (const status of [401, 403]) {
    const expiredTicketApi = new SlackApi({
      botToken: BOT_TOKEN,
      fetchImpl: async (url) => {
        if (url.pathname.endsWith('/files.getUploadURLExternal')) {
          return jsonResponse({
            ok: true,
            upload_url: 'https://files.slack.com/upload/v1/TICKET',
            file_id: 'F12345678',
          });
        }
        return new Response('', { status });
      },
    });
    await assert.rejects(() => expiredTicketApi.uploadFile({
      channelId: 'C12345678',
      file: { fileName: 'result.txt', bytes: Buffer.from('result') },
    }), (error) => error.code === 'artifact-provider-rejected'
      && error.status === status);
  }
});

test('Slack completion is never retried and all non-permission failures are uncertain', async () => {
  const completionCases = [{
    complete: async () => jsonResponse({ ok: false, error: 'ratelimited' }, 429, {
      'retry-after': '0.001',
    }),
    providerCode: 'ratelimited',
  }, {
    complete: async () => new Response('not-json', { status: 200 }),
  }, {
    complete: async () => { throw new TypeError('socket reset'); },
  }, {
    complete: async () => jsonResponse({ ok: true, files: [] }),
  }, {
    complete: async () => jsonResponse({
      ok: true,
      files: [{ id: 'F87654321', title: 'result.txt' }],
    }),
  }];

  for (const entry of completionCases) {
    let completionCalls = 0;
    const api = new SlackApi({
      botToken: BOT_TOKEN,
      fetchImpl: async (url) => {
        if (url.pathname.endsWith('/files.getUploadURLExternal')) {
          return jsonResponse({
            ok: true,
            upload_url: 'https://files.slack.com/upload/v1/TICKET',
            file_id: 'F12345678',
          });
        }
        if (url.pathname.startsWith('/upload/')) return new Response('OK', { status: 200 });
        completionCalls += 1;
        return entry.complete();
      },
    });
    await assert.rejects(() => api.uploadFile({
      channelId: 'C12345678',
      file: { fileName: 'result.txt', bytes: Buffer.from('result') },
    }), (error) => error.code === 'artifact-delivery-uncertain'
      && error.providerCode === entry.providerCode);
    assert.equal(completionCalls, 1);
  }
});

test('Slack completion timeout is uncertain while a caller abort remains an abort', async () => {
  const createApi = ({ complete, fileUploadTimeoutMs = 120_000 }) => new SlackApi({
    botToken: BOT_TOKEN,
    fileUploadTimeoutMs,
    fetchImpl: async (url, options) => {
      if (url.pathname.endsWith('/files.getUploadURLExternal')) {
        return jsonResponse({
          ok: true,
          upload_url: 'https://files.slack.com/upload/v1/TICKET',
          file_id: 'F12345678',
        });
      }
      if (url.pathname.startsWith('/upload/')) return new Response('OK', { status: 200 });
      return complete(options.signal);
    },
  });
  const timeoutApi = createApi({
    fileUploadTimeoutMs: 10,
    complete: async (signal) => new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  await assert.rejects(() => timeoutApi.uploadFile({
    channelId: 'C12345678',
    file: { fileName: 'result.txt', bytes: Buffer.from('result') },
  }), (error) => error.code === 'artifact-delivery-uncertain'
    && error.cause?.name === 'TimeoutError');

  const caller = new AbortController();
  const reason = new DOMException('caller stopped', 'AbortError');
  const cancelledApi = createApi({
    complete: async () => {
      caller.abort(reason);
      throw reason;
    },
  });
  await assert.rejects(() => cancelledApi.uploadFile({
    channelId: 'C12345678',
    file: { fileName: 'result.txt', bytes: Buffer.from('result') },
    signal: caller.signal,
  }), (error) => error === reason && error.code !== 'artifact-delivery-uncertain');
});

test('Slack completion missing_scope remains a permission error', async () => {
  let completionCalls = 0;
  const api = new SlackApi({
    botToken: BOT_TOKEN,
    fetchImpl: async (url) => {
      if (url.pathname.endsWith('/files.getUploadURLExternal')) {
        return jsonResponse({
          ok: true,
          upload_url: 'https://files.slack.com/upload/v1/TICKET',
          file_id: 'F12345678',
        });
      }
      if (url.pathname.startsWith('/upload/')) return new Response('OK', { status: 200 });
      completionCalls += 1;
      return jsonResponse({ ok: false, error: 'missing_scope' });
    },
  });
  await assert.rejects(() => api.uploadFile({
    channelId: 'C12345678',
    file: { fileName: 'result.txt', bytes: Buffer.from('result') },
  }), (error) => error.code === 'artifact-permission-required'
    && error.providerCode === 'missing_scope');
  assert.equal(completionCalls, 1);
});

test('Slack downloads private files with the bot token from Slack hosts only', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const calls = [];
  const api = new SlackApi({
    botToken: BOT_TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(png, { status: 200, headers: { 'content-length': String(png.length) } });
    },
  });
  assert.deepEqual(await api.downloadFile({
    url: 'https://files.slack.com/files-pri/T123-F123/download/image.png',
    maxBytes: 100,
  }), png);
  assert.equal(calls[0].options.headers.authorization, `Bearer ${BOT_TOKEN}`);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.deepEqual(await api.downloadFile({
    url: 'https://slack.com/files-pri/T123-F124/download/image.png',
    maxBytes: 100,
  }), png);
  assert.equal(calls[1].options.headers.authorization, `Bearer ${BOT_TOKEN}`);
  assert.equal(calls[1].url.hostname, 'files.slack.com');
  const streamed = await api.downloadFileStream({
    url: 'https://files.slack.com/files-pri/T123-F126/download/notes.txt',
  });
  const streamedChunks = [];
  for await (const chunk of streamed.stream) streamedChunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(streamedChunks), png);
  assert.equal(calls[2].options.signal, undefined);
  await assert.rejects(() => api.downloadFile({
    url: 'https://example.com/internal.png', maxBytes: 100,
  }), /messaging platform/);
  assert.equal(calls.length, 3);

  const redirectCalls = [];
  const redirectingApi = new SlackApi({
    botToken: BOT_TOKEN,
    fetchImpl: async (url, options) => {
      redirectCalls.push({ url, options });
      return new Response(null, {
        status: 302,
        headers: { location: 'https://example.com/leak-token' },
      });
    },
  });
  await assert.rejects(() => redirectingApi.downloadFile({
    url: 'https://slack.com/files-pri/T123-F125/download/image.png',
    maxBytes: 100,
  }), (error) => {
    assert.equal(error.code, 'image-redirect-blocked');
    return true;
  });
  assert.equal(redirectCalls.length, 1);
  assert.equal(redirectCalls[0].url.hostname, 'files.slack.com');
  assert.equal(redirectCalls[0].options.headers.authorization, `Bearer ${BOT_TOKEN}`);
  assert.match(SLACK_APP_MANIFEST_YAML, /\n\s+- files:read\n/);
});

test('Slack resolves file_access metadata through files.info', async () => {
  const calls = [];
  const api = new SlackApi({
    botToken: BOT_TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        ok: true,
        file: {
          id: 'F12345678',
          name: 'connect.txt',
          mimetype: 'text/plain',
          url_private: 'https://files.slack.com/files-pri/T123-F123/connect.txt',
        },
      });
    },
  });
  assert.equal((await api.fileInfo({ fileId: 'F12345678' })).name, 'connect.txt');
  assert.equal(calls[0].url.pathname.endsWith('/files.info'), true);
  assert.equal(calls[0].options.body, 'file=F12345678');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${BOT_TOKEN}`);
});

test('Slack refuses unsafe file redirects and explains stale files:read authorization', async () => {
  const workspaceCalls = [];
  const workspaceApi = new SlackApi({
    botToken: BOT_TOKEN,
    fetchImpl: async (url, options) => {
      workspaceCalls.push({ url, options });
      return new Response(null, {
        status: 302,
        headers: { location: 'https://workspace-name.slack.com/?redir=%2Ffiles-pri%2Fsecret' },
      });
    },
  });
  await assert.rejects(() => workspaceApi.downloadFile({
    url: 'https://files.slack.com/files-pri/T123-F126/download/image.png',
    maxBytes: 100,
  }), (error) => {
    assert.equal(error.code, 'slack-file-access-required');
    assert.match(error.userMessage, /files:read/);
    return true;
  });
  assert.equal(workspaceCalls.length, 1);

  const missingScopeCalls = [];
  const missingScopeApi = new SlackApi({
    botToken: BOT_TOKEN,
    fetchImpl: async (url, options) => {
      missingScopeCalls.push({ url, options });
      if (url.pathname.endsWith('/auth.test')) {
        return new Response(JSON.stringify({
          ok: true,
          team_id: 'T12345678',
          user_id: 'U12345678',
          bot_id: 'B12345678',
        }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-oauth-scopes': 'app_mentions:read,chat:write,im:history',
          },
        });
      }
      return new Response(null, {
        status: 302,
        headers: {
          location: 'https://files-origin.slack.com/files-pri/T123-F126/download/image.png',
        },
      });
    },
  });
  await missingScopeApi.authTest();
  await assert.rejects(() => missingScopeApi.downloadFile({
    url: 'https://files.slack.com/files-pri/T123-F126/download/image.png',
    maxBytes: 100,
  }), (error) => {
    assert.equal(error.code, 'slack-file-access-required');
    assert.match(error.userMessage, /files:read/);
    return true;
  });
  assert.equal(missingScopeCalls.length, 2);
  assert.deepEqual(missingScopeCalls.map((call) => call.url.hostname), [
    'slack.com', 'files.slack.com',
  ]);

  for (const location of [
    'https://example.com/leak-token',
    'http://files-origin.slack.com/files-pri/T123-F126/download/image.png',
    'https://files-origin.slack.com/files-pri/T123-F126/download/image.png',
    'https://files-origin.slack.com/files-pri/T123-F999/download/image.png',
    'https://files-origin.slack.com/files-pri/T123-F126/download/image.png?changed=1',
  ]) {
    const unsafeCalls = [];
    const unsafeApi = new SlackApi({
      botToken: BOT_TOKEN,
      fetchImpl: async (url, options) => {
        unsafeCalls.push({ url, options });
        return new Response(null, { status: 302, headers: { location } });
      },
    });
    await assert.rejects(() => unsafeApi.downloadFile({
      url: 'https://files.slack.com/files-pri/T123-F126/download/image.png',
      maxBytes: 100,
    }), (error) => {
      assert.equal(error.code, 'image-redirect-blocked');
      return true;
    });
    assert.equal(unsafeCalls.length, 1);
  }
});

test('Slack controller stores two protected credential references and exposes neither token', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-slack-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'config.json');
  const configStore = await new SlackConfigStore(configPath).load();
  const credentialStore = credentials();
  const connectionTests = [];
  const proactiveSends = [];
  const controller = new SlackController({
    credentials: credentialStore,
    configStore,
    inspectCredentials: async () => ({
      platformId: 'T12345678:U12345678',
      name: 'DeepSeek Harness',
      username: 'deepseek-harness',
      teamId: 'T12345678',
      teamName: 'Harness Lab',
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
      async sendConnectionTest(text) { connectionTests.push(text); },
      async sendProactiveText(...args) {
        proactiveSends.push(args);
        return { sent: true };
      },
    }),
  });
  const status = await controller.bindCredentials({ botToken: BOT_TOKEN, appToken: APP_TOKEN });
  assert.equal(status.totals.connected, 1);
  assert.equal(status.bots[0].bot.name, 'DeepSeek Harness');
  assert.equal(status.bots[0].bot.teamName, 'Harness Lab');
  const identity = deriveSlackBotIdentity('T12345678:U12345678');
  assert.equal(credentialStore.values.get(identity.botTokenRef), BOT_TOKEN);
  assert.equal(credentialStore.values.get(identity.appTokenRef), APP_TOKEN);
  const stored = await readFile(configPath, 'utf8');
  assert.doesNotMatch(stored, new RegExp(BOT_TOKEN));
  assert.doesNotMatch(stored, new RegExp(APP_TOKEN));
  await controller.sendConnectionTest(identity.botId);
  assert.match(connectionTests[0], /DeepSeek Harness/);
  assert.match(connectionTests[0], /T1234••• · U1234•••/);
  const target = { kind: 'conversation', route: { channelId: 'C12345678' } };
  assert.deepEqual(await controller.sendProactiveText(identity.botId, target, 'proactive-test'), {
    sent: true,
  });
  assert.deepEqual(proactiveSends, [[target, 'proactive-test', {}]]);
  await controller.deleteBot(identity.botId);
  assert.equal(credentialStore.values.has(identity.botTokenRef), false);
  assert.equal(credentialStore.values.has(identity.appTokenRef), false);
});

test('Slack RPC requires exactly two tokens and strips all credential internals', async () => {
  const connectionTests = [];
  const controller = {
    status: () => ({ bots: [], totals: { configured: 0, connected: 0 } }),
    bindCredentials: async () => ({
      bots: [{
        botId: 'slack_1234567890abcdef12345678',
        botToken: BOT_TOKEN,
        appToken: APP_TOKEN,
        botTokenRef: 'DSH_SLACK_BOT_TOKEN_ABC',
        appTokenRef: 'DSH_SLACK_APP_TOKEN_ABC',
        platformId: 'T123:U123',
        bot: { name: 'Slack机器人', idMasked: 'T123•••' },
      }],
      totals: { configured: 1, connected: 0 },
    }),
    reconnectBot: async (botId) => ({
      bots: [{ botId, connected: true }],
      totals: { configured: 1, connected: 1 },
    }),
    sendConnectionTest: async (botId) => { connectionTests.push(botId); },
    deleteBot: async () => ({ bots: [], totals: { configured: 0, connected: 0 } }),
  };
  const handler = createSlackRpcHandler(controller);
  const result = await handler(SLACK_ENDPOINTS.bindCredentials, {
    botToken: BOT_TOKEN,
    appToken: APP_TOKEN,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.bots[0].botToken, undefined);
  assert.equal(result.value.bots[0].appToken, undefined);
  assert.equal(result.value.bots[0].botTokenRef, undefined);
  assert.equal(result.value.bots[0].appTokenRef, undefined);
  assert.equal(result.value.bots[0].platformId, undefined);
  const rejected = await handler(SLACK_ENDPOINTS.bindCredentials, {
    botToken: BOT_TOKEN,
    appToken: APP_TOKEN,
    extra: true,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'bad-request');

  const tested = await handler(SLACK_ENDPOINTS.reconnectBot, {
    botId: 'slack_1234567890abcdef12345678',
    sendTest: true,
  });
  assert.equal(tested.ok, true);
  assert.deepEqual(tested.value.testMessage, { sent: true });
  assert.deepEqual(connectionTests, ['slack_1234567890abcdef12345678']);
});

test('Slack RPC never sends a connection test after reconnect is cancelled', async () => {
  let resolveReconnect;
  let sendCalls = 0;
  const reconnect = new Promise((resolve) => { resolveReconnect = resolve; });
  const botId = 'slack_1234567890abcdef12345678';
  const controller = {
    status: async () => ({ bots: [] }),
    bindCredentials: async () => ({ bots: [] }),
    reconnectBot: async () => reconnect,
    sendConnectionTest: async () => { sendCalls += 1; },
    deleteBot: async () => ({ bots: [] }),
  };
  const abort = new AbortController();
  const result = createSlackRpcHandler(controller)(SLACK_ENDPOINTS.reconnectBot, {
    botId,
    sendTest: true,
  }, abort.signal);

  abort.abort();
  resolveReconnect({ bots: [{ botId, connected: true }] });

  assert.deepEqual(await result, {
    ok: false,
    error: { code: 'cancelled', message: 'The request was cancelled.' },
  });
  assert.equal(sendCalls, 0);
});

test('Slack normalizes direct messages and addressed channel events', () => {
  const direct = normalizeSlackEvent({
    event_id: 'Ev001',
    team_id: 'T12345678',
    event: {
      type: 'message',
      channel_type: 'im',
      channel: 'D12345678',
      user: 'U87654321',
      ts: '1700000000.001',
      text: 'hello &amp; welcome',
    },
  }, 'U12345678');
  assert.equal(direct.kind, 'direct');
  assert.equal(direct.addressed, true);
  assert.equal(direct.content, 'hello & welcome');
  assert.equal(direct.conversationId, 'D12345678');
  assert.equal(direct.replyTarget.threadTs, '1700000000.001');
  assert.deepEqual(direct.connectionTestTarget, { channelId: 'D12345678' });

  const group = normalizeSlackEvent({
    event_id: 'Ev002',
    team_id: 'T12345678',
    event: {
      type: 'app_mention',
      channel: 'C12345678',
      user: 'U87654321',
      user_team: 'T12345678',
      ts: '1700000000.002',
      text: '<@U12345678> run this',
    },
  }, 'U12345678');
  assert.equal(group.kind, 'group');
  assert.equal(group.addressed, true);
  assert.equal(group.content, 'run this');
  assert.equal(group.conversationId, 'C12345678:1700000000.002');
  assert.equal(group.replyTarget.threadTs, '1700000000.002');

  const threaded = normalizeSlackEvent({
    event_id: 'Ev002-threaded',
    team_id: 'T12345678',
    event: {
      type: 'app_mention',
      channel: 'C12345678',
      user: 'U87654321',
      ts: '1700000000.003',
      thread_ts: '1700000000.002',
      text: '<@U12345678> continue',
    },
  }, 'U12345678');
  assert.equal(threaded.replyTarget.threadTs, '1700000000.002');
  assert.deepEqual(threaded.reactionTarget, {
    channelId: 'C12345678',
    messageTs: '1700000000.003',
  });

  const botMessage = normalizeSlackEvent({
    event_id: 'Ev003',
    event: {
      type: 'message', channel_type: 'im', channel: 'D12345678', user: 'U12345678',
      bot_id: 'B12345678', ts: '1700000000.003', text: 'ignore me',
    },
  }, 'U12345678');
  assert.equal(botMessage, null);
});

test('Slack keeps thread roots as lazy reply references without loading non-thread messages', async () => {
  const loads = [];
  const threaded = normalizeSlackEvent({
    event_id: 'Ev-reply-1',
    event: {
      type: 'app_mention',
      channel: 'C12345678',
      user: 'U87654321',
      ts: '1700000000.002',
      thread_ts: '1700000000.001',
      text: '<@U12345678> summarize this',
    },
  }, 'U12345678', {
    loadReply: async (options) => {
      loads.push(options);
      return {
        ts: '1700000000.001',
        user: 'U11111111',
        username: 'Original author',
        text: 'quoted &amp; original',
        files: [
          { name: 'screen.png', mimetype: 'image/png' },
          { name: 'voice.ogg', mimetype: 'audio/ogg' },
          { name: 'clip.mp4', mimetype: 'video/mp4' },
          { name: 'report.pdf', mimetype: 'application/pdf' },
        ],
      };
    },
  });
  assert.equal(loads.length, 0);
  assert.equal(threaded.replyTo.messageId, '1700000000.001');
  const controller = new AbortController();
  assert.deepEqual(await threaded.replyTo.load({ signal: controller.signal }), {
    messageId: '1700000000.001',
    authorId: 'U11111111',
    authorName: 'Original author',
    content: 'quoted & original',
    attachments: [
      { kind: 'image', name: 'screen.png' },
      { kind: 'audio', name: 'voice.ogg' },
      { kind: 'video', name: 'clip.mp4' },
      { kind: 'file', name: 'report.pdf' },
    ],
  });
  assert.deepEqual(loads, [{
    channelId: 'C12345678',
    messageTs: '1700000000.001',
    signal: controller.signal,
  }]);

  const missingScope = normalizeSlackEvent({
    event_id: 'Ev-reply-scope',
    event: {
      type: 'app_mention', channel: 'C12345678', user: 'U87654321',
      ts: '1700000000.004', thread_ts: '1700000000.001', text: '<@U12345678> retry',
    },
  }, 'U12345678', {
    loadReply: async () => {
      const error = new Error('missing scope');
      error.code = 'slack-missing-scope';
      throw error;
    },
  });
  assert.deepEqual(await missingScope.replyTo.load(), {
    messageId: '1700000000.001',
    unavailableReason: 'permission-denied',
  });

  const root = normalizeSlackEvent({
    event_id: 'Ev-root-1',
    event: {
      type: 'message', channel_type: 'im', channel: 'D12345678', user: 'U87654321',
      ts: '1700000000.003', text: 'ordinary root',
    },
  }, 'U12345678', { loadReply: async () => { throw new Error('must not load'); } });
  assert.equal(Object.hasOwn(root, 'replyTo'), false);
  assert.match(SLACK_APP_MANIFEST_YAML, /\n\s+- channels:history\n/);
  assert.match(SLACK_APP_MANIFEST_YAML, /\n\s+- groups:history\n/);
  assert.match(SLACK_APP_MANIFEST_YAML, /\n\s+- mpim:history\n/);
});

test('Slack keeps image shares in image prompts and exposes ordinary files lazily', async () => {
  const loads = [];
  const direct = normalizeSlackEvent({
    event_id: 'Ev010',
    team_id: 'T12345678',
    event: {
      type: 'message',
      subtype: 'file_share',
      channel_type: 'im',
      channel: 'D12345678',
      user: 'U87654321',
      ts: '1700000000.010',
      text: '识别一下',
      files: [{
        id: 'F12345678', name: 'screen.png', mimetype: 'image/png', size: 2_000,
        url_private_download: 'https://files.slack.com/files-pri/T123-F123/download/screen.png',
      }, {
        id: 'F12345679', name: 'notes.txt', mimetype: 'text/plain', size: 20,
        url_private: 'https://files.slack.com/files-pri/T123-F124/notes.txt',
      }],
    },
  }, 'U12345678', {
    loadFile: async (url, options) => {
      loads.push({ kind: 'image', url, options });
      return Buffer.from('image');
    },
    loadFileStream: async (url, options) => {
      loads.push({ kind: 'file', url, options });
      return { stream: (async function* content() { yield Buffer.from('file'); }()) };
    },
  });
  assert.equal(direct.images.length, 1);
  assert.equal(direct.images[0].name, 'screen.png');
  await direct.images[0].load({ maxBytes: 5_000 });
  assert.match(loads[0].url, /screen\.png$/);
  assert.equal(direct.files.length, 1);
  assert.deepEqual({
    name: direct.files[0].name,
    mediaType: direct.files[0].mediaType,
    size: direct.files[0].size,
  }, { name: 'notes.txt', mediaType: 'text/plain', size: 20 });
  const controller = new AbortController();
  const loadedFile = await direct.files[0].load({ signal: controller.signal });
  const chunks = [];
  for await (const chunk of loadedFile.stream) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), 'file');
  assert.match(loads[1].url, /notes\.txt$/);
  assert.equal(loads[1].kind, 'file');
  assert.deepEqual(loads[1].options, { signal: controller.signal });

  const group = normalizeSlackEvent({
    event_id: 'Ev011',
    team_id: 'T12345678',
    event: {
      type: 'app_mention', channel: 'C12345678', user: 'U87654321', ts: '1700000000.011',
      text: '<@U12345678>',
      files: [{
        id: 'F12345680', name: 'photo.jpg', mimetype: 'image/jpeg', size: 1_000,
        url_private: 'https://files.slack.com/files-pri/T123-F125/photo.jpg',
      }],
    },
  }, 'U12345678');
  assert.equal(group.addressed, true);
  assert.equal(group.images.length, 1);
  assert.deepEqual(group.files, []);

  assert.equal(normalizeSlackEvent({
    event_id: 'Ev012',
    event: {
      type: 'message', subtype: 'message_changed', channel_type: 'im', channel: 'D12345678',
      user: 'U87654321', ts: '1700000000.012', text: '', files: [],
    },
  }, 'U12345678'), null);
});

test('Slack Connect file placeholders load metadata before streaming the file', async () => {
  const calls = [];
  const message = normalizeSlackEvent({
    event_id: 'Ev013',
    event: {
      type: 'message',
      subtype: 'file_share',
      channel_type: 'im',
      channel: 'D12345678',
      user: 'U87654321',
      ts: '1700000000.013',
      text: '',
      files: [{
        id: 'F12345681',
        mode: 'file_access',
        file_access: 'check_file_info',
      }],
    },
  }, 'U12345678', {
    loadFileInfo: async (fileId, options) => {
      calls.push({ kind: 'info', fileId, options });
      return {
        id: fileId,
        name: 'connect-report.pdf',
        mimetype: 'application/pdf',
        url_private_download: 'https://files.slack.com/files-pri/T123-F123/connect-report.pdf',
      };
    },
    loadFileStream: async (url, options) => {
      calls.push({ kind: 'stream', url, options });
      return { stream: (async function* content() { yield Buffer.from('connect'); }()) };
    },
  });
  assert.equal(message.files.length, 1);
  const controller = new AbortController();
  const loaded = await message.files[0].load({ signal: controller.signal });
  assert.equal(loaded.name, 'connect-report.pdf');
  assert.equal(loaded.mediaType, 'application/pdf');
  const chunks = [];
  for await (const chunk of loaded.stream) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), 'connect');
  assert.deepEqual(calls[0], {
    kind: 'info', fileId: 'F12345681', options: { signal: controller.signal },
  });
  assert.equal(calls[1].kind, 'stream');
  assert.match(calls[1].url, /connect-report\.pdf$/);
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
    this.sent.push(JSON.parse(value));
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

test('Slack runtime forwards the live access policy provider into its shared bridge', async () => {
  let socket;
  let stateWrites = 0;
  const runtime = new SlackRuntime({
    config: {
      botId: 'slack_access',
      platformId: 'T12345678:U12345678',
      name: 'DeepSeek Harness',
    },
    botToken: BOT_TOKEN,
    appToken: APP_TOKEN,
    harness: { ensureRunning: async () => true },
    state: {
      hasSeen: () => false,
      markSeen: async () => { stateWrites += 1; },
    },
    accessPolicy: {
      getSettings: () => ({
        direct: {
          mode: 'allowlist',
          open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
          allowlist: { users: [] },
        },
        group: {
          mode: 'open',
          open: { defaultCanExecuteCommands: true, commandPermissionOverrides: [] },
          allowlist: { users: [] },
        },
      }),
    },
    createApi: () => ({
      authTest: async () => ({ team_id: 'T12345678', user_id: 'U12345678' }),
      openConnection: async () => ({ url: 'wss://wss-primary.slack.com/link/?ticket=test' }),
    }),
    createWebSocket: () => {
      socket = new FakeSocket();
      queueMicrotask(() => socket.emit('message', {
        data: JSON.stringify({
          type: 'hello',
          connection_info: { app_id: 'A12345678' },
        }),
      }));
      return socket;
    },
    logger: { warn() {}, error(...args) { assert.fail(args.join(' ')); } },
  });

  try {
    await runtime.start();
    socket.emit('message', {
      data: JSON.stringify({
        envelope_id: 'env-denied',
        type: 'events_api',
        payload: {
          type: 'event_callback',
          api_app_id: 'A12345678',
          event_id: 'Ev-denied',
          event: {
            type: 'message', channel_type: 'im', channel: 'D12345678',
            user: 'U00000000', ts: '1700000000.009', text: 'must stay local',
          },
        },
      }),
    });
    await eventually(() => runtime.status.messagesRejected === 1);
    assert.equal(stateWrites, 1, 'the denial is recorded only for replay suppression');
    assert.deepEqual(socket.sent.at(-1), { envelope_id: 'env-denied' });
  } finally {
    await runtime.stop();
  }
});

test('Slack runtime opens Socket Mode, acknowledges envelopes, and becomes ready', async () => {
  let socket;
  const abortMark = deferred();
  let abortMarkStarted = false;
  const errors = [];
  const proactiveCalls = [];
  const runtime = new SlackRuntime({
    config: {
      botId: 'slack_test',
      platformId: 'T12345678:U12345678',
      name: 'DeepSeek Harness',
    },
    botToken: BOT_TOKEN,
    appToken: APP_TOKEN,
    harness: { ensureRunning: async () => true },
    state: {
      sessionFor: () => null,
      setSession: async () => {},
      clearSession: async () => {},
      hasSeen: () => false,
      markSeen: async (messageId) => {
        if (messageId === 'Ev-abort') {
          abortMarkStarted = true;
          return abortMark.promise;
        }
        throw new Error(`Slack state write failed for ${messageId}`);
      },
    },
    createApi: () => ({
      authTest: async () => ({ team_id: 'T12345678', user_id: 'U12345678' }),
      openConnection: async () => ({ url: 'wss://wss-primary.slack.com/link/?ticket=test' }),
      postMessage: async (request) => {
        proactiveCalls.push(request);
        return { ts: '1700000000.900' };
      },
    }),
    createWebSocket: () => {
      socket = new FakeSocket();
      queueMicrotask(() => socket.emit('message', {
        data: JSON.stringify({
          type: 'hello',
          connection_info: { app_id: 'A12345678' },
        }),
      }));
      return socket;
    },
    logger: {
      warn() {},
      error(...args) { errors.push(args); },
    },
  });
  await runtime.start();
  assert.equal(runtime.status.ready, true);
  assert.deepEqual(await runtime.sendProactiveText({
    kind: 'thread',
    route: { channelId: 'C12345678', threadTs: '1700000000.100' },
  }, 'proactive-test'), { providerMessageIds: ['1700000000.900'] });
  assert.equal(proactiveCalls.length, 1);
  assert.equal(proactiveCalls[0].channelId, 'C12345678');
  assert.equal(proactiveCalls[0].threadTs, '1700000000.100');
  assert.equal(proactiveCalls[0].text, 'proactive-test');
  socket.emit('message', {
    data: JSON.stringify({
      envelope_id: 'env-1',
      type: 'events_api',
      payload: { type: 'event_callback', api_app_id: 'A12345678', event_id: 'Ev-noop', event: {} },
    }),
  });
  assert.deepEqual(socket.sent.at(-1), { envelope_id: 'env-1' });

  for (const eventId of ['Ev-failed-first', 'Ev-failed-queued']) {
    socket.emit('message', {
      data: JSON.stringify({
        envelope_id: `env-${eventId}`,
        type: 'events_api',
        payload: {
          type: 'event_callback',
          api_app_id: 'A12345678',
          event_id: eventId,
          event: {
            type: 'message',
            channel_type: 'im',
            channel: 'D12345678',
            user: 'U87654321',
            ts: eventId === 'Ev-failed-first' ? '1700000000.010' : '1700000000.011',
            text: 'trigger state failure',
          },
        },
      }),
    });
  }
  await eventually(() => errors.length === 2);
  assert.equal(errors.every((args) => args[0].includes('message handling failed')), true);

  socket.emit('message', {
    data: JSON.stringify({
      envelope_id: 'env-abort',
      type: 'events_api',
      payload: {
        type: 'event_callback',
        api_app_id: 'A12345678',
        event_id: 'Ev-abort',
        event: {
          type: 'message',
          channel_type: 'im',
          channel: 'D12345678',
          user: 'U87654321',
          ts: '1700000000.012',
          text: 'abort state write',
        },
      },
    }),
  });
  await eventually(() => abortMarkStarted);
  const stopping = runtime.stop();
  abortMark.reject(new Error('Slack state write aborted'));
  await stopping;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 2);
  assert.equal(runtime.status.ready, false);
});
