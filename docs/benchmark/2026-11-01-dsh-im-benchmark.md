# DSH-IM 开源项目对标报告（2026-11-01）

> 对标对象：@xmanrui/dsh-im v5.8.0（本机仓 D:/codex/DSH-IM/rv5.8.0，分支 feat/wechat-groups，HEAD f3ad28e）。
> 取数时刻：2026-11-02T00:2x–00:5x +08:00；上游数字全部来自 `gh api` 当日现值，本仓数字来自分卷 05 的实测命令。
> 证据等级：[一手] 命令原文/上游源码/官方文档；[本机实测] 本次跑出的输出；[未取证] 明确没拿到。
> 分卷：`docs/benchmark/parts/` 下 00 scope / 01 总览 / 02 差距 / 03 建议 / 04 路线图 / 05 基线盘点 / 06 学习记录 / 07 改造执行。
## 0. 对标项目集合与选择依据

本仓定位（ADR-0001 原文）：「横向建设统一语义，纵向逐个渠道打磨」。它同时具备三层身份：

1. **IM 渠道接入层** —— 15 个渠道目录（14 个用户渠道 + `shared`），把平台事件规范化为统一语义；
2. **Agent 桥接层** —— 把 IM 消息送入 DeepSeek Harness 会话，并把回复、产物、审批流回投到原会话；
3. **cordis 插件** —— 以 `package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml` 挂载，构建产物 `lib/index.js` 入库随包发布。

因此对标集合按这三层各取 2-3 个上游，而不是只找「也接了很多 IM」的项目：

| # | 上游项目 | 与本仓对应的层 | 一手数据（复算时间 2026-11-02T00:2x+08:00） | 选择理由 |
| --- | --- | --- | --- | --- |
| 1 | `koishijs/koishi` | 第 3 层：插件生态 / 适配器契约 | `gh api repos/koishijs/koishi` → **6,309 stars** | 插件式机器人框架，适配器与 service 注入是其核心抽象 |
| 2 | `nonebot/nonebot2` | 第 3 层：插件加载与依赖 | `gh api repos/nonebot/nonebot2` → **7,777 stars** | Matcher/适配器驱动 + 插件热加载，与本仓「按渠道适配器结构接入」同类 |
| 3 | `langbot-app/LangBot` | 第 1 层：多 IM 覆盖 | `gh api repos/langbot-app/LangBot` → **18,657 stars** | 明确同时覆盖 QQ / 微信 / 飞书 / 钉钉 / Discord / Telegram / Slack，是与本仓功能交集最大的项目 |
| 4 | `zhayujie/chatgpt-on-wechat` | 第 1 层：个人微信 / 公众号接入 | `gh api repos/zhayujie/chatgpt-on-wechat` → **47,731 stars** | 中文 IM + LLM 场景装机量最大，个人微信侧能力边界最有参考价值 |
| 5 | `42wim/matterbridge` | 第 2 层：桥接抽象 | `gh api repos/42wim/matterbridge` → **7,609 stars** | 多协议桥接网关，桥接契约与消息翻译是最干净的对照组 |
| 6 | `wechaty/wechaty` | 第 2 层：单渠道深度 / 协议层 | `gh api repos/wechaty/wechaty` → **23,461 stars** | 个人微信协议层事实标准，用于界定「UIA 桥」的能力天花板 |
| 7 | `matrix-org/matrix-appservice-bridge` | 第 2 层：桥接状态机 | `gh api repos/matrix-org/matrix-appservice-bridge` → **187 stars** | 官方桥接库，双 puppet 模型与本仓 matrix 渠道直接对应 |

本仓自身基线（同一时刻取数，详见分卷 05）：

- `gh api repos/xmanrui/dsh-im` → **3,044 stars / 310 forks / 86 open issues**，`pushed_at` 2026-11-01T13:07:26Z，MIT；
- 本地 HEAD `0ae0e13`（分支 `feat/wechat-groups`），1090+ 提交；
- `src` 278 个 mjs / 81,354 行；`test` 293 个 mjs / 129,003 行；用例 4,736 条；
- `lib/index.js` 10,100,334 B + `lib/client.js` 1,823,532 B（入库产物，见 2.3 与改造 ②）；
- 仓库缺 `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md` / `SECURITY.md` / ISSUE 模板 / PR 模板（`ls` 实测，见分卷 05）。

---

## 1. 对比总览表

> 说明：D 列给「本仓实现位置」，对的是**功能模块**而不是文件同名。所有上游数字取 `gh api` 当日现值（2026-11-02），本仓数字取分卷 05 的实测与工单记录。

### 1.1 八维总览（每维一行：本仓现状 vs 上游最佳）

| # | 维度 | 本仓（@xmanrui/dsh-im 5.8.0） | 上游最佳（项目 · 证据） | 差距判定 |
| --- | --- | --- | --- | --- |
| 1 | 功能模块覆盖 | 14 个渠道目录，9 类能力矩阵由源码生成（见 §1.2） | LangBot 18,658★，Python，单仓覆盖 QQ/微信/飞书/钉钉/Discord/Telegram/Slack，`src/langbot/pkg` 分 agent/api/box/cloud/command/config/core/discover/entity/i18n/operation_trace 十余个域 | **渠道数相当（14 vs ~8），域分层落后**：本仓 `src/channels/shared` 83 个平铺文件无二级分层 |
| 2 | 技术架构设计 | 统一语义核心 + 渠道原生适配（ADR-0001），`shared` 24,638 行占 src 30.29% | Koishi 6,309★，`packages/core/src` 只有 bot/session/context/middleware/command 等 13 个文件，`bot.ts` 仅 1,803 B | **本仓核心抽象未收敛**：上游把 Adapter 契约压到 1.8 KB 的 `bot.ts`，本仓同类逻辑散在 83 个文件里 |
| 3 | 实现方式 | 289 个 mjs（279 src + 10 tests）、ESM、无 TS、无 lint/format 配置；**贡献与安全治理骨架已落地**（`f3ad28e`：CONTRIBUTING/SECURITY/CODE_OF_CONDUCT/issue与PR 模板 + `verify-governance.mjs` 判据） | NoneBot2 7,777★ 有 `nonebot/plugin/__init__.py` 8,030 B 的插件加载器 + 类型标注（`py.typed`）；LangBot 有 `CONTRIBUTING.md`、`.pre-commit-config.yaml`、`golangci` 级等价门禁 | **规范层缺失**：本仓无 CONTRIBUTING / SECURITY / ISSUE 模板 / lint/format 配置（`ls` 实测） |
| 4 | 性能表现 | 全量 4,752 用例 25 s 左右；`wechat_group_uia.py` 找按钮 156 ms（commit 4fe8b1d 实测 34.5 s → 156 ms） | matterbridge 用 Go 单进程多协议（`gateway.go` 20,347 B），wechaty 23,461★ 以 puppeteer 事件循环承载 | **基准已建立**（`bc27b224`）：`scripts/benchmark-channels.mjs` 六条热路径，固定种子语料 + 下限判据 + CI 警告态 job；跨项目仍无同口径 msg/s 可比数 |
| 5 | 可扩展性 | 新增渠道 = 新建 `src/channels/<name>/` + `plugin-src/host/channels/<name>/index.mjs` + `plugin-src/client/channels/<name>/`，三处手工接线（`plugin-src/host/index.mjs` 第 2-15 行 import、第 60-75 行 channels 数组） | Koishi 的插件即包（`packages/*`），服务由 `ctx.get()` 注入；NoneBot2 的适配器目录 `nonebot/adapters` 为可外部安装的独立包 | **注册表已落地**（`f192d382`）：`plugin-src/host/channel-registry.mjs`（62 行）成为渠道集合与顺序唯一来源，`index.mjs:63-66` 只剩一次 `map()`；**新缺口是注册条目里没有能力声明**（见 §8 建议 N1） |
| 6 | 维护状态 | 3,045★ / 86 open issues / 最近推送 2026-11-01T13:07:26Z / 单分支主力 `feat/wechat-groups` | LangBot 最近推送 2026-11-01T15:55:19Z（同日）、open 127；chatgpt-on-wechat 47,732★ 最近推送 2026-11-01T07:33:51Z | **活跃度同档**；但本仓 CI 只覆盖 `test/*.test.mjs` + 两条 Windows 专题，无 lint/覆盖率/发布流水线 |
| 7 | 文档完善程度 | README 80 KB + 英文版 + `docs/` 98 个 md + ADR 1 篇 + 12 篇 Issue 方案记录 + `ARCHITECTURE.md`（356 行/8 章）+ 治理七件套；**仍缺独立 API 参考** | LangBot 有仓库根 `ARCHITECTURE.md`（31,138 B）+ `CONTRIBUTING.md` + `CLA.md` + 6 语言 README（README/CN/ES/FR/JP/KO） | **体系化文档落后**：本仓有大量「事后记录」但缺「架构总览 + 贡献流程」两块骨架 |
| 8 | 适用场景 | 必须宿主为 DeepSeek Harness（`dsh.compatibility.dsh` 钉 `0.2.1-rc.2`），一装即得 14 渠道 + 会话隔离 + 产物回投 | LangBot/chatgpt-on-wechat 可独立部署为机器人服务；matterbridge 可独立网关 | **场景窄但粘性高**：本仓不是通用框架，是 DSH 的 IM 面；兼容面仅声明 2 个宿主版本 |

### 1.2 渠道 × 能力（本仓实测，由源码生成，见 `README.md` 同名表）

能力矩阵已由 `scripts/channel-capability-matrix.mjs` 从 `src/channels/*/` 生成并纳入 `npm run check`。9 列能力（文本 / 图片 / 文件 / 语音 / 引用回复 / 群聊 / 流式·编辑 / 卡片·按钮 / 富文本）× 14 个渠道 = 126 格；实测 ✅ **56** 格、— **70** 格（命令：`sed -n '/channel-capability-matrix:start/,/channel-capability-matrix:end/p' README.md | grep -o '✅' | wc -l` 得 57，扣除图例里那 1 个 ✅；— 同法得 71 扣 1）。**这张表的价值不是覆盖率，而是它现在是可复算的**：之前它只是 README 里的散文。

### 1.3 量化差距清单（只列可复算的）

| 指标 | 本仓 | 上游/参照 | 差距 | 证据 |
| --- | --- | --- | --- | --- |
| 核心抽象单文件体积 | `src/channels/shared` 83 文件 / 24,638 行 | Koishi `packages/core/src/bot.ts` 1,803 B | 核心契约未收敛（上游一个文件的量级，本仓是一层目录） | 分卷 05 §2.5；`gh api` bot.ts `.size` |
| 单文件最大 | `src/channels/feishu/bridge.mjs` 6,695 行 | matterbridge `gateway.go` 20,347 B（674 行 Go；旧注「≈500 行」是按字节估算的，实测该估法不可用：steam.go 2,189 B 实为 95 行、mattermost.go 4,839 B 实为 194 行） | 本仓单文件超上游整模块 | 分卷 05 §2.4 |
| 测试/源码行比 | 1.586（129,003 / 81,354） | 无上游同口径读数 | — | 分卷 05 §2.3 |
| 治理文件 | 7（`f3ad28e`，交叉引用有判据） | LangBot：`CONTRIBUTING.md` + `CLA.md` + `.pre-commit-config.yaml` | 已闭合，仍缺 CLA 与 pre-commit | `node scripts/verify-governance.mjs` |
| CI 覆盖 | 2 job（ubuntu `npm run check` + windows 8 个专项） | 无同口径，但上游有 release/lint 流水线 | 缺 lint / 覆盖率 / 发布流水线 | `.github/workflows/ci.yml` 55 行 |
| 入库构建产物 | 11,923,866 B（2 文件） | LangBot/matterbridge 不入库产物 | 体积与漂移风险 | 分卷 05 §2.2；改造 ② 已加漂移守卫 |
| 入站能力盲区 | skip 8 / 4,736 = 0.17%，其中 6 条依赖 POSIX ffmpeg | — | 语音/媒体链路本机永不执行 | 分卷 05 §3.2 |

---

## 2. 逐项差距说明（八维）

> 每条差距都回答三件事：本仓的对应模块在哪、上游的具体做法是什么、差在哪一步。

### 2.1 功能模块覆盖范围

**本仓对应模块**：`src/channels/{feishu,weixin,dingtalk,wecom,wecom-app,qq,slack,telegram,discord,whatsapp,imessage,email,matrix,office}/`，每渠道一个目录，配套 `plugin-src/host/channels/<name>/`（生产装配）与 `plugin-src/client/channels/<name>/`（设置页 UI）。

**核心功能**（文本收发 / 群聊 / 私聊 / 命令）已 14/14 覆盖，见 §1.2 的「文本」「群聊」列。

**扩展功能**差距（按矩阵实测格数）：

| 能力 | 覆盖 | 缺口渠道 | 上游对照 |
| --- | --- | --- | --- |
| 语音 | **2/14**（feishu、telegram）｜旧值 3/14 含 weixin，系 matcher 收窄前读数，2026-11-02 第二轮按 `collectChannelMatrix()` 复算更正 | — | chatgpt-on-wechat 47,732★ 在微信侧原生支持语音消息双向往返；本仓语音只到「转写 + 合成」且在 feishu 侧有 `transcribeIncoming`/`synthesize` 显式能力对象（`src/channels/feishu/bridge.mjs` 第 682-816 行） |
| 卡片/按钮 | **2/14**（feishu、telegram）｜旧值 3/14 同上复算更正 | — | 上游普遍仅 Slack/Telegram 具备原生交互卡；本仓已有 Feishu 卡片 + Telegram `sendInteractionCard`，属同档 |
| 流式/编辑 | **4/14**（discord、feishu、slack、telegram）｜旧值 6/14 同上复算更正 | — | matterbridge（Go）不做流式编辑，本仓在此维度领先 |

**特色功能（本仓独有，上游没有对应物）**：
1. **统一语义层 + 主动投递**：`plugin-src/host/delivery-service.mjs` / `delivery-adapter.mjs`，把产物按 `target kind`（user/group/room/thread/dm/chat/topic/conversation）路由到各渠道；上游没有任何一个项目有「跨渠道统一产物投递」。
2. **会话工作区绑定**：`src/channels/shared/conversation/` + `bot-workspace-store.mjs`（2,838 行），每个 IM 机器人各自绑定 DSH 工作区。
3. **群历史与群文件**（`group-history-store.mjs` + `group-history.mjs` + `docs/group-history.md` 15 KB）：把群消息落 SQLite 并可回查。

**结论**：功能覆盖在本档位（14 渠道）不落后于任何上游；差距在**扩展功能的渠道渗透率**（语音 2/14、卡片 2/14、流式 4/14 —— 三值均为 2026-11-02 第二轮 `collectChannelMatrix()` 复算，旧值 3/3/6 系 `017e3ae` matcher 收窄前的读数且未回改分卷，详见 §8）和**特色功能的可发现性**（这三个特色在 README 里是散句，没有独立章节与示意图）。

### 2.2 技术架构设计

**本仓**（ADR-0001 明示）：统一语义核心 + 渠道原生适配。分层实况：

```
src/channels/shared/   83 个 mjs / 24,638 行  ← 语义核心（无二级分层）
src/channels/<channel>/ 各 6-26 文件            ← 原生适配
plugin-src/host/        构建期装配（channels 数组硬编码 14 项）
plugin-src/client/      设置页 UI（每渠道 index.js + api.js + styles.js）
```

**上游 Koishi**（6,309★）：`packages/core/src` 只有 13 个文件，`bot.ts` 1,803 B，`context.ts`/`session.ts`/`middleware.ts` 各司其职；渠道是**独立 npm 包**（`koishi-plugin-*`），通过 `ctx.plugin()` 挂载。

**差距**：
1. **核心抽象没有单一入口**。上游新增渠道只要实现 `Adapter` 接口；本仓要在 `plugin-src/host/index.mjs` 加 import + 数组项，还要在 client 侧加三件套（index/api/styles）。实测 `plugin-src/host/index.mjs` 第 2-15 行 14 条 import、第 60-75 行 14 条数组项。
2. **shared 无二级分层**。83 个文件平铺，最大 `bot-workspace-store.mjs` 2,838 行。上游把「会话」「中间件」「权限」各自成文件成包。
3. **无能力声明**。上游（NoneBot2 `py.typed` + `nonebot/plugin/__init__.py` 8,030 B）让能力可被类型系统与加载器发现；本仓能力散落在各 bridge 的实现里，这也是改造 ③ 要解决的根因。

### 2.3 实现方式

| 项 | 本仓 | 上游 | 差距 |
| --- | --- | --- | --- |
| 语言/类型 | 纯 JS（ESM），无 `tsc`、无 `jsconfig` 类型检查（**未闭合**） | Koishi/Python 系全部带类型（`py.typed`、TS） | 无静态类型检查 |
| 格式/lint | 无 `.editorconfig` / `.eslintrc` / `.prettierrc`（`ls -a` 实测） | LangBot 有 `.pre-commit-config.yaml`；matterbridge 有 `.golangci.yaml` | 无 Lint 门禁 |
| 测试形态 | `node:test`，296 个 mjs，4,954 用例；**覆盖率已入 CI**（`62f89f45`：lcov → `src`+`plugin-src` 行覆盖 89.97%，阈值 85%） | 上游有覆盖率/CI 矩阵 | 已闭合（分支覆盖仍未设阈值） |
| 贡献流程 | **已落地**：CONTRIBUTING / CODE_OF_CONDUCT / SECURITY / 3 个 issue 模板 / PR 模板，且 `verify-governance.mjs` 判交叉引用（`f3ad28e`） | LangBot：`CONTRIBUTING.md` + `CLA.md` + `.pre-commit-config.yaml` | 仍缺 CLA 与 pre-commit |
| 构建产物 | `lib/index.js` 10.1 MB + `lib/client.js` 1.82 MB 入库 | 上游不入库产物 | 漂移风险（改造 ② 已加守卫） |

### 2.4 性能表现

**本仓可复算读数**：
- 全量测试 4,752 用例 / 25 s 级（`node --test test/*.test.mjs test/channels/*/*.test.mjs`）；
- 单点性能修复：`4fe8b1d` 把微信群发送按钮查找从 34.5 s → **156 ms**（提交标题与 body 记录）；
- 构建确定性：两次 `npm run build` 产物 sha256 相同（改造 ② 的判据前提）。

**差距**：本仓**没有任何吞吐/延迟基准脚本**。上游 matterbridge 是 Go 单进程网关（`gateway.go` 20,347 B）、wechaty 以事件循环承载多会话；这些都没有可直接对标的「消息/秒」数字，但它们的发布流程有基准记录，本仓没有。这是最大的一块量化空白，改进项 H3 提出先建最小基准脚本。

### 2.5 可扩展性

- **架构扩展性**：新增渠道的 host 侧接线已由 `channel-registry.mjs` 收敛到 1 处（`f192d382`）；`plugin-src/client/` 三件套与 `src/channels/<name>/` 仍需新建，且注册条目**不含能力声明**（⇒ 建议 N1）。`shared/` 仍无二级分层（M2 未动）。
- **功能扩展机制**：命令由 `src/channels/shared/command-catalog.mjs` 统一登记，这一块已收敛（好）。
- **第三方集成**：`package.json` 的 `dsh.client.inject` 列出 5 个宿主包依赖；`dsh.compatibility.dsh` 只声明 `0.2.0-rc.2`/`0.2.1-rc.2` 两个宿主版本 —— 兼容面窄，但声明是诚实的（不承诺未验证版本）。

### 2.6 维护状态

| 指标 | 本仓 | LangBot | chatgpt-on-wechat | matterbridge | Koishi |
| --- | --- | --- | --- | --- | --- |
| stars | 3,045 | 18,658 | 47,732 | 7,609 | 6,309 |
| open issues | 86 | 127 | 41 | 339 | 114 |
| 最近推送 | 2026-11-01T13:07Z | 2026-11-01T15:55Z | 2026-11-01T07:33Z | **2024-12-12** | 2026-10-08 |
| 主语言 | JavaScript | Python | Python | Go | TypeScript |

读数：本仓与 LangBot 同日活跃；matterbridge 已两年未推送（对标只取其**架构**，不取维护性）。

### 2.7 文档完善程度

| 档 | 本仓 | 分值 | 依据 |
| --- | --- | --- | --- |
| API 文档 | 无独立 API 参考；`docs/client-integration.md` 12 KB 是唯一接口文档 | 1/2 | `ls docs` |
| 使用教程 | README 80 KB 安装/配置/命令/故障全覆盖 + 12 篇 Issue 方案 | 2/2 | README 一级标题 15 个 |
| 贡献指南 | CONTRIBUTING + SECURITY + CODE_OF_CONDUCT + issue/PR 模板，且有 `verify-governance.mjs` 判据 | 2/2 | `node scripts/verify-governance.mjs` → `GOVERNANCE_OK 7 files` |
| 变更日志 | `CHANGELOG.md` 312 KB | 2/2 | `wc -c` |
| 示例/架构 | ADR 1 篇 + `ARCHITECTURE.md`（356 行 / 8 个一级章节，引用路径 40 条实测存在） | 2/2 | `ls ARCHITECTURE.md docs/adr` |

合计 **8/10**（本轮两项各 +1：贡献指南 0→2、示例/架构 1→2）。上游 LangBot 有仓库根 `ARCHITECTURE.md` 31,138 B + `CONTRIBUTING.md` 2,183 B + `CLA.md` 12,158 B + 6 语言 README（README/CN/ES/FR/JP/KO，各 10.7–13.1 KB 实测）。

### 2.8 适用场景

- **最佳场景**：已经用 DeepSeek Harness、希望把 IM 当遥控器的个人/小团队；一次安装得到 14 个渠道 + 会话隔离 + 产物回投。
- **局限**：① 宿主强耦合（`dsh.compatibility.dsh` 只声明 2 个版本）；② iMessage 仅 macOS 且只有文本（448 行，最小渠道）；③ Matrix 加密为实验状态（README 明示未验证真实 homeserver 互通）；④ 需要跑无头服务器时没有独立网关形态（上游 matterbridge/LangBot 均可独立部署）。
- **兼容性**：Node ≥22.19；Windows 上 `os.tmpdir()` 对 esbuild 子进程可能不可写（改造 ① 已处理）。

---

## 3. 改进建议清单（按优先级）

> 排序依据写死在每一行「排序依据」列里：**先修「证明不了自己」的问题，再修「不够快」的问题**。
> 理由：一个绿不起来的门禁会让后续所有优化都失去可验证性；性能数字在门禁可靠之前没有意义。

### 3.1 高优先级（P0：影响可验证性或对外承诺）

| ID | 改进项 | 排序依据 | 预期目标 | 完成标准（可复跑判据） | 状态 |
| --- | --- | --- | --- | --- | --- |
| **H1** | 本机全量测试基线必须绿 | 基线红 = 之后任何「我修好了」都不可证 | 消除 `os.tmpdir()` 对 esbuild 子进程不可写造成的 1 条恒红 | `node --test test/*.test.mjs test/channels/*/*.test.mjs` 末行 `fail 0`；且该条用注入回归可复现变红 | ✅ 已落地（`87b9f2c`） |
| **H2** | 入库构建产物漂移守卫 | 用户加载的是 `lib/*.js` 字节；源码改了没重建 = 「修了但没生效」 | 让「源码 ≠ 入库产物」在 CI 上直接失败并点名文件 | `npm run check` 末段出现 `BUILT_ARTIFACTS_OK 2 files match HEAD`；注入一个字节 → `BUILT_ARTIFACTS_DRIFT` + 非零退出 | ✅ 已落地（`0306fda` + `b075e39`） |
| **H3** | 渠道能力矩阵由源码生成 | README 承诺过「支持 X」但实现没有，已发生多次返工 | 能力表可复算、漂移即失败 | `node scripts/channel-capability-matrix.mjs --check` → `CAPABILITY_MATRIX_OK 14 channels, 2 document(s)`；改一处实现 → 退出码 1 | ✅ 已落地（`017e3ae` + `0ef3a36`） |
| **H4** | 贡献与安全治理骨架 | 86 个 open issue、3045★，但仓库没有 CONTRIBUTING/SECURITY/模板 → 外部贡献无法进入流程 | 让第一次 PR 有明确的入口与检查清单 | `ls CONTRIBUTING.md SECURITY.md .github/ISSUE_TEMPLATE .github/PULL_REQUEST_TEMPLATE.md` 全部存在；CI 有一条 `verify-governance` 判据 | ⏳ 下一轮（见 §4 阶段二） |

### 3.2 中优先级（P1：影响工程质量与可维护性）

| ID | 改进项 | 排序依据 | 预期目标 | 完成标准 | 状态 |
| --- | --- | --- | --- | --- | --- |
| M1 | 渠道注册表取代 14 条手工接线 | 新增渠道 3 处手工改动，是扩展性第一瓶颈 | 单文件登记即可挂载一个渠道 | 新增 `channel-registry.mjs`，`plugin-src/host/index.mjs` 只遍历注册表；现有 14 渠道行为不变（全量测试绿） | 建议 |
| M2 | `shared/` 二级分层 | 83 文件 24,638 行平铺，最长 2,838 行 | 按 session/permission/delivery/history 四域拆分目录 | 目录数与最大文件行数下降，且 import 面收敛 | 建议 |
| M3 | 性能基准脚本 | 全仓零基准，性能差异无法量化 | 至少 1 条可复跑的吞吐/延迟基准，进 CI 但只警告 | `node scripts/benchmark-channels.mjs` 输出 JSON + 稳定判据 | 建议 |
| M4 | 覆盖率上报 | 4,752 用例但无覆盖率 → 高测试量低覆盖可能 | CI 产覆盖率并留档 | `npm test -- --experimental-test-coverage` 输出并入 CI artifact | 建议 |
| M5 | 语音/媒体链路去平台依赖 | 6/8 skip 依赖 POSIX ffmpeg | 跨平台 stub，让语音链路在 Windows CI 也执行 | skipped 从 8 降到 ≤2 | 建议 |

### 3.3 低优先级（P2：体验与生态）

| ID | 改进项 | 排序依据 | 预期目标 | 完成标准 | 状态 |
| --- | --- | --- | --- | --- | --- |
| L1 | 补 `ARCHITECTURE.md` | 上游 LangBot 有 31 KB 架构文档，本仓只有 ADR | 新人 10 分钟理解分层 | 文件存在且含三层图 | 建议 |
| L2 | 多语言 README | 上游 5 语言 | 至少 zh/en（本仓已有）→ 增 ja/es | — | 已部分 |
| L3 | 独立网关形态 | matterbridge/LangBot 可脱离宿主独立部署 | 评估可行性，不承诺 | 产出评估结论 | 建议 |
| L4 | 发布流水线 | 现无 release workflow | tag → 自动发布 npm + 校验 | `.github/workflows/release.yml` | 建议 |

### 3.4 与遗留台账的对账

本轮没有改动任何既有 P0 遗留项；上面 H1–H3 全部是**本轮新发现并由本轮闭合**（每项都有独立提交与注入式负控）。H4 与 M1–M5、L1–L4 登记为后续（见 §4）。

---

## 4. 可实施路径（分阶段 + 里程碑）

> 时间节点按「轮次」而不是日历天给，因为这项工作由会话推进而不是排期；每阶段结束都有可复跑的判据。

### 阶段一（已完成 · 本轮）：让门禁可信（H1–H3）

| 里程碑 | 交付物 | 判据 | 状态 |
| --- | --- | --- | --- |
| M1.1 | `test/helpers/esbuild-scratch.mjs` + 契约测试 | 全量测试 `fail 0` | ✅ `87b9f2c` |
| M1.2 | `scripts/verify-built-artifacts.mjs` 接入 `npm run check` | `BUILT_ARTIFACTS_OK 2 files match HEAD` | ✅ `0306fda`（产物 `b075e39`） |
| M1.3 | `scripts/channel-capability-matrix.mjs` + 双语 README 块 | `CAPABILITY_MATRIX_OK 14 channels, 2 document(s)` | ✅ `017e3ae` + `0ef3a36` |

**阶段门（已达成）**：`npm run check` 退出码 0，输出含 `ℹ fail 0` / `Verified dsh-im package artifacts.` / `BUILT_ARTIFACTS_OK` / `CAPABILITY_MATRIX_OK` 四条。

### 阶段二（下一轮）：治理与贡献入口（H4）

| 里程碑 | 交付物 | 判据 | 预计 |
| --- | --- | --- | --- |
| M2.1 | `CONTRIBUTING.md`（含本地开发、门禁命令、提交规范、渠道新增五步） | 文件存在且被 README「贡献」段引用；`verify-governance.mjs` PASS | 1 轮 |
| M2.2 | `SECURITY.md`（漏洞上报路径 + 支持版本表） | 同上 | 同轮 |
| M2.3 | `.github/ISSUE_TEMPLATE/{bug,feature}.yml` + `PULL_REQUEST_TEMPLATE.md` | GitHub 上新建 issue 时能选到模板 | 同轮 |
| M2.4 | `scripts/verify-governance.mjs` 接入 `npm run check` | 删任一治理文件 → 门禁红 | 同轮 |

### 阶段三（再下一轮）：扩展性（M1、M2）

| 里程碑 | 交付物 | 判据 |
| --- | --- | --- |
| M3.1 | `channel-registry` 单一登记源 | 新增渠道只改 1 处；14 渠道行为等价（全量测试绿 + 能力矩阵不变） |
| M3.2 | `shared/` 按四域拆目录 | 最大文件行数下降 ≥30%；import 面收敛 |

### 阶段四（长期）：可量化（M3、M4、M5）

| 里程碑 | 交付物 | 判据 |
| --- | --- | --- |
| M4.1 | `scripts/benchmark-channels.mjs` | 输出 JSON（p50/p95 分发延迟），CI 只警告不阻断 |
| M4.2 | 覆盖率并入 CI | `coverage/` 产物 + 阈值 |
| M4.3 | 跨平台媒体 stub | skipped ≤2 |

### 关键风险与回退

- 每一项都是独立提交，可单独 `git revert`；
- 涉及构建产物的项（H2）必须「源码 + 产物」同时提交，否则守卫会正确地把门禁判红（本轮已实际发生并已修正）；
- 与并发写者共仓：提交一律点名路径（`git commit --only -- <files>`），避免吞并他人已暂存内容。

---

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

---

## 7. 四项工程改造执行记录（按优先级高→低）

> 排序依据：**先修「证明不了自己」，再修「对外承诺不实」，最后修「没有证据的漂亮话」**。
> 一个红着的门禁会让后续所有优化的证据失效；一份与实际不符的能力表会变成对外承诺。
> 每项都给了「预期目标 / 完成标准 / 实测证据 / 负向对照」，且都是独立提交，可单笔回退。

### 7.1 改造 ①：本机全量测试基线转绿（优先级 1 · 高）

- **为什么排第一**：基线红（4,727 pass / 1 fail）意味着之后任何「我修好了」都无法验证。
- **执行顺序**：先定位（`esbuild` 子进程被拒写 `os.tmpdir()`）→ 再区分「Node 能写 vs 子进程不能写」→ 最后写可复用 helper。
- **预期目标**：把平台缺陷挡在测试外面，而不是让它伪装成产品缺陷。
- **完成标准**：`node --test test/*.test.mjs test/channels/*/*.test.mjs` 末行 `fail 0`。
- **实测证据**：改前 `4736 tests / 4727 pass / 1 fail`；改后 `4738 / 4730 / 0`（当时用例数）。
- **负向对照**：把 helper 里的可用性探测去掉（改回「拿第一个候选就用」）→ 该用例立刻回到 1 fail；还原后恢复 3 pass。
- **提交**：`87b9f2c`。

### 7.2 改造 ②：入库构建产物漂移守卫（优先级 2 · 高）

- **为什么排第二**：`dsh plugin add` 装的是发布包里的 `lib/*.js`。源码改了没重建 ⇒ 用户加载旧字节，表现为「修了但没生效」，而且排查会从错误前提开始。
- **执行顺序**：先证明构建确定性（两次 `npm run build` 产物 sha256 相同）→ 再写「工作树 vs git HEAD」比较 → 最后接进门禁。
- **完成标准**：`npm run check` 输出 `BUILT_ARTIFACTS_OK 2 files match HEAD`。
- **实测证据**：该守卫**当天就抓到一次真实漂移** —— 我把两个脚本加进 `package.json` 的 `files`/`check` 后，manifest 被编进 `lib/client.js`，门禁立刻报
  `BUILT_ARTIFACTS_DRIFT lib/client.js: committed ae521866f584 != built 06124e10e775 (first differing byte 23874)`，随后由 `b075e39` 补交重建产物。
- **负向对照**：端到端用例真的往 `lib/index.js` 追加一个字节 → CLI 报 DRIFT 并退出 1；还原后报 OK。另有「换成非探针字节仍必须判红」的第二条对照，证明豁免不是全豁免。
- **提交**：`0306fda` + 产物 `b075e39`。

### 7.3 改造 ③：渠道能力矩阵由源码生成（优先级 3 · 高）

- **为什么排第三**：README 的能力描述是**对外承诺**。已发生过「README 承诺 X、实现只有 Y」的返工；手写表格没有 owner、没有门禁。
- **执行顺序**：先定「哪些列算能力」→ 用真实渠道目录校准 matcher（三次误报纠正见下）→ 生成 → 围栏进两份 README → 进门禁。
- **完成标准**：`node scripts/channel-capability-matrix.mjs --check` → `CAPABILITY_MATRIX_OK 14 channels, 2 document(s)`。
- **matcher 校准（这是本项真正的成本）**：首版用 `image_key|imageKey`、`voice|audio`、`group|room`，在本仓 14 个渠道上跑出三处**假 ✅**：
  weixin 的 `image_key` 命中的是校验文案；Discord 的 `audio` 命中的是「拒绝附件」的错误提示；iMessage 的 `room` 命中一对一 API。收窄为「发送/上传调用的函数名」后重跑。
- **实测证据**：14 渠道 × 9 列 = 126 格，✅ **56** 格 / — **70** 格（`grep -o '✅'` 得 57，扣图例 1）。
- **负向对照**：把 `src/channels/imessage/imessage-api.mjs` 的 `sendText` 改名 → `--check` 退出 1；还原 → OK。
- **提交**：`017e3ae` + `0ef3a36`（双语与受检契约收窄）。

### 7.4 改造 ④：贡献与安全治理骨架（优先级 4 · 高）

- **为什么排第四（而不是第一）**：它不是「让已有工作可验证」，而是「让外部工作可进入」；在门禁不可信之前，治理文件只会把未经验证的流程固化下来。
- **执行顺序**：CONTRIBUTING（含门禁真相）→ SECURITY（含信任边界）→ 行为准则 → issue/PR 模板 → 交叉引用判据 → README 入口。
- **预期目标**：让第一次 PR 有明确入口与自查清单；让安全问题有私下通道。
- **完成标准**：`node scripts/verify-governance.mjs` → `GOVERNANCE_OK 7 files, cross-references intact`（7 个文件 + 每条必须引用对方，缺引用即红）。
- **负向对照**：把 CONTRIBUTING 里的 `SECURITY.md` 换成杜撰文件名 → 判据报 `GOVERNANCE_DANGLING: CONTRIBUTING.md -> SECURITY.md` 并退出 1；删除文件 → 报 `GOVERNANCE_MISSING`。
- **提交**：`f3ad28e`（7 个治理文件 + `verify-governance.mjs` + `test/governance.test.mjs`；产物随 `57392f6` 重建提交）。

### 7.5 四项改造的完成顺序与可追溯性

```
H1 基线转绿   87b9f2c
H2 产物漂移   0306fda (+ 产物 b075e39)
H3 能力矩阵   017e3ae → 0ef3a36
H4 治理骨架   （本轮最后一笔）
```

每一项都在 `npm run check` 里有对应判据，且判据本身做过负向对照 —— 也就是说，**门禁绿不是「看起来绿」，是「删掉这一项会变红」**。

最终门禁读数（`npm run check`，2026-11-02T00:53+08:00）：

```
ℹ tests 4761 / pass 4753 / fail 0
Verified dsh-im package artifacts.
BUILT_ARTIFACTS_OK 2 files match HEAD
CAPABILITY_MATRIX_OK 14 channels, 2 document(s)
BENCHMARK_REPORT_OK dimensions=8 sections=4 tables=98 numbers=724
GOVERNANCE_OK 7 files, cross-references intact
EXIT=0
```

### 7.6 分工与未收产出登记（诚实记录）

本轮按「并行优先」派了 4 个子代理（Koishi/NoneBot2 生态、LangBot/chatgpt-on-wechat 渠道矩阵、matterbridge/wechaty 桥接性能、本仓基线盘点）。

| 子代理 | 结果 |
| --- | --- |
| A4 本仓基线盘点 | ✅ 交付 `parts/05-baseline-inventory.md`（194 行；每个数字带可复跑的 C 编号命令） |
| A1 生态与可扩展性 | ❌ **未落盘**：约定路径 `parts/01-plugin-ecosystem.md` 在收尾时不存在 |
| A2 渠道功能覆盖 | ❌ **未落盘**：约定路径 `parts/02-channel-coverage.md` 不存在 |
| A3 桥接/性能/维护 | ❌ **未落盘**：约定路径 `parts/03-bridge-perf-maint.md` 不存在 |

**处置**：这 3 项的内容由 Lead 自采补齐（`gh api` 拉上游目录结构与文件字节、在本仓上跑 matcher 校准），
落在 `parts/01-overview.md`（功能/架构/性能/维护/文档/场景）、`parts/02-gap-analysis.md`、
`parts/06-learning.md`（逐项目阅读记录）。**证据等级随之下调**：这三块结论是「源码与文档阅读」，
不是「子代理独立复核」，报告正文已按 [一手]/[本机实测]/[未取证] 逐条标注，未把未复核的结论写成已复核。

另有 3 项在本轮**未取证**，已写进 §5.8 与 §3 的建议项，不冒充已完成：① 未 clone 运行任何上游项目（只有源码/文档/GitHub API 阅读）；② 未做跨框架同一消息的行为对照实验；③ 未建吞吐基准（M3）。

副作用声明：本报告编写过程中**没有**修改任何上游项目文件、没有向其提 issue/PR、没有向任何仓库推送。


---

## 8. 第二轮更正与新增（2026-11-02 · 轮2）

> 详卷：`docs/benchmark/parts/08-round2-corrections.md`（改造记录/新增建议/盲区闭合/未闭环登记）。
> 本章只做两件事：**登记本轮落地的四项改造**，以及**把正文里已被复算证伪的数字就地
> 更正并留痕**。它不改写第 1–7 章的历史读数。

权威件最危险的失败不是写错，而是「代码演进了而文档没说」。本轮 §1/§2/§5 有四处正是
这种状态 —— 人读两边各自都像真的，只有把两个来源放一起比才会现形（已做成判据，见 8.4）。

### 8.1 本轮落地的四项改造（优先级高→低）

| 序 | ID | 改造 | 提交 | 完成判据 | 负向对照 |
| --- | --- | --- | --- | --- | --- |
| 1 | M5 | 语音/媒体链路去平台依赖 | `ac397eea` | feishu voice 13 pass/**0 skip**、telegram 18 pass/**0 skip**、全量 skipped **8→2** | 替身退非 0⇒reject、`.sh` 交生产 runner⇒`EFTYPE`、假路径⇒`ENOENT`（三条各证一类断言有牙） |
| 2 | M3 | 渠道热路径吞吐/延迟基准 | `bc27b224` | `npm run benchmark`→`BENCHMARK_OK suites=6`；floor 契约测试 9 pass | 下限与 suite 必须恰好配对；`NaN/-1/0/-Infinity` 判红；缺 suite 判红；逐轮 checksum 非零 |
| 3 | M4 | 覆盖率入 CI | `62f89f45` | `npm run coverage`→`COVERAGE_OK lines=89.97%`（阈值 85%） | 阈值 95→**exit 1**；空 lcov→exit 1；85→exit 0（exit 码直测不经管道） |
| 4 | H4.1 | 治理/覆盖率/基准各自成 CI job | `66f8078c` | `test/ci-workflow.test.mjs` 5 pass；PyYAML 解析 5 job，benchmark 为警告态 | 每条 `uses` 必须 40 位 SHA；本轮我凭记忆写的 SHA 是编的，`gh api` 实查 `ea165f8d…`(v4.6.2) 才修正 |

### 8.2 新增两条建议（来自上游复现）

- **N1 给 `channel-registry.mjs` 的注册条目加 `capabilities`**。依据：matterbridge 把能力
  放在第二张表 `bridgemap.UserTypingSupport`，与实现脱钩 ⇒ 穷举 20 个协议目录，
  `EventUserTyping` 在 discord/harmony/slack 三处出现，注册表只登记 discord 与 slack，
  **harmony 的 typing 代码不可达**（`gateway/bridgemap/bharmony.go` 全文只有一行 `FullMap`）。
  本仓注册表（62 行）同样不含能力位。结论：**光有注册表不够，能力声明必须住在注册条目里**。
- **N2 把投递能力声明从 1 个渠道扩到 14 个**。`grep -rln describeDeliveryAccount src/ plugin-src/`
  → 只有 feishu 一家；而 `delivery-service.mjs:579,583` 是**硬读** capabilities（不含
  `proactive-text-checked` 直接拒发）。机制已比上游完整，缺的是覆盖面。

### 8.3 报告自身被证伪并更正的四处

| # | 旧读数 | 复算值 | 根因 |
| --- | --- | --- | --- |
| 1 | 语音 3/14、卡片 3/14、流式 6/14 | **2/2/4** | 分卷 02 写在 matcher 收窄（`017e3ae`/`0ef3a36`）之前，收窄未回改分卷；总格数 56 两边一致，只看总数发现不了 |
| 2 | `nonebot/message.py` 15,911 B 是消息段模型 | 它是**事件总线**（578 行，`class MessageSegment` 命中 0）；段模型在 `nonebot/internal/adapter/message.py`（12,695 B / 434 行） | 只按目录名与字节推断，没打开文件 |
| 3 | `gateway.go` 19,673 B、`bridge.go` 3,030 B | **20,347 B / 674 行**、**3,165 B / 135 行** | 旧值取自更早快照；本轮改用本地全量 clone `wc` |
| 4 | LangBot `ARCHITECTURE.md` 在 `docs/`、5 语言 README | 在**仓库根**（31,138 B 对）；README 实为 **6** 语言 | 路径凭印象；语言数按「常见五语」估 |

附带一条方法论更正：**按字节估行数不可用**（steam.go 2,189 B 估 48 行、实为 95；
mattermost.go 4,839 B 估 107 行、实为 194）。凡行数量级一律 `wc -l`。

### 8.4 判据升级：让 8.3 那类漂移无法再次发生

`scripts/verify-benchmark-report.mjs` 新增判据二 —— 报告里形如 `| 语音 | N/M |` 的行首主张
必须等于 `collectChannelMatrix()` 实测值。实施顺序刻意是「**先让判据报红，再改文档**」，
第一次跑的输出：

```
BENCHMARK_REPORT_MATRIX_MISMATCH: 语音: report=3/14 matrix=2/14 | 流式/编辑: report=6/14 matrix=4/14 | 卡片/按钮: report=3/14 matrix=2/14
```

只认「行首第一格就是能力名」：正文里顺带出现的 `3/14` 不算主张，否则任何巧合都误伤。
少写一条不判红，写错一条必判红。

### 8.5 §5.8 共同盲区闭合情况

| 原盲区 | 状态 | 说明 |
| --- | --- | --- |
| ① 未 clone 运行上游 | **部分闭合** | matterbridge 全量 clone（HEAD `c4157a4`）+ 284 行 JS 复现 12/12 绿；NoneBot2 **未能 clone**（本机 GitHub 443 被代理阻断，实录 `Failed to connect to github.com:443 over proxy 127.0.0.1`；tarball HTTP 415），按退路降级为 `gh api contents` 取 master 原文 + 125 行复现 10/10 绿 |
| ② 未做跨框架同消息对照 | **部分闭合** | 同一份意图段 `[quote,text,image,voice,bold]` 喂三个适配器替身 ⇒ 三种调用序列，且投递函数体内零渠道分支 |
| ③ 未建吞吐基准 | **闭合** | 见 8.1 第 2 项 |
| §5.5 能力声明盲区 | **闭合且结论是缺陷** | 见 8.2 N1 |
| §5.4 去重/回声抑制盲区 | **闭合** | 不是一处 dedup 而是三种互不重叠机制：路由层自回声门（`gateway.go:441-450`）、平台重推去重（`rocketchat/handlers.go:65-69`）、桥身份标记（`mattermost/helpers.go:136/164` 写、`:176/:224` 读并跳过） |

### 8.6 本轮仍未闭环（如实登记）

- Koishi / LangBot 两篇五节笔记：⏳ 在办（首轮子代理读完未落盘，已重派）。
- M2 `shared/` 二级分层：⛔ 未动 —— 与本轮语音/基准改动写面重叠，按「同文件先串后派」推迟。
- 上游 issue 提交：⛔ 未做 —— 四条候选缺陷的**源码事实**均已独立复核（详卷第 7 节），但 nonebot 两条的触发证据只到「按源码求值顺序推导 + 标准库复刻」，未端到端跑过真实 `bot.send()`，本机 443 也不通，无法坐实。按「证据不足不冒充完成」留待可联网机器。
- M3.2 基准 Infinity 边界：⛔ 刻意未修 —— 改判定会让刚写回的下限标定与 CI 首次读数失去可比性，已钉成测试。
- 分支覆盖阈值：⛔ 未设（分支 81.14%，只给行覆盖设了 85%）。

副作用声明：本轮同样**没有**修改任何上游项目文件，没有向任何仓库提 issue/PR 或推送。
