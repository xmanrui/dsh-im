import test from 'node:test';
import assert from 'node:assert/strict';
import { VerifiedFeishuChannel } from '../../../src/channels/feishu/feishu-channel.mjs';

function fakeClient(overrides = {}) {
  const calls = {
    cards: [],
    messages: [],
    replies: [],
    updates: [],
    settings: [],
    recalls: [],
    reactionsAdded: [],
    reactionsRemoved: [],
    fileUploads: [],
    imageUploads: [],
  };
  const client = {
    cardkit: { v1: {
      card: {
        create: async (request) => {
          calls.cards.push(request);
          const cardId = calls.cards.length === 1 ? 'card-test' : `card-test-${calls.cards.length}`;
          return { code: 0, data: { card_id: cardId } };
        },
        settings: async (request) => {
          calls.settings.push(request);
          return { code: 0 };
        },
      },
      cardElement: {
        content: async (request) => {
          calls.updates.push(request);
          return { code: 0 };
        },
      },
    } },
    im: { v1: {
      file: {
        create: async (request) => {
          calls.fileUploads.push(request);
          return { file_key: 'file-key-test' };
        },
      },
      image: {
        create: async (request) => {
          calls.imageUploads.push(request);
          return { data: { image_key: 'image-key-test' } };
        },
      },
      message: {
        reply: async (request) => {
          calls.replies.push(request);
          const messageId = calls.replies.length === 1 ? 'om-stream' : `om-stream-${calls.replies.length}`;
          return { code: 0, data: { message_id: messageId } };
        },
        create: async (request) => {
          calls.messages.push(request);
          const messageId = calls.messages.length === 1 ? 'om-stream' : `om-stream-${calls.messages.length}`;
          return { code: 0, data: { message_id: messageId } };
        },
        delete: async (request) => {
          calls.recalls.push(request);
          return { code: 0 };
        },
      },
      messageReaction: {
        create: async (request) => {
          calls.reactionsAdded.push(request);
          return { code: 0, data: { reaction_id: 'reaction-test' } };
        },
        delete: async (request) => {
          calls.reactionsRemoved.push(request);
          return { code: 0 };
        },
      },
    } },
  };

  if (overrides.updateContent) client.cardkit.v1.cardElement.content = overrides.updateContent;
  if (overrides.finishCard) client.cardkit.v1.card.settings = overrides.finishCard;
  if (overrides.uploadFile) client.im.v1.file.create = overrides.uploadFile;
  if (overrides.uploadImage) client.im.v1.image.create = overrides.uploadImage;
  if (overrides.replyMessage) client.im.v1.message.reply = overrides.replyMessage;
  if (overrides.createMessage) client.im.v1.message.create = overrides.createMessage;
  return { client, calls };
}

function finalCardContents(calls) {
  return calls.cards.map((request, index) => {
    const cardId = index === 0 ? 'card-test' : `card-test-${index + 1}`;
    return calls.updates.findLast((update) => update.path.card_id === cardId)?.data.content
      ?? JSON.parse(request.data.data).body.elements[0].content;
  });
}

test('VerifiedFeishuChannel streams content and verifies terminal settings', async () => {
  const { client, calls } = fakeClient();
  const channel = new VerifiedFeishuChannel({ client, initialText: '正在思考…' });

  const result = await channel.stream('oc_chat', {
    markdown: async (controller) => {
      await controller.setContent('第一段');
      await controller.setContent('第一段和第二段');
    },
  }, { replyTo: 'om_user' });

  assert.deepEqual(result, { messageId: 'om-stream', providerMessageIds: ['om-stream'] });
  assert.equal(calls.replies[0].path.message_id, 'om_user');
  assert.deepEqual(calls.updates.map((call) => ({
    content: call.data.content,
    sequence: call.data.sequence,
  })), [
    { content: '第一段', sequence: 1 },
    { content: '第一段和第二段', sequence: 2 },
  ]);
  assert.equal(calls.settings[0].data.sequence, 3);
  assert.deepEqual(JSON.parse(calls.settings[0].data.settings), {
    config: {
      streaming_mode: false,
      summary: { content: '第一段和第二段' },
    },
  });
  assert.equal(calls.recalls.length, 0);
});

test('VerifiedFeishuChannel previews long snapshots and delivers the entire final answer in cards', async () => {
  const { client, calls } = fakeClient();
  const channel = new VerifiedFeishuChannel({ client });
  const answer = `${'A'.repeat(28000)}\n\n  ${'中'.repeat(28000)}😀\n尾声  `;

  const result = await channel.stream('oc_chat', {
    markdown: async (controller) => {
      await controller.setContent(answer.slice(0, 28001));
      const preview = calls.updates.at(-1).data.content;
      assert.ok(preview.length <= 28000);
      assert.match(preview, /生成完成后将分段发送完整回答/);
      const updateCount = calls.updates.length;
      await controller.setContent(answer);
      assert.equal(calls.updates.length, updateCount, 'unchanged previews need no provider update');
      assert.equal(calls.cards.length, 1, 'only the final snapshot is split into permanent cards');
    },
  }, { replyTo: 'om_user' });

  const contents = finalCardContents(calls);
  assert.equal(contents.join(''), answer, 'preserve the latest tail, newlines, and whitespace');
  assert.ok(contents.every((content) => content.length <= 28000 && content.isWellFormed()));
  assert.ok(calls.updates.every(({ data }) => data.content.length <= 28000));
  assert.equal(result.providerMessageIds.length, contents.length);
  assert.deepEqual(result.providerMessageIds, ['om-stream', 'om-stream-2', 'om-stream-3']);
  assert.ok(calls.replies.every(({ path }) => path.message_id === 'om_user'));
  assert.equal(calls.settings.length, contents.length);
  assert.ok(calls.settings.every(({ data }) => (
    JSON.parse(data.settings).config.streaming_mode === false
  )));
  assert.equal(calls.recalls.length, 0);
});

test('VerifiedFeishuChannel handles exact limits and Unicode without a reply target', async (t) => {
  const previewLimit = 28000 - '\n\n内容较长，生成完成后将分段发送完整回答。'.length;
  for (const answer of [
    'a'.repeat(27999),
    'a'.repeat(28000),
    'a'.repeat(28001),
    `${'中'.repeat(27999)}😀尾声`,
    `${'a'.repeat(20000)}\n\n${'b'.repeat(12000)}`,
    `${'a'.repeat(48)}😀${'b'.repeat(30000)}`,
    `${'a'.repeat(previewLimit - 1)}😀${'b'.repeat(100)}`,
  ]) {
    await t.test(`${answer.length} UTF-16 units`, async () => {
      const { client, calls } = fakeClient();
      const channel = new VerifiedFeishuChannel({ client });
      const result = await channel.stream('oc_chat', {
        markdown: async (controller) => controller.setContent(answer),
      });

      const contents = finalCardContents(calls);
      assert.equal(contents.join(''), answer);
      assert.ok(contents.every((content) => content.length <= 28000 && content.isWellFormed()));
      assert.ok(calls.updates.every(({ data }) => (
        data.content.length <= 28000 && data.content.isWellFormed()
      )));
      assert.ok(calls.settings.every(({ data }) => (
        JSON.parse(data.settings).config.summary.content.isWellFormed()
      )));
      assert.equal(contents.length, answer.length <= 28000 ? 1 : 2);
      assert.equal(result.providerMessageIds.length, contents.length);
      assert.ok(calls.messages.every(({ params, data }) => (
        params.receive_id_type === 'chat_id' && data.receive_id === 'oc_chat'
      )));
      assert.equal(calls.replies.length, 0);
      assert.equal(calls.recalls.length, 0);
    });
  }
});

test('VerifiedFeishuChannel replaces oversized progress with a shorter final answer', async () => {
  const { client, calls } = fakeClient();
  const channel = new VerifiedFeishuChannel({ client });

  await channel.stream('oc_chat', {
    markdown: async (controller) => {
      await controller.setContent('中间过程'.repeat(10000));
      await controller.setContent('最终回答');
    },
  }, { replyTo: 'om_user' });

  assert.deepEqual(finalCardContents(calls), ['最终回答']);
  assert.equal(calls.replies.length, 1);
  assert.equal(calls.recalls.length, 0);
});

test('VerifiedFeishuChannel finishes an empty producer and skips duplicate content updates', async () => {
  const { client, calls } = fakeClient();
  const channel = new VerifiedFeishuChannel({ client, initialText: '' });

  await channel.stream('oc_chat', {
    markdown: async (controller) => {
      await controller.setContent(null);
      await controller.setContent('');
    },
  });

  assert.deepEqual(finalCardContents(calls), ['…']);
  assert.equal(calls.updates.length, 0);
  assert.equal(calls.settings.length, 1);
});

test('VerifiedFeishuChannel cleans up every split card on a real provider failure for text fallback', async () => {
  const { client, calls } = fakeClient({
    updateContent: async (request) => {
      calls.updates.push(request);
      return request.path.card_id === 'card-test-3'
        ? { code: 230099, msg: 'element update failed' }
        : { code: 0 };
    },
  });
  const channel = new VerifiedFeishuChannel({ client });

  await assert.rejects(channel.stream('oc_chat', {
    markdown: async (controller) => controller.setContent('a'.repeat(56001)),
  }, { replyTo: 'om_user' }), /cardElement\.content failed/);

  assert.equal(calls.settings.length, 2);
  assert.deepEqual(calls.recalls.map(({ path }) => path.message_id), [
    'om-stream', 'om-stream-2', 'om-stream-3',
  ]);
});

test('VerifiedFeishuChannel rejects failed updates and recalls the partial card', async () => {
  const { client, calls } = fakeClient({
    updateContent: async () => ({ code: 230099, msg: 'element update failed' }),
  });
  const channel = new VerifiedFeishuChannel({ client });

  await assert.rejects(channel.stream('oc_chat', {
    markdown: async (controller) => controller.setContent('最终回答'),
  }, { replyTo: 'om_user' }), /cardElement\.content failed/);

  assert.deepEqual(calls.recalls, [{ path: { message_id: 'om-stream' } }]);
  assert.equal(calls.settings.length, 0);
});

test('VerifiedFeishuChannel rejects failed finalization and recalls the card', async () => {
  const { client, calls } = fakeClient({
    finishCard: async (request) => {
      calls.settings.push(request);
      return { code: 230099, msg: 'card finalization failed' };
    },
  });
  const channel = new VerifiedFeishuChannel({ client });

  await assert.rejects(channel.stream('oc_chat', {
    markdown: async (controller) => controller.setContent('已经生成的回答'),
  }, { replyTo: 'om_user' }), /card\.settings failed/);

  assert.deepEqual(calls.recalls, [{ path: { message_id: 'om-stream' } }]);
  assert.equal(calls.settings.length, 1);
});

test('VerifiedFeishuChannel checks reaction API results', async () => {
  const { client, calls } = fakeClient();
  const channel = new VerifiedFeishuChannel({ client });

  const reactionId = await channel.addReaction('om_user', 'OnIt');
  await channel.removeReaction('om_user', reactionId);

  assert.equal(reactionId, 'reaction-test');
  assert.equal(calls.reactionsAdded[0].data.reaction_type.emoji_type, 'OnIt');
  assert.equal(calls.reactionsRemoved[0].path.reaction_id, 'reaction-test');
});

test('VerifiedFeishuChannel uploads a materialized result and replies with a native file message', async () => {
  const { client, calls } = fakeClient();
  const channel = new VerifiedFeishuChannel({ client });
  const file = {
    artifactId: 'artifact-html',
    deliveryKey: 'delivery-html',
    fileName: 'result.html',
    mediaType: 'text/html',
    size: 19,
    bytes: Buffer.from('<h1>result</h1>'),
  };

  const receipt = await channel.sendFile('oc_chat', file, { replyTo: 'om_user' });

  assert.equal(calls.fileUploads.length, 1);
  assert.equal(calls.fileUploads[0].data.file_type, 'stream');
  assert.equal(calls.fileUploads[0].data.file_name, 'result.html');
  assert.equal(calls.fileUploads[0].data.file, file.bytes);
  assert.equal(calls.replies.length, 1);
  assert.equal(calls.replies[0].path.message_id, 'om_user');
  assert.equal(calls.replies[0].data.msg_type, 'file');
  assert.deepEqual(JSON.parse(calls.replies[0].data.content), { file_key: 'file-key-test' });
  assert.match(calls.replies[0].data.uuid, /^dshim_[a-f0-9]{40}$/);
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    deliveryId: 'delivery-html',
    presentation: 'feishu-file',
    providerMessageIds: ['om-stream'],
    artifacts: [{ artifactId: 'artifact-html', outcome: 'sent' }],
  });
});

test('VerifiedFeishuChannel uploads an image and replies with a native image message', async () => {
  const { client, calls } = fakeClient();
  const channel = new VerifiedFeishuChannel({ client });
  const file = {
    artifactId: 'artifact-image',
    deliveryKey: 'delivery-image',
    fileName: 'result.png',
    mediaType: 'image/png',
    size: 12,
    bytes: Buffer.from('png contents'),
  };

  const receipt = await channel.sendImage('oc_chat', file, { replyTo: 'om_user' });

  assert.equal(calls.fileUploads.length, 0);
  assert.equal(calls.imageUploads.length, 1);
  assert.deepEqual(calls.imageUploads[0].data, {
    image_type: 'message',
    image: file.bytes,
  });
  assert.equal(calls.replies.length, 1);
  assert.equal(calls.replies[0].path.message_id, 'om_user');
  assert.equal(calls.replies[0].data.msg_type, 'image');
  assert.deepEqual(JSON.parse(calls.replies[0].data.content), { image_key: 'image-key-test' });
  assert.match(calls.replies[0].data.uuid, /^dshim_[a-f0-9]{40}$/);
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    deliveryId: 'delivery-image',
    presentation: 'feishu-image',
    providerMessageIds: ['om-stream'],
    artifacts: [{ artifactId: 'artifact-image', outcome: 'sent' }],
  });
});

test('VerifiedFeishuChannel sends to the current chat when no reply target exists', async () => {
  const { client, calls } = fakeClient({
    createMessage: async (request) => {
      calls.replies.push(request);
      return { code: 0, data: { message_id: 'om-created-file' } };
    },
  });
  const channel = new VerifiedFeishuChannel({ client });

  await channel.sendFile('oc_chat', {
    artifactId: 'artifact-generic',
    deliveryKey: 'delivery-generic',
    fileName: 'result.bin',
    bytes: Buffer.from('generic'),
  });

  assert.deepEqual(calls.replies[0].params, { receive_id_type: 'chat_id' });
  assert.equal(calls.replies[0].data.receive_id, 'oc_chat');
  assert.equal(calls.replies[0].data.msg_type, 'file');
});

test('VerifiedFeishuChannel retries uncertain message delivery without uploading twice', async () => {
  const requests = [];
  let attempts = 0;
  const { client, calls } = fakeClient({
    replyMessage: async (request) => {
      requests.push(structuredClone(request));
      attempts += 1;
      return attempts === 1
        ? { code: 230049, msg: 'still sending' }
        : { code: 0, data: { message_id: 'om-retried-file' } };
    },
  });
  const channel = new VerifiedFeishuChannel({ client });

  const receipt = await channel.sendFile('oc_chat', {
    artifactId: 'artifact-retry',
    deliveryKey: 'delivery-retry',
    fileName: 'retry.txt',
    bytes: Buffer.from('retry'),
  }, { replyTo: 'om_user' });

  assert.equal(calls.fileUploads.length, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(receipt.providerMessageIds, ['om-retried-file']);
});

test('VerifiedFeishuChannel stops after one 230049 retry and never uploads the file twice', async () => {
  const requests = [];
  const { client, calls } = fakeClient({
    replyMessage: async (request) => {
      requests.push(structuredClone(request));
      return { code: 230049, msg: 'still sending' };
    },
  });
  const channel = new VerifiedFeishuChannel({ client });

  await assert.rejects(channel.sendFile('oc_chat', {
    artifactId: 'artifact-still-uncertain',
    deliveryKey: 'delivery-still-uncertain',
    fileName: 'uncertain.txt',
    bytes: Buffer.from('uncertain'),
  }, { replyTo: 'om_user' }), (error) => error.code === 'artifact-delivery-uncertain'
    && error.providerCode === 230049);

  assert.equal(calls.fileUploads.length, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
});

test('VerifiedFeishuChannel retries an SDK-thrown 230049 with the same file key and UUID', async () => {
  const requests = [];
  const { client, calls } = fakeClient({
    replyMessage: async (request) => {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        const error = new Error('still sending');
        error.code = 230049;
        throw error;
      }
      return { code: 0, data: { message_id: 'om-after-thrown-230049' } };
    },
  });
  const channel = new VerifiedFeishuChannel({ client });

  const receipt = await channel.sendFile('oc_chat', {
    artifactId: 'artifact-thrown-retry',
    deliveryKey: 'delivery-thrown-retry',
    fileName: 'thrown-retry.txt',
    bytes: Buffer.from('retry'),
  }, { replyTo: 'om_user' });

  assert.equal(calls.fileUploads.length, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(receipt.providerMessageIds, ['om-after-thrown-230049']);
});

test('VerifiedFeishuChannel bounds upload and message waits independently', async () => {
  const uploadFixture = fakeClient({ uploadFile: async () => new Promise(() => {}) });
  const uploadChannel = new VerifiedFeishuChannel({
    client: uploadFixture.client,
    fileUploadTimeoutMs: 10,
    fileMessageTimeoutMs: 100,
  });

  await assert.rejects(uploadChannel.sendFile('oc_chat', {
    artifactId: 'artifact-upload-timeout',
    deliveryKey: 'delivery-upload-timeout',
    fileName: 'upload-timeout.txt',
    bytes: Buffer.from('timeout'),
  }, { replyTo: 'om_user' }), (error) => error.code === 'artifact-provider-failed'
    && error.cause?.code === 'provider-timeout');
  assert.equal(uploadFixture.calls.replies.length, 0);

  let messageCalls = 0;
  const messageFixture = fakeClient({
    replyMessage: async () => {
      messageCalls += 1;
      return new Promise(() => {});
    },
  });
  const messageChannel = new VerifiedFeishuChannel({
    client: messageFixture.client,
    fileUploadTimeoutMs: 100,
    fileMessageTimeoutMs: 10,
  });

  await assert.rejects(messageChannel.sendFile('oc_chat', {
    artifactId: 'artifact-message-timeout',
    deliveryKey: 'delivery-message-timeout',
    fileName: 'message-timeout.txt',
    bytes: Buffer.from('timeout'),
  }, { replyTo: 'om_user' }), (error) => error.code === 'artifact-delivery-uncertain'
    && error.cause?.code === 'provider-timeout');
  assert.equal(messageFixture.calls.fileUploads.length, 1);
  assert.equal(messageCalls, 1);
});

test('VerifiedFeishuChannel rejects waits longer than the 120 second operation timeout', () => {
  const { client } = fakeClient();
  assert.throws(
    () => new VerifiedFeishuChannel({ client, fileUploadTimeoutMs: 120_001 }),
    /fileUploadTimeoutMs.*120000/,
  );
  assert.throws(
    () => new VerifiedFeishuChannel({ client, fileMessageTimeoutMs: 120_001 }),
    /fileMessageTimeoutMs.*120000/,
  );
});

test('VerifiedFeishuChannel stops after an in-flight upload when file delivery is cancelled', async () => {
  let uploadStarted;
  const started = new Promise((resolve) => { uploadStarted = resolve; });
  const { client, calls } = fakeClient({
    uploadFile: async () => {
      uploadStarted();
      return new Promise(() => {});
    },
  });
  const channel = new VerifiedFeishuChannel({ client });
  const abort = new AbortController();
  const reason = new DOMException('runtime stopped', 'AbortError');

  const sending = channel.sendFile('oc_chat', {
    artifactId: 'artifact-cancelled-upload',
    deliveryKey: 'delivery-cancelled-upload',
    fileName: 'cancelled.txt',
    bytes: Buffer.from('cancelled'),
  }, { replyTo: 'om_user', signal: abort.signal });

  await started;
  abort.abort(reason);

  await assert.rejects(sending, (error) => error === reason);
  assert.equal(calls.replies.length, 0);
});

test('VerifiedFeishuChannel immediately preserves caller abort during an in-flight message send', async () => {
  let messageStarted;
  const started = new Promise((resolve) => { messageStarted = resolve; });
  const { client, calls } = fakeClient({
    replyMessage: async () => {
      messageStarted();
      return new Promise(() => {});
    },
  });
  const channel = new VerifiedFeishuChannel({ client });
  const abort = new AbortController();
  const reason = new DOMException('runtime stopped', 'AbortError');

  const sending = channel.sendFile('oc_chat', {
    artifactId: 'artifact-cancelled-message',
    deliveryKey: 'delivery-cancelled-message',
    fileName: 'cancelled-message.txt',
    bytes: Buffer.from('cancelled'),
  }, { replyTo: 'om_user', signal: abort.signal });

  await started;
  abort.abort(reason);

  await assert.rejects(sending, (error) => error === reason
    && error.code !== 'artifact-delivery-uncertain');
  assert.equal(calls.fileUploads.length, 1);
});

test('VerifiedFeishuChannel does not retry an uncertain file message after cancellation', async () => {
  const abort = new AbortController();
  const reason = new DOMException('runtime stopped', 'AbortError');
  const requests = [];
  const { client } = fakeClient({
    replyMessage: async (request) => {
      requests.push(request);
      abort.abort(reason);
      return { code: 230049, msg: 'still sending' };
    },
  });
  const channel = new VerifiedFeishuChannel({ client });

  await assert.rejects(channel.sendFile('oc_chat', {
    artifactId: 'artifact-cancelled-retry',
    deliveryKey: 'delivery-cancelled-retry',
    fileName: 'cancelled-retry.txt',
    bytes: Buffer.from('cancelled retry'),
  }, { replyTo: 'om_user', signal: abort.signal }), (error) => error === reason);

  assert.equal(requests.length, 1);
});

test('VerifiedFeishuChannel lets Feishu decide empty and oversize file outcomes', async () => {
  const uploads = [];
  const providerCodes = [234010, 234006, 0];
  const { client } = fakeClient({
    uploadFile: async (request) => {
      uploads.push(request);
      const code = providerCodes.shift();
      return code === 0 ? {} : { code };
    },
  });
  const channel = new VerifiedFeishuChannel({ client });
  const base = {
    artifactId: 'artifact-invalid',
    deliveryKey: 'delivery-invalid',
    fileName: 'invalid.bin',
  };

  await assert.rejects(
    channel.sendFile('oc_chat', { ...base, bytes: Buffer.alloc(0) }),
    (error) => error.code === 'artifact-empty' && error.providerCode === 234010,
  );
  await assert.rejects(
    channel.sendFile('oc_chat', { ...base, bytes: Buffer.from('provider decides') }),
    (error) => error.code === 'artifact-too-large' && error.providerCode === 234006,
  );
  await assert.rejects(
    channel.sendFile('oc_chat', { ...base, bytes: Buffer.from('valid bytes') }),
    (error) => error.code === 'artifact-provider-failed' && !error.message.includes('undefined'),
  );
  assert.deepEqual(uploads.map((request) => request.data.file.byteLength), [0, 16, 11]);
});

test('VerifiedFeishuChannel distinguishes upload failure from uncertain final delivery', async () => {
  const uploadFixture = fakeClient({
    uploadFile: async () => { throw new Error('upload transport closed'); },
  });
  const uploadChannel = new VerifiedFeishuChannel({ client: uploadFixture.client });

  await assert.rejects(uploadChannel.sendFile('oc_chat', {
    artifactId: 'artifact-upload-transport',
    deliveryKey: 'delivery-upload-transport',
    fileName: 'upload.txt',
    bytes: Buffer.from('upload'),
  }, { replyTo: 'om_user' }), (error) => error.code === 'artifact-provider-failed');
  assert.equal(uploadFixture.calls.replies.length, 0);

  for (const replyMessage of [
    async () => { throw new Error('message transport closed'); },
    async () => ({ code: 0, data: {} }),
  ]) {
    const messageFixture = fakeClient({ replyMessage });
    const messageChannel = new VerifiedFeishuChannel({ client: messageFixture.client });
    await assert.rejects(messageChannel.sendFile('oc_chat', {
      artifactId: 'artifact-uncertain-message',
      deliveryKey: 'delivery-uncertain-message',
      fileName: 'message.txt',
      bytes: Buffer.from('message'),
    }, { replyTo: 'om_user' }), (error) => error.code === 'artifact-delivery-uncertain');
    assert.equal(messageFixture.calls.fileUploads.length, 1);
  }
});

test('VerifiedFeishuChannel keeps explicit final provider codes out of the uncertain bucket', async () => {
  const { client, calls } = fakeClient({
    replyMessage: async () => ({ code: 99991672, msg: 'missing scope' }),
  });
  const channel = new VerifiedFeishuChannel({ client });

  await assert.rejects(channel.sendFile('oc_chat', {
    artifactId: 'artifact-message-permission',
    deliveryKey: 'delivery-message-permission',
    fileName: 'permission.txt',
    bytes: Buffer.from('permission'),
  }, { replyTo: 'om_user' }), (error) => error.code === 'artifact-permission-required'
    && error.providerCode === 99991672);
  assert.equal(calls.fileUploads.length, 1);
});

test('VerifiedFeishuChannel classifies missing file permission without exposing provider details', async () => {
  const { client } = fakeClient({
    uploadFile: async () => {
      const error = new Error('raw tenant detail and private diagnostic');
      error.code = 99991672;
      throw error;
    },
  });
  const channel = new VerifiedFeishuChannel({ client });

  await assert.rejects(
    channel.sendFile('oc_chat', {
      artifactId: 'artifact-permission',
      deliveryKey: 'delivery-permission',
      fileName: 'result.html',
      bytes: Buffer.from('result'),
    }),
    (error) => error.code === 'artifact-permission-required'
      && error.message.includes('im:resource permission')
      && !error.message.includes('im:resource:upload')
      && !error.message.includes('private diagnostic'),
  );
});

test('VerifiedFeishuChannel recognizes the SDK array-shaped permission error', async () => {
  const { client } = fakeClient({
    uploadFile: async () => {
      const transport = new Error('raw transport diagnostic');
      transport.code = 'ERR_BAD_REQUEST';
      throw [transport, {
        code: 99991672,
        msg: 'raw provider permission URL',
      }];
    },
  });
  const channel = new VerifiedFeishuChannel({ client });

  await assert.rejects(
    channel.sendFile('oc_chat', {
      artifactId: 'artifact-array-permission',
      deliveryKey: 'delivery-array-permission',
      fileName: 'result.txt',
      bytes: Buffer.from('result'),
    }),
    (error) => error.code === 'artifact-permission-required'
      && error.providerCode === 99991672
      && !error.message.includes('provider permission URL'),
  );
});

test('rotate() finalizes the old card and carries the final answer into a new card', async () => {
  const { client, calls } = fakeClient();
  const channel = new VerifiedFeishuChannel({ client, initialText: '正在思考…' });
  const result = await channel.stream('oc_chat', {
    markdown: async (controller) => {
      await controller.setContent('第一步进行中');
      await controller.rotate();
      // 此间隙 bridge 发出独立交互消息（此处不需要模拟）
      await controller.setContent('最终回答');
    },
  });
  assert.deepEqual(result.providerMessageIds, ['om-stream', 'om-stream-2']);
  const card1 = calls.updates.filter((u) => u.path.card_id === 'card-test');
  assert.ok(card1.at(-1).data.content.includes('最终结果见下方'), 'old card must carry the pointer notice');
  const card2 = calls.updates.filter((u) => u.path.card_id === 'card-test-2');
  assert.ok(card2.at(-1).data.content.includes('最终回答'), 'new card must carry the final answer');
  assert.equal(calls.settings.length, 2, 'both cards must be finished');
});

test('rotate() degrades gracefully when finalizing the old card fails', async () => {
  let cardTestUpdates = 0;
  const { client, calls } = fakeClient({
    updateContent: async (request) => {
      if (request.path.card_id === 'card-test') {
        cardTestUpdates += 1;
        if (cardTestUpdates === 2) throw new Error('transient finalize failure');
      }
      calls.updates.push(request);
      return { code: 0 };
    },
  });
  const channel = new VerifiedFeishuChannel({ client, initialText: '正在思考…' });
  const result = await channel.stream('oc_chat', {
    markdown: async (controller) => {
      await controller.setContent('第一步进行中');
      await controller.rotate();
      await controller.setContent('最终回答');
    },
  });
  assert.deepEqual(result.providerMessageIds, ['om-stream', 'om-stream-2']);
  const card2 = calls.updates.filter((u) => u.path.card_id === 'card-test-2');
  assert.ok(card2.at(-1).data.content.includes('最终回答'));
});

test('rotate() keeps oversized chunked delivery on the rotated card chain', async () => {
  const { client, calls } = fakeClient();
  const channel = new VerifiedFeishuChannel({ client, initialText: '正在思考…' });
  const huge = `${'A'.repeat(27990)}\nB`.repeat(2);
  const result = await channel.stream('oc_chat', {
    markdown: async (controller) => {
      await controller.setContent('过程');
      await controller.rotate();
      await controller.setContent(huge);
    },
  });
  assert.equal(result.providerMessageIds.length >= 3, true);
  const settingsByCard = calls.settings.map((s) => s.path.card_id);
  assert.deepEqual([...new Set(settingsByCard)].length, settingsByCard.length, 'each card finishes exactly once');
});

test('VerifiedFeishuChannel asks reply_in_thread for a streamed card and reports the created thread', async () => {
  const { client, calls } = fakeClient({
    replyMessage: async (request) => {
      calls.replies.push(request);
      return {
        code: 0,
        data: {
          message_id: 'om-stream-topic',
          thread_id: request.data.reply_in_thread === true ? 'omt_stream' : undefined,
        },
      };
    },
  });
  const channel = new VerifiedFeishuChannel({ client, initialText: '正在思考…' });
  const threadIds = [];
  const result = await channel.stream('oc_chat', {
    markdown: async (controller) => {
      await controller.setContent('第一段');
    },
  }, {
    replyTo: 'om_user',
    replyInThread: true,
    onReplyThreadId: async (threadId) => threadIds.push(threadId),
  });

  assert.equal(result.messageId, 'om-stream-topic');
  assert.equal(calls.replies[0].data.reply_in_thread, true);
  assert.deepEqual(threadIds, ['omt_stream']);
});

test('VerifiedFeishuChannel keeps reply_in_thread off by default', async () => {
  const { client, calls } = fakeClient();
  const channel = new VerifiedFeishuChannel({ client, initialText: '正在思考…' });
  await channel.stream('oc_chat', {
    markdown: async (controller) => {
      await controller.setContent('第一段');
    },
  }, { replyTo: 'om_user' });
  assert.equal(calls.replies[0].data.reply_in_thread, undefined);
});

test('VerifiedFeishuChannel sends artifacts into a topic via reply_in_thread and reports the thread', async () => {
  const { client, calls } = fakeClient({
    replyMessage: async (request) => {
      calls.replies.push(request);
      return {
        code: 0,
        data: {
          message_id: 'om-file-topic',
          thread_id: request.data.reply_in_thread === true ? 'omt_file' : undefined,
        },
      };
    },
  });
  const channel = new VerifiedFeishuChannel({ client });
  const file = {
    artifactId: 'artifact-topic',
    deliveryKey: 'delivery-topic',
    fileName: 'result.txt',
    mediaType: 'text/plain',
    size: 3,
    bytes: Buffer.from('abc'),
  };
  const threadIds = [];
  await channel.sendFile('oc_chat', file, {
    replyTo: 'om_user',
    replyInThread: true,
    onReplyThreadId: async (threadId) => threadIds.push(threadId),
  });
  assert.equal(calls.replies[0].data.reply_in_thread, true);
  assert.equal(calls.replies[0].data.msg_type, 'file');
  assert.deepEqual(threadIds, ['omt_file']);
});

test('recallMessage deletes through the message delete API and swallows failures', async () => {
  const { client, calls } = fakeClient();
  const channel = new VerifiedFeishuChannel({ client });

  await channel.recallMessage('om_heartbeat');
  assert.equal(calls.recalls.length, 1);
  assert.equal(calls.recalls[0].path.message_id, 'om_heartbeat');

  client.im.v1.message.delete = async () => { throw new Error('already gone'); };
  await channel.recallMessage('om_gone');
  assert.equal(calls.recalls.length, 1);
});
