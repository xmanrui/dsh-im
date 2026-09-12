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
  INJECTED_CONTEXT_PLUGIN,
  rewriteInjectedContextMessages,
  splitInjectedContextPrefix,
} from '../src/channels/shared/injected-context.mjs';
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
  const split = splitInjectedContextPrefix(produced);
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
  const split = splitInjectedContextPrefix(produced[0].text);
  assert.equal(split.rest, '');
  assert.deepEqual(split.blocks.map((block) => block.form), ['notice']);
});

test('a guidance-only prefix is still recognised', () => {
  const produced = enhancedText('hi', { fields: ['senderName'], guidance: '轻松一点' }, {});
  assert.equal(produced.startsWith(INJECTED_CONTEXT_TAGS.guidanceOpen), true);
  const split = splitInjectedContextPrefix(produced);
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
    assert.equal(splitInjectedContextPrefix(text), null, JSON.stringify(text));
  }
});

test('the summary falls back to the sender id and stays bounded', () => {
  const byId = splitInjectedContextPrefix(
    enhancedText('x', { fields: ['channel', 'senderId'] }, { channel: 'qq', senderId: '10001' }),
  );
  assert.equal(byId.blocks[0].summary, 'qq · 10001');
  const long = 'x'.repeat(300);
  const bounded = splitInjectedContextPrefix(
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
  assert.deepEqual(rewritten.map((message) => (message.source.kind === 'plugin'
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
    kind: 'plugin',
    plugin: INJECTED_CONTEXT_PLUGIN,
    form: 'notice',
    summary: 'feishu · 张三',
  }]);
  assert.deepEqual(rewritten.map((message) => message.role).filter((role) => role !== 'user'), []);
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
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, 'agent/pre-step');
  assert.deepEqual(registrations[0].options, { global: true });

  const message = imTextMessage({
    id: 'u1', text: '一号', options: { fields: ['channel'] }, source: { channel: 'feishu' },
  });
  const decision = { kind: 'enter', messages: [message] };
  const result = await registrations[0].listener({}, async () => decision);
  assert.notEqual(result, decision);
  assert.deepEqual(result.messages.map((entry) => (entry.source.kind === 'plugin' ? 'context' : 'user')),
    ['user', 'context']);
  assert.equal(result.messages[0].id, 'u1');
  assert.equal(result.messages[0].content[0].text, '一号');
  assert.equal(result.messages[0].source.rpcId, 'feishu-u1');
  assert.equal(result.messages[1].content[0].text.startsWith(INJECTED_CONTEXT_TAGS.sourceOpen), true);
});

test('the Host installer leaves a rejected or unrelated step alone', async () => {
  let listener;
  installInjectedContext({ on: (name, handler) => { listener = handler; return () => {}; } });
  const rejected = { kind: 'reject' };
  assert.equal(await listener({}, async () => rejected), rejected);
  const empty = { kind: 'enter', messages: [] };
  assert.equal(await listener({}, async () => empty), empty);
});

test('a rewrite failure keeps the original step and reports it', async () => {
  const warnings = [];
  let listener;
  installInjectedContext({
    on: (name, handler) => { listener = handler; return () => {}; },
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
