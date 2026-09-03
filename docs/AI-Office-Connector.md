# AI Office Connector

「AI Office」页让本机 Harness 主动连接公网 Office，本机无需公网 IP、端口转发或 WebSocket 服务。Device Token 只写入 Harness 凭据存储；普通配置文件仅保存设备 ID、Office Origin、工作区 alias 和 Instruction Preset alias。Office 只能选择 alias，不会收到本机绝对路径。

当前协议版本为 `office-harness.v1`。连接器使用 `POST /api/harness/connector/heartbeat` 完成鉴权和能力握手，再以 `GET /api/harness/connector/stream` 建立 SSE 下行；设置页会从 Office Base URL 自动展示全部固定 Hook，并在断线后按退避策略自动重连。

Office 的 `job.available` 会触发本机拉取任务、校验 Workspace/Preset alias、领取 90 秒租约并每 30 秒续租。连接器创建独立 Harness Session，把状态、工具名和增量文字安全回传 Office，终态只允许写入一次。Harness 发起的工具审批或补充问题会进入 Office 人工面板；批准、拒绝或文字答案再经 SSE 回到原 Session，断线时由租约与 Heartbeat 恢复。

Heartbeat 成功响应必须是 JSON：`{"ok":true,"protocolVersion":"office-harness.v1"}`。这使「连接测试通过」代表命中了兼容的 Office Connector，而不只是某个碰巧返回 200 的网址。
