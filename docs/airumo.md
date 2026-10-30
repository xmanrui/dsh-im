# AIRumo

[AIRumo 官网](https://airumo.cn/) · [官方 Bot API 文档](https://api.airumo.cn/_airumo/bot/v1/guide)

## 配置

1. 在 AIRumo 创建机器人，在「接入与状态」中复制专属 Token。
2. 打开 DSH-IM → AIRumo → 手动接入，填写 Token 并绑定。Token 由 Harness 凭据服务保存，不写入普通连接配置。
3. 按需选择 Agent Preset。在 AIRumo 配置可见范围、允许的联系人及群响应规则。
4. 私聊机器人发送问题，再发送一句追问；群聊使用 AIRumo 中配置的触发规则。

Host 向官方 HTTPS Bot API 发起出站长轮询，无需开放入站端口。保持 Harness 在线；一个机器人 Token 只运行一个连接实例，不要同时在另一台机器连接。私聊及显式话题按 AIRumo 的 session_id 分开；群回复规则返回每请求独立的 `rule:<rule-id>:request:<request-id>` 时，按机器人、群房间和规则复用同一会话并串行执行。不同群、规则和话题保持独立。已有拆分会话不拼接历史，Agent Preset 不会合并对话历史。

## 行为与限制

- 文本、输入附件和 Harness 返回的文件走现有附件流程；输入文件限制 30 MiB，输出最多 10 个附件。超过 JSON 大小限制的长答案改为 Markdown 附件。
- 只发送最终答案；处理状态不包含模型思考和工具输出。AIRumo 控制访问和群消息投递，插件不额外提供本地访问名单。
- 状态心跳独立于消息长轮询；模型不可用时报告 unavailable，不接受新的模型执行。暂停或 Token 失效时停止连接，恢复后可手动检查连接。
- 请求编号去重、同会话串行处理、不同会话最多并发 2 项。平台取消或到期仅取消该请求拥有的 Harness 输入或执行。
- 在模型提交前保存执行句柄；重启后只查询原执行，不重新执行已接受且结果不明的任务。最终结果保存后按相同幂等键重试发布。附件上传途中中断会明确报结果未知，不会返回缺附件的成功结果；不支持跨进程恢复分片上传。
- 当前 Bot API 没有主动向任意聊天推送的接口，因此不支持主动提醒、双向同步或 Web 端授权卡片转发，也不支持 DSH-IM 的斜杠命令菜单。配置与日常聊天不依赖特定业务插件。

适配器测试使用模拟平台和临时状态目录。真实 AIRumo 联调请在自己的机器人上核对私聊追问、群聊、附件和取消，不要把 Token 写进 issue。

## English

[AIRumo website](https://airumo.cn/) · [Official Bot API guide](https://api.airumo.cn/_airumo/bot/v1/guide)

Create an AIRumo bot, copy its dedicated Token from its connection settings, then bind it in **DSH-IM → AIRumo**. Optionally select an Agent Preset. Configure visibility, contacts and group response rules in AIRumo. Harness stores the Token through its credential service.

The Host uses outbound HTTPS long polling; no public inbound port is required. Keep Harness running and use one connection instance per bot Token. DMs and explicit topics retain their AIRumo session IDs. Group reply rules with per-request `rule:<rule-id>:request:<request-id>` IDs share a stable bot/room/rule conversation and run serially. Other rooms, rules, bots and explicit topics remain separate; earlier split histories are not merged. Test a question and a follow-up in the same conversation.

The adapter supports input attachments (30 MiB limit), returned files (up to 10 attachments), cancellation, independent status heartbeats and durable request/result state. Long replies exceeding the JSON envelope limit become Markdown attachments. Only final answers are published; reasoning and tool traces are not sent. Same-session requests are serialized, with at most two concurrent sessions.

After restart the adapter observes the original execution rather than replaying uncertain work. Cached final results retain their idempotency key when publication is retried. An interrupted artifact upload reports an unknown outcome instead of success with missing files; multipart uploads are not resumed across process restarts.

The current API does not support arbitrary proactive messages, reminders, bidirectional sync, forwarded Web approval cards or DSH-IM slash-command menus. AIRumo owns access and group trigger rules. Automated tests use mocks and temporary state; live platform verification should cover DMs, follow-ups, groups, attachments and cancellation without publishing Tokens.
