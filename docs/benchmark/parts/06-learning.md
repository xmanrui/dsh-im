## 5. 系统性学习记录与知识盲区

> 这一章回答「读了什么、复现了什么、还缺什么」。每个项目按同一模板：**结构 → 核心代码 → 设计决策 → 本仓可借鉴点 → 我的盲区**。

### 5.1 Koishi（koishijs/koishi，6,309★，TypeScript）

- **结构**：`packages/{core,koishi,loader,utils,i18n-utils,koishi}` —— 「核心 + 加载器 + 工具」三层，其余能力全部走独立插件包。
- **核心代码**：`packages/core/src/bot.ts` 仅 **1,803 B**。它把「一个机器人实例」压到最小：连接、生命周期、`sendMessage` 这一个出口；所有渠道差异都在 `Adapter` 里。
- **设计决策**：**用依赖注入替代继承**。渠道不是子类，而是注册到 `ctx` 的服务；因此插件可以按需 `inject`，缺失即降级而不是崩溃。
- **可借鉴**：本仓 `plugin-src/host/index.mjs` 的 14 条 import + 14 条数组项正是「用清单替代 DI」的做法。改成「注册即生效」是从这里学到的第一条（改进 M1）。
- **我的盲区**：`session.ts` 17,254 B 的 Session 抽象我只读了接口层，没读懂它如何把「多机器人并发会话」与中间件链组合；这块对应本仓 `src/channels/shared/conversation/`。

### 5.2 NoneBot2（nonebot/nonebot2，7,777★，Python）

- **结构**：`nonebot/{adapters,drivers,plugin,matcher,message,permission,rule,params}` —— **按「机制」而不是按「渠道」分文件**，渠道是可外部安装的适配器包。
- **核心代码**：`nonebot/plugin/__init__.py` 8,030 B（插件加载/依赖检查/生命周期），`nonebot/message.py` 15,911 B / 578 行是**事件总线**（`event_preprocessor`、`check_and_run_matcher`），不含 `class MessageSegment`；消息段模型在 `nonebot/internal/adapter/message.py` 12,695 B / 434 行（`class MessageSegment` 在第 25 行、`class Message` 在第 101 行）。旧文本把两者混为一处，2026-11-02 第二轮按 `gh api .../contents/<path>` 逐文件复算更正 —— 照旧指针去读会学错一整块。
- **设计决策**：**消息段（MessageSegment）作为跨渠道通用表达**。任何渠道只要能把原生消息映射成消息段数组，就自动获得全部上层能力。
- **可借鉴**：本仓已做了同类的事（统一语义层 `src/channels/shared/semantic/` 里 `artifact.mjs`/`delivery.mjs`/`reply-reference.mjs`），但**没有为「能力」本身建模**：本仓能表达「发一个产物」，却不能表达「这个渠道能不能发语音」。改造 ③ 的能力矩阵是这条差距的最小可行补丁。
- **我的盲区**：`nonebot/dependencies` 的参数解析（依赖注入式 handler 参数）我没细读；本仓对应的是命令处理器参数解析。

### 5.3 LangBot（langbot-app/LangBot，18,658★，Python）

- **结构**：`src/langbot/pkg/{agent,api,box,cloud,command,config,core,discover,entity,i18n,operation_trace,...}` —— 十余个域目录，`ARCHITECTURE.md` 31,138 B（在**仓库根**，不在 docs/ 下；旧写法路径错，2026-11-02 第二轮按 gh api contents 复算更正）。
- **核心代码**：`ARCHITECTURE.md` 是最有价值的一手材料：它把「一个 IM 消息如何变成 agent 轮次」画成流水线，比读代码更快。
- **设计决策**：**域目录 + 架构文档先行**。与 Koishi 的插件化不同，LangBot 选择「单体分层」，用目录边界换可控性。
- **可借鉴**：本仓 `src/channels/shared` 83 个文件平铺，本质是「没有域目录」。M2 的拆分方案直接来自这里。
- **我的盲区**：`pkg/agent` 与 `pkg/core` 的边界（谁持有会话状态）我只看了目录名，没读实现。

### 5.4 chatgpt-on-wechat（zhayujie/chatgpt-on-wechat，47,732★，Python）

- **结构**：面向「个人微信 + 公众号」的单渠道纵深，把消息类型（文本/图片/语音/文件）做成插件通道。
- **设计决策**：**在能力最受限的平台上把能力榨干**（微信个人号只能走 hook/UIA，它把语音、文件、群都做了）。
- **可借鉴**：本仓 weixin 渠道的 UIA 桥（`scripts/wechat_group_uia.py`）走的正是同一条路；不同点是本仓把「找按钮」优化到了 156 ms（`4fe8b1d`），而上游是长驻 hook。这里没有优劣，只有「重启微信 vs 长驻进程」的权衡。
- **我的盲区**：上游如何做「消息去重与回声抑制」；本仓在 `wechat-group-runtime.mjs` 里有一套，但两者没做对照。

### 5.5 matterbridge（42wim/matterbridge，7,609★，Go · 最后推送 2024-12）

- **结构**：`bridge/` 下每个协议一个目录 + `bridge.go` 3,165 B / 135 行的**唯一接口**（`Bridger` 仅 4 个方法）；`gateway/gateway.go` 20,347 B 负责路由与消息翻译。
- **设计决策**：**接口极薄、路由极厚**。所有协议实现 `Bridge` 接口的少数方法，翻译逻辑集中在 gateway —— 新增协议的成本是「实现接口」，不是「改路由」。
- **可借鉴**：本仓相反（接口散、路由散）。如果要做 M1 的注册表，matterbridge 的 `bridge.go` 是最干净的模板参考。
- **我的盲区**：Go 的接口是隐式实现，我没验证它是否有「能力声明」（应该是没有，因为 2024 年后未更新）。

### 5.6 wechaty（wechaty/wechaty，23,461★，TypeScript）

- **结构**：`puppet` 抽象层 + 多 puppet 实现（web/padpad/…），事件驱动（`on('message')`）。
- **设计决策**：**用 puppet 把「协议」与「语义」切开**，协议由 puppet 提供，语义由 wechaty 定。
- **可借鉴**：与本仓 ADR-0001 是同一思路（这是好消息：本仓的架构方向不是孤例）。差别在 wechaty 的 puppet 是**可替换的第三方实现**，本仓渠道是**仓内代码**。
- **我的盲区**：事件去重与重连退避的具体策略，我只看了 README 描述。

### 5.7 matrix-appservice-bridge（matrix-org，187★，TypeScript）

- **结构**：Application Service 模型：一个 bridge 持有多个 `Intent`（虚拟用户），双 puppet。
- **设计决策**：**身份映射显式化**（remote user ↔ matrix user），而不是靠消息内容猜。
- **可借鉴**：本仓 matrix 渠道是单个 bot 身份，没有 puppet 概念；若未来要「一个 DSH 用户对应一个 Matrix 虚拟用户」，这是唯一正确的参考。
- **我的盲区**：`Intent` 的权限模型（哪些事件能用哪个 intent 发）没读完。

### 5.8 共同盲区（本轮未取证，登记为待办）

1. **没有跑过任何上游项目**：本轮对标全部基于源码/文档/GitHub API 阅读，没有 clone 并运行 Koishi / NoneBot2 / LangBot 做过「同一份群消息在多框架下的行为差异」实验。这属于「复现关键功能」未完成的一半。
2. **没有对数吞吐**：上游与本仓都没有统一的 msg/s 口径，量化性能需要自建基准（M3）。
3. **TS/类型系统**：本仓全 JS，我提出的「能力声明」若用类型表达会更稳，但本轮只能落到运行时生成 + 门禁。

### 5.9 学习计划（按优先级）

| # | 目标 | 方式 | 验收 |
| --- | --- | --- | --- |
| 1 | 把 Koishi 的 Adapter 契约读透并写成本仓 `channel-registry` | clone Koishi，读 `packages/core/src` 全部 13 文件，产出对照笔记 | M1 落地后「新增渠道只改 1 处」 |
| 2 | 复现 NoneBot2 的消息段模型到本仓能力声明 | 写一个最小实验：把 `MessageSegment` 的 capability 位映射到本仓 9 列矩阵 | 能力矩阵可表达「入站/出站」双向 |
| 3 | 运行 matterbridge 桥接实验 | docker 起 matterbridge + 两个协议，观察路由 | 产出「接口薄/路由厚」的实测对比 |
| 4 | 补 TS 类型检查（`checkJs`） | `jsconfig.json` + `tsc --checkJs` 渐进 | CI 加入类型门（警告态起步） |
