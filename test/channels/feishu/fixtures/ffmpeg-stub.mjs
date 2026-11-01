#!/usr/bin/env node
// ffmpeg-stub.mjs — 语音管线测试用的跨平台 ffmpeg 替身（不是生产代码）。
//
// 它做什么：不转码，只把 -i 后面的输入文件复制到最后一个参数（输出路径），
// 用来证明「转写/合成管线确实调用了一个退出码为 0 的子进程并把字节交了出去」。
//
// 为什么要有这个文件：原替身是 ffmpeg-stub.sh，只有 POSIX shell 能执行，
// 于是 Windows 上依赖它的 5 条用例整批 skip —— 语音链路在本机 CI 永远不跑，
// 这是报告 §3.2 登记的测试面盲区（M5）。node 是仓库已有的运行前提，
// 用 node 写替身后同一批用例在 win32/linux 都能真跑子进程。
//
// 参数形态与 src/channels/feishu/voice.mjs 的默认 runner 保持同形：
// 调用方会传 [bin, -hide_banner, -loglevel, error, -y, ...真实参数]，
// argv[0] 是被配置的 ffmpeg 路径（这里只透传不解释），其余按 -i/末位解析。
import { copyFileSync, appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);

// 留痕：把每次收到的参数写进旁路文件（测试用来自证"确实 spawn 过、参数形状对"）。
// 路径由调用方通过环境变量注入，缺省不写，避免污染真实运行目录。
if (process.env.DSH_FFMPEG_STUB_LOG) {
  appendFileSync(process.env.DSH_FFMPEG_STUB_LOG, argv.join('\n') + '\n---\n');
}

let input = null;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '-i') input = argv[i + 1];
}
const output = argv.at(-1);

if (input && output) {
  try {
    copyFileSync(input, output);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`ffmpeg-stub copy failed: ${error.message}\n`);
    process.exit(1);
  }
}
process.stderr.write('ffmpeg-stub: missing -i input or output path\n');
process.exit(2);
