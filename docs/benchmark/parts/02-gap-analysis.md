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
| 语言/类型 | 纯 JS（ESM），无 `tsc`、无 `jsconfig` 类型检查 | Koishi/Python 系全部带类型（`py.typed`、TS） | 无静态类型检查 |
| 格式/lint | 无 `.editorconfig` / `.eslintrc` / `.prettierrc`（`ls -a` 实测） | LangBot 有 `.pre-commit-config.yaml`；matterbridge 有 `.golangci.yaml` | 无 Lint 门禁 |
| 测试形态 | `node:test`，296 个 mjs，4,971 用例；**覆盖率已入 CI**（`62f89f45`：行 89.97%、函数 83.89%、分支 81.14%，阈值 85%） | 上游有覆盖率/CI 矩阵 | 已闭合（分支阈值未设） |
| 贡献流程 | **已落地**：CONTRIBUTING / CODE_OF_CONDUCT / SECURITY / 3 个 issue 模板 / PR 模板，交叉引用有判据（`f3ad28e`） | LangBot：`CONTRIBUTING.md` + `CLA.md` + `.pre-commit-config.yaml` | 仍缺 CLA 与 pre-commit |
| 构建产物 | `lib/index.js` 10.1 MB + `lib/client.js` 1.82 MB 入库 | 上游不入库产物 | 漂移风险（改造 ② 已加守卫） |

### 2.4 性能表现

**本仓可复算读数**：
- 全量测试 4,752 用例 / 25 s 级（`node --test test/*.test.mjs test/channels/*/*.test.mjs`）；
- 单点性能修复：`4fe8b1d` 把微信群发送按钮查找从 34.5 s → **156 ms**（提交标题与 body 记录）；
- 构建确定性：两次 `npm run build` 产物 sha256 相同（改造 ② 的判据前提）。

**差距**：本仓**没有任何吞吐/延迟基准脚本**。上游 matterbridge 是 Go 单进程网关（`gateway.go` 20,347 B / 674 行）、wechaty 以事件循环承载多会话；这些都没有可直接对标的「消息/秒」数字，但它们的发布流程有基准记录，本仓没有。这是最大的一块量化空白，改进项 H3 提出先建最小基准脚本。

### 2.5 可扩展性

- **架构扩展性**：新增渠道需要改 3 处手工接线（见 2.2），且 `shared/` 无分层，新增能力容易再堆文件。
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
| 贡献指南 | CONTRIBUTING + SECURITY + CODE_OF_CONDUCT + issue/PR 模板，交叉引用有判据 | 2/2 | `node scripts/verify-governance.mjs` → `GOVERNANCE_OK 7 files` |
| 变更日志 | `CHANGELOG.md` 312 KB | 2/2 | `wc -c` |
| 示例/架构 | ADR 1 篇 + `ARCHITECTURE.md`（357 行 / 8 个一级章节） | 2/2 | `ls ARCHITECTURE.md docs/adr` |

合计 **8/10**（本轮两项各 +1）。上游 LangBot 有仓库根 `ARCHITECTURE.md` 31,138 B + `CONTRIBUTING.md` 2,183 B + `CLA.md` 12,158 B + 9 个 README 文件（主 README + CN/ES/FR/JP/KO/RU/TW/VI，`gh api contents --paginate` 实测）。

### 2.8 适用场景

- **最佳场景**：已经用 DeepSeek Harness、希望把 IM 当遥控器的个人/小团队；一次安装得到 14 个渠道 + 会话隔离 + 产物回投。
- **局限**：① 宿主强耦合（`dsh.compatibility.dsh` 只声明 2 个版本）；② iMessage 仅 macOS 且只有文本（448 行，最小渠道）；③ Matrix 加密为实验状态（README 明示未验证真实 homeserver 互通）；④ 需要跑无头服务器时没有独立网关形态（上游 matterbridge/LangBot 均可独立部署）。
- **兼容性**：Node ≥22.19；Windows 上 `os.tmpdir()` 对 esbuild 子进程可能不可写（改造 ① 已处理）。