// Exercise the plugin against an actual built Harness checkout, without an
// LLM request or a running Host. Run:
// node scripts/verify-session-title-prefix.mjs /path/to/dsh [all-prompts|first-prompt]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createImHostPlugin } from '../plugin-src/host/index.mjs';

if (!process.argv[2]) throw new Error('Pass the path of a built DSH checkout.');
const root = resolve(process.argv[2]);
const automatic = process.argv[3] ?? 'all-prompts';
assert.ok(['all-prompts', 'first-prompt'].includes(automatic));
const fromHarness = createRequire(resolve(root, 'packages/session/session-title/package.json'));
const load = (name) => import(pathToFileURL(fromHarness.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { default: SessionStore, SessionId } = await load('@deepseek-ai/dsh-session');
const { default: SessionProjectionRegistry } = await load('@deepseek-ai/dsh-session-projection');
const { default: SessionTitleService, SessionTitleProviderId } = await load('@deepseek-ai/dsh-session-title');
const { createUserMessage } = await load('@deepseek-ai/dsh-llm');

const ctx = new Context();
const fibers = [];
for (const [plugin, config] of [
  [SessionStore],
  [SessionProjectionRegistry],
  [SessionTitleService, { fallbackMaxWords: 10, fallbackMaxBytes: 60, maxTitleBytes: 60 }],
]) {
  const fiber = ctx.plugin(plugin, config);
  fibers.push(fiber);
  await fiber.await();
}
// Use the complete Host activation path: Cordis treats returned controller
// objects as invalid effects and disposes their listeners after startup.
for (const [name, value] of Object.entries({
  connection: { rpc: { handle: () => () => {} } }, credentials: {},
  typertGateway: { stream() {} }, sessionController: {}, workspaceController: {},
})) ctx.provide(name, value);
const internals = Object.fromEntries(
  ['Feishu', 'Weixin', 'Dingtalk', 'Wecom', 'Qq', 'Slack', 'Telegram', 'Discord', 'Whatsapp', 'Office']
    .map((channel) => [`apply${channel}`, async () => {}]),
);
Object.assign(internals, {
  installUpdateRpc: () => {}, installInboundTtlRpc: () => {},
  installDeliveryRpc: () => {}, installSessionSyncCoordinator: () => {},
});
const host = ctx.plugin(createImHostPlugin(internals));
fibers.push(host);
await host.await();
const settle = async () => {
  await new Promise((done) => setTimeout(done, 0));
};
await settle();
const prompt = (session, text, channel = 'weixin') => session.append('user/message', createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'user', rpcId: `${channel}-00000000-0000-4000-8000-000000000000` },
}), { surfaceOp: 'append' });
const request = (session) => session.append('request/header', {
  header: { config: { provider: 'test-provider', model: 'test-model' } }, reason: 'change',
});
let calls = 0;
let release;
let aborted = false;
ctx.sessionTitle.register({
  id: SessionTitleProviderId('test-title-provider'),
  automatic,
  async generate(input) {
    calls += 1;
    input.signal.addEventListener('abort', () => { aborted = true; });
    if (calls === 1) await new Promise((done) => { release = done; });
    return { title: `自动标题 ${calls}`, messageSeqs: input.messages.map((message) => message.seq) };
  },
});
const session = ctx.sessions.create(SessionId('ordinary-host-generated-id'));
session.append('turn/start', { turn: 1 });
prompt(session, '第一次消息');
request(session);
await settle();
assert.equal(ctx.sessionTitle.get(session).title, '微信 · 第一次消息');
assert.equal(ctx.sessionTitle.get(session).source.kind, 'fallback');
assert.equal(calls, 1);
assert.equal(aborted, false, 'adding the fallback prefix must not abort the active title provider');
release();
await settle();
assert.equal(ctx.sessionTitle.get(session).title, '微信 · 自动标题 1');
assert.equal(ctx.sessionTitle.get(session).source.kind, 'provider');
assert.equal(ctx.sessionTitle.get(session).source.provider, 'test-title-provider');

prompt(session, '第二次消息');
request(session);
await settle();
const automaticCalls = automatic === 'all-prompts' ? 2 : 1;
assert.equal(calls, automaticCalls, 'the original automatic generation cadence must be preserved');
assert.equal(ctx.sessionTitle.get(session).title, `微信 · 自动标题 ${automaticCalls}`);
assert.equal(ctx.sessionProjections.stateOf(session, 'title'), `微信 · 自动标题 ${automaticCalls}`);
assert.equal(aborted, false);

ctx.sessionTitle.rename(session, '自定义标题');
await settle();
assert.equal(ctx.sessionTitle.get(session).title, '微信 · 自定义标题');
assert.equal(ctx.sessionTitle.get(session).source.kind, 'user');
prompt(session, '手动命名后的消息');
request(session);
await settle();
assert.equal(calls, automaticCalls, 'a real user rename must retain the normal pin');
await ctx.sessionTitle.refresh(session);
await settle();
assert.equal(calls, automaticCalls + 1);
assert.equal(ctx.sessionTitle.get(session).title, `微信 · 自动标题 ${automaticCalls + 1}`);
assert.equal(ctx.sessionTitle.get(session).source.kind, 'provider');

const ordinary = ctx.sessions.create(SessionId('web-created'));
ordinary.append('turn/start', { turn: 1 });
prompt(ordinary, '网页消息', 'web');
await settle();
assert.equal(ctx.sessionTitle.get(ordinary).title, '网页消息');

// The production Feishu path can create its initial title before the first
// prompt. The listener must still be alive after the Host has finished loading.
let feishu;
const creator = ctx.plugin({
  name: 'feishu-session-regression', inject: ['sessions'],
  apply(scoped) {
    feishu = scoped.sessions.create(SessionId('feishu-host-generated-id'));
    feishu.append('session/title', {
      title: '你好，你是谁？', messageSeqs: [], source: { kind: 'user' },
    });
    prompt(feishu, '你好，你是谁？', 'feishu');
  },
});
fibers.push(creator);
await creator.await();
await settle();
assert.equal(ctx.sessionTitle.get(feishu).title, '飞书 · 你好，你是谁？');
assert.equal(ctx.sessionTitle.get(feishu).source.kind, 'user');

const sourceEvents = session.snapshotEvents();
for (const event of sourceEvents.filter((entry) => entry.type === 'session/title')) {
  assert.equal(event.data.messageSeqs.length === 0, event.data.source.kind === 'user');
  for (const seq of event.data.messageSeqs) {
    assert.equal(sourceEvents[seq].type, 'user/message');
    assert.equal(sourceEvents[seq].data.source.kind, 'user');
    assert.ok(seq < event.seq);
  }
  assert.ok(!event.data.title.includes('微信 · 微信 · '));
}
for (const fiber of fibers.reverse()) await fiber.dispose();
console.log(`Session channel prefix verified against ${root} (${automatic}): active generation, later generation, projections, manual rename, refresh, Web sessions, and title-source invariants passed.`);
