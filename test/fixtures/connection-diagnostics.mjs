import assert from 'node:assert/strict';
export function assertTestMessageFailure(value) {
  const { error, ...legacy } = value;
  assert.deepEqual(legacy, { sent: false, code: 'test-message-failed' });
  assert.equal(error.details.stage, 'connection.test');
  assert.equal(error.details.operation, 'connection.test');
  assert.match(error.details.referenceId, /^(?:IM|WX|DT)-CONN-[A-F0-9]{8}$/);
  assert.ok(error.details.reason);
}
