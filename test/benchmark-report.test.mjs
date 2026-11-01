import assert from 'node:assert/strict';
import test from 'node:test';

import { DIMENSIONS, SECTIONS, inspectReport } from '../scripts/verify-benchmark-report.mjs';

// 判据必须有牙：下面每一条都是「把报告削弱成不合格形态」后必须判红。
// 一次真实失败证明了为什么要按标题匹配 —— 首版只查全文词，删掉维度标题后仍然 PASS。
const GOOD = [
  '## 1. 对比总览表',
  '| a | b |',
  '## 2. 逐项差距说明',
  '### 2.1 功能模块覆盖',
  '### 2.2 技术架构设计',
  '### 2.3 实现方式',
  '### 2.4 性能表现',
  '### 2.5 可扩展性',
  '### 2.6 维护状态',
  '### 2.7 文档完善程度',
  '### 2.8 适用场景',
  '## 3. 改进建议清单',
  '## 4. 可实施路径',
].join('\n');

test('a complete skeleton with all headings passes the count checks', () => {
  const padded = GOOD + '\n' + (new Array(50).fill('| x | 1 |').join('\n')) + '\n' + (new Array(120).fill('1').join(' '));
  const result = inspectReport(padded);
  assert.deepEqual(result.missing, []);
  assert.equal(DIMENSIONS.length, 8);
  assert.equal(SECTIONS.length, 4);
});

test('a missing dimension heading is reported by name', () => {
  const broken = GOOD.replace('### 2.8 适用场景', '### 2.8 场景说明');
  const { missing } = inspectReport(broken);
  assert.ok(missing.includes('适用场景'), 'expected 适用场景 in ' + missing.join(','));
});

test('a word in the body does not stand in for a missing heading', () => {
  // 正文里到处都写「适用场景」，但没有对应标题 —— 这就是首版漏判的形态。
  const broken = GOOD.replace('### 2.8 适用场景', '### 2.8 其它')
    + '\n适用场景适用场景适用场景\n';
  const { missing } = inspectReport(broken);
  assert.ok(missing.includes('适用场景'));
});

test('a missing required section is reported', () => {
  const { missing } = inspectReport(GOOD.replace('## 4. 可实施路径', '## 4. 路线'));
  assert.ok(missing.includes('可实施路径'));
});

test('an empty document reports every dimension and section', () => {
  const { missing } = inspectReport('');
  assert.equal(missing.length, DIMENSIONS.length + SECTIONS.length);
});
