import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Context } from '@deepseek-ai/cordis';

import {
  OUTBOUND_ARTIFACT_TOOL,
  OutboundArtifactRegistry,
  createOutboundArtifactTool,
  installOutboundArtifactTool,
  releaseOutboundArtifact,
} from '../src/channels/shared/semantic/artifact.mjs';
import { deliverOutboundArtifacts } from '../src/channels/shared/semantic/artifact-delivery.mjs';

const SESSION_ID = 'session-presented';
const PROMPT_RPC_ID = 'rpc-presented';
const TURN = 3;

async function fixture(t, { consumer = true } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-im-presented-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let nextId = 0;
  const registry = new OutboundArtifactRegistry({ uuid: () => `presented-id-${++nextId}` });
  t.after(() => registry.clear());
  const session = { header: { id: SESSION_ID, cwd: workspace } };
  if (consumer) {
    const close = registry.openConsumer(SESSION_ID, PROMPT_RPC_ID);
    t.after(close);
    openTurn(registry, session, TURN);
  }
  return { workspace, registry, session };
}

function openTurn(registry, session, turn = TURN, rpcId = PROMPT_RPC_ID) {
  registry.observeSessionEvent(session, { type: 'turn/start', data: { turn } });
  registry.observeSessionEvent(session, {
    type: 'user/message',
    data: { turn, source: { rpcId } },
  });
}

/** The exact event dsh-tool-present appends after a successful call. */
function present(registry, session, files, { turn = TURN, callId = 'call-present', logger } = {}) {
  return registry.observePresentedEvent(session, {
    type: 'deliverables/presented',
    data: { turn, callId, files },
  }, { logger });
}

async function send(registry, artifacts) {
  const sent = [];
  const delivery = await deliverOutboundArtifacts({
    artifacts,
    deliveryId: 'presented-delivery',
    channelKey: 'telegram',
    sendImage: async (file) => { sent.push(['image', file.fileName]); return 'message-image'; },
    sendVoice: async (file) => { sent.push(['voice', file.fileName]); return 'message-voice'; },
    sendFile: async (file) => { sent.push(['file', file.fileName]); return 'message-file'; },
  });
  return { sent, delivery };
}

function execution(agent, callId) {
  return {
    name: OUTBOUND_ARTIFACT_TOOL,
    agent,
    callId,
    rootCallId: callId,
    token: Symbol(callId),
  };
}

test('a presented image reaches the channel as an image', async (t) => {
  const fx = await fixture(t);
  const path = join(fx.workspace, 'chart.png');
  await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  assert.equal(await present(fx.registry, fx.session, [{ path, description: 'chart' }]), 1);
  await fx.registry.settle(SESSION_ID, TURN);
  const artifacts = fx.registry.take(SESSION_ID, TURN);
  assert.equal(artifacts.length, 1);

  const { sent } = await send(fx.registry, artifacts);
  assert.deepEqual(sent, [['image', 'chart.png']]);
});

test('a presented ogg becomes a voice note and any other file a document', async (t) => {
  const fx = await fixture(t);
  const voice = join(fx.workspace, 'note.ogg');
  const document = join(fx.workspace, 'report.txt');
  await writeFile(voice, 'OggS voice payload');
  await writeFile(document, 'report body');

  assert.equal(await present(fx.registry, fx.session, [{ path: voice }, { path: document }]), 2);
  await fx.registry.settle(SESSION_ID, TURN);
  const artifacts = fx.registry.take(SESSION_ID, TURN);

  const { sent, delivery } = await send(fx.registry, artifacts);
  assert.deepEqual(sent, [['voice', 'note.ogg'], ['file', 'report.txt']]);
  assert.equal(delivery.artifactsSent, 2);
});

test('a file already returned by dsh_im_return_file is not sent twice', async (t) => {
  const fx = await fixture(t);
  const path = join(fx.workspace, 'report.txt');
  await writeFile(path, 'report body');
  const tool = createOutboundArtifactTool({ registry: fx.registry });

  const agent = { session: fx.session };
  const exec = execution(agent, 'return-first');
  await tool.definition.execute({ path }, exec);
  tool.onResult(exec, { isError: false });

  assert.equal(await present(fx.registry, fx.session, [{ path }]), 0);
  await fx.registry.settle(SESSION_ID, TURN);
  const artifacts = fx.registry.take(SESSION_ID, TURN);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].registeredBy.kind, 'tool-result');
});

test('a file presented before dsh_im_return_file is not sent twice either', async (t) => {
  const fx = await fixture(t);
  const path = join(fx.workspace, 'chart.png');
  await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const tool = createOutboundArtifactTool({ registry: fx.registry });

  assert.equal(await present(fx.registry, fx.session, [{ path }]), 1);
  const agent = { session: fx.session };
  const exec = execution(agent, 'return-second');
  const queued = await tool.definition.execute({ path }, exec);
  tool.onResult(exec, { isError: false });

  await fx.registry.settle(SESSION_ID, TURN);
  const artifacts = fx.registry.take(SESSION_ID, TURN);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].registeredBy.kind, 'presented');
  assert.equal(queued.artifactId, artifacts[0].artifactId);
});

test('the same file presented twice in one turn is sent once', async (t) => {
  const fx = await fixture(t);
  const path = join(fx.workspace, 'chart.png');
  await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  assert.equal(await present(fx.registry, fx.session, [{ path }]), 1);
  assert.equal(await present(fx.registry, fx.session, [{ path }], { callId: 'call-again' }), 0);
  await fx.registry.settle(SESSION_ID, TURN);
  assert.equal(fx.registry.take(SESSION_ID, TURN).length, 1);
});

test('a symlink to the same file counts as the same file', async (t) => {
  const fx = await fixture(t);
  const path = join(fx.workspace, 'report.txt');
  const link = join(fx.workspace, 'report-link.txt');
  await writeFile(path, 'report body');
  const { symlink } = await import('node:fs/promises');
  try {
    await symlink(path, link);
  } catch (error) {
    if (['EACCES', 'EPERM', 'ENOSYS'].includes(error?.code)) {
      t.skip('symbolic links are unavailable in this environment');
      return;
    }
    throw error;
  }

  assert.equal(await present(fx.registry, fx.session, [{ path }]), 1);
  assert.equal(await present(fx.registry, fx.session, [{ path: link }], { callId: 'link' }), 0);
  await fx.registry.settle(SESSION_ID, TURN);
  assert.equal(fx.registry.take(SESSION_ID, TURN).length, 1);
});

test('a presented file with a broken path does not fail the turn', async (t) => {
  const fx = await fixture(t);
  const path = join(fx.workspace, 'chart.png');
  await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const warnings = [];

  const pending = present(fx.registry, fx.session, [
    { path: join(fx.workspace, 'gone.png') },
    { path: fx.workspace },
    { path },
  ], { logger: { warn: (...args) => warnings.push(args) } });

  assert.equal(await pending, 1);
  await fx.registry.settle(SESSION_ID, TURN);
  const artifacts = fx.registry.take(SESSION_ID, TURN);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].fileName, 'chart.png');
  assert.equal(warnings.length, 2, 'a missing file and a directory are each reported once');
  for (const artifact of artifacts) releaseOutboundArtifact(artifact);
});

test('a Web turn without an IM consumer keeps its presented files out of the channel', async (t) => {
  const fx = await fixture(t, { consumer: false });
  const path = join(fx.workspace, 'chart.png');
  await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  openTurn(fx.registry, fx.session, TURN, 'web-rpc');
  const warnings = [];

  assert.equal(await present(fx.registry, fx.session, [{ path }], {
    logger: { warn: (...args) => warnings.push(args) },
  }), null);
  await fx.registry.settle(SESSION_ID, TURN);
  assert.deepEqual(fx.registry.take(SESSION_ID, TURN), []);
  // Files stay out of the channel, but the drop is no longer silent: a record that
  // never arrives used to cost hours of hunting through a log that said nothing.
  assert.equal(warnings.length, 1, 'the reason is named');
  assert.match(String(warnings[0][0]), /no delivery consumer/u);
});

test('a copy that outlives turn/end is still delivered', async (t) => {
  // The channel claims from its own poll, after the turn is over: the copy and the
  // hash run behind the event, and a large file can finish late. A closed turn
  // reports no current turn, which is not a reason to delete the file.
  const fx = await fixture(t);
  const path = join(fx.workspace, 'chart.png');
  // Large enough that the copy cannot finish inside the same microtask as the
  // event: the point of the test is the window between them.
  await writeFile(path, Buffer.alloc(4 * 1024 * 1024, 7));

  const pending = present(fx.registry, fx.session, [{ path }]);
  fx.registry.observeSessionEvent(fx.session, { type: 'turn/end', data: { turn: TURN } });
  await pending;

  await fx.registry.settle(SESSION_ID, TURN);
  const artifacts = fx.registry.take(SESSION_ID, TURN);
  assert.equal(artifacts.length, 1, 'the file survives its own late copy');
  assert.equal(artifacts[0].fileName, 'chart.png');
  const { sent } = await send(fx.registry, artifacts);
  assert.deepEqual(sent, [['image', 'chart.png']]);
});

test('a presented event for an already closed turn is ignored', async (t) => {
  const fx = await fixture(t);
  const path = join(fx.workspace, 'chart.png');
  await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fx.registry.observeSessionEvent(fx.session, { type: 'turn/end', data: { turn: TURN } });

  assert.equal(await present(fx.registry, fx.session, [{ path }]), null);
  await fx.registry.settle(SESSION_ID, TURN);
  const artifacts = fx.registry.take(SESSION_ID, TURN);
  assert.deepEqual(artifacts, []);
});

test('a claim taken before the snapshot registers finds nothing', async (t) => {
  const fx = await fixture(t);
  const path = join(fx.workspace, 'chart.png');
  await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const pending = present(fx.registry, fx.session, [{ path }]);
  // The copy and the hash run after the event, so a claim taken right here
  // finds nothing: this is the race the channel's settle() call avoids.
  assert.deepEqual(fx.registry.take(SESSION_ID, TURN), []);
  await pending;
});

test('settle waits for a presented snapshot the claim would miss', async (t) => {
  const fx = await fixture(t);
  const path = join(fx.workspace, 'chart.png');
  await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const pending = present(fx.registry, fx.session, [{ path }]);
  await fx.registry.settle(SESSION_ID, TURN);
  const artifacts = fx.registry.take(SESSION_ID, TURN);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].fileName, 'chart.png');
  await pending;
});

test('the installed plugin forwards presented files, and the option turns that off', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-im-presented-install-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const path = join(workspace, 'chart.png');
  await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const install = (options) => {
    const listeners = new Map();
    let definition;
    const registry = new OutboundArtifactRegistry();
    t.after(() => registry.clear());
    const installed = installOutboundArtifactTool({
      logger: () => ({ info() {}, warn() {} }),
      tools: { register(value) { definition = value; } },
      on(name, value) { listeners.set(name, value); },
      systemPrompt: { context() {}, section() {} },
    }, { registry, ...options });
    assert.equal(installed, true);
    assert.equal(definition.name, OUTBOUND_ARTIFACT_TOOL);
    const session = { header: { id: SESSION_ID, cwd: workspace } };
    const close = registry.openConsumer(SESSION_ID, PROMPT_RPC_ID);
    t.after(close);
    const emit = (type, data) => listeners.get('session/event')(session, { type, data });
    emit('turn/start', { turn: TURN });
    emit('user/message', { turn: TURN, source: { rpcId: PROMPT_RPC_ID } });
    return { registry, emit };
  };

  const enabled = install({});
  enabled.emit('deliverables/presented', { turn: TURN, callId: 'on', files: [{ path }] });
  await enabled.registry.settle(SESSION_ID, TURN);
  assert.equal(enabled.registry.take(SESSION_ID, TURN).length, 1);

  const disabled = install({ deliverPresentedFiles: false });
  disabled.emit('deliverables/presented', { turn: TURN, callId: 'off', files: [{ path }] });
  await disabled.registry.settle(SESSION_ID, TURN);
  assert.deepEqual(disabled.registry.take(SESSION_ID, TURN), []);
});

test('the installed listener hears Session events dispatched from another scope', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-im-presented-scoped-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const path = join(workspace, 'chart.png');
  await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const registry = new OutboundArtifactRegistry();
  t.after(() => registry.clear());
  const scope = Symbol('dsh-scope');
  const sessionScope = Symbol('session-scope');
  const root = new Context();
  // dsh-im's own context is tagged with its scope, while every Session belongs
  // to another one — dsh-session publishes through the carrier built by
  // scopeTarget(), whose filter admits an untagged listener or the Session's
  // own scope chain, and drops a tagged sibling unless it registered globally.
  const pluginCtx = root.extend({ [scope]: Symbol('dsh-im-scope') });
  const carrier = {
    [Context.filter](ctx) {
      const tag = ctx[scope];
      return tag === undefined || tag === sessionScope;
    },
  };
  const installed = installOutboundArtifactTool({
    logger: () => ({ info() {}, warn() {} }),
    on: (...listener) => pluginCtx.on(...listener),
    tools: { register() {} },
    systemPrompt: { context() {}, section() {} },
  }, { registry });
  assert.equal(installed, true);

  // The premise of this test, spelled out: the same carrier drops a plain
  // listener on the tagged context, so a session event only arrives globally.
  let plainListenerCalls = 0;
  pluginCtx.on('session/event', () => { plainListenerCalls += 1; });

  const session = { header: { id: SESSION_ID, cwd: workspace } };
  const close = registry.openConsumer(SESSION_ID, PROMPT_RPC_ID);
  t.after(close);
  openTurn(registry, session, TURN);

  const event = {
    type: 'deliverables/presented',
    data: { turn: TURN, callId: 'scoped-present', files: [{ path }] },
  };
  const callbacks = [...root.events.dispatch('emit', [carrier, 'session/event', session, event])];
  for (const callback of callbacks) callback(session, event);

  assert.equal(plainListenerCalls, 0);
  await registry.settle(SESSION_ID, TURN);
  const artifacts = registry.take(SESSION_ID, TURN);
  assert.equal(artifacts.length, 1, 'a scoped Session event must still reach the delivery queue');
  assert.equal(artifacts[0].fileName, 'chart.png');
});
