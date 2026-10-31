import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Name of the Python adapter shipped in the package `scripts/` directory. */
export const ADAPTER_SCRIPT_NAME = 'wechat_group_uia.py';

/** How many directories up a package root can plausibly sit from its entry. */
const MAX_ASCENT = 8;

/** The npm package whose `scripts/` directory owns this adapter. */
const PACKAGE_MARKER = 'dsh-im';

/**
 * Locate the Python adapter relative to the module that owns it.
 *
 * The same source file is consumed in two very different layouts:
 *
 * 1. as the plugin's bundled entry (`lib/index.js`);
 * 2. as an unbundled module (`plugin-src/host/channels/weixin/group-source.mjs`).
 *
 * A single hard-coded `resolve(dir, '../../../..')` therefore produced the wrong
 * directory in the packaged layout. A measured consequence: with a `link:`
 * install Node resolves the entry through the symlink to the source checkout, so
 * `../../../..` climbed past the repository to `D:\` and the child interpreter
 * died with a 153-byte `can't open file 'D:\scripts\wechat_group_uia.py'`
 * before executing one Python statement. The bridge then retried forever while
 * the log only ever showed a stderr byte count.
 *
 * Ascending until the adapter's own package is found removes the layout
 * assumption without guessing. The `package.json` gate is deliberate: an
 * ancestor that merely happens to contain a `scripts/` directory (a stray
 * `D:\scripts` on this machine, for example) must never be mistaken for the
 * plugin package.
 *
 * @param {string} startDir Directory of the module that owns the adapter.
 * @returns {string|null} Absolute adapter path, or null when none is found.
 */
export function findAdapterScript(startDir) {
  if (typeof startDir !== 'string' || !startDir.trim()) {
    throw new TypeError('findAdapterScript requires a directory');
  }
  let directory = resolve(startDir);
  for (let depth = 0; depth < MAX_ASCENT; depth += 1) {
    if (isPluginPackage(directory)) {
      const candidate = join(directory, 'scripts', ADAPTER_SCRIPT_NAME);
      if (isRegularFile(candidate)) return candidate;
    }
    const parent = dirname(directory);
    // Reaching the filesystem root means the package tree was searched fully.
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

/** True only for the plugin package itself, never for an unrelated ancestor. */
function isPluginPackage(directory) {
  const manifest = join(directory, 'package.json');
  if (!isRegularFile(manifest)) return false;
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    return typeof parsed?.name === 'string' && parsed.name.includes(PACKAGE_MARKER);
  } catch {
    // An unreadable manifest is not this plugin; keep searching upward.
    return false;
  }
}

function isRegularFile(candidate) {
  if (!existsSync(candidate)) return false;
  try {
    return statSync(candidate).isFile();
  } catch {
    // A path that cannot be stat'ed is not usable by the interpreter either.
    return false;
  }
}
