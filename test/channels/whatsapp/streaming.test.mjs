import assert from 'node:assert/strict';
import test from 'node:test';

import { WhatsappHarnessBridge } from '../../../src/channels/whatsapp/whatsapp-bridge.mjs';
import { WhatsappBotClient } from '../../../src/channels/whatsapp/whatsapp-runtime.mjs';

const target = {
  jid: '120363000000000001@g.us',
  quoted: { key: { id: 'question', remoteJid: '120363000000000001@g.us' } },
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, send) {
  const calls = [];
  const presence = [];
  const reserved = new Set();
  const warnings = [];
  const logger = { warn: (...args) => warnings.push(args), error() {} };
  const client = new WhatsappBotClient({
    readMessages: async () => {},
    sendPresenceUpdate: async (...args) => { presence.push(args); },
    sendMessage: async (jid, content, options) => {
      assert.ok(reserved.has(options.messageId), 'reserve outgoing ids before local echoes');
      if (content.edit) assert.ok(reserved.has(content.edit.id));
      const call = { jid, content, options };
      calls.push(call);
      const response = {
        key: {
          id: options.messageId,
          remoteJid: jid,
          fromMe: true,
          participant: '16505550123:4@s.whatsapp.net',
        },
      };
      return send ? send(call, response) : response;
    },
  }, {
    reserve: (id) => reserved.add(id),
    remember: (id) => reserved.add(id),
  }, { logger });
  t.after(() => client.close());
  return { client, calls, presence, logger, warnings };
}

function bridgeFor(f, ask) {
  return new WhatsappHarnessBridge({
    bot: f.client,
    harness: { sessionExists: async () => true, ask },
    state: {
      hasSeen: () => false,
      markSeen: async () => {},
      sessionFor: () => 'session-stream',
    },
    logger: f.logger,
  });
}

const inbound = {
  messageId: 'question',
  senderId: 'sender',
  conversationId: target.jid,
  kind: 'group',
  addressed: true,
  content: '帮我分析这份文件',
  replyTarget: target,
};

test('WhatsApp shows coalesced tool and text updates before completion and splits the final reply', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(t);
  const first = '答'.repeat(4_000);
  const bridge = bridgeFor(f, async (_sessionId, _text, options) => {
    assert.equal(f.calls[0].content.text, '正在处理…');
    assert.equal(f.calls[0].options.quoted, target.quoted);
    await options.onUpdate({ type: 'tool', name: '读取文件' });
    t.mock.timers.tick(1_000);
    await settle();
    assert.equal(f.calls[1].content.text, '正在使用读取文件…');
    await options.onUpdate({ type: 'text', text: '初步' });
    await options.onUpdate({ type: 'text', text: '初步分析结果' });
    t.mock.timers.tick(999);
    await settle();
    assert.equal(f.calls.length, 2, 'updates are throttled');
    t.mock.timers.tick(1);
    await settle();
    assert.equal(f.calls[2].content.text, '初步分析结果');
    assert.equal(f.presence.some(([status]) => status === 'paused'), false,
      'typing remains active while generating');
    await options.onUpdate({ type: 'text', text: 'outdated pending preview' });
    return `${first}\n最后一段`;
  });

  const receipt = await bridge.accept(inbound);
  t.mock.timers.tick(20_000);
  await settle();
  assert.deepEqual(f.calls.map(({ content }) => content.text), [
    '正在处理…', '正在使用读取文件…', '初步分析结果', first, '最后一段',
  ]);
  const originalKey = {
    remoteJid: target.jid,
    fromMe: true,
    id: f.calls[0].options.messageId,
    participant: '16505550123:4@s.whatsapp.net',
  };
  for (const call of f.calls.slice(1, 4)) {
    assert.deepEqual(call.content.edit, originalKey);
    assert.equal(call.options.quoted, undefined);
  }
  assert.equal(f.calls[4].content.edit, undefined);
  assert.equal(f.calls[4].options.quoted, undefined);
  assert.deepEqual(receipt.providerMessageIds, [
    originalKey.id, f.calls[4].options.messageId,
  ], 'delivery receipts reference visible messages, not edit envelopes');
  assert.equal(receipt.presentation, 'whatsapp-stream');
  assert.deepEqual(f.presence.at(-1), ['paused', target.jid]);
});

test('WhatsApp waits for an in-flight edit before finalizing and drops pending previews', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pendingEdit = Promise.withResolvers();
  const f = fixture(t, (call, response) => (
    call.content.text === 'partial' ? pendingEdit.promise.then(() => response) : response
  ));
  const stream = await f.client.openStream(target);
  stream.update('partial');
  t.mock.timers.tick(1_000);
  await settle();
  stream.update('stale');
  const finishing = stream.finish('final');
  await settle();
  assert.equal(f.calls.length, 2);
  pendingEdit.resolve();
  await finishing;
  t.mock.timers.tick(2_000);
  await settle();
  assert.deepEqual(f.calls.map(({ content }) => content.text), ['正在处理…', 'partial', 'final']);
});

for (const failure of ['create', 'edit']) {
  test(`WhatsApp falls back to a complete answer when stream ${failure} fails`, async (t) => {
    const f = fixture(t, (call, response) => {
      if ((failure === 'create' && call.content.text === '正在处理…')
        || (failure === 'edit' && call.content.edit)) {
        throw new Error('provider rejected the operation');
      }
      return response;
    });
    const receipt = await bridgeFor(f, async () => '完整答案').accept(inbound);
    const delivered = f.calls.filter(({ content }) => content.text === '完整答案' && !content.edit);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].options.quoted, target.quoted);
    assert.equal(receipt.presentation, 'whatsapp-text');
    assert.deepEqual(receipt.providerMessageIds, [delivered[0].options.messageId]);
    assert.equal(f.warnings.length, 1);
  });
}

test('WhatsApp recovers from a failed preview edit and finalizes in place', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, (call, response) => {
    if (call.content.text === 'partial') throw new Error('temporary edit failure');
    return response;
  });
  const stream = await f.client.openStream(target);
  stream.update('partial');
  t.mock.timers.tick(1_000);
  await settle();
  await stream.finish('final');
  assert.equal(f.calls.at(-1).content.text, 'final');
  assert.equal(f.calls.at(-1).content.edit.id, f.calls[0].options.messageId);
  assert.equal(f.calls.filter(({ content }) => !content.edit).length, 1);
  assert.equal(f.warnings.length, 1);
});

test('closing WhatsApp cancels queued previews', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  const stream = await f.client.openStream(target);
  stream.update('pending');
  await f.client.close();
  stream.update('late update');
  t.mock.timers.tick(2_000);
  await settle();
  assert.equal(f.calls.length, 1);
});

test('closing WhatsApp releases an in-flight edit and prevents a late final send', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pendingEdit = Promise.withResolvers();
  const f = fixture(t, (call, response) => call.content.edit ? pendingEdit.promise : response);
  const stream = await f.client.openStream(target);
  stream.update('partial');
  t.mock.timers.tick(1_000);
  await settle();
  const finishing = assert.rejects(stream.finish('final'), { name: 'AbortError' });
  await f.client.close();
  await finishing;
  pendingEdit.resolve({ key: { id: 'late-edit' } });
  await settle();
  assert.deepEqual(f.calls.map(({ content }) => content.text), ['正在处理…', 'partial']);
});
