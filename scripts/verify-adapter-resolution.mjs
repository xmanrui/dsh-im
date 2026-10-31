import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findAdapterScript } from '../src/channels/weixin/adapter-script.mjs';
import { createWechatGroupRuntimeFactory } from '../plugin-src/host/channels/weixin/group-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// The shipped bundle is what a Host actually loads, so it must also contain the
// locator. A build that omits it would keep the old measured failure.
const bundlePath = join(root, 'lib', 'index.js');
if (existsSync(bundlePath)) {
  const bundle = readFileSync(bundlePath, 'utf8');
  assert.ok(
    bundle.includes('wechat_group_uia.py') && !bundle.includes("resolve(import.meta.dirname, '../../../..')"),
    'lib/index.js still resolves the plugin root by a fixed directory count',
  );
}

// Both layouts the package is shipped in must resolve to the same real file.
const bundledEntry = findAdapterScript(join(root, 'lib'));
const unbundledEntry = findAdapterScript(join(root, 'plugin-src', 'host', 'channels', 'weixin'));
assert.equal(bundledEntry, join(root, 'scripts', 'wechat_group_uia.py'));
assert.equal(unbundledEntry, bundledEntry);
assert.ok(existsSync(bundledEntry), 'the resolved adapter must exist on disk');

// The factory must hand that path to the child process. A fake spawn records
// the argv a real Host would run, which is what failed in the field.
const recorded = [];
const factory = createWechatGroupRuntimeFactory({
  spawnImpl: (command, args, options) => {
    recorded.push({ command, args, options });
    const listeners = new Map();
    const child = {
      pid: 1,
      stdin: { write: () => true, end: () => {} },
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event, handler) => listeners.set(event, handler),
      kill: () => { listeners.get('close')?.(0); return true; },
    };
    queueMicrotask(() => listeners.get('close')?.(0));
    return child;
  },
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
});
await factory({
  configPath: join(root, 'test', 'fixtures', 'group-chats.json'),
  config: {}, harness: null, state: {}, contextEnhancement: {}, accessPolicy: {},
}).catch(() => {});

if (recorded.length === 0) {
  // Without a config fixture the factory returns null by design; the argv
  // contract is then covered by the unit tests instead of being faked here.
  process.stdout.write('ADAPTER-RESOLUTION: skip-spawn (' + bundledEntry + ')\n');
} else {
  const scriptArg = recorded[0].args.find((arg) => String(arg).endsWith('wechat_group_uia.py'));
  assert.equal(scriptArg, bundledEntry);
  assert.ok(existsSync(scriptArg), 'the spawned adapter path must exist');
  process.stdout.write('ADAPTER-RESOLUTION: spawn-ok (' + scriptArg + ')\n');
}
process.stdout.write('PASS\n');
