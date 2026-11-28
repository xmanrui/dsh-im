#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const PACKAGE_NAME = '@xmanrui/dsh-im';
const DEFAULT_SOURCE = 'github:xmanrui/dsh-im';
const LEGACY_PACKAGES = [
  '@xmanrui/dsh-feishu',
  '@xmanrui/dsh-weixin',
  '@xmanrui/dsh-dingtalk',
];

function usage() {
  console.log(`Usage:
  dsh-im install [--profile web] [--source <package-spec>]
  dsh-im uninstall [--profile web]

Examples:
  npx -y github:xmanrui/dsh-im install
  dsh-im install --source .`);
}

function takeOption(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function runDsh(args) {
  const result = spawnSync('dsh', args, {
    cwd: tmpdir(),
    stdio: 'inherit',
    shell: false,
  });
  if (result.error?.code === 'ENOENT') {
    throw new Error('找不到 dsh，请先安装 DeepSeek Harness 并确保 dsh 在 PATH 中。');
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`dsh 退出，状态码 ${result.status ?? 1}`);
}

async function directProfilePackages(profile) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const profilePackage = join(dshHome, 'profiles', profile, 'package.json');
  try {
    const manifest = JSON.parse(await readFile(profilePackage, 'utf8'));
    const bundles = new Set(manifest.dsh?.profile?.bundles ?? []);
    const dependencies = manifest.dependencies ?? {};
    return new Set(LEGACY_PACKAGES.filter((name) => dependencies[name] || bundles.has(name)));
  } catch (error) {
    if (error?.code === 'ENOENT') return new Set();
    throw new Error(`无法读取 Harness 配置 ${profilePackage}：${error.message}`);
  }
}

/** Major version of the pnpm first on PATH; null when it cannot be determined. */
function currentPnpmMajor() {
  const result = spawnSync('pnpm', ['--version'], { encoding: 'utf8', shell: false });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  const match = result.stdout.trim().match(/^(\d+)\./);
  return match ? Number(match[1]) : null;
}

/**
 * Refuse to run when the profile's node_modules was built by another pnpm major: pnpm rejects
 * cross-major node_modules, and it appends its own version directory under any storeDir, so a
 * storeDir override cannot fix it and the automatic rollback fails the same way. Skips silently
 * when the check cannot decide (no node_modules yet, unparseable marker, or no pnpm on PATH —
 * the dsh command reports that itself), so it never blocks a healthy install.
 */
async function assertCompatiblePnpmModules(profile, remedy) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const modulesDir = join(dshHome, 'profiles', profile, 'node_modules');
  let modules;
  try {
    modules = await readFile(join(modulesDir, '.modules.yaml'), 'utf8');
  } catch {
    return;
  }
  const built = modules.match(/^packageManager:\s*pnpm@(\d+)\./m);
  const running = currentPnpmMajor();
  if (!built || !running || Number(built[1]) === running) return;
  const builtMajor = Number(built[1]);
  throw new Error([
    `profile ${profile} 的 node_modules 由 pnpm ${builtMajor}.x 建成，而当前 PATH 上的 pnpm 是 ${running}.x，本次安装不会成功：pnpm 拒绝跨大版本复用 node_modules，且它会在任何 storeDir 下再拼自己的版本目录，所以调整 storeDir 修不好，失败后的自动回滚也会以同样方式失败。`,
    '任选其一修复后重跑本命令：',
    `  1) 清空 node_modules 让当前 pnpm 重建（插件市场的 UI 安装只能走这条；已装插件会按 package.json 自动恢复，包会重新下载一次）：`,
    `     rm -rf "${modulesDir}"`,
    `  2) 改用 pnpm ${builtMajor}.x 执行同一命令（把该版本的 pnpm 提到 PATH 最前，路径按本机安装位置调整；macOS Homebrew 安装在 /opt/homebrew/bin）：`,
    `     PATH="/opt/homebrew/bin:$PATH" ${remedy}`,
  ].join('\n'));
}

const args = process.argv.slice(2);
const command = args.shift();

if (!command || command === '--help' || command === '-h') {
  usage();
  process.exit(0);
}

try {
  const profile = takeOption(args, '--profile', 'web');
  if (command === 'install') {
    const requested = takeOption(args, '--source', DEFAULT_SOURCE);
    const source = requested === '.' || requested === '..'
      || requested.startsWith('./') || requested.startsWith('../')
      ? resolve(process.cwd(), requested)
      : (isAbsolute(requested) ? requested : requested);
    if (args.length > 0) throw new Error(`无法识别的参数：${args.join(' ')}`);

    await assertCompatiblePnpmModules(profile, `dsh plugin --profile ${profile} add --save-exact ${source}`);

    const legacy = await directProfilePackages(profile);
    runDsh(['plugin', '--profile', profile, 'add', '--save-exact', source]);
    for (const packageName of legacy) {
      runDsh(['plugin', '--profile', profile, 'remove', packageName]);
    }
    console.log('\nIM 机器人插件已安装。请重启 dsh web、刷新浏览器，然后打开「设置 → IM机器人」。');
    if (legacy.size > 0) {
      console.log('已用 dsh-im 替换独立飞书/微信/钉钉插件；原有凭据和扫码绑定保持不变。');
    }
  } else if (command === 'uninstall') {
    if (args.length > 0) throw new Error(`无法识别的参数：${args.join(' ')}`);
    await assertCompatiblePnpmModules(profile, `dsh plugin --profile ${profile} remove ${PACKAGE_NAME}`);
    runDsh(['plugin', '--profile', profile, 'remove', PACKAGE_NAME]);
    console.log('\nIM 机器人插件已卸载。请重启 dsh web。');
  } else {
    throw new Error(`无法识别的命令：${command}`);
  }
} catch (error) {
  console.error(`dsh-im: ${error.message}`);
  process.exit(1);
}
