# Issue #192：模型失效自救修复与飞书实测

需求：https://github.com/xmanrui/dsh-im/issues/192

测试时间：2026-09-10 22:44–22:52，Asia/Taipei。

## 修复内容

无会话的 `/model` 现在创建不继承机器人模型的会话，再执行原有的模型选择、回读确认和绑定。机器人保存的模型或思考强度失效，不再阻断用户本次显式选择。

- 机器人作用域的 `createSession` 增加内部选项 `inheritBotModel`，默认仍继承；选项在调用 Host 前剥离。
- 只有无会话的 `/model` 传入 `inheritBotModel: false`。已有会话切换、普通消息的默认模型继承、工作区与 Preset、取消信号及绑定校验沿用原流程。
- `model-unavailable` 和 DSH 0.1.5-rc.1 的 `session/model-unavailable` 均识别为模型不可用。中英文提示区分当前聊天的 `/model` 恢复与机器人卡片的后续新会话默认设置。
- 不增加自动降级、配置清理、状态字段、依赖或存储迁移。`/model` 不改写 dsh-im 的机器人卡片模型配置。

机器人卡片继续保存失效值时，后续 `/new` 后的普通消息仍会按原配置报错，但可以再次通过 `/model` 恢复；在卡片修正默认模型后，后续新会话恢复正常。

## 自动化验证

新增组合回归使用真实 `BotWorkspaceStore`、`createBotWorkspaceScope`、`ConversationStateStore`、`runModelCommand` 和普通消息桥接，模拟 Host 边界。

先在原实现上运行，新测试确认旧模型会挡住用户选择。修复后覆盖：保存模型失效、保存强度失效、只应用一次目标选择、工作区/Preset/信号保留、内部选项不泄漏到 Host、成功后普通消息可回复、`/new` 后仍保留机器人配置，以及目标被拒绝或回读不一致时不绑定会话。

最终 `npm run check`：**2,646 项测试通过，0 失败**；构建与包产物验证通过。`git diff --check` 通过。

## 本机飞书实测

- DSH：原版 `0.1.5-rc.1`，目录 `/Users/manruixie/code/new-dsh/dsh-v0.1.5-rc.1`，Web profile，端口 3080。
- dsh-im：当前工作区构建，通过已有本地链接加载。
- 机器人：飞书客户端中的“今天是牢梁”，真实私聊收发。
- 通过临时、隔离的 HMR 监听加载新插件。Host 始终是 PID `64866`，启动时间始终为 `2026-09-10 21:21:35`，未重启 Host、未修改 DSH 源码。插件重载期间各渠道连接重新建立。
- 备份目标配置后，仅将该机器人的保存模型替换为语法合法、Host 无法路由的 `issue192-removed-provider/issue192-expired-model`，模拟保存配置失效。通过飞书发送 `/new`，确认会话绑定为空。

| 检查 | 实际结果 |
| --- | --- |
| 失效模型下发送普通消息 | 飞书返回新的恢复提示及 `MODEL_UNAVAILABLE`，参考号 `MF-AB96C49F`；绑定仍为空 |
| `/models` | 飞书正常列出 10 个模型 |
| 无会话时 `/model 1` | 切换为 `deepseek-official/deepseek-v4-flash`、`high`，绑定新会话；保存的失效机器人模型仍保留 |
| 随后发送限定回复消息 | 飞书独立回复精确标记 `ISSUE192_FEISHU_RECOVERY_OK_20260910` |
| 再次 `/new` | 绑定再次为空 |
| `/model 1 low` | 再次创建并绑定新会话，切换为同一模型、`low` |
| 第二轮限定回复消息 | 飞书独立回复精确标记 `ISSUE192_FEISHU_NEW_LOW_OK_20260910` |

两个成功标记均通过飞书客户端可访问性文本确认，分别出现在独立机器人回复中。Host 原生会话摘要同时确认对应会话的 `lastUsed` 和 `next` 模型与强度一致，任务均已结束。测试消息明确要求不调用工具、不修改文件。

## 恢复与影响核对

- 通过 `bot.model.set` 恢复机器人原来的模型配置；整个飞书 `workspaces.json` 与测试前按 JSON 内容比较一致。
- DSH 原生 `session.selectModel` 还会保存 Host 默认模型，这是 Host 既有行为。本次通过带版本检查的 `settings/replace` 恢复测试前默认值；整个 Host 设置文档按 YAML 内容比较一致。
- 删除临时 HMR 配置，profile patch 与备份逐字节一致；修复后的插件仍在运行。
- 当前测试聊天保留第二轮验证成功的新会话，使用 DeepSeek V4 Flash / Low，便于继续使用；历史会话未删除。
- 12 个渠道管理状态接口均成功，全部 20 个已配置机器人在线，其中飞书 9 个。各机器人的模型、Preset、工作区、上下文增强和访问策略均与测试前一致。其他渠道未做真实消息收发测试。
- DSH Git 工作区仍干净；本仓库原有的其他未跟踪文档未修改。

## 本机证据

证据目录：`/Users/manruixie/.dsh-test-evidence/issue192-20260910`。包括测试前后管理状态、目标配置备份、失效/恢复时的会话绑定、两次 Host 会话摘要、实际飞书观察记录及恢复结果。原始状态和备份仅留在本机，不加入仓库。

完整检查日志：`/tmp/dsh-im-issue192-check.log`。
