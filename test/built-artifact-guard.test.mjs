import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { ARTIFACTS, compareArtifact, firstDifference, hashBytes } from '../scripts/verify-built-artifacts.mjs';

// 判据必须能真的变红：这些用例把"提交产物 ≠ 源码构建产物"的三种形态各钉一条，
// 并给一条负向对照（字节相同必须返回 null），否则守卫恒绿等于没有守卫。
test('identical bytes produce no drift', () => {
  const bytes = Buffer.from('export const a = 1;\n');
  assert.equal(compareArtifact('lib/x.js', bytes, Buffer.from(bytes)), null);
});

test('a one-byte change is reported at the exact offset', () => {
  const committed = Buffer.from('const a=1;');
  const working = Buffer.from('const a=2;');
  assert.equal(firstDifference(committed, working), 8);
  const drift = compareArtifact('lib/index.js', committed, working);
  assert.notEqual(drift, null);
  assert.equal(drift.path, 'lib/index.js');
  assert.equal(drift.difference, 8);
  assert.notEqual(drift.committed, drift.working);
});

test('a truncated artifact is drift, not equality', () => {
  const committed = Buffer.from('abcdef');
  const working = Buffer.from('abc');
  assert.equal(firstDifference(committed, working), 3);
  assert.notEqual(compareArtifact('lib/client.js', committed, working), null);
});

test('the guard covers both shipped entry points', () => {
  assert.deepEqual([...ARTIFACTS], ['lib/index.js', 'lib/client.js']);
});

test('hashes are stable and content addressed', () => {
  const bytes = Buffer.from('same');
  assert.equal(hashBytes(bytes), hashBytes(Buffer.from(bytes)));
  assert.notEqual(hashBytes(bytes), hashBytes(Buffer.from('diff')));
});

// 端到端负控：真的把工作树产物改动一个字节，守卫必须报 DRIFT 并以非零退出；
// 随后还原，确保本用例自身不留下脏文件。
test('the CLI fails on a real drift and passes after restore', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const root = resolve(import.meta.dirname, '..');

  await execFileAsync(process.execPath, ['scripts/verify-built-artifacts.mjs'], { cwd: root });

  const artifact = resolve(root, ARTIFACTS[0]);
  const original = await readFile(artifact);
  await writeFile(artifact, Buffer.concat([original, Buffer.from('\n// drift probe\n')]));
  try {
    await assert.rejects(
      execFileAsync(process.execPath, ['scripts/verify-built-artifacts.mjs'], { cwd: root }),
      (error) => {
        assert.match(String(error.stdout), /BUILT_ARTIFACTS_DRIFT lib\/index\.js/u);
        return true;
      },
    );
  } finally {
    await writeFile(artifact, original);
  }

  await execFileAsync(process.execPath, ['scripts/verify-built-artifacts.mjs'], { cwd: root });
});
