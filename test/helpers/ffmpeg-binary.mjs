// helpers/ffmpeg-binary.mjs — 跨平台找一个「真的能跑」的 ffmpeg。
//
// 为什么需要它：Windows 上 ffmpeg 常常存在但不在 PATH（本机实测：PATH 里没有，
// 但 imageio_ffmpeg 的 wheel 里带了一个 v7.1 可执行文件）。测试此前只试裸 `ffmpeg`，
// 找不到就 t.skip —— 于是「真实转码产物」这条用例在 Windows 上永久不执行，而那正是
// 最容易漏掉容器格式差异的地方（Host 侧只验 WAV 形状，没验真实 ffmpeg 的输出）。
//
// 顺序：显式环境变量 > PATH 上的名字 > 已知打包/常见安装位置。全部失败才返回 null，
// 由调用方决定 skip —— skip 是「本机确实没有」的诚实结论，不是「懒得找」。

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 定向遍历（不是全盘 find）：只在明确的 site-packages 里找「名字含 ffmpeg 的包」，
// 再到该包的 binaries/ exe/ win64/ bin/ 子目录里取 ffmpeg 可执行文件。
// 本机实测：PATH 上没有 ffmpeg，但 imageio_ffmpeg 的 wheel 自带 v7.1 可执行文件。
const BIN_DIRS = ['binaries', 'exe', 'bin', 'win64', 'win32'];
const MAX_PACKAGE_DIRS = 600; // 只数包目录，不做无界扫描

function isExeName(name) {
  // ffmpeg / ffmpeg.exe / ffmpeg-win-x86_64-v7.1.exe / ffmpeg.exe.download
  if (process.platform === 'win32') return /^ffmpeg\b.*\.exe(\..+)?$/i.test(name) || /^ffmpeg\.exe$/i.test(name);
  return /^ffmpeg([-_.].*)?$/i.test(name) && !/\.(py|txt|md|json|dist-info)$/i.test(name);
}

function packageDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .slice(0, MAX_PACKAGE_DIRS);
  } catch {
    return [];
  }
}

function collectFromRoot(root, out) {
  // root 可能是 .../Python、.../Python312、或直接 site-packages；逐层下钻到 site-packages。
  const siteRoots = [];
  if (/site-packages$/i.test(root)) siteRoots.push(root);
  for (const name of packageDirs(root)) {
    const full = join(root, name);
    if (/^python\d*$/i.test(name)) {
      if (existsSync(join(full, 'site-packages'))) siteRoots.push(join(full, 'site-packages'));
      // 三层结构（Python/Python312/Lib/site-packages）也兜住
      if (existsSync(join(full, 'Lib', 'site-packages'))) siteRoots.push(join(full, 'Lib', 'site-packages'));
    }
    if (/^site-packages$/i.test(name)) siteRoots.push(full);
  }
  if (existsSync(join(root, 'site-packages'))) siteRoots.push(join(root, 'site-packages'));
  for (const site of new Set(siteRoots)) {
    for (const pkg of packageDirs(site)) {
      if (!/ffmpeg/i.test(pkg)) continue; // 只看 ffmpeg 相关包：imageio_ffmpeg / static_ffmpeg / ffmpeg-python
      const pkgDir = join(site, pkg);
      for (const sub of ['', ...BIN_DIRS]) {
        const dir = sub ? join(pkgDir, sub) : pkgDir;
        if (!existsSync(dir)) continue;
        for (const name of packageDirs(dir).concat(safeFiles(dir))) {
          if (isExeName(name)) out.push(join(dir, name));
        }
      }
    }
  }
}

function safeFiles(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * 候选路径：显式环境变量 > PATH 上的名字 > 已知 wheel 自带的可执行文件。
 * @returns {string[]} 按优先级排列（可能含不存在/不可执行项，由 findFfmpeg 实测）
 */
export function ffmpegCandidates() {
  const out = [];
  if (process.env.DSH_IM_FFMPEG) out.push(process.env.DSH_IM_FFMPEG);
  out.push('ffmpeg');
  const roots = [
    join(homedir(), 'AppData', 'Roaming', 'Python'),
    join(homedir(), 'AppData', 'Local', 'Programs', 'Python'),
    join(homedir(), '.cache'),
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'ffmpeg') : null,
  ].filter(Boolean);
  for (const root of roots) {
    if (existsSync(root)) collectFromRoot(root, out);
  }
  return [...new Set(out)];
}
/**
 * 可用性 = 能 spawn 且 -version 退 0；返回探过的候选数供 skip 理由引用。
 * @returns {{path: string|null, probed: number}}
 */
export function findFfmpeg() {
  const candidates = ffmpegCandidates();
  for (const candidate of candidates) {
    const r = spawnSync(candidate, ['-version'], { encoding: 'utf8', timeout: 15_000 });
    if (!r.error && r.status === 0) return { path: candidate, probed: candidates.length };
  }
  return { path: null, probed: candidates.length };
}