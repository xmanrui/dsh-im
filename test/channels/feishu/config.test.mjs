import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../../src/channels/feishu/config.mjs';

const KEYS = [
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_SECRET_SERVICE',
  'FEISHU_ALLOWED_OPEN_IDS',
  'HARNESS_WORKSPACE',
  'HARNESS_AGENT_PRESET',
];

function withEnvironment(values, callback) {
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of KEYS) delete process.env[key];
    Object.assign(process.env, values);
    return callback();
  } finally {
    for (const key of KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('loadConfig fails closed when the sender allowlist is empty', () => {
  withEnvironment({
    FEISHU_APP_ID: 'cli_test',
    FEISHU_APP_SECRET: 'test-secret',
    HARNESS_WORKSPACE: '/tmp/test-workspace',
    FEISHU_ALLOWED_OPEN_IDS: ' , ',
  }, () => {
    assert.throws(() => loadConfig(), /FEISHU_ALLOWED_OPEN_IDS/);
  });
});

test('loadConfig parses a deduplicated sender allowlist and defaults to standard', () => {
  withEnvironment({
    FEISHU_APP_ID: 'cli_test',
    FEISHU_APP_SECRET: 'test-secret',
    HARNESS_WORKSPACE: '/tmp/test-workspace',
    FEISHU_ALLOWED_OPEN_IDS: 'ou_one, ou_two,ou_one',
  }, () => {
    const config = loadConfig();
    assert.equal(config.harnessAgentPreset, 'standard');
    assert.deepEqual([...config.allowedSenderOpenIds], ['ou_one', 'ou_two']);
  });
});
