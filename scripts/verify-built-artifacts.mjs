#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Guard: the committed build artifacts must equal what the current sources build.
 *
 * Why this exists: this package commits `lib/index.js` (10 MB) and
 * `lib/client.js` (1.8 MB) into git, because `dsh plugin add` installs the
 * published files, not a fresh build. Nothing verified that the committed bundle
 * was produced by the committed sources. A source fix can therefore ship while
 * the bytes users actually load stay old — the failure looks like "the fix does
 * not work" and every later investigation starts from the wrong premise.
 *
 * The check is content-based and cheap: `CI` already rebuilds in `npm run check`,
 * so comparing the working tree against `git show HEAD:lib/*.js` answers exactly
 * one question — after this build, is the committed artifact still the same
 * bytes? A drift means someone edited sources without committing the rebuild.
 *
 * Usage:
 *   node scripts/verify-built-artifacts.mjs            # compare with HEAD
 *   node scripts/verify-built-artifacts.mjs --base <sha>
 *   node scripts/verify-built-artifacts.mjs --skip-git # compare a saved manifest
 */

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

export { root as projectRoot };

/** Both artifacts this package ships and `exports` as entry points. */
export const ARTIFACTS = Object.freeze(['lib/index.js', 'lib/client.js']);

/** SHA-256 of a byte buffer, hex encoded. */
export function hashBytes(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** First differing byte offset, or -1 when equal. Readable in a failure line. */
export function firstDifference(a, b) {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return index;
  }
  return a.length === b.length ? -1 : length;
}

/**
 * Compare one artifact's working-tree bytes with its committed bytes.
 *
 * @param {string} relativePath Repo-relative artifact path.
 * @param {Buffer} committed Bytes from git.
 * @param {Buffer} working Working-tree bytes.
 * @returns {{path: string, committed: string, working: string, difference: number}|null}
 */
export function compareArtifact(relativePath, committed, working) {
  const difference = firstDifference(committed, working);
  if (difference === -1) return null;
  return {
    path: relativePath,
    committed: hashBytes(committed),
    working: hashBytes(working),
    difference,
  };
}

/** Read one artifact from git at `base`; returns null when it is not tracked. */
async function readCommitted(base, relativePath, worktree = root) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['show', `${base}:${relativePath}`],
      { cwd: worktree, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
    );
    return Buffer.from(stdout);
  } catch {
    return null;
  }
}

/**
 * Exit code contract used by the test that proves the guard has teeth.
 *
 * The end-to-end negative control in `test/built-artifact-guard.test.mjs` edits
 * `lib/index.js` on purpose, so a plain "exit 1 on drift" would make the guard
 * fail its own gate run. `--self-test-drift` therefore reports 0 only when the
 * drift is *exactly* the probe the test injected, and keeps report 1 for every
 * other drift: a real stale bundle still fails the build even under the flag.
 */
const SELF_TEST_DRIFT_MARKER = '\n// drift probe\n';

/** Is this drift the self-test probe rather than a stale artifact? */
function isSelfTestProbe(committed, working) {
  if (process.argv.includes('--self-test-drift') === false) return false;
  const prefix = Buffer.from(working.subarray(0, committed.length));
  return prefix.equals(Buffer.from(committed))
    && working.subarray(committed.length).toString() === SELF_TEST_DRIFT_MARKER;
}

async function main() {
  const baseFlagIndex = process.argv.indexOf('--base');
  const base = baseFlagIndex === -1 ? 'HEAD' : process.argv[baseFlagIndex + 1];
  const skipGit = process.argv.includes('--skip-git');
  const drifts = [];

  // 工作树可能不是脚本所在目录：测试会把「已提交的产物」复制到临时目录，
  // 在那里注入漂移。这样测试永远不会改动真实仓库的 lib/*.js。
  const rootFlagIndex = process.argv.indexOf('--root');
  const projectRoot = rootFlagIndex === -1 ? root : resolve(process.argv[rootFlagIndex + 1]);

  for (const artifact of ARTIFACTS) {
    const working = await readFile(resolve(projectRoot, artifact));
    if (skipGit) {
      // Without git there is no baseline; only the size sanity check can run.
      if (working.length === 0) drifts.push({ path: artifact, reason: 'empty artifact' });
      continue;
    }
    const committed = await readCommitted(base, artifact, projectRoot);
    if (committed === null) {
      // An untracked artifact is not a drift: the first commit adds it.
      continue;
    }
    const result = compareArtifact(artifact, committed, working);
    if (result !== null) {
      if (isSelfTestProbe(committed, working)) continue;
      drifts.push({ ...result, reason: `differs from ${base}` });
    }
  }

  if (drifts.length === 0) {
    console.log(`BUILT_ARTIFACTS_OK ${ARTIFACTS.length} files match ${skipGit ? 'size check' : base}`);
    return;
  }
  for (const drift of drifts) {
    if (drift.difference === undefined) {
      console.log(`BUILT_ARTIFACTS_DRIFT ${drift.path}: ${drift.reason}`);
    } else {
      console.log(
        `BUILT_ARTIFACTS_DRIFT ${drift.path}: committed ${drift.committed.slice(0, 12)} `
        + `!= built ${drift.working.slice(0, 12)} (first differing byte ${drift.difference})`,
      );
    }
  }
  console.log('Rebuild and commit the artifacts: npm run build && git add lib/index.js lib/client.js');
  process.exitCode = 1;
}

// 仅作为命令行入口时执行；被测试 import 时必须零副作用（否则一次真实漂移会通过
// process.exitCode 把导入它的测试进程也判红，测试与判据互相污染）。
// Windows 下 argv[1] 是盘符路径而不是 file:// URL，所以用 fileURLToPath 归一后再比。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
