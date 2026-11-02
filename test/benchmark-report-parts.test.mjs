import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { listReportParts, matchClaimOnLine, inspectCapabilityClaimsWithLocation } from '../scripts/verify-benchmark-report.mjs';

// H4.3 契约：判据二只读主报告，分卷是逃检面。
// r17 实测就是这么漏掉旧值的：主报告改了、分卷仍是 matcher 收窄前的读数，而门禁全绿。
const REPO = resolve(import.meta.dirname, '..');
const REPORT = resolve(REPO, 'docs/benchmark/2026-11-01-dsh-im-benchmark.md');

test('parts discovery enumerates every markdown file under parts', async () => {
  const parts = await listReportParts(REPORT);
  // 目录枚举而非写死名单：新增分卷必须自动进面，否则又是一次「加了但没纳入」。
  assert.ok(parts.length >= 10, 'expected at least ten parts, got ' + parts.length);
  assert.ok(parts.every((p) => p.endsWith('.md')));
  assert.deepEqual(parts, [...parts].sort(), 'order must be stable so readings reproduce');
});

test('a missing parts directory is not an error', async () => {
  const none = await listReportParts(resolve(REPO, 'README.md'));
  assert.deepEqual(none, []);
});

test('claim matcher reads the fraction from a leading capability cell', () => {
  assert.deepEqual(matchClaimOnLine('| 语音 | **2/14**（feishu、telegram）', ['语音']), { count: 2, total: 14 });
  assert.deepEqual(matchClaimOnLine('| Voice | 4/14 | — |', ['语音', 'Voice']), { count: 4, total: 14 });
  // 行首第一格不是能力名 => 不是主张（正文里顺带出现的分数不该误伤）
  assert.equal(matchClaimOnLine('我们说语音覆盖了 2/14 的渠道', ['语音']), null);
  assert.equal(matchClaimOnLine('| 其它 | 2/14 |', ['语音']), null);
  // 有主张但没分数 => 不构成可校验主张
  assert.equal(matchClaimOnLine('| 语音 | 支持 |', ['语音']), null);
});

test('location reporting names the file AND the line', () => {
  // H4.3 的实际价值：主报告与十个分卷里都可能有那一行，只说「语音不一致」无法定位。
  const channels = [{ channel: 'feishu', supported: { voice: true } }];
  const text = ['# x', '', '| 语音 | 3/14 |', ''].join(String.fromCharCode(10));
  const problems = inspectCapabilityClaimsWithLocation(text, '/tmp/sample.md', channels);
  assert.equal(problems.length, 1, problems.join(' | '));
  assert.ok(problems[0].includes('/tmp/sample.md:3'), 'must name line 3, got ' + problems[0]);
  assert.ok(problems[0].includes('report=3/14'), problems[0]);
  assert.ok(problems[0].includes('matrix=1/1'), problems[0]);
});

test('a correct declaration produces no drift', () => {
  const channels = [{ channel: 'a', supported: { voice: false } }];
  const text = ['| 语音 | 0/1 |'].join(String.fromCharCode(10));
  assert.deepEqual(inspectCapabilityClaimsWithLocation(text, 'x.md', channels), []);
});

test('every real document is consistent with the generator', async () => {
  // 活体判据：跑真实语料。变红说明某份文档的读数与 collectChannelMatrix() 不符。
  const { collectChannelMatrix } = await import('../scripts/channel-capability-matrix.mjs');
  const channels = await collectChannelMatrix();
  const documents = [{ path: REPORT, text: await readFile(REPORT, 'utf8') }];
  for (const part of await listReportParts(REPORT)) {
    documents.push({ path: part, text: await readFile(part, 'utf8') });
  }
  const drift = documents.flatMap((doc) => inspectCapabilityClaimsWithLocation(doc.text, doc.path, channels));
  assert.deepEqual(drift, [], 'documentation drift: ' + drift.join(' | '));
});
