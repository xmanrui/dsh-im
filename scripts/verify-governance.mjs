#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 判据：治理骨架必须存在且互相引用。
 *
 * 为什么需要脚本而不是「文件在不在」：本仓有 86 个 open issue 与 3,000+ stars，
 * 但没有贡献入口 —— 外部 PR 没有可读的流程，维护者每次都要口头解释一遍。
 * 光把文件放进去还不够：入口必须真的指向对方（README → CONTRIBUTING，
 * CONTRIBUTING → SECURITY），否则文件是给人看的摆设。
 *
 * 用法：node scripts/verify-governance.mjs
 */

const root = resolve(import.meta.dirname, '..');

/** 必须存在的文件，以及它们必须互相引用的目标。 */
export const GOVERNANCE_FILES = Object.freeze([
  { path: 'CONTRIBUTING.md', mustLink: ['SECURITY.md', 'CODE_OF_CONDUCT.md', '.github/PULL_REQUEST_TEMPLATE.md'] },
  { path: 'SECURITY.md', mustLink: ['3753318894@qq.com'] },
  { path: 'CODE_OF_CONDUCT.md', mustLink: ['Contributor Covenant'] },
  { path: '.github/PULL_REQUEST_TEMPLATE.md', mustLink: ['npm run check'] },
  { path: '.github/ISSUE_TEMPLATE/bug.yml', mustLink: ['SECURITY.md'] },
  { path: '.github/ISSUE_TEMPLATE/feature.yml', mustLink: ['ADR-0001'] },
  { path: '.github/ISSUE_TEMPLATE/config.yml', mustLink: ['SECURITY.md'] },
]);

/**
 * 检查文件存在且引用了应引用的一方。
 *
 * @returns {Promise<{missing: string[], dangling: string[]}>}
 */
export async function inspectGovernance(baseDirectory = root) {
  const missing = [];
  const dangling = [];
  for (const entry of GOVERNANCE_FILES) {
    const path = resolve(baseDirectory, entry.path);
    try {
      await access(path);
    } catch {
      missing.push(entry.path);
      continue;
    }
    const text = await readFile(path, 'utf8');
    for (const target of entry.mustLink) {
      if (!text.includes(target)) dangling.push(entry.path + ' -> ' + target);
    }
  }
  return { missing, dangling };
}

async function main() {
  const { missing, dangling } = await inspectGovernance();
  if (missing.length > 0) {
    console.error('GOVERNANCE_MISSING: ' + missing.join(' | '));
    process.exitCode = 1;
    return;
  }
  if (dangling.length > 0) {
    console.error('GOVERNANCE_DANGLING: ' + dangling.join(' | '));
    process.exitCode = 1;
    return;
  }
  console.log('GOVERNANCE_OK ' + GOVERNANCE_FILES.length + ' files, cross-references intact');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
