import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  createWeixinApi,
  decryptWeixinImage,
  extractWeixinFiles,
  extractWeixinReplyReference,
  extractWeixinText,
  normalizeWeixinApiBaseUrl,
  parseWeixinImageAesKey,
  splitWeixinText,
  weixinImageDownloadUrl,
  weixinMessageTimestampMs,
  WeixinApiError,
} from '../../../src/channels/weixin/weixin-api.mjs';

function jsonResponse(value, init) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

async function uploadBytes(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('login lifecycle preserves business rejection codes without confusing numeric and string zero', async () => {
  for (const operation of ['beginLogin', 'notifyStart', 'notifyStop']) {
    for (const response of [{ ret: 0, errcode: '0' }, { ret: '0', errcode: 0 }, { ret: 0, errcode: -14 }, { ret: '23', errcode: '0' }]) {
      const api = createWeixinApi({ fetchImpl: async () => jsonResponse({ qrcode: 'test', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/test', ...response }) });
      const request = () => api[operation]({ baseUrl: 'https://ilinkai.weixin.qq.com/', token: 'test-login' });
      const provider = response.errcode === -14 ? '-14' : response.ret === '23' ? '23' : null;
      if (!provider) await request();
      else await assert.rejects(request(), error => {
        assert.equal(error.providerCode, provider);
        assert.equal(error.code, operation === 'beginLogin' ? 'qr-request-rejected'
          : operation === 'notifyStop' ? 'stop-rejected' : provider === '-14' ? 'stale-token' : 'start-rejected');
        return true;
      });
    }
  }
});

function encryptImage(plaintext, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

test('iLink image references download lazily from the canonical CDN and decrypt AES-128-ECB', async () => {
  const key = randomBytes(16);
  const plaintext = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x01, 0x02, 0x03,
  ]);
  const ciphertext = encryptImage(plaintext, key);
  const calls = [];
  const api = createWeixinApi({
    fetchImpl: async (url, init) => {
      calls.push({ url: url.toString(), init });
      return new Response(ciphertext, {
        headers: { 'content-length': String(ciphertext.length) },
      });
    },
  });
  const images = api.inboundImages({
    item_list: [{
      type: 2,
      image_item: {
        aeskey: key.toString('hex'),
        media: { encrypt_query_param: 'one=two&three=four' },
      },
    }],
  });

  assert.equal(images.length, 1);
  assert.equal(calls.length, 0);
  const loaded = await images[0].load({ maxBytes: 1_024 });

  assert.equal(loaded.equals(plaintext), true);
  assert.equal(
    calls[0].url,
    'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=one%3Dtwo%26three%3Dfour',
  );
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'manual');
});

test('iLink native file items download lazily and decrypt without image size or type rules', async () => {
  const key = randomBytes(16);
  const plaintext = Buffer.from('weixin-native-file');
  const ciphertext = encryptImage(plaintext, key);
  const calls = [];
  const files = extractWeixinFiles({
    item_list: [{
      type: 4,
      file_item: {
        media: {
          encrypt_query_param: 'native-file-ticket',
          aes_key: Buffer.from(key.toString('hex')).toString('base64'),
          encrypt_type: 1,
        },
        file_name: '微信报告.zip',
        len: String(plaintext.length),
      },
    }],
  }, {
    fetchImpl: async (url, init) => {
      calls.push({ url: url.toString(), init });
      return new Response(ciphertext);
    },
  });

  assert.equal(files.length, 1);
  assert.equal(files[0].name, '微信报告.zip');
  assert.equal(files[0].size, plaintext.length);
  assert.equal(calls.length, 0, 'file download stays lazy');
  assert.deepEqual(await files[0].load({}), plaintext);
  assert.deepEqual(calls, [{
    url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=native-file-ticket',
    init: { method: 'GET', signal: undefined, redirect: 'manual' },
  }]);
});

test('Weixin image keys support both documented CDN encodings and reject unsafe URLs', () => {
  const key = randomBytes(16);
  assert.equal(parseWeixinImageAesKey({ aeskey: key.toString('hex') }).equals(key), true);
  assert.equal(parseWeixinImageAesKey({
    media: { aes_key: key.toString('base64') },
  }).equals(key), true);
  assert.equal(parseWeixinImageAesKey({
    media: { aes_key: Buffer.from(key.toString('hex'), 'ascii').toString('base64') },
  }).equals(key), true);
  assert.throws(
    () => parseWeixinImageAesKey({ aeskey: 'not-a-key' }),
    (error) => error instanceof WeixinApiError && error.code === 'invalid-image-key',
  );
  assert.equal(
    weixinImageDownloadUrl({ full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?id=one#fragment' }),
    'https://novac2c.cdn.weixin.qq.com/c2c/download?id=one',
  );
  assert.throws(
    () => weixinImageDownloadUrl({ full_url: 'https://attacker.example/c2c/download?id=one' }),
    (error) => error instanceof WeixinApiError && error.code === 'untrusted-image-url',
  );

  const encrypted = encryptImage(Buffer.from('image payload'), key);
  assert.equal(decryptWeixinImage(encrypted, key).toString(), 'image payload');
});

test('QR login uses the Tencent iLink headers and keeps local tokens out of the URL', async () => {
  const calls = [];
  const api = createWeixinApi({
    fetchImpl: async (url, init) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse({
        qrcode: 'private-qr-token',
        qrcode_img_content: 'https://liteapp.weixin.qq.com/q/example',
      });
    },
  });

  const login = await api.beginLogin({ localTokens: [' token-a ', 'token-a', 'token-b'] });

  assert.deepEqual(login, {
    qrcode: 'private-qr-token',
    qrcodeUrl: 'https://liteapp.weixin.qq.com/q/example',
  });
  assert.match(calls[0].url, /ilink\/bot\/get_bot_qrcode\?bot_type=3$/);
  assert.doesNotMatch(calls[0].url, /token-a|token-b/);
  assert.equal(calls[0].init.headers['iLink-App-Id'], 'bot');
  assert.equal(calls[0].init.headers['iLink-App-ClientVersion'], String((2 << 16) | (4 << 8) | 6));
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].init.body), { local_token_list: ['token-a', 'token-b'] });
});

test('login polling submits a verification code only to an approved Weixin host', async () => {
  const calls = [];
  const api = createWeixinApi({
    fetchImpl: async (url, init) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse({ status: 'scaned' });
    },
  });

  const status = await api.pollLogin({
    qrcode: 'secret-qr',
    baseUrl: 'https://shard.ilinkai.weixin.qq.com',
    verifyCode: '123456',
  });

  assert.equal(status.status, 'scaned');
  assert.match(calls[0].url, /qrcode=secret-qr&verify_code=123456$/);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.AuthorizationType, undefined);

  await assert.rejects(
    api.pollLogin({ qrcode: 'secret', baseUrl: 'https://attacker.test' }),
    (error) => error instanceof WeixinApiError && error.code === 'untrusted-base-url',
  );
  assert.equal(calls.length, 1);
});

test('sendText emits the iLink message envelope without reflecting the token in its body', async () => {
  const calls = [];
  const api = createWeixinApi({
    fetchImpl: async (url, init) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse({ ret: 0 });
    },
  });
  const result = await api.sendText({
    baseUrl: 'https://ilinkai.weixin.qq.com',
    token: 'host-only-token',
    toUserId: 'wx-user',
    text: 'Harness reply',
    contextToken: 'message-context',
    runId: 'run-1',
  });

  assert.equal(calls[0].init.headers.Authorization, 'Bearer host-only-token');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.msg.to_user_id, 'wx-user');
  assert.equal(body.msg.context_token, 'message-context');
  assert.equal(body.msg.item_list[0].text_item.text, 'Harness reply');
  assert.deepEqual(result.providerMessageIds, [body.msg.client_id]);
  assert.equal(body.base_info.channel_version, '2.4.6');
  assert.equal(body.base_info.bot_agent, 'DeepSeekHarness/1.1.0');
  assert.doesNotMatch(calls[0].init.body, /host-only-token/);
});

test('sendText preserves safe iLink business rejection codes', async (t) => {
  for (const scenario of [
    { response: { ret: -2 }, providerCode: '-2' },
    { response: { errcode: 45009 }, providerCode: '45009' },
  ]) {
    await t.test(scenario.providerCode, async () => {
      const api = createWeixinApi({
        fetchImpl: async () => jsonResponse(scenario.response),
      });

      await assert.rejects(
        api.sendText({
          baseUrl: 'https://ilinkai.wechat.com',
          token: 'host-only-token',
          toUserId: 'wx-user',
          text: 'Harness reply',
          contextToken: 'message-context',
        }),
        (error) => error instanceof WeixinApiError
          && error.code === 'send-rejected'
          && error.providerCode === scenario.providerCode,
      );
    });
  }
});

test('getConfig requests a typing ticket for the current Weixin conversation', async () => {
  const calls = [];
  const api = createWeixinApi({
    fetchImpl: async (url, init) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse({ ret: 0, typing_ticket: 'typing-ticket' });
    },
  });

  const config = await api.getConfig({
    baseUrl: 'https://ilinkai.weixin.qq.com',
    token: 'host-only-token',
    toUserId: 'wx-user',
    contextToken: 'message-context',
  });

  assert.deepEqual(config, { typingTicket: 'typing-ticket' });
  assert.match(calls[0].url, /\/ilink\/bot\/getconfig$/);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer host-only-token');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.ilink_user_id, 'wx-user');
  assert.equal(body.context_token, 'message-context');
  assert.equal(body.base_info.channel_version, '2.4.6');
  assert.doesNotMatch(calls[0].init.body, /host-only-token/);
});

test('sendTyping sends start and cancel states with the cached ticket', async () => {
  const calls = [];
  const api = createWeixinApi({
    fetchImpl: async (url, init) => {
      calls.push({ url: url.toString(), init });
      return jsonResponse({ ret: 0 });
    },
  });

  for (const status of [1, 2]) {
    await api.sendTyping({
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'host-only-token',
      toUserId: 'wx-user',
      typingTicket: 'typing-ticket',
      status,
    });
  }

  assert.deepEqual(calls.map(({ url, init }) => {
    const body = JSON.parse(init.body);
    return {
      path: new URL(url).pathname,
      user: body.ilink_user_id,
      ticket: body.typing_ticket,
      status: body.status,
      tokenInBody: init.body.includes('host-only-token'),
    };
  }), [
    {
      path: '/ilink/bot/sendtyping',
      user: 'wx-user',
      ticket: 'typing-ticket',
      status: 1,
      tokenInBody: false,
    },
    {
      path: '/ilink/bot/sendtyping',
      user: 'wx-user',
      ticket: 'typing-ticket',
      status: 2,
      tokenInBody: false,
    },
  ]);
});

test('typing endpoints reject non-zero iLink return codes', async () => {
  const api = createWeixinApi({
    fetchImpl: async () => jsonResponse({ ret: -2, errmsg: 'rejected' }),
  });

  await assert.rejects(
    api.getConfig({
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'host-only-token',
      toUserId: 'wx-user',
    }),
    (error) => error instanceof WeixinApiError && error.code === 'config-rejected',
  );
  await assert.rejects(
    api.sendTyping({
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'host-only-token',
      toUserId: 'wx-user',
      typingTicket: 'typing-ticket',
      status: 1,
    }),
    (error) => error instanceof WeixinApiError && error.code === 'typing-rejected',
  );
});

test('sendFile uses the iLink 2.4.6 encrypted CDN flow and sends a native file item', async () => {
  const calls = [];
  const api = createWeixinApi({
    fetchImpl: async (url, init) => {
      calls.push({ url: url.toString(), init });
      if (url.pathname.endsWith('/getuploadurl')) {
        return jsonResponse({
          ret: 0,
          upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?ticket=one',
        });
      }
      if (url.pathname === '/c2c/upload') {
        calls.at(-1).ciphertext = await uploadBytes(init.body);
        return new Response(null, {
          status: 200,
          headers: { 'x-encrypted-param': 'download-ticket' },
        });
      }
      return jsonResponse({ ret: 0 });
    },
  });
  const plaintext = Buffer.from('weixin-native-file');
  const result = await api.sendFile({
    baseUrl: 'https://ilinkai.weixin.qq.com',
    token: 'host-only-token',
    toUserId: 'wx-user',
    contextToken: 'message-context',
    runId: 'run-1',
    file: {
      artifactId: 'artifact-one',
      deliveryKey: 'session:turn:artifact-one',
      fileName: 'result.txt',
      mediaType: 'text/plain',
      bytes: plaintext,
    },
  });

  assert.equal(calls.length, 3);
  const ticket = JSON.parse(calls[0].init.body);
  assert.equal(ticket.media_type, 3);
  assert.equal(ticket.to_user_id, 'wx-user');
  assert.equal(ticket.rawsize, plaintext.length);
  assert.equal(ticket.rawfilemd5, 'ae8e1f4207c0468828419884f7329cb8');
  assert.equal(ticket.filesize, 32);
  assert.equal(ticket.no_need_thumb, true);
  assert.match(ticket.aeskey, /^[0-9a-f]{32}$/);

  assert.equal(calls[1].init.headers.Authorization, undefined);
  assert.equal(calls[1].init.headers['content-type'], 'application/octet-stream');
  assert.equal(calls[1].ciphertext.byteLength, 32);
  assert.equal(calls[1].init.headers['content-length'], '32');
  assert.equal(calls[1].init.duplex, 'half');
  assert.equal(
    decryptWeixinImage(calls[1].ciphertext, Buffer.from(ticket.aeskey, 'hex')).equals(plaintext),
    true,
  );

  const sent = JSON.parse(calls[2].init.body).msg;
  assert.equal(sent.context_token, 'message-context');
  assert.equal(sent.run_id, 'run-1');
  assert.match(sent.client_id, /^dsh-weixin-[0-9a-f]{32}$/);
  assert.equal(result.messageId, sent.client_id);
  assert.deepEqual(sent.item_list, [{
    type: 4,
    file_item: {
      media: {
        encrypt_query_param: 'download-ticket',
        aes_key: Buffer.from(ticket.aeskey).toString('base64'),
        encrypt_type: 1,
      },
      file_name: 'result.txt',
      len: String(plaintext.length),
    },
  }]);
});

test('sendImage uses the encrypted CDN flow and sends a native image item', async () => {
  const calls = [];
  const api = createWeixinApi({
    fetchImpl: async (url, init) => {
      calls.push({ url: url.toString(), init });
      if (url.pathname.endsWith('/getuploadurl')) {
        return jsonResponse({
          ret: 0,
          upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?ticket=image-one',
        });
      }
      if (url.pathname === '/c2c/upload') {
        calls.at(-1).ciphertext = await uploadBytes(init.body);
        return new Response(null, {
          status: 200,
          headers: { 'x-encrypted-param': 'download-image-ticket' },
        });
      }
      return jsonResponse({ ret: 0 });
    },
  });
  const plaintext = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x01, 0x02, 0x03,
  ]);
  const result = await api.sendImage({
    baseUrl: 'https://ilinkai.weixin.qq.com',
    token: 'host-only-token',
    toUserId: 'wx-user',
    contextToken: 'message-context',
    runId: 'run-image',
    file: {
      artifactId: 'artifact-image',
      deliveryKey: 'session:turn:artifact-image',
      fileName: 'result.png',
      mediaType: 'image/png',
      bytes: plaintext,
    },
  });

  assert.equal(calls.length, 3);
  const ticket = JSON.parse(calls[0].init.body);
  assert.equal(ticket.media_type, 1);
  assert.equal(ticket.to_user_id, 'wx-user');
  assert.equal(ticket.rawsize, plaintext.length);
  assert.equal(ticket.filesize, 16);
  assert.equal(ticket.no_need_thumb, true);
  assert.match(ticket.aeskey, /^[0-9a-f]{32}$/);
  assert.equal(
    decryptWeixinImage(calls[1].ciphertext, Buffer.from(ticket.aeskey, 'hex')).equals(plaintext),
    true,
  );

  const sent = JSON.parse(calls[2].init.body).msg;
  assert.equal(sent.context_token, 'message-context');
  assert.equal(sent.run_id, 'run-image');
  assert.match(sent.client_id, /^dsh-weixin-[0-9a-f]{32}$/);
  assert.equal(result.messageId, sent.client_id);
  assert.deepEqual(sent.item_list, [{
    type: 2,
    image_item: {
      media: {
        encrypt_query_param: 'download-image-ticket',
        aes_key: Buffer.from(ticket.aeskey).toString('base64'),
        encrypt_type: 1,
      },
      mid_size: 16,
    },
  }]);
});

function weixinFileRequest(overrides = {}) {
  return {
    baseUrl: 'https://ilinkai.weixin.qq.com',
    token: 'host-only-token',
    toUserId: 'wx-user',
    file: {
      artifactId: 'artifact-error-case',
      deliveryKey: 'session:turn:artifact-error-case',
      fileName: 'result.txt',
      mediaType: 'text/plain',
      bytes: Buffer.from('weixin-error-case'),
    },
    ...overrides,
  };
}

function weixinFileFetch(finalResponse) {
  return async (url, init) => {
    if (url.pathname.endsWith('/getuploadurl')) {
      return jsonResponse({
        ret: 0,
        upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?ticket=error-case',
      });
    }
    if (url.pathname === '/c2c/upload') {
      return new Response(null, {
        status: 200,
        headers: { 'x-encrypted-param': 'download-error-case' },
      });
    }
    return finalResponse(url, init);
  };
}

test('images and files use the injected CDN fetch while JSON requests keep their existing fetch', async () => {
  for (const operation of ['sendImage', 'sendFile']) {
    const jsonCalls = [];
    const uploads = [];
    const api = createWeixinApi({
      fetchImpl: async (url, init) => {
        assert.notEqual(url.pathname, '/c2c/upload');
        jsonCalls.push({ path: url.pathname, body: JSON.parse(init.body) });
        return jsonResponse(url.pathname.endsWith('/getuploadurl')
          ? { ret: 0, upload_param: 'upload-ticket' } : { ret: 0 });
      },
      uploadFetchImpl: async (url, init) => {
        assert.equal(url.hostname, 'novac2c.cdn.weixin.qq.com');
        assert.equal(url.pathname, '/c2c/upload');
        assert.equal(init.headers.Authorization, undefined);
        uploads.push(await uploadBytes(init.body));
        return new Response(null, { headers: { 'x-encrypted-param': 'private-download' } });
      },
    });
    const request = weixinFileRequest({ file: {
      fileName: 'test.png', mediaType: 'image/png', bytes: Buffer.from('test-image'),
    } });
    await api[operation](request);
    assert.deepEqual(jsonCalls.map(call => call.path), [
      '/ilink/bot/getuploadurl', '/ilink/bot/sendmessage',
    ]);
    assert.equal(uploads.length, 1);
    assert.deepEqual(
      decryptWeixinImage(uploads[0], Buffer.from(jsonCalls[0].body.aeskey, 'hex')),
      request.file.bytes,
    );
    const item = jsonCalls[1].body.msg.item_list[0];
    assert.equal((item.image_item ?? item.file_item).media.encrypt_query_param, 'private-download');
  }
});

test('sendFile allows an upload lasting over 60 seconds while chunks keep progressing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const plaintext = Buffer.alloc(4 * 64 * 1024 + 7, 0xab);
  let ticket;
  let uploadCount = 0;
  let sendCount = 0;
  let elapsed = 0;
  const api = createWeixinApi({
    fetchImpl: async (url, init) => {
      if (url.pathname.endsWith('/getuploadurl')) {
        ticket = JSON.parse(init.body);
        return jsonResponse({ ret: 0, upload_param: 'slow-upload' });
      }
      if (url.pathname === '/c2c/upload') {
        uploadCount += 1;
        const chunks = [];
        for await (const chunk of init.body) {
          assert.ok(chunk.length <= 64 * 1024);
          chunks.push(chunk);
          t.mock.timers.tick(40_000);
          elapsed += 40_000;
          assert.equal(init.signal.aborted, false);
        }
        const ciphertext = Buffer.concat(chunks);
        assert.equal(ciphertext.length, Number(init.headers['content-length']));
        assert.deepEqual(decryptWeixinImage(ciphertext, Buffer.from(ticket.aeskey, 'hex')), plaintext);
        return new Response(null, { headers: { 'x-encrypted-param': 'slow-download' } });
      }
      sendCount += 1;
      return jsonResponse({ ret: 0 });
    },
  });
  await api.sendFile(weixinFileRequest({ file: { fileName: 'large.zip', bytes: plaintext } }));
  assert.ok(elapsed > 60_000);
  assert.equal(uploadCount, 1);
  assert.equal(sendCount, 1);
});

test('sendFile reports stalled uploads and response waits as unsent after bounded retries', async (t) => {
  for (const consumeBody of [false, true]) {
    await t.test(consumeBody ? 'waiting for response' : 'waiting to upload', async (st) => {
      st.mock.timers.enable({ apis: ['setTimeout'] });
      let attempts = 0;
      const api = createWeixinApi({
        fetchImpl: async (url, init) => {
          if (url.pathname.endsWith('/getuploadurl')) {
            return jsonResponse({ ret: 0, upload_param: 'stalled-upload' });
          }
          assert.equal(url.pathname, '/c2c/upload', 'must never send a file message after upload failure');
          attempts += 1;
          if (consumeBody) await uploadBytes(init.body);
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
            st.mock.timers.tick(60_000);
          });
        },
      });
      await assert.rejects(api.sendFile(weixinFileRequest()), error => (
        error.code === 'artifact-upload-timeout' && error.cause.code === 'upload-timeout'
      ));
      assert.equal(attempts, 3);
    });
  }
});

test('sendFile rebuilds the encrypted stream for retries and stops on definitive rejection', async (t) => {
  for (const status of [503, 413]) {
    await t.test(String(status), async () => {
      const uploads = [];
      let responsesCancelled = 0;
      let sends = 0;
      const api = createWeixinApi({
        fetchImpl: async (url, init) => {
          if (url.pathname.endsWith('/getuploadurl')) {
            return jsonResponse({ ret: 0, upload_param: 'retry-upload' });
          }
          if (url.pathname === '/c2c/upload') {
            uploads.push(await uploadBytes(init.body));
            return {
              status: uploads.length === 1 ? status : 200,
              headers: new Headers({ 'x-encrypted-param': 'retry-download' }),
              body: { async cancel() { responsesCancelled += 1; } },
            };
          }
          sends += 1;
          return jsonResponse({ ret: 0 });
        },
      });
      if (status === 413) {
        await assert.rejects(api.sendFile(weixinFileRequest()), { code: 'artifact-too-large' });
        assert.equal(uploads.length, 1);
        assert.equal(sends, 0);
      } else {
        await api.sendFile(weixinFileRequest());
        assert.equal(uploads.length, 2);
        assert.deepEqual(uploads[0], uploads[1]);
        assert.equal(sends, 1);
      }
      assert.equal(responsesCancelled, uploads.length);
    });
  }
});

test('sendFile honours caller cancellation during upload without retrying or sending', async () => {
  const controller = new AbortController();
  const reason = new Error('caller cancelled upload');
  let attempts = 0;
  const api = createWeixinApi({
    fetchImpl: async (url, init) => {
      if (url.pathname.endsWith('/getuploadurl')) {
        return jsonResponse({ ret: 0, upload_param: 'cancel-upload' });
      }
      assert.equal(url.pathname, '/c2c/upload');
      attempts += 1;
      await init.body.next();
      controller.abort(reason);
      await init.body.next();
      assert.fail('the upload stream must stop');
    },
  });
  await assert.rejects(api.sendFile(weixinFileRequest({ signal: controller.signal })), error => error === reason);
  assert.equal(attempts, 1);
});

test('sendFile streams valid ciphertext and Content-Length through native fetch', async (t) => {
  let received;
  let headers;
  const server = createServer(async (request, response) => {
    headers = request.headers;
    received = await uploadBytes(request);
    response.writeHead(200, { 'x-encrypted-param': 'native-fetch-download' });
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const plaintext = randomBytes(3 * 64 * 1024 + 3);
  let ticket;
  const api = createWeixinApi({
    fetchImpl: async (url, init) => {
      if (url.pathname.endsWith('/getuploadurl')) {
        ticket = JSON.parse(init.body);
        return jsonResponse({ ret: 0, upload_param: 'native-fetch-upload' });
      }
      if (url.pathname === '/c2c/upload') {
        return fetch(`http://127.0.0.1:${server.address().port}/upload`, init);
      }
      assert.equal(JSON.parse(init.body).msg.item_list[0].file_item.len, String(plaintext.length));
      return jsonResponse({ ret: 0 });
    },
  });
  await api.sendFile(weixinFileRequest({ file: { fileName: 'stream.zip', bytes: plaintext } }));
  assert.equal(Number(headers['content-length']), received.length);
  assert.equal(headers.authorization, undefined);
  assert.deepEqual(decryptWeixinImage(received, Buffer.from(ticket.aeskey, 'hex')), plaintext);
});

test('sendFile marks every ambiguous sendmessage result as uncertain', async (t) => {
  const cases = [
    {
      name: 'network failure',
      finalResponse: async () => { throw new TypeError('private socket detail'); },
    },
    {
      name: 'timeout',
      finalResponse: async () => {
        throw new WeixinApiError('timeout', 'private timeout detail');
      },
    },
    {
      name: 'invalid JSON',
      finalResponse: async () => new Response('{not-json', { status: 200 }),
    },
    {
      name: 'HTTP 5xx',
      finalResponse: async () => jsonResponse({ ret: -1 }, { status: 503 }),
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const api = createWeixinApi({
        fetchImpl: weixinFileFetch(scenario.finalResponse),
      });
      await assert.rejects(
        api.sendFile(weixinFileRequest()),
        (error) => error.code === 'artifact-delivery-uncertain'
          && !error.message.includes('private'),
      );
    });
  }
});

test('sendImage preserves the uncertain final-delivery boundary', async () => {
  const api = createWeixinApi({
    fetchImpl: weixinFileFetch(async () => { throw new TypeError('private socket detail'); }),
  });

  await assert.rejects(
    api.sendImage(weixinFileRequest({
      file: {
        artifactId: 'artifact-image-error',
        deliveryKey: 'session:turn:artifact-image-error',
        fileName: 'result.png',
        mediaType: 'image/png',
        bytes: Buffer.from('image-error-case'),
      },
    })),
    (error) => error.code === 'artifact-delivery-uncertain'
      && !error.message.includes('private'),
  );
});

test('sendFile maps definitive sendmessage rejection statuses without treating them as uncertain', async (t) => {
  const cases = [
    { name: 'permission', status: 403, code: 'artifact-permission-required' },
    { name: 'too large', status: 413, code: 'artifact-too-large' },
    { name: 'rate limited', status: 429, code: 'artifact-rate-limited' },
    { name: 'provider rejected', status: 400, code: 'artifact-provider-rejected' },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const api = createWeixinApi({
        fetchImpl: weixinFileFetch(async () => jsonResponse(
          { ret: scenario.status },
          { status: scenario.status },
        )),
      });
      await assert.rejects(
        api.sendFile(weixinFileRequest()),
        (error) => error.code === scenario.code,
      );
    });
  }

  const permissionApi = createWeixinApi({
    fetchImpl: weixinFileFetch(async () => jsonResponse({ ret: 403 })),
  });
  await assert.rejects(
    permissionApi.sendFile(weixinFileRequest()),
    (error) => error.code === 'artifact-permission-required'
      && error.providerCode === '403',
  );

  const api = createWeixinApi({
    fetchImpl: weixinFileFetch(async () => jsonResponse({ ret: -2001 })),
  });
  await assert.rejects(
    api.sendFile(weixinFileRequest()),
    (error) => error.code === 'artifact-provider-rejected'
      && error.providerCode === '-2001',
  );
});

test('sendFile preserves caller abort and never marks a pre-send preparation failure uncertain', async () => {
  let preparationCalls = 0;
  const preparationApi = createWeixinApi({
    fetchImpl: async () => {
      preparationCalls += 1;
      throw new TypeError('private upload preparation failure');
    },
  });
  await assert.rejects(
    preparationApi.sendFile(weixinFileRequest()),
    (error) => error.code === 'artifact-provider-failed'
      && error.code !== 'artifact-delivery-uncertain',
  );
  assert.equal(preparationCalls, 1);

  const controller = new AbortController();
  const reason = new Error('caller stopped the turn');
  const abortApi = createWeixinApi({
    fetchImpl: weixinFileFetch(async () => {
      controller.abort(reason);
      throw new DOMException('Aborted', 'AbortError');
    }),
  });
  await assert.rejects(
    abortApi.sendFile(weixinFileRequest({ signal: controller.signal })),
    (error) => error === reason && error.code !== 'artifact-delivery-uncertain',
  );
});

test('sendFile rejects a provider upload URL outside the canonical Weixin CDN', async () => {
  let calls = 0;
  const api = createWeixinApi({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({
        ret: 0,
        upload_full_url: 'https://attacker.example/c2c/upload?ticket=one',
      });
    },
  });
  await assert.rejects(
    api.sendFile({
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'host-only-token',
      toUserId: 'wx-user',
      file: { fileName: 'result.txt', bytes: Buffer.from('safe') },
    }),
    (error) => error instanceof WeixinApiError && error.code === 'untrusted-upload-url',
  );
  assert.equal(calls, 1);
});

test('getUpdates converts its own long-poll timeout into an empty successful poll', async () => {
  const api = createWeixinApi({
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }),
  });
  const result = await api.getUpdates({
    baseUrl: 'https://ilinkai.weixin.qq.com',
    token: 'token',
    getUpdatesBuf: 'cursor',
    timeoutMs: 2,
  });
  assert.deepEqual(result, { ret: 0, msgs: [], get_updates_buf: 'cursor' });
});

test('Weixin URL, inbound text, and reply chunk helpers enforce their narrow formats', () => {
  assert.equal(
    normalizeWeixinApiBaseUrl('https://ilinkai.weixin.qq.com/path'),
    'https://ilinkai.weixin.qq.com/path/',
  );
  assert.equal(
    normalizeWeixinApiBaseUrl('https://ilinkai.wechat.com/path'),
    'https://ilinkai.wechat.com/path/',
  );
  assert.throws(() => normalizeWeixinApiBaseUrl('https://ilinkai.weixin.qq.com:444/'));
  assert.throws(() => normalizeWeixinApiBaseUrl('https://ilinkai.wechat.com.attacker.test/'));
  assert.equal(extractWeixinText({ item_list: [{ type: 1, text_item: { text: ' 你好 ' } }] }), '你好');
  assert.equal(extractWeixinText({ item_list: [{ type: 3, voice_item: { text: '语音转写' } }] }), '语音转写');
  assert.deepEqual(splitWeixinText('abcdefgh', 5), ['abcde', 'fgh']);
});

test('Weixin extracts one-level ref_msg snapshots and attachment metadata', () => {
  assert.deepEqual(extractWeixinReplyReference({
    item_list: [{
      type: 1,
      text_item: { text: '继续分析' },
      ref_msg: {
        title: '文件摘要',
        message_item: {
          type: 4,
          msg_id: 'quoted-weixin-file',
          file_item: { file_name: '微信说明.docx' },
          ref_msg: {
            title: '不应递归展开',
            message_item: { type: 1, text_item: { text: '二级引用' } },
          },
        },
      },
    }],
  }), {
    messageId: 'quoted-weixin-file',
    content: '文件摘要',
    attachments: [{ kind: 'file', name: '微信说明.docx' }],
  });
});

test('Weixin reads quoted text by payload shape even when iLink labels it as type 8', () => {
  assert.deepEqual(extractWeixinReplyReference({
    item_list: [{
      ref_msg: {
        message_item: {
          type: 8,
          create_time_ms: 1_725_000_000_000,
          text_item: { text: '机器人原回复' },
        },
      },
    }],
  }), { content: '机器人原回复' });
});

test('Weixin resolves a type 8 metadata-only quote and otherwise marks it not delivered', () => {
  const callback = {
    item_list: [{
      ref_msg: {
        message_item: {
          type: 8,
          create_time_ms: '1725000000000',
          update_time_ms: '1725000000100',
        },
      },
    }],
  };
  let reference;
  assert.deepEqual(extractWeixinReplyReference(callback, {
    resolveContent: (value) => {
      reference = value;
      return '从最近出站索引恢复的原回复';
    },
  }), { content: '从最近出站索引恢复的原回复' });
  assert.deepEqual(reference, {
    messageId: null,
    createTimeMs: '1725000000000',
    updateTimeMs: '1725000000100',
  });
  assert.deepEqual(extractWeixinReplyReference(callback), {
    unavailableReason: 'not-delivered',
  });
});

test('Weixin decodes the timestamp carried by a real 64-bit iLink message id', () => {
  assert.equal(weixinMessageTimestampMs('7500581098742245128', {
    now: 1_788_278_900_000,
  }), 1_788_277_887_998);
  assert.equal(weixinMessageTimestampMs('quoted-command'), null);
  assert.equal(weixinMessageTimestampMs('99999999999999999999', {
    now: 1_788_278_900_000,
  }), null);
});
