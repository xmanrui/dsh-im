# DSH-IM 基线量化与文档/维护面盘点（分卷 04）

> 采集时间：2026-11-02T00:03:10+08:00（`date -Is`，见 C0）
> 仓库：`D:/codex/DSH-IM/rv5.8.0`；分支 `feat/wechat-groups`；HEAD `cc006d79b718261eff3ee53ac8611b0b1db763d7`（C28）
> 版本：`@xmanrui/dsh-im` 5.8.0（package.json），npm 线上最新 5.9.1（C29）
> 采集纪律：全程只读。未修改任何源码/配置，未做 git 写操作，未执行 `npm run build`。本文件是本工作流唯一写面。
> 数字口径：正文每个量化数字后括号内的 `C编号` 指向「附录 A 复跑命令」中的同号命令；命令可原样复跑。

## 0. 证据等级约定

| 标记 | 判定标准 | 本文适用面 |
| --- | --- | --- |
| [一手] | 本机命令 stdout/stderr 原文，或仓库内文件本体 | 体量、行数、目录清单、CI 文件内容 |
| [一手-上游] | GitHub REST API / npm registry / git 元数据原文（带 URL 或命令） | stars、issue/PR 计数、release 清单 |
| [本机实测] | 执行产物（测试汇总行、sha256、mtime） | `node --test` 结果、lib 哈希 |
| [未取证] | 明确没拿到，不得用推测补位 | 发布流水线是否存在、跨机器 CI 结果 |

## 1. 快照基线（一句话可复核）

| 项 | 值 | 来源 |
| --- | --- | --- |
| HEAD commit | `cc006d7`（`fix(weixin): idle instead of fighting for the operator chat`，2026-11-01 23:59:34 +0800） | C28 |
| 分支 | `feat/wechat-groups` | C0 |
| 提交总数 | 1091 | C28 |
| 工作区脏项 | `git status --porcelain` 8 行；`-uall` 16 行（他人改动，非本工作流产生） | C27 |
| 跟踪文件数 | 939 | C2 附注 / C27 |
| 测试用例总数 | 4736（pass 4728 / fail 0 / skipped 8） | C9 |
| lib 产物 | 2 个 js，合计 11,923,866 B | C25 |

## 2. 体量盘点

### 2.1 根目录文件按类统计（C1）

根目录（`-maxdepth 1 -type f`）共 **26 个文件**（C1）。按扩展名/类别拆：

| 类别 | 数量 | 具体文件 |
| --- | --- | --- |
| Markdown 文档 | 11 | README.md、README.en.md、CHANGELOG.md、CONTEXT.md、PROACTIVE_DELIVERY.md、PROACTIVE_DELIVERY.en.md、THIRD_PARTY_NOTICES.md、TODO-host-reload.md、plan-ledger-2026-10-31-wechat-groups.md、DECOMPOSE.md、DECOMPOSE-benchmark.md |
| 脚本（.mjs/.cjs/.js/.cmd） | 6 | poll.mjs、pollnow.mjs、_esb_probe.cjs、_esb_probe2.cjs、out5.js、restart-dsh.cmd |
| 配置（.json/.jsonc/.yml） | 4 | package.json、package-lock.json、wrangler.jsonc、cordis.patch.yml |
| 元数据/忽略文件（noext + dotfile） | 5 | LICENSE、.gitignore、.semgrepignore、.all-contributorsrc、@AutomationLog.txt |

一次性脚本占根脚本的 **5/6**（`poll.mjs`、`pollnow.mjs`、`_esb_probe.cjs`、`_esb_probe2.cjs`、`out5.js`），只有 `restart-dsh.cmd` 属于常用入口；`out5.js`（40 B）与 `_esb_probe*.cjs` 均为未跟踪探针（C27）。

### 2.2 目录体量（`du -sb`，C2）

| 目录 | 文件数 | 字节 | 说明 |
| --- | --- | --- | --- |
| src | 279 | 3,599,571 | 运行源码（278 mjs + 1 md） |
| test | 304 | 5,396,781 | 测试树（293 mjs + 其它 fixture） |
| plugin-src | 187 | 1,919,709 | Host/Client/管理 RPC 构建源码（87 js + 100 mjs） |
| lib | 2 | 11,923,866 | 入库构建产物 |
| docs | 109 | 3,653,721 | 文档树（98 md + 10 图 + 1 txt） |
| assets | 11 | 10,857,737 | 图片/赞助商素材 |
| scripts | 15 | 262,577 | 验证脚本 + wechat UIA 工具 |
| tests | 10 | 355,533 | Python 测试（5 py + 5 pyc） |
| integrations | 5 | 5,006 | 集成声明 |
| locale | 2 | 368 | en.json / zh.json |
| bin | 1 | 3,670 | CLI 入口 dsh-im.mjs |
| worker | 1 | 3,066 | 徽章 worker |
| node_modules | 4913 | 131,267,849 | 依赖（不入库） |
| _audit | 9 | 55,894 | 一次性诊断 |
| _hmr | 25 | 39,192 | 一次性诊断 |
| _research | 40 | 1,133,425 | 调研中间件 |
| _uia | 92 | 1,020,623 | 微信 UIA 取证 |
| _larkprobe | 0 | 0 | 空目录 |
| _tmp | 0 | 0 | 空目录（但有 2 个未跟踪日志） |
| _esb_probe_dir | 2 | 54 | 探针产物 |

**一句话**：源码 3.6 MB / 测试 5.4 MB / 产物 11.9 MB / 文档 3.7 MB；产物体积是源码的 3.3 倍（11,923,866 ÷ 3,599,571 ≈ 3.31，C2）。

### 2.3 src 与 test 总行数（C3、C4）

| 范围 | 文件数 | 行数 | 密度 |
| --- | --- | --- | --- |
| src（仅 .mjs） | 278 | **81,354** | 平均 292.6 行/文件 |
| test（仅 .mjs） | 293 | **129,003** | 平均 440.3 行/文件 |
| test（全部文件） | 304 | 129,656 | — |
| plugin-src（.js + .mjs） | 187 | 37,274 | 平均 199.3 行/文件 |

**测试/源码行比 = 129,003 ÷ 81,354 = 1.586**；测试文件数 293 / 源码文件数 278 = 1.054。即测试面在体量上已超过源码，但用例数 ≠ 覆盖分支，覆盖率数字本报告未取证（`coverage/` 在 .gitignore 内且无产物，C27）。

### 2.4 最大 10 个源码文件（C5，按行数）

| # | 文件 | 行数 | 占 src 总行 % |
| --- | --- | --- | --- |
| 1 | `src/channels/feishu/bridge.mjs` | 6,695 | 8.23% |
| 2 | `src/channels/shared/bot-workspace-store.mjs` | 2,838 | 3.49% |
| 3 | `src/channels/shared/harness-client.mjs` | 2,488 | 3.06% |
| 4 | `src/channels/shared/text-harness-bridge.mjs` | 2,350 | 2.89% |
| 5 | `src/channels/dingtalk/dingtalk-bridge.mjs` | 1,925 | 2.37% |
| 6 | `src/channels/wecom/wecom-bridge.mjs` | 1,918 | 2.36% |
| 7 | `src/channels/telegram/telegram-runtime.mjs` | 1,901 | 2.34% |
| 8 | `src/channels/qq/qq-bridge.mjs` | 1,763 | 2.17% |
| 9 | `src/channels/feishu/multi-bot-controller.mjs` | 1,651 | 2.03% |
| 10 | `src/channels/weixin/weixin-bridge.mjs` | 1,607 | 1.98% |

Top 10 合计 22,574 行 = src 的 **27.7%**（22,574 ÷ 81,354）。前 4 名中 3 个在 `shared/`（共享语义层），第 1 名单文件 6,695 行 = 第二名 2.4 倍，是单点维护风险最大的文件。

### 2.5 渠道分布（C6）

15 个渠道目录（含 `shared` 与 `office`），文件数合计 279 = src 全量；行数合计 81,354 = src 全量（C6 逐行相加与 C3 完全一致，交叉校验通过）。

| 渠道目录 | 文件数 | mjs 行数 | 占 src % |
| --- | --- | --- | --- |
| shared | 128 | 24,638 | 30.29% |
| feishu | 26 | 14,874 | 18.28% |
| weixin | 15 | 6,084 | 7.48% |
| dingtalk | 11 | 5,939 | 7.30% |
| matrix | 11 | 5,805 | 7.14% |
| telegram | 11 | 3,728 | 4.58% |
| wecom | 10 | 3,554 | 4.37% |
| qq | 11 | 3,442 | 4.23% |
| email | 12 | 3,149 | 3.87% |
| wecom-app | 8 | 3,065 | 3.77% |
| whatsapp | 8 | 2,023 | 2.49% |
| slack | 8 | 2,041 | 2.51% |
| discord | 7 | 1,499 | 1.84% |
| office | 6 | 1,065 | 1.31% |
| imessage | 7 | 448 | 0.55% |

**可量化差距**：`imessage` 448 行 / 7 文件，是 `feishu`（14,874 行 / 26 文件）的 **3.0%**；两端差 33 倍。`shared` 占 30.29%，符合「统一语义核心」定位（ADR-0001），但 shared 内部 127 个 mjs 无二级分层，平均 194 行/文件。

### 2.6 一次性诊断/研究目录（C7，未入库或部分未入库）

| 目录 | 文件数 | 字节 | .gitignore 是否覆盖 |
| --- | --- | --- | --- |
| `_audit/` | 9 | 55,894 | 是（`_audit/` 行） |
| `_hmr/` | 25 | 39,192 | 是（`_hmr/` 行） |
| `_research/` | 40 | 1,133,425 | 是（`_research/` 行） |
| `_uia/` | 92 | 1,020,623 | 是（`_uia/` 行） |
| `_larkprobe/` | 0 | 0 | 否（.gitignore 无此行） |
| `_tmp/` | 0 | 0 | 否（2 个未跟踪 log） |
| `_esb_probe_dir/` | 2 | 54 | 否 |

合计 **166 个文件 / 2,258,134 B（约 2.15 MiB）**，其中被 .gitignore 覆盖的 166 个文件里 166 个属于前 4 个目录；**未覆盖的 5 类（`_larkprobe/`、`_tmp/`、`_esb_probe_dir/`、`_esb_probe*.cjs`、`out5.js`）出现在 `git status` 的 8 行脏输出里（C27）**。

## 3. 测试面（`node --test`，只读执行）

### 3.1 全量结果：两种环境态，各一次

| 口径 | tests | suites | pass | fail | skipped | cancelled | duration_ms | exit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 默认 TEMP（`D:/app-cache/temp`） | 4736 | 3 | 4727 | **1** | 8 | 0 | 21,646.9572 | 1 |
| 覆写 `TEMP/TMP`（工作区内目录） | 4736 | 3 | **4728** | **0** | 8 | 0 | 20,201.5193 | 0 |

命令：C8（默认）与 C9（覆写）。两次都是全量 117 + 169 个 `*.test.mjs`，用时 **20.2–21.6 s**，远低于 6 分钟退路上限，因此未启用单文件取样退路。

**唯一 fail 的归因 [本机实测]**：`test/channels/feishu/lark-sdk-handshake-patch.test.mjs:59` 的用例 `patched real SDK survives handshake timeout and close without uncaught or zombie reconnects`，esbuild 写 bundle 到 `D:/app-cache/temp/dsh-lark-sdk-test-*/scenario.mjs` 报 `Access is denied`（C8 日志）。同一用例覆写 TEMP/TMP 后 **pass 3 / fail 0**（C9 单文件复跑，C10）。这不是源码缺陷，而是本机 temp 目录的写权限/占用态；跨机器（CI ubuntu/windows-latest）是否复现 [未取证]。

### 3.2 skipped 8 条（C11 原文清单）

| # | 用例名 | 原因（原样） |
| --- | --- | --- |
| 1 | a real group message wakes the agent and the answer lands back in the group | SKIP |
| 2 | permission failures do not publish a new default bot | SKIP |
| 3 | real ffmpeg output passes the canonical container check | ffmpeg is not installed |
| 4 | synthesize clamps long text at the TTS character budget | requires the POSIX ffmpeg stub fixture |
| 5 | synthesize rejects when the TTS response carries no audio url | requires the POSIX ffmpeg stub fixture |
| 6 | synthesize renders speech through the DashScope TTS endpoint and returns opus bytes | requires the POSIX ffmpeg stub fixture |
| 7 | transcribeIncoming downloads the Feishu resource, converts and calls the ASR endpoint | requires the POSIX ffmpeg stub fixture |
| 8 | transcribeIncoming surfaces ASR failures instead of inventing text | requires the POSIX ffmpeg stub fixture |

**可量化差距**：skipped 占 8/4736 = **0.17%**；其中 **6/8（75%）** 依赖 POSIX ffmpeg stub 或本机 ffmpeg，**2/8（25%）** 依赖真实群消息/权限环境。即「语音/媒体链路」在本机永远不执行，是测试面最明显的功能性盲区。

### 3.3 测试文件分布（C12）

`test/*.test.mjs` **117 个** + `test/channels/*/*.test.mjs` **169 个** = **286 个**（C12）；另 293 个 mjs 中 7 个是 fixture/helper。

| 渠道 | 测试文件数 | 对应源码行数 | 行/用例文件 |
| --- | --- | --- | --- |
| feishu | 33 | 14,874 | 450.7 |
| shared | 25 | 24,638 | 985.5 |
| telegram | 20 | 3,728 | 186.4 |
| dingtalk | 19 | 5,939 | 312.6 |
| weixin | 18 | 6,084 | 338.0 |
| qq | 12 | 3,442 | 286.8 |
| wecom | 11 | 3,554 | 323.1 |
| matrix | 9 | 5,805 | 645.0 |
| whatsapp | 6 | 2,023 | 337.2 |
| wecom-app | 5 | 3,065 | 613.0 |
| discord | 4 | 1,499 | 374.8 |
| slack | 3 | 2,041 | 680.3 |
| imessage | 2 | 448 | 224.0 |
| email | 1 | 3,149 | 3,149.0 |
| office | 1 | 1,065 | 1,065.0 |

**可量化差距**：`email`（3,149 行源码）只有 **1** 个测试文件，`office`（1,065 行）只有 1 个；`shared` 每测试文件承载 985.5 行源码，是全仓最高，与 2.4 节的巨型文件叠加，说明共享层测试粒度偏粗。

### 3.4 Python 测试面（C13）

`tests/` 共 10 个文件 = 5 个 `.py` + 5 个 `__pycache__/*.pyc`；`grep -cE 'def test_'` 得 **184 个用例**，分布：`test_wechat_group_uia.py` 169 / `test_wechat_group_gate.py` 6 / `test_enable_wechat_uia_flag.py` 4 / `test_wechat_group_trigger.py` 3 / `test_wechat_group_observed.py` 2。

其中 `test_wechat_group_uia.py` 占 **91.8%（169/184）**，且该文件是唯一被本机改脏的跟踪文件（C27 的 `M tests/python/test_wechat_group_uia.py`），与本工作流无关。`.pyc` 未被 .gitignore 覆盖 → 5 个 pyc 出现在未跟踪列表。
