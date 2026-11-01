// host-registry-for-gate.mjs — 给判据脚本用的一层转发。
//
// 为什么不让 scripts/ 直接 import ../plugin-src/...：判据脚本与注册表分处两个
// 目录，相对路径在 Windows + ESM 下是最容易写错的一类（本仓踩过一次：argv[1]
// 到达时是盘符路径而不是 file: URL，字符串比对判不成「谁在被直接执行」）。
// 集中一处转发，路径只可能在这里错一次，而不是散落在每个判据里。
//
// 代价：导入注册表会连带装载 14 个渠道模块（本机实测约 860 ms）。换来的判据是
// 「声明与实现对账」，这点开销相对它拦住的失效模式可以忽略。
export { HOST_CHANNELS, deliveryKeyOf } from "../plugin-src/host/channel-registry.mjs";
