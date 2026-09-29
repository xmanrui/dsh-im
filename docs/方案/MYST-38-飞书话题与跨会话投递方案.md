# MYST-38：飞书话题与跨会话投递方案

状态：待人工评审；此文是设计，不表示功能已实现。设计基线：`xmanrui/dsh-im` 的 `6626026`；本机另有未提交的飞书主动投递改动与领先上游四个提交，不作为已部署能力。

## 需求与边界

[Linear MYST-38](https://linear.app/castrel/issue/MYST-38) 要求群 Agent 校验 Issue 和仓库后，才在原群消息上创建一个飞书 Thread；向该 Thread 独立 DSH Session 送入带真实来源的首条 `user/message` 并启动正常轮次，不等用户第二次 `@`。后续话题消息继续同一 Session，结果只回原话题。bot、其他 Agent、event hook、scheduler 应复用一个独立的底层 cross-session 插件。不能把 `dsh_im_feishu_send` 的消息发送误作 Agent 输入，也不能伪造人类飞书事件或将自动来源写成 `source.kind: user`。

本设计覆盖 MYST-38 端到端链路的接口与验收；host-c1 镜像和 OpenSandbox 服务由 [Mystra Draft PR #65](https://github.com/Arcadia822/mystra/pull/65) 独立负责，本 PR 不修改其实现。安全隔离缺口在测试 MVP 阶段不阻止服务启动，但真实凭据和不可信任务仍不能以“服务已启动”作为安全验收。

## 方案方向

- **DSH Host 独立插件**负责授权、目标 Session 的查找/创建/续接、来源、去重及轮次接受/完成回执；其目标是 DSH Session，而非飞书目标。禁止复用现有未经业务鉴权的 `/api/dsh-im/delivery/messages` 作为任意 Session 写入口。
- **dsh-im 飞书适配**负责保留原群 `messageId`、在确认后开楼、将 `(botId, chatId, threadId)` 映射至独立 conversation key 与 Session、续接该会话，以及把生成结果安全地回复至原 Thread。
- **执行链路**将 Issue/仓库、权限、工作区与沙箱运行参数绑定到该话题任务；只有真实发布成功且目标 Issue 关联成功才进入 `In Review`。

以上是待审方案的起点；接口、并发与失败状态、迁移及逐项验收将在本文件补全后评审。