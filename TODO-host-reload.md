# 已闭环：宿主重启后复核（2026-11-01 15:05 实测通过）

## 真正的根因（不是本文早前写的 PYTHONHOME）

- 早前「宿主泄漏 PYTHONHOME」的解释已被测量推翻；PEB 读出的环境块也不支持它。
- 真根因：打包后的 `lib/index.js` 用 `resolve(import.meta.dirname, '../../../..')`
  推算包根，叠加 link: 符号链接，把适配器算成了 `D:/scripts/wechat_group_uia.py`，
  `py` 在解释器启动阶段就报 `can't open file`（stderr 恰好 153 字节）后退出。
  全文取证 = `docs/wechat-group-adapter-path-rootcause.md`。

## 修复与验证（全部通过）

- `src/channels/weixin/adapter-script.mjs::findAdapterScript()`：按包内 package.json 门槛上溯定位，不再数目录层级。提交 65918d0。
- 同轮再修两缺陷并加回归测试：`#restart()` 不重挂 bridge、事件被静默丢弃改为记原因。
- 第 9 轮用 `restart-dsh.cmd` 分离进程重启，**本会话存活**（纠正了旧文档「一重启本会话即终止、自证闭环被切断」的假设）。
- 微信登录后桥自动接上；群里一条 `/dsh 验收 FINAL-1793516690` → 收到宿主 Agent 回复（「老大。」前缀 + 唯一 token，探针从未发过）。
- 入站/处理/回发在宿主会话 `session-acb5509b…` 里逐条落库（`user/message` 带 `dsh_im_source{channel:weixin}` + 两条 `assistant/message`）。
- 全程无头：窗口未抢焦点，`allowWindowRestore` 保持 false。

## 重启后复核（本轮已全部满足）

1. ✅ 日志不再有 `group adapter stderr (153 bytes)`（重启后 last 2000 行 0 次）。
2. ✅ 进程出现 `python.exe -B D:\codex\DSH-IM\rv5.8.0\scripts\wechat_group_uia.py --config …` 且持续存活。
3. ✅ 群里发 `/dsh …` 收到 Agent 回复。

## 验收门

- `scripts/verify-wechat-group-live.mjs`（提交 79e7d69）：重启后 PASS；负向对照证明有牙（旧 `D:/scripts` 路径、缺失路径均判红）。
- 群三开关（读/发/触发）与白名单、`SPI_SETSCREENREADER=True`、目标群置顶，均保持就绪，无需再动。
