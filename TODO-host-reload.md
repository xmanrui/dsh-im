# 待办：宿主装载新 bundle（唯一未闭环项）

## 现在的状态

- 群桥代码已全部修好、提交、构建、部署（部署 md5 与构建一致）：
  b370e36 启动失败后重试 / 7c02abc 切会话读回验证 / 32b7a15 清理 PYTHONHOME 泄漏。
- 无头实测通过：窗口最小化时 **STARTED 2.7s / SEND ok / READBACK 1（addressed=true）**。
- 宿主环境模拟通过：用宿主同款 PYTHONHOME/PYTHONPATH，清理后适配器 ready 并收到真实群消息。

## 为什么还没好

运行中的 DSH Desktop 主进程启动于 **2026-11-01 00:53:12**，而最后三处修复是 **01:05** 才落包的。
它执行的是那次启动时载入的旧 JS，所以仍在用旧逻辑（带 PYTHONHOME 泄漏）每 30 秒重试并失败：
日志里持续出现 `group adapter stderr (153 bytes)`。

## 唯一出路 = 重启 DSH Desktop

但**本验证会话就活在这个宿主里**：一重启，本会话立刻终止，没有执行者能做重启后的读回。
这是自证闭环被切断，不是能力缺口。

## 重启后的复核（任一条即可）

1. 日志不再出现 `group adapter stderr (153 bytes)`，且出现群桥 ready；
2. 群里发 `/dsh 测试`（**不是 @**，@ 在本设计下永远不触发），看到 Agent 回复；
3. 进程列表出现 `py -3.12 ... wechat_group_uia.py --config ...` 且持续存活。

## 已就绪、无需再动

- 账号 `wx_c087f36721de6f68e06924cf` 的 group-chats.json（群、读/发开、抢屏关）
- 群白名单 `uia-unverified:row` canExecuteCommands=true（否则事件会被安全策略静默丢弃）
- `SPI_SETSCREENREADER=True`（scripts/enable_wechat_uia_flag.py）
- 目标群已置顶，按标题可选中
