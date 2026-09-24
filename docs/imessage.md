# macOS 原生 iMessage 渠道

这是 dsh-im 对 issue [#137](https://github.com/xmanrui/dsh-im/issues/137) 的首版 MVP 实现。它直接使用 macOS 的 Messages.app 收发文本消息，不需要 BlueBubbles、常驻第三方网关或其他中转服务。

该渠道只运行在 macOS 上，并要求当前 macOS 用户已经在 Messages.app 中登录 iMessage。DeepSeek Harness 和 dsh-im Host 也必须运行在同一个 macOS 用户会话中。

## MVP 范围

- 支持文本私聊，以及同一 Apple ID 的自聊指令。
- 每个联系人独立映射到 Harness 工作区下的会话，不与其他 IM 渠道共享会话或游标。
- 支持使用设置页检查本机权限、查看连接状态、绑定本机身份和移除接入。
- 凭据、权限检查结果、消息游标和运行状态只保存在本机 Host，不通过前端 RPC 返回敏感内容。

实现使用两条 macOS 原生能力：

- 通过 `~/Library/Messages/chat.db` 的只读查询轮询收到的文本私聊。
- 通过 `/usr/bin/osascript` 控制 Messages.app 发送文本消息。

dsh-im 不修改 Messages 数据库；消息映射、Harness 会话和读取游标由 dsh-im 自己保存。

## 单一本机 iMessage 身份

当前 MVP 对每个 macOS 用户账户只暴露一个本机 iMessage 机器人身份：`macos-messages`。

这意味着：

- 一个身份可以服务多个联系人，每个联系人仍然映射到独立的 Harness 会话。
- 同一个 dsh-im 实例不能配置多个独立的 iMessage Bot。
- 设置页不能在多个 Messages.app 账户、多个电话号码、多个 Apple ID 或多个 macOS 用户身份之间切换。
- 如果需要使用另一个 iMessage 身份，应在对应的 macOS 用户账户中运行独立的 Host 实例，并让它使用自己的本地数据目录。

这个限制是本机 Messages.app 接入方式的边界，不代表 iMessage 平台只能有一个账户；后续若要支持多身份，需要额外的账户隔离、权限管理、消息游标和发送路由设计。

## macOS 权限

在 dsh-im 的 iMessage 设置页点击“配置本机权限”，按页面链接打开：

1. **完全磁盘访问权限**：在“系统设置 → 隐私与安全性 → 完全磁盘访问权限”中，给运行 Harness 的终端或应用授权。没有此权限时，Host 无法读取 `chat.db`。
2. **自动化**：在“系统设置 → 隐私与安全性 → 自动化”中，允许运行 Harness 的终端或应用控制 Messages。没有此权限时，Host 无法发送消息。

授权后回到设置页点击“检查权限并启用”。macOS 不允许网页或 Node.js 静默授予这些权限，用户必须在系统设置中确认；按钮只能打开对应设置页并重新检查结果。

## 首次测试

1. 在 macOS 的 Messages.app 中确认 iMessage 已登录并可以正常收发消息。
2. 自用时，在同一 Apple ID 的 iPhone 或 Mac 上，给本机 Messages 已登录的邮箱或号码发消息（自聊）。也可以使用另一个 iMessage 账号发起私聊。
3. 在 Harness 的 IM 机器人设置页打开 iMessage，点击“配置本机权限”，完成两项授权。
4. 点击“检查权限并启用”，确认状态显示为已连接后，发送“只回复 IMESSAGE_TEST_OK”。
5. 等待带有 `🤖 DSH` 标记的 Harness 回复。

自聊只处理 Messages 投递回本机的接收副本，跳过发送记录和带有 `🤖 DSH` 标记的机器人回复，避免重复处理或循环。标记保存在消息正文中，Host 重启后仍能识别。请保留这个标记；不要以它开头输入新指令。发给其他联系人的普通消息不会触发机器人。

同账号跨设备使用时，消息必须先投递到运行 Host 的 Mac；单有发件记录或未送达的消息不会触发机器人。

同账号自聊时，Messages 界面可能同时显示蓝色发送气泡和灰色接收副本。这不代表插件重复调用模型或重复发送回复；插件不会删除 Messages 中的副本。若希望使用普通的一发一回界面，可在 Mac 的 Messages 中登录机器人专用 Apple 账号，再用个人账号与它私聊。

## 当前不支持

以下能力不属于首版 MVP：

- 群聊和群组成员路由；
- 图片、文件、附件和富文本消息；
- 引用回复、reactions、编辑消息和消息撤回；
- 多个独立 Messages.app 账户或多个本机 iMessage 身份；
- 依赖 BlueBubbles 等第三方服务的远程 macOS 代理模式。

这些能力可能在后续版本中分阶段增加，但会受到 Messages.app、macOS 自动化权限和内部消息数据库结构的限制。

## 兼容性与安全边界

`chat.db` 是 macOS 的内部数据库，不是稳定的公开 API。macOS 升级后，表结构、字段含义或隐私权限模型可能变化，渠道需要随之适配。读取采用只读查询，发送只通过 Messages.app 的自动化接口完成；dsh-im 不上传数据库、不保存 iMessage 密码，也不把本机授权信息返回给浏览器。

如果设置页显示 `HTTP 404` 或“无法读取 iMessage 机器人状态”，通常表示 Host 仍加载旧版插件，或者 Host 与前端没有使用同一版插件。升级 dsh-im 后请重启 Harness/Host，并刷新设置页；新版管理 RPC 路径为 `/api/dsh-im/imessage`。
