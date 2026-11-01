# ARCHITECTURE — dsh-im 的结构与取舍

> 目标读者：第一次接手本仓的贡献者。读完应当能回答三个问题：一条微信消息如何走到 Harness、
> 如何回到原群、以及要新增一个渠道该改哪一处。
> 文中每个路径与行号都在 2026-11-02 现读现引；复算方式见文末〈读数复算〉。
> 权威设计取舍不在本文，而在 [docs/adr/0001-semantic-core-native-channel-adapters.md](docs/adr/0001-semantic-core-native-channel-adapters.md)。

## 1. 一页速览

```
平台事件（14 个 IM / 1 个 Office 连接器）
   │  各渠道 api + runtime：把原生事件规范化
   ▼
渠道 bridge（src/channels/<channel>/）
   │  TextHarnessBridge 统一「一条消息 → 一个 Harness 轮次」的编排
   ▼
共享语义核心（src/channels/shared/）
   │  访问控制 · 触发判定 · 上下文增强 · 群历史 · 会话绑定 · 产物登记
   ▼
DeepSeek Harness（宿主会话 / Turn / Session 格式 v4）
   │  回复、进度、审批问题、产物
   ▼
投递（plugin-src/host/delivery-*.mjs）
   │  按 target kind 路由回原会话，超长按渠道分片，失败留痕
   ▼
平台原生呈现（卡片流式 / 编辑同一条消息 / 分段文本 = 明确降级）
```

三条硬约束贯穿全图，来自 ADR-0001：

1. **横向建设统一语义，纵向逐个渠道打磨**：业务规则只在共享层写一次，渠道差异留在边界内。
2. **增量包裹 + 等价接管**：既有行为是最低基线，新路径不得靠删除、降级或转移既有能力换取新能力。
3. **明确降级要说出口**：平台做不到时要有可见的退路（例如流式失败时改发完整文字），不能静默丢内容。

## 2. 三层身份与目录地图

本仓同时是三个东西，搞混层数是从改错文件开始的第一大原因。

### 2.1 第一层：IM 渠道接入（运行源码）

| 目录 | 职责 | 代表文件 |
| --- | --- | --- |
| `src/channels/<channel>/` | 平台 SDK 调用、事件规范化、原生呈现、错误分类 | `src/channels/feishu/bridge.mjs:633`（`FeishuHarnessBridge`） |
| `src/channels/shared/` | 跨渠道语义核心：策略、会话、投递、历史、i18n | 见 2.2 |
| `src/channels/shared/conversation/` | 会话语义与触发判定 | `src/channels/shared/conversation/trigger-policy.mjs:19`（`TRIGGER_REPLY_MODES`）、`:50`（`evaluateTrigger`） |
| `src/channels/shared/semantic/` | 产物、投递、引用回复的公共语义 | `src/channels/shared/semantic/artifact.mjs:7`（`OUTBOUND_ARTIFACT_TOOL`） |

14 个渠道目录 + `shared`，共 278 个 `.mjs` / 81,399 行（复算：
`find src -name "*.mjs" | wc -l`、`find src -name "*.mjs" -exec cat {} + | wc -l`）。

### 2.2 第二层：Agent 桥接（把 IM 变成 Harness 轮次）

| 文件 | 作用 | 为什么在这一层 |
| --- | --- | --- |
| `src/channels/shared/text-harness-bridge.mjs:185` | `TextHarnessBridge`：一条入站消息 → 一个 Harness 轮次 → 回投 | 2,350 行的公共编排队，Discord 等渠道直接继承它（`src/channels/discord/discord-bridge.mjs` 只需给 descriptor） |
| `src/channels/shared/harness-mux.mjs:119` | `watchHarnessMux`：宿主多路复用的观察与恢复 | 渠道不各自实现「宿主断了怎么办」 |
| `src/channels/shared/harness-client.mjs` | 对宿主内部网关的统一客户端（2,488 行） | 重试、错误分类、鉴权口径全渠道一致 |
| `src/channels/shared/harness-session-binding.mjs:86` | `adoptRegisteredWorkspaceSession`：把已登记工作区的会话收养回来 | 会话归属是业务语义，不是平台语义 |
| `plugin-src/host/modern-harness-api.mjs` | 宿主现代 API 的适配（981 行） | 新旧宿主 API 差异只在这里收敛 |
| `src/channels/shared/session-binding-lock.mjs` | 会话绑定的并发锁 | 见 3.3 的竞态解释 |

### 2.3 第三层：cordis 插件（构建与装配）

| 目录/文件 | 职责 |
| --- | --- |
| `plugin-src/host/index.mjs` | 宿主侧插件入口：遍历渠道注册表装配、`provide` 投递服务、注入宿主依赖 |
| `plugin-src/host/channel-registry.mjs:42` | `HOST_CHANNELS`：14 个渠道的**唯一**清单与顺序来源 |
| `plugin-src/host/channels/<name>/` | 每个渠道的生产装配：`index.mjs` / `production.mjs` / `rpc.mjs`（部分渠道另有 `connection-supervisor.mjs`、`credential-store.mjs`） |
| `plugin-src/host/channels/shared/` | 跨渠道管理 RPC：`access-policy-rpc.mjs`、`model-setting-rpc.mjs`、`startup.mjs` 等 16 个 |
| `plugin-src/client/index.js` | 设置页客户端（卡片、表单、面板） |
| `bin/dsh-im.mjs` | `dsh-im install / uninstall` CLI |
| `cordis.patch.yml` | 宿主 profile 里的插件挂载声明 |

构建侧只有两个 esbuild 入口：`plugin-src/host/build.mjs:28`（入口 `index.mjs`，
`:36` 写出 `lib/index.js`）与 `plugin-src/client/build.mjs:13`（写出 `lib/client.js`）。

## 3. 消息生命周期

### 3.1 入站：从平台事件到 Harness 轮次

```
1 平台长连接/回调/轮询事件          渠道 api + runtime（如 src/channels/telegram/telegram-runtime.mjs）
2 规范化为统一语义消息              提取会话标识（群 or 私聊）、发送者、引用、附件
3 访问控制                          src/channels/shared/access-policy.mjs（白名单 / 命令权限 / 群策略）
4 触发判定                          src/channels/shared/conversation/trigger-policy.mjs:50
                                    「必须 @」「回复才回」「全部响应」在此统一，不在渠道里各写一遍
5 上下文增强与群历史                src/channels/shared/context-enhancement.mjs + group-history-store.mjs
6 会话映射与串行                    harness-session-binding.mjs:86 + conversation-queue.mjs + session-binding-lock.mjs
7 交给 Harness 并显示进度            text-harness-bridge.mjs:185；思考过程形态由渠道决定
```

关键顺序约束：**先判定要不要响应，再花上下文增强的开销**。反过来的话，一个不该响应的群消息
也要付一次历史查询与拼装的成本，且会把不该进模型的聊天内容送去宿主。

### 3.2 出站：从 Harness 回复回原会话

投递服务是出站唯一入口：`plugin-src/host/delivery-service.mjs:672`（`createDeliveryService`），
单次发送与回执核验在 `:556`（`sendChecked`，带 `expectedFingerprint` / `expectedTargetDigest`）。

```
Harness 产出一段答案 / 一个产物
   → delivery-adapter：把 target kind 校验成该渠道能接受的路由形状
   → 渠道原生发送：卡片流式 / 编辑同一条消息 / 分段文本
   → 失败留痕：delivery-failure-log.mjs 生成用户能复述的短编号
```

target kind 的集合就是渠道能力的机器可读表述（`plugin-src/host/delivery-adapter.mjs:81` 起逐渠道分支）：

| 渠道 | 允许的 kind | 路由必需字段 |
| --- | --- | --- |
| weixin | `user` | `toUserId` |
| feishu | `user` / `group` | `openId` / `chatId` |
| dingtalk | `user` / `group` | `userId` / `openConversationId` |
| wecom | `user` / `group` | `chatId` |
| wecom-app | `user` | `chatId` |
| qq | `user` / `group` | `userOpenId` / `groupOpenId` |
| slack | `conversation` / `thread` | `channelId` (+ `threadTs`) |
| telegram | `chat` / `topic` | `chatId` (+ `messageThreadId`，必须是正整数) |
| discord | `channel` | `channelId` |
| whatsapp | `user` / `group` | `jid`（按 `@s.whatsapp.net` / `@g.us` 校验） |
| imessage | `user` | `chatGuid` |
| email | `user` | `address`（统一小写，避免大小写产生两个目标） |
| matrix | `room` / `thread` / `dm` | `roomId` (+ `threadId`) / `userId` |

注意 `CHANNELS` 集合（`plugin-src/host/delivery-adapter.mjs:11`）有 13 个渠道，**不含 office**：
AI Office 是连接器而不是 IM 会话面，产物经 `src/channels/office/office-transport.mjs` 自己回投。

### 3.3 为什么出站要有指纹与回执核验

IM 平台的发送接口普遍「返回成功但内容没落地」（微信 `sendmessage` 返回 `ret:0` 而客户端收不到，
见 issue #508 的记录）。所以出站不能把 HTTP 2xx 当成功：
`sendChecked` 要求调用方声明「我要投的是哪一个目标、哪一份内容」（`expectedTargetDigest` +
`expectedFingerprint`），投完读回平台侧事实再判定。这样重试才不会把同一条答案投成两条。

### 3.4 主动投递（没有入站消息也能发）

入口是宿主侧的 `/api/dsh-im/...`（`plugin-src/host/delivery-http.mjs` + `delivery-rpc.mjs`），
用法与鉴权口径见 [PROACTIVE_DELIVERY.md](PROACTIVE_DELIVERY.md)（仓库根，28 KB，中英双语）。
访问控制默认沿用 Harness 的浏览器认证与 Host/Origin 信任检查，可收紧为 `rpcAuthority: loopback`。

### 3.5 产物：路径不会自动变成附件

`src/channels/shared/semantic/artifact.mjs:7` 定义工具名 `dsh_im_return_file`，
`:275` 是登记表 `OutboundArtifactRegistry`，`:643` 是工具装配。规则（ADR-0001 明文）：

> 出站产物必须由受信工具显式登记并绑定 Session/Turn；助手回答里的路径、Markdown 本地链接、
> 工作区扫描结果都**不能**自动触发文件发送。

这条约束的存在理由：如果「答案里出现某路径」就等于「发送该文件」，模型生成的任意文本都会
变成读文件的通道。登记之后，发送对象永远是工具调用产物，可审计、可回滚。
投递编排在 `src/channels/shared/semantic/artifact-delivery.mjs:65`（`deliverOutboundArtifacts`）。

## 4. 渠道适配器契约

### 4.1 一个渠道目录的最小文件集

```
src/channels/<name>/
  <name>-api.mjs          平台 SDK / HTTP 调用，不含业务判断
  <name>-runtime.mjs      连接形态（长连接 / 回调 / 轮询）与重连
  <name>-bridge.mjs       入站事件 → 统一语义；出站 → 原生呈现
  <name>-controller.mjs   每个机器人实例的生命周期（绑定 / 连接 / 停止 / 移除）
  config-store.mjs        凭据与渠道配置读写
  state-store.mjs         运行态与游标
  harness-client.mjs      该渠道向宿主取会话的客户端
```

体量差异体现的是**平台能力差异**，不是完成度差异：`src/channels/imessage/`（448 行 / 7 文件）
只有文本私聊，`src/channels/feishu/`（14,874 行 / 26 文件）有卡片流式、语音、权限补全、斜杠面板。

### 4.2 装配三件套与注册表

`plugin-src/host/channel-registry.mjs` 是渠道集合与顺序的唯一来源，一条注册项包含：

| 字段 | 含义 | 何时需要写 |
| --- | --- | --- |
| `configKey` | 插件配置里的切片名（`config[name]`） | 必填 |
| `applyName` | 测试/调用方通过 `createImHostPlugin(internals)` 覆盖时用的键 | 必填 |
| `apply` | 生产激活函数 | 必填 |
| `deliveryKey` | 投递服务使用的渠道名 | 仅当与 `configKey` 不同（现只有 `wecomApp` → `wecom-app`） |
| `withoutDeliveryService` | 不共享投递服务 | 仅 `office` |

`plugin-src/host/index.mjs:62` 把注册表映射成「覆盖项 ?? 生产实现」，`:66` 派生出参与会话同步的渠道集合，
`:73` 据此算出投递服务需要的 `unavailableSessionSyncChannels`，`:190` 并发激活全部渠道并把失败聚合。

这里有一条不能改成串行启动的规则（`index.mjs:190` 的注释也写了）：每个渠道先挂自己的管理 RPC 再
等待初始化完成，若串行启动，一个慢渠道会让后面所有渠道的路由在初始化期间缺失。

另一条是 HMR 相关：`:104` 起在 `provide` 前先检查 `ctx.get("dshIm")` 是否已存在。原因是热重载时
旧纤体尚未 dispose，cordis 拒绝同名服务二次 `provide`，插件每次热重载都会失败；保留已存在的注册
才是 HMR 真正使用的那一份。

### 4.3 错误降级规则

1. 渠道不支持的能力 → 用更朴素的原生形态（例：卡片流式不可用则分段文本），并**保留全部内容**；
2. 平台瞬时故障 → 渠道内按分类退避重试（错误分类见 `connection-error.mjs` 与 `send-error.mjs`），
   重试要封顶，不能无限重试（微信群 surface-loss 重试封顶两分钟，提交 `d69c7e9`）；
3. 判定不了的失败 → 报告「读不到」而不是「没有」（把「目录缺失」与「面板关闭」区分开，提交 `1d22a8d`）。

把第 3 条写成硬规则的理由：把「读不到」当成「没有」会让上层以为用户退出了登录，从而做出删绑定这种破坏性动作。

### 4.4 能力矩阵不是散文

`scripts/channel-capability-matrix.mjs:43` 定义 9 列能力（文本/图片/文件/语音/引用回复/群聊/
流式·编辑/卡片·按钮/富文本），从 `src/channels/*/` 的实际调用点生成表格，围栏写入中英两份 README。

匹配器只认「发送/上传的函数调用点」，不认文案里出现过的词。本仓实测过的三个假阳性：
`image_key` 命中微信的校验文案、`audio` 命中 Discord 的「拒绝附件」错误提示、
`room` 命中 iMessage 的一对一 API。假阳性比漏报危险：漏掉会被人工复核补回，假阳性直接变成对外承诺。

## 5. 构建与发布

```
npm run build
  = node plugin-src/client/build.mjs   -> lib/client.js  （约 1.8 MB）
  + node plugin-src/host/build.mjs     -> lib/index.js    （约 10.1 MB）
```

**`lib/*.js` 是入库的**，这不是疏忽而是发布形态：`dsh plugin add` 安装的是发布包里的字节，
不会现场构建。由此得到两条纪律：

1. 改了会进 bundle 的内容（`src/`、`plugin-src/`，甚至 `package.json`——它作为 manifest 被编入 bundle）
   之后必须 `npm run build`，并把 `lib/index.js`、`lib/client.js` 与源码**同一笔提交**。
2. 这条纪律有判据：`scripts/verify-built-artifacts.mjs` 比较工作树产物与 `git show HEAD:lib/<file>`，
   不一致时输出 `BUILT_ARTIFACTS_DRIFT <file>: committed <sha12> != built <sha12> (first differing byte N)`
   并以非零退出。

该守卫落地当天就抓到一次真实漂移：把两个校验脚本加进 `package.json` 的 `files` / `scripts.check` 之后，
manifest 变了，`lib/client.js` 的前 2 个 hunk 随之改变（`first differing byte 23874`）。这正是「源码修了但用户
加载的还是旧 bundle」的形态，只是这次被门禁拦住了。

构建是**确定性**的（两次连续构建产物 sha256 相同），这是「字节相等」可以当判据的前提；若不先验证这一点，
漂移守卫就会因为时间戳之类的不相关噪声恒红。

## 6. 门禁与测试

`npm run check` 七段（`package.json:112-114`，逐段职责）：

| # | 命令 | 职责 | 失败说明什么 |
| --- | --- | --- | --- |
| 1 | `npm run build` | 产 bundle | 源码或构建脚本本身坏了 |
| 2 | `npm test` | `node --test test/*.test.mjs test/channels/*/*.test.mjs` | 行为回归 |
| 3 | `scripts/verify-package.mjs` | 发布包内容与凭据检查 | 包结构坏了或夹带了凭据 |
| 4 | `scripts/verify-built-artifacts.mjs` | 产物 ⇄ 源码一致 | 忘记构建或忘记提交 bundle |
| 5 | `scripts/channel-capability-matrix.mjs --check` | README 能力表 ⇄ 源码 | 实现变了但文档没变（对外承诺失真） |
| 6 | `scripts/verify-benchmark-report.mjs` | 对标报告八维与四要素齐全 | 报告缺章或少节 |
| 7 | `scripts/verify-governance.mjs` | 治理文件存在且互相引用 | 贡献入口断了 |

测试规模：`test/` 下 300 个 `.mjs`，全量约 4,769 用例（复算：`node --test test/*.test.mjs
test/channels/*/*.test.mjs` 末尾的 `ℹ tests` 行）。没有覆盖率门禁，也**没有**独立基准脚本——见第 8 节。

### 6.1 判据必须能变红

本仓的每个自造判据都配一条负向对照（证明它不是恒绿）。复跑示例：

```sh
# 产物守卫：注入一字节必须红，还原必须绿
cp lib/index.js /tmp/ix.bak && printf '\n// drift probe\n' >> lib/index.js
node scripts/verify-built-artifacts.mjs        # 期望 BUILT_ARTIFACTS_DRIFT lib/index.js
cp /tmp/ix.bak lib/index.js && node scripts/verify-built-artifacts.mjs   # 期望 BUILT_ARTIFACTS_OK

# 能力矩阵：把某渠道的 sendText 改名，--check 必须红
node scripts/channel-capability-matrix.mjs --check

# 治理：临时移走 SECURITY.md，必须报 GOVERNANCE_MISSING
mv SECURITY.md /tmp/ && node scripts/verify-governance.mjs; mv /tmp/SECURITY.md .

# 渠道注册表：建一个没有注册项的目录，配对判据必须红
mkdir -p plugin-src/host/channels/matrixtest && node --test test/channel-registry.test.mjs
rmdir plugin-src/host/channels/matrixtest
```

`test/channel-registry.test.mjs`（8 条）钉住四件事：注册表 ⇄ `plugin-src/host/channels/` 目录一一对应、
每条注册项的 `apply` 必须就是同渠道模块导出的那个函数、激活顺序与逐渠道 `deliveryService` 契约、
以及「`index.mjs` 不得再自带渠道清单」。最后一条是把本次重构的结果钉住：一旦有人把渠道名写回
`index.mjs`，注册表与装配就会分叉，这条判据先红。

### 6.2 i18n 的字面量规则

`src/channels/shared/AGENTS.md` 是唯一权威：宿主侧文案以**中文原文**作为 key 调用 `t()`，
新增字面量必须同时进每一个词典（各 `i18n-<lang>/` 分卷与 `i18n-<lang>.mjs` 合并模块），
占位符逐字节不动。`test/channels/shared/i18n-coverage.test.mjs` 会把漏项判红并点名是哪个文件加的——
散文规则拦不住，必须靠测试。

### 6.3 CI

`.github/workflows/ci.yml` 两个 job：`Test, build, and verify package`（ubuntu，跑完整 `npm run check`，
`:12`）与 `Workspace and QR regression tests (Windows)`（`:31`，只跑会话工作区恢复与二维码编码两组专项）。
触发面是 push 到 `main` 与 `feishu-*`，以及所有 PR。

## 7. 扩展点

### 7.1 新增一个渠道

五步（权威版本在 [CONTRIBUTING.md](CONTRIBUTING.md) 第 4 节，此处只给骨架）：

1. `src/channels/<name>/`：按 4.1 的最小文件集实现；
2. `plugin-src/host/channels/<name>/{index,production,rpc}.mjs`：生产装配与管理 RPC；
3. `plugin-src/host/channel-registry.mjs`：**加一条注册项**（`index.mjs` 零改动）；
4. `plugin-src/client/channels/<name>/{index,api,styles}.js`：设置页卡片；
5. `test/channels/<name>/`：入站规范化、出站分片、错误降级三类各至少一条。

然后 `node scripts/channel-capability-matrix.mjs --write` 把新渠道自动纳入能力表，再 `npm run check`。

### 7.2 新增一项跨渠道能力

顺序不能倒：先在共享语义层定义**用户语义 + 降级规则 + 验收标准**，再进渠道 SDK 实现，
并选一个原生能力最强的渠道做标杆渠道验证状态机。理由见 ADR-0001 的 Considered Options ——
「最低公分母模型」会持续丢按钮、引用、文件、语音、线程这些高价值能力。

### 7.3 其它扩展面

| 面 | 入口 | 说明 |
| --- | --- | --- |
| 机器人命令 | `src/channels/shared/command-catalog.mjs` | 单一命令目录，各渠道命令菜单由它下发；文档 `docs/bot-commands.md` |
| 管理 RPC | `plugin-src/host/channels/shared/*-rpc.mjs` | 16 个跨渠道设置面 |
| 渠道客户端页 | `plugin-src/client/channels/` | 每个渠道 `index/api/styles` 三件套 |
| 验证脚本 | `scripts/verify-*.mjs` | 面向真实宿主的端到端核验（`verify-injected-context.mjs` 等，需传入宿主路径） |

## 8. 已知取舍与限制

| 事实 | 现状 | 为什么这样 |
| --- | --- | --- |
| 类型系统 | 全仓纯 JS/ESM，无 `tsc` 门禁 | 与 cordis 插件形态一致、构建链最短。代价：能力声明只能靠运行时生成 + 判据（第 4.4 / 6.1 节） |
| `shared` 组织 | 78 个 `.mjs` 平铺在 `src/channels/shared/`（`conversation/`、`semantic/` 两个子目录已抽出） | 抽出的是有明确边界的两块；其余仍是历史平铺，登记为待办 M2 |
| 单文件体量 | `src/channels/feishu/bridge.mjs` 6,695 行，是全仓最大 | 飞书是标杆渠道（卡片流式/语音/权限补全/斜杠面板）。风险由测试面兜，不由拆分兜 |
| 构建产物入库 | `lib/` 约 11.9 MB | 发布形态决定（第 5 节），并由漂移守卫保证不脱钩 |
| 微信个人群 | 本机 UIA 桥 `scripts/wechat_group_uia.py`，仅 Windows + 本机微信，`allowSend` / `allowWindowRestore` 需显式开 | 官方通道无群能力。代价与信任边界写在 [SECURITY.md](SECURITY.md)：启用它等价于本机拥有一个能读屏、能模拟输入的程序。运行手册 `docs/wechat-group-runbook.md` |
| Matrix | 标记实验功能；加密默认 `optional` | 未做交互式设备验证 / 密钥备份 / SSSS / 媒体加密，未验证真实 homeserver 互通 |
| iMessage | 仅文本私聊，仅 macOS | 用原生 Messages.app，不依赖 BlueBubbles；首版不含图片 |
| 宿主兼容面 | `package.json` 只声明 `0.2.0-rc.2` / `0.2.1-rc.2` | 不承诺未验证的未来版本 |

### 8.1 未取证（不冒充已完成）

- **无吞吐/延迟基准**：全仓没有基准脚本，性能证据只有单点修复记录（例如微信群发送按钮定位
  34.5 s → 156 ms，提交 `4fe8b1d`）。与上游不存在可比口径。
- **无覆盖率数字**：`.gitignore` 含 `coverage/` 但没有产物，测试量（4,769 用例）不等于分支覆盖。
- **上游未实跑**：`docs/benchmark/2026-11-01-dsh-im-benchmark.md` 的结论来自源码、文档与 GitHub API
  阅读，没有 clone 运行过任何上游项目。

### 8.2 读数复算

```sh
find src -name '*.mjs' | wc -l                                  # 278
find src -name '*.mjs' -exec cat {} + | wc -l                    # 81399
ls src/channels/shared/*.mjs | wc -l                             # 78
find test -name '*.mjs' | wc -l                                  # 300
wc -l plugin-src/host/channel-registry.mjs                       # 62（14 条注册项）
wc -l src/channels/shared/text-harness-bridge.mjs \
      src/channels/feishu/bridge.mjs plugin-src/host/modern-harness-api.mjs
node --test test/channel-registry.test.mjs                       # pass 8
node scripts/channel-capability-matrix.mjs --check               # CAPABILITY_MATRIX_OK 14 channels, 2 document(s)
```

采集时刻：2026-11-02T01:45+08:00，HEAD 见 `git rev-parse HEAD`。分支上另有会话在并行提交，
数字若对不上请先重跑上面这组命令，再怀疑本文。
