# Issue #229：无文本完成误报修复与 QQ 实测

2026-09-20，基于 dsh-im 4.22.0 实施。生产源码仅调整共享 Harness 客户端和一条英文翻译，各渠道继续使用原有回复与错误处理机制。

## 原因与修复

原先 `ask()` 已确认回合 `completed`，但在文本为空、附件交接数量为零时仍调用 `harnessTurnError()`，将正常结束映射成 `model-empty-response / MODEL_EMPTY_REPLY`。只有工具调用、没有 assistant 文本的正常回合因此收到错误提示。

本次改动：

- 明确 `completed`、无文本且无附件时，返回普通字符串“本轮处理已结束，没有文本回复。”，复用渠道的正常发送、卡片结束及状态更新流程。
- 兼容字符串和对象形式的 `completed`。结束原因缺失且没有可见结果时保留异常处理。
- 删除 `completed` 到 `model-empty-response` 的错误映射；模型实际返回的 `EMPTY_RESPONSE` 仍走原有错误分类。
- 保存附件交接的首个异常；当没有其他文本或成功交接的附件时继续抛出原异常，避免新提示掩盖附件交接失败。
- 为 `HarnessTurnError` 补齐缺失的 `details`，包含 `sessionId`、`promptRpcId`、`baselineSeq`、`turn`、`lastSeq`。保留原有参考号及已有超时字段，渠道日志继续记录错误对象。
- 补充英文提示：`This turn has ended with no text reply.`

该提示只说明回合结束，不承诺所有工具操作或业务目标成功。工具错误仍通过既有进度回调传递，QQ 继续追加原有工具失败提示。

## 自动化验证

`npm run check` 通过：构建成功，3056 项测试通过、0 失败，发布包产物校验通过。

新增或更新的回归覆盖包括：

- 明确完成的空回复、空白回复，字符串/对象结束原因及中英文提示。
- 只有 reasoning 与工具调用的回合；已有前序文本时保留文本；工具错误进度继续传递。
- 文件单独回复，以及附件交接失败时保留原异常。
- 真实模型 `EMPTY_RESPONSE`、缺失结束原因、回合错误及诊断字段。
- QQ 正常发送中性提示、保留工具失败提示、更新回复统计并清除旧错误。
- 共享流式渠道正常结束卡片，不遗留处理中状态。

现有停止、超时、非成功状态的部分文本及其他渠道测试一并通过。完整检查后仅调整了测试缩进，生产源码和构建产物没有再修改。

## 本机 winBot 实测

环境为 macOS、Node.js 24.19.0、DSH `0.1.6-alpha.2`（`ddefc45`）、本机 `127.0.0.1:3080`，通过已登录 QQ 客户端向 winBot 私聊发送，并用 QQ 可访问性文本、截图和 Harness 持久化事件交叉核验。

第一次测试在原有会话调用 bash 时失败，回合结束原因为 `error / UNKNOWN`，错误为 `Cannot read properties of undefined (reading 'prepare')`，参考号 `MF-1F6D76F8`。当时本机通过 `node --import tsx/esm apps/cli/src/bin.ts` 启动，与此前本机记录的源码/构建产物混用问题一致；这次失败发生在工具执行前，不属于空回复误报。

确认没有正在运行的会话后，将启动入口切换为同版本已有的 `apps/cli/lib/bin.js`，保留原有 DSH_HOME、模型配置、机器人配置和工作区。通过 QQ `/new` 创建测试会话，旧会话和失败记录均保留。

成功测试的会话：`session-ef3fc7bf-393b-402c-a5a8-3a9d186636d9`。新会话使用现有默认模型 `deepseek-official / deepseek-v4-flash`，推理等级 `high`；没有修改模型配置。

| 测试 | Harness 证据 | QQ 实际结果 |
| --- | --- | --- |
| 纯工具执行、禁止文本回复 | turn 1：bash 执行 `printf ISSUE229_QQ_TOOL_OK_20260920`；工具结果 `isError: false`；assistant 部分为 reasoning、tool-call、reasoning，没有 text；`turn/end.reason.kind = completed` | 收到“本轮处理已结束，没有文本回复。”，没有错误码或参考号 |
| 普通文本回复 | turn 2：没有工具调用，assistant 包含指定文本；`turn/end.reason.kind = completed` | 收到独立回复 `ISSUE229_QQ_TEXT_OK_20260920` |

最终机器人为 `connected / healthy`，收到 3 条消息（含 `/new`），完成 2 次模型回复，`lastMessageError: null`、`error: null`。测试会话已结束运行，QQ 输入框为空。

## 最终状态与证据

- 修复后的构建继续在本机运行。Host 启动入口为 `apps/cli/lib/bin.js`，监听地址保持不变。
- winBot 当前绑定上述新会话；原会话 `session-be4e07c9-6fa6-434c-a10b-0771ced0be15` 仍保留。
- 用于最初加载补丁的临时 HMR 配置已移除，profile patch 与测试前备份逐字节一致。
- 没有发布新版本，没有修改 DSH 源码；原先工作区内无关改动保留。
- 验收构建 `lib/index.js` SHA-256：`ba59e0e932f1232d5342bc380a29f0bdeaec899f43e968be4a59525340e11e95`。
- 本机证据目录：`/Users/manruixie/.dsh-test-evidence/issue229-20260920`。保留完整检查日志、失败与成功回合事件、成功回合摘要、最终机器人状态、客户端观察记录、profile 备份及构建哈希。启动日志包含本机登录信息，仅留在本机。
