# 待办：宿主重启后复核（唯一未闭环项）

## 现在的状态

- 群桥代码已修好、提交、构建、部署（部署 md5 与构建一致）。
- **无头能力已实测通过**（窗口最小化）：`STARTED 2.7s / SEND ok / READBACK 1 addressed=true`。
- 宿主环境模拟（宿主同款 PYTHONPATH）下，清理后适配器 ready 并收到真实群消息。

## 宿主这边的事实（已取证，不猜）

- 宿主主进程启动于 **2026-11-01 00:53:12**，而最后修复是 **01:05** 才构建 → 它跑的是旧 JS。
- 每 30 秒出现一次 `group adapter stderr (153 bytes)`，日志里**从未**出现我们代码会打的
  `sanitized error (...)` 帧 → 宿主的子进程在**执行脚本第一行之前**就死了。
- 临时在脚本首行装了 env 追踪（已验证在直连 spawn 时会写文件），跨两个重试周期宿主**一次都没写入**
  → 确认死在我们代码之前，不是适配器逻辑问题。
- 本地穷举复现 153 字节：坏 PYTHONHOME(1426) / 仅 PYTHONPATH(0) / 空 SystemRoot(0) / 空 PATH(0) /
  关开关(0) / uiautomation 超时(0) —— **没有任何组合产出 153**。所以那 153 字节不来自我们的 Python。
- 从外部读宿主 PEB 环境块：读到 1944 字节 60 项，但块内容部分损坏/截断，**据此得出的环境结论一律标为未证**。
  （之前写的「宿主泄漏 PYTHONHOME」已被测量推翻，那条修复只作为卫生措施保留。）

## 唯一出路

重启 DSH Desktop。重启会重新读取启动环境（PATH/PYTHON* 都在此时定型），并且装载新 bundle。
而**本会话就活在这个宿主里**，一重启本会话即终止 → 自证闭环被切断，不是能力缺口。

## 重启后的复核（任一条即可）

1. 日志不再出现 `group adapter stderr (153 bytes)`；
2. 群里发 `/dsh 测试`（**不是 @**，@ 在本设计下永远不触发），看到 Agent 回复；
3. 进程列表出现 `py -3.12 ... wechat_group_uia.py --config ...` 且持续存活。

## 已就绪、无需再动

- 账号 `wx_c087f36721de6f68e06924cf` 的 group-chats.json（群、读/发开、抢屏关）
- 群白名单 `uia-unverified:row` canExecuteCommands=true
- `SPI_SETSCREENREADER=True`
- 目标群已置顶，按标题可选中
- 抢屏默认关闭，有单测守着它一个 Win32 调用都不许发
