import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FLOORS,
  evaluateFloors,
  percentile,
  materialize,
  buildCorpus,
  defineSuites,
  makeRng,
} from '../scripts/benchmark-channels.mjs';

// 契约测试：基准的判据本身必须有牙。
// 这里**不测真实耗时**（CI 机器速度不可控，测时间会变成随机红灯）；测的是判定函数
// 与语料的形状契约。真实读数由 npm run benchmark 与 CI 的警告态 job 负责。

test('every suite has a finite positive floor and the tables match exactly', () => {
  const suites = defineSuites(buildCorpus(50));
  const names = suites.map((s) => s.name);
  // 下限表必须**恰好**覆盖 suite 清单：加一项忘配下限 ⇒ 缺下限判红；
  // 删一项留下限 ⇒ 多余下限同样判红。拦的是「删掉慢的项来通过基准」。
  assert.deepEqual(Object.keys(FLOORS).sort(), [...names].sort());
  for (const [name, floor] of Object.entries(FLOORS)) {
    assert.equal(Number.isFinite(floor) && floor > 0, true, name + ' floor must be finite and positive');
  }
});

test('evaluateFloors passes at exactly the floor and fails a hair below', () => {
  const results = [{ name: 'a', opsPerSecond: 1000 }];
  assert.deepEqual(evaluateFloors(results, { a: 1000 }), [], 'at the floor is passing');
  const breaches = evaluateFloors(results, { a: 1001 });
  assert.equal(breaches.length, 1, 'one below the floor must breach');
  assert.equal(breaches[0].reason, 'below-floor');
  assert.equal(breaches[0].measured, 1000, 'the breach names the measured value for triage');
});

test('a missing suite breaches instead of silently passing', () => {
  // 「删项过基准」的直接负控：results 里没有该 suite 时不得返回空 breaches。
  const breaches = evaluateFloors([], { 'feishu.extractText': 1 });
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].reason, 'missing-suite');
});

test('broken clock readings (NaN / negative / zero) cannot report OK', () => {
  for (const value of [NaN, -1, 0, -Infinity]) {
    const breaches = evaluateFloors([{ name: 'x', opsPerSecond: value }], { x: 10 });
    assert.equal(breaches.length, 1, 'value=' + String(value) + ' must breach');
  }
});

test('known edge: Infinity passes the floor comparison, and that is recorded on purpose', () => {
  // Infinity >= 任何下限 ⇒ 判绿。它只可能是「分母为 0 的坏读数」。
  // 本轮不把它判红，因为改判定会让已写回的下限标定与 CI 首次读数失去可比性；
  // 登记为 M3.2（runBenchmark 应在 samples 含 0ms 时拒绝出数）。
  // 把这条行为钉成测试，防止将来有人「顺手」改掉而没人察觉。
  assert.equal(evaluateFloors([{ name: 'x', opsPerSecond: Infinity }], { x: 10 }).length, 0);
});

test('materialize consumes string content, not just the shell V8 hands back', () => {
  // V8 的 slice 会造 SlicedString：只读 .length 是 O(1)，基准会停在壳上。
  // materialize 必须真的碰字符 —— 用「等长不同内容」这对输入来证。
  const base = 'a'.repeat(64) + 'b' + 'c'.repeat(64);
  const same = 'a'.repeat(64) + 'x' + 'c'.repeat(64);
  assert.equal(base.length, same.length, 'shells of identical length');
  assert.notEqual(materialize(base), materialize(same), 'content must change the sum');
});

test('percentile uses nearest-rank and is input-order independent', () => {
  // 秩定义：index = ceil(p * n) - 1。返回真实样本，不做插值。
  assert.equal(percentile([5, 1, 9, 3], 0.5), 3, 'even n takes the 2nd smallest');
  assert.equal(percentile([5, 1, 9, 3], 0), 1, 'p0 is the minimum');
  assert.equal(percentile([5, 1, 9, 3], 1), 9, 'p1 is the maximum');
  assert.equal(percentile([9, 5, 1, 3], 0.75), 5, 'order must not matter');
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3, 'odd n gives the true median (rounds=5 by default)');
  assert.equal(percentile([], 0.5), 0, 'empty input must not be NaN');
});

test('benchmark corpus preconditions pass on the default corpus', async () => {
  // 语料没命中目标分支 ⇒ 基准拒绝出数。这条保证默认语料是真能用的。
  const corpus = buildCorpus(400);
  for (const suite of defineSuites(corpus)) {
    if (typeof suite.precondition === 'function') {
      assert.equal(suite.precondition(), null, suite.name + ' corpus must hit its measured branch');
    }
  }
  const { splitText } = await import('../src/channels/feishu/message-utils.mjs');
  assert.equal(splitText(corpus.feishuLong[0], 9000).length, 2, 'long corpus item must actually chunk');
});

test('corpus is deterministic across runs (the comparability claim)', () => {
  // 「固定种子 ⇒ 每次输入逐字节相同」是整个基准的地基。两次 buildCorpus 必须
  // 产出同样的摘要；LCG 序列也必须可复现。地基塌了的话所有跨机器比较都无意义。
  const rng = makeRng();
  const first = [rng(), rng(), rng()].map((v) => v.toFixed(12)).join(',');
  const rng2 = makeRng();
  const second = [rng2(), rng2(), rng2()].map((v) => v.toFixed(12)).join(',');
  assert.equal(first, second, 'the same seed replays the same sequence');
  const a = JSON.stringify(buildCorpus(20));
  const b = JSON.stringify(buildCorpus(20));
  assert.equal(a, b, 'identical corpus for identical size+seed');
});
