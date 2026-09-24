import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  conversationKey,
  extractInboundMessage,
  extractText,
  isAllowedSender,
  isBotSender,
  isTopicGroupKey,
  managedGroupKey,
  splitText,
} from '../../../src/channels/feishu/message-utils.mjs';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

test('extractText removes bot mentions', () => {
  const event = {
    message: {
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 你好' }),
      mentions: [{ key: '@_user_1' }],
    },
  };
  assert.equal(extractText(event), '你好');
});

test('extractInboundMessage lazily downloads a Feishu image resource as a bounded stream', async () => {
  const calls = [];
  const event = {
    message: {
      message_id: 'om_image',
      message_type: 'image',
      content: JSON.stringify({ image_key: 'img_test' }),
    },
  };
  const client = { im: { v1: { messageResource: { get: async (request) => {
    calls.push(request);
    return {
      headers: { 'content-length': String(PNG_1X1.length) },
      getReadableStream: () => Readable.from([
        PNG_1X1.subarray(0, 12),
        PNG_1X1.subarray(12),
      ]),
    };
  } } } } };

  const message = extractInboundMessage(event, client);
  assert.equal(message.content, '');
  assert.equal(message.images.length, 1);
  assert.deepEqual(await message.images[0].load({ maxBytes: 1024 }), PNG_1X1);
  assert.deepEqual(calls, [{
    path: { message_id: 'om_image', file_key: 'img_test' },
    params: { type: 'image' },
  }]);
});

test('extractInboundMessage preserves visible Feishu post text and every embedded image', async () => {
  const calls = [];
  const event = {
    message: {
      message_id: 'om_post',
      message_type: 'post',
      mentions: [{ key: '@_bot_1' }],
      content: JSON.stringify({
        title: '截图比较',
        content: [
          [
            { tag: 'at', user_id: '@_bot_1', user_name: '机器人' },
            { tag: 'text', text: '@_bot_1 请查看 ' },
            { tag: 'a', text: '第一处', href: 'https://example.com/one' },
            { tag: 'link', text: ' 和第二处', href: 'https://example.com/two' },
          ],
          [{ tag: 'img', image_key: 'img_first' }],
          [{ tag: 'text', text: '补充说明' }],
          [
            { tag: 'img', image_key: 'img_second' },
            { tag: 'img', image_key: '  ' },
          ],
        ],
      }),
    },
  };
  const client = { im: { v1: { messageResource: { get: async (request) => {
    calls.push(request);
    return {
      headers: { 'content-length': String(PNG_1X1.length) },
      getReadableStream: () => Readable.from([PNG_1X1]),
    };
  } } } } };

  const message = extractInboundMessage(event, client);
  assert.equal(extractText(event), null, 'rich posts must not become interaction replies');
  assert.equal(message.content, '截图比较\n请查看 第一处 和第二处\n补充说明');
  assert.equal(message.images.length, 2);
  assert.deepEqual(await Promise.all(message.images.map((image) => image.load({ maxBytes: 1024 }))), [
    PNG_1X1,
    PNG_1X1,
  ]);
  assert.deepEqual(calls, [
    {
      path: { message_id: 'om_post', file_key: 'img_first' },
      params: { type: 'image' },
    },
    {
      path: { message_id: 'om_post', file_key: 'img_second' },
      params: { type: 'image' },
    },
  ]);
});

test('extractInboundMessage exposes a lazy Feishu reply reference and loads the direct parent', async () => {
  const calls = [];
  const event = {
    message: {
      message_id: 'om_current',
      parent_id: 'om_parent',
      root_id: 'om_root',
      chat_id: 'oc_same',
      message_type: 'text',
      content: JSON.stringify({ text: '继续解释' }),
    },
  };
  const client = { im: { v1: { message: { get: async (request) => {
    calls.push(request);
    return {
      code: 0,
      data: {
        items: [{
          message_id: 'om_parent',
          chat_id: 'oc_same',
          msg_type: 'text',
          sender: { id: 'ou_author', sender_name: '引用作者' },
          body: { content: JSON.stringify({ text: '被引用的内容' }) },
        }],
      },
    };
  } } } } };

  const message = extractInboundMessage(event, client);
  assert.equal(message.content, '继续解释');
  assert.equal(message.replyTo.messageId, 'om_parent');
  assert.equal(calls.length, 0, 'quoted message lookup stays lazy');
  assert.deepEqual(await message.replyTo.load(), {
    messageId: 'om_parent',
    authorId: 'ou_author',
    authorName: '引用作者',
    content: '被引用的内容',
    attachments: [],
  });
  assert.deepEqual(calls, [{
    path: { message_id: 'om_parent' },
    params: {
      with_sender_name: true,
      card_msg_content_type: 'raw_card_content',
    },
  }]);
});

test('Feishu reply reference reads raw CardKit 2.0 markdown without hidden card data', async () => {
  const calls = [];
  const client = { im: { v1: { message: { get: async (request) => {
    calls.push(request);
    return {
      code: 0,
      data: { items: [{
        message_id: 'om_card_2',
        chat_id: 'oc_same',
        msg_type: 'interactive',
        sender: { id: 'ou_bot', sender_name: '回答机器人' },
        body: { content: JSON.stringify({
          card_schema: 2,
          json_attachment: JSON.stringify({ secret: 'hidden-attachment' }),
          json_card: JSON.stringify({
            schema: '2.0',
            config: { streaming_mode: false, secret: 'hidden-config' },
            body: {
              id: '_2',
              property: {
                elements: [{
                  id: 'stream_md',
                  tag: 'markdown',
                  property: {
                    elements: [{
                      id: 'stream_md_0',
                      tag: 'plain_text',
                      property: {
                        content: '这是机器人最终回答\n\n模型是 **doubao-seed**。',
                      },
                    }],
                    value: { token: 'hidden-callback-value' },
                  },
                }],
              },
            },
          }),
        }) },
      }] },
    };
  } } } } };

  const reply = await extractInboundMessage({
    message: {
      message_id: 'om_current',
      parent_id: 'om_card_2',
      chat_id: 'oc_same',
      message_type: 'text',
      content: JSON.stringify({ text: '这说的是什么模型？' }),
    },
  }, client).replyTo.load();

  assert.deepEqual(reply, {
    messageId: 'om_card_2',
    authorId: 'ou_bot',
    authorName: '回答机器人',
    content: '这是机器人最终回答\n\n模型是 **doubao-seed**。',
    attachments: [],
  });
  assert.doesNotMatch(
    reply.content,
    /hidden-config|hidden-attachment|hidden-callback-value|stream_md|streaming_mode/u,
  );
  assert.deepEqual(calls, [{
    path: { message_id: 'om_card_2' },
    params: {
      with_sender_name: true,
      card_msg_content_type: 'raw_card_content',
    },
  }]);
});

test('Feishu reply reference reads a historical Card 1.0 and exposes visible labels only', async () => {
  const client = { im: { v1: { message: { get: async () => ({
    code: 0,
    data: { items: [{
      message_id: 'om_card_1',
      chat_id: 'oc_same',
      msg_type: 'interactive',
      body: { content: JSON.stringify({
        header: { title: { tag: 'plain_text', content: '历史回答' } },
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: '这是很久以前的机器人正文。' } },
          {
            tag: 'action',
            actions: [{
              tag: 'button',
              text: { tag: 'plain_text', content: '查看详情' },
              value: { token: 'hidden-callback-value' },
              url: 'https://secret.example.invalid',
            }],
          },
        ],
      }) },
    }] },
  }) } } } };

  const reply = await extractInboundMessage({
    message: {
      message_id: 'om_current',
      parent_id: 'om_card_1',
      chat_id: 'oc_same',
      message_type: 'text',
      content: JSON.stringify({ text: '概括一下' }),
    },
  }, client).replyTo.load();

  assert.equal(reply.content, '历史回答\n这是很久以前的机器人正文。\n查看详情');
  assert.doesNotMatch(reply.content, /hidden-callback-value|secret\.example/u);
});

test('Feishu reply reference reads visible i18n and markdown_v1 fallback card text', async (t) => {
  for (const [name, element, expected] of [
    ['localized text', {
      tag: 'plain_text',
      property: {
        i18nContent: { zh_cn: '旧卡片中文正文', en_us: 'old card text' },
        value: 'hidden-localized-value',
      },
    }, '旧卡片中文正文'],
    ['markdown_v1 fallback', {
      tag: 'markdown_v1',
      property: { value: 'hidden-markdown-value' },
      fallback: {
        tag: 'plain_text',
        property: { content: '旧卡片可见降级正文' },
      },
    }, '旧卡片可见降级正文'],
  ]) {
    await t.test(name, async () => {
      const client = { im: { v1: { message: { get: async () => ({
        code: 0,
        data: { items: [{
          message_id: 'om_old_card',
          chat_id: 'oc_same',
          msg_type: 'interactive',
          body: { content: JSON.stringify({
            card_schema: 2,
            json_card: JSON.stringify({
              schema: '2.0',
              body: { property: { elements: [element] } },
            }),
          }) },
        }] },
      }) } } } };
      const reply = await extractInboundMessage({
        message: {
          message_id: 'om_current',
          parent_id: 'om_old_card',
          chat_id: 'oc_same',
          message_type: 'text',
          content: JSON.stringify({ text: '继续' }),
        },
      }, client).replyTo.load();
      assert.equal(reply.content, expected);
      assert.doesNotMatch(reply.content, /hidden-/u);
    });
  }
});

test('Feishu reply reference reads ordinary two-dimensional fallback card text', async () => {
  const client = { im: { v1: { message: { get: async () => ({
    code: 0,
    data: { items: [{
      message_id: 'om_fallback_card',
      chat_id: 'oc_same',
      msg_type: 'interactive',
      body: { content: JSON.stringify({
        title: '降级卡片',
        elements: [[
          { tag: 'text', text: '第一段' },
          { tag: 'text', text: '第二段' },
        ]],
      }) },
    }] },
  }) } } } };
  const reply = await extractInboundMessage({
    message: {
      message_id: 'om_current',
      parent_id: 'om_fallback_card',
      chat_id: 'oc_same',
      message_type: 'text',
      content: JSON.stringify({ text: '继续' }),
    },
  }, client).replyTo.load();
  assert.equal(reply.content, '降级卡片\n第一段 第二段');
});

test('Feishu reply reference marks unreadable interactive cards as unsupported', async (t) => {
  for (const [name, content] of [
    ['CardKit id pointer', JSON.stringify({ type: 'card', data: { card_id: 'card_secret' } })],
    ['empty Card 2.0', JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'hr' }] } })],
    ['upgrade placeholder', JSON.stringify({
      title: null,
      elements: [[{ tag: 'text', text: '请升级至最新版本客户端，以查看内容' }]],
    })],
    ['malformed card JSON', '{not-json'],
  ]) {
    await t.test(name, async () => {
      const client = { im: { v1: { message: { get: async () => ({
        code: 0,
        data: { items: [{
          message_id: 'om_card',
          chat_id: 'oc_same',
          msg_type: 'interactive',
          sender: { sender_name: '回答机器人' },
          body: { content },
        }] },
      }) } } } };
      const reply = await extractInboundMessage({
        message: {
          message_id: 'om_current',
          parent_id: 'om_card',
          chat_id: 'oc_same',
          message_type: 'text',
          content: JSON.stringify({ text: '继续' }),
        },
      }, client).replyTo.load();
      assert.deepEqual(reply, {
        messageId: 'om_card',
        authorName: '回答机器人',
        attachments: [],
        unavailableReason: 'unsupported',
      });
    });
  }
});

test('Feishu reply reference falls back to root_id and keeps quoted media as metadata only', async () => {
  let resourceDownloads = 0;
  const event = {
    message: {
      message_id: 'om_current',
      root_id: 'om_root',
      chat_id: 'oc_same',
      message_type: 'text',
      content: JSON.stringify({ text: '这两张图说明什么？' }),
    },
  };
  const client = { im: { v1: {
    message: { get: async () => ({
      data: {
        items: [{
          message_id: 'om_root',
          chat_id: 'oc_same',
          msg_type: 'post',
          body: { content: JSON.stringify({
            title: '原消息',
            content: [
              [{ tag: 'text', text: '请比较截图' }],
              [{ tag: 'img', image_key: 'img_one' }, { tag: 'img', image_key: 'img_two' }],
            ],
          }) },
        }],
      },
    }) },
    messageResource: { get: async () => {
      resourceDownloads += 1;
      throw new Error('quoted media must not be downloaded');
    } },
  } } };

  const reply = await extractInboundMessage(event, client).replyTo.load();
  assert.equal(reply.messageId, 'om_root');
  assert.equal(reply.content, '原消息\n请比较截图');
  assert.deepEqual(reply.attachments, [{ kind: 'image' }, { kind: 'image' }]);
  assert.equal(resourceDownloads, 0);
});

test('Feishu reply lookup degrades deleted, foreign, and permission failures', async (t) => {
  const event = {
    message: {
      message_id: 'om_current',
      parent_id: 'om_parent',
      chat_id: 'oc_same',
      message_type: 'text',
      content: JSON.stringify({ text: '继续' }),
    },
  };
  for (const [name, response, unavailableReason] of [
    ['deleted message', {
      data: { items: [{ message_id: 'om_parent', chat_id: 'oc_same', deleted: true }] },
    }, 'deleted'],
    ['foreign chat', {
      data: { items: [{ message_id: 'om_parent', chat_id: 'oc_other', msg_type: 'text' }] },
    }, 'not-found'],
    ['missing chat identity', {
      data: { items: [{ message_id: 'om_parent', msg_type: 'text' }] },
    }, 'not-found'],
    ['missing permission', { code: 99991672 }, 'permission-denied'],
  ]) {
    await t.test(name, async () => {
      const client = { im: { v1: { message: { get: async () => response } } } };
      assert.deepEqual(await extractInboundMessage(event, client).replyTo.load(), {
        messageId: 'om_parent',
        unavailableReason,
      });
    });
  }
});

test('Feishu reply lookup maps a thrown missing-scope response without failing the current turn', async () => {
  const providerError = new Error('Request failed with status code 400');
  providerError.response = {
    status: 400,
    data: Readable.from([Buffer.from(JSON.stringify({ code: 99991672 }))]),
  };
  const client = { im: { v1: { message: { get: async () => { throw providerError; } } } } };
  const message = extractInboundMessage({
    message: {
      message_id: 'om_current',
      parent_id: 'om_parent',
      chat_id: 'oc_same',
      message_type: 'text',
      content: JSON.stringify({ text: '继续' }),
    },
  }, client);

  assert.deepEqual(await message.replyTo.load(), {
    messageId: 'om_parent',
    unavailableReason: 'permission-denied',
  });
});

test('Feishu reply lookup fails closed when the current event has no chat identity', async () => {
  const client = { im: { v1: { message: { get: async () => ({
    code: 0,
    data: { items: [{
      message_id: 'om_parent',
      chat_id: 'oc_secret',
      msg_type: 'text',
      body: { content: JSON.stringify({ text: '不能泄露的跨聊天内容' }) },
    }] },
  }) } } } };
  const message = extractInboundMessage({
    message: {
      message_id: 'om_current',
      parent_id: 'om_parent',
      message_type: 'text',
      content: JSON.stringify({ text: '继续' }),
    },
  }, client);

  assert.deepEqual(await message.replyTo.load(), {
    messageId: 'om_parent',
    unavailableReason: 'not-found',
  });
});

test('Feishu does not treat the current thread root as its own reply reference', () => {
  const message = extractInboundMessage({
    message: {
      message_id: 'om_root',
      root_id: 'om_root',
      message_type: 'text',
      content: JSON.stringify({ text: '主题首条' }),
    },
  }, {});
  assert.equal('replyTo' in message, false);
});

test('Feishu topic parsing is stateless across admission, handling and later messages', () => {
  const event = (id) => ({ message: {
    message_id: id, chat_type: 'group', chat_id: 'oc_topic',
    thread_id: 'omt_topic', root_id: 'om_root', parent_id: 'om_root',
    message_type: 'text', content: JSON.stringify({ text: 'continue' }),
  } });
  for (const id of ['om_first', 'om_first', 'om_second']) {
    assert.equal(extractInboundMessage(event(id), {}).replyTo.messageId, 'om_root');
  }
});

test('extractInboundMessage exposes a native Feishu file as a lazy unbounded resource download', async () => {
  const calls = [];
  const bytes = Buffer.from('ordinary-file-payload');
  const event = {
    message: {
      message_id: 'om_file',
      message_type: 'file',
      content: JSON.stringify({ file_key: 'file_test', file_name: 'report.bin' }),
    },
  };
  const client = { im: { v1: { messageResource: { get: async (request) => {
    calls.push(request);
    return {
      getReadableStream: () => Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]),
    };
  } } } } };

  const message = extractInboundMessage(event, client);
  assert.equal(message.content, '');
  assert.deepEqual(message.images, []);
  assert.equal(message.files.length, 1);
  assert.equal(message.files[0].name, 'report.bin');
  assert.equal(calls.length, 0, 'file download stays lazy');
  assert.deepEqual(await message.files[0].load({}), bytes);
  assert.deepEqual(calls, [{
    path: { message_id: 'om_file', file_key: 'file_test' },
    params: { type: 'file' },
  }]);
});

test('Feishu image loading rejects declared or streamed data above the caller limit', async () => {
  for (const resource of [
    {
      headers: { 'content-length': '5' },
      getReadableStream: () => Readable.from([Buffer.alloc(5)]),
    },
    {
      headers: {},
      getReadableStream: () => Readable.from([Buffer.alloc(2), Buffer.alloc(3)]),
    },
  ]) {
    const message = extractInboundMessage({
      message: {
        message_id: 'om_large',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_large' }),
      },
    }, { im: { v1: { messageResource: { get: async () => resource } } } });
    await assert.rejects(message.images[0].load({ maxBytes: 4 }), /limit|exceeds/);
  }
});

test('Feishu image loading maps the missing message scope to an actionable error', async () => {
  const providerError = new Error('Request failed with status code 400');
  const body = Buffer.from(JSON.stringify({
    code: 99991672,
    msg: 'missing required tenant scope',
  }));
  providerError.response = {
    status: 400,
    data: Readable.from([body.subarray(0, 9), body.subarray(9)]),
  };
  const message = extractInboundMessage({
    message: {
      message_id: 'om_permission',
      message_type: 'image',
      content: JSON.stringify({ image_key: 'img_permission' }),
    },
  }, { im: { v1: { messageResource: { get: async () => { throw providerError; } } } } });

  await assert.rejects(message.images[0].load({ maxBytes: 1024 }), (error) => {
    assert.equal(error.code, 'feishu-image-permission-required');
    assert.match(error.userMessage, /im:message:readonly/);
    assert.match(error.userMessage, /\/repair/);
    assert.match(error.userMessage, /「IM机器人」设置页/);
    assert.match(error.userMessage, /补全权限/);
    assert.match(error.userMessage, /发布新版本/);
    assert.equal(error.cause, providerError);
    return true;
  });
});

test('Feishu image loading leaves unrelated provider failures on the generic path', async () => {
  const providerError = new Error('Request failed with status code 400');
  providerError.response = {
    status: 400,
    data: Readable.from([Buffer.from(JSON.stringify({ code: 99991400 }))]),
  };
  const message = extractInboundMessage({
    message: {
      message_id: 'om_other_error',
      message_type: 'image',
      content: JSON.stringify({ image_key: 'img_other_error' }),
    },
  }, { im: { v1: { messageResource: { get: async () => { throw providerError; } } } } });

  await assert.rejects(
    message.images[0].load({ maxBytes: 1024 }),
    (error) => error === providerError,
  );
});

test('malformed Feishu image content does not create a downloadable image reference', () => {
  assert.deepEqual(extractInboundMessage({
    message: { message_type: 'image', content: '{not-json' },
  }, {}), { content: '', images: [], files: [] });
  assert.deepEqual(extractInboundMessage({
    message: { message_type: 'post', content: '{not-json' },
  }, {}), { content: '', images: [], files: [] });
});

test('conversationKey isolates p2p users and groups', () => {
  assert.equal(conversationKey({
    sender: { sender_id: { open_id: 'ou_test' } },
    message: { chat_type: 'p2p', chat_id: 'oc_private' },
  }), 'p2p:ou_test');
  assert.equal(conversationKey({
    sender: { sender_id: { open_id: 'ou_test' } },
    message: { chat_type: 'group', chat_id: 'oc_group' },
  }), 'group:oc_group');
});

test('conversationKey isolates topic-group threads without affecting regular groups', () => {
  // Topic groups: each message belongs to a thread, so every topic gets its own session.
  assert.equal(conversationKey({
    sender: { sender_id: { open_id: 'ou_test' } },
    message: { chat_type: 'group', chat_id: 'oc_topic_group', thread_id: 'om_thread_a' },
  }), 'group:oc_topic_group:thread:om_thread_a');
  assert.equal(conversationKey({
    sender: { sender_id: { open_id: 'ou_other' } },
    message: { chat_type: 'group', chat_id: 'oc_topic_group', thread_id: 'om_thread_b' },
  }), 'group:oc_topic_group:thread:om_thread_b');
  assert.notEqual(
    conversationKey({
      sender: { sender_id: { open_id: 'ou_test' } },
      message: { chat_type: 'group', chat_id: 'oc_topic_group', thread_id: 'om_thread_a' },
    }),
    conversationKey({
      sender: { sender_id: { open_id: 'ou_test' } },
      message: { chat_type: 'group', chat_id: 'oc_topic_group', thread_id: 'om_thread_b' },
    }),
  );
  // Regular group chats: no thread_id keeps the single shared group key.
  assert.equal(conversationKey({
    sender: { sender_id: { open_id: 'ou_test' } },
    message: { chat_type: 'group', chat_id: 'oc_group' },
  }), 'group:oc_group');
  // Blank thread_id values fall back to the shared group key.
  assert.equal(conversationKey({
    sender: { sender_id: { open_id: 'ou_test' } },
    message: { chat_type: 'group', chat_id: 'oc_group', thread_id: '   ' },
  }), 'group:oc_group');
});

test('managedGroupKey builds per-topic managed keys and requires ids', () => {
  assert.equal(managedGroupKey('oc_group', 'om_root'), 'group:oc_group:managed:om_root');
  assert.throws(() => managedGroupKey('', 'om_root'), /chat_id/);
  assert.throws(() => managedGroupKey('oc_group', ''), /message id/);
});

test('isTopicGroupKey recognizes thread and managed group keys only', () => {
  assert.equal(isTopicGroupKey('group:oc_group:thread:omt_a'), true);
  assert.equal(isTopicGroupKey('group:oc_group:managed:om_root'), true);
  assert.equal(isTopicGroupKey('group:oc_group'), false);
  assert.equal(isTopicGroupKey('p2p:ou_test'), false);
  assert.equal(isTopicGroupKey(null), false);
  assert.equal(isTopicGroupKey(''), false);
});

test('splitText preserves all text', () => {
  const input = `${'a'.repeat(12)}\n${'b'.repeat(12)}`;
  const chunks = splitText(input, 15);
  assert.equal(chunks.join('\n'), input);
  assert.ok(chunks.every((chunk) => chunk.length <= 15));
});

test('isBotSender rejects bot loops', () => {
  assert.equal(isBotSender({ sender: { sender_type: 'bot' } }), true);
  assert.equal(isBotSender({ sender: { sender_type: 'user' } }), false);
});

test('isAllowedSender enforces an open-id allowlist', () => {
  const event = { sender: { sender_id: { open_id: 'ou_allowed' } } };
  assert.equal(isAllowedSender(event, new Set()), false);
  assert.equal(isAllowedSender(event, new Set(['ou_allowed'])), true);
  assert.equal(isAllowedSender(event, new Set(['ou_other'])), false);
  assert.equal(isAllowedSender(event, new Set(['*'])), true);
});
