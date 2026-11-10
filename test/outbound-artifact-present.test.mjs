import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  OutboundArtifactRegistry,
  materializeOutboundArtifact,
  releaseOutboundArtifact,
} from '../src/channels/shared/semantic/artifact.mjs';

async function fixture(t, { consumer = true } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-im-present-workspace-'));
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true });
  });
  let nextId = 0;
  const registry = new OutboundArtifactRegistry({ uuid: () => `present-id-${++nextId}` });
  t.after(() => registry.clear());
  const session = {
    header: { id: 'session-present', cwd: workspace },
    events: [
      { type: 'turn/start', data: { turn: 4 } },
      { type: 'user/message', data: { turn: 4, source: { rpcId: 'rpc-present' } } },
    ],
  };
  if (consumer) {
    const close = registry.openConsumer('session-present', 'rpc-present');
    t.after(close);
    for (const event of session.events) registry.observeSessionEvent(session, event);
  }
  const warnings = [];
  const logger = { warn: (...args) => warnings.push(args) };
  return { workspace, registry, session, warnings, logger };
}

function presentedEvent(turn, files) {
  return {
    type: 'deliverables/presented',
    data: { turn, callId: 'call-present-1', files },
  };
}

test('a file the host present tool recorded is delivered after the turn', async (t) => {
  const { workspace, registry, session, logger } = await fixture(t);
  const file = join(workspace, 'layers.png');
  await writeFile(file, 'png-bytes');

  registry.adoptPresented(session, presentedEvent(4, [{ path: file, description: '栈层' }]), { logger });
  await registry.adoptionsSettled('session-present', 4);

  const [artifact] = registry.take('session-present', 4);
  assert.ok(artifact, 'the presented file must be claimed for delivery');
  assert.equal(artifact.fileName, 'layers.png');
  assert.equal(artifact.size, 'png-bytes'.length);
  const materialized = await materializeOutboundArtifact(artifact);
  releaseOutboundArtifact(artifact);
  assert.ok(materialized);
});

test('every file the host present tool recorded is delivered, in order', async (t) => {
  const { workspace, registry, session, logger } = await fixture(t);
  const first = join(workspace, 'a.png');
  const second = join(workspace, 'b.png');
  await writeFile(first, 'aaa');
  await writeFile(second, 'bbb');

  registry.adoptPresented(session, presentedEvent(4, [{ path: first }, { path: second }]), { logger });
  await registry.adoptionsSettled('session-present', 4);

  const artifacts = registry.take('session-present', 4);
  assert.deepEqual(artifacts.map((artifact) => artifact.fileName), ['a.png', 'b.png']);
  for (const artifact of artifacts) releaseOutboundArtifact(artifact);
});

test('a presented file outside any IM turn is reported, not delivered', async (t) => {
  const { workspace, registry, session, warnings, logger } = await fixture(t, { consumer: false });
  const file = join(workspace, 'orphan.png');
  await writeFile(file, 'orphan');

  const adoption = registry.adoptPresented(session, presentedEvent(4, [{ path: file }]), { logger });
  assert.equal(adoption, null);
  assert.equal(registry.take('session-present', 4).length, 0);
  assert.equal(warnings.length, 1);
  assert.match(JSON.stringify(warnings[0]), /no IM delivery consumer/);
});

test('an unreadable presented path does not break the turn', async (t) => {
  const { workspace, registry, session, warnings, logger } = await fixture(t);
  const file = join(workspace, 'missing.png');

  registry.adoptPresented(session, presentedEvent(4, [{ path: file }]), { logger });
  await registry.adoptionsSettled('session-present', 4);

  assert.equal(registry.take('session-present', 4).length, 0);
  assert.equal(warnings.length, 1);
  assert.match(JSON.stringify(warnings[0]), /could not adopt/);
});
