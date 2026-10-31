import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ADAPTER_SCRIPT_NAME,
  findAdapterScript,
} from '../../../src/channels/weixin/adapter-script.mjs';

const PACKAGE_JSON = JSON.stringify({ name: '@xmanrui/dsh-im', version: '5.8.0' });

// Build one package tree. `rightSiblings` counts the directories between the
// package root and the module that asks for the adapter.
async function fixture(t, { startFrom, script = true, manifest = PACKAGE_JSON }) {
  const root = await mkdtemp(join(tmpdir(), 'adapter-script-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (manifest !== null) await writeFile(join(root, 'package.json'), manifest);
  if (script === true) {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts', ADAPTER_SCRIPT_NAME), '# adapter\n');
  } else if (script === 'directory') {
    await mkdir(join(root, 'scripts', ADAPTER_SCRIPT_NAME), { recursive: true });
  }
  const start = join(root, ...startFrom);
  await mkdir(start, { recursive: true });
  return { root, start };
}

// The shipped bundle: lib/index.js below the package root.
test('a bundled entry finds the adapter one directory up', async (t) => {
  const { root, start } = await fixture(t, { startFrom: ['lib'] });
  assert.equal(findAdapterScript(start), join(root, 'scripts', ADAPTER_SCRIPT_NAME));
});

// The unbundled module: plugin-src/host/channels/weixin/group-source.mjs.
test('an unbundled module finds the adapter four directories up', async (t) => {
  const { root, start } = await fixture(t, {
    startFrom: ['plugin-src', 'host', 'channels', 'weixin'],
  });
  assert.equal(findAdapterScript(start), join(root, 'scripts', ADAPTER_SCRIPT_NAME));
});

// Negative control for the fix itself: without the adapter there must be no
// invented path, otherwise the replacement repeats the bug it removes.
test('a missing adapter resolves to null instead of a guessed path', async (t) => {
  const { start } = await fixture(t, { startFrom: ['lib'], script: false });
  assert.equal(findAdapterScript(start), null);
});

// A directory at the script path cannot be executed by the interpreter.
test('a directory at the script path is rejected', async (t) => {
  const { start } = await fixture(t, { startFrom: ['lib'], script: 'directory' });
  assert.equal(findAdapterScript(start), null);
});

// The measured incident: a stray ancestor `scripts/` directory with no plugin
// manifest must never be chosen, or the child dies with a 153-byte
// "can't open file" again.
test('an unrelated ancestor scripts directory is not mistaken for the plugin', async (t) => {
  const outer = await mkdtemp(join(tmpdir(), 'adapter-outer-'));
  t.after(() => rm(outer, { recursive: true, force: true }));
  await mkdir(join(outer, 'scripts'), { recursive: true });
  await writeFile(join(outer, 'scripts', ADAPTER_SCRIPT_NAME), '# stray\n');
  const inner = join(outer, 'pkg');
  await mkdir(join(inner, 'lib'), { recursive: true });
  await writeFile(join(inner, 'package.json'), JSON.stringify({ name: 'unrelated-plugin' }));
  assert.equal(findAdapterScript(join(inner, 'lib')), null);
});

test('the nearest plugin package wins when two candidates exist', async (t) => {
  const { root, start } = await fixture(t, { startFrom: ['lib'] });
  const closer = join(root, 'lib');
  await writeFile(join(closer, 'package.json'), JSON.stringify({ name: '@xmanrui/dsh-im' }));
  await mkdir(join(closer, 'scripts'), { recursive: true });
  await writeFile(join(closer, 'scripts', ADAPTER_SCRIPT_NAME), '# inner\n');
  assert.equal(findAdapterScript(start), join(closer, 'scripts', ADAPTER_SCRIPT_NAME));
});

test('an empty start directory is rejected', () => {
  assert.throws(() => findAdapterScript(''), TypeError);
});
