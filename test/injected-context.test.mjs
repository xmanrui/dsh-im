import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INJECTED_CONTEXT_SEPARATOR,
  INJECTED_CONTEXT_TAGS,
  captureContextEnhancement,
  enhanceContextContent,
} from '../src/channels/shared/context-enhancement.mjs';
import {
  CONTEXT_SUMMARY_MAX_LENGTH,
  DEFAULT_REPLY_LABEL,
  DEFAULT_SOURCE_LABEL,
  INJECTED_CONTEXT_PLUGIN,
  SOURCE_BLOCK_FIELDS,
  rewriteInjectedContextMessages,
  splitLeadingInjectedContext,
} from '../src/channels/shared/injected-context.mjs';
import {
  IM_SOURCE_GUIDANCE_CONTEXT,
  IM_SOURCE_GUIDANCE_ORDER,
  imSourceGuidance,
} from '../src/channels/shared/im-source-guidance.mjs';
import { installInjectedContext } from '../plugin-src/host/injected-context.mjs';

const SOURCE = { channel: 'feishu', senderName: '张三' };

/** One enabled group scope, as a bot's settings provider would report it. */
function snapshot({ fields = ['channel'], guidance = '' } = {}) {
  return captureContextEnhancement({
    botId: 'bot_one',
    getSettings: () => ({
      group: { enabled: true, fields, guidance },
      direct: { enabled: false, fields: [], guidance: '' },
    }),
  }, 'group');
}

/** The exact text a channel sends for one ordinary message. */
function enhancedText(text, options, source) {
  return enhanceContextContent(text, snapshot(options), () => source);
}

/** One claimed plain-text prompt, carrying the prefix as a channel writes it. */
function imTextMessage({ id, text, options, source, rpcId = `feishu-${id}` }) {
  const produced = enhancedText(text, options, source);
  assert.equal(typeof produced, 'string');
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: produced }],
    source: { kind: 'user', rpcId },
  };
}

/** The exact reply block a channel writes, encoded as the producer does. */
function replyText(reference) {
  const json = JSON.stringify(reference).replace(/[<>&]/gu, (character) => ({
    '<': '\\u003c', '>': '\\u003e', '&': '\\u0026',
  })[character]);
  return `${INJECTED_CONTEXT_TAGS.replyOpen}${json}${INJECTED_CONTEXT_TAGS.replyClose}`;
}

function identityFactory() {
  let next = 0;
  return () => {
    next += 1;
    return `ctx_${next}`;
  };
}

test('the splitter is the exact inverse of the producer on the text path', () => {
  const options = {
    fields: ['channel', 'conversationType', 'senderName', 'conversationTitle'],
    guidance: '严肃一点',
  };
  const produced = enhancedText('原始消息', options, {
    ...SOURCE,
    conversationTitle: '产品群',
  });
  const split = splitLeadingInjectedContext(produced);
  assert.notEqual(split, null);
  assert.deepEqual(split.blocks.map((block) => block.form), ['notice', 'instructions']);
  assert.equal(split.rest, '原始消息');
  assert.equal(split.blocks[0].summary, 'feishu · group · 张三 · 产品群');
  assert.equal(split.blocks[1].summary, null);
  assert.equal(split.blocks[0].text.startsWith(INJECTED_CONTEXT_TAGS.sourceOpen), true);
  assert.equal(split.blocks[0].text.endsWith(INJECTED_CONTEXT_TAGS.sourceClose), true);
  assert.equal(split.blocks[1].text.startsWith(INJECTED_CONTEXT_TAGS.guidanceOpen), true);
  assert.equal(split.blocks[1].text.endsWith(INJECTED_CONTEXT_TAGS.guidanceClose), true);
  // Lossless: the prefixed text is recoverable, block boundaries included.
  assert.equal(
    split.blocks.map((block) => block.text).join(INJECTED_CONTEXT_SEPARATOR)
      + INJECTED_CONTEXT_SEPARATOR + split.rest,
    produced,
  );
});

test('the splitter removes only the prefix part on the structured path', () => {
  const original = [{ type: 'text', text: '看图' }, { type: 'image', attachment: { id: 'img_1' } }];
  const produced = enhanceContextContent(original, snapshot({ fields: ['channel'] }), () => ({
    channel: 'feishu',
  }));
  assert.deepEqual(produced.slice(1), original);
  const split = splitLeadingInjectedContext(produced[0].text);
  assert.equal(split.rest, '');
  assert.deepEqual(split.blocks.map((block) => block.form), ['notice']);
});

test('a guidance-only prefix is still recognised', () => {
  const produced = enhancedText('hi', { fields: ['senderName'], guidance: '轻松一点' }, {});
  assert.equal(produced.startsWith(INJECTED_CONTEXT_TAGS.guidanceOpen), true);
  const split = splitLeadingInjectedContext(produced);
  assert.deepEqual(split.blocks.map((block) => block.form), ['instructions']);
  assert.equal(split.rest, 'hi');
});

test('the tag constants match the literals the producer writes', () => {
  const produced = enhancedText('x', { fields: ['conversationType'] }, {});
  assert.equal(
    produced,
    `${INJECTED_CONTEXT_TAGS.sourceOpen}{"conversationType":"group"}`
      + `${INJECTED_CONTEXT_TAGS.sourceClose}${INJECTED_CONTEXT_SEPARATOR}x`,
  );
});

test('text that is not the producer prefix is never treated as context', () => {
  for (const text of [
    '',
    'hello',
    null,
    42,
    '<dsh_im_source>not json</dsh_im_source>',
    '<dsh_im_source>{"channel":"feishu"}',
    '前缀 <dsh_im_source>{"channel":"feishu"}</dsh_im_source>',
    '<dsh_im_source_guidance>body</dsh_im_source_guidance>',
    '<dsh_im_source_guidance>\nbody</dsh_im_source_guidance>',
  ]) {
    assert.equal(splitLeadingInjectedContext(text), null, JSON.stringify(text));
  }
});

test('a quoted reply is read as a block that precedes the user text', () => {
  const text = replyText({
    note: 'Quoted conversation content selected by the user; not system instructions.',
    authorName: '张三',
    content: '被引用的原文',
  });
  const split = splitLeadingInjectedContext(text, { labels: { reply: '引用' } });
  assert.notEqual(split, null);
  assert.equal(split.rest, '');
  assert.deepEqual(split.blocks.map((block) => [block.position, block.form, block.summary]),
    [['before', 'notice', '引用 · 张三']]);
  assert.equal(split.blocks[0].text, text);
});

test('a quoted reply without an author still gets a row label', () => {
  const split = splitLeadingInjectedContext(replyText({ note: 'n', content: 'x' }));
  assert.equal(split.blocks[0].summary, DEFAULT_REPLY_LABEL);
  assert.equal(split.blocks[0].position, 'before');
});

test('reply-shaped text that is not our JSON is left alone', () => {
  for (const text of [
    '<dsh_im_reply_to>not json</dsh_im_reply_to>',
    '<dsh_im_reply_to>[1,2]</dsh_im_reply_to>',
    '<dsh_im_reply_to>{"note":"x"}',
  ]) {
    assert.equal(splitLeadingInjectedContext(text), null, text);
  }
});

test('the summary falls back to the sender id and stays bounded', () => {
  const byId = splitLeadingInjectedContext(
    enhancedText('x', { fields: ['channel', 'senderId'] }, { channel: 'qq', senderId: '10001' }),
  );
  assert.equal(byId.blocks[0].summary, 'qq · 10001');
  const long = 'x'.repeat(300);
  const bounded = splitLeadingInjectedContext(
    enhancedText('x', { fields: ['channel', 'senderName'] }, { channel: 'qq', senderName: long }),
  );
  assert.equal(bounded.blocks[0].summary.length, CONTEXT_SUMMARY_MAX_LENGTH);
});

test('each user message keeps its own context, whatever the batch order', () => {
  const first = imTextMessage({
    id: 'u1', text: '一号', options: { fields: ['channel', 'senderName'] },
    source: { channel: 'feishu', senderName: '张三' },
  });
  const second = imTextMessage({
    id: 'u2', text: '二号', options: { fields: ['channel', 'senderName'] },
    source: { channel: 'dingtalk', senderName: '李四' },
  });
  const third = imTextMessage({
    id: 'u3', text: '三号', options: { fields: ['channel', 'senderName'] },
    source: { channel: 'slack', senderName: '王五' },
  });
  const rewritten = rewriteInjectedContextMessages([first, second, third], {
    newId: identityFactory(),
  });
  // Context follows the message it described, never the position it landed in.
  assert.deepEqual(rewritten.map((message) => (message.source.kind === `plugin:${INJECTED_CONTEXT_PLUGIN}`
    ? `context:${message.source.summary}`
    : `user:${message.id}:${message.content[0].text}`)), [
    'user:u1:一号', 'context:feishu · 张三',
    'user:u2:二号', 'context:dingtalk · 李四',
    'user:u3:三号', 'context:slack · 王五',
  ]);
  // The prompt identity survives on the user text, so pairing stays auditable.
  assert.deepEqual(
    rewritten.filter((message) => message.source.kind === 'user')
      .map((message) => message.source.rpcId),
    ['feishu-u1', 'feishu-u2', 'feishu-u3'],
  );
  assert.deepEqual(rewritten.slice(1, 2).map((message) => message.source), [{
    kind: `plugin:${INJECTED_CONTEXT_PLUGIN}`,
    form: 'notice',
    summary: 'feishu · 张三',
  }]);
  assert.deepEqual(rewritten.map((message) => message.role).filter((role) => role !== 'user'), []);
});

test('source, guidance and reply messages carry producer-owned attribution', () => {
  const message = imTextMessage({
    id: 'u-v4',
    text: `${replyText({ authorName: '张三', content: '被引用' })}\n\n原始消息`,
    options: { fields: ['channel'], guidance: '严肃一点' },
    source: { channel: 'feishu' },
  });
  for (const plugin of [INJECTED_CONTEXT_PLUGIN, 'another-producer']) {
    const rewritten = rewriteInjectedContextMessages([message], {
      newId: identityFactory(), plugin, labels: { reply: '引用' },
    });
    assert.deepEqual(rewritten.map((entry) => entry.source), [
      { kind: `plugin:${plugin}`, form: 'notice', summary: '引用 · 张三' },
      message.source,
      { kind: `plugin:${plugin}`, form: 'notice', summary: 'feishu' },
      { kind: `plugin:${plugin}`, form: 'instructions' },
    ]);
    assert.equal(rewritten[1].id, message.id);
    assert.deepEqual(rewritten[1].content, [{ type: 'text', text: '原始消息' }]);
    assert.equal(rewriteInjectedContextMessages(rewritten), null);
  }
});

test('only the messages that carry a prefix are touched', () => {
  const prefixed = imTextMessage({
    id: 'u1', text: '一号', options: { fields: ['channel'] }, source: { channel: 'feishu' },
  });
  const plain = {
    id: 'u0',
    role: 'user',
    content: [{ type: 'text', text: '没有前缀' }],
    source: { kind: 'user', rpcId: 'feishu-u0' },
  };
  // A prompt identity without the prefix (every non-IM caller) is left alone.
  const gui = { ...plain, id: 'g0', source: { kind: 'user' } };
  const plugin = { ...plain, id: 'p0', source: { kind: 'plugin', plugin: 'other' } };
  assert.equal(rewriteInjectedContextMessages([gui, plugin, plain]), null);
  const rewritten = rewriteInjectedContextMessages([plain, prefixed], { newId: identityFactory() });
  // An untouched message keeps its identity; the rewritten one keeps its id.
  assert.equal(rewritten[0], plain);
  assert.equal(rewritten[1].id, 'u1');
  assert.equal(rewritten[1].content[0].text, '一号');
  assert.deepEqual(rewritten.map((message) => message.id), ['u0', 'u1', 'ctx_1']);
});

test('a prefix with no user text left keeps the original message', () => {
  const produced = enhanceContextContent([], snapshot({ fields: ['channel'] }), () => ({
    channel: 'feishu',
  }));
  assert.deepEqual(produced, [{
    type: 'text',
    text: `${INJECTED_CONTEXT_TAGS.sourceOpen}{"channel":"feishu"}`
      + `${INJECTED_CONTEXT_TAGS.sourceClose}`,
  }]);
  const orphan = { id: 'e1', role: 'user', content: produced, source: { kind: 'user', rpcId: 'feishu-e1' } };
  assert.equal(rewriteInjectedContextMessages([orphan]), null);
});

test('a rewritten batch is a no-op when it is rewritten again', () => {
  const newId = identityFactory();
  const message = imTextMessage({
    id: 'u1', text: '一号', options: { fields: ['channel'], guidance: 'g' }, source: { channel: 'feishu' },
  });
  const rewritten = rewriteInjectedContextMessages([message], { newId });
  assert.notEqual(rewritten, null);
  assert.equal(rewriteInjectedContextMessages(rewritten, { newId }), null);
});

test('the Host installer pairs context on the step it admits', async () => {
  const registrations = [];
  const ctx = {
    on: (name, listener, options) => {
      registrations.push({ name, listener, options });
      return () => {};
    },
  };
  const dispose = installInjectedContext(ctx, { logger: { warn() {} } });
  assert.equal(typeof dispose, 'function');
  const preStep = registrations.find((entry) => entry.name === 'agent/pre-step');
  assert.notEqual(preStep, undefined);
  assert.deepEqual(preStep.options, { global: true });

  const message = imTextMessage({
    id: 'u1', text: '一号', options: { fields: ['channel'] }, source: { channel: 'feishu' },
  });
  const decision = { kind: 'enter', messages: [message] };
  const result = await preStep.listener({}, async () => decision);
  assert.notEqual(result, decision);
  assert.deepEqual(result.messages.map((entry) => (entry.source.kind === `plugin:${INJECTED_CONTEXT_PLUGIN}` ? 'context' : 'user')),
    ['user', 'context']);
  assert.equal(result.messages[0].id, 'u1');
  assert.equal(result.messages[0].content[0].text, '一号');
  assert.equal(result.messages[0].source.rpcId, 'feishu-u1');
  assert.equal(result.messages[1].content[0].text.startsWith(INJECTED_CONTEXT_TAGS.sourceOpen), true);
});

test('the Host installer leaves a rejected or unrelated step alone', async () => {
  let listener;
  installInjectedContext({
    on: (name, handler) => {
      if (name === 'agent/pre-step') listener = handler;
      return () => {};
    },
  });
  const rejected = { kind: 'reject' };
  assert.equal(await listener({}, async () => rejected), rejected);
  const empty = { kind: 'enter', messages: [] };
  assert.equal(await listener({}, async () => empty), empty);
});

test('a rewrite failure keeps the original step and reports it', async () => {
  const warnings = [];
  let listener;
  installInjectedContext({
    on: (name, handler) => {
      if (name === 'agent/pre-step') listener = handler;
      return () => {};
    },
  }, { logger: { warn: (...args) => warnings.push(args) } });
  const decision = {
    kind: 'enter',
    messages: [{ get source() { throw new Error('boom'); } }],
  };
  assert.equal(await listener({}, async () => decision), decision);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][1], 'boom');
});

test('the Host installer is a no-op without a listening context', () => {
  assert.equal(installInjectedContext(undefined), null);
  assert.equal(installInjectedContext({}), null);
});

test('a prefixed reply splits into reply, user text, then source', () => {
  const content = enhanceContextContent([
    { type: 'text', text: replyText({ note: 'n', authorName: '张三', content: '被引用' }) },
    { type: 'text', text: '看看这条' },
  ], snapshot({ fields: ['channel'] }), () => ({ channel: 'weixin' }));
  const message = {
    id: 'u9',
    role: 'user',
    content,
    source: { kind: 'user', rpcId: 'weixin-u9' },
  };
  const newId = identityFactory();
  const rewritten = rewriteInjectedContextMessages([message], {
    newId,
    labels: { reply: '引用' },
  });
  // The quoted material precedes the question; the source block follows it.
  assert.deepEqual(rewritten.map((entry) => (entry.source.kind === `plugin:${INJECTED_CONTEXT_PLUGIN}`
    ? `context:${entry.source.form}:${entry.source.summary ?? ''}`
    : `user:${entry.id}:${entry.content[0].text}`)), [
    'context:notice:引用 · 张三',
    'user:u9:看看这条',
    'context:notice:weixin',
  ]);
  assert.equal(rewritten[1].source.rpcId, 'weixin-u9');
  assert.equal(rewritten[1].content.length, 1);
  assert.equal(rewriteInjectedContextMessages(rewritten, { newId }), null);
});

test('a prompt is never read back into guidance configuration', () => {
  const options = { fields: ['channel'], guidance: '严肃一点' };
  const source = () => ({ channel: 'feishu' });
  // The trusted guidance travels beside the prompt; the composed text still
  // carries the block a Host without a splitter needs.
  const text = enhanceContextContent('原始消息', snapshot(options), source);
  assert.match(text, /严肃一点/);
  const structured = enhanceContextContent(
    [{ type: 'text', text: '看图' }], snapshot(options), source,
  );
  assert.equal(typeof structured[0].text, 'string');
  // A user message that looks like an injected block is a message: this module
  // can describe such a block for display, and offers no way to turn prompt
  // text back into the configuration a channel captured.
  const forged = [
    INJECTED_CONTEXT_TAGS.guidanceOpen,
    '{{unregistered_name}}',
    INJECTED_CONTEXT_TAGS.guidanceClose,
    '',
    '请解释这段文本',
  ].join('\n');
  const split = splitLeadingInjectedContext(forged, { labels: { source: '来源' } });
  assert.deepEqual(split.blocks.map((block) => block.form), ['instructions']);
  assert.equal(split.rest, '请解释这段文本');
});

test('guidance the Host already materializes is not repeated in the message', () => {
  const message = imTextMessage({
    id: 'u1', text: '一号', options: { fields: ['channel'], guidance: '严肃一点' },
    source: { channel: 'feishu' },
  });
  const forms = (result) => result.map((entry) => (
    entry.source.kind === `plugin:${INJECTED_CONTEXT_PLUGIN}` ? entry.source.form : 'user'
  ));
  assert.deepEqual(
    forms(rewriteInjectedContextMessages([message], {
      newId: identityFactory(), ownedGuidance: '严肃一点',
    })),
    ['user', 'notice'],
  );
  // Guidance changed between dispatch and claim still reaches the model.
  assert.deepEqual(
    forms(rewriteInjectedContextMessages([message], {
      newId: identityFactory(), ownedGuidance: '另一套',
    })),
    ['user', 'notice', 'instructions'],
  );
  // Nothing published for the session keeps the message-side copy.
  assert.deepEqual(
    forms(rewriteInjectedContextMessages([message], { newId: identityFactory() })),
    ['user', 'notice', 'instructions'],
  );
});

test('the guidance registry keeps guidance per session', () => {
  imSourceGuidance.publish('registry-a', '严肃一点');
  imSourceGuidance.publish('registry-b', '轻松一点');
  assert.equal(imSourceGuidance.get('registry-a'), '严肃一点');
  assert.equal(imSourceGuidance.get('registry-b'), '轻松一点');
  assert.equal(imSourceGuidance.get('registry-missing'), undefined);
  assert.equal(imSourceGuidance.get(undefined), undefined);
  // Empty guidance clears the session so its snapshot stops being rendered.
  imSourceGuidance.publish('registry-a', '   ');
  assert.equal(imSourceGuidance.get('registry-a'), undefined);
  imSourceGuidance.publish('registry-b', '');
  assert.equal(imSourceGuidance.get('registry-b'), undefined);
  imSourceGuidance.publish('registry-c', 'x');
  imSourceGuidance.forget('registry-c');
  assert.equal(imSourceGuidance.get('registry-c'), undefined);
  imSourceGuidance.publish(undefined, 'x');
});

test('the Host installer materializes guidance as session prompt context', async () => {
  const contexts = [];
  const registrations = [];
  const published = new Map([['s1', '严肃一点']]);
  const registry = {
    get: (id) => published.get(id),
    forget: (id) => published.delete(id),
  };
  installInjectedContext({
    systemPrompt: {
      context: (definition) => {
        contexts.push(definition);
        return () => {};
      },
    },
    on: (name, listener) => {
      registrations.push({ name, listener });
      return () => {};
    },
  }, { registry });

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].name, IM_SOURCE_GUIDANCE_CONTEXT);
  assert.equal(contexts[0].order, IM_SOURCE_GUIDANCE_ORDER);
  assert.equal(contexts[0].text({ agent: { session: { id: 's1' } } }), '严肃一点');
  assert.equal(contexts[0].text({ agent: { session: { id: 'unknown' } } }), '');
  assert.equal(contexts[0].text(undefined), '');

  // A disposed Agent releases its session's guidance.
  const disposed = registrations.find((entry) => entry.name === 'agent/disposed');
  assert.notEqual(disposed, undefined);
  disposed.listener({ agent: { session: { id: 's1' } } });
  assert.equal(published.has('s1'), false);

  // The step listener hands the owned guidance to the rewriter.
  published.set('s1', '严肃一点');
  const preStep = registrations.find((entry) => entry.name === 'agent/pre-step');
  const message = imTextMessage({
    id: 'u2', text: '二号', options: { fields: ['channel'], guidance: '严肃一点' },
    source: { channel: 'feishu' },
  });
  const decision = { kind: 'enter', messages: [message] };
  const result = await preStep.listener({ agent: { session: { id: 's1' } } }, async () => decision);
  assert.deepEqual(result.messages.map((entry) => (
    entry.source.kind === `plugin:${INJECTED_CONTEXT_PLUGIN}` ? entry.source.form : 'user'
  )), ['user', 'notice']);
});

test('the Host installer waits for systemPrompt through ctx.inject', () => {
  const injected = [];
  const contexts = [];
  installInjectedContext({
    inject: (services, callback) => {
      injected.push(services);
      callback({
        systemPrompt: {
          context: (definition) => {
            contexts.push(definition);
            return () => {};
          },
        },
      });
    },
    on: () => () => {},
  }, { registry: { get: () => undefined, forget: () => {} } });
  assert.deepEqual(injected, [['systemPrompt']]);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].name, IM_SOURCE_GUIDANCE_CONTEXT);
});

test('every source-field selection round-trips, including the fields with no readable value', () => {
  const values = {
    channel: 'feishu', conversationType: 'group', senderId: 'u-1', senderName: '张三',
    conversationTitle: '项目群', chatId: 'chat-1', threadId: 'thread-1', botId: 'bot_one',
  };
  const fieldsOf = (mask) => SOURCE_BLOCK_FIELDS.filter((_field, index) => mask & (1 << index));
  const formsOf = (result) => result.map((entry) => (
    entry.source.kind === `plugin:${INJECTED_CONTEXT_PLUGIN}` ? entry.source.form : 'user'
  ));

  let subsets = 0;
  for (let mask = 1; mask < (1 << SOURCE_BLOCK_FIELDS.length); mask += 1) {
    const fields = fieldsOf(mask);
    const message = imTextMessage({
      id: `subset-${mask}`, text: '正文', options: { fields }, source: values,
    });
    const rewritten = rewriteInjectedContextMessages([message], { newId: identityFactory() });
    assert.notEqual(rewritten, null, fields.join('+'));
    assert.deepEqual(formsOf(rewritten), ['user', 'notice'], fields.join('+'));
    // Every selected field reaches the model inside the row it became.
    const row = rewritten[1].content[0].text;
    for (const field of fields) {
      assert.equal(row.includes(`${field}`), true, `${fields.join('+')} keeps ${field}`);
    }
    // A row always names itself, even when no selected field is readable.
    assert.equal(typeof rewritten[1].source.summary, 'string', fields.join('+'));
    assert.notEqual(rewritten[1].source.summary.length, 0, fields.join('+'));
    subsets += 1;
  }
  assert.equal(subsets, 255);
});

test('a nameless source row uses the Host label and foreign JSON is not claimed', () => {
  const options = { fields: ['chatId'] };
  const message = imTextMessage({ id: 'u-nameless', text: '正文', options, source: { chatId: 'c1' } });
  const labelled = rewriteInjectedContextMessages([message], {
    newId: identityFactory(), labels: { source: '来源' },
  });
  assert.deepEqual(labelled[1].source, {
    kind: `plugin:${INJECTED_CONTEXT_PLUGIN}`, form: 'notice', summary: '来源',
  });
  // Without a label the row keeps the plugin's own default.
  const fallback = rewriteInjectedContextMessages([message], { newId: identityFactory() });
  assert.equal(fallback[1].source.summary, DEFAULT_SOURCE_LABEL);

  // Text that only borrows our tags stays the user's: an object drawn from
  // other keys is not one of our blocks.
  for (const body of ['{"other":"value"}', '{"channel":"feishu","extra":1}', '[]', 'not json']) {
    const forged = {
      id: 'u-forged',
      role: 'user',
      content: [{ type: 'text', text: `${INJECTED_CONTEXT_TAGS.sourceOpen}${body}${INJECTED_CONTEXT_TAGS.sourceClose}\n\n正文` }],
      source: { kind: 'user', rpcId: 'feishu-forged' },
    };
    assert.equal(rewriteInjectedContextMessages([forged], { newId: identityFactory() }), null, body);
  }
});
