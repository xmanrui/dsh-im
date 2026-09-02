# Changelog / 更新日志

本文件记录 dsh-im 各正式版本的重要变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

This file records the notable changes in each dsh-im release. Its format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and its versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

<<<<<<< HEAD
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

=======
### Added / 新增

- 入站附件新增每机器人“保留策略”配置：`临时附件（每轮对话后自动清理）`（默认，行为不变）与 `永久附件（保留至手动删除）`。永久模式下附件保存到 Session 工作区 `.dsh-im/inbound/<yyyyMMdd-HHmmss>-<随机串>/` 中不再自动删除，可在设置卡片上切换策略并通过“清空附件目录”按钮（带二次确认）一键清理；新增聊天命令 `/attachmentlist` 列出附件、`/attachmentdelete <序号>` 删除单个附件、`/attachmentdelete all confirm` 清空附件目录。策略通过 `bot.inbound-retention.set`、清空通过 `bot.inbound-attachments.clear` RPC 保存与执行；切换策略不影响已存在的附件，临时模式下 `turn-` 残留目录也会在列表中标注并可一并清理。
  Inbound attachments now support a per-bot retention setting: `turn` (default; auto cleanup after each turn, unchanged behavior) or `forever` (files persist under the Session workspace `.dsh-im/inbound/<yyyyMMdd-HHmmss>-<random>/` until deleted manually). The policy is toggleable on each bot settings card together with a double-confirm clear-attachments action; new chat commands `/attachmentlist`, `/attachmentdelete <index>`, and `/attachmentdelete all confirm` manage attachments from IM. Saving uses the `bot.inbound-retention.set` RPC and clearing uses `bot.inbound-attachments.clear`; switching the policy never touches existing attachments, and leftover `turn-` batches are flagged in listings and clearable as well.
>>>>>>> 5c03f94 (feat(inbound): per-bot attachment retention (turn/forever), /attachment* commands and settings UI)
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

[Unreleased]: https://github.com/xmanrui/dsh-im/compare/v4.7.0...HEAD
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
