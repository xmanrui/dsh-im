# DECOMPOSE — GitHub 对标学习 + 四项工程改造（2026-11-01 · 轮1）

## 本轮目标
对 DSH-IM（@xmanrui/dsh-im v5.8.0，本机仓 D:/codex/DSH-IM/rv5.8.0，分支 feat/wechat-groups）与 GitHub 上功能定位相似的开源项目做八维对标，产出结构化报告（总览表/逐项差距/改进建议(高中低)/可实施路径），再按优先级从高到低落地 4 项工程改造。

## 验收（可复算）
- R1 报告存在且八维齐全 + 总览表 + 逐项差距 + 建议清单 + 可实施路径：`ls docs/benchmark/2026-11-01-*` 且标题 grep 命中 8 个维度名
- R2 每项改造都有可复跑判据（命令 + 期望末行），Lead 独立复跑至少 1 条，且各带负向对照
- R3 全量门禁 `npm run check`（build+test+verify-package）末行 PASS，测试用例数不低于改造前基线
- R4 改动已提交（点名路径，禁裸 commit）并按 #40 部署 + 线上/加载态读回验证

## 并行工作流（一条消息发 4 件，写面互不相交）
| # | 工作流 | 乙方 | 写面白名单 | 独立验收 |
| 1 | 插件生态与可扩展性对标（Koishi / NoneBot2） | 子代理 A1 | docs/benchmark/parts/01-*.md | 每个项目给出 plugin/adapter 契约 file:line 或官方 URL 证据 |
| 2 | 多 IM 渠道功能覆盖对标（LangBot / chatgpt-on-wechat） | 子代理 A2 | docs/benchmark/parts/02-*.md | 渠道矩阵逐项标注支持/降级，附上游源码或文档链接 |
| 3 | 桥接抽象与性能/并发对标（matterbridge / wechaty） | 子代理 A3 | docs/benchmark/parts/03-*.md | 抽象层与并发/重连机制有代码级证据 |
| 4 | 本仓基线量化（体量/测试/依赖/文档/维护面） | 子代理 A4 | docs/benchmark/parts/04-*.md | 每条量化带命令与输出，mtime/sha 可复算 |
| 5 | 汇总报告 + 四项改造执行 + 提交部署 | Lead | docs/benchmark/、src/、test/、scripts/、.github/ | npm run check PASS + 线上读回 |

## 串行边界
- 报告汇总依赖 A1–A4 收尾消息（Lead 自留，不派）。
- 改造项按优先级串行落地（同文件先串后派），每项前先写失败测试（负向对照）再实现。

## 回滚
源码走 Git 分支 feat/wechat-groups（逐项独立提交，可单笔 revert）；报告为新增文件，删除即回滚。

## 现状基线（开工前读盘）
- HEAD 0ae0e13（feat/wechat-groups），远端 xmanrui/dsh-im；npm scripts: build / test / check。
- src/channels 15 个渠道目录 279 文件；shared 128 文件；test/*.test.mjs 117 个；tests/ 10 文件。
- lib/index.js 10.1MB、lib/client.js 1.82MB（构建产物在仓内）。
- 缺失项（已 ls 实测）：CONTRIBUTING* / CODE_OF_CONDUCT* / SECURITY* / issue 模板 / PR 模板 全部不存在；.github 只有 workflows/ci.yml。
