# MYST-38：飞书话题与跨会话投递方案

状态：**待人工评审**，不是已实施、已部署或已批准。设计分支基线为 `xmanrui/dsh-im@6626026`；另一个本地工作树含四个未合入上游的飞书提交及未提交改动，本文引用它们只作为候选实现证据，实施前须逐项移植并复核。本文件是唯一设计源；[Linear MYST-38](https://linear.app/castrel/issue/MYST-38) 是需求权威，[Mystra #64](https://github.com/Arcadia822/mystra/issues/64) 为关联工单，本设计 [Draft PR #282](https://github.com/xmanrui/dsh-im/pull/282) 不替代 [host-c1 Draft PR #65](https://github.com/Arcadia822/mystra/pull/65)。

## 1. 需求、边界与方案结论

群内 `@Bot + Issue ID` → 群 Agent 核对 Linear Issue、权限、状态及明确的目标仓库 → 在**原入站群消息**上开飞书 Thread → 无需第二次 `@`，把带真实发起者信息的首条 `user/message` 投进该 Thread 的独立 DSH Session → **该 Session 在 host-c1 的独立 OpenSandbox 内运行 DSH Agent runtime**，完成设计、打包并发布 Taco → 正确关联 Linear Issue 后，仅在原 Thread 返回可打开的评审 URL。校验失败时只在原群说明错误，绝不先开楼或起沙箱。并发不同群／Issue 不串话。host-a1 的群 Session 仅负责校验/调度，不能兼任这个设计 Session。

**职责切分**：一个与 IM 无关、单独安装/升级的 DSH Host cross-session 插件负责可信投递、目标绑定与运行回执；dsh-im 负责飞书根消息、Thread 地址、权限、入站续接和原位回复；沙箱内 DSH Agent runtime 负责真实的独立会话，设计执行器负责仓库、模型、Taco/Linear 发布工作流。三者均不把 `dsh_im_feishu_send` 的 one-shot 平台发送误当作 Agent 输入；不伪造飞书人类入站事件，不用全局 `groupTopicReply=true` 抢先开楼。MYST-4 的评论批量回读、批准固化、开发设计移交不在本工单的完成范围内。

**已知部署差异**：host-a1 的 DSH 曾实测为 `0.1.7-rc.1`、Node `v22.23.2`，dsh-im 由 `@xmanrui/dsh-im@4.25.0` 本地 tarball 和 `/opt/dsh-deployment/manifest.json` 哈希部署；这些是此前只读现场记录，实施前必须重新核对。后续 `0.1.7-rc.2` 或第三方消息插件的能力不得直接视作 host-a1 已具备。host-c1 的测试 MVP 已获准启动 OpenSandbox（Linear 最新评论），但服务 `active` / `/health=200` **不等于** execd 提权、跨沙箱网络及真实凭据隔离门禁通过；真实凭据或不可信任务须另做安全门禁。

## 2. 已有机制与不能直接复用的部分

| 位置 | 已核实机制 | 设计影响 |
| --- | --- | --- |
| `plugin-src/host/feishu-tools.mjs:18-53,90-114` | 当前本机改动中的工具能解析当前群目标，`send` 返回平台投递回执；不会启动 Agent 轮次 | 首次开楼需从**已校验入站上下文**拿真实 `messageId`，不可让模型猜测目标消息 ID；本地未提交工具改动不得视为已部署 |
| `src/channels/feishu/feishu-runtime.mjs:719-783` | 本机实现发送前以飞书 `message.get` 校验锚点归属，成功返回 `messageId/threadId/rootId`；缺 `threadId` 时提示“可能已发送” | 返回不完整时进入待核对状态，不能盲重发；先确认 chat 与根锚点再持久记录 |
| `src/channels/feishu/bridge.mjs:840-855,927-936`、`state-store.mjs:177-208` | 已有 `group:<chatId>:thread:<threadId>` 键，自动管理话题另有 `managed:<rootMessageId>` 与 topic root 映射 | 本旅程保持 `groupTopicReply=false`；手动开楼必须仍解析成 `thread:` 键，不移用 `managed:` 键 |
| `src/channels/shared/workspace-session.mjs:91-195` | `askInWorkspaceSession` 按 conversation key 创建 Session 后 `state.setSession` 并 `ask`，workspace 切换有 generation fence | 新入口不得另造一个与入站不一致的映射；并发建会话与工作区切换须同一锁/版本约束 |
| `plugin-src/host/modern-harness-api.mjs:220-233` 及 host-a1 DSH `@deepseek-ai/dsh-api-session-controller@0.1.7-rc.1` | `session.create` 支持指定目标 workspace/cwd；`session.prompt` 内部强制构造 `{ kind:'user', rpcId:requestId }`，没有 `source` 入参，`hasPromptRequest` 也只按此类来源去重 | 不可用 Remote `session.prompt` 注入非人类消息；独立 Host 插件须走进程内 `ctx.agents`，自己实现可信身份、幂等、队列与回执 |
| `src/channels/feishu/bridge.mjs:5976-6015` | 普通回复失败会回退 `message.create` 公屏 | 本旅程的设计结果及错误必须走**严格话题回复**，不能复用该回落；失败显示在已有 Thread 或告警后台，不向群公屏泄漏 |

文档 `docs/方案/飞书群聊话题回复设计.md` 记录过“开启群话题自动回复”的历史方案；它不是本旅程的配置建议。现有 `PROACTIVE_DELIVERY.md` 的 `/api/dsh-im/delivery/messages` 无业务鉴权，且该端点仅面向平台文字发送；禁止扩成任意 Session 写入入口。

## 3. 架构与不变量

```text
已鉴权飞书事件 ─→ 群 Agent（校验 Issue/Repo） ─→ dsh-im 开楼／严格回帖
                                         │ 已校验的根锚点、群及 bot/turn
                                         ↓
                                 Thread 绑定适配器与严格回帖
                                         ↓ 受信 Host 调用（无模型可控 Session ID）
Agent 工具 / hook / scheduler ─→ 独立 cross-session 插件（授权／绑定／去重／队列／来源／回执）
                                         ↓ 认证的 job-scoped 远端投递
                         host-c1 OpenSandbox 内 DSH Session inbox/正常轮次
                                         ↓
                          canonical Markdown → Taco Host → Linear
                                         ↓
                                 dsh-im 原 Thread 回复
```

1. **两个地址空间**：`botId + chatId + threadId` 是平台路由；`dshSessionId` 是模型上下文；Issue ID 是业务标识。三者不能互换。插件的 `binding.namespace='dsh-im:feishu-thread'` 与由 `(botId,chatId,threadId)` 构造的不可混淆键只由 dsh-im 注册适配器解释；通用插件不解析飞书 ID。绑定还记录沙箱内的 `runtimeId/sandboxId`；host-a1 的本地 Session API 不得冒充远端 Session。
2. **单一权威绑定**：插件持久库保存 `bindingKey → runtimeId + sandboxId + sessionId + generation + owner/workspace`；dsh-im 的 `state.sessions[conversationKey]` 是可修复的**地址投影**，绝不是把远端 Session 交给本地 `ask` 的许可。新建 Thread 时先提交权威绑定、再将 `state.sessions['group:<chatId>:thread:<threadId>']` 持久化，最后才承认首轮已接纳；`#resolveKey` 不应为本旅程登记 `topics[threadId]`，否则路由会变成另一个 `managed:` key。入站 mention gate 先查询待建作业或权威绑定并恢复投影；匹配本旅程者转远端队列，只有普通本机会话才进入 `askInWorkspaceSession`。没有插件时现有普通聊天路径不变，**该旅程不以降级到共享群 Session 作为成功**。切换 Session/工作区、删除 Bot、重绑都递增 generation；旧投递失败而非覆盖新绑定。
3. **首轮创建语义**：只有验证过 bot/chat/root/thread 的适配器可申请该命名空间的 `ensureBinding`；建独立 Session 时显式设置 conversation/workspace 身份。未写入绑定的创建结果为可回收孤儿，重试不得随机创建第二个已激活绑定；创建、绑定与首次投递的崩溃间隙须按 requestId 对账。绝不从主群 Session 复制用户历史或改造其 Session ID。
4. **真实来源**：角色仍为 `user`、事件类型仍为 `user/message`，但 `source.kind` 是目标 Host 可持久化的生产者种类，例如 `plugin:dsh-cross-session`，并在可验证的结构化字段中记录 `initiatorKind`、可信 `principalId`、`senderSessionId` 或 `eventId/jobId`、`requestId`；人类入站才可用 `source.kind='user'`。模型输入显式标注“自动投递／非人类指令”，不能只靠正文提示冒充审计记录。DSH v4 来源格式禁止废弃的裸 `kind: 'plugin'`（[兼容性例证](https://github.com/deepseek-ai/deepseek-harness/discussions/7772)）。host-a1 `0.1.7-rc.1` 的底层 `@deepseek-ai/dsh-session` 对 `source.kind` 只要求非空字符串，但仍须实测下游消费和历史读取。正确进程内调用是 `createUserMessage({content,source})` 生成带 `id/role` 的对象后 `agent.followup(message)`，**不是** `followup({content,source})`；该接口返回 `void`，不自带去重/完成回执。不得退回 `session.prompt` 的伪 `user` 来源。
5. **无跨域提升**：Agent 工具的 Session 身份取自 `exec.agent.session.header`，但它**不能证明当前飞书群**（同一 Session 可由多群选择共享）；每个工具调用还须消费由已验签入站事件生成、绑定 `botId/chatId/messageId/senderSessionId/turnId/sender/expiry` 的一次性受信事件凭证，按确切根锚点核销。hook/job 的主体验证由注册器/可信进程提供。调用者不能自行提交 `source.kind`、任意 `sessionId` 或声明所属 bot/chat；不能用 `keyForSession` 或跨 Bot 遍历的首个匹配推断目标群。跨群、跨 workspace、跨 bot/Agent 权限由目标 owner 与 allowlist/策略判定；跨进程入口必须有强鉴权和最小作用域；现有无鉴权发送 HTTP 端点不得复用。
6. **验收与完成分开**：投递返回的是已接收或已去重的 `receiptId` 与 target `sessionId`，不是设计完成或飞书已送达；完成状态分别追踪 Agent turn、沙箱任务、Taco 发布、Linear 关联与飞书交付。所有回执留存可查询，不把超时等同失败重试。

### 3.1 底层插件边界

独立包建议为 `@arcadia/dsh-cross-session`（具体包名在发布时确认）；独立 manifest/安装与版本兼容矩阵，不依赖 `@xmanrui/dsh-im` 或飞书 SDK。Host 根上下文实际提供复数 `ctx.agents`（不是 `ctx.agent`）；插件以受限 Host 服务暴露 `ctx.crossSession.deliver/query/registerBinding`，Agent 工具只给本 Session 允许访问的目标，hook/job 经同一服务适配，外部 webhook 经专门鉴权适配后再走同一 `deliver`。**实际目标 Session 在 host-c1 的独立沙箱 DSH runtime 内创建/恢复**：host-a1 插件按授权 job 将请求通过认证、绑定 target runtime 的传输交给同一插件的远端实例；只有远端实例才可用进程内 `ctx.agents.get/create/resume`、`createUserMessage`/`followup`。host-a1 的 `session.create` 仅能建本机 Session，不能用于此目标，更不能使用伪人类 `session.prompt`；dsh-im 入站普通 `askInWorkspaceSession` 是本机入口，对此类绑定必须接到远端适配器且统一接收执行状态。插件不得以本机 stub Session 欺骗投影。需验证 OpenSandbox 镜像中的 DSH/runtime、工作区挂载、网络与认证协议，PR #65 目前只提供设计工具镜像，**没有证据证明远端 DSH 已可运行**；这是实现门槛，而不是现成功能。若 Host 无法加载独立包或 `followup` 的 durable admission 做不到所需原子性，则先形成受信 DSH Core admission 扩展，而不是把核心逻辑埋进飞书桥接器。

## 4. 数据与接口契约（拟定；实施前按目标 DSH 版本核实）

```ts
// 受信调用方构造；身份、source.kind 由 Host 注入，不由模型输入决定。
type DeliveryRequest = {
  target: { binding: { namespace: string; key: string; expectedGeneration?: number } }
        | { sessionId: string; expectedGeneration?: number };
  requestId: string;                      // 发起者作用域内稳定，重复调用不重复运行
  content: string;                        // 非空 user-role 任务；不是飞书 assistant 回复
  initiator: { kind: 'agent' | 'bot' | 'hook' | 'scheduler';
               principalId: string; senderSessionId?: string; eventId?: string; jobId?: string };
};
type DeliveryReceipt = {
  receiptId: string; sessionId: string; generation: number;
  admission: 'accepted' | 'duplicate';
  execution: 'queued' | 'running' | 'completed' | 'failed' | 'unknown';
};
```

`registerBinding({ namespace, key, sessionId?, workspaceId, owner, expectedGeneration })` 只开放给对应适配器：成功返回固定的**沙箱 runtime/session** 与 generation；指定 `sessionId` 只可由有该 owner/namespace 权限的可信 Host 调用，普通 Agent 只能请求当前策略许可的现有会话。`query(receiptId)` 返回状态和安全裁剪的错误码，不泄露沙箱路径、凭据、完整消息正文。`requestId` 的去重主键为 `(principalId, requestId)`，同时存目标身份、generation 和内容摘要；同键不同请求体返回 `idempotency-conflict`；跨 principal 的同名键互不冲突。远端回执必须包含目标 runtime 的认证身份与 Session ID，host-a1 不从本地普通会话列表虚构成功。

持久表由插件管理：`Binding(namespace,key,runtimeId,sandboxId,sessionId,workspaceId,owner,generation,status)`、`Delivery(principalId,requestId,targetGeneration,contentDigest,receiptId,turnId,admission,execution,errorCode)`；飞书适配的 `ThreadJob(botId,chatId,rootMessageId,threadId,issueId,repoId,runtimeId,sessionId,sandboxId,replyAnchorMessageId,stage)` 记录已验证的原锚点、开楼回执、工作区与发布阶段。`(botId,chatId,rootMessageId)` **永久唯一**，包括成功/失败终态；同根不同 Issue 冲突而非开新楼。同根同 Issue 重试返回原 Thread/Session/阶段；人工重开须单独授权、另记代际与旧楼审计，不能清掉原唯一键后盲重开。插件库与渠道状态不能原子提交时按 `ThreadJob` 日志补偿：`rootChecked → opening → threadKnown → bound → admitted → running → published → linked → replied`，每步持久化后再做下一步；`opening` 超时或飞书返回不完整只允许读平台历史核对，确认无副作用后才重发。对账失败置 `unknown` 并通知维护者，不凭猜测产生第二楼。

Agent 输入中的外部 Issue 内容、聊天原文、仓库 README 都是未信任数据，不能覆盖系统策略、路由和 sandbox 配置。只在通过仓库白名单与目标 repo 唯一性核验后创建绑定；root message ID 来自验签/ACL 已通过的实际入站事件，不能仅用模型从群历史挑选同文本消息。群 Agent 工具发起 `openValidatedThread({ issueId, repository, eventToken })` 时，Host 核销一次性事件令牌并校验确切 bot/chat/root/sender 与发起 turn/session、TTL 和 Issue-Repo 证明；短期事件表先落盘，重放只能查询同一个 ThreadJob，不能以 Session 反查第一群。模型不可自由传入飞书 `threadId` 来绕过校验。

## 5. 先开楼、再首投及后续入站

1. 群事件通过现有 mention gate、sender 策略和事件去重后，保存 `(botId,chatId,messageId,sender,senderSessionId,turnId,expiry)` 到短期受信事件表，并向本轮 Agent 限时提供一次性 `eventToken`；同一 Session 可能服务多个群，不能靠 Session ID 反查群。群 Agent 查 Linear 的 Issue、关联项目/仓库和访问权限；无效、关闭策略不允许、仓库不唯一时，留在群里给错误且没有 `ThreadJob` 的开楼阶段。
2. 按根消息唯一键对 `ThreadJob` 加独占锁，已有任何阶段的作业都返回原状态。通过 dsh-im 已校验的 reply 路径对 root 发**明确的建楼确认消息**，要求 `replyInThread=true`；返回 `threadId` 与话题内 `messageId`，检查群归属并持久化 `threadKnown`。此消息只是平台确认，不代表 Session 首轮；首轮任务文本另行进入 DSH。若平台 API 已接受而回执不完整，停止并对账，绝不盲重发。`threadKnown` 建立后，mention gate 以 `(botId,chatId,threadId)` 匹配**待绑定的 ThreadJob**；后续人类消息立即持久暂存，即使 Binding 尚不存在也不静默丢弃。若回复事件早于 `threadKnown` 落盘，`opening` 作业按同 bot/chat/root 核查飞书消息归属后先暂存并对账；无法证明该 thread 属于此 root 时既不放行也不丢弃，记 `unknown` 告警处理，绝不只凭任意 `thread_id` 绕过 mention gate。
3. 在 host-c1 为此 job 建立独立 OpenSandbox/DSH runtime 与 Session，认证远端实例后对同一 `(botId,chatId,threadId)` 建立 `group:<chatId>:thread:<threadId>` 绑定，并同步投影。自动首投获得**持久序号 0**，在其远端 inbox admission 有确证前，不能释放随后人类消息。投递以原事件为幂等来源，记录 bot/agent 与 `senderSessionId/eventId`。只有远端插件确认 `admission=accepted|duplicate` 且给出真实 Session ID 后才认为首轮输入已投递；不能由群 Agent 自行发一条飞书消息假装首轮。远端运行不可用则停在可恢复的 `threadKnown`，明确提示阶段而不造假成功。
4. `user/message` 归 Thread Session 并开始正常轮次。目标忙时统一持久 FIFO 排队；不同请求的入站去重与先后由 ThreadJob 序号确定，首次自动投递占 0。停机后恢复未完成队列前，按 `source.requestId` 检查目标 Agent 的 nextTurn、nextStep 与 Session 历史，冷 Session 先由 Registry 恢复；`followup` 返回 `void`，因此插件回执仅在成功交给 inbox 并对账后标记 `accepted`，turn 完成另监听 Session 事件。**持久账本提交与 DSH inbox 入队不能靠两次写伪装原子性**：崩溃若使两边状态都无法证明，只标记 `unknown` 并停自动重试，保证不盲目重复但不声称自动 exactly-once；若需求坚持无人工介入的自动 exactly-once，就先扩展受信 Host 的原子 admission。独立群/Thread 可并发，同一目标有序。
5. 后续话题内有效人类消息按 `group:<chatId>:thread:<threadId>` 解析同一绑定；**不能**走现有本机 `askInWorkspaceSession`/`session.prompt` 直接抢跑。入站适配把人类原事件和序号持久加入 ThreadJob 的统一目标队列，恢复后按自动首投、再人类消息的顺序交给沙箱内同一 Session；人类消息保持 `source.kind='user'` 与原始事件 ID。mention gate 在投影不存在时仍查 `threadKnown` 作业，待绑定时落盘并回执等待；绑定失败保持待处理或显式告警，绝不静默丢弃。`/new`、显式 Session 切换/删除 Bot 按 generation fence 更新或停用映射；已接受的运行结果仍锚定最初 Thread，不会落到另一个会话或公屏。
6. **属于 ThreadJob 的全部出站**（首轮、后续追问、流式/卡片、命令、交互、延迟通知、完成、错误）均继承 `strictThread` 路由策略，只用持久 `replyAnchorMessageId` 做 `message.reply(reply_in_thread=true)`；核验群归属、`threadId` 匹配及实际投递回执。桥接器现有 `#send`/stream/fallback 不能绕过该策略调用 `message.create`，失败统一记 `delivery-blocked` 并告警管理入口，不把任何设计内容发到群主时间线。去重键覆盖主动回帖，无法确认平台是否已发时人工对账。

## 6. 设计执行、发布与兼容切换

**执行位置是硬边界**：首轮及后续设计 Agent 的 DSH Session **只能在 host-c1 对应 job 的 OpenSandbox 内创建、恢复与运行**；host-a1 的群 Session 只做 Issue 校验、建楼和远端投递协调，不得有目标 repo 挂载/本机设计工具或代跑模型任务。跨 Host 的受信插件端点仅授权特定 job/runtime/Session，沙箱内 Agent 的仓库访问、模型与出口、凭据都限制在该 job；更换沙箱须按 generation/Session 恢复方案显式迁移，不能将旧 Session ID 直接指向空沙箱。每个 job 显式携带 `issueId/repoId/workspaceId/sandboxId`；沙箱及 Session 持久卷须在 Thread 追问窗口内保留，明确关闭/归档后才清理，归档后的追问须有可验证的恢复/拒绝策略，不得完成首轮即删除唯一运行时。必须实机证明 host-a1 无目标仓库读取权限、沙箱无法读取另一 Issue 文件。host-c1 镜像/服务更改属 PR #65，本 PR 只定义接入面和现场验证，**而远端 DSH runtime/认证转发尚未实施，未补齐前不能宣称旅程可运行**。现有安全缺口在测试 MVP 阶段可记录豁免以启动服务，不可因此向沙箱交付真实高权限凭据或不可信代码。

发布顺序是：设计源文件复核 → Taco 打包 → `taco-cli publish --dry-run` 检查内容及凭据 → 发布到当前指定的 `https://taco.arcadia-han.com` → 用真实 HTTP/浏览器验证可访问 URL → 向**目标 Linear Issue** 附加同一 URL → 仅成功后转 `In Review` → 在原 Thread 回复 URL 与摘要。开始工作时可置 `In Progress`；任一模型/权限/出网/发布/关联失败，都保留阶段与可重试回执，不进入 `In Review`。已发布 URL 的重试应复用已核对产物而非给别的 Issue 重新发布；评论回读与开发设计移交另由 MYST-4 承接。沙箱内路径不能作为评审链接。

迁移次序：先在目标 DSH/Node 版本验证插件独立加载、source v4 落盘及队列恢复，再安装插件和 dsh-im 的薄适配；只为**新建且明确验证的 ThreadJob**启用自动首投。旧 `group:<chatId>`、已有人工 Thread、`managed:<rootMessageId>` 会话保持现状，不批量搬运历史；有旧话题 Session 映射时按 owner/generation 导入绑定并核验，冲突拒绝，不静默新建。关闭插件仅禁用新自动投递，不改变普通 IM 入站；尚未完成的作业需可查询/排空后才能卸载。回滚时保留绑定、请求回执及来源审计，不把旧投递重演为新的人类输入。

## 7. 逐条验收对应关系

| Issue / 评论验收 | 设计条目与必须留下的证据 |
| --- | --- |
| 真实群 `@Bot + Issue ID`，确认前不建 Thread，错误不建沙箱；仓库不明确不默选 | §5.1 受信事件与 Issue/Repo 核验；真机无效 ID、歧义 repo、越权事件，核对飞书楼数及沙箱调用均为零 |
| 确认后仅建一个 Thread；持久 `(botId,chatId,rootMessageId,threadId,issueId,dshSessionId,sandboxId)` | §4 `ThreadJob` 与唯一约束、§5.2 平台回执/对账；重复事件/重复 requestId/超时重试均查唯一映射且不重复开楼 |
| 群和 Thread Session 不同；首轮任务与回复归 Thread，无二次 `@`，后续追问续接 | §3 单一绑定、§5.3-6 来源及 FIFO；核对 DSH 历史 `user/message`、Session ID、回复 `threadId`，不接受只发飞书消息替代 |
| bot／其他 Agent／hook／scheduler 通用投递，真实来源、权限、去重、忙时与冷恢复 | §3.1/§4 插件契约与 §5.4；分别由 Agent、hook、定时调度一次，跨群拒绝、同键重放、冷 Session 重启、忙时顺序与不确定提交对账 |
| host-a1→host-c1 创建/执行/清理真实独立沙箱，指定 repo/模型/出网；双 Issue 不串线 | §3.1、§6；沙箱内 DSH Session 的创建/历史/模型执行证据、沙箱 ID、镜像版本、工作区、模型响应、repo 哈希、清理及 host-a1 本机仓库访问与跨 Issue 读取被拒现场记录，不以单测代替 |
| canonical Markdown、dry-run、HTTPS Taco URL、正确关联 Linear、成功才 `In Review` | §6；读取源与发布物、URL 可达证据、Issue 附件/状态变更日志；发布和关联失败不会推进状态 |
| 最终 URL/摘要只到原 Thread，失败不回退公屏；重试不重复无关产物 | §5.6、§6；抽查首轮/追问/流式/交互/错误全分支的飞书真实回执与原 root/thread 匹配、平台模糊回执进入人工对账；不出现主群公屏设计内容 |
| host-a1 配置、host-c1 服务网络模型发布域名现场验证；上线前端到端冒烟 | §8 清单，附版本、哈希、健康、鉴权、网络、发布/回帖现场记录；PR #65 不计作此链路的通过证据 |

## 8. 实现顺序与验证计划

1. **兼容性门槛**：核对 host-a1 dsh-im 本地 tarball、manifest 哈希、DSH/Node 实际版本；在 host-c1 OpenSandbox 的实际 DSH runtime 以 `ctx.agents`/`createUserMessage`/`followup` 验证指定冷 Session 得到合法非人类来源的 `user/message`、正常 turn、重启恢复与可查询状态，检查下游 `source.kind` 兼容；host-a1 与 host-c1 之间认证/授权且目标 runtime 不混淆。`followup` 不返回 admission 回执或自动幂等，须按 §5.4 证明账本/DSH 历史对账可处理崩溃不确定性，否则先做受信 DSH 原子 admission 扩展；绝不改用 `session.prompt` 伪来源。
2. **通用插件**：独立包与 Host 服务、受信身份与 ACL、版本栅栏、单绑定权威、持久去重和 FIFO/恢复；写跨群拒绝、并发、崩溃各阶段及原子性能力验证。外部 hook/scheduler 只实现适配调用，不复制会话管理。
3. **dsh-im 适配**：在 `plugin-src/host/feishu-tools.mjs`/`delivery-service.mjs` 的工具与能力边界加入带事件令牌的受信根锚点与 `ThreadJob`，在 `src/channels/feishu/{bridge,feishu-runtime,state-store}.mjs` 的 mention gate、所有出站分支适配待绑定暂存与严格话题回复；`src/channels/shared/workspace-session.mjs` 的本机问答与 Host 远端队列按 generation 分流，不可共享错位的 Session 投影。迁入当前工作树未合并的“历史读取、回复回执”变更需单独审阅，不直接复制本地未提交文件。
4. **执行器接线**：为 host-c1 OpenSandbox 实际提供 DSH Agent runtime 与认证、job-scoped 远端服务及持久 Session/工作区，再在沙箱内生成 canonical Markdown/Taco、校验发布 URL、Linear 回填和状态门禁；不把 PR #65 已验证的设计工具镜像当作已有 DSH 执行器，也不擅改其镜像或服务配置。确认沙箱的运行隔离门槛和测试 MVP 允许范围分开记录。
5. **回归与实机**：保持全局 `groupTopicReply=false`、`groupResponseMode=mention`，验证普通群/既有话题/私聊无回归；在测试群真实 Issue 跑一次发起→开楼→首投→生成→dry-run→发布→关联→回帖；再并发两个群/Issue、模拟模型/权限/飞书缺回执/发布失败，重启 host-a1 后恢复和去重。部署更新先对照 manifest 才能替换 tarball，未提交 update-card 等工作不得当作上线证据。

## 9. 风险、需预先验证的事实与待决策点

可实施性风险不是产品取舍：目标 DSH 是否允许独立插件在沙箱内 Session 写入合法非人类 `source.kind` 并在冷恢复中保持 requestId 去重、是否有 durable admission API、OpenSandbox 中能否可靠运行和持久化 DSH Session，均尚未经该目标部署实测。验证失败则按 §8.1 先做最小 DSH/运行时能力扩展；不能以正文注记、伪飞书事件或 `session.prompt` 伪人类输入替代。飞书创建 Thread 的 API 回执与后续消息归属也须实机核对。以下需要人类权衡的选项均不阻止本设计继续评审；**未裁决时的默认行为仅供评审，不代表批准**。

### 待决策点 1：测试 MVP 是否允许真实凭据进入尚有隔离缺口的沙箱？

- **问题与背景**：最新 Linear 评论允许先启动 OpenSandbox 做测试 MVP，但已记录 execd 提权、跨沙箱网络与管理面暴露。完整旅程又要求真实模型、Linear 和 Taco 发布凭据，服务健康不构成安全证明。
- **选项 A（推荐）**：先使用无真实高权限凭据的隔离测试环境验证 DSH 投递/Thread，等 PR #65 消除隔离缺口并复测后才跑真实凭据端到端；代价是完整线上验收延后。
- **选项 B**：限定受控测试群、最小权限短期凭据、明确隔离风险接受人并保留外网/凭据审计后先跑真实端到端；代价是残余提权与横向风险仍存在，必须接受并有撤销预案。
- **影响面**：host-c1、凭据管理、Linear 与 Taco Host 实机验收、上线时机。**不作决策的默认行为**：选 A；禁止以 MVP 启动授权来推断真实凭据风险已获批准。

### 待决策点 2：独立插件发布归属

- **问题与背景**：需求明确“独立的 cross-session 底层能力插件”；当前 dsh-im 是单 npm 包，仓库没有现成独立插件工作区规范。包与仓库归属会影响版本和授权边界，不应在 dsh-im 内复制一份通用 Host 逻辑。
- **选项 A（推荐）**：单独 npm 包/仓库发布，与 dsh-im 按明确 Host service 契约耦合；代价是两个发布流水线与版本矩阵。
- **选项 B**：在 dsh-im 仓库中独立包目录和独立 manifest/产物发布；代价是同仓发版治理，且须防止 dsh-im 直接依赖内部源码。
- **影响面**：源码归属、许可证/发布权限、部署顺序、维护者。**不作决策的默认行为**：选 A；本 PR 只放接口与适配方案，不假设已有包或发布凭据。

## 10. 独立审查记录

独立只读审查（2026-09-29）：**初稿结论为 incorrect，6 项发现；没有构建、测试或部署验证**。审查证据为 Linear MYST-38、Mystra #64 与本机 dsh-im 源码。初稿阻断项和本稿的处理：① 同一 Session 反查首个群可能错投/越权（`bridge.mjs:2757-2763`）→ §3.5/§4/§5.1 以绑定 bot/chat/message/turn 的受信入站令牌核销；② 回执到绑定间消息被 mention gate 丢弃（`bridge.mjs:967-991`）→ §5.2 在 `opening/threadKnown` 匹配并持久暂存；③ 人类 `ask` 绕过插件 FIFO 抢先首投（`bridge.mjs:1299-1327`、`harness-client.mjs:1797-1804`）→ §5.3-5 共用远端队列并锁定序号 0；④ `#send` 公屏 fallback 会泄露追问或错误（`bridge.mjs:5976-6015`）→ §5.6 所有输出继承 `strictThread`；⑤ host-a1 本机 `session.create` 不等于沙箱内执行（`harness-client.mjs:1204-1216`）→ §3.1/§6 指定远端 DSH runtime 并列为实施门槛；⑥ 作业终态释放根消息导致重开楼 → §4 永久唯一映射。以上是**设计修订**，非代码修复或审查通过；还需评审者复核修订版及 host-c1 现场验证，才能批准实施。
