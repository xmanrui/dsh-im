/** Verify the built Host hook against a built DSH's real JSONL persistence. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createImHostPlugin } from '../lib/index.js';
import {
  captureContextEnhancement, enhanceContextContent, INJECTED_CONTEXT_TAGS,
} from '../src/channels/shared/context-enhancement.mjs';

if (!process.argv[2]) throw new Error('Pass the path of a built DSH checkout.');
const harnessRoot = resolve(process.argv[2]);
const fromHarness = createRequire(resolve(harnessRoot, 'packages/session/session-persistence-jsonl/package.json'));
const load = (name) => import(pathToFileURL(fromHarness.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { SESSION_FORMAT_VERSION } = await load('@deepseek-ai/dsh-session');
const { default: JsonlSessionPersistence } = await load('@deepseek-ai/dsh-session-persistence-jsonl');
assert.equal(SESSION_FORMAT_VERSION, 4, 'This regression verifies Session format V4.');

const directory = await mkdtemp(join(tmpdir(), 'dsh-im-context-'));
const ctx = new Context();
const source = { channel: 'feishu', senderName: 'Context test' };
const guidance = 'Reply briefly.';
const reply = `${INJECTED_CONTEXT_TAGS.replyOpen}${JSON.stringify({
  authorName: 'Quoted author', content: 'Quoted text',
})}${INJECTED_CONTEXT_TAGS.replyClose}`;

function enhanced(content, fields = ['channel', 'senderName'], instructions = '') {
  const snapshot = captureContextEnhancement({
    botId: 'context-test',
    getSettings: () => ({
      group: { enabled: true, fields, guidance: instructions },
      direct: { enabled: false, fields: [], guidance: '' },
    }),
  }, 'group');
  return enhanceContextContent(content, snapshot, () => source);
}

function turnEvents(messages, turn = 1, offset = 0) {
  return [
    { type: 'turn/start', data: { turn } },
    { type: 'step/start', data: { turn, step: 1 } },
    ...messages.map(data => ({ type: 'user/message', data, surfaceOp: 'append' })),
    { type: 'step/end', data: { turn, step: 1 } },
    { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
  ].map((event, index) => ({ ...event, seq: offset + index, time: offset + index + 1 }));
}

const cases = [
  ['plain', 'Question', ['user']],
  ['source', enhanced('Question'), ['user', 'notice']],
  ['guidance', enhanced('Question', [], guidance), ['user', 'instructions']],
  ['quote', `${reply}\n\nQuestion`, ['notice', 'user']],
  ['combined', enhanced(`${reply}\n\nQuestion`, ['channel'], guidance),
    ['notice', 'user', 'notice', 'instructions']],
  ['structured', enhanced([{ type: 'text', text: reply }, { type: 'text', text: 'Question' }]),
    ['notice', 'user', 'notice']],
];

try {
  await ctx.plugin(JsonlSessionPersistence, { root: directory, compression: 'none' });
  for (const [name, value] of Object.entries({
    connection: {}, credentials: {}, typertGateway: { stream() {} },
    sessionController: {}, workspaceController: {},
  })) ctx.provide(name, value);
  // Keep the real bundled context hook; unrelated channel connections stay idle.
  const internals = Object.fromEntries([
    'Feishu', 'Weixin', 'Dingtalk', 'Wecom', 'WecomApp', 'Qq', 'Slack',
    'Telegram', 'Discord', 'Whatsapp', 'IMessage', 'Email', 'Matrix', 'Office',
  ].map(name => [`apply${name}`, async () => {}]));
  const host = ctx.plugin(createImHostPlugin({
    ...internals,
    installHostLanguage: () => {},
    installSessionSyncCoordinator: () => {},
  }));
  await host.await();

  for (const [id, content, expectedForms] of cases) {
    const message = {
      id: `${id}-user`, role: 'user',
      content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
      source: { kind: 'user', rpcId: `feishu-${id}` },
    };
    const decision = { kind: 'enter', messages: [message] };
    const result = await ctx.waterfall('agent/pre-step', { agent: { session: { id } } },
      async () => decision);
    assert.deepEqual(result.messages.map(entry => entry.source.kind === 'user' ? 'user' : entry.source.form), expectedForms, id);
    const human = result.messages.find(entry => entry.source.kind === 'user');
    assert.equal(human.id, message.id);
    assert.deepEqual(human.source, message.source);
    assert.deepEqual(human.content, [{ type: 'text', text: 'Question' }]);
    for (const context of result.messages.filter(entry => entry !== human)) {
      assert.equal(context.source.kind, 'plugin:dsh-im', id);
      assert.equal(Object.hasOwn(context.source, 'plugin'), false, id);
      if (context.source.form === 'notice') assert.ok(context.source.summary.length > 0, id);
    }
    assert.equal(await ctx.waterfall('agent/pre-step', { agent: { session: { id } } }, async () => result), result);

    const header = { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, delegationDepth: 0 };
    const events = turnEvents(result.messages);
    const writer = await ctx.sessionPersistence.create(header);
    try { await writer.append(events); } finally { await writer.close(); }
    // Reopen for a second turn, then verify both turns through a fresh read handle.
    const resumed = await ctx.sessionPersistence.open(id, 'write');
    const second = turnEvents([{ ...human, id: `${id}-second` }], 2, events.length);
    try { await resumed.append(second); } finally { await resumed.close(); }
    const reader = await ctx.sessionPersistence.open(id, 'read');
    try {
      assert.deepEqual((await reader.read()).events, [...events, ...second], id);
    } finally { await reader.close(); }
    console.log(`PASS ${id}: bundled hook, persistence, reopen and next turn`);
  }
} finally {
  try { await ctx.fiber.dispose(); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
console.log(`Injected context verified against ${harnessRoot} (format V4).`);
