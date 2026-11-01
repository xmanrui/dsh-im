#!/usr/bin/env node
// coverage-report.mjs — 汇总 lcov 为本仓源文件的行/函数/分支覆盖率并判阈（改进项 M4）。
//
// 为什么需要它：报告 §2.3 记着一条反差 —— 测试/源码行比 1.586（12.9 万行测试对
// 8.1 万行源码），但从未采过覆盖率。用例多不等于覆盖到，最典型的反例就是
// 「整条分支只在别的平台跑」（M5 刚修的语音链）。没有读数时这类结构性盲区
// 只能靠人记住；有读数才能进门禁。
//
// 为什么解析 lcov 而不是 node 的人读表：人读表会截断文件名、格式随版本变；
// lcov 是有明确字段的稳定交换格式（SF/DA/FNDA/BRDA），自己解析还能控制口径 ——
// 只统计 src/ 与 plugin-src/（测试代码自身的覆盖率没有判据意义）。
//
// 用法：node scripts/coverage-report.mjs [--lcov p] [--json p] [--min-lines N]
// 判据：COVERAGE_OK lines=NN.N% / COVERAGE_BELOW_FLOOR（退出码 1）。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_LCOV = resolve('test/.tmp/lcov.info');

// 只统计这些前缀下的文件；lcov 里还会混进 node_modules 与 test 自身。
const INCLUDED = /^(src|plugin-src)\//u;

/**
 * 解析 lcov 文本，按文件聚合行/函数/分支命中。
 *
 * 合并语义：同一 SF 内同一行可能重复出现（多次 run 的记录被拼接），按
 * 「命中过一次即算覆盖」合并 —— 若取最后一次，重复记录会把命中行冲成 0。
 *
 * @param {string} text
 * @returns {Array<{path: string, lines: Map<number, number>, functions: Map<string, number>, branches: Map<string, boolean>}>}
 */
export function parseLcov(text) {
  const files = new Map();
  let current = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('SF:')) {
      // Windows 的 lcov 写反斜杠、CI 写正斜杠：统一成斜杠形态再判前缀。
      const path = line.slice(3).replace(/\\/gu, '/');
      current = files.get(path) ?? { path, lines: new Map(), functions: new Map(), branches: new Map() };
      files.set(path, current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('DA:')) {
      const [lineNo, hits] = line.slice(3).split(',');
      const key = Number(lineNo);
      const covered = (current.lines.get(key) ?? 0) > 0 || Number(hits) > 0 ? 1 : 0;
      current.lines.set(key, covered);
      continue;
    }
    if (line.startsWith('FNDA:')) {
      const parts = line.slice(5).split(',');
      const hits = Number(parts[0]);
      const name = parts.slice(1).join(",");
      const covered = (current.functions.get(name) ?? 0) > 0 || hits > 0 ? 1 : 0;
      current.functions.set(name, covered);
      continue;
    }
    if (line.startsWith('BRDA:')) {
      // BRDA:<line>,<block>,<branch>,<taken>；taken 为 - 表示该分支未执行。
      const parts = line.slice(5).split(',');
      const key = parts[0] + ':' + parts[1] + ':' + parts[2];
      const taken = parts[3] !== '-' && Number(parts[3]) > 0;
      current.branches.set(key, (current.branches.get(key) ?? false) || taken);
    }
  }
  return [...files.values()];
}

/** 收敛成总量读数 + 每文件行覆盖率（只含 INCLUDED 前缀）。 */
export function summarize(records) {
  const included = records.filter((record) => INCLUDED.test(record.path));
  const totals = { linesTotal: 0, linesHit: 0, functionsTotal: 0, functionsHit: 0, branchesTotal: 0, branchesHit: 0 };
  const perFile = [];
  for (const record of included) {
    const linesHit = [...record.lines.values()].reduce((a, b) => a + b, 0);
    const linesTotal = record.lines.size;
    const functionsHit = [...record.functions.values()].reduce((a, b) => a + b, 0);
    const functionsTotal = record.functions.size;
    const branchesHit = [...record.branches.values()].filter(Boolean).length;
    const branchesTotal = record.branches.size;
    totals.linesHit += linesHit;
    totals.linesTotal += linesTotal;
    totals.functionsHit += functionsHit;
    totals.functionsTotal += functionsTotal;
    totals.branchesHit += branchesHit;
    totals.branchesTotal += branchesTotal;
    perFile.push({
      path: record.path,
      linesTotal,
      linesHit,
      linePercent: linesTotal ? Number(((linesHit / linesTotal) * 100).toFixed(2)) : 0,
    });
  }
  const pct = (hit, total) => (total ? Number(((hit / total) * 100).toFixed(2)) : 0);
  return {
    files: included.length,
    linesPercent: pct(totals.linesHit, totals.linesTotal),
    functionsPercent: pct(totals.functionsHit, totals.functionsTotal),
    branchesPercent: pct(totals.branchesHit, totals.branchesTotal),
    ...totals,
    // 真正要盯的不是总量（会被小文件稀释），而是「大文件却低覆盖」。
    lowestCovered: perFile
      .filter((item) => item.linesTotal >= 300)
      .sort((a, b) => a.linePercent - b.linePercent)
      .slice(0, 12),
  };
}

export function parseArgs(argv) {
  const out = { lcov: DEFAULT_LCOV, json: null, minLines: 55 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--lcov') {
      out.lcov = resolve(argv[++i]);
      continue;
    }
    if (token === '--json') {
      out.json = resolve(argv[++i]);
      continue;
    }
    if (token === '--min-lines') {
      out.minLines = Number(argv[++i]);
      continue;
    }
    throw new Error("unknown coverage-report argument: " + token);
  }
  if (!Number.isFinite(out.minLines) || out.minLines < 0) {
    throw new Error('--min-lines must be a finite non-negative number');
  }
  return out;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const text = await readFile(options.lcov, "utf8");
  const summary = summarize(parseLcov(text));
  if (options.json) {
    await mkdir(resolve(options.json, '..'), { recursive: true });
    await writeFile(options.json, JSON.stringify(summary, null, 2) + '\n');
  }
  console.log('COVERAGE lines=' + summary.linesPercent + '% functions=' + summary.functionsPercent + '% branches=' + summary.branchesPercent + '% files=' + summary.files + ' threshold=' + options.minLines + '%');
  if (summary.lowestCovered.length > 0) {
    console.log('LOWEST_300PLUS ' + summary.lowestCovered.map((item) => item.path.replace(/^src\/channels\//u, '') + '=' + item.linePercent + '%').join(' | '));
  }
  if (!(summary.linesPercent >= options.minLines)) {
    console.error('COVERAGE_BELOW_FLOOR lines=' + summary.linesPercent + '% < ' + options.minLines + '%');
    process.exitCode = 1;
    return;
  }
  console.log('COVERAGE_OK lines=' + summary.linesPercent + '%');
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
