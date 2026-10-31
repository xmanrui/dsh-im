import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Every IM channel must dispatch the shared session-navigation commands through
// the one seam (session-nav-command.mjs), rather than keeping a private copy.
// These guards pin that each non-text bridge really imports and calls the seam;
// the behaviour itself is covered by session-nav-command.test.mjs.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const BRIDGES = [
  'src/channels/feishu/bridge.mjs',
  'src/channels/dingtalk/dingtalk-bridge.mjs',
  'src/channels/wecom/wecom-bridge.mjs',
  'src/channels/wecom-app/wecom-app-bridge.mjs',
  'src/channels/weixin/weixin-bridge.mjs',
  'src/channels/qq/qq-bridge.mjs',
];

for (const bridge of BRIDGES) {
  test(`${bridge} dispatches the shared session-navigation commands`, () => {
    const source = readFileSync(join(repoRoot, bridge), 'utf8');
    assert.match(source, /session-nav-command\.mjs/, `${bridge} must import the shared seam`);
    assert.match(source, /\bisSessionNavCommand\s*\(/, `${bridge} must detect session-navigation commands`);
    assert.match(source, /\brunSessionNavTextCommand\s*\(/, `${bridge} must dispatch through the shared seam`);
  });
}
