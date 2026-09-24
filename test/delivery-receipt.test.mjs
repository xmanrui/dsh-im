import assert from 'node:assert/strict';
import test from 'node:test';

import {
  artifactOutcomeForError,
  createArtifactFailureReceipt,
  createDeliveryReceipt,
  createTextDeliveryBlock,
  mergeDeliveryReceipts,
  providerMessageIdsFor,
} from '../src/channels/shared/semantic/delivery.mjs';

test('text DeliveryBlocks preserve explicit format and legacy strings default to plain', () => {
  const legacy = createTextDeliveryBlock('legacy *text*');
  const markdown = createTextDeliveryBlock({
    kind: 'text',
    text: '# Harness answer',
    format: 'markdown',
  });

  assert.deepEqual(legacy, {
    kind: 'text',
    text: 'legacy *text*',
    format: 'plain',
  });
  assert.deepEqual(markdown, {
    kind: 'text',
    text: '# Harness answer',
    format: 'markdown',
  });
  assert.equal(Object.isFrozen(legacy), true);
  assert.equal(Object.isFrozen(markdown), true);
  assert.throws(
    () => createTextDeliveryBlock({ kind: 'text', text: 'x', format: 'html' }),
    /plain or markdown/,
  );
  assert.throws(() => createTextDeliveryBlock('   '), /non-empty text/);
});

test('DeliveryReceipt validates and freezes the shared versioned contract', () => {
  const receipt = createDeliveryReceipt({
    deliveryId: 'delivery-1',
    presentation: 'feishu-file',
    providerMessageIds: ['om-file', 'om-file'],
    artifacts: [{ artifactId: 'artifact-1', outcome: 'sent' }],
  });

  assert.deepEqual(receipt, {
    schemaVersion: 1,
    deliveryId: 'delivery-1',
    presentation: 'feishu-file',
    providerMessageIds: ['om-file'],
    artifacts: [{ artifactId: 'artifact-1', outcome: 'sent' }],
  });
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.providerMessageIds), true);
  assert.equal(Object.isFrozen(receipt.artifacts[0]), true);
  assert.throws(
    () => createDeliveryReceipt({
      deliveryId: 'delivery-invalid',
      presentation: 'feishu-file',
      artifacts: [{ artifactId: 'artifact-1', outcome: 'maybe' }],
    }),
    /artifact outcome/,
  );
});

test('artifact failures distinguish policy rejection, retryable failure, and uncertain delivery', () => {
  assert.equal(artifactOutcomeForError({ code: 'artifact-permission-required' }), 'rejected');
  assert.equal(artifactOutcomeForError({ code: 'artifact-too-large' }), 'rejected');
  assert.equal(artifactOutcomeForError({ code: 'artifact-unavailable' }), 'rejected');
  assert.equal(artifactOutcomeForError({ code: 'artifact-rate-limited' }), 'failed');
  assert.equal(artifactOutcomeForError(new Error('network unavailable')), 'failed');
  assert.equal(artifactOutcomeForError({ code: 'artifact-delivery-uncertain' }), 'unknown');

  assert.deepEqual(createArtifactFailureReceipt({
    artifactId: 'artifact-uncertain',
    deliveryId: 'delivery-uncertain',
    error: { code: 'artifact-delivery-uncertain' },
  }).artifacts, [{
    artifactId: 'artifact-uncertain',
    outcome: 'unknown',
    reason: 'artifact-delivery-uncertain',
  }]);
});

test('provider message ids are collected only from explicit message-id fields', () => {
  assert.deepEqual(providerMessageIdsFor({ message_id: 42 }), ['42']);
  assert.deepEqual(providerMessageIdsFor({ key: { id: 'wamid-one' } }), ['wamid-one']);
  assert.deepEqual(providerMessageIdsFor({ ts: '123.456' }), ['123.456']);
  assert.deepEqual(providerMessageIdsFor({ body: { msgid: 'wecom-one' } }), ['wecom-one']);
  assert.deepEqual(providerMessageIdsFor({
    providerMessageIds: ['first', 'second', 'first', '', null],
  }), ['first', 'second']);
  assert.deepEqual(providerMessageIdsFor({ processQueryKey: 'not-a-message-id' }), []);
  assert.deepEqual(providerMessageIdsFor({ files: [{ id: 'not-a-message-id' }] }), []);
});

test('text and multiple artifact attempts merge into one authoritative receipt', () => {
  const text = createDeliveryReceipt({
    deliveryId: 'turn-message',
    presentation: 'feishu-cardkit',
    providerMessageIds: ['om-card'],
  });
  const sent = createDeliveryReceipt({
    deliveryId: 'file-1',
    presentation: 'feishu-file',
    providerMessageIds: ['om-file'],
    artifacts: [{ artifactId: 'artifact-1', outcome: 'sent' }],
  });
  const failed = createArtifactFailureReceipt({
    artifactId: 'artifact-2',
    deliveryId: 'file-2',
    error: { code: 'artifact-rate-limited' },
    providerMessageIds: ['om-notice'],
  });

  assert.deepEqual(mergeDeliveryReceipts({
    deliveryId: 'turn-message',
    presentation: 'feishu-text-and-files',
    receipts: [text, sent, failed],
  }), {
    schemaVersion: 1,
    deliveryId: 'turn-message',
    presentation: 'feishu-text-and-files',
    providerMessageIds: ['om-card', 'om-file', 'om-notice'],
    artifacts: [
      { artifactId: 'artifact-1', outcome: 'sent' },
      { artifactId: 'artifact-2', outcome: 'failed', reason: 'artifact-rate-limited' },
    ],
  });
});

test('DeliveryReceipt optionally preserves final delivery outcome without changing legacy receipts', () => {
  const legacy = createDeliveryReceipt({
    deliveryId: 'legacy',
    presentation: 'telegram-text',
  });
  const uncertain = createDeliveryReceipt({
    deliveryId: 'rich',
    presentation: 'telegram-rich-final',
    deliveryOutcome: 'unknown',
    reason: 'telegram-timeout',
  });

  assert.equal(Object.hasOwn(legacy, 'deliveryOutcome'), false);
  assert.deepEqual(uncertain, {
    schemaVersion: 1,
    deliveryId: 'rich',
    presentation: 'telegram-rich-final',
    providerMessageIds: [],
    deliveryOutcome: 'unknown',
    reason: 'telegram-timeout',
    artifacts: [],
  });
  assert.throws(() => createDeliveryReceipt({
    deliveryId: 'invalid',
    presentation: 'telegram-rich-final',
    deliveryOutcome: 'maybe',
  }), /deliveryOutcome/);
});
