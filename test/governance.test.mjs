import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { GOVERNANCE_FILES, inspectGovernance } from '../scripts/verify-governance.mjs';

// 判据必须有牙：下面每条都是「把治理骨架弄坏」的形态，必须分别被点名。
// 只查「文件存在」是不够的 —— CONTRIBUTING 不指向 SECURITY，读者到不了报告漏洞的地方。

const root = resolve(import.meta.dirname, '..');

/** 在临时目录里放一份可用的治理骨架副本，供负控修改。 */
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'gov-'));
  for (const entry of GOVERNANCE_FILES) {
    const source = resolve(root, entry.path);
    const target = resolve(base, entry.path);
    await cp(source, target, { recursive: true });
  }
  return base;
}

test('the real repository passes', async () => {
  const result = await inspectGovernance(root);
  assert.deepEqual(result, { missing: [], dangling: [] });
});

test('a missing file is named', async () => {
  const base = await fixture();
  try {
    await unlink(resolve(base, 'SECURITY.md'));
    const { missing } = await inspectGovernance(base);
    assert.ok(missing.includes('SECURITY.md'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// 负向对照：文件都在，但 CONTRIBUTING 不再指向 SECURITY —— 这是「摆设式治理」的典型形态。
test('a broken cross-reference is reported even when every file exists', async () => {
  const base = await fixture();
  try {
    const path = resolve(base, 'CONTRIBUTING.md');
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replaceAll('SECURITY.md', 'security-doc.md'));
    const { missing, dangling } = await inspectGovernance(base);
    assert.deepEqual(missing, []);
    assert.ok(dangling.some((entry) => entry.startsWith('CONTRIBUTING.md -> SECURITY.md')), dangling.join(','));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('an issue template that stops pointing at the security policy is caught', async () => {
  const base = await fixture();
  try {
    const path = resolve(base, '.github/ISSUE_TEMPLATE/bug.yml');
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replaceAll('SECURITY.md', '某文档'));
    const { dangling } = await inspectGovernance(base);
    assert.ok(dangling.includes('.github/ISSUE_TEMPLATE/bug.yml -> SECURITY.md'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
