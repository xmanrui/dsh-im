import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPABILITIES, collectChannelMatrix, reconcileDeclarations } from '../scripts/channel-capability-matrix.mjs';
import { HOST_CHANNELS, deliveryKeyOf } from '../plugin-src/host/channel-registry.mjs';

// N1 的契约测试。核心不是「注册表里多了一个字段」，而是「这个字段与实现双向对账」——
// 上游 matterbridge 把能力放在第二张表且无人比对，结果 harmony 实现了 typing
// 却永不登记，那段代码不可达且不报错。下面几条就是防我们把同一个病搬回来。

const CHANNELS = [
  { channel: 'alpha', supported: { text: true, voice: true } },
  { channel: 'beta', supported: { text: true, voice: false } },
];
const cap = function (keys) { return Object.freeze(keys); };

test('matching declarations produce no drift', () => {
  const registry = [
    { configKey: 'alpha', capabilities: cap(['text', 'voice']) },
    { configKey: 'beta', capabilities: cap(['text']) },
  ];
  assert.deepEqual(reconcileDeclarations(CHANNELS, registry), []);
});

test('implementation evidence without a declaration is drift (the harmony failure mode)', () => {
  const registry = [
    { configKey: 'alpha', capabilities: cap(['text']) }, // voice 漏登记
    { configKey: 'beta', capabilities: cap(['text']) },
  ];
  const problems = reconcileDeclarations(CHANNELS, registry);
  assert.equal(problems.length, 1, problems.join(' | '));
  assert.ok(problems[0].includes('alpha.voice: implementation evidence'), problems[0]);
  assert.match(problems[0], /not declared/u);
});

test('a declaration the implementation no longer backs is also drift', () => {
  const registry = [
    { configKey: 'alpha', capabilities: cap(['text', 'voice']) },
    { configKey: 'beta', capabilities: cap(['text', 'voice']) }, // beta 其实不支持
  ];
  const problems = reconcileDeclarations(CHANNELS, registry);
  assert.equal(problems.length, 1, problems.join(' | '));
  assert.match(problems[0], /beta\.voice: declared but no implementation evidence/u);
});

test('an entry missing the capabilities field entirely is named, not skipped', () => {
  // 漏写整个字段是「最像没改过」的漂移形态：数组判据会把它当空集合放行，
  // 那等于新增渠道时忘写声明也能绿 —— 正是 N1 要拦的。
  const problems = reconcileDeclarations(CHANNELS, [{ configKey: 'alpha' }, { configKey: 'beta', capabilities: cap(['text']) }]);
  assert.equal(problems.length, 1, problems.join(' | '));
  assert.match(problems[0], /alpha: registry entry has no capabilities array/u);
});

test('a typo in a capability key cannot pass silently', () => {
  // 拼错的键（voise）不在 CAPABILITIES 里；若只拿它做 Set 比对，它会既不算声明
  // 也不算漏项 —— 静默通过。判红才有牙。
  const registry = [
    { configKey: 'alpha', capabilities: cap(['text', 'voise']) },
    { configKey: 'beta', capabilities: cap(['text']) },
  ];
  const problems = reconcileDeclarations(CHANNELS, registry);
  assert.ok(problems.some((p) => /unknown capability key voise/u.test(p)), problems.join(' | '));
});

test('camel configKey maps to the kebab directory name before comparing', () => {
  // wecomApp（注册表）↔ wecom-app（src/channels 目录）是同一渠道的两种写法。
  // 判据必须复用 deliveryKey 那层映射，否则会把真实渠道报成「没有注册条目」。
  const channels = [{ channel: 'wecom-app', supported: { text: true } }];
  const registry = [{ configKey: 'wecomApp', deliveryKey: 'wecom-app', capabilities: cap(['text']) }];
  assert.deepEqual(reconcileDeclarations(channels, registry), []);
});

test('a channel directory without a registry entry is named', () => {
  const problems = reconcileDeclarations([{ channel: 'newthing', supported: { text: true } }], []);
  assert.ok(problems.some((p) => p.includes('newthing: has a channel directory but no host registry entry')), problems.join(' | '));
});

test('a registry entry with no channel directory is named', () => {
  const problems = reconcileDeclarations([], [{ configKey: 'ghost', capabilities: cap([]) }]);
  assert.ok(problems.some((p) => p.includes('ghost: registered in host but no src/channels directory')), problems.join(' | '));
});

// —— 以下是「本仓真实数据」的活体判据：不是合成输入，而是真目录 + 真注册表。——

test('every real channel declares capabilities and they reconcile with evidence', async () => {
  const channels = await collectChannelMatrix();
  assert.equal(channels.length, 14, 'expected fourteen channel directories');
  assert.equal(HOST_CHANNELS.length, 14);
  for (const entry of HOST_CHANNELS) {
    assert.ok(Array.isArray(entry.capabilities), deliveryKeyOf(entry) + ' must declare an array');
    assert.equal(Object.isFrozen(entry.capabilities), true, deliveryKeyOf(entry) + ' capabilities must be frozen');
  }
  const drift = reconcileDeclarations(channels, HOST_CHANNELS);
  assert.deepEqual(drift, [], 'declaration drift: ' + drift.join(' | '));
});

test('an entire channel left undeclared is reported capability by capability', () => {
  // 新增渠道时「忘了写 capabilities」比「写错一项」更常见。空声明必须把每个
  // 有证据的能力逐个点名，而不是只报一句「这个渠道没声明」—— 后者会让人以为
  // 补个空数组就能过门。
  const problems = reconcileDeclarations(
    [{ channel: 'alpha', supported: { text: true, voice: true } }],
    [{ configKey: 'alpha', capabilities: Object.freeze([]) }],
  );
  assert.equal(problems.length, 2, problems.join(' | '));
  assert.ok(problems.every(function (p) { return p.includes('implementation evidence but not declared'); }), problems.join(' | '));
});
test('office declares the empty set explicitly rather than omitting the field', () => {
  // 「没有能力」与「忘了写」必须是两个不同的状态；空数组是显式声明。
  const office = HOST_CHANNELS.find((entry) => entry.configKey === 'office');
  assert.deepEqual(office.capabilities, []);
});

test('declared keys are drawn from the same CAPABILITIES vocabulary', () => {
  const known = new Set(CAPABILITIES.map((capability) => capability.key));
  for (const entry of HOST_CHANNELS) {
    for (const key of entry.capabilities) {
      assert.ok(known.has(key), deliveryKeyOf(entry) + ' declares unknown key ' + key);
    }
  }
});
