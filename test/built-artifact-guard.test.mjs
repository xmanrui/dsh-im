import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { ARTIFACTS, compareArtifact, firstDifference, hashBytes } from '../scripts/verify-built-artifacts.mjs';

/** 脚本与仓库根：被检查的工作树可能是临时仓，但脚本永远在本仓。 */
const root = resolve(import.meta.dirname, '..');

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

/** Run the guard and require it to explain itself: OK, or DRIFT naming a shipped file. */
async function runGuardSelfDescribing(execFileAsync, root, extra = []) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['scripts/verify-built-artifacts.mjs', ...extra],
      { cwd: root },
    );
    assert.match(stdout, /BUILT_ARTIFACTS_OK/u);
    return { drifted: false, stdout };
  } catch (error) {
    assert.match(String(error.stdout), /BUILT_ARTIFACTS_DRIFT lib\/(index|client)\.js: /u);
    return { drifted: true, stdout: String(error.stdout) };
  }
}

/**
 * 端到端负控：在**隔离的临时仓**里跑真 CLI，注入漂移必须被点名，撤回后必须消失。
 *
 * 为什么用临时仓而不是直接改本仓的 lib/*.js：
 * 本仓有多会话并行写，测试去动被跟踪的产物文件，既会和别人的 `npm run build` 打架，
 * 也会让「注入的漂移」和「别人真实留下的漂移」混在同一次读数里。临时仓里只有我这一份
 * 字节，报出什么就是什么。
 */
async function makeIsolatedRepository() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const execFileAsync = promisify(execFile);

  const base = await mkdtemp(join(tmpdir(), 'artifact-guard-'));
  await mkdir(join(base, 'lib'), { recursive: true });
  const originals = new Map();
  for (const artifact of ARTIFACTS) {
    const name = artifact.split('/').pop();
    const bytes = await readFile(resolve(root, artifact));
    originals.set(name, bytes);
    await writeFile(join(base, 'lib', name), bytes);
  }
  await execFileAsync('git', ['init', '--quiet'], { cwd: base });
  await execFileAsync('git', ['add', 'lib'], { cwd: base });
  await execFileAsync(
    'git',
    ['-c', 'user.name=guard', '-c', 'user.email=guard@local', 'commit', '--quiet', '-m', 'baseline'],
    { cwd: base },
  );
  return { base, originals, execFileAsync };
}

test('the CLI names an injected drift and forgets it after restore', async () => {
  const { base, originals, execFileAsync } = await makeIsolatedRepository();
  const artifact = join(base, ARTIFACTS[0]);
  const original = originals.get(ARTIFACTS[0].split('/').pop());

  /** 读一次守卫的结论，只取「本测试注入的那条」是否出现。 */
  const reportsIndex = async (extra = []) => {
    const args = ['scripts/verify-built-artifacts.mjs', '--root', base, ...extra];
    try {
      const { stdout } = await execFileAsync(process.execPath, args, { cwd: root });
      return { drift: /BUILT_ARTIFACTS_DRIFT lib\/index\.js:/u.test(stdout), stdout };
    } catch (error) {
      return {
        drift: /BUILT_ARTIFACTS_DRIFT lib\/index\.js:/u.test(String(error.stdout)),
        stdout: String(error.stdout),
      };
    }
  };

  try {
    // 基线：刚提交的字节与工作树一致，守卫必须是绿的。
    const clean = await reportsIndex();
    assert.equal(clean.drift, false, 'a freshly committed tree must be clean: ' + clean.stdout);
    assert.match(clean.stdout, /BUILT_ARTIFACTS_OK/u);

    // 注入本测试自己的探针字节：--self-test-drift 只豁免这一种形态。
    await writeFile(artifact, Buffer.concat([original, Buffer.from('\n// drift probe\n')]));
    const flagged = await reportsIndex(['--self-test-drift']);
    assert.equal(flagged.drift, false, 'the injected probe must be recognised as a probe: ' + flagged.stdout);

    // 负向对照：同一位置换成非探针字节，豁免必须失效、仍然判红。
    await writeFile(artifact, Buffer.concat([original, Buffer.from('\n// real drift\n')]));
    const real = await reportsIndex(['--self-test-drift']);
    assert.equal(real.drift, true, 'a non-probe drift must still be reported: ' + real.stdout);

    // 还原后必须回到绿。
    await writeFile(artifact, original);
    const restored = await reportsIndex();
    assert.equal(restored.drift, false, 'restoring the bytes must clear the report: ' + restored.stdout);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
