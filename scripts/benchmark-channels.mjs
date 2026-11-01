#!/usr/bin/env node
// benchmark-channels.mjs — 渠道热路径吞吐/延迟基准（改进项 M3）。
//
// 为什么需要它：八维对标里「性能表现」是本仓唯一的量化空白（报告 §2.4）——
// 全仓零基准，只有单点修复记录（34.5s→156ms）。没有基准时，任何「这里变慢了」
// 既无法证实也无法证伪，性能回归只能等用户报障才发现。
//
// 测什么：只测纯 CPU 的入站/出站热路径（消息解析、归一化、触发判定、
// 拟人化排版、长文切分）。网络/IO/子进程不进基准 —— 那些的方差来自机器与
// 网络，测到的是环境噪声而不是代码性能，会把基准变成随机红灯。
//
// 怎么做到可比：语料由固定种子的线性同余发生器（LCG）预生成 ⇒ 每次输入
// 逐字节相同；先 warmup 让 JIT 分层编译稳定；每项多轮取轮内中位数。
//
// 判据形态：BENCHMARK_OK / BENCHMARK_BELOW_FLOOR（跌破下限）。CI 以警告态
// 运行（免费 runner 的算力抖动不该把 PR 判红），但下限判定本身有牙：
// 负控在 test/benchmark-floor.test.mjs。

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractText, splitText } from '../src/channels/feishu/message-utils.mjs';
import { normalizeMatrixTimelineEvent, EventDedupeRing } from '../src/channels/matrix/matrix-normalize.mjs';
import { planOutbound, stripMachinePhrases, flattenMarkdown } from '../src/channels/shared/humanize-outbound.mjs';
import { decideObserved } from '../src/channels/weixin/wechat-group-runtime.mjs';

const CORPUS_SIZE = 400;
const WARMUP_ROUNDS = 2;
const MEASURE_ROUNDS = 5;

/**
 * 确定性语料发生器：32 位 LCG（配方同 Numerical Recipes）。
 * 固定种子 ⇒ 跨机器输入逐字相同，这是「同一个数可比」的前提。
 * @param {number} seed
 * @returns {() => number} [0,1) 均匀序列
 */
export function makeRng(seed = 20261102) {
  let state = seed >>> 0;
  return function next() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const WORDS = ['分析','结果','部署','门禁','回滚','会话','群聊','引用','图片','语音','文件','命令','触发','归一','校验','缓存','队列','重试','超时','日志','指标','路由'];

function sentence(rng, minWords, maxWords) {
  const n = minWords + Math.floor(rng() * (maxWords - minWords + 1));
  let out = '';
  for (let i = 0; i < n; i += 1) out += WORDS[Math.floor(rng() * WORDS.length)];
  return out;
}

/** 语料一次性生成完毕，测量阶段只读 —— 生成成本不计入任何基准。 */
export function buildCorpus(size = CORPUS_SIZE) {
  const rng = makeRng();
  const feishuText = [];
  const feishuLong = [];
  const matrixEvents = [];
  const outbound = [];
  const observed = [];
  for (let i = 0; i < size; i += 1) {
    const body = '@机器人 ' + sentence(rng, 3, 20);
    feishuText.push({
      message: { message_id: 'om_' + i, message_type: 'text', content: JSON.stringify({ text: body }) },
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_' + i } },
      mentions: [{ key: '@_user_1', name: '机器人' }],
    });
    const para = sentence(rng, 40, 80);
    // 长文必须**确实超过** splitText 的 9000 阈值，否则它走「原样返回」快路径，
    // 基准就在测一个没被执行的分支（标定实测：repeat 60 只有约 7.3k 字符，落空）。
    // 按块放大到 >12000 字符，并由下面的 precondition 兜住。
    let long = para;
    while (long.length < 12000) long += para + '\n\n';
    feishuLong.push(long);
    matrixEvents.push({
      event: {
        type: 'm.room.message',
        sender: '@user_' + i + ':example.org',
        event_id: '$evt_' + i + ':example.org',
        origin_server_ts: 1760000000000 + i * 1000,
        content: { msgtype: 'm.text', body: '@bot:example.org ' + sentence(rng, 2, 12), 'm.mentions': { user_ids: ['@bot:example.org'] } },
      },
      roomId: '!room_' + (i % 8) + ':example.org',
    });
    const segs = [sentence(rng, 8, 20), sentence(rng, 8, 20), sentence(rng, 8, 20)];
    // 机器口吻前缀 + 列表尾巴：同时命中 stripMachinePhrases 与 splitReply 两条分支。
    outbound.push('作为 AI 助手，我认为：\n\n' + segs.join('\n\n') + '\n\n- ' + segs.join('\n- '));
    observed.push({
      event: { is_self: false, text: sentence(rng, 2, 10), raw_text: sentence(rng, 2, 10) },
      group: { observeAmbient: rng() < 0.7, commandPrefix: '/dsh' },
    });
  }
  return { feishuText, feishuLong, matrixEvents, outbound, observed };
}

/**
 * 热路径清单。每项除 run() 外可给 precondition()：返回字符串即「语料没命中想测的
 * 分支」，基准拒绝出数。每项 run() 返回一个「摘要数」，测量函数把它累加进 checksum ——
 * 不消费返回值的话引擎有权把调用当死代码删掉，基准就变成测空气。
 */
/**
 * 物化一段输出：按步长 64 取样 charCode 并累加。
 *
 * 为什么基准必须做这一步：V8 的 slice/concat 会造出 SlicedString/ConsString，
 * 只数 chunk 数或只读 .length 都不触发展平 —— 那样测的是分配了几个壳，而不是
 * 这条字符串真的被消费过（发送时平台要的是字节）。累加值进 checksum，
 * 引擎就不能把调用当死代码删掉，读数才有物理意义。
 *
 * @param {string} value
 * @returns {number} 与内容相关、与运行次数无关的摘要数
 */
export function materialize(value) {
  let sum = 0;
  for (let i = 0; i < value.length; i += 64) sum += value.charCodeAt(i);
  return sum + value.length;
}
export function defineSuites(corpus) {
  // ring 每轮新建：复用同一个环会在第二轮起把所有事件判成 duplicate，
  // 于是「基准」测的是去重短路而不是归一化全路径。
  let ring = new EventDedupeRing(2000);
  const botUserId = '@bot:example.org';
  const config = { requireMention: true, freeResponseRooms: new Set(), allowedRooms: new Set() };
  return [
    {
      name: 'feishu.extractText',
      run() {
        let sum = 0;
        for (const event of corpus.feishuText) {
          const text = extractText(event);
          // 入站后紧接着归一化/发问，文本必然被读走，所以物化计入成本。
          sum += text ? materialize(text) : 0;
        }
        return sum;
      },
    },
    {
      name: 'feishu.splitText(12k)',
      run() {
        let sum = 0;
        for (const text of corpus.feishuLong) {
          // 只数 chunk 数会停在 SlicedString 上（.length 是 O(1)），测不到真实投递成本。
          for (const chunk of splitText(text, 9000)) sum += materialize(chunk);
        }
        return sum;
      },
      // 语料必须真的被切开：任何一条没超过阈值就是在测快路径。
      precondition() {
        const bad = corpus.feishuLong.filter((t) => t.length <= 9000).length;
        return bad > 0 ? bad + ' item(s) at or below the 9000 threshold (chunking branch never runs)' : null;
      },
    },
    {
      name: 'matrix.normalizeTimelineEvent',
      run() {
        ring = new EventDedupeRing(2000);
        let sum = 0;
        for (const item of corpus.matrixEvents) {
          // ring 复用：同一批语料反复喂入会命中「重复事件」分支，那正是去重环的
          // 热路径；drop 计数也进 checksum，保证结果被消费。
          const out = normalizeMatrixTimelineEvent({
            event: item.event,
            roomId: item.roomId,
            botUserId,
            isDirect: false,
            config,
            patterns: [],
            ring,
          });
          // 通过全部门禁时返回 normalized message（带 text），drop 时返回原因串。
          // 两条都物化，保证测的是真分支而不是壳。
          // normalize 的通过分支返回 { message: { content, ... } }，drop 分支返回 { drop: '原因' }。
          // 两条都把字符串物化计入 —— 取错字段就会 checksum=0，下面的自检会当场抓住。
          sum += out.drop ? materialize(out.drop) : materialize(out.message?.content ?? '');
          sum += 1;
        }
        return sum;
      },
      // 事件形状必须能穿过全部前置门（self/bridge/ignore/type/mention gate）。
      // 若首条就被 drop，整批都在测短路分支，读数毫无意义。
      precondition() {
        const first = normalizeMatrixTimelineEvent({
          event: corpus.matrixEvents[0].event,
          roomId: corpus.matrixEvents[0].roomId,
          botUserId: '@bot:example.org',
          isDirect: false,
          config: { requireMention: true, freeResponseRooms: new Set(), allowedRooms: new Set() },
          patterns: [],
        });
        return first.drop ? 'corpus events drop at ' + first.drop + ' (benchmark would measure a short-circuit)' : null;
      },
    },
    {
      name: 'shared.planOutbound',
      run() {
        let sum = 0;
        for (const text of corpus.outbound) {
          // jitter 固定：不注入的话每次带 Math.random 噪声，基准不可比。
          const plan = planOutbound(text, { jitter: 1, elapsedMs: 0 });
          for (const segment of plan.segments) sum += materialize(segment);
          sum += plan.delaysMs.length;
        }
        return sum;
      },
    },
    {
      name: 'shared.stripMachinePhrases+flattenMarkdown',
      run() {
        let sum = 0;
        for (const text of corpus.outbound) {
          sum += materialize(flattenMarkdown(stripMachinePhrases(text)));
        }
        return sum;
      },
    },
    {
      name: 'weixin.decideObserved',
      run() {
        let sum = 0;
        for (const item of corpus.observed) {
          sum += decideObserved(item.event, item.group).group ? 1 : 0;
        }
        return sum;
      },
    },
  ];
}

/** 第 p 分位（0..1）。空数组返回 0。 */
export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

/**
 * 判定：suite 的 ops/s 低于下限即破线；suite 缺失同样算破线（防止
 * 「删掉一项来通过基准」这种退化）。导出是为了让负控直接注入假读数。
 */
export function evaluateFloors(results, floors) {
  const breaches = [];
  for (const [name, floor] of Object.entries(floors)) {
    const hit = results.find((item) => item.name === name);
    if (!hit) {
      breaches.push({ name, floor, measured: null, reason: 'missing-suite' });
      continue;
    }
    if (!(hit.opsPerSecond >= floor)) {
      breaches.push({ name, floor, measured: hit.opsPerSecond, reason: 'below-floor' });
    }
  }
  return breaches;
}

// 下限表（floor = 标定值 ÷ 20，向下取整到整数位）。
//
// 标定读数 [本机实测 2026-11-02T06:52+08:00，node v24.16.0，win32/x64，
// corpus=400 seed=20261102，warmup=2 rounds=5]：
//   feishu.extractText                        3,035,823 ops/s
//   feishu.splitText(12k)                     1,027,380 ops/s
//   matrix.normalizeTimelineEvent               308,352 ops/s
//   shared.planOutbound                          19,030 ops/s
//   shared.stripMachinePhrases+flattenMarkdown   12,689 ops/s
//   weixin.decideObserved                      6,749,916 ops/s
// 取 ÷20 而不是 ÷1.2：CI 免费 runner 的算力比本机低一个数量级是常态，
// 下限的职责是拦「数量级退化」（比如把 O(n) 写成 O(n^2)），不是拦噪声。
// 「必须是有限正数、且覆盖全部 suite」由 test/benchmark-floor.test.mjs 钉住 ——
// 防止有人把下限调成 0 来制造永久绿灯（那等于把判据拆了）。
export const FLOORS = {
  'feishu.extractText': 150000,
  'feishu.splitText(12k)': 50000,
  'matrix.normalizeTimelineEvent': 15000,
  'shared.planOutbound': 900,
  'shared.stripMachinePhrases+flattenMarkdown': 600,
  'weixin.decideObserved': 300000,
};

function timeRound(suite) {
  const start = process.hrtime.bigint();
  const checksum = suite.run();
  const end = process.hrtime.bigint();
  return { ms: Number(end - start) / 1e6, checksum };
}

export async function runBenchmark(options = {}) {
  const size = options.size ?? CORPUS_SIZE;
  const warmup = options.warmup ?? WARMUP_ROUNDS;
  const rounds = options.rounds ?? MEASURE_ROUNDS;
  const corpus = buildCorpus(size);
  const suites = defineSuites(corpus);
  const results = [];
  const mismatched = [];
  for (const suite of suites) {
    if (typeof suite.precondition === 'function') {
      const problem = suite.precondition();
      if (problem) mismatched.push(suite.name + ': ' + problem);
    }
  }
  // 语料没命中要测的分支 ⇒ 拒绝出数。宁可没数，不要一个漂亮但无意义的数。
  if (mismatched.length > 0) {
    return { corpusMismatch: mismatched, results: [], breaches: [] };
  }
  for (const suite of suites) {
    for (let i = 0; i < warmup; i += 1) timeRound(suite);
    const samples = [];
    let checksumTotal = 0;
    for (let i = 0; i < rounds; i += 1) {
      const timed = timeRound(suite);
      samples.push(timed.ms);
      checksumTotal += timed.checksum;
      // 逐轮判非零：某一轮归零说明那轮什么都没消费（字段取错/分支短路），
      // 只判总和会让「一轮有、四轮空」蒙过去 —— 这条自检第一次就抓到了自己的错。
      if (!(timed.checksum > 0)) {
        return { emptyRound: { name: suite.name, round: i } };
      }
    }
    const totalMs = samples.reduce((a, b) => a + b, 0);
    const medianRoundMs = percentile(samples, 0.5);
    results.push({
      name: suite.name,
      itemsPerRound: size,
      rounds,
      medianRoundMs: Number(medianRoundMs.toFixed(3)),
      opsPerSecond: Math.round((size * rounds) / (totalMs / 1000)),
      itemP50Us: Number(((medianRoundMs * 1000) / size).toFixed(2)),
      itemP95Us: Number(((percentile(samples, 0.95) * 1000) / size).toFixed(2)),
      consumedOutput: checksumTotal > 0,
    });
  }
  return {
    node: process.version,
    platform: process.platform + '/' + process.arch,
    corpusSeed: 20261102,
    corpusSize: size,
    results,
    breaches: evaluateFloors(results, FLOORS),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const jsonAt = args.indexOf('--json');
  const report = await runBenchmark();
  if (report.emptyRound) {
    console.error('BENCHMARK_OUTPUT_NOT_CONSUMED ' + report.emptyRound.name + ' round=' + report.emptyRound.round + ' produced no consumed bytes');
    process.exitCode = 1;
    return;
  }
  if (report.corpusMismatch) {
    console.error('BENCHMARK_CORPUS_MISMATCH ' + report.corpusMismatch.join(' | '));
    process.exitCode = 1;
    return;
  }
  const text = JSON.stringify(report, null, 2);
  if (jsonAt >= 0 && args[jsonAt + 1]) {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname, resolve } = await import('node:path');
    const target = resolve(args[jsonAt + 1]);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text + '\n');
  }
  for (const item of report.results) {
    console.log([
      item.name.padEnd(46),
      String(item.opsPerSecond).padStart(10) + ' ops/s',
      ' p50=' + item.itemP50Us + 'us',
      ' p95=' + item.itemP95Us + 'us',
      item.consumedOutput ? '' : ' (OUTPUT-DROPPED!)',
    ].join(''));
  }
  if (report.breaches.length > 0) {
    const detail = report.breaches.map((b) => b.name + '(' + b.reason + ',measured=' + b.measured + ')').join(', ');
    console.error('BENCHMARK_BELOW_FLOOR ' + detail);
    process.exitCode = 1;
    return;
  }
  console.log('BENCHMARK_OK suites=' + report.results.length + ' corpus=' + report.corpusSize + ' seed=' + report.corpusSeed);
}
// 只在被直接执行时跑 CLI；被测试 import 时不副作用执行。
// resolve() 把相对路径归一，避免 node scripts/x.mjs 这种调用形态判成 import。
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();