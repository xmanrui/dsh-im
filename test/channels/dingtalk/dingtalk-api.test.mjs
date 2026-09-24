import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDingtalkApi,
  DINGTALK_AI_CARD_TEMPLATE_ID,
  DINGTALK_API_BASE_URL,
  DINGTALK_DONE_REACTION_NAME,
  DINGTALK_ERROR_REACTION_NAME,
  DINGTALK_THINKING_REACTION_NAME,
  DingtalkApiError,
  normalizeDingtalkCardMarkdown,
  normalizeDingtalkSessionWebhook,
  splitDingtalkText,
} from '../../../src/channels/dingtalk/dingtalk-api.mjs';

function jsonResponse(value, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('registration API performs init, begin, and poll with normalized results', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.toString(), options });
    if (url.pathname.endsWith('/init')) return jsonResponse({ errcode: 0, nonce: ' nonce-1 ' });
    if (url.pathname.endsWith('/begin')) {
      return jsonResponse({
        errcode: 0,
        device_code: ' device-1 ',
        user_code: 'user-1',
        verification_uri: 'https://h5.dingtalk.com/verify',
        verification_uri_complete: 'https://h5.dingtalk.com/verify?code=one',
        expires_in: 300,
        interval: 3,
      });
    }
    return jsonResponse({
      errcode: 0,
      status: 'success',
      client_id: 'ding-client',
      client_secret: 'host-only-secret',
    });
  };
  const api = createDingtalkApi({ fetchImpl, cardMinIntervalMs: 0, cardBackoffMs: 0 });

  const begun = await api.beginRegistration();
  const polled = await api.pollRegistration({ deviceCode: begun.deviceCode });

  assert.deepEqual(begun, {
    deviceCode: 'device-1',
    userCode: 'user-1',
    verificationUri: 'https://h5.dingtalk.com/verify',
    verificationUriComplete: 'https://h5.dingtalk.com/verify?code=one',
    expiresInSeconds: 300,
    intervalSeconds: 3,
  });
  assert.deepEqual(polled, {
    status: 'SUCCESS',
    failReason: undefined,
    clientId: 'ding-client',
    clientSecret: 'host-only-secret',
  });
  assert.deepEqual(calls.map(({ url, options }) => ({
    path: new URL(url).pathname,
    body: JSON.parse(options.body),
    redirect: options.redirect,
  })), [
    { path: '/app/registration/init', body: { source: 'DING_DWS_CLAW' }, redirect: 'error' },
    { path: '/app/registration/begin', body: { nonce: 'nonce-1' }, redirect: 'error' },
    { path: '/app/registration/poll', body: { device_code: 'device-1' }, redirect: 'error' },
  ]);
});

test('session replies use the fixed token endpoint, reject redirects, and cache access tokens', async () => {
  const calls = [];
  let now = 1_000;
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.toString(), options });
    if (url.toString() === `${DINGTALK_API_BASE_URL}v1.0/oauth2/accessToken`) {
      return jsonResponse({ accessToken: 'access-token', expireIn: 7_200 });
    }
    return jsonResponse({ errcode: 0 });
  };
  const api = createDingtalkApi({ fetchImpl, now: () => now });
  const request = {
    clientId: 'ding-client',
    clientSecret: 'host-only-secret',
    sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=opaque',
    text: '回答',
  };

  await api.sendText(request);
  now += 10_000;
  await api.sendText({ ...request, text: '继续' });

  assert.equal(calls.filter(({ url }) => url.includes('/oauth2/accessToken')).length, 1);
  assert.equal(calls.length, 3);
  for (const { options } of calls) assert.equal(options.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    appKey: 'ding-client',
    appSecret: 'host-only-secret',
  });
  assert.equal(calls[1].options.headers['x-acs-dingtalk-access-token'], 'access-token');
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    msgtype: 'text',
    text: { content: '继续' },
  });
});

test('session text replies include populated mention targets and omit empty mentions', async () => {
  const sent = [];
  const api = createDingtalkApi({
    fetchImpl: async (url, options) => {
      if (url.toString().includes('/oauth2/accessToken')) {
        return jsonResponse({ accessToken: 'access-token', expireIn: 7_200 });
      }
      sent.push(JSON.parse(options.body));
      return jsonResponse({ errcode: 0 });
    },
  });
  for (const at of [
    { atUserIds: ['staff-one'] },
    { atMobiles: ['13800000000'] },
    { isAtAll: true },
    {},
    { atUserIds: [], atMobiles: [], isAtAll: false },
  ]) {
    await api.sendText({
      clientId: 'ding-client',
      clientSecret: 'host-only-secret',
      sessionWebhook: 'https://oapi.dingtalk.com/robot/reply?ticket=mentions',
      text: '回答',
      at,
    });
  }
  assert.deepEqual(sent.map((body) => body.at), [
    { atUserIds: ['staff-one'] },
    { atMobiles: ['13800000000'] },
    { isAtAll: true },
    undefined,
    undefined,
  ]);
  for (const body of sent) assert.equal(body.text.content, '回答');
});

test('DingTalk sends proactive text through stable user and group robot endpoints', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.toString(), options });
    if (url.pathname.endsWith('/oauth2/accessToken')) {
      return jsonResponse({ accessToken: 'proactive-access-token', expireIn: 7_200 });
    }
    return jsonResponse({ processQueryKey: `query-${calls.length}` });
  };
  const api = createDingtalkApi({ fetchImpl });
  await api.sendRobotText({
    clientId: 'ding-proactive-client',
    clientSecret: 'host-only-secret',
    target: { type: 'user', robotCode: 'ding-proactive-client', userId: 'staff-one' },
    text: ' 用户主动消息\n',
  });
  await api.sendRobotText({
    clientId: 'ding-proactive-client',
    clientSecret: 'host-only-secret',
    target: {
      type: 'group',
      robotCode: 'ding-proactive-client',
      openConversationId: 'cid-one',
    },
    text: '群主动消息',
  });

  assert.equal(calls[1].url, `${DINGTALK_API_BASE_URL}v1.0/robot/oToMessages/batchSend`);
  assert.equal(calls[2].url, `${DINGTALK_API_BASE_URL}v1.0/robot/groupMessages/send`);
  assert.equal(calls[1].options.headers['x-acs-dingtalk-access-token'], 'proactive-access-token');
  assert.equal(calls[2].options.headers['x-acs-dingtalk-access-token'], 'proactive-access-token');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    robotCode: 'ding-proactive-client',
    msgKey: 'sampleText',
    msgParam: JSON.stringify({ content: ' 用户主动消息\n' }),
    userIds: ['staff-one'],
  });
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    robotCode: 'ding-proactive-client',
    msgKey: 'sampleText',
    msgParam: JSON.stringify({ content: '群主动消息' }),
    openConversationId: 'cid-one',
  });
  assert.doesNotMatch(JSON.stringify(calls.slice(1)), /sessionWebhook|sendBySession/);
});

test('DingTalk exposes a stable rejection code for rejected proactive text', async () => {
  const api = createDingtalkApi({
    fetchImpl: async (url) => url.pathname.endsWith('/oauth2/accessToken')
      ? jsonResponse({ accessToken: 'rejected-text-token', expireIn: 7_200 })
      : jsonResponse({ code: 'Forbidden.AccessDenied' }),
  });
  await assert.rejects(() => api.sendRobotText({
    clientId: 'ding-rejected-text-client',
    clientSecret: 'host-only-secret',
    target: { type: 'user', robotCode: 'ding-rejected-text-client', userId: 'staff-one' },
    text: '主动投递',
  }), (error) => {
    assert.equal(error.code, 'send-rejected');
    assert.equal(error.providerCode, 'Forbidden.AccessDenied');
    return true;
  });
});

test('DingTalk adds, recalls, and replaces its native status reactions', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.toString(), options });
    if (url.pathname.endsWith('/oauth2/accessToken')) {
      return jsonResponse({ accessToken: 'reaction-access-token', expireIn: 7_200 });
    }
    return jsonResponse({});
  };
  const api = createDingtalkApi({ fetchImpl });
  const request = {
    clientId: 'ding-client',
    clientSecret: 'host-only-secret',
    robotCode: 'robot-from-callback',
    messageId: 'open-message-one',
    conversationId: 'open-conversation-one',
  };

  await api.addReaction({ ...request, reactionName: DINGTALK_THINKING_REACTION_NAME });
  await api.recallReaction({ ...request, reactionName: DINGTALK_THINKING_REACTION_NAME });
  await api.addReaction({ ...request, reactionName: DINGTALK_DONE_REACTION_NAME });
  await api.addReaction({ ...request, reactionName: DINGTALK_ERROR_REACTION_NAME });

  assert.equal(calls.filter(({ url }) => url.includes('/oauth2/accessToken')).length, 1);
  assert.deepEqual(calls.slice(1).map(({ url, options }) => ({
    path: new URL(url).pathname,
    token: options.headers['x-acs-dingtalk-access-token'],
    body: JSON.parse(options.body),
  })), [
    ['reply', DINGTALK_THINKING_REACTION_NAME],
    ['recall', DINGTALK_THINKING_REACTION_NAME],
    ['reply', DINGTALK_DONE_REACTION_NAME],
    ['reply', DINGTALK_ERROR_REACTION_NAME],
  ].map(([action, reactionName]) => ({
    path: `/v1.0/robot/emotion/${action}`,
    token: 'reaction-access-token',
    body: {
      robotCode: 'robot-from-callback',
      openMsgId: 'open-message-one',
      openConversationId: 'open-conversation-one',
      emotionType: 2,
      emotionName: reactionName,
      textEmotion: {
        emotionId: '2659900',
        emotionName: reactionName,
        text: reactionName,
        backgroundId: 'im_bg_1',
      },
    },
  })));
});

test('DingTalk treats a success=false emotion response as rejected', async () => {
  const api = createDingtalkApi({
    fetchImpl: async (url) => url.pathname.endsWith('/oauth2/accessToken')
      ? jsonResponse({ accessToken: 'reaction-access-token', expireIn: 7_200 })
      : jsonResponse({ success: false, code: 'emotion_not_supported' }),
  });

  await assert.rejects(
    api.addReaction({
      clientId: 'ding-client',
      clientSecret: 'host-only-secret',
      robotCode: 'robot-from-callback',
      messageId: 'open-message-one',
      conversationId: 'open-conversation-one',
      reactionName: DINGTALK_DONE_REACTION_NAME,
    }),
    (error) => error instanceof DingtalkApiError
      && error.code === 'reaction-rejected'
      && error.providerCode === 'emotion_not_supported',
  );
});

test('cold reactions share their token request without delaying the normal reply token request', async () => {
  const firstToken = deferred();
  const calls = [];
  let tokenRequests = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.toString(), options });
    if (new URL(url).pathname.endsWith('/oauth2/accessToken')) {
      tokenRequests += 1;
      if (tokenRequests === 1) return firstToken.promise;
      return jsonResponse({ accessToken: 'normal-access-token', expireIn: 7_200 });
    }
    return jsonResponse({});
  };
  const api = createDingtalkApi({ fetchImpl });
  const reactions = Array.from({ length: 10 }, (_unused, index) => (
    api.addReaction({
      clientId: 'ding-client',
      clientSecret: 'host-only-secret',
      messageId: `open-message-${index + 1}`,
      conversationId: 'open-conversation-one',
      reactionName: DINGTALK_THINKING_REACTION_NAME,
    })
  ));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tokenRequests, 1, 'concurrent reactions must share their own cold token request');

  await api.sendText({
    clientId: 'ding-client',
    clientSecret: 'host-only-secret',
    sessionWebhook: 'https://oapi.dingtalk.com/robot/reply?ticket=normal',
    text: '正常回复',
  });
  assert.equal(tokenRequests, 2);

  firstToken.resolve(jsonResponse({ accessToken: 'reaction-access-token', expireIn: 7_200 }));
  await Promise.all(reactions);
  const normalSend = calls.find(({ url }) => url.includes('ticket=normal'));
  assert.equal(normalSend.options.headers['x-acs-dingtalk-access-token'], 'normal-access-token');
});

test('DingTalk uploads and sends a native file message to the exact robot conversation', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.toString(), options });
    if (url.pathname.endsWith('/oauth2/accessToken')) {
      return jsonResponse({ accessToken: 'file-access-token', expireIn: 7_200 });
    }
    if (url.pathname.endsWith('/media/upload')) {
      return jsonResponse({ errcode: 0, media_id: '@media-one', type: 'file' });
    }
    return jsonResponse({ processQueryKey: 'query-one' });
  };
  const api = createDingtalkApi({ fetchImpl });
  const response = await api.sendFile({
    clientId: 'ding-client',
    clientSecret: 'host-only-secret',
    target: {
      type: 'group',
      robotCode: 'robot-code',
      openConversationId: 'cid-one',
    },
    file: {
      fileName: 'result.pdf',
      mediaType: 'application/pdf',
      bytes: Buffer.from('dingtalk-result'),
    },
  });

  assert.equal(response.processQueryKey, 'query-one');
  const uploadUrl = new URL(calls[1].url);
  assert.equal(uploadUrl.origin, 'https://oapi.dingtalk.com');
  assert.equal(uploadUrl.pathname, '/media/upload');
  assert.equal(uploadUrl.searchParams.get('access_token'), 'file-access-token');
  assert.equal(uploadUrl.searchParams.get('type'), 'file');
  assert.ok(calls[1].options.body instanceof FormData);
  const media = calls[1].options.body.get('media');
  assert.equal(media.name, 'result.pdf');
  assert.equal(media.type, 'application/pdf');
  assert.equal(Buffer.from(await media.arrayBuffer()).toString(), 'dingtalk-result');
  assert.equal(calls[1].options.headers, undefined);

  assert.equal(
    calls[2].url,
    `${DINGTALK_API_BASE_URL}v1.0/robot/groupMessages/send`,
  );
  assert.equal(calls[2].options.headers['x-acs-dingtalk-access-token'], 'file-access-token');
  const sent = JSON.parse(calls[2].options.body);
  assert.deepEqual(sent, {
    robotCode: 'robot-code',
    msgKey: 'sampleFile',
    msgParam: JSON.stringify({
      mediaId: '@media-one',
      fileName: 'result.pdf',
      fileType: 'pdf',
    }),
    openConversationId: 'cid-one',
  });
});

test('DingTalk uploads and sends a native image message to the exact robot user', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.toString(), options });
    if (url.pathname.endsWith('/oauth2/accessToken')) {
      return jsonResponse({ accessToken: 'image-access-token', expireIn: 7_200 });
    }
    if (url.pathname.endsWith('/media/upload')) {
      return jsonResponse({ errcode: 0, media_id: '@image-one', type: 'image' });
    }
    return jsonResponse({ processQueryKey: 'image-query-one' });
  };
  const api = createDingtalkApi({ fetchImpl });
  const response = await api.sendImage({
    clientId: 'ding-client',
    clientSecret: 'host-only-secret',
    target: {
      type: 'user',
      robotCode: 'robot-code',
      userId: 'user-one',
    },
    file: {
      fileName: 'result.png',
      mediaType: 'image/png',
      bytes: Buffer.from('dingtalk-image'),
    },
  });

  assert.equal(response.processQueryKey, 'image-query-one');
  const uploadUrl = new URL(calls[1].url);
  assert.equal(uploadUrl.origin, 'https://oapi.dingtalk.com');
  assert.equal(uploadUrl.pathname, '/media/upload');
  assert.equal(uploadUrl.searchParams.get('access_token'), 'image-access-token');
  assert.equal(uploadUrl.searchParams.get('type'), 'image');
  const media = calls[1].options.body.get('media');
  assert.equal(media.name, 'result.png');
  assert.equal(media.type, 'image/png');
  assert.equal(Buffer.from(await media.arrayBuffer()).toString(), 'dingtalk-image');

  assert.equal(
    calls[2].url,
    `${DINGTALK_API_BASE_URL}v1.0/robot/oToMessages/batchSend`,
  );
  assert.equal(calls[2].options.headers['x-acs-dingtalk-access-token'], 'image-access-token');
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    robotCode: 'robot-code',
    msgKey: 'sampleImageMsg',
    msgParam: JSON.stringify({ photoURL: '@image-one' }),
    userIds: ['user-one'],
  });
});

function dingtalkFileRequest(overrides = {}) {
  return {
    clientId: 'ding-client',
    clientSecret: 'host-only-secret',
    target: {
      type: 'group',
      robotCode: 'robot-code',
      openConversationId: 'cid-error-case',
    },
    file: {
      fileName: 'result.pdf',
      mediaType: 'application/pdf',
      bytes: Buffer.from('dingtalk-error-case'),
    },
    ...overrides,
  };
}

function dingtalkFileFetch(finalResponse) {
  return async (url, options) => {
    if (url.pathname.endsWith('/oauth2/accessToken')) {
      return jsonResponse({ accessToken: 'file-access-token', expireIn: 7_200 });
    }
    if (url.pathname.endsWith('/media/upload')) {
      return jsonResponse({ errcode: 0, media_id: '@media-error-case', type: 'file' });
    }
    return finalResponse(url, options);
  };
}

test('DingTalk marks every ambiguous robot file send result as uncertain', async (t) => {
  const cases = [
    {
      name: 'network failure',
      finalResponse: async () => { throw new TypeError('private socket detail'); },
    },
    {
      name: 'timeout',
      finalResponse: async () => {
        throw new DingtalkApiError('timeout', 'private timeout detail');
      },
    },
    {
      name: 'invalid JSON',
      finalResponse: async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError('private invalid JSON detail'); },
      }),
    },
    {
      name: 'HTTP 5xx',
      finalResponse: async () => jsonResponse({ code: 'InternalError' }, { status: 503 }),
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const api = createDingtalkApi({
        fetchImpl: dingtalkFileFetch(scenario.finalResponse),
      });
      await assert.rejects(
        api.sendFile(dingtalkFileRequest()),
        (error) => error.code === 'artifact-delivery-uncertain'
          && !error.message.includes('private'),
      );
    });
  }
});

test('DingTalk keeps ambiguous native image sends in the uncertain bucket', async () => {
  const api = createDingtalkApi({
    fetchImpl: dingtalkFileFetch(async () => { throw new TypeError('private socket detail'); }),
  });

  await assert.rejects(
    api.sendImage(dingtalkFileRequest({
      file: {
        fileName: 'result.png',
        mediaType: 'image/png',
        bytes: Buffer.from('dingtalk-image-error'),
      },
    })),
    (error) => error.code === 'artifact-delivery-uncertain'
      && !error.message.includes('private'),
  );
});

test('DingTalk maps definitive robot file rejection statuses without treating them as uncertain', async (t) => {
  const cases = [
    { name: 'permission', status: 403, code: 'artifact-permission-required' },
    { name: 'too large', status: 413, code: 'artifact-too-large' },
    { name: 'rate limited', status: 429, code: 'artifact-rate-limited' },
    { name: 'provider rejected', status: 400, code: 'artifact-provider-rejected' },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const api = createDingtalkApi({
        fetchImpl: dingtalkFileFetch(async () => jsonResponse(
          { code: scenario.status },
          { status: scenario.status },
        )),
      });
      await assert.rejects(
        api.sendFile(dingtalkFileRequest()),
        (error) => error.code === scenario.code,
      );
    });
  }

  const permissionApi = createDingtalkApi({
    fetchImpl: dingtalkFileFetch(async () => jsonResponse({
      code: 'Forbidden.AccessDenied',
    })),
  });
  await assert.rejects(
    permissionApi.sendFile(dingtalkFileRequest()),
    (error) => error.code === 'artifact-permission-required'
      && error.providerCode === 'Forbidden.AccessDenied',
  );

  const rejectedApi = createDingtalkApi({
    fetchImpl: dingtalkFileFetch(async () => jsonResponse({ code: 'InvalidParameter' })),
  });
  await assert.rejects(
    rejectedApi.sendFile(dingtalkFileRequest()),
    (error) => error.code === 'artifact-provider-rejected'
      && error.providerCode === 'InvalidParameter',
  );
});

test('DingTalk preserves caller abort and never marks a pre-send upload failure uncertain', async () => {
  let uploadCalls = 0;
  const uploadApi = createDingtalkApi({
    fetchImpl: async (url) => {
      uploadCalls += 1;
      if (url.pathname.endsWith('/oauth2/accessToken')) {
        return jsonResponse({ accessToken: 'file-access-token', expireIn: 7_200 });
      }
      throw new TypeError('private upload transport failure');
    },
  });
  await assert.rejects(
    uploadApi.sendFile(dingtalkFileRequest()),
    (error) => error.code === 'artifact-provider-failed'
      && error.code !== 'artifact-delivery-uncertain',
  );
  assert.equal(uploadCalls, 2);

  const controller = new AbortController();
  const reason = new Error('caller stopped the turn');
  const abortApi = createDingtalkApi({
    fetchImpl: dingtalkFileFetch(async () => {
      controller.abort(reason);
      throw new DOMException('Aborted', 'AbortError');
    }),
  });
  await assert.rejects(
    abortApi.sendFile(dingtalkFileRequest({ signal: controller.signal })),
    (error) => error === reason && error.code !== 'artifact-delivery-uncertain',
  );
});

test('DingTalk lets the provider decide whether a robot file type is supported', async () => {
  let providerCalls = 0;
  const api = createDingtalkApi({
    fetchImpl: dingtalkFileFetch(async () => {
      providerCalls += 1;
      return jsonResponse({ code: 400 }, { status: 400 });
    }),
  });
  await assert.rejects(
    api.sendFile({
      clientId: 'ding-client',
      clientSecret: 'host-only-secret',
      target: { type: 'user', robotCode: 'robot-code', userId: 'user-one' },
      file: { fileName: 'result.html', bytes: Buffer.from('<h1>result</h1>') },
    }),
    (error) => error.code === 'artifact-provider-rejected',
  );
  assert.equal(providerCalls, 1);
});

test('DingTalk image downloads exchange downloadCode with the callback robotCode and do not forward auth', async () => {
  const imageBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x01, 0x02,
  ]);
  const calls = [];
  const fetchImpl = async (url, options) => {
    const href = url.toString();
    calls.push({ url: href, options });
    if (href === `${DINGTALK_API_BASE_URL}v1.0/oauth2/accessToken`) {
      return jsonResponse({ accessToken: 'image-access-token', expireIn: 7_200 });
    }
    if (href === `${DINGTALK_API_BASE_URL}v1.0/robot/messageFiles/download`) {
      return jsonResponse({ downloadUrl: 'https://download.oss-cn-hangzhou.aliyuncs.com/opaque-image' });
    }
    return new Response(imageBytes, {
      headers: { 'content-length': String(imageBytes.length) },
    });
  };
  const api = createDingtalkApi({ fetchImpl });

  const loaded = await api.downloadImage({
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    robotCode: 'robot-from-callback',
    downloadCode: 'opaque-download-code',
    maxBytes: 1_024,
  });

  assert.equal(loaded.equals(imageBytes), true);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    downloadCode: 'opaque-download-code',
    robotCode: 'robot-from-callback',
  });
  assert.equal(
    calls[1].options.headers['x-acs-dingtalk-access-token'],
    'image-access-token',
  );
  assert.equal(calls[2].options.method, 'GET');
  assert.equal(calls[2].options.redirect, 'manual');
  assert.equal(calls[2].options.headers?.['x-acs-dingtalk-access-token'], undefined);
});

test('DingTalk downloads ordinary files through the native downloadCode exchange without image limits', async () => {
  const fileBytes = Buffer.from('ordinary-dingtalk-file');
  const calls = [];
  const fetchImpl = async (url, options) => {
    const href = url.toString();
    calls.push({ url: href, options });
    if (href === `${DINGTALK_API_BASE_URL}v1.0/oauth2/accessToken`) {
      return jsonResponse({ accessToken: 'file-access-token', expireIn: 7_200 });
    }
    if (href === `${DINGTALK_API_BASE_URL}v1.0/robot/messageFiles/download`) {
      return jsonResponse({ downloadUrl: 'https://download.example.test/native-file' });
    }
    return new Response(fileBytes);
  };
  const api = createDingtalkApi({ fetchImpl });

  assert.deepEqual(await api.downloadFile({
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    robotCode: 'robot-from-callback',
    downloadCode: 'ordinary-file-code',
  }), fileBytes);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    downloadCode: 'ordinary-file-code',
    robotCode: 'robot-from-callback',
  });
  assert.equal(calls[1].options.headers['x-acs-dingtalk-access-token'], 'file-access-token');
  assert.equal(calls[2].options.method, 'GET');
  assert.equal(calls[2].options.redirect, 'follow');
  assert.equal(calls[2].options.headers, undefined);
});

test('DingTalk upgrades its HTTP temporary image URL to HTTPS without changing the signed request', async () => {
  const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.toString(), options });
    if (url.toString() === `${DINGTALK_API_BASE_URL}v1.0/oauth2/accessToken`) {
      return jsonResponse({ accessToken: 'image-access-token', expireIn: 7_200 });
    }
    if (url.toString() === `${DINGTALK_API_BASE_URL}v1.0/robot/messageFiles/download`) {
      return jsonResponse({
        downloadUrl: 'http://download.example.test:80/private/image?signature=opaque%2Bvalue',
      });
    }
    return new Response(imageBytes, { status: 200 });
  };
  const api = createDingtalkApi({ fetchImpl });

  assert.deepEqual(await api.downloadImage({
    clientId: 'ding-client',
    clientSecret: 'host-secret',
    robotCode: 'robot-from-callback',
    downloadCode: 'opaque-download-code',
    maxBytes: 1_024,
  }), imageBytes);

  assert.equal(
    calls[2].url,
    'https://download.example.test/private/image?signature=opaque%2Bvalue',
  );
  assert.equal(calls[2].options.headers?.['content-type'], undefined);
  assert.equal(calls[2].options.headers?.['x-acs-dingtalk-access-token'], undefined);
});

test('DingTalk image exchange errors preserve the provider code without exposing its message', async () => {
  const fetchImpl = async (url) => {
    if (url.toString() === `${DINGTALK_API_BASE_URL}v1.0/oauth2/accessToken`) {
      return jsonResponse({ accessToken: 'image-access-token', expireIn: 7_200 });
    }
    return jsonResponse({
      code: 'invalidParameter.robotCode.auth',
      message: 'response may contain platform details',
    }, { status: 400 });
  };
  const api = createDingtalkApi({ fetchImpl });

  await assert.rejects(
    api.downloadImage({
      clientId: 'ding-client',
      clientSecret: 'host-secret',
      robotCode: 'robot-from-callback',
      downloadCode: 'opaque-download-code',
      maxBytes: 1_024,
    }),
    (error) => {
      assert.equal(error.code, 'image-download-address-failed');
      assert.equal(error.status, 400);
      assert.equal(error.providerCode, 'invalidParameter.robotCode.auth');
      assert.equal(error.cause?.code, 'http-error');
      assert.doesNotMatch(error.message, /platform details/);
      return true;
    },
  );
});

test('DingTalk image content failures do not expose network or signed-URL details', async () => {
  const fetchImpl = async (url) => {
    if (url.toString() === `${DINGTALK_API_BASE_URL}v1.0/oauth2/accessToken`) {
      return jsonResponse({ accessToken: 'image-access-token', expireIn: 7_200 });
    }
    if (url.toString() === `${DINGTALK_API_BASE_URL}v1.0/robot/messageFiles/download`) {
      return jsonResponse({ downloadUrl: 'https://download.example.test/private?signature=hidden' });
    }
    const cause = new Error('socket details must stay private');
    cause.code = 'ECONNRESET';
    throw new TypeError('fetch failed', { cause });
  };
  const api = createDingtalkApi({ fetchImpl });

  await assert.rejects(
    api.downloadImage({
      clientId: 'ding-client',
      clientSecret: 'host-secret',
      robotCode: 'robot-from-callback',
      downloadCode: 'opaque-download-code',
      maxBytes: 1_024,
    }),
    (error) => {
      assert.equal(error.code, 'image-content-download-failed');
      assert.equal(error.providerCode, undefined);
      assert.equal(error.cause?.cause?.code, 'ECONNRESET');
      assert.doesNotMatch(error.message, /private|signature|socket details|hidden/);
      return true;
    },
  );
});

test('session webhook validation accepts only HTTPS DingTalk hosts on the default port', () => {
  assert.equal(
    normalizeDingtalkSessionWebhook('https://dingtalk.com/reply?ticket=one'),
    'https://dingtalk.com/reply?ticket=one',
  );
  assert.equal(
    normalizeDingtalkSessionWebhook('https://oapi.dingtalk.com:443/reply?ticket=one'),
    'https://oapi.dingtalk.com/reply?ticket=one',
  );
  for (const value of [
    'http://oapi.dingtalk.com/reply',
    'https://oapi.dingtalk.com.evil.example/reply',
    'https://user@oapi.dingtalk.com/reply',
    'https://oapi.dingtalk.com:8443/reply',
  ]) {
    assert.throws(() => normalizeDingtalkSessionWebhook(value), /不受信任/);
  }
});

test('AI Card replies create-and-deliver, stream full snapshots, and finalize on fixed endpoints', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.toString(), options });
    if (url.toString() === `${DINGTALK_API_BASE_URL}v1.0/oauth2/accessToken`) {
      return jsonResponse({ accessToken: 'access-token', expireIn: 7_200 });
    }
    return jsonResponse({});
  };
  const api = createDingtalkApi({ fetchImpl, cardMinIntervalMs: 0, cardBackoffMs: 0 });
  const credentials = { clientId: 'ding-client', clientSecret: 'host-only-secret' };
  const card = await api.createAiCard({
    ...credentials,
    target: { type: 'user', userId: 'staff-one' },
    initialText: '正在处理…',
  });
  await api.updateAiCard({ ...credentials, ...card, text: '第一行\n第二行' });
  await api.finishAiCard({ ...credentials, ...card, text: '最终回答' });

  const cardCalls = calls.slice(1).map(({ url, options }) => ({
    method: options.method,
    path: new URL(url).pathname,
    body: JSON.parse(options.body),
    token: options.headers['x-acs-dingtalk-access-token'],
    redirect: options.redirect,
  }));
  // The final frame closes streaming; the instance update persists the
  // answer in the shared template's msgContent slot and marks it finished.
  assert.deepEqual(cardCalls.map(({ method, path }) => ({ method, path })), [
    { method: 'POST', path: '/v1.0/card/instances/createAndDeliver' },
    { method: 'PUT', path: '/v1.0/card/streaming' },
    { method: 'PUT', path: '/v1.0/card/streaming' },
    { method: 'PUT', path: '/v1.0/card/streaming' },
    { method: 'PUT', path: '/v1.0/card/instances' },
  ]);
  assert.ok(cardCalls.every(({ token, redirect }) => token === 'access-token' && redirect === 'error'));
  assert.equal(cardCalls[0].body.cardTemplateId, DINGTALK_AI_CARD_TEMPLATE_ID);
  assert.equal(cardCalls[0].body.outTrackId, card.cardInstanceId);
  assert.equal(cardCalls[0].body.openSpaceId, 'dtv1.card//IM_ROBOT.staff-one');
  assert.equal(cardCalls[0].body.imRobotOpenDeliverModel.robotCode, 'ding-client');
  assert.equal(cardCalls[0].body.cardData.cardParamMap.flowStatus, '2');
  assert.equal(cardCalls[0].body.cardData.cardParamMap.msgContent, '正在处理…');
  assert.equal(cardCalls[0].body.cardData.cardParamMap.staticMsgContent, '');
  assert.equal(cardCalls[1].body.content, '正在处理…');
  assert.equal(cardCalls[2].body.content, '第一行<br>第二行');
  assert.equal(cardCalls[2].body.isFull, true);
  assert.equal(cardCalls[2].body.isFinalize, false);
  assert.equal(cardCalls[3].body.content, '最终回答');
  assert.equal(cardCalls[3].body.isFinalize, true);
  assert.deepEqual(cardCalls[4].body, {
    outTrackId: card.cardInstanceId,
    cardData: {
      cardParamMap: {
        flowStatus: '3',
        msgContent: '最终回答',
        staticMsgContent: '',
        sys_full_json_obj: JSON.stringify({ order: ['msgContent'] }),
        config: JSON.stringify({ autoLayout: true }),
      },
    },
    cardUpdateOptions: { updateCardDataByKey: true },
  });
});

test('AI Cards keep native group mentions through every frame and leave private replies unchanged', async (t) => {
  const unsafeUserId = "staff&<>\"'";
  const unsafeName = "提问者&<>\"'";
  for (const scenario of [
    {
      name: 'group with sender mention',
      target: {
        type: 'group',
        openConversationId: 'group-one',
        atUserIds: { 'staff-one': '提问者' },
      },
      delivery: {
        openSpaceId: 'dtv1.card//IM_GROUP.group-one',
        imGroupOpenDeliverModel: {
          robotCode: 'ding-client',
          atUserIds: { 'staff-one': '提问者' },
        },
      },
      cardAtUserIds: ['staff-one'],
      mentionPrefix: '<a atId="staff-one">提问者</a>\n\n',
    },
    {
      name: 'mention IDs and names cannot inject HTML',
      target: {
        type: 'group',
        openConversationId: 'group-one',
        atUserIds: { [unsafeUserId]: unsafeName },
      },
      delivery: {
        openSpaceId: 'dtv1.card//IM_GROUP.group-one',
        imGroupOpenDeliverModel: {
          robotCode: 'ding-client',
          atUserIds: { [unsafeUserId]: unsafeName },
        },
      },
      cardAtUserIds: [unsafeUserId],
      mentionPrefix: '<a atId="staff&amp;&lt;&gt;&quot;&#39;">提问者&amp;&lt;&gt;&quot;&#39;</a>\n\n',
    },
    {
      name: 'group without mentions',
      target: { type: 'group', openConversationId: 'group-one' },
      delivery: {
        openSpaceId: 'dtv1.card//IM_GROUP.group-one',
        imGroupOpenDeliverModel: { robotCode: 'ding-client' },
      },
    },
    {
      name: 'private reply ignores mentions',
      target: { type: 'user', userId: 'staff-one', atUserIds: { 'staff-one': '提问者' } },
      delivery: {
        openSpaceId: 'dtv1.card//IM_ROBOT.staff-one',
        imRobotOpenDeliverModel: {
          spaceType: 'IM_ROBOT',
          robotCode: 'ding-client',
          extension: { dynamicSummary: 'true' },
        },
      },
    },
  ]) {
    await t.test(scenario.name, async () => {
      const calls = [];
      const api = createDingtalkApi({
        fetchImpl: async (url, options) => {
          if (url.pathname.endsWith('/oauth2/accessToken')) {
            return jsonResponse({ accessToken: 'access-token', expireIn: 7_200 });
          }
          calls.push({ path: url.pathname, method: options.method, body: JSON.parse(options.body) });
          return jsonResponse({});
        },
        cardMinIntervalMs: 0,
        cardBackoffMs: 0,
      });

      const request = {
        clientId: 'ding-client',
        clientSecret: 'host-only-secret',
        target: scenario.target,
      };
      const card = await api.createAiCard({ ...request, initialText: '正在处理…' });
      await api.updateAiCard({ ...request, ...card, text: '第一行\n第二行' });
      await api.finishAiCard({ ...request, ...card, text: '最终回答' });
      await api.failAiCard({ ...request, ...card, text: '处理失败' });

      assert.deepEqual(calls[0].body.cardAtUserIds, scenario.cardAtUserIds);
      if (!scenario.cardAtUserIds) {
        assert.equal(Object.hasOwn(calls[0].body, 'cardAtUserIds'), false);
      }
      const deliveries = calls
        .filter(({ path }) => path.endsWith('/instances/createAndDeliver'))
        .map(({ body }) => body);
      assert.deepEqual(deliveries.map(({ outTrackId, userIdType, openSpaceId, imGroupOpenDeliverModel, imRobotOpenDeliverModel }) => ({
        outTrackId,
        userIdType,
        openSpaceId,
        ...(imGroupOpenDeliverModel ? { imGroupOpenDeliverModel } : {}),
        ...(imRobotOpenDeliverModel ? { imRobotOpenDeliverModel } : {}),
      })), [{
        outTrackId: card.cardInstanceId,
        userIdType: 1,
        ...scenario.delivery,
      }]);
      const mention = scenario.mentionPrefix ?? '';
      const frames = calls.filter(({ path }) => path.endsWith('/streaming')).map(({ body }) => body);
      assert.deepEqual(frames.map(({ content, isFinalize, isError }) => ({ content, isFinalize, isError })), [
        { content: mention + '正在处理…', isFinalize: false, isError: false },
        { content: mention + '第一行<br>第二行', isFinalize: false, isError: false },
        { content: mention + '最终回答', isFinalize: true, isError: false },
        { content: mention + '处理失败', isFinalize: false, isError: true },
      ]);
      const states = calls
        .filter(({ path, method }) => path.endsWith('/instances') && method === 'PUT')
        .map(({ body }) => body.cardData.cardParamMap);
      assert.deepEqual(states.map(({ flowStatus, msgContent, staticMsgContent }) => ({
        flowStatus,
        msgContent,
        staticMsgContent,
      })), [
        { flowStatus: '3', msgContent: mention + '最终回答', staticMsgContent: '' },
        { flowStatus: '5', msgContent: mention + '处理失败', staticMsgContent: '' },
      ]);
      for (const state of states) {
        assert.deepEqual(JSON.parse(state.sys_full_json_obj).order, ['msgContent']);
      }
    });
  }
});

test('AI Card markdown preserves fenced code while rendering ordinary line breaks', () => {
  assert.equal(normalizeDingtalkCardMarkdown('一\n二'), '一<br>二');
  assert.equal(
    normalizeDingtalkCardMarkdown('```js\nconst answer = 42\n```\n完成'),
    '```js\nconst answer = 42\n```\n完成',
  );
});

test('AI Card start slots preserve 20 QPS without blocking cleanup behind slow HTTP', async () => {
  const firstUpdate = deferred();
  const bodies = [];
  const waits = [];
  let now = 0;
  const fetchImpl = async (url, options) => {
    if (url.toString() === `${DINGTALK_API_BASE_URL}v1.0/oauth2/accessToken`) {
      return jsonResponse({ accessToken: 'access-token', expireIn: 7_200 });
    }
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (new URL(url).pathname === '/v1.0/card/streaming' && body.isError === false) {
      await firstUpdate.promise;
    }
    return jsonResponse({});
  };
  const api = createDingtalkApi({
    fetchImpl,
    now: () => now,
    cardMinIntervalMs: 50,
    delay: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });
  const request = {
    clientId: 'ding-client',
    clientSecret: 'host-only-secret',
    cardInstanceId: 'card-one',
  };

  const slowUpdate = api.updateAiCard({ ...request, text: '仍在请求中' });
  await new Promise((resolve) => setImmediate(resolve));
  await api.failAiCard({ ...request, text: '及时收口' });

  assert.equal(bodies.some((body) => body.isError === true), true);
  assert.equal(bodies.some((body) => body.cardData?.cardParamMap?.flowStatus === '5'), true);
  assert.equal(bodies.find((body) => body.isError === true).content, '及时收口');
  const failedState = bodies.find((body) => body.cardData?.cardParamMap?.flowStatus === '5');
  assert.equal(failedState.cardData.cardParamMap.msgContent, '及时收口');
  assert.deepEqual(waits, [50, 50]);
  firstUpdate.resolve();
  await slowUpdate;
});

test('AI Card retries one QPS rejection after the configured backoff', async () => {
  let attempts = 0;
  const waits = [];
  const fetchImpl = async (url) => {
    if (url.toString() === `${DINGTALK_API_BASE_URL}v1.0/oauth2/accessToken`) {
      return jsonResponse({ accessToken: 'access-token', expireIn: 7_200 });
    }
    attempts += 1;
    return attempts === 1 ? jsonResponse({}, { status: 403 }) : jsonResponse({});
  };
  const api = createDingtalkApi({
    fetchImpl,
    cardMinIntervalMs: 0,
    cardBackoffMs: 1_000,
    delay: async (ms) => waits.push(ms),
  });

  await api.updateAiCard({
    clientId: 'ding-client',
    clientSecret: 'host-only-secret',
    cardInstanceId: 'card-one',
    text: '重试内容',
  });

  assert.equal(attempts, 2);
  assert.deepEqual(waits, [1_000]);
});

test('AI Card final-frame failure propagates before publishing a finished instance', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.toString(), options });
    if (url.toString() === `${DINGTALK_API_BASE_URL}v1.0/oauth2/accessToken`) {
      return jsonResponse({ accessToken: 'access-token', expireIn: 7_200 });
    }
    if (new URL(url).pathname === '/v1.0/card/streaming') {
      return jsonResponse({}, { status: 500 });
    }
    return jsonResponse({});
  };
  const api = createDingtalkApi({ fetchImpl, cardMinIntervalMs: 0, cardBackoffMs: 0 });
  const request = {
    clientId: 'ding-client',
    clientSecret: 'host-only-secret',
    cardInstanceId: 'card-one',
  };

  await assert.rejects(api.finishAiCard({ ...request, text: '最终答案' }));

  const cardBodies = calls
    .filter(({ url }) => new URL(url).pathname.startsWith('/v1.0/card/'))
    .map(({ options }) => JSON.parse(options.body));
  assert.equal(cardBodies.length, 1);
  assert.equal(cardBodies[0].isFinalize, true);
  assert.equal(cardBodies[0].content, '最终答案');

  await api.failAiCard({ ...request, text: '处理失败' });
  const afterFailure = calls
    .filter(({ url }) => new URL(url).pathname.startsWith('/v1.0/card/'))
    .map(({ options }) => JSON.parse(options.body));
  assert.equal(afterFailure.some((body) => body.isError === true), true);
  assert.equal(afterFailure.some((body) => body.cardData?.cardParamMap?.flowStatus === '5'), true);
});

test('AI Card rejects an unpersisted finished state so the bridge can deliver text instead', async () => {
  const calls = [];
  const api = createDingtalkApi({
    cardMinIntervalMs: 0,
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      if (path === '/v1.0/oauth2/accessToken') {
        return jsonResponse({ accessToken: 'access-token', expireIn: 7_200 });
      }
      const body = JSON.parse(options.body);
      calls.push({ path, body });
      return jsonResponse({}, { status: path === '/v1.0/card/instances' ? 500 : 200 });
    },
  });

  await assert.rejects(api.finishAiCard({
    clientId: 'ding-client',
    clientSecret: 'host-only-secret',
    cardInstanceId: 'card-one',
    text: '最终答案',
  }), { code: 'http-error', status: 500 });

  assert.deepEqual(calls.map(({ path }) => path), ['/v1.0/card/streaming', '/v1.0/card/instances']);
  assert.equal(calls[0].body.isFinalize, true);
  assert.equal(calls[1].body.cardData.cardParamMap.flowStatus, '3');
  assert.equal(calls[1].body.cardData.cardParamMap.msgContent, '最终答案');
});

test('AI Card creation cleanup preserves group mentions with an independent signal after abort', async () => {
  const controller = new AbortController();
  const bodies = [];
  const fetchImpl = async (url, options) => {
    if (url.toString() === `${DINGTALK_API_BASE_URL}v1.0/oauth2/accessToken`) {
      return jsonResponse({ accessToken: 'access-token', expireIn: 7_200 });
    }
    const body = JSON.parse(options.body);
    bodies.push(body);
    // Let createAndDeliver succeed (the card is now live), then abort on the
    // startup streaming PUT that follows it, so cleanup runs against an
    // already-delivered card instead of short-circuiting before delivery.
    if (new URL(url).pathname === '/v1.0/card/streaming' && body.isError !== true) {
      controller.abort(new DOMException('stopped', 'AbortError'));
      throw controller.signal.reason;
    }
    return jsonResponse({});
  };
  const api = createDingtalkApi({ fetchImpl, cardMinIntervalMs: 0, cardBackoffMs: 0 });

  await assert.rejects(api.createAiCard({
    clientId: 'ding-client',
    clientSecret: 'host-only-secret',
    target: {
      type: 'group',
      openConversationId: 'group-one',
      atUserIds: { 'staff-one': '提问者' },
    },
    initialText: '正在处理',
    signal: controller.signal,
  }), { name: 'AbortError' });

  assert.equal(bodies.some((body) => body.isError === true), true);
  assert.equal(bodies.some((body) => body.cardData?.cardParamMap?.flowStatus === '5'), true);
  assert.equal(bodies.some((body) => (
    body.isError === true
      && body.content === '<a atId="staff-one">提问者</a>\n\n卡片已结束，请查看后续消息。'
  )), true);
  const failedState = bodies.find((body) => body.cardData?.cardParamMap?.flowStatus === '5');
  assert.equal(failedState.cardData.cardParamMap.msgContent,
    '<a atId="staff-one">提问者</a>\n\n卡片已结束，请查看后续消息。');
  assert.equal(JSON.stringify(bodies).includes('消息处理失败，请稍后重试。'), false);
});

test('text splitting prefers line boundaries and never produces oversized chunks', () => {
  const chunks = splitDingtalkText('第一段\n第二段很长\n第三段', 8);
  assert.equal(chunks.join('').replaceAll('\n', ''), '第一段第二段很长第三段');
  assert.ok(chunks.every((chunk) => chunk.length <= 8));
});
