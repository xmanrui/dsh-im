import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { ADAPTER_SCRIPT_NAME, findAdapterScript } from '../src/channels/weixin/adapter-script.mjs';
import { FALLBACK_SCRATCH_ROOT } from './helpers/esbuild-scratch.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

// 负向对照 1（本轮新增）：证明 esbuild 兜底根**不是中立临时位置**。
//
// 兜底根在仓内（test/.tmp），从它向上走必然命中本仓 package.json
// （name 含 'dsh-im'），于是 findAdapterScript 合法地返回本仓的适配器脚本。
// 任何依赖"向上走找不到任何包"的 fixture，一旦把临时根挪进仓内就会假绿 ——
// 这在基线里真实发生过：把 TMP 指向仓内后 adapter-script 三条用例一起变红。
// 断言（有牙）：兜底根解析出的必须是本仓脚本，而不是 null。
test('the esbuild fallback root is inside this package and therefore not a neutral temp root', () => {
  assert.equal(
    findAdapterScript(FALLBACK_SCRATCH_ROOT),
    join(packageRoot, 'scripts', ADAPTER_SCRIPT_NAME),
  );
});

// 负向对照 2：仓外的系统临时根必须解析成 null，否则说明解析逻辑会误认无关祖先。
test('the neutral system temp root still resolves to nothing', () => {
  assert.equal(findAdapterScript(tmpdir()), null);
});
