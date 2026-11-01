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