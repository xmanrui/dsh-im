#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CAPABILITIES, collectChannelMatrix } from './channel-capability-matrix.mjs';

/**
 * 判据一：对标报告必须覆盖 8 个维度 + 4 个必需要素（总览表/逐项差距/建议清单/可实施路径）。
 * 判据二（本轮新增）：报告主张的能力渗透率必须等于 capability matrix 的实测值。
 *
 * 为什么要有这个脚本：报告是「给未来的自己看」的产物，最容易的失败形态不是写错，
 * 而是少写一段而没人发现。写成可复跑命令（并配负控），才能证明真读过全文。
 *
 * 为什么要判据二：本轮实测抓到报告 §2.1 写「语音 3/14、卡片 3/14、流式 6/14」，
 * 生成器复算是 2/2/4。根因不是笔误 —— 分卷 02 写在 matcher 收窄（017e3ae/0ef3a36）
 * 之前，收窄时没回改分卷。这种「文档比代码旧」人读看不出来（两边各自都像真的），
 * 只有把两个来源放一起比才会现形。
 *
 * 用法：node scripts/verify-benchmark-report.mjs [path]
 */

const REPORT = process.argv[2] ?? resolve('docs/benchmark/2026-11-01-dsh-im-benchmark.md');

/** 8 个维度：每维的标题必须命中「维度名」才算出齐。 */
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
 * 在报告里找形如 `| 语音 | … N/M … |` 的行首主张，取该行第一个分数。
 * 只认「行首第一格就是能力名」的行：正文里顺带出现的数字不该被当成主张
 * （否则任意一处 3/14 都会误伤）。
 *
 * @param {string} reportText
 * @param {string} label 能力名（中文或英文标签）
 * @returns {{count: number, total: number}|null}
 */
export function matchCapabilityClaim(reportText, label) {
  // 手工转义而不借助 $& 之类替换模式：本轮就是被 String.replace 的
  // '$&'/'$\' 特殊模式咬过 —— 正则源串里含这些序列时会被当场展开。
  const escaped = label.replace(/[$()*+.?[\]^{|}\\]/gu, (ch) => '\\' + ch);
  const rowPattern = new RegExp('^\\|\\s*`?' + escaped + '`?\\s*\\|([^\\n]*)$', 'mu');
  const row = reportText.match(rowPattern);
  if (!row) return null;
  const fraction = row[1].match(/(\d+)\s*\/\s*(\d+)/u);
  if (!fraction) return null;
  return { count: Number(fraction[1]), total: Number(fraction[2]) };
}

/**
 * 对账：报告主张 vs 生成器实测。只校验报告确实主张过的能力 ——
 * 少写一条不该判红，写错一条必须判红。
 *
 * @param {string} reportText
 * @param {Array<{supported: Record<string, boolean>}>} channels
 * @returns {string[]} 每条是一个不一致描述
 */
export function inspectCapabilityClaims(reportText, channels) {
  const problems = [];
  for (const capability of CAPABILITIES) {
    const claimed = matchCapabilityClaim(reportText, capability.label)
      ?? matchCapabilityClaim(reportText, capability.labelEn);
    if (!claimed) continue;
    const actual = channels.filter((row) => row.supported[capability.key]).length;
    if (claimed.count !== actual || claimed.total !== channels.length) {
      problems.push(capability.label + ': report=' + claimed.count + '/' + claimed.total
        + ' matrix=' + actual + '/' + channels.length);
    }
  }
  return problems;
}

/**
 * 检查一份报告文本的结构完整性。
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
  const channels = await collectChannelMatrix();
  const inconsistent = inspectCapabilityClaims(text, channels);
  if (inconsistent.length > 0) {
    console.error('BENCHMARK_REPORT_MATRIX_MISMATCH: ' + inconsistent.join(' | '));
    process.exitCode = 1;
    return;
  }
  console.log('BENCHMARK_REPORT_OK dimensions=' + DIMENSIONS.length + ' sections=' + SECTIONS.length
    + ' tables=' + tables + ' numbers=' + quantified + ' capabilityClaimsChecked=yes');
}

await main();
