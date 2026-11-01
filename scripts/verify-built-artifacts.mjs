#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
async function readCommitted(base, relativePath) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['show', `${base}:${relativePath}`],
      { cwd: root, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
    );
    return Buffer.from(stdout);
  } catch {
    return null;
  }
}

async function main() {
  const baseFlagIndex = process.argv.indexOf('--base');
  const base = baseFlagIndex === -1 ? 'HEAD' : process.argv[baseFlagIndex + 1];
  const skipGit = process.argv.includes('--skip-git');
  const drifts = [];

  for (const artifact of ARTIFACTS) {
    const working = await readFile(resolve(root, artifact));
    if (skipGit) {
      // Without git there is no baseline; only the size sanity check can run.
      if (working.length === 0) drifts.push({ path: artifact, reason: 'empty artifact' });
      continue;
    }
    const committed = await readCommitted(base, artifact);
    if (committed === null) {
      // An untracked artifact is not a drift: the first commit adds it.
      continue;
    }
    const result = compareArtifact(artifact, committed, working);
    if (result !== null) drifts.push({ ...result, reason: `differs from ${base}` });
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

await main();
