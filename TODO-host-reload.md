# 待办（本轮未能闭环的唯一一项）

## DSH 宿主加载新插件代码

- 现状：运行中的 DSH Desktop 主进程 PID 12772，启动于 2026-10-31 21:26:51，仍在执行改前的模块树。
- 证据：host 日志 dsh-2026-10-31.8.log 中 `dsh-im` / `reload plugin` / `watching` 均 0 命中；profile 的
  `node_modules/@xmanrui/dsh-im` 是符号链接指向本仓，所以「部署文件哈希一致」只能算文件级证据，不算已加载。
- 为什么没做：唯一的激活方式是重启 DSH Desktop，而**本会话正运行在该宿主内**；重启会立刻终止本会话，
  也就没有执行者做重启后的读回复验。这不是偏好问题，是自证闭环被切断。
- 复核方式（重启后任一条即可）：
  1) host 日志出现 `[dsh-weixin] ... group` 相关新行；
  2) `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:43120/api/dsh-im/weixin` 由 401 变为可鉴权访问后，
     用 management RPC 调 `connection.status` 读到 group.ready=true；
  3) 群里发 `/dsh 测试` 并在群里看到 Agent 回复（真实端到端）。

## 已就绪、无需再动的部分

- 账号 `wx_c087f36721de6f68e06924cf` 的 `group-chats.json`：目标群、三个开关（读/发开、抢屏关）齐备。
- 群访问白名单：`uia-unverified:row` 且 canExecuteCommands=true（否则事件会被安全策略静默丢弃）。
- 系统 `SPI_SETSCREENREADER=True`（脚本 `scripts/enable_wechat_uia_flag.py`）。
- 目标群已在微信里置顶，故按标题可选中。
- 插件拒绝抢屏：窗口最小化时以 `window_minimised` 离线，不还原、不抢焦点（有测试守着）。
