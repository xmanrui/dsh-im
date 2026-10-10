import assert from 'node:assert/strict';
import test from 'node:test';

import {
  modelAttributionLine,
  normalizeModelInfoSetting,
  onReplyModelAttributionChange,
  replyModelAttributionEnabled,
  setReplyModelAttribution,
} from '../../../src/channels/shared/reply-model-attribution.mjs';
import {
  modelAttributionFor,
  withModelAttribution,
} from '../../../src/channels/shared/reply-model-annotate.mjs';

// The switch is global, so each test restores the previous state.
async function withAttribution(value, body) {
  const previous = replyModelAttributionEnabled();
  setReplyModelAttribution(value);
  try {
    await body();
  } finally {
    setReplyModelAttribution(previous);
  }
}

test('model attribution is off by default and never alters a reply', async () => {
  await withAttribution(false, async () => {
    assert.equal(replyModelAttributionEnabled(), false);
    assert.equal(modelAttributionLine('ai-proxy/model-one'), null);
    assert.equal(withModelAttribution('answer', 'ai-proxy/model-one'), 'answer');
  });
});

test('when enabled, the reply names the model on its own line', async () => {
  await withAttribution(true, async () => {
    const result = withModelAttribution('answer body', 'ai-proxy/deepseek-v4.1-flash');
    assert.equal(result, 'answer body\n\n_模型：ai-proxy/deepseek-v4.1-flash_');
  });
});

test('an unresolvable model leaves the answer untouched', async () => {
  await withAttribution(true, async () => {
    // Never invent a placeholder: silence beats a wrong model name.
    assert.equal(withModelAttribution('answer', null), 'answer');
    assert.equal(withModelAttribution('answer', ''), 'answer');
    assert.equal(withModelAttribution('answer', '   '), 'answer');
  });
});

test('an empty answer is not turned into a bare attribution line', async () => {
  await withAttribution(true, async () => {
    assert.equal(withModelAttribution('', 'ai-proxy/model-one'), '');
  });
});

test('the on/off argument accepts the usual spellings and rejects others', () => {
  for (const value of ['on', 'ON', '开', '开启', '1', 'yes', 'true']) {
    assert.equal(normalizeModelInfoSetting(value), true, `${value} should enable`);
  }
  for (const value of ['off', 'OFF', '关', '关闭', '0', 'no', 'false']) {
    assert.equal(normalizeModelInfoSetting(value), false, `${value} should disable`);
  }
  assert.equal(normalizeModelInfoSetting('maybe'), null);
  assert.equal(normalizeModelInfoSetting(''), null);
  assert.equal(normalizeModelInfoSetting(undefined), null);
});

test('a failing or unavailable model lookup never blocks the reply', async () => {
  await withAttribution(true, async () => {
    // No harness, no session, and a throwing RPC all resolve to null.
    assert.equal(await modelAttributionFor(null, 'session-one'), null);
    assert.equal(await modelAttributionFor({}, 'session-one'), null);
    assert.equal(await modelAttributionFor({
      getSessionModels: async () => ({ current: { provider: 'p', model: 'm' } }),
    }, null), null);
    assert.equal(await modelAttributionFor({
      getSessionModels: async () => { throw new Error('RPC failed'); },
    }, 'session-one'), null);
    // A catalog without a current model is not an error, just unknown.
    assert.equal(await modelAttributionFor({
      getSessionModels: async () => ({ groups: [], failures: [] }),
    }, 'session-one'), null);
  });
});

test('the model is resolved from the session catalog when available', async () => {
  await withAttribution(true, async () => {
    const harness = {
      getSessionModels: async () => ({
        groups: [],
        failures: [],
        current: { provider: 'ai-proxy', model: 'deepseek-v4.1-flash' },
      }),
    };
    assert.equal(await modelAttributionFor(harness, 'session-one'), 'ai-proxy/deepseek-v4.1-flash');
  });
});

test('a disabled switch skips the lookup entirely', async () => {
  await withAttribution(false, async () => {
    let called = false;
    const harness = {
      getSessionModels: async () => {
        called = true;
        return { current: { provider: 'p', model: 'm' } };
      },
    };
    assert.equal(await modelAttributionFor(harness, 'session-one'), null);
    assert.equal(called, false, 'no RPC when attribution is off');
  });
});

test('subscribers observe changes and can unsubscribe', async () => {
  const previous = replyModelAttributionEnabled();
  const seen = [];
  const unsubscribe = onReplyModelAttributionChange((next, old) => {
    seen.push([next, old]);
  });
  try {
    setReplyModelAttribution(true);
    setReplyModelAttribution(false);
    assert.deepEqual(seen, [[true, previous], [false, true]]);
  } finally {
    unsubscribe();
    setReplyModelAttribution(previous);
  }
});

test('a throwing subscriber does not strand the others', async () => {
  const previous = replyModelAttributionEnabled();
  const seen = [];
  const off1 = onReplyModelAttributionChange(() => {
    throw new Error('subscriber failure');
  });
  const off2 = onReplyModelAttributionChange((next) => seen.push(next));
  try {
    setReplyModelAttribution(true);
    assert.deepEqual(seen, [true], 'the second subscriber still ran');
  } finally {
    off1();
    off2();
    setReplyModelAttribution(previous);
  }
});
