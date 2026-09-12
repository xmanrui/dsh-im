# Changelog / 更新日志

本文件记录 dsh-im 各正式版本的重要变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

This file records the notable changes in each dsh-im release. Its format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and its versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed / 修复

- 上下文增强的来源块与增强提示词不再写入用户消息正文：Host 在 `agent/pre-step` 把渠道写入的前缀拆成独立的 `dsh-im` 上下文消息（来源块为 `notice`、提示词为 `instructions`），用户消息只保留用户真正发送的内容，同时保留可审计的提交来源，会话展示中不再出现裸标签。配对按消息身份而非队列位置决定，因此在途或并发的多条消息不会互相串用来源；无法拆分的 Host 或指向外部 Harness 的配置保持原有内联前缀行为。
  Context enhancement no longer writes its source block or guidance into the user message. The Host splits the prefix a channel wrote at `agent/pre-step` into separate `dsh-im` context messages (the source block as a notice, the guidance as instructions), so the user message keeps only what the person sent while its durable source still identifies the prompt, and no raw tags remain in the transcript. Pairing follows message identity rather than inbox position, so in-flight or concurrent prompts cannot swap sources; a Host that cannot split, or a configuration pointing at an external Harness, keeps the previous inline prefix.

## [4.20.0] - 2026-09-12

### Added / 新增

- 新增会话级工作区覆盖：每个会话（群线程 / 私聊）可绑定专属 DSH 工作区，未设置时回落到 bot 默认工作区。新增 `/conv` 命令（别名 `/conversation`、`/thread`）用于查看、设置、清除当前会话专属工作区，无参数时会显示当前是「显式绑定」还是「跟随 bot 默认」，并顺带列出现有工作区及序号，可直接用 `/conv <序号>` 切换；`/workspace` 保持 bot 默认级不变。主命令取 `/conv` 而非 `/thread`，是因为 Discord 客户端注册了同名原生斜杠命令，会抢占输入框。覆盖以可选增量字段 `conversationWorkspaces` 持久化到 `workspaces.json`，读取时逐条做破坏隔离，损坏时安全降级为 bot 默认。
  Added per-conversation workspace overrides: each conversation (group thread / DM) can pin its own DSH workspace, falling back to the bot default when unset. A new `/conv` command (aliases `/conversation`, `/thread`) shows, sets, or clears the current conversation's workspace; with no argument it reports whether the conversation is explicitly bound or following the bot default, and also lists the existing workspaces with their indexes so `/conv <index>` can switch directly. `/workspace` remains bot-default. The primary name is `/conv` rather than `/thread` because Discord registers a native slash command of that name and would capture the input box. Overrides persist as the optional additive `conversationWorkspaces` field in `workspaces.json`, with per-entry damage isolation and safe fallback to the bot default.

  感谢 [@baijian](https://github.com/baijian) 的实现、测试与文档，以及 [@lyzhu86](https://github.com/lyzhu86) 的方案与文档贡献（[#195](https://github.com/xmanrui/dsh-im/pull/195)）。Thanks to [@baijian](https://github.com/baijian) for implementation, tests, and documentation, and [@lyzhu86](https://github.com/lyzhu86) for ideas and documentation in [#195](https://github.com/xmanrui/dsh-im/pull/195).

### Fixed / 修复

- 微信连接与绑定失败保留具体分类和可执行的中英文恢复提示，覆盖启动、扫码、凭据读取、重连及账号移除；区分网络、超时、HTTP 状态、失效登录与文件访问问题，不再只显示笼统的离线或失败提示（[#198](https://github.com/xmanrui/dsh-im/issues/198)）。设置页支持展开和复制经过筛选的诊断详情，通过 `WX-CONN-XXXXXXXX` 参考编号关联 Host 日志，避免直接展示原始 Token、二维码链接、本地路径或消息内容。
  Weixin connection and provisioning failures retain classified, actionable bilingual recovery guidance across startup, QR login, credential reads, reconnects, and account removal. Network, timeout, HTTP, stale-login, and file-access failures are distinguished instead of collapsing into generic offline or failure messages ([#198](https://github.com/xmanrui/dsh-im/issues/198)). The settings UI can expand and copy filtered diagnostic details and correlate them with Host logs through a `WX-CONN-XXXXXXXX` reference ID, without directly exposing raw tokens, QR URLs, local paths, or message content.
- 微信账号移除后的清理失败明确报告为警告，不再恢复已删除的账号；回滚结果与主要失败分别保留，状态读取不确定时也不再误报为删除失败。自动重试的重复诊断日志会在短时间窗口内合并。
  Cleanup failures after Weixin account removal are reported as warnings without resurrecting deleted accounts. Rollback outcomes remain distinct from the primary failure, and uncertain status reads are no longer misreported as failed deletion. Repeated automatic-retry diagnostics are deduplicated within a short window.

- `/session ID` 绑定时在同一事务内清除与目标 Session 工作区冲突的对话覆盖，保留匹配的显式覆盖和原有 bot 默认工作区语义；重复 `/conv` 会核验遗留 Session 的目录归属，避免提示切换成功却在其他项目执行。补齐持久化失败、并发切换和符号链接路径的回归测试。
  `/session ID` now clears a conflicting conversation override in the binding transaction, preserving matching explicit pins and existing bot-default behavior. Repeated `/conv` verifies legacy Session ownership instead of reporting success while retaining a Session from another project. Regression tests cover persistence failures, concurrent switches, and symbolic-link paths.
- 飞书 `/sessionlist` 卡片及主菜单、钉钉会话选择器和 QQ 会话列表改用当前对话的有效工作区；工作区设置菜单仍管理 bot 默认工作区。切换后旧会话选择菜单失效，避免旧选项把新工作区切回，并新增实际渠道入口回归测试。
  Feishu `/sessionlist` cards and main-menu sessions, the DingTalk session selector, and QQ session lists now use the conversation's effective workspace. Workspace settings remain bot-default. Stale session-selection menus are rejected after a conversation workspace change, with regression tests covering channel entry points.
- 补齐会话工作区切换的提交校验：显式绑定统一记录会话代际，读取已有 Session 前捕获代际，`/model` 的既有会话与新会话路径都保留对话上下文，防止异步选模或绑定把旧工作区 Session 写回。`/session N` 与 `/sessionlist` 共用对话有效工作区，`/conv` 正确区分显式绑定与跟随默认；共享 Session 的其他对话不受单个对话切换影响。
  Completed conversation-workspace commit fencing: explicit bindings retain structured generation records, adoption captures the conversation generation before asynchronous lookups, and both `/model` paths preserve the conversation context. Delayed model selection or binding cannot restore a Session from the old workspace. `/session N` and `/sessionlist` resolve the same effective workspace, `/conv` reports explicit overrides correctly, and switching one conversation preserves other conversations sharing the Session.
- 修复对话工作区切换与消息处理并发时可能把后续消息发进旧工作区的问题：`/conv` 在开始提交时就发布代际栅栏，已在途的会话绑定会被拒绝并重新解析，消息也不会再经由切换前的会话发送；`/session` 显式绑定同样受该栅栏保护。
  Fixed messages sometimes running in the previous workspace when a conversation workspace switch overlapped message processing. `/conv` now publishes its generation fence as soon as it starts committing, so an in-flight Session binding is rejected and re-resolved and the prompt is never sent through the Session of the workspace being left behind. Explicit `/session` bindings are fenced the same way.
- 修复把对话绑定到当前 bot 默认工作区时未落盘的问题：`/conv <当前默认路径>` 现在会写入显式覆盖，之后修改 bot 默认工作区不再连带改变该对话；`/conv clear` 才回到跟随默认。
  Fixed binding a conversation to the bot's current default workspace not being persisted: `/conv <current default path>` now records an explicit override, so a later bot-default change no longer moves that conversation; only `/conv clear` goes back to following the default.
- `/sessionlist` 不带工作区参数时改为列出当前对话的有效工作区（显式传入工作区序号或绝对路径时仍以参数为准），避免在对话专属工作区里选到 bot 默认工作区的会话。
  `/sessionlist` without a workspace argument now lists the workspace the conversation effectively uses (an explicit index or absolute path still wins), so sessions from the bot default are no longer offered inside a conversation-specific workspace.
- 补齐 `/conv` 与相关提示的英文翻译，并让 Telegram 命令菜单、`/help` 与对应测试跟随命令目录自动更新。
  Added the missing English translations for `/conv` and its messages, and let the Telegram command menu, `/help`, and their tests follow the command catalog automatically.

### Documentation / 文档

- 中英文 README 补充会话专属工作区命令与微信诊断说明，统一贡献者致谢及贡献类型图例，并同步 npm 包的贡献者元数据。
  Updated bilingual READMEs with conversation-workspace commands and Weixin diagnostics, standardized contributor acknowledgements and contribution legends, and synchronized npm contributor metadata.

### Known limitations / 已知限制

- 本次微信更新改善错误诊断，不代表已复现或修复 #198 最初报告的掉线根因；再次发生时仍需结合页面诊断及对应参考编号的 Host 日志排查。
  The Weixin update improves diagnostics; it does not establish that the original disconnection reported in #198 has been reproduced or resolved. Further occurrences still require the page diagnostics and matching Host-log reference ID for investigation.

## [4.19.2] - 2026-09-11

### Fixed / 修复

- 机器人消息语言改为跟随 DeepSeek Harness 的界面语言，不再需要在 Host 配置中手动设置 `language`（[#185](https://github.com/xmanrui/dsh-im/issues/185)）。语言按「插件 `language` 配置 → DSH 语言设置项 → 设置页实际生效的界面语言」顺序解析，并把最后一项持久化到 `~/.dsh/integrations/dsh-im/interface-language.json`，因此界面语言来自浏览器语言列表、以及 Host 重启后尚无浏览器连接时，机器人仍以该语言回复。切换语言即时生效：无需重启 Host，Telegram 命令菜单也会重新下发，无需重连机器人。中文仍是兜底语言，已显式配置 `language` 的用户行为不变。
  Bot message language now follows the DeepSeek Harness interface language instead of requiring a manual `language` entry in the Host config ([#185](https://github.com/xmanrui/dsh-im/issues/185)). It resolves from the plugin's `language` option, then DSH's Language setting, then the interface language the settings page is actually rendered in, and it persists that last layer to `~/.dsh/integrations/dsh-im/interface-language.json` — so a browser-derived interface language, and a Host restart before any browser connects, both keep answering in the reader's language. Switching applies live: no Host restart, and the Telegram command menu is re-sent without reconnecting the bot. Chinese remains the fallback, and an explicitly configured `language` behaves exactly as before.

  感谢 [@grloper](https://github.com/grloper) 的贡献（[#189](https://github.com/xmanrui/dsh-im/pull/189)）。Thanks to [@grloper](https://github.com/grloper) for [#189](https://github.com/xmanrui/dsh-im/pull/189).

- 界面语言回传在连接尚未就绪或 Host 持久化失败时自动重试，渠道启动前先完成语言解析；Telegram 连接期间发生的语言切换会在就绪后补发命令菜单。补齐 Telegram 思考占位、降级投递状态和 Discord 新线程提示的英文翻译。
  Interface-language reporting retries when the Connection is not ready or Host persistence fails, and language resolution completes before channels start. Telegram catches up on command-menu changes made while connecting. Added English translations for Telegram thinking placeholders and fallback-delivery status, plus Discord's new-thread notice.

### Known limitations / 已知限制

- Telegram 客户端可能缓存旧的 `/` 命令菜单；重新打开客户端可刷新。输入框旁的 Menu 按钮由 Telegram 客户端自身语言决定，不随 DSH 语言设置改变。
  Telegram clients may cache the previous `/` command menu; reopen the client to refresh it. The Menu button beside the input follows Telegram's own client language, not the DSH language setting.

### Documentation / 文档

- 新增 `scripts/verify-interface-language.mjs`：使用原版 DSH CLI 与独立临时 home，通过真实 `/api` 通道端到端验证界面语言解析顺序、即时切换、重启后行为与运维固定值；提供机器人 Token 时还会断言 Telegram 侧实际存储的命令菜单，并在结束后恢复原菜单。
  Added `scripts/verify-interface-language.mjs`, an end-to-end check running the unmodified DSH CLI with an isolated temporary home. It asserts each interface-language resolution layer over the real `/api` carrier, live switching, restart behavior, and the operator pin. Given a bot token it also asserts the command menu Telegram itself stores, and restores the original menu afterwards.
- 验证脚本在 HTTP 启动后有界等待语言接口就绪，避免插件异步加载期间的临时 `404` 导致重启检查误报失败。
  The verification script waits for language-route readiness with a bounded timeout after HTTP startup, avoiding false restart failures from temporary `404` responses during asynchronous plugin activation.

## [4.19.1] - 2026-09-11

### Fixed / 修复

- 飞书 Web／CLI 会话同步按真实 Session 和回合区分过程卡，修复连续提问共用卡片或答案被覆盖的问题；长时间思考或工具执行不再因静默 90 秒被误判完成，改为通过真实结束事件或历史记录确认收尾。
  Feishu Web/CLI Session sync now separates process cards by Session and turn, preserving answers across consecutive prompts. Long reasoning or tool calls are no longer treated as completed after 90 seconds of silence; completion requires a real terminal event or a matching history record.
- 同步协调器等待完整答案实际写入卡片后才跳过该目标的最终文字；卡片创建或最后更新失败时保留文字兜底，并按渠道、机器人和目标隔离，避免同名目标相互影响。普通 IM 回合在事件入队前记录归属，避免额外生成同步卡片。
  The sync coordinator suppresses final text for a target only after its complete answer is successfully delivered to the card. Card creation or final-update failures retain text fallback, with channel, bot, and target isolation preventing same-named targets from interfering. IM-origin ownership is captured before event queuing to avoid unwanted mirror cards.
- 飞书同步卡片每次成功更新后保存最新快照与内容块，插件重载后沿用原卡片，并从历史读取最终答案，保留已封存的长答案分片；恢复投递失败保留记录重试，成功后才清理。缺少回合信息的旧记录保留原样，不以空卡片覆盖已有内容。
  Feishu sync cards persist their latest successful snapshot and content blocks. After plugin reload, recovery reuses the original card and reads the final answer from history while retaining sealed continuation chunks. Failed recovery keeps records for retry; cleanup follows successful delivery. Legacy records without turn information are left untouched instead of overwriting existing content with empty cards.

### Changed / 变更

- 优化机器人卡片的名称区域：截断的长名称支持悬停或键盘聚焦查看完整提示，提示避开视口边缘并可用 Escape 关闭；收紧横向间距，窄屏下名称与状态保持同一行。别名编辑图标默认更淡，悬停或聚焦时突出显示。
  Improved bot-card name presentation: truncated names expose a full tooltip on hover or keyboard focus, kept within the viewport and dismissible with Escape. Tighter horizontal spacing keeps names and status on one row on narrow screens. Alias-edit icons are subtler at rest and highlighted on hover or focus.

## [4.19.0] - 2026-09-10

### Added / 新增

- 十一个 IM 渠道的机器人卡片均支持自定义别名，点击名称旁的铅笔即可编辑；保存后立即显示，无需重启或重连，也不会清除会话绑定。原平台名称始终保留，清空别名或点击恢复即可还原；别名仅影响本机设置页，不会修改平台上的机器人名称（[#188](https://github.com/xmanrui/dsh-im/issues/188)）。
  Bot cards across all eleven IM channels support custom aliases through the pencil beside the name. Changes appear immediately without restarting, reconnecting, or clearing Session bindings. The original platform name is retained and can be restored by clearing or resetting the alias; aliases affect only the local settings UI, not the bot's platform identity ([#188](https://github.com/xmanrui/dsh-im/issues/188)).
- 已开启「会话双向同步」的飞书私聊可用实时过程卡展示当前 Session 中的 Web／CLI 回合，包含用户提问引用、思考与工具过程、长答案续卡和最终收尾；按投递目标避免重复发送最终文字，其他同步目标保留原有投递。感谢 [@C3H3-AI](https://github.com/C3H3-AI) 的贡献（[#186](https://github.com/xmanrui/dsh-im/pull/186)）。
  Feishu DMs with two-way Session sync enabled can mirror Web/CLI turns in the current Session as live process cards, including the quoted question, reasoning and tool progress, continuation cards for long answers, and final sealing. Final-text deduplication is scoped to the mirrored delivery target, preserving delivery to other synced targets. Thanks to [@C3H3-AI](https://github.com/C3H3-AI) for [#186](https://github.com/xmanrui/dsh-im/pull/186).

### Fixed / 修复

- 修复机器人保存的模型已失效且聊天尚未绑定 Session 时，连 `/model` 也无法切换的问题：显式选模创建 Session 时不再继承旧模型与思考强度，仍在核验所选模型后绑定会话；普通消息和已有 Session 的行为保持不变（[#192](https://github.com/xmanrui/dsh-im/issues/192)）。
  Fixed `/model` being blocked by an unavailable saved bot model when the chat has no bound Session. Explicit model selection creates the Session without inheriting the old model or reasoning level, then verifies the selection before binding. Normal messages and existing-Session behavior remain unchanged ([#192](https://github.com/xmanrui/dsh-im/issues/192)).
- 同时识别旧版 `model-unavailable` 和新版 `session/model-unavailable` 错误，并补全中英文恢复指引：先用 `/models` 查询，再用 `/model <序号>` 修复当前聊天。此操作不会改写机器人的默认模型；若要修复之后新建的 Session，仍需在机器人卡片中更新默认模型。
  Recognized both legacy `model-unavailable` and current `session/model-unavailable` errors with bilingual recovery guidance: list available models using `/models`, then recover the current chat with `/model <index>`. This does not rewrite the bot's default model; update the bot card to fix future Sessions as well.

## [4.18.1] - 2026-09-10

### Changed / 变更

- IM 管理接口的默认 `rpcAuthority` 从 `loopback` 改为 `trusted-host`，沿用 Harness 的浏览器认证与 Host／Origin 信任检查，修复已认证的受信任局域网访问仍被插件拒绝的问题（[#187](https://github.com/xmanrui/dsh-im/issues/187)）。显式配置的 `loopback` 继续生效；插件更新和入站 TTL 管理仍始终仅限本机。需要保持原默认限制的用户可设置 `rpcAuthority: loopback`。
  Changed the default IM management `rpcAuthority` from `loopback` to `trusted-host`, relying on Harness browser authentication and Host/Origin trust checks so authenticated, trusted LAN access is no longer rejected by the plugin ([#187](https://github.com/xmanrui/dsh-im/issues/187)). Explicit `loopback` settings remain effective, and plugin updates and inbound-TTL management stay local-only. Set `rpcAuthority: loopback` to retain the previous default restriction.

### Fixed / 修复

- Telegram 私聊 Rich Draft 在长时间思考或工具执行期间定时刷新，避免临时预览过期；慢网络下跳过尚未完成的心跳，发送最终答案或错误提示前停止调度，避免重复刷新积压拖延收尾。感谢 [@geekyfoxlab](https://github.com/geekyfoxlab) 的贡献（[#175](https://github.com/xmanrui/dsh-im/pull/175)）。
  Telegram private-chat Rich Drafts stay refreshed during long reasoning or tool calls. Pending heartbeats skip redundant ticks on slow networks, and scheduling stops before final or error delivery so repeated refreshes cannot delay completion. Thanks to [@geekyfoxlab](https://github.com/geekyfoxlab) for [#175](https://github.com/xmanrui/dsh-im/pull/175).

### Documentation / 文档

- 更新中英文管理访问说明，并新增使用原版 DSH、独立临时 profile 和空机器人配置的 HTTP 集成验证脚本，覆盖登录、Host／Origin 检查、默认访问和显式回环限制。该测试经回环 TCP 模拟局域网 Host／Origin，不替代跨设备浏览器验收。
  Updated bilingual management-access guidance and added an HTTP integration check using unmodified DSH, an isolated temporary profile, and no bot credentials. It covers login, Host/Origin checks, default access, and explicit loopback restrictions. LAN Host/Origin values are exercised over loopback TCP; this does not replace a browser check from another device.

## [4.18.0] - 2026-09-09

### Added / 新增

- 新增 macOS 原生 iMessage 渠道，通过本机 Messages.app 收发文本私聊，无需 BlueBubbles 或第三方网关；支持权限检查、连接管理、独立联系人会话和主动文字投递。每个 macOS 用户仅提供一个本机身份，需手动授予完全磁盘访问和 Messages 自动化权限；首版不支持群聊、图片或附件。接入说明见 [iMessage 指南](docs/imessage.md)。感谢 [@cherryFloris](https://github.com/cherryFloris) 的贡献（[#183](https://github.com/xmanrui/dsh-im/pull/183)）。
  Added a native macOS iMessage channel for text DMs through the local Messages.app, without BlueBubbles or a third-party gateway. It includes permission checks, connection management, separate contact Sessions, and proactive text delivery. Each macOS user has one local identity and must manually grant Full Disk Access and Messages automation permissions; the MVP does not support groups, images, or attachments. See the [iMessage guide](docs/imessage.md). Thanks to [@cherryFloris](https://github.com/cherryFloris) for [#183](https://github.com/xmanrui/dsh-im/pull/183).

### Fixed / 修复

- iMessage 支持同一 Apple ID 自聊指令，只处理已投递回本机的接收副本；回复统一携带持久化的 `🤖 DSH` 标记并跳过机器人回声，避免重复处理和重启后的回复循环。首次启用从最新消息游标开始，避免回放旧消息。
  iMessage supports self-chat commands under the same Apple ID by processing only incoming copies delivered to the Mac. Replies carry a persistent `🤖 DSH` marker, and bot echoes are ignored to prevent duplicate processing and reply loops after restarts. First-time activation starts at the latest message cursor instead of replaying old messages.
- 正确识别斜杠分隔的 Agent Preset 错误码，保留安全诊断原因，并在现代 Harness 适配层透传直接返回的 DSH RemoteError；中英文提示明确说明通过 `/presetlist`、`/preset` 和 `/new` 重选并新建会话，或恢复原 Preset 后继续旧会话。
  Recognized slash-separated Agent Preset error codes, retained safe diagnostic reasons, and preserved direct DSH RemoteErrors through the modern Harness adapter. Bilingual guidance explains how to select an available preset with `/presetlist` and `/preset`, then start a new Session with `/new`, or restore the original preset to continue an existing Session.

### Known limitations / 已知限制

- 原版 DSH `0.1.5-alpha.1` 恢复旧会话时仍可能将 Preset 错误包装为 `gateway/internal`，导致插件无法按结构化错误码分类；企业微信相关日志的附加诊断仍有缺口。本版不宣称完整解决 [#184](https://github.com/xmanrui/dsh-im/issues/184)。
  Unmodified DSH `0.1.5-alpha.1` can still wrap preset failures during existing-Session recovery as `gateway/internal`, preventing classification from structured error codes. Related WeCom logs still lack some diagnostic details. This release does not fully resolve [#184](https://github.com/xmanrui/dsh-im/issues/184).

## [4.17.1] - 2026-09-09

### Fixed / 修复

- 修复原版 DSH `0.1.5-alpha.1` 的 IM 管理接口兼容性，统一通过 Connection 的公开 `/api` Fetch 接口承载十个 IM 渠道、Office、更新、入站 TTL 和主动投递管理，无需修改或重新编译 DSH；继续兼容已支持的四个原版 DSH 版本。
  Fixed IM management compatibility with unmodified DSH `0.1.5-alpha.1`. Ten IM channels, Office, updates, inbound TTL, and proactive-delivery management now share Connection's public `/api` Fetch interface without modifying or rebuilding DSH, while retaining compatibility with the four previously supported DSH releases.
- 保留原生请求关联、取消信号和业务错误，并补全旧处理器缺少的错误详情。管理接口继续执行默认回环访问限制；`trusted-host` 复用 DSH 的浏览器认证与 Host／Origin 检查，更新和入站 TTL 管理始终仅允许回环访问。
  Preserved native request correlation, cancellation, and business errors, filling in error details omitted by older handlers. Management access remains loopback-only by default; `trusted-host` relies on DSH browser authentication and Host/Origin checks, while update and inbound-TTL management always remain loopback-only.

### Documentation / 文档

- 更新中英文兼容说明和元数据，记录五个原版 DSH Web profile 的兼容矩阵，以及飞书、钉钉、企业微信和 Telegram 的真实收发验证。升级插件后需重启 Host 并刷新设置页，使两端加载同一版插件。
  Updated bilingual compatibility guidance and metadata, documenting the five-version compatibility matrix for unmodified DSH Web profiles and real-message checks for Feishu, DingTalk, WeCom, and Telegram. Restart the Host and refresh settings after upgrading so both sides load the same plugin version.

## [4.17.0] - 2026-09-09

### Added / 新增

- 飞书新增实时过程卡，将任务步骤和最终答案在卡片内更新，工具摘要与过程说明可折叠；支持长答案续卡、交互前换卡和停止状态。任务过程展示可选不显示过程、实时过程卡或逐步直播；新接入机器人默认实时过程卡。
  Feishu gains process cards with in-place progress and answers, collapsible tool summaries and notes, long-answer continuation cards, interaction rotation, and stopped status. Users can choose no process, a live process card, or per-step messages; new bots default to the process card.

### Fixed / 修复

- 修复已有过程卡收尾时末块覆盖首块，长答案按顺序完整投递；卡片封存或续卡发送失败时沿用完整 post 答案兜底。
  Preserve every answer chunk in order when completing an existing process card. Failed sealing or continuation creation falls back to the complete post answer.

- 旧机器人缺少呈现模式时保留逐条消息行为，明确保存的模式及关闭状态不变；扫码和手动凭据新接入采用一致默认值。
  Existing bots without a stored mode retain per-step posts, preserving explicit modes and disabled settings. QR and manual-credential onboarding use the same new-bot defaults.

## [4.16.1] - 2026-09-09

### Fixed / 修复

- 钉钉 AI Card 改为在创建并投放时同时写入可见的思考提示，避免先出现空白卡片；首次流式更新失败时保留已显示的卡片，后续仍可原位完成。
  DingTalk AI Cards now include visible thinking text in the combined create-and-deliver request, avoiding an initially blank card. A failed initial streaming update keeps the visible card available for later in-place completion.

- 修复钉钉 AI Card 完成后正文消失或继续显示处理中：先结束流式组件，再将完整回答和完成状态持久化到模板实际使用的 `msgContent` 字段，保持正文可见。
  Fix DingTalk AI Cards losing their answer or remaining in the processing state after completion. The stream is finalized first, then the full answer and completed state are persisted in the template's visible `msgContent` field.

- 钉钉卡片创建、流式更新或最终状态写入失败时，恢复完整文字回答和安全错误提示的兜底投递，避免卡片失败被误记为已成功送达而丢失结果。
  Restore full-text answers and safe error-message fallback when DingTalk card creation, streaming updates, or final-state persistence fail, preventing failed cards from being treated as successful delivery and losing the result.

## [4.16.0] - 2026-09-09

### Added / 新增

- 新增实验性企业微信自建应用渠道（`wecom-app`），成为第十个 IM 渠道：通过加密 HTTP 回调接收消息，支持多应用独立配置、私聊流式回复、图片输入、结果文件回传与主动投递目标。成员关注企业的微信插件后可在微信中对话，微信端自动降级为分段文字；接入需要公网回调与企业可信 IP 配置。回调监听按需启动，移除最后一个应用后关闭。接入步骤见[中文指南](docs/企业微信自建应用接入.md)和[英文指南](docs/企业微信自建应用接入.en.md)。
  Adds the experimental WeCom self-built app channel (`wecom-app`) as the tenth IM channel, with encrypted HTTP callbacks, independent multi-app configuration, private-chat streaming, image input, result files, and proactive delivery targets. Members can chat from WeChat through the enterprise's WeChat plugin, with segmented-text fallback there. Setup requires a public callback route and trusted IP configuration. The callback listener starts on demand and stops when the last app is removed. See the linked Chinese and English setup guides.

- 机器人设置新增显式的「思考强度」选择，档位、说明和默认值来自 DSH 当前模型；每个机器人独立保存，切换模型时恢复新模型默认强度，仅影响之后新建的会话，不改变已有会话或进行中的回答。
  Bot settings now expose reasoning-effort choices using the current model's levels, descriptions, and defaults from DSH. Each bot saves its own override; changing models restores the new model's default effort. Changes apply only to future Sessions, leaving existing Sessions and in-progress replies unchanged.

- 飞书分步直推在静默 20 秒后显示「正在思考中」及运行时长，并原位定时更新。出现实际进度、问题或审批，以及回合结束时会尝试撤回；撤回失败最多重试三次，迟到的状态消息也会清理，避免重复状态和残留提示。
  Feishu Step Push shows a thinking-status message with elapsed time after 20 seconds of silence and periodically updates it in place. Real progress, questions, approvals, and turn completion trigger cleanup. Failed recalls allow up to three attempts, and late-arriving status messages are also cleaned up to prevent duplicates and stale notices.

- 飞书提问卡片新增自定义答案入口，提交后将原卡片更新为已回答状态并展示选择结果；重复或过期点击会提示已回答，避免重复提交。
  Feishu question cards add a custom-answer entry and update the original card with its answered state and selected result after submission. Repeated or stale clicks report that the question was already answered instead of submitting again.

### Changed / 变更

- Telegram 原生命令菜单与文字帮助改为共用命令目录，启动和重连时生成本地化完整菜单，自动纳入历史、推理等级等命令及别名；删除的命令不再残留，空目录会清空旧菜单。菜单同步失败不会阻止机器人连接。
  Telegram's native command menu and text help now share one command catalog. Startup and reconnection generate the complete localized menu, including history, reasoning commands, and aliases. Removed commands no longer linger, an empty catalog clears the previous menu, and synchronization failures do not block connection.

### Fixed / 修复

- 修复飞书提问或审批前后的流式消息顺序：卡片写入串行化，交互卡片展示后才继续后续回复，并按已展示正文去重；临时工具状态不再混入固定正文，最终卡片使用最新正文快照，避免旧过程重播、重复回答和正文丢失。
  Feishu serializes streaming-card writes and resumes subsequent replies only after a question or approval is presented, deduplicating already displayed text. Transient tool statuses stay out of the frozen answer prefix, and final cards use the latest text snapshot, preventing replayed progress, duplicate answers, and lost text.

- 各渠道与 AI Office 在初始化期间或启动失败后仍保留管理 RPC，返回可读、脱敏的初始化或失败信息，并清理部分启动的资源，避免设置页因处理器未注册而只显示 404。
  All channels and AI Office retain their management RPC during initialization and after startup failure, returning readable, sanitized status or error information and cleaning up partially initialized resources instead of leaving settings requests with an unregistered-handler 404.

- 企业微信菜单发送错误现在区分权限、限流、断连与结果不确定等情况；仅在明确且可降级的卡片拒绝后回退文字，结果不确定时保留卡片操作状态并避免重复发送。菜单恢复成功后清除对应旧错误，不覆盖模型错误或并发请求的新错误。
  WeCom menu delivery now distinguishes permission, rate-limit, disconnection, and uncertain-outcome errors. Only definite, eligible card rejections fall back to text; uncertain delivery retains card interaction state without duplicate sends. Successful menu recovery clears its own previous error without overwriting model failures or newer concurrent errors.

- 设置页恢复显示完整渠道导航列表，并将飞书分步直推说明移入帮助提示，减少设置项拥挤。
  Settings show the complete channel navigation list again, and Feishu Step Push guidance moves into its help tooltip to reduce clutter.

## [4.15.0] - 2026-09-08

### Added / 新增

- 本机 Host 的九个 IM 渠道与 AI Office 会话自动追加渠道前缀（如「微信 · 标题」），保留自动标题的来源与后续生成能力；不会调用手动重命名接口锁定标题，重复生成和重启不会叠加前缀。已有会话在加载时补齐；显式连接远程 `harnessBaseUrl` 时需在目标 Host 上安装插件。
  Sessions from all nine IM channels and AI Office on the local Host automatically receive channel prefixes such as “WeChat · Title”, preserving automatic title provenance and later generation. Prefixes do not use manual rename or pin titles, and do not stack across regeneration or restarts. Existing Sessions are decorated when loaded; explicit remote `harnessBaseUrl` connections require the plugin on the destination Host.

- Web 会话列表和搜索结果将渠道文字前缀显示为现有渠道 Logo，无需修改 DSH。浏览器适配保留原始文字节点、读屏信息和行操作；不兼容的页面结构或图标加载失败时保留文字前缀，插件卸载后恢复原始显示。
  Web Session lists and search results show existing channel logos in place of textual prefixes, without modifying DSH. The browser adapter preserves original text nodes, accessible names, and row actions, keeps text on incompatible page structures or image-load failures, and restores the original display on unload.

- 飞书群聊默认接收其他机器人明确 @ 当前机器人的消息，无需新增开关；仍遵守群聊白名单、命令权限与消息去重规则，未 @、自发和机器人私聊消息继续忽略。扫码新建应用与“补全权限”/`/repair` 流程同时申请接收机器人 @ 消息所需的飞书权限。
  Feishu group chats accept explicit mentions from other bots by default, while preserving group allowlists, command permissions, and deduplication. Unaddressed messages, self-sent messages, and bot DMs remain ignored. New-app QR onboarding and Complete permissions / `/repair` request the required Feishu bot-mention scope.

### Fixed / 修复

- 修正渠道标题监听器的 Host 启动回调返回值，避免 DSH 将其判为无效 effect 并卸载监听器，导致真实飞书等会话不显示渠道标识；回归验证覆盖完整插件启动流程及先命名、后接收 IM 消息的会话。
  Correct the channel-title observer's Host startup return value so DSH does not reject it as an invalid effect and unload the observer. Regression checks cover full plugin activation and Sessions titled before their first IM message.

## [4.14.0] - 2026-09-08

### Added / 新增

- 飞书机器人新增默认关闭的「分步直推」设置，支持按机器人独立开启并即时应用，无需重连。开启后，以独立富文本消息逐步推送工具调用及参数摘要、过程说明和已完成的助手消息，最终回答以支持 Markdown 的富文本投递；包含发送节流与单轮过程消息上限，达到上限仍会投递最终回答，关闭时保留原有流式卡片体验。
  Feishu bots gain an opt-in Step Push setting that applies per bot without reconnecting. It delivers tool calls with argument excerpts, progress notes, and completed assistant messages as separate rich-text posts, followed by a Markdown-capable final answer. Throttling and a per-turn progress-message cap limit traffic without suppressing the final answer; disabling the setting preserves the existing streaming-card experience.

### Fixed / 修复

- 飞书分步直推的长回答按富文本 JSON 编码后的字节数分段，兼顾中文、转义字符与 emoji 边界；中途投递失败时仅从失败分段恢复，避免重复已成功发送的内容。补齐限流重试、富文本到文字的降级和失败状态记录，防止最终回答未送达却被标记为成功。
  Feishu Step Push splits long answers by encoded rich-text JSON bytes, accounting for CJK text, escaped characters, and emoji boundaries. Delivery resumes at a failed chunk without repeating the successful prefix. Rate-limit retries, rich-text-to-text fallbacks, and failure reporting prevent undelivered final answers from being marked successful.

- 飞书已有话题内的回复现在按实际会话结构留在原话题，不再受「群聊以话题方式回复」开关影响；该开关仅控制是否为普通群聊消息自动创建话题。
  Replies in existing Feishu topics now stay in their original thread based on the conversation structure, regardless of the group-topic reply switch. That switch only controls automatic topic creation for ordinary group messages.

- `dsh_im_return_file` 在新版 DSH Session 使用 `snapshotEvents()` 时，现在可以再次识别当前 Turn 并回传文件；同时保留旧 `session.events` 路径。
  `dsh_im_return_file` once again recognizes the current turn and returns files when running against modern DSH Sessions that expose `snapshotEvents()`, while retaining the legacy `session.events` path.

- 兼容旧版持久化投递目标中重复保存的 `targetId`，修复微信等渠道旧配置的加载；仅在该字段与目标映射键一致时归一化，标识不一致的损坏记录仍会被拒绝。
  Legacy delivery targets with a redundantly stored `targetId` now load correctly for WeChat and other channels. Normalization is limited to IDs matching the target map key; inconsistent or corrupted records remain rejected.

## [4.13.0] - 2026-09-06

### Added / 新增

- 九个 IM 渠道新增统一的超时任务结果补发：前台等待超时后继续跟踪原 Harness 回合，完成后向原聊天或线程补发最终文字或终态通知，支持 Host 重启和连接恢复后继续检查。`/stop` 可精确停止当前聊天的待完成回合，换绑会话后不再补发旧结果；明确发送失败最多尝试三次，结果不确定时停止自动重试。此机制不重放文件产物、问题或审批，仍受平台发送权限与配额限制。
  All nine IM channels now share deferred task delivery: after the foreground reply wait times out, the original Harness turn remains tracked and its final text or terminal notification is delivered to the original chat or thread, including after Host restarts or reconnection. `/stop` can precisely cancel the chat's pending turn, and rebinding the Session prevents delivery of old results. Definite send failures allow up to three attempts; uncertain outcomes stop automatic retries. Files, questions, and approvals are not replayed, and platform permissions and quotas still apply.

- 钉钉新增 `/m`、`/menu` 原生下拉菜单，支持会话、工作区、Agent 预设和模型选择，以及新会话、历史、停止、压缩、状态与帮助按钮；选择后立即生效并更新原卡片。使用插件内置共享模板，无需为每个机器人配置模板；菜单 30 分钟或 Host 重启后失效。
  DingTalk adds native `/m` and `/menu` dropdown menus for Sessions, workspaces, Agent Presets, and models, with New, History, Stop, Compact, Status, and Help buttons. Selections apply immediately and update the original card. The bundled shared template requires no per-bot template configuration; menus expire after 30 minutes or a Host restart.

- QQ 新增 `/m`、`/menu` 按钮与数字菜单，覆盖会话、工作区、模式／预设、模型、新会话、停止、压缩、补充指令、归档显示切换、状态与帮助。长列表按快照分页，菜单按聊天和操作者隔离并沿用命令权限；按钮被平台明确拒绝时回退数字选择。旧菜单、重复点击和已变化的会话／工作区不会执行操作，审批、提问和批量输入保留原有优先级。
  QQ adds `/m` and `/menu` button and numbered menus for sessions, workspaces, modes/presets, models, new sessions, stop, compact, steering, archived-session visibility, status and help. Lists paginate over stable snapshots; menus are scoped to the chat and actor and use existing command permissions. Definite platform rejections fall back to numbered text. Stale menus, repeated clicks and changed session/workspace contexts cannot execute actions; questions, approvals and batch input retain priority.

### Fixed / 修复

- 兼容新版 Harness 命令接口的 `submittedAttachments` 参数，修复 QQ 菜单实测中发现的压缩失败；保留旧版无附件参数及 `images` 接口，仅在明确的调用前参数校验失败时适配重试。
  Support the newer Harness command descriptor's `submittedAttachments` argument, fixing compaction discovered during QQ menu testing. Older argument-free and `images` descriptors remain supported; adaptation retries only exact argument validation failures before command dispatch.

- 微信主动投递、连接测试和延迟任务结果现在复用对应用户最近的 `context_token`，并在 Host 重启后恢复；上下文按机器人登录与用户隔离，更换登录凭据后清理，补齐原先遗漏的会话上下文。主动发送失败会在账号状态中保留脱敏诊断与恢复建议，健康轮询不会覆盖发送错误。升级后需收到一次用户消息建立缓存，此修复不能解除 iLink 的发送额度和会话时效限制。
  WeChat proactive delivery, connection tests, and deferred task results now reuse the recipient's latest `context_token` and restore it after Host restarts. Context is isolated by bot login and recipient and cleared when login credentials change, supplying conversation context that was previously omitted. Proactive failures retain sanitized diagnostics and recovery guidance in account status, even while polling remains healthy. An inbound user message is needed to populate the cache after upgrading; this does not remove iLink sending quotas or conversation lifetime limits.

- 企业微信流式回复在完成、停止或失败后会清除临时思考与工具进度文字，保留最终回答或结果提示。
  Enterprise WeChat clears transient thinking and tool-progress text when a streamed reply completes, stops, or fails, preserving the final answer or outcome message.

- 机器人账号卡片收起时，标题栏的帮助提示不再被卡片边缘裁切。
  Help tooltips in collapsed bot-card headers are no longer clipped by the card edges.

## [4.12.0] - 2026-09-06

### Added / 新增

- 企业微信新增 `/menu`、`/m` 原生交互菜单，可通过下拉框选择会话、模型、Agent 预设和工作区，并使用新会话、停止、压缩、状态与帮助按钮；长列表支持分页，收到平台每日进入单聊事件时也会展示菜单。菜单操作沿用文字命令权限，30 分钟或插件重启后过期，卡片无法投递时提供文字命令降级。
  Enterprise WeChat adds native `/menu` and `/m` menus with dropdowns for Sessions, models, Agent Presets, and workspaces, plus New, Stop, Compact, Status, and Help buttons. Long lists support pagination, and the platform's daily direct-chat entry event also opens the menu. Actions use existing text-command permissions; menus expire after 30 minutes or a plugin restart, with text-command fallback when cards cannot be delivered.

- 九个 IM 渠道的账号卡片现在默认收起详细设置，点击账号标题或使用 Enter／空格即可展开与收起，便于管理多个机器人；折叠区域的控件不会继续占用键盘焦点，并尊重系统的减少动画设置。
  Account cards across all nine IM channels now collapse their detailed settings by default. Click the account header or press Enter/Space to toggle them for easier multi-bot management. Collapsed controls are excluded from keyboard focus, and animations respect reduced-motion preferences.

### Changed / 变更

- WhatsApp 回复改为每秒编辑同一条消息，逐步显示工具进度和生成中的回答；最终回复原位定稿，长回复自动分段。创建或完成流式消息失败时回退为完整文字回复，断开机器人时会取消待发送的预览。
  WhatsApp now edits the same message at one-second intervals to show tool progress and generated text, finalizes the answer in place, and splits long replies. Failed stream creation or finalization falls back to a complete text reply, and disconnecting the bot cancels queued previews.

### Fixed / 修复

- 删除首个账号后，其余账号的折叠样式与展开／收起操作现在会正常保留。
  Removing the first account no longer removes the shared collapse styles or disrupts toggling for the remaining accounts.

## [4.11.0] - 2026-09-05

### Added / 新增

- 已保存的私聊投递目标新增默认关闭的「会话双向同步」开关。开启后，DSH Web／CLI 在该私聊当前 Session 中提交的用户文字和完成后的助手文字会通过原机器人同步回私聊；IM 自身输入不会重复投递。九个 IM 渠道共用同一实现，自动跟随 `/session`、`/new` 和工作区切换后的当前会话；首版仅支持当前 Host 的私聊文字，不支持显式远程 `harnessBaseUrl`、群聊、Topic 或 Thread。
  Saved direct-message delivery targets now have an opt-in **Two-way Session sync** switch. When enabled, user text submitted from DSH Web/CLI and the completed assistant text in that DM's current Session are mirrored through the original bot, while IM-originated input is never duplicated. One shared implementation covers all nine IM channels and follows the current Session across `/session`, `/new`, and workspace changes. The first version supports text DMs on the current Host only, excluding explicit remote `harnessBaseUrl` connections, groups, Topics, and Threads.

- 九个 IM 渠道的每个机器人新增独立模型设置，可从 Host 当前可用模型中选择或跟随默认；设置只影响之后新建的 Session，已有 Session 与正在生成的回复不变。
  Every bot across all nine IM channels now has an independent model setting, selectable from the Host's current model catalog or left to follow the default. The setting applies only to newly created Sessions and does not alter existing Sessions or in-progress replies.

### Changed / 变更

- npm 包元数据新增已验证兼容 DSH `0.1.3-alpha.1`；兼容测试使用官方发布提交 `d347e70`，并完成九渠道各一台机器人的真实主动投递与双向同步冒烟。
  npm package metadata now declares verified compatibility with DSH `0.1.3-alpha.1`. Compatibility testing used official release commit `d347e70` and completed real proactive-delivery and two-way-sync smoke tests with one bot on each of the nine channels.

- 飞书的「群聊响应方式」与「群聊以话题方式回复」已从机器人卡片主页移入该机器人的设置页，使卡片布局与其他渠道保持一致。
  Feishu's “Group response mode” and “Reply to group chats as topics” controls have moved from the bot-card overview into that bot's settings page, aligning the card layout with the other channels.

### Fixed / 修复

- 九个 IM 渠道现在会按 step 顺序保留同一 Turn 的全部助手正文，并用定稿消息替换同 step 的流式草稿；多 step 回答不再在最终投递或进入新 step 时只剩最后一段。
  All nine IM channels now retain every assistant text step in turn order and replace each step's streamed draft with its canonical message, preventing multi-step replies from collapsing to the final fragment during streaming or final delivery.

## [4.10.0] - 2026-09-05

### Added / 新增

- 入站附件改为按时间戳目录持久落盘，并新增全局保留时长（TTL）设置：`-1` 永久保留、`0` 每轮对话结束后立即删除、`1-8760` 整数小时后自动清理，默认 `168` 小时（7 天）；清理在进程启动、每 30 分钟及设置页手动触发时执行，进行中对话的目录会被跳过。通用设置通过顶部 GitHub 按钮右侧的齿轮进入，附件保留功能位于首个「附件」Tab；取值说明收纳在标题右侧的问号中，修改后通过「保存」按钮明确提交。清扫会拒绝位于工作区外的符号链接附件目录。历史 `turn-` 目录及无法解析的目录不参与清理，需要手动删除。清扫仅覆盖各渠道当前配置的工作区；Bot 通过 `/workspace` 切换工作区后，旧工作区中已持久化的附件目录不再参与自动清理，需手动删除。
  Inbound attachments now persist under timestamped directories with a global retention (TTL) setting: `-1` keeps them forever, `0` deletes each directory right after its turn ends, and whole hours `1-8760` clean them automatically, defaulting to `168` hours (7 days). Sweeps run at process startup, every 30 minutes, and on demand from the settings page, always skipping directories owned by in-flight turns. General settings open from the gear beside the top GitHub button, with attachment retention under the first “Attachments” tab. Sweeps refuse symlinked attachment roots outside the workspace. Legacy `turn-` directories and unparseable names are never touched and must be removed manually. Sweeping only covers each channel's currently configured workspaces; after a bot switches its workspace via `/workspace`, persisted attachment directories left in the previous workspace are no longer swept and must be removed manually.

- 飞书机器人设置新增「群聊以话题方式回复」开关：开启后，群聊中向机器人提问会自动开启一条独立的飞书话题，回答落在话题内；每个话题是 dsh 会话列表里的一条独立会话，上下文互不串。私聊不受影响。可分别对每个机器人开启或关闭。
  Feishu bots gain a “Reply to group chats as Feishu topics” switch. When enabled, a question addressed to the bot in a group auto-opens a dedicated Feishu topic and replies stay inside it; each topic is an independent conversation in dsh with its own context. Private chats are unaffected. The switch is configured per bot.

- 同 Host 插件的 `ctx.dshIm` 服务新增 `listBots()`，可发现已配置机器人的公开 `botId` 与渠道类型，再配合现有 `listTargets()` 和 `send()` 完成主动投递；返回值不包含凭据、平台路由或目标内容。
  The same-Host `ctx.dshIm` service now exposes `listBots()`, allowing plugins to discover each configured bot's public `botId` and channel before using the existing `listTargets()` and `send()` APIs for proactive delivery. Results contain no credentials, provider routes, or target content.

### Changed / 变更

- npm 包元数据现在声明已验证兼容 DSH `0.1.2-alpha.4`、`0.1.2-alpha.5` 与 `0.1.2-rc.1` 的 Web profile。
  npm package metadata now declares verified Web-profile compatibility with DSH `0.1.2-alpha.4`, `0.1.2-alpha.5`, and `0.1.2-rc.1`.

### Fixed / 修复

- 新版 DSH Session 使用 `snapshotEvents()` 时，IM 的 `/stop` 现在可以再次识别并停止当前所属 Turn。
  IM `/stop` once again recognizes and cancels the currently owned turn when running against modern DSH Sessions that expose `snapshotEvents()`.

- 飞书在 DSH v2 生成回复期间会重新接收并转发实时 assistant chunk，流式卡片不再等到最终消息落盘后才显示整段回答。
  Feishu now receives and forwards live assistant chunks while DSH v2 is generating, so streaming cards no longer wait for the final durable message before displaying the full reply.

## [4.9.1] - 2026-09-04

### Fixed / 修复

- 九个 IM 渠道的 Harness 结构化问题与审批现在兼容新 DSH Session 的 `snapshotEvents()` 接口，同时保留旧 `session.events` 与旧 Host `apiProxy` 路径；交互不再只停留在 DSH Web，IM 用户回答或审批后原 Turn 可继续完成。
  Harness structured questions and approvals across all nine IM channels now support the new DSH Session `snapshotEvents()` API while retaining the legacy `session.events` and Host `apiProxy` paths. Interactions no longer remain visible only in DSH Web, and the originating turn can continue after the IM user answers or decides.

- 钉钉机器人连接失败时现在会按 Harness、凭据、超时、DNS、TLS、代理、SDK 与依赖兼容性等原因提供脱敏且可操作的诊断，并用参考号关联设置页提示与 Host 日志；已保存但尚未连通的机器人也会保留在设置页供排查。
  DingTalk connection failures now provide redacted, actionable diagnostics for Harness, credential, timeout, DNS, TLS, proxy, SDK, and dependency-compatibility causes, with a reference ID linking settings feedback to Host logs. Saved bots that are not yet connected also remain available in settings for troubleshooting.

## [4.9.0] - 2026-09-03

### Added / 新增

- 飞书的 Harness 审批与单选问题默认使用带按钮的交互卡片；审批人和答题人会绑定到发起者，多题场景会拒绝过期卡片，并在卡片不可用时保留纯文本降级流程。可通过 `DSH_IM_INTERACTION_CARDS=0` 或 `interactionCards=false` 继续使用纯文本交互。
  Harness approvals and single-choice questions in Feishu now use interactive cards with buttons by default. Decisions are bound to the initiating actor, stale cards are rejected in multi-question flows, and plain-text fallback remains available when cards cannot be used. Set `DSH_IM_INTERACTION_CARDS=0` or `interactionCards=false` to keep the plain-text interaction flow.

- 九个渠道的工作区命令新增快捷别名：`/ws` 等价于 `/workspace`，`/workspaces` 与 `/wsl` 等价于 `/workspacelist`。
  Workspace commands across all nine channels now have shortcuts: `/ws` aliases `/workspace`, while `/workspaces` and `/wsl` alias `/workspacelist`.

### Fixed / 修复

- Harness 回复等待改为按活动续期：持续产生事件或 Harness 明确报告 Session 仍在运行的长任务不再被固定 10 分钟上限误报超时；已开始但停止推进且不再运行的任务仍会按停滞窗口超时。
  Harness reply waits now renew from activity: long-running turns that keep producing events or are still reported as running no longer hit a fixed ten-minute timeout, while started turns that stop progressing and are no longer running still time out after the stall window.

- 引用消息注入 Harness 时不再携带内部消息 ID、作者 ID、空附件数组及默认 `truncated: false`，减少与回答无关的元数据，同时保留作者名称、正文、有效附件及不可用原因。
  Quoted-message context sent to Harness no longer includes internal message IDs, author IDs, empty attachment arrays, or the default `truncated: false`, reducing irrelevant metadata while preserving the author name, content, useful attachments, and unavailable reason.

- 飞书交互卡片现在保持引用回复语义，避免问题或审批卡片脱离触发它的消息上下文。
  Feishu interaction cards now preserve reply semantics so question and approval cards stay attached to the message context that triggered them.

- 上下文增强设置中的字段帮助提示会按左右栏定位，不再被设置面板边缘裁切。
  Field-help tooltips in Context enhancement settings now align to their column instead of being clipped by the settings-panel edge.

### Documentation / 文档

- 中英文 README 的详细安装、命令、访问模式与上下文增强说明已拆分到独立指南，并补充主动投递 Webhook 方案等文档。
  Detailed installation, command, access-mode, and Context enhancement material has moved from the Chinese and English READMEs into focused guides, with additional documentation for proactive-delivery webhooks and related workflows.

## [4.8.0] - 2026-09-02

### Added / 新增

- 上下文增强新增两个来源字段：`chatId`（会话标识，用于区分群组或私聊）与 `threadId`（话题标识，飞书话题群会带上 `thread_id`，用于区分同一群组内的不同话题）。九个渠道均可勾选；飞书群聊直接提供群 ID，Slack/Telegram 话题、Discord 频道等渠道也按各自事件补齐。仍只发送当前消息中已有的值，不查询平台 API。
  Context enhancement adds two source fields: `chatId` (the chat ID that distinguishes groups or direct chats) and `threadId` (the topic ID; Feishu topic chats carry `thread_id`, telling different topics inside the same group apart). All nine channels can select them; Feishu group chats provide the group ID directly, and Slack/Telegram topics, Discord channels, and other channels are wired per their own events. Only values already present in the current message are sent; no platform APIs are queried.

### Fixed / 修复

- 机器人工作区目录选择器现在同时识别新版 DSH 的 `directory-picker/*` 错误码与旧版连字符错误码；native 后端会正确回退到系统目录选择器，已失效的保存路径也会回退到 Host 主目录。
  The bot workspace directory picker now recognizes both current DSH `directory-picker/*` error codes and legacy hyphenated codes, restoring the native system-picker fallback and the Host-home fallback for stale saved paths.

## [4.7.0] - 2026-09-02

### Added / 新增

- `/sessionlist --limit N` 与等价命令 `/sessions --limit N` 现在可按现有顺序仅返回当前工作区的前 N 个会话；`N` 必须是正整数，该参数仅影响本次响应，不改变机器人或全局配置。飞书的分页会话卡片会在后续翻页与选择操作中保持同一限制。
  `/sessionlist --limit N` and its `/sessions --limit N` alias now return only the first N sessions in the current workspace's existing order. `N` must be a positive integer, and the option affects only that response without changing bot or global settings. Feishu's paginated session card preserves the same limit across subsequent page and selection actions.

## [4.6.0] - 2026-09-02

### Added / 新增

- 非视觉模型收到图片时不再直接报错丢图：宿主以 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝带图片的 prompt 后，自动把同一批图片字节按入站文件管线落盘到 Session 工作区，并以"原文本 + 工具分析指引 + `<dsh_im_files>` 清单"的纯文本 prompt 复用同一 rpcId 重试一次，使非视觉模型仍可通过 run_code/pwsh 等工具识图；视觉模型与文件消息行为不变，其余图片错误仍按原样提示。
  Sending an image to a non-vision model no longer fails outright: when the Host rejects an image-bearing prompt with `MODEL_DOES_NOT_SUPPORT_IMAGES`, the same image bytes are automatically staged into the Session workspace through the inbound-file pipeline and retried once as a text-only prompt (original text plus tool-analysis guidance and the `<dsh_im_files>` manifest) under the same rpcId, so non-vision models can still inspect images via tools such as run_code/pwsh. Vision models and file messages are unchanged, and other image errors keep their existing messages.

- 九个 IM 渠道统一支持引用或回复消息上下文：Harness 会在当前问题之前收到安全序列化的 `<dsh_im_reply_to>`，包含平台可提供的原消息文字、作者及附件类型/名称；缺少正文快照的渠道仅在访问控制和本地交互完成后进行同会话、有界的延迟查询或 Session 历史恢复，失败时不阻断当前问题，也不会把引用内容误当作命令、审批或问题回答。
  All nine IM channels now preserve quoted or replied-to message context. Harness receives a safely serialized `<dsh_im_reply_to>` before the current question with the original text, author, and attachment type/name when available. Channels without a content snapshot perform only bounded, same-conversation lazy lookup or Session-history recovery after access control and local interactions; lookup failure does not block the current question, and quoted content cannot be interpreted as a command, approval, or question answer.

### Fixed / 修复

- 非视觉模型图片回退在文件落盘阶段收到取消信号时，现在会保留调用方的取消原因并停止处理，不再误报模型不支持图片。
  When image fallback for a non-vision model is cancelled while staging files, it now preserves the caller's cancellation reason and stops instead of reporting that the model does not support images.

## [4.5.0] - 2026-09-01

### Added / 新增

- `/workspace` 现在支持使用 `/workspacelist` 中的工作区序号切换，并在执行命令时按最新列表解析；原有绝对路径用法保持不变。
  `/workspace` now accepts a workspace number from `/workspacelist`, resolved against the latest list when the command runs; the existing absolute-path form remains supported.

- 上下文增强新增可选的 `conversationTitle` 来源字段；渠道入站事件提供会话标题时可将其写入 `<dsh_im_source>`，无需额外的平台 API 请求。
  Context enhancement now offers an optional `conversationTitle` source field. When an inbound channel event provides a conversation title, it can be included in `<dsh_im_source>` without an additional platform API request.

### Fixed / 修复

- 新建 Harness Session 的标题现在始终基于未经上下文增强的首条用户消息：启用增强时会移除注入块后安全设置标题，未启用增强时继续保留 Harness 的原生自动标题；标题会清理控制字符并按 UTF-8 字节安全截断。
  New Harness Session titles now consistently reflect the unenhanced first user message. With enhancement enabled, dsh-im safely sets a title without injected context blocks; without enhancement, the Harness-native automatic title is preserved. Titles are sanitized and truncated safely by UTF-8 byte length.

- 飞书流式回复在同一轮出现 Harness 问题或审批交互时，会先结束当前卡片并在交互完成后创建新卡片，使最终回答显示在交互卡片之后；卡片轮换失败时保持可用的降级投递。
  When a Feishu streaming turn presents an in-turn Harness question or approval, dsh-im now finalizes the current card and starts a new one after the interaction so the final answer appears below the interaction card, with usable fallback delivery if card rotation fails.

## [4.4.0] - 2026-09-01

### Added / 新增

- 九个 IM 渠道新增统一的机器人级“访问设置”：私聊与群聊可分别选择允许所有用户或仅白名单用户，并独立配置默认命令权限、命令权限例外及白名单用户权限。策略按 `botId` 原子保存，保存后对新入站消息立即生效；原 owner、扫码接入者等既有特权身份继续保留访问与完整命令权限，Telegram 与 WhatsApp 旧访问配置会自动迁移。
  All nine IM channels now provide unified per-bot Access settings. Direct and group chats can independently allow everyone or only allowlisted users, with separate default command permissions, command-permission overrides, and per-user allowlist permissions. Policies are atomically stored by `botId` and apply to new inbound messages immediately; existing privileged identities such as owners and QR provisioners retain full access and command permissions, while legacy Telegram and WhatsApp access settings migrate automatically.

### Changed / 变更

- 机器人卡片的设置页改为可扩展的横向 Tab 布局，现有 Bot ID、投递目标管理与专属使用文档统一归入“投递设置”页签。
  Bot-card settings now use an extensible horizontal tab layout, with the existing Bot ID, delivery-target management, and dedicated guide grouped under the Delivery settings tab.

### Fixed / 修复

- 飞书长连接现在会先按常见 `NO_PROXY` / `no_proxy` 语义排除 `open.feishu.cn` 与 `open.larksuite.com`，仅在未命中排除规则时使用代理环境变量，避免本地代理导致长连接持续失败重试。
  Feishu long connections now honor standard `NO_PROXY` / `no_proxy` matching for `open.feishu.cn` and `open.larksuite.com` before using proxy environment variables, preventing local proxies from forcing the connection into a retry loop.

- 飞书话题群中的卡片操作确认、watch 完成通知、命令及子流程失败提示现在都会回复到对应卡片或触发消息所在话题；没有可用话题锚点的历史数据继续沿用原有投递方式。
  Feishu card-action confirmations, watch completion notices, and command or sub-flow failures in topic groups now reply inside the topic containing the relevant card or triggering message; legacy entries without an anchor keep their previous delivery behavior.

## [4.3.0] - 2026-09-01

### Added / 新增

- 飞书话题群现在按 `thread_id` 为每个话题隔离 Harness Session、上下文、批量输入与待处理交互；普通群聊和私聊的会话键保持不变。回答流、命令结果、菜单卡片、Harness 问题及审批提示也会回复到触发消息所在话题，引用消息失效时安全回退为普通消息。
  Feishu topic groups now isolate Harness Sessions, context, batch input, and pending interactions by `thread_id`, while regular group and direct-chat keys remain unchanged. Answer streams, command results, menu cards, Harness questions, and approval prompts reply inside the triggering topic, with a safe plain-message fallback when the referenced message is unavailable.

- QQ 入站消息现在启用 SDK 表情标签解析，把不透明的 `<faceType=...>` 片段转换为 `【表情: 名称】` 等可读文本后再交给 Harness。
  QQ inbound messages now enable the SDK face-tag parser, converting opaque `<faceType=...>` fragments into readable text such as `【表情: name】` before delivery to Harness.

### Changed / 变更

- 上下文增强现在为群聊和私聊分别保存启用开关、来源字段与增强提示词，接收消息时只使用当前会话类型对应的配置。旧版共用字段与提示词会在升级后自动映射到两个场景，并在下一次成功写入机器人设置时无损保存为新结构，无需手工迁移。
  Context enhancement now stores independent enable switches, source fields, and guidance for group and direct chats, and inbound messages use only the matching conversation configuration. Existing shared fields and guidance are automatically mapped to both scopes after upgrade and are losslessly persisted in the new structure on the next successful bot-settings write, with no manual migration required.

## [4.2.1] - 2026-08-31

### Fixed / 修复

- Telegram 机器人现在为长轮询和发送请求使用同一 Runtime 私有、代理感知的有限连接池，避免全局 HTTP 连接受限时 `getUpdates` 阻塞消息发送；停止或启动失败时会显式释放连接池。
  Telegram bots now use a private, proxy-aware bounded connection pool per Runtime for both long polling and sends, preventing `getUpdates` from blocking delivery when global HTTP connections are constrained; the pool is explicitly released on stop and failed startup.

## [4.2.0] - 2026-08-31

### Added / 新增

- 飞书机器人启动时调用 `app_slash_commands` OpenAPI，把常用命令注册为原生 Slash Command，使飞书单聊输入框输入 `/` 弹出命令面板；命令清单由 dsh-im 持有并推送注册，不依赖 dsh/Harness 后端。扫码新建的应用默认申请所需权限，已有应用可通过“补全权限”或 `/repair` 增量补全；注册失败不影响消息收发。
  On startup the Feishu bot registers its common commands as native Slash Commands via the `app_slash_commands` OpenAPI, so the `/` panel appears in Feishu direct-message input. The command list is owned and pushed by dsh-im and does not depend on the dsh/Harness backend. New QR-provisioned apps request the required scopes by default, while existing apps can add them through Complete permissions or `/repair`; registration failure does not affect messaging.

## [4.1.1] - 2026-08-31

### Fixed / 修复

- QQ 扫码绑定的机器人现在会响应群内任意成员对机器人的 @ 消息，同时继续只接受扫码者的私聊；群聊仍不会响应未 @ 机器人的普通消息。
  QQ bots connected by QR code now respond when any group member mentions the bot, while private chats remain restricted to the scanner. Ordinary group messages without a mention remain ignored.

### Documentation / 文档

- 中英文 README 新增上下文增强界面截图和企业微信群入口，方便查看设置效果并加入用户社区。
  Added context-enhancement screenshots and the WeCom community-group entry to the Chinese and English READMEs, making the settings easier to preview and the user community easier to join.

## [4.1.0] - 2026-08-30

### Added / 新增

- 九个 IM 渠道统一支持基于稳定 `botId + targetId` 的主动投递：普通外部程序可调用 `POST /api/dsh-im/delivery/messages`，同 Host Cordis 插件可调用 `ctx.dshIm`，已有 Connection 客户端可调用 `/dsh-im-delivery` RPC；三个入口共用同一投递核心。机器人卡片新增设置页，可复制 Bot ID、管理多个目标并逐个真实测试。新建目标时优先从九渠道已持久化的 conversation keys 选择已聊会话并自动预填稳定路由及随机 `targetId`，手动填写保留为高级兜底并同样预填随机 `targetId`。候选不包含 Harness Session ID、聊天正文、会话名称或活跃时间，也不代表平台全量聊天。
  Added stable `botId + targetId` proactive delivery across all nine IM channels. Ordinary external programs can call `POST /api/dsh-im/delivery/messages`, same-Host Cordis plugins can call `ctx.dshIm`, and existing Connection clients can call `/dsh-im-delivery` RPC; all three entry points share one delivery core. Bot cards now open a settings page for copying Bot IDs, managing multiple targets, and testing each target with a real send. Creating a target now starts with conversations derived from persisted conversation keys across all nine channels and pre-fills both the stable native route and a random `targetId`; advanced manual entry also starts with a random `targetId`. Suggestions contain no Harness Session ID, message text, conversation name, or activity timestamp and are not a complete platform chat directory.

- 新增中英文主动投递使用指南，覆盖设置流程、九渠道字段、HTTP POST、同 Host 插件与 Connection RPC 示例、错误处理和排错；机器人投递设置页可按当前界面语言直接打开对应指南。
  Added Chinese and English proactive-delivery guides covering setup, native fields for all nine channels, HTTP POST, same-Host plugin and Connection RPC examples, errors, and troubleshooting. Bot delivery settings link directly to the guide matching the current UI language.

- 九个 IM 渠道新增 `/presets` 与 `/sessions` 快捷命令，分别作为 `/presetlist` 与 `/sessionlist` 的等价别名，不改变原有会话、工作区或 Agent Preset 行为。
  Added `/presets` and `/sessions` shortcuts across all nine IM channels as equivalent aliases for `/presetlist` and `/sessionlist`, without changing existing Session, workspace, or Agent Preset behavior.

## [4.0.1] - 2026-08-30

### Fixed / 修复

- 新版 DSH 中，机器人卡片的工作区目录选择器现在使用 `uiWorkspace` 目录服务，不再调用已从 Workspace Controller 移除的 `workspaces.listDirectory` / `pickDirectory`；旧版 Host 仍保留原接口回退。
  On current DSH releases, the bot-card workspace picker now uses the `uiWorkspace` directory service instead of the removed Workspace Controller `workspaces.listDirectory` / `pickDirectory` methods, while retaining the legacy Host fallback.

## [4.0.0] - 2026-08-29

### Fixed / 修复

- 本机 `dsh web` 与 DSH Desktop 现在同时兼容旧版和当前版 Host：旧版继续复用内部 `apiProxy`，当前版自动适配 Typert Gateway、Session Controller 与 Workspace Controller；两者都无需回环 HTTP 地址，并继续隔离不同 Host 的会话、审批与问题交互。显式 `harnessBaseUrl` 仅保留给旧版远程 HTTP/WebSocket Harness。
  Local `dsh web` and DSH Desktop now support both legacy and current Hosts. Legacy releases continue to reuse the internal `apiProxy`, while current releases automatically adapt the Typert Gateway plus Session and Workspace controllers. Neither requires a loopback HTTP address, and Sessions, approvals, and questions remain isolated between Hosts. Explicit `harnessBaseUrl` is retained only for legacy remote HTTP/WebSocket Harness endpoints.

## [3.2.0] - 2026-08-29

### Added / 新增

- 九个 IM 渠道的机器人设置新增可选“上下文增强”，可分别控制群聊与私聊，把勾选的渠道、会话类型、发送者和机器人来源字段连同自定义引导附加到普通用户消息；默认关闭、不额外查询平台资料，微信当前仅支持私聊。
  Added optional context enhancement to bot settings across all nine IM channels. It can independently target group and direct chats and attach selected channel, conversation, sender, and bot source fields plus custom guidance to ordinary user messages. It is off by default, performs no extra profile queries, and currently supports direct chats only on Weixin.

- 更新窗口新增手工更新命令及一键复制，页面更新失败时可在相同 Harness / Desktop 环境中通过 npm 更新；复制受限时可选中文本手动复制，安装完成后仍需手动重启。
  Added a manual npm update command and copy button to the update dialog for use in the same Harness / Desktop environment when the in-page update fails. The command remains selectable if clipboard access fails, and installation still requires a manual restart.

### Fixed / 修复

- 钉钉群聊的流式回复现在会在进度、完成和清理阶段保留对发送者的原生提及，无需额外发送提醒消息；私聊与批量回复失败处理保持原有行为。
  DingTalk streamed group replies now preserve the native mention of the sender across progress, completion, and cleanup without sending a separate reminder; direct chats and batch-reply failure handling retain their existing behavior.

## [3.1.1] - 2026-08-28

### Fixed / 修复

- 飞书流式回复超过单卡长度限制时保留预览，生成结束后分段发送完整回答，不再因超限抛错而撤回卡片；分段保留 Unicode 字符、空白和所有消息 ID，解决 Issue #78。
  Feishu streaming replies now keep a bounded preview and deliver the complete final answer across multiple cards instead of throwing and recalling the card when its length limit is exceeded. Splitting preserves Unicode characters, whitespace, and every message ID, resolving Issue #78.

## [3.1.0] - 2026-08-28

### Added / 新增

- 「设置 → IM机器人」新增 npm 更新检查和确认安装按钮，复用当前 Desktop / Harness 的包管理机制；保护源码链接、校验精确版本与目标 profile，不拉取 GitHub，安装后提示手动重启。手动重启后可「刷新状态」核验生效，无需重载原页面。更新功能不会主动重启或刷新；宿主自带的界面刷新不代表后台版本已生效。
  Added npm update checking and confirmed installation to Settings → IM Bot using the current Desktop / Harness package-management mechanism. It protects source links, verifies the exact version and target profile, uses no GitHub downloads, and requires a manual restart. Refresh status verifies the restarted Host without reloading the existing page. The updater does not request a restart or refresh; the host's own interface refresh does not mean the new backend version is running.

- 九个聊天渠道统一新增私聊命令 `/history [数量]`，只读预览当前绑定会话的最近对话：默认 3 条、最多 5 条，超出上限自动按 5 条处理；过滤工具、推理和未完成回复，长正文截断，并复用各渠道现有文字回复机制。命令不创建会话或调用模型，绑定成功提示和中英文帮助同步提供入口。
  Added `/history [count]` to direct chats on all nine channels to preview the bound Session's recent conversation without creating a Session or prompting the model. It defaults to 3 messages and caps larger counts at 5, omits tools, reasoning, and unfinished replies, truncates long text, and reuses each channel's existing text-reply mechanism. Binding confirmations and bilingual help now point to the command.

### Fixed / 修复

- 调整设置页渠道栏顶部间距，使渠道页签与扫码操作对齐。
  Adjusted the channel rail's top spacing to align channel tabs with the scan action in settings.

## [3.0.8] - 2026-08-28

### Fixed / 修复

- 本机 `dsh web` 与 DSH Desktop 的 IM 渠道和 AI Office 现在默认直接使用当前 Host 的内部 `apiProxy`，不再依赖回环 HTTP 端口或 Desktop 的浏览器/局域网访问开关；显式配置 `harnessBaseUrl` 时仍使用 HTTP/WebSocket，内部调用失败不会静默切换 Host。
  IM channels and AI Office in local `dsh web` and DSH Desktop now use the current Host's internal `apiProxy` by default, removing the dependency on loopback HTTP ports or Desktop's browser/LAN access settings. Explicit `harnessBaseUrl` configurations still use HTTP/WebSocket, and failed internal calls never silently switch Hosts.

## [3.0.7] - 2026-08-27

### Fixed / 修复

- `/compact` 同时兼容要求 `images` 字段的新 Harness 与不接受该字段的旧 Harness；仅在网关明确拒绝多余字段、命令尚未执行时回退，避免重复压缩。
  `/compact` now supports both newer Harness endpoints that require `images` and older endpoints that reject it, falling back only after an explicit pre-execution field rejection to avoid duplicate compaction.

### Documentation / 文档

- 中英文 README 的联系方式新增 WhatsApp 二维码。
  Added a WhatsApp contact QR code to the Chinese and English READMEs.

## [3.0.6] - 2026-08-26

### Fixed / 修复

- 工作区目录选择器现在可以直接输入 Windows 盘符、UNC 共享或 POSIX 绝对路径并跳转；输入的目录无法读取时不会误选先前浏览的目录，解决 Issue #69。
  The workspace directory picker now accepts direct Windows drive, UNC share, and POSIX absolute paths; an unreadable typed path can no longer accidentally select the previously browsed directory, resolving Issue #69.
- 微信回复发送失败时会记录并展示脱敏的接口、域名、分段大小、上下文状态、HTTP 状态和平台错误码诊断，便于定位长回复部分投递等问题，同时不会泄露令牌或平台原始错误详情。
  Failed WeChat reply delivery now records and presents sanitized endpoint, host, chunk-size, context, HTTP-status, and provider-code diagnostics for troubleshooting issues such as partially delivered long replies, without exposing tokens or raw provider error details.

## [3.0.5] - 2026-08-26

### Fixed / 修复

- 微信扫码绑定和消息接口现在同时信任腾讯的 `wechat.com` 国际域名及其子域名，国际环境下的二维码验证、登录重定向和消息连接不再被错误拒绝，同时继续拦截伪装后缀域名。
  WeChat QR provisioning and messaging APIs now also trust Tencent's international `wechat.com` domain and its subdomains, preventing valid QR verification, login redirects, and message connections from being rejected in international environments while still blocking lookalike suffix domains.

## [3.0.4] - 2026-08-26

### Changed / 变更

- 回退 3.0.3 中未计划进入 `main` 的 WhatsApp 群聊提及、回复识别与群成员调用白名单改动；WhatsApp 行为恢复到 3.0.2。
  Reverted the WhatsApp group mention/reply detection and group-caller allowlist changes from 3.0.3 that were not intended for `main`; WhatsApp behavior returns to 3.0.2.

## [3.0.3] - 2026-08-26

### Fixed / 修复

- WhatsApp 开放响应模式现在会正确识别群聊中的提及和回复，并使用与私聊联系人分开保存的群成员号码列表控制调用者；群成员列表为空时允许所有群成员。
  WhatsApp Open responses now correctly recognize group mentions and replies and use a separately stored group-member number list to control callers; an empty group list allows every group member.
- 机器人卡片在窄屏布局下仍会把连接状态保持在卡片右上角，不再移动到机器人信息下方。
  Bot cards now keep connection status in the top-right corner on narrow layouts instead of moving it below the bot identity.
- 企业微信流式回复现在会把思考过程与最终答案分开呈现，工具进度只更新思考区域，避免覆盖或混入答案正文。
  WeCom streaming replies now present thinking separately from the final answer, with tool progress updating only the thinking area instead of overwriting or mixing into the answer body.

## [3.0.2] - 2026-08-26

### Fixed / 修复

- 设置页现在会在 `DSH-IM` 品牌标题旁常驻显示当前插件版本，不再需要悬停或键盘聚焦才能查看。
  The settings page now displays the current plugin version persistently beside the `DSH-IM` brand heading instead of requiring hover or keyboard focus.

## [3.0.1] - 2026-08-26

### Fixed / 修复

- QQ 私聊最终回答现在使用标准 Markdown 消息投递，避免部分客户端确认流式最终帧却不显示内容；长回答会安全拆分代码块和 GFM 表格，遵守被动回复配额，并仅在平台明确拒绝 Markdown 时逐段回退纯文本，避免不确定结果造成重复回复。
  QQ direct-message final answers now use standard Markdown delivery to avoid clients that acknowledge but do not render final streaming frames. Long answers safely split fenced code and GFM tables, respect passive-reply quotas, and fall back to plain text per chunk only after a definite Markdown rejection, preventing duplicate replies after uncertain outcomes.
- 优化英文设置界面的文案与间距，限制 Telegram 机器人卡片在窄面板内自适应显示，并把版本提示移到品牌标题下方，避免内容溢出或提示被裁切。
  Polished English settings copy and spacing, constrained Telegram bot cards within narrow panels, and moved the version tooltip below the brand heading to prevent overflow or clipping.

### Documentation / 文档

- 英文 README 新增设置界面预览图。
  Added a settings interface preview to the English README.

## [3.0.0] - 2026-08-25

### Changed / 变更

- 「IM机器人」设置页已从插件页签迁移到一级设置菜单，并以 `order: 21` 尽量排在「Agent 预设」之后；新版不再注册旧二级入口。升级后重启 `dsh web` 并刷新浏览器即可使用，已有机器人配置和页面内的渠道专属 Logo 保持不变。
  The **IM Bot** settings page has moved from a Plugins tab to the top-level settings menu and uses `order: 21` to follow **Agent Presets**. The new release no longer registers the legacy nested entry. Restart `dsh web` and refresh the browser after upgrading; existing bot configuration and channel-specific logos inside the page are preserved.

### Fixed / 修复

- 飞书中不含附件且仅有一个文本段落的富文本消息，如果内容是插件命令，现在会按普通文本命令处理，不再转发给 Harness。
  In Feishu, attachment-free rich-text messages containing a single text paragraph are now handled as ordinary plugin commands instead of being forwarded to Harness.

## [2.6.0] - 2026-08-25

### Added / 新增

- 飞书、钉钉、Slack、Telegram、Discord 和 WhatsApp 现在会通过消息 Reaction 显示任务正在处理、成功或失败；Reaction 调用采用限时的尽力而为机制，不会阻塞正常回复。Slack App Manifest 同步加入 `reactions:write`，已有 App 需要重新授权或安装后再连接机器人。
  Feishu, DingTalk, Slack, Telegram, Discord, and WhatsApp now use message reactions to show processing, success, or failure. Reaction calls are time-bounded and best-effort, so they never block normal replies. The Slack App Manifest now includes `reactions:write`; existing Apps must be re-authorized or reinstalled before reconnecting the bot.

### Fixed / 修复

- 当交互答案提交或后续交互问题发送失败时，消息会保留失败 Reaction，不再被外层处理流程覆盖为成功状态。
  When submitting an interaction answer or presenting a follow-up interaction question fails, the message now retains its failure reaction instead of being overwritten as successful by the outer processing flow.

## [2.5.0] - 2026-08-25

### Added / 新增

- 插件设置页的 DSH-IM 品牌标题现在支持悬停或键盘聚焦显示当前插件版本。
  The DSH-IM brand heading in plugin settings now displays the current plugin version on hover or keyboard focus.
- 九种内置聊天渠道新增结构化消息失败报告：会针对 Harness 连接、模型、会话、输入和渠道投递等故障给出可执行的中英文提示，并附带错误码与参考号；机器人设置卡片也会显示最近一次消息处理失败。
  Added structured message failure reporting across all nine built-in chat channels, with actionable bilingual guidance for Harness connectivity, model, Session, input, and channel-delivery failures, plus an error code and reference ID; bot cards also show the latest message-processing failure.
- 微信机器人现在会在 Harness 处理消息期间显示“正在输入”，并在最终回复、交互问题、错误或任务停止前自动取消；输入状态接口不可用时仍会正常发送最终回答。
  WeChat bots now show a typing indicator while Harness processes a message and automatically cancel it before final replies, interaction questions, errors, or stopped turns; final answers still work when the typing API is unavailable.

## [2.4.0] - 2026-08-25

### Added / 新增

- 九种内置聊天渠道新增 `/version` 命令，可直接查看当前运行的 dsh-im 插件版本；该命令不会连接 Harness、创建 Session 或调用模型。
  Added a `/version` command across all nine built-in chat channels for displaying the running dsh-im plugin version without contacting Harness, creating a Session, or invoking the model.

### Changed / 变更

- 飞书原“修复卡片按钮”操作已更名为“补全权限”，并会同时增量申请读取用户消息内图片或文件所需的 `im:message:readonly`、上传机器人图片或文件所需的 `im:resource`，以及卡片回调；缺权提示会引导用户私聊执行 `/repair`，或在插件页面点击“补全权限”。界面会说明各自用途，并明确确认页只展示应用当前缺少的配置。
  The former Feishu **Repair card buttons** action is now **Complete permissions**. It incrementally requests `im:message:readonly` for reading images or files in user messages, `im:resource` for uploading bot-sent images or files, and the card callback. The UI explains each purpose and that the confirmation page shows only the app's currently missing items.
- 飞书 `/repair` 不再额外区分管理员和普通用户；所有通过当前机器人渠道访问策略的私聊用户都能发起修复，包括使用 `*` 开放访问的手动绑定机器人。
  Feishu `/repair` no longer defines a separate administrator role. Any direct-message user admitted by the current bot's channel access policy can start repair, including manually bound bots configured with `*` access.
- 飞书私聊重复发送普通 `/repair` 时会作废仍在等待授权的旧一次性链接并生成新链接，避免错误账号打开链接后继续复用已消耗的授权码；查询、二维码、验证和取消命令不会意外重启流程，已提交的平台更新也不会并发执行。
  Repeating bare `/repair` in a Feishu direct chat now invalidates a still-pending one-time authorization link and generates a fresh one, avoiding reuse after the link was opened under the wrong account. Status, QR, verify, and cancel commands do not restart the flow, and a platform update that has already been submitted is never duplicated concurrently.

## [2.3.0] - 2026-08-25

### Added / 新增

- 九种内置聊天渠道新增私聊批量输入命令：使用 `/batch` 暂存最多 10 条纯文字消息，使用 `/send` 按原顺序合并为一次 Harness 输入，或使用 `/cancel` 放弃当前批次；提交失败时会保留内容以便重试。
  Added private-chat batch input commands to all nine built-in chat channels: `/batch` collects up to 10 text-only messages, `/send` submits them in order as one Harness input, and `/cancel` discards the batch; failed submissions retain their content for retry.

## [2.2.1] - 2026-08-25

### Fixed / 修复

- WhatsApp 开放响应模式现在会处理已绑定账号自己在群聊中发出的消息，包括只有自己的群；出站文本消息会在发送前预留消息 ID，避免机器人回复的本地回显再次触发 Harness。
  WhatsApp Open responses now handles group messages sent by the linked account, including owner-only groups; outbound text message IDs are reserved before sending so local reply echoes cannot trigger Harness again.

## [2.2.0] - 2026-08-25

### Added / 新增

- 所有聊天渠道新增 `/reasoninglist`、`/reasonings` 和 `/reasoning` 命令，可查看当前模型支持的推理等级、切换指定等级或恢复模型默认值；`/model` 也支持在切换模型时同时指定推理等级。
  Added `/reasoninglist`, `/reasonings`, and `/reasoning` commands across all chat channels for listing the current model's reasoning efforts, selecting an effort, or restoring the model default; `/model` can also select a reasoning effort while switching models.

### Fixed / 修复

- 当浏览器使用不兼容的回环地址访问 Web 设置页并触发 RPC 403 时，插件现在会提供保留当前端口的 `localhost` 恢复入口，避免各 IM 渠道配置页面持续请求失败。
  When an incompatible loopback address causes RPC 403 responses in the Web settings UI, the plugin now offers a `localhost` recovery link that preserves the current port, preventing persistent request failures across IM channel settings.
- 微信长回复现在在桥接层和运行时统一按腾讯 iLink 的 1,800 字符限制分段发送，避免超长回复被平台拒绝或截断。
  Long WeChat replies are now split consistently at Tencent iLink's 1,800-character limit across the bridge and runtime, preventing oversized replies from being rejected or truncated.
- Telegram Bot API 无法连接时会给出明确的代理诊断提示，并补充 Node 环境代理、`HTTPS_PROXY` 和 `NO_PROXY` 的中英文配置说明。
  Telegram Bot API connection failures now provide actionable proxy diagnostics, with bilingual setup guidance for Node environment proxy support, `HTTPS_PROXY`, and `NO_PROXY`.

## [2.1.0] - 2026-08-24

### Added / 新增

- 飞书 `/m` 菜单升级为交互式助手中心，集中提供会话、工作区、Agent Preset 和模型下拉切换，以及新会话、任务停止、上下文压缩、补充指令、关注管理和归档显示控制。
  The Feishu `/m` menu is now an interactive assistant center with dropdowns for sessions, workspaces, Agent Presets, and models, plus controls for new sessions, task stopping, context compaction, steering, watch management, and archived-session visibility.

### Changed / 变更

- 飞书菜单按设置、会话和任务控制重新组织；`/m` 会发送一张新菜单卡片，卡片内的导航和配置操作会尽量原位刷新，减少聊天中的重复卡片。
  The Feishu menu is reorganized around settings, sessions, and task controls; `/m` sends a new menu card, while navigation and configuration actions refresh it in place whenever possible to reduce duplicate cards in chat.

### Fixed / 修复

- 加固飞书卡片回调的字段兼容、串行执行、重试去重、并发上限和超时降级，避免快速或重复点击造成重复操作、状态错乱或 Host 请求堆积。
  Hardened Feishu card callbacks with payload compatibility, serialized execution, retry deduplication, concurrency limits, and timeout fallbacks, preventing rapid or repeated clicks from duplicating actions, corrupting state, or exhausting Host requests.
- 改进飞书 Session 关注完成事件的基线、重连补偿和并发处理，避免错过完成通知、重复推送或阻塞无关 Session。
  Improved baselining, reconnect compensation, and concurrent handling for Feishu Session-watch completion events, preventing missed notifications, duplicate deliveries, and blocking between unrelated Sessions.
- 修复飞书 WebSocket 在握手阶段关闭时的清理竞态，并阻止任务或交互尚未结束时误建新 Session。
  Fixed the Feishu WebSocket cleanup race when closing during the handshake, and prevented new Sessions from being created while a task or interaction is still pending.

## [2.0.1] - 2026-08-24

### Fixed / 修复

- 机器人卡片的操作区域现在会在空间不足时自动换行，避免英文或其他较长本地化文案把操作按钮挤出可视区域。
  Bot-card actions now wrap when space is limited, preventing English or other longer localized labels from pushing actions out of view.
- 一个 IM 渠道激活失败时，Host 现在会记录错误并继续依次激活其他渠道，避免单个渠道的本地配置或初始化故障阻断其余渠道。
  When one IM channel fails to activate, the Host now logs the error and continues activating the remaining channels in order, so a channel-local configuration or initialization failure cannot block the others.

## [2.0.0] - 2026-08-24

### Added / 新增

- Discord 服务器文字和公告频道首次 @ 机器人后会创建原生 Thread；后续消息、流式回答和结果文件都留在该 Thread，并在重启、事件重放和并发创建时保持同一会话。
  The first bot mention in a Discord server text or announcement channel now creates a native Thread; follow-up messages, streamed replies, and result files stay in that Thread, with stable routing across restarts, event replays, and concurrent creation attempts.
- Telegram 新增原生 Rich Message：私聊使用可更新 Draft 并持久化唯一最终消息，群聊和 Topic 原位完成占位消息，同时保留 Markdown 结构、长内容拆分和确定性纯文本降级。
  Added native Telegram Rich Messages: private chats update a Draft and persist one final message, while groups and Topics finalize their placeholder in place, preserving Markdown structure, long-content splitting, and deterministic plain-text fallback.
- 新增机器人聊天消息的英文支持：Host 配置 `language: en`（或环境变量 `DSH_IM_LANGUAGE=en`）后，各渠道发送给用户的提示、命令帮助和交互消息会切换为英文；未设置或未收录的文案仍以中文原样输出，不影响现有中文用户。
  Added English support for bot chat messages: with `language: en` in the Host config (or the `DSH_IM_LANGUAGE=en` environment variable), prompts, command help, and interaction messages sent by every channel switch to English; unset or untranslated text is still sent verbatim in Chinese, so existing Chinese users are unaffected.

### Changed / 变更

- **重大变更：** Discord 服务器父频道中的任务现在默认迁移到机器人创建的 Public Thread。部署方需要启用 **Message Content Intent**，并授予 **Create Public Threads**、**Send Messages in Threads**、**Send Messages** 和 **Read Message History**；文件交付还需要 **Attach Files**。
  **Breaking:** Discord tasks started in server parent channels now move into bot-created Public Threads by default. Deployments must enable **Message Content Intent** and grant **Create Public Threads**, **Send Messages in Threads**, **Send Messages**, and **Read Message History**; file delivery also requires **Attach Files**.
- Harness 助手增量和最终回答现在保留 Markdown 呈现意图，Telegram 交付回执会记录 Rich、纯文本降级、失败或不确定终态，并避免重复最终消息。
  Harness assistant updates and final replies now preserve Markdown presentation intent; Telegram delivery receipts record Rich delivery, plain-text fallback, failure, or uncertain terminal outcomes without duplicating final messages.
- 统一各渠道共用的英文文案到共享词典，消除同名键在不同渠道词典中的重复定义。
  Consolidated English copy shared across channels into the shared dictionaries, removing duplicate keys that were defined in multiple channel dictionaries.

### Fixed / 修复

- 最终文本交付明确失败时会向渠道上层报告安全错误，同时仍然完成已登记结果文件的交付，不会重复运行 Prompt。
  Definite final-text delivery failures now surface a safe channel-level error while registered result files still settle, without rerunning the Prompt.
- 收紧 Host 语言值识别并修复 Discord、Slack、Telegram 等渠道的英文消息边界，未知语言继续可靠回退为中文。
  Hardened Host language-value recognition and English-message handling in Discord, Slack, Telegram, and other channels, while unknown languages continue to fall back reliably to Chinese.

## [1.5.0] - 2026-08-24

### Added / 新增

- Harness 返回的图片现在会在九个内置 IM 渠道中优先使用原生图片消息呈现；渠道不支持或明确拒绝图片发送时自动回退为文件附件。
  Images returned by Harness now prefer native image messages across all nine built-in IM channels, with automatic file-attachment fallback when a channel does not support or definitively rejects image delivery.

### Changed / 变更

- 统一结果文件与图片的发送、交付回执、失败提示和资源释放，并在发送结果不确定时避免补发文件造成重复消息。
  Unified result-file and image sending, delivery receipts, failure notices, and resource cleanup, while avoiding duplicate file fallback when an image delivery result is uncertain.

## [1.4.0] - 2026-08-24

### Added / 新增

- QQ 最终回答现在支持 Markdown；长回答会尽量按代码块和 GFM 表格边界切分，平台拒绝 Markdown 时自动回退为纯文本。
  QQ final answers now support Markdown; long answers are split around code blocks and GFM tables where possible, with automatic plain-text fallback when QQ rejects Markdown.

### Changed / 变更

- QQ 私聊把进度和最终答案收束在一个回复气泡中，群聊只发送最终答案；工具失败会附在最终回答中，避免成功工具和状态消息刷屏。
  QQ private chats keep progress and the final answer in one reply bubble, while group chats send only the final answer; tool failures are appended to the final response without spamming successful tool or status messages.
- 长 QQ 回答使用唯一消息序号并避开被动回复额度，降低重复去重和超额发送失败。
  Long QQ answers use unique message sequence numbers and avoid passive-reply quotas, reducing duplicate suppression and over-quota delivery failures.

## [1.3.0] - 2026-08-23

### Added / 新增

- 九个内置 IM 渠道现在都能接收普通文件，并把文件随同用户消息安全地交给当前 Harness Session。
  All nine built-in IM channels can now receive ordinary files and safely pass them with the user message to the active Harness Session.

### Changed / 变更

- 统一入站文件的提前下载、工作区暂存、路径保护、失败提示和 Turn 结束清理，并继续由各消息平台决定文件类型、数量和大小限制。
  Unified inbound-file prefetching, workspace staging, path protection, failure messages, and end-of-Turn cleanup, while leaving file type, count, and size limits to each messaging platform.

## [1.2.0] - 2026-08-23

### Added / 新增

- WhatsApp 新增仅自己、指定联系人和开放响应三种访问模式；旧机器人和新接入机器人均默认仅响应账号自聊。
  Added Only me, Selected contacts, and Open responses access modes for WhatsApp; existing and newly linked bots now default to self-chat only.

## [1.1.0] - 2026-08-23

### Added / 新增

- 新增 Harness 结果文件的原生交付能力，支持通过钉钉、Discord、飞书、QQ、Slack、Telegram、企业微信、微信和 WhatsApp 返回文件。
  Added native delivery of Harness result files through DingTalk, Discord, Feishu, QQ, Slack, Telegram, WeCom, Weixin, and WhatsApp.
- 新增统一的结果文件快照、交付回执、失败分类与消息 ID 追踪。
  Added unified result-file snapshots, delivery receipts, failure classifications, and message ID tracking.

### Changed / 变更

- 压缩机器人连接元数据布局，并统一各频道卡片的反馈样式。
  Compacted bot connection metadata and unified feedback styling across channel cards.
- 将 Agent Preset 使用说明移入可访问的帮助提示。
  Moved Agent Preset guidance into an accessible help tooltip.

### Fixed / 修复

- 改进微信对 Harness 访问失败、回环地址拒绝和健康检查错误的提示。
  Improved Weixin messages for Harness access failures, loopback denials, and health-check errors.

## [1.0.2] - 2026-08-22

### Fixed / 修复

- 飞书 REST 请求和 WebSocket 连接现在都会遵循系统代理设置。
  Feishu REST requests and WebSocket connections now honor system proxy settings.

## [1.0.1] - 2026-08-22

### Fixed / 修复

- 改进微信对 Harness 健康检查失败的分类和安全提示。
  Improved the classification and safe messaging of Harness health-check failures in Weixin.

## [1.0.0] - 2026-08-22

### Added / 新增

- 新增 `/presetlist` 与 `/preset` 聊天命令，可查看和切换 Agent Preset，并支持恢复跟随 Host 默认值。
  Added `/presetlist` and `/preset` chat commands for viewing and switching Agent Presets, including returning to the Host default.

## [0.19.0] - 2026-08-22

### Added / 新增

- Telegram 启动时注册命令菜单和菜单按钮。
  Telegram now registers its command menu and menu button when the bot starts.
- 飞书新增群聊响应模式配置和群消息权限授权流程。
  Added configurable group response modes and group-message permission authorization for Feishu.

## [0.18.0] - 2026-08-22

### Added / 新增

- 支持为每个机器人独立选择 Agent Preset，并完成创建、持久化和会话启动生命周期。
  Added per-bot Agent Preset selection across bot creation, persistence, and session startup.

## [0.17.1] - 2026-08-21

### Fixed / 修复

- 当模型不支持图片输入时，各频道会返回更明确的提示。
  Channels now provide clearer feedback when a model does not support image input.

## [0.17.0] - 2026-08-21

### Added / 新增

- 飞书新增持久化 Session 关注、完成推送和菜单入口。
  Added persistent Session watches, completion notifications, and a watch menu entry for Feishu.
- 飞书 Session 列表支持关注按钮、归档标记和 `/archived on|off` 切换。
  Feishu Session lists now include watch buttons, archived badges, and the `/archived on|off` toggle.

### Fixed / 修复

- 改进飞书关注完成消息的可靠交付和重连补偿。
  Improved reliable delivery and reconnect compensation for Feishu watch completions.

## [0.16.0] - 2026-08-21

### Added / 新增

- 飞书新增交互式菜单卡片、Session/工作区列表卡片和一键回调修复。
  Added interactive menu cards, Session and workspace list cards, and one-click callback repair for Feishu.

### Fixed / 修复

- 改进飞书交互卡片回调的可靠性。
  Improved the reliability of Feishu interactive-card callbacks.

## [0.15.0] - 2026-08-21

### Changed / 变更

- 将 AI Office 连接器标记为实验性功能。
  Marked the AI Office connector as experimental.

### Fixed / 修复

- 改进微信机器人激活失败的分类和提示。
  Improved classification and messaging for Weixin bot activation failures.

## [0.14.0] - 2026-08-21

### Added / 新增

- 新增 AI Office 连接器，并支持在 Harness 中执行 Office 任务。
  Added the AI Office connector and support for executing Office jobs in Harness.
- 加强 Telegram 私聊访问控制。
  Strengthened access control for Telegram private chats.

### Changed / 变更

- 更新插件品牌、README 视觉和 AI Office 配置示例。
  Updated plugin branding, README visuals, and the AI Office configuration example.

## [0.13.0] - 2026-08-20

### Added / 新增

- 支持通过编号选择模型。
  Added model selection by list number.

### Changed / 变更

- 完善机器人交互、多机器人能力和频道配置文档。
  Expanded documentation for bot interactions, multi-bot support, and channel setup.
- 加强发布包检查，避免捆绑 DSH 运行时包。
  Strengthened package verification to prevent bundling DSH runtime packages.

## [0.12.0] - 2026-08-20

### Added / 新增

- 新增模型查看、模型切换、停止和引导当前 Turn 的聊天命令。
  Added chat commands for listing and switching models, stopping work, and steering the active Turn.

### Changed / 变更

- 改进 npm 安装文档、包元数据和项目徽章。
  Improved npm installation documentation, package metadata, and project badges.

## [0.11.0] - 2026-08-19

### Added / 新增

- 建立统一 IM 插件的首个保留标签版本，集中管理飞书、微信、钉钉、企业微信、QQ、Slack、Telegram、Discord 和 WhatsApp。
  Established the first retained tag of the unified IM plugin, covering Feishu, Weixin, DingTalk, WeCom, QQ, Slack, Telegram, Discord, and WhatsApp.
- 支持多机器人、工作区切换、Session 列表与绑定、Harness 交互和审批、图片输入及连接测试。
  Added multi-bot support, workspace switching, Session listing and binding, Harness interactions and approvals, image input, and connection tests.
- 支持按 Harness 默认 Agent Preset 创建 IM Session。
  Added IM Session creation using the Harness default Agent Preset.

### Changed / 变更

- 完成双语 README、插件品牌、深色主题和紧凑机器人卡片。
  Added a bilingual README, plugin branding, dark-theme support, and compact bot cards.
- 改进 npm 发布包结构，保留 CLI 入口并避免安装脚本拦截。
  Improved npm package contents to preserve the CLI entry point and avoid install-script blocking.

[Unreleased]: https://github.com/xmanrui/dsh-im/compare/v4.20.0...HEAD
[4.20.0]: https://github.com/xmanrui/dsh-im/compare/v4.19.2...v4.20.0
[4.19.2]: https://github.com/xmanrui/dsh-im/compare/v4.19.1...v4.19.2
[4.19.1]: https://github.com/xmanrui/dsh-im/compare/v4.19.0...v4.19.1
[4.19.0]: https://github.com/xmanrui/dsh-im/compare/v4.18.1...v4.19.0
[4.18.1]: https://github.com/xmanrui/dsh-im/compare/v4.18.0...v4.18.1
[4.18.0]: https://github.com/xmanrui/dsh-im/compare/v4.17.1...v4.18.0
[4.17.1]: https://github.com/xmanrui/dsh-im/compare/v4.17.0...v4.17.1
[4.17.0]: https://github.com/xmanrui/dsh-im/compare/v4.16.1...v4.17.0
[4.16.1]: https://github.com/xmanrui/dsh-im/compare/v4.16.0...v4.16.1
[4.16.0]: https://github.com/xmanrui/dsh-im/compare/v4.15.0...v4.16.0
[4.15.0]: https://github.com/xmanrui/dsh-im/compare/v4.14.0...v4.15.0
[4.14.0]: https://github.com/xmanrui/dsh-im/compare/v4.13.0...v4.14.0
[4.13.0]: https://github.com/xmanrui/dsh-im/compare/v4.12.0...v4.13.0
[4.12.0]: https://github.com/xmanrui/dsh-im/compare/v4.11.0...v4.12.0
[4.11.0]: https://github.com/xmanrui/dsh-im/compare/v4.10.0...v4.11.0
[4.10.0]: https://github.com/xmanrui/dsh-im/compare/v4.9.1...v4.10.0
[4.9.1]: https://github.com/xmanrui/dsh-im/compare/v4.9.0...v4.9.1
[4.9.0]: https://github.com/xmanrui/dsh-im/compare/v4.8.0...v4.9.0
[4.8.0]: https://github.com/xmanrui/dsh-im/compare/v4.7.0...v4.8.0
[4.7.0]: https://github.com/xmanrui/dsh-im/compare/v4.6.0...v4.7.0
[4.6.0]: https://github.com/xmanrui/dsh-im/compare/v4.5.0...v4.6.0
[4.5.0]: https://github.com/xmanrui/dsh-im/compare/v4.4.0...v4.5.0
[4.4.0]: https://github.com/xmanrui/dsh-im/compare/v4.3.0...v4.4.0
[4.3.0]: https://github.com/xmanrui/dsh-im/compare/v4.2.1...v4.3.0
[4.2.1]: https://github.com/xmanrui/dsh-im/compare/v4.2.0...v4.2.1
[4.2.0]: https://github.com/xmanrui/dsh-im/compare/v4.1.1...v4.2.0
[4.1.1]: https://github.com/xmanrui/dsh-im/compare/v4.1.0...v4.1.1
[4.1.0]: https://github.com/xmanrui/dsh-im/compare/v4.0.1...v4.1.0
[4.0.1]: https://github.com/xmanrui/dsh-im/compare/v4.0.0...v4.0.1
[4.0.0]: https://github.com/xmanrui/dsh-im/compare/v3.2.0...v4.0.0
[3.2.0]: https://github.com/xmanrui/dsh-im/compare/v3.1.1...v3.2.0
[3.1.1]: https://github.com/xmanrui/dsh-im/compare/v3.1.0...v3.1.1
[3.1.0]: https://github.com/xmanrui/dsh-im/compare/v3.0.8...v3.1.0
[3.0.8]: https://github.com/xmanrui/dsh-im/compare/v3.0.7...v3.0.8
[3.0.7]: https://github.com/xmanrui/dsh-im/compare/v3.0.6...v3.0.7
[3.0.6]: https://github.com/xmanrui/dsh-im/compare/v3.0.5...v3.0.6
[3.0.5]: https://github.com/xmanrui/dsh-im/compare/v3.0.4...v3.0.5
[3.0.4]: https://github.com/xmanrui/dsh-im/compare/v3.0.3...v3.0.4
[3.0.3]: https://github.com/xmanrui/dsh-im/compare/v3.0.2...v3.0.3
[3.0.2]: https://github.com/xmanrui/dsh-im/compare/v3.0.1...v3.0.2
[3.0.1]: https://github.com/xmanrui/dsh-im/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/xmanrui/dsh-im/compare/v2.6.0...v3.0.0
[2.6.0]: https://github.com/xmanrui/dsh-im/compare/v2.5.0...v2.6.0
[2.5.0]: https://github.com/xmanrui/dsh-im/compare/v2.4.0...v2.5.0
[2.4.0]: https://github.com/xmanrui/dsh-im/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/xmanrui/dsh-im/compare/v2.2.1...v2.3.0
[2.2.1]: https://github.com/xmanrui/dsh-im/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/xmanrui/dsh-im/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/xmanrui/dsh-im/compare/v2.0.1...v2.1.0
[2.0.1]: https://github.com/xmanrui/dsh-im/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/xmanrui/dsh-im/compare/v1.5.0...v2.0.0
[1.5.0]: https://github.com/xmanrui/dsh-im/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/xmanrui/dsh-im/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/xmanrui/dsh-im/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/xmanrui/dsh-im/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/xmanrui/dsh-im/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/xmanrui/dsh-im/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/xmanrui/dsh-im/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/xmanrui/dsh-im/compare/v0.19.0...v1.0.0
[0.19.0]: https://github.com/xmanrui/dsh-im/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/xmanrui/dsh-im/compare/v0.17.1...v0.18.0
[0.17.1]: https://github.com/xmanrui/dsh-im/compare/v0.17.0...v0.17.1
[0.17.0]: https://github.com/xmanrui/dsh-im/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/xmanrui/dsh-im/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/xmanrui/dsh-im/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/xmanrui/dsh-im/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/xmanrui/dsh-im/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/xmanrui/dsh-im/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/xmanrui/dsh-im/releases/tag/v0.11.0
