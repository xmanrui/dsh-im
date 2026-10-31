import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the published package contains the complete WeChat group bridge and pinned UIA adapter', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const path of ['scripts/wechat_group_uia.py', 'scripts/requirements-wechat-group.txt']) {
    assert.ok(manifest.files.includes(path), `package.json files must include ${path}`);
  }

  const verify = await readFile(new URL('../scripts/verify-package.mjs', import.meta.url), 'utf8');
  for (const path of [
    'src/channels/weixin/wechat-group-conversation.mjs',
    'src/channels/weixin/wechat-group-config.mjs',
    'src/channels/weixin/wechat-group-process.mjs',
    'src/channels/weixin/wechat-group-runtime.mjs',
    'scripts/wechat_group_uia.py',
    'scripts/requirements-wechat-group.txt',
  ]) {
    assert.ok(verify.includes(`'${path}'`), `verify-package required must include ${path}`);
  }

  const requirements = await readFile(new URL('../scripts/requirements-wechat-group.txt', import.meta.url), 'utf8');
  assert.match(requirements, /^uiautomation==2\.0\.29$/m);
});
