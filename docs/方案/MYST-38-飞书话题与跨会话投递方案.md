# MYST-38：飞书话题与跨会话投递方案

状态：**待人工评审**，不是已实施、已部署或已批准。设计分支基线为 `xmanrui/dsh-im@6626026`；另一个本地工作树含四个未合入上游的飞书提交及未提交改动，本文引用它们只作为候选实现证据，实施前须逐项移植并复核。本文件是唯一设计源；[Linear MYST-38](https://linear.app/castrel/issue/MYST-38) 仍写有 host-c1 OpenSandbox 执行要求，**用户本轮明确把它从 Thread/投递设计前提中移除**，以独立 workspace/worktree 为必要条件；实施前需将此变更同步回 Issue 验收条款，不能声称旧验收已经通过。[Mystra #64](https://github.com/Arcadia822/mystra/issues/64) 为关联工单，本设计 [Draft PR #282](https://github.com/xmanrui/dsh-im/pull/282) 不替代 [host-c1 Draft PR #65](https://github.com/Arcadia822/mystra/pull/65)。

## 1. 需求、边界与方案结论

群内 `@Bot + Issue ID` → 群 Agent 核对 Linear Issue、权限、状态及明确的目标仓库 → 在**原入站群消息**上开飞书 Thread → Agent 根据任务决定工作分支与 worktree，调用受控工具为该 Thread 准备**独立 workspace** → 无需第二次 `@`，把带真实发起者信息的首条 `user/message` 投进绑定此 workspace 的独立 DSH Session → Agent 在该工作区完成设计、打包并发布 Taco → 正确关联 Linear Issue 后，仅在原 Thread 返回可打开的评审 URL。校验失败时只在原群说明错误，绝不先开楼或执行 Git 操作。并发不同群／Issue 不串话。host-a1 的群 Session 仅负责校验/调度，不能兼任这个设计 Session。

**职责切分**：一个与 IM 无关、单独安装/升级的 DSH Host cross-session 插件负责可信投递、目标绑定与运行回执；dsh-im 负责飞书根消息、Thread 地址、权限、入站续接和原位回复；工作区工具负责受限的仓库/worktree/分支准备与对话工作区绑定。**群 Agent** 根据已核验的 Issue/Repo 决定初始分支，调用工具准备 worktree，再创建目标 Thread Session；**Thread Agent** 在该 workspace 内执行设计、Taco/Linear 发布工作流，后续确需换分支时再走显式受控切换和 Session 重建/迁移，不直接修改共享 checkout。OpenSandbox 只是可选的执行 runtime，不是 Thread、Session 或 workspace 的身份，也不是跨会话投递的前置条件。均不把 `dsh_im_feishu_send` 的 one-shot 平台发送误当作 Agent 输入；不伪造飞书人类入站事件，不用全局 `groupTopicReply=true` 抢先开楼。MYST-4 的评论批量回读、批准固化、开发设计移交不在本工单的完成范围内。

**已知部署差异**：host-a1 的 DSH 曾实测为 `0.1.7-rc.1`、Node `v22.23.2`，dsh-im 由 `@xmanrui/dsh-im@4.25.0` 本地 tarball 和 `/opt/dsh-deployment/manifest.json` 哈希部署；这些是此前只读现场记录，实施前必须重新核对。后续 `0.1.7-rc.2` 或第三方消息插件的能力不得直接视作 host-a1 已具备。host-c1 OpenSandbox 与 [Draft PR #65](https://github.com/Arcadia822/mystra/pull/65) 是可另行接入的具体 runtime 工作，不决定本方案的 workspace/Thread 契约；工作区目录不等于安全沙箱，执行权限、凭据与命令准入仍须单独控制。

### 项目群业务背景（交接参考，不扩张本工单验收）

交接材料描述的目标是**不经 Mystra 的项目群 Agent 业务规划**，而 Linear MYST-38 当前限定为一次 `@Bot + Issue ID` 的需求设计交付；两者不是同一份需求。项目负责人 Agent 主动发起的方向/进度/质量/知识沟通、群内普通闲聊的分诊、周期性与事件触发、个人与研发小队的角色及可复用 skill 均需另行确认业务验收，本轮不把它们冒充 MYST-38 已要求的自动化功能。此处仅把会影响本链路的交接约束纳入设计，后续业务规划可另起独立中文评审件。

交接约束为普通非话题群仍可日常聊天，只有可追踪 Issue 才进入对应 Thread；群恰有一个持续对齐仓库 default 分支的项目 workspace，每个 Thread 恰有一个从项目状态分出的任务 workspace，**开 Thread 与 fork 是同一业务动作**；群及同一 Thread 都允许多个 Session，reset、定时任务、新 Session 均复用所属 workspace。两级 workspace 是可互见的 parent–child 关系，但互见不等于自动合并或交叉写入，是否覆盖未提交内容仍待人类裁决。下文明确群工作区的绑定/fork 基线与 Thread 复用语义；当前首轮设计只启动一个 Session，不得把“一 Thread 一 Session”误写成平台永久约束。

现有方案把“先开楼，再 fork worktree”拆成可恢复技术阶段；为满足交接所述原子业务体验，对用户不得在 `threadKnown` 单独报告建楼成功，必须在 workspace 绑定后才报告“任务已开始”。若开楼成功但准备失败，保留唯一 Thread 与待修复 `ThreadJob`、在原 Thread 报告失败阶段并恢复同一 worktree，不能重新开楼或退回群共享 workspace；技术上无法跨飞书/Git 原子提交，故“同步”指对外一致的恢复语义，不是假定分布式事务。

## 2. 已有机制与不能直接复用的部分

| 位置 | 已核实机制 | 设计影响 |
| --- | --- | --- |
| `plugin-src/host/feishu-tools.mjs:18-53,90-114` | 当前本机改动中的工具能解析当前群目标，`send` 返回平台投递回执；不会启动 Agent 轮次 | 首次开楼需从**已校验入站上下文**拿真实 `messageId`，不可让模型猜测目标消息 ID；本地未提交工具改动不得视为已部署 |
| `src/channels/feishu/feishu-runtime.mjs:719-783` | 本机实现发送前以飞书 `message.get` 校验锚点归属，成功返回 `messageId/threadId/rootId`；缺 `threadId` 时提示“可能已发送” | 返回不完整时进入待核对状态，不能盲重发；先确认 chat 与根锚点再持久记录 |
| `src/channels/feishu/bridge.mjs:840-855,927-936`、`state-store.mjs:177-208` | 已有 `group:<chatId>:thread:<threadId>` 键，自动管理话题另有 `managed:<rootMessageId>` 与 topic root 映射 | 本旅程保持 `groupTopicReply=false`；手动开楼必须仍解析成 `thread:` 键，不移用 `managed:` 键 |
| `src/channels/shared/workspace-session.mjs:91-195` | `askInWorkspaceSession` 按 conversation key 创建 Session 后 `state.setSession` 并 `ask`，workspace 切换有 generation fence | 新入口不得另造一个与入站不一致的映射；并发建会话与工作区切换须同一锁/版本约束 |
| `plugin-src/host/modern-harness-api.mjs:220-233` 及 host-a1 DSH `@deepseek-ai/dsh-api-session-controller@0.1.7-rc.1` | `session.create` 支持指定目标 workspace/cwd；`session.prompt` 内部强制构造 `{ kind:'user', rpcId:requestId }`，没有 `source` 入参，`hasPromptRequest` 也只按此类来源去重 | 不可用 Remote `session.prompt` 注入非人类消息；独立 Host 插件须走目标 DSH Host 的进程内 `ctx.agents`，自己实现可信身份、幂等、队列与回执；目标 Host 可在本机，不要求 OpenSandbox |
| `src/channels/feishu/bridge.mjs:5976-6015` | 普通回复失败会回退 `message.create` 公屏 | 本旅程的设计结果及错误必须走**严格话题回复**，不能复用该回落；失败显示在已有 Thread 或告警后台，不向群公屏泄漏 |
| `src/channels/shared/workspace-command.mjs:396-471`、`bot-workspace-store.mjs:775-797,1750-1770,1863-1922` | `/conv` 可把某一对话切到**已有**目录，切换会清理旧会话映射并按 generation 栅栏创建新会话；现有 Agent 工具只有飞书历史/发送/卡片等，没有工作区创建或 worktree 准备工具 | 不能让模型通过发送 `/conv` 字符串冒充用户指令；新增受控 Agent 工具先创建/复用 worktree、登记工作区，再为 Thread 设置对话级覆盖并建立 Session，不能改 Bot 默认 workspace 或直接切共享 repo 的分支 |

文档 `docs/方案/飞书群聊话题回复设计.md` 记录过“开启群话题自动回复”的历史方案；它不是本旅程的配置建议。现有 `PROACTIVE_DELIVERY.md` 的 `/api/dsh-im/delivery/messages` 无业务鉴权，且该端点仅面向平台文字发送；禁止扩成任意 Session 写入入口。

## 3. 架构与不变量

```text
已鉴权飞书事件 ─→ 群 Agent（校验 Issue/Repo） ─→ dsh-im 开楼／严格回帖
                                         │ 已校验的根锚点、群及 bot/turn
                                         ↓
                         ThreadJob + Agent 工作区工具（决定分支、
                           准备独立 worktree、绑定 Thread workspace）
                                         ↓ 目标工作区已验证
Agent 工具 / hook / scheduler ─→ 独立 cross-session 插件（授权／绑定／去重／队列／来源／回执）
                                         ↓
                        目标 DSH Host 的独立 Thread Session
                                         ↓
                          canonical Markdown → Taco Host → Linear
                                         ↓
                                 dsh-im 原 Thread 回复
```

1. **三个地址空间**：`botId + chatId + threadId` 是平台路由；`dshSessionId` 是模型上下文；`workspaceId + worktreePath + branch` 是代码工作上下文；Issue ID 是业务标识。它们不能互换。插件的 `binding.namespace='dsh-im:feishu-thread'` 与由 `(botId,chatId,threadId)` 构造的不可混淆键只由 dsh-im 注册适配器解释；通用插件不解析飞书 ID。具体执行 runtime 可为本机 DSH Host，或以后接入的远端/sandbox Host；不将 `sandboxId` 当作会话身份。
2. **单一权威绑定**：插件持久库保存 `bindingKey → targetHost + sessionId + workspaceId + workspaceGeneration + generation + owner`；dsh-im 的对话级 workspace 覆盖与 `state.sessions[conversationKey]` 是同一绑定的可修复投影。新建 Thread 时先由受控工作区工具提交唯一 worktree/对话覆盖，再创建该 workspace 的 Session，提交权威绑定与 `state.sessions['group:<chatId>:thread:<threadId>']`，最后才承认首轮已接纳；`#resolveKey` 不应为本旅程登记 `topics[threadId]`，否则路由会变成另一个 `managed:` key。入站 mention gate 先查询待建作业或权威绑定并恢复投影；匹配本旅程者经统一目标队列进入此 Session，普通本机会话才走现有 `askInWorkspaceSession`。没有插件时普通聊天不变，**该旅程不以降级到共享群 Session 为成功**。同 Thread 重建/新增 Session 只更换 Session 绑定、递增 generation，继承原 workspaceId/worktreePath；删除 Bot 停用绑定，旧投递失败而非覆盖新绑定。
3. **首轮创建语义**：只有验证过 bot/chat/root/thread 的适配器可申请该命名空间的 `ensureBinding`；建独立 Session 前必须已有通过受控工具登记的独立 workspace，显式设置 conversation/workspace 身份。未写入绑定的创建结果为可回收孤儿，重试不得随机创建第二个已激活绑定；worktree 准备、Session 创建、绑定与首次投递的崩溃间隙须按 job/requestId 对账。绝不从主群 Session 复制用户历史或改造其 Session ID。`/conv` 清理当前对话 Session 映射，因此**不能先投首条消息再切 workspace**；本旅程运行中禁止直接执行 `/conv` 换 workspace 或以换分支暗中创建第二工作区。要换分支，应在同一 worktree 停队列、核验旧轮次终态、校验 Git 变更安全后操作并记录版本；若必须换工作区，必须另建经人类授权的任务/Thread 与新唯一键，不在原 Thread 偷换。reset/定时任务/新增 Session 仍指向原 workspace；旧轮次回执保留原 Session+generation，不能路由到新 Session 或主群。
4. **真实来源**：角色仍为 `user`、事件类型仍为 `user/message`，但 `source.kind` 是目标 Host 可持久化的生产者种类，例如 `plugin:dsh-cross-session`，并在可验证的结构化字段中记录 `initiatorKind`、可信 `principalId`、`senderSessionId` 或 `eventId/jobId`、`requestId`；人类入站才可用 `source.kind='user'`。模型输入显式标注“自动投递／非人类指令”，不能只靠正文提示冒充审计记录。DSH v4 来源格式禁止废弃的裸 `kind: 'plugin'`（[兼容性例证](https://github.com/deepseek-ai/deepseek-harness/discussions/7772)）。host-a1 `0.1.7-rc.1` 的底层 `@deepseek-ai/dsh-session` 对 `source.kind` 只要求非空字符串，但仍须实测下游消费和历史读取。正确进程内调用是 `createUserMessage({content,source})` 生成带 `id/role` 的对象后 `agent.followup(message)`，**不是** `followup({content,source})`；该接口返回 `void`，不自带去重/完成回执。不得退回 `session.prompt` 的伪 `user` 来源。
5. **无跨域提升**：Agent 工具的 Session 身份取自 `exec.agent.session.header`，但它**不能证明当前飞书群**（同一 Session 可由多群选择共享）；每个工具调用还须消费由已验签入站事件生成、绑定 `botId/chatId/messageId/senderSessionId/turnId/sender/expiry` 的一次性受信事件凭证，按确切根锚点核销。hook/job 的主体验证由注册器/可信进程提供。调用者不能自行提交 `source.kind`、任意 `sessionId` 或声明所属 bot/chat；不能用 `keyForSession` 或跨 Bot 遍历的首个匹配推断目标群。跨群、跨 workspace、跨 bot/Agent 权限由目标 owner 与 allowlist/策略判定；跨进程入口必须有强鉴权和最小作用域；现有无鉴权发送 HTTP 端点不得复用。
6. **验收与完成分开**：投递返回的是已接收或已去重的 `receiptId` 与目标 `sessionId`，不是设计完成或飞书已送达；完成状态分别追踪 Agent turn、worktree/工作区准备、Taco 发布、Linear 关联与飞书交付。所有回执留存可查询，不把超时等同失败重试。
7. **群级父工作区**：已核验的项目群与唯一仓库绑定恰好一个 `ProjectGroupWorkspace(botId,chatId,repoId,defaultRef,observedCommit,workspaceId,generation)`，唯一键为 `(botId,chatId)`；同群仓库变更须人工重绑定，不按消息任意换库。受控同步器从远端核验 default 分支并刷新项目 workspace 的已提交基线，拒绝覆盖本地未提交修改或在离线/分支不明确时宣称最新；一次 fork 锁定父 workspace 的 `observedCommit` 与 generation。每 Thread 的 `ThreadJob` 永久记录 `parentWorkspaceId/parentGeneration/baseCommit/workspaceId`；即使父 workspace 后续更新，已有 Thread 不自动 rebase、merge 或替换工作区。群内多个 Session 同用父 workspace，Thread 内多个 Session 同用子 workspace；双向未提交内容可见性按 §9 未决，默认不暴露。

### 3.1 底层插件边界

独立包建议为 `@arcadia/dsh-cross-session`（具体包名在发布时确认）；独立 manifest/安装与版本兼容矩阵，不依赖 `@xmanrui/dsh-im` 或飞书 SDK。Host 根上下文实际提供复数 `ctx.agents`（不是 `ctx.agent`）；插件以受限 Host 服务暴露 `ctx.crossSession.deliver/query/registerBinding`，Agent 工具只给本 Session 允许访问的目标，hook/job 经同一服务适配，外部 webhook 经专门鉴权适配后再走同一 `deliver`。目标 Session 由承载选定 workspace 的 DSH Host 进程内 `ctx.agents.get/create/resume` 创建/恢复，使用 `createUserMessage`/`followup` 注入真实来源；默认不跨 Host，也不要求沙箱。若日后目标 workspace 在远端 runtime，复用相同绑定与投递契约，额外实现认证传输，而非改变 Thread 语义。`session.create` 能指定 workspace/cwd，但 `session.prompt` 会伪造人类来源，不能作为自动首投入口。现有 `askInWorkspaceSession` 可复用会话创建与 generation 约束，但 ThreadJob 的首投和人类追问必须经同一持久队列；若 Host 无法加载独立包或 `followup` 的 durable admission 做不到所需原子性，先形成受信 DSH Core admission 扩展，而不是把核心逻辑埋进飞书桥接器。

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

`registerBinding({ namespace, key, sessionId?, workspaceId, workspaceGeneration, owner, expectedGeneration })` 只开放给对应适配器：成功返回固定的**目标 Host/workspace/Session** 与 generation；指定 `sessionId` 只可由有该 owner/namespace 权限的可信 Host 调用，普通 Agent 只能请求当前策略许可的现有会话。`query(receiptId)` 返回状态和安全裁剪的错误码，不泄露工作区绝对路径、凭据、完整消息正文。`requestId` 的去重主键为 `(principalId, requestId)`，同时存目标身份、generation 和内容摘要；同键不同请求体返回 `idempotency-conflict`；跨 principal 的同名键互不冲突。回执必须包含承载该 workspace 的 Host 身份、workspaceGeneration 与 Session ID；不得从普通会话列表虚构成功。

持久表由插件管理：`Binding(namespace,key,targetHost,sessionId,workspaceId,workspaceGeneration,owner,generation,status)`、`Delivery(principalId,requestId,targetGeneration,contentDigest,receiptId,turnId,admission,execution,errorCode)`；飞书适配保存 `ProjectGroupWorkspace(botId,chatId,repoId,defaultRef,observedCommit,workspaceId,generation)` 与 `ThreadJob(botId,chatId,rootMessageId,threadId,issueId,repoId,parentWorkspaceId,parentGeneration,worktreePath,branch,baseCommit,workspaceId,sessionId,replyAnchorMessageId,stage)`。群唯一键 `(botId,chatId)`；根消息唯一键 `(botId,chatId,rootMessageId)` **永久唯一**，包括成功/失败终态；同根不同 Issue 冲突而非开新楼。同根同 Issue 重试返回原 Thread/worktree/Session/阶段；人工重开须单独授权、另记代际与旧楼审计，不能清掉原唯一键后盲重开。插件库与渠道状态不能原子提交时按 `ThreadJob` 日志补偿：`rootChecked → opening → threadKnown → workspaceReady → bound → admitted → running → published → linked → replied`，每步持久化后再做下一步；`opening` 超时或飞书返回不完整只允许读平台历史核对，确认无副作用后才重发。对账失败置 `unknown` 并通知维护者，不凭猜测产生第二楼或第二个 worktree。

Agent 输入中的外部 Issue 内容、聊天原文、仓库 README 都是未信任数据，不能覆盖系统策略、路由和工作区策略。只在通过仓库白名单与目标 repo 唯一性核验后创建绑定；root message ID 来自验签/ACL 已通过的实际入站事件，不能仅用模型从群历史挑选同文本消息。群 Agent 工具发起 `openValidatedThread({ issueId, repository, eventToken })` 时，Host 核销一次性事件令牌并校验确切 bot/chat/root/sender 与发起 turn/session、TTL 和 Issue-Repo 证明；短期事件表先落盘，重放只能查询同一个 ThreadJob，不能以 Session 反查第一群。模型不可自由传入飞书 `threadId`、工作区路径或任意 Git 命令来绕过校验。

**新增 Agent 工作区工具契约**：`prepareThreadWorkspace({ threadJobId, repoId, branchName }) → { workspaceId, parentWorkspaceId, parentGeneration, branch, baseCommit, status }`。群 Agent 在核验 Issue/Repo 后选择任务分支名并发起调用；Host 校验当前工具执行的 Session/turn/principal 与 `openValidatedThread` 签发给该 job 的短时受信能力，不能只凭可猜的 `threadJobId` 授权，并从 job 取得 repo 的真实路径及 bot/chat/thread。Host 确保群父 workspace 唯一、远端 default 分支已验证并同步到 `observedCommit`，锁定该 commit/generation 作为唯一 fork 基线；Agent 不能自由指定 `baseRef` 绕过父子关系。Host 校验仓库白名单、分支命名/冲突及 job 权限，执行参数化 `git worktree add`（不经 shell 拼接），为该 job 唯一分配路径，核实 Git 实际结果并持久记录；重放同参复用，异参冲突，不 checkout/重置群父工作树，也不删已有用户 worktree。随后 `bindThreadWorkspace({ threadJobId, workspaceId, expectedGeneration })` 以同一受信能力通过对话级 workspace 覆盖接口为该 Thread 设置工作区，不触碰 bot 默认值；仅在绑定及 generation 校验完成后建 Session/首投。失败保留可对账 job 阶段和明确错误，孤儿 worktree 按记录人工/受控回收；工具不接收任意 `cwd`、`sessionId`、`botId/chatId` 或原始命令字符串。已有 `/conv` 是人类聊天命令、只能选存在的目录，不等同于这两个 Agent 工具；目前并未实现这些工具。

## 5. 先开楼、再首投及后续入站

1. 群事件通过现有 mention gate、sender 策略和事件去重后，保存 `(botId,chatId,messageId,sender,senderSessionId,turnId,expiry)` 到短期受信事件表，并向本轮 Agent 限时提供一次性 `eventToken`；同一 Session 可能服务多个群，不能靠 Session ID 反查群。群 Agent 查 Linear 的 Issue、关联项目/仓库和访问权限；无效、关闭策略不允许、仓库不唯一时，留在群里给错误且没有 `ThreadJob` 的开楼阶段。
2. 按根消息唯一键对 `ThreadJob` 加独占锁，已有任何阶段的作业都返回原状态。通过 dsh-im 已校验的 reply 路径对 root 发**“正在建立任务工作区”阶段提示**，要求 `replyInThread=true`；返回 `threadId` 与话题内 `messageId`，检查群归属并持久化 `threadKnown`。此消息只开启 Thread，不能称为任务已开始；首轮任务文本另行进入 DSH。若平台 API 已接受而回执不完整，停止并对账，绝不盲重发。`threadKnown` 建立后，mention gate 以 `(botId,chatId,threadId)` 匹配**待绑定的 ThreadJob**；后续人类消息立即持久暂存，即使 Binding 尚不存在也不静默丢弃。若回复事件早于 `threadKnown` 落盘，`opening` 作业按同 bot/chat/root 核查飞书消息归属后先暂存并对账；无法证明该 thread 属于此 root 时既不放行也不丢弃，记 `unknown` 告警处理，绝不只凭任意 `thread_id` 绕过 mention gate。
3. 群 Agent 在已核验的 Issue/Repo 上选择工作分支，调用 `prepareThreadWorkspace` 从**已核验的群父工作区 commit**建立/复用与该 ThreadJob 唯一对应的 worktree，再调用 `bindThreadWorkspace` 登记 `group:<chatId>:thread:<threadId>` 的对话级 workspace；确认 Git 归属、父 workspace/generation、分支/baseCommit 与子 workspace generation 后，在该子 workspace 创建独立 DSH Session、建立权威绑定并同步投影。绑定成功后才在原 Thread 发送“任务已开始”；自动首投获得**持久序号 0**，在目标 inbox admission 有确证前不能释放随后人类消息。投递以原事件为幂等来源，记录 bot/agent 与 `senderSessionId/eventId`。只有插件确认 `admission=accepted|duplicate` 且给出真实 Session ID 后才认为首轮输入已投递；不能由群 Agent 自行发飞书消息假装首轮。准备或绑定失败则停在可恢复的 `threadKnown/workspaceReady` 并在原 Thread 明确提示阶段，不得退回群共享 workspace。
4. `user/message` 归 Thread Session 并开始正常轮次。目标忙时统一持久 FIFO 排队；不同请求的入站去重与先后由 ThreadJob 序号确定，首次自动投递占 0。停机后恢复未完成队列前，按 `source.requestId` 检查目标 Agent 的 nextTurn、nextStep 与 Session 历史，冷 Session 先由 Registry 恢复；`followup` 返回 `void`，因此插件回执仅在成功交给 inbox 并对账后标记 `accepted`，turn 完成另监听 Session 事件。**持久账本提交与 DSH inbox 入队不能靠两次写伪装原子性**：崩溃若使两边状态都无法证明，只标记 `unknown` 并停自动重试，保证不盲目重复但不声称自动 exactly-once；若需求坚持无人工介入的自动 exactly-once，就先扩展受信 Host 的原子 admission。独立群/Thread 可并发，同一目标有序。
5. 后续话题内有效人类消息按 `group:<chatId>:thread:<threadId>` 解析同一绑定；**不能**走现有 `askInWorkspaceSession`/`session.prompt` 直接抢跑。入站适配把人类原事件和序号持久加入 ThreadJob 的统一目标队列，恢复后按自动首投、再人类消息的顺序交给该 workspace 的当前 Session；人类消息保持 `source.kind='user'` 与原始事件 ID。mention gate 在投影不存在时仍查 `threadKnown/workspaceReady` 作业，待绑定时落盘并回执等待；绑定失败保持待处理或显式告警，绝不静默丢弃。`/new`、reset、新 Session、定时投递只改变会话/投递代际，不重建子 workspace；显式换 workspace 在此旅程拒绝并解释须新建授权 ThreadJob。删除 Bot 停用映射；旧 Session 已接受轮次的结果仍锚定最初 Thread/Session/generation，不会落到新会话或公屏。
6. **属于 ThreadJob 的全部出站**（首轮、后续追问、流式/卡片、命令、交互、延迟通知、完成、错误）均继承 `strictThread` 路由策略，只用持久 `replyAnchorMessageId` 做 `message.reply(reply_in_thread=true)`；核验群归属、`threadId` 匹配及实际投递回执。桥接器现有 `#send`/stream/fallback 不能绕过该策略调用 `message.create`，失败统一记 `delivery-blocked` 并告警管理入口，不把任何设计内容发到群主时间线。去重键覆盖主动回帖，无法确认平台是否已发时人工对账。

## 6. 设计执行、发布与兼容切换

**workspace 是必需边界，sandbox runtime 不是**：群 Session 只做 Issue 校验、建楼和调度，不共享目标 worktree 或设计 Session；每个 ThreadJob 有独立的 `issueId/repoId/workspaceId/worktreePath/branch/baseCommit` 与 DSH Session。群 Agent 决定基线/分支并调用 §4 的受控工具；目标 Session 必须在绑定该 worktree 的 workspace 上创建，后续追问续用同一 Session/工作区。当前 `/conv` 能按对话切换已有目录并清空旧 Session 映射，却不会创建 worktree，也不是 Agent 工具；不得让模型发聊天命令或在共享仓库执行 `git checkout` 来替代。工作区必须在 Thread 的可追问期间保留，归档后的恢复/清理须验证 Session 与工作树归属，未检查未提交修改时不得删除；不同 Issue 的 worktree/分支和投递目标不能串线。普通工作区不是沙箱隔离，凭据、模型工具权限和 repo 路径仍需受控。若另行选择 OpenSandbox/远端 Host 承载 workspace，再验证其运行、网络和安全门禁；PR #65 不作为本方案投递成功的先决条件或证明。

发布顺序是：设计源文件复核 → Taco 打包 → `taco-cli publish --dry-run` 检查内容及凭据 → 发布到当前指定的 `https://taco.arcadia-han.com` → 用真实 HTTP/浏览器验证可访问 URL → 向**目标 Linear Issue** 附加同一 URL → 仅成功后转 `In Review` → 在原 Thread 回复 URL 与摘要。开始工作时可置 `In Progress`；任一模型/权限/出网/发布/关联失败，都保留阶段与可重试回执，不进入 `In Review`。已发布 URL 的重试应复用已核对产物而非给别的 Issue 重新发布；评论回读与开发设计移交另由 MYST-4 承接。本地 worktree 路径不能作为评审链接。

迁移次序：先在目标 DSH/Node 版本验证插件独立加载、source v4 落盘及队列恢复，再安装插件和 dsh-im 的薄适配；只为**新建且明确验证的 ThreadJob**启用自动首投。旧 `group:<chatId>`、已有人工 Thread、`managed:<rootMessageId>` 会话保持现状，不批量搬运历史；有旧话题 Session 映射时按 owner/generation 导入绑定并核验，冲突拒绝，不静默新建。关闭插件仅禁用新自动投递，不改变普通 IM 入站；尚未完成的作业需可查询/排空后才能卸载。回滚时保留绑定、请求回执及来源审计，不把旧投递重演为新的人类输入。

## 7. 逐条验收对应关系

| Issue / 评论验收 | 设计条目与必须留下的证据 |
| --- | --- |
| 真实群 `@Bot + Issue ID`，确认前不建 Thread；仓库不明确不默选 | §5.1 受信事件与 Issue/Repo 核验；无效 ID、歧义 repo、越权事件下飞书楼数与 worktree 新建数均为零 |
| 确认后仅建一个 Thread；持久 `(botId,chatId,rootMessageId,threadId,issueId,workspaceId,dshSessionId)` | §4 `ThreadJob` 与唯一约束、§5.2 平台回执/对账；重复事件/重复 requestId/超时重试不重复开楼或建 worktree |
| 群和 Thread Session、workspace 均不同；首轮与回复归 Thread，无二次 `@`，后续追问续接 | §3 单一绑定、§5.3-6 来源及 FIFO；核对 DSH 历史 `user/message`、Session/workspace ID、Git 工作树、回复 `threadId` |
| bot／其他 Agent／hook／scheduler 通用投递，真实来源、权限、去重、忙时与冷恢复 | §3.1/§4 插件契约与 §5.4；分别由 Agent、hook、定时调度一次，跨群拒绝、同键重放、冷 Session 重启、忙时顺序与不确定提交对账 |
| Agent 选择分支并发起工具建独立 worktree，不影响共享 checkout；双 Issue 不串线 | §4 工具契约、§5.3/§6；记录 Agent 选择的 `baseRef/branchName`、实际 baseCommit/worktreePath、会话 cwd/代际；测试冲突、断电恢复、旧工作树有修改时拒绝清理、并发不同 Issue 与切换中追问 |
| canonical Markdown、dry-run、HTTPS Taco URL、正确关联 Linear、成功才 `In Review` | §6；读取源与发布物、URL 可达证据、Issue 附件/状态变更日志；发布和关联失败不会推进状态 |
| 最终 URL/摘要只到原 Thread，失败不回退公屏；重试不重复无关产物 | §5.6、§6；抽查首轮/追问/流式/交互/错误全分支的飞书真实回执与原 root/thread 匹配、平台模糊回执进入人工对账；不出现主群公屏设计内容 |
| 原工单第 2 条：host-a1→host-c1 真实创建／执行／清理 OpenSandbox，沙箱内真实模型/仓库/文件及双 Issue 隔离 | **当前方案不覆盖、未验收**。§6 的 worktree 只隔离代码上下文，不提供沙箱权限/网络隔离；若保持原验收，则必须在独立 host-c1 执行线完成 DSH→OpenSandbox 会话/工作区适配、沙箱生命周期与工具/凭据出网实测，并在双 Issue 下证明隔离；不得以 §5 的本机执行或 PR #65 镜像代替。见 §9 待决策点。 |
| 原工单第 4 条：host-c1 服务/网络/模型现场证据及真实端到端冒烟 | **当前方案只覆盖 host-a1 与本机 Thread 链路，host-c1 项未完成**。若保持原验收，记录 host-c1 服务/鉴权/网络、隔离门禁、真实模型/仓库/发布与完整链路证据；若用户决定修改工单验收，先正式更新工单与对应验收表，再按新口径验证。见 §9 待决策点。 |
| host-a1 工作区/模型与发布域名现场验证；上线前端到端冒烟 | §8 清单，附版本/manifest 哈希、workspace 分离、工具授权、发布/回帖现场记录；**原工单另要求 host-c1 现场及真实跨主机冒烟，目前不由本 PR 证明**，需按 §9 裁决后的正式验收口径执行 |

## 8. 实现顺序与验证计划

1. **兼容性门槛**：核对 host-a1 dsh-im 本地 tarball、manifest 哈希、DSH/Node 版本；在承载 Thread workspace 的 DSH Host 用 `ctx.agents`/`createUserMessage`/`followup` 验证指定冷 Session 得到合法非人类来源的 `user/message`、正常 turn、重启恢复与可查询状态，并确认 session.cwd/workspace 不会从群共享 checkout 继承。`followup` 不返回 admission 回执或自动幂等，须按 §5.4 证明账本/DSH 历史对账可处理崩溃不确定性，否则先做受信 DSH 原子 admission 扩展；绝不改用 `session.prompt` 伪来源。
2. **通用插件**：独立包与 Host 服务、受信身份与 ACL、版本栅栏、单绑定权威、持久去重和 FIFO/恢复；写跨群拒绝、并发、崩溃各阶段及原子性能力验证。外部 hook/scheduler 只实现适配调用，不复制会话管理。
3. **dsh-im 适配与工作区工具**：在 `plugin-src/host/feishu-tools.mjs`/`delivery-service.mjs` 的工具与能力边界加入带事件令牌的受信根锚点、`ThreadJob` 与 `prepareThreadWorkspace`/`bindThreadWorkspace`；工作区 API 以对话键登记已有的真实 worktree，不改变 bot 默认；在 `src/channels/feishu/{bridge,feishu-runtime,state-store}.mjs` 的 mention gate、所有出站分支适配待绑定暂存与严格话题回复；`src/channels/shared/{bot-workspace-store,workspace-session}.mjs` 的对话工作区/Session 映射与投递队列按 generation 协调。迁入当前工作树未合并的“历史读取、回复回执”变更需单独审阅，不直接复制本地未提交文件。
4. **执行器接线**：让 Agent 从已核验 Issue/Repo 选择基线与分支并主动调用工作区工具，确保创建的 Session 绑定该 worktree；在此 workspace 生成 canonical Markdown/Taco、校验发布 URL、Linear 回填和状态门禁。sandbox runtime 如有需要后续另行接入，不把 PR #65 的镜像或 host-c1 配置当作本项实现依赖。
5. **回归与实机**：保持全局 `groupTopicReply=false`、`groupResponseMode=mention`，验证普通群/既有话题/私聊无回归；在测试群真实 Issue 跑一次发起→开楼→Agent 选分支/建 worktree→绑定 workspace/Session→首投→生成→dry-run→发布→关联→回帖；再并发两个群/Issue，模拟分支冲突、工作区切换/删除、模型/权限/飞书缺回执/发布失败，重启 Host 后恢复和去重。部署更新先对照 manifest 才能替换 tarball，未提交 update-card 等工作不得当作上线证据。

### 8.1 独立插件当前实现与本方案的差距

独立仓库 [Arcadia822/dsh-message-gateway Draft PR #1](https://github.com/Arcadia822/dsh-message-gateway/pull/1) 已实现 Host 进程内的 `ctx.messageGateway.connect(principalId, token)`、已有 Session 的 `registerBinding`、精确目标授权的 `deliver/query` 与两个按执行 Agent Session 限权的工具。`deliver` 使用 `createUserMessage` + `agent.followup` 写入非人类 `source.kind='plugin:dsh-message-gateway'`，在 DSH Session flush 后返回 `queued` 回执；崩溃或无法确认持久事件时标记 `unknown`，不自动重放。单进程持久状态支持幂等请求、绑定冲突及目标代际校验。测试覆盖两目标隔离、Agent/hook/scheduler 来源、重启去重、缺失事件和持久化失败；Cordis 冒烟运行了真实插件与 DSH Session 事件，但 Agent/flush 是合成适配，不构成真实模型轮次或持久化 DSH Store 的实机证据。

此 PR **不是** §3–§8 全链路实现：现有插件只允许向已有/可恢复 Session 绑定，不创建工作区、worktree 或目标 Agent；绑定授权是赋予受信 owner 的命名空间管理权，不是本方案所需的飞书 bot/chat/root/thread 一次性事件凭证。当前配置中的 `targets` 是静态精确键，尚无动态 Thread ACL 注册/撤销、工作区 generation 同步、跨进程队列、webhook/定时适配、飞书回帖或 host-c1 执行。§4 的 API 类型是目标设计而非已交付接口；实际接口见该仓库 README。必须完成 Host/dsh-im 接线和实机验收后，才可声称 MYST-38 的首投与追问闭环已通。

## 9. 风险、需预先验证的事实与待决策点

可实施性风险不是产品取舍：目标 DSH 是否允许独立插件对新 workspace 的 Session 写入合法非人类 `source.kind` 并在冷恢复中保持 requestId 去重、是否有 durable admission API、现有对话工作区切换的 generation 与投递队列能否一致恢复，均尚未经目标部署实测。验证失败则按 §8.1 先做最小 DSH/运行时能力扩展；不能以正文注记、伪飞书事件或 `session.prompt` 伪人类输入替代。飞书创建 Thread 的 API 回执与后续消息归属、worktree 的仓库/分支/基线核验也须实机核对。当前 Linear Issue 的 host-c1 验收文字需与用户的新范围对齐；本设计不擅改 Issue。以下需要人类权衡的选项不阻止评审，**未裁决时的默认行为仅供评审，不代表批准**。

### 待决策点：MYST-38 执行范围与原工单验收

- **问题与背景**：Linear 正文及第 2、4 条验收明确要求 host-a1→host-c1 OpenSandbox 真实执行与现场证据；本地设计与后续用户澄清选择 Thread 独立 worktree，不再以 host-c1 为前提。两种口径不能同时宣称是同一个已验收的闭环；曾获准在测试 MVP 启动有隔离缺口的服务，不等于批准带真实凭据运行不可信任务。
- **选项 A（推荐）**：本 PR 只设计并在后续单独验收工作区/通用投递链路；由工单负责人正式改写 MYST-38 的 OpenSandbox 条款或拆出独立工单，保留原版证据与 PR #65 链接。优点是业务起点最短且不把安全沙箱伪装成 worktree；代价是原第 2、4 条**在修改前仍不通过**，修改后还需另验沙箱线。
- **选项 B**：保留 Linear 现有全部验收，交付两条线：本 PR 的 Thread/投递/工作区设计，加 host-c1 独立执行适配和隔离门禁（由 PR #65 等独立工作承接）；两条线真实端到端后才标记 MYST-38 通过。优点是保持原工单承诺；代价是 DSH→远端会话/工作区、生命周期、安全与凭据门禁显著增加，不能以镜像或服务健康检查替代。
- **影响面**：Issue 验收和状态、MYST-4 依赖、host-c1 运行安全、PR #65、实机验证及上线条件。**不作决策的默认行为**：以原 Linear 文本为唯一正式验收，不推进“已完成”或上线；本设计只提供可评审的工作区路线，不修改 Issue、不执行真实凭据任务。

### 待决策点：项目群与任务工作区的未提交内容互见

- **问题与背景**：交接约束要求项目群 workspace 与 Thread workspace 双向可见，却未定义是否包含未提交内容；简单 worktree 只能天然共享已提交对象/引用，不能自动安全共享双方工作树的未提交改动。
- **选项 A（推荐）**：互见只通过显式选择的快照/受控只读视图（可包含经授权的未提交内容），不自动写入对方工作树；优点是覆盖双向互见且保留来源与访问审计，代价是需要快照生命周期与敏感文件过滤。
- **选项 B**：仅已提交的 Git 状态可见；优点是实现简单，代价是**不满足交接所述未提交内容可能互见的期待**，需由用户明确收窄该业务语义。
- **影响面**：workspace 读取权限、未提交内容保密、Agent 协作、快照/清理、测试样例。**不作决策的默认行为**：不自动暴露或复制任何未提交内容，保持独立工作树；互见能力不宣称通过验收，待业务范围与权限规则确认。

### 待决策点：独立插件发布归属

- **问题与背景**：需求明确“独立的 cross-session 底层能力插件”；当前 dsh-im 是单 npm 包，仓库没有现成独立插件工作区规范。包与仓库归属会影响版本和授权边界，不应在 dsh-im 内复制一份通用 Host 逻辑。
- **选项 A（推荐）**：单独 npm 包/仓库发布，与 dsh-im 按明确 Host service 契约耦合；代价是两个发布流水线与版本矩阵。
- **选项 B**：在 dsh-im 仓库中独立包目录和独立 manifest/产物发布；代价是同仓发版治理，且须防止 dsh-im 直接依赖内部源码。
- **影响面**：源码归属、许可证/发布权限、部署顺序、维护者。**不作决策的默认行为**：选 A；本 PR 只放接口与适配方案，不假设已有包或发布凭据。

## 10. 独立审查记录

独立只读审查（2026-09-29）**针对上一稿**的结论为 incorrect，6 项发现；没有构建、测试或部署验证。前四项和终态根消息重复开楼风险仍沿用修订：① 同一 Session 反查首个群可能错投/越权（`bridge.mjs:2757-2763`）→ §3.5/§4/§5.1 的受信事件令牌；② 回执到绑定间消息被 mention gate 丢弃（`bridge.mjs:967-991`）→ §5.2 暂存；③ 人类 `ask` 绕过插件 FIFO（`bridge.mjs:1299-1327`、`harness-client.mjs:1797-1804`）→ §5.3-5 统一队列；④ `#send` 公屏 fallback（`bridge.mjs:5976-6015`）→ §5.6 严格路由；⑤ 上一稿的“本机 Session 不等于 host-c1 沙箱执行”依据的是当时的沙箱硬约束，**用户现已撤销这一设计前提**，改为 §3/§6 的 Thread 独立 workspace/worktree，仍须验证工作区与 Session 真正绑定，不能把工作区误称为沙箱；⑥ 作业终态释放根消息导致重开楼 → §4 永久唯一映射。以上只是设计修订，不是代码修复或复审通过。

本轮按用户澄清改为「Agent 决定并通过工具准备独立 worktree，先绑定 Thread workspace 后创建 Session」。已对照现有 `/conv`、会话 generation、Host 工具注册路径自检；**本轮没有独立复审或运行时验证**，不能把旧审查结论当成本轮方案获批。
