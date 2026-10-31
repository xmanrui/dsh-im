# Changelog / 更新日志

本文件记录 dsh-im 各正式版本的重要变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

This file records the notable changes in each dsh-im release. Its format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and its versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed / 修复

- 邮件线程在只引用上一封的客户端（如 iOS Mail 只带一条 `References`）里会分裂：回信的 Message-ID 由发信时生成、从未登记，解析线程时认不出它，于是把该封当成新线程另开一个 Harness 会话。现在每次回信都把发信侧 Message-ID 登记回它所回复的线程，同一封邮件的往返始终留在同一个会话里。
  A mail thread split when the client quoted only the immediate parent (iOS Mail sends a single-entry `References` header): the Message-ID of our own reply is minted on the way out and was never registered, so the thread resolver did not recognise it and opened a new Harness session for that message. Every reply we send now records its own Message-ID against the thread it answers, keeping a mail thread in one session.

- 会话开启 Goal 后，自动续跑的每一轮会在绑定的飞书对话里渲染过程卡：工具调用、流式答案和每轮结果都会推送，不再整轮静默。同一会话的群话题与同步私聊按投递位置分别去重；连接中断漏掉轮次结束、会话改绑等异常下旧轮会先收尾，不会阻塞后续轮次或串写；目标轮次的驱动提示原文（`<goal_round>`）不会外发；目标轮的 `user/message` 不带 `turn` 字段，按紧邻的 `turn/start` 归轮。方案见 `docs/方案/飞书目标自动续跑过程与结果可见方案.md`。
  Turns opened automatically by an active Goal now render into the bound Feishu conversation with the same step card an IM turn uses — tool calls, the streamed answer and each round's result are delivered instead of leaving the chat silent for the whole round. Deduplication happens per delivery surface, so a group topic keeps rendering next to a synced DM; rounds orphaned by a dropped turn-end or a conversation rebind are closed before the next round instead of blocking or writing into the wrong card; the `<goal_round>` driver prompt is never echoed. See `docs/方案/飞书目标自动续跑过程与结果可见方案.md`.

- 通用设置与插件更新统一沿用 `rpcAuthority`，修复已认证的 NAS／Docker 局域网访问被固定本机限制拒绝的问题；显式 `loopback` 仍限制本机访问。管理错误区分登录失效、访问拒绝、接口缺失与服务异常，保留现有更新确认和安装限制。（[#477](https://github.com/xmanrui/dsh-im/issues/477)）
  General settings and plugin updates now honor `rpcAuthority`, allowing authenticated, trusted LAN access on NAS/Docker deployments while retaining explicit `loopback` restrictions. Management errors distinguish authentication, access denial, missing APIs, and service failures. Existing update confirmation and installation restrictions are preserved. ([#477](https://github.com/xmanrui/dsh-im/issues/477))

## [5.9.0] - 2026-10-31

### Added / 新增

- 新增默认关闭的 `groupByAgentPreset` 选项，按明确选择的 Agent Preset 为后续新会话创建工作区分组；已有聊天、手动工作区和飞书会话隔离目录保持原路径。
  Added opt-in `groupByAgentPreset` workspace grouping for new sessions with an explicitly selected Agent Preset. Existing chats, manual workspaces and Feishu conversation directories keep their paths.

- Telegram 新增“批准一次 / 拒绝”审批按钮，仅允许任务发起人操作，处理重复点击、提交重试和过期状态；卡片不可用时回退文字审批。（[#430](https://github.com/xmanrui/dsh-im/pull/430)）
  Added Telegram approve-once/reject buttons restricted to the task initiator, with duplicate-click, retry and expiry handling and text approval fallback. ([#430](https://github.com/xmanrui/dsh-im/pull/430))
- Telegram 原生命令菜单分别注册私聊与群聊作用域，隐藏别名；`/status` 补充当前工作区、绑定会话、模型、Agent Preset 和运行任务，并限制可选信息读取的等待时间。（[#431](https://github.com/xmanrui/dsh-im/pull/431)）
  Telegram registers native command menus separately for private and group chats and hides aliases. `/status` now includes the workspace, bound session, model, Agent Preset and running-task state, with bounded waits for optional fields. ([#431](https://github.com/xmanrui/dsh-im/pull/431))
- 飞书模型卡片支持分页与推理强度选择，选择后在当前页刷新原卡片，避免大型模型列表被截断。（[#491](https://github.com/xmanrui/dsh-im/pull/491)）
  Feishu model cards support pagination and reasoning-effort selection, refreshing the current card and page without truncating large model catalogs. ([#491](https://github.com/xmanrui/dsh-im/pull/491))
- Host 新增 IM 会话身份查询（含同步查询）和绑定生命周期事件，供首条提示词及集成读取所属渠道、聊天和话题信息。（[#470](https://github.com/xmanrui/dsh-im/pull/470)）
  Added Host conversation-identity lookups, including synchronous lookup, and binding lifecycle events for first-prompt construction and channel/chat/thread-aware integrations. ([#470](https://github.com/xmanrui/dsh-im/pull/470))

### Fixed / 修复

- 邮箱 IMAP 断线后在后续轮询自动重连，旧连接事件不会清除新连接；邮件读取失败会使本次轮询失败，避免游标跳过尚未读取的邮件。（[#493](https://github.com/xmanrui/dsh-im/pull/493)）
  Email IMAP reconnects on subsequent polls after a disconnect, without letting stale connection events discard a replacement. Failed message reads fail the poll so the cursor cannot skip unread mail. ([#493](https://github.com/xmanrui/dsh-im/pull/493))
- 飞书已绑定 DS Bot 的会话通过 DS Bot API 切换模型，并补全缺失的本地会话映射与取消处理。（[#490](https://github.com/xmanrui/dsh-im/pull/490)）
  Feishu conversations bound to a DS Bot switch models through the DS Bot API, with missing local session mappings and cancellation handled correctly. ([#490](https://github.com/xmanrui/dsh-im/pull/490))
- Agent Preset 分组下的会话列表与会话切换按当前绑定会话的实际工作区解析，避免重启或更换预设后列错工作区。（[#492](https://github.com/xmanrui/dsh-im/pull/492)）
  Session lists and switching in Agent Preset groups resolve the bound session's actual workspace, including after restarts or preset changes. ([#492](https://github.com/xmanrui/dsh-im/pull/492))
- 飞书二维码生成失败时显示经过白名单筛选的本地库错误原因，便于区分编码问题，同时避免把凭据或任意异常文本写入诊断。（[#495](https://github.com/xmanrui/dsh-im/pull/495)）
  Feishu QR-generation diagnostics include allowlisted local-library failure details while excluding credentials and arbitrary exception text. ([#495](https://github.com/xmanrui/dsh-im/pull/495))
- 绑定不存在的会话 ID 时明确提示“会话不存在”，不再误导用户稍后重试。（[#482](https://github.com/xmanrui/dsh-im/issues/482)）
  Binding an unknown session ID now reports that the session does not exist instead of suggesting a retry. ([#482](https://github.com/xmanrui/dsh-im/issues/482))

### Security / 安全

- 将构建锁中的 `follow-redirects` 从 1.16.1 更新至 1.16.2 并重新构建 Host，纳入跨 realm `sensitiveHeaders` 数组的凭据保护修复。（[GHSA-mrwp-f3q8-3g9p](https://github.com/advisories/GHSA-mrwp-f3q8-3g9p)）
  Updated build-lock `follow-redirects` from 1.16.1 to 1.16.2 and rebuilt the Host to include the credential-protection fix for cross-realm `sensitiveHeaders` arrays. ([GHSA-mrwp-f3q8-3g9p](https://github.com/advisories/GHSA-mrwp-f3q8-3g9p))

### Notes / 使用说明

- Agent Preset 分组需显式开启，仅影响后续新会话；分组共享工作区文件，不构成用户数据隔离边界。依赖声明、Node.js 要求和 DSH 兼容声明保持不变。升级后重启 Host 并刷新管理页面。
  Agent Preset grouping requires explicit opt-in and applies to subsequent new sessions. Grouped sessions share workspace files; grouping is not a user-data isolation boundary. Dependency declarations, Node.js requirements and DSH compatibility declarations are unchanged. Restart the Host and refresh management pages after upgrading.

## [5.8.0] - 2026-10-30

### Added / 新增

- 飞书新增会话目录隔离，支持每个对话固定目录或每次新会话创建新目录，可设置渠道默认、单机器人覆盖及目录前缀。目录直接创建在基工作区下，默认关闭；开启后禁止手动切换工作区，工作区列表默认隐藏隔离目录，使用 `/wsl all` 可查看全部。（[#422](https://github.com/xmanrui/dsh-im/pull/422)、[#481](https://github.com/xmanrui/dsh-im/pull/481)）
  Added opt-in Feishu conversation directories, with a fixed directory per conversation or a new directory per session, channel defaults, per-bot overrides, and configurable prefixes. Directories are created directly under the base workspace. Manual workspace switching is disabled while enabled; workspace lists hide these directories by default, with `/wsl all` showing all entries. ([#422](https://github.com/xmanrui/dsh-im/pull/422), [#481](https://github.com/xmanrui/dsh-im/pull/481))

### Fixed / 修复

- 飞书引用消息中的文件现在通过正常附件流程下载并交给会话处理；话题根消息与工作区重试保留附件引用，避免重复附加或重复下载文件。（[#353](https://github.com/xmanrui/dsh-im/issues/353)）
  Files quoted in Feishu messages now pass through the normal inbound attachment pipeline. Topic-root handling and workspace retries preserve attachment references without adding or downloading the same quoted files repeatedly. ([#353](https://github.com/xmanrui/dsh-im/issues/353))

- `session.prompt` 提交超时（30 秒窗口到期）不再直接判定消息失败：客户端会按本次请求的 RPC ID 回查 `session.history` 持久账本，确认消息已入库（含已入队、尚未开始执行的状态）则继续等待回复，取消请求也优先于超时定性；仅当确认不到时才上报失败，并把「提交请求超时、是否送达未知」与「已提交、结果未知」的提示文案区分开。修复 Host 繁忙时每条消息先收到「已尝试提交，但任务结果尚未确认」误报、正常回复随后照达的问题。
  A `session.prompt` submission timeout no longer fails the message outright: the client re-checks the durable `session.history` ledger by this request's RPC ID and keeps waiting for the reply once the message is confirmed as recorded (including the queued-but-not-yet-executing state), with cancellation taking precedence over the timeout; a failure is reported only when the message cannot be confirmed, with distinct wording for "submission request timed out, delivery unknown" versus "submitted, outcome unconfirmed". This fixes the false "submission attempted but unconfirmed" notice that appeared before every normal reply while the Host was busy.

### Notes / 使用说明

- 会话目录设置对新会话生效；发送 `/new` 使用新设置，已有会话和旧目录中的文件保留。依赖声明、Node.js 要求及 DSH 兼容声明保持不变。升级后重启 Host 并刷新管理页面。
  Conversation directory settings apply to new sessions. Send `/new` to use updated settings; existing sessions and files in old directories are retained. Dependency declarations, Node.js requirements, and DSH compatibility declarations are unchanged. Restart the Host and refresh management pages after upgrading.

## [5.7.0] - 2026-10-28

### Added / 新增

- 投递目标设置支持邮箱渠道，可显式填写收件人地址；不会把邮箱会话的 Message-ID 或 Session ID 当作地址自动生成目标。（[#451](https://github.com/xmanrui/dsh-im/pull/451)）
  Delivery target settings now support email with an explicit recipient address. Email Message-IDs and Session IDs are not treated as recipient addresses for automatic target suggestions. ([#451](https://github.com/xmanrui/dsh-im/pull/451))

### Fixed / 修复

- 飞书停止运行时，为桥接层空闲等待设置 2 秒上限，避免未结束任务无限阻塞后续清理。（[#465](https://github.com/xmanrui/dsh-im/pull/465)）
  Feishu shutdown now limits the bridge idle wait to 2 seconds so unfinished tasks cannot block subsequent cleanup indefinitely. ([#465](https://github.com/xmanrui/dsh-im/pull/465))
- 修复带渠道图标的会话标题在滚动展示时仍被预先截断的问题，使长标题能够完整展示。（[#455](https://github.com/xmanrui/dsh-im/pull/455)）
  Fixed channel-marked session titles remaining pre-clipped during marquee scrolling, allowing the full title to become visible. ([#455](https://github.com/xmanrui/dsh-im/pull/455))
- 串行处理同路径更新状态文件的读写，Windows 原子替换遇到临时 EPERM 时有限重试并保留旧文件，避免并发状态查询损坏更新记录；同步修正跨平台测试基线。（[#456](https://github.com/xmanrui/dsh-im/pull/456)）
  Serialized update-state reads and writes per path, with bounded retries for transient Windows EPERM during atomic replacement while preserving the old file. Concurrent status reads no longer disrupt update journals; cross-platform test baselines were also corrected. ([#456](https://github.com/xmanrui/dsh-im/pull/456))

- 企业微信机器人被服务端断开后，若「正在连接」连续超过 2 分钟无状态更新，则自动重启连接；存活不足 5 分钟即再次掉线的连接与启动失败按 bot 共享 1–10 分钟指数退避，连接持续稳定 5 分钟后清零。正常 SDK 重连不受影响，手动重连始终立即执行。（[#420](https://github.com/xmanrui/dsh-im/pull/420)）
  WeCom bots recover automatically when a server-side disconnect leaves them in "connecting" without a state update for over 2 minutes. Connections that drop again within 5 minutes and failed starts share per-bot exponential backoff from 1 to 10 minutes, cleared after 5 minutes of stable connectivity. Active SDK retries are unchanged, and manual reconnects remain immediate. ([#420](https://github.com/xmanrui/dsh-im/pull/420))

- QQ 回复超时后迟到的结果改为在 QQ 被动回复窗口内（私聊 60 分钟、群 5 分钟，各留 30 秒余量）带原消息 `msg_id` 被动回复，不再一律走常被平台拒绝的主动消息；超时提示已占用的一次被动额度会计入。窗口外或平台明确拒绝被动回复时，回退为一次主动发送。
  A late QQ result after a reply timeout is now sent as a passive reply to the original `msg_id` while QQ's window is open (C2C 60 min, group 5 min, each minus a 30 s margin), instead of always going out as a proactive message that QQ often refuses. The passive slot used by the timeout notice is counted. Outside the window, or when QQ definitely refuses the passive reply, it falls back to one proactive send.

- Slack 流式定稿在追加失败或最终文本被重写时，改用 `chat.update` 的 `markdown_text`，不再以 `parse: none` 发送原始 GFM。Markdown block 被拒绝时先重试 `markdown_text`；只有 Markdown 本身被拒绝时才按字面文本发送，避免把 `**` 和表格当成 mrkdwn。（[#466](https://github.com/xmanrui/dsh-im/issues/466)）
  Slack stream finalization now updates with `markdown_text` when appending fails or the final text is rewritten, instead of sending raw GFM with `parse: none`. A rejected Markdown block retries `markdown_text`; literal text is used only when the Markdown itself is rejected, so `**` and tables are not parsed as mrkdwn. ([#466](https://github.com/xmanrui/dsh-im/issues/466))

### Security / 安全

- 更新构建锁中的 qs 从 6.16.0 至 6.17.0 并重新构建 Host，纳入逗号数组序列化触发未捕获异常的修复（[GHSA-6pq8-jhm2-2vcw](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw)）。
  Updated build-lock qs from 6.16.0 to 6.17.0 and rebuilt the Host to include the fix for uncaught exceptions during comma-array serialization ([GHSA-6pq8-jhm2-2vcw](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw)).

### Notes / 使用说明

- 中英文 README 新增赞助展示。依赖声明、Node.js 要求及 DSH 兼容声明保持不变；升级后重启 Host 并刷新管理页面。
  Added sponsor information to the Chinese and English READMEs. Dependency declarations, Node.js requirements, and DSH compatibility declarations remain unchanged. Restart the Host and refresh management pages after upgrading.

## [5.6.0] - 2026-10-24

### Added / 新增

- Telegram 的 `/ws`（`/workspace`）无参数时显示工作区切换卡片，点击按钮即可切换并更新当前项；保留带序号或绝对路径的直接切换，以及 `/wsl`、`/workspaces`、`/workspacelist` 文本别名。过期卡片与重复点击安全处理，工作区列表变更时不会按旧序号误切，卡片不可用时回退文字列表。（[#432](https://github.com/xmanrui/dsh-im/pull/432)）
  Telegram `/ws` (`/workspace`) without arguments now shows an inline workspace picker. Buttons switch workspaces and update the current selection; direct index/path switching and the `/wsl`, `/workspaces`, and `/workspacelist` aliases remain supported. Stale cards and duplicate clicks are handled safely, changed lists cannot redirect old indices, and unavailable cards fall back to text. ([#432](https://github.com/xmanrui/dsh-im/pull/432))
- Telegram 投递失败或结果不确定时，将用户提示中的 `MF-…` 编号与发送尝试、分片回执、失败正文写入同一条本地日志，保留富文本回退及过程消息的投递证据，便于定位未送达内容。（[#442](https://github.com/xmanrui/dsh-im/pull/442)）
  Telegram failed or unconfirmed deliveries now log the user-visible `MF-…` reference alongside send attempts, part acknowledgments, and undelivered text, retaining rich-text fallback and thinking-stream evidence for diagnosis. ([#442](https://github.com/xmanrui/dsh-im/pull/442))

### Fixed / 修复

- 确认普通绑定会话的日志损坏且消息尚未提交时，自动切换到新会话并提示后继续本条消息，最多恢复一次；保留原会话，不自动迁移历史上下文，不将归档、权限、临时故障或提交状态不确定的情况误判为损坏，也不替换 DS Bot 会话。（[#445](https://github.com/xmanrui/dsh-im/pull/445)）
  Confirmed corrupt logs in ordinary bound sessions can recover once into a new session before prompt submission, with a notice before continuing. Original sessions remain intact and history is not migrated. Archived, inaccessible, transient, uncertain-submission, and DS Bot session failures do not trigger this replacement. ([#445](https://github.com/xmanrui/dsh-im/pull/445))
- 修复运行时拼接文案仅显示英文或翻译不完整的问题，完善渠道状态、凭据绑定及管理设置中的动态英文、俄语翻译，并补充回归覆盖。（[#443](https://github.com/xmanrui/dsh-im/pull/443)）
  Fixed incomplete or English-only runtime-composed messages, improving dynamic English and Russian localization across channel status, credential binding, and management settings with regression coverage. ([#443](https://github.com/xmanrui/dsh-im/pull/443))
- 管理界面统一使用“绑定 DS Bot”等明确标签，避免与 IM 渠道机器人混淆。
  Clarified DS Bot binding labels in management settings to distinguish DS Bot from IM channel bots.
- 修复飞书私聊发起 DS Bot 提问后，回合收尾误取消新问题卡、点击提示“已在其他客户端处理”的问题；同步问题按自身生命周期结束，撤回时同步释放投递状态，保留普通 Harness 问答及发送失败时的取消清理。（[#447](https://github.com/xmanrui/dsh-im/issues/447)）
  Fixed Feishu-initiated DS Bot questions being cancelled by turn cleanup immediately after delivery. Synced questions now retain their own lifetime and release upstream delivery state on withdrawal, while ordinary Harness questions and failed-delivery cancellation retain their existing cleanup. ([#447](https://github.com/xmanrui/dsh-im/issues/447))

### Security / 安全

- Undici 更新到 7.30.1，Nodemailer 最低版本提高至 10.1.4，Mailparser 最低版本提高至 3.9.43，纳入上游 HTTP 响应处理及邮件地址解析安全修复。（[Undici 公告](https://github.com/advisories/GHSA-xjj6-f33q-929c)、[Nodemailer 公告](https://github.com/advisories/GHSA-8c8m-p3m8-cjg8)）
  Updated Undici to 7.30.1 and raised minimum versions to Nodemailer 10.1.4 and Mailparser 3.9.43, incorporating upstream HTTP response handling and email address parsing security fixes. ([Undici advisory](https://github.com/advisories/GHSA-xjj6-f33q-929c), [Nodemailer advisory](https://github.com/advisories/GHSA-8c8m-p3m8-cjg8))

### Notes / 使用说明

- Telegram 失败投递日志可能包含未送达的消息正文、聊天和话题标识；分享日志前请检查并脱敏。日志中的平台错误说明会过滤匹配的 Bot Token URL，但消息正文按原样记录。
  Telegram delivery-failure logs can contain undelivered message text and chat/topic identifiers. Review and redact logs before sharing. Matching bot-token URLs are scrubbed from provider error descriptions, while message text is retained verbatim.
- Node.js 要求及 DSH 兼容声明保持不变。升级后重启 Host 并刷新管理页面。感谢 [@wings1848](https://github.com/wings1848) 的工作区卡片贡献和 [@unera](https://github.com/unera) 的翻译及投递诊断改进。
  Node.js requirements and DSH compatibility declarations are unchanged. Restart the Host and refresh management pages after upgrading. Thanks to [@wings1848](https://github.com/wings1848) for workspace cards and [@unera](https://github.com/unera) for localization and delivery diagnostics.

## [5.5.0] - 2026-10-24

### Added / 新增

- Telegram 支持通过 Host 的 `speechToText` 服务转写语音及音频附件，再将转写文本交给会话处理；规范 WAV 可直接使用，其他格式通过本机 ffmpeg 转换。未配置服务、未选择提供方或转写失败时保留无文本语音提示，不虚构转写内容。（[#405](https://github.com/xmanrui/dsh-im/pull/405)）
  Telegram can transcribe voice and audio attachments through the Host's `speechToText` service and pass the transcript to the conversation. Canonical WAV is used directly; other formats are converted with local ffmpeg. Missing services, unselected providers, and transcription failures retain a textless-voice notice without inventing a transcript. ([#405](https://github.com/xmanrui/dsh-im/pull/405))

- Telegram 新增逐聊天发送预算，默认每分钟 15 条，可配置为 1–30 条；新消息等待可用额度，编辑、草稿、输入状态及表情不占用该队列。发送遇到 429 时按 `retry_after` 有限重试，最终无法投递时明确报告失败。（[#423](https://github.com/xmanrui/dsh-im/pull/423)）
  Added a per-chat Telegram send budget, defaulting to 15 new messages per minute and configurable from 1 to 30. New sends wait for capacity; edits, drafts, typing actions, and reactions bypass that queue. Sends receiving 429 use bounded `retry_after` retries and report failure if delivery cannot complete. ([#423](https://github.com/xmanrui/dsh-im/pull/423))

- Telegram 过程消息支持 0–60 秒发送间隔和可选编号，窗口内合并为最新进度，结束时先处理待发进度再发送答案；进度占位消息也显示编号，取消后清理待发帧与定时器。默认不节流、不编号。（[#425](https://github.com/xmanrui/dsh-im/pull/425)、[#426](https://github.com/xmanrui/dsh-im/pull/426)）
  Telegram thinking traces support a 0–60-second cadence and optional numbering. Bursts coalesce to the latest progress, pending progress settles before the final answer, and placeholder progress is numbered too. Cancellation clears pending frames and timers. Pacing and numbering are off by default. ([#425](https://github.com/xmanrui/dsh-im/pull/425), [#426](https://github.com/xmanrui/dsh-im/pull/426))

- 新增 Host 消息与设置界面的俄语翻译、客户端俄语语言包及翻译覆盖检查；中文语言标签继续使用中文，俄语使用俄语，其余语言回退到英文，俄语缺失条目先回退英文。（[#438](https://github.com/xmanrui/dsh-im/pull/438)、[#439](https://github.com/xmanrui/dsh-im/pull/439)、[#440](https://github.com/xmanrui/dsh-im/pull/440)）
  Added Russian Host messages, settings translations, a client language pack, and dictionary coverage checks. Chinese locale tags retain Chinese, Russian selects Russian, and other locales fall back to English; missing Russian entries fall back to English first. ([#438](https://github.com/xmanrui/dsh-im/pull/438), [#439](https://github.com/xmanrui/dsh-im/pull/439), [#440](https://github.com/xmanrui/dsh-im/pull/440))

- 同 Host 插件服务 `dshIm` 新增 `createTarget(botId, target)`，消费插件可把已知的会话路由注册成投递目标，注册后即可用 `targetId` 投递并出现在设置页目标列表；已存在的 `targetId` 以 `target-conflict` 拒绝。
  The same-Host `dshIm` service now exposes `createTarget(botId, target)`, so a consumer plugin can register a known conversation route as a delivery target; the target is then addressable by `targetId` and listed in the settings panel. An existing `targetId` is rejected with `target-conflict`.

### Fixed / 修复

- 修复绑定 DS Bot 的飞书私聊提问与回答续跑同步，支持 Host 提问及 DS Bot 的待回答卡片，重启后恢复未答问题；桌面端和 IM 端先答者生效，绑定不明确时提示回到桌面回答。（[#428](https://github.com/xmanrui/dsh-im/pull/428)）
  Fixed question delivery and answer continuation for Feishu private chats bound to DS Bot, including Host questions and pending DS Bot cards recovered after restart. The first desktop or IM answer wins; ambiguous bindings ask the user to answer on the desktop. ([#428](https://github.com/xmanrui/dsh-im/pull/428))
- Telegram 最终答案独立发送，不再只编辑进度占位消息，并在回合结束后清理状态表情；避免最终答案缺少新消息通知及遗留处理中标记。（[#412](https://github.com/xmanrui/dsh-im/pull/412)、[#414](https://github.com/xmanrui/dsh-im/pull/414)）
  Telegram sends final answers as separate messages instead of only editing progress placeholders, and clears status reactions after a turn finishes, avoiding missing new-message notifications and stale processing indicators. ([#412](https://github.com/xmanrui/dsh-im/pull/412), [#414](https://github.com/xmanrui/dsh-im/pull/414))
- 统一识别不同 Host 的缺失会话错误码，恢复失效会话绑定并改进相关命令的错误提示；不将权限错误误判为会话缺失。（[#444](https://github.com/xmanrui/dsh-im/pull/444)）
  Recognize missing-session errors across Host error codes, recover stale session bindings, and improve related command guidance without treating permission failures as missing sessions. ([#444](https://github.com/xmanrui/dsh-im/pull/444))

### Security / 安全

- 将构建锁中的 ip-address 从 10.7.2 更新到 10.7.4，并重新生成 Host 产物，纳入 IPv6 地址解析可能阻塞进程的修复（[GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5)）。保留旧间接依赖锁的已有安装仍需刷新依赖解析。
  Updated build-lock ip-address from 10.7.2 to 10.7.4 and rebuilt the Host artifact with the IPv6 parsing denial-of-service fix ([GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5)). Existing installations retaining old transitive dependency locks must refresh their resolution.

### Notes / 使用说明

- Telegram 语音转写需安装并配置 Host 的语音识别服务，非规范 WAV 转换需本机可用的 ffmpeg；本包不会自动安装 ffmpeg。发送预算是本地节流，不保证完全避免 Telegram 服务端限流。
  Telegram transcription requires a configured Host speech-to-text service; noncanonical WAV conversion requires locally available ffmpeg, which this package does not install. The send budget is local pacing, not a guarantee against Telegram server-side limits.
- 完善完整包名与 Desktop/Web 安装说明。依赖声明、Node.js 要求和 DSH 兼容声明保持不变；升级后重启 Host 并刷新管理页面。
  Clarified the full package name and Desktop/Web installation instructions. Dependency declarations, Node.js requirements, and DSH compatibility declarations are unchanged. Restart the Host and refresh the management page after upgrading.
- 感谢 [@unera](https://github.com/unera) 的 Telegram、俄语及测试贡献，以及 [@wanchun](https://github.com/wanchun) 的 `createTarget` 服务扩展。
  Thanks to [@unera](https://github.com/unera) for Telegram, Russian localization, and test contributions, and [@wanchun](https://github.com/wanchun) for the `createTarget` service extension.

## [5.4.0] - 2026-10-21

### Added / 新增

- 新增独立于投递目标设置的 DS Bot 私聊绑定：已有 IM 私聊可绑定到当前 Host 的 DS Bot，会话随 Bot 切换并同步到桌面；解绑后释放双方占用，保留原有普通会话同步设置。绑定选择器过滤已占用的 Bot 和私聊，并处理并发冲突、会话切换及旧数据迁移。（[#410](https://github.com/xmanrui/dsh-im/pull/410)、[#411](https://github.com/xmanrui/dsh-im/pull/411)）
  Added DS Bot private-chat bindings independent of delivery targets. Existing IM private chats can follow a DS Bot session on the current Host and sync to the desktop. Unbinding releases both sides while preserving ordinary session-sync preferences. Selectors exclude occupied bots and chats, with conflict handling, session rollover, and migration support. ([#410](https://github.com/xmanrui/dsh-im/pull/410), [#411](https://github.com/xmanrui/dsh-im/pull/411))

- Telegram 新增默认及逐群回复规则：关闭、提及或回复、名单内成员提及或回复、所有消息、名单内成员所有消息。可管理已发现的群，或通过群 ID、用户名及支持的公开链接添加群；未配置群维持原有提及或回复行为，私聊不受影响。（[#404](https://github.com/xmanrui/dsh-im/pull/404)）
  Added default and per-group Telegram reply triggers: Off, Mention/reply, Mention/reply from listed senders, All messages, and All messages from listed senders. Manage discovered groups or add groups by ID, username, or supported public links. Unconfigured groups retain mention/reply behavior; private chats are unaffected. ([#404](https://github.com/xmanrui/dsh-im/pull/404))

- 企业微信长任务在流式卡片接近十分钟窗口前自动续接新卡片，静默期间发送进度探测，连续回执拒绝时尝试更换卡片；最终结果发送到最新卡片，续接失败时回退到主动消息。（[#388](https://github.com/xmanrui/dsh-im/pull/388)）
  WeCom long-running tasks rotate streaming cards before their ten-minute window expires, probe progress during quiet periods, and attempt replacement after consecutive rejected acknowledgments. Final results target the newest card, falling back to an active message if rotation fails. ([#388](https://github.com/xmanrui/dsh-im/pull/388))

### Fixed / 修复

- 绑定 DS Bot 的会话优先显示 Bot 头像而非渠道图标，支持形状、颜色及安全的图片头像；设置面板在打开或手动刷新时更新名称和头像，侧边栏在返回窗口时刷新，避免逐行请求及定时轮询，并丢弃过期请求结果。（[#415](https://github.com/xmanrui/dsh-im/pull/415)、[#416](https://github.com/xmanrui/dsh-im/pull/416)、[#417](https://github.com/xmanrui/dsh-im/pull/417)、[#418](https://github.com/xmanrui/dsh-im/pull/418)）
  Bound sessions prioritize DS Bot avatars over channel logos, including shape, color, and safe image avatars. Settings refresh names and avatars on open or manual refresh; the sidebar refreshes on window return without per-row requests or periodic polling. Stale responses are discarded. ([#415](https://github.com/xmanrui/dsh-im/pull/415), [#416](https://github.com/xmanrui/dsh-im/pull/416), [#417](https://github.com/xmanrui/dsh-im/pull/417), [#418](https://github.com/xmanrui/dsh-im/pull/418))

- 飞书提问卡片将选项说明放在选择按钮外并允许换行，改善长选项的显示。（[#407](https://github.com/xmanrui/dsh-im/pull/407)）
  Feishu question cards place option text outside selection buttons and allow wrapping, improving readability for long options. ([#407](https://github.com/xmanrui/dsh-im/pull/407))

- 移除 IM 管理面板的「返回插件详情」按钮及相关导航依赖、样式和翻译，从侧边栏或插件详情进入时统一通过宿主侧边栏切换面板。（[#395](https://github.com/xmanrui/dsh-im/issues/395)）
  Removed the IM management panel's **Back to plugin details** button and its navigation dependency, styles, and translation. Both sidebar and plugin-detail entry points now use the host sidebar to switch panels. ([#395](https://github.com/xmanrui/dsh-im/issues/395))

### Security / 安全

- 将构建锁中的 follow-redirects 从 1.16.0 更新到 1.16.1，并重新生成 Host 产物，纳入跨源重定向凭据头过滤修复（[GHSA-q3jh-wrc6-jgq8](https://github.com/advisories/GHSA-q3jh-wrc6-jgq8)、[GHSA-8r9p-f939-6h3c](https://github.com/advisories/GHSA-8r9p-f939-6h3c)）。已有安装若保留旧的间接依赖锁，仍需刷新依赖解析。
  Updated build-lock follow-redirects from 1.16.0 to 1.16.1 and rebuilt the Host artifact with cross-origin redirect credential-header filtering fixes ([GHSA-q3jh-wrc6-jgq8](https://github.com/advisories/GHSA-q3jh-wrc6-jgq8), [GHSA-8r9p-f939-6h3c](https://github.com/advisories/GHSA-8r9p-f939-6h3c)). Existing installations retaining older transitive dependency locks must refresh their resolution.

### Notes / 使用说明

- DS Bot 绑定要求当前 Host 已安装并启用 DS Bot，且 IM 已存在私聊；不支持群聊或远程 Harness 绑定。Bot 缺失时不会将消息误送到其他会话。Telegram 群规则只能处理机器人实际收到的消息，不支持通过邀请链接解析群；从管理列表移除群不会删除聊天历史。
  DS Bot bindings require DS Bot installed and enabled on the current Host and an existing IM private chat; group chats and remote Harness bindings are unsupported. Missing bots do not redirect messages to unrelated sessions. Telegram rules apply only to messages delivered to the bot; invite links cannot resolve groups, and removing a group from the management list does not delete chat history.
- 依赖声明、Node.js 要求与 DSH 兼容声明保持不变。新增头像素材的第三方许可说明；升级后重启 Host 并刷新管理页面。
  Dependency declarations, Node.js requirements, and DSH compatibility declarations are unchanged. Added third-party notices for avatar assets. Restart the Host and refresh the management page after upgrading.

## [5.3.0] - 2026-10-20

### Added / 新增

- 通用设置新增侧边栏入口「自动／始终显示／始终隐藏」模式。默认未配置渠道时显示，保存至少一个渠道后自动隐藏，删除最后一个渠道后恢复；设置保存后即时生效并在 Host 重启后保留。隐藏入口不会停止机器人，仍可从设置或插件详情打开管理面板。
  Added Automatic / Always show / Always hide sidebar entry modes in General settings. Automatic shows the entry before setup, hides it after at least one channel is saved, and restores it after the last channel is removed. Preferences apply immediately and persist across Host restarts. Bots keep running, and Settings and plugin details still open the management panel.

### Fixed / 修复

- 微信、飞书、钉钉、企业微信、QQ、WhatsApp 的二维码生成失败现在保留脱敏的错误类型、错误码、生成阶段及依赖版本，区分本机图片生成故障与网络故障；失败后可在当前登录流程重试，迟到的失败不会清除新缓存。诊断不包含二维码内容、原始异常文本或堆栈。（[#393](https://github.com/xmanrui/dsh-im/pull/393)）
  QR generation failures for Weixin, Feishu, DingTalk, WeCom, QQ, and WhatsApp now retain sanitized error types, codes, encoding stage, and dependency versions, distinguishing local image generation failures from network errors. Failed renders can retry within the current login attempt, and late failures cannot evict newer cached results. Diagnostics exclude QR contents, raw exception messages, and stack traces. ([#393](https://github.com/xmanrui/dsh-im/pull/393))

- 侧边栏入口改为选择后自动保存并立即生效，移除独立保存按钮；保存失败恢复原选项并提供重试。
  Sidebar entry preferences now save and apply on selection without a separate Save button. Failed saves restore the previous selection and offer Retry.

- 侧边栏入口设置使用独立管理接口并遵循 `rpcAuthority`，修复通过已认证的局域网或域名访问时入口一直隐藏、无法强制显示的问题；TTL 等通用设置接口继续仅限本机。读取设置或渠道配置失败时，仍可选择并保存「始终显示／始终隐藏」，保存失败后保留重试入口。
  Sidebar visibility uses a dedicated management route that follows `rpcAuthority`, restoring the entry and forced visibility settings for authenticated LAN and domain access. General settings such as TTL remain loopback-only. Failed settings or channel configuration reads still allow saving Always show / Always hide, and failed recovery saves retain Retry.

- 启动时默认隐藏侧边栏入口，收到渠道配置及显示设置后才按需显示，避免已配置用户重启时入口先显示再隐藏造成侧栏闪动。读取失败时保持当前状态，设置与插件详情入口仍可访问。
  Keep the sidebar entry hidden during startup until channel configuration and visibility preferences arrive, preventing a temporary entry from shifting the sidebar for configured users. Failed reads retain the current state; Settings and plugin details remain accessible.
- iMessage 渠道在 macOS 26（Tahoe）上会静默跳过收到的消息：系统不再写入 `message.text`，正文只存在于 `message.attributedBody`。消息查询改为同时接受两列，并在 `text` 为空时解码 typedstream 正文；纯附件占位（U+FFFC）仍视为无文本。
  iMessage messages were silently skipped on macOS 26 (Tahoe), where Messages no longer writes `message.text` and stores the body only in `message.attributedBody`. The query now accepts either column and decodes the typedstream body when `text` is empty; attachment-only runs (U+FFFC) still count as no text.

### Security / 安全

- 将构建锁中的 Axios 从 1.19.0 更新到 1.20.0、music-metadata 从 11.14.0 更新到 11.16.0，并重新生成 Host 发布产物，以纳入上游安全修复。更新均在现有依赖声明范围内；已有安装若保留旧的间接依赖锁，仍需更新依赖解析。
  Updated build-lock Axios from 1.19.0 to 1.20.0 and music-metadata from 11.14.0 to 11.16.0, and rebuilt the Host artifact with upstream security fixes. Both updates satisfy existing dependency ranges; existing installations retaining older transitive dependency locks must refresh their resolution.

### Notes / 使用说明

- 感谢 [@zhiqiangme](https://github.com/zhiqiangme) 的侧边栏显示模式贡献（[#398](https://github.com/xmanrui/dsh-im/pull/398)）与 [@hxu129](https://github.com/hxu129) 的 iMessage 修复（[#401](https://github.com/xmanrui/dsh-im/pull/401)）。
  Thanks to [@zhiqiangme](https://github.com/zhiqiangme) for sidebar visibility modes ([#398](https://github.com/xmanrui/dsh-im/pull/398)) and [@hxu129](https://github.com/hxu129) for the iMessage fix ([#401](https://github.com/xmanrui/dsh-im/pull/401)).
- 直接依赖声明、Node.js 要求与 DSH 兼容声明保持不变。升级后重启 Host 并刷新管理页面，以加载同版 Host 和客户端代码。
  Direct dependency declarations, Node.js requirements, and DSH compatibility declarations are unchanged. Restart the Host and refresh the management page after upgrading to load matching Host and client code.

## [5.2.0] - 2026-10-20

### Added / 新增

- 支持 `sidebar.panellist` 的 DSH 宿主新增左侧「IM机器人」入口，与插件详情操作共用主区域管理面板；保留原设置入口和返回插件详情操作，无需安装独立桌面接入。侧栏使用跟随主题颜色及尺寸的单色双对话框图标，顺序设为 10，并在槽位或依赖服务退出时清理对应注册；旧宿主继续使用原设置入口。
  Added an IM bots sidebar entry on DSH hosts supporting `sidebar.panellist`, opening the same main-area management panel as the plugin detail action. Settings and Back to plugin details remain available without installing the separate desktop integration. The sidebar uses a theme-colored, size-aware monochrome speech-bubble icon with order 10 and cleans up registrations when slots or required services disappear; older hosts retain Settings access.

### Fixed / 修复

- 微信文本回复遇到连接级 `network-error` 时，分别等待 400 ms、1,200 ms 后重试，最多尝试三次，同一文本块复用 `client_id`；超时、HTTP 错误和业务拒绝不自动重试，取消后停止后续尝试。感谢 [@chentianhai4](https://github.com/chentianhai4) 的贡献（[#392](https://github.com/xmanrui/dsh-im/pull/392)）。
  Weixin text replies retry connection-level `network-error` failures after 400 ms and 1,200 ms, for up to three attempts with the same `client_id` per chunk. Timeouts, HTTP errors, and provider rejections are not retried, and cancellation stops further attempts. Thanks to [@chentianhai4](https://github.com/chentianhai4) for [#392](https://github.com/xmanrui/dsh-im/pull/392).
- 企业微信 SDK 的警告与错误现写入渠道日志；共享进度更新失败日志可识别原始回执中的 `errcode` / `errmsg`，不再仅输出 `undefined`。感谢 [@lysgithub0302](https://github.com/lysgithub0302) 的贡献（[#387](https://github.com/xmanrui/dsh-im/pull/387)）。
  WeCom SDK warnings and errors are now surfaced in channel logs. Shared progress-update failure logging extracts `errcode` / `errmsg` from raw acknowledgment frames instead of only printing `undefined`. Thanks to [@lysgithub0302](https://github.com/lysgithub0302) for [#387](https://github.com/xmanrui/dsh-im/pull/387).
- 邮件投递重试回归测试改为等待实际重试完成，减少慢速 CI 下短轮询期限导致的误失败，并核对成功投递只执行一次且写入已处理状态。
  The email delivery-retry regression now waits for the retry to complete instead of racing a short polling deadline on slow CI, and verifies single execution and persisted handled state.

### Notes / 使用说明

- 微信服务不保证按 `client_id` 去重：若请求已到达服务端但连接在响应前中断，重试仍可能产生重复消息。本次仅重试连接级错误，不承诺恰好一次投递。
  Weixin does not guarantee deduplication by `client_id`: if a request reaches the service before the connection breaks, a retry may still duplicate the message. This change retries only connection-level failures and does not promise exactly-once delivery.
- npm 依赖、Node.js 要求与 DSH 兼容声明保持不变。升级后重启 Host 并刷新管理页面，以加载同版 Host 和客户端代码。
  npm dependencies, Node.js requirements, and DSH compatibility declarations are unchanged. Restart the Host and refresh the management page after upgrading to load matching Host and client code.

## [5.1.0] - 2026-10-18

### Added / 新增

- 新增 WhatsApp、飞书、Telegram、Discord、Slack、QQ 群消息与附件本地归档，保存实际收到的普通群消息，无需先 @ 机器人；采集本身不调用模型或创建 AI 会话，回复仍遵守原有触发规则与访问设置。群记录独立于机器人、会话和工作区，同一数据目录内按群身份共享；QQ 按应用来源隔离，Discord 线程与父频道分开。
  Added local group-message and attachment archives for WhatsApp, Feishu, Telegram, Discord, Slack, and QQ, including ordinary received messages without a bot mention. Capture does not invoke the model or create AI Sessions, and replies retain existing trigger and access rules. Archives are independent of bots, Sessions, and workspaces and are shared by group identity within one data directory; QQ is application-scoped, while Discord threads are separate from parent channels.
- 新增 `dsh_im_group_history` 与 `dsh_im_group_file` 工具，支持按时间、关键词分页查询当前群消息或文件列表，并读取文件的会话副本。读取权限绑定当前群的实际请求；私聊、Web/CLI、跨群及已结束的请求不能继承群记录权限。
  Added `dsh_im_group_history` and `dsh_im_group_file` tools for paginated time/keyword searches and session copies of archived files. Access is bound to a live request originating from the current group; direct chats, Web/CLI inputs, other groups, and ended requests cannot inherit archive access.
- 通用设置新增全局群聊天记录保留天数，默认 14 天，支持正整数并即时生效；按消息时间滚动保留，查询排除过期数据，启动、每小时及修改设置后清理过期消息与文件。新增中英文群记录设置和使用指南。
  Added a global group-history retention setting, defaulting to 14 days and accepting positive integers with immediate effect. Retention rolls from message timestamps, queries exclude expired data, and startup, hourly, and settings-change sweeps clean up expired messages and files. Added Chinese and English setup and usage guides.

### Changed / 变更

- 飞书扫码新增与补全权限流程申请群普通消息和消息附件读取权限；Slack 应用模板补充普通频道消息订阅。已有应用仍需按平台要求补齐权限或重新授权，详见 [群记录指南](docs/group-history.md)。
  Feishu onboarding and permission repair request ordinary group-message and message-resource access; the Slack app manifest adds ordinary channel-message subscriptions. Existing apps still require platform-side permissions or reauthorization as described in the [group-history guide](docs/group-history.en.md).

### Notes / 使用说明

- 群记录默认自动采集，无逐群开关；仅保存平台实际投递的消息与可下载附件，不回填接入前完整历史，也不保证补齐离线消息、编辑或撤回。归档单文件上限 100 MiB，仍受平台更低限制约束。请在升级前确认群成员知情及所需平台权限。
  Group recording is automatic by default, without per-group switches. Only actually delivered messages and downloadable attachments are saved; full pre-connection history, offline gaps, edits, and deletions are not guaranteed. The archive limit is 100 MiB per file, subject to lower platform limits. Ensure group members are informed and required platform permissions are configured before upgrading.
- 缩短保留期限会清理过期原始记录；延长期限不能恢复已删除内容。AI 会话中的文字、总结和文件副本按各自规则保留，不随群记录期限同步清除。Telegram 文件及 Discord、Slack 真实群验收尚未完成，不将已实现采集路径等同于全平台实测通过。
  Shortening retention removes expired archive originals; extending it cannot restore deleted data. Text, summaries, and file copies already in AI Sessions follow their own retention rules. Live validation of Telegram files and Discord/Slack groups remains outstanding; implemented capture paths do not imply all platforms have passed live acceptance tests.
- npm 依赖、Node.js 要求与 DSH 兼容声明保持不变。升级后重启 Host 并刷新管理页面，以加载同版 Host 和客户端代码。
  npm dependencies, Node.js requirements, and DSH compatibility declarations are unchanged. Restart the Host and refresh the management page after upgrading to load matching Host and client code.

## [5.0.3] - 2026-10-18

### Fixed / 修复

- WhatsApp 群聊仅在被 @ 或回复机器人实际发出的消息时触发，绑定账号本人的普通发言及对其手动消息的回复不再唤醒机器人；自聊保持正常。机器人群消息 ID 随现有状态保存，重启后仍可识别。
  WhatsApp groups now respond only to mentions or replies to messages actually sent by the bot. Ordinary messages from the linked account and replies to its manual messages no longer trigger the bot; self-chat is unchanged. Bot group-message IDs are persisted across restarts.
- 修复临时文件快照目录被系统清理后，后续结果文件发送持续失败的问题：自动重建私有目录并重试一次；初次目录创建失败不再永久缓存失败结果，错误保留底层原因，取消请求不会继续重试。
  Fixed subsequent result-file sends failing after system cleanup removes the temporary snapshot directory. The private directory is recreated and copying is retried once; an initial directory-creation failure no longer stays cached permanently, underlying error causes are preserved, and cancelled requests are not retried.

### Notes / 使用说明

- WhatsApp 保存最近 2,000 条机器人群消息标识，按群区分并跨重启保留。升级前未记录或超出保留范围的旧消息不能用于回复唤醒，请 @ 机器人或回复其新消息；私聊和自聊保持原有行为。中英文说明已同步更新。
  WhatsApp retains the latest 2,000 bot group-message identifiers, scoped to their groups and persisted across restarts. Replies to unrecorded pre-upgrade messages or older messages outside this history do not trigger the bot; mention it or reply to a new bot message instead. Direct and self-chat behavior is unchanged, and both READMEs are updated.
- 依赖与 DSH 兼容声明保持不变。升级后重启 Host 并刷新管理页面，以加载同版 Host 和客户端代码。
  Dependency and DSH compatibility declarations remain unchanged. Restart the Host and refresh the management page after upgrading so Host and client code use the same version.

## [5.0.2] - 2026-10-18

### Fixed / 修复

- 修复 DSH `0.2.1-rc.2` 下 `/session` 绑定已有会话失败并额外创建空白会话的问题。现代 Host 的绑定路径改为读取指定会话并核对工作区，不再通过 `session.create` 恢复；保留原 Session ID、历史、权限、模型和 Agent Preset，以及归档状态。
  Fixed `/session` failing to bind existing Sessions and creating unwanted blank Sessions on DSH `0.2.1-rc.2`. Modern Host adoption now reads the specified Session and validates its workspace instead of using `session.create`, preserving its identity, history, permissions, model, Agent Preset, and archive state.
- 修复企业微信将 `/permission` 和 `/permissionlist` 当作普通消息提交给模型的问题；现接入共享权限命令处理，遵守机器人命令访问限制，并补齐帮助说明。
  Fixed Enterprise WeChat submitting `/permission` and `/permissionlist` as model prompts. They now use the shared permission command handler, enforce bot command access rules, and appear in help.
- 补齐 DSH `0.2.1-rc.2` 下 `/compact`、`/clear`、`/permission` 命令请求的调用方 `peer`，与会话请求共用一个 Host 身份，参数适配重试也保留该身份，并在插件卸载时统一释放。感谢 [@2220545672](https://github.com/2220545672) 在 [#364](https://github.com/xmanrui/dsh-im/pull/364) 中的定位与验证，以及 [@spdw666](https://github.com/spdw666) 指出的命令路径遗漏。
  Added the missing caller `peer` to `/compact`, `/clear`, and `/permission` requests on DSH `0.2.1-rc.2`. Commands and session requests share one Host identity, preserve it during argument adaptation, and release it on plugin unload. Thanks to [@2220545672](https://github.com/2220545672) for the diagnosis and validation in [#364](https://github.com/xmanrui/dsh-im/pull/364), and [@spdw666](https://github.com/spdw666) for identifying the missing command path.

### Notes / 使用说明

- DSH `0.2.1-rc.2` 未注册 `/clear`。本次补齐其请求身份后，会明确提示 Host 不支持并保留当前会话；不会清空上下文或改为新建会话。飞书和企业微信已实测 `/compact`、`/permission workspace-write` 成功，以及 `/clear` 的未支持提示。
  DSH `0.2.1-rc.2` does not register `/clear`. With its caller identity supplied, the bot explicitly reports the unsupported command and preserves the Session; it does not clear context or create a replacement Session. Live Feishu and Enterprise WeChat tests verified successful `/compact` and `/permission workspace-write` execution, plus the unsupported `/clear` response.
- 依赖声明与包内 DSH 兼容声明保持不变。升级后重启 Host 并刷新管理页面，以加载同版 Host 和客户端代码。
  Dependency and DSH compatibility declarations remain unchanged. Restart the Host and refresh the management page after upgrading so Host and client code use the same version.

## [5.0.1] - 2026-10-18

### Fixed / 修复

- 更新管理页面的 DSH 版本兼容说明：明确 dsh-im `4.39.0` 对应 DSH `0.2.0-rc.2`、dsh-im `5.0.0` 对应 DSH `0.2.1-rc.2`，保留 `4.25.0` 的旧版提示，移除过时的 `4.26.0` / `4.27.0` 提示；同步英文翻译与客户端构建产物。
  Updated the management page's DSH compatibility notes to identify dsh-im `4.39.0` with DSH `0.2.0-rc.2` and dsh-im `5.0.0` with DSH `0.2.1-rc.2`. The legacy `4.25.0` note is retained, obsolete `4.26.0` / `4.27.0` guidance is removed, and English translations and the client bundle are synchronized.

### Notes / 使用说明

- 本次为兼容提示文案修正版，不改变渠道运行逻辑、依赖或包内兼容声明。升级后重启 Host 并刷新管理页面，以加载新版客户端提示。
  This patch updates compatibility guidance only; channel runtime behavior, dependencies, and package compatibility declarations remain unchanged. Restart the Host and refresh the management page after upgrading to load the updated client guidance.

## [5.0.0] - 2026-10-18

### Added / 新增

- Telegram、Slack、Discord、Matrix、WhatsApp、Email、iMessage 和 QQ 的排队消息新增持久化恢复：进入队列时保存文本与路由信息，重启后重新处理尚未进入提交阶段的消息；已标记提交的消息不自动重放，而是发送中断提示，避免重复执行。感谢 [@ferocknew](https://github.com/ferocknew) 的贡献（[#370](https://github.com/xmanrui/dsh-im/pull/370)）。
  Queued messages in Telegram, Slack, Discord, Matrix, WhatsApp, Email, iMessage, and QQ gain durable recovery. Text and routing data are saved on enqueue; after a restart, entries that have not entered submission are replayed, while entries marked submitted are reported as interrupted instead of being replayed automatically. Thanks to [@ferocknew](https://github.com/ferocknew) for the contribution ([#370](https://github.com/xmanrui/dsh-im/pull/370)).

### Fixed / 修复

- 修复旧会话引用已移除模型时，WhatsApp、Discord 等渠道停在「正在处理」并让后续消息等待超时的问题。共享回复追踪从持久化消息队列的取出记录确认早期失败归属，及时提示模型不可用并释放聊天队列；已留下的超时补发记录也能识别这类失败并结束等待。
  Fixed WhatsApp, Discord, and other channels waiting for a timeout when an existing session references a removed model. Shared reply tracking now correlates early failures through durable inbox claims, reports the model error promptly, and releases the conversation queue. Deferred deliveries can also resolve these failures without waiting indefinitely.
- 修复 DSH `0.2.1-rc.2` 下所有渠道因网关请求缺少 `peer` 而在提交消息前失败的问题。共享适配层复用 Host Connection 创建的调用方身份，用于普通调用和流式调用，并在插件卸载时释放；补充全部渠道的回归测试，微信和 QQ 新会话、已有会话已完成真机收发验证。
  Fixed pre-submission failures across all channels on DSH `0.2.1-rc.2` caused by Gateway requests missing `peer`. The shared adapter reuses a Host Connection peer for unary and streaming calls and disposes it on unload. Regression coverage includes every channel; live WeChat and QQ tests verified replies in new and existing sessions.

### Changed / 变更

- 兼容声明更新至 DSH `0.2.1-rc.2`，保留 DSH `0.2.0-rc.2` 的兼容声明；同步更新中英文说明、Trendshift 徽章和企业微信截图。
  The declared DSH target is now `0.2.1-rc.2`, retaining the `0.2.0-rc.2` compatibility declaration. Chinese and English documentation, Trendshift badges, and the WeCom screenshot are refreshed.

### Notes / 使用说明

- 排队恢复仅覆盖上述八个渠道；微信、钉钉、企业微信、企业微信应用和飞书仍使用各自原有队列路径。持久化记录保存在渠道状态文件中，最多保留 200 条，内容包括消息文本和路由元数据，不是附件或富媒体的完整备份。已进入提交阶段的记录不代表已确认执行，收到重启中断提示后请先检查原会话再决定是否重发。
  Queue recovery covers only the eight channels listed above. Weixin, DingTalk, WeCom, WeCom App, and Feishu retain their existing queue paths. Channel state files retain up to 200 entries containing message text and routing metadata, not complete attachment or rich-media backups. A submission marker does not prove execution; check the original session before resending after an interruption notice.
- npm 依赖声明与 Node.js `>=22.19` 要求保持不变。升级后重启 Host 并刷新管理页面，以加载同版 Host 和客户端代码。
  npm dependency declarations and the Node.js `>=22.19` requirement remain unchanged. Restart the Host and refresh the management page after upgrading so Host and client code use the same version.

## [4.39.0] - 2026-10-13

本版本的 Matrix 会话上下文与群聊追问能力来自 [@Dong09](https://github.com/Dong09) 的贡献（[#350](https://github.com/xmanrui/dsh-im/pull/350)），感谢！
Thanks to [@Dong09](https://github.com/Dong09) for the Matrix conversation-context and group follow-up improvements in this release ([#350](https://github.com/xmanrui/dsh-im/pull/350)).

### Added / 新增

- Matrix 渠道接入渠道无关的会话上下文引擎：共享层 `src/channels/shared/conversation/` 新增语义消息、会话路由键编解码、触发规则表、话题根一次注入、回复链解析、环库（burst/recent）环境上下文与上下文装配七个模块；Matrix 运行时按配置启用回复链与话题根注入、同发送者连珠消息与近期窗口作为上下文随触发消息一并送达。上下文条目按共享注入协议 `<dsh_im_context>` 块随提示词前置，Host 在 `agent/pre-step` 将每块拆回独立的插件归因上下文消息：真人的直接提问在会话中保持原样，条目按 event 去重，同一消息被多角色命中只呈现一次（如 `thread-root+reply`）。显式关系优先于环库推断，环库条目仅在被成功使用的一轮消费一次。
  Added a channel-neutral conversation context engine for Matrix: the shared layer gained semantic message, conversation route key codec, trigger rule table, once-per-conversation thread-root injection, reply-chain resolution, ambient burst/recent providers, and context assembly modules. Collected entries ride ahead of the triggering prompt as `<dsh_im_context>` blocks of the shared injected-context grammar, and the Host's `agent/pre-step` splits every block back into its own plugin-sourced context message, so the human's direct question stays verbatim in the Session; entries merge by event id, presenting one message hit by several roles once (e.g. `thread-root+reply`). Explicit relations always win over ambient inference, and ambient entries are consumed only by a successful turn.
- Matrix 机器人新增配置：`threadsMode`（会话分叉策略，默认 `inherit`，可选 `isolate`/`auto`）、`triggerOnReply`（回复触发策略，默认 `never`，可选 `any`/`bot-only`）、`rootContextOnceEnabled`、`replyContextEnabled`、`ambientContextEnabled`、`contextMaxChars`、`replyMaxDepth`、`ambientBurstGapMs`、`ambientRecentWindowMs`、`ambientRecentCount`；话题根、回复链和 burst/recent 环境上下文三个可选采集开关默认关闭。
  Added Matrix bot settings `threadsMode` (thread conversation splitting: default `inherit`, plus `isolate`/`auto`), `triggerOnReply` (reply triggering: default `never`, plus `any`/`bot-only`), `rootContextOnceEnabled`, `replyContextEnabled`, `ambientContextEnabled`, `contextMaxChars`, `replyMaxDepth`, `ambientBurstGapMs`, `ambientRecentWindowMs`, and `ambientRecentCount`; these three optional thread-root, reply-chain, and burst/recent ambient collectors default to off.
- Matrix 群聊提示词现以发送者显示名前缀（`显示名: 内容`）：房间会话按房间共享，前缀让持久化的每轮指明其提问者；名字取房间成员状态的显示名，取不到回退 MXID localpart，私聊、命令与注入块不添加前缀。
  Group prompts now carry the speaker's display name as a prefix (`Name: message`): a room shares one conversation, and the label names whose turn each persisted turn is; the name resolves from the room member state with an MXID localpart fallback, while direct chats, commands, and injected blocks stay unlabelled.
- Matrix 新增房间可见上下文窗口（`visibleContextEnabled`，默认开启）：群聊触发轮最先采集"当前消息列里成员可读的最近内容"——主聊问答、机器人自己的回答、以及未被提及而落下的消息一并可回填给模型，窗口按触发消息所在的消息列过滤（主聊窗口不混入 thread 消息，反之亦然），并以每会话台账防重放；机器人回答从发送出口记录（含流式回答的编辑终帧），不依赖服务器回声 bot 事件；占位回执"正在处理…"不入记录；以占位回执开起的 thread，其话题根不贡献独立条目，占位回答的编辑终态经同列窗口送达。新增配置 `visibleContextWindowMs`（缺省 600000）、`visibleContextLimit`（缺省 8）、`visibleContextChars`（缺省 4000）。
  Added the Matrix room-visible context window (setting `visibleContextEnabled`, on by default): a group turn first collects what members can read in the current message list — earlier questions, the bot's own answers, and dropped unaddressed chatter — so elliptical follow-ups lean on the same readback the client shows; the window filters to the triggering message's own list (the mainline never borrows thread posts, nor a thread from the mainline) with a per-conversation ledger against re-serving. Bot answers are recorded at the send exits, streamed answers included via their final edit frames, without relying on the homeserver echoing bot events back; the pending placeholder is never stored, and a thread opened by such a placeholder contributes no thread-root entry of its own — the edited final body of that answer reaches the model through the same-list room-visible window. New settings `visibleContextWindowMs` (default 600000), `visibleContextLimit` (default 8), and `visibleContextChars` (default 4000).
- Matrix 群聊追问三档语义：同一发送者连续发送的触发消息在发射前经短暂折窗（`coalesceWindowMs`，缺省 450 毫秒）合并为一次发起，连发数条气泡合成一个回合；回合在飞时，该发送者的后续触发消息不再排队等待整条回答、而是 steer 注入在飞回合于模型下一步即读（`autoSteerSameSender` 缺省开启，每回合注入上限 `autoSteerLimit` 缺省 5，超限回落排队，注入文带发言者署名）；不同发送者的消息仍依序排队执行，媒材与合成消息不合并、不注入。
  Added the Matrix three-lane follow-up policy for group chats: consecutive addressed posts from one sender fold into a single dispatch inside a short pre-dispatch window (`coalesceWindowMs`, default 450ms), so a burst split across bubbles becomes one turn; while a turn is in flight, that sender's further posts steer the running turn at its next model step instead of queueing behind the pending answer (`autoSteerSameSender`, on by default; per-turn steer budget `autoSteerLimit`, default 5, over-budget posts fall back to the queue, and steered text carries its speaker label); other senders still queue one voice at a time, and media or composed payloads neither fold nor steer.

### Changed / 变更

- Matrix 群聊触发改为缺省仅提及：`triggerOnReply` 缺省现为 `never`，群聊（消息列与 thread）只有 @ 提及或命令才开口回复；带回复关系但未 @ 的消息一律只记为事实（供后续环境上下文使用）。旧「任何回复即唤醒」形态可经 `triggerOnReply:'any'` 显式恢复；`bot-only` 形态（仅可证实回复 bot 自身消息才唤醒，依赖 bot 事件绑定表）显式开启。私聊不受影响，仍每条消息即答。
  Changed the Matrix room trigger policy to mention-only by default: `triggerOnReply` now defaults to `never`, so rooms and threads wake the bot only through an @-mention or a command, and an unaddressed reply records as a fact for later ambient use. The previous any-reply shape returns through `triggerOnReply:'any'`, and `bot-only` wakes the bot for replies that the bot-event binding table proves address one of its own messages. Direct chats are untouched and still answer every message.
- Matrix 话题会话分叉策略修正：客户端在线程内发送时自动附着的成员声明关系（回退的 `m.in_reply_to`）不再参与会话选择——线程内消息一律分叉该话题的独立会话；真人回复主聊消息开起的话题仍继承被回复消息所在会话；回复 bot 自己回答气泡（话题根为 bot 所发）的线程式消息同样分叉独立会话——回答气泡之下的面板自成一个可读的消息列。另修复占位回执泄漏进上下文的两条路径：回复链上溯遇占位回执即截断（占位背后的主聊问题不再进入线程面板的上下文），占位事件在记录面以空文 bot 回执存形（供作者判定与编辑终态归一），同列窗口并将话题根气泡纳入线程式窗口（回答以回复开起线程时其编辑终态虽存于主聊列仍进该线程序列；根气泡是面板之头而非近期消息，不受新鲜度窗口约束，线程再久也恒列窗首）。
  Changed the Matrix thread fork policy: the thread-membership declaration clients attach automatically (the falling-back `m.in_reply_to`) no longer selects a conversation, so posts made inside a thread always fork the thread's own conversation; a genuine reply that opens a thread at a human mainline message still inherits that message's conversation, while a reply to a bot-authored answer bubble (a bot-authored root) likewise forks — the panel under an answer reads as its own message list. Also fixed two leaks of the pending placeholder into context: the reply-chain walk truncates at a placeholder receipt (the mainline question behind a placeholder no longer crosses into the panel above it), the placeholder event keeps a content-free bot receipt in the record (authorship proof and the anchor the final edit frame revises into), and a thread window now includes its root bubble — an answer sent as the reply that opened the thread is stored on the mainline where it was sent yet reads inside the thread's list too, leading the window exempt from the freshness floor as the panel's permanent head.

### Fixed / 修复

- 企业微信命令菜单恢复为六个按钮，移除菜单中的「清空上下文」按钮，避免超过平台卡片按钮数量限制；手动输入 `/clear` 仍可使用。
  The WeCom command menu returns to six buttons by removing the Clear context button, avoiding the platform's card-button limit. The `/clear` text command remains available.
- 修复 Matrix 把线程内的消息路由进房间主会话的问题：插件此前只识别自身发送端使用的嵌套关系格式；按 Matrix 协议，回复目标位于顶层的 `m.in_reply_to` 或新格式 `m.relates_to`（`rel_type` 为 `m.reply`），`is_falling_back` 标记在 `m.relates_to` 与 `m.in_reply_to` 两处任一出现即表示线程成员声明。按协议标准格式发送、回退目标指向人类话题根的事件因此没有被排除，默认的 `inherit` 策略把消息路由到了主会话。回复目标的提取与回复链的遍历现在同时读取两种格式和两处的标记；测试按协议规定的消息结构新增用例，既有夹具中位置错误的标记移到协议规定的位置。
  Fixed Matrix thread posts routing into the room's mainline conversation: the reader only understood the nested relation form this plugin's own writer emits, while the Matrix spec carries the reply target in the top-level `m.in_reply_to` or the new-form `m.relates_to` (`rel_type: "m.reply"`) and defines `is_falling_back` on both `m.relates_to` and `m.in_reply_to`. A standards-shaped event whose fallback relation points at a human thread root therefore was not excluded as a thread-membership declaration, and the default `inherit` fork routed the post into the mainline. Reply-target extraction and the reply-chain walk now read both relation forms and the marker at either position; tests add the protocol-defined event structures and move misplaced markers in existing fixtures to the specified levels.
- 修复 Matrix 配置存储丢失七个设置字段的问题：`visibleContextEnabled`、`visibleContextWindowMs`、`visibleContextLimit`、`visibleContextChars`、`coalesceWindowMs`、`autoSteerSameSender`、`autoSteerLimit` 保存时未校验也未保留，保存后再加载全部变为未定义，运行时重新采用默认值，关闭房间可见窗口、连发合并和自动插话的设置无法生效。存储现在按各字段的取值范围校验并持久化；测试覆盖关闭值和自定义值的保存与重新加载。
  Fixed the Matrix config store dropping seven settings fields: `visibleContextEnabled`, `visibleContextWindowMs`, `visibleContextLimit`, `visibleContextChars`, `coalesceWindowMs`, `autoSteerSameSender`, and `autoSteerLimit` were neither validated nor preserved on save, so they came back undefined after a reload and the runtime silently fell back to their enabled defaults — turning the room-visible window, burst folding, or auto-steering off could not take effect. The store now validates each field against its bounds and persists it; tests cover saving, reloading, and rejecting invalid values.
- 修复 Matrix 普通文字发送路径把机器人回答记录成空文本的问题：发送出口传给记录函数的是分块后的对象（含 `markdown` 与 `plain` 两个属性），而记录函数只接受字符串；流式回复初始化失败、回退为普通发送时，回答已成功发出，近史簿中的正文却是空字符串，后续窗口无法读回。发送出口现在传入实际发送的正文；测试覆盖普通发送、流式回退和分块余量的记录。
  Fixed the plain-text send path recording bot answers with an empty body: the send exit passed the prepared chunk object (`{ markdown, plain }`) to the recorder, which accepts strings only, so when a streamed reply failed to initialize and the turn fell back to plain delivery, the answer left the room while the room-visible store held an empty string no later window could read back. The send exit now passes the actually delivered body string; tests cover plain delivery, the streamed-delivery fallback, and multi-chunk remainders.
- 修复 Matrix 连发合并时第一条消息重复注入为房间可见上下文的问题：合并以最后一条消息为触发消息，附带用于去重的标识却取 `open.members.slice(1)`，漏掉第一条、反而包含最后一条；两条同发送者的消息在合并窗口内到达时，输入中同时包含第一条消息的房间可见上下文和合并后的正文。去重标识现在包含除最后一条以外的全部成员；测试断言合并成员不会再次出现在注入的上下文块中。
  Fixed the first message of a coalesced same-sender burst resurfacing as room-visible context: the fold dispatches the last member as the trigger but built the extra deduplication ids with `open.members.slice(1)`, dropping the first member and keeping the last, so a two-message burst reached the model with the first message's room-visible context alongside the merged body. The deduplication set now carries every member id except the trigger, and a test asserts no folded member reappears inside the injected context blocks.
- 修复 Matrix 群聊进程重启后已注入过的上下文再次注入的问题：「每事件每会话只注入一次」的台账与会话世代此前只存于进程内存、不落实盘，重启即勾消账失、世代清零——列根招呼之类的条目会随重启后的首问再次进入上下文，模型记录里同一段文字出现两遍；非首世代的老回答于重启后也会被再读一次。注入台账与世代计数现与近史簿同存，重启后的进程不再把该会话已经见过的料重发；`/new` 仍清账并递进世代，新会话照旧把前代气泡读回一次。归属钉机制上线之前所记的 bot 老气泡，于装载时按其本列路由补钉，自我答案守卫于重启后重新认得 bot 自己的旧话并保持退休。
  Fixed the Matrix room re-serving already-delivered context after a process restart: the per-conversation injection ledger and the session generation counter lived only in process memory, so a restart wiped both — the column's greeting and other head bubbles entered the first post-restart prompt once more, duplicating text the model's transcript already carried, and older-generation answers could be read back once as well. The ledger and the generation counter now persist beside the room record, a restarted process re-offers nothing its conversation has already been shown, and `/new` still clears the ledger and bumps the generation so a successor session reads the predecessor's bubbles back once. Bot bubbles recorded before the provenance stamp existed are stamped at store load from their own room and thread route, so the self-answer guard recognizes the bot's old own words across a restart and keeps them retired.
- 修复 Matrix 群聊中一场会话把自己产出的回答再次注入其下一轮提示词的问题：回答文本本已在该会话的记录之中，再作为房间可见上下文块注入即成重复，既耗提示额度，亦偏离窗口"只补会话所不知"的初衷。发送出口发出的气泡现记录产出它的会话键与当时的会话世代：该会话的窗口不再注入当前会话产出的回答；其他会话读取这些气泡不受影响，回复开起的话题面板仍显示其根回答气泡；在飞注入的补充消息亦随其回合收账，此后不再注入；`/new` 清除台账后会话世代递进，新会话可以重新读到旧会话的回答。
  Fixed a Matrix conversation re-reading its own answers into its next prompt: the delivered text already sits in that session's transcript, so serving it again as room-visible context duplicated content and spent the prompt budget beyond the window's intent to supply only what a session cannot know. Bubbles leaving the send exits now record the conversation and the session generation that produced them, and that conversation's window no longer injects what its current session delivered. Other conversations keep reading these bubbles unchanged — the answer bubble a thread was opened under still leads that panel's window — a steered in-flight follow-up retires with its turn, and after `/new` clears the ledger the generation bump lets the fresh session read the previous session's answers once more.
- 修复 Matrix 群聊中会话经消息引用再次读入自己回答的缺口：同列窗口的自我答案守卫此前只护住近史回填一路，触发消息以引用关系指向本会话当前世代产出的回答气泡时（服务器能解析出正文的整发气泡），该气泡仍会沿回复链注入为上下文条目，同一段话第二次进入提示词。回复链节点现按发送出口记录的归属会话与会话世代判定，本会话当前世代之所出者不再随引用链注入，与窗口同判据；`/new` 后新会话引用旧会话的回答，仍可将其读回一次。
  Fixed the last road through which a Matrix conversation could read back its own answer: the self-answer guard stood only on the room-visible backfill lane, so a trigger quoting one of the conversation's own freshly sent bubbles — the whole-send shape whose body the homeserver resolves — carried that text in once more as a reply-chain entry. Reply-chain nodes now consult the owning conversation and session generation recorded at the send exits, the same proof the window applies, while a successor session under the bumped generation still reads a quoted previous answer once.
- 修复群聊中机器人等待「精准批准/拒绝」决定时，消息发送人改提新需求会被无限卡住的问题：群聊中 @ 提及的消息在房间仅等待审批决定、且文本不是审批决定词（批准/同意/拒绝/不同意/yes/no）时，不再被审批队列吞没并只重发决定指引，而是安全拒绝该待审批并立即作为新回合处理该消息，房间随即收到拒绝回执与「先回应新请求」通知；待决的是提问时行为如常——提问人本人的 @ 文本仍按答案提交（自由文本原样送达模型），其他成员的消息仍依序排队，私聊的决定与回答路径、提问自身的安全取消以及命令出口（如 `/stop`、`/new`）均不受影响。
  Fixed a pending approval freezing the room when its sender changes their mind instead of deciding: in group chats, an @-addressed message that is no exact approve/reject token (批准/同意/拒绝/不同意/yes/no) while the room waits on an approval alone is no longer swallowed by the approval queue with only a re-sent decision prompt; the waiting tool call is safely rejected and the message runs at once as its own turn, announced by the rejection receipt plus a moved-on notice. A pending question keeps its established flow — the asking actor's @ text still submits as the answer (free-form text reaches the model verbatim), other members still queue one voice at a time, and direct chats, the question's own safe cancellation, and command exits such as `/stop` and `/new` are untouched.
- 修复 Matrix 主时间线人类消息的真实回复开起话题时另起会话的问题：客户端以“回复消息即在该消息上开话题”的形式发出的回复（话题根即被回复消息）现按配置默认继承被回复消息所属的房间主会话；机器人回答下的话题和回退关系声明的话题内继续消息仍使用话题独立会话。始终隔离的旧行为可经 `threadsMode:'isolate'` 保留。
  Fixed a genuine Matrix reply opening a new conversation at a human-authored mainline message: a client's reply-to-message event whose thread root is the replied-to message now inherits that message's conversation under the default thread mode while threads under bot answers and in-thread posts carrying fallback membership relations keep separate thread conversations. The previous fork-always behavior remains available through `threadsMode:'isolate'`.
- 修复话题内的普通继续发言被当作真实回复处理的问题：客户端在线程内发送消息时自动附上的回退关系（`m.in_reply_to.is_falling_back`）按 Matrix 规范是“线程成员声明”而非真人回复，此前被计入回复目标，导致线程内每条消息都把话题根及其回复链作为上下文重复前置（同一条旧消息每轮都出现）。回复链采集、回复触发分类与回复记录现只认真实回复关系；回退关系不再参与 `inherit` 会话选择，线程内继续发言使用话题独立会话。另外，同一会话内已作为上下文注入过的事件（回复链或话题根条目）此后不再重复注入（台账与近史簿同存，`/new` 即清除；重启亦不重发已呈现之料）。
  Fixed ordinary posts inside a thread being treated as genuine replies: the falling-back relation (`m.in_reply_to.is_falling_back`) that clients attach when sending inside a thread is a thread-membership declaration per the Matrix spec, not a human reply, yet it was taken as a reply target so every post in the thread re-attached the thread root and its reply chain as context, surfacing the same old message on every turn. Reply-chain collection, reply-based triggering and recorded reply targets now honour genuine reply relations only, while the `inherit` policy no longer uses fallback membership relations to select a conversation, and in-thread continuation stays in the thread's own conversation. Additionally, an event already injected as collected context (reply-chain or thread-root entry) into a conversation is not injected again (the ledger persists beside the room record and is cleared by `/new`; a restart re-serves nothing already shown).

### Notes / 使用说明

- Matrix 默认仅由群聊提及或命令触发；房间可见上下文窗口和同发送者自动插话默认开启，连发合并窗口为 450 毫秒。话题根、回复链和 burst/recent 环境上下文三个可选采集开关默认关闭。升级前可按需检查这些配置。
  Matrix group chats trigger on mentions or commands by default. The room-visible context window and same-sender automatic steering default to on, with a 450 ms coalescing window. The optional thread-root, reply-chain, and burst/recent ambient collectors default to off. Review these settings as needed when upgrading.
- 依赖声明与 DSH `0.2.0-rc.2` 兼容声明保持不变；升级后重启 Host 并刷新管理页面，以加载同版 Host 和客户端代码。
  Dependency declarations and declared DSH `0.2.0-rc.2` compatibility remain unchanged. Restart the Host and refresh the management page after upgrading so Host and client code use the same version.

## [4.38.2] - 2026-10-13

### Fixed / 修复

- 飞书双向同步不再无限重试已过期的镜像卡片：识别平台的过期拒绝，清理超过 14 天的恢复快照，并为恢复失败设置可跨重启保留的 20 次上限。每条记录独立调度，执行前重新读取状态，避免旧定时任务恢复已删除记录或覆盖较新的快照；现有卡片与纯文本兜底保持不变。（[#352](https://github.com/xmanrui/dsh-im/issues/352)）
  Feishu bidirectional sync stops endlessly retrying expired mirror cards. It recognizes provider expiry rejections, retires recovery snapshots older than 14 days, and persists a 20-failure recovery limit across restarts. Each record retries independently and rereads current state before running, preventing stale timers from resurrecting deleted records or overwriting newer snapshots. Existing card and plain-text fallbacks remain unchanged. ([#352](https://github.com/xmanrui/dsh-im/issues/352))
- Harness 消息失败明确区分准备会话、准备消息、建立交互通道、提交消息和等待结果等阶段，并标明「未提交／已确认接收／提交结果未知」。交互通道 30 秒未就绪时明确提示消息尚未提交；已尝试提交但结果不确定时提示先到 DSH 查看，避免立即重复发送。
  Harness message failures distinguish session preparation, prompt preparation, interaction setup, submission, and result waiting, with explicit not-submitted, accepted, or unknown submission states. A 30-second interaction-setup timeout clearly reports that no prompt was submitted; uncertain post-submission failures advise checking DSH before resending.
- 管理页面、中英文提示、复制诊断和日志补齐失败阶段、提交状态、连接尝试次数、最近连接失败原因及运行环境信息。诊断字段使用白名单，关联标识仅进入本地日志；为每次请求保留独立上下文，不污染共享错误，也不改变取消与既有重试行为。
  Management UI, bilingual messages, copied diagnostics, and logs now include failure stage, submission state, connection-attempt count, last connection failure, and runtime information. Fields are allowlisted, correlation identifiers stay in local logs, and request-specific context does not mutate shared errors or alter cancellation and existing retry behavior.

### Performance / 性能优化

- 同一 Host 的本地 IM 客户端共享经过校验的模型目录缓存（30 秒），合并并发读取并为调用者返回独立副本；单个调用取消不影响其他调用。保存模型设置时强制重新校验目录，Host 释放时清理缓存；远程 HTTP 客户端不共享此缓存。（[#349](https://github.com/xmanrui/dsh-im/issues/349)）
  Local IM clients on the same Host share a validated model catalog for 30 seconds, coalesce concurrent reads, and receive independent copies. Cancelling one reader does not cancel peers. Saving model settings forces fresh validation, Host disposal clears the cache, and remote HTTP clients do not share it. ([#349](https://github.com/xmanrui/dsh-im/issues/349))

### Notes / 使用说明

- 依赖声明与 DSH `0.2.0-rc.2` 兼容声明保持不变；升级后重启 Host 并刷新管理页面，以加载同版 Host 和客户端诊断逻辑。
  Dependency declarations and declared DSH `0.2.0-rc.2` compatibility remain unchanged. Restart the Host and refresh the management page after upgrading so Host and client diagnostics use the same version.

## [4.38.1] - 2026-10-12

### Fixed / 修复

- 修复双向 Session 同步中助手最终答复的 Markdown 丢失问题，按各 IM 渠道能力发送富文本、原生 Markdown 或保留完整正文的纯文本；用户消息回显仍为纯文本。长消息按渠道限制分片并补齐代码围栏，新增格式降级仅针对明确被拒绝的分片，不重发成功分片或为不确定结果新增重试；飞书保留原有镜像卡与纯文本兜底。（[#339](https://github.com/xmanrui/dsh-im/issues/339)）
  Bidirectional Session sync preserves Markdown in final assistant answers using each IM channel's rich text, native Markdown, or full-text fallback, while user echoes remain plain text. Long messages respect channel limits and repair code fences. New format fallbacks target only explicitly rejected chunks, without replaying successful chunks or adding retries for uncertain outcomes. Feishu retains its existing mirror cards and plain-text fallback. ([#339](https://github.com/xmanrui/dsh-im/issues/339))
- 企业微信机器人将引用消息中的图片与当前消息图片一同送入模型，保留图片来源和序号提示；引用图片缺失时明确说明并提示重新发送。本地命令仍不下载引用图片，现有权限、预取队列及图片输入限制保持不变。（[#345](https://github.com/xmanrui/dsh-im/issues/345)）
  WeCom bots pass quoted images alongside directly attached images to the model, identifying their source and position. Missing quoted images are explicitly reported with a resend request. Local commands do not download quoted images, and existing permissions, prefetch queues, and image-input limits remain unchanged. ([#345](https://github.com/xmanrui/dsh-im/issues/345))
- 客户端时区无法解析、为空或读取异常时省略可选时区字段，避免普通排队与插话请求被网关拒绝；网关输入校验错误归入协议错误，便于诊断。
  Queue and steer requests omit the optional client time zone when it is unresolved, empty, or throws, preventing gateway input rejection. Gateway input-validation failures are classified as protocol errors for clearer diagnostics.
- 主动投递不再将明确未发送、失败或结果未知的返回值误判为成功；微信长消息分片投递在失败时停止后续分片，并保留安全的分片诊断信息。
  Proactive delivery no longer treats explicit non-delivery, failure, or unknown outcomes as success. Weixin long-message delivery stops remaining chunks on failure and retains safe chunk diagnostics.

### Changed / 变更

- 中英文插件名称统一附加 `(dsh-im)`，同步更新说明文档与截图。
  Localized plugin names consistently include the `(dsh-im)` suffix, with refreshed documentation and screenshots.

### Notes / 使用说明

- 双向同步范围仍为当前 Host 的已绑定私聊，不扩展到群、话题或远程 Host；WhatsApp 仅转换常见格式，复杂结构保留原文。
  Bidirectional sync remains limited to bound private chats on the current Host, without adding groups, topics, or remote Hosts. WhatsApp converts common formatting conservatively and preserves unsupported complex structures literally.
- 依赖声明与 DSH `0.2.0-rc.2` 兼容声明保持不变；升级后重启 Host 并刷新管理页面，以加载同版 Host 和客户端代码。
  Dependency declarations and declared DSH `0.2.0-rc.2` compatibility remain unchanged. Restart the Host and refresh the management page after upgrading so Host and client code use the same version.

## [4.38.0] - 2026-10-09

### Added / 新增

- 飞书机器人「更多设置 → 通用」新增独立的「展开思考过程」和「展开工具摘要」开关。设置按机器人持久化，更新时无需重连，普通回复与双向同步的实时过程卡使用同一偏好；默认思考过程收起、工具摘要展开。（[#326](https://github.com/xmanrui/dsh-im/issues/326)）
  Feishu bots add independent “Expand thinking process” and “Expand tool summaries” switches under More settings → General. Preferences persist per bot and update without reconnecting, applying to live process cards for both ordinary replies and bidirectional Session sync. Thinking stays collapsed and tools expanded by default. ([#326](https://github.com/xmanrui/dsh-im/issues/326))

### Fixed / 修复

- 待处理审批默认在一小时后自动拒绝，不再无限占用队列或留下 Web 端审批。拒绝提交失败时保留审批状态并退避重试、明确提示尚未确认；已在提交的人工决定优先，过期后不再接受新的批准。感谢 [@luochen211](https://github.com/luochen211) 的贡献（[#319](https://github.com/xmanrui/dsh-im/pull/319)）。
  Pending approvals now default to automatic rejection after one hour instead of indefinitely occupying the queue or leaving shared Web approvals pending. Failed rejection submissions retain state, retry with backoff, and clearly report the unconfirmed outcome. An already-submitting human decision takes precedence, and expired approvals accept no new allow decision. Thanks to [@luochen211](https://github.com/luochen211) ([#319](https://github.com/xmanrui/dsh-im/pull/319)).
- Matrix 加密引擎停止时先等待房间密钥请求及其持久化任务完成，再释放加密会话；后台密钥请求失败被捕获并记录，避免关闭阶段的异步任务竞争。（[#337](https://github.com/xmanrui/dsh-im/pull/337)）
  Matrix crypto shutdown drains room-key requests and their persistence tasks before freeing crypto sessions. Background key-request failures are caught and logged, preventing shutdown races. ([#337](https://github.com/xmanrui/dsh-im/pull/337))

### Changed / 变更

- 简化机器人通用设置，消息处理模式和飞书面板开关改为修改后自动保存；保存期间避免重复提交，失败时恢复已保存值并显示错误。飞书两个过程卡开关以统一布局展示。
  Bot General settings are streamlined: message mode and Feishu panel switches save automatically on change, block duplicate submissions while saving, and restore the saved value with an error on failure. Both Feishu process-card controls share a consistent layout.
- 插件图标调整为更粗的蓝绿圆环，并更新文档截图。
  The plugin icon now uses thicker blue and green rings, with refreshed documentation screenshots.

### Notes / 使用说明

- 面板展开偏好仅影响飞书实时过程卡；已完成、已停止和分片封存的卡片仍自动收起过程详情，不会改变原生 CoT 或分步消息的展示模式。
  Panel expansion preferences apply only to Feishu live process cards. Completed, stopped, and sealed overflow cards still collapse process details; native CoT and discrete step-post modes remain unchanged.
- 依赖声明与 DSH `0.2.0-rc.2` 兼容声明保持不变；升级后重启 Host 并刷新管理页面，以加载同版 Host 和客户端设置。
  Dependency declarations and declared DSH `0.2.0-rc.2` compatibility remain unchanged. Restart the Host and refresh the management page after upgrading so Host and client settings use the same version.



## [4.37.0] - 2026-10-07

### Added / 新增

- 全部 13 个聊天渠道新增每个机器人独立的「排队／插话」设置，入口为「更多设置 → 通用」，默认排队。插话模式复用现有 `/steer` 权限、任务归属与补充指令机制；普通纯文字可在当前任务的下一步读取，并提供排队或提交回执。（[#314](https://github.com/xmanrui/dsh-im/issues/314)、[#115](https://github.com/xmanrui/dsh-im/issues/115)）
  All 13 chat channels add a per-bot Queue/Steer setting under More settings → General, defaulting to Queue. Automatic steering reuses `/steer` permissions, task ownership, and instruction submission for ordinary plain text, with queue or submission receipts. ([#314](https://github.com/xmanrui/dsh-im/issues/314), [#115](https://github.com/xmanrui/dsh-im/issues/115))

- 新增跨渠道 `/clear` 命令，清空当前会话的模型上下文，同时保留 Session 绑定和历史记录；同步更新帮助、菜单与中英文提示。感谢 [@luochen211](https://github.com/luochen211) 的贡献（[#320](https://github.com/xmanrui/dsh-im/pull/320)，解决 [#318](https://github.com/xmanrui/dsh-im/issues/318)）。
  The cross-channel `/clear` command clears model context while retaining the current Session binding and history, with updated help, menus, and bilingual messages. Thanks to [@luochen211](https://github.com/luochen211) ([#320](https://github.com/xmanrui/dsh-im/pull/320), addressing [#318](https://github.com/xmanrui/dsh-im/issues/318)).

### Fixed / 修复

- 修复飞书数字菜单的新会话操作在消息队列中被自身队列误判为忙碌的问题；等待前序消息处理完成后正常切换，仍保留未完成交互保护。
  Feishu numeric new-Session menu actions no longer mistake their own queue entry for a busy task. They run after earlier messages while preserving pending-interaction protection.

### Security / 安全

- 可选图片处理依赖 `sharp` 从 `0.35.4` 升级至 `0.35.5`，更新预编译原生依赖，修复上游 librsvg 内存安全漏洞 [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)。其他直接依赖声明保持不变。
  Optional image processing dependency `sharp` is upgraded from `0.35.4` to `0.35.5`, updating prebuilt native dependencies to fix the upstream librsvg memory-safety vulnerability [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w). Other direct dependency declarations remain unchanged.

### Notes / 使用说明

- 设置保存后对新消息生效，已排队消息保持原顺序；没有运行任务时正常开始新任务，附件、语音、引用、命令、审批和菜单保持原有处理方式。手动 `/steer` 在两种模式下均可用；AI Office 的任务协议不适用此设置。
  Settings apply to new messages without reinterpreting queued inputs. Idle messages start normally; attachments, voice, quotes, commands, approvals, and menus retain their existing handling. Manual `/steer` works in either mode. AI Office's task protocol is outside this setting's scope.
- `/clear` 不接受参数、图片或文件，运行任务或等待交互时须先处理完毕；Host 不支持时明确提示，不会回退到 `/new` 或解除会话绑定。
  `/clear` accepts no arguments, images, or files and requires active tasks or pending interactions to finish first. Unsupported Hosts receive an explicit notice without falling back to `/new` or clearing the Session binding.
- DSH `0.2.0-rc.2` 兼容声明保持不变；升级后重启 Host 并刷新管理页面，以加载同版 Host 和客户端设置。
  Declared DSH `0.2.0-rc.2` compatibility remains unchanged. Restart the Host and refresh the management page after upgrading so Host and client settings use the same version.

## [4.36.1] - 2026-10-06

### Fixed / 修复

- Harness RPC 失败时保留实际调用方法、进程内 Host API 或 HTTP 调用方式、请求耗时及超时阈值；诊断信息经过健康检查包装、消息错误分类和公开错误转换后仍可用于定位问题。
  Failed Harness RPCs retain the actual method, in-process Host API or HTTP transport, elapsed request time, and timeout threshold. This evidence survives health-check wrapping, message-failure classification, and public error projection for troubleshooting.
- 管理页面的连接错误与消息错误详情补齐 RPC 方法和调用方式，中英文标签、复制诊断内容及日志同步保留这些信息；方法与调用方式使用白名单校验，不透出请求正文、认证信息或未经允许的底层字段。
  Management-page connection and message error details now show RPC method and transport, with Chinese and English labels and matching copied diagnostics and logs. Method and transport values are allowlisted without exposing request payloads, credentials, or unapproved underlying fields.
- 保持现有错误码及调用方取消行为；调用方主动取消时不改写原始错误，也不会因新增诊断而重试请求或切换传输方式。
  Existing error codes and caller cancellation behavior are preserved. Explicit cancellation leaves the original error untouched, and the added diagnostics do not retry requests or switch transports.

### Notes / 使用说明

- 依赖声明与 DSH `0.2.0-rc.2` 兼容声明保持不变；升级后重启 Host 并刷新管理页面，以加载同版 Host 和客户端诊断逻辑。
  Dependency declarations and declared DSH `0.2.0-rc.2` compatibility remain unchanged. Restart the Host and refresh the management page after upgrading so Host and client diagnostics use the same version.

## [4.36.0] - 2026-10-05

### Added / 新增

- Web 与 11 类 IM 渠道共享同一次审批，最先提交的「批准一次」或「拒绝」生效，另一端随即失效；机器人发起的审批沿用原聊天，Web/Host 发起的审批可投递到该 Session 唯一绑定且开启双向同步的私聊。发送和提交时重新校验绑定与访问权限，同一私聊的目标别名合并计算；多个私聊仅发送 Web 处理提醒，不提供永久批准。
  Web and 11 IM channel types can handle the same approval: the first allow-once or reject decision wins and retires the other presentation. IM-originated approvals stay in their original chat; Web/Host approvals may reach the Session's single bound private chat with bidirectional sync enabled. Binding and access checks run before presentation and submission, aliases for the same private chat are deduplicated, multiple private chats receive only a Web reminder, and permanent approval is not offered.
- 同 Host 的 `dshIm` Service 新增 `inboundVersion: 1`、`consumeInbound`、`replyChecked` 和 `historyChecked`。已注册的飞书/Lark 独占消费者可按已认证原消息读取群、附近或原生话题中的有限文本历史；每次重新核验作者、会话及话题路由，显式分页，单次最多检查 20 条平台记录，不支持的记录计入 `omitted`。
  The same-Host `dshIm` Service adds `inboundVersion: 1`, `consumeInbound`, `replyChecked`, and `historyChecked`. Registered exclusive Feishu/Lark consumers can read bounded group, nearby, or native-thread text history anchored to an authenticated source. Every call revalidates author, conversation, and topic routing, explicitly paginates at most 20 provider records, and counts unsupported records as `omitted`.
- 经过校验的 Lark 附近上下文先遍历原消息前后各五分钟内可见、受支持的用户文本，再按可配置的前后消息保底条数补齐稀疏侧（默认前 10／后 5）。新消息不会查询未来区间；每次调用仍有界并重新校验原消息身份。
  Checked Lark nearby context traverses all supported visible human text within five minutes before and after the source, then fills sparse sides to configurable message minima (default 10 before / 5 after). Fresh sources terminate without querying a future range; every call remains bounded and rechecks the authenticated anchor.

- 飞书/Lark 可由同 Host 应用独占接收文本消息，等待应用确认持久化后返回，并按校验过的原消息/话题回复；外部消费模式在释放或重启后不回退到独立 Session。
  Same-Host applications can opt into exclusive Feishu/Lark text intake, acknowledge after durable acceptance, and reply through a checked original-message/topic route. Releasing or restarting an external consumer never falls back to a standalone Session.

### Fixed / 修复

- 群与话题历史读取现在同时识别 SDK 成功响应和 HTTP 拒绝中的权限错误；取消优先于错误映射，不向应用暴露带认证信息的底层 HTTP 错误。
  Checked history reads recognize permission errors in both resolved responses and rejected SDK HTTP responses; cancellation takes precedence and raw authenticated HTTP errors never escape to application callers.

- 独占收件接管与凭据重绑共用配置事务队列；展示设置更新不再被误判为账号变更。应用回调不占用机器人操作队列，断开可取消待处理回调，回调也可读取或回复原消息。
  Exclusive takeover shares configuration serialization with credential rebinding; presentation changes no longer look like account changes. Application callbacks release the bot operation queue so disconnect can cancel them and callbacks can await checked reads or replies.

### Changed / 变更

- DSH 支持基线调整为 `0.2.0-rc.2`，同 Host 连接统一使用现代 Typert Gateway、Session 与 Workspace Controller，不再依赖旧 `apiProxy` 注入入口。
  The declared DSH baseline is now `0.2.0-rc.2`. Same-Host connections use the modern Typert Gateway, Session Controller, and Workspace Controller instead of the legacy injected `apiProxy` entry point.

### Notes / 使用说明

- 共享审批支持微信、飞书、钉钉、企业微信机器人／应用、QQ、Telegram、Slack、Discord、WhatsApp、Matrix；iMessage、邮箱与 AI Office 暂不参与。Slack 接收 Web 审批需 `im:read` 权限，缺少权限时保留 Web 入口；本次发布不会自动修改应用权限。
  Shared approvals support WeChat, Feishu, DingTalk, WeCom bot/app, QQ, Telegram, Slack, Discord, WhatsApp, and Matrix; iMessage, email, and AI Office do not participate. Slack needs `im:read` for Web-originated approvals and retains Web fallback when unavailable; this release does not automatically change application permissions.
- 独占收件由应用显式启用，应用负责授权、去重及持久化；释放或重启不会自动恢复独立 Session。历史读取仅覆盖平台可见的用户文本，群历史可能不包含话题回复，应单独使用 `thread`；读历史不会自动收件、唤醒 Agent 或回复。回复结果未知时应核对外部会话，不要盲目重试。
  Exclusive intake is application opt-in, with authorization, deduplication, and persistence owned by the application; release or restart never silently restores standalone Sessions. History covers provider-visible human text only; chat history may omit topic replies, so use `thread` separately. Reads do not automatically ingest messages, wake an agent, or reply. Reconcile unknown reply outcomes externally rather than blindly retrying.
- 依赖声明保持不变。旧版 DSH 请使用对应历史插件版本；升级后重启 Host 并刷新管理页面。感谢 [@DoodleBears](https://github.com/DoodleBears) 的飞书/Lark 接口贡献（[#313](https://github.com/xmanrui/dsh-im/pull/313)、[#315](https://github.com/xmanrui/dsh-im/pull/315)、[#317](https://github.com/xmanrui/dsh-im/pull/317)）。
  Dependency declarations remain unchanged. Use a corresponding historical plugin release with older DSH versions; restart the Host and refresh the management page after upgrading. Thanks to [@DoodleBears](https://github.com/DoodleBears) for the Feishu/Lark contracts ([#313](https://github.com/xmanrui/dsh-im/pull/313), [#315](https://github.com/xmanrui/dsh-im/pull/315), [#317](https://github.com/xmanrui/dsh-im/pull/317)).

## [4.35.1] - 2026-10-05

### Fixed / 修复

- QQ 正常回复和超时补发只包含最后一次工具调用后的答复正文，避免把“正在查询”等过程文字混入最终答案；保留正文分段、工具错误提示及停止后的部分回复。（[#310](https://github.com/xmanrui/dsh-im/issues/310)）
  QQ replies and deferred deliveries now retain answer text after the last tool call, excluding intermediate progress text while preserving answer paragraphs, tool error notices, and partial replies after stopping. ([#310](https://github.com/xmanrui/dsh-im/issues/310))

- 各渠道统一识别已归档会话，发送前明确提示到 DSH 取消归档或使用 `/new`，不再因归档日志不可读取而误判会话不存在、静默切换绑定。发送期间发生归档、相关内部错误或被阻止的轮次时重新核实归档状态；已被接受的消息会提示可能仍在队列中，避免重复提交。（[#316](https://github.com/xmanrui/dsh-im/issues/316)）
  All channels now recognize archived Sessions and explain how to unarchive in DSH or use `/new` before submitting. Unreadable archived logs no longer cause missing-Session misclassification or silent rebinding. Archive races, related internal errors, and blocked turns trigger a fresh archive check; already-accepted messages warn that they may still be queued to prevent duplicate submissions. ([#316](https://github.com/xmanrui/dsh-im/issues/316))
- 普通被阻止的轮次改为中性状态提示，不再直接断言为当前渠道无法处理的操作；归档诊断保留原请求归属、取消行为和其他网络、模型及附件错误，中英文错误提示同步更新。
  Ordinary blocked turns now use a neutral status notice instead of assuming an action unsupported by the channel. Archive diagnostics preserve request ownership, cancellation, and unrelated network, model, and attachment errors, with updated Chinese and English notices.

### Notes / 使用说明

- QQ 最终正文筛选仅用于正常完成及超时后的补发，不改变工具错误提示、停止后的部分回复或其他渠道的正文行为；本次不会自动取消归档或自动重发已接受的消息。
  QQ final-answer filtering applies to normal completion and deferred delivery, without changing tool-error notices, partial replies after stopping, or other channels' answer behavior. This release does not automatically unarchive Sessions or resubmit accepted messages.
- 依赖声明和 DSH `0.1.7-alpha.1` 兼容性声明保持不变；升级后重启 Host 并刷新管理页面。
  Dependency declarations and declared DSH `0.1.7-alpha.1` compatibility remain unchanged. Restart the Host and refresh the management page after upgrading.

## [4.35.0] - 2026-10-04

### Added / 新增

- 同 Host 的公开 `dshIm` Service 新增可选的飞书 / Lark 群消息投递回执：通过 `receiptVersion: 1` 和 `proactive-receipt-checked` 能力声明识别，调用 `sendChecked(..., { receipt: true })` 可获得经过目标校验的最小消息 ID 和会话 ID。未启用回执时继续返回 `{ sent: true }`，沿用账号指纹、目标摘要及发送前注册状态校验。感谢 [@DoodleBears](https://github.com/DoodleBears) 的贡献（[#308](https://github.com/xmanrui/dsh-im/pull/308)）。
  The same-Host public `dshIm` Service adds opt-in Feishu/Lark group delivery receipts, advertised through `receiptVersion: 1` and `proactive-receipt-checked`. Calling `sendChecked(..., { receipt: true })` returns minimal message and conversation IDs validated against the target. Existing sends retain `{ sent: true }` and account-fingerprint, target-digest, and pre-send registration checks. Thanks to [@DoodleBears](https://github.com/DoodleBears) ([#308](https://github.com/xmanrui/dsh-im/pull/308)).

### Fixed / 修复

- QQ 开启平台「接收所有群消息」后，识别 `GROUP_MESSAGE_CREATE` 中指向当前机器人的 @，不再仅依赖专用 @ 事件。识别信息在 SDK 清理文字前保留，并用于消息、命令、交互回复和输入状态；未 @ 当前机器人的消息不会触发回复，访问策略保持不变。（[#311](https://github.com/xmanrui/dsh-im/issues/311)）
  QQ now recognizes self mentions in `GROUP_MESSAGE_CREATE` when the platform delivers all group messages, rather than relying solely on dedicated mention events. The decision survives SDK text sanitization and applies to messages, commands, interaction replies, and typing status. Messages not addressing this bot do not trigger replies, and access policies remain unchanged. ([#311](https://github.com/xmanrui/dsh-im/issues/311))
- 飞书菜单和工作区选择卡片优先显示 Host 工作区名称，缺少名称时回退目录名；同名工作区增加路径片段区分，长名称缩略，仍冲突时补充序号。路径、回调值和数字选择的快照顺序不变，并兼容旧 Host 的路径列表接口。（[#300](https://github.com/xmanrui/dsh-im/issues/300)）
  Feishu menus and workspace cards prefer Host workspace titles, falling back to directory names. Duplicate labels gain path context, long labels are shortened, and remaining collisions receive numbers. Paths, callback values, and numeric-selection snapshot order remain unchanged, with compatibility for older path-only Host APIs. ([#300](https://github.com/xmanrui/dsh-im/issues/300))
- 插件元数据补齐中英文显示名称「IM 机器人」和「IM bots」。
  Plugin metadata now supplies the localized display names “IM 机器人” and “IM bots”.

### Changed / 变更

- README 更新 Token 赞助说明，并明确项目由社区开发者独立开发与维护。
  README sponsorship information is updated and clarifies independent community development and maintenance.

### Notes / 使用说明

- 回执仅证明平台接受请求，不代表消息已送达或被阅读。发送后的回执缺失或与目标不符时返回 `send-result-unknown`，调用方应保留结果未知状态，不要自动重试；本次未新增入站消费、调度或重试机制。详见[回执接口说明](https://github.com/xmanrui/dsh-im/blob/v4.35.0/docs/checked-proactive-receipts.md)。
  Receipts prove platform acceptance, not delivery or human read status. Missing or mismatched receipts after dispatch raise `send-result-unknown`; callers must retain an unknown outcome and must not automatically retry. This release adds no inbound consumer, scheduler, or retry mechanism. See the [receipt contract](https://github.com/xmanrui/dsh-im/blob/v4.35.0/docs/checked-proactive-receipts.md).
- 依赖声明和 DSH `0.1.7-alpha.1` 兼容性声明保持不变；升级后重启 Host 并刷新管理页面。
  Dependency declarations and declared DSH `0.1.7-alpha.1` compatibility remain unchanged. Restart the Host and refresh the management page after upgrading.

## [4.34.2] - 2026-10-03

### Fixed / 修复

- 飞书会话同步复用现有请求期限，为卡片创建、更新、封存和主动文字投递设置有限等待；SDK 请求持续挂起时进入原有失败与文字兜底路径，后续轮次可以继续，停止运行时也会释放当前等待。（[#294](https://github.com/xmanrui/dsh-im/issues/294)）
  Feishu session sync now reuses the existing request deadline to bound card creation, updates, sealing, and proactive text delivery. Hanging SDK requests enter the existing failure and text fallback paths so later turns can continue, and stopping the runtime releases pending waits. ([#294](https://github.com/xmanrui/dsh-im/issues/294))
- 机器人「更多设置」页签在空间不足时显示左右滚动按钮，切换页签及调整容器宽度时自动保持选中项可见，并支持方向键与 Home / End 导航。（[#303](https://github.com/xmanrui/dsh-im/issues/303)）
  Bot settings tabs now show scroll buttons when space is limited, keep the selected tab visible when switching tabs or resizing the container, and support arrow-key and Home / End navigation. ([#303](https://github.com/xmanrui/dsh-im/issues/303))

- 消息失败诊断区分请求超时与网络连接错误，跨 Host RPC 保留经过筛选的连接诊断信息；已知业务错误、主动取消和投递结果未知仍保留各自语义。错误提示提醒先检查会话记录，避免在结果不确定时立即重复发送。
  Message failure diagnostics distinguish request timeouts from network errors and preserve allowlisted connection evidence across Host RPC. Known business errors, deliberate cancellation, and uncertain delivery retain their own semantics. Hints recommend checking conversation history before resubmitting when the outcome is uncertain.

### Changed / 变更

- 新建飞书和 QQ 机器人默认允许所有用户在私聊和群聊中对话及执行内置命令；可在访问设置中改为白名单或关闭普通用户命令权限。已有机器人的已保存策略和旧配置迁移逻辑保持不变。
  New Feishu and QQ bots default to allowing all users to chat and run built-in commands in direct and group conversations. Access settings can restrict them to allowlists or disable ordinary-user commands. Existing saved policies and legacy configuration migration remain unchanged.

### Notes / 使用说明

- 新建机器人默认权限更开放，请按实际使用范围检查访问设置。飞书 SDK 请求超时只保证本地等待结束，不保证平台侧操作已取消；遇到超时或网络错误，请先核对聊天记录再决定是否重试。
  New bots have more permissive defaults; review access settings for the intended audience. A Feishu SDK timeout bounds local waiting but does not guarantee cancellation on the provider side. Check chat history before retrying after a timeout or network error.
- 依赖声明和 DSH `0.1.7-alpha.1` 兼容性声明保持不变；升级后重启 Host 并刷新管理页面。
  Dependency declarations and declared DSH `0.1.7-alpha.1` compatibility remain unchanged. Restart the Host and refresh the management page after upgrading.

## [4.34.1] - 2026-10-02

### Fixed / 修复

- Discord 通过已认证的应用信息确认个人应用所有者或团队所有者，并接入现有所有者访问豁免：已确认的所有者可在私聊和群聊中访问机器人、执行命令，不受普通用户白名单和命令开关限制。身份仅在正常启动、重连或凭据绑定时查询，成功保存后才用于运行时策略；查询失败保留已保存身份，不阻止机器人启动，也不会把团队其他成员或机器人自身视为所有者。（[#296](https://github.com/xmanrui/dsh-im/issues/296)）
  Discord now resolves the personal application owner or team owner from authenticated application metadata and applies the existing owner exemption. Confirmed owners can access the bot and run commands in direct and group chats regardless of ordinary-user allowlists or command switches. Identity is queried only during normal startup, reconnect, or credential binding and applied only after persistence succeeds. Lookup failures retain the saved identity without blocking startup; other team members and the bot itself are not treated as owners. ([#296](https://github.com/xmanrui/dsh-im/issues/296))
- 飞书保存访问策略时校验当前启用的私聊和群聊白名单，拒绝填入当前机器人自身的 Open ID，并返回中英文错误提示；校验失败不会写入或替换已有策略。开放模式下未启用的历史白名单保留，方便恢复访问。
  Feishu rejects its own bot Open ID in active direct-message or group allowlists, with localized save errors. Validation failures leave the existing policy untouched. Inactive historical allowlists remain available when switching back to open mode to recover access.
- 飞书被访问策略拒绝的消息、语音识别结果和卡片操作记录统一的拒绝原因日志，仅包含机器人标识、会话类型和原因，不记录用户身份或消息正文。
  Feishu consistently logs access-policy refusals for messages, transcribed voice input, and card actions using only the bot identifier, conversation type, and reason, without user identities or message content.

### Changed / 变更

- 访问设置补充已确认所有者的权限说明、飞书用户 Open ID 填写提示及 QQ 私聊／群聊身份边界说明，并同步英文文案；新增跨渠道所有者与普通用户隔离回归，修复 Matrix 测试清理临时目录前未等待历史写入的问题。
  Access settings clarify confirmed-owner privileges, Feishu user Open IDs, and QQ direct/group identity boundaries in Chinese and English. Added cross-channel owner/isolation regressions and fixed Matrix test cleanup to wait for pending room-history writes.

### Notes / 使用说明

- 所有者豁免仅适用于接入流程或平台认证确认的身份；飞书仅配置通配符时不会推断所有者，QQ 群聊必须匹配已确认身份，其他用户继续遵守原访问策略。Discord 升级后重启或重连即可尝试补齐身份，无需修改已有白名单；可选身份查询最长等待 5 秒，失败时不会自动放开访问。
  Owner exemptions require identities confirmed during connection setup or by the platform. Wildcard-only Feishu configurations do not identify an owner, QQ groups require a matching confirmed identity, and other users remain subject to their existing access policy. Restart or reconnect Discord after upgrading to attempt owner discovery without changing allowlists. The optional lookup has a five-second timeout and does not open access on failure.
- 依赖声明和 DSH `0.1.7-alpha.1` 兼容性声明保持不变；升级后重启 Host 并刷新管理页面。
  Dependency declarations and declared DSH `0.1.7-alpha.1` compatibility remain unchanged. Restart the Host and refresh the management page after upgrading.

## [4.34.0] - 2026-10-01

### Added / 新增

- 飞书和 QQ 新增 `/permission`、`/permissionlist`，可查看并通过序号或完整 ID 一步切换当前会话权限。序号绑定最近一次列表及会话，沿用 15 分钟快照；沙箱与审批联动由 Host 处理，运行中的任务也能响应。（[#280](https://github.com/xmanrui/dsh-im/issues/280)）
  Feishu and QQ add `/permission` and `/permissionlist` to view and switch current-session permissions by number or full ID in one step. Numbers retain the displayed list and session for 15 minutes; the Host applies sandbox and approval changes, including during a running turn. ([#280](https://github.com/xmanrui/dsh-im/issues/280))

### Fixed / 修复

- Telegram 关闭思考过程留痕时，私聊复用群聊的占位消息编辑流程，避免 Rich Draft 在 Android 上占用发送入口；`/stop`、`/steer` 和普通追加消息沿用原有处理。最终答案保留在占位消息位置，富文本、长答案拆分和附件保持现有投递机制；最终编辑返回明确的“内容未变化”时视为已送达，避免重复发送或降级格式。（[#276](https://github.com/xmanrui/dsh-im/issues/276)）
  With thinking traces off, Telegram private chats now reuse the group's editable placeholder flow, avoiding Rich Drafts that block the Android composer. `/stop`, `/steer`, and ordinary follow-ups retain their existing handling. Final answers stay at the placeholder's position, with existing Rich formatting, long-answer splitting, and attachment delivery. Explicit unchanged-content responses during final edits count as delivered, preventing duplicate messages or unnecessary format fallback. ([#276](https://github.com/xmanrui/dsh-im/issues/276))

### Notes / 使用说明

- 权限命令仅支持纯文字且要求当前聊天已绑定会话，不会为查询自动创建会话，沿用现有命令访问控制。切换直接调用 Host 的权限命令；包括完全访问在内的档位可能改变审批要求，请仅在可信聊天中按需选择。列表序号过期或会话改变后需重新执行 `/permissionlist`，纯数字档位 ID 使用 `/permission id:<ID>`。Host 缺少相关接口或命令时会明确提示不支持。
  Permission commands accept text only, require an already-bound Session, and retain existing command access controls; queries do not create Sessions. Switching invokes the Host's permission command directly. Presets, including full access, may change approval requirements, so select them deliberately in trusted chats. Refresh `/permissionlist` after its number mapping expires or the Session changes; use `/permission id:<ID>` for numeric IDs. Missing Host APIs or commands produce an explicit unsupported message.
- Telegram 本次只调整关闭思考过程留痕时的展示方式，不改变 `/stop`、`/steer`、普通追加消息或附件的既有处理规则。依赖声明和 DSH `0.1.7-alpha.1` 兼容性声明保持不变；升级后重启 Host 并刷新管理页面。
  The Telegram change affects presentation with thinking traces disabled, without changing existing handling of `/stop`, `/steer`, ordinary follow-ups, or attachments. Dependency declarations and declared DSH `0.1.7-alpha.1` compatibility remain unchanged. Restart the Host and refresh the management page after upgrading.

## [4.33.0] - 2026-10-01

### Added / 新增

- 同 Host 的公开 `dshIm` Service 新增版本化账号描述和条件纯文本发送：Feishu/Lark 账号由平台认证身份确定，目标以固定内容摘要校验，旧 `send` 行为保持兼容；未支持的渠道返回明确错误。感谢 [@DoodleBears](https://github.com/DoodleBears) 的代码、文档和测试贡献（[#293](https://github.com/xmanrui/dsh-im/pull/293)）。
  The same-Host public `dshIm` Service adds versioned account descriptions and checked plain-text sends. Feishu/Lark account identity is authenticated against the platform, destinations are checked against a frozen content digest, legacy `send` remains compatible, and unsupported channels return an explicit error. Thanks to [@DoodleBears](https://github.com/DoodleBears) for code, documentation and tests ([#293](https://github.com/xmanrui/dsh-im/pull/293)).

### Fixed / 修复

- IM 文件回传现在要求当前回合存在实际接收文件的活跃 IM 消费者；提示词只在对应回合提供回传指引，Web、Desktop、CLI 等非 IM 回合误用工具时明确拒绝入队。回合结束、消费者释放或文件快照期间失去归属时清理文件，避免显示已排队却无人接收。感谢 [@luochen211](https://github.com/luochen211)（[#290](https://github.com/xmanrui/dsh-im/pull/290)，修复 [#286](https://github.com/xmanrui/dsh-im/issues/286)）。
  IM file returns now require an active consumer that can receive files for the current turn. Prompt guidance is scoped to that turn, and tool calls from non-IM turns such as Web, Desktop, or CLI are explicitly refused rather than queued without a receiver. Files are cleaned up when ownership is lost, including during snapshot creation or turn completion. Thanks to [@luochen211](https://github.com/luochen211) ([#290](https://github.com/xmanrui/dsh-im/pull/290), fixes [#286](https://github.com/xmanrui/dsh-im/issues/286)).
- 飞书菜单的「新会话」按钮显示处理中、已执行和失败状态，并阻止重复或过期回调再次清空后续会话；失败可重试，成功后按钮禁用，卡片更新失败时提示重新打开菜单。感谢 [@luochen211](https://github.com/luochen211)（[#291](https://github.com/xmanrui/dsh-im/pull/291)）。
  Feishu's New session menu action shows processing, completed, and failed states, and prevents duplicate or stale callbacks from clearing a later session. Failures can be retried; successful actions disable the button, and failed card updates prompt the user to reopen the menu. Thanks to [@luochen211](https://github.com/luochen211) ([#291](https://github.com/xmanrui/dsh-im/pull/291)).
- 已启用会话同步的 IM 私聊可接收绑定 Session 中 Host 定时任务成功完成后的最终助手文字，不再漏发结果；内部提醒提示不会作为用户消息回显。
  IM direct chats with Session sync enabled now receive the final assistant text from successful Host-delivered scheduled turns in their bound Session. Internal reminder prompts are not echoed as user messages.

- 飞书图片或文件资源整文件下载返回 `234037` 时，自动改用每次最多 8 MiB 的顺序 Range 请求，并校验响应范围、总大小和实际字节数。普通附件直接流式落盘；图片继续遵守现有大小限制，取消或失败时清理未完成的附件。（[#266](https://github.com/xmanrui/dsh-im/issues/266)） 感谢 [@luochen211](https://github.com/luochen211)（[#289](https://github.com/xmanrui/dsh-im/pull/289)）。
  Feishu image and file downloads now fall back to sequential Range requests of at most 8 MiB when the full download returns `234037`, validating ranges, total size, and actual byte counts. Ordinary attachments stream directly to disk; images retain their existing size limits, and cancelled or failed downloads clean up incomplete attachments. ([#266](https://github.com/xmanrui/dsh-im/issues/266)) Thanks to [@luochen211](https://github.com/luochen211) ([#289](https://github.com/xmanrui/dsh-im/pull/289)).

- 条件投递在最后一次异步账号核验后、SDK 请求开始前再次检查渠道注册、控制器关闭状态和取消信号；凭据读取与平台认证失败返回 `account-unverified`，避免将尚未发送的请求误判为结果未知。
  Checked delivery revalidates the channel Registration, controller lifecycle and cancellation after its final asynchronous account verification, before the SDK request starts. Credential lookup and platform authentication failures return `account-unverified` instead of reporting an uncertain message outcome before any send.

- 修复 Host 语言设置在未注入的 Context 中读取时报错，以及新版 DSH 切换界面语言后 IM 回复和命令菜单未同步的问题。兼容新旧 settings API，渠道启动前等待语言初始化，settings 服务撤销时清理监听并回退到镜像语言。感谢 [@resetsix](https://github.com/resetsix)（[#288](https://github.com/xmanrui/dsh-im/pull/288)，修复 [#287](https://github.com/xmanrui/dsh-im/issues/287)）。
  Fixed Host language settings being read from a Context without injection, and IM replies and command menus not following interface-language changes in newer DSH versions. Supports both settings APIs, waits for language initialization before channels start, and cleans up observers and falls back to the mirrored language when the settings service is withdrawn. Thanks to [@resetsix](https://github.com/resetsix) ([#288](https://github.com/xmanrui/dsh-im/pull/288), fixes [#287](https://github.com/xmanrui/dsh-im/issues/287)).

### Changed / 变更

- npm 包元数据仅保留 `author`，贡献者致谢继续保留在 README 和更新日志中。
  npm package metadata retains only `author`; contributor acknowledgements remain in the READMEs and changelog.

### Notes / 使用说明

- 新条件投递接口为可选的同 Host 插件能力，首版支持飞书/Lark，不改变已有 `send`、HTTP 或管理 RPC。调用方仍需持有用户授权；平台接受不代表送达，结果不确定时不要盲目重试。
  Checked delivery is an optional same-Host plugin capability, initially supported by Feishu/Lark, without changes to existing `send`, HTTP, or management RPC. Callers still need user authorization; platform acceptance does not prove delivery, and uncertain outcomes must not be blindly retried.
- 非 IM 会话应使用 Host 的展示能力返回文件（若提供）；定时任务文字同步需事先启用对应私聊的会话同步。升级后请重新打开飞书菜单，旧卡片的「新会话」回调不再执行。DSH 兼容性声明仍为 `0.1.7-alpha.1`。
  Non-IM conversations should use the Host's presentation capability for file returns, when available. Scheduled text synchronization requires Session sync to be enabled for the direct chat. Reopen the Feishu menu after upgrading; New session callbacks from old cards no longer run. Declared DSH compatibility remains `0.1.7-alpha.1`.

## [4.32.0] - 2026-09-29

### Added / 新增

- 支持插件详情操作按钮的 DSH 中，dsh-im 插件详情页新增「打开 IM机器人」按钮，可在主区域打开已有 IM 管理面板，并通过「返回插件详情」返回当前插件。按钮及返回入口支持中英文。
  On DSH versions that support plugin detail actions, the dsh-im details page adds **Open IM bots** to open the existing IM management panel in the main area, with **Back to plugin details** returning to this plugin. Both actions support Chinese and English.
- 新增中英文插件描述资源，并随 npm 包发布、导出 `locale/*.json`，供 Host 根据界面语言显示插件说明。
  Added Chinese and English plugin-description resources, published and exported as `locale/*.json` so the Host can display the description in the interface language.

### Notes / 使用说明

- 新入口按需接入可选的 `layout`、`pluginNavigation` 服务和 `plugins.detail.actions` 槽位；缺少相关能力的旧版 DSH 仍可通过「设置 → IM机器人」访问，无需迁移配置。入口注册不会提前加载管理面板，相关服务或槽位撤销时会清理注册。
  The new entry uses the optional `layout` and `pluginNavigation` services and the `plugins.detail.actions` slot. Older DSH versions without these capabilities retain **Settings → IM bots**, with no configuration migration. Registration does not mount the panel early, and registrations are cleaned up when the relevant services or slots are withdrawn.
- 本次不改变渠道配置及消息处理行为；DSH 兼容性声明仍为 `0.1.7-alpha.1`，插件详情入口仅在 Host 提供上述能力时可用。
  This release does not change channel configuration or message processing. The declared DSH compatibility remains `0.1.7-alpha.1`; the plugin-details entry is available only when the Host provides the capabilities above.

## [4.31.0] - 2026-09-29

### Added / 新增

- 上下文增强新增可选来源字段「发送时间」`sentAt`，目前由微信渠道提供：优先使用平台发送时间，平台未提供时从消息 ID 解析，按 Host 本机时区输出 `YYYY-MM-DD HH:mm:ss`。无法取得有效时间时省略该字段，不用当前时间代替。感谢 [@Pegasus02](https://github.com/Pegasus02)（[#279](https://github.com/xmanrui/dsh-im/pull/279)）。
  Context enhancement adds an optional Sent at source field, `sentAt`, currently supplied by WeChat. It uses the platform send time, or decodes the message ID when that time is absent, and renders `YYYY-MM-DD HH:mm:ss` in the Host's local time zone. An unavailable or invalid time is omitted rather than replaced with the current time. Thanks to [@Pegasus02](https://github.com/Pegasus02) ([#279](https://github.com/xmanrui/dsh-im/pull/279)).

### Fixed / 修复

- 飞书等待用户回答时，提问发起人发送图片或图文消息会结束本轮追问，并在原会话按顺序处理图片，避免图片被丢弃且流程持续等待文字；原提问卡同步移除按钮。连续发图、图片消息去重和普通文字回答沿用既有机制。（[#208](https://github.com/xmanrui/dsh-im/issues/208)）
  When a Feishu question is pending, images and image posts from its initiating user end the question turn and are processed in order in the same Session. Images are no longer discarded while the flow waits for text, and the question card removes its buttons. Existing queueing, deduplication, and text-answer behavior are preserved. ([#208](https://github.com/xmanrui/dsh-im/issues/208))
- 发送时间仅在已启用的上下文增强实际选中并输出该字段时读取；关闭增强、未选择字段或执行本地命令时不读取，时间读取失败不阻断消息处理。
  Send time is read only when an enabled context-enhancement block actually selects and renders the field. Disabled enhancement, unselected fields, and local commands do not read it; an unreadable time does not block message processing.

### Security / 安全

- 将生产依赖 `undici` 从 7.29.0 更新到官方安全修复版 7.29.1，修复本次安装审计报告的 [GHSA-3wwx-pv8p-q78v](https://github.com/advisories/GHSA-3wwx-pv8p-q78v)。这只更新插件依赖，不替代 Node.js 自带网络组件的安全升级。
  Updated the production dependency `undici` from 7.29.0 to the upstream security release 7.29.1, addressing [GHSA-3wwx-pv8p-q78v](https://github.com/advisories/GHSA-3wwx-pv8p-q78v) reported by the release install audit. This updates the plugin dependency, not Node.js's bundled networking components.

### Notes / 使用说明

- 不自动开启上下文增强，也不自动给已有配置添加 `sentAt`。启用并勾选后，发送时间会作为消息上下文提供给模型；时间文本不带时区偏移，可在增强提示词中注明 Host 时区。其他渠道暂不提供该字段。
  Context enhancement is not enabled automatically, and existing field selections do not gain `sentAt` automatically. When enabled and selected, send time is supplied to the model as message context. The text contains no time-zone offset; name the Host time zone in the guidance if needed. Other channels do not currently supply this field.
- 飞书图片接续只由当前提问的发起人触发；若停止提问失败，图片保留在队列中并提示先回答问题或发送 `/stop`，不会伪造文字答案。DSH 0.1.7-alpha.1 兼容性声明保持不变；升级后重启 Host 并刷新设置页。
  Only the initiating user's image interrupts a pending Feishu question. If stopping fails, the image remains queued and the bot asks the user to answer or send `/stop`; no text answer is fabricated. The DSH 0.1.7-alpha.1 compatibility declaration remains unchanged. Restart the Host and refresh settings after upgrading.

## [4.30.0] - 2026-09-28

### Upgrade notes / 升级注意事项

- 飞书「被 @ 时以话题方式回复」现在默认开启，群聊和私聊都会在主时间线中被 @ 提问的消息下创建独立话题；这也会改变已有机器人的默认行为。需要保留平铺回复时，请在机器人卡片「更多设置 → 群聊」中关闭该开关（`mentionTopicReply: false`）。
  Feishu's Reply as a topic when mentioned setting is now on by default in both groups and direct chats, including existing bots. A question mentioning the bot in the main timeline starts a dedicated topic. To retain flat replies, disable the setting under the bot card's More Settings → Group (`mentionTopicReply: false`).
- 旧字段 `groupTopicReply` 不会迁移为新开关的取值，下次保存时会被忽略。相关设置端点由 `bot.group-topic-reply.set` 更名为 `bot.mention-topic-reply.set`；自行接入该端点的客户端需同步调整。升级后请重启 Host 并刷新设置页。
  The old `groupTopicReply` value is not migrated to the new setting and is ignored on the next save. The setting endpoint changes from `bot.group-topic-reply.set` to `bot.mention-topic-reply.set`; custom clients using it must update accordingly. Restart the Host and refresh settings after upgrading.

### Added / 新增

- 飞书由机器人开启的话题对应独立的 DSH 会话，话题内后续消息继续使用同一会话；仅发送 @机器人 不创建话题，没有 @ 的普通消息沿用原有会话及回复规则。感谢 [@yangzhe1991](https://github.com/yangzhe1991)（[#275](https://github.com/xmanrui/dsh-im/pull/275)）。
  Bot-created Feishu topics map to independent DSH Sessions, with follow-up messages staying in the same Session. A bare bot mention does not create a topic, and ordinary messages without a mention retain existing conversation and reply rules. Thanks to [@yangzhe1991](https://github.com/yangzhe1991) ([#275](https://github.com/xmanrui/dsh-im/pull/275)).
- 飞书机器人「更多设置 → 指令面板」可选择跟随插件默认清单，或自定义输入框“/”面板中的内置指令及顺序；支持增删、上下移动，以及确认后将当前配置保存并复制到同渠道其他机器人。离线机器人在下次启动时同步。感谢 [@yangzhe1991](https://github.com/yangzhe1991)（[#274](https://github.com/xmanrui/dsh-im/pull/274)）。
  Feishu More Settings → Command Panel now supports following the shipped defaults or selecting and ordering built-in commands in the input box's slash panel. Commands can be added, removed, and moved up or down; after confirmation, the current configuration can be saved and copied to other bots on the channel. Offline bots synchronize on their next start. Thanks to [@yangzhe1991](https://github.com/yangzhe1991) ([#274](https://github.com/xmanrui/dsh-im/pull/274)).

### Fixed / 修复

- 飞书回复未返回 `thread_id` 时回读根消息并登记话题，包含逐步消息模式，避免话题内追问错误回到主会话。
  Feishu topic registration reads back the root message when a reply omits `thread_id`, including step-by-step message mode, preventing topic follow-ups from falling back to the main conversation.
- 同一机器人的指令面板同步串行执行，新配置使旧同步在后续检查点停止，避免新旧计划交错写入；保存后设置页和后续复制操作使用已保存的新列表，不再回显旧配置。
  Command-panel synchronization runs serially per bot. New settings stop superseded work at subsequent checkpoints to prevent interleaved writes. The settings page and later copy actions retain the newly saved list instead of reverting to stale configuration.

### Notes / 使用说明

- 隐藏面板指令不等于禁用该命令，手动输入仍遵循现有处理及权限规则。默认模式仅补齐缺少项，不删除、不重排已有项；自定义模式按需重建插件清单内的指令，不删除清单外的指令。后台同步可能需要数十秒，保存配置成功不代表飞书面板已经更新完成。
  Hiding a panel entry does not disable the command; typed commands retain existing handling and permission rules. Default mode only adds missing entries without deleting or reordering existing ones. Custom mode rebuilds commands from the plugin manifest when needed and leaves commands outside that manifest untouched. Background synchronization may take tens of seconds; saving settings does not mean the Feishu panel has finished updating.
- 宿主兼容性声明保持 DSH 0.1.7-alpha.1，依赖声明未变。
  Host compatibility remains declared for DSH 0.1.7-alpha.1, and dependency declarations are unchanged.

## [4.29.1] - 2026-09-28

### Changed / 变更

- 新增渐变消息连接图标，并通过 `package.json` 的 `icon` 字段声明；图标资源随 npm 包发布，供支持该元数据的插件界面展示。
  Added a gradient message-link icon declared through the `icon` field in `package.json`. The asset is included in the npm package for plugin interfaces that support this metadata.

### Compatibility / 兼容性

- 本次仅更新插件图标与包元数据，不改变渠道行为、配置、依赖声明或宿主兼容性范围；DSH 兼容性声明保持 0.1.7-alpha.1。
  This release only updates the plugin icon and package metadata. Channel behavior, configuration, dependency declarations, and the Host compatibility range are unchanged; DSH compatibility remains declared for 0.1.7-alpha.1.

## [4.29.0] - 2026-09-28

### Added / 新增

- 飞书新增默认关闭、按机器人启用的语音交互：语音提问经 ASR 转写后进入现有文字处理流程，同回合答案在保留文字回复的同时可合成为语音，包含分步流式卡片完成后的语音回复。转写后继续执行命令权限检查，语音回合按会话隔离，避免同群不同话题之间串音。感谢 [@rosalynthompson32-a11y](https://github.com/rosalynthompson32-a11y)（[#271](https://github.com/xmanrui/dsh-im/pull/271)）。
  Added optional, per-bot Feishu voice interaction, disabled by default. ASR transcripts enter the existing text pipeline, and the same turn's answer can be spoken alongside its text reply, including after step-streaming cards finish. Transcribed commands retain permission checks, while voice turns are isolated per Session to prevent cross-topic replies. Thanks to [@rosalynthompson32-a11y](https://github.com/rosalynthompson32-a11y) ([#271](https://github.com/xmanrui/dsh-im/pull/271)).
- 飞书机器人「更多设置」新增「语音交互」页，可配置凭据引用、ASR/TTS 模型和音色；刷新后恢复已保存配置，关闭开关立即保存。密钥由宿主凭据库解析，配置只保存引用名称。
  Added a Voice Interaction tab in Feishu bot More Settings for the credential reference, ASR/TTS models, and voice. Saved settings survive refresh, disabling is persisted immediately, and configuration stores only a reference to the credential resolved by the Host.

### Fixed / 修复

- 飞书审批在批准、拒绝或已处理后更新原卡片，用结果文字替换操作按钮并保留工具、参数和原因；按钮与文字审批均生效，继续保留原有文字回执。卡片更新失败不会重新提交审批，也不阻断后续审批（[#273](https://github.com/xmanrui/dsh-im/issues/273)）。
  Feishu approvals now update the original card after approval, rejection, or resolution, replacing action buttons with the outcome while retaining tool details, arguments, and reason. Both button and text decisions retain the existing text receipt. Card-update failures neither resubmit the decision nor block later approvals ([#273](https://github.com/xmanrui/dsh-im/issues/273)).
- 邮件审批等待场景的回归测试改为等待实际轮询条件，减少繁忙环境下固定延时造成的偶发失败（[#272](https://github.com/xmanrui/dsh-im/pull/272)）。
  The email pending-approval regression now waits for the actual polling condition, reducing timing-related failures caused by a fixed delay under load ([#272](https://github.com/xmanrui/dsh-im/pull/272)).

### Notes / 使用说明

- 语音交互需要自行准备可用的 ffmpeg 和 DashScope 凭据；默认使用 `qwen3-asr-flash`、`qwen3-tts-flash` 与 `Momo` 音色。启用后，音频会发往所配置的 ASR 服务，回复文本会发往 DashScope TTS；TTS 仅取空白归一化后的前 600 个字符。转写失败时保留不支持类型提示，语音合成失败不影响已发送的文字回复；缺失 ffmpeg 不会导致宿主进程崩溃。npm 安装不会自动安装 ffmpeg。
  Voice interaction requires an available ffmpeg installation and DashScope credential. Defaults are `qwen3-asr-flash`, `qwen3-tts-flash`, and the `Momo` voice. When enabled, audio is sent to the configured ASR service and reply text to DashScope TTS; speech uses only the first 600 characters after whitespace normalization. Transcription failures retain the unsupported-type notice, speech failures leave delivered text intact, and missing ffmpeg does not crash the Host. npm installation does not install ffmpeg.
- 审批卡修复不批量更新旧版本或进程重启前已发出的历史卡片。宿主兼容性声明仍为 DSH 0.1.7-alpha.1；升级后请重启 Host 并刷新设置页。
  The approval fix does not retroactively update cards from older versions or before a process restart. Host compatibility remains declared for DSH 0.1.7-alpha.1; restart the Host and refresh settings after upgrading.

## [4.28.1] - 2026-09-25

### Fixed / 修复

- 默认 IM 工作区改为按实际选择创建：仅加载渠道或使用自定义工作区时，不再生成未使用的 `$DSH_HOME/im` 空目录；机器人或会话选用默认目录、切回默认目录，以及恢复相关 Session 时按需准备目录。已有工作区选择与未分组 Session 行为不变，不自动删除历史目录，也不自动创建任意自定义路径（[#259](https://github.com/xmanrui/dsh-im/issues/259)、[#260](https://github.com/xmanrui/dsh-im/pull/260)）。
  The default IM workspace is now created when selected, rather than generating an unused `$DSH_HOME/im` directory while loading channels or using a custom workspace. Bot/conversation selection, switching back, and relevant Session recovery prepare the directory as needed. Existing workspace choices and ungrouped Session behavior are preserved; old directories are not deleted and arbitrary custom paths are not created automatically ([#259](https://github.com/xmanrui/dsh-im/issues/259), [#260](https://github.com/xmanrui/dsh-im/pull/260)).
- 飞书「实时直播」在需要话题内回复的回合自动使用实时过程卡，让过程和最终答案留在同一话题，避免原生思考过程出现在群聊主时间线。私聊和非话题群聊继续使用原生思考过程，不修改机器人的已保存展示模式。感谢 [@TonyWu2333](https://github.com/TonyWu2333)（[#244](https://github.com/xmanrui/dsh-im/issues/244)、[#265](https://github.com/xmanrui/dsh-im/pull/265)）。
  Feishu Live process mode now uses a streaming process card for turns that must reply inside a topic, keeping progress and the final answer in that topic instead of posting native thinking progress to the main group timeline. Private and non-topic chats retain native thinking messages, and saved bot presentation settings are unchanged. Thanks to [@TonyWu2333](https://github.com/TonyWu2333) ([#244](https://github.com/xmanrui/dsh-im/issues/244), [#265](https://github.com/xmanrui/dsh-im/pull/265)).
- 微信图片与文件的 CDN 上传使用延迟创建、独立管理的网络分发器，避免宿主全局分发器导致成功响应缺少 `x-encrypted-param` 而上传失败；继续遵循环境代理配置，控制器关闭时释放资源，保留现有 JSON 请求和上传重试行为（[#270](https://github.com/xmanrui/dsh-im/issues/270)）。
  Weixin image/file CDN uploads now use a lazy, privately managed dispatcher, avoiding failures when the Host's global dispatcher loses `x-encrypted-param` from otherwise successful responses. Environment proxy settings remain honored, resources are released on controller close, and existing JSON requests and upload retry behavior are preserved ([#270](https://github.com/xmanrui/dsh-im/issues/270)).

### Changed / 变更

- CI 增加 Windows 工作区回归检查，覆盖默认目录创建、工作区切换、绑定恢复及相关并发场景；同步中英文 README 的官方 Token 赞助说明。
  Added Windows CI regression coverage for workspace creation, switching, binding recovery, and related concurrency cases, and clarified official token sponsorship wording in both READMEs.

### Compatibility / 兼容性

- 插件宿主兼容性元数据保持 DSH 0.1.7-alpha.1，不扩大为未经验证的版本范围。升级插件后请重启 Host 并刷新设置页。
  Host compatibility metadata remains declared for DSH 0.1.7-alpha.1 without expanding to unverified versions. Restart the Host and refresh settings after upgrading.

## [4.28.0] - 2026-09-24

### Fixed / 修复

- 飞书分步流式卡片按实际表格数量拆分正文与折叠面板，保留完整表格；重新分片时同步已有卡片，并隔离审批前后的卡片，避免超限、内容缺失或覆盖历史过程。感谢 [@C3H3-AI](https://github.com/C3H3-AI)（[#255](https://github.com/xmanrui/dsh-im/pull/255)）。
  Feishu step-streaming cards split answers and folded panels by their actual table count while preserving complete tables. Existing chunks are synchronized after redistribution, and cards before an interaction remain isolated from later updates. Thanks to [@C3H3-AI](https://github.com/C3H3-AI) ([#255](https://github.com/xmanrui/dsh-im/pull/255)).
- 飞书支持读取转发卡片中的可见文字，私聊仅提及机器人时可打开菜单，并沿用命令权限检查；语音、视频、表情和无可读文字的卡片保留不支持类型提示。感谢 [@C3H3-AI](https://github.com/C3H3-AI)（[#254](https://github.com/xmanrui/dsh-im/pull/254)）。
  Feishu now reads visible text from forwarded cards and opens the menu for a bare private mention with command permissions enforced. Unsupported audio, video, stickers, and unreadable cards retain their existing notice. Thanks to [@C3H3-AI](https://github.com/C3H3-AI) ([#254](https://github.com/xmanrui/dsh-im/pull/254)).
- 修复私聊引用消息后仅提及机器人时，被误判为菜单命令的问题；允许聊天但禁止命令的用户仍可正常提交引用内容。
  Fixed quoted private mentions being classified as menu commands, so users who may chat but cannot run commands can still submit quoted content.

### Notes / 使用说明

- 多表格修复覆盖分步流式卡片及复用该流程的会话镜像。表格数量拆分保持表头、分隔行和数据完整；原有过程摘要和字节预算仍生效，不新增单个超大表格的分页能力，也不将该路径的表格上限推广到所有飞书接口。
  The multi-table fixes cover step-streaming cards and Session mirrors using the same rendering path. Table-count splitting preserves headers, separators, and rows; existing process summaries and byte budgets still apply. This does not add pagination for a single oversized table or generalize this path's table limit to every Feishu API.
- 宿主兼容性声明保持 DSH 0.1.7-alpha.1，未扩展未经验证的版本范围。升级后请重启 Host 并刷新设置页；旧版 DSH 请继续使用对应的历史插件版本。
  Host compatibility remains declared for DSH 0.1.7-alpha.1 without expanding to unverified versions. Restart the Host and refresh settings after upgrading; older DSH installations should use the corresponding historical plugin version.

## [4.27.0] - 2026-09-23

### Added / 新增

- Matrix 新增按机器人、房间隔离的本机群聊记录。在需要提及的群聊中，未点名机器人的发言不会单独触发回复，但后续提及或引用提问可附带当天尚未注入的背景；背景带时间、发言者和明确边界，机器人自己的发言不作为其他成员的背景。感谢 [@Dong09](https://github.com/Dong09)（[#256](https://github.com/xmanrui/dsh-im/pull/256)）。
  Added local Matrix room records isolated by bot and room. In mention-gated groups, unaddressed chatter does not trigger replies by itself, but a later mention or quoted question can include pending same-day background with timestamps, speakers, and explicit delimiters. The bot's own messages are excluded from other-member background. Thanks to [@Dong09](https://github.com/Dong09) ([#256](https://github.com/xmanrui/dsh-im/pull/256)).
- 记录按事件 ID 去重并保存已注入标记，重启后可继续使用；默认每房间保留最近 2000 条，每次背景选择默认最多 50 条、目标字符预算 8000，优先保留较新的发言。新增 `roomContextEnabled`、`roomContextLimit`、`roomContextMaxChars` 和 `roomContextTzOffsetMinutes` 配置字段，并提供记录层的文本、发言者及时间范围查询能力。
  Room records deduplicate event IDs and persist consumed markers across restarts. Defaults retain the latest 2000 entries per room and select up to 50 background entries with a target 8000-character budget, preferring newer messages. Added `roomContextEnabled`, `roomContextLimit`, `roomContextMaxChars`, and `roomContextTzOffsetMinutes` configuration fields, plus record-layer queries by text, speaker, and time range.

### Fixed / 修复

- 修复飞书状态文件一次写入失败后，后续消息持续失败的问题；本次写入仍正常报错，文件恢复可写后，后续消息无需重启机器人即可继续处理（[#250](https://github.com/xmanrui/dsh-im/issues/250)）。
  Fixed a Feishu state-file write failure permanently blocking subsequent messages. The failed write still reports its error, while later messages recover once the file becomes writable, without restarting the bot ([#250](https://github.com/xmanrui/dsh-im/issues/250)).
- Matrix 不再仅凭房间只有两名成员就将其视为私聊，避免普通小群绕过提及要求；启动时清理缺少账号直接会话信息或路由依据的旧分类，邀请处理区分直接会话标记。
  Matrix no longer treats a two-member room as a direct chat solely by member count, preserving mention requirements for ordinary small groups. Startup discards stale classifications without account direct-chat data or routing evidence, and invitation handling distinguishes direct-chat flags.

### Compatibility / 兼容性

- 更新面板补充 4.27.0 的宿主版本提示：最低基线为 DSH 0.1.7-alpha.1；当前实际验证并在插件元数据中声明的版本仍为 0.1.7-alpha.1，更新宿主版本需另行验证。旧版 DSH 请继续使用 dsh-im 4.25.0；升级后重启 Host 并刷新设置页。
  Added the 4.27.0 Host-version notice to the update panel. The minimum baseline is DSH 0.1.7-alpha.1; this remains the version actually verified and declared in plugin metadata, while newer Host releases require separate validation. Older DSH users should stay on dsh-im 4.25.0. Restart the Host and refresh settings after upgrading.

### Notes / 使用说明

- Matrix 群聊背景记录默认开启，会在机器人目录的 `matrix-history.json` 中保存本机明文记录，并可能随后发送给模型；请按群成员的隐私预期使用。可通过 `roomContextEnabled: false` 停止新增记录与背景注入，但不会自动删除已有记录。背景按房间共享，不按发言者或 Session 单独分隔，也不是群聊全量历史归档。
  Matrix room context is enabled by default. Plaintext records are stored locally in the bot's `matrix-history.json` and may later be sent to the model; use according to participants' privacy expectations. `roomContextEnabled: false` stops new recording and background injection without deleting existing records. Background is shared per room rather than isolated by speaker or Session, and is not a complete room-history archive.
- Matrix 仍为实验性渠道，本次未进行真实 homeserver／Element 互通测试；4.25.0 所述设备验证、密钥备份、SSSS 和附件加密限制仍然适用。
  Matrix remains experimental, with no live homeserver/Element interoperability test in this release. The device-verification, key-backup, SSSS, and attachment-encryption limitations documented for 4.25.0 still apply.

## [4.26.0] - 2026-09-23

### Compatibility / 兼容性与升级提示

- 本版仅面向 **DSH 0.1.7-alpha.1** 的 Session V4 契约，并更新插件兼容性声明。请先升级 DSH，再升级 dsh-im，随后重启 Host 并刷新设置页；使用旧版 DSH 的用户请保留 dsh-im 4.25.0。本版不新增旧宿主兼容分支，也不承诺未经验证的后续版本。
  This release targets the Session V4 contract in **DSH 0.1.7-alpha.1** and updates the compatibility manifest. Upgrade DSH first, then dsh-im, restart the Host, and refresh settings. Users on older DSH versions should stay on dsh-im 4.25.0. No new legacy-Host compatibility branches or unverified future-version guarantees are added.

### Added / 新增

- 主动投递服务、`message.send` RPC 及 HTTP 接口新增可选 `format: "markdown"`。飞书私聊和群聊可发送 Markdown 卡片，保留原始文本与换行；默认仍为纯文本，其他渠道沿用原有行为，不保证 Markdown 渲染。感谢 [@alpacachen](https://github.com/alpacachen)（[#246](https://github.com/xmanrui/dsh-im/pull/246)）。
  Added optional `format: "markdown"` to proactive delivery, the `message.send` RPC, and HTTP endpoint. Feishu DMs and groups can receive Markdown cards with original text and line breaks preserved. Plain text remains the default; other channels retain their existing behavior without a Markdown-rendering guarantee. Thanks to [@alpacachen](https://github.com/alpacachen) ([#246](https://github.com/xmanrui/dsh-im/pull/246)).
- 新增基于真实 DSH JSONL 持久化的上下文验证脚本，覆盖普通消息、来源、指导语、引用和结构化内容，以及关闭重开后的后续回合；脚本随 npm 包发布。
  Added a real-DSH JSONL persistence verification script covering plain, source, guidance, quoted, and structured messages, including reopening and subsequent turns. The script is included in the npm package.

### Fixed / 修复

- 注入的来源信息、会话指导语及引用上下文改用 `source.kind: "plugin:dsh-im"`，适配 DSH 0.1.7-alpha.1 对消息来源的要求，修复 `SessionFormatError: format v4 message requires a producer-owned source kind`。保留用户正文、消息顺序及指导语去重行为；历史 Session 迁移仍由宿主负责。
  Injected source, guidance, and quoted context now use `source.kind: "plugin:dsh-im"`, fixing `SessionFormatError: format v4 message requires a producer-owned source kind` on DSH 0.1.7-alpha.1. User content, message ordering, and guidance deduplication are preserved; historical Session migration remains the Host's responsibility.

### Changed / 变更

- 优化图片输入设置的字段对齐、保存与重试区域，将说明收纳至带无障碍描述的帮助提示；原有限制值和默认行为不变。
  Aligned image-input settings and save/retry controls, moving explanatory text into an accessible help tooltip without changing limits or defaults.
- 完善中英文主动投递文档与回归测试：Markdown 卡片不静默截断或自动拆分；发送失败或结果不确定时不自动改发纯文本，避免重复投递。
  Expanded bilingual proactive-delivery documentation and regression coverage. Markdown cards are not silently truncated or automatically split, and failures or uncertain outcomes do not trigger automatic plain-text retries that could duplicate delivery.

## [4.25.0] - 2026-09-22

### Added / 新增

- 新增 Matrix 实验性渠道，可使用 homeserver 与访问令牌，或用户 ID 与密码接入；支持私聊、群聊提及、线程回复、HTML 白名单富文本、编辑式流式输出、输入状态及图片和结果文件回传。纳入现有机器人设置、工作区与会话绑定、访问策略和主动投递体系。感谢 [@Dong09](https://github.com/Dong09)（[#245](https://github.com/xmanrui/dsh-im/pull/245)）。
  Added an experimental Matrix channel using a homeserver with an access token or a user ID/password. It supports DMs, room mentions, thread replies, allowlisted HTML, edit-based streaming, typing indicators, and image/result-file delivery, integrated with bot settings, workspaces, Session bindings, access policies, and proactive delivery. Thanks to [@Dong09](https://github.com/Dong09) ([#245](https://github.com/xmanrui/dsh-im/pull/245)).
- Matrix 加入本机加密状态存储、设备密钥注册、Megolm 房间消息加解密及设备间密钥共享的实验性实现，依赖固定版本 `@matrix-org/olm@3.2.15`。配置支持 `off`、默认 `optional` 和 `required`；引擎启动失败时，optional 模式跳过收到的加密消息，required 模式拒绝启动连接。
  Added experimental Matrix local crypto state, device-key registration, Megolm room-message encryption/decryption, and to-device key sharing using pinned `@matrix-org/olm@3.2.15`. Configuration supports `off`, default `optional`, and `required`: failed crypto startup skips incoming encrypted traffic in optional mode and prevents connection startup in required mode.

### Changed / 变更

- 「检查更新」改为图标按钮，通过悬停提示与无障碍标签展示检查中、可更新版本、安装中或待手动重启状态，保留原有更新对话框和确认流程。
  Replaced the update-check text button with an icon whose tooltip and accessible label reflect checking, the available version, installation, or a required manual restart, preserving the update dialog and confirmation flow.
- Matrix 导航明确标注「实验功能」，补充渠道标识、中英文文案、集成说明及自动化测试，并纠正 README 中「始终跳过加密房间」的旧描述。
  Marked Matrix as experimental in navigation, added channel branding, Chinese/English copy, integration notes, and automated tests, and corrected the outdated README statement that encrypted rooms are always skipped.

### Known limitations / 已知限制

- Matrix 加密仍为实验性能力，本次发布验证不包含真实 homeserver／Element 互通测试；未实现交互式设备验证、密钥备份及 SSSS，媒体附件内容也未做附件级加密。请仅在非敏感测试场景试用，不要将其视为完整的端到端保密保障。
  Matrix encryption remains experimental; release validation does not include live homeserver/Element interoperability testing. Interactive device verification, key backup, SSSS, and attachment-content encryption are not implemented. Use only for non-sensitive testing, not as a complete end-to-end confidentiality guarantee.

## [4.24.1] - 2026-09-22

### Fixed / 修复

- 飞书话题首文在同一 AI 会话成功使用后不再重复注入；命令、拒绝消息及读取或请求失败不提前消耗首文，`/new`、会话切换或失效重建后重新附带。普通群聊和私聊的主动引用保持原有行为。感谢 [@yangzhe1991](https://github.com/yangzhe1991) 提出并实现首文去重（[#222](https://github.com/xmanrui/dsh-im/pull/222)）。
  Feishu topic roots are no longer injected repeatedly after a successful turn in the same AI session. Commands, rejected messages, and failed lookups or requests do not consume the root; new, switched, or rebuilt sessions receive it again. Explicit quotes in ordinary groups and direct chats retain their existing behavior. Thanks to [@yangzhe1991](https://github.com/yangzhe1991) for proposing and implementing topic-root deduplication ([#222](https://github.com/xmanrui/dsh-im/pull/222)).

- 修复通过终端或插件市场升级、回退后，历史更新记录持续阻止后续安装的问题。重启 Host 后，在无安装锁、当前安装校验通过且运行版本与已安装版本一致时重新判定可恢复状态；不删除历史记录，也不绕过安装锁、版本兼容性、确认有效期或手动重启要求。
  Fixed historical update jobs blocking later installs after an external upgrade or rollback. After restarting the Host, recovery is derived from a valid current installation with no install lock and matching running/installed versions. History remains intact, and install locks, compatibility checks, confirmation expiry, and manual-restart requirements remain enforced.
- 更新面板优先展示本次检查结果，区分「最新版本」「上次更新目标」与正在安装的「目标版本」，避免旧任务遮盖新版本或错误状态；打开符合条件的面板时重新检查更新，手动命令不再沿用可恢复历史任务的旧目标。已被旧版更新器阻塞的用户，需先通过手动命令或插件市场安装含修复的版本，再手动重启 Host。
  The update panel now prioritizes fresh checks and distinguishes Latest version, Previous update target, and an active Target version, so old jobs cannot hide available updates or errors. Eligible panel openings check again, and manual commands ignore recoverable historical targets. Users already blocked by the old updater must first install a fixed version through the manual command or plugin market, then restart the Host manually.

### Changed / 变更

- 统一机器人卡片设置入口：卡片顶部使用齿轮与箭头展开或收起常用配置，「更多设置」移入展开区域；调整图标间距，保留键盘操作、展开状态提示及收起后隐藏控件的无障碍行为。
  Unified bot-card settings entry points: a gear-and-chevron control expands or collapses common settings, with More settings inside the expanded area. Balanced icon spacing while preserving keyboard interaction, expanded-state announcements, and accessibility hiding for collapsed controls.
- 补充飞书话题首文去重贡献者信息，并完善飞书实时直播功能对 [@ShawnKung](https://github.com/ShawnKung) 的文档致谢（[#243](https://github.com/xmanrui/dsh-im/pull/243)）。
  Added contributor credits for Feishu topic-root deduplication and completed the documentation attribution to [@ShawnKung](https://github.com/ShawnKung) for Feishu Live process mode ([#243](https://github.com/xmanrui/dsh-im/pull/243)).

## [4.24.0] - 2026-09-21

### Added / 新增

- 飞书任务过程展示新增「实时直播」，使用原生思考过程消息展示当前任务的推理片段、工具调用、参数及结果，最终答案仍以普通富文本消息单独发送。推理通过实时连接补充，工具进度和最终结果沿用历史轮询；过程写入采用非阻塞批处理，原生过程不可用时不影响最终答案。已有机器人不自动切换展示模式。感谢 [@ShawnKung](https://github.com/ShawnKung)（[#224](https://github.com/xmanrui/dsh-im/pull/224)）。
  Added Feishu Live process mode, using native thinking-process messages for the current task's reasoning snippets, tool calls, arguments, and results while delivering the final answer separately as rich text. Live connections supplement reasoning; history polling remains authoritative for tool progress and final results. Process writes use non-blocking batches, and process failures do not suppress the answer. Existing bots keep their selected presentation mode. Thanks to [@ShawnKung](https://github.com/ShawnKung) ([#224](https://github.com/xmanrui/dsh-im/pull/224)).
- Telegram 新增每机器人独立的「会话行为 → 思考过程留痕」开关，将推理摘要和工具调用摘要作为独立的 💭／🔧 消息保留，最终答案另发。默认开启（含未设置该字段的已有机器人），显式关闭后恢复原有回复方式；中间留痕发送失败不阻止最终答案，长任务继续显示输入状态。留痕可能包含工具参数摘要，请按聊天受众选择是否开启。感谢 [@gin-melodic](https://github.com/gin-melodic)（[#203](https://github.com/xmanrui/dsh-im/pull/203)、[#235](https://github.com/xmanrui/dsh-im/pull/235)）。
  Added a per-bot Telegram Thinking traces toggle under Conversation behavior. Reasoning and tool-call summaries remain as separate 💭/🔧 messages, followed by the final answer. It defaults on, including existing bots without the field; explicitly disabling it restores the previous reply presentation. Trace-send failures do not prevent the final answer, and long-running tasks keep the typing indicator. Traces can include tool-argument summaries, so choose the setting for the chat's audience. Thanks to [@gin-melodic](https://github.com/gin-melodic) ([#203](https://github.com/xmanrui/dsh-im/pull/203), [#235](https://github.com/xmanrui/dsh-im/pull/235)).

### Fixed / 修复

- 飞书直播以历史记录恢复最终答案和任务结束，避免断线重连后的较新实时事件跳过尚未补回的回复。提前到达的推理采用有界暂存，确认请求与回合归属后才展示；同时处理排序、去重及结束后的迟到片段，避免排队请求混入上一轮推理。最终答复使用最后一步定稿内容，长工具参数和结果按协议限制截断。
  Feishu live replies recover final answers and completion from history so newer events after a reconnect cannot skip missing replies. Early reasoning is buffered within fixed limits and displayed only after request/turn correlation, with ordering, deduplication, and late-frame handling that keep queued requests separate. Final replies use the last step's canonical text, and long tool arguments/results are bounded for the protocol.
- Telegram 留痕模式的最终答案保留 Markdown、代码块及原有空行，不再按空段落预先拆分；纯文本重试保留原文，只重发明确失败的未发送部分，投递结果不确定时不自动重发。
  Telegram thinking-mode final answers preserve Markdown, fenced code, and original blank lines without pre-splitting on empty paragraphs. Plain-text retries preserve content and resend only the definitively failed unsent tail; uncertain delivery is not automatically retried.
- 修复邮件模型输入丢失主题等邮件头、腾讯 Agent 邮箱附件下载返回加载函数而非内容的问题；初始化收信游标只读取邮件列表摘要，不提前下载可能不在白名单内的正文。保留纯正文命令解析和现有延迟图片处理。感谢 [@C3H3-AI](https://github.com/C3H3-AI)（[#233](https://github.com/xmanrui/dsh-im/pull/233)）。
  Fixed email model input losing subject/header context and Agent Mail attachment loaders returning functions instead of bytes. Initial receive cursors now use list summaries without fetching potentially disallowed message bodies. Plain-body command parsing and deferred image handling are preserved. Thanks to [@C3H3-AI](https://github.com/C3H3-AI) ([#233](https://github.com/xmanrui/dsh-im/pull/233)).
- 补齐飞书原生斜杠命令面板中的工作区、会话绑定、模型、推理等级、预设、停止、补充指令、批量输入、版本及修复等现有命令入口，同步命令文档与测试。
  Completed Feishu's native slash-command panel entries for existing workspace, Session binding, model, reasoning effort, preset, stop, steer, batch-input, version, and repair commands, with updated documentation and tests.

### Changed / 变更

- 设置页 GitHub 入口改用 Logo，保留链接及无障碍标签；补充飞书直播、Telegram 留痕及邮件回归测试和验证记录。移除带固定本机路径和聊天目标的 Telegram 实测脚本，并将 npm 包内的脚本收紧为明确的验证脚本清单。
  Replaced the settings-page GitHub text button with a logo while preserving its link and accessible label, and expanded Feishu live-process, Telegram trace, and email regression coverage and verification records. Removed the machine-specific Telegram live-test script and restricted packaged scripts to an explicit verification-script allowlist.

## [4.23.0] - 2026-09-20

### Added / 新增

- 新增邮件渠道，支持标准 IMAP/SMTP 邮箱及通过官方 `@tencent-qqmail/agently-cli` 接入腾讯 Agent 邮箱；可在设置页管理多邮箱、发件人白名单、工作区、模型和 Session 绑定，并收发邮件正文及附件（[#223](https://github.com/xmanrui/dsh-im/pull/223)，感谢 [@C3H3-AI](https://github.com/C3H3-AI)）。邮件线程与绑定持久化，补齐分页收信、失败重试、限流退避和自动回复防循环。渠道默认可用，但需自行绑定邮箱；可用 `EMAIL_CHANNEL_ENABLED=0` 或 `emailChannelEnabled: false` 关闭，保留已有配置。空白名单不接收任何发件人的请求；邮件发件人地址可被伪造，白名单不能替代身份认证，应仅接入可信来源。
  Added an email channel for standard IMAP/SMTP mailboxes and Tencent Agent Mail through the official `@tencent-qqmail/agently-cli`, with multiple mailboxes, sender allowlists, workspace/model selection, Session bindings, and text/attachment delivery ([#223](https://github.com/xmanrui/dsh-im/pull/223), thanks to [@C3H3-AI](https://github.com/C3H3-AI)). Threads and bindings persist across restarts, with paginated polling, bounded retries, rate-limit backoff, and automatic-reply loop prevention. The channel is available by default but requires mailbox setup; `EMAIL_CHANNEL_ENABLED=0` or `emailChannelEnabled: false` disables it without deleting configuration. Empty allowlists admit nobody. Sender addresses can be spoofed, so allowlists are not identity authentication; connect only trusted sources.
- 新增「通用设置 → 附件 → 图片输入」四项限制：原图单张大小、单条消息图片数、模型单张图片预算和模型总图片预算。默认分别为 30 MB、20 张、5 MB 和 20 MB，设置对后续消息生效，仍受平台及 Host 限制。
  Added four Image input limits under General settings → Attachments: original image size, images per message, per-image model budget, and total model budget. Defaults are 30 MB, 20 images, 5 MB, and 20 MB respectively. Changes apply to subsequent messages and remain subject to platform and Host limits.

### Changed / 变更

- 图片原文件先保存到 Session 工作区并遵循附件保留设置；使用可选 `sharp` 为模型生成预算内的缩放或压缩副本。无法压缩、超出预算、缺少可选编解码器或 Host 拒绝图片输入时，按适用条件回退为工作区文件，并明确提示未直接提供给模型的图片，不丢弃已保存的原图。
  Original images are saved to the Session workspace under attachment-retention rules before optional `sharp` resizing/compression produces model copies within budget. Images fall back to workspace files where applicable when compression is unavailable or fails, budgets are exceeded, or the Host rejects image input, with explicit notices identifying images not directly provided to the model; saved originals are retained.
- 将连接诊断扩展到全部渠道，保留失败阶段、可识别的底层原因、HTTP 状态、时间和回滚结果，设置页可展开并复制诊断信息。诊断引用可关联 Host 日志；对外仅输出允许的诊断字段，并保留删除成功但清理失败的警告。
  Extended connection diagnostics across all channels, preserving failure stages, recognized underlying causes, HTTP status, timing, and rollback results, with expandable/copyable details in settings. References correlate with Host logs; public diagnostics use admitted fields and retain warnings when removal succeeds but cleanup fails.

### Fixed / 修复

- 修复 WhatsApp 群聊中其他成员通过 LID 提及或引用回复机器人时没有响应的问题（[#221](https://github.com/xmanrui/dsh-im/issues/221)）。恢复 3.0.3 的账号别名识别，使用当前连接提供的手机号 ID 和 LID 识别提及、回复及自聊；继续遵守现有群聊访问权限。
  Fixed WhatsApp group mentions and quoted replies from other members being ignored when they address the bot by LID ([#221](https://github.com/xmanrui/dsh-im/issues/221)). Restored the account-alias matching from 3.0.3, using the current connection's phone-number ID and LID for mentions, replies, and self-chat while preserving existing group access policies.
- 工具已完成处理但没有文本或文件回复时，返回明确的完成提示，不再误报模型空回复；文件交付失败仍报告原错误，并为回合失败补充关联信息。
  Completed tool-only turns without text or file replies now return an explicit completion notice instead of being misreported as empty model responses. Artifact handoff failures retain their original errors, and turn failures include correlation details.
- 邮件渠道可用性查询补齐请求载荷，修复设置页查询失败；同步生成的客户端与 Host 产物，并补充邮件、图片输入、连接诊断和 WhatsApp 的回归测试。
  Added the request payload to email availability queries to fix settings-page checks, synchronized generated client/Host artifacts, and expanded email, image-input, connection-diagnostic, and WhatsApp regression coverage.

## [4.22.0] - 2026-09-19

### Added / 新增

- 新增可选客户端服务 `dshImClient` v1，宿主可通过 `render({ preferredSectionId })` 嵌入完整 IM 管理面板，并用 `setSettingsVisible(boolean)` 隐藏或恢复本客户端的设置入口；`settingsVisible()` 返回入口是否已注册（[#231](https://github.com/xmanrui/dsh-im/issues/231)）。默认仍保留「设置 → IM机器人」，不需要迁移数据或新增配置，Host 侧主动投递服务 `dshIm` 不变。
  Added the optional `dshImClient` v1 client service so shells can embed the complete IM management panel with `render({ preferredSectionId })`, hide or restore this client's settings entry with `setSettingsVisible(boolean)`, and check its registration with `settingsVisible()` ([#231](https://github.com/xmanrui/dsh-im/issues/231)). Settings → IM bots remains the default without migration or new configuration; the Host-side `dshIm` delivery service is unchanged.
- 嵌入面板复用现有 RPC、权限、目录选择和语言服务，保持组件身份稳定，避免重复渲染重置未保存表单；支持首次栏目选择、语言刷新及局部错误重试。入口开关只作用于当前客户端内存，不影响其他浏览器或机器人运行；不支持新服务的旧宿主继续使用原设置页。接口 v1 面向单个活跃管理面板，不提供多面板状态同步。
  Embedded panels reuse existing RPC, permissions, directory selection, and locale services, with stable component identity to preserve unsaved forms across re-renders. Initial-section selection, locale updates, and local error recovery are supported. Visibility is in-memory and client-local, without affecting other browsers or running bots; older Hosts retain the original settings page. V1 targets one active management panel and does not synchronize multiple panels.

### Changed / 变更

- 新机器人默认工作目录由 Host 当前目录改为 `$DSH_HOME/im`，未设置时使用 `~/.dsh/im`，默认目录自动创建；显式 `workspace` 优先，`dshHome` 可覆盖环境变量。默认目录中的新 Session 保持「未分组」，切换到其他目录时继续使用原工作区分组机制，切回默认目录后新 Session 恢复未分组。已有机器人的目录和历史 Session 不自动迁移；各机器人仍独立保存聊天与 Session 的绑定。
  New bots default to `$DSH_HOME/im` instead of the Host's current directory, falling back to `~/.dsh/im`; the default directory is created automatically. Explicit `workspace` takes precedence, and `dshHome` overrides the environment variable. New Sessions in the default directory remain ungrouped, while other directories retain workspace grouping. Existing bot directories and historical Sessions are not migrated, and each bot retains independent chat-to-Session bindings.

### Fixed / 修复

- 默认 IM 目录的 `/sessionlist`／`/sessions` 识别工作目录匹配的未分组 Session，排除已归属其他工作区分组的会话；普通未分组 Session 可按 ID 或当前列表序号绑定，重启后也能重新识别已有绑定。路径比较兼容符号链接，默认目录创建失败时直接报告错误，不退回 Host 当前目录。
  `/sessionlist` and `/sessions` include ungrouped Sessions whose working directory matches the default IM directory, without including Sessions assigned to other workspace groups. Ordinary ungrouped Sessions can be bound by ID or current-list index, and existing bindings remain recognizable after restart. Path matching supports symbolic links; default-directory creation errors are reported instead of falling back to the Host's current directory.

### Documentation / 文档

- 新增中英文客户端接入文档并随 npm 包发布，记录服务契约、生命周期、权限及兼容边界；同步默认目录与会话命令说明。仓库提供独立的 `integrations/desktop-panel` 可选桌面接入示例，它不随 dsh-im npm 包发布，也不代表桌面端已内置入口。
  Added a bilingual client integration guide to the npm package covering the service contract, lifecycle, permissions, and compatibility, and updated default-directory and Session-command guidance. The repository includes an optional standalone `integrations/desktop-panel` integration; it is excluded from the dsh-im npm package and does not imply a built-in desktop entry.

## [4.21.2] - 2026-09-17

### Fixed / 修复

- 修复 Lark（飞书国际版）应用无法通过手动凭据入口接入的问题（[#212](https://github.com/xmanrui/dsh-im/issues/212)）。飞书设置页的「手动接入」可选择飞书或 Lark，绑定请求将所选平台传给 Host，并沿用该平台进行凭据验证、配置保存及 HTTP／WebSocket 连接；未指定平台的旧请求仍默认使用飞书。感谢 [@alpacachen](https://github.com/alpacachen) 的代码与测试贡献（[#219](https://github.com/xmanrui/dsh-im/pull/219)）。
  Fixed Lark (international Feishu) applications being unable to connect through manual credential binding ([#212](https://github.com/xmanrui/dsh-im/issues/212)). The Feishu settings page now offers a Feishu/Lark platform selector for manual setup. The selected platform is passed to the Host and used for credential verification, persisted configuration, and HTTP/WebSocket connections; existing requests without a platform still default to Feishu. Thanks to [@alpacachen](https://github.com/alpacachen) for code and tests in [#219](https://github.com/xmanrui/dsh-im/pull/219).
- 切换应用平台时清空已填写的 App ID、App Secret 和旧错误，避免跨平台复用凭据；提交期间锁定表单及平台选择，防止重复提交。补齐 Lark 绑定表单和成功提示的中英文文案，Host 仅接受 `feishu`、`lark` 或省略的平台值。
  Changing platforms clears the entered App ID, App Secret, and previous error to avoid reusing credentials across platforms. The form and platform selector are locked during submission to prevent duplicate requests. Added bilingual Lark form and success messages; the Host accepts only `feishu`, `lark`, or an omitted platform value.

### Documentation / 文档

- 补充自定义域名访问 IM 管理接口时的 HTTP 403 排查说明：通过 DSH 的 `--trusted-host` 配置域名及可选端口，反向代理需保留匹配的 Host／Origin，浏览器认证仍然必需；该文档更新不放宽访问控制。
  Documented HTTP 403 troubleshooting for IM management through custom domains: configure the domain and optional port with DSH's `--trusted-host`, preserve matching Host/Origin values through reverse proxies, and retain browser authentication. This documentation update does not relax access controls.
- 扩展局域网管理验证脚本，覆盖回环地址、局域网地址、自定义域名、未认证访问及 Host／Origin 不匹配，并等待渠道初始化完成后检查业务状态；新增 Lark 界面、RPC、配置持久化和运行时域名选择的回归测试。
  Expanded the LAN management verification script to cover loopback, LAN addresses, custom domains, unauthenticated access, and Host/Origin mismatches, waiting for channel initialization before checking business status. Added Lark regression tests for the UI, RPC validation, persisted configuration, and runtime domain selection.

## [4.21.1] - 2026-09-16

### Fixed / 修复

- 修复钉钉群聊和私聊中引用图片、文件、富文本图片及音视频附件时，模型只收到引用说明而无法读取实际内容的问题（[#211](https://github.com/xmanrui/dsh-im/issues/211)）。仅解析直接引用的一层附件，保留当前消息附件并按下载引用去重；命令、权限校验与交互路由完成后才下载。缺少下载信息或下载失败时明确提示，不再把仅有元数据的请求送入模型。
  Fixed quoted images, files, rich-text images, and audio/video attachments in DingTalk group and direct chats reaching the model as descriptions without their actual content ([#211](https://github.com/xmanrui/dsh-im/issues/211)). Only the immediate quote is resolved, current attachments are preserved, and matching download references are deduplicated. Downloads happen after command, access, and interaction routing; missing references or failed downloads report an error instead of submitting metadata alone.
- 微信文件上传改为分块流式加密，由网络背压控制读取，减少整份密文复制。将固定 60 秒上传截止时间改为 60 秒无进展超时，持续传输的大文件不再因总耗时超过一分钟被中断；重试重新创建加密流，用户取消立即停止，失败不发送文件消息，并提供明确的上传超时提示。
  Weixin file uploads now encrypt in chunks with network backpressure, reducing whole-file ciphertext copies. A 60-second idle timeout replaces the fixed upload deadline, allowing transfers that continue making progress to exceed one minute. Retries recreate the encrypted stream, caller cancellation stops immediately, and failed uploads never send a file message and report an explicit timeout when stalled.
- IM 来源块与引用块按实际消息身份配对，在支持的 Host 中拆成独立、可折叠的 `dsh-im` 上下文行；用户消息保留自己的正文，引用材料排在提问之前，并发或在途消息不会串用来源。只选择 `botId`、`chatId` 或 `threadId` 时仍正确拆分，无法生成摘要时使用「来源」标题；不支持拆分或连接外部 Harness 时保留内联回退。
  IM source and quoted-reply blocks are paired by message identity and split into separate, collapsible `dsh-im` context rows on supported Hosts. User messages retain their own text, quotations precede the question, and concurrent or in-flight prompts cannot exchange sources. ID-only field selections still split correctly and use a Source label when no readable summary exists; unsupported Hosts and external Harness connections retain the inline fallback.
- `/补充指令`（`/steer`）按执行时的增强配置记录实际下达指令者的来源，卡片使用操作者身份，菜单和消息使用发送者身份，不再借用开启该回合的消息来源。感谢 [@Librazy](https://github.com/Librazy) 的实现、测试与文档贡献（[#204](https://github.com/xmanrui/dsh-im/pull/204)）。
  `/steer` captures enhancement settings when the correction is issued and records its actual author: the card operator or the menu/message sender, rather than the author of the turn's opening message. Thanks to [@Librazy](https://github.com/Librazy) for implementation, tests, and documentation in [#204](https://github.com/xmanrui/dsh-im/pull/204).

### Changed / 变更

- 上下文增强提示词登记为会话级动态提示词上下文，不再逐条消息重复，配置变化时重新渲染。提示词中的 `{{变量}}` 按部署注册的变量解析，未知或格式错误的变量会使当前步骤失败；是否保留动态上下文由 Host 部署策略决定。
  Context-enhancement guidance is registered as Session-level dynamic prompt context instead of repeating in each message, and re-rendered when its configuration changes. `{{variable}}` references use the deployment's registered template variables; unknown or malformed references fail the current step. Host deployment policy controls whether dynamic context is retained.

### Security / 安全

- 会话增强提示词仅来自渠道捕获的配置，不从用户消息中的仿造标签回读；关闭增强时清除登记。来源块采用受限字段识别，避免将形状不符的用户 JSON 误当成插件上下文。
  Session guidance comes only from configuration captured by the channel, never from lookalike tags in user text, and is cleared when enhancement is disabled. Source blocks use restricted-field recognition so unrelated user JSON is not mistaken for plugin context.

### Documentation / 文档

- 更新上下文增强说明和钉钉引用附件修复记录，补充消息配对、纠偏来源、实际附件内容、微信流式上传、超时重试及取消的回归测试。
  Updated context-enhancement guidance and DingTalk quoted-attachment repair notes, with regression tests for message pairing, correction provenance, actual attachment content, Weixin streaming uploads, timeout retries, and cancellation.

## [4.21.0] - 2026-09-16

### Added / 新增

- Telegram 单选型 Harness 提问支持 Inline Keyboard，点击按钮即可提交，编号文字回复仍然有效。多选、超过八个选项、按钮标签不可用或平台拒绝键盘时回退到文本流程；回调数据使用短编码并校验 Telegram 的 64 字节限制（[#199](https://github.com/xmanrui/dsh-im/issues/199)）。感谢 [@wings1848](https://github.com/wings1848) 的代码、文档与测试贡献（[#206](https://github.com/xmanrui/dsh-im/pull/206)）。
  Telegram single-choice Harness questions now support inline keyboards: press a button to answer, or keep replying with numbered text. Multi-select questions, more than eight options, unusable button labels, or keyboard rejection fall back to text. Compact callback data is validated against Telegram's 64-byte limit ([#199](https://github.com/xmanrui/dsh-im/issues/199)). Thanks to [@wings1848](https://github.com/wings1848) for code, documentation, and tests in [#206](https://github.com/xmanrui/dsh-im/pull/206).

### Fixed / 修复

- Harness 提问允许 IM 与 Web／CLI 同时呈现，先作答者生效；另一端及时收回待答项和卡片。取消范围限定到当前问题，避免 IM 正常作答误取消外层 `run_code`／PTC 执行，真正的上游取消仍会传递。
  Harness questions can be presented on IM and Web/CLI together, with the first answer winning and the other side's pending question and card retired. Cancellation is scoped to the current question, so an IM answer does not cancel an enclosing `run_code`/PTC execution, while genuine upstream cancellation still propagates.
- Telegram 卡片提交前等待展示完成，拒绝提交期间的重复点击；文字回答也会回收旧键盘，旧卡片不能回答后续问题。数字标签按钮直接提交所选选项，不再把标签误解析为位置序号；手动输入数字仍按位置选择。宿主应答链仅对 `NO_PROVIDER` 静默降级，其他错误保留日志。
  Telegram card answers wait for presentation to finish, reject duplicate presses during submission, and retire keyboards after text answers so stale cards cannot answer later questions. Numeric button labels submit the exact selected option instead of being reinterpreted as positions; typed numbers still select by position. Only `NO_PROVIDER` is silently handled in the host answerer chain; other failures are logged.
- 批量输入收集期间，带引用的 `/send`、`/cancel` 和重复 `/batch` 正常提交、取消或报告进度；空闲时的 `/send`、`/cancel` 返回准确状态。命令携带的引用或附件不混入批量内容，会话标题取第一条已收录内容，而非插件框架句。首次开启批次仍需要纯文字 `/batch`。感谢 [@Librazy](https://github.com/Librazy) 的代码、文档与测试贡献（[#205](https://github.com/xmanrui/dsh-im/pull/205)）。
  During batch collection, quoted `/send`, `/cancel`, and repeated `/batch` commands submit, cancel, or report progress normally; idle `/send` and `/cancel` return accurate state messages. Command-carried quotes and attachments stay out of submissions, and Session titles use the first collected message rather than plugin framing. Starting a batch still requires plain-text `/batch`. Thanks to [@Librazy](https://github.com/Librazy) for code, documentation, and tests in [#205](https://github.com/xmanrui/dsh-im/pull/205).
- QQ 本地状态 JSON 损坏时，先以独占文件保存原始字节备份，再重建状态，避免机器人因解析失败无法启动（[#215](https://github.com/xmanrui/dsh-im/issues/215)）。恢复会重置该机器人的会话映射、消息去重和延迟投递记录，并在 Host 日志中提示；备份失败时保留原文件，读取、备份和写入失败分别通过管理接口报告。
  Corrupt QQ state JSON is backed up byte-for-byte to an exclusive file before state is rebuilt, allowing startup to recover from parse errors ([#215](https://github.com/xmanrui/dsh-im/issues/215)). Recovery resets that bot's Session mappings, message deduplication, and deferred-delivery records and reports this in Host logs. A failed backup preserves the original file; read, backup, and write failures retain distinct management-interface errors.
- 微信启动配置错误标明配置文件、从零开始的字段位置和校验原因，区分 JSON 语法、账号标识、重复账号、工作区及模型配置等问题；页面、复制诊断和参考号对应日志保持一致，不包含账号、配置值、凭据或本机绝对路径，并明确修复配置后需要重启 DSH。
  Weixin startup configuration errors identify the file, zero-based field position, and validation issue, distinguishing JSON syntax, account identity, duplicates, workspace, and model settings. The page, copied diagnostics, and correlated logs retain matching details without account identities, configuration values, credentials, or absolute local paths, and explain that DSH must restart after configuration repair.
- `dsh_im_return_file` 优先采用 Session 事件流观察到的活动回合，修复实际宿主不公开事件快照时误报 `artifact-context-required`、文件无法进入投递流程的问题；回合已结束或缺少活动证据时仍拒绝暂存。感谢 [@Dong09](https://github.com/Dong09) 的贡献（[#210](https://github.com/xmanrui/dsh-im/pull/210)）。
  `dsh_im_return_file` now prefers the active turn observed on the Session event stream, fixing `artifact-context-required` errors that blocked delivery when the host exposed no event snapshot. Staging still rejects closed turns or Sessions without activity evidence. Thanks to [@Dong09](https://github.com/Dong09) for [#210](https://github.com/xmanrui/dsh-im/pull/210).
- Telegram 移除机器人提及时使用原文偏移，避免 Unicode 大小写转换改变长度后残留提及或误删其他用户名，同时覆盖文字与媒体说明。
  Telegram mention removal uses original text offsets, avoiding retained mentions or damaged usernames when Unicode case conversion changes string length, for both text and media captions.

### Changed / 变更

- 将正常的模型思考强度说明移入帮助提示，失效配置仍在设置区显式提醒；统一 Slack、iMessage 的渠道图标与应用图标。
  Moved normal reasoning-effort guidance into the help tooltip while keeping unavailable-setting warnings visible, and aligned Slack and iMessage channel icons with their app icons.

### Security / 安全

- 减少动态正则与动态日志格式字符串，强化标识校验和配置目录错误处理；更新锁文件中的 `qs`、`sharp`／libvips 间接依赖，并将 CI Actions 固定到提交 SHA。感谢 [@johnslee1207-commits](https://github.com/johnslee1207-commits) 的代码、测试与基础设施贡献（[#214](https://github.com/xmanrui/dsh-im/pull/214)）。
  Reduced dynamic regular expressions and log format strings, strengthened identity validation and configuration-directory error handling, updated locked `qs` and `sharp`/libvips transitive dependencies, and pinned CI Actions to commit SHAs. Thanks to [@johnslee1207-commits](https://github.com/johnslee1207-commits) for code, tests, and infrastructure in [#214](https://github.com/xmanrui/dsh-im/pull/214).

### Documentation / 文档

- 同步中英文交互与批量命令说明、贡献者名单、渠道徽章和截图，并完善跨平台测试及 Windows 包校验兼容性。
  Updated bilingual interaction and batch-command guidance, contributor lists, channel badges, and screenshots, and improved cross-platform tests and Windows package verification.

## [4.20.2] - 2026-09-13

### Fixed / 修复

- 修复 Telegram 私聊在 `ask_user_question` 等待回答时，流式草稿心跳持续占用输入框、导致答案无法正常发送的问题（[#199](https://github.com/xmanrui/dsh-im/issues/199)）。需要提问或审批时，先停止本轮草稿预览与心跳，等待已在发送的草稿结束，再发送普通交互消息，避免迟到草稿覆盖问题并再次阻塞作答。
  Fixed Telegram private-chat live-draft heartbeats keeping the composer busy while `ask_user_question` waits for an answer, preventing replies from being sent normally ([#199](https://github.com/xmanrui/dsh-im/issues/199)). Questions and approvals now stop the current turn's draft preview and heartbeat and drain in-flight draft writes before sending the regular interaction message, so a late draft cannot replace the question and block replies again.
- 交互开始后，本轮后续进度不再重新激活草稿，最终回复仍正常发送；下一轮恢复正常流式预览，群聊的普通占位消息不受影响。提问仍通过编号或文字回答，本次未增加按钮协议、配置项或外部依赖。
  Later progress cannot restart the draft once interaction begins, while the final reply is still delivered normally. The next turn starts a fresh stream, and regular group-chat placeholders are unchanged. Questions still accept numbered or text replies; no button protocol, configuration option, or external dependency was added.

### Documentation / 文档

- 补充 #199 的复现、根因与修复验证记录；新增回归用例覆盖在途草稿、迟到进度、后续心跳、答案提交和最终消息投递。
  Recorded the reproduction, root cause, and validation for #199, and added regression coverage for in-flight drafts, late progress, subsequent heartbeats, answer submission, and final-message delivery.


## [4.20.1] - 2026-09-12

### Fixed / 修复

- 企业微信不再因进入单聊而自动发送菜单，重复进入、断线重连和运行时重启也保持静默；交互菜单通过 `/m` 或 `/menu` 手动打开，普通消息及其他文字命令不会额外触发菜单卡片。
  Enterprise WeChat no longer sends menus automatically on direct-chat entry, including repeated entries, reconnects, and runtime restarts. Open the interactive menu explicitly with `/m` or `/menu`; ordinary messages and other text commands do not trigger extra menu cards.
- 企业微信菜单按钮执行后仅确认操作并反馈结果，不再自动补发整组菜单；覆盖新会话、停止、压缩、状态、帮助、工作区切换及会话／模型／预设设置。保留卡片上的「重新打开菜单」入口；工作区已变化的旧卡片会提示发送 `/m` 重新选择，避免误操作。
  Enterprise WeChat menu actions now acknowledge the operation and return its result without automatically appending another set of menus. This covers new Session, stop, compact, status, help, workspace switching, and Session/model/preset settings. The card's Reopen menu action remains available; stale workspace cards prompt users to send `/m` and select again to avoid unintended actions.

### Documentation / 文档

- 同步中英文 README 与机器人命令指南，说明企业微信菜单的手动打开及操作后反馈行为。
  Updated the bilingual READMEs and bot-command guide to describe explicit Enterprise WeChat menu opening and post-action feedback.

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

[Unreleased]: https://github.com/xmanrui/dsh-im/compare/v5.9.0...HEAD
[5.9.0]: https://github.com/xmanrui/dsh-im/compare/v5.8.0...v5.9.0
[5.8.0]: https://github.com/xmanrui/dsh-im/compare/v5.7.0...v5.8.0
[5.7.0]: https://github.com/xmanrui/dsh-im/compare/v5.6.0...v5.7.0
[5.6.0]: https://github.com/xmanrui/dsh-im/compare/v5.5.0...v5.6.0
[5.5.0]: https://github.com/xmanrui/dsh-im/compare/v5.4.0...v5.5.0
[5.4.0]: https://github.com/xmanrui/dsh-im/compare/v5.3.0...v5.4.0
[5.3.0]: https://github.com/xmanrui/dsh-im/compare/v5.2.0...v5.3.0
[5.2.0]: https://github.com/xmanrui/dsh-im/compare/v5.1.0...v5.2.0
[5.1.0]: https://github.com/xmanrui/dsh-im/compare/v5.0.3...v5.1.0
[5.0.3]: https://github.com/xmanrui/dsh-im/compare/v5.0.2...v5.0.3
[5.0.2]: https://github.com/xmanrui/dsh-im/compare/v5.0.1...v5.0.2
[5.0.1]: https://github.com/xmanrui/dsh-im/compare/v5.0.0...v5.0.1
[5.0.0]: https://github.com/xmanrui/dsh-im/compare/v4.39.0...v5.0.0
[4.39.0]: https://github.com/xmanrui/dsh-im/compare/v4.38.2...v4.39.0
[4.38.2]: https://github.com/xmanrui/dsh-im/compare/v4.38.1...v4.38.2
[4.38.1]: https://github.com/xmanrui/dsh-im/compare/v4.38.0...v4.38.1
[4.38.0]: https://github.com/xmanrui/dsh-im/compare/v4.37.0...v4.38.0
[4.37.0]: https://github.com/xmanrui/dsh-im/compare/v4.36.1...v4.37.0
[4.36.1]: https://github.com/xmanrui/dsh-im/compare/v4.36.0...v4.36.1
[4.36.0]: https://github.com/xmanrui/dsh-im/compare/v4.35.1...v4.36.0
[4.35.1]: https://github.com/xmanrui/dsh-im/compare/v4.35.0...v4.35.1
[4.35.0]: https://github.com/xmanrui/dsh-im/compare/v4.34.2...v4.35.0
[4.34.2]: https://github.com/xmanrui/dsh-im/compare/v4.34.1...v4.34.2
[4.34.1]: https://github.com/xmanrui/dsh-im/compare/v4.34.0...v4.34.1
[4.34.0]: https://github.com/xmanrui/dsh-im/compare/v4.33.0...v4.34.0
[4.33.0]: https://github.com/xmanrui/dsh-im/compare/v4.32.0...v4.33.0
[4.32.0]: https://github.com/xmanrui/dsh-im/compare/v4.31.0...v4.32.0
[4.31.0]: https://github.com/xmanrui/dsh-im/compare/v4.30.0...v4.31.0
[4.30.0]: https://github.com/xmanrui/dsh-im/compare/v4.29.1...v4.30.0
[4.29.1]: https://github.com/xmanrui/dsh-im/compare/v4.29.0...v4.29.1
[4.29.0]: https://github.com/xmanrui/dsh-im/compare/v4.28.1...v4.29.0
[4.28.1]: https://github.com/xmanrui/dsh-im/compare/v4.28.0...v4.28.1
[4.28.0]: https://github.com/xmanrui/dsh-im/compare/v4.27.0...v4.28.0
[4.27.0]: https://github.com/xmanrui/dsh-im/compare/v4.26.0...v4.27.0
[4.26.0]: https://github.com/xmanrui/dsh-im/compare/v4.25.0...v4.26.0
[4.25.0]: https://github.com/xmanrui/dsh-im/compare/v4.24.1...v4.25.0
[4.24.1]: https://github.com/xmanrui/dsh-im/compare/v4.24.0...v4.24.1
[4.24.0]: https://github.com/xmanrui/dsh-im/compare/v4.23.0...v4.24.0
[4.23.0]: https://github.com/xmanrui/dsh-im/compare/v4.22.0...v4.23.0
[4.22.0]: https://github.com/xmanrui/dsh-im/compare/v4.21.2...v4.22.0
[4.21.2]: https://github.com/xmanrui/dsh-im/compare/v4.21.1...v4.21.2
[4.21.1]: https://github.com/xmanrui/dsh-im/compare/v4.21.0...v4.21.1
[4.21.0]: https://github.com/xmanrui/dsh-im/compare/v4.20.2...v4.21.0
[4.20.2]: https://github.com/xmanrui/dsh-im/compare/v4.20.1...v4.20.2
[4.20.1]: https://github.com/xmanrui/dsh-im/compare/v4.20.0...v4.20.1
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

