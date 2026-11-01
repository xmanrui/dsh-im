import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

/**
 * Scratch directories that a *child process* can really write to.
 *
 * Why this exists: `esbuild` is a native binary, not the Node process. On
 * Windows, DSH's desktop build redirects `os.tmpdir()` to a directory that the
 * Node process may write (its ACL lets it) while the spawned `esbuild.exe`
 * child is denied by the security software in front of that path. The failure
 * surfaces as "Failed to write to output file: ... Access is denied" — a
 * write-permission shape that `fs.writeFileSync` from the same test process
 * does NOT reproduce, so a plain "can Node write here?" probe is useless.
 *
 * The only reliable probe is the same operation the caller will perform: compile
 * a throwaway module with esbuild and see whether the bytes land. When the
 * default temp root cannot host an esbuild output, the helper falls back to a
 * repo-local `test/.tmp/` directory, which is inside the workspace the tool
 * chain is allowed to write.
 *
 * The fallback is deliberately *not` os.tmpdir()` for every caller: tests that
 * assert "no package manifest may be found while walking upwards" (see
 * `test/channels/weixin/adapter-script.test.mjs`) must keep a temp root outside
 * this repository, or the walk correctly finds `@xmanrui/dsh-im` above it. So
 * the helper is opt-in per call site, not a global TMPDIR rewrite.
 */

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = dirname(TEST_DIRECTORY);

/** Repo-local fallback root: inside the workspace, outside any test glob. */
export const FALLBACK_SCRATCH_ROOT = resolve(TEST_ROOT, '.tmp');

/**
 * Can `esbuild` actually write an output file into `directory`?
 *
 * @param {string} directory Directory that must exist already.
 * @returns {Promise<boolean>} true only when the probe bundle was written.
 */
export async function canEsbuildWriteInto(directory) {
  const outfile = join(directory, '__esbuild-probe.mjs');
  try {
    await build({
      stdin: { contents: 'export const probe = 1;\n', loader: 'js', resolveDir: TEST_ROOT },
      outfile,
      write: true,
      logLevel: 'silent',
      bundle: false,
    });
    return true;
  } catch {
    // Any failure (permission, missing directory, antivirus lock) means this
    // directory is unusable for the caller's real build as well.
    return false;
  } finally {
    await rm(outfile, { force: true });
  }
}

/**
 * Find the first candidate root where esbuild can really write.
 *
 * @param {string[]} [candidates] Ordered roots to try; defaults to os.tmpdir().
 * @returns {Promise<string>} A directory known to accept esbuild output.
 */
export async function resolveEsbuildScratchRoot(candidates = [tmpdir(), FALLBACK_SCRATCH_ROOT]) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new TypeError('resolveEsbuildScratchRoot requires at least one candidate');
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    if (await canEsbuildWriteInto(candidate)) return candidate;
  }
  throw new Error(
    'esbuild cannot write into any candidate scratch root: ' + candidates.join(', '),
  );
}

/**
 * Create a per-test scratch directory whose output esbuild can write, and
 * register its removal on the node:test context.
 *
 * @param {import('node:test').TestContext} t Test context that owns cleanup.
 * @param {string} [prefix] Directory name prefix.
 * @param {string[]} [candidates] Optional override, mainly for tests.
 * @returns {Promise<string>} Fresh directory path.
 */
export async function createEsbuildScratchDirectory(t, prefix = 'dsh-esbuild-', candidates) {
  if (t === null || typeof t !== 'object' || typeof t.after !== 'function') {
    throw new TypeError('createEsbuildScratchDirectory requires a node:test context with t.after');
  }
  const root = await resolveEsbuildScratchRoot(candidates);
  const directory = await mkdtemp(join(root, prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
