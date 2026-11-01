## 1. 对比总览表

> 说明：D 列给「本仓实现位置」，对的是**功能模块**而不是文件同名。所有上游数字取 `gh api` 当日现值（2026-11-02），本仓数字取分卷 05 的实测与工单记录。

### 1.1 八维总览（每维一行：本仓现状 vs 上游最佳）

| # | 维度 | 本仓（@xmanrui/dsh-im 5.8.0） | 上游最佳（项目 · 证据） | 差距判定 |
| --- | --- | --- | --- | --- |
| 1 | 功能模块覆盖 | 14 个渠道目录，9 类能力矩阵由源码生成（见 §1.2） | LangBot 18,658★，Python，单仓覆盖 QQ/微信/飞书/钉钉/Discord/Telegram/Slack，`src/langbot/pkg` 分 agent/api/box/cloud/command/config/core/discover/entity/i18n/operation_trace 十余个域 | **渠道数相当（14 vs ~8），域分层落后**：本仓 `src/channels/shared` 83 个平铺文件无二级分层 |
| 2 | 技术架构设计 | 统一语义核心 + 渠道原生适配（ADR-0001），`shared` 24,638 行占 src 30.29% | Koishi 6,309★，`packages/core/src` 只有 bot/session/context/middleware/command 等 13 个文件，`bot.ts` 仅 1,803 B | **本仓核心抽象未收敛**：上游把 Adapter 契约压到 1.8 KB 的 `bot.ts`，本仓同类逻辑散在 83 个文件里 |
| 3 | 实现方式 | 289 个 mjs（279 src + 10 tests）、ESM、无 TS、无 lint/format 配置；治理骨架已落地（`f3ad28e`） | NoneBot2 7,777★ 有 `nonebot/plugin/__init__.py` 8,030 B 的插件加载器 + 类型标注（`py.typed`）；LangBot 有 `CONTRIBUTING.md`、`.pre-commit-config.yaml`、`golangci` 级等价门禁 | **规范层缺失**：本仓无 CONTRIBUTING / SECURITY / ISSUE 模板 / lint/format 配置（`ls` 实测） |
| 4 | 性能表现 | 全量 4,752 用例 25 s 左右；`wechat_group_uia.py` 找按钮 156 ms（commit 4fe8b1d 实测 34.5 s → 156 ms） | matterbridge 用 Go 单进程多协议（`gateway.go` 20,347 B），wechaty 23,461★ 以 puppeteer 事件循环承载 | **基准已建立**（`bc27b224`）：六条热路径 + 下限判据 + CI 警告态；跨项目仍无同口径 msg/s 可比数 |
| 5 | 可扩展性 | 新增渠道 = 新建 `src/channels/<name>/` + `plugin-src/host/channels/<name>/index.mjs` + `plugin-src/client/channels/<name>/`，三处手工接线（`plugin-src/host/index.mjs` 第 2-15 行 import、第 60-75 行 channels 数组） | Koishi 的插件即包（`packages/*`），服务由 `ctx.get()` 注入；NoneBot2 的适配器目录 `nonebot/adapters` 为可外部安装的独立包 | **接线仍手工**：本仓 14 个渠道在 host 里是 14 条 import + 14 条数组项，无注册表/自动发现 |
| 6 | 维护状态 | 3,045★ / 86 open issues / 最近推送 2026-11-01T13:07:26Z / 单分支主力 `feat/wechat-groups` | LangBot 最近推送 2026-11-01T15:55:19Z（同日）、open 127；chatgpt-on-wechat 47,732★ 最近推送 2026-11-01T07:33:51Z | **活跃度同档**；但本仓 CI 只覆盖 `test/*.test.mjs` + 两条 Windows 专题，无 lint/覆盖率/发布流水线 |
| 7 | 文档完善程度 | README 80 KB + 英文版 + `docs/` 98 个 md + ADR 1 篇 + 12 篇 Issue 方案记录 + `ARCHITECTURE.md` + 治理七件套；仍缺独立 API 参考 | LangBot 有仓库根 `ARCHITECTURE.md`（31,138 B）+ `CONTRIBUTING.md` + `CLA.md` + 6 语言 README（README/CN/ES/FR/JP/KO） | **体系化文档落后**：本仓有大量「事后记录」但缺「架构总览 + 贡献流程」两块骨架 |
| 8 | 适用场景 | 必须宿主为 DeepSeek Harness（`dsh.compatibility.dsh` 钉 `0.2.1-rc.2`），一装即得 14 渠道 + 会话隔离 + 产物回投 | LangBot/chatgpt-on-wechat 可独立部署为机器人服务；matterbridge 可独立网关 | **场景窄但粘性高**：本仓不是通用框架，是 DSH 的 IM 面；兼容面仅声明 2 个宿主版本 |

### 1.2 渠道 × 能力（本仓实测，由源码生成，见 `README.md` 同名表）

能力矩阵已由 `scripts/channel-capability-matrix.mjs` 从 `src/channels/*/` 生成并纳入 `npm run check`。9 列能力（文本 / 图片 / 文件 / 语音 / 引用回复 / 群聊 / 流式·编辑 / 卡片·按钮 / 富文本）× 14 个渠道 = 126 格；实测 ✅ **56** 格、— **70** 格（命令：`sed -n '/channel-capability-matrix:start/,/channel-capability-matrix:end/p' README.md | grep -o '✅' | wc -l` 得 57，扣除图例里那 1 个 ✅；— 同法得 71 扣 1）。**这张表的价值不是覆盖率，而是它现在是可复算的**：之前它只是 README 里的散文。

### 1.3 量化差距清单（只列可复算的）

| 指标 | 本仓 | 上游/参照 | 差距 | 证据 |
| --- | --- | --- | --- | --- |
| 核心抽象单文件体积 | `src/channels/shared` 83 文件 / 24,638 行 | Koishi `packages/core/src/bot.ts` 1,803 B | 核心契约未收敛（上游一个文件的量级，本仓是一层目录） | 分卷 05 §2.5；`gh api` bot.ts `.size` |
| 单文件最大 | `src/channels/feishu/bridge.mjs` 6,695 行 | matterbridge `gateway.go` 20,347 B（674 行 Go；旧注「≈500 行」是按字节估算的，实测该估法不可用：steam.go 2,189 B 实为 95 行、mattermost.go 4,839 B 实为 194 行） | 本仓单文件超上游整模块 | 分卷 05 §2.4 |
| 测试/源码行比 | 1.586（129,003 / 81,354） | 无上游同口径读数 | — | 分卷 05 §2.3 |
| 治理文件 | 7（`f3ad28e`） | LangBot：`CONTRIBUTING.md` + `CLA.md` + `.pre-commit-config.yaml` | 已闭合，仍缺 CLA 与 pre-commit | `node scripts/verify-governance.mjs` |
| CI 覆盖 | 2 job（ubuntu `npm run check` + windows 8 个专项） | 无同口径，但上游有 release/lint 流水线 | 缺 lint / 覆盖率 / 发布流水线 | `.github/workflows/ci.yml` 55 行 |
| 入库构建产物 | 11,923,866 B（2 文件） | LangBot/matterbridge 不入库产物 | 体积与漂移风险 | 分卷 05 §2.2；改造 ② 已加漂移守卫 |
| 入站能力盲区 | skip 8 / 4,736 = 0.17%，其中 6 条依赖 POSIX ffmpeg | — | 语音/媒体链路本机永不执行 | 分卷 05 §3.2 |