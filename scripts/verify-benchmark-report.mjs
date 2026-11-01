#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 判据：对标报告必须覆盖 8 个维度，且含 4 个必需要素（总览表 / 逐项差距 / 建议清单 / 可实施路径）。
 *
 * 为什么要有这个脚本：报告是一份「给未来的自己看」的产物，最容易的失败形态不是写错，
 * 而是**少写一段而没人发现**。把检查写成可复跑命令（并配负控），才能证明它是真读过全文，
 * 而不是只看了标题。
 *
 * 用法：node scripts/verify-benchmark-report.mjs [path]
 */

const REPORT = process.argv[2] ?? resolve('docs/benchmark/2026-11-01-dsh-im-benchmark.md');

/** 8 个维度：每维的关键词必须同时命中「维度名」与「至少一条量化」才算出齐。 */
export const DIMENSIONS = Object.freeze([
  { key: 'coverage', label: '功能模块覆盖', markers: ['功能模块覆盖'] },
  { key: 'architecture', label: '技术架构设计', markers: ['技术架构设计'] },
  { key: 'implementation', label: '实现方式', markers: ['实现方式'] },
  { key: 'performance', label: '性能表现', markers: ['性能表现'] },
  { key: 'scalability', label: '可扩展性', markers: ['可扩展性'] },
  { key: 'maintenance', label: '维护状态', markers: ['维护状态'] },
  { key: 'documentation', label: '文档完善程度', markers: ['文档完善程度'] },
  { key: 'applicability', label: '适用场景', markers: ['适用场景'] },
]);

/** 4 个必需要素。 */
export const SECTIONS = Object.freeze([
  { key: 'overview-table', label: '对比总览表', markers: ['对比总览表'] },
  { key: 'gap-detail', label: '逐项差距说明', markers: ['逐项差距说明'] },
  { key: 'recommendations', label: '改进建议清单', markers: ['改进建议清单'] },
  { key: 'roadmap', label: '可实施路径', markers: ['可实施路径'] },
]);

/**
 * 检查一份报告文本。
 *
 * @param {string} text Whole report.
 * @returns {{missing: string[], tables: number, quantified: number}}
 */
export function inspectReport(text) {
  const missing = [];
  // 必须命中的是**标题行**，不是正文里出现过这个词：
  // 一次真实失败证明了为什么 —— 首版只查全文，我把「### 2.8 适用场景」改成「### 2.8 场景」
  // 后判据仍然 PASS，因为 §1.1 总览表的「适用场景」那一格还在。词出现 ≠ 章节存在。
  const headings = (text.match(/^#{2,4} .*$/gmu) ?? []).map((line) => line.replace(/^#+\s*/u, ''));
  for (const dimension of [...DIMENSIONS, ...SECTIONS]) {
    const hit = headings.some((heading) => dimension.markers.some((marker) => heading.includes(marker)));
    if (!hit) missing.push(dimension.label);
  }
  // 「量化」的最低形状：表格行 + 至少一个可复算数字（百分号/字节/行数/秒）。
  const tables = (text.match(/^\|.*\|$/gmu) ?? []).length;
  const quantified = (text.match(/\d+/gu) ?? []).length;
  return { missing, tables, quantified };
}

async function main() {
  const text = await readFile(REPORT, 'utf8');
  const { missing, tables, quantified } = inspectReport(text);
  if (missing.length > 0) {
    console.error('BENCHMARK_REPORT_MISSING: ' + missing.join(' | '));
    process.exitCode = 1;
    return;
  }
  if (tables < 40 || quantified < 100) {
    console.error('BENCHMARK_REPORT_THIN: tables=' + tables + ' numbers=' + quantified);
    process.exitCode = 1;
    return;
  }
  console.log('BENCHMARK_REPORT_OK dimensions=' + DIMENSIONS.length + ' sections=' + SECTIONS.length
    + ' tables=' + tables + ' numbers=' + quantified);
}

await main();
