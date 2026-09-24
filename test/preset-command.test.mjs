import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPresetCommand,
  PRESET_LIST_SNAPSHOT_MAX_ENTRIES,
  PRESET_LIST_SNAPSHOT_TTL_MS,
  runPresetCommand,
} from '../src/channels/shared/preset-command.mjs';
import { withSessionBindingLock } from '../src/channels/shared/session-binding-lock.mjs';

const CATALOG = Object.freeze({
  defaultId: 'standard',
  items: Object.freeze([
    Object.freeze({ id: 'standard', label: 'Standard' }),
    Object.freeze({ id: 'coding', label: 'Coding' }),
    Object.freeze({ id: 'marketing', label: 'Marketing' }),
  ]),
});

function fixture({
  agentPreset = null,
  catalog = CATALOG,
  settingsError = null,
  updateError = null,
  updateHook = null,
} = {}) {
  const calls = [];
  let selected = agentPreset;
  const harness = {
    async agentPresetSettings(options) {
      calls.push(['agentPresetSettings', options]);
      if (settingsError) throw settingsError;
      const currentCatalog = typeof catalog === 'function' ? catalog() : catalog;
      return { agentPreset: selected, agentPresetCatalog: currentCatalog };
    },
    async updateAgentPreset(value, options) {
      calls.push(['updateAgentPreset', value, options]);
      if (updateHook) await updateHook({ value, options });
      if (updateError) throw updateError;
      selected = value;
      const currentCatalog = typeof catalog === 'function' ? catalog() : catalog;
      return { agentPreset: selected, agentPresetCatalog: currentCatalog };
    },
  };
  return { calls, harness, state: {}, selected: () => selected };
}

test('isPresetCommand recognizes /presets, /presetlist, and /preset command prefixes', () => {
  for (const command of [
    '/presetlist', ' /PRESETLIST ', '/presetlist ignored', '/presets', ' /PRESETS ',
    '/preset', '/PrEsEt coding',
  ]) {
    assert.equal(isPresetCommand(command), true, command);
  }
  for (const value of [
    null, '', 'preset', '/presetx', '/presetlisting', '/presetss', 'hello /preset',
  ]) {
    assert.equal(isPresetCommand(value), false, String(value));
  }
});

test('/presets reuses /presetlist validation, listing, and snapshot behavior', async () => {
  const { calls, harness, state } = fixture({ agentPreset: 'coding' });
  const listed = await runPresetCommand('  /PRESETS  ', harness, state, 'direct:alias');

  assert.match(listed.message, /2\. Coding（coding）（当前选择）/);
  assert.deepEqual(calls, [['agentPresetSettings', {}]]);

  const selected = await runPresetCommand('/preset 1', harness, state, 'direct:alias');
  assert.match(selected.message, /Standard（standard）/);
  assert.deepEqual(calls.at(-1), ['updateAgentPreset', 'standard', {}]);

  const invalid = await runPresetCommand('/presets unexpected', harness, state, 'direct:alias');
  assert.match(invalid.message, /用法：\/presetlist/);
});

test('/presetlist dynamically lists, annotates, and snapshots presets without updating', async () => {
  const { calls, harness, state } = fixture({ agentPreset: 'coding' });
  const signal = new AbortController().signal;
  const result = await runPresetCommand('/PRESETLIST', harness, state, 'direct:one', { signal });

  assert.match(result.message, /当前机器人用于新会话/);
  assert.match(result.message, /Host 默认：Standard（standard）/);
  assert.match(result.message, /1\. Standard（standard）（Host 默认）/);
  assert.match(result.message, /2\. Coding（coding）（当前选择）/);
  assert.match(result.message, /\/preset --default/);
  assert.deepEqual(calls, [['agentPresetSettings', { signal }]]);

  const selected = await runPresetCommand('/preset 2', harness, state, 'direct:one');
  assert.match(selected.message, /Coding（coding）/);
  assert.deepEqual(calls.at(-1), ['updateAgentPreset', 'coding', {}]);
});

test('/presetlist shows following Host default as the effective preset', async () => {
  const { harness, state } = fixture();
  const result = await runPresetCommand('/presetlist', harness, state, 'direct:one');

  assert.match(result.message, /跟随 Host 默认：Standard（standard）/);
  assert.match(result.message, /Standard（standard）（Host 默认，当前生效）/);
});

test('/presetlist filters invalid, duplicate, and broken entries and sanitizes labels', async () => {
  const catalog = {
    defaultId: 'safe',
    items: [
      { id: 'safe', label: 'Safe\nPreset\u202e' },
      { id: 'safe', label: 'Duplicate' },
      { id: 'UPPER', label: 'Invalid' },
      { id: 'broken', label: 'Broken', broken: { message: 'secret' } },
    ],
  };
  const { harness, state } = fixture({ catalog });
  const result = await runPresetCommand('/presetlist', harness, state, 'direct:one');

  assert.match(result.message, /可用 Agent Preset（1）/);
  assert.match(result.message, /Safe Preset（safe）/);
  assert.doesNotMatch(result.message, /Duplicate|Invalid|Broken|secret|\u202e/);
});

test('/preset reports an explicit unavailable current preset without changing it', async () => {
  const { calls, harness, state, selected } = fixture({ agentPreset: 'removed' });
  const result = await runPresetCommand('/preset', harness, state, 'direct:one');

  assert.match(result.message, /removed（已不可用）/);
  assert.match(result.message, /已有会话不会受此设置影响/);
  assert.equal(selected(), 'removed');
  assert.equal(calls.some(([name]) => name === 'updateAgentPreset'), false);
});

test('/preset and /presetlist expose an unavailable Host default safely', async () => {
  const catalog = { defaultId: 'removed-default', items: CATALOG.items };
  const current = fixture({ catalog });
  assert.match(
    (await runPresetCommand('/preset', current.harness, current.state, 'direct:one')).message,
    /跟随 Host 默认（Host 默认当前不可用）/,
  );

  const listed = fixture({ catalog });
  assert.match(
    (await runPresetCommand('/presetlist', listed.harness, listed.state, 'direct:one')).message,
    /Host 默认：removed-default（当前不可用）/,
  );
});

test('numeric selection requires a snapshot for the same state and conversation key', async () => {
  const first = fixture();
  assert.match(
    (await runPresetCommand('/preset 1', first.harness, first.state, 'direct:one')).message,
    /先执行 \/presetlist/,
  );
  assert.equal(first.calls.length, 0);

  await runPresetCommand('/presetlist', first.harness, first.state, 'direct:one');
  assert.match(
    (await runPresetCommand('/preset 1', first.harness, first.state, 'direct:two')).message,
    /先执行 \/presetlist/,
  );

  const otherState = {};
  assert.match(
    (await runPresetCommand('/preset 1', first.harness, otherState, 'direct:one')).message,
    /先执行 \/presetlist/,
  );
});

test('numeric selection rejects an expired snapshot and requires a new /presetlist', async (t) => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const { calls, harness, state } = fixture();
  await runPresetCommand('/presetlist', harness, state, 'direct:one');

  now += PRESET_LIST_SNAPSHOT_TTL_MS - 1;
  const stillFresh = await runPresetCommand('/preset 1', harness, state, 'direct:one');
  assert.match(stillFresh.message, /Standard（standard）/);

  now += 1;
  const expired = await runPresetCommand('/preset 1', harness, state, 'direct:one');

  assert.match(expired.message, /请先执行 \/presetlist/);
  assert.equal(calls.filter(([name]) => name === 'updateAgentPreset').length, 1);
});

test('numeric snapshots are capacity-bounded and evicted in LRU order', async () => {
  const { calls, harness, state } = fixture();
  for (let index = 0; index < PRESET_LIST_SNAPSHOT_MAX_ENTRIES; index += 1) {
    await runPresetCommand('/presetlist', harness, state, `direct:${index}`);
  }

  await runPresetCommand('/preset 1', harness, state, 'direct:0');
  await runPresetCommand(
    '/presetlist',
    harness,
    state,
    `direct:${PRESET_LIST_SNAPSHOT_MAX_ENTRIES}`,
  );

  const evicted = await runPresetCommand('/preset 1', harness, state, 'direct:1');
  assert.match(evicted.message, /请先执行 \/presetlist/);
  const retained = await runPresetCommand('/preset 1', harness, state, 'direct:0');
  assert.match(retained.message, /Standard（standard）/);
  assert.equal(calls.filter(([name]) => name === 'updateAgentPreset').length, 2);
});

test('numeric selection keeps the listed ID when the fresh catalog is reordered', async () => {
  let currentCatalog = CATALOG;
  const fixtureValue = fixture({ catalog: () => currentCatalog });
  await runPresetCommand(
    '/presetlist',
    fixtureValue.harness,
    fixtureValue.state,
    'direct:one',
  );
  currentCatalog = {
    defaultId: 'standard',
    items: [CATALOG.items[2], CATALOG.items[0], CATALOG.items[1]],
  };

  await runPresetCommand('/preset 2', fixtureValue.harness, fixtureValue.state, 'direct:one');
  assert.deepEqual(
    fixtureValue.calls.findLast(([name]) => name === 'updateAgentPreset'),
    ['updateAgentPreset', 'coding', {}],
  );
});

test('/preset rejects invalid and out-of-range numeric selections without updating', async () => {
  const { calls, harness, state } = fixture();
  await runPresetCommand('/presetlist', harness, state, 'direct:one');

  for (const requested of ['0', '4', '9007199254740992']) {
    const result = await runPresetCommand(`/preset ${requested}`, harness, state, 'direct:one');
    assert.match(result.message, /序号.*无效|序号不存在/, requested);
  }
  assert.equal(calls.filter(([name]) => name === 'updateAgentPreset').length, 0);
});

test('/preset accepts exact IDs and id: for a purely numeric ID', async () => {
  const direct = fixture();
  const directResult = await runPresetCommand(
    '/preset marketing',
    direct.harness,
    direct.state,
    'direct:one',
  );
  assert.match(directResult.message, /Marketing（marketing）/);
  assert.deepEqual(direct.calls.at(-1), ['updateAgentPreset', 'marketing', {}]);

  const numericCatalog = {
    defaultId: '123',
    items: [{ id: '123', label: 'Numeric' }],
  };
  const numeric = fixture({ catalog: numericCatalog });
  const numericResult = await runPresetCommand(
    '/preset id:123',
    numeric.harness,
    numeric.state,
    'direct:one',
  );
  assert.match(numericResult.message, /Numeric（123）/);
  assert.deepEqual(numeric.calls.at(-1), ['updateAgentPreset', '123', {}]);
});

test('/preset --default clears the override without first reading the catalog', async () => {
  const settingsError = new Error('catalog private failure');
  const { calls, harness, state, selected } = fixture({
    agentPreset: 'coding',
    settingsError,
  });
  const signal = new AbortController().signal;
  const result = await runPresetCommand(
    '/preset --DEFAULT',
    harness,
    state,
    'direct:one',
    { signal },
  );

  assert.match(result.message, /跟随 Host 默认/);
  assert.equal(selected(), null);
  assert.deepEqual(calls, [['updateAgentPreset', null, { signal }]]);
  assert.doesNotMatch(result.message, /private/);
});

test('/preset updates even while an interaction is pending and never consults Session state', async () => {
  const { calls, harness, state } = fixture();
  state.sessionFor = () => {
    throw new Error('must not inspect current Session');
  };
  const result = await runPresetCommand(
    '/preset coding',
    harness,
    state,
    'direct:one',
    { pendingInteraction: true, control: { owner: 'one' } },
  );

  assert.match(result.message, /已设置为/);
  assert.match(result.message, /先发送 \/new/);
  assert.deepEqual(calls, [['updateAgentPreset', 'coding', {}]]);
});

test('/preset serializes with the next Session-binding transaction', async () => {
  let releaseUpdate;
  let markUpdateStarted;
  const updateStarted = new Promise((resolve) => { markUpdateStarted = resolve; });
  const updateGate = new Promise((resolve) => { releaseUpdate = resolve; });
  const order = [];
  const { harness, state } = fixture({
    updateHook: async () => {
      markUpdateStarted();
      await updateGate;
      order.push('preset');
    },
  });
  const updating = runPresetCommand('/preset coding', harness, state, 'direct:one');
  await updateStarted;
  const binding = withSessionBindingLock(state, 'direct:one', async () => {
    order.push('session');
  });

  await Promise.resolve();
  assert.deepEqual(order, []);
  releaseUpdate();
  await Promise.all([updating, binding]);
  assert.deepEqual(order, ['preset', 'session']);
});

test('preset commands validate syntax and reject images without calling the harness', async () => {
  const { calls, harness, state } = fixture();
  for (const command of ['/presetlist extra', '/preset coding extra', '/preset id:abc']) {
    const result = await runPresetCommand(command, harness, state, 'direct:one');
    assert.match(result.message, /用法|格式无效/, command);
  }

  for (const command of ['/preset', '/presetlist', '/preset coding']) {
    const result = await runPresetCommand(command, harness, state, 'direct:one', {
      hasImages: true,
    });
    assert.match(result.message, /仅支持纯文字/, command);
  }
  assert.equal(calls.length, 0);
});

test('fresh validation failures and internal errors use safe messages', async () => {
  const unavailableError = new Error('path=/private/preset token=secret');
  unavailableError.code = 'agent-preset-unavailable';
  const unavailable = fixture({ updateError: unavailableError });
  const unavailableResult = await runPresetCommand(
    '/preset coding',
    unavailable.harness,
    unavailable.state,
    'direct:one',
  );
  assert.match(unavailableResult.message, /不存在或当前不可用/);
  assert.doesNotMatch(unavailableResult.message, /private|secret/);

  const missingError = new Error('bot details');
  missingError.code = 'workspace-bot-not-found';
  const missing = fixture({ updateError: missingError });
  assert.match(
    (await runPresetCommand('/preset coding', missing.harness, missing.state, 'direct:one')).message,
    /机器人状态已发生变化/,
  );

  const listing = fixture({ settingsError: new Error('private catalog endpoint') });
  const listingResult = await runPresetCommand(
    '/presetlist',
    listing.harness,
    listing.state,
    'direct:one',
  );
  assert.match(listingResult.message, /暂时无法获取 Agent Preset 列表/);
  assert.doesNotMatch(listingResult.message, /private catalog endpoint/);
});

test('cancelled and malformed harness results fail safely', async () => {
  const cancelledError = new Error('secret abort details');
  cancelledError.name = 'AbortError';
  const cancelled = fixture({ settingsError: cancelledError });
  assert.match(
    (await runPresetCommand(
      '/presetlist',
      cancelled.harness,
      cancelled.state,
      'direct:one',
    )).message,
    /列表已取消/,
  );

  const badHarness = {
    async agentPresetSettings() {
      return { agentPreset: null, agentPresetCatalog: { items: null } };
    },
  };
  const result = await runPresetCommand('/preset', badHarness, {}, 'direct:one');
  assert.match(result.message, /暂时无法获取 Agent Preset 设置/);
});

test('/presetlist splits long output into lossless 1,800-character messages', async () => {
  const catalog = {
    defaultId: 'preset-000',
    items: Array.from({ length: 80 }, (_, index) => ({
      id: `preset-${String(index).padStart(3, '0')}`,
      label: `Preset ${index} ${'x'.repeat(80)}`,
    })),
  };
  const { harness, state } = fixture({ catalog });
  const result = await runPresetCommand('/presetlist', harness, state, 'direct:one');

  assert.ok(result.messages.length > 1);
  assert.ok(result.messages.every((message) => message.length <= 1_800));
  assert.equal(result.messages.join(''), result.message);
  assert.match(result.message, /80\. Preset 79/);
});

test('non-preset input is left for ordinary message routing', async () => {
  assert.equal(await runPresetCommand('hello', {}, {}, 'direct:one'), null);
});
