import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// H4.1 的本地判据：CI 的 job 结构是「贡献入口能不能被机器看见」的一部分。
// 这些断言不用 YAML 解析器（本仓零 YAML 依赖，装一个只为测试不值当），
// 而是钉住**结构事实**：job 存在、各自跑哪条判据、警告态、以及 action 引用
// 必须是 40 位提交 SHA（防「凭记忆写 SHA」——本轮真的错过一次）。
const FILE = resolve('import.meta.dirname') + '/../.github/workflows/ci.yml';
const text = await readFile(resolve(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf8');

/** 取出 `  <name>:` 形式的顶层 job 名（on: 之下的分支缩进不同，靠行首两空格+小写名识别）。 */
function jobNames(source) {
  const jobsBlock = source.split(/^jobs:\s*$/m)[1];
  assert.ok(jobsBlock, 'ci.yml must have a jobs: block');
  return [...jobsBlock.matchAll(/^  ([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]);
}

test('the five jobs exist and are individually addressable', () => {
  const names = jobNames(text);
  for (const required of ['check', 'governance', 'coverage', 'benchmark', 'windows-workspaces']) {
    assert.ok(names.includes(required), 'missing job: ' + required);
  }
});

test('governance and coverage are blocking, benchmark is advisory', () => {
  // 治理与覆盖率必须能红（否则它们不是门禁）；基准刻意不阻断合并。
  const benchmark = text.split(/^  benchmark:$/m)[1].split(/^  [a-z][a-z0-9-]*:$/m)[0];
  assert.match(benchmark, /continue-on-error: true/);
  const governance = text.split(/^  governance:$/m)[1].split(/^  [a-z][a-z0-9-]*:$/m)[0];
  assert.doesNotMatch(governance, /continue-on-error/);
  const coverage = text.split(/^  coverage:$/m)[1].split(/^  [a-z][a-z0-9-]*:$/m)[0];
  assert.doesNotMatch(coverage, /continue-on-error/);
});

test('each new job runs its own verification command', () => {
  assert.match(text, /node scripts\/verify-governance\.mjs/);
  assert.match(text, /node scripts\/verify-benchmark-report\.mjs/);
  assert.match(text, /npm run coverage/);
  assert.match(text, /npm run benchmark/);
});

test('coverage job installs ffmpeg so the voice suites really run on CI', () => {
  // M5 的另一半：本机解了 skip 不算完，CI 上也要真跑。
  assert.match(text, /apt-get install -y ffmpeg/);
});

test('every action reference is a full 40-hex commit SHA, never a floating tag', () => {
  const uses = [...text.matchAll(/uses: ([^\s]+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 8, 'expected several pinned actions, got ' + uses.length);
  for (const ref of uses) {
    const sha = ref.split('@')[1];
    assert.match(sha ?? '', /^[0-9a-f]{40}$/u, 'unpinned action reference: ' + ref);
  }
});
